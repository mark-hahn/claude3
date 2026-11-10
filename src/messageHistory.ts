// The commit message box's history, a port of VS Code's Source Control input (SCMInput on a
// HistoryNavigator2), except that the old messages come from the branch's log rather than VS Code's
// own store. Oldest first, no repeats. The last entry is the slot for the text being typed, which
// waits there while older messages are on show.
const CAPACITY = 100;

export class MessageHistory {
  private list = [""];
  private cursor = 0;

  // The log's messages, newest first, replace all but the slot. The one on show stays on show.
  fill(log: string[]): void {
    const slot = this.list[this.list.length - 1];
    const shown = this.list[this.cursor];
    this.list = [...[...new Set(log)].reverse().filter((old) => old !== slot), slot].slice(-CAPACITY);
    const at = this.list.indexOf(shown);
    this.cursor = at < 0 ? this.list.length - 1 : at;
  }

  private atEnd(): boolean {
    return this.cursor === this.list.length - 1;
  }

  // Into the slot. An edited older message lands here too, replacing what was waiting, as in VS Code.
  private keep(text: string): void {
    this.list = [...this.list.slice(0, -1).filter((old) => old !== text), text];
    this.cursor = this.list.length - 1;
  }

  // The message before the one on show; `text` is what the box holds now.
  previous(text: string): string {
    if (this.atEnd() || !this.list.includes(text)) this.keep(text);
    this.cursor = Math.max(this.cursor - 1, 0);
    return this.list[this.cursor];
  }

  // The message after the one on show, or undefined when the slot is already on show.
  next(text: string): string | undefined {
    if (this.atEnd()) return undefined;
    if (!this.list.includes(text)) this.keep(text);
    this.cursor = Math.min(this.cursor + 1, this.list.length - 1);
    return this.list[this.cursor];
  }

  // Text put in the box by a command (a commit's "", a generated message): what it replaces stays.
  replace(text: string, replacement: string): void {
    this.keep(text);
    this.list = [...this.list.filter((old) => old !== replacement), replacement].slice(-CAPACITY);
    this.cursor = this.list.length - 1;
  }
}
