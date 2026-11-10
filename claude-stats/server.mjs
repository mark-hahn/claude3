#!/usr/bin/env node
// claude-stats: what claude3's backends on the three hosts share, kept in one place: the account's
// quota history and the lease on reading it, the Snips' text, and two spend figures for the Quotas
// pane. Runs on hahnca.com under pm2 as "claude-stats" (port 7313, data in
// ~/.claude-stats/data.json); `./deploy stats` puts it there. It began as claude2's claude2-stats,
// cut down to what claude3 calls, and shares nothing with it: its own port, process and data.
//
//   GET  /version                        -> the deployed version, the hash ./deploy wrote ("dev" in the repo)
//   GET  /quota                          -> { rows, readAt, pausedUntil, state }
//   GET  /quota/meta                     -> { readAt, pausedUntil } : open panes poll this every 30s
//   POST /quota   body: { rows?, readAt?, pausedUntil?, state? } -> merge a reading
//   POST /quota/claim                    -> { poll } : the right to call the usage endpoint
//   GET  /checks                         -> { months: { <YYYY-MM>: { usd, count } } } : the API key's spend as claude2 recorded it; nothing adds to it
//   GET  /snips                          -> { text } : the Snips' text ({} until first saved)
//   POST /snips  body: { text }          -> replace it
//   GET  /speechmatics/<YYYY-MM>[?rescan=1] -> { usd, hrs, at?, error? } : the tv project's Speechmatics spend
//
// The quota block is the account's one reading history. Anthropic's usage endpoint rate-limits
// per account, not per machine, so with a pane open on three hosts the fleet would spend its
// whole budget on itself. /quota/claim leases the right to poll: the check-and-set in it is
// atomic because node handles one request at a time, so any number of backends asking at once
// still yields exactly one poller per cycle. Everyone else reads the answer from GET /quota.
// ponytail: no auth — personal server on the LAN, low-value data; add a token header check if that changes.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const port = process.env.PORT === undefined ? 7313 : Number(process.env.PORT);
const dataDir = process.env.CLAUDE_STATS_DIR || path.join(os.homedir(), ".claude-stats");
const dataPath = path.join(dataDir, "data.json");
// ./deploy writes the hash of this folder beside the server; --if-stale compares it with the repo's.
let version = "dev";
try {
  version = fs.readFileSync(path.join(import.meta.dirname, "version"), "utf8").trim();
} catch {
  // run from the repo
}

// Freshness the lease counts from — a touch under the pane's five-minute timer, so a tick
// that lands a hair early still defers. claimedAt expires on its own: a backend that claims and
// then dies mid-read costs one skipped cycle, not a stuck fleet.
const quotaFreshMs = 4.5 * 60 * 1000;
const quotaClaimMs = 30 * 1000;
const emptyQuota = { rows: [], readAt: 0, pausedUntil: 0, claimedAt: 0, state: null };

let data = { quota: { ...emptyQuota }, checks: {}, speechmatics: {}, snips: null };
try {
  // The first data.json is a copy of claude2-stats'; what claude3 never used of it goes at the next save.
  const saved = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  data = { quota: { ...emptyQuota, ...(saved.quota || {}) }, checks: saved.checks || {}, speechmatics: saved.speechmatics || {}, snips: typeof saved.snips === "string" ? saved.snips : null };
} catch {
  // first run, or an unreadable file: start empty
}

function save() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(dataPath + ".tmp", JSON.stringify(data, null, 2));
  fs.renameSync(dataPath + ".tmp", dataPath);
}

function numberOf(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

// Rows are identified by their timestamp, so a replayed push is idempotent. readAt and pausedUntil
// only ever move forward: a client with a slow clock can neither re-arm a spent lease nor cut short
// someone else's 429 pause. Only a newer reading ends a pause.
function mergeQuota(body) {
  const quota = data.quota;
  const incoming = Array.isArray(body.rows) ? body.rows : [];
  if (incoming.length) {
    const byAt = new Map(quota.rows.map((row) => [row.at, row]));
    for (const row of incoming) {
      if (row && typeof row === "object" && typeof row.at === "number" && Number.isFinite(row.at)) {
        byAt.set(row.at, row);
      }
    }
    quota.rows = [...byAt.values()].sort((left, right) => left.at - right.at);
  }
  quota.pausedUntil = Math.max(numberOf(quota.pausedUntil), numberOf(body.pausedUntil));
  const readAt = numberOf(body.readAt);
  if (readAt > numberOf(quota.readAt)) {
    quota.readAt = readAt;
    // A reading that got through (an Update click overrides the pause) shows the endpoint answers again.
    quota.pausedUntil = 0;
    // The state travels with the reading that produced it: a row carries percentages, but not the
    // subscription or window labels the pane needs before its first local reading lands.
    if (body.state && typeof body.state === "object") {
      quota.state = body.state;
    }
  }
}

function readBody(request, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      text += chunk;
      if (text.length > limit) {
        reject(new Error("body too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(text));
    request.on("error", reject);
  });
}

// The tv project's ASR runs on Speechmatics, and tv-srvr on this box keeps the job record: it
// answers audio hours per Los Angeles day of a month. Every answer costs tv-srvr a walk of
// Speechmatics' job list, which is rate-limited per account and shared with tv's own ASR -- a
// pane re-asking every five minutes drew 429s. So panes never reach tv-srvr directly: a
// past month is asked once and kept in data.json, the current month at most hourly, a failure
// holds off asking again for half an hour (the last figure is served meanwhile, flagged as an
// error until a read succeeds), and concurrent asks share one request. A rescan -- the quota
// pane's Update button, pressed by hand -- asks tv-srvr regardless. A month not yet kept also
// answers when it was last read. The price is tv's ASR_USD_PER_HOUR.
const tvAsrCostUrl = "http://127.0.0.1:8739/api/asr/cost";
const speechmaticsUsdPerHour = 0.38;
const speechmaticsFreshMs = 60 * 60 * 1000;
const speechmaticsRetryMs = 30 * 60 * 1000;
// month -> { result, at, failedAt, error, pending } for months not yet kept in data.json
const speechmaticsLive = {};

async function speechmatics(month, rescan) {
  if (data.speechmatics[month]) return data.speechmatics[month];
  const entry = (speechmaticsLive[month] ||= { result: null, at: 0, failedAt: 0, error: "", pending: null });
  const now = Date.now();
  const fresh = entry.result && now - entry.at < speechmaticsFreshMs;
  const holding = !entry.pending && now - entry.failedAt < speechmaticsRetryMs;
  if (rescan || !(fresh || holding)) {
    entry.pending ||= askTvAsrCost(month).then((result) => {
      entry.result = result;
      entry.at = Date.now();
      const current = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit" }).format(new Date());
      if (month < current) {
        data.speechmatics[month] = result;
        save();
      }
    }, (error) => {
      entry.failedAt = Date.now();
      entry.error = String(error.message || error);
      console.log(`speechmatics ${month}: ${entry.error}; not asking again for ${speechmaticsRetryMs / 60000} minutes`);
    }).finally(() => {
      entry.pending = null;
    });
    await entry.pending;
  }
  if (!entry.result) throw new Error(entry.error);
  return { ...entry.result, at: entry.at, error: entry.failedAt > entry.at };
}

async function askTvAsrCost(month) {
  const response = await fetch(`${tvAsrCostUrl}?month=${month}`, { signal: AbortSignal.timeout(25000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`tv-srvr ${tvAsrCostUrl} HTTP ${response.status}: ${text.slice(0, 200)}`);
  const hrs = JSON.parse(text).hrs.reduce((sum, day) => sum + day, 0);
  return { usd: hrs * speechmaticsUsdPerHour, hrs };
}

const server = http.createServer((request, response) => {
  void handle(request, response).catch((error) => {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: String(error.message || error) }));
  });
});

async function handle(request, response) {
  const url = new URL(request.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const json = (code, body) => {
    response.writeHead(code, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };

  if (request.method === "GET" && url.pathname === "/version") {
    response.writeHead(200, { "Content-Type": "text/plain" });
    return response.end(version);
  }
  if (request.method === "GET" && url.pathname === "/quota/meta") {
    return json(200, { readAt: data.quota.readAt, pausedUntil: data.quota.pausedUntil });
  }
  if (request.method === "GET" && url.pathname === "/quota") {
    const { rows, readAt, pausedUntil, state } = data.quota;
    return json(200, { rows, readAt, pausedUntil, state });
  }
  if (request.method === "POST" && url.pathname === "/quota/claim") {
    const now = Date.now();
    const quota = data.quota;
    if (now < quota.pausedUntil) {
      return json(200, { poll: false, pausedUntil: quota.pausedUntil });
    }
    if (now - quota.claimedAt < quotaClaimMs || now - quota.readAt < quotaFreshMs) {
      return json(200, { poll: false });
    }
    quota.claimedAt = now;
    save();
    return json(200, { poll: true });
  }
  if (request.method === "POST" && url.pathname === "/quota") {
    const body = JSON.parse((await readBody(request)) || "{}");
    if (typeof body !== "object" || body === null) {
      return json(400, { error: "expected a JSON object" });
    }
    mergeQuota(body);
    save();
    return json(200, { ok: true, rows: data.quota.rows.length });
  }
  if (request.method === "GET" && url.pathname === "/snips") {
    return json(200, data.snips === null ? {} : { text: data.snips });
  }
  if (request.method === "POST" && url.pathname === "/snips") {
    const body = JSON.parse((await readBody(request)) || "{}");
    if (typeof body.text !== "string") {
      return json(400, { error: "expected { text: string }" });
    }
    data.snips = body.text;
    save();
    return json(200, { ok: true });
  }
  if (request.method === "GET" && url.pathname === "/checks") {
    return json(200, { months: data.checks });
  }
  if (request.method === "GET" && parts[0] === "speechmatics" && /^\d{4}-\d{2}$/.test(parts[1] || "")) {
    return json(200, await speechmatics(parts[1], url.searchParams.get("rescan") === "1"));
  }
  json(404, { error: "not found" });
}

server.listen(port, () => {
  console.log(`claude-stats listening on ${server.address().port}, data in ${dataPath}`);
});
