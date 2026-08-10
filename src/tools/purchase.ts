import { z } from "zod";
import { assertTransmitAllowed } from "../policy.js";
import {
  CURRENCY_CODE,
  COUNTRY_CODE,
  asArray,
  asScalar,
  defineTool,
  describeShape,
  isRecord,
  fail,
  isoDate,
  ok,
  okList,
  confirmAgainstResponse,
  describeConfirmation,
  requireTenantId,
  startOfYear,
  tenantIdArg,
  today,
  type ToolDef,
  isWholeOre,
  requiredName,
  mergeForReplacement,
  readableRecord,
  PHONE_RULE,
  SKIP_REGISTRY_LOOKUP_RULE,
} from "./registry.js";

/**
 * Floor for open-item queries. Mirrors the customer-side constant: the ledger only
 * returns parties with activity in the window, so an unpaid invoice from an earlier
 * year is simply absent unless the window reaches back.
 */
const OPEN_ITEM_FLOOR = "2000-01-01";

/**
 * The purchase side: suppliers, supplier invoices, the document inbox, expenses.
 *
 * Two things shape this domain and are not obvious from the endpoint names.
 *
 * First, **cost lines use explicit debit and credit accounts**, not the signed
 * single-amount convention that vouchers use. A supplier invoice line names the
 * cost account it debits, and `amount` is positive for an invoice and negative
 * for a credit note.
 *
 * Second, a supplier invoice usually does not start life as an API payload — it
 * arrives as a PDF or an EHF document in the *reception* inbox, and is then
 * registered from there. That path preserves the original document as the
 * attachment, which is what bokføringsloven actually requires, so it is the one
 * worth reaching for.
 */

// --- Suppliers -------------------------------------------------------------

const listSuppliers = defineTool({
  name: "reai_list_suppliers",
  title: "List suppliers",
  description:
    "List or search suppliers (leverandører). Archived suppliers are excluded unless asked for.",
  risk: "read",
  apiPaths: [["GET", "/api/suppliers"]],
  inputSchema: {
    name: z.string().optional().describe("Filter by name (partial match)."),
    archived: z
      .boolean()
      .optional()
      .describe(
        "true returns archived suppliers ONLY, false active ones only — the spec says so outright, " +
          "and it is confirmed against live data. So this replaces the default set rather than " +
          "adding to it: there is no single call that returns both.",
      ),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...query } = args;
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/suppliers",
      query,
      tenantId: requireTenantId(tenantId, ctx),
    });
    return okList(res.data, { noun: "supplier", suffix: "." });
  },
});

const getSupplier = defineTool({
  name: "reai_get_supplier",
  title: "Get one supplier",
  description: "Fetch a single supplier by id, including bank details and address.",
  risk: "read",
  apiPaths: [["GET", "/api/suppliers/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Supplier id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const res = await ctx.client.request({
      method: "GET",
      path: `/api/suppliers/${args.id}`,
      tenantId,
    });
    return ok(res.data, { link: ctx.client.deepLink(`/suppliers/${args.id}`, tenantId) });
  },
});

const createSupplier = defineTool({
  name: "reai_create_supplier",
  title: "Create a supplier",
  description:
    "Create a supplier. As with customers, a Norwegian company is looked up in " +
    "Brønnøysundregistrene from its organizationNumber, so that plus a name is usually enough. " +
    "Set privateContact=true for a private individual.\n\n" +
    "Bank details are not accepted here — set them afterwards with reai_update_supplier.\n\n" +
    "ReAI normalizes stored names to title case, so what comes back is not byte-equal with what " +
    "you sent (\"acme as\" returns as \"Acme As\"). Do not treat that as a failed write.",
  risk: "reversible",
  apiPaths: [["POST", "/api/suppliers"]],
  inputSchema: {
    name: requiredName(75)
      .describe(
        "Supplier or company name, at most 75 characters. Required, and whitespace alone will " +
          "not do — the API answers \"name is required\" for both, with or without an " +
          "organizationNumber. Verified against the live API, which contradicts the schema.",
      ),
    organizationNumber: z
      .string()
      .max(36, "The API caps organizationNumber at 36 characters.")
      .optional()
      .describe("Norwegian organisation number."),
    privateContact: z.boolean().optional().describe("True for a private individual."),
    email: z.string().optional().describe("Email address."),
    countryCode: COUNTRY_CODE.optional().describe('ISO country code. Defaults to "NO".'),
    addressPart1: z.string().optional().describe("Street address."),
    addressPart2: z.string().optional().describe("Second address line."),
    postalCode: z.string().optional().describe("Postal code."),
    city: z.string().optional().describe("City."),
    province: z.string().optional().describe("Province or region."),
    skipRegistryLookup: z
      .boolean()
      .optional()
      .describe(SKIP_REGISTRY_LOOKUP_RULE),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...body } = args;
    const resolved = requireTenantId(tenantId, ctx);
    const res = await ctx.client.request<{ id?: number; name?: string }>({
      method: "POST",
      path: "/api/suppliers",
      body,
      tenantId: resolved,
    });
    const id = res.data?.id;
    return ok(res.data, {
      note: `Supplier created${res.data?.name ? `: ${res.data.name}` : ""}.`,
      ...(id ? { link: ctx.client.deepLink(`/suppliers/${id}`, resolved) } : {}),
    });
  },
});

const updateSupplier = defineTool({
  name: "reai_update_supplier",
  title: "Update a supplier",
  description:
    "Update supplier details. Editing name, address or contact data is ordinary master-data work.\n\nCHANGING THE BANK DETAILS (bankAccountNumber, iban, swiftCode) is different in kind: the record is reversible, but the payment is not. Whoever pays this supplier next — quite possibly a person clicking through the ReAI UI, long after this call — sends money to whatever account is on file. So those fields require REAI_WRITE_MODE=full, and they are worth confirming with the user against something outside the conversation before changing. " +
    "Only the fields you pass are changed.",
  risk: "reversible",
  apiPaths: [["PATCH", "/api/suppliers/{id}"]],
  idempotent: true,
  inputSchema: {
    id: z.number().int().positive().describe("Supplier id."),
    // The API's pattern is .*\S.* — a blank name is rejected, so refuse it here with the
    // reason rather than sending an update that cannot succeed.
    name: z
      .string()
      .max(75)
      .refine((v) => v.trim().length > 0, { message: "A name cannot be blank; the API rejects it." })
      .optional()
      .describe("New name. At most 75 characters, and not blank."),
    email: z.string().optional().describe("Email address."),
    phone: z
      .string()
      .optional()
      // Was: 'a "+47" prefix on a Norwegian number is rejected'. Measured false on
      // PATCH /api/suppliers/{id} — 200, stored as sent. Same rule as every other phone field.
      .describe(`Phone number. ${PHONE_RULE}`),
    iban: z.string().optional().describe("IBAN, for foreign payments."),
    bankAccountNumber: z.string().optional().describe("Norwegian bank account number."),
    swiftCode: z.string().optional().describe("SWIFT/BIC code."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, ...body } = args;
    if (Object.keys(body).length === 0) {
      return fail("Nothing to update — pass at least one field to change.");
    }
    const resolved = requireTenantId(tenantId, ctx);
    const res = await ctx.client.request({
      method: "PATCH",
      path: `/api/suppliers/${id}`,
      body,
      tenantId: resolved,
    });
    return ok(res.data, { link: ctx.client.deepLink(`/suppliers/${id}`, resolved) });
  },
});

const deleteSupplier = defineTool({
  name: "reai_delete_supplier",
  title: "Delete or archive a supplier",
  description:
    "Delete a supplier. ReAI archives instead of deleting when the supplier already has " +
    "transactions, so the audit trail survives, and answers " +
    '{"outcome":"deleted"} or {"outcome":"archived"} to say which — this tool reads it. Measured: a ' +
    "supplier with no transactions came back \"deleted\", and an unarchive on it then answered 404, " +
    "because there was nothing archived to restore.\n\n" +
    "An ARCHIVED supplier is recoverable with reai_unarchive_supplier.",
  risk: "reversible",
  apiPaths: [["DELETE", "/api/suppliers/{id}"]],
  destructive: true,
  inputSchema: {
    id: z.number().int().positive().describe("Supplier id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "DELETE",
      path: `/api/suppliers/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const outcome = (res.data as { outcome?: string } | undefined)?.outcome;
    return ok(res.data ?? { supplierId: args.id }, {
      note:
        outcome === "deleted"
          ? `Supplier ${args.id} was DELETED outright — the record is gone, and there is nothing to ` +
            `unarchive (that call would answer 404).`
          : outcome === "archived"
            ? `Supplier ${args.id} was ARCHIVED, not deleted: it had transactions, so the audit ` +
              `trail is kept. It is hidden from reai_list_suppliers unless you pass archived: true, ` +
              `and reai_unarchive_supplier brings it back.`
            : `Supplier ${args.id}: DELETE answered HTTP ${res.status} with no recognised outcome ` +
              `(${JSON.stringify(outcome)}). This endpoint deletes OR archives and says which, so ` +
              `which one happened is unknown — read it back with reai_list_suppliers archived: true.`,
    });
  },
});

const supplierLedger = defineTool({
  name: "reai_supplier_ledger",
  title: "Supplier ledger (leverandørreskontro)",
  description:
    "Read the supplier ledger: what the company owes each supplier, with the postings behind it. " +
    "isUnpaid answers 'what do we still owe', showDisputed surfaces invoices flagged as disputed. " +
    "Omit supplierId for all suppliers. Defaults to the current calendar year.",
  risk: "read",
  apiPaths: [["GET", "/api/ledger/supplier"], ["GET", "/api/ledger/supplier/{supplierId}"]],
  inputSchema: {
    supplierId: z.number().int().positive().optional().describe("Restrict to one supplier."),
    startDate: isoDate.optional().describe("Inclusive start date. Defaults to 1 January of the current year."),
    endDate: isoDate.optional().describe("Inclusive end date. Defaults to today."),
    isOpenPosting: z.boolean().optional().describe("Only unsettled (open) postings."),
    isUnpaid: z.boolean().optional().describe("Only unpaid invoices."),
    showDisputed: z.boolean().optional().describe("Include invoices marked as disputed."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    // Widened for open-item questions, exactly as the customer ledger already is.
    // The endpoint returns only suppliers "with activity in the period", so a
    // current-year default silently hides an invoice that went unpaid in an earlier
    // year — and "what do we still owe" is precisely the question people ask of this
    // tool. Understating accounts payable is the failure mode, and it looks like a
    // clean answer. Both open-item flags need it, not just one.
    const openItems = args.isUnpaid === true || args.isOpenPosting === true;
    const startDate = args.startDate ?? (openItems ? OPEN_ITEM_FLOOR : startOfYear());
    const endDate = args.endDate ?? today();
    const path = args.supplierId ? `/api/ledger/supplier/${args.supplierId}` : "/api/ledger/supplier";
    const res = await ctx.client.request({
      method: "GET",
      path,
      query: {
        startDate,
        endDate,
        isOpenPosting: args.isOpenPosting,
        isUnpaid: args.isUnpaid,
        showDisputed: args.showDisputed,
      },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data, {
      note:
        `Supplier ledger ${startDate} to ${endDate}` +
        (openItems && args.startDate === undefined
          ? " (open items only — the window was widened back to 2000, because this endpoint returns " +
            "only suppliers with activity in the period and an older unpaid invoice would otherwise " +
            "be invisible)."
          : "."),
    });
  },
});

// --- Supplier invoices -----------------------------------------------------

/**
 * Cost lines do NOT follow the voucher sign convention. Each line names its
 * debit and credit account explicitly, and `amount` is positive on an invoice,
 * negative on a credit note.
 */
const costLine = z.object({
  amount: z
    .number()
    .describe(
      "Line amount, VAT-INCLUSIVE (gross) — send what the supplier billed, not the net figure.\n" +
        "Verified against live books: 1000 with a 25% debitVatCode booked 800 to the cost account, " +
        "200 to input VAT and -1000 to the payable. Sending the net 800 instead books 640 cost and " +
        "160 VAT, understating the cost by 20% — and the voucher still balances, so nothing catches " +
        "it.\n" +
        "At least 0.01 on an invoice, at most -0.01 on a credit note. Unlike voucher postings, the " +
        "sign here indicates document type, not debit versus credit.",
    ),
  debitAccount: z
    .string()
    .optional()
    .describe("Account to debit — the cost account. From reai_list_accounts."),
  creditAccount: z
    .string()
    .optional()
    .describe("Account to credit. Usually left to ReAI, which uses the supplier's payable account."),
  description: z.string().optional().describe("Line description."),
  debitVatCode: z.string().optional().describe("VAT code on the debit side, from reai_list_vat_codes."),
  creditVatCode: z.string().optional().describe("VAT code on the credit side."),
  projectId: z.number().int().optional().describe("Link the line to a project."),
  departmentId: z.number().int().optional().describe("Link the line to a department."),
  assetId: z
    .number()
    .int()
    .optional()
    .describe("Asset id, required when the chosen account uses the asset sub-ledger."),
  rowNumber: z.number().int().optional().describe("Explicit row ordering."),
});

const listSupplierInvoices = defineTool({
  name: "reai_list_supplier_invoices",
  title: "List supplier invoices",
  description:
    "List registered supplier invoices (leverandørfakturaer) and credit notes. " +
    "For what is still unpaid, reai_supplier_ledger with isUnpaid=true is the better question.\n\n" +
    "IMPORTANT: this returns only NON-REVERSED invoices — the spec says so outright. So absence " +
    "from this list is NOT evidence that an invoice was never registered, and \"did we already " +
    "book supplier invoice 10009?\" cannot be answered from it alone: a reversed one is invisible " +
    "here, and re-registering it posts to the ledger a second time. Check the supplier ledger, or " +
    "fetch the invoice by id, before concluding something is missing.",
  risk: "read",
  apiPaths: [["GET", "/api/supplier-invoices"]],
  inputSchema: {
    documentType: z
      .enum(["invoice", "credit_note"])
      .optional()
      .describe("Filter to invoices or credit notes."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/supplier-invoices",
      query: { documentType: args.documentType },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return okList(res.data, { noun: "supplier invoice", suffix: "." });
  },
});

const getSupplierInvoice = defineTool({
  name: "reai_get_supplier_invoice",
  title: "Get one supplier invoice",
  description:
    "Fetch a registered supplier invoice by id, with its cost lines, payments and settlement " +
    "state. It does NOT include attachments — the response has no attachment field. For the " +
    "original document use reai_request GET /api/supplier-invoices/{id}/attachments, or find it in " +
    "the reception inbox via reai_list_reception_documents.",
  risk: "read",
  apiPaths: [["GET", "/api/supplier-invoices/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Supplier invoice id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const res = await ctx.client.request({
      method: "GET",
      path: `/api/supplier-invoices/${args.id}`,
      tenantId,
    });
    return ok(res.data, { link: ctx.client.deepLink(`/supplier-invoices/${args.id}`, tenantId) });
  },
});

const createSupplierInvoice = defineTool({
  name: "reai_create_supplier_invoice",
  title: "Register a supplier invoice",
  description:
    "Register a supplier invoice directly from its details. This posts the cost and the payable to " +
    "the ledger, so it is not freely reversible — DELETE on a supplier invoice *reverses* it rather " +
    "than removing it.\n\n" +
    "Prefer registering from the reception inbox instead when the document exists as a file: see " +
    "reai_list_reception_documents. That route keeps the original PDF or EHF attached to the " +
    "posting, which is what the bookkeeping rules on documentation actually require. Use this tool " +
    "when there is no document to attach. Requires REAI_WRITE_MODE=full.",
  risk: "irreversible",
  apiPaths: [["POST", "/api/supplier-invoices"]],
  inputSchema: {
    supplierId: z.number().int().positive().describe("Supplier being invoiced by. From reai_list_suppliers."),
    date: isoDate.describe("Invoice date. Determines the accounting period."),
    dueDate: isoDate.describe("Payment due date."),
    costLines: z.array(costLine).min(1).describe("At least one cost line."),
    number: z.string().optional().describe("The supplier's own invoice number."),
    documentType: z
      .enum(["invoice", "credit_note"])
      .optional()
      .describe('Defaults to "invoice". A credit note needs negative cost-line amounts.'),
    currency: CURRENCY_CODE.optional().describe('ISO 4217 code. Defaults to the tenant currency.'),
    kidNumber: z.string().optional().describe("Norwegian KID payment reference."),
    paymentReference: z.string().optional().describe("Free-text payment reference."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...body } = args;
    const resolved = requireTenantId(tenantId, ctx);

    // The sign convention is easy to get backwards, and the API's own message is
    // less specific than this check can be.
    // Zero is rejected as well as the wrong sign: the spec asks for at least 0.01
    // on an invoice and at most -0.01 on a credit note, but declares no `minimum`,
    // so a zero-amount line may well be accepted and posted.
    //
    // A review questioned whether this is over-tight, since a discount or an
    // øre-rounding line on a Norwegian supplier invoice is ordinarily negative. It is
    // not over-tight — the API enforces it PER LINE, verified against a live tenant:
    //
    //   [1000, 250]   -> 201
    //   [1000, -200]  -> 400 "costLines amount must be at least 0.01 for invoice
    //                        and at most -0.01 for credit_note"
    //   [1000, -0.4]  -> 400 (same)
    //
    // So the check mirrors the API and, unlike the API, says so before posting
    // anything. What it cannot do is leave the caller stuck, which is why the message
    // now says how to express a discount instead.
    const isCredit = args.documentType === "credit_note";
    const wrongSign = args.costLines.filter((l) =>
      isCredit ? l.amount > -0.01 : l.amount < 0.01,
    );
    if (wrongSign.length > 0) {
      return fail(
        `Cost-line amounts do not match documentType=${args.documentType ?? "invoice"}.\n` +
          `An invoice needs amounts of at least 0.01; a credit note needs at most -0.01. ` +
          `Zero is not valid either way.\n` +
          `Offending amounts: ${wrongSign.map((l) => l.amount).join(", ")}.\n\n` +
          `This is the API's own rule, not a stricter one imposed here — it rejects a ` +
          `mixed-sign document with "costLines amount must be at least 0.01 for invoice and ` +
          `at most -0.01 for credit_note". So a discount or an øre-rounding line cannot be ` +
          `sent as a negative line on an invoice. Express it either by netting it into the ` +
          `line it discounts (send 800 rather than 1000 and -200), or, if the credit arrived ` +
          `separately from the supplier, as its own document with documentType="credit_note" ` +
          `and all amounts negative.\n` +
          `Nothing was sent to ReAI.`,
      );
    }

    const res = await ctx.client.request<{ id?: number; documentType?: string }>({
      method: "POST",
      path: "/api/supplier-invoices",
      body,
      tenantId: resolved,
    });
    const id = res.data?.id;
    // WHICH KIND of document, from the response. The note named it from `args.documentType`, and the two kinds
    // are opposite signs in the ledger: calling a stored credit note an "invoice" describes a debit where the
    // books hold a credit. `SupplierInvoiceRes` carries the field, and this tool is declared irreversible —
    // its own next sentence says the document cannot be deleted outright.
    const storedType = typeof res.data?.documentType === "string" ? res.data.documentType : undefined;
    // Two defects review found in the first version of this, both in the direction of a FALSE alarm on an
    // irreversible ledger posting:
    //
    //   `documentType` is OPTIONAL and defaults to "invoice" (the request body eleven lines up already writes
    //   `args.documentType ?? "invoice"`). Comparing the stored kind against `args.documentType` therefore
    //   reported "NOT the invoice this call sent" on every call that omitted the field and got exactly what it
    //   asked for.
    //
    //   The label mapped ANYTHING that is not literally `credit_note` to "invoice", so a stored `"CREDIT_NOTE"`
    //   was named an invoice — on the one field this tool was fixed for, in a file whose premise is that this
    //   API rewrites what it stores.
    const sentType = args.documentType ?? "invoice";
    const CREDIT = new Set(["credit_note", "creditnote", "credit-note", "credit note"]);
    const label = (kind: string | undefined) =>
      kind === undefined
        ? "document"
        : CREDIT.has(kind.trim().toLowerCase().replace(/_/g, "_"))
          ? "credit note"
          : /^invoice$/i.test(kind.trim())
            ? "invoice"
            : undefined;
    const storedLabel = label(storedType);
    return ok(res.data, {
      note:
        (storedType === undefined
          ? `Supplier ${label(sentType)} registered as SENT — the response does not say which kind it stored`
          : storedLabel === undefined
            ? `Supplier document registered, and the response calls its kind ` +
              `${JSON.stringify(storedType)} — a value this tool does not recognise as either an invoice or a ` +
              `credit note, and the two are opposite signs in the ledger. Check it before relying on the sign`
            : `Supplier ${storedLabel} registered, read back from the response` +
              (storedLabel === label(sentType)
                ? ``
                : ` — NOT the ${label(sentType)} this call sent, which is the opposite sign in the ledger`)) +
        ` and posted to the ledger. Reverse it with DELETE if it was wrong — it cannot be deleted outright.`,
      ...(id ? { link: ctx.client.deepLink(`/supplier-invoices/${id}`, resolved) } : {}),
    });
  },
});

const paySupplierInvoice = defineTool({
  name: "reai_register_supplier_invoice_payment",
  title: "Pay or record payment of a supplier invoice",
  description:
    "Settle a supplier invoice. This posts against the bank account and settles the supplier " +
    "ledger, so it moves money in the books. Requires REAI_WRITE_MODE=full.\n\n" +
    "READ THIS BEFORE CALLING: `manualPayment` is required and chooses between two genuinely " +
    "different things.\n" +
    "  • manualPayment=true — RECORD a payment that has already left the bank. Books only.\n" +
    "  • manualPayment=false — the BANK-INTEGRATED flow. ReAI may return an approvalUrl that " +
    "starts a real payment approval (BankID), i.e. it can actually move money.\n" +
    "If the user said the invoice is already paid, that is manualPayment=true. Never pick false " +
    "on their behalf without saying what it does.\n\n" +
    "paidPrivately=true settles the ENTIRE invoice from a sole proprietor's private account — a " +
    "partial invoiceAmount is meaningless with it, and companyBankId and bankDebitAmount must be " +
    "omitted. Otherwise companyBankId is required.",
  risk: "irreversible",
  apiPaths: [["POST", "/api/supplier-invoices/{id}/payments"]],
  inputSchema: {
    id: z.number().int().positive().describe("Supplier invoice id."),
    paymentDate: isoDate.describe("Date the payment left the account."),
    invoiceAmount: z
      .number()
      .min(0.01)
      .max(9_999_999_999_999.99, "The API caps invoiceAmount at 9999999999999.99.")
      .refine(isWholeOre, { message: "invoiceAmount must be a whole number of øre." })
      .describe(
        "Amount of the invoice to settle. Must be positive. Ignored in effect when " +
          "paidPrivately=true, which always settles the invoice in full.",
      ),
    manualPayment: z
      .boolean()
      .describe(
        "REQUIRED, and not a formality. true = record a payment already made (books only). " +
          "false = the bank-integrated flow, which can return an approvalUrl that starts a real " +
          "BankID payment approval. Choose deliberately.",
      ),
    companyBankId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Bank account the payment came from, from reai_list_company_banks. Required unless " +
          "paidPrivately=true, in which case it must be omitted.",
      ),
    bankDebitAmount: z
      .number()
      .min(0.01)
      .max(9_999_999_999_999.99, "The API caps bankDebitAmount at 9999999999999.99.")
      .refine(isWholeOre, { message: "bankDebitAmount must be a whole number of øre." })
      .optional()
      .describe(
        "What was actually debited from the bank, when it differs from invoiceAmount (fees, " +
          "currency). Manual payments only — must not be sent for a bank-integrated payment.",
      ),
    paidPrivately: z
      .boolean()
      .optional()
      .describe(
        "A sole proprietor paid this from a private account. Settles the invoice IN FULL and " +
          "requires companyBankId and bankDebitAmount to be omitted. The response then carries a " +
          "voucherId rather than a payment id.",
      ),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, ...body } = args;
    const resolved = requireTenantId(tenantId, ctx);

    // Each of these is a documented API constraint. Checking locally turns a
    // generic 400 into an explanation, and for the paidPrivately case prevents
    // silently settling an invoice in full when a partial amount was asked for.
    if (args.paidPrivately === true) {
      const offenders = [
        args.companyBankId !== undefined ? "companyBankId" : null,
        args.bankDebitAmount !== undefined ? "bankDebitAmount" : null,
      ].filter(Boolean);
      if (offenders.length > 0) {
        return fail(
          `paidPrivately=true requires ${offenders.join(" and ")} to be omitted — the payment ` +
            `comes from a private account, not a company one. Nothing was sent to ReAI.`,
        );
      }
    } else if (args.companyBankId === undefined) {
      return fail(
        "companyBankId is required unless paidPrivately=true. List the company's accounts with " +
          "reai_list_company_banks. Nothing was sent to ReAI.",
      );
    }

    if (args.bankDebitAmount !== undefined && args.manualPayment !== true) {
      return fail(
        "bankDebitAmount applies only to manual payments. For a bank-integrated payment " +
          "(manualPayment=false) it must not be sent. Nothing was sent to ReAI.",
      );
    }

    // The bank-integrated branch can start a real transfer: the endpoint returns an
    // approvalUrl that "starts the BankID approval flow". That is money leaving for a third
    // party, so it belongs behind REAI_ALLOW_EXTERNAL_SEND and not behind the write mode
    // alone — `full` says "you may touch the ledger", not "you may move money out".
    //
    // Gated here as well as in the policy, deliberately. classifyTransmission covers the same
    // path for reai_request, and without this the escape hatch would be STRICTER than the
    // curated tool, which is backwards: the curated tool is what an agent reaches for. Done in
    // the handler rather than through curatedArgsEscalate because that helper reads the
    // arguments as an API body, and a tool argument named like a transmitting field — a report
    // tool's outputMode, say — would then arm a send that no request carries.
    if (args.manualPayment !== true) {
      assertTransmitAllowed(
        "external",
        ctx.config.allowExternalSend,
        `paying supplier invoice ${id} with manualPayment=false, the bank-integrated flow, ` +
          `which can return an approvalUrl that starts a real BankID transfer`,
      );
    }

    const res = await ctx.client.request<{
      approvalUrl?: string;
      voucherId?: number;
      paymentId?: number;
      status?: string;
    }>({
      method: "POST",
      path: `/api/supplier-invoices/${id}/payments`,
      body,
      tenantId: resolved,
    });

    // A payment awaiting approval is NOT paid -- but branching on approvalUrl alone
    // was wrong twice over. It caught only awaiting_approval among the API's several
    // non-terminal states, and it missed awaiting_approval itself whenever the URL was
    // null, which the response schema permits. The STATUS is the authority; the URL is
    // just how a human finishes the job.
    const notes: string[] = [];
    const status = res.data?.status;
    // HTTP 200 rather than 201 means "existing idempotent payment returned": this call
    // created nothing. That says nothing about whether the invoice is SETTLED -- the
    // existing payment can itself be failed, in flight, or a partial amount -- so it is
    // reported as "already existed" and the settlement question is left to the status
    // above. Claiming "already paid, do not retry" would have contradicted a preceding
    // "NOT PAID" line, and could leave a genuinely unpaid invoice looking closed.
    const replayed = res.status === 200;
    const settled = status === undefined || status === "completed";

    if (status === "awaiting_approval" || res.data?.approvalUrl) {
      notes.push(
        `NOT YET PAID. ReAI started a bank-integrated payment and is waiting for approval.` +
          (res.data?.approvalUrl
            ? ` Someone must complete it (BankID) here: ${res.data.approvalUrl}`
            : ` No approval URL was returned, so it has to be completed from within ReAI.`),
      );
    } else if (status === "failed" || status === "reversed") {
      notes.push(
        `NOT PAID — the payment ${status === "failed" ? "FAILED" : "was REVERSED"}. ReAI reports ` +
          `status "${status}", so the invoice is still outstanding. Check the company bank account ` +
          `and the amount before retrying; do not record it as settled.`,
      );
    } else if (status === "in_process" || status === "customer_action_required") {
      notes.push(
        `NOT YET SETTLED. ReAI reports status "${status}", so the payment is in flight rather than ` +
          `done` +
          `${status === "customer_action_required" ? " and is waiting on an action from you in ReAI or your bank" : ""}. ` +
          `Re-read the invoice before treating it as paid.`,
      );
    } else if (args.paidPrivately) {
      notes.push(
        `Supplier invoice ${id} settled IN FULL from a private account` +
          `${status ? ` (status "${status}")` : ""}.`,
      );
    } else {
      notes.push(
        `Payment of ${args.invoiceAmount} recorded on supplier invoice ${id}, dated ${args.paymentDate}` +
          `${status ? ` (status "${status}")` : ""}.`,
      );
    }
    if (replayed) {
      notes.push(
        `This call created NOTHING: the API returned an existing payment` +
          `${res.data?.paymentId ? ` (id ${res.data.paymentId})` : ""} rather than a new one, so a ` +
          `payment for this invoice was already registered. Do not send it again.` +
          (settled
            ? ""
            : ` Note the state above — an existing payment is not necessarily a settled invoice.`) +
          ` If the amount was a partial payment, re-read the invoice to see what remains.`,
      );
    }
    return ok(res.data, {
      note: notes.join("\n"),
      link: ctx.client.deepLink(`/supplier-invoices/${id}`, resolved),
    });
  },
});

// --- The document inbox ----------------------------------------------------

const listReceptionDocuments = defineTool({
  name: "reai_list_reception_documents",
  title: "List the document inbox",
  description:
    "List documents waiting in the reception inbox — the incoming supplier invoices and receipts " +
    "that have arrived as PDF or EHF but are not yet booked. This is the natural starting point for " +
    "'what still needs processing'.\n\n" +
    "Two separate inboxes exist: invoices (supplier invoices awaiting registration) and receipts " +
    "(purchase receipts awaiting registration plus payment confirmation).\n\n" +
    "Inspect an EHF attachment first with reai_parse_ehf_attachment to read the supplier and amounts " +
    "straight off the document. Then register it with reai_request POST " +
    "/api/invoice-reception-documents/{id}/supplier-invoice — note that registering posts to the " +
    "ledger, so it is classified irreversible and needs REAI_WRITE_MODE=full.",
  risk: "read",
  apiPaths: [["GET", "/api/invoice-reception-documents"], ["GET", "/api/receipt-reception-documents"]],
  // routes the call: selects the invoice or receipt reception endpoint
  localArgs: ["kind"],
  inputSchema: {
    kind: z
      .enum(["invoice", "receipt", "both"])
      .optional()
      .describe('Which inbox to read. Defaults to "both".'),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const kind = args.kind ?? "both";

    const wanted: Array<"invoice" | "receipt"> =
      kind === "both" ? ["invoice", "receipt"] : [kind];

    // Fetched together, and a failure on one must not discard the other: the
    // receipt inbox can 403 on a tenant without that module, and losing eight
    // real invoices to it would be a lie by omission.
    const results = await Promise.allSettled(
      wanted.map((which) =>
        ctx.client
          .request<unknown[]>({
            method: "GET",
            path:
              which === "invoice"
                ? "/api/invoice-reception-documents"
                : "/api/receipt-reception-documents",
            tenantId,
          })
          .then((res) => ({ which, res })),
      ),
    );

    const out: Record<string, unknown> = {};
    const notes: string[] = [];
    let failures = 0;
    for (const [i, settled] of results.entries()) {
      const which = wanted[i] as "invoice" | "receipt";
      const key = which === "invoice" ? "invoiceInbox" : "receiptInbox";
      if (settled.status === "fulfilled") {
        const rows = settled.value.res.data;
        out[key] = rows;
        // Two inboxes are read in parallel and reported in one sentence, so this cannot use
        // okList — but it must make the same distinction. A non-array counted as 0 would say
        // "0 invoice document(s) awaiting processing" about an inbox that returned rows.
        notes.push(
          Array.isArray(rows)
            ? `${rows.length} ${which} document(s) awaiting processing`
            : `the ${which} inbox did not return a list, so it is NOT known to be empty`,
        );
      } else {
        failures++;
        const message =
          settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        out[`${key}Error`] = message;
        notes.push(`the ${which} inbox could not be read`);
      }
    }

    // Only a total failure is an error; a partial one is reported honestly.
    if (failures === wanted.length) {
      return fail(
        `Could not read the reception inbox.\n${Object.entries(out)
          .filter(([k]) => k.endsWith("Error"))
          .map(([, v]) => v)
          .join("\n")}`,
      );
    }
    return ok(out, { note: notes.join("; ") + "." });
  },
});

const parseEhfAttachment = defineTool({
  name: "reai_parse_ehf_attachment",
  title: "Parse an EHF invoice attachment",
  description:
    "Parse an attachment as EHF (the Norwegian electronic invoice format) and return its structured " +
    "contents — supplier, invoice number, dates, lines, totals and VAT. Use this to read an incoming " +
    "electronic invoice before registering it, rather than guessing at the values.\n\n" +
    "The attachment id comes from a reception document listed by reai_list_reception_documents. " +
    "If the EHF carries embedded files (often a human-readable PDF), fetch them with reai_request " +
    "GET /api/attachments/{id}/embedded-files.",
  risk: "read",
  apiPaths: [["GET", "/api/attachments/{id}/ehf"]],
  inputSchema: {
    attachmentId: z
      .number()
      .int()
      .positive()
      .describe("Attachment id, from a reception document's attachment reference."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "GET",
      path: `/api/attachments/${args.attachmentId}/ehf`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data, {
      note: "Parsed EHF document. Register it with POST /api/invoice-reception-documents/{id}/supplier-invoice.",
    });
  },
});

/**
 * Attachments: the source document behind a record.
 *
 * Everything here was measured on tenant 2634 against supplier invoice 5830 and its attachment 19780
 * (`faktura_2026_10009.pdf`, 1,784,632 bytes), on 2026-08-10.
 *
 * ## There is no global list, and the scoped ones are the way in
 *
 * `GET /api/attachments` answers **405** — only POST exists on that collection — so an attachment cannot be
 * found by browsing. Ids come from an owner: `GET /api/orders/{id}/attachments` and
 * `GET /api/supplier-invoices/{id}/attachments`. That is the whole reason these tools exist; before them an
 * agent looking at a supplier invoice had no curated way to reach the PDF it came from.
 *
 * ## The two routes disagree on FOUR fields, not one
 *
 * The owner-scoped list leaves **`usedBy` null**. Reading the same attachment by id fills it in — 19780 came
 * back `[{"ownerType":"SUPPLIER_INVOICE","ownerId":5830}]`. So "what else references this file" is a question
 * only `reai_get_attachment` can answer, and it is worth asking before deleting anything.
 *
 * `contentUrl` and `downloadUrl` on a scoped row point at the OWNER path
 * (`/api/supplier-invoices/5830/attachments/19780/content`), not at `/api/attachments/{id}/content`. Both serve
 * the same bytes — verified byte-identical.
 *
 * And **`createdAt` disagrees by two days**: `2026-08-07T10:21:49` from the supplier-invoice route against
 * `2026-08-05T17:22:28` by id. Review found that; the first version of this comment claimed the two routes
 * differed in one field, having compared only the field it was looking for. Which of the two is "when the
 * document arrived" is NOT established — one may be the upload and the other the link — so neither tool
 * asserts a meaning for it. Voucher-embedded rows carry the same `createdAt` as the by-id read, so the drift
 * belongs to the supplier-invoice route rather than to scoped listing in general.
 *
 * ## Why neither tool returns the file
 *
 * The content endpoints return the raw document — `application/pdf`, 1.7 MB for this one. Handing that to a
 * model as text would be useless at best. These tools report the metadata and say where the bytes are; fetching
 * or reading them is the caller's job, outside this protocol.
 */
const ATTACHMENT_OWNERS = {
  order: { path: "orders", label: "order" },
  supplierInvoice: { path: "supplier-invoices", label: "supplier invoice" },
} as const;

const listAttachments = defineTool({
  name: "reai_list_attachments",
  title: "List a record's attachments",
  description:
    "List the files attached to an order or a supplier invoice — the scanned invoice, the receipt, the " +
    "EHF document.\n\n" +
    "There is no GLOBAL attachment list: measured, GET /api/attachments answers 405, because only POST " +
    "exists on that collection. This tool is one of THREE ways to reach an id, and often not the right one:\n\n" +
    "- **A voucher embeds its attachments** in its own response, so reai_list_vouchers and reai_get_voucher " +
    "already carry them. Measured on 2634: six of 58 vouchers had one, against one supplier invoice — so " +
    "vouchers held six of the seven attachments on that tenant. There is no /api/vouchers/{id}/attachments " +
    "route (404), which is why voucher is not an ownerType here.\n" +
    "- **The reception inbox** carries `attachmentId` on every row — reai_list_reception_documents. That is " +
    "the route for a document that has NOT yet become an order or a supplier invoice, which is exactly the " +
    "case this tool cannot reach: it takes those two owners and nothing else. Read off the schema rather than " +
    "measured, because both inboxes were empty on the tenant available.\n" +
    "- This tool, for a document already attached to an order or a supplier invoice.\n\n" +
    "Each row carries filename, mimeType, size and the URL its bytes live at. Two measured caveats worth " +
    "knowing before you act on the result:\n\n" +
    "- `usedBy` is NULL here even when the attachment is referenced. Read one by id with " +
    "reai_get_attachment to learn what else points at it — which is the question to ask before deleting.\n" +
    "- `contentUrl` and `downloadUrl` point at the OWNER path, not at /api/attachments/{id}/content. Both " +
    "serve the same bytes.\n" +
    "- `createdAt` DISAGREES with the by-id read — measured, by two days on the one attachment available. " +
    "Which one means \"when the document arrived\" is not established, so do not report either as that.\n\n" +
    "This does not fetch the file. Content is the raw document — measured, application/pdf at 1.7 MB for one " +
    "supplier invoice — so it is reported as a URL rather than returned.\n\n" +
    "UPLOADING a file is not possible through this server at all, so do not plan a workflow around it: " +
    "reai_request transports its body as JSON and nothing here ever builds a multipart request, which is what " +
    "both upload routes require. The upload belongs in the ReAI web UI or another client.\n\n" +
    "LINKING an attachment that already exists IS reachable, and the two owners use opposite paths for it — " +
    "measured on 2783:\n\n" +
    "- An ORDER links at POST /api/orders/{id}/attachments with JSON `{\"attachmentId\": N}`. A bad id " +
    'answers 404 "Attachment not found".\n' +
    "- A SUPPLIER INVOICE links at POST /api/supplier-invoices/{id}/attachments/existing — its plain " +
    "/attachments is the multipart upload, and answers 415 to JSON.\n\n" +
    "So the JSON body an order takes at /attachments is what a supplier invoice takes at " +
    "/attachments/existing. reai_describe_endpoint carries the rest, including that a 415 is decided BEFORE " +
    "the owner is looked up, and that an uploaded attachment has no delete route.",
  risk: "read",
  apiPaths: [
    ["GET", "/api/orders/{id}/attachments"],
    ["GET", "/api/supplier-invoices/{id}/attachments"],
  ],
  // ownerType routes the call; ownerId is the path parameter under a generic name, because this tool is
  // polymorphic over owners and no per-path derivation can name it. Neither becomes a body field.
  localArgs: ["ownerType", "ownerId"],
  inputSchema: {
    ownerType: z
      .enum(["order", "supplierInvoice"])
      .describe("Which kind of record the attachments hang off."),
    ownerId: z
      .number()
      .int()
      .positive()
      .describe(
        "The order id or supplier invoice id. Supplier invoice ids come from reai_list_supplier_invoices in " +
          "this toolset; order ids come from reai_list_orders, which is in the `sales` toolset — with " +
          "REAI_TOOLSETS=purchase alone, reach it through reai_request GET /api/orders.",
      ),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const owner = ATTACHMENT_OWNERS[args.ownerType];
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: `/api/${owner.path}/${args.ownerId}/attachments`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    // An unknown owner answers 404 naming the OWNER, not an empty list — measured, "Supplier invoice 999999 not
    // found" — so an empty result here means the record exists and has no files, which is a different answer.
    // CHECKED, not asserted. The first version stated "usedBy is null on every row here" as a fixed sentence,
    // and review drove a populated row straight through it — the claim was generalised from one route and one
    // row, and the `order` branch had never been measured at all. It is now read off what came back, and the
    // zero-row case says nothing about rows that do not exist.
    const rows = Array.isArray(res.data) ? res.data : [];
    const populated = rows.filter((row) => isRecord(row) && row.usedBy != null).length;
    return okList(res.data, {
      noun: "attachment",
      suffix:
        ` on ${owner.label} ${args.ownerId}. An empty list means the record has none: an unknown ` +
        `${owner.label} answers 404 rather than returning nothing.` +
        (rows.length === 0
          ? ``
          : populated === 0
            ? ` \`usedBy\` is null on all ${rows.length} row(s) here, which is what this route does — read an ` +
              `attachment by id with reai_get_attachment to learn what references it.`
            : ` ${populated} of ${rows.length} row(s) carry a \`usedBy\`, which this route usually leaves ` +
              `null — read by id with reai_get_attachment if you need it for the rest.`),
    });
  },
});

const getAttachment = defineTool({
  name: "reai_get_attachment",
  title: "Get one attachment, and what references it",
  description:
    "Fetch one attachment by id: filename, mimeType, size, and — unlike the owner-scoped list — the " +
    "`usedBy` array saying what references it. Measured: attachment 19780 came back " +
    '`[{"ownerType":"SUPPLIER_INVOICE","ownerId":5830}]`, while the same attachment in the scoped list had ' +
    "`usedBy: null`. Ask this before deleting a file that may be attached to more than one record.\n\n" +
    "Ids come from reai_list_attachments; there is no global attachment list to search (405 on the " +
    "collection).\n\n" +
    "Two measured limits. The bytes are not returned — content is the raw document, 1.7 MB of " +
    "application/pdf for that one — only the URL is. And the /ehf and /embedded-files routes are EHF-only: " +
    'both answer 400 "Attachment is not a valid EHF XML" on a PDF, so check mimeType before reaching for ' +
    "reai_parse_ehf_attachment.",
  risk: "read",
  apiPaths: [["GET", "/api/attachments/{id}"]],
  inputSchema: {
    // `id`, not `attachmentId`: this repo's convention for a single-record getter, enforced by
    // test/toolsets.test.mjs because two spellings make an agent guess and get "Invalid arguments for tool".
    id: z.number().int().positive().describe("Attachment id, from reai_list_attachments."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<{
      filename?: unknown;
      mimeType?: unknown;
      size?: unknown;
      usedBy?: unknown;
    }>({
      method: "GET",
      path: `/api/attachments/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const record = isRecord(res.data) ? res.data : undefined;
    const owners = asArray(record?.usedBy as unknown[] | undefined);
    const mime = asScalar(record?.mimeType);
    return ok(res.data, {
      note: [
        record === undefined
          ? `Attachment ${args.id} came back as ${describeShape(res.data)}, so nothing could be ` +
            `read from it.`
          : `${asScalar(record.filename) ?? "(no filename)"}` +
            `${mime === undefined ? "" : `, ${mime}`}` +
            `${asScalar(record.size) === undefined ? "" : `, ${asScalar(record.size)} bytes`}` +
            `, read back from the response.`,
        // FIVE outcomes, not three. Review collapsed them and found two false sentences:
        //
        //   no record at all   — this branch used to run anyway and say "usedBy came back null" when nothing
        //                        came back. An unreadable shape and a missing field call for different
        //                        sentences, which is what `isRecord`'s own comment says.
        //   ABSENT             — the field is not in the response. Rendered as `null` by `?? null`, so it read
        //                        as the API answering null when it had said nothing.
        //   null               — the API's own "not populated", which is what the scoped list always returns.
        //   not an array       — `asArray` collapses anything to `[]`, and the code then said "an empty list,
        //                        so nothing references this attachment" while the payload below showed the
        //                        reference. That is the one sentence this tool exists to be trusted on.
        //   an array           — the real answer, empty or not.
        record === undefined
          ? `Nothing could be read, so what references this file is unknown.`
          : !Object.hasOwn(record, "usedBy")
            ? `The response carries no \`usedBy\` field at all, so what references this file is NOT ` +
              `established — which is not the same as nothing referencing it.`
            : record.usedBy === null
              ? `\`usedBy\` came back null, so what references this file is NOT established — that is also ` +
                `what the owner-scoped list returns, and it is not the same as nothing referencing it.`
              : !Array.isArray(record.usedBy)
                ? `\`usedBy\` came back as ${describeShape(record.usedBy)} rather than a list, so what ` +
                  `references this file could not be read. The raw value is in the record below — do not treat ` +
                  `this as nothing referencing it.`
                : owners.length === 0
                  ? `\`usedBy\` is an empty list, so nothing references this attachment.`
                  : `Referenced by ${owners.length} record(s): ${owners
                      .map((o) =>
                        isRecord(o)
                          ? `${asScalar(o.ownerType) ?? "?"} ${asScalar(o.ownerId) ?? "?"}`
                          : JSON.stringify(o),
                      )
                      .join(", ")}. Deleting the file affects all of them.` +
                    // A VOUCHER owner cannot be reached by this tool's sibling: there is no
                    // /api/vouchers/{id}/attachments route (measured: 404 "No static resource"). The voucher
                    // read embeds its attachments instead, so that is where to send the caller.
                    (owners.some((o) => isRecord(o) && /voucher/i.test(String(asScalar(o.ownerType) ?? "")))
                      ? ` A VOUCHER owner is not reachable with reai_list_attachments — there is no ` +
                        `/api/vouchers/{id}/attachments route. Read the voucher with reai_get_voucher; it ` +
                        `embeds its attachments.`
                      : ``),
        `The bytes are not in this response. They are at /api/attachments/${args.id}/content, ` +
          `served as the raw document` +
          (mime === undefined ? `` : ` (${mime})`) +
          `; this server reports the URL rather than returning the file.`,
      ].join("\n\n"),
    });
  },
});

// --- Expenses --------------------------------------------------------------

const listExpenses = defineTool({
  name: "reai_list_expenses",
  title: "List expense claims",
  description:
    "List employee expense claims (utgiftsrapporter), including travel claims with per diems and " +
    "mileage. Filter by status, date range, employee, or whether they have been paid out.\n\n" +
    "The lifecycle is create → deliver → approve → book the voucher, and each of those steps is a " +
    "separate call. Everything past listing is treated as irreversible here because approving and " +
    "booking post to the ledger and drive a reimbursement; drive them via reai_request with " +
    "REAI_WRITE_MODE=full.",
  risk: "read",
  apiPaths: [["GET", "/api/expenses"]],
  inputSchema: {
    keyword: z.string().optional().describe("Free-text search."),
    status: z
      .enum(["open", "for_approval", "approved"])
      .optional()
      .describe("Filter by claim status."),
    paidOut: z
      .enum(["true", "false"])
      .optional()
      .describe(
        'Whether the claim has been reimbursed. The API takes this as a string, not a boolean. ' +
          'With "false" the date window is widened automatically — see startDate.',
      ),
    employeeIds: z.string().optional().describe("Comma-separated employee ids."),
    startDate: isoDate
      .optional()
      .describe(
        "Inclusive start date. The API defaults this to 1 January of the current year, so an " +
          'unreimbursed claim from last December is invisible. With paidOut="false" this tool ' +
          "reaches back to 2000 instead.",
      ),
    endDate: isoDate.optional().describe("Inclusive end date."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...query } = args;
    // The endpoint returns only claims in the window and defaults to the current year,
    // so "what have we not reimbursed" hid a December claim from last year — the same
    // shape of bug as the customer and supplier ledgers.
    const widened = args.paidOut === "false" && args.startDate === undefined;
    if (widened) query.startDate = OPEN_ITEM_FLOOR;
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/expenses",
      query,
      tenantId: requireTenantId(tenantId, ctx),
    });
    return okList(res.data, { noun: "expense claim", suffix: "." });
  },
});


const SUPPLIER_ADDRESS_PARTS = [
  "addressPart1",
  "addressPart2",
  "postalCode",
  "city",
  "province",
  "countryCode",
] as const;

const setSupplierAddress = defineTool({
  name: "reai_set_supplier_address",
  title: "Change a supplier's address",
  description:
    "Change a supplier's address. Pass only the parts you want different; the rest is kept.\n\n" +
    "The call underneath is a full REPLACEMENT whose required set is only addressPart1, city and " +
    "countryCode — so a body carrying those three is accepted and empties the rest. Measured on " +
    "the customer version of the same endpoint: postalCode and province became null and the second " +
    "address line was emptied, on a 200. This reads the supplier first and merges. Pass null to " +
    "clear one of the OPTIONAL parts — addressPart2, postalCode or province. The other three are " +
    "required by the endpoint, so there is no way to clear them and null is refused.\n\n" +
    "Between the read and the write an address edited in the ReAI UI is silently reverted; there " +
    "is no version field to prevent it.",
  risk: "reversible",
  apiPaths: [
    ["GET", "/api/suppliers/{id}"],
    ["PUT", "/api/suppliers/{id}/address"],
  ],
  idempotent: true,
  inputSchema: {
    id: z.number().int().positive().describe("Supplier id, from reai_list_suppliers."),
    // These three are REQUIRED by the endpoint and non-nullable in the document, so a null is not
    // something a caller can mean: there is no way to clear a required field. They were nullable
    // by reflex, alongside the optional three below where the document does allow it.
    addressPart1: z.string().optional().describe("Street address."),
    city: z.string().optional().describe("City."),
    countryCode: COUNTRY_CODE.optional().describe('ISO country code, e.g. "NO".'),
    addressPart2: z.string().nullable().optional().describe("Second address line."),
    postalCode: z.string().nullable().optional().describe("Postal code."),
    province: z.string().nullable().optional().describe("Province or region."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, ...changes } = args;
    const resolved = requireTenantId(tenantId, ctx);
    const current = await ctx.client.request<unknown>({
      method: "GET",
      path: `/api/suppliers/${id}`,
      tenantId: resolved,
    });
    const { record, problem } = readableRecord(current.data, "address");
    if (!record) {
      return fail(
        `Could not read supplier ${id}'s current address: ${problem}. Nothing was written — this ` +
          `endpoint REPLACES the address, so the parts you did not pass would have been erased.`,
      );
    }
    const { merged, kept, missing, given } = mergeForReplacement({
      existing: record,
      changes,
      settable: SUPPLIER_ADDRESS_PARTS,
      required: ["addressPart1", "city", "countryCode"],
    });
    if (given.length === 0) {
      return fail(
        "No address parts were given, so nothing was written. An empty body here would replace " +
          "the address with an empty one.",
      );
    }
    if (missing.length > 0) {
      return fail(
        `The API requires ${missing.join(", ")} on an address, and neither your change nor the ` +
          `supplier's current address supplies ${missing.length === 1 ? "it" : "them"}. Nothing ` +
          `was written.`,
      );
    }
    const res = await ctx.client.request({
      method: "PUT",
      path: `/api/suppliers/${id}/address`,
      body: merged,
      tenantId: resolved,
    });
    // Nested, and `merged` rather than the caller's subset — see the note in reai_set_customer_address. The
    // documented response is SupplierRes with the address at `.address`, so comparing the top level marked
    // every field unanswered always.
    // See the note in reai_set_customer_address: `{ record: {} }` covers both "no address" and "address: null",
    // and the second means every part is gone.
    const written = readableRecord(res.data, "address");
    const wiped =
      !!res.data &&
      typeof res.data === "object" &&
      !Array.isArray(res.data) &&
      (res.data as Record<string, unknown>).address === null;
    const confirmation = confirmAgainstResponse(merged, wiped ? {} : written.record, { wholeRecord: true });
    const extra = describeConfirmation(confirmation, "the address");
    return ok(res.data ?? "Supplier address updated.", {
      note:
        `Changed ${given.join(", ")} on supplier ${id}'s address` +
        (kept.length
          ? `; ${kept.join(", ")} ${kept.length === 1 ? "was" : "were"} read first and sent back ` +
            `unchanged, because this endpoint replaces rather than patches.`
          : `. Nothing else was set on it beforehand.`) +
        (wiped
          ? `\n\nWARNING: the response came back with no address at all — every part is gone, not just the ` +
            `ones you changed. Read the supplier back before relying on it.`
          : ``) +
        (extra.length > 0 ? `\n\n${extra.join("\n\n")}` : ``) +
        (!wiped && written.problem !== undefined
          ? `\n\nThe response could not be read as an address (${written.problem}), so nothing above about ` +
            `what is stored is confirmed.`
          : ``),
    });
  },
});


const unarchiveSupplier = defineTool({
  name: "reai_unarchive_supplier",
  title: "Unarchive a supplier",
  description:
    "Bring an archived supplier back into use. ReAI archives rather than deletes a supplier with " +
    "transactions, and an archived one is invisible to reai_list_suppliers unless you pass " +
    "archived: true.\n\n" +
    "The same endpoint shape as reai_unarchive_customer, which was measured end to end. This one " +
    "is exercised in the write suite against the supplier that suite archives; a supplier with no " +
    "transactions is DELETED instead, and unarchiving that answers 404 — measured, so a 404 here " +
    "usually means the record was never archived in the first place.",
  risk: "reversible",
  apiPaths: [["POST", "/api/suppliers/{id}/unarchive"]],
  inputSchema: {
    id: z
      .number()
      .int()
      .positive()
      .describe("Supplier id. Find archived ones with reai_list_suppliers archived: true."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<{ archived?: boolean; name?: string }>({
      method: "POST",
      path: `/api/suppliers/${args.id}/unarchive`,
      body: {},
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    // See the customer tool: only `archived: false` is evidence of recovery.
    const archived = res.data?.archived;
    return ok(res.data ?? { supplierId: args.id }, {
      note:
        archived === false
          ? `Supplier ${args.id}${res.data?.name ? ` (${res.data.name})` : ""} is active again and ` +
            `back in reai_list_suppliers.`
          : archived === true
            ? `Supplier ${args.id} still reads archived: true after the call answered HTTP ` +
              `${res.status}. Nothing was recovered — read it back before relying on it.`
            : `Supplier ${args.id}: the call answered HTTP ${res.status} but the response carried no ` +
              `archived field (${JSON.stringify(archived)}), so whether it is active again is NOT ` +
              `established. Read it with reai_list_suppliers archived: true.`,
    });
  },
});

export const purchaseTools: ToolDef[] = [
  listSuppliers,
  getSupplier,
  createSupplier,
  unarchiveSupplier,
  updateSupplier,
  deleteSupplier,
  supplierLedger,
  listSupplierInvoices,
  getSupplierInvoice,
  createSupplierInvoice,
  paySupplierInvoice,
  listReceptionDocuments,
  parseEhfAttachment,
  listAttachments,
  getAttachment,
  listExpenses,
  setSupplierAddress,
] as ToolDef[];
