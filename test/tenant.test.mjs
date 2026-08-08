import { test } from "node:test";
import { ReaiClient } from "../dist/reai/client.js";
import assert from "node:assert/strict";
import { resolveTenantId, requireTenantId } from "../dist/tools/registry.js";

/**
 * The consent page tells the user "pick the company this connection should use".
 * These tests exist because that was originally only a *default*: a tool could
 * pass any tenantId the underlying ReAI token happened to unlock, which for an
 * accountant's token means every client company they have access to.
 */

function ctx({ boundTenantId, defaultTenantId, activeTenantId } = {}) {
  return {
    config: { boundTenantId, defaultTenantId },
    session: activeTenantId !== undefined ? { activeTenantId } : {},
    client: {},
  };
}

test("without a bound tenant, explicit beats session beats default", () => {
  assert.equal(resolveTenantId(1, ctx({ activeTenantId: 2, defaultTenantId: 3 })), 1);
  assert.equal(resolveTenantId(undefined, ctx({ activeTenantId: 2, defaultTenantId: 3 })), 2);
  assert.equal(resolveTenantId(undefined, ctx({ defaultTenantId: 3 })), 3);
  assert.equal(resolveTenantId(undefined, ctx()), undefined);
});

test("a bound tenant is used when nothing is requested", () => {
  assert.equal(resolveTenantId(undefined, ctx({ boundTenantId: 4711 })), 4711);
  assert.equal(requireTenantId(undefined, ctx({ boundTenantId: 4711 })), 4711);
});

test("a bound tenant permits an explicit request for the same tenant", () => {
  assert.equal(resolveTenantId(4711, ctx({ boundTenantId: 4711 })), 4711);
});

test("a bound tenant rejects any other tenant rather than silently redirecting", () => {
  assert.throws(
    () => resolveTenantId(5002, ctx({ boundTenantId: 4711 })),
    /bound to tenant 4711.*cannot address tenant 5002/s,
  );
  // Including one smuggled in through the session rather than an argument.
  assert.throws(
    () => resolveTenantId(undefined, ctx({ boundTenantId: 4711, activeTenantId: 5002 })),
    /bound to tenant 4711/,
  );
});

test("the rejection explains that re-authorization is the way out", () => {
  try {
    resolveTenantId(5002, ctx({ boundTenantId: 4711 }));
    assert.fail("expected a throw");
  } catch (err) {
    assert.match(err.message, /re-authorize/i);
  }
});

test("requireTenantId still explains itself when no tenant is available at all", () => {
  assert.throws(() => requireTenantId(undefined, ctx()), /No tenant selected/);
});

/**
 * The other half of the boundary: `reai_request` can name a tenant in places
 * `resolveTenantId` never sees. It governs one thing — the X-Tenant-Id header — while the
 * path, the query and the body are all just strings the caller chose.
 *
 * The gate that reads them used to consult the OpenAPI spec first and give up when the
 * spec had nothing to say, which left three holes, each reachable through `reai_request`:
 * an unresolvable path checked nothing at all, an undeclared query parameter was
 * invisible on a resolved path, and the body was never read.
 *
 * Measured against the live API on 2026-08-08, none of the three currently reaches
 * another company's books: `tenantId`, `tenant_id`, `tenant` and `companyId` in the query
 * are ignored, a body tenant id is ignored, and a duplicate X-Tenant-Id does not displace
 * the first. That is upstream behaviour nobody here controls or gets told about when it
 * changes, and this gate is what the consent page promises a user. So it fails closed on
 * the request instead.
 *
 * Re-probed the same day on `GET /api/company-banks`, which discriminates cleanly — tenant 2634
 * holds three company banks and 2783 holds none — so an accidental crossing is visible rather
 * than inferred. Bound to 2783, every spelling stayed at zero rows:
 *
 *   ?tenantId=2634 / ?tenant=2634 / ?clientTenantId=2634   200, rows=0  (ignored)
 *   ;tenantId=2634  (matrix parameter)                     400          (rejected outright)
 *   /api/company-banks/2634                                404 "Company bank not found"
 *                                                                       (read as a RECORD id)
 *   Tenant-Id: 2634 / X-Tenant: 2634                       200, rows=0  (only X-Tenant-Id binds)
 *   X-Tenant-Id: 2634                                      200, rows=3  (the control)
 *
 * The path result is why the spec is consulted for path parameters and nowhere else: upstream reads
 * a trailing number as a record id, so a scan that refused every tenant-shaped path segment would
 * refuse `/api/customers/2634` — an ordinary call. The boundary can only know which segment names a
 * company by being told, which is what the spec does.
 */
async function requestWithBound(args, boundTenantId = 4711) {
  const { registeredTools } = await import("../dist/server.js");
  const tool = registeredTools.find((t) => t.name === "reai_request");
  assert.ok(tool, "reai_request should exist");

  const sent = [];
  const ctxObj = {
    config: {
      boundTenantId,
      defaultTenantId: boundTenantId,
      writeMode: "full",
      allowExternalSend: false,
      baseUrl: "https://app.reai.no",
    },
    session: {},
    client: {
      request: async (opts) => {
        sent.push(opts);
        return { status: 200, data: { ok: true } };
      },
      deepLink: () => "https://app.reai.no/",
    },
  };
  const res = await tool.handler(args, ctxObj);
  const text = (res.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return { text, sent };
}

test("a bound connection refuses another tenant named in the body", async () => {
  const { text, sent } = await requestWithBound({
    method: "POST",
    path: "/api/departments",
    body: { name: "Smuggled", tenantId: 5002 },
  });
  assert.match(text, /bound to tenant 4711/);
  assert.match(text, /5002/);
  assert.deepEqual(sent, [], "the request was sent anyway");
});

test("the body is read at depth, and through an array", async () => {
  for (const body of [
    { wrapper: { inner: { tenantId: 5002 } } },
    [{ tenantId: 5002 }],
    { rows: [{ ok: 1 }, { clientTenantId: 5002 }] },
    // A `tenant` key may carry the whole Tenant object rather than its id.
    { tenant: { id: 5002, companyName: "Other" } },
    // Strings count: JSON from a caller that stringifies its ids.
    { tenantId: "5002" },
  ]) {
    const { text, sent } = await requestWithBound({ method: "POST", path: "/api/departments", body });
    assert.match(text, /bound to tenant 4711/, `not refused: ${JSON.stringify(body)}`);
    assert.deepEqual(sent, [], `sent anyway: ${JSON.stringify(body)}`);
  }
});

test("an undeclared query parameter is refused even on a path the spec knows", async () => {
  // GET /api/vouchers declares startDate, endDate, voucherType, registeredBy and
  // includeReversed -- and no tenant parameter at all, which is why the spec-driven
  // version could not see this.
  const { text, sent } = await requestWithBound({
    method: "GET",
    path: "/api/vouchers",
    query: { startDate: "2026-01-01", endDate: "2026-08-08", tenantId: 5002 },
  });
  assert.match(text, /bound to tenant 4711/);
  assert.deepEqual(sent, []);
});

test("a path the spec cannot resolve is still checked", async () => {
  const { text, sent } = await requestWithBound({
    method: "POST",
    path: "/api/not-a-real-endpoint",
    query: { tenant_id: 5002 },
  });
  assert.match(text, /bound to tenant 4711/);
  assert.deepEqual(sent, []);
});

test("the boundary is not keyed on risk: a read across it is refused too", async () => {
  const { text, sent } = await requestWithBound({
    method: "GET",
    path: "/api/accountant-clients/5002",
  });
  assert.match(text, /bound to tenant 4711/);
  assert.deepEqual(sent, [], "a cross-tenant read is the disclosure the boundary prevents");
});

test("the narrow key vocabulary does not refuse an ordinary write", async () => {
  // Every one of these is a real field in the spec whose value can be all digits, and a
  // plain /tenant/i rule would have read each as a tenant id and refused the write.
  const innocent = {
    tenantNoticeMonths: 3,
    tenantPhone: "12345678",
    enkOwnerPersonIdentifierOnTenant: "01019012345",
    tenantBirthDate: "19800101",
    tenantName: "Whoever",
    // A different id space entirely: Tenant itself has a companyId, and customers and
    // suppliers carry one for a counterparty.
    companyId: 5002,
    // And the bound tenant echoed back by a read-modify-write is not a violation.
    tenantId: 4711,
  };
  const { text, sent } = await requestWithBound({
    method: "POST",
    path: "/api/agreements",
    body: innocent,
  });
  assert.doesNotMatch(text, /bound to tenant/, "an innocent body was refused");
  assert.equal(sent.length, 1, "the request should have been sent");
});

/**
 * The spellings that got through the first version. Every one was demonstrated end to end — the
 * request reached `client.request` — before it was fixed, and all four classes came from Codex's
 * review of #93 rather than from this file's imagination.
 *
 * The unifying mistake was reading the request the way JavaScript reads it instead of the way the
 * upstream Java reads it. `/^\d+$/` is not "is this a number", the query schema permits arrays that
 * `buildUrl` comma-joins back into exactly the scalar it was avoiding, and a depth limit on a
 * boundary check is an instruction to add one more wrapper.
 */
test("a tenant id is caught however it is spelled", async () => {
  const deep = (() => {
    let node = { tenantId: 5002 };
    for (let i = 0; i < 10; i++) node = { nest: node };
    return node;
  })();

  const cases = [
    // buildUrl comma-joins a query array, so [5002] is transmitted as exactly tenantId=5002.
    ["single-element query array", { method: "GET", path: "/api/vouchers", query: { tenantId: [5002] } }],
    ["array in the body", { method: "POST", path: "/api/departments", body: { tenantId: [5002] } }],
    // Java's Integer.parseInt accepts a leading plus, and a container trims.
    ["a leading plus", { method: "GET", path: "/api/vouchers", query: { tenantId: "+5002" } }],
    ["surrounding whitespace", { method: "GET", path: "/api/vouchers", query: { tenantId: " 5002 " } }],
    // Arabic-Indic digits. parseInt accepts any Unicode decimal digit; rather than reimplement that,
    // an all-decimal-digit string that is not ASCII is refused whatever it turns out to mean.
    ["non-ASCII decimal digits", { method: "GET", path: "/api/vouchers", query: { tenantId: "\u0665\u0660\u0660\u0662" } }],
    // Ten levels down, where the old ceiling of eight stopped looking.
    ["deeper than the old depth limit", { method: "POST", path: "/api/departments", body: deep }],
    // A matrix parameter, which the rest of the handler already normalises through routedPathForms.
    ["a matrix-parameter path form", { method: "GET", path: "/api/accountant-clients;v=1/5002" }],
  ];

  for (const [label, args] of cases) {
    const { text, sent } = await requestWithBound(args);
    assert.match(text, /bound to tenant 4711/, `not refused: ${label}`);
    assert.deepEqual(sent, [], `sent anyway: ${label}`);
  }
});

test("the spelling rules do not refuse an ordinary value", async () => {
  // The mirror of the test above: each of these could be mistaken for a tenant id by a looser rule.
  // A negative or zero id addresses no company, a decimal is not an integer the API would accept, and
  // the bound tenant echoed back in any spelling is not a violation.
  for (const query of [
    { startDate: "2026-01-01", endDate: "2026-08-08", tenantId: -5002 },
    { startDate: "2026-01-01", endDate: "2026-08-08", tenantId: 0 },
    { startDate: "2026-01-01", endDate: "2026-08-08", tenantId: "+4711" },
    { startDate: "2026-01-01", endDate: "2026-08-08", tenantId: [4711] },
    { startDate: "2026-01-01", endDate: "2026-08-08", tenantId: "not-a-number" },
  ]) {
    const { text, sent } = await requestWithBound({ method: "GET", path: "/api/vouchers", query });
    assert.doesNotMatch(text, /bound to tenant 4711, and this request names/, `refused: ${JSON.stringify(query)}`);
    assert.equal(sent.length, 1, `not sent: ${JSON.stringify(query)}`);
  }
});

/**
 * The boundary's last line of defence, which nothing pinned.
 *
 * `resolveTenantId` decides WHICH tenant and `reai_request` refuses a request that names another —
 * but both are upstream of one line in ReaiClient.request, which spread `opts.headers` into the
 * header object and assigned `X-Tenant-Id` afterwards. The bound tenant won only because that
 * assignment came second. Move the spread after it and a caller's header wins: measured, 859 tests
 * passed with the two lines swapped.
 *
 * The wire behaviour, measured through the real pre-fix build against a local server rather than
 * reasoned about — and the first version of this comment got it wrong twice, which is why it is
 * spelled out:
 *
 *   - Object keys are case-SENSITIVE, header names are not, so `{"x-tenant-id": "2634"}` did not
 *     collide with the `X-Tenant-Id` set below it. Both keys existed. But undici does not send two
 *     headers: building `Headers` from a record APPENDS, which comma-folds. What actually went out
 *     was a single `x-tenant-id: 2634, 2783` — caller's value first.
 *   - Upstream answers 400 to that, and the first version of this comment recorded the reason as
 *     "a duplicate is rejected". It is not. The message is `X-Tenant-Id header must be a valid
 *     integer`: the FOLDED value fails an integer parse. Sent as two genuine header lines, upstream
 *     honours the FIRST — 200, with the caller's company's data. Which is what line 74 above has
 *     said all along.
 *
 * So the pre-fix code failed closed only because of how undici flattens a record. Swap in a Headers
 * instance, an array of pairs, or an HTTP/2 path that emits separate lines, and the same code
 * crosses tenants with a 200. That is too much load for an implementation detail of the fetch stack
 * to carry, so the client now refuses the header instead of racing it.
 */
function clientCapturingHeaders(defaultTenantId = 2783) {
  const sent = [];
  const client = new ReaiClient({
    token: "t",
    defaultTenantId,
    fetchImpl: async (_url, init) => {
      sent.push(init?.headers ?? {});
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return { client, sent };
}

/**
 * What the WIRE sees, not what the object holds. The first version of these tests read
 * `init.headers` directly, so they inspected the pre-fetch record and could not have observed the
 * fold that the comment above is about — the misdiagnosis was invisible to the tests placed under
 * it. `new Headers(...)` applies the same normalisation undici does.
 */
const onTheWire = (headers, name) => new Headers(headers).get(name);

test("the client refuses a caller-supplied tenant header rather than dropping it", async () => {
  const { client, sent } = clientCapturingHeaders(2783);
  await assert.rejects(
    () => client.request({ method: "GET", path: "/api/company-banks", headers: { "X-Tenant-Id": "2634" } }),
    /tenant is a boundary, not a header/,
  );
  // Refused before anything was sent, in either spelling.
  await assert.rejects(
    () => client.request({ method: "GET", path: "/api/company-banks", headers: { "x-tenant-id": "2634" } }),
    /cannot be supplied by a caller/,
  );
  assert.deepEqual(sent, [], "nothing should reach fetch");
});

test("and the same for the two other headers this client owns", async () => {
  const { client, sent } = clientCapturingHeaders(2783);
  // Substituting the bearer token is a larger break than redirecting one request, and it sat
  // unprotected one line above the tenant header while that one was being fixed.
  await assert.rejects(
    () => client.request({ method: "GET", path: "/api/customers", headers: { Authorization: "Bearer other" } }),
    /token comes from the client's configuration/,
  );
  // content-type had the identical case-collision bug: a caller's `content-type: text/plain` with a
  // JSON body folded to `text/plain, application/json`.
  await assert.rejects(
    () => client.request({ method: "POST", path: "/api/customers", body: { name: "x" }, headers: { "content-type": "text/plain" } }),
    /follows from the body being JSON or multipart/,
  );
  assert.deepEqual(sent, [], "nothing should reach fetch");
});

test("one tenant header reaches the wire, and every other caller header survives", async () => {
  const { client, sent } = clientCapturingHeaders(2783);
  await client.request({
    method: "GET",
    path: "/api/company-banks",
    headers: { "X-Request-Extra": "kept", "X-Another": "also kept" },
  });
  assert.equal(onTheWire(sent[0], "x-tenant-id"), "2783", "exactly the bound tenant, unfolded");
  assert.equal(onTheWire(sent[0], "x-request-extra"), "kept");
  assert.equal(onTheWire(sent[0], "x-another"), "also kept");
  assert.equal(onTheWire(sent[0], "authorization"), "Bearer t");
});

test("omitTenant still sends no tenant header at all", async () => {
  // The reference-data endpoints get that property from `omitTenant`, not from a header, and this
  // is the case where the old code would have sent a caller's header alone with nothing to override
  // it — the one behaviour change here, and it is in the safe direction.
  const { client, sent } = clientCapturingHeaders(2783);
  await client.request({ method: "GET", path: "/api/me", omitTenant: true });
  assert.equal(onTheWire(sent[0], "x-tenant-id"), null);
});
