import { test } from "node:test";
import assert from "node:assert/strict";
import { salesTools } from "../dist/tools/sales.js";
import { purchaseTools } from "../dist/tools/purchase.js";
import { SKIP_REGISTRY_LOOKUP_RULE } from "../dist/tools/registry.js";
import { QUIRKS, quirksFor } from "../dist/reai/quirks.js";

/**
 * `skipRegistryLookup`, which two tools carry and which both described wrongly.
 *
 * The description promised "use exactly the details supplied". Measured on 29 organisation numbers:
 * sixteen ignore the flag and overwrite both name and address, and the override does not come from
 * Brønnøysundregistrene at all — it comes from a stale internal directory that returns a superseded
 * name for 971648198 and the wrong postcode for 976967631.
 *
 * The first version of this guard was worse than useless in one specific way, and that shaped what is
 * pinned here. It asserted the description names `974761076` "or the warning is unusable" — locking in
 * the claim that Skatteetaten is THE exception, which the measurement then contradicted. Fixing the
 * description required editing the test, which is backwards. So this pins the SHAPE of an honest
 * warning — a class rather than one number, the real source, the load-bearing use — and not any
 * particular sentence.
 */

const tool = (tools, name) => {
  const found = tools.find((t) => t.name === name);
  assert.ok(found, `${name} is not registered`);
  return found;
};

test("both tools that carry the flag describe it from the same source", () => {
  const customer = tool(salesTools, "reai_create_customer").inputSchema.skipRegistryLookup;
  const supplier = tool(purchaseTools, "reai_create_supplier").inputSchema.skipRegistryLookup;
  // The supplier tool kept the false string verbatim while the customer tool was corrected — one of
  // the two places the promise lived, and the reason the correction has one home now.
  for (const [label, schema] of [
    ["reai_create_customer", customer],
    ["reai_create_supplier", supplier],
  ]) {
    assert.equal(
      schema.description,
      SKIP_REGISTRY_LOOKUP_RULE,
      `${label} paraphrases the flag instead of using SKIP_REGISTRY_LOOKUP_RULE`,
    );
  }
});

test("the rule does not promise certainty, in any casing", () => {
  // Case-insensitive, because the previous assertions pinned capitalisation: "not a guarantee"
  // lower-case failed a test with no change in meaning.
  assert.doesNotMatch(SKIP_REGISTRY_LOOKUP_RULE, /use exactly the details supplied/i);
  assert.doesNotMatch(SKIP_REGISTRY_LOOKUP_RULE, /use exactly what you sent/i);
  assert.match(SKIP_REGISTRY_LOOKUP_RULE, /not a guarantee/i);
});

test("the rule warns about a CLASS of counterparty, not one organisation number", () => {
  // The failure this replaces: naming 974761076 as the exception, when sixteen numbers behave that
  // way. An agent that reads one number trusts the flag for DNB, Telia, Posten and Gjensidige.
  assert.match(SKIP_REGISTRY_LOOKUP_RULE, /banks/i);
  assert.match(SKIP_REGISTRY_LOOKUP_RULE, /telecoms|telecom/i);
  assert.match(SKIP_REGISTRY_LOOKUP_RULE, /public agenc/i);
  // And it must not present the hazard as a single named case.
  assert.doesNotMatch(
    SKIP_REGISTRY_LOOKUP_RULE,
    /(only|sole|one) (exception|counterexample)/i,
    "the hazard is a class; calling it an exception invites trusting the flag elsewhere",
  );
});

test("the rule names the real source and the reason it is dangerous", () => {
  // Not the registry. Three measurements rule that out, and the stale directory is a worse hazard
  // than "the registry wins" — a wrong address can be stored with a 201 and no warning.
  assert.match(SKIP_REGISTRY_LOOKUP_RULE, /stale/i);
  assert.doesNotMatch(
    SKIP_REGISTRY_LOOKUP_RULE,
    /the registry's name and address/i,
    "the override is not the registry; saying so hides that the stored value can be wrong",
  );
  assert.match(SKIP_REGISTRY_LOOKUP_RULE, /read the created record back/i);
});

test("the rule states the one thing the flag is required for", () => {
  // Without the flag an unregistered but mod-11-valid organisation number answers
  // 500 {"detail":"404 : [no body]"}; with it, 201. Nothing documented that, and it is the only
  // reason a caller MUST pass it.
  assert.match(SKIP_REGISTRY_LOOKUP_RULE, /not registered/i);
  assert.match(SKIP_REGISTRY_LOOKUP_RULE, /500/);
});

test("the two quirks about this flag do not contradict each other", () => {
  // Both attach to POST /api/customers, so reai_describe_endpoint emits them together. The older one
  // said "pass skipRegistryLookup to use exactly what you sent" while the newer said it is not a
  // guarantee — one response, two answers.
  const onCustomers = quirksFor("POST", "/api/customers");
  const ids = onCustomers.map((q) => q.id);
  assert.ok(ids.includes("brreg-lookup"), "the lookup quirk should still reach this operation");
  assert.ok(ids.includes("skip-registry-lookup-is-not-a-guarantee"));
  for (const q of onCustomers) {
    assert.doesNotMatch(
      q.note,
      /use exactly what you sent|use exactly the details supplied/i,
      `${q.id} still promises the flag is exact`,
    );
  }
});

test("the flag's quirk covers both operations that accept it", () => {
  // It was scoped to /api/customers only, while POST /api/suppliers behaves identically — measured,
  // 974761076 comes back "Skatteetaten" there too.
  const quirk = QUIRKS.find((q) => q.id === "skip-registry-lookup-is-not-a-guarantee");
  assert.ok(quirk, "the quirk should exist");
  assert.deepEqual([...quirk.paths].sort(), ["/api/customers", "/api/suppliers"]);
  assert.ok(quirksFor("POST", "/api/suppliers").some((q) => q.id === quirk.id));
});
