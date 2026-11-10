// The Git pane's lines, from `git log --graph`: one per commit, with no star and no hash on show,
// though each knows its commit's full hash and message, for copying. A commit with branch or tag names has its message on a
// second line, in the column where the messages on the other lines start. The checked-out branch's
// newest commit always has names, and its message line is editable: older commits would need a rebase.

// After the graph's own characters, which git puts first, the fields are split by NULs.
// ponytail: the newest 1000 commits; page it if older history is ever wanted.
export const GRAPH_ARGS = ["log", "--graph", "--all", "--no-color", "--date=format:%Y-%m-%d %H:%M", "--format=%x00%H%x00%ad%x00%d%x00%s", "-n", "1000"];

export function layoutGraph(out: string): { text: string; hash: string; message: string; editable?: boolean }[] {
  const rows = out.trimEnd().split("\n").flatMap((line) => {
    const [graph = "", hash = "", date, names, message = ""] = line.split("\0");
    // A row of the graph alone.
    if (date === undefined) return [{ text: line, hash, message }];
    // Blank where the star was, so the other branches' lines stay where they are.
    const rails = graph.replace("*", " ");
    if (!names) return [{ text: `${rails}${date} ${message}`, hash, message }];
    return [{ text: `${rails}${date}${names}`, hash, message }, { text: `${rails}${" ".repeat(date.length + 1)}${message}`, hash, message, editable: names.includes("HEAD -> ") }];
  });
  // A straight history is left with an empty column where its stars were.
  const indent = Math.min(...rows.map((row) => row.text.search(/\S|$/)));
  return rows.map((row) => ({ ...row, text: row.text.slice(indent) }));
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
