// The Term pane's shells: one pty per terminal (main.ts keys them, three a tab at most), in the folder the page names, through node-pty (what VS Code's
// terminal uses): bash on Linux, PowerShell on Windows. Kept here, so closing the pane or
// reloading the page loses nothing. The page's xterm.js gets the raw output, colours and all, and
// sends keys as typed. The last LINES lines are kept, to replay to a page that comes in fresh.
import { randomUUID } from "crypto";
import { writeFileSync } from "fs";
import { createRequire } from "module";
import { homedir } from "os";
import { join } from "path";
import type { IPty } from "node-pty";
import { childEnv } from "./claudeCli.ts";

const LINES = 1000;
// Also a cap in characters, for output that never ends a line (a progress bar on \r).
const MAX_CHARS = 2_000_000;
interface Shell {
  pty?: IPty;
  // A page holding another id (from before a backend restart) starts over from the whole buffer.
  id: string;
  text: string;
  // Where text starts in all the shell has printed: what has been cut off its front.
  base: number;
  cols: number;
  rows: number;
  // Date.now() of the last output or key, for the header's idle time.
  last: number;
  // Its pty has exited and no key has started another: the page takes such a terminal out, unless it is the only one.
  exited: boolean;
  changed: Promise<void>;
  wake: () => void;
}
const shells = new Map<string, Shell>();
const end = (shell: Shell): number => shell.base + shell.text.length;
// Loaded when first wanted, so a host without node-pty still runs everything but the terminal.
const require = createRequire(import.meta.url);
const size = (value: number, fallback: number): number => (Number.isInteger(value) && value > 0 && value <= 1000 ? value : fallback);
const messageOf = (problem: unknown): string => (problem instanceof Error ? problem.message : String(problem));

function append(shell: Shell, data: string): void {
  shell.last = Date.now();
  shell.text += data;
  let cut = shell.text.length;
  let lines = 0;
  while (lines < LINES && cut > 0) {
    cut = shell.text.lastIndexOf("\n", cut - 1);
    lines++;
  }
  const from = Math.max(lines === LINES && cut >= 0 ? cut + 1 : 0, shell.text.length - MAX_CHARS);
  if (from > 0) {
    shell.base += from;
    shell.text = shell.text.slice(from);
  }
  shell.wake();
  shell.changed = new Promise((resolve) => (shell.wake = resolve));
}

// Each prompt sends the shell's folder as OSC 7 with a bare path, for the pane's header. Added after
// the user's own startup (bash's ~/.bashrc unsets PROMPT_COMMAND), and last, so $? is still theirs.
const BASH_RC = `[ -f ~/.bashrc ] && . ~/.bashrc
PROMPT_COMMAND="\${PROMPT_COMMAND}
printf '\\e]7;%s\\a' \\"\\$PWD\\""
`;
const PS_PROMPT = `$global:__c3Prompt = $function:prompt; function global:prompt { "$([char]27)]7;$($PWD.ProviderPath)$([char]7)" + (& $global:__c3Prompt) }`;

function start(shell: Shell, cwd: string): void {
  try {
    const { spawn } = require("node-pty") as typeof import("node-pty");
    const windows = process.platform === "win32";
    let args = ["-NoLogo", "-NoExit", "-EncodedCommand", Buffer.from(PS_PROMPT, "utf16le").toString("base64")];
    if (!windows) {
      const rc = join(homedir(), ".claude3", "term.bashrc");
      writeFileSync(rc, BASH_RC);
      args = ["--rcfile", rc];
    }
    const pty = spawn(windows ? "powershell.exe" : "bash", args, { name: "xterm-256color", cols: shell.cols, rows: shell.rows, cwd, env: { ...childEnv(), TERM: "xterm-256color", COLORTERM: "truecolor" } });
    shell.pty = pty;
    shell.exited = false;
    pty.onData((data) => append(shell, data));
    pty.onExit(({ exitCode }) => {
      if (shell.pty === pty) {
        shell.pty = undefined;
        shell.exited = true;
      }
      append(shell, `\r\n[exited ${exitCode}; press a key to start another]\r\n`);
    });
  } catch (problem) {
    append(shell, `\r\n[${messageOf(problem)}]\r\n`);
  }
}

// The project's shell, started the first time the pane asks. One that has exited is started
// again only by a key, so a shell that can't start doesn't respawn in a loop.
function shellFor(project: string, cwd: string, cols = 80, rows = 24): Shell {
  let shell = shells.get(project);
  if (!shell) {
    shell = { id: randomUUID(), text: "", base: 0, cols: size(cols, 80), rows: size(rows, 24), last: Date.now(), exited: false, changed: Promise.resolve(), wake: () => undefined };
    const made = shell;
    shell.changed = new Promise((resolve) => (made.wake = resolve));
    shells.set(project, shell);
    start(shell, cwd);
  }
  return shell;
}

// What the page at (id, at) hasn't seen, waiting up to 2s for some. reset: the page's copy is from
// another shell or fell behind the buffer, and text is the whole of it. idle: ms since the last output or key,
// a span rather than a time, so the two clocks needn't agree.
export async function termRead(project: string, cwd: string, id: string, at: number, cols: number, rows: number): Promise<{ id: string; at: number; text: string; reset: boolean; idle: number; exited: boolean }> {
  const shell = shellFor(project, cwd, cols, rows);
  if (id === shell.id && at === end(shell)) await Promise.race([shell.changed, new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (id !== shell.id || !(at >= shell.base && at <= end(shell))) return { id: shell.id, at: end(shell), text: shell.text, reset: true, idle: Date.now() - shell.last, exited: shell.exited };
  return { id: shell.id, at: end(shell), text: shell.text.slice(at - shell.base), reset: false, idle: Date.now() - shell.last, exited: shell.exited };
}

export function termSend(project: string, cwd: string, data: string): void {
  const shell = shellFor(project, cwd);
  shell.last = Date.now();
  if (!shell.pty) start(shell, cwd);
  shell.pty?.write(data);
}

// The pane's Clr, which has cleared its own xterm: the buffer cut to its last line, the prompt, so a
// reload doesn't bring the rest back, with the last folder sent kept for the header. The page's offset
// stays good. ConPTY is told too, or it may reprint the old screen.
export function termClear(project: string): void {
  const shell = shells.get(project);
  if (!shell) return;
  const at = shell.text.lastIndexOf("\x1b]7;");
  const folder = at < 0 ? "" : shell.text.slice(at, shell.text.indexOf("\x07", at) + 1);
  const keep = folder + shell.text.slice(shell.text.lastIndexOf("\n") + 1);
  shell.base = end(shell) - keep.length;
  shell.text = keep;
  shell.pty?.clear();
}

// A terminal the page has taken out of the pane after its shell's exit: forgotten, so one added
// there later starts afresh. A pty still running is ended.
export function termClose(project: string): void {
  shells.get(project)?.pty?.kill();
  shells.delete(project);
}

export function termResize(project: string, cols: number, rows: number): void {
  const shell = shells.get(project);
  if (!shell) return;
  shell.cols = size(cols, shell.cols);
  shell.rows = size(rows, shell.rows);
  try {
    shell.pty?.resize(shell.cols, shell.rows);
  } catch {
    // A pty that exited a moment ago; the next start takes the size.
  }
}
