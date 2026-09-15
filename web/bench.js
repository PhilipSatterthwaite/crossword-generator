// Solver benchmark: node web/bench.js [--time 8] [--solver path/to/filler.js] [--only name,name/min30]
//   [--seeds 1,2] [--heuristic wdeg|mrv] [--quality 0.035]
// Runs one grid at a time on one thread, checks every fill independently, and reports
// the fill's average and lowest word score.
const path = require("node:path");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const timeLimit = Number(option("time", 8));
const solverPath = path.resolve(option("solver", path.join(__dirname, "filler.js")));
const only = option("only", "").split(",").filter(Boolean);
const seeds = option("seeds", "1").split(",").map(Number);
const heuristic = option("heuristic", undefined); // undefined: the solver's default
const quality = option("quality", undefined);
const qualityWeight = quality === undefined ? undefined : Number(quality);
const numberOption = (name) => (option(name, undefined) === undefined ? undefined : Number(option(name)));
const lookahead = numberOption("lookahead");
const layers = numberOption("layers");
const allowPopular = args.includes("--popular");

require(path.join(__dirname, "words.js"));
const G = require(solverPath);
const words = new G.WordList(globalThis.GRIDFILL_WORDS);

const open = (n) => Array.from({ length: n }, () => ".".repeat(n));
const GRIDS = {
  themeless15a: ["........#......", "........#......", "...............", "...#.....#.....", "....#....#.....", ".....#....#....", "###...#....#...", ".......#.......", "...#....#...###", "....#....#.....", ".....#....#....", ".....#.....#...", "...............", "......#........", "......#........"],
  themed15: ["...#....#......", "...#....#......", "GOLDENRETRIEVER", ".......#....###", "......#....#...", ".....#...##....", "###.....#......", "NUCLEARFOOTBALL", "......#.....###", "....##...#.....", "...#....#......", "###....#.......", "BATTLEOFBULLRUN", "......#....#...", "......#....#..."],
  triple15: ["...............", "...............", "...............", "....#...#......", "###....#....###", "....#.....#....", "...#.....#.....", ".....#...#.....", ".....#.....#...", "....#.....#....", "###....#....###", "......#...#....", "...............", "...............", "..............."],
  open6: open(6),
  open7: open(7),
};

// [grid, minimum word score]
const CASES = [
  ["themeless15a", 50],
  ["themed15", 50],
  ["triple15", 40],
  ["triple15", 50],
  ["open6", 50],
  ["open7", 0],
];

/* Scores of the entries the solver filled (given entries don't count). */
function fillScores(original, filled) {
  const { cells, slots } = G.parseGrid(original);
  const letters = filled.flat();
  const scores = [];
  for (const slot of slots) {
    if (slot.cells.every((i) => cells[i] !== null)) continue;
    const word = slot.cells.map((i) => letters[i]).join("");
    const id = words.wordId(word);
    if (id !== undefined) scores.push(words.lists[word.length].scores[id]);
  }
  return scores;
}

console.log(`solver ${path.relative(process.cwd(), solverPath)}, ${timeLimit}s limit`);
console.log("case                 seed  result   seconds     steps  backtracks  restarts   steps/s  avg score  lowest");
for (const [name, minScore] of CASES) {
  const label = `${name}/min${minScore}`;
  if (only.length && !only.includes(name) && !only.includes(label)) continue;
  for (const seed of seeds) {
    const result = G.fill(GRIDS[name], words, { timeLimit, seed, variety: seed !== 1, heuristic, qualityWeight, minScore, allowPopular, lookahead, layers });
    const problems = result.success ? G.checkFill(GRIDS[name], result.grid, words) : [];
    const s = result.stats;
    const verdict = !result.success ? (/within/.test(result.reason) ? "timeout" : "none") : problems.length ? "BAD" : "filled";
    const scores = result.success ? fillScores(GRIDS[name], result.grid) : [];
    const average = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : "";
    const lowest = scores.length ? String(Math.min(...scores)) : "";
    console.log(
      `${label.padEnd(20)} ${String(seed).padStart(4)}  ${verdict.padEnd(7)} ${(s.seconds ?? 0).toFixed(2).padStart(8)} ${String(s.nodes ?? 0).padStart(9)} ${String(s.failures ?? 0).padStart(11)} ${String(s.restarts ?? 0).padStart(9)} ${String(Math.round((s.nodes ?? 0) / Math.max(s.seconds ?? 0, 0.001))).padStart(9)} ${average.padStart(10)} ${lowest.padStart(7)}`
    );
    if (problems.length) console.log("  ", problems.slice(0, 5));
    if (verdict === "none") console.log("  ", result.reason);
  }
}
