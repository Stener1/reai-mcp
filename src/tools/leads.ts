import { z } from "zod";
import { defineTool, isoDate, ok, requireTenantId, tenantIdArg, type ToolDef } from "./registry.js";

/**
 * Leads — a search over the Norwegian company register (Brønnøysund), plus whatever CRM state this
 * tenant has attached to a company.
 *
 * Not a list of records this tenant owns, which is the thing to understand before using it. The
 * default search returns companies from the REGISTER, most of which this tenant has never touched:
 * measured, the first page came back with `id: null` and `status: null` on every row. An entry
 * becomes a saved lead only once something is written to it, and `leadFilter` is what separates the
 * two — all | saved | unsaved.
 *
 * ## Two addressing schemes, and only one of them always works
 *
 * `/api/leads/{id}` and `/api/leads/org/{orgNumber}` both exist. An unsaved company has NO id, so
 * the first cannot address it: measured, `GET /api/leads/null` answers
 * `400 "Failed to convert 'id' with value: 'null'"`. The org number is on every row whether saved
 * or not, so that is the addressing this server uses.
 *
 * ## The result says how many pages, never how many matches
 *
 * The envelope is `{items, page, hasPrevious, hasNext, latestRegisteredAt}`. There is no total, so
 * "how many companies match" cannot be answered from one call and this tool does not pretend
 * otherwise — it reports what came back and whether more exists.
 */

/** Lead state as the DETAIL response carries it — nested, unlike the flattened search row. */
type LeadState = {
  id?: number | null;
  status?: string | null;
  notes?: string | null;
  followUpAt?: string | null;
  convertedCustomerId?: number | null;
  convertedAt?: string | null;
};

type LeadRow = {
  id?: number | null;
  orgNumber?: string;
  companyName?: string;
  city?: string | null;
  legalFormCode?: string | null;
  industryDescription?: string | null;
  hasAccountant?: boolean | null;
  hasEmail?: boolean | null;
  hasPhone?: boolean | null;
  registeredAt?: string | null;
  status?: string | null;
  followUpAt?: string | null;
  /** Only on the detail response. The search row flattens these to the top level instead. */
  lead?: LeadState | null;
};

type LeadPage = {
  items?: LeadRow[];
  page?: number;
  hasPrevious?: boolean;
  hasNext?: boolean;
  latestRegisteredAt?: string | null;
};

const searchLeads = defineTool({
  name: "reai_search_leads",
  title: "Search companies and leads",
  description:
    "Search the Norwegian company register (Brønnøysund) with this tenant's lead state layered on " +
    "top. This is prospecting: filter by legal form, industry, city, registration date, whether the " +
    "company has an accountant registered, and whether the register holds an email or phone.\n\n" +
    "Most results are NOT leads yet. The register is the source, so a row with id null and status " +
    "null is a company nobody here has touched — measured, that is the whole of the default first " +
    "page. `leadFilter` separates them: saved for companies this tenant has written to, unsaved for " +
    "the rest.\n\n" +
    "The response carries no total. It says which page you are on and whether another exists, so " +
    "\"how many match\" is not a question one call can answer, and this tool reports the count it " +
    "actually received rather than implying more.\n\n" +
    "Nothing here contacts anybody. Placing a call is a separate, internal endpoint that this " +
    "server treats as an external send.",
  risk: "read",
  apiPaths: [["GET", "/api/leads"]],
  inputSchema: {
    query: z
      .string()
      .max(200, "The API caps query at 200 characters.")
      .optional()
      .describe("Free-text match on company name or organisation number."),
    leadFilter: z
      .enum(["all", "saved", "unsaved"])
      .optional()
      .describe(
        "saved = companies this tenant has lead state on; unsaved = register entries it has not " +
          "touched. Default includes both, which is usually not what a question about 'our leads' means.",
      ),
    statusFilter: z
      .enum(["all", "no_status", "active", "disqualified", "converted"])
      .optional()
      .describe("Lead status. `all` includes unsaved companies too."),
    contactStatus: z
      .enum(["any", "not_contacted", "contacted"])
      .optional()
      .describe("Whether the lead has any contact events recorded."),
    legalFormCode: z
      .string()
      .max(500, "The API caps legalFormCode at 500 characters.")
      .optional()
      .describe('Comma-separated Brreg legal-form codes, e.g. "AS,ENK,NUF".'),
    industryCodePrefix: z
      .string()
      .max(500, "The API caps industryCodePrefix at 500 characters.")
      .optional()
      .describe('Comma-separated Brreg industry-code prefixes, e.g. "62" for IT services.'),
    city: z
      .string()
      .max(1000, "The API caps city at 1000 characters.")
      .optional()
      .describe("Comma-separated city names. Exact match, case-insensitive."),
    hasAccountant: z
      .boolean()
      .optional()
      .describe(
        "Whether Brreg lists an accountant for the company. False is the prospecting filter for an " +
          "accounting firm: companies keeping their own books.",
      ),
    vatRegistered: z.boolean().optional().describe("Filter by VAT registration."),
    requireEmail: z.boolean().optional().describe("Only companies with an email in Brreg."),
    requirePhone: z.boolean().optional().describe("Only companies with a phone or mobile in Brreg."),
    registeredStartDate: isoDate.optional().describe("Registered in Brreg on or after this date."),
    registeredEndDate: isoDate.optional().describe("Registered in Brreg on or before this date."),
    followUpDueStartDate: isoDate
      .optional()
      .describe("Leads with followUpAt on or after this date. Leads without one are excluded."),
    followUpDueEndDate: isoDate.optional().describe("Leads with followUpAt on or before this date."),
    deduplicateByOwner: z
      .boolean()
      .optional()
      .describe("Collapse rows sharing an email or phone, keeping one per owner."),
    page: z.number().int().min(1).optional().describe("1-based page number."),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(200, "The API caps pageSize at 200, and answers a bare 400 \"Validation failed\" above it.")
      .optional()
      .describe("Rows per page, at most 200 — measured, 500 answers 400 \"Validation failed\"."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...query } = args;
    const res = await ctx.client.request<LeadPage>({
      method: "GET",
      path: "/api/leads",
      query,
      tenantId: requireTenantId(tenantId, ctx),
    });
    const page = res.data ?? {};
    const rows = Array.isArray(page.items) ? page.items : undefined;
    if (rows === undefined) {
      return ok(page, {
        note:
          "The response carried no `items` array, so how many companies matched is UNKNOWN — do not " +
          "read that as none. This endpoint returns an envelope " +
          "{items, page, hasPrevious, hasNext}; read the body below.",
      });
    }
    const unsaved = rows.filter((r) => r.id === null || r.id === undefined).length;
    const notes = [
      `${rows.length} row(s) on page ${page.page ?? "?"}` +
        (page.hasNext === true
          ? ", and there are more — raise `page` to walk them."
          : page.hasNext === false
            ? ", and this is the last page."
            : ".") +
        ` The API returns no total, so how many match altogether is not something this call can say.`,
    ];
    if (unsaved > 0) {
      notes.push(
        `${unsaved} of them are UNSAVED register entries — companies this tenant has no lead state ` +
          `on, with id null. They are addressed by orgNumber, not by id: reai_get_lead takes the ` +
          `organisation number for exactly that reason. Pass leadFilter: "saved" to see only the ` +
          `ones already worked.`,
      );
    }
    if (rows.length > 0) {
      const noAccountant = rows.filter((r) => r.hasAccountant === false).length;
      notes.push(
        `${noAccountant} of these have no accountant registered in Brreg, ` +
          `${rows.filter((r) => r.hasEmail === true).length} have an email and ` +
          `${rows.filter((r) => r.hasPhone === true).length} a phone. Those flags come from the ` +
          `register, not from this tenant.`,
      );
    }
    return ok(page, { note: notes.join("\n\n") });
  },
});

const getLead = defineTool({
  name: "reai_get_lead",
  title: "Get one company or lead",
  description:
    "One company from the register, with this tenant's lead state on it if there is any — addressed " +
    "by ORGANISATION NUMBER.\n\n" +
    "That is deliberate. The API also offers /api/leads/{id}, but an unsaved company has no id: " +
    "measured, a search row comes back with id null and " +
    "`GET /api/leads/null` answers 400 \"Failed to convert 'id' with value: 'null'\". The " +
    "organisation number is present on every row whether the company has been saved as a lead or " +
    "not, so it is the only handle that always works.\n\n" +
    "Note the two endpoints do not agree on shape: this one nests lead state under a `lead` object " +
    "(id, status, notes, followUpAt, convertedCustomerId), while a search ROW flattens id and status " +
    "to the top level. Measured on a live response, and worth knowing if you read the body directly.",
  risk: "read",
  apiPaths: [["GET", "/api/leads/org/{orgNumber}"]],
  inputSchema: {
    orgNumber: z
      .string()
      .regex(/^\d{9}$/, "A Norwegian organisation number is exactly 9 digits.")
      .describe("Organisation number, 9 digits, from reai_search_leads."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<LeadRow>({
      method: "GET",
      path: `/api/leads/org/${encodeURIComponent(args.orgNumber)}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const record = res.data ?? {};
    // The DETAIL response nests lead state under `lead` (LeadRes.lead: LeadStateRes) while a SEARCH
    // row flattens id/status to the top level. Reading the top level here reported every saved lead
    // as untouched — and the test missed it by mocking the search shape, which is the trap: two
    // endpoints in one domain with different shapes for the same fields. Both are read, detail first.
    const state: LeadState = record.lead ?? {
      id: record.id,
      status: record.status,
      followUpAt: record.followUpAt,
    };
    const saved = state.id !== null && state.id !== undefined;
    return ok(record, {
      note:
        `${record.companyName ?? args.orgNumber}${record.city ? ` (${record.city})` : ""}: ` +
        (saved
          ? `a SAVED lead, id ${state.id}, status ${JSON.stringify(state.status ?? null)}` +
            (state.followUpAt ? `, follow-up ${state.followUpAt}` : "") +
            (state.convertedCustomerId
              ? `, already converted to customer ${state.convertedCustomerId}`
              : ``) +
            `.`
          : `a register entry with NO lead state on this tenant — its lead.id is null, so nothing ` +
            `here has been worked. Writing a note, status or follow-up is what turns it into a ` +
            `saved lead.`) +
        (record.hasAccountant === false
          ? `\n\nBrreg lists no accountant for this company.`
          : record.hasAccountant === true
            ? `\n\nBrreg lists an accountant for this company.`
            : ``),
    });
  },
});

export const leadTools: ToolDef[] = [searchLeads, getLead];
