<script setup lang="ts">
// The Files column, in the Snips' place: a VS Code-style tree on the tab's host or, in file mode,
// one file in FileEditor. Click a folder to open it, double-click to make it the root; click a file
// to put it on the Windows clipboard, double-click to edit it. Ctrl-click deletes, alt-click copies
// the path, shift-click on a folder pastes the clipboard's files into it, a long press renames.
// Files dragged from Explorer land on the folder under them. The header's path row stands for the
// root folder, which has no row of its own, for paste and drop.
// The tree holds only what the backend last said: each open folder is asked for again every 2s.
// ponytail: polling, not file watches; change it if the 2s lag or the traffic ever matters.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type { HostName, Tab } from "../../shared/config.ts";
import type { FileEntry } from "../../shared/types.ts";
import { post, postHost, upload } from "../api.ts";
import { foldersBetween } from "../tabList.ts";
import FileEditor from "./FileEditor.vue";
import FolderPicker from "./FolderPicker.vue";

// fileMode: App's column is showing the file. openFile asks for that; App's Files button leaves it.
const props = defineProps<{ tab: Tab; fileMode: boolean }>();
const emit = defineEmits<{ close: []; openFile: [] }>();

const roots = computed(() => props.tab.roots ?? []);
const root = computed(() => roots.value.at(-1) ?? props.tab.path);
const listings = reactive(new Map<string, FileEntry[]>());
const openKey = `filesOpen:${props.tab.id}`;
const lastKey = `filesLast:${props.tab.id}`;
const opened = reactive(new Set<string>(JSON.parse(localStorage.getItem(openKey) ?? "[]") as string[]));
const last = ref(localStorage.getItem(lastKey) ?? "");
watch(() => [...opened], (folders) => localStorage.setItem(openKey, JSON.stringify(folders)));
watch(last, (folder) => localStorage.setItem(lastKey, folder));

const note = ref("");
const listProblem = ref("");
const file = ref<{ path: string; text: string; mtime: number } | null>(null);
// The row a clipboard or drop job is running on, and the folder a drag is over.
const working = ref("");
const dragTarget = ref("");
const renaming = ref("");
const newName = ref("");
const picker = ref<InstanceType<typeof FolderPicker>>();
const tree = ref<HTMLElement>();

const rows = computed(() => {
  const out: (FileEntry & { depth: number })[] = [];
  const walk = (folder: string, depth: number): void => {
    for (const entry of listings.get(folder) ?? []) {
      out.push({ ...entry, depth });
      if (entry.dir && opened.has(entry.path)) walk(entry.path, depth + 1);
    }
  };
  walk(root.value, 0);
  return out;
});
type Row = (typeof rows.value)[number];

const messageOf = (problem: unknown): string => (problem instanceof Error ? problem.message : String(problem));
const openRows = (): string[] => rows.value.filter((row) => row.dir && opened.has(row.path)).map((row) => row.path);

// Goes round again for folders the last answer brought into view (open ones remembered from before).
async function listAll(): Promise<void> {
  try {
    do {
      again = false;
      const shown = root.value;
      const reply = await post<{ listings: Record<string, FileEntry[] | null> }>(props.tab, "listFiles", { paths: [shown, ...openRows()] });
      listProblem.value = reply.listings[shown] ? "" : `${shown} no longer exists or can't be read.`;
      for (const [folder, entries] of Object.entries(reply.listings)) {
        if (entries) {
          listings.set(folder, entries);
        } else {
          listings.delete(folder);
          opened.delete(folder);
        }
      }
    } while (again || openRows().some((folder) => !listings.has(folder)));
  } catch (problem) {
    listProblem.value = messageOf(problem);
  }
}
let listing: Promise<void> | null = null;
let again = false;
function refresh(): Promise<void> {
  if (listing) {
    again = true;
    return listing;
  }
  listing = listAll().finally(() => (listing = null));
  return listing;
}

function attempt(work: Promise<unknown>): Promise<void> {
  note.value = "";
  return work.then(() => refresh()).catch((problem) => void (note.value = messageOf(problem)));
}

// The backend's list comes back as a projects event, and with it the new root.
const setRoots = (next: string[]): Promise<void> => attempt(post(props.tab, "setRoots", { roots: next }));

function collapse(): void {
  opened.clear();
  last.value = "";
}

const newFile = (): Promise<void> => attempt(post(props.tab, "newFile", { folder: opened.has(last.value) && foldersBetween(root.value, last.value) ? last.value : root.value }));

// A picked folder under the root is opened down to and shown; any other becomes a new root.
async function goTo(folder: string): Promise<void> {
  if (folder === root.value) return;
  const chain = foldersBetween(root.value, folder);
  if (!chain) return setRoots([...roots.value, folder]);
  chain.forEach((entry) => opened.add(entry));
  last.value = folder;
  await refresh();
  await nextTick();
  tree.value?.querySelector(`[data-drop="${CSS.escape(folder)}"]`)?.scrollIntoView({ block: "nearest" });
}

// A srv tab's clipboard work is done by WSL's backend: the clipboard is on the laptop.
const clipHost = computed<HostName>(() => (props.tab.host === "srv" ? "wsl" : props.tab.host));
function clipboardJob(target: string, action: string, body: Record<string, unknown>): void {
  working.value = target;
  void attempt(postHost(clipHost.value, action, { host: props.tab.host, ...body })).finally(() => (working.value = ""));
}
const paste = (folder: string): void => clipboardJob(folder, "clipPaste", { folder });

function remove(row: Row): void {
  const what = row.dir ? `the folder ${row.path} and everything in it` : row.path;
  if (window.confirm(`Permanently delete ${what}?\n\nThis cannot be undone.`)) void attempt(post(props.tab, "deletePath", { path: row.path }));
}

// A single click on a file waits, so the first click of a double-click doesn't replace the clipboard.
let clickTimer = 0;
function clickRow(row: Row, event: MouseEvent): void {
  if (held) return;
  if (event.ctrlKey) return remove(row);
  if (event.altKey) return void attempt(navigator.clipboard.writeText(row.path));
  if (event.shiftKey) return row.dir ? paste(row.path) : undefined;
  if (!row.dir) {
    window.clearTimeout(clickTimer);
    clickTimer = window.setTimeout(() => clipboardJob(row.path, "clipCopy", { path: row.path }), 300);
  } else if (!opened.delete(row.path)) {
    opened.add(row.path);
    last.value = row.path;
    void refresh();
  }
}

async function openRow(row: Row): Promise<void> {
  note.value = "";
  try {
    const reply = await post<{ mtime: number; text: string | null }>(props.tab, "readFile", { path: row.path });
    if (reply.text === null) return;
    file.value = { path: row.path, text: reply.text, mtime: reply.mtime };
    emit("openFile");
  } catch (problem) {
    note.value = messageOf(problem);
  }
}

function doubleClickRow(row: Row, event: MouseEvent): void {
  if (held || event.ctrlKey || event.altKey || event.shiftKey) return;
  window.clearTimeout(clickTimer);
  if (row.dir) void setRoots([...roots.value, row.path]);
  else void openRow(row);
}

// As on a session card: a long press renames, and the click that ends it does nothing else.
let pressTimer = 0;
let held = false;
function press(row: Row, event: PointerEvent): void {
  held = renaming.value === row.path;
  if (held || event.button || event.ctrlKey || event.altKey || event.shiftKey) return;
  window.clearTimeout(pressTimer);
  pressTimer = window.setTimeout(() => {
    held = true;
    renaming.value = row.path;
    newName.value = row.name;
  }, 650);
}
const unpress = (): void => window.clearTimeout(pressTimer);

// What was open under a renamed folder is still open.
function moved(from: string, to: string): void {
  const follow = (folder: string): string => (folder === from || foldersBetween(from, folder) ? to + folder.slice(from.length) : folder);
  const folders = [...opened].map(follow);
  opened.clear();
  folders.forEach((folder) => opened.add(folder));
  last.value = follow(last.value);
}

function finishRename(row: Row, commit: boolean): void {
  if (renaming.value !== row.path) return;
  renaming.value = "";
  const name = newName.value.trim();
  if (commit && name && name !== row.name) void attempt(post<{ path: string }>(props.tab, "renamePath", { path: row.path, name }).then((reply) => moved(row.path, reply.path)));
}
// The name without its extension is selected, as VS Code does.
const vFocus = {
  mounted: (el: HTMLInputElement) => {
    const dot = el.value.lastIndexOf(".");
    el.focus();
    el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
  },
};

// By position, not the event's target: Firefox can make that a text node.
const folderUnder = (event: DragEvent): string => document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-drop]")?.dataset.drop ?? "";
function dragOver(event: DragEvent): void {
  dragTarget.value = folderUnder(event);
  event.dataTransfer!.dropEffect = dragTarget.value ? "copy" : "none";
}
function dragLeave(event: DragEvent): void {
  if (!(event.currentTarget as Node).contains(event.relatedTarget as Node | null)) dragTarget.value = "";
}
function drop(event: DragEvent): void {
  const folder = folderUnder(event);
  dragTarget.value = "";
  if (!folder) return;
  const dropped = [...event.dataTransfer!.files];
  working.value = folder;
  void attempt((async () => {
    for (const item of dropped) await upload(props.tab, folder, item);
  })()).finally(() => (working.value = ""));
}

let poller = 0;
watch([root, () => props.fileMode], () => void refresh());
onMounted(() => {
  void refresh();
  poller = window.setInterval(() => !document.hidden && !props.fileMode && void refresh(), 2000);
});
onBeforeUnmount(() => {
  window.clearInterval(poller);
  window.clearTimeout(clickTimer);
  window.clearTimeout(pressTimer);
});
</script>

<template>
  <div class="files" @dragover.prevent="dragOver" @dragleave="dragLeave" @drop.prevent="drop">
    <FileEditor v-if="fileMode && file" :tab="tab" :file="file" />
    <div v-show="!fileMode" class="files-mode">
      <div class="files-bar">
        <button title="Back to the previous root" aria-label="Back" :disabled="!roots.length" @click="setRoots(roots.slice(0, -1))">
          <svg viewBox="0 0 20 16"><path d="M18 3h-6C8.5 3 8.5 12 5 12H2M6 8.5 2 12l4 3.5" /></svg>
        </button>
        <button title="Close all folders" aria-label="Collapse" @click="collapse">
          <svg viewBox="0 0 16 16"><rect x="1.5" y="4.5" width="10" height="10" rx="1" /><path d="M4 9.5h5M4.5 1.5h10v10" /></svg>
        </button>
        <button title="New empty file in the last folder opened" @click="newFile">New</button>
        <button title="Show a folder in the tree" @click="picker?.open(root)">Path</button>
        <button class="files-close" @click="emit('close')">Close</button>
      </div>
      <div class="files-root" :class="{ drop: dragTarget === root, working: working === root }" :data-drop="root" title="Shift-click to paste the clipboard's files here" @click.shift="paste(root)">{{ root }}</div>
      <div v-if="note || listProblem" class="files-note">{{ note || listProblem }}</div>
      <div ref="tree" class="files-tree">
        <div
          v-for="row in rows"
          :key="row.path"
          class="files-row"
          :class="{ drop: dragTarget === row.path, working: working === row.path }"
          :data-drop="row.dir ? row.path : undefined"
          :title="row.path"
          role="button"
          @pointerdown="press(row, $event)"
          @pointerup="unpress"
          @pointercancel="unpress"
          @pointerleave="unpress"
          @click="clickRow(row, $event)"
          @dblclick="doubleClickRow(row, $event)"
        >
          <span v-for="depth in row.depth" :key="depth" class="files-guide"></span>
          <svg class="files-chevron" :class="{ open: opened.has(row.path) }" viewBox="0 0 16 16"><path v-if="row.dir" d="M6 3.5 10.5 8 6 12.5" /></svg>
          <svg class="files-icon" viewBox="0 0 16 16"><path :d="row.dir ? 'M1.5 13.5v-11h4.5l1.5 2h7v9z' : 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3'" /></svg>
          <input v-if="renaming === row.path" v-model="newName" v-focus class="files-rename" spellcheck="false" @pointerdown.stop @click.stop @dblclick.stop @keydown.enter.prevent="finishRename(row, true)" @keydown.esc.prevent="finishRename(row, false)" @blur="finishRename(row, true)" />
          <span v-else class="files-name">{{ row.name }}</span>
        </div>
      </div>
      <FolderPicker ref="picker" :host="tab.host" @pick="goTo" />
    </div>
  </div>
</template>

<style scoped>
.files { min-height: 0; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-left: 1px solid var(--border); background: var(--page); }
.files-mode { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; }
.files-bar { flex: none; display: flex; align-items: center; gap: 6px; }
.files-bar button { min-height: 0; padding: 3px 10px; }
.files-bar svg { display: block; width: 20px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.files-close { margin-left: auto; }
.files-root { flex: none; padding: 2px 6px; border-radius: 4px; overflow-wrap: anywhere; }
.files-note { flex: none; background: #fbd9d9; border: 1px solid #e4a7a7; border-radius: 8px; padding: 4px 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.files-tree { flex: 1; min-height: 0; overflow: auto; padding: 4px 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); user-select: none; }
.files-row { display: flex; align-items: center; width: max-content; min-width: 100%; height: 24px; padding: 0 8px 0 6px; cursor: pointer; white-space: nowrap; }
.files-row:hover { background: var(--wash); }
.files-row.working, .files-root.working { background: #fbf3c4; }
.files-row.drop, .files-root.drop { background: #cfe8ff; box-shadow: inset 0 0 0 1px #8fb8e0; }
/* VS Code's indent guides: shown while the pointer is over the tree, under the parent's chevron. */
.files-guide { flex: none; align-self: stretch; width: 12px; }
.files-tree:hover .files-guide { background: linear-gradient(var(--border), var(--border)) 8px 0 / 1px 100% no-repeat; }
.files-chevron, .files-icon { flex: none; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.2; stroke-linecap: round; stroke-linejoin: round; }
.files-chevron.open { transform: rotate(90deg); }
.files-icon { margin: 0 5px 0 2px; }
.files-rename { flex: 1; min-width: 120px; padding: 0 4px; border: 1px solid #9a9a93; border-radius: 4px; background: #fff; color: var(--ink); font: inherit; }
</style>
