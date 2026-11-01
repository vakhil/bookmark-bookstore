#!/usr/bin/env python3
"""
restore_and_sync_covers.py
==========================
Restores pre-scraped book cover image URLs from backup database into:
1. Local bookstore.db
2. Turso Cloud database
"""

import os
import sqlite3
import turso_client

BACKUP_DB = os.path.join(os.path.dirname(__file__), "backups", "bookstore_before_important_import_20261031_053929.db")
LOCAL_DB = os.path.join(os.path.dirname(__file__), "bookstore.db")

TURSO_URL = os.environ.get("TURSO_DATABASE_URL", "libsql://bookstore-akhilvemula96.aws-ap-northeast-1.turso.io").strip()
TURSO_TOKEN = os.environ.get("TURSO_AUTH_TOKEN", "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTMyMjYwMzQsImlkIjoiMDFhMTg0OTUtN2QwMS03NzcxLThiMzMtMmJhMGQ2ZjY2MDU1Iiwia2lkIjoiczBtU1ZjVU9uV25FRDJaVjMtQVRlOGtMZnhlLUp0clRQeTlKVm5sNGtGayIsInJpZCI6ImRkNDMxYTc2LWM2ZjgtNDViOC1hODQ4LWI5ZTEyNjZkZTAyNiJ9.YLdnymMUWT78qF9-GZtEdQmqBHjKnQGA2EWO9phNuKPPnclCh2QacjB4x5GR2EG3lr6WVYbzWg6dqkVLyaYDAQ").strip()

def main():
    print("1. Loading cached images from backup DB...")
    b_conn = sqlite3.connect(BACKUP_DB)
    bc = b_conn.cursor()
    bc.execute("SELECT lower(trim(title)), image_url FROM books WHERE image_url != '' AND image_url IS NOT NULL")
    img_map = {row[0]: row[1] for row in bc.fetchall()}
    b_conn.close()
    print(f"   Loaded {len(img_map)} image URLs from backup.")

    print("\n2. Updating local bookstore.db...")
    l_conn = sqlite3.connect(LOCAL_DB)
    lc = l_conn.cursor()
    lc.execute("SELECT id, lower(trim(title)) FROM books")
    local_books = lc.fetchall()

    updates = []
    for bid, title in local_books:
        if title in img_map:
            updates.append((img_map[title], bid))

    lc.executemany("UPDATE books SET image_url = ? WHERE id = ?", updates)
    l_conn.commit()

    lc.execute("SELECT COUNT(*) FROM books WHERE image_url != '' AND image_url IS NOT NULL")
    local_cnt = lc.fetchone()[0]
    l_conn.close()
    print(f"   ✅ Local database updated! Books with cover images: {local_cnt} / {len(local_books)}")

    if not TURSO_URL or not TURSO_TOKEN:
        print("\nTurso credentials missing. Skipping Turso Cloud update.")
        return

    print("\n3. Connecting to Turso Cloud...")
    t_conn = turso_client.connect(TURSO_URL, TURSO_TOKEN)
    tc = t_conn.cursor()

    tc.execute("SELECT id, lower(trim(title)) FROM books")
    t_books = tc.fetchall()
    print(f"   Found {len(t_books)} books in Turso Cloud.")

    t_updates = []
    for row in t_books:
        # support row indexing or dict access
        bid = row["id"] if hasattr(row, "__getitem__") and not isinstance(row, tuple) else row[0]
        title = row["lower(trim(title))"] if hasattr(row, "__getitem__") and not isinstance(row, tuple) and "lower(trim(title))" in row else (row[1] if isinstance(row, tuple) else list(row.values())[1])
        if title in img_map:
            t_updates.append((img_map[title], bid))

    print(f"   Found {len(t_updates)} matching images to upload to Turso...")
    batch_size = 150
    total = len(t_updates)
    for i in range(0, total, batch_size):
        batch = t_updates[i:i + batch_size]
        tc.executemany("UPDATE books SET image_url = ? WHERE id = ?", batch)
        pct = min(100, int((i + len(batch)) / total * 100))
        print(f"   [{pct:3d}%] Synced {i + len(batch)} / {total} covers to Turso...", end="\r")

    print(f"\n   ✅ All {total} cover images synced to Turso Cloud!")
    tc.execute("SELECT COUNT(*) as cnt FROM books WHERE image_url != '' AND image_url IS NOT NULL")
    res = tc.fetchone()
    turso_cnt = res["cnt"] if hasattr(res, "__getitem__") else res[0]
    print(f"   📊 Turso Cloud total books with cover images: {turso_cnt}")

if __name__ == "__main__":
    main()
