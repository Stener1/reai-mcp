import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveOperation, missingRequired, findOperation, getSpecIndex, describeOperation } from "../dist/reai/spec.js";
import { allTools, registeredTools } from "../dist/server.js";
import { ok } from "../dist/tools/registry.js";

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
  for (const tool of registeredTools) {
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

/** Read-tool inputs that legitimately never reach the API. See the filter below. */
const SHAPES_THE_RESPONSE = {
  "reai_get_employee: includePersonalData":
    "returns the national identity number and bank account instead of redacting them; proven by " +
    "the redaction test in test/organisation.test.mjs",
};

// The exemption map says each entry "owes a test proving the field actually changes the
// output". That was a comment, and a comment is not a link: if redact() were deleted
// tomorrow, includePersonalData becomes a genuinely dropped input and the sweep below —
// the only mechanical guard against that class of bug — would stay green. So check the
// entries are real and that the test they name exists and exercises the field.
test("every response-shaping exemption names a real field and a real test", async () => {
  const { readFileSync } = await import("node:fs");
  const { registeredTools } = await import("../dist/server.js");
  for (const [entry, reason] of Object.entries(SHAPES_THE_RESPONSE)) {
    const [toolName, field] = entry.split(": ");
    const tool = registeredTools.find((t) => t.name === toolName);
    assert.ok(tool, `exemption names an unknown tool: ${toolName}`);
    assert.ok(tool.inputSchema?.[field], `${toolName} has no input called ${field}`);

    const named = /test\/([\w.-]+\.mjs)/.exec(reason);
    assert.ok(named, `exemption for ${entry} must name the test file that proves it`);
    const proof = readFileSync(new URL(`./${named[1]}`, import.meta.url), "utf8");
    assert.ok(proof.includes(field), `${named[1]} never mentions ${field}`);
    // And that test has to actually run the tool both ways, or it proves nothing.
    assert.ok(
      proof.includes(`${field}: true`) || proof.includes(`${field}:true`),
      `${named[1]} never exercises ${field} being set`,
    );
  }
});

test("no read tool accepts an input it never sends", async () => {
  // Codex found `filterRestricted` declared on reai_list_accounts and silently
  // dropped, which is worse than not offering it: the tool promised to exclude
  // system-only accounts and did not. This sweeps for the same class across every
  // read tool, so the next one fails here instead of shipping.

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
  for (const tool of registeredTools) {
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
    const missing = fields
      .filter((f) => !seen.includes(String(args[f])) && !seen.includes(f))
      // ...or if it shapes the RESPONSE instead of the request, which is a real thing a
      // read tool can do and not the failure this sweeps for. Listed one by one with the
      // reason, and each entry owes a test proving the field actually changes the output —
      // an exemption without one is the same silent drop wearing a comment.
      .filter((f) => SHAPES_THE_RESPONSE[`${tool.name}: ${f}`] === undefined);
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

  // This used to assert the opposite — that an empty name is VALID — reasoning from
  // CreateCustomerReq declaring minLength 0, and that supplying an organizationNumber
  // and letting the Brønnøysund lookup fill the name is the documented flow. The live
  // API disagrees on both counts:
  //
  //   POST /api/customers {"name": ""}                          -> 400 "name is required"
  //   POST /api/customers {"name": "   "}                       -> 400 "name is required"
  //   POST /api/customers {"name": "", organizationNumber: ...} -> 400 "name is required"
  //
  // The third case is the one that settles it: the lookup does not fill an omitted name.
  assert.equal(accepts(customer.inputSchema.name, ""), false);
  assert.equal(accepts(supplier.inputSchema.name, ""), false);
  assert.equal(accepts(customer.inputSchema.name, "   "), false);
  // ...while a real name of course still passes, in both directions of this test.
  assert.equal(accepts(customer.inputSchema.name, "Acme AS"), true);
});


test("a truncated result never contains a partial value", async () => {
  // Cutting the serialised body at a byte offset splits tokens: on a ledger-shaped
  // object the 24000-character cut landed on `"closingBalanc`, and across a range of
  // cut positions 61% fell mid-token. A partial NUMBER is the dangerous one —
  // `"closingBalance": 481` where the figure was 4812.60 reads as finished, and a
  // note above it does not undo that.
  const { ok } = await import("../dist/tools/registry.js");

  // An array is cut at an item boundary and re-serialised, so it stays valid JSON.
  const rows = Array.from({ length: 4000 }, (_, i) => ({
    id: i,
    accountNumber: "1920",
    closingBalance: 4812.6,
    note: "x".repeat(20),
  }));
  const arrayText = ok(rows).content[0].text;
  const jsonPart = arrayText.slice(arrayText.indexOf("["));
  const parsed = JSON.parse(jsonPart); // throws if truncation broke the structure
  assert.ok(parsed.length > 0 && parsed.length < rows.length, "should show some but not all");
  for (const row of parsed) {
    assert.equal(row.closingBalance, 4812.6, "every value shown must be whole");
  }
  assert.match(arrayText, /showing the first \d+ of 4000 items/);

  // And the truncated body must respect the cap it claims to enforce. Summing
  // stringify(item) undercounted — it omits the indentation and commas array
  // serialization adds, and returns string values unquoted — so a "truncated"
  // response came out LARGER than the limit: 29216 characters for these 4000 objects,
  // and 60165 for a list of 10000 empty strings.
  assert.ok(
    arrayText.length <= 24_000,
    `truncated result is ${arrayText.length} characters, over the cap it claims`,
  );
  for (const pathological of [
    Array.from({ length: 10_000 }, () => ""),
    Array.from({ length: 5_000 }, () => "\t\t\t"),
  ]) {
    const out = ok(pathological).content[0].text;
    assert.ok(out.length <= 24_000, `pathological array produced ${out.length} characters`);
  }

  // A single item bigger than the whole budget must say so rather than returning an
  // empty array under a note about "the first 0 items".
  const oversized = ok([{ id: 1, blob: "x".repeat(50_000) }]).content[0].text;
  assert.match(oversized, /FIRST of 1 item\(s\) alone exceeds/);

  // A non-array is cut back to a line boundary, so no token is split.
  const ledger = {
    accounts: Array.from({ length: 2000 }, (_, i) => ({
      accountNumber: String(1000 + i),
      closingBalance: 4812.6,
    })),
    totalAmount: 98765.43,
  };
  const objectText = ok(ledger).content[0].text;
  // This used to assert the body was NOT valid JSON, and that the caller was told so.
  // That was the best the line-boundary rule could offer: it kept scalars whole but cut
  // the array inside the object mid-item. An object whose bulk is in its arrays is now
  // truncated by SHORTENING those arrays, so the result parses and every item in it is
  // complete — a strictly stronger guarantee, so the assertion moved up rather than out.
  const objectBody = objectText.slice(objectText.indexOf("{"));
  const objectParsed = JSON.parse(objectBody);
  assert.equal(objectParsed.totalAmount, 98765.43, "scalars after a trimmed list must survive");
  assert.ok(objectParsed.accounts.length > 0 && objectParsed.accounts.length < 2000);
  for (const account of objectParsed.accounts) {
    assert.equal(account.closingBalance, 4812.6, "every value shown must be whole");
    assert.equal(Object.keys(account).length, 2, "an item was cut short");
  }
  assert.match(objectText, /accounts shows \d+ of 2000/);
  assert.ok(objectText.length <= 24_000, `object result is ${objectText.length} characters`);

  // Small results are untouched.
  const small = ok([{ id: 1, closingBalance: 4812.6 }]).content[0].text;
  assert.doesNotMatch(small, /truncated/);
  assert.deepEqual(JSON.parse(small), [{ id: 1, closingBalance: 4812.6 }]);
});

// The array path was fixed once already; these are the residual cases. `stringify`
// returns a plain string unindented and unquoted, so there was no newline to cut back
// to and the whole body was discarded — a 40,000-character response came back as the
// NOTE alone, whose text ("it stops at a line boundary, so no value shown is partial")
// describes a prefix that was not there.
test("truncating a long plain-text response keeps the text", () => {
  const text = ok("x".repeat(40000)).content[0].text;
  assert.match(text, /text truncated/);
  assert.ok(text.includes("x".repeat(1000)), "the prefix itself must survive");
  assert.match(text, /ends mid-text/, "a text prefix IS partial and must say so");
});

// One oversized field early in an object — a base64 attachment, a long description —
// pushed the first line boundary past the cut, leaving a lone "{" under a note that
// invited the reader to treat it as a partial record.
test("an object whose first field is oversized reports that nothing fits", () => {
  const text = ok({ blob: "A".repeat(40000), id: 7 }).content[0].text;
  assert.match(text, /nothing is shown/);
  assert.ok(!/\bfields after the cut are\b/.test(text), "must not imply a partial record is shown");
  assert.ok(text.length < 1000, `expected a short explanation, got ${text.length} chars`);
});

test("a response under the limit is untouched", () => {
  const text = ok({ id: 1, name: "ok" }).content[0].text;
  assert.equal(text, '{\n  "id": 1,\n  "name": "ok"\n}');
});

// Required query parameters were compared case-INSENSITIVELY, on the stated grounds
// that "ReAI is a .NET API and binding is case-insensitive by ASP.NET Core default".
// The backend is Spring, and it is not. Measured against the live API on tenant 2634:
//
//   GET /api/vouchers?voucherType=SALARY  ->  0 rows   (filter applied)
//   GET /api/vouchers?VoucherType=SALARY  -> 38 rows   (silently ignored)
//
// So the preflight told an agent its request was complete while the parameter did
// nothing — the worst shape for a preflight, because the call then returns a
// confidently wrong ANSWER rather than an error.
test("a mis-cased required query parameter is reported, and the near-miss is named", () => {
  const index = getSpecIndex();
  const op = index.operations.find((o) => o.method === "GET" && o.path === "/api/timesheets");
  assert.ok(op, "expected /api/timesheets in the index");

  const right = missingRequired(op, { projectId: 7, startDate: "2026-01-01", endDate: "2026-01-31" }, undefined);
  assert.deepEqual(right.params, [], "correctly cased parameters must satisfy the check");

  const wrong = missingRequired(op, { ProjectId: 7, startDate: "2026-01-01", endDate: "2026-01-31" }, undefined);
  assert.equal(wrong.params.length, 1);
  assert.match(wrong.params[0], /^projectId/, "must name the parameter the API wants");
  assert.match(wrong.params[0], /ProjectId/, "must quote what was actually sent");
  assert.match(wrong.params[0], /case-sensitive/, "must say why it did not bind");
});

// A nested object whose bulk is in its arrays was cut at a line boundary, under a note
// claiming "no value shown is partial" — while the arrays inside it were cut mid-item
// and later fields vanished with no field-level signal. Measured on a real bank
// reconciliation shape: 200 pending transactions became 91 whole ones plus a fragment,
// with pendingPostings and matchedGroups gone entirely and the result not valid JSON.
//
// That is a wrong ANSWER, not just an ugly one: an agent asking "what still needs
// reconciling" saw unmatched transactions and no unmatched postings, would conclude
// there was nothing on the ledger side to match against, and would reach for the
// booking tool — which posts — instead of the matching one.
test("a nested object is truncated by shortening its lists, not by cutting text", () => {
  const tx = (i) => ({
    id: i,
    date: "2026-07-15",
    amount: -1234.56 + i,
    description: `Faktura fra leverandør AS nr ${i}`,
    reference: `KID${String(i).padStart(12, "0")}`,
    archived: false,
    matchedGroupId: null,
    bankAccountId: 1338,
  });
  const posting = (i) => ({
    id: 9000 + i,
    voucherId: 500 + i,
    account: "1920",
    amount: 1234.56 + i,
    date: "2026-07-15",
    description: `Bankpostering ${i}`,
    vatCode: null,
  });
  const payload = {
    bankAccountId: 1338,
    month: "2026-07",
    pendingTransactionCount: 200,
    pendingPostingCount: 40,
    matchedGroupCount: 12,
    openingBalance: 100000,
    closingBalance: 87654.32,
    pendingTransactions: Array.from({ length: 200 }, (_, i) => tx(i)),
    pendingPostings: Array.from({ length: 40 }, (_, i) => posting(i)),
    matchedGroups: Array.from({ length: 12 }, (_, i) => ({ id: i, transactionIds: [i], postingIds: [9000 + i], amount: 1000 + i })),
  };

  const text = ok(payload).content[0].text;
  const [note, ...rest] = text.split("\n\n");
  const body = rest.join("\n\n");

  // Still parseable, which the old branch was not.
  const parsed = JSON.parse(body);

  // No field disappears. This is the whole point: an absent pendingPostings reads as
  // "nothing to match against".
  for (const field of Object.keys(payload)) {
    assert.ok(field in parsed, `${field} vanished from the truncated response`);
  }

  // Every item that IS shown is complete.
  for (const item of parsed.pendingTransactions) {
    assert.equal(Object.keys(item).length, Object.keys(tx(0)).length, "an item was cut short");
  }

  // The smaller lists survive intact rather than being starved by the big one.
  assert.equal(parsed.pendingPostings.length, 40);
  assert.equal(parsed.matchedGroups.length, 12);
  assert.ok(parsed.pendingTransactions.length > 0 && parsed.pendingTransactions.length < 200);

  // The counts are what let an agent detect the shortfall, so they must survive.
  assert.equal(parsed.pendingTransactionCount, 200);
  assert.equal(parsed.pendingPostingCount, 40);

  // And the note says which list was shortened and by how much, rather than claiming
  // nothing is partial.
  assert.match(note, /pendingTransactions shows \d+ of 200/);
  assert.match(note, /still valid JSON/);
  assert.ok(!/no value shown is partial/.test(note));
  assert.ok(text.length <= 24_000, `the whole payload must respect the cap, got ${text.length}`);
});

test("truncation falls back cleanly when shortening lists cannot help", () => {
  // No arrays to shorten, and one oversized scalar.
  assert.match(ok({ blob: "A".repeat(40000), id: 7 }).content[0].text, /nothing is shown/);
  // Arrays exist, but the non-array part alone busts the cap.
  assert.match(ok({ blob: "A".repeat(30000), rows: [{ a: 1 }] }).content[0].text, /nothing is shown/);
  // A bare array still uses the item-boundary path.
  assert.match(
    ok(Array.from({ length: 4000 }, (_, i) => ({ i, v: "x".repeat(40) }))).content[0].text,
    /showing the first \d+ of 4000 items/,
  );
  // Under the cap, untouched.
  assert.equal(ok({ id: 1, name: "ok" }).content[0].text, '{\n  "id": 1,\n  "name": "ok"\n}');
});

// The first version of this helper sampled five items to estimate per-item cost. That
// was wrong in both directions, and Codex found all three consequences on the PR.
test("nested truncation is fast, fair, and counts its own note", () => {
  // A list of five tiny entries followed by 1 KB strings: the sample admitted thousands
  // of items that then had to be removed ONE AT A TIME, re-serialising the whole payload
  // each pass — quadratic, measured at roughly 23 seconds, blocking the event loop.
  const heterogeneous = [...Array(5).fill(""), ...Array.from({ length: 1995 }, () => "x".repeat(1000))];
  const started = Date.now();
  const out = ok({ rows: heterogeneous }).content[0].text;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `truncation took ${elapsed}ms — it must not be quadratic`);
  assert.ok(out.length <= 24_000, `produced ${out.length} characters`);

  // An average inflated by one huge entry could reject a field whose FIRST item fitted,
  // recreating the empty-list outcome the helper exists to prevent.
  const mixed = ok({
    small: ["a"],
    huge: [...Array(3).fill("b"), "z".repeat(20_000)],
    pad: "y".repeat(10_000),
  }).content[0].text;
  const parsed = JSON.parse(mixed.slice(mixed.indexOf("{")));
  assert.deepEqual(parsed.small, ["a"], "a list whose first item fits must not be emptied");

  // The note names every trimmed field, so 1000 short arrays produced a 23.9 KB body
  // under an 18.7 KB note — a "capped" response of 42.6 KB.
  const many = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`field${i}`, ["v".repeat(20)]]));
  const wide = ok(many).content[0].text;
  assert.ok(wide.length <= 24_000, `note plus body came to ${wide.length} characters`);
});

// Money fields on the two irreversible payment tools accepted sub-øre precision, which
// the spec forbids (multipleOf 0.01). isWholeOre existed and was applied to line
// quantities but to no amount field.
test("money amounts must be whole øre", async () => {
  const { allTools } = await import("../dist/server.js");
  const { isWholeOre } = await import("../dist/tools/registry.js");

  const field = (tool, name) => allTools.find((t) => t.name === tool).inputSchema[name];
  // Every field the spec marks multipleOf 0.01 on these two request schemas, including
  // the optional companion amounts — a foreign-currency payment and a bank debit that
  // differs from the invoice are exactly where odd fractions turn up.
  for (const [tool, name] of [
    ["reai_register_invoice_payment", "receivedAmount"],
    ["reai_register_invoice_payment", "paidInvoiceCurrencyAmount"],
    ["reai_register_supplier_invoice_payment", "invoiceAmount"],
    ["reai_register_supplier_invoice_payment", "bankDebitAmount"],
  ]) {
    const schema = field(tool, name);
    assert.equal(schema.safeParse(100).success, true, `${tool}.${name} must accept 100`);
    assert.equal(schema.safeParse(100.55).success, true, `${tool}.${name} must accept 100.55`);
    assert.equal(schema.safeParse(1234.567).success, false, `${tool}.${name} must reject sub-øre`);
  }

  // The exponent guard used to read only the FRACTION, and String(1e-7) is "1e-7" with
  // no decimal point at all — so the fraction came out empty and passed.
  assert.equal(isWholeOre(1e-7), false);
  assert.equal(isWholeOre(1.5e-7), false);
  assert.equal(isWholeOre(1e21), false);
  // And the value that a fixed 1e-9 epsilon wrongly rejected still passes: 279796.4 is
  // a valid multiple of 0.01 even though 279796.4 * 100 is off by ~3.7e-9.
  assert.equal(isWholeOre(279796.4), true);
  assert.equal(isWholeOre(1.005), false);
  assert.equal(isWholeOre(0.01), true);
});

// A quirk recorded against the DELETE said that GET /api/supplier-invoices hides
// reversed invoices — the consequence half — but was scoped so it never surfaced there.
// An agent asking "is invoice 10009 already registered?" through the list got no
// warning, and re-registering posts to the ledger a second time.
test("the list endpoint warns that reversed supplier invoices are hidden", () => {
  const index = getSpecIndex();
  const list = describeOperation(
    index.operations.find((o) => o.method === "GET" && o.path === "/api/supplier-invoices"),
  );
  const notes = (list.quirks ?? []).map((q) => q.note).join(" ");
  assert.match(notes, /NON-REVERSED/i, "the list must warn about hidden reversals");
  assert.match(notes, /absence from this list is not evidence/i);

  // And the DELETE keeps its own note, which is about the outcome string.
  const del = describeOperation(
    index.operations.find((o) => o.method === "DELETE" && o.path === "/api/supplier-invoices/{id}"),
  );
  assert.match((del.quirks ?? []).map((q) => q.note).join(" "), /outcome/i);
});

// Settled by writing to a live tenant, which is the only thing that could settle it: the
// spec states the rule in prose but declares no `minimum`, and a review flagged the local
// guard as possibly over-tight because a Norwegian supplier invoice ordinarily carries a
// negative discount or øre-rounding line. It is not over-tight — the API enforces it per
// line — so the guard stays, and the refusal now says how to express a discount instead.
test("a mixed-sign supplier invoice is refused with a way forward", async () => {
  const { allTools } = await import("../dist/server.js");
  const tool = allTools.find((t) => t.name === "reai_create_supplier_invoice");
  let sent = 0;
  const ctx = {
    client: { request: async () => { sent += 1; return { data: { id: 1 }, status: 201 } }, deepLink: () => "l" },
    config: { writeMode: "full", tenantId: 2783 },
    session: {},
  };
  const line = (amount, description) => ({ amount, debitAccount: "6700", description });
  const args = (costLines) => ({ supplierId: 1, date: "2026-08-07", dueDate: "2026-09-07", costLines, tenantId: 2783 });

  const mixed = await tool.handler(args([line(1000, "Varer"), line(-200, "Rabatt")]), ctx);
  assert.equal(sent, 0, "nothing may be sent for a document the API will reject");
  const text = mixed.content.map((c) => c.text).join("\n");
  assert.match(text, /-200/, "name the offending amount");
  // The part that matters: the caller is told what to do instead.
  assert.match(text, /netting it into the line it discounts/);
  assert.match(text, /documentType="credit_note"/);
  assert.match(text, /API's own rule/, "say whose rule this is, so it is not read as our restriction");

  // An ordinary all-positive invoice still goes through.
  const ok = await tool.handler(args([line(1000, "Varer"), line(250, "Frakt")]), ctx);
  assert.equal(ok.isError, undefined);
  assert.equal(sent, 1);

  // And an all-negative credit note.
  sent = 0;
  const credit = await tool.handler(
    { ...args([line(-1000, "Kreditnota")]), documentType: "credit_note" },
    ctx,
  );
  assert.equal(credit.isError, undefined);
  assert.equal(sent, 1);
});

// Each of these was verified against the live API before being tightened, because the
// spec is wrong in at least one place and guessing has cost this project twice — once by
// leaving a field looser than the API (a wasted round trip and a worse message) and once
// by making one tighter (a legitimate value refused).
test("validation matches what the API actually enforces", async () => {
  const { allTools } = await import("../dist/server.js");
  const field = (tool, name) => allTools.find((t) => t.name === tool)?.inputSchema?.[name];
  const accepts = (tool, name, value) => field(tool, name).safeParse(value).success;

  // POST /api/customers {"name":""} and {"name":"   "} both answer 400 "name is
  // required" — including WITH an organizationNumber, which disproves the claim these
  // tools carried that a Brønnøysund lookup can fill an omitted name.
  for (const [tool, name] of [
    ["reai_create_customer", "name"],
    ["reai_create_supplier", "name"],
    ["reai_create_product", "title"],
    ["reai_create_company_bank", "name"],
  ]) {
    assert.equal(accepts(tool, name, "Acme AS"), true, `${tool}.${name} must accept a real name`);
    assert.equal(accepts(tool, name, ""), false, `${tool}.${name} must reject an empty name`);
    assert.equal(accepts(tool, name, "   "), false, `${tool}.${name} must reject whitespace`);
  }

  // "name must be at most 255 characters", verbatim from the API.
  assert.equal(accepts("reai_create_company_bank", "name", "x".repeat(255)), true);
  assert.equal(accepts("reai_create_company_bank", "name", "x".repeat(256)), false);

  // "must contain only digits" and "must be exactly 11 digits", both from one response.
  const nid = "nationalIdentityNumber";
  assert.equal(accepts("reai_create_customer", nid, "12345678901"), true);
  assert.equal(accepts("reai_create_customer", nid, "abc"), false);
  assert.equal(accepts("reai_create_customer", nid, "1234567890"), false, "ten digits is not eleven");
  assert.equal(accepts("reai_create_customer", nid, "123 45678901"), false, "separators are digits-only failures");
  // Optional, so omitting it stays valid — a refinement next to .optional() is easy to
  // get wrong in the direction that breaks every caller who does not use the field.
  assert.equal(field("reai_create_customer", nid).safeParse(undefined).success, true);
});

// The cap is on what the CALLER receives, and the note is part of that. Three of the
// four truncation branches sized only the body and then prepended the note, so a
// "24,000-character" response arrived at 24,127 / 24,139 / 24,159. Each branch was
// internally consistent; they disagreed with each other, which is what happens when two
// rewrites each define the same constant for themselves. One shared budget now, and
// this asserts it across every branch rather than the one that prompted it.
test("no truncation branch exceeds the cap, note included", () => {
  const cases = {
    "array of objects": Array.from({ length: 4000 }, (_, i) => ({ i, v: "x".repeat(40) })),
    "array of ints": Array.from({ length: 100_000 }, (_, i) => i),
    "array of empty strings": Array.from({ length: 10_000 }, () => ""),
    "plain string": "x".repeat(40_000),
    "object cut at a line boundary": { a: { deep: "y".repeat(40_000) }, b: 1 },
    "object with nested arrays": { rows: Array.from({ length: 5000 }, (_, i) => ({ i, v: "z".repeat(50) })), n: 5000 },
    "many short arrays": Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`f${i}`, ["v".repeat(20)]])),
  };
  for (const [label, value] of Object.entries(cases)) {
    const text = ok(value).content[0].text;
    assert.ok(text.length <= 24_000, `${label}: produced ${text.length} characters against a 24000 cap`);
  }
});

// An empty array is not "nothing shown", it is "no results" — valid JSON that reads as
// an answer. The object branch already returned nothing in this case, for exactly that
// reason; the array branch returned "[]", and its note was the only one omitting the
// total, so three items became "[]" with no mention that three existed.
test("an oversized first item is not reported as an empty result", () => {
  const text = ok([{ blob: "x".repeat(50_000) }, { id: 10 }, { id: 11 }]).content[0].text;
  assert.ok(!/\[\]/.test(text), `must not return an empty array: ${text.slice(0, 200)}`);
  assert.match(text, /of 3 item/, "the note must say how many items there were");
  assert.match(text, /NOT an empty result/i, "and say plainly that this is not emptiness");
});

// The fixed note reserve is a worst case for the NESTED-object note, which names every
// trimmed field. The array note is one sentence, so reserving 1200 characters for it
// threw away headroom — and for an item sized between the reserved budget and the true
// cap it meant discarding the item entirely while claiming it "exceeds the
// 24000-character limit". A 23,026-character item was dropped with 23,769 unused.
test("the array branch sizes against its real note, not a worst-case reserve", () => {
  const big = { blob: "x".repeat(23_000) };
  const text = ok([big, ...Array.from({ length: 50 }, (_, i) => ({ id: i }))]).content[0].text;
  assert.match(text, /showing the first \d+ of 51 items/, `the big item fits and must be shown: ${text.slice(0, 140)}`);
  assert.ok(text.length <= 24_000);
  assert.ok(text.length > 20_000, `should use the available room, used only ${text.length}`);

  // A genuinely oversized item still reports nothing shown, with the total.
  const oversized = ok([{ blob: "x".repeat(50_000) }, { id: 1 }, { id: 2 }]).content[0].text;
  assert.match(oversized, /FIRST of 3 item\(s\) alone exceeds/);
});

// Three samples are not evidence for a bound that is now approached to within four
// characters. This sweeps the shapes that have historically broken it — empty strings,
// tabs, bare ints, wide unicode — and every combination of item size and count.
test("no array shape exceeds the cap", () => {
  const shapes = [];
  for (const len of [0, 1, 3, 7, 17, 40, 113, 500, 2000, 9000, 23_000, 26_000]) {
    for (const count of [1, 2, 3, 10, 57, 500, 4000, 20_000]) {
      // Skip combinations whose raw size dwarfs the cap without testing anything new —
      // 20,000 items of 26,000 characters is half a gigabyte and aborts the runner.
      // Anything past a few times the cap exercises the same branch.
      if (len * count > 4 * 24_000) continue;
      shapes.push(Array.from({ length: count }, (_, i) => ({ i, v: "x".repeat(len) })));
    }
  }
  // ...plus a few deliberately far over the cap, at sizes that stay cheap.
  shapes.push(
    Array.from({ length: 20_000 }, (_, i) => ({ i })),
    Array.from({ length: 4000 }, (_, i) => ({ i, v: "x".repeat(40) })),
    [{ blob: "x".repeat(60_000) }],
  );
  shapes.push(
    Array.from({ length: 10_000 }, () => ""),
    Array.from({ length: 5000 }, () => "\t\t\t"),
    Array.from({ length: 300 }, (_, i) => ({ i, s: "æøå".repeat(200) })),
    [{ a: 1 }],
    [],
  );
  let worst = 0;
  for (const shape of shapes) {
    const length = ok(shape).content[0].text.length;
    worst = Math.max(worst, length);
    assert.ok(length <= 24_000, `an array of ${shape.length} produced ${length} characters`);
  }
  assert.ok(worst > 20_000, `the sweep should approach the cap; worst was only ${worst}`);
});
