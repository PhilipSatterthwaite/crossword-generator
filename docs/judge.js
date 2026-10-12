/* A second opinion on the word in front of you, from Claude, on the Word lists and Train pages.

   Hidden unless the page is opened once with ?ai=1 (?ai=0 turns it off again), and it does nothing
   until you paste an API key. The key is kept in this browser's localStorage and sent only to
   api.anthropic.com, which Anthropic allows for a personal tool like this one -- but anyone who can
   open this browser can read it, so it must never be a key that pays for other people. When the site
   has paying users the same prompt moves behind a server that holds the key instead.

   It only ever suggests. Keep, remove and score stay on the same keys they always were. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const KEY = "fillmein:ai:key";
  const ON = "fillmein:ai:on";
  const RUBRIC = "fillmein:ai:rubric";
  const MODEL = "fillmein:ai:model";
  const AUTO = "fillmein:ai:auto";
  const SPENT = "fillmein:ai:spent";

  const get = (name, fallback = "") => {
    try {
      return localStorage.getItem(name) ?? fallback;
    } catch (error) {
      return fallback; // private window, or storage turned off
    }
  };
  const set = (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch (error) {
      /* this session only, then */
    }
  };

  const flag = new URLSearchParams(location.search).get("ai");
  if (flag === "1") set(ON, "1");
  if (flag === "0") set(ON, "");
  if (!get(ON)) {
    window.FillmeinJudge = null; // the page carries on exactly as before
    return;
  }

  // Dollars per million tokens, from the pricing page. Cache reads cost a tenth of input, or less.
  const MODELS = {
    "claude-haiku-5-5": { name: "Haiku 5.5 - cheapest", in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    "claude-sonnet-5-5": { name: "Sonnet 5.5 - balanced", in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    "claude-opus-5-5": { name: "Opus 5.5 - best", in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
  };
  const DEFAULT_MODEL = "claude-haiku-5-5";

  /* The standing instructions, yours to edit in the panel. This default is only a starting point:
     every answer gets better the more of your own rules replace it. */
  const DEFAULT_RUBRIC = `You judge entries for a crossword word list used by an autofill. For each word, decide whether it
earns a place in a published American crossword, and if so what it is worth.

Keep a word when a solver would recognise it on sight and not resent it: ordinary vocabulary, real
phrases people actually say, well-known names, titles and brands.

Cut a word when it is:
- a phrase that is grammatical but nobody says ("green paint": BUSYPLACE, REDHOUSE)
- a made-up inflection or comparative (RANDOMEST, REEMAIL, UNSOGGY)
- scientific taxonomy, an obscure genus or species (GORGONACEA)
- an obscure person, place or brand only a specialist would know
- a fragment or partial phrase that is not a thing on its own (ATO, INAN)
- crosswordese, kept alive only by other crosswords
- crude, offensive or grim enough to fail the breakfast test

Scores, which only matter in bands:
- 90: sparkling, an entry a constructor would build a grid around
- 80: very good, lively and current
- 70: good, solid fill anyone is pleased to see
- 60: fine, unremarkable, no complaints
- 50: dull but legitimate; it fills a hole without hurting
- 40: weak; allowed only when a corner demands it
- cut: should not be in the list at all

Judge the word itself, not how useful its letters are. The statistics are evidence, not the verdict:
a word with no crossword history can still be excellent, and plenty of published answers are poor.
Wiktionary tags are hints only.

Answer with the verdict, a score (40-90 when keeping, 0 when cutting) and a reason of at most twelve
words. Say what is wrong with the word, not what the numbers say.`;

  /* The answer's shape, enforced by the API rather than asked for in words. Every field is required
     and nothing else is allowed, so score comes back even on a cut, where it means nothing. */
  const VERDICT_SCHEMA = {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["keep", "cut"] },
      score: { type: "integer", description: "40 to 90 when keeping; 0 when cutting" },
      why: { type: "string", description: "at most 12 words" },
    },
    required: ["verdict", "score", "why"],
    additionalProperties: false,
  };

  const WIKT = ["listed", "noun", "verb", "adjective", "adverb", "proper", "phrase", "abbreviation", "dated", "informal", "offensive", "rare", "inflection"];
  const PAPERS = ["lat", "wsj", "usa", "tny", "up", "nw", "other"];
  const safe = (text) => String(text).replace(/[&<>]/g, "");

  const style = document.createElement("style");
  style.textContent = [
    "#judge-panel { position: fixed; right: 16px; bottom: 16px; width: 320px; max-width: calc(100vw - 32px); z-index: 60;",
    "  background: var(--surface, #fff); color: inherit; border: 1px solid var(--line, #ccc); border-radius: 10px;",
    "  box-shadow: 0 8px 24px rgba(0,0,0,.18); font: 13px/1.45 var(--sans, system-ui); }",
    "#judge-panel .head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line, #ddd); }",
    "#judge-panel .head b { flex: 1; }",
    "#judge-panel .body { padding: 10px 12px; display: grid; gap: 8px; }",
    "#judge-panel.shut .body { display: none; }",
    "#judge-panel label { display: grid; gap: 3px; font-size: 12px; color: var(--muted, #666); }",
    "#judge-panel input, #judge-panel select, #judge-panel textarea { font: inherit; width: 100%; padding: 5px 7px;",
    "  border: 1px solid var(--line, #ccc); border-radius: 6px; background: var(--page, #fff); color: inherit; }",
    "#judge-panel textarea { min-height: 120px; resize: vertical; font-size: 12px; }",
    "#judge-panel .row { display: flex; gap: 8px; align-items: center; }",
    "#judge-panel .note { font-size: 11px; color: var(--muted, #777); }",
    "#judge-box { margin: 8px 0 0; }",
    "#judge-box .verdict { margin: 0; padding: 7px 10px; border: 1px solid var(--line, #ddd); border-radius: 8px; }",
    "#judge-box .verdict.keep { border-left: 3px solid #2a7; }",
    "#judge-box .verdict.cut { border-left: 3px solid #c33; }",
    "#judge-box .verdict .why { color: var(--muted, #666); }",
    "#judge-box .verdict.waiting { opacity: .65; }",
  ].join("\n");
  document.head.append(style);

  const panel = document.createElement("div");
  panel.id = "judge-panel";
  panel.className = "shut";
  panel.innerHTML =
    '<div class="head"><b>Claude (private)</b><span class="note" id="judge-spent"></span>' +
    '<button type="button" class="btn quiet" id="judge-toggle">Open</button></div>' +
    '<div class="body">' +
    '<label>API key<input type="password" id="judge-key" placeholder="sk-ant-..." autocomplete="off" spellcheck="false"></label>' +
    `<label>Model<select id="judge-model">${Object.entries(MODELS).map(([id, m]) => `<option value="${id}">${m.name}</option>`).join("")}</select></label>` +
    '<label class="row"><input type="checkbox" id="judge-auto" style="width:auto"><span>Judge each word as it comes up</span></label>' +
    '<label>Your rules<textarea id="judge-rubric" spellcheck="false"></textarea></label>' +
    '<div class="row"><button type="button" class="btn quiet" id="judge-reset">Reset rules</button>' +
    '<button type="button" class="btn quiet" id="judge-forget">Forget key</button></div>' +
    '<p class="note" id="judge-status">The key stays in this browser and goes only to Anthropic. Use a key of your own, never one that pays for other people.</p>' +
    "</div>";
  document.body.append(panel);

  $("judge-key").value = get(KEY);
  $("judge-model").value = MODELS[get(MODEL)] ? get(MODEL) : DEFAULT_MODEL;
  $("judge-rubric").value = get(RUBRIC) || DEFAULT_RUBRIC;
  $("judge-auto").checked = get(AUTO) === "1";

  const say = (text) => ($("judge-status").textContent = text);
  let spent = Number(get(SPENT, "0")) || 0;
  const showSpent = () => ($("judge-spent").textContent = spent ? `$${spent < 0.01 ? spent.toFixed(4) : spent.toFixed(2)}` : "");
  showSpent();

  $("judge-toggle").addEventListener("click", () => {
    panel.classList.toggle("shut");
    $("judge-toggle").textContent = panel.classList.contains("shut") ? "Open" : "Close";
  });
  $("judge-key").addEventListener("change", () => set(KEY, $("judge-key").value.trim()));
  $("judge-model").addEventListener("change", () => {
    set(MODEL, $("judge-model").value);
    cache.clear(); // another model may well say something else
  });
  $("judge-rubric").addEventListener("change", () => {
    set(RUBRIC, $("judge-rubric").value);
    cache.clear(); // new rules, new verdicts
  });
  $("judge-auto").addEventListener("change", () => {
    set(AUTO, $("judge-auto").checked ? "1" : "");
    if (current) show(current);
  });
  $("judge-reset").addEventListener("click", () => {
    $("judge-rubric").value = DEFAULT_RUBRIC;
    set(RUBRIC, DEFAULT_RUBRIC);
    cache.clear();
  });
  $("judge-forget").addEventListener("click", () => {
    set(KEY, "");
    $("judge-key").value = "";
    say("Key forgotten.");
  });

  // --- what Claude is told about a word ---

  const defFiles = new Map(); // two letters -> Promise of {word: definition}
  function definitionOf(word) {
    const prefix = word.slice(0, 2);
    if (!defFiles.has(prefix)) {
      defFiles.set(prefix, fetch(`defs/${prefix}.json?v=${window.FILLMEIN_DEFS_VERSION || ""}`)
        .then((response) => (response.ok ? response.json() : {}))
        .catch(() => {
          defFiles.delete(prefix);
          return {};
        }));
    }
    return defFiles.get(prefix).then((file) => file[word] || "");
  }

  async function factsFor(row, reading) {
    const tags = WIKT.filter((name, i) => (row.wikt >> i) & 1);
    const papers = PAPERS.reduce((sum, key) => sum + (row[key] || 0), 0);
    const definition = await definitionOf(row.word);
    return [
      `WORD: ${row.word} (${row.len} letters)`,
      reading && reading !== row.word ? `reads as: ${reading}` : "",
      `list score now: ${row.score}${row.broda >= 0 ? `, Broda's own score: ${row.broda}` : ", not in Broda's list"}`,
      `NYT puzzles that used it: ${row.uses}${row.year ? `, last in ${row.year}` : ""}; other crossword outlets: ${papers}`,
      `everyday familiarity (0-100): ${row.everyday}; Zipf frequency: ${row.zipf ? row.zipf.toFixed(1) : "unmeasured"}`,
      `Google web count: ${row.google}; Google Books 2015-19: ${row.books}`,
      `Wikipedia article of that name: ${row.wiki ? "yes" : "no"}`,
      tags.length ? `Wiktionary says: ${tags.join(", ")}` : "not in Wiktionary",
      definition ? `definition: ${definition}` : "",
    ].filter(Boolean).join("\n");
  }

  // --- asking ---

  const cache = new Map(); // word -> Promise of {verdict, score, why}
  let current = null;

  async function ask(row, reading) {
    const key = get(KEY).trim();
    if (!key) throw new Error("no key");
    const model = $("judge-model").value;
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        // Thinking is on by default and counts against max_tokens, so leave it room: too small a
        // budget is spent thinking and the reply comes back with no text at all.
        max_tokens: 1024,
        // The rules are the same every time, so they are cached: after the first call they cost a tenth.
        system: [{ type: "text", text: $("judge-rubric").value, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: await factsFor(row, reading) }],
        output_config: {
          effort: "low", // a one-word judgement doesn't need deep thought, and this keeps it quick and cheap
          format: { type: "json_schema", schema: VERDICT_SCHEMA }, // the shape is enforced, not hoped for
        },
      }),
    });
    if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 160)}`);
    const message = await response.json();
    const rates = MODELS[model];
    const used = message.usage || {};
    spent += ((used.input_tokens || 0) * rates.in + (used.output_tokens || 0) * rates.out +
      (used.cache_read_input_tokens || 0) * rates.cacheRead + (used.cache_creation_input_tokens || 0) * rates.cacheWrite) / 1e6;
    set(SPENT, String(spent));
    showSpent();
    const text = (message.content || []).filter((part) => part.type === "text").map((part) => part.text).join("");
    const json = text.match(/\{[\s\S]*\}/); // the schema makes this the whole reply, but a stray word around it is survivable
    if (!json) {
      // Worth saying which, since the cures differ: more room, or a prompt the model would rather refuse.
      say(`No verdict. stop_reason: ${message.stop_reason || "?"}. Reply began: ${text.slice(0, 200) || "(nothing)"}`);
      throw new Error(message.stop_reason === "max_tokens" ? "ran out of room before answering" : "no verdict in the reply");
    }
    const verdict = JSON.parse(json[0]);
    return {
      verdict: verdict.verdict === "cut" ? "cut" : "keep",
      score: Number(verdict.score) || null,
      why: String(verdict.why || ""),
    };
  }

  function judge(row, reading) {
    if (!cache.has(row.word)) {
      cache.set(row.word, ask(row, reading).catch((error) => {
        cache.delete(row.word); // a failure shouldn't stick to the word
        throw error;
      }));
    }
    return cache.get(row.word);
  }

  // --- the line under the card ---

  function draw(html) {
    const box = $("judge-box");
    if (box) box.innerHTML = html;
  }

  async function show(card) {
    const { row, reading } = card;
    if (!get(KEY).trim()) {
      draw('<p class="verdict waiting">Claude: paste an API key in the panel for a second opinion.</p>');
      return;
    }
    if (!$("judge-auto").checked && !cache.has(row.word)) {
      draw(`<p class="verdict waiting">Claude: <button type="button" class="btn quiet" id="judge-now">ask about ${safe(row.word)}</button></p>`);
      const button = $("judge-now");
      if (button) button.addEventListener("click", () => {
        judge(row, reading).catch(() => {});
        show(card);
      });
      return;
    }
    draw(`<p class="verdict waiting">Claude is looking at ${safe(row.word)}...</p>`);
    try {
      const out = await judge(row, reading);
      if (current !== card) return; // you moved on while it answered
      draw(`<p class="verdict ${out.verdict}">Claude: <b>${out.verdict === "cut" ? "cut" : `keep at ${out.score || "?"}`}</b> ` +
        `<span class="why">${safe(out.why)}</span></p>`);
    } catch (error) {
      if (current !== card) return;
      draw(`<p class="verdict waiting">Claude couldn't answer: ${safe(error.message)}</p>`);
      say(`Last error: ${error.message}`);
    }
  }

  /* listtool.js calls this whenever the review card changes. `next` holds the cards after it, judged
     ahead so the verdict is already there when you reach them. */
  window.FillmeinJudge = {
    onCard(row, reading, next = []) {
      if (!$("judge-box")) return;
      current = { row, reading };
      show(current);
      if ($("judge-auto").checked && get(KEY).trim()) {
        for (const other of next.slice(0, 2)) judge(other, other.word).catch(() => {});
      }
    },
  };
})();
