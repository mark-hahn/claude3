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
// The Snips are one text for every tab, so one toggle here; the tab on show draws them, and
// picking a tab closes them, as if they were a tab of their own.
const snips = ref(false);
// The sidebar width every tab shares; Project's divider drag sets it.
document.documentElement.style.setProperty("--sidebar-width", `${Number(localStorage.getItem("claude3.sidebarWidth")) || 300}px`);

watch(current, (label) => {
  snips.value = false;
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
      <button class="tab snips-toggle" :class="{ active: snips }" :aria-pressed="snips" title="Open or close the Snips: snippets of prompt text, one copy shared with claude2 and every tab" @click="snips = !snips">Snips</button>
    </nav>
    <Project v-for="tab in TABS" v-show="tab.label === current" :key="tab.label" :tab="tab" :active="tab.label === current" @busy="(count) => (busy[tab.label] = count)" :snips="snips" @close-snips="snips = false" />
  </div>
</template>

<style>
.app { height: 100%; display: grid; grid-template-rows: auto minmax(0, 1fr); }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--border); }
.tabs .tab { min-height: 0; padding: 3px 12px; }
.tabs .tab.selected { background: #fbf3c4; border-color: #ddd08a; font-weight: 600; }
.tabs .snips-toggle { margin-left: auto; }
.tabs .snips-toggle.active { background: #cfe8ff; border-color: #8fb8e0; }
.tabs .tab-busy { color: #1a8f2e; margin-right: 6px; }
</style>
