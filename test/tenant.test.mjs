import { test } from "node:test";
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
