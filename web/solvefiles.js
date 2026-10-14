/* Puzzle files opened for solving, kept in this browser: each puzzle under FILE + its id, the list of
   them, newest first, under FILES, and the solver's progress on one under PROGRESS + its id (the
   solve page writes that). The same file opened twice is the same puzzle, progress and all: its id
   comes from its bytes. Needs importers.js (GridImport). Exposes window.SolveFiles. */
(function (root) {
  "use strict";

  const FILES = "fillmein:solve:files";
  const FILE = "fillmein:solve:file-puzzle:";
  const PROGRESS = "fillmein:solve:file:";
  const MOST = 40;

  /* [{id, title, author, width, height, opened}], newest first. */
  const list = () => {
    try { return JSON.parse(localStorage.getItem(FILES)) || []; } catch (error) { return []; }
  };
  const write = (entries) => {
    try { localStorage.setItem(FILES, JSON.stringify(entries.slice(0, MOST))); } catch (error) { /* storage full or off */ }
  };

  const hash = (bytes) => {
    let h = 2166136261;
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619);
    return (h >>> 0).toString(36) + bytes.length.toString(36);
  };

  /* A file read by importers.js as the solve page holds a puzzle: cells a character a square ("#" a
     block, the answer's letter, "." where the file gave none), and known when every answer is there. */
  function shape(read) {
    const cells = read.cells.map((cell) => (cell === "#" ? "#" : cell || ".")).join("");
    const rebus = {};
    for (const [key, text] of Object.entries(read.rebus || {})) if (/^[A-Z]{2,12}$/.test(text) && cells[Number(key)] === text[0]) rebus[key] = text;
    return {
      title: read.title || "Untitled puzzle",
      author: read.author || "",
      width: read.width,
      height: read.height,
      cells,
      clues: read.clues || {},
      rebus,
      known: !read.locked && !cells.includes("."),
    };
  }

  /* Read a dropped or chosen file and keep it: resolves to its id, or rejects with a message to show. */
  async function open(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const read = root.GridImport.read(file.name, bytes, { allowLocked: true });
    const id = hash(bytes);
    const puzzle = shape(read);
    try {
      localStorage.setItem(FILE + id, JSON.stringify(puzzle));
    } catch (error) {
      throw new Error("This browser has no room to keep the puzzle. Remove a puzzle you've finished and try again.");
    }
    touch(id, puzzle);
    return id;
  }

  /* A kept puzzle, or null when it isn't in this browser (or is damaged). */
  function load(id) {
    let puzzle = null;
    try { puzzle = JSON.parse(localStorage.getItem(FILE + id)); } catch (error) { return null; }
    if (!puzzle || !(puzzle.width > 0 && puzzle.height > 0) || typeof puzzle.cells !== "string" || puzzle.cells.length !== puzzle.width * puzzle.height) return null;
    return puzzle;
  }

  /* Move a puzzle to the top of the list, as just opened. */
  function touch(id, puzzle) {
    const entries = list();
    const known = entries.find((entry) => entry.id === id);
    const entry = known || { id, title: puzzle.title, author: puzzle.author, width: puzzle.width, height: puzzle.height };
    write([{ ...entry, opened: Date.now() }, ...entries.filter((other) => other.id !== id)]);
  }

  function remove(id) {
    try {
      localStorage.removeItem(FILE + id);
      localStorage.removeItem(PROGRESS + id);
    } catch (error) { /* already gone */ }
    write(list().filter((entry) => entry.id !== id));
  }

  /* How far along a puzzle is, in words: "solved", "12 squares filled", or "" when not started. */
  function progress(id) {
    try {
      const saved = JSON.parse(localStorage.getItem(PROGRESS + id));
      if (saved && saved.done) return "solved";
      if (saved && Array.isArray(saved.letters)) {
        const filled = saved.letters.filter(Boolean).length;
        return filled ? `${filled} ${filled === 1 ? "square" : "squares"} filled` : "";
      }
    } catch (error) { /* nothing saved yet */ }
    return "";
  }

  /* How far along a kept puzzle is: {filled, open, share (0 to 1), done}, or null if it's gone. */
  function filledOf(id) {
    const puzzle = load(id);
    if (!puzzle) return null;
    const open = [...puzzle.cells].filter((cell) => cell !== "#").length;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(PROGRESS + id)); } catch (error) { /* not started */ }
    // Progress is an array of letters, or, saved by earlier versions, a string with "." for empty.
    const letters = saved && saved.letters ? Array.from(saved.letters) : [];
    const filled = letters.filter((text, i) => text && text !== "." && puzzle.cells[i] !== "#").length;
    return { filled, open, share: open ? filled / open : 0, done: Boolean(saved && saved.done), puzzle };
  }

  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const UNITS = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  const ago = (time) => {
    const seconds = (time - Date.now()) / 1000;
    for (const [unit, size] of UNITS) if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
    return "just now";
  };

  /* One line about a kept puzzle, for a list of them: "by Name · 15×15 · 42% filled · opened 2 days ago". */
  function describe(entry) {
    const state = filledOf(entry.id);
    const how = !state ? "" : state.done ? "solved" : state.filled ? `${Math.max(1, Math.floor(100 * state.share))}% filled` : "not started";
    // A file's author field often says "by" already.
    const author = String(entry.author || "").trim().replace(/^by\s+/i, "");
    return [author ? `by ${author}` : "", `${entry.width}×${entry.height}`, how, entry.opened ? `opened ${ago(entry.opened)}` : ""]
      .filter(Boolean).join(" · ");
  }

  /* The puzzle's blocks drawn small, as the home page draws the puzzles you're making. */
  function thumbnail(id, size = 48) {
    const puzzle = load(id);
    if (!puzzle) return null;
    const SVG = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", `0 0 ${puzzle.width} ${puzzle.height}`);
    svg.setAttribute("width", size * Math.min(1, puzzle.width / puzzle.height));
    svg.setAttribute("height", size * Math.min(1, puzzle.height / puzzle.width));
    svg.setAttribute("shape-rendering", "crispEdges");
    svg.setAttribute("aria-hidden", "true");
    for (let i = 0; i < puzzle.cells.length; i++) {
      if (puzzle.cells[i] !== "#") continue;
      const rect = document.createElementNS(SVG, "rect");
      rect.setAttribute("x", i % puzzle.width);
      rect.setAttribute("y", Math.floor(i / puzzle.width));
      rect.setAttribute("width", 1);
      rect.setAttribute("height", 1);
      svg.append(rect);
    }
    return svg;
  }

  /* A row for a list of kept puzzles: thumbnail, title linking to it, the line about it, and a thin
     bar of how much is filled. extra, if given, goes at the end of the row (a Remove button, say). */
  function row(entry, extra) {
    const item = document.createElement("li");
    item.className = "puzzle";
    const thumb = document.createElement("span");
    thumb.className = "thumb";
    const svg = thumbnail(entry.id);
    if (svg) thumb.append(svg);
    const text = document.createElement("div");
    const link = document.createElement("a");
    link.href = `solve?f=${encodeURIComponent(entry.id)}`;
    link.textContent = entry.title || "Untitled puzzle";
    const info = document.createElement("div");
    info.className = "meta";
    info.textContent = describe(entry);
    text.append(link, info);
    const state = filledOf(entry.id);
    if (state && state.filled && !state.done) {
      const bar = document.createElement("div");
      bar.className = "filled-bar";
      bar.setAttribute("aria-hidden", "true");
      const fill = document.createElement("i");
      fill.style.width = `${(100 * state.share).toFixed(1)}%`;
      bar.append(fill);
      text.append(bar);
    }
    item.append(thumb, text);
    if (extra) item.append(extra);
    return item;
  }

  root.SolveFiles = { list, open, load, touch, remove, progress, filledOf, describe, thumbnail, row, progressKey: (id) => PROGRESS + id };
})(self);
