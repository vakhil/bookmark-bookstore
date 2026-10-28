import unittest
import zipfile
import io
import export_manager
import database

class TestExportManager(unittest.TestCase):
    def test_database_xlsx_export(self):
        """Verifies full database .xlsx export creates valid multi-sheet workbook."""
        xlsx_bytes = export_manager.generate_database_xlsx()
        self.assertGreater(len(xlsx_bytes), 10000)
        
        # Verify valid zip and contents
        zf = zipfile.ZipFile(io.BytesIO(xlsx_bytes))
        self.assertIsNone(zf.testzip())
        
        file_list = zf.namelist()
        self.assertIn("[Content_Types].xml", file_list)
        self.assertIn("xl/workbook.xml", file_list)
        self.assertIn("xl/worksheets/sheet1.xml", file_list)
        self.assertIn("xl/worksheets/sheet2.xml", file_list)
        self.assertIn("xl/worksheets/sheet3.xml", file_list)
        
        wb_content = zf.read("xl/workbook.xml").decode("utf-8")
        self.assertIn('name="Inventory"', wb_content)
        self.assertIn('name="Sales_Transactions"', wb_content)
        self.assertIn('name="Store_Summary"', wb_content)

    def test_inventory_csv_export(self):
        """Verifies inventory CSV export has UTF-8 BOM and correct headers."""
        csv_bytes = export_manager.generate_inventory_csv()
        self.assertTrue(csv_bytes.startswith(b'\xef\xbb\xbf'))  # UTF-8 BOM
        text = csv_bytes.decode('utf-8-sig')
        lines = text.splitlines()
        self.assertGreater(len(lines), 5000)
        self.assertIn("Book ID", lines[0])
        self.assertIn("Title", lines[0])
        self.assertIn("Status", lines[0])

    def test_sales_csv_export(self):
        """Verifies sales CSV export has UTF-8 BOM and correct headers."""
        csv_bytes = export_manager.generate_sales_csv()
        self.assertTrue(csv_bytes.startswith(b'\xef\xbb\xbf'))
        text = csv_bytes.decode('utf-8-sig')
        lines = text.splitlines()
        self.assertIn("Transaction Ref", lines[0])

if __name__ == "__main__":
    unittest.main()
