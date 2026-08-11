import { test } from "node:test";
import assert from "node:assert/strict";
import { PHRASE_INTENT, getSpecIndex, termSynonymKeys } from "../dist/reai/spec.js";
import {
  ADJECTIVES,
  NOUNS,
  READ_VERBS,
  WRITE_VERBS,
  buildQueries,
  compare,
} from "../scripts/discovery-sweep.mjs";

/**
 * The sweep, tested by CALLING it rather than by grepping its source.
 *
 * The same reasoning as test/deployed-drift.test.mjs, and this repository has learned it the hard way: every
 * guard here that verified a script by pattern-matching its text has been defeated — by a commented-out line,
 * by a string in a log message, by prose above the code satisfying the grep.
 *
 * What the script is for: three PRs in a row added a synonym or a phrase rule, swept it, and had an
 * independent review find an over-match the sweep had not covered. Each time the harness was rebuilt by hand
 * in a scratch directory, differently and covering less. The dimensions are not clever — they are the ones
 * that have actually caught something — so what these tests protect is that none of them silently disappears.
 */

test("the sweep covers every dimension that has caught a defect", () => {
  const queries = new Set(buildQueries(getSpecIndex(), { synonymKeys: termSynonymKeys() }));

  // A path segment, spelled all three ways a caller might type it.
  for (const q of ["vat-returns", "vat returns", "vatreturns"]) {
    assert.ok(queries.has(q), `path-segment spelling missing: ${q}`);
  }
  // An endpoint's own summary — the dimension that found the #122 inversion, where "Apply a manual credit
  // note to an invoice" returned the DELETE that unapplies it.
  assert.ok(
    queries.has("apply a manual credit note to an invoice"),
    "endpoint summaries must be swept; that is how the #122 inversion was found",
  );
  // Adjective + noun, which found the #125 inbox over-match, in both spellings of å.
  for (const q of ["inngående faktura", "inngaaende ehf", "mottatt faktura"]) {
    assert.ok(queries.has(q), `adjective+noun missing: ${q}`);
  }
  // Noun + noun with the Norwegian connectors, which found the #125 subscription over-match.
  for (const q of ["faktura for abonnement", "fakturagebyr abonnement", "faktura pa abonnementene"]) {
    assert.ok(queries.has(q), `noun+noun missing: ${q}`);
  }
  // INTENT-PREFIXED, and this is the assertion that matters most: "vis faktura for abonnementet" is the exact
  // #125 read regression the docs cite, and the first version of this file did not generate it while claiming
  // the dimension had found it. Codex and the independent review both caught that.
  for (const q of ["vis faktura for abonnementet", "opprett faktura for abonnement", "slett faktura for abonnementet"]) {
    assert.ok(queries.has(q), `intent-prefixed noun pair missing: ${q}`);
  }
  // And the synonym table's own keys, the #120 dimension that was claimed and not implemented.
  for (const q of ["diett", "opprett diett", "krediter faktura", "periodisering mva"]) {
    assert.ok(queries.has(q), `synonym-key cross missing: ${q}`);
  }
  // A write verb and a read verb in front of a noun, since the two have different failure modes.
  assert.ok(queries.has("opprett faktura") && queries.has("vis faktura"));
  // And the specific queries whose regressions were caught by review rather than by a sweep.
  for (const q of ["registrer kvittering", "endre inngående faktura", "last opp kvittering"]) {
    assert.ok(queries.has(q), `a query a review had to find is still not swept: ${q}`);
  }
});

test("every PHRASE_INTENT entry is reachable from the corpus", () => {
  // THE SWEEP'S SILENCE MUST BE ABOUT THE CHANGE, NOT ABOUT ITS OWN VOCABULARY.
  //
  // PR #192 added `legg til` to PHRASE_INTENT, swept it against main, and got 0 rank-1 changes, 0
  // unreachable and 0 newly answered across 69,204 queries. That reads as "provably harmless" and meant
  // nothing whatsoever: `legg til` was not in WRITE_VERBS, so not ONE of the 69,204 generated queries
  // contained the phrase. The instrument was blind to the change it had been run to check, and the
  // omission was invisible because 660 queries matched `last opp`, so the phrase mechanism looked covered.
  //
  // Worse than the three failures in this file's header: there the query at least ran and two rankings
  // were compared. Here nothing was compared, and the zero row was nearly reported as the last gate
  // passing.
  //
  // So this is the same fact enforced rather than written down. A phrase the ranker knows and the corpus
  // does not now fails here, at the moment it is added.
  const queries = buildQueries(getSpecIndex(), { synonymKeys: termSynonymKeys() });
  const unreached = PHRASE_INTENT.filter(([pattern]) => !queries.some((q) => pattern.test(q.toLowerCase())));
  assert.deepEqual(
    unreached.map(([pattern]) => String(pattern)),
    [],
    "these PHRASE_INTENT patterns match no swept query, so `--against` cannot see a change to them. Add " +
      "the phrase to WRITE_VERBS or READ_VERBS in scripts/discovery-sweep.mjs:\n  " +
      unreached.map(([pattern]) => String(pattern)).join("\n  "),
  );

  // Non-vacuous in both directions: the table must be non-empty, and a phrase the corpus genuinely cannot
  // produce must be reported. Without this the assertion above passes for an empty table.
  assert.ok(PHRASE_INTENT.length >= 3, `PHRASE_INTENT has only ${PHRASE_INTENT.length} entries`);
  const invented = [[/\bzzz\s+quux\b/, ["POST"]]];
  assert.equal(
    invented.filter(([pattern]) => !queries.some((q) => pattern.test(q.toLowerCase()))).length,
    1,
    "the reachability check cannot detect an unreachable phrase, so it proves nothing about the real ones",
  );
});

test("the corpus is large enough to be a sweep rather than a sample", () => {
  const queries = buildQueries(getSpecIndex(), { synonymKeys: termSynonymKeys() });
  // ~19,800 today. Floored well below, because the count moves with the spec index; what matters is that a
  // refactor cannot quietly reduce this to a handful.
  assert.ok(queries.length > 15000, `only ${queries.length} queries generated`);
  // 69,143 with the synonym keys and intent-prefixed pairs the review of #126 added. The floor stays well
  // below, because the count moves with the spec index and a number pinned at the actual is a brittleness trap
  // this repository has now been told about three times.
  assert.equal(new Set(queries).size, queries.length, "queries must be deduplicated");
  assert.ok(
    queries.every((q) => typeof q === "string" && q.trim() === q && q.length > 1),
    "queries must be trimmed and non-trivial",
  );
});

test("the vocabulary lists keep the entries whose absence caused a miss", () => {
  // `lag` is in WRITE_VERBS here and deliberately NOT in the ranker's WRITE_INTENT_VERBS — it is also the
  // everyday noun for a team. The sweep still has to generate it, because "lag faktura for abonnementene" is
  // the query that sat at rank 34.
  assert.ok(WRITE_VERBS.includes("lag"));
  assert.ok(WRITE_VERBS.includes("last opp"), "the upload phrasing found the kvittering hole");
  assert.ok(READ_VERBS.includes("hvor mange") && READ_VERBS.includes("hvilke"), "question words are read intent");
  // Both spellings of å: the index folds it to a single a, and callers type the conventional double.
  assert.ok(ADJECTIVES.includes("inngaende") && ADJECTIVES.includes("inngaaende") && ADJECTIVES.includes("inngående"));
  // The compound nouns are the ones a `\w*` pattern over-matches into.
  for (const noun of ["fakturagebyr", "fakturalinjer", "abonnementene", "kvitteringer"]) {
    assert.ok(NOUNS.includes(noun), `NOUNS is missing the compound ${noun}`);
  }
});

test("compare reports the four categories, and does not confuse them", () => {
  const before = new Map([
    ["kept", ["GET /a", "GET /b"]],
    ["moved", ["GET /a", "GET /b"]],
    ["lost", ["GET /a", "GET /b"]],
    ["was-nothing", []],
    ["became-write", ["GET /a"]],
  ]);
  const after = new Map([
    ["kept", ["GET /a", "GET /b"]],
    // Rank 1 changed but the old answer is still reachable — a demotion, not a loss.
    ["moved", ["GET /b", "GET /a"]],
    // Rank 1 changed AND the old answer is gone from the window.
    ["lost", ["GET /c"]],
    ["was-nothing", ["GET /d"]],
    // The old read is still in the window, so this case is ONLY a write promotion — each fixture row isolates
    // one category. The first version had it drop "GET /a" too, which made it legitimately a loss as well and
    // the assertion below fail; the code was right and the fixture was sloppy.
    ["became-write", ["POST /e", "GET /a"]],
  ]);
  const r = compare(before, after, { risk: () => "irreversible, EXTERNAL" });

  assert.deepEqual(r.rankOneChanged.map((x) => x.query).sort(), ["became-write", "lost", "moved", "was-nothing"]);
  // "moved" must NOT be reported as unreachable: that distinction is the one two CHANGELOG entries got wrong,
  // by counting empty result sets — which, with no score floor in searchOperations, can never happen.
  assert.deepEqual(r.unreachable.map((x) => x.query), ["lost"]);
  assert.deepEqual(r.newlyAnswered.map((x) => x.query), ["was-nothing"]);
  assert.deepEqual(r.writesPromoted.map((x) => x.query), ["became-write"]);
  assert.equal(r.writesPromoted[0].risk, "irreversible, EXTERNAL");
});

test("a write that was already a write is not reported as newly promoted", () => {
  // The category is "a query that used to answer with a read now answers with a write". A write-to-write
  // change is a different thing and counting it would bury the one that matters.
  const before = new Map([["q", ["POST /a"]]]);
  const after = new Map([["q", ["DELETE /b"]]]);
  const r = compare(before, after);
  assert.equal(r.writesPromoted.length, 0);
  assert.equal(r.rankOneChanged.length, 1);
});

test("buildQueries is a function of the spec, not a hardcoded list", () => {
  // Every other test here asserts `queries.has(…)` against the real index, and the independent review of PR
  // #126 pointed out that all of them are satisfied by returning a big literal array. This one drives a
  // synthetic index, so the output has to be DERIVED.
  const synthetic = {
    operations: [
      { method: "GET", path: "/api/zz-thing/{id}/sub-part", tag: "Zz Things", summary: "Do The Zz Thing" },
    ],
  };
  const queries = new Set(buildQueries(synthetic, { synonymKeys: ["zzsynonym"] }));
  // Path segments in all three spellings.
  for (const q of ["zz-thing", "zz thing", "zzthing", "sub-part", "sub part", "subpart"]) {
    assert.ok(queries.has(q), `synthetic path segment missing: ${q}`);
  }
  assert.ok(queries.has("zz things"), "the tag should be lowercased and swept");
  assert.ok(queries.has("do the zz thing"), "the summary should be lowercased and swept");
  assert.ok(queries.has("zzsynonym"), "a synonym key should be swept on its own");
  assert.ok(queries.has("zzsynonym faktura"), "a synonym key should be crossed with the nouns");
  assert.ok(queries.has("vis zz things"), "tags should be crossed with a read verb");
  // And nothing from the real index leaks in, which is what proves it is derived rather than canned.
  assert.ok(!queries.has("vat-returns"), "buildQueries must not carry hardcoded queries from the real spec");
  assert.ok(!queries.has("apply a manual credit note to an invoice"));
});

test("importing the sweep does not run it", () => {
  // The positive form of the main-module guard: if it fired on import, this test process would have shelled
  // out to git archive and npm run build.
  assert.equal(typeof buildQueries, "function");
  assert.equal(typeof compare, "function");
});
