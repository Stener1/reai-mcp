import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QUIRKS } from "../dist/reai/quirks.js";
import { classifyRequest, classifyTransmission } from "../dist/policy.js";

/**
 * `scripts/audit-quirks-write.mjs` probes quirks whose claim is that a WRITE is refused. This keeps it safe.
 *
 * The read-only audit is safe by construction — an AST test forbids it issuing anything but GET. This one
 * cannot be: its whole method is to send writes. What makes it safe is narrower and needs enforcing:
 *
 *   1. **Nothing irreversible or transmitting is probed.** A probe is only safe if success would be harmless,
 *      because a refusal that stops working means the request goes through. Checked against `classifyRequest`
 *      and `classifyTransmission` — the same code the server enforces with — not against a hand-kept list.
 *   2. **An unexpected 2xx is a SAFETY outcome**, separate from drift, and exits non-zero.
 *   3. **Record counts are snapshotted before and after**, and any change fails the run.
 *
 * Rule 3 exists because of a real slip while scoping the audit: an order-line probe unexpectedly returned 201,
 * and the ad-hoc cleanup filtered the list response for a field the list does not return — so it reported
 * "cleaning up 0 orders" while order 4109 sat in the tenant. Deleted by hand a minute later. A count check
 * catches that; a filter that has to be correct does not.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIT = path.join(HERE, "..", "scripts/audit-quirks-write.mjs");

function auditSource() {
  return readFileSync(AUDIT, "utf8");
}

function auditCases() {
  const src = auditSource();
  const body = src.slice(src.indexOf("const CASES = ["));
  return body
    .split(/\n[ \t]*\{[ \t]*\n?/)
    .slice(1)
    .map((chunk) => ({
      quirk: /quirk:\s*"([^"]+)"/.exec(chunk)?.[1],
      claim: /claim:\s*\n?\s*"([^"]+)"/.exec(chunk)?.[1],
      marker: (/marker:\s*"((?:[^"\\]|\\.)+)"/.exec(chunk) ?? /marker:\s*'([^']+)'/.exec(chunk))?.[1]?.replace(
        /\\"/g,
        '"',
      ),
      chunk,
    }))
    .filter((c) => c.quirk);
}

test("every probe names a real quirk and binds to text that still predicts what it measures", () => {
  const cases = auditCases();
  assert.equal(cases.length, 7, `expected 7 refusal cases, extracted ${cases.length}`);
  const byId = new Map(QUIRKS.map((q) => [q.id, q]));
  for (const { quirk, claim, marker } of cases) {
    const q = byId.get(quirk);
    assert.ok(q, `the audit probes "${quirk}", which is not a quirk id`);
    assert.ok(claim, `${quirk} declares no claim`);
    assert.ok(marker && marker.length >= 12, `${quirk}'s marker is missing or too short`);
    assert.ok(
      marker.trim().split(/\s+/).length >= 3,
      `${quirk}'s marker ${JSON.stringify(marker)} is too fragmentary to bind a claim`,
    );
    assert.ok(
      q.note.includes(marker),
      `${quirk}: the note no longer contains ${JSON.stringify(marker)} — the probe may be measuring a claim ` +
        `nobody makes any more`,
    );
  }
});

test("the transmitting exclusion is enforced INSIDE call(), not by reading this file", () => {
  // The version this replaces extracted literal method/path pairs with a regex and asked the policy engine
  // about each. Review defeated it with two lines — a template-literal path and a path held in a variable — and
  // delivered a transmitting POST /api/salary-payments/{id}/complete plus an uncounted POST /api/suppliers to
  // tenant 2634 with all 996 tests green. Same failure as PR #129: a guard that reads source loses to ordinary
  // indirection. (It was also, finally, tripped by a COMMENT describing its own regex.)
  //
  // So the check moved into the call, where it sees the path actually being sent. This verifies the check exists
  // and is unconditional; the behaviour is exercised by running the audit.
  const text = auditSource();
  const callDecl = text.indexOf("const call = async (method, path, body) => {");
  assert.ok(callDecl > 0, "the single request helper must be named `call`");
  const body = text.slice(callDecl, text.indexOf("\n};", callDecl));
  assert.match(body, /classifyRequest\(method, canonical\)/, "call() must classify the path it is about to send");
  assert.match(body, /classifyTransmission\(method, canonical\)/);
  assert.match(
    body,
    /risk === "irreversible" \|\| transmission === "external"[\s\S]{0,200}throw new Error/,
    "an irreversible or transmitting probe must throw before the request is made",
  );
  assert.match(body, /writePathsSent\.add\(/, "every non-GET path must be recorded for the completeness check");

  // One request helper, or the classification can be routed around.
  const fetches = [...text.matchAll(/(?<![A-Za-z0-9_$.])fetch\s*\(/g)];
  assert.equal(fetches.length, 1, `expected one fetch call site in the audit, found ${fetches.length}`);
});

test("both tenant guards are called with the SAME value call() sends", async () => {
  // Review's point: the previous tests checked the guards by callee NAME. Passing literals —
  // requireWritableTenant(2783, …) — while call() keeps using tenantId from --tenant satisfies both while every
  // request goes elsewhere. The argument must be the identifier the header is built from.
  const { default: ts } = await import("typescript");
  const text = auditSource();
  const sf = ts.createSourceFile(AUDIT, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const seen = {};
  const walk = (n) => {
    if (ts.isCallExpression(n)) {
      const name = n.expression.getText(sf);
      if (name === "requireWritableTenant" || name === "requireTokenReachesTenant") {
        seen[name] = n.arguments[0]?.getText(sf);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  for (const guard of ["requireWritableTenant", "requireTokenReachesTenant"]) {
    assert.equal(
      seen[guard],
      "tenantId",
      `${guard} must receive \`tenantId\` — the same binding call() puts in X-Tenant-Id — not ${seen[guard]}`,
    );
  }
  assert.match(text, /"X-Tenant-Id": String\(tenantId\)/);
});

test("an unexpected success is a SAFETY outcome, not drift, and fails the run", () => {
  const src = auditSource();
  // Every case must recognise the 2xx it is not expecting. A case that only distinguishes 400 from 404 reports
  // "inconclusive" for the one outcome that means it has written to real books.
  for (const c of auditCases()) {
    assert.match(
      c.chunk,
      /status < 300/,
      `${c.quirk} does not check for an unexpected success — the one outcome that means a write landed`,
    );
  }
  assert.match(src, /tally\.safety > 0/, "a SAFETY outcome must affect the exit code");
  assert.match(src, /Treat as an incident/);
});

test("the count check cannot be filtered, saturated or silently skipped", () => {
  const src = auditSource();
  assert.match(src, /const before = await snapshot\(\)/);
  assert.match(src, /const after = await snapshot\(\)/);
  assert.match(src, /RECORD COUNTS CHANGED/, "a count change must be reported as a leak");
  assert.match(src, /moved\.length > 0[\s\S]{0,400}process\.exit\(1\)/, "a count change must fail the run");

  // Review kept the required wide-date-range string in a COMMENT and set the orders entry to ?status=closed,
  // which returns 0 permanently — the run then printed "nothing was created" while an order sat outside the
  // filter. A test asserting a string appears somewhere in the file is what allowed that, so the rule is now
  // enforced at runtime over the actual WATCHED array.
  assert.match(src, /const COUNT_SAFE_PARAMS = new Set\(/, "WATCHED entries must be validated at runtime");
  assert.match(src, /filters on \$\{key\}/, "a filtering WATCHED entry must stop the run");
  assert.match(src, /saturates and hides changes/, "a small pageSize must stop the run");

  // An unreadable collection means the check did not happen.
  assert.match(src, /Cannot count \$\{path\}: HTTP/, "a non-200 snapshot must throw, not be recorded as a string");
  assert.match(src, /neither an array nor a page object/, "an unrecognised body shape must throw");

  // Completeness derived from what was SENT, not from a regex over the source.
  assert.match(src, /which the snapshot does not count/, "a write to an uncounted collection must fail the run");
  assert.match(src, /\[\.\.\.writePathsSent\]/);
});

test("the audit goes through the tenant guard, at the top level, before any request", async () => {
  const { default: ts } = await import("typescript");
  const text = auditSource();
  const sf = ts.createSourceFile(AUDIT, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const topLevel = sf.statements.filter(
    (st) =>
      ts.isExpressionStatement(st) &&
      ts.isCallExpression(st.expression) &&
      st.expression.expression.getText(sf) === "requireWritableTenant",
  );
  assert.equal(topLevel.length, 1, "requireWritableTenant must be called exactly once at the top level");
  // And the runtime protected-tenant refusal, since this file's whole job is sending writes.
  assert.match(text, /installProtectedTenantFetchGuard\(\)/);
  const guardPos = topLevel[0].getStart(sf);
  const before = [...text.slice(0, guardPos).matchAll(/call\(\s*"(POST|PUT|PATCH|DELETE)"/g)];
  assert.deepEqual(
    before.map(([m]) => m),
    [],
    "no write may be issued before the guard runs",
  );
});

test("a probe is valid except for the field under test, and the required set comes from the spec", () => {
  // Fourth appearance of this trap across these audits: an under-specified body tests the first validator that
  // trips. The offer case took three rounds of measurement — currencyCode, then the wrong field name, then the
  // actual claim — so the required fields are read from the pinned spec rather than remembered.
  const src = auditSource();
  assert.match(src, /function requiredFor\(/, "required fields must come from the spec, not from memory");
  assert.match(src, /op\?\.body\?\.required/);
  // The offer probe in particular must carry every other required field.
  const offer = auditCases().find((c) => c.quirk === "offer-lines-stricter");
  for (const field of ["customerId", "currencyCode", "daysUntilDue", "offerLines"]) {
    assert.match(
      offer.chunk,
      new RegExp(field),
      `the offer probe must supply ${field}, or it never reaches the line validation it is about`,
    );
  }
  assert.doesNotMatch(
    offer.chunk,
    /\blines:\s*\[/,
    "the field is offerLines/orderLines; `lines` is silently ignored and the probe measures nothing",
  );
});

test("the token's actual tenant is verified, not just the number on the command line", async () => {
  // The single-tenant-token hazard: ReAI ignores X-Tenant-Id when a token reaches exactly one tenant, so
  // `--tenant 2783` on a token scoped to 2634 satisfies both number-based guards while every write lands in
  // 2634. This file imported `requireTokenReachesTenant` and never called it — the hazard PR #130 existed to
  // fix, reintroduced one file later by forgetting a line. The coverage test in write-guard.test.mjs only
  // required the top-level allowlist call, so nothing caught it.
  const { default: ts } = await import("typescript");
  const text = auditSource();
  const sf = ts.createSourceFile(AUDIT, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  let called = false;
  let pos = -1;
  const walk = (n) => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === "requireTokenReachesTenant") {
      called = true;
      pos = n.getStart(sf);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  assert.ok(called, "requireTokenReachesTenant must be CALLED, not merely imported");
  // And before any write, or it protects nothing.
  const before = [...text.slice(0, pos).matchAll(/call\(\s*"(POST|PUT|PATCH|DELETE)"/g)];
  assert.deepEqual(
    before.map(([m]) => m),
    [],
    "the reachability check must run before the first write",
  );
});

test("an accepted write is classified SAFETY in every case that can create something", () => {
  // A "drift" outcome tells the operator to correct a note. When a probe is ACCEPTED, a record now exists — a
  // different kind of problem, and the run's `0 SAFETY` line would otherwise be false. Three cases POST an
  // otherwise-valid order, so each must say safety rather than drift on success.
  for (const c of auditCases()) {
    const successBranches = [...c.chunk.matchAll(/status < 300[\s\S]{0,400}?return \[\s*\n?\s*"(\w+)"/g)].map(
      ([, outcome]) => outcome,
    );
    assert.ok(successBranches.length > 0, `${c.quirk} has no success branch`);
    assert.deepEqual(
      [...new Set(successBranches)].filter((o) => o !== "safety"),
      [],
      `${c.quirk} reports ${successBranches.join(", ")} when a probe is ACCEPTED; it must be "safety", because ` +
        `the run's SAFETY count is what tells the operator a record was created`,
    );
  }
});

test("the order snapshot cannot be masked by a default date window", () => {
  // /api/orders takes startDate/endDate. With a pinned probe date and a default window, a stray order would
  // fall outside the list once the year rolled over — and the count check that exists to catch exactly that
  // would see nothing.
  const src = auditSource();
  assert.match(
    src,
    /"\/api\/orders\?startDate=\d{4}-\d{2}-\d{2}&endDate=\d{4}-\d{2}-\d{2}"/,
    "the order snapshot must ask for an explicit wide date range",
  );
  assert.doesNotMatch(
    src,
    /return "20\d\d-\d\d-\d\d";/,
    "the probe date must be derived, not pinned to a literal year",
  );
  assert.match(src, /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
});

test("a claim that needs a successful write is declared unverified, not quietly dropped", () => {
  // `offer-lines-stricter` also says vatCode is OPTIONAL on an order line. Showing that requires a line that
  // SUCCEEDS, which would create an order — so this file does not probe it, and says so in the result rather
  // than reporting OK for the whole claim.
  const c = auditCases().find((x) => x.quirk === "offer-lines-stricter");
  assert.match(
    c.chunk,
    /NOT verified here/,
    "the unprobed half of the claim must be named in the case's own output",
  );
});

test("every case declares what it probes, so the report can say what it does not cover", () => {
  // The read-only audit FAILS the build unless a case covers every path its quirk is served on. This one cannot
  // reach that bar — several of these quirks are served on PUT and on paths needing a fixture — so the honest
  // substitute is disclosure. Review was right that "five verified exactly as written" overstated things: the
  // sentence a note leads with is often not the one probed. Every case declares `probes`, the run prints the
  // declared paths it does not reach, and a case leaving a headline claim unverified must name it.
  const byId = new Map(QUIRKS.map((q) => [q.id, q]));
  for (const c of auditCases()) {
    const probes = [...(/probes:\s*\[([\s\S]*?)\]/.exec(c.chunk)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
      ([, v]) => v,
    );
    assert.ok(probes.length > 0, `${c.quirk} declares no probes, so the report cannot say what it misses`);
    const q = byId.get(c.quirk);
    for (const p of probes) {
      assert.ok(q.paths.includes(p), `${c.quirk} declares probing ${p}, which its quirk is not served on`);
    }
    if (q.paths.some((p) => !probes.includes(p))) {
      assert.match(
        c.chunk,
        /(^|[^A-Za-z])unprobedClaims:/m,
        `${c.quirk} does not probe every path its quirk declares, so it must name what is left uncovered`,
      );
    }
  }
});
