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
  // OpenAPI 3.1 writes many bounds EXCLUSIVELY, and this document does it 28 times on query
  // parameters alone — `exclusiveMinimum: 0` on every id filter. Reading only the inclusive keys
  // dropped those parameters entirely, so a plain z.number().int() accepting 0 and negative ids
  // stayed green. Normalised to the inclusive form the probe already understands: exclusiveMinimum 0
  // is minimum 1 for an integer, and the probe then tries 0.
  if (typeof schema.exclusiveMinimum === "number" && c.minimum === undefined) {
    c.minimum = schema.exclusiveMinimum + (schema.type === "integer" ? 1 : 0);
    if (schema.type !== "integer") c.exclusiveMinimumValue = schema.exclusiveMinimum;
  }
  if (typeof schema.exclusiveMaximum === "number" && c.maximum === undefined) {
    c.maximum = schema.exclusiveMaximum - (schema.type === "integer" ? 1 : 0);
    if (schema.type !== "integer") c.exclusiveMaximumValue = schema.exclusiveMaximum;
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
  // For a non-integer exclusive bound, the excluded VALUE itself is the interesting probe: the
  // spec says "greater than 0", so 0 must be rejected while 0.0001 is fine.
  if (typeof c.exclusiveMinimumValue === "number") {
    out.push([`equal to the excluded minimum ${c.exclusiveMinimumValue}`, c.exclusiveMinimumValue]);
  }
  if (typeof c.exclusiveMaximumValue === "number") {
    out.push([`equal to the excluded maximum ${c.exclusiveMaximumValue}`, c.exclusiveMaximumValue]);
  }
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

/**
 * Every operation a tool declares, paired with the spec's constraints on its QUERY parameters.
 *
 * `writeOperations` walks request BODIES, so a read tool's filters had never been checked by
 * anything — which is how `reai_search_leads` shipped accepting a 300-character `query` against a
 * documented cap of 200. Codex found that by reading, and a guard that only covers write bodies
 * cannot claim to cover "arguments the API rejects".
 *
 * Includes writes, since a POST or PATCH can carry query parameters too, and DELETE, which
 * `writeOperations` skips because it has no body.
 */
function queryOperations() {
  const out = [];
  for (const tool of registeredTools) {
    for (const [method, path] of tool.apiPaths ?? []) {
      const op = SPEC.paths[path]?.[method.toLowerCase()];
      if (!op) continue;
      const constraints = {};
      for (const parameter of op.parameters ?? []) {
        if (parameter.in !== "query" || !parameter.schema) continue;
        // An ARRAY parameter keeps its constraints on `items` — /api/bank-reconciliations'
        // `include` has its allowed values as an enum there — so probing the outer schema found
        // nothing and swapping the tool's z.array(z.enum(...)) for plain strings would have stayed
        // green. Merged, with the item bounds winning, since they are the ones a value must satisfy.
        const bound = {
          ...scalarConstraints(parameter.schema),
          ...(parameter.schema.items ? scalarConstraints(parameter.schema.items) : {}),
        };
        if (Object.keys(bound).length > 0) {
          constraints[parameter.name] = { ...bound, isArray: parameter.schema.type === "array" };
        }
      }
      if (Object.keys(constraints).length > 0) out.push({ tool, method, path, constraints });
    }
  }
  return out;
}

/**
 * Constrained query parameters a tool exposes under a DIFFERENT name than the spec uses.
 *
 * Keyed `tool.specParameterName` → the tool's own argument name, and the sweep RESOLVES through it
 * rather than merely listing it. That distinction is the whole point: the first version held one
 * entry that said the tool and the spec agreed on the name — documenting nothing — while the sweep
 * went on skipping genuinely renamed parameters in silence. A map that records a blind spot without
 * closing it is worse than no map, because it reads as coverage.
 *
 * Empty today, and asserted below to contain only real renames of genuinely constrained parameters,
 * so it cannot fill up with decoration again.
 */
const RENAMED_QUERY_ARGS = {};

test("the query sweep sees a useful number of operations, not zero", () => {
  // A sweep that resolves nothing passes silently, which is the failure mode this repo keeps
  // naming. Measured: ten tool operations carry documented query bounds, three of them a maxLength.
  const ops = queryOperations();
  assert.ok(ops.length >= 10, `only ${ops.length} tool operations resolved to query constraints`);
  const withMaxLength = ops.filter((o) =>
    Object.values(o.constraints).some((c) => typeof c.maxLength === "number"),
  );
  assert.ok(withMaxLength.length >= 3, `only ${withMaxLength.length} carry a maxLength to check`);
});

test("no tool accepts a QUERY argument the API's schema rejects", () => {
  const problems = [];
  for (const { tool, constraints } of queryOperations()) {
    for (const [name, bound] of Object.entries(constraints)) {
      const renamed = RENAMED_QUERY_ARGS[`${tool.name}.${name}`];
      const schema = resolveInput(tool.inputSchema, renamed ?? name);
      // Not exposed at all is fine — a tool need not offer every filter. Exposed under another name
      // is what RENAMED_QUERY_ARGS is for, and the entry above is what makes it checkable instead of
      // skipped.
      if (!schema) continue;
      for (const [label, value] of violationsOf(bound)) {
        // A value that violates an ITEM constraint has to be offered as a one-element array, or the
        // probe tests the wrong thing and passes for the wrong reason.
        const probe = bound.isArray === true ? [value] : value;
        if (schema.safeParse?.(probe)?.success === true) {
          problems.push(`${tool.name}.${name}: accepts a value ${label}`);
        }
      }
    }
  }
  assert.deepEqual(
    problems.sort(),
    [],
    "these query arguments would be rejected by the API with a bare 400 — bound them locally so the " +
      "caller gets the reason",
  );
});

test("the query sweep would catch the case that prompted it", () => {
  // reai_search_leads.query is capped at 200 in the document. Asserted directly, so that removing
  // the bound fails here as well as in the leads suite — a sweep whose motivating case it cannot
  // see is not a sweep.
  const leads = queryOperations().find((o) => o.tool.name === "reai_search_leads");
  assert.ok(leads, "reai_search_leads should resolve query constraints");
  assert.equal(leads.constraints.query?.maxLength, 200);
  const schema = resolveInput(leads.tool.inputSchema, "query");
  assert.equal(schema.safeParse("x".repeat(201)).success, false);
});

test("an ARRAY query parameter's item constraints are resolved", () => {
  // /api/bank-reconciliations keeps `include`'s allowed values as an enum on schema.items, so
  // probing the outer schema found nothing at all. There is no violation to catch today —
  // reai_get_bank_reconciliation already uses z.array(z.enum(...)) — which is precisely why this
  // asserts the CONSTRAINT is resolved rather than that some tool is currently wrong. Verified the
  // other way round by mutation: replacing that enum with z.array(z.string()) makes the sweep fail,
  // which is the regression it exists to catch.
  const recon = queryOperations().find((o) => o.tool.name === "reai_get_bank_reconciliation");
  assert.ok(recon, "reai_get_bank_reconciliation should resolve query constraints");
  const include = recon.constraints.include;
  assert.ok(include, "`include` carries an item enum and must be resolved");
  assert.ok(Array.isArray(include.enum) && include.enum.length >= 3, JSON.stringify(include));
  assert.equal(include.isArray, true, "and it must be marked an array, or the probe tests a bare value");
});

test("every RENAMED_QUERY_ARGS entry is a real rename of a constrained parameter", () => {
  for (const [key, toolArg] of Object.entries(RENAMED_QUERY_ARGS)) {
    const [name, ...rest] = key.split(".");
    const specName = rest.join(".");
    const tool = registeredTools.find((t) => t.name === name);
    assert.ok(tool, `unknown tool: ${name}`);
    // A genuine RENAME: the tool must not already expose the spec's own name, or the entry is
    // decoration — which is exactly what the first version of this map contained.
    assert.ok(
      !resolveInput(tool.inputSchema, specName),
      `${key} is not a rename: ${name} already exposes "${specName}"`,
    );
    assert.ok(resolveInput(tool.inputSchema, toolArg), `${key} → "${toolArg}" is not an argument`);
    // And the spec parameter must actually be constrained, or there is nothing for the sweep to do.
    const constrained = queryOperations().some(
      (o) => o.tool.name === name && o.constraints[specName] !== undefined,
    );
    assert.ok(constrained, `${key} names no constrained query parameter`);
  }
});

test("a renamed parameter would be CHECKED, not skipped", () => {
  // The map is empty, so the mechanism is proved against a synthetic entry rather than left to be
  // trusted the first time a rename appears. reai_list_postings exposes `voucherId`; pretend the
  // spec called it something else and confirm the resolution finds the tool's argument.
  const postings = queryOperations().find((o) => o.tool.name === "reai_list_postings");
  assert.ok(postings, "reai_list_postings should resolve query constraints");
  const map = { "reai_list_postings.someOtherName": "voucherId" };
  const resolved = resolveInput(postings.tool.inputSchema, map["reai_list_postings.someOtherName"]);
  assert.ok(resolved, "the rename map must resolve to the tool's own argument");
  assert.equal(resolved.safeParse(0).success, false, "and the resolved schema is the bounded one");
});

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
/**
 * Operations this sweep cannot see, named so the gap is recorded rather than silent.
 *
 * DELIBERATELY_LOOSER is for a tool argument that maps to a body field of the same name; it
 * cannot express this case, and its own "is it still loose?" check rejects the entry — the
 * agreement tool takes a passthrough `changes` record, so there is no per-field schema for the
 * sweep to compare and all five template PUTs are skipped entirely.
 *
 * That is a deliberate trade: the five templates carry 78 / 31 / 23 / 20 / 17 fields, and
 * restating them as Zod would be a copy of the document that rots. The part that bites — 14
 * documented enums whose members are lowercase snake_case — is checked at call time from the
 * spec index instead, which test/agreements.test.mjs exercises for every one of the lease's.
 *
 * If this list grows, the reason should be as good.
 */
test("the operations this sweep skips are the ones we know about", () => {
  const seen = new Set();
  for (const { tool, method, path, constraints } of writeOperations()) {
    // "Skipped" here means: the operation has documented constraints and the tool exposes no
    // field of that name to compare them against.
    const exposes = Object.keys(constraints).some((field) => resolveInput(tool.inputSchema, field));
    if (!exposes && Object.keys(constraints).length > 0) seen.add(`${tool.name}: ${method} ${path}`);
  }
  // Six: four agreement templates plus the two single-concern employee tools. The purchase
  // template declares no constraints at all, so there is nothing for this sweep to skip on it —
  // measured rather than assumed, since the first version of this list had five and said so.
  const expected = [
    // Both take PATCH /api/employees/{id} and expose exactly ONE concern each — the salary
    // account, and the employment lines. The constrained fields on that endpoint are `name`
    // (maxLength 75) and `phone` (30), and neither tool accepts either, which is the point of
    // their being separate tools: a payment destination is not changed while fixing a postal
    // code. So there is nothing here for the sweep to bound. reai_create_employee and
    // reai_update_employee DO expose both and are checked normally.
    "reai_add_employment_line: PATCH /api/employees/{id}",
    "reai_set_employee_bank_account: PATCH /api/employees/{id}",
    "reai_update_agreement: PUT /api/agreements/accounting-services/{id}",
    "reai_update_agreement: PUT /api/agreements/employee-contract/{id}",
    "reai_update_agreement: PUT /api/agreements/rent-agreement/{id}",
    "reai_update_agreement: PUT /api/agreements/service-agreement/{id}",
  ];
  assert.deepEqual(
    [...seen].sort(),
    expected,
    "a write operation whose constraints this sweep cannot check — either expose the fields, or " +
      "add it here with the reason it is safe to skip",
  );
});

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

/**
 * The third leg: PATH parameters.
 *
 * The two sweeps above walk request bodies and query strings. Path parameters went unchecked, and the
 * first thing checking them found was that
 * reai_get_annual_accounts shipped taking a NUMBER for the same fiscal year that
 * reai_get_tax_return and reai_create_vat_return both take as a four-digit string. An agent using
 * two of the three in one session had to guess which wanted `2025` and which wanted `"2025"`.
 *
 * An earlier version of this comment justified the sweep by calling a path parameter "the one input a
 * caller cannot avoid". That is false in this very codebase, and the sweep's design depends on it
 * being false: reai_customer_ledger, reai_supplier_ledger and reai_employee_ledger all take their id
 * OPTIONALLY and switch endpoint when it is omitted, and reai_convert_lead covers
 * POST /api/leads/{id}/convert while exposing no argument for {id} at all — it derives the id from an
 * organisation number. Those are exactly the cases the resolver below has to reason about rather than
 * assume away.
 *
 * Two things are deliberately NOT enforced here, and both are decisions rather than omissions:
 *
 *  1. **int32 ceilings.** 231 path parameters declare `format: int32` (167 distinct path+name pairs),
 *     and 67 distinct tool arguments accept
 *     2147483648. Adding `.max(2147483647)` to every id would be 67 edits for a value no caller
 *     reaches by accident, and the API answers such a call with a clear `400 "Failed to convert
 *     'id'"`. Membership of the int32 range is the API's to judge, the same division of labour
 *     reai_list_countries documents for country codes: this server checks the SHAPE. Pinned as a
 *     test below so the decision is visible rather than looking like a gap nobody noticed.
 *  2. **The letter of `exclusiveMinimum: 0` on a string-typed year.** Three fiscal-year parameters
 *     declare that, which taken literally would admit "1" and "40000". All three tools require four
 *     digits instead. That is narrower than the spec and defensible — no company has books for year
 *     5 — and it is different in kind from the floor of 2000 an earlier version of the
 *     annual-accounts tool had, which excluded 1999, a year a real tenant could ask about.
 */
/**
 * The tool argument that feeds a path placeholder.
 *
 * Exact name first. Then one structural rule: if the operation has exactly ONE path parameter and the
 * tool has exactly ONE `…Id` argument, that argument is the one — there is nothing else it could be.
 *
 * This is not a nicety. Skipping every renamed placeholder left 11 of 109 path parameters unswept,
 * and review proved the consequence: dropping `.positive()` from `assetId`, `departmentId` or
 * `warehouseId` left seven tools accepting an id of 0 with all 750 tests green. The original comment
 * justified the skip as avoiding "a guess about which argument feeds which placeholder", which is
 * sound for a tool with two candidate ids and wrong for a tool with one.
 */
function resolveArg(tool, params, parameter) {
  const exact = tool.inputSchema?.[parameter.name];
  if (exact) return exact;
  const idArgs = Object.keys(tool.inputSchema ?? {}).filter(
    (name) => /Id$/i.test(name) && name !== "tenantId",
  );
  if (params.length === 1 && idArgs.length === 1) return tool.inputSchema[idArgs[0]];
  return undefined;
}

/** Placeholders no rule can attribute, listed so the set cannot grow in silence. */
const UNRESOLVED_PATH_ARGS = [
  // Derives the lead id internally from orgNumber, so no argument feeds the placeholder at all.
  "reai_convert_lead {id}",
  // Both take customerId AND projectId, and {id} here belongs to a preflight GET /api/customers/{id}.
  // Attributing it would be domain knowledge, not structure. Sorted, since the assertion sorts.
  "reai_create_offer {id}",
  "reai_create_order {id}",
];

function pathOperations() {
  const out = [];
  for (const tool of registeredTools) {
    for (const [method, path] of tool.apiPaths ?? []) {
      const item = SPEC.paths[path];
      const op = item?.[method.toLowerCase()];
      if (!op) continue;
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].filter(
        (p) => p?.in === "path" && p.schema,
      );
      if (params.length > 0) out.push({ tool, method, path, params });
    }
  }
  return out;
}

test("the path sweep sees a useful number of operations, not zero", () => {
  const ops = pathOperations();
  // Measured: well over a hundred tool operations carry a path parameter. A sweep that resolved
  // nothing would pass in silence, which is the failure mode this file keeps naming.
  // Near the measured 107, not far below it. A floor of 80 left 27 operations' worth of slack, and
  // the previous iteration's lesson was that slack is where coverage disappears: `checked >= 8`
  // against an actual 11 let three tools vanish from an audit.
  assert.ok(ops.length >= 100, `only ${ops.length} tool operations resolved to path parameters`);
});

test("no tool refuses a path value the API accepts", () => {
  const offenders = [];
  let checked = 0;
  for (const { tool, method, path, params } of pathOperations()) {
    for (const parameter of params) {
      const arg = resolveArg(tool, params, parameter);
      if (!arg) continue;
      checked += 1;
      const schema = parameter.schema;
      const integer = schema.type === "integer";
      // `exclusiveMinimum: 0` means "greater than zero" whatever the declared type; every parameter
      // carrying it here is numeric in content, string-typed years included.
      const smallestValid =
        schema.exclusiveMinimum !== undefined
          ? schema.exclusiveMinimum + 1
          : schema.minimum !== undefined
            ? schema.minimum
            : undefined;
      if (smallestValid === undefined) continue;
      // Probe in the shape the SPEC declares, not in whatever shape a magic value happens to fit.
      // The heuristic here was `arg.safeParse("2025").success || !arg.safeParse(2025).success`, which
      // defaults to "string" whenever it cannot tell — so adding a `.max(100)` to a numeric id
      // produced `refuses "1" which the spec allows` about an argument that accepts the number 1,
      // naming both the wrong shape and the wrong problem.
      const probe = schema.type === "string" ? String(smallestValid) : smallestValid;
      // A four-digit convention legitimately refuses "1", so a year is not compared against the
      // spec's floor directly — decision (2) in the comment above. It is NOT skipped outright,
      // though, which is what an earlier version did: review found that `"0000"` slipped through all
      // three fiscal-year tools precisely because this branch stopped looking. The floor still has to
      // bite somewhere, so a year argument is required to refuse year zero and to accept a real one.
      if (/^(year|fiscalYear)$/i.test(parameter.name)) {
        if (arg.safeParse("0000").success) {
          offenders.push(
            `${tool.name}.${parameter.name} accepts "0000" on ${method} ${path}, and the spec ` +
              `declares exclusiveMinimum 0`,
          );
        }
        if (!arg.safeParse("2025").success) {
          offenders.push(`${tool.name}.${parameter.name} refuses "2025" on ${method} ${path}`);
        }
        continue;
      }
      if (integer && !arg.safeParse(probe).success) {
        offenders.push(
          `${tool.name}.${parameter.name} refuses ${JSON.stringify(probe)} on ${method} ${path}, ` +
            `which the spec allows (exclusiveMinimum ${schema.exclusiveMinimum ?? "-"}, minimum ${schema.minimum ?? "-"})`,
        );
      }
    }
  }
  // 98 measured. Same reasoning as the operation floor above.
  assert.ok(checked >= 90, `expected many path arguments to compare; checked ${checked}`);
  assert.deepEqual(offenders, [], "these reject input the API would have accepted");
});

test("a path id below the spec's floor is refused locally", () => {
  // The other direction, and the one that catches a missing `.positive()`: an id of 0 or -1 is a
  // plausible agent mistake — an off-by-one, or a sentinel — and every id parameter in this API
  // declares exclusiveMinimum 0.
  const offenders = [];
  let checked = 0;
  for (const { tool, method, path, params } of pathOperations()) {
    for (const parameter of params) {
      const arg = resolveArg(tool, params, parameter);
      if (!arg || parameter.schema.exclusiveMinimum !== 0 || parameter.schema.type !== "integer") continue;
      checked += 1;
      for (const bad of [0, -1]) {
        if (arg.safeParse(bad).success) {
          offenders.push(`${tool.name}.${parameter.name} accepts ${bad} on ${method} ${path}`);
        }
      }
    }
  }
  // 86 measured.
  assert.ok(checked >= 80, `expected many integer path ids to check; checked ${checked}`);
  assert.deepEqual(offenders, [], "these accept an id the API declares impossible");
});

test("every tool taking a fiscal year takes it the same way", () => {
  // The inconsistency this sweep was written to catch, pinned as a property rather than as three
  // separate bounds: whatever the convention is, all of them share it.
  const yearTools = registeredTools.filter((t) => t.inputSchema?.year);
  assert.ok(yearTools.length >= 3, `expected several tools taking a year; found ${yearTools.length}`);
  const verdicts = yearTools.map((t) => ({
    name: t.name,
    shape: ["2025", "1999", "1", "20255", "", 2025]
      .map((probe) => (t.inputSchema.year.safeParse(probe).success ? "y" : "n"))
      .join(""),
  }));
  const shapes = new Set(verdicts.map((v) => v.shape));
  assert.equal(
    shapes.size,
    1,
    `tools disagree about how a fiscal year is passed: ${verdicts.map((v) => `${v.name}=${v.shape}`).join(", ")}`,
  );
  // And the shared convention is the four-digit string, which is what the spec declares the type as.
  assert.equal(verdicts[0].shape, "yynnnn", `unexpected year convention ${verdicts[0].shape}`);

  // A leading-zero year is refused by all of them. Four digits alone admitted "0000", which the spec
  // rules out with exclusiveMinimum 0 — and a bare `> 0` refinement then still admitted "0999", which
  // reai_get_annual_accounts converts with Number() and would have reported as year 999. The shared
  // `fiscalYear` schema in registry.ts requires >= 1000, in one place rather than three.
  for (const t of yearTools) {
    for (const bad of ["0000", "0001", "0999"]) {
      assert.equal(t.inputSchema.year.safeParse(bad).success, false, `${t.name} accepts year ${bad}`);
    }
    assert.equal(t.inputSchema.year.safeParse("1000").success, true, `${t.name} refuses year 1000`);
  }
});

test("the int32 ceiling is deliberately not enforced, and that is recorded here", () => {
  // Decision (1) above. This test exists so the absence is a choice on the record rather than a gap:
  // if someone decides the ceilings ARE worth 67 edits, this test is what they have to change, and
  // the reasoning is one scroll away.
  const beyondInt32 = new Set();
  for (const { tool, params } of pathOperations()) {
    for (const parameter of params) {
      const arg = resolveArg(tool, params, parameter);
      if (!arg || parameter.schema.format !== "int32") continue;
      // Unique tool+argument, not occurrences. Counting occurrences meant `reai_update_agreement.id`
      // alone contributed six, so ceilings could have been added to 59 of the 67 arguments while the
      // failure message still claimed none had been.
      if (arg.safeParse(2147483648).success) beyondInt32.add(`${tool.name}.${parameter.name}`);
    }
  }
  // Asserted as a RANGE, not a number, so ordinary tool churn does not fail it while a wholesale
  // change of policy in either direction does.
  assert.ok(
    beyondInt32.size >= 60,
    `int32 ceilings appear to have been added to path ids (${beyondInt32.size} of 67 still unbounded) — ` +
      `if that was deliberate, delete this test and the reasoning above it`,
  );
});

test("the manual-reconciliation 404 is recorded as ambiguous, not as a verdict", async () => {
  // Measured while looking for a manual bank account to build tools against: there is none on either
  // test tenant, and the endpoint's refusal for a SYNCED account names the wrong problem. Kept in
  // this file because it is the other thing the path-parameter work turned up.
  const { quirksFor } = await import("../dist/reai/quirks.js");
  const quirk = quirksFor("GET", "/api/manual-reconciliations/{bankAccountId}").find(
    (q) => q.id === "manual-reconciliation-404-means-not-manual-not-missing",
  );
  assert.ok(quirk, "the quirk should reach the endpoint it is about");
  assert.match(quirk.note, /Bankkonto ikke funnet/);
  // Ambiguous, not decided. The first version of this quirk said the 404 means "not manual", which
  // would send a caller with a stale or foreign id to the synced endpoint instead of fixing the id.
  // Both readings have to be named, and so does the way to tell them apart.
  assert.match(quirk.note, /AMBIGUOUS/);
  assert.match(quirk.note, /genuinely does not exist, or belongs to another tenant/);
  // The REMEDY sentence specifically. Matching `reai_list_company_banks` anywhere was satisfied by an
  // earlier, incidental mention ("appearing normally in reai_list_company_banks"), so deleting the
  // actionable advice left the test green.
  assert.match(quirk.note, /Settle it with reai_list_company_banks/);
  assert.match(quirk.note, /providerType/);
  assert.ok(
    !/It means the account is not a MANUAL one/.test(quirk.note),
    "the quirk must not state one reading as the answer",
  );

  // And the tool that sends callers there says so too, since that pointer is where they meet it.
  const tool = registeredTools.find((t) => t.name === "reai_get_bank_reconciliation");
  assert.match(tool.description, /Bankkonto ikke funnet/);
  assert.match(tool.description, /ambiguous/);
  assert.match(tool.description, /reai_list_company_banks/);
});

test("every path placeholder is either swept or listed as unattributable", () => {
  // The skip is the sweep's only blind spot, so it is pinned rather than trusted. Review showed what
  // an unpinned skip costs: 11 of 109 placeholders were unswept, and dropping `.positive()` from
  // assetId, departmentId or warehouseId left seven tools accepting an id of 0 with the whole suite
  // green. Eight of those eleven are now resolved structurally; the remaining three are named.
  const unresolved = [];
  let resolved = 0;
  for (const { tool, params } of pathOperations()) {
    for (const parameter of params) {
      if (resolveArg(tool, params, parameter)) resolved += 1;
      else unresolved.push(`${tool.name} {${parameter.name}}`);
    }
  }
  assert.ok(resolved >= 100, `only ${resolved} placeholders resolved to an argument`);
  assert.deepEqual(
    [...new Set(unresolved)].sort(),
    UNRESOLVED_PATH_ARGS,
    "a placeholder became unattributable, or one of the listed three became attributable — either " +
      "way the list above needs updating on purpose, because everything not on it is swept",
  );
});

/**
 * The other direction: a tool must not be STRICTER than the spec either.
 *
 * Everything above guards against looseness — a tool accepting what the API will reject, so the caller
 * gets a bare 400 instead of a reason. This guards the mirror, which is quieter and therefore worse: an
 * enum hardcoded in a tool schema that has fallen behind the document REFUSES a value the API accepts,
 * locally, with a validation error that reads like the caller's mistake. Nothing upstream is consulted,
 * so nothing ever corrects it.
 *
 * Keyed on dotted LOCATIONS rather than argument names, for the reason `constraintsOf` gives above: the
 * first version of this sweep iterated top-level `inputSchema` entries only, so every enum inside an
 * array of objects was invisible — `reai_create_expense.perDiems[].tripType` and `costs[].category`
 * among them, both backed by documented enums. A sweep that silently skips the nested half is the same
 * failure this file already records for bounds, and review caught it here within the hour.
 *
 * `DELIBERATELY_NARROWER` holds VALUES, not locations: exempting a whole argument would suppress the
 * comparison for every other value too, so the day the document gains another one, that drift hides
 * behind an exemption written for something else.
 */
const DELIBERATELY_NARROWER = {
  // "tool.location": { values: ["X"], reason: "why refusing X is deliberate" }
};

/**
 * Follow a `$ref` anywhere in the document, not only into `components.schemas`.
 *
 * `constraintsOf` above resolves through the `SCHEMAS` map because request bodies only ever point there.
 * Parameters do not: several of this document's query parameters are `$ref`s into
 * `components.parameters`, and an enum on one of those is exactly the kind this sweep must see.
 */
function derefAny(node, guard = 0) {
  let n = node;
  while (n && typeof n === "object" && typeof n.$ref === "string" && guard < 10) {
    n = n.$ref.replace(/^#\//, "").split("/").reduce((acc, key) => acc?.[key], SPEC);
    guard++;
  }
  return n;
}

/** Every enum the SPEC declares, by dotted location, for one operation — body and parameters alike. */
function specEnumLocations(method, path) {
  const op = SPEC.paths?.[path]?.[method.toLowerCase()];
  if (!op) return {};
  const found = {};
  const walk = (schema, prefix, depth = 0) => {
    const s = derefAny(schema);
    if (!s || depth > 6) return;
    const items = derefAny(s.items);
    if (items) walk(items, `${prefix}[]`, depth + 1);
    for (const [name, raw] of Object.entries(s.properties ?? {})) {
      const prop = derefAny(raw);
      const location = prefix ? `${prefix}.${name}` : name;
      if (Array.isArray(prop?.enum)) found[location] = prop.enum;
      const inner = derefAny(prop?.items);
      if (Array.isArray(inner?.enum)) found[`${location}[]`] = inner.enum;
      if (prop?.properties || prop?.items) walk(prop, location, depth + 1);
    }
  };
  walk(derefAny(op.requestBody)?.content?.["application/json"]?.schema, "");
  for (const raw of op.parameters ?? []) {
    const param = derefAny(raw);
    const schema = derefAny(param?.schema);
    if (Array.isArray(schema?.enum)) found[param.name] = schema.enum;
    const inner = derefAny(schema?.items);
    if (Array.isArray(inner?.enum)) found[param.name] = inner.enum;
  }
  return found;
}

/** Every enum a TOOL declares, by the same dotted location, walking into objects and arrays. */
function toolEnumLocations(schema, prefix = "", out = {}, depth = 0) {
  if (!schema || depth > 6) return out;
  let def = schema._def;
  // Unwrap optional / nullable / default / effects until something structural appears.
  for (let i = 0; i < 6 && def; i++) {
    if (Array.isArray(def.values)) {
      out[prefix] = def.values;
      return out;
    }
    if (def.typeName === "ZodArray" || def.type) {
      const inner = def.type ?? def.innerType;
      if (inner) return toolEnumLocations(inner, `${prefix}[]`, out, depth + 1);
    }
    if (def.typeName === "ZodObject" || typeof def.shape === "function") {
      const shape = typeof def.shape === "function" ? def.shape() : def.shape;
      for (const [name, child] of Object.entries(shape ?? {})) {
        toolEnumLocations(child, prefix ? `${prefix}.${name}` : name, out, depth + 1);
      }
      return out;
    }
    def = def.innerType?._def ?? def.schema?._def;
  }
  return out;
}

/**
 * Every comparison this sweep is expected to make, pinned.
 *
 * A floor was the first version and review was right that it is too weak: a floor of eight let the sweep
 * lose most of its comparisons and stay green —
 * while counting operation occurrences rather than distinct locations made it easier still, since a
 * create and an update mapping the same argument both counted. Pinning the set means losing one fails,
 * and gaining one fails with a nudge to add it here, which is the only way the claim stays true.
 */
const EXPECTED_ENUM_COMPARISONS = [
  "reai_add_salary_line.specificationCode",
  "reai_add_share_investment_event.eventType",
  "reai_create_asset.depreciationMethod",
  "reai_create_expense.costs[].category",
  "reai_create_expense.perDiems[].tripType",
  "reai_create_loan.dayCountConvention",
  "reai_create_loan.interestTreatment",
  "reai_create_loan.loanType",
  "reai_create_loan.perspective",
  "reai_create_loan.repaymentType",
  "reai_create_share_investment.instrumentType",
  "reai_create_subscription.billingTiming",
  "reai_create_subscription.outputMode",
  "reai_create_subscription.periodAlignment",
  "reai_create_supplier_invoice.documentType",
  "reai_list_invoices.dueDateStatus",
  "reai_list_invoices.paymentStatus",
  "reai_list_invoices.type",
  "reai_list_orders.status",
  "reai_list_vat_codes.usage",
  "reai_list_vouchers.voucherType",
  "reai_log_lead_contact.source",
  "reai_search_leads.contactStatus",
  "reai_search_leads.leadFilter",
  "reai_search_leads.statusFilter",
  "reai_set_asset_depreciation.depreciationMethod",
  "reai_update_expense.costs[].category",
  "reai_update_expense.perDiems[].tripType",
  "reai_update_lead.status",
  "reai_update_loan.dayCountConvention",
  "reai_update_loan.interestTreatment",
  "reai_update_loan.loanType",
  "reai_update_loan.perspective",
  "reai_update_loan.repaymentType",
  "reai_update_salary_line.specificationCode",
  "reai_update_share_investment.instrumentType",
  "reai_update_subscription.billingTiming",
  "reai_update_subscription.outputMode",
  "reai_update_subscription.periodAlignment",
];

test("no tool enum has fallen behind the values the spec allows", () => {
  const narrower = [];
  const compared = new Set();
  for (const tool of registeredTools) {
    const mine = toolEnumLocations({ _def: { typeName: "ZodObject", shape: () => tool.inputSchema ?? {} } });
    for (const [location, values] of Object.entries(mine)) {
      for (const [method, path] of tool.apiPaths ?? []) {
        const theirs = specEnumLocations(method, path)[location];
        if (!theirs) continue;
        const key = `${tool.name}.${location}`;
        compared.add(key);
        const exempt = DELIBERATELY_NARROWER[key]?.values ?? [];
        const missing = theirs.filter((v) => !values.includes(v) && !exempt.includes(v));
        if (missing.length > 0) narrower.push(`${key} (${method} ${path}) refuses ${missing.join(", ")}`);
      }
    }
  }

  // The set, not a floor: if argument matching or the spec walk regresses, the comparisons vanish and a
  // floor would still pass. Distinct locations, so a create and an update sharing an argument count once.
  assert.deepEqual(
    [...compared].sort(),
    [...EXPECTED_ENUM_COMPARISONS].sort(),
    "the set of enums compared against the document changed — add a new one to EXPECTED_ENUM_COMPARISONS, " +
      "or find out why one stopped being seen",
  );
  assert.deepEqual(
    narrower,
    [],
    "these tools refuse values the API documents, which the caller sees as their own mistake — widen the " +
      "enum, or record the specific values in DELIBERATELY_NARROWER with why",
  );
});
