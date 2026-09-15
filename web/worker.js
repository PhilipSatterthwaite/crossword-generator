/* Runs fills and word-option checks off the page's main thread so the grid stays responsive. */
importScripts("words.js", "filler.js");

const words = new Gridfill.WordList(self.GRIDFILL_WORDS);

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
  } else if (data.type === "options") {
    const check = Gridfill.checkOptions(data.grid, words, data.target, data.candidates, data.options);
    if (check.error) {
      job = null;
      self.postMessage({ type: "options", id: data.id, error: check.error });
      return;
    }
    job = { id: data.id, check };
    slices.port2.postMessage(null);
  } else if (data.type === "prioritize") {
    if (job && job.id === data.id) job.check.prioritize(data.index, data.seconds);
  } else if (data.type === "cancel") {
    job = null;
  }
};

self.postMessage({ type: "ready", count: words.size });
