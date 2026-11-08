// claude2's Monaco setup (its webviews.ts monacoScript / monacoStyle), shared by the prompt box and
// the Snips: the worker, the theme, the user's editing keys, the editor options, the gutter's line
// dots, the list keys (Tab, Shift-Tab, Enter, Backspace, #), and the untabbing of text that arrives.
// Every editor feature, but only the markdown language.
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/features/register.all";
import "monaco-editor/editor/browser/coreCommands";
import "monaco-editor/languages/definitions/markdown/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "./monaco.css";

export { monaco };
type Editor = monaco.editor.IStandaloneCodeEditor;

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
const themeColors = { "editor.background": "#fcfcfb", foreground: "#000000", descriptionForeground: "#000000", "input.placeholderForeground": "#000000", "keybindingLabel.foreground": "#000000" };
// Black wherever the stock light theme greys text: html delimiters, widget text, placeholders.
monaco.editor.defineTheme("claude2", { base: "vs", inherit: true, rules: [{ token: "delimiter.html", foreground: "000000" }], colors: themeColors });
// The user's own VS Code editing keys. Ctrl-D is otherwise Monaco's add-next-match, and
// shift-alt-left/right its smart select.
const { KeyMod, KeyCode } = monaco;
const writable = "textInputFocus && !editorReadonly";
monaco.editor.addKeybindingRules([
  { keybinding: KeyMod.CtrlCmd | KeyCode.KeyD, command: "editor.action.deleteLines", when: writable },
  { keybinding: KeyMod.CtrlCmd | KeyCode.KeyJ, command: "editor.action.joinLines", when: writable },
  { keybinding: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyD, command: "editor.action.duplicateSelection", when: writable },
  { keybinding: KeyMod.CtrlCmd | KeyMod.Shift | KeyMod.Alt | KeyCode.KeyU, command: "editor.action.transformToUppercase", when: writable },
  { keybinding: KeyMod.CtrlCmd | KeyMod.Shift | KeyMod.Alt | KeyCode.KeyL, command: "editor.action.transformToLowercase", when: writable },
  { keybinding: KeyMod.Shift | KeyMod.Alt | KeyCode.LeftArrow, command: "cursorUndo", when: "textInputFocus" },
  { keybinding: KeyMod.Shift | KeyMod.Alt | KeyCode.RightArrow, command: "cursorRedo", when: "textInputFocus" },
]);

export const editorOptions: monaco.editor.IStandaloneEditorConstructionOptions = {
  language: "markdown",
  theme: "claude2",
  automaticLayout: true,
  wordWrap: "on",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 14,
  lineHeight: 1.5,
  tabSize: 2,
  // Ctrl-click adds and removes cursors (Monaco's default is alt), so alt-click follows links.
  multiCursorModifier: "ctrlCmd",
  // With the frame's 3px inset and 1px border: a small gap on top and below.
  padding: { top: 7, bottom: 3 },
  // Room for the line dot and a clear gap after it before the text.
  lineDecorationsWidth: 14,
  lineNumbers: "off",
  glyphMargin: false,
  folding: false,
  minimap: { enabled: false },
  // On by default: it pins the line that opens the indent block being scrolled through.
  stickyScroll: { enabled: false },
  overviewRulerLanes: 0,
  scrollBeyondLastLine: false,
  // Popups may overhang the box's frame instead of being clipped by it.
  fixedOverflowWidgets: true,
  // VS Code's own markdown defaults: no completion popups while typing, no boxes on curly quotes.
  quickSuggestions: false,
  unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
  // The textarea input path, as claude2 has it.
  editContext: false,
};

// A dot in the gutter on the first row of each real line, so a wrapped line reads as one.
// Clicking a dot selects that line with its line break, like a line number in VS Code, and
// dragging from it selects every line passed over. Shift-click extends from the line the dots
// last started on, or from the selection's fixed end if something else has moved it since.
// Monaco leaves gutter clicks alone and keeps focus where it was, so the editor takes it here.
export function addLineDots(editor: Editor): void {
  const model = editor.getModel()!;
  const dots = editor.createDecorationsCollection();
  const show = (): void => {
    dots.set(Array.from({ length: model.getLineCount() }, (_, i) => ({
      range: new monaco.Range(i + 1, 1, i + 1, 1),
      options: { isWholeLine: true, firstLineDecorationClassName: "line-dot" },
    })));
  };
  model.onDidChangeContent(show);
  show();
  let anchor = 0;
  let anchored: monaco.Selection | null = null;
  const selectLines = (from: number, to: number): void => {
    const top = Math.min(from, to), bottom = Math.max(from, to);
    editor.setSelection(bottom < model.getLineCount() ? new monaco.Range(top, 1, bottom + 1, 1) : new monaco.Range(top, 1, bottom, model.getLineMaxColumn(bottom)));
    anchor = from;
    anchored = editor.getSelection();
  };
  // The line the drag started on and the pointer's height, while the button is down. Past the
  // box's top or bottom edge it scrolls, faster the further out the pointer is, and the line
  // taken is the one at that edge. Half a line in from the edge clears the padding.
  let dragFrom = 0, dragY = 0;
  const drag = (): void => {
    if (!dragFrom) return;
    const rect = editor.getDomNode()!.getBoundingClientRect();
    const past = dragY < rect.top ? dragY - rect.top : dragY > rect.bottom ? dragY - rect.bottom : 0;
    if (past) editor.setScrollTop(editor.getScrollTop() + past / 4);
    const inset = editor.getOption(monaco.editor.EditorOption.lineHeight) / 2;
    const target = editor.getTargetAtClientPoint(rect.left + rect.width / 2, Math.min(Math.max(dragY, rect.top + inset), rect.bottom - inset));
    if (target?.position) selectLines(dragFrom, target.position.lineNumber);
    requestAnimationFrame(drag);
  };
  editor.onMouseDown((event) => {
    if (!event.target.element?.closest(".line-dot") || !event.target.position) return;
    const line = event.target.position.lineNumber, selection = editor.getSelection()!;
    dragFrom = !event.event.shiftKey ? line : anchored && selection.equalsSelection(anchored) ? anchor : selection.selectionStartLineNumber;
    dragY = event.event.browserEvent.clientY;
    selectLines(dragFrom, line);
    editor.focus();
    requestAnimationFrame(drag);
  });
  window.addEventListener("pointermove", (event) => (dragY = event.clientY));
  window.addEventListener("pointerup", () => (dragFrom = 0));
}

// No tab char ever goes in the box: Tab itself makes list items, and text arriving with tabs
// (a paste, a draft, the Snips) has each one turned into two spaces.
export const untab = (text: string): string => text.replace(/\t/g, "  ");

// Tab makes list items (tabLines) instead of inserting anything, Shift-Tab steps them back the
// same way, Enter starts the next one (enterLines), Backspace takes a dash back off
// (backspaceDashes) and # turns an empty one into a heading (typeHash). Tab, Shift-Tab and Enter
// are left to Monaco while a completion list or a snippet is up, where they mean something else,
// and Enter on a read-only box, which answers with its message. Pasted text loses its tab chars,
// through Monaco's own paste so it stays one undo step; the find box's own pastes and a read-only
// editor's are left alone. Capture phase, so Monaco never sees the paste.
export function addListKeys(editor: Editor): void {
  const free = "editorTextFocus && !suggestWidgetVisible && !inSnippetMode";
  editor.addAction({ id: "claude2.tabLines", label: "Make List Items", keybindings: [KeyCode.Tab], keybindingContext: free, run: () => tabLines(editor, tabLine) });
  editor.addAction({ id: "claude2.untabLines", label: "Step List Items Back", keybindings: [KeyMod.Shift | KeyCode.Tab], keybindingContext: free, run: () => tabLines(editor, untabLine) });
  editor.addAction({ id: "claude2.enterLines", label: "Next List Item", keybindings: [KeyCode.Enter], keybindingContext: free + " && !editorReadonly", run: () => enterLines(editor) });
  editor.onKeyDown((event) => {
    if (!(event.equals(KeyCode.Backspace) ? backspaceDashes(editor) : event.browserEvent.key === "#" && typeHash(editor))) return;
    event.preventDefault();
    event.stopPropagation();
  });
  editor.getContainerDomNode().addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!editor.hasTextFocus() || editor.getOption(monaco.editor.EditorOption.readOnly) || !text.includes("\t")) return;
    event.preventDefault();
    event.stopPropagation();
    editor.trigger("keyboard", "paste", { text: untab(text) });
  }, true);
}

interface LineStart { old: number; prefix: string }

// Tab on each line a caret or selection touches: a line with no dash becomes a "- " item at the
// left edge, and an item's margin steps right to the next even count (an odd one by 1, an even
// one by 2), exactly one space after the dash either way. A run of lines leaves its blank ones
// alone; a lone blank line becomes an empty item at its own margin. Shift-Tab comes through here
// too, with untabLine for what each line gets.
function tabLines(editor: Editor, startOf: (line: string) => LineStart): void {
  const model = editor.getModel()!;
  const lines = new Set<number>();
  for (const s of editor.getSelections()!) {
    // A selection ending at the very start of a line does not take that line in.
    const last = s.endLineNumber > s.startLineNumber && s.endColumn === 1 ? s.endLineNumber - 1 : s.endLineNumber;
    for (let n = s.startLineNumber; n <= last; n++) lines.add(n);
  }
  const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
  const tabbed = new Map<number, LineStart>();
  for (const n of lines) {
    const line = model.getLineContent(n);
    if (lines.size > 1 && !line.trim()) continue;
    const start = startOf(line);
    edits.push({ range: new monaco.Range(n, 1, n, start.old + 1), text: start.prefix });
    tabbed.set(n, start);
  }
  // A caret keeps its place in its line's text; one that was in the margin or on the dash
  // lands at the start of the text.
  const move = (n: number, col: number): number => {
    const start = tabbed.get(n);
    return !start ? col : col > start.old ? col + start.prefix.length - start.old : start.prefix.length + 1;
  };
  const selections = editor.getSelections()!.map((s) => new monaco.Selection(
    s.selectionStartLineNumber, move(s.selectionStartLineNumber, s.selectionStartColumn), s.positionLineNumber, move(s.positionLineNumber, s.positionColumn)));
  editor.pushUndoStop();
  editor.executeEdits("claude2", edits, selections);
  editor.pushUndoStop();
}

// What Tab puts at the start of a line: prefix replaces the line's first old chars, its margin and
// any dash with the spaces after it. Text with no dash takes one at the left edge, while a blank
// line stays at its margin.
function tabLine(line: string): LineStart {
  const margin = line.match(/^ */)![0].length;
  const dash = line.slice(margin).match(/^- */);
  if (!dash) return { old: margin, prefix: " ".repeat(margin === line.length ? margin : 0) + "- " };
  return { old: margin + dash[0].length, prefix: " ".repeat(margin + 2 - (margin % 2)) + "- " };
}

// Shift-Tab's prefix and old, the inverse of tabLine: an item at the left edge loses its dash, and
// any other margin steps left to the next even count, keeping the dash.
function untabLine(line: string): LineStart {
  const dash = line.match(/^- +/);
  if (dash) return { old: dash[0].length, prefix: "" };
  const margin = line.match(/^ */)![0].length;
  return { old: margin, prefix: " ".repeat(Math.max(margin - 2 + (margin % 2), 0)) };
}

// Enter at each caret, with the spaces after the caret dropped so the text it takes along keeps
// exactly one after the dash.
function enterLines(editor: Editor): void {
  const model = editor.getModel()!;
  const edits = editor.getSelections()!.map((s) => {
    const rest = model.getLineContent(s.endLineNumber).slice(s.endColumn - 1);
    const spaces = rest.match(/^ */)![0].length;
    return { range: new monaco.Range(s.startLineNumber, s.startColumn, s.endLineNumber, s.endColumn + spaces), text: "\n" + enterStart(model.getLineContent(s.startLineNumber), rest.slice(spaces)) };
  });
  typeEdits(editor, edits);
}

// One undo step, each caret landing after its new text. Unlike Monaco's own typing, an edit
// doesn't scroll to the caret.
function typeEdits(editor: Editor, edits: monaco.editor.IIdentifiedSingleEditOperation[]): void {
  editor.pushUndoStop();
  editor.executeEdits("claude2", edits, (undo) => undo.map(({ range }) => monaco.Selection.fromPositions(monaco.Range.lift(range).getEndPosition())));
  editor.pushUndoStop();
  editor.revealPosition(editor.getPosition()!);
}

// What Enter starts the new line with, given the line it leaves and the text it takes along: that
// line's margin, and a dash if that line is an item or a heading, unless the text is already one itself.
function enterStart(line: string, rest: string): string {
  const dash = /^ *(- |#+ )/.test(line) && !/^(-( |$)|#+ )/.test(rest);
  return line.match(/^ */)![0] + (dash ? "- " : "");
}

// Backspace right after a line's "- " takes both chars, for the odd line that isn't a list item:
// the inverse of Tab on a blank line. False, leaving the key to Monaco, unless every caret is there.
function backspaceDashes(editor: Editor): boolean {
  const model = editor.getModel()!;
  const carets = editor.getSelections()!;
  const afterDash = (s: monaco.Selection): boolean => s.isEmpty() && /^ *- $/.test(model.getLineContent(s.startLineNumber).slice(0, s.startColumn - 1));
  if (editor.getOption(monaco.editor.EditorOption.readOnly) || !carets.every(afterDash)) return false;
  editor.pushUndoStop();
  editor.executeEdits("claude2", carets.map((s) => ({ range: new monaco.Range(s.startLineNumber, s.startColumn - 2, s.startLineNumber, s.startColumn), text: null })));
  editor.pushUndoStop();
  return true;
}

// Typing # where hashStart has something else for it to do. False, leaving the key to Monaco,
// unless every caret is at such a place.
function typeHash(editor: Editor): boolean {
  const model = editor.getModel()!;
  const carets = editor.getSelections()!;
  const above = (n: number): string => (n > 1 ? model.getLineContent(n - 1) : "");
  const starts = carets.map((s) => (s.isEmpty() ? hashStart(model.getLineContent(s.startLineNumber), s.startColumn, above(s.startLineNumber)) : null));
  if (editor.getOption(monaco.editor.EditorOption.readOnly) || starts.includes(null)) return false;
  typeEdits(editor, carets.map((s, i) => ({ range: new monaco.Range(s.startLineNumber, s.startColumn - starts[i]!.old, s.startLineNumber, s.startColumn), text: starts[i]!.text })));
  return true;
}

// What # typed at column does: text replaces the old chars before the caret. Right after a "# " it
// joins that hash, the space staying behind it. At the end of an empty item it makes "# " at the
// left edge, with a blank line before it unless the line above is one already or there is none.
// Null anywhere else.
function hashStart(line: string, column: number, above: string): { old: number; text: string } | null {
  const before = line.slice(0, column - 1);
  if (before.endsWith("# ")) return { old: 1, text: "# " };
  if (!/^ *- $/.test(line) || column <= line.length) return null;
  return { old: before.length, text: (above.trim() ? "\n" : "") + "# " };
}
