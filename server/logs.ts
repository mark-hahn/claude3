// The Tail pane's backend: which log files a project has, and a log's end read in whole lines,
// older ones on request, new ones as they are written. Paths come whole from files.ts, already checked.
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const LINES = 500;
export interface LogEntry {
  path: string;
  label: string;
  size: number;
  mtime: number;
}
export interface TailChunk {
  text: string;
  start: number;
  end: number;
  ino: number;
}

// The processes pm2 runs in the folder or below it: their out and error logs, which pm2 keeps
// under ~/.pm2/logs, outside the project. Only asked when pm2's daemon is up, as `pm2 jlist` would start it.
const pm2Home = (): string => process.env.PM2_HOME ?? path.join(os.homedir(), ".pm2");

function pm2Logs(root: string): Promise<string[]> {
  if (!fs.existsSync(path.join(pm2Home(), "pm2.pid"))) {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    execFile("pm2", ["jlist"], { timeout: 5000, maxBuffer: 20_000_000, windowsHide: true }, (error, stdout) => {
      // The list is one line of JSON; pm2 may print its own [PM2] notes around it.
      const json = /^\[(\{.*\})?\]$/m.exec(stdout)?.[0];
      if (error || !json) {
        return resolve([]);
      }
      try {
        const found = (JSON.parse(json) as { pm2_env?: { pm_cwd?: string; pm_out_log_path?: string; pm_err_log_path?: string } }[])
          .filter((one) => one.pm2_env?.pm_cwd && isInside(root, one.pm2_env.pm_cwd))
          .flatMap((one) => [one.pm2_env?.pm_out_log_path, one.pm2_env?.pm_err_log_path]);
        resolve(found.filter((file): file is string => typeof file === "string"));
      } catch {
        resolve([]);
      }
    });
  });
}

export function isInside(root: string, folder: string): boolean {
  const rel = path.relative(root, folder);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Folders that hold other things' logs, not the project's, and what pm2-logrotate makes of a day's log.
const SKIP = new Set(["node_modules", "dist", "graft", "build", "target", "venv", "__pycache__"]);
const ROTATED = /__\d{4}-\d\d-\d\d_/;
// ponytail: three levels and 2s, so a project at / ends its walk early; a real index if that ever matters.
async function walkLogs(root: string): Promise<string[]> {
  const found: string[] = [];
  const until = Date.now() + 2000;
  const walk = async (folder: string, depth: number): Promise<void> => {
    for (const item of await fs.promises.readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (Date.now() > until) {
        return;
      }
      if (item.isFile() && item.name.endsWith(".log") && !ROTATED.test(item.name)) {
        found.push(path.join(folder, item.name));
      } else if (item.isDirectory() && depth < 3 && !SKIP.has(item.name) && !item.name.startsWith(".")) {
        await walk(path.join(folder, item.name), depth + 1);
      }
    }
  };
  await walk(root, 1);
  return found;
}

// The first is the one the pane opens on: the biggest of the logs written in the last week (the main log
// is the one most is added to, and a daily rotation keeps its size about a day's writing; the newest write
// alone would flip between a project's pm2 processes), then older ones with text, newest first, empty ones last.
const WEEK = 7 * 86_400_000;
export const byRelevance = (a: LogEntry, b: LogEntry): number => {
  const tier = (log: LogEntry): number => (log.size === 0 ? 2 : Date.now() - log.mtime < WEEK ? 0 : 1);
  return tier(a) - tier(b) || (tier(a) === 0 ? b.size - a.size : 0) || b.mtime - a.mtime;
};

// A path from the project's folder; pm2's own logs, which are never in it, say `pm2/` in place of the way out to its folder.
export const logLabel = (root: string, home: string, file: string): string => (isInside(home, file) ? `pm2/${path.relative(home, file)}` : path.relative(root, file)).replaceAll("\\", "/");

export async function findLogs(root: string, pm2 = pm2Logs, home = pm2Home()): Promise<{ logs: LogEntry[] }> {
  const files = [...new Set([...(await pm2(root)), ...(await walkLogs(root))])];
  const entries = await Promise.all(files.map(async (file): Promise<LogEntry | null> => {
    const found = await fs.promises.stat(file).catch(() => null);
    return found?.isFile() ? { path: file, label: logLabel(root, home, file), size: found.size, mtime: found.mtimeMs } : null;
  }));
  return { logs: entries.filter((one) => one !== null).sort(byRelevance) };
}

const BLOCK = 65536;
// A line longer than this, with no newline in sight, isn't worth the backend's memory.
const MAX_SCAN = 8_000_000;

// Index in buf, which ends in a newline, where its last `lines` lines begin.
export function startOfLast(buf: Buffer, lines: number): number {
  let at = buf.length - 1;
  for (let n = 0; n <= lines; n++) {
    at = at < 0 ? -1 : buf.lastIndexOf(10, at);
    if (at < 0) {
      return 0;
    }
    at--;
  }
  return at + 2;
}

// Up to LINES whole lines ending at byte `before`, which is a line's end (a start the pane was given
// before); with none, ending at the file's last newline, a line still being written left out.
export async function tailRead(file: string, before?: number): Promise<TailChunk> {
  const fh = await fs.promises.open(file, "r");
  try {
    const { size, ino } = await fh.stat();
    const top = before === undefined ? size : Math.min(before, size);
    let pos = top;
    const parts: Buffer[] = [];
    let newlines = 0;
    while (pos > 0 && newlines <= LINES && top - pos < MAX_SCAN) {
      const block = Buffer.alloc(Math.min(BLOCK, pos));
      pos -= block.length;
      await fh.read(block, 0, block.length, pos);
      parts.unshift(block);
      for (let at = block.indexOf(10); at >= 0; at = block.indexOf(10, at + 1)) {
        newlines++;
      }
    }
    let buf = Buffer.concat(parts);
    if (before === undefined) {
      buf = buf.subarray(0, buf.lastIndexOf(10) + 1);
    }
    const from = startOfLast(buf, LINES);
    // Both cuts are at newlines, so no character is split.
    return { text: buf.subarray(from).toString("utf8"), start: pos + from, end: pos + buf.length, ino };
  } finally {
    await fh.close();
  }
}

// More than this behind (a page that was asleep) and the pane starts over from the end instead.
const MAX_NEW = 1_000_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The whole lines written after byte `from`: as soon as there are some, else an empty answer after 2s.
// `reset` when the file isn't the one the pane read (replaced, or cut short as pm2-logrotate does at midnight).
// ponytail: a stat every 250ms, which sees changes anywhere (fs.watch is blind on /mnt/c); a watch if the load ever matters.
export async function tailWait(file: string, from: number, ino: number): Promise<{ text: string; end: number } | { reset: true }> {
  for (let tries = 0; ; tries++) {
    const found = await fs.promises.stat(file);
    if (found.size < from || found.ino !== ino || found.size - from > MAX_NEW) {
      return { reset: true };
    }
    if (found.size > from) {
      const fh = await fs.promises.open(file, "r");
      try {
        const buf = Buffer.alloc(found.size - from);
        await fh.read(buf, 0, buf.length, from);
        const last = buf.lastIndexOf(10);
        if (last >= 0) {
          return { text: buf.subarray(0, last + 1).toString("utf8"), end: from + last + 1 };
        }
      } finally {
        await fh.close();
      }
    }
    if (tries >= 7) {
      return { text: "", end: from };
    }
    await sleep(250);
  }
}
