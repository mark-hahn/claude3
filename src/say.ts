// The page's own alert and confirm, in place of window.alert and window.confirm: a drawn <dialog>
// (`.say-pop` in style.css) whose text can be selected and copied. Each is a promise, and they queue:
// a second one waits for the first's OK. An alert whose text is already waiting or on show is dropped,
// so an error that repeats (a failing keystroke send) doesn't pile up dialogs.
let line: Promise<unknown> = Promise.resolve();
const alerting = new Set<string>();

function button(label: string, value: string): HTMLButtonElement {
  const made = document.createElement("button");
  made.textContent = label;
  made.value = value;
  return made;
}

function show(text: string, asks: boolean, cancelFirst: boolean): Promise<boolean> {
  if (!asks && alerting.has(text)) return Promise.resolve(false);
  if (!asks) alerting.add(text);
  const turn = line.then(() => new Promise<boolean>((done) => {
    const dialog = document.createElement("dialog");
    dialog.className = "say-pop";
    dialog.setAttribute("closedby", "any");
    const body = document.createElement("pre");
    body.textContent = text;
    const form = document.createElement("form");
    form.method = "dialog";
    if (asks) form.dataset.help = "confirm dialog";
    else form.dataset.help = "alert dialog";
    const ok = button("OK", "ok");
    const cancel = asks ? button("Cancel", "") : null;
    // main.ts's Enter in a modal dialog presses the autofocus button.
    (cancelFirst && cancel ? cancel : ok).autofocus = true;
    form.append(ok);
    if (cancel) form.append(" ", cancel);
    dialog.append(body, form);
    dialog.addEventListener("close", () => {
      dialog.remove();
      alerting.delete(text);
      done(dialog.returnValue === "ok");
    });
    document.body.append(dialog);
    dialog.showModal();
  }));
  line = turn;
  return turn;
}

export function say(text: string): Promise<void> {
  return show(text, false, false).then(() => undefined);
}

// True for OK. Esc, a click on the gray and Cancel are false. `cancelFirst`: Cancel is the button
// Enter presses, for what can't be undone.
export function ask(text: string, cancelFirst = false): Promise<boolean> {
  return show(text, true, cancelFirst);
}
