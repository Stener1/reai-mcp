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

// The API decides the amount, so there is nothing to check locally — but the note must not
// imply the record is gone, because it is not.
test("write-off leaves the record in the register", async () => {
  const { calls, text } = await run("reai_write_off_asset", { assetId: 42 }, { id: 42 });
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/api/assets/42/write-off");
  assert.equal(calls[0].body, undefined, "the endpoint takes no body");
  assert.match(text, /The asset stays in the register/);
});

// The spec's description says the body is always {"outcome":"deleted"}; its response schema
// allows "reversed". Report what arrived, not what the description claims.
test("deleting an asset reports a reversal when that is what happened", async () => {
  const reversed = await run("reai_delete_asset", { assetId: 42 }, { outcome: "reversed" });
  assert.match(reversed.text, /acquisition voucher REVERSED/);
  assert.match(reversed.text, /counter-entry is now in the ledger/);

  const deleted = await run("reai_delete_asset", { assetId: 42 }, { outcome: "deleted" });
  assert.match(deleted.text, /deleted/);
  assert.doesNotMatch(deleted.text, /REVERSED/);

  const silent = await run("reai_delete_asset", { assetId: 42 }, {});
  assert.match(silent.text, /Check the ledger before assuming nothing was posted/);
});

test("the depreciation schedule is replaced whole, and the note says what it now is", async () => {
  const { calls, text } = await run(
    "reai_set_asset_depreciation",
    { assetId: 42, usefulLifeInMonths: 36, depreciationMethod: "manual" },
    { id: 42 },
  );
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].path, "/api/assets/42/depreciation");
  assert.deepEqual(calls[0].body, { usefulLifeInMonths: 36, depreciationMethod: "manual" });
  assert.match(text, /depreciates manual over 36 month\(s\)/);
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
