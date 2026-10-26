import os
import sys

# Ensure parent directory is in sys.path so modules can be imported
parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

import database
from server import BookstoreAPIHandler

# Ensure database is primed on serverless cold-start
try:
    database.ensure_database_ready()
except Exception as e:
    print(f"Serverless DB ready notice: {e}")

class handler(BookstoreAPIHandler):
    """Vercel Serverless Function entry point."""
    pass
