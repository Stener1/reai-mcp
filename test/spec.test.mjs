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
