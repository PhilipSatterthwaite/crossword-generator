"""Build web/pastclues/: clues NYT puzzles have used for each answer, for the Clues page's suggestions.

Run: python web/build_clues.py path/to/clues.tsv
The source is clues.tsv from xd-clues.zip, Saul Pwanson's xd crossword corpus (https://xd.saul.pw/data):
one line per clue use, "pubid<TAB>year<TAB>answer<TAB>clue". Only the NYT's lines (pubid nyt) are used.

For each answer, the clues are tidied (see tidy), merged when they differ only in case and punctuation,
and the MOST_PER_ANSWER used most are kept, each as [text, times used, last year used]. Uses before
MODERN count OLD_WEIGHT as much as later ones, since today's clues read differently from the
crosswordese of the Maleska years; a tie goes to the clue used more recently. Clues that point at
other entries ("See 17-Across") mean nothing on their own and are left out.

Answers are split by their first two letters into files like pastclues/OR.json, so the Clues page
loads only the few kilobytes an entry needs.
"""

import argparse
import html
import json
import re
import shutil
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "pastclues"
MOST_PER_ANSWER = 20
MODERN = 1994       # Will Shortz's first year editing the NYT puzzle
OLD_WEIGHT = 0.3
LONGEST = 150  # characters; longer ones are puzzle notes, not clues
CROSS_REFERENCE = re.compile(r"\b\d+-(Across|Down)\b|^See\b.*\b\d+\b", re.I)
# Words whose period belongs to them, so a clue ending in one keeps it.
KEEPS_PERIOD = {"abbr", "inc", "co", "corp", "ltd", "jr", "sr", "st", "mr", "mrs", "ms", "dr", "etc", "bros",
                "vs", "ave", "mt", "no", "esq", "univ", "dept", "govt", "assn", "var", "pl", "sing", "fr", "sp",
                "ger", "lat", "gr", "it", "abbrs", "e.g", "i.e", "a.m", "p.m", "u.s", "d.c", "wm", "geo"}


def tidy(clue, year):
    """The clue as a constructor would type it, or "" to leave it out."""
    text = html.unescape(clue).strip()
    text = re.sub(r"\{/(.*?)/\}", r"\1", text)  # {/italics/} markup
    text = text.replace('""', '"')
    text = re.sub(r"^\*+\s*", "", text)  # the star on a theme clue
    text = re.sub(r"\s+", " ", text).strip()
    # Older puzzles end every clue with a period; today's don't, except after an abbreviation, so an
    # old clue loses its period unless its last word looks like one (short and lowercase: "org.").
    if year < MODERN and text.endswith(".") and not text.endswith(".."):
        last = text[:-1].rsplit(" ", 1)[-1].strip("(\"'")
        abbreviation = last.lower() in KEEPS_PERIOD or "." in last or (last.islower() and len(last) <= 4)
        if not abbreviation:
            text = text[:-1]
    if not text or len(text) > LONGEST or CROSS_REFERENCE.search(text):
        return ""
    return text


def same(text):
    """What two versions of one clue have in common."""
    return re.sub(r"[^a-z0-9_ ]", "", text.lower()).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", type=Path, help="clues.tsv from https://xd.saul.pw/xd-clues.zip")
    args = parser.parse_args()

    # answer -> merged clue -> [text as most often written, uses, last year, uses of that wording]
    found = defaultdict(dict)
    wordings = defaultdict(lambda: defaultdict(int))
    rows = 0
    with args.source.open(encoding="utf-8", errors="replace") as source:
        next(source)
        for line in source:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 4 or parts[0] != "nyt":
                continue
            answer = re.sub(r"[^A-Z]", "", parts[2].upper())
            year = int(parts[1]) if parts[1].isdigit() else 0
            text = tidy(parts[3], year)
            if len(answer) < 3 or not text:
                continue
            rows += 1
            key = same(text)
            entry = found[answer].setdefault(key, [text, 0, 0, 0.0])
            entry[1] += 1
            entry[2] = max(entry[2], year)
            entry[3] += 1 if year >= MODERN else OLD_WEIGHT
            # Keep the wording used most, the newest wording breaking a tie.
            wordings[(answer, key)][text] += 1
            if wordings[(answer, key)][text] > wordings[(answer, key)][entry[0]] or (
                    wordings[(answer, key)][text] == wordings[(answer, key)][entry[0]] and year >= entry[2]):
                entry[0] = text

    shards = defaultdict(dict)
    kept = 0
    for answer, clues in found.items():
        best = sorted(clues.values(), key=lambda e: (-e[3], -e[2], e[0]))[:MOST_PER_ANSWER]
        shards[answer[:2]][answer] = [[text, uses, year] for text, uses, year, _ in best]
        kept += len(best)

    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir()
    size = 0
    for prefix, answers in sorted(shards.items()):
        path = OUT / f"{prefix}.json"
        path.write_text(json.dumps(dict(sorted(answers.items())), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        size += path.stat().st_size
    print(f"read {rows} NYT clue uses; wrote {kept} clues for {len(found)} answers "
          f"in {len(shards)} files under {OUT} ({size // 1024 // 1024} MB)")


if __name__ == "__main__":
    main()
