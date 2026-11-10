// The Git pane's lines, from `git log --graph`: one per commit, with no star and no hash on show,
// though each knows its commit's full hash and message, for copying. A commit with branch or tag names has its message on a
// second line, in the column where the messages on the other lines start.

// After the graph's own characters, which git puts first, the fields are split by NULs.
// ponytail: the newest 1000 commits; page it if older history is ever wanted.
export const GRAPH_ARGS = ["log", "--graph", "--all", "--no-color", "--date=format:%Y-%m-%d %H:%M", "--format=%x00%H%x00%ad%x00%d%x00%s", "-n", "1000"];

export function layoutGraph(out: string): { text: string; hash: string; message: string }[] {
  const rows = out.trimEnd().split("\n").flatMap((line) => {
    const [graph = "", hash = "", date, names, message = ""] = line.split("\0");
    // A row of the graph alone.
    if (date === undefined) return [{ text: line, hash, message }];
    // Blank where the star was, so the other branches' lines stay where they are.
    const rails = graph.replace("*", " ");
    if (!names) return [{ text: `${rails}${date} ${message}`, hash, message }];
    return [{ text: `${rails}${date}${names}`, hash, message }, { text: `${rails}${" ".repeat(date.length + 1)}${message}`, hash, message }];
  });
  // A straight history is left with an empty column where its stars were.
  const indent = Math.min(...rows.map((row) => row.text.search(/\S|$/)));
  return rows.map((row) => ({ ...row, text: row.text.slice(indent) }));
}
