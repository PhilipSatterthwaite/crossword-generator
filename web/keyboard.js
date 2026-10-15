/* The phone's own keyboard for the grid, working the way a computer's does.

   On a computer: letters fill squares, "." makes a block (on the Grid page), space and Enter do what
   each page says, and Shift pressed and released on its own starts a rebus. A phone's keyboard does all
   of that but the last: its Shift key sends the page nothing. What it does send is the letter typed
   after it, as a capital. So the keyboard is asked for small letters, and a capital is the sign that
   Shift was pressed: it starts a rebus, with that letter first. The rest of the rebus is typed as usual
   and Enter keeps it, as on a computer.

   A phone keyboard also capitalises on its own at the start of an empty box, which would turn every
   letter into a rebus, so the box never quite empties: it keeps one quiet character in it. And some
   phone keyboards send no key press for Backspace in an empty box, only a request to delete; that is
   turned into the Backspace the page understands.

   FillmeinKeyboard.attach(input, {grid, isRebus}). On a device with a mouse or trackpad it does nothing. */
(function (root) {
  "use strict";

  const TOUCH = root.matchMedia && root.matchMedia("(hover: none) and (pointer: coarse)").matches;
  const QUIET = "-"; // kept in the box so it's never empty; no page reads it as anything
  const KEYBOARD_TALL = 150; // px the visible page shrinks by when a phone keyboard is up, at least

  function attach(input, options = {}) {
    if (!TOUCH || !input) return null;
    const isRebus = options.isRebus || (() => false);
    const view = root.visualViewport;

    input.setAttribute("inputmode", "text");
    input.setAttribute("autocapitalize", "none"); // small letters, so a capital means Shift
    input.setAttribute("autocorrect", "off");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");

    const send = (name, type = "keydown") => input.dispatchEvent(new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true }));
    const settle = () => {
      if (input.value !== QUIET) input.value = QUIET;
      try { input.setSelectionRange(1, 1); } catch (error) { /* not every box allows it */ }
    };
    input.addEventListener("focus", () => setTimeout(settle, 0));
    settle();

    /* What the keyboard typed arrives here before the page reads it. A capital starts a rebus first, so
       the page then takes the letters as a rebus's; the page clears the box, and the quiet character
       goes back in. */
    input.addEventListener("input", () => {
      const typed = input.value.split(QUIET).join("");
      if (input.value !== typed) input.value = typed; // the page sees only what was typed
      if (/[A-Z]/.test(typed) && !isRebus()) {
        send("Shift");
        send("Shift", "keyup");
      }
      setTimeout(settle, 0);
    });

    // Some keyboards send a letter as a key press instead: a capital there means Shift just the same.
    input.addEventListener("keydown", (event) => {
      if (event.isTrusted && /^[A-Z]$/.test(event.key) && !isRebus()) {
        send("Shift");
        send("Shift", "keyup");
      }
    }, true);

    // Backspace, however the keyboard sends it.
    input.addEventListener("beforeinput", (event) => {
      if (event.inputType !== "deleteContentBackward") return;
      event.preventDefault();
      send("Backspace");
      settle();
    });

    /* Lowering the keyboard with the phone's down arrow leaves the grid with the focus, and focusing it
       again does nothing, so a tap on the grid wouldn't bring the keyboard back. Here it does. */
    const keyboardUp = (() => {
      let tallest = view ? view.height : 0;
      root.addEventListener("orientationchange", () => { tallest = 0; });
      return () => {
        if (!view) return true;
        tallest = Math.max(tallest, view.height);
        return view.height < tallest - KEYBOARD_TALL;
      };
    })();
    if (options.grid) {
      options.grid.addEventListener("click", () => {
        if (document.activeElement !== input || keyboardUp()) return;
        input.blur();
        input.focus();
      });
    }
    return { input };
  }

  root.FillmeinKeyboard = { attach, touch: TOUCH };
})(self);
