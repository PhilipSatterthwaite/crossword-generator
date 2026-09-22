/* Gridfill solver: fills a crossword grid with words from a scored word list.
   A JavaScript port of filler.py (see its docstring for how the search works),
   tuned for speed. Runs in a page, a Web Worker, or Node.

   Each open slot keeps its candidate words as a bitset that is edited in place,
   plus a list of the bitset's non-empty 32-bit chunks so scans shrink as words
   are ruled out (the "compact table" technique from constraint solvers):
   - a slot only re-filters positions whose cell letters changed since it last
     looked, using whichever is smaller: the letters removed or the letters left;
   - "does any word still have letter l here?" checks the chunk that answered
     last time before scanning;
   - when few words are left, or few were just removed, a slot reads their letters straight
     off instead of asking the bitsets about every letter;
   - each slot's word count is kept up to date, so picking the next slot counts nothing;
   - every change is logged on a typed-array trail, so backing up allocates nothing.

   The next slot to fill is the one with the fewest words left relative to how often
   it and its crossings have run dry ("weighted degree"). Those counts survive
   restarts, so the search learns where the grid's hard corner is and starts there.
   Before the first pick, a quick scan scores each slot's hardness by how well its words'
   letters agree with what its crossings can supply, so heavily crossed long slots (15s)
   go first even though more 15-letter words exist than 3-letter ones. A slot's words are
   ranked when it's picked, but only the best few are found by a scan: the full sort waits
   until they've all failed, which most never do.

   fill() runs two searches on one clock, one holding long entries to a higher score floor, and
   checkOptions() reuses each fill it finds to settle later words cheaply; see each for how. */
(function (root) {
  "use strict";

  const BLOCK = "#";
  const FULL = (1 << 26) - 1;
  const FIRST_BUDGET = 100;  // failures allowed before the first restart
  const BUDGET_GROWTH = 1.5; // each restart allows this many times more
  const RESTART_NOISE = 1.0; // random jitter in word ranking after a restart
  /* Word score counts for more in a long slot than a short one: a weak three lost in the corner
     matters far less than a weak fifteen across the middle. At LENGTH_PIVOT letters the score
     counts as much as qualityWeight says; each letter either side moves it by LENGTH_SLOPE, held
     between LENGTH_FLOOR and LENGTH_CEILING. */
  /* A long entry is also held to a higher score than the grid's minimum: LONG_FROM letters and up,
     each further letter asking LONG_STEP more, up to LONG_MOST above the minimum. A length with too
     few words left to work with (LONG_ENOUGH) keeps the plain minimum instead. */
  const LONG_FROM = 6;
  const LONG_STEP = 4;
  const LONG_MOST = 30;
  const LONG_ENOUGH = 400;
  const GRACE_FACTOR = 3;    // with a plain fill in hand, the strict search may take this many times the plain one's time
  const GRACE_LEAST = 1.5;   // and never less than this many seconds
  const LENGTH_PIVOT = 5;
  const LENGTH_SLOPE = 0.15;
  const LENGTH_FLOOR = 0.4;
  const LENGTH_CEILING = 2.5;
  const SCAN_SAMPLE = 3000;  // most words per slot the hardness scan looks at
  const RESTART = { restart: true };
  const OUT_OF_TIME = { outOfTime: true };

  // Trail entry kinds live in the top bits of each entry's index.
  const WORD = 0;          // index = slot << 12 | chunk
  const LIMIT = 1 << 28;   // index = slot
  const CELL = 2 << 28;    // index = cell
  const LAST = 3 << 28;    // index = slot position
  const COUNT = 4 << 28;   // index = slot
  const KIND = 7 << 28;
  const INDEX = (1 << 28) - 1;

  const ENUMERATE = 256;   // at most this many words left (or just removed): read their letters directly
  const FIRST_PICKS = 3;   // best words found by scanning before a slot's whole list gets sorted

  /* checkOptions: once a fill is known, a "frame" keeps its words in every entry more than a radius
     of crossings from the one being checked, and each word left to settle gets a short search over
     the few entries inside. */
  const FRAME_RADII = [1, 2, 3];
  const FRAME_BUDGET = 30;   // failures a word may cost inside a frame before it waits for a full search
  const FRAME_PINNED = 0.5;  // a radius must keep at least this share of the grid, or it saves nothing
  const CALIBRATE = 2;       // full searches from a known fill to time before any frame runs
  const NEAR_WEIGHT = 2;     // how strongly the full searches favour entries near the one being checked

  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  class GridError extends Error {}

  function popcount32(x) {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
  }

  function mulberry32(seed) {
    let a = seed | 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // --- word list ---

  /* Words grouped by length, best first. For length L, lists[L].index[p][l] is a
     bitset of the words with letter l at position p. */
  class WordList {
    /* data: {length: [letters, counts]} as written by build_words.py */
    constructor(data) {
      this.lists = {};
      this.size = 0;
      for (const key of Object.keys(data)) {
        const length = Number(key);
        const [letters, scoreText, popularText] = data[key];
        const n = letters.length / length;
        const size = (n + 31) >>> 5;
        if (size > 4096) throw new Error(`Too many ${length}-letter words (${n}); the solver handles up to ${4096 * 32}.`);
        const codes = new Uint8Array(n * length);
        const index = [];
        for (let p = 0; p < length; p++) {
          const row = [];
          for (let l = 0; l < 26; l++) row.push(new Uint32Array(size));
          index.push(row);
        }
        for (let i = 0; i < n; i++) {
          const bit = 1 << (i & 31);
          for (let p = 0; p < length; p++) {
            const l = letters.charCodeAt(i * length + p) - 65;
            codes[i * length + p] = l;
            index[p][l][i >>> 5] |= bit;
          }
        }
        // Word scores run 0-100, and build_words.py sorts each length best first.
        const scoreValues = scoreText.split(",");
        const scores = new Float64Array(n);
        for (let i = 0; i < n; i++) scores[i] = Number(scoreValues[i]);
        // Words popular enough to allow below the minimum score: base64 bytes in, a bitset out.
        const popular = new Uint32Array(size);
        if (popularText) {
          const bytes = atob(popularText);
          for (let b = 0; b < bytes.length; b++) popular[b >>> 2] |= bytes.charCodeAt(b) << ((b & 3) * 8);
        }
        this.lists[length] = { length, size, count: n, letters, codes, index, scores, popular, ids: null, cuts: new Map(), gone: null };
        this.size += n;
      }
    }

    /* A list from plain words, all scored equally (handy for tests and custom lists). */
    static fromWords(words) {
      const unique = [...new Set(words.map((w) => w.trim().toUpperCase()).filter((w) => /^[A-Z]+$/.test(w)))].sort();
      const data = {};
      for (const word of unique) (data[word.length] = data[word.length] || []).push(word);
      for (const key of Object.keys(data)) data[key] = [data[key].join(""), data[key].map(() => 50).join(",")];
      return new WordList(data);
    }

    wordId(word) {
      const list = this.lists[word.length];
      if (!list) return undefined;
      if (!list.ids) {
        // Built on first use: a map over every word of every length costs more than it saves.
        list.ids = new Map();
        for (let i = 0; i < list.count; i++) list.ids.set(list.letters.substr(i * list.length, list.length), i);
      }
      const id = list.ids.get(word);
      return id !== undefined && list.gone && list.gone[id >>> 5] & (1 << (id & 31)) ? undefined : id;
    }

    /* Take words out, or with gone false put them back: one bit each, so a word removed by hand
       doesn't mean indexing its whole length again. Returns how many changed. */
    hide(words, gone = true) {
      let changed = 0;
      for (const word of words) {
        const list = this.lists[word.length];
        if (!list) continue;
        if (!list.ids) this.wordId(word);
        const id = list.ids.get(word);
        if (id === undefined) continue;
        const chunk = id >>> 5;
        const bit = 1 << (id & 31);
        if (!list.gone) list.gone = new Uint32Array(list.size);
        if (Boolean(list.gone[chunk] & bit) === gone) continue;
        list.gone[chunk] ^= bit;
        changed++;
        this.size += gone ? -1 : 1;
        if (gone) {
          for (const cut of list.cuts.values()) {
            if (cut.bits[chunk] & bit) {
              cut.bits[chunk] &= ~bit;
              cut.count--;
            }
          }
        } else list.cuts.clear(); // worked out again, with the word back, when next asked for
      }
      return changed;
    }

    /* Put back every word hidden with hide(). */
    unhideAll() {
      for (const list of Object.values(this.lists)) {
        if (!list.gone) continue;
        for (let i = 0; i < list.size; i++) this.size += popcount32(list.gone[i]);
        list.gone = null;
        list.cuts.clear();
      }
    }

    has(word) {
      return this.wordId(word) !== undefined;
    }

    /* The words of a length scoring at least minScore (plus, with allowPopular, popular words
       scoring less), as {count, bits}. Lists are sorted best first, so the words at or above
       minScore are always the first ids. */
    atLeast(length, minScore, allowPopular = false) {
      const list = this.lists[length];
      const key = allowPopular ? `${minScore}+popular` : minScore;
      let cut = list.cuts.get(key);
      if (!cut) {
        let above = 0;
        let high = list.count;
        while (above < high) {
          const middle = (above + high) >>> 1;
          if (list.scores[middle] >= minScore) above = middle + 1;
          else high = middle;
        }
        const bits = new Uint32Array(list.size);
        bits.fill(0xffffffff, 0, above >>> 5);
        if (above & 31) bits[above >>> 5] = 2 ** (above & 31) - 1;
        if (allowPopular) for (let i = 0; i < list.size; i++) bits[i] |= list.popular[i];
        if (list.gone) for (let i = 0; i < list.size; i++) bits[i] &= ~list.gone[i];
        let count = 0;
        for (let i = 0; i < list.size; i++) count += popcount32(bits[i]);
        cut = { count, bits };
        list.cuts.set(key, cut);
      }
      return cut;
    }
  }

  // --- grid ---

  /* grid: rows (strings or arrays). '#' or '■' is a block; ' ', '.', '_' or '' is empty.
     rebus: {square index: letters} for squares holding more than one letter.
     Returns {height, width, cells, slots}; cells hold BLOCK, a letter, or null. A rebus square keeps
     its first letter, and each letter after it gets a square of its own past the grid's (index
     width * height and up) that both of its entries run through, so an entry's cells spell its whole
     answer. */
  function parseGrid(grid, rebus = null) {
    const rows = Array.from(grid, (row) => Array.from(row));
    if (!rows.length || !rows[0].length) throw new GridError("The grid is empty.");
    const width = rows[0].length;
    const height = rows.length;
    if (rows.some((row) => row.length !== width)) throw new GridError("The grid's rows have different lengths.");

    const cells = [];
    rows.forEach((row, r) =>
      row.forEach((ch, c) => {
        if (ch === "#" || ch === "■") cells.push(BLOCK);
        else if (ch == null || ch === "" || ch === " " || ch === "." || ch === "_") cells.push(null);
        else if (/^[A-Za-z]$/.test(ch)) cells.push(ch.toUpperCase());
        else throw new GridError(`Unexpected character "${ch}" at row ${r + 1}, column ${c + 1}.`);
      })
    );

    const white = (r, c) => r >= 0 && r < height && c >= 0 && c < width && cells[r * width + c] !== BLOCK;
    // Runs of 2+ open squares are entries; a lone square in one direction is just unchecked.
    const slots = [];
    let number = 0;
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        if (!white(r, c)) continue;
        const starts = [];
        for (const [direction, dr, dc] of [["across", 0, 1], ["down", 1, 0]]) {
          if (white(r - dr, c - dc)) continue;
          let n = 1;
          while (white(r + dr * n, c + dc * n)) n++;
          if (n >= 2) starts.push([direction, Array.from({ length: n }, (_, i) => (r + dr * i) * width + c + dc * i)]);
        }
        if (starts.length) {
          number++;
          for (const [direction, run] of starts) {
            slots.push({ number, row: r, col: c, direction, cells: run, name: `${number}-${direction === "across" ? "Across" : "Down"}` });
          }
        }
      }
    }
    if (rebus) {
      const squares = new Map(); // rebus square -> the squares its letters are in
      for (const [key, text] of Object.entries(rebus)) {
        const i = Number(key);
        const letters = String(text).toUpperCase();
        if (!/^[A-Z]{2,}$/.test(letters) || !(i >= 0 && i < width * height) || cells[i] === BLOCK) continue;
        cells[i] = letters[0];
        const run = [i];
        for (const letter of letters.slice(1)) {
          run.push(cells.length);
          cells.push(letter);
        }
        squares.set(i, run);
      }
      if (squares.size) for (const slot of slots) slot.cells = slot.cells.flatMap((i) => squares.get(i) || [i]);
    }
    return { height, width, cells, slots };
  }

  // --- search ---

  class Search {
    constructor(grid, words, heuristic, minScore, allowPopular, longStep = LONG_STEP, rebus = null) {
      this.longStep = longStep;
      const { height, width, cells, slots } = parseGrid(grid, rebus);
      this.height = height;
      this.width = width;
      this.slots = slots;
      this.block = cells.map((ch) => ch === BLOCK);
      this.cellMask = Int32Array.from(cells, (ch) => (ch === BLOCK ? 0 : ch === null ? FULL : 1 << (ch.charCodeAt(0) - 65)));
      const cellSlots = cells.map(() => []);
      slots.forEach((slot, s) => slot.cells.forEach((cell, p) => cellSlots[cell].push([s, p])));
      cells.forEach((ch, i) => {
        if (ch === null && !cellSlots[i].length) {
          throw new GridError(`The empty square at row ${Math.floor(i / width) + 1}, column ${(i % width) + 1} isn't part of any entry. Make it a block or open up a neighbor.`);
        }
      });

      // Fully given entries are fixed (they needn't be listed words). Every other
      // entry is a variable whose candidates start as all words of its length.
      const n = slots.length;
      this.list = new Array(n).fill(null);
      this.words = new Array(n).fill(null);  // candidate bitset, edited in place
      this.active = new Array(n).fill(null); // chunk offsets; the first limits[s] are non-empty
      this.limits = new Int32Array(n);
      this.dirty = new Uint8Array(n);        // words removed since the slot last narrowed its cells
      this.dirtyId = new Int32Array(n).fill(-1); // the one word removed since then, or -1 if unknown or several
      this.left = new Int32Array(n);         // how many candidates are left, kept in step with the bitset
      this.learn = true;                     // whether dead ends add to slot weights
      this.raised = false;                   // whether some slot is held above the minimum score (cutFor)
      this.queued = new Uint8Array(n);
      this.weight = new Float64Array(n);     // how often each slot has run dry
      this.hardness = new Float64Array(n);   // log share of words likely to survive crossings (scanHardness)
      this.base = new Int32Array(n);         // offset of the slot's positions in per-position arrays
      this.variables = [];
      this.byLength = new Map();
      const fixedWords = [];
      let positions = 0;
      slots.forEach((slot, s) => {
        this.base[s] = positions;
        positions += slot.cells.length;
        const given = slot.cells.map((i) => cells[i]);
        if (!given.includes(null)) {
          fixedWords.push(given.join(""));
          return;
        }
        const length = slot.cells.length;
        const list = words.lists[length];
        if (!list) {
          throw new GridError(
            length < 3
              ? `${slot.name} is only ${length} letters long. Entries need at least 3, so add or remove a block there.`
              : `${slot.name} needs a ${length}-letter word, and the word list has none that long.`
          );
        }
        this.list[s] = list;
        const cut = this.cutFor(words, length, minScore, allowPopular);
        if (!cut.count) {
          throw new GridError(`No ${length}-letter word scores ${minScore} or more, so ${slot.name} can't be filled. Lower the minimum word score.`);
        }
        this.words[s] = cut.bits.slice();
        // Non-empty chunks first; empty ones wait beyond the limit.
        const active = new Int32Array(list.size);
        let limit = 0;
        for (let i = 0; i < list.size; i++) if (cut.bits[i]) active[limit++] = i;
        for (let i = 0, rest = limit; i < list.size; i++) if (!cut.bits[i]) active[rest++] = i;
        this.active[s] = active;
        this.limits[s] = limit;
        this.left[s] = cut.count;
        this.dirty[s] = 1;
        this.variables.push(s);
        if (!this.byLength.has(length)) this.byLength.set(length, []);
        this.byLength.get(length).push(s);
      });

      // Per slot position: the letters it last saw, the open slot crossing it, and support hints.
      this.lastMask = new Int32Array(positions).fill(FULL);
      this.crossSlot = new Int32Array(positions).fill(-1);
      this.crossPos = new Int32Array(positions);
      this.residue = new Int32Array(positions * 26);
      this.neighbors = slots.map(() => []);
      slots.forEach((slot, s) => {
        slot.cells.forEach((cell, p) => {
          for (const [o, q] of cellSlots[cell]) {
            if (o === s || !this.list[o]) continue;
            this.crossSlot[this.base[s] + p] = o;
            this.crossPos[this.base[s] + p] = q;
            this.neighbors[s].push(o);
          }
        });
      });

      this.tv = new Uint32Array(1 << 16); // trail: old values
      this.ti = new Int32Array(1 << 16);  // trail: kind | index
      this.tp = 0;
      const longest = Math.max(0, ...slots.map((slot) => slot.cells.length));
      this.refs = [];                              // revise scratch: letter bitsets per change
      this.starts = new Int32Array(longest + 1);   // where each change's bitsets start in refs
      this.removes = new Uint8Array(longest);      // whether each change removes its letters
      this.seen = new Int32Array(longest);         // revise scratch: letters seen per position
      this.goneChunk = new Int32Array(ENUMERATE);  // revise scratch: chunks that lost words, and which
      this.goneBits = new Int32Array(ENUMERATE);
      this.wdeg = heuristic === "wdeg";
      this.guide = null; // per slot: the word id to try first, or -1 (a known fill to stay close to)
      this.near = null;  // per slot: crossings away from the entry being checked (checkOptions)
      this.deadSlot = -1;
      this.nodes = 0;
      this.failures = 0;
      this.attemptFailures = 0;
      this.restarts = 0;

      // A given entry that's also a listed word can't be used again elsewhere.
      for (const word of fixedWords) {
        const id = words.wordId(word);
        if (id === undefined) continue;
        for (const s of this.byLength.get(word.length) || []) this.removeWord(s, id);
      }
    }

    // --- trail ---

    save(entry, old) {
      if (this.tp === this.ti.length) {
        const tv = new Uint32Array(this.tv.length * 2);
        const ti = new Int32Array(this.ti.length * 2);
        tv.set(this.tv);
        ti.set(this.ti);
        this.tv = tv;
        this.ti = ti;
      }
      this.tv[this.tp] = old;
      this.ti[this.tp++] = entry;
    }

    undo(mark) {
      const tv = this.tv;
      const ti = this.ti;
      for (let k = this.tp - 1; k >= mark; k--) {
        const entry = ti[k];
        const i = entry & INDEX;
        switch (entry & KIND) {
          case WORD: this.words[i >>> 12][i & 4095] = tv[k]; break;
          case LIMIT: this.limits[i] = tv[k]; break;
          case CELL: this.cellMask[i] = tv[k]; break;
          case COUNT: this.left[i] = tv[k]; break;
          default: this.lastMask[i] = tv[k];
        }
      }
      this.tp = mark;
    }

    // --- candidate bitsets ---

    count(s) {
      return this.left[s];
    }

    isSingleton(s) {
      return this.left[s] === 1;
    }

    firstWord(s) {
      const chunk = this.active[s][0];
      const x = this.words[s][chunk];
      return chunk * 32 + 31 - Math.clz32(x & -x);
    }

    hasWord(s, id) {
      return (this.words[s][id >>> 5] >>> (id & 31)) & 1;
    }

    /* Ascending ids of slot s's candidates. */
    wordIds(s) {
      const words = this.words[s];
      const active = this.active[s];
      const ids = new Int32Array(this.left[s]);
      const limit = this.limits[s];
      let k = 0;
      if (limit * 8 >= words.length) {
        // Most chunks are live: walking them all in order is cheaper than sorting afterwards.
        for (let chunk = 0, size = words.length; chunk < size; chunk++) {
          let x = words[chunk];
          while (x) {
            const t = x & -x;
            ids[k++] = chunk * 32 + 31 - Math.clz32(t);
            x ^= t;
          }
        }
        return ids;
      }
      for (let i = 0; i < limit; i++) {
        const chunk = active[i];
        let x = words[chunk];
        while (x) {
          const t = x & -x;
          ids[k++] = chunk * 32 + 31 - Math.clz32(t);
          x ^= t;
        }
      }
      return ids.sort();
    }

    /* How many of slot s's candidates are also in bits. */
    countAnd(s, bits) {
      const words = this.words[s];
      const active = this.active[s];
      let n = 0;
      for (let i = 0, limit = this.limits[s]; i < limit; i++) {
        const chunk = active[i];
        n += popcount32(words[chunk] & bits[chunk]);
      }
      return n;
    }

    removeWord(s, id) {
      const words = this.words[s];
      const chunk = id >>> 5;
      const old = words[chunk];
      const bit = 1 << (id & 31);
      if (!(old & bit)) return false;
      const next = (old & ~bit) >>> 0;
      this.save(WORD | (s << 12) | chunk, old);
      words[chunk] = next;
      this.save(COUNT | s, this.left[s]);
      this.left[s]--;
      this.dirtyId[s] = this.dirty[s] ? -1 : id;
      this.dirty[s] = 1;
      if (next === 0) {
        const active = this.active[s];
        const limit = this.limits[s];
        for (let i = 0; i < limit; i++) {
          if (active[i] === chunk) {
            active[i] = active[limit - 1];
            active[limit - 1] = chunk;
            break;
          }
        }
        this.save(LIMIT | s, limit);
        this.limits[s] = limit - 1;
      }
      return true;
    }

    assignWord(s, id) {
      const words = this.words[s];
      const active = this.active[s];
      const keep = id >>> 5;
      const bit = (1 << (id & 31)) >>> 0;
      const limit = this.limits[s];
      for (let i = 0; i < limit; i++) {
        const chunk = active[i];
        const next = chunk === keep ? bit : 0;
        if (words[chunk] !== next) {
          this.save(WORD | (s << 12) | chunk, words[chunk]);
          words[chunk] = next;
        }
        if (chunk === keep) {
          active[i] = active[0];
          active[0] = chunk;
        }
      }
      this.save(LIMIT | s, limit);
      this.limits[s] = 1;
      this.save(COUNT | s, this.left[s]);
      this.left[s] = 1;
      this.dirty[s] = 1;
      this.dirtyId[s] = -1;
    }

    /* Does some candidate of slot s have letter l at the position whose support hint is r? */
    supported(s, r, bits) {
      const words = this.words[s];
      const hint = this.residue[r];
      if (words[hint] & bits[hint]) return true;
      const active = this.active[s];
      for (let i = 0, limit = this.limits[s]; i < limit; i++) {
        const chunk = active[i];
        if (words[chunk] & bits[chunk]) {
          this.residue[r] = chunk;
          return true;
        }
      }
      return false;
    }

    // --- propagation ---

    /* Revise slots until nothing changes. False if some slot runs out of words. */
    propagate(start) {
      const queue = [];
      let head = 0;
      for (const s of start) this.enqueue(queue, s);
      while (head < queue.length) {
        const s = queue[head++];
        this.queued[s] = 0;
        if (!this.revise(s, queue)) {
          this.deadSlot = s;
          for (let k = head; k < queue.length; k++) this.queued[queue[k]] = 0;
          return false;
        }
      }
      return true;
    }

    enqueue(queue, s) {
      if (!this.queued[s]) {
        this.queued[s] = 1;
        queue.push(s);
      }
    }

    revise(s, queue) {
      const cells = this.slots[s].cells;
      const length = cells.length;
      const base = this.base[s];
      const list = this.list[s];
      const wasDirty = this.dirty[s] === 1;
      this.dirty[s] = 0;

      // Collect positions whose letters changed since this slot last looked. Each becomes a
      // set of letter bitsets to keep, or to remove when that set is smaller. Keeps go first:
      // one kept letter rules out most words, so chunks empty out early.
      const refs = this.refs;
      const starts = this.starts;
      const removes = this.removes;
      refs.length = 0;
      let changes = 0;
      let source = -1;
      for (let pass = 0; pass < 2; pass++) {
        for (let p = 0; p < length; p++) {
          const current = this.cellMask[cells[p]];
          const last = this.lastMask[base + p];
          if (current === last) continue;
          const removed = last & ~current;
          const byRemoved = popcount32(removed) < popcount32(current);
          if (byRemoved !== (pass === 1)) continue;
          this.save(LAST | (base + p), last);
          this.lastMask[base + p] = current;
          starts[changes] = refs.length;
          removes[changes++] = pass;
          for (let m = byRemoved ? removed : current; m; m &= m - 1) refs.push(list.index[p][31 - Math.clz32(m & -m)]);
          source = p;
        }
      }
      starts[changes] = refs.length;

      // Apply every change in one pass over the slot's non-empty chunks.
      let removedAny = false;
      let removedCount = 0;
      let gone = 0; // chunks noted in goneChunk/goneBits; -1 once there are too many to note
      const goneChunk = this.goneChunk;
      const goneBits = this.goneBits;
      const dirtyId = this.dirtyId[s];
      if (changes) {
        const words = this.words[s];
        const active = this.active[s];
        const oldLimit = this.limits[s];
        const single = changes === 1 && refs.length === 1 ? refs[0] : null;
        const negate = removes[0] === 1;
        let limit = oldLimit;
        for (let i = limit - 1; i >= 0; i--) {
          const chunk = active[i];
          const old = words[chunk];
          let keep = old;
          if (single !== null) {
            // The usual case, one letter kept or removed at one position: no inner loops.
            keep = negate ? old & ~single[chunk] : old & single[chunk];
          } else {
            for (let j = 0; j < changes && keep !== 0; j++) {
              let m = 0;
              for (let k = starts[j], end = starts[j + 1]; k < end; k++) m |= refs[k][chunk];
              keep = removes[j] ? keep & ~m : keep & m;
            }
          }
          keep >>>= 0;
          if (keep !== old) {
            this.save(WORD | (s << 12) | chunk, old);
            words[chunk] = keep;
            const lost = old ^ keep;
            removedCount += popcount32(lost);
            if (gone >= 0) {
              if (gone < ENUMERATE) {
                goneChunk[gone] = chunk;
                goneBits[gone++] = lost;
              } else gone = -1;
            }
            if (keep === 0) {
              active[i] = active[--limit];
              active[limit] = chunk;
            }
          }
        }
        if (removedCount) {
          removedAny = true;
          this.save(COUNT | s, this.left[s]);
          this.left[s] -= removedCount;
        }
        if (limit !== oldLimit) {
          this.save(LIMIT | s, oldLimit);
          this.limits[s] = limit;
        }
        if (limit === 0) {
          if (this.learn) this.weight[s]++;
          return false;
        }
      }
      if (!wasDirty && !removedAny) return true;

      // A slot down to one word owns it: no other slot may use it.
      if (this.left[s] === 1) {
        const id = this.firstWord(s);
        for (const o of this.byLength.get(length)) {
          if (o === s || !this.removeWord(o, id)) continue;
          if (this.limits[o] === 0) {
            if (this.learn) this.weight[o]++;
            return false;
          }
          this.enqueue(queue, o);
        }
      }

      // Narrow crossing cells to letters some remaining word still uses. With few words left, read
      // their letters straight off (mode 1). With few just removed, only the letters those words
      // used can have lost their support (mode 2). Otherwise ask about every letter (mode 0).
      const codes = list.codes;
      const seen = this.seen;
      let mode = 0;
      if (this.left[s] <= ENUMERATE) {
        mode = 1;
        seen.fill(0, 0, length);
        const words = this.words[s];
        const active = this.active[s];
        for (let i = 0, limit = this.limits[s]; i < limit; i++) {
          const chunk = active[i];
          for (let x = words[chunk]; x; x &= x - 1) {
            const offset = (chunk * 32 + 31 - Math.clz32(x & -x)) * length;
            for (let p = 0; p < length; p++) seen[p] |= 1 << codes[offset + p];
          }
        }
      } else if (gone >= 0 && removedCount <= ENUMERATE && (!wasDirty || dirtyId >= 0)) {
        mode = 2;
        seen.fill(0, 0, length);
        for (let i = 0; i < gone; i++) {
          const chunk = goneChunk[i];
          for (let x = goneBits[i]; x; x &= x - 1) {
            const offset = (chunk * 32 + 31 - Math.clz32(x & -x)) * length;
            for (let p = 0; p < length; p++) seen[p] |= 1 << codes[offset + p];
          }
        }
        if (wasDirty) for (let p = 0, offset = dirtyId * length; p < length; p++) seen[p] |= 1 << codes[offset + p];
      }
      // If one position caused every removal, its own letters all kept their support, so skip it.
      const skip = !wasDirty && changes === 1 ? source : -1;
      for (let p = 0; p < length; p++) {
        const o = this.crossSlot[base + p];
        if (o < 0 || p === skip) continue;
        const cell = cells[p];
        const mask = this.cellMask[cell];
        if ((mask & (mask - 1)) === 0) continue;
        let next = mask;
        if (mode === 1) {
          next = mask & seen[p];
        } else {
          for (let m = mode === 2 ? mask & seen[p] : mask; m; m &= m - 1) {
            const l = 31 - Math.clz32(m & -m);
            if (!this.supported(s, (base + p) * 26 + l, list.index[p][l])) next &= ~(1 << l);
          }
        }
        if (next !== mask) {
          this.save(CELL | cell, mask);
          this.cellMask[cell] = next;
          this.save(LAST | (base + p), this.lastMask[base + p]);
          this.lastMask[base + p] = next;
          this.enqueue(queue, o);
        }
      }
      return true;
    }

    // --- search ---

    /* Before searching, estimate how hard each open slot is, looking `layers` crossings deep.
       A slot's hardness is the log of the share of its words whose letters agree with what its
       crossings can supply. At one layer that's each crossing's raw letter mix; at each deeper
       layer, the crossings' words are first weighted by how well they agree with their own
       crossings. A 15 crossed at every square scores far lower (harder) than a 3, even though
       more 15-letter words exist. Big slots are estimated from an even sample of their words. */
    scanHardness(layers, sample = SCAN_SAMPLE) {
      const n = this.slots.length;
      const samples = new Array(n).fill(null);    // candidate ids per slot, sampled
      const logWeights = new Array(n).fill(null); // log weight per sampled word
      const mixes = new Array(n).fill(null);      // mixes[s][p * 26 + l]: weighted share with letter l at p
      for (const s of this.variables) {
        let ids = this.wordIds(s);
        if (ids.length > sample) {
          const stride = ids.length / sample;
          ids = Int32Array.from({ length: sample }, (_, k) => ids[Math.floor(k * stride)]);
        }
        samples[s] = ids;
        logWeights[s] = new Float64Array(ids.length);
        mixes[s] = new Float64Array(this.slots[s].cells.length * 26);
      }
      const logMeanExp = (values) => {
        let max = -Infinity;
        for (const x of values) if (x > max) max = x;
        let total = 0;
        for (const x of values) total += Math.exp(x - max);
        return max + Math.log(total / values.length);
      };

      for (let layer = 0; layer < layers; layer++) {
        // Every slot's letter mix under the current weights.
        for (const s of this.variables) {
          const ids = samples[s];
          const logw = logWeights[s];
          const mix = mixes[s];
          const length = this.slots[s].cells.length;
          const codes = this.list[s].codes;
          let max = -Infinity;
          for (const x of logw) if (x > max) max = x;
          mix.fill(0);
          let total = 0;
          for (let k = 0; k < ids.length; k++) {
            const w = Math.exp(logw[k] - max);
            const offset = ids[k] * length;
            total += w;
            for (let p = 0; p < length; p++) mix[p * 26 + codes[offset + p]] += w;
          }
          // Stored as logs: the reweighting below reads each entry thousands of times.
          for (let i = 0; i < mix.length; i++) mix[i] = Math.log(mix[i] / total + 1e-9);
        }
        // Reweight every word by how well its letters agree with its crossings' mixes.
        for (const s of this.variables) {
          const ids = samples[s];
          const logw = logWeights[s];
          const length = this.slots[s].cells.length;
          const codes = this.list[s].codes;
          const base = this.base[s];
          for (let k = 0; k < ids.length; k++) {
            const offset = ids[k] * length;
            let sum = 0;
            for (let p = 0; p < length; p++) {
              const o = this.crossSlot[base + p];
              if (o >= 0) sum += mixes[o][this.crossPos[base + p] * 26 + codes[offset + p]];
            }
            logw[k] = sum;
          }
        }
      }
      for (const s of this.variables) this.hardness[s] = logMeanExp(logWeights[s]);
    }

    /* The open slot with the fewest words left, scaled by its scanned hardness (lookahead)
       and by how troublesome it and its crossings have been (wdeg); longer slots win ties. */
    pickSlot() {
      let best = -1;
      let bestScore = Infinity;
      let bestLength = 0;
      for (const s of this.variables) {
        if (this.isSingleton(s)) continue;
        let score = Math.log(this.count(s)) + this.lookahead * this.hardness[s];
        if (this.near !== null) score += NEAR_WEIGHT * this.near[s];
        if (this.wdeg) {
          let weight = 1 + this.weight[s];
          for (const o of this.neighbors[s]) if (!this.isSingleton(o)) weight += this.weight[o];
          score -= Math.log(weight);
        }
        const length = this.slots[s].cells.length;
        if (score < bestScore || (score === bestScore && length > bestLength)) {
          best = s;
          bestScore = score;
          bestLength = length;
        }
      }
      return best;
    }

    /* The words a slot of this length may use. A weak three in a corner costs the puzzle little; a
       weak fifteen across the middle is the thing people notice, so long entries are held to a
       higher score than the grid's minimum — unless that leaves them too little to work with. */
    cutFor(words, length, minScore, allowPopular) {
      const over = Math.max(0, length - LONG_FROM);
      const raised = Math.min(100, minScore + Math.min(LONG_MOST, this.longStep * over));
      if (raised > minScore) {
        const strict = words.atLeast(length, raised, allowPopular);
        if (strict.count >= LONG_ENOUGH) {
          this.raised = true;
          return strict;
        }
      }
      return words.atLeast(length, minScore, allowPopular);
    }

    /* How much word score counts for a slot of this length, as a multiple of qualityWeight. */
    lengthWeight(length) {
      const weight = 1 + this.lengthSlope * (length - LENGTH_PIVOT);
      return Math.min(LENGTH_CEILING, Math.max(LENGTH_FLOOR, weight));
    }

    /* Slot s's words and a key to rank each by, higher first: a good score, and leaving crossing
       slots the most options. */
    rankWords(s) {
      const cells = this.slots[s].cells;
      const length = cells.length;
      const base = this.base[s];
      const list = this.list[s];
      const positions = [];
      const tables = [];
      for (let p = 0; p < length; p++) {
        const o = this.crossSlot[base + p];
        if (o < 0 || this.isSingleton(o)) continue;
        const crossing = this.list[o].index[this.crossPos[base + p]];
        const table = new Float64Array(26);
        for (let m = this.cellMask[cells[p]]; m; m &= m - 1) {
          const l = 31 - Math.clz32(m & -m);
          table[l] = Math.log1p(this.countAnd(o, crossing[l]));
        }
        positions.push(p);
        tables.push(table);
      }
      const ids = this.wordIds(s);
      const checked = tables.length || 1;
      const keys = new Float64Array(ids.length);
      const { codes, scores } = list;
      // How much a good word is worth here. The jitter that shakes up a restart grows with it, so
      // a long slot can still be reshuffled rather than trying the same best words for ever.
      const quality = this.qualityWeight * this.lengthWeight(length);
      const shake = this.noise ? this.noise * (quality / this.qualityWeight || 1) : 0;
      for (let k = 0; k < ids.length; k++) {
        const id = ids[k];
        let flex = 0;
        for (let j = 0; j < tables.length; j++) flex += tables[j][codes[id * length + positions[j]]];
        const jitter = shake ? shake * this.random() : 0;
        keys[k] = flex / checked + quality * scores[id] + jitter;
      }
      return { ids, keys };
    }

    /* The rest of a ranked list in order, once the first few picks are used up. */
    sortRanked(ids, keys) {
      const left = [];
      for (let k = 0; k < ids.length; k++) if (keys[k] > -Infinity) left.push(k);
      const order = Uint32Array.from(left);
      order.sort((a, b) => keys[b] - keys[a] || ids[b] - ids[a]);
      return order;
    }

    search() {
      const s = this.pickSlot();
      if (s < 0) return true;
      this.nodes++;
      this.tick();
      const single = [s];
      // A word this slot held in an earlier fill goes first: most of a known fill usually still stands.
      let guided = this.guide ? this.guide[s] : -1;
      if (guided >= 0 && !this.hasWord(s, guided)) guided = -1;
      let first = guided;
      let ids = null;
      let keys = null;
      let order = null;
      let at = 0;
      let picks = 0;
      for (;;) {
        let id = first;
        first = -1;
        if (id < 0) {
          if (ids === null) ({ ids, keys } = this.rankWords(s));
          // The first few come from a scan for the best key; sorting the lot waits until they fail.
          if (picks < FIRST_PICKS && order === null) {
            let best = -1;
            let bestKey = -Infinity;
            for (let k = 0; k < keys.length; k++) {
              const key = keys[k];
              if (key >= bestKey && key > -Infinity) {
                best = k;
                bestKey = key;
              }
            }
            if (best < 0) break;
            id = ids[best];
            keys[best] = -Infinity;
            picks++;
          } else {
            if (order === null) order = this.sortRanked(ids, keys);
            if (at >= order.length) break;
            id = ids[order[at++]];
          }
          if (id === guided) continue;
        }
        if (!this.hasWord(s, id)) continue; // ruled out while refuting an earlier word
        const mark = this.tp;
        this.assignWord(s, id);
        if (this.propagate(single) && this.search()) return true;
        this.undo(mark);
        this.failures++;
        if (++this.attemptFailures >= this.budget) throw RESTART;
        // That word can't go here: rule it out and propagate what that implies.
        this.removeWord(s, id);
        if (this.limits[s] === 0 || !this.propagate(single)) return false;
      }
      return false;
    }

    /* Search from the current state until deadline. true: solved, and the state holds the
       fill; false: proven impossible; null: out of time. Unless solved, the state is restored. */
    solve(deadline) {
      this.beginSolve();
      for (;;) {
        const result = this.round(deadline);
        if (result !== RESTART) return result;
      }
    }

    beginSolve() {
      this.budget = FIRST_BUDGET;
      this.attemptFailures = 0;
      this.noise = this.baseNoise;
    }

    /* One attempt, up to its failure budget: true, false or null as solve, or RESTART. */
    round(deadline) {
      const root = this.tp;
      this.deadline = deadline;
      try {
        if (this.search()) return true;
        this.undo(root);
        return false; // every word was tried in every slot without a restart
      } catch (signal) {
        this.undo(root);
        if (signal === OUT_OF_TIME) return null;
        if (signal !== RESTART) throw signal;
        this.restarts++;
        this.attemptFailures = 0;
        this.budget = Math.floor(this.budget * BUDGET_GROWTH);
        this.noise = RESTART_NOISE;
        return RESTART;
      }
    }

    tick() {
      const t = now();
      if (t >= this.deadline) throw OUT_OF_TIME;
      if (this.onProgress && t >= this.nextReport) {
        this.nextReport = t + this.progressInterval;
        this.onProgress(this.gridRows(), this.stats());
      }
    }

    /* Rows of '#', a letter, or '' where the letter isn't settled yet. */
    gridRows() {
      const letters = new Array(this.cellMask.length).fill("");
      this.cellMask.forEach((mask, i) => {
        if (this.block[i]) letters[i] = BLOCK;
        else if ((mask & (mask - 1)) === 0) letters[i] = String.fromCharCode(65 + 31 - Math.clz32(mask));
      });
      for (const s of this.variables) {
        if (!this.isSingleton(s)) continue;
        const { cells } = this.slots[s];
        const id = this.firstWord(s);
        const codes = this.list[s].codes;
        cells.forEach((cell, p) => (letters[cell] = String.fromCharCode(65 + codes[id * cells.length + p])));
      }
      const rows = [];
      for (let r = 0; r < this.height; r++) rows.push(letters.slice(r * this.width, (r + 1) * this.width));
      return rows;
    }

    stats() {
      return {
        seconds: Math.round(now() - this.started) / 1000,
        nodes: this.nodes,
        failures: this.failures,
        restarts: this.restarts,
      };
    }
  }

  /* Set up a search over grid and propagate the given letters. Returns {search}, or
     {error} (with the search when it was built) if the grid can't be filled as drawn.
     options: minScore (0-100), allowPopular (also allow popular words scoring under
     minScore), qualityWeight, lengthSlope (how much more a good word counts per letter over five;
     0 weighs every length the same), longStep (how much higher the score floor climbs per letter
     past six; 0 holds every length to the same floor), seed, variety (shuffle from the start for
     a different fill), heuristic ("wdeg" or "mrv"), lookahead (how much scanned hardness
     counts when picking the next slot; 0 turns the scan off), layers (how many crossings
     deep the scan looks) and scanSample (most words per slot the scan samples; a smaller sample
     still spots a clearly better grid, which is what the designer screens patterns with). */
  function prepare(grid, words, options = {}) {
    const { minScore = 0, allowPopular = false, qualityWeight = 0.035, lengthSlope = LENGTH_SLOPE, longStep = LONG_STEP, seed = 1, variety = false, heuristic = "wdeg", lookahead = 1, layers = 1, scanSample = SCAN_SAMPLE } = options;
    let search;
    try {
      search = new Search(grid, words, heuristic, minScore, allowPopular, longStep, options.rebus || null);
    } catch (error) {
      if (error instanceof GridError) return { error: error.message };
      throw error;
    }
    Object.assign(search, {
      started: now(),
      deadline: Infinity,
      qualityWeight,
      lengthSlope,
      random: mulberry32(seed),
      baseNoise: variety ? RESTART_NOISE : 0,
      onProgress: null,
      lookahead,
    });
    if (search.variables.some((s) => search.limits[s] === 0) || !search.propagate(search.variables)) {
      const dead = search.deadSlot >= 0 ? search.deadSlot : search.variables.find((s) => search.limits[s] === 0);
      return { search, error: `No fill exists: nothing in the word list fits ${search.slots[dead].name} with the letters around it.` };
    }
    if (lookahead > 0) search.scanHardness(layers, scanSample);
    return { search };
  }

  /* Word ids per slot from the rows of an earlier fill, for slots still open; -1 where that fill's
     letters don't spell a listed word. */
  function guideFrom(search, words, rows) {
    const letters = Array.from(rows, (row) => Array.from(row)).flat();
    const guide = new Int32Array(search.slots.length).fill(-1);
    for (const v of search.variables) {
      const id = words.wordId(search.slots[v].cells.map((cell) => letters[cell] || "?").join(""));
      if (id !== undefined) guide[v] = id;
    }
    return guide;
  }

  /* Fill grid from words (a WordList). Never throws for bad grids; returns
     {success, grid, reason, stats, phase}. phase says which search found the fill: "strict", with long
     entries held above the minimum score, or "plain". options: those of prepare, plus timeLimit
     (seconds), onProgress(rows, stats), progressInterval (seconds) and guide (the rows of an earlier
     fill of this grid: each entry tries the word it held there first, so a fill redone after a small
     change keeps most of what was there). */
  function fill(grid, words, options = {}) {
    if (options.required && options.required.length) return fillWithTheme(grid, words, options);
    const { timeLimit = 30, onProgress = null, progressInterval = 0.25, longStep = LONG_STEP, guide = null } = options;
    const started = now();
    const deadline = started + timeLimit * 1000;
    let strict = null;
    let plain = null;
    const totals = () => {
      const stats = (plain || strict).stats();
      if (plain && strict) for (const key of ["nodes", "failures", "restarts"]) stats[key] += strict[key];
      return stats;
    };
    const ready = (step) => {
      const { search, error } = prepare(grid, words, { ...options, longStep: step });
      if (search && !error) {
        search.onProgress = onProgress && ((rows) => onProgress(rows, totals()));
        search.progressInterval = progressInterval * 1000;
        search.started = started; // one clock across both searches, so progress and stats add up
        search.nextReport = now() + search.progressInterval;
        if (guide) search.guide = guideFrom(search, words, guide);
        search.beginSolve();
      }
      return { search, error };
    };

    /* Two searches share the clock: a strict one that holds long entries above the grid's minimum
       score, and a plain one that doesn't. They take turns a restart's worth at a time, whichever has
       had less time going next, so a grid the raised floors can't fill costs about twice what the
       plain search needs rather than a fixed share of the limit. A strict fill is returned at once. A
       plain fill waits while the strict search gets a last chance, until it has had GRACE_FACTOR
       times the plain search's time (and at least GRACE_LEAST seconds), since a strict fill is the
       better one. The plain search is only set up once the strict one has run out its first budget,
       so a grid that fills easily pays nothing for it. */
    if (longStep > 0) {
      const attempt = ready(longStep);
      // Nothing is held higher on this grid, or the raised floors leave some entry no words at all.
      if (!attempt.error && attempt.search.raised) strict = attempt.search;
    }
    let strictOpen = strict !== null; // still worth running
    let held = null;
    const used = { strict: 0, plain: 0 };
    for (;;) {
      let turn;
      if (held || !plain) turn = strictOpen && (held || used.strict === 0) ? "strict" : "plain";
      else turn = strictOpen && used.strict <= used.plain ? "strict" : "plain";
      if (turn === "plain" && !plain) {
        const attempt = ready(0);
        if (attempt.error) return { success: false, grid: null, reason: attempt.error, stats: attempt.search ? attempt.search.stats() : {} };
        plain = attempt.search;
      }
      const search = turn === "strict" ? strict : plain;
      const until = held ? Math.min(deadline, now() + Math.max(GRACE_LEAST * 1000, GRACE_FACTOR * used.plain) - used.strict) : deadline;
      const began = now();
      const result = until > began ? search.round(until) : null;
      used[turn] += now() - began;
      if (result === RESTART) continue;
      if (turn === "strict") {
        if (result === true) return { success: true, grid: search.gridRows(), reason: "", stats: totals(), phase: "strict" };
        if (held || result === null) break; // its last chance is over, or the whole time limit is
        strictOpen = false; // impossible with the raised floors: the plain search carries on alone
        continue;
      }
      if (result === true) {
        held = { success: true, grid: search.gridRows(), reason: "", stats: null, phase: "plain" };
        if (!strictOpen) break;
      } else if (result === false) {
        return { success: false, grid: null, reason: "No fill exists for this grid with these words. Try moving a block, removing a letter, or lowering the minimum word score.", stats: totals() };
      } else break; // out of time
    }
    if (!held) return { success: false, grid: null, reason: `No fill found within ${timeLimit} seconds. Try moving a block, or run it again.`, stats: totals(), timedOut: true };
    held.stats = totals();
    return held;
  }

  /* fill() for a grid that must also hold some theme words (options.required), wherever they fit.
     Theme words the given letters already spell count as placed. The rest go into the entries they
     fit, longest first; a placement that leaves some entry no word at all is dropped at once, and
     each other one gets a short fill search of its own. Placements that ran out of time get longer
     searches once every placement has had a turn. Without variety, a theme word goes first where an
     earlier fill (options.guide) had it, then where it would mirror one of the same length (turned
     180°), then across before down. */
  function fillWithTheme(grid, words, options) {
    const { timeLimit = 30, onProgress = null, variety = false, seed = 1, guide = null } = options;
    const started = now();
    const deadline = started + timeLimit * 1000;
    const before = guide ? Array.from(guide, (row) => Array.from(row)).flat() : null;
    const plain = { ...options, required: null };
    const fail = (reason, stats = {}) => ({ success: false, grid: null, reason, stats });
    let parsed;
    try {
      parsed = parseGrid(grid, options.rebus || null);
    } catch (error) {
      if (error instanceof GridError) return fail(error.message);
      throw error;
    }
    const { cells, slots, width, height } = parsed;
    const given = new Set();
    for (const slot of slots) {
      const letters = slot.cells.map((i) => cells[i]);
      if (letters.every(Boolean)) given.add(letters.join(""));
    }
    const todo = [...new Set(options.required.map((word) => String(word).toUpperCase().replace(/[^A-Z]/g, "")))].filter((word) => word.length >= 2 && !given.has(word));
    if (!todo.length) return fill(grid, words, plain);

    const letters = cells.slice();
    const fits = (word, slot) => slot.cells.length === word.length && slot.cells.every((i, p) => !letters[i] || letters[i] === word[p]);
    for (const word of todo) {
      if (!slots.some((slot) => fits(word, slot))) return fail(`No ${word.length}-letter entry in the grid can take the theme entry ${word}.`);
    }
    todo.sort((a, b) => b.length - a.length || slots.filter((slot) => fits(a, slot)).length - slots.filter((slot) => fits(b, slot)).length);

    // Each slot's mirror image, turned 180°.
    const byStart = new Map(slots.map((slot, s) => [`${slot.direction}:${slot.cells[0]}`, s]));
    const mirror = slots.map((slot) => byStart.get(`${slot.direction}:${width * height - 1 - slot.cells[slot.cells.length - 1]}`));
    const random = mulberry32(seed);
    const rows = () => Array.from({ length: height }, (_, r) => letters.slice(r * width, (r + 1) * width).map((ch) => ch || ""));
    const opens = () => !prepare(rows(), words, { ...plain, longStep: 0, lookahead: 0 }).error;
    const used = [];
    let placed = 0; // placements that didn't break the grid at once

    function* placements(k) {
      if (k === todo.length) {
        placed++;
        yield rows();
        return;
      }
      const word = todo[k];
      let order = slots.map((_, s) => s).filter((s) => !used.includes(s) && fits(word, slots[s]));
      if (variety) {
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
      } else {
        const mirrors = new Set(used.filter((s) => slots[s].cells.length === word.length).map((s) => mirror[s]));
        const guided = (s) => before && slots[s].cells.every((i, p) => before[i] === word[p]);
        const rank = (s) => (guided(s) ? -4 : 0) + (mirrors.has(s) ? 0 : 2) + (slots[s].direction === "across" ? 0 : 1);
        order = order.map((s, at) => [rank(s), at, s]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((entry) => entry[2]);
      }
      for (const s of order) {
        if (now() >= deadline) return;
        const { cells: run } = slots[s];
        const before = run.map((i) => letters[i]);
        run.forEach((i, p) => (letters[i] = word[p]));
        used.push(s);
        if (opens()) yield* placements(k + 1);
        used.pop();
        run.forEach((i, p) => (letters[i] = before[p]));
      }
    }

    let stats = {};
    const attempt = (grid, seconds) => {
      const result = fill(grid, words, {
        ...plain,
        timeLimit: seconds,
        onProgress: onProgress && ((partial, progress) => onProgress(partial, { ...progress, seconds: (now() - started) / 1000 })),
      });
      stats = { ...result.stats, seconds: (now() - started) / 1000 };
      result.stats = stats;
      return result;
    };
    const left = () => (deadline - now()) / 1000;
    let seconds = Math.max(1, timeLimit / 10);
    const waiting = []; // placements whose search ran out of time
    for (const grid of placements(0)) {
      if (left() <= 0) break;
      const result = attempt(grid, Math.min(left(), seconds));
      if (result.success) return result;
      if (result.timedOut) waiting.push(grid);
    }
    while (waiting.length && left() > 0) {
      seconds *= 2;
      for (let k = 0; k < waiting.length && left() > 0; ) {
        const result = attempt(waiting[k], Math.min(left(), seconds));
        if (result.success) return result;
        if (result.timedOut) k++;
        else waiting.splice(k, 1);
      }
    }
    if (left() <= 0) return fail(`No fill with the theme entries found within ${timeLimit} seconds. Try moving a block, or run it again.`, stats);
    if (!placed) {
      // Name the theme words that can't go anywhere even on their own.
      const alone = (word) => slots.some((slot) => {
        if (!fits(word, slot)) return false;
        const was = slot.cells.map((i) => letters[i]);
        slot.cells.forEach((i, p) => (letters[i] = word[p]));
        const open = opens();
        slot.cells.forEach((i, p) => (letters[i] = was[p]));
        return open;
      });
      const stuck = todo.filter((word) => !alone(word));
      if (stuck.length) {
        const names = stuck.length === 1 ? stuck[0] : `${stuck.slice(0, -1).join(", ")} and ${stuck[stuck.length - 1]}`;
        return fail(`${names} can't go in any entry that fits without leaving a crossing entry no word fits. Move a block, clear some letters or lower the minimum score.`, stats);
      }
      return fail("The theme entries can't all go in this grid together: every way of placing them leaves some entry no word fits.", stats);
    }
    return fail("No fill exists with the theme entries in any of the places they fit. Try moving a block or lowering the minimum word score.", stats);
  }

  /* Check which candidate words for one entry can be part of a full fill, from the top of the
     list down.
     target: {row, col, direction} of the entry; candidates: words, checked in this order.
     options: those of prepare, plus perWordSeconds.
     Returns {error}, or a checker with:
     - step(ms): checks words for about ms milliseconds and returns
       {updates: [[index, status, rows?], ...], done}. Statuses: "works" (a full fill uses the
       word, and rows is that fill), "fails" (no fill can use it), "unknown" (no fill found
       within perWordSeconds). A word reported "unknown" may be reported again later as "works".
     - prioritize(index, seconds): check that word next, allowing it seconds.

     Most words share most of a fill with the words around them, so each check reuses the fills
     found before it. A full search tries each entry's word from the last fill first, and works
     outward from the target entry so a dead end near it shows up at once. Each fill found also
     becomes a few frames (see FRAME_RADII): in one, its words stay put beyond the radius, and every
     word still to settle gets a short search over the entries inside. A word that fits a frame
     works, and that's that; one that doesn't learns nothing, and waits for its own full search, so
     "fails" still means a complete search found no fill. A radius that costs more per word than a
     full search is dropped. */
  function checkOptions(grid, words, target, candidates, options = {}) {
    const { perWordSeconds = 0.5 } = options;
    // Picking a word by hand is the constructor's call, so the higher floor long entries get from
    // the autofill doesn't apply here: nothing legal is hidden from the options list.
    const { search, error } = prepare(grid, words, { longStep: 0, ...options });
    if (!search) return { error };
    const s = search.slots.findIndex((slot) => slot.row === target.row && slot.col === target.col && slot.direction === target.direction);
    if (s < 0) return { error: "That entry isn't in the grid any more." };
    if (!search.list[s]) return { error: "That entry is already complete." };
    const noFillAtAll = Boolean(error);
    const ids = candidates.map((word) => words.wordId(word));
    const PENDING = 0, WORKS = 1, FAILS = 2, UNKNOWN = 3;
    const state = new Uint8Array(candidates.length);
    let open = candidates.length; // candidates still PENDING
    let next = 0;
    let urgent = null;
    let screened = false;

    // How many crossings each open slot is from the target.
    const distance = new Int32Array(search.slots.length).fill(1 << 30);
    distance[s] = 0;
    for (let ring = [s], d = 1; ring.length; d++) {
      const outer = [];
      for (const v of ring) {
        for (const o of search.neighbors[v]) {
          if (distance[o] > d) {
            distance[o] = d;
            outer.push(o);
          }
        }
      }
      ring = outer;
    }
    search.near = distance;
    const rootMark = search.tp;
    const waiting = []; // frames not yet run: {fill, radius}
    let frame = null;   // the frame being run: {fill, radius, list, at, entered}

    const fillIds = () => {
      const fill = new Int32Array(search.slots.length).fill(-1);
      for (const v of search.variables) fill[v] = search.firstWord(v);
      return fill;
    };
    // A radius that leaves most of the grid free is no short cut, just a second full search.
    const radii = FRAME_RADII.filter((radius) => {
      let pinned = 0;
      for (const v of search.variables) if (distance[v] > radius) pinned++;
      return pinned >= FRAME_PINNED * search.variables.length;
    });
    // What each radius has cost per word it settled, against what a full search costs per word.
    const spent = new Map(radii.map((radius) => [radius, { ms: 0, hits: 0, dropped: false }]));
    let fullMs = 0;
    let fullCount = 0;
    // A frame is its fill beyond the radius, and nothing else: a new fill that matches an earlier one
    // out there would only repeat that frame's answers, so it isn't run again.
    const framed = new Set();
    const learnFill = (fill) => {
      search.guide = fill;
      for (const radius of radii) {
        if (spent.get(radius).dropped) continue;
        let signature = `${radius}`;
        for (const v of search.variables) if (distance[v] > radius) signature += `,${fill[v]}`;
        if (framed.has(signature)) continue;
        framed.add(signature);
        waiting.push({ fill, radius });
      }
    };

    const settle = (update, updates) => {
      const [i, status] = update;
      if (state[i] === PENDING) open--;
      state[i] = status === "works" ? WORKS : status === "fails" ? FAILS : UNKNOWN;
      updates.push(update);
    };

    /* Place one candidate at the root, look for a full fill around it, and put the grid back. */
    const check = (i, seconds) => {
      const id = ids[i];
      if (noFillAtAll || id === undefined || !search.hasWord(s, id)) return [i, "fails"];
      const mark = search.tp;
      search.assignWord(s, id);
      let update = [i, "fails"]; // placing it already breaks a crossing
      if (search.propagate([s])) {
        const began = now();
        const guided = search.guide !== null;
        const solved = search.solve(began + seconds * 1000);
        if (solved) {
          // The first fill is found cold; the ones after start from a known fill, and those are
          // what a frame has to beat.
          if (guided) {
            fullMs += now() - began;
            fullCount++;
          }
          update = [i, "works", search.gridRows()];
          learnFill(fillIds());
        } else update = [i, solved === false ? "fails" : "unknown"];
      }
      search.undo(mark);
      return update;
    };

    const leaveFrame = () => {
      if (frame && frame.entered) {
        search.undo(rootMark);
        frame.entered = false;
      }
    };

    /* Pin the frame's fill beyond its radius and, the first time, list the words it still allows. */
    const enterFrame = () => {
      const pinned = [];
      for (const v of search.variables) {
        if (distance[v] <= frame.radius || !search.hasWord(v, frame.fill[v])) continue;
        search.assignWord(v, frame.fill[v]);
        pinned.push(v);
      }
      frame.entered = true;
      if (!search.propagate(pinned)) return false;
      if (!frame.list) {
        frame.list = [];
        for (let i = 0; i < ids.length; i++) {
          if ((state[i] === PENDING || state[i] === UNKNOWN) && search.hasWord(s, ids[i])) frame.list.push(i);
        }
      }
      return true;
    };

    /* One candidate inside the frame: a short search over the slots left free. A fill, or null. */
    const checkInFrame = (i) => {
      const mark = search.tp;
      search.assignWord(s, ids[i]);
      let update = null;
      if (search.propagate([s])) {
        search.beginSolve();
        search.budget = FRAME_BUDGET;
        if (search.round(now() + perWordSeconds * 1000) === true) update = [i, "works", search.gridRows()];
      }
      search.undo(mark);
      return update;
    };

    /* Work through the current frame until it's done or the step's time is up. */
    const runFrame = (end, updates) => {
      search.learn = false; // a frame's dead ends are the frame's, not the grid's
      const saved = search.guide;
      search.guide = frame.fill;
      const tally = spent.get(frame.radius);
      const fullCost = fullCount ? fullMs / fullCount : Infinity;
      const began = now();
      if (!frame.entered && !enterFrame()) frame.at = frame.list ? frame.list.length : 0;
      while (frame.list && frame.at < frame.list.length && now() < end) {
        const i = frame.list[frame.at++];
        if (state[i] === WORKS || state[i] === FAILS) continue;
        const update = checkInFrame(i);
        if (update) {
          tally.hits++;
          settle(update, updates);
        }
        const cost = tally.ms + now() - began;
        if (cost > 40 && cost / (tally.hits + 1) > fullCost) {
          tally.dropped = true; // dearer than searching from scratch
          frame.at = frame.list.length;
        }
      }
      tally.ms += now() - began;
      search.learn = true;
      search.guide = saved;
      if (!frame.list || frame.at >= frame.list.length) {
        leaveFrame();
        frame = null;
      }
    };

    return {
      prioritize(index, seconds) {
        if (index >= 0 && index < candidates.length) urgent = { index, seconds };
      },
      step(ms) {
        const end = now() + ms;
        const updates = [];
        if (!screened) {
          // Words the given letters already rule out need no search at all.
          screened = true;
          for (let i = 0; i < ids.length; i++) {
            if (noFillAtAll || ids[i] === undefined || !search.hasWord(s, ids[i])) settle([i, "fails"], updates);
          }
        }
        while (now() < end) {
          if (urgent) {
            leaveFrame();
            const { index, seconds } = urgent;
            urgent = null;
            if (state[index] !== WORKS && state[index] !== FAILS) settle(check(index, seconds), updates);
          } else if (frame) {
            runFrame(end, updates);
          } else if (waiting.length && open > 0 && (fullCount >= CALIBRATE || next >= candidates.length)) {
            frame = { ...waiting.shift(), list: null, at: 0, entered: false };
          } else {
            if (fullCount >= CALIBRATE) waiting.length = 0; // nothing left for them to settle
            while (next < candidates.length && state[next] !== PENDING) next++;
            if (next >= candidates.length) return { updates, done: true };
            settle(check(next, perWordSeconds), updates);
          }
        }
        return { updates, done: false };
      },
    };
  }

  /* Independently verify a filled grid. Returns a list of problems (empty if valid). */
  function checkFill(original, filled, words) {
    const { width, cells: given, slots } = parseGrid(original);
    const { cells: got } = parseGrid(filled);
    if (got.length !== given.length) return ["The filled grid is a different size."];
    const problems = [];
    given.forEach((before, i) => {
      const after = got[i];
      const where = `row ${Math.floor(i / width) + 1}, column ${(i % width) + 1}`;
      if ((before === BLOCK) !== (after === BLOCK)) problems.push(`block changed at ${where}`);
      else if (after === null) problems.push(`empty square at ${where}`);
      else if (before !== null && before !== after) problems.push(`given letter ${before} changed to ${after} at ${where}`);
    });
    if (problems.length) return problems;
    const seen = new Map();
    for (const slot of slots) {
      const word = slot.cells.map((i) => got[i]).join("");
      if (slot.cells.some((i) => given[i] === null) && !words.has(word)) problems.push(`${slot.name} ${word} is not in the word list`);
      if (seen.has(word)) problems.push(`${word} is used twice (${seen.get(word)} and ${slot.name})`);
      seen.set(word, slot.name);
    }
    return problems;
  }

  const api = { BLOCK, GridError, WordList, parseGrid, prepare, fill, checkOptions, checkFill };
  root.Gridfill = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
