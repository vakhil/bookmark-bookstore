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

        # Verify existing record BK-10151 specifically cited in user specification
        conn = database.get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM books WHERE book_id = 'BK-10151'")
        book = dict(cursor.fetchone())
        conn.close()

        self.assertEqual(book["book_id"], "BK-10151")
        self.assertEqual(book["title"], "The One Plus One")
        self.assertEqual(book["author"], "Jojo Moyes")
        self.assertEqual(book["rack"], "Rack 50")
        self.assertEqual(book["column_num"], "Column 1")
        self.assertEqual(book["position"], "1")
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

if __name__ == "__main__":
    unittest.main()


