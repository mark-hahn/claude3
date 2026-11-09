// Every alt-click's copy: the text to the clipboard and a light-red flash on what was clicked.
export function copy(text: string, el: HTMLElement): void {
  void navigator.clipboard.writeText(text);
  void el.animate([{ backgroundColor: "#ffc9c9" }, { backgroundColor: "#ffc9c9" }], 200);
}

// Alt-click in a fenced code block copies just that block. For a capture-phase click listener on
// whatever holds rendered markdown, so it wins over every other alt-click (a box's whole-text copy included).
export function copyCodeBlock(event: MouseEvent): void {
  const block = event.altKey ? (event.target as HTMLElement).closest("pre") : null;
  if (!block) return;
  event.stopPropagation();
  event.preventDefault();
  copy(block.textContent ?? "", block);
}
