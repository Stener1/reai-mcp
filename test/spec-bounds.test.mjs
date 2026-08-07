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

/**
 * Constraints per dotted LOCATION, from a request body schema.
 *
 * The first version flattened every depth into one field-name map, which made it blind to
 * anything inside an array — `subscriptionLines[].quantity`, `postings[].rowNumber`,
 * `serviceRecipients[].countryCode`. That is not a corner: it is where the bug that
 * prompted this whole sweep lived. Thirty probes existed for array-nested fields and the
 * sweep ran none of them, so deleting `quantity`'s bounds left it green.
 *
 * Locations also remove a latent false positive: two constrained fields sharing a name at
 * different depths used to collide, last writer winning, which could apply a nested field's
 * tighter bound to a top-level argument.
 */
function constraintsOf(node, prefix = "", out = {}, seen = new Set(), depth = 0) {
  if (depth > 8 || !node || typeof node !== "object") return out;
  if (node.$ref) {
    const name = node.$ref.split("/").pop();
    if (seen.has(name)) return out;
    return constraintsOf(SCHEMAS[name] ?? {}, prefix, out, new Set([...seen, name]), depth + 1);
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    for (const sub of node[key] ?? []) constraintsOf(sub, prefix, out, seen, depth + 1);
  }
  if (node.items) constraintsOf(node.items, `${prefix}[]`, out, seen, depth + 1);
  for (const [name, schema] of Object.entries(node.properties ?? {})) {
    const location = prefix ? `${prefix}.${name}` : name;
    const c = scalarConstraints(schema, seen);
    if (Object.keys(c).length > 0) out[location] = { ...(out[location] ?? {}), ...c };
    constraintsOf(schema, location, out, seen, depth + 1);
  }
  return out;
}

/**
 * The constraints on one property, including any reached through a `$ref` or a `oneOf`.
 *
 * Only `enum` used to be pulled through a `$ref`, so the patterns on `CountryCode`
 * (`^[A-Z]{2}$`) and `CurrencyCode` (`^[A-Z]{3}$`) were dropped — which is how a service
 * recipient's `countryCode` came to accept "no".
 */
function scalarConstraints(schema, seen = new Set(), depth = 0) {
  if (depth > 4 || !schema || typeof schema !== "object") return {};
  const c = {};
  for (const key of ["maximum", "minimum", "maxLength", "minLength", "pattern", "enum"]) {
    if (schema[key] !== undefined) c[key] = schema[key];
  }
  const refs = [schema.$ref, ...(schema.oneOf ?? []).map((o) => o.$ref)].filter(Boolean);
  for (const ref of refs) {
    const name = ref.split("/").pop();
    if (seen.has(name)) continue;
    Object.assign(c, scalarConstraints(SCHEMAS[name] ?? {}, new Set([...seen, name]), depth + 1), c);
  }
  return c;
}

/**
 * Unwrap toward the schema underneath — used for DESCENT, where an object or array shape is
 * needed. Strips refinements, so it must never be used for the probe itself.
 */
function unwrapForDescent(schema) {
  let node = schema;
  for (let i = 0; i < 10 && node?._def; i++) {
    const kind = node._def.typeName;
    if (kind === "ZodOptional" || kind === "ZodNullable" || kind === "ZodDefault") node = node._def.innerType;
    else if (kind === "ZodEffects") node = node._def.schema;
    else break;
  }
  return node;
}

/**
 * Unwrap only the modifiers that do not carry validation, for PROBING.
 *
 * Keeping ZodEffects matters: a `.refine()` is where several of these bounds live, and
 * unwrapping it threw the refinement away — so the sweep kept reporting the two `name`
 * fields as unbounded after they had been fixed, because it was probing the bare
 * ZodString inside the refinement rather than the schema the server actually uses.
 */
function unwrapForProbe(schema) {
  let node = schema;
  for (let i = 0; i < 10 && node?._def; i++) {
    const kind = node._def.typeName;
    if (kind === "ZodOptional" || kind === "ZodNullable" || kind === "ZodDefault") node = node._def.innerType;
    else break;
  }
  return node;
}

/** Follow a dotted location into a tool's input schema, descending arrays and objects. */
function resolveInput(inputSchema, location) {
  const parts = location.split(".");
  const first = parts[0].replace(/\[\]$/, "");
  let node = inputSchema[first];
  if (!node) return undefined;
  // Descend with the stripping unwrap, but return the LAST hop probe-ready, refinements
  // intact.
  const isLeaf = parts.length === 1 && !parts[0].endsWith("[]");
  if (isLeaf) return unwrapForProbe(node);
  node = unwrapForDescent(node);
  if (parts[0].endsWith("[]")) node = unwrapForDescent(node?._def?.type);
  for (const [i, raw] of parts.slice(1).entries()) {
    const key = raw.replace(/\[\]$/, "");
    const shape = typeof node?._def?.shape === "function" ? node._def.shape() : node?.shape;
    if (!shape?.[key]) return undefined;
    const last = i === parts.length - 2 && !raw.endsWith("[]");
    if (last) return unwrapForProbe(shape[key]);
    node = unwrapForDescent(shape[key]);
    if (raw.endsWith("[]")) node = unwrapForDescent(node?._def?.type);
  }
  return node;
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

test("the sweep reaches inside arrays, which is where the motivating bug lived", () => {
  const ops = writeOperations();
  assert.ok(ops.length >= 20, `only ${ops.length} tool write operations resolved to a request schema`);
  const find = (name) => ops.find((o) => o.tool.name === name);

  // Spec side: the nested locations resolve at all.
  const sub = find("reai_create_subscription");
  assert.equal(sub.constraints["subscriptionLines[].quantity"]?.minimum, 1);
  assert.equal(sub.constraints["serviceRecipients[].name"]?.maxLength, 255);
  assert.equal(sub.constraints.intervalMonths?.maximum, 12);
  // A pattern reached through a $ref — only `enum` used to be followed.
  assert.equal(sub.constraints["serviceRecipients[].countryCode"]?.pattern, "^[A-Z]{2}$");

  // Tool side: the same locations resolve into the zod schema, so a probe can reach them.
  const reach = (name, location) => resolveInput(find(name).tool.inputSchema, location);
  assert.ok(reach("reai_create_subscription", "subscriptionLines[].quantity"));
  assert.ok(reach("reai_create_subscription", "serviceRecipients[].countryCode"));
  assert.ok(reach("reai_create_voucher", "postings[].rowNumber"));
  // And at least a dozen nested locations are genuinely probed, or the sweep is theatre.
  let nested = 0;
  for (const { tool, constraints } of ops) {
    for (const location of Object.keys(constraints)) {
      if (location.includes("[]") && resolveInput(tool.inputSchema, location)) nested++;
    }
  }
  assert.ok(nested >= 12, `only ${nested} nested locations are reachable — the descent has drifted`);
});

test("no tool accepts an argument the API's schema rejects", () => {
  const accepted = [];
  for (const { tool, constraints } of writeOperations()) {
    for (const [location, c] of Object.entries(constraints)) {
      const key = `${tool.name}.${location}`;
      if (key in DELIBERATELY_LOOSER) continue;
      const schema = resolveInput(tool.inputSchema, location);
      if (!schema) continue; // the tool does not expose this field
      for (const [why, value] of violationsOf(c)) {
        if (schema.safeParse?.(value)?.success === true) accepted.push(`${key}: accepts a value ${why}`);
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

// The map is a filter, so a stale entry silently suppresses a live gap: with `.max(12)`
// removed from intervalMonths AND a stale exemption present, the sweep went green. The two
// comparable maps in this repo both check their own entries; this one did not.
test("every DELIBERATELY_LOOSER entry is real, needed, and explained", () => {
  for (const [key, reason] of Object.entries(DELIBERATELY_LOOSER)) {
    const [toolName, ...rest] = key.split(".");
    const location = rest.join(".");
    const tool = registeredTools.find((t) => t.name === toolName);
    assert.ok(tool, `exemption names an unknown tool: ${toolName}`);
    const schema = resolveInput(tool.inputSchema, location);
    assert.ok(schema, `${toolName} has no input at ${location}`);
    assert.ok(String(reason).length > 25, `${key} needs a reason, not a placeholder`);

    // And it must still be NEEDED: if the field now rejects everything the spec rejects,
    // the exemption is stale and hiding whatever comes next.
    const constraints = writeOperations()
      .filter((o) => o.tool.name === toolName)
      .reduce((acc, o) => ({ ...acc, ...(o.constraints[location] ?? {}) }), {});
    const stillLoose = violationsOf(constraints).some(([, v]) => schema.safeParse?.(v)?.success === true);
    assert.equal(stillLoose, true, `${key} is no longer loose — drop the exemption`);
  }
});


/** A probe-ready schema at a dotted location, asserted to exist. */
function at(toolName, location) {
  const tool = registeredTools.find((t) => t.name === toolName);
  assert.ok(tool, `no such tool: ${toolName}`);
  const schema = resolveInput(tool.inputSchema, location);
  assert.ok(schema, `${toolName} has no input at ${location}`);
  return schema;
}
function rejects(schema, value, pattern) {
  const parsed = schema.safeParse(value);
  assert.equal(parsed.success, false, `should reject ${JSON.stringify(value).slice(0, 30)}`);
  if (pattern) assert.match(parsed.error.issues.at(-1).message, pattern);
}

// The top-level bounds, pinned individually so a regression names itself rather than
// appearing as one line in a list.
test("the top-level bounds are enforced", () => {
  // The one that mattered: annual is the longest interval the API allows, confirmed against
  // the live API — 24 and 13 both answer 400, 12 is accepted.
  rejects(at("reai_create_subscription", "intervalMonths"), 24, /caps intervalMonths at 12/);
  rejects(at("reai_update_subscription", "intervalMonths"), 13);
  assert.equal(at("reai_create_subscription", "intervalMonths").safeParse(12).success, true);

  rejects(at("reai_create_subscription", "daysUntilDue"), -1, /cannot be negative/);
  rejects(at("reai_create_subscription", "daysUntilDue"), 3001, /caps daysUntilDue at 3000/);
  rejects(at("reai_create_subscription", "invoiceEmail"), "x".repeat(101), /100 characters/);
  rejects(at("reai_create_customer", "organizationNumber"), "x".repeat(37), /36 characters/);
  rejects(at("reai_create_supplier", "organizationNumber"), "x".repeat(37), /36 characters/);
  rejects(at("reai_create_order", "buyerReference"), "x".repeat(256), /255 characters/);
  rejects(at("reai_create_order", "externalReference"), "x".repeat(101), /100 characters/);
  rejects(at("reai_create_asset", "name"), "x".repeat(256));
  rejects(at("reai_register_supplier_invoice_payment", "invoiceAmount"), 10_000_000_000_000);
  rejects(at("reai_register_supplier_invoice_payment", "bankDebitAmount"), 10_000_000_000_000);

  // A blank name is rejected by the API's own pattern, on both update tools.
  rejects(at("reai_update_customer", "name"), "   ", /cannot be blank/);
  rejects(at("reai_update_supplier", "name"), "", /cannot be blank/);
  assert.equal(at("reai_update_customer", "name").safeParse("Kunde AS").success, true);
});

// Found only once the sweep could see inside arrays, and once it followed a $ref to a
// pattern. Every one of these would have failed the whole enclosing write with a bare 400.
test("the bounds inside arrays and behind refs are enforced", () => {
  rejects(at("reai_create_voucher", "postings[].rowNumber"), -1, /0 or more/);
  rejects(at("reai_create_voucher", "postings[].accountNumber"), "", /non-empty/);
  rejects(at("reai_create_subscription", "serviceRecipients[].countryCode"), "no", /two-letter uppercase/);
  rejects(at("reai_create_subscription", "serviceRecipients[].name"), "x".repeat(256), /255/);
  rejects(at("reai_create_subscription", "serviceRecipients[].organizationNumber"), "x".repeat(37), /36/);
  // The line bound Codex found, now reachable by the sweep rather than only by a hand pin.
  rejects(at("reai_create_subscription", "subscriptionLines[].quantity"), 0, /at least 1/);

  // Currency codes: the pattern lives behind a $ref, which the first sweep did not follow.
  for (const [tool, location] of [
    ["reai_create_subscription", "currencyCode"],
    ["reai_create_asset", "currencyCode"],
    // On the posting line, not the voucher root.
    ["reai_create_voucher", "postings[].currency"],
    ["reai_create_supplier_invoice", "currency"],
  ]) {
    rejects(at(tool, location), "nok", /three-letter uppercase/);
    assert.equal(at(tool, location).safeParse("NOK").success, true, `${tool}.${location} must accept NOK`);
  }
});

// The sweep's own unwrapping hid two findings after they were fixed: stripping ZodEffects
// discards a .refine(), so it probed the bare string inside the refinement rather than the
// schema the server uses. Descent needs the stripping unwrap; the probe must not have it.
test("the probe sees refinements, not the schema underneath them", () => {
  assert.equal(at("reai_update_customer", "name").safeParse("   ").success, false);
  // And descent still works through a refined object — subscriptionLines is
  // z.array(z.object({...}).refine(...)).
  assert.ok(at("reai_create_subscription", "subscriptionLines[].quantity"));
});
