/* The Teach page: you write the rules, correct Claude on a hundred words, and it rewrites the rules
   to match what you actually decided. Repeat with a hundred more whenever you like.

   Nothing here is automatic. Claude's guesses are a starting point for your corrections, and the
   rules it writes come back into editable boxes, not into the word list. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const C = window.FillmeinClaude;
  const STATE = "fillmein:teach";
  const JUDGE_RUBRIC = "fillmein:ai:rubric"; // what judge.js reads on the Train page
  /* True while the look of this page is being settled: nothing is sent to Claude, no key is needed,
     and the answers are stand-ins worked out from the figures the site already holds. */
  const MODELS_OFF = false;

  const PER_ROUND = 100;
  const SAMPLE = 10;
  /* The model that rewrites the rules. Judging words is a hundred cheap calls a round and the cheap
     model does it well; the rules are one call that everything afterwards rests on, so it gets the
     best model whatever is chosen for the words. */
  const RULES_MODEL = "claude-opus-5-5";

  const BATCH = 10; // words per request
  const WIDTH = 3;  // requests at once

  const get = (name, fallback = "") => {
    try {
      return localStorage.getItem(name) ?? fallback;
    } catch (error) {
      return fallback;
    }
  };
  const set = (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch (error) {
      /* this session only */
    }
  };
  const safe = (text) => String(text == null ? "" : text).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]);

  // --- the rules you start from ---

  const EXAMPLE = {
    intro: `You judge entries for a crossword word list. For each word, decide whether it earns a place in a
published American crossword, and if so what its score is.`,
    rules: `Keep a word when a solver would recognise it on sight and not resent it: ordinary vocabulary, real
phrases people actually say, well-known names, titles and brands.

Cut a word when it is:
- a phrase that is grammatical but nobody says ("green paint": BUSYPLACE, REDHOUSE)
- a made-up inflection or comparative (RANDOMEST, REEMAIL, UNSOGGY)
- scientific taxonomy, an obscure genus or species (GORGONACEA)
- an obscure person, place or brand only a specialist would know
- a fragment or partial phrase that is not a thing on its own (ATO, INAN)
- outdated crosswordese that hasn't been used in the last 5 years in NYT crosswords
- crude, offensive or grim enough to fail the breakfast test

What the scores mean:
- 10: perfect, an exciting and highly relevant word that has not been used much in crosswords
- 9: fantastic, a lively and evocative word that has not shown up frequently in crosswords
- 8: excellent, an entry a constructor would build a grid around
- 7: very good, lively and current
- 6: good, solid fill anyone is pleased to see
- 5: fine, unremarkable, no complaints
- 4: dull but legitimate; it fills a hole without hurting
- 3: weak; allowed only when a corner demands it
- 2: slightly cringe-worthy, borderline allowable by the NYT
- 1: very poor, almost never used but could include one of these if the rest is excellent
- 0: cut, not allowed in the list`,
    closing: `Judge the word itself, not how useful its letters are. The statistics are evidence, not the verdict: a
word with no crossword history can still be excellent, and plenty of published answers are poor.
Answer with a verdict, a score (1-10 when keeping, 0 when cutting) and a reason of at most twelve words.`,
  };

  const rulesText = (rules) => [rules.intro, rules.rules, rules.closing].filter(Boolean).join("\n\n");

  /* Rules written before October 2026 talk in hundredths, because the site scored words out of a
     hundred then. They are yours, so they are not rewritten behind your back: the page notices and
     offers to move the numbers across. A ladder line like "- 90:" becomes "- 9:", and a text that
     does not look like the old scale is left alone, so running it twice changes nothing. */
  const OLD_LADDER = /(^|\n)\s*-\s*(100|90|80|70|60|50|40|30|20)\s*:/;
  const looksOldScale = (rules) => {
    const text = rulesText(rules);
    return OLD_LADDER.test(text) || /\b[01]\s*-\s*100\b|\b[01] to 100\b/.test(text);
  };
  const ontoTen = (text) => {
    const ladder = OLD_LADDER.test(text)
      ? text.replace(/(^|\n)(\s*-\s*)(\d{2,3})(\s*:)/g, (all, start, dash, number, colon) =>
          (Number(number) >= 10 && Number(number) % 10 === 0 ? `${start}${dash}${Number(number) / 10}${colon}` : all))
      : text;
    return ladder
      .replace(/\b([01])\s*-\s*100\b/g, "$1-10")
      .replace(/\b([01]) to 100\b/g, "$1 to 10")
      // A range of two old-scale scores written out in prose: "they now sit at 65 to 80" means 7 to 8.
      // Only pairs between 11 and 100, so years (2000 to 2020) and counts of words are left alone.
      .replace(/\b(\d{2,3})(\s*(?:to|-|\u2013)\s*)(\d{2,3})\b/g, (all, low, between, high) => {
        const from = Number(low);
        const to = Number(high);
        if (from < 11 || from > 100 || to < 11 || to > 100) return all;
        return `${Math.round(from / 10)}${between}${Math.round(to / 10)}`;
      });
  };

  // --- state ---

  let state = { rules: { ...EXAMPLE }, used: [], rounds: [], learned: [], sample: [], record: [], round: null };
  try {
    const saved = JSON.parse(get(STATE, "null"));
    if (saved && saved.rules) state = { ...state, ...saved };
  } catch (error) {
    /* start afresh */
  }
  const save = () => set(STATE, JSON.stringify(state));

  /* The hundred in progress, kept small enough to write after every answer: a word, what the rules
     said about it, and what you said. Leaving the page and coming back carries on where you were. */
  function saveRound() {
    state.round = round && round.items.length
      ? { at: round.at, items: round.items.map((item) => ({ w: item.row.word, g: item.guess, y: item.you, c: item.changed })) }
      : null;
    save();
  }

  /* The other way about, once the words are in hand again. */
  function restoreRound() {
    if (!state.round || !state.round.items || !state.round.items.length) return null;
    const byWord = new Map(buildPool().map((row) => [row.word, row]));
    const items = [];
    for (const saved of state.round.items) {
      const row = byWord.get(saved.w);
      if (!row) continue; // the word list changed under it
      items.push({ row, guess: saved.g || null, you: saved.y || null, changed: Boolean(saved.c) });
    }
    if (!items.length) return null;
    return { at: Math.min(state.round.at || 0, items.length), items };
  }
  let round = null; // the words being corrected now

  // --- the words ---

  const WIKT = ["listed", "noun", "verb", "adjective", "adverb", "proper", "phrase", "abbreviation", "dated", "informal", "offensive", "rare", "inflection"];
  const FIELDS = ["uses", "everyday", "google", "year", "broda", "zipf", "cuts", "books", "lat", "wsj", "usa", "tny", "up", "nw", "other", "outlets", "clues", "wiki", "subtlex", "opensubs", "wikt"];
  let pool = null; // every 3-10 letter word, with the figures the rules might lean on

  function buildPool() {
    if (pool) return pool;
    const words = window.GRIDFILL_WORDS || {};
    const stats = window.GRIDFILL_STATS || {};
    pool = [];
    for (let len = 3; len <= 10; len++) {
      const entry = words[len];
      if (!entry || !stats[len]) continue;
      const letters = entry[0];
      const scores = entry[1].split(",");
      const columns = {};
      FIELDS.forEach((name, i) => (columns[name] = (stats[len][i] || "").split(",")));
      for (let i = 0; i < scores.length; i++) {
        const row = { word: letters.substr(i * len, len), len, score: Number(scores[i]) };
        for (const name of FIELDS) {
          const value = columns[name][i];
          row[name] = name === "cuts" ? value || "" : Number(value || 0);
        }
        row.broda = columns.broda[i] === "" ? -1 : Number(columns.broda[i]);
        row.papers = row.lat + row.wsj + row.usa + row.tny + row.up + row.nw + row.other;
        pool.push(row);
      }
    }
    return pool;
  }

  const flag = (row, name) => (row.wikt >> WIKT.indexOf(name)) & 1;

  /* Ten kinds of word, ten of each: the point is breadth, so the rules are tested on the easy cases
     and the nasty ones alike. */
  const KINDS = [
    ["familiar and often published", (r) => r.everyday >= 60 && r.uses >= 3],
    ["strong scores", (r) => r.score >= 7],
    ["the lively band", (r) => r.score === 6],
    ["single words nobody has published", (r) => r.score === 5 && !r.cuts && !r.uses && !r.papers],
    ["phrases nobody has published", (r) => r.score === 5 && r.cuts && !r.uses && !r.papers],
    ["unknown to Wiktionary and Google", (r) => r.score >= 5 && !r.wikt && !r.google],
    ["low scores, everyday words", (r) => r.score === 4 && r.everyday >= 50],
    ["proper nouns", (r) => r.score >= 5 && flag(r, "proper") && r.everyday < 40],
    ["abbreviations, dated and rare", (r) => r.score >= 5 && (flag(r, "abbreviation") || flag(r, "dated") || flag(r, "rare"))],
    ["inflections", (r) => r.score === 5 && /(?:S|ED|ING)$/.test(r.word) && !r.uses],
  ];

  function pick(count) {
    const all = buildPool();
    const used = new Set(state.used);
    const chosen = [];
    const per = Math.max(1, Math.round(count / KINDS.length));
    for (const [, test] of KINDS) {
      // Long words outnumber short ones several times over, so take them length by length: a hundred
      // words that are all nine letters would teach the rules about nine-letter words.
      const byLength = new Map();
      for (const row of all) {
        if (used.has(row.word) || !test(row)) continue;
        if (!byLength.has(row.len)) byLength.set(row.len, []);
        byLength.get(row.len).push(row);
      }
      const lengths = [...byLength.keys()].sort(() => Math.random() - 0.5);
      for (let k = 0; k < per && lengths.length; k++) {
        const members = byLength.get(lengths[k % lengths.length]);
        const row = members[Math.floor(Math.random() * members.length)];
        if (used.has(row.word)) continue;
        used.add(row.word);
        chosen.push(row);
      }
    }
    while (chosen.length < count) { // any shortfall filled at random
      const row = all[Math.floor(Math.random() * all.length)];
      if (used.has(row.word)) continue;
      used.add(row.word);
      chosen.push(row);
    }
    return chosen.sort(() => Math.random() - 0.5).slice(0, count);
  }

  /* What Claude is told about a word: the same figures the Train page's card shows. */
  function facts(row) {
    const tags = WIKT.filter((name, i) => (row.wikt >> i) & 1);
    return [
      `${row.word} (${row.len} letters)`,
      row.cuts ? `reads as a phrase, split ${row.cuts}` : "one word",
      `list score ${row.score} out of 10${row.broda >= 0 ? `, hand-scored ${row.broda}` : ", never hand-scored"}`,
      `NYT uses ${row.uses}${row.year ? ` (last ${row.year})` : ""}, other outlets ${row.papers}`,
      `everyday familiarity ${row.everyday}/100, Zipf ${row.zipf ? (row.zipf / 10).toFixed(1) : "none"}`,
      `Google ${row.google}, Books ${row.books}, Wikipedia ${row.wiki ? "yes" : "no"}`,
      tags.length ? tags.join("/") : "not in Wiktionary",
    ].join("; ");
  }

  const GUESS_SCHEMA = {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            word: { type: "string" },
            verdict: { type: "string", enum: ["keep", "cut"] },
            score: { type: "integer", description: "1-10 when keeping, 0 when cutting" },
            why: { type: "string", description: "at most 12 words" },
          },
          required: ["word", "verdict", "score", "why"],
          additionalProperties: false,
        },
      },
    },
    required: ["verdicts"],
    additionalProperties: false,
  };

  /* What a stand-in says about a word while the models are off: the list's own score, rounded to a
     band and nudged down for a word no crossword has printed, with a reason that never pretends. */
  function standIn(row) {
    const band = Math.max(0, Math.min(10, row.score));
    const score = row.uses || row.papers ? band : Math.max(0, band - 1);
    return {
      word: row.word,
      verdict: score <= 1 ? "cut" : "keep",
      score: score <= 1 ? 0 : score,
      why: "stand-in answer, the model is off",
    };
  }

  /* What judging one word has actually cost and taken, averaged over everything judged so far. The
     estimate for the whole list leans on this rather than on a guess. */
  function noteRate(words, cost, seconds, bulk) {
    if (!words || MODELS_OFF) return;
    // Kept apart two ways. A teaching round sends ten words a request with someone waiting on each
    // answer and a run sends forty with four in flight, so one can't be read as the other; and each
    // model has its own price and pace, so Haiku's figures say nothing about Opus's.
    const key = bulk ? "bulkRate" : "rate";
    const model = C.model();
    if (!state[key] || state[key].words !== undefined) state[key] = {}; // the old shape, before models were kept apart
    const had = state[key][model] || { words: 0, cost: 0, seconds: 0 };
    state[key][model] = { words: had.words + words, cost: had.cost + cost, seconds: had.seconds + seconds };
    save();
  }

  /* Claude's first pass over a set of words, in batches. */
  async function guessAll(rows, onProgress) {
    if (MODELS_OFF) {
      const byWord = new Map();
      const batches = Math.ceil(rows.length / BATCH);
      for (let i = 0; i < batches; i++) {
        for (const row of rows.slice(i * BATCH, (i + 1) * BATCH)) byWord.set(row.word, standIn(row));
        await new Promise((resolve) => setTimeout(resolve, 50)); // so the line underneath has something to say
        if (onProgress) onProgress(i + 1, batches);
      }
      return { byWord, error: null };
    }
    const system = rulesText(state.rules);
    const batches = [];
    for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));
    const spentBefore = C.spent();
    const began = Date.now();
    const results = await C.pool(batches.map((batch) => async () => {
      const answer = await C.call({
        system,
        messages: [{ role: "user", content: `Judge each of these words.\n\n${batch.map(facts).join("\n")}` }],
        schema: GUESS_SCHEMA,
        maxTokens: 4000,
      });
      return answer.verdicts || [];
    }), WIDTH, onProgress);
    const byWord = new Map();
    for (const result of results) {
      if (!result || result.error) continue;
      // Rules written for the old hundred draw answers in hundreds: a 40 means a 4 here. The page
      // keeps one scale whatever the rules say, so the card and the Agree button never show a 40.
      for (const verdict of result) byWord.set(String(verdict.word).toUpperCase(), { ...verdict, score: onTen(verdict.score) });
    }
    // What this round actually cost and took, so the estimate for the rest of the list is measured
    // rather than guessed.
    noteRate(byWord.size, C.spent() - spentBefore, (Date.now() - began) / 1000, false);
    const failed = results.filter((result) => result && result.error);
    return { byWord, error: failed.length ? failed[0].error : null };
  }

  // --- the whole list ---------------------------------------------------------------------------

  const WHOLE_BATCH = 40;  // words per request when there is no one waiting on each answer
  const WHOLE_WIDTH = 4;   // requests at once
  const SAVE_EVERY = 10;   // batches between writes, so a stop costs you four hundred words at most
  const DB = "fillmein-filter";

  /* Somewhere to put half a million verdicts: localStorage is far too small, so they go in
     IndexedDB, written in batches as the run goes along. */
  function store(mode, work) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("verdicts")) db.createObjectStore("verdicts");
        if (!db.objectStoreNames.contains("run")) db.createObjectStore("run");
      };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const deal = db.transaction(["verdicts", "run"], mode);
        const out = work(deal.objectStore("verdicts"), deal.objectStore("run"));
        deal.oncomplete = () => {
          db.close();
          resolve(out && out.result !== undefined ? out.result : out);
        };
        deal.onerror = () => reject(deal.error);
      };
    });
  }
  const countDone = () => store("readonly", (verdicts) => verdicts.count());

  /* Every word in the list, shortest first, so a run that is stopped early has still covered the
     lengths that fill the most grids. */
  function allWords() {
    const words = window.GRIDFILL_WORDS || {};
    const out = [];
    for (const length of Object.keys(words).map(Number).sort((a, b) => a - b)) {
      const letters = words[length][0];
      for (let i = 0; i < letters.length; i += length) out.push(letters.substr(i, length));
    }
    return out;
  }

  let whole = null;    // the run in progress
  let wholeStop = false;
  let wholeWords = null;

  const hours = (seconds) => {
    if (seconds < 90) return `${Math.round(seconds)} seconds`;
    if (seconds < 5400) return `${Math.round(seconds / 60)} minutes`;
    const whole_hours = seconds / 3600;
    return `${whole_hours < 10 ? whole_hours.toFixed(1) : Math.round(whole_hours)} hours`;
  };

  /* What the rest of the list would cost and take, from what the teaching rounds actually cost and
     took, scaled for the bigger batches a run uses. Without a measurement, the model's own rates
     and a word's worth of tokens stand in. */
  /* A word's worth of tokens at a model's prices: what one costs before anything is measured, and
     the yardstick for carrying a measurement from one model to another. */
  const nominal = (model) => (90 * C.MODELS[model].in + 30 * C.MODELS[model].out) / 1e6;
  const bucket = (key, model) => (state[key] && state[key].words === undefined ? state[key][model] : null);

  function estimate(left) {
    const model = C.model();
    const bulk = bucket("bulkRate", model);
    if (bulk && bulk.words >= 200) {
      // Measured on a run on this model over the list itself, which is the thing being estimated.
      return { cost: (bulk.cost / bulk.words) * left, seconds: left / (bulk.words / bulk.seconds), measured: "run" };
    }
    const rate = bucket("rate", model);
    if (rate && rate.words >= 20) {
      // From the teaching rounds on this model, where each request carries fewer words and waits on
      // an answer: bigger batches spread the rules over more words and run four at a time.
      const perWord = (rate.cost / rate.words) * 0.8;
      const perSecond = (rate.words / rate.seconds) * (WHOLE_BATCH / BATCH) * (WHOLE_WIDTH / WIDTH);
      return { cost: perWord * left, seconds: left / perSecond, measured: "rounds" };
    }
    // Nothing measured on this model, but perhaps on another: its tokens per word carry across, so
    // the cost does at the new model's prices. How fast it answers does not, so that is a guess.
    for (const key of ["bulkRate", "rate"]) {
      const other = state[key] && state[key].words === undefined
        ? Object.entries(state[key]).find(([name, had]) => name !== model && had.words >= (key === "bulkRate" ? 200 : 20))
        : null;
      if (!other) continue;
      const [name, had] = other;
      const scale = nominal(model) / nominal(name);
      const perWord = (had.cost / had.words) * scale * (key === "rate" ? 0.8 : 1);
      return { cost: perWord * left, seconds: left / 12, measured: "other", from: name };
    }
    return { cost: nominal(model) * left, seconds: left / 12, measured: null };
  }

  async function drawWhole() {
    if (!$("whole-note")) return;
    const total = (wholeWords || (wholeWords = allWords())).length;
    const done = await countDone().catch(() => 0);
    const left = Math.max(0, total - done);
    const guess = estimate(left);
    $("whole-note").innerHTML = done
      ? `${done.toLocaleString()} of ${total.toLocaleString()} judged. The rest would cost about <b>${C.money(guess.cost)}</b> ` +
        `and take about <b>${hours(guess.seconds)}</b> on ${C.MODELS[C.model()].name.split(" - ")[0]}.`
      : `${total.toLocaleString()} words. Judging all of them with your rules would cost about <b>${C.money(guess.cost)}</b> ` +
        `and take about <b>${hours(guess.seconds)}</b> on ${C.MODELS[C.model()].name.split(" - ")[0]}` +
        `${guess.measured === "run" ? ", going by the run so far"
          : guess.measured === "rounds" ? ", going by what your rounds have cost"
          : guess.measured === "other" ? `, going by its prices against what ${C.MODELS[guess.from].name.split(" - ")[0]} used` : ""}. ` +
        `It saves as it goes, so you can stop and carry on later.`;
    $("whole-start").textContent = done ? "Carry on judging the list" : "Judge the whole list";
    $("whole-save").hidden = !done;
    $("whole-forget").hidden = !done;
  }

  async function runWhole() {
    wholeStop = false;
    $("whole-start").hidden = true;
    $("whole-stop").hidden = false;
    $("whole-progress").hidden = false;
    const total = (wholeWords || (wholeWords = allWords())).length;
    let done = await countDone();
    // Which words are already judged: read once, so the run doesn't ask the database per word.
    const judged = await store("readonly", (verdicts) => verdicts.getAllKeys());
    const seen = new Set(judged || []);
    const left = wholeWords.filter((word) => !seen.has(word));
    const byWord = new Map((wholeWords || []).map((word) => [word, null]));
    const pool = buildPool();
    const rows = new Map(pool.map((row) => [row.word, row]));
    const started = Date.now();
    let since = 0;
    let waiting = [];

    const keep = async () => {
      const batch = waiting;
      waiting = [];
      if (!batch.length) return;
      await store("readwrite", (verdicts, run) => {
        for (const [word, verdict] of batch) verdicts.put(verdict, word);
        run.put({ at: Date.now(), done: done }, "state");
      });
    };

    for (let i = 0; i < left.length && !wholeStop; i += WHOLE_BATCH * WHOLE_WIDTH) {
      const lot = [];
      for (let k = 0; k < WHOLE_WIDTH; k++) {
        const slice = left.slice(i + k * WHOLE_BATCH, i + (k + 1) * WHOLE_BATCH);
        if (slice.length) lot.push(slice);
      }
      const before = C.spent();
      const at = Date.now();
      const answers = await Promise.all(lot.map(async (slice) => {
        const described = slice.map((word) => (rows.get(word) ? facts(rows.get(word)) : `${word} (${word.length} letters)`));
        try {
          const answer = await C.call({
            system: rulesText(state.rules),
            messages: [{ role: "user", content: `Judge each of these words.\n\n${described.join("\n")}` }],
            schema: GUESS_SCHEMA,
            maxTokens: 8000,
          });
          return answer.verdicts || [];
        } catch (error) {
          return { error };
        }
      }));
      let got = 0;
      for (const answer of answers) {
        if (!answer || answer.error) continue;
        for (const verdict of answer) {
          const word = String(verdict.word).toUpperCase();
          if (!byWord.has(word) || seen.has(word)) continue;
          seen.add(word);
          waiting.push([word, { s: onTen(verdict.score), v: verdict.verdict === "cut" ? 0 : 1, w: String(verdict.why || "").slice(0, 60) }]);
          got++;
        }
      }
      done += got;
      noteRate(got, C.spent() - before, (Date.now() - at) / 1000, true);
      since++;
      if (since >= SAVE_EVERY) {
        await keep();
        since = 0;
      }
      const share = Math.round((100 * done) / total);
      $("whole-bar").style.width = `${share}%`;
      const perSecond = done > 0 ? done / ((Date.now() - started) / 1000) : 0;
      $("whole-status").textContent = `${done.toLocaleString()} of ${total.toLocaleString()} judged` +
        (perSecond ? `, about ${hours((total - done) / perSecond)} to go` : "") +
        `. ${C.money(C.spent())} spent so far.`;
      const failed = answers.filter((answer) => answer && answer.error);
      if (failed.length === answers.length) {
        $("whole-status").textContent = `Stopped: ${failed[0].error.message}. What is judged is saved.`;
        break;
      }
    }
    await keep();
    $("whole-start").hidden = false;
    $("whole-stop").hidden = true;
    await drawWhole();
  }

  /* Everything judged so far, as a word list file: WORD;score, which the Word lists page takes. */
  async function downloadWhole() {
    $("whole-status").textContent = "Gathering what's judged…";
    const [keys, values] = await store("readonly", (verdicts) => {
      const k = verdicts.getAllKeys();
      const v = verdicts.getAll();
      return { get result() { return [k.result, v.result]; } };
    });
    const lines = [];
    for (let i = 0; i < keys.length; i++) if (values[i] && values[i].v) lines.push(`${keys[i]};${values[i].s}`);
    const cut = keys.length - lines.length;
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "fillmein-judged.txt";
    link.click();
    URL.revokeObjectURL(link.href);
    $("whole-status").textContent = `${lines.length.toLocaleString()} words kept, ${cut.toLocaleString()} cut. ` +
      "Upload the file on the Word lists page to fill from it.";
  }

  if ($("whole-start")) {
    $("whole-start").addEventListener("click", () => runWhole());
    $("whole-stop").addEventListener("click", () => {
      wholeStop = true;
      $("whole-status").textContent = "Stopping after this lot…";
    });
    $("whole-save").addEventListener("click", () => downloadWhole());
    $("whole-forget").addEventListener("click", async () => {
      const ok = await window.fillmeinConfirm({
        title: "Start the list again?",
        text: "Every verdict from the run so far goes, and the next run begins at the first word.",
        confirm: "Start again",
      });
      if (!ok) return;
      await store("readwrite", (verdicts, run) => {
        verdicts.clear();
        run.delete("state");
      });
      await drawWhole();
    });
  }

  // --- drawing ---

  const show = (name) => {
    for (const step of ["gate", "rules", "teach", "training", "result"]) $(`step-${step}`).hidden = step !== name;
    // The run over the rest of the list stands beside the rules and the result, since it is a thing
    // you may want at any point, not only after a round. It stays out of the way while judging.
    const beside = name === "rules" || name === "result";
    $("step-whole").hidden = !beside;
    if (beside) drawWhole();
    $("setup").hidden = name === "gate" || MODELS_OFF;
    $("preview-note").hidden = name === "gate";
    if (MODELS_OFF) {
      $("preview-note").textContent = "The models are off while this page's look is being settled. Everything works, but the " +
        "answers are stand-ins worked out from the word list's own figures, and nothing is sent to Claude.";
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /* The paid gate, with payment switched off: it opens on a click and stays open. When there is
     something to charge for, this is where it goes, and the key field below it goes away with it. */
  const UNLOCKED = "fillmein:teach:unlocked";
  $("unlock").addEventListener("click", () => {
    set(UNLOCKED, "1");
    show("rules");
  });

  function drawRules() {
    $("intro").value = state.rules.intro;
    $("rules").value = state.rules.rules;
    $("closing").value = state.rules.closing;
    noticeScale();
  }

  /* There is one scale. Rules written for the old hundred are moved onto it as they are read, and
     the boxes show what was actually moved rather than announcing it twice. */
  function noticeScale() {
    if (!looksOldScale(state.rules)) return;
    state.rules = { intro: ontoTen(state.rules.intro), rules: ontoTen(state.rules.rules), closing: ontoTen(state.rules.closing) };
    save();
    $("intro").value = state.rules.intro;
    $("rules").value = state.rules.rules;
    $("closing").value = state.rules.closing;
    $("rules-note").textContent = "Your rules scored words out of a hundred; the numbers are on the 1 to 10 scale now.";
  }

  function readRules() {
    state.rules = { intro: $("intro").value, rules: $("rules").value, closing: $("closing").value };
    save();
  }

  /* A word's own files: its first Wiktionary definition, and the clues the Times has given it. Both
     are fetched two letters at a time and kept, so a hundred words cost a handful of requests. */
  const files = new Map();
  function fileFor(kind, word, version) {
    const key = `${kind}/${word.slice(0, 2)}`;
    if (!files.has(key)) {
      files.set(key, fetch(`${kind}/${word.slice(0, 2)}.json?v=${version || ""}`)
        .then((response) => (response.ok ? response.json() : {}))
        .catch(() => {
          files.delete(key);
          return {};
        }));
    }
    return files.get(key);
  }
  const definitionOf = (word) => fileFor("defs", word, window.FILLMEIN_DEFS_VERSION).then((file) => file[word] || "");
  const cluesFor = (word) => fileFor("pastclues", word, window.FILLMEIN_PAST_VERSION).then((file) => file[word] || []);

  /* Any score onto the site's ten: a hundred-scale answer is divided, anything else is rounded and
     held inside the scale. */
  const onTen = (score) => {
    const n = Number(score) || 0;
    return n > 10 ? Math.max(1, Math.min(10, Math.round(n / 10))) : Math.max(0, Math.min(10, Math.round(n)));
  };

  const BANDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; // cut on the left, the best on the right

  /* The word in front of you: what it is, what the rules made of it, and the bands to put it in.
     0 means cut, so one click settles a word either way. */
  function drawCard() {
    const total = round.items.length;
    const at = round.at;
    const decided = round.items.filter((item) => item.you).length;
    const changed = round.items.filter((item) => item.changed).length;
    $("guess-bar").style.width = `${Math.round((100 * decided) / total)}%`;
    $("guess-note").textContent = at < total
      ? `Word ${at + 1} of ${total}${changed ? `, ${changed} corrected so far` : ""}`
      : `All ${total} decided, ${changed} of them corrected.`;
    $("teach-note").textContent = at < total ? "Enter or → moves on. ← goes back." : "";
    $("train").hidden = at < total;

    if (at >= total) {
      $("card").innerHTML = `<p class="done-note">That's the hundred. Train on them and Claude rewrites your rules to match.</p>` +
        `<div class="doing"><button type="button" class="btn quiet" data-go="back">← Look at the last one again</button></div>`;
      return;
    }
    const { row, guess, you } = round.items[at];
    const chosen = you ? (you.verdict === "cut" ? 0 : you.score) : null;
    // Agreeing is not changing: a word you simply waved through still offers Agree, unfaded.
    const touched = Boolean(you && guess && (you.verdict !== guess.verdict ||
      (you.verdict === "keep" && you.score !== guess.score) || you.note));
    $("card").innerHTML =
      `<p class="word">${safe(row.word)}</p>` +
      (row.cuts ? `<p class="reading">reads as a phrase</p>` : "") +
      `<div class="about" id="card-about"><p class="definition waiting">Looking it up…</p>` +
      `<p class="seen">${row.year ? `Last in a New York Times puzzle in ${row.year}` : "Never used in a New York Times puzzle"}</p></div>` +
      `<p class="says${guess ? "" : " pending"}">${guess
        ? `Claude says <b>${guess.verdict === "cut" ? "cut" : `keep at ${guess.score}`}</b> <span class="why">${safe(guess.why)}</span>`
        : "Claude is still looking at this one…"}</p>` +
      `<div class="bands" role="group" aria-label="Your score for ${safe(row.word)}">${BANDS.map((band) => {
        const isGuess = guess && (guess.verdict === "cut" ? band === 0 : band === guess.score);
        const picked = chosen === band;
        return `<button type="button" data-band="${band}" class="${band === 0 ? "cut " : ""}${isGuess ? "guessed" : ""}"` +
          `${picked ? ' aria-pressed="true"' : ""}>${band === 0 ? "cut" : band}</button>`;
      }).join("")}</div>` +
      `<p class="chose">${!guess ? "" : touched
        ? `Yours: <b>${you.verdict === "cut" ? "cut" : you.score}</b>. Next keeps it.`
        : `Next agrees with the answer above: <b>${guess.verdict === "cut" ? "cut" : guess.score}</b>.`}</p>` +
      `<input class="note" id="card-note" type="text" placeholder="why, if it matters" value="${safe(you && you.note)}" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Why, for ${safe(row.word)}">` +
      `<div class="doing">` +
      `<button type="button" class="btn quiet" data-go="back"${at ? "" : " disabled"}>← Back</button>` +
      `<button type="button" class="btn agree${touched ? " faded" : ""}" data-go="agree"${guess ? "" : " disabled"}` +
      `${touched ? ' title="Takes the answer above after all, in place of yours"' : ""}>` +
      `Agree${guess ? ` — ${guess.verdict === "cut" ? "cut" : guess.score}` : ""}</button>` +
      `<button type="button" class="btn primary" data-go="next"${guess ? "" : " disabled"}>Next →</button>` +
      `</div>`;
    describe(row);
    const next = round.items[at + 1];
    if (next) { // the next word's files, fetched while you look at this one
      definitionOf(next.row.word);
      cluesFor(next.row.word);
    }
  }

  /* The definition and the clues the word has had, dropped in when they arrive. The dictionary knows
     a word in its plainest reading, which is not always the one anyone means: MINECRAFT is a warship
     to Wiktionary. So a word that means something else as a name shows both, and the clues, which
     settle it better than any definition, run two deep. */
  const CLUES_SHOWN = 2;
  const MOST_KEPT = 2000;        // judgements kept in this browser
  const MOST_CORRECTIONS = 400;  // corrections sent to the agent, newest first
  const MOST_AGREEMENTS = 150;   // and words it got right, as the other side of the picture

  /* What the agent is given each round: not just the hundred just judged but everything judged so
     far, written out once. Corrections lead, since a rule is wrong wherever one was needed; the
     words left standing follow, so the rules are not rewritten against evidence that isn't there. */
  function document_of(record) {
    const line = (entry) => `${entry.word} [${entry.facts}]\n  rules said: ${entry.said}` +
      `\n  they said: ${entry.yours}${entry.note ? ` - ${entry.note}` : ""}${entry.round ? `  (round ${entry.round})` : ""}`;
    const corrections = record.filter((entry) => entry.changed).slice(-MOST_CORRECTIONS);
    const agreements = record.filter((entry) => !entry.changed).slice(-MOST_AGREEMENTS);
    const parts = [];
    parts.push(`CORRECTIONS (${corrections.length} of ${record.filter((e) => e.changed).length}), where your rules were wrong:`);
    parts.push(corrections.length ? corrections.map(line).join("\n") : "(none yet)");
    parts.push(`\nLEFT STANDING (${agreements.length} of ${record.filter((e) => !e.changed).length}), where your rules were right:`);
    parts.push(agreements.length ? agreements.map(line).join("\n") : "(none yet)");
    return parts.join("\n");
  }
  async function describe(row) {
    const [definition, clues] = await Promise.all([definitionOf(row.word), cluesFor(row.word)]);
    const box = $("card-about");
    if (!box || !round.items[round.at] || round.items[round.at].row.word !== row.word) return; // moved on
    const [plain, asName] = Array.isArray(definition) ? definition : [definition, ""];
    box.innerHTML =
      `<p class="definition">${plain ? safe(plain) : asName ? safe(asName) : "No dictionary definition for it."}</p>` +
      (asName && plain ? `<p class="definition">As a name: ${safe(asName)}</p>` : "") +
      clues.slice(0, CLUES_SHOWN).map((clue) =>
        `<p class="clue">Clued as “${safe(clue[0])}”${clue[2] ? ` (${clue[2]})` : ""}</p>`).join("") +
      `<p class="seen">${row.year ? `Last in a New York Times puzzle in ${row.year}` : "Never used in a New York Times puzzle"}` +
      `${row.wiki ? ", and Wikipedia has an article by that name" : ""}</p>`;
  }

  const noteNow = () => ($("card-note") ? $("card-note").value.trim() : "");
  const mark = (item) => {
    item.changed = item.you.verdict !== item.guess.verdict ||
      (item.you.verdict === "keep" && item.you.score !== item.guess.score) || Boolean(item.you.note);
  };

  /* Picking a band records what you think and stays on the word. A score of 0 is a cut. */
  function choose(score) {
    const item = round.items[round.at];
    if (!item || !item.guess) return;
    item.you = { verdict: score === 0 ? "cut" : "keep", score, note: noteNow() };
    mark(item);
    saveRound();
    drawCard();
  }

  /* Next moves on, taking what you picked, or the answer on the card if you picked nothing. */
  function advance() {
    const item = round.items[round.at];
    if (!item || !item.guess) return;
    if (!item.you) item.you = { verdict: item.guess.verdict, score: item.guess.verdict === "cut" ? 0 : item.guess.score, note: "" };
    item.you.note = noteNow();
    mark(item);
    round.at++;
    saveRound();
    drawCard();
  }

  // --- step 1: the rules ---

  drawRules();

  /* Resetting throws away everything written here, including whatever Claude learned, so it asks. */
  $("reset-rules").addEventListener("click", async () => {
    const rounds = state.rounds.length;
    const ok = await window.fillmeinConfirm({
      title: "Reset to the baseline prompt?",
      text: "Every change to these three boxes goes, and the prompt returns to the one the page starts with." +
        (rounds ? ` That includes what Claude wrote from your ${rounds === 1 ? "round" : `${rounds} rounds`} of corrections.` : "") +
        " The words you have already judged are still remembered, so another hundred will be fresh ones.",
      confirm: "Reset the prompt",
    });
    if (!ok) return;
    state.rules = { ...EXAMPLE };
    drawRules();
    save();
    $("rules-note").textContent = "Back to the baseline prompt.";
  });

  $("start").addEventListener("click", async () => {
    readRules();
    if (!MODELS_OFF && !C.key()) {
      $("rules-note").textContent = "Add your API key at the top first.";
      return;
    }
    $("start").disabled = true;
    $("rules-note").textContent = "Choosing a hundred words…";
    const rows = pick(PER_ROUND);
    round = { at: 0, items: rows.map((row) => ({ row, guess: null, you: null, changed: false })) };
    show("teach");
    drawCard();
    $("guess-note").textContent = MODELS_OFF ? "Working them out…" : "Claude is judging them…";
    const { byWord, error } = await guessAll(rows, (done, total) => {
      $("guess-note").textContent = `${Math.min(done * BATCH, rows.length)} of ${rows.length} judged…`;
      if (done === 1) drawCard(); // the first batch is in, so the first card can be answered
    });
    for (const item of round.items) {
      const guess = byWord.get(item.row.word);
      if (guess) item.guess = { verdict: guess.verdict, score: Number(guess.score) || 0, why: guess.why };
    }
    for (const item of round.items) if (!item.guess) item.guess = { verdict: "keep", score: 5, why: "(no answer)" };
    if (error) $("teach-note").textContent = `Some came back empty: ${safe(error.message)}`;
    $("start").disabled = false;
    drawCard();
  });

  $("card").addEventListener("click", (event) => {
    const band = event.target.closest("button[data-band]");
    if (band) {
      choose(Number(band.dataset.band));
      return;
    }
    const go = event.target.closest("button[data-go]");
    if (!go) return;
    if (go.dataset.go === "agree") {
      const item = round.items[round.at];
      if (!item || !item.guess) return;
      item.you = null; // back to the answer on the card, whatever was picked
      advance();
    } else if (go.dataset.go === "next") advance();
    else if (round.at > 0) {
      const item = round.items[round.at];
      if (item && item.you) item.you.note = noteNow(); // keep what was typed before stepping away
      round.at--;
      saveRound();
      drawCard();
    }
  });

  document.addEventListener("keydown", (event) => {
    if ($("step-teach").hidden || event.ctrlKey || event.metaKey || event.altKey) return;
    const typing = event.target instanceof Element && event.target.matches("input, textarea, select");
    if ((event.key === "Enter" || (event.key === "ArrowRight" && !typing)) && round && round.at < round.items.length) {
      if (!round.items[round.at].guess) return;
      event.preventDefault();
      advance();
    } else if (event.key === "ArrowLeft" && !typing && round && round.at > 0) {
      event.preventDefault();
      round.at--;
      saveRound();
      drawCard();
    }
  });

  $("back-to-rules").addEventListener("click", () => show("rules"));

  // --- step 3: training ---

  const TRAIN_SCHEMA = {
    type: "object",
    properties: {
      rules: { type: "string", description: "the rewritten rules, and nothing else" },
      learned: { type: "array", items: { type: "string" }, description: "what changed and why, one short line each" },
    },
    required: ["rules", "learned"],
    additionalProperties: false,
  };

  const TRAINER = `You are rewriting the standing orders a crossword constructor gives to whoever judges
words for their word list. What you write is read cold by that judge, before every word, and by
nobody else. It is a brief, not a reply: write it to the judge, in the second person, exactly as the
rules you are given are written. Never address the constructor in it, never describe your own
changes in it, and never begin with what their corrections showed.

You are given their current rules and every word they have judged, over one round or many: their
decision is the truth, and the guess beside it was made by the rules as they stood at the time.
Where the two differ, the rules were wrong, not the person. A correction from an early round counts
as much as one from the latest, so a rule that explained the old ones survives unless newer evidence
contradicts it.

You rewrite one part of the brief and only that part: the rules. The opening and the closing are the
constructor's own. They are shown to you so that what you write sits properly between them, and they
are not yours to touch: nothing you return can change them.

The rules read as they are given to you: a short paragraph on what to keep; then "Cut a word when it
is:" and a dash-led list of the kinds to cut, each with an example or two drawn from their
corrections; then "What the scores mean:" and one dash-led line for each score from 10 down to 0.
Keep the section under about 500 words, and keep the constructor's own wording wherever their
decisions bear it out.

Words are scored 1 to 10, where 10 is the best and 0 means cut. Every score you write is on that
scale: "7 to 8", never "70 to 80". There is no hundred-point scale any more.

Write rules, not a lookup table: no lists of the words you were given.

"learned" is the only part the constructor reads: a few short lines there, addressed to them, saying
what you changed and why.`;

  $("train").addEventListener("click", async () => {
    if (!round) return;
    show("training");
    $("training-note").textContent = `${C.MODELS[RULES_MODEL].name.split(" - ")[0]} is reading every correction at once and ` +
      "rewriting your rules so they would have produced your decisions. Your opening and closing are left as you wrote them.";
    $("train-bar").style.width = "30%";
    noticeScale(); // whatever has been typed into the boxes meanwhile is on the ten before it is sent
    const round_number = state.rounds.length + 1;
    for (const item of round.items) {
      const you = item.you || item.guess;
      state.record.push({
        round: round_number,
        word: item.row.word,
        facts: facts(item.row),
        said: `${item.guess.verdict}${item.guess.verdict === "keep" ? ` ${item.guess.score}` : ""}`,
        yours: `${you.verdict}${you.verdict === "keep" ? ` ${you.score}` : ""}`,
        note: you.note || "",
        changed: Boolean(item.changed),
      });
    }
    if (state.record.length > MOST_KEPT) state.record = state.record.slice(-MOST_KEPT);
    save();
    const decided = document_of(state.record);
    const agreed = round.items.filter((item) => !item.changed).length;
    try {
      const answer = MODELS_OFF ? {
        ...state.rules,
        learned: [`The models are off, so your rules are unchanged. ${agreed} of ${round.items.length} stand-in answers matched you.`,
          "Turn MODELS_OFF off in teach.js to have Claude rewrite the rules from these corrections."],
      } : await C.call({
        system: TRAINER,
        messages: [{
          role: "user",
          content: `The opening and closing of their brief, which you do not rewrite:\n\n` +
            `<opening>\n${state.rules.intro}\n</opening>\n\n<closing>\n${state.rules.closing}\n</closing>\n\n` +
            `The rules you are rewriting:\n\n<rules>\n${state.rules.rules}\n</rules>\n\n` +
            `Every word they have judged, over ${round_number} round${round_number === 1 ? "" : "s"}. ` +
            `The corrections come first, since those are where the rules were wrong; the words they let ` +
            `stand follow, as the rules got those right. Account for all of it, not only the newest.\n\n${decided}`,
        }],
        schema: TRAIN_SCHEMA,
        model: RULES_MODEL,
        maxTokens: 32000,
        effort: "high", // the one call worth thinking about
        cache: false,   // these instructions are sent once a round, so caching buys nothing
      });
      $("train-bar").style.width = "70%";
      // The opening and closing are yours and are left exactly as they are: only the rules are
      // rewritten. If what comes back talks to you rather than to the judge -- "your corrections
      // show...", "I rewrote them around..." -- it is a reply, not a brief, so yours stand.
      const reply = /\b(?:i|we)\s+(?:rewrote|changed|updated|tightened|loosened|reorganis|reorganiz)|your corrections|you corrected|you asked/i;
      const refused = Boolean(answer.rules) && reply.test(answer.rules);
      state.rules = {
        intro: state.rules.intro,
        rules: ontoTen(refused || !answer.rules ? state.rules.rules : answer.rules),
        closing: state.rules.closing,
      };
      state.learned = (answer.learned || []).map(ontoTen);
      if (refused) {
        state.learned.push("The rules came back written to you rather than to the judge, so your own stand.");
      }
      state.used = [...new Set([...state.used, ...round.items.map((item) => item.row.word)])];
      state.rounds.push({ at: Date.now(), agreed, of: round.items.length });
      round = null;
      state.round = null; // trained on, so no longer a round in progress
      save();
      drawRules();
      // A free sample, judged by the rules it just wrote.
      const rows = pick(SAMPLE);
      const { byWord } = await guessAll(rows, () => {});
      state.sample = rows.map((row) => ({ row, guess: byWord.get(row.word) || null }));
      state.used = [...new Set([...state.used, ...rows.map((row) => row.word)])];
      save();
      $("train-bar").style.width = "100%";
      drawResult();
      show("result");
    } catch (error) {
      // The hundred words are still in hand, so nothing is lost: offer the two ways on.
      $("training-note").innerHTML = `That didn't work: ${safe(error.message)}. Your hundred words are still here. ` +
        '<button type="button" class="btn" id="train-retry">Try again</button> ' +
        '<button type="button" class="btn quiet" id="train-back">Back to the words</button>';
      const again = $("train-retry");
      const back = $("train-back");
      if (again) again.addEventListener("click", () => $("train").click());
      if (back) back.addEventListener("click", () => {
        round.at = Math.max(0, round.items.length - 1);
        show("teach");
        drawCard();
      });
    }
  });

  function drawResult() {
    const rounds = state.rounds;
    const last = rounds[rounds.length - 1];
    const before = rounds.length > 1 ? rounds[rounds.length - 2] : null;
    $("agreement").innerHTML = `Before this round, your rules already agreed with you on <b>${last.agreed}</b> of ${last.of} words.` +
      (before ? ` Last round it was ${before.agreed} of ${before.of}.` : "") +
      ` ${rounds.length} round${rounds.length === 1 ? "" : "s"} so far, ${state.used.length} words seen.`;
    $("learned").innerHTML = state.learned.length
      ? `<b>What Claude changed</b><ul>${state.learned.map((line) => `<li>${safe(line)}</li>`).join("")}</ul>`
      : "<b>No changes</b>";
    drawWhole();
    $("sample").innerHTML = state.sample.map(({ row, guess }) => `<div class="one">
      <span class="w">${safe(row.word)}</span>
      <span>${guess ? (guess.verdict === "cut" ? "cut" : `keep at ${guess.score}`) : "—"}</span>
      <span class="muted">${safe(guess ? guess.why : "")}</span></div>`).join("");
  }

  $("more").addEventListener("click", () => {
    show("rules");
    $("rules-note").textContent = "These are the rules Claude wrote. Edit them if you like, then take another hundred.";
  });
  $("see-rules").addEventListener("click", () => show("rules"));
  $("use-rules").addEventListener("click", () => {
    set(JUDGE_RUBRIC, rulesText(state.rules));
    $("result-note").textContent = "Saved. The Train page's panel will use these.";
  });

  // --- the key, the model, the bill ---

  $("key").value = C.key();
  $("key").addEventListener("change", () => C.setKey($("key").value));
  $("model").innerHTML = Object.entries(C.MODELS).map(([id, m]) => `<option value="${id}">${m.name}</option>`).join("");
  $("model").value = C.model();
  $("model").addEventListener("change", () => {
    C.setModel($("model").value);
    drawWhole(); // the price and the time are this model's, so they are worked out again
  });
  const showSpent = () => ($("spent").textContent = C.spent() ? `${C.money(C.spent())} spent so far` : "");
  C.onSpend(showSpent);
  showSpent();
  if (state.rounds.length) {
    drawResult();
    $("rules-note").textContent = `${state.rounds.length} round${state.rounds.length === 1 ? "" : "s"} done. Edit the rules, or take another hundred words.`;
  }

  /* A hundred left half-judged is waiting where you left it, so say so and offer to carry on. */
  if (state.round && state.round.items && state.round.items.length) {
    const left = state.round.items.length - Math.min(state.round.at || 0, state.round.items.length);
    $("rules-note").innerHTML = `You left a hundred part-judged, ${left} still to go. ` +
      '<button type="button" class="btn" id="carry-on">Carry on</button> ' +
      '<button type="button" class="btn quiet" id="start-over">Start a fresh hundred</button>';
    const carry = $("carry-on");
    const fresh = $("start-over");
    if (carry) carry.addEventListener("click", () => {
      round = restoreRound();
      if (!round) {
        $("rules-note").textContent = "Those words have gone from the list. Take a fresh hundred.";
        return;
      }
      show("teach");
      drawCard();
    });
    if (fresh) fresh.addEventListener("click", () => {
      state.round = null;
      save();
      $("rules-note").textContent = "Set aside. Show me a hundred when you're ready.";
    });
  }
  show(get(UNLOCKED) || state.rounds.length ? "rules" : "gate");
})();
