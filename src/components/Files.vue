<script lang="ts">
// Ctrl-X's item, here because the Ctrl-V can come in any tab's tree. clip is the clipboard's name for it.
let cut: { tab: Tab; path: string; clip: string } | null = null;
</script>

<script setup lang="ts">
// The Files column, in the Snips' place: a VS Code-style tree on the tab's host or, in file mode,
// one file in FileEditor. Click a folder to open it, double-click to make it the root; double-click
// a file to edit it, or ctrl-double-click a .md to read it rendered; alt-click copies the path. One row can be selected, remembered per root: a
// click on a file or a ctrl-click on anything toggles it, and the keys act on it (keyDown).
// Files dragged from Explorer land on the folder under them. The header's path row stands for the
// root folder, which has no row of its own, for drop.
// The tree holds only what the backend last said: each open folder is asked for again every 2s.
// ponytail: polling, not file watches; change it if the 2s lag or the traffic ever matters.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type { HostName, Tab } from "../../shared/config.ts";
import type { FileEntry } from "../../shared/types.ts";
import { post, postHost, upload } from "../api.ts";
import { copy, copyCodeBlock } from "../copy.ts";
import { renderMarkdown } from "../render.ts";
import { foldersBetween, sameName } from "../tabList.ts";
import FileEditor from "./FileEditor.vue";
import FolderPicker from "./FolderPicker.vue";

// fileMode: App's column is showing the file. openFile asks for that; App's Files button leaves it.
const props = defineProps<{ tab: Tab; fileMode: boolean }>();
const emit = defineEmits<{ openFile: [] }>();

const roots = computed(() => props.tab.roots ?? []);
const rootIdx = computed(() => props.tab.rootIdx ?? roots.value.length - 1);
const root = computed(() => roots.value[rootIdx.value] ?? props.tab.path);
const listings = reactive(new Map<string, FileEntry[]>());
const openKey = `filesOpen:${props.tab.id}`;
const selectKey = `filesSelected:${props.tab.id}`;
const opened = reactive(new Set<string>(JSON.parse(localStorage.getItem(openKey) ?? "[]") as string[]));
// Each root's selected path. A selected row may be out of sight, or gone from the disk.
const selections = reactive<Record<string, string>>(JSON.parse(localStorage.getItem(selectKey) ?? "{}"));
watch(() => [...opened], (folders) => localStorage.setItem(openKey, JSON.stringify(folders)));
watch(selections, (all) => localStorage.setItem(selectKey, JSON.stringify(all)));
const selected = computed(() => selections[root.value] ?? "");
function select(path: string): void {
  if (path) selections[root.value] = path;
  else delete selections[root.value];
}

const note = ref("");
const listProblem = ref("");
// rendered: shown as markdown, read-only, instead of in the editor.
const file = ref<{ path: string; text: string; mtime: number; rendered: boolean } | null>(null);
// The row a clipboard or drop job is running on, and the folder a drag is over.
const working = ref("");
const dragTarget = ref("");
const renaming = ref("");
const newName = ref("");
const picker = ref<InstanceType<typeof FolderPicker>>();
const tree = ref<HTMLElement>();
const treeArea = ref<HTMLElement>();

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

// What the keys act on: a selection out of sight counts as none.
const selectedRow = computed(() => rows.value.find((row) => row.path === selected.value));
// The folders that have to be open for a row under the root to show.
const wayTo = (path: string): string[] => (foldersBetween(root.value, path) ?? []).slice(0, -1);
// Where New and paste land: in the selected folder, beside the selected file, else in the root.
const landing = computed(() => {
  const row = selectedRow.value;
  return !row ? root.value : row.dir ? row.path : (wayTo(row.path).at(-1) ?? root.value);
});

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
const setRoots = (next: string[], idx: number): Promise<void> => attempt(post(props.tab, "setRoots", { roots: next, rootIdx: idx }));
// Anything Fwd could still have reached is dropped, as in a browser's history.
const addRoot = (folder: string): Promise<void> => setRoots([...roots.value.slice(0, rootIdx.value + 1), folder], rootIdx.value + 1);

// -1 is Back, 1 is Fwd.
function stepRoot(by: number): void {
  const idx = rootIdx.value + by;
  if (idx >= -1 && idx < roots.value.length) void setRoots(roots.value, idx);
  // The button may have just been disabled, with the focus on it.
  treeArea.value?.focus();
}

// Opens the folders on the way to a row and scrolls to it.
async function reveal(target: string, folders: string[]): Promise<void> {
  folders.forEach((folder) => opened.add(folder));
  await refresh();
  await nextTick();
  tree.value?.querySelector(`[data-path="${CSS.escape(target)}"]`)?.scrollIntoView({ block: "nearest" });
}

function selectAndReveal(path: string): Promise<void> {
  select(path);
  return reveal(path, wayTo(path));
}

// The tree as a collapse that kept the selection left it. Opening a folder or selecting another
// row makes the tree differ from this, which ends the partially collapsed state.
let partiallyCollapsed = "";
const treeState = (): string => JSON.stringify([root.value, selected.value, [...opened]]);

// With a selection, the first press closes all but the way to it, even if that changes nothing.
// The next press, with the tree as that one left it, closes everything and drops the selection.
function collapse(): void {
  const keep = treeState() === partiallyCollapsed ? "" : selected.value;
  opened.clear();
  select(keep);
  partiallyCollapsed = "";
  if (keep) {
    void reveal(keep, wayTo(keep));
    partiallyCollapsed = treeState();
  }
}

const newFile = (): Promise<void> => attempt(post<{ path: string }>(props.tab, "newFile", { folder: landing.value }).then((reply) => selectAndReveal(reply.path)));

// A picked folder under the root is opened down to and shown; any other becomes a new root.
async function goTo(folder: string): Promise<void> {
  if (folder === root.value) return;
  const chain = foldersBetween(root.value, folder);
  if (!chain) return addRoot(folder);
  select(folder);
  await reveal(folder, chain);
}

// Each Enter in the search box goes on to the next name below the last one found, in the tree's
// order, closed folders included, and Ctrl-Enter back to the one above it; new text starts from the
// end it is heading away from. Queued, so quick presses each move on one.
const searchText = ref("");
const searchNodeModules = ref(false);
let foundAt = "";
let searches: Promise<void> = Promise.resolve();

async function findStep(text: string, backward: boolean): Promise<void> {
  note.value = "";
  try {
    const reply = await post<{ path: string | null }>(props.tab, "findFile", { root: root.value, text, after: foundAt, backward, nodeModules: searchNodeModules.value });
    if (!reply.path) {
      note.value = `No name here contains "${text}".`;
      return;
    }
    foundAt = reply.path;
    await selectAndReveal(reply.path);
  } catch (problem) {
    note.value = messageOf(problem);
  }
}

function search(backward: boolean): void {
  const text = searchText.value;
  if (text) searches = searches.then(() => findStep(text, backward));
}

// A srv tab's clipboard work is done by WSL's backend: the clipboard is on the laptop.
const clipHost = computed<HostName>(() => (props.tab.host === "srv" ? "wsl" : props.tab.host));
// One at a time and in order, or a Ctrl-V right after a Ctrl-C would paste what was there before it.
let clipboardJobs: Promise<unknown> = Promise.resolve();
function clipboardJob(target: string, work: () => Promise<unknown>): void {
  clipboardJobs = clipboardJobs.then(() => {
    working.value = target;
    return attempt(work()).finally(() => (working.value = ""));
  });
}

function copyRow(row: Row, cutting: boolean): void {
  clipboardJob(row.path, async () => {
    const { clip } = await postHost<{ clip: string }>(clipHost.value, "clipCopy", { host: props.tab.host, path: row.path });
    cut = cutting ? { tab: props.tab, path: row.path, clip } : null;
  });
}

// A cut item moves only if it is still all the clipboard holds; otherwise this is an ordinary paste.
async function paste(folder: string): Promise<void> {
  let item = cut;
  if (item) {
    const { files } = await postHost<{ files: string[] }>(clipHost.value, "clipFiles", {});
    if (files.length !== 1 || !sameName(files[0]!, item.clip)) item = cut = null;
  }
  if (item?.tab.host === props.tab.host) {
    const reply = await post<{ path: string }>(props.tab, "movePath", { path: item.path, folder });
    moved(item.path, reply.path);
    cut = null;
    return selectAndReveal(reply.path);
  }
  const reply = await postHost<{ path: string }>(clipHost.value, "clipPaste", { host: props.tab.host, folder });
  if (item) {
    await post(item.tab, "deletePath", { path: item.path });
    cut = null;
  }
  await selectAndReveal(reply.path);
}

function remove(row: Row): void {
  const what = row.dir ? `the folder ${row.path} and everything in it` : row.path;
  if (window.confirm(`Permanently delete ${what}?\n\nThis cannot be undone.`)) void attempt(post(props.tab, "deletePath", { path: row.path }).then(() => select("")));
}

function clickRow(row: Row, event: MouseEvent): void {
  if (event.shiftKey) return;
  if (event.altKey) return copy(row.path, event.currentTarget as HTMLElement);
  if (event.ctrlKey || !row.dir) return select(selected.value === row.path ? "" : row.path);
  if (!opened.delete(row.path)) {
    opened.add(row.path);
    void refresh();
  }
}

// Only while the focus is in the tree's part of the column, so the keys stay ordinary everywhere else.
function keyDown(event: KeyboardEvent): void {
  const area = event.currentTarget as HTMLElement;
  if ((event.target as Element).closest("input, dialog") || event.altKey || event.shiftKey) return;
  const key = `${event.ctrlKey ? "ctrl+" : ""}${event.key.toLowerCase()}`;
  const row = selectedRow.value;
  // Text picked in the path row or a note is what Ctrl-C copies then.
  const picked = window.getSelection();
  if (key === "ctrl+c" && picked && !picked.isCollapsed && area.contains(picked.anchorNode)) return;
  if (key === "backspace") stepRoot(-1);
  else if (key === "ctrl+v") {
    const folder = landing.value;
    clipboardJob(folder, () => paste(folder));
  } else if (!row) return;
  else if (key === "delete") remove(row);
  else if (key === "f2") startRename(row);
  else if (key === "ctrl+c") copyRow(row, false);
  else if (key === "ctrl+x") copyRow(row, true);
  else return;
  event.preventDefault();
}

async function openRow(row: Row, rendered: boolean): Promise<void> {
  note.value = "";
  try {
    const reply = await post<{ mtime: number; text: string | null }>(props.tab, "readFile", { path: row.path });
    if (reply.text === null) return;
    file.value = { path: row.path, text: reply.text, mtime: reply.mtime, rendered };
    emit("openFile");
  } catch (problem) {
    note.value = messageOf(problem);
  }
}

// The rendered view follows the file, as the editor does. An unchanged file answers with no text.
// One request at a time, or a backend that stopped answering would use up the browser's connections to it.
let rereading = false;
async function rereadRendered(): Promise<void> {
  if (rereading) return;
  rereading = true;
  const shown = file.value!;
  try {
    const reply = await post<{ mtime: number; text?: string | null }>(props.tab, "readFile", { path: shown.path, known: shown.mtime });
    listProblem.value = "";
    if (typeof reply.text === "string" && file.value === shown) file.value = { ...shown, text: reply.text, mtime: reply.mtime };
  } catch (problem) {
    listProblem.value = messageOf(problem);
  }
  rereading = false;
}

function doubleClickRow(row: Row, event: MouseEvent): void {
  const rendered = event.ctrlKey && !row.dir && /\.md$/i.test(row.name);
  if ((event.ctrlKey && !rendered) || event.altKey || event.shiftKey) return;
  select(row.path);
  if (row.dir) void addRoot(row.path);
  else void openRow(row, rendered);
}

function startRename(row: Row): void {
  renaming.value = row.path;
  newName.value = row.name;
}

// What was open or selected under a renamed or moved item still is.
function moved(from: string, to: string): void {
  const follow = (item: string): string => (item === from || foldersBetween(from, item) ? to + item.slice(from.length) : item);
  const folders = [...opened].map(follow);
  opened.clear();
  folders.forEach((folder) => opened.add(folder));
  for (const [folder, item] of Object.entries(selections)) selections[folder] = follow(item);
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
// Back from the editor, the keys work at once. After the tick: v-show only reveals the area at the
// end of the flush, even for a post-flush watcher, and a hidden element can't take focus.
watch(() => props.fileMode, async (editing) => {
  await nextTick();
  if (!editing) treeArea.value?.focus();
});
onMounted(() => {
  void refresh();
  treeArea.value?.focus();
  poller = window.setInterval(() => {
    if (document.hidden) return;
    if (!props.fileMode) void refresh();
    else if (file.value?.rendered) void rereadRendered();
  }, 2000);
});
onBeforeUnmount(() => window.clearInterval(poller));
</script>

<template>
  <div class="files" @dragover.prevent="dragOver" @dragleave="dragLeave" @drop.prevent="drop">
    <div v-if="fileMode && file?.rendered" class="files-root">{{ tab.host }}: {{ file.path }}</div>
    <div v-if="fileMode && file?.rendered && listProblem" class="files-note">{{ listProblem }}</div>
    <!-- Inside a .pane for Pane.vue's global markdown styles. -->
    <div v-if="fileMode && file?.rendered" class="pane files-rendered" @click.capture="copyCodeBlock">
      <div class="response markdown files-rendered-text" v-html="renderMarkdown(file.text)"></div>
    </div>
    <FileEditor v-else-if="fileMode && file" :tab="tab" :file="file" />
    <div v-show="!fileMode" ref="treeArea" class="files-mode" tabindex="-1" @keydown="keyDown">
      <div class="files-bar">
        <button title="Back to the previous root" aria-label="Back" :disabled="rootIdx < 0" @click="stepRoot(-1)">
          <svg viewBox="0 0 20 16"><path d="M1.5 5.5H14a4.5 4.5 0 0 1 0 9M6 10 1.5 5.5 6 1" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter" /></svg>
        </button>
        <button title="Forward to the next root" aria-label="Forward" :disabled="rootIdx >= roots.length - 1" @click="stepRoot(1)">
          <svg class="files-flip" viewBox="0 0 20 16"><path d="M1.5 5.5H14a4.5 4.5 0 0 1 0 9M6 10 1.5 5.5 6 1" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter" /></svg>
        </button>
        <button title="Close all folders but the way to the selection; pressed again, close those too and drop the selection" aria-label="Collapse" @click="collapse">
          <svg viewBox="0 0 16 16"><rect x="1.5" y="4.5" width="10" height="10" rx="1" /><path d="M4 9.5h5M4.5 1.5h10v10" /></svg>
        </button>
        <button title="New empty file in the selected folder, beside the selected file, or in the root" @click="newFile">New</button>
        <button title="Show a folder in the tree" @click="picker?.open(root)">Path</button>
        <input v-model="searchText" class="tabs-input" spellcheck="false" aria-label="Find a file or folder by name" @input="foundAt = ''" @keydown.enter.prevent="search($event.ctrlKey)" @keydown.esc.prevent="treeArea?.focus()" />
        <label class="files-nm" title="Search inside node_modules too"><input v-model="searchNodeModules" type="checkbox" />NM</label>
      </div>
      <div class="files-root" :class="{ drop: dragTarget === root, working: working === root }" :data-drop="root">{{ tab.host }}: {{ root }}</div>
      <div v-if="note || listProblem" class="files-note">{{ note || listProblem }}</div>
      <div ref="tree" class="files-tree">
        <div
          v-for="row in rows"
          :key="row.path"
          class="files-row"
          :class="{ drop: dragTarget === row.path, working: working === row.path, selected: selected === row.path }"
          :data-path="row.path"
          :data-drop="row.dir ? row.path : undefined"
          :title="row.path"
          role="button"
          @click="clickRow(row, $event)"
          @dblclick="doubleClickRow(row, $event)"
        >
          <span v-for="depth in row.depth" :key="depth" class="files-guide"></span>
          <svg class="files-chevron" :class="{ open: opened.has(row.path) }" viewBox="0 0 16 16"><path v-if="row.dir" d="M6 3.5 10.5 8 6 12.5" /></svg>
          <svg class="files-icon" viewBox="0 0 16 16"><path :d="row.dir ? 'M1.5 13.5v-11h4.5l1.5 2h7v9z' : 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3'" /></svg>
          <input v-if="renaming === row.path" v-model="newName" v-focus class="files-rename" spellcheck="false" @click.stop @dblclick.stop @keydown.enter.prevent="finishRename(row, true); treeArea?.focus()" @keydown.esc.prevent="finishRename(row, false); treeArea?.focus()" @blur="finishRename(row, true)" />
          <span v-else class="files-name">{{ row.name }}</span>
        </div>
      </div>
      <FolderPicker ref="picker" :host="tab.host" @pick="goTo" />
    </div>
  </div>
</template>

<style scoped>
.files { min-height: 0; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-left: 1px solid var(--border); background: var(--page); }
.files-rendered { flex: 1; min-height: 0; }
.files-rendered-text { overflow-y: auto; }
.files-mode { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; outline: none; }
.files-bar { flex: none; display: flex; align-items: center; gap: 6px; }
.files-bar button { min-height: 0; padding: 3px 10px; }
.files-bar svg { display: block; width: 20px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.files-bar .files-flip { transform: scaleX(-1); }
/* Icons stay black like all text, so a disabled one shows by its thin line. */
.files-bar button:disabled path { stroke-width: 0.75; }
.files-bar .tabs-input { padding: 3px 8px; }
.files-nm { flex: none; display: flex; align-items: center; gap: 3px; margin-right: 15px; cursor: pointer; user-select: none; }
.files-root { flex: none; padding: 2px 6px; border-radius: 4px; overflow-wrap: anywhere; }
.files-note { flex: none; background: #fbd9d9; border: 1px solid #e4a7a7; border-radius: 8px; padding: 4px 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
/* A grid so every row is as wide as the widest, and a selection's colour reaches the far edge when scrolled. */
.files-tree { flex: 1; min-height: 0; overflow: auto; padding: 4px 0; display: grid; align-content: start; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); user-select: none; }
.files-row { display: flex; align-items: center; height: 24px; padding: 0 8px 0 6px; cursor: pointer; white-space: nowrap; }
.files-row:hover { background: var(--wash); }
.files-row.selected { background: var(--yellow); }
/* Not yellow: the row being copied is usually the selected one. */
.files-row.working, .files-root.working { background: #ffd9a8; }
.files-row.drop, .files-root.drop { background: #cfe8ff; box-shadow: inset 0 0 0 1px #8fb8e0; }
/* VS Code's indent guides: shown while the pointer is over the tree, under the parent's chevron. */
.files-guide { flex: none; align-self: stretch; width: 12px; }
.files-tree:hover .files-guide { background: linear-gradient(var(--border), var(--border)) 8px 0 / 1px 100% no-repeat; }
.files-chevron, .files-icon { flex: none; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.2; stroke-linecap: round; stroke-linejoin: round; }
.files-chevron.open { transform: rotate(90deg); }
.files-icon { margin: 0 5px 0 2px; }
.files-rename { flex: 1; min-width: 120px; padding: 0 4px; border: 1px solid #9a9a93; border-radius: 4px; background: #fff; color: var(--ink); font: inherit; }
</style>
