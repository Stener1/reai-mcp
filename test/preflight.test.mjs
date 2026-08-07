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
  // Uses a REAL overlap. The previous fixture was POST /api/vat-returns/reopen,
  // where no "/api/vat-returns/{id}" exists at all — so there was no placeholder to
  // beat and deleting the preference entirely left the test passing.
  //
  // These GETs are the genuine collisions in the current spec: each literal shares a
  // segment count with an {id} sibling.
  for (const [concrete, expected] of [
    ["/api/users/permissions", "/api/users/permissions"],
    ["/api/users/roles", "/api/users/roles"],
    ["/api/users/invitations", "/api/users/invitations"],
    ["/api/warehouses/inventory", "/api/warehouses/inventory"],
    ["/api/leads/person-profiles", "/api/leads/person-profiles"],
    ["/api/projects/activities", "/api/projects/activities"],
    ["/api/accountant-clients/missing-annual-control", "/api/accountant-clients/missing-annual-control"],
  ]) {
    const op = resolveOperation("GET", concrete);
    assert.ok(op, `${concrete} did not resolve`);
    assert.equal(op.path, expected, `${concrete} resolved to the {id} sibling instead`);
  }

  // And the placeholder still wins when the segment is genuinely an id.
  assert.equal(resolveOperation("GET", "/api/users/1234")?.path, "/api/users/{id}");
  assert.equal(resolveOperation("GET", "/api/warehouses/9")?.path, "/api/warehouses/{id}");
});

test("a non-numeric segment does not match an integer path parameter", () => {
  // This is what actually disambiguates the collisions above, and it is worth
  // stating plainly: with it in place the literal-vs-placeholder preference is a
  // backstop rather than the deciding rule, so no black-box test can distinguish
  // whether that preference is present. The type check can be tested, and is.
  assert.equal(resolveOperation("GET", "/api/users/notanumber"), undefined);
  assert.equal(resolveOperation("GET", "/api/customers/abc"), undefined);
  // Negative and multi-digit ids are still ids.
  assert.equal(resolveOperation("GET", "/api/users/0")?.path, "/api/users/{id}");
  assert.equal(resolveOperation("GET", "/api/users/999999")?.path, "/api/users/{id}");
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

test("missing required body fields are reported", () => {
  const op = resolveOperation("POST", "/api/vouchers");
  assert.ok(op, "POST /api/vouchers should resolve");
  const required = op.body?.required ?? [];
  assert.ok(required.length > 0, "POST /api/vouchers should declare required body fields");

  const empty = missingRequired(op, undefined, {});
  assert.deepEqual(empty.bodyFields, required, "an empty body is missing all of them");

  const full = missingRequired(op, undefined, Object.fromEntries(required.map((f) => [f, "x"])));
  assert.deepEqual(full.bodyFields, [], "a complete body reports nothing");
});

test("a non-object body reports the spec's required fields rather than crashing", () => {
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

test("HTML is detected even in binary mode", async () => {
  // Following the documented guidance and setting binary: true for a PDF endpoint
  // must not bypass this: parseBody would base64-encode the HTML shell and the call
  // would be reported as a successful attachment download — the exact false success
  // the check exists to prevent.
  const tool = allTools.find((t) => t.name === "reai_request");
  const ctx = {
    config: { boundTenantId: undefined, defaultTenantId: 1, writeMode: "reversible", allowExternalSend: false },
    session: {},
    client: {
      request: async () => ({ status: 200, data: "PGh0bWw+", contentType: "text/html" }),
      deepLink: () => "https://app.reai.no/",
    },
  };
  const res = await tool.handler({ method: "GET", path: "/api/documents/1/content", binary: true }, ctx);
  assert.equal(res.isError, true, "an HTML body must fail even when binary was requested");
  assert.match(res.content.map((c) => c.text).join("\n"), /matched no API route/);
});

test("a required body with required fields is not called all-optional", async () => {
  // POST /api/assets requires a body AND requires accountNumber and name inside it.
  // Saying "every property is optional" immediately before listing those two as
  // required contradicts itself.
  const op = resolveOperation("POST", "/api/assets");
  assert.ok(op);
  assert.equal(op.body?.bodyRequired, true);
  const result = missingRequired(op, undefined, undefined);
  assert.equal(result.bodyMissing, true);
  assert.ok(result.bodyFields.length > 0, "this operation should have required fields too");
});

test("a null body counts as absent, matching the client", async () => {
  // ReaiClient.request serialises a payload only when the body is neither undefined
  // nor null, so `body: null` transmits nothing.
  const op = resolveOperation("PUT", "/api/leads/5/notes");
  assert.equal(missingRequired(op, undefined, null).bodyMissing, true);
  assert.equal(missingRequired(op, undefined, undefined).bodyMissing, true);
  assert.equal(missingRequired(op, undefined, {}).bodyMissing, false);
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

/**
 * The enrichment itself, which had no test at all: replacing the whole of
 * `enrichRequestFailure` with `return err` left the suite green, so none of the
 * shipped behaviour of this feature was verified.
 */

const REQUEST_CTX = {
  config: { boundTenantId: undefined, defaultTenantId: 1, writeMode: "reversible", allowExternalSend: false },
  session: {},
  client: { deepLink: () => "https://app.reai.no/" },
};

/** Drive the real reai_request handler against a client that fails as given. */
async function callFailing(args, { status, detail, contentType = "application/problem+json" }) {
  const { ReaiApiError } = await import("../dist/reai/errors.js");
  const tool = allTools.find((t) => t.name === "reai_request");
  const ctx = {
    ...REQUEST_CTX,
    client: {
      ...REQUEST_CTX.client,
      request: async () => {
        throw new ReaiApiError({
          status,
          method: args.method,
          path: args.path,
          rawBody: JSON.stringify({ detail }),
          problem: { detail, status },
          ...(contentType ? {} : {}),
        });
      },
    },
  };
  // The handler RETHROWS the enriched error — server.ts turns it into a tool error
  // by reading err.message — so the message is what has to be inspected.
  try {
    const res = await tool.handler(args, ctx);
    return res.content.map((c) => c.text).join("\n");
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

test("a 400 is enriched with the required parameters and the matching quirk", async () => {
  const text = await callFailing(
    { method: "GET", path: "/api/timesheets" },
    { status: 400, detail: "projectId is required" },
  );
  assert.match(text, /projectId, startDate, endDate/, "all three should be named at once");
  assert.match(text, /Known quirk/, "the endpoint's 400 quirk should be attached");
});

test("a 403 does NOT get the 404 empty-state quirk", async () => {
  // This stated something false about a customer's books: it told the agent to
  // "report it as empty" when the real answer was that it may not read them.
  const text = await callFailing(
    { method: "GET", path: "/api/opening-balances" },
    { status: 403, detail: "Forbidden" },
  );
  assert.doesNotMatch(text, /NOTHING HAS BEEN SET UP YET/);
  assert.doesNotMatch(text, /Report it as empty/);
});

test("a 404 DOES get the empty-state quirk", async () => {
  const text = await callFailing(
    { method: "GET", path: "/api/opening-balances" },
    { status: 404, detail: "Opening balance not found" },
  );
  assert.match(text, /NOTHING HAS BEEN SET UP YET/);
});

test("a 401 gets no module-disabled advice and no payload analysis", async () => {
  // An expired token read as "the Project module is disabled, stop retrying" —
  // burying the one action that would have worked.
  const text = await callFailing(
    { method: "GET", path: "/api/timesheets" },
    { status: 401, detail: "Unauthorized" },
  );
  assert.doesNotMatch(text, /module is (off|disabled)/i);
  assert.doesNotMatch(text, /were not sent/, "the payload is not the problem on a 401");
});

test("a 429 is not answered with a list of missing parameters", async () => {
  // The client has already exhausted its retries; the request shape is irrelevant.
  const text = await callFailing(
    { method: "GET", path: "/api/timesheets" },
    { status: 429, detail: "Too many requests" },
  );
  assert.doesNotMatch(text, /were not sent/);
});

test("a 5xx is passed through untouched", async () => {
  const text = await callFailing(
    { method: "GET", path: "/api/timesheets" },
    { status: 503, detail: "Service unavailable" },
  );
  assert.doesNotMatch(text, /Known quirk/);
  assert.doesNotMatch(text, /were not sent/);
});

test("an unresolvable path is not enriched with another endpoint's advice", async () => {
  const text = await callFailing(
    { method: "GET", path: "/api/definitely-not-a-real-endpoint" },
    { status: 404, detail: "No static resource" },
  );
  assert.doesNotMatch(text, /Known quirk/);
});

test("a query string in the path is refused rather than silently dropped", async () => {
  const tool = allTools.find((t) => t.name === "reai_request");
  const res = await tool.handler(
    { method: "GET", path: "/api/timesheets?projectId=7&startDate=2026-01-01" },
    { ...REQUEST_CTX, client: { ...REQUEST_CTX.client, request: async () => ({ status: 200, data: [] }) } },
  );
  const text = res.content.map((c) => c.text).join("\n");
  assert.match(text, /Put query parameters in the "query" argument/);
  assert.match(text, /projectId/);
});

test("a genuine HTML attachment is not mistaken for a routing miss", async () => {
  // Attachment endpoints declare */* and ReAI stores whatever was uploaded, so an
  // HTML invoice is an ordinary successful download. Content-Disposition — surfaced
  // by parseBody as `filename` — is what distinguishes it from the SPA shell.
  const tool = allTools.find((t) => t.name === "reai_request");
  const res = await tool.handler(
    { method: "GET", path: "/api/attachments/42/content", binary: true },
    {
      ...REQUEST_CTX,
      client: {
        ...REQUEST_CTX.client,
        request: async () => ({
          status: 200,
          contentType: "text/html",
          data: { base64: "PGh0bWw+", contentType: "text/html", filename: "invoice-from-supplier.html" },
        }),
      },
    },
  );
  assert.notEqual(res.isError, true, "a named payload is a real file, not the app shell");
});

test("an HTML body with no content-type is still caught", async () => {
  // ReAI omits content-type in the wild, and letting undefined fall through left the
  // false success this guard exists to close.
  const tool = allTools.find((t) => t.name === "reai_request");
  const res = await tool.handler(
    { method: "GET", path: "/api/opening-balances" },
    {
      ...REQUEST_CTX,
      client: {
        ...REQUEST_CTX.client,
        request: async () => ({ status: 200, data: "<!DOCTYPE html>\n<html lang=\"no\"></html>" }),
      },
    },
  );
  assert.equal(res.isError, true);
  assert.match(res.content.map((c) => c.text).join("\n"), /matched no API route/);
});

test("charset on the content-type does not defeat the guard", async () => {
  const tool = allTools.find((t) => t.name === "reai_request");
  const res = await tool.handler(
    { method: "GET", path: "/api/opening-balances" },
    {
      ...REQUEST_CTX,
      client: {
        ...REQUEST_CTX.client,
        request: async () => ({ status: 200, contentType: "text/html; charset=utf-8", data: "<html></html>" }),
      },
    },
  );
  assert.equal(res.isError, true);
});

test("a bound tenant cannot be overridden via the path or query", async () => {
  // resolveTenantId governs only the X-Tenant-Id header, but twelve operations name a
  // tenant as a path or query parameter — and /api/accountant-clients/{clientTenantId}
  // plus its notes endpoints are public. That is exactly the accountant case the README
  // describes, one token reaching every client company, so a grant bound to one tenant
  // could still address another by naming it in the path.
  const { allTools } = await import("../dist/server.js");
  const tool = allTools.find((t) => t.name === "reai_request");

  const sent = [];
  const ctx = (boundTenantId) => ({
    config: { boundTenantId, defaultTenantId: boundTenantId ?? 1, writeMode: "full", allowExternalSend: false },
    session: {},
    client: {
      request: async (opts) => {
        sent.push(opts);
        return { status: 200, data: [] };
      },
      deepLink: () => "https://app.reai.no/",
    },
  });

  const refused = [
    { method: "GET", path: "/api/accountant-clients/200" },
    { method: "POST", path: "/api/accountant-clients/200/oppdragskontroll-notes", body: {} },
    { method: "POST", path: "/auth/select-tenant", query: { tenantId: 200 } },
    // Case-insensitive query binding, and a percent-encoded id, must not slip past.
    { method: "POST", path: "/auth/select-tenant", query: { TenantId: "200" } },
    { method: "GET", path: "/api/accountant-clients/2%30%30" },
  ];
  for (const args of refused) {
    sent.length = 0;
    const res = await tool.handler(args, ctx(100));
    assert.equal(sent.length, 0, `${args.method} ${args.path} should not be sent`);
    assert.match(res.content.map((c) => c.text).join("\n"), /bound to tenant 100/);
  }

  // The bound tenant's own id is fine, and so is an ordinary call.
  for (const args of [
    { method: "GET", path: "/api/accountant-clients/100" },
    { method: "GET", path: "/api/customers" },
  ]) {
    sent.length = 0;
    await tool.handler(args, ctx(100));
    assert.equal(sent.length, 1, `${args.path} should be sent`);
  }

  // With no bound tenant there is nothing to enforce.
  sent.length = 0;
  await tool.handler({ method: "GET", path: "/api/accountant-clients/200" }, ctx(undefined));
  assert.equal(sent.length, 1);
});

test("every voucher type the API declares is accepted by the filter", async () => {
  // Eight of sixteen were listed while the filter read as exhaustive, so "show me the
  // VAT settlement voucher" or "which depreciation was booked" got a validation
  // rejection from this server rather than an answer.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
  const raw = readFileSync(join(repo, "spec", "reai-openapi.json"), "utf8");

  const match = /"enum"\s*:\s*\[([^\]]{0,900})\]/g;
  let declared = null;
  for (const m of raw.matchAll(match)) {
    if (m[1].includes("OPENING_BALANCE") && m[1].includes("MANUAL")) {
      declared = m[1].split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
      break;
    }
  }
  assert.ok(declared && declared.length > 0, "the spec should declare voucher types");

  const { allTools } = await import("../dist/server.js");
  const tool = allTools.find((t) => t.name === "reai_list_vouchers");
  const accepted = tool.inputSchema.voucherType?._def?.innerType?._def?.values
    ?? tool.inputSchema.voucherType?._def?.values
    ?? [];
  const missing = declared.filter((v) => !accepted.includes(v));
  assert.deepEqual(missing, [], `voucher types the API declares but this tool rejects: ${missing.join(", ")}`);
});

test("the account limit does not exceed the API's silent cap", async () => {
  // The API caps limit at 100 and does so without saying so, which made a larger
  // number look like it worked while truncating the chart of accounts — under a tool
  // that tells the agent every posting must reference an account from this list.
  const { allTools } = await import("../dist/server.js");
  const tool = allTools.find((t) => t.name === "reai_list_accounts");
  const checks = tool.inputSchema.limit?._def?.innerType?._def?.checks
    ?? tool.inputSchema.limit?._def?.checks
    ?? [];
  const max = checks.find((c) => c.kind === "max");
  assert.ok(max, "limit should declare a maximum");
  assert.ok(max.value <= 100, `limit allows ${max.value}, but the API caps at 100`);
});

test("no read tool accepts an input it never sends", async () => {
  // Codex found `filterRestricted` declared on reai_list_accounts and silently
  // dropped, which is worse than not offering it: the tool promised to exclude
  // system-only accounts and did not. This sweeps for the same class across every
  // read tool, so the next one fails here instead of shipping.
  const { allTools } = await import("../dist/server.js");

  // A value the field will actually accept, so the handler behaves normally.
  const sentinelFor = (name, schema) => {
    const def = schema?._def?.innerType?._def ?? schema?._def ?? {};
    if (Array.isArray(def.values) && def.values.length > 0) return def.values[0];
    if (def.typeName === "ZodBoolean") return true;
    if (def.typeName === "ZodNumber") return 4242;
    if (/date/i.test(name)) return "2026-03-04";
    return `SENTINEL_${name}`;
  };

  const dropped = [];
  for (const tool of allTools) {
    if (tool.risk !== "read") continue;
    if (tool.name === "reai_request") continue; // its inputs map to method/path/binary, not a query
    const fields = Object.keys(tool.inputSchema ?? {}).filter((f) => f !== "tenantId");
    if (fields.length === 0) continue;

    const args = {};
    for (const f of fields) args[f] = sentinelFor(f, tool.inputSchema[f]);

    const calls = [];
    const ctx = {
      config: { boundTenantId: undefined, defaultTenantId: 1, writeMode: "full", allowExternalSend: false },
      session: {},
      client: {
        request: async (opts) => {
          calls.push(opts);
          return { status: 200, data: [] };
        },
        deepLink: () => "https://app.reai.no/",
      },
    };

    try {
      await tool.handler(args, ctx);
    } catch {
      continue; // a tool that refuses this combination locally is not the target here
    }
    if (calls.length === 0) continue;

    // A field counts as used if its VALUE or its NAME shows up anywhere in any request
    // the handler made — query, path or body. Some fields legitimately choose an
    // endpoint rather than being forwarded.
    const seen = JSON.stringify(calls);
    const missing = fields.filter((f) => !seen.includes(String(args[f])) && !seen.includes(f));
    if (missing.length > 0) dropped.push(`${tool.name}: ${missing.join(", ")}`);
  }

  assert.deepEqual(dropped, [], `inputs accepted but never sent:\n  ${dropped.join("\n  ")}`);
});

test("constraints the descriptions promise are enforced, and no further", () => {
  // Each was stated in prose and unchecked, so the tool described a guardrail it did
  // not have. Tightening them then over-shot in three places and rejected calls the
  // API accepts — which is the worse failure, so both directions are asserted here.
  const offer = allTools.find((t) => t.name === "reai_create_offer");
  const order = allTools.find((t) => t.name === "reai_create_order");
  const customer = allTools.find((t) => t.name === "reai_create_customer");
  const supplier = allTools.find((t) => t.name === "reai_create_supplier");
  const line = (over) => ({ itemName: "x", quantity: 1, unitPrice: 100, vatCode: "3", ...over });
  const accepts = (schema, value) => schema.safeParse(value).success;

  // Rejected, as the API rejects them.
  assert.equal(accepts(offer.inputSchema.offerLines, [line({ quantity: 1.234 })]), false);
  assert.equal(accepts(offer.inputSchema.offerLines, [line({ unitPrice: 20_000_000 })]), false);
  assert.equal(accepts(customer.inputSchema.name, "x".repeat(76)), false);
  assert.equal(accepts(supplier.inputSchema.name, "x".repeat(76)), false);

  // A fixed 1e-9 epsilon rejected 279796.4, a valid multiple of 0.01, because
  // 279796.4 * 100 drifts about 3.7e-9 from its rounded value.
  for (const quantity of [279_796.4, 1.5, 0.01, 99_999_999.99]) {
    assert.equal(
      accepts(offer.inputSchema.offerLines, [line({ quantity })]),
      true,
      `quantity ${quantity} is a valid multiple of 0.01`,
    );
  }

  // Zero unit price is forbidden on an ORDER line and permitted on an OFFER line —
  // only CreateOrderLineReq documents the restriction. Putting it in the shared base
  // blocked valid free-item and informational quote lines.
  assert.equal(accepts(order.inputSchema.orderLines, [line({ unitPrice: 0 })]), false);
  assert.equal(accepts(offer.inputSchema.offerLines, [line({ unitPrice: 0 })]), true);
  assert.equal(accepts(order.inputSchema.orderLines, [line({ unitPrice: -50 })]), true);

  // CreateCustomerReq declares minLength 0 on purpose: supplying an organizationNumber
  // and letting the Brønnøysund lookup fill the name is the documented flow, and
  // requiring a name removes its only valid representation.
  assert.equal(accepts(customer.inputSchema.name, ""), true);
  assert.equal(accepts(supplier.inputSchema.name, ""), true);
});

