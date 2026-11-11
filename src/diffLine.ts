// For the Git popup's diff: where a line of the old file is in the new one, so a click on an old
// line number can open the file there.

// One changed stretch, as Monaco's ILineChange has it: an end of 0 means that side has no lines
// in the stretch, its start then being the line the other side's lines sit after.
export interface LineChange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

// An untouched line's own counterpart, a rewritten line's place in what replaced it (the last of
// those lines when there are fewer), and for a removed line the line it was removed after.
export function modifiedLine(changes: LineChange[], original: number): number {
  let shift = 0;
  for (const { originalStartLineNumber: from, originalEndLineNumber: to, modifiedStartLineNumber: start, modifiedEndLineNumber: end } of changes) {
    // Lines added after `from`, none taken out.
    if (!to) {
      if (original <= from) break;
      shift = end - from;
      continue;
    }
    if (original < from) break;
    if (original <= to) return end ? Math.min(start + original - from, end) : Math.max(start, 1);
    shift = (end || start) - to;
  }
  return original + shift;
}
