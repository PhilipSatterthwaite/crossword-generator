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
  authDomain: "fillmein-87a2d.firebaseapp.com",
  projectId: "fillmein-87a2d",
  storageBucket: "fillmein-87a2d.firebasestorage.app",
  messagingSenderId: "721963482530",
  appId: "1:721963482530:web:8c057625ad061086fd46fb",
};
const PARTS = ["grid", "clues", "details"];
const ACCOUNT = "fillmein:account"; // the account whose puzzles this browser last kept
const PUSH_DELAY = 800; // ms to wait after a save before sending it, so typing sends one write

const S = window.GridfillStore;
const app = initializeApp(CONFIG);
const auth = getAuth(app);

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

async function startSync(user) {
  firestore = firestore || (await import(FIRESTORE));
  db = db || firestore.getFirestore(app);
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

// --- the account box and sign-in dialog ---

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
      box.append(button("Sign in", "btn small", openSignIn));
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

let dialog = null;

function openSignIn() {
  if (!dialog) dialog = buildDialog();
  dialog.querySelector(".sign-in-message").textContent = "";
  dialog.showModal();
  dialog.querySelector("[data-google]").focus();
}

function buildDialog() {
  const box = document.createElement("dialog");
  box.className = "sign-in";
  box.setAttribute("aria-labelledby", "sign-in-title");
  box.innerHTML = `
    <form class="sign-in-form" novalidate>
      <div class="sign-in-head">
        <h2 id="sign-in-title">Sign in to fillmein</h2>
        <button type="button" class="btn quiet small" data-close>Close</button>
      </div>
      <p class="sign-in-lede">Your puzzles save to your account, so you can pick them up on any device.</p>
      <button type="button" class="btn google" data-google>Continue with Google</button>
      <p class="or">or with your email</p>
      <label class="text-field">Email <input name="email" type="email" autocomplete="email" required></label>
      <label class="text-field">Password <input name="password" type="password" autocomplete="current-password" minlength="6" required></label>
      <div class="actions">
        <button type="submit" class="btn primary" data-mode="sign-in">Sign in</button>
        <button type="submit" class="btn" data-mode="create">Create account</button>
      </div>
      <button type="button" class="link-button" data-reset>Forgot your password?</button>
      <p class="sign-in-message" role="alert"></p>
    </form>`;
  document.body.append(box);

  const form = box.querySelector("form");
  const message = box.querySelector(".sign-in-message");
  const say = (text, tone = "error") => {
    message.textContent = text;
    message.dataset.tone = tone;
  };
  const busy = (on) => {
    for (const element of form.querySelectorAll("button")) element.disabled = on;
  };
  const finish = () => {
    form.reset();
    say("");
    box.close();
  };

  box.querySelector("[data-close]").addEventListener("click", () => box.close());
  box.addEventListener("click", (event) => {
    if (event.target === box) box.close(); // a click on the backdrop
  });

  box.querySelector("[data-google]").addEventListener("click", async () => {
    say("");
    busy(true);
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
      finish();
    } catch (error) {
      say(explain(error));
    } finally {
      busy(false);
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const create = Boolean(event.submitter && event.submitter.dataset.mode === "create");
    const email = form.elements.email.value.trim();
    const password = form.elements.password.value;
    if (!email || !password) {
      say("Enter your email and a password.");
      return;
    }
    say("");
    busy(true);
    try {
      await (create ? createUserWithEmailAndPassword : signInWithEmailAndPassword)(auth, email, password);
      finish();
    } catch (error) {
      say(explain(error));
    } finally {
      busy(false);
    }
  });

  box.querySelector("[data-reset]").addEventListener("click", async () => {
    const email = form.elements.email.value.trim();
    if (!email) {
      say("Enter your email above, then choose Forgot your password.");
      return;
    }
    busy(true);
    try {
      await sendPasswordResetEmail(auth, email);
      say("If there's an account with that email, a link to reset its password is on the way.", "note");
    } catch (error) {
      say(explain(error));
    } finally {
      busy(false);
    }
  });
  return box;
}
