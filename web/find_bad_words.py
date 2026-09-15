"""Flag words in web/words.js that look like garbage fill, for a person to review.

Run: python web/find_bad_words.py [--min-score 40] [--stats]
Needs wordfreq (pip install wordfreq), like build_words.py.

Writes compileWords/review-bad-words.txt: one line per suspect word, grouped by why it was
flagged, highest score first within each group (autofill reaches for those first). Every word
still listed there is removed when you rebuild with python web/build_words.py. To keep a word
instead, just delete its line -- rerunning this script remembers that (in compileWords/review-
seen.txt) and won't bring it back. With --stats it prints how many words each rule catches, with
examples, and writes nothing.
"""

import argparse
import json
import re
from pathlib import Path

import build_words as bw

HERE = Path(__file__).parent
REVIEW = bw.COMPILE / "review-bad-words.txt"
ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

# Profanity and crude roots that almost never occur inside ordinary words. TWAT excludes a run of
# ordinary *WATCH compounds (WRISTWATCH, NIGHTWATCH, SMARTWATCH...), which otherwise contain it letter-for-letter.
CRUDE_INSIDE = re.compile(
    r"FUCK|FUCC|FUQ|PHUK|PHUC|FCUK|FCK|SHIT|SHYT|CUNT|JIZZ|DILDO|BITCH|BIATCH|WHORE|SLUT|TWAT(?!CH)|"
    r"PISS|BOOB|ASSHOLE|BUTTHOLE|ARSEHOLE|DOUCHE|SKANK|PORN|NUTSACK|BALLSACK|TITTIE|TITTY|MOFO|MUTHA"
)
# Crude words that are obviously crude on their own, not just inside a phrase.
CRUDE_WHOLE = {
    "POOP", "POOPS", "POOPY", "POOPED", "CRAP", "CRAPPY", "FART", "FARTS", "FARTED", "BONER", "BONERS",
    "BOOGER", "TITS", "HORNY", "DAMMIT", "HELLA", "THOT", "MILF", "WTF", "STFU", "GTFO", "FFS", "OMFG",
    "HOE", "HOES", "TURD", "TURDS", "WANKER", "ARSE",
}
# Crude words that are also pieces of ordinary words (COCKPIT, SCRAP), so they only count as a whole word
# of a run-together phrase (DOGPOO = DOG + POO). BUTT, BALLS, NUTS and BOOTY are deliberately left out:
# they turn out to mean sports equipment, food, or gun/rifle parts far more often than anything crude
# (CIGARBUTT, GOLFBALLS, BRAZILNUTS, RIFLEBUTT), so segmentation on them made too many false hits.
CRUDE_PARTS = {
    "POO", "POOP", "POOPS", "POOPY", "POOPED", "CRAP", "CRAPPY", "CRAPS", "COCK", "COCKS", "DICK", "DICKS",
    "HUMP", "HUMPS", "HUMPING", "FART", "FARTS", "FARTED", "CUM", "BONER", "BONERS",
    "PEE", "PEES", "PEED", "PUKE", "PUKED", "BARF", "BARFED", "SNOT", "BOOGER", "TITS", "HORNY", "ASS", "ARSE",
    "SUCKS", "SCREWED", "DAMN", "DAMMIT", "HELLA", "JUGS", "HOOTERS", "KNOCKERS", "SEXT",
    "SEXTING", "HOE", "HOES", "PIMP", "PIMPS", "THOT", "MILF", "BJ", "WTF", "STFU", "GTFO", "FFS", "OMFG",
    "TURD", "TURDS", "WANK", "WANKER",
}
# Chat shorthand and internet slang.
SLANG = {
    "DAFUQ", "LOL", "LOLS", "LOLZ", "LMAO", "LMFAO", "ROFL", "ROFLMAO", "OMG", "OMFG", "OMGS", "WTF", "WTH", "SMH",
    "TBH", "IMO", "IMHO", "IDK", "IDC", "ICYMI", "TFW", "MFW", "AFAIK", "BRB", "BTW", "TTYL", "TTYN", "FOMO",
    "YOLO", "BAE", "FTW", "NSFW", "SFW", "TLDR", "TMI", "IRL", "AFK", "GG", "GGWP", "NOOB", "NOOBS", "NEWB",
    "PWN", "PWNED", "PWNS", "LEET", "ROFLS", "LULZ", "SRSLY", "PLZ", "PLS", "THX", "TNX", "CYA", "NVM", "JK",
    "JKJK", "AMIRITE", "AMIRIGHT", "OFC", "NGL", "FRFR", "ONG", "SUS", "YEET", "YEETED", "BRUH", "BRUV",
    "FAM", "FAMS", "SIMP", "SIMPS", "RIZZ", "SKRRT", "SKIBIDI", "LOWKEY", "HIGHKEY", "DEADASS", "BIGLY",
    "COVFEFE", "DERP", "DERPY", "HERP", "HERPDERP", "SMOL", "HECKIN", "BOI", "BOIS", "GURL", "GURLS", "GRRL",
    "GRRLS", "KTHX", "KTHXBYE", "OKAYY", "WHATEVS", "TOTES", "ADORBS", "OBVI", "OBVS", "PERF", "CRAY",
    "CRAYCRAY", "BAMF", "OTP", "FTFY", "IANAL", "HMU", "DMED", "DMING", "WYD", "HBU", "IYKYK", "ISTG", "TFTI",
    "ASF", "BFFS", "BFF", "BFFL", "YASS", "YAAS", "YAAAS", "CRINGEY", "CRINGY", "MEH", "WHOMST", "SPILLTHETEA",
    "UWU", "OWO", "XOXO", "XOXOXO",
}
# Words people say but don't usually spell out (GONNA, HMM, SHHH). These are fine fill, so they stay off
# the list entirely, even where another rule would catch them (HMM has no vowels, SHHH triples a letter).
SPOKEN = {
    "GONNA", "WANNA", "GOTTA", "KINDA", "SORTA", "DUNNO", "LEMME", "GIMME", "OUTTA", "LOTTA", "COULDA", "WOULDA",
    "SHOULDA", "MUSTA", "OUGHTA", "HAFTA", "HASTA", "USETA", "YALL", "YOUSE", "YINZ", "AINT", "WHADDAYA",
    "WHADDYA", "WHATCHA", "WATCHA", "GOTCHA", "BETCHA", "DONTCHA", "DIDJA", "WOULDJA", "COULDJA", "YER",
    "YEP", "YUP", "NOPE", "NAH", "NUH", "UHUH", "UHHUH", "MMHMM", "MMHM", "UMM", "UMMM", "UHH", "HMM", "HMMM",
    "HMMMM", "SHH", "SHHH", "SHHHH", "SHHS", "PSST", "PSSST", "PSSTS", "TSK", "TSKS", "TSKTSK", "TSKTSKS", "OOPSIE",
    "WHOOPSIE", "LIL", "OL", "CUZ", "COZ", "THRU", "NITE", "TONITE", "LITE", "LUV", "WUV", "SUMMAT", "INNIT",
    "INNA", "OUTA", "AHHH", "OHHH", "OOOH", "OOOOH", "OOOOHS", "AWWW", "EWWW", "BRR", "BRRR", "BRRRR", "GRR",
    "GRRR", "GRRS", "MMMM", "AAARGH", "BZZT",
}
LETTER_NAMES = {
    "AITCH", "AITCHES", "CEE", "CEES", "DEES", "EFF", "EFFS", "EFS", "ELL", "ELLS", "ELS", "EMM", "EMS",
    "ENN", "ENS", "ESS", "ESSES", "ARS", "VEE", "VEES", "WYE", "WYES", "ZEE", "ZEES", "ZEDS",
}
# Partials: a common lead-in stopped on an article (ONEA, SUCHA, TAKEA, INTHE). Plenty of real words also
# end in -A or -AN (SPIREA, OHIOAN), so the first word has to be one that usually comes before "a" or "the".
PARTIAL_ENDS = {"A", "AN", "THE"}
PARTIAL_LEADS = {
    "ONE", "SUCH", "WHAT", "QUITE", "RATHER", "HALF", "MANY", "ONCE", "TWICE", "ITS", "IS", "AS", "IN", "TO",
    "FOR", "ON", "AT", "BY", "OF", "SO", "IF", "BE", "LIKE", "NOT", "HAVE", "HAS", "HAD", "TAKE", "TAKES",
    "GIVE", "GIVES", "MAKE", "MAKES", "GET", "GETS", "WAS", "WERE", "ISNT", "THATS", "HES", "SHES", "YOURE",
    "ALL", "ONTO", "INTO", "WITH", "FROM", "NEED", "NEEDS", "WANT", "WANTS", "AND", "OR", "BUT", "OVER", "UNDER",
    "AFTER", "BEFORE", "ABOUT", "WITHOUT", "WHERES", "HERES", "THERES", "LETS", "HOW", "WHO", "WHY",
}

# Abbreviations people know that the frequency data is too old or too thin to show (GPT, LLM) and that
# haven't turned up in published crosswords much yet. Checked by hand.
WELL_KNOWN = {
    "GPT", "GPTS", "LLM", "LLMS", "NFT", "NFTS", "NPCS", "VFX", "SFX", "CSV", "SVG", "JPG", "JPGS", "DRM", "DPRK",
    "DDR", "KJV", "MMR", "XXL", "XXS", "KPMG", "DMX", "MFG", "HGH", "SQRT", "SQFT", "BLDG", "BLDGS", "DVRS", "HDDS",
    "BFG", "CSX", "JRR", "TCB", "NLCS", "NLDS", "FSB", "HRT", "VCS", "WTC", "DDD", "CCR", "LPG", "DBMS", "RFP",
    "KMH", "GCHQ", "LVMH", "DWTS", "TMNT", "DNF", "CWM", "HMPH", "BPM", "BPMS", "RPGS", "JVC", "TBD", "ZZZ",
    "XKCD", "DMZS", "NLP", "BMR", "TLS", "WWJD", "TTFN",
}
# Two-letter abbreviations common enough to count as one piece of a run-together string (TV + VCR, MLK + JR).
SHORT_ABBREVIATIONS = {"TV", "CD", "DJ", "VJ", "JR", "PC", "HD"}

# Groups in the order they appear in the review file; a word goes in the first group that catches it.
GROUPS = [
    ("crude", "Crude or vulgar"),
    ("slang", "Internet slang and chat abbreviations"),
    ("spoken", "Z spelled for S (BOYZ for BOYS)"),
    ("plural", "Wrong plurals (SEXS for SEXES)"),
    ("letters", "Letter junk: tripled letters and alphabet runs"),
    ("roman", "Roman numerals"),
    ("abbr-stacked", "Abbreviations run together (NFL MVP, DVD VCRS)"),
    ("abbr-plural", "Plurals of abbreviations nobody pluralizes (CNNS, KGBS)"),
    ("abbr-obscure", "Obscure abbreviations: rare in everyday English and in published crosswords"),
    ("abbr-crossword", "Crossword-only abbreviations: rare in English but used in published puzzles (SSGTS, NTWT)"),
    ("partial", "Partial phrases that end on an article (ONE A, SUCH A)"),
    ("names", "Spelled-out letter names"),
    ("unknown", "Scores 50+ but has no English reading and was never used in a published crossword"),
]


def load_scores():
    """{word: score} from web/words.js, the list the site uses (block-listed words already gone)."""
    text = (HERE / "words.js").read_text(encoding="utf-8")
    data = json.loads(text[text.index("{"): text.rindex("}") + 1])
    scores = {}
    for length, (letters, score_text, *_) in data.items():
        size = int(length)
        for i, value in enumerate(score_text.split(",")):
            scores[letters[i * size:(i + 1) * size]] = int(value)
    return scores


def vowelless(word):
    return not re.search(r"[AEIOUY]", word)


def familiar_abbreviation(word, zipf, counts):
    """Whether a vowelless entry is an abbreviation most solvers would know (CNN, HTML, GPT)."""
    whole = zipf.get(word, 0.0)
    return word in WELL_KNOWN or whole >= 3.0 or (whole >= 2.0 and counts.get(word, 0) >= 10)


def stacked(word, zipf, counts):
    """The pieces of two or more different abbreviations run together (NFL + MVP), or None."""
    if re.fullmatch(r"CTRL[A-Z]", word):
        return ["CTRL", word[4]]
    best = [None] * (len(word) + 1)
    best[0] = []
    for end in range(1, len(word) + 1):
        for start in range(max(0, end - 5), end):
            piece = word[start:end]
            if best[start] is None or not (
                piece in SHORT_ABBREVIATIONS or (len(piece) >= 3 and vowelless(piece) and familiar_abbreviation(piece, zipf, counts))
            ):
                continue
            if best[end] is None or len(best[start]) + 1 < len(best[end]):
                best[end] = best[start] + [piece]
    parts = best[-1]
    return parts if parts and len(parts) > 1 and len(set(parts)) > 1 else None


def abbreviation(word, zipf, counts):
    """(group, detail) for a vowelless entry that isn't a well-known abbreviation, or None."""
    if len(word) < 3 or not vowelless(word) or familiar_abbreviation(word, zipf, counts):
        return None
    whole, used = zipf.get(word, 0.0), counts.get(word, 0)
    stem = word[:-1]
    if word.endswith("S") and len(stem) >= 2 and familiar_abbreviation(stem, zipf, counts):
        # DVRS and BLTS are fine; CNNS and LSDS aren't, and only usage can tell them apart.
        return None if whole >= 1.5 or used >= 10 else ("abbr-plural", f"plural of {stem}")
    if whole < 2.0 and used < 25:
        parts = stacked(word, zipf, counts)
        if parts:
            return ("abbr-stacked", "reads as " + " + ".join(parts))
    if used >= 10:
        return ("abbr-crossword", f"rare abbreviation, in {used} published crosswords")
    return ("abbr-obscure", "rare abbreviation" + (f", in {used} published crosswords" if used else ", never in a published crossword"))


def flags(word, score, zipf, counts):
    """Every (group, detail) that makes the word look like garbage fill."""
    found = []
    whole = zipf.get(word, 0.0)
    familiar_z, parts = bw.reading(word, zipf)
    # The proper spelling must be clearly more common than this one (LOVIN vs LOVING, BOYZ vs BOYS).
    more_common = lambda other: zipf.get(other, 0.0) >= max(3.0, whole + 1.0) and whole < 3.3

    inside = CRUDE_INSIDE.search(word)
    if inside:
        found.append(("crude", f"contains {inside.group(0)}"))
    elif len(parts) > 1 and any(p in CRUDE_PARTS for p in parts):
        found.append(("crude", "reads as " + " ".join(parts)))
    elif word in CRUDE_WHOLE:
        found.append(("crude", "crude word"))

    if word in SLANG:
        found.append(("slang", "chat or internet slang"))

    if len(word) >= 4 and word.endswith("Z") and more_common(word[:-1] + "S"):
        found.append(("spoken", f"Z for S ({word[:-1]}S)"))

    stem = word[:-1]
    if word.endswith("S") and re.search(r"(X|Z|SH|CH)$", stem) and zipf.get(stem, 0.0) >= 3.0 and whole < 1.5:
        found.append(("plural", f"plural of {stem} should end in ES"))

    # Tripled letters inside one word (ZZZ, MMMM), not where two words meet (SUCCESSSTORY).
    if word in WELL_KNOWN:
        pass
    elif any(re.search(r"(.)\1\1", part) for part in parts):
        found.append(("letters", "the same letter three times in a row"))
    elif (len(word) >= 3 and word in ALPHABET) or (len(word) >= 4 and word in ALPHABET[::-1]):
        found.append(("letters", "a run of the alphabet"))

    if len(word) >= 3 and whole < 3.5 and bw.ROMAN_NUMERAL.fullmatch(word):
        found.append(("roman", "a Roman numeral"))

    short_form = abbreviation(word, zipf, counts)
    if short_form:
        found.append(short_form)

    if len(parts) == 2 and len(word) <= 9 and parts[0] in PARTIAL_LEADS and parts[-1] in PARTIAL_ENDS:
        found.append(("partial", "reads as " + " ".join(parts)))

    if word in LETTER_NAMES:
        found.append(("names", "a letter's name"))

    if score >= 50 and familiar_z == 0 and not counts.get(word):
        found.append(("unknown", "no English reading"))

    # Spoken-style spellings (GONNA, HMM) and dropped g's (LOVIN for LOVING) are fine fill: only list
    # one if it's crude.
    dropped_g = len(word) >= 5 and word.endswith("IN") and more_common(word + "G")
    if word in SPOKEN or dropped_g:
        found = [f for f in found if f[0] == "crude"]
    return found


SEEN = bw.COMPILE / "review-seen.txt"  # every word ever flagged, so a deleted line stays deleted


def read_listed():
    """{word: (group, score, detail)} for words currently sitting in the review file, i.e. the ones
    the user hasn't deleted."""
    titles = {title: key for key, title in GROUPS}
    listed, group = {}, None
    if REVIEW.exists():
        for line in REVIEW.read_text(encoding="utf-8").splitlines():
            if line.startswith("## "):
                group = titles.get(re.sub(r" \(\d+ words\)$", "", line[3:]))
                continue
            match = re.match(r"([A-Z]+)\s+(-?\d+)\s+(.*)", line)
            if match and group:
                listed[match.group(1)] = (group, int(match.group(2)), match.group(3))
    return listed


def read_seen():
    return set(SEEN.read_text(encoding="utf-8").split()) if SEEN.exists() else set()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--min-score", type=int, default=40, help="only check words scoring at least this (default 40)")
    parser.add_argument("--stats", action="store_true", help="print counts and examples per group; write nothing")
    args = parser.parse_args()

    scores = load_scores()
    zipf = bw.load_zipf()
    counts = bw.load_published()
    groups = {key: [] for key, _ in GROUPS}
    order = [key for key, _ in GROUPS]
    checked = known_abbreviations = 0
    for word, score in scores.items():
        if score < args.min_score:
            continue
        checked += 1
        if len(word) >= 3 and vowelless(word) and familiar_abbreviation(word, zipf, counts):
            known_abbreviations += 1
        found = flags(word, score, zipf, counts)
        if found:
            found.sort(key=lambda f: order.index(f[0]))
            groups[found[0][0]].append((score, word, "; ".join(detail for _, detail in found)))
    # Words a rebuild already removed aren't in words.js any more, so carry their lines over as they
    # were; dropping them here would put them back in the word list on the next build.
    listed = read_listed()
    for word, (group, score, detail) in listed.items():
        if word not in scores:
            groups[group].append((score, word, detail))
    for items in groups.values():
        items.sort(key=lambda item: (-item[0], item[1]))

    total = sum(len(items) for items in groups.values())
    if args.stats:
        print(f"checked {checked} words scoring {args.min_score}+; flagged {total}")
        for key, title in GROUPS:
            items = groups[key]
            print(f"\n{title}: {len(items)}")
            print("  top: " + ", ".join(f"{w} {s}" for s, w, _ in items[:25]))
        print(f"\nwell-known abbreviations left out: {known_abbreviations}")
        probe = [w for w in ("DAFUQ", "DOGPOO", "SHITPOST", "SEXS", "RSTU", "GONNA", "LOVIN", "BOYZ", "GPT", "CNN", "ZZZ",
                             "NFLMVP", "CNNS", "HDTVS", "DVRS", "SSGTS", "ZDX", "CTRLZ") if w in scores]
        print("\nprobes: " + ", ".join(f"{w} {scores[w]}: {flags(w, scores[w], zipf, counts)}" for w in probe))
        return

    # A word that was flagged before and is no longer sitting in the review file was deleted on
    # purpose, to keep it -- exclude it here too, or rerunning this script would bring it right back.
    seen = read_seen()
    kept = seen - set(listed)
    all_flagged = {word for items in groups.values() for _, word, _ in items}
    for items in groups.values():
        items[:] = [item for item in items if item[1] not in kept]
    total = sum(len(items) for items in groups.values())
    dropped = len(all_flagged & kept)

    width = max((len(w) for items in groups.values() for _, w, _ in items), default=10)
    lines = [
        "# Gridfill word-list review: words that look like garbage fill. Every word listed here is",
        "# removed from the site's word list when you rebuild (python web/build_words.py).",
        f"# {total} words scoring {args.min_score} or more, grouped by why they were flagged; highest score first,",
        "# since autofill reaches for those first. Most groups are rough guesses, so check before rebuilding.",
        f"# {known_abbreviations} well-known abbreviations (CNN, HTML, GPT) aren't listed.",
        "#",
        "# To KEEP a word (don't remove it), delete its line. Rerunning web/find_bad_words.py remembers",
        f"# what you've deleted, so it won't come back.{f' ({dropped} kept this way right now.)' if dropped else ''}",
        "",
    ]
    for key, title in GROUPS:
        items = groups[key]
        lines.append(f"## {title} ({len(items)} words)")
        for score, word, detail in items:
            lines.append(f"{word.ljust(width)}  {score:>3}  {detail}")
        lines.append("")
    REVIEW.write_text("\n".join(lines), encoding="utf-8")
    SEEN.write_text("\n".join(sorted(seen | all_flagged)), encoding="utf-8")
    print(f"wrote {REVIEW}: {total} words to review, {dropped} kept (deleted in an earlier pass)")


if __name__ == "__main__":
    main()
