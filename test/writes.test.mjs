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
