import { z } from "zod";
import { defineTool, ok, okText, tenantIdArg, resolveTenantId, type ToolDef } from "./registry.js";
import {
  describeOperation,
  findOperation,
  getSpecIndex,
  missingRequired,
  resolveOperation,
  searchOperations,
} from "../reai/spec.js";
import { findQuirks, quirksFor } from "../reai/quirks.js";
import {
  assertAllowed,
  assertTransmitAllowed,
  canonicalizeApiPath,
  classifyRequest,
  classifyTransmission,
  classifyWithBody,
  escalatingBodyFields,
  transmittingBodyFields,
} from "../policy.js";
import type { HttpMethod } from "../reai/client.js";
import { ReaiApiError } from "../reai/errors.js";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const searchEndpoints = defineTool({
  name: "reai_search_endpoints",
  title: "Search ReAI API endpoints",
  description:
    "Search the full ReAI OpenAPI surface (313 public operations) by keyword, tag or HTTP method. " +
    "Use this whenever no curated tool covers what you need — for example leads, agreements, " +
    "subscriptions, assets, warehouses, share investments, salary or Peppol. " +
    "Returns matching operations with their path, parameters and request-body field names. " +
    "Follow up with reai_describe_endpoint for full schemas, then call it via reai_request.",
  risk: "read",
  inputSchema: {
    query: z
      .string()
      .optional()
      .describe(
        'Keywords to match against path, tag, summary and description. Norwegian domain terms often ' +
          'appear in descriptions (e.g. "mva", "bilag", "kunde"), and English ones in paths and tags. ' +
          'Omit to browse by tag alone.',
      ),
    tag: z.string().optional().describe('Restrict to one tag, e.g. "Invoices" or "Bank reconciliations". Use reai_list_api_tags to see them all.'),
    method: z.enum(HTTP_METHODS).optional().describe("Restrict to one HTTP method."),
    includeInternal: z
      .boolean()
      .optional()
      .describe(
        "Include undocumented internal endpoints (payment-provider webhooks, the POS app, platform " +
          "admin). Off by default; these are not intended for API consumers.",
      ),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum results (default 25)."),
  },
  handler: async (args) => {
    const hits = searchOperations({
      ...(args.query !== undefined ? { query: args.query } : {}),
      ...(args.tag !== undefined ? { tag: args.tag } : {}),
      ...(args.method !== undefined ? { method: args.method } : {}),
      ...(args.includeInternal !== undefined ? { includeInternal: args.includeInternal } : {}),
      limit: args.limit ?? 25,
    });

    if (hits.length === 0) {
      const tags = Object.keys(getSpecIndex().tags).join(", ");
      return okText(
        `No endpoints matched. Try broader keywords or browse by tag.\nAvailable tags: ${tags}`,
      );
    }

    const results = hits.map((h) => {
      const quirks = quirksFor(h.method, h.path);
      return {
      call: `${h.method} ${h.path}`,
      tag: h.tag,
      ...(h.summary ? { summary: h.summary } : {}),
      // Surfaced here rather than only in describe, so an agent choosing between
      // endpoints can see which ones have a trap in them.
      ...(quirks.length > 0
        ? { knownQuirks: quirks.map((q) => `[${q.kind}] ${q.note}`) }
        : {}),
      ...(h.params?.length
        ? {
            params: h.params.map(
              (p) => `${p.name} (${p.in}${p.required ? ", required" : ""}): ${p.type}`,
            ),
          }
        : {}),
      ...(h.body ? { body: h.body } : {}),
      ...(h.deprecated ? { deprecated: true } : {}),
      ...(h.internal ? { internal: true } : {}),
      };
    });

    return ok(results, {
      note:
        `${hits.length} endpoint(s) matched. Call any of them with reai_request, ` +
        `or get full schemas with reai_describe_endpoint.`,
    });
  },
});

const describeEndpoint = defineTool({
  name: "reai_describe_endpoint",
  title: "Describe a ReAI API endpoint",
  description:
    "Get the complete schema for one ReAI endpoint: every parameter, the full request body with " +
    "nested objects resolved, and response shapes. Use this before calling an unfamiliar endpoint " +
    "with reai_request, especially for POST and PUT where required fields matter.",
  risk: "read",
  inputSchema: {
    method: z.enum(HTTP_METHODS).describe("HTTP method of the endpoint."),
    path: z
      .string()
      .describe(
        'API path exactly as it appears in the spec, including braces for path parameters, ' +
          'e.g. "/api/customers/{id}".',
      ),
    depth: z
      .number()
      .int()
      .min(1)
      .max(8)
      .optional()
      .describe("How deep to expand nested schemas (default 4). Raise it for deeply nested payloads."),
  },
  handler: async (args) => {
    const op = findOperation(args.method, args.path);
    if (!op) {
      const guesses = searchOperations({ query: args.path.replace(/[/{}]/g, " "), limit: 8 });
      const suggestion = guesses.length
        ? `\n\nDid you mean one of these?\n${guesses.map((g) => `  ${g.method} ${g.path}`).join("\n")}`
        : "";
      return okText(
        `No such endpoint: ${args.method} ${args.path}\n` +
          `Paths must match the spec exactly, including {braces} around path parameters.${suggestion}`,
      );
    }
    const described = describeOperation(op, args.depth ?? 4);
    const quirkCount = described.quirks?.length ?? 0;
    return ok(described, {
      note:
        `Schema for ${op.method} ${op.path}. Call it with reai_request.` +
        (quirkCount > 0
          ? `\n${quirkCount} known quirk(s) for this endpoint are listed under "quirks" — read ` +
            `them before calling; several were learned from a rejected request rather than the schema.`
          : ""),
    });
  },
});

const listApiTags = defineTool({
  name: "reai_list_api_tags",
  title: "List ReAI API domains",
  description:
    "List every documented ReAI API domain (tag) with its operation count — a map of what the " +
    "accounting system can do. Useful for orienting before a search.",
  risk: "read",
  inputSchema: {},
  handler: async () => {
    const index = getSpecIndex();
    return ok(index.tags, {
      note:
        `${index.counts.public} public operations across ${Object.keys(index.tags).length} domains ` +
        `(plus ${index.counts.internal} internal endpoints, hidden by default). ` +
        `Search within one using reai_search_endpoints with the tag parameter.`,
    });
  },
});

const apiNotes = defineTool({
  name: "reai_api_notes",
  title: "Known ReAI API quirks",
  description:
    "Browse the known quirks of the ReAI API: request shapes that differ from what an endpoint name " +
    "suggests, constraints the schema does not state, multi-step workflows, and operations that are " +
    "harder to undo than they look.\n\n" +
    "Worth reading before working in a domain the curated tools do not cover, since those endpoints " +
    "are reached through raw schemas. Individual quirks also appear automatically on the endpoints " +
    "they affect in reai_search_endpoints and reai_describe_endpoint.",
  risk: "read",
  inputSchema: {
    query: z
      .string()
      .optional()
      .describe(
        'Filter by keyword, matched against the note, paths and kind — e.g. "vat", "invoice", ' +
          '"irreversible", "bank". Omit for all of them.',
      ),
  },
  handler: async (args) => {
    const quirks = findQuirks(args.query);
    if (quirks.length === 0) {
      return okText(
        `No known quirks matched "${args.query}". That is not a guarantee there are none — ` +
          `call reai_describe_endpoint for the endpoint's actual schema.`,
      );
    }
    const byKind: Record<string, Array<{ paths: string; note: string }>> = {};
    for (const q of quirks) {
      (byKind[q.kind] ??= []).push({
        paths: q.paths.join(", ") + (q.methods ? ` (${q.methods.join("/")})` : ""),
        note: q.note,
      });
    }
    return ok(byKind, {
      note:
        `${quirks.length} known quirk(s)` +
        `${args.query ? ` matching "${args.query}"` : ""}, grouped by kind. ` +
        `"shape" = the payload is not what the name suggests; "validation" = a constraint the ` +
        `schema omits; "workflow" = needs a specific sequence; "irreversible" = hard or impossible ` +
        `to undo; "gotcha" = simply surprising.`,
    });
  },
});

/**
 * Add spec-derived guidance to a failed `reai_request` call.
 *
 * Only for 4xx: a 5xx or a transport failure says nothing about the payload, and
 * guessing at required fields there would be noise.
 */
/** Statuses where the request's own shape is a plausible explanation. */
const PAYLOAD_STATUSES = new Set([400, 415, 422]);

function enrichRequestFailure(
  err: unknown,
  method: HttpMethod,
  path: string,
  query: Record<string, unknown> | undefined,
  body: unknown,
): unknown {
  if (!(err instanceof ReaiApiError)) return err;
  if (err.status < 400 || err.status >= 500) return err;

  const op = resolveOperation(method, path);
  if (!op) return err;

  const extra: string[] = [];
  // Payload analysis belongs only to the statuses that are ABOUT the payload. On a
  // 401, 403, 404, 409 or 429 the request shape is not the problem, and "these
  // required parameters were not sent" is a true sentence pointing away from the
  // actual cause — an exhausted rate limit was being answered with a list of
  // missing query parameters.
  const explainsPayload = PAYLOAD_STATUSES.has(err.status);
  const { params, bodyFields, bodyMissing } = explainsPayload
    ? missingRequired(op, query, body)
    : { params: [], bodyFields: [], bodyMissing: false };
  if (params.length > 0) {
    extra.push(
      `The spec marks these query parameters as required on ${op.method} ${op.path}, and they were ` +
        `not sent: ${params.join(", ")}. Sending them all at once avoids discovering them one ` +
        `rejection at a time.`,
    );
  }
  if (bodyMissing) {
    const shape = Object.keys(op.body?.fields ?? {});
    // Only claim the properties are all optional when they actually are. An
    // operation can require a body AND require fields within it -- POST /api/assets
    // needs accountNumber and name -- and asserting "every property is optional"
    // immediately before listing those as required contradicts itself.
    const allOptional = bodyFields.length === 0;
    extra.push(
      `${op.method} ${op.path} requires a request body and none was sent.` +
        (allOptional
          ? ` Every property in it is optional, which is why no individual field is named` +
            `${shape.length > 0 ? `; the accepted properties are: ${shape.join(", ")}` : ""}.`
          : ""),
    );
  }
  if (bodyFields.length > 0) {
    extra.push(
      `The spec marks these body fields as required on ${op.method} ${op.path}, and they were ` +
        `absent: ${bodyFields.join(", ")}.`,
    );
  }

  // The quirks are the point. Several exist because an endpoint's own error
  // message points the wrong way -- a voucher whose rows cannot merge is reported
  // as a sign-convention problem, for instance.
  //
  // Filtered by status, because a note written about one outcome states something
  // FALSE when attached to another. A 403 was being answered with the 404
  // empty-state quirk ("report it as empty"), which would have had an agent tell a
  // user their company has no opening balances when it simply could not read them.
  const quirks = quirksFor(method, op.path).filter(
    (q) => q.statuses === undefined || q.statuses.includes(err.status),
  );
  for (const q of quirks) extra.push(`Known quirk [${q.kind}]: ${q.note}`);

  if (extra.length === 0) return err;
  // Appended to the existing error rather than rebuilt: reconstructing it would
  // duplicate the constructor's contract here and drift from it.
  err.message = `${err.message}\n${extra.join("\n")}`;
  return err;
}

const request = defineTool({
  name: "reai_request",
  title: "Call any ReAI API endpoint",
  description:
    "Escape hatch: call any ReAI API endpoint directly. Use it for anything the curated tools do " +
    "not cover. Discover the endpoint with reai_search_endpoints and check its schema with " +
    "reai_describe_endpoint first.\n\n" +
    "Authentication and the tenant header are handled for you. Write calls are subject to the " +
    "server's write policy, and unrecognised write paths are treated as irreversible and blocked " +
    "unless REAI_WRITE_MODE=full.\n\n" +
    "Anything that sends to a third party — EHF/Peppol, invoice email, payment reminders, signing " +
    "requests, and issuing an invoice, which starts delivery — is blocked separately unless " +
    "REAI_ALLOW_EXTERNAL_SEND is enabled, regardless of write mode.",
  risk: "read", // Reads are always permitted; writes are classified per-call below.
  destructive: true,
  inputSchema: {
    method: z.enum(HTTP_METHODS).describe("HTTP method."),
    path: z
      .string()
      .describe(
        'Concrete API path with path parameters already substituted, e.g. "/api/customers/1234" ' +
          '(not "/api/customers/{id}"). Must start with "/".',
      ),
    query: z
      .record(z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]))
      .optional()
      .describe("Query-string parameters."),
    body: z.unknown().optional().describe("JSON request body, for POST, PUT and PATCH."),
    tenantId: tenantIdArg,
    binary: z
      .boolean()
      .optional()
      .describe(
        "Set for endpoints returning a file (PDF, attachment content). Returns base64 plus " +
          "content type instead of attempting to parse JSON.",
      ),
  },
  handler: async (args, ctx) => {
    const method = args.method as HttpMethod;

    let raw = args.path.trim();
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      raw = url.pathname + url.search;
    }
    if (!raw.startsWith("/")) raw = `/${raw}`;

    if (raw.includes("{") || raw.includes("}")) {
      return okText(
        `The path still contains a template placeholder: ${raw}\n` +
          `Substitute real values before calling, e.g. "/api/customers/1234".`,
      );
    }

    // Resolve once, then classify and send the *same* resolved path. Doing this
    // in two places with two different values is precisely how a write policy
    // gets bypassed.
    const canonical = canonicalizeApiPath(raw);
    if (!canonical) {
      return okText(
        `Not a usable API path: ${raw}\n` +
          `Give a path on the ReAI API such as "/api/customers/1234".`,
      );
    }
    const path = canonical.pathname;

    // A query string in `path` used to be dropped silently: only `pathname` is kept,
    // so "/api/timesheets?projectId=7" reached the API with no parameters at all and
    // the resulting 400 said the parameters were missing without mentioning that
    // this server had thrown them away. Refused with the values spelled out, rather
    // than merged, so there is no ambiguity about precedence against `query`.
    if (canonical.search) {
      const pairs = [...new URLSearchParams(canonical.search).entries()]
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(", ");
      return okText(
        `Put query parameters in the "query" argument, not in the path.\n` +
          `Path: "${path}"\nquery: { ${pairs} }\n` +
          `A query string inside "path" is discarded, which would have produced a confusing ` +
          `rejection about missing parameters.`,
      );
    }

    // Path first, then the body: a flag like `sendEhf: true` transmits the
    // document to a counterparty, which no amount of path inspection reveals.
    const pathRisk = classifyRequest(method, path);
    const risk = classifyWithBody(pathRisk, args.body);
    const escalated = risk !== pathRisk ? escalatingBodyFields(args.body) : [];
    assertAllowed(
      risk,
      ctx.config.writeMode,
      escalated.length > 0
        ? `${method} ${path} with ${escalated.join(", ")} (this arms an external send)`
        : `${method} ${path}`,
    );

    // Separately from reversibility: does this leave the tenant? Checked after
    // the write policy so the more fundamental refusal is reported first.
    const transmits = classifyTransmission(method, path, args.body);
    const sendFields = transmittingBodyFields(args.body);
    assertTransmitAllowed(
      transmits,
      ctx.config.allowExternalSend,
      sendFields.length > 0 ? `${method} ${path} with ${sendFields.join(", ")}` : `${method} ${path}`,
    );

    const isMeta = path === "/api/me" || path === "/api/tenants";
    let res;
    try {
      res = await ctx.client.request({
        method,
        path,
        query: args.query,
        ...(args.body !== undefined ? { body: args.body } : {}),
        tenantId: resolveTenantId(args.tenantId, ctx),
        omitTenant: isMeta,
        ...(args.binary !== undefined ? { binary: args.binary } : {}),
      });
    } catch (err) {
      // Enrich a rejected call with what this server already knows about the
      // endpoint, then rethrow. The escape hatch only ever sees concrete paths, so
      // until now an agent calling it directly got the API's error and nothing
      // else -- none of the schema and none of the quirks that exist precisely
      // because the schema is not enough.
      //
      // Additive on purpose. The request is still sent first: this spec
      // under-states requirements in places (startDate on /api/vouchers is
      // required by the API and not marked so), which means it may over-state
      // elsewhere, and refusing a call on its authority could block one that
      // would have worked.
      throw enrichRequestFailure(err, method, path, args.query, args.body);
    }

    // A path that matches no API route falls through to the web application, which
    // answers 200 with its HTML shell — "/notarealpath" and a mis-capitalised
    // "/API/opening-balances" both do. That is the worst possible shape for an
    // agent: a success status carrying a login page. Within /api/ a wrong path does
    // 404 properly; this only catches the fall-through, and it is reported as a
    // failure because nothing was actually called.
    // Checked regardless of `binary`: in binary mode ReaiClient.parseBody would
    // base64-encode the HTML shell and this would report a successful attachment
    // download, which is the exact false success the check exists to prevent.
    //
    // But "HTML means the SPA answered" is not quite true. Attachment endpoints
    // declare */* and ReAI stores whatever was uploaded or arrived by email, so an
    // HTML invoice or a saved HTML receipt is an ordinary, successful download. The
    // discriminator is Content-Disposition: the SPA shell never sends one, and
    // parseBody surfaces it as `filename`. A named payload is a real file.
    //
    // The content-type being ABSENT is treated as suspicious rather than fine —
    // ReAI is known to omit it (see the module-gating quirk), and letting undefined
    // fall through left open exactly the false success this guard exists to close.
    // So when it is missing, the body itself is sniffed.
    const contentType = res.contentType ?? "";
    const looksHtml =
      /^text\/html/i.test(contentType) ||
      (contentType === "" && typeof res.data === "string" && /^\s*<(!doctype html|html[\s>])/i.test(res.data));
    const named =
      typeof res.data === "object" && res.data !== null && typeof (res.data as { filename?: unknown }).filename === "string";
    if (looksHtml && !named) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `${method} ${path} returned HTTP ${res.status} with an HTML page, not JSON.\n` +
              `Nothing was called: this path matched no API route, so ReAI served the web ` +
              `application's shell instead. Check the path and its capitalisation — routes are ` +
              `case-sensitive, and most public ones live under "/api/". Use reai_search_endpoints ` +
              `to find the real one.`,
          },
        ],
        isError: true,
      };
    }

    const notes = [`${method} ${path} → HTTP ${res.status}`];
    if (res.location) notes.push(`Location: ${res.location}`);
    if (risk !== "read") notes.push(`Write classified as "${risk}" and permitted by policy.`);

    return ok(res.data ?? "(empty response)", { note: notes.join("\n") });
  },
});

export const discoveryTools: ToolDef[] = [
  searchEndpoints,
  describeEndpoint,
  listApiTags,
  apiNotes,
  request,
] as ToolDef[];
