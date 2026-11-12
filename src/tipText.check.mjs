// Every data-help / data-mode name in src/ has a block in tip-text.txt, and every block's name is used
// (keyHelp.ts's "global keys" by the ? button). Run by npm test.
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL(".", import.meta.url);
const blocks = readFileSync(new URL("tip-text.txt", dir), "utf8").split(/^@/m).slice(1).map((block) => block.split("\n")[0].trim());
const used = new Set(["global keys"]);
for (const entry of readdirSync(dir, { recursive: true })) {
  if (!/\.(vue|ts)$/.test(entry)) continue;
  const text = readFileSync(new URL(entry, dir), "utf8");
  for (const [, name] of text.matchAll(/(?:(?<!:)data-(?:help|mode)=|dataset\.(?:help|mode) = )"([^"]+)"/g)) used.add(name);
  // A bound one, as :data-help="line.hash ? 'Log row' : undefined": its quoted names.
  for (const [, bound] of text.matchAll(/:data-(?:help|mode)="([^"]+)"/g)) for (const [, name] of bound.matchAll(/'([^']+)'/g)) used.add(name);
}
const problems = [
  ...blocks.filter((name, at) => blocks.indexOf(name) !== at).map((name) => `@${name} is in tip-text.txt twice`),
  ...[...used].filter((name) => !blocks.includes(name)).map((name) => `"${name}" has no @${name} block in tip-text.txt`),
  ...blocks.filter((name) => !used.has(name)).map((name) => `@${name} in tip-text.txt is on no element`),
];
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`tip-text.txt: ${blocks.length} blocks, all used`);
