<script lang="ts">
// Ctrl-X's item, here because the Ctrl-V can come in any tab's tree. clip is the clipboard's name for it.
let cut: { host: HostName; path: string; clip: string } | null = null;
</script>

<script setup lang="ts">
// The Files column, in the Snips' place: a VS Code-style tree on any host (the tab's to start) or, in file mode,
// one file in FileEditor. Click a folder to open it, double-click to make it the root; double-click
// a file to edit it, or ctrl-double-click a .md to read it rendered; alt-click copies the path; a long press shows all about it. Rows can be selected, remembered per root:
// a click on a file selects just it, ctrl-click toggles any row, shift-click adds the run of files from the last one
// (src/pick.ts); a click on a folder only opens or closes it, so only ctrl-click selects a folder. The keys act on them (keyDown); all but Delete need exactly one. Ctrl+Enter on a file adds it to the prompt, as the footer's File does.
// Files dragged from Explorer land on the folder under them. The header's path row stands for the
// root folder, which has no row of its own, for drop; a click on it types a path to go to (editRoot).
// Path's host selector makes a root on another host: everything the tree does then goes to that host.
// The tree holds only what the backend last said: each open folder is asked for again every 2s.
// ponytail: polling, not file watches; change it if the 2s lag or the traffic ever matters.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { HOSTS, type HostName, type Tab } from "../../shared/config.ts";
import type { FileEntry } from "../../shared/types.ts";
import { post, postHost, upload } from "../api.ts";
import { copy, copyCodeBlock } from "../copy.ts";
import { pick } from "../pick.ts";
import { renderMarkdown } from "../render.ts";
import { foldersBetween, parentFolder, sameName, withSeparator } from "../tabList.ts";
import { wheelZoom } from "../wheelZoom.ts";
import FileEditor from "./FileEditor.vue";
import FolderPicker from "./FolderPicker.vue";

// fileMode: App's column is showing the file. openFile asks for that; App's Files button leaves it.
// active: this is the tab on show; a tab out of sight stops asking the backend.
const props = defineProps<{ tab: Tab; active: boolean; fileMode: boolean }>();
// attach: Ctrl+Enter on the one selected file, for the pane to add to its prompt.
const emit = defineEmits<{ openFile: []; attach: [path: string, host: HostName] }>();
const newProjectAt = inject("newProjectAt") as (host: HostName, folder: string) => void;
// Sizes the tree and rendered markdown; FileEditor's editor keeps a size of its own.
const zoom = wheelZoom("files-font-size");

const roots = computed(() => props.tab.roots ?? []);
const rootIdx = computed(() => props.tab.rootIdx ?? roots.value.length - 1);
// A root on another host than the tab's is kept as "<host>:<path>": no path starts so, a drive letter being one letter.
const onHost = (path: string, host: HostName): string => (host === props.tab.host ? path : `${host}:${path}`);
const rootParts = computed((): [HostName, string] => {
  const entry = roots.value[rootIdx.value] ?? props.tab.path;
  const host = entry.split(":", 1)[0]!;
  return Object.hasOwn(HOSTS, host) ? [host as HostName, entry.slice(host.length + 1)] : [props.tab.host, entry];
});
const treeHost = computed(() => rootParts.value[0]);
const root = computed(() => rootParts.value[1]);
// What the root's selection is kept under.
const rootKey = computed(() => onHost(root.value, treeHost.value));
const listings = reactive(new Map<string, FileEntry[]>());
const openKey = `filesOpen:${props.tab.id}`;
const selectKey = `filesSelected:${props.tab.id}`;
const opened = reactive(new Set<string>(JSON.parse(localStorage.getItem(openKey) ?? "[]") as string[]));
// Each root's selected paths. A selected row may be out of sight, or gone from the disk.
// flat(): a root stored before multiple selection holds one path, not a list.
const stored = JSON.parse(localStorage.getItem(selectKey) ?? "{}") as Record<string, string | string[]>;
const selections = reactive<Record<string, string[]>>(Object.fromEntries(Object.entries(stored).map(([folder, paths]) => [folder, [paths].flat()])));
watch(() => [...opened], (folders) => localStorage.setItem(openKey, JSON.stringify(folders)));
watch(selections, (all) => localStorage.setItem(selectKey, JSON.stringify(all)), { deep: true });
const selected = computed(() => new Set(selections[rootKey.value] ?? []));
// Where shift-click's run starts: the last row selected.
let anchor = "";
function select(...paths: string[]): void {
  anchor = paths.at(-1) ?? "";
  if (paths.length) selections[rootKey.value] = paths;
  else delete selections[rootKey.value];
}

const note = ref("");
const listProblem = ref("");
// host: the one it is on. rendered: shown as markdown, read-only, instead of in the editor. line: the line the editor opens
// centered on, with line numbers in place of its line dots (a file opened from the Git popup's diff,
// which has them); 0 for a file opened in the tree.
const file = ref<{ host: HostName; path: string; text: string; mtime: number; rendered: boolean; line: number } | null>(null);
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

// The selected rows on show, in the tree's order.
const selectedRows = computed(() => rows.value.filter((row) => selected.value.has(row.path)));
const below = (path: string): string => path.slice(withSeparator(root.value).length);
// What the one-row actions act on: none with more than one selected, or with the one out of sight.
const selectedRow = computed(() => (selected.value.size === 1 ? selectedRows.value[0] : undefined));
const many = computed(() => selected.value.size > 1);
// Its path below the root, or a * for more than one.
const selectedBelowRoot = computed(() => (many.value ? "*" : selectedRow.value ? below(selectedRow.value.path) : ""));
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
      const reply = await postHost<{ listings: Record<string, FileEntry[] | null> }>(treeHost.value, "listFiles", { paths: [shown, ...openRows()] });
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
const addRoot = (folder: string, host = treeHost.value): Promise<void> => setRoots([...roots.value.slice(0, rootIdx.value + 1), onHost(folder, host)], rootIdx.value + 1);

// -1 is Back, 1 is Fwd.
function stepRoot(by: number): void {
  const idx = rootIdx.value + by;
  if (idx >= -1 && idx < roots.value.length) void setRoots(roots.value, idx);
  // The button may have just been disabled, with the focus on it.
  treeArea.value?.focus();
}

// Up makes the root's parent a new root, so Back returns; "" above / or a drive's C:\.
const upFolder = computed(() => parentFolder(root.value));
function goUp(): void {
  if (upFolder.value) void addRoot(upFolder.value);
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

// After any listing under way has landed. A selection in a closed folder stays out of sight.
const showSelection = (): Promise<void> => reveal([...selected.value][0] ?? "", []);

// Not from the element's focus event: a mouse press also focuses the tree, and scrolling then would
// move the row being clicked.
function focusTree(): void {
  treeArea.value?.focus();
  void showSelection();
}

// The tree as a collapse that kept the selection left it. Opening a folder or selecting another
// row makes the tree differ from this, which ends the partially collapsed state.
let partiallyCollapsed = "";
const treeState = (): string => JSON.stringify([root.value, [...selected.value], [...opened]]);

// With a selection, the first press closes all but the way to it, even if that changes nothing.
// The next press, with the tree as that one left it, closes everything and drops the selection.
function collapse(): void {
  const keep = treeState() === partiallyCollapsed ? [] : [...selected.value];
  opened.clear();
  select(...keep);
  partiallyCollapsed = "";
  if (keep.length) {
    void reveal(keep[0]!, keep.flatMap(wayTo));
    partiallyCollapsed = treeState();
  }
}

// Ctrl-click makes a folder instead.
const newFile = (dir: boolean): Promise<void> => attempt(postHost<{ path: string }>(treeHost.value, "newFile", { folder: landing.value, dir }).then((reply) => selectAndReveal(reply.path)));

// A picked folder under the root is opened down to and shown; any other, or one on another host, becomes a new root.
async function goTo(folder: string, host = treeHost.value): Promise<void> {
  if (host !== treeHost.value) return addRoot(folder, host);
  if (folder === root.value) return;
  const chain = foldersBetween(root.value, folder);
  if (!chain) return addRoot(folder);
  select(folder);
  await reveal(folder, chain);
}

// Path's picker, with a host selector left of its box, opens on the tree's host at the root. Another host
// chosen there moves it to that host's home folder; nothing changes until Ok.
const pickHost = ref<HostName>(props.tab.host);
function showHost(host: HostName): void {
  pickHost.value = host;
  picker.value?.open(host === treeHost.value ? root.value : HOSTS[host].home, host);
}

// A click on the path row edits it in place (not a drag that picked text in it, for Ctrl-C); Enter
// goes to the folder typed as Path's pick does, Esc or leaving the box drops it.
const rootText = ref<string | null>(null);
const rootInput = ref<HTMLInputElement>();
function editRoot(): void {
  if (rootText.value !== null || !window.getSelection()?.isCollapsed) return;
  rootText.value = root.value;
  void nextTick(() => {
    rootInput.value?.focus();
    rootInput.value?.select();
  });
}
async function goToTyped(): Promise<void> {
  const typed = rootText.value?.trim() ?? "";
  rootText.value = null;
  focusTree();
  note.value = "";
  try {
    const host = treeHost.value;
    const { path } = await postHost<{ path: string }>(host, "folders", { path: typed });
    if (path) await goTo(path, host);
    else note.value = `${typed || "An empty path"} is not a folder on ${host}.`;
  } catch (problem) {
    note.value = messageOf(problem);
  }
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
    const reply = await postHost<{ path: string | null }>(treeHost.value, "findFile", { root: root.value, text, after: foundAt, backward, nodeModules: searchNodeModules.value });
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

// A srv tree's clipboard work is done by WSL's backend: the clipboard is on the laptop.
const clipHost = computed<HostName>(() => (treeHost.value === "srv" ? "wsl" : treeHost.value));
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
    const { clip } = await postHost<{ clip: string }>(clipHost.value, "clipCopy", { host: treeHost.value, path: row.path });
    cut = cutting ? { host: treeHost.value, path: row.path, clip } : null;
  });
}

// A cut item moves only if it is still all the clipboard holds; otherwise this is an ordinary paste.
async function paste(folder: string): Promise<void> {
  let item = cut;
  if (item) {
    const { files } = await postHost<{ files: string[] }>(clipHost.value, "clipFiles", {});
    if (files.length !== 1 || !sameName(files[0]!, item.clip)) item = cut = null;
  }
  if (item?.host === treeHost.value) {
    const reply = await postHost<{ path: string }>(item.host, "movePath", { path: item.path, folder });
    moved(item.path, reply.path);
    cut = null;
    return selectAndReveal(reply.path);
  }
  const reply = await postHost<{ path: string }>(clipHost.value, "clipPaste", { host: treeHost.value, folder });
  if (item) {
    await postHost(item.host, "deletePath", { path: item.path });
    cut = null;
  }
  await selectAndReveal(reply.path);
}

// Every selected row, but refused while any is out of sight: what is deleted must be on show.
// Rows inside a selected folder go with it.
function remove(): void {
  const shown = selectedRows.value;
  const hidden = [...selected.value].filter((path) => !shown.some((row) => row.path === path));
  if (hidden.length) {
    window.alert(`Nothing deleted: these selected items are out of sight, in a closed folder or gone:\n\n${hidden.map(below).join("\n")}\n\nOpen their folders or change the selection.`);
    return;
  }
  const doomed = shown.filter((row) => !shown.some((folder) => folder.dir && foldersBetween(folder.path, row.path)));
  const list = doomed.map((row) => (row.dir ? `${below(row.path)}  (folder, and everything in it)` : below(row.path))).join("\n");
  if (!window.confirm(`Permanently delete ${doomed.length === 1 ? "this" : `these ${doomed.length}`}?\n\n${list}\n\nThis cannot be undone.`)) return;
  const host = treeHost.value;
  void attempt((async () => {
    for (const row of doomed) await postHost(host, "deletePath", { path: row.path });
  })().finally(() => select()));
}

// A long press on a row: all the backend can say about it, in a dialog. Its facts are server/files.ts's fileInfo.
type Info = {
  kind: string; link: string; realPath: string; size: number; text: { lines: number } | { binary: true } | null;
  entries: number | null; totals: { files: number; folders: number; bytes: number; partial: boolean } | null;
  modified: number; accessed: number; changed: number; created: number;
  permissions: string; owner: string; group: string; inode: number; hardLinks: number; device: number; blocks: number | null;
};
const infoDialog = ref<HTMLDialogElement>();
const infoRow = ref<Row | null>(null);
const info = ref<Info | null>(null);
const infoProblem = ref("");
let pressTimer = 0;
// The click that ends a long press does nothing more.
let longPressed = false;

function press(row: Row, event: PointerEvent): void {
  longPressed = false;
  window.clearTimeout(pressTimer);
  if (event.button !== 0 || event.altKey || event.ctrlKey || event.shiftKey || renaming.value === row.path) return;
  pressTimer = window.setTimeout(() => {
    longPressed = true;
    select(row.path);
    void showInfo(row);
  }, 650);
}
const unpress = (): void => window.clearTimeout(pressTimer);

async function showInfo(row: Row): Promise<void> {
  infoRow.value = row;
  info.value = null;
  infoProblem.value = "";
  infoDialog.value?.showModal();
  try {
    const reply = await postHost<Info>(treeHost.value, "fileInfo", { path: row.path });
    if (infoRow.value?.path === row.path) info.value = reply;
  } catch (problem) {
    if (infoRow.value?.path === row.path) infoProblem.value = messageOf(problem);
  }
}

function sizeText(bytes: number): string {
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = bytes;
  let unit = -1;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit++;
  }
  return `${bytes.toLocaleString()} bytes${unit < 0 ? "" : ` (${scaled.toFixed(1)} ${units[unit]})`}`;
}
// In the page's time zone. 0 is what a file system that doesn't keep the time answers.
const when = (ms: number): string => (ms ? new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" }) : "not kept here");

const infoRows = computed((): [string, string][] => {
  const row = infoRow.value;
  const found = info.value;
  if (!row) return [];
  const out: [string, string][] = [["Name", row.name], ["Host", treeHost.value], ["Path", row.path]];
  if (!found) return infoProblem.value ? out : [...out, ["", "Reading…"]];
  out.push(["Type", found.link ? `${found.kind}, by a symbolic link to ${found.link}` : found.kind]);
  if (found.realPath && found.realPath !== row.path) out.push(["Real path", found.realPath]);
  if (found.totals) {
    const { files, folders, bytes, partial } = found.totals;
    out.push(["Size", `${sizeText(bytes)} in ${files.toLocaleString()} files and ${folders.toLocaleString()} folders${partial ? ", at least: counting stopped after 2s" : ""}`]);
    if (found.entries !== null) out.push(["Directly inside", `${found.entries.toLocaleString()} items`]);
  } else {
    out.push(["Size", sizeText(found.size)]);
  }
  if (found.text) out.push(["Contents", "binary" in found.text ? "binary" : `text, ${found.text.lines.toLocaleString()} lines`]);
  out.push(["Modified", when(found.modified)], ["Accessed", when(found.accessed)], ["Changed", when(found.changed)], ["Created", when(found.created)]);
  out.push(["Permissions", found.permissions]);
  if (found.owner) out.push(["Owner", found.owner], ["Group", found.group]);
  out.push(["Inode", String(found.inode)], ["Hard links", String(found.hardLinks)], ["Device", String(found.device)]);
  if (found.blocks !== null) out.push(["Blocks", String(found.blocks)]);
  return out;
});

function clickRow(row: Row, event: MouseEvent): void {
  if (longPressed) {
    longPressed = false;
    return;
  }
  if (event.altKey) return copy(row.path, event.currentTarget as HTMLElement);
  if (row.dir && !event.ctrlKey) {
    if (!opened.delete(row.path)) {
      opened.add(row.path);
      void refresh();
    }
    return;
  }
  const picked = new Set(selected.value);
  // Only ctrl-click picks a folder, so a shift-click's run takes in just the files (and its own ends).
  const paths = rows.value.filter((each) => !each.dir || each.path === anchor || each.path === row.path).map((each) => each.path);
  // With the run's start out of sight, shift-click adds just this row.
  const next = event.shiftKey && !paths.includes(anchor) ? (picked.add(row.path), row.path) : pick(picked, paths, row.path, anchor, event);
  select(...picked);
  anchor = next;
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
  else if (key === "delete" && selected.value.size) remove();
  else if (key === "ctrl+v" && !many.value) {
    const folder = landing.value;
    clipboardJob(folder, () => paste(folder));
  } else if (!row) return;
  else if (key === "f2") startRename(row);
  else if (key === "ctrl+c") copyRow(row, false);
  else if (key === "ctrl+x") copyRow(row, true);
  else if (key === "ctrl+enter" && !row.dir) emit("attach", row.path, treeHost.value);
  else return;
  event.preventDefault();
}

async function openRow(path: string, rendered: boolean, line = 0, host = treeHost.value): Promise<void> {
  note.value = "";
  try {
    const reply = await postHost<{ mtime: number; text: string | null }>(host, "readFile", { path });
    if (reply.text === null) return;
    file.value = { host, path, text: reply.text, mtime: reply.mtime, rendered, line };
    emit("openFile");
  } catch (problem) {
    note.value = messageOf(problem);
  }
}

// A file asked for from outside the pane (a click on a line number in the Git popup's diff), with
// the tree on show: selected and scrolled to when it is under the root (on the tab's host, as the repo is), then in the editor at that
// line. One that can't be opened leaves the tree up, with the reason.
async function openPath(path: string, line: number): Promise<void> {
  if (treeHost.value === props.tab.host && foldersBetween(root.value, path)) await selectAndReveal(path);
  await openRow(path, false, line, props.tab.host);
}
defineExpose({ openPath });

// The rendered view follows the file, as the editor does. An unchanged file answers with no text.
// One request at a time, or a backend that stopped answering would use up the browser's connections to it.
let rereading = false;
async function rereadRendered(): Promise<void> {
  if (rereading) return;
  rereading = true;
  const shown = file.value!;
  try {
    const reply = await postHost<{ mtime: number; text?: string | null }>(shown.host, "readFile", { path: shown.path, known: shown.mtime });
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
  if (!row.dir) {
    select(row.path);
    return void openRow(row.path, rendered);
  }
  // A new root starts with nothing selected, here or there.
  select();
  delete selections[onHost(row.path, treeHost.value)];
  void addRoot(row.path);
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
  for (const [folder, items] of Object.entries(selections)) selections[folder] = items.map(follow);
}

function finishRename(row: Row, commit: boolean): void {
  if (renaming.value !== row.path) return;
  renaming.value = "";
  const name = newName.value.trim();
  if (commit && name && name !== row.name) void attempt(postHost<{ path: string }>(treeHost.value, "renamePath", { path: row.path, name }).then((reply) => moved(row.path, reply.path)));
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
  const host = treeHost.value;
  void attempt((async () => {
    for (const item of dropped) await upload(host, folder, item);
  })()).finally(() => (working.value = ""));
}

let poller = 0;
watch([root, () => props.fileMode], () => void showSelection());
// Back from the editor, the keys work at once. After the tick: v-show only reveals the area at the
// end of the flush, even for a post-flush watcher, and a hidden element can't take focus.
watch(() => props.fileMode, async (editing) => {
  await nextTick();
  if (!editing) treeArea.value?.focus();
});
onMounted(() => {
  focusTree();
  poller = window.setInterval(() => {
    if (document.hidden || !props.active) return;
    if (!props.fileMode) void refresh();
    else if (file.value?.rendered) void rereadRendered();
  }, 2000);
});
onBeforeUnmount(() => window.clearInterval(poller));
</script>

<template>
  <div class="files" @wheel="(!fileMode || file?.rendered) && zoom($event)" @dragover.prevent="dragOver" @dragleave="dragLeave" @drop.prevent="drop">
    <div v-if="fileMode && file?.rendered" class="files-root">{{ file.host }}: {{ file.path }}</div>
    <div v-if="fileMode && file?.rendered && listProblem" class="files-note">{{ listProblem }}</div>
    <!-- Inside a .pane for Pane.vue's global markdown styles. -->
    <div v-if="fileMode && file?.rendered" class="pane files-rendered" data-help="rendered markdown" @click.capture="copyCodeBlock">
      <div class="response markdown files-rendered-text" v-html="renderMarkdown(file.text)"></div>
    </div>
    <FileEditor v-else-if="fileMode && file" :active="active" :file="file" />
    <div v-show="!fileMode" ref="treeArea" class="files-mode" tabindex="-1" data-mode="Files tree" @keydown="keyDown">
      <div class="files-bar">
        <button title="New empty file in the selected folder, beside the selected file, or in the root" data-help="Files New button" :disabled="many" @click="newFile($event.ctrlKey)">New</button>
        <button title="New project from the selected folder" data-help="Files Prj button" :disabled="!selectedRow?.dir" @click="newProjectAt(treeHost, selectedRow!.path)">Prj</button>
        <button title="Show a folder in the tree, on any host" data-help="Files Path button" @click="showHost(treeHost)">Path</button>
        <!-- One piece, so the search box and NM wrap to the next line together. -->
        <span class="files-find">
          <input v-model="searchText" class="tabs-input" spellcheck="false" aria-label="Find a file or folder by name" data-help="Files search box" data-mode="Files search box" @input="foundAt = ''" @keydown.enter.prevent="search($event.ctrlKey)" @keydown.esc.prevent="focusTree()" />
          <label class="files-nm" title="Search inside node_modules too" data-help="Files NM box"><input v-model="searchNodeModules" type="checkbox" />NM</label>
        </span>
      </div>
      <div class="files-bar">
        <button title="Up to the root's parent folder" aria-label="Up" data-help="Files Up button" :disabled="!upFolder" @click="goUp">
          <svg viewBox="0 0 20 16"><path d="M10 15.5V1.5M5.5 6 10 1.5 14.5 6" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter" /></svg>
        </button>
        <button title="Back to the previous root" aria-label="Back" data-help="Files Back button" :disabled="rootIdx < 0" @click="stepRoot(-1)">
          <svg viewBox="0 0 20 16"><path d="M1.5 5.5H14a4.5 4.5 0 0 1 0 9M6 10 1.5 5.5 6 1" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter" /></svg>
        </button>
        <button title="Forward to the next root" aria-label="Forward" data-help="Files Forward button" :disabled="rootIdx >= roots.length - 1" @click="stepRoot(1)">
          <svg class="files-flip" viewBox="0 0 20 16"><path d="M1.5 5.5H14a4.5 4.5 0 0 1 0 9M6 10 1.5 5.5 6 1" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter" /></svg>
        </button>
        <button title="Close all folders but the way to the selection; pressed again, close those too and drop the selection" aria-label="Collapse" data-help="Files Collapse button" @click="collapse">
          <svg viewBox="0 0 16 16"><rect x="1.5" y="4.5" width="10" height="10" rx="1" /><path d="M4 9.5h5M4.5 1.5h10v10" /></svg>
        </button>
      </div>
      <div class="files-root" :class="{ drop: dragTarget === root, working: working === root }" :data-drop="root" data-help="Files root path" @click="editRoot">
        {{ treeHost }}:
        <input v-if="rootText !== null" ref="rootInput" v-model="rootText" class="files-rename" spellcheck="false" aria-label="Folder path" data-mode="Files root path" @keydown.enter.prevent="goToTyped" @keydown.esc.prevent="rootText = null; focusTree()" @blur="rootText = null" />
        <template v-else>{{ withSeparator(root) }}<span class="files-relative">{{ selectedBelowRoot }}</span></template>
      </div>
      <div v-if="note || listProblem" class="files-note">{{ note || listProblem }}</div>
      <div ref="tree" class="files-tree" data-help="Files tree">
        <div
          v-for="row in rows"
          :key="row.path"
          class="files-row"
          :class="{ drop: dragTarget === row.path, working: working === row.path, selected: selected.has(row.path) }"
          :data-path="row.path"
          :data-drop="row.dir ? row.path : undefined"
          :title="row.path"
          role="button"
          data-help="Files row"
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
          <input v-if="renaming === row.path" v-model="newName" v-focus class="files-rename" spellcheck="false" data-help="rename box" data-mode="rename box" @click.stop @dblclick.stop @keydown.enter.prevent="finishRename(row, true); focusTree()" @keydown.esc.prevent="finishRename(row, false); focusTree()" @blur="finishRename(row, true)" />
          <span v-else class="files-name">{{ row.name }}</span>
        </div>
      </div>
      <FolderPicker ref="picker" :host="treeHost" @pick="goTo($event, pickHost)">
        <select :value="pickHost" aria-label="Host" title="The host whose folders these are" data-help="Files host" @change="showHost(($event.target as HTMLSelectElement).value as HostName)"><option v-for="(_, name) in HOSTS" :key="name">{{ name }}</option></select>
      </FolderPicker>
      <dialog ref="infoDialog" class="files-info" closedby="any" @wheel.stop @close="treeArea?.focus()">
        <table>
          <tr v-for="[label, value] in infoRows" :key="label"><th>{{ label }}</th><td>{{ value }}</td></tr>
        </table>
        <div v-if="infoProblem" class="files-note">{{ infoProblem }}</div>
        <form method="dialog" data-help="file info"><button autofocus>OK</button></form>
      </dialog>
    </div>
  </div>
</template>

<style scoped>
.files { min-height: 0; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; background: var(--page); }
.files-rendered { flex: 1; min-height: 0; }
.files-rendered-text { overflow-y: auto; }
/* Pane.vue fixes its markdown at 14px; here the ctrl-wheel sizes it. */
.files .pane .files-rendered-text, .files .pane .files-rendered-text :deep(:is(h1, h2, h3, h4, h5, h6, code, table)) { font-size: var(--files-font-size, 14px); }
.files-mode { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; outline: none; }
.files-bar { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
/* Basis 0, so it wraps only when NM and a 5em box no longer fit (its min-content); otherwise the
   input's ~20-character default width would decide. */
.files-find { flex: 1 1 0; display: flex; align-items: center; gap: 6px; }
.files-find .tabs-input { min-width: 5em; }
.files-bar button { min-height: 0; padding: 3px 10px; }
.files-bar svg { display: block; width: 20px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.files-bar .files-flip { transform: scaleX(-1); }
.files-bar .tabs-input { padding: 3px 8px; }
.files-nm { flex: none; display: flex; align-items: center; gap: 3px; margin-right: 15px; cursor: pointer; user-select: none; }
.files-root { flex: none; padding: 2px 6px; border-radius: 4px; overflow-wrap: anywhere; }
.files-root:has(.files-rename) { display: flex; align-items: center; gap: 4px; }
.files-relative { background: #fffbdf; }
.files-note { flex: none; background: #fbd9d9; border: 1px solid #e4a7a7; border-radius: 8px; padding: 4px 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
/* A grid so every row is as wide as the widest, and a selection's colour reaches the far edge when scrolled. */
.files-tree { font-size: var(--files-font-size, 14px); flex: 1; min-height: 0; overflow: auto; padding: 4px 0; display: grid; align-content: start; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); user-select: none; }
.files-row { display: flex; align-items: center; min-height: 24px; padding: 0 8px 0 6px; cursor: pointer; white-space: nowrap; }
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
.files-info { max-width: 80vw; max-height: 80vh; padding: 12px 16px; border: 1px solid #000; border-radius: 8px; color: #000; font-size: 14px; }
.files-info table { border-collapse: collapse; margin-bottom: 10px; }
.files-info th { padding: 2px 16px 2px 0; text-align: left; vertical-align: top; white-space: nowrap; }
.files-info td { padding: 2px 0; overflow-wrap: anywhere; }
.files-info .files-note { margin-bottom: 10px; }
.files-info form { text-align: right; }
.files-info button { font-size: 14px; }
.files-rename { flex: 1; min-width: 120px; padding: 0 4px; border: 1px solid #9a9a93; border-radius: 4px; background: #fff; color: var(--ink); font: inherit; }
</style>
