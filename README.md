# Bookstore Operations & Inventory Hub

A comprehensive, production-ready full-stack application designed specifically for independent bookstores. Built with a high-performance **Python backend** and a modern, responsive **Frontend (HTML5, CSS3, JavaScript)** optimized for mobile phone camera operation and desktop counter use.

Directly connected to the live Google Drive spreadsheet:
[Google Sheets Inventory Index](https://docs.google.com/spreadsheets/d/1-b8dp2W_1z1BT_2vAxpAMYTIP68CiyQf5z-Hal33JrU/edit?gid=0#gid=0)

---

## Key Features & Functional Requirements

### 1. Adding Books to Inventory
- **Single Book Entry (Option A & B)**:
  - **Option A (Camera Photograph)**: Mobile camera capture of front cover or spine. The app automatically segments text, extracts Title, Author, Genre, and Language. Staff review, correct, or confirm details.
  - **Option B (Manual Entry)**: Fast manual input without requiring photographs, publisher barcodes, or ISBNs.
- **Bulk Entry Workflows**:
  - **Workflow A (Batch Session)**: Rapid continuous capture mode where staff photograph books one after another, review the temporary batch list together, and save all to Google Sheets.
  - **Workflow B (Shelf / Stack Photo)**: Photograph an entire row or stack of books in one image. Detects individual book spines, extracts visible titles/authors, and flags uncertain, blurry, or overlapping items with clear warning badges rather than guessing.
- **Inventory ID Generation & Collision Prevention**:
  - Automatically preserves existing IDs (`BK-001` through `BK-11072`).
  - Sequentially generates collision-safe new IDs for newly added copies.
  - Thread-safe concurrency lock ensures no duplicate IDs are created even with simultaneous staff usage.
- **Duplicate Handling**:
  - Warns staff if the exact same photo is captured twice in a batch.
  - Distinguishes between intentional additions of multiple physical copies of the same title vs accidental duplicate entries.
- **Location Assignment & Conventions (Req 1.6)**:
  - Stores `rack`, `column`, and `position` as separate fields.
  - Translates numeric codes to bookstore English:
    - Position `1` maps to **"On top of the rack"** (e.g. `Rack 50 → Column 1 → On top of the rack`).
    - Position `5` maps to **"5th book from top"** (e.g. `Rack 50 → Column 2 → 5th book from top`).
- **Unassigned Books Section (Req 1.7)**:
  - Dedicated view for books without assigned shelf locations.
  - Shows days unassigned (flagging books unassigned for > 7 days).
  - Bulk assignment: assign the same location to multiple books at once, or assign different locations inline.
  - Location discrepancy finder & missing book auditor.

---

### 2. Intelligent Search Engine
Answers both critical customer service questions:
1. *Does the bookstore have the specific book the customer is asking for?*
2. *If unavailable, what relevant books does the store have instead?*

- **3-Tier Categorized Presentation (Req 2.4)**:
  1. **Exact or Verified Matches**: Exact title, verified author, or Inventory ID (`BK-10151`).
  2. **Possible Matches**: Typo-tolerant matches (Levenshtein distance), partial titles, word-order variations (e.g. "One Plus One The" vs "The One Plus One"), and minor spelling errors.
  3. **Related Books**: Semantic topic and niche genre expansion matching books addressing similar reading needs (e.g. "books about procrastination" matches habits and behavioral psychology; "personal finance" matches investing and economics).
- **Physical Copies & Locations**:
  - Displays each physical copy separately with its Inventory ID, English location, and status badge (`Available` [Green], `SOLD OUT` [Gray]).
  - Provides a one-click **"⚡ Sell Copy"** button directly from search results.
- **Offline / Local Search**:
  - Powered by SQLite FTS5 full-text indexing with BM25 ranking, running 100% locally with sub-millisecond response times even if internet or Google Sheets is temporarily unreachable.

---

### 3. Selling Workflow (POS)
- Fast mobile-friendly flow for serving customers at the counter.
- Look up by Inventory ID, Title/Author search, or photo.
- Displays matching physical copies, locations, and current availability status.
- Staff selects the specific copy to sell.
- Modal opens to review details with an **Optional Selling Price** input (distinguishing between unrecorded price and a genuine $0.00 free copy).
- **Concurrency Verification**: Atomically checks that the physical copy is not already marked as SOLD OUT before completing the sale.
- **Sheet Updates**:
  - Marks inventory availability by writing `"SOLD OUT"` adjacent to the book in Google Sheets.
  - Appends transaction record to the `Sales_Transactions` sheet with a unique Transaction ID (`TX-YYYYMMDD-XXXX`), Date/Time, Title, Author, Inventory ID, and Price.
  - Displays a printable/downloadable digital receipt.

---

### 4. Direct Google Sheets Connection & Outbox Sync
- Connected to spreadsheet `1-b8dp2W_1z1BT_2vAxpAMYTIP68CiyQf5z-Hal33JrU`.
- **Hybrid Outbox Architecture**:
  - Every write operation commits immediately to local SQLite for instant UI responsiveness and offline resilience.
  - Operations are queued in `sync_queue` with status tracking (`PENDING`, `SYNCED`, `FAILED`).
  - Automatic background flusher and manual **"🔄 Sync Outbox"** button.
  - Built-in zero-setup Google Apps Script webhook integration code provided for 2-way real-time writing.
- **Backups & Audit History**:
  - One-click timestamped CSV snapshot backups (`backups/inventory_backup_YYYYMMDD_HHMMSS.csv`).
  - Full audit log recording all additions, location changes, sales, and metadata corrections.

---

## Quick Start & Running the App

### 1. Start the Server
The backend requires **Python 3** (no external pip dependencies needed):

```bash
python3 server.py 8080
```

### 2. Access the Application
Open your web browser (or mobile browser on the same local network):
```
http://localhost:8080/
```

### 3. Running Automated Tests
Run the comprehensive test suite to verify all requirements:
```bash
python3 -m unittest tests/test_system.py
```

---

## File Structure

```
book-store-advanced/
├── server.py              # Threaded HTTP REST API Server
├── database.py            # SQLite database layer, FTS5 triggers, location conventions
├── search_engine.py       # 3-tier fuzzy search & semantic topic expansion engine
├── ocr_engine.py          # Book cover/spine candidate extraction & duplicate detection
├── sheets_sync.py         # Google Sheets live sync manager & outbox processor
├── initial_inventory.csv  # 2,688 books seed data from the Google Spreadsheet
├── static/
│   ├── index.html         # Responsive Single Page Application UI
│   ├── styles.css         # Modern, mobile-first stylesheet
│   └── app.js             # Interactive frontend application controller
├── tests/
│   └── test_system.py     # Functional test suite
└── backups/               # Recoverable snapshot backups directory
```

## Canonical Rack Numbering & Special Mappings

Because the database stores `rack` as an `INTEGER`, all named, alphanumeric, or special shelf/stack locations are mapped as follows:

| Physical / Sheet Name | Database Rack (`INTEGER`) | Notes / Scope |
| :--- | :--- | :--- |
| **Standard Floor Racks** | `1` .. `157` | Main aisles and shelf units |
| **Rack Manga / Manga Rack** | **`-31`** | Rows 8528–8951 in Google Sheet (424 books, `BK-17652` to `BK-18075`) |
| **Special Stacks / Overflow** | `-1` .. `-30` | Dedicated floor stacks & overflow piles |
| **Top Rack 1** | `5001` | Top shelf row 1 (`5000 + N`) |
| **Top Rack 2** | `5002` | Top shelf row 2 (`5000 + N`) |
| **Top Rack <N>** | `5000 + N` | e.g. `Top Rack 400` -> `5400` |
| **Top Rack Part 2** | `10000` | Legacy anchor |
| **Top Rack Part <N>** | `10000 + N` | e.g. `Top Rack Part 3` -> `10003` |

