// claude2's QuotaService (src/quota.ts), ported nearly verbatim for the Settings pane's Quotas tab.
// Left out: the footer's 95% alert (claude3 has no such stat yet) and claude2's Windows-side VS Code
// storage; the local history and meta files live in ~/.claude3 instead. The stats server on
// hahnca.com:7301 holds the account's one history and the lease, shared with every claude2 window.
import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { ModelMap } from "../shared/types.ts";
import { cheapestModel, childEnv } from "./claudeCli.ts";

export interface QuotaReadingRow {
  at: number;
  five_pct: number | null;
  five_resets: number | null;
  seven_pct: number | null;
  seven_resets: number | null;
  fable_pct: number | null;
  fable_resets: number | null;
  spent_usd: number | null;
  limit_usd: number | null;
}

export interface QuotaWindowState {
  key: "five" | "seven" | "model";
  label: string;
  pct: number | null;
  resetsAt: number | null;
}

export interface QuotaState {
  at: number | null;
  available: boolean;
  subscription: string | null;
  credits: { enabled: boolean; spentUsd: number | null; limitUsd: number | null } | null;
  windows: QuotaWindowState[];
  error: string | null;
  pausedUntil: number | null;
}

export interface QuotaHistoryPayload {
  readAt: number | null;
  rows: QuotaReadingRow[];
  state: QuotaState;
}

const usageUrl = "https://api.anthropic.com/api/oauth/usage";
const statsUrl = "http://hahnca.com:7301";
const oneMinuteMs = 60 * 1000;
const fifteenMinutesMs = 15 * 60 * 1000;
// The endpoint rate-limits the whole account (ten calls in five minutes draws a 429), so there is
// no background timer: a reading is taken when a Quotas pane opens or ticks, or on Update, and the
// stats server's lease shares one reading across every window.
const fetchTimeoutMs = 5000;
const sharedTimeoutMs = 3000;

interface HttpJsonResponse {
  statusCode: number;
  retryAfter: string | undefined;
  body: unknown;
  rawBody: string;
}

// claude2's pluginStats httpJson: null rather than a throw when the stats server is out.
export async function httpJson(method: string, urlPath: string, body: unknown, timeoutMs: number, log: (line: string) => void): Promise<Record<string, unknown> | null> {
  const fail = (reason: string): null => {
    log(`stats server: ${method} ${urlPath} failed — ${reason}`);
    return null;
  };
  try {
    const response = await fetch(`${statsUrl}${urlPath}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (response.status !== 200) {
      return fail(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return fail(`unparseable body (${text.length} bytes): ${text.slice(0, 200)}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return fail(`no response in ${timeoutMs}ms`);
    }
    const cause = (error as { cause?: NodeJS.ErrnoException }).cause;
    return fail(cause?.code ? `${cause.code} ${cause.message}` : String(error instanceof Error ? error.message : error));
  }
}

// Every month's Git changes check total (claude2's API-key spend), keyed YYYY-MM. Null when the server can't be reached.
export async function checkCosts(log: (line: string) => void): Promise<Record<string, { usd: number; count: number }> | null> {
  const reply = await httpJson("GET", "/checks", undefined, 3000, log);
  return reply && typeof reply.months === "object" && reply.months !== null ? reply.months as Record<string, { usd: number; count: number }> : null;
}

// The tv project's Speechmatics spend for a month (YYYY-MM, Los Angeles), which the stats server
// reads from tv-srvr; rescan skips the server's hourly copy.
export async function speechmaticsCost(month: string, rescan: boolean, log: (line: string) => void): Promise<{ usd: number; hrs: number; at: number | null; error: boolean } | null> {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`bad month ${JSON.stringify(month)}`);
  }
  const reply = await httpJson("GET", `/speechmatics/${month}${rescan ? "?rescan=1" : ""}`, undefined, 30000, log);
  return reply && typeof reply.usd === "number" && typeof reply.hrs === "number"
    ? { usd: reply.usd, hrs: reply.hrs, at: typeof reply.at === "number" ? reply.at : null, error: reply.error === true }
    : null;
}

export class QuotaService {
  private state: QuotaState = emptyState(null);
  private readings: QuotaReadingRow[] = [];
  private loaded = false;
  private inFlight: Promise<QuotaState> | null = null;
  private probeInFlight: Promise<void> | null = null;
  private lastReadAt = 0;
  private lastFailureReason: string | null = null;
  private pausedUntil = 0;
  private readonly dir: string;
  private readonly cwd: string;
  private readonly models: () => ModelMap;
  private readonly log: (line: string) => void;

  public constructor(dir: string, cwd: string, models: () => ModelMap, log: (line: string) => void) {
    this.dir = dir;
    this.cwd = cwd;
    this.models = models;
    this.log = log;
  }

  public async history(force: boolean): Promise<QuotaHistoryPayload> {
    await this.ensureLoaded();
    await this.read(force);
    return this.payload();
  }

  // An open Quotas pane asks every 30s so the panes of every window match. Never calls the usage
  // endpoint. Null when the pane already shows this reading and message.
  public async shared(paneReadAt: number, paneError: string): Promise<QuotaHistoryPayload | null> {
    await this.ensureLoaded();
    const meta = await httpJson("GET", "/quota/meta", undefined, sharedTimeoutMs, this.log);
    if (meta === null || (numberOf(meta.readAt) ?? 0) > this.lastReadAt || (numberOf(meta.pausedUntil) ?? 0) > this.pausedUntil) {
      await this.adoptShared();
    }
    if (this.pausedUntil > Date.now()) {
      this.state = { ...this.state, pausedUntil: this.pausedUntil, error: rateLimitedMessage(this.pausedUntil) };
    }
    const payload = this.payload();
    return (payload.readAt ?? 0) === paneReadAt && (payload.state.error ?? "") === paneError ? null : payload;
  }

  private payload(): QuotaHistoryPayload {
    return { readAt: this.lastReadAt || null, rows: [...this.readings].sort((left, right) => left.at - right.at), state: this.state };
  }

  public async read(force: boolean): Promise<QuotaState> {
    await this.ensureLoaded();
    await this.adoptShared();
    if (!force && this.lastReadAt && Date.now() - this.lastReadAt < oneMinuteMs) {
      return this.state;
    }
    if (this.inFlight) {
      if (!force) {
        return await this.inFlight;
      }
      await this.inFlight;
    }
    this.inFlight = this.takeReading(force).finally(() => {
      this.inFlight = null;
    });
    return await this.inFlight;
  }

  private async takeReading(force: boolean): Promise<QuotaState> {
    const now = Date.now();
    // Update (force) always tries the endpoint; a reading that succeeds ends the pause for everyone.
    if ((!force && this.pausedUntil > now) || !(await this.claim(force))) {
      const paused = this.pausedUntil > now;
      this.state = { ...this.state, pausedUntil: this.pausedUntil || null, error: paused ? rateLimitedMessage(this.pausedUntil) : this.state.error };
      return this.state;
    }
    try {
      const credentials = await this.credentials();
      if (credentials.expiresAt !== null && credentials.expiresAt <= now) {
        await this.probeQuotaRefresh();
      }
      const state = await this.fetchUsageAfterRefresh(false);
      this.state = state;
      this.lastReadAt = state.at ?? Date.now();
      this.lastFailureReason = null;
      this.pausedUntil = 0;
      await this.recordReading(state);
      await this.writeSharedMeta();
      return this.state;
    } catch (error) {
      this.noteFailure(error);
      this.state = { ...this.state, available: this.lastReadAt > 0, error: errorMessage(error), pausedUntil: this.pausedUntil || null };
      if (this.pausedUntil > Date.now()) {
        await this.sharePause();
      }
      return this.state;
    }
  }

  private async fetchUsageAfterRefresh(retried: boolean): Promise<QuotaState> {
    const credentials = await this.credentials();
    const response = await getJson(credentials.accessToken);
    if (response.statusCode === 429) {
      // Capped: the endpoint has asked for 8-11 hour waits yet answered fine within the hour.
      this.pausedUntil = Math.min(retryAfterMs(response.retryAfter), Date.now() + fifteenMinutesMs);
      this.log(`quota: 429 from usage endpoint, retry-after ${response.retryAfter ?? "(none)"}, pausing until ${new Date(this.pausedUntil).toLocaleTimeString()}`);
      throw new Error(rateLimitedMessage(this.pausedUntil));
    }
    if (response.statusCode === 401 && !retried) {
      await this.probeQuotaRefresh();
      return await this.fetchUsageAfterRefresh(true);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Claude usage endpoint returned ${response.statusCode}: ${response.rawBody.slice(0, 200)}`);
    }
    return reshapeUsage(response.body, Date.now());
  }

  private async credentials(): Promise<{ accessToken: string; expiresAt: number | null }> {
    const credentialsPath = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), ".credentials.json");
    const parsed = JSON.parse(await fs.readFile(credentialsPath, "utf8")) as unknown;
    const oauth = recordOf(recordOf(parsed)?.claudeAiOauth);
    const accessToken = stringOf(oauth?.accessToken);
    if (!accessToken) {
      throw new Error(`No Claude OAuth access token found in ${credentialsPath}.`);
    }
    return { accessToken, expiresAt: numberOf(oauth?.expiresAt) };
  }

  // A one-turn CLI run refreshes the expired OAuth token in .credentials.json.
  private async probeQuotaRefresh(): Promise<void> {
    if (this.probeInFlight) {
      await this.probeInFlight;
      return;
    }
    const model = cheapestModel(this.models());
    this.probeInFlight = new Promise<void>((resolve, reject) => {
      const child = spawn("claude", ["-p", "quota", "--model", model, "--max-turns", "1", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--tools", ""], {
        cwd: this.cwd,
        env: childEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let settled = false;
      let stderrText = "";
      const timeout = setTimeout(() => finish(new Error("Claude quota token refresh probe timed out.")), 20000);
      const finish = (error: Error | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        child.kill("SIGTERM");
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      child.stdout.on("data", () => finish(null));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrText += chunk;
      });
      child.on("error", (error) => finish(error));
      child.on("close", (exitCode) => finish(exitCode !== 0 ? new Error(stderrText.trim() || `Claude quota probe exited with code ${exitCode ?? "unknown"}.`) : null));
    }).finally(() => {
      this.probeInFlight = null;
    });
    await this.probeInFlight;
  }

  // The right to call the endpoint is leased: the server hands out one claim per five-minute cycle
  // and everyone else paints the winner's reading. Update skips the queue. An unreachable server
  // means no lease to be had: poll anyway.
  private async claim(force: boolean): Promise<boolean> {
    if (force) {
      return true;
    }
    const reply = await httpJson("POST", "/quota/claim", {}, sharedTimeoutMs, this.log);
    if (reply === null) {
      return true;
    }
    const pausedUntil = numberOf(reply.pausedUntil) ?? 0;
    if (pausedUntil > this.pausedUntil) {
      this.pausedUntil = pausedUntil;
    }
    return reply.poll === true;
  }

  // The server is the shared copy; the local meta file is what is left when it cannot be reached.
  private async fetchShared(): Promise<{ lastReadAt: number; pausedUntil: number; state: QuotaState | null; rows: QuotaReadingRow[] }> {
    const remote = await httpJson("GET", "/quota", undefined, sharedTimeoutMs, this.log);
    if (remote === null) {
      return { ...await this.readSharedMeta(), rows: [] };
    }
    const state = recordOf(remote.state);
    return {
      lastReadAt: numberOf(remote.readAt) ?? 0,
      pausedUntil: numberOf(remote.pausedUntil) ?? 0,
      state: state && Array.isArray(state.windows) ? state as unknown as QuotaState : null,
      rows: Array.isArray(remote.rows) ? remote.rows.map((row) => normalizeRow(row)).filter((row) => row !== null) : [],
    };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    this.readings = await readRows(this.historyPath());
    const newest = [...this.readings].sort((left, right) => right.at - left.at)[0];
    if (newest) {
      this.lastReadAt = newest.at;
    }
  }

  private async recordReading(state: QuotaState): Promise<void> {
    const row = rowFromState(state);
    const merged = new Map<number, QuotaReadingRow>((await readRows(this.historyPath())).map((reading) => [reading.at, reading]));
    for (const reading of this.readings) {
      if (!merged.has(reading.at)) {
        merged.set(reading.at, reading);
      }
    }
    this.readings = [...merged.values()].sort((left, right) => left.at - right.at);
    const newest = this.readings[this.readings.length - 1];
    let kept = false;
    if (!newest || rowChanged(newest, row) || row.at - newest.at >= 60 * 60 * 1000) {
      if (!this.readings.some((reading) => reading.at === row.at)) {
        this.readings.push(row);
      }
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(this.historyPath(), JSON.stringify(this.readings.sort((left, right) => left.at - right.at), null, 2), "utf8");
      kept = true;
    }
    // Told even when the row folded into the last one: readAt is what the lease counts from.
    await httpJson("POST", "/quota", { rows: kept ? [row] : [], readAt: row.at, state: this.state }, sharedTimeoutMs, this.log);
  }

  private async adoptShared(): Promise<void> {
    const shared = await this.fetchShared();
    // A reading newer than ours ends any pause we hold.
    if (shared.pausedUntil > this.pausedUntil || shared.lastReadAt > this.lastReadAt) {
      this.pausedUntil = shared.pausedUntil;
    }
    if (shared.rows.length) {
      const merged = new Map<number, QuotaReadingRow>(this.readings.map((row) => [row.at, row]));
      for (const row of shared.rows) {
        merged.set(row.at, row);
      }
      this.readings = [...merged.values()].sort((left, right) => left.at - right.at);
    }
    // Or no state yet: lastReadAt may come from the history file's newest row, often this very reading.
    if (shared.state && (shared.lastReadAt > this.lastReadAt || !this.state.windows.length)) {
      this.state = shared.state;
      this.lastReadAt = shared.lastReadAt;
    }
  }

  private async readSharedMeta(): Promise<{ lastReadAt: number; pausedUntil: number; state: QuotaState | null }> {
    try {
      const record = recordOf(JSON.parse(await fs.readFile(this.metaPath(), "utf8")));
      const state = recordOf(record?.state);
      return {
        lastReadAt: numberOf(record?.lastReadAt) ?? 0,
        pausedUntil: numberOf(record?.pausedUntil) ?? 0,
        state: state && Array.isArray(state.windows) ? state as unknown as QuotaState : null,
      };
    } catch {
      return { lastReadAt: 0, pausedUntil: 0, state: null };
    }
  }

  private async writeSharedMeta(): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(this.metaPath(), JSON.stringify({ lastReadAt: this.lastReadAt, pausedUntil: this.pausedUntil, state: this.state }), "utf8");
    } catch (error) {
      this.noteFailure(error);
    }
  }

  private async sharePause(): Promise<void> {
    try {
      const meta = await this.readSharedMeta();
      if (this.pausedUntil > meta.pausedUntil) {
        await fs.mkdir(this.dir, { recursive: true });
        await fs.writeFile(this.metaPath(), JSON.stringify({ lastReadAt: meta.lastReadAt, pausedUntil: this.pausedUntil, state: meta.state }), "utf8");
      }
      await httpJson("POST", "/quota", { pausedUntil: this.pausedUntil }, sharedTimeoutMs, this.log);
    } catch (error) {
      this.noteFailure(error);
    }
  }

  private historyPath(): string {
    return path.join(this.dir, "quota-history.json");
  }

  private metaPath(): string {
    return path.join(this.dir, "quota-meta.json");
  }

  private noteFailure(error: unknown): void {
    const reason = errorMessage(error);
    if (reason !== this.lastFailureReason) {
      this.lastFailureReason = reason;
      this.log(`Claude quota read failed: ${reason}`);
    }
  }
}

async function getJson(accessToken: string): Promise<HttpJsonResponse> {
  let response: Response;
  try {
    response = await fetch(usageUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" },
      signal: AbortSignal.timeout(fetchTimeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("Claude usage endpoint timed out.");
    }
    throw error;
  }
  const rawBody = await response.text();
  let body: unknown = null;
  try {
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    body = rawBody;
  }
  return { statusCode: response.status, retryAfter: response.headers.get("retry-after") ?? undefined, body, rawBody };
}

function reshapeUsage(body: unknown, at: number): QuotaState {
  const root = recordOf(body);
  return {
    at,
    available: true,
    subscription: stringOf(root?.subscription) || null,
    credits: creditsFrom(recordOf(root?.extra_usage)),
    windows: [windowFrom(recordOf(root?.five_hour), "five", "5h"), windowFrom(recordOf(root?.seven_day), "seven", "7d"), modelScopedWindow(root)],
    error: null,
    pausedUntil: null,
  };
}

function windowFrom(value: Record<string, unknown> | undefined, key: "five" | "seven", label: string): QuotaWindowState {
  return { key, label, pct: numberOrNull(value?.utilization), resetsAt: secondsFromIso(value?.resets_at) };
}

function modelScopedWindow(root: Record<string, unknown> | undefined): QuotaWindowState {
  const limits = Array.isArray(root?.limits) ? root.limits : [];
  for (const limit of limits) {
    const record = recordOf(limit);
    const displayName = stringOf(recordOf(recordOf(record?.scope)?.model)?.display_name);
    if (displayName) {
      return { key: "model", label: displayName, pct: numberOrNull(record?.percent), resetsAt: secondsFromIso(record?.resets_at) };
    }
  }
  return { key: "model", label: "Fable", pct: null, resetsAt: null };
}

function creditsFrom(value: Record<string, unknown> | undefined): QuotaState["credits"] {
  if (!value) {
    return null;
  }
  const divisor = 10 ** (numberOf(value.decimal_places) ?? 2);
  const spent = numberOf(value.used_credits);
  const limit = numberOf(value.monthly_limit);
  return { enabled: value.is_enabled === true, spentUsd: spent === null ? null : spent / divisor, limitUsd: limit === null ? null : limit / divisor };
}

function rowFromState(state: QuotaState): QuotaReadingRow {
  const find = (key: string): QuotaWindowState | undefined => state.windows.find((windowState) => windowState.key === key);
  const [five, seven, model] = [find("five"), find("seven"), find("model")];
  return {
    at: state.at ?? Date.now(),
    five_pct: five?.pct ?? null,
    five_resets: five?.resetsAt ?? null,
    seven_pct: seven?.pct ?? null,
    seven_resets: seven?.resetsAt ?? null,
    fable_pct: model?.pct ?? null,
    fable_resets: model?.resetsAt ?? null,
    spent_usd: state.credits?.spentUsd ?? null,
    limit_usd: state.credits?.limitUsd ?? null,
  };
}

const rowKeys = ["five_pct", "five_resets", "seven_pct", "seven_resets", "fable_pct", "fable_resets", "spent_usd", "limit_usd"] as const;

function rowChanged(left: QuotaReadingRow, right: QuotaReadingRow): boolean {
  return rowKeys.some((key) => left[key] !== right[key]);
}

function normalizeRow(value: unknown): QuotaReadingRow | null {
  const record = recordOf(value);
  const at = numberOf(record?.at);
  if (at === null) {
    return null;
  }
  const row = { at } as QuotaReadingRow;
  for (const key of rowKeys) {
    row[key] = numberOrNull(record?.[key]);
  }
  return row;
}

function emptyState(error: string | null): QuotaState {
  return { at: null, available: false, subscription: null, credits: null, windows: [], error, pausedUntil: null };
}

function rateLimitedMessage(until: number): string {
  return `Quota check returned 429 (too many checks, not your usage limit). Quota checking is paused until ${new Date(until).toLocaleTimeString()}; Update checks now.`;
}

function retryAfterMs(firstValue: string | undefined): number {
  if (!firstValue) {
    return Date.now() + fifteenMinutesMs;
  }
  const seconds = Number(firstValue);
  if (Number.isFinite(seconds)) {
    return Date.now() + Math.max(oneMinuteMs, seconds * 1000);
  }
  const dateMs = Date.parse(firstValue);
  if (Number.isFinite(dateMs)) {
    return Math.max(Date.now() + oneMinuteMs, dateMs);
  }
  return Date.now() + fifteenMinutesMs;
}

function secondsFromIso(value: unknown): number | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

async function readRows(filePath: string): Promise<QuotaReadingRow[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.map((row) => normalizeRow(row)).filter((row) => row !== null) : [];
  } catch {
    return [];
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : numberOf(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
