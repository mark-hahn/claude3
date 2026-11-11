<script setup lang="ts">
// claude2's Snips tab, a column right of the conversation pane, the window's full height below the
// tab strip. One text, kept on the stats server (claude-stats, the backend's `snips` action), so
// every tab on every host edits the same copy. Read when it opens and whenever the window gets focus back; saved half a
// second after the typing stops, and at once on close. Esc closes it; Ctrl+Enter moves the selected text
// to the end of the prompt and the cursor there (an empty prompt sends it at once), takes the blank lines around the removed text
// down to one and closes the Snips; with nothing selected it types two bare newlines, no margin or dash. A Monaco editor with
// claude2's editing (src/monaco.ts).
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Tab } from "../../shared/config.ts";
import { post } from "../api.ts";
import { extraBlankLines } from "../blankLines.ts";
import { addLineDots, addListKeys, addWheelZoom, applyWheelZoom, editorOptions, monaco, typeEdits, untab } from "../monaco.ts";

// addToPrompt answers whether the prompt took the text: a trashed session's doesn't.
const props = defineProps<{ tab: Tab; shown: boolean; addToPrompt: (text: string) => boolean }>();
const emit = defineEmits<{ close: [] }>();

const FONT_KEY = "claude3.snipsFontSize";
// Editable only once the shared copy has been read, so nothing typed early can replace it.
let ready = false;
// Why it can't be read or saved; empty while all is well.
const note = ref("");
const host = ref<HTMLElement>();
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
const text = (): string => editor?.getValue() ?? "";
// Typing since a read started makes its answer stale.
let edits = 0;
let saveTimer = 0;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function load(): Promise<void> {
  if (saveTimer || !props.shown) return;
  const asked = edits;
  try {
    const reply = await post<{ text: string }>(props.tab, "snips", {});
    if (asked !== edits || saveTimer) return;
    // \n line ends only, so the comparison holds whatever line ends were saved.
    const next = untab(reply.text.replace(/\r\n?/g, "\n"));
    note.value = "";
    if (!ready) {
      ready = true;
      editor?.updateOptions({ readOnly: false });
    }
    if (!editor || next === text()) return;
    const view = editor.saveViewState();
    editor.setValue(next);
    editor.restoreViewState(view);
  } catch (error) {
    note.value = `The Snips couldn't be read: ${messageOf(error)}`;
  }
}

function save(): void {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  post(props.tab, "snips", { text: text() }).then(
    () => (note.value = ""),
    (error) => (note.value = `Not saved: ${messageOf(error)}`),
  );
}

function typed(): void {
  edits++;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, 500);
}

// Closing only hides the column, so the cursor, selections and undo last until the page reloads.
// Hidden it is 0x0 and every line rewraps, so the scroll position is put back by hand. Another tab's
// Snips may have changed the text or the size meanwhile, so it is read-only again until the text has
// been read, as it is when first opened.
let closedView: monaco.editor.ICodeEditorViewState | null = null;
watch(() => props.shown, async (shown) => {
  const ed = editor!;
  if (!shown) {
    closedView = ed.saveViewState();
    if (saveTimer) save();
    return;
  }
  ready = false;
  ed.updateOptions({ readOnly: true });
  // v-show undoes display:none after post watchers like this one, and until then the editor can't take focus or be measured.
  await nextTick();
  applyWheelZoom(ed, FONT_KEY);
  ed.layout();
  ed.restoreViewState(closedView);
  ed.focus();
  void load();
}, { flush: "post" });

onMounted(() => {
  editor = monaco.editor.create(host.value!, { ...editorOptions, readOnly: true, readOnlyMessage: { value: "The Snips can't be edited until the saved copy has been read." } });
  addLineDots(editor);
  addListKeys(editor);
  addWheelZoom(editor, FONT_KEY);
  // A load's setValue is an edit too, but not typing: only user edits count and get saved.
  editor.onDidChangeModelContent((event) => !event.isFlush && typed());
  // Esc is left to Monaco while it has something of its own up to close.
  editor.addAction({ id: "claude3.closeSnips", label: "Close Snips", keybindings: [monaco.KeyCode.Escape], keybindingContext: "editorTextFocus && !findWidgetVisible && !suggestWidgetVisible && !editorHasMultipleSelections && !inSnippetMode", run: () => emit("close") });
  editor.addAction({
    id: "claude3.insertSnip",
    label: "Add Selection to Prompt",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
    run: (ed) => {
      const model = ed.getModel()!;
      const picked = ed.getSelections()!.filter((s) => !s.isEmpty());
      // No selection: two bare newlines at each caret (a blank line between), no margin and no dash (unlike enterLines).
      if (!picked.length) return typeEdits(ed, ed.getSelections()!.map((range) => ({ range, text: "\n\n" })));
      const added = props.addToPrompt(picked.map((s) => model.getValueInRange(s)).join("\n"));
      console.log("snips ctrl+enter: prompt took the text:", added);
      if (!added) return;
      let removedAt: number[] = [];
      // The inverse edits' ranges say where the text was, in the text as it is after the removal.
      ed.executeEdits("claude3", picked.map((range) => ({ range, text: null })), (inverse) => {
        removedAt = inverse.map((edit) => edit.range.startLineNumber);
        return null;
      });
      const blank = (line: number): boolean => !model.getLineContent(line).trim();
      ed.executeEdits("claude3", extraBlankLines(model.getLineCount(), blank, removedAt).map((line) => ({ range: new monaco.Range(line - 1, 1, line, 1), text: null })));
      console.log("snips ctrl+enter: removed at lines", removedAt, "- closing");
      emit("close");
    },
  });
  editor.focus();
  void load();
  window.addEventListener("focus", load);
});
onBeforeUnmount(() => {
  console.log("snips closing: column is unmounting");
  window.removeEventListener("focus", load);
  if (saveTimer) save();
  editor?.dispose();
});
</script>

<template>
  <div v-show="shown" class="snips">
    <div v-if="note" class="snips-note">{{ note }}</div>
    <div class="snips-text"><div ref="host"></div></div>
  </div>
</template>

<style scoped>
.snips { min-height: 0; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; background: var(--page); }
.snips-note { background: #fbd9d9; border: 1px solid #e4a7a7; border-radius: 8px; padding: 4px 8px; }
.snips-text { position: relative; flex: 1; min-height: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.snips-text:focus-within { outline: 2px solid var(--ink); outline-offset: -1px; border-color: transparent; }
/* Inset just past the rounded corners, so the editor's square ones stay inside the border. */
.snips-text > div { position: absolute; inset: 3px; }
</style>
