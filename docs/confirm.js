/* Two popups, shared by every page. fillmeinConfirm({title, text, confirm}) is yes or no: it resolves
   true only if the confirming button is pressed, and Cancel, Escape and a click outside all mean no.
   fillmeinChoose({title, text, choices}) offers several ways on, and resolves the value of the one
   chosen, or null if the popup is dismissed. */
(function (root) {
  "use strict";

  let box = null;
  let chooser = null;

  function build() {
    box = document.createElement("dialog");
    box.className = "confirm-dialog";
    box.setAttribute("aria-labelledby", "confirm-title");
    box.innerHTML = `
      <div class="confirm-body">
        <h2 id="confirm-title"></h2>
        <p id="confirm-text" class="confirm-text"></p>
        <div class="confirm-actions">
          <button type="button" class="btn" data-confirm-no>Cancel</button>
          <button type="button" class="btn destructive" data-confirm-yes></button>
        </div>
      </div>`;
    box.addEventListener("click", (event) => {
      if (event.target === box) box.close();
    });
    document.body.append(box);
    return box;
  }

  root.fillmeinConfirm = ({ title, text = "", confirm = "Delete" }) => {
    const dialog = box || build();
    dialog.querySelector("#confirm-title").textContent = title;
    dialog.querySelector("#confirm-text").textContent = text;
    dialog.querySelector("#confirm-text").hidden = !text;
    const yes = dialog.querySelector("[data-confirm-yes]");
    const no = dialog.querySelector("[data-confirm-no]");
    yes.textContent = confirm;
    return new Promise((resolve) => {
      const finish = (answer) => {
        yes.removeEventListener("click", onYes);
        no.removeEventListener("click", onNo);
        dialog.removeEventListener("close", onClose);
        if (dialog.open) dialog.close();
        resolve(answer);
      };
      const onYes = () => finish(true);
      const onNo = () => finish(false);
      const onClose = () => finish(false);
      yes.addEventListener("click", onYes);
      no.addEventListener("click", onNo);
      dialog.addEventListener("close", onClose);
      dialog.showModal();
      no.focus();
    });
  };

  function buildChooser() {
    chooser = document.createElement("dialog");
    chooser.className = "confirm-dialog choose-dialog";
    chooser.setAttribute("aria-labelledby", "choose-title");
    chooser.innerHTML = `
      <div class="confirm-body">
        <h2 id="choose-title"></h2>
        <p id="choose-text" class="confirm-text"></p>
        <div class="confirm-choices" data-choices></div>
      </div>`;
    chooser.addEventListener("click", (event) => {
      if (event.target === chooser) chooser.close();
    });
    document.body.append(chooser);
    return chooser;
  }

  /* choices: [{value, label, note, kind}] — the first one is the one the popup starts on. */
  root.fillmeinChoose = ({ title, text = "", choices = [] }) => {
    const dialog = chooser || buildChooser();
    dialog.querySelector("#choose-title").textContent = title;
    dialog.querySelector("#choose-text").textContent = text;
    dialog.querySelector("#choose-text").hidden = !text;
    const holder = dialog.querySelector("[data-choices]");
    holder.replaceChildren();
    return new Promise((resolve) => {
      const finish = (answer) => {
        dialog.removeEventListener("close", onClose);
        if (dialog.open) dialog.close();
        resolve(answer);
      };
      const onClose = () => finish(null);
      for (const choice of choices) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `btn${choice.kind ? ` ${choice.kind}` : ""}`;
        button.dataset.choice = choice.value;
        const label = document.createElement("span");
        label.className = "choice-label";
        label.textContent = choice.label;
        button.append(label);
        if (choice.note) {
          const note = document.createElement("span");
          note.className = "choice-note";
          note.textContent = choice.note;
          button.append(note);
        }
        button.addEventListener("click", () => finish(choice.value));
        holder.append(button);
      }
      dialog.addEventListener("close", onClose);
      dialog.showModal();
      const first = holder.querySelector("button");
      if (first) first.focus();
    });
  };
})(self);
