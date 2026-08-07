import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getSpecIndex,
  searchOperations,
  findOperation,
  describeOperation,
} from "../dist/reai/spec.js";

test("the index loads and covers the documented API", () => {
  const index = getSpecIndex();
  assert.ok(index.counts.total > 400, `expected >400 operations, got ${index.counts.total}`);
  assert.ok(index.counts.public > 300, `expected >300 public operations, got ${index.counts.public}`);
  assert.ok(index.counts.internal > 0);
  assert.equal(index.serverUrl, "https://app.reai.no");
  for (const tag of ["Invoices", "Vouchers", "Customers", "Supplier invoices"]) {
    assert.ok(index.tags[tag] > 0, `expected tag ${tag}`);
  }
});

test("internal endpoints are excluded by default and reachable on request", () => {
  const hidden = searchOperations({ query: "adyen webhook" });
  assert.equal(hidden.length, 0, "payment-provider webhooks must not surface by default");

  const shown = searchOperations({ query: "adyen webhook", includeInternal: true });
  assert.ok(shown.length > 0);
  assert.ok(shown.every((o) => o.internal));
});

test("domain searches find the right endpoint", () => {
  const cases = [
    ["bank reconciliation", "/api/bank-reconciliations"],
    ["chart of accounts", "/api/chart-of-accounts"],
    ["supplier invoice", "/api/supplier-invoices"],
    ["vat code", "/api/vat-codes"],
    ["customer ledger", "/api/ledger/customer"],
    ["salary payment", "/api/salary-payments"],
    ["share investment", "/api/share-investments"],
  ];
  for (const [query, expectedPath] of cases) {
    const hits = searchOperations({ query, limit: 10 });
    assert.ok(
      hits.some((h) => h.path.startsWith(expectedPath)),
      `search "${query}" did not surface ${expectedPath}; got ${hits.slice(0, 4).map((h) => h.path).join(", ")}`,
    );
  }
});

test("search honours method and tag filters", () => {
  const posts = searchOperations({ query: "customer", method: "POST", limit: 50 });
  assert.ok(posts.length > 0);
  assert.ok(posts.every((h) => h.method === "POST"));

  const invoices = searchOperations({ tag: "Invoices", limit: 100 });
  assert.ok(invoices.length > 0);
  assert.ok(invoices.every((h) => h.tag === "Invoices" || h.tags.includes("Invoices")));
});

test("an empty query browses rather than returning nothing", () => {
  const hits = searchOperations({ tag: "Vouchers" });
  assert.ok(hits.length > 0);
});

test("search results are capped by limit", () => {
  assert.equal(searchOperations({ query: "invoice", limit: 3 }).length, 3);
});

test("findOperation resolves by method and path, including templated paths", () => {
  assert.ok(findOperation("GET", "/api/customers"));
  assert.ok(findOperation("POST", "/api/vouchers"));
  assert.ok(findOperation("GET", "/api/customers/{id}"));
  // Path-parameter names are interchangeable for route matching.
  assert.ok(findOperation("GET", "/api/customers/{customerId}"));
  assert.equal(findOperation("GET", "/api/nope"), undefined);
});

test("findOperation resolves by operation id", () => {
  const byPath = findOperation("POST", "/api/vouchers");
  const byId = findOperation(byPath.id);
  assert.equal(byId?.path, "/api/vouchers");
});

test("describeOperation expands the voucher body to real posting fields", () => {
  const op = findOperation("POST", "/api/vouchers");
  const described = describeOperation(op);

  assert.equal(described.method, "POST");
  assert.equal(described.path, "/api/vouchers");
  assert.ok(described.requestBody);

  const schema = described.requestBody.schema;
  assert.deepEqual(schema.required, ["date", "postings"]);

  const posting = schema.properties.postings.items;
  assert.ok(posting.properties.accountNumber, "posting must expose accountNumber");
  assert.ok(posting.properties.amount, "posting must expose amount");
  assert.ok(posting.properties.vatCode, "posting must expose vatCode");
  assert.match(
    posting.properties.amount.description,
    /positive/i,
    "the debit/credit sign convention must survive into the description",
  );
});

test("describeOperation hides the tenant header, which the client owns", () => {
  const op = findOperation("POST", "/api/vouchers");
  const described = describeOperation(op);
  assert.ok(
    !described.parameters.some((p) => p.name.toLowerCase() === "x-tenant-id"),
    "X-Tenant-Id must not be presented as a callable parameter",
  );
});

test("describeOperation reports required query parameters", () => {
  const op = findOperation("GET", "/api/vouchers");
  const described = describeOperation(op);
  const required = described.parameters.filter((p) => p.required).map((p) => p.name);
  assert.ok(required.includes("startDate"), `startDate must be required, got ${required.join(", ")}`);
  assert.ok(required.includes("endDate"));
});

test("describeOperation terminates on recursive schemas", () => {
  // Guards against a hang or stack overflow rather than asserting a shape.
  for (const op of getSpecIndex().operations.filter((o) => !o.internal).slice(0, 120)) {
    assert.doesNotThrow(() => JSON.stringify(describeOperation(op, 4)), `${op.method} ${op.path}`);
  }
});

// An enum is a closed set, so a silently-shortened one is worse than none: the agent
// reads it as exhaustive and concludes the missing values are illegal. Both the index
// and describeOperation used to cut at 8 and 12 with no marker, which is how
// GET /api/vouchers advertised 8 of its 16 voucher types.
test("enums are published in full, and truncation is always marked", () => {
  const index = getSpecIndex();
  const vouchers = index.operations.find((o) => o.method === "GET" && o.path === "/api/vouchers");
  const voucherType = vouchers.params.find((p) => p.name === "voucherType").type;
  for (const value of ["MANUAL", "VAT_RETURN", "LOAN", "CUSTOMER_INVOICE_ADJUSTMENT"]) {
    assert.ok(voucherType.includes(value), `voucherType enum is missing ${value}: ${voucherType}`);
  }
  assert.ok(!/\+\d+ more/.test(voucherType), "16 values fit under the limit; nothing should be dropped");

  // Every enum that IS shortened says so, in the index and at runtime alike.
  for (const op of index.operations) {
    for (const p of op.params ?? []) {
      if (!p.type.startsWith("enum(")) continue;
      const shown = p.type.slice(5, p.type.lastIndexOf(")")).split("|");
      assert.ok(
        shown.length <= 24 || /\+\d+ more/.test(p.type),
        `${op.method} ${op.path} ${p.name}: ${shown.length} values with no truncation marker`,
      );
    }
  }
});

// An array parameter carries its enum on `items`, which the array branch read past
// entirely — so three live parameters rendered as a bare `string[]` with their legal
// values published nowhere in the server's output.
test("array-valued enums keep their values", () => {
  const index = getSpecIndex();
  const op = index.operations.find(
    (o) => o.method === "GET" && o.path === "/api/bank-reconciliations/{bankAccountId}",
  );
  const include = op.params.find((p) => p.name === "include");
  assert.match(include.type, /^enum\(/, `expected an enum, got ${include.type}`);
  assert.ok(include.type.endsWith("[]"), `expected an array marker, got ${include.type}`);
  for (const value of ["summary", "pending_transactions", "pending_postings", "matched_groups"]) {
    assert.ok(include.type.includes(value), `missing ${value}`);
  }
  // ...and the same value survives the runtime path, which re-derives from the raw spec.
  const described = describeOperation(op).parameters.find((p) => p.name === "include");
  assert.ok(described.type.includes("matched_groups"), described.type);
});

// A 45-value enum exists (user permission codes), so the limit really does bind
// somewhere. When it does, the full set must remain reachable — the compact index is
// a search summary, describe is authoritative.
test("a truncated enum is still recoverable in full from describeOperation", () => {
  const index = getSpecIndex();
  const op = index.operations.find((o) => o.method === "POST" && o.path === "/api/users");
  assert.match(op.body.fields.directPermissionCodes, /\+\d+ more/);
  const full = describeOperation(op).requestBody?.schema?.properties?.directPermissionCodes;
  assert.ok(full.items.enum.length > 24, `expected the full set, got ${full.items.enum?.length}`);
});

// The `*-ctrl` tag heuristic hides 85 operations, and is right about nearly all of
// them — UI typeahead, Adyen and Shopify webhooks, point-of-sale auth. But registering
// a payroll payment is not an undocumented internal, and hiding it made an agent asked
// to do that report the capability as absent, which is worse than refusing because it
// is false. None of these has a documented twin; four candidates were dropped because
// they did.
test("business operations behind the -ctrl heuristic are discoverable", () => {
  const index = getSpecIndex();
  const exposed = index.operations.filter((o) => !o.internal && !o.path.startsWith("/api/"));
  assert.ok(exposed.length > 0, "the allowlist should expose something");

  // A path's literal segments, singularised and with the /api prefix dropped, so
  // /project/{id}/sub-project/{x} and /api/projects/{id}/sub-projects/{x}/name are
  // comparable. Matching on the LAST segment alone was too weak: it read those two as
  // different because one ends in a parameter and the other in "name", and missed
  // that renameSubProject and updateSubProjectName are the same action.
  const segments = (path) =>
    path
      .split("/")
      .filter((s) => s && !s.startsWith("{") && s !== "api")
      .map((s) => s.replace(/s$/, "").replace(/ie$/, "y"));

  for (const op of exposed) {
    assert.ok(!/-ctrl$/.test(op.tag), `${op.path} carries the internal tag ${op.tag}`);
    assert.ok(index.tags[op.tag] > 0, `${op.path} has tag ${op.tag}, absent from the tag index`);

    // A documented operation covering the same resources with the same method is a
    // twin even when its path is longer — the extra segment names the action.
    const mine = segments(op.path);
    const twin = index.operations.find(
      (o) =>
        !o.internal &&
        o.path.startsWith("/api/") &&
        o.method === op.method &&
        mine.every((s) => segments(o.path).includes(s)),
    );
    assert.equal(twin, undefined, `${op.method} ${op.path} duplicates ${twin?.path}`);
  }

  const salary = exposed.find((o) => o.path === "/salary/{id}/register-payment");
  assert.ok(salary, "registering a payroll payment must be reachable");
  assert.equal(salary.tag, "Salary Payments");
});

// Advertising something reai_request cannot call is the same false signal this
// allowlist exists to remove, pointing the other way. POST /invoice/setting/receiver-bank
// takes a required object-valued query parameter and no body, which the tool's
// scalar-and-scalar-array query model cannot express; it is excluded for that reason.
test("every exposed business operation is actually callable through reai_request", () => {
  const index = getSpecIndex();
  for (const op of index.operations.filter((o) => !o.internal && !o.path.startsWith("/api/"))) {
    const described = describeOperation(op);
    for (const p of described.parameters ?? []) {
      if (p.in !== "query") continue;
      assert.ok(
        !/^object|^oneOf/.test(p.type),
        `${op.method} ${op.path}: query parameter "${p.name}" is ${p.type}, which reai_request cannot send`,
      );
    }
  }
});
