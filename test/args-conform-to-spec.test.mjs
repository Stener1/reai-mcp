import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { findOperation } from "../dist/reai/spec.js";
import { allTools } from "../dist/server.js";
import { uiTools } from "../dist/tools/ui.js";

/**
 * Every argument a curated tool accepts must correspond to something its endpoint declares, or be explicitly
 * declared local by the tool itself.
 *
 * WHY THIS MATTERS, and the first version of the write-up had it backwards: ReAI declares no
 * `additionalProperties: false` anywhere. An argument the endpoint does not know is usually NOT refused — it is
 * silently discarded. `customer-create-fields` records exactly that for `POST /api/customers`, which drops
 * `invoiceEmail`, `phone` and `daysUntilDue` on a 200. So the failure mode is not a loud rejection an agent can
 * react to; it is a caller setting a field, seeing success, and losing the value. That is the class this
 * repository exists to prevent.
 *
 * WHY THE EXEMPTIONS LIVE ON THE TOOLS. A first attempt at this check found 18 arguments the spec does not
 * declare, every one of them correct code, in five patterns. Three are derivable here — path parameters,
 * acknowledgement gates, and the handful of arguments the server consumes structurally. Two are not: a routing
 * discriminator looks like any enum, and a local filter looks like any string. Carrying those in a roster inside
 * this file is the allowlist failure this repo has shipped three times, because a list of what to excuse
 * silently exempts the next case too. So they are declared in `localArgs` on the tool, where the author adding
 * an argument will see the requirement.
 */

/** An optional (or bare) `z.literal(true)` — a confirmation gate. Never sent; its job is to make a caller stop. */
function isAcknowledgementGate(schema) {
  const def = schema?._def;
  const inner = def?.typeName === "ZodOptional" ? def.innerType?._def : def;
  return inner?.typeName === "ZodLiteral" && inner?.value === true;
}

/**
 * Arguments the SERVER consumes structurally, for every tool that has them.
 *
 * Three entries, each justified, and deliberately not extended for convenience: `tenantId` routes the call and
 * never reaches a body, `clearOmittedFields` selects replacement semantics in the handler, `binary` selects
 * response handling in the client. Anything else belongs in a tool's own `localArgs`.
 */
const SERVER_CONSUMED = new Set(["tenantId", "clearOmittedFields", "binary"]);

/**
 * Does `arg` name a path parameter of `op`, allowing the repo's `<resource>Id` convention?
 *
 * `reai_delete_asset` takes `assetId` for `/api/assets/{id}` deliberately — a bare `id` beside `tenantId` reads
 * as ambiguous in a tool call. The alias is only accepted for an `id`-shaped parameter, so this can never excuse
 * a body field: `name` or `accountNumber` will not pass.
 */
function namesPathParameter(arg, op) {
  const pathParams = (op.params ?? []).filter((p) => p.in === "path").map((p) => p.name);
  if (pathParams.includes(arg)) return true;
  return pathParams.some((p) => /^id$/i.test(p) && /^[a-z][a-zA-Z]*Id$/.test(arg));
}

/** What an operation declares: top-level body fields plus every parameter. */
function declaredBy(ops) {
  const declared = new Set();
  for (const op of ops) {
    for (const field of Object.keys(op.body?.fields ?? {})) declared.add(field);
    for (const param of op.params ?? []) declared.add(param.name);
  }
  return declared;
}

const TOOLS = [...allTools, ...uiTools];

/** Every tool paired with the operations it declares, skipping any whose paths do not resolve. */
function toolsWithOps() {
  const out = [];
  for (const tool of TOOLS) {
    const ops = (tool.apiPaths ?? []).map(([m, p]) => findOperation(m, p)).filter(Boolean);
    if (ops.length > 0) out.push({ tool, ops });
  }
  return out;
}

test("no curated tool accepts an argument its endpoint does not declare", () => {
  const offenders = [];

  for (const { tool, ops } of toolsWithOps()) {
    // A tool spanning several endpoints may legitimately take the union of their fields; asserting per-endpoint
    // would fail every composed tool, and a check that cannot pass gets deleted rather than fixed.
    const declared = declaredBy(ops);
    const local = new Set(tool.localArgs ?? []);

    for (const [arg, schema] of Object.entries(tool.inputSchema ?? {})) {
      if (SERVER_CONSUMED.has(arg)) continue;
      if (isAcknowledgementGate(schema)) continue;
      if (declared.has(arg)) continue;
      if (local.has(arg)) continue;
      if (ops.some((op) => namesPathParameter(arg, op))) continue;
      offenders.push(
        `${tool.name}: "${arg}" — not declared by ${tool.apiPaths.map(([m, p]) => `${m} ${p}`).join(", ")}`,
      );
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "these arguments are not declared by the endpoint, are not path parameters or acknowledgement gates, and " +
      "are not listed in the tool's localArgs. ReAI has no additionalProperties:false, so an argument it does " +
      "not know is silently DISCARDED on a 200 rather than refused — add it to the endpoint's schema knowledge " +
      "or, if the handler genuinely does not send it, declare it in localArgs with a reason:\n  " +
      offenders.join("\n  "),
  );
});

test("localArgs does not exempt an argument the endpoint already declares", () => {
  // A dead exemption is how this guard would rot: someone quiets a failure by listing a field that IS sent, and
  // the check then permits a real divergence on that name forever. Every entry must be doing work.
  const dead = [];
  for (const { tool, ops } of toolsWithOps()) {
    const declared = declaredBy(ops);
    for (const arg of tool.localArgs ?? []) {
      if (declared.has(arg)) dead.push(`${tool.name}: "${arg}" is declared by the endpoint and need not be local`);
      if (!(arg in (tool.inputSchema ?? {}))) dead.push(`${tool.name}: "${arg}" is not an argument of this tool`);
      if (ops.some((op) => namesPathParameter(arg, op))) {
        dead.push(`${tool.name}: "${arg}" is a path parameter, which is already derivable`);
      }
    }
  }
  assert.deepEqual(dead, [], `localArgs entries that do nothing:\n  ${dead.join("\n  ")}`);
});

test("the conformance check can actually fail", () => {
  // Without this the two assertions above are indistinguishable from a check that inspects nothing — the exact
  // failure this repo has shipped more than once. Each exemption is probed for both directions.
  const op = findOperation("DELETE", "/api/assets/{id}");
  assert.ok(op, "the fixture endpoint moved; re-anchor this test");

  // The path-parameter rule accepts the convention and refuses field-shaped names.
  assert.equal(namesPathParameter("assetId", op), true, "the <resource>Id convention must be accepted");
  assert.equal(namesPathParameter("id", op), true, "the literal parameter name must be accepted");
  assert.equal(namesPathParameter("name", op), false, "a plain field name must not pass as a path parameter");
  assert.equal(namesPathParameter("accountNumber", op), false, "a plain field name must not pass");
  assert.equal(namesPathParameter("notAField", op), false, "an invented name must not pass");

  // The gate detector is specific to literal true.
  assert.equal(isAcknowledgementGate(z.literal(true).optional()), true);
  assert.equal(isAcknowledgementGate(z.literal(true)), true);
  assert.equal(isAcknowledgementGate(z.boolean().optional()), false, "an ordinary boolean is not a gate");
  assert.equal(isAcknowledgementGate(z.literal(false).optional()), false, "literal false is not a gate");
  assert.equal(isAcknowledgementGate(z.string().optional()), false);

  // And the population is non-empty in both directions, or the whole thing is vacuous.
  const pairs = toolsWithOps();
  assert.ok(pairs.length > 100, `only ${pairs.length} tools resolved to operations`);
  const withLocal = TOOLS.filter((t) => (t.localArgs ?? []).length > 0);
  assert.ok(withLocal.length > 0, "no tool declares localArgs, so that exemption is untested");
  assert.ok(
    TOOLS.some((t) => Object.values(t.inputSchema ?? {}).some(isAcknowledgementGate)),
    "no tool has an acknowledgement gate, so that exemption is untested",
  );
});
