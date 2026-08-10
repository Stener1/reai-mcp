/**
 * Make a script structurally incapable of anything but GET.
 *
 * `installProtectedTenantFetchGuard` is NOT this. That one refuses a non-GET only when the request carries a
 * protected `X-Tenant-Id`, which is right for a script addressing a tenant and useless for one that sends no
 * tenant header at all. `scripts/spec-drift.mjs` cited it as its read-only enforcement and review showed the
 * claim was empty: the guard did nothing there, while the exemption it justified caused the AST coverage test to
 * skip the file. A POST added later would have gone out, certified by a reason that was never true.
 *
 * This wrapper is unconditional: any method other than GET throws, whatever headers the request carries.
 *
 * It lives here rather than inline in the script for the reason the self-contained-HTML predicate does — logic
 * inside a script is logic nothing can test. Importing that script to exercise its wrapper is not an option
 * either: its top level calls `process.exit`, which takes the test runner with it.
 */

/**
 * Replace `globalThis.fetch` with a wrapper that refuses any method but GET.
 *
 * Returns the wrapper, so a caller can assert on it. The native function is captured in a closure and not
 * exposed: a later edit cannot name it to route around the check.
 */
export function installGetOnlyFetch(scope = globalThis) {
  const nativeFetch = scope.fetch;
  const guarded = (input, init) => {
    const method = String(init?.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      throw new Error(`This script is GET-only by construction; refusing ${method}.`);
    }
    return nativeFetch(input, init);
  };
  scope.fetch = guarded;
  return guarded;
}
