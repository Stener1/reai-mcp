import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Every record a write suite creates must be cleaned up from inside its `finally`.
 *
 * Written because I made the same mistake three times in three iterations: a cleanup block
 * anchored on a string that occurs in BOTH the try and the finally, inserted with a
 * first-occurrence replace, lands in the try. It then runs before the record it deletes has been
 * created, reports nothing, and strands rows on a live tenant — twice it also crashed the run
 * outright with "attempt is not defined", because the helper is defined in the finally.
 *
 * The suites pass either way, which is what makes it worth a test: the failure is invisible except
 * as leftovers on the tenant, noticed afterwards by hand.
 */

const SUITES = ["scripts/smoke-write.mjs", "scripts/smoke-full-write.mjs"];

/** Where the `finally` block of `main` starts and ends. */
function finallyRange(source) {
  const start = source.indexOf("\n  } finally {");
  assert.ok(start > 0, "expected a top-level finally in main()");
  return { start, end: source.length };
}

for (const path of SUITES) {
  test(`${path}: every created record is deleted inside the finally`, () => {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    const { start } = finallyRange(source);
    const tryHalf = source.slice(0, start);
    const finallyHalf = source.slice(start);

    // Everything the suite records having created. `created.x = ...` is the assignment shape both
    // suites use; the declaration block lists them too, which is why assignment is the signal.
    const createdKeys = new Set(
      [...tryHalf.matchAll(/created\.([A-Za-z0-9_]+)\s*=/g)].map((m) => m[1]),
    );
    assert.ok(createdKeys.size >= 3, `expected several created records; found ${[...createdKeys]}`);

    const uncleaned = [...createdKeys].filter((key) => !finallyHalf.includes(`created.${key}`));
    assert.deepEqual(
      uncleaned,
      [],
      "these are created in the try and never referenced in the finally, so a run leaves them on " +
        "the live tenant — put the cleanup beside the others, after `attempt` is defined",
    );
  });

  test(`${path}: no cleanup call sits in the try half`, () => {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    const { start } = finallyRange(source);
    const tryHalf = source.slice(0, start);
    // A delete of something the suite created belongs in the finally. A delete of something it is
    // deliberately testing (reai_delete_* as the subject of an assertion) is keyed on a local, not
    // on `created.`, so this looks only for the cleanup shape.
    const strays = [
      ...tryHalf.matchAll(/name: "(reai_delete_[a-z_]+)"[\s\S]{0,120}?created\.([A-Za-z0-9_]+)/g),
    ].map((m) => `${m[1]} on created.${m[2]}`);
    assert.deepEqual(
      strays,
      [],
      "a cleanup of a created record is in the try half, where it runs before the record exists " +
        "(and before `attempt` is defined) — move it into the finally",
    );
  });
}

test("the guard would catch the mistake it was written for", () => {
  // The shape that shipped three times: the cleanup textually present, but above the finally.
  const broken = `
  const created = { subscriptionId: undefined };
  try {
    created.subscriptionId = 1;
    if (created.subscriptionId) {
      await client.callTool({ name: "reai_delete_subscription", arguments: { id: created.subscriptionId } });
    }
  } finally {
    console.log("cleanup:");
  }`;
  const start = broken.indexOf("\n  } finally {");
  const tryHalf = broken.slice(0, start);
  const finallyHalf = broken.slice(start);
  const keys = [...tryHalf.matchAll(/created\.([A-Za-z0-9_]+)\s*=/g)].map((m) => m[1]);
  assert.deepEqual(keys, ["subscriptionId"]);
  assert.equal(
    finallyHalf.includes("created.subscriptionId"),
    false,
    "the fixture must reproduce the bug, or the guard above is untested",
  );
  const strays = [
    ...tryHalf.matchAll(/name: "(reai_delete_[a-z_]+)"[\s\S]{0,120}?created\.([A-Za-z0-9_]+)/g),
  ];
  assert.equal(strays.length, 1, "and the stray-cleanup half must see it too");
});
