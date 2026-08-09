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
  /**
   * Whether the request body may be omitted at all — distinct from which of its
   * properties are required. 51 operations declare a mandatory body whose every
   * property is optional, so an empty `required` array is not evidence that the
   * body itself is optional.
   */
  bodyRequired?: boolean;
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
  // A phrase wins over the token tables when both speak, because it is the more specific statement:
  // "last opp" is an upload whatever `last` means alone.
  const phraseMethods = wantMethod ? undefined : phraseMethodsFor(opts.query ?? "");
  const impliedMethods = phraseMethods ?? (wantMethod ? undefined : impliedMethodsFor(rawTerms));
  const writeIntent =
    !wantMethod &&
    (hasWriteIntent(rawTerms) ||
      // A phrase that implies a writing method is a write intent, or the endpoint it names gets only
      // the weak generic bonus and a GET on the same resource still wins — the failure METHOD_INTENT's
      // own comment describes.
      [...(phraseMethods ?? [])].some((m) => m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE"));

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

/**
 * Resolve a CONCRETE path — one with real ids substituted — back to its spec
 * operation.
 *
 * `findOperation` compares templates to templates, so "/api/customers/1234" matched
 * nothing at all. That mattered because the escape hatch only ever sees concrete
 * paths: an agent calling `reai_request` could not be shown the schema or the known
 * quirks for the very endpoint it was calling.
 *
 * A literal segment is preferred over a placeholder at the same position, so
 * "/api/vat-returns/reopen" resolves to the literal operation rather than to a
 * "/api/vat-returns/{id}"-shaped one.
 */
export function resolveOperation(method: string, concretePath: string): SpecOperation | undefined {
  const index = getSpecIndex();
  const wantMethod = method.toUpperCase();
  // Only the leading empty segment (from the leading slash) is dropped. Interior
  // empties are KEPT, because the client transmits "/api//opening-balances"
  // verbatim: filtering them made that resolve to the real operation, and the
  // enrichment then answered a 404 with "nothing has been set up yet" instead of
  // "your path is wrong". That is exactly the bug fixed for case-folding just below,
  // reintroduced through a different normalisation.
  const trimmed = concretePath.split("?")[0]?.replace(/\/+$/, "") ?? "";
  const wanted = trimmed.split("/");
  if (wanted[0] === "") wanted.shift();

  let best: SpecOperation | undefined;
  let bestLiterals = -1;
  for (const op of index.operations) {
    if (op.method !== wantMethod) continue;
    const segments = op.path.replace(/\/+$/, "").split("/").filter(Boolean);
    if (segments.length !== wanted.length) continue;

    let literals = 0;
    let matches = true;
    for (let i = 0; i < segments.length; i++) {
      const spec = segments[i] ?? "";
      const actual = wanted[i] ?? "";
      if (spec.startsWith("{") && spec.endsWith("}")) {
        // A placeholder matches, but not unconditionally: the index carries the
        // declared type, and every colliding path parameter in this spec is an
        // integer. Rejecting a non-numeric segment removes the ambiguity between
        // "/api/users/{id}" and "/api/users/permissions" at the source, instead of
        // leaving it to a tie-break whose correctness depended on the order
        // operations happen to sit in the index.
        const name = spec.slice(1, -1);
        const declared = (op.params ?? []).find((prm) => prm.in === "path" && prm.name === name);
        if (declared && /^integer|^number/.test(declared.type) && !/^-?\d+$/.test(actual)) {
          matches = false;
          break;
        }
        continue;
      }
      // Compared EXACTLY, because the client sends the path through unchanged and
      // the API's routes are case-sensitive. Folding case here meant a typo like
      // "/API/opening-balances" — which really 404s — resolved to the real
      // operation, and the enrichment then attached its empty-state quirk and told
      // the agent nothing had been set up, hiding the invalid path.
      if (spec !== actual) {
        matches = false;
        break;
      }
      literals += 1;
    }
    if (!matches) continue;
    // More literal segments means a more specific match.
    if (literals > bestLiterals) {
      best = op;
      bestLiterals = literals;
    }
  }
  return best;
}

/**
 * Required parameters and top-level body fields the spec declares but the call
 * omitted.
 *
 * Advisory only, and deliberately so: this spec UNDER-states requirements in
 * places — startDate on /api/vouchers is required by the API and not marked so —
 * which means it may over-state elsewhere too. Refusing a call on its authority
 * could block one that would have worked, so this is used to explain a failure
 * after the fact rather than to prevent the request.
 */
/**
 * The documented body fields a full-replacement write LEAVES OUT — the ones it will clear.
 *
 * `missingRequired` answers "what does this call lack that the API demands". This answers the
 * opposite and more dangerous question: what does the caller not mention, on an endpoint that
 * replaces rather than patches, so the API stores nothing for it.
 *
 * Written because that bug class has now been found five times by hand, each time on a live
 * tenant and each time after the damage: a company bank whose account number was emptied by a
 * rename, a creditor the same way, a lease whose rent and deposit went null while GET /pdf still
 * answered 200, a subscription that lost its delivery address and half its lines, and a wage line
 * whose comment disappeared. Every one was a PUT where the intent was to change one field.
 *
 * The curated tools that wrap those endpoints now read-merge-write. The other sixteen replacement
 * endpoints in this document have no tool at all and are reached through `reai_request`, which
 * cannot merge on the caller's behalf — so the honest thing is to refuse and name what would go.
 *
 * Only PUT. Measured, PATCH on this API really patches: a PATCH carrying only `phone` left an
 * employee's address, bank account, start date and employment lines untouched, and the customer
 * and supplier PATCHes say so in their own descriptions. Applying this to PATCH would refuse
 * ordinary partial updates on the strength of a rule that does not hold there.
 *
 * Required fields are excluded deliberately: the API rejects a body missing one, so `missingRequired`
 * already explains it and naming it twice would bury the fields that get silently dropped.
 */
/**
 * The operation a request will actually reach, resolved from every form of the path it might route as.
 *
 * ReAI decodes before routing — measured: `GET /api/company%2Dbanks` and `GET /api/employe%65s`
 * both answer 200 — while `resolveOperation` matches the literal string it is given, so an encoded
 * path resolves to nothing. That is harmless for a note and not harmless for a gate: the write
 * policy already classifies on both forms and takes the stricter, and the omission gate was
 * resolving only the raw one, so a percent-encoded PUT skipped it entirely and could clear an
 * account number exactly as the gate exists to prevent. Found in review.
 *
 * Returns the first form that resolves, preferring whichever is passed first.
 */
export function resolveRoutedOperation(
  method: HttpMethod,
  ...paths: readonly string[]
): SpecOperation | undefined {
  for (const candidate of paths) {
    const op = resolveOperation(method, candidate);
    if (op) return op;
  }
  return undefined;
}

export function omittedReplacementFields(
  op: SpecOperation,
  body: unknown,
): { fields: string[]; documented: number } {
  if (op.method !== "PUT") return { fields: [], documented: 0 };
  const documented = Object.keys(op.body?.fields ?? {});
  if (documented.length === 0) return { fields: [], documented: 0 };
  // A non-object body cannot be compared field by field. Reported as nothing omitted rather than
  // as everything omitted: the API will reject a malformed body on its own, and a refusal listing
  // every documented field would read as this server's rule rather than as the shape being wrong.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { fields: [], documented: documented.length };
  }
  const required = new Set(op.body?.required ?? []);
  // Case-insensitively, and the comment here used to say the opposite of what the code does: it
  // claimed a mis-cased key is NOT supplied and should be reported as omitted. The code lowercases
  // both sides, so a mis-cased key counts as supplied and is not reported — which is the right
  // behaviour, for the reason missingRequired states 50 lines down: this is Jackson, and a mis-cased
  // body field is REJECTED with a 400 rather than silently ignored. The call never reaches the
  // record, so nothing is cleared and a warning listing the field would be a false alarm about a
  // request that cannot happen. Review caught the contradiction; the code was right, the comment was
  // describing a rule nobody implemented.
  const supplied = new Set(Object.keys(body as Record<string, unknown>).map((k) => k.toLowerCase()));
  const fields = documented.filter(
    (field) => !required.has(field) && !supplied.has(field.toLowerCase()),
  );
  return { fields, documented: documented.length };
}

export function missingRequired(
  op: SpecOperation,
  query: Record<string, unknown> | undefined,
  body: unknown,
): { params: string[]; bodyFields: string[]; bodyMissing: boolean } {
  // Names are compared case-SENSITIVELY, and the earlier rule here was the opposite.
  // It rested on ReAI being an ASP.NET API, where binding is case-insensitive by
  // default. It is not: the spec is springdoc-generated (2138 Spring `ProblemDetail`
  // refs, the literal default server description "Generated server url"), and Spring
  // binds query parameters by exact name. Measured against the live API:
  //
  //   ?voucherType=SALARY  ->  0 rows   (filter applied)
  //   ?VoucherType=SALARY  -> 38 rows   (silently ignored)
  //
  // So a mis-cased parameter does not bind — and the old rule reported it as present,
  // telling the agent its request was complete while the filter did nothing. That is
  // the worst failure mode for a preflight check: silence on a request that returns a
  // confidently wrong ANSWER rather than an error. A name that matches only when case
  // is ignored is reported as missing, with the near-miss named, because "you wrote
  // ProjectId and it wants projectId" is the whole of what the agent needs.
  const supplied = query ?? {};
  const suppliedByLower = new Map(
    Object.entries(supplied).map(([k, v]) => [k.toLowerCase(), { key: k, value: v }]),
  );
  const params = (op.params ?? [])
    .filter((p) => p.required && p.in === "query")
    .map((p) => p.name)
    .filter((name) => !isTransmittedQueryValue(supplied[name]))
    .map((name) => {
      const nearMiss = suppliedByLower.get(name.toLowerCase());
      return nearMiss && nearMiss.key !== name
        ? `${name} (you sent "${nearMiss.key}" — query parameters are case-sensitive here)`
        : name;
    });

  const bodyIsObject = typeof body === "object" && body !== null && !Array.isArray(body);
  const suppliedBodyKeys = new Set(
    bodyIsObject
      ? Object.entries(body as Record<string, unknown>)
          .filter(([, v]) => v !== undefined) // JSON.stringify drops these
          .map(([k]) => k.toLowerCase())
      : [],
  );
  // Body fields stay case-insensitive: this is Jackson, whose default is
  // case-sensitive too, but a mis-cased body field is REJECTED with a 400 rather than
  // silently ignored, so the API itself tells the agent. The query-string case is
  // different precisely because nothing complains.
  const bodyFields = (op.body?.required ?? []).filter(
    (name) => !bodyIsObject || !suppliedBodyKeys.has(name.toLowerCase()),
  );

  // A wholly absent body when the operation demands one. Reported separately
  // because the field list cannot express it: those 51 operations have a mandatory
  // body and no mandatory property inside it.
  // `null` counts as absent too: ReaiClient.request serialises a payload only when
  // the body is neither undefined nor null, so `body: null` sends nothing at all.
  const bodyMissing = op.body?.bodyRequired === true && (body === undefined || body === null);

  return { params, bodyFields, bodyMissing };
}

/**
 * Whether a query value would actually reach the API.
 *
 * Mirrors `ReaiClient.buildUrl`, which drops an array once its null and undefined
 * entries are removed and nothing is left. Treating `[]` as supplied meant a
 * required parameter that was never transmitted looked present, so the rejection
 * came back without the guidance that would explain it.
 */
function isTransmittedQueryValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.filter((v) => v !== undefined && v !== null).length > 0;
  return true;
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
    const raw = deref(p.schema, ctx) as SchemaShape & { items?: unknown };
    // An array parameter's enum lives on `items`, which may itself be a $ref.
    const schema: SchemaShape = raw?.items
      ? { ...raw, items: deref(raw.items, ctx) as SchemaShape }
      : raw;
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

type SchemaShape = { type?: unknown; enum?: unknown[]; format?: string; items?: SchemaShape };

function describeType(schema: SchemaShape | undefined): string {
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
  // Kept in step with ENUM_LIMIT in scripts/build-spec-index.mjs, and truncating is
  // marked rather than silent: a partial enum reads as exhaustive, so an agent shown
  // 12 of 16 voucher types concludes the missing four are not valid filters. Arrays
  // carry the enum on `items`.
  const enumValues = (schema.enum ?? schema.items?.enum)?.filter((e) => e !== null);
  if (enumValues?.length) {
    const shown = enumValues.slice(0, 24).join("|");
    const suffix = enumValues.length > 24 ? `|+${enumValues.length - 24} more` : "";
    return `enum(${shown}${suffix})${base.startsWith("array") ? "[]" : ""}`;
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
  // Norwegian equivalents of the fillers above. "beklager" ("sorry") earns its place
  // twice: it carries no signal about which endpoint is wanted, AND it ends in "lager",
  // so compound decomposition read a conversational apology as a question about the
  // warehouse — "beklager, hvor er abonnementene" ranked stock above subscriptions.
  "hvordan", "hva", "hvilken", "hvilke", "hvem", "naar", "hvor", "hvorfor",
  "kan", "skal", "vil", "er", "var", "har", "hadde", "blir",
  "jeg", "vi", "min", "mitt", "vaar", "vaare", "meg", "oss", "du", "din", "ditt",
  "den", "det", "dette", "disse", "der", "som", "til", "fra", "med", "paa", "av",
  "og", "eller", "ikke", "noen", "noe", "alle", "vennligst", "takk", "hei",
  "beklager", "unnskyld",
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
  // The Norwegian actions belong here too — a third table I missed, and the one that decides
  // WEIGHT. Left out, they scored as full resource words: "registrer dokumenter" ranked
  // POST /api/receipt-reception-documents/{id}/registration first, because `registrer` matched
  // that operation's registration prose instead of being discounted as the action it is.
  "opprett", "opprette", "registrer", "registrere",
  "slett", "slette", "fjern", "fjerne",
  "endre", "oppdater", "oppdatere", "rediger",
  "bokfor", "bokfore", "bokfør", "bokføre",
  "vis", "hent", "finn",
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
  [["register", "registered", "create", "created", "add", "new", "make", "submit", "start", "post", "book", "enter", "record", "close", "pay", "issue", "upload", "file", "settle",
    // Norwegian. This table had none at all, although WRITE_INTENT_VERBS already held four — so
    // "opprett kreditnota" licensed a write and then implied no method, leaving it the weak generic
    // bonus the comment above warns about. Measured: "opprett kreditnota" ranked the endpoint first
    // while "lag kreditnota" did not find it at all, and `lag` is the commoner verb of the two.
    // Both spellings, because these tables are consulted with RAW tokens rather than the
    // ASCII-folded ones TERM_SYNONYMS uses: measured, "oppdater" matched and "bokfør" did not.
    // `lag` and `lage` are NOT here, although "lag en kreditnota" is the commonest phrasing:
    // `lag` is also the everyday noun for a team, so "ansatte per lag" was being read as a create
    // and ranked POST /api/employees first. An unconditional token cannot tell the two apart, and a
    // wrongly-implied write is worse than a create verb this table happens not to know.
    "opprett", "opprette", "registrer", "registrere",
    "bokfor", "bokfore", "bokfør", "bokføre",
    // The action imperatives. Adding them to TERM_SYNONYMS alone was half a change: these tables are
    // what decide METHOD, so "aktiver abonnement" expanded to `activate`, matched the right segment,
    // and still lost to three GETs because nothing said a write was wanted. Only unambiguous
    // imperatives — the verbal nouns stay out, since "hvilke venter på godkjenning" is a question and
    // "avsluttet" is a participle that appears in one.
    // `lever`/`levere` are out for the same reason they are out of TERM_SYNONYMS: filing a return is
    // the commoner sense. `aktiver` is out because it is the noun for assets. `avslutt` is out
    // because it means terminate. Each of those would imply a write on a read question.
    "godkjenn", "godkjenne", "lukk", "lukke",
    "gjenapne", "gjenåpne", "gjenopprett", "gjenopprette", "dearkiver",
    "avskriv", "avskrive", "utranger", "utrangere", "konverter", "konvertere",
    "aktivere", "deaktiver", "deaktivere",
    "fullfor", "fullfore", "fullfør", "fullføre", "ferdigstill", "ferdigstille",
    "generer", "generere", "valider", "validere", "krediter", "kreditere", "innsend"], ["POST"]],
  [["update", "change", "edit", "modify", "rename",
    "endre", "oppdater", "oppdatere", "rediger"], ["PUT", "PATCH"]],
  [["delete", "remove", "cancel", "slett", "slette", "fjern", "fjerne"], ["DELETE"]],
  [["list", "show", "find", "search", "fetch", "read", "view", "see", "which", "what",
    // Left OUT deliberately: "betal"/"betale" (pay). A stemmer that strips -ing turns the READ
    // phrasing "hvilke betalinger" into "betal", which would license a write on a question about
    // payments — the exact false positive the note below this table was written about.
    "vis", "hent", "finn", "hvilke", "hva"], ["GET"]],
];

/**
 * Intent carried by a PHRASE rather than by a word.
 *
 * "Last opp" is upload and "last ned" is download — opposite methods, sharing a verb that means
 * neither on its own. `last` is also the noun for a load, and an English word. So neither table above
 * can hold it: the direction lives in the particle, and only the pair says anything.
 *
 * Matched against the raw query text, not the token set, because a token set has no adjacency. Same
 * reasoning as PHRASE_SYNONYMS, which exists because "skylder oss" and "skylder vi" point at opposite
 * sides of the books while sharing a verb.
 */
const PHRASE_INTENT: ReadonlyArray<readonly [RegExp, readonly HttpMethod[]]> = [
  [/\blast(e|er)?\s+opp\b/, ["POST"]],
  [/\blast(e|er)?\s+ned\b/, ["GET"]],
];

function phraseMethodsFor(query: string): Set<HttpMethod> | undefined {
  const text = query.toLowerCase();
  const matched = PHRASE_INTENT.filter(([pattern]) => pattern.test(text));
  // One phrase only. Two competing phrases say the user asked for two things, and guessing between
  // them is how the verb heuristic got worse than none — the same rule impliedMethodsFor applies to
  // its groups.
  const only = matched.length === 1 ? matched[0] : undefined;
  return only ? new Set(only[1]) : undefined;
}

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
  // Kept in step with METHOD_INTENT above, which is what the comment there asks for.
  // See METHOD_INTENT: `lag`/`lage` are excluded as ambiguous with the noun for a team.
  "opprett", "opprette", "registrer", "registrere",
  "slett", "slette", "fjern", "fjerne",
  "endre", "oppdater", "oppdatere", "rediger",
  "bokfor", "bokfore", "bokfør", "bokføre",
  // Kept in step with METHOD_INTENT, as the comment there requires. Same exclusions: imperatives
  // only, no verbal nouns and no participles.
  // Same exclusions as METHOD_INTENT: `lever`/`levere` (filing), `aktiver` (assets), `avslutt`
  // (terminate) are homographs that would imply a write on a read.
  "godkjenn", "godkjenne", "lukk", "lukke",
  "gjenapne", "gjenåpne", "gjenopprett", "gjenopprette", "dearkiver",
  "avskriv", "avskrive", "utranger", "utrangere", "konverter", "konvertere",
  "aktivere", "deaktiver", "deaktivere",
  "fullfor", "fullfore", "fullfør", "fullføre", "ferdigstill", "ferdigstille",
  "generer", "generere", "valider", "validere", "krediter", "kreditere", "innsend",
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
  // Who owes whom. The verb "skylde" is neutral and these two phrasings point at opposite sides of
  // the books: "hvem skylder oss" is the customer ledger, "hva skylder vi" the supplier ledger.
  [/\bskylder\s+oss\b/g, "customer ledger"],
  // "Levere" means file-a-return far more often than it means hand in an expense claim, so the
  // expense sense is recognised only when the object says so. Bare `lever` maps to nothing.
  [/\b(lever|levere)\s+(en\s+)?(reiseregning|utlegg|reiseregninger)/g, "deliver expense"],
  [/\bskylder\s+vi\b/g, "supplier ledger"],
  // Maps to the resource only. Injecting "depreciation" here made the nested
  // write endpoint dominate: even "create fixed asset" ranked
  // PUT /api/assets/{id}/depreciation above POST /api/assets. A user who means
  // depreciation says so, and that word matches on its own.
  // Both forms, now that a matched phrase is consumed rather than annotated: with only the
  // singular left, "fixed assets" ranked GET /api/ledger/asset — whose final segment IS "asset" —
  // above the resource itself. The plural restores the exact-segment bonus on /api/assets.
  [/\bfixed\s+assets?\b/g, "asset assets"],
  [/\b(recurring|repeating)\b[^.]{0,24}\b(invoice|billing)/g, "subscription"],
  [/\bcredit\s+notes?\b/g, "credit invoice"],
  [/\bopening\s+balances?\b/g, "opening-balances"],
  [/\bannual\s+accounts?\b/g, "annual-accounts"],
  [/\bprofit\s+and\s+loss\b/g, "result income statement"],
  [/\btrial\s+balance\b/g, "ledger balance"],
  [/\bchart\s+of\s+accounts\b/g, "chart-of-accounts"],
  [/\bcash\s+register\b/g, "kassasystem"],
  // Hyphenated Norwegian terms, which tokenise into halves that mean something else. "a-melding"
  // became "a" + "melding", and `melding` maps to return/returns — so the payroll filing that goes
  // to Skatteetaten ranked the TAX RETURN first. Measured; it is the sharpest instance because the
  // two are different filings to the same authority.
  // "salary-payments complete" and NOT "amelding": the literal word only matches
  // GET /amelding/{id}/feedback-raw, which reads a submission's raw feedback rather than filing
  // one, and it took the top slot away from the operation that does the filing.
  [/\ba[-\s]?melding(en|er)?\b/g, "salary-payments complete"],
  [/\bmva[-\s]?melding(en|er)?\b/g, "vat-returns"],
  [/\bmva[-\s]?kode(r|ne)?\b/g, "vat-codes"],
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

  // --- Norwegian ----------------------------------------------------------------
  //
  // This is a Norwegian accounting system, so an agent talking to a Norwegian user
  // receives Norwegian words. A handful were already here; these are the rest of the
  // everyday vocabulary, measured against queries a bookkeeper would actually ask.
  // Keys are ASCII-folded because lookupForms folds before looking up: "lonn", not "lønn".
  // --- Measured against a HELD-OUT set of Norwegian queries ---------------------
  //
  // The vocabulary above was tuned against the queries in test/discovery-norwegian.test.mjs,
  // which I wrote. Scored against 45 fresh queries built from bookkeeping vocabulary instead,
  // the ranker managed 17 in the top 3 — and a dozen returned NOTHING AT ALL, which is the
  // outcome that leaves an agent stuck rather than merely misdirected. These are the terms that
  // found nothing, each mapped to the endpoint that answers it.
  //
  // Expense claims. "reiseregning" (travel claim) and "utlegg" (out-of-pocket) are the two words
  // a Norwegian actually uses for /api/expenses; the endpoint's own name matches neither.
  produkt: ["product", "products"],
  produkter: ["product", "products"],
  // Neither `vare` nor `varer` is here, and removing the plural alone was not enough: the suffix
  // rules fold "varer" back to "vare", so the mapping fired anyway and "hvor lenge varer
  // abonnementet" — a question about duration — still ranked products first through third. The
  // product queries are served by `produkt`/`produkter`, measured, so this pair buys nothing and
  // costs a confident wrong answer on a common phrasing.
  valuta: ["currency", "currencies"],
  // `valutakurs` (exchange RATE) is deliberately absent. CurrencyRes carries only `code` and
  // `name`, so pointing this at /api/currencies would rank an endpoint that cannot answer the
  // question — a confident wrong answer, which is worse than no result.
  kontoutskrift: ["ledger", "postings"],
  // A second, genuinely untouched corpus scored 19 of 30 in the top 3 where the tuned one scored
  // 37 of 41 — the honest measure of what unseen vocabulary gets. These are the terms from it that
  // returned NOTHING, fixed because a stranded agent is the failure that matters, not because the
  // benchmark asked.
  eier: ["owner", "user", "users"],
  eierrolle: ["owner", "role", "roles", "user"],
  kassesystem: ["kassasystem"],
  kassaapparat: ["kassasystem"],
  ansettelsesavtale: ["employee-contract", "agreement", "employment"],
  arbeidsavtale: ["employee-contract", "agreement", "employment"],
  arbeidskontrakt: ["employee-contract", "agreement", "employment"],
  // Loans and the words around them. `/api/loans` was reachable by `lån` and `loan` and by almost
  // nothing else: measured before this, `gjeld`, `avdrag`, `aksjonærlån` and `borrowing` returned
  // NOTHING at all, and `banklån` and `ansattlån` — ordinary compounds — went to company-banks and the
  // employee ledger instead.
  //
  // `renter` is the one that was actively wrong rather than merely missing. It is Norwegian for
  // INTEREST, and it ranked /api/agreements/rent-agreement first, because the -er rule strips it to
  // `rent` and that matches the path segment. Norwegian rent is `leie`; the collision is with English.
  // Same shape as the `levere`/`aktiver` homographs already recorded above, so it is fixed the same
  // way: an explicit entry, which wins over a derived stem.
  //
  // Every entry here carries ONE or two tokens, and that restraint is the whole lesson of the first
  // version, which carried three or four each. Review measured the result: `gjeld til leverandør`
  // pushed the supplier ledger from first to FOURTH, `nedbetaling av faktura` and `avdrag på faktura`
  // moved off the invoice payments, `motpart på banktransaksjon` filled all four top places with
  // creditors and debtors, and the English `renter agreement` — a person who rents — lost the rent
  // agreement. A broad word carrying several strong tokens drowns the specific resource a query names,
  // which is a worse failure than the word missing, because the caller named the thing they wanted.
  //
  // `nedbetaling` and `motpart` are GONE rather than weakened, because they are genuinely ambiguous and
  // choosing a side is itself the bug: an invoice is paid down too (it reaches the invoice payments,
  // which is the better default), and a counterparty belongs to anything, not only a loan.
  gjeld: ["loan"],
  gjeldsbrev: ["loans", "loan"],
  laan: ["loans", "loan"],
  // Deliberately NOT carrying "bank" as well: with it, `banklån` ranked /api/loans fifth behind the
  // company-bank endpoints, because the extra term pulls the whole bank family up. A compound names
  // one thing.
  banklan: ["loans", "loan"],
  ansattlan: ["loans", "loan", "employee"],
  aksjonaerlan: ["loans", "loan", "owner"],
  eierlan: ["loans", "loan", "owner"],
  konsernlan: ["loans", "loan", "intercompany"],
  rente: ["interest", "loan"],
  renter: ["interest", "loan"],
  rentesats: ["interest", "loan"],
  rentefot: ["interest", "loan"],
  avdrag: ["loan"],
  hovedstol: ["loans", "loan", "principal"],
  laneperspektiv: ["loans", "loan"],
  borrowing: ["loans", "loan"],
  // The counterparty ledgers, which a loan needs and which answered to their ENGLISH names only:
  // `creditor` found /api/creditors while `kreditor` found nothing, and `debitor` ranked a
  // supplier-invoice cost-line above /api/debtors.
  kreditor: ["creditors", "creditor"],
  kreditorer: ["creditors", "creditor"],
  debitor: ["debtors", "debtor"],
  debitorer: ["debtors", "debtor"],
  leiekontrakt: ["rent-agreement", "agreement", "rent"],
  husleie: ["rent-agreement", "rent"],
  leieavtale: ["rent-agreement", "agreement", "rent"],
  feriepengegrunnlag: ["salary", "salary-payments", "holiday"],
  reiseregning: ["expense", "expenses", "travel"],
  utlegg: ["expense", "expenses"],
  utleggsrefusjon: ["expense", "expenses"],
  kjoregodtgjorelse: ["expense", "mileage", "expenses"],
  kilometergodtgjorelse: ["expense", "mileage", "expenses"],
  diett: ["expense", "per-diem", "expenses"],
  diettgodtgjorelse: ["expense", "per-diem", "expenses"],
  godtgjorelse: ["expense", "allowance"],
  // A THIRD corpus (test/discovery-heldout.test.mjs, `EVERYDAY`) measured 16 of 28 in the top 3 with
  // two queries returning NOTHING AT ALL. Same rule as before: an empty result strands an agent, so
  // the empties are fixed and the rankings are left alone. These are the two words.
  //
  // "land" is the plainest possible way to ask which countries this API accepts, and the country list
  // only became a tool last iteration — its vocabulary was never added with it.
  land: ["country", "countries"],
  landkode: ["country", "countries", "countryCode"],
  // "hvem skylder oss penger" — who owes us money — is the customer ledger, and no form of "skylde"
  // was in the table at all. The verb itself is direction-NEUTRAL, deliberately: "hva skylder vi" is
  // the same verb pointing at the supplier side, and hard-coding `customer` here ranked both
  // customer-ledger routes above the supplier ledger for it — the opposite side of the books. The
  // direction lives in PHRASE_SYNONYMS, where "skylder oss" and "skylder vi" can be told apart.
  skylder: ["ledger", "unpaid", "due"],
  skylde: ["ledger", "unpaid", "due"],
  skyldig: ["unpaid", "due", "ledger"],

  // --- Norwegian ACTION words, enumerated from the API's own action segments ---------
  //
  // Almost everything above is nouns. Review corrected two claims that stood here: the table was not
  // verbless — `avstemme`, `reconcile`, `reconciling`, `signing`, `owe` and `owes` were already in it,
  // and `skylder` below is a Norwegian translation of `owes` rather than a new category — and the API
  // does not have 65 ACTION segments. It has 65 distinct trailing segments after a path placeholder
  // among public operations, of which perhaps 25 to 30 are actions; the rest are sub-resources like
  // address, attachments, pdf, notes and contact-persons. About a dozen real actions still have no
  // Norwegian word here (send, unmatch, matches, apply-rules, follow-up, use-credit-note,
  // register-payment, registration, sign-request).
  //
  // What is true and was the point: a Norwegian asking for one of those actions names it ("godkjenn
  // utlegg", "avskriv anleggsmiddel"), the word matched nothing, and the resource collection outranked
  // the endpoint that does the thing — /api/expenses ahead of /api/expenses/{id}/approve.
  //
  // Enumerated from the spec's action segments rather than from a benchmark's phrasings, which is
  // the difference between covering a category and fitting a score. The cost is stated plainly in
  // test/discovery-heldout.test.mjs: I read that corpus's failures before doing this, so it stops
  // being a held-out measurement and becomes a regression set, and a third corpus was written
  // afterwards to measure what this generalises to.
  //
  // Both the imperative and the verbal noun, since Norwegian queries use either: "godkjenn
  // reiseregningen" and "til godkjenning" are the same request.
  godkjenn: ["approve"],
  godkjenne: ["approve"],
  godkjenning: ["approve"],
  // `underkjenn`/`underkjenne` are deliberately ABSENT. They mean reject or disallow a claim, and the
  // only endpoint near them is POST /api/expenses/{id}/unapprove — which by its own description
  // "returns an APPROVED expense to for_approval so it can be corrected again" and is refused for an
  // expense that is not approved. Rejecting a pending claim has no endpoint at all, so mapping the
  // word would answer a question the API cannot answer, confidently.
  // `lever`/`levere`/`levering` are deliberately ABSENT as bare words, and this was a real
  // regression before review caught it. "Levere" is how Skatteetaten and every Norwegian bookkeeper
  // says FILE a return — "lever mva-meldingen", "levere skattemeldingen", "lever årsregnskapet" —
  // while `deliver` exists on exactly one endpoint in this API, POST /api/expenses/{id}/deliver. So
  // the mapping took three filing queries that main answered correctly and pointed them all at an
  // expense claim. The expense sense is real too, so it lives in PHRASE_SYNONYMS where the object of
  // the verb can be seen.
  lukk: ["close"],
  lukke: ["close"],
  // `avslutt`/`avslutte` are NOT here. In Norwegian business language they mean TERMINATE — an
  // employment, a lease, a subscription — and `close` in this API is a reconciliation period. So
  // "avslutt arbeidsforholdet" and "avslutt leiekontrakten" both ranked the bank and manual
  // reconciliation close endpoints, with nothing about agreements or employment anywhere in the
  // results. `lukk`/`lukke` carry the period sense without the collision.
  gjenapne: ["reopen"],
  // `apne`/`åpne` alone is NOT here: it is an adjective as often as an imperative, and "åpne poster"
  // — open items, i.e. unpaid — is a read. Mapped unconditionally it put the three mutating
  // POST /api/postings/{customer,employee,supplier}/open operations above GET /api/postings/groups
  // for that phrase. `gjenapne` carries the same meaning unambiguously when reopening IS the intent.
  gjenopprett: ["unarchive", "restore"],
  gjenopprette: ["unarchive", "restore"],
  dearkiver: ["unarchive"],
  avskriv: ["depreciation", "asset"],
  avskrive: ["depreciation", "asset"],
  // `nedskriv`/`nedskrivning` are deliberately ABSENT, and this is the one that mattered most.
  // Nedskrivning is an IMPAIRMENT — write the carrying value down and keep the asset. The endpoint
  // this would have reached, POST /api/assets/{id}/write-off, takes no amount and is the destructive
  // disposal for something scrapped, lost or sold; reai_write_off_asset is marked irreversible and
  // destructive for that reason. Mapping the word would have pointed "nedskriv maskinen" at disposing
  // of the machine. There is no write-down endpoint, so there is nothing to point it at.
  utranger: ["write-off"],
  utrangere: ["write-off"],
  konverter: ["convert"],
  konvertere: ["convert"],
  // `aktiver` alone is NOT here: in Norwegian it is the balance-sheet noun for ASSETS — "aktiver og
  // passiver", "sum aktiver i balansen" — as well as the imperative "activate". Mapped
  // unconditionally it ranked POST /api/subscriptions/{id}/activate first for every one of those
  // questions, with /api/assets absent from the results. `aktivere` is unambiguously the verb.
  aktivere: ["activate"],
  //  IS unambiguous — it is only the balance-sheet noun, never the verb — so the assets sense
  // that  cannot safely carry is available under the word that has no second meaning.
  aktiva: ["asset", "assets"],
  deaktiver: ["deactivate"],
  deaktivere: ["deactivate"],
  fullfor: ["complete"],
  fullfore: ["complete"],
  ferdigstill: ["complete"],
  ferdigstille: ["complete"],
  generer: ["generate"],
  generere: ["generate"],
  innsend: ["submit"],
  innsending: ["submit"],
  valider: ["validate"],
  validere: ["validate"],
  krediter: ["credit", "credit-note"],
  kreditere: ["credit", "credit-note"],
  refusjon: ["refunds", "refund"],
  tilbakebetaling: ["refunds", "refund"],
  sluttsaldo: ["ending-balance", "balance"],
  utgaende: ["ending-balance", "outgoing"],
  oreavrunding: ["rounding-adjustment"],
  avrunding: ["rounding-adjustment"],
  // Payroll vocabulary that is not the word "salary".
  feriepenger: ["salary", "wage-specs", "holiday"],
  // No generic "tax" on either: it ranked GET /api/tax-returns/{year} — the annual INCOME-tax
  // return — ahead of every salary operation, which is the same wrong-filing confusion the
  // a-melding rule exists to prevent. Withholding and employer's contribution are handled by the
  // salary completion flow.
  forskuddstrekk: ["salary", "salary-payments", "complete"],
  arbeidsgiveravgift: ["salary", "salary-payments", "complete"],
  amelding: ["salary", "complete", "amelding"],
  // Time.
  timeforing: ["timesheet"],
  // Documents and attachments — both returned nothing, and both are real endpoints.
  vedlegg: ["attachment", "attachments"],
  dokument: ["document", "documents"],
  dokumenter: ["document", "documents"],
  // Access control, added with the tools that read it.
  tilgang: ["user", "users", "permission", "role"],
  tilganger: ["user", "users", "permission", "role"],
  // `bruker` alone is NOT here: it is equally the verb "uses", and "hvilken konto bruker
  // fakturaen" filled the results with /api/users instead of accounts or invoices. The
  // unambiguous plural stays.
  brukere: ["user", "users"],
  rolle: ["role", "roles", "user"],
  roller: ["role", "roles", "user"],
  rettighet: ["permission", "permissions", "user"],
  rettigheter: ["permission", "permissions", "user"],
  // Counterparty detail.
  kontaktperson: ["contact-persons", "contact", "customer"],
  kontaktpersoner: ["contact-persons", "contact", "customer"],
  organisasjonsnummer: ["organization", "organisation", "customer", "supplier"],
  orgnummer: ["organization", "organisation", "customer", "supplier"],
  stillingsprosent: ["employee", "employment", "percentage"],
  // Invoice sub-operations. "kreditnota" ranked the SUPPLIER credit-note lookup first, which is
  // a different thing from crediting a customer invoice.
  betalingspaminnelse: ["reminders", "reminder", "dunning"],
  purregebyr: ["reminders", "reminder"],
  inkasso: ["reminders", "debt-collection"],
  // Transport.
  peppol: ["peppol", "ehf"],
  ehf: ["ehf", "peppol"],

  lager: ["warehouse", "inventory"],
  varelager: ["warehouse", "inventory"],
  beholdning: ["warehouse", "inventory"],
  avstemming: ["reconciliation"],
  avstemme: ["reconciliation"],
  abonnement: ["subscription"],
  avdeling: ["department"],
  prosjekt: ["project"],
  avskrivning: ["depreciation", "asset"],
  anleggsmiddel: ["asset"],
  anleggsmidler: ["asset"],
  driftsmiddel: ["asset"],
  // Irregular: lookupForms strips -er to "driftsmidl" and -r to "driftsmidle", so the
  // plural has to be its own key. Same reason anleggsmidler and eiendeler are listed.
  driftsmidler: ["asset"],
  tilbud: ["offer"],
  ordre: ["order"],
  purring: ["reminders", "dunning"],
  kreditnota: ["credit", "invoice", "invoices"],
  innbetaling: ["payment", "customer"],
  utbetaling: ["payment", "supplier"],
  betaling: ["payment"],
  skattemelding: ["tax-returns"],
  utgift: ["expense"],
  utgifter: ["expense"],
  timeliste: ["timesheet"],
  timer: ["timesheet"],
  avtale: ["agreement"],
  avtaler: ["agreement"],
  // "lån" folds to "lan" — foldDiacritics maps å to a, not aa. The first attempt keyed
  // this as "laan" and matched nothing.
  lan: ["loan"],
  aksje: ["share-investments"],
  aksjer: ["share-investments"],
  apningsbalanse: ["opening-balances"],
  arsregnskap: ["annual-accounts"],
  // The older double-a transliteration. foldDiacritics maps å to a rather than aa, so "årsregnskap"
  // arrives as `arsregnskap` and is matched — but someone typing the aa convention directly was not, and
  // reached /api/ledger/general instead.
  aarsregnskap: ["annual-accounts"],
  // `arsoppgjor` is the same thing in the language accountants actually use — the year-end process — and
  // it returned NOTHING at all, as did `aarsoppgjor` and `arsavslutning`. `arsregnskap` was mapped and
  // its synonym was not, which is the shape of gap a synonym table accumulates: the word someone thought
  // of, not the word someone types. Measured before adding: `mva` reached /api/vat-codes while the formal
  // `merverdiavgift` reached nothing, and /api/annual-accounts exists.
  //
  // Mapped to the hyphenated path token only, NOT to "accounts": that token is in chart-of-accounts,
  // general-sub-accounts and company bank accounts, so "årsoppgjør" would have dragged the whole
  // account surface up with it.
  arsoppgjor: ["annual-accounts"],
  aarsoppgjor: ["annual-accounts"],
  arsavslutning: ["annual-accounts"],
  // The formal name of MVA. `mva` was mapped and this was not, so a query written the way a tax form
  // writes it returned nothing.
  // No "mva" in the value list: the string appears in ZERO of the 430 operations' path, tag, summary,
  // description or id, and synonym expansion is not recursive — so it can never match, while it inflates
  // `resourceCount` and shrinks the coverage multiplier. Measured by the review of PR #118:
  // "merverdiavgift pa faktura" scored /api/vat-codes at 18.9 with it and 19.18 without. No flip today,
  // a self-inflicted penalty regardless.
  //
  // And no `merverdiavgiften` entry: `definite("en")` in lookupForms already derives it, so the entry was
  // dead. The first version of this change claimed every synonym here was "verified load-bearing by
  // removing it and watching the test fail"; two were not, and this is one.
  merverdiavgift: ["vat"],
  // `postering`/`posteringer` — a posting, the core unit of double-entry bookkeeping — reached
  // /api/invoice-reception-documents and /api/attachments, while /api/postings carries nine operations
  // that no curated tool covers, so the escape hatch is the only route to them. Low collision risk: this
  // API has no other "posting" family, and the English "posting group" query already ranks first.
  // A REACHABILITY compromise, and the first version of this comment got the reason wrong. It claimed the
  // destination was "a judgement about Norwegian practice" that the API had no opinion on. The API has an
  // opinion: `accrualEnabled`, `accrualPeriod`, `accrualPeriodCount` and `accrualAccountNumber` are
  // first-class fields on supplier-invoice cost lines and order lines — periodisering is a flag on a line,
  // not a manual voucher. The review of PR #118 found that by grepping for the word, which I had not done.
  //
  // It still maps to `voucher`, for a reason that has to be stated rather than dressed up: `fieldNamesOf`
  // deliberately excludes request-BODY fields from the searchable text, so `["accrual"]` would match
  // nothing at all and the query would go back to returning the VAT-return endpoints. Voucher is the best
  // REACHABLE answer, not the correct one. If body fields ever become searchable, this should point at
  // /api/supplier-invoices and /api/orders instead.
  //
  // A KNOWN LIMIT, measured rather than waved away. Codex pointed out on PR #118 that an unconditional
  // `voucher` can swamp a more specific resource in a mixed query, and it does for one shape:
  // "periodisering av mva-melding" returns ten voucher operations and no /api/vat-returns, while
  // "mva-melding" alone ranks POST /api/vat-returns first. It does NOT happen for the realistic query —
  // "periodisering av leverandorfaktura" ranks /api/supplier-invoices first, which is exactly right, and
  // that is the phrase an accountant actually types. The mapping is kept because it turns a wrong bare
  // answer (VAT returns) into a defensible one, and the damage is confined to a hyphenated abbreviation in
  // a combination that is not a real accounting operation. Recorded so the next person weighing it has the
  // measurement rather than the argument.
  periodisering: ["voucher"],
  // The same concept in English, which was left empty while the Norwegian was fixed — the same gap class
  // the change was about, one language over.
  accrual: ["voucher"],
  accruals: ["voucher"],
  periodisation: ["voucher"],
  // "posting" only. Adding the plural put GET /api/postings/groups above GET /api/postings — and
  // /api/postings is the one operation in the family a curated tool already wraps (reai_list_postings), so
  // the plural demoted the answer most likely to be wanted. Measured by the review of PR #118: with
  // ["posting"] alone the collection wins 18 to 17. `posteringer` needs no entry of its own — the `-er`
  // rule in lookupForms reaches this one, which is the second entry the "verified load-bearing" claim
  // covered and should not have.
  // "voucher" as well as "posting", because a posting is CREATED by posting a voucher — this API has no
  // POST /api/postings. Without it, "opprett postering" ranked the six
  // /api/postings/{customer,employee,supplier}/{close,open} period commands first and the operation that
  // actually creates a posting nowhere: a write verb pointed at unrelated mutations, which is the failure
  // the rest of this table is written to avoid. Codex caught it on PR #118. Measured: the bare `postering`
  // still ranks GET /api/postings first, and "opprett postering" now ranks POST /api/vouchers first.
  // --- Round two, from the review of PR #118 -----------------------------------------------------------
  //
  // Nine terms were added here and SEVEN were withdrawn after review. What survives is the two whose
  // destination could be defended; the rest are recorded below because the reasons they failed are worth
  // more than the mappings would have been.
  //
  // `fordring` is the customer ledger — a receivable IS the kundereskontro. Mapping it to
  // ["receivable", "ledger"] first put the ASSET ledger on top, because "receivable" appears exactly once
  // in the whole index (in a rounding-adjustment description) and the asset ledger then won a six-way tie.
  // The entity has to be named. No `fordringer` entry: lookupForms' `-er` rule derives it, and shipping one
  // anyway was the dead-plural mistake from the round before this.
  //
  // ONE token, not ["ledger", "customer"]. A two-token expansion outscores a single explicitly named
  // resource, so the wider form made `fordring` win every compound it appeared in: "faktura fordringer"
  // ranked the customer ledger above /api/invoices, "bilag fordring" above /api/vouchers, "postering
  // fordringer" above /api/postings. That is the same defect as the withdrawn `kontonummer: ["account"]`
  // below — a synonym broad enough to displace the endpoint the other word names outright. Measured over
  // 1170 queries: ["customer"] keeps GET /api/ledger/customer at rank 1 for the bare term, both plurals,
  // "kundefordringer" and "utestaende fordringer", and returns all three compounds above to the resource
  // they name. ["ledger"] alone is worse than either — GET /api/ledger/asset wins the bare term.
  // Still imperfect, and stated rather than hidden: "leverandor fordring" and "ansatt fordring" rank the
  // customer ledger above the supplier and employee ones, which stay at rank 3. Neither phrase is real
  // Norwegian for those (a supplier balance is leverandørgjeld, a payable), so it is not worth widening.
  fordring: ["customer"],
  // The abbreviation of arbeidsgiveravgift, which the unabbreviated word already reached. Before this,
  // `aga` returned seven operations ALL TIED at the bare-substring floor of 0.16, so the top hit was
  // whichever came first in index order. The commit message called that "a confident wrong answer being
  // fixed"; it was noise, and calling noise confidence overstated the change.
  aga: ["salary-payment"],
  //
  // WITHDRAWN after the review of PR #119 measured them. Each looked reasonable and each was wrong:
  //
  //   kontonummer     The worst of them. Two different things are called kontonummer here — a bank account
  //                   number and a chart-of-accounts number — and mapping it to `account` resolved that
  //                   ambiguity silently toward the chart. "endre kontonummer pa bankkonto" then ranked
  //                   PUT /api/general-sub-accounts/{id} FIRST, a write on the wrong resource, where it had
  //                   correctly ranked PUT /api/company-banks/{id}.
  //   dimensjon       The premise was false. The comment claimed a department is what a posting is analysed
  //                   by; `departmentId` appears on exactly two operations, both employee writes, while
  //                   `projectId` is the query parameter on GET /api/postings and GET /api/ledger/general.
  //                   It also demoted /api/projects for "dimensjon prosjekt".
  //   driftskostnader A category error the repository already documents: /api/expenses is employee expense
  //                   CLAIMS — `travel` is required, and expenses.ts calls it "utlegg og reiseregninger" —
  //                   not operating costs. It turned a wrong-and-weak answer into a wrong-and-confident one.
  //   inngaende       Right for one sense of a standard pair and damaging for the other two. Inngående
  //                   pairs with utgående for faktura, MVA and balanse; mapping the adjective to
  //                   supplier-invoice evicted all three vat-return operations from "inngående mva" and
  //                   three of the four /api/opening-balances operations from "inngående balanse".
  //   termin          Reached GET /vat-return/altinn-sync at a score of 1.7 on an empty summary, ahead of
  //                   three period-locking writes. Termin is also the loan instalment, and "betale termin"
  //                   and "terminbelop" now pointed at VAT filing.
  //   anskaffelseskost Acquisition cost applies to share investments too — PURCHASE is an eventType with
  //                   pricePerUnit — and the mapping evicted /api/share-investments from
  //                   "anskaffelseskost aksjer" entirely.
  //   fordringer      Dead code, derived by the `-er` rule.
  //
  // REFUSED, with the reasons corrected. The first version of this block asserted that four of these
  // "reached" specific endpoints. They reach NOTHING — `kredit`, `trekk`, `styre` and `valutakurs` all
  // return zero hits — and describing a result that does not exist is worse than leaving the note out:
  //
  //   debet, kredit          The two sides of an entry. Neither returns anything, and neither has a
  //                          destination: a posting's sides are body fields on a voucher line. The first
  //                          version claimed kredit's "closest match is /api/creditors" — it has no match,
  //                          and the point being made (creditors are loan counterparties, not the credit
  //                          side) stands as a warning without the false measurement attached to it.
  //   egenkapital, omsetning No endpoint reports equity or turnover.
  //   utbytte                Withdrawn as a refusal REASON, not as a refusal: DIVIDEND is an eventType on
  //                          /api/share-investments/{id}/events, so "no endpoint reports it" was false. It
  //                          stays unmapped because the word alone does not tell you whether the question
  //                          is about recording one or reporting one, and the event type is a body field
  //                          that fieldNamesOf excludes from the searchable text.
  //   varekostnad            Cost of goods sold is computed, not a resource.
  //   permisjon, fravaer     No absence model in this API.
  //   sykepenger             A salary COMPONENT; /api/salary-payments is the disbursement.
  //   trekk                  Returns nothing. Withholding is a payroll line, not an endpoint.
  //   kid, kidnummer         A payment reference field on a body.
  //   valutakurs             Returns nothing, and `valuta` is ALREADY refused twelve lines above this with
  //                          the correct reason — /api/currencies is public but lists currencies rather
  //                          than rates. The first version of this note claimed the only match was an
  //                          internal operation, contradicting the note that got it right.
  //   saldobalanse           Still refused, but the first version's reason was wrong: GET /api/ledger/general
  //                          reports opening balance, postings and closing balance per account, which is a
  //                          trial balance in all but name, so "nothing to point it at" was false. Left
  //                          unmapped in THIS pass because it needs the same measurement the others turned
  //                          out to need, and this round has already shown what happens when that is
  //                          skipped.
  //   arsberetning           The directors' report is not in this API.
  //   generalforsamling      Reaches /api/general-sub-accounts on a spurious "general"; no AGM endpoint.
  //   styre                  Returns nothing. The first version said it matched /onboarding/company-search,
  //                          which it does not — and that path only contains "board" inside "onboarding".
  //   betalingsbetingelser   The target is real and public, POST /invoice/setting/daysUntilDue, and
  //                          querying "daysuntildue" reaches it. The synonym does not work: compound
  //                          decomposition splits the word and `betaling` maps to payment, so the payment
  //                          endpoints win. Verified by re-inserting it and watching the scores not move.
  postering: ["posting", "voucher"],
  posteringsgruppe: ["posting", "group"],
  resultat: ["result", "income"],
  balanse: ["balance"],
  regnskap: ["accounting", "ledger"],
  kontoplan: ["chart-of-accounts"],
  hovedbok: ["ledger", "general"],
  kundefaktura: ["invoice", "customer"],
  leverandorfaktura: ["supplier-invoices"],
  lonnsslipp: ["salary", "payslip"],
  lonnskjoring: ["salary", "salary-payments"],
  ansatte: ["employee"],
  eiendel: ["asset"],
  eiendeler: ["asset"],
};

/**
 * Norwegian stems worth finding INSIDE a longer word.
 *
 * Norwegian glues nouns together, so the word a user types is often a compound whose
 * meaning lives in one half: "lønnskjøring" is lønn+kjøring, "varelager" is vare+lager,
 * "lagerbeholdning" is lager+beholdning. None of those are reachable by the plural and
 * diacritic rules in lookupForms, so "lønnskjøring" found nothing at all while "lonn" was
 * already in the table.
 *
 * Substring matching earns its keep here and would not in English, where compounds are
 * written with spaces and a substring rule mostly produces noise. Kept to stems of four
 * characters or more, and to words specific enough that a coincidental match is unlikely —
 * "konto" is deliberately absent, because it sits inside "kontor" (an office) and inside
 * "kontant" (cash).
 */
const NORWEGIAN_COMPOUND_STEMS: readonly string[] = [
  "lonn",
  "lager",
  "faktura",
  "bilag",
  "kunde",
  "leverandor",
  "ansatt",
  "avdeling",
  "prosjekt",
  "abonnement",
  "avstemming",
  "avskrivning",
  "reskontro",
  "timeliste",
  "skattemelding",
  "kreditnota",
  "purring",
  "betaling",
  "regnskap",
  "aksje",
  "eiendel",
  "tilbud",
];

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
  // A matched phrase is CONSUMED, not merely annotated. Previously the replacement terms were added
  // while the phrase's own words stayed in the text and scored on their own, so a mapping could be
  // outvoted by the thing it exists to override: "a-melding" tokenised to `a` + `melding`, `melding`
  // maps to return/returns, and GET /api/tax-returns/{year} — the annual INCOME-tax return — ranked
  // above the payroll filing the phrase points at. Two different filings to the same authority.
  //
  // Removing the matched text is what makes a phrase mapping mean what its comment says: a
  // deliberate, high-confidence statement about the user's words.
  let remaining = text;
  for (const [pattern, replacement] of PHRASE_SYNONYMS) {
    pattern.lastIndex = 0;
    if (pattern.test(remaining)) {
      phraseTerms.push(...replacement.split(" "));
      pattern.lastIndex = 0;
      remaining = remaining.replace(pattern, " ");
    }
    pattern.lastIndex = 0;
  }

  const terms: Array<{ term: string; weight: number }> = [];
  const byTerm = new Map<string, { term: string; weight: number }>();
  /**
   * Record a term, keeping the HIGHEST weight any source gives it.
   *
   * Keeping the first weight instead made results depend on word order. A compound token
   * contributes its stems below full weight, so "fakturagebyr faktura" pinned "invoice" at
   * the compound weight before the plain token could claim it — and since a term under 1
   * cannot identify a resource, `/api/invoices` fell from first to fourth, while
   * "faktura fakturagebyr" stayed first. Fourteen of forty-five two-word Norwegian queries
   * flipped on ordering alone, none of which did before the compound pass existed.
   */
  const push = (term: string, weight: number) => {
    if (term.length < 2) return;
    const existing = byTerm.get(term);
    if (existing === undefined) {
      const entry = { term, weight };
      byTerm.set(term, entry);
      terms.push(entry);
      return;
    }
    if (weight > existing.weight) existing.weight = weight;
  };

  for (const term of phraseTerms) push(term, PHRASE_WEIGHT);
  for (const token of tokenize(remaining)) {
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
    // Norwegian compounds: the meaning is in one half of a word written as one word.
    // Slightly below a direct hit, because a stem found inside a longer word is weaker
    // evidence than the word itself.
    for (const stem of compoundStemsIn(token)) {
      push(stem, weight * COMPOUND_WEIGHT);
      for (const syn of TERM_SYNONYMS[stem] ?? []) push(syn, weight * COMPOUND_WEIGHT);
    }
  }
  // Counted at the end, not as terms arrive: a weight can be raised by a later source, and
  // a term that starts below the resource gate may finish above it.
  const resourceCount = terms.filter((t) => t.weight >= 1).length;
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

/**
 * A stem found inside a compound counts as much as the word itself.
 *
 * It was 0.8, described as "slightly below a direct hit". That reading was wrong: scoring
 * has a cliff at 1, not a slope — `termWeight >= 1` is what lets a term identify a resource
 * and earn the coverage multiplier and the identity bonus, so any discount at all
 * disqualifies it entirely and the size of the discount is nearly irrelevant. Measured over
 * 385 queries, moving 0.8 → 0.999 changed 2 results while 0.999 → 1.0 changed 6, and 1.0 was
 * the better answer in six of the seven: "prosjektregnskap" reaches /api/projects rather
 * than the asset ledger, "avdelingsregnskap" reaches /api/departments.
 */
const COMPOUND_WEIGHT = 1;

/**
 * Norwegian stems inside a compound token, longest first.
 *
 * Only fires when the stem is a proper substring — a token that IS the stem is already
 * handled by the synonym table directly, and contributing it twice would double its weight.
 */
function compoundStemsIn(token: string): string[] {
  const folded = foldDiacritics(token);
  if (folded.length < 6) return [];
  if (NOT_A_COMPOUND.some((word) => folded.startsWith(word))) return [];
  return NORWEGIAN_COMPOUND_STEMS.filter((stem) => {
    if (folded === stem) return false;
    // At a compound BOUNDARY — the first element or the last — rather than anywhere in the
    // string. An unanchored `includes` matched "lonn" inside "kolonner" (columns) and
    // "belønning" (reward), and "kunde" inside "sekunder" (seconds), so ordinary words
    // returned payroll and the customer ledger. Norwegian compounds put their elements at
    // the edges, so the edges are where to look.
    // And the OTHER element has to be a word too, not a stray letter: "slager" (a hit song)
    // ends with "lager" and was reaching the warehouse. Two characters is the shortest
    // Norwegian element worth treating as one.
    const remainder = folded.length - stem.length;
    if (remainder < 2) return false;
    return folded.startsWith(stem) || folded.endsWith(stem);
  });
}

/**
 * Words that begin with a stem and mean something else.
 *
 * Anchoring fixes the mid-word matches but not a genuine shared root: "lønnsomhet" is
 * profitability, built on the same lønn, and a bookkeeper asking about it does not want the
 * payroll endpoints. String rules cannot tell those apart, so the exceptions are listed.
 */
const NOT_A_COMPOUND: readonly string[] = ["lonnsom", "ulonnsom", "lonnsemne"];

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
    // The Norwegian DEFINITE article is a suffix, and it is how people actually speak: "send
    // fakturaen", "slett bilaget", "endre kunden". Most of those already resolved by accident,
    // because the compound-stem rule finds `faktura` inside `fakturaen` — but it requires at least
    // two characters left over, and the commonest Norwegian noun class ends in -e and takes a single
    // -n. So `kunden`, `ordren`, `leieavtalen`, `husleien` and every other definite -e noun resolved
    // to NOTHING, a quarter of the keys in the table below. Measured: "endre kunden" and "vis ordren"
    // returned no endpoint at all while their indefinite forms ranked correctly.
    //
    // Both the singular -n and the plural -ne. There are no length guards, because the GATE below is
    // the whole protection: a stem that is not a synonym key derives nothing. Two earlier versions of
    // this comment got that wrong in opposite directions — one claimed the length kept a short word
    // like `lan` safe (it could not be reached), the next claimed removing the guards changed nothing
    // (it fixed `lånet`, which the guards were silently breaking). The length was never a precaution;
    // it was an off-by-one on the shortest real stem.
    // Only when the stem is a word this table KNOWS. Stripping -n from anything long enough was the
    // first version and it double-counted: `documentation` also produced `documentatio`, which
    // matchStrength then matched against the same endpoint token twice, and "product documentation"
    // ranked the document-reception endpoints above every product endpoint — worse than before the
    // rule existed. Review caught it. A derived form that is not a synonym key buys nothing here and
    // can only distort, so the gate is the point rather than a precaution.
    const known = (stem: string) => Object.prototype.hasOwnProperty.call(TERM_SYNONYMS, stem);
    // No length guard, and that is the fix rather than an omission. The guards used to read
    // `base.length > 5`, which excluded exactly the three-letter consonant stems: `lån` folds to
    // `lan`, so its definite `lånet` folds to `lanet` — five characters, one short. Measured before
    // the change: `lån` returned GET /api/loans first, `lånet` returned NOTHING, and `saldo på lånet`
    // returned company-banks, departments and salary-payments, i.e. it lost the loan endpoint
    // entirely. Found by Codex on #88; the comment right above claimed the guards were "cheap sanity
    // and nothing more", which was true of what they let through and false about what they blocked.
    // The gate below is the whole protection: a stem that is not a key derives nothing.
    // `minStem` is per suffix, because the single -n is the one that needs protecting and Codex
    // caught it: with a uniform floor, `vatn` (Nynorsk for water) stems to the known key `vat` and
    // returned the VAT endpoints, and `owen` stems to `owe` — so "faktura til owen", an invoice to a
    // person, ranked the customer LEDGER above /api/invoices. A one-character suffix strips one
    // character, so it turns any four-letter word into a three-letter one, and three-letter keys are
    // exactly what this change set out to reach. The two rules pull in opposite directions and the
    // floor has to distinguish them.
    //
    // Four for -n, three for the rest, and neither is arbitrary: every real Norwegian -n definite has
    // an -e stem (`kunde`, `ordre`, `avtale`, `leieavtale`), so nothing legitimate needs a
    // three-letter stem there — adding -n to each three-letter key gives `vatn`, `mvan`, `owen`,
    // `ehfn`, `lann`, not one of which is a definite form of it. The -et/-en/-ene rules DO need three
    // (`lanet`, `lanene`), and no key is shorter than three characters, so the floor can never be the
    // thing that blocks a real stem.
    const definite = (suffix: string, minStem = 3) => {
      if (!base.endsWith(suffix)) return;
      const stem = base.slice(0, -suffix.length);
      if (stem.length >= minStem && known(stem)) add(stem);
    };
    definite("ne");
    definite("n", 4);
    // And the plural definite of a CONSONANT stem, which is -ene: `lånene`, `utgiftene`,
    // `dokumentene`, `kontoene`, `vedleggene`, `produktene`. Fixing the singular above made the
    // asymmetry obvious — `utgiften` resolved and `utgiftene` returned nothing, though the -ne rule
    // already handled the -e nouns (`kundene`, `ordrene`) because their stem keeps its -e. Same gate,
    // so `scene` and `hygiene` derive nothing: `sc` and `hygi` are not keys.
    definite("ene");
    // The consonant-stem definites, -en and -et, which are the BIGGER class and were left out of the
    // first version: `reiseregningen`, `beholdningen`, `kontoen`, `utgiften`, `dokumentet` and
    // `vedlegget` all returned nothing at all. Some definite forms of this class already resolved
    // because the compound-stem rule finds the stem inside them, but only where that stem happens to
    // be a compound element; a plain noun like `utgift` is not one.
    //
    // Safe by the same gate, which is what makes extending cheap: the stem has to be a key, so
    // `token`, `given`, `budget` and `asset` derive nothing because `tok`, `giv`, `budg` and `ass` are
    // not words this table knows.
    definite("en");
    definite("et");
    // The English plural, and the one derivation here with NO known-stem gate. Raised as an
    // asymmetry worth a deliberate decision rather than an accident, so it was measured: gating it on
    // `known` changes no corpus score at all, and over 34 plural queries it moves only the THIRD
    // result, six times, never the first or second (`customers` swaps contact-persons for
    // POST /api/customers; `warehouses` is arguably improved). Removing the rule entirely changes
    // exactly the same six. So the gate is left off, with the reason rather than by omission: a
    // Norwegian definite stem is only useful if it is a synonym key, since that is the table it is
    // reaching for, while an English plural stem is matched against ENDPOINT path tokens — `warehouse`
    // earns its keep against `/api/warehouses` whether or not the synonym table has heard of it.
    // Gating it would silently narrow it to the table.
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
