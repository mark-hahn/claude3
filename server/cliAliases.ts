// The model aliases the CLI itself knows (sonnet, opus, best, opusplan, ...), read from its binary: its
// own model list (the `models` action) has only some of them, and a new release can add one. The binary
// carries its minified JavaScript as text, and the aliases are a quoted array in it:
//   ,$ee=["sonnet","opus","haiku","fable","best","sonnet[1m]","opus[1m]","fable[1m]","opusplan"],Uee=["sonnet","opus","haiku","fable"];
// so the longest array of plain quoted names holding "opus" is the table (the variable's name is
// minified and changes). A release that lays it out differently makes this throw, which the Models pane
// shows in a dialog, rather than showing a list that is quietly stale.
import * as fs from "fs";
import * as path from "path";
import { childEnv } from "./claudeCli.ts";

const ANCHOR = Buffer.from('"opus"');
const NAME = '"[a-z][a-z0-9]*(?:\\[[0-9a-z]+\\])?"';
const LIST = new RegExp(`\\[${NAME}(?:,${NAME})*\\]`, "g");
const REACH = 800;
const CHUNK = 16 << 20;
// More than the table is wide, so one that straddles two chunks is whole in the earlier.
const OVERLAP = 4096;

// The longest array of plain quoted names around any "opus" in a piece of the binary.
export function aliasesIn(chunk: Buffer): string[] {
  let best: string[] = [];
  for (let at = chunk.indexOf(ANCHOR); at !== -1; at = chunk.indexOf(ANCHOR, at + 1)) {
    const from = Math.max(0, at - REACH);
    const text = chunk.subarray(from, at + REACH).toString("latin1");
    for (const match of text.matchAll(LIST)) {
      const start = match.index!;
      if (start > at - from || start + match[0].length <= at - from) continue;
      const names = match[0].slice(1, -1).split(",").map((quoted) => quoted.slice(1, -1));
      if (names.length > best.length) best = names;
    }
  }
  return best;
}

// Where `claude` is, by the PATH the runs use. A symlink is followed; on Windows the npm shim (claude.cmd)
// is followed to the binary beside it.
export function findClaudeBinary(): string {
  const env = childEnv();
  const dirs = (env[Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"] ?? "").split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) continue;
      const real = fs.realpathSync(file);
      if (!real.toLowerCase().endsWith(".cmd")) return real;
      const beside = path.join(path.dirname(real), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
      if (fs.existsSync(beside)) return beside;
    }
  }
  throw new Error("The claude binary is not on this host's PATH.");
}

let cached: { key: string; aliases: string[] } | null = null;

// A binary is hundreds of MB, so it is read in chunks, and only when its size or time changed.
export async function cliAliases(): Promise<string[]> {
  const file = findClaudeBinary();
  const handle = await fs.promises.open(file, "r");
  try {
    const stat = await handle.stat();
    const key = `${file}:${stat.size}:${stat.mtimeMs}`;
    if (cached?.key === key) return cached.aliases;
    // A launcher script, not the program: nothing to read.
    if (stat.size < 5e6) throw new Error(`${file} is only ${stat.size} bytes, not the CLI's program.`);
    const buffer = Buffer.allocUnsafe(CHUNK + OVERLAP);
    let best: string[] = [];
    for (let start = 0; start < stat.size; start += CHUNK) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK + OVERLAP, start);
      const found = aliasesIn(buffer.subarray(0, bytesRead));
      if (found.length > best.length) best = found;
    }
    // The table holds the four family names and more (the array of just the four, beside it, is not it);
    // fewer means the layout is not what this reads.
    if (best.length < 5 || !best.includes("sonnet") || !best.includes("opus")) {
      throw new Error(`No alias table found in ${file} (the nearest array was ${JSON.stringify(best)}).`);
    }
    cached = { key, aliases: best };
    return best;
  } finally {
    await handle.close();
  }
}
