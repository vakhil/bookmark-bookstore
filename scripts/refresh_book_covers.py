#!/usr/bin/env python3
"""
scripts/refresh_book_covers.py
Bulk multi-source book cover refresher.
Queries Pinterest, Goodreads, Open Library, Google Books, and Web Images
to determine the best high-definition location URL for each book.
Updates both local SQLite and Turso Cloud database.
"""

import os
import sys
import time
import argparse
import sqlite3
import urllib.request
import urllib.parse
import re
import json
import http.cookiejar
from concurrent.futures import ThreadPoolExecutor, as_completed

root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if root_dir not in sys.path:
    sys.path.insert(0, root_dir)

import search_engine

MOBILE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
}
DESKTOP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
}

def resolve_cover_network(title: str, author: str = ""):
    """Queries Pinterest, Goodreads, Open Library, Google Books, and Web Images."""
    clean_title = (title or "").strip()
    clean_author = (author or "").strip()
    if not clean_title:
        return None, "empty"
    query_str = f"{clean_title} {clean_author}".strip()

    # 1. Try Pinterest (Curated aesthetic high-res book covers)
    try:
        url = f"https://www.pinterest.com/search/pins/?q={urllib.parse.quote(query_str + ' book cover')}"
        req = urllib.request.Request(url, headers=MOBILE_HEADERS)
        with urllib.request.urlopen(req, timeout=3.5) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
            pin_matches = re.findall(r"https://i\.pinimg\.com/(?:60x60|236x)/([^\s\"\'<>]+\.(?:jpg|png|webp))", html)
            if pin_matches:
                for img_p in pin_matches:
                    if "d53b014d" not in img_p:  # skip static Pinterest icon
                        return f"https://i.pinimg.com/736x/{img_p}", "Pinterest"
    except Exception:
        pass

    # 2. Try Goodreads Direct Search
    try:
        cookie_jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))
        gr_url = "https://www.goodreads.com/search?q=" + urllib.parse.quote(query_str)
        req = urllib.request.Request(gr_url, headers=DESKTOP_HEADERS)
        with opener.open(req, timeout=3.5) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
            gr_imgs = re.findall(r"(https://m\.media-amazon\.com/images/S/compressed\.photo\.goodreads\.com/books/[^\s\"\'\\\>]+)", html)
            if not gr_imgs:
                gr_imgs = re.findall(r"(https://images-na\.ssl-images-amazon\.com/images/S/compressed\.photo\.goodreads\.com/books/[^\s\"\'\\\>]+)", html)
            if gr_imgs:
                raw_url = gr_imgs[0].split()[0].split("\"")[0]
                return re.sub(r"\._S[XY]\d+_\.", ".", raw_url), "Goodreads"
    except Exception:
        pass

    # 2b. Try Goodreads via Index Search
    try:
        gr_bing_url = f"https://www.bing.com/images/search?q={urllib.parse.quote('site:goodreads.com ' + query_str + ' book cover')}"
        req = urllib.request.Request(gr_bing_url, headers=DESKTOP_HEADERS)
        with urllib.request.urlopen(req, timeout=3.5) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
            tse = re.findall(r'(https://tse\d\.mm\.bing\.net/th/id/[^\"]+)', html)
            if tse:
                clean = re.sub(r'w=\d+&h=\d+&c=\d+&r=\d+&o=\d+&', '', tse[0].replace('&amp;', '&'))
                return clean, "Goodreads/Index"
    except Exception:
        pass

    # 3. Try Open Library Covers API
    try:
        ol_params = f"title={urllib.parse.quote(clean_title)}"
        if clean_author:
            ol_params += f"&author={urllib.parse.quote(clean_author)}"
        ol_url = f"https://openlibrary.org/search.json?{ol_params}&limit=1"
        req = urllib.request.Request(ol_url, headers=DESKTOP_HEADERS)
        with urllib.request.urlopen(req, timeout=3.5) as resp:
            d = json.loads(resp.read().decode("utf-8", errors="ignore"))
            docs = d.get("docs", [])
            if docs and docs[0].get("cover_i"):
                cid = docs[0]["cover_i"]
                return f"https://covers.openlibrary.org/b/id/{cid}-L.jpg", "OpenLibrary"
    except Exception:
        pass

    # 4. Try Google Books API
    try:
        gb_query = f"intitle:{urllib.parse.quote(clean_title)}"
        if clean_author:
            gb_query += f"+inauthor:{urllib.parse.quote(clean_author)}"
        gb_url = f"https://www.googleapis.com/books/v1/volumes?q={gb_query}&maxResults=1"
        req = urllib.request.Request(gb_url, headers=DESKTOP_HEADERS)
        with urllib.request.urlopen(req, timeout=3.5) as resp:
            gb_data = json.loads(resp.read().decode("utf-8", errors="ignore"))
            items = gb_data.get("items", [])
            if items:
                images = items[0].get("volumeInfo", {}).get("imageLinks", {})
                thumb = images.get("thumbnail") or images.get("smallThumbnail")
                if thumb:
                    return thumb.replace("http://", "https://").replace("&edge=curl", ""), "GoogleBooks"
    except Exception:
        pass

    # 5. Try Web Images Search (Bing CDN)
    try:
        web_url = f"https://www.bing.com/images/search?q={urllib.parse.quote(query_str + ' book cover')}"
        req = urllib.request.Request(web_url, headers=DESKTOP_HEADERS)
        with urllib.request.urlopen(req, timeout=3.5) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
            tse = re.findall(r'(https://tse\d\.mm\.bing\.net/th/id/[^\"]+)', html)
            if tse:
                clean = re.sub(r'w=\d+&h=\d+&c=\d+&r=\d+&o=\d+&', '', tse[0].replace('&amp;', '&'))
                return clean, "WebImages"
    except Exception:
        pass

    return None, "Not found"

def load_turso_credentials():
    url = os.environ.get("TURSO_DATABASE_URL", "").strip()
    token = os.environ.get("TURSO_AUTH_TOKEN", "").strip()
    if url and token:
        return url, token

    env_path = os.path.join(root_dir, ".env.local")
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip().strip("\"'")
                    if k == "TURSO_DATABASE_URL":
                        url = v
                    elif k == "TURSO_AUTH_TOKEN":
                        token = v
    return url, token

def main():
    parser = argparse.ArgumentParser(description="Refresh book covers across inventory")
    parser.add_argument("--limit", type=int, default=0, help="Max unique titles to refresh (0 = all)")
    parser.add_argument("--workers", type=int, default=8, help="Number of concurrent worker threads")
    parser.add_argument("--target", choices=["local", "turso", "both"], default="both", help="Target database")
    args = parser.parse_args()

    turso_url, turso_token = load_turso_credentials()
    has_turso = bool(turso_url and turso_token)

    print("=" * 70)
    print(" 📚 BOOK COVER MULTI-SOURCE REFRESHER")
    print(" Sources: Pinterest, Goodreads, Open Library, Google Books, Web")
    print(f" Target: {args.target.upper()} | Workers: {args.workers} | Has Turso: {has_turso}")
    print("=" * 70)

    # Fetch unique titles needing cover refresh
    local_conn = sqlite3.connect("bookstore.db", timeout=30.0)
    local_cursor = local_conn.cursor()
    local_cursor.execute("""
        SELECT title, author, count(*) as copy_count
        FROM books
        WHERE title IS NOT NULL AND title != ''
          AND (image_url IS NULL OR image_url = '')
        GROUP BY lower(title)
        ORDER BY copy_count DESC, id ASC
    """)
    rows = local_cursor.fetchall()

    total_candidates = len(rows)
    if args.limit > 0:
        rows = rows[:args.limit]
    active_count = len(rows)

    print(f"Found {total_candidates} unique book titles needing cover refresh.")
    print(f"Processing batch of {active_count} titles with {args.workers} concurrent network workers...\n")

    if active_count == 0:
        print("✅ All books already have image_url populated.")
        local_conn.close()
        return

    # Turso setup
    turso_conn = None
    if has_turso and args.target in ("turso", "both"):
        try:
            import turso_client
            turso_conn = turso_client.connect(turso_url, turso_token)
            print("Connected to Turso Cloud database for live production sync.\n")
        except Exception as e:
            print(f"Warning: Turso connection failed ({e}), continuing with local SQLite only.\n")

    start_time = time.time()
    success_count = 0
    failure_count = 0
    completed = 0

    def task(item):
        title, author = item[0], item[1]
        url, source = resolve_cover_network(title, author)
        return (title, author, url, source)

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(task, r): r for r in rows}
        for future in as_completed(futures):
            completed += 1
            t, a, cover, src = future.result()
            pct = (completed / active_count) * 100

            if cover:
                success_count += 1
                try:
                    local_cursor.execute(
                        "UPDATE books SET image_url = ? WHERE lower(title) = ?",
                        (cover, t.lower())
                    )
                except Exception as e:
                    print(f"SQLite update error: {e}")

                if turso_conn:
                    try:
                        turso_cursor = turso_conn.cursor()
                        turso_cursor.execute(
                            "UPDATE books SET image_url = ? WHERE lower(title) = ?",
                            (cover, t.lower())
                        )
                        turso_conn.commit()
                    except Exception:
                        pass

                print(f"[{completed:>4}/{active_count}] ({pct:>5.1f}%) ✅ [{src:<15}] {t[:35]:<35}")
            else:
                failure_count += 1
                print(f"[{completed:>4}/{active_count}] ({pct:>5.1f}%) ❌ [{src:<15}] {t[:35]:<35}")

            if completed % 10 == 0:
                local_conn.commit()

    local_conn.commit()
    local_conn.close()
    if turso_conn:
        turso_conn.close()

    elapsed = time.time() - start_time
    search_engine.invalidate_search_cache()

    print("\n" + "=" * 70)
    print(f" 🏁 Refresh Completed in {elapsed:.1f}s")
    print(f" Successful: {success_count} | Failed/Unmatched: {failure_count} | Total: {active_count}")
    print("=" * 70)

if __name__ == "__main__":
    main()
