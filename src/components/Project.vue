<script setup lang="ts">
// One tab: claude2's sidebar column (ported from sidebarHtml) beside one conversation pane. The
// sessions come down the tab's event stream; picking a card shows that session in the pane, and
// the others keep running and show their clocks here. Left out for now: management, Close.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { HOSTS, type HostName, type Tab } from "../../shared/config.ts";
import { typedPrompt, type ClaudeSession, type RunningStatus, type ServerEvent } from "../../shared/types.ts";
import { authNeeded, listen, post, postHost } from "../api.ts";
import { beep } from "../beep.ts";
import { copy } from "../copy.ts";
import { keepOpen } from "../keepOpen.ts";
import { pick } from "../pick.ts";
import { matchCount } from "../render.ts";
import Files from "./Files.vue";
import Git from "./Git.vue";
import GitGraph from "./GitGraph.vue";
import Pane from "./Pane.vue";
import ReAuth from "./ReAuth.vue";
import Settings from "./Settings.vue";
import Snips from "./Snips.vue";
import Term from "./Term.vue";

// active: this is the tab on show. side: what this tab has open right of the pane ("", "snips",
// "settings", "git", "term", "files" for the tree or "file" for its editor), through App's column toggles.
// focusAsked: a change puts the cursor in the prompt box of the tab on show. sidebarAsked: a change
// toggles the sidebar of the tab on show.
const props = defineProps<{ tab: Tab; active: boolean; side: string; focusAsked: number; sidebarAsked: number }>();
// The Term pane's terminals by slot (0 to 2, each its own shell in the backend), top to bottom, sharing
// the column's height equally. A header's + adds the lowest free slot at the bottom, three at most. One
// whose shell exits is taken out, unless it is the only one, and the backend forgets its slot.
const terms = ref([0]);
const termPanes = ref<InstanceType<typeof Term>[]>([]);
function addTerm(): void {
  const free = [0, 1, 2].find((slot) => !terms.value.includes(slot));
  if (free !== undefined) terms.value.push(free);
}
function closeTerm(slot: number): void {
  terms.value = terms.value.filter((one) => one !== slot);
  post(props.tab, "termClose", { term: slot }).catch((problem) => window.alert(`Term: ${problem instanceof Error ? problem.message : String(problem)}`));
  void nextTick(() => termPanes.value.at(-1)?.focus());
}
const emit = defineEmits<{ busy: [count: number]; closeSide: []; openFile: []; showFiles: []; highlighted: [on: boolean]; noRepo: [none: boolean]; sessionName: [name: string] }>();

// Plain objects mutated in place as text streams in; `version` tells Vue when the shape changed.
let sessions: ClaudeSession[] = [];
const version = ref(0);
const statuses = ref<Record<string, RunningStatus>>({});
const ceilings = ref(0);
const selectedKey = `claude3.session.${props.tab.id}`;
// '' is the moment before ensureOpen has a session; a prompt sent then makes its own.
const selectedId = ref(localStorage.getItem(selectedKey) ?? "");
const showTrash = ref(false);
// The trashed cards the trash list's delete button takes, and the card a shift-click runs from.
const picked = ref(new Set<string>());
let pickAnchor = "";
const connected = ref(false);
const editingId = ref("");
const editName = ref("");
const pane = ref<InstanceType<typeof Pane>>();

const selected = computed(() => {
  void version.value;
  return sessions.find((session) => session.id === selectedId.value) ?? null;
});
// claude2's search, the third list beside the active and trash ones, on while searchText is
// non-empty. Enter in the box starts it; the X, an empty Enter, a card's R, "+", Clean or Trash ends
// it. A card click steps through the hits instead, so it never ends it.
const searchBox = ref("");
const searchText = ref("");
const nameMatches = (session: ClaudeSession): boolean => (session.name || "").toLowerCase().includes(searchText.value.toLowerCase());
// The name is deliberately not counted: a name-only match shows the card with no tally.
const hitCounts = computed(() => {
  void version.value;
  const needle = searchText.value.toLowerCase();
  const tally = new Map<string, number>();
  if (needle) for (const session of sessions) tally.set(session.id, matchCount(session.turns, needle));
  return tally;
});
const matches = (session: ClaudeSession): boolean => !!hitCounts.value.get(session.id) || nameMatches(session);
const visible = computed(() => {
  void version.value;
  // A search takes in both lists. A running card is in every list (see running).
  const listed = (session: ClaudeSession): boolean => !!busy(session) || (searchText.value ? matches(session) : session.trashed === showTrash.value);
  // Newest first by the time each card shows.
  return sessions.filter(listed).sort((a, b) => b.updatedAt - a.updatedAt);
});
const counts = computed(() => {
  void version.value;
  const trashed = sessions.filter((session) => session.trashed).length;
  return { active: sessions.length - trashed, trashed };
});
// The hosts whose Claude login has expired, any of which raises Re-Auth in every tab.
const expired = computed(() => (Object.keys(authNeeded) as HostName[]).filter((host) => authNeeded[host]).join(", "));
const busy = (session: ClaudeSession): string => {
  const status = statuses.value[session.id];
  return status?.active ? (status.phase === "background" ? "background" : "running") : "";
};
// A session running or waiting on a background task. Its card stays on show (only Ctrl-B hides
// it): Clean, Trash and its own 🗑 are off, one starting leaves the trash list, and a search shows it.
const running = computed(() => Object.values(statuses.value).some((status) => status.active));

function setStatus(id: string, status: RunningStatus | null): void {
  const next = { ...statuses.value };
  if (status?.active) next[id] = status;
  else delete next[id];
  statuses.value = next;
}

function onEvent(event: ServerEvent): void {
  if (event.type === "state") {
    loaded = true;
    sessions = event.sessions;
    statuses.value = event.statuses;
    if (selectedId.value && !sessions.some((session) => session.id === selectedId.value)) selectedId.value = "";
    version.value++;
  } else if (event.type === "session") {
    const at = sessions.findIndex((session) => session.id === event.session.id);
    const before = sessions[at]?.turns.at(-1);
    const turn = event.session.turns.at(-1);
    // tag: a second page open on the same browser replaces this one's notification, not adds to it.
    if (turn?.finished && before?.id === turn.id && !before.finished && !document.hasFocus() && Notification.permission === "granted") {
      new Notification(`${props.tab.label}: turn finished`, { body: event.session.name, tag: turn.id });
      beep();
    }
    if (at >= 0) sessions[at] = event.session;
    else sessions.unshift(event.session);
    setStatus(event.session.id, event.status);
    version.value++;
  } else if (event.type === "delta") {
    const turn = sessions.find((session) => session.id === event.sessionId)?.turns.find((entry) => entry.id === event.turnId);
    // Spliced at its offset, not appended: a session event that landed first may already hold it.
    if (turn && event.delta) turn.response = turn.response.slice(0, event.at) + event.delta;
    setStatus(event.sessionId, event.status);
    if (event.sessionId === selectedId.value) pane.value?.applyDelta(event.turnId, event.status);
  } else if (event.type === "removed") {
    sessions = sessions.filter((session) => !event.ids.includes(session.id));
    if (event.ids.includes(selectedId.value)) selectedId.value = "";
    version.value++;
  } else if (event.type === "ceilings") {
    ceilings.value = event.count;
  } else if (event.type === "returned") {
    pane.value?.returnPrompt(event.sessionId, event.prompt, event.images, event.files ?? []);
    if (event.notice) window.alert(`${event.notice}\n\nYour prompt is back in the box.`);
  }
  if (event.type === "state" || event.type === "removed") void ensureOpen();
}

function select(id: string): void {
  selectedId.value = id;
}

// claude2's "+": a "New session" card, opened in the pane. Attention moving on (another card,
// Clean, Trash, "+" again) sweeps it away while it is still empty and holds no typing.
// The card with turns that "+" or Ctrl-S moved on from, for Ctrl-S to go back to.
let beforeNew = "";
async function newSession(): Promise<void> {
  clearSearch();
  if (selected.value?.turns.length) beforeNew = selected.value.id;
  try {
    openCard((await post<{ session: ClaudeSession }>(props.tab, "new", { keep: keepIds() })).session);
    showTrash.value = false;
  } catch (error) {
    report(error);
  }
}

function openCard(session: ClaudeSession): void {
  if (!sessions.some((entry) => entry.id === session.id)) onEvent({ type: "session", session, status: null });
  selectedId.value = session.id;
  focusPrompt();
}

// There is always a session open. Only the tab on show gets one, once its backend's list is in, so
// tabs never looked at stay as they were. A failed open leaves the pane able to start a session
// from its first prompt, so it is only logged.
let loaded = false;
const ensureOpen = keepOpen(
  () => loaded && props.active && !selected.value,
  async () => {
    const { session } = await post<{ session: ClaudeSession }>(props.tab, "open", {});
    if (!selected.value) openCard(session);
  },
  console.error,
);

function keepIds(...keep: string[]): string[] {
  return [...keep, ...(pane.value?.drafted() ?? [])].filter(Boolean);
}
function sweep(...keep: string[]): void {
  if (sessions.some((session) => !session.turns.length)) void post(props.tab, "discard", { keep: keepIds(...keep) }).catch(report);
}

// claude2's Clean: every session to the trash, then a new one opens.
function clean(): void {
  clearSearch();
  sweep();
  selectedId.value = "";
  void ensureOpen(post(props.tab, "clean", {}).catch(report));
}

function toggleTrash(): void {
  clearSearch();
  sweep(selectedId.value);
  showTrash.value = !showTrash.value;
}

// A search covers every session, so it replaces the trash list too, and lands on its first card.
function setSearch(text: string): void {
  searchText.value = text;
  if (!text) return;
  showTrash.value = false;
  void stepSearch(visible.value.find(matches)?.id ?? "", true);
}

// What a top button does to a search: typing not yet searched for stays in the box.
function clearSearch(): void {
  if (searchText.value) searchBox.value = searchText.value = "";
}

// The X, which also leaves the trash list.
function closeSearch(): void {
  searchBox.value = searchText.value = "";
  showTrash.value = false;
}

// Selects a result. first lands on its first hit, otherwise the pane moves on to the next one.
async function stepSearch(id: string, first: boolean): Promise<void> {
  if (!id) return;
  sweep(id);
  selectedId.value = id;
  // After the flush: the pane has to have this session before it can walk its hits.
  await nextTick();
  pane.value?.stepSearch(first);
}

// Ctrl-S on an empty card with no typing goes back to the card before it (or the newest card with
// turns), which sweeps the empty one away, so Ctrl-S toggles a new session. Otherwise it opens one.
function toggleNew(): void {
  const empty = selected.value && !selected.value.turns.length && !pane.value?.drafted().includes(selected.value.id);
  const back = sessions.find((session) => session.id === beforeNew && !session.trashed) ?? [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).find((session) => !session.trashed && session.turns.length);
  if (!empty || !back) return void newSession();
  clearSearch();
  showTrash.value = false;
  sweep(back.id);
  selectedId.value = back.id;
  void focusPrompt();
}

// Ctrl-S opens or drops a new session (toggleNew), leaving the sidebar as it is. Ctrl-B hides or shows this
// tab's sidebar, but never closes it on the trash list. Capture phase, so an editor holding the
// cursor doesn't get the key. A held key counts once: repeated "new" requests would sweep each other's card.
const sidebarHidden = ref(false);
function toggleSidebar(): void {
  if (!showTrash.value) sidebarHidden.value = !sidebarHidden.value;
}
function onPageKey(event: KeyboardEvent): void {
  if (!props.active || (event.code !== "KeyB" && event.code !== "KeyS") || !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat) return;
  if (event.code === "KeyS") toggleNew();
  else toggleSidebar();
}

// claude2's delete for good: one question for the whole pick.
function deletePicked(): void {
  const ids = [...picked.value];
  const question = ids.length === 1 ? `Permanently delete "${sessions.find((session) => session.id === ids[0])?.name || "this session"}"?` : `Permanently delete the ${ids.length} selected sessions?`;
  if (!window.confirm(`${question}\n\nThis cannot be undone.`)) return;
  void post(props.tab, "delete", { sessionIds: ids }).catch(report);
}

// After the whole flush: the watchers that call this run before their tab is put on show, and a
// hidden box can't take focus.
async function focusPrompt(): Promise<void> {
  await nextTick();
  pane.value?.focusPrompt();
}

// The divider between sidebar and pane: dragging it sets the width every tab shares (App.vue
// reads it back at load). The sidebar starts at the page's left edge, so the pointer's x is it.
function dragDivider(event: PointerEvent): void {
  const divider = event.currentTarget as HTMLElement;
  event.preventDefault();
  divider.setPointerCapture(event.pointerId);
  let width = 0;
  const move = (step: PointerEvent): void => {
    width = Math.round(Math.max(180, Math.min(step.clientX, window.innerWidth - 300)));
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
  };
  divider.addEventListener("pointermove", move);
  divider.addEventListener("lostpointercapture", () => {
    divider.removeEventListener("pointermove", move);
    if (width) localStorage.setItem("claude3.sidebarWidth", String(width));
  }, { once: true });
}

// The divider between pane and the right column: dragging it sets the column's share of what the
// sidebar leaves (--side-share on the root, shared by every tab, App.vue reads it back at load).
// The grid stops the column where the pane's dock would no longer fit (see .with-snips); the share is
// then cut back to the width the column got, so dragging back right moves it at once.
function dragSideDivider(event: PointerEvent): void {
  const divider = event.currentTarget as HTMLElement;
  event.preventDefault();
  divider.setPointerCapture(event.pointerId);
  let share = 0;
  const setShare = (width: number, room: number): void => {
    share = width / room;
    document.documentElement.style.setProperty("--side-share", String(share));
  };
  const move = (step: PointerEvent): void => {
    const sidebar = sidebarHidden.value ? 0 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width")) || 300;
    const room = window.innerWidth - sidebar;
    const width = Math.max(200, window.innerWidth - step.clientX);
    setShare(width, room);
    const got = window.innerWidth - divider.getBoundingClientRect().right;
    if (got < width) setShare(got, room);
  };
  divider.addEventListener("pointermove", move);
  divider.addEventListener("lostpointercapture", () => {
    divider.removeEventListener("pointermove", move);
    if (share) localStorage.setItem("claude3.sideShare", String(share));
  }, { once: true });
}

function trash(session: ClaudeSession, trashed: boolean): void {
  // Trashing the open card opens the one below it (or above, if it was the last).
  if (trashed && session.id === selectedId.value) {
    const list = visible.value;
    const at = list.findIndex((entry) => entry.id === session.id);
    selectedId.value = (list[at + 1] ?? list[at - 1])?.id ?? "";
  }
  sweep(selectedId.value, session.id);
  void ensureOpen(post(props.tab, "trash", { sessionId: session.id, trashed }).catch(report));
  // A card's R ends a search. Marked here first, or the end would move the pane off a restored open card.
  if (!trashed && searchText.value) {
    session.trashed = false;
    clearSearch();
  }
}

function report(error: unknown): void {
  window.alert(error instanceof Error ? error.message : String(error));
}

// A test of Re-Auth: ctrl-click on the counts raises this tab's host's flag, as an expired login
// would. One host only, as a real expiry is: a flag on every host stayed up on each one skipped.
function fakeExpiry(): void {
  void postHost(props.tab.host, "fakeAuthNeeded", {}).catch(report);
}

// A long press renames; a plain click opens; alt-click copies the name. On the trash list every
// click opens the card, whatever the modifier; alt there also copies and leaves the picks alone.
let pressTimer = 0;
let renamed = false;
function press(session: ClaudeSession, event: PointerEvent): void {
  renamed = !event.altKey && editingId.value === session.id;
  if (renamed || event.altKey) return;
  window.clearTimeout(pressTimer);
  pressTimer = window.setTimeout(() => {
    renamed = true;
    editingId.value = session.id;
    editName.value = session.name || "New session";
  }, 650);
}
function unpress(): void {
  window.clearTimeout(pressTimer);
}
function clickCard(session: ClaudeSession, event: MouseEvent): void {
  if (event.altKey) {
    copy(session.name || "", event.currentTarget as HTMLElement);
    if (!showTrash.value) return;
  }
  // The open card moves on from its pane's current hit; any other card starts at its first.
  if (searchText.value && !renamed) {
    void stepSearch(session.id, session.id !== selectedId.value);
    void focusPrompt();
    return;
  }
  sweep(session.id);
  if (renamed) return;
  if (showTrash.value && !event.altKey) pickAnchor = pick(picked.value, visible.value.map((entry) => entry.id), session.id, pickAnchor, event);
  selectedId.value = session.id;
  void focusPrompt();
}
function finishRename(session: ClaudeSession, commit: boolean): void {
  if (editingId.value !== session.id) return;
  editingId.value = "";
  const name = editName.value.trim();
  if (commit && name && name !== session.name) void post(props.tab, "rename", { sessionId: session.id, name }).catch(report);
}
// The input is mounted by the rename that just started, so it takes focus as it appears.
const vFocus = { mounted: (el: HTMLInputElement) => (el.focus(), el.select()) };

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
// The first prompt, which the name was made from; capped so a long one can't fill the screen.
function firstPrompt(session: ClaudeSession): string {
  const prompt = typedPrompt(session.turns[0]?.prompt ?? "") || "No prompt.";
  return prompt.length > 800 ? prompt.slice(0, 800) + "…" : prompt;
}

watch(selectedId, (id) => localStorage.setItem(selectedKey, id));
// Only the trash list and a search can have a trashed session open. Off them (Trash clicked again,
// a search ended, a reload, another page trashing the open card) the newest card opens, or
// ensureOpen makes one.
watch(() => !showTrash.value && !searchText.value && selected.value?.trashed, (stale) => {
  if (!stale) return;
  selectedId.value = visible.value[0]?.id ?? "";
  void ensureOpen();
});
// Picks outlive leaving the trash list; only a card restored or deleted drops out. The delete button
// exists only on that list, where every trashed card is on show, so it never reaches one out of sight.
watch(running, (on) => on && (showTrash.value = false));
watch(visible, () => (picked.value = new Set(sessions.filter((session) => session.trashed && picked.value.has(session.id)).map((session) => session.id))));
watch(statuses, (all) => emit("busy", Object.values(all).filter((status) => status.active).length));
// The Git and Run buttons' highlights, for the dot on this project's tab in App's tab strip.
const gitDirty = ref(false);
const deployDue = ref(false);
watch(() => gitDirty.value || deployDue.value, (on) => emit("highlighted", on));
// A click on a line number in the Git popup's diff: that file in the Files pane's editor, at that
// line. By way of the tree, so an editor already open saves and closes first; Files is there to ask
// once the column has changed.
const filesPane = ref<InstanceType<typeof Files>>();
async function openInFiles(path: string, line: number): Promise<void> {
  emit("showFiles");
  await nextTick();
  void filesPane.value?.openPath(path, line);
}
// The selected session's name, as its card shows it, for App's tab strip.
watch(() => (selected.value ? selected.value.name || "New session" : ""), (name) => emit("sessionName", name));
// Mounted the first time they are opened, not with every project at page load, and only hidden after that.
const snipsShown = computed(() => props.side === "snips" && props.active);
const snipsOpened = ref(false);
watch(snipsShown, (shown) => { if (shown) snipsOpened.value = true; }, { immediate: true });
// Picking a tab puts the cursor in its prompt box.
watch(() => props.active, (active) => {
  if (!active) return;
  void focusPrompt();
  void ensureOpen();
});
watch(() => props.side, (open) => !open && props.active && focusPrompt());
watch(() => props.focusAsked, () => props.active && focusPrompt());
watch(() => props.sidebarAsked, () => props.active && toggleSidebar());
// A project closed and opened again comes back with its sidebar open.
watch(() => props.tab.open, () => (sidebarHidden.value = false));
// Re-Auth and its message are in the sidebar, so an expired login opens it, in every tab.
watch(expired, (hosts) => hosts && (sidebarHidden.value = false));

let stopListening = (): void => undefined;
onMounted(() => {
  stopListening = listen(props.tab, onEvent, (up) => (connected.value = up));
  if (props.active) focusPrompt();
  window.addEventListener("keydown", onPageKey, true);
});
onBeforeUnmount(() => {
  stopListening();
  window.removeEventListener("keydown", onPageKey, true);
});
</script>

<template>
  <div class="project" :class="{ 'with-snips': side, 'no-sidebar': sidebarHidden }">
    <!-- Hidden off show, not unmounted: Git's status drives this project's tab dot. Deferred, as the tab row isn't in the document yet at first mount. -->
    <Teleport defer to=".project-buttons">
      <span v-show="active">
        <button class="tab new" title="New session" @click="newSession">
          <svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" /></svg>
        </button>
        <Git :tab="tab" :active="active" :version="version" @closed="focusPrompt" @dirty="(dirty) => (gitDirty = dirty)" @no-repo="(none) => emit('noRepo', none)" @open-file="openInFiles" />
        <button class="tab" :class="{ 'deploy-due': deployDue }" title="Run the project's ./run, the same as the prompt r. Ctrl-click: the same as the prompt v" @mousedown.prevent @click="pane?.runScript($event.ctrlKey)">R</button>
      </span>
    </Teleport>
    <aside class="sidebar">
      <div class="top">
        <div class="head">
          <button v-if="showTrash" class="delete" title="Permanently delete the selected trashed sessions. Ctrl-click or shift-click a card to select more" :disabled="!picked.size" @click="deletePicked">&#x1F5D1;{{ picked.size ? ` ${picked.size}` : "" }}</button>
          <button v-else class="clean" title="Move every session to the trash. Off while a session is running" :disabled="running || !visible.some((session) => session.turns.length)" @click="clean">Clean</button>
          <button class="trash-toggle" :class="{ active: showTrash }" :title="showTrash ? 'Show active sessions' : 'Show trashed sessions. Off while a session is running'" :disabled="running" @click="toggleTrash">Trash</button>
          <div class="row">
            <span class="counts" title="Active sessions / trashed sessions. Ctrl-click: fake an expired login on this tab's host, to test Re-Auth" @click.ctrl="fakeExpiry">{{ counts.active }}/{{ counts.trashed }}</span>
            <ReAuth :needed="!!expired" @closed="focusPrompt" />
          </div>
        </div>
        <div class="row">
          <input v-model="searchBox" class="tabs-input" :class="{ searching: searchText }" type="text" placeholder="Search" aria-label="Search sessions" spellcheck="false" @keydown.enter.prevent="setSearch(searchBox.trim())" />
          <button class="search-clear" title="Clear search" aria-label="Clear search" @click="closeSearch">&#x2715;</button>
        </div>
        <div v-if="!connected" class="offline">No answer from the {{ tab.host }} backend at {{ HOSTS[tab.host].url }}. Retrying.</div>
        <div v-if="expired" class="offline">Authorization expired on {{ expired }}. Click Re-Auth to sign in again.</div>
      </div>
      <div class="sessions">
        <div v-if="searchText ? !visible.some(matches) : !visible.length" class="empty">{{ searchText ? "No matches" : showTrash ? "Trash is empty" : "No sessions yet" }}</div>
        <div
          v-for="session in visible"
          :key="session.id"
          class="card"
          :class="{ selected: showTrash ? picked.has(session.id) : session.id === selectedId, trashed: session.trashed }"
          :title="firstPrompt(session)"
          role="button"
          tabindex="0"
          @pointerdown="press(session, $event)"
          @pointerup="unpress"
          @pointercancel="unpress"
          @pointerleave="unpress"
          @click="clickCard(session, $event)"
        >
          <input
            v-if="editingId === session.id"
            v-model="editName"
            v-focus
            class="card-rename"
            @pointerdown.stop
            @click.stop
            @keydown.enter.prevent="finishRename(session, true)"
            @keydown.esc.prevent="finishRename(session, false)"
            @blur="finishRename(session, true)"
          />
          <span v-else class="card-name" :class="{ 'search-hit': searchText && nameMatches(session) }">{{ session.name || "New session" }}</span>
          <span class="card-meta">{{ timeLabel(session.updatedAt) }}</span>
          <span v-if="hitCounts.get(session.id)" class="card-hits">{{ hitCounts.get(session.id) }} {{ hitCounts.get(session.id) === 1 ? "match" : "matches" }}</span>
          <div class="card-actions">
            <span v-if="busy(session)" class="card-clock" :class="busy(session)" :title="busy(session) === 'background' ? 'Waiting on a background task (Stop ends it)' : 'Responding'">
              <svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8" /><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
            </span>
            <button v-if="!session.trashed" v-show="!busy(session)" class="card-trash" title="Move this session to the trash" @pointerdown.stop @click.stop="trash(session, true)">&#x1F5D1;</button>
            <button v-else class="card-restore" title="Move this session out of the trash" @pointerdown.stop @click.stop="trash(session, false)">R</button>
            <span class="card-turns" title="Prompt turns">{{ session.turns.length }}</span>
          </div>
        </div>
      </div>
    </aside>
    <div class="divider" title="Drag to change the sidebar's width" @pointerdown="dragDivider"></div>
    <Pane ref="pane" :tab="tab" :active="active" :session="selected" :status="selected ? statuses[selected.id] ?? null : null" :version="version" :ceilings="ceilings" :search="searchText" @started="select" @deploy-due="(due) => (deployDue = due)" />
    <div v-if="side" class="divider side-divider" title="Drag to change the widths of the pane and this column" @pointerdown="dragSideDivider"></div>
    <Snips v-if="snipsOpened" :shown="snipsShown" :tab="tab" :add-to-prompt="(text) => pane?.appendPrompt(text) ?? false" @close="emit('closeSide')" />
    <Settings v-if="side === 'settings'" :tab="tab" :active="active" @close="emit('closeSide')" />
    <GitGraph v-if="side === 'git'" :tab="tab" :active="active" />
    <div v-if="side === 'term'" class="terms"><Term v-for="slot in terms" :key="slot" ref="termPanes" :tab="tab" :active="active" :index="slot" :count="terms.length" @add="addTerm" @exit="closeTerm(slot)" /></div>
    <Files v-if="side.startsWith('file')" ref="filesPane" :tab="tab" :active="active" :file-mode="side === 'file'" @open-file="emit('openFile')" @attach="(path) => pane?.attach(path, tab.host)" />
  </div>
</template>

<style>
/* The tab row's R (./run) button, highlighted as the Git button is when dirty (Git.vue). */
.tab.deploy-due { background: #fbd9d9; border-color: #e4a7a7; }
.tab.deploy-due:hover { background: linear-gradient(var(--wash), var(--wash)), #fbd9d9; }
/* Ported from claude2's sidebar. */
.project { height: 100%; min-height: 0; display: grid; grid-template-columns: var(--sidebar-width, 300px) 7px minmax(0, 1fr); }
/* The Snips (or Settings) column: --side-share (half by default, the side divider drags it) of what the sidebar leaves, the conversation pane keeping the rest.
   The pane's 1fr keeps an auto minimum, what its dock needs, and the column's minmax(0, ...) gives way to it, so a
   wider sidebar or a narrower window can't cover the footer or the boxes' text. */
.project.with-snips { grid-template-columns: var(--sidebar-width, 300px) 7px 1fr 7px minmax(0, calc((100vw - var(--sidebar-width, 300px)) * var(--side-share, 0.5))); }
/* Ctrl-B: with the sidebar and divider out of the grid, the pane moves over to the first column. */
.project.no-sidebar { grid-template-columns: minmax(0, 1fr); }
/* The Term pane's terminals, one to three, in equal rows. */
.terms { min-height: 0; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); grid-auto-rows: minmax(0, 1fr); }
.project.no-sidebar.with-snips { grid-template-columns: 1fr 7px minmax(0, calc(100vw * var(--side-share, 0.5))); }
.project.no-sidebar > .sidebar, .project.no-sidebar > .divider:not(.side-divider) { display: none; }
.sidebar { box-sizing: border-box; display: flex; flex-direction: column; gap: 10px; min-height: 0; padding: 10px; line-height: 1.5; }
/* The sidebar's old right border, now a wide-enough strip to grab. */
.project > .divider { cursor: col-resize; touch-action: none; background: linear-gradient(var(--border), var(--border)) center / 1px 100% no-repeat; }
.project > .divider:hover { background-image: linear-gradient(#9a9a93, #9a9a93); background-size: 3px 100%; }
.tabs .new svg { display: block; margin: 0 auto; width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
.sidebar .top { display: flex; flex-direction: column; gap: 7px; flex: none; }
.sidebar .row { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
/* Equal side columns hold the Trash button at the row's center whatever sits beside it. */
.sidebar .head { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 7px; align-items: center; }
.sidebar .head > :first-child { justify-self: start; }
.sidebar .top button { height: 25px; min-height: 0; flex: none; padding: 0 8px; }
.sidebar .trash-toggle.active { background: #fbd9d9; border-color: #e4a7a7; }
.sidebar .tabs-input { height: 25px; padding: 0 8px; }
.sidebar .tabs-input.searching { background: #cfe8ff; }
.sidebar .top .search-clear { width: 25px; padding: 0; }
.sidebar .counts { margin-left: 8px; font-size: 15px; }
.sidebar .offline { background: #fbd9d9; border: 1px solid #e4a7a7; border-radius: 8px; padding: 6px 8px; }
.sidebar .sessions { overflow: auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding-right: 2px; }
.sidebar .card { position: relative; flex: none; width: 100%; min-height: 42px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); cursor: pointer; user-select: none; }
.sidebar .card:hover { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
.sidebar .card.selected { background: #fbf3c4; border-color: #ddd08a; }
.sidebar .card.trashed.selected { background: #fce4ec; border-color: #eab3c6; }
.sidebar .card-actions { position: absolute; right: 6px; bottom: 6px; display: flex; align-items: center; gap: 6px; }
.sidebar .card-trash, .sidebar .card-restore { display: none; border: none; background: transparent; min-height: 0; padding: 2px 4px; font-size: 14px; line-height: 1; border-radius: 6px; }
.sidebar .card:hover .card-trash, .sidebar .card:hover .card-restore { display: block; }
.sidebar .card-trash:hover { background: #fbd9d9; }
.sidebar .card-restore { border: 1px solid var(--border); padding: 3px 8px; }
.sidebar .card-clock { display: flex; }
.sidebar .card-clock.running { color: #1a8f2e; }
.sidebar .card-clock.background { color: #d11a1a; }
.sidebar .card-name { display: block; overflow-wrap: anywhere; padding-right: 24px; }
.sidebar .card-rename { display: block; width: 100%; font: inherit; color: var(--ink); background: #fff; border: 1px solid #9a9a93; border-radius: 6px; padding: 1px 4px; }
.sidebar .card-meta { display: block; }
/* Every card whose name holds the search text at once, over the card's own yellow. */
.sidebar .card-name.search-hit { background: #ffc9c9; }
.sidebar .card-hits { display: block; color: #0b5ed7; }
.sidebar .empty { border: 1px dashed var(--border); border-radius: 8px; padding: 14px 10px; text-align: center; }
</style>
