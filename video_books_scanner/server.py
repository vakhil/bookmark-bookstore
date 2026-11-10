"""
Standalone Video Book Shelf Scanner using Indra OCR.
Independent server running on its own port (default: 8088).
Processes videos frame-by-frame, extracts book spines via Indra OCR,
groups titles into racks, columns, and positions (top-to-bottom or left-to-right),
and outputs table data formatted as TSV/CSV/JSON matching:
Book_ID | Rack | Column | Pos | Title | Author_or_Editor | Genre | Notes
"""

import os
import sys
import json
import base64
import re
import tempfile
from http.server import HTTPServer, SimpleHTTPRequestHandler
import urllib.parse
from typing import List, Dict, Any, Optional

# Ensure indra and root directory modules can be loaded
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.abspath(os.path.join(BASE_DIR, ".."))
INDRA_DIR = os.path.join(ROOT_DIR, "indra")

if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)
if INDRA_DIR not in sys.path:
    sys.path.insert(0, INDRA_DIR)

try:
    import indra_ocr
    import cv2
    import numpy as np
    HAS_INDRA = True
except Exception as e:
    HAS_INDRA = False
    print(f"[Warning] Indra OCR / OpenCV load notice: {e}")

# Try importing catalog search engine and genre classifier from root if available
try:
    import search_engine
    HAS_SEARCH = True
except Exception:
    HAS_SEARCH = False

try:
    import genre_classifier
    HAS_GENRE = True
except Exception:
    HAS_GENRE = False

# Global Indra Converter instance
_CONVERTER = None

def get_converter():
    global _CONVERTER
    if _CONVERTER is not None:
        return _CONVERTER
    if HAS_INDRA:
        try:
            _CONVERTER = indra_ocr.load(threads=4)
        except Exception as e:
            print(f"[Error] Failed to load indra_ocr: {e}")
    return _CONVERTER

def clean_ocr_text(t: str) -> str:
    cleaned = re.sub(r"[^\w\s\-\':\.,&/]", " ", t).strip()
    return " ".join(cleaned.split())

def is_noise_text(t: str) -> bool:
    if not t or len(t) < 2:
        return True
    t_lower = t.lower()
    noise = {"isbn", "barcode", "vol", "http", "www", "com", "page", "chapter", "edition", "bestseller"}
    if t_lower in noise:
        return True
    return False

def ocr_image_cv2(conv, gray_img):
    """Runs Indra OCR on a grayscale OpenCV image."""
    try:
        page = conv.ocr(gray_img)
        lines = []
        if hasattr(page, "lines"):
            for l in page.lines:
                txt = getattr(l, "text", "").strip()
                box = list(getattr(l, "box", []))
                conf = getattr(l, "confidence", 1.0)
                if txt and not is_noise_text(txt):
                    lines.append({
                        "text": txt,
                        "box": box,
                        "confidence": conf
                    })
        return lines
    except Exception as e:
        print(f"Indra frame OCR error: {e}")
        return []

def classify_book_genre(title: str, author: str = "") -> str:
    if HAS_GENRE:
        try:
            return genre_classifier.classify_common_genre("", title)
        except Exception:
            pass
    # Basic keyword rules
    t_low = (title + " " + author).lower()
    if any(k in t_low for k in ["fiction", "novel", "stories", "heart", "secrets", "game", "kiss"]):
        return "Fiction"
    if any(k in t_low for k in ["leadership", "business", "money", "investing", "startup", "management", "corporate", "success"]):
        return "Business & Management"
    if any(k in t_low for k in ["psychology", "mind", "think", "empathy", "mental", "focus"]):
        return "Psychology"
    if any(k in t_low for k in ["spiritual", "yoga", "meditation", "god", "enlightenment", "adiyogi"]):
        return "Spirituality"
    if any(k in t_low for k in ["history", "war", "churchill", "mughal"]):
        return "History"
    if any(k in t_low for k in ["data", "science", "physics", "code", "ai", "math"]):
        return "Science & Technology"
    return "General Non-Fiction"

def process_video_stream(video_path: str, rack_name: str = "Rack 92", fps_sample: float = 1.5, columns_count: int = 1):
    """
    Reads a video file using OpenCV, samples frames at `fps_sample`,
    runs Indra OCR to detect ONLY books visible in the video,
    orders them strictly top-to-bottom within each column, and assigns Pos 1, 2, 3...
    """
    conv = get_converter()
    if not conv:
        return {"error": "Indra OCR engine not available on this server"}

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return {"error": f"Could not open video file: {video_path}"}

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_interval = max(1, int(fps / fps_sample))

    collected_lines = []
    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % frame_interval == 0:
            # Grayscale conversion for Indra OCR
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            lines = ocr_image_cv2(conv, gray)
            for l in lines:
                l["frame"] = frame_idx
                collected_lines.append(l)
        frame_idx += 1

    cap.release()

    # Deduplicate and keep ONLY text detected in the video frames
    seen_titles = set()
    raw_books = []

    for l in collected_lines:
        txt = clean_ocr_text(l["text"])
        if len(txt) < 3 or is_noise_text(txt):
            continue

        norm_key = re.sub(r"[^\w]", "", txt.lower())
        if len(norm_key) < 3 or norm_key in seen_titles:
            continue

        # Keep strictly what is seen in the video; do not inject outside phantom books
        detected_title = txt
        detected_author = ""
        detected_genre = ""
        detected_notes = ""

        # Only check existing catalog to refine author/genre for the EXACT detected book title
        if HAS_SEARCH:
            try:
                res = search_engine.search_books(txt)
                if res.get("exact_matches"):
                    top = res["exact_matches"][0]
                    # Verify string similarity to ensure it's the exact same title
                    sim = search_engine.string_similarity(txt, top["title"])
                    if sim >= 0.85:
                        detected_title = top["title"]
                        detected_author = top.get("author", "")
                        detected_genre = top.get("genre", "")
                        detected_notes = f"Catalog match ({top.get('book_id', '')})"
            except Exception:
                pass

        if not detected_genre:
            detected_genre = classify_book_genre(detected_title, detected_author)

        box = l.get("box", [])
        y_val = (box[1] + box[3]) / 2.0 if len(box) >= 4 else float(l.get("frame", 0))
        x_val = (box[0] + box[2]) / 2.0 if len(box) >= 4 else 0.0

        seen_titles.add(norm_key)
        raw_books.append({
            "title": detected_title,
            "author": detected_author,
            "genre": detected_genre,
            "x": x_val,
            "y": y_val,
            "frame": l.get("frame", 0),
            "notes": detected_notes or f"Spine in video frame {l.get('frame', 0)}"
        })

    # Sort strictly by temporal and spatial order (top to bottom as scanned)
    raw_books.sort(key=lambda b: (b["frame"], b["y"]))

    # Normalize rack name formatting (e.g. ensure 'Rack 92')
    clean_rack = rack_name.strip()
    if clean_rack and not clean_rack.lower().startswith("rack"):
        clean_rack = f"Rack {clean_rack}"

    # Partition detected books across the rack's columns
    num_cols = max(1, columns_count)
    books_per_col = max(1, (len(raw_books) + num_cols - 1) // num_cols)

    final_entries = []
    base_id = 12400

    for idx, b in enumerate(raw_books):
        # A single vertical sequence from top to bottom is called a Column
        col_idx = (idx // books_per_col) + 1
        # The number within that column is the position (Pos), 1 at the top, increasing downwards
        pos_in_col = (idx % books_per_col) + 1
        book_id = f"BK-{base_id + idx + 1}"

        final_entries.append({
            "Book_ID": book_id,
            "Rack": clean_rack,
            "Column": f"Column {col_idx}",
            "Pos": pos_in_col,
            "Title": b["title"],
            "Author_or_Editor": b["author"],
            "Genre": b["genre"],
            "Notes": b["notes"]
        })

    return {"success": True, "count": len(final_entries), "books": final_entries}


class VideoScannerServer(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.path.join(BASE_DIR, "static"), **kwargs)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/process-video":
            content_length = int(self.headers.get("Content-Length", 0))
            post_data = self.rfile.read(content_length)

            content_type = self.headers.get("Content-Type", "")

            # Handle JSON body with base64 video or file path
            if "application/json" in content_type:
                try:
                    payload = json.loads(post_data.decode("utf-8"))
                    rack = payload.get("rack", "Rack 92")
                    columns = int(payload.get("columns", 4))
                    fps = float(payload.get("fps", 1.5))
                    video_b64 = payload.get("video_data", "")

                    if video_b64:
                        if "," in video_b64:
                            video_b64 = video_b64.split(",", 1)[1]
                        raw_bytes = base64.b64decode(video_b64)
                        with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as tmp:
                            tmp.write(raw_bytes)
                            tmp_path = tmp.name

                        result = process_video_stream(tmp_path, rack_name=rack, fps_sample=fps, columns_count=columns)
                        try:
                            os.remove(tmp_path)
                        except Exception:
                            pass
                    elif payload.get("video_path"):
                        result = process_video_stream(payload["video_path"], rack_name=rack, fps_sample=fps, columns_count=columns)
                    else:
                        result = {"error": "No video data or video path provided"}

                    self._send_json(result)
                except Exception as e:
                    self._send_json({"error": str(e)}, status=500)
            else:
                self._send_json({"error": "Expected application/json payload"}, status=400)
        else:
            self._send_json({"error": "Not Found"}, status=404)

    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(json.dumps(data, indent=2).encode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

def run_server(port=8088):
    server = HTTPServer(("0.0.0.0", port), VideoScannerServer)
    print(f"================================================================")
    print(f"📚 Indra OCR Video Shelf Scanner running at:")
    print(f"👉 http://localhost:{port}")
    print(f"👉 http://127.0.0.1:{port}")
    print(f"================================================================")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server.")
        server.server_close()

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8088
    run_server(port)
