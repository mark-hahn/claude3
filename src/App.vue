<script setup lang="ts">
// The tab strip. Every project's Project stays mounted and laid out, closed ones too, so its events
// and everything on its screen carry on while it is out of sight.
import { computed, provide, reactive, ref, watch, watchEffect } from "vue";
import { FIRST_TABS, type HostName, type Tab } from "../shared/config.ts";
import { connect, post } from "./api.ts";
import Project from "./components/Project.vue";
import Settings from "./components/Settings.vue";
import Snips from "./components/Snips.vue";
import Tabs from "./components/Tabs.vue";
import { showKeys } from "./keyHelp.ts";
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
// Bumped by the tab strip's sidebar button; the Project on show toggles its sidebar, as Ctrl-B does.
const sidebarAsked = ref(0);
// Bumped by a click on a tab or a tab strip toggle other than Log: it ends log view mode (Git.vue's
// review of a Log pane commit). Per tab: log view mode is on, and the Log button has a red border.
const logViewEnd = ref(0);
const logView = reactive<Record<string, boolean>>({});
// Ctrl-click closes the project, as a click on its name in the Tabs dialog does. The tab goes when
// the backend's new list comes down; a project with a session running is refused.
function clickTab(tab: Tab, event: MouseEvent): void {
  logViewEnd.value++;
  if (event.ctrlKey) {
    post(tab, "openProject", { open: false })
      .catch((error) => window.alert(error instanceof Error ? error.message : String(error)))
      .finally(() => focusAsked.value++);
    return;
  }
  current.value = tab.id;
  focusAsked.value++;
}
// Sessions responding per tab, so a tab out of sight still shows it is working.
const busy = reactive<Record<string, number>>({});
// Per tab: its Git or Run button is highlighted.
const highlighted = reactive<Record<string, boolean>>({});
// Per tab: its folder is in no git repo, so there is no graph to open.
const noRepo = reactive<Record<string, boolean>>({});
// Per tab: the name of its selected session, on show in the strip for the tab on show.
const sessionNames = reactive<Record<string, string>>({});
// The Files, Git graph, Snips and Settings share the column right of the pane, one at a time: "" (closed),
// "files" (the tree), "file" (its editor), "git", "term", "snips" or "settings". Each tab has its own, and one
// toggle each here acts on the tab on show. The toggle's name being "files", the Files button takes
// the editor back to the tree.
const sides = reactive<Record<string, string>>({});
const side = computed(() => sides[current.value] ?? "");
function toggle(name: string): void {
  if (name !== "git") logViewEnd.value++;
  sides[current.value] = side.value === name ? "" : name;
}
// With no project open, the Snips and Settings have the page to themselves. Both are the host's
// actions, not a project's, so this stand-in only names the WSL backend to ask.
const NO_TAB: Tab = { id: "", label: "", host: "wsl", path: "", open: false };
// The sidebar width every tab shares; Project's divider drag sets it.
document.documentElement.style.setProperty("--sidebar-width", `${Number(localStorage.getItem("claude3.sidebarWidth")) || 300}px`);
// The right column's share of what the sidebar leaves; Project's side divider drag sets it.
document.documentElement.style.setProperty("--side-share", String(Number(localStorage.getItem("claude3.sideShare")) || 0.5));

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
const tabsDialog = ref<InstanceType<typeof Tabs>>();
provide("newProjectAt", (host: HostName, folder: string) => tabsDialog.value?.openWith(host, folder));
</script>

<template>
  <div class="app">
    <nav class="tabs">
      <button class="tab tabs-toggle sidebar-toggle" aria-label="Sidebar" data-help="sidebar button" :disabled="!currentTab" @mousedown.prevent @click="sidebarAsked++">
        <svg viewBox="0 0 20 16" width="20" height="16" aria-hidden="true"><rect x="1" y="1.5" width="18" height="13" rx="3" /><path d="M7.5 1.5H4a3 3 0 0 0-3 3v7a3 3 0 0 0 3 3h3.5z" fill="currentColor" /></svg>
      </button>
      <span class="project-buttons"></span>
      <Tabs ref="tabsDialog" :tabs="sorted" :highlighted="highlighted" :busy="busy" @show="(host, path) => (toShow = { host, path })" @closed="focusAsked++" />
      <button v-for="tab in opened" :key="tab.id" class="tab" :class="[tab.host, { selected: tab.id === current }]" :title="`${tab.path} (${tab.host})`" data-help="tab" @click="clickTab(tab, $event)">
        <span v-if="busy[tab.id] || highlighted[tab.id]" class="tab-dot" :class="{ due: !busy[tab.id] }">&#x25CF;</span>{{ tab.label }}
      </button>
      <span class="session-name">{{ sessionNames[current] }}</span>
      <button class="tab files-toggle" :class="{ active: side.startsWith('file') }" :aria-pressed="side.startsWith('file')" :disabled="!currentTab" data-help="Files button" @click="toggle('files')">Files</button>
      <button class="tab git-toggle" :class="{ active: side === 'git', 'log-view': logView[current] }" :aria-pressed="side === 'git'" :disabled="!currentTab || noRepo[current]" data-help="Log button" @click="toggle('git')">Log</button>
      <button class="tab term-toggle" :class="{ active: side === 'term' }" :aria-pressed="side === 'term'" :disabled="!currentTab" data-help="Term button" @click="toggle('term')">Term</button>
      <button class="tab snips-toggle" :class="{ active: side === 'snips' }" :aria-pressed="side === 'snips'" data-help="Snips button" @click="toggle('snips')">Snips</button>
      <button class="tab" aria-label="Keys" data-help="keys button" @mousedown.prevent @click="showKeys">?</button>
      <button class="tab settings-toggle" :class="{ active: side === 'settings' }" :aria-pressed="side === 'settings'" aria-label="Settings" data-help="Settings button" @click="toggle('settings')">&#x2699;&#xFE0E;</button>
    </nav>
    <Project v-for="tab in sorted" :key="tab.id" :class="{ offstage: tab.id !== current }" :tab="tab" :active="tab.id === current" @busy="(count) => (busy[tab.id] = count)" @highlighted="(on) => (highlighted[tab.id] = on)" @no-repo="(none) => (noRepo[tab.id] = none)" @session-name="(name) => (sessionNames[tab.id] = name)" :side="sides[tab.id] ?? ''" :focus-asked="focusAsked" :sidebar-asked="sidebarAsked" :log-view-end="logViewEnd" @log-view="(on) => (logView[tab.id] = on)" @close-side="sides[tab.id] = ''" @open-file="sides[tab.id] = 'file'" @show-files="sides[tab.id] = 'files'" />
    <Snips v-if="!currentTab && side === 'snips'" class="alone" :tab="NO_TAB" shown :add-to-prompt="() => false" @close="sides[current] = ''" />
    <Settings v-if="!currentTab && side === 'settings'" class="alone" :tab="NO_TAB" active @close="sides[current] = ''" />
  </div>
</template>

<style>
.app { height: 100%; display: grid; grid-template-rows: auto minmax(0, 1fr); grid-template-columns: minmax(0, 1fr); }
/* Every project in the one cell, those not on show only invisible. display:none (v-show) would
   lose their scroll positions and have their layout code measure 0x0. */
.app > .project { grid-area: 2 / 1; }
.app > .project.offstage { visibility: hidden; }
.app > .alone { grid-area: 2 / 1; }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--border); }
.tabs .tab { min-height: 0; padding: 3px 12px; }
.tabs .tab.selected { background: #fbf3c4; border-color: #ddd08a; }
.tabs .tab.wsl { color: green; }
.tabs .tab.win { color: blue; }
.tabs .tab.srv { color: brown; }
/* tabs-toggle's right margin and the bar's gap leave 12px on its right; this and the bar's padding leave 12px on its left. */
.tabs .sidebar-toggle { margin-left: 2px; }
/* Each Project teleports its +, G (Git) and R (Run) here in a span, shown only for the tab on show. display: contents makes them the row's own flex items. */
.tabs .project-buttons, .tabs .project-buttons > span { display: contents; }
/* Takes the row's free space, so it is centered between the last tab and Files. A basis of 0 so it never wraps the row. */
.tabs .session-name { flex: 1 1 0; min-width: 0; align-self: center; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tabs .files-toggle { margin-left: auto; }
.tabs .files-toggle.active, .tabs .git-toggle.active, .tabs .term-toggle.active, .tabs .snips-toggle.active, .tabs .settings-toggle.active { background: #cfe8ff; border-color: #8fb8e0; }
/* Log view mode (Git.vue's review of a Log pane commit), with its popup open or parked behind the Files editor. */
.tabs .git-toggle.log-view { border-color: #d11a1a; }
/* 20% over the tab's 14px. The line-height keeps the bigger glyph from making its tab taller. */
.tabs .tab-dot { color: #1a8f2e; margin-right: 6px; font-size: 16.8px; line-height: 1; }
.tabs .tab-dot.due { color: #f08080; }
</style>
