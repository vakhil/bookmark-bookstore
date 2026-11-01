"""
Bookstore On-Demand Spreadsheet & Excel Export Manager.
Generates genuine Microsoft Excel (.xlsx) workbooks and CSV spreadsheets
directly from the SQLite database with ZERO external dependencies.
"""

import io
import csv
import zipfile
import sqlite3
import xml.sax.saxutils
from datetime import datetime
from typing import Dict, List, Any, Optional
import database

def _col_idx_to_letter(idx: int) -> str:
    """Converts a 1-based column index to an Excel column letter (1 -> A, 27 -> AA)."""
    col = ""
    while idx > 0:
        idx, rem = divmod(idx - 1, 26)
        col = chr(65 + rem) + col
    return col

def build_xlsx_workbook(sheets_data: Dict[str, Dict[str, Any]]) -> bytes:
    """
    Builds a multi-sheet .xlsx workbook using Python's built-in zipfile and xml libraries.
    sheets_data format:
    {
        "SheetName": {
            "headers": ["Col1", "Col2", ...],
            "rows": [ [val1, val2, ...], ... ]
        }
    }
    """
    buf = io.BytesIO()
    sheet_names = list(sheets_data.keys())

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # 1. [Content_Types].xml
        sheet_overrides = "".join(
            f'<Override PartName="/xl/worksheets/sheet{i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            for i in range(len(sheet_names))
        )
        content_types_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  {sheet_overrides}
</Types>"""
        zf.writestr("[Content_Types].xml", content_types_xml)

        # 2. _rels/.rels
        rels_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""
        zf.writestr("_rels/.rels", rels_xml)

        # 3. xl/_rels/workbook.xml.rels
        wb_rels_items = "".join(
            f'<Relationship Id="rId{i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i+1}.xml"/>'
            for i in range(len(sheet_names))
        )
        wb_rels_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  {wb_rels_items}
</Relationships>"""
        zf.writestr("xl/_rels/workbook.xml.rels", wb_rels_xml)

        # 4. xl/workbook.xml
        sheets_tags = "".join(
            f'<sheet name="{xml.sax.saxutils.escape(name)}" sheetId="{i+1}" r:id="rId{i+1}"/>'
            for i, name in enumerate(sheet_names)
        )
        workbook_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    {sheets_tags}
  </sheets>
</workbook>"""
        zf.writestr("xl/workbook.xml", workbook_xml)

        # 5. Worksheets
        for i, name in enumerate(sheet_names):
            sheet_info = sheets_data[name]
            headers = sheet_info.get("headers", [])
            rows = sheet_info.get("rows", [])

            rows_xml = []

            # Header row (row 1)
            h_cells = []
            for c_idx, h in enumerate(headers, 1):
                col_letter = _col_idx_to_letter(c_idx)
                esc_val = xml.sax.saxutils.escape(str(h) if h is not None else "")
                h_cells.append(f'<c r="{col_letter}1" t="inlineStr"><is><t>{esc_val}</t></is></c>')
            rows_xml.append(f'<row r="1">{" ".join(h_cells)}</row>')

            # Data rows
            for r_idx, row in enumerate(rows, 2):
                r_cells = []
                for c_idx, val in enumerate(row, 1):
                    col_letter = _col_idx_to_letter(c_idx)
                    esc_val = xml.sax.saxutils.escape(str(val) if val is not None else "")
                    r_cells.append(f'<c r="{col_letter}{r_idx}" t="inlineStr"><is><t>{esc_val}</t></is></c>')
                rows_xml.append(f'<row r="{r_idx}">{" ".join(r_cells)}</row>')

            worksheet_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    {" ".join(rows_xml)}
  </sheetData>
</worksheet>"""
            zf.writestr(f"xl/worksheets/sheet{i+1}.xml", worksheet_xml)

    return buf.getvalue()

def get_inventory_records() -> List[List[Any]]:
    """Fetches all physical book copies ordered by ID."""
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT 
            book_id, title, author, genre, simple_genre, language, 
            status, rack, column_num, position, location_english, 
            notes, selling_price, created_at, updated_at
        FROM books 
        ORDER BY id ASC
    """)
    rows = [list(r) for r in cursor.fetchall()]
    conn.close()
    return rows

def get_sales_records() -> List[List[Any]]:
    """Fetches all sales transaction records ordered by date DESC."""
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT 
            transaction_ref, book_id, title, author, 
            selling_price, sold_at, sold_by, notes
        FROM sales_transactions 
        ORDER BY id DESC
    """)
    rows = [list(r) for r in cursor.fetchall()]
    conn.close()
    return rows

def generate_database_xlsx() -> bytes:
    """
    Generates a full Excel spreadsheet workbook (.xlsx) containing:
      - 'Inventory': Full active catalog, racks, columns, and availability status.
      - 'Sales_Transactions': All sold books, sales revenue, and timestamps.
      - 'Store_Summary': KPI snapshot (total physical copies, available, sold out, unassigned).
    """
    inventory_headers = [
        "Book ID", "Title", "Author / Editor", "Genre", "Canonical Genre",
        "Language", "Status", "Rack", "Column", "Position (Top to Bottom)",
        "Location Description", "Physical Notes", "Selling Price", "Date Added", "Last Updated"
    ]
    inventory_rows = get_inventory_records()

    sales_headers = [
        "Transaction Ref", "Book ID", "Title", "Author",
        "Selling Price", "Sale Timestamp", "Cashier / User", "Payment Notes"
    ]
    sales_rows = get_sales_records()

    stats = database.get_inventory_stats()
    summary_headers = ["Metric", "Value"]
    summary_rows = [
        ["Total Physical Book Copies", stats.get("total_copies", len(inventory_rows))],
        ["Unique Titles", stats.get("unique_titles", 0)],
        ["Available Copies in Stock", stats.get("available_copies", 0)],
        ["Sold Out Copies", stats.get("sold_copies", 0)],
        ["Unassigned Books Needing Shelving", stats.get("unassigned_count", 0)],
        ["Total Shelving Racks Active", stats.get("rack_count", 0)],
        ["Export Generated At", datetime.now().strftime("%Y-%m-%d %H:%M:%S")]
    ]

    sheets_data = {
        "Inventory": {
            "headers": inventory_headers,
            "rows": inventory_rows
        },
        "Sales_Transactions": {
            "headers": sales_headers,
            "rows": sales_rows
        },
        "Store_Summary": {
            "headers": summary_headers,
            "rows": summary_rows
        }
    }

    return build_xlsx_workbook(sheets_data)

def generate_inventory_csv() -> bytes:
    """
    Generates an inventory CSV spreadsheet with UTF-8 BOM
    for seamless opening in Microsoft Excel, Google Sheets, and Apple Numbers.
    """
    headers = [
        "Book ID", "Title", "Author / Editor", "Genre", "Canonical Genre",
        "Language", "Status", "Rack", "Column", "Position",
        "Location Description", "Physical Notes", "Selling Price", "Date Added", "Last Updated"
    ]
    rows = get_inventory_records()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(headers)
    writer.writerows(rows)

    # Encode with UTF-8-SIG (BOM) so Excel opens accented text and quotes cleanly
    return buf.getvalue().encode("utf-8-sig")

def generate_sales_csv(phone: Optional[str] = None) -> bytes:
    """
    Generates a sales transactions CSV spreadsheet with UTF-8 BOM.
    Optionally filters by buyer mobile phone number.
    """
    headers = [
        "Transaction Ref", "Order ID", "Book ID", "Title", "Author", "Buyer Name", "Buyer Phone",
        "Selling Price", "Sale Timestamp", "Cashier / User", "Payment Notes", "Status"
    ]
    conn = database.get_db_connection()
    cursor = conn.cursor()
    if phone:
        clean_phone = "".join(filter(str.isdigit, str(phone)))
        cursor.execute("""
            SELECT 
                COALESCE(NULLIF(st.order_id, ''), st.transaction_ref) AS order_ref,
                st.book_id, st.title, st.author,
                COALESCE(co.buyer_name, '') AS buyer_name,
                COALESCE(co.buyer_phone, '') AS buyer_phone,
                st.selling_price, st.sold_at, st.sold_by, st.notes,
                COALESCE(st.status, 'COMPLETED') AS status
            FROM sales_transactions st
            LEFT JOIN customer_orders co ON COALESCE(NULLIF(st.order_id, ''), st.transaction_ref) = co.order_id
            WHERE co.buyer_phone LIKE ?
            ORDER BY st.id DESC
        """, (f"%{clean_phone}%",))
    else:
        cursor.execute("""
            SELECT 
                COALESCE(NULLIF(st.order_id, ''), st.transaction_ref) AS order_ref,
                st.book_id, st.title, st.author,
                COALESCE(co.buyer_name, '') AS buyer_name,
                COALESCE(co.buyer_phone, '') AS buyer_phone,
                st.selling_price, st.sold_at, st.sold_by, st.notes,
                COALESCE(st.status, 'COMPLETED') AS status
            FROM sales_transactions st
            LEFT JOIN customer_orders co ON COALESCE(NULLIF(st.order_id, ''), st.transaction_ref) = co.order_id
            ORDER BY st.id DESC
        """)
    rows = [list(r) for r in cursor.fetchall()]
    conn.close()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(headers)
    writer.writerows(rows)

    return buf.getvalue().encode("utf-8-sig")

def generate_phone_statement_xlsx(phone: str) -> bytes:
    """
    Generates a dedicated customer purchase statement spreadsheet (.xlsx)
    filtered for a specific mobile phone number.
    """
    clean_phone = "".join(filter(str.isdigit, str(phone)))
    conn = database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT 
            COALESCE(NULLIF(st.order_id, ''), st.transaction_ref) AS order_ref,
            st.book_id, st.title, st.author,
            COALESCE(co.buyer_name, '') AS buyer_name,
            COALESCE(co.buyer_phone, '') AS buyer_phone,
            st.selling_price, st.sold_at, st.sold_by, st.notes,
            COALESCE(st.status, 'COMPLETED') AS status
        FROM sales_transactions st
        LEFT JOIN customer_orders co ON COALESCE(NULLIF(st.order_id, ''), st.transaction_ref) = co.order_id
        WHERE co.buyer_phone LIKE ?
        ORDER BY st.id DESC
    """, (f"%{clean_phone}%",))
    rows = [list(r) for r in cursor.fetchall()]
    conn.close()

    headers = [
        "Order ID / Ref", "Book ID", "Title", "Author", "Buyer Name", "Buyer Phone",
        "Selling Price (INR)", "Sale Timestamp", "Cashier", "Payment Notes", "Status"
    ]

    total_spent = sum(float(r[6] or 0) for r in rows if r[10] != 'REVERTED')
    buyer_name = rows[0][4] if rows and rows[0][4] else "Customer"

    summary_headers = ["Customer Statement Metric", "Details"]
    summary_rows = [
        ["Customer Mobile Number", phone],
        ["Customer Name", buyer_name],
        ["Total Books Purchased", len(rows)],
        ["Completed Transactions Total (INR)", f"₹{total_spent:.2f}"],
        ["Statement Generated At", datetime.now().strftime("%Y-%m-%d %H:%M:%S")]
    ]

    sheets_data = {
        "Purchased_Books": {
            "headers": headers,
            "rows": rows
        },
        "Customer_Summary": {
            "headers": summary_headers,
            "rows": summary_rows
        }
    }

    return build_xlsx_workbook(sheets_data)
