<script setup lang="ts">
// The conversation pane, ported from claude2's conversationHtml. The history (bars and boxes) is
// built imperatively, as claude2 builds it, so streaming refills one box rather than re-rendering
// the pane; the dock is an ordinary template. Left out for now: search,
// export, presets (M), arrow-key navigation and the frozen pane.
// The prompt box is a Monaco editor with claude2's editing (src/monaco.ts), and has claude2's big
// prompt editor.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { HostName, Tab } from "../../shared/config.ts";
import { COMPACT_RESERVE, DEFAULT_CONTEXT_WINDOW, modelChoice, quotaSpend, typedPrompt, type AttachedFile, type ClaudeSession, type ClaudeTurn, type RunningStatus } from "../../shared/types.ts";
import { post, postHost, quotaUse } from "../api.ts";
import { cropRect } from "../cropRect.ts";
import { addLineDots, addListKeys, editorOptions, monaco, untab } from "../monaco.ts";
import { copy, copyCodeBlock } from "../copy.ts";
import { answerText, fillBox, occurrences, renderMarkdown, shownText, textHits, withoutDetails } from "../render.ts";
import { loadWaiting, saveWaiting, type Waiting } from "../waitingImages.ts";
import { wheelZoom } from "../wheelZoom.ts";
import FolderPicker from "./FolderPicker.vue";

// active: this pane's tab is the one on show, so the page-wide keys are its. search: the sidebar's
// search text; while non-empty, every bar holding it gets a light-blue wash.
const props = defineProps<{ tab: Tab; session: ClaudeSession | null; status: RunningStatus | null; version: number; active: boolean; ceilings: number; search: string }>();
const emit = defineEmits<{ started: [sessionId: string]; deployDue: [due: boolean] }>();

const historyEl = ref<HTMLElement>();
// Ctrl-wheel on the bars and boxes sizes their text alone, the same in every tab.
const zoom = wheelZoom("pane-font-size");
const runPopEl = ref<HTMLDialogElement>();
const runText = ref("");
const runErrorEl = ref<HTMLDialogElement>();
const runErrorText = ref("");
const deployPopEl = ref<HTMLDialogElement>();
const deployText = ref("");
const setupPopEl = ref<HTMLDialogElement>();
const setupText = ref("");
const setupStarted = ref(false);
const commitPopEl = ref<HTMLDialogElement>();
const commitText = ref("");
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
// The selected search hit: the nth occurrence in that turn's bar or box. A bar holding it shows its
// whole prompt for as long as it does.
interface SearchHit { turnId: string; bar: boolean; nth: number }
let searchHit: SearchHit | null = null;
// Set by a step until the hit has been scrolled to, so a later render leaves the box alone.
let searchHitMoved = false;
let programmaticScroll = false;
// Unsent text per session; '' is the new-session draft. Every edit is saved in localStorage, as
// claude2 keeps its drafts beside the sessions, so a reload puts each one back in its session's box.
// ponytail: drafts of deleted sessions stay in localStorage; prune them if the 5MB quota ever matters.
const draftKey = (id: string): string => `draft:${props.tab.id}:${id}`;
const drafts = new Map<string, string>();
for (const key of Object.keys(localStorage)) {
  if (key.startsWith(draftKey(""))) drafts.set(key.slice(draftKey("").length), localStorage.getItem(key)!);
}

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
    bar.className = "prompt-bar" + (expandedPrompts.has(turn.id) || (searchHit?.bar && searchHit.turnId === turn.id) ? " prompt-expanded" : "");
    const typed = typedText(turn);
    if (props.search && (occurrences(typed, searchNeedle()) || occurrences(shownText(turn), searchNeedle()))) bar.classList.add("search-hit");
    // The hover leads with what this prompt actually ran under, which need not be what the dock
    // is set to now, and when it was sent.
    const ranAs = [turn.model, turn.effort, turn.advisor && `advisor ${turn.advisor}`, turn.modelId].filter(Boolean).join(" / ");
    const sent = new Date(turn.createdAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    bar.title = `${ranAs}   ${sent}\n${typed}`;
    bar.dataset.help = "bar";
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
    // claude2's fork mark leads every bar. A span, since a bar is a button and can't hold buttons.
    const forkIcon = document.createElement("span");
    forkIcon.className = "bar-icon";
    forkIcon.dataset.help = "fork mark";
    forkIcon.title = "Fork here: copy the session, then drop every block below this one";
    forkIcon.innerHTML = '<svg viewBox="0 0 16 16"><path d="M8 1v5l-4 4v5M8 6l4 4v5M2 12.5 4 15l2-2.5M10 12.5 12 15l2-2.5"/></svg>';
    bar.appendChild(forkIcon);
    // One icon per picture sent with this prompt, as in the prompt box.
    (turn.images ?? []).forEach((_, at) => {
      const icon = document.createElement("span");
      icon.className = "img-char";
      icon.dataset.help = "bar picture";
      icon.dataset.image = String(at);
      icon.textContent = IMG;
      bar.appendChild(icon);
    });
    // Then one mark per file sent with it.
    (turn.files ?? []).forEach((_, at) => {
      const mark = document.createElement("span");
      mark.className = "file-char";
      mark.dataset.help = "bar file mark";
      mark.dataset.file = String(at);
      mark.textContent = FILE;
      bar.appendChild(mark);
    });
    bar.appendChild(document.createTextNode(typed || (turn.images?.length || turn.files?.length ? "" : "(empty prompt)")));
    bar.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest(".bar-icon")) return void fork(turns().length - index - 1, turn.id);
      if (event.altKey) return copy(typed, bar);
      const icon = (event.target as HTMLElement).closest<HTMLElement>(".img-char");
      if (icon) return void showSentImage(turn, Number(icon.dataset.image));
      const mark = (event.target as HTMLElement).closest<HTMLElement>(".file-char");
      if (mark) return showFile(turn.files![Number(mark.dataset.file)]!);
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
      response.dataset.help = "box";
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
  fillBox(box, turn.response || "", tools, turn.id, openToolCalls, searchNeedle());
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
  paintSearchHit();
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
const drafted = (): string[] => [...drafts].filter(([, text]) => text.trim()).map(([id]) => id).concat(draft.value.trim() && props.session ? [props.session.id] : [], Object.keys(waiting), Object.keys(waitingFiles));
// Text picked in the Snips joins the end of the prompt, on a line of its own, with the cursor after it.
// An edit through Monaco, so ctrl-z takes it back. False when the box couldn't take it.
// Into an empty box (no text, pictures or files) it is sent at once, after a dialog when the session has turns (commitChoice);
// a send that is cancelled or fails leaves it in the box.
function appendPrompt(text: string): boolean {
  const box = promptBox;
  if (!box || box.getOption(monaco.editor.EditorOption.readOnly)) return false;
  setPromptMarkdown(false);
  const model = box.getModel()!;
  const end = model.getPositionAt(model.getValueLength());
  const value = model.getValue();
  const empty = !value.trim() && !images().length && !attached().length;
  box.pushUndoStop();
  box.executeEdits("claude3", [{ range: monaco.Range.fromPositions(end), text: (value && !value.endsWith("\n") ? "\n" : "") + untab(text) }]);
  box.pushUndoStop();
  box.focus();
  box.setPosition(model.getPositionAt(model.getValueLength()));
  box.revealPosition(box.getPosition()!);
  if (empty) void submit(undefined, false, true);
  return true;
}
const focusPrompt =(): void => (promptMarkdown.value ? promptMdEl.value : promptBox)?.focus();
// claude2's promptReturned: the prompt never ran, so the box the send emptied takes it back. Anything
// typed since outranks it and stays. A session not on show holds it as its draft.
function returnPrompt(sessionId: string, text: string, pictures: string[], files: WaitingFile[] = []): void {
  if (pictures.length) {
    waiting[sessionId] = [...pictures.map((picture) => [picture]), ...(waiting[sessionId] ?? [])];
    storeImages();
  }
  if (files.length) {
    waitingFiles[sessionId] = [...files, ...(waitingFiles[sessionId] ?? [])];
    storeFiles();
  }
  if (sessionId === sessionKey()) {
    if (!draft.value) draft.value = text;
  } else if (!drafts.get(sessionId)) {
    drafts.set(sessionId, text);
    localStorage.setItem(draftKey(sessionId), text);
  }
}

// ---- search (claude2's) ----

const searchNeedle = (): string => props.search.toLowerCase();

// Every hit in the session, top to bottom, a bar's ahead of its box's. A box holding the text is
// built offscreen to count them as rendered, since only the selected one is in the page.
function searchHits(): SearchHit[] {
  const needle = searchNeedle();
  const hits: SearchHit[] = [];
  for (const turn of turns()) {
    const add = (bar: boolean, count: number): void => {
      for (let nth = 0; nth < count; nth++) hits.push({ turnId: turn.id, bar, nth });
    };
    add(true, occurrences(typedText(turn), needle));
    if (!occurrences(shownText(turn), needle)) continue;
    const box = document.createElement("div");
    fillResponse(box, turn, false);
    add(false, textHits(box, needle).length);
  }
  return hits;
}

// A step from the sidebar: first lands on this session's first hit, otherwise on the one after the
// selected hit, wrapping from the last to the first. A hit in a box opens that block alone; a hit in
// a bar leaves every block closed.
function stepSearch(first: boolean): void {
  const hits = searchHits();
  const hit = hits[(first ? 0 : hits.findIndex((entry) => entry.turnId === searchHit?.turnId && entry.bar === searchHit.bar && entry.nth === searchHit.nth) + 1) % hits.length];
  searchHit = hit ?? null;
  if (hit) {
    anchorIndex = turns().findIndex((turn) => turn.id === hit.turnId);
    boxOpen = !hit.bar;
    toolsBox = false;
    boxScrollNext = "restore";
    searchHitMoved = true;
    // A step is navigation, and it outranks what a first render or a live run would select.
    initialized = true;
    pendingTurnCount = 0;
    if (status?.active) shownActiveTurn = status.turnId;
  }
  render();
}

// A CSS highlight, so the hit needs no element of its own in the bar or the rendered markdown. A
// rebuild takes its range along, so this runs at the end of every sync. The highlight's name is
// page-wide and every tab has a pane, so only the tab on show paints.
function paintSearchHit(): void {
  if (!props.active) return;
  const block = searchHit ? historyEl.value?.querySelector(`[data-turn-id="${searchHit.turnId}"]`) : null;
  const host = block?.querySelector<HTMLElement>(searchHit!.bar ? ".prompt-bar" : ".response");
  const spot = host ? textHits(host, searchNeedle())[searchHit!.nth] : undefined;
  if (!host || !spot) {
    CSS.highlights.delete("search-selection");
    return;
  }
  const range = new Range();
  range.setStart(spot.node, spot.offset);
  range.setEnd(spot.node, spot.offset + props.search.length);
  CSS.highlights.set("search-selection", new Highlight(range));
  if (!searchHitMoved) return;
  searchHitMoved = false;
  // Centred in a box or bar clamped to scroll; one showing in full ignores this.
  host.scrollTop += range.getBoundingClientRect().top - host.getBoundingClientRect().top - host.clientHeight / 2;
}

defineExpose({ applyDelta, drafted, appendPrompt, attach, focusPrompt, returnPrompt, stepSearch, runScript });

// ---- the dock ----

function report(error: unknown): void {
  window.alert(error instanceof Error ? error.message : String(error));
}

// A bar's fork mark. The backend keeps the whole conversation as a new session and cuts this one
// back to just after that bar's run, Claude's transcript too; it refuses while the session runs.
async function fork(count: number, turnId: string): Promise<void> {
  const question = count
    ? `Fork the conversation here, dropping the ${count} run${count === 1 ? "" : "s"} after this one?\n\nClaude forgets them too. The whole conversation is kept as a new session beside this one.`
    : "Copy this session?\n\nThe copy is a session of its own, holding the whole conversation.";
  if (!props.session || !window.confirm(question)) return;
  try {
    const { warning } = await post<{ warning: string }>(props.tab, "fork", { sessionId: props.session.id, turnId });
    if (warning) window.alert(warning);
  } catch (error) {
    report(error);
  }
}

// The backend keeps the box with the session; a failed save puts it back.
function setBestModel(event: Event): void {
  const box = event.target as HTMLInputElement;
  post(props.tab, "bestModel", { sessionId: props.session?.id, on: box.checked }).catch((error) => {
    box.checked = !!props.session?.bestModel;
    report(error);
  });
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
// Terminal colour codes (pm2 and others print them even into a file) would show as [1m[36m...
const plain = (text: string): string => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
function putRun(text: string): void {
  const dialog = runPopEl.value!;
  const following = !dialog.open || dialog.scrollHeight - dialog.scrollTop - dialog.clientHeight < 40;
  runText.value = plain(text);
  if (!props.active) return;
  if (!dialog.open) dialog.showModal();
  if (following) void nextTick(() => (dialog.scrollTop = dialog.scrollHeight));
  // A failed ./run also gets a dialog of its own on top, since the output's is easy to OK unread.
  const failure = sessionStorage.getItem(runFailKey());
  if (failure && !runErrorEl.value!.open) {
    runErrorText.value = failure;
    runErrorEl.value!.showModal();
  }
}
// What the error dialog says: the failure, then the output's "!!" lines (claude3's deploy marks a
// failed host with them). Kept until its OK, like the output.
const runFailKey = (): string => `runFail:${props.tab.id}`;
function runErrorClosed(): void {
  sessionStorage.removeItem(runFailKey());
}
function runFailure(head: string, output = ""): string {
  return [head, ...plain(output).split("\n").filter((line) => line.startsWith("!!"))].join("\n");
}
// While a ./run goes on, the dialog shows its output so far. OK hides that (the run carries on)
// and the result opens the dialog again.
let runLive = false;
function showRunLive(output: string): void {
  if (runLive) putRun(`./run in ${props.tab.label} running...\n\n${output}`);
}
function showRun(text: string, failure = ""): void {
  runLive = false;
  runState = "";
  sessionStorage.setItem(runKey(), text);
  if (failure) sessionStorage.setItem(runFailKey(), failure);
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
const askRun = () => post<{ done: boolean; code: number; output: string; id?: string }>(props.tab, "runResult", {});

// This page's id for the ./run whose answer is due, so a page reloaded meanwhile picks up the wait
// and can tell that run's result from an older one's.
const runIdKey = (): string => `runId:${props.tab.id}`;
// One ./run at a time: "asking" while its setup question is out, "going" until its result shows.
let runState: "" | "asking" | "going" = "";

// Also the footer's Run button (ctrl-click: "v"). It leaves the prompt box's text alone and never
// takes focus, so the Enter that dismisses the result can't land on it and run ./run again.
// It asks the deploy-setup question first, as a prompt does, unless the caller already has
// (the deploy warning's Deploy comes after a prompt's). With a ./run already going it starts no
// second one: it brings the live output back up, which OK had hidden.
async function runScript(restartVite: boolean, askSetup = true): Promise<void> {
  if (runState === "asking") return;
  if (runState === "going") {
    runLive = true;
    return putRun(runText.value);
  }
  runState = "asking";
  let ok = false;
  try {
    ok = !askSetup || (await deploySetupOk("run"));
  } finally {
    runState = ok ? "going" : "";
  }
  if (!ok) return;
  const id = crypto.randomUUID();
  sessionStorage.setItem(runIdKey(), id);
  sessionStorage.removeItem(runFailKey());
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
    const { output } = await post<{ output: string }>(props.tab, "run", { restartVite, id });
    sessionStorage.removeItem(runIdKey());
    showRun(`./run in ${props.tab.label} finished.\n\n${output}`);
  } catch (error) {
    // A network failure: a ./run that restarts this backend (claude3's own) cuts the answer off,
    // and the script runs on, so its result is fetched once the backend is back.
    if (error instanceof TypeError) return awaitRun(id);
    sessionStorage.removeItem(runIdKey());
    const message = error instanceof Error ? error.message : String(error);
    showRun(`./run in ${props.tab.label}: ${message}`, runFailure(`./run in ${props.tab.label}: ${message.split("\n")[0]}`, message));
  } finally {
    window.clearInterval(follow);
  }
}

// The result of the ./run this page named id, asked of a backend that may be restarting.
async function awaitRun(id: string): Promise<void> {
  for (let tries = 0; tries < 300; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const result = await askRun().catch(() => null);
    if (!result) continue; // the backend is still restarting
    // Another run's id: the request for this one never reached the backend (it was down), and what
    // it has is an older run's result. A backend from before ids sends none and is taken at its word.
    if (result.id && result.id !== id) {
      sessionStorage.removeItem(runIdKey());
      const head = `./run in ${props.tab.label} didn't start: its backend couldn't be reached. Press Run again.`;
      return showRun(head, head);
    }
    if (!result.done) {
      showRunLive(result.output);
      continue;
    }
    sessionStorage.removeItem(runIdKey());
    // 124 is the backend's time limit (timeout's exit code).
    const head = `./run in ${props.tab.label} ${result.code === 0 ? "finished" : result.code === 124 ? "was stopped after 5 minutes" : `failed (exit ${result.code})`}.`;
    return showRun(`${head}\n\n${result.output}`, result.code === 0 ? "" : runFailure(head, result.output));
  }
  sessionStorage.removeItem(runIdKey());
  const head = `./run in ${props.tab.label}: no result after 5 minutes.`;
  showRun(head, head);
}

// Before a prompt, until the project's ./run is set up for the Run button (the deployable skill;
// the flag is the project's deploySetup, kept by its backend). With no flag yet the backend's
// check runs first, and a project that passes it is marked set up and its prompt goes on with no
// dialog. Otherwise a dialog asks: Set up sends the skill to a new session and opens it (this
// prompt goes along into its box, unsent; once "started" the button reads
// "Set up again", so a second setup is meant); Check checks again and sets the flag when ./run passes. Not
// needed sets "none" and sends the prompt, as Continue does without touching the flag; Set up,
// Check and Cancel don't send it. Once Set up has run ("started"), the dialog comes with no check first,
// except for a prompt to the setup session itself (an answer to its question), which just goes.
// Enter is Cancel, as in the other dialogs before a prompt (Check once "started", which changes nothing):
// Set up starts a session that writes scripts into the project, so it takes a click.
// A ./run (Run, "r", "v") asks the same, for the same flag; `what` is what goes on or doesn't. It
// also checks a "done" project again, so a script broken since, or a rule the check has gained, is
// caught where it matters; the backend drops the flag when that fails.
const SETUP_PROMPT = "Set up deploy for claude3's Run button: use the deployable skill (~/.claude/skills/deployable/SKILL.md) on this project.";
async function deploySetupOk(what: "prompt" | "run" = "prompt"): Promise<boolean> {
  const state = props.tab.deploySetup;
  if (state === "none" || (state === "done" && what === "prompt")) return true;
  if (state === "started" && what === "prompt" && turns()[0]?.prompt === SETUP_PROMPT) return true;
  setupStarted.value = state === "started";
  const held = what === "prompt" ? "Your prompt stays unsent, in the prompt box," : "./run doesn't start";
  let problems: string[] = [];
  if (!setupStarted.value) {
    try {
      ({ problems } = await post<{ problems: string[] }>(props.tab, "deployCheck", {}));
    } catch (error) {
      // As with the deploy warning, a failed check doesn't hold the prompt up.
      report(new Error(`Couldn't check whether ${props.tab.label} is set up for the Run button (${what === "prompt" ? "the prompt is sent" : "./run starts"} anyway): ${error instanceof Error ? error.message : String(error)}`));
      return true;
    }
    if (!problems.length) return true;
  }
  setupText.value = setupStarted.value
    ? `${props.tab.label}: Claude was asked to set up its deploy for the Run button, in a session of its own.\n\nCheck reads ./run and ./deploy without running them, and stops this question when they pass.\n${held} unless you pick Continue.`
    : `${props.tab.label} isn't set up for claude3's Run button:\n${problems.map((problem) => `- ${problem}`).join("\n")}\n\nSet up: Claude does it in a new session (the deployable skill).\nCheck: check again, after fixing it yourself.\nNot needed: nothing to deploy here; never ask again.\n${held} unless you pick Continue or Not needed.`;
  await nextTick(); // the autofocus attribute follows setupStarted before showModal reads it
  const dialog = setupPopEl.value!;
  dialog.returnValue = "";
  dialog.showModal();
  await new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
  const choice = dialog.returnValue;
  try {
    if (choice === "setup") {
      const { sessionId } = await post<{ sessionId: string }>(props.tab, "prompt", { sessionId: "", prompt: SETUP_PROMPT, images: [] });
      await post(props.tab, "deploySetup", { state: "started" });
      // Opened, so the footer's status is the setup's. The prompt typed goes along, unsent, so the box
      // on show still holds it: emptied first in its own session (and that session's storage), then
      // the setup session's draft, which the switch puts in the box. Pictures and files stay behind.
      if (what === "prompt") {
        const text = draft.value;
        draft.value = "";
        await nextTick();
        drafts.set(sessionId, text);
      }
      emit("started", sessionId);
    } else if (choice === "check") {
      const { problems } = await post<{ problems: string[] }>(props.tab, "deployCheck", {});
      window.alert(problems.length ? `${props.tab.label}: the deploy setup isn't finished.\n\n${problems.map((problem) => `- ${problem}`).join("\n")}` : `${props.tab.label}: deploy is set up. Press Run to deploy.`);
    } else if (choice === "none") {
      await post(props.tab, "deploySetup", { state: "none" });
    }
  } catch (error) {
    report(new Error(`Deploy setup for ${props.tab.label} failed (${what === "prompt" ? "the prompt wasn't sent" : "./run didn't start"}): ${error instanceof Error ? error.message : String(error)}`));
    return false;
  }
  return choice === "continue" || choice === "none";
}

// Before a prompt: when files changed since the project's ./deploy (or ./run) last finished, a
// dialog asks Deploy, Continue or Cancel. Deploy does what the prompt "r" does and leaves the
// prompt unsent in the box. A failed check doesn't hold the prompt up.
async function deployOk(): Promise<boolean> {
  let check: { script: string; files: string[] };
  try {
    check = await post<{ script: string; files: string[] }>(props.tab, "deployNeeded", {});
  } catch (error) {
    // An older backend answers this unknown action with "No such session.": a sign it needs a deploy.
    report(new Error(`Couldn't check whether ${props.tab.label} needs a deploy (the prompt is sent anyway): ${error instanceof Error ? error.message : String(error)}`));
    return true;
  }
  if (!check.files.length) return true;
  const list = check.files.slice(0, 10).join("\n") + (check.files.length > 10 ? `\n... and ${check.files.length - 10} more` : "");
  deployText.value = `${props.tab.label} needs a deploy: ${check.files.length} file(s) changed since ./${check.script} last ran.\n\n${list}`;
  const dialog = deployPopEl.value!;
  dialog.returnValue = "";
  dialog.showModal();
  await new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
  if (dialog.returnValue === "deploy") void runScript(false, false);
  return dialog.returnValue === "continue";
}

// Before a prompt to a session with turns: when HEAD was committed after its last prompt, the
// conversation is likely about work that's done, so a dialog asks New session (this prompt
// starts one), Continue (send it here) or Cancel. A failed check doesn't hold the prompt up.
// snips: the Snips' text sent straight from an empty box, which nobody looked at the conversation
// for, so any turns at all ask the same question, commit or not.
async function commitChoice(snips = false): Promise<"new" | "continue" | ""> {
  const last = turns().at(-1);
  if (!last) return "continue";
  if (snips) {
    commitText.value = `${props.tab.label}: this conversation already has prompts. Send the Snips' text to it, or start a new session with it?`;
  } else {
    let head: { at: number; subject: string };
    try {
      head = await post<{ at: number; subject: string }>(props.tab, "lastCommit", {});
    } catch (error) {
      report(new Error(`Couldn't check ${props.tab.label} for a commit since this conversation's last prompt (the prompt is sent anyway): ${error instanceof Error ? error.message : String(error)}`));
      return "continue";
    }
    if (head.at <= last.createdAt) return "continue";
    commitText.value = `${props.tab.label}: a commit was made after this conversation's last prompt.\n\n${head.subject}`;
  }
  const dialog = commitPopEl.value!;
  dialog.returnValue = "";
  dialog.showModal();
  await new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
  return dialog.returnValue as "new" | "continue" | "";
}

// The Run button is highlighted while that same check finds changed files. Re-read like the Git
// button's count, open or closed (for the Tabs button), on show or not, and after a ./run, which resets the check.
const deployDue = ref(false);
watch(deployDue, (due) => emit("deployDue", due));
let deployTimer = 0;
function checkDeploySoon(): void {
  window.clearTimeout(deployTimer);
  deployTimer = window.setTimeout(() => {
    post<{ files: string[] }>(props.tab, "deployNeeded", {}).then(
      ({ files }) => (deployDue.value = files.length > 0),
      () => (deployDue.value = false),
    );
  }, 300);
}
watch(() => [props.active, props.version], checkDeploySoon, { immediate: true });

async function submit(text = draft.value, keepDraft = false, snips = false): Promise<void> {
  if ((text.trim() === "r" || text.trim() === "v") && !keepDraft) {
    draft.value = "";
    return runScript(text.trim() === "v");
  }
  // Pictures or files alone are a prompt, not an empty box.
  if ((!text.trim() && (keepDraft || (!images().length && !attached().length))) || (props.session?.trashed ?? false)) return;
  // The checks before a send take a few round trips and the box keeps its text until they pass, so
  // a second Ctrl+Enter meanwhile would send the same prompt again.
  if (sending) return;
  sending = true;
  try {
    await send(text, keepDraft, snips);
  } finally {
    sending = false;
  }
}
let sending = false;

async function send(text: string, keepDraft: boolean, snips: boolean): Promise<void> {
  if (!keepDraft && !(await deploySetupOk())) return;
  if (!keepDraft && !(await deployOk())) return;
  const choice = keepDraft ? "continue" : await commitChoice(snips);
  if (!choice) return;
  const fresh = !props.session || choice === "new";
  // Sending during a run stops that run and takes this prompt instead; a run waiting on a
  // background task takes it as a follow-up.
  if (!fresh && props.status?.active && props.status.phase !== "background" && !window.confirm("Stop the running response and send this prompt instead?")) return;
  if (!keepDraft) draft.value = "";
  // Every waiting picture and file rides with this prompt; a failed send puts them back.
  const key = sessionKey();
  const sending = keepDraft ? [] : images();
  const sendingFiles = keepDraft ? [] : attached();
  if (sending.length) {
    delete waiting[key];
    storeImages();
  }
  if (sendingFiles.length) {
    delete waitingFiles[key];
    storeFiles();
  }
  pendingTurnCount = fresh ? 1 : turns().length + 1;
  try {
    const { sessionId } = await post<{ sessionId: string }>(props.tab, "prompt", { sessionId: fresh ? "" : props.session!.id, prompt: text, images: sending.map((stack) => stack.at(-1)), files: sendingFiles });
    if (fresh) {
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
    if (sendingFiles.length) {
      waitingFiles[key] = [...sendingFiles, ...(waitingFiles[key] ?? [])];
      storeFiles();
    }
    report(new Error(`Prompt not sent: ${error instanceof Error ? error.message : String(error)}`));
  }
}

// Ctrl+Enter in the prompt box. An empty one (no text, pictures or files) takes the last bar's prompt as
// ordinary text to edit and send; left as it came, it isn't sent again: Ctrl+Enter only clears it.
function sendKey(): void {
  if (props.session?.trashed) return;
  const last = turns().at(-1);
  const lastText = last ? untab(typedText(last)) : "";
  if (!images().length && !attached().length) {
    if (!draft.value.trim()) return void (draft.value = lastText);
    if (lastText.trim() && draft.value.trim() === lastText.trim()) return void (draft.value = "");
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
  const both = event.ctrlKey && event.altKey;
  const index = both ? -1 : imageCharAt(event);
  const fileIndex = both ? -1 : fileCharAt(event);
  if (index < 0 && fileIndex < 0 && !both) return;
  event.preventDefault();
  event.stopPropagation();
  if (fileIndex >= 0) return event.ctrlKey ? deleteWaitingFile(fileIndex) : showFile(attached()[fileIndex]!);
  if (index >= 0) return event.ctrlKey ? deleteWaitingImage(index) : showWaitingImage(index);
  setBigPrompt(!bigPrompt.value);
  promptBox?.focus();
}
function onPromptMouse(event: MouseEvent): void {
  if ((!event.ctrlKey || !event.altKey) && imageCharAt(event) < 0 && fileCharAt(event) < 0) return;
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
// The files (the File button) waiting on each session's next prompt, kept as the pictures are,
// their bytes as data URIs. A <file> mark in the box stands for each.
type WaitingFile = AttachedFile & { dataUri: string };
const FILE = "<file>";
const filesKey = (): string => `files:${props.tab.id}`;
let waitingFiles: Record<string, WaitingFile[]> = {};
void loadWaiting<Record<string, WaitingFile[]>>(filesKey()).then((stored) => {
  waitingFiles = stored;
  showImageChars();
}, report);
const attached = (): WaitingFile[] => waitingFiles[sessionKey()] ?? [];
function storeFiles(): void {
  showImageChars();
  saveWaiting(filesKey(), waitingFiles).catch(report);
}

// The icons, then the <file> marks, lead the box's first line as injected text: drawn there but not
// part of the text, so typing, the caret and the draft never touch them. Set again on every edit, or
// one at the very start would carry them along with the text it moved.
let imageChars: monaco.editor.IEditorDecorationsCollection | null = null;
// The pictures waiting on the next prompt.
const boxImageCount = (): number => images().length;
function showImageChars(): void {
  const count = boxImageCount();
  const fileCount = attached().length;
  const cursorStops = monaco.editor.InjectedTextCursorStops.Right;
  // An empty range: without showIfCollapsed Monaco keeps the decoration but never draws it. The marks
  // are its after, which Monaco draws after its before at the same column.
  imageChars?.set(count || fileCount ? [{ range: new monaco.Range(1, 1, 1, 1), options: { showIfCollapsed: true,
    ...(count ? { before: { content: IMG.repeat(count), inlineClassName: "img-char", cursorStops } } : {}),
    ...(fileCount ? { after: { content: FILE.repeat(fileCount), inlineClassName: "file-char", cursorStops } } : {}) } }] : []);
}
// Which icon or mark an event in the prompt box is on, or -1. Each kind is one injected span, its
// marks all one width.
function markAt(event: MouseEvent, selector: string, count: number): number {
  const span = (event.target as HTMLElement).closest?.(selector);
  if (!span || !count || event.button) return -1;
  const box = span.getBoundingClientRect();
  const index = Math.floor((event.clientX - box.left) / (box.width / count));
  return index >= 0 && index < count ? index : -1;
}
const imageCharAt = (event: MouseEvent): number => markAt(event, ".img-char", boxImageCount());
const fileCharAt = (event: MouseEvent): number => markAt(event, ".file-char", attached().length);

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

// ---- files: the File button, its picker, and a mark's details ----

const filePicker = ref<InstanceType<typeof FolderPicker>>();
let fileHost: HostName = "wsl";
// The picker opens on the project's host at its folder; a ctrl-click opens it on the Windows PC.
function pickFile(event: MouseEvent): void {
  fileHost = event.ctrlKey ? "win" : props.tab.host;
  filePicker.value!.open(event.ctrlKey ? "C:\\Users\\mark" : props.tab.path, fileHost);
}
// A picture joins the prompt as a screenshot does (a PNG, shown for cropping); text or a PDF as a
// <file> mark. The backend refuses anything else, and its reason shows in a dialog. The host is the
// picker's, or the one given: the Files tree's Ctrl+Enter adds its selected file. Once added the
// focus is in the prompt box, set before the picture's dialog opens, which hands it back there.
async function attach(file: string, host: HostName = fileHost): Promise<void> {
  if (props.session?.trashed) return;
  const key = sessionKey();
  try {
    const { kind, dataUri, ...details } = await postHost<{ name: string; path: string; size: number; mtime: number; kind: AttachedFile["kind"] | "image"; dataUri: string }>(host, "attachFile", { path: file });
    if (kind === "image") await addPictures(key, [dataUri]);
    else {
      (waitingFiles[key] ??= []).push({ ...details, kind, host, dataUri });
      storeFiles();
      focusPrompt();
    }
  } catch (error) {
    report(new Error(`File not added: ${error instanceof Error ? error.message : String(error)}`));
  }
}
// Pictures join the session's prompt as PNGs, the last shown for cropping, with the focus put back
// in the prompt box first, since the dialog hands it back to whatever had it.
async function addPictures(key: string, dataUris: string[]): Promise<void> {
  for (const dataUri of dataUris) (waiting[key] ??= []).push([await asPng(dataUri)]);
  storeImages();
  await nextTick();
  focusPrompt();
  if (key === sessionKey()) showWaitingImage(images().length - 1);
}
// Files pasted in the prompt box or dropped on the pane (from Explorer) are added as File adds
// them: pictures for cropping, PDFs and UTF-8 text as <file> marks (no path is given a page, so
// the name stands for it, on win, where the clipboard and Explorer are), anything else (a folder
// too) refused in a dialog.
async function addFiles(files: File[]): Promise<void> {
  const key = sessionKey();
  const pictures: string[] = [];
  const refused: string[] = [];
  for (const file of files) {
    try {
      const { kind, dataUri } = await pastedFile(file);
      if (kind === "image") pictures.push(dataUri);
      else (waitingFiles[key] ??= []).push({ name: file.name, path: file.name, host: "win", size: file.size, mtime: file.lastModified, kind, dataUri });
    } catch (error) {
      refused.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  storeFiles();
  try {
    if (pictures.length) await addPictures(key, pictures);
    else focusPrompt();
  } catch (error) {
    refused.push(`A picture: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (refused.length) report(new Error(`Not added:\n${refused.join("\n")}`));
}
// Ctrl-V with files on the clipboard (a copied picture, or files copied in Explorer). A clipboard
// with text pastes the text as before: Excel's cells come with a picture of them. Capture phase,
// ahead of Monaco and its untab paste.
function pasteFiles(event: ClipboardEvent): void {
  const files = [...(event.clipboardData?.files ?? [])];
  if (!files.length || event.clipboardData!.getData("text/plain") || props.session?.trashed) return;
  event.preventDefault();
  event.stopPropagation();
  void addFiles(files);
}
// Files dragged anywhere over the pane are taken, so the browser never opens one in place of the
// page, and Monaco never sees the drag, which would insert their names. Capture phase. Dropped
// on a trashed session they are ignored.
function dragFiles(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = props.session?.trashed ? "none" : "copy";
  if (event.type === "drop" && !props.session?.trashed) void addFiles([...event.dataTransfer.files]);
}
// attachFile's test, for a pasted or dropped file: 20MB at most, and a picture, a PDF or UTF-8 text.
async function pastedFile(file: File): Promise<{ kind: AttachedFile["kind"] | "image"; dataUri: string }> {
  if (file.size > 20_000_000) throw new Error(`${file.size.toLocaleString()} bytes, over the 20,000,000 a prompt can take.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isText = (): boolean => {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return !bytes.includes(0);
    } catch {
      return false;
    }
  };
  const kind = file.type.startsWith("image/") ? "image" : new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-" ? "pdf" : isText() ? "text" : "";
  if (!kind) throw new Error("only text, PDF and picture files can be added to a prompt.");
  const type = kind === "image" ? file.type : kind === "pdf" ? "application/pdf" : "text/plain";
  const dataUri = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([file], { type }));
  });
  return { kind, dataUri };
}
// Every picture goes to the CLI as a PNG.
async function asPng(dataUri: string): Promise<string> {
  if (dataUri.startsWith("data:image/png;")) return dataUri;
  const image = new Image();
  image.src = dataUri;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d")!.drawImage(image, 0, 0);
  return canvas.toDataURL("image/png");
}
function deleteWaitingFile(index: number): void {
  const key = sessionKey();
  waitingFiles[key]!.splice(index, 1);
  if (!waitingFiles[key]!.length) delete waitingFiles[key];
  storeFiles();
}
const filePopEl = ref<HTMLDialogElement>();
const fileText = ref("");
// A mark's file: where it came from, never its text.
function showFile(file: AttachedFile): void {
  fileText.value = [
    file.name,
    `${file.kind === "pdf" ? "PDF" : "Text"}, ${file.size.toLocaleString()} bytes, modified ${new Date(file.mtime).toLocaleString()}`,
    `On ${file.host}: ${file.path}`,
    ...(file.stored ? [] : [`Waiting on the next prompt. Ctrl-click its ${FILE} to remove it.`]),
  ].join("\n");
  if (props.active) filePopEl.value!.showModal();
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
    turns: live ? live.turns : last?.turns ?? 0,
    graftSaved: props.session?.graftSavedUsd ?? 0,
    pony: skips,
    spend: quotaSpend(quotaUse.value, now.value),
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

// ---- wiring ----

let switchedFrom: string | null = null;
watch(
  () => [props.session?.id ?? "", props.version] as const,
  ([id]) => {
    if (id !== switchedFrom) {
      // Another session in the pane: its own draft, picks and a fresh view.
      if (switchedFrom !== null) drafts.set(switchedFrom, draft.value);
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
      searchHit = null;
      bigPrompt.value = localStorage.getItem(bigKey(id)) === "1";
      setPromptMarkdown(false);
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
watch(() => props.search, () => {
  searchHit = null;
  render();
});
watch(() => props.active, (on) => on && paintSearchHit());
watch(draft, (text) => {
  if (promptBox && promptBox.getValue() !== text) promptBox.setValue(untab(text));
  const key = draftKey(props.session?.id ?? "");
  if (text) localStorage.setItem(key, text);
  else localStorage.removeItem(key);
});
// A trashed session's box is read-only until the session is restored.
function lockPrompt(): void {
  promptBox?.updateOptions({
    readOnly: props.session?.trashed ?? false,
    readOnlyMessage: { value: "This session is in the trash. Restore it to send a prompt." },
  });
}
watch(() => props.session?.trashed, lockPrompt);

let ticker = 0;
let resize: ResizeObserver | null = null;

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
  const waitingRun = sessionStorage.getItem(runIdKey());
  if (waitingRun !== null) {
    runLive = true;
    runState = "going";
    void awaitRun(waitingRun);
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
  window.addEventListener("focus", checkDeploySoon);
});
onBeforeUnmount(() => {
  window.removeEventListener("focus", checkDeploySoon);
  window.clearInterval(ticker);
  resize?.disconnect();
  window.removeEventListener("keydown", onPageKey, true);
  promptBox?.dispose();
});
</script>

<template>
  <div class="pane" :class="{ 'big-prompt-editor': bigPrompt }" @click.capture="copyCodeBlock" @dragenter.capture="dragFiles" @dragover.capture="dragFiles" @drop.capture="dragFiles">
    <div ref="historyEl" class="history" tabindex="-1" data-help="history" data-mode="history" @wheel="zoom"></div>
    <dialog ref="runPopEl" closedby="any" class="run-pop" @close="runClosed">
      <pre>{{ runText }}</pre>
      <form method="dialog" data-help="run output"><button autofocus>OK</button></form>
    </dialog>
    <dialog ref="runErrorEl" closedby="any" class="run-pop run-error" @close="runErrorClosed">
      <pre>{{ runErrorText }}</pre>
      <form method="dialog" data-help="run error"><button autofocus>OK</button></form>
    </dialog>
    <dialog ref="deployPopEl" closedby="any" class="run-pop">
      <pre>{{ deployText }}</pre>
      <form method="dialog" data-help="deploy warning"><button value="deploy">Deploy</button> <button value="continue">Continue</button> <button value="" autofocus>Cancel</button></form>
    </dialog>
    <dialog ref="setupPopEl" closedby="any" class="run-pop">
      <pre>{{ setupText }}</pre>
      <form method="dialog" data-help="deploy setup"><button value="setup">{{ setupStarted ? "Set up again" : "Set up" }}</button> <button value="check" :autofocus="setupStarted">Check</button> <button value="none">Not needed</button> <button value="continue">Continue</button> <button value="" :autofocus="!setupStarted">Cancel</button></form>
    </dialog>
    <dialog ref="commitPopEl" closedby="any" class="run-pop">
      <pre>{{ commitText }}</pre>
      <form method="dialog" data-help="commit warning"><button value="new">New session</button> <button value="continue">Continue</button> <button value="" autofocus>Cancel</button></form>
    </dialog>
    <dialog ref="filePopEl" closedby="any" class="run-pop">
      <pre>{{ fileText }}</pre>
      <form method="dialog" data-help="file details"><button autofocus>OK</button></form>
    </dialog>
    <FolderPicker ref="filePicker" :host="tab.host" files @pick="attach" />
    <dialog ref="imagePopEl" closedby="any" class="img-pop" @close="popSrc = ''">
      <div class="img-title">
        <strong>{{ popLabel }}</strong>
        <span>{{ !popEditable ? "already sent, shown only" : popDepth ? "drag to crop, click to undo a crop" : "drag to crop" }}</span>
        <form method="dialog" data-help="image popup Close"><button autofocus>Close</button></form>
      </div>
      <div ref="popFrameEl" class="img-frame" data-help="image popup picture" :class="{ readonly: !popEditable }" @pointerdown="cropDown" @pointermove="cropMove" @pointerup="cropUp" @pointercancel="cropCancel">
        <img ref="popImageEl" :src="popSrc" alt="" draggable="false" />
        <div ref="popSelEl" class="img-sel" hidden></div>
      </div>
    </dialog>
    <div class="dock">
      <div ref="promptHostEl" class="prompt" data-help="prompt box" data-mode="prompt box" @pointerdown.capture="onPromptPointer" @mousedown.capture="onPromptMouse" @paste.capture="pasteFiles">
        <div v-show="!promptMarkdown"></div>
        <div v-show="promptMarkdown" ref="promptMdEl" class="prompt-md response markdown" tabindex="-1" data-help="prompt markdown view" data-mode="prompt markdown view" @keydown="onMdKey" v-html="promptHtml"></div>
      </div>
      <div class="dock-controls">
        <div class="footer">
          <div class="indicator finish" :class="pill.cls" :title="pill.title">{{ pill.text }}</div>
          <div class="group">
            <button class="stop" data-help="stop button" :class="{ stopping: stopping && active }" title="Stop" aria-label="Stop" :disabled="!active" @click="stop">&#x25AA;</button>
            <button title="Capture the screen for this prompt, hiding this window for the shot" data-help="Cap button" :disabled="capturing || session?.trashed" @mousedown.prevent @click="capture">Cap</button>
            <button title="Add a file to this prompt, picked on this project's host" data-help="footer File button" :disabled="session?.trashed" @mousedown.prevent @click="pickFile">File</button>
            <input type="checkbox" aria-label="bestModel" data-help="bestModel box" :title="modelChoice(session?.bestModel).title" :checked="!!session?.bestModel" :disabled="!session || session.trashed" @mousedown.prevent @change="setBestModel" />
          </div>
        </div>
        <div class="stats">
          <div class="status" title="Agentic turns in the last prompt">{{ stats.turns }}</div>
          <div class="status context" :class="{ over: contextUsed > compactAt }" title="Context used / where the CLI compacts it, in thousands of tokens" data-help="context stat" @click="compactNow">
            {{ Math.round((contextUsed || 0) / 1000) }}/{{ inK(compactAt) }}
          </div>
          <div v-if="stats.graftSaved > 0.25" class="status" title="What graft has saved this session">${{ stats.graftSaved.toFixed(2) }}</div>
          <div v-if="stats.spend" class="status spend" title="A plan window (5h, 7d or Fable) is at 95%: past 100% extra usage costs real dollars, and this shows the month's extra-usage spend">{{ stats.spend }}</div>
          <div v-else-if="stats.pony === 0 || ceilings === 0" class="status" title="Ponytail skips this session : ponytail comments in the project">{{ stats.pony }}:{{ ceilings }}</div>
          <div class="status" title="Time since anything new showed in the pane">{{ stats.quiet }}</div>
          <div class="status" title="Time spent responding in this session">{{ stats.duration }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
/* Ported from claude2's conversation pane. Not scoped: the history is built by script, and its
   elements carry no scope attribute. Font sizes stay in 14-18px and text is solid black (CLAUDE.md),
   except the history's ctrl-wheel size (--pane-font-size, 1em below it), at the user's asking. */
.pane { height: 100%; min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr) auto; background: var(--page); }
.pane > .history { grid-area: 1 / 1; }
.pane .dock { display: flex; align-items: stretch; gap: 10px; border-top: 1px solid var(--border); background: var(--page); padding: 8px 12px; }
.pane .dock-controls { display: flex; flex-direction: column; justify-content: flex-end; align-items: stretch; gap: 4px; flex: 0 1 auto; min-width: 0; margin-left: auto; }
.pane .dock-controls button { min-height: 0; padding: 3px 8px; }
/* contain: no long code line in a box sets the pane's minimum width; only the dock does (Project's grid). */
.pane .history { overflow-y: auto; overflow-x: hidden; min-height: 0; padding: 10px 12px 4px; outline: none; contain: inline-size; font-size: var(--pane-font-size, 14px); }
.pane .turn { margin-bottom: 4px; }
.pane .turn.selected .prompt-bar { outline: 2px solid #f28b82; outline-offset: -2px; }
.pane .prompt-bar { width: 100%; height: 1.65em; border: 1px solid #eadf90; background: var(--yellow); color: var(--ink); display: block; text-align: left; padding: 1px 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-radius: 4px; cursor: pointer; min-height: 0; font: inherit; }
.pane .prompt-bar:hover { background: linear-gradient(var(--wash), var(--wash)), var(--yellow); }
.pane .prompt-bar.prompt-expanded { height: auto; min-height: 1.65em; overflow: visible; text-overflow: clip; white-space: pre-wrap; }
.pane .prompt-bar.search-hit { background: #cfe8ff; border-color: #9cc4e8; }
.pane .bar-icon { display: inline-block; width: 1em; height: 1em; vertical-align: -0.15em; margin-right: 6px; border-radius: 3px; cursor: pointer; }
.pane .bar-icon:hover { background: var(--wash); }
.pane .bar-icon svg { display: block; width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.pane .response .search-line { background: #cfe8ff; }
::highlight(search-selection) { background-color: #ffc9c9; }
.pane .response { margin: 4px 0 8px; border-left: 3px solid var(--border); padding: 8px 10px; background: var(--surface); overflow-wrap: anywhere; overflow-x: hidden; }
.pane .response.error { border-left-color: #c62828; }
.pane .response.markdown { font: 1em/1.5 Aptos, "Segoe UI", sans-serif; white-space: normal; }
.pane .response.markdown > :first-child { margin-top: 0; }
.pane .response.markdown h1, .pane .response.markdown h2 { font-size: 1em; font-weight: 700; margin: 14px 0 6px; padding-bottom: 3px; border-bottom: 1px solid var(--border); }
.pane .response.markdown h3, .pane .response.markdown h4, .pane .response.markdown h5, .pane .response.markdown h6 { font-size: 1em; font-weight: 700; margin: 12px 0 5px; }
.pane .response.markdown p { margin: 0 0 8px; }
.pane .response.markdown ul, .pane .response.markdown ol { margin: 0 0 8px; padding-left: 24px; }
.pane .response.markdown li { margin: 2px 0; }
.pane .response.markdown li > ul, .pane .response.markdown li > ol { margin: 2px 0 0; }
.pane .response.markdown blockquote { margin: 0 0 8px; border-left: 3px solid var(--border); padding: 2px 10px; }
.pane .response.markdown hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
/* Above the closing answer: heavier than a markdown rule so the two never get confused. */
.pane .response.markdown hr.answer-rule { border-top: 2px solid #000; }
.pane .response.markdown a { color: var(--ink); }
.pane .response.markdown code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 1em; background: rgba(0,0,0,0.05); border-radius: 4px; padding: 1px 4px; }
.pane .response.markdown pre { background: #f2f1ec; border: 1px solid var(--border); border-radius: 8px; margin: 0 0 10px; padding: 8px 10px; overflow: auto; }
.pane .response.markdown pre code { background: none; padding: 0; white-space: pre; }
.pane .response.markdown table { border-collapse: collapse; margin: 0 0 10px; font-size: 1em; }
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
   script) from two lines to six, and still stretches to the controls' height beside it. Basis 0:
   in a narrow pane the controls keep their full width and the box takes what is left. */
.pane .prompt { position: relative; flex: 1 1 0; min-width: 180px; min-height: min(var(--content-h, 0px), 144px); max-height: 144px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
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
.pane .stats { display: flex; gap: 1ch; align-items: center; justify-content: flex-end; margin-left: 8px; margin-right: 5px; font-variant-numeric: tabular-nums; }
.pane .status { white-space: nowrap; }
.pane .context { cursor: pointer; }
.pane .context.over { background: #ffd0d0; border-radius: 4px; padding: 0 5px; margin: 0 -5px; }
.pane .spend { color: #c62828; font-weight: bold; }
/* Every dock control keeps a white fill. */
.pane .dock-controls button { background: #fff; }
.pane .dock-controls button:hover:not(:disabled) { background: #fff; border-color: #000; }
.pane .stop { display: inline-flex; align-items: center; justify-content: center; line-height: 1; color: #000; border-color: #000; }
/* Stop asks the CLI to finish the message it is on, so the run keeps streaming for a moment. */
.pane .stop.stopping:not(:disabled) { background: #ffd4d4; }
.pane .indicator { border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; font-weight: 700; white-space: nowrap; }
/* One letter at a fixed width, so the pill never resizes as the phase changes. */
.pane .finish { width: calc(2ch + 16px); flex: none; display: flex; align-items: center; justify-content: center; height: calc(1.45em + 6px); font-size: 16.8px; }
.pane .indicator.done { background: #fff; }
.pane .indicator.active { border-color: #e2a3a3; background: #fde0e0; }
.pane .indicator.active.waiting { border-color: #a5d6a7; background: #e3f6e4; }
/* The ./run result. */
/* The top is pinned, so a growing ./run log doesn't re-centre the dialog on every line. */
.pane .run-pop { margin-top: 10vh; max-width: 80vw; max-height: 80vh; padding: 12px 16px; border: 1px solid #000; border-radius: 8px; color: #000; font-size: 14px; }
.pane .run-pop pre { margin: 0 0 10px; white-space: pre-wrap; font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.pane .run-pop form { text-align: right; }
.pane .run-pop button { font-size: 14px; }
.pane .run-error { margin-top: 20vh; border: 3px solid #c00; }
/* The icons leading a prompt, one per picture, in the prompt box and on a bar. */
.pane .img-char { cursor: pointer; }
/* The marks after them, one per file. */
.pane .file-char { cursor: pointer; background: #dbe9ff; border-radius: 3px; }
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
</style>
