<script setup lang="ts">
// The conversation pane, ported from claude2's conversationHtml. The history (bars and boxes) is
// built imperatively, as claude2 builds it, so streaming refills one box rather than re-rendering
// the pane; the dock is an ordinary template. Left out for now: search, fork, pasted images, File,
// export, presets (M), arrow-key navigation and the frozen pane, the restored prompt.
// The prompt box is a Monaco editor with claude2's editing (src/monaco.ts), and has claude2's big
// prompt editor.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Tab } from "../../shared/config.ts";
import { COMPACT_RESERVE, DEFAULT_CONTEXT_WINDOW, typedPrompt, type ClaudeSession, type ClaudeTurn, type RunningStatus } from "../../shared/types.ts";
import { post } from "../api.ts";
import { cropRect } from "../cropRect.ts";
import { addLineDots, addListKeys, editorOptions, monaco, untab } from "../monaco.ts";
import { copy, copyCodeBlock } from "../copy.ts";
import { answerText, fillBox, renderMarkdown, withoutDetails } from "../render.ts";
import { loadWaiting, saveWaiting, type Waiting } from "../waitingImages.ts";

// active: this pane's tab is the one on show, so the page-wide keys are its.
const props = defineProps<{ tab: Tab; session: ClaudeSession | null; status: RunningStatus | null; version: number; active: boolean; ceilings: number }>();
const emit = defineEmits<{ started: [sessionId: string]; deployDue: [due: boolean] }>();

const historyEl = ref<HTMLElement>();
const ctxPopEl = ref<HTMLElement>();
const runPopEl = ref<HTMLDialogElement>();
const runText = ref("");
const deployPopEl = ref<HTMLDialogElement>();
const deployText = ref("");
const ctxButtonEl = ref<HTMLButtonElement>();
const promptHostEl = ref<HTMLElement>();
const promptMdEl = ref<HTMLElement>();
let promptBox: monaco.editor.IStandaloneCodeEditor | null = null;
// The prompt box's text, kept in step with the editor both ways.
const draft = ref("");
const stopping = ref("");
const now = ref(Date.now());

// The run's status as this pane last heard it: from the prop, or straight from a delta, which
// arrives before the prop catches up.
let status: RunningStatus | null = null;
let statusAt = 0;

// Per-session view state, reset when the pane switches session.
let anchorIndex = 0;
// At most one box is ever open: the selected block's, and only while this is true.
let boxOpen = true;
// The open box hides its tool groups by default and a ctrl-click toggles them. The streaming box
// always shows them.
let toolsBox = false;
let initialized = false;
let pendingTurnCount = 0;
let shownActiveTurn: string | null = null;
let streamingTurn: string | null = null;
let wasStreaming: string | null = null;
// Where the box contents land on the next render: 'restore' for the remembered spot, a fresh
// position, or null to keep the current one.
type BoxScroll = "top" | "bottom" | number;
let boxScrollNext: BoxScroll | "restore" | null = null;
let boxScrolls: Record<string, "bottom" | number> = {};
let expandedPrompts = new Set<string>();
// Tool lines showing their detail, as turn id + ':' + the line's place among the box's tool calls.
let openToolCalls = new Set<string>();
let programmaticScroll = false;
// Unsent text per session; '' is the new-session draft. Every edit is saved in localStorage, as
// claude2 keeps its drafts beside the sessions, so a reload puts each one back in its session's box.
// ponytail: drafts of deleted sessions stay in localStorage; prune them if the 5MB quota ever matters.
const draftKey = (id: string): string => `draft:${props.tab.id}:${id}`;
const drafts = new Map<string, string>();
for (const key of Object.keys(localStorage)) {
  if (key.startsWith(draftKey(""))) drafts.set(key.slice(draftKey("").length), localStorage.getItem(key)!);
}
// The prompt box's text when something other than sending emptied it (a session switch, a page
// reload); Ctrl+Enter in an empty box puts it back. Every edit is saved under lostKey for the reload.
const lostKey = (): string => `lostPrompt:${props.tab.id}`;
let clearedDraft = localStorage.getItem(lostKey()) ?? "";

const turns = (): ClaudeTurn[] => props.session?.turns ?? [];
const typedText = (turn: ClaudeTurn): string => typedPrompt(turn.prompt);

function render(): void {
  const history = historyEl.value;
  if (!history) return;
  const active = !!status?.active && status.sessionId === props.session?.id;
  const list = turns();
  const wasAnchor = anchorIndex;
  anchorIndex = Math.max(0, Math.min(list.length - 1, anchorIndex));
  // First render of a session with turns: land on the newest block, box open.
  if (!initialized && list.length) {
    initialized = true;
    anchorIndex = list.length - 1;
    boxOpen = true;
    boxScrollNext = "restore";
    toolsBox = false;
  }
  if (pendingTurnCount && list.length >= pendingTurnCount) {
    anchorIndex = pendingTurnCount - 1;
    boxOpen = true;
    boxScrollNext = "restore";
    toolsBox = false;
    pendingTurnCount = 0;
  }
  // A run that just started selects and opens its new block. The user is free to move the
  // selection or close the box afterwards, leaving the run to stream invisibly.
  if (active && status!.turnId !== shownActiveTurn) {
    shownActiveTurn = status!.turnId;
    const activeIndex = list.findIndex((turn) => turn.id === status!.turnId);
    if (activeIndex >= 0) {
      anchorIndex = activeIndex;
      boxOpen = true;
      boxScrollNext = "restore";
    }
  }
  // A run that ended leaves its box as the wasStreaming box: it drops its tool groups, and a run
  // that answered lands its open box on the answer.
  if (streamingTurn && (!active || status!.turnId !== streamingTurn)) {
    wasStreaming = streamingTurn;
    const ended = list[anchorIndex]?.id === streamingTurn ? list[anchorIndex] : null;
    if (ended) toolsBox = false;
    if (ended && boxOpen && ended.finished && !ended.stopped && !ended.error) boxScrollNext = "top";
  }
  streamingTurn = active ? status!.turnId : null;
  const openTurn = boxOpen && list[anchorIndex] ? list[anchorIndex]!.id : null;
  if (wasStreaming && wasStreaming !== openTurn) {
    delete boxScrolls[wasStreaming];
    wasStreaming = null;
  }
  // Rebuilding throws the open box's scroll away, so it is measured first and restored, still
  // pinned to the bottom when it was there (how a streaming box follows its text).
  const selectedResponse = history.querySelector<HTMLElement>(`[data-index="${anchorIndex}"] .response`);
  const selectedTop = selectedResponse ? selectedResponse.scrollTop : 0;
  const selectedAtBottom = selectedResponse ? atBottom(selectedResponse) : false;
  history.replaceChildren();
  list.forEach((turn, index) => {
    const wrapper = document.createElement("div");
    wrapper.className = "turn";
    wrapper.dataset.index = String(index);
    wrapper.dataset.turnId = turn.id;
    const bar = document.createElement("button");
    bar.className = "prompt-bar" + (expandedPrompts.has(turn.id) ? " prompt-expanded" : "");
    const typed = typedText(turn);
    // The hover leads with what this prompt actually ran under, which need not be what the dock
    // is set to now, and when it was sent.
    const ranAs = [turn.model, turn.effort, turn.advisor && `advisor ${turn.advisor}`, turn.modelId].filter(Boolean).join(" / ");
    const sent = new Date(turn.createdAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    bar.title = `${ranAs}   ${sent}\n${typed}`;
    const boxShown = index === anchorIndex && boxOpen;
    // A running turn whose box is closed says so with a blinking arrow; the delay is set from the
    // clock so the rebuild on every streamed chunk doesn't restart the blink.
    if (active && status!.turnId === turn.id && !boxShown) {
      const arrow = document.createElement("span");
      arrow.className = "run-arrow";
      arrow.textContent = "↓";
      arrow.style.animationDelay = -(Date.now() % 600) + "ms";
      bar.appendChild(arrow);
    }
    // One icon per picture sent with this prompt, as in the prompt box.
    (turn.images ?? []).forEach((_, at) => {
      const icon = document.createElement("span");
      icon.className = "img-char";
      icon.dataset.image = String(at);
      icon.textContent = IMG;
      bar.appendChild(icon);
    });
    bar.appendChild(document.createTextNode(typed || (turn.images?.length ? "" : "(empty prompt)")));
    bar.addEventListener("click", (event) => {
      if (event.altKey) return copy(typed, bar);
      const icon = (event.target as HTMLElement).closest<HTMLElement>(".img-char");
      if (icon) return void showSentImage(turn, Number(icon.dataset.image));
      if (event.ctrlKey) {
        if (!expandedPrompts.delete(turn.id)) expandedPrompts.add(turn.id);
        if (index === anchorIndex) render();
        else selectBlock(index);
        return;
      }
      // A click selects the block, which opens it; on the already-selected bar it is the
      // open/close toggle instead, and closing it leaves every box closed.
      if (index !== anchorIndex) return selectBlock(index);
      boxOpen = !boxOpen;
      if (boxOpen) {
        boxScrollNext = "restore";
        toolsBox = false;
      }
      render();
    });
    wrapper.appendChild(bar);
    if (boxShown) {
      // The streaming box keeps its tool groups up (they are the run's progress display) and
      // answers no clicks but a tool line's.
      const locked = active && status!.turnId === turn.id;
      const tools = locked || toolsBox;
      const response = document.createElement("div");
      response.className = "response markdown" + (turn.error ? " error" : "");
      fillResponse(response, turn, tools);
      // The tool line a press landed on. The streaming box is rebuilt as text arrives, so by the
      // click that line can have been swapped for a fresh copy.
      let pressedCall: HTMLElement | null = null;
      response.addEventListener("mousedown", (event) => {
        pressedCall = (event.target as HTMLElement).closest(".tool-call.has-detail");
      });
      response.addEventListener("click", (event) => {
        const target = event.target as HTMLElement;
        if (event.altKey) {
          // The whole box, as shown: a failed turn keeps its partial text and gains the reason.
          const body = turn.error ? (turn.response ? turn.response + "\n\n" : "") + turn.error : turn.response;
          return copy(tools ? withoutDetails(body) : answerText(body), response);
        }
        // A plain click on a tool line with a detail swaps the two, unless it ended a drag that
        // selected text. The set keeps the choice through rebuilds.
        const hit = target.closest<HTMLElement>(".tool-call.has-detail");
        const pressed = hit || (pressedCall && !pressedCall.isConnected ? pressedCall : null);
        pressedCall = null;
        if (pressed && !event.ctrlKey) {
          if (!window.getSelection()?.isCollapsed) return;
          const key = turn.id + ":" + pressed.dataset.call;
          if (!openToolCalls.delete(key)) openToolCalls.add(key);
          response.querySelector(`.tool-call[data-call="${pressed.dataset.call}"]`)?.classList.toggle("open", openToolCalls.has(key));
          return;
        }
        // Any other plain click is left to text selection; only a ctrl-click toggles.
        if (locked || !event.ctrlKey || target.closest("a") || !window.getSelection()?.isCollapsed) return;
        toolsBox = !toolsBox;
        // The two views shape the text differently, so every toggle starts from the top.
        boxScrollNext = "top";
        render();
      });
      response.addEventListener("scroll", () => {
        boxScrolls[turn.id] = atBottom(response) ? "bottom" : response.scrollTop;
      });
      wrapper.appendChild(response);
    }
    history.appendChild(wrapper);
  });
  if (boxScrollNext === null && anchorIndex !== wasAnchor) boxScrollNext = "restore";
  let boxScroll: BoxScroll | "restore" = boxScrollNext ?? (selectedAtBottom ? "bottom" : selectedTop);
  if (boxScroll === "restore") {
    const turn = list[anchorIndex];
    const saved = turn ? boxScrolls[turn.id] : undefined;
    boxScroll = saved ?? (active && turn && status!.turnId === turn.id ? "bottom" : "top");
  }
  boxScrollNext = null;
  const settled = boxScroll;
  requestAnimationFrame(() => syncSelectedBlock(settled));
}

// The whole box: a run that failed part way still wrote everything up to that point, so the text
// stays and the reason goes underneath it rather than in its place.
function fillResponse(box: HTMLElement, turn: ClaudeTurn, tools: boolean): void {
  fillBox(box, turn.response || "", tools, turn.id, openToolCalls);
  if (!turn.error) return;
  const note = document.createElement("div");
  note.className = "error-note";
  note.textContent = turn.error;
  box.appendChild(note);
}

function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 18;
}

function selectBlock(index: number): void {
  const list = turns();
  if (!list.length) return;
  const next = Math.max(0, Math.min(list.length - 1, index));
  // Deliberate navigation outranks a submit's queued jump to the not-yet-arrived turn.
  pendingTurnCount = 0;
  if (next === anchorIndex) return;
  anchorIndex = next;
  boxOpen = true;
  boxScrollNext = "restore";
  toolsBox = false;
  render();
}

// Enter (claude2's selectBottomBlock): the last block selected and open, every other box closed,
// its bar as high as the rules allow. Already there, it toggles that box, so a second Enter leaves
// every box closed and a third opens the last one again.
function selectBottomBlock(): void {
  const last = turns().length - 1;
  if (last < 0) return;
  if (anchorIndex !== last) selectBlock(last);
  else {
    boxOpen = !boxOpen;
    if (boxOpen) {
      boxScrollNext = "restore";
      toolsBox = false;
    }
    render();
  }
  // After the render's own sync has set the clamps, so the bounds see the final layout.
  requestAnimationFrame(() => {
    const bounds = scrollBounds();
    if (bounds) historyEl.value!.scrollTop = bounds.max;
  });
}

// The window the pane's scrollTop must stay in so the bar above the selected block, the whole
// selected block, and the bar below all sit inside the pane at once. min > max can only happen in a
// pane too short for that span; the bottom bar is given up first.
function scrollBounds(): { min: number; max: number } | null {
  const history = historyEl.value!;
  const node = history.querySelector<HTMLElement>(`[data-index="${anchorIndex}"]`);
  if (!node) return null;
  const above = history.querySelector<HTMLElement>(`[data-index="${anchorIndex - 1}"]`);
  const below = history.querySelector<HTMLElement>(`[data-index="${anchorIndex + 1}"]`);
  const end = below || node;
  const base = history.offsetTop;
  const max = Math.max(0, (above || node).offsetTop - base);
  const min = Math.max(0, end.offsetTop + end.offsetHeight - base - history.clientHeight);
  return { min: Math.min(min, max), max };
}

// Clamps the open box so its whole region (bordering bars included) fits the pane, then moves the
// pane the minimum distance into the allowed window, then positions the box contents.
function syncSelectedBlock(boxScroll: BoxScroll): void {
  const history = historyEl.value;
  if (!history) return;
  history.querySelectorAll<HTMLElement>(".turn").forEach((turn) => {
    turn.classList.remove("selected");
    turn.querySelectorAll<HTMLElement>(".prompt-bar, .response").forEach((part) => {
      part.style.maxHeight = "";
      part.style.overflowY = "";
    });
  });
  const node = history.querySelector<HTMLElement>(`[data-index="${anchorIndex}"]`);
  if (!node) return;
  node.classList.add("selected");
  const bar = node.querySelector<HTMLElement>(".prompt-bar");
  const response = node.querySelector<HTMLElement>(".response");
  const above = history.querySelector<HTMLElement>(`[data-index="${anchorIndex - 1}"]`);
  const below = history.querySelector<HTMLElement>(`[data-index="${anchorIndex + 1}"]`);
  const spanHeight = (): number => (below || node).offsetTop + (below || node).offsetHeight - (above || node).offsetTop;
  // A ctrl-expanded prompt gives way first, down to three lines, before the box does.
  if (bar?.classList.contains("prompt-expanded") && spanHeight() > history.clientHeight) {
    const lineHeight = parseFloat(getComputedStyle(bar).lineHeight) || 20;
    bar.style.maxHeight = Math.ceil(lineHeight * 3 + 4) + "px";
    bar.style.overflowY = "auto";
  }
  if (response) {
    const excess = spanHeight() - history.clientHeight;
    if (excess > 0) {
      const lineHeight = parseFloat(getComputedStyle(response).lineHeight) || 20;
      response.style.maxHeight = Math.max(Math.ceil(lineHeight + 18), response.offsetHeight - excess) + "px";
      response.style.overflowY = "auto";
    }
  }
  const bounds = scrollBounds();
  if (bounds) {
    const target = Math.min(bounds.max, Math.max(bounds.min, history.scrollTop));
    if (target !== history.scrollTop) {
      programmaticScroll = true;
      history.scrollTop = target;
      window.setTimeout(() => (programmaticScroll = false), 80);
    }
  }
  if (response) {
    response.scrollTop = boxScroll === "bottom" ? response.scrollHeight : boxScroll === "top" ? 0 : boxScroll;
  }
}

function resyncSelectedBlock(): void {
  const response = historyEl.value?.querySelector<HTMLElement>(`[data-index="${anchorIndex}"] .response`);
  syncSelectedBlock(response ? (atBottom(response) ? "bottom" : response.scrollTop) : 0);
}

// Streamed text has already been spliced into the turn: only the one growing box is refilled. The
// full render is kept for structure: the first delta of a run anchors and opens its block.
function applyDelta(turnId: string, next: RunningStatus | null): void {
  status = next ?? status;
  statusAt = Date.now();
  const turn = turns().find((entry) => entry.id === turnId);
  if (!turn) return;
  if (status?.active && status.turnId !== shownActiveTurn) return render();
  const node = historyEl.value?.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`);
  const response = node?.querySelector<HTMLElement>(".response");
  if (!node || !response) return;
  const pinned = atBottom(response);
  const top = response.scrollTop;
  fillResponse(response, turn, true);
  if (Number(node.dataset.index) === anchorIndex) requestAnimationFrame(() => syncSelectedBlock(pinned ? "bottom" : top));
}
// Sessions holding unsent text: the sidebar's sweep of empty sessions spares them.
const drafted = (): string[] => [...drafts].filter(([, text]) => text.trim()).map(([id]) => id).concat(draft.value.trim() && props.session ? [props.session.id] : [], Object.keys(waiting));
// Text picked in the Snips joins the end of the prompt, on a line of its own, with the cursor after it.
// An edit through Monaco, so ctrl-z takes it back. False when the box couldn't take it.
function appendPrompt(text: string): boolean {
  const box = promptBox;
  if (!box || box.getOption(monaco.editor.EditorOption.readOnly)) return false;
  setPromptMarkdown(false);
  const model = box.getModel()!;
  const end = model.getPositionAt(model.getValueLength());
  const value = model.getValue();
  box.pushUndoStop();
  box.executeEdits("claude3", [{ range: monaco.Range.fromPositions(end), text: (value && !value.endsWith("\n") ? "\n" : "") + untab(text) }]);
  box.pushUndoStop();
  box.focus();
  box.setPosition(model.getPositionAt(model.getValueLength()));
  box.revealPosition(box.getPosition()!);
  return true;
}
const focusPrompt =(): void => (promptMarkdown.value ? promptMdEl.value : promptBox)?.focus();
// claude2's promptReturned: the prompt never ran, so the box the send emptied takes it back. Anything
// typed since outranks it and stays. A session not on show holds it as its draft.
function returnPrompt(sessionId: string, text: string, pictures: string[]): void {
  if (pictures.length) {
    waiting[sessionId] = [...pictures.map((picture) => [picture]), ...(waiting[sessionId] ?? [])];
    storeImages();
  }
  if (sessionId === sessionKey()) {
    if (!draft.value) draft.value = text;
  } else if (!drafts.get(sessionId)) {
    drafts.set(sessionId, text);
    localStorage.setItem(draftKey(sessionId), text);
  }
}
defineExpose({ applyDelta, drafted, appendPrompt, focusPrompt, returnPrompt });

// ---- the dock ----

function report(error: unknown): void {
  window.alert(error instanceof Error ? error.message : String(error));
}

const active = computed(() => !!props.status?.active);
const latest = computed(() => {
  void props.version;
  return turns().at(-1);
});

// The prompt "r" alone runs the project's ./run on its backend instead of going to claude; "v"
// does the same with RESTART_VITE=1, which makes claude3's ./run restart a running vite.
// Its result shows in a <dialog> rather than window.alert so the font can be sized. claude3's own
// ./run restarts vite, which reloads the page; unlike an alert the dialog doesn't hold that off,
// so the text waits in sessionStorage until OK and is shown again on mount.
const runKey = (): string => `runPop:${props.tab.id}`;
// The dialog follows the end of its text unless it has been scrolled up. It opens only on the tab
// on show: a modal dialog in a hidden tab would block the whole page with nothing to see.
function putRun(text: string): void {
  const dialog = runPopEl.value!;
  const following = !dialog.open || dialog.scrollHeight - dialog.scrollTop - dialog.clientHeight < 40;
  runText.value = text;
  if (!props.active) return;
  if (!dialog.open) dialog.showModal();
  if (following) void nextTick(() => (dialog.scrollTop = dialog.scrollHeight));
}
// While a ./run goes on, the dialog shows its output so far. OK hides that (the run carries on)
// and the result opens the dialog again.
let runLive = false;
function showRunLive(output: string): void {
  if (runLive) putRun(`./run in ${props.tab.label} running...\n\n${output}`);
}
function showRun(text: string): void {
  runLive = false;
  sessionStorage.setItem(runKey(), text);
  putRun(text);
  checkDeploySoon();
}
function runClosed(): void {
  runLive = false;
  sessionStorage.removeItem(runKey());
}
// A result that came while the tab was hidden opens when it's picked; post, so it's on show by then.
watch(
  () => props.active,
  (active) => {
    const waiting = sessionStorage.getItem(runKey());
    if (active && waiting !== null) putRun(waiting);
  },
  { flush: "post" },
);
const askRun = () => post<{ done: boolean; code: number; output: string }>(props.tab, "runResult", {});

// Set while a ./run's answer is due, so a page reloaded meanwhile picks up the wait.
const runWaitKey = (): string => `runWait:${props.tab.id}`;

// Also the footer's Run button (ctrl-click: "v"). It leaves the prompt box's text alone and never
// takes focus, so the Enter that dismisses the result can't land on it and run ./run again.
async function runScript(restartVite: boolean): Promise<void> {
  sessionStorage.setItem(runWaitKey(), "1");
  runLive = true;
  showRunLive("");
  // A "done" here is the previous ./run's, not cleared yet: only the answer below ends this one.
  const follow = window.setInterval(() => {
    void askRun().then(
      (result) => {
        if (!result.done) showRunLive(result.output);
      },
      () => {}, // the backend is restarting; the next one will tell
    );
  }, 1000);
  try {
    const { output } = await post<{ output: string }>(props.tab, "run", { restartVite });
    sessionStorage.removeItem(runWaitKey());
    showRun(`./run in ${props.tab.label} finished.\n\n${output}`);
  } catch (error) {
    // A network failure: a ./run that restarts this backend (claude3's own) cuts the answer off,
    // and the script runs on, so its result is fetched once the backend is back.
    if (error instanceof TypeError) return awaitRun();
    sessionStorage.removeItem(runWaitKey());
    showRun(`./run in ${props.tab.label}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    window.clearInterval(follow);
  }
}

async function awaitRun(): Promise<void> {
  for (let tries = 0; tries < 300; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const result = await askRun().catch(() => null);
    if (!result) continue; // the backend is still restarting
    if (!result.done) {
      showRunLive(result.output);
      continue;
    }
    sessionStorage.removeItem(runWaitKey());
    return showRun(`./run in ${props.tab.label} ${result.code === 0 ? "finished" : `failed (exit ${result.code})`}.\n\n${result.output}`);
  }
  sessionStorage.removeItem(runWaitKey());
  showRun(`./run in ${props.tab.label}: no result after 5 minutes.`);
}

// Before a prompt: when files changed since the project's ./deploy (or ./run) last finished, a
// dialog asks Deploy, Continue or Cancel. Deploy does what the prompt "r" does and leaves the
// prompt unsent in the box. A failed check doesn't hold the prompt up.
async function deployOk(): Promise<boolean> {
  let check: { script: string; files: string[] };
  try {
    check = await post<{ script: string; files: string[] }>(props.tab, "deployNeeded", {});
  } catch (error) {
    // An older backend answers this unknown action with "No such session."; nothing to stop for.
    console.warn("deployNeeded check failed:", error);
    return true;
  }
  if (!check.files.length) return true;
  const list = check.files.slice(0, 10).join("\n") + (check.files.length > 10 ? `\n... and ${check.files.length - 10} more` : "");
  deployText.value = `${props.tab.label} needs a deploy: ${check.files.length} file(s) changed since ./${check.script} last ran.\n\n${list}`;
  const dialog = deployPopEl.value!;
  dialog.returnValue = "";
  dialog.showModal();
  await new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
  if (dialog.returnValue === "deploy") void runScript(false);
  return dialog.returnValue === "continue";
}

// The Run button is highlighted while that same check finds changed files. Re-read like the Git
// button's count, while the project is open, on show or not, and after a ./run, which resets the check.
const deployDue = ref(false);
watch(deployDue, (due) => emit("deployDue", due));
let deployTimer = 0;
function checkDeploySoon(): void {
  if (!props.tab.open) return;
  window.clearTimeout(deployTimer);
  deployTimer = window.setTimeout(() => {
    post<{ files: string[] }>(props.tab, "deployNeeded", {}).then(
      ({ files }) => (deployDue.value = files.length > 0),
      () => (deployDue.value = false),
    );
  }, 300);
}
watch(() => [props.active, props.version], checkDeploySoon, { immediate: true });

async function submit(text = draft.value, keepDraft = false): Promise<void> {
  if ((text.trim() === "r" || text.trim() === "v") && !keepDraft) {
    draft.value = "";
    localStorage.removeItem(lostKey());
    return runScript(text.trim() === "v");
  }
  // Pictures alone are a prompt, not an empty box.
  if ((!text.trim() && (keepDraft || !images().length)) || (props.session?.trashed ?? false)) return;
  if (!keepDraft && !(await deployOk())) return;
  // Sending during a run stops that run and takes this prompt instead; a run waiting on a
  // background task takes it as a follow-up.
  if (props.status?.active && props.status.phase !== "background" && !window.confirm("Stop the running response and send this prompt instead?")) return;
  if (!keepDraft) {
    draft.value = "";
    localStorage.removeItem(lostKey());
    if (clearedDraft === text) clearedDraft = "";
  }
  // Every waiting picture rides with this prompt; a failed send puts them back.
  const key = sessionKey();
  const sending = keepDraft ? [] : images();
  if (sending.length) {
    delete waiting[key];
    storeImages();
  }
  pendingTurnCount = turns().length + 1;
  try {
    const { sessionId } = await post<{ sessionId: string }>(props.tab, "prompt", { sessionId: props.session?.id ?? "", prompt: text, images: sending.map((stack) => stack.at(-1)) });
    if (!props.session) {
      storeBig(sessionId, bigPrompt.value);
      emit("started", sessionId);
    }
  } catch (error) {
    pendingTurnCount = 0;
    if (!keepDraft) draft.value = text;
    if (sending.length) {
      waiting[key] = [...sending, ...(waiting[key] ?? [])];
      storeImages();
    }
    report(new Error(`Prompt not sent: ${error instanceof Error ? error.message : String(error)}`));
  }
}

// Ctrl+Enter in the prompt box.
function sendKey(): void {
  if (!draft.value.trim() && !images().length && clearedDraft) {
    draft.value = clearedDraft;
    clearedDraft = "";
    return;
  }
  void submit();
}

// The frame grows with the text (--content-h), never below two lines, and the CSS caps it at
// six. The floor is Monaco's own rounded line height.
function fitPrompt(): void {
  const box = promptBox;
  if (!box) return;
  const twoLines = 2 * box.getOption(monaco.editor.EditorOption.lineHeight) + 10;
  promptHostEl.value!.style.setProperty("--content-h", Math.max(box.getContentHeight(), twoLines) + 8 + "px");
}

// bigPromptEditor: the prompt box takes the pane's full height on the left, and the history and
// the controls share the column to its right. Ctrl-Alt-click in the box or Ctrl-Alt-Z anywhere in
// the tab toggles it. Each session keeps its own flag, in localStorage, so a reload comes back in
// the same layout; a session started from the new-session draft takes the draft's.
// ponytail: flags of deleted sessions stay in localStorage; a few bytes each.
const bigPrompt = ref(false);
const bigKey = (id: string): string => `bigPrompt:${props.tab.id}:${id}`;
function storeBig(id: string, on: boolean): void {
  if (on) localStorage.setItem(bigKey(id), "1");
  else localStorage.removeItem(bigKey(id));
}
function setBigPrompt(on: boolean): void {
  bigPrompt.value = on;
  setPromptMarkdown(false);
  storeBig(props.session?.id ?? "", on);
}

// promptMarkdown: the big box's text shown rendered, read-only, in the editor's place. Ctrl-Alt-X
// toggles it while the box is big; leaving the big box leaves it too. Ctrl+Enter there sends, as
// it would from the text.
const promptMarkdown = ref(false);
const promptHtml = computed(() => (promptMarkdown.value ? renderMarkdown(draft.value) : ""));
function setPromptMarkdown(on: boolean): void {
  if (on === promptMarkdown.value) return;
  promptMarkdown.value = on;
  if (!on) return;
  requestAnimationFrame(() => {
    promptMdEl.value!.scrollTop = 0;
    promptMdEl.value!.focus();
  });
}
function onMdKey(event: KeyboardEvent): void {
  if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.key !== "Enter") return;
  event.preventDefault();
  setPromptMarkdown(false);
  promptBox?.focus();
  sendKey();
}
// Capture phase, so Monaco never sees the press.
function onPageKey(event: KeyboardEvent): void {
  if (props.active && event.key === "Enter" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
    const target = event.target as HTMLElement;
    if (target.closest?.("textarea, input, select, [contenteditable], dialog, .dock-controls, .prompt-md")) return;
    event.preventDefault();
    return selectBottomBlock();
  }
  if (!props.active || !event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey) return;
  if (event.code === "KeyZ") {
    event.preventDefault();
    event.stopPropagation();
    setBigPrompt(!bigPrompt.value);
    promptBox?.focus();
  } else if (event.code === "KeyX" && bigPrompt.value) {
    event.preventDefault();
    event.stopPropagation();
    const on = !promptMarkdown.value;
    setPromptMarkdown(on);
    if (!on) promptBox?.focus();
  }
}
// Ctrl-Alt-click in the box. Capture phase, so Monaco never sees the press (its ctrl-click adds a
// cursor). Monaco listens for pointer events; the mouse ones are only blocked, so a browser that
// still fires them can't toggle twice.
function onPromptPointer(event: PointerEvent): void {
  const index = event.ctrlKey && event.altKey ? -1 : imageCharAt(event);
  if (index < 0 && (!event.ctrlKey || !event.altKey)) return;
  event.preventDefault();
  event.stopPropagation();
  if (index >= 0) return event.ctrlKey ? deleteWaitingImage(index) : showWaitingImage(index);
  setBigPrompt(!bigPrompt.value);
  promptBox?.focus();
}
function onPromptMouse(event: MouseEvent): void {
  if ((!event.ctrlKey || !event.altKey) && imageCharAt(event) < 0) return;
  event.preventDefault();
  event.stopPropagation();
}

// ---- pictures: the Cap button, the icons, and the image popup ----

const IMG = "\u{1F5BC}️";
const sessionKey = (): string => props.session?.id ?? "";
// Waiting on each session's next prompt, as drafts wait ('' is the new-session draft).
// ponytail: pictures of a session deleted before sending stay in IndexedDB; prune them if the space matters.
let waiting: Waiting = {};
void loadWaiting(props.tab.id).then((stored) => {
  waiting = stored;
  showImageChars();
}, report);
const images = (): string[][] => waiting[sessionKey()] ?? [];
function storeImages(): void {
  showImageChars();
  saveWaiting(props.tab.id, waiting).catch(report);
}

// The icons lead the box's first line as injected text: drawn there but not part of the text, so
// typing, the caret and the draft never touch them. Set again on every edit, or one at the very
// start would carry them along with the text it moved.
let imageChars: monaco.editor.IEditorDecorationsCollection | null = null;
function showImageChars(): void {
  const count = images().length;
  // An empty range: without showIfCollapsed Monaco keeps the decoration but never draws it.
  imageChars?.set(count ? [{ range: new monaco.Range(1, 1, 1, 1), options: { showIfCollapsed: true, before: { content: IMG.repeat(count), inlineClassName: "img-char", cursorStops: monaco.editor.InjectedTextCursorStops.Right } } }] : []);
}
// Which icon an event in the prompt box is on, or -1. They are one injected span, all one width.
function imageCharAt(event: MouseEvent): number {
  const span = (event.target as HTMLElement).closest?.(".img-char");
  const count = images().length;
  if (!span || !count || event.button) return -1;
  const box = span.getBoundingClientRect();
  const index = Math.floor((event.clientX - box.left) / (box.width / count));
  return index >= 0 && index < count ? index : -1;
}

// The screen is the laptop's, so a tab on the server asks a laptop backend for the shot.
const captureTab = (): Tab => (props.tab.host === "srv" ? { ...props.tab, host: "wsl" } : props.tab);
const onPreviousTab = inject("onPreviousTab") as <T>(shot: () => Promise<T>) => Promise<T>;
const capturing = ref(false);
// A plain click hides this window for the shot, a ctrl-click leaves it up, and an alt-click leaves
// it up with the previously shown tab brought forward. Every click adds another picture.
async function capture(event: MouseEvent): Promise<void> {
  const key = sessionKey();
  const take = (hideWindow: boolean) => post<{ dataUri: string }>(captureTab(), "capture", { hideWindow });
  capturing.value = true;
  try {
    const { dataUri } = await (event.altKey ? onPreviousTab(() => take(false)) : take(!event.ctrlKey));
    (waiting[key] ??= []).push([dataUri]);
    storeImages();
    // After Alt-Cap's return to this tab has drawn: a modal dialog in a hidden tab would block the page.
    await nextTick();
    // Set before the dialog opens, which hands focus back to whatever had it. The flip took it away.
    if (event.altKey) focusPrompt();
    if (key === sessionKey()) showWaitingImage(images().length - 1);
  } catch (error) {
    report(new Error(`Screen capture failed: ${error instanceof Error ? error.message : String(error)}`));
  } finally {
    capturing.value = false;
  }
}

function deleteWaitingImage(index: number): void {
  const key = sessionKey();
  waiting[key]!.splice(index, 1);
  if (!waiting[key]!.length) delete waiting[key];
  storeImages();
}

const imagePopEl = ref<HTMLDialogElement>();
const popImageEl = ref<HTMLImageElement>();
const popFrameEl = ref<HTMLElement>();
const popSelEl = ref<HTMLElement>();
const popSrc = ref("");
const popLabel = ref("");
// False for a picture already sent with a prompt: it is shown and nothing more.
const popEditable = ref(false);
const popDepth = ref(0);
// The shown waiting picture's own stack, the one in `waiting`.
let popStack: string[] = [];
function drawPop(): void {
  popSrc.value = popStack.at(-1)!;
  popDepth.value = popStack.length - 1;
}
function openPop(label: string, editable: boolean): void {
  popLabel.value = label;
  popEditable.value = editable;
  if (props.active && !imagePopEl.value!.open) imagePopEl.value!.showModal();
}
function showWaitingImage(index: number): void {
  popStack = images()[index]!;
  drawPop();
  openPop(`Screen capture ${index + 1} of ${images().length}`, true);
}
async function showSentImage(turn: ClaudeTurn, index: number): Promise<void> {
  try {
    const { dataUri } = await post<{ dataUri: string }>(props.tab, "image", { sessionId: props.session?.id, turnId: turn.id, index });
    popSrc.value = dataUri;
    openPop(`Screen capture ${index + 1} of ${turn.images!.length}`, false);
  } catch (error) {
    report(error);
  }
}

// claude2's crop. A drag cuts the rectangle out on a canvas and the crop is the picture from then
// on; a click that never moved pops back to what the last crop replaced. Pointer capture on the
// frame, not the image, so a drag can start off the picture and end outside the window.
let cropDrag: { x: number; y: number; moved: boolean } | null = null;
function cropTo(from: { x: number; y: number }, to: PointerEvent) {
  const image = popImageEl.value!;
  return cropRect(image.getBoundingClientRect(), { width: image.naturalWidth, height: image.naturalHeight }, from, { x: to.clientX, y: to.clientY });
}
function cropDown(event: PointerEvent): void {
  if (event.button !== 0 || !popEditable.value) return;
  event.preventDefault();
  popFrameEl.value!.setPointerCapture(event.pointerId);
  cropDrag = { x: event.clientX, y: event.clientY, moved: false };
  popSelEl.value!.hidden = true;
}
function cropMove(event: PointerEvent): void {
  if (!cropDrag) return;
  // The button is already up: a release went somewhere that swallowed it.
  if (!(event.buttons & 1)) return cropUp(event);
  if (!cropDrag.moved && Math.abs(event.clientX - cropDrag.x) < 4 && Math.abs(event.clientY - cropDrag.y) < 4) return;
  cropDrag.moved = true;
  const rect = cropTo(cropDrag, event);
  // Placed against the frame's padding box, which is what it scrolls within.
  const frame = popFrameEl.value!;
  const frameBox = frame.getBoundingClientRect();
  const sel = popSelEl.value!;
  sel.style.left = rect.left - frameBox.left + frame.scrollLeft + rect.x * rect.scale + "px";
  sel.style.top = rect.top - frameBox.top + frame.scrollTop + rect.y * rect.scale + "px";
  sel.style.width = rect.w * rect.scale + "px";
  sel.style.height = rect.h * rect.scale + "px";
  sel.hidden = false;
}
function cropCancel(): void {
  cropDrag = null;
  popSelEl.value!.hidden = true;
}
function cropUp(event: PointerEvent): void {
  const started = cropDrag;
  if (!started) return;
  cropCancel();
  if (!started.moved) {
    if (popStack.length <= 1) return;
    popStack.pop();
  } else {
    const rect = cropTo(started, event);
    if (rect.w < 2 || rect.h < 2) return;
    const canvas = document.createElement("canvas");
    canvas.width = rect.w;
    canvas.height = rect.h;
    canvas.getContext("2d")!.drawImage(popImageEl.value!, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    popStack.push(canvas.toDataURL("image/png"));
  }
  drawPop();
  storeImages();
}

function stop(): void {
  if (!props.session || !props.status?.active) return;
  stopping.value = props.status.turnId;
  void post(props.tab, "stop", { sessionId: props.session.id }).catch(report);
}

// The context gauge: the conversation's level against where the CLI compacts it. A click when
// nothing is running compacts now.
const compactAt = computed(() => {
  const window = (active.value ? latest.value?.contextWindow : undefined) ?? turns().at(-1)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  return Math.max(1000, window - COMPACT_RESERVE);
});
const contextUsed = computed(() => {
  void props.version;
  return active.value ? props.status!.contextTokens : turns().reduce((level, turn) => turn.contextUsed || (turn.cleared ? 0 : level), 0);
});
function compactNow(): void {
  if (!active.value && turns().length) void submit("/compact", true);
}

const inK = (tokens: number): string => Math.round((tokens || 0) / 1000) + "K";
// m:ss, with the minutes free to run past 60 rather than rolling over into hours.
const shortTime = (ms: number): string => {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
};

const stats = computed(() => {
  void props.version;
  const list = turns();
  const last = latest.value;
  const live = active.value ? props.status! : null;
  const since = Math.max(0, now.value - statusAt);
  const spent = list.reduce((sum, turn) => sum + (turn.durationMs || 0), 0) + (live ? live.elapsedMs + since : 0);
  const skips = list.reduce((sum, turn) => sum + (turn.ponySkips || []).length, 0) + (live ? live.ponySkips.length : 0);
  return {
    turns: `${live ? live.turns : last?.turns ?? 0}/${live ? live.maxTurns : last?.maxTurns || 100}`,
    graftSaved: props.session?.graftSavedUsd ?? 0,
    pony: skips,
    quiet: shortTime(live ? live.sinceEventMs + since : 0),
    duration: shortTime(spent),
  };
});

// One letter, with the full word on hover: T/W/Q/w/C/B while streaming (working, the wait between
// blocks, is lower-case so it reads apart from writing), F or S once the turn lands, R when idle.
const pill = computed(() => {
  const last = latest.value;
  const label = active.value ? props.status!.phase || "working" : last?.finished ? (last.stopped ? "stopped" : "finished") : "ready";
  return {
    text: label === "working" ? "w" : label.charAt(0).toUpperCase(),
    title: label.charAt(0).toUpperCase() + label.slice(1),
    cls: (active.value ? "active" : last?.finished ? "done" : "") + (label === "working" ? " waiting" : ""),
  };
});

// ---- the Ctx popup: tokens by source, from the transcript and the CLI's own counts ----

interface CtxRow { depth: number; label: string; now: number; lastIn: number; lastOut: number; allIn: number; allOut: number }
interface CacheSplit { read: number; write: number; fresh: number }
// server/contextStats.ts ContextTable, as it arrives.
interface CtxTable { rows: CtxRow[]; calls: { last: number; all: number }; cache: { now: CacheSplit; last: CacheSplit; all: CacheSplit }; measured: boolean }

let ctxAsk = 0;
let ctxNotesOpen = false;
const ctxOpenRows = new Set<string>();
// Every count is whole thousands, with no unit letters. Only a true zero is left blank.
const fmtCtx = (n: number): string => (!n ? "" : String(Math.round(n / 1000)));

function placeCtxPop(): void {
  const pop = ctxPopEl.value!;
  const rect = ctxButtonEl.value!.getBoundingClientRect();
  const paneLeft = historyEl.value!.getBoundingClientRect().left;
  pop.style.left = paneLeft + 8 + "px";
  pop.style.right = Math.max(8, innerWidth - rect.right) + "px";
  pop.style.bottom = innerHeight - rect.top + 6 + "px";
  pop.style.maxHeight = Math.max(120, rect.top - 14) + "px";
}

function ctxLine(text: string, className: string): void {
  const line = document.createElement("div");
  line.className = className;
  line.textContent = text;
  ctxPopEl.value!.append(line);
}

function foldCtx(items: { line: HTMLTableRowElement; depth: number; key: string; twist: HTMLElement | null }[]): void {
  let cut = Infinity;
  for (const item of items) {
    item.line.hidden = item.depth > cut;
    if (item.line.hidden) continue;
    const open = ctxOpenRows.has(item.key);
    cut = item.twist && !open ? item.depth : Infinity;
    if (item.twist) item.twist.textContent = open ? "▾" : "▸";
  }
}

function showCtx(table: CtxTable | null): void {
  const pop = ctxPopEl.value!;
  pop.replaceChildren();
  if (!table) return ctxLine("Nothing to count yet: Claude has no transcript for this session.", "ctx-head");
  const subagents = table.rows.some((row) => row.depth === 0 && row.label === "Subagents");
  const notes = document.createElement("div");
  notes.className = "ctx-notes";
  notes.hidden = !ctxNotesOpen;
  for (const text of [
    "All counts are thousands of tokens.",
    "Now is the latest API call’s whole context, split by source. Its total is the footer’s figure, which counts towards " + Math.round(compactAt.value / 1000) + ", where the conversation is compacted.",
    "In counts each call’s whole context again, cache reads included. API calls: " + table.calls.last + " in the last prompt, " + table.calls.all + " in the conversation.",
    "The cache rows split each column’s input by how it was billed: a cache read costs about a tenth of fresh input, a cache write more than fresh input.",
    "Totals and thinking are exact; the rest of the split is estimated.",
    ...(subagents ? ["Subagents are conversations of their own, left out of the session’s token stats."] : []),
    ...(table.measured ? [] : ["The CLI gave no counts of its own, so the system prompt and tool rows are estimates too."]),
  ]) {
    const line = document.createElement("div");
    line.textContent = text;
    notes.append(line);
  }
  const bar = document.createElement("div");
  bar.className = "ctx-bar";
  const notesButton = document.createElement("button");
  notesButton.textContent = "Notes";
  notesButton.addEventListener("click", () => {
    ctxNotesOpen = !ctxNotesOpen;
    notes.hidden = !ctxNotesOpen;
    placeCtxPop();
  });
  const closeButton = document.createElement("button");
  closeButton.textContent = "Close";
  closeButton.addEventListener("click", () => (pop.hidden = true));
  bar.append(notesButton, closeButton);
  pop.append(bar, notes);
  const grid = document.createElement("table");
  const head = grid.createTHead();
  const spans = head.insertRow();
  const unit = head.insertRow();
  const th = (row: HTMLTableRowElement, text: string, cols = 0, rows = 0): void => {
    const cell = document.createElement("th");
    cell.textContent = text;
    if (cols) cell.colSpan = cols;
    if (rows) cell.rowSpan = rows;
    row.append(cell);
  };
  th(spans, "Source", 0, 2);
  th(spans, "Now", 0, 2);
  th(spans, "Last prompt", 2);
  th(spans, "Conversation", 2);
  for (const text of ["in", "out", "in", "out"]) th(unit, text);
  const body = grid.createTBody();
  // The rows come depth first, so a row's contents are the deeper rows right after it. Each row is
  // keyed by its path of labels, which keeps an opened row open.
  const items: { line: HTMLTableRowElement; depth: number; key: string; twist: HTMLElement | null }[] = [];
  const path: string[] = [];
  table.rows.forEach((row, index) => {
    const line = body.insertRow();
    line.className = index === table.rows.length - 1 ? "total" : row.depth === 0 && index > 0 ? "top" : "";
    if (index < table.rows.length - 1 && row.depth === 0) line.classList.add("subtotal");
    path.length = row.depth;
    path.push(row.label);
    const key = JSON.stringify(path);
    const opens = index + 1 < table.rows.length && table.rows[index + 1]!.depth > row.depth;
    const name = line.insertCell();
    const twist = document.createElement("span");
    twist.className = "ctx-twist";
    name.append(twist);
    row.label.split(/(?<=[\\/])/).forEach((part, at) => {
      if (at) name.append(document.createElement("wbr"));
      name.append(part);
    });
    name.style.paddingLeft = `calc(8px + ${row.depth * 1.2 + 1}em)`;
    for (const value of [row.now, row.lastIn, row.lastOut, row.allIn, row.allOut]) line.insertCell().textContent = fmtCtx(value);
    if (opens) {
      line.classList.add("opens");
      line.addEventListener("click", () => {
        if (!ctxOpenRows.delete(key)) ctxOpenRows.add(key);
        foldCtx(items);
        placeCtxPop();
      });
    }
    items.push({ line, depth: row.depth, key, twist: opens ? twist : null });
  });
  foldCtx(items);
  // How each column's input was billed, as shares of it; the out columns have no caching.
  const pct = (split: CacheSplit, key: keyof CacheSplit): string => {
    const whole = split.read + split.write + split.fresh;
    return whole ? ((100 * split[key]) / whole).toFixed(1) + "%" : "";
  };
  ([["Cache read", "read"], ["Cache write", "write"], ["Uncached", "fresh"]] as const).forEach(([label, key], index) => {
    const line = body.insertRow();
    line.className = index === 0 ? "cache-first" : "";
    const name = line.insertCell();
    name.textContent = label;
    name.style.paddingLeft = "calc(8px + 1em)";
    for (const value of [pct(table.cache.now, key), pct(table.cache.last, key), "", pct(table.cache.all, key), ""]) line.insertCell().textContent = value;
  });
  pop.append(grid);
  placeCtxPop();
}

function toggleCtx(): void {
  const pop = ctxPopEl.value!;
  if (!pop.hidden || !props.session) {
    pop.hidden = true;
    return;
  }
  const ask = ++ctxAsk;
  ctxNotesOpen = false;
  ctxOpenRows.clear();
  pop.replaceChildren();
  ctxLine("Reading the transcript…", "ctx-head");
  pop.hidden = false;
  placeCtxPop();
  post<{ table: CtxTable | null }>(props.tab, "ctx", { sessionId: props.session.id })
    .then((answer) => ask === ctxAsk && !pop.hidden && showCtx(answer.table))
    .catch((error) => ask === ctxAsk && ctxLine(`Ctx failed: ${error instanceof Error ? error.message : String(error)}`, "ctx-head"));
}

// ---- wiring ----

let switchedFrom: string | null = null;
watch(
  () => [props.session?.id ?? "", props.version] as const,
  ([id]) => {
    if (id !== switchedFrom) {
      // Another session in the pane: its own draft, picks and a fresh view.
      if (switchedFrom !== null) drafts.set(switchedFrom, draft.value);
      if (draft.value.trim()) clearedDraft = draft.value;
      // An empty card taking over from the new-session draft keeps what was typed there.
      draft.value = drafts.get(id) || (switchedFrom === "" && !turns().length ? draft.value : "");
      if (switchedFrom === "") {
        drafts.delete("");
        localStorage.removeItem(draftKey(""));
      }
      switchedFrom = id;
      anchorIndex = 0;
      boxOpen = true;
      toolsBox = false;
      initialized = false;
      shownActiveTurn = streamingTurn = wasStreaming = null;
      boxScrolls = {};
      expandedPrompts = new Set();
      openToolCalls = new Set();
      if (ctxPopEl.value) ctxPopEl.value.hidden = true;
      bigPrompt.value = localStorage.getItem(bigKey(id)) === "1";
      setPromptMarkdown(false);
      showImageChars();
    }
    status = props.status;
    render();
  },
);
watch(
  () => props.status,
  (next) => {
    status = next;
    statusAt = Date.now();
    if (!next?.active || next.turnId !== stopping.value) stopping.value = "";
  },
);
watch(draft, (text) => {
  if (promptBox && promptBox.getValue() !== text) promptBox.setValue(untab(text));
  if (text.trim()) localStorage.setItem(lostKey(), text);
  const key = draftKey(props.session?.id ?? "");
  if (text) localStorage.setItem(key, text);
  else localStorage.removeItem(key);
});
// A trashed session's box is read-only until the session is restored.
const lockPrompt = (): void =>
  promptBox?.updateOptions({ readOnly: props.session?.trashed ?? false, readOnlyMessage: { value: "This session is in the trash. Restore it to send a prompt." } });
watch(() => props.session?.trashed, lockPrompt);

let ticker = 0;
let resize: ResizeObserver | null = null;
function closeCtxOutside(event: MouseEvent): void {
  const pop = ctxPopEl.value;
  if (pop && !pop.hidden && !pop.contains(event.target as Node) && !ctxButtonEl.value?.contains(event.target as Node)) pop.hidden = true;
}

onMounted(() => {
  status = props.status;
  switchedFrom = props.session?.id ?? "";
  draft.value = drafts.get(switchedFrom) ?? "";
  bigPrompt.value = localStorage.getItem(bigKey(switchedFrom)) === "1";
  // Monaco places the caret on an all-ASCII line by counting columns instead of measuring;
  // measuring is always right.
  const box = (promptBox = monaco.editor.create(promptHostEl.value!.firstElementChild as HTMLElement, { ...editorOptions, disableMonospaceOptimizations: true, value: draft.value }));
  box.onDidContentSizeChange(fitPrompt);
  fitPrompt();
  addLineDots(box);
  addListKeys(box);
  // Ctrl+Enter sends, in place of Monaco's insert-line-below. An action, not addCommand: Monaco's
  // addCommand keys are page-wide, and every tab has its own editor.
  box.addAction({ id: "claude3.submitPrompt", label: "Send Prompt", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], run: sendKey });
  imageChars = box.createDecorationsCollection();
  showImageChars();
  box.onDidChangeModelContent(() => {
    draft.value = box.getValue();
    showImageChars();
  });
  lockPrompt();
  window.addEventListener("keydown", onPageKey, true);
  render();
  const pendingRun = sessionStorage.getItem(runKey());
  if (pendingRun !== null) showRun(pendingRun);
  if (sessionStorage.getItem(runWaitKey()) !== null) {
    runLive = true;
    void awaitRun();
  }
  // Nothing arrives between API calls, so the clock ticks on its own.
  ticker = window.setInterval(() => {
    if (props.status?.active) now.value = Date.now();
  }, 250);
  // The open box's clamp is sized from the pane height, so any resize has to re-derive it.
  resize = new ResizeObserver(resyncSelectedBlock);
  resize.observe(historyEl.value!);
  // Manual scrolling never changes the selection; the pane is clamped to the window the rules allow.
  historyEl.value!.addEventListener("scroll", () => {
    if (programmaticScroll || !turns().length) return;
    const bounds = scrollBounds();
    if (!bounds) return;
    const clamped = Math.min(bounds.max, Math.max(bounds.min, historyEl.value!.scrollTop));
    if (clamped !== historyEl.value!.scrollTop) historyEl.value!.scrollTop = clamped;
  });
  document.addEventListener("mousedown", closeCtxOutside, true);
  window.addEventListener("focus", checkDeploySoon);
});
onBeforeUnmount(() => {
  window.removeEventListener("focus", checkDeploySoon);
  window.clearInterval(ticker);
  resize?.disconnect();
  document.removeEventListener("mousedown", closeCtxOutside, true);
  window.removeEventListener("keydown", onPageKey, true);
  promptBox?.dispose();
});
</script>

<template>
  <div class="pane" :class="{ 'big-prompt-editor': bigPrompt }" @click.capture="copyCodeBlock">
    <div ref="historyEl" class="history" tabindex="-1"></div>
    <div ref="ctxPopEl" class="ctx-pop" hidden></div>
    <dialog ref="runPopEl" class="run-pop" @close="runClosed">
      <pre>{{ runText }}</pre>
      <form method="dialog"><button autofocus>OK</button></form>
    </dialog>
    <dialog ref="deployPopEl" class="run-pop">
      <pre>{{ deployText }}</pre>
      <form method="dialog"><button value="deploy">Deploy</button> <button value="continue">Continue</button> <button value="" autofocus>Cancel</button></form>
    </dialog>
    <dialog ref="imagePopEl" class="img-pop" @close="popSrc = ''">
      <div class="img-title">
        <strong>{{ popLabel }}</strong>
        <span>{{ !popEditable ? "already sent, shown only" : popDepth ? "drag to crop, click to undo a crop" : "drag to crop" }}</span>
        <form method="dialog"><button autofocus>Close</button></form>
      </div>
      <div ref="popFrameEl" class="img-frame" :class="{ readonly: !popEditable }" @pointerdown="cropDown" @pointermove="cropMove" @pointerup="cropUp" @pointercancel="cropCancel">
        <img ref="popImageEl" :src="popSrc" alt="" draggable="false" />
        <div ref="popSelEl" class="img-sel" hidden></div>
      </div>
    </dialog>
    <div class="dock">
      <div ref="promptHostEl" class="prompt" @pointerdown.capture="onPromptPointer" @mousedown.capture="onPromptMouse">
        <div v-show="!promptMarkdown"></div>
        <div v-show="promptMarkdown" ref="promptMdEl" class="prompt-md response markdown" tabindex="-1" @keydown="onMdKey" v-html="promptHtml"></div>
      </div>
      <div class="dock-controls">
        <div class="footer">
          <div class="indicator finish" :class="pill.cls" :title="pill.title">{{ pill.text }}</div>
          <div class="group">
            <button class="stop" :class="{ stopping: stopping && active }" title="Stop" aria-label="Stop" :disabled="!active" @click="stop">&#x25AA;</button>
            <button :class="{ 'deploy-due': deployDue }" title="Run the project's ./run, the same as the prompt r. Ctrl-click: the same as the prompt v" @mousedown.prevent @click="runScript($event.ctrlKey)">Run</button>
            <button title="Capture the screen for this prompt, hiding this window for the shot. Ctrl-click: this window stays up. Alt-click: the previous tab is shown for the shot" :disabled="capturing || session?.trashed" @mousedown.prevent @click="capture">Cap</button>
            <button ref="ctxButtonEl" title="Tokens by source, for the last prompt and the whole conversation, in and out" :disabled="!session?.turns.length" @click="toggleCtx">Ctx</button>
          </div>
        </div>
        <div class="stats">
          <div class="status" title="Agentic turns in the last prompt / the limit">{{ stats.turns }}</div>
          <div class="status context" :class="{ over: contextUsed > compactAt }" title="Context used / where the CLI compacts it, in thousands of tokens. Click to compact now" @click="compactNow">
            {{ Math.round((contextUsed || 0) / 1000) }}/{{ inK(compactAt) }}
          </div>
          <div v-if="stats.graftSaved > 0.25" class="status" title="What graft has saved this session">${{ stats.graftSaved.toFixed(2) }}</div>
          <div v-if="stats.pony === 0 || ceilings === 0" class="status" title="Ponytail skips this session : ponytail comments in the project">{{ stats.pony }}:{{ ceilings }}</div>
          <div class="status" title="Time since anything new showed in the pane">{{ stats.quiet }}</div>
          <div class="status" title="Time spent responding in this session">{{ stats.duration }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
/* Ported from claude2's conversation pane. Not scoped: the history is built by script, and its
   elements carry no scope attribute. Font sizes stay in 14-18px and text is solid black (CLAUDE.md). */
.pane { height: 100%; min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr) auto; background: var(--page); }
.pane > .history { grid-area: 1 / 1; }
.pane .dock { display: flex; align-items: stretch; gap: 10px; border-top: 1px solid var(--border); background: var(--page); padding: 8px 12px; }
.pane .dock-controls { display: flex; flex-direction: column; justify-content: flex-end; align-items: stretch; gap: 4px; flex: 0 1 auto; min-width: 0; margin-left: auto; }
.pane .dock-controls button { min-height: 0; padding: 3px 8px; }
.pane .history { overflow-y: auto; overflow-x: hidden; min-height: 0; padding: 10px 12px 4px; outline: none; }
.pane .turn { margin-bottom: 4px; }
.pane .turn.selected .prompt-bar { outline: 2px solid #f28b82; outline-offset: -2px; }
.pane .prompt-bar { width: 100%; height: 1.65em; border: 1px solid #eadf90; background: var(--yellow); color: var(--ink); display: block; text-align: left; padding: 1px 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-radius: 4px; cursor: pointer; min-height: 0; font: inherit; }
.pane .prompt-bar:hover { background: linear-gradient(var(--wash), var(--wash)), var(--yellow); }
.pane .prompt-bar.prompt-expanded { height: auto; min-height: 1.65em; overflow: visible; text-overflow: clip; white-space: pre-wrap; }
.pane .response { margin: 4px 0 8px; border-left: 3px solid var(--border); padding: 8px 10px; background: var(--surface); overflow-wrap: anywhere; overflow-x: hidden; }
.pane .response.error { border-left-color: #c62828; }
.pane .response.markdown { font: 14px/1.5 Aptos, "Segoe UI", sans-serif; white-space: normal; }
.pane .response.markdown > :first-child { margin-top: 0; }
.pane .response.markdown h1, .pane .response.markdown h2 { font-size: 14px; font-weight: 700; margin: 14px 0 6px; padding-bottom: 3px; border-bottom: 1px solid var(--border); }
.pane .response.markdown h3, .pane .response.markdown h4, .pane .response.markdown h5, .pane .response.markdown h6 { font-size: 14px; font-weight: 700; margin: 12px 0 5px; }
.pane .response.markdown p { margin: 0 0 8px; }
.pane .response.markdown ul, .pane .response.markdown ol { margin: 0 0 8px; padding-left: 24px; }
.pane .response.markdown li { margin: 2px 0; }
.pane .response.markdown li > ul, .pane .response.markdown li > ol { margin: 2px 0 0; }
.pane .response.markdown blockquote { margin: 0 0 8px; border-left: 3px solid var(--border); padding: 2px 10px; }
.pane .response.markdown hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
/* Above the closing answer: heavier than a markdown rule so the two never get confused. */
.pane .response.markdown hr.answer-rule { border-top: 2px solid #000; }
.pane .response.markdown a { color: var(--ink); }
.pane .response.markdown code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px; background: rgba(0,0,0,0.05); border-radius: 4px; padding: 1px 4px; }
.pane .response.markdown pre { background: #f2f1ec; border: 1px solid var(--border); border-radius: 8px; margin: 0 0 10px; padding: 8px 10px; overflow: auto; }
.pane .response.markdown pre code { background: none; padding: 0; white-space: pre; }
.pane .response.markdown table { border-collapse: collapse; margin: 0 0 10px; font-size: 14px; }
.pane .response.markdown th, .pane .response.markdown td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
.pane .response.markdown th { background: rgba(0,0,0,0.05); }
/* A run of tool lines between the prose, shown only while the box's tool groups are. */
.pane .response.markdown .tool-group { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; margin: 0 0 8px; }
/* A tool line with a stored detail: a click shows the detail in its place. */
.pane .response.markdown .tool-call:not(.open) > .tool-long, .pane .response.markdown .tool-call.has-detail.open > .tool-short { display: none; }
.pane .response.markdown .tool-call.has-detail { cursor: pointer; }
.pane .response.markdown .tool-call.has-detail:hover { background: var(--wash); }
.pane .error-note { margin-top: 10px; background: #fdecec; border: 1px solid #f0bcbc; border-radius: 6px; padding: 8px 10px; }
.pane .run-arrow { font-weight: 700; margin-right: 6px; animation: run-blink 0.6s steps(1) infinite; }
@keyframes run-blink { 50% { visibility: hidden; } }
/* The prompt box: a frame around a Monaco editor. It grows with the text (--content-h, set by the
   script) from two lines to six, and still stretches to the controls' height beside it. */
.pane .prompt { position: relative; flex: 1 1 260px; min-width: 180px; min-height: min(var(--content-h, 0px), 144px); max-height: 144px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.pane .prompt:focus-within { outline: 2px solid var(--ink); outline-offset: -1px; border-color: transparent; }
/* Inset just past the rounded corners, so the editor's square ones stay inside the border. */
.pane .prompt > div { position: absolute; inset: 3px; }
/* promptMarkdown: the big box's text rendered as a markdown box, read-only, in the editor's place. */
.pane .prompt > .prompt-md { margin: 0; border-left: none; padding: 7px 10px 3px 14px; background: transparent; overflow-y: auto; outline: none; }
/* bigPromptEditor: the editor runs the pane's full height on the left, and the history and the
   controls share the column to its right, the controls at their own two-row height. The dock
   dissolves so its two children can sit in the pane's grid beside the history. The right column
   takes at least half the pane, more only if the controls need it. */
.pane.big-prompt-editor { grid-template-columns: minmax(0, 1fr) minmax(max-content, 1fr); }
.pane.big-prompt-editor .dock { display: contents; }
.pane.big-prompt-editor .prompt { grid-column: 1; grid-row: 1 / 3; align-self: stretch; max-height: none; margin: 8px 0 8px 12px; }
/* Sized by the column, never by its own content, or a long line would widen the column. */
.pane.big-prompt-editor > .history { grid-area: 1 / 2; contain: inline-size; }
.pane.big-prompt-editor .dock-controls { grid-column: 2; grid-row: 2; margin: 0; padding: 8px 16px 8px 12px; border-top: 1px solid var(--border); }
.pane.big-prompt-editor .footer, .pane.big-prompt-editor .stats { justify-content: center; }
.pane.big-prompt-editor .stats { margin-right: 0; }
.pane .footer { display: flex; gap: 8px; align-items: center; }
.pane .group { display: flex; gap: 6px; align-items: center; min-width: 0; flex-wrap: wrap; }
/* Every digit one width, so a ticking stat does not resize the column. */
.pane .stats { display: flex; gap: 1ch; align-items: center; justify-content: flex-end; margin-left: 8px; margin-right: 20px; font-variant-numeric: tabular-nums; }
.pane .status { white-space: nowrap; }
.pane .context { cursor: pointer; }
.pane .context.over { background: #ffd0d0; border-radius: 4px; padding: 0 5px; margin: 0 -5px; }
/* Every dock control keeps a white fill and says "unavailable" by a dashed grey border (style.css). */
.pane .dock-controls button { background: #fff; }
.pane .dock-controls button:hover:not(:disabled) { background: #fff; border-color: #000; }
.pane .dock-controls button:disabled { background: #fff; border-color: #bfbfbf; }
/* The Git button's dirty colours (Git.vue). After the hover rule and as specific, so its border stays. */
.pane .dock-controls button.deploy-due:not(:disabled) { background: #fbd9d9; border-color: #e4a7a7; }
.pane .dock-controls button.deploy-due:hover:not(:disabled) { background: linear-gradient(var(--wash), var(--wash)), #fbd9d9; }
.pane .stop { display: inline-flex; align-items: center; justify-content: center; line-height: 1; }
.pane .stop:not(:disabled) { color: #000; border-color: #000; }
/* Stop asks the CLI to finish the message it is on, so the run keeps streaming for a moment. */
.pane .stop.stopping:not(:disabled) { background: #ffd4d4; }
.pane .indicator { border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; font-weight: 700; white-space: nowrap; }
/* One letter at a fixed width, so the pill never resizes as the phase changes. */
.pane .finish { width: calc(2ch + 16px); flex: none; display: flex; align-items: center; justify-content: center; height: calc(1.45em + 6px); font-size: 16.8px; }
.pane .indicator.done { background: #fff; }
.pane .indicator.active { border-color: #e2a3a3; background: #fde0e0; }
.pane .indicator.active.waiting { border-color: #a5d6a7; background: #e3f6e4; }
/* The Ctx popup, opening upward from its button; placed by script. */
.pane .ctx-pop { position: fixed; z-index: 50; overflow: auto; padding: 8px 10px; border: 1px solid #000; border-radius: 8px; background: #fff; color: #000; font-size: 14px; box-shadow: 0 4px 14px rgba(0,0,0,0.2); }
/* The ./run result. */
/* The top is pinned, so a growing ./run log doesn't re-centre the dialog on every line. */
.pane .run-pop { margin-top: 10vh; max-width: 80vw; max-height: 80vh; padding: 12px 16px; border: 1px solid #000; border-radius: 8px; color: #000; font-size: 14px; }
.pane .run-pop pre { margin: 0 0 10px; white-space: pre-wrap; font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.pane .run-pop form { text-align: right; }
.pane .run-pop button { font-size: 14px; }
/* The icons leading a prompt, one per picture, in the prompt box and on a bar. */
.pane .img-char { cursor: pointer; }
/* The image popup, claude2's Image pane as a dialog. Flex only while open, or it would show closed. */
.pane .img-pop { width: 96vw; height: 94vh; max-width: none; max-height: none; padding: 12px 16px; border: 1px solid #000; border-radius: 8px; color: #000; font-size: 14px; }
.pane .img-pop[open] { display: flex; flex-direction: column; }
.pane .img-title { flex: none; display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.pane .img-title form { margin-left: auto; }
.pane .img-title button { font-size: 14px; }
/* position: relative so the crop rectangle can be laid over the picture; the image stays a direct
   grid item, which is what lets its max-height resolve against the frame. */
.pane .img-frame { position: relative; flex: 1; min-height: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); display: grid; place-items: center; overflow: auto; padding: 8px; cursor: crosshair; user-select: none; }
.pane .img-frame.readonly { cursor: default; }
.pane .img-frame img { max-width: 100%; max-height: 100%; object-fit: contain; user-select: none; touch-action: none; }
.pane .img-sel { position: absolute; border: 2px solid #1a6fd4; background: rgba(26,111,212,0.16); pointer-events: none; }
.pane .ctx-pop table { width: 100%; border-collapse: collapse; }
.pane .ctx-pop th, .pane .ctx-pop td { padding: 1px 8px; white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }
.pane .ctx-pop thead tr:first-child th:first-child, .pane .ctx-pop td:first-child { text-align: left; }
.pane .ctx-pop td:first-child { white-space: normal; overflow-wrap: anywhere; }
.pane .ctx-pop tr.opens { cursor: pointer; }
.pane .ctx-pop .ctx-twist { display: inline-block; width: 1em; margin-left: -1em; }
.pane .ctx-pop th[colspan] { text-align: center; }
.pane .ctx-pop th { font-weight: 700; vertical-align: bottom; }
.pane .ctx-pop thead tr:last-child th, .pane .ctx-pop th[rowspan] { border-bottom: 1px solid #000; }
.pane .ctx-pop tr.top td { border-top: 1px solid var(--border); }
.pane .ctx-pop tr.subtotal td { background: var(--yellow); }
.pane .ctx-pop tr.total td { font-weight: 700; border-top: 1px solid #000; }
.pane .ctx-pop tr.cache-first td { padding-top: 6px; }
.pane .ctx-pop .ctx-head { margin-bottom: 6px; font-weight: 700; }
.pane .ctx-pop .ctx-bar { display: flex; justify-content: flex-end; gap: 6px; margin-bottom: 4px; }
.pane .ctx-pop .ctx-bar button { min-height: 0; padding: 2px 8px; }
.pane .ctx-pop .ctx-notes { margin-bottom: 8px; max-width: 64ch; white-space: normal; }
.pane .ctx-pop .ctx-notes > div { margin-bottom: 4px; }
</style>
