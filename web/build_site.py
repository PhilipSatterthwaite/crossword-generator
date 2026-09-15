"""Build docs/: a standalone copy of the web page for static hosting. GitHub Pages serves it
from the main branch's docs/ folder at https://fillmein.org.

Run: python web/build_site.py

web/grid.html is written for claude.ai artifacts, which wrap the page in <!doctype html>,
<head> and <body> and add a small reset (including [hidden] { display: none !important }).
This adds that wrapper so the page renders the same anywhere, and copies the other pages
(the home page index.html, clues.html, export.html), the scripts and the word list next to it.
"""

import hashlib
import shutil
from pathlib import Path

HERE = Path(__file__).parent
SITE = HERE.parent / "docs"
DOMAIN = "fillmein.org"
PAGE_START = '<div class="page">'
PAGES = ("index.html", "clues.html", "export.html")
# Scripts and stylesheets the pages load, copied as they are and referenced with a version stamp.
ASSETS = ("theme.css", "store.js", "account.js", "filler.js", "exporters.js", "words.js")

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


def version(path):
    """A short hash of a file's bytes."""
    return hashlib.sha256(path.read_bytes()).hexdigest()[:10]


def stamp(text, versions):
    """Every quoted reference to a versioned file, as "name?v=hash"."""
    for name, digest in versions.items():
        text = text.replace(f'"{name}"', f'"{name}?v={digest}"')
    return text


def main():
    page = (HERE / "grid.html").read_text(encoding="utf-8")
    head, marker, body = page.partition(PAGE_START)
    if not marker:
        raise SystemExit(f"web/grid.html has no {PAGE_START} to split the head from the body")

    SITE.mkdir(exist_ok=True)
    (SITE / "grid.html").write_text(f"{HEAD}{head}</head>\n<body>\n{marker}{body}</body>\n</html>\n", encoding="utf-8")
    # The other pages are complete documents already; only grid.html needs the wrapper.
    for name in PAGES + ASSETS:
        shutil.copyfile(HERE / name, SITE / name)

    # Stamp every script and stylesheet reference with its content's hash (store.js?v=3f9a...). The CDN
    # tells browsers to keep scripts for hours but pages for minutes, so without this a browser can pair a
    # new page with an old script; a changed file now gets a new address.
    versions = {name: version(SITE / name) for name in ASSETS}
    worker = stamp((HERE / "worker.js").read_text(encoding="utf-8"), versions)
    (SITE / "worker.js").write_text(worker, encoding="utf-8")
    versions["worker.js"] = version(SITE / "worker.js")
    for name in PAGES + ("grid.html",):
        path = SITE / name
        path.write_text(stamp(path.read_text(encoding="utf-8"), versions), encoding="utf-8")
    (SITE / ".nojekyll").write_text("", encoding="utf-8")  # serve files as-is on GitHub Pages
    (SITE / "CNAME").write_text(f"{DOMAIN}\n", encoding="utf-8")  # the domain GitHub Pages serves it at

    # The site used to live at philipsatterthwaite.github.io/crossword-generator/docs/, and GitHub forwards
    # that address to the same path on the domain, so old links land in docs/docs/: send them on.
    moved = SITE / "docs"
    moved.mkdir(exist_ok=True)
    for name in PAGES:
        target = "/" if name == "index.html" else f"/{name}"
        (moved / name).write_text(
            f'<!doctype html>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0; url={target}">\n'
            f'<link rel="canonical" href="https://{DOMAIN}{target}">\n<title>This page has moved</title>\n'
            f'<a href="{target}">This page is now at {DOMAIN}{target}</a>\n',
            encoding="utf-8",
        )
    size = sum(p.stat().st_size for p in SITE.iterdir() if p.is_file())
    print(f"built {SITE} ({size // 1024} KB)")


if __name__ == "__main__":
    main()
