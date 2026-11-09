<script setup lang="ts">
// The tab row's Tabs button and its dialog: a new project (host, folder, name) above the list of
// every project. Clicking a name opens or closes its project, holding it renames, ctrl-click
// deletes it for good. Each change goes to the project's backend and the new list comes back down
// the event stream, so the dialog always shows what the backend really did.
import { computed, ref, watch } from "vue";
import { HOSTS, type HostName, type Tab } from "../../shared/config.ts";
import { post, postHost } from "../api.ts";
import { folderName, sameName } from "../tabList.ts";

// Every project, in name order.
const props = defineProps<{ tabs: Tab[] }>();
const emit = defineEmits<{ show: [host: HostName, path: string]; closed: [] }>();

interface Folders {
  path: string;
  entries: { name: string; path: string }[];
}

const HOST_NAMES = Object.keys(HOSTS) as HostName[];
const dialog = ref<HTMLDialogElement>();
const picker = ref<HTMLDialogElement>();
const host = ref<HostName>("wsl");
const path = ref("");
const name = ref("");
// Typed by hand: a new folder no longer changes the name.
const edited = ref(false);
const creating = ref(false);
const error = ref("");
const editing = ref("");
const editName = ref("");
// The picker's box, and the backend's answer for the text it was last asked about.
const pickerPath = ref("");
const found = ref<Folders & { asked: string }>({ asked: "", path: "", entries: [] });
const pickerError = ref("");

const canCreate = computed(() => !!path.value && !!name.value.trim() && !creating.value);
// Only when the answer is about what the box says now.
const canPick = computed(() => !!found.value.path && found.value.asked === pickerPath.value);

const messageOf = (problem: unknown): string => (problem instanceof Error ? problem.message : String(problem));
const taken = (label: string, except = ""): boolean => props.tabs.some((tab) => tab.id !== except && sameName(tab.label, label));

function setPath(folder: string): void {
  path.value = folder;
  if (!edited.value) name.value = folderName(folder);
}
watch(host, () => setPath(""));

function open(): void {
  error.value = "";
  dialog.value?.showModal();
}

// Pointerdown, not click: a text selection dragged out of a box must not close the dialog. The
// target test leaves the dialog's contents out, the box test its padding.
function closeOnBackdrop(event: PointerEvent): void {
  const shown = event.currentTarget as HTMLDialogElement;
  const box = shown.getBoundingClientRect();
  if (event.target === shown && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) shown.close();
}

function attempt(work: Promise<unknown>): void {
  error.value = "";
  work.catch((problem) => (error.value = messageOf(problem)));
}

async function create(): Promise<void> {
  const label = name.value.trim();
  if (!canCreate.value) return;
  error.value = taken(label) ? `There is already a project called ${label}.` : "";
  if (error.value) return;
  creating.value = true;
  try {
    await postHost(host.value, "createProject", { label, path: path.value });
    emit("show", host.value, path.value);
    edited.value = false;
    setPath("");
  } catch (problem) {
    error.value = messageOf(problem);
  }
  creating.value = false;
}

async function list(folder: string): Promise<void> {
  pickerPath.value = folder;
  pickerError.value = "";
  try {
    const reply = await postHost<Folders>(host.value, "folders", { path: folder });
    if (folder === pickerPath.value) found.value = { asked: folder, ...reply };
  } catch (problem) {
    found.value = { asked: folder, path: "", entries: [] };
    pickerError.value = messageOf(problem);
  }
}

function openPicker(): void {
  found.value = { asked: "", path: "", entries: [] };
  void list(HOSTS[host.value].appsFolder);
  picker.value?.showModal();
}

function pick(): void {
  if (!canPick.value) return;
  setPath(found.value.path);
  picker.value?.close();
}

// As on a session card: a long press renames, and the click that ends it does nothing else.
let pressTimer = 0;
let held = false;
function press(tab: Tab, event: PointerEvent): void {
  held = editing.value === tab.id;
  if (held || event.ctrlKey) return;
  window.clearTimeout(pressTimer);
  pressTimer = window.setTimeout(() => {
    held = true;
    editing.value = tab.id;
    editName.value = tab.label;
  }, 650);
}
const unpress = (): void => window.clearTimeout(pressTimer);

function clickName(tab: Tab, event: MouseEvent): void {
  if (held) return;
  if (event.ctrlKey) return remove(tab);
  const open = !tab.open;
  attempt(post(tab, "openProject", { open }).then(() => open && emit("show", tab.host, tab.path)));
}

// ponytail: the project's unsent drafts and pictures stay in this browser, unreachable; clear them if storage ever fills.
function remove(tab: Tab): void {
  if (window.confirm(`Permanently delete the project "${tab.label}" and its sessions?\n\nThe folder ${tab.path} is left alone.\n\nThis cannot be undone.`)) attempt(post(tab, "deleteProject", {}));
}

function finishRename(tab: Tab, commit: boolean): void {
  if (editing.value !== tab.id) return;
  editing.value = "";
  const label = editName.value.trim();
  if (!commit || !label || label === tab.label) return;
  if (taken(label, tab.id)) error.value = `There is already a project called ${label}.`;
  else attempt(post(tab, "renameProject", { label }));
}
// The input is mounted by the rename that just started, so it takes focus as it appears.
const vFocus = { mounted: (el: HTMLInputElement) => (el.focus(), el.select()) };
</script>

<template>
  <button class="tab tabs-toggle" title="Add, open, close, rename or delete projects" aria-label="Tabs" @click="open">
    <svg viewBox="0 0 20 16" width="20" height="16" aria-hidden="true"><path d="M1 14.5V6h18v8.5zM2 6V2.5h4.5V6M7.75 6V2.5h4.5V6M13.5 6V2.5H18V6" /></svg>
  </button>
  <dialog ref="dialog" class="tabs-pop" @pointerdown="closeOnBackdrop" @close="emit('closed')">
    <section class="tabs-row">
      <select v-model="host" aria-label="Host"><option v-for="entry in HOST_NAMES" :key="entry">{{ entry }}</option></select>
      <button @click="openPicker">Path</button>
      <span class="tabs-path">{{ path }}</span>
      <button @click="dialog?.close()">Close</button>
    </section>
    <section class="tabs-row">
      <input v-model="name" class="tabs-input" placeholder="Project name" aria-label="Project name" spellcheck="false" @input="edited = !!($event.target as HTMLInputElement).value" @keydown.enter.prevent="create" />
      <button :disabled="!canCreate" @click="create">Create</button>
    </section>
    <div v-if="error" class="tabs-error">{{ error }}</div>
    <section class="tabs-names">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="tabs-name"
        :class="{ open: tab.open }"
        :title="`${tab.host}: ${tab.path}`"
        role="button"
        @pointerdown="press(tab, $event)"
        @pointerup="unpress"
        @pointercancel="unpress"
        @pointerleave="unpress"
        @click="clickName(tab, $event)"
      >
        <input
          v-if="editing === tab.id"
          v-model="editName"
          v-focus
          class="tabs-input"
          spellcheck="false"
          @pointerdown.stop
          @click.stop
          @keydown.enter.prevent="finishRename(tab, true)"
          @keydown.esc.prevent="finishRename(tab, false)"
          @blur="finishRename(tab, true)"
        />
        <template v-else>{{ tab.label }}</template>
      </div>
    </section>
  </dialog>
  <dialog ref="picker" class="tabs-pop tabs-picker" @pointerdown="closeOnBackdrop">
    <div class="tabs-row">
      <input class="tabs-input" :value="pickerPath" autofocus spellcheck="false" aria-label="Folder path" @input="list(($event.target as HTMLInputElement).value)" @keydown.enter.prevent="pick" />
      <button :disabled="!canPick" @click="pick">Ok</button>
    </div>
    <div v-if="pickerError" class="tabs-error">{{ pickerError }}</div>
    <div class="tabs-folders">
      <button v-for="entry in found.entries" :key="entry.path" class="tabs-folder" @click="list(entry.path)">{{ entry.name }}</button>
    </div>
  </dialog>
</template>

<style scoped>
/* With the row's 6px gap, twice the space the tabs have between them. */
.tabs-toggle { margin-right: 6px; }
.tabs-toggle svg { display: block; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linejoin: round; }
.tabs-pop { width: min(560px, 92vw); max-height: 86vh; padding: 12px; border: 1px solid #000; border-radius: 8px; background: var(--surface); color: var(--ink); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2); }
.tabs-pop[open] { display: flex; flex-direction: column; gap: 10px; }
.tabs-pop::backdrop { background: rgba(0, 0, 0, 0.15); }
.tabs-picker { height: min(480px, 86vh); }
.tabs-row { display: flex; align-items: center; gap: 8px; flex: none; }
.tabs-path { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.tabs-input { flex: 1; min-width: 0; width: 100%; padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; background: #fff; color: var(--ink); font: inherit; }
.tabs-input::placeholder { color: var(--ink); opacity: 1; }
.tabs-error { background: #fbd9d9; border: 1px solid #e4a7a7; border-radius: 6px; padding: 4px 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.tabs-names { overflow: auto; min-height: 0; padding-top: 10px; border-top: 1px solid var(--border); }
.tabs-row + .tabs-row { padding-top: 10px; border-top: 1px solid var(--border); }
.tabs-name { padding: 2px 6px; border-radius: 4px; cursor: pointer; user-select: none; }
.tabs-name:hover { background: var(--wash); }
.tabs-name.open { font-weight: 700; }
.tabs-folders { flex: 1; min-height: 0; overflow: auto; }
.tabs-folder { display: block; width: 100%; min-height: 0; padding: 2px 6px; border: none; border-radius: 4px; background: transparent; text-align: left; }
</style>
