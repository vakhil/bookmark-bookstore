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
    if not os.path.exists(tmp_db):
        candidates = [
            DB_PATH,
            os.path.join(os.getcwd(), "bookstore.db"),
            "/var/task/bookstore.db",
            os.path.join(os.path.dirname(os.path.dirname(__file__)), "bookstore.db")
        ]
        for c in candidates:
            if os.path.exists(c) and os.path.getsize(c) > 1000:
                try:
                    shutil.copyfile(c, tmp_db)
                    break
                except Exception as e:
                    print(f"Notice copying DB candidate {c}: {e}")
    if os.path.exists(tmp_db):
        DB_PATH = tmp_db

    tmp_csv = "/tmp/initial_inventory.csv"
    if not os.path.exists(tmp_csv):
        csv_candidates = [
            SEED_CSV_PATH,
            os.path.join(os.getcwd(), "initial_inventory.csv"),
            "/var/task/initial_inventory.csv",
            os.path.join(os.path.dirname(os.path.dirname(__file__)), "initial_inventory.csv")
        ]
        for c in csv_candidates:
            if os.path.exists(c) and os.path.getsize(c) > 1000:
                try:
                    shutil.copyfile(c, tmp_csv)
                    break
                except Exception as e:
                    print(f"Notice copying CSV candidate {c}: {e}")
    if os.path.exists(tmp_csv):
        SEED_CSV_PATH = tmp_csv

# Global lock for concurrency control across threads
db_lock = threading.Lock()

_schema_ensured = False

def ensure_schema(conn):
    global _schema_ensured
    if _schema_ensured:
        return
    try:
        cursor = conn.cursor()
        cursor.execute("PRAGMA table_info(sales_transactions)")
        st_cols = [c["name"] for c in cursor.fetchall()]
        if st_cols:
            if "order_id" not in st_cols:
                try:
                    cursor.execute("ALTER TABLE sales_transactions ADD COLUMN order_id TEXT")
                    cursor.execute("UPDATE sales_transactions SET order_id = transaction_ref WHERE order_id IS NULL OR order_id = ''")
                    conn.commit()
                except Exception:
                    pass
            if "status" not in st_cols:
                try:
                    cursor.execute("ALTER TABLE sales_transactions ADD COLUMN status TEXT DEFAULT 'COMPLETED'")
                    conn.commit()
                except Exception:
                    pass
        _schema_ensured = True
    except Exception:
        pass

def generate_unique_transaction_ref(cursor, today_code: str) -> str:
    """Generates a guaranteed unique transaction reference for today, avoiding any sequence gaps or collisions."""
    cursor.execute("SELECT transaction_ref FROM sales_transactions WHERE transaction_ref LIKE ?", (f"TX-{today_code}-%",))
    rows = cursor.fetchall()
    max_num = 0
    for r in rows:
        ref = r[0] if isinstance(r, (list, tuple)) else (r["transaction_ref"] if hasattr(r, "__getitem__") else str(r))
        try:
            num = int(str(ref).split("-")[-1])
            if num > max_num:
                max_num = num
        except (ValueError, IndexError):
            pass
    num = max_num + 1
    while True:
        candidate = f"TX-{today_code}-{num:04d}"
        cursor.execute("SELECT 1 FROM sales_transactions WHERE transaction_ref = ?", (candidate,))
        if not cursor.fetchone():
            return candidate
        num += 1

def generate_unique_order_id(cursor, today_code: str) -> str:
    """Generates a guaranteed unique order_id for today, avoiding collisions."""
    try:
        cursor.execute("SELECT order_id FROM sales_transactions WHERE order_id LIKE ?", (f"ORD-{today_code}-%",))
        rows = cursor.fetchall()
    except Exception:
        rows = []
    max_num = 0
    for r in rows:
        oid = r[0] if isinstance(r, (list, tuple)) else (r["order_id"] if hasattr(r, "__getitem__") else str(r))
        if oid:
            try:
                num = int(str(oid).split("-")[-1])
                if num > max_num:
                    max_num = num
            except (ValueError, IndexError):
                pass
    num = max_num + 1
    while True:
        candidate = f"ORD-{today_code}-{num:04d}"
        try:
            cursor.execute("SELECT 1 FROM sales_transactions WHERE order_id = ?", (candidate,))
            if not cursor.fetchone():
                return candidate
        except Exception:
            return candidate
        num += 1

def get_db_connection() -> Any:
    """Creates a database connection with dictionary row access.
    Automatically connects to Turso Cloud (libSQL) when TURSO_DATABASE_URL and
    TURSO_AUTH_TOKEN are set; otherwise connects to local SQLite bookstore.db.
    """
    turso_url = os.environ.get("TURSO_DATABASE_URL", "").strip()
    turso_token = os.environ.get("TURSO_AUTH_TOKEN", "").strip()

    if turso_url and turso_token:
        try:
            import turso_client
            conn = turso_client.connect(turso_url, turso_token)
            ensure_schema(conn)
            return conn
        except Exception as e:
            print(f"Warning: Turso connection failed ({e}), falling back to local SQLite.")

    conn = sqlite3.connect(DB_PATH, timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    ensure_schema(conn)
    try:
        conn.execute("PRAGMA foreign_keys = ON")
    except Exception:
        pass
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except Exception:
        pass
    try:
        conn.execute("PRAGMA busy_timeout = 30000")
    except Exception:
        pass
    return conn

def parse_rack_value(val: Any) -> Optional[int]:
    """
    Normalizes rack input to integer:
      - 'Rack 1' -> 1, 'Rack 36' -> 36
      - 'Top Rack 1' -> 5001, 'Top Rack 2' -> 5002, 'Top Rack 400' -> 5400 ('Top Rack <N>' -> 5000 + N)
      - 'Top Rack Part 2' -> 10000
      - 'Top Rack Part <N>' -> 10000 + N (e.g. 'Top Rack Part 5' -> 10005)
      - Unassigned / empty / None -> None
    """
    if val is None:
        return None
    s = str(val).strip()
    if not s or s.lower() in ("none", "null", "unassigned", ""):
        return None
    s_clean = " ".join(s.split())
    # 1. Top Rack Part <N>
    m_part = re.search(r"top\s*rack\s*part\s*(\d+)", s_clean, re.IGNORECASE)
    if m_part:
        part_num = int(m_part.group(1))
        if part_num == 2:
            return 10000
        return 10000 + part_num

    # 2. Top Rack <N> (e.g. Top Rack 1 -> 5001, Top Rack 2 -> 5002, Top Rack 400 -> 5400)
    m_top = re.search(r"top\s*rack\s*(\d+)", s_clean, re.IGNORECASE)
    if m_top:
        return 5000 + int(m_top.group(1))

    # 3. Pure integer or Rack <N>
    m_num = re.search(r"\d+", s_clean)
    if m_num:
        return int(m_num.group(0))
    return None

def parse_column_value(val: Any) -> Optional[int]:
    """Extracts integer column number (e.g. 'Column 1' -> 1, 'Column 4 (Vertical)' -> 4)."""
    if val is None:
        return None
    s = str(val).strip()
    if not s or s.lower() in ("none", "null", "unassigned", ""):
        return None
    m = re.search(r"\d+", s)
    if m:
        return int(m.group(0))
    return None

def parse_position_value(val: Any) -> Optional[int]:
    """Extracts integer position number (e.g. '1', 1, '1 (Top Horizontal)' -> 1)."""
    if val is None:
        return None
    s = str(val).strip()
    if not s or s.lower() in ("none", "null", "unassigned", ""):
        return None
    m = re.search(r"\d+", s)
    if m:
        return int(m.group(0))
    return None

def format_location_english(rack: Any, column: Any, position: Any, notes: Optional[str] = "") -> str:
    """
    Translates integer rack, column, and position codes into standard bookstore English:
      - Rack 50 -> Column 1 -> On top of the rack
      - Rack 5001 -> Column 2 -> 5th book from top
    """
    r_int = parse_rack_value(rack)
    c_int = parse_column_value(column)
    p_int = parse_position_value(position)

    if r_int is None or c_int is None or p_int is None:
        return "Unassigned"

    if p_int == 1:
        placement = "On top of the rack"
    elif p_int == 2:
        placement = "2nd book from top"
    elif p_int == 3:
        placement = "3rd book from top"
    else:
        suffix = "th"
        if 11 <= (p_int % 100) <= 13:
            suffix = "th"
        else:
            suffix = {1: "st", 2: "nd", 3: "rd"}.get(p_int % 10, "th")
        placement = f"{p_int}{suffix} book from top"

    return f"Rack {r_int} → Column {c_int} → {placement}"

def sanitize_title(title: str) -> str:
    """Removes 'Copy 1', 'Copy 2', '(Copy 1 of 2)', etc. from book title."""
    if not title:
        return ""
    t = title
    t = re.sub(r',\s*copy\s*\d+(\s*of\s*\d+)?\s*(?=\))', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*\(\s*copy\s*\d+(\s*of\s*\d+)?\s*\)', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*[-–—]\s*copy\s*\d+(\s*of\s*\d+)?\s*$', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\s+copy\s+\d+(\s*of\s*\d+)?\s*$', '', t, flags=re.IGNORECASE)
    return t.strip()

def sanitize_notes(n: str) -> str:
    """Removes 'Copy 1 of 2', 'Copy 1', etc. from notes."""
    if not n:
        return ""
    s = re.sub(r'\s*\(\s*copy\s*\d+(\s*of\s*\d+)?\s*\)', '', n, flags=re.IGNORECASE)
    s = re.sub(r'\bcopy\s*\d+(\s*of\s*\d+)?\b', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\s*[-–—]\s*$', '', s).strip()
    s = re.sub(r'^\s*[-–—]\s*', '', s).strip()
    return s.strip()

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
                rack INTEGER DEFAULT NULL,
                column_num INTEGER DEFAULT NULL,
                position INTEGER DEFAULT NULL,
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

        # 2. FTS5 full text search table (optional accelerator)
        try:
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
        except Exception as fts_err:
            pass

        # 4. Sales transactions table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS sales_transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                transaction_ref TEXT UNIQUE NOT NULL,
                order_id TEXT,
                book_id TEXT NOT NULL,
                title TEXT NOT NULL,
                author TEXT NOT NULL,
                selling_price REAL DEFAULT NULL,
                sold_at TEXT NOT NULL,
                sold_by TEXT DEFAULT 'Staff',
                notes TEXT DEFAULT '',
                status TEXT DEFAULT 'COMPLETED',
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

        # Ensure order_id and status columns exist in sales_transactions
        cursor.execute("PRAGMA table_info(sales_transactions)")
        st_cols = [c["name"] for c in cursor.fetchall()]
        if "order_id" not in st_cols:
            try:
                cursor.execute("ALTER TABLE sales_transactions ADD COLUMN order_id TEXT")
                cursor.execute("UPDATE sales_transactions SET order_id = transaction_ref WHERE order_id IS NULL OR order_id = ''")
                conn.commit()
            except Exception:
                pass
        if "status" not in st_cols:
            try:
                cursor.execute("ALTER TABLE sales_transactions ADD COLUMN status TEXT DEFAULT 'COMPLETED'")
                conn.commit()
            except Exception:
                pass
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_st_order_id ON sales_transactions(order_id)")

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

def migrate_database_schema(conn: sqlite3.Connection):
    """Migrates books table schema so that rack, column_num, position are stored as pure INTEGER."""
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM books ORDER BY id ASC")
    rows = cursor.fetchall()

    cursor.execute("DROP TABLE IF EXISTS books_new")
    cursor.execute("""
        CREATE TABLE books_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            author TEXT NOT NULL,
            genre TEXT DEFAULT '',
            simple_genre TEXT DEFAULT '',
            language TEXT DEFAULT 'English',
            rack INTEGER DEFAULT NULL,
            column_num INTEGER DEFAULT NULL,
            position INTEGER DEFAULT NULL,
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

    migrated_rows = []
    for r in rows:
        r_int = parse_rack_value(r["rack"])
        c_int = parse_column_value(r["column_num"])
        p_int = parse_position_value(r["position"])
        loc_eng = format_location_english(r_int, c_int, p_int, r["notes"])

        migrated_rows.append((
            r["id"], r["book_id"], r["title"], r["author"], r["genre"], r["simple_genre"], r["language"],
            r_int, c_int, p_int, loc_eng,
            r["notes"], r["status"], r["selling_price"],
            r["created_at"], r["updated_at"], r["unassigned_since"],
            r["image_url"]
        ))

    cursor.executemany("""
        INSERT INTO books_new (
            id, book_id, title, author, genre, simple_genre, language,
            rack, column_num, position, location_english,
            notes, status, selling_price,
            created_at, updated_at, unassigned_since,
            image_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, migrated_rows)

    cursor.execute("DROP TRIGGER IF EXISTS books_ai")
    cursor.execute("DROP TRIGGER IF EXISTS books_ad")
    cursor.execute("DROP TRIGGER IF EXISTS books_au")

    cursor.execute("DROP TABLE books")
    cursor.execute("ALTER TABLE books_new RENAME TO books")

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_books_id ON books(book_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_books_status ON books(status)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_books_rack ON books(rack, column_num)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_books_unassigned ON books(unassigned_since)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_books_simple_genre ON books(simple_genre)")

    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS books_ai AFTER INSERT ON books BEGIN
            INSERT INTO books_fts(rowid, book_id, title, author, genre, notes, location_english)
            VALUES (new.id, new.book_id, new.title, new.author, new.genre, new.notes, new.location_english);
        END
    """)
    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS books_ad AFTER DELETE ON books BEGIN
            DELETE FROM books_fts WHERE rowid = old.id;
        END
    """)
    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS books_au AFTER UPDATE ON books BEGIN
            DELETE FROM books_fts WHERE rowid = old.id;
            INSERT INTO books_fts(rowid, book_id, title, author, genre, notes, location_english)
            VALUES (new.id, new.book_id, new.title, new.author, new.genre, new.notes, new.location_english);
        END
    """)

    cursor.execute("DELETE FROM books_fts")
    cursor.execute("""
        INSERT INTO books_fts(rowid, book_id, title, author, genre, notes, location_english)
        SELECT id, book_id, title, author, genre, notes, location_english FROM books
    """)
    conn.commit()

_DB_IS_VERIFIED = False

def ensure_database_ready():
    """Verifies books exist; if empty or missing, initializes and seeds from CSV or Google Sheet."""
    global _DB_IS_VERIFIED
    if _DB_IS_VERIFIED:
        return
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='books'")
        if not cursor.fetchone():
            conn.close()
            init_database(force_reseed=True)
            _DB_IS_VERIFIED = True
            return
        cursor.execute("SELECT COUNT(*) FROM books")
        cnt = cursor.fetchone()[0]
        if cnt == 0:
            conn.close()
            init_database(force_reseed=True)
            _DB_IS_VERIFIED = True
            return

        # Sanitize any legacy copy suffixes on warm containers
        cursor.execute("PRAGMA table_info(books)")
        cols = {row["name"]: row["type"].upper() for row in cursor.fetchall()}
        if cols.get("rack") != "INTEGER":
            print("Auto-migrating books schema to INTEGER rack, column_num, position...")
            migrate_database_schema(conn)

        cursor.execute("SELECT id, title, notes FROM books WHERE title LIKE '%copy%' OR notes LIKE '%copy%'")
        to_clean = cursor.fetchall()
        for r in to_clean:
            cursor.execute(
                "UPDATE books SET title = ?, notes = ? WHERE id = ?",
                (sanitize_title(r["title"]), sanitize_notes(r["notes"]), r["id"])
            )
        if to_clean:
            conn.commit()
        conn.close()
        _DB_IS_VERIFIED = True
    except Exception as e:
        print(f"Notice initializing database: {e}")
        try:
            init_database(force_reseed=True)
        except Exception:
            pass

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
            title = sanitize_title(row[title_idx].strip() if title_idx < len(row) else "")
            author = row[author_idx].strip() if author_idx < len(row) else ""
            genre = row[genre_idx].strip() if genre_idx < len(row) else ""
            notes = sanitize_notes(row[notes_idx].strip() if notes_idx < len(row) else "")
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

            r_int = parse_rack_value(rack)
            c_int = parse_column_value(column)
            p_int = parse_position_value(pos)
            is_unassigned = r_int is None or c_int is None or p_int is None
            unassigned_since = now_iso if is_unassigned else None
            loc_eng = format_location_english(r_int, c_int, p_int, notes)

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
                    r_int, c_int, p_int, loc_eng,
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

def notify_inventory_changed():
    """Invalidates the in-memory book search cache on writes."""
    try:
        import search_engine
        search_engine.invalidate_search_cache()
    except Exception:
        pass

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
    clean_title = sanitize_title(title.strip())
    clean_notes = sanitize_notes(notes.strip())
    r_int = parse_rack_value(rack)
    c_int = parse_column_value(column_num)
    p_int = parse_position_value(position)
    loc_eng = format_location_english(r_int, c_int, p_int, clean_notes)

    stored_notes = clean_notes
    if idempotency_key:
        stored_notes = f"{clean_notes} [idempotency:{idempotency_key}]".strip()

    assigned_genre = genre.strip()
    if not assigned_genre:
        try:
            import ocr_engine
            assigned_genre = ocr_engine.predict_genre_with_llm(clean_title, author.strip())
        except Exception:
            assigned_genre = "General Non-Fiction"

    simple_genre = genre_classifier.classify_common_genre(assigned_genre, clean_title)

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
        is_unassigned = r_int is None or c_int is None or p_int is None
        unassigned_since = now_iso if is_unassigned else None

        cursor.execute("""
            INSERT INTO books (
                book_id, title, author, genre, simple_genre, language,
                rack, column_num, position, location_english,
                notes, status, created_at, updated_at, unassigned_since
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Available', ?, ?, ?)
        """, (
            book_id, clean_title, author.strip(), assigned_genre, simple_genre, language.strip(),
            r_int, c_int, p_int, loc_eng,
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
        notify_inventory_changed()
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
            title = sanitize_title((item.get("title") or "").strip())
            author = (item.get("author") or "").strip()
            genre = (item.get("genre") or "").strip()
            language = (item.get("language") or "English").strip()
            r_int = parse_rack_value(item.get("rack"))
            c_int = parse_column_value(item.get("column_num"))
            p_int = parse_position_value(item.get("position"))
            notes = sanitize_notes((item.get("notes") or "").strip())

            if not title:
                continue

            book_id = generate_next_book_id(conn)
            is_unassigned = r_int is None or c_int is None or p_int is None
            unassigned_since = now_iso if is_unassigned else None
            loc_eng = format_location_english(r_int, c_int, p_int, notes)
            simple_genre = item.get("simple_genre") or genre_classifier.classify_common_genre(genre, title)

            cursor.execute("""
                INSERT INTO books (
                    book_id, title, author, genre, simple_genre, language,
                    rack, column_num, position, location_english,
                    notes, status, created_at, updated_at, unassigned_since
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Available', ?, ?, ?)
            """, (
                book_id, title, author, genre, simple_genre, language,
                r_int, c_int, p_int, loc_eng,
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
        notify_inventory_changed()
        return {"success": True, "count": len(saved_books), "books": saved_books}

def assign_location(
    book_id: str,
    rack: Any,
    column_num: Any,
    position: Any,
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
        r_int = parse_rack_value(rack)
        c_int = parse_column_value(column_num)
        p_int = parse_position_value(position)
        loc_eng = format_location_english(r_int, c_int, p_int, loc_notes)

        is_unassigned = r_int is None or c_int is None or p_int is None
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
            r_int, c_int, p_int,
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
        notify_inventory_changed()
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
        notify_inventory_changed()
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
        tx_ref = generate_unique_transaction_ref(cursor, today_code)

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
                transaction_ref, order_id, book_id, title, author,
                selling_price, sold_at, sold_by, notes, status, synced_to_sheets
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', 0)
        """, (
            tx_ref, tx_ref, book_id, book["title"], book["author"],
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
        notify_inventory_changed()

        return {
            "success": True,
            "transaction_ref": tx_ref,
            "book": updated_book,
            "selling_price": selling_price,
            "sold_at": now_iso,
            "message": f"Successfully completed sale for {updated_book['title']} ({book_id})."
        }

def sell_books_bulk(
    items: List[Dict[str, Any]],
    user: str = "Staff",
    shared_notes: str = ""
) -> Dict[str, Any]:
    """
    Executes selling multiple physical books at once (multi-book sale transaction).
    Each item in items contains:
      - book_id: str (required)
      - selling_price: Optional[float]
      - notes: Optional[str]
    Marks each book as 'SOLD OUT', generates transaction references,
    logs into audit_log and sales_transactions, and queues sync to Google Sheets.
    """
    if not items:
        return {"error": "No books provided to sell."}

    with db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        now_iso = datetime.now().isoformat()
        today_code = datetime.now().strftime("%Y%m%d")

        order_id = generate_unique_order_id(cursor, today_code)

        successful_sales = []
        errors = []
        total_amount = 0.0

        for item in items:
            bid = (item.get("book_id") or "").strip()
            if not bid:
                continue

            price = item.get("selling_price")
            price_val = None
            if price is not None and str(price).strip() != "":
                try:
                    price_val = float(price)
                except ValueError:
                    price_val = None

            notes = (item.get("notes") or shared_notes or "").strip()

            cursor.execute("SELECT * FROM books WHERE book_id = ?", (bid,))
            book = cursor.fetchone()
            if not book:
                errors.append(f"Book {bid} not found in inventory.")
                continue

            if book["status"] == "SOLD OUT":
                errors.append(f"Book '{book['title']}' ({bid}) is already marked as SOLD OUT.")
                continue

            tx_ref = generate_unique_transaction_ref(cursor, today_code)

            cursor.execute("""
                UPDATE books SET
                    status = 'SOLD OUT',
                    selling_price = ?,
                    updated_at = ?
                WHERE book_id = ?
            """, (price_val, now_iso, bid))

            cursor.execute("""
                INSERT INTO sales_transactions (
                    transaction_ref, order_id, book_id, title, author,
                    selling_price, sold_at, sold_by, notes, status, synced_to_sheets
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', 0)
            """, (
                tx_ref, order_id, bid, book["title"], book["author"],
                price_val, now_iso, user, notes
            ))

            cursor.execute("""
                INSERT INTO audit_log (action, book_id, before_data, after_data, timestamp, user, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                "SELL_BOOK_BULK", bid,
                json.dumps({"status": "Available", "selling_price": None}),
                json.dumps({"status": "SOLD OUT", "selling_price": price_val, "transaction_ref": tx_ref}),
                now_iso, user, f"Bulk sale transaction: {tx_ref}"
            ))

            cursor.execute("""
                INSERT INTO sync_queue (operation, payload, created_at)
                VALUES (?, ?, ?)
            """, (
                "UPDATE_STATUS",
                json.dumps({
                    "book_id": bid, "status": "SOLD OUT",
                    "transaction_ref": tx_ref, "selling_price": price_val
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
                    "book_id": bid,
                    "title": book["title"],
                    "author": book["author"],
                    "selling_price": price_val,
                    "sold_at": now_iso,
                    "sold_by": user,
                    "notes": notes
                }),
                now_iso
            ))

            sync_csv_update_status(bid, "SOLD OUT")
            if price_val is not None:
                total_amount += price_val

            successful_sales.append({
                "book_id": bid,
                "title": book["title"],
                "author": book["author"],
                "transaction_ref": tx_ref,
                "selling_price": price_val,
                "location_english": book["location_english"]
            })

        conn.commit()
        conn.close()
        notify_inventory_changed()

        if not successful_sales and errors:
            return {"error": "; ".join(errors), "errors": errors}

        return {
            "success": True,
            "order_id": order_id,
            "count": len(successful_sales),
            "total_amount": round(total_amount, 2),
            "sold_books": successful_sales,
            "errors": errors,
            "message": f"Successfully completed sale for {len(successful_sales)} books."
        }

def revert_sale(
    book_id: str,
    user: str = "Staff",
    notes: str = "",
    position_mode: str = "previous",
    rack: Any = None,
    column_num: Any = None,
    position: Any = None,
    refund_amount: Any = None
) -> Dict[str, Any]:
    """Reverts a sold book back to 'Available' status, refunds/repays customer, and returns to previous or new shelf position."""
    with db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        now_iso = datetime.now().isoformat()
        cursor.execute("SELECT * FROM books WHERE book_id = ?", (book_id,))
        book = cursor.fetchone()
        if not book:
            conn.close()
            return {"error": f"Book with ID {book_id} not found."}

        cursor.execute("SELECT * FROM sales_transactions WHERE book_id = ? ORDER BY id DESC LIMIT 1", (book_id,))
        tx = cursor.fetchone()
        amount_paid = (tx["selling_price"] if tx and tx["selling_price"] is not None else book["selling_price"]) or 0.0

        if refund_amount is not None and refund_amount != "":
            try:
                final_refund = round(float(refund_amount), 2)
            except (ValueError, TypeError):
                final_refund = amount_paid
        else:
            final_refund = amount_paid

        new_rack = book["rack"]
        new_col = book["column_num"]
        new_pos = book["position"]
        new_loc_eng = book["location_english"]
        new_unassigned_since = book["unassigned_since"]

        mode_clean = (position_mode or "previous").strip().lower()
        if mode_clean == "new":
            new_r_int = parse_rack_value(rack)
            new_c_int = parse_column_value(column_num)
            new_p_int = parse_position_value(position)
            new_rack = new_r_int
            new_col = new_c_int
            new_pos = new_p_int
            if new_r_int is not None:
                new_loc_eng = format_location_english(new_r_int, new_c_int, new_p_int)
                new_unassigned_since = None
            else:
                new_loc_eng = None
                new_unassigned_since = now_iso
        elif mode_clean == "unassigned":
            new_rack = None
            new_col = None
            new_pos = None
            new_loc_eng = None
            new_unassigned_since = now_iso
        else:
            # Previous position: keep book's recorded rack, column, position
            if new_rack is not None and not new_loc_eng:
                new_loc_eng = format_location_english(new_rack, new_col, new_pos)

        cursor.execute("""
            UPDATE books SET
                status = 'Available',
                selling_price = NULL,
                rack = ?,
                column_num = ?,
                position = ?,
                location_english = ?,
                updated_at = ?,
                unassigned_since = ?
            WHERE book_id = ?
        """, (new_rack, new_col, new_pos, new_loc_eng, now_iso, new_unassigned_since, book_id))

        cursor.execute("DELETE FROM sales_transactions WHERE book_id = ?", (book_id,))
        cursor.execute("DELETE FROM sync_queue WHERE payload LIKE ?", (f'%"{book_id}"%',))

        cursor.execute("""
            INSERT INTO audit_log (action, book_id, before_data, after_data, timestamp, user, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            "CANCEL_SALE_RETURN", book_id,
            json.dumps({"status": book["status"], "selling_price": amount_paid, "location_english": book["location_english"]}),
            json.dumps({
                "status": "Available",
                "selling_price": None,
                "refunded_amount": final_refund,
                "position_mode": mode_clean,
                "rack": new_rack,
                "column_num": new_col,
                "position": new_pos,
                "location_english": new_loc_eng
            }),
            now_iso, user, f"Sale cancelled & returned to shelf ({'New position' if mode_clean == 'new' else 'Previous position'}: {new_loc_eng or 'Unassigned'}). Repaid ₹{final_refund:g}. {notes}".strip()
        ))

        cursor.execute("""
            INSERT INTO sync_queue (operation, payload, created_at)
            VALUES (?, ?, ?)
        """, (
            "UPDATE_STATUS",
            json.dumps({
                "book_id": book_id,
                "status": "Available",
                "rack": new_rack,
                "column_num": new_col,
                "position": new_pos,
                "location_english": new_loc_eng,
                "refunded_amount": final_refund
            }),
            now_iso
        ))

        cursor.execute("SELECT * FROM books WHERE book_id = ?", (book_id,))
        updated_book = dict(cursor.fetchone())

        conn.commit()
        conn.close()

        sync_csv_update_status(book_id, "")
        if mode_clean == "new":
            sync_csv_update_location(book_id, str(new_rack or ""), str(new_col or ""), str(new_pos or ""))
        notify_inventory_changed()

        return {
            "success": True,
            "book": updated_book,
            "book_id": book_id,
            "status": "Available",
            "refunded_amount": final_refund,
            "position_mode": mode_clean,
            "location_english": new_loc_eng,
            "message": f"Successfully cancelled sale for {updated_book['title']} ({book_id}) and returned to shelf ({new_loc_eng or 'Unassigned'}). Repaid ₹{final_refund:g}."
        }

def update_sale_payment(
    book_id: str,
    selling_price: Any,
    notes: str = "",
    user: str = "Staff"
) -> Dict[str, Any]:
    """Updates the recorded sale payment for a sold book, synchronizing transactions, audit logs, and revenue."""
    with db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        now_iso = datetime.now().isoformat()

        cursor.execute("SELECT * FROM books WHERE book_id = ?", (book_id,))
        book = cursor.fetchone()
        if not book:
            conn.close()
            return {"error": f"Book with ID {book_id} not found."}

        cursor.execute("SELECT * FROM sales_transactions WHERE book_id = ? ORDER BY id DESC LIMIT 1", (book_id,))
        tx = cursor.fetchone()

        old_price = (tx["selling_price"] if tx and tx["selling_price"] is not None else book["selling_price"]) or 0.0

        try:
            new_price = round(float(selling_price), 2)
            if new_price < 0:
                conn.close()
                return {"error": "Payment amount cannot be negative."}
        except (ValueError, TypeError):
            conn.close()
            return {"error": "Invalid payment amount."}

        diff = new_price - old_price

        cursor.execute("""
            UPDATE books
            SET selling_price = ?, updated_at = ?
            WHERE book_id = ?
        """, (new_price, now_iso, book_id))

        if tx:
            cursor.execute("""
                UPDATE sales_transactions
                SET selling_price = ?
                WHERE book_id = ?
            """, (new_price, book_id))
        else:
            today_code = datetime.now().strftime("%Y%m%d")
            tx_ref = generate_unique_transaction_ref(cursor, today_code)
            cursor.execute("""
                INSERT INTO sales_transactions (
                    transaction_ref, order_id, book_id, title, author,
                    selling_price, sold_at, sold_by, notes, status, synced_to_sheets
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', 0)
            """, (
                tx_ref, tx_ref, book_id, book["title"], book["author"],
                new_price, now_iso, user, notes or "Payment updated"
            ))

        cursor.execute("""
            INSERT INTO audit_log (action, book_id, before_data, after_data, timestamp, user, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            "UPDATE_SALE_PAYMENT", book_id,
            json.dumps({"status": book["status"], "selling_price": old_price}),
            json.dumps({"status": book["status"], "selling_price": new_price, "adjustment": diff}),
            now_iso, user, f"Sale payment adjusted from ₹{old_price:g} to ₹{new_price:g} ({'+' if diff >= 0 else ''}₹{diff:g}). {notes}".strip()
        ))

        cursor.execute("""
            INSERT INTO sync_queue (operation, payload, created_at)
            VALUES (?, ?, ?)
        """, (
            "UPDATE_STATUS",
            json.dumps({
                "book_id": book_id,
                "status": book["status"],
                "selling_price": new_price,
                "previous_price": old_price
            }),
            now_iso
        ))

        cursor.execute("SELECT * FROM books WHERE book_id = ?", (book_id,))
        updated_book = dict(cursor.fetchone())

        conn.commit()
        conn.close()
        notify_inventory_changed()

        return {
            "success": True,
            "book": updated_book,
            "book_id": book_id,
            "old_price": old_price,
            "new_price": new_price,
            "adjustment": diff,
            "message": f"Successfully updated sale payment from ₹{old_price:g} to ₹{new_price:g} ({'+' if diff >= 0 else ''}₹{diff:g})."
        }

def update_book_metadata(
    book_id: str,
    title: Optional[str] = None,
    author: Optional[str] = None,
    genre: Optional[str] = None,
    language: Optional[str] = None,
    rack: Any = None,
    column_num: Any = None,
    position: Any = None,
    notes: Optional[str] = None,
    status: Optional[str] = None,
    selling_price: Any = None,
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
        new_lang = language.strip() if language is not None else (existing["language"] or "English")
        new_notes = notes.strip() if notes is not None else (existing["notes"] or "")
        new_status = status.strip() if status is not None else existing["status"]
        new_simple_genre = genre_classifier.classify_common_genre(new_genre, new_title)

        if selling_price is not None and selling_price != "":
            try:
                new_selling_price = round(float(selling_price), 2)
            except (ValueError, TypeError):
                new_selling_price = existing["selling_price"]
        elif selling_price == "":
            new_selling_price = None
        else:
            new_selling_price = existing["selling_price"]

        # Location parsing & formatting if any location attribute is supplied
        if rack is not None or column_num is not None or position is not None:
            r_val = rack if rack is not None else existing["rack"]
            c_val = column_num if column_num is not None else existing["column_num"]
            p_val = position if position is not None else existing["position"]
            new_r_int = parse_rack_value(r_val)
            new_c_int = parse_column_value(c_val)
            new_p_int = parse_position_value(p_val)
            new_loc_eng = format_location_english(new_r_int, new_c_int, new_p_int, new_notes)
            is_unassigned = new_r_int is None or new_c_int is None or new_p_int is None
            new_unassigned_since = now_iso if is_unassigned and not existing["unassigned_since"] else (None if not is_unassigned else existing["unassigned_since"])
        else:
            new_r_int = existing["rack"]
            new_c_int = existing["column_num"]
            new_p_int = existing["position"]
            new_loc_eng = existing["location_english"]
            new_unassigned_since = existing["unassigned_since"]

        cursor.execute("""
            UPDATE books SET
                title = ?,
                author = ?,
                genre = ?,
                simple_genre = ?,
                language = ?,
                rack = ?,
                column_num = ?,
                position = ?,
                location_english = ?,
                notes = ?,
                status = ?,
                selling_price = ?,
                updated_at = ?,
                unassigned_since = ?
            WHERE book_id = ?
        """, (
            new_title, new_author, new_genre, new_simple_genre, new_lang,
            new_r_int, new_c_int, new_p_int, new_loc_eng, new_notes, new_status,
            new_selling_price, now_iso, new_unassigned_since, book_id
        ))

        # Keep sales_transactions selling_price in sync if sale exists
        if new_selling_price != existing["selling_price"]:
            cursor.execute("""
                UPDATE sales_transactions
                SET selling_price = ?
                WHERE book_id = ?
            """, (new_selling_price, book_id))

        cursor.execute("""
            INSERT INTO audit_log (action, book_id, before_data, after_data, timestamp, user, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            "EDIT_METADATA", book_id,
            json.dumps(dict(existing)),
            json.dumps({
                "title": new_title, "author": new_author, "genre": new_genre,
                "language": new_lang, "rack": new_r_int, "column": new_c_int,
                "position": new_p_int, "location_english": new_loc_eng,
                "status": new_status, "selling_price": new_selling_price
            }),
            now_iso, user, "Metadata and location/payment updated"
        ))

        cursor.execute("""
            INSERT INTO sync_queue (operation, payload, created_at)
            VALUES (?, ?, ?)
        """, (
            "UPDATE_METADATA",
            json.dumps({
                "book_id": book_id, "title": new_title, "author": new_author,
                "genre": new_genre, "language": new_lang, "rack": new_r_int,
                "column": new_c_int, "position": new_p_int, "location_english": new_loc_eng,
                "notes": new_notes, "status": new_status, "selling_price": new_selling_price
            }),
            now_iso
        ))

        conn.commit()
        cursor.execute("SELECT * FROM books WHERE book_id = ?", (book_id,))
        res = dict(cursor.fetchone())
        conn.close()
        sync_csv_update_location(book_id, str(new_r_int if new_r_int is not None else ""), str(new_c_int if new_c_int is not None else ""), str(new_p_int if new_p_int is not None else ""))
        notify_inventory_changed()
        return res

def get_unassigned_books(query: str = "", limit: int = 200, offset: int = 0) -> Dict[str, Any]:
    """Retrieves books that do not have an assigned location, with duration analysis and multi-token search."""
    conn = get_db_connection()
    cursor = conn.cursor()

    base_sql = """
        SELECT * FROM books 
        WHERE (rack IS NULL OR column_num IS NULL OR position IS NULL 
               OR rack = '' OR column_num = '' OR position = '' OR lower(rack) = 'unassigned')
    """
    params = []

    if query and query.strip():
        tokens = [t.strip() for t in query.strip().split() if t.strip()]
        for token in tokens:
            base_sql += """ AND (
                LOWER(title) LIKE LOWER(?) OR 
                LOWER(author) LIKE LOWER(?) OR 
                LOWER(genre) LIKE LOWER(?) OR 
                LOWER(simple_genre) LIKE LOWER(?) OR 
                LOWER(book_id) LIKE LOWER(?)
            )"""
            pat = f"%{token}%"
            params.extend([pat, pat, pat, pat, pat])

    # Count total unassigned
    cursor.execute(f"SELECT COUNT(*) FROM ({base_sql})", list(params))
    total = cursor.fetchone()[0]

    # Order by unassigned_since ascending (oldest unassigned first)
    query_sql = base_sql + " ORDER BY unassigned_since ASC, id DESC LIMIT ? OFFSET ?"
    query_params = list(params) + [limit, offset]

    cursor.execute(query_sql, query_params)
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

def get_transactions(limit: int = 100) -> List[Dict[str, Any]]:
    """
    Fetches sales transactions grouped into discrete order transactions.
    Supports single-book and multi-book sales with member books and locations.
    """
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT st.id, st.transaction_ref, COALESCE(NULLIF(st.order_id, ''), st.transaction_ref) AS order_id,
               st.book_id, st.title, st.author, st.selling_price, st.sold_at, st.sold_by, st.notes,
               COALESCE(st.status, 'COMPLETED') AS status,
               b.status AS current_book_status, b.location_english, b.rack, b.column_num, b.position
        FROM sales_transactions st
        LEFT JOIN books b ON st.book_id = b.book_id
        ORDER BY st.id DESC
        LIMIT ?
    """, (limit * 20,))
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()

    orders_map = {}
    ordered_ids = []

    for r in rows:
        oid = r["order_id"]
        if oid not in orders_map:
            ordered_ids.append(oid)
            orders_map[oid] = {
                "order_id": oid,
                "sold_at": r["sold_at"],
                "sold_by": r["sold_by"] or "Staff",
                "notes": r["notes"] or "",
                "status": r["status"] or "COMPLETED",
                "total_amount": 0.0,
                "books": []
            }

        if r["status"] == "COMPLETED":
            orders_map[oid]["status"] = "COMPLETED"

        price = r["selling_price"]
        if price is not None:
            orders_map[oid]["total_amount"] += float(price)

        loc = r["location_english"]
        if not loc and (r["rack"] or r["column_num"]):
            loc = format_location_english(r["rack"], r["column_num"], r["position"])

        orders_map[oid]["books"].append({
            "book_id": r["book_id"],
            "title": r["title"],
            "author": r["author"],
            "selling_price": price,
            "status": r["status"],
            "current_book_status": r["current_book_status"] or ("SOLD OUT" if r["status"] == "COMPLETED" else "Available"),
            "location_english": loc or "Location Unassigned"
        })

    result = []
    for oid in ordered_ids[:limit]:
        order = orders_map[oid]
        order["total_amount"] = round(order["total_amount"], 2)
        order["count"] = len(order["books"])
        result.append(order)

    return result

def revert_transaction(order_id: str, user: str = "Staff", notes: str = "") -> Dict[str, Any]:
    """
    Reverts an entire transaction / purchase order.
    Returns all member books back to their previous shelf positions as 'Available',
    marks the transaction status as 'REVERTED', and syncs changes.
    """
    if not order_id:
        return {"error": "Order ID is required."}

    with db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        now_iso = datetime.now().isoformat()

        cursor.execute("""
            SELECT * FROM sales_transactions
            WHERE order_id = ? OR transaction_ref = ?
        """, (order_id, order_id))
        st_rows = [dict(r) for r in cursor.fetchall()]

        if not st_rows:
            conn.close()
            return {"error": f"Transaction '{order_id}' not found."}

        reverted_books = []
        for row in st_rows:
            bid = row["book_id"]
            cursor.execute("SELECT * FROM books WHERE book_id = ?", (bid,))
            b = cursor.fetchone()
            if not b:
                continue

            r_val = b["rack"]
            c_val = b["column_num"]
            p_val = b["position"]
            loc_eng = b["location_english"]
            if r_val is not None and not loc_eng:
                loc_eng = format_location_english(r_val, c_val, p_val)

            cursor.execute("""
                UPDATE books SET
                    status = 'Available',
                    selling_price = NULL,
                    updated_at = ?
                WHERE book_id = ?
            """, (now_iso, bid))

            sync_csv_update_status(bid, "")

            cursor.execute("""
                INSERT INTO audit_log (action, book_id, before_data, after_data, timestamp, user, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                "REVERT_TRANSACTION", bid,
                json.dumps({"status": b["status"], "selling_price": b["selling_price"]}),
                json.dumps({"status": "Available", "selling_price": None, "order_id": order_id}),
                now_iso, user, f"Reverted transaction {order_id} & restored to shelf ({loc_eng or 'Unassigned'}). {notes}".strip()
            ))

            reverted_books.append({
                "book_id": bid,
                "title": b["title"],
                "author": b["author"],
                "location_english": loc_eng
            })

        cursor.execute("""
            UPDATE sales_transactions
            SET status = 'REVERTED'
            WHERE order_id = ? OR transaction_ref = ?
        """, (order_id, order_id))

        conn.commit()
        conn.close()
        notify_inventory_changed()

        return {
            "success": True,
            "order_id": order_id,
            "status": "REVERTED",
            "count": len(reverted_books),
            "books": reverted_books,
            "message": f"Successfully reverted transaction {order_id} and restored {len(reverted_books)} books to their shelf locations."
        }

def redo_transaction(order_id: str, user: str = "Staff", notes: str = "") -> Dict[str, Any]:
    """
    Redoes / re-applies a previously reverted transaction.
    Marks all member books as 'SOLD OUT', restores their selling prices,
    and updates transaction status back to 'COMPLETED'.
    """
    if not order_id:
        return {"error": "Order ID is required."}

    with db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        now_iso = datetime.now().isoformat()

        cursor.execute("""
            SELECT * FROM sales_transactions
            WHERE order_id = ? OR transaction_ref = ?
        """, (order_id, order_id))
        st_rows = [dict(r) for r in cursor.fetchall()]

        if not st_rows:
            conn.close()
            return {"error": f"Transaction '{order_id}' not found."}

        sold_books = []
        for row in st_rows:
            bid = row["book_id"]
            price_val = row["selling_price"]
            cursor.execute("SELECT * FROM books WHERE book_id = ?", (bid,))
            b = cursor.fetchone()
            if not b:
                continue

            cursor.execute("""
                UPDATE books SET
                    status = 'SOLD OUT',
                    selling_price = ?,
                    updated_at = ?
                WHERE book_id = ?
            """, (price_val, now_iso, bid))

            sync_csv_update_status(bid, "SOLD OUT")

            cursor.execute("""
                INSERT INTO audit_log (action, book_id, before_data, after_data, timestamp, user, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                "REDO_TRANSACTION", bid,
                json.dumps({"status": b["status"], "selling_price": b["selling_price"]}),
                json.dumps({"status": "SOLD OUT", "selling_price": price_val, "order_id": order_id}),
                now_iso, user, f"Redid transaction {order_id} & marked SOLD OUT. {notes}".strip()
            ))

            sold_books.append({
                "book_id": bid,
                "title": b["title"],
                "author": b["author"],
                "location_english": b["location_english"]
            })

        cursor.execute("""
            UPDATE sales_transactions
            SET status = 'COMPLETED'
            WHERE order_id = ? OR transaction_ref = ?
        """, (order_id, order_id))

        conn.commit()
        conn.close()
        notify_inventory_changed()

        return {
            "success": True,
            "order_id": order_id,
            "status": "COMPLETED",
            "count": len(sold_books),
            "books": sold_books,
            "message": f"Successfully redid transaction {order_id} and marked {len(sold_books)} books as SOLD OUT."
        }

def delete_transaction(order_id: str, user: str = "Staff") -> Dict[str, Any]:
    """
    Totally cancels/removes a purchase transaction from the records.
    If books are currently marked 'SOLD OUT', restores them to 'Available'.
    Permanently deletes records from sales_transactions.
    """
    if not order_id:
        return {"error": "Order ID is required."}

    with db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        now_iso = datetime.now().isoformat()

        cursor.execute("""
            SELECT * FROM sales_transactions
            WHERE order_id = ? OR transaction_ref = ?
        """, (order_id, order_id))
        st_rows = [dict(r) for r in cursor.fetchall()]

        if not st_rows:
            conn.close()
            return {"error": f"Transaction '{order_id}' not found."}

        for row in st_rows:
            bid = row["book_id"]
            cursor.execute("SELECT * FROM books WHERE book_id = ?", (bid,))
            b = cursor.fetchone()
            if b and b["status"] == "SOLD OUT":
                cursor.execute("""
                    UPDATE books SET
                        status = 'Available',
                        selling_price = NULL,
                        updated_at = ?
                    WHERE book_id = ?
                """, (now_iso, bid))
                sync_csv_update_status(bid, "")

        cursor.execute("""
            DELETE FROM sales_transactions
            WHERE order_id = ? OR transaction_ref = ?
        """, (order_id, order_id))

        conn.commit()
        conn.close()
        notify_inventory_changed()

        return {
            "success": True,
            "order_id": order_id,
            "message": f"Transaction {order_id} totally removed and cancelled."
        }

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
        WHERE (rack IS NULL OR column_num IS NULL OR position IS NULL 
               OR rack = '' OR column_num = '' OR position = '' OR lower(rack) = 'unassigned')
    """)
    unassigned_count = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(DISTINCT rack) FROM books WHERE rack IS NOT NULL AND rack != '' AND lower(rack) != 'unassigned'")
    rack_count = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM sales_transactions")
    total_sales_count = cursor.fetchone()[0]

    try:
        cursor.execute("SELECT COUNT(DISTINCT COALESCE(NULLIF(order_id, ''), transaction_ref)) FROM sales_transactions")
        total_transactions_count = cursor.fetchone()[0]
    except Exception:
        total_transactions_count = total_sales_count

    try:
        cursor.execute("SELECT SUM(selling_price) FROM sales_transactions WHERE selling_price IS NOT NULL AND (status IS NULL OR status != 'REVERTED')")
        total_revenue = cursor.fetchone()[0] or 0.0
    except Exception:
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
        "total_transactions_count": total_transactions_count,
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

def get_or_fetch_book_cover(title: str, author: str = "") -> Optional[str]:
    """
    Returns the cached cover URL from SQLite if available.
    Otherwise queries Open Library / Google Books, caches in SQLite, and returns the URL.
    """
    clean_title = (title or "").strip()
    if not clean_title:
        return None

    # Check local SQLite cache first
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT image_url FROM books WHERE lower(title) = ? AND image_url != '' AND image_url IS NOT NULL LIMIT 1",
            (clean_title.lower(),)
        )
        row = cursor.fetchone()
        if row and row["image_url"]:
            cached = row["image_url"]
            conn.close()
            return cached
        conn.close()
    except Exception as e:
        print(f"Notice reading cached cover: {e}")

    # Query Open Library Search API
    cover_url = None
    try:
        import urllib.request, urllib.parse
        q_params = f"title={urllib.parse.quote(clean_title)}"
        if author and author.strip():
            q_params += f"&author={urllib.parse.quote(author.strip())}"
        q_url = f"https://openlibrary.org/search.json?{q_params}&limit=1"
        req = urllib.request.Request(q_url, headers={"User-Agent": "BookstoreApp/2.0 (books@internal)"})
        with urllib.request.urlopen(req, timeout=4) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="ignore"))
            docs = data.get("docs", [])
            if docs and docs[0].get("cover_i"):
                cover_id = docs[0]["cover_i"]
                cover_url = f"https://covers.openlibrary.org/b/id/{cover_id}-M.jpg"
    except Exception as e:
        pass

    # Fallback to Bing / Web Image Search
    if not cover_url:
        try:
            import urllib.request, urllib.parse, re
            query_str = f"{clean_title} {author}".strip()
            url = f"https://www.bing.com/images/search?q={urllib.parse.quote(query_str + ' book cover')}"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
            with urllib.request.urlopen(req, timeout=3) as resp:
                html = resp.read().decode("utf-8", errors="ignore")
                m = re.findall(r'(https://tse\d\.mm\.bing\.net/th/id/[^\"]+)', html)
                if m:
                    cover_url = m[0].replace("&amp;", "&")
        except Exception:
            pass

    # Fallback to Google Books API
    if not cover_url:
        try:
            import urllib.request, urllib.parse
            gb_query = f"intitle:{urllib.parse.quote(clean_title)}"
            if author and author.strip():
                gb_query += f"+inauthor:{urllib.parse.quote(author.strip())}"
            gb_url = f"https://www.googleapis.com/books/v1/volumes?q={gb_query}&maxResults=1"
            req = urllib.request.Request(gb_url, headers={"User-Agent": "BookstoreApp/2.0 (books@internal)"})
            with urllib.request.urlopen(req, timeout=4) as resp:
                gb_data = json.loads(resp.read().decode("utf-8", errors="ignore"))
                items = gb_data.get("items", [])
                if items:
                    images = items[0].get("volumeInfo", {}).get("imageLinks", {})
                    thumb = images.get("thumbnail") or images.get("smallThumbnail")
                    if thumb:
                        cover_url = thumb.replace("http://", "https://")
        except Exception as e:
            pass

    if cover_url:
        try:
            with db_lock:
                conn = get_db_connection()
                cursor = conn.cursor()
                cursor.execute(
                    "UPDATE books SET image_url = ? WHERE lower(title) = ?",
                    (cover_url, clean_title.lower())
                )
                conn.commit()
                conn.close()
        except Exception as e:
            print(f"Notice saving book cover to DB: {e}")

    return cover_url

