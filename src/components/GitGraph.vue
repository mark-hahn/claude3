<script setup lang="ts">
// The tab row's Git pane: the project's commit graph, laid out by the backend from `git log --graph`.
// On a commit's line ctrl-click copies its full hash and alt-click its message. A long press on the
// message of the checked-out branch's newest commit edits it: Enter saves and pushes, Esc cancels.
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { Tab } from "../../shared/config.ts";
import { post } from "../api.ts";
import { copy } from "../copy.ts";
import { wheelZoom } from "../wheelZoom.ts";

const props = defineProps<{ tab: Tab; active: boolean }>();
// One line on show. The hash and message are empty on a row of graph alone.
interface GraphLine {
  text: string;
  hash: string;
  message: string;
  editable?: boolean;
}
const lines = ref<GraphLine[]>([]);
const zoom = wheelZoom("git-font-size");
const messageOf = (problem: unknown): string => (problem instanceof Error ? problem.message : String(problem));

// One request at a time, as the Git button's status does. A failure shows where the graph would.
// ponytail: polls every 2s while on show, as the Files tree does; change it if `git log` ever gets heavy.
let reading = false;
async function refresh(): Promise<void> {
  if (reading || !props.active || document.hidden) return;
  reading = true;
  try {
    lines.value = (await post<{ lines: GraphLine[] }>(props.tab, "gitGraph", {})).lines;
  } catch (problem) {
    lines.value = [{ text: messageOf(problem), hash: "", message: "" }];
  }
  reading = false;
}
let poller = 0;
onMounted(() => {
  void refresh();
  poller = window.setInterval(() => void refresh(), 2000);
});
onBeforeUnmount(() => window.clearInterval(poller));

// The hash of the commit whose message is being edited. Leaving the input doesn't save it, or a stray
// click could force-push. A press that has dragged out a selection is left to be a selection.
const editing = ref("");
const draft = ref("");
let pressTimer = 0;
function press(line: GraphLine, event: PointerEvent): void {
  if (event.ctrlKey || event.altKey) return;
  window.clearTimeout(pressTimer);
  pressTimer = window.setTimeout(() => {
    if (!window.getSelection()?.isCollapsed) return;
    draft.value = line.message;
    editing.value = line.hash;
  }, 650);
}
const unpress = (): void => window.clearTimeout(pressTimer);
function save(line: GraphLine): void {
  const message = draft.value.trim();
  editing.value = "";
  if (message && message !== line.message) post(props.tab, "reword", { hash: line.hash, message }).catch((problem) => window.alert(messageOf(problem)));
}
// The input is mounted by the edit that just started, so it takes focus as it appears.
const vFocus = { mounted: (el: HTMLInputElement) => (el.focus(), el.select()) };
</script>

<template>
  <div class="git-graph" @wheel="zoom">
    <div v-for="(line, at) in lines" :key="at" :title="line.hash && `Ctrl-click: copy ${line.hash}. Alt-click: copy the message${line.editable ? '. Long press: edit the message and push it' : ''}`" @click.ctrl="line.hash && copy(line.hash, $event.currentTarget as HTMLElement)" @click.alt="line.message && copy(line.message, $event.currentTarget as HTMLElement)" @pointerdown="line.editable && press(line, $event)" @pointerup="unpress" @pointercancel="unpress" @pointerleave="unpress">
      <template v-if="line.editable && editing === line.hash">{{ line.text.slice(0, line.text.length - line.message.length) }}<input v-model="draft" v-focus :size="draft.length + 2" @pointerdown.stop @click.stop @keydown.enter.prevent="save(line)" @keydown.esc.prevent="editing = ''" /></template>
      <template v-else>{{ line.text }}</template>
    </div>
  </div>
</template>

<style scoped>
.git-graph { min-height: 0; padding: 10px 12px; overflow: auto; white-space: pre; border-left: 1px solid var(--border); background: var(--page); color: var(--ink); font: var(--git-font-size, 14px)/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.git-graph input { padding: 0; border: 0; outline: 0; background: var(--yellow); color: inherit; font: inherit; }
</style>
