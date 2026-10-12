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
published American crossword, and if so what it is worth.`,
    rules: `Keep a word when a solver would recognise it on sight and not resent it: ordinary vocabulary, real
phrases people actually say, well-known names, titles and brands.

Cut a word when it is:
- a phrase that is grammatical but nobody says ("green paint": BUSYPLACE, REDHOUSE)
- a made-up inflection or comparative (RANDOMEST, REEMAIL, UNSOGGY)
- scientific taxonomy, an obscure genus or species (GORGONACEA)
- an obscure person, place or brand only a specialist would know
- a fragment or partial phrase that is not a thing on its own (ATO, INAN)
- crosswordese, kept alive only by other crosswords
- crude, offensive or grim enough to fail the breakfast test

What the scores mean:
- 90: sparkling, an entry a constructor would build a grid around
- 80: very good, lively and current
- 70: good, solid fill anyone is pleased to see
- 60: fine, unremarkable, no complaints
- 50: dull but legitimate; it fills a hole without hurting
- 40: weak; allowed only when a corner demands it`,
    closing: `Judge the word itself, not how useful its letters are. The statistics are evidence, not the verdict: a
word with no crossword history can still be excellent, and plenty of published answers are poor.
Answer with a verdict, a score (40-90 when keeping, 0 when cutting) and a reason of at most twelve words.`,
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
    ["strong scores", (r) => r.score >= 70],
    ["the lively band", (r) => r.score >= 60 && r.score < 70],
    ["single words nobody has published", (r) => r.score >= 50 && r.score < 60 && !r.cuts && !r.uses && !r.papers],
    ["phrases nobody has published", (r) => r.score >= 50 && r.score < 60 && r.cuts && !r.uses && !r.papers],
    ["unknown to Wiktionary and Google", (r) => r.score >= 50 && !r.wikt && !r.google],
    ["low scores, everyday words", (r) => r.score >= 40 && r.score < 50 && r.everyday >= 50],
    ["proper nouns", (r) => r.score >= 50 && flag(r, "proper") && r.everyday < 40],
    ["abbreviations, dated and rare", (r) => r.score >= 50 && (flag(r, "abbreviation") || flag(r, "dated") || flag(r, "rare"))],
    ["inflections", (r) => r.score >= 50 && r.score < 60 && /(?:S|ED|ING)$/.test(r.word) && !r.uses],
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
      `list score ${row.score}${row.broda >= 0 ? `, hand-scored ${row.broda}` : ", never hand-scored"}`,
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
            score: { type: "integer", description: "40-90 when keeping, 0 when cutting" },
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

  /* Claude's first pass over a set of words, in batches. */
  async function guessAll(rows, onProgress) {
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
    for (const step of ["rules", "teach", "training", "result"]) $(`step-${step}`).hidden = step !== name;
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  function drawRules() {
    $("intro").value = state.rules.intro;
    $("rules").value = state.rules.rules;
    $("closing").value = state.rules.closing;
  }

  function readRules() {
    state.rules = { intro: $("intro").value, rules: $("rules").value, closing: $("closing").value };
    save();
  }

  function rowHtml(item, i) {
    const { row, guess, you } = item;
    const verdict = you ? you.verdict : guess ? guess.verdict : "";
    return `<div class="wordrow${item.changed ? " changed" : ""}" data-i="${i}">
      <div><div class="word">${safe(row.word)}</div><div class="facts">score ${row.score} · NYT ${row.uses} · everyday ${row.everyday}${row.cuts ? " · phrase" : ""}</div></div>
      <div class="guess${guess ? "" : " pending"}">${guess
        ? `<b>${guess.verdict === "cut" ? "cut" : `keep at ${guess.score}`}</b> <span class="why">${safe(guess.why)}</span>`
        : "thinking…"}</div>
      <div class="controls">
        <div class="verdictset" role="group" aria-label="Your verdict for ${safe(row.word)}">
          <button type="button" data-set="keep" aria-pressed="${verdict === "keep"}">keep</button>
          <button type="button" data-set="cut" aria-pressed="${verdict === "cut"}">cut</button>
        </div>
        <input class="score" type="number" min="0" max="100" step="5" value="${you ? you.score : guess ? guess.score : ""}" aria-label="Your score for ${safe(row.word)}">
        <input class="score note" type="text" style="width:150px" placeholder="why, if it matters" value="${safe(you && you.note)}" aria-label="Why, for ${safe(row.word)}">
      </div>
    </div>`;
  }

  function drawWords() {
    $("words").innerHTML = round.items.map(rowHtml).join("");
    countChanges();
  }

  function countChanges() {
    const done = round.items.filter((item) => item.guess).length;
    const changed = round.items.filter((item) => item.changed).length;
    $("teach-note").textContent = `${changed} correction${changed === 1 ? "" : "s"} of ${done} judged`;
    $("train").disabled = done < round.items.length;
  }

  // --- step 1: the rules ---

  drawRules();
  $("reset-rules").addEventListener("click", () => {
    state.rules = { ...EXAMPLE };
    drawRules();
    save();
    $("rules-note").textContent = "Back to the example.";
  });

  $("start").addEventListener("click", async () => {
    readRules();
    if (!C.key()) {
      $("rules-note").textContent = "Add your API key at the top first.";
      return;
    }
    $("start").disabled = true;
    $("rules-note").textContent = "Choosing a hundred words…";
    const rows = pick(PER_ROUND);
    round = { items: rows.map((row) => ({ row, guess: null, you: null, changed: false })) };
    show("teach");
    drawWords();
    $("guess-note").textContent = "Claude is judging them…";
    const { byWord, error } = await guessAll(rows, (done, total) => {
      $("guess-bar").style.width = `${Math.round((100 * done) / total)}%`;
      $("guess-note").textContent = `Claude has judged ${Math.min(done * BATCH, rows.length)} of ${rows.length}…`;
    });
    for (const item of round.items) {
      const guess = byWord.get(item.row.word);
      if (guess) item.guess = { verdict: guess.verdict, score: Number(guess.score) || 0, why: guess.why };
    }
    const missing = round.items.filter((item) => !item.guess).length;
    $("guess-note").textContent = error
      ? `Some words came back empty: ${safe(error.message)}`
      : missing ? `${missing} words came back empty; correct the rest and train anyway.` : "Change the ones it got wrong, then train.";
    for (const item of round.items) if (!item.guess) item.guess = { verdict: "keep", score: 50, why: "(no answer)" };
    $("start").disabled = false;
    drawWords();
    $("guess-bar").style.width = "100%";
  });

  // --- step 2: corrections ---

  $("words").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-set]");
    if (!button || !round) return;
    const wrap = button.closest(".wordrow");
    const item = round.items[Number(wrap.dataset.i)];
    const verdict = button.dataset.set;
    const score = verdict === "cut" ? 0 : Number(wrap.querySelector(".score").value) || item.guess.score || 50;
    item.you = { verdict, score, note: wrap.querySelector(".note").value };
    item.changed = item.you.verdict !== item.guess.verdict || (verdict === "keep" && item.you.score !== item.guess.score);
    wrap.classList.toggle("changed", item.changed);
    for (const other of wrap.querySelectorAll("button[data-set]")) other.setAttribute("aria-pressed", String(other === button));
    wrap.querySelector(".score").value = score;
    countChanges();
  });

  $("words").addEventListener("change", (event) => {
    const input = event.target.closest("input");
    if (!input || !round) return;
    const wrap = input.closest(".wordrow");
    const item = round.items[Number(wrap.dataset.i)];
    const verdict = wrap.querySelector('button[aria-pressed="true"]');
    item.you = {
      verdict: verdict ? verdict.dataset.set : item.guess.verdict,
      score: Number(wrap.querySelector(".score").value) || 0,
      note: wrap.querySelector(".note").value,
    };
    item.changed = item.you.verdict !== item.guess.verdict || (item.you.verdict === "keep" && item.you.score !== item.guess.score) || Boolean(item.you.note);
    wrap.classList.toggle("changed", item.changed);
    countChanges();
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
      const answer = await C.call({
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
})();
