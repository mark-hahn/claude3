<script setup lang="ts">
// The tab row's Git pane: the project's commit graph, laid out by the backend from `git log --graph`.
// View only, except that on a commit's line ctrl-click copies its full hash and alt-click its message.
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
}
const lines = ref<GraphLine[]>([]);
const zoom = wheelZoom("git-font-size");

// One request at a time, as the Git button's status does. A failure shows where the graph would.
// ponytail: polls every 2s while on show, as the Files tree does; change it if `git log` ever gets heavy.
let reading = false;
async function refresh(): Promise<void> {
  if (reading || !props.active || document.hidden) return;
  reading = true;
  try {
    lines.value = (await post<{ lines: GraphLine[] }>(props.tab, "gitGraph", {})).lines;
  } catch (problem) {
    lines.value = [{ text: problem instanceof Error ? problem.message : String(problem), hash: "", message: "" }];
  }
  reading = false;
}
let poller = 0;
onMounted(() => {
  void refresh();
  poller = window.setInterval(() => void refresh(), 2000);
});
onBeforeUnmount(() => window.clearInterval(poller));
</script>

<template>
  <div class="git-graph" @wheel="zoom">
    <div v-for="(line, at) in lines" :key="at" :title="line.hash && `Ctrl-click: copy ${line.hash}. Alt-click: copy the message`" @click.ctrl="line.hash && copy(line.hash, $event.currentTarget as HTMLElement)" @click.alt="line.message && copy(line.message, $event.currentTarget as HTMLElement)">{{ line.text }}</div>
  </div>
</template>

<style scoped>
.git-graph { min-height: 0; padding: 10px 12px; overflow: auto; white-space: pre; border-left: 1px solid var(--border); background: var(--page); color: var(--ink); font: var(--git-font-size, 14px)/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
</style>
