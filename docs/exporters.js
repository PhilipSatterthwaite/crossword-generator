/* Gridfill exporters: turn a puzzle into .puz (Across Lite), .ipuz, .jpz (Crossword Compiler)
   files and a printable sheet. Runs in the page or Node.

   A puzzle is {width, height, cells, entries, title, author, copyright, notes}:
   - cells: row-major array of "#" for a block, a letter, or "" for an empty square
   - entries: [{number, direction: "across" | "down", row, col, length, answer, clue}] */
(function (root) {
  "use strict";

  const escapeXml = (text) =>
    String(text || "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]);

  const ordered = (entries, direction) => entries.filter((e) => e.direction === direction).sort((a, b) => a.number - b.number);

  /* Clue number of each cell (0 where no entry starts). */
  function numbers(puzzle) {
    const out = new Array(puzzle.width * puzzle.height).fill(0);
    for (const entry of byNumber(puzzle.entries)) out[entry.row * puzzle.width + entry.col] = entry.number;
    return out;
  }

  /* Entries in number order, across before down when they share a number. */
  function byNumber(entries) {
    return [...entries].sort((a, b) => a.number - b.number || (a.direction === "across" ? -1 : 1));
  }

  /* What still stops a puzzle being complete: empty squares and entries without clues. */
  function problems(puzzle) {
    return {
      empty: puzzle.cells.filter((cell) => cell === "").length,
      unclued: puzzle.entries.filter((entry) => !String(entry.clue || "").trim()).length,
    };
  }

  function requireFull(puzzle, format) {
    if (puzzle.cells.includes("")) throw new Error(`Fill every square before exporting ${format}: it needs a complete answer grid.`);
  }

  // --- .ipuz (http://ipuz.org, version 2) ---

  function toIpuz(puzzle) {
    const { width, height, cells } = puzzle;
    const nums = numbers(puzzle);
    const rows = (value) => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => value(r * width + c)));
    const doc = {
      version: "http://ipuz.org/v2",
      kind: ["http://ipuz.org/crossword#1"],
      origin: "fillmein",
      title: puzzle.title || "Untitled",
    };
    for (const field of ["author", "copyright", "notes"]) if (puzzle[field]) doc[field] = puzzle[field];
    Object.assign(doc, {
      dimensions: { width, height },
      block: "#",
      empty: 0,
      puzzle: rows((i) => (cells[i] === "#" ? "#" : nums[i])),
      solution: rows((i) => (cells[i] === "#" ? "#" : cells[i] || null)),
      clues: {
        Across: ordered(puzzle.entries, "across").map((e) => [e.number, e.clue || ""]),
        Down: ordered(puzzle.entries, "down").map((e) => [e.number, e.clue || ""]),
      },
    });
    return JSON.stringify(doc, null, 2);
  }

  // --- .puz (Across Lite, version 1.3) ---

  /* Across Lite's rotating 16-bit checksum over a run of bytes. */
  function checksum(bytes, sum = 0) {
    for (const byte of bytes) {
      sum = sum & 1 ? (sum >> 1) | 0x8000 : sum >> 1;
      sum = (sum + byte) & 0xffff;
    }
    return sum;
  }

  /* Text as Latin-1 bytes (Across Lite's encoding); anything outside it becomes "?". */
  const latin1 = (text) => Array.from(String(text || ""), (ch) => (ch.codePointAt(0) < 256 ? ch.codePointAt(0) : 63));

  function toPuz(puzzle) {
    const { width, height, cells } = puzzle;
    if (width > 255 || height > 255) throw new Error("Across Lite grids can be at most 255 squares on a side.");
    requireFull(puzzle, "to .puz");

    const solution = cells.map((cell) => (cell === "#" ? 0x2e : cell.charCodeAt(0))); // "." marks a block
    const state = cells.map((cell) => (cell === "#" ? 0x2e : 0x2d));                   // "-" marks an unsolved square
    const title = latin1(puzzle.title || "Untitled");
    const author = latin1(puzzle.author);
    const copyright = latin1(puzzle.copyright);
    const notes = latin1(puzzle.notes);
    const clues = byNumber(puzzle.entries).map((entry) => latin1(entry.clue));
    const terminated = (bytes) => bytes.concat([0]);

    // Title, author, copyright and notes count with their NUL when present; clues count without.
    const textChecksum = (sum) => {
      for (const field of [title, author, copyright]) if (field.length) sum = checksum(terminated(field), sum);
      for (const clue of clues) sum = checksum(clue, sum);
      if (notes.length) sum = checksum(terminated(notes), sum);
      return sum;
    };

    // Width, height, clue count, puzzle type (1: normal) and scrambled state (0: not scrambled).
    const counts = [width, height, clues.length & 0xff, clues.length >> 8, 1, 0, 0, 0];
    const countsSum = checksum(counts);
    const sums = [countsSum, checksum(solution), checksum(state), textChecksum(0)];
    const fileSum = textChecksum(checksum(state, checksum(solution, countsSum)));

    const header = new Uint8Array(0x34);
    const view = new DataView(header.buffer);
    view.setUint16(0x00, fileSum, true);
    Array.from("ACROSS&DOWN").forEach((ch, i) => (header[0x02 + i] = ch.charCodeAt(0)));
    view.setUint16(0x0e, countsSum, true);
    const mask = "ICHEATED";
    sums.forEach((sum, i) => {
      header[0x10 + i] = mask.charCodeAt(i) ^ (sum & 0xff);
      header[0x14 + i] = mask.charCodeAt(i + 4) ^ (sum >> 8);
    });
    Array.from("1.3").forEach((ch, i) => (header[0x18 + i] = ch.charCodeAt(0)));
    header.set(counts, 0x2c);

    const body = [
      ...solution,
      ...state,
      ...terminated(title),
      ...terminated(author),
      ...terminated(copyright),
      ...clues.flatMap(terminated),
      ...terminated(notes),
    ];
    const file = new Uint8Array(header.length + body.length);
    file.set(header);
    file.set(body, header.length);
    return file;
  }

  // --- .jpz (Crossword Compiler XML) ---

  function toJpz(puzzle) {
    const { width, height, cells } = puzzle;
    requireFull(puzzle, "to .jpz");
    const nums = numbers(puzzle);
    const cellXml = cells.map((cell, i) => {
      const x = (i % width) + 1;
      const y = Math.floor(i / width) + 1;
      if (cell === "#") return `      <cell x="${x}" y="${y}" type="block"/>`;
      return `      <cell x="${x}" y="${y}" solution="${cell}"${nums[i] ? ` number="${nums[i]}"` : ""}/>`;
    });
    const across = ordered(puzzle.entries, "across");
    const down = ordered(puzzle.entries, "down");
    const wordXml = [...across, ...down].map((e, k) => {
      const x = e.direction === "across" ? `${e.col + 1}-${e.col + e.length}` : `${e.col + 1}`;
      const y = e.direction === "down" ? `${e.row + 1}-${e.row + e.length}` : `${e.row + 1}`;
      return `    <word id="${k + 1}" x="${x}" y="${y}"/>`;
    });
    const clueXml = (list, label, firstId) =>
      `    <clues ordering="normal">\n      <title><b>${label}</b></title>\n` +
      list.map((e, k) => `      <clue word="${firstId + k}" number="${e.number}">${escapeXml(e.clue)}</clue>`).join("\n") +
      "\n    </clues>";

    return `<?xml version="1.0" encoding="UTF-8"?>
<crossword-compiler-applet xmlns="http://crossword.info/xml/crossword-compiler">
<rectangular-puzzle xmlns="http://crossword.info/xml/rectangular-puzzle" alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ">
  <metadata>
    <title>${escapeXml(puzzle.title || "Untitled")}</title>
    <creator>${escapeXml(puzzle.author)}</creator>
    <copyright>${escapeXml(puzzle.copyright)}</copyright>
    <description>${escapeXml(puzzle.notes)}</description>
  </metadata>
  <crossword>
    <grid width="${width}" height="${height}">
      <grid-look numbering-scheme="normal"/>
${cellXml.join("\n")}
    </grid>
${wordXml.join("\n")}
${clueXml(across, "Across", 1)}
${clueXml(down, "Down", across.length + 1)}
  </crossword>
</rectangular-puzzle>
</crossword-compiler-applet>
`;
  }

  // --- printable sheet ---

  /* Two pages of HTML: the blank puzzle with its clues, then the answer key.
     The page supplies the print styles (.print-page, .print-grid, .print-clues). */
  function toPrintHtml(puzzle) {
    const { width, height, cells } = puzzle;
    const nums = numbers(puzzle);
    const grid = (withAnswers) => {
      const rows = [];
      for (let r = 0; r < height; r++) {
        const row = [];
        for (let c = 0; c < width; c++) {
          const i = r * width + c;
          if (cells[i] === "#") row.push('<div class="pc b"></div>');
          else row.push(`<div class="pc">${nums[i] ? `<span class="pn">${nums[i]}</span>` : ""}${withAnswers ? escapeXml(cells[i]) : ""}</div>`);
        }
        rows.push(`<div class="pr">${row.join("")}</div>`);
      }
      return `<div class="print-grid" style="--cols:${width}">${rows.join("")}</div>`;
    };
    const clueList = (direction, label) =>
      `<h2>${label}</h2>` + ordered(puzzle.entries, direction).map((e) => `<p><b>${e.number}</b> ${escapeXml(e.clue) || "&nbsp;"}</p>`).join("");
    const title = escapeXml(puzzle.title || "Untitled");
    const byline = [puzzle.author ? `By ${escapeXml(puzzle.author)}` : "", escapeXml(puzzle.copyright)].filter(Boolean).join(" · ");
    return (
      `<section class="print-page"><header class="print-head"><h1>${title}</h1>${byline ? `<p>${byline}</p>` : ""}</header>` +
      grid(false) +
      `<div class="print-clues">${clueList("across", "Across")}${clueList("down", "Down")}</div>` +
      (puzzle.notes ? `<p class="print-note">${escapeXml(puzzle.notes)}</p>` : "") +
      `</section><section class="print-page"><header class="print-head"><h1>${title}: answers</h1></header>${grid(true)}</section>`
    );
  }

  const api = { problems, toIpuz, toPuz, toJpz, toPrintHtml };
  root.GridExport = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
