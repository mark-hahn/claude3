// Self-check for stamp.ts: `node server/stamp.check.mjs` (part of `npm test`).
import assert from "node:assert/strict";
import { stampProblem, stampTime } from "./stamp.ts";

const ok = (...texts) => assert.equal(stampProblem(texts), "", texts.join(" | "));
const bad = (word, ...texts) => assert.match(stampProblem(texts), word, texts.join(" | "));

// Paths redirected into the stamp, however it is addressed.
ok(`printf '%s\\n' src "my dir" > .deployed`);
ok(`printf '%s\\n' "\${SOURCES[@]}" > .deployed # claude3's page warns`);
ok(`printf '%s\\n' src > "$(dirname "$0")/.deployed"`);
ok(`printf '%s\\n' src >./.deployed`);
ok(`deploy_ps -List | tr -d '\\r' > .deployed\necho "== stamped .deployed"`);
ok(`exec ./deploy`, `echo "== stamping"; printf '%s\\n' src > .deployed`);
ok(`{ echo src; echo server; } > .deployed`);

// A touch, with or without another command's redirect beside it.
bad(/only touched/, `./srvr --if-stale && touch .deployed # newer than this`);
bad(/only touched/, `make > build.log 2>&1 && touch .deployed`);
bad(/only touched/, `# printf '%s\\n' src > .deployed\ntouch .deployed`);
bad(/Neither/, `npm run build`);

// An echo's paths land on one line.
bad(/echo/, `echo src server > .deployed`);
bad(/echo/, `echo "\${SOURCES[@]}" > "$here/.deployed"`);

// A stamp written during a run counts from the run's start; any other keeps its own time.
assert.equal(stampTime(500, null), 500);
assert.equal(stampTime(500, { started: 400, ended: 600 }), 400);
assert.equal(stampTime(500, { started: 400 }), 400); // still going
assert.equal(stampTime(700, { started: 400, ended: 600 }), 700); // stamped later, from a terminal
assert.equal(stampTime(300, { started: 400, ended: 600 }), 300); // the run wrote no stamp
assert.equal(stampTime(400 + 600_001, { started: 400 }), 400 + 600_001); // a run that never ended

console.log("stamp.check: ok");
