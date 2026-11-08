<script setup lang="ts">
// The tab strip. Every tab's Project stays mounted (v-show), so its stream and its pane's state
// carry on while another tab is up.
import { reactive, ref, watch } from "vue";
import { TABS } from "../shared/config.ts";
import Project from "./components/Project.vue";

const saved = localStorage.getItem("claude3.tab");
const current = ref(TABS.some((tab) => tab.label === saved) ? saved! : TABS[0]!.label);
// Sessions responding per tab, so a tab out of sight still shows it is working.
const busy = reactive<Record<string, number>>({});
// The Snips and Settings share the column right of the pane, one at a time: "" (closed), "snips"
// or "settings". One toggle each here, for every tab; the tab on show draws the column, and
// picking a tab closes it, as if it were a tab of its own.
const side = ref("");
const toggle = (name: string): void => void (side.value = side.value === name ? "" : name);
// The sidebar width every tab shares; Project's divider drag sets it.
document.documentElement.style.setProperty("--sidebar-width", `${Number(localStorage.getItem("claude3.sidebarWidth")) || 300}px`);

watch(current, (label) => {
  side.value = "";
  localStorage.setItem("claude3.tab", label);
  document.title = `${label} - claude3`;
}, { immediate: true });
</script>

<template>
  <div class="app">
    <nav class="tabs">
      <button v-for="tab in TABS" :key="tab.label" class="tab" :class="{ selected: tab.label === current }" :title="`${tab.path} (${tab.host})`" @click="current = tab.label">
        <span v-if="busy[tab.label]" class="tab-busy" title="Responding">&#x25CF;</span>{{ tab.label }}
      </button>
      <button class="tab snips-toggle" :class="{ active: side === 'snips' }" :aria-pressed="side === 'snips'" title="Open or close the Snips: snippets of prompt text, one copy shared with claude2 and every tab" @click="toggle('snips')">Snips</button>
      <button class="tab settings-toggle" :class="{ active: side === 'settings' }" :aria-pressed="side === 'settings'" title="Open or close the Settings: quotas" aria-label="Settings" @click="toggle('settings')">&#x2699;&#xFE0E;</button>
    </nav>
    <Project v-for="tab in TABS" v-show="tab.label === current" :key="tab.label" :tab="tab" :active="tab.label === current" @busy="(count) => (busy[tab.label] = count)" :side="side" @close-side="side = ''" />
  </div>
</template>

<style>
.app { height: 100%; display: grid; grid-template-rows: auto minmax(0, 1fr); }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--border); }
.tabs .tab { min-height: 0; padding: 3px 12px; }
.tabs .tab.selected { background: #fbf3c4; border-color: #ddd08a; }
.tabs .snips-toggle { margin-left: auto; }
.tabs .snips-toggle.active, .tabs .settings-toggle.active { background: #cfe8ff; border-color: #8fb8e0; }
.tabs .tab-busy { color: #1a8f2e; margin-right: 6px; }
</style>
