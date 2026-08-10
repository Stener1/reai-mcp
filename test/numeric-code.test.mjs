import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { allTools } from "../dist/server.js";
import { uiTools } from "../dist/tools/ui.js";
import { numericCode } from "../dist/tools/registry.js";

/**
 * `numericCode` accepts a number where an agent would naturally pass one — and must never be used where a
 * leading zero is real.
 *
 * The friction was measured, not imagined: `reai_list_postings` with `accountNumber: 4300` was rejected with
 * "Expected string, received number", which is the form an agent reaches for first since an account number IS a
 * number. Accepting it cannot lose information, because JSON has no way to express a leading zero in a number —
 * `String(4300)` is exactly `"4300"`.
 *
 * That same fact is why this must stay narrow. For a field where a leading zero is real, the string requirement
 * is a FEATURE: Norwegian postal codes run from 0001 and a fødselsnummer can begin 01–09, so `postalCode: 150`
 * is not a clumsy `"0150"` — it is a different, wrong value. Rejecting it makes the caller write the string;
 * coercing would accept corrupted data on a 200, which is the silent-loss class this repository is built around.
 */

/** Fields where a leading zero occurs in real Norwegian data, so a number must be REFUSED. */
const MUST_STAY_STRICT = [
  "postalCode",
  "nationalIdentityNumber",
  "bban",
  "bankAccountNumber",
  "iban",
  "swiftCode",
  "countryCode",
  "currencyCode",
];

test("numericCode accepts a number without losing what a string could carry", () => {
  assert.equal(numericCode.parse(4300), "4300");
  assert.equal(numericCode.parse("4300"), "4300");
  // A string is passed through untouched, so a leading zero written correctly survives.
  assert.equal(numericCode.parse("0100"), "0100");
  assert.equal(numericCode.parse("3"), "3");
  // Not a whole number, so not a code.
  assert.equal(numericCode.safeParse(4.5).success, false, "a fractional value is not a code");
  assert.equal(numericCode.safeParse(true).success, false);
  assert.equal(numericCode.safeParse(null).success, false);
});

test("no leading-zero-bearing field accepts a number", () => {
  // The guard against widening this carelessly. A number reaching one of these fields means the caller has
  // already lost a leading zero, and accepting it would store the wrong value on a 200.
  const offenders = [];
  for (const tool of [...allTools, ...uiTools]) {
    for (const field of MUST_STAY_STRICT) {
      const schema = tool.inputSchema?.[field];
      if (!schema) continue;
      // 150 stands in for "0150": if it parses, the field has been made coercible.
      if (z.object({ [field]: schema }).safeParse({ [field]: 150 }).success) {
        offenders.push(`${tool.name}.${field}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these fields accept a number, but a leading zero is real in them — 0150 Oslo, a fødselsnummer beginning " +
      "01. A number cannot carry that zero, so accepting one stores a different value than the caller meant:\n  " +
      offenders.join("\n  "),
  );

  // Non-vacuous: the fields must actually exist somewhere, or this asserts nothing.
  const present = [...allTools, ...uiTools].flatMap((t) =>
    MUST_STAY_STRICT.filter((f) => t.inputSchema?.[f]).map((f) => `${t.name}.${f}`),
  );
  assert.ok(present.length > 5, `only ${present.length} strict fields found — the list has gone stale`);
});

test("accountNumber accepts a number where it is a filter, and normalises when it does", () => {
  // The two tools where the friction was measured. Asserted by name because these are FILTERS — any account
  // number is a legitimate value.
  for (const name of ["reai_list_postings", "reai_general_ledger"]) {
    const tool = allTools.find((t) => t.name === name);
    assert.ok(tool, `${name} is gone — re-anchor this`);
    for (const value of [4300, "4300"]) {
      const parsed = z.object({ accountNumber: tool.inputSchema.accountNumber }).safeParse({ accountNumber: value });
      assert.ok(parsed.success, `${name} rejected accountNumber as ${typeof value}`);
      assert.equal(parsed.data.accountNumber, "4300", `${name} did not normalise ${typeof value} to the string`);
    }
  }

  // Everywhere else the weaker property, which is the one that is actually true: a stricter schema may refuse a
  // value on domain grounds — `reai_create_asset` takes only a 1xxx balance-sheet account, so it rejects "4300"
  // correctly, and an earlier version of this test asserted otherwise and failed. What must hold everywhere is
  // that IF a number is accepted, it arrives as the string form rather than as a number.
  let coercible = 0;
  for (const tool of [...allTools, ...uiTools]) {
    const schema = tool.inputSchema?.accountNumber;
    if (!schema) continue;
    const parsed = z.object({ accountNumber: schema }).safeParse({ accountNumber: 1250 });
    if (!parsed.success) continue;
    coercible++;
    assert.equal(
      typeof parsed.data.accountNumber,
      "string",
      `${tool.name} accepts accountNumber as a number and passes it on as one; the API field is a string`,
    );
  }
  assert.ok(coercible >= 2, `only ${coercible} tools accept a numeric accountNumber — re-anchor this`);
});
