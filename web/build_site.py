"""Build docs/: a standalone copy of the web page for static hosting. GitHub Pages serves it
from the main branch's docs/ folder at https://fillmein.org.

Run: python web/build_site.py

web/grid.html is written for claude.ai artifacts, which wrap the page in <!doctype html>,
<head> and <body> and add a small reset (including [hidden] { display: none !important }).
This adds that wrapper so the page renders the same anywhere, and copies the other pages
(the home page index.html, clues.html, export.html), the scripts and the word list next to it.
"""

import base64
import hashlib
import re
import shutil
from pathlib import Path

HERE = Path(__file__).parent
SITE = HERE.parent / "docs"
DOMAIN = "fillmein.org"
PAGE_START = '<div class="page">'
# explore.html is written but not shipped: puzzles will be chosen for it later, rather than every
# shared puzzle appearing there.
PAGES = ("index.html", "puzzles.html", "clues.html", "export.html", "solve.html")
# Scripts and stylesheets the pages load, copied as they are and referenced with a version stamp.
ASSETS = ("theme.css", "store.js", "account.js", "confirm.js", "lists.js", "lists-sync.js", "filler.js", "exporters.js", "words.js")

# What each page may load, as a Content-Security-Policy in a <meta> tag (GitHub Pages sets no headers).
# Scripts: the site's own, Firebase from gstatic, Analytics from googletagmanager, and each page's inline
# script by its hash, so an inline handler such as onerror= in someone's text could never run. Styles
# allow inline because the pages set them from script (a cell's position, a grid's column count).
CSP = (
    "default-src 'self'; "
    "script-src 'self' https://www.gstatic.com https://www.googletagmanager.com {hashes}; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src https://fonts.gstatic.com; "
    "img-src 'self' data: https://*.google-analytics.com https://*.googletagmanager.com; "
    "connect-src 'self' https://*.googleapis.com https://*.google-analytics.com https://*.analytics.google.com "
    "https://*.googletagmanager.com https://*.firebaseio.com wss://*.firebaseio.com; "
    "frame-src 'self' https://fillmein-87a2d.firebaseapp.com https://accounts.google.com; "
    "worker-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'"
)
INLINE_SCRIPT = re.compile(rb"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", re.DOTALL)

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


def secure(path):
    """Put the policy in a page, naming each of its inline scripts by hash."""
    page = path.read_bytes()
    hashes = []
    for block in INLINE_SCRIPT.findall(page):
        # The browser hashes the script as its parser saw it, with Windows line endings already folded.
        digest = hashlib.sha256(block.replace(b"\r\n", b"\n")).digest()
        hashes.append(f"'sha256-{base64.b64encode(digest).decode()}'")
    marker = b'<meta charset="utf-8">'
    if marker not in page:
        raise SystemExit(f"{path} has no charset meta to put the policy after")
    newline = b"\r\n" if b"\r\n" in page else b"\n"
    meta = f'<meta http-equiv="Content-Security-Policy" content="{CSP.format(hashes=" ".join(hashes))}">'.encode()
    path.write_bytes(page.replace(marker, marker + newline + meta, 1))


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
        secure(path)  # after stamping: the hashes must match the inline scripts as finally written
    (SITE / ".nojekyll").write_text("", encoding="utf-8")  # serve files as-is on GitHub Pages, __/ included

    # Firebase's sign-in helper pages (web/__/auth/), served from the site's own domain so Google's
    # account chooser says "continue to fillmein.org" (account.js sets authDomain to it). GitHub Pages
    # serves /__/auth/handler from handler.html. They're copies of the files at
    # https://fillmein-87a2d.firebaseapp.com/__/auth/{handler,handler.js,experiments.js,iframe,iframe.js};
    # refresh them from there now and then.
    shutil.copytree(HERE / "__", SITE / "__", dirs_exist_ok=True)
    (SITE / "CNAME").write_text(f"{DOMAIN}\n", encoding="utf-8")  # the domain GitHub Pages serves it at

    # The site used to live at philipsatterthwaite.github.io/crossword-generator/docs/, and GitHub forwards
    # that address to the same path on the domain, so old links land in docs/docs/: send them on.
    moved = SITE / "docs"
    shutil.rmtree(moved, ignore_errors=True)  # a stub for a page that no longer ships shouldn't linger
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
