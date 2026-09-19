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
from html import escape
from pathlib import Path

HERE = Path(__file__).parent
SITE = HERE.parent / "docs"
DOMAIN = "fillmein.org"
PAGE_START = '<div class="page">'
# explore.html is written but not shipped: puzzles will be chosen for it later, rather than every
# shared puzzle appearing there.
PAGES = ("index.html", "puzzles.html", "clues.html", "export.html", "solve.html", "privacy.html",
         "contact.html", "guide.html", "404.html")
# Scripts, stylesheets and the social-preview image the pages load, copied as they are and referenced
# with a version stamp.
ASSETS = ("theme.css", "store.js", "account.js", "confirm.js", "lists.js", "lists-sync.js", "filler.js",
          "exporters.js", "importers.js", "words.js", "social.png",
          "favicon.svg", "favicon.png", "apple-touch-icon.png")
# What each page may load, as a Content-Security-Policy in a <meta> tag (GitHub Pages sets no headers).
# Scripts: the site's own, Firebase from gstatic, Google's api.js from apis.google.com (Firebase loads it
# into the page to run the sign-in popup; without it sign-in fails with auth/internal-error), and each
# page's inline script by its hash, so an inline
# handler such as onerror= in someone's text could never run. Styles allow inline because the pages set
# them from script (a cell's position, a grid's column count).
CSP = (
    "default-src 'self'; "
    "script-src 'self' https://www.gstatic.com https://apis.google.com{counting_script} {hashes}; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src https://fonts.gstatic.com; "
    "img-src 'self' data:{counting_img}; "
    "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com{counting_connect}; "
    "frame-src 'self' https://fillmein.org https://fillmein-87a2d.firebaseapp.com https://accounts.google.com; "
    "worker-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'"
)
# Counting visitors: Google Analytics, loaded by account.js, and the beacon Cloudflare puts in the page
# itself when Web Analytics is on for the domain. Both are left out of the solve page's policy, so the id
# of a puzzle shared privately by link reaches neither of them. (Cloudflare still adds its beacon to that
# page; the policy is what stops it running, which the browser console says on every visit. Excluding
# /solve.html in the Cloudflare dashboard as well would keep that console quiet.)
COUNTING = {
    "counting_script": " https://www.googletagmanager.com https://static.cloudflareinsights.com",
    "counting_img": " https://*.google-analytics.com https://*.googletagmanager.com",
    "counting_connect": " https://*.google-analytics.com https://*.analytics.google.com"
                        " https://*.googletagmanager.com https://cloudflareinsights.com",
}
UNCOUNTED = {key: "" for key in COUNTING}
INLINE_SCRIPT = re.compile(rb"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", re.DOTALL)

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="icon" href="favicon.png" sizes="192x192">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
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
    counting = UNCOUNTED if path.name == "solve.html" else COUNTING
    policy = CSP.format(hashes=" ".join(hashes), **counting)
    meta = f'<meta http-equiv="Content-Security-Policy" content="{policy}">'.encode()
    path.write_bytes(page.replace(marker, marker + newline + meta, 1))


# --- the site's words, kept in web/text.md so they can be edited without touching the pages ---

TEXT = HERE / "text.md"
KEY = re.compile(r"^\[([a-z0-9][a-z0-9.-]*)\]\s*$")
# {{key}} in a page becomes that block of text.md, paragraphs and all. {{key|line}} becomes the words
# on their own, for text already inside a <p> or a <span>. {{key|plain}} strips the markup too, for a
# title or a meta tag. A {{key}} alone on a line keeps that line's indentation.
ALONE = re.compile(r"^([ \t]*)\{\{([a-z0-9][a-z0-9.-]*)\}\}[ \t]*$", re.MULTILINE)
INSIDE = re.compile(r"\{\{([a-z0-9][a-z0-9.-]*)(?:\|(plain|line))?\}\}")
BOTH = re.compile(r"\*\*\*(.+?)\*\*\*")
BOLD = re.compile(r"\*\*(.+?)\*\*")
# One asterisk each side, not two: *italic*, where **bold** has already been dealt with.
ITALIC = re.compile(r"(?<![*\w])\*(?![\s*])(.+?)(?<![\s*])\*(?![*\w])")
LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")


def read_words():
    """text.md as {key: the lines written under [key]}."""
    words, key, lines = {}, None, []
    for number, raw in enumerate(TEXT.read_text(encoding="utf-8").splitlines(), 1):
        if raw.startswith("//"):
            continue  # a note to whoever is editing; it never reaches the site
        found = KEY.match(raw)
        if found:
            if key:
                words[key] = "\n".join(lines).strip("\n")
            key, lines = found.group(1), []
            if key in words:
                raise SystemExit(f"text.md line {number}: [{key}] is used twice")
        elif key is not None:
            lines.append(raw)
        elif raw.strip():
            raise SystemExit(f"text.md line {number}: words before the first [key]")
    if key:
        words[key] = "\n".join(lines).strip("\n")
    return words


def inline(text):
    """**bold**, *italic*, ***both*** and [a link](where.html), within a line."""
    linked = LINK.sub(lambda m: f'<a href="{m.group(2)}">{m.group(1)}</a>', text)
    both = BOTH.sub(lambda m: f"<b><i>{m.group(1)}</i></b>", linked)
    bold = BOLD.sub(lambda m: f"<b>{m.group(1)}</b>", both)
    return ITALIC.sub(lambda m: f"<i>{m.group(1)}</i>", bold)


def slug(text):
    """A heading's name as an address to link to."""
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def render(block):
    """A block of text.md as HTML. A blank line starts a new paragraph. A run of lines each starting
    "- " is a list. "## " and "### " are headings, and [[contents]] is a list of this block's "## "
    headings. A paragraph that starts with "<" is markup already and is passed through untouched."""
    headings = [line[3:].strip() for line in block.splitlines() if line.startswith("## ")]
    contents = "".join(f'<li><a href="#{slug(h)}">{inline(h)}</a></li>' for h in headings)
    out = []
    for para in re.split(r"\n[ \t]*\n", block):
        lines = [line for line in para.split("\n") if line.strip()]
        if not lines:
            continue
        first = lines[0]
        if first.lstrip().startswith("<"):
            out.append("\n".join(lines))
        elif first.strip() == "[[contents]]":
            out.append(f"<ol>{contents}</ol>")
        elif all(line.startswith("- ") for line in lines):
            out.append("<ul>" + "".join(f"<li>{inline(line[2:].strip())}</li>" for line in lines) + "</ul>")
        elif first.startswith("## "):
            title = " ".join(line.strip() for line in lines)[3:].strip()
            out.append(f'<h2 id="{slug(title)}">{inline(title)}</h2>')
        elif first.startswith("### "):
            title = " ".join(line.strip() for line in lines)[4:].strip()
            out.append(f"<h3>{inline(title)}</h3>")
        else:
            out.append("<p>" + inline(" ".join(line.strip() for line in lines)) + "</p>")
    return "\n".join(out)


def plain(block):
    """A block as one line of words, safe inside an attribute."""
    text = " ".join(line.strip() for line in block.splitlines() if line.strip())
    bare = LINK.sub(lambda m: m.group(1), text)
    for rule in (BOTH, BOLD, ITALIC):
        bare = rule.sub(lambda m: m.group(1), bare)
    return escape(bare, quote=True)


def say(text, words, used, where):
    """Put the words into a page, in place of its {{key}} marks."""
    def find(key):
        if key not in words:
            raise SystemExit(f"{where}: there is no [{key}] in text.md")
        used.add(key)
        return words[key]

    def whole_line(match):
        indent, key = match.group(1), match.group(2)
        return "\n".join(indent + line for line in render(find(key)).split("\n"))

    def within(match):
        block = find(match.group(1))
        how = match.group(2)
        if how == "plain":
            return plain(block)
        if how == "line":
            return inline(" ".join(line.strip() for line in block.splitlines() if line.strip()))
        return render(block)

    return INSIDE.sub(within, ALONE.sub(whole_line, text))


def stamp(text, versions):
    """Every quoted reference to a versioned file, as "name?v=hash" (404.html spells them from the root)."""
    for name, digest in versions.items():
        text = text.replace(f'"{name}"', f'"{name}?v={digest}"').replace(f'"/{name}"', f'"/{name}?v={digest}"')
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
    # The words live in text.md; each page carries {{key}} marks saying where its blocks go.
    words, used = read_words(), set()
    for name in PAGES + ("grid.html",):
        path = SITE / name
        path.write_text(say(path.read_text(encoding="utf-8"), words, used, name), encoding="utf-8")
    spare = sorted(set(words) - used)
    if spare:
        print(f"text.md: {len(spare)} unused ({', '.join(spare)})")

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
        if name == "404.html":
            continue
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
