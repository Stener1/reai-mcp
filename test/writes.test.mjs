import { test } from "node:test";
import assert from "node:assert/strict";
import { assignRowNumbers } from "../dist/tools/bookkeeping.js";
import { ReaiClient } from "../dist/reai/client.js";

/**
 * Two behaviours that only matter when a write reaches real accounting records,
 * and that no amount of read-path testing exercises: how voucher rows are
 * numbered, and whether a non-idempotent write is ever repeated.
 */

test("a matched debit and credit share one row, even with different descriptions", () => {
  // The spec: "A balanced debit+credit entry for the same amount, currency and date
  // MUST share a single rowNumber... never split the debit and credit of one entry
  // across two rowNumbers." The old implementation split exactly this pair whenever
  // their descriptions differed, and a test asserted that as correct.
  const rows = assignRowNumbers([
    { amount: 1000, description: "debit side" },
    { amount: -1000, description: "credit side" },
  ]);
  assert.equal(rows[0].rowNumber, rows[1].rowNumber, "a matched pair must not be split");
});

test("a purchase voucher with two debits gets one row each", () => {
  // Debit cost 800, debit input VAT 200, credit payable -1000, one description
  // throughout — the ordinary Norwegian purchase voucher. The old code early-returned
  // because the descriptions matched, assigning nothing, so both debits landed in row
  // 0 and the API rejected the merge this function exists to prevent.
  const rows = assignRowNumbers([
    { amount: 800, description: "Kjøp" },
    { amount: 200, description: "Kjøp" },
    { amount: -1000, description: "Kjøp" },
  ]);
  const numbers = rows.map((r) => r.rowNumber);
  assert.equal(new Set(numbers).size, 3, `each posting needs its own row, got ${numbers.join(",")}`);
  // A row may hold at most one debit and one credit, so no row may hold two debits.
  for (const n of new Set(numbers)) {
    const inRow = rows.filter((r) => r.rowNumber === n);
    assert.ok(inRow.filter((r) => r.amount > 0).length <= 1, `row ${n} has more than one debit`);
    assert.ok(inRow.filter((r) => r.amount < 0).length <= 1, `row ${n} has more than one credit`);
  }
});

test("two independent matched pairs get one row each", () => {
  const rows = assignRowNumbers([
    { amount: 500, description: "a" },
    { amount: -500, description: "a" },
    { amount: 300, description: "b" },
    { amount: -300, description: "b" },
  ]);
  assert.equal(rows[0].rowNumber, rows[1].rowNumber);
  assert.equal(rows[2].rowNumber, rows[3].rowNumber);
  assert.notEqual(rows[0].rowNumber, rows[2].rowNumber, "unrelated entries need separate rows");
});

test("floating-point wobble does not split a matched pair", () => {
  // Currency arithmetic routinely leaves a pair a fraction apart; comparison is at
  // øre precision so the pair still shares a row.
  const rows = assignRowNumbers([
    { amount: 100.005, description: "x" },
    { amount: -100.005, description: "x" },
  ]);
  assert.equal(rows[0].rowNumber, rows[1].rowNumber);
});

test("an explicit row number is never overwritten", () => {
  const rows = assignRowNumbers([
    { amount: 1000, rowNumber: 7, description: "A" },
    { amount: -1000, description: "A" },
  ]);
  assert.equal(rows[0].rowNumber, 7);
  assert.ok(rows[1].rowNumber !== undefined, "the unnumbered side must still get a row");
  assert.notEqual(rows[1].rowNumber, 7, "a claimed row is not reused for an unpaired posting");
});

test("a fully numbered voucher is never rewritten", () => {
  const postings = [
    { amount: 1, rowNumber: 7, description: "A" },
    { amount: -1, rowNumber: 9, description: "B" },
  ];
  assert.deepEqual(assignRowNumbers(postings), postings);
});

/** A client whose fetch counts calls and fails in a chosen way. */
function countingClient(failure) {
  let calls = 0;
  const client = new ReaiClient({
    baseUrl: "https://app.reai.invalid",
    token: "t",
    maxRetries: 2,
    fetchImpl: async () => {
      calls += 1;
      if (failure === "transport") throw new Error("socket hang up");
      return new Response("upstream unavailable", { status: failure });
    },
  });
  return { client, calls: () => calls };
}

test("a GET is retried after a gateway error", async () => {
  const { client, calls } = countingClient(503);
  await assert.rejects(() => client.request({ method: "GET", path: "/api/customers" }));
  assert.equal(calls(), 3, "one attempt plus two retries");
});

test("a POST is NOT retried after a gateway error", async () => {
  // 502/503/504 are ambiguous: the request may already have been committed, and
  // POST /api/vouchers has no idempotency key, so a retry can double-book.
  const { client, calls } = countingClient(503);
  await assert.rejects(() => client.request({ method: "POST", path: "/api/vouchers", body: {} }));
  assert.equal(calls(), 1, "a non-idempotent write must be attempted exactly once");
});

test("a POST is NOT retried after a transport failure", async () => {
  // The worst case: the write landed and the response was lost on the way back.
  const { client, calls } = countingClient("transport");
  await assert.rejects(() => client.request({ method: "POST", path: "/api/vouchers", body: {} }));
  assert.equal(calls(), 1);
});

test("a POST IS retried on 429, which is rejected before processing", async () => {
  const { client, calls } = countingClient(429);
  await assert.rejects(() => client.request({ method: "POST", path: "/api/vouchers", body: {} }));
  assert.equal(calls(), 3, "rate limiting cannot have duplicated anything");
});

test("a DELETE is retried, since repeating it is harmless", async () => {
  const { client, calls } = countingClient(503);
  await assert.rejects(() => client.request({ method: "DELETE", path: "/api/vouchers/1" }));
  assert.equal(calls(), 3);
});

test("deleting a voucher reports REVERSAL rather than claiming deletion", async () => {
  // The spec is explicit: DELETE /api/vouchers/{id} "deletes the resource when no
  // accounting reversal is needed. If financial audit history must be retained,
  // records a reversal instead" and answers {"outcome":"deleted"|"reversed"}.
  //
  // This tool asserted the opposite — that ReAI *rejects* when a reversal would be
  // needed — and then discarded the body and said "deleted" every time. So an agent
  // could tell a user a voucher was gone while the ledger held the original plus a
  // counter-posting, and might re-book the transaction and double-post it. My own
  // live write test never caught it: on an open period the delete really does remove
  // the voucher, so the reversal branch was never exercised.
  const { allTools } = await import("../dist/server.js");
  const tool = allTools.find((t) => t.name === "reai_delete_voucher");
  assert.ok(tool);

  const run = async (data, status = 200) => {
    const ctx = {
      config: { boundTenantId: undefined, defaultTenantId: 1 },
      session: {},
      client: { request: async () => ({ status, data }), deepLink: () => "https://app.reai.no/" },
    };
    const res = await tool.handler({ id: 55 }, ctx);
    return res.content.map((c) => c.text).join("\n");
  };

  const reversed = await run({ outcome: "reversed" });
  assert.match(reversed, /REVERSED, not deleted/);
  assert.match(reversed, /do not re-book/i, "the agent must be told not to re-book");
  assert.doesNotMatch(reversed, /^Voucher 55 deleted/m);

  const deleted = await run({ outcome: "deleted" });
  assert.match(deleted, /deleted outright/);

  // An empty body must not be reported as a confident deletion either.
  const silent = await run(undefined, 204);
  assert.match(silent, /did not say whether/);
});

test("a row requires the same currency and date, not just the same amount", async () => {
  // The schema: both sides of a row share "the same date, description, currency and
  // absolute amount". Matching on amount alone put a multi-date or multi-currency
  // pair into one row, which ReAI then rejects — worse than one row each.
  const { assignRowNumbers } = await import("../dist/tools/bookkeeping.js");

  const differentDate = assignRowNumbers([
    { amount: 100, postingDate: "2026-01-01" },
    { amount: -100, postingDate: "2026-02-01" },
  ]);
  assert.notEqual(differentDate[0].rowNumber, differentDate[1].rowNumber);

  const differentCurrency = assignRowNumbers([
    { amount: 100, currency: "NOK" },
    { amount: -100, currency: "EUR" },
  ]);
  assert.notEqual(differentCurrency[0].rowNumber, differentCurrency[1].rowNumber);

  const matching = assignRowNumbers([
    { amount: 100, currency: "NOK", postingDate: "2026-01-01" },
    { amount: -100, currency: "NOK", postingDate: "2026-01-01" },
  ]);
  assert.equal(matching[0].rowNumber, matching[1].rowNumber);
});

test("an omitted description is not treated as a conflicting one", async () => {
  // This check refuses the voucher locally, so it must not fire on a rule the spec
  // does not state. Only two explicitly different descriptions disagree.
  const { rowDescriptionConflicts } = await import("../dist/tools/bookkeeping.js");
  assert.deepEqual(rowDescriptionConflicts([{ rowNumber: 0, description: "Kjøp" }, { rowNumber: 0 }]), []);
  assert.deepEqual(rowDescriptionConflicts([{ rowNumber: 0 }, { rowNumber: 0 }]), []);
  assert.equal(
    rowDescriptionConflicts([
      { rowNumber: 0, description: "a" },
      { rowNumber: 0, description: "b" },
    ]).length,
    1,
  );
});

test("a silent delete response does not report a deleted outcome", async () => {
  // An earlier version returned a synthesized { outcome: "deleted" } alongside a note
  // saying the outcome was unknown, so anything reading the structured value would
  // conclude the voucher was gone when it may have been reversed.
  const { allTools } = await import("../dist/server.js");
  const tool = allTools.find((t) => t.name === "reai_delete_voucher");
  const ctx = {
    config: { boundTenantId: undefined, defaultTenantId: 1 },
    session: {},
    client: { request: async () => ({ status: 204, data: undefined }), deepLink: () => "x" },
  };
  const text = (await tool.handler({ id: 9 }, ctx)).content.map((c) => c.text).join("\n");
  assert.doesNotMatch(text, /"outcome":\s*"deleted"/, "must not synthesize a deleted outcome");
  assert.match(text, /did not say whether/);
  assert.match(text, /REVERSED/);
});

// The escape hatch runs the body classifiers on every request; curated tools were
// gated on their static `risk` alone. So reai_update_supplier, declared reversible,
// repointed a supplier's bank account in the DEFAULT mode while reai_request refused
// the identical PATCH /api/suppliers/{id}. A curated tool quietly doing what the
// escape hatch forbids is the failure this project treats as its worst — and the
// existing guard compared only apiPaths, so it structurally could not see it.
test("a curated tool cannot do what reai_request would refuse for the same body", async () => {
  const { allTools } = await import("../dist/server.js");
  const { curatedArgsEscalate, classifyPaymentRouting, isAllowed } = await import(
    "../dist/policy.js"
  );

  // Every field name the policy treats as payment routing, as an agent would pass it.
  const ESCALATING = {
    iban: "NO9386011117947",
    bankAccountNumber: "86011117947",
    swiftCode: "DNBANOKK",
    bban: "86011117947",
    invoiceEmail: "attacker@evil.example",
  };

  let checked = 0;
  for (const tool of allTools) {
    for (const field of Object.keys(tool.inputSchema ?? {})) {
      if (!(field in ESCALATING)) continue;
      const args = { id: 1, [field]: ESCALATING[field] };

      // What reai_request would decide for the same path and body.
      const viaEscapeHatch = (tool.apiPaths ?? []).some(
        ([method, path]) =>
          classifyPaymentRouting("reversible", path, args, method) === "irreversible",
      );
      if (!viaEscapeHatch) continue;
      checked += 1;

      const escalated = curatedArgsEscalate(tool.apiPaths ?? [], args);
      assert.ok(
        escalated && escalated.risk === "irreversible",
        `${tool.name} accepts "${field}" but does not escalate — reai_request would refuse it`,
      );
      // And the escalation must actually bite in the default mode.
      assert.equal(
        isAllowed(escalated.risk, "reversible"),
        false,
        `${tool.name} escalates on "${field}" but the escalation is permitted in reversible mode`,
      );
    }
  }
  assert.ok(checked >= 2, `expected to find escalating fields on curated tools, found ${checked}`);
});

// The scoping matters as much as the rule: `accountNumber` on a supplier is a bank
// account, and on a bookkeeping tool it is a chart-of-accounts code like 4300.
// Matching on the field name alone would refuse ordinary ledger work.
test("escalation is scoped by path, so ledger account numbers are unaffected", async () => {
  const { curatedArgsEscalate } = await import("../dist/policy.js");
  assert.equal(
    curatedArgsEscalate([["POST", "/api/vouchers"]], { accountNumber: "4300", amount: 100 }),
    undefined,
  );
  assert.equal(curatedArgsEscalate([["PATCH", "/api/suppliers/{id}"]], { id: 1, name: "Acme" }), undefined);
  // Adding a company bank stays ordinary work; repointing an existing one does not.
  assert.equal(curatedArgsEscalate([["POST", "/api/company-banks"]], { bban: "86011117947" }), undefined);
  assert.ok(curatedArgsEscalate([["PUT", "/api/company-banks/{id}"]], { bban: "86011117947" }));
});

// A success message that asserts an outcome the API did not confirm is the defect
// class already guarded for reai_delete_voucher ("reports a REVERSAL rather than
// claiming deletion"). Three more tools had it. The bank matcher is the worst:
// POST .../matches answers HTTP 200 whether or not it matched, and the note was built
// from the REQUEST, so {status:"not_matched"} was reported as "Matched 3
// transaction(s)" — an agent then calls the month reconciled, or redoes the work
// another way and double-books it.
test("a tool never claims an outcome the API did not report", async () => {
  const { allTools } = await import("../dist/server.js");
  const fakeCtx = (data, status = 201) => ({
    client: { request: async () => ({ data, status }), deepLink: () => "link" },
    config: { writeMode: "full", tenantId: 2634 },
    session: {},
  });
  const firstLine = (r) => r.content[0].text.split("\n")[0];
  const tool = (name) => {
    const t = allTools.find((x) => x.name === name);
    assert.ok(t, `${name} not found`);
    return t;
  };

  const match = tool("reai_match_bank_transactions");
  const matchArgs = { bankAccountId: 1, transactionIds: [1, 2, 3], postingIds: [9], tenantId: 2634 };

  const notMatched = await match.handler(
    matchArgs,
    fakeCtx({ status: "not_matched", success: false, requiresDiscrepancyAccount: true, discrepancy: -256.12, reconciledTransactionIds: [], errors: ["Discrepancy account required"] }),
  );
  assert.match(firstLine(notMatched), /NOT matched/);
  assert.ok(!/^Matched/.test(firstLine(notMatched)), "must not claim a match");
  assert.match(notMatched.content[0].text, /discrepancyAccount/, "must say how to proceed");

  const already = await match.handler(matchArgs, fakeCtx({ status: "already_matched", reconciledTransactionIds: [] }));
  assert.match(firstLine(already), /Already matched/);
  assert.match(firstLine(already), /changed nothing/);

  // On success the counts come from the response, not the request.
  const ok3 = await match.handler(
    { ...matchArgs, transactionIds: [1, 2, 3, 4, 5] },
    fakeCtx({ status: "matched", reconciledTransactionIds: [1, 2], reconciledPostingIds: [9], voucherIds: [900] }),
  );
  assert.match(firstLine(ok3), /Matched 2 transaction\(s\)/, `got: ${firstLine(ok3)}`);
  assert.match(firstLine(ok3), /you asked for 5/, "a shortfall must be called out");

  // Booking: same rule.
  const book = tool("reai_book_bank_transactions");
  const booked = await book.handler(
    { bankAccountId: 1, transactionIds: [1, 2, 3, 4, 5], account: "7770", description: "x", tenantId: 2634 },
    fakeCtx({ voucherIds: [900], reconciledTransactionIds: [1, 2] }),
  );
  assert.match(firstLine(booked), /Booked 2 transaction\(s\)/, `got: ${firstLine(booked)}`);
  assert.match(firstLine(booked), /voucher\(s\) 900/);

  // A payment the bank rejected, or one still in flight, is not "recorded".
  const pay = tool("reai_register_supplier_invoice_payment");
  const payArgs = { id: 42, invoiceAmount: 300, paymentDate: "2026-08-07", manualPayment: true, companyBankId: 1, tenantId: 2634 };
  for (const [status, expected] of [
    ["failed", /NOT PAID/],
    ["reversed", /NOT PAID/],
    ["in_process", /NOT YET SETTLED/],
    ["customer_action_required", /NOT YET SETTLED/],
  ]) {
    const r = await pay.handler(payArgs, fakeCtx({ status }));
    assert.match(firstLine(r), expected, `status ${status} gave: ${firstLine(r)}`);
    assert.ok(!/^Payment of/.test(firstLine(r)), `status ${status} must not claim the payment was recorded`);
  }
  // HTTP 200 is "existing idempotent payment returned" — the call created nothing.
  const replay = await pay.handler(payArgs, fakeCtx({ status: "completed", paymentId: 77 }, 200));
  assert.match(replay.content[0].text, /created NOTHING/);
  assert.match(replay.content[0].text, /Do not retry/);
  // And a genuine 201 still reads as done.
  const fresh = await pay.handler(payArgs, fakeCtx({ status: "completed", paymentId: 78 }, 201));
  assert.match(firstLine(fresh), /^Payment of 300 recorded/);
  assert.ok(!/created NOTHING/.test(fresh.content[0].text));
});
