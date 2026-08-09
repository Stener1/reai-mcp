import { test } from "node:test";
import assert from "node:assert/strict";
import { registeredTools } from "../dist/server.js";
import { findOperation, getSpecIndex } from "../dist/reai/spec.js";

/**
 * Do the curated tools still agree with the document about what the API accepts?
 *
 * Both properties hold today — these lock them in rather than fixing anything, which is worth saying plainly.
 * They came out of looking for a validation gap that turned out not to exist, and the looking is what belongs
 * in the repository: a hand-rolled version gave a FALSE NEGATIVE, reporting `reai_update_agreement` as
 * unvalidated because the grep looked for `enum(` while the source carries the regex escape `enum\(`.
 *
 * The first version of this file was reviewed hard and most of its escape valves were unexercised slack. What
 * changed, because each was a hole rather than a nicety:
 *
 *   - A spec enum field with no matching top-level argument was dropped BEFORE it could be recorded, so
 *     twelve pairs vanished silently. They are now enumerated against a named expectation.
 *   - `notEnum.length <= 2` licensed two future holes while the actual was 0, and the comment justifying the
 *     slack described a case that cannot occur. It asserts empty now.
 *   - The unwrapper did not follow `ZodArray`, and the index renders an array enum as `enum(...)[]` — which
 *     passes `startsWith("enum(")`, so a correctly written `z.array(z.enum([...]))` would have been counted as
 *     "not an enum" and swallowed by that slack.
 *   - `ENUM_LIMIT = 24` in the index builder renders overflow as `enum(a|b|+21 more)`. Two live fields hit it,
 *     and comparing against a literal member `+21 more` would be a spurious failure indistinguishable from
 *     real drift. Those are now detected and skipped by name.
 *   - The free-form escape whitelisted eight argument names on speculation; no tool hit any of them. It is a
 *     structural check for a `z.record` passthrough now, which is what the escape was reaching for.
 */

const WRITE = /^(POST|PUT|PATCH)$/;

/**
 * The spec index encodes an enum body field as `enum(a|b|c)` with an optional `[]` for an array and `?` for
 * nullable. Both suffixes were being discarded, which is what made the array case invisible.
 */
function parseEnum(declared) {
  if (typeof declared !== "string" || !declared.startsWith("enum(")) return undefined;
  const members = /^enum\(([^)]*)\)/.exec(declared)?.[1] ?? "";
  const suffix = declared.slice(members.length + "enum()".length);
  return {
    members: members.split("|").filter(Boolean),
    isArray: suffix.includes("[]"),
    // The index truncates long member lists, so the document's own text is not recoverable from it.
    truncated: /\+\d+ more$/.test(members.split("|").at(-1) ?? ""),
  };
}

/** The ZodEnum inside whatever wrappers a tool put around it, including an array element. */
function zodEnum(schema) {
  let node = schema;
  for (let depth = 0; depth < 10 && node?._def; depth += 1) {
    const kind = node._def.typeName;
    if (kind === "ZodEnum") return { values: node._def.values ?? node.options ?? [] };
    // ZodNativeEnum keeps an object, not an array.
    if (kind === "ZodNativeEnum") return { values: Object.values(node._def.values ?? {}) };
    if (kind === "ZodArray" && node._def.type) {
      node = node._def.type;
      continue;
    }
    if (kind === "ZodPipeline" && node._def.out) {
      node = node._def.out;
      continue;
    }
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

/**
 * Spec enum fields with no top-level argument of that name.
 *
 * All twelve belong to `reai_update_agreement`, which takes a free-form `changes` record and checks it against
 * `findOperation("PUT", …).body.fields` AT RUNTIME — the source says why: "a copy would rot the moment one
 * changes". So these cannot drift from the document by construction, and there is nothing for a comparison to
 * do. They are listed rather than skipped so that a thirteenth, on a tool with no such runtime check, fails.
 */
const VALIDATED_AT_RUNTIME = new Set(["reai_update_agreement"]);

function enumPairs() {
  const compared = [];
  const notEnum = [];
  const noArgument = [];
  const truncated = [];
  const seen = new Set();
  for (const tool of registeredTools) {
    for (const [method, path] of tool.apiPaths ?? []) {
      if (!WRITE.test(method)) continue;
      const fields = findOperation(method, path)?.body?.fields ?? {};
      for (const [name, declared] of Object.entries(fields)) {
        const parsed = parseEnum(declared);
        if (!parsed) continue;
        const key = `${tool.name}.${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const arg = tool.inputSchema?.[name];
        if (!arg) {
          noArgument.push(key);
          continue;
        }
        if (parsed.truncated) {
          truncated.push(key);
          continue;
        }
        const declaredEnum = zodEnum(arg);
        if (!declaredEnum) {
          notEnum.push(key);
          continue;
        }
        compared.push({ key, spec: parsed.members, tool: [...declaredEnum.values] });
      }
    }
  }
  return { compared, notEnum, noArgument, truncated };
}

test("every enum a tool declares matches the members the document declares", () => {
  const { compared, notEnum, noArgument, truncated } = enumPairs();

  // Headroom, and a message that names what it found — a floor pinned exactly at the current value fails any
  // legitimate consolidation with a number and no tool name.
  assert.ok(
    compared.length >= 24,
    `only ${compared.length} enum arguments compared (floor 24). Found: ${compared.map((c) => c.key).join(", ")}`,
  );

  const mismatched = compared
    .filter(({ spec, tool }) => [...spec].sort().join("|") !== [...tool].sort().join("|"))
    .map(({ key, spec, tool }) => `${key}\n     document: ${[...spec].sort().join("|")}\n     tool:     ${[...tool].sort().join("|")}`);
  assert.deepEqual(mismatched, [], `these tools disagree with the document:\n  ${mismatched.join("\n  ")}`);

  // EMPTY, not "at most two". An argument named after an enum field and typed as a bare string is the shape
  // that lets a value the API rejects reach it, and there is no case today that needs the licence.
  assert.deepEqual(notEnum, [], `enum-named arguments not typed as enums: ${notEnum.join(", ")}`);

  // Every unmatched field must belong to a tool that checks the document at runtime instead.
  const unexplained = noArgument.filter((key) => !VALIDATED_AT_RUNTIME.has(key.split(".")[0]));
  assert.deepEqual(
    unexplained,
    [],
    `these enum fields have no argument and no runtime check: ${unexplained.join(", ")}`,
  );

  // And the truncated ones are named, so the skip is visible rather than silent.
  for (const key of truncated) {
    assert.match(key, /directPermissionCodes$/, `unexpected truncated enum skipped: ${key}`);
  }
});

test("the index still truncates exactly the two enum lists this file skips", () => {
  // The skip above is only safe while `ENUM_LIMIT` affects a known, small set. If a spec refresh pushes a third
  // field over the limit, that field silently stops being compared — so the count is pinned here instead.
  const over = [];
  for (const op of getSpecIndex().operations) {
    for (const [name, declared] of Object.entries(op.body?.fields ?? {})) {
      if (parseEnum(declared)?.truncated) over.push(`${op.method} ${op.path} ${name}`);
    }
  }
  assert.equal(over.length, 2, `enum lists truncated by ENUM_LIMIT: ${over.join(", ")}`);
  for (const entry of over) assert.match(entry, /directPermissionCodes$/);
});

test("no write tool omits a body property the document marks required", () => {
  // `body.required` is the document's own list. An earlier hand-rolled version inferred requiredness from the
  // type string not ending in "?" and reported nine tools — every one a false positive, since those tools are
  // verified working live. The index carries the real list; use it.
  const offenders = [];
  const passthrough = [];
  let checked = 0;
  for (const tool of registeredTools) {
    for (const [method, path] of tool.apiPaths ?? []) {
      if (!WRITE.test(method)) continue;
      const required = findOperation(method, path)?.body?.required ?? [];
      if (required.length === 0) continue;
      checked += 1;
      const schema = tool.inputSchema ?? {};
      // A genuine free-form passthrough, detected structurally rather than by guessing argument names. The
      // first version whitelisted eight names on speculation and no tool hit any of them.
      const record = Object.entries(schema).find(([, arg]) => {
        let node = arg;
        for (let depth = 0; depth < 6 && node?._def; depth += 1) {
          if (node._def.typeName === "ZodRecord") return true;
          node = node._def.innerType ?? node._def.schema;
        }
        return false;
      });
      if (record) {
        passthrough.push(`${tool.name}.${record[0]}`);
        continue;
      }
      const missing = required.filter((name) => !Object.keys(schema).includes(name));
      if (missing.length > 0) offenders.push(`${tool.name} (${method} ${path}) omits ${missing.join(", ")}`);
    }
  }
  // 51 today. Floored close to it: the first version said 20, which would have let half the write tools lose
  // their apiPaths silently — the same hole its own comment claimed to have closed.
  assert.ok(checked >= 45, `only ${checked} write operations with a required body property (floor 45)`);
  assert.deepEqual(offenders, [], `these tools omit a required body property:\n  ${offenders.join("\n  ")}`);
});
