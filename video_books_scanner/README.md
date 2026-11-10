# Indra OCR Video Bookshelf Scanner (Standalone Program)

A completely independent application (HTML, CSS, JavaScript + Python backend) for scanning videos of bookshelf walkthroughs using **Indra Neural OCR** to output a structured inventory database table:

```
Book_ID	Rack	Column	Pos	Title	Author_or_Editor	Genre	Notes
BK-12399	Rack 92	Column 1	1	The Lives of Strangers	Chitra Banerjee Divakaruni	Short Stories / Contemporary Fiction	...
```

---

## Features
- **Independent Architecture**: Runs completely on its own port (default: `8088`), separate from the main bookstore website.
- **Indra OCR Neural Pipeline**: Uses the 1M-parameter ONNX Indra OCR model to detect lines, boxes, and reading order directly from video frames.
- **Automated Spatial Segmentation**: Detects books, clusters spine titles, and organizes items into columns and vertical shelf positions (1, 2, 3...).
- **Multi-Format Export**:
  - **TSV (Tab-Separated Values)**: First line is the database header row, followed by entry rows (ready for Excel/Google Sheets).
  - **CSV**: Standard comma-separated file with quoted fields.
  - **JSON**: Machine-readable array of structured records.
- **Live Video Preview & Progress Tracking**: Upload or drag-and-drop any `.mp4`, `.mov`, or `.webm` video.

---

## Quick Start

1. Start the server:
```bash
python3 video_books_scanner/server.py 8088
```

2. Open in your browser:
```
http://localhost:8088
```

3. Drag & drop or upload your shelf video walkthrough, set the rack name and columns, and click:
**"⚡ Process Video with Indra OCR"**
