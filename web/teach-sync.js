/* Keeping the AI teaching in step with the account.

   Your rules and your rounds of corrections are the part worth carrying between devices, so they go up
   as one small compressed document at users/{uid}/private/teach, and come down on the next machine you
   sign in on. The teaching is a single record rather than many, so whichever device saved last wins.

   Two things stay where they are. The verdicts of a run over a whole list are kept in that browser --
   half a million of them is far more than belongs in a document -- and your API key never leaves this
   browser at all. Everything that does go up is stored as it is, not encrypted, so it is readable by
   whoever runs the site's database, the same as word lists are.

   Needs account.js (window.Fillmein) for the account and Firestore, and a page that hands over its
   teaching with hold(). Exposes window.FillmeinTeachSync. */
(function (root) {
  "use strict";

  const DOCUMENT = "teach";
  const FORMAT = "gzip";
  /* A round saves after every answer, and each save rewrites the whole document, so changes are left
     to settle for a few seconds rather than sent a hundred times. Leaving the page sends at once. */
  const SETTLE = 5000;

  const listeners = new Set();
  let state = { signedIn: false, busy: false, last: 0, error: "" };
  let page = null; // what the page gave hold(): {read, write}
  let timer = null;
  let running = null;
  let again = false;

  const status = () => ({ ...state });
  const setState = (changes) => {
    state = { ...state, ...changes };
    for (const listener of listeners) listener(status());
  };

  // --- bytes ---

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const toBase64 = (bytes) => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  };
  const fromBase64 = (text) => {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };
  const squeeze = async (bytes) =>
    new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  const unsqueeze = async (bytes) =>
    new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  const pack = async (value) => toBase64(await squeeze(encoder.encode(JSON.stringify(value))));
  const unpack = async (text) => JSON.parse(decoder.decode(await unsqueeze(fromBase64(text))));

  // --- the account's copy ---

  const account = () => (root.Fillmein && root.Fillmein.user()) || null;

  async function theDoc() {
    const fs = await root.Fillmein.loadFirestore();
    const db = fs.getFirestore(root.Fillmein.app);
    return { fs, doc: fs.doc(db, "users", account().uid, "private", DOCUMENT) };
  }

  /* One pass. Whichever side was saved later stands: the account's copy comes down, or this browser's
     goes up. A copy saved before this browser kept stamps counts as the oldest there is. */
  async function syncOnce() {
    if (!page) return "";
    const { fs, doc } = await theDoc();
    const snapshot = await fs.getDoc(doc);
    const remote = snapshot.exists() ? snapshot.data() : null;
    const theirs = remote && typeof remote.data === "string" && remote.format === FORMAT ? Number(remote.updated) || 0 : 0;
    const mine = page.read();
    const stamp = Number(mine.updated) || 0;

    if (theirs > stamp) {
      const taken = page.write(await unpack(remote.data), theirs);
      // A page in the middle of a hundred words keeps what it has; the account's copy is still there
      // to be taken next time.
      return taken ? "" : "Newer teaching is waiting in your account. It will load once this round is done.";
    }
    if (stamp > theirs) await fs.setDoc(doc, { format: FORMAT, updated: stamp, data: await pack(mine.state) });
    return "";
  }

  /* Sync now, one at a time: a request made while one is running joins it, and anything saved
     meanwhile sends in another pass before it finishes. */
  function syncNow() {
    if (!account() || !page) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    clearTimeout(timer);
    setState({ busy: true, error: "" });
    running = (async () => {
      try {
        let trouble = "";
        do {
          again = false;
          trouble = await syncOnce();
        } while (again && account());
        setState({ busy: false, last: Date.now(), error: trouble });
      } catch (error) {
        setState({ busy: false, error: error.message || "Saving to your account didn't work." });
      } finally {
        running = null;
      }
    })();
    return running;
  }

  const soon = () => {
    if (!account() || !page) return;
    clearTimeout(timer);
    timer = setTimeout(syncNow, SETTLE);
  };

  function refreshStatus() {
    setState({ signedIn: Boolean(account()), error: "" });
    if (account()) syncNow();
  }

  root.FillmeinTeachSync = {
    status,
    onStatus(listener) {
      listeners.add(listener);
      listener(status());
      return () => listeners.delete(listener);
    },
    /* The page hands over how to read its teaching and how to take a newer copy. write() returns
       false if now is the wrong moment, and is asked again on the next pass. */
    hold(handlers) {
      page = handlers;
      refreshStatus();
    },
    syncNow,
    soon,
  };

  if (root.Fillmein) root.Fillmein.onUser(() => refreshStatus());
  else root.addEventListener("fillmein:user", () => refreshStatus());
  // Shutting the tab or switching away sends what is still settling, rather than losing it.
  root.addEventListener("visibilitychange", () => {
    if (root.document && root.document.visibilityState === "hidden" && timer) syncNow();
  });
  root.addEventListener("pagehide", () => {
    if (timer) syncNow();
  });
})(self);
