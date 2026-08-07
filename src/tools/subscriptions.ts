import { z } from "zod";
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
    itemName: z.string().min(1).describe("What is being billed."),
    quantity: z.number().describe("Quantity per period."),
    unitPrice: z.number().describe("Price per unit, excluding VAT."),
    discount: z.number().optional().describe("Discount percentage, 0–100."),
    comment: z.string().optional().describe("Line comment, visible to the customer."),
    vatCode: vatCodeArg,
    variantId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Product variant to bill, from the product's variants. Sets price and VAT."),
  })
  .describe("One recurring line.");

/** The fields the API requires on every write, shared by create and update. */
const writeFields = {
  customerId: z.number().int().positive().describe("Who is billed, from reai_list_customers."),
  startDate: isoDate.describe("First period start, yyyy-MM-dd."),
  intervalMonths: z
    .number()
    .int()
    .positive()
    .describe("Months between billings — 1 monthly, 3 quarterly, 12 annually."),
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
  daysUntilDue: z.number().int().optional().describe("Payment terms in days."),
  invoiceComment: z.string().optional().describe("Comment on the produced document."),
  internalComment: z.string().optional().describe("Internal note, not shown to the customer."),
  invoiceEmail: z
    .string()
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
    const armed = rows.filter((r) => r.active === true && r.automaticBillingGeneration === true);
    const invoicing = armed.filter((r) => r.outputMode === "create_invoice");
    const due = rows.filter((r) => r.due === true);
    const suffix =
      "." +
      (armed.length > 0
        ? ` ${armed.length} bill(s) automatically, of which ${invoicing.length} issue a numbered ` +
          `invoice rather than a draft order — those go out without a further call.`
        : " None bill automatically; each one waits for reai_generate_subscription_billing.") +
      (due.length > 0 ? ` ${due.length} due now.` : "");
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
    const res = await ctx.client.request<Record<string, unknown>>({
      method: "GET",
      path: `/api/subscriptions/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const s = res.data ?? {};
    const note =
      s.active === true && s.automaticBillingGeneration === true
        ? `ACTIVE and billing automatically every ${s.intervalMonths} month(s); next ` +
          `${String(s.nextBillingDate)}. It produces ${s.outputMode === "create_invoice" ? "a numbered INVOICE" : "a draft order"}` +
          `${s.sendEhf === true ? " and sends it over EHF/Peppol" : ""}, with no further call.`
        : s.active === true
          ? `Active but not automatic: it bills only when reai_generate_subscription_billing is called.`
          : `Not active — it produces nothing until activated.`;
    return ok(res.data, { note, link: ctx.client.deepLink(`/subscriptions/${args.id}`, args.tenantId) });
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
        `${res.data?.active === true ? " — ACTIVE" : ", inactive until activated"}. ` +
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
    const res = await ctx.client.request({
      method: "POST",
      path: `/api/subscriptions/${args.id}/activate`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data, {
      note: `Subscription ${args.id} is active. reai_deactivate_subscription stops it again.`,
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
    "Produce this subscription's next billing immediately — a draft order or a numbered " +
    "invoice, depending on its outputMode.\n\n" +
    "Nothing here checks whether the period was already billed, and neither does the API: call " +
    "reai_subscription_billing_history first, or you can bill the same period twice. Requires " +
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
    return ok(res.data, {
      note:
        `Billed subscription ${args.id}. Check reai_subscription_billing_history for what it ` +
        `produced — the response does not always name it.`,
    });
  },
});

const deleteSubscription = defineTool({
  name: "reai_delete_subscription",
  title: "Delete a subscription",
  description:
    "Remove a subscription. Documents it has already produced are unaffected — an invoice it " +
    "issued stays issued. Prefer reai_deactivate_subscription when the arrangement ended but " +
    "its history matters, which for an accounting record it usually does.",
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
    const outcome = res.data?.outcome;
    return ok(res.data ?? { outcome }, {
      note:
        outcome === "archived"
          ? `Subscription ${args.id} was ARCHIVED rather than deleted, because something ` +
            `references it. It is hidden from the active list but still exists.`
          : `Subscription ${args.id} removed. Anything it already produced is untouched.`,
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
