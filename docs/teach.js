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

  // --- state ---

  let state = { rules: { ...EXAMPLE }, used: [], rounds: [], learned: [], sample: [] };
  try {
    const saved = JSON.parse(get(STATE, "null"));
    if (saved && saved.rules) state = { ...state, ...saved };
  } catch (error) {
    /* start afresh */
  }
  const save = () => set(STATE, JSON.stringify({ ...state, round: undefined }));
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
    const results = await C.pool(batches.map((batch) => async () => {
      const answer = await C.call({
        system,
        messages: [{ role: "user", content: `Judge each of these words.\n\n${batch.map(facts).join("\n")}` }],
        schema: GUESS_SCHEMA,
        maxTokens: 2000,
      });
      return answer.verdicts || [];
    }), WIDTH, onProgress);
    const byWord = new Map();
    for (const result of results) {
      if (!result || result.error) continue;
      for (const verdict of result) byWord.set(String(verdict.word).toUpperCase(), verdict);
    }
    const failed = results.filter((result) => result && result.error);
    return { byWord, error: failed.length ? failed[0].error : null };
  }

  // --- drawing ---

  const show = (name) => {
    for (const step of ["gate", "rules", "teach", "training", "result"]) $(`step-${step}`).hidden = step !== name;
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
      `<input class="note" id="card-note" type="text" placeholder="why, if it matters" value="${safe(you && you.note)}" aria-label="Why, for ${safe(row.word)}">` +
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
      drawCard();
    }
  });

  $("back-to-rules").addEventListener("click", () => show("rules"));

  // --- step 3: training ---

  const TRAIN_SCHEMA = {
    type: "object",
    properties: {
      intro: { type: "string" },
      rules: { type: "string" },
      closing: { type: "string" },
      learned: { type: "array", items: { type: "string" }, description: "what changed and why, one short line each" },
    },
    required: ["intro", "rules", "closing", "learned"],
    additionalProperties: false,
  };

  const TRAINER = `You are improving the rules a crossword constructor uses to judge words for their word list.

You are given their current rules, and a hundred words where their decision is the truth and the
earlier guess was made by those rules. Where the two differ, the rules were wrong, not the person.

Rewrite the rules so that, read cold, they would produce the person's decisions on these words and
generalise to words like them. Work out what the corrections have in common and say that as a rule.
Be specific: name the kinds of word, and give an example or two from their corrections. Keep the
rules tight and readable - no more than about 500 words in the rules section - and drop anything the
evidence contradicts. Keep the person's own wording and emphasis where their decisions agree with
it. Do not list the hundred words; write rules, not a lookup table.

Also return "learned": a few short lines saying what you changed and why, addressed to the person.`;

  $("train").addEventListener("click", async () => {
    if (!round) return;
    show("training");
    $("train-bar").style.width = "30%";
    const decided = round.items.map((item) => {
      const you = item.you || item.guess;
      return `${item.row.word} [${facts(item.row)}]\n  rules said: ${item.guess.verdict}${item.guess.verdict === "keep" ? ` ${item.guess.score}` : ""} (${item.guess.why})` +
        `\n  they said: ${you.verdict}${you.verdict === "keep" ? ` ${you.score}` : ""}${you.note ? ` - ${you.note}` : ""}`;
    }).join("\n");
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
          content: `Their current rules:\n\n<rules>\n${rulesText(state.rules)}\n</rules>\n\n` +
            `The hundred words, with what the rules said and what they said:\n\n${decided}`,
        }],
        schema: TRAIN_SCHEMA,
        maxTokens: 8000,
        effort: "high", // the one call worth thinking about
        cache: false,   // these instructions are sent once a round, so caching buys nothing
      });
      $("train-bar").style.width = "70%";
      state.rules = { intro: answer.intro, rules: answer.rules, closing: answer.closing };
      state.learned = answer.learned || [];
      state.used = [...new Set([...state.used, ...round.items.map((item) => item.row.word)])];
      state.rounds.push({ at: Date.now(), agreed, of: round.items.length });
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
      $("training-note").textContent = `That didn't work: ${error.message}`;
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
  $("model").addEventListener("change", () => C.setModel($("model").value));
  const showSpent = () => ($("spent").textContent = C.spent() ? `${C.money(C.spent())} spent so far` : "");
  C.onSpend(showSpent);
  showSpent();
  if (state.rounds.length) {
    drawResult();
    $("rules-note").textContent = `${state.rounds.length} round${state.rounds.length === 1 ? "" : "s"} done. Edit the rules, or take another hundred words.`;
  }
  show(get(UNLOCKED) || state.rounds.length ? "rules" : "gate");
})();
