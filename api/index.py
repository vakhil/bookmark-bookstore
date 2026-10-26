import os
import sys

# Ensure parent directory is in sys.path so modules (database, search_engine, etc.) can be loaded
parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from server import BookstoreAPIHandler

class handler(BookstoreAPIHandler):
    """Vercel Serverless Function entry point."""
    pass
