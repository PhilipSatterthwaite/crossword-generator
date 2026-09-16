/* Keeping custom word lists in step with the account.

   Signing in is all it takes: the lists in this browser go up, anything the account already has comes
   down, and from then on every change is sent as it happens. Lists are compressed and split into chunks
   that fit a Firestore document, which keeps a cloned 500,000-word list manageable.

   They are stored as they are, not encrypted, so they are readable by anyone with access to the project's
   database — the site's owner, in other words. They are private from other people using the site, since
   the rules only let an account read its own, but they are not private from us.

   Needs account.js (window.Fillmein) for the signed-in account and Firestore, and lists.js
   (window.FillmeinLists) for the lists themselves. Exposes window.FillmeinSync. */
(function (root) {
  "use strict";

  const PRIVATE = "private";
  const EDITS = "edits"; // one document holding the per-word edits
  const CHUNK = 400000; // bytes per document, well under Firestore's 1MB
  const SYNCED = "fillmein:synced-lists"; // ids this device has seen in the account
  const FORMAT = "gzip"; // how a list's chunks are written, so older shapes can be spotted and skipped
  const SETTLE = 800; // ms to wait after a change before sending it

  const listeners = new Set();
  let state = { signedIn: false, busy: false, last: 0, error: "" };
  let timer = null;

  const status = () => ({ ...state });
  const announce = () => {
    for (const listener of listeners) listener(status());
  };
  const setState = (changes) => {
    state = { ...state, ...changes };
    announce();
  };

  // --- bytes ---

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function toBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  }
  function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  const squeeze = async (bytes) =>
    new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  const unsqueeze = async (bytes) =>
    new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());

  // --- the account's copy ---

  const account = () => (root.Fillmein && root.Fillmein.user()) || null;

  async function firestore() {
    const fs = await root.Fillmein.loadFirestore();
    return { fs, db: fs.getFirestore(root.Fillmein.app) };
  }

  async function upload(list) {
    const { fs, db } = await firestore();
    const packed = await squeeze(encoder.encode(JSON.stringify({ name: list.name, count: list.count, basedOn: list.basedOn || "", words: list.words })));
    const ref = fs.doc(db, "users", account().uid, "lists", list.id);
    const chunks = Math.ceil(packed.length / CHUNK) || 1;
    await fs.setDoc(ref, { name: list.name, count: list.count, updated: list.updated, chunks, bytes: packed.length, format: FORMAT });
    for (let i = 0; i < chunks; i++) {
      await fs.setDoc(fs.doc(ref, "chunks", String(i)), { data: toBase64(packed.subarray(i * CHUNK, (i + 1) * CHUNK)) });
    }
  }

  async function download(id, meta) {
    if (meta.format !== FORMAT) throw new Error("that list was saved in an older shape");
    const { fs, db } = await firestore();
    const ref = fs.doc(db, "users", account().uid, "lists", id);
    const parts = [];
    for (let i = 0; i < meta.chunks; i++) {
      const snapshot = await fs.getDoc(fs.doc(ref, "chunks", String(i)));
      if (!snapshot.exists()) throw new Error("a piece of that list is missing");
      parts.push(fromBase64(snapshot.data().data));
    }
    const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.length;
    }
    const { name, count, words, basedOn } = JSON.parse(decoder.decode(await unsqueeze(joined)));
    return { id, name, count, words, basedOn: basedOn || "", updated: meta.updated };
  }

  async function removeRemote(id) {
    const { fs, db } = await firestore();
    const ref = fs.doc(db, "users", account().uid, "lists", id);
    const snapshot = await fs.getDoc(ref);
    const chunks = snapshot.exists() ? snapshot.data().chunks || 0 : 0;
    for (let i = 0; i < chunks; i++) await fs.deleteDoc(fs.doc(ref, "chunks", String(i))).catch(() => {});
    await fs.deleteDoc(ref);
  }

  async function syncEdits(localEdits, localStamp) {
    const { fs, db } = await firestore();
    const ref = fs.doc(db, "users", account().uid, PRIVATE, EDITS);
    const snapshot = await fs.getDoc(ref);
    const remote = snapshot.exists() ? snapshot.data() : null;
    if (remote && remote.data && remote.updated > localStamp) {
      const edits = JSON.parse(decoder.decode(await unsqueeze(fromBase64(remote.data))));
      await root.FillmeinLists.saveOverrides(edits, remote.updated);
      return;
    }
    const packed = await squeeze(encoder.encode(JSON.stringify(localEdits)));
    await fs.setDoc(ref, { data: toBase64(packed), updated: localStamp || Date.now(), format: FORMAT });
  }

  /* Push what is newer here, pull what is newer there, and clear anything deleted here. */
  async function syncNow() {
    if (!account()) return;
    setState({ busy: true, error: "" });
    try {
      const { fs, db } = await firestore();
      const uid = account().uid;
      const [lists, edits, editStamp, tombstones] = await Promise.all([
        root.FillmeinLists.all(),
        root.FillmeinLists.overrides(),
        root.FillmeinLists.overridesStamp(),
        root.FillmeinLists.tombstones(),
      ]);

      for (const id of tombstones) {
        await removeRemote(id);
        await root.FillmeinLists.clearTombstone(id);
      }

      // Which lists this device has seen in the account, so one that disappears counts as deleted
      // elsewhere rather than as a list that still needs uploading.
      const known = (await root.FillmeinLists.getSetting(SYNCED)) || {};
      const here = new Map(lists.map((list) => [list.id, list]));
      const there = await fs.getDocs(fs.collection(db, "users", uid, "lists"));
      const seen = new Set();
      for (const snapshot of there.docs) {
        seen.add(snapshot.id);
        known[snapshot.id] = true;
        const meta = snapshot.data();
        const mine = here.get(snapshot.id);
        if (mine && mine.updated >= (meta.updated || 0)) {
          if (mine.updated > (meta.updated || 0)) await upload(mine);
          continue;
        }
        try {
          await root.FillmeinLists.put(await download(snapshot.id, meta));
        } catch (error) {
          if (mine) await upload(mine); // an older or damaged copy up there: replace it with this one
        }
      }
      for (const list of lists) {
        if (seen.has(list.id)) continue;
        if (known[list.id]) {
          await root.FillmeinLists.forgetList(list.id); // deleted on another device
          delete known[list.id];
        } else {
          await upload(list);
          known[list.id] = true;
        }
      }
      await root.FillmeinLists.setSetting(SYNCED, known);

      await syncEdits(edits, editStamp);
      setState({ busy: false, last: Date.now() });
    } catch (error) {
      setState({ busy: false, error: error.message || "Syncing didn't work." });
    }
  }

  /* A change here reaches the account a moment later, so a burst of edits sends once. */
  function syncSoon() {
    if (!account()) return;
    clearTimeout(timer);
    timer = setTimeout(syncNow, SETTLE);
  }

  function refreshStatus() {
    const user = account();
    setState({ signedIn: Boolean(user), error: "" });
    if (user) syncNow();
  }

  root.FillmeinSync = {
    status,
    onStatus(listener) {
      listeners.add(listener);
      listener(status());
      return () => listeners.delete(listener);
    },
    refreshStatus,
    syncNow,
  };

  // Follow the account, and send changes up as they happen.
  if (root.Fillmein) root.Fillmein.onUser(() => refreshStatus());
  else root.addEventListener("fillmein:user", () => refreshStatus());
  if (root.FillmeinLists) root.FillmeinLists.onChange(syncSoon);
})(self);
