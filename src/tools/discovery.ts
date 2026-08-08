import { z } from "zod";
import { defineTool, ok, okText, tenantIdArg, resolveTenantId, type ToolDef } from "./registry.js";
import {
  describeOperation,
  findOperation,
  getSpecIndex,
  missingRequired,
  resolveOperation,
  searchOperations,
  omittedReplacementFields,
  resolveRoutedOperation,} from "../reai/spec.js";
import { findQuirks, quirksFor } from "../reai/quirks.js";
import {
  assertAllowed,
  assertTransmitAllowed,
  canonicalizeApiPath,
  classifyRequest,
  classifyTransmission,
  classifyWithBody,
  classifyPaymentRouting,
  inPaymentRoutingScope,
  classifyInvoiceDelivery,
  inInvoiceDeliveryScope,
  invoiceDeliveryChanges,
  routedPathForms,
  escalatingBodyFields,
  paymentRoutingFields,
  transmittingBodyFields,
  type Risk,
} from "../policy.js";
import type { HttpMethod } from "../reai/client.js";
import { ReaiApiError } from "../reai/errors.js";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const searchEndpoints = defineTool({
  name: "reai_search_endpoints",
  title: "Search ReAI API endpoints",
  description:
    "Search the full ReAI OpenAPI surface (321 public operations) by keyword, tag or HTTP method. " +
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
 * Tenant ids the caller named ANYWHERE in the request, which the bound-tenant check
 * would otherwise never see.
 *
 * `resolveTenantId` governs exactly one thing: the value that becomes the X-Tenant-Id
 * header. But twelve operations name a tenant as a path or query parameter, and
 * `/api/accountant-clients/{clientTenantId}` plus its notes endpoints are PUBLIC —
 * which is precisely the accountant case the README describes, one token reaching
 * every client company. So a grant bound to one tenant could still address another by
 * naming it in the path, making the consent page's promise narrower than it reads.
 * Found independently by two reviewers, which is usually a sign it is real.
 *
 * It used to look only where the SPEC declared a tenant parameter, which left two holes,
 * both reachable through `reai_request`:
 *
 *   1. An **unresolvable path** checked nothing at all — `if (!op) return []`. Unknown
 *      paths are deliberately permitted here (the API decodes and normalises before
 *      routing, and refusing what this server cannot resolve would refuse legitimate
 *      calls), so the one gate that must not depend on resolution was the one that did.
 *   2. An **undeclared parameter** was invisible even on a resolved path. The spec
 *      declares what the API documents, not what it reads.
 *   3. The **body** was never looked at, so `POST /api/x {"tenantId": 9999}` passed.
 *
 * Now it scans the path segments, every query key and the whole body for anything named
 * like a tenant, regardless of what the spec says. Measured against the live API on
 * 2026-08-08: `tenantId`, `tenant_id`, `tenant` and `companyId` in the query are all
 * ignored by ReAI, a body tenant id is ignored, and a duplicate `X-Tenant-Id` does not
 * displace the first — so today none of these actually reach another company's books.
 * That is upstream behaviour we neither control nor get told about when it changes, and
 * this gate is the promise the consent page makes to a user. So it fails closed on the
 * request rather than trusting the API to keep ignoring it.
 *
 * Deliberately NOT keyed on risk: a read across the boundary is the disclosure the
 * boundary exists to prevent.
 *
 * The key vocabulary is narrow on purpose -- see `namesATenant` below for the fields a
 * looser rule would have refused.
 */
function tenantIdsInRequest(
  method: HttpMethod,
  path: string,
  query: Record<string, unknown> | undefined,
  body?: unknown,
): number[] {
  const found: number[] = [];
  /** A tenant id is a positive integer. Anything else cannot address a company. */
  const push = (raw: unknown) => {
    if (typeof raw === "number" && Number.isInteger(raw)) found.push(raw);
    else if (typeof raw === "string" && /^\d+$/.test(raw)) found.push(Number(raw));
  };
  /**
   * Keys that name the ACTING tenant. Deliberately narrow, and the narrowness is
   * measured rather than guessed: a plain /tenant/i over the spec's own vocabulary
   * matches `tenantNoticeMonths` (a small integer, so a rental agreement with three
   * months' notice would read as "tenant 3"), `tenantPhone` (eight digits),
   * `enkOwnerPersonIdentifierOnTenant` (eleven), and `tenantBirthDate` — all of which
   * would refuse ordinary writes on a bound connection. A boundary that fires on
   * innocent bodies gets switched off, so it fires on tenant ids only.
   *
   * `companyId` is excluded for a stronger reason: it is a DIFFERENT id space. `Tenant`
   * itself has a `companyId`, and `CustomerRes`, `SupplierRes` and
   * `SubscriptionServiceRecipientRes` all carry one for a counterparty. Treating it as a
   * tenant would refuse the most ordinary write there is.
   */
  const namesATenant = (key: string) => /^(client_?)?tenant_?id$/i.test(key) || /^tenant$/i.test(key);

  // Path parameters still need the spec, because only the spec says which segment is the
  // parameter. A path that resolves to nothing contributes nothing here -- and that is
  // exactly why the query and body scans below do not consult it.
  const op = resolveOperation(method, path);
  if (op) {
    const specSegments = op.path.split("/").filter(Boolean);
    const actualSegments = path.split("/").filter(Boolean);
    for (const param of op.params ?? []) {
      if (param.in !== "path" || !namesATenant(param.name)) continue;
      const index = specSegments.indexOf(`{${param.name}}`);
      if (index >= 0) push(actualSegments[index]);
    }
  }

  // Query keys bind case-insensitively on this API, and are scanned whether or not the
  // spec declares them.
  for (const [key, value] of Object.entries(query ?? {})) {
    if (namesATenant(key)) push(value);
  }

  // The body, at any depth: a tenant id nested under a wrapper object is the same
  // request. Cycles are possible in a hand-built argument object, so nodes are tracked.
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number) => {
    if (node === null || typeof node !== "object" || depth > 8 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (namesATenant(key)) push(value);
      // A `tenant` key may hold the whole Tenant object rather than its id, and that
      // object's own primary key is `id` -- which nothing else here matches, since a bare
      // `id` means the record being written almost everywhere else.
      if (/^tenant$/i.test(key) && value !== null && typeof value === "object" && !Array.isArray(value)) {
        push((value as Record<string, unknown>).id);
      }
      walk(value, depth + 1);
    }
  };
  walk(body, 0);

  return found;
}

/** The worse of two classifications, so an ambiguity can only ever tighten. */
function strictestRisk(a: Risk, b: Risk): Risk {
  const order: Risk[] = ["read", "reversible", "irreversible"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

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
  // 5xx used to return here, which skipped the QUIRKS along with the payload diagnosis. Those
  // are different things: guessing at a payload on a server error is noise, but a quirk
  // written about a 500 is only ever useful on a 500. The order-delete refusal is exactly
  // that — the API answers 500 to a delete it will not perform, and the note saying "this is
  // a refusal, do not retry" was unreachable at the one status it describes.
  //
  // Below 400 there is nothing to enrich, and above 599 is not a status this API produces.
  if (err.status < 400 || err.status > 599) return err;

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
    clearOmittedFields: z
      .boolean()
      .optional()
      .describe(
        "Acknowledge that a PUT will CLEAR the documented fields your body leaves out. Without " +
          "this, a PUT whose body omits optional fields is refused with those fields named, " +
          "because a full replacement stores nothing for what it does not mention — that is how a " +
          "rename emptied a company bank's account number on a live tenant. Prefer reading the " +
          "record and sending it back merged; set this only when clearing those fields is what you " +
          "mean, or when the record does not carry them. PATCH is never checked: it really patches.",
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

    // A bound tenant is a boundary, so it must cover every way a tenant can be named,
    // not just the header. Checked before classification, so the refusal is about the
    // boundary rather than about the write ladder.
    const boundTenant = ctx.config.boundTenantId;
    if (boundTenant !== undefined) {
      const named = tenantIdsInRequest(
        method,
        canonical.decodedPathname,
        args.query,
        args.body,
      ).filter((id) => id !== boundTenant);
      if (named.length > 0) {
        return okText(
          `This connection is bound to tenant ${boundTenant}, and this request names tenant ` +
            `${named.join(", ")} in its path, query or body. Refused.\n` +
            `The tenant chosen at authorization is a boundary, not a default, so it cannot be ` +
            `overridden per call — including by an endpoint that takes a tenant id as a parameter.`,
        );
      }
    }

    // Classified on BOTH the raw path and its decoded form, taking whichever is
    // stricter. The raw form is what gets sent; the decoded form is what the upstream
    // router will match. Percent-encoding a single character of a segment used to
    // move a call from one classification to another — "sign-reques%74" was treated
    // as an unknown sub-path of the reversible /api/agreements prefix and then landed
    // on the endpoint that emails a signing request to a counterparty. Comparing both
    // and taking the worse means it no longer matters which one an attacker aims at.
    const decoded = canonical.decodedPathname;
    const pathRisk = strictestRisk(
      classifyRequest(method, path),
      classifyRequest(method, decoded),
    );
    const bodyRisk = classifyWithBody(pathRisk, args.body);
    // Then payment routing, which needs the path: changing a counterparty's bank
    // details is reversible as a RECORD and irreversible as a PAYMENT, and the loss
    // happens later when a human pays the invoice in the ReAI UI.
    const routingRisk = classifyPaymentRouting(bodyRisk, decoded, args.body, args.method);
    // The operation this call will actually reach, resolved once and reused by the omission gate
    // further down. Every path form, because the API decodes and normalises before routing and this
    // server does not: a form that resolves to no operation is a form every gate keyed on the
    // operation silently stops covering.
    const routedOp = resolveRoutedOperation(method, ...routedPathForms(path, decoded));
    // And invoice delivery, which is the same shape of harm with a different
    // consequence: reversible as a record, permanent as a disclosure. Kept apart so
    // the refusal names the right thing to go and check.
    //
    // `partialBody` is true only for PATCH. A PUT body is the whole record, so an empty
    // `invoiceEmail` in one cannot be told apart from faithfully carrying back an address that is
    // already empty — which is what this hatch tells callers to do a few lines down. Escalating it
    // made PUT /api/orders/{id} refuse every possible body in the default mode, with no curated
    // order-update tool to fall back to. The omission gate below is the mechanism for a replacement.
    const risk = classifyInvoiceDelivery(routingRisk, decoded, args.body, method === "PATCH");
    // Named whenever the call actually repoints a destination, not only when doing so is
    // what escalated it. On a path that is ALREADY irreversible — creating a supplier
    // invoice, say — classifyPaymentRouting returns before it looks at the body, so
    // `routingRisk === bodyRisk` and the refusal used to read as an ordinary ledger write
    // while quietly carrying `paymentDetails.iban`. In `full` mode that call is permitted,
    // and the operator reading the log deserves to know which of the two things it did.
    const routing = paymentRoutingFields(args.body).length > 0 && inPaymentRoutingScope(decoded, args.method)
      ? paymentRoutingFields(args.body)
      : [];
    // Computed by presence and scope, like `routing` above, rather than only when it is what
    // escalated the call — same reason: in `full` mode the call goes through, and a note that does
    // not mention the address it emptied hides the more permanent half of what it did.
    const delivery = inInvoiceDeliveryScope(decoded)
      ? invoiceDeliveryChanges(args.body, method === "PATCH")
      : [];
    // EVERY reason, accumulated. This was a ternary, so a body carrying both `iban` and an emptied
    // `invoiceEmail` was refused for the iban alone: drop that field and the same call earns a second
    // refusal for a reason never mentioned, with a contradictory explanation. curatedArgsEscalate
    // already fixed exactly this on the curated side, with a comment saying so, and the escape hatch
    // kept the shape that comment was written about.
    const escalated: string[] = [];
    if (routing.length > 0) {
      escalated.push(`${routing.join(", ")} (this changes where a payment will go)`);
    }
    if (delivery.length > 0) {
      escalated.push(`${delivery.join("; ")} (this changes where invoices are delivered)`);
    }
    if (bodyRisk !== pathRisk) {
      const arming = escalatingBodyFields(args.body);
      if (arming.length > 0) escalated.push(`${arming.join(", ")} (this arms an external send)`);
    }
    // When nothing in the BODY escalated, the reason lives in the path rule — and the generic
    // explanation is worst exactly there. If the endpoint has a quirk written about why it is
    // irreversible, name it, so a refusal for "this PUT replaces the record" does not read as
    // "this posts to the ledger".
    const pathReason =
      escalated.length === 0 && risk === "irreversible"
        ? (() => {
            const op = routedOp;
            const q = op
              ? quirksFor(method, op.path).find((entry) => entry.kind === "irreversible")
              : undefined;
            return q ? ` — ${q.note.split("\n")[0]}` : "";
          })()
        : "";
    assertAllowed(
      risk,
      ctx.config.writeMode,
      escalated.length > 0
        ? // Every reason carries its own explanation, so the list joins without a suffix that would
          // be wrong for all but one of them: a body can escalate because it arms a send, because it
          // repoints a payment, or because it empties a delivery address, and calling any of those
          // the others would be simply untrue.
          `${method} ${path} with ${escalated.join("; also ")}`
        : `${method} ${path}${pathReason}`,
    );

    // Separately from reversibility: does this leave the tenant? Checked after
    // the write policy so the more fundamental refusal is reported first.
    const rawTransmits = classifyTransmission(method, path, args.body);
    const decodedTransmits = classifyTransmission(method, decoded, args.body);
    const transmits = rawTransmits !== "none" ? rawTransmits : decodedTransmits;
    const sendFields = transmittingBodyFields(args.body);
    assertTransmitAllowed(
      transmits,
      ctx.config.allowExternalSend,
      sendFields.length > 0 ? `${method} ${path} with ${sendFields.join(", ")}` : `${method} ${path}`,
    );

    // A full replacement clears what the body leaves out, and this hatch cannot merge on the
    // caller's behalf the way the curated tools do. Refusing here rather than reporting it
    // afterwards, because "these five fields were just emptied" is not a warning, it is a
    // post-mortem — and every instance of this bug in this repo was found that way.
    //
    // After the policy checks: a call that write mode already refuses should be refused for that
    // reason, which is the more fundamental one.
    if (args.clearOmittedFields !== true) {
      const omitted = routedOp
        ? omittedReplacementFields(routedOp, args.body)
        : { fields: [], documented: 0 };
      if (omitted.fields.length > 0) {
        return okText(
          `${method} ${path} REPLACES the record, and this body leaves out ` +
            `${omitted.fields.length} of its ${omitted.documented} documented field(s), which the ` +
            `API stores as empty:\n\n  ${omitted.fields.join(", ")}\n\n` +
            `Nothing was sent. This is not a theoretical risk on this API — a rename sent to ` +
            `PUT /api/company-banks/{id} emptied the account number its own customers pay into, ` +
            `and the same shape blanked a lease's rent and deposit while the PDF still rendered.\n\n` +
            `Two ways forward. To change some fields and keep the rest, GET the record first, merge ` +
            `your changes over it, and send the whole thing — that is what this server's curated ` +
            `tools do for the endpoints they cover. To genuinely clear those fields, or if the ` +
            `record does not carry them, pass clearOmittedFields: true and this exact call will go ` +
            `through.\n\n` +
            `Only PUT is checked. PATCH on this API really does patch — measured — so a partial ` +
            `PATCH body is not flagged.`,
        );
      }
    }

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

    // Quirks on a write that SUCCEEDED, not only on one that failed.
    //
    // enrichRequestFailure was the only place these were attached, which is fine for the notes
    // that explain an error and useless for the ones whose whole point is that the call succeeds
    // and does something unexpected. The case that exposed it: PUT /api/company-banks/{id}
    // answers 200 and CLEARS the account number the body left out — so the 200 was the only
    // thing the caller saw, and the quirk written about exactly that never appeared.
    //
    // Restricted to writes, because a read cannot surprise anyone this way, and to quirks with
    // no `statuses` filter — that field means "this note is about one outcome", and those are
    // failure notes by construction. Anything left holds regardless of outcome, which is the
    // definition of what belongs on a success.
    if (risk !== "read") {
      // Both path forms here too. An encoded path resolved to nothing, so a write that reached a
      // quirked endpoint by that route got the bare 200 and none of the warning — the same blind
      // spot as the omission gate, with a quieter consequence.
      const op = routedOp;
      const always = op ? quirksFor(method, op.path).filter((q) => q.statuses === undefined) : [];
      for (const q of always) notes.push(`Known quirk [${q.kind}]: ${q.note}`);
    }

    // A bound connection must not disclose the OTHER companies the underlying ReAI token
    // reaches — reai_whoami filters its tenant list for exactly that reason, and the README
    // describes the binding as a disclosure boundary. But the boundary was tool-dependent:
    // GET /api/me through this escape hatch returned every company verbatim. Verified with a
    // three-tenant response on a connection bound to one — whoami showed one, this showed
    // all three. The binding has to hold whichever door the agent walks through.
    const body = redactUnboundTenants(res.data, ctx.config.boundTenantId, isMeta, notes);

    return ok(body ?? "(empty response)", { note: notes.join("\n") });
  },
});

/**
 * Strip companies a bound connection may not address from a /api/me or /api/tenants body.
 *
 * Shape-tolerant on purpose: the point is a disclosure boundary, so an unrecognised shape
 * is withheld rather than passed through on the assumption it holds nothing sensitive.
 */
function redactUnboundTenants(
  data: unknown,
  bound: number | undefined,
  isMeta: boolean,
  notes: string[],
): unknown {
  if (!isMeta || bound === undefined || data === undefined || data === null) return data;

  const keep = (list: unknown): unknown[] | undefined =>
    Array.isArray(list) ? list.filter((t) => (t as { id?: number })?.id === bound) : undefined;

  if (Array.isArray(data)) {
    const kept = keep(data);
    if (kept && kept.length !== data.length) {
      notes.push(
        `Filtered to tenant ${bound}: this connection is bound to one company and does not ` +
          `disclose the others the underlying token reaches. reai_whoami shows the same view.`,
      );
    }
    return kept ?? data;
  }
  if (typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (!("tenants" in record)) return data;
    const kept = keep(record.tenants);
    notes.push(
      kept
        ? `Filtered to tenant ${bound}: this connection is bound to one company and does not ` +
          `disclose the others the underlying token reaches. reai_whoami shows the same view.`
        : `The tenants field was withheld: this connection is bound to tenant ${bound}, and the ` +
          `field was not a list, so it could not be filtered to that company.`,
    );
    return { ...record, tenants: kept ?? null };
  }
  return data;
}

export const discoveryTools: ToolDef[] = [
  searchEndpoints,
  describeEndpoint,
  listApiTags,
  apiNotes,
  request,
] as ToolDef[];
