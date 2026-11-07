// Self-check for the markdown renderer and answer text ported from claude2: `node src/render.check.mjs`.
// The ports un-doubled every backslash of claude2's template-literal source, so a missed one shows here.
import assert from "node:assert/strict";
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
console.log("render checks passed");
