// Every alt-click's copy: the text to the clipboard and a light-red flash on what was clicked.
export function copy(text: string, el: HTMLElement): void {
  void navigator.clipboard.writeText(text);
  void el.animate([{ backgroundColor: "#ffc9c9" }, { backgroundColor: "#ffc9c9" }], 200);
}
