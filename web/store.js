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
  /* A time for a part just saved: now, or a moment after the copy it replaces if that one was stamped
     later (by a device whose clock runs ahead), so the newest edit always counts as the newest when the
     account merges copies from different devices. */
  const stampFor = (entry, part) => Math.max(Date.now(), partTime(entry, part) + 1);

  let id = null; // the puzzle this page shows, once open() has found it
  let wantedId = null; // the puzzle the address named, if any
  let missing = false; // the address named a puzzle this browser doesn't have

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
    wantedId = wanted || null;
    if (wanted) id = readIndex().puzzles[wanted] ? wanted : null;
    else id = list().length ? list()[0].id : null;
    missing = Boolean(wanted && !id);
    // Only a page with no puzzle named starts a new one: a link to a puzzle this browser doesn't have
    // (not synced down yet, or deleted) mustn't quietly turn into a different puzzle.
    if (!id && startNew && !wanted) id = create();
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
    entry.parts = { ...entry.parts, [part]: stampFor(index.puzzles[id], part) };
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
    // The folder path it sits in on the My puzzles page; kept with the details so it follows the puzzle.
    details.folder = typeof saved.folder === "string" ? saved.folder : "";
    return details;
  }

  /* Folders someone has made, whether or not anything is in them yet. A folder is a path, with the
     names of its parents in front of it ("Themeless/Minis"), so folders can sit inside one another.
     Which folder a puzzle is in travels with the puzzle; this list is what keeps an empty folder
     around on this device. */
  const FOLDER_DEPTH = 8;

  /* A folder path with its names tidied: no blanks, no runaway lengths, no stray slashes. */
  function cleanPath(path) {
    return String(path || "")
      .split("/")
      .map((name) => name.trim().slice(0, 60))
      .filter(Boolean)
      .slice(0, FOLDER_DEPTH)
      .join("/");
  }

  const parentOf = (path) => path.split("/").slice(0, -1).join("/");
  const nameOf = (path) => path.split("/").pop() || "";
  /* A folder and everything filed inside it. */
  const inside = (path, other) => other === path || other.startsWith(`${path}/`);

  const folders = () => {
    const index = readIndex();
    const kept = Array.isArray(index.folders) ? index.folders : [];
    return [...new Set(kept.map(cleanPath).filter(Boolean))];
  };

  function writeFolders(list) {
    const index = readIndex();
    index.folders = [...new Set(list.filter(Boolean))];
    write(INDEX, index);
    announce("fillmein:changed", "", "folders");
  }

  /* Add a folder, and its parents with it, so the way down to it always exists. */
  function addFolder(path) {
    const clean = cleanPath(path);
    if (!clean) return "";
    const names = clean.split("/");
    const wanted = names.map((_, i) => names.slice(0, i + 1).join("/"));
    writeFolders([...folders(), ...wanted]);
    return clean;
  }

  /* Forget a folder and any folders inside it. The puzzles filed there are the caller's to move. */
  function removeFolder(path) {
    const clean = cleanPath(path);
    if (!clean) return;
    writeFolders(folders().filter((other) => !inside(clean, other)));
  }

  /* Rename or move a folder to a whole new path, taking what's inside it along. */
  function renameFolder(from, to) {
    const was = cleanPath(from);
    const now = cleanPath(to);
    if (!was || !now || now === was || inside(was, now)) return was;
    const moved = (other) => (inside(was, other) ? now + other.slice(was.length) : other);
    writeFolders([
      ...folders().map(moved),
      ...now.split("/").map((_, i, names) => names.slice(0, i + 1).join("/")),
    ]);
    for (const pid of Object.keys(readIndex().puzzles)) {
      const folder = cleanPath(loadDetails(pid).folder);
      if (folder && inside(was, folder)) setFolder(pid, moved(folder));
    }
    return now;
  }

  /* Move a folder into another one (an empty parent means the top level), keeping its own name. */
  function moveFolder(path, parent) {
    const was = cleanPath(path);
    const into = cleanPath(parent);
    if (!was || inside(was, into)) return was;
    const now = into ? `${into}/${nameOf(was)}` : nameOf(was);
    return now === was ? was : renameFolder(was, now);
  }

  /* A copy of a puzzle, grid, clues and all, filed where the caller asks. */
  function duplicate(pid, folder) {
    if (!pid || !readIndex().puzzles[pid]) return "";
    const copy = create();
    const from = keysFor(pid);
    const to = keysFor(copy);
    for (const part of ["grid", "clues", "details"]) {
      const value = read(from[part]);
      if (value) write(to[part], value);
    }
    const details = loadDetails(copy);
    details.folder = cleanPath(folder);
    write(to.details, details);
    const index = readIndex();
    const now = Date.now();
    index.puzzles[copy] = { created: now, updated: now, parts: { grid: now, clues: now, details: now } };
    write(INDEX, index);
    for (const part of ["grid", "clues", "details"]) announce("fillmein:saved", copy, part);
    return copy;
  }

  /* A puzzle read from a file (importers.js) becomes a new saved puzzle, filed in a folder: its letters
     go in as ink, each clue is written for the answer it came with, and whether the blocks are symmetric
     decides whether the Grid page mirrors them. Returns the new id. */
  function importPuzzle(puzzle, folder = "") {
    const { width: W, height: H, cells } = puzzle;
    const pid = create();
    const to = keysFor(pid);
    const symmetry = cells.every((cell, i) => (cell === "#") === (cells[W * H - 1 - i] === "#"));
    write(to.grid, {
      v: 2, W, H, sel: Math.max(0, cells.findIndex((cell) => cell !== "#")), dir: "across",
      blocks: cells.map((cell) => (cell === "#" ? "#" : ".")).join(""),
      ink: cells.map((cell) => (/^[A-Z]$/.test(cell) ? cell : ".")).join(""),
      pencil: ".".repeat(W * H),
      symmetry, tint: true, minScore: 50, allowPopular: false, timeLimit: 30, lists: { id: "built-in" },
    });
    const grid = loadGrid(pid);
    const clues = {};
    for (const slot of grid.slots) {
      const text = puzzle.clues[clueKey(slot)];
      if (typeof text !== "string" || !text.trim()) continue;
      const answer = answerOf(grid, slot);
      clues[clueKey(slot)] = { text: text.trim(), answer: answer.length === slot.cells.length ? answer : "" };
    }
    write(to.clues, { v: 1, clues });
    const details = {};
    for (const field of META_FIELDS) details[field] = String(puzzle[field] || "").slice(0, field === "title" ? 120 : 2000);
    details.folder = cleanPath(folder);
    write(to.details, details);
    const index = readIndex();
    const now = Date.now();
    index.puzzles[pid] = { created: now, updated: now, parts: { grid: now, clues: now, details: now } };
    write(INDEX, index);
    for (const part of ["grid", "clues", "details"]) announce("fillmein:saved", pid, part);
    return pid;
  }

  /* Rename a puzzle from outside its own pages. */
  function setTitle(pid, title) {
    if (!pid) return;
    const details = loadDetails(pid);
    details.title = String(title || "").slice(0, 120);
    write(keysFor(pid).details, details);
    const index = readIndex();
    const now = Date.now();
    const entry = { created: now, ...index.puzzles[pid], updated: now };
    entry.parts = { ...entry.parts, details: stampFor(index.puzzles[pid], "details") };
    index.puzzles[pid] = entry;
    write(INDEX, index);
    announce("fillmein:saved", pid, "details");
  }

  /* Put a puzzle in a folder (an empty name means no folder). */
  function setFolder(pid, folder) {
    if (!pid) return;
    const details = loadDetails(pid);
    details.folder = cleanPath(folder);
    write(keysFor(pid).details, details);
    const index = readIndex();
    const now = Date.now();
    const entry = { created: now, ...index.puzzles[pid], updated: now };
    entry.parts = { ...entry.parts, details: stampFor(index.puzzles[pid], "details") };
    index.puzzles[pid] = entry;
    write(INDEX, index);
    announce("fillmein:saved", pid, "details");
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
      ...Object.fromEntries(META_FIELDS.map((field) => [field, details[field] || ""])),
    };
  }

  /* Call redraw whenever the page's saved puzzle may have changed underneath it. */
  function watch(redraw) {
    root.addEventListener("storage", (event) => {
      if (event.key === null || (id && Object.values(keysFor(id)).includes(event.key))) redraw();
    });
    root.addEventListener("fillmein:changed", (event) => {
      if (event.detail.id === id) redraw();
      // The puzzle the address named has arrived (from the account, say): open it.
      else if (missing && event.detail.id === wantedId && readIndex().puzzles[wantedId]) root.location.reload();
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
    const pageName = document.title; // "Grid · fillmein": the puzzle's name goes in front, so tabs tell apart
    const show = () => {
      const title = loadDetails().title;
      if (document.activeElement !== input) input.value = title;
      document.title = title.trim() ? `${title.trim()} · ${pageName}` : pageName;
    };
    input.addEventListener("input", () => {
      const details = loadDetails();
      details.title = input.value;
      saveDetails(details);
      show();
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
    open, missing: () => missing, list, create, remove, forget, keys, href, linkPages,
    entries, partTime, partData, applyRemote, setOwner,
    clueKey, gridData, saveGrid, loadGrid, loadClues, saveClues, loadDetails, saveDetails, setFolder, setTitle, duplicate, importPuzzle,
    folders, addFolder, removeFolder, renameFolder, moveFolder, cleanPath, parentOf, nameOf,
    answerOf, hasClue, isStale, puzzle, watch, renderTabs, bindTitle,
  };
})(self);
