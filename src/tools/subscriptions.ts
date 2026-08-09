import { z } from "zod";
import { assertTransmitAllowed, bindsToCreateInvoice, bindsToTrue } from "../policy.js";
import {
  fail,
  mergeForReplacement,
  optionalShape,
  readableRecord,
  CURRENCY_CODE,
  COUNTRY_CODE,
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
/** Exactly what SubscriptionWriteReq accepts. The response carries ten more. */
const SUBSCRIPTION_SETTABLE = [
  "customerId",
  "startDate",
  "intervalMonths",
  "billingTiming",
  "periodAlignment",
  "outputMode",
  "automaticBillingGeneration",
  "daysUntilDue",
  "currencyCode",
  "invoiceEmail",
  "invoiceComment",
  "internalComment",
  "sendEhf",
  "agreementId",
  "projectId",
  "serviceRecipients",
  "subscriptionLines",
] as const;

/** What the API refuses to do without. Everything else the stored subscription can supply. */
const SUBSCRIPTION_REQUIRED = [
  "customerId",
  "startDate",
  "intervalMonths",
  "billingTiming",
  "outputMode",
  "automaticBillingGeneration",
  "currencyCode",
  "subscriptionLines",
] as const;

/**
 * Changes that alter what an unattended invoice SAYS or who RECEIVES it.
 *
 * Used only when the stored subscription is already armed: editing these on a machine that
 * invoices by itself reaches a third party as surely as arming it does, and the argument gate
 * cannot see it, because the arming is on the record rather than in the call.
 *
 * Deliberately not every field. A comment, a due-day or an unlinked project changes nothing
 * anybody receives, and gating those would make ordinary maintenance need the send flag.
 */
const BILLING_SUBSTANCE = [
  "customerId",
  "serviceRecipients",
  "subscriptionLines",
  "startDate",
  "intervalMonths",
  "billingTiming",
  "currencyCode",
] as const;

/**
 * What SubscriptionLineReq accepts, of the eleven a response line carries.
 *
 * vatTitle, vatRate and amounts are computed and have no place in a write — which is the trap in
 * "read it first and send back what you do not intend to change".
 */
const SUBSCRIPTION_LINE_SETTABLE = [
  "rowNumber",
  "itemName",
  "comment",
  "quantity",
  "unitPrice",
  "discount",
  "vatCode",
  "variantId",
] as const;

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
  currencyCode: CURRENCY_CODE.describe('Currency, e.g. "NOK".'),
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
      "Arms EHF/Peppol transmission of what this subscription produces. Setting it to TRUE needs " +
        "full mode and external send enabled; an EHF document cannot be recalled. Setting it to " +
        "false needs neither — turning a send off is not a send — which is how the arming is " +
        "removed. (automaticBillingGeneration's description already scopes its claim this way; " +
        "this one read as though both directions were gated.)",
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
        organizationNumber: z
          .string()
          .min(1)
          .max(36, "The API caps organizationNumber at 36 characters.")
          .describe("The recipient organisation's number."),
        name: z
          .string()
          .max(255, "The API caps a recipient name at 255 characters.")
          .optional()
          .describe("Recipient name."),
        // A bare z.string() here accepted "no" and "norway"; the spec's CountryCode is
        // ^[A-Z]{2}$. Inside an array, which is exactly where the first version of the
        // bounds sweep could not look.
        countryCode: COUNTRY_CODE.optional().describe('Two-letter country code, e.g. "NO".'),
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
  title: "Change a subscription",
  description:
    "Change one or more things about a subscription, leaving the rest alone.\n\n" +
    "The call underneath is a full REPLACEMENT, and its own advice — read it first and send back " +
    "what you do not intend to change — is harder to follow than it sounds, because the read and " +
    "the write disagree about shape. The response puts the lines under `lines` and the request " +
    "wants them under `subscriptionLines`; a response line carries eleven fields and the request " +
    "accepts eight (vatTitle, vatRate and amounts are computed); and a service recipient reads " +
    "back as `companyName` and writes as `name`. A caller echoing the response verbatim gets none " +
    "of that right.\n\n" +
    "Measured on a live subscription: a PUT that carried the eight required fields and one line " +
    "answered 200 and left invoiceEmail, invoiceComment and internalComment all null, with the " +
    "second line gone. So this tool reads the subscription, maps it, merges your changes over it " +
    "and writes the whole thing back. The mapped round-trip was verified lossless — read, map, " +
    "write, and nothing changed, discounts included.\n\n" +
    "IT DOES NOT DISARM ANYTHING. outputMode, automaticBillingGeneration and sendEhf are carried " +
    "over as they are, so a subscription that was invoicing on its own still is after an ordinary " +
    "edit. Pass those fields explicitly to change them: sendEhf: false, " +
    'automaticBillingGeneration: false and outputMode: "create_order" are the three ways to stop ' +
    "it, and none of them needs REAI_ALLOW_EXTERNAL_SEND, because turning a send OFF is not a " +
    "send.\n\n" +
    "What this reports about those three flags comes from the RESPONSE. That matters most when a disarming " +
    "does not take: sending sendEhf: false and having it discarded earns a WARNING, where silence would read " +
    "as confirmation that the machine is stopped. Whether this API ever discards such a value is NOT " +
    "established, and the reason is worth stating precisely: it is not that subscriptions are created active " +
    "— subscription-created-active measured that a new one with automaticBillingGeneration: false issues " +
    "nothing, so \"newly created\" is not what makes one dangerous. It is that measuring means creating a " +
    "subscription on a real company, and the only one on the test tenant is real. So this reports what the " +
    "response says, warns when the response disagrees with what was sent, and says so when the response does " +
    "not answer — correct under either behaviour.\n\n" +
    "What DOES need it: changing who or what an ARMED subscription bills. When the stored " +
    "subscription already arms a send, a change to customerId, serviceRecipients, " +
    "subscriptionLines, startDate, intervalMonths, billingTiming or currencyCode is refused " +
    "without REAI_ALLOW_EXTERNAL_SEND — it alters what an unattended invoice will say and who " +
    "receives it, and the write ladder cannot see that on its own, because the arming is on the " +
    "record rather than in the call. Comments, due-days and project links are not gated: they " +
    "reach nobody.\n\n" +
    "Between the read and the write an edit made in the ReAI UI is silently reverted; there is no " +
    "version field to prevent it.",
  risk: "reversible",
  apiPaths: [
    ["GET", "/api/subscriptions/{id}"],
    ["PUT", "/api/subscriptions/{id}"],
  ],
  inputSchema: {
    id: z.number().int().positive().describe("Subscription id."),
    // Every field optional: the stored subscription supplies whatever the caller does not. The
    // create tool keeps the required versions, which is where they belong.
    ...optionalShape(writeFields),
    // Omission now means "carry the stored value over", so null is the only way left to UNLINK
    // something — and optionalShape adds only `.optional()`, which left no way at all to detach a
    // subscription from its project or agreement. A capability this change removed by accident.
    //
    // These five because they are the OPTIONAL fields the document types as nullable. Twelve of
    // the seventeen are nullable there — the other seven are all REQUIRED, where the merge treats
    // null as missing and refuses, so making them nullable would buy nothing and read as
    // permission. (An earlier version of this comment said "exactly the five the document types as
    // nullable", which was simply wrong about the document.) daysUntilDue, periodAlignment,
    // sendEhf and serviceRecipients are optional and NOT nullable, so null stays rejected for
    // them; recipients are cleared with an empty array, which the merge lets win.
    agreementId: writeFields.agreementId.nullable().optional(),
    projectId: writeFields.projectId.nullable().optional(),
    invoiceEmail: writeFields.invoiceEmail.nullable().optional(),
    invoiceComment: writeFields.invoiceComment.nullable().optional(),
    internalComment: writeFields.internalComment.nullable().optional(),
    // Overridden to ALLOW an empty array, which the create tool's .min(1) rejects. Not because
    // the API accepts one — it does not — but because "empty the lines to stop the billing" is a
    // plausible wrong idea, and the handler answers it by naming reai_deactivate_subscription.
    // With .min(1) here the caller got "Invalid arguments for tool reai_update_subscription" and
    // no idea what to do instead. Same trade as reai_update_company_bank's bban: accept what the
    // API would refuse, in the one place where doing so buys a better answer.
    subscriptionLines: z
      .array(subscriptionLine)
      .optional()
      .describe(
        "What is billed each period. These REPLACE the existing lines — send them all, or leave " +
          "the field out and the stored ones are carried over.",
      ),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, ...changes } = args;
    const resolved = requireTenantId(tenantId, ctx);
    const given = Object.entries(changes).filter(([, v]) => v !== undefined);
    if (given.length === 0) {
      return fail(
        "No changes were given, so nothing was written. Rewriting a subscription with its own " +
          "current values is a pointless write to something that bills a customer.",
      );
    }

    const current = await ctx.client.request<Record<string, unknown>>({
      method: "GET",
      path: `/api/subscriptions/${id}`,
      tenantId: resolved,
    });
    const { record, problem } = readableRecord(current.data, undefined, SUBSCRIPTION_SETTABLE);
    if (!record) {
      return fail(
        `Could not read subscription ${id}: ${problem}. Nothing was written — this endpoint ` +
          `REPLACES the subscription, so the fields and lines you did not pass would have been ` +
          `erased, and its billing schedule with them.`,
      );
    }

    // The two shapes the read and the write disagree about. Done before the merge so the
    // caller's own `subscriptionLines` / `serviceRecipients`, if given, simply win.
    const storedLines = Array.isArray(record.lines)
      ? (record.lines as Array<Record<string, unknown>>).map((line) =>
          Object.fromEntries(
            SUBSCRIPTION_LINE_SETTABLE.filter((k) => line[k] !== undefined && line[k] !== null).map(
              (k) => [k, line[k]],
            ),
          ),
        )
      : undefined;
    // Four differences between the shapes, not three: `companyName` becomes `name`, and
    // `companyId` is response-only. Absent values are filtered like the lines are — every
    // SubscriptionServiceRecipientRes property is optional, so echoing an undefined through would
    // build a recipient with no organizationNumber, which the API refuses with
    // "400 serviceRecipients[0].organizationNumber". Measured.
    const storedRecipients = Array.isArray(record.serviceRecipients)
      ? (record.serviceRecipients as Array<Record<string, unknown>>).map((r) => {
          const mapped: Record<string, unknown> = {};
          const name = r.companyName ?? r.name;
          if (r.organizationNumber !== undefined && r.organizationNumber !== null) {
            mapped.organizationNumber = r.organizationNumber;
          }
          if (name !== undefined && name !== null) mapped.name = name;
          if (r.countryCode !== undefined && r.countryCode !== null) mapped.countryCode = r.countryCode;
          return mapped;
        })
      : undefined;
    // organizationNumber is required on a recipient, so one that cannot supply it cannot be
    // carried back — better to say so than to send a body the API will refuse.
    const unwritable = storedRecipients?.find((r) => r.organizationNumber === undefined);
    if (unwritable && !Object.hasOwn(changes, "serviceRecipients")) {
      return fail(
        `Subscription ${id} has a service recipient with no organizationNumber ` +
          `(${JSON.stringify(unwritable.name ?? "unnamed")}), and the API requires one on every ` +
          `recipient sent. Nothing was written, because carrying it back would be refused. Pass ` +
          `serviceRecipients explicitly to say what the list should be.`,
      );
    }

    const { merged, kept, missing, given: givenKeys } = mergeForReplacement({
      existing: {
        ...record,
        ...(storedLines ? { subscriptionLines: storedLines } : {}),
        ...(storedRecipients ? { serviceRecipients: storedRecipients } : {}),
      },
      changes,
      settable: SUBSCRIPTION_SETTABLE,
      required: SUBSCRIPTION_REQUIRED,
    });
    if (missing.length > 0) {
      return fail(
        `The API requires ${missing.join(", ")} on a subscription, and neither your change nor ` +
          `the stored one supplies ${missing.length === 1 ? "it" : "them"}. Nothing was written.`,
      );
    }

    // The API wants at least one line, and `missing` only catches undefined/null/"" — an empty
    // array would have gone through and replaced a billing subscription with one that bills for
    // nothing. Checked here rather than coerced into a count of zero further down.
    const lines = merged.subscriptionLines;
    if (!Array.isArray(lines) || lines.length === 0) {
      return fail(
        `Subscription ${id} would be left with no billing lines, and the API requires at least ` +
          `one. Nothing was written. ${
            Array.isArray(lines)
              ? "An empty subscriptionLines array is not a way to pause billing — " +
                "reai_deactivate_subscription is."
              : "The stored subscription's lines could not be read, so there was nothing to carry over."
          }`,
      );
    }
    const lineCount = lines.length;

    // The arming lives on the RECORD, and the argument gate only sees this CALL — so preserving an
    // armed state through a merge is invisible to it. reai_activate_subscription below closes
    // exactly this gap for exactly this reason, and it applies here too.
    //
    // What changed: before this tool merged, outputMode and automaticBillingGeneration were
    // REQUIRED arguments, so every update that succeeded with sending off had necessarily
    // DISARMED the subscription — preserving the arming was refused. Now preservation is the
    // default, which means an unattended invoicing machine could be repointed at a different
    // customer, given a different amount, or backdated, in the default mode with
    // REAI_ALLOW_EXTERNAL_SEND unset. The booleans are unchanged; who is billed, how much and on
    // what schedule are not, and those are what actually reach a third party.
    //
    // Scoped to the substance of the billing: editing an internal comment on an armed
    // subscription changes nothing anyone receives, and refusing that would make the tool
    // unusable for the benign edits it exists for.
    const storedArmed: string[] = [];
    if (record.automaticBillingGeneration === true) storedArmed.push("automaticBillingGeneration");
    if (record.outputMode === "create_invoice") storedArmed.push('outputMode="create_invoice"');
    if (record.sendEhf === true) storedArmed.push("sendEhf");
    const billingSubstance = givenKeys.filter((k) => (BILLING_SUBSTANCE as readonly string[]).includes(k));
    if (storedArmed.length > 0 && billingSubstance.length > 0) {
      assertTransmitAllowed(
        "external",
        ctx.config.allowExternalSend,
        `changing ${billingSubstance.join(", ")} on subscription ${id}, which carries ` +
          `${storedArmed.join(", ")} and bills on its own — this changes what an unattended ` +
          `invoice will say and who receives it`,
      );
    }

    const res = await ctx.client.request<Record<string, unknown>>({
      method: "PUT",
      path: `/api/subscriptions/${id}`,
      body: merged,
      tenantId: resolved,
    });

    const after = res.data ?? {};
    const notes = [
      `Changed ${givenKeys.join(", ")} on subscription ${id}; the other ${kept.length} field(s) ` +
        `were read first and written back unchanged, because this endpoint replaces rather than ` +
        `patches.` +
        // Verified against the response, because `lines` is the ONE field this endpoint is recorded as
        // disagreeing about: subscription-read-and-write-shapes-differ measured "a PUT carrying the eight
        // required fields and one line answered 200 … with the second line gone". Asserting the count from the
        // request on that field of all fields was the wrong half to trust.
        (() => {
          const storedLines = Array.isArray(after.lines) ? after.lines.length : undefined;
          const sent = givenKeys.includes("subscriptionLines")
            ? ` The ${lineCount} line(s) you sent are now the lines it has.`
            : ` Its ${lineCount} line(s) were carried over.`;
          if (storedLines === undefined) return `${sent} (The response did not carry the lines, so that count is what was SENT.)`;
          if (storedLines === lineCount) return `${sent} Confirmed from the response.`;
          return ` WARNING: this write sent ${lineCount} line(s) and the subscription came back with ` +
            `${storedLines}. Read it back with reai_get_subscription — a lost line is silent otherwise.`;
        })(),
    ];
    // The arming state, read from the RESPONSE.
    //
    // Three defects here, and the third is the one that matters. This was computed from `merged` — what was
    // SENT — so (1) it announced an arming the API might not have stored, (2) it said "This edit did not
    // change that" even when the caller had passed the field, and (3) worst, SILENCE MEANT DISARMED. A caller
    // who sends sendEhf: false to stop an unattended invoicing machine and has it discarded got no note at
    // all, and the absence of a warning reads as confirmation. Of the five request-sourced outcome reports a
    // review of #141 found, this was the one to fix first: the cost of being wrong is invoices reaching a
    // customer.
    //
    // NOT measured against the live API, deliberately. Subscriptions are created ACTIVE
    // (subscription-created-active), so a throwaway one on a real company could generate an invoice, and the
    // only subscription on the test tenant is a real one. So this does not claim to know whether the API
    // discards a disarming value — it reports what the response says, warns when the response disagrees with
    // the request, and says so when the response cannot answer. Correct under either behaviour.
    //
    // SubscriptionRes carries all three fields under the same names as SubscriptionWriteReq — checked, since
    // subscription-read-and-write-shapes-differ makes that the exception rather than the rule here.
    const ARMING: ReadonlyArray<readonly [string, (v: unknown) => boolean, string]> = [
      ["outputMode", bindsToCreateInvoice, 'outputMode="create_invoice"'],
      // bindsToTrue, not `=== true`: the backend coerces "true" and 1, and a flag that arms a send is the
      // last place to be strict about spelling.
      ["automaticBillingGeneration", bindsToTrue, "automaticBillingGeneration"],
      ["sendEhf", bindsToTrue, "sendEhf"],
    ];
    // A field is ANSWERED only if the response carries it AND the value is not null. Folding present-null
    // into the predicates made the non-answer the safe answer: `bindsToTrue(null)` is false, so a response of
    // `sendEhf: null` silently dropped it from "Still armed … confirmed from the response" and suppressed the
    // warning. That is this tool's own bug relocated from the request to the response.
    const answered = (field: string) => Object.hasOwn(after, field) && after[field] !== null;
    const carried = ARMING.filter(([field]) => answered(field));
    const armedNow = carried.filter(([field, isArmed]) => isArmed(after[field])).map(([, , label]) => label);
    // NOT gated on the caller having named the field. reai_update_creditor was corrected for exactly this and
    // says why: the hazard is a replacement that changes a CARRIED value, so keying the check on `given` blinds
    // it to its own reason for existing. `merged` holds what was sent whether the caller named it or not.
    const notDisarmed = carried
      .filter(([field, isArmed]) => !isArmed(merged[field]) && isArmed(after[field]))
      .map(([, , label]) => label);
    // The other direction, so the asymmetry #141 objected to is not repeated: a failed ARMING is the safe
    // failure, but silence about it is still a caller believing something happened.
    const notArmed = carried
      .filter(([field, isArmed]) => isArmed(merged[field]) && !isArmed(after[field]))
      .map(([, , label]) => label);
    // The caller ARMED it: what was SENT is armed, the response agrees, and the record did not have it.
    // Keying this on the response alone reported a contradicted disarm as the caller's own arming — the
    // warning and "armed BY THIS EDIT" fired together, saying opposite things.
    const armedByThisEdit = carried
      .filter(([field, isArmed]) => isArmed(merged[field]) && isArmed(after[field]) && !isArmed(record[field]))
      .map(([, , label]) => label);

    // The active state has to be known here, not just further down: telling the caller of an INACTIVE
    // subscription that "the unattended billing is not stopped" and to run reai_deactivate_subscription
    // contradicts the branch below, which correctly says an inactive one is not billing and names the same
    // tool it is already the result of.
    const activeState = answered("active") ? after.active : record.active;
    const knownInactive = activeState !== undefined && activeState !== null && !bindsToTrue(activeState);
    if (notDisarmed.length > 0) {
      notes.push(
        `WARNING: this write sent ${notDisarmed.join(", ")} turned OFF and the subscription came back with ` +
          `${notDisarmed.length === 1 ? "it" : "them"} STILL SET. ` +
          (knownInactive
            ? `The subscription is INACTIVE, so nothing is billing right now — but the flag is dormant rather ` +
              `than cleared, and activating it would start the machine. Read it back with ` +
              `reai_get_subscription.`
            : `The unattended billing this guards is not stopped. Read the subscription back with ` +
              `reai_get_subscription, and use reai_deactivate_subscription if the intent was to stop it ` +
              `billing at all.`),
      );
    }
    if (notArmed.length > 0) {
      notes.push(
        `This write sent ${notArmed.join(", ")} turned ON and the subscription came back WITHOUT ` +
          `${notArmed.length === 1 ? "it" : "them"}. Nothing is armed that was not armed before — the safe ` +
          `direction, but not what was asked for.`,
      );
    }
    const unanswered = ARMING.filter(([field]) => !answered(field));
    if (unanswered.length > 0) {
      notes.push(
        `The response did not answer for ${unanswered.map(([f]) => f).join(", ")}` +
          `${unanswered.some(([f]) => Object.hasOwn(after, f)) ? " (present but null)" : ""}, so the state of ` +
          `${unanswered.length === 1 ? "that flag" : "those flags"} could not be confirmed` +
          `${armedNow.length > 0 ? " — whatever the confirmed ones below say" : ""}. This write ` +
          `${unanswered
            .map(([f]) =>
              Object.hasOwn(merged, f) ? `sent ${f}=${JSON.stringify(merged[f])}` : `did not send ${f}`,
            )
            .join(", ")}. Read it back with reai_get_subscription before relying on it.`,
      );
    }
    if (armedNow.length > 0) {
      // Three branches, matching reai_create_subscription: the API not reporting `active` is its own answer
      // rather than a reason to assert billing. And read tolerantly — a strict `=== false` sitting under a
      // comment about Jackson coercion made `active: null` assert billing about a stopped subscription, which
      // main got right.
      const activeAnswer = activeState;
      notes.push(
        `Still armed: ${armedNow.join(", ")}, confirmed from the response. ` +
          (armedByThisEdit.length > 0
            ? `${armedByThisEdit.join(", ")} ${armedByThisEdit.length === 1 ? "was" : "were"} armed BY THIS ` +
              `EDIT, not carried over. `
            : notDisarmed.length > 0
              ? ``
              : `This edit did not change that — it carries over what was already set. `) +
          (activeAnswer === undefined || activeAnswer === null
            ? `The API did not report whether it is active; assume it is, and check with ` +
              `reai_get_subscription.`
            : bindsToTrue(activeAnswer)
              ? `So it goes on billing as it was.`
              : `The subscription is INACTIVE, so it is not billing; if it is activated again it will bill on ` +
                `its own. Editing it does not reactivate it — measured.`) +
          ` Pass those fields explicitly to change them.`,
      );
    }
    return ok(res.data, { note: notes.join("\n\n") });
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
  apiPaths: [
    // The pre-read this handler makes before activating. Declared for the same reason the voucher
    // tool now declares its dimension lookup: apiPaths is what coverage audits read, and an
    // undeclared pre-read is invisible to them.
    ["GET", "/api/subscriptions/{id}"],
    ["POST", "/api/subscriptions/{id}/activate"],
  ],
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
