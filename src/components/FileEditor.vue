<script setup lang="ts">
// The Files pane's file mode: one file on the tab's host in a stock Monaco editor, of the prompt
// box's and Snips' custom keys only Ctrl-D, uncoloured, wrapped, their line dots in place of line numbers, no minimap. Live as Snips are: saved half a second after the
// typing stops and at once on close, and read again when the file changes on disk. A save is
// refused if the file changed since it was read, and then nothing more is saved until Reload.
// ponytail: asks every 2s, not a file watch; change it if that lag ever matters.
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { Tab } from "../../shared/config.ts";
import { post } from "../api.ts";
import { addLineDots, addWheelZoom, monaco } from "../monaco.ts";

const props = defineProps<{ tab: Tab; file: { path: string; text: string; mtime: number } }>();

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
// One save at a time: each needs the mtime the one before it left.
let saves: Promise<void> = Promise.resolve();

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function saveNow(text: string): Promise<void> {
  if (!dirty || refused.value) return;
  dirty = false;
  saving = true;
  try {
    const reply = await post<{ mtime?: number; conflict?: boolean }>(props.tab, "saveFile", { path: props.file.path, text, mtime });
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
    editor.setValue(reply.text);
    editor.restoreViewState(view);
  }
}

async function poll(): Promise<void> {
  if (document.hidden || saveTimer || saving || refused.value) return;
  // A save that failed is tried again.
  if (dirty) return flush();
  const asked = edits;
  try {
    const reply = await post<{ mtime: number; text?: string | null }>(props.tab, "readFile", { path: props.file.path, known: mtime });
    if (asked !== edits || saving || refused.value) return;
    note.value = "";
    show(reply);
  } catch (error) {
    note.value = messageOf(error);
  }
}

async function reload(): Promise<void> {
  try {
    const reply = await post<{ mtime: number; text?: string | null }>(props.tab, "readFile", { path: props.file.path });
    refused.value = false;
    dirty = false;
    note.value = "";
    show(reply);
  } catch (error) {
    note.value = messageOf(error);
  }
}

onMounted(() => {
  editor = monaco.editor.create(host.value!, { value: props.file.text, language: "plaintext", theme: "claude2", automaticLayout: true, fontSize: 14, minimap: { enabled: false }, lineNumbers: "off", wordWrap: "on", lineDecorationsWidth: 14, glyphMargin: false, folding: false, editContext: false });
  addLineDots(editor);
  addWheelZoom(editor, "claude3.fileFontSize");
  editor.createContextKey("stockEditor", true);
  // A read's setValue is an edit too, but not typing.
  editor.onDidChangeModelContent((event) => !event.isFlush && typed());
  editor.focus();
  poller = window.setInterval(() => void poll(), 2000);
});
onBeforeUnmount(() => {
  window.clearInterval(poller);
  if (dirty) flush();
  editor?.dispose();
  editor = null;
});
</script>

<template>
  <div v-if="note" class="file-note">{{ note }} <button v-if="refused" @click="reload">Reload</button></div>
  <div class="file-text"><div ref="host"></div></div>
</template>

<style scoped>
.file-note { flex: none; background: #fbd9d9; border: 1px solid #e4a7a7; border-radius: 8px; padding: 4px 8px; overflow-wrap: anywhere; }
.file-note button { min-height: 0; padding: 1px 8px; }
.file-text { position: relative; flex: 1; min-height: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.file-text:focus-within { outline: 2px solid var(--ink); outline-offset: -1px; border-color: transparent; }
/* Inset just past the rounded corners, as the Snips' editor is. */
.file-text > div { position: absolute; inset: 3px; }
</style>
