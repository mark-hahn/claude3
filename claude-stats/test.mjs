#!/usr/bin/env node
// The check of claude-stats (part of `npm test`): the server on a spare port, its data folder
// holding a file as claude2-stats left one. The quota lease is what stops every backend's Quotas
// pane from spending the account's whole rate-limit budget on reading the rate limit.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-stats-test-"));
const dataPath = path.join(dir, "data.json");
fs.writeFileSync(dataPath, JSON.stringify({ installs: { a: {} }, checks: { "2026-10": { usd: 0.75, count: 2 } }, snips: "kept" }));
const child = spawn(process.execPath, [path.join(import.meta.dirname, "server.mjs")], { env: { ...process.env, PORT: "0", CLAUDE_STATS_DIR: dir }, stdio: ["ignore", "pipe", "inherit"] });

const port = new Promise((resolve, reject) => {
  child.stdout.on("data", (chunk) => {
    const found = /listening on (\d+)/.exec(String(chunk));
    if (found) resolve(Number(found[1]));
  });
  child.once("exit", () => reject(new Error("the server stopped before it listened")));
});

async function call(method, urlPath, body) {
  const response = await fetch(`http://127.0.0.1:${await port}${urlPath}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return urlPath === "/version" ? await response.text() : await response.json();
}

async function main() {
  assert.equal(await call("GET", "/version"), "dev");
  assert.deepEqual(await call("GET", "/checks"), { months: { "2026-10": { usd: 0.75, count: 2 } } }, "claude2-stats' check costs are read");
  assert.deepEqual(await call("GET", "/snips"), { text: "kept" }, "and its Snips");
  await call("POST", "/snips", { text: "" });
  assert.deepEqual(await call("GET", "/snips"), { text: "" }, "empty Snips are still set");
  const kept = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  assert.deepEqual(Object.keys(kept).sort(), ["checks", "quota", "snips", "speechmatics"], "what claude3 never used of claude2-stats' data is dropped");
  assert.equal((await call("POST", "/snips", { text: 1 })).error, "expected { text: string }");
  assert.equal((await call("GET", "/stats")).error, "not found", "claude2's own endpoints are gone");

  const claim = () => call("POST", "/quota/claim");
  assert.equal((await claim()).poll, true, "an idle fleet lets the first asker poll");
  assert.equal((await claim()).poll, false, "a claim in flight blocks every other backend");

  const now = Date.now();
  await call("POST", "/quota", { rows: [{ at: now, five_pct: 12 }], readAt: now, state: { windows: [{ key: "five" }] } });
  assert.equal((await claim()).poll, false, "a fresh reading blocks the next cycle");
  assert.deepEqual(await call("GET", "/quota/meta"), { readAt: now, pausedUntil: 0 });

  const stored = await call("GET", "/quota");
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.readAt, now);
  assert.equal(stored.state.windows[0].key, "five", "state rides along with the reading");

  await call("POST", "/quota", { rows: [{ at: now, five_pct: 12 }], readAt: now - 1000 });
  const replayed = await call("GET", "/quota");
  assert.equal(replayed.rows.length, 1, "a replayed row merges on its timestamp");
  assert.equal(replayed.readAt, now, "an older readAt never drags the lease backwards");

  const paused = now + 60_000;
  await call("POST", "/quota", { pausedUntil: paused });
  assert.deepEqual(await claim(), { poll: false, pausedUntil: paused }, "one host's 429 quiets them all");
  await call("POST", "/quota", { pausedUntil: now });
  assert.equal((await claim()).pausedUntil, paused, "nobody can cut another host's pause short");

  console.log("claude-stats checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});
