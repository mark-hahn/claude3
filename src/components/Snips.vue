<script setup lang="ts">
// claude2's Snips tab, a column right of the conversation pane, the window's full height below the
// tab strip. One text, kept on claude2's stats server (the backend's `snips` action), so claude2's
// windows and every claude3 tab edit the same copy. Read when it opens and whenever the window gets focus back; saved half a
// second after the typing stops, and at once on close. Ctrl+Enter or Esc closes it.
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { Tab } from "../../shared/config.ts";
import { post } from "../api.ts";

const props = defineProps<{ tab: Tab }>();
const emit = defineEmits<{ close: [] }>();

const text = ref("");
// Editable only once the shared copy has been read, so nothing typed early can replace it.
const ready = ref(false);
// Why it can't be read or saved; empty while all is well.
const note = ref("");
const box = ref<HTMLTextAreaElement>();
// Typing since a read started makes its answer stale.
let edits = 0;
let saveTimer = 0;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function load(): Promise<void> {
  if (saveTimer) return;
  const asked = edits;
  try {
    const reply = await post<{ text: string | null }>(props.tab, "snips", {});
    if (asked !== edits || saveTimer) return;
    if (reply.text === null) {
      note.value = "claude2 hasn't shared its Snips yet: open them once in claude2.";
      return;
    }
    // A textarea hands back \n line ends whatever it was given, so compare and keep them that way.
    const next = reply.text.replace(/\r\n?/g, "\n");
    note.value = "";
    ready.value = true;
    if (next === text.value) return;
    const el = box.value;
    const [start, end, top] = [el?.selectionStart ?? 0, el?.selectionEnd ?? 0, el?.scrollTop ?? 0];
    text.value = next;
    await nextTick();
    el?.setSelectionRange(start, end);
    if (el) el.scrollTop = top;
  } catch (error) {
    note.value = `The Snips couldn't be read: ${messageOf(error)}`;
  }
}

function save(): void {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  post(props.tab, "snips", { text: text.value }).then(
    () => (note.value = ""),
    (error) => (note.value = `Not saved: ${messageOf(error)}`),
  );
}

function typed(): void {
  edits++;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, 500);
}

function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape" || (event.key === "Enter" && event.ctrlKey)) {
    event.preventDefault();
    emit("close");
  }
}

onMounted(() => {
  box.value?.focus();
  void load();
  window.addEventListener("focus", load);
});
onBeforeUnmount(() => {
  window.removeEventListener("focus", load);
  if (saveTimer) save();
});
</script>

<template>
  <div class="snips">
    <div v-if="note" class="snips-note">{{ note }}</div>
    <textarea ref="box" v-model="text" class="snips-text" spellcheck="false" :readonly="!ready" @input="typed" @keydown="onKey"></textarea>
  </div>
</template>

<style scoped>
.snips { min-height: 0; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-left: 1px solid var(--border); background: var(--page); }
.snips-note { background: #fbd9d9; border: 1px solid #e4a7a7; border-radius: 8px; padding: 4px 8px; }
.snips-text { flex: 1; min-height: 0; resize: none; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; outline: none; }
</style>
