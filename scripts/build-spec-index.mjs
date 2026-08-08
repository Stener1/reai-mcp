#!/usr/bin/env node
/**
 * Builds spec/index.json — a compact, searchable index of the ReAI OpenAPI spec.
 *
 * The raw spec is ~900 KB / 430 operations, which is far too large to hold in an
 * LLM's context. The index keeps only what's needed to *find* an operation
 * (method, path, tag, summary, param names). Full parameter and body schemas are
 * resolved on demand from the raw spec by src/reai/spec.ts.
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const SRC = join(repo, "spec", "reai-openapi.json");
const OUT = join(repo, "spec", "index.json");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

/**
 * Paths and tags that exist in the spec but are not part of the API a
 * bookkeeping agent should drive: inbound webhooks from payment providers,
 * platform-admin endpoints, the internal POS ("kassasystem") app, Cloudflare
 * worker ingest hooks, and the Peppol transport layer.
 */
const INTERNAL_PATH_PREFIXES = [
  "/adyen",
  "/kassasystem",
  "/cf-worker",
  "/admin",
  "/ztl",
  "/api/admin",
  "/api/peppol",
];

/** Spring bean names leak into tags as `*-ctrl`; those endpoints are undocumented internals. */
const isInternalTag = (tag) => /-ctrl$/.test(tag);

/**
 * Operations the `-ctrl` heuristic hides that are real accounting work.
 *
 * The heuristic is right about the great majority of the 85 it catches: UI typeahead
 * (`/customer/search`, `/country/search`, 40-odd of them), Adyen and Shopify webhooks,
 * point-of-sale mobile auth, `/frontend-error`. But registering a payroll payment is
 * not an "undocumented internal", and hiding it means an agent asked to do that
 * reports the capability as absent — which is worse than refusing, because it is
 * false. None of these appear anywhere else in the public set, so discovery was the
 * only way to reach them.
 *
 * Exposing them does not widen what may be CALLED: `internal` is a discovery flag,
 * not a policy boundary, and every write below currently classifies as irreversible
 * (the fail-closed default for an unrecognised write path), so `reversible` mode
 * still refuses them. Discovery's job is to describe the API truthfully; the write
 * policy decides what happens next.
 *
 * Exact paths, deliberately — a prefix would sweep the `/invoice/.../search` and
 * `/salary/...` typeahead back in with them.
 *
 * Two rules govern what may be listed here, and both are enforced by tests rather
 * than trusted to this comment.
 *
 * No documented twin. Surfacing an unsupported duplicate of a supported endpoint is
 * worse than hiding it: it gives an agent two ways to do one job and no reason to
 * prefer the documented one. Five candidates were dropped for having one —
 * `POST /salary/{id}/complete`, `DELETE /subscription/{id}` and `GET /attachments/{id}`
 * duplicate `/api/salary-payments/{id}/complete`, `/api/subscriptions/{id}` and
 * `/api/attachments/{id}`; `/attachments/{id}/view/{filename}` is covered by
 * `/api/attachments/{id}/content`; and `PUT /project/{id}/sub-project/{subProjectId}`
 * (`renameSubProject`) is the same action as the documented
 * `PUT /api/projects/{id}/sub-projects/{subProjectId}/name` (`updateSubProjectName`).
 *
 * And it has to be callable. `POST /invoice/setting/receiver-bank` takes a required
 * object-valued QUERY parameter and no body, which `reai_request` cannot express, so
 * advertising it would offer a capability that fails the moment it is used —
 * precisely the false signal this allowlist exists to remove, pointing the other way.
 */
const BUSINESS_OPERATIONS = new Map([
  // Payroll: complete a run, record when and how it was paid.
  ["POST /salary/{id}/register-payment", "Salary Payments"],
  ["POST /salary/{id}/payment-date", "Salary Payments"],
  // Payments: correct the date or the company bank account a payment settles on.
  ["POST /payments/{id}/payment-date", "Invoices"],
  ["POST /payments/{id}/company-bank", "Invoices"],
  ["POST /invoice/payment/{paymentId}/company-bank", "Invoices"],
  // The default payment terms applied to every future invoice.
  ["POST /invoice/setting/daysUntilDue", "Invoices"],
  // Reading back what was filed: the Altinn sync state of a VAT return, and the raw
  // Skatteetaten feedback on an A-melding. Both read-only, and both answer a question
  // ("did it go through, and what did they say") that nothing else does.
  ["GET /vat-return/altinn-sync", "VAT returns"],
  ["GET /amelding/{id}/feedback-raw", "Salary Payments"],
]);

const isInternal = (path, tags, method) =>
  !BUSINESS_OPERATIONS.has(`${method} ${path}`) &&
  (INTERNAL_PATH_PREFIXES.some((p) => path === p || path.startsWith(p + "/")) ||
    tags.length === 0 ||
    tags.every(isInternalTag));

const spec = JSON.parse(readFileSync(SRC, "utf8"));

/** Resolve a local `$ref` one level. Returns the node unchanged if it is not a ref. */
function deref(node, seen = new Set()) {
  if (!node || typeof node !== "object" || !("$ref" in node)) return node;
  const ref = node.$ref;
  if (seen.has(ref)) return {};
  seen.add(ref);
  let cur = spec;
  for (const part of ref.replace(/^#\//, "").split("/")) {
    cur = cur?.[part];
    if (cur === undefined) return {};
  }
  return deref(cur, seen);
}

/** A stable, readable operation id: `GET /api/customers/{id}` -> `get_api_customers_by_id`. */
function operationId(method, path) {
  const slug = path
    .replace(/^\//, "")
    .replace(/\{([^}]+)\}/g, "by_$1")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
  return `${method}_${slug}`;
}

/**
 * OpenAPI 3.1 expresses nullability as `type: ["string", "null"]`. Flatten that to
 * `string?` so the index reads as a type hint rather than raw JSON.
 */
function typeName(schema) {
  const t = schema?.type;
  if (Array.isArray(t)) {
    const nullable = t.includes("null");
    const base = t.filter((x) => x !== "null");
    return (base.length === 1 ? base[0] : base.join("|") || "any") + (nullable ? "?" : "");
  }
  return t;
}

// An enum is a closed set, and a partial one is worse than none: an agent reading
// eight of sixteen voucher types concludes VAT_RETURN is not a legal filter and
// reports the API cannot do it. Truncation is therefore both generous and, when it
// happens, explicit — "+N more" tells the reader to call reai_describe_endpoint
// rather than trusting the list. Array-valued parameters carry their enum on
// `items`, not on the schema, so read both: three live parameters (bank-reconciliation
// `include`, `directPermissionCodes` on the user endpoints) rendered as a bare
// `string[]` with their legal values published nowhere.
const ENUM_LIMIT = 24;

function enumType(schema, fallback) {
  const declared = schema?.enum ?? deref(schema?.items)?.enum;
  const values = declared?.filter((e) => e !== null);
  if (!values?.length) return fallback;
  const shown = values.slice(0, ENUM_LIMIT).join("|");
  const suffix = values.length > ENUM_LIMIT ? `|+${values.length - ENUM_LIMIT} more` : "";
  const array = String(fallback ?? "").includes("[]") || schema?.type === "array";
  // Nullability has to survive the enum rendering. It did not: this threw `fallback` away, and
  // with it the trailing "?" that typeName had already worked out, so all 65 enum-typed body
  // fields in the spec read as non-nullable regardless of what they declare. That silence is not
  // harmless -- test/merge-tools.test.mjs decides from this exact string whether a tool may accept
  // null, so a nullable enum looked like a tool bug and the fix on offer was to drop a correct
  // `.nullable()`. Both signals count: `type: [..., "null"]`, which typeName encodes, and a null
  // sitting among the enum values, which is filtered out above and would otherwise vanish.
  const nullable = String(fallback ?? "").endsWith("?") || declared.some((e) => e === null);
  return `enum(${shown}${suffix})${array ? "[]" : ""}${nullable ? "?" : ""}`;
}

function trim(text, max) {
  if (!text) return undefined;
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** Shallow property summary: name -> short type string. Deep schemas stay in the raw spec. */
function bodyShape(op) {
  const rb = deref(op.requestBody);
  const json = rb?.content?.["application/json"] ?? rb?.content?.["*/*"];
  // Whether the BODY ITSELF is mandatory, which is separate from which of its
  // properties are. 51 operations declare a required body whose every property is
  // optional -- PUT /api/leads/{id}/notes among them -- so a `required` array that
  // is empty says nothing about whether the body may be omitted entirely.
  const bodyRequired = rb?.required === true;
  if (!json) {
    const multipart = rb?.content?.["multipart/form-data"];
    return multipart ? { contentType: "multipart/form-data", bodyRequired } : undefined;
  }
  const schema = deref(json.schema);
  const props = schema?.properties ?? {};
  const fields = {};
  for (const [name, raw] of Object.entries(props)) {
    const p = deref(raw);
    let t = typeName(p) ?? (p.oneOf || p.anyOf ? "oneOf" : "object");
    if (t === "array" || t === "array?") {
      const item = deref(p.items);
      t = `${typeName(item) ?? "object"}[]${t.endsWith("?") ? "?" : ""}`;
    }
    t = enumType(p, t);
    if (p.format && (t === "string" || t === "string?")) t = `${t.replace("?", "")}(${p.format})${t.endsWith("?") ? "?" : ""}`;
    fields[name] = t;
  }
  return {
    contentType: "application/json",
    bodyRequired,
    required: schema?.required ?? [],
    fields: Object.keys(fields).length ? fields : undefined,
  };
}

function paramShape(op, pathLevelParams) {
  const all = [...(pathLevelParams ?? []), ...(op.parameters ?? [])].map((p) => deref(p));
  const seen = new Set();
  const out = [];
  for (const p of all) {
    if (!p.name || seen.has(`${p.in}:${p.name}`)) continue;
    // The tenant header is set by the client from the `tenantId` tool argument;
    // surfacing it as a callable parameter only invites agents to fight over it.
    if (p.in === "header" && p.name.toLowerCase() === "x-tenant-id") continue;
    seen.add(`${p.in}:${p.name}`);
    const s = deref(p.schema) ?? {};
    let type = typeName(s) ?? "string";
    if (type.startsWith("array")) type = `${typeName(deref(s.items)) ?? "string"}[]`;
    type = enumType(s, type);
    out.push({
      name: p.name,
      in: p.in,
      required: p.required === true,
      type,
      description: trim(p.description, 160),
    });
  }
  return out;
}

const operations = [];
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  const pathLevelParams = item.parameters;
  for (const method of HTTP_METHODS) {
    const op = item[method];
    if (!op) continue;
    const tags = op.tags ?? [];
    const params = paramShape(op, pathLevelParams);
    const body = ["post", "put", "patch"].includes(method) ? bodyShape(op) : undefined;
    operations.push({
      id: operationId(method, path),
      method: method.toUpperCase(),
      path,
      // An allowlisted operation gets the tag its domain actually uses. Otherwise its
      // leaked Spring bean name ("salary-ctrl") would appear in reai_list_api_tags
      // beside the real ones, and searching the Salary Payments tag would not find it.
      tag:
        BUSINESS_OPERATIONS.get(`${method.toUpperCase()} ${path}`) ??
        tags.find((t) => !isInternalTag(t)) ??
        tags[0] ??
        "Other",
      tags,
      summary: trim(op.summary, 200),
      description: trim(op.description, 500),
      params: params.length ? params : undefined,
      body,
      internal: isInternal(path, tags, method.toUpperCase()),
      deprecated: op.deprecated === true || undefined,
    });
  }
}

// Codepoint order, not localeCompare: the default collation is locale-dependent, and
// under LANG=nb_NO Node sorts "aa" as "å" (after z). One Norwegian-named path would
// then make the artifact differ between machines, which defeats the reproducibility
// this file is otherwise careful about.
const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
operations.sort((a, b) => byCodepoint(a.path, b.path) || byCodepoint(a.method, b.method));

const tagCounts = {};
for (const o of operations) {
  if (o.internal) continue;
  tagCounts[o.tag] = (tagCounts[o.tag] ?? 0) + 1;
}

const index = {
  // No build timestamp on purpose: it would make the artifact non-reproducible
  // and churn the diff on every rebuild.
  source: "https://app.reai.no/openapi",
  openapi: spec.openapi,
  apiTitle: spec.info?.title,
  apiVersion: spec.info?.version ?? null,
  serverUrl: spec.servers?.[0]?.url ?? "https://app.reai.no",
  counts: {
    total: operations.length,
    public: operations.filter((o) => !o.internal).length,
    internal: operations.filter((o) => o.internal).length,
  },
  tags: Object.fromEntries(Object.entries(tagCounts).sort(([a], [b]) => byCodepoint(a, b))),
  operations,
};

// Everything the server knows about the API comes from this file, so a degraded
// build is invisible at runtime and confidently wrong — an agent is told an
// endpoint does not exist rather than that the index is broken. The builder used
// to have no assertions at all: an upstream spec with its `tags` dropped produced
// "430 operations, 0 public", exit 0, and a server with an empty discovery surface.
// test/spec.test.mjs does catch that, but neither `npm run build` nor the Dockerfile
// runs tests, so a Cloud Run deploy could ship it. These are floors, not exact
// counts, so ordinary API growth does not trip them.
const MIN_TOTAL = 350;
const MIN_PUBLIC = 250;
const problems = [];
if (index.counts.total < MIN_TOTAL) {
  problems.push(`only ${index.counts.total} operations (expected at least ${MIN_TOTAL})`);
}
if (index.counts.public < MIN_PUBLIC) {
  problems.push(`only ${index.counts.public} public operations (expected at least ${MIN_PUBLIC})`);
}
if (Object.keys(index.tags).length < 20) {
  problems.push(`only ${Object.keys(index.tags).length} public tags — is the spec still tagged?`);
}
const untyped = operations.filter((o) => !o.method || !o.path);
if (untyped.length) problems.push(`${untyped.length} operations missing a method or path`);
if (problems.length) {
  console.error("spec index build FAILED — the result would be silently wrong:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`Source: ${SRC}. Refusing to write ${OUT}.`);
  process.exit(1);
}

// Write via a temp file in the same directory: an interrupted build previously left
// a truncated index.json that every later run failed to parse.
const TMP = `${OUT}.tmp`;
writeFileSync(TMP, JSON.stringify(index) + "\n");
renameSync(TMP, OUT);

const kb = (n) => `${Math.round(n / 1024)} KB`;
console.error(
  `spec/index.json written: ${index.counts.total} operations ` +
    `(${index.counts.public} public, ${index.counts.internal} internal), ` +
    `${Object.keys(index.tags).length} tags, ${kb(JSON.stringify(index).length)} ` +
    `(raw spec ${kb(readFileSync(SRC).length)})`,
);
