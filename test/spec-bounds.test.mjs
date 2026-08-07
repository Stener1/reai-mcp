import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { registeredTools } from "../dist/server.js";

const SPEC = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "spec", "reai-openapi.json"), "utf8"),
);
const SCHEMAS = SPEC.components.schemas;

/**
 * A tool must not accept an argument the API's own schema rejects.
 *
 * Codex found one instance — `quantity: 0` on a subscription line, where
 * `SubscriptionLineReq` requires at least 1 — and the interesting question was whether it
 * was one instance or a pattern. Sweeping every curated tool against the spec found
 * fifteen, across seven tools: `intervalMonths` accepted 24 where the API caps it at 12,
 * so a biennial subscription was expressible and could only ever fail; `daysUntilDue`
 * accepted negatives; four string fields had no length cap; two amounts had no ceiling.
 *
 * None of that is a safety problem. It is the difference between "the tool told me this
 * was valid and the API returned 400" and "the tool told me why". This server already
 * checks voucher balance locally for exactly that reason.
 */

/** Constraints per field name, from a request body schema, following refs and unions. */
function constraintsOf(node, out = {}, seen = new Set(), depth = 0) {
  if (depth > 6 || !node || typeof node !== "object") return out;
  if (node.$ref) {
    const name = node.$ref.split("/").pop();
    if (seen.has(name)) return out;
    return constraintsOf(SCHEMAS[name] ?? {}, out, new Set([...seen, name]), depth + 1);
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    for (const sub of node[key] ?? []) constraintsOf(sub, out, seen, depth + 1);
  }
  if (node.items) constraintsOf(node.items, out, seen, depth + 1);
  for (const [name, schema] of Object.entries(node.properties ?? {})) {
    const c = {};
    for (const key of ["maximum", "minimum", "maxLength", "pattern", "enum"]) {
      if (schema[key] !== undefined) c[key] = schema[key];
    }
    // An enum often hides behind a $ref (VatCode, CountryCode).
    if (schema.$ref) {
      const ref = SCHEMAS[schema.$ref.split("/").pop()];
      if (ref?.enum) c.enum = ref.enum;
    }
    if (Object.keys(c).length > 0) out[name] = { ...(out[name] ?? {}), ...c };
    constraintsOf(schema, out, seen, depth + 1);
  }
  return out;
}

/**
 * Values that violate a constraint, for probing the tool's schema with.
 *
 * The pattern case has to be constructed rather than guessed. A first version probed
 * `"zz not matching"` against `.*\S.*` — which that string satisfies — and reported two
 * findings that were nothing at all. It now picks a candidate that genuinely fails.
 */
function violationsOf(c) {
  const out = [];
  if (typeof c.maximum === "number") out.push([`above maximum ${c.maximum}`, c.maximum + 1]);
  if (typeof c.minimum === "number") out.push([`below minimum ${c.minimum}`, c.minimum - 1]);
  if (typeof c.maxLength === "number" && c.maxLength < 5000) {
    out.push([`longer than maxLength ${c.maxLength}`, "x".repeat(c.maxLength + 1)]);
  }
  if (Array.isArray(c.enum) && c.enum.length > 0) out.push(["outside the enum", "zz-not-a-member"]);
  if (typeof c.pattern === "string") {
    let re;
    try {
      re = new RegExp(c.pattern);
    } catch {
      return out; // a pattern this runtime cannot compile is not something to assert on
    }
    const candidate = ["zz-not-matching", "", " ", "0", "!!"].find((v) => !re.test(v));
    if (candidate !== undefined) out.push([`fails pattern ${c.pattern}`, candidate]);
  }
  return out;
}

/**
 * Where a tool is deliberately looser than the spec, with the reason.
 *
 * Empty today. Kept because there are two legitimate cases — a spec constraint the live API
 * does not actually enforce (this document has been wrong before, in five places), and a
 * field whose tool argument means something different from the body field of the same name.
 * Either is fine to record; neither is fine to leave silent.
 */
const DELIBERATELY_LOOSER = {};

/** Every write operation a tool declares, paired with the spec's constraints for it. */
function writeOperations() {
  const out = [];
  for (const tool of registeredTools) {
    for (const [method, path] of tool.apiPaths ?? []) {
      if (method === "GET" || method === "DELETE") continue;
      const op = SPEC.paths[path]?.[method.toLowerCase()];
      const media = Object.values(op?.requestBody?.content ?? {})[0];
      if (!media?.schema) continue;
      out.push({ tool, method, path, constraints: constraintsOf(media.schema) });
    }
  }
  return out;
}

test("the sweep finds the operations it is meant to check", () => {
  const ops = writeOperations();
  assert.ok(ops.length >= 20, `only ${ops.length} tool write operations resolved to a request schema`);
  // Named anchors, so a traversal that silently stops following $ref fails here rather than
  // passing an empty assertion below.
  const find = (name) => ops.find((o) => o.tool.name === name);
  assert.ok(find("reai_create_subscription"), "subscription create should resolve");
  assert.equal(find("reai_create_subscription").constraints.intervalMonths?.maximum, 12);
  assert.equal(find("reai_create_customer").constraints.organizationNumber?.maxLength, 36);
  // And a constraint reached through a nested array of objects.
  assert.equal(find("reai_create_subscription").constraints.quantity?.minimum, 1);
});

test("no tool accepts an argument the API's schema rejects", () => {
  const accepted = [];
  for (const { tool, constraints } of writeOperations()) {
    for (const [field, schema] of Object.entries(tool.inputSchema ?? {})) {
      const key = `${tool.name}.${field}`;
      if (key in DELIBERATELY_LOOSER) continue;
      for (const [why, value] of violationsOf(constraints[field] ?? {})) {
        if (schema.safeParse?.(value)?.success === true) {
          accepted.push(`${key}: accepts a value ${why}`);
        }
      }
    }
  }
  assert.deepEqual(
    accepted,
    [],
    "these arguments would be rejected by the API with a bare 400 — bound them locally so the " +
      "caller gets the reason, or record the looseness in DELIBERATELY_LOOSER with why",
  );
});

// The bounds that came out of the sweep, pinned individually so a regression names itself
// rather than appearing as one line in a list.
test("the bounds found by the sweep are enforced", () => {
  const input = (toolName, field) => {
    const tool = registeredTools.find((t) => t.name === toolName);
    assert.ok(tool?.inputSchema?.[field], `${toolName}.${field} should exist`);
    return tool.inputSchema[field];
  };
  const rejects = (schema, value, pattern) => {
    const parsed = schema.safeParse(value);
    assert.equal(parsed.success, false, `should reject ${JSON.stringify(value)}`);
    if (pattern) assert.match(parsed.error.issues.at(-1).message, pattern);
  };

  // The one that mattered: annual is the longest interval the API allows, so a biennial
  // subscription was expressible and could only fail.
  rejects(input("reai_create_subscription", "intervalMonths"), 24, /caps intervalMonths at 12/);
  rejects(input("reai_update_subscription", "intervalMonths"), 13);
  assert.equal(input("reai_create_subscription", "intervalMonths").safeParse(12).success, true);

  rejects(input("reai_create_subscription", "daysUntilDue"), -1, /cannot be negative/);
  rejects(input("reai_create_subscription", "daysUntilDue"), 3001, /caps daysUntilDue at 3000/);
  rejects(input("reai_create_subscription", "invoiceEmail"), "x".repeat(101), /100 characters/);
  rejects(input("reai_create_customer", "organizationNumber"), "x".repeat(37), /36 characters/);
  rejects(input("reai_create_supplier", "organizationNumber"), "x".repeat(37), /36 characters/);
  rejects(input("reai_create_order", "buyerReference"), "x".repeat(256), /255 characters/);
  rejects(input("reai_create_order", "externalReference"), "x".repeat(101), /100 characters/);
  rejects(input("reai_create_asset", "name"), "x".repeat(256));
  rejects(input("reai_register_supplier_invoice_payment", "invoiceAmount"), 10_000_000_000_000);
  rejects(input("reai_register_supplier_invoice_payment", "bankDebitAmount"), 10_000_000_000_000);

  // A blank name is rejected by the API's own pattern, on both update tools.
  rejects(input("reai_update_customer", "name"), "   ", /cannot be blank/);
  rejects(input("reai_update_supplier", "name"), "", /cannot be blank/);
  assert.equal(input("reai_update_customer", "name").safeParse("Kunde AS").success, true);
});
