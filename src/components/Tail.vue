<script setup lang="ts">
// The tab row's Tail pane: the end of one of the project's primary logs, live. `tailLogs` finds them
// (the project's own *.log files and the logs of pm2 processes run from its folder, the most recently
// written first, so the first is the one it opens on); the header's select picks another, and the pick
// is remembered per tab. Whole lines only, the last 500 on opening and 500 older ones each time the
// scroll reaches the top, back to the file's start. New lines come as the backend sees them
// (`tailWait`); the view follows them only while it is at the bottom, as the Files editor does.
// ponytail: nothing is dropped from the top as lines arrive; a long-open pane on a busy log grows until it is closed.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Tab } from "../../shared/config.ts";
import { postHost } from "../api.ts";
import { wheelZoom } from "../wheelZoom.ts";

const props = defineProps<{ tab: Tab; active: boolean }>();
interface Chunk {
  text: string;
  start: number;
  end: number;
  ino: number;
}

const logs = ref<{ path: string; label: string }[]>([]);
const loaded = ref(false);
const chosen = ref("");
const note = ref("");
// The view is at the bottom, so new lines move it: the select goes yellow, as the Files editor's path does.
const following = ref(true);
const box = ref<HTMLElement>();
const pre = ref<HTMLElement>();
// Where the lines on show begin and end in the file (bytes), and which file it is, for the next reads.
let start = 0;
let end = 0;
let ino = 0;
// Each opening of a log, and each start over, is a generation; what an older one asks for is dropped.
let generation = 0;
let loadingUp = false;
let alive = true;
const savedKey = `claude3.tailLog:${props.tab.id}`;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
// pm2 writes its colour codes into its files.
const plain = (text: string): string => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r\n/g, "\n");
const atBottom = (): boolean => box.value!.scrollTop + box.value!.clientHeight >= box.value!.scrollHeight - 2;
const toBottom = (): void => void (box.value!.scrollTop = box.value!.scrollHeight);

// Reads the log's end, then waits for its new lines, until another log is chosen or the pane closes.
// Hidden pages and tabs off show ask for nothing; a failed read is tried again every 2s, so a log that
// reappears, or a backend not yet deployed with these actions, is picked up as soon as it answers.
async function follow(path: string): Promise<void> {
  const mine = ++generation;
  pre.value!.textContent = "";
  start = end = ino = 0;
  let ready = false;
  while (alive && mine === generation) {
    if (!props.active || document.hidden) {
      await sleep(500);
      continue;
    }
    try {
      if (!ready) {
        const first = await postHost<Chunk>(props.tab.host, "tailRead", { path });
        if (mine !== generation) return;
        ({ start, end, ino } = first);
        pre.value!.append(plain(first.text));
        toBottom();
        ready = true;
      } else {
        const more = await postHost<{ text?: string; end?: number; reset?: boolean }>(props.tab.host, "tailWait", { path, from: end, ino });
        if (mine !== generation) return;
        if (more.reset) return void follow(path);
        if (more.text) {
          const stick = atBottom();
          pre.value!.append(plain(more.text));
          end = more.end!;
          if (stick) toBottom();
        }
      }
      note.value = "";
    } catch (error) {
      if (mine !== generation) return;
      note.value = messageOf(error);
      await sleep(2000);
    }
  }
}

// The 500 lines before the ones on show, put above them with the view kept on what it showed.
async function loadUp(): Promise<void> {
  if (loadingUp || !start) return;
  loadingUp = true;
  const mine = generation;
  try {
    const older = await postHost<Chunk>(props.tab.host, "tailRead", { path: chosen.value, before: start });
    if (mine === generation && older.text) {
      const height = box.value!.scrollHeight;
      pre.value!.prepend(plain(older.text));
      start = older.start;
      box.value!.scrollTop += box.value!.scrollHeight - height;
    }
  } catch (error) {
    if (mine === generation) note.value = messageOf(error);
  }
  loadingUp = false;
}

function scrolled(): void {
  following.value = atBottom();
  if (box.value!.scrollTop < 200) void loadUp();
}

// Ctrl-wheel sizes the text; a view at the bottom stays there, as new lines keep it.
const zoom = wheelZoom("tail-font-size");
function onWheel(event: WheelEvent): void {
  const stick = atBottom();
  zoom(event);
  if (event.ctrlKey && stick) toBottom();
}

const remember = (path: string): void => localStorage.setItem(savedKey, path);

watch(chosen, (path) => void follow(path));
onMounted(async () => {
  try {
    logs.value = (await postHost<{ logs: { path: string; label: string }[] }>(props.tab.host, "tailLogs", { root: props.tab.path })).logs;
    const saved = localStorage.getItem(savedKey);
    chosen.value = logs.value.find((log) => log.path === saved)?.path ?? logs.value[0]?.path ?? "";
  } catch (error) {
    note.value = messageOf(error);
  }
  loaded.value = true;
});
onBeforeUnmount(() => (alive = false));
</script>

<template>
  <div class="tail" @wheel="onWheel">
    <div class="tail-head">
      <select v-if="logs.length" v-model="chosen" :class="{ following }" aria-label="Log file" data-help="Tail log select" @change="remember(($event.target as HTMLSelectElement).value)"><option v-for="log in logs" :key="log.path" :value="log.path">{{ log.label }}</option></select>
      <span v-else-if="loaded && !note">No log files found in this project's folder, or run by pm2 from it.</span>
    </div>
    <div v-if="note" class="tail-note">{{ note }}</div>
    <div ref="box" class="tail-text" data-help="Tail log" @scroll="scrolled"><pre ref="pre"></pre></div>
  </div>
</template>

<style scoped>
.tail { min-height: 0; min-width: 0; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; background: var(--page); color: var(--ink); }
.tail-head { flex: none; }
.tail-head select { max-width: 100%; min-height: 0; padding: 3px 8px; }
.tail-head select.following { background: var(--yellow); }
.tail-note { flex: none; background: #fbd9d9; border: 1px solid #e4a7a7; border-radius: 8px; padding: 4px 8px; overflow-wrap: anywhere; }
/* overflow-anchor off: the script keeps the view still when lines are added above it. */
.tail-text { flex: 1; min-height: 0; overflow: auto; overflow-anchor: none; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.tail-text pre { margin: 0; padding: 6px 8px; white-space: pre-wrap; overflow-wrap: anywhere; font: var(--tail-font-size, 14px)/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--ink); }
</style>
