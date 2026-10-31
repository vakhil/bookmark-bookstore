#!/usr/bin/env python3
"""
convert_and_upload_to_turso.py
==============================
Parses `books-list/data_latest.xlsx` using the application's core rules:
- Normalizes rack, column, position via database.py helper functions.
- Formats location_english.
- Resolves ID collisions with duplicate suffixing (BK-XXX-2, etc.).
- Normalizes status ('Available' / 'Sold').
- Auto-classifies genre if empty via genre_classifier.
- Seeds books directly to local bookstore.db and/or Turso Cloud database.
"""

import os
import sys
import re
import time
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime
import sqlite3

import database
import genre_classifier
import turso_client

EXCEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "books-list", "data_latest.xlsx")
LOCAL_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bookstore.db")

def parse_excel_books(excel_path: str):
    """Parses data_latest.xlsx directly using zipfile and ElementTree (zero dependencies)."""
    if not os.path.exists(excel_path):
        raise FileNotFoundError(f"Excel file not found at {excel_path}")

    print(f"Reading {excel_path}...")
    with zipfile.ZipFile(excel_path) as z:
        sst = []
        if 'xl/sharedStrings.xml' in z.namelist():
            tree = ET.fromstring(z.read('xl/sharedStrings.xml'))
            for si in tree.findall('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}si'):
                texts = [t.text for t in si.findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t') if t.text]
                sst.append(''.join(texts))

        stree = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
        rows = stree.findall('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}sheetData/{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row')

        # First pass: collect all existing numeric BK-IDs to find the max number
        existing_numeric_ids = set()
        for r in rows[1:]:
            for c in r.findall('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c'):
                if c.get('r', '').startswith('B'):
                    v = c.find('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v')
                    val = v.text if v is not None else ''
                    if c.get('t') == 's' and val.isdigit():
                        idx = int(val)
                        val = sst[idx] if idx < len(sst) else ''
                    val = val.strip()
                    m = re.match(r"^BK-(\d+)$", val)
                    if m:
                        existing_numeric_ids.add(int(m.group(1)))

        max_num = max(existing_numeric_ids) if existing_numeric_ids else 1
        next_available_id = max_num + 1

        seen_ids = set()
        parsed_books = []
        collisions = 0
        now_iso = datetime.now().isoformat()

        # Second pass: parse and assign pure BK-<number>
        for r in rows[1:]:
            cells = {}
            for c in r.findall('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c'):
                ref = c.get('r', '')
                col = ''.join(filter(str.isalpha, ref))
                v = c.find('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v')
                val = v.text if v is not None else ''
                if c.get('t') == 's' and val.isdigit():
                    idx = int(val)
                    val = sst[idx] if idx < len(sst) else ''
                cells[col] = val.strip()

            bid = cells.get('B', '')
            title = database.sanitize_title(cells.get('F', ''))
            if not bid or not title:
                continue

            rack = cells.get('C', '')
            col_val = cells.get('D', '')
            pos_val = cells.get('E', '')
            author = cells.get('G', '')
            genre = cells.get('H', '')
            notes = database.sanitize_notes(cells.get('I', ''))
            simple_genre = cells.get('J', '')
            status_raw = cells.get('K', '')

            # Resolve duplicates to clean, unique standard format BK-<number> (e.g. BK-14680)
            final_id = bid
            if final_id in seen_ids:
                collisions += 1
                while next_available_id in existing_numeric_ids:
                    next_available_id += 1
                final_id = f"BK-{next_available_id}"
                existing_numeric_ids.add(next_available_id)
                next_available_id += 1
                notes = f"{notes} (Original Sheet ID: {bid})".strip()
            seen_ids.add(final_id)

            r_int = database.parse_rack_value(rack)
            c_int = database.parse_column_value(col_val)
            p_int = database.parse_position_value(pos_val)
            loc_eng = database.format_location_english(r_int, c_int, p_int, notes)

            if not simple_genre:
                simple_genre = genre_classifier.classify_common_genre(genre, title)

            if status_raw.upper() == 'SOLD OUT':
                status = 'Sold'
            elif status_raw.capitalize() == 'Available' or not status_raw:
                status = 'Available'
            else:
                status = status_raw.capitalize()

            is_unassigned = r_int is None or c_int is None or p_int is None
            unassigned_since = now_iso if is_unassigned else None

            parsed_books.append({
                "book_id": final_id,
                "title": title,
                "author": author,
                "genre": genre,
                "simple_genre": simple_genre,
                "language": "English",
                "rack": r_int,
                "column_num": c_int,
                "position": p_int,
                "location_english": loc_eng,
                "notes": notes,
                "status": status,
                "selling_price": None,
                "created_at": now_iso,
                "updated_at": now_iso,
                "unassigned_since": unassigned_since,
                "image_url": "",
                "summary": ""
            })

    print(f"✅ Successfully parsed {len(parsed_books)} books ({collisions} duplicate IDs deduplicated).")
    return parsed_books

def update_local_sqlite(books):
    """Updates local bookstore.db with parsed books."""
    print(f"\nUpdating local database: {LOCAL_DB_PATH}...")
    conn = sqlite3.connect(LOCAL_DB_PATH)
    cursor = conn.cursor()

    # Ensure schema
    database.ensure_schema(conn)

    cursor.execute("DELETE FROM books")
    try:
        cursor.execute("DELETE FROM books_fts")
    except Exception:
        pass

    cursor.executemany("""
        INSERT INTO books (
            book_id, title, author, genre, simple_genre, language,
            rack, column_num, position, location_english,
            notes, status, selling_price,
            created_at, updated_at, unassigned_since, image_url, summary
        ) VALUES (
            :book_id, :title, :author, :genre, :simple_genre, :language,
            :rack, :column_num, :position, :location_english,
            :notes, :status, :selling_price,
            :created_at, :updated_at, :unassigned_since, :image_url, :summary
        )
    """, books)

    # Rebuild FTS
    try:
        cursor.execute("DELETE FROM books_fts")
        cursor.execute("""
            INSERT INTO books_fts(rowid, book_id, title, author, genre, notes, location_english)
            SELECT id, book_id, title, author, genre, notes, location_english FROM books
        """)
    except Exception as e:
        print(f"FTS rebuild notice: {e}")

    conn.commit()
    cursor.execute("SELECT COUNT(*) FROM books")
    cnt = cursor.fetchone()[0]
    conn.close()
    print(f"✅ Local bookstore.db updated. Current book count: {cnt}")

def upload_to_turso(books, url: str, token: str):
    """Batch uploads parsed books to Turso Cloud."""
    print(f"\nConnecting to Turso Cloud at {url}...")
    remote_conn = turso_client.connect(url, token)
    remote_cursor = remote_conn.cursor()

    print("Ensuring remote schema in Turso...")
    try:
        remote_cursor.execute("ALTER TABLE books ADD COLUMN summary LONGTEXT DEFAULT ''")
    except Exception:
        pass

    # Indices
    for idx_sql in [
        "CREATE INDEX IF NOT EXISTS idx_books_id ON books(book_id)",
        "CREATE INDEX IF NOT EXISTS idx_books_status ON books(status)",
        "CREATE INDEX IF NOT EXISTS idx_books_rack ON books(rack, column_num)",
        "CREATE INDEX IF NOT EXISTS idx_books_title ON books(title)",
        "CREATE INDEX IF NOT EXISTS idx_books_author ON books(author)",
        "CREATE INDEX IF NOT EXISTS idx_books_simple_genre ON books(simple_genre)"
    ]:
        try:
            remote_cursor.execute(idx_sql)
        except Exception:
            pass

    print("Clearing old books in Turso...")
    remote_cursor.execute("DELETE FROM books")

    # Insert in batches of 100
    batch_size = 100
    total = len(books)
    print(f"Uploading {total} books to Turso in batches of {batch_size}...")

    insert_sql = """
        INSERT INTO books (
            book_id, title, author, genre, simple_genre, language,
            rack, column_num, position, location_english,
            notes, status, selling_price,
            created_at, updated_at, unassigned_since, image_url, summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """

    for i in range(0, total, batch_size):
        batch = books[i:i + batch_size]
        rows = [
            (
                b["book_id"], b["title"], b["author"], b["genre"], b["simple_genre"], b["language"],
                b["rack"], b["column_num"], b["position"], b["location_english"],
                b["notes"], b["status"], b["selling_price"],
                b["created_at"], b["updated_at"], b["unassigned_since"], b["image_url"], b["summary"]
            )
            for b in batch
        ]
        remote_cursor.executemany(insert_sql, rows)
        pct = min(100, int((i + len(batch)) / total * 100))
        print(f"   [{pct:3d}%] Uploaded {i + len(batch)} / {total} books...", end="\r")

    print(f"\n✅ All {total} books successfully uploaded to Turso Cloud!")
    remote_cursor.execute("SELECT COUNT(*) as cnt FROM books")
    res = remote_cursor.fetchone()
    remote_count = res["cnt"] if isinstance(res, dict) or hasattr(res, "__getitem__") else res[0]
    print(f"📊 Turso books table total: {remote_count}")

def main():
    books = parse_excel_books(EXCEL_PATH)
    update_local_sqlite(books)

    url = os.environ.get("TURSO_DATABASE_URL", "libsql://bookstore-akhilvemula96.aws-ap-northeast-1.turso.io").strip()
    token = os.environ.get("TURSO_AUTH_TOKEN", "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTMyMjYwMzQsImlkIjoiMDFhMTg0OTUtN2QwMS03NzcxLThiMzMtMmJhMGQ2ZjY2MDU1Iiwia2lkIjoiczBtU1ZjVU9uV25FRDJaVjMtQVRlOGtMZnhlLUp0clRQeTlKVm5sNGtGayIsInJpZCI6ImRkNDMxYTc2LWM2ZjgtNDViOC1hODQ4LWI5ZTEyNjZkZTAyNiJ9.YLdnymMUWT78qF9-GZtEdQmqBHjKnQGA2EWO9phNuKPPnclCh2QacjB4x5GR2EG3lr6WVYbzWg6dqkVLyaYDAQ").strip()

    if url and token:
        upload_to_turso(books, url, token)
    else:
        print("TURSO credentials not found in env. Skipped remote Turso upload.")

if __name__ == "__main__":
    main()
