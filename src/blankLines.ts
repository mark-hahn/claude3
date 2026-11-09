// The Snips' tidy-up after text is removed from them. Lines count from 1, as in Monaco. Given the
// lines the text was removed from, answers which lines to delete so the blank lines at or right
// beside each come down to one. Blank lines elsewhere are left alone.
export function extraBlankLines(lineCount: number, blank: (line: number) => boolean, removedAt: number[]): number[] {
  const extras = new Set<number>();
  for (const at of removedAt) {
    let first = at;
    let last = at;
    while (first > 1 && blank(first - 1)) first--;
    while (last < lineCount && blank(last + 1)) last++;
    for (let line = first + 1; line <= last; line++) {
      if (blank(line) && blank(line - 1)) extras.add(line);
    }
  }
  return [...extras];
}

// Enter at the end of a heading, a line whose first non-white char is #, or whose # has only a "- "
// before it: what replaces the line up to the caret. Everything left of the # comes off, a blank
// line goes above, unless the line above is one already or there is none, and a new item starts
// below at the left edge. Null when the caret isn't at the end of a heading.
export function headingEnter(before: string, rest: string, above: string): string | null {
  if (!/^\s*(- +)?#/.test(before) || rest.trim()) return null;
  return (above.trim() ? "\n" : "") + before.slice(before.indexOf("#")) + "\n- ";
}
