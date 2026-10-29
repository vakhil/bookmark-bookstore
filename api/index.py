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
import export_manager
import ocr_engine
from datetime import datetime

# Prime and verify database on serverless cold-boot
try:
    database.ensure_database_ready()
    # Pre-warm search engine cache into RAM for instant searches
    search_engine.get_all_books_cached()
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
            sync_info = {"active": False, "mode": "local_database", "pending_changes": 0}
            return json_response(start_response, {"stats": stats, "sync": sync_info})

        elif path == "/api/search":
            q = query_params.get("q", [""])[0]
            stype = query_params.get("type", ["all"])[0]
            limit = int(query_params.get("limit", [80])[0])
            results = search_engine.search_books(q, search_type=stype, limit=limit)
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

        elif path in ("/api/transactions", "/api/transactions/list"):
            limit = int(query_params.get("limit", [100])[0])
            txs = database.get_transactions(limit=limit)
            return json_response(start_response, {"transactions": txs})

        elif path == "/api/audit":
            bid = query_params.get("book_id", [None])[0]
            limit = int(query_params.get("limit", [100])[0])
            logs = database.get_audit_history(book_id=bid, limit=limit)
            return json_response(start_response, {"audit_logs": logs})

        elif path == "/api/sync/status":
            return json_response(start_response, {"connected": False, "pending_count": 0, "mode": "local_database"})

        elif path == "/api/genres":
            dist = database.get_genre_distribution()
            return json_response(start_response, {"genres": dist})

        elif path == "/api/books/by-genre":
            genre = query_params.get("genre", [""])[0]
            avail_only = query_params.get("available_only", ["true"])[0].lower() in ("true", "1")
            limit = int(query_params.get("limit", [500])[0])
            raw_books = database.get_books_by_genre(genre, available_only=avail_only, limit=limit)
            grouped = search_engine.group_physical_copies(raw_books)
            return json_response(start_response, {"genre": genre, "total_books": len(grouped), "books": grouped})

        elif path == "/api/books/cover":
            title = query_params.get("title", [""])[0]
            author = query_params.get("author", [""])[0]
            cover_url = database.get_or_fetch_book_cover(title, author)
            return json_response(start_response, {"title": title, "cover_url": cover_url})

        elif path == "/api/books/suggest-genre":
            title = query_params.get("title", [""])[0]
            author = query_params.get("author", [""])[0]
            suggested = ocr_engine.predict_genre_with_llm(title, author)
            return json_response(start_response, {"title": title, "author": author, "genre": suggested})

        elif path == "/api/config/google-key":
            key = ocr_engine.get_google_api_key()
            # Security: Never expose raw API key to the client
            return json_response(start_response, {"has_key": bool(key), "ai_status": "active" if bool(key) else "inactive"})

        elif path in ("/api/export/xlsx", "/api/export/excel"):
            xlsx_bytes = export_manager.generate_database_xlsx()
            filename = f"Bookstore_Database_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
            headers = [
                ("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
                ("Content-Disposition", f'attachment; filename="{filename}"'),
                ("Access-Control-Allow-Origin", "*"),
                ("Content-Length", str(len(xlsx_bytes)))
            ]
            start_response("200 OK", headers)
            return [xlsx_bytes]

        elif path in ("/api/export/csv", "/api/export/inventory.csv"):
            csv_bytes = export_manager.generate_inventory_csv()
            filename = f"Bookstore_Inventory_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
            headers = [
                ("Content-Type", "text/csv; charset=utf-8"),
                ("Content-Disposition", f'attachment; filename="{filename}"'),
                ("Access-Control-Allow-Origin", "*"),
                ("Content-Length", str(len(csv_bytes)))
            ]
            start_response("200 OK", headers)
            return [csv_bytes]

        elif path == "/api/export/sales.csv":
            csv_bytes = export_manager.generate_sales_csv()
            filename = f"Bookstore_Sales_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
            headers = [
                ("Content-Type", "text/csv; charset=utf-8"),
                ("Content-Disposition", f'attachment; filename="{filename}"'),
                ("Access-Control-Allow-Origin", "*"),
                ("Content-Length", str(len(csv_bytes)))
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

        elif path in ("/api/books/sell", "/api/books/sell-bulk"):
            # Multi-book bulk sale support
            if body.get("books") and isinstance(body.get("books"), list):
                res = database.sell_books_bulk(
                    items=body["books"],
                    user=body.get("user", "Staff"),
                    shared_notes=body.get("notes", "")
                )
                if "error" in res and not res.get("success"):
                    return json_response(start_response, res, 400)
                return json_response(start_response, res)

            # Single book sale support
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

        elif path in ("/api/books/revert-sale", "/api/books/repay", "/api/books/refund", "/api/books/cancel-sale", "/api/books/return"):
            book_id = body.get("book_id", "")
            if not book_id:
                return json_response(start_response, {"error": "Book ID is required."}, 400)
            notes = body.get("notes", "")
            position_mode = body.get("position_mode", "previous")
            rack = body.get("rack")
            column_num = body.get("column_num")
            position = body.get("position")
            refund_amount = body.get("refund_amount")
            res = database.revert_sale(
                book_id=book_id,
                notes=notes,
                position_mode=position_mode,
                rack=rack,
                column_num=column_num,
                position=position,
                refund_amount=refund_amount
            )
            return json_response(start_response, res)

        elif path in ("/api/transactions/revert", "/api/transactions/return"):
            order_id = body.get("order_id", "")
            if not order_id:
                return json_response(start_response, {"error": "Order ID is required."}, 400)
            res = database.revert_transaction(
                order_id=order_id,
                user=body.get("user", "Staff"),
                notes=body.get("notes", "")
            )
            if "error" in res:
                return json_response(start_response, res, 400)
            return json_response(start_response, res)

        elif path in ("/api/transactions/redo", "/api/transactions/resell"):
            order_id = body.get("order_id", "")
            if not order_id:
                return json_response(start_response, {"error": "Order ID is required."}, 400)
            res = database.redo_transaction(
                order_id=order_id,
                user=body.get("user", "Staff"),
                notes=body.get("notes", "")
            )
            if "error" in res:
                return json_response(start_response, res, 400)
            return json_response(start_response, res)

        elif path in ("/api/transactions/cancel", "/api/transactions/delete"):
            order_id = body.get("order_id", "")
            if not order_id:
                return json_response(start_response, {"error": "Order ID is required."}, 400)
            res = database.delete_transaction(
                order_id=order_id,
                user=body.get("user", "Staff")
            )
            if "error" in res:
                return json_response(start_response, res, 400)
            return json_response(start_response, res)

        elif path == "/api/books/update-payment":
            book_id = body.get("book_id", "")
            selling_price = body.get("selling_price")
            if not book_id:
                return json_response(start_response, {"error": "Book ID is required."}, 400)
            if selling_price is None or selling_price == "":
                return json_response(start_response, {"error": "Selling price is required."}, 400)
            notes = body.get("notes", "")
            res = database.update_sale_payment(book_id, selling_price=selling_price, notes=notes)
            if "error" in res:
                return json_response(start_response, res, 400)
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
                rack=body.get("rack"),
                column_num=body.get("column_num"),
                position=body.get("position"),
                notes=body.get("notes"),
                status=body.get("status"),
                selling_price=body.get("selling_price")
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
            safe_cfg = dict(cfg)
            if safe_cfg.get("api_key"):
                safe_cfg["api_key"] = "••••••••"
            return json_response(start_response, {"success": True, "config": safe_cfg})

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
