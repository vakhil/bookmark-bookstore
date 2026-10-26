"""
Database layer for Bookstore App.
Handles SQLite storage, FTS5 full-text indexing, location conventions,
Inventory ID generation with collision checking, transactions, and audit logging.
"""

import sqlite3
import os
import re
import csv
import json
import threading
from datetime import datetime
from typing import Dict, List, Optional, Tuple, Any
import genre_classifier
import shutil

DB_PATH = os.path.join(os.path.dirname(__file__), "bookstore.db")
SEED_CSV_PATH = os.path.join(os.path.dirname(__file__), "initial_inventory.csv")

# Vercel serverless environment support (ephemeral writable /tmp)
if os.environ.get("VERCEL"):
    tmp_db = "/tmp/bookstore.db"
    src_db = DB_PATH
    if not os.path.exists(tmp_db) and os.path.exists(src_db):
        try:
            shutil.copyfile(src_db, tmp_db)
        except Exception as e:
            print(f"Notice copying DB to /tmp: {e}")
    if os.path.exists(tmp_db):
        DB_PATH = tmp_db

    tmp_csv = "/tmp/initial_inventory.csv"
    src_csv = SEED_CSV_PATH
    if not os.path.exists(tmp_csv) and os.path.exists(src_csv):
        try:
            shutil.copyfile(src_csv, tmp_csv)
        except Exception as e:
            print(f"Notice copying CSV to /tmp: {e}")
    if os.path.exists(tmp_csv):
        SEED_CSV_PATH = tmp_csv

# Global lock for concurrency control across threads
db_lock = threading.Lock()

def get_db_connection() -> sqlite3.Connection:
    """Creates a database connection with dictionary row access and FTS5 enabled."""
    conn = sqlite3.connect(DB_PATH, timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys = ON")
    except Exception:
        pass
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except Exception:
        pass
    return conn

def format_location_english(rack: Optional[str], column: Optional[str], position: Optional[str], notes: Optional[str] = "") -> str:
    """
    Translates rack, column, and position codes into standard bookstore English.
    Requirement 1.6:
      - Rack 50 -> Column 1 -> On top of the rack
      - Rack 50 -> Column 2 -> 5th book from top
      - Preserves store's documented conventions: position 1 -> 'On top of the rack'
      - Handles unassigned books distinctly.
    """
    rack = (rack or "").strip()
    column = (column or "").strip()
    pos_raw = (position or "").strip()
    notes = (notes or "").strip()

    if not rack or not column or rack.lower() == "unassigned" or column.lower() == "unassigned" or not pos_raw:
        return "Unassigned"

    # Interpret position / book number
    pos_str = pos_raw.lower()
    placement_english = ""

    # Check known notes or explicit conventions
    if pos_raw in ("1", "1.0"):
        if "top horizontal" in pos_str:
            placement_english = "1st book from top (Top horizontal)"
        elif "on top" in notes.lower() or "top book" in notes.lower() or True:
            # Documented bookstore convention: position 1 = On top of the rack
            placement_english = "On top of the rack"
    elif pos_raw in ("2", "2.0"):
        placement_english = "2nd book from top"
    elif pos_raw in ("3", "3.0"):
        placement_english = "3rd book from top"
    elif pos_raw in ("4", "4.0"):
        placement_english = "4th book from top"
    elif pos_raw in ("5", "5.0"):
        placement_english = "5th book from top"
    elif pos_raw.isdigit():
        n = int(pos_raw)
        if 11 <= (n % 100) <= 13:
            suffix = "th"
        else:
            suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
        placement_english = f"{n}{suffix} book from top"
    else:
        # Descriptive positions like '1 (Top Horizontal)', 'Vertical, Left to Right 1'
        m = re.match(r"^(\d+)\s*\((.+)\)$", pos_raw)
        if m:
            num = int(m.group(1))
            suffix = {1: "st", 2: "nd", 3: "rd"}.get(num, "th")
            desc = m.group(2).capitalize()
            placement_english = f"{num}{suffix} book ({desc})"
        else:
            placement_english = pos_raw

    return f"{rack} → {column} → {placement_english}"

def init_db(force_reseed: bool = False):
    """Initializes tables, triggers, indexes, and imports seed inventory if needed."""
    with db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()

        # 1. Main books table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS books (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                book_id TEXT UNIQUE NOT NULL,
                title TEXT NOT NULL,
                author TEXT NOT NULL,
                genre TEXT DEFAULT '',
                simple_genre TEXT DEFAULT '',
                language TEXT DEFAULT 'English',
                rack TEXT DEFAULT '',
                column_num TEXT DEFAULT '',
                position TEXT DEFAULT '',
                location_english TEXT DEFAULT '',
                notes TEXT DEFAULT '',
                status TEXT DEFAULT 'Available',
                selling_price REAL DEFAULT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                unassigned_since TEXT DEFAULT NULL,
                image_url TEXT DEFAULT ''
            )
        """)

        # 2. FTS5 full text search table
        cursor.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
                book_id,
                title,
                author,
                genre,
                notes,
                location_english,
                tokenize='porter unicode61'
            )
        """)

        # 3. Triggers to keep FTS5 in sync with books table
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS books_ai AFTER INSERT ON books BEGIN
                INSERT INTO books_fts(rowid, book_id, title, author, genre, notes, location_english)
                VALUES (new.id, new.book_id, new.title, new.author, new.genre, new.notes, new.location_english);
            END;
        """)

        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS books_ad AFTER DELETE ON books BEGIN
                DELETE FROM books_fts WHERE rowid = old.id;
            END;
        """)

        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS books_au AFTER UPDATE ON books BEGIN
                DELETE FROM books_fts WHERE rowid = old.id;
                INSERT INTO books_fts(rowid, book_id, title, author, genre, notes, location_english)
                VALUES (new.id, new.book_id, new.title, new.author, new.genre, new.notes, new.location_english);
            END;
        """)

        # 4. Sales transactions table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS sales_transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                transaction_ref TEXT UNIQUE NOT NULL,
                book_id TEXT NOT NULL,
                title TEXT NOT NULL,
                author TEXT NOT NULL,
                selling_price REAL DEFAULT NULL,
                sold_at TEXT NOT NULL,
                sold_by TEXT DEFAULT 'Staff',
                notes TEXT DEFAULT '',
                synced_to_sheets INTEGER DEFAULT 0
            )
        """)

        # 5. Audit log table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL,
                book_id TEXT NOT NULL,
                before_data TEXT,
                after_data TEXT,
                timestamp TEXT NOT NULL,
                user TEXT DEFAULT 'Staff',
                notes TEXT DEFAULT ''
            )
        """)

        # 6. Google Sheets sync queue (Outbox)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS sync_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                operation TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL,
                status TEXT DEFAULT 'PENDING',
                retry_count INTEGER DEFAULT 0,
                last_error TEXT DEFAULT ''
            )
        """)

        # 7. Create indexes for high-speed queries
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_books_id ON books(book_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_books_status ON books(status)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_books_rack ON books(rack, column_num)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_books_unassigned ON books(unassigned_since)")

        # Ensure simple_genre column exists in existing database
        cursor.execute("PRAGMA table_info(books)")
        existing_cols = [c["name"] for c in cursor.fetchall()]
        if "simple_genre" not in existing_cols:
            cursor.execute("ALTER TABLE books ADD COLUMN simple_genre TEXT DEFAULT ''")
            conn.commit()

        cursor.execute("CREATE INDEX IF NOT EXISTS idx_books_simple_genre ON books(simple_genre)")

        # Backfill simple_genre for existing rows if empty
        cursor.execute("SELECT id, title, genre FROM books WHERE simple_genre IS NULL OR simple_genre = ''")
        missing_simple = cursor.fetchall()
        for r in missing_simple:
            sg = genre_classifier.classify_common_genre(r["genre"] or "", r["title"] or "")
            cursor.execute("UPDATE books SET simple_genre = ? WHERE id = ?", (sg, r["id"]))
        if missing_simple:
            conn.commit()

        conn.commit()

        # Check if books table is empty or forced reseed
        cursor.execute("SELECT COUNT(*) FROM books")
        count = cursor.fetchone()[0]

        if count == 0 or force_reseed:
            if force_reseed:
                cursor.execute("DELETE FROM books")
                cursor.execute("DELETE FROM books_fts")
                cursor.execute("DELETE FROM sales_transactions")
                cursor.execute("DELETE FROM audit_log")
                cursor.execute("DELETE FROM sync_queue")
                conn.commit()
            import_initial_seed(conn)

        conn.close()

def sync_csv_update_status(book_id: str, status: str = "SOLD OUT"):
    """Directly updates the status of a book in initial_inventory.csv in Column K."""
    if not os.path.exists(SEED_CSV_PATH):
        return
    try:
        rows = []
        with open(SEED_CSV_PATH, "r", encoding="utf-8", errors="replace") as f:
            reader = csv.reader(f)
            for r in reader:
                rows.append(r)
        if not rows:
            return

        header = rows[0]
        if "Status" in header:
            status_idx = header.index("Status")
        else:
            header.append("Status")
            status_idx = len(header) - 1

        for r in rows[1:]:
            if len(r) > 1 and r[1].strip() == book_id:
                while len(r) <= status_idx:
                    r.append("")
                r[status_idx] = status
                break

        tmp_path = SEED_CSV_PATH + ".tmp"
        with open(tmp_path, "w", encoding="utf-8", newline="") as f:
            writer = csv.writer(f)
            writer.writerows(rows)
        os.replace(tmp_path, SEED_CSV_PATH)
    except Exception as e:
        print(f"Error updating CSV status for {book_id}: {e}")

def sync_csv_add_book(book_dict: Dict[str, Any]):
    """Appends a new book record directly to initial_inventory.csv."""
    if not os.path.exists(SEED_CSV_PATH):
        return
    try:
        simple = book_dict.get("simple_genre") or genre_classifier.classify_common_genre(
            book_dict.get("genre", ""), book_dict.get("title", "")
        )
        with open(SEED_CSV_PATH, "a", encoding="utf-8", newline="") as f:
            writer = csv.writer(f)
            writer.writerow([
                "",
                book_dict.get("book_id", ""),
                book_dict.get("rack", ""),
                book_dict.get("column_num", ""),
                book_dict.get("position", ""),
                book_dict.get("title", ""),
                book_dict.get("author", ""),
                book_dict.get("genre", ""),
                book_dict.get("notes", ""),
                simple,
                book_dict.get("status", "Available")
            ])
    except Exception as e:
        print(f"Error adding book to CSV: {e}")

def sync_csv_delete_book(book_id: str):
    """Removes a book record directly from initial_inventory.csv."""
    if not os.path.exists(SEED_CSV_PATH):
        return
    try:
        rows = []
        with open(SEED_CSV_PATH, "r", encoding="utf-8", errors="replace") as f:
            reader = csv.reader(f)
            for r in reader:
                if len(r) > 1 and r[1].strip() == book_id:
                    continue
                rows.append(r)
        tmp_path = SEED_CSV_PATH + ".tmp"
        with open(tmp_path, "w", encoding="utf-8", newline="") as f:
            writer = csv.writer(f)
            writer.writerows(rows)
        os.replace(tmp_path, SEED_CSV_PATH)
    except Exception as e:
        print(f"Error deleting book from CSV: {e}")

def sync_csv_update_location(book_id: str, rack: str, column_num: str, position: str):
    """Updates location for a book in initial_inventory.csv."""
    if not os.path.exists(SEED_CSV_PATH):
        return
    try:
        rows = []
        with open(SEED_CSV_PATH, "r", encoding="utf-8", errors="replace") as f:
            reader = csv.reader(f)
            for r in reader:
                if len(r) > 1 and r[1].strip() == book_id:
                    while len(r) <= 4:
                        r.append("")
                    r[2] = rack
                    r[3] = column_num
                    r[4] = position
                rows.append(r)
        tmp_path = SEED_CSV_PATH + ".tmp"
        with open(tmp_path, "w", encoding="utf-8", newline="") as f:
            writer = csv.writer(f)
            writer.writerows(rows)
        os.replace(tmp_path, SEED_CSV_PATH)
    except Exception as e:
        print(f"Error updating book location in CSV: {e}")

def import_initial_seed(conn: sqlite3.Connection):
    """Imports initial inventory from CSV preserving existing Book_IDs and location codes."""
    if not os.path.exists(SEED_CSV_PATH):
        print(f"Warning: {SEED_CSV_PATH} not found. Skipping seed.")
        return

    now_iso = datetime.now().isoformat()
    cursor = conn.cursor()

    with open(SEED_CSV_PATH, "r", encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if not header:
            return

        # Find column indices
        col_map = {}
        for idx, col_name in enumerate(header):
            cleaned = col_name.strip()
            if cleaned:
                col_map[cleaned] = idx

        id_idx = col_map.get("Book_ID", 1)
        rack_idx = col_map.get("Rack", 2)
        column_idx = col_map.get("Column", 3)
        pos_idx = col_map.get("Position_Top_To_Bottom", 4)
        title_idx = col_map.get("Title", 5)
        author_idx = col_map.get("Author_or_Editor", 6)
        genre_idx = col_map.get("Genre", 7)
        notes_idx = col_map.get("Notes", 8)
        simple_genre_idx = col_map.get("Simple_Genre", col_map.get("Simple Genre", -1))

        inserted = 0
        for row in reader:
            if len(row) <= title_idx:
                continue

            book_id = row[id_idx].strip() if id_idx < len(row) else ""
            if not book_id or not book_id.startswith("BK-"):
                continue

            rack = row[rack_idx].strip() if rack_idx < len(row) else ""
            column = row[column_idx].strip() if column_idx < len(row) else ""
            pos = row[pos_idx].strip() if pos_idx < len(row) else ""
            title = row[title_idx].strip() if title_idx < len(row) else ""
            author = row[author_idx].strip() if author_idx < len(row) else ""
            genre = row[genre_idx].strip() if genre_idx < len(row) else ""
            notes = row[notes_idx].strip() if notes_idx < len(row) else ""
            simple_genre = row[simple_genre_idx].strip() if (simple_genre_idx >= 0 and simple_genre_idx < len(row)) else ""
            if not simple_genre:
                simple_genre = genre_classifier.classify_common_genre(genre, title)

            if not title:
                continue

            # Check for sold status in notes or extra columns
            status = "Available"
            for col_val in row[notes_idx:]:
                if "sold out" in col_val.lower() or col_val.strip().upper() == "SOLD OUT":
                    status = "SOLD OUT"
                    break

            is_unassigned = not rack or not column or not pos or rack.lower() == "unassigned"
            unassigned_since = now_iso if is_unassigned else None
            loc_eng = format_location_english(rack, column, pos, notes)

            # Ensure unique Book_ID if original sheet had collision
            final_book_id = book_id
            cursor.execute("SELECT 1 FROM books WHERE book_id = ?", (final_book_id,))
            if cursor.fetchone():
                collision_suffix = 2
                while True:
                    candidate = f"{book_id}-{collision_suffix}"
                    cursor.execute("SELECT 1 FROM books WHERE book_id = ?", (candidate,))
                    if not cursor.fetchone():
                        final_book_id = candidate
                        break
                    collision_suffix += 1
                notes = f"{notes} (Original Sheet ID: {book_id})".strip()

            try:
                cursor.execute("""
                    INSERT INTO books (
                        book_id, title, author, genre, simple_genre, language,
                        rack, column_num, position, location_english,
                        notes, status, created_at, updated_at, unassigned_since
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    final_book_id, title, author, genre, simple_genre, "English",
                    rack, column, pos, loc_eng,
                    notes, status, now_iso, now_iso, unassigned_since
                ))
                inserted += 1
            except sqlite3.IntegrityError:
                pass

        conn.commit()
        print(f"Successfully imported {inserted} books from seed CSV.")

def generate_next_book_id(conn: sqlite3.Connection) -> str:
    """
    Generates the next unique Inventory ID (e.g. BK-11073).
    Ensures collision prevention and concurrency safety.
    """
    cursor = conn.cursor()
    cursor.execute("SELECT book_id FROM books WHERE book_id LIKE 'BK-%'")
    all_ids = cursor.fetchall()

    max_num = 0
    for r in all_ids:
        bid = r["book_id"]
        m = re.search(r"BK-(\d+)", bid)
        if m:
            val = int(m.group(1))
            if val > max_num:
                max_num = val

    next_num = max_num + 1
    # Check for collisions defensively
    while True:
        candidate_id = f"BK-{next_num}"
        cursor.execute("SELECT 1 FROM books WHERE book_id = ?", (candidate_id,))
        if not cursor.fetchone():
            return candidate_id
        next_num += 1

def add_book(
    title: str,
    author: str,
    genre: str = "",
    language: str = "English",
    rack: str = "",
    column_num: str = "",
    position: str = "",
    notes: str = "",
    user: str = "Staff",
    idempotency_key: Optional[str] = None
) -> Dict[str, Any]:
    """
    Adds a new book record with a uniquely generated Inventory ID.
    Performs concurrency checking and audit logging.
    """
    with db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        now_iso = datetime.now().isoformat()

        # Idempotency check if key provided in notes or caller
        if idempotency_key:
            cursor.execute("SELECT * FROM books WHERE notes LIKE ?", (f"%[idempotency:{idempotency_key}]%",))
            existing = cursor.fetchone()
            if existing:
                conn.close()
                return dict(existing)

        book_id = generate_next_book_id(conn)
        is_unassigned = not rack or not column_num or not position or rack.lower() == "unassigned"
        unassigned_since = now_iso if is_unassigned else None
        loc_eng = format_location_english(rack, column_num, position, notes)

        stored_notes = notes
        if idempotency_key:
            stored_notes = f"{notes} [idempotency:{idempotency_key}]".strip()

        simple_genre = genre_classifier.classify_common_genre(genre.strip(), title.strip())

        cursor.execute("""
            INSERT INTO books (
                book_id, title, author, genre, simple_genre, language,
                rack, column_num, position, location_english,
                notes, status, created_at, updated_at, unassigned_since
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Available', ?, ?, ?)
        """, (
            book_id, title.strip(), author.strip(), genre.strip(), simple_genre, language.strip(),
            rack.strip(), column_num.strip(), position.strip(), loc_eng,
            stored_notes, now_iso, now_iso, unassigned_since
        ))

        new_book_id = cursor.lastrowid

        # Record in audit log
        cursor.execute("""
            INSERT INTO audit_log (action, book_id, before_data, after_data, timestamp, user, notes)
            VALUES (?, ?, NULL, ?, ?, ?, ?)
        """, (
            "ADD_BOOK", book_id,
            json.dumps({
                "book_id": book_id, "title": title, "author": author,
                "genre": genre, "rack": rack, "column": column_num, "position": position
            }),
            now_iso, user, "Added individual book"
        ))

        # Enqueue sync to Google Sheets
        cursor.execute("""
            INSERT INTO sync_queue (operation, payload, created_at)
            VALUES (?, ?, ?)
        """, (
            "INSERT_ROW",
            json.dumps({
                "book_id": book_id, "rack": rack, "column": column_num,
                "position": position, "title": title, "author": author,
                "genre": genre, "notes": stored_notes, "status": "Available"
            }),
            now_iso
        ))

        conn.commit()

        cursor.execute("SELECT * FROM books WHERE id = ?", (new_book_id,))
        result = dict(cursor.fetchone())
        conn.close()
        sync_csv_add_book(result)
        return result

def add_books_batch(
    books_list: List[Dict[str, Any]],
    user: str = "Staff"
) -> Dict[str, Any]:
    """
    Bulk adds multiple books in a single transaction.
    Returns list of saved books with their unique Inventory IDs.
    """
    with db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        now_iso = datetime.now().isoformat()

        saved_books = []
        for item in books_list:
            title = (item.get("title") or "").strip()
            author = (item.get("author") or "").strip()
            genre = (item.get("genre") or "").strip()
            language = (item.get("language") or "English").strip()
            rack = (item.get("rack") or "").strip()
            column_num = (item.get("column_num") or "").strip()
            position = (item.get("position") or "").strip()
            notes = (item.get("notes") or "").strip()

            if not title:
                continue

            book_id = generate_next_book_id(conn)
            is_unassigned = not rack or not column_num or not position or rack.lower() == "unassigned"
            unassigned_since = now_iso if is_unassigned else None
            loc_eng = format_location_english(rack, column_num, position, notes)
            simple_genre = item.get("simple_genre") or genre_classifier.classify_common_genre(genre, title)

            cursor.execute("""
                INSERT INTO books (
                    book_id, title, author, genre, simple_genre, language,
                    rack, column_num, position, location_english,
                    notes, status, created_at, updated_at, unassigned_since
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Available', ?, ?, ?)
            """, (
                book_id, title, author, genre, simple_genre, language,
                rack, column_num, position, loc_eng,
                notes, now_iso, now_iso, unassigned_since
            ))

            new_id = cursor.lastrowid

            cursor.execute("""
                INSERT INTO audit_log (action, book_id, before_data, after_data, timestamp, user, notes)
                VALUES (?, ?, NULL, ?, ?, ?, ?)
            """, (
                "BULK_ADD", book_id,
                json.dumps({"title": title, "author": author, "book_id": book_id}),
                now_iso, user, "Added via bulk workflow"
            ))

            cursor.execute("""
                INSERT INTO sync_queue (operation, payload, created_at)
                VALUES (?, ?, ?)
            """, (
                "INSERT_ROW",
                json.dumps({
                    "book_id": book_id, "rack": rack, "column": column_num,
                    "position": position, "title": title, "author": author,
                    "genre": genre, "notes": notes, "status": "Available"
                }),
                now_iso
            ))

            cursor.execute("SELECT * FROM books WHERE id = ?", (new_id,))
            saved_books.append(dict(cursor.fetchone()))

        conn.commit()
        conn.close()
        return {"success": True, "count": len(saved_books), "books": saved_books}

def assign_location(
    book_id: str,
    rack: str,
    column_num: str,
    position: str,
    notes: Optional[str] = None,
    user: str = "Staff"
) -> Dict[str, Any]:
    """
    Updates the location of an inventory copy.
    Preserves Inventory ID, maps location code to English, updates audit log & sync queue.
    """
    with db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        now_iso = datetime.now().isoformat()

        cursor.execute("SELECT * FROM books WHERE book_id = ?", (book_id,))
        existing = cursor.fetchone()
        if not existing:
            conn.close()
            return {"error": f"Book with ID {book_id} not found"}

        before_data = dict(existing)
        loc_notes = notes if notes is not None else existing["notes"]
        loc_eng = format_location_english(rack, column_num, position, loc_notes)

        is_unassigned = not rack or not column_num or not position or rack.lower() == "unassigned"
        unassigned_since = existing["unassigned_since"] if is_unassigned else None

        cursor.execute("""
            UPDATE books SET
                rack = ?,
                column_num = ?,
                position = ?,
                location_english = ?,
                notes = ?,
                updated_at = ?,
                unassigned_since = ?
            WHERE book_id = ?
        """, (
            rack.strip(), column_num.strip(), position.strip(),
            loc_eng, loc_notes, now_iso, unassigned_since, book_id
        ))

        cursor.execute("""
            INSERT INTO audit_log (action, book_id, before_data, after_data, timestamp, user, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            "UPDATE_LOCATION", book_id,
            json.dumps({"rack": existing["rack"], "column": existing["column_num"], "position": existing["position"]}),
            json.dumps({"rack": rack, "column": column_num, "position": position, "location_english": loc_eng}),
            now_iso, user, "Location assigned/updated"
        ))

        cursor.execute("""
            INSERT INTO sync_queue (operation, payload, created_at)
            VALUES (?, ?, ?)
        """, (
            "UPDATE_LOCATION",
            json.dumps({
                "book_id": book_id, "rack": rack, "column": column_num,
                "position": position, "location_english": loc_eng
            }),
            now_iso
        ))

        conn.commit()
        cursor.execute("SELECT * FROM books WHERE book_id = ?", (book_id,))
        updated = dict(cursor.fetchone())
        conn.close()
        sync_csv_update_location(book_id, rack, column_num, position)
        return updated

def assign_location_bulk(
    assignments: List[Dict[str, Any]],
    user: str = "Staff"
) -> Dict[str, Any]:
    """
    Bulk assigns locations to multiple books.
    Supports either assigning the same location or different locations.
    """
    results = []
    errors = []
    for item in assignments:
        bid = item.get("book_id")
        rack = item.get("rack", "")
        col = item.get("column_num", "")
        pos = item.get("position", "")
        notes = item.get("notes")
        res = assign_location(bid, rack, col, pos, notes, user)
        if "error" in res:
            errors.append(res)
        else:
            results.append(res)
    return {"success": True, "updated_count": len(results), "errors": errors, "books": results}

def delete_book(book_id: str, user: str = "Staff") -> Dict[str, Any]:
    """
    Deletes a book record from inventory.
    Records deletion in audit log and registers in sync queue for Google Sheets.
    """
    with db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        now_iso = datetime.now().isoformat()

        cursor.execute("SELECT * FROM books WHERE book_id = ?", (book_id,))
        existing = cursor.fetchone()
        if not existing:
            conn.close()
            return {"error": f"Book with ID {book_id} not found."}

        book_data = dict(existing)

        cursor.execute("DELETE FROM books WHERE book_id = ?", (book_id,))

        # Audit log entry
        cursor.execute("""
            INSERT INTO audit_log (
                action, book_id, before_data, after_data, timestamp, user, notes
            ) VALUES ('DELETE_BOOK', ?, ?, NULL, ?, ?, 'Deleted from inventory')
        """, (book_id, json.dumps(book_data), now_iso, user))

        # Sync queue entry
        cursor.execute("""
            INSERT INTO sync_queue (operation, payload, created_at)
            VALUES ('DELETE_ROW', ?, ?)
        """, (json.dumps({"book_id": book_id, "title": book_data.get("title")}), now_iso))

        conn.commit()
        conn.close()
        sync_csv_delete_book(book_id)
        return {"success": True, "book_id": book_id, "deleted_book": book_data}

def delete_books_bulk(book_ids: List[str], user: str = "Staff") -> Dict[str, Any]:
    """Bulk deletes multiple books from inventory."""
    deleted = []
    errors = []
    for bid in book_ids:
        res = delete_book(bid, user)
        if "error" in res:
            errors.append(res)
        else:
            deleted.append(bid)
    return {"success": True, "deleted_count": len(deleted), "deleted_ids": deleted, "errors": errors}

def sell_book(
    book_id: str,
    selling_price: Optional[float] = None,
    user: str = "Staff",
    notes: str = ""
) -> Dict[str, Any]:
    """
    Executes the selling workflow (Req 3.1 - 3.3):
    1. Verifies book exists and status is Available.
    2. Marks copy status as 'SOLD OUT'.
    3. Records transaction in sales_transactions table with unique Transaction Ref.
    4. Records in audit_log.
    5. Queues Google Sheets update: writes 'SOLD OUT' adjacent to the book and appends to sales sheet.
    """
    with db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        now_iso = datetime.now().isoformat()

        # Step 1: Verify book availability
        cursor.execute("SELECT * FROM books WHERE book_id = ?", (book_id,))
        book = cursor.fetchone()
        if not book:
            conn.close()
            return {"error": f"Book with ID {book_id} not found."}

        if book["status"] == "SOLD OUT":
            conn.close()
            return {"error": f"Book {book_id} is already marked as SOLD OUT. Cannot sell twice."}

        # Step 2: Generate unique transaction reference
        today_code = datetime.now().strftime("%Y%m%d")
        cursor.execute("SELECT COUNT(*) FROM sales_transactions WHERE transaction_ref LIKE ?", (f"TX-{today_code}-%",))
        daily_count = cursor.fetchone()[0] + 1
        tx_ref = f"TX-{today_code}-{daily_count:04d}"

        # Step 3: Update book status
        cursor.execute("""
            UPDATE books SET
                status = 'SOLD OUT',
                selling_price = ?,
                updated_at = ?
            WHERE book_id = ?
        """, (selling_price, now_iso, book_id))

        # Step 4: Record sale transaction
        cursor.execute("""
            INSERT INTO sales_transactions (
                transaction_ref, book_id, title, author,
                selling_price, sold_at, sold_by, notes, synced_to_sheets
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
        """, (
            tx_ref, book_id, book["title"], book["author"],
            selling_price, now_iso, user, notes
        ))

        # Step 5: Audit log
        cursor.execute("""
            INSERT INTO audit_log (action, book_id, before_data, after_data, timestamp, user, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            "SELL_BOOK", book_id,
            json.dumps({"status": "Available", "selling_price": None}),
            json.dumps({"status": "SOLD OUT", "selling_price": selling_price, "transaction_ref": tx_ref}),
            now_iso, user, f"Book sold. Transaction Ref: {tx_ref}"
        ))

        # Step 6: Queue sync for Google Sheets
        cursor.execute("""
            INSERT INTO sync_queue (operation, payload, created_at)
            VALUES (?, ?, ?)
        """, (
            "UPDATE_STATUS",
            json.dumps({
                "book_id": book_id, "status": "SOLD OUT",
                "transaction_ref": tx_ref, "selling_price": selling_price
            }),
            now_iso
        ))

        cursor.execute("""
            INSERT INTO sync_queue (operation, payload, created_at)
            VALUES (?, ?, ?)
        """, (
            "APPEND_SALE",
            json.dumps({
                "transaction_ref": tx_ref,
                "book_id": book_id,
                "title": book["title"],
                "author": book["author"],
                "selling_price": selling_price,
                "sold_at": now_iso,
                "sold_by": user,
                "notes": notes
            }),
            now_iso
        ))

        conn.commit()

        cursor.execute("SELECT * FROM books WHERE book_id = ?", (book_id,))
        updated_book = dict(cursor.fetchone())

        conn.close()
        sync_csv_update_status(book_id, "SOLD OUT")

        return {
            "success": True,
            "transaction_ref": tx_ref,
            "book": updated_book,
            "selling_price": selling_price,
            "sold_at": now_iso,
            "message": f"Successfully completed sale for {updated_book['title']} ({book_id})."
        }

def revert_sale(book_id: str) -> Dict[str, Any]:
    """Reverts a sold book back to 'Available' status and removes test transaction."""
    with db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("UPDATE books SET status = 'Available', selling_price = NULL WHERE book_id = ?", (book_id,))
        cursor.execute("DELETE FROM sales_transactions WHERE book_id = ?", (book_id,))
        cursor.execute("DELETE FROM sync_queue WHERE payload LIKE ?", (f'%"{book_id}"%',))
        conn.commit()
        conn.close()
        sync_csv_update_status(book_id, "")
        return {"success": True, "book_id": book_id, "status": "Available"}

def update_book_metadata(
    book_id: str,
    title: Optional[str] = None,
    author: Optional[str] = None,
    genre: Optional[str] = None,
    language: Optional[str] = None,
    notes: Optional[str] = None,
    status: Optional[str] = None,
    user: str = "Staff"
) -> Dict[str, Any]:
    """Updates book metadata while preserving Inventory ID and location history."""
    with db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        now_iso = datetime.now().isoformat()

        cursor.execute("SELECT * FROM books WHERE book_id = ?", (book_id,))
        existing = cursor.fetchone()
        if not existing:
            conn.close()
            return {"error": f"Book with ID {book_id} not found."}

        new_title = title.strip() if title is not None else existing["title"]
        new_author = author.strip() if author is not None else existing["author"]
        new_genre = genre.strip() if genre is not None else existing["genre"]
        new_lang = language.strip() if language is not None else existing["language"]
        new_notes = notes.strip() if notes is not None else existing["notes"]
        new_status = status.strip() if status is not None else existing["status"]
        new_simple_genre = genre_classifier.classify_common_genre(new_genre, new_title)

        cursor.execute("""
            UPDATE books SET
                title = ?,
                author = ?,
                genre = ?,
                simple_genre = ?,
                language = ?,
                notes = ?,
                status = ?,
                updated_at = ?
            WHERE book_id = ?
        """, (new_title, new_author, new_genre, new_simple_genre, new_lang, new_notes, new_status, now_iso, book_id))

        cursor.execute("""
            INSERT INTO audit_log (action, book_id, before_data, after_data, timestamp, user, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            "EDIT_METADATA", book_id,
            json.dumps(dict(existing)),
            json.dumps({"title": new_title, "author": new_author, "genre": new_genre, "status": new_status}),
            now_iso, user, "Metadata updated"
        ))

        cursor.execute("""
            INSERT INTO sync_queue (operation, payload, created_at)
            VALUES (?, ?, ?)
        """, (
            "UPDATE_METADATA",
            json.dumps({
                "book_id": book_id, "title": new_title, "author": new_author,
                "genre": new_genre, "notes": new_notes, "status": new_status
            }),
            now_iso
        ))

        conn.commit()
        cursor.execute("SELECT * FROM books WHERE book_id = ?", (book_id,))
        res = dict(cursor.fetchone())
        conn.close()
        return res

def get_unassigned_books(query: str = "", limit: int = 200, offset: int = 0) -> Dict[str, Any]:
    """Retrieves books that do not have an assigned location, with duration analysis."""
    conn = get_db_connection()
    cursor = conn.cursor()

    base_sql = """
        SELECT * FROM books 
        WHERE (rack = '' OR rack IS NULL OR column_num = '' OR column_num IS NULL 
               OR position = '' OR position IS NULL OR lower(rack) = 'unassigned')
    """
    params = []

    if query:
        base_sql += " AND (title LIKE ? OR author LIKE ? OR genre LIKE ? OR book_id LIKE ?)"
        pattern = f"%{query.strip()}%"
        params.extend([pattern, pattern, pattern, pattern])

    # Count total unassigned
    cursor.execute(f"SELECT COUNT(*) FROM ({base_sql})", params)
    total = cursor.fetchone()[0]

    # Order by unassigned_since ascending (oldest unassigned first)
    base_sql += " ORDER BY unassigned_since ASC, id DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])

    cursor.execute(base_sql, params)
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()

    # Calculate days unassigned
    now = datetime.now()
    for r in rows:
        r["days_unassigned"] = 0
        if r.get("unassigned_since"):
            try:
                dt = datetime.fromisoformat(r["unassigned_since"])
                r["days_unassigned"] = max(0, (now - dt).days)
            except Exception:
                pass

    return {"total": total, "books": rows}

def get_recent_sales(limit: int = 100) -> List[Dict[str, Any]]:
    """Fetches recent sales transactions."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM sales_transactions ORDER BY id DESC LIMIT ?", (limit,))
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows

def get_audit_history(book_id: Optional[str] = None, limit: int = 100) -> List[Dict[str, Any]]:
    """Fetches audit history log."""
    conn = get_db_connection()
    cursor = conn.cursor()
    if book_id:
        cursor.execute("SELECT * FROM audit_log WHERE book_id = ? ORDER BY id DESC LIMIT ?", (book_id, limit))
    else:
        cursor.execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,))
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows

def get_inventory_stats() -> Dict[str, Any]:
    """Computes real-time inventory statistics."""
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT COUNT(*) FROM books")
    total_copies = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(DISTINCT lower(title)) FROM books")
    unique_titles = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM books WHERE status = 'Available'")
    available_copies = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM books WHERE status = 'SOLD OUT'")
    sold_copies = cursor.fetchone()[0]

    cursor.execute("""
        SELECT COUNT(*) FROM books 
        WHERE (rack = '' OR rack IS NULL OR column_num = '' OR column_num IS NULL 
               OR position = '' OR position IS NULL OR lower(rack) = 'unassigned')
    """)
    unassigned_count = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(DISTINCT rack) FROM books WHERE rack != '' AND lower(rack) != 'unassigned'")
    rack_count = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM sales_transactions")
    total_sales_count = cursor.fetchone()[0]

    cursor.execute("SELECT SUM(selling_price) FROM sales_transactions WHERE selling_price IS NOT NULL")
    total_revenue = cursor.fetchone()[0] or 0.0

    conn.close()

    return {
        "total_copies": total_copies,
        "unique_titles": unique_titles,
        "available_copies": available_copies,
        "sold_copies": sold_copies,
        "unassigned_count": unassigned_count,
        "rack_count": rack_count,
        "total_sales_count": total_sales_count,
        "total_revenue": round(total_revenue, 2)
    }

def get_genre_distribution() -> List[Dict[str, Any]]:
    """Returns all canonical simple genres with book counts and availability."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT 
            simple_genre,
            COUNT(*) as total_copies,
            COUNT(DISTINCT lower(title)) as unique_titles,
            SUM(CASE WHEN status = 'Available' THEN 1 ELSE 0 END) as available_copies,
            SUM(CASE WHEN status = 'SOLD OUT' THEN 1 ELSE 0 END) as sold_copies
        FROM books
        WHERE simple_genre != '' AND simple_genre IS NOT NULL
        GROUP BY simple_genre
        ORDER BY total_copies DESC
    """)
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows

def get_books_by_genre(genre: str, available_only: bool = False, limit: int = 500) -> List[Dict[str, Any]]:
    """Returns books classified under a given canonical simple genre."""
    conn = get_db_connection()
    cursor = conn.cursor()
    sql = "SELECT * FROM books WHERE lower(simple_genre) = lower(?)"
    params = [genre.strip()]
    if available_only:
        sql += " AND status = 'Available'"
    sql += " ORDER BY title ASC, id ASC LIMIT ?"
    params.append(limit)
    cursor.execute(sql, params)
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows
