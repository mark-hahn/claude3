// Ported from claude2's conversation webview (webviews.ts): how a response's stored text becomes a
// box. The text carries the runner's invisible marks (shared/types.ts): tool lines, their detail
// lines, and the line where the closing answer starts.
import { ANSWER_MARK, TOOL_DETAIL_MARK, TOOL_LINE_MARK } from "../shared/types.ts";

// The graft plugin closes a response with a savings tally line opening with this sprout. Every
// view of a response drops those lines.
const GRAFT_TALLY_MARK = "🌱";

export function isToolLine(line: string): boolean {
  return line.startsWith(TOOL_LINE_MARK);
}

// A line of the stored detail under a tool line, which carries the detail mark after the tool mark.
function isDetailLine(line: string): boolean {
  return line.startsWith(TOOL_LINE_MARK + TOOL_DETAIL_MARK);
}

// A response without the stored tool-line details: what a box shows with every call closed.
export function withoutDetails(text: string): string {
  return text.split("\n").filter((line) => !isDetailLine(line)).join("\n");
}

// What the markdown box renders: the response without its tool lines, no leading blanks, runs of
// blank lines collapsed to one so the paragraph breaks survive.
function strippedText(text: string): string {
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (isToolLine(line) || line.startsWith(GRAFT_TALLY_MARK)) continue;
    if (!line.trim() && (!kept.length || !kept[kept.length - 1]!.trim())) continue;
    kept.push(line);
  }
  while (kept.length && !kept[kept.length - 1]!.trim()) kept.pop();
  return kept.join("\n");
}

// What a closed-tools box renders: the closing answer, the work above its mark hiding with the tool
// lines. A run that never marked one (stopped, failed, still streaming) keeps all its text.
export function answerText(text: string): string {
  return strippedText(text.split("\n" + ANSWER_MARK + "\n").pop() ?? "");
}

// Fills a box with the response. With tools hidden that is the closing answer alone. With them
// shown, where the run marked the start of its answer, it sits under a rule of its own.
// openCalls holds turnId:n for the tool lines showing their detail.
export function fillBox(box: HTMLElement, text: string, tools: boolean, turnId: string, openCalls: Set<string>): void {
  box.replaceChildren();
  if (!tools) {
    box.insertAdjacentHTML("beforeend", renderMarkdown(answerText(text)));
    return;
  }
  const parts = text.split("\n" + ANSWER_MARK + "\n");
  // Tool calls are numbered across both parts, so each keeps one key in openCalls.
  const calls = { turnId, count: 0, openCalls };
  appendResponse(box, parts[0] ?? "", calls);
  if (parts.length > 1) {
    const rule = document.createElement("hr");
    rule.className = "answer-rule";
    box.appendChild(rule);
    appendResponse(box, parts.slice(1).join("\n"), calls);
  }
}

// Adds response text to a box as markdown, each run of tool lines sitting between the prose around
// it as a monospace group; tool lines are plain text except for a leading **bold** tool name.
// Blank lines do not end a group.
function appendResponse(box: HTMLElement, text: string, calls: { turnId: string; count: number; openCalls: Set<string> }): void {
  let prose: string[] = [];
  let group: HTMLElement | null = null;
  // The tool call whose detail lines, if it has any, come next.
  let call: HTMLElement | null = null;
  const flushProse = (): void => {
    const kept = strippedText(prose.join("\n"));
    if (kept) box.insertAdjacentHTML("beforeend", renderMarkdown(kept));
    prose = [];
  };
  for (const line of text.split("\n")) {
    if (!isToolLine(line)) {
      prose.push(line);
      if (line.trim() && !line.startsWith(GRAFT_TALLY_MARK)) group = null;
      call = null;
      continue;
    }
    flushProse();
    // A call is its short line plus a hidden copy of its detail; the .open class swaps which shows.
    if (isDetailLine(line)) {
      if (!call) continue;
      let long = call.querySelector<HTMLElement>(".tool-long");
      if (long) long.appendChild(document.createTextNode("\n"));
      else {
        long = document.createElement("span");
        long.className = "tool-long";
        call.appendChild(long);
        call.classList.add("has-detail");
      }
      appendFormattedLine(long, line.slice(TOOL_LINE_MARK.length + TOOL_DETAIL_MARK.length));
      continue;
    }
    if (group) group.appendChild(document.createTextNode("\n"));
    else {
      group = document.createElement("div");
      group.className = "tool-group";
      box.appendChild(group);
    }
    call = document.createElement("span");
    call.className = "tool-call";
    call.dataset.call = String(calls.count++);
    if (calls.openCalls.has(calls.turnId + ":" + call.dataset.call)) call.classList.add("open");
    const short = document.createElement("span");
    short.className = "tool-short";
    appendFormattedLine(short, line);
    call.appendChild(short);
    group.appendChild(call);
  }
  flushProse();
}

function appendFormattedLine(box: HTMLElement, line: string): void {
  if (isToolLine(line)) line = line.slice(TOOL_LINE_MARK.length);
  // Tool lines open with an "hh:mm:ss " timestamp ahead of the bold name.
  const bold = /^(\d\d:\d\d:\d\d )?\*\*([^*]+)\*\*/.exec(line);
  if (!bold) {
    box.appendChild(document.createTextNode(line));
    return;
  }
  if (bold[1]) box.appendChild(document.createTextNode(bold[1]));
  const name = document.createElement("b");
  name.textContent = bold[2] ?? "";
  box.appendChild(name);
  box.appendChild(document.createTextNode(line.slice(bold[0].length)));
}

// The markdown renderer, deliberately small: the blocks Claude actually emits (headings, fences,
// lists, quotes, tables, rules) and the inline runs inside them.
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Inline runs. Code spans are lifted out first so nothing inside them is treated as markup, and
// only http(s) links are kept as links.
function inline(text: string): string {
  const codes: string[] = [];
  let out = escapeHtml(text).replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(code);
    return "\u0000" + (codes.length - 1) + "\u0000";
  });
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => "<code>" + codes[Number(index)] + "</code>");
}

interface ListItem {
  indent: number;
  offset: number;
  ordered: boolean;
  text: string;
}

// The offset is where the item's text starts, which is how far a continuation line under it is
// indented; the indent is the marker's own column, which is what nesting goes by.
function listItemOf(line: string): ListItem | null {
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return { indent: bullet[1]!.length, offset: line.length - bullet[2]!.length, ordered: false, text: bullet[2]! };
  const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
  if (numbered) return { indent: numbered[1]!.length, offset: line.length - numbered[2]!.length, ordered: true, text: numbered[2]! };
  return null;
}

function buildList(items: (Omit<ListItem, "text"> & { lines: string[] })[]): string {
  const parts: string[] = [];
  let index = 0;
  while (index < items.length) {
    const item = items[index]!;
    const nested = [];
    let next = index + 1;
    while (next < items.length && items[next]!.indent > item.indent) {
      nested.push(items[next]!);
      next++;
    }
    const body = item.lines.join("\n");
    let inner = item.lines.length > 1 ? renderMarkdown(body) : inline(body);
    if (nested.length) inner += buildList(nested);
    parts.push("<li>" + inner + "</li>");
    index = next;
  }
  const tag = items[0]!.ordered ? "ol" : "ul";
  return "<" + tag + ">" + parts.join("") + "</" + tag + ">";
}

function tableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

export function renderMarkdown(text: string): string {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (!paragraph.length) return;
    out.push("<p>" + inline(paragraph.join("\n")).replace(/\n/g, "<br>") + "</p>");
    paragraph = [];
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flush();
      const marker = fence[1]!.charAt(0);
      const body = [];
      index++;
      while (index < lines.length && !new RegExp("^\\s*" + marker + "{3,}\\s*$").test(lines[index]!)) {
        body.push(lines[index]);
        index++;
      }
      index++;
      out.push("<pre><code>" + escapeHtml(body.join("\n")) + "</code></pre>");
      continue;
    }
    if (!line.trim()) {
      flush();
      index++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      out.push("<h" + level + ">" + inline(heading[2]!.replace(/\s+#+\s*$/, "")) + "</h" + level + ">");
      index++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      index++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const quoted = [];
      while (index < lines.length && (/^\s*>/.test(lines[index]!) || (quoted.length && lines[index]!.trim()))) {
        quoted.push(lines[index]!.replace(/^\s*>\s?/, ""));
        index++;
      }
      out.push("<blockquote>" + renderMarkdown(quoted.join("\n")) + "</blockquote>");
      continue;
    }
    const next = lines[index + 1];
    if (line.indexOf("|") >= 0 && next !== undefined && /^\s*\|?[\s:-]*-[\s|:-]*$/.test(next) && next.indexOf("-") >= 0) {
      flush();
      const head = tableRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index]!.indexOf("|") >= 0 && lines[index]!.trim()) {
        rows.push(tableRow(lines[index]!));
        index++;
      }
      const headHtml = "<tr>" + head.map((cell) => "<th>" + inline(cell) + "</th>").join("") + "</tr>";
      const bodyHtml = rows.map((row) => "<tr>" + row.map((cell) => "<td>" + inline(cell) + "</td>").join("") + "</tr>").join("");
      out.push("<table>" + headHtml + bodyHtml + "</table>");
      continue;
    }
    if (listItemOf(line)) {
      flush();
      const items: (Omit<ListItem, "text"> & { lines: string[] })[] = [];
      while (index < lines.length) {
        const item = listItemOf(lines[index]!);
        // Bullets switching to numbers (or back) at the top level start a new list rather than
        // joining this one, which would take the tag of whichever came first.
        if (item && items.length && item.indent <= items[0]!.indent && item.ordered !== items[0]!.ordered) break;
        if (item) {
          items.push({ indent: item.indent, offset: item.offset, ordered: item.ordered, lines: [item.text] });
          index++;
          continue;
        }
        const owner = items[items.length - 1];
        // A blank line inside a list is kept only when a list line or an indented continuation
        // follows it; an indented line that is not a new item continues the item above, keeping
        // any indentation past the item's own.
        const after = lines[index + 1] || "";
        if (!lines[index]!.trim() && owner && (listItemOf(after) || /^\s{2,}\S/.test(after))) {
          owner.lines.push("");
          index++;
          continue;
        }
        if (owner && /^\s{2,}\S/.test(lines[index]!)) {
          const lead = lines[index]!.length - lines[index]!.replace(/^\s+/, "").length;
          owner.lines.push(lines[index]!.slice(Math.min(lead, owner.offset)));
          index++;
          continue;
        }
        break;
      }
      out.push(buildList(items));
      continue;
    }
    paragraph.push(line);
    index++;
  }
  flush();
  return out.join("");
}
