// Self-check for the markdown renderer, answer text and trash-list picking ported from claude2: `node src/render.check.mjs`.
// The ports un-doubled every backslash of claude2's template-literal source, so a missed one shows here.
import assert from "node:assert/strict";
import { extraBlankLines } from "./blankLines.ts";
import { pick } from "./pick.ts";
import { answerText, renderMarkdown } from "./render.ts";

const T = "⁣"; // TOOL_LINE_MARK
const A = "⁤"; // ANSWER_MARK

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

// The Snips' blank lines after a removal: only those at or beside it come down to one.
const extras = (lines, removedAt) => extraBlankLines(lines.length, (line) => !lines[line - 1].trim(), removedAt);
assert.deepEqual(extras(["a", "", "", "", "b"], [3]), [3, 4]);
assert.deepEqual(extras(["a", "", "", "b", "", "", "c"], [2]), [3]);
assert.deepEqual(extras(["a", "", "b"], [2]), []);
// A removal that left text on its line: the runs on each side of that line.
assert.deepEqual(extras(["", "", "x", " ", ""], [3]), [2, 5]);
// Two removals in one run name each line once, or Monaco throws on the overlap.
assert.deepEqual(extras(["a", "", "", "b"], [2, 3]), [3]);
console.log("render checks passed");
