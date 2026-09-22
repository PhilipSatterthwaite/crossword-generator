/* Grid designer: chooses a crossword's black squares, not just the words that go in them.

   The filler takes a block pattern as given. This one looks for a good pattern to give it. A
   pattern is scored with the hardness scan the filler already runs before searching (filler.js
   scanHardness): for each entry it estimates the log share of that entry's words whose letters
   its crossings can actually supply. The entry that runs dry is what sinks a fill, so a pattern
   is worth what its worst entry is worth, and the search maximizes that bottleneck.

   Scoring is the whole cost, and the scan is the only thing that can do it. Arc consistency on
   its own can't: with no letters in the grid it prunes almost nothing, so counting surviving
   candidates reports the rarest word length present and scores nearly every pattern the same.
   The scan costs 20-60 ms depending on how many words per entry it samples. A small sample
   ranks near-identical patterns badly but still picks out a clearly better one, so the search
   screens every move with a small sample and re-scores a shortlist of its best finds with a
   large one at the end.

   The search is simulated annealing over 180°-symmetric block pairs, starting from a
   constructive seed that is already legal. Legality is checked before scoring, since it costs
   microseconds and scoring costs milliseconds: every entry at least minLength long, all white
   squares connected, blocks under the cap, and every theme entry still exactly its own length.
   Requiring every run to reach minLength in both directions also rules out unchecked squares,
   so there is no separate test for them.
*/
(function (root) {
  "use strict";

  const Gridfill = root.Gridfill || (typeof require === "function" ? require("./filler.js") : null);
  if (!Gridfill) throw new Error("designer.js needs filler.js loaded first.");

  const SCREEN_SAMPLE = 300;   // words per entry while screening moves
  const CONFIRM_SAMPLE = 3000; // ...and while re-scoring the shortlist
  const SHORTLIST = 24;        // best screened patterns kept for confirmation
  const T_START = 4;           // annealing temperature, in units of the bottleneck's log score
  const T_END = 0.15;
  const SEED_RUN = 7;          // the seeder breaks non-theme runs down to about this length
  const THEME_GAP = 2;         // rows left clear between theme entries
  const LAYOUT_TRIES = 400;    // random theme layouts examined before settling on the candidates

  // --- random ---

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const now = () => (typeof performance === "object" ? performance.now() : Date.now());

  // --- pattern geometry ---

  /* True when the pattern could be a crossword: no entry shorter than minLength in either
     direction, every white square reachable from every other, and blocks within the cap. Called
     before every score, so it sweeps the grid rather than allocating. */
  function legal(blocks, W, H, minLength, maxBlocks) {
    let count = 0;
    for (let i = 0; i < blocks.length; i++) if (blocks[i]) count++;
    if (count > maxBlocks) return false;

    for (let r = 0; r < H; r++) {
      let run = 0;
      for (let c = 0; c <= W; c++) {
        if (c < W && !blocks[r * W + c]) run++;
        else {
          if (run && run < minLength) return false;
          run = 0;
        }
      }
    }
    for (let c = 0; c < W; c++) {
      let run = 0;
      for (let r = 0; r <= H; r++) {
        if (r < H && !blocks[r * W + c]) run++;
        else {
          if (run && run < minLength) return false;
          run = 0;
        }
      }
    }
    return connected(blocks, W, H, blocks.length - count);
  }

  function connected(blocks, W, H, whites) {
    const start = blocks.indexOf(0);
    if (start < 0) return false;
    const seen = new Uint8Array(W * H);
    const stack = [start];
    seen[start] = 1;
    let found = 1;
    while (stack.length) {
      const i = stack.pop();
      const r = (i / W) | 0;
      const c = i % W;
      if (c > 0) { const j = i - 1; if (!blocks[j] && !seen[j]) { seen[j] = 1; found++; stack.push(j); } }
      if (c < W - 1) { const j = i + 1; if (!blocks[j] && !seen[j]) { seen[j] = 1; found++; stack.push(j); } }
      if (r > 0) { const j = i - W; if (!blocks[j] && !seen[j]) { seen[j] = 1; found++; stack.push(j); } }
      if (r < H - 1) { const j = i + W; if (!blocks[j] && !seen[j]) { seen[j] = 1; found++; stack.push(j); } }
    }
    return found === whites;
  }

  /* Each theme entry still occupying its own run, end to end. A move that lengthens or splits one
     has put the theme word somewhere it no longer fits. */
  function themesIntact(blocks, W, placements) {
    for (const p of placements) {
      const step = p.direction === "across" ? 1 : W;
      const before = p.start - step;
      const after = p.start + step * p.length;
      for (let k = 0; k < p.length; k++) if (blocks[p.start + step * k]) return false;
      if (p.direction === "across") {
        if (p.col > 0 && !blocks[before]) return false;
        if (p.col + p.length < W && !blocks[after]) return false;
      } else {
        if (before >= 0 && !blocks[before]) return false;
        if (after < blocks.length && !blocks[after]) return false;
      }
    }
    return true;
  }

  /* The pattern as the filler wants it: '#' for a block, the theme letter where there is one. */
  function gridRows(blocks, letters, W, H) {
    const rows = [];
    for (let r = 0; r < H; r++) {
      let row = "";
      for (let c = 0; c < W; c++) {
        const i = r * W + c;
        row += blocks[i] ? "#" : letters[i] || ".";
      }
      rows.push(row);
    }
    return rows;
  }

  // --- theme placement ---

  /* Where the theme entries could sit, as across entries in 180°-symmetric pairs. Entries pair up
     by length; at most one may be left over, and only if it can sit centred in the middle row.
     Placing one of a pair fixes the other, so a layout is a choice of row and starting column per
     pair. Layouts are sampled rather than enumerated: the count runs to thousands and they are
     mostly alike. */
  function themeLayouts(entries, W, H, rng, limit) {
    const byLength = new Map();
    for (const word of entries) {
      const n = word.length;
      if (!byLength.has(n)) byLength.set(n, []);
      byLength.get(n).push(word);
    }
    const pairs = [];
    let centre = null;
    for (const [length, words] of byLength) {
      for (let i = 0; i + 1 < words.length; i += 2) pairs.push([words[i], words[i + 1]]);
      if (words.length % 2 === 1) {
        if (centre) {
          return { error: `${centre} and ${words[words.length - 1]} are both left without a partner of the same length. Theme entries pair up by length, and only one can sit in the middle.` };
        }
        if ((W - length) % 2 !== 0) {
          return { error: `${words[words.length - 1]} is ${length} letters, so it can't be centred in a ${W}-wide grid. Give it a partner of the same length, or change its length by one.` };
        }
        if (length > W) return { error: `${words[words.length - 1]} is longer than the grid is wide.` };
        centre = words[words.length - 1];
      }
    }
    if (H % 2 === 0 && centre) return { error: `${centre} needs a middle row, and a ${H}-row grid has none.` };
    for (const [a, b] of pairs) if (a.length > W) return { error: `${a} is longer than the grid is wide.` };

    const middle = (H - 1) / 2;
    const rowsFor = (n) => {
      // Upper rows a pair may use: never the outermost two, never the middle, and spaced apart.
      const out = [];
      for (let r = 2; r < middle; r++) out.push(r);
      return out;
    };
    const seen = new Set();
    const layouts = [];
    for (let attempt = 0; attempt < limit * 8 && layouts.length < limit; attempt++) {
      const used = [];
      const placements = [];
      let ok = true;
      for (const [a, b] of pairs) {
        const choices = rowsFor(a.length).filter((r) => used.every((u) => Math.abs(u - r) >= THEME_GAP));
        if (!choices.length) { ok = false; break; }
        const row = choices[Math.floor(rng() * choices.length)];
        const col = Math.floor(rng() * (W - a.length + 1));
        used.push(row);
        placements.push({ word: a, row, col, direction: "across", length: a.length });
        placements.push({ word: b, row: H - 1 - row, col: W - col - a.length, direction: "across", length: b.length });
      }
      if (!ok) continue;
      if (centre) {
        if (used.some((u) => Math.abs(u - middle) < THEME_GAP)) continue;
        placements.push({ word: centre, row: middle, col: (W - centre.length) / 2, direction: "across", length: centre.length });
      }
      for (const p of placements) p.start = p.row * W + p.col;
      const key = placements.map((p) => `${p.word}@${p.start}`).sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      layouts.push(placements);
    }
    if (!layouts.length) return { error: "No symmetric arrangement of those theme entries fits this grid. Try a taller grid or fewer entries." };
    return { layouts };
  }

  // --- seeding ---

  /* A legal pattern with the theme entries in place, to start annealing from. The theme rows get
     their caps first, since those blocks are forced. Then pairs go in wherever the longest white
     run is, split near the middle, until nothing runs much past SEED_RUN or the budget is gone.
     Starting from a sane pattern matters: from an empty grid the search would spend its whole
     budget rediscovering that a crossword needs about thirty blocks. */
  function seedPattern(placements, letters, W, H, minLength, maxBlocks, rng, targetRun = SEED_RUN) {
    const blocks = new Uint8Array(W * H);
    const frozen = new Uint8Array(W * H); // squares the annealer may not touch
    const mustStayOpen = new Uint8Array(W * H);
    for (const p of placements) {
      for (let k = 0; k < p.length; k++) {
        frozen[p.start + k] = 1;
        mustStayOpen[p.start + k] = 1;
      }
      if (p.col > 0) { blocks[p.start - 1] = 1; frozen[p.start - 1] = 1; }
      if (p.col + p.length < W) { blocks[p.start + p.length] = 1; frozen[p.start + p.length] = 1; }
    }
    // The layout is symmetric, so the caps came in mirrored pairs and the pattern still is.

    const put = (i) => {
      const j = W * H - 1 - i;
      if (mustStayOpen[i] || mustStayOpen[j]) return false;
      blocks[i] = 1;
      blocks[j] = 1;
      return true;
    };
    const count = () => {
      let n = 0;
      for (let i = 0; i < blocks.length; i++) if (blocks[i]) n++;
      return n;
    };
    // Every maximal white run, across then down.
    const scan = () => {
      const out = [];
      for (let r = 0; r < H; r++) {
        let n = 0;
        for (let c = 0; c <= W; c++) {
          if (c < W && !blocks[r * W + c]) n++;
          else { if (n) out.push({ start: r * W + c - n, step: 1, len: n }); n = 0; }
        }
      }
      for (let c = 0; c < W; c++) {
        let n = 0;
        for (let r = 0; r <= H; r++) {
          if (r < H && !blocks[r * W + c]) n++;
          else { if (n) out.push({ start: (r - n) * W + c, step: W, len: n }); n = 0; }
        }
      }
      return out;
    };

    /* Runs too short to hold an entry become blocks. A theme entry's cap regularly strands one or
       two squares against the edge of the grid, and a seeder that gave up on those rejected almost
       every layout; real grids block the stub out the same way. */
    for (let guard = 0; guard < W * H; guard++) {
      const stub = scan().find((run) => run.len < minLength);
      if (!stub) break;
      for (let k = 0; k < stub.len; k++) if (!put(stub.start + stub.step * k)) return null;
    }

    /* Then the long runs come down to about SEED_RUN, split near the middle so entries come out
       evenly sized. A run that can't be split is passed over rather than ending the seed: the one
       stubborn run is usually a column the theme entries have pinned. */
    for (let guard = 0; guard < W * H; guard++) {
      if (count() + 2 > maxBlocks) break;
      const longs = scan().filter((run) => run.len > targetRun).sort((a, b) => b.len - a.len);
      if (!longs.length) break;
      let placed = false;
      for (const run of longs) {
        const order = [];
        for (let k = minLength; k <= run.len - minLength; k++) order.push(k);
        order.sort((a, b) => Math.abs(a - run.len / 2) - Math.abs(b - run.len / 2) + (rng() - 0.5));
        for (const k of order) {
          const i = run.start + run.step * k;
          if (frozen[i] || frozen[W * H - 1 - i] || blocks[i]) continue;
          const before = blocks.slice();
          if (put(i) && legal(blocks, W, H, minLength, maxBlocks) && themesIntact(blocks, W, placements)) {
            placed = true;
            break;
          }
          blocks.set(before);
        }
        if (placed) break;
      }
      if (!placed) break;
    }
    if (!legal(blocks, W, H, minLength, maxBlocks) || !themesIntact(blocks, W, placements)) return null;
    return { blocks, frozen };
  }

  // --- scoring ---

  /* What a pattern is worth: how many short fills of it succeed, and how many of those fills are
     different from each other. This is the only measure that turned out to work. The obvious cheap
     one - scanHardness's estimate of the worst entry - is not merely weak but backwards: over ten
     seeded patterns its rank correlation with actually filling was -0.59, and the mean estimate for
     patterns that filled (-25.6) and for patterns that could not (-25.7) was the same. It judges
     each entry against its immediate crossings, so a grid whose every entry looks locally
     comfortable can still have no solution at all, and it marks down the long entries that in
     practice pin a grid down and make it fill.

     Probing is affordable because a hopeless pattern is usually proved hopeless rather than timed
     out: the filler comes back in a fraction of a second having searched the space out, and there
     is no reason to try another seed once it has. Ten patterns cost 1.4 seconds each at four
     probes apiece. */
  function probe(rows, words, options, trials, seconds, rng) {
    const distinct = new Set();
    let hits = 0;
    let spent = 0;
    let runs = 0;
    let best = null;
    for (let k = 0; k < trials; k++) {
      runs++;
      const began = now();
      const attempt = Gridfill.fill(rows, words, {
        minScore: options.minScore,
        allowPopular: options.allowPopular,
        timeLimit: seconds,
        seed: Math.floor(rng() * 1e9),
        variety: true,
      });
      spent += now() - began;
      if (attempt.success) {
        hits++;
        distinct.add(attempt.grid.join("|"));
        if (!best) best = attempt.grid;
      } else if (!attempt.timedOut) {
        break; // proved impossible: no other seed will do better
      }
    }
    return { hits, runs, distinct: distinct.size, ms: spent, fill: best };
  }

  /* Better means more different fills, then more fills, then found sooner. */
  function better(a, b) {
    if (!b) return true;
    if (a.distinct !== b.distinct) return a.distinct > b.distinct;
    if (a.hits !== b.hits) return a.hits > b.hits;
    return a.ms < b.ms;
  }

  // --- the search ---

  /* Design a grid around some theme entries.

     spec: width, height, themes (placed as across entries), minLength (3), maxBlockRatio (0.16),
     timeLimit (seconds), seed, minScore, allowPopular, screenTrials/deepTrials (fills per probe)
     and probeSeconds (how long one of those fills may take).
     Returns {success, rows, blocks, placements, fill, distinct, hits, candidates, stats, reason}.

     Three phases share the budget. Breadth seeds many patterns across many theme layouts and gives
     each a couple of fills, which is enough to throw out the impossible ones. Depth re-probes the
     survivors harder, to tell a grid with one fill from a grid with plenty. Polish hill-climbs the
     leader by moving one symmetric block pair at a time, keeping a move only when it probes
     better. Breadth is given half the budget because seeds differ enough between layouts that
     generating a fresh one usually beats perturbing an old one. */
  function designGrid(spec, words, options = {}) {
    const {
      width: W = 15,
      height: H = 15,
      themes = [],
      minLength = 3,
      maxBlockRatio = 0.16,
      timeLimit = 60,
      seed = 1,
      minScore = 50,
      allowPopular = false,
      screenTrials = 2,
      deepTrials = 6,
      probeSeconds = 1.5,
    } = spec;
    const onProgress = options.onProgress || null;
    const started = now();
    const deadline = started + timeLimit * 1000;
    const rng = mulberry32(seed);
    const maxBlocks = Math.floor(maxBlockRatio * W * H);
    const probeOptions = { minScore, allowPopular };
    const stats = { layouts: 0, seeded: 0, seedFailed: 0, screened: 0, impossible: 0, deepened: 0, moves: 0, kept: 0 };

    const clean = themes.map((w) => String(w).toUpperCase().replace(/[^A-Z]/g, "")).filter(Boolean);
    const { layouts, error } = themeLayouts(clean, W, H, rng, LAYOUT_TRIES);
    if (error) return { success: false, reason: error, stats };
    stats.layouts = layouts.length;

    let best = null;
    const survivors = [];
    const report = (phase) => {
      if (!onProgress) return;
      onProgress({
        phase,
        elapsed: (now() - started) / 1000,
        best: best ? { distinct: best.distinct, hits: best.hits, rows: best.rows } : null,
        stats,
      });
    };

    // --- breadth: many seeds, two fills each ---
    const breadthUntil = started + (deadline - started) * 0.5;
    while (now() < breadthUntil) {
      const placements = layouts[Math.floor(rng() * layouts.length)];
      const letters = new Array(W * H).fill("");
      for (const p of placements) for (let k = 0; k < p.length; k++) letters[p.start + k] = p.word[k];
      const targetRun = 6 + Math.floor(rng() * 3);
      const built = seedPattern(placements, letters, W, H, minLength, maxBlocks, rng, targetRun);
      if (!built) { stats.seedFailed++; continue; }
      stats.seeded++;
      const rows = gridRows(built.blocks, letters, W, H);
      const key = rows.join("");
      if (survivors.some((s) => s.key === key)) continue;
      const result = probe(rows, words, probeOptions, screenTrials, probeSeconds, rng);
      stats.screened++;
      if (!result.hits) { stats.impossible++; continue; }
      const entry = { key, rows, blocks: built.blocks, frozen: built.frozen, letters, placements, ...result };
      survivors.push(entry);
      if (better(entry, best)) best = entry;
      report("breadth");
    }
    if (!survivors.length) {
      return {
        success: false,
        stats,
        reason: stats.seeded
          ? `Seeded ${stats.seeded} patterns from those theme entries and none of them could be filled. Try a looser block cap, a lower minimum word score, or one fewer theme entry.`
          : `None of the ${layouts.length} symmetric arrangements of those theme entries could be seeded into a legal pattern. Try a looser block cap or a shorter minimum entry.`,
      };
    }

    // --- depth: the survivors probed harder, to separate one fill from many ---
    const deepUntil = started + (deadline - started) * 0.8;
    survivors.sort((a, b) => (better(a, b) ? -1 : 1));
    for (const entry of survivors) {
      if (now() >= deepUntil) break;
      const more = probe(entry.rows, words, probeOptions, deepTrials, probeSeconds, rng);
      stats.deepened++;
      entry.distinct = Math.max(entry.distinct, more.distinct);
      entry.hits = more.hits;
      entry.ms = more.ms;
      if (more.fill) entry.fill = more.fill;
      if (better(entry, best)) best = entry;
      report("depth");
    }

    // --- polish: one block pair at a time on the leader ---
    const movable = [];
    for (let i = 0; i < W * H; i++) {
      if (!best.frozen[i] && !best.frozen[W * H - 1 - i] && i <= W * H - 1 - i) movable.push(i);
    }
    const blocks = Uint8Array.from(best.blocks);
    while (now() < deadline && movable.length) {
      const i = movable[Math.floor(rng() * movable.length)];
      const j = W * H - 1 - i;
      const was = blocks[i];
      blocks[i] = was ? 0 : 1;
      blocks[j] = blocks[i];
      stats.moves++;
      if (!legal(blocks, W, H, minLength, maxBlocks) || !themesIntact(blocks, W, best.placements)) {
        blocks[i] = was;
        blocks[j] = was;
        continue;
      }
      const rows = gridRows(blocks, best.letters, W, H);
      const result = probe(rows, words, probeOptions, deepTrials, probeSeconds, rng);
      if (result.hits && better(result, best)) {
        best = { key: rows.join(""), rows, blocks: Uint8Array.from(blocks), frozen: best.frozen, letters: best.letters, placements: best.placements, ...result };
        stats.kept++;
        report("polish");
      } else {
        blocks[i] = was;
        blocks[j] = was;
      }
    }

    const count = best.blocks.reduce((a, b) => a + b, 0);
    return {
      success: true,
      rows: best.rows,
      blocks: Array.from(best.blocks),
      placements: best.placements,
      fill: best.fill,
      distinct: best.distinct,
      hits: best.hits,
      blockCount: count,
      blockRatio: count / (W * H),
      candidates: survivors
        .filter((s) => s !== best)
        .sort((a, b) => (better(a, b) ? -1 : 1))
        .slice(0, 3)
        .map((s) => ({ rows: s.rows, distinct: s.distinct, hits: s.hits })),
      stats,
      reason: "",
    };
  }

  const api = { designGrid, probe, legal, themeLayouts, seedPattern, gridRows };
  root.Griddesign = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
