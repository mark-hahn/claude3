<script setup lang="ts">
// The tab row's Git button (teleported there by Project) and its popup, a small copy of VS Code's Source Control view for the
// tab's project: the last commit's message, the new commit message, then the staged and the changed files. Commit stages
// everything, commits, and pushes (the backend's `commit`). The label counts the files waiting
// for a commit. It's re-read while the project is open, on show or not, for the dot on its tab:
// when it comes up, when a session changes (a turn starting or ending), and every 2s for changes
// no event tells of.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Tab } from "../../shared/config.ts";
import { post } from "../api.ts";
import { MessageHistory } from "../messageHistory.ts";

const props = defineProps<{ tab: Tab; active: boolean; version: number }>();
const emit = defineEmits<{ closed: []; dirty: [dirty: boolean]; noRepo: [none: boolean] }>();

// One `git status --porcelain` entry: x is the index's letter, y the work tree's.
interface GitFile {
  x: string;
  y: string;
  path: string;
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

const staged = computed(() => files.value.filter((file) => !" ?".includes(file.x)).map((file) => ({ ...file, letter: file.x })));
const changed = computed(() => files.value.filter((file) => file.y !== " ").map((file) => ({ ...file, letter: file.y === "?" ? "U" : file.y })));
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
}

// Session events come in bursts (a Clean sends one per session), so they're gathered first.
let timer = 0;
function refreshSoon(): void {
  if (!props.tab.open) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(refresh, 300);
}
watch(() => [props.active, props.version], refreshSoon, { immediate: true });

// For the Files tree's edits and other programs'. One request at a time, or a backend that stopped
// answering would use up the browser's few connections to it.
// ponytail: polling, not file watches, as the Files tree does; change it if the 2s lag ever matters.
// ponytail: one `git status` per open tab every 2s; poll tabs out of sight less often if that gets heavy.
let polling = false;
async function poll(): Promise<void> {
  if (polling || document.hidden || !props.tab.open) return;
  polling = true;
  await refresh();
  polling = false;
}
let poller = 0;
// Ctrl-G opens or closes the popup from anywhere on the page, as the button does; in the message box
// with text in it, it commits instead. Capture phase, so an editor holding the cursor never gets the
// key (Monaco's go-to-line, the browser's find-next).
function onPageKey(event: KeyboardEvent): void {
  if (!props.active || event.code !== "KeyG" || !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat || committing.value) return;
  if (!dialog.value?.open) {
    if (!noRepo.value) open();
  } else if (document.activeElement === messageBox.value && message.value.trim()) void commit();
  else dialog.value.close();
}
onMounted(() => {
  poller = window.setInterval(() => void poll(), 2000);
  window.addEventListener("keydown", onPageKey, true);
});
onBeforeUnmount(() => {
  window.clearInterval(poller);
  window.removeEventListener("keydown", onPageKey, true);
});

function open(): void {
  error.value = "";
  editing.value = "";
  // Upper left, just under the button, and no taller than the room below it so Commit stays on screen.
  const { left, bottom } = button.value!.getBoundingClientRect();
  dialog.value!.style.margin = `${bottom + 4}px 0 0 ${left}px`;
  dialog.value!.style.maxHeight = `calc(100vh - ${bottom + 16}px)`;
  dialog.value!.showModal();
  void refresh();
}

// The modal's backdrop covers the Git button, so a click on the button lands on the dialog
// instead; when it falls inside the button's box, close, so the button toggles the popup.
function onDialogClick(event: MouseEvent): void {
  if (event.target !== dialog.value || committing.value) return;
  const box = button.value?.getBoundingClientRect();
  if (box && event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom) dialog.value?.close();
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
  <button ref="button" class="tab git" :class="{ dirty: files.length }" :title="failure || `Commit and push ${tab.path}: ${files.length} changed file${files.length === 1 ? '' : 's'}`" :disabled="noRepo" @click="open">
    Git<span v-if="files.length">&nbsp;{{ files.length }}</span>
  </button>
  <dialog ref="dialog" class="git-pop" @cancel="committing && $event.preventDefault()" @close="emit('closed')" @click="onDialogClick">
    <div class="git-head">
      <div class="git-title">Source Control: {{ tab.path }}</div>
      <button class="git-describe" :disabled="describing || committing || !files.length" @click="describe">{{ describing ? "Describing…" : "Describe changes" }}</button>
    </div>
    <input v-if="editing" v-model="draft" v-focus class="git-last-edit" spellcheck="false" :readonly="committing" @keydown.enter.prevent="saveLast" @keydown.esc.prevent="stopEditing" />
    <div v-else-if="last?.hash" class="git-last" title="The last commit's message. Click to edit it: Enter amends and pushes, Esc cancels." @click="editLast">{{ last.subject }}</div>
    <textarea ref="messageBox" v-model="message" class="git-message" rows="3" spellcheck="false" autofocus :readonly="describing" @keydown="onMessageKey"></textarea>
    <div v-if="failure" class="git-error">{{ failure }}</div>
    <div v-if="error" class="git-error">{{ error }}</div>
    <div class="git-files">
      <template v-for="group in [{ title: 'Staged Changes', list: staged }, { title: 'Changes', list: changed }]" :key="group.title">
        <div v-if="group.list.length" class="git-group">{{ group.title }}<span class="git-count">{{ group.list.length }}</span></div>
        <div v-for="file in group.list" :key="group.title + file.path" class="git-file" :class="`git-${file.letter}`" :title="file.path">
          <span class="git-name">{{ nameOf(file.path) }}</span>
          <span class="git-folder">{{ folderOf(file.path) }}</span>
          <span class="git-letter">{{ file.letter }}</span>
        </div>
      </template>
      <div v-if="!files.length && !failure" class="git-none">No changes.</div>
    </div>
    <div class="git-buttons">
      <button class="git-commit" :disabled="!canCommit" @click="commit">{{ committing ? "Committing…" : "Commit" }}</button>
      <button :disabled="committing" @click="dialog?.close()">Close</button>
    </div>
  </dialog>
</template>

<style scoped>
/* Something to commit: changed or staged files. */
.git.dirty { background: #fbd9d9; border-color: #e4a7a7; }
.git.dirty:hover { background: linear-gradient(var(--wash), var(--wash)), #fbd9d9; }
.git-pop { width: min(560px, 92vw); max-height: 86vh; padding: 12px; border: 1px solid #000; border-radius: 8px; background: var(--surface); color: var(--ink); line-height: 1.5; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2); }
.git-pop button { height: 25px; min-height: 0; flex: none; padding: 0 8px; }
.git-pop[open] { display: flex; flex-direction: column; gap: 8px; }
.git-pop::backdrop { background: rgba(0, 0, 0, 0.15); }
.git-head { display: flex; align-items: center; gap: 8px; }
.git-title { flex: 1; min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
.git-describe { flex: none; }
.git-last, .git-last-edit { padding: 5px 8px; border: 1px solid transparent; border-radius: 6px; color: var(--ink); font: inherit; }
.git-last { cursor: text; overflow-wrap: anywhere; }
.git-last:hover { background: var(--wash); }
.git-last-edit { box-sizing: border-box; width: 100%; border-color: var(--border); background: var(--yellow); }
.git-message { resize: vertical; padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px; background: #fff; color: var(--ink); font: inherit; }
.git-error { background: #fbd9d9; border: 1px solid #e4a7a7; border-radius: 6px; padding: 4px 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.git-files { overflow: auto; min-height: 0; }
.git-group { display: flex; align-items: center; gap: 8px; margin: 6px 0 2px; font-weight: 600; }
.git-count { padding: 0 7px; border-radius: 9px; background: #cfe8ff; font-weight: 400; }
.git-file { display: flex; align-items: baseline; gap: 8px; padding: 1px 4px 1px 14px; border-radius: 4px; white-space: nowrap; }
.git-file:hover { background: var(--wash); }
.git-name { flex: none; }
.git-folder { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.git-letter { flex: none; width: 1.2em; text-align: center; font-weight: 600; }
.git-D .git-name { text-decoration: line-through; }
.git-none { padding: 4px 0; }
.git-buttons { display: flex; gap: 8px; }
.git-commit { flex: 1; background: #cfe8ff; border-color: #8fb8e0; }
.git-commit:hover:not(:disabled) { background: linear-gradient(var(--wash), var(--wash)), #cfe8ff; }
</style>
