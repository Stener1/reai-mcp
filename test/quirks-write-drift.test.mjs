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
  assert.equal(cases.length, 6, `expected 6 refusal cases, extracted ${cases.length}`);
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

test("no probe touches an irreversible or transmitting operation", () => {
  // The property that makes a write audit safe at all: if a refusal stops working, the request goes through, so
  // success has to be harmless. Asked of the policy engine rather than of a list someone maintains.
  const src = auditSource();
  const calls = [...src.matchAll(/call\(\s*"([A-Z]+)"\s*,\s*"([^"]+)"/g)].map(([, method, p]) => ({
    method,
    path: p.split("?")[0],
  }));
  assert.ok(calls.length >= 8, `only ${calls.length} calls extracted — the extraction has stopped matching`);

  const unsafe = calls
    .filter((c) => c.method !== "GET")
    .map((c) => ({
      ...c,
      risk: classifyRequest(c.method, c.path),
      transmission: classifyTransmission(c.method, c.path),
    }))
    .filter((c) => c.risk === "irreversible" || c.transmission === "external");
  assert.deepEqual(
    unsafe.map((c) => `${c.method} ${c.path} (${c.risk}, ${c.transmission})`),
    [],
    "a probe may only target an operation whose accidental SUCCESS would be harmless",
  );
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

test("record counts are snapshotted before and after, and any change fails the run", () => {
  const src = auditSource();
  assert.match(src, /const before = await snapshot\(\)/);
  assert.match(src, /const after = await snapshot\(\)/);
  assert.match(src, /RECORD COUNTS CHANGED/, "a count change must be reported as a leak");
  assert.match(
    src,
    /moved\.length > 0[\s\S]{0,400}process\.exit\(1\)/,
    "a count change must fail the run, not warn",
  );
  // The collections a probe could add to must all be watched. A probe against /api/products with no matching
  // snapshot entry is a leak nobody would see.
  const watched = [...(/const WATCHED = \[([\s\S]*?)\]/.exec(src)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
    ([, v]) => v.split("?")[0],
  );
  const posted = [...src.matchAll(/call\(\s*"POST"\s*,\s*"(\/api\/[^"?]+)"/g)].map(([, p]) => p);
  for (const p of new Set(posted)) {
    // A POST to a sub-resource or a nonexistent route cannot add a row to a watched collection; a POST to a
    // collection itself can, and that collection must be counted.
    const isCollection = /^\/api\/[a-z-]+$/.test(p);
    if (!isCollection) continue;
    assert.ok(
      watched.includes(p),
      `the audit POSTs to ${p} but does not snapshot it, so a probe that succeeded there would be invisible`,
    );
  }
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
