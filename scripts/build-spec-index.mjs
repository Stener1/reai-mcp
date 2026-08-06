#!/usr/bin/env node
/**
 * Builds spec/index.json — a compact, searchable index of the ReAI OpenAPI spec.
 *
 * The raw spec is ~900 KB / 430 operations, which is far too large to hold in an
 * LLM's context. The index keeps only what's needed to *find* an operation
 * (method, path, tag, summary, param names). Full parameter and body schemas are
 * resolved on demand from the raw spec by src/reai/spec.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
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

const isInternal = (path, tags) =>
  INTERNAL_PATH_PREFIXES.some((p) => path === p || path.startsWith(p + "/")) ||
  tags.length === 0 ||
  tags.every(isInternalTag);

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
  if (!json) {
    const multipart = rb?.content?.["multipart/form-data"];
    return multipart ? { contentType: "multipart/form-data" } : undefined;
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
    if (p.enum) t = `enum(${p.enum.filter((e) => e !== null).slice(0, 8).join("|")})`;
    if (p.format && (t === "string" || t === "string?")) t = `${t.replace("?", "")}(${p.format})${t.endsWith("?") ? "?" : ""}`;
    fields[name] = t;
  }
  return {
    contentType: "application/json",
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
    if (s.enum) type = `enum(${s.enum.filter((e) => e !== null).slice(0, 8).join("|")})`;
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
      tag: tags.find((t) => !isInternalTag(t)) ?? tags[0] ?? "Other",
      tags,
      summary: trim(op.summary, 200),
      description: trim(op.description, 500),
      params: params.length ? params : undefined,
      body,
      internal: isInternal(path, tags),
      deprecated: op.deprecated === true || undefined,
    });
  }
}

operations.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

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
  tags: Object.fromEntries(Object.entries(tagCounts).sort(([a], [b]) => a.localeCompare(b))),
  operations,
};

writeFileSync(OUT, JSON.stringify(index) + "\n");

const kb = (n) => `${Math.round(n / 1024)} KB`;
console.error(
  `spec/index.json written: ${index.counts.total} operations ` +
    `(${index.counts.public} public, ${index.counts.internal} internal), ` +
    `${Object.keys(index.tags).length} tags, ${kb(JSON.stringify(index).length)} ` +
    `(raw spec ${kb(readFileSync(SRC).length)})`,
);
