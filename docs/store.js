/* fillmein's saved puzzles, shared by every page. Each puzzle has an id, carried in the page's address
   (grid.html?p=ID), and is saved in three parts so tabs open side by side never overwrite each other:
   the Grid page saves the grid, the Clues page the clues, the Export page the puzzle's details. An index
   lists the puzzles for the home page. Pages redraw when another tab (or the Back button) changes their
   puzzle. Everything is saved in this browser; account.js copies it to a signed-in account and back.
   Needs filler.js for Gridfill.parseGrid. */
(function (root) {
  "use strict";

  const INDEX = "fillmein:puzzles";
  const META_FIELDS = ["title", "author", "copyright", "notes"];
  const PAGES = ["grid.html", "clues.html", "export.html"];

  const read = (key) => {
    try { return JSON.parse(localStorage.getItem(key)); } catch (error) { return null; }
  };
  const write = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { /* storage unavailable */ }
  };
  const letterOf = (value) => (/^[A-Z]$/.test(value) ? value : "");
  const clueKey = (slot) => `${slot.direction}:${slot.row},${slot.col}`;
  const keysFor = (pid) => ({ grid: `fillmein:${pid}:grid`, clues: `fillmein:${pid}:clues`, details: `fillmein:${pid}:details` });
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  /* Tell this tab's other scripts that a puzzle changed: "fillmein:saved" for edits made in this browser
     (account.js sends them up to the account), "fillmein:changed" for anything that changed underneath
     the page, such as a newer copy that came down from the account. */
  const announce = (type, pid, part) => root.dispatchEvent(new CustomEvent(type, { detail: { id: pid, part } }));

  let id = null; // the puzzle this page shows, once open() has found it

  /* {v, puzzles: {id: {created, updated}}}. The first time, the single puzzle earlier versions kept
     (under gridfill:* keys) becomes the first puzzle. */
  function readIndex() {
    const index = read(INDEX);
    if (index && index.puzzles && typeof index.puzzles === "object") return index;
    const fresh = { v: 1, puzzles: {} };
    const grid = read("gridfill:v2") || read("gridfill:v1");
    if (grid) {
      const first = newId();
      const keys = keysFor(first);
      write(keys.grid, grid);
      for (const [part, old] of [["clues", "gridfill:clues:v1"], ["details", "gridfill:details:v1"]]) {
        const value = read(old);
        if (value) write(keys[part], value);
      }
      fresh.puzzles[first] = { created: Date.now(), updated: Date.now() };
    }
    write(INDEX, fresh);
    return fresh;
  }

  /* Every saved puzzle, most recently edited first: [{id, created, updated}]. */
  function list() {
    return Object.entries(readIndex().puzzles)
      .map(([pid, entry]) => ({ id: pid, created: entry.created || 0, updated: entry.updated || 0 }))
      .sort((a, b) => b.updated - a.updated);
  }

  function create() {
    const index = readIndex();
    const pid = newId();
    index.puzzles[pid] = { created: Date.now(), updated: Date.now() };
    write(INDEX, index);
    return pid;
  }

  function remove(pid) {
    forget(pid);
    announce("fillmein:saved", pid, "deleted");
  }

  /* Drop a puzzle from this browser only: account.js does this for puzzles deleted on another device,
     or kept in an account that has signed out. */
  function forget(pid) {
    const index = readIndex();
    delete index.puzzles[pid];
    write(INDEX, index);
    try {
      for (const key of Object.values(keysFor(pid))) localStorage.removeItem(key);
    } catch (error) { /* storage unavailable */ }
    announce("fillmein:changed", pid, "deleted");
  }

  /* Find the puzzle named in the page's address (or, with no name, the most recently edited one) and
     put its id in the address and in links to the other pages. With create, a page with no puzzle to
     show starts a new one, as the Grid page does. */
  function open({ create: startNew = false } = {}) {
    const wanted = new URLSearchParams(root.location.search).get("p");
    if (wanted) id = readIndex().puzzles[wanted] ? wanted : null;
    else id = list().length ? list()[0].id : null;
    if (!id && startNew) id = create();
    if (id && id !== wanted) {
      const url = new URL(root.location.href);
      url.searchParams.set("p", id);
      root.history.replaceState(root.history.state, "", url);
    }
    linkPages();
    return id;
  }

  /* The storage keys of the page's puzzle, or null. */
  const keys = () => (id ? keysFor(id) : null);

  /* A link to another page for the same puzzle. */
  const href = (page) => (id ? `${page}?p=${id}` : page);

  function linkPages(scope = document) {
    if (!id) return;
    for (const link of scope.querySelectorAll("a[href]")) {
      const page = link.getAttribute("href").split("?")[0];
      if (PAGES.includes(page)) link.setAttribute("href", href(page));
    }
  }

  /* Mark part of the page's puzzle (grid, clues or details) as just saved: this orders the home page's
     list and tells account.js which copy of the part is newest. */
  function touch(part) {
    if (!id) return;
    const index = readIndex();
    const now = Date.now();
    const entry = { created: now, ...index.puzzles[id], updated: now };
    entry.parts = { ...entry.parts, [part]: now };
    index.puzzles[id] = entry;
    write(INDEX, index);
    announce("fillmein:saved", id, part);
  }

  /* The Grid page's saved state, just as it wrote it, or null. */
  const gridData = (pid = id) => (pid ? read(keysFor(pid).grid) : null);

  function saveGrid(data) {
    if (!id) return;
    const text = JSON.stringify(data);
    try {
      if (localStorage.getItem(keysFor(id).grid) === text) return;
      localStorage.setItem(keysFor(id).grid, text);
    } catch (error) {
      return;
    }
    touch("grid");
  }

  /* A saved grid as {W, H, blocks, letters, slots}, or null if the Grid page hasn't saved one. */
  function loadGrid(pid = id) {
    const data = gridData(pid);
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
  function loadClues(pid = id) {
    if (!pid) return {};
    let saved = read(keysFor(pid).clues);
    if (!saved) {
      // Earlier versions saved clues as plain text alongside the grid.
      const old = gridData(pid);
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
    if (!id) return;
    write(keysFor(id).clues, { v: 1, clues });
    touch("clues");
  }

  /* The puzzle's title, author, copyright and notes. */
  function loadDetails(pid = id) {
    // Earlier versions kept details with the clues, or with the grid before that.
    const saved = (pid && (read(keysFor(pid).details) || (read(keysFor(pid).clues) || {}).meta || (gridData(pid) || {}).meta)) || {};
    const details = {};
    for (const field of META_FIELDS) details[field] = typeof saved[field] === "string" ? saved[field] : "";
    return details;
  }

  function saveDetails(details) {
    if (!id) return;
    write(keysFor(id).details, details);
    touch("details");
  }

  // --- for account.js ---

  /* The index's entries as saved: {id: {created, updated, parts: {grid, clues, details}, owner}}. */
  const entries = () => readIndex().puzzles;

  /* When a part was last saved in this browser; puzzles saved before parts were timed use their last edit. */
  const partTime = (entry, part) => (entry && ((entry.parts && entry.parts[part]) || entry.updated)) || 0;

  /* A part just as it was saved, or null. */
  const partData = (pid, part) => read(keysFor(pid)[part]);

  /* Save a newer copy of a part that came from the account, without announcing it as an edit to send back. */
  function applyRemote(pid, part, value, time) {
    const index = readIndex();
    const entry = { created: time, updated: 0, ...index.puzzles[pid] };
    entry.parts = { ...entry.parts, [part]: time };
    entry.updated = Math.max(entry.updated || 0, time);
    index.puzzles[pid] = entry;
    write(INDEX, index);
    write(keysFor(pid)[part], value);
    announce("fillmein:changed", pid, part);
  }

  /* Record the account a puzzle is kept in, adding the puzzle to the index if it's new to this browser. */
  function setOwner(pid, owner, created) {
    const index = readIndex();
    index.puzzles[pid] = { created: created || Date.now(), updated: 0, ...index.puzzles[pid], owner };
    write(INDEX, index);
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

  /* Call redraw whenever the page's saved puzzle may have changed underneath it. */
  function watch(redraw) {
    root.addEventListener("storage", (event) => {
      if (event.key === null || (id && Object.values(keysFor(id)).includes(event.key))) redraw();
    });
    root.addEventListener("fillmein:changed", (event) => {
      if (event.detail.id === id) redraw();
    });
    // The Back button can restore an old copy of a page from the browser's cache.
    root.addEventListener("pageshow", (event) => {
      if (event.persisted) redraw();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") redraw();
    });
  }

  /* Show the page's puzzle title in a field and save what's typed there. The Export page can change the
     other details meanwhile, so each save starts from the latest saved details. */
  function bindTitle(input) {
    if (!input) return;
    input.disabled = !id;
    const show = () => {
      if (document.activeElement !== input) input.value = loadDetails().title;
    };
    input.addEventListener("input", () => {
      const details = loadDetails();
      details.title = input.value;
      saveDetails(details);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
    });
    watch(show);
    show();
  }

  /* The Clues tab's count: how many of the grid's entries have a clue. */
  function renderTabs(slots, clues) {
    const count = document.querySelector('.tab [data-count="clues"]');
    if (!count) return;
    count.textContent = slots.length ? `${slots.filter((slot) => hasClue(clues, slot)).length}/${slots.length}` : "";
  }

  root.GridfillStore = {
    INDEX, META_FIELDS,
    open, list, create, remove, forget, keys, href, linkPages,
    entries, partTime, partData, applyRemote, setOwner,
    clueKey, gridData, saveGrid, loadGrid, loadClues, saveClues, loadDetails, saveDetails,
    answerOf, hasClue, isStale, puzzle, watch, renderTabs, bindTitle,
  };
})(self);
