/* The little bit of Claude plumbing the site shares: where the key is kept, which model to use, how
   a request is made, and what it has cost so far. Used by judge.js (a second opinion on the review
   card) and teach.js (the page where you teach it your rules).

   The key lives in this browser's localStorage and goes only to api.anthropic.com. That is fine for
   your own key on your own machine, and wrong for a key that pays for other people: anyone who can
   open the browser can read it. A server holding the key is what that would need. */
(() => {
  "use strict";
  const KEY = "fillmein:ai:key";
  const MODEL = "fillmein:ai:model";
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

  // Dollars per million tokens, from the pricing page. Cache reads cost a tenth of input, or less.
  const MODELS = {
    "claude-haiku-5-5": { name: "Haiku 5.5 - cheapest", in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    "claude-sonnet-5-5": { name: "Sonnet 5.5 - balanced", in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    "claude-opus-5-5": { name: "Opus 5.5 - best", in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
  };
  const DEFAULT_MODEL = "claude-haiku-5-5";
  const MOST_TOKENS = 128000; // the models' limit on one reply, and so the ceiling on asking again
  const listeners = new Set();

  const api = {
    MODELS,
    DEFAULT_MODEL,
    key: () => get(KEY).trim(),
    setKey: (value) => set(KEY, String(value).trim()),
    model: () => (MODELS[get(MODEL)] ? get(MODEL) : DEFAULT_MODEL),
    setModel: (value) => set(MODEL, value),
    spent: () => Number(get(SPENT, "0")) || 0,
    /* Money spent since this browser last forgot: handy beside anything that spends it. */
    onSpend(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    money: (amount) => `$${amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2)}`,

    /* One request. system and messages as the Messages API takes them; schema (a JSON schema) makes
       the API enforce the answer's shape, so the reply parses or the request fails. Thinking is on by
       default and counts against maxTokens, so leave it room. Returns the parsed JSON when a schema
       was given, otherwise the text. */
    async call({ system, messages, schema = null, maxTokens = 1024, effort = "low", cache = true, room = 1, model = null }) {
      const key = api.key();
      if (!key) throw new Error("no API key: add one at the top of the page");
      model = model && MODELS[model] ? model : api.model();
      const body = {
        model,
        max_tokens: maxTokens,
        messages,
        output_config: { effort, ...(schema ? { format: { type: "json_schema", schema } } : {}) },
      };
      if (system) {
        // The standing instructions repeat on every call, so they are cached: after the first they cost a tenth.
        body.system = [{ type: "text", text: system, ...(cache ? { cache_control: { type: "ephemeral" } } : {}) }];
      }
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 200)}`);
      const message = await response.json();
      const rates = MODELS[model];
      const used = message.usage || {};
      const cost = ((used.input_tokens || 0) * rates.in + (used.output_tokens || 0) * rates.out +
        (used.cache_read_input_tokens || 0) * rates.cacheRead + (used.cache_creation_input_tokens || 0) * rates.cacheWrite) / 1e6;
      set(SPENT, String(api.spent() + cost));
      for (const listener of listeners) listener(api.spent(), cost);
      const text = (message.content || []).filter((part) => part.type === "text").map((part) => part.text).join("");
      if (!schema) return text;
      const json = text.match(/\{[\s\S]*\}/);
      if (!json) {
        // Thinking counts against max_tokens, so a hard question can use the whole budget before a
        // word of the answer. Ask again with room to spare rather than handing back a failure.
        if (message.stop_reason === "max_tokens" && maxTokens < MOST_TOKENS && room < 3) {
          return api.call({ system, messages, schema, maxTokens: Math.min(maxTokens * 4, MOST_TOKENS), effort, cache, room: room + 1, model });
        }
        throw new Error(message.stop_reason === "max_tokens"
          ? `ran out of room before answering, even with ${maxTokens.toLocaleString()} tokens`
          : `no answer in the reply (stop reason: ${message.stop_reason || "?"})`);
      }
      return JSON.parse(json[0]);
    },

    /* Run jobs a few at a time, so a hundred words don't all leave at once. */
    async pool(jobs, width, onDone) {
      const results = new Array(jobs.length);
      let next = 0;
      let finished = 0;
      await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
        for (;;) {
          const mine = next++;
          if (mine >= jobs.length) return;
          try {
            results[mine] = await jobs[mine]();
          } catch (error) {
            results[mine] = { error };
          }
          if (onDone) onDone(++finished, jobs.length);
        }
      }));
      return results;
    },
  };

  window.FillmeinClaude = api;
})();
