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
    assert.match(text, /Changed NOTHING/, `${label}: an unconfirmable change must not be claimed`);
  }
});
