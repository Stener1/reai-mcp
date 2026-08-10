import { test } from "node:test";
import assert from "node:assert/strict";
import { installGetOnlyFetch } from "../scripts/lib/get-only-fetch.mjs";

/**
 * The GET-only wrapper that `scripts/spec-drift.mjs` takes its write-guard exemption on.
 *
 * That exemption previously cited `installProtectedTenantFetchGuard()`, which refuses a non-GET only when the
 * request carries a protected tenant header — and spec-drift sends none. So the stated enforcement was empty
 * while the exemption caused the AST coverage test to skip the file: a POST added later would have gone out,
 * certified by a reason that was never true. Review caught it.
 */
test("the GET-only wrapper refuses every method but GET", async () => {
  const calls = [];
  const scope = { fetch: async (input, init) => { calls.push(init?.method ?? "GET"); return "ok"; } };

  const guarded = installGetOnlyFetch(scope);
  assert.equal(scope.fetch, guarded, "the wrapper must replace fetch on the scope");

  // GET passes, explicitly and by omission, in either case.
  assert.equal(await scope.fetch("https://example.invalid"), "ok");
  assert.equal(await scope.fetch("https://example.invalid", { method: "GET" }), "ok");
  assert.equal(await scope.fetch("https://example.invalid", { method: "get" }), "ok");
  assert.deepEqual(calls, [undefined, "GET", "get"].map((m) => m ?? "GET"));

  // Everything else throws, WHATEVER headers it carries — the distinction from the tenant guard.
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "post", "HEAD"]) {
    assert.throws(
      () => scope.fetch("https://example.invalid", { method, headers: {} }),
      /GET-only/,
      `${method} was not refused`,
    );
    assert.throws(
      () => scope.fetch("https://example.invalid", { method, headers: { "x-tenant-id": "2783" } }),
      /GET-only/,
      `${method} with a tenant header was not refused`,
    );
  }
  // Nothing reached the underlying fetch beyond the three GETs.

  // A Request object carries its own method, and `fetch` honours it. Reading `init?.method` alone let
  // `fetch(new Request(url, { method: "POST" }))` reach the network — measured, before this was fixed.
  for (const method of ["POST", "PUT", "DELETE"]) {
    assert.throws(
      () => scope.fetch(new Request("https://example.invalid", { method })),
      /GET-only/,
      `a Request carrying ${method} was not refused`,
    );
  }
  // A GET Request still passes, and init overrides the Request's method the way fetch does.
  assert.equal(await scope.fetch(new Request("https://example.invalid")), "ok");
  assert.throws(
    () => scope.fetch(new Request("https://example.invalid"), { method: "POST" }),
    /GET-only/,
    "init.method must be honoured over a GET Request",
  );
  // An object that merely has a `method`-like property must not confuse it into allowing a write.
  assert.throws(() => scope.fetch({ method: "delete" }), /GET-only/, "a lowercase method on the input passed");
  assert.equal(calls.length, 4, `the wrapper let ${calls.length - 4} unexpected call(s) through`);

  // The native function must not be reachable from the wrapper's surface.
  assert.equal(Object.keys(guarded).length, 0, "the wrapper exposes properties a later edit could use to bypass it");
});
