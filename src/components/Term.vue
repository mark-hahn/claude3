<script setup lang="ts">
// One terminal of the tab row's Term pane (Project stacks up to three): xterm.js on its own pty (server/term.ts), bash or PowerShell on win,
// kept by the backend while the pane is closed. Keys go up as typed, Ctrl-C included; selecting text
// (a double-click's word too) copies it, with text selected Ctrl-C copies it instead, and Ctrl-V pastes.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type IMarker } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { HOSTS, type HostName, type Tab } from "../../shared/config.ts";
import { postHost } from "../api.ts";
import { findBack, STAMP } from "../termFind.ts";
import FolderPicker from "./FolderPicker.vue";

// index: which of the pane's terminals this is, 0 to 2, each with its own shell. count: how many the pane has.
// host: where its shell runs, which needn't be the tab's. start: the folder the shell starts in.
const props = defineProps<{ tab: Tab; active: boolean; index: number; count: number; host: HostName; start: string }>();
// add: another terminal, on that host starting in that folder (the header's +: the project's host and folder; the Path
// dialog: a folder picked on another host). close: Project takes this terminal out (the header's Close, or its shell has exited and it isn't the only one).
const emit = defineEmits<{ add: [host: HostName, start: string]; close: [] }>();
const call = <T = Record<string, unknown>,>(action: string, body: Record<string, unknown>): Promise<T> => postHost<T>(props.host, action, { tab: props.tab.id, term: props.index, cwd: props.start, ...body });
const box = ref<HTMLElement>();
const messageOf = (problem: unknown): string => (problem instanceof Error ? problem.message : String(problem));
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// VS Code's light terminal colours, greys included (at the user's asking).
// Ctrl-wheel sizes this pane's text alone, remembered like the Snips' (no limits but visible, at the user's asking).
const FONT_KEY = "claude3.termFontSize";
const term = new Terminal({
  scrollback: 1000,
  fontSize: Number(localStorage.getItem(FONT_KEY)) || 14,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  cursorBlink: true,
  minimumContrastRatio: 4.5,
  // For the brown timestamps' decorations.
  allowProposedApi: true,
  windowsPty: props.host === "win" ? { backend: "conpty" } : undefined,
  theme: {
    background: "#f9f9f7", foreground: "#000000", cursor: "#000000", cursorAccent: "#f9f9f7", selectionBackground: "#add6ff",
    black: "#000000", red: "#cd3131", green: "#107c10", yellow: "#949800", blue: "#0451a5", magenta: "#bc05bc", cyan: "#0598bc", white: "#555555",
    brightBlack: "#666666", brightRed: "#cd3131", brightGreen: "#14ce14", brightYellow: "#b5ba00", brightBlue: "#0451a5", brightMagenta: "#bc05bc", brightCyan: "#0598bc", brightWhite: "#a5a5a5",
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
// The header's folder: each prompt sends it as OSC 7 with a bare path (server/term.ts).
const cwd = ref(props.start);
// In pieces that each end at a slash, so a folder too long for the header wraps after one.
const cwdParts = computed(() => cwd.value.split(/(?<=[\\/])/));
term.parser.registerOscHandler(7, (data) => {
  cwd.value = data;
  return true;
});
// The header's m:ss since the shell's last output or key, as the backend counts it (so a reload keeps it), stopping at 59:59.
const lastAt = ref(0);
const now = ref(Date.now());
const ticker = setInterval(() => (now.value = Date.now()), 1000);
const idle = computed(() => {
  if (!lastAt.value) return "";
  const secs = Math.min(Math.max(0, Math.floor((now.value - lastAt.value) / 1000)), 59 * 60 + 59);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
});
term.attachCustomKeyEventHandler((event) => {
  // Ctrl-R and Ctrl-Shift-R are left to the browser, to reload the page (at the user's asking: the shell's history search loses its key).
  if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "r") return false;
  if (event.type !== "keydown" || !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return true;
  if (event.key === "c" && term.hasSelection()) {
    event.preventDefault();
    void navigator.clipboard.writeText(term.getSelection());
    term.clearSelection();
    return false;
  }
  // Left to the browser, whose paste event xterm takes.
  return event.key !== "v";
});
// Selecting copies, a double-click's word too (VS Code's copyOnSelection).
term.onSelectionChange(() => !finding && term.hasSelection() && void navigator.clipboard.writeText(term.getSelection()));

// The header's search box: Enter selects the last place its text is in the buffer, and each Enter after
// that the one above. The last hit is the selection, while it still reads as the text; from the top one
// the search goes round to the bottom. A hit out of view is scrolled to the middle. Red: no hit at all.
const findText = ref("");
const missed = ref(false);
// Set while a hit is being selected, which is not for the clipboard.
let finding = false;
function find(): void {
  const text = findText.value;
  if (!text) return;
  const buffer = term.buffer.active;
  const last = term.getSelection().toLowerCase() === text.toLowerCase() ? term.getSelectionPosition()?.start : undefined;
  const hit = findBack(buffer, term.cols, text, last) ?? (last ? findBack(buffer, term.cols, text) : null);
  missed.value = !hit;
  if (!hit) return;
  finding = true;
  term.select(hit.col, hit.row, hit.length);
  finding = false;
  if (hit.row < buffer.viewportY || hit.row >= buffer.viewportY + term.rows) term.scrollToLine(Math.max(0, hit.row - Math.floor(term.rows / 2)));
}

// Keys one request at a time, so they reach the shell in order; those typed meanwhile go together.
let pending = "";
let sending = false;
async function flush(): Promise<void> {
  if (sending || !pending) return;
  sending = true;
  const data = pending;
  pending = "";
  try {
    await call("termSend", { data });
  } catch (problem) {
    window.alert(`Term: ${messageOf(problem)}`);
  }
  sending = false;
  void flush();
}
term.onData((data) => {
  pending += data;
  void flush();
});
term.onResize(({ cols, rows }) => void call("termResize", { cols, rows }).catch(() => undefined));

// Timestamps in brown (STAMP, at the user's asking), as decorations, which leave the shell's colours alone. After each
// write, the lines it can have changed (the screen's, from its top before the write, which a marker follows through
// the scrollback's trimming) lose theirs and are matched again. Each has its own marker, disposed with it, else
// they'd pile up. Not on the alternate screen (vim, less), which takes no decorations. Clr and a reset drop them all.
// ponytail: one cut by a line's wrap isn't matched, and a match's string index is its column (wrong after wide characters).
let stamped: IMarker[] = [];
function write(text: string): void {
  const before = term.buffer.active;
  const top = before.type === "normal" ? term.registerMarker(-before.cursorY) : undefined;
  term.write(text, () => {
    const buffer = term.buffer.active;
    const from = top ? Math.max(0, top.line) : buffer.baseY;
    top?.dispose();
    if (buffer.type !== "normal") return;
    for (const marker of stamped) if (marker.line >= from) marker.dispose();
    stamped = stamped.filter((marker) => !marker.isDisposed);
    const cursor = buffer.baseY + buffer.cursorY;
    for (let y = from; y < buffer.length; y++) {
      for (const match of buffer.getLine(y)?.translateToString(true).matchAll(STAMP) ?? []) {
        const marker = term.registerMarker(y - cursor);
        if (term.registerDecoration({ marker, x: match.index, width: match[0].length, foregroundColor: "#8b4513" })) stamped.push(marker);
        else marker.dispose();
      }
    }
  });
}

// A long poll: the backend answers at once with output this page hasn't seen, else after 2s.
let alive = true;
// The read on its way to the backend, for close to wait on.
let reading: Promise<unknown> = Promise.resolve();
async function follow(): Promise<void> {
  let id = "";
  let at = 0;
  while (alive) {
    if (!props.active || document.hidden) {
      await pause(500);
      continue;
    }
    try {
      const read = call<{ id: string; at: number; text: string; reset: boolean; idle: number; exited: boolean }>("termRead", { id, at, cols: term.cols, rows: term.rows });
      reading = read;
      const got = await read;
      if (!alive) return;
      if (got.exited && props.count > 1) return close();
      if (got.reset) term.reset();
      if (got.text) write(got.text);
      lastAt.value = Date.now() - got.idle;
      ({ id, at } = got);
    } catch (problem) {
      term.write(`\r\n[${messageOf(problem)}]\r\n`);
      id = "";
      await pause(2000);
    }
  }
}

// The header's Path: the folder picker with a host selector left of its box, opened on this terminal's
// host at its shell's folder. Another host chosen there only moves the picker to that host's home
// folder (back on this one, to the shell's folder); nothing is done until Ok. A folder picked on this
// host is a cd to it, after clearing any half-typed line (bash's Ctrl-E Ctrl-U; PowerShell's is left
// as it is); one on another host is a new terminal there, starting in it. With three terminals the
// selector is off.
const picker = ref<InstanceType<typeof FolderPicker>>();
const pickHost = ref<HostName>(props.host);
function showHost(host: HostName): void {
  pickHost.value = host;
  picker.value?.open(host === props.host ? cwd.value : HOSTS[host].home, host);
}
function picked(folder: string): void {
  if (pickHost.value !== props.host) return emit("add", pickHost.value, folder);
  cd(folder);
}
function cd(folder: string): void {
  pending += props.host === "win" ? `Set-Location -LiteralPath '${folder.replaceAll("'", "''")}'\r` : `\x05\x15cd -- '${folder.replaceAll("'", "'\\''")}'\r`;
  void flush();
  term.focus();
}

// The header's Clr: all but the prompt line, here and in the backend's buffer (so a reload keeps it cleared).
function clear(): void {
  term.clear();
  term.focus();
  call("termClear", {}).catch((problem) => window.alert(`Term: ${messageOf(problem)}`));
}

// The header's Close, or the shell's exit with other terminals left: no more reads here, Project takes
// the terminal out, and the backend forgets its shell, ending one still running. That waits for the read
// on its way to be answered (2s at most), since one arriving after it would start the shell again.
function close(): void {
  alive = false;
  emit("close");
  void reading.catch(() => undefined).then(() => call("termClose", {})).catch((problem) => window.alert(`Term: ${messageOf(problem)}`));
}

// Capture phase, so xterm doesn't scroll as well; the box keeps its size, so the fit is called here.
function zoom(event: WheelEvent): void {
  if (!event.ctrlKey) return;
  event.preventDefault();
  event.stopPropagation();
  term.options.fontSize = Math.max(1, (term.options.fontSize ?? 14) + (event.deltaY < 0 ? 1 : -1));
  localStorage.setItem(FONT_KEY, String(term.options.fontSize));
  fit.fit();
}

const resized = new ResizeObserver(() => box.value?.clientWidth && fit.fit());
onMounted(() => {
  term.open(box.value!);
  fit.fit();
  resized.observe(box.value!);
  term.focus();
  void follow();
});
defineExpose({ focus: () => term.focus() });
onBeforeUnmount(() => {
  alive = false;
  clearInterval(ticker);
  resized.disconnect();
  term.dispose();
});
</script>

<template>
  <div class="term" @wheel.capture="zoom">
    <div class="term-head"><span class="term-cwd">{{ host }}: <span v-for="(part, at) in cwdParts" :key="at">{{ part }}</span></span><span class="term-bar"><button data-help="Term + button" title="Add a terminal right below, on the project's host in the project's folder, three at most" aria-label="Add a terminal" :disabled="count >= 3" @click="emit('add', tab.host, tab.path)">+</button><button class="term-path" data-help="Term Path button" title="Pick a folder for the shell to cd to, or one on another host for a new terminal there" @click="showHost(host)">Path</button><input v-model="findText" class="tabs-input" :class="{ missed }" spellcheck="false" aria-label="Search the terminal's text, from the bottom up" data-help="Term search box" data-mode="Term search box" @input="missed = false" @keydown.enter.prevent="find" @keydown.esc.prevent="term.focus()" /><button data-help="Term Clr button" title="Clear all but the prompt line" @click="clear">Clr</button><button data-help="Term Close button" title="End this terminal's shell and take it out of the pane; the last one closes the pane" @click="close">Close</button><span class="term-idle" title="Time since the shell's last output or key">{{ idle }}</span></span></div>
    <div ref="box" class="term-box" data-help="terminal" data-mode="terminal"></div>
    <FolderPicker ref="picker" :host="host" @pick="picked">
      <select :value="pickHost" :disabled="count >= 3" aria-label="Host" title="The host whose folders these are" data-help="Term host" @change="showHost(($event.target as HTMLSelectElement).value as HostName)"><option v-for="(_, name) in HOSTS" :key="name">{{ name }}</option></select>
    </FolderPicker>
  </div>
</template>

<style scoped>
/* The padding is the outer div's: the fit measures the inner one. */
/* The black line is above each terminal's header (at the user's asking). */
.term { min-height: 0; min-width: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 6px; padding: 6px 0 0 10px; border-top: 1px solid #000; background: #f9f9f7; }
/* One row while the folder fits left of the buttons, search box and time; else it goes below them, on a row
   of its own. wrap-reverse: the folder comes first, so the buttons' line, the second, is the upper one.
   In a column too narrow even for them, they wrap onto a second row of theirs, still above the folder's. */
.term-head { display: flex; flex-wrap: wrap-reverse; align-items: center; gap: 6px 8px; padding: 0 10px 6px 0; border-bottom: 1px solid var(--border); color: #000; font-size: 14px; }
/* All but the folder is 20% smaller than the page's 14px controls (at the user's asking). */
.term-head button, .term-head .tabs-input, .term-idle { font-size: 11.2px; }
.term-head button { min-height: 0; padding: 2px 8px; border-radius: 6px; }
/* The search box is 1.25 times the Path button, whose width is set for that. */
.term-head { --path-width: 45px; }
.term-head .term-path { width: var(--path-width); padding: 2px 0; }
.term-head .tabs-input { flex: none; width: calc(var(--path-width) * 1.25); padding: 2px 6px; border-radius: 5px; }
.term-head .tabs-input.missed { background: #ffd6d6; }
.term-cwd { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.term-bar { flex: 0 1 auto; min-width: 0; display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 6px 8px; margin-left: auto; }
/* Each piece stays whole while it fits a line, so the folder wraps after a slash. */
.term-cwd span { display: inline-block; max-width: 100%; }
.term-idle { flex: none; margin: 0 10px 0 4px; font-variant-numeric: tabular-nums; }
.term-box { min-height: 0; }
</style>
