// Self-check for QuotaService's reading before a window resets: `node server/quota.check.mjs`
// (part of `npm test`). It drives the chain on a fake clock against stand-ins for the stats server
// (claim rules as in claude-stats/server.mjs) and the usage endpoint.
import { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "chain-home-"));
fs.writeFileSync(path.join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: 9e15 } }));
process.env.CLAUDE_CONFIG_DIR = home;
const { QuotaService } = await import("./quota.ts");

mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 10, 19, 12, 0, 0) });
let resetMs = 0;
const iso = (ms) => new Date(ms).toISOString();

function scenario(usage, claimBlocked) {
  resetMs = Date.now() + 10 * 60 * 1000;
  const stats = { readAt: 0, claimedAt: 0, pausedUntil: 0, state: null };
  const calls = { claim: 0, usage: 0, finalClaims: 0 };
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.includes("/quota/claim")) {
      calls.claim++;
      const final = JSON.parse(init?.body ?? "{}").final === true;
      if (final) calls.finalClaims++;
      const now = Date.now();
      if (claimBlocked(calls.claim) || (!final && now < stats.pausedUntil)) return json({ poll: false });
      if (now - stats.claimedAt < 30_000 || now - stats.readAt < (final ? 60_000 : 30 * 60_000)) return json({ poll: false });
      stats.claimedAt = now;
      return json({ poll: true });
    }
    if (url.endsWith("/quota/meta")) return json({ readAt: stats.readAt, pausedUntil: stats.pausedUntil });
    if (url.endsWith("/quota") && init?.method === "POST") {
      const body = JSON.parse(init.body ?? "{}");
      if ((body.readAt ?? 0) > stats.readAt) { stats.readAt = body.readAt; stats.pausedUntil = 0; stats.state = body.state; }
      stats.pausedUntil = Math.max(stats.pausedUntil, body.pausedUntil ?? 0);
      return json({ ok: true });
    }
    if (url.endsWith("/quota")) return json({ rows: [], readAt: stats.readAt, pausedUntil: stats.pausedUntil, state: stats.state });
    if (url.includes("/api/oauth/usage")) {
      const outcome = usage(++calls.usage);
      if (outcome === "429") return new Response("{}", { status: 429, headers: { "retry-after": "3600" } });
      if (outcome === "fail") return new Response("boom", { status: 500 });
      return json({ five_hour: { utilization: 16, resets_at: iso(resetMs) }, seven_day: { utilization: 40, resets_at: iso(resetMs + 86400e3) } });
    }
    throw new Error("unexpected fetch " + url);
  });
  const logs = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-dir-"));
  const q = new QuotaService(dir, dir, () => ({}), (line) => logs.push(line));
  q.state = { ...q.state, windows: [{ key: "five", resetsAt: resetMs / 1000 }] };
  return { q, logs, calls, stats };
}
const advance = async (ms) => { for (let left = ms; left > 0; left -= 5000) await tick(Math.min(5000, left)); };
const tick = async (ms) => { mock.timers.tick(ms); for (let i = 0; i < 12; i++) { await fs.promises.stat("/"); await new Promise((r) => setImmediate(r)); } };

// 1. The first call fails: the retry 35s later lands, the chain stops, the reading is the 2-minute one.
{
  const { q, logs, calls } = scenario((n) => (n === 1 ? "fail" : "ok"), () => false);
  q.armFinalReading();
  await tick(8 * 60 * 1000 - 1);
  assert.equal(calls.usage, 0, "nothing before the 2-minute mark");
  await tick(2);
  assert.equal(calls.usage, 1, "first try at 2 minutes before the reset");
  await tick(35_000);
  assert.equal(calls.usage, 2, "retried 35s later");
  await tick(5 * 60 * 1000);
  assert.equal(calls.usage, 2, "and no more once a reading landed");
  assert.equal(calls.finalClaims, calls.claim, "every claim was a final one");
  assert.ok(logs.some((l) => l.includes("reset taken")), logs.join("\n"));
}
// 2. A 429 stops the chain: another try would only repeat it.
{
  const { q, logs, calls } = scenario(() => "429", () => false);
  q.armFinalReading();
  await advance(10 * 60 * 1000);
  assert.equal(calls.usage, 1);
  assert.ok(logs.some((l) => l.includes("refused with a 429")), logs.join("\n"));
}
// 3. Another backend keeps holding the claim and never reads: four tries, the last 15s before the reset, then it stops.
{
  const { q, logs, calls } = scenario(() => "ok", () => true);
  q.armFinalReading();
  await advance(10 * 60 * 1000);
  assert.equal(calls.claim, 4, "tries at -120s, -85s, -50s, -15s");
  assert.ok(logs.some((l) => l.includes("not taken in time")), logs.join("\n"));
}
// 4. A reading from a turn's end 30s before the mark stands in: no call at all, chain done.
{
  const { q, logs, calls, stats } = scenario(() => "ok", () => false);
  stats.readAt = resetMs - 150_000;
  q.lastReadAt = stats.readAt;
  q.armFinalReading();
  await advance(10 * 60 * 1000);
  assert.equal(calls.usage, 0, "the reading of the last minute stands in");
  assert.ok(logs.some((l) => l.includes("reset taken")), logs.join("\n"));
}
// 5. Re-arming for the same reset keeps the chain; a started backend that sees the reset 40s away tries at once.
{
  const { q, calls } = scenario(() => "ok", () => false);
  q.armFinalReading();
  const timer = q.finalReadingTimer;
  q.armFinalReading();
  assert.equal(q.finalReadingTimer, timer, "same reset, same timer");
  await advance(9 * 60 * 1000 + 20_000);
  assert.equal(calls.usage, 1);
}
// 6. A backend that learns of a reset only 40s away tries at once rather than waiting for a mark that has passed.
{
  const { q, calls } = scenario(() => "ok", () => false);
  q.state.windows[0].resetsAt = (Date.now() + 40_000) / 1000;
  q.armFinalReading();
  await advance(1000);
  assert.equal(calls.usage, 1);
}
console.log("chain checks passed");
process.exit(0);
