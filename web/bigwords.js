/* The two big files: words.js (every word and its score, about 7 MB) and wordstats.js (the figures
   behind each word, about 26 MB). Loaded as script tags, they held a page blank and silent until both
   had arrived, which on a phone could be minutes. Fetched here instead, so the page can say how far
   along they are, and read with JSON.parse, since they are plain data. The browser keeps them after the
   first visit, so the wait is a one-off.

   The page names them, and their sizes, in window.FILLMEIN_WORD_FILES, which the build fills in and
   stamps: {words: ["words.js?v=…", bytes], stats: ["wordstats.js?v=…", bytes]}. Each file sets the
   same global its script tag used to (GRIDFILL_WORDS, GRIDFILL_STATS), so nothing that reads the words
   needs to change. Exposes window.FillmeinWords. */
(function (root) {
  "use strict";

  const GLOBALS = { words: "GRIDFILL_WORDS", stats: "GRIDFILL_STATS" };
  const FALLBACK = { words: ["words.js", 0], stats: ["wordstats.js", 0] };
  const fetching = {}; // kind -> its promise, so two callers share one download

  const fileOf = (kind) => (root.FILLMEIN_WORD_FILES || {})[kind] || FALLBACK[kind];

  async function fetchOne(kind, onBytes) {
    const [url] = fileOf(kind);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`The word list didn't load (${response.status}).`);
    let text;
    if (response.body && response.body.getReader) {
      const reader = response.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        onBytes(got);
      }
      const all = new Uint8Array(got);
      let at = 0;
      for (const part of parts) {
        all.set(part, at);
        at += part.length;
      }
      text = new TextDecoder().decode(all);
    } else {
      text = await response.text();
    }
    // "(...).GRIDFILL_WORDS = {...};": the object is JSON.
    const start = text.indexOf("= {");
    root[GLOBALS[kind]] = JSON.parse(text.slice(start + 2, text.lastIndexOf("}") + 1));
  }

  /* Load the kinds asked for ("words", "stats"); resolves once all are in place. onProgress gets the
     share done (0 to 1), and the megabytes so far and in all. */
  function load(kinds, onProgress = () => {}) {
    const total = kinds.reduce((sum, kind) => sum + (fileOf(kind)[1] || 0), 0);
    const got = {};
    const report = () => {
      const sum = Object.values(got).reduce((a, b) => a + b, 0);
      onProgress(total ? Math.min(1, sum / total) : 0, sum / 1e6, total / 1e6);
    };
    return Promise.all(kinds.map((kind) => {
      if (root[GLOBALS[kind]]) {
        got[kind] = fileOf(kind)[1] || 0;
        return Promise.resolve();
      }
      if (!fetching[kind]) fetching[kind] = fetchOne(kind, (bytes) => { got[kind] = bytes; report(); });
      else fetching[kind].then(() => { got[kind] = fileOf(kind)[1] || 0; report(); });
      return fetching[kind];
    })).then(() => {
      onProgress(1, total / 1e6, total / 1e6);
    });
  }

  root.FillmeinWords = { load, has: (kind) => Boolean(root[GLOBALS[kind]]) };
})(self);
