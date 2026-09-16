/* fillmein's custom word lists: reading the usual construction file formats, keeping lists in this
   browser (IndexedDB, so nothing leaves the device), and merging them into the built-in list.

   A merged list is the same shape the solver takes, {length: [letters, scores, popular]}: the words of
   each length run together, best score first, their scores as a comma list, and a base64 bitset of the
   popular ones. Only the lengths a change touches are rebuilt; the rest are passed through untouched.

   Per-word edits made on the Grid page (remove this word, score it differently) live here too, as
   "overrides", and apply whatever list is in use. account.js encrypts and syncs all of it. */
(function (root) {
  "use strict";

  const DB = "fillmein";
  const VERSION = 1;
  const LISTS = "lists";
  const SETTINGS = "settings";
  const OVERRIDES = "overrides"; // the single settings record holding per-word edits
  const TOMBSTONES = "tombstones"; // lists deleted here, still to be deleted in the account
  const MIN_LENGTH = 2;
  const MAX_LENGTH = 25;
  const DEFAULT_SCORE = 50;

  const listeners = new Set();
  const announce = () => {
    for (const listener of listeners) listener();
  };

  // --- reading files ---

  /* One word per line, with an optional score after ";", "," or a tab (Broda, Crossfire, Crossword
     Compiler and plain lists all fit): "WORD;60", "WORD,60", "WORD\t60", or just "WORD". Anything that
     isn't a letter is dropped, so "ONE A" becomes ONEA, the way run-together entries are stored. */
  function parse(text) {
    const words = new Map();
    let skipped = 0;
    for (const line of String(text).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
      const [rawWord, rawScore] = trimmed.split(/[;,\t]|\s{2,}/, 2);
      const word = (rawWord || "").toUpperCase().replace(/[^A-Z]/g, "");
      if (word.length < MIN_LENGTH || word.length > MAX_LENGTH) {
        skipped++;
        continue;
      }
      const score = rawScore === undefined || rawScore.trim() === "" ? DEFAULT_SCORE : Number(rawScore.trim());
      const clean = Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : DEFAULT_SCORE;
      words.set(word, Math.max(words.get(word) ?? -1, clean)); // a word listed twice keeps its best score
    }
    return { words: [...words].sort((a, b) => (a[0] < b[0] ? -1 : 1)), skipped };
  }

  // --- keeping lists in this browser ---

  let opening = null;
  function open() {
    opening = opening || new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(LISTS)) db.createObjectStore(LISTS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return opening;
  }

  async function run(store, mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const request = work(transaction.objectStore(store));
      transaction.onerror = () => reject(transaction.error);
      if (request) request.onsuccess = () => resolve(request.result);
      else transaction.oncomplete = () => resolve();
    });
  }

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  /* Every list saved here: [{id, name, count, updated, words}]. */
  const all = () => run(LISTS, "readonly", (store) => store.getAll()).then((lists) => lists.sort((a, b) => b.updated - a.updated));

  async function add(name, text) {
    const { words, skipped } = parse(text);
    if (!words.length) throw new Error("That file had no words in it.");
    const list = { id: newId(), name: String(name || "Word list").slice(0, 120), count: words.length, updated: Date.now(), words };
    await run(LISTS, "readwrite", (store) => store.put(list));
    announce();
    return { list, skipped };
  }

  /* Drop a list from this browser without asking the account to delete it: for lists that have already
     gone from the account, deleted on another device. */
  async function forgetList(id) {
    await run(LISTS, "readwrite", (store) => store.delete(id));
    announce();
  }

  /* A new list from words already in hand: cloning a list, or the built-in one. */
  async function create(name, words) {
    const list = {
      id: newId(),
      name: String(name || "Word list").slice(0, 120),
      count: words.length,
      updated: Date.now(),
      words: words.map(([word, score]) => [word, score]),
    };
    await run(LISTS, "readwrite", (store) => store.put(list));
    announce();
    return list;
  }

  const remove = (id) =>
    inTurn(async () => {
      await run(LISTS, "readwrite", (store) => store.delete(id));
      // Remembered so the deletion reaches the account too, next time it syncs.
      const gone = await getSetting(TOMBSTONES);
      await setSetting(TOMBSTONES, [...new Set([...(gone || []), id])]);
      announce();
    });

  /* Save a list as it came from the account, keeping its id and time. */
  async function put(list) {
    await run(LISTS, "readwrite", (store) => store.put({
      id: list.id,
      name: String(list.name || "Word list").slice(0, 120),
      count: list.count || list.words.length,
      updated: list.updated || Date.now(),
      words: list.words,
    }));
    announce();
  }

  async function rename(id, name) {
    const list = await run(LISTS, "readonly", (store) => store.get(id));
    if (!list) return;
    list.name = String(name || "").slice(0, 120) || list.name;
    list.updated = Date.now();
    await run(LISTS, "readwrite", (store) => store.put(list));
    announce();
  }

  // --- per-word edits, which apply to any list in use ---

  const emptyEdits = () => ({ scores: {}, removed: [], recent: [] });
  const tidyEdits = (value) => ({
    scores: (value && value.scores) || {},
    removed: (value && value.removed) || [],
    recent: (value && value.recent) || [],
  });

  /* Anything else worth keeping on this device: the remembered encryption key, deletions still to
     reach the account. Values go through IndexedDB, so a CryptoKey can live here as itself. */
  const getSetting = (key) => run(SETTINGS, "readonly", (store) => store.get(key)).then((row) => (row ? row.value : null));
  const setSetting = (key, value) =>
    value === null || value === undefined
      ? run(SETTINGS, "readwrite", (store) => store.delete(key))
      : run(SETTINGS, "readwrite", (store) => store.put({ key, value, updated: Date.now() }));

  const tombstones = () => getSetting(TOMBSTONES).then((gone) => gone || []);
  const clearTombstone = async (id) => {
    const gone = await tombstones();
    await setSetting(TOMBSTONES, gone.filter((other) => other !== id));
  };

  /* {list id: {scores, removed, recent}}, where "built-in" is a list id like any other. */
  async function overrides() {
    const saved = await run(SETTINGS, "readonly", (store) => store.get(OVERRIDES));
    const value = (saved && saved.value) || {};
    // Edits made before they were kept per list belonged to the built-in list.
    if (value.scores || value.removed) return { "built-in": tidyEdits(value) };
    const byList = {};
    for (const [id, edits] of Object.entries(value)) byList[id] = tidyEdits(edits);
    return byList;
  }

  /* Just the edits for one list. */
  const editsFor = async (listId) => tidyEdits((await overrides())[listId]);

  /* When the per-word edits last changed here, so syncing can tell which copy is newer. */
  const overridesStamp = () => run(SETTINGS, "readonly", (store) => store.get(OVERRIDES)).then((row) => (row && row.updated) || 0);

  async function saveOverrides(value, stamp) {
    await run(SETTINGS, "readwrite", (store) => store.put({ key: OVERRIDES, value, updated: stamp || Date.now() }));
    announce();
  }

  /* Edits read the saved record, change it and write it back, so they have to take turns: three quick
     clicks at once would otherwise each start from the same copy and only the last would stick. */
  let queue = Promise.resolve();
  function inTurn(work) {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  }

  const change = (listId, work) =>
    inTurn(async () => {
      const all = await overrides();
      const edits = tidyEdits(all[listId]);
      work(edits);
      all[listId] = edits;
      await saveOverrides(all);
    });

  const setScore = (listId, word, score) =>
    change(listId, (edits) => {
      edits.scores[word] = Math.max(0, Math.min(100, Math.round(score)));
      edits.removed = edits.removed.filter((other) => other !== word);
      edits.recent = [word, ...edits.recent.filter((other) => other !== word)].slice(0, 20);
    });

  const removeWord = (listId, word) =>
    change(listId, (edits) => {
      if (!edits.removed.includes(word)) edits.removed.push(word);
      delete edits.scores[word];
      edits.recent = [word, ...edits.recent.filter((other) => other !== word)].slice(0, 20);
    });

  /* Undo an edit: the word goes back to whatever that list says. */
  const restoreWord = (listId, word) =>
    change(listId, (edits) => {
      delete edits.scores[word];
      edits.removed = edits.removed.filter((other) => other !== word);
      edits.recent = edits.recent.filter((other) => other !== word);
    });

  // --- merging ---

  const popularBit = (bytes, i) => Boolean(bytes && (bytes.charCodeAt(i >>> 3) >> (i & 7)) & 1);

  function packPopular(flags) {
    if (!flags.some(Boolean)) return "";
    const bytes = new Uint8Array((flags.length + 7) >>> 3);
    flags.forEach((flag, i) => {
      if (flag) bytes[i >>> 3] |= 1 << (i & 7);
    });
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  /* The words of one length as [word, score, popular], from the built-in list's packed form. */
  function unpack(length, entry) {
    const [letters, scoreText, popularText] = entry;
    const scores = scoreText.split(",");
    const count = letters.length / length;
    const rows = new Array(count);
    for (let i = 0; i < count; i++) rows[i] = [letters.substr(i * length, length), Number(scores[i]), popularBit(popularText, i)];
    return rows;
  }

  function pack(rows) {
    // Best score first, as the solver's lookups assume; same score keeps alphabetical order.
    rows.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return [rows.map((row) => row[0]).join(""), rows.map((row) => row[1]).join(","), packPopular(rows.map((row) => row[2]))];
  }

  /* The built-in list with custom words, score changes and removals folded in.
     use: "built-in" | "custom" | "both"; lists: the custom lists to use; edits: {scores, removed}. */
  function merge(base, { use = "built-in", lists = [], edits = emptyEdits() } = {}) {
    const custom = new Map(); // word -> score
    if (use !== "built-in") {
      for (const list of lists) for (const [word, score] of list.words) custom.set(word, score);
    }
    const scores = edits.scores || {};
    const removed = new Set(edits.removed || []);
    for (const [word, score] of Object.entries(scores)) if (custom.has(word) || use !== "custom") custom.set(word, score);

    const touched = new Set();
    for (const word of custom.keys()) touched.add(word.length);
    for (const word of removed) touched.add(word.length);

    const merged = {};
    const lengths = new Set([...Object.keys(base).map(Number), ...custom.keys()].map((value) => (typeof value === "string" ? value.length : value)));
    for (const length of lengths) {
      const entry = base[length];
      if (use === "custom") {
        // Only their words, though scores set on the Grid page still apply.
        const rows = [...custom].filter(([word]) => word.length === length && !removed.has(word)).map(([word, score]) => [word, score, false]);
        if (rows.length) merged[length] = pack(rows);
        continue;
      }
      if (!entry) {
        const rows = [...custom].filter(([word]) => word.length === length && !removed.has(word)).map(([word, score]) => [word, score, false]);
        if (rows.length) merged[length] = pack(rows);
        continue;
      }
      if (!touched.has(length)) {
        merged[length] = entry; // nothing changed at this length: pass the built-in data straight through
        continue;
      }
      const rows = unpack(length, entry).filter((row) => !removed.has(row[0]));
      const seen = new Map(rows.map((row, i) => [row[0], i]));
      for (const [word, score] of custom) {
        if (word.length !== length || removed.has(word)) continue;
        const at = seen.get(word);
        if (at === undefined) rows.push([word, score, false]);
        else rows[at][1] = score; // their score wins over the built-in one
      }
      if (rows.length) merged[length] = pack(rows);
    }
    return merged;
  }

  /* Everything a page needs to build the list it should be using right now: every list, and the edits
     belonging to the one in use. */
  async function state(listId = "built-in") {
    const [lists, byList] = await Promise.all([all(), overrides()]);
    return { lists, edits: tidyEdits(byList[listId]), byList };
  }

  root.FillmeinLists = {
    parse, all, add, create, put, remove, forgetList, rename,
    overrides, editsFor, overridesStamp, saveOverrides, setScore, removeWord, restoreWord,
    getSetting, setSetting, tombstones, clearTombstone,
    merge, state,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})(self);
