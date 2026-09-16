/* Syncing custom word lists to the account, encrypted in this browser so nobody else can read them.

   The passphrase never leaves the browser. It derives a key (PBKDF2, then AES-GCM), and everything that
   could say anything about a list — its name, its words, the per-word edits — is compressed, encrypted
   and only then uploaded, split into chunks that fit a Firestore document. The account holds ciphertext,
   a salt and timestamps; no one with database access, the site's owner included, can read the contents.

   Lose the passphrase and the lists are lost with it: there is no copy of the key anywhere.

   Needs account.js (window.Fillmein) for the signed-in account and Firestore, and lists.js
   (window.FillmeinLists) for the lists themselves. Exposes window.FillmeinSync. */
(function (root) {
  "use strict";

  const PRIVATE = "private";
  const CHECK = "lists"; // the private document holding the salt and check value
  const EDITS = "edits"; // the private document holding the encrypted per-word edits
  const ITERATIONS = 250000;
  const CHUNK = 400000; // bytes of ciphertext per document, well under Firestore's 1MB
  const KEY_STORE = "fillmein:list-key"; // this device's remembered key lives in IndexedDB, never uploaded
  const SYNCED = "fillmein:synced-lists"; // ids this device has seen in the account
  const CHECK_TEXT = "fillmein list key";

  const listeners = new Set();
  let key = null;        // the CryptoKey, once unlocked
  let state = { signedIn: false, hasPassphrase: false, unlocked: false, busy: false, last: 0, error: "" };

  const announce = () => {
    for (const listener of listeners) listener(status());
  };
  const status = () => ({ ...state });
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

  // --- the key ---

  async function deriveKey(passphrase, salt) {
    const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      false, // not extractable: it can be used here but never read out
      ["encrypt", "decrypt"]
    );
  }

  async function encrypt(bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
    return { iv: toBase64(iv), data: toBase64(sealed) };
  }

  async function decrypt({ iv, data }) {
    const open = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, key, fromBase64(data));
    return new Uint8Array(open);
  }

  /* Remember the key on this device so the passphrase is asked for once per browser. IndexedDB keeps the
     key object itself, which can't be read back out as text by anything, including this code. */
  async function rememberKey(value) {
    try {
      await root.FillmeinLists.setSetting(KEY_STORE, value);
    } catch (error) { /* a browser that won't store it just asks again next time */ }
  }
  const forgetKey = () => root.FillmeinLists.setSetting(KEY_STORE, null).catch(() => {});
  const rememberedKey = () => root.FillmeinLists.getSetting(KEY_STORE).catch(() => null);

  // --- the account's copy ---

  const account = () => (root.Fillmein && root.Fillmein.user()) || null;

  async function firestore() {
    const fs = await root.Fillmein.loadFirestore();
    return { fs, db: fs.getFirestore(root.Fillmein.app) };
  }

  const privateDoc = async (name) => {
    const { fs, db } = await firestore();
    return { fs, ref: fs.doc(db, "users", account().uid, PRIVATE, name) };
  };

  /* The salt and check value, made on the first passphrase and read on every other device. */
  async function readCheck() {
    const { fs, ref } = await privateDoc(CHECK);
    const snapshot = await fs.getDoc(ref);
    return snapshot.exists() ? snapshot.data() : null;
  }

  async function writeCheck(salt) {
    const { fs, ref } = await privateDoc(CHECK);
    const check = await encrypt(encoder.encode(CHECK_TEXT));
    await fs.setDoc(ref, { salt: toBase64(salt), check, updated: Date.now() });
  }

  async function keyWorks(check) {
    try {
      return decoder.decode(await decrypt(check)) === CHECK_TEXT;
    } catch (error) {
      return false;
    }
  }

  // --- lists to and from the account ---

  async function upload(list) {
    const { fs, db } = await firestore();
    const uid = account().uid;
    const packed = await squeeze(encoder.encode(JSON.stringify({ name: list.name, count: list.count, words: list.words })));
    const chunks = [];
    for (let at = 0; at < packed.length; at += CHUNK) chunks.push(await encrypt(packed.subarray(at, at + CHUNK)));
    const ref = fs.doc(db, "users", uid, "lists", list.id);
    await fs.setDoc(ref, { chunks: chunks.length, updated: list.updated, bytes: packed.length });
    for (const [i, chunk] of chunks.entries()) await fs.setDoc(fs.doc(ref, "chunks", String(i)), chunk);
  }

  async function download(id, meta) {
    const { fs, db } = await firestore();
    const ref = fs.doc(db, "users", account().uid, "lists", id);
    const parts = [];
    for (let i = 0; i < meta.chunks; i++) {
      const snapshot = await fs.getDoc(fs.doc(ref, "chunks", String(i)));
      if (!snapshot.exists()) throw new Error("a piece of that list is missing");
      parts.push(await decrypt(snapshot.data()));
    }
    const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.length;
    }
    const { name, count, words } = JSON.parse(decoder.decode(await unsqueeze(joined)));
    return { id, name, count, words, updated: meta.updated };
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
    const { fs, ref } = await privateDoc(EDITS);
    const snapshot = await fs.getDoc(ref);
    const remote = snapshot.exists() ? snapshot.data() : null;
    if (remote && remote.updated > localStamp) {
      const edits = JSON.parse(decoder.decode(await unsqueeze(await decrypt(remote))));
      await root.FillmeinLists.saveOverrides(edits, remote.updated);
      return;
    }
    const sealed = await encrypt(await squeeze(encoder.encode(JSON.stringify(localEdits))));
    await fs.setDoc(ref, { ...sealed, updated: localStamp || Date.now() });
  }

  /* Push what's newer here, pull what's newer there, and clear anything deleted here. */
  async function syncNow() {
    if (!key || !account()) return;
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
        await root.FillmeinLists.put(await download(snapshot.id, meta));
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

  // --- what the page calls ---

  async function refreshStatus() {
    const user = account();
    if (!user) {
      key = null;
      setState({ signedIn: false, hasPassphrase: false, unlocked: false });
      return;
    }
    let check = null;
    try {
      check = await readCheck();
    } catch (error) {
      setState({ signedIn: true, error: "Couldn't reach your account." });
      return;
    }
    if (!check) {
      key = null;
      setState({ signedIn: true, hasPassphrase: false, unlocked: false });
      return;
    }
    const remembered = await rememberedKey();
    if (remembered) {
      key = remembered;
      if (await keyWorks(check.check)) {
        setState({ signedIn: true, hasPassphrase: true, unlocked: true });
        syncNow();
        return;
      }
      key = null;
      await forgetKey(); // the passphrase changed elsewhere
    }
    setState({ signedIn: true, hasPassphrase: true, unlocked: false });
  }

  /* First passphrase for this account: everything on this device goes up, encrypted. */
  async function setPassphrase(passphrase) {
    if (!account()) throw new Error("Sign in first.");
    if (!passphrase || passphrase.length < 8) throw new Error("Use a passphrase of at least 8 characters.");
    if (await readCheck()) throw new Error("This account already has a passphrase. Unlock with it instead.");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    key = await deriveKey(passphrase, salt);
    await writeCheck(salt);
    await rememberKey(key);
    setState({ hasPassphrase: true, unlocked: true });
    await syncNow();
  }

  async function unlock(passphrase) {
    if (!account()) throw new Error("Sign in first.");
    const check = await readCheck();
    if (!check) throw new Error("This account has no passphrase yet. Set one instead.");
    key = await deriveKey(passphrase, fromBase64(check.salt));
    if (!(await keyWorks(check.check))) {
      key = null;
      throw new Error("That passphrase doesn't match this account's lists.");
    }
    await rememberKey(key);
    setState({ hasPassphrase: true, unlocked: true, error: "" });
    await syncNow();
  }

  async function lock() {
    key = null;
    await forgetKey();
    setState({ unlocked: false });
  }

  root.FillmeinSync = {
    status,
    onStatus(listener) {
      listeners.add(listener);
      listener(status());
      return () => listeners.delete(listener);
    },
    refreshStatus,
    setPassphrase,
    unlock,
    lock,
    syncNow,
  };

  // Follow the account, and send changes up as they happen.
  if (root.Fillmein) root.Fillmein.onUser(() => refreshStatus());
  else root.addEventListener("fillmein:user", () => refreshStatus());
  if (root.FillmeinLists) {
    root.FillmeinLists.onChange(() => {
      if (key && account()) syncNow();
    });
  }
})(self);
