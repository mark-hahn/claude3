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
