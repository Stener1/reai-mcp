import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertWritableTenant,
  declaredTestTenants,
  PROTECTED_TENANTS,
} from "../scripts/lib/write-guard.mjs";

/**
 * The guard that decides whether a script may write to a ReAI tenant.
 *
 * ## What was wrong
 *
 * Four scripts each carried their own copy of the same check: refuse unless `--tenant` appears in
 * `REAI_WRITE_TEST_TENANTS`. That compares two values the OPERATOR supplies, so it cannot protect anything —
 * set both to the same wrong number and it agrees with the mistake. Which is the incident this repository
 * already had: a full-write test reached tenant 2634, a real business's books.
 *
 * Measured against a local server mimicking `/api/me`, with `REAI_WRITE_TEST_TENANTS=2634 --tenant 2634`, all
 * three runnable write scripts proceeded and attempted `POST /api/customers`, `POST /api/suppliers`,
 * `POST /api/warehouses`, `POST /api/subscriptions` and `POST /api/agreements/rent-agreement`.
 *
 * So there is now a denylist underneath the allowlist, and no environment variable can override it.
 *
 * ## Why these tests call the function instead of grepping for it
 *
 * The lesson from PR #129, where seven bypasses in four review rounds each defeated a better regex over a
 * script's source: a guard asserted by pattern is a guard that can be worded around. The behavioural tests
 * below call `assertWritableTenant` directly, and the coverage test parses each script with the TypeScript
 * compiler and asks whether it CALLS the guard — not whether the string appears somewhere in it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, "..", "scripts");

test("a protected tenant is refused however the environment is set", () => {
  // The incident's exact shape: the operator declares the real tenant and points the run at it.
  assert.throws(
    () => assertWritableTenant(2634, { env: { REAI_WRITE_TEST_TENANTS: "2634" } }),
    /PROTECTED list/,
    "declaring the protected tenant must not make it writable — that is precisely what failed before",
  );
  // And with it merely present alongside the real test tenant, which is how it would be mistyped.
  assert.throws(
    () => assertWritableTenant(2634, { env: { REAI_WRITE_TEST_TENANTS: "2783,2634" } }),
    /PROTECTED list/,
  );
  // Numeric comparison, so whitespace and string/number spelling cannot slip past. A string-equality version
  // of this check would accept " 2634 ".
  for (const spelling of [2634, "2634", " 2634 ", "2634\n"]) {
    assert.throws(
      () => assertWritableTenant(spelling, { env: { REAI_WRITE_TEST_TENANTS: "2634" } }),
      /PROTECTED list/,
      `${JSON.stringify(spelling)} is the protected tenant and must be refused`,
    );
  }
});

test("the protected check runs BEFORE the allowlist, so the error names the real reason", () => {
  // If it ran the other way round, an operator would read "not in REAI_WRITE_TEST_TENANTS" and fix that by
  // adding it — turning a refusal into permission.
  const err = (() => {
    try {
      assertWritableTenant(2634, { env: { REAI_WRITE_TEST_TENANTS: "2783" } });
      return null;
    } catch (e) {
      return e.message;
    }
  })();
  assert.ok(err, "2634 must be refused");
  assert.match(err, /PROTECTED list/);
  assert.doesNotMatch(
    err,
    /is not in REAI_WRITE_TEST_TENANTS/,
    "the message must not suggest that adding it to the allowlist would help",
  );
});

test("no environment variable can override the denylist", () => {
  // Every plausible escape hatch someone might reach for under time pressure.
  for (const env of [
    { REAI_WRITE_TEST_TENANTS: "2634", REAI_ALLOW_PROTECTED_TENANT: "1" },
    { REAI_WRITE_TEST_TENANTS: "2634", REAI_FORCE: "1" },
    { REAI_WRITE_TEST_TENANTS: "2634", REAI_PROTECTED_TENANTS: "" },
    { REAI_WRITE_TEST_TENANTS: "2634", REAI_WRITE_MODE: "full" },
    { REAI_WRITE_TEST_TENANTS: "2634", CI: "true" },
  ]) {
    assert.throws(
      () => assertWritableTenant(2634, { env }),
      /PROTECTED list/,
      `refused regardless of ${Object.keys(env).join(", ")}`,
    );
  }
  // And the module must not read any such variable in the first place.
  const src = readFileSync(path.join(SCRIPTS, "lib/write-guard.mjs"), "utf8");
  const envReads = [...src.matchAll(/env\.([A-Z_]+)/g)].map(([, n]) => n);
  assert.deepEqual(
    [...new Set(envReads)],
    ["REAI_WRITE_TEST_TENANTS"],
    "the guard may read only the allowlist variable; anything else is an override waiting to be used",
  );
});

test("the allowlist still does its job for an unprotected tenant", () => {
  assert.doesNotThrow(() => assertWritableTenant(2783, { env: { REAI_WRITE_TEST_TENANTS: "2783" } }));
  assert.doesNotThrow(() => assertWritableTenant("2783", { env: { REAI_WRITE_TEST_TENANTS: " 2783 , 1581 " } }));
  assert.throws(
    () => assertWritableTenant(2783, { env: { REAI_WRITE_TEST_TENANTS: "1581" } }),
    /not in REAI_WRITE_TEST_TENANTS/,
  );
  assert.throws(() => assertWritableTenant(2783, { env: {} }), /REAI_WRITE_TEST_TENANTS is not set/);
  assert.throws(() => assertWritableTenant("not-a-number", { env: { REAI_WRITE_TEST_TENANTS: "2783" } }), /not a tenant id/);
  assert.deepEqual(declaredTestTenants({ REAI_WRITE_TEST_TENANTS: "2783, 1581 ," }), ["2783", "1581"]);
});

test("the protected list names the tenant this repository must never write to", () => {
  assert.ok(
    PROTECTED_TENANTS.has(2634),
    "2634 is the operator's real company; it is the whole reason this list exists",
  );
});

/**
 * Every script that can issue a non-GET must call the guard.
 *
 * Parsed, not grepped. A new write script that forgets the guard is the realistic way this protection gets
 * lost — not someone deleting it from an existing one.
 */
test("every script that writes calls the guard, checked from the AST", async () => {
  const { default: ts } = await import("typescript");
  const WRITE_VERBS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  // Read-only or non-API scripts. Each is listed with the reason, so adding to this list is a visible choice.
  const EXEMPT = new Map([
    ["audit-quirks.mjs", "read-only by construction: an AST test forbids it issuing anything but GET"],
    ["smoke.mjs", "read-only smoke; asserts refusals rather than performing writes"],
    ["smoke-http.mjs", "exercises the deployed server's OAuth flow, not the ReAI API directly"],
    ["build-spec-index.mjs", "generates spec/index.json from the pinned document"],
    ["check-deployed.mjs", "compares git and Cloud Run metadata"],
    ["discovery-sweep.mjs", "offline ranking sweep"],
    ["storage-census.mjs", "counts claims in source"],
  ]);

  const findings = [];
  for (const file of readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs"))) {
    const full = path.join(SCRIPTS, file);
    const text = readFileSync(full, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);

    let writes = null;
    let callsGuard = false;
    const walk = (n) => {
      // `{ method: "POST" }` on a request, and `call("POST", …)` — the helper these scripts actually use.
      if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "method" && ts.isStringLiteral(n.initializer)) {
        if (WRITE_VERBS.has(n.initializer.text.toUpperCase())) writes ??= `method: "${n.initializer.text}"`;
      }
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(sf);
        if (callee === "requireWritableTenant" || callee === "assertWritableTenant") callsGuard = true;
        const first = n.arguments[0];
        if (first && ts.isStringLiteral(first) && WRITE_VERBS.has(first.text.toUpperCase())) {
          writes ??= `${callee}("${first.text}", …)`;
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);

    if (!writes) continue;
    if (EXEMPT.has(file)) {
      // An exemption must stay honest: a known writing script may never appear on this list, whatever reason
      // is written next to it.
      assert.ok(
        !/^(smoke-write|smoke-full-write|audit-storage|audit-messages)\.mjs$/.test(file),
        `${file} is exempt but is one of the known writing scripts`,
      );
      continue;
    }
    if (!callsGuard) findings.push(`${file} can issue a write (${writes}) but never calls the tenant guard`);
  }

  assert.deepEqual(findings, [], findings.join("\n"));
});

test("the four known writing scripts each call the guard exactly once, at the top level", async () => {
  const { default: ts } = await import("typescript");
  for (const file of ["smoke-write.mjs", "smoke-full-write.mjs", "audit-storage.mjs", "audit-messages.mjs"]) {
    const text = readFileSync(path.join(SCRIPTS, file), "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    // Top level, so it cannot end up inside a branch that a later edit stops taking.
    const topLevelCalls = sf.statements.filter(
      (st) =>
        ts.isExpressionStatement(st) &&
        ts.isCallExpression(st.expression) &&
        st.expression.expression.getText(sf) === "requireWritableTenant",
    );
    assert.equal(
      topLevelCalls.length,
      1,
      `${file} must call requireWritableTenant exactly once at the top level, found ${topLevelCalls.length}`,
    );
    // And it must be reached before anything can write: no non-GET request may appear earlier in the file.
    const guardPos = topLevelCalls[0].getStart(sf);
    const earlierWrite = [...text.slice(0, guardPos).matchAll(/method:\s*"(POST|PUT|PATCH|DELETE)"/g)];
    assert.deepEqual(
      earlierWrite.map(([m]) => m),
      [],
      `${file} has a write-shaped request before the guard runs`,
    );
  }
});
