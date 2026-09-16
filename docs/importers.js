/* fillmein importers: read a crossword file (.puz from Across Lite, .ipuz, or .jpz from Crossword
   Compiler) into the shape exporters.js writes, so a puzzle made elsewhere can be opened here.

   read(name, bytes) picks the format from the file name (then from the bytes) and returns
   {width, height, cells, clues, title, author, copyright, notes}:
   - cells: row-major, "#" for a block, a letter, or "" where the file gave no answer;
   - clues: {"across:row,col": text}, keyed the way store.js keys them, using Gridfill.parseGrid to
     number the grid, so a file's own numbering never has to be trusted.
   Throws an Error whose message can be shown as it is. Needs filler.js (Gridfill.parseGrid). */
(function (root) {
  "use strict";

  const MAX_SIDE = 25; // what the Grid page can show
  const MIN_SIDE = 3;

  const letter = (value) => {
    const ch = String(value ?? "").trim().toUpperCase();
    return /^[A-Z]/.test(ch) ? ch[0] : ""; // a rebus keeps its first letter
  };

  /* Slots of a block pattern, from filler.js, with the key each clue is stored under. */
  function slotsOf(width, height, cells) {
    const rows = [];
    for (let r = 0; r < height; r++) rows.push(cells.slice(r * width, (r + 1) * width).map((cell) => (cell === "#" ? "#" : ".")));
    const { slots } = root.Gridfill.parseGrid(rows);
    return slots.map((slot) => ({ ...slot, key: `${slot.direction}:${slot.row},${slot.col}` }));
  }

  function checkSize(width, height) {
    if (!(Number.isInteger(width) && Number.isInteger(height))) throw new Error("The file doesn't say how big the grid is.");
    if (width < MIN_SIDE || height < MIN_SIDE) throw new Error(`That grid is ${width}×${height}; the smallest fillmein takes is ${MIN_SIDE}×${MIN_SIDE}.`);
    if (width > MAX_SIDE || height > MAX_SIDE) throw new Error(`That grid is ${width}×${height}; the largest fillmein takes is ${MAX_SIDE}×${MAX_SIDE}.`);
  }

  const finish = (puzzle) => {
    checkSize(puzzle.width, puzzle.height);
    if (puzzle.cells.length !== puzzle.width * puzzle.height) throw new Error("The file's grid doesn't match its size.");
    if (!puzzle.cells.some((cell) => cell !== "#")) throw new Error("The file's grid has no open squares.");
    for (const field of ["title", "author", "copyright", "notes"]) puzzle[field] = String(puzzle[field] || "").trim().slice(0, 2000);
    return puzzle;
  };

  // --- .puz (Across Lite) ---

  /* Across Lite files are Latin-1 (Windows-1252) by definition; newer tools write UTF-8. Prefer
     UTF-8 when the bytes are valid UTF-8, since Latin-1 accepts anything. */
  function decodeText(bytes) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      return new TextDecoder("windows-1252").decode(bytes);
    }
  }

  function fromPuz(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const magic = String.fromCharCode(...data.subarray(0x02, 0x0d));
    if (data.length < 0x34 || magic !== "ACROSS&DOWN") throw new Error("That isn't an Across Lite .puz file.");
    const width = data[0x2c];
    const height = data[0x2d];
    const clueCount = view.getUint16(0x2e, true);
    const scrambled = view.getUint16(0x32, true);
    if (scrambled) throw new Error("That .puz is locked: its answers are scrambled, and the key to them isn't in the file.");
    checkSize(width, height);
    const n = width * height;
    let at = 0x34;
    const solution = data.subarray(at, at + n);
    at += 2 * n; // past the solution and the solver's state
    // Then NUL-terminated strings: title, author, copyright, each clue, notes.
    const strings = [];
    while (strings.length < clueCount + 4 && at < data.length) {
      let end = at;
      while (end < data.length && data[end] !== 0) end++;
      strings.push(decodeText(data.subarray(at, end)));
      at = end + 1;
    }
    const [title = "", author = "", copyright = ""] = strings;
    const clueTexts = strings.slice(3, 3 + clueCount);
    const notes = strings[3 + clueCount] || "";
    const cells = Array.from(solution, (byte) => (byte === 0x2e || byte === 0x3a ? "#" : letter(String.fromCharCode(byte))));
    // ':' marks an empty square in some writers; '.' is a block. Both came through as "#" above, so
    // put ':' squares back to open.
    solution.forEach((byte, i) => {
      if (byte === 0x3a) cells[i] = "";
    });
    // Clues come in numeric order, an across before a down when they share a number.
    const slots = slotsOf(width, height, cells).sort((a, b) => a.number - b.number || (a.direction === "across" ? -1 : 1));
    if (slots.length !== clueCount) throw new Error(`The file has ${clueCount} clues but its grid has ${slots.length} entries.`);
    const clues = {};
    slots.forEach((slot, i) => {
      if (clueTexts[i]) clues[slot.key] = clueTexts[i];
    });
    return finish({ width, height, cells, clues, title, author, copyright, notes });
  }

  // --- .ipuz ---

  function fromIpuz(text) {
    let doc;
    try {
      // Some writers wrap the JSON in ipuz( ... ).
      doc = JSON.parse(String(text).trim().replace(/^ipuz\s*\(/, "").replace(/\)\s*;?\s*$/, ""));
    } catch (error) {
      throw new Error("That isn't an .ipuz file: it isn't valid JSON.");
    }
    const kinds = [].concat(doc.kind || []);
    if (!kinds.some((kind) => /crossword/i.test(String(kind)))) throw new Error("That .ipuz isn't a crossword.");
    const width = doc.dimensions && doc.dimensions.width;
    const height = doc.dimensions && doc.dimensions.height;
    checkSize(width, height);
    const block = doc.block === undefined ? "#" : String(doc.block);
    const cellValue = (value) => (value && typeof value === "object" ? value.cell ?? value.value : value);
    const layout = Array.isArray(doc.puzzle) ? doc.puzzle : [];
    const solution = Array.isArray(doc.solution) ? doc.solution : [];
    const cells = [];
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const shape = cellValue(layout[r] && layout[r][c]);
        const answer = cellValue(solution[r] && solution[r][c]);
        if (shape === block || answer === block || shape === null) cells.push("#");
        else cells.push(letter(answer));
      }
    }
    const slots = slotsOf(width, height, cells);
    const byNumber = { across: new Map(), down: new Map() };
    for (const slot of slots) byNumber[slot.direction].set(slot.number, slot);
    const clues = {};
    const lists = doc.clues || {};
    for (const [direction, names] of [["across", ["Across", "across"]], ["down", ["Down", "down"]]]) {
      const name = Object.keys(lists).find((key) => names.includes(key) || names.some((n) => key.startsWith(`${n}:`)));
      for (const entry of (name && Array.isArray(lists[name]) ? lists[name] : [])) {
        const [number, text] = Array.isArray(entry) ? entry : [entry && entry.number, entry && entry.clue];
        const slot = byNumber[direction].get(Number(number));
        if (slot && typeof text === "string" && text.trim()) clues[slot.key] = text.trim();
      }
    }
    return finish({ width, height, cells, clues, title: doc.title, author: doc.author, copyright: doc.copyright, notes: doc.notes });
  }

  // --- .jpz (Crossword Compiler XML) ---

  function fromJpz(text) {
    if (typeof DOMParser === "undefined") throw new Error(".jpz files can only be opened in a browser.");
    const xml = new DOMParser().parseFromString(String(text), "application/xml");
    if (xml.getElementsByTagName("parsererror").length) throw new Error("That isn't a .jpz file: the XML doesn't parse.");
    const one = (element, name) => element.getElementsByTagName(name)[0] || null;
    const all = (element, name) => Array.from(element.getElementsByTagName(name));
    const grid = one(xml, "grid");
    if (!grid) throw new Error("That .jpz has no grid in it.");
    const width = Number(grid.getAttribute("width"));
    const height = Number(grid.getAttribute("height"));
    checkSize(width, height);
    const cells = new Array(width * height).fill("");
    for (const cell of all(grid, "cell")) {
      const x = Number(cell.getAttribute("x")) - 1;
      const y = Number(cell.getAttribute("y")) - 1;
      if (!(x >= 0 && x < width && y >= 0 && y < height)) continue;
      const type = cell.getAttribute("type") || "";
      cells[y * width + x] = type === "block" || type === "void" ? "#" : letter(cell.getAttribute("solution"));
    }
    const slots = slotsOf(width, height, cells);
    const byStart = new Map(slots.map((slot) => [`${slot.direction}:${slot.row},${slot.col}`, slot]));
    // A word is a run of cells given as x="1-5" y="3" (across), x="3" y="1-5" (down), or listed cells.
    const words = new Map();
    for (const word of all(xml, "word")) {
      const range = (value) => String(value || "").split("-").map(Number);
      let x = range(word.getAttribute("x"));
      let y = range(word.getAttribute("y"));
      const listed = all(word, "cells");
      if (listed.length) {
        const xs = listed.map((c) => Number(c.getAttribute("x")));
        const ys = listed.map((c) => Number(c.getAttribute("y")));
        x = [Math.min(...xs), Math.max(...xs)];
        y = [Math.min(...ys), Math.max(...ys)];
      }
      if (!(x[0] > 0 && y[0] > 0)) continue;
      const direction = (x[1] ?? x[0]) > x[0] ? "across" : "down";
      words.set(word.getAttribute("id"), byStart.get(`${direction}:${y[0] - 1},${x[0] - 1}`) || null);
    }
    const clues = {};
    for (const clue of all(xml, "clue")) {
      const slot = words.get(clue.getAttribute("word"));
      const clueText = clue.textContent.trim();
      if (slot && clueText) clues[slot.key] = clueText;
    }
    const meta = one(xml, "metadata");
    const field = (name) => (meta && one(meta, name) ? one(meta, name).textContent : "");
    return finish({ width, height, cells, clues, title: field("title"), author: field("creator"), copyright: field("copyright"), notes: field("description") });
  }

  // --- picking the format ---

  /* name: the file's name; bytes: its contents as an ArrayBuffer or Uint8Array. */
  function read(name, bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const extension = String(name || "").toLowerCase().split(".").pop();
    const head = String.fromCharCode(...data.subarray(0, 16));
    if (extension === "puz" || head.includes("ACROSS&DOWN")) return fromPuz(data);
    const text = decodeText(data);
    if (extension === "ipuz" || /^\s*(ipuz\s*\()?\s*\{/.test(text)) return fromIpuz(text);
    if (extension === "jpz" || /^\s*<\?xml|<crossword-compiler/i.test(text)) return fromJpz(text);
    throw new Error("fillmein can open .puz, .ipuz and .jpz files.");
  }

  const api = { read, fromPuz, fromIpuz, fromJpz };
  root.GridImport = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
