import { test } from "node:test";
import assert from "node:assert/strict";
import { registeredTools } from "../dist/server.js";
import { findOperation } from "../dist/reai/spec.js";

/**
 * Do the curated tools still agree with the document about what the API accepts?
 *
 * Both properties below currently hold — this locks them in rather than fixing anything, which is worth
 * stating plainly. They were checked by hand while looking for a validation gap that turned out not to exist,
 * and the checking is what belongs in the repository: a hand-rolled version of the first one gave a FALSE
 * NEGATIVE, reporting `reai_update_agreement` as unvalidated because the grep looked for `enum(` while the
 * source contains the regex escape `enum\(`. A computed invariant does not make that mistake twice.
 *
 * What each is worth:
 *
 *   The enum comparison catches drift in the direction that hurts. A spec refresh that ADDS a member leaves a
 *   tool's `z.enum` rejecting a value the API now accepts, and the agent is told the value is invalid by the
 *   server that is wrong about it. Nothing else in the suite would notice: the tool's own tests use values
 *   from its own list.
 *
 *   The required-property check catches a tool shipped without an argument the API insists on, which fails as
 *   a 400 after a round-trip rather than locally.
 */

const WRITE = /^(POST|PUT|PATCH)$/;

/** The ZodEnum inside whatever optional/nullable/default wrappers a tool put around it. */
function zodEnum(schema) {
  let node = schema;
  for (let depth = 0; depth < 8 && node?._def; depth += 1) {
    if (node._def.typeName === "ZodEnum") return node;
    if (node._def.innerType) {
      node = node._def.innerType;
      continue;
    }
    if (node._def.schema) {
      node = node._def.schema;
      continue;
    }
    break;
  }
  return undefined;
}

/** Every (tool, field) pair where a write tool exposes a body field the spec declares as an enum. */
function enumArgs() {
  const pairs = [];
  const seen = new Set();
  for (const tool of registeredTools) {
    for (const [method, path] of tool.apiPaths ?? []) {
      if (!WRITE.test(method)) continue;
      const fields = findOperation(method, path)?.body?.fields ?? {};
      for (const [name, declared] of Object.entries(fields)) {
        if (typeof declared !== "string" || !declared.startsWith("enum(")) continue;
        const arg = tool.inputSchema?.[name];
        if (!arg) continue;
        const key = `${tool.name}.${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({
          key,
          members: (/^enum\(([^)]*)\)/.exec(declared)?.[1] ?? "").split("|").filter(Boolean),
          arg,
        });
      }
    }
  }
  return pairs;
}

test("every enum a tool declares matches the members the document declares", () => {
  const pairs = enumArgs();
  // Ratcheted, so deleting the arguments is not a way to pass. 26 pairs when this was written.
  assert.ok(pairs.length >= 26, `only ${pairs.length} enum arguments found; the floor is 26`);

  const mismatched = [];
  const notEnum = [];
  for (const { key, members, arg } of pairs) {
    const declared = zodEnum(arg);
    if (!declared) {
      // A tool may validate at runtime instead of in its schema — `reai_update_agreement` checks a free-form
      // `changes` record against the same declarations. That is not a failure, but a top-level argument NAMED
      // after an enum field and typed as a bare string is worth listing, because it is the shape that lets a
      // bad value reach the API.
      notEnum.push(key);
      continue;
    }
    const options = declared._def.values ?? declared.options ?? [];
    const fromSpec = [...members].sort().join("|");
    const fromTool = [...options].sort().join("|");
    if (fromSpec !== fromTool) {
      mismatched.push(`${key}\n     document: ${fromSpec}\n     tool:     ${fromTool}`);
    }
  }
  assert.deepEqual(mismatched, [], `these tools disagree with the document:\n  ${mismatched.join("\n  ")}`);
  // Recorded rather than asserted at zero: this is a list to look at when it grows, not a rule.
  assert.ok(
    notEnum.length <= 2,
    `${notEnum.length} enum-named arguments are not typed as enums: ${notEnum.join(", ")}`,
  );
});

test("no write tool omits a body property the document marks required", () => {
  // `body.required` is the document's own list. An earlier hand-rolled version of this check inferred
  // requiredness from the type string not ending in "?" and reported nine tools — every one a false positive,
  // since those tools are verified working live. The index carries the real list; use it.
  const offenders = [];
  let checked = 0;
  for (const tool of registeredTools) {
    for (const [method, path] of tool.apiPaths ?? []) {
      if (!WRITE.test(method)) continue;
      const required = findOperation(method, path)?.body?.required ?? [];
      if (required.length === 0) continue;
      checked += 1;
      const args = Object.keys(tool.inputSchema ?? {});
      // A tool carrying a free-form body can supply anything, so it cannot omit a field.
      if (args.some((a) => /^(body|changes|terms|fields|patch|data|lines|rows)$/.test(a))) continue;
      const missing = required.filter((r) => !args.includes(r));
      if (missing.length > 0) {
        offenders.push(`${tool.name} (${method} ${path}) omits ${missing.join(", ")}`);
      }
    }
  }
  assert.ok(checked >= 20, `only ${checked} write operations with a required body property; the floor is 20`);
  assert.deepEqual(offenders, [], `these tools omit a required body property:\n  ${offenders.join("\n  ")}`);
});
