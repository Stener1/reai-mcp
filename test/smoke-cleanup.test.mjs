import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Every record a write suite creates must be DELETED from inside its `finally`.
 *
 * Written because I made the same mistake three times in three iterations: a cleanup block
 * anchored on a string that occurs in BOTH the try and the finally, inserted with a
 * first-occurrence replace, lands in the try. It then runs before the record it deletes has been
 * created, reports nothing, and strands rows on a live tenant — twice it also crashed the run
 * outright with "attempt is not defined", because the helper is defined in the finally.
 *
 * The suites pass either way, which is what makes it worth a test: the failure is invisible except
 * as leftovers on the tenant, noticed afterwards by hand.
 *
 * Two things this guard does NOT catch, said plainly so it is not mistaken for more than it is:
 *  - A record created but never recorded in `created` at all. The lead section of
 *    scripts/smoke-full-write.mjs is now exactly that: it materialises a lead row and, briefly, a
 *    customer, and records neither in `created`. That is deliberate — it owns its cleanup in its own
 *    try/catch/finally, deletes only a customer proven new against a baseline it took first, and
 *    re-reads to confirm — but it does mean this guard cannot see that section, and the comment used
 *    to claim nothing did that. Detecting it in general would have to reason about call ordering
 *    rather than text.
 *  - A `created.x` assigned LATE — after further remote calls — so a throw in between leaves the
 *    finally with nothing to delete. The key is referenced, so this passes. Codex caught one of
 *    those by reading, which is the honest way.
 */

const SUITES = ["scripts/smoke-write.mjs", "scripts/smoke-full-write.mjs"];

/**
 * The two shapes a cleanup takes in these suites. Written once and shared by every assertion and
 * by the self-test, because three copies of a regex is the "a test that reimplements what it
 * guards passes on its own reimplementation" shape this repo keeps naming.
 */
const CREATED_ASSIGNMENT = /created\.([A-Za-z0-9_]+)\s*=/g;
/** A curated delete tool, or reai_request with method DELETE — 6 of the 17 cleanups use the latter. */
const DELETE_CALL = /(?:name:\s*"reai_delete_[a-z_]+"|method:\s*"DELETE")[\s\S]{0,400}/g;

/**
 * Every `created.*` a delete call touches.
 *
 * All of them, not the first: the supplier-payment cleanup addresses
 * `/api/supplier-invoices/${created.supplierInvoiceId}/payments/${created.supplierPaymentId}`, and
 * a non-greedy single capture stops at the invoice id and reports the payment as never deleted.
 */
function deletedKeys(text) {
  const keys = new Set();
  for (const [window] of text.matchAll(DELETE_CALL)) {
    for (const m of window.matchAll(/created\.([A-Za-z0-9_]+)/g)) keys.add(m[1]);
  }
  return keys;
}

/**
 * `created.*` entries that are not independently deletable records.
 *
 * `variantId` is read off a product's stock line so an inventory adjustment can name it; deleting
 * the product removes it. Recorded here rather than left to look like an uncleaned record.
 */
const NOT_A_RECORD = {
  variantId: "a variant id read from a stock line; the product's deletion removes it",
};

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The `finally` of `main`, split from everything before it. */
function halves(text) {
  const start = text.indexOf("\n  } finally {");
  assert.ok(start > 0, "expected a top-level finally in main()");
  assert.equal(
    text.indexOf("\n  } finally {", start + 1),
    -1,
    "more than one top-level finally — this split would silently pick the first",
  );
  return { tryHalf: text.slice(0, start), finallyHalf: text.slice(start) };
}

for (const path of SUITES) {
  test(`${path}: every created record is DELETED inside the finally`, () => {
    const { tryHalf, finallyHalf } = halves(source(path));
    const created = new Set([...tryHalf.matchAll(CREATED_ASSIGNMENT)].map((m) => m[1]));
    assert.ok(created.size >= 3, `expected several created records; found ${[...created]}`);

    // Deleted, not merely mentioned. The first version checked `finallyHalf.includes("created.x")`,
    // which a message like `remove bank ${created.bankId} by hand` satisfies — so a suite that
    // only WARNED about a leftover passed a test named "is deleted".
    const deleted = deletedKeys(finallyHalf);
    const undeleted = [...created].filter((key) => !deleted.has(key) && !(key in NOT_A_RECORD));
    assert.deepEqual(
      undeleted,
      [],
      "these are created in the try and never DELETED in the finally, so a run leaves them on the " +
        "live tenant — put the cleanup beside the others, after `attempt` is defined",
    );
  });

  test(`${path}: no cleanup of a created record sits in the try half`, () => {
    const { tryHalf } = halves(source(path));
    const strays = [...deletedKeys(tryHalf)].filter((key) => !(key in NOT_A_RECORD));
    assert.deepEqual(
      strays,
      [],
      "a cleanup of a created record is in the try half, where it runs before the record exists " +
        "(and before `attempt` is defined) — move it into the finally",
    );
  });
}

test("the guard would catch the mistake it was written for, in both cleanup shapes", () => {
  // The real shape that shipped three times, once per cleanup style. Asserted with the SAME
  // regexes the tests above use, imported from the consts rather than retyped.
  for (const [label, deleteCall] of [
    ["a curated delete tool", 'await client.callTool({ name: "reai_delete_subscription", arguments: { id: created.subscriptionId } });'],
    ["reai_request DELETE", 'await client.callTool({ name: "reai_request", arguments: { method: "DELETE", path: `/api/x/${created.subscriptionId}` } });'],
  ]) {
    const broken = `
  try {
    created.subscriptionId = 1;
    if (created.subscriptionId) {
      ${deleteCall}
    }
  } finally {
    console.log("cleanup:");
  }`;
    const { tryHalf, finallyHalf } = halves(broken);
    const created = [...tryHalf.matchAll(CREATED_ASSIGNMENT)].map((m) => m[1]);
    assert.deepEqual(created, ["subscriptionId"], label);
    const deletedInFinally = [...deletedKeys(finallyHalf)];
    assert.deepEqual(deletedInFinally, [], `${label}: the fixture must reproduce the bug`);
    assert.deepEqual([...deletedKeys(tryHalf)], ["subscriptionId"], `${label}: the stray check must see it`);
  }
});

test("a cleanup that only WARNS does not count as deleting", () => {
  const warnsOnly = `
  try {
    created.bankId = 1;
  } finally {
    report("bank cleanup", false, \`remove bank \${created.bankId} by hand\`);
  }`;
  const { tryHalf, finallyHalf } = halves(warnsOnly);
  assert.deepEqual([...tryHalf.matchAll(CREATED_ASSIGNMENT)].map((m) => m[1]), ["bankId"]);
  assert.ok(finallyHalf.includes("created.bankId"), "mentioned, which the old check accepted");
  assert.deepEqual(
    [...deletedKeys(finallyHalf)],
    [],
    "but not deleted, which is what the guard now requires",
  );
});

test("a delete whose path names two created ids counts both", () => {
  // The supplier-payment cleanup addresses two: a non-greedy single capture stopped at the first
  // and reported the payment as never deleted.
  const twoIds = `
  } finally {
    await client.callTool({
      name: "reai_request",
      arguments: {
        method: "DELETE",
        path: \`/api/supplier-invoices/\${created.supplierInvoiceId}/payments/\${created.supplierPaymentId}\`,
      },
    });
  }`;
  assert.deepEqual(
    [...deletedKeys(twoIds)].sort(),
    ["supplierInvoiceId", "supplierPaymentId"],
    "both ids in the path are deleted by that call",
  );
});

test("every not-a-record exemption is real and explained", () => {
  for (const [key, reason] of Object.entries(NOT_A_RECORD)) {
    assert.ok(reason.length > 25, `${key} needs a reason, not a placeholder`);
    const assigned = SUITES.some((path) =>
      [...source(path).matchAll(CREATED_ASSIGNMENT)].some((m) => m[1] === key),
    );
    assert.ok(assigned, `${key} is exempted but no suite records it — drop the exemption`);
  }
});
