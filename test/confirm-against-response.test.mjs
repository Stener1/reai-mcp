import { test } from "node:test";
import assert from "node:assert/strict";
import { registeredTools } from "../dist/server.js";
import { confirmAgainstResponse, describeConfirmation } from "../dist/tools/registry.js";

/**
 * Five read-merge-write tools reported an outcome from what they SENT rather than from the response. They were
 * found and fixed one at a time, and TWICE the fix repeated a mistake an earlier fix had already corrected:
 * the `given` gate that blinds the check to a carried value, and the `""`/null comparison that flags a
 * successful clear. That is the argument for one helper rather than five careful sites, and for one test file
 * that holds every tool to the same rule.
 *
 * The remaining four are covered here. `reai_update_creditor` (#141) and `reai_update_subscription` (#142)
 * have their own, richer tests in loans/subscriptions.
 */

const tool = (name) => {
  const found = registeredTools.find((t) => t.name === name);
  assert.ok(found, `${name} should exist`);
  return found;
};

/** Answers the GET with `before` and the write with `after`, recording what was sent. */
async function run(name, args, before, after) {
  const sent = [];
  const queue = [{ data: before, status: 200 }, { data: after, status: 200 }];
  const result = await tool(name).handler(
    { tenantId: 2783, ...args },
    {
      client: {
        request: async (req) => { sent.push(req); return queue.shift() ?? { data: after, status: 200 }; },
        deepLink: () => "link",
      },
      config: { boundTenantId: undefined, defaultTenantId: 2783, tenantId: 2783, writeMode: "full", allowExternalSend: true },
      session: {},
    },
  );
  const text = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { sent, result, text };
}

// ---------------------------------------------------------------------------
// The helper itself, on the semantics that were measured rather than assumed
// ---------------------------------------------------------------------------

test("a non-answer is not a confirmation", () => {
  // `sendEhf: null` silently dropped an arming flag out of a sentence containing the word "confirmed".
  for (const response of [{}, { comment: null }, "OK", undefined, null, []]) {
    const c = confirmAgainstResponse({ comment: "x" }, response);
    assert.deepEqual(c.confirmed, [], `${JSON.stringify(response)} must not confirm anything`);
    assert.deepEqual(c.unanswered, ["comment"]);
  }
});

test('an empty string stored as null is the API doing what was asked, not a disagreement', () => {
  // The bug #140's review found in the sales tools, and which I then reintroduced in #141's creditor fix.
  const c = confirmAgainstResponse({ comment: "" }, { comment: null });
  assert.deepEqual(c.confirmed, ["comment"]);
  assert.equal(c.contradicted.length, 0);
  // And the reverse spelling.
  assert.deepEqual(confirmAgainstResponse({ comment: null }, { comment: "" }).confirmed, ["comment"]);
});

test("strings are compared trimmed, and a real disagreement is reported with both values", () => {
  assert.deepEqual(confirmAgainstResponse({ name: " ZZ " }, { name: "ZZ" }).confirmed, ["name"]);
  const c = confirmAgainstResponse({ name: "ZZ" }, { name: "Other" });
  assert.deepEqual(c.contradicted, [{ field: "name", sent: "ZZ", stored: "Other" }]);
  const [note] = describeConfirmation(c, "customer 5");
  assert.match(note, /WARNING/);
  assert.match(note, /name \(sent "ZZ", customer 5 came back with "Other"\)/);
});

test("skip is for fields whose shape differs between request and response", () => {
  // orderLines vs lines: not comparable here, and the line counts are checked by their own tools.
  const c = confirmAgainstResponse({ orderLines: [1], comment: "x" }, { comment: "x" }, { skip: ["orderLines"] });
  assert.deepEqual(c.confirmed, ["comment"]);
  assert.deepEqual(c.unanswered, []);
});

// ---------------------------------------------------------------------------
// The four tools
// ---------------------------------------------------------------------------

test("reai_update_salary_line reports the amounts from the response, not from args", async () => {
  // Payroll. Quoting the request back as "Line N is now Q × R" states a figure nobody checked.
  const runRec = (quantity) => ({
    id: 9, payableAmount: 1000, totalTaxDeducted: 200,
    employees: [{ id: 1, wageSpecs: [{ id: 77, specificationCode: "HOURLY_WAGE", quantity, rate: 500, comment: null }] }],
  });
  const { text } = await run(
    "reai_update_salary_line",
    { id: 9, wageSpecId: 77, specificationCode: "HOURLY_WAGE", quantity: 3, rate: 500 },
    runRec(3),
    runRec(2),
  );
  assert.match(text, /is now 2 × 500 as HOURLY_WAGE, read back from the response/);
  assert.match(text, /WARNING: quantity \(sent 3, line 77 came back with 2\)/);
});

test("reai_update_salary_line says so when the response does not carry the line", async () => {
  const { text } = await run(
    "reai_update_salary_line",
    { id: 9, wageSpecId: 77, specificationCode: "HOURLY_WAGE", quantity: 3, rate: 500 },
    { id: 9, payableAmount: 1000, employees: [{ id: 1, wageSpecs: [{ id: 77, specificationCode: "HOURLY_WAGE", quantity: 3, rate: 500 }] }] },
    { id: 9, payableAmount: 1000, employees: [] },
  );
  assert.match(text, /was sent as 3 × 500/);
  assert.match(text, /what was SENT, not what is stored/);
  assert.match(text, /reai_get_salary_run/);
});

test("reai_update_share_investment checks its fields against the response", async () => {
  const inv = (over = {}) => ({ id: 3, name: "ZZ AS", instrumentType: "share", ticker: "ZZZ", isin: "NO0000000000", organizationNumber: "999999999", ...over });
  const { text } = await run("reai_update_share_investment", { id: 3, ticker: "NEW" }, inv(), inv({ ticker: "ZZZ" }));
  assert.match(text, /WARNING: ticker \(sent "NEW", share investment 3 came back with "ZZZ"\)/);
  const ok = await run("reai_update_share_investment", { id: 3, ticker: "NEW" }, inv(), inv({ ticker: "NEW" }));
  assert.doesNotMatch(ok.text, /WARNING/);
});

test("reai_set_customer_address checks the parts against the response", async () => {
  const addr = (over = {}) => ({ addressPart1: "Gata 1", city: "Oslo", postalCode: "0150", countryCode: "NO", ...over });
  // The address is NESTED under `address` on the customer record; the PUT answers with the address itself.
  const { text } = await run("reai_set_customer_address", { id: 5, city: "Bergen" }, { id: 5, address: addr() }, addr({ city: "Oslo" }));
  assert.match(text, /WARNING: city \(sent "Bergen", the address came back with "Oslo"\)/);
});

test("reai_set_customer_address reports a string response as unconfirmed rather than asserting success", async () => {
  // The API answers some of these with a bare string, and asserting the parts were stored would be a claim
  // nothing checked.
  const addr = { addressPart1: "Gata 1", city: "Oslo", postalCode: "0150", countryCode: "NO" };
  const { text } = await run("reai_set_customer_address", { id: 5, city: "Bergen" }, { id: 5, address: addr }, "Address updated.");
  assert.match(text, /did not answer for city/);
  assert.match(text, /could not be confirmed/);
});

test("reai_set_supplier_address checks the parts against the response", async () => {
  const addr = (over = {}) => ({ addressPart1: "Gata 1", city: "Oslo", postalCode: "0150", countryCode: "NO", ...over });
  const { text } = await run("reai_set_supplier_address", { id: 5, city: "Bergen" }, { id: 5, address: addr() }, addr({ city: "Oslo" }));
  assert.match(text, /WARNING: city \(sent "Bergen", the address came back with "Oslo"\)/);
});

/**
 * The tripwire. Thirteen tools GET then PUT/PATCH, and reporting the request as the outcome was a defect in
 * five of them — found one at a time over four PRs, twice reintroducing a mistake an earlier fix had already
 * corrected. The point of this list is that a FOURTEENTH cannot be added without someone deciding which side
 * of it it belongs on.
 *
 * PROVEN means a test somewhere drives the handler with a response that DISAGREES with the request and
 * requires the tool to say so. The test is named, so the claim is checkable rather than asserted.
 */
const VERIFIES_AGAINST_RESPONSE = {
  reai_update_salary_line: "this file: reports the amounts from the response, not from args",
  reai_update_share_investment: "this file: checks its fields against the response",
  reai_set_customer_address: "this file: checks the parts against the response",
  reai_set_supplier_address: "this file: checks the parts against the response",
  reai_update_creditor: "test/loans.test.mjs: a rename whose replacement drops the carried account …",
  reai_update_company_bank: "test/loans.test.mjs: does not call a bodyless response an empty account",
  reai_update_subscription: "test/subscriptions.test.mjs: a CARRIED arming value the response contradicts …",
  reai_update_order: "test/update-order.test.mjs: a value stored differently from what was sent is flagged",
  reai_update_offer: "test/update-offer.test.mjs: a value stored differently from what was sent is flagged",
  reai_update_agreement: "test/agreements.test.mjs: a value the API silently did not store is reported",
};

/**
 * Not proven, with the reason. Each of these still reports something, so being here is a statement that
 * nobody has checked it against a disagreeing response — not that it is fine.
 */
const UNVERIFIED = {
  reai_update_loan: "verifies the stored relatedParty and the interest accounts off res.data, but no test drives a disagreement",
  reai_set_employee_bank_account: "compares digit-normalised before/after and re-reads — the best in the repo, but the comparison is untested against a disagreement",
  reai_add_employment_line: "reports the line it added from args; no per-field outcome claim was reviewed",
};

test("every merge tool is classified, so a new one cannot slip in unexamined", async () => {
  const merge = registeredTools
    .filter((t) => {
      const methods = (t.apiPaths ?? []).map(([m]) => m);
      return methods.includes("GET") && (methods.includes("PUT") || methods.includes("PATCH"));
    })
    .map((t) => t.name)
    .sort();

  const classified = new Set([...Object.keys(VERIFIES_AGAINST_RESPONSE), ...Object.keys(UNVERIFIED)]);
  const unclassified = merge.filter((n) => !classified.has(n));
  assert.deepEqual(
    unclassified,
    [],
    `these tools read then replace and are not classified above. Decide whether each verifies its outcome ` +
      `against the response, and add it to VERIFIES_AGAINST_RESPONSE with the test that proves it or to ` +
      `UNVERIFIED with why: ${unclassified.join(", ")}`,
  );
  // And nothing may sit in the lists that is not a merge tool, so a rename cannot leave a stale entry behind.
  const stale = [...classified].filter((n) => !merge.includes(n));
  assert.deepEqual(stale, [], `no longer a read-then-replace tool: ${stale.join(", ")}`);

  // A floor, so deleting entries cannot quietly shrink what this covers.
  assert.equal(merge.length, 13, `the merge-tool count moved to ${merge.length}; classify the difference`);
  assert.ok(
    Object.keys(VERIFIES_AGAINST_RESPONSE).length >= 10,
    `${Object.keys(VERIFIES_AGAINST_RESPONSE).length} of ${merge.length} verify; that number should not fall`,
  );
});
