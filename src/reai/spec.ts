import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { HttpMethod } from "./client.js";
import { quirksFor, type Quirk } from "./quirks.js";
import { classifyRequest } from "../policy.js";

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
  const rawTerms = tokenize(opts.query ?? "");
  const { terms, resourceCount } = expandQuery(opts.query ?? "");
  // An explicit method filter already narrows the results, so the verb hint would
  // only add noise on top of it.
  const impliedMethods = wantMethod ? undefined : impliedMethodsFor(rawTerms);
  const writeIntent = !wantMethod && hasWriteIntent(rawTerms);

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
      const haystacks: Array<[string, number, boolean?]> = [
        [op.path.toLowerCase(), 6],
        [op.tag.toLowerCase(), 5],
        [(op.summary ?? "").toLowerCase(), 4, true],
        [(op.description ?? "").toLowerCase(), 2, true],
        [op.id.toLowerCase(), 3],
        // Parameter and body field names say what an endpoint is ABOUT, often more
        // plainly than its prose. "employee hours on a project" was landing on the
        // employee ledger, when /api/timesheets is the endpoint that actually takes
        // projectId and employeeId — the names were there, just never scored.
        [fieldNamesOf(op), 3],
      ];
      const phrase = rawTerms.join(" ");
      const matchedResourceTerms = new Set<string>();
      // Prose is corroborating evidence, not primary, so its contribution is
      // capped. `/api/employees` carries no summary at all, while
      // `/api/ledger/employee` has "List employee ledgers" — so an uncapped
      // summary plus description was worth as much as the whole path and put a
      // reporting view above the endpoint that actually creates an employee.
      // Verbose documentation should not outrank being the right resource.
      let prose = 0;
      for (const [text, weight, isProse] of haystacks) {
        if (!text) continue;
        const tokens = fieldTokens(text);
        let contribution = 0;
        if (rawTerms.length > 1 && text.includes(phrase)) contribution += weight * 3;
        for (const { term, weight: termWeight } of terms) {
          const strength = matchStrength(text, tokens, term);
          if (strength === 0) continue;
          contribution += weight * strength * termWeight;
          // A 0.2 bare-substring hit is noise and must not buy the coverage
          // multiplier: "end" inside "endpoint" in a boilerplate description was
          // enough to lift DELETE /api/projects/{id} above POST and GET /api/projects.
          if (termWeight >= 1 && strength >= 0.6) matchedResourceTerms.add(term);
        }
        if (isProse) prose += contribution;
        else score += contribution;
      }
      // Covering more of what the user actually named matters more than matching
      // one word repeatedly across several fields. Without this, an endpoint whose
      // long description happens to mention one query word many times outranks the
      // endpoint that is simply about the thing being asked for.
      if (resourceCount > 0 && matchedResourceTerms.size > 0) {
        score *= 1 + 0.6 * ((matchedResourceTerms.size - 1) / resourceCount);
      }
      // Added after the multiplier, so PROSE_CAP is the bound it claims to be
      // rather than a pre-multiplier figure that could grow to 4.8.
      score += Math.min(prose, PROSE_CAP);
      // A collection endpoint is the more useful answer to a vague query than a
      // deeply nested sub-resource, so mildly prefer shallow paths.
      if (score > 0) score += Math.max(0, 4 - op.path.split("/").length) * 0.5;
      // Naming the resource in the LAST path segment is the strongest evidence that
      // this endpoint IS that resource, rather than something hanging off it. A
      // 0.5 shallow-path nudge was no match for a capped 3 points of prose, so
      // "users" returned /api/users/permissions and "chart of accounts" returned
      // /api/chart-of-accounts/accounts — both beating the collection purely by
      // being documented.
      if (score > 0 && matchedResourceTerms.size > 0) {
        const lastSegment = op.path.split("/").filter((seg) => seg && !seg.startsWith("{")).pop() ?? "";
        // The segment must BE the resource, not merely contain the word. Accepting
        // a token match made "invoice-reception-documents" count as a hit for
        // "documents" and tie with /api/documents itself.
        const segmentForms = fieldTokens(lastSegment.replace(/-/g, " "));
        const isExactly = (term: string) =>
          lastSegment === term || (segmentForms.has(term) && !lastSegment.includes("-"));
        for (const term of matchedResourceTerms) {
          if (isExactly(term)) {
            // Deliberately larger than PROSE_CAP: being the resource must outweigh
            // merely being well documented about it, which is how
            // /api/invoice-reception-documents edged out /api/documents.
            score += IDENTITY_BONUS;
            break;
          }
        }
      }
      // A verb in the query says which METHOD is wanted: "register a new employee"
      // should reach POST /api/employees rather than the read-only employee ledger,
      // and "delete a customer" should surface the DELETE.
      //
      // With no verb, the default is GET. A query with no stated intent is a
      // question, and in an accounting API the cost of guessing wrong is asymmetric
      // — "salary payment" was returning POST /api/salary-payments/{id}/complete
      // first, which finalises payroll and starts an A-melding submission to
      // Skatteetaten. DELETE is penalised harder still, since nothing about a
      // neutral question suggests destroying a record.
      //
      // This is a nudge, not a filter: verbs are often absent or ambiguous. Use the
      // explicit `method` option when certainty matters.
      // Ranking by risk, not by guessing intent from verbs.
      //
      // My first attempt inferred the wanted METHOD from verbs in the query and
      // nudged scores by a fixed amount. Measured on held-out read questions it
      // made things WORSE than no heuristic at all — 13 of 25 ranked a write first
      // versus 10 before — because verbs appear in read questions constantly:
      // "which invoices did we cancel" set the intent to DELETE and filled the
      // whole top three with deletions, and "how many new employees this year"
      // became POST /api/employees. A small additive nudge also loses to the
      // multiplicative coverage bonus, so "unpaid invoices" still returned
      // POST /api/invoices/{id}/reminders/forgive, which waives real fees.
      //
      // So: only an UNAMBIGUOUS write verb licenses a write. Otherwise the answer
      // to a question is a read, and the demotion is proportional to what the
      // operation would do — using the same classification the write policy
      // enforces, rather than a second guess about methods. The penalty is
      // multiplicative so it cannot be outrun by a high raw score, which is how
      // POST /api/salary-payments/{id}/complete kept winning "is the salary
      // payment complete" — the phrasing that motivated the whole heuristic.
      // A write request demotes reads, mirroring the way a question demotes writes.
      // Boosting the write alone was not enough: "post a voucher" still returned
      // GET /api/vouchers, which simply carried a higher base score.
      if (score > 0 && !wantMethod && writeIntent && op.method === "GET") score *= 0.7;
      if (score > 0 && !wantMethod && op.method !== "GET") {
        const risk = classifyRequest(op.method, op.path);
        if (writeIntent) {
          // The user asked to change something. Where their verb names a specific
          // method, other writes are DEMOTED rather than given a smaller boost:
          // giving every write +0.5 meant "create fixed asset" ranked
          // DELETE /api/assets/{id} above POST /api/assets.
          if (impliedMethods) score = impliedMethods.has(op.method) ? score + 2 : score * 0.7;
          else score += 0.5;
        } else if (risk === "irreversible") {
          score *= 0.4;
        } else {
          score *= 0.7;
        }
      }
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

/**
 * Words carrying no signal about WHICH endpoint is wanted.
 *
 * Agents ask questions rather than typing keywords ("how do I register a new
 * employee"), and every filler word here was matching substrings in unrelated
 * paths: "exist" hit `/attachments/existing`, "what" and "new" hit assorted
 * descriptions. Since scores accumulate per matching term, that noise was enough
 * to put three supplier-invoice endpoints above `/api/departments` for a query
 * whose main word was "departments".
 */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "to", "in", "on", "and", "or", "api", "get", "all",
  // Question and filler words.
  "how", "do", "does", "did", "what", "which", "who", "when", "where", "why",
  "is", "are", "was", "be", "can", "could", "should", "would", "will",
  "i", "we", "my", "our", "us", "me", "you", "your",
  "this", "that", "these", "those", "there", "then", "than",
  "with", "from", "by", "at", "as", "it", "its", "if", "so", "any", "some",
  "want", "need", "please", "about", "into", "out", "up", "down", "again",
  "exist", "exists", "s",
]);

/**
 * Terms describing an ACTION rather than a resource.
 *
 * "register a new employee" wants `/api/employees`, but "register" substring-
 * matched `/api/receipt-reception-documents/{id}/registration` just as strongly as
 * "employee" matched `/api/employees`, so the wrong endpoint won. A verb in the
 * query says something about the METHOD, not about which resource is meant, so it
 * is scored at a fraction of a resource word. The `method` filter is the right way
 * to express intent.
 */
const VERB_TERMS = new Set([
  "register", "registered", "create", "created", "add", "new", "make", "post",
  "update", "change", "edit", "modify", "patch", "put",
  "delete", "remove", "cancel",
  "list", "show", "find", "search", "fetch", "read", "view", "see", "look",
  "set", "run", "send", "start", "book", "record", "enter", "submit",
]);
const VERB_WEIGHT = 0.25;

/** Prose (summary + description) cannot contribute more than this in total. */
const PROSE_CAP = 3;

/** Awarded when the final path segment IS the resource asked for. */
const IDENTITY_BONUS = 3.5;

/** Terms contributed by an explicit phrase mapping are high-confidence. */
const PHRASE_WEIGHT = 2.6;

/**
 * Verbs that indicate which HTTP method the user means. Absent or ambiguous
 * verbs simply yield no hint.
 */
const METHOD_INTENT: ReadonlyArray<readonly [readonly string[], readonly HttpMethod[]]> = [
  // Kept in step with WRITE_INTENT_VERBS: a word that licenses a write should also
  // say which method, or the write it asked for gets only the weak generic bonus
  // and a GET on the same resource still wins ("post a voucher" returned
  // GET /api/vouchers).
  [["register", "registered", "create", "created", "add", "new", "make", "submit", "start", "post", "book", "enter", "record", "close", "pay", "issue", "upload", "file", "settle"], ["POST"]],
  [["update", "change", "edit", "modify", "rename"], ["PUT", "PATCH"]],
  [["delete", "remove", "cancel"], ["DELETE"]],
  [["list", "show", "find", "search", "fetch", "read", "view", "see", "which", "what"], ["GET"]],
];

/**
 * Verbs that unambiguously ask to CHANGE something.
 *
 * Deliberately much narrower than VERB_TERMS. Every word left out was left out for
 * a measured reason: "cancel" appears in "which invoices did we cancel", "new" in
 * "how many new employees this year", "start" in "when does the subscription
 * start", "complete" in "is the salary payment complete". Treating any of those as
 * a licence to rank a write first is what made the earlier heuristic worse than
 * having none.
 */
const WRITE_INTENT_VERBS = new Set([
  "create", "register", "add", "delete", "remove", "update", "edit", "modify",
  "rename", "upload", "pay", "issue", "credit", "reverse", "settle", "file",
  // Safe as exact tokens: "postings" and "submission" tokenize to themselves, so
  // these do not fire on the read phrasings that broke the earlier heuristic.
  "post", "book", "close", "enter", "record", "submit",
  "opprett", "slett", "endre", "registrer",
]);

function hasWriteIntent(tokens: readonly string[]): boolean {
  return tokens.some((t) => WRITE_INTENT_VERBS.has(t));
}

function impliedMethodsFor(tokens: readonly string[]): Set<HttpMethod> | undefined {
  // Counted by GROUP, not by resulting method. Allowing any set of up to two
  // methods let "list and delete customers" produce {GET, DELETE} — which then
  // exempted DELETE from its penalty and ranked DELETE /api/customers/{id} first,
  // the opposite of what the comment promised. One update group legitimately maps
  // to two methods (PUT and PATCH), so the limit belongs on groups.
  const groups = new Set<number>();
  const methods = new Set<HttpMethod>();
  METHOD_INTENT.forEach(([verbs, ms], index) => {
    if (tokens.some((t) => verbs.includes(t))) {
      groups.add(index);
      for (const m of ms) methods.add(m);
    }
  });
  return groups.size === 1 ? methods : undefined;
}

/**
 * Domain vocabulary mapped onto the API's own words.
 *
 * The API names a thing once; users name it several ways. An accountant says
 * "payroll" where the API says salary-payments, "cost centre" where it says
 * department, and "recurring invoice" where it says subscription — and every one
 * of those missed the right endpoint entirely before this existed. Norwegian terms
 * are here for the same reason: the books are Norwegian even when the API is
 * English.
 *
 * Expansions are additive, so the original term still scores; this only widens
 * what can match.
 */
const PHRASE_SYNONYMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bcost\s*(centre|center)s?\b/g, "department"],
  // Maps to the resource only. Injecting "depreciation" here made the nested
  // write endpoint dominate: even "create fixed asset" ranked
  // PUT /api/assets/{id}/depreciation above POST /api/assets. A user who means
  // depreciation says so, and that word matches on its own.
  [/\bfixed\s+assets?\b/g, "asset"],
  [/\b(recurring|repeating)\b[^.]{0,24}\b(invoice|billing)/g, "subscription"],
  [/\bcredit\s+notes?\b/g, "credit invoice"],
  [/\bopening\s+balances?\b/g, "opening-balances"],
  [/\bannual\s+accounts?\b/g, "annual-accounts"],
  [/\bprofit\s+and\s+loss\b/g, "result income statement"],
  [/\btrial\s+balance\b/g, "ledger balance"],
  [/\bchart\s+of\s+accounts\b/g, "chart-of-accounts"],
  [/\bcash\s+register\b/g, "kassasystem"],
];

const TERM_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  payroll: ["salary", "salary-payments"],
  wages: ["salary"],
  wage: ["salary"],
  lonn: ["salary"],
  salaries: ["salary"],
  hours: ["timesheet"],
  hour: ["timesheet"],
  timetracking: ["timesheet"],
  recurring: ["subscription"],
  repeating: ["subscription"],
  monthly: ["subscription", "period"],
  inventory: ["warehouse"],
  stock: ["warehouse"],
  contract: ["agreement"],
  contracts: ["agreement"],
  signing: ["sign", "agreement"],
  vat: ["vat", "mva"],
  mva: ["vat"],
  reskontro: ["ledger"],
  bilag: ["voucher"],
  faktura: ["invoice"],
  kunde: ["customer"],
  leverandor: ["supplier"],
  ansatt: ["employee"],
  konto: ["account"],
  staff: ["employee"],
  personnel: ["employee"],
  employees: ["employee"],
  department: ["department"],
  reminder: ["reminders", "dunning"],
  bank: ["bank", "company-banks"],
  melding: ["return", "returns"],
  owes: ["ledger", "unpaid", "customer"],
  owe: ["ledger", "unpaid", "customer"],
  outstanding: ["unpaid", "ledger"],
  receivable: ["customer", "ledger", "unpaid"],
  receivables: ["customer", "ledger", "unpaid"],
  payable: ["supplier", "ledger", "unpaid"],
  payables: ["supplier", "ledger", "unpaid"],
  overdue: ["unpaid", "due", "reminders"],
  reconcile: ["reconciliation"],
  reconciling: ["reconciliation"],
};

/**
 * Turn a natural-language query into the terms to score against, each carrying a
 * weight. Returns resource terms and verb terms separately so coverage can be
 * measured over the ones that actually identify an endpoint.
 */
function expandQuery(query: string): { terms: Array<{ term: string; weight: number }>; resourceCount: number } {
  const text = query.toLowerCase();
  // A phrase mapping is a deliberate, high-confidence statement that a user's
  // words mean a particular resource ("recurring monthly invoice" -> subscription),
  // so the terms it contributes outweigh a word that merely happens to appear.
  // Without that, "invoice" in the query kept /api/invoices and the reception inbox
  // above /api/subscriptions.
  const phraseTerms: string[] = [];
  for (const [pattern, replacement] of PHRASE_SYNONYMS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) phraseTerms.push(...replacement.split(" "));
    pattern.lastIndex = 0;
  }

  const seen = new Set<string>();
  const terms: Array<{ term: string; weight: number }> = [];
  let resourceCount = 0;
  const push = (term: string, weight: number) => {
    if (term.length < 2 || seen.has(term)) return;
    seen.add(term);
    terms.push({ term, weight });
    if (weight >= 1) resourceCount += 1;
  };

  for (const term of phraseTerms) push(term, PHRASE_WEIGHT);
  for (const token of tokenize(text)) {
    const isVerb = VERB_TERMS.has(token);
    const weight = isVerb ? VERB_WEIGHT : 1;
    push(token, weight);
    // The token's OWN synonyms first. Looking these up only for derived variants
    // silently disabled the whole table for any word with no variant -- "mva"
    // stopped reaching vat-codes entirely, and "payroll" stopped reaching salary.
    for (const syn of TERM_SYNONYMS[token] ?? []) push(syn, weight);
    // Then the normalised forms, because the keys are ASCII and singular while
    // "lønn", "leverandør", "ansatte" and "kunder" are what people actually type.
    for (const variant of lookupForms(token)) {
      push(variant, weight);
      for (const syn of TERM_SYNONYMS[variant] ?? []) push(syn, weight);
    }
  }
  return { terms, resourceCount };
}

/**
 * How well one term matches one field, from 1 (the field contains that exact
 * word) down to a small credit for a bare substring.
 *
 * Plain `includes` treated "register" inside "registration" as a full match,
 * which is how a receipt-registration endpoint beat `/api/employees`. Ranking a
 * whole-word hit above a fragment is what separates the two.
 */
export function matchStrength(haystack: string, haystackTokens: ReadonlySet<string>, term: string): number {
  if (haystackTokens.has(term)) return 1;
  for (const token of haystackTokens) {
    // Plural and inflected forms: "department" in "departments". Restricted to
    // reasonably long terms so short fragments do not sweep up everything.
    if (term.length >= 4 && token.startsWith(term)) return 0.75;
    if (token.length >= 4 && term.startsWith(token)) return 0.6;
  }
  return haystack.includes(term) ? 0.2 : 0;
}

/**
 * Parameter and body field names as one searchable string, camelCase split so
 * "projectId" contributes both "project" and "id". Cached per operation because
 * search walks all 430 of them on every query.
 */
const fieldNameCache = new WeakMap<SpecOperation, string>();

function fieldNamesOf(op: SpecOperation): string {
  const cached = fieldNameCache.get(op);
  if (cached !== undefined) return cached;
  const names: string[] = [];
  // Path parameters are skipped deliberately: `{employeeId}` only restates what
  // the path already says, and counting it twice made
  // `/api/ledger/employee/{employeeId}` outrank `/api/employees` for "register a
  // new employee". Query parameters and body fields carry genuinely new
  // information — they are why /api/timesheets answers a question about an
  // employee's hours on a project.
  for (const p of op.params ?? []) if (p.in !== "path") names.push(p.name);
  // Body fields are deliberately excluded. Only writes have a body, so scoring
  // field names handed every POST and PUT a bonus no GET could earn — which put
  // POST /api/supplier-invoices above the GET for the bare query "supplier
  // invoice", and POST /api/salary-payments/{id}/complete above the GET for
  // "salary payment". Query parameters carry the same descriptive value without
  // being tied to a method.
  const text = names
    .join(" ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
  fieldNameCache.set(op, text);
  return text;
}

/** æøå -> aoa, so an ASCII synonym key matches what a Norwegian user types. */
function foldDiacritics(term: string): string {
  return term.replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a");
}

/** The forms of a query token worth trying against the synonym table. */
function lookupForms(token: string): string[] {
  const forms = new Set<string>();
  const add = (t: string) => {
    if (t.length > 1 && t !== token) forms.add(t);
  };
  const folded = foldDiacritics(token);
  add(folded);
  for (const base of [token, folded]) {
    if (base.endsWith("ies") && base.length > 4) add(`${base.slice(0, -3)}y`);
    else if (base.endsWith("er") && base.length > 4) {
      add(base.slice(0, -2));
      // Norwegian plurals are -er on a stem that already ends in -e: "kunder" is
      // "kunde", not "kund", and only the former is a synonym key.
      add(base.slice(0, -1));
    } else if (base.endsWith("e") && base.length > 4) add(base.slice(0, -1));
    if (base.endsWith("s") && !base.endsWith("ss") && base.length > 3) add(base.slice(0, -1));
  }
  return [...forms];
}

const FIELD_TOKENS = /[^a-z0-9æøå]+/;

/**
 * Field tokens, with a singular form added for plurals.
 *
 * REST collections are plural, so `/api/employees` tokenizes to "employees" while
 * a user searches for "employee" — which scored only as an inflected match, below
 * the exact hit that `/api/ledger/employee` got for the same word. The collection
 * endpoint was losing to a sub-view precisely because it followed the convention.
 * Adding the stem makes the collection an exact match, which is nearly always the
 * answer the user wanted.
 */
export function fieldTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of text.split(FIELD_TOKENS)) {
    if (token.length <= 1) continue;
    tokens.add(token);
    if (token.endsWith("ies") && token.length > 4) tokens.add(`${token.slice(0, -3)}y`);
    else if (token.endsWith("ses") && token.length > 4) tokens.add(token.slice(0, -2));
    else if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
      tokens.add(token.slice(0, -1));
    }
  }
  return tokens;
}

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
