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

  root.SolveFiles = { list, open, load, touch, remove, progress, progressKey: (id) => PROGRESS + id };
})(self);
