<script setup lang="ts">
// The sidebar's Git button and its popup, a small copy of VS Code's Source Control view for the
// tab's project: the commit message, then the staged and the changed files. Commit stages
// everything, commits, and pushes (the backend's `commit`). The label counts the files waiting
// for a commit. It's re-read while the project is open, on show or not, for the dot on its tab:
// when it comes up, when a session changes (a turn starting or ending), and every 2s for changes
// no event tells of.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Tab } from "../../shared/config.ts";
import { post } from "../api.ts";

const props = defineProps<{ tab: Tab; active: boolean; version: number }>();
const emit = defineEmits<{ closed: []; dirty: [dirty: boolean] }>();

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

const staged = computed(() => files.value.filter((file) => !" ?".includes(file.x)).map((file) => ({ ...file, letter: file.x })));
const changed = computed(() => files.value.filter((file) => file.y !== " ").map((file) => ({ ...file, letter: file.y === "?" ? "U" : file.y })));
const canCommit = computed(() => !committing.value && !describing.value && !!message.value.trim() && files.value.length > 0);
const noRepo = computed(() => /not a git repository/i.test(failure.value));
watch(() => files.value.length > 0, (dirty) => emit("dirty", dirty));

const messageOf = (problem: unknown): string => (problem instanceof Error ? problem.message : String(problem));
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const folderOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf("/"), 0));

async function refresh(): Promise<void> {
  try {
    files.value = (await post<{ files: GitFile[] }>(props.tab, "git", {})).files;
    failure.value = "";
  } catch (problem) {
    files.value = [];
    failure.value = messageOf(problem);
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
onMounted(() => (poller = window.setInterval(() => void poll(), 2000)));
onBeforeUnmount(() => window.clearInterval(poller));

function open(): void {
  error.value = "";
  void refresh();
  // Upper left, just under the button, and no taller than the room below it so Commit stays on screen.
  const { left, bottom } = button.value!.getBoundingClientRect();
  dialog.value!.style.margin = `${bottom + 4}px 0 0 ${left}px`;
  dialog.value!.style.maxHeight = `calc(100vh - ${bottom + 16}px)`;
  dialog.value!.showModal();
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
    message.value = "";
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
    message.value = (await post<{ text: string }>(props.tab, "describeChanges", {})).text;
  } catch (problem) {
    error.value = messageOf(problem);
  }
  describing.value = false;
}

function onMessageKey(event: KeyboardEvent): void {
  if (event.key === "Enter" && event.ctrlKey) {
    event.preventDefault();
    void commit();
  }
}
</script>

<template>
  <button ref="button" class="git" :class="{ dirty: files.length }" :title="failure || `Commit and push ${tab.path}: ${files.length} changed file${files.length === 1 ? '' : 's'}`" :disabled="noRepo" @click="open">
    Git<span v-if="files.length">&nbsp;{{ files.length }}</span>
  </button>
  <dialog ref="dialog" class="git-pop" @cancel="committing && $event.preventDefault()" @close="emit('closed')" @click="onDialogClick">
    <div class="git-head">
      <div class="git-title">Source Control: {{ tab.path }}</div>
      <button class="git-describe" :disabled="describing || committing || !files.length" @click="describe">{{ describing ? "Describing…" : "Describe changes" }}</button>
    </div>
    <textarea v-model="message" class="git-message" rows="3" spellcheck="false" autofocus :readonly="describing" @keydown="onMessageKey"></textarea>
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
      <button :disabled="committing" @click="dialog?.close()">Hide</button>
      <button :disabled="committing" @click="dialog?.close()">Cancel</button>
    </div>
  </dialog>
</template>

<style scoped>
/* Something to commit: changed or staged files. */
.git.dirty { background: #fbd9d9; border-color: #e4a7a7; }
.git.dirty:hover { background: linear-gradient(var(--wash), var(--wash)), #fbd9d9; }
.git-pop { width: min(560px, 92vw); max-height: 86vh; padding: 12px; border: 1px solid #000; border-radius: 8px; background: var(--surface); color: var(--ink); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2); }
.git-pop[open] { display: flex; flex-direction: column; gap: 8px; }
.git-pop::backdrop { background: rgba(0, 0, 0, 0.15); }
.git-head { display: flex; align-items: center; gap: 8px; }
.git-title { flex: 1; min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
.git-describe { flex: none; }
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
