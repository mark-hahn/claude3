// The Git pane's lines, from `git log --graph`: one per commit, with no star and no hash on show,
// though each knows its commit's full hash and message, for copying. A commit with branch or tag names has its message on a
// second line, in the column where the messages on the other lines start.
import { MAX_EDITABLE } from "./files.ts";

// After the graph's own characters, which git puts first, the fields are split by NULs.
// ponytail: the newest 1000 commits; page it if older history is ever wanted.
export const GRAPH_ARGS = ["log", "--graph", "--all", "--no-color", "--date=format:%y-%m-%d %H:%M", "--format=%x00%H%x00%ad%x00%d%x00%s", "-n", "1000"];

export function layoutGraph(out: string): { text: string; hash: string; message: string }[] {
  const rows = out.trimEnd().split("\n").flatMap((line) => {
    const [graph = "", hash = "", date, names, message = ""] = line.split("\0");
    // A row of the graph alone.
    if (date === undefined) return [{ text: line, hash, message }];
    // Blank where the star was, so the other branches' lines stay where they are.
    const rails = graph.replace("*", " ");
    if (!names) return [{ text: `${rails}${date}  ${message}`, hash, message }];
    return [{ text: `${rails}${date}${names}`, hash, message }, { text: `${rails}${" ".repeat(date.length + 2)}${message}`, hash, message }];
  });
  // A straight history is left with an empty column where its stars were.
  const indent = Math.min(...rows.map((row) => row.text.search(/\S|$/)));
  return rows.map((row) => ({ ...row, text: row.text.slice(indent) }));
}

// The Git popup's old messages, whole and newest first, and the newest commit's hash and subject,
// the part `rewordHead` edits. Each commit is three NUL-ended fields.
export const MESSAGE_ARGS = ["log", "-n", "100", "--format=%H%x00%s%x00%B%x00"];

export function parseMessages(out: string): { hash: string; subject: string; messages: string[] } {
  const fields = out.split("\0").map((field) => field.trim());
  return { hash: fields[0] ?? "", subject: fields[1] ?? "", messages: fields.filter((field, at) => field && at % 3 === 2) };
}

// A file's text in the last commit (or rev, a reviewed commit or its parent), for the Git popup's diff. file is from the repo's top, as status
// paths are. "" when that commit has no such file (untracked, added), null when it isn't text or
// is too big to show.
export async function headText(git: (...args: string[]) => Promise<string>, file: string, rev = "HEAD"): Promise<string | null> {
  // From the page, so never anything git could read as an option.
  if (!/^(HEAD|[0-9a-f]{7,64}\^?)$/.test(rev)) throw new Error(`Not a commit: ${rev}`);
  // A repo with no commits yet fails this, as does a first commit's parent, which only means there is no such file.
  const listed = await git("ls-tree", "--full-tree", "--name-only", rev, "--", file).catch(() => "");
  if (!listed.trim()) return "";
  const text = await git("show", `${rev}:${file}`);
  return text.includes("\0") || text.length > MAX_EDITABLE ? null : text;
}

// The files one commit changed, against its first parent (a first commit: against nothing), for the
// Git popup's review of it from the Log pane. As status entries, the change being the work tree's
// letter, so they all land in its Changes list. `-z --name-status`: a letter (a rename's with a
// score), NUL, the path, a rename's or copy's old path first.
export async function commitFiles(git: (...args: string[]) => Promise<string>, hash: string): Promise<{ x: string; y: string; path: string; from?: string }[]> {
  if (!/^[0-9a-f]{7,64}$/.test(hash)) throw new Error(`Not a commit: ${hash}`);
  const args = ["diff-tree", "-r", "-z", "--name-status", "-M", "--no-commit-id"];
  const parts = (await git(...args, `${hash}^`, hash).catch(() => git(...args, "--root", hash))).split("\0");
  const files: { x: string; y: string; path: string; from?: string }[] = [];
  for (let at = 0; at + 1 < parts.length; ) {
    const letter = parts[at++]!.charAt(0);
    const from = "RC".includes(letter) ? parts[at++] : undefined;
    files.push({ x: " ", y: letter, path: parts[at++] ?? "", ...(from ? { from } : {}) });
  }
  return files;
}

// A new subject for the checked-out branch's newest commit, pushed. The body stays, and --only keeps
// staged files out of the commit. A failed push puts the old commit back, because no later plain
// push could follow the amended one.
export async function rewordHead(git: (...args: string[]) => Promise<string>, hash: string, subject: string): Promise<void> {
  if (!subject) throw new Error("A commit message is needed.");
  if ((await git("rev-parse", "HEAD")).trim() !== hash) throw new Error("Only the newest commit on the branch can be edited.");
  // With no upstream there is nothing to push to, so only the amend happens.
  const upstream = await git("rev-parse", "--abbrev-ref", "@{u}").catch(() => "");
  if (upstream) {
    // The fetch keeps this check and the push's lease current, so nobody's newer commits are overwritten.
    await git("fetch");
    if ((await git("rev-list", "--count", "HEAD..@{u}")).trim() !== "0") throw new Error(`${upstream.trim()} has commits this branch doesn't. Pull first.`);
  }
  const body = await git("log", "-1", "--format=%b");
  await git("commit", "--amend", "--only", "-m", subject, "-m", body);
  if (!upstream) return;
  try {
    await git("push", "--force-with-lease");
  } catch (error) {
    await git("reset", "--soft", hash);
    throw new Error(`The push failed, so the message is unchanged. ${error instanceof Error ? error.message : String(error)}`);
  }
}
