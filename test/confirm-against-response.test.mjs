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
 *
 * How far the consolidation actually got, since claiming "one place" would be the same overstatement this file
 * exists to catch: SIX of the eleven certified tools route through `confirmAgainstResponse` — the four here
 * plus order and offer, whose near-duplicate helper with the opposite semantics now delegates to it. Creditor,
 * company bank, subscription, agreement and employee bank account still hand-roll their own wording.
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

test("key order is not a disagreement, and neither is the spelling of a number", () => {
  // Both were measured as false contradictions in the first version of this helper. An object-valued field —
  // an offer's deliveryAddress, say — would have warned on every write purely because the API serialises its
  // keys in a different order, and a payroll quantity would have warned on 3 vs "3".
  assert.deepEqual(confirmAgainstResponse({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } }).confirmed, ["a"]);
  assert.deepEqual(confirmAgainstResponse({ a: { p: { m: 1, n: 2 } } }, { a: { p: { n: 2, m: 1 } } }).confirmed, ["a"]);
  assert.deepEqual(confirmAgainstResponse({ a: 5 }, { a: "5" }).confirmed, ["a"]);
  assert.deepEqual(confirmAgainstResponse({ a: "3.0" }, { a: 3 }).confirmed, ["a"], "same number, no information lost");
  // And a real difference still is one, in both shapes.
  assert.equal(confirmAgainstResponse({ a: 5 }, { a: 6 }).contradicted.length, 1);
  assert.equal(confirmAgainstResponse({ a: { x: 1 } }, { a: { x: 2 } }).contradicted.length, 1);
  // A non-numeric string must not be coerced into agreeing with a number.
  assert.equal(confirmAgainstResponse({ a: "abc" }, { a: 0 }).contradicted.length, 1);
  // The three classes the first version got wrong. A leading zero is an identifier, not a quantity — and a
  // postalCode losing one is the exact harm #140 measured on the address endpoint.
  assert.equal(confirmAgainstResponse({ postalCode: "0150" }, { postalCode: 150 }).contradicted.length, 1);
  assert.equal(confirmAgainstResponse({ a: "1e3" }, { a: 1000 }).contradicted.length, 1);
  assert.equal(confirmAgainstResponse({ a: "0x10" }, { a: 16 }).contradicted.length, 1);
  // Two different eighteen-digit ids compared equal through float64.
  assert.equal(
    confirmAgainstResponse({ a: "123456789012345678" }, { a: 123456789012345679 }).contradicted.length,
    1,
  );
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

/**
 * The address responses are DOCUMENTED as CustomerRes / SupplierRes with the parts nested at `.address` (or
 * `.deliveryAddress`), and the first version of these tests fed a bare address object instead — a shape the
 * document does not describe and nothing in this repo measures. They passed against that fiction while the
 * tool compared the parts to the top level of a customer record, so the contradiction branch was unreachable
 * and every successful write printed "could not be confirmed". Derived from the schema now.
 */
const addressParts = (over = {}) => ({
  addressPart1: "Gata 1",
  city: "Oslo",
  postalCode: "0150",
  countryCode: "NO",
  ...over,
});
const customerRecord = (over = {}) => ({ id: 5, name: "ZZ Kunde", address: addressParts(over) });
const supplierRecord = (over = {}) => ({ id: 5, name: "ZZ Leverandør", address: addressParts(over) });

test("reai_set_customer_address checks the parts against the nested response", async () => {
  const { text } = await run(
    "reai_set_customer_address",
    { id: 5, city: "Bergen" },
    customerRecord(),
    customerRecord({ city: "Oslo" }),
  );
  assert.match(text, /WARNING: city \(sent "Bergen", the address came back with "Oslo"\)/);
});

test("reai_set_customer_address confirms silently when the nested response agrees", async () => {
  const { text } = await run(
    "reai_set_customer_address",
    { id: 5, city: "Bergen" },
    customerRecord(),
    customerRecord({ city: "Bergen" }),
  );
  assert.doesNotMatch(text, /WARNING/);
  assert.doesNotMatch(text, /could not be confirmed/, "the response confirms it — saying otherwise was the bug");
});

test("reai_set_customer_address checks the CARRIED parts, not only what the caller named", async () => {
  // #140's measured harm on this very endpoint was a carried postalCode being wiped. A check keyed on the
  // caller's own fields would have excluded exactly the field that was lost.
  const { text } = await run(
    "reai_set_customer_address",
    { id: 5, city: "Bergen" },
    customerRecord(),
    customerRecord({ city: "Bergen", postalCode: null }),
  );
  assert.match(text, /WARNING: postalCode \(sent "0150", the address came back with null\)/);
});

test("reai_set_supplier_address checks the supplier parts against the nested response", async () => {
  const { text } = await run(
    "reai_set_supplier_address",
    { id: 5, city: "Bergen" },
    supplierRecord(),
    supplierRecord({ city: "Oslo" }),
  );
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
  reai_update_salary_line: ["test/confirm-against-response.test.mjs", "reai_update_salary_line reports the amounts from the response, not from args"],
  reai_update_share_investment: ["test/confirm-against-response.test.mjs", "reai_update_share_investment checks its fields against the response"],
  reai_set_customer_address: ["test/confirm-against-response.test.mjs", "reai_set_customer_address checks the parts against the nested response"],
  reai_set_supplier_address: ["test/confirm-against-response.test.mjs", "reai_set_supplier_address checks the supplier parts against the nested response"],
  reai_update_creditor: ["test/loans.test.mjs", "a rename whose replacement drops the carried account is the case this tool exists for, and warns"],
  reai_update_company_bank: ["test/loans.test.mjs", "reai_update_company_bank does not call a bodyless response an empty account"],
  reai_update_subscription: ["test/subscriptions.test.mjs", "a CARRIED arming value the response contradicts is warned about — no `given` gate"],
  reai_update_order: ["test/update-order.test.mjs", "a value stored differently from what was sent is flagged"],
  reai_update_offer: ["test/update-offer.test.mjs", "a value stored differently from what was sent is flagged"],
  reai_update_agreement: ["test/agreements.test.mjs", "a value the API silently did not store is reported, not assumed"],
  // Proven twice, and the strongest example in the repo — it compares digit-normalised and refuses. An earlier
  // version of this file listed it as UNVERIFIED with a reason that was wrong on both clauses, which is the
  // error class this whole list exists to prevent, occurring inside the list.
  reai_set_employee_bank_account: ["test/employees.test.mjs", "a stored account that does not match what was sent is flagged, not celebrated"],
};

/**
 * Not proven, with the reason. Being here is a statement that nobody has driven this tool with a disagreeing
 * response — not that it is fine.
 */
const UNVERIFIED = {
  reai_update_loan: "relatedParty and the interest accounts ARE checked against the response, and test/loans.test.mjs drives a relatedParty disagreement — but the rest of its fields are not, so it is not certified here",
  reai_add_employment_line: "checks the line COUNT against the response and that is tested; the per-field content of the added line is not",
};

test("every merge tool is classified, so a new one cannot slip in unexamined", async () => {
  const merge = registeredTools
    .filter((t) => {
      const methods = (t.apiPaths ?? []).map(([m]) => m);
      return methods.includes("GET") && (methods.includes("PUT") || methods.includes("PATCH"));
    })
    .map((t) => t.name)
    .sort();

  // The naming has to be CHECKED, or the list is prose. Verified: repointing an entry at
  // "test/no-such-file.test.mjs" and promoting a tool with an invented test name both passed, because only
  // Object.keys was ever read. Now the file must exist and must contain a test with that title.
  const { readFileSync, existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join, dirname } = await import("node:path");
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
  // Three ways the substring version was still defeatable, all reproduced by a review: the title could live in
  // a COMMENT or an assertion message; two entries could name the SAME title so deleting one test left the
  // other satisfying both; and the named test could have a body that proves nothing. Anchored on the `test("`
  // that opens it, required to be distinct per entry, and required to mention the tool it certifies.
  const seenTitles = new Set();
  for (const [name, [file, title]] of Object.entries(VERIFIES_AGAINST_RESPONSE)) {
    assert.ok(existsSync(join(repo, file)), `${name} names ${file}, which does not exist`);
    const body = readFileSync(join(repo, file), "utf8");
    const opener = `test("${title}"`;
    assert.ok(
      body.includes(opener),
      `${name} claims a test titled "${title}" in ${file}. No test OPENS with that title there — a mention ` +
        `in a comment or an assertion message does not count.`,
    );
    const key = `${file}::${title}`;
    assert.ok(!seenTitles.has(key), `two entries name the same test (${key}); deleting it would leave both green`);
    seenTitles.add(key);
    // The named test must at least be about this tool. Cheap, and it kills a body that proves nothing about it.
    const from = body.indexOf(opener);
    const next = body.indexOf('\ntest(', from + 1);
    const testBody = body.slice(from, next === -1 ? body.length : next);
    assert.ok(
      testBody.includes(name) || testBody.includes(name.replace(/^reai_/, "")),
      `the test "${title}" never mentions ${name}, so it cannot be what proves it`,
    );
  }

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
    Object.keys(VERIFIES_AGAINST_RESPONSE).length >= 11,
    `${Object.keys(VERIFIES_AGAINST_RESPONSE).length} of ${merge.length} verify; that number should not fall`,
  );
});

test("the salary fallback distinguishes no lines from no matching line", async () => {
  // SalaryWageSpecRes.id is assumed to BE the wageSpecId the path takes — read off the schema, not measured.
  // If that is wrong the lookup finds nothing, and the two messages differ so the wrong assumption shows up
  // rather than hiding behind "the response did not carry the line".
  const none = await run(
    "reai_update_salary_line",
    { id: 9, wageSpecId: 77, specificationCode: "HOURLY_WAGE", quantity: 3, rate: 500 },
    { id: 9, employees: [{ id: 1, wageSpecs: [{ id: 77, specificationCode: "HOURLY_WAGE", quantity: 3, rate: 500 }] }] },
    { id: 9, employees: [] },
  );
  assert.match(none.text, /carried no lines/);
  const mismatched = await run(
    "reai_update_salary_line",
    { id: 9, wageSpecId: 77, specificationCode: "HOURLY_WAGE", quantity: 3, rate: 500 },
    { id: 9, employees: [{ id: 1, wageSpecs: [{ id: 77, specificationCode: "HOURLY_WAGE", quantity: 3, rate: 500 }] }] },
    { id: 9, employees: [{ id: 1, wageSpecs: [{ id: 99, quantity: 3, rate: 500 }] }] },
  );
  assert.match(mismatched.text, /carried 1 line\(s\) but none with id 77/);
});

test("reai_update_salary_line treats a dropped carried comment as a contradiction, not a silence", async () => {
  // The blocking finding of the re-review: this site omitted `wholeRecord`, so a carried comment the replacing
  // PUT dropped read as "the response did not answer" while the headline said the line was read back FROM the
  // response. Payroll is where I argued this matters most, and it was the one site I had not checked.
  const runRec = (comment) => ({
    id: 9, payableAmount: 1000, totalTaxDeducted: 200,
    employees: [{ id: 1, wageSpecs: [{ id: 77, specificationCode: "HOURLY_WAGE", quantity: 3, rate: 500, comment }] }],
  });
  const { text } = await run(
    "reai_update_salary_line",
    { id: 9, wageSpecId: 77, specificationCode: "HOURLY_WAGE", quantity: 3, rate: 500, comment: "ZZ note" },
    runRec("ZZ note"),
    runRec(null),
  );
  assert.match(text, /WARNING: comment \(sent "ZZ note", line 77 came back with null\)/);
  assert.doesNotMatch(text, /did not answer for comment/, "the response answered — with null");
});

test("reai_set_customer_address distinguishes a wiped address from an unreadable response", async () => {
  // readableRecord answers `{ record: {} }` for a nested field that is missing OR null. The second means the
  // whole address is gone, and an empty base made that read as the same soft "could not be confirmed" a bare
  // string gets — two responses meaning entirely different things.
  const parts = { addressPart1: "Gata 1", city: "Oslo", postalCode: "0150", countryCode: "NO" };
  const wiped = await run("reai_set_customer_address", { id: 5, city: "Bergen" }, { id: 5, address: parts }, { id: 5, address: null });
  assert.match(wiped.text, /no postal address at all — every part is gone/);
  const unreadable = await run("reai_set_customer_address", { id: 5, city: "Bergen" }, { id: 5, address: parts }, "Updated.");
  assert.match(unreadable.text, /could not be confirmed/);
  assert.doesNotMatch(unreadable.text, /every part is gone/, "an unreadable response is not evidence of a wipe");
});

test("the order and offer tools no longer count an unanswered field as applied", async () => {
  // appliedChanges was a near-duplicate with the OPPOSITE semantics, in the same file as the migrated sites,
  // while both tools were certified as verifying against the response. A bodyless PUT produced a bare
  // "Changed comment".
  const { registeredTools: tools } = await import("../dist/server.js");
  const order = tools.find((t) => t.name === "reai_update_order");
  const rec = (over = {}) => ({
    id: 4105, number: "OR-4105", currencyCode: "NOK", customerId: 1, daysUntilDue: 14, issueDate: "2026-08-09",
    comment: "ZZ C", sendEhf: false, invoiceId: null,
    lines: [{ id: 1, itemName: "x", quantity: 1, unitPrice: 5, vatCode: "0" }], ...over,
  });
  for (const [label, after] of [["no body", undefined], ["omits the field", rec({ comment: undefined })]]) {
    const queue = [{ data: rec(), status: 200 }, { data: after, status: 200 }];
    const result = await order.handler(
      { id: 4105, comment: "NEW", tenantId: 2783 },
      { client: { request: async () => queue.shift(), deepLink: () => "l" }, config: { writeMode: "full", tenantId: 2783 }, session: {} },
    );
    const text = result.content.find((c) => c.type === "text").text;
    assert.match(
      text,
      // "you asked for" is part of the claim, not decoration: the record may well have changed, and review
      // built the case where a bare "Changed NOTHING" sat above a warning that a comment had been destroyed.
      /Changed NOTHING you asked for/,
      `${label}: an unconfirmable change must not be claimed`,
    );
  }
});

/**
 * The other blind spot: tools with NO declared GET.
 *
 * The classification above is gated on `apiPaths` containing a GET, which is what a read-merge-write tool
 * looks like. Three tools that report an outcome from `args` were therefore invisible to it, and survived five
 * rediscoveries for exactly that reason — `reai_set_asset_depreciation`, `reai_rename_warehouse` and
 * `reai_rename_sub_account`, each of whose write endpoint returns a record carrying the field it echoed.
 *
 * So this population is DERIVED from the spec rather than from a list anyone maintains: a tool qualifies when
 * one of its write endpoints answers with a schema that carries a field the tool's own inputSchema accepts.
 * If the response can answer the question, quoting the request is a choice.
 *
 * Identity fields are excluded. An echoed `id` or `orgNumber` went out in the path and comes back unchanged
 * whatever the API did with the payload, so it cannot confirm anything.
 */
const IDENTITY_FIELDS = ["id", "tenantId", "orgNumber", "organizationNumber"];

/** Proven to state the stored value, each with the test that drives a DISAGREEING response. */
const READS_BACK_FROM_RESPONSE = {
  reai_set_asset_depreciation: [
    "test/assets.test.mjs",
    "setting a depreciation schedule states what the response stored, not what was sent",
  ],
  reai_rename_warehouse: [
    "test/warehouses.test.mjs",
    "renaming a warehouse states the name the response carries, not the one sent",
  ],
  reai_rename_sub_account: [
    "test/subaccounts.test.mjs",
    "renaming a sub-account states the name the response carries, not the one sent",
  ],
  reai_update_lead: ["test/leads.test.mjs", "reai_update_lead reports a carried contact field the API destroyed"],
  reai_create_sub_account: [
    "test/subaccounts.test.mjs",
    "creating a sub-account states the name the response stored, not the one sent",
  ],
  reai_add_salary_line: [
    "test/salary.test.mjs",
    "reai_add_salary_line reports the added line from the response, not from args",
  ],
  reai_log_lead_contact: [
    "test/leads.test.mjs",
    "reai_log_lead_contact reports the event from the response, not from args",
  ],
};

/**
 * The tools the behavioural sweep below cannot generate arguments for, and therefore cannot judge.
 *
 * This list used to hold 40 names and mean "nobody has checked". It was a ratchet, and a ratchet on a hand-kept
 * list is only ever as good as the hand. Driving every candidate against a response that DISAGREED with the
 * request replaced 40 assertions with 40 measurements, and found two tools echoing their arguments —
 * `reai_create_asset` (irreversible, and the field was the balance-sheet account carrying the asset) and
 * `reai_create_warehouse` (whose own description says names are not unique, so naming the wrong one leaves a
 * caller unable to tell which of two they just made).
 *
 * What remains here is the residue the sweep genuinely cannot reach: a schema whose required shape the sampler
 * cannot construct. That is a real gap, not a soft one, so it is named rather than counted.
 */
/** Filled by the classification test, read by the sweep, so the population is derived in one place. */
const CANDIDATES = [];

const NOT_ESTABLISHED = [
  // MEASURED, not guessed. The first version of this list had seven names in it, carried over from a weaker
  // sampler; the four extras are driven fine and one of them, `reai_set_bank_statement_balance`, turned out to
  // be echoing its month — which the sweep then caught the moment the list stopped hiding it.
  // A shape the sampler cannot construct: a record of arbitrary keys, a discriminated line union, a posting set
  // that has to balance.
  "reai_create_agreement",
  "reai_create_subscription",
  "reai_create_voucher",
  // These two REFUSE before sending anything, and correctly: each requires one of two arguments and no schema
  // can express that, so a sampler filling in the required fields produces a body the tool declines.
  //
  //   reai_apply_reconciliation_rules  "Give either a month (yyyy-MM) or a complete startDate/endDate range."
  //   reai_register_supplier_invoice_payment  "companyBankId is required unless paidPrivately=true."
  //
  // `reai_apply_reconciliation_rules` is here because the sweep now checks that the request actually WENT OUT.
  // It had been counted as covered while never reaching the stub at all — which is the same "measured nothing"
  // hole that made `reai_update_expense` look covered while it returned "No fields were given".
  "reai_apply_reconciliation_rules",
  "reai_register_supplier_invoice_payment",
];
test("a write tool whose response could answer for it is classified, GET or no GET", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join, dirname } = await import("node:path");
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
  const spec = JSON.parse(readFileSync(join(repo, "spec", "reai-openapi.json"), "utf8"));
  const schemas = spec.components?.schemas ?? {};

  /**
   * The property names of whatever schema a write endpoint answers SUCCESSFULLY with.
   *
   * Every 2xx, not just 200/201. Review found the hole: `reai_apply_reconciliation_rules` posts to an endpoint
   * documented as **202**, whose record carries `month`, `startDate` and `endDate` — all accepted by that
   * tool — so it fell out of the census entirely and neither list had to account for it. A guard that skips
   * the tools it cannot categorise is not a guard.
   */
  /**
   * Property names reachable in a schema, following `allOf` and descending through nested objects and arrays.
   *
   * Both refinements came from review finding a real tool escaping:
   *
   *   NESTED — `reai_add_salary_line` echoed `args.quantity`, `args.rate` and `args.specificationCode` while
   *   the POST answers with `SalaryPaymentDetailRes`, which carries the stored line at
   *   `employees[].wageSpecs[]`. Comparing only TOP-LEVEL names found none of them, so the tool was in neither
   *   list and the tripwire was green — while its own sibling `reai_update_salary_line` is certified by the
   *   older census for walking exactly that path, ten lines away in the same file.
   *
   *   allOf — `BankReconciliationOverviewRes` declares its 30-odd fields inside an `allOf` member, so reading
   *   `schemas[name].properties` returned nothing. Latent rather than live (no registered tool declares those
   *   two paths today), but a census that returns zero fields drops the tool silently, which is the failure
   *   mode this whole file exists to stop.
   */
  const fieldsOf = (schema, depth = 0, seen = new Set()) => {
    if (!schema || depth > 4) return [];
    if (schema.$ref) {
      const name = schema.$ref.split("/").pop();
      if (seen.has(name)) return [];
      return fieldsOf(schemas[name], depth, new Set([...seen, name]));
    }
    const names = [];
    for (const member of schema.allOf ?? []) names.push(...fieldsOf(member, depth, seen));
    if (schema.items) names.push(...fieldsOf(schema.items, depth + 1, seen));
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      names.push(key);
      names.push(...fieldsOf(prop, depth + 1, seen));
    }
    return names;
  };

  /** The fields any SUCCESSFUL response of this write endpoint can carry, at any depth. */
  const responseFields = (method, path) => {
    const op = spec.paths?.[path]?.[method.toLowerCase()];
    const names = new Set();
    for (const [code, body] of Object.entries(op?.responses ?? {})) {
      if (!/^2\d\d$/.test(code)) continue;
      for (const media of Object.values(body?.content ?? {})) {
        for (const k of fieldsOf(media?.schema)) names.add(k);
      }
    }
    return [...names];
  };

  const candidates = registeredTools
    .filter((t) => {
      const paths = t.apiPaths ?? [];
      // Exclude only what the OTHER census actually owns — GET *plus* PUT/PATCH — rather than anything that
      // declares a GET at all. Review found tools falling between the two: `reai_create_order` and
      // `reai_create_offer` declare their POST plus an ancillary customer GET, so the first census skipped them
      // for having no PUT/PATCH and this one skipped them for having a GET. Neither list had to account for
      // them, which is a hole in the thing this file calls a ratchet.
      const methods = paths.map(([m]) => m);
      const ownedByMergeCensus =
        methods.includes("GET") && (methods.includes("PUT") || methods.includes("PATCH"));
      if (ownedByMergeCensus) return false;
      const accepts = new Set(Object.keys(t.inputSchema ?? {}));
      return paths
        .filter(([m]) => ["PUT", "PATCH", "POST"].includes(m))
        .some(([m, p]) =>
          responseFields(m, p).some((f) => accepts.has(f) && !IDENTITY_FIELDS.includes(f)),
        );
    })
    .map((t) => t.name)
    .sort();

  // The population is exported for the behavioural sweep in the next test, which is what actually judges the
  // members. This test's remaining job is the two lists: nothing stale in them, and no candidate is BOTH
  // hand-certified and parked as unreachable.
  CANDIDATES.push(...candidates);
  const both = Object.keys(READS_BACK_FROM_RESPONSE).filter((n) => NOT_ESTABLISHED.includes(n));
  assert.deepEqual(both, [], `certified and parked as unreachable at once: ${both.join(", ")}`);
  const stale = [...Object.keys(READS_BACK_FROM_RESPONSE), ...NOT_ESTABLISHED].filter(
    (n) => !candidates.includes(n),
  );
  assert.deepEqual(stale, [], `no longer in this population (renamed, or gained a GET): ${stale.join(", ")}`);

  // The numbers in docs/tools.md are ENFORCED here, because the last commit moved this population and left
  // three of them stale in the doc and self-contradictory in the CHANGELOG (39/4/35 against an actual 45/5/40).
  // A count in prose that nothing checks is a count that rots.
  const doc = readFileSync(join(repo, "docs", "tools.md"), "utf8");
  const proven = Object.keys(READS_BACK_FROM_RESPONSE).length;
  assert.ok(
    doc.includes(
      `${candidates.length} tools, ${proven} proven, ${NOT_ESTABLISHED.length} the sweep cannot drive`,
    ),
    `docs/tools.md must say "${candidates.length} tools, ${proven} proven, ${NOT_ESTABLISHED.length} the ` +
      `sweep cannot drive" for this census. The phrasing matters: these are not tools nobody examined, they ` +
      `are tools the sweep cannot construct arguments for, which is a narrower and more honest claim.`,
  );

  // What this can and cannot check, stated honestly, because the version of this comment on the merge-tool
  // list overclaimed and review demonstrated it: a test reading `assert.ok(true)` with the tool's name in a
  // COMMENT, placed in an unrelated file, satisfied every condition — and moving a tool out of NOT_ESTABLISHED
  // on that basis LOWERS the ratchet, so the fake proof reads as progress.
  //
  // No static check can establish that a test proves something. These raise the cost of a fake to the point
  // where writing the real test is easier:
  //
  //   - the file must actually exercise the tool's module (it must import the module the tool is defined in),
  //     which stops a proof living in a file that has nothing to do with it;
  //   - the tool name must appear OUTSIDE comments in the test's body, so a naming comment is not enough;
  //   - the body must assert on something, and must mention at least one of the words this class of proof
  //     turns on — a disagreement has to be visible for the test to be about one.
  // tool name -> the src/tools module that defines it, read off the source rather than from a property on the
  // tool (there is none) or a hand-kept table.
  const { readdirSync } = await import("node:fs");
  const toolModules = new Map();
  for (const entry of readdirSync(join(repo, "src", "tools"))) {
    if (!entry.endsWith(".ts")) continue;
    const src = readFileSync(join(repo, "src", "tools", entry), "utf8");
    for (const m of src.matchAll(/name:\s*"(reai_[a-z0-9_]+)"/g)) toolModules.set(m[1], entry.replace(/\.ts$/, ""));
  }

  const seen = new Set();
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const [name, [file, title]] of Object.entries(READS_BACK_FROM_RESPONSE)) {
    assert.ok(existsSync(join(repo, file)), `${name} names ${file}, which does not exist`);
    const body = readFileSync(join(repo, file), "utf8");
    const opener = `test("${title}"`;
    assert.ok(body.includes(opener), `${name} claims a test titled "${title}" in ${file}; none OPENS with it`);
    assert.ok(!seen.has(`${file}::${title}`), `two entries name the same test: ${file}::${title}`);
    seen.add(`${file}::${title}`);

    // The file has to be about the module this tool lives in, so a proof cannot be parked in whichever test
    // file happens to be convenient. The module is found by looking for the tool's `name:` in src/tools —
    // the FIRST version of this read `t.sourceModule`, a property no tool has, so it was a silent skip that
    // asserted nothing. Hence the assertion that the module was found at all.
    const module = toolModules.get(name);
    assert.ok(module !== undefined, `could not find where ${name} is defined under src/tools`);
    assert.ok(
      body.includes(`dist/tools/${module}.js`),
      `${name} is defined in src/tools/${module}.ts, but ${file} does not import that module — a proof for ` +
        `it cannot live there`,
    );

    const from = body.indexOf(opener);
    const next = body.indexOf("\ntest(", from + 1);
    const testBody = body.slice(from, next === -1 ? body.length : next);
    const code = stripComments(testBody);
    assert.ok(
      code.includes(name) || code.includes(name.replace(/^reai_/, "")),
      `the test "${title}" mentions ${name} only in a comment, so it cannot be what proves it`,
    );
    assert.ok(
      /assert\.(match|equal|deepEqual|ok|doesNotMatch|notEqual)\(/.test(code),
      `the test "${title}" asserts nothing`,
    );
    assert.ok(
      /read back|WARNING|stored|SENT|carried|DESTROYED/.test(code),
      `the test "${title}" never asserts on what the response said versus what was sent, which is the only ` +
        `thing that would make it a proof for ${name}`,
    );
  }
});

/**
 * Fields this sweep cannot judge, because their value is a WORD.
 *
 * A note may print a label derived from an enum rather than the value itself — `reai_create_supplier_invoice`
 * renders anything that is not `credit_note` as "invoice" — so an echo and a read-back produce the same
 * headline. The sweep reports these rather than guessing, and each is then either covered by a hand-written
 * test or it is not covered at all.
 *
 * All nine have now been driven by hand with a response naming a DIFFERENT member. One was echoing
 * (`documentType`, fixed in #145 — the two kinds are opposite signs in the ledger) and the other eight already
 * reported from the record. The `certifiedBy` entries are what keeps that from being a claim resting on a probe
 * nobody kept; a `null` says plainly that nothing covers it.
 */
const RENDERED_FIELDS_WITH_PROOF = {
  "reai_add_share_investment_event.eventType": [
    "test/investments.test.mjs",
    "reai_add_share_investment_event names the event type the record stored",
  ],
  "reai_create_share_investment.instrumentType": [
    "test/investments.test.mjs",
    "reai_create_share_investment names the instrument type the record stored",
  ],
  "reai_create_loan.loanType": [
    "test/loans.test.mjs",
    "reai_create_loan names the loan terms the record stored, not the ones it sent",
  ],
  "reai_create_loan.perspective": [
    "test/loans.test.mjs",
    "reai_create_loan names the loan terms the record stored, not the ones it sent",
  ],
  // These three do not reach the note at all — `describeLoan` names the loan by reference, type, perspective,
  // amount, rate, counterparty and status, and not by these. Nothing to state means nothing to get wrong, which
  // is a weaker guarantee than a test and is recorded as such.
  "reai_create_loan.dayCountConvention": null,
  "reai_create_loan.interestTreatment": null,
  "reai_create_loan.repaymentType": null,
  // Set by reai_set_asset_depreciation, which IS certified; the create tool's note does not name it.
  "reai_create_asset.depreciationMethod": null,
  "reai_create_supplier_invoice.documentType": [
    "test/purchase.test.mjs",
    "a supplier document stored as the other kind is named from the record",
  ],
};
const RENDERED_FIELDS = Object.keys(RENDERED_FIELDS_WITH_PROOF).sort();

/** A stable per-field number, so every field's sample is distinct and the same on every run. */
function hashOf(key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) % 100000;
  return h;
}

/**
 * Did this headline state the sent value as fact?
 *
 * Extracted from the sweep so it can be tested on its own. It has to be: setting its hedge branch to a constant
 * `true` disarmed the entire sweep and every other check stayed green — a guard nothing guards.
 *
 * Only the HEADLINE matters. Scanning the whole note meant a tool could assert the sent value in its first
 * sentence while a `describeConfirmation` paragraph below mentioned the stored one, and this called it fine;
 * reverting `reai_create_asset` to echo its account number survived exactly that way.
 */
function judgeHeadline(headline, note, sentValue, storedValue) {
  // Both verdicts read the HEADLINE. Judging "read" on the whole note was the asymmetry that let the three
  // reconciliation fixes be reverted with the sweep still green: the headline quoted the request, and the
  // `describeConfirmation` WARNING paragraph underneath — which names the stored value precisely BECAUSE the
  // write disagreed — then scored the field as a read-back. So a note falsely claiming the response carried
  // nothing while quoting the request was invisible, and the `reads` floor was satisfied by the warning.
  // Whole-token matching in both directions. A substring test reported `documentType: "invoice"` as echoed
  // because the word appears in "Supplier invoice registered" — a claim about a field the note never mentions.
  const mentions = (text, value) =>
    new RegExp(`(^|[^A-Za-z0-9_])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`).test(text);
  if (mentions(headline, storedValue)) return "read";
  // "as SENT", "not what is stored", "unconfirmed" — the wording this repo uses when it declines to vouch for
  // a figure. Anchored to the value, not the whole headline: a headline can hedge one field and assert another
  // in the same sentence, which reai_create_sub_account did.
  const hedgedNearby = new RegExp(
    `${sentValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^.]{0,80}?(\\bSENT\\b|not what is stored|unconfirmed|could not)`,
  ).test(headline);
  if (mentions(headline, sentValue) && !hedgedNearby) return "echo";
  return "neither";
}

test("the sweep's own verdict function distinguishes an echo from a hedge from a read-back", () => {
  // The positive controls. Without these, `hedged = true` (or any other short-circuit) leaves the sweep green
  // while it measures nothing — which is how the version before this one behaved under mutation.
  assert.equal(
    judgeHeadline("Warehouse 4 is now named Lager A.", "Warehouse 4 is now named Lager A.", "Lager A", "STORED"),
    "echo",
    "a headline stating the sent value, with the stored value nowhere, is an echo",
  );
  assert.equal(
    judgeHeadline('Sent "Lager A" as SENT.', 'Sent "Lager A" as SENT.', "Lager A", "STORED"),
    "neither",
    "naming the sent value while marking it SENT is not an assertion",
  );
  assert.equal(
    judgeHeadline("Warehouse 4 is now named STORED.", "Warehouse 4 is now named STORED.", "Lager A", "STORED"),
    "read",
    "a headline stating the stored value is a read-back",
  );
  assert.equal(
    judgeHeadline("Renamed to Lager A.", "Renamed to Lager A.\n\nWARNING: came back with STORED", "Lager A", "STORED"),
    "echo",
    "a warning further down does NOT excuse a headline that asserts the sent value — this is the case that " +
      "survived mutation before the verdict was scoped to the headline",
  );
  assert.equal(
    judgeHeadline("Nothing about the field.", "Nothing about the field.", "Lager A", "STORED"),
    "neither",
    "a note that mentions neither makes no claim",
  );
});

/**
 * The measurement that replaced a 40-name list of "nobody has checked".
 *
 * Every candidate is driven with arguments built from its own schema, against a response whose overlapping
 * fields carry SENTINEL values distinct from what was sent. Then the note is read:
 *
 *   ECHOES   the sent value appears and the stored one does not. A defect: the note states as fact something
 *            the response contradicted. Two were found this way — `reai_create_asset`, which named the
 *            balance-sheet account the asset would sit on and is declared irreversible, and
 *            `reai_create_warehouse`, whose own description says names are not unique.
 *   READS    the stored value appears. Good, whether or not the sent one is also named for contrast.
 *   NEITHER  the note does not mention the field at all, so it makes no claim to be wrong about. Acceptable.
 *
 * What this cannot see, stated so the pass is not read as more than it is: a note that RE-FORMATS the value it
 * echoes — a currency rendered with a thousands separator, a date rendered long-form — looks like NEITHER. So
 * a green sweep means "no tool echoes a value verbatim", not "every note is honest". The hand-written
 * certifications in READS_BACK_FROM_RESPONSE remain the stronger evidence, per tool.
 */
test("no candidate tool states a sent value the response contradicted", async () => {
  const { z } = await import("zod");
  const { readFileSync, existsSync, readdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join, dirname } = await import("node:path");
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
  const spec = JSON.parse(readFileSync(join(repo, "spec", "reai-openapi.json"), "utf8"));
  const schemas = spec.components.schemas;
  // Rebuilt here rather than shared with the test above: these two tests are independent, and depending on state
  // one leaves for the other is how the CANDIDATES coupling already needed a guard against measuring nothing.
  const toolModules = new Map();
  for (const entry of readdirSync(join(repo, "src", "tools"))) {
    if (!entry.endsWith(".ts")) continue;
    const src = readFileSync(join(repo, "src", "tools", entry), "utf8");
    for (const m of src.matchAll(/name:\s*"(reai_[a-z0-9_]+)"/g)) toolModules.set(m[1], entry.replace(/\.ts$/, ""));
  }
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  assert.ok(
    CANDIDATES.length > 0,
    "the population is empty — this sweep depends on the classification test above having run first, and " +
      "an empty list would make it pass while measuring nothing",
  );

  const fieldsOf = (schema, depth = 0, seen = new Set()) => {
    if (!schema || depth > 4) return [];
    if (schema.$ref) {
      const name = schema.$ref.split("/").pop();
      return seen.has(name) ? [] : fieldsOf(schemas[name], depth, new Set([...seen, name]));
    }
    const names = [];
    for (const member of schema.allOf ?? []) names.push(...fieldsOf(member, depth, seen));
    if (schema.items) names.push(...fieldsOf(schema.items, depth + 1, seen));
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      names.push(key);
      names.push(...fieldsOf(prop, depth + 1, seen));
    }
    return names;
  };
  const overlapOf = (tool) => {
    const accepts = new Set(Object.keys(tool.inputSchema ?? {}));
    const hits = new Set();
    for (const [method, path] of (tool.apiPaths ?? []).filter(([m]) =>
      ["PUT", "PATCH", "POST"].includes(m),
    )) {
      const op = spec.paths[path]?.[method.toLowerCase()];
      for (const [code, body] of Object.entries(op?.responses ?? {})) {
        if (!/^2\d\d$/.test(code)) continue;
        for (const media of Object.values(body?.content ?? {}))
          for (const f of fieldsOf(media?.schema)) if (accepts.has(f) && !IDENTITY_FIELDS.includes(f)) hits.add(f);
      }
    }
    return [...hits];
  };

  const pick = (schema, key, depth = 0, unwrapOptional = false) => {
    const def = schema?._def;
    if (!def || depth > 4) return { skip: true };
    const kind = def.typeName;
    if (kind === "ZodOptional" || kind === "ZodNullable" || kind === "ZodDefault") {
      return unwrapOptional ? pick(def.innerType, key, depth + 1, true) : { optional: true };
    }
    if (kind === "ZodEffects") return pick(def.schema, key, depth + 1);
    if (kind === "ZodEnum") return { value: def.values[0], rendered: true };
    if (kind === "ZodNativeEnum") return { value: Object.values(def.values)[0], rendered: true };
    if (kind === "ZodLiteral") return { value: def.value, rendered: true };
    if (kind === "ZodBoolean") return { value: false };
    if (kind === "ZodNumber") {
      // Multi-digit AND distinct per field. Sampling every integer as `7` made them all invisible (a
      // one-character value is dropped by the "too short to find in prose" guard below, which hid
      // `reai_adjust_inventory` asserting four contradicted values irreversibly). Sampling them all as the SAME
      // multi-digit number then flagged every integer field a tool accepts whenever it echoed one of them —
      // most of that run's hits were the artifact, not the defect.
      const int = (def.checks ?? []).some((c) => c.kind === "int");
      const min = (def.checks ?? []).find((c) => c.kind === "min")?.value;
      const base = 200000 + (hashOf(key) % 90000) * (int ? 1 : 1) + (int ? 0 : 0.5);
      return { value: typeof min === "number" && min > base ? min + 1 : base };
    }
    if (kind === "ZodString") {
      const checks = def.checks ?? [];
      const pattern = checks.find((c) => c.kind === "regex")?.regex;
      if (pattern) {
        for (const c of ["2026-08-09", "2026-08", "1500", "NO", "NOK", "12345678901", "930000000", "0150", "ZZ"])
          if (pattern.test(c)) return { value: c };
        return { skip: true };
      }
        if (/date/i.test(key)) return { value: "2026-08-09" };
      const max = checks.find((c) => c.kind === "max")?.value ?? 40;
      // Distinct per field, and deliberately not a word that occurs in prose. `"ZZ probe"` for everything meant
      // one echoed string flagged every string field; an ENUM sampled as `"invoice"` matched the word in
      // "Supplier invoice registered" and was reported as an echo of a field the note never mentioned.
      return { value: `ZZQ${hashOf(key).toString(36).toUpperCase()}`.slice(0, Math.max(3, Math.min(max, 40))) };
    }
    if (kind === "ZodArray") {
      const inner = pick(def.type, key, depth + 1);
      if (inner.skip || inner.optional) return (def.minLength?.value ?? 1) > 0 ? { skip: true } : { value: [] };
      return { value: [inner.value] };
    }
    if (kind === "ZodObject") {
      const out = {};
      for (const [k, v] of Object.entries(def.shape())) {
        const r = pick(v, k, depth + 1);
        if (r.optional) continue;
        if (r.skip) return { skip: true };
        out[k] = r.value;
      }
      return { value: out };
    }
    if (kind === "ZodUnion") {
      for (const option of def.options) {
        const r = pick(option, key, depth + 1);
        if (!r.skip && !r.optional) return r;
      }
      return { skip: true };
    }
    return { skip: true };
  };

  const echoes = [];
  const reads = [];
  const unmeasurable = [];
  const tooShort = [];
  const silent = [];
  const undrivable = [];
  for (const name of CANDIDATES) {
    // The hand-certified tools are owned by their own tests, which is stronger evidence than this sweep and
    // handles nuance it cannot. Concretely: `reai_add_salary_line` and `reai_log_lead_contact` identify their
    // row by MATCHING, and when nothing matches they correctly state the sent values labelled `SENT` beside a
    // warning — which this sweep reads as an echo, because the sentinel never appears. Flagging honest tools
    // would train the sweep to be ignored.
    //
    // The exemption is not free: READS_BACK_FROM_RESPONSE requires a test that opens with the named title, in
    // the file importing the tool's own module, naming the tool outside comments, asserting something, and
    // asserting on what the response said versus what was sent. Writing the real test is cheaper than faking
    // that.
    if (Object.hasOwn(READS_BACK_FROM_RESPONSE, name)) continue;
    const tool = registeredTools.find((t) => t.name === name);
    const answerable = new Set(overlapOf(tool));

    /**
     * One attempt at driving the tool. `unwrap` decides whether optional fields the response can answer for are
     * supplied.
     *
     * TWO attempts, because each mode loses tools the other reaches. Supplying optional fields is what made
     * seven update tools measurable at all — everything they accept is optional, so required-only drove them
     * while judging nothing. But it also made `reai_create_customer_contact` and
     * `reai_register_supplier_invoice_payment` refuse a mutually-exclusive combination, which cost their
     * coverage entirely. The previous version picked one mode and listed the casualties; running both and
     * taking the union costs nothing and loses neither.
     */
    const attempt = async (unwrap) => {
      const args = { tenantId: 2783 };
      const rendered = new Set();
      for (const [key, schema] of Object.entries(tool.inputSchema ?? {})) {
        if (key === "tenantId") continue;
        const r = pick(schema, key, 0, unwrap && answerable.has(key));
        if (r.optional) continue;
        if (r.skip) return undefined;
        args[key] = r.value;
        if (r.rendered) rendered.add(key);
      }
      const parsed = z.object(tool.inputSchema ?? {}).safeParse(args);
      if (!parsed.success) return undefined;

      const record = { id: 4242 };
      const sent = new Map();
      for (const field of answerable) {
        const value = parsed.data[field];
        if (value === undefined || value === null) continue;
        sent.set(field, value);
        // A DISTINCT sentinel per field. One shared literal meant that a tool naming any single stored value in
        // its headline satisfied `!headline.includes(storedValue)` for every other field at once — so a tool
        // reading back one field was immune to echo detection on all the rest.
        const nth = sent.size;
        record[field] =
          typeof value === "number"
            ? 900000 + nth
            : typeof value === "boolean"
              ? !value
              : `STORED_${field.toUpperCase()}_${nth}`;
      }
      let reached = false;
      let note = "";
      try {
        const result = await tool.handler(parsed.data, {
          client: {
            request: async () => { reached = true; return { data: record, status: 200 }; },
            deepLink: () => "link",
          },
          config: { writeMode: "full", tenantId: 2783, allowExternalSend: false },
          session: {},
        });
        note = (result.content ?? []).map((c) => c.text ?? "").join("\n");
        // The prose only. The full record is appended to every result, so the sentinel appears in it whatever
        // the note says — the same whole-text-versus-note trap that has produced four bad assertions here.
        const bodyAt = note.indexOf("\n{");
        if (bodyAt > 0) note = note.slice(0, bodyAt);
      } catch {
        return undefined;
      }
      // A tool that refused before sending anything measured nothing, whatever its note says. Counting that as
      // a pass is how `reai_update_expense` looked covered while returning "No fields were given".
      if (!reached || sent.size === 0) return undefined;
      return { note, sent, record, rendered };
    };

    const runs = [await attempt(false), await attempt(true)].filter(Boolean);
    if (runs.length === 0) { undrivable.push(name); continue; }

    let judged = 0;
    for (const { note, sent, record, rendered } of runs) {
    // The HEADLINE, not the whole note. This is the correction a mutation battery forced: scanning the whole
    // note meant a tool could state the sent value as fact in its first sentence while a `describeConfirmation`
    // paragraph mentioned the stored one further down, and this sweep called that fine. Reverting
    // `reai_create_asset` to echo its account number survived, because its own warning paragraph named the
    // sentinel. So the sweep was measuring "does the note mention the record at all" — not the defect.
    const headline = note.split("\n\n")[0] ?? "";
    for (const [field, value] of sent) {
      const asSent = String(value);
      if (asSent.length < 2) {
        // NOT a silent `continue`. This guard is what made every integer field in the repo invisible while the
        // sampler produced `7`, and reverting the sampler to a single digit left the sweep green — the one
        // blindness nothing pinned. Recorded and asserted empty below, so a sample too short to find in prose
        // is a failure of the SAMPLER rather than a quietly unmeasured field.
        tooShort.push(`${name}.${field} sampled as ${JSON.stringify(value)}`);
        continue;
      }
      if (rendered.has(field)) {
        // An enum or literal. Its value is a WORD, and a note may legitimately print a label derived from it —
        // `reai_create_supplier_invoice` renders anything that is not `credit_note` as "invoice", so the sent
        // member and the sentinel produce the SAME headline and this sweep cannot tell a read-back from an
        // echo. Reported as unmeasurable rather than flagged: the first version raised it as an echo against a
        // tool that had just been fixed to read from the response.
        unmeasurable.push(`${name}.${field}`);
        continue;
      }
      const verdict = judgeHeadline(headline, note, asSent, String(record[field]));
      if (verdict === "echo") { echoes.push(`${name}.${field} (${tool.risk}) headline said ${asSent}`); judged += 1; }
      else if (verdict === "read") { reads.push(`${name}.${field}`); judged += 1; }
    }
    }
    if (judged === 0) silent.push(name);
  }

  assert.deepEqual(
    echoes,
    [],
    `these notes stated a value the response contradicted:\n  ${echoes.join("\n  ")}`,
  );
  // A floor on what the sweep actually observed. Without it, a change that made every note stop mentioning
  // its fields would empty `echoes` and pass while measuring nothing — the sweep would be green and blind.
  // DEDUPED. Driving each tool twice pushes the same field twice whenever the two runs produce the same note,
  // which is 10 of 27 tools — review measured `reads.length` at 52 against 29 distinct fields, so the stated
  // floor of 10 was being met by 5 real ones.
  //
  // Stated honestly: a floor CANNOT pin its own de-duplication. Reverting to the raw count makes the check more
  // permissive, and no floor value catches that — 52 clears any threshold 29 clears. The assertion below records
  // that duplicates are real, so the reason for the `Set` is visible in the file rather than only in this
  // comment, but it is not a guard and is not claimed as one.
  const distinctReads = new Set(reads);
  assert.ok(
    reads.length > distinctReads.size,
    `no duplicate reads were seen, so either a tool stopped producing identical notes across the two drive ` +
      `modes or the two-attempt loop is gone — the de-duplication above exists because of those duplicates`,
  );
  assert.ok(
    distinctReads.size >= 25,
    `only ${distinctReads.size} DISTINCT field(s) were seen reported FROM the response; that number should not ` +
      `fall. If a tool stopped naming what the record said, this sweep has quietly stopped covering it.`,
  );

  // Tools that mentioned NEITHER value for every field they were measured on. Nothing is wrong with that — a
  // note that makes no claim cannot make a false one — but it is not evidence either, and the previous version
  // let such a tool move off NOT_ESTABLISHED and read as covered. `reai_create_customer_contact` was recovered
  // by the two-attempt drive and contributes exactly nothing; that is now visible instead of implied.
  assert.deepEqual(
    [...new Set(silent)].sort(),
    [
      // MEASURED. `reai_create_supplier_invoice` is here because its only comparable field is `documentType`,
      // which is a RENDERED value the sweep skips — it is covered by test/purchase.test.mjs instead, which is
      // exactly what the rendered-field proofs are for.
      "reai_book_bank_transactions",
      "reai_create_customer_contact",
      "reai_create_department",
      "reai_create_product",
      "reai_create_reconciliation_rule",
      "reai_create_supplier_invoice",
      "reai_credit_invoice",
      "reai_match_bank_transactions",
      "reai_update_customer",
      "reai_update_department",
      "reai_update_employee",
      "reai_update_expense",
      "reai_update_supplier",
    ],
    `the set of tools whose notes name NEITHER the sent nor the stored value has changed. They are not echoing, ` +
      `but they are not evidence of anything either: ${[...new Set(silent)].sort().join(", ")}`,
  );
  assert.deepEqual(
    tooShort,
    [],
    `the sampler produced values too short to find in prose, so these fields were not measured at all. That ` +
      `is how every integer field in this repo went unchecked while an irreversible tool asserted four ` +
      `contradicted values: ${tooShort.join(", ")}`,
  );
  // Named, not counted away. A rendered value is a real hole in this sweep — the tool could echo and look
  // identical — so each one is either covered by a hand-written test or it is not covered at all.
  // The proofs are CHECKED. Not "the same way the census entries are" — that claim was in the changelog and
  // review showed it false in three ways, so the differences are closed here and the remaining limits are
  // stated rather than glossed:
  //
  //   - a duplicate-title guard, which this list needs more than the census does, because two fields legitimately
  //     point at ONE test and a third pointing at it by accident would look like coverage;
  //   - `{ skip: true }` and `{ todo: true }` are rejected. A textual `test("<title>"` check cannot tell a
  //     skipped test from a running one, and review disarmed a proof by marking it skipped: the file reported
  //     "2 pass / 1 skipped" and this test stayed green;
  //   - string literals are stripped before the tool name and the marker are looked for. Review passed a
  //     two-line stub whose only mention of either was inside an assertion message.
  //
  // What it still cannot do is establish that a test proves anything. It raises the cost of a fake to the point
  // where the real test is cheaper, which is the same honest limit the census's own comment records.
  const stripStrings = (text) =>
    text.replace(/`(?:[^`\\]|\\.)*`/g, "``").replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
  const seenProofs = new Map();
  for (const [field, proof] of Object.entries(RENDERED_FIELDS_WITH_PROOF)) {
    if (proof === null) continue; // an explicit "nothing covers this", which is a claim about coverage, not proof
    const [file, title] = proof;
    const toolName = field.split(".")[0];
    assert.ok(existsSync(join(repo, file)), `${field} names ${file}, which does not exist`);
    const body = readFileSync(join(repo, file), "utf8");
    assert.ok(body.includes(`test("${title}"`), `${field} claims a test titled "${title}" in ${file}; none opens with it`);
    // A skipped or todo test satisfies a textual existence check and runs nothing.
    const opener = body.slice(body.indexOf(`test("${title}"`), body.indexOf(`test("${title}"`) + title.length + 80);
    assert.ok(
      !/\bskip\s*:\s*true|\btodo\s*:\s*true|test\.skip|test\.todo/.test(opener),
      `${field} names "${title}", which is skipped or todo — it proves nothing while looking like coverage`,
    );
    const owners = seenProofs.get(`${file}::${title}`) ?? [];
    owners.push(field);
    seenProofs.set(`${file}::${title}`, owners);
    const module = toolModules.get(toolName);
    assert.ok(module !== undefined, `could not find where ${toolName} is defined under src/tools`);
    // Either the file imports the tool's module directly, or it IS that module's test file by name. The first
    // version demanded the import and failed a legitimate proof: test/investments.test.mjs reaches its tools
    // through `registeredTools` from dist/server.js, which is how several files here are written. The point of
    // the check is that a proof cannot be parked in an unrelated file, and the filename carries that just as
    // well.
    assert.ok(
      body.includes(`dist/tools/${module}.js`) || file === `test/${module}.test.mjs`,
      `${toolName} is defined in src/tools/${module}.ts, but ${file} neither imports that module nor is its ` +
        `test file — a proof for it cannot live there`,
    );
    const from = body.indexOf(`test("${title}"`);
    const next = body.indexOf("\ntest(", from + 1);
    const raw = stripComments(body.slice(from, next === -1 ? body.length : next));
    // The tool name must appear as an IDENTIFIER or as a whole string — `tool("reai_x")` counts, which is how
    // most of these tests reach their tool; a name buried in an assertion message does not. Stripping every
    // string literal was too blunt and rejected the legitimate form; the first version of the check, which
    // allowed any occurrence, accepted a two-line stub whose only mention was inside a message.
    const namedProperly =
      stripStrings(raw).includes(toolName) ||
      new RegExp(`(["'\`])${toolName}\\1`).test(raw);
    assert.ok(namedProperly, `the test "${title}" mentions ${toolName} only inside prose, not as the tool it drives`);
    const code = stripStrings(raw);
    assert.ok(/assert\.(match|equal|deepEqual|ok|doesNotMatch|notEqual)\(/.test(code), `"${title}" asserts nothing`);
    // `record` is gone from this list: it matches "recorded", which nearly every create-tool test contains.
    assert.ok(
      /read back|stored|SENT|carried|DESTROYED/.test(raw),
      `"${title}" never asserts on what the response said versus what was sent`,
    );
  }
  // Two fields may share one test deliberately; a THIRD sharing it is almost always a mistake, and a shared
  // test deleted would silently uncover every field pointing at it.
  for (const [key, owners] of seenProofs) {
    assert.ok(owners.length <= 2, `${owners.length} fields point at one test (${key}): ${owners.join(", ")}`);
  }

  assert.deepEqual(
    [...new Set(unmeasurable)].sort(),
    RENDERED_FIELDS,
    `the set of fields this sweep cannot measure because their value is a word a note may RENDER has changed. ` +
      `Each needs a hand-written test or an explicit decision: ${[...new Set(unmeasurable)].join(", ")}`,
  );
  assert.deepEqual(
    undrivable.sort(),
    [...NOT_ESTABLISHED].sort(),
    `the tools this sweep cannot drive no longer match NOT_ESTABLISHED. Nothing may be skipped silently: ` +
      `either teach the sampler the shape, or list it there deliberately.`,
  );
});
