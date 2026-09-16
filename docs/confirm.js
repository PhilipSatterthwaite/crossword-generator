/* One yes-or-no popup, shared by every page: fillmeinConfirm({title, text, confirm}) resolves true only
   if the confirming button is pressed. Cancel, Escape and a click outside all mean no. */
(function (root) {
  "use strict";

  let box = null;

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
})(self);
