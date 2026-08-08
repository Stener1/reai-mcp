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

// Both quote styles. The first version counted double-quoted fragments only, and the review of PR #116
// measured 49 additional BACKTICK literals matching the same keywords in the same files — including every
// `.describe(\`Phone number. ${PHONE_RULE}\`)`, so the five consumers of the most error-prone rule in the
// repository were invisible to the census that was supposed to expose them.
//
// Fragments are also DEDUPED per file. A concatenated string is many literals: PHONE_RULE alone is six,
// two of which match, so one claim counted twice. This is still a lower bound — it counts literals, not
// claims — but a lower bound that double-counts is not a bound at all.
let total = 0;
const perFile = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const seen = new Set();
  for (const m of text.matchAll(/"((?:[^"\\]|\\.){20,300})"|`((?:[^`\\]|\\.){20,300})`/g)) {
    const literal = m[1] ?? m[2];
    if (!STORAGE.test(literal)) continue;
    seen.add(literal.replace(/\s+/g, " ").trim());
  }
  if (seen.size > 0) perFile.push([file, seen.size]);
  total += seen.size;
}

const audit = readFileSync("scripts/audit-storage.mjs", "utf8");
const probed = [...audit.matchAll(/claim:\s*\n?\s*"/g)].length;
const distinctSources = new Set([...audit.matchAll(/source:\s*"([^"]+)"/g)].map(([, x]) => x)).size;

perFile.sort((a, b) => b[1] - a[1]);
for (const [file, count] of perFile) console.log(`${String(count).padStart(4)}  ${file}`);
console.log(`\n${total} distinct agent-facing literals assert something about what is STORED.`);
console.log(`${probed} probes cover them, binding to ${distinctSources} distinct source texts.`);
console.log(
  `\nThose are different units — literals counted here, probes counted there — so this is not a\n` +
    `percentage and must not be read as one. It is a floor with a direction.`,
);
console.log(
  `\nThe gap is the point: this is a floor to raise, not a completeness claim. The cheap unprobed ones\n` +
    `are listed in the header of test/storage-drift.test.mjs.`,
);
