"""
Enhanced OCR and book candidate extraction engine with Google Vision & Multimodal AI.
Supports:
  1. Google Cloud Vision API (TEXT_DETECTION / DOCUMENT_TEXT_DETECTION)
  2. Google Gemini Multimodal Vision API (book spine & multi-shelf intelligence)
  3. Real-time Video Frame OCR Analysis
  4. Catalog-guided N-Gram & fuzzy matching across 2,688 store titles
  5. Multi-book spine/stack segmentation (Workflow B)
  6. Duplicate image detection in batches (Req 1.5)
"""

import os
import re
import json
import base64
import hashlib
import urllib.request
import urllib.error
from typing import Dict, List, Any, Optional, Tuple
import database
import search_engine

CONFIG_FILE = os.path.join(os.path.dirname(__file__), "google_config.json")

def is_valid_google_key(key: Optional[str]) -> bool:
    """Checks whether an API key is non-empty and valid length."""
    if not key:
        return False
    k = key.strip()
    return len(k) >= 15

def get_google_api_key() -> str:
    """Gets Google API key from config file, environment, or default."""
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                cand = (data.get("google_api_key") or "").strip()
                if is_valid_google_key(cand):
                    return cand
        except Exception:
            pass
    env_key = (os.environ.get("GEMINI_API_KEY", "") or os.environ.get("GOOGLE_API_KEY", "")).strip()
    if is_valid_google_key(env_key):
        return env_key
    return "AQ.Ab8RN6LlJMtfmbF5D-ab_GRLfZUOw02vTua6nA9IbRKtZE6L_w"

AUTHOR_PREFIXES = ["by", "edited by", "author:", "written by", "translated by", "compiled by"]

PUBLISHER_NAMES = {
    "harper business", "harperbusiness", "harper collins", "harpercollins", "penguin", "penguin books",
    "random house", "simon & schuster", "simon and schuster", "vintage", "bloomsbury", "tor",
    "ballantine", "wiley", "o'reilly", "broadway books", "anchor books", "crown publishing",
    "crown", "hachette", "macmillan", "knopf", "berkley", "bantam", "riverhead", "picador",
    "st. martin's press", "scholastic", "oxford university press", "cambridge university press",
    "routledge", "springer", "pearson", "mcgraw-hill", "mit press", "harvard business review",
    "hbr press", "hyperion", "hodder & stoughton", "canongate", "atlantic books", "headline"
}

COVER_NOISE_WORDS = {
    "a novel", "the #1 new york times bestseller", "new york times bestseller", "#1 new york times bestseller",
    "bestseller", "the sunday times bestseller", "sunday times bestseller", "a memoir", "stories",
    "international bestseller", "#1 international bestseller", "national bestseller", "#1 national bestseller",
    "wall street journal bestseller", "#1 wall street journal bestseller", "usa today bestseller",
    "exclusive edition", "special edition", "foreword by", "introduction by", "preface by",
    "with a new afterword", "with a new introduction", "pulitzer prize winner", "now a major motion picture",
    "over 1 million copies sold", "over 2 million copies sold", "million-copy bestseller", "expanded edition",
    "updated edition", "anniversary edition", "revised edition", "collector's edition"
}

def is_garbage_line(line: str) -> bool:
    """Detects if an OCR line is meaningless noise, barcode, blurb, or non-book text."""
    line_clean = line.strip()
    if len(line_clean) < 3:
        return True
    
    # 1. Letter-to-character ratio
    letters = [c for c in line_clean if c.isalpha()]
    if len(letters) < 3 or (len(letters) / len(line_clean) < 0.60):
        return True

    # 2. Fragmented noise (e.g. '4 fa', '1 z Wii', 'ii Bl QQ', '474 Ih 3')
    tokens = line_clean.split()
    single_char_tokens = [t for t in tokens if len(t) <= 1 or (len(t) == 2 and t.lower() not in {"in", "on", "at", "to", "by", "of", "an", "as", "is", "it", "no", "we", "he", "or"})]
    if len(tokens) >= 2 and (len(single_char_tokens) / len(tokens) >= 0.5):
        return True

    # 3. Quotes and review blurbs
    if line_clean.startswith(('"', "'", "“", "”", "‘", "’")) or line_clean.endswith(('"', "'", "“", "”", "‘", "’")):
        return True
    if line_clean.startswith("- ") or line_clean.startswith("— "):
        return True
    if any(q in line_clean.lower() for q in ['" -', '“ -', '” -', " - cal", " - james", "fascinating", "praise for", "must-read", "brilliant"]):
        return True

    # 4. URLs, ISBN, barcodes
    if any(p in line_clean.lower() for p in ["http", "www.", ".com", ".org", "isbn", "978-", "barcode"]):
        return True

    # 5. Publisher names & known badges
    lower = line_clean.lower().strip()
    if lower in COVER_NOISE_WORDS or lower in PUBLISHER_NAMES:
        return True
    for badge in COVER_NOISE_WORDS:
        if badge in lower and len(lower) < len(badge) + 10:
            return True
    for pub in PUBLISHER_NAMES:
        if lower == pub or lower.startswith(pub + " ") or lower.endswith(" " + pub):
            return True

    return False

def compute_image_hash(image_data_or_b64: str) -> str:
    """Computes a SHA256 digest of image content to detect accidental duplicate captures."""
    if not image_data_or_b64:
        return ""
    if "," in image_data_or_b64:
        image_data_or_b64 = image_data_or_b64.split(",", 1)[1]
    return hashlib.sha256(image_data_or_b64.encode("utf-8")).hexdigest()[:16]

def clean_ocr_line(line: str) -> str:
    """Removes special characters and noise from OCR line."""
    cleaned = re.sub(r"[^\w\s\-\':\.,]", " ", line).strip()
    return " ".join(cleaned.split())

def call_google_cloud_vision(image_b64: str, api_key: str) -> Optional[List[str]]:
    """
    Calls Google Cloud Vision API (TEXT_DETECTION) to extract visible text lines.
    """
    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]

    url = f"https://vision.googleapis.com/v1/images:annotate?key={api_key}"
    payload = {
        "requests": [{
            "image": {"content": image_b64},
            "features": [{"type": "TEXT_DETECTION", "maxResults": 50}]
        }]
    }

    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            annotations = data.get("responses", [{}])[0].get("textAnnotations", [])
            if annotations:
                # First element contains full detected description
                full_desc = annotations[0].get("description", "")
                return [l.strip() for l in full_desc.splitlines() if l.strip()]
    except Exception as e:
        print(f"Google Cloud Vision notice (offline or unreachable): {e}")
    return None

def call_google_gemini_multimodal(image_b64: str, api_key: str) -> Optional[Dict[str, Any]]:
    """
    Calls Google Gemini Multimodal Vision API to identify book spine/cover directly.
    """
    if "," in image_b64:
        mime_match = re.search(r"data:(image/[a-zA-Z]+);base64,", image_b64)
        mime_type = mime_match.group(1) if mime_match else "image/jpeg"
        image_b64 = image_b64.split(",", 1)[1]
    else:
        mime_type = "image/jpeg"

    models_to_try = ["gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-flash-lite-latest"]
    prompt = """You are an automated bookstore scanner. Look at this book cover or spine photograph.
Identify the exact:
1. "title": The main book title.
2. "author": The primary author or editor name.
3. "genre": Likely genre or category.
4. "language": Book language (default English).
5. "confidence": "high", "medium", or "low".
Return strictly valid JSON with these keys, and no extra markdown or explanations."""

    payload = {
        "contents": [{
            "parts": [
                {"text": prompt},
                {"inlineData": {"mimeType": mime_type, "data": image_b64}}
            ]
        }],
        "generationConfig": {"temperature": 0.1, "responseMimeType": "application/json"}
    }

    for model in models_to_try:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json", "x-goog-api-key": api_key}
            )
            with urllib.request.urlopen(req, timeout=12) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
                if text.startswith("```"):
                    text = re.sub(r"^```[a-z]*\n|\n```$", "", text, flags=re.MULTILINE).strip()
                parsed = json.loads(text)
                if isinstance(parsed, dict) and parsed.get("title"):
                    return parsed
        except Exception as e:
            print(f"Gemini single model {model} notice: {e}")
            continue

    return None

def call_google_gemini_stack(image_b64: str, api_key: str) -> Optional[List[Dict[str, Any]]]:
    """
    Calls Google Gemini Multimodal Vision API to identify multiple books stacked on top of each other
    or placed in a row on a shelf, ordered from top to bottom (or left to right).
    """
    if "," in image_b64:
        mime_match = re.search(r"data:(image/[a-zA-Z]+);base64,", image_b64)
        mime_type = mime_match.group(1) if mime_match else "image/jpeg"
        image_b64 = image_b64.split(",", 1)[1]
    else:
        mime_type = "image/jpeg"

    models_to_try = ["gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-flash-lite-latest"]
    prompt = """You are an automated bookstore inventory scanner.
Look at this photograph of books stacked one on top of each other (or a row of books on a shelf).
Examine each individual book spine or cover from the TOP of the stack to the BOTTOM.
For EVERY distinct book visible, extract:
- "title": Clean, full book title as written on the spine.
- "author": Author or editor name if visible or known.
- "genre": Likely category (e.g. Fiction, Self-Help, Business, Science, Philosophy, History).
- "language": Language (default "English").
- "confidence": "high", "medium", or "low".

Return strictly a valid JSON array of objects:
[
  {"title": "Title 1", "author": "Author 1", "genre": "Fiction", "language": "English", "confidence": "high"},
  {"title": "Title 2", "author": "Author 2", "genre": "Business", "language": "English", "confidence": "high"}
]
Return only the JSON array with no extra text or markdown formatting."""

    payload = {
        "contents": [{
            "parts": [
                {"text": prompt},
                {"inlineData": {"mimeType": mime_type, "data": image_b64}}
            ]
        }],
        "generationConfig": {"temperature": 0.1, "responseMimeType": "application/json"}
    }

    for model in models_to_try:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json", "x-goog-api-key": api_key}
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
                if text.startswith("```"):
                    text = re.sub(r"^```[a-z]*\n|\n```$", "", text, flags=re.MULTILINE).strip()
                parsed = json.loads(text)
                if isinstance(parsed, list) and len(parsed) > 0:
                    return parsed
                elif isinstance(parsed, dict) and "books" in parsed and isinstance(parsed["books"], list) and len(parsed["books"]) > 0:
                    return parsed["books"]
        except Exception as e:
            print(f"Gemini stack model {model} notice: {e}")
            continue

    return None

def extract_candidates_from_text(
    raw_text: str,
    image_data: Optional[str] = None,
    google_api_key: Optional[str] = None
) -> Dict[str, Any]:
    """
    Analyzes extracted text or image using Google Vision / Gemini Multimodal,
    with catalog-guided matching against store titles.
    """
    api_key = google_api_key if is_valid_google_key(google_api_key) else get_google_api_key()

    # 1. Try Google Gemini Multimodal Vision if image is provided and key is present
    if image_data and api_key:
        gemini_result = call_google_gemini_multimodal(image_data, api_key)
        if gemini_result and gemini_result.get("title"):
            g_title = gemini_result.get("title", "").strip()
            g_author = gemini_result.get("author", "").strip()
            # Cross-reference with bookstore inventory for exact catalog ID and placement
            cat_search = search_engine.search_books(g_title)
            if cat_search["exact_matches"]:
                top = cat_search["exact_matches"][0]
                return {
                    "title": top["title"],
                    "author": top["author"],
                    "genre": top["genre"],
                    "language": top.get("language", "English"),
                    "confidence": "high",
                    "flag_uncertain": False,
                    "matched_existing": True,
                    "engine": "Google Gemini Vision AI",
                    "warning": None
                }
            return {
                "title": g_title,
                "author": g_author,
                "genre": gemini_result.get("genre", ""),
                "language": gemini_result.get("language", "English"),
                "confidence": gemini_result.get("confidence", "high"),
                "flag_uncertain": gemini_result.get("confidence") == "low",
                "matched_existing": False,
                "engine": "Google Gemini Vision AI",
                "warning": None
            }

    # 2. Try Google Cloud Vision API (TEXT_DETECTION)
    if image_data and api_key:
        vision_lines = call_google_cloud_vision(image_data, api_key)
        if vision_lines:
            raw_text = "\n".join(vision_lines)

    # 3. Catalog-Guided N-Gram & Fuzzy Matching
    raw_lines = [l.strip() for l in raw_text.splitlines() if l.strip()]
    cleaned_lines = []
    for l in raw_lines:
        c = clean_ocr_line(l)
        if len(c) >= 2 and c.lower() not in COVER_NOISE_WORDS:
            cleaned_lines.append(c)

    if not cleaned_lines:
        return {
            "title": "",
            "author": "",
            "genre": "",
            "language": "English",
            "confidence": "uncertain",
            "flag_uncertain": True,
            "matched_existing": False,
            "engine": "Store Catalog Matcher",
            "warning": "No readable text detected on cover or spine. Please enter manually or retry."
        }

    best_match = None
    best_score = 0.0

    # 1. Full text check against store catalog (fast indexed SQL lookup)
    full_text = " ".join(cleaned_lines)
    full_search = search_engine.search_books(full_text, include_fuzzy=False)
    if full_search["exact_matches"]:
        top = full_search["exact_matches"][0]
        sim = max(
            search_engine.string_similarity(full_text, top["title"]),
            search_engine.token_similarity(full_text, top["title"])
        )
        if sim >= 0.75:
            best_match = top
            best_score = sim

    # 2. Individual line checks (fast indexed SQL lookup for lines >= 4 chars)
    if not best_match:
        for line in cleaned_lines:
            if len(line) < 4 or line.lower() in COVER_NOISE_WORDS:
                continue
            line_search = search_engine.search_books(line, include_fuzzy=False)
            if line_search["exact_matches"]:
                m = line_search["exact_matches"][0]
                sim = max(
                    search_engine.string_similarity(line, m["title"]),
                    search_engine.token_similarity(line, m["title"])
                )
                if sim > best_score and sim >= 0.75:
                    best_match = m
                    best_score = sim

    # 3. 2-line sliding window for split titles
    if not best_match:
        for i in range(len(cleaned_lines) - 1):
            pair_text = f"{cleaned_lines[i]} {cleaned_lines[i+1]}"
            if len(pair_text) < 5:
                continue
            pair_search = search_engine.search_books(pair_text, include_fuzzy=False)
            if pair_search["exact_matches"]:
                m = pair_search["exact_matches"][0]
                sim = max(
                    search_engine.string_similarity(pair_text, m["title"]),
                    search_engine.token_similarity(pair_text, m["title"])
                )
                if sim > best_score and sim >= 0.75:
                    best_match = m
                    best_score = sim
                    best_score = sim

    # Return verified catalog match only if good confidence
    if best_match and best_score >= 0.75:
        return {
            "title": best_match["title"],
            "author": best_match["author"],
            "genre": best_match.get("genre", ""),
            "language": best_match.get("language", "English"),
            "confidence": "high",
            "flag_uncertain": False,
            "matched_existing": True,
            "match_score": round(best_score, 2),
            "engine": "Store Catalog Matcher",
            "warning": None
        }

    # 4. Accurate Visual Text Extraction directly from book cover/spine
    detected_title, detected_author = extract_visual_cover_info(cleaned_lines)

    flag_uncertain = len(detected_title) < 3
    warning = "Please verify title and author before saving." if flag_uncertain else None

    return {
        "title": detected_title,
        "author": detected_author,
        "genre": "",
        "language": "English",
        "confidence": "high" if (detected_title and detected_author) else ("medium" if detected_title else "low"),
        "flag_uncertain": flag_uncertain,
        "matched_existing": False,
        "engine": "Visual Cover Scanner",
        "warning": warning
    }

def extract_visual_cover_info(cleaned_lines: List[str]) -> Tuple[str, str]:
    """
    Intelligently scores and extracts Title and Author from clean OCR lines,
    filtering out taglines, subtitles, review blurbs, and publisher artifacts.
    """
    valid_lines = [l for l in cleaned_lines if not is_garbage_line(l)]
    if not valid_lines:
        return "", ""

    # Check for author explicitly prefixed (e.g. "By Scott Young")
    detected_author = ""
    for line in valid_lines:
        line_lower = line.lower()
        for prefix in AUTHOR_PREFIXES:
            if line_lower.startswith(prefix + " "):
                author_cand = line[len(prefix):].strip()
                if not is_garbage_line(author_cand):
                    detected_author = author_cand
                    break
        if detected_author:
            break

    # Score candidates for Title
    title_candidates = []
    for line in valid_lines:
        if line == detected_author:
            continue
        # Skip lines starting with "foreword by" or "introduction by"
        if any(line.lower().startswith(p) for p in ["foreword by", "introduction by", "preface by"]):
            continue

        words = line.split()
        score = 0.0

        # Book titles are concise (1-5 words)
        if 1 <= len(words) <= 4:
            score += 10.0
        elif len(words) == 5:
            score += 6.0
        elif len(words) >= 7:
            score -= 6.0

        # Character length: ideal title is 4-32 characters
        if 4 <= len(line) <= 30:
            score += 6.0
        elif len(line) > 45:
            score -= 6.0

        # Uppercase or Title Case
        if line.isupper():
            score += 5.0
        elif line.istitle():
            score += 4.0

        # Penalize sentences with periods or question marks
        if "." in line or "?" in line or "!" in line:
            score -= 8.0

        # Penalize subtitle words like "how to", "outsmart", "guide to", etc.
        if any(w in line.lower() for w in ["outsmart", "accelerate", "guide to", "how to", "secrets of", "manual for"]):
            score -= 6.0

        title_candidates.append((score, line))

    title_candidates.sort(key=lambda x: x[0], reverse=True)
    detected_title = title_candidates[0][1] if title_candidates else ""

    # If author was not found via prefix, score author candidates
    if not detected_author:
        author_candidates = []
        for line in valid_lines:
            if line == detected_title:
                continue
            if any(line.lower().startswith(p) for p in ["foreword by", "introduction by", "preface by"]):
                continue
            words = line.split()
            # Authors are usually 2-3 words (e.g. "Scott Young", "Scott H. Young")
            if len(words) in (2, 3):
                score = 5.0
                if re.match(r"^[A-Z][a-zA-Z\.\'\-]+(?:\s+[A-Z][a-zA-Z\.\'\-]+)+$", line):
                    score += 10.0
                if line.isupper():
                    score += 2.0
                author_candidates.append((score, line))
            elif len(words) == 1 and line.istitle() and len(line) > 3:
                author_candidates.append((1.0, line))

        if author_candidates:
            author_candidates.sort(key=lambda x: x[0], reverse=True)
            detected_author = author_candidates[0][1]

    # Clean up formatting
    if detected_title.isupper():
        detected_title = detected_title.title()
    if detected_author.isupper():
        detected_author = detected_author.title()

    detected_title = re.sub(r"^[^\w]+|[^\w]+$", "", detected_title).strip()
    detected_author = re.sub(r"^[^\w]+|[^\w]+$", "", detected_author).strip()

    return detected_title, detected_author

def detect_multiple_books_in_image(
    raw_text_blocks: List[str],
    batch_image_hashes: Optional[List[str]] = None,
    current_image_hash: Optional[str] = None,
    image_data: Optional[str] = None,
    google_api_key: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Workflow B: Processes multiple books captured in one image (books stacked one on top of each other,
    or shelf row). Segments spines into individual candidate book records ordered from top to bottom.
    Flags duplicates and uncertain items.
    """
    api_key = google_api_key if is_valid_google_key(google_api_key) else get_google_api_key()
    candidates = []
    is_dup_image = False
    if current_image_hash and batch_image_hashes and current_image_hash in batch_image_hashes:
        is_dup_image = True

    # 1. Try Google Gemini Vision to detect all spines in the stack directly from image
    if image_data and api_key:
        gemini_stack = call_google_gemini_stack(image_data, api_key)
        if gemini_stack and len(gemini_stack) > 0:
            conn = database.get_db_connection()
            cursor = conn.cursor()
            for idx, g_cand in enumerate(gemini_stack):
                g_title = (g_cand.get("title") or "").strip()
                g_author = (g_cand.get("author") or "").strip()
                g_genre = (g_cand.get("genre") or "").strip()
                if not g_title:
                    continue

                # Cross-reference with store catalog
                cat_search = search_engine.search_books(g_title)
                matched_existing = False
                if cat_search["exact_matches"]:
                    top = cat_search["exact_matches"][0]
                    g_title = top["title"]
                    g_author = top["author"]
                    g_genre = top.get("genre", g_genre)
                    matched_existing = True

                cursor.execute(
                    "SELECT book_id, rack, column_num, position FROM books WHERE lower(title) = ? AND status = 'Available'",
                    (g_title.lower(),)
                )
                existing_copies = cursor.fetchall()
                existing_count = len(existing_copies)

                item = {
                    "candidate_index": idx + 1,
                    "position": idx + 1,
                    "title": g_title,
                    "author": g_author,
                    "genre": g_genre,
                    "language": g_cand.get("language", "English"),
                    "confidence": g_cand.get("confidence", "high"),
                    "flag_uncertain": g_cand.get("confidence") == "low",
                    "matched_existing": matched_existing or existing_count > 0,
                    "existing_in_inventory": existing_count > 0,
                    "existing_copies_count": existing_count,
                    "info_message": f"Title exists in store ({existing_count} copies)" if existing_count > 0 else "New title",
                    "engine": "Google Gemini Vision AI",
                    "warning": "Same image photographed twice" if is_dup_image else None,
                    "is_duplicate_image": is_dup_image
                }
                candidates.append(item)
            conn.close()
            if candidates:
                return candidates

    # 2. Fallback: Parse raw_text_blocks into individual book spine segments
    all_blocks = []
    for b in raw_text_blocks:
        if not b or not b.strip():
            continue
        if "---" in b:
            all_blocks.extend([part.strip() for part in b.split("---") if part.strip()])
        elif "\n\n" in b:
            all_blocks.extend([part.strip() for part in b.split("\n\n") if part.strip()])
        else:
            all_blocks.append(b.strip())

    # If all_blocks only has 1 block but with several lines, group into 2-line spine segments
    if len(all_blocks) == 1 and "\n" in all_blocks[0]:
        lines = [l.strip() for l in all_blocks[0].splitlines() if l.strip()]
        if len(lines) > 2:
            all_blocks = []
            chunk = []
            for l in lines:
                chunk.append(l)
                if len(chunk) >= 2:
                    all_blocks.append("\n".join(chunk))
                    chunk = []
            if chunk:
                all_blocks.append("\n".join(chunk))

    for idx, block in enumerate(all_blocks):
        cand = extract_candidates_from_text(block, google_api_key=google_api_key)
        cand["candidate_index"] = idx + 1
        cand["position"] = idx + 1
        cand["is_duplicate_image"] = is_dup_image

        if is_dup_image:
            cand["flag_uncertain"] = True
            cand["warning"] = "Same image photographed twice in this batch. Please verify if intentional."

        if cand.get("title"):
            conn = database.get_db_connection()
            cursor = conn.cursor()
            cursor.execute(
                "SELECT book_id, rack, column_num, position FROM books WHERE lower(title) = ? AND status = 'Available'",
                (cand["title"].lower(),)
            )
            existing_copies = cursor.fetchall()
            conn.close()

            if existing_copies:
                cand["existing_in_inventory"] = True
                cand["existing_copies_count"] = len(existing_copies)
                cand["info_message"] = f"Title already exists in inventory ({len(existing_copies)} copies). Adding as another physical copy."
            else:
                cand["existing_in_inventory"] = False

        candidates.append(cand)

    return candidates
