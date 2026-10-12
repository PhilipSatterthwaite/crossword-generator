"""Serve the built site (docs/) on this computer the way GitHub Pages serves it: /grid answers with
grid.html, since the site's links leave ".html" off.

Run: python web/serve_site.py [port]   (8765 when none is given), then open http://localhost:8765/
"""
import http.server
import os
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent / "docs"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def translate_path(self, path):
        full = super().translate_path(path)
        if not os.path.exists(full) and os.path.exists(full + ".html"):
            return full + ".html"
        return full


if __name__ == "__main__":
    print(f"serving {ROOT} at http://localhost:{PORT}/")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
