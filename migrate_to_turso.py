#!/usr/bin/env python3
"""
migrate_to_turso.py
===================
One-click data migration utility to push all inventory, sales transactions,
and audit history from your local SQLite bookstore.db to Turso Cloud (libSQL).

Usage:
  python3 migrate_to_turso.py

Or with environment variables:
  TURSO_DATABASE_URL="libsql://..." TURSO_AUTH_TOKEN="..." python3 migrate_to_turso.py
"""

import os
import sys
import sqlite3
import time
from typing import List, Dict, Any

try:
    import turso_client
except ImportError:
    sys.path.append(os.path.dirname(os.path.abspath(__file__)))
    import turso_client


LOCAL_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bookstore.db")


def main():
    print("=" * 70)
    print("  🚀 BOOKSTORE ADVANCED → TURSO CLOUD MIGRATION UTILITY")
    print("=" * 70)

    url = os.environ.get("TURSO_DATABASE_URL", "").strip()
    token = os.environ.get("TURSO_AUTH_TOKEN", "").strip()

    if not url:
        print("\nEnter your Turso Database URL:")
        print("  (e.g., libsql://bookstore-username.turso.io or https://...)")
        url = input("  URL: ").strip()

    if not token:
        print("\nEnter your Turso Auth Token:")
        print("  (generated via `turso db tokens create <db-name>`)")
        token = input("  Token: ").strip()

    if not url or not token:
        print("\n❌ Error: Both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required.")
        sys.exit(1)

    if not os.path.exists(LOCAL_DB_PATH):
        print(f"\n❌ Error: Local database file not found at {LOCAL_DB_PATH}")
        sys.exit(1)

    print(f"\n1. Connecting to local SQLite: {LOCAL_DB_PATH}...")
    local_conn = sqlite3.connect(LOCAL_DB_PATH)
    local_conn.row_factory = sqlite3.Row
    local_cursor = local_conn.cursor()

    print(f"2. Connecting to remote Turso database at {url}...")
    try:
        remote_conn = turso_client.connect(url, token)
        remote_cursor = remote_conn.cursor()
        # Verify connection
        remote_cursor.execute("SELECT 1 AS test")
        test_row = remote_cursor.fetchone()
        print("   ✅ Connected to Turso Cloud successfully!")
    except Exception as e:
        print(f"   ❌ Failed to connect to Turso: {e}")
        sys.exit(1)

    print("\n3. Creating tables in Turso Cloud...")
    # Books Table
    remote_cursor.execute("""
        CREATE TABLE IF NOT EXISTS books (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            author TEXT NOT NULL,
            genre TEXT DEFAULT '',
            language TEXT DEFAULT 'English',
            rack INTEGER,
            column_num INTEGER,
            position INTEGER,
            location_english TEXT,
            notes TEXT DEFAULT '',
            status TEXT DEFAULT 'Available',
            selling_price REAL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            unassigned_since TEXT,
            image_url TEXT,
            simple_genre TEXT DEFAULT 'Fiction'
        )
    """)

    # Indexes
    remote_cursor.execute("CREATE INDEX IF NOT EXISTS idx_books_status ON books(status)")
    remote_cursor.execute("CREATE INDEX IF NOT EXISTS idx_books_rack ON books(rack)")
    remote_cursor.execute("CREATE INDEX IF NOT EXISTS idx_books_title ON books(title)")
    remote_cursor.execute("CREATE INDEX IF NOT EXISTS idx_books_author ON books(author)")

    # Sales Transactions Table
    remote_cursor.execute("""
        CREATE TABLE IF NOT EXISTS sales_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transaction_ref TEXT UNIQUE NOT NULL,
            book_id TEXT NOT NULL,
            title TEXT NOT NULL,
            author TEXT NOT NULL,
            selling_price REAL,
            sold_at TEXT NOT NULL,
            sold_by TEXT NOT NULL,
            notes TEXT,
            synced_to_sheets INTEGER DEFAULT 0
        )
    """)

    # Audit Log Table
    remote_cursor.execute("""
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            book_id TEXT NOT NULL,
            before_data TEXT,
            after_data TEXT,
            timestamp TEXT NOT NULL,
            user TEXT NOT NULL,
            notes TEXT
        )
    """)

    # Sync Queue Table
    remote_cursor.execute("""
        CREATE TABLE IF NOT EXISTS sync_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at TEXT NOT NULL,
            status TEXT DEFAULT 'PENDING',
            retry_count INTEGER DEFAULT 0
        )
    """)
    print("   ✅ Tables and indexes ready on Turso.")

    # 4. Migrate Books
    print("\n4. Migrating books inventory...")
    local_cursor.execute("SELECT * FROM books ORDER BY id ASC")
    local_books = local_cursor.fetchall()
    total_books = len(local_books)
    print(f"   Found {total_books} books in local database.")

    insert_sql = """
        INSERT OR REPLACE INTO books (
            id, book_id, title, author, genre, language,
            rack, column_num, position, location_english, notes,
            status, selling_price, created_at, updated_at,
            unassigned_since, image_url, simple_genre
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """

    book_rows = []
    for b in local_books:
        book_rows.append((
            b["id"], b["book_id"], b["title"], b["author"], b["genre"], b["language"],
            b["rack"], b["column_num"], b["position"], b["location_english"], b["notes"],
            b["status"], b["selling_price"], b["created_at"], b["updated_at"],
            b["unassigned_since"], b["image_url"], b["simple_genre"]
        ))

    # Chunk in batches of 50 for smooth pipeline execution
    chunk_size = 50
    migrated_count = 0
    t0 = time.time()
    for i in range(0, len(book_rows), chunk_size):
        chunk = book_rows[i:i + chunk_size]
        remote_cursor.executemany(insert_sql, chunk)
        migrated_count += len(chunk)
        pct = (migrated_count / total_books) * 100
        print(f"\r   Progress: {migrated_count}/{total_books} books ({pct:.1f}%)...", end="", flush=True)

    elapsed = time.time() - t0
    print(f"\n   ✅ Successfully migrated {migrated_count} books in {elapsed:.2f} seconds!")

    # 5. Migrate Sales Transactions
    print("\n5. Migrating sales transactions...")
    local_cursor.execute("SELECT * FROM sales_transactions ORDER BY id ASC")
    local_sales = local_cursor.fetchall()
    if local_sales:
        sales_sql = """
            INSERT OR REPLACE INTO sales_transactions (
                id, transaction_ref, book_id, title, author,
                selling_price, sold_at, sold_by, notes, synced_to_sheets
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """
        sales_rows = [
            (
                s["id"], s["transaction_ref"], s["book_id"], s["title"], s["author"],
                s["selling_price"], s["sold_at"], s["sold_by"], s["notes"], s["synced_to_sheets"]
            )
            for s in local_sales
        ]
        remote_cursor.executemany(sales_sql, sales_rows)
        print(f"   ✅ Migrated {len(sales_rows)} sales transactions.")
    else:
        print("   (No sales transactions to migrate).")

    # 6. Migrate Audit Log
    print("\n6. Migrating audit history...")
    local_cursor.execute("SELECT * FROM audit_log ORDER BY id ASC")
    local_audit = local_cursor.fetchall()
    if local_audit:
        audit_sql = """
            INSERT OR REPLACE INTO audit_log (
                id, action, book_id, before_data, after_data, timestamp, user, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """
        audit_rows = [
            (
                a["id"], a["action"], a["book_id"], a["before_data"], a["after_data"],
                a["timestamp"], a["user"], a["notes"]
            )
            for a in local_audit
        ]
        # Chunk audit logs
        for i in range(0, len(audit_rows), 50):
            remote_cursor.executemany(audit_sql, audit_rows[i:i + 50])
        print(f"   ✅ Migrated {len(audit_rows)} audit log records.")
    else:
        print("   (No audit logs to migrate).")

    # 7. Verification
    print("\n7. Verifying Turso Cloud Database...")
    remote_cursor.execute("SELECT COUNT(*) FROM books")
    turso_book_count = remote_cursor.fetchone()[0]
    print(f"   Local book count: {total_books}")
    print(f"   Turso book count: {turso_book_count}")

    if turso_book_count >= total_books:
        print("\n" + "=" * 70)
        print("  🎉 MIGRATION COMPLETED SUCCESSFULLY!")
        print("=" * 70)
        print("\nNext step: Add these environment variables to Vercel:")
        print("1. Go to https://vercel.com/dashboard → Your Project → Settings → Environment Variables")
        print("2. Add:")
        print(f"   TURSO_DATABASE_URL = {url}")
        print(f"   TURSO_AUTH_TOKEN    = (your token)")
        print("\nOnce set, Vercel will persistently read & write directly to Turso Cloud!")
        print("No new sales, payment edits, or inventory changes will ever be lost again.")
    else:
        print("\n⚠️ Warning: Counts did not match exactly. Please check the logs.")

    local_conn.close()


if __name__ == "__main__":
    main()
