import { z } from "zod";
import { assertTransmitAllowed } from "../policy.js";
import {
  defineTool,
  isoDate,
  ok,
  okList,
  requireTenantId,
  tenantIdArg,
  type ToolDef,
} from "./registry.js";

/**
 * Recurring billing (abonnement).
 *
 * This is the domain where the difference between the two safety switches is sharpest, so
 * it is worth stating once here rather than in every description.
 *
 * A subscription is a standing instruction. Three of its fields decide whether that
 * instruction reaches a counterparty on its own:
 *
 *   outputMode: "create_invoice"   issues a numbered invoice rather than a draft order
 *   automaticBillingGeneration     lets ReAI bill on schedule with no further API call
 *   sendEhf                        arms Peppol transmission of what it produces
 *
 * Together they are a machine that invoices real customers while nobody is looking. The
 * policy treats a body carrying any of them as irreversible AND as an external send, so
 * such a call needs REAI_WRITE_MODE=full *and* REAI_ALLOW_EXTERNAL_SEND — `full` alone
 * does not lift the second. A subscription that produces a draft order and bills nothing
 * automatically is ordinary reversible master data, and stays usable in the default mode.
 *
 * `POST /api/subscriptions/generate-due` is deliberately NOT curated. It bills every due
 * subscription in one call, which is the operation an agent would reach for to "catch up
 * billing" and the one where a mistake is widest. It remains available through
 * reai_request, where the refusal names what it is.
 */

const vatCodeArg = z
  .string()
  .optional()
  .describe("VAT code for the line, from reai_list_vat_codes.");

const subscriptionLine = z
  .object({
    // Optional in the spec, and deliberately optional here: a line that names a variantId
    // takes its name from the product, so requiring itemName would have blocked the ordinary
    // way to bill a catalogue item. The refinement below insists on one of the two.
    itemName: z
      .string()
      .min(1)
      .max(255, "The API caps itemName at 255 characters.")
      .optional()
      .describe("What is being billed. Omit only when variantId supplies it."),
    // Bounds taken from SubscriptionLineReq, so a call that cannot succeed is refused here
    // with the reason rather than at the API with a bare 400.
    quantity: z
      .number()
      .min(1, "The API requires quantity to be at least 1.")
      .max(100000, "The API caps quantity at 100000.")
      .describe("Quantity per period, 1–100000."),
    unitPrice: z
      .number()
      .min(-10_000_000, "The API caps unitPrice at ±10,000,000.")
      .max(10_000_000, "The API caps unitPrice at ±10,000,000.")
      .describe("Price per unit excluding VAT, within ±10,000,000."),
    discount: z
      .number()
      .int("The API requires a WHOLE-number discount percentage: 50, not 50.5.")
      .min(0)
      .max(100)
      .optional()
      .describe("Discount percentage, a whole number from 0 to 100."),
    comment: z.string().optional().describe("Line comment, visible to the customer."),
    vatCode: vatCodeArg,
    variantId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Product variant to bill, from the product's variants. Sets price and VAT."),
  })
  .refine((line) => line.itemName !== undefined || line.variantId !== undefined, {
    message: "A line needs either an itemName or a variantId — otherwise it bills something unnamed.",
  })
  .describe("One recurring line.");

/** The fields the API requires on every write, shared by create and update. */
const writeFields = {
  customerId: z.number().int().positive().describe("Who is billed, from reai_list_customers."),
  startDate: isoDate.describe("First period start, yyyy-MM-dd."),
  intervalMonths: z
    .number()
    .int()
    .min(1)
    // The API caps this at 12, so annual is the longest interval a subscription can have —
    // a biennial arrangement is not expressible and would have failed with a bare 400.
    .max(12, "The API caps intervalMonths at 12, so annual is the longest interval.")
    .describe("Months between billings, 1–12 — 1 monthly, 3 quarterly, 12 annually."),
  billingTiming: z
    .enum(["in_advance", "after_period"])
    .describe("Bill at the start of the period or after it has run."),
  currencyCode: z.string().describe("Currency, e.g. NOK."),
  outputMode: z
    .enum(["create_order", "create_invoice"])
    .describe(
      "'create_order' produces a draft order somebody reviews before it goes out. " +
        "'create_invoice' ISSUES A NUMBERED INVOICE — it needs REAI_WRITE_MODE=full and " +
        "REAI_ALLOW_EXTERNAL_SEND, because the document reaches the customer without another call.",
    ),
  automaticBillingGeneration: z
    .boolean()
    .describe(
      "false means billing happens only when you call reai_generate_subscription_billing. " +
        "TRUE hands the schedule to ReAI: it bills on its own, repeatedly, with no further " +
        "call — needs full mode and external send enabled.",
    ),
  subscriptionLines: z.array(subscriptionLine).min(1).describe("What is billed each period."),
  periodAlignment: z
    .enum(["calendar_boundary", "start_date"])
    .optional()
    .describe("Whether periods snap to calendar boundaries or run from the start date."),
  daysUntilDue: z
    .number()
    .int()
    .min(0, "Payment terms cannot be negative.")
    .max(3000, "The API caps daysUntilDue at 3000.")
    .optional()
    .describe("Payment terms in days, 0–3000."),
  invoiceComment: z.string().optional().describe("Comment on the produced document."),
  internalComment: z.string().optional().describe("Internal note, not shown to the customer."),
  invoiceEmail: z
    .string()
    .max(100, "The API caps invoiceEmail at 100 characters.")
    .optional()
    .describe(
      "Override the delivery address for what this subscription produces. Changing where " +
        "invoices go is treated as irreversible: the disclosure happens later, when someone " +
        "issues one normally.",
    ),
  sendEhf: z
    .boolean()
    .optional()
    .describe(
      "Arms EHF/Peppol transmission of what this subscription produces. Needs full mode and " +
        "external send enabled; an EHF document cannot be recalled.",
    ),
  projectId: z.number().int().positive().optional().describe("Tag billing to a project."),
  agreementId: z.number().int().positive().optional().describe("Link to an agreement."),
  // On the write schema and returned by the read. Omitting it made it unrepresentable —
  // and since the update REPLACES the record, a caller following the advice to "read it
  // first and send back what you do not intend to change" would have had no way to send
  // this back, wiping the recipient list on every price change.
  serviceRecipients: z
    .array(
      z.object({
        organizationNumber: z.string().min(1).describe("The recipient organisation's number."),
        name: z.string().optional().describe("Recipient name."),
        countryCode: z.string().optional().describe("Two-letter country code."),
      }),
    )
    .optional()
    .describe(
      "Organisations that receive the service, when that is not the customer being billed. " +
        "Send the existing list back on an update, or it is cleared.",
    ),
} as const;

const listSubscriptions = defineTool({
  name: "reai_list_subscriptions",
  title: "List subscriptions",
  description:
    "Every recurring billing arrangement, with its customer, interval, next billing date and " +
    "whether it bills automatically. The summary calls out the ones that will produce documents " +
    "without anybody asking — that is usually the question worth answering first.",
  risk: "read",
  apiPaths: [["GET", "/api/subscriptions"]],
  inputSchema: { tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<Array<Record<string, unknown>>>({
      method: "GET",
      path: "/api/subscriptions",
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    // Counting only makes sense over a real list; okList handles the rest.
    const rows = Array.isArray(res.data) ? res.data : [];
    // Every one of these distinctions was wrong in the reassuring direction first time.
    // An INACTIVE subscription with automaticBillingGeneration set is not "waiting for a
    // generate call" — it is waiting for activation, after which it invoices on its own,
    // and activation is framed everywhere as the ordinary thing to do. A `due` flag on an
    // inactive subscription pushes toward a generate call that will do nothing. And an
    // ABSENT automaticBillingGeneration read as false gives the comfortable answer to a
    // shape change, which is the failure this repo keeps finding.
    const unknownArming = rows.filter((r) => typeof r.automaticBillingGeneration !== "boolean");
    const automatic = rows.filter((r) => r.automaticBillingGeneration === true);
    const running = automatic.filter((r) => r.active === true);
    const dormant = automatic.filter((r) => r.active !== true);
    const invoicing = running.filter((r) => r.outputMode === "create_invoice");
    const due = rows.filter((r) => r.due === true && r.active === true);
    const parts: string[] = [];
    if (running.length > 0) {
      parts.push(
        `${running.length} bill(s) automatically right now, of which ${invoicing.length} issue a ` +
          `numbered invoice rather than a draft order — those go out without a further call.`,
      );
    }
    if (dormant.length > 0) {
      parts.push(
        `${dormant.length} more would bill automatically if activated — they are stopped, not manual.`,
      );
    }
    if (running.length === 0 && dormant.length === 0 && unknownArming.length === 0) {
      parts.push("None bill automatically; each one waits for reai_generate_subscription_billing.");
    }
    if (unknownArming.length > 0) {
      parts.push(
        `${unknownArming.length} did not report automaticBillingGeneration, so whether they bill ` +
          `on their own is UNKNOWN — not assumed to be no.`,
      );
    }
    if (due.length > 0) parts.push(`${due.length} active and due now.`);
    const suffix = `. ${parts.join(" ")}`;
    return okList(res.data, {
      noun: "subscription",
      suffix,
      empty: "No subscriptions. Nothing recurring is set up on this company.",
    });
  },
});

const getSubscription = defineTool({
  name: "reai_get_subscription",
  title: "Get one subscription",
  description:
    "One subscription in full: lines, amounts, next billing period, and the three fields that " +
    "decide whether it acts on its own — outputMode, automaticBillingGeneration and sendEhf. " +
    "Read this before updating one, because the update replaces the whole record.",
  risk: "read",
  apiPaths: [["GET", "/api/subscriptions/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Subscription id, from reai_list_subscriptions."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    // Resolved once and used for BOTH the request and the link. Passing the raw argument
    // meant an omitted tenantId — the normal case once reai_use_tenant has run, or on a
    // bound connector — left deepLink falling back to the environment default, so the URL
    // could name a different company than the record it was showing.
    const tenantId = requireTenantId(args.tenantId, ctx);
    const res = await ctx.client.request<Record<string, unknown>>({
      method: "GET",
      path: `/api/subscriptions/${args.id}`,
      tenantId,
    });
    const s = res.data ?? {};
    const note =
      s.active === true && s.automaticBillingGeneration === true
        ? `ACTIVE and billing automatically` +
          `${typeof s.intervalMonths === "number" ? ` every ${s.intervalMonths} month(s)` : ""}` +
          `${s.nextBillingDate ? `; next ${String(s.nextBillingDate)}` : ""}` +
          `. It produces ${s.outputMode === "create_invoice" ? "a numbered INVOICE" : "a draft order"}` +
          `${s.sendEhf === true ? " and sends it over EHF/Peppol" : ""}, with no further call.`
        : s.active === true
          ? `Active but not automatic: it bills only when reai_generate_subscription_billing is called.`
          : `Not active — it produces nothing until activated.`;
    return ok(res.data, { note, link: ctx.client.deepLink(`/subscriptions/${args.id}`, tenantId) });
  },
});

const billingHistory = defineTool({
  name: "reai_subscription_billing_history",
  title: "Subscription billing history",
  description:
    "What a subscription has produced: one row per billing, with the period it covered and the " +
    "order or invoice it generated. This is how to check whether a run already happened before " +
    "generating another — the API does not stop you billing the same period twice.",
  risk: "read",
  apiPaths: [["GET", "/api/subscriptions/{id}/billing-history"]],
  inputSchema: {
    id: z.number().int().positive().describe("Subscription id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: `/api/subscriptions/${args.id}/billing-history`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return okList(res.data, {
      noun: "billing",
      suffix: ` on subscription ${args.id}.`,
      empty: `Subscription ${args.id} has never billed. That is not the same as it being inactive — check reai_get_subscription.`,
    });
  },
});

const createSubscription = defineTool({
  name: "reai_create_subscription",
  title: "Create a subscription",
  description:
    "Set up recurring billing for a customer.\n\n" +
    "Created ACTIVE. Measured against the live API, not assumed: a create returns " +
    "active: true, so there is no inert draft stage and reai_activate_subscription is for " +
    "restarting one that was stopped. What keeps a new subscription harmless is " +
    "automaticBillingGeneration: false — it then produces nothing until somebody calls " +
    "reai_generate_subscription_billing — and NOT the fact that it was just created.\n\n" +
    "outputMode 'create_invoice', automaticBillingGeneration true, or sendEhf true each turn " +
    "this into a machine that reaches a customer on its own, and each is refused unless the " +
    "server runs with REAI_WRITE_MODE=full AND REAI_ALLOW_EXTERNAL_SEND. A draft-order " +
    "subscription that bills on request needs neither.",
  risk: "reversible",
  apiPaths: [["POST", "/api/subscriptions"]],
  inputSchema: { ...writeFields, tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const { tenantId, ...body } = args;
    const res = await ctx.client.request<{ id?: number; active?: boolean }>({
      method: "POST",
      path: "/api/subscriptions",
      body,
      tenantId: requireTenantId(tenantId, ctx),
    });
    return ok(res.data, {
      note:
        `Created subscription ${res.data?.id ?? "?"}` +
        // Never the words "inactive until activated" as a FALLBACK. The API creates these
        // active, so guessing that on an unexpected body would assert the exact falsehood
        // the quirk records — and in the direction that makes someone relax.
        `${
          res.data?.active === true
            ? " — ACTIVE"
            : res.data?.active === false
              ? " — inactive"
              : " (the API did not report whether it is active; assume it is, and check)"
        }. ` +
        `It produces ${args.outputMode === "create_invoice" ? "numbered invoices" : "draft orders"} ` +
        `every ${args.intervalMonths} month(s) from ${args.startDate}.`,
    });
  },
});

const updateSubscription = defineTool({
  name: "reai_update_subscription",
  title: "Replace a subscription",
  description:
    "Update a subscription. This is a full REPLACEMENT, not a patch: every field the API " +
    "requires must be sent, and the lines you send become the lines it has.\n\n" +
    "So read it with reai_get_subscription first and send back what you do not intend to " +
    "change. Omitting a value does not leave it alone — and the fields most dangerous to get " +
    "wrong by omission are the three that decide whether it acts on its own.",
  risk: "reversible",
  apiPaths: [["PUT", "/api/subscriptions/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Subscription id."),
    ...writeFields,
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, ...body } = args;
    const res = await ctx.client.request({
      method: "PUT",
      path: `/api/subscriptions/${id}`,
      body,
      tenantId: requireTenantId(tenantId, ctx),
    });
    return ok(res.data, { note: `Subscription ${id} replaced with the body sent.` });
  },
});

const activateSubscription = defineTool({
  name: "reai_activate_subscription",
  title: "Activate a subscription",
  description:
    "Start a subscription running again after it was deactivated. Note that a NEW subscription " +
    "is already active — the API creates them that way — so this is for restarting a stopped " +
    "one rather than a required step after creating one.\n\n" +
    "If the subscription bills automatically, activating it is the moment the machine starts, " +
    "not a status change. Requires REAI_WRITE_MODE=full.\n\n" +
    "Check reai_get_subscription first: activating one whose outputMode is 'create_invoice' " +
    "with automaticBillingGeneration set means numbered invoices start reaching the customer.",
  risk: "irreversible",
  apiPaths: [["POST", "/api/subscriptions/{id}/activate"]],
  inputSchema: {
    id: z.number().int().positive().describe("Subscription id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    // The arming fields live on the RECORD, not in this call — activate carries no body, so
    // the argument gate has nothing to inspect and would wave through the resumption of an
    // automatic invoicing schedule with external sending switched off. That is the one
    // thing that switch exists to prevent, and reai_generate_subscription_billing, a
    // strictly smaller action, is already gated on it. Reading first is what closes the gap.
    const current = await ctx.client.request<Record<string, unknown>>({
      method: "GET",
      path: `/api/subscriptions/${args.id}`,
      tenantId,
    });
    const s = current.data ?? {};
    const armed: string[] = [];
    if (s.automaticBillingGeneration === true) armed.push("automaticBillingGeneration");
    if (s.outputMode === "create_invoice") armed.push('outputMode="create_invoice"');
    if (s.sendEhf === true) armed.push("sendEhf");
    if (armed.length > 0) {
      assertTransmitAllowed(
        "external",
        ctx.config.allowExternalSend,
        `activating subscription ${args.id}, which carries ${armed.join(", ")} and will bill on ` +
          `its own once running`,
      );
    }

    const res = await ctx.client.request({
      method: "POST",
      path: `/api/subscriptions/${args.id}/activate`,
      tenantId,
    });
    return ok(res.data, {
      note:
        `Subscription ${args.id} is active.` +
        (armed.length > 0
          ? ` It carries ${armed.join(", ")}, so it now bills on its own.`
          : ` It bills only when reai_generate_subscription_billing is called.`) +
        ` reai_deactivate_subscription stops it again.`,
    });
  },
});

const deactivateSubscription = defineTool({
  name: "reai_deactivate_subscription",
  title: "Deactivate a subscription",
  description:
    "Stop a subscription from producing anything further. This UNDOES a standing risk rather " +
    "than creating one, so it is available in the default write mode — the same reasoning that " +
    "keeps other stop-and-cancel actions ungated. It does not touch documents already produced.",
  risk: "reversible",
  apiPaths: [["POST", "/api/subscriptions/{id}/deactivate"]],
  inputSchema: {
    id: z.number().int().positive().describe("Subscription id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "POST",
      path: `/api/subscriptions/${args.id}/deactivate`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data, {
      note:
        `Subscription ${args.id} is deactivated and will produce nothing further. Anything it ` +
        `already generated is unaffected.`,
    });
  },
});

const generateBilling = defineTool({
  name: "reai_generate_subscription_billing",
  title: "Bill a subscription now",
  description:
    "Produce this subscription's DUE billing immediately — draft orders or numbered invoices, " +
    "depending on its outputMode.\n\n" +
    "Every due period at once, not one. A subscription backdated to January and generated in " +
    "August produced EIGHT orders from a single call, measured on a live tenant. Check " +
    "startDate and nextBillingDate before calling, or read reai_subscription_billing_history " +
    "afterwards to see what appeared.\n\n" +
    "Re-running is safe: the same call twice more returned generatedBillings 0 both times, so " +
    "the API bills only what is due rather than repeating a period. Requires " +
    "REAI_WRITE_MODE=full, and REAI_ALLOW_EXTERNAL_SEND because what it produces can reach the " +
    "customer.",
  risk: "irreversible",
  destructive: true,
  transmits: true,
  apiPaths: [["POST", "/api/subscriptions/{id}/generate"]],
  inputSchema: {
    id: z.number().int().positive().describe("Subscription id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "POST",
      path: `/api/subscriptions/${args.id}/generate`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    // The API answers with counts — generatedBillings, generatedOrders, generatedInvoices,
    // safetyCapHits — and the first version of this note ignored all four and said "Billed
    // subscription N" regardless. A run that generated nothing was reported as a success.
    const r = (res.data ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
    const billings = num(r.generatedBillings);
    const orders = num(r.generatedOrders);
    const invoices = num(r.generatedInvoices);
    const capped = num(r.safetyCapHits);
    const note =
      billings === undefined
        ? `Called generate on subscription ${args.id}; the API did not report how much it ` +
          `produced. Read reai_subscription_billing_history before assuming anything happened.`
        : billings === 0
          ? `Nothing was generated for subscription ${args.id} — no period is due. This is not ` +
            `a failure, and nothing reached the customer.`
          : `Generated ${billings} billing(s) for subscription ${args.id}: ` +
            `${orders ?? "?"} order(s) and ${invoices ?? "?"} invoice(s). ` +
            (invoices !== undefined && invoices > 0
              ? `The invoices are numbered documents and have left for the customer. `
              : ``) +
            `reai_subscription_billing_history lists them.`;
    return ok(res.data, {
      note: capped !== undefined && capped > 0 ? `${note} The API hit its safety cap ${capped} time(s); some periods were NOT generated.` : note,
    });
  },
});

const deleteSubscription = defineTool({
  name: "reai_delete_subscription",
  title: "Delete a subscription",
  description:
    "Remove a subscription that has never billed.\n\n" +
    "One that HAS is refused: 409 \"Kan ikke slette et abonnement som har generert " +
    "faktureringshistorikk\" — cannot delete a subscription that has generated billing " +
    "history. Verified on a live tenant, and it is not the delete-or-archive behaviour other " +
    "records have; nothing is archived, the call simply fails. Use " +
    "reai_deactivate_subscription instead, which is the right answer anyway when an " +
    "arrangement ended but its history matters — for an accounting record it usually does.",
  risk: "reversible",
  destructive: true,
  apiPaths: [["DELETE", "/api/subscriptions/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Subscription id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<{ outcome?: string }>({
      method: "DELETE",
      path: `/api/subscriptions/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data ?? { deleted: args.id }, {
      note:
        `Subscription ${args.id} removed. Anything it already produced is untouched — the ` +
        `orders and invoices stay.`,
    });
  },
});

/** Nine operations exist; generate-due is deliberately absent — see the file header. */
export const subscriptionTools: ToolDef[] = [
  listSubscriptions,
  getSubscription,
  billingHistory,
  createSubscription,
  updateSubscription,
  activateSubscription,
  deactivateSubscription,
  generateBilling,
  deleteSubscription,
];

/** Kept for the test that checks the omission is deliberate rather than forgotten. */
export const uncuratedSubscriptionPaths = ["POST /api/subscriptions/generate-due"] as const;
