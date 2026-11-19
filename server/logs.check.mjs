// Self-check for logs.ts: `node server/logs.check.mjs` (part of `npm test`).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findLogs, LINES, tailRead, tailWait } from "./logs.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logs-check-"));
const file = path.join(dir, "big.log");
const line = (n) => `line ${n} é${"x".repeat(n % 7)}\n`;
const all = Array.from({ length: 1200 }, (_, n) => line(n));
fs.writeFileSync(file, all.join("") + "unfinished");

// The end of the file in whole lines: the last 500, and the line still being written left out.
const last = await tailRead(file);
assert.equal(last.text, all.slice(-LINES).join(""));
assert.equal(Buffer.byteLength(all.slice(0, -LINES).join("")), last.start);
assert.equal(Buffer.byteLength(all.join("")), last.end);
// Older ones, 500 at a time, then what is left, the file's very start.
const older = await tailRead(file, last.start);
assert.equal(older.text, all.slice(-2 * LINES, -LINES).join(""));
const oldest = await tailRead(file, older.start);
assert.equal(oldest.text, all.slice(0, 200).join(""));
assert.equal(oldest.start, 0);
// A file with no whole line yet, and an empty one.
fs.writeFileSync(path.join(dir, "none.log"), "partial");
assert.deepEqual({ ...(await tailRead(path.join(dir, "none.log"))), ino: 0 }, { text: "", start: 0, end: 0, ino: 0 });
fs.writeFileSync(path.join(dir, "empty.log"), "");
assert.equal((await tailRead(path.join(dir, "empty.log"))).text, "");

// New lines: nothing for 2s, then the whole ones only; a cut-short or replaced file is a reset.
assert.deepEqual(await tailWait(file, last.end, last.ino), { text: "", end: last.end });
fs.appendFileSync(file, " more\nnext é\npart");
assert.deepEqual(await tailWait(file, last.end, last.ino), { text: "unfinished more\nnext é\n", end: last.end + Buffer.byteLength("unfinished more\nnext é\n") });
assert.deepEqual(await tailWait(file, last.end + 100000, last.ino), { reset: true });
assert.deepEqual(await tailWait(file, last.end, last.ino + 1), { reset: true });

// Which logs: pm2's (outside the folder, labelled pm2/ from pm2's own folder), the folder's own, not rotated copies, not node_modules;
// the biggest written this week first, then older ones with text, then empty ones.
fs.mkdirSync(path.join(dir, "node_modules"));
fs.writeFileSync(path.join(dir, "node_modules", "x.log"), "x\n");
fs.writeFileSync(path.join(dir, "app-out__2026-11-17_00-00-00.log"), "old\n");
fs.writeFileSync(path.join(dir, "empty.log"), "");
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "logs-pm2-"));
const pm2Out = path.join(outside, "app-out.log");
fs.writeFileSync(pm2Out, "hello\n");
const ago = (name, seconds) => fs.utimesSync(name, new Date(Date.now() - seconds * 1000), new Date(Date.now() - seconds * 1000));
ago(path.join(dir, "none.log"), 1000);
ago(file, 3600);
fs.writeFileSync(path.join(dir, "old.log"), "x\n");
ago(path.join(dir, "old.log"), 30 * 86400);
fs.writeFileSync(path.join(dir, "tiny.log"), "t\n");
const { logs } = await findLogs(dir, async () => [pm2Out, path.join(outside, "gone.log"), "/dev/null"], outside);
assert.deepEqual(logs.map((one) => one.label), ["big.log", "none.log", "pm2/app-out.log", "tiny.log", "old.log", "empty.log"]);
assert.equal(logs[2].path, pm2Out);
assert.ok(!logs.some((one) => /node_modules|__20/.test(one.label)));

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });
console.log("logs.check: ok");
