import { z } from "zod";
import {
  defineTool,
  fail,
  isoDate,
  ok,
  okList,
  requireTenantId,
  startOfYear,
  tenantIdArg,
  today,
  type ToolDef,
  isWholeOre,
  requiredName,
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

const COUNTRY_CODE = z
  .string()
  .regex(/^[A-Z]{2}$/, 'Must be a two-letter uppercase ISO country code, e.g. "NO".');

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
    organizationNumber: z.string().optional().describe("Norwegian organisation number."),
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
      .describe("Skip the Brønnøysund lookup and use exactly the details supplied."),
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
    name: z.string().max(75).optional().describe("New name. At most 75 characters."),
    email: z.string().optional().describe("Email address."),
    phone: z
      .string()
      .optional()
      .describe('Phone number. A "+47" prefix on a Norwegian number is rejected — write it plain.'),
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
    "Delete a supplier. Archiving is reversible via reai_request POST /api/suppliers/{id}/unarchive. " +
    "ReAI archives instead of deleting when the supplier already has " +
    "transactions, so the audit trail survives — the response says which happened.",
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
    return ok(res.data ?? `Supplier ${args.id} deleted or archived (HTTP ${res.status}).`);
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
    currency: z.string().optional().describe('ISO 4217 code. Defaults to the tenant currency.'),
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

    const res = await ctx.client.request<{ id?: number }>({
      method: "POST",
      path: "/api/supplier-invoices",
      body,
      tenantId: resolved,
    });
    const id = res.data?.id;
    return ok(res.data, {
      note:
        `Supplier ${args.documentType === "credit_note" ? "credit note" : "invoice"} registered and ` +
        `posted to the ledger. Reverse it with DELETE if it was wrong — it cannot be deleted outright.`,
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

export const purchaseTools: ToolDef[] = [
  listSuppliers,
  getSupplier,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  supplierLedger,
  listSupplierInvoices,
  getSupplierInvoice,
  createSupplierInvoice,
  paySupplierInvoice,
  listReceptionDocuments,
  parseEhfAttachment,
  listExpenses,
] as ToolDef[];
