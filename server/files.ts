// The Files pane's backend: what is in a folder, a text file read and saved, new, rename and
// delete, a file dropped on the tree, and files on the Windows clipboard. Paths come whole from the
// page, as this host's OS writes them; the pane browses the whole host, as Claude's own shell can.
import { execFile } from "child_process";
import * as fs from "fs";
import type { IncomingMessage } from "http";
import * as os from "os";
import * as path from "path";
import { pipeline } from "stream/promises";
import { HOSTS } from "../shared/config.ts";
import type { FileEntry } from "../shared/types.ts";
import { POWERSHELL } from "./capture.ts";

const MAX_EDITABLE = 5_000_000;
const exists = (item: string): Promise<boolean> => fs.promises.lstat(item).then(() => true, () => false);

// A relative path would land in the backend's own folder.
function absolute(value: unknown): string {
  const wanted = String(value ?? "");
  if (!path.isAbsolute(wanted)) {
    throw new Error(`${wanted || "An empty path"} is not a full path.`);
  }
  return wanted;
}

// One name, nothing that could take the item out of its folder.
function plainName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
    throw new Error(`"${name}" can't be a file name.`);
  }
  return name;
}

// A name with its clash index, which goes before the extension. Index 0 is the name as it is.
export function numberedName(name: string, index: number): string {
  const { name: stem, ext } = path.parse(name);
  return index ? `${stem}(${index})${ext}` : name;
}

async function freePath(folder: string, name: string): Promise<string> {
  for (let index = 0; ; index++) {
    const candidate = path.join(folder, numberedName(name, index));
    if (!(await exists(candidate))) {
      return candidate;
    }
  }
}

// Folders first, then by name; a link counts as what it points at. Null when it can't be read.
async function listFolder(folder: string): Promise<FileEntry[] | null> {
  const found = await fs.promises.readdir(folder, { withFileTypes: true }).catch(() => null);
  if (!found) {
    return null;
  }
  const entries = await Promise.all(found.filter((item) => item.name !== ".git").map(async (item) => {
    const full = path.join(folder, item.name);
    const dir = item.isSymbolicLink() ? await fs.promises.stat(full).then((target) => target.isDirectory(), () => false) : item.isDirectory();
    return { name: item.name, path: full, dir };
  }));
  return entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

// The next name holding text, case aside, in the tree's order: below after, or above it going
// backward, round to the other end when none is left there. node_modules counts only when asked.
// Links to folders aren't followed, or a link cycle would never end.
async function findStep(root: string, text: string, after: string, backward: boolean, nodeModules: boolean): Promise<{ path: string | null }> {
  const wanted = text.toLowerCase();
  let first: string | null = null;
  let latest: string | null = null;
  let passed = !after;
  const walk = async (folder: string): Promise<string | null> => {
    for (const entry of (await listFolder(folder)) ?? []) {
      if (entry.name === "node_modules" && !nodeModules) {
        continue;
      }
      const hit = entry.name.toLowerCase().includes(wanted);
      if (backward ? entry.path === after && latest : hit && passed) {
        return backward ? latest : entry.path;
      }
      if (hit) {
        first ??= entry.path;
        latest = entry.path;
      }
      passed ||= entry.path === after;
      if (entry.dir && (await fs.promises.lstat(entry.path).then((found) => found.isDirectory(), () => false))) {
        const found = await walk(entry.path);
        if (found) {
          return found;
        }
      }
    }
    return null;
  };
  return { path: (await walk(root)) ?? (backward ? latest : first) };
}

// text is left out when the file is still the version known, and null when it can't be edited
// here: too big, binary, or not UTF-8, which a save would corrupt.
async function readText(file: string, known: number): Promise<{ mtime: number; text?: string | null }> {
  const { mtimeMs: mtime, size } = await fs.promises.stat(file);
  if (mtime === known) {
    return { mtime };
  }
  if (size >= MAX_EDITABLE) {
    return { mtime, text: null };
  }
  const bytes = await fs.promises.readFile(file);
  try {
    return { mtime, text: bytes.includes(0) ? null : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { mtime, text: null };
  }
}

// The editor's tail mode: answers once the file differs from the version known, or after 2s, so
// where a watch can't see a change (Windows writing a file WSL reads under /mnt/c) it is no worse
// than the polling. A new watch each time: a file replaced by rename leaves the old one on a dead inode.
// ponytail: answers with the whole file; send only what was appended if huge busy logs ever matter.
async function waitForChange(file: string, known: number): Promise<{ mtime: number; text?: string | null }> {
  await new Promise<void>((resolve) => {
    let watcher: fs.FSWatcher | undefined;
    let timer = setTimeout(() => {
      watcher?.close();
      resolve();
    }, 2000);
    // The first event ends the watch, so a burst of writes comes back as one answer.
    const changed = (): void => {
      watcher?.close();
      clearTimeout(timer);
      timer = setTimeout(resolve, 100);
    };
    try {
      // The listener is needed: Windows reports a deleted file as an error event, which would end the backend.
      watcher = fs.watch(file, changed).on("error", () => undefined);
    } catch {
      // No watch to be had: the 2s stands, and a missing file is found by the stat below.
    }
    // A change made before the watch began sends no event.
    void fs.promises.stat(file).then((found) => found.mtimeMs !== known && changed(), changed);
  });
  return readText(file, known);
}

// Refused unless the file is still the version the editor read, so a change made meanwhile (a
// Claude session, most likely) isn't overwritten unseen.
async function saveText(file: string, text: string, mtime: number): Promise<{ mtime?: number; conflict?: boolean }> {
  const now = await fs.promises.stat(file).then((found) => found.mtimeMs, () => 0);
  if (now !== mtime) {
    return { conflict: true };
  }
  await fs.promises.writeFile(file, text);
  return { mtime: (await fs.promises.stat(file)).mtimeMs };
}

async function rename(item: string, name: string): Promise<{ path: string }> {
  const target = path.join(path.dirname(item), name);
  if (await exists(target)) {
    throw new Error(`${name} already exists there.`);
  }
  await fs.promises.rename(item, target);
  return { path: target };
}

// A file dropped on the tree: the raw bytes, streamed to disk under a free name.
export async function upload(req: IncomingMessage, query: URLSearchParams): Promise<object> {
  const target = await freePath(absolute(query.get("folder")), plainName(query.get("name")));
  try {
    await pipeline(req, fs.createWriteStream(target, { flags: "wx" }));
  } catch (error) {
    // Not a clash: that file is someone else's.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      await fs.promises.rm(target, { force: true });
    }
    throw error;
  }
  return {};
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 600_000, maxBuffer: 20_000_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

// Encoded, so no name can break the quoting on its way through WSL's interop; UTF-8 out, so one
// can't come back mangled by the console's code page. The catch keeps a failure to its one-line
// message, for the pane's red note.
function powershell(script: string): Promise<string> {
  const full = `$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); try { ${script} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  return run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(full, "utf16le").toString("base64")]);
}

// PowerShell ends a single-quoted string at the curly quotes too.
const quoted = (text: string): string => `'${text.replace(/['‘’‚‛]/g, "$&$&")}'`;
const windows = process.platform === "win32";
const toWindows = async (file: string): Promise<string> => (windows ? file : (await run("wslpath", ["-w", file])).trim());
const fromWindows = async (file: string): Promise<string> => (windows ? file : (await run("wslpath", ["-u", file])).trim());

// The clipboard is on the laptop, out of the srv backend's reach, so WSL's backend does a srv tab's
// clipboard work, carrying the files with scp.
const SRV = new URL(HOSTS.srv.url).hostname;
const CLIP_DIR = path.join(os.homedir(), ".claude3", "clipboard");
const scp = (from: string, to: string): Promise<string> => run("scp", ["-q", "-r", "-o", "BatchMode=yes", from, to]);

// clip is the clipboard's own name for the item, which a later clipFiles answers in.
async function clipCopy(host: string, file: string): Promise<{ clip: string }> {
  let local = file;
  if (host === "srv") {
    // ponytail: the fetched copy stays until the next one, as a paste can come at any time.
    await fs.promises.rm(CLIP_DIR, { recursive: true, force: true });
    await fs.promises.mkdir(CLIP_DIR, { recursive: true });
    local = path.join(CLIP_DIR, path.basename(file));
    await scp(`${SRV}:${file}`, local);
  }
  const clip = await toWindows(local);
  await powershell(`Set-Clipboard -LiteralPath ${quoted(clip)}`);
  return { clip };
}

const clipFiles = async (): Promise<string[]> => (await powershell("Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }")).split(/\r?\n/).filter(Boolean);

async function srvFreePath(folder: string, name: string): Promise<string> {
  const res = await fetch(`${HOSTS.srv.url}/api/freePath`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ folder, name }) });
  const reply = (await res.json()) as { path?: string; error?: string };
  if (!reply.path) {
    throw new Error(reply.error ?? `srv backend: ${res.status}`);
  }
  return reply.path;
}

// Answers where the first item landed; the tree selects that one.
async function clipPaste(host: string, folder: string): Promise<{ path: string }> {
  const listed = await clipFiles();
  if (!listed.length) {
    throw new Error("The clipboard has no files.");
  }
  let first = "";
  for (const file of await Promise.all(listed.map(fromWindows))) {
    const name = path.basename(file);
    const target = host === "srv" ? await srvFreePath(folder, name) : await freePath(folder, name);
    if (host === "srv") {
      await scp(file, `${SRV}:${target}`);
    } else {
      await fs.promises.cp(file, target, { recursive: true, force: false, errorOnExist: true });
    }
    first ||= target;
  }
  return { path: first };
}

// Ctrl-X's item landing on its own host. Into the folder it is already in, nothing moves.
async function move(item: string, folder: string): Promise<{ path: string }> {
  if (path.dirname(item) === path.resolve(folder)) {
    return { path: item };
  }
  const target = await freePath(folder, path.basename(item));
  try {
    await fs.promises.rename(item, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }
    // Another disk, such as /root to /mnt/c.
    await fs.promises.cp(item, target, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true, preserveTimestamps: true });
    await fs.promises.rm(item, { recursive: true });
  }
  return { path: target };
}

// A folder's whole contents, links not followed. ponytail: gives up after 2s and says so (partial);
// a count kept running in the background if big trees ever need the full figure.
async function folderTotals(folder: string): Promise<{ files: number; folders: number; bytes: number; partial: boolean }> {
  const totals = { files: 0, folders: 0, bytes: 0, partial: false };
  const until = Date.now() + 2000;
  const walk = async (dir: string): Promise<void> => {
    for (const item of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (Date.now() > until) {
        totals.partial = true;
        return;
      }
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        totals.folders++;
        await walk(full);
      } else {
        totals.files++;
        totals.bytes += (await fs.promises.lstat(full).catch(() => null))?.size ?? 0;
      }
    }
  };
  await walk(folder);
  return totals;
}

// A uid or gid's name from /etc/passwd or /etc/group; Windows has neither.
async function idName(file: string, id: number): Promise<string> {
  const text = await fs.promises.readFile(file, "utf8").catch(() => "");
  return text.split("\n").map((line) => line.split(":")).find((parts) => parts[2] === String(id))?.[0] ?? "";
}

const rwx = (mode: number): string => [6, 3, 0].map((shift) => ["r", "w", "x"].map((letter, bit) => ((mode >> shift) & (4 >> bit) ? letter : "-")).join("")).join("");

// The long-press dialog's facts: what lstat and stat say, and a link's target. Times are ms, for the page to show in its own zone.
async function fileInfo(item: string): Promise<object> {
  const own = await fs.promises.lstat(item);
  const link = own.isSymbolicLink() ? await fs.promises.readlink(item) : "";
  // A link's facts are its target's, or its own when the target is gone.
  const found = link ? await fs.promises.stat(item).catch(() => own) : own;
  const kind = found.isDirectory() ? "folder" : found.isFile() ? "file" : found.isFIFO() ? "pipe" : found.isSocket() ? "socket" : found.isCharacterDevice() || found.isBlockDevice() ? "device" : "link to nothing";
  let text: { lines: number } | { binary: true } | null = null;
  if (kind === "file" && found.size < MAX_EDITABLE) {
    const bytes = await fs.promises.readFile(item).catch(() => null);
    if (bytes) text = bytes.includes(0) ? { binary: true } : { lines: bytes.length ? bytes.toString("latin1").split("\n").length - (bytes.at(-1) === 10 ? 1 : 0) : 0 };
  }
  return {
    kind,
    link,
    realPath: await fs.promises.realpath(item).catch(() => ""),
    size: found.size,
    text,
    entries: kind === "folder" ? ((await fs.promises.readdir(item).catch(() => null))?.length ?? null) : null,
    totals: kind === "folder" ? await folderTotals(item) : null,
    modified: found.mtimeMs,
    accessed: found.atimeMs,
    changed: found.ctimeMs,
    created: found.birthtimeMs,
    permissions: `${rwx(found.mode)} (${(found.mode & 0o7777).toString(8).padStart(4, "0")})`,
    owner: windows ? "" : `${(await idName("/etc/passwd", found.uid)) || "?"} (${found.uid})`,
    group: windows ? "" : `${(await idName("/etc/group", found.gid)) || "?"} (${found.gid})`,
    inode: found.ino,
    hardLinks: found.nlink,
    device: found.dev,
    blocks: found.blocks ?? null,
  };
}

export const fileActions: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  fileInfo: (body) => fileInfo(absolute(body.path)),
  listFiles: async (body) => {
    const paths = Array.isArray(body.paths) ? body.paths.map(absolute) : [];
    return { listings: Object.fromEntries(await Promise.all(paths.map(async (folder) => [folder, await listFolder(folder)]))) };
  },
  findFile: (body) => findStep(absolute(body.root), String(body.text ?? ""), String(body.after ?? ""), body.backward === true, body.nodeModules === true),
  readFile: (body) => readText(absolute(body.path), Number(body.known)),
  waitFile: (body) => waitForChange(absolute(body.path), Number(body.known)),
  saveFile: (body) => saveText(absolute(body.path), String(body.text ?? ""), Number(body.mtime)),
  newFile: async (body) => {
    const target = await freePath(absolute(body.folder), "new-file");
    await fs.promises.writeFile(target, "", { flag: "wx" });
    return { path: target };
  },
  renamePath: (body) => rename(absolute(body.path), plainName(body.name)),
  movePath: (body) => move(absolute(body.path), absolute(body.folder)),
  deletePath: async (body) => {
    await fs.promises.rm(absolute(body.path), { recursive: true });
    return {};
  },
  freePath: async (body) => ({ path: await freePath(absolute(body.folder), plainName(body.name)) }),
  clipCopy: (body) => clipCopy(String(body.host), absolute(body.path)),
  clipFiles: async () => ({ files: await clipFiles() }),
  clipPaste: (body) => clipPaste(String(body.host), absolute(body.folder)),
};
