<script setup lang="ts">
// The tab row's Tabs button and its dialog: a new project (host, folder, name) above the list of
// every project. Clicking a name opens or closes its project, holding it renames, ctrl-click
// deletes it for good. Each change goes to the project's backend and the new list comes back down
// the event stream, so the dialog always shows what the backend really did.
import { computed, ref, watch } from "vue";
import { HOSTS, type HostName, type Tab } from "../../shared/config.ts";
import { post, postHost } from "../api.ts";
import { folderName, sameName } from "../tabList.ts";
import FolderPicker from "./FolderPicker.vue";

// Every project, in name order, which have their Git or Run button highlighted, open or closed, and how many sessions each has running.
const props = defineProps<{ tabs: Tab[]; highlighted: Record<string, boolean>; busy: Record<string, number> }>();
const emit = defineEmits<{ show: [host: HostName, path: string]; closed: [] }>();

const HOST_NAMES = Object.keys(HOSTS) as HostName[];
const button = ref<HTMLButtonElement>();
const dialog = ref<HTMLDialogElement>();
const picker = ref<InstanceType<typeof FolderPicker>>();
const host = ref<HostName>("wsl");
const path = ref("");
const name = ref("");
// Typed by hand: a new folder no longer changes the name.
const edited = ref(false);
const creating = ref(false);
const error = ref("");
const editing = ref("");
const editName = ref("");

const due = computed(() => props.tabs.some((tab) => props.highlighted[tab.id]));
const running = computed(() => props.tabs.some((tab) => props.busy[tab.id]));
const canCreate = computed(() => !!path.value && !!name.value.trim() && !creating.value);

const messageOf = (problem: unknown): string => (problem instanceof Error ? problem.message : String(problem));
const taken = (label: string, except = ""): boolean => props.tabs.some((tab) => tab.id !== except && sameName(tab.label, label));

function setPath(folder: string): void {
  path.value = folder;
  if (!edited.value) name.value = folderName(folder);
}
// Sync, so openWith's folder isn't emptied by this running after it.
watch(host, () => setPath(""), { flush: "sync" });

function open(event?: MouseEvent): void {
  if (event?.ctrlKey) return openFlagged();
  error.value = "";
  // Upper left, just under the button.
  const { left, bottom } = button.value!.getBoundingClientRect();
  dialog.value!.style.margin = `${bottom + 4}px 0 0 ${left}px`;
  dialog.value!.showModal();
}

// Ctrl-click on the button: open every closed project with a red or green dot, no dialog.
function openFlagged(): void {
  const flagged = props.tabs.filter((tab) => !tab.open && (props.highlighted[tab.id] || props.busy[tab.id]));
  Promise.all(flagged.map((tab) => post(tab, "openProject", { open: true })))
    .catch((problem) => window.alert(messageOf(problem)))
    .finally(() => emit("closed"));
}

// The Files bar's Prj: the new-project fields filled in from a folder.
function openWith(onHost: HostName, folder: string): void {
  host.value = onHost;
  edited.value = false;
  setPath(folder);
  open();
}
defineExpose({ openWith });

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
  attempt(post(tab, "openProject", { open }).then(() => {
    if (!open) return;
    emit("show", tab.host, tab.path);
    dialog.value?.close();
  }));
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
  <button ref="button" class="tab tabs-toggle" :class="{ due: due && !running, running }" :title="`Add, open, close, rename or delete projects${running ? '. A project has a session running' : due ? '. A project has its Git or Run button highlighted' : ''}`" aria-label="Tabs" data-help="Tabs button" @click="open">
    <svg viewBox="0 0 20 16" width="20" height="16" aria-hidden="true"><path d="M1 14.5V6h18v8.5zM2 6V2.5h4.5V6M7.75 6V2.5h4.5V6M13.5 6V2.5H18V6" /></svg>
  </button>
  <dialog ref="dialog" class="tabs-pop" closedby="any" @close="emit('closed')">
    <section class="tabs-row">
      <select v-model="host" aria-label="Host" data-help="Tabs host"><option v-for="entry in HOST_NAMES" :key="entry">{{ entry }}</option></select>
      <button data-help="Tabs Path button" @click="picker?.open(HOSTS[host].appsFolder)">Path</button>
      <button class="tabs-close" data-help="Tabs Close button" @click="dialog?.close()">Close</button>
    </section>
    <div v-if="path" class="tabs-path">{{ path }}</div>
    <section class="tabs-row">
      <input v-model="name" class="tabs-input" placeholder="Project name" aria-label="Project name" data-help="Tabs name box" spellcheck="false" @input="edited = !!($event.target as HTMLInputElement).value" @keydown.enter.prevent="create" />
      <button :disabled="!canCreate" data-help="Tabs Create button" @click="create">Create</button>
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
        data-help="Tabs project name"
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
          data-help="rename box"
          @pointerdown.stop
          @click.stop
          @keydown.enter.prevent="finishRename(tab, true)"
          @keydown.esc.prevent="finishRename(tab, false)"
          @blur="finishRename(tab, true)"
        />
        <template v-else><span v-if="busy[tab.id] || highlighted[tab.id]" class="tab-dot" :class="{ due: !busy[tab.id] }" :title="busy[tab.id] ? 'Responding' : 'Git or Run is highlighted'">&#x25CF;</span>{{ tab.host }}:&nbsp;&nbsp; {{ tab.label }}</template>
      </div>
    </section>
  </dialog>
  <FolderPicker ref="picker" :host="host" @pick="setPath" />
</template>

<!-- Not scoped: FolderPicker's dialog wears these too, wherever it is used. -->
<style>
/* With the row's 6px gap, twice the space the tabs have between them. */
.tabs-toggle { margin-right: 6px; color: #666; }
.tabs-toggle.due { background: #fbd9d9; border-color: #e4a7a7; }
.tabs-toggle.due:hover { background: linear-gradient(var(--wash), var(--wash)), #fbd9d9; }
.tabs-toggle.running { background: #e3f6e4; border-color: #a5d6a7; }
.tabs-toggle.running:hover { background: linear-gradient(var(--wash), var(--wash)), #e3f6e4; }
.tabs-toggle svg { display: block; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linejoin: round; }
.tabs-pop { width: min(280px, 92vw); max-height: 86vh; padding: 12px; border: 1px solid #000; border-radius: 8px; background: var(--surface); color: var(--ink); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2); }
.tabs-pop[open] { display: flex; flex-direction: column; gap: 10px; }
.tabs-pop::backdrop { background: rgba(0, 0, 0, 0.15); }
.tabs-picker { width: min(560px, 92vw); height: min(480px, 86vh); }
.tabs-row { display: flex; align-items: center; gap: 8px; flex: none; }
.tabs-path { overflow-wrap: anywhere; }
.tabs-close { margin-left: auto; }
.tabs-input { flex: 1; min-width: 0; width: 100%; padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; background: #fff; color: var(--ink); font: inherit; }
.tabs-input::placeholder { color: var(--ink); opacity: 1; }
.tabs-error { background: #fbd9d9; border: 1px solid #e4a7a7; border-radius: 6px; padding: 4px 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.tabs-names { overflow: auto; min-height: 0; padding-top: 10px; border-top: 1px solid var(--border); }
.tabs-row + .tabs-row, .tabs-path + .tabs-row { padding-top: 10px; border-top: 1px solid var(--border); }
.tabs-name { padding: 2px 6px; border-radius: 4px; cursor: pointer; user-select: none; }
.tabs-name:hover { background: var(--wash); }
.tabs-name.open { font-weight: 700; }
.tabs-folders { flex: 1; min-height: 0; overflow: auto; }
.tabs-folder { display: block; width: 100%; min-height: 0; padding: 2px 6px; border: none; border-radius: 4px; background: transparent; text-align: left; }
/* Folders, apart from the files. A folder picker's files can't be picked, but stay solid black. */
.tabs-dir { font-weight: 700; }
.tabs-folder:disabled::after { content: none; }
</style>
