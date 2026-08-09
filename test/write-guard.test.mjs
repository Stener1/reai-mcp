import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertWritableTenant,
  declaredTestTenants,
  isProtectedTenant,
  protectedTenants,
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
  // The old version of this assertion required the module to read NO environment variable except the
  // allowlist. Review pointed out that forbids the one safe extension — letting a self-hoster ADD their own
  // production tenants — while doing nothing about the hazard, which is removal. The invariant now lives in
  // "env-ADDABLE but never env-REMOVABLE" below, and an argv flag has its own test, because that is the form
  // review actually used to get through.
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

test("the protected list names the tenant this repository must never write to, and cannot be edited", () => {
  assert.ok(isProtectedTenant(2634), "2634 is the operator's real company; it is why this list exists");

  // It used to be an exported Set, and review defeated the entire guard with one line —
  // `PROTECTED_TENANTS.delete(2634)` in a caller, then 41 non-GET requests to 2634 with every test passing.
  // `export const` blocks rebinding, not mutation. The Set is module-private now and this is the only handle.
  const copy = protectedTenants();
  copy.length = 0;
  copy.push(999);
  assert.ok(isProtectedTenant(2634), "mutating the returned array must not change the list");
});

test("the protected list is env-ADDABLE but never env-REMOVABLE", async () => {
  // Review's point, and the right invariant. The previous test asserted the module reads NO environment
  // variable except the allowlist, which forbade the safe extension: a self-hoster inherits a list protecting
  // this repository's operator's company and none of their own. Additions are fine; removals are the hazard.
  const { isProtectedTenant: isProtected } = await import(
    `../scripts/lib/write-guard.mjs?added=${encodeURIComponent("1")}`
  );
  assert.ok(isProtected(2634), "the built-in entry survives a fresh import");

  const src = readFileSync(path.join(SCRIPTS, "lib/write-guard.mjs"), "utf8");
  // Additive only: the env value is fed to `.add`, and nothing in the module deletes or clears.
  assert.match(src, /PROTECTED\.add\(/, "the env list must be additive");
  assert.doesNotMatch(
    src,
    /PROTECTED\.(delete|clear)\(/,
    "nothing in the guard may remove a protected tenant",
  );
});

test("the decision cannot be changed by a command-line flag", () => {
  // "No override flag, deliberately" was asserted in prose and tested only by a source regex over `env.X` —
  // the very pattern this PR argues against. Review added `!process.argv.includes("--force-protected")` to the
  // condition and wrote to 2634 with every test passing. So: the module must not read argv at all, and the
  // decision must not change when argv is full of plausible hatches.
  const src = readFileSync(path.join(SCRIPTS, "lib/write-guard.mjs"), "utf8");
  assert.doesNotMatch(
    src,
    /process\.argv/,
    "the guard must not consult argv: a flag is the override this PR promises not to add",
  );

  const saved = process.argv;
  try {
    process.argv = [...saved, "--force-protected", "--force", "--yes", "--i-know-what-i-am-doing"];
    assert.throws(
      () => assertWritableTenant(2634, { env: { REAI_WRITE_TEST_TENANTS: "2634" } }),
      /PROTECTED list/,
      "no combination of flags may make a protected tenant writable",
    );
  } finally {
    process.argv = saved;
  }
});

test("a non-GET to a protected tenant is refused at the request itself", async () => {
  // The layer that does not depend on reading the caller's source. PR #129 established that source-level checks
  // lose to ordinary indirection — `const VERB = "POST"`, a template literal, a file one directory down — so
  // this fires when the request is actually made.
  const { installProtectedTenantFetchGuard } = await import("../scripts/lib/write-guard.mjs");
  installProtectedTenantFetchGuard();
  // Synchronously, before any promise exists — the refusal should be as early as it can be.
  for (const headers of [{ "X-Tenant-Id": "2634" }, { "x-tenant-id": 2634 }]) {
    assert.throws(
      () => globalThis.fetch("http://127.0.0.1:9/api/customers", { method: "POST", headers }),
      /PROTECTED/,
      `a POST carrying ${JSON.stringify(headers)} must be refused before it is sent`,
    );
  }
  // A GET to the same tenant is the whole point of the read-only audits, and must still reach the socket.
  await assert.rejects(
    () => globalThis.fetch("http://127.0.0.1:9/api/customers", { headers: { "X-Tenant-Id": "2634" } }),
    /ECONNREFUSED|fetch failed|other side closed/,
    "a GET must reach the socket rather than being refused by the guard",
  );
  // And a non-GET to an UNPROTECTED tenant must not be refused by this layer.
  await assert.rejects(
    () => globalThis.fetch("http://127.0.0.1:9/api/customers", { method: "POST", headers: { "X-Tenant-Id": "2783" } }),
    /ECONNREFUSED|fetch failed|other side closed/,
    "the guard must only block protected tenants, or the write audits stop working",
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

  // Curated tools too, not only literal HTTP verbs. These scripts write mostly through
  // `client.callTool({ name: "reai_create_customer", … })`, which carries no `method` property at all — so a
  // new script using only curated tools would have left `writes` null and passed with no guard. The existing
  // ones were detected only incidentally, because they also make raw `reai_request` calls.
  //
  // Derived from each tool's DECLARED risk rather than from its name, so a tool called something unexpected is
  // still classified correctly, and a new write tool is covered the day it is added.
  const WRITING_TOOLS = new Set();
  const { readdirSync: rd } = await import("node:fs");
  for (const file of rd(path.join(HERE, "..", "dist", "tools")).filter((f) => f.endsWith(".js"))) {
    let mod;
    try {
      mod = await import(pathToFileURL(path.join(HERE, "..", "dist", "tools", file)).href);
    } catch {
      continue;
    }
    for (const value of Object.values(mod)) {
      if (!Array.isArray(value)) continue;
      for (const tool of value) {
        if (tool?.name?.startsWith?.("reai_") && tool.risk && tool.risk !== "read") WRITING_TOOLS.add(tool.name);
      }
    }
  }
  assert.ok(
    WRITING_TOOLS.size > 50,
    `expected many writing tools, found ${WRITING_TOOLS.size} — the registry scan has stopped matching`,
  );
  // reai_request takes the verb as an argument, so it is a write whenever that verb is one.
  WRITING_TOOLS.delete("reai_request");
  // Read-only or non-API scripts. Each is listed with the reason, so adding to this list is a visible choice.
  const EXEMPT = new Map([
    ["audit-quirks.mjs", "read-only by construction: an AST test forbids it issuing anything but GET"],
    // Earned by forcing the mode, not by intent. It POSTs to /api/vat-returns,
    // /api/manual-reconciliations/{id}/close, /api/bank-reconciliations/{id}/vouchers and /api/subscriptions
    // expecting refusals; forwarding an ambient REAI_WRITE_MODE=full turned three irreversible ones into real
    // writes with no tenant guard in the file. A separate test below pins the forcing.
    ["smoke.mjs", "spawns the server with REAI_WRITE_MODE forced to read-only, pinned by its own test"],
    ["smoke-http.mjs", "exercises the deployed server's OAuth flow, not the ReAI API directly"],
    ["build-spec-index.mjs", "generates spec/index.json from the pinned document"],
    ["check-deployed.mjs", "compares git and Cloud Run metadata"],
    ["discovery-sweep.mjs", "offline ranking sweep"],
    ["storage-census.mjs", "counts claims in source"],
  ]);

  const findings = [];
  // Recursive. The flat readdir never looked in scripts/lib, and review put a writer there — plain
  // `method: "POST"`, never scanned, all tests green.
  const scriptFiles = [];
  const collect = (dir, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) collect(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".mjs")) scriptFiles.push(`${prefix}${entry.name}`);
    }
  };
  collect(SCRIPTS);
  assert.ok(scriptFiles.length >= 12, `only ${scriptFiles.length} scripts found — the scan has stopped working`);
  assert.ok(scriptFiles.includes("lib/write-guard.mjs"), "the scan must reach scripts/lib, where review put a writer");

  for (const file of scriptFiles) {
    const full = path.join(SCRIPTS, file);
    const text = readFileSync(full, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);

    let writes = null;
    let callsGuard = false;
    const guardCalls = [];
    const walk = (n) => {
      // `{ method: "POST" }` on a request, and `call("POST", …)` — the helper these scripts actually use.
      // Anything not PROVABLY GET. Enumerating write verbs missed `const VERB = "POST"` and a template
      // literal, both of which review used to write to 2634 with every test green. Inverting it means an
      // unrecognised spelling counts as a possible write, which is the safe direction to be wrong in.
      if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "method") {
        const init = n.initializer;
        const provablyGet = ts.isStringLiteral(init) && init.text.toUpperCase() === "GET";
        if (!provablyGet) {
          writes ??= ts.isStringLiteral(init)
            ? `method: "${init.text}"`
            : `method: ${init.getText(sf)} (not a literal, so it could be any verb)`;
        }
      }
      // `opts.method = …` — assignment rather than a property in a literal.
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        /\.method$/.test(n.left.getText(sf))
      ) {
        const provablyGet = ts.isStringLiteral(n.right) && n.right.text.toUpperCase() === "GET";
        if (!provablyGet) writes ??= `${n.left.getText(sf)} = ${n.right.getText(sf)}`;
      }
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(sf);
        if (callee === "requireWritableTenant" || callee === "assertWritableTenant") {
          callsGuard = true;
          guardCalls.push(n);
        }
        const first = n.arguments[0];
        if (first && ts.isStringLiteral(first) && WRITE_VERBS.has(first.text.toUpperCase())) {
          writes ??= `${callee}("${first.text}", …)`;
        }
      }
      // `{ name: "reai_create_customer" }` anywhere — the callTool argument shape.
      if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "name" && ts.isStringLiteral(n.initializer)) {
        if (WRITING_TOOLS.has(n.initializer.text)) writes ??= `callTool ${n.initializer.text}`;
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
    if (!callsGuard) {
      findings.push(`${file} can issue a write (${writes}) but never calls the tenant guard`);
      continue;
    }

    // Reachable, not merely present. A call inside `if (cond)` or in an unused function satisfies
    // "callsGuard" while being skipped at runtime, and the stricter check below used to apply only to the four
    // scripts named by hand — so a NEW script could put the guard behind a condition and pass.
    const topLevel = sf.statements.filter(
      (st) =>
        ts.isExpressionStatement(st) &&
        ts.isCallExpression(st.expression) &&
        ["requireWritableTenant", "assertWritableTenant"].includes(st.expression.expression.getText(sf)),
    );
    if (topLevel.length === 0) {
      findings.push(
        `${file} writes (${writes}) and mentions the guard, but never calls it at the TOP LEVEL — a call ` +
          `inside a branch or an unused function is not a guard`,
      );
      continue;
    }
    // And nothing write-shaped may appear before it.
    const guardPos = topLevel[0].getStart(sf);
    const before = [...text.slice(0, guardPos).matchAll(/method:\s*"(POST|PUT|PATCH|DELETE)"/g)];
    if (before.length > 0) {
      findings.push(`${file} has a write-shaped request before the guard runs (${before[0][0]})`);
    }
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

test("the read-only smoke forces read-only mode rather than forwarding it", () => {
  // Its exemption from the tenant guard rests entirely on this line. With
  // `REAI_WRITE_MODE: process.env.REAI_WRITE_MODE ?? "read-only"`, an ambient `full` in the shell reached the
  // spawned server, and these four became real requests against whatever --tenant said:
  //
  //   POST /api/vat-returns                        irreversible, no transmission gate
  //   POST /api/manual-reconciliations/{id}/close  irreversible, no transmission gate
  //   POST /api/bank-reconciliations/{id}/vouchers irreversible, no transmission gate
  //   POST /api/subscriptions                      reversible
  //
  // (The generate-due paths stay blocked by the external-send gate, which is a separate axis.) Every
  // assertion in that file is written for read-only mode, so forcing it is also what makes them mean anything.
  const src = readFileSync(path.join(SCRIPTS, "smoke.mjs"), "utf8");
  assert.match(
    src,
    /REAI_WRITE_MODE:\s*"read-only"/,
    "smoke.mjs must FORCE read-only for the server it spawns",
  );
  assert.doesNotMatch(
    src,
    /REAI_WRITE_MODE:\s*process\.env\.REAI_WRITE_MODE/,
    "smoke.mjs must not forward an ambient write mode: it has no tenant guard, so full mode reached real books",
  );
});
