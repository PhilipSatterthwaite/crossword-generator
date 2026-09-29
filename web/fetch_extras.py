"""Download the extra word data the Word lists and Train pages use, keeping only the site's words.

Run: python web/fetch_extras.py [xd] [wiki] [spoken] [wiktionary]   (all four when none is named)

Each source is streamed and boiled down to a small file in compileWords/, one line per list word
that the source has, for build_words.py to fold into web/wordstats.js:

- xd-uses.tsv       Saul Pwanson's xd crossword corpus (https://xd.saul.pw/data, about 90 MB): per
                    word, its uses as an answer in the LA Times, Wall Street Journal, USA Today, New
                    Yorker, Universal and Newsday puzzles and in everything else (indies, older
                    papers), how many outlets have used it, and how many different clues it has had.
- wiki-titles.tsv   English Wikipedia's article titles (dumps.wikimedia.org, about 110 MB): how many
                    articles have a title that runs together to the word (CHARACTERRECOGNITION, 1).
- spoken.tsv        Spoken English: SUBTLEX-US (film and TV subtitles, Brysbaert and New) and the
                    OpenSubtitles 2018 frequency list (hermitdave/FrequencyWords): counts per word.
- wiktionary.tsv    The English Wiktionary, as extracted by kaikki.org (about 3.3 GB, never saved):
                    per word, a bitset of what it is (see FLAGS) and its first definition.
"""
import csv
import io
import json
import re
import sys
import time
import unicodedata
import urllib.request
import zipfile
from pathlib import Path

WEB = Path(__file__).parent
OUT = WEB.parent / "compileWords"

URLS = {
    "xd": "https://xd.saul.pw/xd-clues.zip",
    "wiki": "https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-all-titles-in-ns0.gz",
    "subtlex": "https://www.ugent.be/pp/experimentele-psychologie/en/research/documents/subtlexus/subtlexus2.zip",
    "opensubs": "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_full.txt",
    "wiktionary": "https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl",
}
# The outlets counted on their own; every other xd publication counts as "other".
OUTLETS = ["lat", "wsj", "usa", "tny", "up", "nw"]
# A definition that only sends the reader to another entry.
REDIRECT = re.compile(r"^(alternative|obsolete|archaic|dated|rare|nonstandard|informal)?\s*(letter-case |spelling |typography )?(form|spelling|case form|letter-case form) of|^synonym of\b", re.I)
# A definition that says what an abbreviation stands for.
SPELLS_OUT = re.compile(r"^(acronym|initialism|abbreviation|contraction|clipping) of\b", re.I)
# Wiktionary flags, one bit each.
FLAGS = ["listed", "noun", "verb", "adjective", "adverb", "proper", "phrase", "abbreviation", "dated",
         "informal", "offensive", "rare", "inflection"]


def log(message):
    print(time.strftime("%H:%M:%S"), message, flush=True)


def letters(text):
    """Text as the grid would hold it: accents off, letters only, uppercase."""
    text = unicodedata.normalize("NFKD", text)
    return re.sub(r"[^A-Z]", "", text.upper())


def list_words():
    src = (WEB / "words.js").read_text(encoding="utf-8")
    start = src.index("GRIDFILL_WORDS = ") + len("GRIDFILL_WORDS = ")
    data = json.loads(src[start: src.rindex(";")])
    words = set()
    for key, entry in data.items():
        n = int(key)
        for i in range(len(entry[0]) // n):
            words.add(entry[0][i * n:(i + 1) * n])
    return words


def fetch(url):
    """The download as a stream. Through curl, which checks certificates against the system's own
    store; Python's bundled store can be out of date and reject sites that are fine."""
    import subprocess
    proc = subprocess.Popen(["curl", "-sSfL", "--retry", "3", "-A", "fillmein word build (fillmein.org)", url],
                            stdout=subprocess.PIPE)
    return proc.stdout


def write(name, header, rows):
    path = OUT / name
    with path.open("w", encoding="utf-8", newline="\n") as out:
        out.write("\t".join(header) + "\n")
        for row in rows:
            out.write("\t".join(str(x) for x in row) + "\n")
    log(f"wrote {path} ({path.stat().st_size // 1024} KB)")


def do_xd(words):
    log("xd: downloading")
    raw = fetch(URLS["xd"]).read()
    uses = {}      # word -> [count per OUTLET..., other]
    outlets = {}   # word -> set of pubids
    clues = {}     # word -> set of clue texts
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        name = next(n for n in zf.namelist() if n.endswith("clues.tsv"))
        with zf.open(name) as fh:
            reader = io.TextIOWrapper(fh, encoding="utf-8", errors="replace")
            next(reader)
            for line in reader:
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 4:
                    continue
                pub, word = parts[0], letters(parts[2])
                if word not in words:
                    continue
                counts = uses.setdefault(word, [0] * (len(OUTLETS) + 1))
                counts[OUTLETS.index(pub) if pub in OUTLETS else len(OUTLETS)] += 0 if pub == "nyt" else 1
                outlets.setdefault(word, set()).add(pub)
                clues.setdefault(word, set()).add(re.sub(r"[^a-z0-9 ]", "", parts[3].lower()).strip())
    rows = [[w, *uses[w], len(outlets[w]), len(clues[w])] for w in sorted(uses)]
    write("xd-uses.tsv", ["word", *OUTLETS, "other", "outlets", "clues"], rows)


def do_wiki(words):
    log("wiki: downloading titles")
    import gzip
    counts = {}
    with fetch(URLS["wiki"]) as response, gzip.GzipFile(fileobj=response) as raw:
        for line in io.TextIOWrapper(raw, encoding="utf-8", errors="replace"):
            word = letters(line.replace("_", " "))
            if word in words:
                counts[word] = counts.get(word, 0) + 1
    write("wiki-titles.tsv", ["word", "titles"], sorted(counts.items()))


def do_spoken(words):
    log("spoken: downloading SUBTLEX-US and OpenSubtitles")
    subtlex = {}
    with zipfile.ZipFile(io.BytesIO(fetch(URLS["subtlex"]).read())) as zf:
        name = next(n for n in zf.namelist() if n.lower().endswith(".txt"))
        text = zf.read(name).decode("utf-8", errors="replace").splitlines()
        head = text[0].split("\t")
        col = head.index("FREQcount")
        for line in text[1:]:
            parts = line.split("\t")
            word = letters(parts[0])
            if word in words and parts[col].isdigit():
                subtlex[word] = subtlex.get(word, 0) + int(parts[col])
    opensubs = {}
    for line in fetch(URLS["opensubs"]).read().decode("utf-8", errors="replace").splitlines():
        parts = line.split(" ")
        if len(parts) == 2 and parts[1].isdigit():
            word = letters(parts[0])
            if word in words:
                opensubs[word] = opensubs.get(word, 0) + int(parts[1])
    rows = [[w, subtlex.get(w, 0), opensubs.get(w, 0)] for w in sorted(set(subtlex) | set(opensubs))]
    write("spoken.tsv", ["word", "subtlex", "opensubtitles"], rows)


def do_wiktionary(words):
    log("wiktionary: streaming the kaikki.org English extract")
    flags = {}
    gloss = {}
    lines = 0
    bit = {name: 1 << i for i, name in enumerate(FLAGS)}
    pos_bits = {"noun": "noun", "verb": "verb", "adj": "adjective", "adv": "adverb", "name": "proper",
                "phrase": "phrase", "prep_phrase": "phrase", "proverb": "phrase", "abbrev": "abbreviation"}
    tag_bits = {"abbreviation": "abbreviation", "initialism": "abbreviation", "acronym": "abbreviation",
                "obsolete": "dated", "archaic": "dated", "dated": "dated", "slang": "informal",
                "informal": "informal", "colloquial": "informal", "vulgar": "offensive",
                "offensive": "offensive", "derogatory": "offensive", "slur": "offensive", "rare": "rare"}
    with fetch(URLS["wiktionary"]) as response:
        for line in io.TextIOWrapper(response, encoding="utf-8", errors="replace"):
            lines += 1
            if lines % 200000 == 0:
                log(f"wiktionary: {lines:,} entries, {len(flags):,} list words found")
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            raw_word = entry.get("word", "")
            word = letters(raw_word)
            if word not in words:
                continue
            pos = entry.get("pos", "")
            # Pieces of words ("-erie", "pre-") and symbols run together to list words but aren't them.
            stripped = raw_word.strip()
            if pos in ("suffix", "prefix", "infix", "affix", "interfix", "circumfix", "character", "symbol") or stripped.startswith("-") or stripped.endswith("-"):
                continue
            value = flags.get(word, 0) | bit["listed"]
            if pos in pos_bits:
                value |= bit[pos_bits[pos]]
            if " " in raw_word.strip():
                value |= bit["phrase"]
            first = None
            only_forms = True
            for sense in entry.get("senses", []):
                for tag in sense.get("tags", []):
                    if tag in tag_bits:
                        value |= bit[tag_bits[tag]]
                glosses = sense.get("glosses") or []
                # An abbreviation's sense is filed as a form of what it stands for, which is its meaning.
                spells_out = bool(glosses) and SPELLS_OUT.match(glosses[0])
                if (sense.get("form_of") or "form-of" in sense.get("tags", [])) and not spells_out:
                    continue
                # "Alternative letter-case form of Oreo" and the like point elsewhere and define nothing.
                if (sense.get("alt_of") or "alt-of" in sense.get("tags", [])) and not spells_out:
                    continue
                glosses = sense.get("glosses") or []
                if glosses and REDIRECT.match(glosses[0]):
                    continue
                only_forms = False
                if first is None and sense.get("glosses"):
                    first = sense["glosses"][0]
            if only_forms and entry.get("senses"):
                value |= bit["inflection"]
            flags[word] = value
            # The definition shown is the plainest reading's: the lowercase word (oreo), then a name
            # (Erie), then a phrase, then an abbreviation (ELI); the first found of the best kind.
            if first:
                if " " in stripped or "-" in stripped:
                    rank = 2
                elif stripped.islower():
                    rank = 0
                elif stripped[:1].isupper() and stripped[1:].islower():
                    rank = 1
                else:
                    rank = 3
                if word not in gloss or rank < gloss[word][0]:
                    gloss[word] = (rank, re.sub(r"\s+", " ", first).strip()[:120])
    rows = [[w, flags[w], gloss[w][1].replace("\t", " ") if w in gloss else ""] for w in sorted(flags)]
    write("wiktionary.tsv", ["word", "flags", "gloss"], rows)
    log(f"wiktionary: done, {lines:,} entries read")


def main():
    wanted = sys.argv[1:] or ["xd", "wiki", "spoken", "wiktionary"]
    words = list_words()
    log(f"{len(words):,} list words")
    for name in wanted:
        {"xd": do_xd, "wiki": do_wiki, "spoken": do_spoken, "wiktionary": do_wiktionary}[name](words)
    log("all done")


if __name__ == "__main__":
    main()
