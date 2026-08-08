import { z } from "zod";
import {
  defineTool,
  fail,
  isoDate,
  ok,
  requireTenantId,
  tenantIdArg,
  type ToolContext,
  type ToolDef,
  PHONE_RULE,
} from "./registry.js";

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
 *
 * ## Writing: null means two different things depending on which endpoint you use
 *
 * There are two ways to change lead state and they disagree about null, which is the trap this
 * module exists to hide. Measured on tenant 2783, seeding every field and then sending nulls:
 *
 *   - `PATCH /api/leads/org/{orgNumber}` — null LEAVES THE VALUE ALONE. Sending
 *     `{notes: null, email: null, phone: null, followUpAt: null}` against a lead holding all four
 *     changed nothing at all. PATCH can only set.
 *   - `PUT .../notes`, `PUT .../follow-up`, `PUT .../contact` — null CLEARS. The same nulls through
 *     these endpoints emptied the fields.
 *
 * So "clear the follow-up date" is impossible through the endpoint that looks like the general
 * update, and succeeds silently-looking through another. `reai_update_lead` takes one uniform rule —
 * omit to keep, null to clear — and routes each field to whichever endpoint actually does that.
 *
 * Two further measured facts shape these tools:
 *
 *   - `PUT .../contact` does not have ONE behaviour for a body carrying just one of its two fields,
 *     which is the strangest thing measured in this API so far. On a lead holding an email and a
 *     phone, `{phone: null}` sent on its own was a complete no-op — four trials out of four, on
 *     freshly created leads, re-read after four seconds, with the phone it explicitly named still
 *     in place. The identical body, sent by this tool immediately after `PUT /notes` and
 *     `PUT /follow-up`, behaved as a full replacement and cleared the email it had omitted. I could
 *     not reduce the difference to anything in the request. So `reai_update_lead` always sends BOTH
 *     fields, carrying over whichever one the caller did not mention: under the replacement reading
 *     that preserves it, and under the no-op reading the call is no longer single-key so it lands.
 *     Sending one field and trusting either story is the thing to avoid.
 *   - `PUT .../contact` is also the ONE write that does not create the lead. Every other write
 *     materialises a register company on first use: measured, PATCH, `PUT /status`,
 *     `PUT /follow-up` and `POST /contact-events` each turned `lead.id: null` into a real id.
 *     `PUT /contact` answered 200 and left the id null, which means the email and phone went
 *     nowhere at all. A success that stores nothing is the worst shape a write can have, so
 *     `reai_update_lead` saves the lead first whenever it is about to write to an unsaved company.
 *   - Status, once set, cannot be unset. `PatchLeadReq.status` documents "To clear an existing
 *     status use PUT /status with explicit null"; measured, that answers 400 "Validation failed" and
 *     the status stayed `disqualified`. active ↔ disqualified, or delete the lead. Nothing else.
 */

/** Lead state as the DETAIL response carries it — nested, unlike the flattened search row. */
type LeadState = {
  id?: number | null;
  status?: string | null;
  notes?: string | null;
  email?: string | null;
  phone?: string | null;
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
  notes?: string | null;
  email?: string | null;
  phone?: string | null;
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

/** Reads current lead state through the detail endpoint, which nests it under `lead`. */
async function readLeadState(
  ctx: ToolContext,
  tenantId: number,
  orgNumber: string,
): Promise<{ record: LeadRow; state: LeadState }> {
  const res = await ctx.client.request<LeadRow>({
    method: "GET",
    path: `/api/leads/org/${encodeURIComponent(orgNumber)}`,
    tenantId,
  });
  const record = res.data ?? {};
  // The fallback carries EVERY field, not just id and status. It never fires today — an untouched
  // company still returns a `lead` object with all fields null — but if a response ever arrived
  // flattened, dropping email and phone here would make the contact carry-over send null for a field
  // the caller never mentioned, which is exactly the silent data loss these tools exist to prevent.
  return {
    record,
    state:
      record.lead ?? {
        id: record.id,
        status: record.status,
        notes: record.notes,
        email: record.email,
        phone: record.phone,
        followUpAt: record.followUpAt,
      },
  };
}

const isSaved = (state: LeadState) => state.id !== null && state.id !== undefined;

const orgNumberArg = z
  .string()
  .regex(/^\d{9}$/, "A Norwegian organisation number is exactly 9 digits.")
  .describe("Organisation number, 9 digits, from reai_search_leads.");

const saveLead = defineTool({
  name: "reai_save_lead",
  title: "Start tracking a company as a lead",
  description:
    "Turn a register entry into a saved lead on this tenant, with no state on it yet.\n\n" +
    "Only needed to claim a company before you have anything to say about it. Nearly every write " +
    "creates the row on its own — measured, a company reading `lead.id: null` had a real id " +
    "immediately after a single `PUT .../notes`, and the same for PATCH, status, follow-up and a " +
    "contact event. The exception is `PUT .../contact`, which answers 200 and leaves the id null, " +
    "storing neither email nor phone; reai_update_lead handles that by saving first, so it does not " +
    "need this tool either.\n\n" +
    "Calling it on an already-saved lead is harmless and changes nothing. Deleting the lead again " +
    "returns the company to the register-only state this started from.",
  risk: "reversible",
  apiPaths: [["POST", "/api/leads"]],
  idempotent: true,
  inputSchema: { orgNumber: orgNumberArg, tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const before = await readLeadState(ctx, tenantId, args.orgNumber);
    if (isSaved(before.state)) {
      return ok(before.record, {
        note:
          `${before.record.companyName ?? args.orgNumber} was ALREADY a saved lead (id ` +
          `${before.state.id}, status ${JSON.stringify(before.state.status ?? null)}). Nothing was ` +
          `written.`,
      });
    }
    await ctx.client.request({
      method: "POST",
      path: "/api/leads",
      tenantId,
      body: { orgNumber: args.orgNumber },
    });
    // The POST response does not carry the new state, and a saved-but-empty lead is exactly the
    // shape that reads like a failure, so the id is read back rather than assumed.
    const after = await readLeadState(ctx, tenantId, args.orgNumber);
    const result = ok(after.record, {
      note: isSaved(after.state)
        ? `${after.record.companyName ?? args.orgNumber} is now a saved lead, id ${after.state.id}, ` +
          `with no status, notes or follow-up on it. reai_update_lead sets those.`
        : `The POST succeeded but the lead still reads id null, so nothing was actually saved. Do ` +
          `not treat this company as tracked.`,
    });
    // Flagged on the RESULT, following reai_set_employee_bank_account: a verified non-outcome must reach
    // the caller as an error and not only as prose, since prose is what an agent skims. Not fail(),
    // because the response body is the evidence for the claim and discarding it would hide it.
    if (!isSaved(after.state)) result.isError = true;
    return result;
  },
});

const updateLead = defineTool({
  name: "reai_update_lead",
  title: "Set or clear lead status, notes, contact details and follow-up",
  description:
    "Change this tenant's CRM state on a company: status, notes, email, phone, follow-up date. " +
    "Creates the lead if it does not exist yet, so a company straight out of reai_search_leads can " +
    "be written to directly.\n\n" +
    "One rule for every field: OMIT to leave it alone, pass NULL to clear it. The API does not work " +
    "that way and that is the reason this tool exists. `PATCH /api/leads/org/{orgNumber}` documents " +
    "null as 'leave unchanged', so clearing through it is impossible — measured, nulls for notes, " +
    "email, phone and followUpAt against a lead holding all four changed nothing. The `PUT` setters " +
    "do clear. This tool sends each field to whichever endpoint honours the intent: one PATCH for " +
    "the values being set, and the specific setter for each value being cleared. It reports which " +
    "calls it made.\n\n" +
    "Status is the exception, and not because of this tool. It accepts active or disqualified and " +
    "CANNOT BE CLEARED once set: the spec says to clear it with `PUT /status` and an explicit null, " +
    "and that answers 400 'Validation failed' with the old status still in place. Passing null here " +
    "is refused up front with that explanation rather than forwarded. `converted` is not settable " +
    "either — it is what reai_convert_lead produces.\n\n" +
    "Phone numbers come back normalised: 40000000 was stored as +4740000000.",
  risk: "reversible",
  apiPaths: [
    ["POST", "/api/leads"],
    ["PATCH", "/api/leads/org/{orgNumber}"],
    ["PUT", "/api/leads/org/{orgNumber}/notes"],
    ["PUT", "/api/leads/org/{orgNumber}/follow-up"],
    ["PUT", "/api/leads/org/{orgNumber}/contact"],
  ],
  inputSchema: {
    orgNumber: orgNumberArg,
    status: z
      .enum(["active", "disqualified"])
      .nullable()
      .optional()
      .describe(
        "active or disqualified. Omit to leave unchanged. Null is REFUSED, because no endpoint can " +
          "unset a status — see the tool description. `converted` is set by reai_convert_lead only.",
      ),
    notes: z
      .string()
      .max(20000, "The API caps notes at 20000 characters.")
      .nullable()
      .optional()
      .describe(
        "Free-text notes. Omit to leave unchanged, null or an empty string to clear. Replaces any " +
          "existing note.",
      ),
    email: z
      .string()
      .max(320, "The API caps email at 320 characters.")
      .nullable()
      .optional()
      .describe("Lead email. Omit to leave unchanged, null to clear."),
    phone: z
      .string()
      .max(64, "The API caps phone at 64 characters.")
      .nullable()
      .optional()
      .describe(`Lead phone. Omit to leave unchanged, null to clear. ${PHONE_RULE}`),
    followUpAt: isoDate
      .nullable()
      .optional()
      .describe("Follow-up date, YYYY-MM-DD. Omit to leave unchanged, null to clear."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const org = encodeURIComponent(args.orgNumber);
    const given = (key: keyof typeof args) => args[key] !== undefined;

    if (!given("status") && !given("notes") && !given("email") && !given("phone") && !given("followUpAt")) {
      return fail(
        "Nothing to change: pass at least one of status, notes, email, phone or followUpAt. To " +
          "start tracking a company with no state on it, use reai_save_lead.",
      );
    }
    if (given("status") && args.status === null) {
      return fail(
        "A lead status cannot be cleared. `PatchLeadReq.status` says to clear it with " +
          "`PUT /status` and an explicit null; measured against the live API that answers 400 " +
          '"Validation failed" and leaves the old status in place. Set it to active or ' +
          "disqualified instead, or remove the lead entirely with reai_delete_lead.",
      );
    }

    const before = await readLeadState(ctx, tenantId, args.orgNumber);
    const calls: string[] = [];

    // A request that only CLEARS things has nothing to do on a company with no lead state, and
    // acting on it anyway would create a lead in order to empty it — state produced by a request to
    // remove state. Reported as the answer it is rather than as an error, since the caller's
    // intended end state is already the actual one.
    const asksToClear = (key: "notes" | "email" | "phone" | "followUpAt") =>
      args[key] === null || (key === "notes" && args[key] === "");
    const clearsOnly = (["notes", "email", "phone", "followUpAt"] as const).every(
      (key) => !given(key) || asksToClear(key),
    );
    if (!isSaved(before.state) && clearsOnly && !given("status")) {
      return ok(before.record, {
        note:
          `${before.record.companyName ?? args.orgNumber} has no lead state on this tenant — ` +
          `lead.id is null, so the fields you asked to clear are already empty. Nothing was written, ` +
          `and in particular no lead was created just to empty it.`,
      });
    }

    // Save the lead first when it does not exist. Most writes would create it themselves, but
    // `PUT .../contact` does NOT: measured, it answers 200 against an unsaved company and leaves
    // lead.id null, so the email and phone are accepted and discarded. Doing this unconditionally
    // rather than only for contact keeps one call shape for every combination of fields, and it is
    // one extra request only on a company that has never been touched.
    if (!isSaved(before.state)) {
      await ctx.client.request({
        method: "POST",
        path: "/api/leads",
        tenantId,
        body: { orgNumber: args.orgNumber },
      });
      calls.push(
        `POST /api/leads to create the lead first — PUT .../contact silently stores nothing on an ` +
          `unsaved company`,
      );
    }

    // Values being SET go in one PATCH; the endpoint takes them all and ignores what is absent.
    const patch: Record<string, unknown> = {};
    if (args.status !== undefined && args.status !== null) patch.status = args.status;
    // An empty string is a CLEAR, not a set: UpdateLeadNotesReq documents "Null or empty clears the
    // notes", and PATCH cannot clear at all, so routing "" through it would store an empty note on
    // some tenants and silently do nothing on others. It goes to the setter with the nulls instead.
    if (typeof args.notes === "string" && args.notes !== "") patch.notes = args.notes;
    if (typeof args.followUpAt === "string") patch.followUpAt = args.followUpAt;
    if (Object.keys(patch).length > 0) {
      await ctx.client.request({ method: "PATCH", path: `/api/leads/org/${org}`, tenantId, body: patch });
      calls.push(`PATCH /api/leads/org/${args.orgNumber} to set ${Object.keys(patch).join(", ")}`);
    }

    // Values being CLEARED each need their own setter, which is the only place null means clear.
    if (args.notes === null || args.notes === "") {
      await ctx.client.request({
        method: "PUT",
        path: `/api/leads/org/${org}/notes`,
        tenantId,
        body: { notes: null },
      });
      calls.push(`PUT .../notes with null to clear the notes`);
    }
    if (args.followUpAt === null) {
      await ctx.client.request({
        method: "PUT",
        path: `/api/leads/org/${org}/follow-up`,
        tenantId,
        body: { followUpAt: null },
      });
      calls.push(`PUT .../follow-up with null to clear the follow-up date`);
    }

    // Contact is sent with BOTH fields, always, carrying over the one the caller did not mention.
    //
    // Not defensive padding — a single-key call to this endpoint does not have one meaning. Sent on
    // its own against a lead holding an email and a phone, `{phone: null}` was a complete no-op,
    // four times out of four, leaving even the phone it named untouched. The same body, sent by this
    // tool after `PUT /notes` and `PUT /follow-up` in the same request sequence, behaved as a full
    // replacement and cleared the email it had omitted. Both were measured on tenant 2783 against
    // freshly created leads, and I could not reduce the difference to anything in the request
    // itself. Sending both fields removes the question: under the replacement reading the carried
    // value preserves what the caller kept, and under the no-op reading the call is no longer
    // single-key, so it applies. The one thing not to do is send one field and trust either story.
    if (given("email") || given("phone")) {
      const carry = <K extends "email" | "phone">(key: K) =>
        given(key) ? (args[key] as string | null) : (before.state[key] ?? null);
      const body: Record<string, unknown> = { email: carry("email"), phone: carry("phone") };
      await ctx.client.request({
        method: "PUT",
        path: `/api/leads/org/${org}/contact`,
        tenantId,
        body,
      });
      calls.push(
        `PUT .../contact with ${(["email", "phone"] as const)
          .map((k) =>
            given(k)
              ? `${k} ${args[k] === null ? "cleared" : "set"}`
              : `${k} carried over unchanged (${JSON.stringify(body[k])})`,
          )
          .join(" and ")}`,
      );
    }

    const after = await readLeadState(ctx, tenantId, args.orgNumber);

    // Verify the end state the caller asked for, and separate two very different outcomes.
    //
    // Worth checking at all in this domain because one of these endpoints answered 200 and stored
    // nothing, and another applied to a different set of fields than the body named. But byte
    // equality is the wrong test: ReAI rewrites what it stores, and not only for phone numbers —
    // reai_create_customer documents the stored name coming back title-cased. Comparing exactly
    // would report a successful write as a failure the first time an agent's note carried a trailing
    // space or the API returned a date as a timestamp.
    //
    // So only the two things that cannot be normalisation count as failures: a field asked to be
    // CLEARED that still reads a value, and a field asked to be SET that reads null. A stored value
    // that differs some other way is reported as a difference and nothing more. This is also why
    // phone needs no special case any more — the general rule already covers it.
    const failures: string[] = [];
    const rewritten: string[] = [];
    const show = (v: unknown) => JSON.stringify(v ?? null);
    const check = (key: "status" | "notes" | "email" | "phone" | "followUpAt") => {
      if (!given(key)) return;
      const want = key !== "status" && asksToClear(key) ? null : (args[key] ?? null);
      const got = after.state[key] ?? null;
      if (want === null) {
        if (got !== null) failures.push(`${key}: asked to clear it, reads ${show(got)}`);
        return;
      }
      if (got === null) {
        failures.push(`${key}: asked for ${show(want)}, reads null`);
        return;
      }
      if (String(want) !== String(got)) rewritten.push(`${key}: sent ${show(want)}, stored ${show(got)}`);
    };
    check("status");
    check("notes");
    check("email");
    check("phone");
    check("followUpAt");
    // The row itself, which is the failure the whole save-first exists to prevent: without this the
    // note could read "this CREATED lead null" and still report success, because every field the
    // caller named happened to come back as asked.
    if (!isSaved(after.state)) {
      failures.push(
        `the lead still reads id null, so none of this was stored against anything — see ` +
          `reai_save_lead for the same failure mode`,
      );
    }

    const field = (key: keyof LeadState) =>
      `${String(key)} ${JSON.stringify(after.state[key] ?? null)}`;
    const result = ok(after.record, {
      note:
        `${after.record.companyName ?? args.orgNumber}` +
        (isSaved(before.state)
          ? ` (lead ${after.state.id})`
          : ` — it had no lead state, so this CREATED lead ${after.state.id}`) +
        `.\n\nCalls made:\n` +
        calls.map((c) => `  - ${c}`).join("\n") +
        `\n\nState now: ${field("status")}, ${field("notes")}, ${field("followUpAt")}` +
        (after.state.convertedCustomerId
          ? `. Still linked to customer ${after.state.convertedCustomerId} from an earlier conversion.`
          : `.`) +
        (failures.length > 0
          ? `\n\nBUT THE WRITE DID NOT FULLY TAKE. Read back from the API:\n` +
            failures.map((m) => `  - ${m}`).join("\n") +
            `\n\nEvery call above returned success, so this is the API storing something other ` +
            `than what it accepted. Re-read with reai_get_lead before relying on any of it.`
          : ``) +
        (rewritten.length > 0
          ? `\n\nStored, but not exactly as sent — this API rewrites values (a phone becomes E.164, ` +
            `a name comes back title-cased):\n` + rewritten.map((m) => `  - ${m}`).join("\n")
          : ``),
    });
    if (failures.length > 0) result.isError = true;
    return result;
  },
});

const logLeadContact = defineTool({
  name: "reai_log_lead_contact",
  title: "Record that a lead was contacted",
  description:
    "Append a contact event to a lead: when it happened, through which channel, and an optional " +
    "180-character note. Creates the lead if it does not exist yet.\n\n" +
    "This RECORDS contact that already happened. It sends nothing and reaches nobody — placing a " +
    "call is a different, internal endpoint this server treats as an external send and does not " +
    "expose.\n\n" +
    "There is no endpoint that removes a contact event. The API has no DELETE for them, so the only " +
    "way to take one back is reai_delete_lead, which discards the whole lead including its notes " +
    "and every other event. Worth knowing before logging a guess.",
  risk: "reversible",
  apiPaths: [["POST", "/api/leads/org/{orgNumber}/contact-events"]],
  inputSchema: {
    orgNumber: orgNumberArg,
    contactedOn: isoDate.describe("The date contact happened, YYYY-MM-DD."),
    source: z
      .enum(["email", "phone", "message", "other"])
      .describe("How contact happened."),
    note: z
      .string()
      .max(180, "The API caps a contact-event note at 180 characters.")
      .optional()
      .describe("Optional short note. For anything longer, put it in the lead notes instead."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const before = await readLeadState(ctx, tenantId, args.orgNumber);
    const res = await ctx.client.request<{ id?: number }>({
      method: "POST",
      path: `/api/leads/org/${encodeURIComponent(args.orgNumber)}/contact-events`,
      tenantId,
      body: {
        contactedOn: args.contactedOn,
        source: args.source,
        ...(args.note === undefined ? {} : { note: args.note }),
      },
    });
    return ok(res.data ?? {}, {
      note:
        `Logged ${args.source} contact with ${before.record.companyName ?? args.orgNumber} on ` +
        `${args.contactedOn}` +
        (res.data?.id ? ` as event ${res.data.id}` : ``) +
        `.` +
        (isSaved(before.state) ? `` : ` This also created the lead, which did not exist before.`) +
        `\n\nIt cannot be removed on its own — see the tool description.`,
    });
  },
});

const convertLead = defineTool({
  name: "reai_convert_lead",
  title: "Convert a lead into a customer",
  description:
    "Create a customer from a lead, carrying the register's name and address across, and mark the " +
    "lead converted.\n\n" +
    "The endpoint is `POST /api/leads/{id}/convert` and it exists ONLY by id — measured, the org " +
    "variant answers 404 'No static resource'. An unsaved company has no id, so this tool saves it " +
    "first when needed and then converts, which is the whole reason to prefer it over reai_request.\n\n" +
    "Converting twice is safe: measured, a second call returned 200 and did NOT create a second " +
    "customer. This tool does not even make that call — it reads the lead first and reports the " +
    "existing customer instead.\n\n" +
    "What conversion does not do is set anything in stone. The lead keeps its own state and its " +
    "status can still be moved back to active or disqualified afterwards, which leaves a lead " +
    "reading `active` while `convertedCustomerId` still points at a real customer.\n\n" +
    "To undo a conversion, delete THE LEAD FIRST and the customer second. The other order does not " +
    "work: measured, deleting the customer while the converted lead still pointed at it ARCHIVED it " +
    "instead, reported as \"it had transactions\" — on a customer minutes old with no ledger entry, " +
    "no order and no invoice. The lead reference is what counts as one. With the lead gone, " +
    "unarchiving and deleting the same customer removed it outright, so nothing is permanently " +
    "stuck; the wrong order just leaves an archived counterparty to clean up.",
  risk: "reversible",
  apiPaths: [
    ["POST", "/api/leads"],
    ["POST", "/api/leads/{id}/convert"],
  ],
  inputSchema: { orgNumber: orgNumberArg, tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const before = await readLeadState(ctx, tenantId, args.orgNumber);
    const name = before.record.companyName ?? args.orgNumber;

    if (before.state.convertedCustomerId) {
      return ok(before.record, {
        note:
          `${name} was already converted to customer ${before.state.convertedCustomerId}` +
          (before.state.convertedAt ? ` on ${before.state.convertedAt}` : ``) +
          `. Nothing was called: a repeat conversion returns the same customer rather than making a ` +
          `second one, so there is nothing to gain and a duplicate to risk if that ever changes.`,
      });
    }

    let leadId = before.state.id;
    const created = !isSaved(before.state);
    if (created) {
      await ctx.client.request({
        method: "POST",
        path: "/api/leads",
        tenantId,
        body: { orgNumber: args.orgNumber },
      });
      leadId = (await readLeadState(ctx, tenantId, args.orgNumber)).state.id;
      if (leadId === null || leadId === undefined) {
        return fail(
          `${name} could not be saved as a lead, so there is no id to convert. It still reads ` +
            `lead.id null after POST /api/leads. Nothing was converted.`,
        );
      }
    }

    const res = await ctx.client.request<Record<string, unknown>>({
      method: "POST",
      path: `/api/leads/${leadId}/convert`,
      tenantId,
    });
    // The convert response is the COMPANY record, not the customer, so the new customer id is only
    // available by reading the lead back. Reporting it matters: it is the handle for undoing this.
    const after = await readLeadState(ctx, tenantId, args.orgNumber);
    const customerId = after.state.convertedCustomerId;
    const result = ok(
      { customerId: customerId ?? null, lead: after.state, convertResponse: res.data ?? null },
      {
        link: customerId ? ctx.client.deepLink(`/customers/${customerId}`, tenantId) : undefined,
        note:
          (customerId
            ? `${name} is now customer ${customerId}, and lead ${leadId} reads status ` +
              `${JSON.stringify(after.state.status ?? null)}.`
            : `The convert call returned ${res.status}, but the lead carries no convertedCustomerId, ` +
              `so it is NOT established that a customer was created. Check reai_list_customers ` +
              `before converting again.`) +
          (created ? ` The lead did not exist before this call and was saved first.` : ``),
      },
    );
    if (customerId === null || customerId === undefined) result.isError = true;
    return result;
  },
});

const deleteLead = defineTool({
  name: "reai_delete_lead",
  title: "Delete a lead",
  description:
    "Discard this tenant's CRM state on a company: status, notes, contact details, follow-up date " +
    "and every contact event logged against it.\n\n" +
    "The company itself is not affected — it belongs to the register, not to this tenant. Measured, " +
    "after this the same company still comes back from reai_search_leads with lead.id null, exactly " +
    "as it read before anything was ever written to it. So this is not deleting a company, it is " +
    "forgetting one.\n\n" +
    "None of the discarded content is recoverable. Notes are free text with no other copy, and " +
    "contact events have no delete of their own, which makes this the only way to remove one and " +
    "an all-or-nothing way at that.\n\n" +
    "A customer created by reai_convert_lead SURVIVES this. Deleting the lead does not delete the " +
    "customer; it only forgets where it came from — and that is the right order to undo a " +
    "conversion in. Deleting the customer while the lead still points at it archives the customer " +
    "rather than deleting it, because the lead reference counts as a transaction.",
  risk: "reversible",
  destructive: true,
  apiPaths: [["DELETE", "/api/leads/org/{orgNumber}"]],
  inputSchema: { orgNumber: orgNumberArg, tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const before = await readLeadState(ctx, tenantId, args.orgNumber);
    const name = before.record.companyName ?? args.orgNumber;
    if (!isSaved(before.state)) {
      return ok(before.record, {
        note:
          `${name} has no lead state on this tenant — lead.id is already null. Nothing was ` +
          `deleted, and there was nothing to delete.`,
      });
    }
    const had = before.state;
    await ctx.client.request({
      method: "DELETE",
      path: `/api/leads/org/${encodeURIComponent(args.orgNumber)}`,
      tenantId,
    });
    const after = await readLeadState(ctx, tenantId, args.orgNumber);
    const result = ok(after.record, {
      note: isSaved(after.state)
        ? `The DELETE returned success but ${name} still reads lead id ${after.state.id}. The lead ` +
          `was NOT removed.`
        : `Lead ${had.id} for ${name} is gone, along with its notes and contact events. The ` +
          `company is still in the register and will keep appearing in reai_search_leads with ` +
          `lead.id null.` +
          (had.convertedCustomerId
            ? `\n\nCustomer ${had.convertedCustomerId}, created when this lead was converted, still ` +
              `exists. Deleting the lead did not touch it.`
            : ``),
    });
    if (isSaved(after.state)) result.isError = true;
    return result;
  },
});

export const leadTools: ToolDef[] = [
  searchLeads,
  getLead,
  saveLead,
  updateLead,
  logLeadContact,
  convertLead,
  deleteLead,
];
