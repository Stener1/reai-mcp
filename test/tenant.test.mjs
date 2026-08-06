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
