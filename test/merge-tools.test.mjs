import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeForReplacement, readableRecord } from "../dist/tools/registry.js";
import { allTools, registeredTools } from "../dist/server.js";
import { classifyRequest } from "../dist/policy.js";

/**
 * The tools that wrap a replacement, and the helper they share.
 *
 * Gating the two destructive PUTs left no safe route to a rename — `reai_request` in `full` mode
 * was the only one — so these close a gap the previous change named rather than fixed.
 */

const tool = (name) => {
  const found = allTools.find((t) => t.name === name);
  assert.ok(found, `${name} is not registered`);
  return found;
};

async function run(name, args, responses) {
  const calls = [];
  const result = await tool(name).handler(
    { tenantId: 2783, ...args },
    {
      client: {
        request: async (req) => {
          calls.push(req);
          const data = typeof responses === "function" ? responses(req, calls.length) : responses;
          return { data, status: 200 };
        },
        deepLink: () => "",
      },
      config: { writeMode: "full", tenantId: 2783, allowExternalSend: false },
      session: {},
    },
  );
  return { calls, result, text: result.content.find((c) => c.type === "text").text };
}

// A company bank as the live API returns one: six settable fields among eighteen.
const BANK = {
  id: 1500,
  name: "Drift",
  countryCode: "NO",
  currency: "NOK",
  bban: "15201353103",
  swiftCode: "DNBANOKK",
  excludeFromReconciliationTodos: false,
  // Response-only, and none of it belongs in the request.
  displayName: "Drift (1520 13 53103)",
  iban: "NO1615201353103",
  manual: true,
  active: true,
  archived: false,
  providerType: null,
  providerDisplayName: null,
  syncEnabled: false,
  defaultForOutgoingPayment: false,
  hasProviderConnection: false,
  eligibleForPaymentCreation: true,
};

// ---------------------------------------------------------------------------
// The shared helper
// ---------------------------------------------------------------------------

test("the merge keeps what was not mentioned and drops what the request cannot take", () => {
  const out = mergeForReplacement({
    existing: BANK,
    changes: { name: "Drift 2" },
    settable: ["name", "countryCode", "currency", "bban", "swiftCode", "excludeFromReconciliationTodos"],
    required: ["name", "countryCode", "currency"],
  });
  assert.equal(out.merged.name, "Drift 2");
  assert.equal(out.merged.bban, "15201353103", "the account number must survive a rename");
  assert.equal(out.merged.swiftCode, "DNBANOKK");
  // The twelve response-only fields must not be echoed back.
  for (const key of ["id", "iban", "displayName", "providerType", "eligibleForPaymentCreation"]) {
    assert.equal(key in out.merged, false, `${key} is response-only`);
  }
  assert.deepEqual(out.given, ["name"]);
  assert.ok(out.kept.includes("bban"));
  assert.deepEqual(out.missing, []);
});

test("a deliberate null is kept and an absent undefined is dropped", () => {
  const out = mergeForReplacement({
    existing: BANK,
    changes: { swiftCode: null, currency: undefined },
    settable: ["name", "currency", "swiftCode"],
  });
  assert.equal(out.merged.swiftCode, null, "clearing a field on purpose is a legitimate edit");
  assert.equal(out.merged.currency, "NOK", "an unmentioned field is carried over");
  assert.deepEqual(out.given, ["swiftCode"]);
});

// Pinned as a PREFERENCE, not a correctness guard, and said so: removing the null-exclusion from
// the base failed no test, because for a nullable field an explicit null and an absent key mean
// the same thing, and for a required one the missing-check catches it either way. Whether this API
// distinguishes them anywhere is unverified — not echoing is the narrower choice, so it is the one
// taken, and this records it so the mutation is at least visible.
test("a stored null is not echoed back into the write", () => {
  const out = mergeForReplacement({
    existing: { name: "x", swiftCode: null, bban: "15201353103" },
    changes: { name: "y" },
    settable: ["name", "swiftCode", "bban"],
  });
  assert.equal("swiftCode" in out.merged, false, "an unset field is left out, not sent as null");
  assert.equal(out.merged.bban, "15201353103");
  assert.equal(out.kept.includes("swiftCode"), false, "and it is not claimed as carried over");
});

test("a missing required field is reported rather than sent", () => {
  const out = mergeForReplacement({
    existing: { name: "x" },
    changes: { name: "y" },
    settable: ["name", "countryCode", "currency"],
    required: ["name", "countryCode", "currency"],
  });
  assert.deepEqual(out.missing, ["countryCode", "currency"]);
});

test("a change the record does not already have is flagged, prototype keys included", () => {
  const out = mergeForReplacement({
    existing: { name: "x" },
    changes: { swiftCode: "DNBANOKK", toString: "surprise" },
    settable: ["name", "swiftCode", "toString"],
  });
  // `in` would have found toString on the prototype and skipped the warning.
  assert.deepEqual(out.unknown.sort(), ["swiftCode", "toString"]);
});

test("readableRecord separates 'not set yet' from 'I could not read this'", () => {
  assert.deepEqual(readableRecord({ a: 1 }).record, { a: 1 });
  // Absent or null nested means "nothing set yet", which is a legitimate base.
  assert.deepEqual(readableRecord({ address: null }, "address").record, {});
  assert.deepEqual(readableRecord({}, "address").record, {});
  // Anything else is a shape it does not understand, and must not become an empty base.
  for (const bad of ["text", 7, null, undefined, [{ a: 1 }]]) {
    assert.equal(readableRecord(bad).record, undefined, JSON.stringify(bad));
    assert.ok(readableRecord(bad).problem, "a refusal needs a reason");
  }
  assert.equal(readableRecord({ address: "Gata 1" }, "address").record, undefined);
});

// ---------------------------------------------------------------------------
// reai_update_company_bank
// ---------------------------------------------------------------------------

test("renaming a company bank keeps the account number", async () => {
  const { calls, text } = await run(
    "reai_update_company_bank",
    { id: 1500, name: "Drift 2" },
    (req, n) => (n === 1 ? BANK : { ...BANK, name: "Drift 2" }),
  );
  assert.deepEqual(calls.map((c) => c.method), ["GET", "PUT"], "it must read before replacing");
  assert.equal(calls[1].body.bban, "15201353103");
  assert.deepEqual(
    Object.keys(calls[1].body).sort(),
    ["bban", "countryCode", "currency", "excludeFromReconciliationTodos", "name", "swiftCode"],
    "only the six settable fields may be sent",
  );
  assert.match(text, /read first and written back unchanged/);
});

// The refusal below lives in the HANDLER, and these tests call the handler directly — so the
// schema has to actually let the value through, or the branch is dead code and the caller gets
// "Invalid arguments for tool ..." with none of the explanation. That is what shipped: bban was
// `.string().min(1)`, which rejects both null and "" before the handler runs, and only driving
// the tool live exposed it.
test("the schema lets a clear-request reach the handler that explains it", () => {
  const schema = tool("reai_update_company_bank").inputSchema.bban;
  assert.equal(schema.safeParse(null).success, true, "null must reach the handler's refusal");
  assert.equal(schema.safeParse("").success, true, '"" must reach it too');
  assert.equal(schema.safeParse("15201353103").success, true);
  assert.equal(schema.safeParse(15201353103).success, false, "still a string");
});

test("clearing the account number is refused even when asked for", async () => {
  // The harm this tool exists to prevent cannot happen by accident — and asking for it directly
  // is refused too, because an account with no number cannot be used for payments at all.
  for (const bban of [null, ""]) {
    const { calls, result, text } = await run("reai_update_company_bank", { id: 1500, bban }, BANK);
    assert.equal(result.isError, true, JSON.stringify(bban));
    assert.deepEqual(calls.map((c) => c.method), ["GET"], "nothing may be written");
    assert.match(text, /cannot be used for payments/);
    assert.match(text, /reai_delete_company_bank/, "it must say what to do instead");
  }
});

test("an unreadable read refuses instead of wiping", async () => {
  for (const body of ["a bank, apparently", 7, [BANK]]) {
    const { calls, result, text } = await run("reai_update_company_bank", { id: 1500, name: "x" }, body);
    assert.equal(result.isError, true, JSON.stringify(body));
    assert.deepEqual(calls.map((c) => c.method), ["GET"]);
    assert.match(text, /Nothing was written/);
  }
});

test("a response that did not store the account number sent is called out", async () => {
  // A NON-EMPTY mismatch, so this pins the mismatch warning specifically. With bban: "" both
  // warnings fired and either assertion was satisfied by the empty-account one alone — deleting
  // the mismatch check entirely left the test green.
  const mismatch = await run(
    "reai_update_company_bank",
    { id: 1500, bban: "15202296179" },
    (req, n) => (n === 1 ? BANK : { ...BANK, bban: "15201353103" }),
  );
  assert.match(mismatch.text, /came back as "15201353103"/);
  assert.match(mismatch.text, /not the "15202296179" that was sent/);
  assert.doesNotMatch(mismatch.text, /now EMPTY/, "this one is not the empty-account case");

  // And an empty or null account coming back is its own warning. null is the shape the creditor
  // measurement produced, and the first version of the check tested only for "".
  for (const bban of ["", null, "   "]) {
    const emptied = await run(
      "reai_update_company_bank",
      { id: 1500, name: "Drift 2" },
      (req, n) => (n === 1 ? BANK : { ...BANK, bban }),
    );
    assert.match(emptied.text, /account number is now EMPTY/, JSON.stringify(bban));
  }
});

test("a whitespace account number is refused like an empty one", async () => {
  // "   " is as unusable as "", and CompanyBankReq has no minLength or pattern, so the API would
  // very likely store it. The repo's own requiredName uses trim() for exactly this.
  for (const bban of ["   ", "\t"]) {
    const { calls, result, text } = await run("reai_update_company_bank", { id: 1500, bban }, BANK);
    assert.equal(result.isError, true, JSON.stringify(bban));
    assert.deepEqual(calls.map((c) => c.method), ["GET"], "nothing may be written");
    assert.match(text, /cannot be used for payments/);
  }
});

test("a whole-record read of the wrong shape is refused, not merged into", async () => {
  // The HIGH finding: readableRecord accepted any object when called without a field, so a 200
  // carrying an envelope, renamed keys, or {} became a valid base — and for a creditor, whose only
  // required field is `name`, a rename then supplied everything the API needed. The result was
  // PUT {"name": ...}, which is precisely the body measured as clearing bankAccountNumber, with
  // the note reporting the other fields as "written back unchanged".
  for (const [label, body] of [
    ["a response envelope", { data: { id: 14, name: "Sparebank 1", bankAccountNumber: "15201353103" } }],
    ["renamed keys", { Name: "Sparebank 1" }],
    ["an empty object", {}],
  ]) {
    const { calls, result, text } = await run("reai_update_creditor", { id: 14, name: "Renamed AS" }, body);
    assert.equal(result.isError, true, label);
    assert.deepEqual(calls.map((c) => c.method), ["GET"], `${label}: nothing may be written`);
    assert.match(text, /Nothing was written/);

    const bank = await run("reai_update_company_bank", { id: 1500, name: "x", countryCode: "NO", currency: "NOK" }, body);
    assert.equal(bank.result.isError, true, `${label} (company bank)`);
    assert.deepEqual(bank.calls.map((c) => c.method), ["GET"]);
  }
});

test("the company-bank tool sits at the tier of the PUT it wraps", () => {
  assert.equal(classifyRequest("PUT", "/api/company-banks/7"), "irreversible");
  assert.equal(tool("reai_update_company_bank").risk, "irreversible");
  assert.equal(tool("reai_update_company_bank").destructive, true);
});

// ---------------------------------------------------------------------------
// reai_update_creditor
// ---------------------------------------------------------------------------

const CREDITOR = { id: 14, name: "Sparebank 1", bankAccountNumber: "15201353103", createdAt: "x", updatedAt: "y" };

test("renaming a creditor keeps the repayment account", async () => {
  const { calls, text } = await run(
    "reai_update_creditor",
    { id: 14, name: "Sparebank 1 SMN" },
    (req, n) => (n === 1 ? CREDITOR : { ...CREDITOR, name: "Sparebank 1 SMN" }),
  );
  assert.deepEqual(calls.map((c) => c.method), ["GET", "PUT"]);
  assert.deepEqual(calls[1].body, { name: "Sparebank 1 SMN", bankAccountNumber: "15201353103" });
  // createdAt/updatedAt are response-only and must not be echoed.
  assert.equal("createdAt" in calls[1].body, false);
  assert.match(text, /read first and written back unchanged/);
});

test("clearing a creditor's account is allowed but stated plainly", async () => {
  // Unlike a company bank, a creditor with no account is not inherently broken — a loan may not
  // be repaid by transfer at all — so this is permitted, and said out loud.
  const { calls, text } = await run(
    "reai_update_creditor",
    { id: 14, bankAccountNumber: null },
    (req, n) => (n === 1 ? CREDITOR : { ...CREDITOR, bankAccountNumber: null }),
  );
  assert.equal(calls[1].body.bankAccountNumber, null);
  assert.match(text, /NO bank account number/);
  assert.match(text, /no destination/);
});

test("the creditor list does not read an empty list as 'no debt'", async () => {
  const empty = await run("reai_list_creditors", {}, []);
  assert.match(empty.text, /does not mean the company has no debt/);
  const some = await run("reai_list_creditors", {}, [CREDITOR, { id: 15, name: "No account" }]);
  assert.match(some.text, /1 has no bank account number/, "one creditor, singular");
});

// ---------------------------------------------------------------------------
// reai_set_supplier_address
// ---------------------------------------------------------------------------

const SUPPLIER = {
  id: 5689,
  name: "ZZ supplier",
  address: {
    addressPart1: "Gata 1",
    addressPart2: "Oppgang B",
    postalCode: "0150",
    city: "Oslo",
    province: "Oslo",
    countryCode: "NO",
  },
};

test("changing one part of a supplier address keeps the others", async () => {
  const { calls, text } = await run("reai_set_supplier_address", { id: 5689, addressPart1: "Gata 2" }, SUPPLIER);
  assert.deepEqual(calls.map((c) => c.method), ["GET", "PUT"]);
  assert.equal(calls[1].path, "/api/suppliers/5689/address");
  assert.deepEqual(calls[1].body, { ...SUPPLIER.address, addressPart1: "Gata 2" });
  assert.match(text, /read first and sent back/);
});

test("a supplier with no address yet can still have one set", async () => {
  const { calls, text } = await run(
    "reai_set_supplier_address",
    { id: 5689, addressPart1: "Gata 1", city: "Oslo", countryCode: "NO" },
    { id: 5689, address: null },
  );
  assert.deepEqual(calls[1].body, { addressPart1: "Gata 1", city: "Oslo", countryCode: "NO" });
  assert.match(text, /Nothing else was set on it beforehand/);
});

test("a supplier address change missing a required part is refused locally", async () => {
  const { calls, result, text } = await run(
    "reai_set_supplier_address",
    { id: 5689, addressPart1: "Gata 2" },
    { id: 5689, address: { addressPart1: "Gata 1", countryCode: "NO" } },
  );
  assert.equal(result.isError, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  assert.match(text, /requires city/);
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

test("every tool that wraps a replacement declares the read it depends on", () => {
  // A merge tool without a declared GET understates what it does, and the pattern is the whole
  // point: read, merge, write.
  // Derived, not listed: a hardcoded set went stale the moment reai_update_subscription joined,
  // and it would have passed while omitting it. Any tool declaring both a GET and a write on the
  // SAME resource is merging, which is the property this is about.
  const merging = registeredTools.filter((t) => {
    const paths = t.apiPaths ?? [];
    return (
      paths.some(([m]) => m === "GET") &&
      paths.some(([m]) => m === "PUT" || m === "PATCH") &&
      t.name.startsWith("reai_")
    );
  });
  assert.ok(merging.length >= 5, `expected the merge tools; found ${merging.map((t) => t.name)}`);
  for (const name of merging.map((t) => t.name)) {
    const paths = tool(name).apiPaths ?? [];
    assert.ok(
      paths.some(([m]) => m === "GET"),
      `${name} merges, so it must declare the GET it reads`,
    );
    // The WRITE, whichever verb it is. This asserted "PUT" specifically while the filter above
    // admitted PATCH too, so the first GET+PATCH merge to arrive failed a test that had selected
    // it deliberately. reai_set_employee_bank_account and reai_add_employment_line are that case:
    // PATCH /api/employees/{id} is a real patch, but its employmentLines field replaces, so the
    // read-merge-write shape is needed on a PATCH.
    assert.ok(
      paths.some(([m]) => m === "PUT" || m === "PATCH"),
      `${name} should declare the write it merges into`,
    );
  }
});

test("no tool is softer than the policy for any path it declares", () => {
  // A floor, because this sweep narrows and a narrowing filter that stops matching leaves the assertions
  // below about the empty set. See test/README.md — the audit that found this class listed thirty sweeps
  // passing with an emptied registry, and my first pass wrongly claimed this one had no filter to break.
  const irreversiblePaths = registeredTools.flatMap((t) =>
    (t.apiPaths ?? []).filter(([m, p]) => classifyRequest(m, p.replace(/\{[^}]+\}/g, "7")) === "irreversible"),
  );
  assert.ok(
    irreversiblePaths.length >= 38,
    `only ${irreversiblePaths.length} irreversible declared paths — this invariant is about nothing`,
  );
  const softer = [];
  for (const t of registeredTools) {
    for (const [method, path] of t.apiPaths ?? []) {
      if (classifyRequest(method, path.replace(/\{[^}]+\}/g, "7")) === "irreversible" && t.risk !== "irreversible") {
        softer.push(`${t.name}: ${method} ${path}`);
      }
    }
  }
  assert.deepEqual(softer, [], "a curated tool must not be a softer route than reai_request");
});

/**
 * A tool argument must not accept `null` where the document says the field cannot be null.
 *
 * Doing so passes local validation and fails at the API, which is the opposite of what these
 * schemas are for — `excludeFromReconciliationTodos` was exactly that, made `.nullable()` by
 * reflex alongside two fields where the document does allow it. Swept rather than checked by
 * hand, because "I added .nullable() without looking" is not a mistake one notices twice.
 */
const NULLABLE_ON_PURPOSE = {
  "reai_update_company_bank.bban":
    "the handler REFUSES a null or empty account number before anything is sent, and it can only " +
    "do that if the value reaches it; with .min(1) the caller got a bare validation error instead " +
    "of an explanation and a pointer at reai_delete_company_bank",
};

test("no tool accepts null where the spec says the field cannot be null", async () => {
  const { getSpecIndex } = await import("../dist/reai/spec.js");
  const index = getSpecIndex();
  const offenders = [];
  let checked = 0;
  for (const t of registeredTools) {
    for (const [method, path] of t.apiPaths ?? []) {
      if (method === "GET") continue;
      const op = index.operations.find((o) => o.method === method && o.path === path);
      const fields = op?.body?.fields ?? {};
      for (const [field, descriptor] of Object.entries(fields)) {
        const schema = t.inputSchema?.[field];
        if (!schema) continue;
        // The index marks a nullable type with a trailing "?" — the meaning this repo got wrong
        // once already, so it is spelled out here: this is nullability, not optionality.
        const specNullable = String(descriptor).endsWith("?");
        if (specNullable) continue;
        checked += 1;
        if (schema.safeParse(null).success !== true) continue;
        const key = `${t.name}.${field}`;
        if (key in NULLABLE_ON_PURPOSE) continue;
        offenders.push(`${key} accepts null; ${method} ${path} declares ${descriptor}`);
      }
    }
  }
  assert.ok(checked >= 20, `expected non-nullable fields to compare against; checked ${checked}`);
  assert.deepEqual(
    offenders,
    [],
    "these would pass local validation and be refused by the API — drop .nullable(), or record " +
      "the exception in NULLABLE_ON_PURPOSE with the reason it buys a better answer",
  );
});

test("every deliberate nullable exception is real and still needed", () => {
  for (const [key, reason] of Object.entries(NULLABLE_ON_PURPOSE)) {
    const [toolName, field] = key.split(".");
    const t = registeredTools.find((x) => x.name === toolName);
    assert.ok(t, `exception names an unknown tool: ${toolName}`);
    assert.ok(t.inputSchema?.[field], `${toolName} has no ${field} argument`);
    assert.ok(reason.length > 40, `${key} needs a reason, not a placeholder`);
    // If it stops accepting null, the exception is stale and hiding the next one.
    assert.equal(
      t.inputSchema[field].safeParse(null).success,
      true,
      `${key} no longer accepts null — drop the exception`,
    );
  }
});
