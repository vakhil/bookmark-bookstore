"""
Batch Book Cover Scraper.
Scrapes book cover thumbnail URLs and populates `books.image_url` in SQLite.
"""

import time
import urllib.request
import urllib.parse
import re
import json
import sqlite3
import os
import sys

# Ensure root directory is in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import database

def scrape_single_cover(title: str, author: str = "") -> str:
    clean_title = (title or "").strip()
    if not clean_title:
        return ""

    query_str = f"{clean_title} {author}".strip()
    try:
        url = f"https://www.bing.com/images/search?q={urllib.parse.quote(query_str + ' book cover')}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
        with urllib.request.urlopen(req, timeout=3.5) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
            m = re.findall(r'(https://tse\d\.mm\.bing\.net/th/id/[^\"]+)', html)
            if m:
                return m[0].replace("&amp;", "&")
    except Exception:
        pass

    # Open Library fallback
    try:
        url = f"https://openlibrary.org/search.json?q={urllib.parse.quote(clean_title)}&limit=1"
        req = urllib.request.Request(url, headers={"User-Agent": "BookstoreManager/2.0"})
        with urllib.request.urlopen(req, timeout=3.5) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="ignore"))
            docs = data.get("docs", [])
            if docs and docs[0].get("cover_i"):
                return f"https://covers.openlibrary.org/b/id/{docs[0]['cover_i']}-M.jpg"
            if docs and docs[0].get("cover_edition_key"):
                return f"https://covers.openlibrary.org/b/olid/{docs[0]['cover_edition_key']}-M.jpg"
    except Exception:
        pass

    return ""

def populate_covers_batch(limit: int = 150):
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT DISTINCT title, author FROM books
        WHERE (image_url IS NULL OR image_url = '') AND title != ''
        LIMIT ?
    """, (limit,))
    rows = cursor.fetchall()
    print(f"Starting batch scrape for {len(rows)} book titles...")

    success = 0
    for idx, r in enumerate(rows, 1):
        t = r["title"]
        a = r["author"]
        cov = scrape_single_cover(t, a)
        if cov:
            cursor.execute("UPDATE books SET image_url = ? WHERE lower(title) = ?", (cov, t.lower()))
            conn.commit()
            success += 1
            print(f"[{idx}/{len(rows)}] ✓ {t[:35]} -> {cov[:50]}")
        else:
            print(f"[{idx}/{len(rows)}] ✗ {t[:35]}")
        time.sleep(0.2)

    conn.close()
    print(f"Batch completed! Successfully assigned covers to {success} titles.")

if __name__ == "__main__":
    import sys
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    populate_covers_batch(count)
