<script setup lang="ts">
// The tab row's Git button (teleported there by Project) and its popup, a small copy of VS Code's Source Control view for the
// tab's project: the last commit's message, the new commit message, then the staged and the changed files. Commit stages
// everything, commits, and pushes (the backend's `commit`). Files are picked as in the sidebar (click, ctrl-click,
// shift-click), and Delete or Ctrl-Z there reverts the picked ones to the last commit, after a question. With one row picked its
// diff is on show to their right, Up and Down in the list walking the files; a click on one of the diff's line numbers opens the file there in the Files pane. The label counts the files waiting
// for a commit. It's re-read while the project is open, on show or not, for the dot on its tab:
// when it comes up, when a session changes (a turn starting or ending), and every 2s for changes
// no event tells of. A click on a Log pane line opens it on one commit instead (`openCommit`): that
// commit's files and their diffs against its parent, with no buttons but Close, no message boxes, no revert,
// not modal (no gray cover, no click-outside close), so a click on another log line shows that commit.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Tab } from "../../shared/config.ts";
import { post } from "../api.ts";
import { pick } from "../pick.ts";
import { modifiedLine } from "../diffLine.ts";
import { MessageHistory } from "../messageHistory.ts";
import { monaco } from "../monaco.ts";

const props = defineProps<{ tab: Tab; active: boolean; version: number; sessionNames: string[] }>();
const emit = defineEmits<{ closed: []; dirty: [dirty: boolean]; noRepo: [none: boolean]; openFile: [path: string, line: number] }>();

// One `git status --porcelain` entry: x is the index's letter, y the work tree's, from a rename's old path.
// path and from are from the repo's top; full, there only while the popup is open, is path on the host.
interface GitFile {
  x: string;
  y: string;
  path: string;
  from?: string;
  full?: string;
}
const files = ref<GitFile[]>([]);
// Why the status couldn't be read (not a repo, no git); empty when it could.
const failure = ref("");
const message = ref("");
const error = ref("");
const committing = ref(false);
const describing = ref(false);
const dialog = ref<HTMLDialogElement>();
const button = ref<HTMLButtonElement>();
const messageBox = ref<HTMLTextAreaElement>();
// The branch's newest commit and its old messages, straight from `git log`.
interface GitLog {
  hash: string;
  subject: string;
  messages: string[];
}
const last = ref<GitLog>();
// The commit under review, from the Log pane; undefined in the usual popup. Its files come as
// status entries with the change in y, so they all fall in the Changes list.
const review = ref<{ hash: string; subject: string; files: GitFile[] }>();

const listed = computed(() => review.value?.files ?? files.value);
const staged = computed(() => listed.value.filter((file) => !" ?".includes(file.x)).map((file) => ({ ...file, letter: file.x, key: `s${file.path}` })));
const changed = computed(() => listed.value.filter((file) => file.y !== " ").map((file) => ({ ...file, letter: file.y === "?" ? "U" : file.y, key: `c${file.path}` })));
const shown = computed(() => [...staged.value, ...changed.value]);
// The picked rows' keys: a file both staged and changed has a row, and so a key, in each list.
const picked = ref(new Set<string>());
let anchor = "";
function clickFile(key: string, event: MouseEvent): void {
  // A plain click on the only picked row unpicks it, closing its diff.
  if (!event.ctrlKey && !event.shiftKey && picked.value.size === 1 && picked.value.has(key)) {
    picked.value = new Set();
    return;
  }
  const next = new Set(picked.value);
  anchor = pick(next, shown.value.map((file) => file.key), key, anchor, event);
  picked.value = next;
}
// A revert puts a file back as the last commit has it, staged and on disk, whichever list it was
// picked in; an untracked file is deleted. The popup stays open.
async function revert(): Promise<void> {
  const chosen = shown.value.filter((file) => picked.value.has(file.key));
  const paths = [...new Set(chosen.map((file) => file.path))];
  if (!paths.length || committing.value || review.value) return;
  const list = paths.map((path) => (chosen.some((file) => file.path === path && file.x === "?") ? `${path}  (untracked: deleted)` : path)).join("\n");
  if (!window.confirm(`Revert ${paths.length === 1 ? "this file" : `these ${paths.length} files`} to the last commit?\n\n${list}\n\nThis cannot be undone.`)) return;
  const untracked = chosen.filter((file) => file.x === "?");
  const tracked = chosen.filter((file) => file.x !== "?").flatMap((file) => (file.from ? [file.path, file.from] : [file.path]));
  error.value = "";
  try {
    await post(props.tab, "revert", { untracked: [...new Set(untracked.map((file) => file.path))], tracked: [...new Set(tracked)] });
    picked.value = new Set();
  } catch (problem) {
    error.value = messageOf(problem);
  }
  void refresh();
}
// Up and Down in the list pick the row before or after the last one clicked, so the diff walks the files.
function step(by: number): void {
  const keys = shown.value.map((file) => file.key);
  const at = keys.indexOf(anchor);
  anchor = keys[at < 0 ? 0 : Math.min(Math.max(at + by, 0), keys.length - 1)] ?? "";
  picked.value = new Set(anchor ? [anchor] : []);
  void nextTick(() => dialog.value?.querySelector(".git-file.picked")?.scrollIntoView({ block: "nearest" }));
}
function onFilesKey(event: KeyboardEvent): void {
  if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    event.preventDefault();
    return step(event.key === "ArrowDown" ? 1 : -1);
  }
  const ctrlZ = event.code === "KeyZ" && event.ctrlKey;
  if ((event.key !== "Delete" && !ctrlZ) || event.altKey || event.metaKey || event.shiftKey || (!ctrlZ && event.ctrlKey)) return;
  event.preventDefault();
  if (!event.repeat) void revert();
}
const canCommit = computed(() => !committing.value && !describing.value && !!message.value.trim() && files.value.length > 0);
const noRepo = computed(() => /not a git repository/i.test(failure.value));
watch(() => files.value.length > 0, (dirty) => emit("dirty", dirty));
watch(noRepo, (none) => emit("noRepo", none));

const history = new MessageHistory();
function setMessage(text: string): void {
  history.replace(message.value, text);
  message.value = text;
}

const messageOf = (problem: unknown): string => (problem instanceof Error ? problem.message : String(problem));
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const folderOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf("/"), 0));

// The log is read only while the popup is open, so on every 2s poll there. A new newest commit
// (any commit or amend, wherever it was made) means new old messages.
async function refresh(): Promise<void> {
  try {
    const status = await post<{ files: GitFile[]; log?: GitLog }>(props.tab, "git", { log: dialog.value?.open });
    files.value = status.files;
    failure.value = "";
    if (status.log) {
      if (status.log.hash !== last.value?.hash) history.fill(status.log.messages);
      last.value = status.log;
    }
  } catch (problem) {
    files.value = [];
    failure.value = messageOf(problem);
    last.value = undefined;
  }
  await loadDiff();
}

// The diff, right of the lists while the popup is open with exactly one row picked: the file as the
// last commit has it (a rename's under its old name) against the file on disk, which is what Commit
// would take whichever list the row is in. Read-only, and it follows both: the left side is asked
// for again when the newest commit changes, the right side after every status read, the backend
// sending text only when the file's mtime has moved.
const isOpen = ref(false);
const diffRow = computed(() => {
  const rows = isOpen.value ? shown.value.filter((file) => picked.value.has(file.key)) : [];
  return rows.length === 1 ? rows[0] : undefined;
});
// Whether the diff's file is there to open: not before its full path has come, not a deleted one.
// A reviewed commit's file opens only while it is still as that commit left it (`fresh`, asked once
// per row), and without that its line numbers aren't shown at all: they wouldn't be the file's now.
const fresh = ref(false);
const canOpen = computed(() => (!review.value || fresh.value) && !!diffRow.value?.full && diffRow.value.x !== "D" && diffRow.value.y !== "D");
const diffHost = ref<HTMLElement>();
// Why there is no diff to see: the file isn't text, or reading it failed.
const diffNote = ref("");
const diffError = ref("");
let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
// What the two sides were last read as, and of what: the commit and path on the left, the file and
// its mtime on the right. shownKey: the row the editor's two texts belong to.
const sides = { leftOf: "", before: "" as string | null, rightOf: "", mtime: NaN, after: "" as string | null };
let shownKey = "";
async function loadDiff(): Promise<void> {
  const row = diffRow.value;
  if (!row?.full || !diffEditor) return;
  const { key, full } = row;
  const old = row.from ?? row.path;
  // A reviewed commit: its parent's file against its own, both fixed, so each is read once.
  const rev = review.value?.hash;
  const leftOf = rev ? `${rev}^ ${old}` : `${last.value?.hash} ${old}`;
  const rightOf = rev ? `${rev} ${row.path}` : full;
  // A deleted file has nothing on disk to read.
  const gone = row.x === "D" || row.y === "D";
  try {
    const [head, disk] = await Promise.all([
      leftOf === sides.leftOf ? null : post<{ text: string | null }>(props.tab, "gitHead", { path: old, rev: rev && `${rev}^` }),
      gone
        ? { mtime: 0, text: "" }
        : !rev
          ? post<{ mtime: number; text?: string | null }>(props.tab, "readFile", { path: full, known: sides.rightOf === full ? sides.mtime : undefined })
          : rightOf === sides.rightOf
            ? { mtime: 0, text: undefined }
            : post<{ text: string | null; same: boolean }>(props.tab, "gitHead", { path: row.path, rev, same: true }).then(({ text, same }) => ({ mtime: 0, text, same })),
    ]);
    // Another row was picked, or the popup closed, while this was on its way.
    if (diffRow.value?.key !== key || !diffEditor) return;
    if ("same" in disk) fresh.value = disk.same === true;
    const before = head ? head.text : sides.before;
    const after = disk.text === undefined ? sides.after : disk.text;
    const same = shownKey === key && before === sides.before && after === sides.after;
    Object.assign(sides, { leftOf, before, rightOf, mtime: disk.mtime, after });
    diffError.value = "";
    if (same) return;
    // The same file read again keeps its place.
    const view = shownKey === key ? diffEditor.saveViewState() : null;
    shownKey = key;
    diffNote.value = before === null || after === null ? "This file isn't text, or is too big to show here." : "";
    if (before === null || after === null) return;
    // Monaco picks the language from the model's name and first line; the query keeps the names apart.
    const named = (text: string): monaco.editor.ITextModel => monaco.editor.createModel(text, undefined, monaco.Uri.file(full).with({ query: String(Math.random()) }));
    const was = diffEditor.getModel();
    diffEditor.setModel({ original: named(before), modified: named(after) });
    was?.original.dispose();
    was?.modified.dispose();
    if (view) diffEditor.restoreViewState(view);
  } catch (problem) {
    if (diffRow.value?.key === key) diffError.value = messageOf(problem);
  }
}
function closeDiff(): void {
  const was = diffEditor?.getModel();
  diffEditor?.dispose();
  was?.original.dispose();
  was?.modified.dispose();
  diffEditor = null;
  shownKey = "";
}
// The editor lives only while its place in the popup does.
watch(diffHost, (host) => {
  if (!host) return closeDiff();
  // ponytail: the text size is fixed; add the Files editor's ctrl-wheel zoom (both sides) if it is ever wanted.
  diffEditor = monaco.editor.createDiffEditor(host, { lineNumbers: numbered.value ? "on" : "off", theme: "claude2", automaticLayout: true, readOnly: true, fontSize: 14, minimap: { enabled: false }, wordWrap: "on", scrollBeyondLastLine: false, glyphMargin: false, folding: false, editContext: false, renderFinalNewline: "on", ignoreTrimWhitespace: false, hideUnchangedRegions: { enabled: true } });
  // A click on a line number, in the old file's column or the new one's, opens the file in the Files
  // pane's editor with that line (an old line's place in the new file) centered, for a fix
  // mid-review. Down and up on the same number: a drag over the numbers only selects lines. In the
  // one-column view the old file's numbers are still the old file's editor, narrowed to its margin.
  for (const [side, old] of [[diffEditor.getOriginalEditor(), true], [diffEditor.getModifiedEditor(), false]] as const) {
    const lineOf = ({ target }: monaco.editor.IEditorMouseEvent): number => {
      if (target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) return 0;
      return old ? modifiedLine(diffEditor?.getLineChanges() ?? [], target.position.lineNumber) : target.position.lineNumber;
    };
    let pressed = 0;
    side.onMouseDown((event) => void (pressed = event.event.leftButton ? lineOf(event) : 0));
    side.onMouseUp((event) => {
      const line = lineOf(event);
      if (line && line === pressed) openAt(line);
    });
  }
  void loadDiff();
}, { flush: "post" });
// The popup closes: the file is in the editor behind it. A review is kept (parked) for the Log button
// to bring back.
function openAt(line: number): void {
  if (!canOpen.value || committing.value) return;
  parked = !!review.value;
  emit("openFile", diffRow.value!.full!, line);
  dialog.value?.close();
}
// A row coming on show reads its right side again, as only that read says whether a reviewed file is
// still as its commit left it (the same row again, or a parked review brought back after an edit).
watch(() => diffRow.value?.key, () => {
  fresh.value = false;
  sides.rightOf = "";
  void loadDiff();
});
// The usual popup always numbers its lines; a review only where a click on one opens the file.
const numbered = computed(() => !review.value || canOpen.value);
watch(numbered, (on) => diffEditor?.updateOptions({ lineNumbers: on ? "on" : "off" }));

// Session events come in bursts (a Clean sends one per session), so they're gathered first.
let timer = 0;
function refreshSoon(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(refresh, 300);
}
watch(() => [props.active, props.version], refreshSoon, { immediate: true });

// For the Files tree's edits and other programs'. One request at a time, or a backend that stopped
// answering would use up the browser's few connections to it.
// ponytail: polling, not file watches, as the Files tree does; change it if the 2s lag ever matters.
// Closed projects too, every 30s, for the Tabs button's highlight.
// ponytail: one `git status` per open tab every 2s; poll tabs out of sight less often if that gets heavy.
let polling = false;
let ticks = 0;
async function poll(): Promise<void> {
  ticks++;
  if (polling || document.hidden || (!props.tab.open && ticks % 15)) return;
  polling = true;
  await refresh();
  polling = false;
}
let poller = 0;
// Ctrl-G opens or closes the popup from anywhere on the page, as the button does; it never commits.
// Capture phase, so an editor holding the cursor never gets the key (Monaco's go-to-line, the
// browser's find-next).
function onPageKey(event: KeyboardEvent): void {
  if (!props.active || event.code !== "KeyG" || !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat && !committing.value) void toggle();
}
// The button and Ctrl-G. A parked review ends first: this is the usual popup.
async function toggle(): Promise<void> {
  if (dialog.value?.open) return dialog.value.close();
  if (noRepo.value) return;
  if (review.value) {
    endReview();
    // closedby follows review before the popup shows.
    await nextTick();
  }
  open();
}
onMounted(() => {
  poller = window.setInterval(() => void poll(), 2000);
  window.addEventListener("keydown", onPageKey, true);
});
onBeforeUnmount(() => {
  closeDiff();
  window.clearInterval(poller);
  window.removeEventListener("keydown", onPageKey, true);
});

function open(): void {
  error.value = "";
  editing.value = "";
  named.value = -1;
  // Upper left, just under the button, and no taller than the room below it so the file list stays on screen.
  const { left, bottom } = button.value!.getBoundingClientRect();
  dialog.value!.style.margin = `${bottom + 4}px 0 0 ${left}px`;
  dialog.value!.style.maxHeight = `calc(100vh - ${bottom + 16}px)`;
  // With a diff on show it reaches from here to the window's right edge.
  dialog.value!.style.setProperty("--git-left", `${left}px`);
  // A review isn't modal: the Log pane beside it stays usable, its lines picking the commit.
  if (review.value) dialog.value!.show();
  else dialog.value!.showModal();
  isOpen.value = true;
  void refresh();
}

// A click on a Log pane line: the popup on that commit's changes, or the one open moving to it. A diff reaches over the log, so it is closed before another line
// can be clicked. Shown at once, the list filling in when it comes.
async function openCommit(hash: string, subject: string): Promise<void> {
  error.value = "";
  picked.value = new Set();
  review.value = { hash, subject, files: [] };
  if (!dialog.value!.open) {
    // closedby follows review before the popup shows.
    await nextTick();
    if (review.value?.hash === hash) open();
  }
  try {
    const { files: changes } = await post<{ files: GitFile[] }>(props.tab, "gitCommit", { hash });
    if (review.value?.hash === hash) review.value = { hash, subject, files: changes };
  } catch (problem) {
    if (review.value?.hash === hash) error.value = messageOf(problem);
  }
}
// Log view mode: a review is on, its popup open or parked while a file it opened is in the Files
// editor (`parked`). For the Log pane and the tab row: the commit under review (its line highlighted,
// the Log button red), and the end of the review (a tab row click, the log closing, the popup closing).
let parked = false;
const reviewing = computed(() => review.value?.hash ?? "");
function endReview(): void {
  if (!review.value) return;
  parked = false;
  if (dialog.value?.open) return dialog.value.close();
  review.value = undefined;
  picked.value = new Set();
}
// The tab's side pane changed: the log coming back brings a parked review back, popup, picked file and
// diff; anything else but the Files pane a parked review opened ends it.
function sideShown(side: string): void {
  if (!review.value) return;
  if (side !== "git") {
    if (!parked || !side.startsWith("file")) endReview();
  } else if (parked) {
    parked = false;
    open();
  }
}
defineExpose({ openCommit, reviewing, endReview, sideShown });

function onClose(): void {
  isOpen.value = false;
  // A row picked in the review isn't the usual popup's. A parked review keeps both.
  if (!parked) {
    if (review.value) picked.value = new Set();
    review.value = undefined;
  }
  emit("closed");
}

async function commit(): Promise<void> {
  if (!canCommit.value) return;
  committing.value = true;
  error.value = "";
  try {
    await post(props.tab, "commit", { message: message.value });
    setMessage("");
    dialog.value?.close();
  } catch (problem) {
    error.value = messageOf(problem);
  }
  committing.value = false;
  void refresh();
}

// Like VS Code's generate button: Opus 5.5 writes the commit message, replacing what's in the box.
async function describe(): Promise<void> {
  describing.value = true;
  error.value = "";
  try {
    setMessage((await post<{ text: string }>(props.tab, "describeChanges", {})).text);
  } catch (problem) {
    error.value = messageOf(problem);
  }
  describing.value = false;
}

// ↓ puts the newest session's name in the box, each click after it an older one, and ↑ goes back
// up the list. Clr and opening the popup start it over.
const named = ref(-1);
function walkNames(by: number): void {
  named.value = Math.min(Math.max(named.value + by, 0), props.sessionNames.length - 1);
  if (named.value >= 0) setMessage(props.sessionNames[named.value]!);
}
function clearMessage(): void {
  named.value = -1;
  setMessage("");
  messageBox.value?.focus();
}

// A click on the last commit's message edits its subject, as a long press does in the Log pane. Enter
// amends and pushes, Esc cancels, and leaving the input doesn't save it, or a stray click could
// force-push. `editing` holds the commit it began on, so if another commit lands meanwhile the
// backend refuses rather than amending that one. A refusal keeps the input, for another try.
const editing = ref("");
const draft = ref("");
const vFocus = { mounted: (el: HTMLInputElement) => (el.focus(), el.select()) };
function editLast(): void {
  if (committing.value || !last.value) return;
  draft.value = last.value.subject;
  editing.value = last.value.hash;
}
function stopEditing(): void {
  editing.value = "";
  messageBox.value?.focus();
}
async function saveLast(): Promise<void> {
  if (committing.value) return;
  const subject = draft.value.trim();
  if (!subject || subject === last.value?.subject) return stopEditing();
  committing.value = true;
  error.value = "";
  try {
    await post(props.tab, "reword", { hash: editing.value, message: subject });
    await refresh();
    stopEditing();
  } catch (problem) {
    error.value = messageOf(problem);
  }
  committing.value = false;
}

// VS Code's keys for the box: Up at the very start loads the previous message and Down at the very
// end the next, Alt with either from anywhere. Only the browser knows the wrapped rows, so a key that
// might be on the top or bottom row is left to it, and if the caret didn't move it was: VS Code
// goes to the text's start or end then, which some browsers don't.
function onMessageKey(event: KeyboardEvent): void {
  if (event.key === "Enter" && event.ctrlKey) {
    event.preventDefault();
    void commit();
    return;
  }
  const up = event.key === "ArrowUp";
  if ((!up && event.key !== "ArrowDown") || event.shiftKey || event.ctrlKey || event.metaKey || describing.value) return;
  const box = event.target as HTMLTextAreaElement;
  const caret = box.selectionDirection === "backward" ? box.selectionStart : box.selectionEnd;
  const edge = up ? 0 : box.value.length;
  if (caret !== edge && !event.altKey) {
    window.setTimeout(() => {
      if (box.selectionStart === caret && box.selectionEnd === caret) box.setSelectionRange(edge, edge);
    });
    return;
  }
  event.preventDefault();
  const text = up ? history.previous(box.value) : history.next(box.value);
  if (text === undefined) return;
  message.value = text;
  // The start after going back and the end after going forward, so the same key keeps going.
  void nextTick(() => {
    const place = up ? 0 : box.value.length;
    box.setSelectionRange(place, place);
    box.scrollTop = up ? 0 : box.scrollHeight;
  });
}
</script>

<template>
  <button ref="button" class="tab git" :class="{ dirty: files.length }" data-help="Git button" :title="failure || `Commit and push ${tab.path}: ${files.length} changed file${files.length === 1 ? '' : 's'}`" :disabled="noRepo" @click="toggle">
    G<span v-if="files.length">&nbsp;{{ files.length }}</span>
  </button>
  <dialog ref="dialog" class="git-pop" :class="{ wide: diffRow }" @cancel="committing && $event.preventDefault()" @close="onClose" :closedby="review ? 'closerequest' : 'any'">
    <div class="git-main">
      <div class="git-head">
        <div class="git-title">{{ review ? `Commit ${review.hash.slice(0, 7)}: ${review.subject}` : `Source Control: ${tab.path}` }}</div>
        <template v-if="!review">
        <button data-help="Git ↑ button" :disabled="describing || committing || named <= 0" @click="walkNames(-1)">↑</button>
        <button data-help="Git ↓ button" :disabled="describing || committing || named >= sessionNames.length - 1" @click="walkNames(1)">↓</button>
        <button data-help="Git Clr button" :disabled="describing || committing" @click="clearMessage">Clr</button>
        <button data-help="Git AI button" :disabled="describing || committing || !files.length" @click="describe">{{ describing ? "AI…" : "AI" }}</button>
        <button class="git-commit" data-help="Git Commit button" :disabled="!canCommit" @click="commit">{{ committing ? "Committing…" : "Commit" }}</button>
        </template>
        <button :disabled="committing" data-help="Git Close button" @click="dialog?.close()">Close</button>
      </div>
      <template v-if="!review">
      <input v-if="editing" v-model="draft" v-focus class="git-last-edit" data-help="Git last commit" spellcheck="false" :readonly="committing" @keydown.enter.prevent="saveLast" @keydown.esc.prevent="stopEditing" />
      <div v-else-if="last?.hash" class="git-last" data-help="Git last commit" @click="editLast">{{ last.subject }}</div>
      <textarea ref="messageBox" v-model="message" class="git-message" data-help="Git message box" rows="3" spellcheck="false" autofocus :readonly="describing" @keydown="onMessageKey"></textarea>
      </template>
      <div v-if="failure" class="git-error">{{ failure }}</div>
      <div v-if="error" class="git-error">{{ error }}</div>
      <div class="git-files" tabindex="-1" @keydown="onFilesKey">
        <template v-for="group in [{ title: 'Staged Changes', list: staged }, { title: 'Changes', list: changed }]" :key="group.title">
          <div v-if="group.list.length" class="git-group">{{ group.title }}<span class="git-count">{{ group.list.length }}</span></div>
          <div v-for="file in group.list" :key="file.key" class="git-file" data-help="Git file row" :class="[`git-${file.letter}`, { picked: picked.has(file.key) }]" :title="file.path" @click="clickFile(file.key, $event)">
            <span class="git-name">{{ nameOf(file.path) }}</span>
            <span class="git-folder">{{ folderOf(file.path) }}</span>
            <span class="git-letter">{{ file.letter }}</span>
          </div>
        </template>
        <div v-if="!shown.length && !failure" class="git-none">No changes.</div>
      </div>
    </div>
    <div v-if="diffRow" class="git-diff">
      <div class="git-diff-path">{{ diffRow.from ? `${diffRow.from} → ${diffRow.path}` : diffRow.path }}</div>
      <div v-if="diffError" class="git-error">{{ diffError }}</div>
      <div v-else-if="diffNote">{{ diffNote }}</div>
      <div v-show="!diffError && !diffNote" class="git-diff-text" data-help="Git diff" :class="{ opens: canOpen }"><div ref="diffHost"></div></div>
    </div>
  </dialog>
</template>

<style scoped>
/* Something to commit: changed or staged files. */
.git.dirty { background: #fbd9d9; border-color: #e4a7a7; }
.git.dirty:hover { background: linear-gradient(var(--wash), var(--wash)), #fbd9d9; }
.git-pop { width: min(420px, 92vw); max-height: 86vh; padding: 12px; border: 1px solid #000; border-radius: 8px; background: var(--surface); color: var(--ink); line-height: 1.5; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2); }
.git-pop button { height: 25px; min-height: 0; flex: none; padding: 0 8px; }
.git-pop[open] { display: flex; gap: 12px; }
/* A diff on show: from under the button to the window's right and bottom edges, the lists keeping their width and place. */
.git-pop.wide { width: calc(100vw - var(--git-left) - 12px); max-width: none; height: 100vh; }
.git-main { display: flex; flex-direction: column; gap: 8px; flex: 1; min-width: 0; min-height: 0; }
/* A review isn't modal: placed as the modal popup is, over the panes. */
.git-pop:not(:modal) { position: fixed; inset: 0; z-index: 100; }
.git-pop.wide .git-main { flex: none; width: calc(min(420px, 92vw) - 26px); }
.git-diff { display: flex; flex-direction: column; gap: 8px; flex: 1; min-width: 0; }
.git-diff-path { font-weight: 600; overflow-wrap: anywhere; }
.git-diff-text { position: relative; flex: 1; min-height: 0; border: 1px solid var(--border); border-radius: 6px; }
/* Inset just past the rounded corners, as the Files editor is. */
.git-diff-text > div { position: absolute; inset: 3px; }
/* A line number opens the file there. */
.git-diff-text.opens :deep(.margin .line-numbers) { cursor: pointer; }
.git-pop::backdrop { background: rgba(0, 0, 0, 0.15); }
.git-head { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 8px; }
.git-title { flex: 1 0 100%; min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
.git-last, .git-last-edit { padding: 5px 8px; border: 1px solid transparent; border-radius: 6px; color: var(--ink); font: inherit; }
.git-last { cursor: text; overflow-wrap: anywhere; }
.git-last:hover { background: var(--wash); }
.git-last-edit { box-sizing: border-box; width: 100%; border-color: var(--border); background: var(--yellow); }
.git-message { resize: vertical; padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px; background: #fff; color: var(--ink); font: inherit; }
.git-error { background: #fbd9d9; border: 1px solid #e4a7a7; border-radius: 6px; padding: 4px 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.git-files { overflow: auto; min-height: 0; outline: none; user-select: none; }
.git-group { display: flex; align-items: center; gap: 8px; margin: 6px 0 2px; font-weight: 600; }
.git-count { padding: 0 7px; border-radius: 9px; background: #cfe8ff; font-weight: 400; }
.git-file { display: flex; align-items: baseline; gap: 8px; padding: 1px 4px 1px 14px; border-radius: 4px; white-space: nowrap; }
.git-file:hover { background: var(--wash); }
.git-file.picked { background: var(--yellow); }
.git-name { flex: none; }
.git-folder { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.git-letter { flex: none; width: 1.2em; text-align: center; font-weight: 600; }
.git-D .git-name { text-decoration: line-through; }
.git-none { padding: 4px 0; }
.git-commit { background: #cfe8ff; border-color: #8fb8e0; }
.git-commit:hover:not(:disabled) { background: linear-gradient(var(--wash), var(--wash)), #cfe8ff; }
</style>
