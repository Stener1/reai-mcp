import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QUIRKS } from "../dist/reai/quirks.js";
import { classifyRequest } from "../dist/policy.js";

/**
 * `scripts/audit-quirks.mjs` asks whether the quirks this server serves are still true. This keeps it
 * honest, in the two ways a live audit can quietly stop meaning anything.
 *
 * **It can drift from the text it claims to check.** The audit's `claim` is a sentence written here; the
 * thing an agent actually reads is `note` in `src/reai/quirks.ts`. Nothing stops the note being rewritten
 * to say the opposite while the probe keeps reporting OK against its own paraphrase. So each case names a
 * `marker` phrase from the note that predicts what the probe measures, and this file asserts it is still
 * there. Edit the note past that phrase and CI fails here — which is the moment claim and measurement can
 * diverge. Same relationship as `storage-drift.test.mjs`, for the same reason.
 *
 * **It can stop being able to fail.** A case whose `check` has no drift branch reports OK or INCONCLUSIVE
 * forever and adds a line to a passing report. That is the vacuous-guard failure this repository has now
 * shipped several times: a `notEnum.length <= 2` that licensed holes, sweep tests satisfiable by a literal
 * array, an `assert.equal` on a query with no read verb. So every case must contain a drift branch, and
 * comments are stripped before looking — a commented-out `"drift"` is not a drift branch, and that exact
 * trick defeated two assertions in `storage-drift.test.mjs` when PR #116 was reviewed.
 *
 * The read-only property is asserted against `classifyRequest`, the same policy code the server enforces
 * with, rather than by grepping for method names. This audit runs against tenant **2634**, real books, and
 * "it only does GETs" is the entire reason that is allowed.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIT = path.join(HERE, "..", "scripts/audit-quirks.mjs");

/** Comments stripped first — see the header. */
function auditSource() {
  return readFileSync(AUDIT, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

/**
 * Split on the case boundary and read each key independently, rather than with one multi-line regex that
 * requires a fixed key order. The review of PR #116 dropped two cases out of `storage-drift`'s population
 * by reordering keys and inserting a comment, and that test passed on the smaller set.
 */
function auditCases() {
  const src = auditSource();
  const body = src.slice(src.indexOf("const CASES = ["));
  return body
    .split(/\n  \{\n/)
    .slice(1)
    .map((chunk) => ({
      quirk: /quirk:\s*"([^"]+)"/.exec(chunk)?.[1],
      claim: /claim:\s*\n?\s*"([^"]+)"/.exec(chunk)?.[1],
      marker: (/marker:\s*"((?:[^"\\]|\\.)+)"/.exec(chunk) ?? /marker:\s*'([^']+)'/.exec(chunk))?.[1]?.replace(
        /\\"/g,
        '"',
      ),
      // The branch that makes the case able to fail at all.
      canDrift: /return\s*\[\s*"drift"/.test(chunk) || /\[\s*\n?\s*"drift"/.test(chunk),
      conditional: (/conditional:\s*"((?:[^"\\]|\\.)+)"/.exec(chunk) ?? /conditional:\s*'([^']+)'/.exec(chunk))?.[1],
      // Declared concrete endpoints. Read from the `probes` array so the coverage check below compares
      // against the quirk's own `paths` rather than against whatever the check() body happens to fetch.
      probes: [...(/probes:\s*\[([\s\S]*?)\]/.exec(chunk)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
        ([, v]) => v,
      ),
      chunk,
    }))
    .filter((c) => c.quirk);
}

test("every quirk probe names a real quirk, and binds to text that still PREDICTS what it measures", () => {
  const cases = auditCases();
  // The count itself is the floor. A "6 of 8" style threshold licenses two cases silently falling out of
  // the population, which is how `storage-drift` was defeated; removing a case on purpose is a
  // one-character edit here.
  assert.equal(
    cases.length,
    8,
    `expected 8 quirk cases, extracted ${cases.length} — either a case was added without updating this ` +
      `number, or the extraction has stopped matching`,
  );

  const byId = new Map(QUIRKS.map((q) => [q.id, q]));
  for (const { quirk, claim, marker } of cases) {
    const q = byId.get(quirk);
    assert.ok(q, `the audit probes "${quirk}", which is not a quirk id in src/reai/quirks.ts`);
    assert.ok(claim, `${quirk} declares no claim`);
    assert.ok(marker, `${quirk} declares no marker phrase from its note`);
    // Long enough to bind something. `marker: "e"` and `marker: " "` both satisfied a naive version of
    // the equivalent assertion in storage-drift.
    assert.ok(
      marker.length >= 12,
      `${quirk} has marker ${JSON.stringify(marker)}, too short to bind anything — use a phrase`,
    );
    assert.ok(
      q.note.includes(marker),
      `${quirk}: the note no longer contains ${JSON.stringify(marker)}. The probe measures something the ` +
        `note may no longer claim — re-read both before editing this test.`,
    );
  }
});

test("every quirk probe can report drift", () => {
  const offenders = auditCases().filter((c) => !c.canDrift);
  assert.deepEqual(
    offenders.map((c) => c.quirk),
    [],
    "these have no drift branch, so they can only ever report OK or INCONCLUSIVE and are decoration",
  );
});

test("the quirk audit is read-only, by the same policy engine the server enforces with", () => {
  const src = auditSource();

  // Every path it touches, classified. A GET the policy engine thinks is a write would be a bug in one of
  // the two, and either way this audit must not run against 2634.
  const paths = [...src.matchAll(/get\(\s*[`"](\/api\/[^`"?]*)/g)].map(([, p]) => p);
  assert.ok(paths.length >= 8, `only ${paths.length} requests extracted — the extraction has stopped matching`);
  const writes = paths
    .map((p) => ({ p, risk: classifyRequest("GET", p.replace(/\$\{[^}]*\}/g, "7")) }))
    .filter((c) => c.risk !== "read");
  assert.deepEqual(
    writes.map((c) => `${c.p} (${c.risk})`),
    [],
    "every request in this audit must classify as a read",
  );

  // And no way to make a non-GET at all. The helper hardcodes the method; nothing else may call fetch.
  assert.match(src, /method:\s*"GET"/, "the request helper must pin the method");
  const fetches = [...src.matchAll(/fetch\(/g)].length;
  assert.equal(fetches, 1, `expected exactly one fetch call site, found ${fetches}`);
  assert.doesNotMatch(
    src,
    /method:\s*(?:"(?:POST|PUT|PATCH|DELETE)"|method\b|[a-zA-Z]+\s*\?\?)/,
    "the method must be a literal GET, not a variable or a parameter with a default",
  );

  // Read-only is *why* there is no write guard, so the absence has to be deliberate rather than forgotten.
  assert.doesNotMatch(
    src,
    /REAI_WRITE_TEST_TENANTS/,
    "a read-only audit must not consult the write guard — if it needs one, it is no longer read-only",
  );
});

test("probes that depend on validation ORDER send a full request", () => {
  // Pinned because it is the exact mistake made while writing this audit, and it produced a false DRIFT
  // against a correct quirk. `/api/timesheets?projectId=1` returns "startDate is required": the date
  // validator runs first, so the response says nothing about the module the claim is about.
  const cases = auditCases();
  const timesheets = cases.find((c) => c.quirk === "timesheets-need-project-module");
  assert.ok(timesheets, "the timesheets case has gone missing");
  assert.match(
    timesheets.chunk,
    /projectId=1&\$\{DATES\}/,
    "the timesheets probe must send the date range too, or it measures the date validator instead of the " +
      "module check and reports a correct quirk as drift",
  );
  // The claim is two-sided ("required AND rejected"), so both halves must be probed.
  assert.match(timesheets.chunk, /projectid is required/i, "it must also verify projectId is required");
});

test("shape probes compare the whole wrapper, not just the keys they hope for", () => {
  // `keys.includes("items")` passes on a wrapper that has grown three paging fields, and these claims are
  // specifically about which fields are present — the hazard is an agent assuming the wrong shape.
  const src = auditSource();
  assert.match(src, /const sameKeys =/, "shape comparison must be exact, not a subset check");
  for (const quirk of ["leads-paginated-object", "person-role-matches-shape", "warehouse-inventory-object"]) {
    const c = auditCases().find((x) => x.quirk === quirk);
    assert.ok(c, `${quirk} case is missing`);
    assert.match(c.chunk, /sameKeys\(/, `${quirk} must compare the full key set`);
  }
});

test("the audited quirks are a documented subset, not a claim of coverage", () => {
  // 8 of 122. The number in the report has to be honest about that, because "the quirk audit passes" is
  // otherwise read as "the quirks are verified" — the same over-claim `storage-drift` was corrected for.
  const src = readFileSync(AUDIT, "utf8");
  assert.match(src, /QUIRKS\.length/, "the report must print the total, not only the probed count");
  assert.match(
    src,
    /covers the subset a GET can answer/,
    "the report must say the probed set is a subset and why",
  );
  assert.ok(QUIRKS.length > 100, `sanity: expected >100 quirks, found ${QUIRKS.length}`);
});

test("an unverifiable claim fails the run unless it says WHY it cannot be verified", () => {
  // `audit-storage.mjs` exits 3 on inconclusive, for the reason docs/development.md records: "a claim
  // nobody checked is not a claim that held". This audit adopts that — but one case is unanswerable by
  // construction rather than by accident (the tenant-header claim needs a single-tenant token; ours reaches
  // four), and a gate that fails forever is a gate everyone learns to ignore. So the escape hatch exists
  // and is narrow: declare `conditional:` with the reason, in the file, where review can see it.
  const src = auditSource();
  assert.match(src, /process\.exit\(3\)/, "an unexpected inconclusive must exit 3, as the storage audit does");
  assert.match(
    src,
    /!c\.conditional/,
    "the exit status must ignore only the cases that declare themselves conditional",
  );

  for (const c of auditCases().filter((x) => x.conditional)) {
    // A reason, not a shrug. This is the field that suppresses a failure, so it is the field most worth
    // making expensive to add.
    assert.ok(
      c.conditional.length >= 20,
      `${c.quirk} declares conditional: ${JSON.stringify(c.conditional)} — say what would answer it`,
    );
    assert.match(
      c.chunk,
      /needs|requires|cannot|only/i,
      `${c.quirk}'s conditional reason must state the missing precondition`,
    );
  }

  // And the hatch stays rare. If most cases are conditional the audit has become a list of things it
  // cannot check, which is the honest-looking version of checking nothing.
  const cases = auditCases();
  const conditional = cases.filter((c) => c.conditional);
  assert.ok(
    conditional.length <= 1,
    `${conditional.length} of ${cases.length} cases are conditional (${conditional
      .map((c) => c.quirk)
      .join(", ")}) — raising this number needs a better reason than convenience`,
  );
});

test("every case probes every path its quirk is SERVED for", () => {
  // The fragment problem, and this file's own history: `date-range-required` was verified against
  // /api/vouchers while `quirksFor()` also serves it for /api/postings and the nine /api/ledger/*
  // endpoints, and `module-gating` was checked on two of the five paths it declares. Both reported OK for
  // claims that had been tested on part of their surface — the same shape as the shallow-request bug, by
  // another route.
  //
  // Comparing against the quirk's own `paths` is what makes it self-maintaining: add a path to a quirk in
  // src/reai/quirks.ts and this fails until the audit probes it.
  // A declared path is covered by a probe that equals it, sits beneath it (`/api/ledger` is a PREFIX, not
  // an endpoint — it 404s "No static resource" and matches the nine real /api/ledger/* operations), or
  // instantiates it (`/api/annual-accounts/{year}` is templated, and only a concrete year can be fetched).
  const covers = (probe, declared) => {
    if (probe === declared) return true;
    if (declared.includes("{")) {
      const pattern = new RegExp(
        `^${declared.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]*\\\}/g, "[^/]+")}$`,
      );
      if (pattern.test(probe)) return true;
    }
    return probe.startsWith(`${declared}/`);
  };

  const byId = new Map(QUIRKS.map((q) => [q.id, q]));
  const gaps = [];
  for (const c of auditCases()) {
    const q = byId.get(c.quirk);
    assert.ok(q, `${c.quirk} is not a known quirk`);
    assert.ok(c.probes.length > 0, `${c.quirk} declares no probes`);

    for (const declared of q.paths) {
      if (!c.probes.some((probe) => covers(probe, declared))) {
        gaps.push(`${c.quirk} is served for ${declared}, which nothing probes`);
      }
    }

    // And the converse, so `probes` cannot be padded with unrelated paths to satisfy the check above.
    for (const probe of c.probes) {
      assert.ok(
        q.paths.some((d) => covers(probe, d)),
        `${c.quirk} probes ${probe}, which is not among the paths that quirk declares (${q.paths.join(", ")})`,
      );
    }
  }
  assert.deepEqual(gaps, [], "these quirks are asserted to agents on paths the audit never checks");
});

test("a case that declares many probes actually requests them all", () => {
  // `probes` is metadata; the guard above compares metadata to metadata. If check() ignores it, the
  // coverage claim is decoration. The two multi-path cases iterate `this.probes`, so the request set and
  // the declared set are the same object by construction — assert that rather than trusting it.
  for (const quirk of ["date-range-required", "module-gating"]) {
    const c = auditCases().find((x) => x.quirk === quirk);
    assert.ok(c, `${quirk} case is missing`);
    assert.match(
      c.chunk,
      /for \(const path of this\.probes\)/,
      `${quirk} must iterate this.probes, or its declared coverage is not what it requests`,
    );
  }
});
