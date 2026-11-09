<script setup lang="ts">
// One tab: claude2's sidebar column (ported from sidebarHtml) beside one conversation pane. The
// sessions come down the tab's event stream; picking a card shows that session in the pane, and
// the others keep running and show their clocks here. Left out for now: search, management,
// Close, Re-Auth.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { HOSTS, type Tab } from "../../shared/config.ts";
import { typedPrompt, type ClaudeSession, type RunningStatus, type ServerEvent } from "../../shared/types.ts";
import { listen, post } from "../api.ts";
import { pick } from "../pick.ts";
import Git from "./Git.vue";
import Pane from "./Pane.vue";
import Settings from "./Settings.vue";
import Snips from "./Snips.vue";

// active: this is the tab on show. side: what App's column toggles have open right of the pane
// ("", "snips" or "settings"; one for every tab). focusAsked: a change puts the cursor in the
// prompt box of the tab on show.
const props = defineProps<{ tab: Tab; active: boolean; side: string; focusAsked: number }>();
const emit = defineEmits<{ busy: [count: number]; closeSide: []; highlighted: [on: boolean] }>();

// Plain objects mutated in place as text streams in; `version` tells Vue when the shape changed.
let sessions: ClaudeSession[] = [];
const version = ref(0);
const statuses = ref<Record<string, RunningStatus>>({});
const ceilings = ref(0);
const selectedKey = `claude3.session.${props.tab.id}`;
// '' is the new-session draft: the pane is empty until its first prompt makes the session.
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
const visible = computed(() => {
  void version.value;
  // Newest first by the time each card shows.
  return sessions.filter((session) => session.trashed === showTrash.value).sort((a, b) => b.updatedAt - a.updatedAt);
});
const counts = computed(() => {
  void version.value;
  const trashed = sessions.filter((session) => session.trashed).length;
  return { active: sessions.length - trashed, trashed };
});
const busy = (session: ClaudeSession): string => {
  const status = statuses.value[session.id];
  return status?.active ? (status.phase === "background" ? "background" : "running") : "";
};

function setStatus(id: string, status: RunningStatus | null): void {
  const next = { ...statuses.value };
  if (status?.active) next[id] = status;
  else delete next[id];
  statuses.value = next;
}

function onEvent(event: ServerEvent): void {
  if (event.type === "state") {
    sessions = event.sessions;
    statuses.value = event.statuses;
    if (selectedId.value && !sessions.some((session) => session.id === selectedId.value)) selectedId.value = "";
    version.value++;
  } else if (event.type === "session") {
    const at = sessions.findIndex((session) => session.id === event.session.id);
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
  }
}

function select(id: string): void {
  selectedId.value = id;
}

// claude2's "+": a "New session" card, opened in the pane. Attention moving on (another card,
// Clean, Trash, "+" again) sweeps it away while it is still empty and holds no typing.
async function newSession(): Promise<void> {
  showTrash.value = false;
  try {
    const { session } = await post<{ session: ClaudeSession }>(props.tab, "new", { keep: keepIds() });
    if (!sessions.some((entry) => entry.id === session.id)) onEvent({ type: "session", session, status: null });
    selectedId.value = session.id;
    focusPrompt();
  } catch (error) {
    report(error);
  }
}

function keepIds(keep = ""): string[] {
  return [keep, ...(pane.value?.drafted() ?? [])].filter(Boolean);
}
function sweep(keep = ""): void {
  if (sessions.some((session) => !session.turns.length)) void post(props.tab, "discard", { keep: keepIds(keep) }).catch(report);
}

// claude2's Clean: every session to the trash, the pane back to a new-session draft.
function clean(): void {
  sweep();
  selectedId.value = "";
  void post(props.tab, "clean", {}).catch(report);
}

function toggleTrash(): void {
  sweep();
  showTrash.value = !showTrash.value;
}

// claude2's delete for good: one question for the whole pick.
function deletePicked(): void {
  const ids = [...picked.value];
  const question = ids.length === 1 ? `Permanently delete "${sessions.find((session) => session.id === ids[0])?.name || "this session"}"?` : `Permanently delete the ${ids.length} selected sessions?`;
  if (!window.confirm(`${question}\n\nThis cannot be undone.`)) return;
  void post(props.tab, "delete", { sessionIds: ids }).catch(report);
}

function focusPrompt(): void {
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

function trash(session: ClaudeSession, trashed: boolean): void {
  sweep(session.turns.length ? "" : session.id);
  // Trashing the open card opens the one below it (or above, if it was the last).
  if (trashed && session.id === selectedId.value) {
    const list = visible.value;
    const at = list.findIndex((entry) => entry.id === session.id);
    selectedId.value = (list[at + 1] ?? list[at - 1])?.id ?? "";
  }
  void post(props.tab, "trash", { sessionId: session.id, trashed }).catch(report);
}

function report(error: unknown): void {
  window.alert(error instanceof Error ? error.message : String(error));
}

// A long press renames; a plain click opens; alt-click copies the name.
let pressTimer = 0;
let renamed = false;
function press(session: ClaudeSession, event: PointerEvent): void {
  if (event.altKey) return;
  renamed = editingId.value === session.id;
  if (renamed) return;
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
    void navigator.clipboard.writeText(session.name || "");
    (event.currentTarget as HTMLElement).animate([{ backgroundColor: "#ffc9c9" }, { backgroundColor: "#ffc9c9" }], 200);
    return;
  }
  sweep(session.id);
  if (renamed) return;
  if (showTrash.value) {
    pickAnchor = pick(picked.value, visible.value.map((entry) => entry.id), session.id, pickAnchor, event);
    if (event.ctrlKey || event.shiftKey) return;
  }
  selectedId.value = session.id;
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
// Only a trashed card on show can stay picked, so the delete button never reaches one out of sight.
watch(visible, (list) => (picked.value = new Set(list.filter((session) => session.trashed && picked.value.has(session.id)).map((session) => session.id))));
watch(statuses, (all) => emit("busy", Object.values(all).filter((status) => status.active).length));
// The Git and Run buttons' highlights, for the indicator in App's tab strip.
const gitDirty = ref(false);
const deployDue = ref(false);
watch(() => gitDirty.value || deployDue.value, (on) => emit("highlighted", on));
// Picking a tab puts the cursor in its prompt box; post, so the tab is on show by then.
watch(() => props.active, (active) => active && focusPrompt(), { flush: "post" });
watch(() => props.side, (open) => !open && props.active && focusPrompt(), { flush: "post" });
watch(() => props.focusAsked, () => props.active && focusPrompt(), { flush: "post" });

let stopListening = (): void => undefined;
onMounted(() => {
  stopListening = listen(props.tab, onEvent, (up) => (connected.value = up));
  if (props.active) focusPrompt();
});
onBeforeUnmount(() => stopListening());
</script>

<template>
  <div class="project" :class="{ 'with-snips': side && active }">
    <aside class="sidebar">
      <div class="top">
        <div class="row">
          <button class="new" title="New session" @click="newSession">
            <svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" /></svg>
          </button>
          <Git :tab="tab" :active="active" :version="version" @closed="focusPrompt" @dirty="(dirty) => (gitDirty = dirty)" />
        </div>
        <div class="row">
          <button v-if="showTrash" class="delete" title="Permanently delete the selected trashed sessions. Ctrl-click or shift-click a card to select more" :disabled="!picked.size" @click="deletePicked">&#x1F5D1;{{ picked.size ? ` ${picked.size}` : "" }}</button>
          <button v-else class="clean" title="Move every session to the trash" :disabled="!counts.active" @click="clean">Clean</button>
          <button class="trash-toggle" :class="{ active: showTrash }" :title="showTrash ? 'Show active sessions' : 'Show trashed sessions'" @click="toggleTrash">Trash</button>
          <span class="counts" title="Active sessions / trashed sessions">{{ counts.active }}/{{ counts.trashed }}</span>
        </div>
        <div v-if="!connected" class="offline">No answer from the {{ tab.host }} backend at {{ HOSTS[tab.host].url }}. Retrying.</div>
      </div>
      <div class="sessions">
        <div v-if="!visible.length" class="empty">{{ showTrash ? "Trash is empty" : "No sessions yet" }}</div>
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
          <span v-else class="card-name">{{ session.name || "New session" }}</span>
          <span class="card-meta">{{ timeLabel(session.updatedAt) }}</span>
          <div class="card-actions">
            <span v-if="busy(session)" class="card-clock" :class="busy(session)" :title="busy(session) === 'background' ? 'Waiting on a background task (Stop ends it)' : 'Responding'">
              <svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8" /><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
            </span>
            <button v-if="!session.trashed" class="card-trash" title="Move this session to the trash" @pointerdown.stop @click.stop="trash(session, true)">&#x1F5D1;</button>
            <button v-else class="card-restore" title="Move this session out of the trash" @pointerdown.stop @click.stop="trash(session, false)">R</button>
            <span class="card-turns" title="Prompt turns">{{ session.turns.length }}</span>
          </div>
        </div>
      </div>
    </aside>
    <div class="divider" title="Drag to change the sidebar's width" @pointerdown="dragDivider"></div>
    <Pane ref="pane" :tab="tab" :active="active" :session="selected" :status="selected ? statuses[selected.id] ?? null : null" :version="version" :ceilings="ceilings" @started="select" @deploy-due="(due) => (deployDue = due)" />
    <Snips v-if="side === 'snips' && active" :tab="tab" :add-to-prompt="(text) => pane?.appendPrompt(text) ?? false" @close="emit('closeSide')" />
    <Settings v-if="side === 'settings' && active" :tab="tab" @close="emit('closeSide')" />
  </div>
</template>

<style>
/* Ported from claude2's sidebar. */
.project { height: 100%; min-height: 0; display: grid; grid-template-columns: var(--sidebar-width, 300px) 7px minmax(0, 1fr); }
/* The Snips (or Settings) column: half of what the sidebar leaves, the conversation pane keeping the rest. */
.project.with-snips { grid-template-columns: var(--sidebar-width, 300px) 7px minmax(0, 1fr) calc((100vw - var(--sidebar-width, 300px)) / 2); }
.sidebar { box-sizing: border-box; display: flex; flex-direction: column; gap: 10px; min-height: 0; padding: 10px; line-height: 1.5; }
/* The sidebar's old right border, now a wide-enough strip to grab. */
.project > .divider { cursor: col-resize; touch-action: none; background: linear-gradient(var(--border), var(--border)) center / 1px 100% no-repeat; }
.project > .divider:hover { background-image: linear-gradient(#9a9a93, #9a9a93); background-size: 3px 100%; }
.sidebar .new { width: 42px; }
.sidebar .new svg { display: block; margin: 0 auto; width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
.sidebar .top { display: flex; flex-direction: column; gap: 7px; flex: none; }
.sidebar .row { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
.sidebar .top button { height: 25px; min-height: 0; flex: none; padding: 0 8px; }
.sidebar .trash-toggle.active { background: #fbd9d9; border-color: #e4a7a7; }
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
.sidebar .empty { border: 1px dashed var(--border); border-radius: 8px; padding: 14px 10px; text-align: center; }
</style>
