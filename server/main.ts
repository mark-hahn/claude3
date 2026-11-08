// One claude3 backend: `node --experimental-strip-types server/main.ts <wsl|win|srv>`. It runs the
// claude CLI for the tabs whose host is this one, keeps their sessions, and streams them to the page.
//   GET  /events?tab=<label>   -> server-sent events (ServerEvent), the full state first
//   POST /api/<action>         body: { tab, sessionId?, ... } -> JSON
//        prompt  { prompt, model, effort, advisor } -> { sessionId } (an empty sessionId starts a session)
//        stop | rename { name } | trash { trashed } | picks { model, effort, advisor } | ctx -> { table }
//        new { keep } -> { session } (an empty "New session"; sweeps other empty ones, as discard does)
//        discard { keep } -> {} (drop every session with no turns, except the ids in keep)
//        run -> { output } (the project's ./run, the prompt box's "r")
//        deployNeeded -> { script, files } (project files changed since .deployed; see deployNeeded)
//        clean -> {} (every session to the trash) | git -> { files: [{ x, y, path }] } (git status)
//        commit { message } -> {} (add everything, commit, push)
//        snips { text? } -> { text } (claude2's Snips text, kept on claude2-stats; text saves it)
//        quota { force } -> { readAt, rows, state, apiCosts } (the Quotas pane; force is its Update)
//        quotaSync { readAt, error } -> { payload } (null when the pane already shows the newest)
//        speechmatics { month, rescan } -> { payload } (the tv project's Speechmatics spend)
//   GET  /version              -> the deployed version, the hash ./deploy wrote ("dev" in the repo)
//   GET  anything else         -> the built page in dist/, when there is one (the WSL backend's)
import { execFile, spawn } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { HOSTS, ORIGINS, TABS, type HostName, type Tab } from "../shared/config.ts";
import { ANSWER_MARK, DEFAULT_CONTEXT_WINDOW, type ClaudeSession, type ClaudeTurn, type ModelMap, type PonySkip, type RunningStatus, type ServerEvent } from "../shared/types.ts";
import { advisorFor, cheapestModel, ClaudeCliRunner, effortArgs, sanitizeModel, swapSessionTranscripts, type RunLimits } from "./claudeCli.ts";
import { contextTable } from "./contextStats.ts";
import { checkCosts, QuotaService, speechmaticsCost } from "./quota.ts";

const hostName = process.argv[2] as HostName;
const host = HOSTS[hostName];
if (!host) {
  console.error("usage: node --experimental-strip-types server/main.ts wsl|win|srv");
  process.exit(1);
}

// Sessions live here, outside the project folders, so no repo gets an untracked file and a
// redeploy of the backend leaves them alone.
const DATA_DIR = path.join(os.homedir(), ".claude3");
fs.mkdirSync(path.join(DATA_DIR, "sessions"), { recursive: true });
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
// ./deploy writes the hash of server/ and shared/ here; ./run compares it with the repo's.
const VERSION = (() => {
  try {
    return fs.readFileSync(path.join(ROOT, "version"), "utf8").trim();
  } catch {
    return "dev";
  }
})();
// claude2's Settings-pane values as the user has them. ponytail: fixed until a Settings pane exists.
const LIMITS: RunLimits = { maxTurns: 100, maxBudgetUsd: 0, permissionMode: "bypassPermissions" };

// Windows has no journal or pm2 log, so every host keeps its own file too.
function log(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  fs.appendFile(path.join(DATA_DIR, `${hostName}.log`), `${stamped}\n`, () => undefined);
}

const runner = new ClaudeCliRunner(log);

interface Project {
  tab: Tab;
  file: string;
  // Newest first, the sidebar's order.
  sessions: ClaudeSession[];
  clients: Set<ServerResponse>;
}

const projects = new Map<string, Project>();
for (const tab of TABS.filter((entry) => entry.host === hostName)) {
  const file = path.join(DATA_DIR, "sessions", `${tab.path.replace(/[^a-zA-Z0-9]/g, "-")}.json`);
  projects.set(tab.label, { tab, file, sessions: loadSessions(file), clients: new Set() });
}

function loadSessions(file: string): ClaudeSession[] {
  let sessions: ClaudeSession[];
  try {
    sessions = JSON.parse(fs.readFileSync(file, "utf8")) as ClaudeSession[];
  } catch {
    return [];
  }
  // A turn still open on load was cut off when this backend last stopped; its CLI died with it.
  for (const turn of sessions.flatMap((session) => session.turns)) {
    if (!turn.finished) {
      Object.assign(turn, { finished: true, completedAt: turn.completedAt ?? Date.now(), error: "The backend stopped during this response." });
    }
  }
  return sessions;
}

// Written whole, through a temp file, so a crash mid-write never leaves half a file.
// ponytail: the whole project on every save, sync; split per session if files grow large.
function save(project: Project): void {
  const temp = `${project.file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(project.sessions));
  fs.renameSync(temp, project.file);
}

function send(project: Project, event: ServerEvent): void {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of project.clients) {
    client.write(data);
  }
}

function sendSession(project: Project, session: ClaudeSession): void {
  send(project, { type: "session", session, status: runner.status(session.id) });
}

function statuses(project: Project): Record<string, RunningStatus> {
  const out: Record<string, RunningStatus> = {};
  for (const session of project.sessions) {
    const status = runner.status(session.id);
    if (status) {
      out[session.id] = status;
    }
  }
  return out;
}

// The CLI's model list, asked once at start and again until it answers.
let models: ModelMap = {};
async function loadModels(): Promise<void> {
  const cwd = [...projects.values()][0]?.tab.path ?? os.homedir();
  try {
    models = (await runner.listModels(cwd)).models;
    for (const project of projects.values()) {
      send(project, { type: "models", models });
    }
  } catch (error) {
    log(`Model list failed: ${errorText(error)}`);
    setTimeout(() => void loadModels(), 60000);
  }
}

// Each model's window as the CLI last reported it; until then the default.
const windows: Record<string, number> = {};
// The run in progress per session, so a new prompt can wait for a stopped one to settle.
const runs = new Map<string, Promise<void>>();
// One per backend; its token-refresh probe runs in DATA_DIR so no project gets its transcript.
const quota = new QuotaService(DATA_DIR, DATA_DIR, () => models, log);

async function submitPrompt(project: Project, body: Record<string, unknown>): Promise<{ sessionId: string }> {
  const prompt = String(body.prompt ?? "");
  const model = String(body.model ?? "");
  const effort = String(body.effort ?? "");
  // Only what the pickers showed runs: a missing or malformed model sends nothing.
  sanitizeModel(model);
  effortArgs(effort);
  const advisor = body.advisor === true ? advisorFor(model, models) : "";
  if (advisor) {
    sanitizeModel(advisor);
  }
  if (!prompt.trim()) {
    throw new Error("Empty prompt.");
  }
  let session = project.sessions.find((entry) => entry.id === body.sessionId);
  if (!session) {
    // The pane's draft (no card picked): the session exists from its first prompt on.
    session = { id: randomUUID(), name: firstWords(prompt), createdAt: Date.now(), updatedAt: Date.now(), trashed: false, model, effort, advisor: !!advisor, turns: [] };
    project.sessions.unshift(session);
  }
  if (!session.turns.length && !session.name) {
    session.name = firstWords(prompt);
  }
  if (session.trashed) {
    throw new Error("A trashed session takes no prompts.");
  }
  const id = session.id;
  // While the CLI waits on a background task the prompt joins that process instead; otherwise a
  // prompt sent during a run replaces it (the page asked first).
  if (!runner.canFollowUp(id, model, effort, advisor) && (runs.has(id) || runner.isRunning(id))) {
    runner.stop(id);
    await runs.get(id);
  }
  const run = runTurn(project, session, prompt, model, effort, advisor).catch((error) => log(`Turn failed: ${errorText(error)}`));
  runs.set(id, run);
  void run.finally(() => {
    if (runs.get(id) === run) {
      runs.delete(id);
    }
  });
  return { sessionId: id };
}

// Ported from claude2's runTurn, without images, files, stats, quota or notifications.
async function runTurn(project: Project, session: ClaudeSession, prompt: string, model: string, effort: string, advisor: string): Promise<void> {
  const workspacePath = project.tab.path;
  const wasFirstPrompt = session.turns.length === 0;
  // Context is a level: a run inherits where the last one that recorded one left off.
  const priorContext = session.turns.reduce((level, prior) => prior.contextUsed || (prior.cleared ? 0 : level), 0);
  const priorCost = session.turns.reduce((total, prior) => prior.cliCostTotal ?? total, 0);
  const turn: ClaudeTurn = {
    id: randomUUID(), prompt, response: "", createdAt: Date.now(), completedAt: null, model, modelId: "", effort, advisor,
    tokensIn: 0, tokensOut: 0, contextWindow: windows[model] ?? DEFAULT_CONTEXT_WINDOW, contextUsed: priorContext, cleared: false,
    finished: false, stopped: false, error: null, costUsd: null, cliCostTotal: null, stopReason: null, turns: 0,
    maxTurns: LIMITS.maxTurns, durationMs: 0, ponySkips: [],
  };
  Object.assign(session, { model, effort, advisor: !!advisor, updatedAt: Date.now() });
  session.turns.push(turn);
  save(project);
  sendSession(project, session);
  if (wasFirstPrompt) {
    void nameSession(project, session, prompt);
  }

  // Streaming is throttled: text collects for 80ms and goes out as one small delta, not a
  // whole-session post per token.
  let streamed = "";
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Set from the runner's callbacks; an object so the narrowing after `await` doesn't pin it to null.
  const last: { status: RunningStatus | null; ponySkips: PonySkip[] } = { status: null, ponySkips: [] };
  const flush = (): void => {
    timer = null;
    send(project, { type: "delta", sessionId: session.id, turnId: turn.id, at: streamed.length - pending.length, delta: pending, status: last.status });
    pending = "";
  };
  const queue = (): void => {
    timer ??= setTimeout(flush, 80);
  };
  try {
    const result = await runner.runPrompt({
      sessionId: session.id,
      turnId: turn.id,
      prompt,
      model,
      effort,
      contextWindow: turn.contextWindow,
      compactWindow: null,
      workspacePath,
      hasPriorTurns: !wasFirstPrompt,
      priorContextTokens: priorContext,
      priorCostTotal: priorCost,
      limits: LIMITS,
      longTools: false,
      fastMode: false,
      advisor,
      promptSuggestions: false,
      onSuggestion: () => undefined,
      debugDir: path.join(DATA_DIR, "debug"),
      onText: (text) => {
        streamed += text;
        turn.response = streamed;
        pending += text;
        queue();
      },
      onStatus: (status) => {
        last.status = status;
        last.ponySkips = status.ponySkips.length ? status.ponySkips : last.ponySkips;
        queue();
      },
    });
    // After /clear this session goes on resuming its own id, so that transcript has to become the
    // cleared conversation. If the swap fails Claude keeps its context, and so does the gauge.
    const cleared = result.clearedInto !== null && swapSessionTranscripts(workspacePath, session.id, result.clearedInto);
    if (result.modelWindow) {
      windows[model] = result.modelWindow;
    }
    Object.assign(turn, {
      response: markAnswer(streamed || result.text, result.stopped ? "" : result.answer),
      completedAt: Date.now(),
      contextWindow: windows[model] ?? turn.contextWindow,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      contextUsed: result.contextTokens,
      cleared,
      finished: true,
      stopped: result.stopped,
      costUsd: result.costUsd,
      cliCostTotal: result.cliCostTotal,
      stopReason: result.stopReason,
      turns: result.turns,
      durationMs: result.durationMs,
      ponySkips: result.ponySkips,
      modelId: last.status?.modelId ?? "",
    });
  } catch (error) {
    const status = last.status;
    Object.assign(turn, {
      error: errorText(error),
      completedAt: Date.now(),
      contextUsed: status?.contextTokens || priorContext,
      durationMs: Math.max(0, Date.now() - turn.createdAt),
      ponySkips: last.ponySkips,
      turns: status?.turns ?? 0,
      modelId: status?.modelId ?? "",
      finished: true,
      stopped: false,
    });
  } finally {
    // A delta still queued after the closing post would re-append text the page already has.
    if (timer !== null) {
      clearTimeout(timer);
    }
    session.updatedAt = Date.now();
    save(project);
    sendSession(project, session);
  }
}

async function nameSession(project: Project, session: ClaudeSession, prompt: string): Promise<void> {
  try {
    const name = await runner.generateTitle(prompt, cheapestModel(models), project.tab.path);
    session.name = name;
    save(project);
    sendSession(project, session);
  } catch (error) {
    log(`Session naming failed: ${errorText(error)}`);
  }
}

// The Ctx popup's table: the transcript's counts with the CLI's own split of the fixed parts.
async function ctxTable(project: Project, session: ClaudeSession): Promise<unknown> {
  const model = session.turns.at(-1)?.model || session.model;
  let usage: Record<string, unknown> | null = null;
  try {
    usage = await runner.contextUsage({
      sessionId: session.id,
      workspacePath: project.tab.path,
      model,
      contextWindow: windows[model] ?? DEFAULT_CONTEXT_WINDOW,
      compactWindow: null,
      permissionMode: LIMITS.permissionMode,
      advisor: session.advisor && model ? advisorFor(model, models) : "",
    });
  } catch (error) {
    log(`Ctx: the CLI's context count failed: ${errorText(error)}`);
  }
  return { table: await contextTable(project.tab.path, session.id, usage) };
}

// claude2's sweep: a session "+" made that never got a prompt is scratch, dropped as soon as
// attention moves elsewhere. The page keeps the one it opens and any holding unsent text.
// ponytail: another page showing an empty session can lose it; per-client keeps if that matters.
function discardEmpty(project: Project, keep: string[]): void {
  const ids = project.sessions.filter((session) => !session.turns.length && !keep.includes(session.id) && !runs.has(session.id)).map((session) => session.id);
  if (!ids.length) {
    return;
  }
  project.sessions = project.sessions.filter((session) => !ids.includes(session.id));
  save(project);
  send(project, { type: "removed", ids });
}

async function action(name: string, body: Record<string, unknown>): Promise<unknown> {
  const project = projects.get(String(body.tab));
  if (!project) {
    throw new Error(`No tab ${JSON.stringify(body.tab)} on ${hostName}.`);
  }
  if (name === "prompt") {
    return await submitPrompt(project, body);
  }
  if (name === "git") {
    return { files: parseStatus(await git(project, "status", "--porcelain", "-z", "--untracked-files=all")) };
  }
  if (name === "commit") {
    return await commit(project, String(body.message ?? "").trim());
  }
  if (name === "run") {
    return { output: await runScript(project, body.restartVite === true) };
  }
  if (name === "deployNeeded") {
    return await deployNeeded(project);
  }
  if (name === "snips") {
    return await snips(body.text);
  }
  if (name === "quota") {
    const [history, apiCosts] = await Promise.all([quota.history(body.force === true), checkCosts(log)]);
    return { ...history, apiCosts };
  }
  if (name === "quotaSync") {
    return { payload: await quota.shared(Number(body.readAt) || 0, String(body.error ?? "")) };
  }
  if (name === "speechmatics") {
    return { payload: await speechmaticsCost(String(body.month ?? ""), body.rescan === true, log) };
  }
  if (name === "new" || name === "discard") {
    discardEmpty(project, Array.isArray(body.keep) ? body.keep.map(String) : []);
    if (name === "discard") {
      return {};
    }
    // Blank picks: the pane shows its defaults and the first prompt sends them.
    const session: ClaudeSession = { id: randomUUID(), name: "", createdAt: Date.now(), updatedAt: Date.now(), trashed: false, model: "", effort: "", advisor: true, turns: [] };
    project.sessions.unshift(session);
    save(project);
    sendSession(project, session);
    return { session };
  }
  if (name === "clean") {
    for (const entry of project.sessions.filter((session) => !session.trashed)) {
      runner.stop(entry.id);
      entry.trashed = true;
      sendSession(project, entry);
    }
    save(project);
    return {};
  }
  const session = project.sessions.find((entry) => entry.id === body.sessionId);
  if (!session) {
    throw new Error("No such session.");
  }
  switch (name) {
    case "stop":
      return { stopped: runner.stop(session.id) };
    case "ctx":
      return await ctxTable(project, session);
    case "rename":
      session.name = String(body.name ?? "").trim() || session.name;
      break;
    case "trash":
      session.trashed = body.trashed === true;
      break;
    case "picks":
      Object.assign(session, { model: String(body.model ?? ""), effort: String(body.effort ?? ""), advisor: body.advisor === true });
      break;
    default:
      throw new Error(`Unknown action ${name}.`);
  }
  save(project);
  sendSession(project, session);
  return {};
}

// The answer mark goes on its own line where the closing answer starts. The result repeats the
// final message's text, so the last place that text shows up in the stream is the start. With
// nothing above it (no tools ran) there is nothing to set it apart from, so no mark.
function markAnswer(text: string, answer: string): string {
  const head = answer.trim().slice(0, 200);
  const at = head ? text.lastIndexOf(head) : -1;
  if (at <= 0 || !text.slice(0, at).trim()) {
    return text;
  }
  return `${text.slice(0, at).trimEnd()}\n\n${ANSWER_MARK}\n\n${text.slice(at)}`;
}

function firstWords(text: string): string {
  const words = text.split(/\s+/).filter(Boolean).slice(0, 5).join(" ").replace(/[.,;:!?]+$/, "");
  return (words.length > 42 ? `${words.slice(0, 42).trimEnd()}…` : words) || "New session";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// git in the tab's project folder. With no terminal prompt, a push that wants a password fails
// instead of hanging on a question nobody can see.
// The project's ./run, its output combined. On WSL it runs as a transient systemd unit, outside
// claude3.service's cgroup: a restart of this backend (claude3's own ./run deploys) would
// otherwise kill it and whatever it leaves running. KillMode=process lets those outlive it.
// Done at the script's exit, not its pipes' close: a detached child may hold them open.
// restartVite sets RESTART_VITE=1 for it (the page's "v" prompt); claude3's ./run then restarts vite.
function runScript(project: Project, restartVite: boolean): Promise<string> {
  const cwd = project.tab.path;
  if (!fs.existsSync(path.join(cwd, "run"))) {
    return Promise.reject(new Error(`No ./run in ${cwd}.`));
  }
  const [command, ...args] = hostName === "wsl"
    ? ["systemd-run", "--quiet", "--collect", "--pipe", "--wait", "-p", "KillMode=process", "-p", `WorkingDirectory=${cwd}`, "-E", `PATH=${process.env.PATH}`, "-E", `HOME=${os.homedir()}`, ...(restartVite ? ["-E", "RESTART_VITE=1"] : []), "./run"]
    : ["./run"];
  log(`./run in ${cwd}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...(restartVite ? { RESTART_VITE: "1" } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const take = (chunk: Buffer): void => void (output = (output + chunk.toString()).slice(-20_000));
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill(), 300_000);
    child.on("error", (error) => (clearTimeout(timer), reject(error)));
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else reject(new Error(`./run failed (${signal ?? `exit ${code}`}):\n${output.trim()}`));
    });
  });
}

// Whether the project needs a deploy before a prompt: its ./deploy (or ./run when it has none)
// touches .deployed when it finishes, and any git-visible file newer than that is undeployed.
// A project with neither script, or no stamp yet, never needs one. ponytail: every file counts, docs included.
async function deployNeeded(project: Project): Promise<{ script: string; files: string[] }> {
  const cwd = project.tab.path;
  const script = ["deploy", "run"].find((name) => fs.existsSync(path.join(cwd, name))) ?? "";
  if (!script) return { script, files: [] };
  let stamp: number;
  try {
    stamp = fs.statSync(path.join(cwd, ".deployed")).mtimeMs;
  } catch {
    return { script, files: [] }; // never stamped: unknown, so no warning
  }
  const listed = (await git(project, "ls-files", "-z", "--cached", "--others", "--exclude-standard")).split("\0").filter(Boolean);
  const files = [...new Set(listed)].filter((file) => {
    try {
      return fs.statSync(path.join(cwd, file)).mtimeMs > stamp;
    } catch {
      return false;
    }
  });
  return { script, files };
}

function git(project: Project, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = { cwd: project.tab.path, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 120_000, maxBuffer: 20_000_000 };
    execFile("git", args, options, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args[0]}: ${(stderr || stdout || error.message).trim()}`));
      else resolve(stdout);
    });
  });
}

// `git status --porcelain -z`: "XY path" entries split by NULs (X the index, Y the work tree), a
// rename's or copy's entry followed by its old path.
function parseStatus(out: string): { x: string; y: string; path: string }[] {
  const files: { x: string; y: string; path: string }[] = [];
  const parts = out.split("\0");
  for (let at = 0; at < parts.length; at++) {
    const entry = parts[at] ?? "";
    if (entry.length < 4) continue;
    files.push({ x: entry.charAt(0), y: entry.charAt(1), path: entry.slice(3) });
    if ("RC".includes(entry.charAt(0))) at++;
  }
  return files;
}

// The Git popup's Commit: everything staged, committed, and pushed.
async function commit(project: Project, message: string): Promise<object> {
  if (!message) throw new Error("A commit message is needed.");
  await git(project, "add", "-A");
  await git(project, "commit", "-m", message);
  try {
    await git(project, "push");
  } catch (error) {
    throw new Error(`Committed, but the push failed. ${errorText(error)}`);
  }
  return {};
}

// claude2's Snips text lives on its stats server, so every claude2 window and every claude3 tab
// share one copy. null: claude2 hasn't moved its copy there yet, so nothing may be saved over it.
const SNIPS_URL = "http://hahnca.com:7301/snips";
async function snips(text: unknown): Promise<{ text: string | null }> {
  const saving = typeof text === "string";
  const res = await fetch(SNIPS_URL, {
    method: saving ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: saving ? JSON.stringify({ text }) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`claude2-stats ${res.status}: ${(await res.text()).slice(0, 200)}`);
  if (saving) return { text };
  const stored = ((await res.json()) as { text?: unknown }).text;
  return { text: typeof stored === "string" ? stored : null };
}

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const wanted = path.join(DIST, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
  // Unknown paths (and anything climbing out of dist) get the page itself, the SPA fallback.
  const file = wanted.startsWith(DIST + path.sep) && fs.existsSync(wanted) && fs.statSync(wanted).isFile() ? wanted : path.join(DIST, "index.html");
  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404).end("No built page here: run vite, or deploy dist/.");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" }).end(data);
  });
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      text += chunk;
      if (text.length > 5_000_000) {
        req.destroy(new Error("Body too large."));
      }
    });
    req.on("end", () => {
      try {
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const server = createServer((req, res) => {
  // Only the page's own origins, and only under this host's own names: a backend that runs
  // claude must not be reachable by whatever other website the browser has open.
  const origin = req.headers.origin;
  const hostHeader = (req.headers.host ?? "").replace(/:\d+$/, "");
  if ((origin && !ORIGINS.includes(origin)) || !host.names.includes(hostHeader)) {
    res.writeHead(403).end();
    return;
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "content-type" }).end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/version") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end(VERSION);
    return;
  }
  if (req.method === "GET" && url.pathname === "/events") {
    const project = projects.get(url.searchParams.get("tab") ?? "");
    if (!project) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(`data: ${JSON.stringify({ type: "state", sessions: project.sessions, statuses: statuses(project), models } satisfies ServerEvent)}\n\n`);
    project.clients.add(res);
    req.on("close", () => project.clients.delete(res));
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    readBody(req)
      .then((body) => action(url.pathname.slice(5), body))
      .then((result) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result)))
      .catch((error) => res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: errorText(error) })));
    return;
  }
  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }
  res.writeHead(405).end();
});

server.listen(host.port, host.bind, () => {
  log(`claude3 ${hostName} backend on ${host.bind}:${host.port} for ${[...projects.keys()].join(", ")}`);
  void loadModels();
});

// The CLI processes are children and go with the backend. Their turns keep the text streamed so
// far, marked cut off.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    runner.dispose();
    for (const project of projects.values()) {
      const open = project.sessions.flatMap((session) => session.turns).filter((turn) => !turn.finished);
      for (const turn of open) {
        Object.assign(turn, { finished: true, completedAt: Date.now(), error: "The backend stopped during this response." });
      }
      if (open.length) {
        save(project);
      }
    }
    process.exit(0);
  });
}
