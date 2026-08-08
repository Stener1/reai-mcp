#!/usr/bin/env node
/**
 * How many storage claims does this repository make, and how many are probed?
 *
 * `test/storage-drift.test.mjs` used to say the population "cannot be measured mechanically". The review
 * of PR #115 measured it, so this prints the number instead of hiding behind prose. It is a LOWER BOUND —
 * a keyword sweep over agent-facing string literals — which is why it is a script rather than an
 * assertion: pinning a fuzzy number is the false precision this repository keeps paying for.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const STORAGE =
  /\b(stored|stores|normalis|normaliz|title.?cas|canonicalis|defaults? to|rounded|discard|overwrit|silently|comes? back)\b/i;

const files = [
  ...readdirSync("src/tools").filter((f) => f.endsWith(".ts")).map((f) => path.join("src/tools", f)),
  "src/reai/quirks.ts",
];

let total = 0;
const perFile = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  let count = 0;
  for (const m of text.matchAll(/"((?:[^"\\]|\\.){20,300})"/g)) {
    if (STORAGE.test(m[1])) count += 1;
  }
  if (count > 0) perFile.push([file, count]);
  total += count;
}

const audit = readFileSync("scripts/audit-storage.mjs", "utf8");
const probed = [...audit.matchAll(/claim:\s*\n?\s*"/g)].length;

perFile.sort((a, b) => b[1] - a[1]);
for (const [file, count] of perFile) console.log(`${String(count).padStart(4)}  ${file}`);
console.log(`\n${total} agent-facing literals assert something about what is STORED (lower bound).`);
console.log(`${probed} are probed by scripts/audit-storage.mjs.`);
console.log(
  `\nThe gap is the point: this is a floor to raise, not a completeness claim. The cheap unprobed ones\n` +
    `are listed in the header of test/storage-drift.test.mjs.`,
);
