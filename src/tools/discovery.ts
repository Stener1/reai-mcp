import { z } from "zod";
import { defineTool, ok, okText, tenantIdArg, resolveTenantId, type ToolDef } from "./registry.js";
import { describeOperation, findOperation, getSpecIndex, searchOperations } from "../reai/spec.js";
import { assertAllowed, canonicalizeApiPath, classifyRequest } from "../policy.js";
import type { HttpMethod } from "../reai/client.js";

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

    const results = hits.map((h) => ({
      call: `${h.method} ${h.path}`,
      tag: h.tag,
      ...(h.summary ? { summary: h.summary } : {}),
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
    }));

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
    return ok(describeOperation(op, args.depth ?? 4), {
      note: `Schema for ${op.method} ${op.path}. Call it with reai_request.`,
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

const request = defineTool({
  name: "reai_request",
  title: "Call any ReAI API endpoint",
  description:
    "Escape hatch: call any ReAI API endpoint directly. Use it for anything the curated tools do " +
    "not cover. Discover the endpoint with reai_search_endpoints and check its schema with " +
    "reai_describe_endpoint first.\n\n" +
    "Authentication and the tenant header are handled for you. Write calls are subject to the " +
    "server's write policy, and unrecognised write paths are treated as irreversible and blocked " +
    "unless REAI_WRITE_MODE=full.",
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

    const risk = classifyRequest(method, path);
    assertAllowed(risk, ctx.config.writeMode, `${method} ${path}`);

    const isMeta = path === "/api/me" || path === "/api/tenants";
    const res = await ctx.client.request({
      method,
      path,
      query: args.query,
      ...(args.body !== undefined ? { body: args.body } : {}),
      tenantId: resolveTenantId(args.tenantId, ctx),
      omitTenant: isMeta,
      ...(args.binary !== undefined ? { binary: args.binary } : {}),
    });

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
  request,
] as ToolDef[];
