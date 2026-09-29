"""Build web/words.js: every word the site can use, with a 0-100 score.

Run: python web/build_words.py [--samples]
Needs wordfreq for everyday-English word frequencies: pip install wordfreq

Scores start from two sources:
- Peter Broda's scored word list (compileWords/peter-broda-wordlist*.txt, WORD;score
  lines), the hand-scored list many constructors load into Crossfire: 50 is ordinary fill,
  60 and up is lively, under 50 is weak.
- Entries from published crosswords (compileWords/SortedWords) that Broda's list lacks,
  mostly one-off theme answers. They're unvetted, so they score UNVETTED_MAX at most,
  ranked by estimate_score.

Broda gives hundreds of thousands of words a flat 50, obscure and everyday alike, so each
of his scores is then nudged by popularity: up to POPULARITY_BOOST points for words everyone
knows, down to POPULARITY_PENALTY points for words almost nobody uses. Popularity is how
common the word (or its stem) is in everyday English, or, discounted, how often it has
appeared in published crosswords. Run-together phrases can lose points for a rare word but
can't gain any just because their words are common: that's how "green paint" gets in.

Words on a block list (compileWords/blocklist*.txt: slurs and obscenities, one per line) are
left out entirely, whatever their score.

web/wordstats.js is written beside it for the list editor, with figures per word beyond the score:
per length, comma lists in the same word order of
- uses: how many published puzzles the word has appeared in;
- everyday: how familiar it is in everyday English (0-100, see popularity);
- google: how many times Google's web corpus has it (compileWords/google-1w.txt and google-2w.txt:
  the unigram and bigram counts from the Google Web Trillion Word Corpus as Peter Norvig publishes
  them at norvig.com/ngrams; a phrase counts as the rarest of its word pairs, unseen counts 0);
- year: the last year it was a published answer (0 if never);
- broda: Broda's own score before the popularity nudge ("" for words his list lacks);
- zipf: the Zipf frequency of its most familiar reading, times ten (see reading);
- cuts: where that reading splits it into words, as letter counts ("5.8" for ASKED|FOR|THEMOON's
  first two cuts; "" for a single word);
- books: how many times Google Books used the word in 2015-2019, the last years of its English
  corpus (compileWords/books-1w.txt, made from the Google Books Ngram v3 1-grams by
  web/books_ngrams.py; single words only, 0 for phrases and unseen words);
- lat, wsj, usa, tny, up, nw, other: its uses as an answer in the LA Times, Wall Street Journal, USA
  Today, New Yorker, Universal and Newsday puzzles and in every other xd outlet; outlets: how many
  outlets have used it; clues: how many different clues it has had (all from
  compileWords/xd-uses.tsv, made by web/fetch_extras.py);
- wiki: how many English Wikipedia article titles run together to it (wiki-titles.tsv);
- subtlex, opensubs: its count in SUBTLEX-US and in the OpenSubtitles 2018 list (spoken.tsv);
- wikt: its Wiktionary flags, a bitset (wiktionary.tsv; the bits are listed in fetch_extras.FLAGS).
And web/defs/XX.json holds each word's first Wiktionary definition, by its first two letters, for
the review card to fetch as it needs them.

Each length becomes [letters, scores, popular, published, unvetted]: the words run together
(they're all the same length), best score first; their scores as a comma list; and three base64
bitsets: which of them are popular (see popularity), which have appeared in published
crosswords, and which of those Broda's list lacks. The site's NYT answers list is the published
words, with the unvetted ones scored NYT_UNVETTED_SCORE instead of their estimate.
"""

import argparse
import base64
import json
import math
import random
import re
from pathlib import Path

try:
    from wordfreq import get_frequency_dict
except ImportError:
    raise SystemExit("build_words.py needs wordfreq: pip install wordfreq")

HERE = Path(__file__).parent
COMPILE = HERE.parent / "compileWords"
PUBLISHED = COMPILE / "SortedWords"
MIN_LENGTH, MAX_LENGTH = 3, 25  # the site's grids go up to 25 squares across
UNVETTED_MAX = 40
POPULARITY_BOOST = 10      # most a household word gains
POPULARITY_PENALTY = 20    # most a word nobody uses loses
PUZZLE_DISCOUNT = 0.6      # crossword appearances count for less than everyday use
# "Popular" words may be allowed below the site's minimum score: single words at least this
# common in everyday English, as long as they score at least POPULAR_FLOOR (Broda marks
# abbreviations, junk and slurs lower than that). Crossword-only regulars like ALEE don't count.
POPULAR_ZIPF = 3.0
POPULAR_FLOOR = 40

FUNCTION_WORDS = {"A", "AN", "THE", "OF", "TO", "IN", "ON", "AT", "BY", "FOR", "AND", "OR", "IS", "IT",
                  "AS", "BE", "UP", "SO", "NO", "MY", "ME", "WE", "US"}
TWO_LETTER_WORDS = {"AN", "OF", "TO", "IN", "ON", "AT", "BY", "OR", "IS", "IT", "AS", "BE", "UP", "SO", "NO",
                    "MY", "ME", "WE", "US", "DO", "GO", "HE", "OH", "OX", "AM", "IF", "EX"}
SUFFIXES = ("ING", "IES", "ERS", "ES", "ED", "ER", "LY", "S")
PARTIAL_STARTS = {"A", "AN", "THE"}
PARTIAL_ENDS = {"A", "AN", "THE", "OF", "TO", "IN", "AND", "OR"}
ROMAN_NUMERAL = re.compile(r"M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})")
LENGTH_LIVELINESS = {3: 0.0, 4: 0.1, 5: 0.25, 6: 0.4, 7: 0.5, 8: 0.6, 9: 0.65}
PROBES = ["ERA", "AREA", "ERNE", "ALEE", "OREO", "ESAI", "QUIZ", "JAZZ", "XRAY", "STARWARS", "SLOWSTART",
          "GOLDENRETRIEVER", "SINORNIS", "HALTERED", "AURICULOVENTRICULAR", "FLATUS", "NAVELS", "INCEPT",
          "EYESOFLAURAMARS", "THEFATHEROFGEOGRAPHY", "SPENDINGSPREES", "ELECTRONICBALANCE", "LOOKINGINON",
          "REALFRIEND", "GOODKING", "PLAYCARDS", "DIVAGATE", "ERUDITE", "LANDMINES", "EMACIATED", "RESONATES",
          "AMBIGUOUSLY", "WHOLESALING", "COHOSH", "OXYTONE", "RULELESS"]


def clamp(x):
    return max(0.0, min(1.0, x))


# --- how familiar a word is ---

def load_zipf():
    """Everyday-English Zipf frequency (roughly 0-8) of alphabetic words, keyed in uppercase."""
    zipf = {}
    for word, freq in get_frequency_dict("en").items():
        if word.isascii() and word.isalpha():
            key = word.upper()
            zipf[key] = max(zipf.get(key, 0.0), math.log10(freq) + 9)
    return zipf


def part_zipf(part, zipf):
    """Zipf of one piece of a run-together phrase, or None if it's too rare to trust as a word there."""
    z = zipf.get(part)
    if z is None:
        return None
    if len(part) == 1:
        return z if part in ("A", "I") else None
    if len(part) == 2:
        return z if part in TWO_LETTER_WORDS else None
    return z if z >= (3.0 if len(part) == 3 else 1.5) else None


def segment(word, zipf):
    """The most likely split of a run-together phrase into English words, or None."""
    best = [None] * (len(word) + 1)
    best[0] = (0.0, [])
    for end in range(1, len(word) + 1):
        for start in range(max(0, end - 16), end):
            if best[start] is None:
                continue
            z = part_zipf(word[start:end], zipf)
            if z is None:
                continue
            logprob = best[start][0] + z - 9
            if best[end] is None or logprob > best[end][0]:
                best[end] = (logprob, best[start][1] + [word[start:end]])
    return best[-1][1] if best[-1] else None


def reading(word, zipf):
    """(Zipf frequency of the word's most familiar reading, the words in that reading)."""
    whole = zipf.get(word, 0.0)
    parts = [word]
    familiar_z = whole
    # Read it as a phrase when it isn't a common word itself, or when it's a long rare token
    # whose split is clearly more familiar.
    if len(word) >= 4 and (whole < 2.5 or (len(word) >= 7 and whole < 3.5)):
        split = segment(word, zipf)
        if split and len(split) > 1:
            split_z = min(zipf[p] for p in split)
            if all(len(p) <= 3 for p in split):
                split_z = min(split_z, 3.0)  # runs of short pieces are usually abbreviations
            if whole < 2.5 or split_z >= whole + 1.0:
                parts = split
                familiar_z = max(whole, split_z)
    if len(parts) == 1 and whole < 2.5 and len(word) >= 4 and word[0] not in "AEIOU" and zipf.get(word[1:], 0.0) >= 3.5:
        familiar_z = zipf[word[1:]] - 0.5  # a letter and a word: TBAR, XRAY
    return familiar_z, parts


def stem_zipf(word, zipf):
    """Zipf of the word's likely stem, less a little, so NAVELS and RESONATES aren't treated as rare."""
    best = 0.0
    for suffix in SUFFIXES:
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            stem = word[: -len(suffix)]
            for candidate in (stem, stem + "E", stem + "Y"):
                best = max(best, zipf.get(candidate, 0.0) - 0.5)
    return best


def popularity(word, count, zipf):
    """(popularity 0-1 where 0.5 is neutral, whether the word is popular enough for the site's
    "allow popular words" option): how widely known a word is, in everyday English or in crosswords."""
    familiar_z, parts = reading(word, zipf)
    single = len(parts) == 1
    if single:
        # A common stem can spare a word the penalty, but can't earn it a boost (SEXS, MAJORER).
        familiar_z = max(familiar_z, min(stem_zipf(word, zipf), 2.5))
    everyday = clamp((familiar_z - 1.0) / 3.0)  # Zipf 2.5 (say, "navel") is neutral; 4 and up is fully familiar
    if not single:
        everyday = min(everyday, 0.5)  # common words don't make a phrase common ("green paint")
    in_puzzles = clamp(math.log10(count) / 2) if count else 0.0  # 100+ puzzles counts fully
    popular = single and familiar_z >= POPULAR_ZIPF
    return max(everyday, PUZZLE_DISCOUNT * in_puzzles), popular


def bitset_base64(flags):
    """Flags packed as bits (flag i is bit i & 7 of byte i >> 3), base64-encoded."""
    packed = bytearray((len(flags) + 7) // 8)
    for i, flag in enumerate(flags):
        if flag:
            packed[i >> 3] |= 1 << (i & 7)
    return base64.b64encode(bytes(packed)).decode("ascii")


def adjust(score, popular):
    """Broda's score nudged by popularity (0-1, where 0.5 leaves it unchanged)."""
    if popular < 0.5:
        return max(0, round(score - POPULARITY_PENALTY * (0.5 - popular) / 0.5))
    if score < 40:
        return score  # don't lift words Broda marked as bad
    return min(100, round(score + POPULARITY_BOOST * (popular - 0.5) / 0.5))


def estimate_score(word, count, zipf):
    """0-100 guess for words Broda doesn't score, from how familiar and lively they look."""
    familiar_z, parts = reading(word, zipf)
    phrase = len(parts) > 1
    content = [p for p in parts if p not in FUNCTION_WORDS]
    familiarity = clamp((familiar_z - 1.5) / 3.5)
    in_puzzles = clamp(math.log10(count) / 2)
    liveliness = LENGTH_LIVELINESS.get(len(word), 0.75 if len(word) < 13 else 0.85)
    if phrase and len(content) >= 2 and len(word) >= 8:
        liveliness += 0.15
    liveliness += min(0.16, 0.08 * sum(word.count(ch) for ch in "JQXZ"))
    liveliness = min(1.0, liveliness)

    value = 0.2 + 0.3 * familiarity + 0.45 * liveliness + 0.08 * min(1.0, count / 5)
    if familiar_z == 0:
        value -= 0.15
    if familiarity < 0.35:
        value -= min(0.15, max(0.0, in_puzzles - familiarity) * 0.45)
    if phrase and len(word) <= 8 and (parts[0] in PARTIAL_STARTS or parts[-1] in PARTIAL_ENDS):
        value -= 0.35
    if zipf.get(word, 0.0) < 3 and ROMAN_NUMERAL.fullmatch(word):
        value -= 0.35
    return round(100 * clamp(value))


# --- build ---

def load_broda():
    paths = sorted(COMPILE.glob("peter-broda-wordlist*.txt"), key=lambda p: p.stat().st_mtime)
    if not paths:
        raise SystemExit(f"Put Peter Broda's scored word list (peter-broda-wordlist*.txt) in {COMPILE}")
    scores = {}
    for line in paths[-1].read_text(encoding="utf-8", errors="replace").splitlines():
        word, _, value = line.strip().partition(";")
        word = word.upper()
        if MIN_LENGTH <= len(word) <= MAX_LENGTH and re.fullmatch(r"[A-Z]+", word) and value.strip().isdigit():
            scores[word] = max(scores.get(word, 0), min(100, int(value)))
    return paths[-1].name, scores


def load_google():
    """Google's web counts: {WORD: count} and {"WORD WORD": count}, uppercased."""
    def read(name):
        counts = {}
        path = COMPILE / name
        if not path.exists():
            print(f"no {path}: Google counts left out")
            return counts
        for line in path.read_text(encoding="utf-8").splitlines():
            parts = line.split("\t")
            if len(parts) == 2 and parts[1].isdigit():
                counts[parts[0].upper()] = int(parts[1])
        return counts
    return read("google-1w.txt"), read("google-2w.txt")


def google_count(word, parts, unigrams, bigrams):
    """How often Google's web corpus saw the word, or, for a phrase, its rarest word pair."""
    if len(parts) <= 1:
        return unigrams.get(word, 0)
    least = None
    for a, b in zip(parts, parts[1:]):
        count = bigrams.get(f"{a} {b}", 0)
        if not count:
            return 0
        least = count if least is None else min(least, count)
    return least or 0


def load_tsv(name):
    """{WORD: [columns after the word]} from a compileWords/*.tsv with a header line, or {} without one."""
    path = COMPILE / name
    if not path.exists():
        print(f"no {path}: left out (python web/fetch_extras.py makes it)")
        return {}
    rows = {}
    lines = path.read_text(encoding="utf-8").splitlines()
    for line in lines[1:]:
        parts = line.split("\t")
        rows[parts[0]] = parts[1:]
    return rows


def load_books():
    """{WORD: Google Books uses in 2015-2019}, from compileWords/books-1w.txt (WORD, recent, all)."""
    path = COMPILE / "books-1w.txt"
    counts = {}
    if not path.exists():
        print(f"no {path}: Google Books counts left out")
        return counts
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = line.split("\t")
        if len(parts) >= 2 and parts[1].isdigit():
            counts[parts[0]] = int(parts[1])
    return counts


def load_published(years=None):
    """{WORD: puzzles it appeared in}; with a dict given as years, also {WORD: last year, as 2000 + n}."""
    counts = {}
    for path in PUBLISHED.glob("len*.txt"):
        for line in path.read_text(encoding="utf-8").splitlines():
            parts = line.split()
            if len(parts) >= 2 and re.fullmatch(r"[A-Z]+", parts[0]) and int(parts[1]) >= 1:
                counts[parts[0]] = max(counts.get(parts[0], 0), int(parts[1]))
                if years is not None and len(parts) >= 3 and parts[2].isdigit():
                    years[parts[0]] = max(years.get(parts[0], 0), 2000 + int(parts[2]))
    return counts


def read_word_file(path):
    """Entries of a one-per-line word file ('#' starts a comment), run together and uppercased."""
    words = set()
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        word = re.sub(r"[^A-Za-z]", "", line.split("#")[0]).upper()
        if len(word) >= MIN_LENGTH:
            words.add(word)
    return words


def load_blocklist():
    """Words and phrases never to offer (slurs, obscenities), from compileWords/blocklist*.txt,
    minus the exceptions in compileWords/allowlist.txt. Broda's scores don't reliably keep
    these out: he scores SPIC 50, likely for SPIC AND SPAN."""
    blocked = set()
    for path in COMPILE.glob("blocklist*.txt"):
        blocked |= read_word_file(path)
    # Every word still listed in a review file (web/find_bad_words.py writes one) is blocked too --
    # delete a line there to keep that word instead of marking it. Section headers ("## ...") and
    # comments ("# ...") are skipped; a listed word looks like "WORD   score   reason".
    for path in COMPILE.glob("review*.txt"):
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            match = re.match(r"([A-Z]+)\s+-?\d+\s", line)
            if match:
                blocked.add(match.group(1))
    allowlist = COMPILE / "allowlist.txt"
    if allowlist.exists():
        blocked -= read_word_file(allowlist)
    return blocked


def print_popular(scores, popular, minimum):
    rng = random.Random(3)
    below = [w for w in popular if scores[w] < minimum]
    short = [w for w in below if len(w) <= 5]
    total_below = sum(1 for s in scores.values() if s < minimum)
    print(f"popular words under {minimum}: {len(below)} of the {total_below} words under it ({len(short)} of 3-5 letters)")
    print("  e.g. " + ", ".join(rng.sample(below, min(30, len(below)))))
    print("  short ones: " + ", ".join(rng.sample(short, min(30, len(short)))))


def print_samples(scores, broda):
    rng = random.Random(7)
    kept = sum(1 for w, s in broda.items() if s >= 50)
    now = sum(1 for w, s in scores.items() if w in broda and s >= 50)
    print(f"Broda words scoring 50+: {kept} before popularity, {now} after")
    flat = [w for w, s in broda.items() if s == 50]
    for low, high in ((0, 39), (40, 49), (50, 54), (55, 60)):
        band = [w for w in flat if low <= scores[w] <= high]
        print(f"Broda 50 now {low}-{high} ({len(band)} words): " + ", ".join(rng.sample(band, min(14, len(band)))))
    print("probes: " + ", ".join(f"{w} {broda.get(w, '-')}->{scores[w]}" for w in PROBES if w in scores))


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--samples", action="store_true", help="print samples showing what popularity changed")
    args = parser.parse_args()

    source, broda = load_broda()
    years = {}
    counts = load_published(years)
    zipf = load_zipf()
    unigrams, bigrams = load_google()
    books = load_books()
    xd = load_tsv("xd-uses.tsv")          # lat wsj usa tny up nw other outlets clues
    wiki = load_tsv("wiki-titles.tsv")    # titles
    spoken = load_tsv("spoken.tsv")       # subtlex opensubtitles
    wikt = load_tsv("wiktionary.tsv")     # flags gloss
    scores = {}
    popular = set()
    everyday = {}
    google = {}
    readings = {}  # word -> (familiar zipf, its words)
    for word, score in broda.items():
        how_popular, is_popular = popularity(word, counts.get(word, 0), zipf)
        everyday[word] = how_popular
        readings[word] = reading(word, zipf)
        google[word] = google_count(word, readings[word][1], unigrams, bigrams)
        scores[word] = adjust(score, how_popular)
        if is_popular and scores[word] >= POPULAR_FLOOR:
            popular.add(word)
    for word, count in counts.items():
        if word not in scores:
            scores[word] = round(UNVETTED_MAX * estimate_score(word, count, zipf) / 100)
            how_popular, is_popular = popularity(word, count, zipf)
            everyday[word] = how_popular
            readings[word] = reading(word, zipf)
            google[word] = google_count(word, readings[word][1], unigrams, bigrams)
            if is_popular and scores[word] >= POPULAR_FLOOR:
                popular.add(word)
    # Blocked words leave the list entirely: no autofill or word option offers them at any
    # minimum score, though you can still ink one yourself.
    blocked = load_blocklist() & set(scores)
    for word in blocked:
        del scores[word]
        popular.discard(word)
    print(f"blocked {len(blocked)} offensive words and phrases")

    by_length = {}
    for word in scores:
        by_length.setdefault(len(word), []).append(word)
    data = {}
    stats = {}
    for length, words in sorted(by_length.items()):
        # Among equal scores, words seen in published puzzles come first.
        words.sort(key=lambda w: (-scores[w], -counts.get(w, 0), w))
        data[length] = ["".join(words), ",".join(str(scores[w]) for w in words), bitset_base64([w in popular for w in words]),
                        bitset_base64([w in counts for w in words]), bitset_base64([w in counts and w not in broda for w in words])]
        cuts = []
        for w in words:
            parts = readings[w][1] if w in readings else [w]
            edges = []
            at = 0
            for part in parts[:-1]:
                at += len(part)
                edges.append(str(at))
            cuts.append(".".join(edges))
        stats[length] = [",".join(str(counts.get(w, 0)) for w in words), ",".join(str(round(100 * everyday.get(w, 0.5))) for w in words),
                         ",".join(str(google.get(w, 0)) for w in words), ",".join(str(years.get(w, 0)) for w in words),
                         ",".join(str(broda[w]) if w in broda else "" for w in words),
                         ",".join(str(round(10 * readings[w][0])) if w in readings else "0" for w in words), ",".join(cuts),
                         ",".join(str(books.get(w, 0)) for w in words)]
        for k in range(9):
            stats[length].append(",".join(xd[w][k] if w in xd else "0" for w in words))
        stats[length].append(",".join(wiki[w][0] if w in wiki else "0" for w in words))
        stats[length].append(",".join(spoken[w][0] if w in spoken else "0" for w in words))
        stats[length].append(",".join(spoken[w][1] if w in spoken else "0" for w in words))
        stats[length].append(",".join(wikt[w][0] if w in wikt else "0" for w in words))

    out = HERE / "words.js"
    payload = json.dumps(data, separators=(",", ":"))
    out.write_text(f"(typeof self !== 'undefined' ? self : globalThis).GRIDFILL_WORDS = {payload};\n", encoding="utf-8")
    print(f"wrote {out}: {len(scores)} words ({len(broda)} from {source}, {len(scores) - len(broda)} unvetted), "
          f"{out.stat().st_size // 1024} KB")
    # Definitions, filed by first two letters, fetched a file at a time by the review card.
    defs_dir = HERE / "defs"
    if wikt:
        import shutil
        shutil.rmtree(defs_dir, ignore_errors=True)
        defs_dir.mkdir()
        shelves = {}
        for word, (flags, *rest) in wikt.items():
            gloss = rest[0] if rest else ""
            if gloss and word in scores:
                shelves.setdefault(word[:2], {})[word] = gloss
        for prefix, shelf in sorted(shelves.items()):
            (defs_dir / f"{prefix}.json").write_text(json.dumps(dict(sorted(shelf.items())), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"wrote {defs_dir}: {sum(len(s) for s in shelves.values())} definitions in {len(shelves)} files")
    stats_out = HERE / "wordstats.js"
    stats_out.write_text(f"(typeof self !== 'undefined' ? self : globalThis).GRIDFILL_STATS = {json.dumps(stats, separators=(',', ':'))};\n", encoding="utf-8")
    print(f"wrote {stats_out}: {stats_out.stat().st_size // 1024} KB")
    if args.samples:
        print_samples(scores, broda)
        for minimum in (50, 70):
            print_popular(scores, popular, minimum)


if __name__ == "__main__":
    main()
