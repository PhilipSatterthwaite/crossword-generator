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
   - every change is logged on a typed-array trail, so backing up allocates nothing.

   The next slot to fill is the one with the fewest words left relative to how often
   it and its crossings have run dry ("weighted degree"). Those counts survive
   restarts, so the search learns where the grid's hard corner is and starts there.
   Before the first pick, a quick scan scores each slot's hardness by how well its words'
   letters agree with what its crossings can supply, so heavily crossed long slots (15s)
   go first even though more 15-letter words exist than 3-letter ones. */
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
  const STRICT_SHARE = 0.6; // how much of the time limit the higher floors get before settling
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
  const KIND = 3 << 28;
  const INDEX = (1 << 28) - 1;

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
        this.lists[length] = { length, size, count: n, letters, codes, index, scores, popular, ids: null, cuts: new Map() };
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
      return list.ids.get(word);
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
     Returns {height, width, cells, slots}; cells hold BLOCK, a letter, or null. */
  function parseGrid(grid) {
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
    return { height, width, cells, slots };
  }

  // --- search ---

  class Search {
    constructor(grid, words, heuristic, minScore, allowPopular, longStep = LONG_STEP) {
      this.longStep = longStep;
      const { height, width, cells, slots } = parseGrid(grid);
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
      this.wdeg = heuristic === "wdeg";
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
          default: this.lastMask[i] = tv[k];
        }
      }
      this.tp = mark;
    }

    // --- candidate bitsets ---

    count(s) {
      const words = this.words[s];
      const active = this.active[s];
      let n = 0;
      for (let i = 0, limit = this.limits[s]; i < limit; i++) n += popcount32(words[active[i]]);
      return n;
    }

    isSingleton(s) {
      if (this.limits[s] !== 1) return false;
      const x = this.words[s][this.active[s][0]];
      return (x & (x - 1)) === 0;
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
      const ids = new Int32Array(this.count(s));
      let k = 0;
      for (let i = 0, limit = this.limits[s]; i < limit; i++) {
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
      if (changes) {
        const words = this.words[s];
        const active = this.active[s];
        const oldLimit = this.limits[s];
        let limit = oldLimit;
        for (let i = limit - 1; i >= 0; i--) {
          const chunk = active[i];
          const old = words[chunk];
          let keep = old;
          for (let j = 0; j < changes && keep !== 0; j++) {
            let m = 0;
            for (let k = starts[j], end = starts[j + 1]; k < end; k++) m |= refs[k][chunk];
            keep = removes[j] ? keep & ~m : keep & m;
          }
          keep >>>= 0;
          if (keep !== old) {
            this.save(WORD | (s << 12) | chunk, old);
            words[chunk] = keep;
            removedAny = true;
            if (keep === 0) {
              active[i] = active[--limit];
              active[limit] = chunk;
            }
          }
        }
        if (limit !== oldLimit) {
          this.save(LIMIT | s, oldLimit);
          this.limits[s] = limit;
        }
        if (limit === 0) {
          this.weight[s]++;
          return false;
        }
      }
      if (!wasDirty && !removedAny) return true;

      // A slot down to one word owns it: no other slot may use it.
      if (this.isSingleton(s)) {
        const id = this.firstWord(s);
        for (const o of this.byLength.get(length)) {
          if (o === s || !this.removeWord(o, id)) continue;
          if (this.limits[o] === 0) {
            this.weight[o]++;
            return false;
          }
          this.dirty[o] = 1;
          this.enqueue(queue, o);
        }
      }

      // Narrow crossing cells to letters some remaining word still uses. If one position
      // caused every removal, its own letters all kept their support, so skip it.
      const skip = !wasDirty && changes === 1 ? source : -1;
      for (let p = 0; p < length; p++) {
        const o = this.crossSlot[base + p];
        if (o < 0 || p === skip) continue;
        const cell = cells[p];
        const mask = this.cellMask[cell];
        if ((mask & (mask - 1)) === 0) continue;
        let next = mask;
        for (let m = mask; m; m &= m - 1) {
          const l = 31 - Math.clz32(m & -m);
          if (!this.supported(s, (base + p) * 26 + l, list.index[p][l])) next &= ~(1 << l);
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
    scanHardness(layers) {
      const n = this.slots.length;
      const samples = new Array(n).fill(null);    // candidate ids per slot, sampled
      const logWeights = new Array(n).fill(null); // log weight per sampled word
      const mixes = new Array(n).fill(null);      // mixes[s][p * 26 + l]: weighted share with letter l at p
      for (const s of this.variables) {
        let ids = this.wordIds(s);
        if (ids.length > SCAN_SAMPLE) {
          const stride = ids.length / SCAN_SAMPLE;
          ids = Int32Array.from({ length: SCAN_SAMPLE }, (_, k) => ids[Math.floor(k * stride)]);
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
          for (let i = 0; i < mix.length; i++) mix[i] /= total;
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
              if (o >= 0) sum += Math.log(mixes[o][this.crossPos[base + p] * 26 + codes[offset + p]] + 1e-9);
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
        if (strict.count >= LONG_ENOUGH) return strict;
      }
      return words.atLeast(length, minScore, allowPopular);
    }

    /* How much word score counts for a slot of this length, as a multiple of qualityWeight. */
    lengthWeight(length) {
      const weight = 1 + this.lengthSlope * (length - LENGTH_PIVOT);
      return Math.min(LENGTH_CEILING, Math.max(LENGTH_FLOOR, weight));
    }

    /* Slot s's words, best first: popular, and leaving crossing slots the most options. */
    orderedWords(s) {
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
      const order = Uint32Array.from(ids.keys());
      order.sort((a, b) => keys[b] - keys[a] || ids[b] - ids[a]);
      for (let k = 0; k < order.length; k++) order[k] = ids[order[k]];
      return order;
    }

    search() {
      const s = this.pickSlot();
      if (s < 0) return true;
      this.nodes++;
      this.tick();
      const single = [s];
      for (const id of this.orderedWords(s)) {
        if (!this.hasWord(s, id)) continue; // ruled out while refuting an earlier word
        const mark = this.tp;
        this.assignWord(s, id);
        this.dirty[s] = 1;
        if (this.propagate(single) && this.search()) return true;
        this.undo(mark);
        this.failures++;
        if (++this.attemptFailures >= this.budget) throw RESTART;
        // That word can't go here: rule it out and propagate what that implies.
        this.removeWord(s, id);
        this.dirty[s] = 1;
        if (this.limits[s] === 0 || !this.propagate(single)) return false;
      }
      return false;
    }

    /* Search from the current state until deadline. true: solved, and the state holds the
       fill; false: proven impossible; null: out of time. Unless solved, the state is restored. */
    solve(deadline) {
      const root = this.tp;
      this.deadline = deadline;
      this.budget = FIRST_BUDGET;
      this.attemptFailures = 0;
      this.noise = this.baseNoise;
      for (;;) {
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
        }
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
     counts when picking the next slot; 0 turns the scan off) and layers (how many crossings
     deep the scan looks). */
  function prepare(grid, words, options = {}) {
    const { minScore = 0, allowPopular = false, qualityWeight = 0.035, lengthSlope = LENGTH_SLOPE, longStep = LONG_STEP, seed = 1, variety = false, heuristic = "wdeg", lookahead = 1, layers = 1 } = options;
    let search;
    try {
      search = new Search(grid, words, heuristic, minScore, allowPopular, longStep);
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
    if (lookahead > 0) search.scanHardness(layers);
    return { search };
  }

  /* Fill grid from words (a WordList). Never throws for bad grids; returns
     {success, grid, reason, stats}. options: those of prepare, plus timeLimit (seconds),
     onProgress(rows, stats) and progressInterval (seconds). */
  function fill(grid, words, options = {}) {
    const { timeLimit = 30, onProgress = null, progressInterval = 0.25, longStep = LONG_STEP } = options;
    const started = now();
    const deadline = started + timeLimit * 1000;

    /* Aim high first: hold the long entries above the grid's minimum score and see if that fills.
       If it can't, in the share of the time set aside for it, settle for the plain minimum rather
       than leave the grid empty — a tidy fill beats a perfect one that never arrives. */
    const attempt = (step, until) => {
      const { search, error } = prepare(grid, words, { ...options, longStep: step });
      if (error) return { search, error };
      search.onProgress = onProgress;
      search.progressInterval = progressInterval * 1000;
      search.started = started; // one clock across both attempts, so progress and stats add up
      search.nextReport = now() + search.progressInterval;
      return { search, solved: search.solve(until) };
    };

    let attempted = longStep > 0 ? attempt(longStep, Math.min(deadline, started + timeLimit * 1000 * STRICT_SHARE)) : null;
    if (attempted && attempted.solved) {
      return { success: true, grid: attempted.search.gridRows(), reason: "", stats: attempted.search.stats() };
    }
    // Either the raised floors made it impossible, or they ran out of their share of the time.
    const { search, error, solved } = attempt(0, deadline);
    if (error) return { success: false, grid: null, reason: error, stats: search ? search.stats() : {} };
    if (solved) return { success: true, grid: search.gridRows(), reason: "", stats: search.stats() };
    const reason = solved === false
      ? "No fill exists for this grid with these words. Try moving a block, removing a letter, or lowering the minimum word score."
      : `No fill found within ${timeLimit} seconds. Try moving a block, or run it again.`;
    return { success: false, grid: null, reason, stats: search.stats() };
  }

  /* Check which candidate words for one entry can be part of a full fill, one word at a time
     from the top of the list down.
     target: {row, col, direction} of the entry; candidates: words, checked in this order.
     options: those of prepare, plus perWordSeconds.
     Returns {error}, or a checker with:
     - step(ms): checks words for about ms milliseconds and returns
       {updates: [[index, status, rows?], ...], done}. Statuses: "works" (a full fill uses the
       word, and rows is that fill), "fails" (no fill can use it), "unknown" (no fill found
       within perWordSeconds).
     - prioritize(index, seconds): check that word next, allowing it seconds. */
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
    const settled = new Uint8Array(candidates.length);
    let next = 0;
    let urgent = null;

    /* Place one candidate, look for a full fill around it, and put the grid back. */
    const check = (i, seconds) => {
      const id = ids[i];
      if (noFillAtAll || id === undefined || !search.hasWord(s, id)) return [i, "fails"];
      const mark = search.tp;
      search.assignWord(s, id);
      search.dirty[s] = 1;
      let update = [i, "fails"]; // placing it already breaks a crossing
      if (search.propagate([s])) {
        const solved = search.solve(now() + seconds * 1000);
        update = solved ? [i, "works", search.gridRows()] : [i, solved === false ? "fails" : "unknown"];
      }
      search.undo(mark);
      return update;
    };

    return {
      prioritize(index, seconds) {
        if (index >= 0 && index < candidates.length) urgent = { index, seconds };
      },
      step(ms) {
        const end = now() + ms;
        const updates = [];
        while (now() < end) {
          let update;
          if (urgent) {
            update = check(urgent.index, urgent.seconds);
            urgent = null;
          } else {
            while (next < candidates.length && settled[next]) next++;
            if (next >= candidates.length) return { updates, done: true };
            update = check(next, perWordSeconds);
          }
          settled[update[0]] = 1;
          updates.push(update);
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

  const api = { BLOCK, GridError, WordList, parseGrid, fill, checkOptions, checkFill };
  root.Gridfill = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
