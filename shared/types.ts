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
}

export interface ClaudeSession {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  trashed: boolean;
  turns: ClaudeTurn[];
  // What graft has saved this session, as of its last finished turn. Absent until then.
  graftSavedUsd?: number;
  // The footer's bestModel box; see modelChoice. Absent is unchecked.
  bestModel?: boolean;
}

// What a session's turns run on, in every tab on every host. The CLI's "fable" alias is Fable 5.2.
// An advisor takes a model only: neither the CLI nor the API has an effort for it.
export const modelChoice = (bestModel: boolean | undefined) =>
  bestModel
    ? { model: "claude-fable-5-2", effort: "xhigh", advisor: "", title: "Fable 5.2 xhigh, no advisor" }
    : { model: "claude-opus-5-5", effort: "xhigh", advisor: "fable", title: "Opus 5.5 xhigh, advisor Fable 5.2" };

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
// on connect and at every change, and each project's events marked with its id.
export type StreamEvent = { type: "projects"; tabs: Tab[] } | { type: "auth"; needed: boolean } | (ServerEvent & { tab: string });

// One line of the Files tree.
export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
}
