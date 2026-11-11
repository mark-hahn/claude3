<script setup lang="ts">
// The tab row's Term pane: xterm.js on the project's pty (server/term.ts), bash or PowerShell on win,
// kept by the backend while the pane is closed. Keys go up as typed, Ctrl-C included; with text
// selected Ctrl-C copies it instead, and Ctrl-V pastes, as in VS Code.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { Tab } from "../../shared/config.ts";
import { post } from "../api.ts";

const props = defineProps<{ tab: Tab; active: boolean }>();
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
  windowsPty: props.tab.host === "win" ? { backend: "conpty" } : undefined,
  theme: {
    background: "#f9f9f7", foreground: "#000000", cursor: "#000000", cursorAccent: "#f9f9f7", selectionBackground: "#add6ff",
    black: "#000000", red: "#cd3131", green: "#107c10", yellow: "#949800", blue: "#0451a5", magenta: "#bc05bc", cyan: "#0598bc", white: "#555555",
    brightBlack: "#666666", brightRed: "#cd3131", brightGreen: "#14ce14", brightYellow: "#b5ba00", brightBlue: "#0451a5", brightMagenta: "#bc05bc", brightCyan: "#0598bc", brightWhite: "#a5a5a5",
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.attachCustomKeyEventHandler((event) => {
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

// Keys one request at a time, so they reach the shell in order; those typed meanwhile go together.
let pending = "";
let sending = false;
async function flush(): Promise<void> {
  if (sending || !pending) return;
  sending = true;
  const data = pending;
  pending = "";
  try {
    await post(props.tab, "termSend", { data });
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
term.onResize(({ cols, rows }) => void post(props.tab, "termResize", { cols, rows }).catch(() => undefined));

// A long poll: the backend answers at once with output this page hasn't seen, else after 2s.
let alive = true;
async function follow(): Promise<void> {
  let id = "";
  let at = 0;
  while (alive) {
    if (!props.active || document.hidden) {
      await pause(500);
      continue;
    }
    try {
      const got = await post<{ id: string; at: number; text: string; reset: boolean }>(props.tab, "termRead", { id, at, cols: term.cols, rows: term.rows });
      if (!alive) return;
      if (got.reset) term.reset();
      if (got.text) term.write(got.text);
      ({ id, at } = got);
    } catch (problem) {
      term.write(`\r\n[${messageOf(problem)}]\r\n`);
      id = "";
      await pause(2000);
    }
  }
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
onBeforeUnmount(() => {
  alive = false;
  resized.disconnect();
  term.dispose();
});
</script>

<template>
  <div class="term" @wheel.capture="zoom"><div ref="box" class="term-box"></div></div>
</template>

<style scoped>
/* The padding is the outer div's: the fit measures the inner one. */
.term { min-height: 0; min-width: 0; padding: 8px 0 0 10px; background: #f9f9f7; }
.term-box { height: 100%; }
</style>
