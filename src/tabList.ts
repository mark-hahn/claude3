// The rules for the list of projects: their order, their default names, and what shows next.
import type { Tab } from "../shared/config.ts";

// Case doesn't count, so "tv" and "TV" are the same name and "Zed" sorts after "alpha".
export const sameName = (a: string, b: string): boolean => a.localeCompare(b, undefined, { sensitivity: "base" }) === 0;
export const byName = (a: Tab, b: Tab): number => a.label.localeCompare(b.label, undefined, { sensitivity: "base" });

// A path's last folder, as the path writes it, on either OS's paths.
export const folderName = (path: string): string => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";

// The id of the tab to show when the one on show (gone, if known) closed or was deleted: the next
// open one by name, or the last when it was the last. "" with none open.
export function nextTab(sorted: Tab[], gone: Tab | undefined): string {
  const open = sorted.filter((tab) => tab.open);
  return (gone ? open.find((tab) => byName(tab, gone) > 0) ?? open.at(-1) : open[0])?.id ?? "";
}
