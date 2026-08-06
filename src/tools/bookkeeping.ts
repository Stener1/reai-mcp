import { z } from "zod";
import {
  defineTool,
  fail,
  isoDate,
  ok,
  okText,
  requireTenantId,
  startOfYear,
  tenantIdArg,
  today,
  type ToolDef,
} from "./registry.js";

const VOUCHER_TYPES = [
  "MANUAL",
  "OPENING_BALANCE",
  "SUPPLIER_INVOICE",
  "CUSTOMER_INVOICE",
  "INCOME",
  "PAYMENT",
  "EXPENSE",
  "SALARY",
] as const;

const listAccounts = defineTool({
  name: "reai_list_accounts",
  title: "List chart of accounts",
  description:
    "Search the tenant's chart of accounts (kontoplan). Returns account numbers, names and types. " +
    "Use this to find the right account number before booking a voucher — every posting must " +
    "reference an account that exists in this list.",
  risk: "read",
  apiPaths: [["GET", "/api/chart-of-accounts/accounts"]],
  inputSchema: {
    query: z
      .string()
      .optional()
      .describe('Free-text search over account number and name, e.g. "bank", "salgsinntekt", "1920".'),
    accountNumberPrefix: z
      .string()
      .optional()
      .describe('Restrict to a leading digit range, e.g. "19" for bank accounts or "3" for revenue.'),
    limit: z.number().int().min(1).max(500).optional().describe("Maximum accounts to return."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/chart-of-accounts/accounts",
      query: {
        query: args.query,
        accountNumberPrefix: args.accountNumberPrefix,
        limit: args.limit,
      },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const count = Array.isArray(res.data) ? res.data.length : undefined;
    return ok(res.data, {
      ...(count !== undefined ? { note: `${count} account(s).` } : {}),
    });
  },
});

const listVatCodes = defineTool({
  name: "reai_list_vat_codes",
  title: "List VAT codes",
  description:
    "List the VAT (mva) codes available in this tenant, with rate, type and description. " +
    "Postings to revenue and cost accounts generally require a VAT code; look it up here rather " +
    "than guessing, because the valid set depends on the tenant's VAT registration.",
  risk: "read",
  apiPaths: [["GET", "/api/vat-codes"]],
  inputSchema: {
    usage: z
      .enum(["customer-invoice"])
      .optional()
      .describe("Filter to codes valid in a specific context, e.g. codes usable on a customer invoice."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "GET",
      path: "/api/vat-codes",
      query: { usage: args.usage },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data);
  },
});

const listVouchers = defineTool({
  name: "reai_list_vouchers",
  title: "List vouchers",
  description:
    "List vouchers (bilag) in a date range, each with its postings. A voucher is the atomic unit of " +
    "Norwegian bookkeeping: a dated, balanced set of debit and credit postings. " +
    "Defaults to the current calendar year if no dates are given.",
  risk: "read",
  apiPaths: [["GET", "/api/vouchers"]],
  inputSchema: {
    startDate: isoDate.optional().describe("Inclusive start date. Defaults to 1 January of the current year."),
    endDate: isoDate.optional().describe("Inclusive end date. Defaults to today."),
    voucherType: z.enum(VOUCHER_TYPES).optional().describe("Filter by how the voucher was created."),
    registeredBy: z.string().optional().describe("Filter by the user who registered the voucher."),
    includeReversed: z.boolean().optional().describe("Include reversed vouchers (excluded by default)."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const startDate = args.startDate ?? startOfYear();
    const endDate = args.endDate ?? today();
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/vouchers",
      query: {
        startDate,
        endDate,
        voucherType: args.voucherType,
        registeredBy: args.registeredBy,
        includeReversed: args.includeReversed,
      },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const count = Array.isArray(res.data) ? res.data.length : 0;
    return ok(res.data, { note: `${count} voucher(s) between ${startDate} and ${endDate}.` });
  },
});

const getVoucher = defineTool({
  name: "reai_get_voucher",
  title: "Get one voucher",
  description: "Fetch a single voucher by id, including all its postings and attachments.",
  risk: "read",
  apiPaths: [["GET", "/api/vouchers/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Voucher id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const res = await ctx.client.request({
      method: "GET",
      path: `/api/vouchers/${args.id}`,
      tenantId,
    });
    return ok(res.data, { link: ctx.client.deepLink(`/vouchers/${args.id}`, tenantId) });
  },
});

const postingInput = z.object({
  accountNumber: z
    .string()
    .describe('Chart-of-accounts number, e.g. "1920". Must exist — check with reai_list_accounts.'),
  amount: z
    .number()
    .describe(
      "Signed amount in the tenant's currency. POSITIVE debits the account, NEGATIVE credits it. " +
        "All amounts across the voucher must sum to exactly zero.",
    ),
  postingDate: isoDate.optional().describe("Date for this posting. Defaults to the voucher date."),
  description: z.string().optional().describe("Line description. Falls back to the voucher description."),
  currency: z.string().length(3).optional().describe('ISO 4217 code. Defaults to "NOK".'),
  currencyAmount: z
    .number()
    .optional()
    .describe("Signed amount in the foreign currency, when currency differs from the tenant's."),
  vatCode: z
    .string()
    .optional()
    .describe("VAT code from reai_list_vat_codes. Required on most revenue and cost accounts."),
  rowNumber: z
    .number()
    .int()
    .optional()
    .describe("Groups postings into voucher rows; a matching debit and credit share a row number."),
  supplierId: z.number().int().optional().describe("Link the posting to a supplier."),
  customerId: z.number().int().optional().describe("Link the posting to a customer."),
  projectId: z.number().int().optional().describe("Link the posting to a project."),
  departmentId: z.number().int().optional().describe("Link the posting to a department."),
  employeeId: z.number().int().optional().describe("Link the posting to an employee."),
  companyBankId: z.number().int().optional().describe("Link the posting to a company bank account."),
  assetId: z.number().int().optional().describe("Link the posting to an asset."),
  subAccountId: z.number().int().optional().describe("Optional general sub-account id."),
});

/**
 * Rounded to 2 decimals before comparison: floating-point sums of currency
 * amounts routinely land a fraction of an øre away from zero, and the API would
 * reject that as unbalanced without explaining why.
 */
function imbalance(postings: Array<{ amount: number }>): number {
  const sum = postings.reduce((acc, p) => acc + p.amount, 0);
  return Math.round(sum * 100) / 100;
}

const createVoucher = defineTool({
  name: "reai_create_voucher",
  title: "Book a voucher",
  description:
    "Create (book) a voucher in the general ledger from a set of postings.\n\n" +
    "Sign convention: a POSITIVE amount debits the account, a NEGATIVE amount credits it, and the " +
    "postings must sum to exactly zero. The sum is checked locally before the request is sent, so " +
    "an unbalanced voucher fails with a clear explanation instead of a generic API error.\n\n" +
    "This posts to the general ledger and is NOT freely reversible — under Norwegian bookkeeping " +
    "rules a voucher in a closed period cannot be deleted. Requires REAI_WRITE_MODE=full.",
  risk: "irreversible",
  apiPaths: [["POST", "/api/vouchers"]],
  inputSchema: {
    date: isoDate.describe("Voucher date. Determines the accounting period."),
    description: z
      .string()
      .optional()
      .describe("Voucher description. Strongly recommended — it is what a human sees in the audit trail."),
    postings: z
      .array(postingInput)
      .min(2)
      .describe("At least two postings, summing to exactly zero."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);

    const diff = imbalance(args.postings);
    if (diff !== 0) {
      const lines = args.postings
        .map((p) => `  ${p.accountNumber}: ${p.amount > 0 ? "debit" : "credit"} ${Math.abs(p.amount)}`)
        .join("\n");
      return fail(
        `Voucher is not balanced — the postings sum to ${diff}, but must sum to exactly 0.\n\n${lines}\n\n` +
          `Remember: positive amounts debit, negative amounts credit. ` +
          `Add or correct a posting of ${-diff} to balance it. Nothing was sent to ReAI.`,
      );
    }

    const body = {
      date: args.date,
      ...(args.description !== undefined ? { description: args.description } : {}),
      postings: args.postings.map((p) => ({
        ...p,
        postingDate: p.postingDate ?? args.date,
        currency: p.currency ?? "NOK",
      })),
    };

    const res = await ctx.client.request<{ id?: number; number?: string }>({
      method: "POST",
      path: "/api/vouchers",
      body,
      tenantId,
    });

    const id = res.data?.id;
    return ok(res.data, {
      note:
        `Voucher booked${res.data?.number ? ` as ${res.data.number}` : ""}. ` +
        `Total debits and credits: ${args.postings.filter((p) => p.amount > 0).reduce((a, p) => a + p.amount, 0)}.`,
      ...(id ? { link: ctx.client.deepLink(`/vouchers/${id}`, tenantId) } : {}),
    });
  },
});

const deleteVoucher = defineTool({
  name: "reai_delete_voucher",
  title: "Delete a voucher",
  description:
    "Delete a voucher and its postings. Only possible while the accounting period is still open and " +
    "no posting is locked — otherwise ReAI rejects it, and the correct remedy is a reversing voucher " +
    "instead. Requires REAI_WRITE_MODE=full.",
  risk: "irreversible",
  apiPaths: [["DELETE", "/api/vouchers/{id}"]],
  destructive: true,
  inputSchema: {
    id: z.number().int().positive().describe("Voucher id to delete."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "DELETE",
      path: `/api/vouchers/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return okText(`Voucher ${args.id} deleted (HTTP ${res.status}).`);
  },
});

const listPostings = defineTool({
  name: "reai_list_postings",
  title: "List postings",
  description:
    "List individual ledger postings in a date range, with optional filters by account, voucher, " +
    "customer, supplier, project, employee or bank. Each posting reports `canDelete` and " +
    "`lockReasons`, which tell you whether it can still be changed. " +
    "Defaults to the current calendar year.",
  risk: "read",
  apiPaths: [["GET", "/api/postings"]],
  inputSchema: {
    startDate: isoDate.optional().describe("Inclusive start date. Defaults to 1 January of the current year."),
    endDate: isoDate.optional().describe("Inclusive end date. Defaults to today."),
    accountNumber: z.string().optional().describe("Filter by chart-of-accounts number."),
    voucherId: z.number().int().optional().describe("Filter to one voucher's postings."),
    customerId: z.number().int().optional().describe("Filter by customer."),
    supplierId: z.number().int().optional().describe("Filter by supplier."),
    projectId: z.number().int().optional().describe("Filter by project."),
    employeeId: z.number().int().optional().describe("Filter by employee."),
    companyBankId: z.number().int().optional().describe("Filter by company bank account."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const startDate = args.startDate ?? startOfYear();
    const endDate = args.endDate ?? today();
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/postings",
      query: {
        startDate,
        endDate,
        accountNumber: args.accountNumber,
        voucherId: args.voucherId,
        customerId: args.customerId,
        supplierId: args.supplierId,
        projectId: args.projectId,
        employeeId: args.employeeId,
        companyBankId: args.companyBankId,
      },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const count = Array.isArray(res.data) ? res.data.length : 0;
    return ok(res.data, { note: `${count} posting(s) between ${startDate} and ${endDate}.` });
  },
});

const generalLedger = defineTool({
  name: "reai_general_ledger",
  title: "General ledger (hovedbok)",
  description:
    "Read the general ledger for a period: every account with its opening balance, postings and " +
    "closing balance. This is the report to use for questions like 'what did we spend on X' or " +
    "'what is the balance of account 1920'. Narrow with accountNumber or an account range, since " +
    "a full-year ledger for an active tenant can be large.",
  risk: "read",
  apiPaths: [["GET", "/api/ledger/general"]],
  inputSchema: {
    startDate: isoDate.optional().describe("Inclusive start date. Defaults to 1 January of the current year."),
    endDate: isoDate.optional().describe("Inclusive end date. Defaults to today."),
    accountNumber: z.string().optional().describe("Restrict to a single account."),
    accountFrom: z.string().optional().describe("Start of an account-number range."),
    accountTo: z.string().optional().describe("End of an account-number range."),
    vatCode: z.string().optional().describe("Filter by VAT code."),
    voucherNumber: z.string().optional().describe("Filter by voucher number."),
    customerId: z.number().int().optional().describe("Filter by customer."),
    supplierId: z.number().int().optional().describe("Filter by supplier."),
    projectId: z.number().int().optional().describe("Filter by project."),
    amountFrom: z.number().optional().describe("Minimum posting amount."),
    amountTo: z.number().optional().describe("Maximum posting amount."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const startDate = args.startDate ?? startOfYear();
    const endDate = args.endDate ?? today();
    const { tenantId, ...filters } = args;
    const res = await ctx.client.request({
      method: "GET",
      path: "/api/ledger/general",
      query: { ...filters, startDate, endDate },
      tenantId: requireTenantId(tenantId, ctx),
    });
    return ok(res.data, { note: `General ledger ${startDate} to ${endDate}.` });
  },
});

export const bookkeepingTools: ToolDef[] = [
  listAccounts,
  listVatCodes,
  listVouchers,
  getVoucher,
  createVoucher,
  deleteVoucher,
  listPostings,
  generalLedger,
] as ToolDef[];
