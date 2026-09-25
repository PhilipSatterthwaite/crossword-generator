/* Runs fills, grid designs and word-option checks off the page's main thread so the grid stays
   responsive. */
importScripts("words.js?v=ed9a1ba31e", "filler.js?v=8904f4f420", "designer.js?v=3980bdf382");

let words = new Gridfill.WordList(self.GRIDFILL_WORDS);

// The word-option check in progress, worked on in short slices so new requests get through.
let job = null;
const slices = new MessageChannel();
slices.port1.onmessage = work;

function work() {
  const current = job;
  if (!current) return;
  let message;
  try {
    const { updates, done } = current.check.step(30);
    // A fill travels as one string per row: thousands arrive a second, and the page keeps them all.
    for (const update of updates) if (update[2]) update[2] = update[2].map((row) => row.join(""));
    message = { type: "options", id: current.id, updates, done };
  } catch (error) {
    message = { type: "options", id: current.id, error: `The checker hit an error: ${error.message}` };
  }
  if (job !== current) return; // replaced or cancelled meanwhile
  if (message.error || message.done) job = null;
  if (message.error || message.done || message.updates.length) self.postMessage(message);
  if (job) slices.port2.postMessage(null);
}

self.onmessage = ({ data }) => {
  if (data.type === "fill") {
    job = null;
    let result;
    try {
      result = Gridfill.fill(data.grid, words, {
        ...data.options,
        onProgress: (rows, stats) => self.postMessage({ type: "progress", rows, stats }),
      });
    } catch (error) {
      result = { success: false, grid: null, reason: `The solver hit an error: ${error.message}`, stats: {} };
    }
    self.postMessage({ type: "result", result });
  } else if (data.type === "design") {
    // Designing a grid means filling candidate patterns over and over, so it belongs off the page
    // even more than a single fill does.
    job = null;
    let result;
    try {
      result = Griddesign.designGrid(data.spec, words, {
        onProgress: (progress) => self.postMessage({ type: "design-progress", progress }),
      });
    } catch (error) {
      result = { success: false, reason: `The designer hit an error: ${error.message}`, stats: {} };
    }
    self.postMessage({ type: "design-result", result });
  } else if (data.type === "options") {
    const check = Gridfill.checkOptions(data.grid, words, data.target, data.candidates, data.options);
    if (check.error) {
      job = null;
      self.postMessage({ type: "options", id: data.id, error: check.error });
      return;
    }
    job = { id: data.id, check };
    slices.port2.postMessage(null);
  } else if (data.type === "words") {
    // Custom lists or per-word edits changed. Only the word lengths that changed come over, and only
    // those are indexed again: rebuilding all half a million words to drop one made the page crawl.
    job = null;
    try {
      if (data.reset) {
        words = new Gridfill.WordList(self.GRIDFILL_WORDS);
      } else if (data.lengths) {
        const patch = new Gridfill.WordList(data.lengths);
        for (const key of Object.keys(data.lengths)) {
          const length = Number(key);
          const had = words.lists[length];
          words.size += patch.lists[length].count - (had ? had.count : 0);
          words.lists[length] = patch.lists[length];
        }
        for (const key of Object.keys(words.lists)) {
          if (data.all && !data.lengths[key]) {
            words.size -= words.lists[key].count; // that length has no words left
            delete words.lists[key];
          }
        }
      }
      self.postMessage({ type: "ready", count: words.size });
    } catch (error) {
      self.postMessage({ type: "ready", count: words.size, error: `That word list didn't load: ${error.message}` });
    }
  } else if (data.type === "hide") {
    // A word removed by hand (or put back): one bit flips, and the page asks for any checks again.
    if (data.clear) words.unhideAll();
    else words.hide(data.words, data.gone);
  } else if (data.type === "prioritize") {
    if (job && job.id === data.id) job.check.prioritize(data.index, data.seconds);
  } else if (data.type === "cancel") {
    job = null;
  }
};

self.postMessage({ type: "ready", count: words.size });
