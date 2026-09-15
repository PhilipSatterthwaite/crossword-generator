"""Fill a crossword grid with words from a scored word list.

A grid is a list of rows (strings or lists). Each cell is a black square ('■' or
'#'), a letter, or empty (' ', '.', '_'). fill() returns a grid in which every
across and down entry of 2+ letters is a word from the list, no word is used
twice, and every given letter is kept. Entries whose letters are all given
(theme answers) don't have to be in the word list.

The search treats the puzzle as a constraint satisfaction problem:

- Every cell keeps a 26-bit mask of the letters still possible there, and every
  slot keeps a bitset of the words (by id) that still fit it.
- Propagation: a slot's words are filtered by its cells' letters, then its cells
  are narrowed to the letters those words still allow. A narrowed cell makes the
  crossing slot re-check, until nothing changes or some slot has no words left.
- Search: take the slot with the fewest words left and try its words best-first
  (popular, and leaving the crossings plenty of options). When a word fails, rule
  it out and propagate that too. Every change is logged on a trail, so backing up
  is just replaying the log in reverse.
- Restarts: after a budget of failures, start over with slightly shuffled word
  order and a bigger budget, so one bad early choice can't sink the whole run.
"""

from __future__ import annotations

import math
import random
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_WORDS_DIR = Path(__file__).parent / "compileWords" / "SortedWords"

BLACK = "■"
_BLACK_INPUT = {"■", "#"}
_EMPTY_INPUT = {" ", ".", "_", "", None}
_FULL = (1 << 26) - 1
_A = ord("A")

# Below this many candidates, reading letters straight off the words is cheaper
# than testing every letter's bitset at every position.
_SMALL_SET = 48

_FIRST_BUDGET = 100      # failures allowed before the first restart
_BUDGET_GROWTH = 1.5     # each restart allows this many times more failures
_RESTART_NOISE = 1.0     # random jitter added to word ranking after a restart


class GridError(ValueError):
    """The grid can't be filled as drawn (bad characters, orphan cells, missing word lengths)."""


def _bits(x):
    """Indices of the set bits of x, lowest first."""
    return [i for i, ch in enumerate(bin(x)[:1:-1]) if ch == "1"]


def _letters(mask):
    return [l for l in range(26) if mask >> l & 1]


class WordList:
    """Words grouped by length, best score first, indexed by (position, letter).

    For a length L, index[L][p][l] is a bitset whose bit i is set when word i of
    that length has letter l at position p, so "5-letter words with E third" is
    index[5][2][4] rather than a scan.
    """

    def __init__(self, entries):
        """entries: iterable of (word, score). Non A-Z words are skipped; duplicates keep the best score."""
        best = {}
        for word, score in entries:
            word = word.strip().upper()
            if word.isascii() and word.isalpha() and score > best.get(word, -math.inf):
                best[word] = score
        grouped = defaultdict(list)
        for word, score in best.items():
            grouped[len(word)].append((word, score))

        self.words = {}
        self.scores = {}
        self.codes = {}
        self.index = {}
        self.all = {}
        self._ids = {}
        for length, items in grouped.items():
            items.sort(key=lambda ws: (-ws[1], ws[0]))
            words = [w for w, _ in items]
            size = (len(words) + 7) // 8
            positions = [[bytearray(size) for _ in range(26)] for _ in range(length)]
            codes = []
            for i, word in enumerate(words):
                code = tuple(ord(ch) - _A for ch in word)
                codes.append(code)
                for p, l in enumerate(code):
                    positions[p][l][i >> 3] |= 1 << (i & 7)
            self.words[length] = words
            self.scores[length] = [s for _, s in items]
            self.codes[length] = codes
            self.index[length] = [[int.from_bytes(b, "little") for b in pos] for pos in positions]
            self.all[length] = (1 << len(words)) - 1
            self._ids[length] = {w: i for i, w in enumerate(words)}

    @classmethod
    def from_folder(cls, folder=DEFAULT_WORDS_DIR, min_count=1):
        """Load len*.txt files of 'WORD count year' lines, scoring each word log(1 + count)."""
        entries = []
        for path in sorted(Path(folder).glob("len*.txt")):
            for line in path.read_text(encoding="utf-8").splitlines():
                parts = line.split()
                if len(parts) >= 2 and int(parts[1]) >= min_count:
                    entries.append((parts[0], math.log1p(int(parts[1]))))
        return cls(entries)

    def word_id(self, word):
        return self._ids.get(len(word), {}).get(word)

    def __contains__(self, word):
        return self.word_id(word) is not None

    def __len__(self):
        return sum(len(words) for words in self.words.values())


@dataclass
class Slot:
    number: int       # clue number
    row: int
    col: int
    direction: str    # "across" or "down"
    cells: list       # cell ids, row * width + col

    @property
    def name(self):
        return f"{self.number}-{self.direction.capitalize()}"


def parse_grid(grid):
    """Return (height, width, cells, slots). cells holds BLACK, a letter, or None per cell."""
    rows = [list(row) for row in grid]
    if not rows or not rows[0]:
        raise GridError("grid is empty")
    width = len(rows[0])
    if any(len(row) != width for row in rows):
        raise GridError("grid rows have different lengths")
    height = len(rows)

    cells = []
    for r, row in enumerate(rows):
        for c, ch in enumerate(row):
            if ch in _BLACK_INPUT:
                cells.append(BLACK)
            elif ch in _EMPTY_INPUT:
                cells.append(None)
            elif len(ch) == 1 and ch.isascii() and ch.isalpha():
                cells.append(ch.upper())
            else:
                raise GridError(f"unexpected character {ch!r} at row {r}, col {c}")

    def white(r, c):
        return 0 <= r < height and 0 <= c < width and cells[r * width + c] != BLACK

    # Runs of 2+ white cells are entries; a lone cell in a direction is just unchecked.
    slots = []
    number = 0
    for r in range(height):
        for c in range(width):
            if not white(r, c):
                continue
            starts = []
            for direction, dr, dc in (("across", 0, 1), ("down", 1, 0)):
                if white(r - dr, c - dc):
                    continue
                n = 1
                while white(r + dr * n, c + dc * n):
                    n += 1
                if n >= 2:
                    starts.append((direction, [(r + dr * i) * width + c + dc * i for i in range(n)]))
            if starts:
                number += 1
                slots.extend(Slot(number, r, c, direction, run) for direction, run in starts)
    return height, width, cells, slots


@dataclass
class FillResult:
    success: bool
    grid: list | None          # rows of letters and BLACK, or None on failure
    reason: str = ""           # why it failed
    stats: dict = field(default_factory=dict)


class _Restart(Exception):
    pass


class _OutOfTime(Exception):
    pass


class _Search:
    """Search state for one grid. All changes to cands and cell_mask go through the trail."""

    def __init__(self, grid, words):
        self.height, self.width, cells, self.slots = parse_grid(grid)
        self.words = words
        self.black = [ch == BLACK for ch in cells]
        self.cell_mask = [0 if ch == BLACK else _FULL if ch is None else 1 << (ord(ch) - _A) for ch in cells]
        self.cell_slots = [[] for _ in cells]
        for s, slot in enumerate(self.slots):
            for p, cell in enumerate(slot.cells):
                self.cell_slots[cell].append((s, p))
        for i, ch in enumerate(cells):
            if ch is None and not self.cell_slots[i]:
                r, c = divmod(i, self.width)
                raise GridError(f"empty cell at row {r}, col {c} isn't part of any entry")

        # Fully given slots are fixed. Every other slot's candidates start as all words of its length.
        self.cands = [None] * len(self.slots)
        self.variables = []
        self.by_length = defaultdict(list)
        fixed_words = []
        for s, slot in enumerate(self.slots):
            given = [cells[i] for i in slot.cells]
            if None not in given:
                fixed_words.append("".join(given))
                continue
            length = len(slot.cells)
            if length not in words.all:
                raise GridError(f"{slot.name} needs a {length}-letter word, but the word list has none")
            self.cands[s] = words.all[length]
            self.variables.append(s)
            self.by_length[length].append(s)
        # A given entry that's also a listed word can't be used again elsewhere.
        for word in fixed_words:
            wid = words.word_id(word)
            if wid is not None:
                for s in self.by_length[len(word)]:
                    self.cands[s] &= ~(1 << wid)

        self.trail = []
        self.queued = [False] * len(self.slots)
        self.dead_slot = None
        self.nodes = 0
        self.failures = 0
        self.attempt_failures = 0
        self.restarts = 0

    # --- trail -------------------------------------------------------------

    def _set_cands(self, s, value):
        self.trail.append((self.cands, s, self.cands[s]))
        self.cands[s] = value

    def _set_cell(self, cell, value):
        self.trail.append((self.cell_mask, cell, self.cell_mask[cell]))
        self.cell_mask[cell] = value

    def undo(self, mark):
        trail = self.trail
        while len(trail) > mark:
            array, i, old = trail.pop()
            array[i] = old

    # --- propagation ---------------------------------------------------------

    def propagate(self, start):
        """Revise slots until nothing changes. False if some slot runs out of words."""
        queue = deque()
        for s in start:
            self._enqueue(queue, s)
        while queue:
            s = queue.popleft()
            self.queued[s] = False
            if not self._revise(s, queue):
                self.dead_slot = s
                for t in queue:
                    self.queued[t] = False
                return False
        return True

    def _enqueue(self, queue, s):
        if self.cands[s] is not None and not self.queued[s]:
            self.queued[s] = True
            queue.append(s)

    def _revise(self, s, queue):
        cells = self.slots[s].cells
        length = len(cells)
        index = self.words.index[length]

        # Keep only words whose letters are allowed in every cell.
        cands = self.cands[s]
        for p, cell in enumerate(cells):
            mask = self.cell_mask[cell]
            if mask == _FULL:
                continue
            letters = _letters(mask)
            if len(letters) <= 13:
                allowed = 0
                for l in letters:
                    allowed |= index[p][l]
                cands &= allowed
            else:
                for l in range(26):
                    if not mask >> l & 1:
                        cands &= ~index[p][l]
            if not cands:
                return False
        if cands != self.cands[s]:
            self._set_cands(s, cands)

        # A slot down to one word owns it: no other slot may use it.
        if cands & (cands - 1) == 0:
            for o in self.by_length[length]:
                if o != s and self.cands[o] & cands:
                    rest = self.cands[o] & ~cands
                    if not rest:
                        return False
                    self._set_cands(o, rest)
                    self._enqueue(queue, o)

        # Narrow each cell to the letters the remaining words still use there.
        small = cands.bit_count() <= _SMALL_SET
        if small:
            codes = self.words.codes[length]
            used = [0] * length
            for wid in _bits(cands):
                for p, l in enumerate(codes[wid]):
                    used[p] |= 1 << l
        for p, cell in enumerate(cells):
            mask = self.cell_mask[cell]
            if mask & (mask - 1) == 0:
                continue
            if small:
                new = used[p]
            else:
                new = 0
                for l in _letters(mask):
                    if cands & index[p][l]:
                        new |= 1 << l
            if new != mask:
                self._set_cell(cell, new)
                for o, _ in self.cell_slots[cell]:
                    if o != s:
                        self._enqueue(queue, o)
        return True

    # --- search --------------------------------------------------------------

    def _pick_slot(self):
        """The open slot with the fewest words left; longer slots win ties."""
        best, best_key = None, None
        for s in self.variables:
            n = self.cands[s].bit_count()
            if n > 1:
                key = (n, -len(self.slots[s].cells))
                if best_key is None or key < best_key:
                    best, best_key = s, key
        return best

    def _ordered_words(self, s):
        """Slot s's words, best first: popular, and leaving crossing slots the most options."""
        cells = self.slots[s].cells
        length = len(cells)
        # For each position crossing an open slot: log(1 + crossing words left) per letter.
        support = []
        for p, cell in enumerate(cells):
            for o, q in self.cell_slots[cell]:
                other = self.cands[o]
                if o == s or other is None or other & (other - 1) == 0:
                    continue
                crossing = self.words.index[len(self.slots[o].cells)][q]
                table = [0.0] * 26
                for l in _letters(self.cell_mask[cell]):
                    table[l] = math.log1p((other & crossing[l]).bit_count())
                support.append((p, table))

        codes = self.words.codes[length]
        scores = self.words.scores[length]
        checked = len(support) or 1
        noise, rand, weight = self.noise, self.rng.random, self.quality_weight
        ranked = []
        for wid in _bits(self.cands[s]):
            code = codes[wid]
            flex = sum(table[code[p]] for p, table in support) / checked
            ranked.append((flex + weight * scores[wid] + noise * rand(), wid))
        ranked.sort(reverse=True)
        return [wid for _, wid in ranked]

    def search(self):
        s = self._pick_slot()
        if s is None:
            return True
        self.nodes += 1
        self._tick()
        for wid in self._ordered_words(s):
            bit = 1 << wid
            if not self.cands[s] & bit:
                continue  # ruled out while refuting an earlier word
            mark = len(self.trail)
            self._set_cands(s, bit)
            if self.propagate([s]) and self.search():
                return True
            self.undo(mark)
            self.failures += 1
            self.attempt_failures += 1
            if self.attempt_failures >= self.budget:
                raise _Restart
            # That word can't go here: rule it out and propagate what that implies.
            self._set_cands(s, self.cands[s] & ~bit)
            if not self.cands[s] or not self.propagate([s]):
                return False
        return False

    def _tick(self):
        now = time.monotonic()
        if now >= self.deadline:
            raise _OutOfTime
        if self.on_progress and now >= self.next_report:
            self.next_report = now + self.progress_interval
            self.on_progress(self.grid_rows(), self.stats())

    def grid_rows(self):
        rows = []
        for r in range(self.height):
            row = []
            for i in range(r * self.width, (r + 1) * self.width):
                mask = self.cell_mask[i]
                if self.black[i]:
                    row.append(BLACK)
                elif mask & (mask - 1) == 0:
                    row.append(chr(_A + mask.bit_length() - 1))
                else:
                    row.append(" ")
            rows.append(row)
        return rows

    def stats(self):
        return {
            "seconds": round(time.monotonic() - self.started, 2),
            "nodes": self.nodes,
            "failures": self.failures,
            "restarts": self.restarts,
        }


def fill(grid, words, *, time_limit=60.0, quality_weight=0.5, seed=None,
         on_progress=None, progress_interval=1.0):
    """Fill grid from words (a WordList). Returns a FillResult; never raises for bad grids.

    quality_weight: how much word popularity counts against leaving crossings options.
    seed: makes the shuffling after restarts repeatable.
    on_progress(grid_rows, stats): called about every progress_interval seconds.
    """
    started = time.monotonic()
    try:
        search = _Search(grid, words)
    except GridError as error:
        return FillResult(False, None, str(error))
    search.started = started
    search.deadline = started + time_limit
    search.quality_weight = quality_weight
    search.rng = random.Random(seed)
    search.on_progress = on_progress
    search.progress_interval = progress_interval
    search.next_report = started + progress_interval

    if not search.propagate(search.variables):
        name = search.slots[search.dead_slot].name
        return FillResult(False, None, f"no fill exists: nothing in the word list fits {name}", search.stats())

    root = len(search.trail)
    search.budget = _FIRST_BUDGET
    search.noise = 0.0
    while True:
        try:
            solved = search.search()
        except _Restart:
            search.undo(root)
            search.restarts += 1
            search.attempt_failures = 0
            search.budget = int(search.budget * _BUDGET_GROWTH)
            search.noise = _RESTART_NOISE
            continue
        except _OutOfTime:
            return FillResult(False, None, f"no fill found within {time_limit:g}s", search.stats())
        if solved:
            return FillResult(True, search.grid_rows(), "", search.stats())
        # The search tried every word in every slot without a restart, so this is a proof.
        return FillResult(False, None, "no fill exists with this word list", search.stats())


def check_fill(original, filled, words):
    """Independently verify a filled grid. Returns a list of problems (empty if it's valid)."""
    _, width, given, slots = parse_grid(original)
    _, _, got, _ = parse_grid(filled)
    if len(got) != len(given):
        return ["filled grid is a different size"]
    problems = []
    for i, (before, after) in enumerate(zip(given, got)):
        r, c = divmod(i, width)
        if (before == BLACK) != (after == BLACK):
            problems.append(f"black square changed at row {r}, col {c}")
        elif after is None:
            problems.append(f"empty cell at row {r}, col {c}")
        elif before not in (None, after):
            problems.append(f"given letter {before} changed to {after} at row {r}, col {c}")
    if problems:
        return problems
    seen = {}
    for slot in slots:
        word = "".join(got[i] for i in slot.cells)
        if any(given[i] is None for i in slot.cells) and word not in words:
            problems.append(f"{slot.name} {word} is not in the word list")
        if word in seen:
            problems.append(f"{word} is used twice ({seen[word]} and {slot.name})")
        seen[word] = slot.name
    return problems


def format_grid(rows):
    """Printable grid; black squares as '#' since some consoles can't show '■'."""
    return "\n".join(" ".join("#" if ch == BLACK else ch for ch in row) for row in rows)


def main():
    import argparse
    from sample_grids import SAMPLE_GRIDS

    parser = argparse.ArgumentParser(description="Fill a crossword grid.")
    parser.add_argument("grid", nargs="?", default="themed15",
                        help=f"a sample grid ({', '.join(SAMPLE_GRIDS)}) or a text file, one row per line")
    parser.add_argument("--time", type=float, default=60, help="time limit in seconds")
    parser.add_argument("--min-count", type=int, default=1, help="drop words seen fewer times than this")
    parser.add_argument("--quality", type=float, default=0.5, help="weight of word popularity")
    parser.add_argument("--seed", type=int)
    args = parser.parse_args()

    grid = SAMPLE_GRIDS.get(args.grid) or Path(args.grid).read_text(encoding="utf-8").splitlines()
    words = WordList.from_folder(min_count=args.min_count)
    print(f"{len(words)} words loaded")

    def report(rows, stats):
        print(f"  {stats['seconds']:>6}s  nodes {stats['nodes']}  failures {stats['failures']}  restarts {stats['restarts']}")

    result = fill(grid, words, time_limit=args.time, quality_weight=args.quality, seed=args.seed, on_progress=report)
    print(result.stats)
    if not result.success:
        print("FAILED:", result.reason)
        return
    print(format_grid(result.grid))
    problems = check_fill(grid, result.grid, words)
    print("check:", "ok" if not problems else problems)


if __name__ == "__main__":
    main()
