import { test } from "node:test";
import assert from "node:assert/strict";
import { assetTools } from "../dist/tools/assets.js";
import { registeredTools } from "../dist/server.js";
import { classifyRequest, isAllowed } from "../dist/policy.js";

const tool = (name) => {
  const found = assetTools.find((t) => t.name === name);
  assert.ok(found, `${name} is not registered`);
  return found;
};

async function run(name, args, response) {
  const calls = [];
  const result = await tool(name).handler(
    { tenantId: 2783, ...args },
    {
      client: {
        request: async (req) => {
          calls.push(req);
          return { data: response, status: 200 };
        },
        deepLink: () => "link",
      },
      config: { writeMode: "full", tenantId: 2783 },
      session: {},
    },
  );
  return { calls, text: result.content.find((c) => c.type === "text").text };
}

// The pattern is the API's, and rejecting early gives the reason instead of a bare 422.
test("an asset must sit on a balance-sheet account", () => {
  const schema = tool("reai_create_asset").inputSchema.accountNumber;
  for (const good of ["1200", "1250", "1999"]) {
    assert.equal(schema.safeParse(good).success, true, good);
  }
  for (const bad of ["3000", "120", "12500", "1200a", "", "6790"]) {
    const parsed = schema.safeParse(bad);
    assert.equal(parsed.success, false, `${bad} should be rejected`);
  }
  assert.match(schema.safeParse("6790").error.issues[0].message, /balance-sheet account/);
});

test("creating an asset says plainly that it posted nothing", async () => {
  const { calls, text } = await run(
    "reai_create_asset",
    {
      name: "Delivery van",
      accountNumber: "1200",
      acquisitionDate: "2026-01-15",
      acquisitionCost: 250000,
      usefulLifeInMonths: 60,
      depreciationMethod: "linear",
    },
    { id: 42 },
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/api/assets");
  // tenantId must not leak into the body — it is a header.
  assert.equal(calls[0].body.tenantId, undefined);
  assert.equal(calls[0].body.usefulLifeInMonths, 60);
  assert.equal(calls[0].body.accountNumber, "1200");
  // Measured behaviour, stated so an agent does not go looking for a voucher that is not
  // there — or worse, book the acquisition twice assuming this did it.
  assert.match(text, /No voucher was posted by this call/);
  assert.match(text, /Registered asset 42/);
});

// The endpoint has no summary and no description in the spec, AssetRes carries no
// carrying-value or written-off field, and no asset with real value could be produced — so
// the note must report what was seen and no more. An earlier version asserted "write-off
// removes the carrying value", which had no source at all.
test("write-off reports only what the response shows", async () => {
  const { calls, text } = await run("reai_write_off_asset", { assetId: 42 }, { id: 42 });
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/api/assets/42/write-off");
  assert.equal(calls[0].body, undefined, "the endpoint takes no body");
  assert.match(text, /still in the register/);
  assert.match(text, /check the ledger/i);
  // No claim about an amount, because nothing in the response carries one.
  assert.doesNotMatch(text, /removes the carrying value/);
});

// ApiLifecycleOutcomeRes is deleted | archived | reversed. Only "deleted" has been observed
// — a referenced asset is refused with 409 rather than archived or reversed — but all three
// are reported distinctly, because "removed" is false for an archived record.
test("every outcome the shared enum allows is reported distinctly", async () => {
  // "deleted" is the outcome for the ASSET. Reading it as "and therefore no counter-entry
  // exists" is an inference the shared enum does not support, and it would be wrong in
  // exactly the case where checking the ledger matters most.
  const deleted = await run("reai_delete_asset", { assetId: 42 }, { outcome: "deleted" });
  assert.match(deleted.text, /the outcome for the ASSET/);
  assert.match(deleted.text, /check the ledger/);
  assert.doesNotMatch(deleted.text, /Nothing referenced it/);

  const archived = await run("reai_delete_asset", { assetId: 42 }, { outcome: "archived" });
  assert.match(archived.text, /ARCHIVED, not deleted/);
  assert.match(archived.text, /still exists in the books/);
  assert.doesNotMatch(archived.text, /Asset 42 deleted/);

  const reversed = await run("reai_delete_asset", { assetId: 42 }, { outcome: "reversed" });
  assert.match(reversed.text, /REVERSED/);
  assert.match(reversed.text, /has not been observed/);

  const silent = await run("reai_delete_asset", { assetId: 42 }, {});
  assert.match(silent.text, /before assuming what happened/);
});

// The API's own DELETE description says a linked voucher is deleted or reversed. It is
// refused instead — verified by booking a voucher against an asset and deleting it.
test("the tool describes the 409, not the description the spec offers", () => {
  const description = tool("reai_delete_asset").description;
  assert.match(description, /409/);
  assert.match(description, /used in existing vouchers/);
  assert.match(description, /contradicts the API's own description/);
  // And it must not repeat the warning the spec invites, which would be a false alarm.
  assert.doesNotMatch(description, /can put a reversing entry in the ledger/);
});

// Land is capitalised and never depreciated; the API accepts an asset with no schedule.
test("a non-depreciable asset can be registered", async () => {
  const schema = tool("reai_create_asset").inputSchema;
  assert.equal(schema.usefulLifeInMonths.isOptional(), true);
  assert.equal(schema.depreciationMethod.isOptional(), true);
  const { calls } = await run("reai_create_asset", { name: "Tomt", accountNumber: "1150" }, { id: 9 });
  assert.deepEqual(calls[0].body, { name: "Tomt", accountNumber: "1150" });
});

test("the depreciation schedule is replaced whole, and the note says what the RECORD now is", async () => {
  // The fixture used to answer `{ id: 42 }` and the assertion still passed, because the note quoted `args`.
  // AssetRes carries both fields and this PUT returns it, so the fixture now answers as the API does.
  //
  // Correcting a claim this comment used to make: the fixture is NOT what makes the assertion meaningful. Its
  // stored values EQUAL the sent ones, so an echo and a read-back print the same figures — review proved that
  // by mutating the handler back to `args` with the wording kept, and only the sibling test below failed. What
  // distinguishes this one is the literal ", both read back from the response" suffix.
  const { calls, text } = await run(
    "reai_set_asset_depreciation",
    { assetId: 42, usefulLifeInMonths: 36, depreciationMethod: "manual" },
    { id: 42, depreciationMethod: "manual", usefulLifeInMonths: 36 },
  );
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].path, "/api/assets/42/depreciation");
  assert.deepEqual(calls[0].body, { usefulLifeInMonths: 36, depreciationMethod: "manual" });
  assert.match(text, /depreciates manual over 36 month\(s\), both read back from the response/);
});

test("an empty register is not the same as owning nothing", async () => {
  const empty = await run("reai_list_assets", {}, []);
  assert.match(empty.text, /anything expensed rather than capitalised never appears here/);

  // And a shape surprise must not be reported as emptiness.
  const wrapped = await run("reai_list_assets", {}, { content: [{ id: 1, name: "Van" }] });
  assert.match(wrapped.text, /did not return a list/);
  assert.match(wrapped.text, /Van/);
});

test("every asset write is gated at full, and the deletes are flagged destructive", () => {
  assert.equal(assetTools.length, 6);
  for (const t of assetTools) {
    assert.ok(registeredTools.includes(t), `${t.name} must be inside the invariant sweeps`);
    assert.ok(!t.transmits, `${t.name} must not leave the tenant`);
    // The declared risk may never be softer than what the escape hatch would say.
    for (const [method, path] of t.apiPaths ?? []) {
      const viaPolicy = classifyRequest(method, path.replace(/\{[^}]+\}/g, "7"));
      if (viaPolicy === "irreversible") assert.equal(t.risk, "irreversible", `${t.name} vs ${method} ${path}`);
    }
  }
  for (const name of ["reai_list_assets", "reai_get_asset"]) assert.equal(tool(name).risk, "read", name);
  for (const name of ["reai_create_asset", "reai_set_asset_depreciation", "reai_write_off_asset", "reai_delete_asset"]) {
    assert.equal(tool(name).risk, "irreversible", name);
    assert.equal(isAllowed(tool(name).risk, "reversible"), false, `${name} must not run in the default mode`);
  }
  // Both of these dispose of something; a client that confirms destructive calls must be told.
  assert.equal(tool("reai_write_off_asset").destructive, true);
  assert.equal(tool("reai_delete_asset").destructive, true);
});

test("setting a depreciation schedule states what the response stored, not what was sent", async () => {
  // reai_set_asset_depreciation: declared IRREVERSIBLE, and it was the last tool stating the resulting
  // schedule from `args`. AssetRes carries both fields and this PUT returns it.
  const { text } = await run(
    "reai_set_asset_depreciation",
    { assetId: 8, usefulLifeInMonths: 60, depreciationMethod: "linear" },
    { id: 8, depreciationMethod: "manual", usefulLifeInMonths: 60 },
  );
  assert.match(text, /now depreciates manual over 60 month\(s\), both read back from the response/);
  assert.match(text, /WARNING: depreciationMethod \(sent "linear", asset 8 came back with "manual"\)/);
});

test("a depreciation response missing the fields is not reported as a confirmed schedule", async () => {
  const { text } = await run(
    "reai_set_asset_depreciation",
    { assetId: 8, usefulLifeInMonths: 60, depreciationMethod: "linear" },
    undefined,
  );
  assert.match(text, /neither was read back .*the response came back as no body.*so both are what was SENT/);
  assert.doesNotMatch(text, /read back from the response\./);
});

test("a depreciation schedule the API stored as sent reports no discrepancy", async () => {
  // Positive control, and it also pins the numeric read-back: 60 must not be quoted from args by accident.
  const { text } = await run(
    "reai_set_asset_depreciation",
    { assetId: 8, usefulLifeInMonths: 60, depreciationMethod: "linear" },
    { id: 8, depreciationMethod: "linear", usefulLifeInMonths: 60 },
  );
  assert.match(text, /now depreciates linear over 60 month\(s\), both read back from the response/);
  assert.match(text, /Future depreciation follows the new schedule/);
  assert.doesNotMatch(text, /WARNING/);
});

test("a depreciation response of nulls is not read as the stored schedule", async () => {
  // reai_set_asset_depreciation: gating on `!== undefined` printed "now depreciates null over null month(s),
  // read back from the response" — a confident sentence stating a value this API is documented as
  // substituting. A stored null counts as unanswered here; the contradiction still gets its warning.
  const { text } = await run(
    "reai_set_asset_depreciation",
    { assetId: 8, usefulLifeInMonths: 60, depreciationMethod: "linear" },
    { id: 8, depreciationMethod: null, usefulLifeInMonths: null },
  );
  assert.doesNotMatch(text, /depreciates null/);
  assert.match(text, /"linear" as SENT over 60 as SENT month\(s\)/);
  assert.match(text, /WARNING: usefulLifeInMonths .*depreciationMethod /);
});

test("one depreciation field read back does not throw away the other", async () => {
  // reai_set_asset_depreciation: the all-or-nothing gate put the REQUEST's method in front of the reader in a
  // case where the response had already contradicted it — sent linear, stored manual, headline said linear.
  const { text } = await run(
    "reai_set_asset_depreciation",
    { assetId: 8, usefulLifeInMonths: 60, depreciationMethod: "linear" },
    { id: 8, depreciationMethod: "manual" },
  );
  assert.match(text, /now depreciates manual over 60 as SENT month\(s\)/);
  assert.match(text, /The value marked SENT was not carried back by the response/);
  assert.match(text, /WARNING: depreciationMethod \(sent "linear", asset 8 came back with "manual"\)/);
});

test("a depreciation response that is not a record says so, rather than denying the fields", async () => {
  // reai_set_asset_depreciation: an array response made the note deny values a payload below it might carry.
  const { text } = await run(
    "reai_set_asset_depreciation",
    { assetId: 8, usefulLifeInMonths: 60, depreciationMethod: "linear" },
    [{ id: 8, depreciationMethod: "manual", usefulLifeInMonths: 12 }],
  );
  assert.match(text, /neither was read back \(the response came back as an array of 1\)/);
});

test("a depreciation account returned as an object is not stated as a read-back", async () => {
  // reai_create_asset: `String(stored)` produced "on account [object Object], read back from the response"
  // after an irreversible write — found by review in the very commit that was hardening these handlers against
  // unexpected 200 shapes.
  const { text } = await run(
    "reai_create_asset",
    { name: "ZZ asset", accountNumber: "1150" },
    { id: 9, accountNumber: { value: "1150" } },
  );
  assert.doesNotMatch(text, /\[object Object\]/);
  assert.match(text, /the response carries accountNumber as an object, which is not a value this can state/);
  assert.match(text, /as SENT/);
});
