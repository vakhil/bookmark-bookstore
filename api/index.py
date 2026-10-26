"""
Vercel Serverless Function entry point.
Implements standard WSGI interface supported by @vercel/python runtime.
Zero third-party dependencies - 100% Python Standard Library.
"""

import os
import sys
import json
import urllib.parse
import csv
import io

# Ensure parent directory is in sys.path
root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if root_dir not in sys.path:
    sys.path.insert(0, root_dir)

import database
import search_engine
import sheets_sync
import ocr_engine

# Prime and verify database on serverless cold-boot
try:
    database.ensure_database_ready()
except Exception as e:
    print(f"Serverless DB init notice: {e}")

def json_response(start_response, data, status_code=200):
    status_text = f"{status_code} OK" if status_code == 200 else f"{status_code} Error"
    if status_code == 404:
        status_text = "404 Not Found"
    elif status_code == 400:
        status_text = "400 Bad Request"
    elif status_code == 500:
        status_text = "500 Internal Server Error"

    body = json.dumps(data, default=str).encode("utf-8")
    headers = [
        ("Content-Type", "application/json; charset=utf-8"),
        ("Content-Length", str(len(body))),
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE"),
        ("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With"),
        ("Cache-Control", "no-cache, no-store, must-revalidate")
    ]
    start_response(status_text, headers)
    return [body]

def read_json_body(environ):
    try:
        content_length = int(environ.get("CONTENT_LENGTH", 0))
    except (ValueError, TypeError):
        content_length = 0
    if content_length > 0:
        wsgi_input = environ.get("wsgi.input")
        if wsgi_input:
            data = wsgi_input.read(content_length)
            try:
                return json.loads(data.decode("utf-8"))
            except Exception:
                return {}
    return {}

def app(environ, start_response):
    """Main WSGI entry point for Vercel Serverless Functions."""
    # Ensure database is primed for every request
    database.ensure_database_ready()

    method = environ.get("REQUEST_METHOD", "GET").upper()
    query_string = environ.get("QUERY_STRING", "")
    query_params = urllib.parse.parse_qs(query_string)

    # Resolve accurate API path
    path = query_params.get("__path__", [""])[0]
    if not path or path == "/api/index.py":
        raw = environ.get("RAW_URI") or environ.get("REQUEST_URI") or environ.get("HTTP_X_MATCHED_PATH", "")
        if raw:
            path = urllib.parse.urlparse(raw).path
    if not path or path == "/api/index.py":
        path = environ.get("PATH_INFO", "")

    # 1. CORS Preflight
    if method == "OPTIONS":
        headers = [
            ("Access-Control-Allow-Origin", "*"),
            ("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE"),
            ("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With"),
            ("Content-Length", "0")
        ]
        start_response("200 OK", headers)
        return [b""]

    # 2. GET Endpoints
    if method == "GET":
        if path == "/api/stats":
            stats = database.get_inventory_stats()
            sync_info = sheets_sync.get_sync_status()
            return json_response(start_response, {"stats": stats, "sync": sync_info})

        elif path == "/api/search":
            q = query_params.get("q", [""])[0]
            stype = query_params.get("type", ["all"])[0]
            results = search_engine.search_books(q, search_type=stype)
            return json_response(start_response, results)

        elif path == "/api/unassigned":
            q = query_params.get("q", [""])[0]
            limit = int(query_params.get("limit", [200])[0])
            offset = int(query_params.get("offset", [0])[0])
            unassigned_data = database.get_unassigned_books(query=q, limit=limit, offset=offset)
            return json_response(start_response, unassigned_data)

        elif path == "/api/sales":
            limit = int(query_params.get("limit", [100])[0])
            sales = database.get_recent_sales(limit=limit)
            return json_response(start_response, {"sales": sales})

        elif path == "/api/audit":
            bid = query_params.get("book_id", [None])[0]
            limit = int(query_params.get("limit", [100])[0])
            logs = database.get_audit_history(book_id=bid, limit=limit)
            return json_response(start_response, {"audit_logs": logs})

        elif path == "/api/sync/status":
            status = sheets_sync.get_sync_status()
            return json_response(start_response, status)

        elif path == "/api/genres":
            dist = database.get_genre_distribution()
            return json_response(start_response, {"genres": dist})

        elif path == "/api/books/by-genre":
            genre = query_params.get("genre", [""])[0]
            avail_only = query_params.get("available_only", ["false"])[0].lower() in ("true", "1")
            limit = int(query_params.get("limit", [500])[0])
            raw_books = database.get_books_by_genre(genre, available_only=avail_only, limit=limit)
            grouped = search_engine.group_physical_copies(raw_books)
            return json_response(start_response, {"genre": genre, "total_books": len(grouped), "books": grouped})

        elif path == "/api/config/google-key":
            key = ocr_engine.get_google_api_key()
            return json_response(start_response, {"google_api_key": key, "has_key": bool(key)})

        elif path == "/api/export/csv":
            conn = database.get_db_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM books ORDER BY id ASC")
            books = cursor.fetchall()
            conn.close()

            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow(["Book_ID", "Rack", "Column", "Position_Top_To_Bottom", "Title", "Author_or_Editor", "Genre", "Notes", "Simple_Genre", "Status", "Location_English", "Selling_Price"])
            for b in books:
                b_dict = dict(b)
                writer.writerow([
                    b_dict.get("book_id", ""), b_dict.get("rack", ""), b_dict.get("column_num", ""), b_dict.get("position", ""),
                    b_dict.get("title", ""), b_dict.get("author", ""), b_dict.get("genre", ""), b_dict.get("notes", ""),
                    b_dict.get("simple_genre", ""), b_dict.get("status", "Available"), b_dict.get("location_english", ""),
                    b_dict.get("selling_price", "")
                ])
            csv_bytes = output.getvalue().encode("utf-8")
            headers = [
                ("Content-Type", "text/csv; charset=utf-8"),
                ("Content-Disposition", "attachment; filename=\"inventory_export.csv\""),
                ("Access-Control-Allow-Origin", "*")
            ]
            start_response("200 OK", headers)
            return [csv_bytes]

    # 3. POST Endpoints
    elif method == "POST":
        body = read_json_body(environ)

        if path == "/api/books/add":
            title = body.get("title", "").strip()
            author = body.get("author", "").strip()
            genre = body.get("genre", "").strip()
            language = body.get("language", "English").strip()
            notes = body.get("notes", "").strip()
            rack = body.get("rack", "").strip()
            column_num = body.get("column_num", "").strip()
            position = body.get("position", "").strip()

            if not title:
                return json_response(start_response, {"error": "Book title is required."}, 400)

            book = database.add_book(
                title=title, author=author, genre=genre, language=language,
                notes=notes, rack=rack, column_num=column_num, position=position
            )
            return json_response(start_response, {"success": True, "book": book})

        elif path in ("/api/books/bulk", "/api/books/batch-a", "/api/books/batch-b"):
            books_list = body.get("books", [])
            if not books_list:
                return json_response(start_response, {"error": "No books provided in batch."}, 400)
            res = database.add_books_batch(books_list, user="Staff")
            return json_response(start_response, res)

        elif path == "/api/books/assign-location":
            book_id = body.get("book_id", "")
            rack = body.get("rack", "")
            column_num = body.get("column_num", "")
            position = body.get("position", "")
            notes = body.get("notes")

            if not book_id:
                return json_response(start_response, {"error": "Book ID is required."}, 400)

            res = database.assign_location(book_id, rack, column_num, position, notes)
            if "error" in res:
                return json_response(start_response, res, 404)
            return json_response(start_response, {"success": True, "book": res})

        elif path == "/api/books/assign-location-bulk":
            assignments = body.get("assignments", [])
            if not assignments:
                return json_response(start_response, {"error": "No assignments provided."}, 400)
            res = database.assign_location_bulk(assignments)
            return json_response(start_response, res)

        elif path == "/api/books/delete":
            book_id = body.get("book_id", "")
            if not book_id:
                return json_response(start_response, {"error": "Book ID is required to delete."}, 400)
            res = database.delete_book(book_id)
            if "error" in res:
                return json_response(start_response, res, 404)
            return json_response(start_response, res)

        elif path == "/api/books/delete-bulk":
            book_ids = body.get("book_ids", [])
            if not book_ids:
                return json_response(start_response, {"error": "No book IDs provided."}, 400)
            res = database.delete_books_bulk(book_ids)
            return json_response(start_response, res)

        elif path == "/api/books/sell":
            book_id = body.get("book_id", "")
            selling_price = body.get("selling_price")
            notes = body.get("notes", "")

            if not book_id:
                return json_response(start_response, {"error": "Book ID is required to sell."}, 400)

            price_val = None
            if selling_price is not None and str(selling_price).strip() != "":
                try:
                    price_val = float(selling_price)
                except ValueError:
                    return json_response(start_response, {"error": "Invalid selling price format."}, 400)

            res = database.sell_book(book_id, selling_price=price_val, notes=notes)
            if "error" in res:
                return json_response(start_response, res, 400)
            return json_response(start_response, res)

        elif path == "/api/books/revert-sale":
            book_id = body.get("book_id", "")
            if not book_id:
                return json_response(start_response, {"error": "Book ID is required."}, 400)
            res = database.revert_sale(book_id)
            return json_response(start_response, res)

        elif path == "/api/books/update":
            book_id = body.get("book_id", "")
            if not book_id:
                return json_response(start_response, {"error": "Book ID is required."}, 400)
            res = database.update_book_metadata(
                book_id=book_id,
                title=body.get("title"),
                author=body.get("author"),
                genre=body.get("genre"),
                language=body.get("language"),
                notes=body.get("notes"),
                status=body.get("status")
            )
            if "error" in res:
                return json_response(start_response, res, 400)
            return json_response(start_response, {"success": True, "book": res})

        elif path == "/api/ask-recommendations":
            q = body.get("question", "")
            result = search_engine.ask_recommendations(q)
            return json_response(start_response, result)

        elif path == "/api/books/ocr-extract":
            raw_text = body.get("raw_text", "")
            image_data = body.get("image_data", "")
            is_spine_mode = body.get("spine_mode", False) or body.get("multiple", False)
            batch_hashes = body.get("batch_hashes", [])
            google_key = body.get("google_api_key", None)
            img_hash = ocr_engine.compute_image_hash(image_data) if image_data else ""

            if is_spine_mode:
                clusters = []
                current_cluster = []
                for line in raw_text.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    if line.startswith("---") or line.startswith("Book"):
                        if current_cluster:
                            clusters.append("\n".join(current_cluster))
                            current_cluster = []
                    else:
                        current_cluster.append(line)
                if current_cluster:
                    clusters.append("\n".join(current_cluster))
                if not clusters:
                    clusters = [raw_text] if raw_text.strip() else []

                candidates = ocr_engine.detect_multiple_books_in_image(
                    clusters, batch_image_hashes=batch_hashes, current_image_hash=img_hash,
                    image_data=image_data, google_api_key=google_key
                )
                return json_response(start_response, {"candidates": candidates, "image_hash": img_hash})
            else:
                cand = ocr_engine.extract_candidates_from_text(
                    raw_text, image_data=image_data, google_api_key=google_key
                )
                cand["image_hash"] = img_hash
                return json_response(start_response, cand)

        elif path == "/api/sync/trigger":
            res = sheets_sync.process_outbox_queue()
            return json_response(start_response, res)

        elif path == "/api/sync/backup":
            backup_file = sheets_sync.create_local_backup()
            return json_response(start_response, {"success": True, "backup_file": backup_file})

        elif path == "/api/sync/config":
            cfg = sheets_sync.load_config()
            if "apps_script_url" in body:
                cfg["apps_script_url"] = body["apps_script_url"].strip()
            if "api_key" in body:
                cfg["api_key"] = body["api_key"].strip()
            sheets_sync.save_config(cfg)
            return json_response(start_response, {"success": True, "config": cfg})

        elif path == "/api/sync/pull-sheet":
            live_csv = sheets_sync.fetch_live_sheet_csv()
            if not live_csv:
                return json_response(start_response, {"success": False, "error": "Could not fetch Google Sheet CSV."}, 500)
            csv_path = database.SEED_CSV_PATH
            with open(csv_path, "w", encoding="utf-8") as f:
                f.write(live_csv)
            database.init_database(force_reseed=True)
            stats = database.get_inventory_stats()
            return json_response(start_response, {"success": True, "stats": stats})

    return json_response(start_response, {"error": "Not Found", "path": path}, 404)

# Expose both app and handler for Vercel
handler = app
