// Word-option benchmark: node web/bench_options.js [--grid themed15] [--slot 8-Across] [--min 50]
//   [--cap 40] [--every k] [--per 0.5] [--solver path/to/filler.js] [--noverify]
//   [--dump statuses.json] [--compare statuses.json]
// Settles every candidate for one entry the way worker.js does (step(30) until done) and reports
// candidates settled per second and how long the first 50 "works" took, since the options panel
// lists confirmed words first. Every "works" fill is checked independently and must use its word.
// --every k checks every k-th candidate only; --dump saves each word's status, and --compare reads
// such a file (say, from another solver) and reports any word one calls "works" and the other "fails".
const path = require("node:path");
const fs = require("node:fs");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const solverPath = path.resolve(option("solver", path.join(__dirname, "filler.js")));
const gridName = option("grid", "themed15");
const slotName = option("slot", "8-Across");
const minScore = Number(option("min", 50));
const cap = Number(option("cap", 40));
const every = Number(option("every", 1));
const per = option("per", undefined);
const verify = !args.includes("--noverify");

require(path.join(__dirname, "words.js"));
const G = require(solverPath);
const words = new G.WordList(globalThis.GRIDFILL_WORDS);

const GRIDS = {
  themed15: ["...#....#......", "...#....#......", "GOLDENRETRIEVER", ".......#....###", "......#....#...", ".....#...##....", "###.....#......", "NUCLEARFOOTBALL", "......#.....###", "....##...#.....", "...#....#......", "###....#.......", "BATTLEOFBULLRUN", "......#....#...", "......#....#..."],
  themeless15a: ["........#......", "........#......", "...............", "...#.....#.....", "....#....#.....", ".....#....#....", "###...#....#...", ".......#.......", "...#....#...###", "....#....#.....", ".....#....#....", ".....#.....#...", "...............", "......#........", "......#........"],
  triple15: ["...............", "...............", "...............", "....#...#......", "###....#....###", "....#.....#....", "...#.....#.....", ".....#...#.....", ".....#.....#...", "....#.....#....", "###....#....###", "......#...#....", "...............", "...............", "..............."],
};
const grid = GRIDS[gridName];
const parsed = G.parseGrid(grid);
const slot = parsed.slots.find((s) => s.name === slotName);
if (!slot) throw new Error(`${gridName} has no ${slotName}`);

// The candidates as the page lists them: best first, fitting the letters already in place.
const length = slot.cells.length;
const list = words.lists[length];
const pattern = slot.cells.map((i) => parsed.cells[i]);
let candidates = [];
for (let w = 0; w < list.count && list.scores[w] >= minScore; w++) {
  const word = list.letters.substr(w * length, length);
  if (pattern.every((ch, p) => !ch || ch === word[p])) candidates.push(word);
}
const total = candidates.length;
if (every > 1) candidates = candidates.filter((_, i) => i % every === 0);

const options = { minScore };
if (per !== undefined) options.perWordSeconds = Number(per);
const start = performance.now();
const check = G.checkOptions(grid, words, { row: slot.row, col: slot.col, direction: slot.direction }, candidates, options);
if (check.error) throw new Error(check.error);
const counts = { works: 0, fails: 0, unknown: 0 };
const status = {};
let settled = 0;
let first50 = null;
let bad = 0;
let done = false;
while (!done && performance.now() - start < cap * 1000) {
  const result = check.step(30);
  done = result.done;
  for (const [i, state, rows] of result.updates) {
    const word = candidates[i];
    if (status[word] === undefined) settled++;
    else counts[status[word]]--;
    status[word] = state;
    counts[state]++;
    if (state !== "works") continue;
    if (counts.works === 50 && first50 === null) first50 = performance.now() - start;
    if (!verify) continue;
    const letters = rows.map((row) => Array.from(row)).flat();
    const problems = G.checkFill(grid, rows, words);
    const used = slot.cells.map((cell) => letters[cell]).join("");
    if (problems.length || used !== word) {
      if (++bad <= 3) console.log("BAD fill for", word, used, problems.slice(0, 3));
    }
  }
}
const seconds = (performance.now() - start) / 1000;
console.log(`solver ${path.relative(process.cwd(), solverPath)}: ${gridName} ${slotName}, min ${minScore}`);
console.log(`${settled} of ${candidates.length} candidates${every > 1 ? ` (every ${every} of ${total})` : ""} settled in ${seconds.toFixed(2)} s, ${(settled / seconds).toFixed(1)} a second${done ? "" : " (stopped at the cap)"}`);
console.log(`works ${counts.works}, fails ${counts.fails}, unknown ${counts.unknown}; first 50 works after ${first50 === null ? "-" : `${(first50 / 1000).toFixed(2)} s`}${verify ? `; bad fills ${bad}` : ""}`);

const dump = option("dump", "");
if (dump) fs.writeFileSync(dump, JSON.stringify(status));
const compare = option("compare", "");
if (compare) {
  const other = JSON.parse(fs.readFileSync(compare, "utf8"));
  const shared = Object.keys(status).filter((word) => other[word] !== undefined);
  const clash = shared.filter((word) => [status[word], other[word]].sort().join() === "fails,works");
  console.log(`${shared.length} words also in ${compare}: ${clash.length ? `CONTRADICTIONS: ${clash.slice(0, 10).join(", ")}` : "no works/fails contradictions"}`);
}
