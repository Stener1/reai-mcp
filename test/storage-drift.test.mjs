import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PHONE_RULE, SKIP_REGISTRY_LOOKUP_RULE } from "../dist/tools/registry.js";
import { salesTools } from "../dist/tools/sales.js";
import { purchaseTools } from "../dist/tools/purchase.js";
import { QUIRKS } from "../dist/reai/quirks.js";

/**
 * `scripts/audit-storage.mjs` checks what the API STORES. This keeps it honest.
 *
 * The message audit's completeness guard extracts its population from `src/` mechanically, because a
 * regex applied to error text has a recognisable shape. A storage claim does not: "a bare number that
 * is valid in Norway is stored under +47" is prose, and pretending to extract it would be the same
 * over-claiming the message audit was corrected for.
 *
 * So the relationship runs the other way. Each case in the audit names the CONSTANT that makes its
 * claim and a `marker` phrase from it, and this file asserts the marker is still there. Edit
 * `PHONE_RULE` and the marker disappears, this fails, and the probe has to be revisited — which is
 * exactly the moment the claim and the measurement can diverge.
 *
 * ## The census, because "the population cannot be measured" was a cop-out
 *
 * The first version of this file said asserting completeness was impossible because "a storage claim is
 * prose". The review of PR #115 enumerated it anyway — the claims live in exactly two places,
 * `description:`/`.describe()` in `src/tools/*.ts` and `note:` in `src/reai/quirks.ts`, both as greppable
 * as the error strings the message audit does enumerate. A keyword sweep over agent-facing string
 * literals finds **129** that assert something about what is stored; the review's narrower reading of
 * distinct claims put it near 50. Either way the ratio is what matters, and hiding it behind "cannot be
 * measured" made 11-of-many look like completeness.
 *
 * So: **11 probed.** The census below is printed by `npm run audit:census` rather than asserted, because
 * a keyword sweep over prose is a lower bound and pinning it would be the false precision this
 * repository keeps paying for. What IS asserted is that every probe binds to text that still predicts
 * what it measures, which is the part a unit test can actually know.
 *
 * That list was written to be worked through, and this round did: the **no-flag registry discard** (the
 * default path, and the flagship claim of `reai_create_customer`), the **address half** of both
 * skip-lookup claims including the wrong-postcode hazard, `countryCode` defaulting to NO, and the phone
 * rule on a **supplier**. The contact-person phone shipped in PR #115, not here — miscredited in the
 * first version of this comment. That makes **three** of the five fields `PHONE_RULE` governs, not four:
 * `reai_update_customer.phone`, `reai_create_customer_contact.phone` and `reai_update_supplier.phone`.
 *
 * The address-overwrite case is the one with real consequence: an agent could invoice to that address.
 * It is verified against Brønnøysundregistrene rather than a remembered string — stored postcode 7900
 * against the registry's 1331 — because "wrong" is a claim about the registry, not about a constant.
 *
 * Still unprobed and cheap: `reai_update_lead.phone` AND `reai_update_customer_contact.phone` — two
 * remaining `PHONE_RULE` consumers, not one, which the first version of this comment also got wrong —
 * `SKIP_REGISTRY_LOOKUP_RULE` on the supplier tool (all four skip-lookup probes are customer-only),
 * `PUT /api/customers/{id}/address` as a separate resource, and the employee phone's silent-null
 * behaviour, which `organisation.ts` measured and documented but nothing re-checks.
 *
 * `npm run audit:census` prints the floor. It counts LITERALS and the probes count CLAIMS, so the two
 * numbers are not a percentage and the script says so.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIT = path.join(HERE, "..", "scripts/audit-storage.mjs");

/** The constants the audit's cases name, resolved so a rename cannot leave a dangling reference. */
const SOURCES = {
  PHONE_RULE,
  SKIP_REGISTRY_LOOKUP_RULE,
  "reai_create_customer description": salesTools.find((t) => t.name === "reai_create_customer")
    .description,
  "reai_create_supplier description": purchaseTools.find((t) => t.name === "reai_create_supplier")
    .description,
  "customer-name-title-cased quirk": QUIRKS.find((q) => q.id === "customer-name-title-cased").note,
  "reai_create_customer countryCode argument": salesTools.find(
    (t) => t.name === "reai_create_customer",
  ).inputSchema.countryCode.description,
};

/**
 * The audit's cases, extracted per case-object rather than by one brittle multi-line regex.
 *
 * The first version required `claim:`, `source:` and `marker:` on consecutive lines in that order — so
 * the review dropped two cases out of the population with two ordinary edits (a comment between two of
 * the keys, and swapping their order) and the test passed at six with those markers never checked.
 * Splitting on the case boundary and reading each key independently cannot be defeated that way.
 */
function auditCases() {
  // Comments stripped FIRST. The review of PR #116 defeated two assertions with commented-out code: a
  // `// predictsEcho: true` satisfied the value-pin check for a case that had none, and a commented-out
  // `call("GET"` satisfied "every probe reads the record back" for a probe that had stopped. A guard that
  // reads comments as code is not reading the program.
  const src = readFileSync(AUDIT, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const body = src.slice(src.indexOf("const CASES = ["));
  const chunks = body.split(/\n  \{\n/).slice(1);
  const cases = [];
  for (const chunk of chunks) {
    const claim = /claim:\s*\n?\s*"([^"]+)"/.exec(chunk)?.[1];
    if (!claim) continue;
    cases.push({
      claim,
      source: /source:\s*"([^"]+)"/.exec(chunk)?.[1],
      // Double- OR single-quoted, because a marker containing a quoted value reads better in single
      // quotes and the first extractor silently saw no marker at all — reported as "declares no marker",
      // which at least failed loudly rather than passing.
      marker: (/marker:\s*"((?:[^"\\]|\\.)+)"/.exec(chunk) ?? /marker:\s*'([^']+)'/.exec(chunk))?.[1]?.replace(
        /\\"/g,
        '"',
      ),
      // Allows escaped quotes inside the literal: a predicted value like `comes back "Acme As"` is
      // exactly the kind of distinctive string worth pinning, and the first regex could not see it.
      mustPredict: (
        /mustPredict:\s*"((?:[^"\\]|\\.)+)"/.exec(chunk) ?? /mustPredict:\s*'([^']+)'/.exec(chunk)
      )?.[1]?.replace(/\\"/g, '"'),
      predictsEcho: /predictsEcho:\s*true/.test(chunk),
      // A GET after the write counts, however it is spelled — the supplier case reads back with a plain
      // call() because suppliers are not customers. What matters is that something is read, not which
      // helper does it.
      readsBack: /readBack\(|patchAndRead\(|call\("GET"/.test(chunk),
      // `want` must be a literal the probe cannot manufacture from what it just read. The review noted
      // nothing constrained a probe's assertion at all: `want` could be built from `got` and every test
      // still passed, which is how the address case reported OK for an address that was absent.
      // A literal, or the conventional `sent` — a `want` derived from the INPUT is exactly right for a
      // claim of the form "what you sent survives", while one derived from the RESPONSE is a tautology.
      // The rule is the variable's name, so it is readable: call it `sent` or use a literal.
      wantsLiteral: /want:\s*(?:"|`[^`$]*`|sent\b)/.test(chunk),
    });
  }
  return cases;
}

test("every storage probe names a real source, and the source still PREDICTS what is measured", () => {
  const cases = auditCases();
  // Every case, not most: the review dropped two out of a 6-of-8 floor with ordinary edits, so the floor
  // is the count itself. A case removed on purpose is a one-character edit here, which is the point.
  assert.equal(
    cases.length,
    17,
    `expected 17 storage cases, extracted ${cases.length} — either a case was added without updating ` +
      `this number, or the extraction has stopped matching`,
  );

  for (const { claim, source, marker, mustPredict, predictsEcho } of cases) {
    const text = SOURCES[source];
    assert.ok(text, `the probe for "${claim}" names source "${source}", which is not resolved here`);
    assert.ok(marker, `"${claim}" declares no marker`);

    // A marker has to be substantial. The review passed this test with `marker: " "` and `marker: "e"`,
    // and the shipped case 7 used the five-letter word "stale".
    assert.ok(
      marker.length >= 12,
      `"${claim}" has marker ${JSON.stringify(marker)}, too short to bind anything — use a phrase`,
    );
    assert.ok(text.includes(marker), `"${claim}": ${source} no longer contains ${JSON.stringify(marker)}`);

    // And the part the marker cannot do. The review rewrote PHONE_RULE to say the OPPOSITE of every
    // phone claim while keeping all four markers, and this test passed 4/4 — markers live in the
    // opening sentences while the measured content sits further down. So each case also pins the VALUE
    // its source predicts: text that predicts "+46701234567" cannot simultaneously claim foreign
    // numbers are rewritten to +47.
    assert.ok(
      mustPredict || predictsEcho,
      `"${claim}" must declare mustPredict (the literal its source predicts) or predictsEcho`,
    );
    if (mustPredict) {
      assert.ok(
        text.includes(mustPredict),
        `"${claim}": ${source} must contain the value it predicts, ${JSON.stringify(mustPredict)}. ` +
          `Without that, the text can be rewritten to mean the opposite while every marker survives — ` +
          `which is exactly what the review of PR #115 demonstrated.`,
      );
    }
  }
});

test("every storage probe asserts against a literal, not against what it just read", () => {
  // A `want` interpolated from the same values as `got` reduces the case to a tautology. Two of the
  // seventeen did that, and both reported OK when the stored value was absent or destroyed rather than
  // replaced — the failure had the opposite fix from the one the claim describes.
  const offenders = auditCases().filter((c) => !c.wantsLiteral);
  assert.deepEqual(
    offenders.map((c) => c.claim),
    [],
    "these build `want` from what they read, so they cannot fail: give each a literal expectation",
  );
});

test("every storage probe reads the record back", () => {
  // Three of eight compared the POST echo, in the one family whose own constant ends "read the created
  // record back whenever the name or address matters".
  const offenders = auditCases().filter((c) => !c.readsBack);
  assert.deepEqual(
    offenders.map((c) => c.claim),
    [],
    "these compare what the write echoed, not what was stored — a create can echo a field it dropped",
  );
});

test("the storage audit writes only reversible records, and fails on a leak", () => {
  const src = readFileSync(AUDIT, "utf8");
  // It creates records, unlike the message audit, so the cleanup contract has to be visible. Customers
  // are the only thing written, because they delete cleanly.
  assert.match(src, /outcome !== "deleted"/);
  assert.match(src, /drift > 0 \|\| leaked > 0/, "a leak must affect the exit code");
  assert.match(src, /does not reach tenant/, "the token's tenant must be verified before writing");
});

test("the storage audit writes nothing this repo classifies irreversible", async () => {
  // Was a three-string blacklist of the paths the previous review happened to name — so adding
  // `PATCH /api/attachments/1` or `PUT /api/agreements/lease/1` passed, and `classifyRequest` calls both
  // irreversible. Assert the PROPERTY instead: extract every call and ask the policy engine, which is
  // the same code the server enforces with.
  const { classifyRequest } = await import("../dist/policy.js");
  const src = readFileSync(AUDIT, "utf8");
  const calls = [...src.matchAll(/call\(\s*"([A-Z]+)"\s*,\s*[`"]([^`"$]*)/g)]
    .map(([, method, path]) => ({ method, path: path.replace(/\?.*$/, "") }))
    // A path that begins with an interpolation captures as "" — the sweep builds one from a variable —
    // and classifying "" lands on "/", which reads as irreversible. Those are covered by the RESOURCES
    // list they come from, which is asserted below.
    .filter((c) => c.path.startsWith("/"));
  assert.ok(calls.length >= 6, `only ${calls.length} calls extracted — the extraction has stopped matching`);

  const bad = calls
    .map((c) => ({ ...c, risk: classifyRequest(c.method, c.path.replace(/\{[^}]+\}/g, "7") || "/") }))
    .filter((c) => c.risk === "irreversible");
  assert.deepEqual(
    bad.map((c) => `${c.method} ${c.path} (${c.risk})`),
    [],
    "the storage audit may only write things that can be deleted again",
  );

  // The templated paths the filter above skips all come from RESOURCES, so classify those too rather
  // than letting a variable path be an unexamined gap.
  const src2 = readFileSync(AUDIT, "utf8");
  const resourcePaths = [...src2.matchAll(/path:\s*"(\/api\/[a-z-]+)"/g)].map(([, p]) => p);
  assert.ok(resourcePaths.length >= 2, "expected the RESOURCES list to name at least two paths");
  for (const path of resourcePaths) {
    for (const method of ["POST", "DELETE"]) {
      assert.notEqual(
        classifyRequest(method, `${path}/7`),
        "irreversible",
        `${method} ${path} is irreversible, so the sweep must not create or delete there`,
      );
    }
  }
});

test("the storage audit reads the record back rather than trusting the write", () => {
  // A create can echo a field it silently dropped. That is not hypothetical here: `phone` is not a
  // create field, so four probes reported DRIFT against PHONE_RULE with `stored null` when the value
  // had never been written at all. Reading back is what distinguishes "the claim is wrong" from "the
  // probe wrote nothing".
  const src = readFileSync(AUDIT, "utf8");
  assert.match(src, /async function readBack/);
  assert.match(src, /patchAndRead/);
  assert.match(src, /not a create field/);
});

test("the phone claims are probed through PATCH, because create ignores the field", () => {
  // Pinned because it is the exact mistake made here, and the tool description already said so:
  // "Invoice email, phone and payment terms are not among them — set those with reai_update_customer".
  const create = salesTools.find((t) => t.name === "reai_create_customer");
  assert.ok(
    !("phone" in create.inputSchema),
    "reai_create_customer must not offer a phone argument the API ignores",
  );
  const src = readFileSync(AUDIT, "utf8");
  for (const sent of ["90123456", "+46701234567", "40123456"]) {
    assert.match(
      src,
      new RegExp(`patchAndRead\\("phone", "${sent.replace("+", "\\+")}"\\)`),
      `the ${sent} claim must be probed through PATCH, not create`,
    );
  }
});
