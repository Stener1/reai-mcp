#!/usr/bin/env node
/**
 * What did a ranking change actually do to every other query?
 *
 * This exists because of a specific, repeated failure. Three PRs in a row added a synonym or a phrase rule,
 * swept it, reported the sweep, and had an independent review find an over-match the sweep had not covered:
 *
 *   #120  `krediter -> credit-note` moved "krediter faktura" off the operation that CREATES a credit note and
 *         onto the one that applies an existing one. Found by crossing the SYNONYM TABLE'S OWN KEYS with
 *         domain nouns — a dimension no sweep had ever generated.
 *   #122  A demotion rule made "Apply a manual credit note to an invoice" return the DELETE that unapplies it.
 *         Found by using each endpoint's OWN SUMMARY as a query.
 *   #125  `inngående + faktura` swallowed "endre inngående faktura", and `faktura + abonnement` erased the
 *         invoice family from "vis faktura for abonnementet". Found by crossing ADJECTIVES with nouns, and
 *         nouns with nouns in both orders.
 *
 * Each time the harness was rebuilt by hand in a scratch directory, and each time it was rebuilt differently
 * and covered less. The dimensions above are not clever; they are simply the ones that have caught something.
 * Committing them is the whole point — a sweep that is reinvented per change is a sweep that under-covers.
 *
 * ## What it reports, and why each line is there
 *
 *   rank-1 changes            the headline, and the least informative on its own
 *   answer no longer reachable  the baseline's top result absent from the new top N. This is the measure two
 *                             CHANGELOG entries got wrong by counting EMPTY RESULT SETS instead — and with no
 *                             score floor in searchOperations, a result set can never empty, so that count was
 *                             always zero and always meaningless
 *   newly answered            was nothing, now something
 *   writes newly at rank 1    split out by risk, because a query that states no intent to write and is handed
 *                             an irreversible or externally-transmitting operation is the failure this
 *                             repository treats as most serious
 *
 * ## Usage
 *
 *   node scripts/discovery-sweep.mjs --against main
 *   node scripts/discovery-sweep.mjs --baseline /tmp/some-built-checkout
 *
 * `--against` extracts that revision with `git archive`, symlinks node_modules and builds it. `--baseline`
 * reuses a checkout already built, which is faster when comparing several variants against one baseline.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Verbs that ask to change something, and verbs that ask to look. Both have found defects. */
export const WRITE_VERBS = [
  "opprett", "slett", "endre", "send", "lever", "registrer", "bokfor", "godkjenn", "krediter", "avskriv",
  "last opp", "fullfor", "lukk", "create", "delete", "update", "upload", "submit", "approve", "lag", "generer",
];
export const READ_VERBS = [
  "vis", "se", "list", "hent", "finn", "sok", "hvilke", "hva", "hvor mange",
  "get", "show", "find", "search", "which", "what",
];

/**
 * Norwegian adjectives that pair with a noun and change which side of it is meant.
 *
 * `inngående` pairs with `utgående` for faktura, MVA and balanse — PR #119 mapped the bare adjective and had
 * to withdraw it, and PR #125 over-matched the phrase that replaced it. Both spellings of å, because the
 * index folds it to one `a` while callers type the conventional double.
 */
export const ADJECTIVES = [
  "innkommende", "inngaende", "inngaaende", "inngående", "utgaende", "utgående", "mottatt", "mottatte",
];

/** Domain nouns an accountant would type. Deliberately includes compounds that have caused over-matches. */
export const NOUNS = [
  "faktura", "fakturaer", "fakturagebyr", "fakturalinjer", "kreditnota", "abonnement", "abonnementene",
  "kvittering", "kvitteringer", "bilag", "postering", "kunde", "leverandor", "ansatt", "lonn", "mva",
  "balanse", "konto", "bankkonto", "prosjekt", "ordre", "utlegg", "vedlegg", "ehf", "peppol", "avtale",
  "kontrakt", "aksjer", "lan", "varelager", "betaling", "purring", "dokument", "avdeling", "saldo",
];

/**
 * Every query the sweep runs.
 *
 * Exported and tested rather than inlined, because the value of this file is precisely which dimensions it
 * covers — a silent narrowing of this function is the failure it exists to prevent.
 */
export function buildQueries(index) {
  const queries = new Set();
  const add = (q) => {
    const trimmed = q.trim();
    if (trimmed.length > 1) queries.add(trimmed);
  };

  // 1. Every path segment, in the three spellings a caller might type.
  for (const op of index.operations) {
    for (const segment of op.path.split("/")) {
      if (!segment || segment.startsWith("{")) continue;
      add(segment);
      if (segment.includes("-")) {
        add(segment.replace(/-/g, " "));
        add(segment.replace(/-/g, ""));
      }
    }
    // 2. Every tag, and 3. every endpoint's own summary — the dimension that found the #122 inversion.
    add(op.tag.toLowerCase());
    if (op.summary) add(op.summary.toLowerCase());
  }

  // 4. Tags crossed with both verb sets.
  for (const tag of new Set(index.operations.map((op) => op.tag.toLowerCase()))) {
    for (const verb of [...WRITE_VERBS, ...READ_VERBS]) add(`${verb} ${tag}`);
  }

  // 5. Nouns alone and with every verb.
  for (const noun of NOUNS) {
    add(noun);
    for (const verb of [...WRITE_VERBS, ...READ_VERBS]) add(`${verb} ${noun}`);
  }

  // 6. Adjective + noun, and a verb in front of it — the dimension that found the #125 inbox over-match.
  for (const adjective of ADJECTIVES) {
    for (const noun of NOUNS) {
      add(`${adjective} ${noun}`);
      for (const verb of [...WRITE_VERBS, ...READ_VERBS]) add(`${verb} ${adjective} ${noun}`);
    }
  }

  // 7. Noun + noun, both orders and with the connectors Norwegian uses — the dimension that found the #125
  //    subscription over-match, where a consumed phrase erased one of the two nouns.
  for (const left of NOUNS) {
    for (const right of NOUNS) {
      if (left === right) continue;
      add(`${left} ${right}`);
      add(`${left} for ${right}`);
      add(`${left} pa ${right}`);
    }
  }
  return [...queries].sort();
}

/** One revision's answer to every query, as `METHOD /path` strings. */
async function rankings(root, queries, limit) {
  const { searchOperations } = await import(pathToFileURL(join(root, "dist/reai/spec.js")).href);
  const out = new Map();
  for (const query of queries) {
    out.set(query, searchOperations({ query, limit }).map((hit) => `${hit.method} ${hit.path}`));
  }
  return out;
}

const WRITE_METHOD = /^(POST|PUT|PATCH|DELETE)\b/;

/**
 * What changed, in the four categories that have each caught a real defect.
 *
 * `classifyRequest` and `classifyTransmission` come from the NEW revision deliberately: the question is
 * whether what ships now points a caller at something irreversible, judged by the policy that ships with it.
 */
export function compare(before, after, { risk } = {}) {
  const rankOneChanged = [];
  const unreachable = [];
  const newlyAnswered = [];
  const writesPromoted = [];
  for (const [query, was] of before) {
    const now = after.get(query) ?? [];
    if ((was[0] ?? "") !== (now[0] ?? "")) rankOneChanged.push({ query, was: was[0], now: now[0] });
    if (was.length > 0 && !now.includes(was[0])) unreachable.push({ query, lost: was[0], now: now[0] });
    if (was.length === 0 && now.length > 0) newlyAnswered.push({ query, now: now[0] });
    if (now[0] && WRITE_METHOD.test(now[0]) && !(was[0] && WRITE_METHOD.test(was[0]))) {
      const [method, path] = now[0].split(" ");
      writesPromoted.push({
        query,
        now: now[0],
        risk: risk ? risk(method, path) : undefined,
      });
    }
  }
  return { rankOneChanged, unreachable, newlyAnswered, writesPromoted };
}

/** A built checkout of `rev`, in a temp directory the caller deletes. */
function buildRevision(rev) {
  const dir = mkdtempSync(join(tmpdir(), "reai-sweep-"));
  execFileSync("sh", ["-c", `git archive ${rev} | tar -x -C ${dir}`], { stdio: "inherit" });
  const modules = join(process.cwd(), "node_modules");
  if (existsSync(modules)) symlinkSync(modules, join(dir, "node_modules"));
  execFileSync("npm", ["run", "build"], { cwd: dir, stdio: "ignore" });
  return dir;
}

async function main() {
  const args = process.argv.slice(2);
  const at = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const against = at("--against");
  const givenBaseline = at("--baseline");
  const limit = Number(at("--limit") ?? 20);
  if (!against && !givenBaseline) {
    console.error("Pass --against <rev> or --baseline <built-checkout>.\n");
    console.error("  node scripts/discovery-sweep.mjs --against main");
    process.exit(2);
  }

  const { getSpecIndex } = await import(pathToFileURL(join(process.cwd(), "dist/reai/spec.js")).href);
  const policy = await import(pathToFileURL(join(process.cwd(), "dist/policy.js")).href);
  const queries = buildQueries(getSpecIndex());

  let baseline = givenBaseline;
  let temporary;
  try {
    if (!baseline) {
      console.log(`Building ${against} to compare against…`);
      temporary = buildRevision(against);
      baseline = temporary;
    }
    const before = await rankings(baseline, queries, limit);
    const after = await rankings(process.cwd(), queries, limit);
    const result = compare(before, after, { risk: (m, p) => {
      const transmits = policy.classifyTransmission(m, p) === "external";
      const level = policy.classifyRequest(m, p);
      return transmits ? `${level}, EXTERNAL` : level;
    } });

    console.log(`\nqueries swept: ${queries.length}   (top ${limit})`);
    console.log(`rank-1 changes:            ${result.rankOneChanged.length}`);
    console.log(`answer no longer reachable: ${result.unreachable.length}`);
    console.log(`newly answered:            ${result.newlyAnswered.length}`);
    console.log(`writes newly at rank 1:    ${result.writesPromoted.length}`);

    const risky = result.writesPromoted.filter((w) => /irreversible|EXTERNAL/.test(w.risk ?? ""));
    if (risky.length > 0) {
      console.log(`\n  ${risky.length} of those are irreversible or transmit outside the tenant:`);
      for (const w of risky.slice(0, 25)) console.log(`    ${w.query}  ->  ${w.now}  [${w.risk}]`);
      if (risky.length > 25) console.log(`    …and ${risky.length - 25} more`);
    }
    if (result.unreachable.length > 0) {
      console.log(`\n  no longer reachable (first 25):`);
      for (const u of result.unreachable.slice(0, 25)) {
        console.log(`    ${u.query}\n        lost ${u.lost}  (now ${u.now ?? "nothing"})`);
      }
      if (result.unreachable.length > 25) console.log(`    …and ${result.unreachable.length - 25} more`);
    }
    console.log(
      `\nNothing here is automatically a regression: a phrase rule narrowing a query to the family it names ` +
        `will show as "no longer reachable" for the family it replaced. Read the lines, do not count them.`,
    );
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
