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
