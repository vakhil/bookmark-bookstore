"""
Production REST API server for Bookstore App.
Runs using Python standard library (http.server.ThreadingHTTPServer).
Provides full API endpoints for Single Book Entry, Bulk Entry (Workflows A & B),
Intelligent Search, Selling Workflow, Unassigned Books, Location Conventions,
and Google Sheets Live Sync.
"""

import sys
import os
import json
import mimetypes
import ssl
import threading
from urllib.parse import urlparse, parse_qs
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn

import database
import search_engine
import ocr_engine
import export_manager
from datetime import datetime

PORT = 8000
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """Handles requests in separate threads for high concurrency."""
    allow_reuse_address = True
    daemon_threads = True

class BookstoreAPIHandler(SimpleHTTPRequestHandler):
    """HTTP request handler supporting REST API endpoints and static file serving."""

    def __init__(self, *args, **kwargs):
        if "directory" not in kwargs and os.path.exists(STATIC_DIR):
            kwargs["directory"] = STATIC_DIR
        try:
            super().__init__(*args, **kwargs)
        except TypeError:
            # Handle BaseHTTPRequestHandler signatures
            kwargs.pop("directory", None)
            super().__init__(*args, **kwargs)

    def _send_json(self, data: Any, status_code: int = 200):
        """Sends a JSON response with CORS headers."""
        response_bytes = json.dumps(data, default=str).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(response_bytes)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")
        self.end_headers()
        self.wfile.write(response_bytes)

    def _read_json_body(self) -> Dict[str, Any]:
        """Reads and parses JSON body from POST request."""
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > 0:
            body_bytes = self.rfile.read(content_length)
            try:
                return json.loads(body_bytes.decode("utf-8"))
            except Exception:
                return {}
        return {}

    def end_headers(self):
        """Forces no-cache so browsers always load fresh UI without stale cache."""
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_OPTIONS(self):
        """Handles CORS preflight requests."""
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")
        self.end_headers()

    def do_GET(self):
        """Routes GET API requests or serves frontend static assets."""
        parsed_url = urlparse(self.path)
        path = parsed_url.path
        query_params = parse_qs(parsed_url.query)

        # API Routes
        if path == "/api/stats":
            stats = database.get_inventory_stats()
            sync_info = {"active": False, "mode": "local_database", "pending_changes": 0}
            self._send_json({"stats": stats, "sync": sync_info})
            return

        elif path == "/api/search":
            q = query_params.get("q", [""])[0]
            stype = query_params.get("type", ["all"])[0]
            results = search_engine.search_books(q, search_type=stype)
            self._send_json(results)
            return

        elif path == "/api/unassigned":
            q = query_params.get("q", [""])[0]
            limit = int(query_params.get("limit", [200])[0])
            offset = int(query_params.get("offset", [0])[0])
            unassigned_data = database.get_unassigned_books(query=q, limit=limit, offset=offset)
            self._send_json(unassigned_data)
            return

        elif path == "/api/sales":
            limit = int(query_params.get("limit", [100])[0])
            sales = database.get_recent_sales(limit=limit)
            self._send_json({"sales": sales})
            return

        elif path == "/api/audit":
            bid = query_params.get("book_id", [None])[0]
            limit = int(query_params.get("limit", [100])[0])
            logs = database.get_audit_history(book_id=bid, limit=limit)
            self._send_json({"audit_logs": logs})
            return

        elif path == "/api/sync/status":
            self._send_json({"connected": False, "pending_count": 0, "mode": "local_database"})
            return

        elif path == "/api/genres":
            dist = database.get_genre_distribution()
            self._send_json({"genres": dist})
            return

        elif path == "/api/books/by-genre":
            genre = query_params.get("genre", [""])[0]
            avail_only = query_params.get("available_only", ["true"])[0].lower() in ("true", "1")
            limit = int(query_params.get("limit", [500])[0])
            raw_books = database.get_books_by_genre(genre, available_only=avail_only, limit=limit)
            grouped = search_engine.group_physical_copies(raw_books)
            self._send_json({"genre": genre, "total_books": len(grouped), "books": grouped})
            return

        elif path == "/api/books/cover":
            title = query_params.get("title", [""])[0]
            author = query_params.get("author", [""])[0]
            cover_url = database.get_or_fetch_book_cover(title, author)
            self._send_json({"title": title, "cover_url": cover_url})
            return

        elif path == "/api/books/suggest-genre":
            title = query_params.get("title", [""])[0]
            author = query_params.get("author", [""])[0]
            suggested = ocr_engine.predict_genre_with_llm(title, author)
            self._send_json({"title": title, "author": author, "genre": suggested})
            return

        elif path == "/api/config/google-key":
            key = ocr_engine.get_google_api_key()
            # Security: Never expose raw API key to the client
            self._send_json({"has_key": bool(key), "ai_status": "active" if bool(key) else "inactive"})
            return

        elif path in ("/api/export/xlsx", "/api/export/excel"):
            xlsx_bytes = export_manager.generate_database_xlsx()
            filename = f"Bookstore_Database_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Content-Length", str(len(xlsx_bytes)))
            self.end_headers()
            self.wfile.write(xlsx_bytes)
            return

        elif path in ("/api/export/csv", "/api/export/inventory.csv"):
            csv_bytes = export_manager.generate_inventory_csv()
            filename = f"Bookstore_Inventory_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Content-Length", str(len(csv_bytes)))
            self.end_headers()
            self.wfile.write(csv_bytes)
            return

        elif path == "/api/export/sales.csv":
            csv_bytes = export_manager.generate_sales_csv()
            filename = f"Bookstore_Sales_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Content-Length", str(len(csv_bytes)))
            self.end_headers()
            self.wfile.write(csv_bytes)
            return

        # Serve static assets or index.html for single-page app
        if path == "/" or not os.path.exists(os.path.join(STATIC_DIR, path.lstrip("/"))):
            self.path = "/index.html"

        return super().do_GET()

    def do_POST(self):
        """Routes POST API requests."""
        parsed_url = urlparse(self.path)
        path = parsed_url.path
        body = self._read_json_body()

        # 1. Single Book Addition (Req 1.1)
        if path == "/api/books/add":
            title = body.get("title", "")
            author = body.get("author", "")
            genre = body.get("genre", "")
            language = body.get("language", "English")
            rack = body.get("rack", "")
            column_num = body.get("column_num", "")
            position = body.get("position", "")
            notes = body.get("notes", "")
            idempotency_key = body.get("idempotency_key")

            if not title.strip() or not author.strip():
                self._send_json({"error": "Title and Author are required."}, 400)
                return

            result = database.add_book(
                title=title, author=author, genre=genre, language=language,
                rack=rack, column_num=column_num, position=position,
                notes=notes, idempotency_key=idempotency_key
            )
            self._send_json({"success": True, "book": result})
            return

        # 2. Bulk Book Addition (Req 1.2 Workflows A & B)
        elif path == "/api/books/bulk":
            books_list = body.get("books", [])
            if not books_list:
                self._send_json({"error": "No books provided in batch."}, 400)
                return

            res = database.add_books_batch(books_list)
            self._send_json(res)
            return

        # 3. OCR Text Extraction & Book Candidate Detection (Req 1.1 Option A & Req 1.2)
        elif path == "/api/books/ocr-extract":
            raw_text = body.get("raw_text", "")
            multiple = body.get("multiple", False) or body.get("spine_mode", False)
            image_data = body.get("image_data", "")
            batch_hashes = body.get("batch_hashes", [])

            google_key = body.get("google_api_key", "")
            img_hash = ocr_engine.compute_image_hash(image_data) if image_data else ""

            if multiple:
                # Workflow B: Multi-book detection
                lines = [l.strip() for l in raw_text.splitlines() if l.strip()]
                # Group lines into book candidate clusters
                clusters = []
                current_cluster = []
                for line in lines:
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
                self._send_json({"candidates": candidates, "image_hash": img_hash})
            else:
                # Single book extraction (Option A)
                cand = ocr_engine.extract_candidates_from_text(
                    raw_text, image_data=image_data, google_api_key=google_key
                )
                cand["image_hash"] = img_hash
                self._send_json(cand)
            return

        # 4. Assign Location (Req 1.6 & 1.7)
        elif path == "/api/books/assign-location":
            book_id = body.get("book_id", "")
            rack = body.get("rack", "")
            column_num = body.get("column_num", "")
            position = body.get("position", "")
            notes = body.get("notes")

            if not book_id:
                self._send_json({"error": "Book ID is required."}, 400)
                return

            res = database.assign_location(book_id, rack, column_num, position, notes)
            if "error" in res:
                self._send_json(res, 404)
            else:
                self._send_json({"success": True, "book": res})
            return

        # 5. Bulk Assign Locations (Req 1.7)
        elif path == "/api/books/assign-location-bulk":
            assignments = body.get("assignments", [])
            if not assignments:
                self._send_json({"error": "No assignments provided."}, 400)
                return

            res = database.assign_location_bulk(assignments)
            self._send_json(res)
            return

        # 5b. Delete Book (Unassigned or routine removal)
        elif path == "/api/books/delete":
            book_id = body.get("book_id", "")
            if not book_id:
                self._send_json({"error": "Book ID is required to delete."}, 400)
                return
            res = database.delete_book(book_id)
            if "error" in res:
                self._send_json(res, 404)
            else:
                self._send_json(res)
            return

        elif path == "/api/books/delete-bulk":
            book_ids = body.get("book_ids", [])
            if not book_ids:
                self._send_json({"error": "No book IDs provided."}, 400)
                return
            res = database.delete_books_bulk(book_ids)
            self._send_json(res)
            return

        # 6. Selling Workflow (Req 3.1 - 3.3, Multi-Book Sale)
        elif path in ("/api/books/sell", "/api/books/sell-bulk"):
            # Multi-book bulk sale support
            if body.get("books") and isinstance(body.get("books"), list):
                res = database.sell_books_bulk(
                    items=body["books"],
                    user=body.get("user", "Staff"),
                    shared_notes=body.get("notes", "")
                )
                if "error" in res and not res.get("success"):
                    self._send_json(res, 400)
                else:
                    self._send_json(res)
                return

            # Single book sale support
            book_id = body.get("book_id", "")
            selling_price = body.get("selling_price")
            notes = body.get("notes", "")

            if not book_id:
                self._send_json({"error": "Book ID is required to sell."}, 400)
                return

            # Price can be float or None (optional selling price)
            price_val = None
            if selling_price is not None and str(selling_price).strip() != "":
                try:
                    price_val = float(selling_price)
                except ValueError:
                    self._send_json({"error": "Invalid selling price format."}, 400)
                    return

            res = database.sell_book(book_id, selling_price=price_val, notes=notes)
            if "error" in res:
                self._send_json(res, 400)
            else:
                self._send_json(res)
            return

        elif path == "/api/books/revert-sale":
            book_id = body.get("book_id", "")
            if not book_id:
                self._send_json({"error": "Book ID is required."}, 400)
                return
            res = database.revert_sale(book_id)
            self._send_json(res)
            return

        # 7. Update Metadata (Req 1.8)
        elif path == "/api/books/update":
            book_id = body.get("book_id", "")
            if not book_id:
                self._send_json({"error": "Book ID is required."}, 400)
                return

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
                self._send_json(res, 400)
            else:
                self._send_json({"success": True, "book": res})
            return

        # 8. Trigger Google Sheets Sync Outbox Flush (Req 1.8)
        elif path == "/api/sync/trigger":
            res = sheets_sync.process_outbox_queue()
            self._send_json(res)
            return

        # 9. Create Backup Snapshot (Req 1.8)
        elif path == "/api/sync/backup":
            backup_file = sheets_sync.create_local_backup()
            self._send_json({"success": True, "backup_file": backup_file})
            return

        # 10. Update Google Sheets Config
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
            self._send_json({"success": True, "config": safe_cfg})
            return

        # 11. Live Google Sheets Reload & Sync
        elif path == "/api/sync/reload-sheet":
            csv_content = body.get("csv_content", "").strip()
            if csv_content and len(csv_content) > 100:
                with open(database.SEED_CSV_PATH, "w", encoding="utf-8") as f:
                    f.write(csv_content)
            database.init_db(force_reseed=True)
            conn = database.get_db_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM books")
            total = cursor.fetchone()[0]
            conn.close()
            self._send_json({
                "success": True,
                "total_books": total,
                "message": f"Synchronized {total:,} books directly from live Google Sheet!"
            })
            return

        # 12. Natural Language Question Answering & Book Recommendations
        elif path == "/api/ask-recommendations":
            question = body.get("question") or body.get("query") or ""
            res = search_engine.ask_recommendations(question)
            self._send_json(res)
            return

        else:
            self._send_json({"error": "Endpoint not found."}, 404)

def ensure_ssl_certs(cert_file: str, key_file: str):
    """Generates self-signed SSL certificate if missing."""
    if not (os.path.exists(cert_file) and os.path.exists(key_file)):
        print("Generating self-signed SSL certificates for HTTPS (cert.pem, key.pem)...")
        os.system(f'openssl req -x509 -newkey rsa:2048 -keyout "{key_file}" -out "{cert_file}" -days 365 -nodes -subj "/CN=localhost" 2>/dev/null')

def run_server(port: int = 8088, use_ssl: bool = False, enable_dual_https: bool = True):
    """Starts the bookstore web server with automatic fallback and HTTPS support."""
    os.makedirs(STATIC_DIR, exist_ok=True)
    database.init_db()

    cert_file = os.path.join(os.path.dirname(__file__), "cert.pem")
    key_file = os.path.join(os.path.dirname(__file__), "key.pem")
    ensure_ssl_certs(cert_file, key_file)

    candidate_ports = [port, 8088, 8888, 9000, 9090, 5050]
    server = None
    actual_port = None

    for p in candidate_ports:
        try:
            server = ThreadedHTTPServer(("0.0.0.0", p), BookstoreAPIHandler)
            actual_port = p
            break
        except OSError as e:
            if e.errno == 48:
                continue
            raise

    if not server:
        raise RuntimeError("Could not bind to any available candidate port.")

    protocol = "http"
    if use_ssl and os.path.exists(cert_file) and os.path.exists(key_file):
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx.load_cert_chain(certfile=cert_file, keyfile=key_file)
        server.socket = ssl_ctx.wrap_socket(server.socket, server_side=True)
        protocol = "https"

    conn = database.get_db_connection()
    c = conn.cursor()
    c.execute("SELECT COUNT(*) FROM books")
    total_count = c.fetchone()[0]
    conn.close()

    print(f"Serving {total_count:,} live inventory records from local database.")
    print(f"Bookstore application running at {protocol}://localhost:{actual_port}/")
    print(f"LAN Access: {protocol}://192.168.29.144:{actual_port}/")

    # If main server is HTTP and dual HTTPS is enabled, start HTTPS companion on 8443
    https_server = None
    if not use_ssl and enable_dual_https and os.path.exists(cert_file) and os.path.exists(key_file):
        try:
            https_server = ThreadedHTTPServer(("0.0.0.0", 8443), BookstoreAPIHandler)
            ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ssl_ctx.load_cert_chain(certfile=cert_file, keyfile=key_file)
            https_server.socket = ssl_ctx.wrap_socket(https_server.socket, server_side=True)
            t = threading.Thread(target=https_server.serve_forever, daemon=True)
            t.start()
            print(f"🔒 Secure HTTPS companion active at https://localhost:8443/")
            print(f"🔒 Secure HTTPS LAN access at https://192.168.29.144:8443/")
        except Exception as ex:
            print(f"Notice: Could not bind HTTPS companion on port 8443: {ex}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server.")
        server.server_close()
        if https_server:
            https_server.server_close()

if __name__ == "__main__":
    args = sys.argv[1:]
    use_ssl = "--ssl" in args or "--https" in args
    clean_args = [a for a in args if not a.startswith("--")]
    port = int(clean_args[0]) if len(clean_args) > 0 else (8443 if use_ssl else 8088)
    run_server(port, use_ssl=use_ssl)
