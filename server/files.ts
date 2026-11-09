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

async function clipCopy(host: string, file: string): Promise<object> {
  let local = file;
  if (host === "srv") {
    // ponytail: the fetched copy stays until the next one, as a paste can come at any time.
    await fs.promises.rm(CLIP_DIR, { recursive: true, force: true });
    await fs.promises.mkdir(CLIP_DIR, { recursive: true });
    local = path.join(CLIP_DIR, path.basename(file));
    await scp(`${SRV}:${file}`, local);
  }
  await powershell(`Set-Clipboard -LiteralPath ${quoted(await toWindows(local))}`);
  return {};
}

async function srvFreePath(folder: string, name: string): Promise<string> {
  const res = await fetch(`${HOSTS.srv.url}/api/freePath`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ folder, name }) });
  const reply = (await res.json()) as { path?: string; error?: string };
  if (!reply.path) {
    throw new Error(reply.error ?? `srv backend: ${res.status}`);
  }
  return reply.path;
}

async function clipPaste(host: string, folder: string): Promise<object> {
  const listed = (await powershell("Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }")).split(/\r?\n/).filter(Boolean);
  if (!listed.length) {
    throw new Error("The clipboard has no files.");
  }
  for (const file of await Promise.all(listed.map(fromWindows))) {
    const name = path.basename(file);
    if (host === "srv") {
      await scp(file, `${SRV}:${await srvFreePath(folder, name)}`);
    } else {
      await fs.promises.cp(file, await freePath(folder, name), { recursive: true, force: false, errorOnExist: true });
    }
  }
  return {};
}

export const fileActions: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  listFiles: async (body) => {
    const paths = Array.isArray(body.paths) ? body.paths.map(absolute) : [];
    return { listings: Object.fromEntries(await Promise.all(paths.map(async (folder) => [folder, await listFolder(folder)]))) };
  },
  readFile: (body) => readText(absolute(body.path), Number(body.known)),
  saveFile: (body) => saveText(absolute(body.path), String(body.text ?? ""), Number(body.mtime)),
  newFile: async (body) => {
    await fs.promises.writeFile(await freePath(absolute(body.folder), "new-file"), "", { flag: "wx" });
    return {};
  },
  renamePath: (body) => rename(absolute(body.path), plainName(body.name)),
  deletePath: async (body) => {
    await fs.promises.rm(absolute(body.path), { recursive: true });
    return {};
  },
  freePath: async (body) => ({ path: await freePath(absolute(body.folder), plainName(body.name)) }),
  clipCopy: (body) => clipCopy(String(body.host), absolute(body.path)),
  clipPaste: (body) => clipPaste(String(body.host), absolute(body.folder)),
};
