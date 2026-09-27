"""Stream Google Books Ngram v3 English 1-grams and keep, for every single word in web/words.js, its
match counts for 2015-2019 (the corpus's last years) and for all years. Writes
compileWords/books-1w.txt (WORD<TAB>recent<TAB>all) for build_words.py.

Run: python web/books_ngrams.py
The 24 shards are about 9 GB compressed and are streamed, never saved; the run takes 15-20 minutes
and resumes from compileWords/books-progress.json if interrupted. The first shards hold only number-
like tokens, so they match nothing; that's expected.
"""
import gzip
import io
import json
import re
import time
import urllib.request
from pathlib import Path

WEB = Path(__file__).parent
OUT = WEB.parent / "compileWords" / "books-1w.txt"
PROGRESS = WEB.parent / "compileWords" / "books-progress.json"
SHARDS = 24
RECENT_FROM = 2015

src = (WEB / "words.js").read_text(encoding="utf-8")
start = src.index("GRIDFILL_WORDS = ") + len("GRIDFILL_WORDS = ")
data = json.loads(src[start: src.rindex(";")])
wanted = set()
for key, entry in data.items():
    n = int(key)
    letters = entry[0]
    for i in range(len(letters) // n):
        wanted.add(letters[i * n:(i + 1) * n])
print(f"{len(wanted)} words to look for", flush=True)

done = json.loads(PROGRESS.read_text()) if PROGRESS.exists() else {"shards": [], "counts": {}}
counts = done["counts"]  # WORD -> [recent, all]

for shard in range(SHARDS):
    if shard in done["shards"]:
        continue
    name = f"1-{shard:05d}-of-{SHARDS:05d}.gz"
    url = f"http://storage.googleapis.com/books/ngrams/books/20200217/eng/{name}"
    began = time.time()
    lines = hits = 0
    with urllib.request.urlopen(url, timeout=120) as response:
        with gzip.GzipFile(fileobj=response) as raw:
            for line in io.TextIOWrapper(raw, encoding="utf-8", errors="replace"):
                lines += 1
                tab = line.find("\t")
                if tab <= 0:
                    continue
                token = line[:tab]
                if "_" in token or not token.isalpha():
                    continue
                word = token.upper()
                if word not in wanted:
                    continue
                recent = total = 0
                for cell in line[tab + 1:].split("\t"):
                    parts = cell.split(",")
                    if len(parts) < 2:
                        continue
                    year = int(parts[0])
                    match = int(parts[1])
                    total += match
                    if year >= RECENT_FROM:
                        recent += match
                had = counts.get(word, [0, 0])
                counts[word] = [had[0] + recent, had[1] + total]
                hits += 1
    done["shards"].append(shard)
    PROGRESS.write_text(json.dumps(done))
    print(f"shard {shard}: {lines} lines, {hits} matching, {time.time() - began:.0f} s; {len(counts)} words so far", flush=True)

with OUT.open("w", encoding="utf-8") as out:
    for word in sorted(counts):
        out.write(f"{word}\t{counts[word][0]}\t{counts[word][1]}\n")
print(f"wrote {OUT}: {len(counts)} words", flush=True)
