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

// Ctrl-J's join (VS Code's Join Lines): each line after the first loses its leading white space,
// the text before it its trailing white space, and one space goes between unless either side is
// empty. The column, counting from 1, is the last join's: left of its space.
export function joinLines(lines: string[]): { text: string; column: number } {
  let text = lines[0];
  let column = text.length + 1;
  for (const line of lines.slice(1)) {
    const next = line.trimStart();
    text = text.trimEnd();
    column = text.length + 1;
    text += text && next ? " " + next : next;
  }
  return { text, column };
}
