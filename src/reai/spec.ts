import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { HttpMethod } from "./client.js";
import { quirksFor, type Quirk } from "./quirks.js";

export type SpecParam = {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  type: string;
  description?: string;
};

export type SpecBody = {
  contentType: string;
  required?: string[];
  fields?: Record<string, string>;
};

export type SpecOperation = {
  id: string;
  method: HttpMethod;
  path: string;
  tag: string;
  tags: string[];
  summary?: string;
  description?: string;
  params?: SpecParam[];
  body?: SpecBody;
  internal: boolean;
  deprecated?: boolean;
};

export type SpecIndex = {
  source: string;
  openapi: string;
  apiTitle?: string;
  apiVersion: string | null;
  serverUrl: string;
  counts: { total: number; public: number; internal: number };
  tags: Record<string, number>;
  operations: SpecOperation[];
};

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a file that ships alongside the code but lives outside `rootDir`.
 * Layouts differ between a built package (`dist/reai/` -> `../../spec/`), a
 * ts-node style run from `src/`, and a Docker image with a flattened tree.
 */
function locate(filename: string): string {
  const candidates = [
    join(here, "..", "..", "spec", filename),
    join(here, "..", "..", "..", "spec", filename),
    resolve(process.cwd(), "spec", filename),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    `Could not locate spec/${filename}. Run "npm run build:spec" to generate it. Looked in:\n  ${candidates.join("\n  ")}`,
  );
}

let indexCache: SpecIndex | undefined;

export function getSpecIndex(): SpecIndex {
  if (!indexCache) {
    indexCache = JSON.parse(readFileSync(locate("index.json"), "utf8")) as SpecIndex;
  }
  return indexCache;
}

/** The full OpenAPI document, loaded lazily — it is ~900 KB and most sessions never need it. */
let rawSpecCache: RawSpec | undefined;

type RawSpec = {
  paths: Record<string, Record<string, RawOperation>>;
  components?: { schemas?: Record<string, unknown> };
  [key: string]: unknown;
};

type RawOperation = {
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
  deprecated?: boolean;
};

function getRawSpec(): RawSpec {
  if (!rawSpecCache) {
    rawSpecCache = JSON.parse(readFileSync(locate("reai-openapi.json"), "utf8")) as RawSpec;
  }
  return rawSpecCache;
}

export type SearchOptions = {
  query?: string;
  tag?: string;
  method?: string;
  includeInternal?: boolean;
  limit?: number;
};

export type SearchHit = SpecOperation & { score: number };

/**
 * Keyword search over the operation index.
 *
 * Deliberately not fuzzy: agents search with domain words ("credit note", "bank
 * reconciliation", "mva"), and substring-plus-token scoring over path, tag,
 * summary and description handles those far more predictably than edit distance,
 * which tends to match unrelated short paths.
 */
export function searchOperations(opts: SearchOptions): SearchHit[] {
  const index = getSpecIndex();
  const limit = clamp(opts.limit ?? 25, 1, 200);
  const wantMethod = opts.method?.toUpperCase();
  const wantTag = opts.tag?.toLowerCase();
  const terms = tokenize(opts.query ?? "");

  const hits: SearchHit[] = [];
  for (const op of index.operations) {
    if (!opts.includeInternal && op.internal) continue;
    if (wantMethod && op.method !== wantMethod) continue;
    if (wantTag && op.tag.toLowerCase() !== wantTag && !op.tags.some((t) => t.toLowerCase() === wantTag)) {
      continue;
    }

    let score = 0;
    if (terms.length === 0) {
      score = 1;
    } else {
      const haystacks: Array<[string, number]> = [
        [op.path.toLowerCase(), 6],
        [op.tag.toLowerCase(), 5],
        [(op.summary ?? "").toLowerCase(), 4],
        [(op.description ?? "").toLowerCase(), 2],
        [op.id.toLowerCase(), 3],
      ];
      const phrase = terms.join(" ");
      for (const [text, weight] of haystacks) {
        if (!text) continue;
        if (terms.length > 1 && text.includes(phrase)) score += weight * 3;
        for (const term of terms) if (text.includes(term)) score += weight;
      }
      // A collection endpoint is the more useful answer to a vague query than a
      // deeply nested sub-resource, so mildly prefer shallow paths.
      if (score > 0) score += Math.max(0, 4 - op.path.split("/").length) * 0.5;
      if (op.deprecated) score -= 3;
    }

    if (score > 0) hits.push({ ...op, score: round2(score) });
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return hits.slice(0, limit);
}

export function findOperation(methodOrId: string, path?: string): SpecOperation | undefined {
  const index = getSpecIndex();
  if (path) {
    const m = methodOrId.toUpperCase();
    const normalized = normalizePath(path);
    return index.operations.find((o) => o.method === m && normalizePath(o.path) === normalized);
  }
  const needle = methodOrId.toLowerCase();
  return index.operations.find((o) => o.id.toLowerCase() === needle);
}

export type DescribedOperation = {
  id: string;
  method: HttpMethod;
  path: string;
  tag: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  internal: boolean;
  parameters: SpecParam[];
  requestBody?: { contentType: string; schema: unknown };
  responses: Array<{ status: string; description?: string; schema?: unknown }>;
  /**
   * Known quirks for this operation. Listed first in the tool output because a
   * schema alone has repeatedly proved insufficient — several of these were
   * learned from a 400 or from a surprising success.
   */
  quirks?: Array<{ kind: Quirk["kind"]; note: string }>;
};

/**
 * Full detail for one operation, with `$ref`s resolved. Schemas are expanded to a
 * bounded depth — some ReAI schemas are recursive, and an agent needs the shape,
 * not a 200 KB fully-inlined tree.
 */
export function describeOperation(op: SpecOperation, maxDepth = 4): DescribedOperation {
  const spec = getRawSpec();
  const raw = spec.paths?.[op.path]?.[op.method.toLowerCase()];
  const pathLevel = (spec.paths?.[op.path] as { parameters?: unknown[] } | undefined)?.parameters;
  const ctx = { spec, maxDepth };

  const parameters: SpecParam[] = [];
  const seen = new Set<string>();
  for (const rawParam of [...(pathLevel ?? []), ...(raw?.parameters ?? [])]) {
    const p = deref(rawParam, ctx) as {
      name?: string;
      in?: SpecParam["in"];
      required?: boolean;
      description?: string;
      schema?: unknown;
    };
    if (!p?.name) continue;
    if (p.in === "header" && p.name.toLowerCase() === "x-tenant-id") continue;
    const key = `${p.in}:${p.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const schema = deref(p.schema, ctx) as { type?: unknown; enum?: unknown[]; format?: string };
    parameters.push({
      name: p.name,
      in: p.in ?? "query",
      required: p.required === true,
      type: describeType(schema),
      ...(p.description ? { description: p.description } : {}),
    });
  }

  const knownQuirks = quirksFor(op.method, op.path);

  const result: DescribedOperation = {
    // Quirks first, deliberately: a resolved response schema runs to hundreds of
    // lines, and anything placed after it is effectively hidden.
    ...(knownQuirks.length > 0
      ? { quirks: knownQuirks.map((q) => ({ kind: q.kind, note: q.note })) }
      : {}),
    id: op.id,
    method: op.method,
    path: op.path,
    tag: op.tag,
    internal: op.internal,
    parameters,
    responses: [],
    ...(op.summary ? { summary: op.summary } : {}),
    ...(raw?.description ? { description: raw.description } : {}),
    ...(op.deprecated ? { deprecated: true } : {}),
  };

  const rb = deref(raw?.requestBody, ctx) as { content?: Record<string, { schema?: unknown }> } | undefined;
  if (rb?.content) {
    const [contentType, media] = Object.entries(rb.content)[0] ?? [];
    if (contentType) {
      result.requestBody = { contentType, schema: expand(media?.schema, ctx, 0) };
    }
  }

  for (const [status, rawRes] of Object.entries(raw?.responses ?? {})) {
    const res = deref(rawRes, ctx) as
      | { description?: string; content?: Record<string, { schema?: unknown }> }
      | undefined;
    const media = res?.content ? Object.values(res.content)[0] : undefined;
    result.responses.push({
      status,
      ...(res?.description ? { description: res.description } : {}),
      ...(media?.schema ? { schema: expand(media.schema, ctx, 1) } : {}),
    });
  }

  return result;
}

type Ctx = { spec: RawSpec; maxDepth: number };

function deref(node: unknown, ctx: Ctx, seen = new Set<string>()): unknown {
  if (!node || typeof node !== "object" || !("$ref" in (node as object))) return node;
  const ref = String((node as { $ref: string }).$ref);
  if (seen.has(ref)) return { $circular: ref };
  seen.add(ref);
  let cur: unknown = ctx.spec;
  for (const part of ref.replace(/^#\//, "").split("/")) {
    cur = (cur as Record<string, unknown> | undefined)?.[decodeURIComponent(part)];
    if (cur === undefined) return {};
  }
  return deref(cur, ctx, seen);
}

/** Recursively inline `$ref`s up to `maxDepth`, then degrade to a type name. */
function expand(node: unknown, ctx: Ctx, depth: number, seen = new Set<string>()): unknown {
  if (node === null || typeof node !== "object") return node;

  if ("$ref" in (node as object)) {
    const ref = String((node as { $ref: string }).$ref);
    const name = ref.split("/").pop() ?? ref;
    if (seen.has(ref)) return { type: "object", $ref: name, note: "recursive reference, not expanded" };
    if (depth >= ctx.maxDepth) return { type: "object", $ref: name, note: "max depth reached" };
    const nextSeen = new Set(seen);
    nextSeen.add(ref);
    return expand(deref(node, ctx), ctx, depth + 1, nextSeen);
  }

  if (Array.isArray(node)) return node.map((n) => expand(n, ctx, depth, seen));

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    // Verbose, low-signal keys. `example` in particular can be enormous.
    if (key === "example" || key === "examples" || key === "xml") continue;
    out[key] = expand(value, ctx, depth, seen);
  }
  return out;
}

function describeType(schema: { type?: unknown; enum?: unknown[]; format?: string } | undefined): string {
  if (!schema) return "string";
  const t = schema.type;
  let base: string;
  if (Array.isArray(t)) {
    const nullable = t.includes("null");
    const rest = t.filter((x) => x !== "null");
    base = (rest.length === 1 ? String(rest[0]) : rest.join("|") || "any") + (nullable ? "?" : "");
  } else {
    base = typeof t === "string" ? t : "string";
  }
  if (schema.enum) {
    return `enum(${schema.enum
      .filter((e) => e !== null)
      .slice(0, 12)
      .join("|")})`;
  }
  if (schema.format) base = `${base.replace("?", "")}(${schema.format})${base.endsWith("?") ? "?" : ""}`;
  return base;
}

/** `/api/customers/{id}` and `/api/customers/{customerId}` describe the same route shape. */
function normalizePath(path: string): string {
  return path.replace(/\{[^}]+\}/g, "{}").replace(/\/+$/, "").toLowerCase();
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9æøå]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

const STOPWORDS = new Set(["the", "a", "an", "of", "for", "to", "in", "on", "and", "or", "api", "get", "all"]);

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Exposed for tests: drop cached spec state so fixtures take effect. */
export function __resetSpecCaches(): void {
  indexCache = undefined;
  rawSpecCache = undefined;
}
