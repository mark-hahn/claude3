// The Term pane's search: the last place the text is in the buffer, case ignored, with wrapped rows
// read as one line. Given `before` (the cell the last hit starts at), the last one ending at or
// before it. Answered as xterm's select() takes it.
// ponytail: a string index is taken as a column, so on a line with double-width characters (CJK,
// emoji) a hit to their right is selected one cell left per such character; map through getCell if that matters.
export interface FindBuffer {
  length: number;
  getLine(y: number): { isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined;
}

export function findBack(buffer: FindBuffer, cols: number, text: string, before?: { x: number; y: number }): { col: number; row: number; length: number } | null {
  const want = text.toLowerCase();
  let last = before ? Math.min(before.y, buffer.length - 1) : buffer.length - 1;
  // The latest column of row `last` a hit may start at.
  let limit = before ? before.x - want.length : Infinity;
  while (want && last >= 0) {
    let first = last;
    let line = buffer.getLine(last)?.translateToString(true) ?? "";
    while (first > 0 && buffer.getLine(first)?.isWrapped) line = (buffer.getLine(--first)?.translateToString(false) ?? "") + line;
    const from = (last - first) * cols + limit;
    const index = from < 0 ? -1 : line.toLowerCase().lastIndexOf(want, from);
    if (index >= 0) return { col: index % cols, row: first + Math.floor(index / cols), length: want.length };
    last = first - 1;
    limit = Infinity;
  }
  return null;
}

// What the Term pane shows in brown as a timestamp: month-day or year-month (2 or 4 digits, then 2, by - or /),
// perhaps after a year, then a space or T and hh:mm, perhaps :ss and a fraction. Or a month by name, capitalised,
// whole or in three letters (Sept too), and its day, perhaps a year (after a comma or not), perhaps that time.
// Any number of spaces between the parts (ls pads `Nov  7 16:37`). A word's letters or digits don't start one.
const TIME = String.raw`\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?`;
const MONTH = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
export const STAMP = new RegExp(String.raw`\b(?:(?:\d{4}[-/])?(?:\d{4}|\d{2})[-/]\d{2}(?: +|T)${TIME}|(?:${MONTH}) +\d{1,2}(?:,? +\d{4})?(?: +${TIME})?)\b`, "g");
