// npm test: the Term pane's pty (server/term.ts) on this Linux box: its folder, colours passed
// through, the prompt's OSC 7 folder, Ctrl-C, the 1000-line replay, Clr, a key after `exit` starting another shell, and a closed one starting afresh.
import assert from "node:assert";
import { termClear, termClose, termRead, termSend } from "./term.ts";

const cwd = import.meta.dirname;
let id = "";
let at = 0;
let seen = "";
// Reads as the page does until the output seen since the last mark matches, for 20s at most
// (not a count of reads: a long output can come in any number of pieces).
async function until(wanted) {
  for (const stop = Date.now() + 20_000; Date.now() < stop && !wanted.test(seen); ) {
    const got = await termRead("check", cwd, id, at, 100, 30);
    seen = got.reset ? got.text : seen + got.text;
    ({ id, at } = got);
  }
  assert.match(seen, wanted);
}
// After a pause, as a person types: a Ctrl-C sent the moment the tty echoes a command can reach
// bash before it hands the terminal to that command, leaving the command running.
const send = async (data) => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  seen = "";
  termSend("check", cwd, data);
};

await until(/./);
await send("cd /tmp\r");
await until(/\x1b\]7;\/tmp\x07/);
await send("cd -\r");
await send("pwd; printf 'x\\033[31mred\\033[0m\\n'\r");
await until(/\x1b\[31mred\x1b\[0m\r\n/);
assert.ok(seen.includes(`${cwd}\r\n`), "starts in its folder");
const started = Date.now();
await send("sleep 30; echo slept\r");
await until(/sleep 30/);
await send("\x03echo woke\r");
await until(/\rwoke\r\n/);
assert.ok(!seen.includes("slept") && Date.now() - started < 10_000, "Ctrl-C");
await send("seq 1 2000\r");
await until(/\r\n2000\r\n/);
const replay = await termRead("check", cwd, "", 0, 100, 30);
assert.ok(replay.reset && replay.text.split("\n").length <= 1001 && replay.text.includes("\r\n2000\r\n"), "replay of the last 1000 lines");
assert.ok(replay.idle >= 0 && replay.idle < 5000, "idle since the last output");
await until(/\r\n2000\r\n[^]*\x1b\]7;/);
termClear("check");
const cleared = await termRead("check", cwd, "", 0, 100, 30);
assert.ok(!cleared.text.includes("2000") && cleared.text.startsWith(`\x1b]7;${cwd}\x07`), "Clr leaves the folder and the prompt line");
await send("exit\r");
await until(/\[exited 0/);
assert.ok((await termRead("check", cwd, id, at, 100, 30)).exited, "an exit is told");
await send("echo again; exit\r");
await until(/\ragain\r\n[^]*\[exited 0/);
termClose("check");
const fresh = await termRead("check", cwd, id, at, 100, 30);
assert.ok(fresh.reset && fresh.id !== id && !fresh.exited, "a closed terminal starts afresh");
termClose("check");
console.log("term.check: ok");
