<script setup lang="ts">
// The tab row's Log pane: the project's commit graph, laid out by the backend from `git log --graph`.
// On a commit's line a click opens the Git popup on that commit's changes (`review`, by way of
// Project), or shows it in the one open; ctrl-click copies its full hash, alt-click its message. While
// that review is on show (`reviewing`, its hash) the commit's lines are highlighted.
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { Tab } from "../../shared/config.ts";
import { post } from "../api.ts";
import { copy } from "../copy.ts";
import { wheelZoom } from "../wheelZoom.ts";

const props = defineProps<{ tab: Tab; active: boolean; reviewing?: string }>();
const emit = defineEmits<{ review: [hash: string, subject: string] }>();
function review(line: GraphLine): void {
  if (line.hash) emit("review", line.hash, line.message);
}
// One line on show. The hash and message are empty on a row of graph alone.
interface GraphLine {
  text: string;
  hash: string;
  message: string;
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
</script>

<template>
  <div class="git-graph" @wheel="zoom">
    <div v-for="(line, at) in lines" :key="at" :title="line.hash" :class="{ reviewed: reviewing && line.hash === reviewing }" :data-help="line.hash ? 'Log row' : undefined" @click.exact="review(line)" @click.ctrl.exact="line.hash && copy(line.hash, $event.currentTarget as HTMLElement)" @click.alt.exact="line.message && copy(line.message, $event.currentTarget as HTMLElement)">{{ line.text }}</div>
  </div>
</template>

<style scoped>
.reviewed { background: var(--yellow); }
.git-graph { min-height: 0; padding: 10px 12px; overflow: auto; white-space: pre; background: var(--page); color: var(--ink); font: var(--git-font-size, 14px)/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
</style>
