// npm test: the Term pane's pty (server/term.ts) on this Linux box: its folder, colours passed
// through, Ctrl-C, the 1000-line replay, and a key after `exit` starting another shell.
import assert from "node:assert";
import { termRead, termSend } from "./term.ts";

const cwd = import.meta.dirname;
let id = "";
let at = 0;
let seen = "";
// Reads as the page does until the output seen since the last mark matches.
async function until(wanted) {
  for (let tries = 0; tries < 15 && !wanted.test(seen); tries++) {
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
await send("exit\r");
await until(/\[exited 0/);
await send("echo again; exit\r");
await until(/\ragain\r\n[^]*\[exited 0/);
console.log("term.check: ok");
