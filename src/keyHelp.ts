// Middle-click on an item shows how it is used, from src/tip-text.txt: each "@name" line starts the
// block of the element whose data-help is that name. The ? button in the tab strip shows the "global keys"
// block and the block of the focused element's data-mode. An element with no data-help is display only:
// the middle-click does nothing there. Names are literal in the source so tipText.check.mjs can match
// them to the blocks.
import raw from "./tip-text.txt?raw";
import { hide as hideTip } from "./tooltip.ts";

export const GLOBAL = "global keys";

function parse(text: string): Map<string, string> {
  const tips = new Map<string, string>();
  for (const block of text.split(/^@/m).slice(1)) {
    const end = block.indexOf("\n");
    tips.set((end < 0 ? block : block.slice(0, end)).trim(), end < 0 ? "" : block.slice(end + 1).trim());
  }
  return tips;
}
let tips = parse(raw);
// Saving the file swaps the text in without reloading the page.
import.meta.hot?.accept("./tip-text.txt?raw", (mod) => {
  if (mod) tips = parse(mod.default as string);
});

const dialog = document.createElement("dialog");
dialog.className = "help-pop";
dialog.setAttribute("closedby", "any");
const title = document.createElement("div");
title.className = "help-title";
const body = document.createElement("div");
body.className = "help-text";
const close = document.createElement("button");
close.textContent = "Close";
close.addEventListener("click", () => dialog.close());
const buttons = document.createElement("div");
buttons.className = "help-buttons";
buttons.append(close);
dialog.append(title, body, buttons);
document.body.append(dialog);

// What a line acts on, up to its ": " ("Ctrl-click", "Enter (outside a text box)"), at a line's or a
// sentence's start: shown blue. tip-text.txt keeps ": " for that alone.
const ACTION = /(?<=^|\. )[^:\n]+?(?=: )/gm;
function span(className: string, text: string): HTMLSpanElement {
  const part = document.createElement("span");
  part.className = className;
  part.textContent = text;
  return part;
}
function actions(text: string): (string | Node)[] {
  const parts: (string | Node)[] = [];
  let at = 0;
  for (const match of text.matchAll(ACTION)) {
    parts.push(text.slice(at, match.index), span("help-key", match[0]));
    at = match.index + match[0].length;
  }
  parts.push(text.slice(at));
  return parts;
}
function show(heading: string, parts: (string | Node)[]): void {
  hideTip();
  title.textContent = heading;
  body.replaceChildren(...parts);
  // A modal open on top of another (the Git popup) stacks above it.
  if (!dialog.open) dialog.showModal();
}
const blockOf = (name: string): string => tips.get(name) ?? `No text in src/tip-text.txt for @${name}`;

export function showItem(name: string): void {
  show(name, actions(blockOf(name)));
}

// The ? button: global keys, then the keys of what has focus (the button keeps focus where it was).
// The focused part's name is in light red, at the top and over its keys.
export function showKeys(): void {
  const mode = document.activeElement?.closest<HTMLElement>("[data-mode]")?.dataset.mode;
  const parts = [...actions("Focused: "), mode ? span("help-mode", mode) : "none", "\n\n", ...actions(tips.get(GLOBAL) ?? "")];
  if (mode) parts.push("\n\n", span("help-mode", mode), ":\n", ...actions(blockOf(mode)));
  show("Keys", parts);
}

// Window capture, ahead of every other listener: Monaco's middle-drag column select, xterm's mouse
// reporting, Edge's autoscroll and the long presses never see the middle button. A link keeps it
// (a new background tab). Shown on the release: a disabled button gets pointer events but no
// auxclick, and a dialog opened by the press would see the release as a click on its backdrop.
function middle(event: MouseEvent): void {
  const target = event.target as Element;
  if (event.button !== 1 || target.closest?.("a[href]")) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.type !== "pointerup" || dialog.contains(target)) return;
  const name = target.closest?.<HTMLElement>("[data-help]")?.dataset.help;
  if (name) showItem(name);
}
const TYPES = ["pointerdown", "mousedown", "pointerup", "mouseup", "auxclick"];
for (const type of TYPES) window.addEventListener(type, middle as EventListener, true);
// A hot update runs this module again: the old listeners and dialog go first.
import.meta.hot?.dispose(() => {
  for (const type of TYPES) window.removeEventListener(type, middle as EventListener, true);
  dialog.remove();
});
