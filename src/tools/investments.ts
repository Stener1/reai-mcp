import { z } from "zod";
import { ReaiApiError } from "../reai/errors.js";
import {
  defineTool,
  fail,
  isoDate,
  mergeForReplacement,
  ok,
  okList,
  readableRecord,
  requiredName,
  requireTenantId,
  resolveTenantId,
  tenantIdArg,
  type ToolDef,
  type ToolResult,
} from "./registry.js";

/**
 * Share investments (aksjeposter) — a portfolio the company holds, and the events that move it.
 *
 * Eight operations, of which seven are curated — the Nordnet import is the exception, for reasons at the
 * bottom. All measured on the write test tenant before any of this was written, because the document is
 * unusually quiet here: it marks one field required on the create, nothing required on an event, and says
 * nothing at all about what any of it does to the ledger.
 *
 * ## An EVENT posts. The position does not.
 *
 * Creating a position posted nothing — voucher count 0 before and 0 after. An event books a voucher in
 * its own **SH** series and the response carries its `voucherId`: measured, a `DIVIDEND` of 1000 produced
 * `SH1-2026 "Utbytte …"` with postings on 1920 and 8071. So the position is a record and an event is an
 * accounting entry, which is why they are classified apart in everything below.
 *
 * There is no `DELETE` for an event. The document has `GET` and `POST` on that path and nothing else, so
 * the only undo is on the voucher — and `reai_delete_voucher` deletes OR reverses, with ReAI choosing
 * which. Measured once here, on one SH voucher: it answered `{"outcome":"reversed"}`, two offsetting
 * postings were booked, the original stayed, and the voucher then vanished from `GET /api/vouchers` while
 * still reading 200 by id. Net effect zero, trace permanent.
 *
 * That is one observation, not a rule, and the distinction matters because the classification here leans
 * on it. This repository's own `supplier-invoice-reverses` quirk records the opposite outcome on an open
 * period — "reversed" that left no vouchers and no postings at all — so read the outcome the delete
 * reports rather than assuming permanence.
 *
 * ## An opening position IS an event, and that makes the record permanent
 *
 * This is the one that cost something. `openingQuantity`, `openingCostAmount` and `openingDate` look
 * like fields on a record; they silently create a `PURCHASE` event (measured: quantity 100, with
 * `pricePerUnit` derived as 500 from 50000/100). And a position with any event cannot be deleted —
 * `400 "Aksjeposten har registrerte transaksjoner og kan ikke slettes."` — while nothing removes an
 * event. So a position created with an opening balance is permanent from birth, the create response says
 * nothing about it, and clearing the fields afterwards does not help: measured, the PUT answered 200 and
 * the event stayed.
 *
 * One share investment on the write test tenant is unremovable because this was learned in the wrong
 * order. `reai_create_share_investment` therefore refuses an opening balance unless the caller says
 * explicitly that a permanent record is intended — the only argument on this server that exists to make
 * someone stop and think, and it is here because the consequence is invisible and cannot be undone.
 *
 * ## The rest of what the document does not say
 *
 *   - `assetAccountNumber` is derived at creation — **1810** for a listed share — and is not re-derived.
 *   - An event needs `companyBankId`, and asks for it in Norwegian:
 *     `400 "Velg verdipapirkontoen transaksjonen ble gjort opp mot."` A tenant with no company bank
 *     cannot record one at all.
 *   - `PUT` also requires `instrumentType`, though `required` lists only `name`, and it REPLACES:
 *     `ticker` went from `"ZZ"` to null by omission. `quantity` and `costPrice` survived, and those two
 *     genuinely are derived — they are not in `ShareInvestmentReq` and cannot be sent at all.
 *     `assetAccountNumber` survived too, and the first version of this comment explained that the same
 *     way, which is WRONG: it is in the request schema, this server sends it, and the create tool offers
 *     it as an override. Why it survived an omitting PUT is unmeasured — preserved, or re-derived — so
 *     the honest statement is that it did, once, and not that it cannot be cleared. Either way, checking
 *     a derived field and concluding the record is intact would be a mistake:
 *     `reai_update_share_investment` reads and merges.
 *   - `withinExemptionMethod` is fritaksmetoden. Whether a holding qualifies has real tax consequences
 *     and is not something this server can determine; the flag is carried as given and the tool says so
 *     rather than guessing.
 *
 * ## Nordnet import is deliberately not curated
 *
 * `POST /api/share-investments/import/nordnet` takes a `file` and creates transactions in bulk. Every one
 * of those is an event, so it posts, and by the rule above every position it touches becomes permanent. A
 * tool that turns one call into an unknown number of irreversible postings is not something to offer an
 * agent casually.
 *
 * The first version of this paragraph added "and `reai_request` reaches it for anyone who means it",
 * which is probably false and was not checked. Nothing in this server ever constructs a `FormData`, and
 * `ReaiClient` only sends multipart when the body already IS one — a JSON-transported MCP argument never
 * is. The document declares this operation `application/json` with `file: {format: binary}`, alone among
 * the seven file-upload operations in the spec, which reads like a generator artefact rather than a real
 * JSON endpoint. So the honest statement is that this import belongs in the ReAI web UI, and that
 * whether the JSON form works is unknown — establishing it would require a call that posts.
 */

const INSTRUMENT_TYPES = ["LISTED_SHARE", "UNLISTED_SHARE", "FUND", "BOND", "OTHER"] as const;
const EVENT_TYPES = ["PURCHASE", "SALE", "DIVIDEND", "CAPITAL_REPAYMENT", "WRITE_DOWN"] as const;

/**
 * What the UPDATE merge may carry. Deliberately NOT the whole PUT body.
 *
 * `PUT /api/share-investments/{id}` also accepts openingQuantity, openingCostAmount and openingDate, and
 * those are exactly the fields that create a PURCHASE event and make a position permanent. Leaving them
 * in this list meant the only thing stopping `reai_update_share_investment` from doing what
 * `reai_create_share_investment` guards against was zod stripping an undeclared argument: verified
 * through the real server, `{ id, name, openingQuantity: 100 }` reaches the handler without the opening
 * field and the PUT body is clean — but calling the handler directly forwards it, and one `.passthrough()`
 * or one added argument would make that the live path. `mergeForReplacement`'s own comment warns about
 * this shape: "adding an argument and forgetting the list is exactly how that stops being true".
 *
 * So the update cannot express an opening balance at all, structurally. Creating an event is
 * reai_add_share_investment_event's job, where it is classified and explained.
 */
const INVESTMENT_SETTABLE = [
  "name",
  "ticker",
  "isin",
  "organizationNumber",
  "instrumentType",
  "withinExemptionMethod",
  "assetAccountNumber",
  "companyBankId",
] as const;

/** What the API requires on a PUT — `instrumentType` is required in fact and not in the document. */
const INVESTMENT_REQUIRED = ["name", "instrumentType"] as const;

type Investment = {
  id?: number;
  name?: string;
  ticker?: string | null;
  isin?: string | null;
  instrumentType?: string;
  currency?: string;
  withinExemptionMethod?: boolean;
  status?: string;
  assetAccountNumber?: string | null;
  companyBankId?: number | null;
  quantity?: number | null;
  costPrice?: number | null;
};

type InvestmentEvent = {
  id?: number;
  shareInvestmentId?: number;
  eventType?: string;
  eventDate?: string;
  quantity?: number | null;
  pricePerUnit?: number | null;
  feeAmount?: number;
  amount?: number;
  costAmount?: number | null;
  gainOrLossAmount?: number | null;
  voucherId?: number | null;
};

const describeInvestment = (i: Investment): string =>
  [
    i.name,
    i.ticker ? `(${i.ticker})` : undefined,
    i.instrumentType,
    i.quantity !== null && i.quantity !== undefined ? `${i.quantity} units` : undefined,
    i.costPrice !== null && i.costPrice !== undefined ? `cost ${i.costPrice} ${i.currency ?? ""}`.trim() : undefined,
    // Three-way. A bare ternary reported an ABSENT flag as "outside the exemption method", which is a
    // tax classification asserted from a missing field — the defect class this repository names in
    // test/writes.test.mjs ("an absent response field is reported as unknown, not as zero"), and worse
    // here because the create tool says in the same breath that it does not judge whether it applies.
    i.withinExemptionMethod === true
      ? "within the exemption method"
      : i.withinExemptionMethod === false
        ? "outside the exemption method"
        : undefined,
    i.status,
  ]
    .filter(Boolean)
    .join(" · ");

/**
 * The two upstream refusals worth translating, shared by every tool that can provoke them.
 *
 * Both are Norwegian, and one of them is the answer to a question the caller did not know they were
 * asking — the deletion refusal is really about a decision taken at creation.
 */
function translateInvestmentError(err: unknown, ctx: { id?: number }): ToolResult | undefined {
  if (!(err instanceof ReaiApiError)) return undefined;
  const detail = `${err.problem?.detail ?? ""} ${err.rawBody ?? ""} ${err.message}`;

  if (/registrerte transaksjoner og kan ikke slettes/i.test(detail)) {
    return fail(
      `Share investment ${ctx.id ?? "?"} has at least one registered event, so the API will not delete ` +
        `it — and nothing removes an event, so this refusal is final rather than an ordering problem to ` +
        `work around. Nothing was deleted.\n\n` +
        `If you did not knowingly add an event, the cause is almost certainly an opening balance: ` +
        `openingQuantity, openingCostAmount and openingDate on the create silently produce a PURCHASE ` +
        `event. Read the events with reai_list_share_investment_events to see what is on it.\n\n` +
        `A position that must disappear from the books is a question for an accountant, not an API call: ` +
        `what is left is to correct it, not to remove it.`,
    );
  }

  if (/verdipapirkontoen/i.test(detail)) {
    return fail(
      `This event needs the securities account it was settled against — companyBankId. The API asks for ` +
        `it in Norwegian ("Velg verdipapirkontoen transaksjonen ble gjort opp mot.") and the document ` +
        `marks nothing on this body as required, so there is no way to know from the schema. Nothing was ` +
        `posted.\n\n` +
        `reai_list_company_banks gives the id. A company with no bank account registered cannot record a ` +
        `share investment event at all — and that includes an OPENING BALANCE on a create, since that is ` +
        `an event too, which is why this refusal can arrive from a call that never mentioned an event.`,
    );
  }
  return undefined;
}

const listInvestments = defineTool({
  name: "reai_list_share_investments",
  title: "List share investments",
  description:
    "The company's share positions, each with its derived asset account, current `quantity` and " +
    "`costPrice`, and whether it is inside the exemption method.\n\n" +
    "`quantity` and `costPrice` are derived from the position's EVENTS rather than set directly, so they " +
    "answer what is held now. `status` is the API's own, not a field this server maintains.\n\n" +
    "This endpoint takes no parameters, so `query` filters HERE, on name, ticker, ISIN and instrument " +
    "type. A no-match answer is about this list, not about what the API would accept.",
  risk: "read",
  apiPaths: [["GET", "/api/share-investments"]],
  inputSchema: {
    query: z.string().optional().describe("Narrow by name, ticker, ISIN or instrument type."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<Investment[]>({
      method: "GET",
      path: "/api/share-investments",
      tenantId: resolveTenantId(args.tenantId, ctx),
    });
    // Not coerced to []: an envelope this server does not recognise must not read as "no positions".
    if (!Array.isArray(res.data)) return okList(res.data, { noun: "share investment" });
    const all = res.data;
    const needle = args.query?.trim().toLowerCase();
    const rows = needle
      ? all.filter((i) =>
          [i.name, i.ticker, i.isin, i.instrumentType]
            .filter((v): v is string => typeof v === "string")
            .some((v) => v.toLowerCase().includes(needle)),
        )
      : all;
    return okList(rows, {
      noun: "share investment",
      suffix: needle
        ? `, filtered locally from ${all.length} — this endpoint takes no parameters.`
        : ". quantity and costPrice are derived from each position's events.",
      empty: needle
        ? `No share investment matches ${JSON.stringify(args.query)} among the ${all.length} on this ` +
          `company. The filter ran here, not at the API.`
        : "No share investments are recorded on this company.",
    });
  },
});

const getInvestment = defineTool({
  name: "reai_get_share_investment",
  title: "Read one share investment",
  description:
    "One position, with its derived asset account, holdings and exemption-method flag.\n\n" +
    "To see what moved it, read reai_list_share_investment_events: `quantity` and `costPrice` here are " +
    "the result of those events, and the events are what carry the ledger vouchers.",
  risk: "read",
  apiPaths: [["GET", "/api/share-investments/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Share investment id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<Investment>({
      method: "GET",
      path: `/api/share-investments/${args.id}`,
      tenantId: resolveTenantId(args.tenantId, ctx),
    });
    const inv = res.data ?? {};
    const notes = [describeInvestment(inv)];
    notes.push(
      inv.assetAccountNumber
        ? `Asset account ${inv.assetAccountNumber}, derived at creation from the instrument type.`
        : `The response carries no assetAccountNumber, so this says nothing about whether the position ` +
          `has one — "none" would be a claim about state built from an absence.`,
    );
    return ok(inv, { note: notes.join("\n\n") });
  },
});

const listEvents = defineTool({
  name: "reai_list_share_investment_events",
  title: "List the events on a share investment",
  description:
    "Every event on a position — purchases, sales, dividends, capital repayments and write-downs — with " +
    "the `voucherId` each one booked.\n\n" +
    "Worth reading before trying to delete a position: any event at all makes it permanent, and an " +
    "opening balance given at creation appears here as a `PURCHASE` even though nobody asked for an " +
    "event. `costAmount` and `gainOrLossAmount` are the API's own calculations on a sale.",
  risk: "read",
  apiPaths: [["GET", "/api/share-investments/{id}/events"]],
  inputSchema: {
    id: z.number().int().positive().describe("Share investment id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<InvestmentEvent[]>({
      method: "GET",
      path: `/api/share-investments/${args.id}/events`,
      tenantId: resolveTenantId(args.tenantId, ctx),
    });
    if (!Array.isArray(res.data)) return okList(res.data, { noun: "event" });
    const rows = res.data;
    const posted = rows.filter((e) => e.voucherId !== null && e.voucherId !== undefined).length;
    const opening = rows.filter((e) => e.eventType === "PURCHASE" && (e.voucherId === null || e.voucherId === undefined));
    return okList(rows, {
      noun: "event",
      suffix:
        `. ${posted} of them report a ledger voucher` +
        (opening.length
          ? `; ${opening.length} PURCHASE event(s) carry NO voucherId, which means their posting is ` +
            `UNCONFIRMED rather than absent — the same shape reai_add_share_investment_event reports as ` +
            `unconfirmed. An opening balance given at creation is one way to get it, and not the only ` +
            `one, so read the ledger rather than concluding either. Whatever it turns out to be, an ` +
            `event exists, and that alone is why this position cannot be deleted.`
          : `. While any event exists, the position cannot be deleted.`),
      empty:
        `No events, so nothing has moved this position and it is still deletable. An opening balance ` +
        `would have created one, so this position was created without one.`,
    });
  },
});

const createInvestment = defineTool({
  name: "reai_create_share_investment",
  title: "Record a share investment",
  description:
    "Record a share position the company holds. The position itself posts NOTHING to the ledger — " +
    "measured, the voucher count did not move — which is why this is separate from adding an event.\n\n" +
    "**An opening balance makes the record permanent, and this tool will not do it by accident.** " +
    "`openingQuantity`, `openingCostAmount` and `openingDate` look like fields; they silently create a " +
    "PURCHASE event, and a position with any event can never be deleted — the API refuses with " +
    '400 "Aksjeposten har registrerte transaksjoner og kan ikke slettes." and nothing removes an event. ' +
    "Clearing the fields later does not undo it. So an opening balance requires " +
    "`acceptPermanentPosition: true`, which is the only argument on this server whose job is to make " +
    "someone stop and think. Without an opening balance the position is deletable, and you can add the " +
    "purchase as an explicit event once you are satisfied it is right.\n\n" +
    "`assetAccountNumber` is derived here and only here — 1810 for a listed share, measured — so a wrong " +
    "`instrumentType` now means hand-written account numbers forever.\n\n" +
    "`withinExemptionMethod` is fritaksmetoden. Whether a particular holding qualifies has tax " +
    "consequences this server cannot determine; the flag is stored as given, and if you are unsure the " +
    "answer is an accountant rather than a default.",
  risk: "irreversible",
  apiPaths: [["POST", "/api/share-investments"]],
  inputSchema: {
    name: requiredName(150).describe("What the holding is called. The API caps this at 150 characters."),
    instrumentType: z
      .enum(INSTRUMENT_TYPES)
      .describe("What kind of instrument. Also selects the derived asset account, permanently."),
    ticker: z.string().max(20).optional().describe("Exchange ticker, if it has one. Max 20 characters."),
    isin: z.string().max(12).optional().describe("ISIN — exactly the 12 characters an ISIN has."),
    organizationNumber: z
      .string()
      .max(9)
      .optional()
      .describe("The issuer's organisation number. Max 9 characters, which is the Norwegian length."),
    withinExemptionMethod: z
      .boolean()
      .optional()
      .describe("Fritaksmetoden. Stored as given — this server does not judge whether it applies."),
    assetAccountNumber: z.string().max(10).optional().describe("Overrides the derived asset account. Max 10 characters."),
    companyBankId: z.number().int().positive().optional().describe("The securities account it is held through."),
    openingQuantity: z
      .number()
      .positive()
      .optional()
      .describe("Units already held, greater than zero. Creates a PURCHASE event — see acceptPermanentPosition."),
    openingCostAmount: z
      .number()
      .positive()
      .optional()
      .describe("What those units cost. Creates a PURCHASE event."),
    openingDate: isoDate.optional().describe("When the opening position was acquired. Creates a PURCHASE event."),
    acceptPermanentPosition: z
      .literal(true)
      .optional()
      .describe(
        "Required to give an opening balance. It creates an event, and a position with any event can " +
          "never be deleted. Omit it and create the position empty if you may need to remove it.",
      ),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, acceptPermanentPosition, ...body } = args;
    const resolved = requireTenantId(tenantId, ctx);

    const openingFields = (["openingQuantity", "openingCostAmount", "openingDate"] as const).filter(
      (f) => body[f] !== undefined,
    );
    // Refused locally, before anything exists, because the consequence is invisible in the response and
    // cannot be undone afterwards. This is the one place on this server where a caller has to say the
    // quiet part out loud.
    if (openingFields.length > 0 && acceptPermanentPosition !== true) {
      return fail(
        `${openingFields.join(", ")} would create a PURCHASE event on this position, and a position with ` +
          `any event can NEVER be deleted — the API refuses with "Aksjeposten har registrerte ` +
          `transaksjoner og kan ikke slettes." and no endpoint removes an event. Clearing these fields ` +
          `afterwards does not undo it. Nothing was created.\n\n` +
          `Two ways forward:\n` +
          `  - Leave the opening fields out. The position is then deletable, and you can add the purchase ` +
          `with reai_add_share_investment_event once you are satisfied it is right — which is also the ` +
          `only way to give it a settlement account and a fee.\n` +
          `  - Pass acceptPermanentPosition: true if a permanent record is what you intend, for instance ` +
          `when migrating a portfolio that genuinely predates these books.`,
      );
    }

    let res;
    try {
      res = await ctx.client.request<Investment>({
        method: "POST",
        path: "/api/share-investments",
        body,
        tenantId: resolved,
      });
    } catch (err) {
      // An accepted opening balance IS an event, so this call can hit the settlement-account refusal —
      // which means the caller who did the one thing this tool made them acknowledge in writing was
      // getting the raw Norwegian back. Found in review.
      const translated = translateInvestmentError(err, {});
      if (translated) return translated;
      throw err;
    }
    const created = res.data ?? {};
    const notes = [
      `Share investment ${created.id ?? "?"} recorded: ${describeInvestment(created)}. Nothing was posted ` +
        `to the ledger — a position is a record, and only an event posts.`,
      created.assetAccountNumber
        ? `Asset account ${created.assetAccountNumber}, derived from instrumentType ` +
          `${created.instrumentType ?? "the type given"}. Check it now rather than after the first event.`
        : `The response carries no assetAccountNumber, so which account this posts to is UNCONFIRMED — ` +
          `read it back with reai_get_share_investment rather than assuming it has none.`,
    ];
    if (openingFields.length > 0) {
      notes.push(
        `This position carries an opening balance, so it now has a PURCHASE event and CANNOT be deleted. ` +
          `That was accepted deliberately. reai_list_share_investment_events shows it.`,
      );
    } else {
      notes.push(
        `No opening balance, so this position has no events yet and is still deletable. It stops being ` +
          `deletable the moment the first event is added.`,
      );
    }
    if (created.withinExemptionMethod === true) {
      notes.push(
        `Stored as within the exemption method (fritaksmetoden), because that is what was asked for. ` +
          `Whether it qualifies is a tax question this server did not evaluate.`,
      );
    }
    return ok(created, { note: notes.join("\n\n") });
  },
});

const updateInvestment = defineTool({
  name: "reai_update_share_investment",
  title: "Change a share investment",
  description:
    "Change a position's descriptive fields. This endpoint REPLACES rather than patches, so the tool " +
    "reads the record first and merges.\n\n" +
    "Measured: a body carrying only `name` is refused with " +
    '400 "Validation failed" naming `instrumentType`, which the document does NOT list as required; and ' +
    "a body carrying name and instrumentType set `ticker` to null by omission.\n\n" +
    "`quantity` and `costPrice` survived and always will: they are derived from the events and are not in " +
    "the request schema at all. `assetAccountNumber` also survived, and that is an OBSERVATION rather " +
    "than a rule — it IS settable, this tool sends it, and whether an omitting PUT preserves or " +
    "re-derives it was not measured. So do not treat a surviving account number as proof the write was " +
    "harmless.\n\n" +
    "This cannot change what a position HOLDS. Quantity and cost come from events; add one with " +
    "reai_add_share_investment_event.",
  risk: "irreversible",
  apiPaths: [
    ["GET", "/api/share-investments/{id}"],
    ["PUT", "/api/share-investments/{id}"],
  ],
  inputSchema: {
    id: z.number().int().positive().describe("Share investment id."),
    name: requiredName(150).optional().describe("Max 150 characters."),
    instrumentType: z.enum(INSTRUMENT_TYPES).optional(),
    ticker: z.string().max(20).nullable().optional().describe("Max 20 characters; null clears it."),
    isin: z.string().max(12).nullable().optional().describe("12 characters; null clears it."),
    organizationNumber: z.string().max(9).nullable().optional().describe("Max 9 characters."),
    withinExemptionMethod: z.boolean().optional(),
    assetAccountNumber: z.string().max(10).optional().describe("Max 10 characters."),
    companyBankId: z.number().int().positive().nullable().optional(),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, ...changes } = args;
    const resolved = requireTenantId(tenantId, ctx);
    const current = await ctx.client.request<unknown>({
      method: "GET",
      path: `/api/share-investments/${id}`,
      tenantId: resolved,
    });
    const { record, problem } = readableRecord(current.data, undefined, INVESTMENT_SETTABLE);
    if (!record) {
      return fail(
        `Could not read share investment ${id}: ${problem}. Nothing was written — this endpoint REPLACES ` +
          `the record, so every descriptive field you did not pass would have been erased.`,
      );
    }
    const { merged, kept, unknown, missing, given } = mergeForReplacement({
      existing: record,
      changes,
      settable: INVESTMENT_SETTABLE,
      required: INVESTMENT_REQUIRED,
    });
    if (given.length === 0) return fail(`No changes were given, so nothing was written to share investment ${id}.`);
    if (missing.length > 0) {
      return fail(
        `The API requires ${missing.join(", ")} on a share investment — instrumentType is required in ` +
          `fact even though the document lists only name — and neither your change nor the stored record ` +
          `supplies ${missing.length === 1 ? "it" : "them"}. Nothing was written.`,
      );
    }
    let res;
    try {
      res = await ctx.client.request<Investment>({
        method: "PUT",
        path: `/api/share-investments/${id}`,
        body: merged,
        tenantId: resolved,
      });
    } catch (err) {
      const translated = translateInvestmentError(err, { id });
      if (translated) return translated;
      throw err;
    }
    const notes = [
      `Changed ${given.join(", ")} on share investment ${id}` +
        (kept.length
          ? `; ${kept.join(", ")} ${kept.length === 1 ? "was" : "were"} read first and written back ` +
            `unchanged, because this endpoint replaces rather than patches.`
          : `.`),
    ];
    if (unknown.length > 0) notes.push(`The stored record had no ${unknown.join(", ")} before this write.`);
    notes.push(
      `Nothing here changes what the position holds, and nothing posted to the ledger — quantity and ` +
        `cost come from its events.`,
    );
    return ok(res.data ?? {}, { note: notes.join("\n\n") });
  },
});

const addEvent = defineTool({
  name: "reai_add_share_investment_event",
  title: "Record a share investment event",
  description:
    "Record a purchase, sale, dividend, capital repayment or write-down on a position. **This POSTS TO " +
    "THE LEDGER.** Measured: a DIVIDEND of 1000 booked voucher SH1-2026 with postings on 1920 and 8071, " +
    "and the response carries the `voucherId`.\n\n" +
    "There is no way to delete an event. The document has GET and POST on this path and nothing else, so " +
    "the only undo is on the voucher — and that answers " +
    '{"outcome":"reversed"} rather than "deleted": two offsetting postings are booked, the original ' +
    "stays, and the voucher then disappears from reai_list_vouchers while still reading by id. The net " +
    "effect is zero and the trace is permanent.\n\n" +
    "It also makes the position permanent: from the first event, the position can no longer be deleted.\n\n" +
    "`companyBankId` is required in practice — the securities account the transaction settled against — " +
    "and the API asks for it in Norwegian while the document marks nothing required. This tool requires " +
    "it up front so the refusal does not have to be translated.\n\n" +
    "What is NOT known, and worth saying rather than implying: whether a SALE of more units than the " +
    "position holds is refused, what happens on a position whose `status` is not OPEN, and whether an " +
    "event dated into a closed period is accepted. None of that was measured, because measuring it means " +
    "posting. A PURCHASE or SALE needs a `quantity`; a DIVIDEND does not.",
  // No `destructive: true`. It would change nothing — `destructiveHintFor` already returns true for any
  // irreversible tool — and this posting POST is not the shape the flag marks elsewhere in this repo,
  // where it means "removes a record", "transmits", or "a replacing PUT that erases data".
  // reai_create_voucher, reai_book_expense_voucher and reai_book_bank_transactions all post to the ledger
  // and do not carry it. Claiming it as an extra protection, which an earlier version of this file did,
  // was decorative.
  risk: "irreversible",
  apiPaths: [["POST", "/api/share-investments/{id}/events"]],
  inputSchema: {
    id: z.number().int().positive().describe("Share investment id."),
    eventType: z.enum(EVENT_TYPES).describe("What happened."),
    eventDate: isoDate.describe("When it happened, yyyy-MM-dd. This dates the voucher."),
    amount: z
      .number()
      .min(0.01)
      .describe("The total amount of the transaction. The API requires at least 0.01."),
    companyBankId: z
      .number()
      .int()
      .positive()
      .describe("The securities account it settled against, from reai_list_company_banks. Required in practice."),
    // Positive, which the document does NOT say — it leaves quantity, pricePerUnit and feeAmount as bare
    // numbers. A negative quantity would be a permanent event nobody can delete, and a negative price or
    // fee is not a thing; refusing locally costs a caller nothing and the API gives no better message.
    // Recorded as a local decision rather than a documented bound, which is the distinction
    // test/spec-bounds.test.mjs exists to keep honest.
    quantity: z
      .number()
      .positive()
      .optional()
      .describe("Units bought or sold, greater than zero. Leave out for a dividend."),
    pricePerUnit: z.number().positive().optional().describe("Price per unit, for a purchase or sale."),
    feeAmount: z.number().min(0).optional().describe("Brokerage or fee, if any. Not negative."),
    description: z.string().optional().describe("Free text carried onto the voucher."),
    externalReference: z
      .string()
      .max(60)
      .optional()
      .describe("Your own reference, e.g. a broker transaction id. Max 60 characters."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, ...body } = args;
    const resolved = requireTenantId(tenantId, ctx);
    let res;
    try {
      res = await ctx.client.request<InvestmentEvent>({
        method: "POST",
        path: `/api/share-investments/${id}/events`,
        body,
        tenantId: resolved,
      });
    } catch (err) {
      const translated = translateInvestmentError(err, { id });
      if (translated) return translated;
      throw err;
    }
    const event = res.data ?? {};
    const notes = [
      `Event ${event.id ?? "?"} recorded on share investment ${id}: ${event.eventType ?? args.eventType} ` +
        `on ${event.eventDate ?? args.eventDate}.`,
    ];
    if (event.voucherId !== null && event.voucherId !== undefined) {
      notes.push(
        `This POSTED to the ledger as voucher ${event.voucherId}. There is no way to delete the event. ` +
          `Deleting that voucher answers "reversed" rather than "deleted", which books offsetting ` +
          `postings and leaves the original — so the net effect can be undone and the trace cannot.`,
      );
    } else {
      notes.push(
        `The response carries no voucherId, so whether this posted is UNCONFIRMED — read the ledger with ` +
          `reai_list_vouchers rather than assuming either way.`,
      );
    }
    notes.push(`Share investment ${id} can no longer be deleted, because it now has at least one event.`);
    if (event.gainOrLossAmount !== null && event.gainOrLossAmount !== undefined) {
      notes.push(
        `The API calculated a gain or loss of ${event.gainOrLossAmount}. Its tax treatment depends on the ` +
          `exemption method and is not something this server evaluated.`,
      );
    }
    return ok(event, { note: notes.join("\n\n") });
  },
});

const deleteInvestment = defineTool({
  name: "reai_delete_share_investment",
  title: "Delete a share investment",
  description:
    "Remove a position that has no events. A position with any event — including the PURCHASE that an " +
    "opening balance creates — cannot be deleted, and nothing removes an event, so the refusal is final. " +
    "This tool explains that rather than passing on the Norwegian 400.\n\n" +
    "Check with reai_list_share_investment_events first if you are unsure.",
  risk: "irreversible",
  destructive: true,
  apiPaths: [["DELETE", "/api/share-investments/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Share investment id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    try {
      const res = await ctx.client.request<unknown>({
        method: "DELETE",
        path: `/api/share-investments/${args.id}`,
        tenantId: requireTenantId(args.tenantId, ctx),
      });
      return ok(res.data ?? { deleted: args.id }, {
        note:
          `Share investment ${args.id} deleted — HTTP ${res.status}. It had no events, which is the only ` +
          `state in which the API allows this.`,
      });
    } catch (err) {
      const translated = translateInvestmentError(err, { id: args.id });
      if (translated) return translated;
      throw err;
    }
  },
});

export const investmentTools: ToolDef[] = [
  listInvestments,
  getInvestment,
  listEvents,
  createInvestment,
  updateInvestment,
  addEvent,
  deleteInvestment,
];
