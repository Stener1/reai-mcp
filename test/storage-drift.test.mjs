import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PHONE_RULE, SKIP_REGISTRY_LOOKUP_RULE } from "../dist/tools/registry.js";
import { salesTools } from "../dist/tools/sales.js";

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
 * What this deliberately does NOT do is assert that every storage claim in the repository has a probe.
 * It cannot know the population, and asserting completeness it cannot measure is the failure mode
 * three PRs in this repository were spent unwinding.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIT = path.join(HERE, "..", "scripts/audit-storage.mjs");

/** The constants the audit's cases name, resolved so a rename cannot leave a dangling reference. */
const SOURCES = {
  PHONE_RULE,
  SKIP_REGISTRY_LOOKUP_RULE,
  "reai_create_customer description": salesTools.find((t) => t.name === "reai_create_customer")
    .description,
};

function auditCases() {
  const src = readFileSync(AUDIT, "utf8");
  const cases = [];
  const re = /claim:\s*\n?\s*"([^"]+)",\s*\n\s*source:\s*"([^"]+)",\s*\n\s*marker:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) cases.push({ claim: m[1], source: m[2], marker: m[3] });
  return cases;
}

test("every storage probe names a real source that still contains its claim", () => {
  const cases = auditCases();
  // A floor on the work: eight cases across three sources today. If the extraction stops matching, this
  // sweep guards nothing while still passing — the failure this repository keeps paying for.
  assert.ok(
    cases.length >= 6,
    `only ${cases.length} storage cases extracted (8 today) — the extraction has stopped matching`,
  );

  for (const { claim, source, marker } of cases) {
    const text = SOURCES[source];
    assert.ok(text, `the probe for "${claim}" names source "${source}", which is not resolved here`);
    assert.ok(
      text.includes(marker),
      `"${claim}" is probed against ${source}, but that text no longer contains "${marker}".\n` +
        `Either the claim changed — in which case re-measure and update the probe — or the marker is ` +
        `stale. The probe must not outlive the sentence it verifies.`,
    );
  }
});

test("the storage audit writes only reversible records, and fails on a leak", () => {
  const src = readFileSync(AUDIT, "utf8");
  // It creates records, unlike the message audit, so the cleanup contract has to be visible. Customers
  // are the only thing written, because they delete cleanly.
  assert.match(src, /outcome !== "deleted"/);
  assert.match(src, /drift > 0 \|\| leaked > 0/, "a leak must affect the exit code");
  assert.match(src, /does not reach tenant/, "the token's tenant must be verified before writing");
  // Nothing here may touch a path this repo classifies irreversible. Vouchers, share investments and
  // sub-accounts are exactly what the message audit had to have removed from it.
  for (const forbidden of ["/api/vouchers", "/api/share-investments", "/api/general-sub-accounts"]) {
    assert.ok(!src.includes(forbidden), `the storage audit must not write to ${forbidden}`);
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
