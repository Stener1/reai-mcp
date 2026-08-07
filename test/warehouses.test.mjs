import { test } from "node:test";
import assert from "node:assert/strict";
import { warehouseTools } from "../dist/tools/warehouses.js";
import { registeredTools } from "../dist/server.js";
import { classifyRequest, isAllowed } from "../dist/policy.js";

const tool = (name) => {
  const found = warehouseTools.find((t) => t.name === name);
  assert.ok(found, `${name} is not registered`);
  return found;
};

/**
 * `responses` is a function of the request, so a tool that reads before it writes can be
 * given a different answer per call — which is the whole point for reai_adjust_inventory.
 * `calls` is what it actually sent, so a refusal can be checked for having sent nothing.
 */
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
        deepLink: () => "link",
      },
      config: { writeMode: "full", tenantId: 2783 },
      session: {},
    },
  );
  return { calls, result, text: result.content.find((c) => c.type === "text").text };
}

const inventory = (rows) => ({
  warehouseId: 1,
  rows,
  totalStockValue: rows.reduce((s, r) => s + (r.stockValue ?? 0), 0),
  totalRetailValue: 0,
});

// ---------------------------------------------------------------------------
// The measured no-op: 200 + a transactionId, and no stock moved.
// ---------------------------------------------------------------------------

test("an adjustment that would silently move nothing is refused before it is written", async () => {
  const { calls, result, text } = await run(
    "reai_adjust_inventory",
    { productId: 55252, warehouseId: 356, quantityChange: 4 },
    inventory([
      { productId: 55252, variantId: 231671, sku: "ZZ-A", quantityOnHand: 0, productTitle: "Probe" },
      { productId: 55252, variantId: 231672, sku: "ZZ-B", quantityOnHand: 7 },
    ]),
  );
  assert.equal(result.isError, true);
  // The whole value of the refusal: nothing was POSTed.
  assert.deepEqual(
    calls.map((c) => c.method),
    ["GET"],
    "the refusal must happen before the write, not after it",
  );
  assert.match(text, /Nothing was written/);
  // And it has to name the variants, or the caller cannot act on it.
  assert.match(text, /231671/);
  assert.match(text, /231672/);
  assert.match(text, /ZZ-A/);
  assert.match(text, /7 on hand/);
});

test("a product with no variant rows is adjusted without a variantId", async () => {
  const { calls, result } = await run(
    "reai_adjust_inventory",
    { productId: 900, warehouseId: 356, quantityChange: 2 },
    (req, n) =>
      n === 1
        ? inventory([{ productId: 900, variantId: null, quantityOnHand: 5 }])
        : { transactionId: 1, quantityOnHand: 7 },
  );
  assert.notEqual(result.isError, true);
  assert.equal(calls[1].method, "POST");
  // Absent, not null: sending variantId: null is the shape the API answers 200 to while
  // moving nothing, so it must not be introduced by the tool itself.
  assert.equal("variantId" in calls[1].body, false);
});

test("the resulting quantity is checked against the pre-read, not trusted", async () => {
  // The exact live signature: accepted, a real transaction id, and on-hand did not move.
  const { text } = await run(
    "reai_adjust_inventory",
    { productId: 55252, warehouseId: 356, quantityChange: 3, variantId: 231671 },
    (req, n) =>
      n === 1
        ? inventory([{ productId: 55252, variantId: 231671, quantityOnHand: 0 }])
        : { transactionId: 147036, quantityOnHand: 0, variantId: null },
  );
  assert.match(text, /WARNING: stock did NOT move as asked/);
  assert.match(text, /was 0 before/);
  assert.match(text, /3 was requested, so 3 was expected/);
  assert.match(text, /reports 0/);
});

test("a normal adjustment reports the new quantity and does not cry wolf", async () => {
  const { text } = await run(
    "reai_adjust_inventory",
    { productId: 55252, warehouseId: 356, quantityChange: 4, variantId: 231671 },
    (req, n) =>
      n === 1
        ? inventory([{ productId: 55252, variantId: 231671, quantityOnHand: 0 }])
        : { transactionId: 147038, quantityOnHand: 4, variantId: 231671 },
  );
  assert.doesNotMatch(text, /WARNING/);
  assert.match(text, /by \+4/);
  assert.match(text, /4 now on hand/);
  assert.match(text, /transaction 147038/);
  // Measured, and the reason an agent should not go looking for a voucher.
  assert.match(text, /No voucher was posted/);
  assert.match(text, /cannot be deleted/);
});

test("negative stock is called out, because the API accepts it silently", async () => {
  const { text } = await run(
    "reai_adjust_inventory",
    { productId: 55252, warehouseId: 356, quantityChange: -10, variantId: 231671 },
    (req, n) =>
      n === 1
        ? inventory([{ productId: 55252, variantId: 231671, quantityOnHand: 4 }])
        : { transactionId: 147039, quantityOnHand: -6, variantId: 231671 },
  );
  // -6 IS what -10 against 4 should give, so this must not be reported as a failed move.
  assert.doesNotMatch(text, /WARNING: stock did NOT move/);
  assert.match(text, /Stock is now NEGATIVE \(-6\)/);
});

test("occurredAt is completed to a timestamp, since a bare date is refused with no field name", async () => {
  const responses = (req, n) =>
    n === 1 ? inventory([{ productId: 1, variantId: null, quantityOnHand: 0 }]) : { transactionId: 1, quantityOnHand: 1 };

  const date = await run(
    "reai_adjust_inventory",
    { productId: 1, warehouseId: 2, quantityChange: 1, occurredAt: "2026-08-01" },
    responses,
  );
  assert.equal(date.calls[1].body.occurredAt, "2026-08-01T00:00:00Z");

  // Already a timestamp: passed through untouched, offset and all.
  for (const given of ["2026-08-01T10:00:00Z", "2026-08-01T10:00:00+02:00"]) {
    const full = await run(
      "reai_adjust_inventory",
      { productId: 1, warehouseId: 2, quantityChange: 1, occurredAt: given },
      responses,
    );
    assert.equal(full.calls[1].body.occurredAt, given);
  }

  // Omitted entirely rather than sent as undefined, so the API applies its own default.
  const none = await run("reai_adjust_inventory", { productId: 1, warehouseId: 2, quantityChange: 1 }, responses);
  assert.equal("occurredAt" in none.calls[1].body, false);
});

test("a zero adjustment is rejected: it would record a movement of nothing", () => {
  const schema = tool("reai_adjust_inventory").inputSchema.quantityChange;
  assert.equal(schema.safeParse(0).success, false);
  assert.match(schema.safeParse(0).error.issues[0].message, /must not be 0/);
  for (const good of [1, -1, 500, -500]) assert.equal(schema.safeParse(good).success, true, String(good));
  // A delta, so fractions are not accepted where the API takes int32.
  assert.equal(schema.safeParse(1.5).success, false);
});

// ---------------------------------------------------------------------------
// Listing, reading, and the archive branch
// ---------------------------------------------------------------------------

test("archived is sent only when asked for, because it selects rather than widens", async () => {
  const off = await run("reai_list_warehouses", {}, [{ id: 1, name: "Main" }]);
  assert.equal(off.calls[0].query, undefined, "omitting the filter must not send archived=false");

  const on = await run("reai_list_warehouses", { archived: true }, []);
  assert.deepEqual(on.calls[0].query, { archived: "true" });
  assert.match(on.text, /No archived warehouses/);
  assert.match(on.text, /Active ones are not listed here/);

  const explicitlyOff = await run("reai_list_warehouses", { archived: false }, []);
  assert.deepEqual(explicitlyOff.calls[0].query, { archived: "false" });
  // An empty ACTIVE list is the dangerous one: stock can be in an archived warehouse.
  assert.match(explicitlyOff.text, /archived rather than deleted/);
});

test("an empty warehouse list is not the same as no stock anywhere", async () => {
  const { text } = await run("reai_list_warehouses", {}, []);
  assert.match(text, /archived ones are only returned by archived=true/);
});

test("reading an archived warehouse says so", async () => {
  const archived = await run("reai_get_warehouse", { id: 357 }, { id: 357, name: "Old", archived: true });
  assert.match(archived.text, /is ARCHIVED/);
  assert.match(archived.text, /does not appear in the default warehouse list/);

  const active = await run("reai_get_warehouse", { id: 1 }, { id: 1, name: "Main", archived: false });
  assert.doesNotMatch(active.text, /ARCHIVED/);
});

test("delete reports which of the two things happened", async () => {
  const archived = await run("reai_delete_warehouse", { warehouseId: 357 }, { outcome: "archived" });
  assert.match(archived.text, /was ARCHIVED, not deleted/);
  assert.match(archived.text, /still holds whatever stock/);
  assert.match(archived.text, /no unarchive endpoint/);
  // The actionable part: how to make it a real delete.
  assert.match(archived.text, /bring its stock to zero/);

  const deleted = await run("reai_delete_warehouse", { warehouseId: 1 }, { outcome: "deleted" });
  assert.match(deleted.text, /deleted, along with its stock transaction history/);
  assert.doesNotMatch(deleted.text, /ARCHIVED, not deleted/);

  // The shared enum's third value has not been observed here; it must not be reported as
  // either of the two that have.
  const other = await run("reai_delete_warehouse", { warehouseId: 1 }, { outcome: "reversed" });
  assert.match(other.text, /reported outcome "reversed"/);
  assert.match(other.text, /before assuming it is gone/);

  const silent = await run("reai_delete_warehouse", { warehouseId: 1 }, {});
  assert.match(silent.text, /before assuming it is gone/);
});

test("the inventory envelope is read as an object, and a shape change is not read as zero", async () => {
  const stocked = await run(
    "reai_get_warehouse_inventory",
    { warehouseId: 1 },
    inventory([{ productId: 1, sku: "A", quantityOnHand: 4, stockValue: 400 }]),
  );
  assert.deepEqual(stocked.calls[0].query, { warehouseId: "1" });
  assert.match(stocked.text, /1 stock line\(s\)/);
  assert.match(stocked.text, /total stock value 400/);

  const empty = await run("reai_get_warehouse_inventory", {}, inventory([]));
  assert.equal(empty.calls[0].query, undefined, "omitting warehouseId reports across all of them");
  assert.match(empty.text, /No stock lines/);
  assert.match(empty.text, /not a stock item never/);

  // An array, or anything without `rows`, must not be reported as an empty warehouse.
  const wrong = await run("reai_get_warehouse_inventory", {}, [{ productId: 1 }]);
  assert.match(wrong.text, /no `rows` array/);
  assert.doesNotMatch(wrong.text, /No stock lines/);
});

test("negative stock lines are named in the summary", async () => {
  const { text } = await run(
    "reai_get_warehouse_inventory",
    { warehouseId: 1 },
    inventory([
      { productId: 1, sku: "A", quantityOnHand: 4, stockValue: 400 },
      { productId: 2, sku: "B", quantityOnHand: -6, stockValue: -600 },
    ]),
  );
  assert.match(text, /1 line\(s\) are NEGATIVE/);
  assert.match(text, /B: -6/);
});

test("the name bound the API actually enforces is applied locally", () => {
  for (const name of ["reai_create_warehouse", "reai_rename_warehouse"]) {
    const schema = tool(name).inputSchema.name;
    assert.equal(schema.safeParse("A".repeat(160)).success, true, name);
    assert.equal(schema.safeParse("A".repeat(161)).success, false, `${name} must cap at 160`);
    assert.equal(schema.safeParse("   ").success, false, `${name} must reject whitespace`);
  }
});

test("rename sends only the name, which is all this resource has", async () => {
  const { calls } = await run("reai_rename_warehouse", { warehouseId: 5, name: "Nytt lager" }, { id: 5 });
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].path, "/api/warehouses/5");
  assert.deepEqual(calls[0].body, { name: "Nytt lager" });
});

test("create sends only the name and does not leak tenantId into the body", async () => {
  const { calls, text } = await run("reai_create_warehouse", { name: "Hovedlager" }, { id: 353 });
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, { name: "Hovedlager" });
  assert.equal(calls[0].tenantId, 2783);
  assert.match(text, /Created warehouse 353/);
  assert.match(text, /holds no stock yet/);
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

test("every warehouse tool is inside the sweeps, and none is softer than the policy", () => {
  assert.equal(warehouseTools.length, 7);
  for (const t of warehouseTools) {
    assert.ok(registeredTools.includes(t), `${t.name} must be inside the invariant sweeps`);
    assert.ok(!t.transmits, `${t.name} must not leave the tenant`);
    for (const [method, path] of t.apiPaths ?? []) {
      const viaPolicy = classifyRequest(method, path.replace(/\{[^}]+\}/g, "7"));
      if (viaPolicy === "irreversible") {
        assert.equal(t.risk, "irreversible", `${t.name} vs ${method} ${path}`);
      }
    }
  }
  for (const name of ["reai_list_warehouses", "reai_get_warehouse", "reai_get_warehouse_inventory"]) {
    assert.equal(tool(name).risk, "read", name);
  }
  for (const name of ["reai_create_warehouse", "reai_rename_warehouse", "reai_delete_warehouse"]) {
    assert.equal(tool(name).risk, "reversible", name);
  }
  // The adjustment cannot be undone — no route lists or deletes a stock transaction — so it
  // must not be reachable in the default mode.
  assert.equal(tool("reai_adjust_inventory").risk, "irreversible");
  assert.equal(isAllowed("irreversible", "reversible"), false);
  // A host that confirms destructive calls has to be told about the archive-or-delete one.
  assert.equal(tool("reai_delete_warehouse").destructive, true);
});

test("the read-before-write is declared, so the gate sees both calls it makes", () => {
  const paths = tool("reai_adjust_inventory").apiPaths.map(([m, p]) => `${m} ${p}`);
  assert.ok(paths.includes("POST /api/warehouses/inventory/adjust"));
  assert.ok(
    paths.includes("GET /api/warehouses/inventory"),
    "the pre-read must be declared, or apiPaths understates what the tool does",
  );
});
