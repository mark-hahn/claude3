// The alias table read out of the CLI binary (server/cliAliases.ts), on pieces shaped like the real one:
// minified JavaScript text with the aliases as a quoted array, found 2026-11-19 in claude 2.1.325.
import assert from "node:assert/strict";
import { aliasesIn } from "./cliAliases.ts";

const filler = (n) => "x".repeat(n);
const real = ["sonnet", "opus", "haiku", "fable", "best", "sonnet[1m]", "opus[1m]", "fable[1m]", "opusplan"];
const piece = (names, before = 900, after = 900) => Buffer.from(`${filler(before)},$ee=[${names.map((n) => `"${n}"`).join(",")}],Uee=["sonnet","opus","haiku","fable"];var Axt="cl${filler(after)}`, "latin1");

// The table, with the four-name array beside it ignored (the longest wins).
assert.deepEqual(aliasesIn(piece(real)), real);
// A new alias anywhere in it shows up; so does a removed one.
assert.deepEqual(aliasesIn(piece([...real, "newone"])), [...real, "newone"]);
assert.deepEqual(aliasesIn(piece(real.filter((name) => name !== "best"))), real.filter((name) => name !== "best"));
assert.deepEqual(aliasesIn(piece(["haiku", "opus", "sonnet", "opusplan"])), ["haiku", "opus", "sonnet", "opusplan"]);
// Short pieces and ones with the table at an edge.
assert.deepEqual(aliasesIn(piece(real, 0, 0)), real);
// The length-prefixed copy of the names (NUL-separated, as the binary also has them) is not an array.
assert.deepEqual(aliasesIn(Buffer.from("claude-sonnet-4-0\0\0\0sonnet\0\0\x04opus\0haiku\0fable\0best\0opusplan\0", "latin1")), []);
// Other arrays with "opus" in them that are not names (a model id has a hyphen) don't count.
assert.deepEqual(aliasesIn(Buffer.from('["claude-opus-4-0","claude-opus-4-1"],["x","opus"]', "latin1")), ["x", "opus"]);
assert.deepEqual(aliasesIn(Buffer.from("nothing here", "latin1")), []);
console.log("aliases.check: ok");
