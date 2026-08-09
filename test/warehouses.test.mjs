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

// The API marks variantId optional. Anything that can hold stock has at least one variant
// (the API refuses a stock product without one), and an adjustment that omits it is accepted
// while moving nothing — so there is no useful call without it. Requiring it removes the
// failure mode rather than detecting it after the fact.
test("variantId is required, not optional as the API has it", () => {
  const schema = tool("reai_adjust_inventory").inputSchema.variantId;
  assert.equal(schema.isOptional(), false, "the whole silent-no-op class hinges on this");
  assert.equal(schema.safeParse(undefined).success, false);
  assert.equal(schema.safeParse(231671).success, true);
  // And it is always sent, so `variantId: null` — the shape the API answers 200 to while
  // moving nothing — can never originate from this tool.
  assert.equal(schema.safeParse(0).success, false);
});

test("a variant the warehouse does not track is refused before the write", async () => {
  const { calls, result, text } = await run(
    "reai_adjust_inventory",
    { productId: 55252, warehouseId: 356, quantityChange: 4, variantId: 999999 },
    inventory([
      { productId: 55252, variantId: 231671, sku: "ZZ-A", quantityOnHand: 7, productTitle: "Probe" },
      { productId: 777, variantId: 231680, sku: "OTHER", quantityOnHand: 1 },
    ]),
  );
  assert.equal(result.isError, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET"], "nothing may be written");
  assert.match(text, /not a stock line of product 55252/);
  // It must name what IS available, or the caller cannot recover.
  assert.match(text, /231671/);
  assert.match(text, /7 on hand/);
  // ...and must not offer another product's variant as a candidate.
  assert.doesNotMatch(text, /231680/);
});

test("a product with no stock line at all is refused, with the likely reason", async () => {
  const { calls, result, text } = await run(
    "reai_adjust_inventory",
    { productId: 900, warehouseId: 356, quantityChange: 2, variantId: 5 },
    inventory([{ productId: 1, variantId: 2, quantityOnHand: 0 }]),
  );
  assert.equal(result.isError, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  assert.match(text, /no stock line in warehouse 356 at all/);
  assert.match(text, /check that this product is a stock item/);
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
    n === 1
      ? inventory([{ productId: 1, variantId: 9, quantityOnHand: 0 }])
      : { transactionId: 1, quantityOnHand: 1, variantId: 9 };
  const base = { productId: 1, warehouseId: 2, quantityChange: 1, variantId: 9 };

  const date = await run("reai_adjust_inventory", { ...base, occurredAt: "2026-08-01" }, responses);
  assert.equal(date.calls[1].body.occurredAt, "2026-08-01T00:00:00Z");

  // Already a timestamp: passed through untouched, offset and all.
  for (const given of ["2026-08-01T10:00:00Z", "2026-08-01T10:00:00+02:00", "2026-08-01T10:00"]) {
    const full = await run("reai_adjust_inventory", { ...base, occurredAt: given }, responses);
    assert.equal(full.calls[1].body.occurredAt, given);
  }

  // Omitted entirely rather than sent as undefined, so the API applies its own default.
  const none = await run("reai_adjust_inventory", base, responses);
  assert.equal("occurredAt" in none.calls[1].body, false);
});

// An unvalidated z.string() passed these straight through to produce exactly the bare 400
// the argument's own description promises to prevent.
test("a date the API cannot parse is rejected here, not forwarded", () => {
  const schema = tool("reai_adjust_inventory").inputSchema.occurredAt;
  for (const good of ["2026-08-01", "2026-08-01T10:00", "2026-08-01T10:00:00", "2026-08-01T10:00:00Z", "2026-08-01T10:00:00.123Z", "2026-08-01T10:00:00+02:00"]) {
    assert.equal(schema.safeParse(good).success, true, good);
  }
  for (const bad of ["01.08.2026", "2026-8-1", "2026-08-01 10:00", "yesterday", "", "2026/08/01", "2026-08-01T"]) {
    assert.equal(schema.safeParse(bad).success, false, `${bad} should be rejected`);
  }
  assert.match(schema.safeParse("01.08.2026").error.issues[0].message, /yyyy-MM-dd or a full ISO timestamp/);
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

// Not "so the gate sees both calls": the gate skips GET entirely (policy.ts returns early on
// it, and the spec-bounds and escalation sweeps skip it too), so declaring the pre-read grants
// and changes nothing there. The reason is narrower and worth stating correctly — apiPaths is
// what a reader consults for what a tool touches, and omitting a call the tool always makes
// would understate it.
test("the read-before-write is declared, so apiPaths does not understate the tool", () => {
  const paths = tool("reai_adjust_inventory").apiPaths.map(([m, p]) => `${m} ${p}`);
  assert.ok(paths.includes("POST /api/warehouses/inventory/adjust"));
  assert.ok(paths.includes("GET /api/warehouses/inventory"), "the pre-read must be declared");
  // And the declaration must not soften the risk: GET classifies as read, so if a GET entry
  // could lower a tool's tier this would be the tool where it mattered most.
  assert.equal(tool("reai_adjust_inventory").risk, "irreversible");
});

// `?? []` covers null and undefined, not a wrong type — so a non-array `rows` made the
// pre-read that exists to prevent a silent write throw a TypeError instead. The sibling read
// tool in the same file already handled this shape; the adjust handler did not.
// `?? []` covers null and undefined, not a wrong type — so a non-array `rows` made the
// pre-read that exists to prevent a silent write throw a TypeError instead. The sibling read
// tool in the same file already handled this shape; the adjust handler did not.
test("an unreadable pre-read neither crashes nor swallows the missing check", async () => {
  for (const rows of [{ "0": { productId: 1 } }, "rows", 7, null, undefined]) {
    const attempt = await run(
      "reai_adjust_inventory",
      { productId: 1, warehouseId: 2, quantityChange: 3, variantId: 9 },
      (req, n) => (n === 1 ? { warehouseId: 2, rows } : { transactionId: 1, quantityOnHand: 3, variantId: 9 }),
    );
    // The variant was supplied, so the no-op failure mode is gone and the write may proceed.
    assert.notEqual(attempt.result.isError, true, `rows=${JSON.stringify(rows)}`);
    assert.equal(attempt.calls[1].method, "POST");
    // But the comparison genuinely did not run, and that must not read as a clean result.
    assert.match(attempt.text, /NOT verified against an expected total/, `rows=${JSON.stringify(rows)}`);
    assert.doesNotMatch(attempt.text, /WARNING: stock did NOT move/);
  }
});

// The API echoes the variant it acted on. A null echo against a variant that WAS sent is the
// no-op signature itself, and it needs nothing from the pre-read — so it still fires in the
// cases where the pre-read could not be read or matched.
test("a null variantId echoed back is reported as having moved nothing", async () => {
  const { text } = await run(
    "reai_adjust_inventory",
    { productId: 55252, warehouseId: 356, quantityChange: 3, variantId: 231671 },
    (req, n) =>
      n === 1
        ? inventory([{ productId: 55252, variantId: 231671, quantityOnHand: 0 }])
        : { transactionId: 147036, quantityOnHand: 0, variantId: null },
  );
  assert.match(text, /echoed back variantId: null/);
  assert.match(text, /accepted and moves no stock/);
});

test("an absent quantityOnHand is reported as unknown, not as zero or as success", async () => {
  const { text } = await run(
    "reai_adjust_inventory",
    { productId: 1, warehouseId: 2, quantityChange: 3, variantId: 9 },
    (req, n) =>
      n === 1
        ? inventory([{ productId: 1, variantId: 9, quantityOnHand: 0 }])
        : { transactionId: 5, variantId: 9 },
  );
  assert.match(text, /carried no quantityOnHand/);
  assert.match(text, /UNKNOWN/);
  assert.match(text, /not zero/);
});

// Landing on exactly zero is the workflow reai_delete_warehouse recommends, so a real
// adjustment that ends at 0 must not be reported as one that moved nothing.
test("an adjustment that legitimately lands on zero is not flagged", async () => {
  const { text } = await run(
    "reai_adjust_inventory",
    { productId: 1, warehouseId: 2, quantityChange: -4, variantId: 9 },
    (req, n) =>
      n === 1
        ? inventory([{ productId: 1, variantId: 9, quantityOnHand: 4 }])
        : { transactionId: 6, quantityOnHand: 0, variantId: 9 },
  );
  assert.doesNotMatch(text, /WARNING/);
  assert.doesNotMatch(text, /moved nothing/);
  assert.match(text, /0 now on hand/);
});

test("the negative-line summary is bounded, since ok() does not shorten a note", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    productId: i,
    sku: `SKU-${"x".repeat(40)}-${i}`,
    quantityOnHand: -1 - i,
    stockValue: -100,
  }));
  const { text } = await run("reai_get_warehouse_inventory", {}, inventory(many));
  assert.match(text, /40 line\(s\) are NEGATIVE/);
  assert.match(text, /and 30 more/, "the sample must be bounded, and the remainder counted");
  // Measured on the NOTE alone. The body is legitimately long and ok() already trims it to
  // the result budget; the note is the part ok() does not shorten, so it is the part that
  // has to bound itself. An earlier version asserted on note + body and failed for that
  // reason rather than for the one it was written about.
  const note = text.split("\n\n").find((b) => !b.trim().startsWith("[")) ?? text;
  assert.ok(note.length < 1200, `the note alone grew to ${note.length} characters`);
  assert.equal((note.match(/SKU-/g) ?? []).length, 10, "exactly the sample, not every line");
});

test("renaming a warehouse states the name the response carries, not the one sent", async () => {
  // reai_rename_warehouse: a rename is the case where quoting the request back is least defensible —
  // reai_create_customer already documents this API storing a name title-cased.
  const { text } = await run("reai_rename_warehouse", { warehouseId: 4, name: "hovedlager" }, {
    id: 4,
    name: "Hovedlager",
  });
  assert.match(text, /is now named "Hovedlager", read back from the response/);
  assert.match(text, /WARNING: name \(sent "hovedlager", warehouse 4 came back with "Hovedlager"\)/);
});

test("renaming a warehouse says so plainly when the response carries no name", async () => {
  // The negative branch: a bodyless 200 must not be reported as a confirmed rename.
  const { text } = await run("reai_rename_warehouse", { warehouseId: 4, name: "Nytt navn" }, undefined);
  assert.match(text, /was sent the name "Nytt navn", but the response does not carry it/);
  assert.doesNotMatch(text, /read back from the response/);
});

test("renaming a warehouse to the name it stores reports no discrepancy", async () => {
  // Positive control: a warning on every rename would pass the tests above and make the tool worse.
  const { text } = await run("reai_rename_warehouse", { warehouseId: 4, name: "Hovedlager" }, {
    id: 4,
    name: "Hovedlager",
  });
  assert.match(text, /is now named "Hovedlager", read back from the response/);
  assert.doesNotMatch(text, /WARNING/);
});
