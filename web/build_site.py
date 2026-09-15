"""Build docs/: a standalone copy of the web page for static hosting. GitHub Pages serves it
from the main branch's docs/ folder.

Run: python web/build_site.py

web/index.html is written for claude.ai artifacts, which wrap the page in <!doctype html>,
<head> and <body> and add a small reset (including [hidden] { display: none !important },
which the preview bar relies on). This adds that wrapper so the page renders the same
anywhere, and copies the scripts and word list next to it.
"""

import shutil
from pathlib import Path

HERE = Path(__file__).parent
SITE = HERE.parent / "docs"
PAGE_START = '<div class="page">'

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>✏️</text></svg>">
<style>
  body { margin: 0; }
  img { max-width: 100%; }
  [hidden] { display: none !important; }
</style>
"""


def main():
    page = (HERE / "index.html").read_text(encoding="utf-8")
    head, marker, body = page.partition(PAGE_START)
    if not marker:
        raise SystemExit(f"web/index.html has no {PAGE_START} to split the head from the body")

    SITE.mkdir(exist_ok=True)
    (SITE / "index.html").write_text(f"{HEAD}{head}</head>\n<body>\n{marker}{body}</body>\n</html>\n", encoding="utf-8")
    for name in ("filler.js", "exporters.js", "worker.js", "words.js"):
        shutil.copyfile(HERE / name, SITE / name)
    (SITE / ".nojekyll").write_text("", encoding="utf-8")  # serve files as-is on GitHub Pages
    size = sum(p.stat().st_size for p in SITE.iterdir() if p.is_file())
    print(f"built {SITE} ({size // 1024} KB)")


if __name__ == "__main__":
    main()
