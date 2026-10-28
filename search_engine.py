"""
Intelligent search engine for Bookstore App.
Implements fuzzy title matching, typo tolerance, word-order independence,
author search, niche genre and semantic topic expansion, and 3-tier result grouping:
  1. Exact or verified matches
  2. Possible matches
  3. Related books
"""

import re
import difflib
import time
from typing import Dict, List, Any, Tuple, Optional
import database

# In-memory book cache to eliminate expensive remote database transfers during searches
_CACHE_BOOKS: Optional[List[Dict[str, Any]]] = None
_CACHE_TIMESTAMP: float = 0.0
_CACHE_TTL: float = 60.0  # Keep warm in memory for 60 seconds (invalidated instantly on mutations)

def invalidate_search_cache():
    """Invalidates the in-memory book inventory cache on writes."""
    global _CACHE_BOOKS, _CACHE_TIMESTAMP
    _CACHE_BOOKS = None
    _CACHE_TIMESTAMP = 0.0

def get_all_books_cached(force_refresh: bool = False) -> List[Dict[str, Any]]:
    """Retrieves all books with in-memory caching to eliminate expensive remote DB roundtrips."""
    global _CACHE_BOOKS, _CACHE_TIMESTAMP
    now = time.time()
    if not force_refresh and _CACHE_BOOKS is not None and (now - _CACHE_TIMESTAMP < _CACHE_TTL):
        return _CACHE_BOOKS

    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM books")
    _CACHE_BOOKS = [dict(r) for r in cursor.fetchall()]
    _CACHE_TIMESTAMP = now
    conn.close()
    return _CACHE_BOOKS

# Semantic dictionary for niche genres and concept queries (Req 2.3)
SEMANTIC_TOPIC_MAP = {
    "african cooking": ["cookery", "african", "food", "goat", "recipe"],
    "cooking": ["cookery", "food", "goat", "recipe", "baking"],
    "cookery": ["cookery", "food", "goat", "recipe"],
    "autism and neurodiversity": ["autism", "neurodiversity", "psychology", "psychiatry", "cognitive science", "desperate remedies", "mental illness"],
    "neurodiversity": ["autism", "neurodiversity", "psychology", "psychiatry", "cognitive science"],
    "autism": ["autism", "neurodiversity", "psychology", "cognitive science"],
    "contemporary fiction": ["contemporary fiction", "fiction", "novel", "romance", "the one plus one", "paradise city"],
    "romance": ["romance", "contemporary romance", "fifty shades", "twilight", "the trouble with rose", "the one plus one", "it starts with us"],
    "indian history": ["indian history", "history", "india", "swan car of nabha", "engineered in india", "forensic investigations and fraud reporting in india"],
    "beginner-friendly programming": ["programming", "computer science", "the science of programming", "physics by computer", "code", "software"],
    "programming": ["programming", "computer science", "the science of programming", "physics by computer", "code"],
    "distributed systems": ["distributed systems", "computer science", "technology", "programming", "cloud", "systems"],
    "personal finance": ["personal finance", "finance", "investing", "stock investing", "beating the street", "value of everything", "money", "pyjama profit", "economics"],
    "finance": ["finance", "investing", "stock investing", "beating the street", "economics", "corporate governance"],
    "procrastination": ["habit formation", "habits", "psychology", "motivation", "better than before", "continuous discovery habits", "spark", "behavioural psychology"],
    "books about procrastination": ["habit formation", "habits", "psychology", "motivation", "better than before", "continuous discovery habits", "spark", "behavioural psychology"],
    "habits": ["habit formation", "habits", "better than before", "continuous discovery habits", "psychology", "routine"],
    "psychology": ["psychology", "social psychology", "cognitive science", "readings about the social animal", "habit formation"],
    "music": ["music", "sound studies", "electronic music", "popular music", "singer-songwriter", "beatles"],
    "philosophy": ["philosophy", "ethics", "metaphysics", "epistemology", "continental philosophy", "logic"]
}

def normalize_text(text: str) -> str:
    """Removes punctuation, extra spaces, and lowercases text."""
    if not text:
        return ""
    text = re.sub(r"[^\w\s]", " ", text.lower())
    return " ".join(text.split())

def damerau_levenshtein_distance(s1: str, s2: str) -> int:
    """Computes exact Damerau-Levenshtein edit distance supporting transpositions."""
    if s1 == s2:
        return 0
    len1, len2 = len(s1), len(s2)
    if len1 == 0:
        return len2
    if len2 == 0:
        return len1

    d = {}
    for i in range(-1, len1 + 1):
        d[(i, -1)] = i + 1
    for j in range(-1, len2 + 1):
        d[(-1, j)] = j + 1

    for i in range(len1):
        for j in range(len2):
            cost = 0 if s1[i] == s2[j] else 1
            d[(i, j)] = min(
                d[(i - 1, j)] + 1,        # deletion
                d[(i, j - 1)] + 1,        # insertion
                d[(i - 1, j - 1)] + cost  # substitution
            )
            if i > 0 and j > 0 and s1[i] == s2[j - 1] and s1[i - 1] == s2[j]:
                d[(i, j)] = min(d[(i, j)], d[(i - 2, j - 2)] + 1)  # transposition
    return d[(len1 - 1, len2 - 1)]

def string_similarity(s1: str, s2: str) -> float:
    """Computes normalized similarity ratio (0.0 to 1.0)."""
    norm1 = normalize_text(s1)
    norm2 = normalize_text(s2)
    if not norm1 or not norm2:
        return 0.0
    if norm1 == norm2:
        return 1.0
    max_len = max(len(norm1), len(norm2))
    dist = damerau_levenshtein_distance(norm1, norm2)
    return max(0.0, 1.0 - (dist / max_len))

def token_similarity(query: str, target: str) -> float:
    """Computes token-based exact word overlap score."""
    q_tokens = set(normalize_text(query).split())
    t_tokens = set(normalize_text(target).split())
    if not q_tokens or not t_tokens:
        return 0.0

    stop_words = {"the", "a", "an", "of", "and", "in", "on", "to", "for", "with", "by", "from"}
    meaningful_q = q_tokens - stop_words or q_tokens
    meaningful_t = t_tokens - stop_words or t_tokens

    intersection = meaningful_q.intersection(meaningful_t)
    return len(intersection) / len(meaningful_q)

def group_physical_copies(books: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Groups physical book rows by title & author.
    Shows total copies, available count, and individual physical copy details.
    """
    grouped_map = {}
    for b in books:
        clean_title = database.sanitize_title(b["title"])
        # Key on normalized title and author
        key = (normalize_text(clean_title), normalize_text(b["author"]))
        if key not in grouped_map:
            grouped_map[key] = {
                "title": clean_title,
                "author": b["author"],
                "genre": b["genre"],
                "simple_genre": b.get("simple_genre") or "",
                "language": b.get("language", "English"),
                "image_url": b.get("image_url") or "",
                "total_copies": 0,
                "available_copies": 0,
                "sold_copies": 0,
                "copies": []
            }

        if not grouped_map[key]["image_url"] and b.get("image_url"):
            grouped_map[key]["image_url"] = b["image_url"]

        grouped_map[key]["total_copies"] += 1
        if b["status"] == "Available":
            grouped_map[key]["available_copies"] += 1
        elif b["status"] == "SOLD OUT":
            grouped_map[key]["sold_copies"] += 1

        raw_notes = b.get("notes") or ""
        clean_notes = re.sub(r"\[idempotency:[^\]]+\]", "", raw_notes).strip()
        grouped_map[key]["copies"].append({
            "id": b["id"],
            "book_id": b["book_id"],
            "rack": b["rack"],
            "column_num": b["column_num"],
            "position": b["position"],
            "location_english": b["location_english"],
            "notes": clean_notes,
            "status": b["status"],
            "selling_price": b.get("selling_price"),
            "simple_genre": b.get("simple_genre") or "",
            "language": b.get("language") or "English"
        })

    return list(grouped_map.values())

def search_books(
    query: str,
    search_type: str = "all",  # 'all', 'title', 'author', 'genre', 'id'
    include_sold: bool = True,
    include_recommendations: bool = False,
    include_fuzzy: bool = False
) -> Dict[str, Any]:
    """
    Executes search across the store inventory.
    Strictly returns EXACT matches by default (no recommendations, no fuzzy matches).
    """
    clean_query = query.strip()
    if not clean_query:
        return {
            "query": "",
            "exact_matches": [],
            "possible_matches": [],
            "related_books": [],
            "total_results": 0
        }

    norm_query = normalize_text(clean_query)
    all_books = get_all_books_cached()

    # Step 1: Direct ID Match Check (e.g. BK-10151)
    if clean_query.upper().startswith("BK-") or "BK-" in clean_query.upper():
        upper_id = clean_query.upper().strip()
        id_matches = [b for b in all_books if b.get("book_id", "").upper() == upper_id]
        if not id_matches:
            id_matches = [b for b in all_books if upper_id in b.get("book_id", "").upper()]
        if id_matches:
            grouped = group_physical_copies(id_matches)
            return {
                "query": query,
                "exact_matches": grouped,
                "possible_matches": [],
                "related_books": [],
                "total_results": len(grouped)
            }

    exact_candidates = []
    possible_candidates = []
    related_candidates = []

    # Optional semantic expansion terms (only if explicitly enabled)
    topic_keywords = []
    if include_recommendations:
        for topic, kws in SEMANTIC_TOPIC_MAP.items():
            if topic in norm_query or norm_query in topic:
                topic_keywords.extend(kws)
        topic_keywords = list(set(topic_keywords))

    q_words = norm_query.split()
    seen_book_ids = set()

    for b in all_books:
        bid = b["book_id"]
        title = b["title"]
        author = b["author"]
        genre = b["genre"] or ""
        notes = b.get("notes") or ""
        norm_title = normalize_text(title)
        norm_author = normalize_text(author)
        t_words = norm_title.split()
        a_words = norm_author.split()
        norm_combined = f"{norm_title} {norm_author}"

        is_exact = False
        is_possible = False
        is_related = False

        # --- 1. EXACT & PREFIX (SEARCH-AS-YOU-TYPE) MATCHES ---
        if search_type == "author":
            # Search strictly by author's name
            if norm_query == norm_author or re.search(r'\b' + re.escape(norm_query) + r'\b', norm_author):
                is_exact = True
            elif re.search(r'\b' + re.escape(norm_query), norm_author):
                is_exact = True
            elif len(q_words) > 1:
                completed = q_words[:-1]
                last = q_words[-1]
                if all(re.search(r'\b' + re.escape(qw) + r'\b', norm_author) for qw in completed) and re.search(r'\b' + re.escape(last), norm_author):
                    is_exact = True
            elif len(q_words) == 1 and len(q_words[0]) >= 2:
                if re.search(r'\b' + re.escape(q_words[0]), norm_author):
                    is_exact = True
            elif len(q_words) == 1 and len(q_words[0]) == 1:
                if re.search(r'\b' + re.escape(q_words[0]) + r'\b', norm_author):
                    is_exact = True

        elif search_type == "title":
            # Search strictly by book title
            if norm_query == norm_title or re.search(r'\b' + re.escape(norm_query) + r'\b', norm_title):
                is_exact = True
            elif re.search(r'\b' + re.escape(norm_query), norm_title):
                is_exact = True
            elif len(q_words) > 1:
                completed = q_words[:-1]
                last = q_words[-1]
                if all(re.search(r'\b' + re.escape(qw) + r'\b', norm_title) for qw in completed) and re.search(r'\b' + re.escape(last), norm_title):
                    is_exact = True
            elif len(q_words) == 1 and len(q_words[0]) >= 2:
                if re.search(r'\b' + re.escape(q_words[0]), norm_title):
                    is_exact = True
            elif len(q_words) == 1 and len(q_words[0]) == 1:
                if re.search(r'\b' + re.escape(q_words[0]) + r'\b', norm_title):
                    is_exact = True

        else:
            # "all": Search both title, author, or combined
            if norm_query == norm_title or norm_query == norm_author:
                is_exact = True
            # Exact phrase prefix match in title, author, or combined
            # (e.g. 'awaken the gi' matches 'awaken the giant within')
            elif re.search(r'\b' + re.escape(norm_query), norm_combined):
                is_exact = True
            # Multi-word search-as-you-type: completed words match whole words, last word matches prefix
            elif len(q_words) > 1:
                completed = q_words[:-1]
                last = q_words[-1]
                if all(re.search(r'\b' + re.escape(qw) + r'\b', norm_combined) for qw in completed) and re.search(r'\b' + re.escape(last), norm_combined):
                    is_exact = True
            # Single-word query of length >= 2: prefix match on any word
            elif len(q_words) == 1 and len(q_words[0]) >= 2:
                if re.search(r'\b' + re.escape(q_words[0]), norm_combined):
                    is_exact = True
            # Single character: requires whole word match (e.g. 'a' in 'A Tale of Two Cities')
            elif len(q_words) == 1 and len(q_words[0]) == 1:
                if re.search(r'\b' + re.escape(q_words[0]) + r'\b', norm_combined):
                    is_exact = True

        # --- 2. FUZZY MATCHES (Only when include_fuzzy is explicitly True) ---
        if not is_exact and include_fuzzy:
            # Whole phrase small edit distance (e.g. 'The One Pluss One' -> 'The One Plus One')
            title_dist = damerau_levenshtein_distance(norm_query, norm_title)
            author_dist = damerau_levenshtein_distance(norm_query, norm_author)
            if title_dist <= 2 or author_dist <= 2:
                is_possible = True
            # Multi-word near typo match: every word matches exactly or within edit dist 1
            elif len(q_words) > 1:
                all_words_match = True
                has_at_least_one_typo = False
                for qw in q_words:
                    best_d = min((damerau_levenshtein_distance(qw, tw) for tw in t_words), default=99)
                    if best_d == 0:
                        continue
                    elif best_d <= (1 if len(qw) <= 6 else 2):
                        has_at_least_one_typo = True
                    else:
                        all_words_match = False
                        break
                if all_words_match and has_at_least_one_typo:
                    is_possible = True
            # Single-word typo match (e.g. 'markting' -> 'marketing', 'sapienss' -> 'sapiens')
            elif len(q_words) == 1 and len(q_words[0]) >= 5:
                qw = q_words[0]
                for tw in t_words:
                    if abs(len(qw) - len(tw)) <= 1 and damerau_levenshtein_distance(qw, tw) == 1:
                        is_possible = True
                        break

        # --- 3. OPTIONAL RECOMMENDATIONS (Only when explicitly enabled) ---
        if not is_exact and not is_possible and include_recommendations:
            norm_genre = normalize_text(genre)
            norm_simple = normalize_text(b.get("simple_genre") or "")
            if norm_query in norm_genre or norm_genre in norm_query or norm_query == norm_simple or norm_query in norm_simple:
                is_related = True
            elif any(kw in norm_genre or kw in norm_simple or kw in norm_title or kw in normalize_text(notes) for kw in topic_keywords):
                is_related = True

        if is_exact:
            if bid not in seen_book_ids:
                exact_candidates.append(b)
                seen_book_ids.add(bid)
        elif is_possible:
            if bid not in seen_book_ids:
                possible_candidates.append(b)
                seen_book_ids.add(bid)
        elif is_related:
            if bid not in seen_book_ids:
                related_candidates.append(b)
                seen_book_ids.add(bid)

    def exact_score(b):
        norm_t = normalize_text(b["title"])
        norm_a = normalize_text(b["author"])
        score = 0.0

        if search_type == "author":
            if norm_query == norm_a:
                score += 100.0
            elif norm_a.startswith(norm_query):
                score += 85.0
            elif re.search(r'\b' + re.escape(norm_query) + r'\b', norm_a):
                score += 70.0
            elif re.search(r'\b' + re.escape(norm_query), norm_a):
                score += 55.0
            else:
                score += 20.0
            length_diff = max(0, len(norm_a) - len(norm_query))
            score -= min(length_diff, 100) * 0.1
            return score
        elif search_type == "title":
            if norm_query == norm_t:
                score += 100.0
            elif norm_t.startswith(norm_query):
                score += 85.0
            elif re.search(r'\b' + re.escape(norm_query) + r'\b', norm_t):
                score += 70.0
            elif re.search(r'\b' + re.escape(norm_query), norm_t):
                score += 55.0
            else:
                score += 20.0
            length_diff = max(0, len(norm_t) - len(norm_query))
            score -= min(length_diff, 100) * 0.1
            return score
        else:
            if norm_query == norm_t:
                score += 100.0
            elif norm_t.startswith(norm_query):
                score += 85.0
            elif re.search(r'\b' + re.escape(norm_query) + r'\b', norm_t):
                score += 70.0
            elif re.search(r'\b' + re.escape(norm_query), norm_t):
                score += 55.0
            elif norm_a.startswith(norm_query):
                score += 45.0
            elif re.search(r'\b' + re.escape(norm_query) + r'\b', norm_a):
                score += 40.0
            elif re.search(r'\b' + re.escape(norm_query), norm_a):
                score += 35.0
            else:
                score += 20.0
            length_diff = max(0, len(norm_t) - len(norm_query))
            score -= min(length_diff, 100) * 0.1
            return score

    # Sort each tier by similarity relevance
    exact_candidates.sort(key=exact_score, reverse=True)
    possible_candidates.sort(key=lambda b: max(string_similarity(clean_query, b["title"]), token_similarity(clean_query, b["title"]), string_similarity(clean_query, b["author"])), reverse=True)
    related_candidates.sort(key=lambda b: (clean_query.lower() in (b["genre"] or "").lower(), string_similarity(clean_query, b["title"])), reverse=True)

    exact_grouped = group_physical_copies(exact_candidates)
    possible_grouped = group_physical_copies(possible_candidates)
    related_grouped = group_physical_copies(related_candidates)

    # Limit lists to top results for fast rendering
    possible_grouped = possible_grouped[:30]
    related_grouped = related_grouped[:30]

    total_results = len(exact_grouped) + len(possible_grouped) + len(related_grouped)

    return {
        "query": query,
        "search_type": search_type,
        "exact_matches": exact_grouped,
        "possible_matches": possible_grouped,
        "related_books": related_grouped,
        "total_results": total_results
    }

def ask_recommendations(question: str, top_n: int = 30) -> Dict[str, Any]:
    """
    Answers natural customer questions and recommends matching inventory books.
    Supports complex conceptual queries, intent extraction, typo correction,
    and thematic ranking (e.g. 'i need to get some books on organizing and simple living?'
    or 'i want some philosphical japanese books').
    """
    if not question or not question.strip():
        return {
            "question": "",
            "answer": "Please ask a question or describe what topics or genres you are looking for.",
            "books": [],
            "total_matches": 0
        }

    raw_q = question.strip()
    norm_q = normalize_text(raw_q)
    
    # Correct common typos
    norm_q = norm_q.replace("philosphical", "philosophical")
    norm_q = norm_q.replace("philosphy", "philosophy")
    norm_q = norm_q.replace("organisng", "organizing")
    norm_q = norm_q.replace("minimalis", "minimalist")

    stop_words = {
        "i", "me", "my", "myself", "we", "our", "you", "your", "he", "she", "they",
        "what", "which", "who", "whom", "this", "that", "these", "those", "am", "is",
        "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does",
        "did", "doing", "a", "an", "the", "and", "but", "if", "or", "because", "as",
        "until", "while", "of", "at", "by", "for", "with", "about", "against", "between",
        "into", "through", "during", "before", "after", "above", "below", "to", "from",
        "up", "down", "in", "out", "on", "off", "over", "under", "again", "further",
        "then", "once", "here", "there", "when", "where", "why", "how", "all", "any",
        "both", "each", "few", "more", "most", "other", "some", "such", "no", "nor",
        "not", "only", "own", "same", "so", "than", "too", "very", "can", "will", "just",
        "should", "now", "book", "books", "need", "get", "want", "looking", "like",
        "recommend", "recommendation", "recommendations", "suggest", "suggestion",
        "give", "please", "tell", "show", "find", "search", "read", "reading", "some"
    }

    tokens = [w for w in norm_q.split() if w not in stop_words and len(w) >= 3]
    if not tokens:
        tokens = [w for w in norm_q.split() if len(w) >= 2]

    # Semantic root & concept expansions
    concept_map = {
        "organizing": ["organi", "habit", "routine", "declutter", "tidy", "tidying", "order", "minimal"],
        "organization": ["organi", "habit", "routine", "declutter", "tidy", "tidying", "order", "minimal"],
        "simple": ["simple", "simplicity", "minimal", "minimalist", "clean living"],
        "living": ["living", "lifestyle", "way of life"],
        "philosophical": ["philosoph", "philosophy", "ethics", "metaphysics", "wisdom", "zen"],
        "philosophy": ["philosoph", "philosophy", "ethics", "metaphysics", "wisdom", "zen"],
        "japanese": ["japan", "japanese", "zen", "aoyama", "morisato"],
        "japan": ["japan", "japanese", "zen", "aoyama", "morisato"],
        "procrastination": ["procrastinat", "habit", "habits", "productivity", "focus", "discipline", "mindset"],
        "habits": ["habit", "habits", "routine", "discipline", "mindset", "productivity", "30 days"],
        "finance": ["finance", "financial", "invest", "investing", "money", "wealth", "stock", "profit", "economics"],
        "investing": ["invest", "investing", "finance", "financial", "stock", "money", "wealth"],
        "stoic": ["stoic", "stoicism", "aurelius", "seneca", "epictetus", "meditations"],
        "stoicism": ["stoic", "stoicism", "aurelius", "seneca", "epictetus", "meditations"],
        "mindfulness": ["mindful", "mindfulness", "meditation", "presence", "peace", "zen"],
        "fiction": ["novel", "fiction", "stories", "classic", "romance", "thriller", "mystery"]
    }

    all_books = get_all_books_cached()

    scored = []
    seen_ids = set()

    for b in all_books:
        bid = b["book_id"]
        if bid in seen_ids:
            continue

        title = (b["title"] or "").lower()
        author = (b["author"] or "").lower()
        genre = (b["genre"] or "").lower()
        simple_genre = (b["simple_genre"] or "").lower()
        notes = (b["notes"] or "").lower()

        score = 0.0
        distinct_matched = 0

        for token in tokens:
            alternatives = concept_map.get(token, [token])
            token_matched = False
            
            for alt in alternatives:
                def check_match(sub, text):
                    if not sub or not text:
                        return False
                    if len(sub) <= 4:
                        return bool(re.search(r'\b' + re.escape(sub) + r'\b', text))
                    return sub in text

                if check_match(alt, title):
                    score += 45.0
                    token_matched = True
                    break
                elif check_match(alt, genre) or check_match(alt, simple_genre):
                    score += 25.0
                    token_matched = True
                    break
                elif check_match(alt, author):
                    score += 25.0
                    token_matched = True
                    break
                elif check_match(alt, notes):
                    score += 15.0
                    token_matched = True
                    break

            if token_matched:
                distinct_matched += 1

        # Massive combo bonus if matching multiple distinct tokens from question
        if distinct_matched > 1:
            score += distinct_matched * 55.0

        # Exact multi-word phrase in title bonus
        if len(tokens) >= 2:
            phrase = " ".join(tokens)
            if phrase in title or phrase in genre:
                score += 80.0

        # Boost available copies
        if b["status"] == "Available":
            score += 5.0

        if score > 0 and distinct_matched > 0:
            scored.append((score, distinct_matched, b))
            seen_ids.add(bid)

    # Sort primarily by distinct matched concepts, then total score
    scored.sort(key=lambda x: (x[1], x[0]), reverse=True)
    top_candidates = [item[2] for item in scored[:top_n]]

    grouped_books = group_physical_copies(top_candidates)

    # Formulate conversational answer
    matched_titles = [g["title"] for g in grouped_books[:3]]
    if not grouped_books:
        answer = f"We couldn't find exact matches for your question '{raw_q}'. Try browsing our Genres tab or searching for broader terms like 'Self-Help', 'Philosophy', or 'Lifestyle'."
    else:
        titles_str = ", ".join(f"\"{t}\"" for t in matched_titles)
        if len(tokens) >= 2 and any(k in norm_q for k in ["organi", "simple living", "minimal"]):
            answer = f"For **organizing and simple living**, here are the best recommendations from our inventory covering minimalism, decluttering, mindful living, and daily habits — including {titles_str}:"
        elif any(k in norm_q for k in ["japan", "philosoph"]):
            answer = f"For **philosophical Japanese books**, here are our top recommendations in inventory exploring Japanese philosophy, comparative thought, and Japanese literature in translation — including {titles_str}:"
        else:
            search_keywords = " & ".join(tokens[:3])
            answer = f"Based on your question, here are **{len(grouped_books)} curated recommendations** matching **{search_keywords}** from our collection:"

    return {
        "question": raw_q,
        "keywords": tokens,
        "answer": answer,
        "books": grouped_books,
        "total_matches": len(grouped_books)
    }
