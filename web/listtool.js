/* The Word lists page (lists.html) and the Train page (train.html, which the site build makes from
   lists.html): one word at a time, a table, and on the Train page a model that learns from the
   decisions. document.body.dataset.page says which: "edit" or "train". */
(() => {
  "use strict";
  // The page's own saves are counted, so the change notice each one sets off is ignored: re-reading
  // the saved edits mid-way through a two-part save (a score, then "confirmed") brought the word just
  // decided back to the card.
  let localWrites = 0;
  const LISTS = { ...window.FillmeinLists };
  const TRAIN = document.body.dataset.page === "train";
  for (const name of ["removeWord", "restoreWord", "setScore", "keepWord", "unkeepWord", "setEditsFor", "create"]) {
    const write = window.FillmeinLists[name];
    LISTS[name] = async (...args) => {
      localWrites++;
      try {
        return await write(...args);
      } finally {
        localWrites--;
      }
    };
  }
  const $ = (id) => document.getElementById(id);
  const ROW = 34;
  const BUILT_INS = { "built-in": "Built-in list", nyt: "NYT answers" };
  const NYT_UNVETTED = 50; // the NYT answers list scores its unvetted answers this (as the Grid page does)

  let listId = "built-in";
  let state = { lists: [], edits: { scores: {}, removed: [] }, byList: {} };
  let rows = [];     // every word of the list: {word, len, base, score, uses, everyday, vowels, popular, nyt, unvetted, removed, own}
  let shown = [];    // the rows the filters and sort leave, in order
  let sortKey = "uses";
  let sortDown = false;
  let mode = "review";
  let setLength = 0;   // the word length being reviewed, 0 for every length
  let at = 0;          // where the review is in `shown`
  let history = [];    // decisions made, newest last: {index, wasRemoved, wasOwn?, wasScore?}
  let byWord = null; // word -> row, built when needed

  // --- the words ---

  /* The word as its reading splits it: GREEN PAINT. */
  const readingOf = (row) => {
    if (!row.cuts) return row.word;
    const out = [];
    let at = 0;
    for (const edge of row.cuts.split(".").map(Number)) {
      out.push(row.word.slice(at, edge));
      at = edge;
    }
    out.push(row.word.slice(at));
    return out.join(" ");
  };

  /* A count as people read it: 12.3M, 45k, 980, or – for none. */
  const compact = (n) => (!n ? "–" : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n));
  const bit = (bytes, i) => (bytes ? (bytes.charCodeAt(i >>> 3) >> (i & 7)) & 1 : 0);
  const vowelShare = (word) => Math.round((100 * (word.match(/[AEIOU]/g) || []).length) / word.length);

  /* The built-in words as rows, with their stats; only the published ones for the NYT list. */
  function builtInRows(which) {
    const out = [];
    for (const [key, entry] of Object.entries(window.GRIDFILL_WORDS || {})) {
      const len = Number(key);
      const [letters, scoreText, popularText, publishedText, unvettedText] = entry;
      const scores = scoreText.split(",");
      const stats = (window.GRIDFILL_STATS || {})[key];
      const uses = stats ? stats[0].split(",") : null;
      const everyday = stats ? stats[1].split(",") : null;
      const google = stats && stats[2] ? stats[2].split(",") : null;
      const years = stats && stats[3] ? stats[3].split(",") : null;
      const brodas = stats && stats[4] ? stats[4].split(",") : null;
      const zipfs = stats && stats[5] ? stats[5].split(",") : null;
      const cuts = stats && stats[6] ? stats[6].split(",") : null;
      const books = stats && stats[7] ? stats[7].split(",") : null;
      const popular = popularText ? atob(popularText) : "";
      const published = publishedText ? atob(publishedText) : "";
      const unvetted = unvettedText ? atob(unvettedText) : "";
      for (let i = 0; i < scores.length; i++) {
        const nyt = bit(published, i);
        if (which === "nyt" && !nyt) continue;
        const word = letters.substr(i * len, len);
        const unv = bit(unvetted, i);
        out.push({
          word, len,
          base: which === "nyt" && unv ? NYT_UNVETTED : Number(scores[i]),
          score: 0, uses: uses ? Number(uses[i]) : 0, everyday: everyday ? Number(everyday[i]) : 50, google: google ? Number(google[i]) : 0,
          year: years ? Number(years[i]) : 0, broda: brodas && brodas[i] !== "" ? Number(brodas[i]) : -1, zipf: zipfs ? Number(zipfs[i]) / 10 : 0,
          cuts: cuts ? cuts[i] : "", books: books ? Number(books[i]) : 0,
          vowels: vowelShare(word), popular: bit(popular, i), nyt, unvetted: unv, removed: false, own: false,
        });
      }
    }
    return out;
  }

  /* A list of the user's own words: its words, with stats looked up where the built-in list has them. */
  function ownRows(list) {
    if (!byWord) {
      byWord = new Map();
      for (const row of builtInRows("built-in")) byWord.set(row.word, row);
    }
    return list.words.map(([word, score]) => {
      const known = byWord.get(word);
      return {
        word, len: word.length, base: score, score: 0,
        uses: known ? known.uses : 0, everyday: known ? known.everyday : 50, google: known ? known.google : 0,
        year: known ? known.year : 0, broda: known ? known.broda : -1, zipf: known ? known.zipf : 0, cuts: known ? known.cuts : "", books: known ? known.books : 0, vowels: vowelShare(word),
        popular: known ? known.popular : 0, nyt: known ? known.nyt : 0, unvetted: known ? known.unvetted : 0, removed: false, own: false,
      };
    });
  }

  /* The edits saved for the list, laid over the rows. */
  function applyEdits() {
    const scores = state.edits.scores || {};
    const removed = new Set(state.edits.removed || []);
    const kept = new Set(state.edits.kept || []);
    for (const row of rows) {
      const own = Object.prototype.hasOwnProperty.call(scores, row.word);
      row.own = own;
      row.score = own ? scores[row.word] : row.base;
      row.removed = removed.has(row.word);
      row.kept = kept.has(row.word);
    }
    // A score set on a word the list didn't have adds it.
    const have = new Set(rows.map((row) => row.word));
    for (const [word, score] of Object.entries(scores)) {
      if (have.has(word) || !/^[A-Z]{2,}$/.test(word)) continue;
      rows.push({ word, len: word.length, base: score, score, uses: 0, everyday: 50, google: 0, year: 0, broda: -1, zipf: 0, cuts: "", books: 0, vowels: vowelShare(word), popular: 0, nyt: 0, unvetted: 0, removed: removed.has(word), own: true, kept: kept.has(word) });
    }
  }

  const chosen = () => state.lists.find((list) => list.id === listId) || null;
  const isBuiltIn = (id) => Object.prototype.hasOwnProperty.call(BUILT_INS, id);
  const editable = () => !isBuiltIn(listId);

  // The list and length last looked at, so the page opens where it was left.
  const LAST = TRAIN ? "fillmein:train:last" : "fillmein:lists:last";
  const rememberWhere = () => {
    try { localStorage.setItem(LAST, JSON.stringify({ listId, setLength })); } catch (error) { /* no storage */ }
  };

  async function loadList() {
    state = await LISTS.state(listId);
    const list = chosen();
    if (!list && !isBuiltIn(listId)) listId = "built-in";
    rememberWhere();
    setStatus("Loading the words…");
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the status paint
    if (isBuiltIn(listId)) rows = builtInRows(listId);
    else if (isBuiltIn(list.basedOn)) rows = builtInRows(list.basedOn);
    else rows = ownRows(list);
    applyEdits();
    renderWhich();
    renderSets();
    refilter();
    setStatus("");
    focusReview();
  }

  // --- the list menu ---

  function renderWhich() {
    const select = $("list");
    select.replaceChildren();
    for (const [id, name] of Object.entries(BUILT_INS)) select.append(new Option(name, id));
    for (const list of state.lists) select.append(new Option(list.name, list.id));
    select.value = listId;
    const list = chosen();
    $("copy").hidden = editable();
    $("which-note").textContent = editable()
      ? `Edits belong to ${list.name}${isBuiltIn(list.basedOn) ? `, which is ${BUILT_INS[list.basedOn]} plus your changes` : ""}. Every puzzle that fills from it uses them.`
      : `${BUILT_INS[listId]} comes with the site and can't be edited. Make a copy, and edit that.`;
  }

  // After a choice in a menu, the arrow keys should be back on the words, not on the menu.
  const focusReview = () => { if (mode === "review") $("review").focus({ preventScroll: true }); };
  $("list").addEventListener("change", async () => {
    listId = $("list").value;
    await loadList();
    focusReview();
  });

  $("copy").addEventListener("click", async () => {
    const count = rows.length;
    const copy = await LISTS.create(`${BUILT_INS[listId]} copy`, [], { basedOn: listId, count });
    listId = copy.id;
    await loadList();
  });

  // --- filters and sort ---

  const num = (id) => {
    const value = $(id).value.trim();
    return value === "" ? null : Number(value);
  };

  function patternTest() {
    const raw = $("pattern").value.toUpperCase().replace(/[^A-Z?*]/g, "");
    if (!raw) return null;
    if (!/[?*]/.test(raw)) return (word) => word.includes(raw);
    const source = "^" + raw.replace(/\?/g, "[A-Z]").replace(/\*/g, "[A-Z]*") + "$";
    const re = new RegExp(source);
    return (word) => re.test(word);
  }

  function refilter() {
    const test = patternTest();
    let lenMin = num("len-min"), lenMax = num("len-max");
    if (setLength) lenMin = lenMax = setLength; // a length button overrides the length boxes
    const scoreMin = num("score-min"), scoreMax = num("score-max");
    const usesMin = num("uses-min"), usesMax = num("uses-max");
    const evMin = num("ev-min"), evMax = num("ev-max");
    const gMin = num("g-min"), gMax = num("g-max");
    const onlyRescored = $("only-rescored").checked;
    const onlyRemoved = $("only-removed").checked;
    const hideRemoved = ($("hide-removed").checked && !onlyRemoved) || mode === "review";
    const hideKept = mode === "review" || $("hide-kept").checked;
    const onlyNyt = $("only-nyt").checked;
    const onlyPopular = $("only-popular").checked;
    shown = rows.filter((row) =>
      (!test || test(row.word)) &&
      (lenMin === null || row.len >= lenMin) && (lenMax === null || row.len <= lenMax) &&
      (scoreMin === null || row.score >= scoreMin) && (scoreMax === null || row.score <= scoreMax) &&
      (usesMin === null || row.uses >= usesMin) && (usesMax === null || row.uses <= usesMax) &&
      (evMin === null || row.everyday >= evMin) && (evMax === null || row.everyday <= evMax) &&
      (gMin === null || row.google >= gMin) && (gMax === null || row.google <= gMax) &&
      (!onlyRescored || row.own) && (!onlyRemoved || row.removed) && (!hideRemoved || !row.removed) && (!hideKept || !row.kept) &&
      (!onlyNyt || row.nyt) && (!onlyPopular || row.popular));
    resort();
  }

  /* A fixed shuffle per list, so a mixed sample keeps its order between visits. */
  /* A shuffle keyed on each word (and the list), so a word's place never depends on what else is
     left: deciding one doesn't reshuffle the rest. */
  function mixedOrder() {
    let base = 2166136261;
    for (const ch of listId) base = Math.imul(base ^ ch.charCodeAt(0), 16777619);
    const rank = new Map();
    for (const row of shown) {
      let h = base;
      for (let i = 0; i < row.word.length; i++) h = Math.imul(h ^ row.word.charCodeAt(i), 16777619);
      h ^= h >>> 15;
      h = Math.imul(h, 0x2c1b3c6d);
      h ^= h >>> 12;
      rank.set(row, (h >>> 0) / 4294967296);
    }
    shown.sort((a, b) => rank.get(a) - rank.get(b) || (a.word < b.word ? -1 : 1));
  }

  function resort() {
    if (sortKey === "mixed") {
      mixedOrder();
      for (const button of document.querySelectorAll(".grid-head [data-sort]")) button.setAttribute("aria-sort", "none");
      $("count").innerHTML = `<b>${shown.length.toLocaleString()}</b> of ${rows.length.toLocaleString()} words shown`;
      $("scroller").scrollTop = 0;
      draw();
      if (mode === "review") resumeReview();
      sweepHint();
      return;
    }
    // Ties on the chosen figure break on the others, in this order and the same direction, so
    // "fewest NYT appearances first" runs on to the lowest score and then the least everyday.
    const keys = [sortKey, ...["uses", "score", "everyday", "google", "books", "broda", "year"].filter((key) => key !== sortKey)];
    const sign = sortDown ? -1 : 1;
    shown.sort((a, b) => {
      for (const key of keys) {
        const x = a[key], y = b[key];
        if (x !== y) return typeof x === "string" ? (x < y ? sign : -sign) : (x - y) * sign;
      }
      return a.word < b.word ? -1 : a.word > b.word ? 1 : 0;
    });
    for (const button of document.querySelectorAll(".grid-head [data-sort]")) {
      button.setAttribute("aria-sort", button.dataset.sort === sortKey ? (sortDown ? "descending" : "ascending") : "none");
    }
    $("count").innerHTML = `<b>${shown.length.toLocaleString()}</b> of ${rows.length.toLocaleString()} words shown`;
    $("scroller").scrollTop = 0;
    draw();
    if (mode === "review") resumeReview();
    sweepHint();
  }

  let filterTimer = 0;
  const refilterSoon = () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(refilter, 150);
  };
  for (const el of document.querySelectorAll(".filters input")) el.addEventListener("input", refilterSoon);
  $("toggle-filters").addEventListener("click", () => {
    const open = document.querySelector(".filters").classList.toggle("open");
    $("toggle-filters").setAttribute("aria-expanded", String(open));
  });
  $("clear-filters").addEventListener("click", () => {
    for (const el of document.querySelectorAll(".filters input")) {
      if (el.type === "checkbox") el.checked = el.id === "hide-removed";
      else el.value = "";
    }
    refilter();
  });
  document.querySelector(".grid-head").addEventListener("click", (event) => {
    const button = event.target.closest("[data-sort]");
    if (!button) return;
    if (sortKey === button.dataset.sort) sortDown = !sortDown;
    else {
      sortKey = button.dataset.sort;
      sortDown = sortKey !== "word" && sortKey !== "len";
    }
    resort();
  });

  // --- one word at a time ---

  function setMode(next) {
    mode = next;
    for (const button of document.querySelectorAll(".modes button")) button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    const review = mode === "review";
    $("review-view").hidden = !review;
    document.querySelector(".bulk").hidden = review;
    document.querySelector(".grid-head").hidden = review;
    $("scroller").hidden = review;
    if (review) {
      const [key, direction] = $("order").value.split("-");
      sortKey = key;
      sortDown = direction === "down";
    } else if (sortKey === "mixed") {
      sortKey = "uses";
      sortDown = false;
    }
    refilter();
  }
  document.querySelector(".modes").addEventListener("click", (event) => {
    const button = event.target.closest("[data-mode]");
    if (button) setMode(button.dataset.mode);
  });
  $("order").addEventListener("change", () => {
    setMode("review");
    focusReview();
  });

  /* The lengths on offer, each with how many words are still to decide in it. */
  function renderSets() {
    const counts = new Map();
    let total = 0;
    for (const row of rows) {
      if (row.removed || row.kept) continue;
      counts.set(row.len, (counts.get(row.len) || 0) + 1);
      total++;
    }
    const sets = $("sets");
    for (const old of sets.querySelectorAll("button")) old.remove();
    const button = (value, label, count) => {
      const el = document.createElement("button");
      el.type = "button";
      el.dataset.len = value;
      el.innerHTML = `${label} <small>${count.toLocaleString()}</small>`;
      el.setAttribute("aria-pressed", String(value === setLength));
      sets.append(el);
    };
    button(0, "All", total);
    for (const len of [...counts.keys()].sort((a, b) => a - b)) button(len, String(len), counts.get(len));
  }
  $("sets").addEventListener("click", (event) => {
    const button = event.target.closest("[data-len]");
    if (!button) return;
    setLength = Number(button.dataset.len);
    for (const other of $("sets").querySelectorAll("button")) other.setAttribute("aria-pressed", String(Number(other.dataset.len) === setLength));
    rememberWhere();
    refilter();
    $("review").focus({ preventScroll: true });
  });

  /* A set holds only the words still to decide, so a review always resumes at its first word. */
  function resumeReview() {
    history = [];
    at = 0;
    renderCard();
  }

  /* After a decision: the counts on the length buttons, and the card. */
  function remember() {
    renderSets();
  }

  function renderCard() {
    scoring = null;
    const box = $("review");
    box.className = "review";
    box.style.transform = "";
    renderModelCount();
    const n = shown.length;
    const removedNow = history.filter((h) => !h.wasRemoved && shown[h.index].removed).length;
    const keptNow = history.length - removedNow;
    const verdicts = history.length ? `<p class="verdicts">This sitting: ${removedNow.toLocaleString()} removed, ${keptNow.toLocaleString()} kept or scored. Backspace undoes the last one.</p>` : "";
    if (!n) {
      box.innerHTML = `<p class="done">${rows.length ? "No words match." : "This list has no words."}</p>`;
      return;
    }
    if (at >= n) {
      box.innerHTML = `<p class="done">Every word in this set has been decided.</p>${verdicts}` +
        `<div class="decide"><button type="button" class="btn quiet" data-decide="undo"><kbd>⌫</kbd>Undo the last one</button></div>`;
      return;
    }
    const row = shown[at];
    const tags = [];
    if (row.own) tags.push('<span class="tag own">rescored</span>');
    if (row.nyt) tags.push('<span class="tag nyt">NYT answer</span>');
    if (row.unvetted) tags.push('<span class="tag">unvetted</span>');
    if (row.popular) tags.push('<span class="tag">popular</span>');
    box.innerHTML = `<p class="progress">${(n - at).toLocaleString()} ${setLength ? `${setLength}-letter words` : "words"} left to decide</p>` +
      `<p class="big${row.removed ? " gone" : ""}">${row.word}</p>` +
      (row.cuts ? `<p class="reading">read as <b>${readingOf(row)}</b></p>` : "") +
      `<div class="facts"><span>Score <b>${row.score}</b></span><span title="Peter Broda's own score, before the site's popularity nudge">Broda <b>${row.broda < 0 ? "–" : row.broda}</b></span>` +
      `<span>NYT <b>${row.uses.toLocaleString()}</b></span>${row.year ? `<span>last <b>${row.year}</b></span>` : ""}<span>Everyday <b>${row.everyday}</b></span>` +
      `<span title="Zipf frequency in everyday English: 3 is one word in a million, 5 one in ten thousand">Zipf <b>${row.zipf ? row.zipf.toFixed(1) : "–"}</b></span>` +
      `<span title="${row.google.toLocaleString()} in Google's web corpus">Google <b>${compact(row.google)}</b></span>` +
      `<span title="${row.books.toLocaleString()} uses in Google Books, 2015-2019">Books <b>${compact(row.books)}</b></span>${tags.join("")}</div>` +
      `<div id="clues-box"></div>` +
      `<div class="decide"><button type="button" class="btn danger" data-decide="remove"><kbd>←</kbd>Remove</button><button type="button" class="btn" data-decide="keep"><kbd>→</kbd>Keep</button>` +
      `<button type="button" class="btn quiet" data-decide="undo"${history.length ? "" : " disabled"}><kbd>⌫</kbd>Undo</button></div>` +
      (verdicts || `<p class="verdicts">${row.removed ? "This word is already removed; Keep puts it back." : ""}</p>`);
    showClues(row);
    if (at + 1 < n) pastFor(shown[at + 1].word); // the next word's file, fetched ahead
  }

  // --- what the word has meant: its past NYT clues, or a dictionary to look it up in ---

  const PAST_VERSION = window.FILLMEIN_PAST_VERSION || "";
  const pastFiles = new Map(); // two letters -> Promise of {answer: [[clue, times used, last year], ...]}

  function pastFor(word) {
    const prefix = word.slice(0, 2);
    if (!pastFiles.has(prefix)) {
      const file = fetch(`pastclues/${prefix}.json?v=${PAST_VERSION}`)
        .then((response) => (response.ok ? response.json() : {}))
        .catch(() => {
          pastFiles.delete(prefix);
          return {};
        });
      pastFiles.set(prefix, file);
    }
    return pastFiles.get(prefix).then((file) => file[word] || []);
  }

  const lookups = (word) => {
    const lower = word.toLowerCase();
    return `<a href="https://www.onelook.com/?w=${encodeURIComponent(lower)}" target="_blank" rel="noopener">OneLook</a> · ` +
      `<a href="https://en.wiktionary.org/wiki/${encodeURIComponent(lower)}" target="_blank" rel="noopener">Wiktionary</a>`;
  };

  async function showClues(row) {
    const box = $("clues-box");
    if (!box) return;
    if (!row.nyt) {
      box.innerHTML = `<p class="clues-note">Never a Times answer. Look it up: ${lookups(row.word)}</p>`;
      return;
    }
    box.innerHTML = `<p class="clues-note">Looking up its clues…</p>`;
    const clues = await pastFor(row.word);
    if (!$("clues-box") || shown[at] !== row) return; // moved on meanwhile
    if (!clues.length) {
      box.innerHTML = `<p class="clues-note">No clues on file. Look it up: ${lookups(row.word)}</p>`;
      return;
    }
    box.innerHTML = `<ul class="clues">${clues.slice(0, 4).map(([text, uses, year]) => `<li><span>${text.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch])}</span><span class="when">${year}${uses > 1 ? ` · ${uses}×` : ""}</span></li>`).join("")}</ul>` +
      `<p class="clues-note">Times clues, most used first · ${lookups(row.word)}</p>`;
  }

  /* Keeping a word means saying what it's worth: the card turns into a scorer for it. */
  let scoring = null; // the row being scored, or null
  function askScore() {
    if (at >= shown.length) return;
    const row = shown[at];
    scoring = row;
    const box = $("review");
    box.className = "review";
    box.style.transform = "";
    box.innerHTML = `<p class="progress">Keeping <b>${row.word}</b> — how good is it?</p>` +
      `<div class="scorer"><p class="big-score" id="score-big">${row.score}</p>` +
      `<input type="range" id="score-range" min="1" max="100" value="${Math.max(1, row.score)}" aria-label="Score">` +
      `<div class="presets">${[20, 35, 50, 60, 70, 80, 90, 100].map((n) => `<button type="button" data-preset="${n}">${n}</button>`).join("")}</div>` +
      `<div class="number-line">or type it <input type="number" id="score-box" min="1" max="100" value="${Math.max(1, row.score)}" aria-label="Score, typed"> then Enter</div>` +
      `<div class="decide"><button type="button" class="btn quiet" data-decide="score-cancel"><kbd>Esc</kbd>Back</button>` +
      `<button type="button" class="btn primary" data-decide="score-done"><kbd>⏎</kbd>Keep</button></div></div>`;
    const show = (n) => {
      $("score-big").textContent = n;
      $("score-range").value = n;
      if (document.activeElement !== $("score-box")) $("score-box").value = n;
    };
    $("score-range").addEventListener("input", () => show(Number($("score-range").value)));
    $("score-box").addEventListener("input", () => { const n = Number($("score-box").value); if (n >= 1 && n <= 100) show(n); });
    if (!matchMedia("(pointer: coarse)").matches) {
      $("score-box").focus();
      $("score-box").select();
    }
  }
  const scoreChosen = () => Math.max(1, Math.min(100, Math.round(Number($("score-box").value) || Number($("score-range").value) || 50)));

  async function decide(keep) {
    if (at >= shown.length) return;
    if (!(await guard())) return;
    if (keep && !scoring) {
      askScore();
      return;
    }
    scoring = null;
    const row = shown[at];
    history.push({ index: at, wasRemoved: row.removed, wasKept: row.kept });
    if (keep) {
      if (row.removed) {
        await LISTS.restoreWord(listId, row.word);
        row.removed = false;
        row.own = false;
        row.score = row.base;
        noteEdit(row.word, "restored");
      }
      await LISTS.keepWord(listId, row.word);
      row.kept = true;
      noteKept(row.word, true);
    } else if (!row.removed) {
      await LISTS.removeWord(listId, row.word);
      row.removed = true;
      row.own = false;
      row.score = row.base;
      noteEdit(row.word, "removed");
    }
    at++;
    remember();
    renderCard();
  }

  async function scoreCurrent(value) {
    if (at >= shown.length || !Number.isFinite(value)) return;
    if (!(await guard())) return;
    const row = shown[at];
    const score = Math.max(0, Math.min(100, Math.round(value)));
    history.push({ index: at, wasRemoved: row.removed, wasOwn: row.own, wasScore: row.score, wasKept: row.kept });
    await LISTS.setScore(listId, row.word, score);
    await LISTS.keepWord(listId, row.word);
    row.score = score;
    row.own = true;
    row.removed = false;
    row.kept = true;
    noteEdit(row.word, score);
    noteKept(row.word, true);
    at++;
    remember();
    renderCard();
  }

  async function undo() {
    const last = history.pop();
    if (!last) return;
    const row = shown[last.index];
    if (last.wasScore !== undefined) {
      // A score set here: back to what it was, the row's own or the list's, removed again if it was.
      if (last.wasRemoved) await LISTS.removeWord(listId, row.word);
      else if (last.wasOwn) await LISTS.setScore(listId, row.word, last.wasScore);
      else await LISTS.restoreWord(listId, row.word);
      row.own = last.wasOwn;
      row.score = last.wasScore;
      row.removed = last.wasRemoved;
      noteEdit(row.word, last.wasRemoved ? "removed" : last.wasOwn ? last.wasScore : "restored");
    } else if (row.removed !== last.wasRemoved) {
      if (last.wasRemoved) await LISTS.removeWord(listId, row.word);
      else await LISTS.restoreWord(listId, row.word);
      row.removed = last.wasRemoved;
      noteEdit(row.word, last.wasRemoved ? "removed" : "restored");
    }
    if (row.kept && !last.wasKept) {
      await LISTS.unkeepWord(listId, row.word);
      row.kept = false;
      noteKept(row.word, false);
    }
    at = last.index;
    remember();
    renderCard();
  }

  $("review").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-decide], button[data-preset]");
    if (!button) return;
    const what = button.dataset.decide;
    if (what === "remove") decide(false);
    else if (what === "keep") decide(true);
    else if (what === "score-done") scoreCurrent(scoreChosen());
    else if (what === "score-cancel") { scoring = null; renderCard(); focusReview(); }
    else if (button.dataset.preset) { scoring = null; scoreCurrent(Number(button.dataset.preset)); }
    else if (what === "undo") undo();
  });
  $("review").addEventListener("keydown", (event) => {
    if (event.target.matches("input") && event.key === "Enter") {
      event.preventDefault();
      if (scoring) { scoring = null; scoreCurrent(scoreChosen()); }
      else scoreCurrent(Number(event.target.value));
    } else if (scoring && event.key === "Escape") {
      event.preventDefault();
      scoring = null;
      renderCard();
      focusReview();
    } else if (scoring && (event.key === "ArrowUp" || event.key === "ArrowDown") && event.target.id === "score-box") {
      event.preventDefault();
      const n = Math.max(1, Math.min(100, Number($("score-box").value) + (event.key === "ArrowUp" ? 5 : -5)));
      $("score-box").value = n;
      $("score-box").dispatchEvent(new Event("input"));
    }
  });

  // A finger: slide the card, and past a hand's width it's decided.
  (() => {
    const box = $("review");
    let startX = 0, startY = 0, dx = 0, active = false;
    box.addEventListener("touchstart", (event) => {
      if (scoring || at >= shown.length || event.touches.length !== 1 || event.target.matches("input, button")) return;
      active = true;
      dx = 0;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      box.classList.add("dragging");
    }, { passive: true });
    box.addEventListener("touchmove", (event) => {
      if (!active) return;
      dx = event.touches[0].clientX - startX;
      const dy = event.touches[0].clientY - startY;
      if (Math.abs(dy) > Math.abs(dx) * 1.5 && Math.abs(dx) < 20) return; // a scroll, not a swipe
      box.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
      box.classList.toggle("leaning-left", dx < -40);
      box.classList.toggle("leaning-right", dx > 40);
    }, { passive: true });
    const end = () => {
      if (!active) return;
      active = false;
      box.classList.remove("dragging", "leaning-left", "leaning-right");
      box.style.transform = "";
      if (dx <= -90) decide(false);
      else if (dx >= 90) decide(true);
    };
    box.addEventListener("touchend", end);
    box.addEventListener("touchcancel", end);
  })();
  document.addEventListener("keydown", (event) => {
    if (mode !== "review" || event.ctrlKey || event.metaKey || event.altKey || scoring) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target && target.matches("select") && (event.key === "ArrowLeft" || event.key === "ArrowRight")) target.blur(); // a menu left focused: the arrows mean the words
    const typing = target && target.matches("input, textarea");
    if (event.key === "ArrowLeft" && !typing) { event.preventDefault(); decide(false); }
    else if (event.key === "ArrowRight" && !typing) { event.preventDefault(); decide(true); }
    else if (event.key === "Backspace" && !typing) { event.preventDefault(); undo(); }
  });

  // --- drawing the rows that are on screen ---

  const rowEls = new Map(); // shown index -> element, for the rows drawn now

  function rowHtml(row) {
    const tags = [];
    if (row.own) tags.push('<span class="tag own">rescored</span>');
    if (row.removed) tags.push('<span class="tag">removed</span>');
    if (row.kept) tags.push('<span class="tag" title="Looked at and confirmed on the review">confirmed</span>');
    if (row.nyt) tags.push(`<span class="tag nyt" title="In ${row.uses} published puzzles">NYT</span>`);
    if (row.unvetted) tags.push('<span class="tag" title="Not in the scored list; its score is an estimate">unvetted</span>');
    if (row.popular) tags.push('<span class="tag" title="Everyday enough to be allowed under the minimum score">popular</span>');
    const can = editable();
    return `<span class="word">${row.word}</span><span class="num">${row.len}</span>` +
      `<input class="score num${row.own ? " own" : ""}" type="number" min="0" max="100" value="${row.score}" aria-label="Score for ${row.word}"${can ? "" : " disabled"}>` +
      `<span class="num uses">${row.uses ? row.uses.toLocaleString() : "–"}</span><span class="num">${row.everyday}</span><span class="num goog" title="${row.google.toLocaleString()}">${compact(row.google)}</span><span class="num goog" title="${row.books.toLocaleString()}">${compact(row.books)}</span><span class="num vow">${row.year || "–"}</span>` +
      `<span class="flags">${tags.join("")}</span>` +
      (can ? `<button type="button" class="act${row.removed ? "" : " drop"}" data-act="${row.removed ? "restore" : "remove"}">${row.removed ? "Put back" : "Remove"}</button>` : "<span></span>");
  }

  function draw() {
    const scroller = $("scroller");
    const rowsEl = $("rows");
    $("spacer").style.height = `${Math.max(1, shown.length) * ROW}px`;
    if (!shown.length) {
      rowsEl.innerHTML = `<div class="empty">${rows.length ? "No words match these filters." : "This list has no words."}</div>`;
      rowEls.clear();
      return;
    }
    const first = Math.max(0, Math.floor(scroller.scrollTop / ROW) - 5);
    const last = Math.min(shown.length, first + Math.ceil(scroller.clientHeight / ROW) + 10);
    rowsEl.style.transform = `translateY(${first * ROW}px)`;
    const html = [];
    for (let i = first; i < last; i++) html.push(`<div class="row${shown[i].removed ? " removed" : ""}" data-i="${i}">${rowHtml(shown[i])}</div>`);
    rowsEl.innerHTML = html.join("");
  }
  $("scroller").addEventListener("scroll", () => requestAnimationFrame(draw));
  window.addEventListener("resize", draw);

  function redrawRow(i) {
    const el = $("rows").querySelector(`.row[data-i="${i}"]`);
    if (!el) return;
    el.className = `row${shown[i].removed ? " removed" : ""}`;
    el.innerHTML = rowHtml(shown[i]);
  }

  // --- editing ---

  const setStatus = (text) => { $("status").textContent = text; };

  async function guard() {
    if (editable()) return true;
    const pick = await window.fillmeinChoose({
      title: `You're on ${BUILT_INS[listId]}`,
      text: "It comes with the site, so it can't be edited. Scores and removals belong to a list of your own.",
      choices: [
        { value: "copy", label: "Make a copy and edit that", note: "Same words to start with.", kind: "primary" },
        { value: "stay", label: "Never mind", note: "Nothing changes." },
      ],
    });
    if (pick === "copy") {
      $("copy").click();
      return false; // the copy is loading; edit again once it's up
    }
    return false;
  }

  $("rows").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const el = button.closest(".row");
    const i = Number(el.dataset.i);
    const row = shown[i];
    if (!(await guard())) return;
    // The saved edits are kept in step here too, so the change notice that follows doesn't redraw
    // the list and drop the row from under the cursor.
    if (button.dataset.act === "remove") {
      await LISTS.removeWord(listId, row.word);
      row.removed = true;
      noteEdit(row.word, "removed");
    } else {
      await LISTS.restoreWord(listId, row.word);
      row.removed = false;
      row.own = false;
      row.score = row.base;
      noteEdit(row.word, "restored");
    }
    redrawRow(i);
    setStatus(button.dataset.act === "remove" ? `Removed ${row.word}.` : `Put ${row.word} back.`);
  });
  $("rows").addEventListener("change", async (event) => {
    const input = event.target;
    if (!input.classList.contains("score")) return;
    const el = input.closest(".row");
    const i = Number(el.dataset.i);
    const row = shown[i];
    const value = Math.max(0, Math.min(100, Math.round(Number(input.value))));
    if (!Number.isFinite(value) || value === row.score) {
      input.value = row.score;
      return;
    }
    if (!(await guard())) {
      input.value = row.score;
      return;
    }
    await LISTS.setScore(listId, row.word, value);
    row.score = value;
    row.own = true;
    row.removed = false;
    noteEdit(row.word, value);
    redrawRow(i);
    setStatus(`${row.word} scored ${value}.`);
  });

  /* What lists.js just saved for one word, mirrored in the edits held here (see the click handler). */
  function noteEdit(word, what) {
    const edits = state.edits;
    edits.removed = (edits.removed || []).filter((other) => other !== word);
    if (what === "removed") edits.removed.push(word);
    if (what === "removed" || what === "restored") delete edits.scores[word];
    else edits.scores[word] = what;
  }

  function noteKept(word, kept) {
    const list = (state.edits.kept || []).filter((other) => other !== word);
    if (kept) list.push(word);
    state.edits.kept = list;
  }

  /* Many words at once, as one saved change: everything shown, or the rows given. */
  async function bulk(kind, which = shown, why = "shown") {
    if (!which.length) return;
    if (!(await guard())) return;
    const n = which.length;
    const value = Math.max(0, Math.min(100, Math.round(Number($("bulk-score").value)) || 0));
    const count = `${n.toLocaleString()} ${n === 1 ? "word" : "words"} ${why}`;
    const what = kind === "remove" ? `Remove ${count}?` : kind === "restore" ? `Put back ${count}?` : kind === "keep" ? `Keep ${count}?` : `Score ${count} ${value}?`;
    const sure = await window.fillmeinConfirm({
      title: what,
      text: kind === "remove" ? "They leave the list you're editing. Undo by showing removed words and putting them back."
        : kind === "restore" ? "Their own scores and removals are dropped, back to what the list said."
        : kind === "keep" ? "They stay as they are, marked confirmed, and don't come up in the review again."
        : "Each gets the score in the box, replacing any it had.",
      confirm: kind === "remove" ? "Remove them" : kind === "restore" ? "Put them back" : kind === "keep" ? "Keep them" : "Score them",
    });
    if (!sure) return;
    const edits = { scores: { ...state.edits.scores }, removed: state.edits.removed.slice(), recent: (state.edits.recent || []).slice(), kept: (state.edits.kept || []).slice() };
    const removed = new Set(edits.removed);
    const kept = new Set(edits.kept);
    for (const row of which) {
      if (kind === "remove") {
        removed.add(row.word);
        delete edits.scores[row.word];
        row.removed = true;
        row.own = false;
        row.score = row.base;
      } else if (kind === "keep") {
        removed.delete(row.word);
        kept.add(row.word);
        row.removed = false;
        row.kept = true;
      } else if (kind === "restore") {
        removed.delete(row.word);
        delete edits.scores[row.word];
        row.removed = false;
        row.own = false;
        row.score = row.base;
      } else {
        removed.delete(row.word);
        edits.scores[row.word] = value;
        row.removed = false;
        row.own = true;
        row.score = value;
      }
    }
    edits.removed = [...removed];
    edits.kept = [...kept];
    await LISTS.setEditsFor(listId, edits);
    state.edits = edits;
    const said = kind === "remove" ? `Removed ${n.toLocaleString()} words.` : kind === "restore" ? `Put ${n.toLocaleString()} words back.` : kind === "keep" ? `Kept ${n.toLocaleString()} words.` : `Scored ${n.toLocaleString()} words ${value}.`;
    setStatus(said);
    $("sweep-hint").textContent = said;
    renderSets();
    refilter();
  }
  $("bulk-keep").addEventListener("click", () => bulk("keep"));
  $("bulk-remove").addEventListener("click", () => bulk("remove"));

  /* Keep or remove every undecided word in the set whose figure clears a threshold. */
  const STAT_NAMES = { uses: "NYT appearances", score: "score", everyday: "everyday figure", google: "Google hits", books: "Google Books uses", broda: "Broda score", year: "last Times year" };
  function sweepRows() {
    const stat = $("sweep-stat").value;
    const atLeast = $("sweep-how").value === "min";
    const value = Number($("sweep-value").value);
    if (!Number.isFinite(value)) return [];
    return shown.filter((row) => (atLeast ? row[stat] >= value : row[stat] <= value));
  }
  function sweepHint() {
    const rows = sweepRows();
    $("sweep-scope").textContent = mode === "review" ? "in this set" : "shown";
    $("sweep-hint").textContent = `${rows.length.toLocaleString()} of the ${shown.length.toLocaleString()} words ${mode === "review" ? "in this set" : "shown"} have ${STAT_NAMES[$("sweep-stat").value]} ${$("sweep-how").value === "min" ? "at least" : "at most"} ${$("sweep-value").value}.`;
  }
  for (const id of ["sweep-what", "sweep-stat", "sweep-how", "sweep-value"]) $(id).addEventListener("input", sweepHint);
  $("sweep-go").addEventListener("click", async () => {
    const rows = sweepRows();
    if (!rows.length) {
      $("sweep-hint").textContent = "No word in this set clears that threshold.";
      return;
    }
    await bulk($("sweep-what").value, rows, `${mode === "review" ? "in this set" : "shown"} with ${STAT_NAMES[$("sweep-stat").value]} ${$("sweep-how").value === "min" ? "at least" : "at most"} ${$("sweep-value").value}`);
    focusReview();
  });
  $("bulk-restore").addEventListener("click", () => bulk("restore"));
  $("bulk-rescore").addEventListener("click", () => bulk("rescore"));

  // --- a model of what's kept and what it's worth ---

  /* The word as numbers for the model: each 0-1-ish, with a flag where a figure is missing. */
  const FEATURES = ["len", "words", "base", "broda", "brodaMissing", "uses", "never", "age", "everyday", "zipf", "google", "googleMissing", "books", "booksMissing",
    "vowels", "scrabble", "rare", "doubles", "endsS", "endsED", "endsING", "endsER", "partial", "popular", "nyt", "unvetted"];
  function featuresOf(row) {
    const w = row.word;
    const parts = readingOf(row).split(" ");
    return [
      row.len / 15, parts.length / 4, row.base / 100, row.broda < 0 ? 0.5 : row.broda / 100, row.broda < 0 ? 1 : 0,
      Math.log10(row.uses + 1) / 3, row.uses ? 0 : 1, row.year ? (2024 - row.year) / 25 : 1, row.everyday / 100, row.zipf / 7,
      Math.log10(row.google + 1) / 10, row.google ? 0 : 1, Math.log10(row.books + 1) / 8, row.books ? 0 : 1,
      row.vowels / 100, [...w].reduce((sum, ch) => sum + (SCRABBLE[ch] || 0), 0) / row.len / 10, (w.match(/[JQXZ]/g) || []).length / 3, (w.match(/([A-Z])\1/g) || []).length / 2,
      Number(/S$/.test(w)), Number(/ED$/.test(w)), Number(/ING$/.test(w)), Number(/ER$/.test(w)), Number(parts[0] === "A" || parts[0] === "AN" || parts[0] === "THE"),
      row.popular, row.nyt, row.unvetted,
    ];
  }

  /* A small network: the features, two hidden layers, and two outputs: the log-odds that the word is
     kept, and its score as a fraction. Trained with Adam on the decisions made so far. */
  function makeNet(inputs, hidden = 24) {
    const rand = () => (Math.random() * 2 - 1) * 0.3;
    const layer = (n, m) => ({ w: Float64Array.from({ length: n * m }, rand), b: new Float64Array(m), n, m });
    return { layers: [layer(inputs, hidden), layer(hidden, hidden), layer(hidden, 2)], mean: null, std: null };
  }
  function forward(net, x, keep = null) {
    let a = x;
    const acts = [a];
    net.layers.forEach((L, k) => {
      const out = new Float64Array(L.m);
      for (let j = 0; j < L.m; j++) {
        let sum = L.b[j];
        for (let i = 0; i < L.n; i++) sum += a[i] * L.w[i * L.m + j];
        out[j] = k < net.layers.length - 1 ? Math.max(0, sum) : sum;
      }
      a = out;
      acts.push(a);
    });
    if (keep) keep.acts = acts;
    return a;
  }
  const sigmoid = (z) => 1 / (1 + Math.exp(-z));

  /* Hand the page back to the browser for a frame now and then, so taps and the progress bar keep up. */
  let lastYield = 0;
  const yieldChannel = new MessageChannel();
  const yieldWaiting = [];
  yieldChannel.port1.onmessage = () => { const resolve = yieldWaiting.shift(); if (resolve) resolve(); };
  const breathe = async () => {
    const now = performance.now();
    if (now - lastYield < 40) return;
    await new Promise((resolve) => { yieldWaiting.push(resolve); yieldChannel.port2.postMessage(0); });
    lastYield = performance.now();
  };

  async function trainNet(net, X, Y, epochs, onEpoch) {
    // Y rows: [kept 0/1, score 0-1 or -1 when unknown]
    const L = net.layers;
    const m = [], v = [];
    for (const layer of L) { m.push({ w: new Float64Array(layer.w.length), b: new Float64Array(layer.b.length) }); v.push({ w: new Float64Array(layer.w.length), b: new Float64Array(layer.b.length) }); }
    let step = 0;
    const lr = 0.003, b1 = 0.9, b2 = 0.999, eps = 1e-8, batch = 32;
    const order = X.map((_, i) => i);
    for (let epoch = 0; epoch < epochs; epoch++) {
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      for (let start = 0; start < order.length; start += batch) {
        const gW = L.map((layer) => new Float64Array(layer.w.length));
        const gB = L.map((layer) => new Float64Array(layer.b.length));
        await breathe();
        const idx = order.slice(start, start + batch);
        for (const i of idx) {
          const keep = {};
          const out = forward(net, X[i], keep);
          const acts = keep.acts;
          // output gradients: binary cross-entropy on keep, squared error on score (only where known)
          const dOut = new Float64Array(2);
          dOut[0] = sigmoid(out[0]) - Y[i][0];
          dOut[1] = Y[i][1] >= 0 ? 2 * (out[1] - Y[i][1]) : 0;
          let delta = dOut;
          for (let k = L.length - 1; k >= 0; k--) {
            const layer = L[k];
            const a = acts[k];
            const next = new Float64Array(layer.n);
            for (let j = 0; j < layer.m; j++) {
              gB[k][j] += delta[j];
              for (let p = 0; p < layer.n; p++) {
                gW[k][p * layer.m + j] += a[p] * delta[j];
                next[p] += layer.w[p * layer.m + j] * delta[j];
              }
            }
            if (k > 0) for (let p = 0; p < layer.n; p++) next[p] = a[p] > 0 ? next[p] : 0; // through the relu
            delta = next;
          }
        }
        step++;
        const scale = 1 / idx.length;
        L.forEach((layer, k) => {
          const upd = (param, g, mm, vv) => {
            for (let q = 0; q < param.length; q++) {
              const grad = g[q] * scale + 1e-4 * param[q];
              mm[q] = b1 * mm[q] + (1 - b1) * grad;
              vv[q] = b2 * vv[q] + (1 - b2) * grad * grad;
              const mh = mm[q] / (1 - Math.pow(b1, step)), vh = vv[q] / (1 - Math.pow(b2, step));
              param[q] -= lr * mh / (Math.sqrt(vh) + eps);
            }
          };
          upd(layer.w, gW[k], m[k].w, v[k].w);
          upd(layer.b, gB[k], m[k].b, v[k].b);
        });
      }
      if (onEpoch) onEpoch(epoch);
    }
  }

  const standardize = (net, X) => X.map((x) => x.map((value, i) => (value - net.mean[i]) / net.std[i]));
  let model = null; // {net, decided, report}

  function decidedRows() {
    return rows.filter((row) => row.removed || row.kept || row.own);
  }
  function renderModelCount() {
    if (!TRAIN) return;
    const decided = decidedRows();
    const removed = decided.filter((row) => row.removed).length;
    const scored = decided.filter((row) => !row.removed && row.own).length;
    $("model-count").innerHTML = `<b>${decided.length.toLocaleString()}</b> words decided: ${removed.toLocaleString()} removed, ${(decided.length - removed).toLocaleString()} kept.` +
      (decided.length < 40 || !removed ? " Decide at least 40, some of each, to train." : "");
    $("train").disabled = decided.length < 40 || decided.some((r) => r.removed) === false;
  }

  async function train() {
    const decided = decidedRows();
    const X0 = decided.map(featuresOf);
    const Y = decided.map((row) => [row.removed ? 0 : 1, row.removed ? -1 : row.own ? row.score / 100 : -1]);
    const net = makeNet(FEATURES.length);
    net.mean = FEATURES.map((_, i) => X0.reduce((sum, x) => sum + x[i], 0) / X0.length);
    net.std = FEATURES.map((_, i) => Math.sqrt(X0.reduce((sum, x) => sum + (x[i] - net.mean[i]) ** 2, 0) / X0.length) || 1);
    const X = standardize(net, X0);
    // A fifth held out to say how good it is, then everything for the model that's used.
    const order = X.map((_, i) => i).sort(() => Math.random() - 0.5);
    const held = new Set(order.slice(0, Math.floor(order.length / 5)));
    const trainIdx = order.filter((i) => !held.has(i));
    const epochs = Math.max(20, Math.min(120, Math.round(6000 / Math.max(1, trainIdx.length))));
    $("train").disabled = true;
    $("train").textContent = "Training…";
    $("model-result").hidden = true;
    $("train-progress").hidden = false;
    // The work in three parts: a test run, the real run, then the model's verdict on every word left.
    const progress = (share, what) => {
      $("train-bar").style.width = `${Math.round(100 * share)}%`;
      $("train-note").textContent = what;
    };
    const tick = (_bar, epoch, total) => progress(((epoch + 1) / total) * 0.7, epoch + 1 <= total / 2 ? "Training…" : "Training…");
    progress(0, "Training…");
    const trial = makeNet(FEATURES.length);
    trial.mean = net.mean; trial.std = net.std;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await trainNet(trial, trainIdx.map((i) => X[i]), trainIdx.map((i) => Y[i]), epochs, (e) => tick(null, e, epochs * 2));
    let right = 0, baseRight = 0, n = 0, scoreErr = 0, scoreN = 0;
    let trainRight = 0, trainScoreErr = 0, trainScoreN = 0;
    for (const i of trainIdx) {
      const out = forward(trial, X[i]);
      if ((sigmoid(out[0]) >= 0.5 ? 1 : 0) === Y[i][0]) trainRight++;
      if (Y[i][1] >= 0) { trainScoreErr += Math.abs(out[1] * 100 - Y[i][1] * 100); trainScoreN++; }
    }
    const trainAcc = trainIdx.length ? Math.round((100 * trainRight) / trainIdx.length) : 0;
    const keptShare = trainIdx.filter((i) => Y[i][0] === 1).length / trainIdx.length;
    for (const i of held) {
      const out = forward(trial, X[i]);
      n++;
      if ((sigmoid(out[0]) >= 0.5 ? 1 : 0) === Y[i][0]) right++;
      if ((keptShare >= 0.5 ? 1 : 0) === Y[i][0]) baseRight++;
      if (Y[i][1] >= 0) { scoreErr += Math.abs(out[1] * 100 - Y[i][1] * 100); scoreN++; }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await trainNet(net, X, Y, epochs, (e) => tick(null, e + epochs, epochs * 2));
    model = { net, decided: decided.length };
    const acc = n ? Math.round((100 * right) / n) : 0, base = n ? Math.round((100 * baseRight) / n) : 0;
    // Confidence: how often it got right the decisions it wasn't trained on.
    // Confidence runs from a coin toss (50% right on the held-back words: 0) to 95% right or better
    // (100), in three stages.
    const confidence = Math.max(0, Math.min(100, Math.round(((acc - 50) / 45) * 100)));
    const stage = confidence >= 85 ? "green" : confidence >= 60 ? "yellow" : "red";
    $("meter-value").textContent = confidence;
    $("meter-fill").style.width = `${Math.max(2, confidence)}%`;
    $("meter").dataset.stage = stage;
    $("meter-note").textContent = stage === "green" ? "Ready to finish the list." : stage === "yellow" ? "Getting there. Keep swiping, then train again." : "Keep swiping, then train again.";
    $("meter-split").textContent = `${trainIdx.length.toLocaleString()} words were used for training and ${n.toLocaleString()} for testing.`;
    $("acc-train-value").textContent = `${trainAcc}%`;
    $("acc-train").style.width = `${trainAcc}%`;
    $("acc-test-value").textContent = `${acc}%`;
    $("acc-test").style.width = `${acc}%`;
    // Score accuracy: 100 less the points its scores are off by, on average, for words kept with a score.
    const scoreAcc = (err, count) => (count ? Math.max(0, Math.round(100 - err / count)) : null);
    for (const [key, value] of [["acc-score-train", scoreAcc(trainScoreErr, trainScoreN)], ["acc-score-test", scoreAcc(scoreErr, scoreN)]]) {
      $(`${key}-value`).textContent = value === null ? "–" : `${value}%`;
      $(key).style.width = `${value || 0}%`;
    }
    await predictAll((share) => progress(0.7 + 0.3 * share, "Training…"));
    $("train-progress").hidden = true;
    $("model-result").hidden = false;
    $("model-made").textContent = "";
    $("train").disabled = false;
    $("train").textContent = "Train again";
    previewModel();
    $("model-result").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  $("train").addEventListener("click", train);

  /* The model's verdict on every word not yet decided, made once after training, a slice at a time:
     how likely it is to be kept, and its score. */
  async function predictAll(onProgress) {
    const undecided = rows.filter((row) => !(row.removed || row.kept || row.own));
    const pKeep = new Float32Array(undecided.length);
    const score = new Uint8Array(undecided.length);
    const net = model.net;
    const [A, B, C] = net.layers;
    const x = new Float64Array(A.n), h1 = new Float64Array(A.m), h2 = new Float64Array(B.m), out = new Float64Array(C.m);
    const dense = (layer, input, output, relu) => {
      for (let j = 0; j < layer.m; j++) {
        let sum = layer.b[j];
        for (let i = 0; i < layer.n; i++) sum += input[i] * layer.w[i * layer.m + j];
        output[j] = relu && sum < 0 ? 0 : sum;
      }
    };
    for (let i = 0; i < undecided.length; i++) {
      if ((i & 4095) === 0) {
        await breathe();
        onProgress(i / undecided.length);
      }
      const f = featuresOf(undecided[i]);
      for (let k = 0; k < f.length; k++) x[k] = (f[k] - net.mean[k]) / net.std[k];
      dense(A, x, h1, true);
      dense(B, h1, h2, true);
      dense(C, h2, out, false);
      pKeep[i] = sigmoid(out[0]);
      score[i] = Math.max(1, Math.min(100, Math.round(out[1] * 100)));
    }
    model.undecided = undecided;
    model.pKeep = pKeep;
    model.score = score;
  }

  /* What the model would do with the words not yet decided, at the certainty chosen: just a count
     over the verdicts already made, so the box can be changed freely. */
  function modelVerdicts() {
    const sure = 0.5; // its best guess: remove what it thinks more likely removed than kept
    const out = [];
    const { undecided, pKeep, score } = model;
    for (let i = 0; i < undecided.length; i++) {
      if (undecided[i].removed || undecided[i].kept || undecided[i].own) continue; // decided since training
      out.push({ row: undecided[i], keep: 1 - pKeep[i] < sure, score: score[i] });
    }
    return out;
  }
  function previewModel() {
    if (!model) return;
    const verdicts = modelVerdicts();
    const dropped = verdicts.filter((v) => !v.keep).length;
    const decidedKept = rows.filter((row) => !row.removed && (row.kept || row.own)).length;
    $("model-preview").innerHTML = `New list: <b>${(decidedKept + verdicts.length - dropped).toLocaleString()}</b> words.`;
  }

  $("model-make").addEventListener("click", async () => {
    if (!model) return;
    const name = ($("model-name").value.trim() || "Model list").slice(0, 60);
    $("model-made").textContent = "Making it…";
    await new Promise((resolve) => setTimeout(resolve, 20));
    const words = [];
    for (const row of rows) if (!row.removed && (row.kept || row.own)) words.push([row.word, row.score]);
    for (const v of modelVerdicts()) if (v.keep) words.push([v.row.word, v.score]);
    $("model-make").disabled = true;
    const list = await LISTS.create(name, words);
    $("model-make").disabled = false;
    $("model-made").innerHTML = `Made <b>${name.replace(/[&<>]/g, "")}</b> (${words.length.toLocaleString()} words).`;
    state = await LISTS.state(listId);
    renderWhich();
  });

  // --- the data, for anything that wants to learn from it ---

  const SCRABBLE = { A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8, K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1, U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10 };
  const CSV_HEAD = ["word", "reading", "length", "words", "score", "own_score", "base_score", "broda_score", "nyt_uses", "nyt_last_year", "everyday", "zipf", "google", "books_2015_2019",
    "vowel_pct", "scrabble", "rare_letters", "double_letters", "ends_s", "ends_ed", "ends_ing", "ends_er", "starts_a_the", "popular", "nyt_answer", "unvetted",
    "confirmed", "removed", "label"];

  /* One row of the spreadsheet: the word's figures, then what was decided about it. label is 1 for a
     word kept or scored, 0 for one removed, blank for one not looked at yet. */
  function csvRow(row) {
    const w = row.word;
    const reading = readingOf(row);
    const parts = reading.split(" ");
    const first = parts[0];
    return [
      w, reading, row.len, parts.length, row.score, row.own ? row.score : "", row.base, row.broda < 0 ? "" : row.broda, row.uses, row.year || "", row.everyday, row.zipf.toFixed(1), row.google, row.books,
      row.vowels, [...w].reduce((sum, ch) => sum + (SCRABBLE[ch] || 0), 0), (w.match(/[JQXZ]/g) || []).length, (w.match(/([A-Z])\1/g) || []).length,
      Number(/S$/.test(w)), Number(/ED$/.test(w)), Number(/ING$/.test(w)), Number(/ER$/.test(w)), Number(first === "A" || first === "AN" || first === "THE"),
      row.popular, row.nyt, row.unvetted,
      Number(row.kept), Number(row.removed), row.removed ? 0 : row.kept || row.own ? 1 : "",
    ].join(",");
  }

  $("download").addEventListener("click", () => {
    setStatus("Making the spreadsheet…");
    setTimeout(() => {
      const lines = [CSV_HEAD.join(",")];
      for (const row of rows) lines.push(csvRow(row));
      const blob = new Blob([lines.join("\n")], { type: "text/csv" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      const list = chosen();
      link.download = `${(list ? list.name : BUILT_INS[listId]).replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}-words.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 60000);
      setStatus(`${rows.length.toLocaleString()} words written to ${link.download}.`);
    }, 30);
  });

  // Lists arriving from the account, or edits made on another page: pick them up.
  let busy = false;
  LISTS.onChange(async () => {
    if (busy || localWrites) return;
    busy = true;
    try {
      const fresh = await LISTS.state(listId);
      // Only the scores and removals matter here; the recent-words list changes with every edit.
      const gist = (edits) => JSON.stringify([Object.entries(edits.scores || {}).sort(), [...(edits.removed || [])].sort(), [...(edits.kept || [])].sort()]);
      const before = gist(state.edits);
      state = fresh;
      renderWhich();
      if (gist(state.edits) !== before) {
        applyEdits();
        refilter();
      }
    } finally {
      busy = false;
    }
  });

  try {
    const last = JSON.parse(localStorage.getItem(LAST) || "null");
    if (last && typeof last.listId === "string") listId = last.listId;
    if (last && Number.isInteger(last.setLength)) setLength = last.setLength;
  } catch (error) { /* start fresh */ }
  // The Train page samples the whole list at random; the editor has no use for that order.
  if (TRAIN) {
    $("order").value = "mixed";
    setLength = 0;
  } else {
    const mixed = $("order").querySelector('option[value="mixed"]');
    if (mixed) mixed.remove();
  }
  setMode("review");
  loadList();
})();
