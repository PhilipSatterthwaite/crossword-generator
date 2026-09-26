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
   squares connected and no section hanging off the rest by fewer than minOpening squares, blocks
   under the cap, no pockets (see pockets), and every theme entry still exactly its own length.
   Requiring every run to
   reach minLength in both directions also rules out unchecked squares, so there is no separate
   test for them.
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
  const THEME_GAP = 3;         // rows between theme entries: two clear, so the downs between them aren't pinned at both ends
  const LAYOUT_TRIES = 400;    // random theme layouts examined before settling on the candidates
  const SEED_BATCH = 12;       // seeds made per probe, the best-shaped of which is the one probed
  const MIN_OPENING = 3;       // squares any section must be joined to the rest by, at the least
  const SECTION = 4;           // white squares that make a piece of grid a section, for that rule

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
     direction, every white square reachable from every other through at least minOpening squares
     (see opening), and blocks within the cap. Called before every score, so the cheap sweeps come
     first and the graph work last. */
  function legal(blocks, W, H, minLength, maxBlocks, minOpening = MIN_OPENING) {
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
    if (pockets(blocks, W, H)) return false;
    return opening(blocks, W, H, blocks.length - count) >= minOpening;
  }

  /* How well the white squares hang together: the fewest squares whose removal would cut a
     section of the grid off from the rest, capped at 3. 0 means it's already in pieces; 1 means a
     section hangs off a single square; 2 that some section is reached only through two, the narrow
     passages solvers and editors dislike; 3 means every section is joined by three or more. A
     section is a piece of at least SECTION squares but no more than a third of the grid: a lone
     corner square (which never has more than two neighbours) doesn't count, and neither does half
     the grid, since two halves meeting at the centre square is a common design. A corner holding a
     few entries is what counts. */
  function opening(blocks, W, H, whites, section = SECTION) {
    if (!connected(blocks, W, H, whites)) return 0;
    const isSection = (size) => size >= section && size <= whites / 3;
    for (const a of cutSquares(blocks, W, H, -1)) if (isSection(stranded(blocks, W, H, a, -1))) return 1;
    for (let v = 0; v < blocks.length; v++) {
      if (blocks[v]) continue;
      for (const a of cutSquares(blocks, W, H, v)) if (isSection(stranded(blocks, W, H, v, a))) return 2;
    }
    return 3;
  }

  const side = (i, W, H, k) => {
    const r = (i / W) | 0;
    const c = i % W;
    return k === 0 ? (c > 0 ? i - 1 : -1) : k === 1 ? (c < W - 1 ? i + 1 : -1) : k === 2 ? (r > 0 ? i - W : -1) : r < H - 1 ? i + W : -1;
  };

  /* The white squares whose removal would split the rest, with square `skip` treated as black:
     Tarjan's articulation points, found iteratively. Only the part reachable from the first white
     square is searched; whatever `skip` already cut off is the caller's business. */
  function cutSquares(blocks, W, H, skip) {
    const n = W * H;
    const disc = new Int32Array(n);
    const low = new Int32Array(n);
    const parent = new Int32Array(n).fill(-1);
    const next = new Uint8Array(n);
    let start = -1;
    for (let i = 0; i < n && start < 0; i++) if (!blocks[i] && i !== skip) start = i;
    const cuts = [];
    if (start < 0) return cuts;
    let time = 0;
    let rootChildren = 0;
    const stack = [start];
    disc[start] = low[start] = ++time;
    while (stack.length) {
      const i = stack[stack.length - 1];
      if (next[i] < 4) {
        const j = side(i, W, H, next[i]++);
        if (j < 0 || blocks[j] || j === skip) continue;
        if (!disc[j]) {
          parent[j] = i;
          disc[j] = low[j] = ++time;
          if (i === start) rootChildren++;
          stack.push(j);
        } else if (j !== parent[i] && disc[j] < low[i]) low[i] = disc[j];
      } else {
        stack.pop();
        const p = parent[i];
        if (p < 0) continue;
        if (low[i] < low[p]) low[p] = low[i];
        if (p !== start && low[i] >= disc[p] && cuts[cuts.length - 1] !== p) cuts.push(p);
      }
    }
    if (rootChildren > 1) cuts.push(start);
    return cuts;
  }

  /* With squares a and b black, the size of the biggest piece of white squares other than the
     main one: what those two squares were holding on to the grid. */
  function stranded(blocks, W, H, a, b) {
    const n = W * H;
    const seen = new Uint8Array(n);
    seen[a] = 1;
    if (b >= 0) seen[b] = 1;
    let largest = 0;
    let second = 0;
    for (let i = 0; i < n; i++) {
      if (blocks[i] || seen[i]) continue;
      let size = 0;
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const x = stack.pop();
        size++;
        for (let k = 0; k < 4; k++) {
          const j = side(x, W, H, k);
          if (j >= 0 && !blocks[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
      if (size > largest) {
        second = largest;
        largest = size;
      } else if (size > second) second = size;
    }
    return second;
  }

  /* Pockets: a white square with blocks (or the edge) on two adjacent sides and a block on the
     corner diagonally opposite. The square starts both an across and a down entry, each of which
     turns away at once around that corner block, leaving a two-wide channel that snakes diagonally:
     the S-bends that make a pattern look machine-drawn. Published grids have none, so a legal
     pattern has none. */
  function pockets(blocks, W, H) {
    const at = (r, c) => (r < 0 || r >= H || c < 0 || c >= W ? 1 : blocks[r * W + c]);
    let count = 0;
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        if (blocks[r * W + c]) continue;
        for (const [dr, dc] of POCKET_CORNERS) {
          if (at(r - dr, c) && at(r, c - dc) && r + dr >= 0 && r + dr < H && c + dc >= 0 && c + dc < W && blocks[(r + dr) * W + c + dc]) count++;
        }
      }
    }
    return count;
  }
  const POCKET_CORNERS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

  /* Corners in the black area: 2x2 windows holding three blocks (a block jutting off a run, or an
     L) or all four, weighted by how far into the grid they sit. Against the edge they're ordinary:
     the "Utah" of five blocks on a grid's side is in the Times most weeks. One square in they cost
     a little, and in the middle of the grid, where they make the geometry look funky, a lot. */
  function corners(blocks, W, H) {
    let cost = 0;
    for (let r = 0; r + 1 < H; r++) {
      for (let c = 0; c + 1 < W; c++) {
        const i = r * W + c;
        if (blocks[i] + blocks[i + 1] + blocks[i + W] + blocks[i + W + 1] < 3) continue;
        const inset = Math.min(r, c, H - 2 - r, W - 2 - c); // 0 when the window touches the edge
        cost += inset === 0 ? 0 : inset === 1 ? 1 : 3;
      }
    }
    return cost;
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
     mostly alike. `anchored` are theme entries already inked on the grid, as placements: they stay
     put, and an entry of the same length goes in the mirror of one before any pairing. */
  function themeLayouts(entries, W, H, rng, limit, anchored = []) {
    const byLength = new Map();
    for (const word of entries) {
      const n = word.length;
      if (!byLength.has(n)) byLength.set(n, []);
      byLength.get(n).push(word);
    }
    const fixedPlacements = anchored.map((p) => ({ ...p }));
    for (const a of anchored) {
      const row = H - 1 - a.row;
      const col = W - a.col - a.length;
      if (row === a.row && col === a.col) continue; // sits centred: needs no partner
      if (anchored.some((o) => o.row === row && o.col === col)) continue; // its partner is inked too
      const words = byLength.get(a.length);
      if (!words || !words.length) continue; // an inked entry without a partner is the constructor's call
      fixedPlacements.push({ word: words.shift(), row, col, direction: "across", length: a.length });
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
      const used = fixedPlacements.map((p) => p.row);
      const placements = fixedPlacements.map((p) => ({ ...p }));
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
    if (!layouts.length) return { error: anchored.length ? "No symmetric arrangement of the remaining theme entries fits around the ones already inked. Try fewer entries, or ink the rest in by hand." : "No symmetric arrangement of those theme entries fits this grid. Try a taller grid or fewer entries." };
    return { layouts };
  }

  // --- seeding ---

  /* A legal pattern with the theme entries in place, to start annealing from. The theme rows get
     their caps first, since those blocks are forced. Then pairs go in wherever the longest white
     run is, split near the middle, until nothing runs much past SEED_RUN or the budget is gone.
     Starting from a sane pattern matters: from an empty grid the search would spend its whole
     budget rediscovering that a crossword needs about thirty blocks. */
  function seedPattern(placements, letters, W, H, minLength, maxBlocks, rng, targetRun = SEED_RUN, minOpening = MIN_OPENING, fixed = null) {
    const blocks = new Uint8Array(W * H);
    const frozen = new Uint8Array(W * H); // squares the annealer may not touch
    const mustStayOpen = new Uint8Array(W * H);
    // What the grid already has stays as it is: its blocks stay black, its lettered squares white.
    if (fixed) {
      for (let i = 0; i < W * H; i++) {
        if (fixed.blocks[i]) {
          blocks[i] = 1;
          frozen[i] = 1;
        } else if (fixed.letters[i]) {
          frozen[i] = 1;
          mustStayOpen[i] = 1;
        }
      }
    }
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
       stubborn run is usually a column the theme entries have pinned, or a run of seven or eight
       that would only split into threes. */
    for (let guard = 0; guard < W * H; guard++) {
      if (count() + 2 > maxBlocks) break;
      const longs = scan().filter((run) => run.len > targetRun).sort((a, b) => b.len - a.len);
      if (!longs.length) break;
      let placed = false;
      for (const run of longs) {
        // Near the middle, and better still where the block would touch one already there: at a
        // corner best of all, so blocks grow into staircases; beside it a little, so runs of two or
        // three can form without every block piling into a wall.
        const touches = (k) => {
          const i = run.start + run.step * k;
          const r = (i / W) | 0;
          const c = i % W;
          let best = 0;
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            if ((dr || dc) && r + dr >= 0 && r + dr < H && c + dc >= 0 && c + dc < W && blocks[(r + dr) * W + c + dc]) best = Math.max(best, dr && dc ? 1 : 0.4);
          }
          return best;
        };
        // Both pieces at least four long if it can be: a three-letter entry is only ever the fill
        // nobody wanted, so a split that makes one costs extra and comes last.
        const order = [];
        for (let k = minLength; k <= run.len - minLength; k++) order.push(k);
        const short = (k) => (k < 4 ? 1 : 0) + (run.len - k - 1 < 4 ? 1 : 0);
        // ...and counting the threes the block and its mirror would make in the other direction too.
        const shape = () => threes(blocks, W, H) + 4 * walls(blocks, W, H) + 2 * corners(blocks, W, H);
        const before = shape();
        const made = (k) => {
          const i = run.start + run.step * k;
          const j = W * H - 1 - i;
          const wasI = blocks[i];
          const wasJ = blocks[j];
          blocks[i] = 1;
          blocks[j] = 1;
          const after = shape();
          blocks[i] = wasI;
          blocks[j] = wasJ;
          return after - before;
        };
        const cost = (k) => Math.abs(k - run.len / 2) - touches(k) * (run.len / 2) + 3 * made(k) + 6 * short(k);
        const noisy = order.map((k) => [k, cost(k) + (rng() - 0.5) * 4]); // enough noise that seeds differ
        noisy.sort((a, b) => a[1] - b[1]);
        order.splice(0, order.length, ...noisy.map((entry) => entry[0]));
        for (const k of order) {
          const i = run.start + run.step * k;
          if (frozen[i] || frozen[W * H - 1 - i] || blocks[i]) continue;
          const before = blocks.slice();
          if (put(i) && legal(blocks, W, H, minLength, maxBlocks, minOpening) && themesIntact(blocks, W, placements)) {
            placed = true;
            break;
          }
          blocks.set(before);
        }
        if (placed) break;
      }
      if (!placed) break;
    }
    if (!legal(blocks, W, H, minLength, maxBlocks, minOpening) || !themesIntact(blocks, W, placements)) return null;
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

  /* How many entries are three letters long: the fill nobody remembers, so a pattern with fewer
     is the better one when they fill alike. */
  function threes(blocks, W, H) {
    let count = 0;
    for (let r = 0; r < H; r++) {
      let run = 0;
      for (let c = 0; c <= W; c++) {
        if (c < W && !blocks[r * W + c]) run++;
        else {
          if (run === 3) count++;
          run = 0;
        }
      }
    }
    for (let c = 0; c < W; c++) {
      let run = 0;
      for (let r = 0; r <= H; r++) {
        if (r < H && !blocks[r * W + c]) run++;
        else {
          if (run === 3) count++;
          run = 0;
        }
      }
    }
    return count;
  }

  /* Blocks standing alone inside the grid: no other block beside them, above or below, or at a
     corner. Real grids gather their blocks into runs and staircases; a scatter of single blocks,
     with the zigzag channels it leaves between them, is what a pattern looks like when a machine
     drew it. A single block on the edge is ordinary and doesn't count. */
  function loneBlocks(blocks, W, H) {
    let count = 0;
    for (let r = 1; r < H - 1; r++) {
      for (let c = 1; c < W - 1; c++) {
        if (!blocks[r * W + c]) continue;
        let near = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if ((dr || dc) && blocks[(r + dr) * W + c + dc]) near++;
        if (!near) count++;
      }
    }
    return count;
  }

  /* Straight walls of four or more blocks that don't touch the edge: the other way a machine-drawn
     pattern gives itself away. Three in a row, and any run against the edge, are ordinary. */
  function walls(blocks, W, H) {
    let count = 0;
    for (let r = 0; r < H; r++) {
      let run = 0;
      for (let c = 0; c <= W; c++) {
        if (c < W && blocks[r * W + c]) run++;
        else {
          if (run >= 4 && c - run > 0 && c < W) count++;
          run = 0;
        }
      }
    }
    for (let c = 0; c < W; c++) {
      let run = 0;
      for (let r = 0; r <= H; r++) {
        if (r < H && blocks[r * W + c]) run++;
        else {
          if (run >= 4 && r - run > 0 && r < H) count++;
          run = 0;
        }
      }
    }
    return count;
  }

  /* What's wrong with a pattern's shape, to be kept small: its three-letter entries, its lone
     blocks counted three times over (each usually brings a few threes with it), and its walls. */
  const ugliness = (blocks, W, H) => threes(blocks, W, H) + 3 * loneBlocks(blocks, W, H) + 4 * walls(blocks, W, H) + 2 * corners(blocks, W, H);

  /* Better means more different fills, then a better shape (see ugliness), then more fills, then
     found sooner. */
  function better(a, b) {
    if (!b) return true;
    if (a.distinct !== b.distinct) return a.distinct > b.distinct;
    if (a.ugliness !== b.ugliness) return a.ugliness < b.ugliness;
    if (a.hits !== b.hits) return a.hits > b.hits;
    return a.ms < b.ms;
  }

  // --- the search ---

  /* Design a grid around some theme entries.

     spec: width, height, themes (placed as across entries), blocks and letters (what the grid
     already has, kept as it is: blocks stay, lettered squares stay white with their letters given;
     a rebus square's letters go in rebus), minLength (3), maxBlockRatio (0.16),
     minOpening (3: the fewest squares any section may be joined to the rest by), timeLimit
     (seconds), seed, minScore, allowPopular, screenTrials/deepTrials (fills per probe) and
     probeSeconds (how long one of those fills may take).
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
      blocks: keptBlocks = null,
      letters: keptLetters = null,
      rebus = null,
      minLength = 3,
      maxBlockRatio = 0.16,
      minOpening = MIN_OPENING,
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
    const probeOptions = { minScore, allowPopular, rebus };
    const fixed = keptBlocks || keptLetters
      ? { blocks: Uint8Array.from({ length: W * H }, (_, i) => (keptBlocks && keptBlocks[i] ? 1 : 0)), letters: Array.from({ length: W * H }, (_, i) => (keptLetters && keptLetters[i]) || "") }
      : null;
    const stats = { layouts: 0, seeded: 0, seedFailed: 0, screened: 0, impossible: 0, deepened: 0, moves: 0, kept: 0 };

    const clean = themes.map((w) => String(w).toUpperCase().replace(/[^A-Z]/g, "")).filter(Boolean);
    // Theme entries already inked in full stay where they are. One that reads across anchors a
    // partner of its length in the mirror row; one that reads down is simply already there.
    const anchored = [];
    const remaining = [];
    const inkedAt = (word, across) => {
      const n = word.length;
      const outer = across ? H : W;
      const inner = across ? W : H;
      const at = (a, b) => (across ? a * W + b : b * W + a);
      for (let a = 0; a < outer; a++) {
        for (let b = 0; b + n <= inner; b++) {
          let hit = true;
          for (let k = 0; k < n && hit; k++) {
            const text = fixed.letters[at(a, b + k)];
            if (!text || text[0] !== word[k]) hit = false;
          }
          if (!hit) continue;
          // Its ends must be caps or become them: a letter beyond either end means it's part of something longer.
          if ((b > 0 && fixed.letters[at(a, b - 1)]) || (b + n < inner && fixed.letters[at(a, b + n)])) continue;
          return across ? { word, row: a, col: b, direction: "across", length: n } : { word, direction: "down", length: n };
        }
      }
      return null;
    };
    for (const word of clean) {
      const across = fixed ? inkedAt(word, true) : null;
      if (across) anchored.push(across);
      else if (!(fixed && inkedAt(word, false))) remaining.push(word);
    }
    // Any other complete inked across entry (blocks or the edge at both ends) of the same length as
    // a theme entry still to place anchors one too: an inked fifteen wants its partner opposite.
    if (fixed && remaining.length) {
      const lengths = new Set(remaining.map((word) => word.length));
      for (let r = 0; r < H; r++) {
        for (let c = 0; c < W; c++) {
          if (!fixed.letters[r * W + c] || (c > 0 && !fixed.blocks[r * W + c - 1])) continue;
          let n = 0;
          while (c + n < W && fixed.letters[r * W + c + n]) n++;
          const capped = c + n === W || fixed.blocks[r * W + c + n];
          if (capped && lengths.has(n) && !anchored.some((p) => p.row === r && p.col === c)) {
            let word = "";
            for (let k = 0; k < n; k++) word += fixed.letters[r * W + c + k][0];
            anchored.push({ word, row: r, col: c, direction: "across", length: n });
          }
          c += n;
        }
      }
    }
    const found = themeLayouts(remaining, W, H, rng, LAYOUT_TRIES, anchored);
    if (found.error) return { success: false, reason: found.error, stats };
    // Only layouts that agree with what the grid already has: no theme letter on a block or over
    // a different letter, and no cap (the block at either end) on a lettered square.
    const agrees = (p) => {
      for (let k = 0; k < p.length; k++) {
        const i = p.start + k;
        if (fixed.blocks[i] || (fixed.letters[i] && fixed.letters[i][0] !== p.word[k])) return false;
      }
      if (p.col > 0 && fixed.letters[p.start - 1]) return false;
      if (p.col + p.length < W && fixed.letters[p.start + p.length]) return false;
      return true;
    };
    const layouts = fixed ? found.layouts.filter((placements) => placements.every(agrees)) : found.layouts;
    if (!layouts.length) return { success: false, reason: "None of the symmetric arrangements of those theme entries fits around the blocks and letters already on the grid. Clear some, or put the theme entries in by hand.", stats };
    if (fixed) {
      const already = fixed.blocks.reduce((a, b) => a + b, 0);
      if (already > maxBlocks) return { success: false, reason: `The grid already has ${already} blocks, over the ${Math.round(maxBlockRatio * 100)}% cap of ${maxBlocks}. Raise the cap or clear some blocks.`, stats };
    }
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
    // Seeding costs milliseconds and probing costs seconds, so each probe goes to the best-shaped of
    // a batch of seeds rather than to the first one made.
    const breadthUntil = started + (deadline - started) * 0.5;
    while (now() < breadthUntil) {
      let built = null;
      let letters = null;
      let placements = null;
      for (let attempt = 0; attempt < SEED_BATCH; attempt++) {
        const tryPlacements = layouts[Math.floor(rng() * layouts.length)];
        const tryLetters = fixed ? fixed.letters.map((text) => text.charAt(0)) : new Array(W * H).fill("");
        for (const p of tryPlacements) for (let k = 0; k < p.length; k++) tryLetters[p.start + k] = p.word[k];
        const targetRun = 5 + Math.floor(rng() * 5);
        const candidate = seedPattern(tryPlacements, tryLetters, W, H, minLength, maxBlocks, rng, targetRun, minOpening, fixed);
        if (!candidate) { stats.seedFailed++; continue; }
        stats.seeded++;
        // Shape, plus a charge for every block short of the cap: a sparse seed looks tidy but won't fill.
        const count = candidate.blocks.reduce((a, b) => a + b, 0);
        candidate.ugliness = ugliness(candidate.blocks, W, H) + 2 * Math.max(0, maxBlocks - 2 - count);
        if (!built || candidate.ugliness < built.ugliness) {
          built = candidate;
          letters = tryLetters;
          placements = tryPlacements;
        }
      }
      if (!built) continue;
      const rows = gridRows(built.blocks, letters, W, H);
      const key = rows.join("");
      if (survivors.some((s) => s.key === key)) continue;
      const result = probe(rows, words, probeOptions, screenTrials, probeSeconds, rng);
      stats.screened++;
      if (!result.hits) { stats.impossible++; continue; }
      const entry = { key, rows, blocks: built.blocks, frozen: built.frozen, letters, placements, threes: threes(built.blocks, W, H), lone: loneBlocks(built.blocks, W, H), ugliness: ugliness(built.blocks, W, H), ...result };
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
          : `None of the ${layouts.length} symmetric arrangements of those theme entries could be seeded into a legal pattern (every section joined to the rest by ${minOpening}+ squares). Try a looser block cap or a shorter minimum entry.`,
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
      if (!legal(blocks, W, H, minLength, maxBlocks, minOpening) || !themesIntact(blocks, W, best.placements)) {
        blocks[i] = was;
        blocks[j] = was;
        continue;
      }
      const rows = gridRows(blocks, best.letters, W, H);
      const result = { ...probe(rows, words, probeOptions, deepTrials, probeSeconds, rng), threes: threes(blocks, W, H), lone: loneBlocks(blocks, W, H), ugliness: ugliness(blocks, W, H) };
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
      threes: best.threes,
      lone: best.lone,
      candidates: survivors
        .filter((s) => s !== best)
        .sort((a, b) => (better(a, b) ? -1 : 1))
        .slice(0, 3)
        .map((s) => ({ rows: s.rows, distinct: s.distinct, hits: s.hits, threes: s.threes, lone: s.lone })),
      stats,
      reason: "",
    };
  }

  const api = { designGrid, probe, legal, opening, threes, loneBlocks, walls, pockets, corners, themeLayouts, seedPattern, gridRows };
  root.Griddesign = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
