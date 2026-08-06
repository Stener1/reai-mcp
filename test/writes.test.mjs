import { test } from "node:test";
import assert from "node:assert/strict";
import { assignRowNumbers } from "../dist/tools/bookkeeping.js";
import { ReaiClient } from "../dist/reai/client.js";

/**
 * Two behaviours that only matter when a write reaches real accounting records,
 * and that no amount of read-path testing exercises: how voucher rows are
 * numbered, and whether a non-idempotent write is ever repeated.
 */

test("postings with one shared description are left as the caller wrote them", () => {
  const postings = [
    { accountNumber: "1576", amount: 1, description: "same" },
    { accountNumber: "1580", amount: -1, description: "same" },
  ];
  // They merge into a single tidy row; adding numbers would only split it.
  assert.deepEqual(assignRowNumbers(postings), postings);
});

test("differing descriptions each get their own row", () => {
  const rows = assignRowNumbers([
    { amount: 1, description: "debit side" },
    { amount: -1, description: "credit side" },
  ]);
  assert.deepEqual(
    rows.map((r) => r.rowNumber),
    [0, 1],
  );
});

test("postings sharing a description share a row", () => {
  const rows = assignRowNumbers([
    { amount: 2, description: "a" },
    { amount: -1, description: "b" },
    { amount: -1, description: "a" },
  ]);
  assert.deepEqual(
    rows.map((r) => r.rowNumber),
    [0, 1, 0],
  );
});

test("a partially numbered voucher does not collide on row 0", () => {
  // The regression Codex caught: bailing out because *one* posting was numbered
  // left the other defaulted to row 0 as well, so an explicit row 0 describing
  // A and an unnumbered posting describing B were merged and rejected.
  const rows = assignRowNumbers([
    { amount: 1, rowNumber: 0, description: "A" },
    { amount: -1, description: "B" },
  ]);
  assert.equal(rows[0].rowNumber, 0, "an explicit row number must be preserved");
  assert.notEqual(rows[1].rowNumber, 0, "an unnumbered posting must not land on a taken row");
  assert.equal(new Set(rows.map((r) => r.rowNumber)).size, 2);
});

test("an unnumbered posting joins an explicit row carrying the same description", () => {
  const rows = assignRowNumbers([
    { amount: 2, rowNumber: 3, description: "A" },
    { amount: -1, description: "A" },
    { amount: -1, description: "B" },
  ]);
  assert.equal(rows[0].rowNumber, 3);
  assert.equal(rows[1].rowNumber, 3, "same description merges into the existing row");
  assert.ok(rows[2].rowNumber !== 3, "a different description needs its own row");
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
