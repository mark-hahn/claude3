<script setup lang="ts">
// The tab row's Git pane: the project's commit graph as `git log --graph` draws it. View only.
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { Tab } from "../../shared/config.ts";
import { post } from "../api.ts";
import { wheelZoom } from "../wheelZoom.ts";

const props = defineProps<{ tab: Tab; active: boolean }>();
const text = ref("");
const zoom = wheelZoom("git-font-size");

// One request at a time, as the Git button's status does. A failure shows where the graph would.
// ponytail: polls every 2s while on show, as the Files tree does; change it if `git log` ever gets heavy.
let reading = false;
async function refresh(): Promise<void> {
  if (reading || !props.active || document.hidden) return;
  reading = true;
  try {
    text.value = (await post<{ text: string }>(props.tab, "gitGraph", {})).text;
  } catch (problem) {
    text.value = problem instanceof Error ? problem.message : String(problem);
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
  <pre class="git-graph" @wheel="zoom">{{ text }}</pre>
</template>

<style scoped>
.git-graph { min-height: 0; margin: 0; padding: 10px 12px; overflow: auto; border-left: 1px solid var(--border); background: var(--page); color: var(--ink); font: var(--git-font-size, 14px)/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
</style>
