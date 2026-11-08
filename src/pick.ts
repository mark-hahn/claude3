// claude2's list selection over the trashed cards on show: a click picks just that card, ctrl-click
// toggles it, shift-click adds the run from the anchor to what is already picked. Returns the anchor.
export function pick(picked: Set<string>, ids: string[], id: string, anchor: string, keys: { ctrlKey: boolean; shiftKey: boolean }): string {
  if (keys.shiftKey && ids.includes(anchor)) {
    const from = ids.indexOf(anchor);
    const to = ids.indexOf(id);
    for (const run of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) picked.add(run);
    return anchor;
  }
  if (!keys.ctrlKey) picked.clear();
  if (picked.has(id)) picked.delete(id);
  else picked.add(id);
  return id;
}
