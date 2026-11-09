// Self-check for the markdown renderer, answer text and trash-list picking ported from claude2: `node src/render.check.mjs`.
// The ports un-doubled every backslash of claude2's template-literal source, so a missed one shows here.
import assert from "node:assert/strict";
import { AUTH_FAILED, imageNote, typedPrompt } from "../shared/types.ts";
import { extraBlankLines, headingEnter } from "./blankLines.ts";
import { cropRect } from "./cropRect.ts";
import { pick } from "./pick.ts";
import { answerText, renderMarkdown } from "./render.ts";
import { byName, folderName, foldersBetween, nextTab, sameName } from "./tabList.ts";
import { fileActions, numberedName } from "../server/files.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The Files pane: a clash's index goes before the extension, and a picked folder opens down from the root.
assert.equal(numberedName("new-file", 0), "new-file");
assert.equal(numberedName("new-file", 2), "new-file(2)");
assert.equal(numberedName("report.pdf", 1), "report(1).pdf");
assert.equal(numberedName(".bashrc", 1), ".bashrc(1)");
assert.deepEqual(foldersBetween("/a/b", "/a/b/c/d"), ["/a/b/c", "/a/b/c/d"]);
assert.deepEqual(foldersBetween("/", "/a"), ["/a"]);
assert.deepEqual(foldersBetween("C:\\x", "C:\\x\\y"), ["C:\\x\\y"]);
assert.equal(foldersBetween("/a/b", "/a/bc"), null, "a sibling with the root's name in it");
assert.equal(foldersBetween("/a/b", "/a/b"), null);

// On disk: nothing is overwritten, folders sort first, and a stale save is refused.
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "claude3-files-"));
await fileActions.newFile({ folder });
await fileActions.newFile({ folder });
fs.mkdirSync(path.join(folder, "zdir"));
fs.mkdirSync(path.join(folder, ".git"));
const { listings } = await fileActions.listFiles({ paths: [folder] });
assert.deepEqual(listings[folder].map((entry) => entry.name), ["zdir", "new-file", "new-file(1)"]);
await assert.rejects(async () => fileActions.renamePath({ path: path.join(folder, "new-file"), name: "new-file(1)" }), /already exists/);
await assert.rejects(async () => fileActions.renamePath({ path: path.join(folder, "new-file"), name: "../out" }), /can't be a file name/);
await assert.rejects(async () => fileActions.deletePath({ path: "relative" }), /not a full path/);
const edited = path.join(folder, "new-file");
const { mtime } = await fileActions.readFile({ path: edited });
const saved = await fileActions.saveFile({ path: edited, text: "mine", mtime });
assert.deepEqual((await fileActions.saveFile({ path: edited, text: "stale", mtime: saved.mtime - 5000 })).conflict, true);
assert.equal(fs.readFileSync(edited, "utf8"), "mine");
assert.equal((await fileActions.readFile({ path: edited, known: saved.mtime })).text, undefined, "unchanged: no text");
fs.writeFileSync(edited, Buffer.from([0x61, 0x00]));
assert.equal((await fileActions.readFile({ path: edited })).text, null, "binary");
fs.writeFileSync(edited, Buffer.from([0xe9]));
assert.equal((await fileActions.readFile({ path: edited })).text, null, "not UTF-8");
// Search goes down the tree in its own order, into closed folders, then round to the top; a link
// back up the tree can't trap it.
const inner = path.join(folder, "zdir", "New-inner");
fs.writeFileSync(inner, "");
fs.symlinkSync(folder, path.join(folder, "zdir", "loop"));
const after = async (from) => (await fileActions.findFile({ root: folder, text: "NEW", after: from })).path;
assert.equal(await after(""), inner, "folders first, whatever the case");
assert.equal(await after(inner), edited);
assert.equal(await after(edited), `${edited}(1)`);
assert.equal(await after(`${edited}(1)`), inner, "round to the top");
assert.equal((await fileActions.findFile({ root: folder, text: "absent", after: "" })).path, null);
const before = async (from) => (await fileActions.findFile({ root: folder, text: "NEW", after: from, backward: true })).path;
assert.equal(await before(edited), inner, "one step back");
assert.equal(await before(inner), `${edited}(1)`, "round to the bottom");
assert.equal(await before(""), `${edited}(1)`, "new text going backward: the last one");
// node_modules only when asked, the folder's own name included.
const buried = path.join(folder, "zdir", "node_modules", "buried");
fs.mkdirSync(path.dirname(buried));
fs.writeFileSync(buried, "");
const findIn = async (text, nodeModules) => (await fileActions.findFile({ root: folder, text, after: "", nodeModules })).path;
assert.equal(await findIn("buried", false), null);
assert.equal(await findIn("node_modules", false), null);
assert.equal(await findIn("buried", true), buried);
fs.rmSync(folder, { recursive: true });

// Ctrl-X's move: nothing in its own folder, a free name on a clash, and across disks (/dev/shm is another one).
const moves = fs.mkdtempSync(path.join(os.tmpdir(), "claude3-move-"));
const moving = path.join(moves, "item.txt");
const into = path.join(moves, "into");
fs.writeFileSync(moving, "x");
fs.mkdirSync(into);
fs.writeFileSync(path.join(into, "item.txt"), "already here");
assert.deepEqual(await fileActions.movePath({ path: moving, folder: moves }), { path: moving }, "its own folder");
const landed = (await fileActions.movePath({ path: moving, folder: into })).path;
assert.equal(landed, path.join(into, "item(1).txt"));
assert.equal(fs.readFileSync(landed, "utf8"), "x");
assert.equal(fs.readFileSync(path.join(into, "item.txt"), "utf8"), "already here");
assert.ok(!fs.existsSync(moving));
if (fs.existsSync("/dev/shm")) {
  const otherDisk = fs.mkdtempSync("/dev/shm/claude3-move-");
  const crossed = (await fileActions.movePath({ path: landed, folder: otherDisk })).path;
  assert.equal(fs.readFileSync(crossed, "utf8"), "x");
  assert.ok(!fs.existsSync(landed), "the original goes too");
  fs.rmSync(otherDisk, { recursive: true });
}
// The editor's tail mode: a change is answered at once with its text; a missing file is refused.
const tailed = path.join(into, "tailed.txt");
fs.writeFileSync(tailed, "one");
const waitStarted = Date.now();
const waited = fileActions.waitFile({ path: tailed, known: fs.statSync(tailed).mtimeMs });
setTimeout(() => fs.appendFileSync(tailed, " two"), 100);
assert.equal((await waited).text, "one two");
assert.ok(Date.now() - waitStarted < 1500, "a change doesn't wait out the 2s");
await assert.rejects(async () => fileActions.waitFile({ path: path.join(into, "absent"), known: 0 }), /ENOENT/);
fs.rmSync(moves, { recursive: true });

// The CLI's own words for a login that's gone send the prompt back; any other failure keeps its turn.
assert.ok(AUTH_FAILED.test("Failed to authenticate: OAuth session expired and could not be refreshed"));
assert.ok(AUTH_FAILED.test("Not logged in · Please run /login"));
assert.ok(!AUTH_FAILED.test("Claude CLI exited with code 1."));

// A new project's default name is its folder's, written as the path writes it, on either host's paths.
assert.equal(folderName("/root/apps/MyProj/"), "MyProj");
assert.equal(folderName("C:\\Users\\mark\\apps\\ham"), "ham");
assert.equal(folderName(""), "");
assert.ok(sameName("TV", "tv"));
assert.ok(!sameName("tv", "tv srvr"));

// Tabs sort without regard to case; closing the one on show moves on to the next open one by name.
const named = (label, open = true) => ({ id: label, label, host: "wsl", path: `/${label}`, open });
const list = [named("alpha"), named("Beta", false), named("gamma"), named("Zed")];
assert.deepEqual([named("Zed"), named("gamma"), named("alpha")].sort(byName).map((tab) => tab.label), ["alpha", "gamma", "Zed"]);
assert.equal(nextTab(list, list[1]), "gamma", "the next open one after it");
assert.equal(nextTab(list, list[3]), "Zed", "the last when it was the last");
assert.equal(nextTab(list, undefined), "alpha", "the first with nothing to go by");
assert.equal(nextTab([named("a", false)], named("a", false)), "", "none open");

const T = "⁣"; // TOOL_LINE_MARK
const A = "⁤"; // ANSWER_MARK

// A picture's sentence comes back off what the prompt bar shows, on either host's paths.
const notes = `\n\n${imageNote("/root/.claude3/images/s/a.png")}\n\n${imageNote("C:\\Users\\mark\\.claude3\\images\\s\\b.png")}`;
assert.equal(typedPrompt(`look at this${notes}`), "look at this");
assert.equal(typedPrompt(notes), "");
assert.equal(typedPrompt("no pictures\n\n[but brackets]"), "no pictures\n\n[but brackets]");

// A 200x100 picture letterboxed in a 400x400 box sits at y 100-300, twice its size.
const box = { left: 0, top: 0, width: 400, height: 400 };
const natural = { width: 200, height: 100 };
const crop = (fromX, fromY, toX, toY) => {
  const { x, y, w, h } = cropRect(box, natural, { x: fromX, y: fromY }, { x: toX, y: toY });
  return [x, y, w, h];
};
assert.deepEqual(crop(40, 120, 240, 220), [20, 10, 100, 50]);
// Dragged backwards, the same rectangle.
assert.deepEqual(crop(240, 220, 40, 120), [20, 10, 100, 50]);
// Both ends clamp onto the picture, off the letterbox bands and past the box.
assert.deepEqual(crop(-50, 0, 900, 900), [0, 0, 200, 100]);

assert.equal(renderMarkdown("# Title ##"), "<h1>Title</h1>");
assert.equal(renderMarkdown("a **b** *c* `<d>` [e](https://x.y)"), '<p>a <strong>b</strong> <em>c</em> <code>&lt;d&gt;</code> <a href="https://x.y" target="_blank" rel="noreferrer">e</a></p>');
assert.equal(renderMarkdown("line one\nline two\n\nnext"), "<p>line one<br>line two</p><p>next</p>");
assert.equal(renderMarkdown("```js\nif (a < b) {}\n```"), "<pre><code>if (a &lt; b) {}</code></pre>");
assert.equal(renderMarkdown("- a\n  - b\n- c"), "<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>");
assert.equal(renderMarkdown("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>");
assert.equal(renderMarkdown("| h1 | h2 |\n|---|---|\n| a | b |"), "<table><tr><th>h1</th><th>h2</th></tr><tr><td>a</td><td>b</td></tr></table>");
assert.equal(renderMarkdown("> quoted\n\n---"), "<blockquote><p>quoted</p></blockquote><hr>");

// Tools hidden: the work above the answer mark goes, and so do tool lines and graft tallies.
const response = `${T}10:00:00 **Started:** Sat\nworking prose\n\n${A}\n\nThe answer.\n\n🌱 graft saved 1k\n${T}10:00:05 **Finished:** =======\n`;
assert.equal(answerText(response), "The answer.");
// A run with no mark (stopped, still streaming) keeps its prose.
assert.equal(answerText(`${T}10:00:00 **Started:** Sat\npartial text\n`), "partial text");

const ids = ["a", "b", "c", "d"];
const plain = { ctrlKey: false, shiftKey: false };
const ctrl = { ctrlKey: true, shiftKey: false };
const shift = { ctrlKey: false, shiftKey: true };
const picked = new Set();
let anchor = pick(picked, ids, "b", "", plain);
assert.deepEqual([...picked], ["b"]);
// A plain click on the only picked card keeps it picked.
assert.equal(pick(picked, ids, "b", anchor, plain), "b");
assert.deepEqual([...picked], ["b"]);
anchor = pick(picked, ids, "d", anchor, ctrl);
assert.deepEqual([...picked].sort(), ["b", "d"]);
anchor = pick(picked, ids, "d", anchor, ctrl);
assert.deepEqual([...picked], ["b"]);
// Shift adds the run, from either side of the anchor, and keeps the anchor.
assert.equal(pick(picked, ids, "c", "a", shift), "a");
assert.deepEqual([...picked].sort(), ["a", "b", "c"]);
pick(picked, ids, "d", anchor, plain);
assert.equal(pick(picked, ids, "b", "d", shift), "d");
assert.deepEqual([...picked].sort(), ["b", "c", "d"]);
// A shift-click with no anchor on show picks just that card.
assert.equal(pick(picked, ids, "a", "gone", shift), "a");
assert.deepEqual([...picked], ["a"]);

// Enter at the end of a heading: a blank line above unless one is there, an item at the left edge.
assert.equal(headingEnter("## modes", "", "- a"), "\n## modes\n- ");
assert.equal(headingEnter("  # x", "", "  "), "# x\n- ");
assert.equal(headingEnter("# top", "", ""), "# top\n- ");
// White space and a "- " before the # come off; a dash later in the heading stays.
assert.equal(headingEnter("- ## modes", "", "- a"), "\n## modes\n- ");
assert.equal(headingEnter("  -   # x", "", ""), "# x\n- ");
assert.equal(headingEnter("# a - b", "", ""), "# a - b\n- ");
assert.equal(headingEnter("- a # x", "", "b"), null);
// Not at the end of the line, or no heading before the caret.
assert.equal(headingEnter("# x", "y", "a"), null);
assert.equal(headingEnter("", "", "a"), null);
assert.equal(headingEnter("a # x", "", "a"), null);

// The Snips' blank lines after a removal: only those at or beside it come down to one.
const extras =(lines, removedAt) => extraBlankLines(lines.length, (line) => !lines[line - 1].trim(), removedAt);
assert.deepEqual(extras(["a", "", "", "", "b"], [3]), [3, 4]);
assert.deepEqual(extras(["a", "", "", "b", "", "", "c"], [2]), [3]);
assert.deepEqual(extras(["a", "", "b"], [2]), []);
// A removal that left text on its line: the runs on each side of that line.
assert.deepEqual(extras(["", "", "x", " ", ""], [3]), [2, 5]);
// Two removals in one run name each line once, or Monaco throws on the overlap.
assert.deepEqual(extras(["a", "", "", "b"], [2, 3]), [3]);
console.log("render checks passed");
