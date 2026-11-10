// The page's tooltips, ported from claude2's tooltipScript: a native `title` bubble renders at a
// fixed OS size that no stylesheet can reach. A host's title moves to data-tip while the mouse is
// on it, which keeps the native bubble away, and back when the mouse leaves (Vue can change or
// drop a title between hovers, so no copy outlives the hover). A popover, not a z-index: only the
// top layer shows above a modal <dialog>.
const DELAY = 750;
const EDGE = 6;

const tip = document.createElement("div");
tip.id = "tip";
tip.popover = "manual";
document.body.append(tip);

let host: HTMLElement | null = null;
let timer = 0;
let mouseX = 0;

const tipUp = () => tip.matches(":popover-open");

// The title stays moved aside: after a click or a key the bubble is gone until the mouse leaves.
function hide() {
  clearTimeout(timer);
  if (tipUp()) tip.hidePopover();
}

function release() {
  hide();
  if (!host) return;
  // A title already back is a newer one Vue set during the hover.
  if (!host.hasAttribute("title")) host.setAttribute("title", host.dataset.tip!);
  delete host.dataset.tip;
  host = null;
}

// Anchored to the host's box, not the cursor: a bubble that flips upward for room would land on
// the host. A transform, since left and top would change the width it has to wrap in.
function place(node: HTMLElement) {
  if (!tipUp()) tip.showPopover();
  const box = tip.getBoundingClientRect();
  const anchor = node.getBoundingClientRect();
  let left = mouseX + 4;
  let top = anchor.bottom + EDGE;
  if (left + box.width > innerWidth - EDGE) left = Math.max(EDGE, innerWidth - EDGE - box.width);
  if (top + box.height > innerHeight - EDGE) top = Math.max(EDGE, anchor.top - EDGE - box.height);
  tip.style.transform = `translate(${left}px, ${top}px)`;
}

document.addEventListener("mouseover", (event) => {
  const node = event.target instanceof Element ? event.target.closest<HTMLElement>("[title], [data-tip]") : null;
  // Moving between a host's own children.
  if (node && node === host) return;
  release();
  const text = node?.getAttribute("title");
  if (!node || !text) return;
  node.dataset.tip = text;
  node.removeAttribute("title");
  host = node;
  mouseX = event.clientX;
  timer = window.setTimeout(() => {
    if (!node.isConnected) return;
    tip.textContent = text;
    place(node);
  }, DELAY);
});

document.addEventListener("mouseout", (event) => {
  if (!event.relatedTarget) release();
});
document.addEventListener("mousedown", hide, true);
document.addEventListener("keydown", hide, true);
window.addEventListener("blur", hide);
// A scroll under the cursor doesn't drop the tip, but it has to follow its host's box.
window.addEventListener("scroll", () => {
  if (!host || !tipUp()) return;
  if (host.isConnected) place(host);
  else hide();
}, true);
