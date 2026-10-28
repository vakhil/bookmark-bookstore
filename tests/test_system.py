"""
Comprehensive automated tests for Bookstore App.
Verifies all functional requirements from specification:
  - Inventory Import & Preservation (2,688 books)
  - Location Conventions & English Formatting (Req 1.6)
  - Adding Single & Bulk Books (Req 1.1, 1.2, 1.4, 1.5)
  - Intelligent 3-Tier Search (Req 2.1 - 2.7)
  - POS Selling Workflow & Concurrency Protection (Req 3.1 - 3.3)
  - Dedicated Unassigned Books Section & Bulk Assignment (Req 1.7)
  - Google Sheets Live Outbox Sync & Backup (Req 1.8)
"""

import unittest
import os
import json
import sqlite3

import database
import search_engine
import ocr_engine
import sheets_sync

class TestBookstoreSystem(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.orig_db_path = database.DB_PATH
        cls.test_db_path = os.path.join(os.path.dirname(__file__), "test_bookstore.db")
        database.DB_PATH = cls.test_db_path
        database.init_db(force_reseed=True)

    @classmethod
    def tearDownClass(cls):
        database.DB_PATH = cls.orig_db_path
        for suffix in ["", "-wal", "-shm"]:
            fpath = cls.test_db_path + suffix
            if os.path.exists(fpath):
                try:
                    os.remove(fpath)
                except Exception:
                    pass

    def test_01_seed_inventory_integrity(self):
        """Verifies all 2,688 physical books from Google Sheets are imported."""
        stats = database.get_inventory_stats()
        self.assertGreaterEqual(stats["total_copies"], 2688)
        self.assertGreater(stats["unique_titles"], 2000)
        self.assertGreaterEqual(stats["rack_count"], 45)

    def test_02_location_conventions_req1_6(self):
        """
        Req 1.6:
          - Stores rack, column, placement separately.
          - Maps position 1 to 'On top of the rack'.
          - Maps position 5 to '5th book from top'.
          - Formats location string in bookstore English.
        """
        loc1 = database.format_location_english("Rack 50", "Column 1", "1")
        self.assertEqual(loc1, "Rack 50 → Column 1 → On top of the rack")

        loc5 = database.format_location_english("Rack 50", "Column 2", "5")
        self.assertEqual(loc5, "Rack 50 → Column 2 → 5th book from top")

        # Top Rack 1 -> 5001, Top Rack 2 -> 5002, Top Rack 400 -> 5400
        self.assertEqual(database.parse_rack_value("Top Rack 1"), 5001)
        self.assertEqual(database.parse_rack_value("Top Rack 2"), 5002)
        self.assertEqual(database.parse_rack_value("Top Rack 400"), 5400)
        self.assertEqual(database.format_location_english("Top Rack 2", 1, 1), "Rack 5002 → Column 1 → On top of the rack")

        # Top Rack Part 5 -> 10005
        self.assertEqual(database.format_location_english("Top Rack Part 5", 1, 1), "Rack 10005 → Column 1 → On top of the rack")
        self.assertEqual(database.parse_rack_value("Top Rack Part 5"), 10005)

        # Verify existing record BK-10151 specifically cited in user specification
        conn = database.get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM books WHERE book_id = 'BK-10151'")
        book = dict(cursor.fetchone())
        conn.close()

        self.assertEqual(book["book_id"], "BK-10151")
        self.assertEqual(book["title"], "The One Plus One")
        self.assertEqual(book["author"], "Jojo Moyes")
        self.assertEqual(book["rack"], 50)
        self.assertEqual(book["column_num"], 1)
        self.assertEqual(book["position"], 1)
        self.assertEqual(book["location_english"], "Rack 50 → Column 1 → On top of the rack")
        self.assertEqual(book["status"], "Available")

    def test_03_add_individual_book_req1_1(self):
        """Req 1.1 & 1.4: Adds new book with unique collision-free ID and audit log entry."""
        title = "Agentic Systems Engineering"
        author = "Demis Hassabis"
        genre = "Computer Science / AI"
        rack = "Rack 12"
        col = "Column 2"
        pos = "3"

        res = database.add_book(
            title=title, author=author, genre=genre,
            rack=rack, column_num=col, position=pos,
            notes="Brand new copy"
        )

        self.assertTrue(res["book_id"].startswith("BK-"))
        self.assertEqual(res["title"], title)
        self.assertEqual(res["author"], author)
        self.assertEqual(res["location_english"], "Rack 12 → Column 2 → 3rd book from top")
        self.assertEqual(res["status"], "Available")

        # Verify audit log entry
        audit_logs = database.get_audit_history(book_id=res["book_id"])
        self.assertGreaterEqual(len(audit_logs), 1)
        self.assertEqual(audit_logs[0]["action"], "ADD_BOOK")

    def test_04_intelligent_search_3_tiers_req2(self):
        """
        Req 2.1 - 2.4:
        Intelligent search handling exact matches, typos, partial titles,
        authors, semantic topics, and 3-tier grouping.
        """
        # 1. Exact match
        res_exact = search_engine.search_books("The One Plus One")
        self.assertGreater(len(res_exact["exact_matches"]), 0)
        self.assertEqual(res_exact["exact_matches"][0]["title"], "The One Plus One")

        # 2. Typo tolerance
        res_typo = search_engine.search_books("The One Pluss One", include_fuzzy=True)
        self.assertGreater(len(res_typo["possible_matches"]), 0)
        self.assertEqual(res_typo["possible_matches"][0]["title"], "The One Plus One")

        # 3. Partial title
        res_partial = search_engine.search_books("One Plus One")
        self.assertGreater(len(res_partial["exact_matches"]), 0)

        # 4. Author search
        res_author = search_engine.search_books("Jojo Moyes")
        self.assertGreater(len(res_author["exact_matches"]), 0)

        # 5. Semantic niche topic query: "books about procrastination"
        res_semantic = search_engine.search_books("books about procrastination", include_recommendations=True)
        # Exact should be 0, but Related Books should return available stock
        self.assertEqual(len(res_semantic["exact_matches"]), 0)
        self.assertGreater(len(res_semantic["related_books"]), 0)

        # 6. Niche genre query: "Personal finance"
        res_finance = search_engine.search_books("Personal finance", include_recommendations=True)
        self.assertGreater(len(res_finance["related_books"]), 0)

        # 7. Search-as-you-type prefix match: "awaken the gi"
        res_prefix = search_engine.search_books("awaken the gi")
        self.assertGreater(len(res_prefix["exact_matches"]), 0)
        self.assertEqual(res_prefix["exact_matches"][0]["title"], "Awaken the Giant Within")

        # 8. Exact match filtering: "marketing" must not match "making" or "market"
        res_marketing = search_engine.search_books("marketing")
        titles = [b["title"] for b in res_marketing["exact_matches"]]
        self.assertTrue(all("marketing" in t.lower() for t in titles))
        self.assertFalse(any("making it heard" in t.lower() for t in titles))
        self.assertFalse(any("karl polanyi" in t.lower() for t in titles))

    def test_05_selling_workflow_req3(self):
        """
        Req 3.1 - 3.3:
        Selling workflow verifies copy is available, updates status to SOLD OUT,
        records transaction in sales sheet with Transaction Ref, and prevents double-sale.
        """
        # Find an available copy to sell
        conn = database.get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT book_id, title FROM books WHERE status = 'Available' AND book_id != 'BK-10151' LIMIT 1")
        target = dict(cursor.fetchone())
        conn.close()

        target_id = target["book_id"]

        # Step 1: Sell copy
        sale_res = database.sell_book(book_id=target_id, selling_price=19.99, user="Staff Tester", notes="Cash POS")
        self.assertTrue(sale_res["success"])
        self.assertTrue(sale_res["transaction_ref"].startswith("TX-"))
        self.assertEqual(sale_res["book"]["status"], "SOLD OUT")
        self.assertEqual(sale_res["selling_price"], 19.99)

        # Step 2: Concurrency check - Selling same copy again must be rejected!
        double_sale = database.sell_book(book_id=target_id, selling_price=19.99)
        self.assertIn("error", double_sale)
        self.assertIn("already marked as SOLD OUT", double_sale["error"])

        # Step 3: Verify sales transaction record
        sales = database.get_recent_sales(limit=10)
        recent_tx = next(s for s in sales if s["book_id"] == target_id)
        self.assertEqual(recent_tx["transaction_ref"], sale_res["transaction_ref"])
        self.assertEqual(recent_tx["selling_price"], 19.99)

    def test_05b_bulk_selling(self):
        """Test selling multiple books at once."""
        b1 = database.add_book(title="Multi Sell 1", author="Author A")
        b2 = database.add_book(title="Multi Sell 2", author="Author B")

        res = database.sell_books_bulk([
            {"book_id": b1["book_id"], "selling_price": 15.0},
            {"book_id": b2["book_id"], "selling_price": 25.0}
        ], shared_notes="Bulk Cash Sale")

        self.assertTrue(res["success"])
        self.assertEqual(res["count"], 2)
        self.assertEqual(res["total_amount"], 40.0)
        self.assertEqual(len(res["sold_books"]), 2)

        # Verify books status in DB
        conn = database.get_db_connection()
        c = conn.cursor()
        c.execute("SELECT status, selling_price FROM books WHERE book_id IN (?, ?)", (b1["book_id"], b2["book_id"]))
        rows = c.fetchall()
        conn.close()
        for r in rows:
            self.assertEqual(r["status"], "SOLD OUT")

    def test_05c_cancel_sale_and_return_to_shelf(self):
        """Test cancelling a sale and returning book to previous position or new position."""
        # 1. Add a book at a known location
        book = database.add_book(
            title="Returnable Novel",
            author="Author R",
            rack=15,
            column_num=2,
            position=4
        )
        book_id = book["book_id"]
        self.assertEqual(book["status"], "Available")
        self.assertEqual(book["rack"], 15)
        self.assertEqual(book["column_num"], 2)
        self.assertEqual(book["position"], 4)
        self.assertIn("Rack 15", book["location_english"])

        # 2. Sell the book
        sell_res = database.sell_book(book_id, selling_price=120.0, notes="Sold to customer")
        self.assertTrue(sell_res["success"])
        self.assertEqual(sell_res["book"]["status"], "SOLD OUT")
        self.assertEqual(sell_res["book"]["selling_price"], 120.0)

        # 3. Cancel sale & return to previous position
        return_prev = database.revert_sale(book_id, position_mode="previous", notes="Customer changed mind")
        self.assertTrue(return_prev["success"])
        self.assertEqual(return_prev["status"], "Available")
        self.assertEqual(return_prev["book"]["status"], "Available")
        self.assertIsNone(return_prev["book"]["selling_price"])
        self.assertEqual(return_prev["book"]["rack"], 15)
        self.assertEqual(return_prev["book"]["column_num"], 2)
        self.assertEqual(return_prev["book"]["position"], 4)
        self.assertIn("Rack 15", return_prev["book"]["location_english"])

        # 4. Sell the book again
        database.sell_book(book_id, selling_price=150.0, notes="Second sale")

        # 5. Cancel sale & return to a NEW position (e.g. Rack 42, Column 3, Position 7)
        return_new = database.revert_sale(
            book_id,
            position_mode="new",
            rack=42,
            column_num=3,
            position=7,
            refund_amount=150.0,
            notes="Relocated after return"
        )
        self.assertTrue(return_new["success"])
        self.assertEqual(return_new["book"]["status"], "Available")
        self.assertIsNone(return_new["book"]["selling_price"])
        self.assertEqual(return_new["book"]["rack"], 42)
        self.assertEqual(return_new["book"]["column_num"], 3)
        self.assertEqual(return_new["book"]["position"], 7)
        self.assertIn("Rack 42", return_new["book"]["location_english"])
        self.assertIn("Column 3", return_new["book"]["location_english"])
        self.assertIn("7th book from top", return_new["book"]["location_english"])

    def test_05d_update_sale_payment_without_returning(self):
        """Test correcting recorded sale payment (e.g. from 200 to 300) without returning to shelf."""
        # Add book and sell for 200
        book = database.add_book(title="Awaken the Giant Within", author="Anthony Robbins")
        book_id = book["book_id"]
        sell_res = database.sell_book(book_id, selling_price=200.0, notes="Cash sale")
        self.assertTrue(sell_res["success"])
        self.assertEqual(sell_res["book"]["status"], "SOLD OUT")
        self.assertEqual(sell_res["book"]["selling_price"], 200.0)

        # Update payment to 300
        up_res = database.update_sale_payment(book_id, selling_price=300.0, notes="Corrected price from 200 to 300")
        self.assertTrue(up_res["success"])
        self.assertEqual(up_res["old_price"], 200.0)
        self.assertEqual(up_res["new_price"], 300.0)
        self.assertEqual(up_res["adjustment"], 100.0)
        self.assertEqual(up_res["book"]["status"], "SOLD OUT")
        self.assertEqual(up_res["book"]["selling_price"], 300.0)

        # Verify transaction table
        conn = database.get_db_connection()
        c = conn.cursor()
        c.execute("SELECT selling_price FROM sales_transactions WHERE book_id = ?", (book_id,))
        tx_row = c.fetchone()
        self.assertEqual(tx_row["selling_price"], 300.0)

        # Verify audit log
        c.execute("SELECT action, notes FROM audit_log WHERE book_id = ? AND action = 'UPDATE_SALE_PAYMENT'", (book_id,))
        audit_row = c.fetchone()
        self.assertIsNotNone(audit_row)
        self.assertIn("Sale payment adjusted from ₹200 to ₹300", audit_row["notes"])
        conn.close()

    def test_06_unassigned_books_and_bulk_assignment_req1_7(self):
        """Req 1.7: Unassigned books section and bulk location assignment."""
        # Add 2 books with unassigned locations
        b1 = database.add_book(title="Unassigned Test 1", author="Author 1")
        b2 = database.add_book(title="Unassigned Test 2", author="Author 2")

        # Verify they appear in unassigned section
        unassigned_res = database.get_unassigned_books(query="Unassigned Test")
        unassigned_ids = [b["book_id"] for b in unassigned_res["books"]]
        self.assertIn(b1["book_id"], unassigned_ids)
        self.assertIn(b2["book_id"], unassigned_ids)

        # Bulk assign same location
        bulk_res = database.assign_location_bulk([
            {"book_id": b1["book_id"], "rack": "Rack 99", "column_num": "Column 1", "position": "1"},
            {"book_id": b2["book_id"], "rack": "Rack 99", "column_num": "Column 1", "position": "2"}
        ])
        self.assertTrue(bulk_res["success"])
        self.assertEqual(bulk_res["updated_count"], 2)

        # Verify English location assignment
        conn = database.get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT location_english FROM books WHERE book_id = ?", (b1["book_id"],))
        loc1 = cursor.fetchone()[0]
        self.assertEqual(loc1, "Rack 99 → Column 1 → On top of the rack")
        conn.close()

    def test_07_google_sheets_sync_outbox_req1_8(self):
        """Req 1.8: Verifies Outbox queue captures operations and flushes cleanly."""
        status = sheets_sync.get_sync_status()
        self.assertIn("spreadsheet_id", status)
        self.assertEqual(status["spreadsheet_id"], "1-b8dp2W_1z1BT_2vAxpAMYTIP68CiyQf5z-Hal33JrU")

        # Process outbox queue
        res = sheets_sync.process_outbox_queue()
        self.assertIn("synced_count", res)

        # Create timestamped snapshot backup
        backup_file = sheets_sync.create_local_backup()
        self.assertTrue(os.path.exists(backup_file))
        self.assertTrue(backup_file.endswith(".csv"))

    def test_08_delete_books_single_and_bulk(self):
        """Test deleting individual and multiple unassigned books."""
        b1 = database.add_book(title="Delete Candidate 1", author="Author A")
        b2 = database.add_book(title="Delete Candidate 2", author="Author B")
        b3 = database.add_book(title="Delete Candidate 3", author="Author C")

        # Test single delete
        del_res = database.delete_book(b1["book_id"])
        self.assertTrue(del_res["success"])
        self.assertEqual(del_res["book_id"], b1["book_id"])

        # Check it is removed from books table
        conn = database.get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM books WHERE book_id = ?", (b1["book_id"],))
        self.assertIsNone(cursor.fetchone())
        conn.close()

        # Test bulk delete
        bulk_del_res = database.delete_books_bulk([b2["book_id"], b3["book_id"]])
        self.assertTrue(bulk_del_res["success"])
        self.assertEqual(bulk_del_res["deleted_count"], 2)

        # Check both are gone
        conn = database.get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM books WHERE book_id IN (?, ?)", (b2["book_id"], b3["book_id"]))
        self.assertEqual(cursor.fetchone()[0], 0)
        conn.close()

    def test_ocr_ultralearning_extraction_no_garbage(self):
        """Verify that a noisy scan of a book like Ultralearning filters out blurbs, noise, and extracts clean Title & Author."""
        import ocr_engine

        noisy_ocr_text = """
        4 fa
        WALL STREET JOURNAL BESTSELLER
        "Ultralearning is fascinating..." - Cal Newport
        ULTRALEARNING
        MASTER HARD SKILLS OUTSMART THE COMPETITION AND ACCELERATE YOUR CAREER
        SCOTT H. YOUNG
        FOREWORD BY JAMES CLEAR
        HARPER BUSINESS
        1 z Wii
        474 Ih 3
        """

        cand = ocr_engine.extract_candidates_from_text(noisy_ocr_text)
        self.assertEqual(cand["title"], "Ultralearning")
        self.assertEqual(cand["author"], "Scott H. Young")
        self.assertFalse(cand["matched_existing"])
        self.assertNotIn("4 fa", cand["title"])
        self.assertNotIn("Wii", cand["title"])
        self.assertNotIn("Cal Newport", cand["title"])

    def test_search_by_author(self):
        """Verify searching specifically by author's name."""
        res_author = search_engine.search_books("Robbins", search_type="author")
        self.assertTrue(len(res_author["exact_matches"]) >= 1)
        for b in res_author["exact_matches"]:
            self.assertIn("robbins", b["author"].lower())

        # When searching specifically for "Robbins" as title, it should not match authors
        res_title = search_engine.search_books("Robbins", search_type="title")
        self.assertEqual(len(res_title["exact_matches"]), 0)

    def test_simple_genre_standardization(self):
        """Verifies simple genre classification and column presence in CSV and DB."""
        import genre_classifier

        # Test specific user cited cases
        self.assertEqual(genre_classifier.classify_common_genre("Indian Philosophy / Non-Western Philosophy"), "Philosophy")
        self.assertEqual(genre_classifier.classify_common_genre("Music History / Business"), "Music")
        self.assertEqual(genre_classifier.classify_common_genre("Tax Law / Real Estate Law"), "Law")
        self.assertEqual(genre_classifier.classify_common_genre("self-help"), "Self-Help")

        # Verify database books have simple_genre populated
        conn = database.get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT book_id, genre, simple_genre FROM books WHERE book_id IN ('BK-024', 'BK-481', 'BK-485')")
        rows = {r["book_id"]: dict(r) for r in cursor.fetchall()}
        conn.close()

        self.assertEqual(rows["BK-024"]["simple_genre"], "Philosophy")
        self.assertEqual(rows["BK-481"]["simple_genre"], "Music")
        self.assertEqual(rows["BK-485"]["simple_genre"], "Law")

    def test_genre_browsing_and_advisory(self):
        """Verifies genre browsing distribution and conversational recommendations."""
        # 1. Genre distribution
        dist = database.get_genre_distribution()
        self.assertGreaterEqual(len(dist), 18)
        genre_names = [d["simple_genre"] for d in dist]
        self.assertIn("Philosophy", genre_names)
        self.assertIn("Self-Help", genre_names)
        self.assertIn("Fiction", genre_names)

        # 2. Books by genre
        phil_books = database.get_books_by_genre("Philosophy", available_only=True)
        self.assertGreater(len(phil_books), 10)
        grouped = search_engine.group_physical_copies(phil_books)
        self.assertGreater(len(grouped), 10)

        # 3. Question: Japanese philosophical books
        res_jp = search_engine.ask_recommendations("i want some philosphical japanese books")
        self.assertGreater(len(res_jp["books"]), 0)
        top_titles = [b["title"].lower() for b in res_jp["books"][:5]]
        self.assertTrue(any("japanese" in t or "philosophy" in t or "zen" in t for t in top_titles))

        # 4. Question: Organizing and simple living
        res_org = search_engine.ask_recommendations("i need to get some books on organizing and simple living?")
        self.assertGreater(len(res_org["books"]), 0)
        org_titles = [b["title"].lower() for b in res_org["books"][:5]]
        self.assertTrue(any("things" in t or "living" in t or "minimal" in t or "order" in t or "habits" in t for t in org_titles))

    def test_workflow_b_stack_spine_detection(self):
        """Verifies Workflow B multi-spine stack extraction and candidate ordering."""
        stack_text = (
            "Awaken The Giant Within\nTony Robbins\n---\n"
            "Atomic Habits\nJames Clear\n---\n"
            "Physics by Computer\nKinzel and Reents"
        )
        candidates = ocr_engine.detect_multiple_books_in_image(
            raw_text_blocks=[stack_text]
        )
        self.assertEqual(len(candidates), 3)
        self.assertEqual(candidates[0]["position"], 1)
        self.assertIn("Awaken the Giant Within", candidates[0]["title"])
        self.assertTrue(candidates[0]["matched_existing"])
        self.assertEqual(candidates[1]["position"], 2)
        self.assertEqual(candidates[2]["position"], 3)

    def test_book_cover_resolution_and_caching(self):
        """Verifies dynamic cover lookup and persistent caching in SQLite."""
        target_title = "The Road to Vietnam"
        mock_cover = "https://covers.openlibrary.org/b/id/10156205-M.jpg"

        # Pre-seed cover cache in SQLite for existing book
        conn = database.get_db_connection()
        cursor = conn.cursor()
        cursor.execute("UPDATE books SET image_url = ? WHERE lower(title) = ?", (mock_cover, target_title.lower()))
        conn.commit()
        conn.close()

        cover = database.get_or_fetch_book_cover(target_title)
        self.assertTrue(bool(cover))
        self.assertTrue(cover.startswith("http"))
        self.assertEqual(cover, mock_cover)

        # Verify search_engine returns image_url
        res = search_engine.search_books(target_title)
        self.assertGreater(len(res["exact_matches"]), 0)
        self.assertEqual(res["exact_matches"][0]["image_url"], mock_cover)

    def test_llm_genre_prediction_and_auto_assignment(self):
        """Verifies predict_genre_with_llm and automatic assignment in add_book."""
        # 1. Existing title in inventory
        g = ocr_engine.predict_genre_with_llm("The Road to Vietnam")
        self.assertTrue(bool(g))

        # 2. Add book with empty genre -> backend automatically predicts and assigns genre
        new_book = database.add_book(
            title="Introduction to Quantum Mechanics",
            author="David J. Griffiths",
            genre=""  # Left blank to trigger LLM/rule prediction
        )
        self.assertTrue(bool(new_book["genre"]))

if __name__ == "__main__":
    unittest.main()


