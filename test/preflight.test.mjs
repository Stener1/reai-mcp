import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveOperation, missingRequired, findOperation } from "../dist/reai/spec.js";
import { allTools } from "../dist/server.js";

/**
 * Resolving a concrete path back to its spec operation, and using that to explain a
 * failed call.
 *
 * The escape hatch only ever sees concrete paths — "/api/customers/1234", not
 * "/api/customers/{id}" — so before this it could not show an agent the schema or
 * the quirks for the endpoint it was actually calling.
 */

test("a concrete path resolves to its templated operation", () => {
  for (const [method, concrete, expected] of [
    ["GET", "/api/customers/1234", "/api/customers/{id}"],
    ["GET", "/api/vouchers/999", "/api/vouchers/{id}"],
    ["DELETE", "/api/customers/5/contact-persons/9", "/api/customers/{id}/contact-persons/{contactPersonId}"],
    ["GET", "/api/customers", "/api/customers"],
  ]) {
    const op = resolveOperation(method, concrete);
    assert.ok(op, `${method} ${concrete} did not resolve`);
    assert.equal(op.path, expected);
    assert.equal(op.method, method);
  }
});

test("a literal segment beats a placeholder at the same position", () => {
  // "/api/vat-returns/reopen" must not be read as an id called "reopen".
  const op = resolveOperation("POST", "/api/vat-returns/reopen");
  assert.ok(op);
  assert.equal(op.path, "/api/vat-returns/reopen");
});

test("resolution is method-specific and fails closed", () => {
  assert.equal(resolveOperation("GET", "/api/nonexistent/1"), undefined);
  assert.equal(resolveOperation("PUT", "/api/leads"), undefined, "no PUT on /api/leads");
  // Segment count must match; a shorter or longer path is not the same operation.
  assert.equal(resolveOperation("GET", "/api/customers/1/2/3"), undefined);
});

test("resolveOperation agrees with findOperation on templated paths", () => {
  // Both should identify the same operation when given the same thing in their own
  // form, or the two lookups have diverged.
  for (const path of ["/api/customers", "/api/vouchers", "/api/timesheets", "/api/leads"]) {
    const byTemplate = findOperation("GET", path);
    const byConcrete = resolveOperation("GET", path);
    assert.equal(byConcrete?.path, byTemplate?.path, path);
  }
});

test("missing required query parameters are reported", () => {
  // The case that motivated this: the API reveals these one rejection at a time.
  const op = resolveOperation("GET", "/api/timesheets");
  assert.ok(op);

  const none = missingRequired(op, undefined, undefined);
  assert.deepEqual(none.params, ["projectId", "startDate", "endDate"]);

  const partial = missingRequired(op, { projectId: 1 }, undefined);
  assert.deepEqual(partial.params, ["startDate", "endDate"]);

  const all = missingRequired(op, { projectId: 1, startDate: "2026-01-01", endDate: "2026-08-06" }, undefined);
  assert.deepEqual(all.params, [], "nothing should be reported once all are present");
});

test("a present-but-falsy parameter counts as supplied", () => {
  // 0 and "" are legitimate values; only absence is missing.
  const op = resolveOperation("GET", "/api/timesheets");
  const result = missingRequired(op, { projectId: 0, startDate: "", endDate: "2026-08-06" }, undefined);
  assert.deepEqual(result.params, []);
});

test("missing required body fields are reported, and only for objects", () => {
  const op = [...allTools] && resolveOperation("POST", "/api/vouchers");
  assert.ok(op, "POST /api/vouchers should resolve");
  const required = op.body?.required ?? [];
  if (required.length === 0) return; // nothing to assert against for this operation

  const empty = missingRequired(op, undefined, {});
  assert.deepEqual(empty.bodyFields, required, "an empty body is missing all of them");

  const full = missingRequired(op, undefined, Object.fromEntries(required.map((f) => [f, "x"])));
  assert.deepEqual(full.bodyFields, [], "a complete body reports nothing");
});

test("a non-object body does not produce spurious field reports", () => {
  // `body` is typed unknown on reai_request, so it can be an array or a string.
  const op = resolveOperation("POST", "/api/vouchers");
  const required = op.body?.required ?? [];
  for (const body of [undefined, null, "a string", 42, [1, 2, 3]]) {
    const result = missingRequired(op, undefined, body);
    assert.deepEqual(
      result.bodyFields,
      required,
      `a ${typeof body} body should report the spec's required fields, not crash`,
    );
  }
});

test("literal path segments are matched exactly, not case-insensitively", () => {
  // The API's routes are case-sensitive and the client sends the path unchanged, so
  // "/API/opening-balances" really does 404. Folding case here resolved it to the
  // real operation and then attached that endpoint's empty-state quirk, telling the
  // agent nothing had been set up rather than that the path was wrong.
  assert.ok(resolveOperation("GET", "/api/opening-balances"), "the correct path must resolve");
  assert.equal(resolveOperation("GET", "/API/opening-balances"), undefined);
  assert.equal(resolveOperation("GET", "/Api/Customers/1"), undefined);
});

test("a wholly omitted body is reported when the operation requires one", () => {
  // 51 operations declare a mandatory body whose every property is optional, so the
  // required-fields list cannot express "you sent no body at all".
  const op = resolveOperation("PUT", "/api/leads/5/notes");
  assert.ok(op, "PUT /api/leads/{id}/notes should resolve");
  assert.equal(op.body?.bodyRequired, true);
  assert.deepEqual(op.body?.required ?? [], [], "this operation has no required properties");

  assert.equal(missingRequired(op, undefined, undefined).bodyMissing, true);
  assert.equal(missingRequired(op, undefined, {}).bodyMissing, false, "an empty object IS a body");
});

test("an operation with no required body does not report one missing", () => {
  const get = resolveOperation("GET", "/api/customers");
  assert.equal(missingRequired(get, undefined, undefined).bodyMissing, false);
});

test("an empty query array counts as not supplied", () => {
  // ReaiClient.buildUrl drops an array once its null/undefined entries are removed
  // and nothing is left, so [] never reaches the API — treating it as present meant
  // the rejection came back without the guidance explaining it.
  const op = resolveOperation("GET", "/api/leads/person-role-matches");
  assert.ok(op);
  const required = (op.params ?? []).filter((p) => p.required && p.in === "query").map((p) => p.name);
  assert.ok(required.length > 0, "this operation should have a required query parameter");
  const name = required[0];

  assert.deepEqual(missingRequired(op, { [name]: [] }, undefined).params, required);
  assert.deepEqual(missingRequired(op, { [name]: [null, undefined] }, undefined).params, required);
  assert.deepEqual(missingRequired(op, { [name]: ["x"] }, undefined).params, []);
  // A falsy scalar is still transmitted, so it counts as supplied.
  assert.deepEqual(missingRequired(op, { [name]: "" }, undefined).params, []);
  assert.deepEqual(missingRequired(op, { [name]: 0 }, undefined).params, []);
});

test("an HTML response is reported as a routing miss, not a success", async () => {
  // A path matching no API route falls through to the web app, which answers 200
  // with its HTML shell — "/notarealpath" and a mis-capitalised
  // "/API/opening-balances" both do. A success status carrying a login page is the
  // worst possible shape for an agent, so it is reported as a failure.
  const tool = allTools.find((t) => t.name === "reai_request");
  assert.ok(tool);

  const ctx = {
    config: { boundTenantId: undefined, defaultTenantId: 1, writeMode: "reversible", allowExternalSend: false },
    session: {},
    client: {
      request: async () => ({ status: 200, data: "<!DOCTYPE html><html></html>", contentType: "text/html" }),
      deepLink: () => "https://app.reai.no/",
    },
  };

  const res = await tool.handler({ method: "GET", path: "/api/opening-balances" }, ctx);
  assert.equal(res.isError, true, "HTML must not be reported as a successful call");
  const text = res.content.map((c) => c.text).join("\n");
  assert.match(text, /matched no API route/);
  assert.match(text, /case-sensitive/);
});

test("a JSON response is still reported as success", async () => {
  const tool = allTools.find((t) => t.name === "reai_request");
  const ctx = {
    config: { boundTenantId: undefined, defaultTenantId: 1, writeMode: "reversible", allowExternalSend: false },
    session: {},
    client: {
      request: async () => ({ status: 200, data: [{ id: 1 }], contentType: "application/json" }),
      deepLink: () => "https://app.reai.no/",
    },
  };
  const res = await tool.handler({ method: "GET", path: "/api/customers" }, ctx);
  assert.notEqual(res.isError, true);
});

test("every curated tool's declared apiPaths still resolve", () => {
  // A tool naming a path that no longer exists in the spec is a drift signal: the
  // policy test compares tools against classifyRequest, but nothing checked that
  // the paths are real.
  const unresolved = [];
  for (const tool of allTools) {
    for (const [method, path] of tool.apiPaths ?? []) {
      if (!method || !path) continue;
      // Templated paths come from the tool definitions, so compare via findOperation.
      if (!findOperation(method, path)) unresolved.push(`${tool.name}: ${method} ${path}`);
    }
  }
  assert.deepEqual(unresolved, [], `tool apiPaths not found in the spec:\n  ${unresolved.join("\n  ")}`);
});
