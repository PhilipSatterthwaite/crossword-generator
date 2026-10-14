/* A keyboard of the site's own for touch screens, in place of the phone's, while the grid has focus.

   A phone's keyboard can't type a rebus: its Shift key sends the page nothing, so "press and release
   Shift" never happens. This one is capitals only, with Rebus where Shift would be, and a 123 key that
   hands over to the phone's own keyboard for numbers and symbols (tap the grid again to come back).

   Every key is sent to the grid's hidden input as the key press a real keyboard would make, so the
   page needs no second way of handling them: letters, Backspace, space, Enter, and Rebus as a Shift
   pressed and released on its own (or Enter, to finish a rebus already started).

   FillmeinKeyboard.attach(input, {isRebus, spaceLabel, enterLabel}). Does nothing on a device with a
   mouse or trackpad. */
(function (root) {
  "use strict";

  const TOUCH = root.matchMedia && root.matchMedia("(hover: none) and (pointer: coarse)").matches;
  const ROWS = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
  const REPEAT_AFTER = 400; // ms a held Backspace waits before repeating
  const REPEAT_EVERY = 70;

  function attach(input, options = {}) {
    if (!TOUCH || !input) return null;
    const isRebus = options.isRebus || (() => false);
    let native = false; // the phone's own keyboard is up, for numbers and symbols
    let switching = false; // the blur and focus that hand over to it, which aren't the grid losing focus

    input.setAttribute("inputmode", "none");

    const board = document.createElement("div");
    board.className = "touch-keys";
    board.setAttribute("role", "group");
    board.setAttribute("aria-label", "Keyboard");
    board.hidden = true;
    const key = (label, value, className = "") =>
      `<button type="button" class="tk${className ? ` ${className}` : ""}" data-key="${value}" aria-label="${value === " " ? "Space" : value}">${label}</button>`;
    board.innerHTML =
      `<div class="tk-row">${[...ROWS[0]].map((ch) => key(ch, ch)).join("")}</div>` +
      `<div class="tk-row tk-indent">${[...ROWS[1]].map((ch) => key(ch, ch)).join("")}</div>` +
      `<div class="tk-row">${key("Rebus", "Rebus", "tk-wide tk-rebus")}${[...ROWS[2]].map((ch) => key(ch, ch)).join("")}${key("⌫", "Backspace", "tk-wide")}</div>` +
      `<div class="tk-row">${key("123", "Native", "tk-wide tk-quiet")}${key(options.spaceLabel || "space", " ", "tk-space tk-quiet")}${key(options.enterLabel || "↵", "Enter", "tk-wide tk-quiet")}</div>`;
    document.body.append(board);

    const send = (name, type = "keydown") => input.dispatchEvent(new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true }));
    const press = (value) => {
      if (value === "Rebus") {
        // A rebus already started is finished as Enter would; otherwise Shift, pressed and let go alone.
        if (isRebus()) send("Enter");
        else {
          send("Shift");
          send("Shift", "keyup");
        }
      } else {
        send(value);
      }
      showRebus();
    };
    const showRebus = () => board.querySelector(".tk-rebus").setAttribute("aria-pressed", String(isRebus()));

    // Keys act on the press, not the lift, and never take the focus from the grid.
    let repeat = null;
    const stopRepeat = () => {
      clearTimeout(repeat);
      repeat = null;
    };
    board.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const button = event.target.closest("[data-key]");
      if (!button) return;
      const value = button.dataset.key;
      if (value === "Native") return; // on the click, below: a phone only opens its keyboard from one
      button.classList.add("down");
      press(value);
      if (value === "Backspace") {
        const again = () => {
          press("Backspace");
          repeat = setTimeout(again, REPEAT_EVERY);
        };
        repeat = setTimeout(again, REPEAT_AFTER);
      }
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
      board.addEventListener(type, () => {
        stopRepeat();
        for (const down of board.querySelectorAll(".down")) down.classList.remove("down");
      });
    }
    board.addEventListener("click", (event) => {
      const button = event.target.closest('[data-key="Native"]');
      if (!button) return;
      native = true;
      board.hidden = true;
      document.body.classList.remove("touch-keys-open");
      input.setAttribute("inputmode", "text");
      switching = true;
      input.blur();
      input.focus();
      switching = false;
    });

    input.addEventListener("focus", () => {
      if (native) return;
      board.hidden = false;
      document.body.classList.add("touch-keys-open");
      showRebus();
      // The square being typed in stays above the keyboard.
      requestAnimationFrame(() => {
        const r = input.getBoundingClientRect();
        const top = board.getBoundingClientRect().top;
        if (r.bottom > top - 8) root.scrollBy({ top: r.bottom - top + 24, behavior: "smooth" });
      });
    });
    input.addEventListener("blur", () => {
      if (switching) return;
      // Going back to the grid's own keyboard is a tap on the grid away.
      if (native) {
        native = false;
        input.setAttribute("inputmode", "none");
      }
      stopRepeat();
      board.hidden = true;
      document.body.classList.remove("touch-keys-open");
    });
    // A rebus can also end by tapping another square; keep the key's look in step.
    document.addEventListener("pointerup", () => requestAnimationFrame(showRebus));
    return { board, refresh: showRebus };
  }

  root.FillmeinKeyboard = { attach, touch: TOUCH };
})(self);
