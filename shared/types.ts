// Ported from claude2's src/types.ts: the session and turn records, and the marks the runner
// writes into a response for the pane to find.
import type { HostName, Tab } from "./config.ts";

export const DEFAULT_CONTEXT_WINDOW = 1000000;

// The CLI never lets the context reach the window: it holds back up to 20,000 tokens for the reply
// and a further 13,000 of headroom, and auto-compacts the conversation at what is left. That figure,
// not the window, is the ceiling the gauge is really counting towards.
export const COMPACT_RESERVE = 33000;

// U+2063 INVISIBLE SEPARATOR, prefixed to every tool-call line in a response. It is what the
// pane hides on: bold alone is not the tell, since the model opens its own prose with **bold**
// runs too. Zero width, so it shows as nothing wherever a response is read as plain text.
export const TOOL_LINE_MARK = "⁣";

// U+2062 INVISIBLE TIMES, after the tool mark on a tool line's detail lines: the call's long form,
// stored under its short line. A box shows them in the line's place when it is clicked.
export const TOOL_DETAIL_MARK = "⁢";

// A line of just this, put in when the run ends, is where the closing answer starts; the pane
// draws a rule there. Zero width like the tool mark, and a different character.
export const ANSWER_MARK = "⁤";

// The sentence each attached picture adds to the prompt, which is what gets the CLI to read it.
export const imageNote = (file: string): string => `[An image is attached. Read the image file ${file} to view it.]`;
// A file attached to a prompt by the footer's File (a picked image goes as a picture instead): where
// it was picked, and once sent, the copy the CLI reads, under ~/.claude3/files on the session's host.
export interface AttachedFile {
  name: string;
  host: HostName;
  path: string;
  size: number;
  mtime: number;
  kind: "text" | "pdf";
  stored?: string;
}
// The sentence each attached file adds to the prompt.
export const fileNote = (file: AttachedFile): string => `[A file is attached: ${file.path} on the ${file.host} host, copied to ${file.stored} when attached. Read that copy to view it.]`;
// A stored prompt as it was typed, without those sentences: a prompt bar draws icons for them.
// The screenshot wording is the old image note, still in older sessions' transcripts.
export const typedPrompt = (prompt: string): string => prompt.replace(/\n\n\[(?:An image|A screenshot of the user's desktop) is attached\. Read the image file [^\]]* to view it\.\]/g, "").replace(/\n\n\[A file is attached: .*? Read that copy to view it\.\]/g, "");

// What the CLI says when this host's Claude login is gone: claude2's test, plus its words for no login at all.
export const AUTH_FAILED = /failed to authenticate|oauth session expired|not logged in/i;
// Starts the error a backend gives when the claude command isn't there (spawn ENOENT).
export const CLI_MISSING = "Claude Code is not installed where this backend can find it.";

// One ponytail skip line out of a response: "skipped: <x>, add when <y>".
export interface PonySkip {
  x: string;
  y: string;
}

export type ClaudePhase = "thinking" | "writing" | "querying" | "working" | "compacting" | "background" | null;

// Model id -> its effort levels, as the CLI lists them.
export type ModelMap = Record<string, string[]>;

export interface ClaudeTurn {
  id: string;
  prompt: string;
  response: string;
  createdAt: number;
  completedAt: number | null;
  // The value sent with --model, as the CLI's model list gave it: often an alias like "opus[1m]".
  model: string;
  // What actually answered ("claude-opus-5-5"), read off the reply itself.
  modelId: string;
  effort: string;
  advisor: string;
  tokensIn: number;
  tokensOut: number;
  contextWindow: number;
  contextUsed: number;
  // /clear ran in this turn: Claude's context starts over here, so the gauge takes this turn's level, even 0.
  cleared: boolean;
  finished: boolean;
  stopped: boolean;
  error: string | null;
  costUsd: number | null;
  // The CLI's running cost for the whole session when this turn ended. A resumed CLI process
  // starts its total_cost_usd there, so the next turn's own cost is measured from it.
  cliCostTotal: number | null;
  stopReason: string | null;
  turns: number;
  maxTurns: number;
  durationMs: number;
  ponySkips: PonySkip[];
  // The pictures sent with this prompt: PNG files on the session's host, under ~/.claude3/images.
  images?: string[];
  // The files sent with this prompt.
  files?: AttachedFile[];
  // A plan turn: it ran in the CLI's plan mode (read-only), so its response is a plan.
  plan?: boolean;
  // The plan box was changed by hand after this plan turn: that ended the planning, so ticking the box
  // again never brings this plan back to wait for an answer.
  planClosed?: boolean;
}

export interface ClaudeSession {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  trashed: boolean;
  // The name of the deleted project this session was moved from: set, it is trashed for good (no
  // restore, no fork), only readable and deletable. Absent on every session made here.
  fromProject?: string;
  turns: ClaudeTurn[];
  // What graft has saved this session, as of its last finished turn. Absent until then.
  graftSavedUsd?: number;
  // The footer's bestModel box; see modelChoice. Absent is unchecked.
  bestModel?: boolean;
  // The footer's plan box: while checked every prompt is a plan turn (see modelChoice and awaitingPlan).
  planMode?: boolean;
}

// The CLI's model list: each value's effort levels, its Anthropic name and its resolved id.
export interface ModelList {
  models: ModelMap;
  names: Record<string, string>;
  ids: Record<string, string>;
}// The list plus the value the Settings pane's Models tab marked Default (a backend keeps it, and sends this to every page).
export type ModelPick = ModelList & { default: string };

// A host's own list value for the model a page picked from another host's list. Hosts' CLIs differ in
// version and name one model differently (Fable 5.2 is `fable` on one, `claude-fable-5-2` on another), and
// one name can be different models (`fable[1m]` is Fable 5.1 on an older CLI), so the id decides: the
// page's value when it is that model here too, else the first value here that resolves to the id.
export function ownModel(list: ModelList, model: string, id: string): string | undefined {
  if (model in list.models && (!id || list.ids[model] === id)) return model;
  return id ? Object.keys(list.models).find((value) => list.ids[value] === id) : undefined;
}

// A model value or id as shown on the page: no "claude-" prefix, no date suffix (a number past 100).
export const shortModel = (model: string) => model.replace(/^claude-/, "").replace(/-\d{3,}$/, "");

// Every family, weakest first: the order sortModels keeps the Models tab in.
const FAMILIES = ["haiku", "sonnet", "opus", "fable"];
// The families a run can climb, weakest first. Opus is the top: Fable is never anyone's "next better"
// and never plans, since on a Pro plan it always bills usage credits.
const LADDER = ["haiku", "sonnet", "opus"];
// A model's "next better" one is the newest of the next family up the LADDER the list has, by resolved
// version: an alias is the CLI's own pointer, named differently and lagging by host, and the list's
// order means nothing. With no list yet, the family's alias itself.
function nextBetter(value: string, models: ModelMap, ids: Record<string, string> = {}): string {
  const own = LADDER.findIndex((family) => value.includes(family));
  const listed = Object.keys(models);
  const pool = listed.length ? listed : LADDER;
  for (const family of own === -1 ? [] : LADDER.slice(own + 1)) {
    const hit = sortModels(pool.filter((id) => id.includes(family)), ids).at(-1);
    if (hit) return hit;
  }
  return "";
}
// The LADDER's top: the newest model of its highest family the list has, which a plan turn runs on
// whatever the Default is. With no list yet, the family's alias itself.
function topModel(models: ModelMap, ids: Record<string, string> = {}): string {
  const listed = Object.keys(models);
  const pool = listed.length ? listed : LADDER;
  for (const family of [...LADDER].reverse()) {
    const hit = sortModels(pool.filter((id) => id.includes(family)), ids).at(-1);
    if (hit) return hit;
  }
  return "";
}
// False when the Default is already the top, so the footer's bestModel box has nothing to choose.
export const hasBetter = (pick: ModelPick = { default: "sonnet", models: {}, names: {}, ids: {} }): boolean => nextBetter(pick.default, pick.models, pick.ids) !== "";

// The hosts whose CLI version is below the newest one shown. A "?" (the CLI wouldn't answer) or a host
// not heard from yet has no version to compare.
const compareVersions = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
export function olderCli(versions: Partial<Record<string, string>>): string[] {
  const known = Object.entries(versions).filter((entry): entry is [string, string] => /^\d+(\.\d+)*$/.test(entry[1] ?? ""));
  const newest = known.reduce((best, [, version]) => (compareVersions(version, best) > 0 ? version : best), "0");
  return known.filter(([, version]) => compareVersions(version, newest) < 0).map(([host]) => host);
}

// A list's values weakest first: by family, then version (read from the resolved id), then name, so
// an alias (`opus`) lands next to the id it resolves to. A family this doesn't know goes last.
export function sortModels(values: string[], ids: Record<string, string>): string[] {
  const key = (value: string) => {
    const id = ids[value] || value;
    const family = FAMILIES.findIndex((name) => id.includes(name));
    const [, major, minor] = id.match(/^claude-[a-z]+-(\d+)(?:-(\d{1,2})(?!\d))?/) ?? [];
    return [family === -1 ? FAMILIES.length : family, Number(major ?? 0), Number(minor ?? 0)];
  };
  return [...values].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a.localeCompare(b);
  });
}

// What a session's turns run on, in every tab on every host. Bestmodel unchecked: the Default model
// with the next better one as advisor; checked: the next better one alone (the Default itself when
// nothing is better). A plan turn (plan: the footer's plan box is checked) runs on the LADDER's top
// alone, with no advisor, whatever the other box says; the turn after its approval is an ordinary one.
// An advisor takes a model only: neither the CLI nor the API has an effort for it.
// Effort is xhigh where the model has it, else its highest below max; none for a model with no levels.
// Max is never used: it cost 2.3x xhigh for no better result.
export function modelChoice(bestModel: boolean | undefined, pick: ModelPick = { default: "sonnet", models: {}, names: {}, ids: {} }, plan = false) {
  const base = pick.default;
  const better = nextBetter(base, pick.models, pick.ids);
  const run = plan ? topModel(pick.models, pick.ids) || base : bestModel ? better || base : base;
  const advisor = plan || bestModel ? "" : better;
  const levels = pick.models[run]?.filter((level) => level !== "max");
  const effort = !levels || levels.includes("xhigh") ? "xhigh" : levels.at(-1) ?? "";
  const name = (value: string) => pick.names[value] || value;
  return { model: pick.ids[run] || run, effort, advisor, title: `${name(run)}${effort ? " " + effort : ""}, ${advisor ? "advisor " + name(advisor) : "no advisor"}` };
}

// What Enter on an empty prompt sends to approve a plan, and the line under a plan that waits for it.
export const PLAN_APPROVED = "The plan is approved. Implement it.";
export const PLAN_WAIT = "======= Response to this plan is needed =======";
// A plan waits for an answer while the plan box is still checked and the last turn was a plan turn that
// ended well. Typed text then makes another plan turn, Enter approves, unchecking the box ends the planning.
export function awaitingPlan(session: ClaudeSession | null | undefined): boolean {
  const last = session?.turns.at(-1);
  return !!session?.planMode && !!last?.plan && !last.planClosed && last.finished && !last.stopped && !last.error;
}

export interface RunningStatus {
  active: boolean;
  sessionId: string;
  turnId: string;
  turns: number;
  maxTurns: number;
  costUsd: number | null;
  contextTokens: number;
  ponySkips: PonySkip[];
  codeLines: number;
  phase: ClaudePhase;
  // When the conversation was last compacted in this run. Null until a compaction happens.
  compactedAt: number | null;
  elapsedMs: number;
  startedAt: number;
  // When the pane last got something visible to show, and how long ago that was as of the
  // snapshot, so the footer can show how long the response has looked stalled.
  lastEventAt: number;
  sinceEventMs: number;
  // The model id the API answered the main conversation with; empty until the first reply starts.
  modelId: string;
}

export interface ClaudeRunResult {
  stopped: boolean;
  text: string;
  tokensIn: number;
  tokensOut: number;
  contextTokens: number;
  costUsd: number | null;
  cliCostTotal: number | null;
  stopReason: string | null;
  turns: number;
  durationMs: number;
  ponySkips: PonySkip[];
  // The text of the last message, the one that ended the run: what the CLI's result repeats.
  answer: string;
  // /clear moved Claude's conversation to this new CLI session; null when nothing was cleared.
  clearedInto: string | null;
  // The context window the CLI reported for the main model; null when no result said.
  modelWindow: number | null;
}

// What a backend sends about one project.
export type ServerEvent =
  // On connect: everything the tab shows.
  | { type: "state"; sessions: ClaudeSession[]; statuses: Record<string, RunningStatus> }
  // One session changed shape (new, renamed, trashed, a turn started or settled).
  | { type: "session"; session: ClaudeSession; status: RunningStatus | null }
  // Streamed text, spliced in at `at` of the turn's response, plus the run's latest status.
  | { type: "delta"; sessionId: string; turnId: string; at: number; delta: string; status: RunningStatus | null }
  // Sessions gone for good (empty ones swept away).
  | { type: "removed"; ids: string[] }
  // How many "ponytail:" comments the project holds; on connect and when a turn ends.
  | { type: "ceilings"; count: number }
  // A prompt that never ran because the login had expired or the CLI couldn't start, for its session's box. Pictures as PNG data URIs, files with theirs.
  // notice: why, for a dialog (the CLI-missing case; an expired login has its own banner).
  | { type: "returned"; sessionId: string; prompt: string; images: string[]; files: (AttachedFile & { dataUri: string })[]; notice?: string };

// A backend's one event stream: its list of projects and whether its Claude login needs renewing,
// on connect and at every change, the model list and default likewise, the plan's use on connect and at each turn's end, and each project's events marked with its id.
export type StreamEvent = { type: "projects"; tabs: Tab[] } | { type: "auth"; needed: boolean } | { type: "quota"; use: QuotaUse } | { type: "modelPick"; pick: ModelPick } | (ServerEvent & { tab: string });

// The account's plan use from the backend's newest reading (one account behind every host): each
// window's (5h, 7d, Fable) percent and reset in epoch seconds, and the month's extra-usage spend.
export interface QuotaUse {
  at: number;
  windows: { pct: number | null; resetsAt: number | null }[];
  spentUsd: number | null;
}

// The footer's red spend in place of the ponytail stat: $0.00 once a window not yet reset is at 95%,
// where extra usage (real dollars) is next; past 100% the month's extra-usage spend. Null below 95%.
export function quotaSpend(use: QuotaUse | null, nowMs: number): string | null {
  const live = (use?.windows ?? []).filter((window) => window.resetsAt === null || window.resetsAt * 1000 > nowMs);
  const pct = Math.max(0, ...live.map((window) => window.pct ?? 0));
  return pct < 95 ? null : "$" + (pct >= 100 ? use!.spentUsd ?? 0 : 0).toFixed(2);
}

// One line of the Files tree.
export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
}
