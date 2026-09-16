/* fillmein accounts. Sign in with Google or with an email and password (Firebase Authentication), and keep
   this browser's puzzles in step with the account's copies in Firestore, at users/{uid}/puzzles/{puzzle id}.

   Pages keep saving through store.js, into this browser. This module copies each part they save (grid,
   clues, details) up to the account, applies newer parts saved on other devices, and brings a guest's
   puzzles into the account at sign-in; for each part the most recently saved copy wins. Signing out
   removes the account's puzzles from this browser.

   Every page loads it as a module after store.js and gives it a [data-account] box for the Sign in button.
   Elements marked data-signed-in or data-signed-out show only in that state; [data-sign-in] opens the
   sign-in dialog. */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, sendPasswordResetEmail, signOut,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

const FIRESTORE = "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js"; // loaded once someone signs in
// The web app's Firebase settings. These identify the project and are meant to be public; the rules in
// firestore.rules are what keep each account's puzzles private.
const CONFIG = {
  apiKey: "AIzaSyAib6wDX8oBLXw3y66PF9W2k5C7igeUDBI",
  // Sign-in runs through the site's own domain (the helper pages in web/__/auth/), so Google's account
  // chooser says "continue to fillmein.org" and the sign-in window isn't third-party.
  authDomain: "fillmein.org",
  projectId: "fillmein-87a2d",
  storageBucket: "fillmein-87a2d.firebasestorage.app",
  messagingSenderId: "721963482530",
  appId: "1:721963482530:web:8c057625ad061086fd46fb",
  measurementId: "G-C9H5DQ0WJG",
};
const PARTS = ["grid", "clues", "details"];
const ACCOUNT = "fillmein:account"; // the account whose puzzles this browser last kept
const PUSH_DELAY = 800; // ms to wait after a save before sending it, so typing sends one write

const S = window.GridfillStore;
const app = initializeApp(CONFIG);
const auth = getAuth(app);

/* Google Analytics: page views and how many people are on the site, in the Firebase console. Left off in
   automated browsers so test runs don't count as visitors. Ad blockers block it, so the counts are a
   floor, not a headcount. */
if (!navigator.webdriver) {
  import("https://www.gstatic.com/firebasejs/12.19.0/firebase-analytics.js")
    .then(({ getAnalytics, isSupported }) => isSupported().then((ok) => ok && getAnalytics(app)))
    .catch(() => { /* blocked or unavailable: the site works the same */ });
}

let firestore = null; // the Firestore module, once loaded
let db = null;
let uid = null; // the signed-in account
let stopListening = null;
const known = new Map(); // puzzle id -> {part: time} of the account's copy, as last seen
const pending = new Map(); // puzzle id -> Set of parts (or "deleted") waiting to go up
let pushTimer = null;

const readAccount = () => {
  try { return localStorage.getItem(ACCOUNT); } catch (error) { return null; }
};
const writeAccount = (value) => {
  try {
    if (value) localStorage.setItem(ACCOUNT, value);
    else localStorage.removeItem(ACCOUNT);
  } catch (error) { /* storage unavailable */ }
};
const forgetPuzzlesOf = (owner) => {
  for (const [pid, entry] of Object.entries(S.entries())) if (entry.owner === owner) S.forget(pid);
};

// --- sync ---

function queue(pid, parts) {
  const waiting = pending.get(pid) || new Set();
  for (const part of parts) waiting.add(part);
  pending.set(pid, waiting);
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, PUSH_DELAY);
}

/* Send every waiting part that's newer here than in the account. */
async function push() {
  clearTimeout(pushTimer);
  pushTimer = null;
  if (!uid || !db) return;
  const account = uid;
  const work = [...pending];
  pending.clear();
  const entries = S.entries();
  await Promise.all(work.map(async ([pid, parts]) => {
    const ref = firestore.doc(db, "users", account, "puzzles", pid);
    const entry = entries[pid];
    if (!entry) {
      if (parts.has("deleted")) {
        known.delete(pid);
        await firestore.deleteDoc(ref).catch(showError);
      }
      return;
    }
    const seen = known.get(pid) || {};
    const update = { created: entry.created || Date.now(), updated: entry.updated || Date.now(), parts: {} };
    for (const part of PARTS) {
      const value = S.partData(pid, part);
      const time = S.partTime(entry, part);
      if (!parts.has(part) || value === null || time <= (seen[part] || 0)) continue;
      update[part] = JSON.stringify(value);
      update.parts[part] = time;
    }
    if (!Object.keys(update.parts).length) return;
    known.set(pid, { ...seen, ...update.parts });
    try {
      await firestore.setDoc(ref, update, { merge: true });
      // Only a puzzle the account really has is marked as the account's, so a failed write never
      // gets it mistaken later for one deleted on another device.
      if (entry.owner !== account && uid === account) S.setOwner(pid, account);
      setSyncState("ok");
    } catch (error) {
      known.set(pid, seen);
      showError(error);
    }
  }));
}

/* Take the parts of an account copy that are newer than this browser's. */
function applyDoc(pid, data) {
  const times = data.parts || {};
  known.set(pid, { ...times });
  const entry = S.entries()[pid];
  if (!entry || entry.owner !== uid) S.setOwner(pid, uid, data.created);
  for (const part of PARTS) {
    const time = times[part] || 0;
    if (!time || typeof data[part] !== "string" || time <= S.partTime(entry, part)) continue;
    try {
      S.applyRemote(pid, part, JSON.parse(data[part]), time);
    } catch (error) { /* a damaged copy: keep this browser's */ }
  }
}

/* The Firestore module, loaded once and shared with pages that need it (the Export page's share
   controls, the solve page). */
async function loadFirestore() {
  firestore = firestore || (await import(FIRESTORE));
  db = db || firestore.getFirestore(app);
  return firestore;
}

// --- sharing a puzzle to solve by link ---

/* Put the puzzle in "published" so anyone with the link can solve it. The document holds the finished
   grid, so whoever has the link can read the answers: it's for sharing with people, not a secret. */
async function publish(pid, { listed = false } = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in to share a link.");
  const grid = S.loadGrid(pid);
  if (!grid) throw new Error("There's no grid to share yet.");
  const empty = grid.letters.filter((letter, i) => !letter && !grid.blocks[i]).length;
  if (empty) throw new Error(`Fill every square first: ${empty} ${empty === 1 ? "is" : "are"} still empty.`);
  const clues = S.loadClues(pid);
  const details = S.loadDetails(pid);
  const text = {};
  for (const slot of grid.slots) {
    const clue = clues[S.clueKey(slot)];
    if (clue && clue.text.trim()) text[S.clueKey(slot)] = clue.text.trim().slice(0, 300);
  }
  const data = {
    owner: user.uid,
    title: (details.title || "").trim().slice(0, 200),
    author: (details.author || "").trim().slice(0, 200),
    width: grid.W,
    height: grid.H,
    cells: grid.blocks.map((block, i) => (block ? "#" : grid.letters[i])).join(""),
    clues: text,
    updated: Date.now(),
    listed: Boolean(listed), // shown on the Explore page, as well as reachable by link
  };
  const fs = await loadFirestore();
  await fs.setDoc(fs.doc(db, "published", pid), data);
  return data;
}

async function unpublish(pid) {
  const fs = await loadFirestore();
  await fs.deleteDoc(fs.doc(db, "published", pid));
}

/* What's published for this puzzle, or null. */
async function publishState(pid) {
  const fs = await loadFirestore();
  const snapshot = await fs.getDoc(fs.doc(db, "published", pid));
  return snapshot.exists() ? snapshot.data() : null;
}

const solveUrl = (pid) => new URL(`solve.html?p=${encodeURIComponent(pid)}`, location.href).href;

/* What pages can use: the app itself, Firestore on demand, who's signed in, and sharing. */
window.Fillmein = {
  app,
  loadFirestore,
  user: () => auth.currentUser,
  onUser(callback) {
    window.addEventListener("fillmein:user", (event) => callback(event.detail.user));
    callback(auth.currentUser);
  },
  publish,
  unpublish,
  publishState,
  solveUrl,
};

async function startSync(user) {
  await loadFirestore();
  if (uid !== user.uid) return; // signed out or switched accounts while Firestore loaded
  const previous = readAccount();
  if (previous && previous !== user.uid) forgetPuzzlesOf(previous); // left behind by another account
  writeAccount(user.uid);

  let first = true;
  stopListening = firestore.onSnapshot(firestore.collection(db, "users", user.uid, "puzzles"), (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type === "removed") {
        known.delete(change.doc.id);
        S.forget(change.doc.id);
      } else {
        applyDoc(change.doc.id, change.doc.data());
      }
    }
    if (!first) return;
    first = false;
    const inAccount = new Set(snapshot.docs.map((doc) => doc.id));
    for (const [pid, entry] of Object.entries(S.entries())) {
      if (entry.owner === user.uid && !inAccount.has(pid)) S.forget(pid); // deleted on another device
      else if (!entry.owner || entry.owner === user.uid) queue(pid, PARTS); // a guest's puzzle, or edits made offline
    }
  }, showError);
}

onAuthStateChanged(auth, (user) => {
  if (stopListening) stopListening();
  stopListening = null;
  known.clear();
  uid = user ? user.uid : null;
  renderAccount(user);
  window.dispatchEvent(new CustomEvent("fillmein:user", { detail: { user } }));
  if (user) startSync(user).catch(showError);
});

window.addEventListener("fillmein:saved", (event) => {
  if (uid) queue(event.detail.id, [event.detail.part]);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && pending.size) push();
});

async function signOutHere() {
  const account = uid;
  await push();
  await signOut(auth);
  if (account) forgetPuzzlesOf(account);
  writeAccount(null);
  const page = location.pathname.split("/").pop();
  if (page && page !== "index.html") location.href = "index.html";
}

// --- the account box ---

function button(label, className, onClick) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

function renderAccount(user) {
  for (const box of document.querySelectorAll("[data-account]")) {
    box.replaceChildren();
    box.dataset.state = user ? "signed-in" : "signed-out";
    if (user) {
      const who = document.createElement("span");
      who.className = "account-name";
      who.textContent = user.displayName || user.email || "Signed in";
      who.title = user.email || "";
      const sync = document.createElement("span");
      sync.className = "account-sync";
      sync.setAttribute("role", "status");
      box.append(who, sync, button("Sign out", "btn quiet small", () => signOutHere().catch(showError)));
    } else {
      box.append(button("Sign in", "btn small", () => openSignIn()));
    }
  }
  for (const element of document.querySelectorAll("[data-signed-in]")) element.hidden = !user;
  for (const element of document.querySelectorAll("[data-signed-out]")) element.hidden = Boolean(user);
}

function setSyncState(state, text = "") {
  for (const element of document.querySelectorAll(".account-sync")) {
    element.dataset.state = state;
    element.textContent = text;
  }
}

function showError(error) {
  console.error("fillmein account:", error && (error.code || error.message));
  setSyncState("error", "Not saving to your account");
  for (const element of document.querySelectorAll(".account-sync")) element.title = (error && (error.code || error.message)) || "";
}

document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-sign-in]")) return;
  event.preventDefault();
  openSignIn();
});

// --- the sign-in dialog ---

const WRONG = "That email and password don't match an account. Check them, or create an account.";
const MESSAGES = {
  "auth/invalid-credential": WRONG,
  "auth/invalid-login-credentials": WRONG,
  "auth/wrong-password": WRONG,
  "auth/user-not-found": WRONG,
  "auth/email-already-in-use": "There's already an account with that email. Sign in instead.",
  "auth/weak-password": "Use a password with at least 6 characters.",
  "auth/invalid-email": "That doesn't look like an email address.",
  "auth/missing-password": "Enter a password.",
  "auth/popup-closed-by-user": "",
  "auth/cancelled-popup-request": "",
  "auth/popup-blocked": "Your browser blocked the Google sign-in window. Allow pop-ups for fillmein.org and try again.",
  "auth/too-many-requests": "Too many tries. Wait a few minutes and try again.",
  "auth/network-request-failed": "Couldn't reach the sign-in service. Check your connection and try again.",
  "auth/unauthorized-domain": "Google sign-in isn't set up for this web address.",
  "auth/account-exists-with-different-credential": "That email already has an account that signs in another way. Try your email and password.",
};
const explain = (error) => MESSAGES[error.code] ?? `Sign-in didn't work (${error.code || error.message}).`;

const MODES = {
  "sign-in": {
    title: "Welcome back",
    lede: "Sign in to save your puzzles to your account and pick them up on any device.",
    submit: "Sign in",
    busy: "Signing in…",
    autocomplete: "current-password",
  },
  create: {
    title: "Create your account",
    lede: "Save your puzzles to an account and pick them up on any device. It's free.",
    submit: "Create account",
    busy: "Creating your account…",
    autocomplete: "new-password",
  },
};

const GOOGLE_LOGO = `<svg class="google-logo" viewBox="0 0 48 48" width="20" height="20" aria-hidden="true">
  <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.7-.4-3.9z"/>
  <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
  <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/>
  <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.7-.4-3.9z"/>
</svg>`;

let dialog = null;

function openSignIn(mode = "sign-in") {
  if (!dialog) dialog = buildDialog();
  dialog.setMode(mode);
  dialog.showModal();
  dialog.querySelector("[data-google]").focus();
}

function buildDialog() {
  const box = document.createElement("dialog");
  box.className = "sign-in";
  box.setAttribute("aria-labelledby", "sign-in-title");
  box.innerHTML = `
    <form class="sign-in-form" novalidate>
      <button type="button" class="sign-in-close" data-close aria-label="Close">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <span class="wordmark sign-in-mark" aria-hidden="true"><span>F</span><span>I</span><span>L</span><span>L</span><span class="wm-block"></span><span class="fill-letter">M</span><span class="fill-letter">E</span><span class="wm-block"></span><span class="fill-letter">I</span><span class="fill-letter">N</span></span>
      <div class="sign-in-head">
        <h2 id="sign-in-title"></h2>
        <p class="sign-in-lede"></p>
      </div>
      <button type="button" class="sign-in-google" data-google>${GOOGLE_LOGO}<span>Continue with Google</span></button>
      <p class="or">or use email</p>
      <div class="sign-in-modes" role="group" aria-label="Email">
        <button type="button" data-mode="sign-in" aria-pressed="true">Sign in</button>
        <button type="button" data-mode="create" aria-pressed="false">Create account</button>
      </div>
      <div class="sign-in-field">
        <label class="sign-in-label" for="sign-in-email">Email</label>
        <div class="sign-in-input"><input id="sign-in-email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required></div>
      </div>
      <div class="sign-in-field">
        <div class="sign-in-label"><label for="sign-in-password">Password</label><button type="button" class="link-button" data-reset>Forgot password?</button></div>
        <div class="sign-in-input">
          <input id="sign-in-password" name="password" type="password" autocomplete="current-password" minlength="6" required>
          <button type="button" class="sign-in-reveal" data-reveal aria-pressed="false" aria-label="Show password">Show</button>
        </div>
      </div>
      <p class="sign-in-message" role="alert"></p>
      <button type="submit" class="btn primary sign-in-submit"></button>
    </form>`;
  document.body.append(box);

  const form = box.querySelector("form");
  const message = box.querySelector(".sign-in-message");
  const submit = box.querySelector(".sign-in-submit");
  const password = form.elements.password;
  const reveal = box.querySelector("[data-reveal]");
  let mode = "sign-in";

  const say = (text, tone = "error") => {
    message.textContent = text;
    message.dataset.tone = tone;
  };
  const busy = (label) => {
    for (const element of form.querySelectorAll("button, input")) element.disabled = Boolean(label);
    submit.textContent = label || MODES[mode].submit;
  };
  const finish = () => {
    form.reset();
    showPassword(false);
    say("");
    box.close();
  };
  const showPassword = (show) => {
    password.type = show ? "text" : "password";
    reveal.textContent = show ? "Hide" : "Show";
    reveal.setAttribute("aria-pressed", String(show));
    reveal.setAttribute("aria-label", show ? "Hide password" : "Show password");
  };

  box.setMode = (next) => {
    mode = next;
    for (const option of box.querySelectorAll(".sign-in-modes [data-mode]")) option.setAttribute("aria-pressed", String(option.dataset.mode === mode));
    box.querySelector("#sign-in-title").textContent = MODES[mode].title;
    box.querySelector(".sign-in-lede").textContent = MODES[mode].lede;
    box.querySelector("[data-reset]").hidden = mode !== "sign-in";
    password.autocomplete = MODES[mode].autocomplete;
    submit.textContent = MODES[mode].submit;
    say("");
  };

  box.querySelector("[data-close]").addEventListener("click", () => box.close());
  box.addEventListener("click", (event) => {
    if (event.target === box) box.close(); // a click on the backdrop
  });
  box.querySelector(".sign-in-modes").addEventListener("click", (event) => {
    const option = event.target.closest("[data-mode]");
    if (option) box.setMode(option.dataset.mode);
  });
  reveal.addEventListener("click", () => showPassword(password.type === "password"));

  box.querySelector("[data-google]").addEventListener("click", async () => {
    say("");
    busy("Waiting for Google…");
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
      finish();
    } catch (error) {
      say(explain(error));
    } finally {
      busy(null);
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = form.elements.email.value.trim();
    if (!email || !password.value) {
      say(mode === "create" ? "Enter your email and choose a password." : "Enter your email and password.");
      (email ? password : form.elements.email).focus();
      return;
    }
    say("");
    busy(MODES[mode].busy);
    try {
      await (mode === "create" ? createUserWithEmailAndPassword : signInWithEmailAndPassword)(auth, email, password.value);
      finish();
    } catch (error) {
      say(explain(error));
    } finally {
      busy(null);
    }
  });

  box.querySelector("[data-reset]").addEventListener("click", async () => {
    const email = form.elements.email.value.trim();
    if (!email) {
      say("Enter your email, then choose Forgot password.");
      form.elements.email.focus();
      return;
    }
    busy("Sending…");
    try {
      await sendPasswordResetEmail(auth, email);
      say("If there's an account with that email, a link to reset its password is on the way.", "note");
    } catch (error) {
      say(explain(error));
    } finally {
      busy(null);
    }
  });
  return box;
}
