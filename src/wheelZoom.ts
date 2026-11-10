// Ctrl-wheel sizes a pane's text, for panes that aren't a Monaco editor (monaco.ts has addWheelZoom
// for those): the returned handler goes on the pane. As there, the size is remembered and has no
// limits of ours (CLAUDE.md's one exception to 14-18px, at the user's asking) beyond staying visible.
// It lives in the CSS variable --<name> on the root, like --sidebar-width, so the pane in every tab
// follows at once.
export function wheelZoom(name: string): (event: WheelEvent) => void {
  const key = `claude3.${name}`;
  const read = (): number => Number(localStorage.getItem(key)) || 14;
  const show = (size: number): void => document.documentElement.style.setProperty(`--${name}`, `${size}px`);
  show(read());
  return (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const size = Math.max(1, read() + (event.deltaY < 0 ? 1 : -1));
    show(size);
    localStorage.setItem(key, String(size));
  };
}
