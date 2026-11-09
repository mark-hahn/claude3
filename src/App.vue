<script setup lang="ts">
// The tab strip. Every project's Project stays mounted and laid out, closed ones too, so its events
// and everything on its screen carry on while it is out of sight.
import { computed, provide, reactive, ref, watch, watchEffect } from "vue";
import { FIRST_TABS, type Tab } from "../shared/config.ts";
import { connect } from "./api.ts";
import Project from "./components/Project.vue";
import Tabs from "./components/Tabs.vue";
import { byName, nextTab } from "./tabList.ts";

// Every project on every host. Each backend's part is replaced when it sends its list; until then
// it's the last one that backend sent, so a backend that is down still shows its tabs.
const all = ref<Tab[]>(JSON.parse(localStorage.getItem("claude3.tabs") ?? "null") ?? FIRST_TABS);
connect((host, tabs) => {
  all.value = [...all.value.filter((tab) => tab.host !== host), ...tabs];
  localStorage.setItem("claude3.tabs", JSON.stringify(all.value));
});
const sorted = computed(() => [...all.value].sort(byName));
const opened = computed(() => sorted.value.filter((tab) => tab.open));
const current = ref(localStorage.getItem("claude3.tab") ?? "");
const currentTab = computed(() => opened.value.find((tab) => tab.id === current.value));
watch(sorted, (list, old) => {
  if (!currentTab.value) current.value = nextTab(list, old?.find((tab) => tab.id === current.value));
}, { immediate: true });
// A project the Tabs dialog just made or opened comes up as soon as its backend's list has it open,
// which can be before or after the answer to the request.
const toShow = ref<{ host: string; path: string } | null>(null);
watch([toShow, sorted], () => {
  const tab = opened.value.find((entry) => entry.host === toShow.value?.host && entry.path === toShow.value?.path);
  if (!tab) return;
  current.value = tab.id;
  toShow.value = null;
});
// Bumped when the Tabs dialog closes (a tab picked behind the dialog couldn't take the cursor then)
// and on a click on a tab, which may be the one already on show.
const focusAsked = ref(0);
// Sessions responding per tab, so a tab out of sight still shows it is working.
const busy = reactive<Record<string, number>>({});
// Per tab: its Git or Run button is highlighted.
const highlighted = reactive<Record<string, boolean>>({});
// The Files, Snips and Settings share the column right of the pane, one at a time: "" (closed),
// "files" (the tree), "file" (its editor), "snips" or "settings". Each tab has its own, and one
// toggle each here acts on the tab on show. The toggle's name being "files", the Files button takes
// the editor back to the tree.
const sides = reactive<Record<string, string>>({});
const side = computed(() => sides[current.value] ?? "");
const toggle = (name: string): void => void (sides[current.value] = side.value === name ? "" : name);
// The sidebar width every tab shares; Project's divider drag sets it.
document.documentElement.style.setProperty("--sidebar-width", `${Number(localStorage.getItem("claude3.sidebarWidth")) || 300}px`);

// The tab on show before this one, for Alt-Cap: it comes up for the length of the shot, then the
// tab that asked is back, holding the picture.
let previous = "";
watch(current, (id, old) => {
  previous = old ?? previous;
  localStorage.setItem("claude3.tab", id);
}, { immediate: true });
watchEffect(() => (document.title = currentTab.value ? `${currentTab.value.label} - claude3` : "claude3"));

async function onPreviousTab<T>(shot: () => Promise<T>): Promise<T> {
  if (!opened.value.some((tab) => tab.id === previous)) return await shot();
  const back = current.value;
  current.value = previous;
  // claude2's tabSettleMs: the tab has to lay out and paint before the screen is worth copying.
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    return await shot();
  } finally {
    current.value = back;
  }
}
provide("onPreviousTab", onPreviousTab);
</script>

<template>
  <div class="app">
    <nav class="tabs">
      <span class="indicator" :class="busy[current] ? 'active' : highlighted[current] ? 'due' : ''"></span>
      <Tabs :tabs="sorted" @show="(host, path) => (toShow = { host, path })" @closed="focusAsked++" />
      <button v-for="tab in opened" :key="tab.id" class="tab" :class="{ selected: tab.id === current }" :title="`${tab.path} (${tab.host})`" @click="current = tab.id; focusAsked++">
        <span v-if="busy[tab.id]" class="tab-busy" title="Responding">&#x25CF;</span>{{ tab.label }}
      </button>
      <button class="tab files-toggle" :class="{ active: side.startsWith('file') }" :aria-pressed="side.startsWith('file')" :disabled="!currentTab" title="Open or close the Files: a tree of the project's folder, and an editor" @click="toggle('files')">Files</button>
      <button class="tab snips-toggle" :class="{ active: side === 'snips' }" :aria-pressed="side === 'snips'" :disabled="!currentTab" title="Open or close the Snips: snippets of prompt text, one copy shared with claude2 and every tab" @click="toggle('snips')">Snips</button>
      <button class="tab settings-toggle" :class="{ active: side === 'settings' }" :aria-pressed="side === 'settings'" :disabled="!currentTab" title="Open or close the Settings: quotas" aria-label="Settings" @click="toggle('settings')">&#x2699;&#xFE0E;</button>
    </nav>
    <Project v-for="tab in sorted" :key="tab.id" :class="{ offstage: tab.id !== current }" :tab="tab" :active="tab.id === current" @busy="(count) => (busy[tab.id] = count)" @highlighted="(on) => (highlighted[tab.id] = on)" :side="sides[tab.id] ?? ''" :focus-asked="focusAsked" @close-side="sides[tab.id] = ''" @open-file="sides[tab.id] = 'file'" />
  </div>
</template>

<style>
.app { height: 100%; display: grid; grid-template-rows: auto minmax(0, 1fr); grid-template-columns: minmax(0, 1fr); }
/* Every project in the one cell, those not on show only invisible. display:none (v-show) would
   lose their scroll positions and have their layout code measure 0x0. */
.app > .project { grid-area: 2 / 1; }
.app > .project.offstage { visibility: hidden; }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--border); }
.tabs .tab { min-height: 0; padding: 3px 12px; }
/* Buttons are about 28px high. With the row's 10px padding and 6px gap, 12px each side: what the Tabs button has on its right. */
.tabs .indicator { align-self: center; width: 14.08px; height: 14.08px; margin: 0 6px 0 2px; border: 1px solid #000; border-radius: 50%; background: #fff; }
.tabs .indicator.due { background: #fbd9d9; border-color: #e4a7a7; }
.tabs .indicator.active { background: lightgreen; border-color: lightgreen; }
.tabs .tab.selected { background: #fbf3c4; border-color: #ddd08a; }
.tabs .files-toggle { margin-left: auto; }
.tabs .files-toggle.active, .tabs .snips-toggle.active, .tabs .settings-toggle.active { background: #cfe8ff; border-color: #8fb8e0; }
.tabs .tab-busy { color: #1a8f2e; margin-right: 6px; }
</style>
