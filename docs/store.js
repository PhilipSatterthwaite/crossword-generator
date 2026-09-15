/* Gridfill's shared puzzle record, used by every page. Each page saves only its own part, so tabs
   open side by side never overwrite each other: the Grid page saves the grid, the Clues page the
   clues, the Export page the puzzle's details. Pages redraw when another tab (or the Back button)
   changes any part. Needs filler.js for Gridfill.parseGrid. */
(function (root) {
  "use strict";

  const GRID_STORE = "gridfill:v2";
  const CLUE_STORE = "gridfill:clues:v1";
  const DETAILS_STORE = "gridfill:details:v1";
  const META_FIELDS = ["title", "author", "copyright", "notes"];

  const read = (key) => {
    try { return JSON.parse(localStorage.getItem(key)); } catch (error) { return null; }
  };
  const write = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { /* storage unavailable */ }
  };
  const letterOf = (value) => (/^[A-Z]$/.test(value) ? value : "");
  const clueKey = (slot) => `${slot.direction}:${slot.row},${slot.col}`;

  /* The saved grid as {W, H, blocks, letters, slots}, or null if the Grid page hasn't saved one. */
  function loadGrid() {
    const data = read(GRID_STORE);
    const n = data && data.W > 0 && data.H > 0 ? data.W * data.H : 0;
    if (!n || [data.blocks, data.ink, data.pencil].some((s) => typeof s !== "string" || s.length !== n)) return null;
    const rows = [];
    for (let r = 0; r < data.H; r++) rows.push(data.blocks.slice(r * data.W, (r + 1) * data.W));
    return {
      W: data.W,
      H: data.H,
      blocks: Array.from(data.blocks, (ch) => ch === "#"),
      letters: Array.from({ length: n }, (_, i) => letterOf(data.ink[i]) || letterOf(data.pencil[i])),
      slots: root.Gridfill.parseGrid(rows).slots,
    };
  }

  /* Saved clues: {entry key: {text, answer it was written for ("" if it wasn't complete yet)}}. */
  function loadClues() {
    let saved = read(CLUE_STORE);
    if (!saved) {
      // Earlier versions saved clues as plain text alongside the grid.
      const old = read(GRID_STORE);
      if (old && old.clues && typeof old.clues === "object") {
        saved = { clues: {} };
        for (const [key, text] of Object.entries(old.clues)) if (typeof text === "string") saved.clues[key] = { text, answer: "" };
      }
    }
    const clues = {};
    for (const [key, value] of Object.entries((saved && saved.clues) || {})) {
      if (value && typeof value.text === "string") clues[key] = { text: value.text, answer: typeof value.answer === "string" ? value.answer : "" };
    }
    return clues;
  }

  function saveClues(clues) {
    write(CLUE_STORE, { v: 1, clues });
  }

  /* The puzzle's title, author, copyright and notes. */
  function loadDetails() {
    // Earlier versions kept details with the clues, or with the grid before that.
    const saved = read(DETAILS_STORE) || (read(CLUE_STORE) || {}).meta || (read(GRID_STORE) || {}).meta || {};
    const details = {};
    for (const field of META_FIELDS) details[field] = typeof saved[field] === "string" ? saved[field] : "";
    return details;
  }

  function saveDetails(details) {
    write(DETAILS_STORE, details);
  }

  const answerOf = (grid, slot) => slot.cells.map((i) => grid.letters[i]).join("");
  const hasClue = (clues, slot) => Boolean(clues[clueKey(slot)] && clues[clueKey(slot)].text.trim());
  /* A clue whose entry's answer has changed on the grid since the clue was written. */
  const isStale = (grid, clues, slot) => {
    const clue = clues[clueKey(slot)];
    return Boolean(clue && clue.answer && clue.answer !== answerOf(grid, slot));
  };

  /* The puzzle in the shape exporters.js takes. */
  function puzzle(grid, clues, details) {
    return {
      width: grid.W,
      height: grid.H,
      cells: grid.blocks.map((block, i) => (block ? "#" : grid.letters[i])),
      entries: grid.slots.map((slot) => ({
        number: slot.number,
        direction: slot.direction,
        row: slot.row,
        col: slot.col,
        length: slot.cells.length,
        answer: answerOf(grid, slot),
        clue: clues[clueKey(slot)] ? clues[clueKey(slot)].text : "",
      })),
      ...details,
    };
  }

  /* Call redraw whenever the saved puzzle may have changed underneath this page. */
  function watch(redraw) {
    root.addEventListener("storage", (event) => {
      if ([GRID_STORE, CLUE_STORE, DETAILS_STORE, null].includes(event.key)) redraw();
    });
    // The Back button can restore an old copy of a page from the browser's cache.
    root.addEventListener("pageshow", (event) => {
      if (event.persisted) redraw();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") redraw();
    });
  }

  /* The Clues tab's count: how many of the grid's entries have a clue. */
  function renderTabs(slots, clues) {
    const count = document.querySelector('.tab [data-count="clues"]');
    if (!count) return;
    count.textContent = slots.length ? `${slots.filter((slot) => hasClue(clues, slot)).length}/${slots.length}` : "";
  }

  root.GridfillStore = {
    GRID_STORE, CLUE_STORE, DETAILS_STORE, META_FIELDS,
    clueKey, loadGrid, loadClues, saveClues, loadDetails, saveDetails,
    answerOf, hasClue, isStale, puzzle, watch, renderTabs,
  };
})(self);
