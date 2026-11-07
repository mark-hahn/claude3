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

watch(current, (label) => {
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
    </nav>
    <Project v-for="tab in TABS" v-show="tab.label === current" :key="tab.label" :tab="tab" @busy="(count) => (busy[tab.label] = count)" />
  </div>
</template>

<style>
.app { height: 100%; display: grid; grid-template-rows: auto minmax(0, 1fr); }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--border); }
.tabs .tab { min-height: 0; padding: 3px 12px; }
.tabs .tab.selected { background: #fbf3c4; border-color: #ddd08a; font-weight: 600; }
.tabs .tab-busy { color: #1a8f2e; margin-right: 6px; }
</style>
