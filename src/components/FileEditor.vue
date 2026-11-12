<script setup lang="ts">
// The Files pane's file mode: one file on its host (the tree's) in a stock Monaco editor, of the prompt
// box's and Snips' custom keys only Ctrl-D, coloured by the language its name or #! line implies, wrapped, their line dots in place of line numbers (but numbers, and that line centered, for a file opened at a line from the Git popup's diff), no minimap. Live as Snips are: saved half a second after the
// typing stops and at once on close, and read again when the file changes on disk. A save is
// refused if the file changed since it was read, and then nothing more is saved until Reload.
// With the file's last line in view it is in tail mode, shown by the header's path going yellow:
// changes arrive as they happen and the view stays at the bottom.
// ponytail: out of tail mode asks every 2s, not a file watch; change it if that lag ever matters.
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { HostName } from "../../shared/config.ts";
import { postHost } from "../api.ts";
import { addLineDots, addWheelZoom, monaco } from "../monaco.ts";

const props = defineProps<{ active: boolean; file: { host: HostName; path: string; text: string; mtime: number; line?: number } }>();

const note = ref("");
const refused = ref(false);
const host = ref<HTMLElement>();
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let mtime = props.file.mtime;
// Typing since a read started makes its answer stale.
let edits = 0;
let dirty = false;
let saving = false;
let saveTimer = 0;
let poller = 0;
const tail = ref(false);
// While text from disk goes in, whose scrolling isn't the user's.
let settingText = false;
let following = false;
// One save at a time: each needs the mtime the one before it left.
let saves: Promise<void> = Promise.resolve();

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function saveNow(text: string): Promise<void> {
  if (!dirty || refused.value) return;
  dirty = false;
  saving = true;
  try {
    const reply = await postHost<{ mtime?: number; conflict?: boolean }>(props.file.host, "saveFile", { path: props.file.path, text, mtime });
    if (reply.conflict) {
      dirty = true;
      refused.value = true;
      note.value = "Not saved: the file changed on disk after it was read here. Reload takes the version on disk.";
    } else {
      mtime = reply.mtime!;
      note.value = "";
    }
  } catch (error) {
    dirty = true;
    note.value = `Not saved: ${messageOf(error)}`;
  }
  saving = false;
}

function flush(text = editor!.getValue()): void {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  saves = saves.then(() => saveNow(text));
}

function typed(): void {
  edits++;
  dirty = true;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flush, 500);
}

function show(reply: { mtime: number; text?: string | null }): void {
  mtime = reply.mtime;
  if (reply.text === null) {
    note.value = "This file can no longer be edited here.";
  } else if (reply.text !== undefined && editor && reply.text !== editor.getValue()) {
    const view = editor.saveViewState();
    settingText = true;
    editor.setValue(reply.text);
    editor.restoreViewState(view);
    if (tail.value) editor.setScrollTop(editor.getContentHeight() - editor.getLayoutInfo().height);
    settingText = false;
  }
}

// True when the backend answered; false when nothing was asked or it failed.
async function poll(action = "readFile"): Promise<boolean> {
  if (!editor || document.hidden || !props.active || saveTimer || saving || refused.value) return false;
  if (dirty) {
    // A save that failed is tried again.
    flush();
    return false;
  }
  const asked = edits;
  try {
    const reply = await postHost<{ mtime: number; text?: string | null }>(props.file.host, action, { path: props.file.path, known: mtime });
    if (asked === edits && !saving && !refused.value) {
      note.value = "";
      show(reply);
    }
    return true;
  } catch (error) {
    note.value = messageOf(error);
    return false;
  }
}

// Tail mode: each wait the backend answers is followed at once by the next. Whatever makes poll
// say false (typing, a hidden page, a failure) ends this, and the 2s tick starts it again.
async function follow(): Promise<void> {
  if (following) return;
  following = true;
  while (tail.value && (await poll("waitFile")));
  following = false;
}

// With scrollBeyondLastLine off, the scrollbar's end, and exactly where a change puts the view.
const atBottom =(): boolean => editor!.getScrollTop() + editor!.getLayoutInfo().height >= editor!.getContentHeight() - 2;

async function reload(): Promise<void> {
  try {
    const reply = await postHost<{ mtime: number; text?: string | null }>(props.file.host, "readFile", { path: props.file.path });
    refused.value = false;
    dirty = false;
    note.value = "";
    show(reply);
  } catch (error) {
    note.value = messageOf(error);
  }
}

onMounted(() => {
  // Monaco picks the language from the model's name and first line. The query keeps two editors
  // of one file from sharing a model name, which Monaco refuses.
  const model = monaco.editor.createModel(props.file.text, undefined, monaco.Uri.file(props.file.path).with({ query: String(Math.random()) }));
  editor = monaco.editor.create(host.value!, { model, theme: "claude2", automaticLayout: true, fontSize: 14, minimap: { enabled: false }, lineNumbers: props.file.line ? "on" : "off", renderFinalNewline: "on", wordWrap: "on", scrollBeyondLastLine: false, lineDecorationsWidth: 14, glyphMargin: false, folding: false, editContext: false });
  if (props.file.line) {
    const line = Math.min(props.file.line, model.getLineCount());
    editor.setPosition({ lineNumber: line, column: 1 });
    // Once this render is over: until then the tree is still on show under the editor, which is
    // only part of its height, and the middle of that isn't the middle it ends up with.
    void nextTick(() => {
      editor?.layout();
      editor?.revealLineInCenter(line);
    });
  } else addLineDots(editor);
  addWheelZoom(editor, "claude3.fileFontSize");
  editor.createContextKey("stockEditor", true);
  // A read's setValue is an edit too, but not typing.
  editor.onDidChangeModelContent((event) => !event.isFlush && typed());
  editor.focus();
  // Only the scroll position moving decides this, so a column resize doesn't.
  editor.onDidScrollChange((event) => {
    if (!event.scrollTopChanged || settingText) return;
    tail.value = atBottom();
    void follow();
  });
  tail.value = atBottom();
  void follow();
  poller = window.setInterval(() => void (tail.value ? follow() : poll()), 2000);
});
onBeforeUnmount(() => {
  window.clearInterval(poller);
  if (dirty) flush();
  // An editor given a model leaves it alive.
  editor?.getModel()?.dispose();
  editor?.dispose();
  editor = null;
});
</script>

<template>
  <div class="file-path" :class="{ tail }">{{ file.host }}: {{ file.path }}</div>
  <div v-if="note" class="file-note">{{ note }} <button v-if="refused" data-help="Files editor Reload" @click="reload">Reload</button></div>
  <div class="file-text" data-help="Files editor" data-mode="Files editor"><div ref="host"></div></div>
</template>

<style scoped>
.file-path { flex: none; padding: 2px 6px; border-radius: 4px; overflow-wrap: anywhere; }
.file-path.tail { background: var(--yellow); }
.file-note { flex: none; background: #fbd9d9; border: 1px solid #e4a7a7; border-radius: 8px; padding: 4px 8px; overflow-wrap: anywhere; }
.file-note button { min-height: 0; padding: 1px 8px; }
.file-text { position: relative; flex: 1; min-height: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.file-text:focus-within { outline: 2px solid var(--ink); outline-offset: -1px; border-color: transparent; }
/* Inset just past the rounded corners, as the Snips' editor is. */
.file-text > div { position: absolute; inset: 3px; }
</style>
