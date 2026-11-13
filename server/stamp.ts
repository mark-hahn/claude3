// The parts of the deploy stamp's rules that need no project to try: `npm test` runs them
// (server/stamp.check.mjs). The rest is deployNeeded and deployCheck in main.ts.

// What is wrong with how ./run and ./deploy (their texts) write the stamp .deployed, or "" when one
// of them redirects its paths into it. The stamp holds the deploy's paths, one per line
// (`printf '%s\n' ... > .deployed`). A bare touch is the old kind, which counts every file, docs
// included, and comes with a deploy that redoes everything. An echo puts every path on one line,
// which reads as a single path that matches nothing.
export function stampProblem(texts: string[]): string {
  // A comment line says nothing about what the script does.
  const code = texts.map((text) => text.replace(/^\s*#.*$/gm, ""));
  // A redirect to .deployed at any path (> .deployed, > "$dir/.deployed"), within one command.
  if (!code.some((text) => />[^\n;|&]*\.deployed\b/.test(text))) {
    return texts.some((text) => text.includes(".deployed"))
      ? "The stamp .deployed is only touched: the deploy should write the paths it depends on into it, one per line (printf '%s\\n' ... > .deployed)."
      : "Neither ./run nor ./deploy writes .deployed, the stamp the deploy warning reads.";
  }
  if (code.some((text) => /\becho\b[^\n;|&]*>[^\n;|&]*\.deployed\b/.test(text))) {
    return "The stamp .deployed is written with echo, all on one line: it needs one path per line (printf '%s\\n' ... > .deployed).";
  }
  return "";
}

// The time a stamp counts from. One written while the Run button's ./run was going (started to
// ended; no end yet while it goes on) counts from that run's start: a file saved during the deploy
// may have missed it. A run whose end was never written stops mattering after ten minutes.
// A run that printed its frozen line (FROZEN_LINE) counts from that time instead: it writes its own
// sources (a code generator) before then and copies none until after, so what was saved before it
// was deployed.
export function stampTime(stamp: number, run: { started: number; ended?: number; frozen?: number } | null): number {
  if (!run || !(run.started < stamp && stamp <= (run.ended ?? run.started + 600_000))) return stamp;
  return run.frozen && run.frozen > run.started && run.frozen <= stamp ? run.frozen : run.started;
}

// The line a ./run prints, with the epoch ms it took the time at, once its own writes to its
// sources are done and before it copies any: `echo "== sources frozen $(date +%s%3N)"`.
export const FROZEN_LINE = /^== sources frozen (\d+)\s*$/m;
