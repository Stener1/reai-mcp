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
 *   answer no longer reachable  the baseline's top result absent from the new top N. Two CHANGELOG entries
 *                             reported "no answer lost" on the strength of counting EMPTY RESULT SETS, which is
 *                             a much weaker measure: a query loses its answer by having it pushed out of the
 *                             window, not by returning nothing. Those entries were measuring something real —
 *                             a first version of this comment claimed a result set "can never empty" because
 *                             there is no score floor, and that is FALSE: 489 of the 19,840 queries here return
 *                             nothing on main, because a query whose every term matches no operation never
 *                             pushes a hit. The weakness was the choice of measure, not the measure's existence
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
  // Definite forms, because that is how the recorded cases are phrased: "vis faktura for abonnementET",
  // "hent kunden tilbake", "åpne avstemmingEN på nytt".
  "abonnementet", "fakturaen", "kunden", "bilaget", "avstemmingen", "kvitteringen",
];

/**
 * Every query the sweep runs.
 *
 * Exported and tested rather than inlined, because the value of this file is precisely which dimensions it
 * covers — a silent narrowing of this function is the failure it exists to prevent.
 */
/** The small set of intent prefixes used on noun PAIRS, kept short because the pair space is already large. */
export const PAIR_PREFIXES = ["vis", "hent", "opprett", "slett", "endre"];

export function buildQueries(index, { synonymKeys = [] } = {}) {
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
  //
  //    PREFIXED with intent as well as bare, because the ranker treats read and write intent separately and a
  //    neutral pair is not a substitute. The first version generated only the bare forms, so "vis faktura for
  //    abonnementet" — the exact #125 read regression this file cites — was ABSENT from the corpus while the
  //    docs claimed the dimension had found it. Codex, PR #126.
  for (const left of NOUNS) {
    for (const right of NOUNS) {
      if (left === right) continue;
      for (const joined of [`${left} ${right}`, `${left} for ${right}`, `${left} pa ${right}`]) {
        add(joined);
        for (const prefix of PAIR_PREFIXES) add(`${prefix} ${joined}`);
      }
    }
  }

  // 8. The SYNONYM TABLE'S OWN KEYS, crossed with nouns and verbs — the dimension that found #120's
  //    `krediter -> credit-note`. The first version claimed this dimension and did not generate it: it crossed
  //    only the two hand-maintained verb lists, so `krediter` was probed by accident (it is also a write verb)
  //    while `kontonummer`, `fordring` and `periodisering` never were.
  for (const key of synonymKeys) {
    add(key);
    for (const verb of [...WRITE_VERBS, ...READ_VERBS]) add(`${verb} ${key}`);
    for (const noun of NOUNS) {
      add(`${key} ${noun}`);
      add(`${noun} ${key}`);
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
  const riskyTargets = [];
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
      writesPromoted.push({ query, now: now[0], risk: risk ? risk(method, path) : undefined });
    }
    // A RISKY new answer, whatever the old method was. writesPromoted deliberately ignores write-to-write, and
    // that exclusion hid the #122 defect completely: "apply a manual credit note to an invoice" inverted from
    // the POST that applies one to the DELETE that unapplies it, which is write-to-write, so the only place it
    // appeared was an unnamed count of 346 rank-1 changes. An irreversible or transmitting operation arriving
    // at rank 1 is worth naming even when the query already answered with a write.
    if (now[0] && (was[0] ?? "") !== now[0] && risk) {
      const [method, path] = now[0].split(" ");
      const level = risk(method, path);
      if (/irreversible|EXTERNAL/.test(level)) riskyTargets.push({ query, was: was[0], now: now[0], risk: level });
    }
  }
  return { rankOneChanged, riskyTargets, unreachable, newlyAnswered, writesPromoted };
}

/** A built checkout of `rev`, in a temp directory the caller deletes. */
function buildRevision(rev, dir) {
  // No `sh -c`. The interpolated revision was a command injection: `--against 'main; echo …'` ran the echo,
  // demonstrated by the independent review of PR #126. Piping two execFileSync calls also gives git its own
  // exit status, where the shell pipeline masked a bad revision behind tar's success and failed later, inside
  // npm run build, with a confusing error.
  const archive = execFileSync("git", ["archive", rev], { maxBuffer: 1024 * 1024 * 256 });
  execFileSync("tar", ["-x", "-C", dir], { input: archive });
  const modules = join(process.cwd(), "node_modules");
  if (existsSync(modules)) symlinkSync(modules, join(dir, "node_modules"));
  execFileSync("npm", ["run", "build"], { cwd: dir, stdio: "ignore" });
}

async function main() {
  const args = process.argv.slice(2);
  const at = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const against = at("--against");
  const givenBaseline = at("--baseline");
  const rawLimit = at("--limit") ?? "20";
  const limit = Number(rawLimit);
  // A misspelt flag made Number() produce NaN, searchOperations carried it through its clamp, slice(0, NaN)
  // returned nothing, and BOTH revisions looked empty — so the script reported zero changes in every category:
  // a false clean, which is the worst thing a tool like this can do. Codex, PR #126.
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    console.error(`--limit must be an integer between 1 and 200; got ${JSON.stringify(rawLimit)}.`);
    process.exit(2);
  }
  if (!against && !givenBaseline) {
    console.error("Pass --against <rev> or --baseline <built-checkout>.\n");
    console.error("  node scripts/discovery-sweep.mjs --against main");
    process.exit(2);
  }

  const head = await import(pathToFileURL(join(process.cwd(), "dist/reai/spec.js")).href);
  const policy = await import(pathToFileURL(join(process.cwd(), "dist/policy.js")).href);

  let baseline = givenBaseline;
  let temporary;
  try {
    if (!baseline) {
      console.log(`Building ${against} to compare against…`);
      // The directory is created BEFORE the build so `finally` can remove it when the build throws. Assigning
      // only on return leaked one temp directory per failure, reproduced by the review of PR #126.
      temporary = mkdtempSync(join(tmpdir(), "reai-sweep-"));
      buildRevision(against, temporary);
      baseline = temporary;
    }
    if (!existsSync(join(baseline, "dist/reai/spec.js"))) {
      console.error(`${baseline} has no dist/reai/spec.js — run \`npm run build\` in it first.`);
      process.exit(2);
    }

    // The query set is the UNION of both revisions' vocabularies. Deriving it from HEAD alone meant that when a
    // change renamed or removed a path, tag or summary, the old spelling existed only in the baseline and was
    // never searched — so "what does HEAD now answer for an endpoint summary it used to have" could not be
    // asked. Codex, PR #126.
    const old = await import(pathToFileURL(join(baseline, "dist/reai/spec.js")).href);
    const queries = [
      ...new Set([
        ...buildQueries(head.getSpecIndex(), { synonymKeys: head.termSynonymKeys?.() ?? [] }),
        ...buildQueries(old.getSpecIndex(), { synonymKeys: old.termSynonymKeys?.() ?? [] }),
      ]),
    ].sort();

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

    console.log(`risky new answers:         ${result.riskyTargets.length}`);
    if (result.riskyTargets.length > 0) {
      console.log(`\n  rank 1 is now irreversible or transmits, whatever it was before (first 25 of ${result.riskyTargets.length}):`);
      for (const t of result.riskyTargets.slice(0, 25)) {
        console.log(`    ${t.query}\n        ${t.was ?? "nothing"}  ->  ${t.now}  [${t.risk}]`);
      }
    }
    const risky = result.writesPromoted.filter((w) => /irreversible|EXTERNAL/.test(w.risk ?? ""));
    if (risky.length > 0) {
      console.log(`\n  ${risky.length} of those are irreversible or transmit outside the tenant:`);
      for (const w of risky.slice(0, 25)) console.log(`    ${w.query}  ->  ${w.now}  [${w.risk}]`);
      if (risky.length > 25) console.log(`    …and ${risky.length - 25} more`);
    }
    // The rank-1 changes no other section names. Counting them was the first version's whole report for a
    // GET-to-GET reorder or a POST-to-DELETE inversion — the #122 defect was exactly that shape, so the
    // developer was told a number and no query. Codex, PR #126.
    const namedElsewhere = new Set([
      ...result.unreachable.map((u) => u.query),
      ...result.writesPromoted.map((w) => w.query),
      ...result.newlyAnswered.map((n) => n.query),
    ]);
    const quiet = result.rankOneChanged.filter((c) => !namedElsewhere.has(c.query));
    if (quiet.length > 0) {
      console.log(`\n  rank-1 changed, old answer still reachable (first 25 of ${quiet.length}):`);
      for (const c of quiet.slice(0, 25)) {
        console.log(`    ${c.query}\n        ${c.was ?? "nothing"}  ->  ${c.now ?? "nothing"}`);
      }
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
