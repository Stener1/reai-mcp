import { z } from "zod";
import {
  defineTool,
  fail,
  isoDate,
  ok,
  requireTenantId,
  tenantIdArg,
  type ToolDef,
} from "./registry.js";

/**
 * Bank reconciliation and VAT.
 *
 * Worth knowing before using any of this: **there is no endpoint that lists bank
 * transactions.** `GET /api/bank-transactions/{id}` fetches one by id, and that
 * is all. Transactions are seen through the reconciliation view for a bank
 * account and a month, which returns them split into pending transactions,
 * pending postings and already-matched groups. So the reconciliation workflow is
 * the entry point, not a transaction list.
 *
 * There are two reconciliation views, and which one applies depends on the
 * account. `/api/bank-reconciliations/{id}` is for bank-synced accounts (it
 * reports `lastSyncedAt` and a provider balance). An account with
 * `providerType: "manual"` has no synced transactions and is reconciled against
 * a statement balance instead, through `/api/manual-reconciliations/{id}` —
 * reachable via `reai_request`.
 *
 * The month-scoped endpoints take `month` as a `yyyy-MM` string rather than a
 * date range, and a reconciliation month can be closed and reopened.
 *
 * VAT has no read endpoint at all in the public API — only create, complete
 * manually, and reopen. Reading a period's state means looking at the ledger.
 */

/** Term index to the months it covers, for unambiguous confirmation messages. */
const VAT_TERM_MONTHS: Record<string, string> = {
  "1": "Jan–Feb",
  "2": "Mar–Apr",
  "3": "May–Jun",
  "4": "Jul–Aug",
  "5": "Sep–Oct",
  "6": "Nov–Dec",
};

/** `yyyy-MM`, which is what the month-scoped reconciliation endpoints expect. */
const month = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must be yyyy-MM, e.g. 2026-07");

// --- Company bank accounts -------------------------------------------------

const listCompanyBanks = defineTool({
  name: "reai_list_company_banks",
  title: "List company bank accounts",
  description:
    "List the company's own bank accounts, with account numbers, currency and the ledger account " +
    "each maps to. The `id` returned here is the `companyBankId` that payment and reconciliation " +
    "calls ask for, so this is usually the first call in any payment or bank workflow.",
  risk: "read",
  apiPaths: [["GET", "/api/company-banks"]],
  inputSchema: { tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/company-banks",
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const count = Array.isArray(res.data) ? res.data.length : 0;
    return ok(res.data, { note: `${count} bank account(s).` });
  },
});

const createCompanyBank = defineTool({
  name: "reai_create_company_bank",
  title: "Add a company bank account",
  description:
    "Register a bank account belonging to the company. Adding the account does not connect it to " +
    "the bank or move any money — it creates the record that postings and reconciliations refer to.",
  risk: "reversible",
  apiPaths: [["POST", "/api/company-banks"]],
  inputSchema: {
    name: z.string().describe('A label for the account, e.g. "Drift" or "Skattetrekk".'),
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/, 'Two-letter uppercase ISO country code, e.g. "NO".')
      .describe('ISO country code of the bank, e.g. "NO".'),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'Three-letter uppercase ISO 4217 code, e.g. "NOK".')
      .describe('ISO 4217 currency of the account, e.g. "NOK".'),
    bban: z
      .string()
      .min(1)
      .describe(
        "Basic bank account number — the plain account number. Technically omittable, but an " +
          "account created without one cannot be used for payments or reconciliation, so it is " +
          "required here.",
      ),
    swiftCode: z.string().optional().describe("SWIFT/BIC code, for foreign accounts."),
    excludeFromReconciliationTodos: z
      .boolean()
      .optional()
      .describe("Keep this account out of the reconciliation to-do list."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...body } = args;
    const res = await ctx.client.request<{ id?: number; name?: string }>({
      method: "POST",
      path: "/api/company-banks",
      body,
      tenantId: requireTenantId(tenantId, ctx),
    });
    return ok(res.data, {
      note: `Bank account created${res.data?.name ? `: ${res.data.name}` : ""}.`,
    });
  },
});

// --- Reconciliation --------------------------------------------------------

const getBankReconciliation = defineTool({
  name: "reai_get_bank_reconciliation",
  title: "Bank reconciliation for a month",
  description:
    "Read the reconciliation state of one bank account for one month (yyyy-MM): unmatched bank " +
    "transactions, unmatched ledger postings, and the groups already matched together.\n\n" +
    "This is also the only way to SEE bank transactions — there is no endpoint that lists them. " +
    "Use it to answer 'what still needs reconciling', then match with " +
    "reai_match_bank_transactions or book straight to an account with reai_book_bank_transactions.\n\n" +
    "This is the view for BANK-SYNCED accounts. If reai_list_company_banks reports " +
    'providerType "manual" for the account, use reai_request GET ' +
    "/api/manual-reconciliations/{bankAccountId}?month=yyyy-MM instead — a manual account has no " +
    "synced transactions and is reconciled against a statement balance.",
  risk: "read",
  apiPaths: [["GET", "/api/bank-reconciliations/{bankAccountId}"]],
  inputSchema: {
    bankAccountId: z
      .number()
      .int()
      .positive()
      .describe("Company bank account id, from reai_list_company_banks."),
    month: month.describe("Month to reconcile, as yyyy-MM."),
    include: z
      .array(z.enum(["summary", "pending_transactions", "pending_postings", "matched_groups"]))
      .optional()
      .describe(
        "Which sections to return. Omit for the API's default. Narrow this on a busy account — a " +
          "full month of transactions and postings can be large.",
      ),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "GET",
      path: `/api/bank-reconciliations/${args.bankAccountId}`,
      query: { month: args.month, include: args.include },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data, { note: `Reconciliation for bank account ${args.bankAccountId}, ${args.month}.` });
  },
});

const getBankTransaction = defineTool({
  name: "reai_get_bank_transaction",
  title: "Get one bank transaction",
  description:
    "Fetch a single bank transaction by id. Ids come from the pending_transactions section of " +
    "reai_get_bank_reconciliation — there is no endpoint that lists transactions directly.",
  risk: "read",
  apiPaths: [["GET", "/api/bank-transactions/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Bank transaction id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "GET",
      path: `/api/bank-transactions/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data);
  },
});

const listReconciliationRules = defineTool({
  name: "reai_list_reconciliation_rules",
  title: "List reconciliation rules",
  description:
    "List the automatic reconciliation rules. Each rule matches text in a bank transaction " +
    "description and books it to a chosen account — the mechanism behind recurring costs booking " +
    "themselves. Apply them with reai_apply_reconciliation_rules.",
  risk: "read",
  apiPaths: [["GET", "/api/reconciliation-rules"]],
  inputSchema: { tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/reconciliation-rules",
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const count = Array.isArray(res.data) ? res.data.length : 0;
    return ok(res.data, { note: `${count} reconciliation rule(s).` });
  },
});

const createReconciliationRule = defineTool({
  name: "reai_create_reconciliation_rule",
  title: "Create a reconciliation rule",
  description:
    "Create a rule that books matching bank transactions to an account automatically — the " +
    "mechanism behind recurring costs booking themselves.\n\n" +
    "A rule is STANDING AUTHORITY TO POST, which is why this is irreversible even though creating " +
    "it books nothing immediately. Applying it creates vouchers, the API documents an " +
    "'auto-reconciliation' step at bank-sync time that may act on the rule with no further call, " +
    "and deleting the rule afterwards does NOT reverse anything it already booked. Requires " +
    "REAI_WRITE_MODE=full.\n\n" +
    "matchText is matched against the bank transaction's description, so use a stable fragment of " +
    "the payee name rather than a whole line that varies by month.",
  // Escalated together with the path in classifyRequest. I initially kept this
  // reversible, reasoning that creation books nothing; two independent reviews
  // pushed back, and they are right that "books nothing YET" is not the same as
  // reversible when the API may act on the rule unprompted. Deletion is dragged
  // along -- it shares the prefix -- which is an accepted cost: a rule cannot be
  // removed in reversible mode, but nor can one be created there.
  risk: "irreversible",
  apiPaths: [["POST", "/api/reconciliation-rules"]],
  inputSchema: {
    matchText: z
      .string()
      .min(1)
      .describe('Text to look for in the transaction description, e.g. "TELENOR".'),
    accountNumber: z
      .string()
      .describe("Account to book matching transactions to. From reai_list_accounts."),
    description: z.string().min(1).describe("Description to put on the resulting posting."),
    vatCode: z.string().optional().describe("VAT code for the posting, from reai_list_vat_codes."),
    subAccountId: z.number().int().optional().describe("Optional general sub-account id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...body } = args;
    const res = await ctx.client.request<{ id?: number }>({
      method: "POST",
      path: "/api/reconciliation-rules",
      body,
      tenantId: requireTenantId(tenantId, ctx),
    });
    return ok(res.data, {
      note:
        `Rule created. It may be applied explicitly with reai_apply_reconciliation_rules, and may ` +
        `also be picked up by the next bank sync. Deleting it later does not reverse anything it ` +
        `has booked.`,
    });
  },
});

const deleteReconciliationRule = defineTool({
  name: "reai_delete_reconciliation_rule",
  title: "Delete a reconciliation rule",
  description:
    "Delete a reconciliation rule, stopping it matching future transactions. Postings it already " +
    "created are unaffected — deleting a rule is not a way to undo its bookings.\n\n" +
    "Classified irreversible only because it shares a path prefix with rule creation. Deleting a " +
    "rule is itself safe; it can only reduce future automation.",
  risk: "irreversible",
  apiPaths: [["DELETE", "/api/reconciliation-rules/{id}"]],
  destructive: true,
  inputSchema: {
    id: z.number().int().positive().describe("Rule id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "DELETE",
      path: `/api/reconciliation-rules/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data ?? `Reconciliation rule ${args.id} deleted (HTTP ${res.status}).`);
  },
});

const matchBankTransactions = defineTool({
  name: "reai_match_bank_transactions",
  title: "Match bank transactions to postings",
  description:
    "Reconcile bank transactions against existing ledger postings by matching them together. " +
    "Both id lists come from reai_get_bank_reconciliation. Several transactions can be matched to " +
    "several postings as one group, which is how a batched payout is reconciled.\n\n" +
    "This changes reconciliation state in the books. A group can be undone with reai_request POST " +
    "/api/bank-reconciliations/{bankAccountId}/groups/{groupId}/unmatch, but a discrepancy booked " +
    "as part of the match is a real posting. Requires REAI_WRITE_MODE=full.",
  risk: "irreversible",
  apiPaths: [["POST", "/api/bank-reconciliations/{bankAccountId}/matches"]],
  inputSchema: {
    bankAccountId: z.number().int().positive().describe("Company bank account id."),
    transactionIds: z
      .array(z.number().int().positive())
      .min(1)
      .describe("Bank transaction ids to match, from pending_transactions."),
    postingIds: z
      .array(z.number().int().positive())
      .min(1)
      .describe("Ledger posting ids to match them against, from pending_postings."),
    discrepancyAccount: z
      .string()
      .optional()
      .describe(
        "Account to book any difference to, when the totals do not agree exactly. Omit when they " +
          "balance — supplying it books a real posting for the difference.",
      ),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, bankAccountId, ...body } = args;
    const res = await ctx.client.request({
      method: "POST",
      path: `/api/bank-reconciliations/${bankAccountId}/matches`,
      body,
      tenantId: requireTenantId(tenantId, ctx),
    });
    return ok(res.data, {
      note:
        `Matched ${args.transactionIds.length} transaction(s) to ${args.postingIds.length} posting(s)` +
        `${args.discrepancyAccount ? `, booking any difference to ${args.discrepancyAccount}` : ""}.`,
    });
  },
});

const bookBankTransactions = defineTool({
  name: "reai_book_bank_transactions",
  title: "Book bank transactions to an account",
  description:
    "Book unmatched bank transactions straight to a counter-account, creating the voucher for them. " +
    "Use this when a transaction has no existing posting to match against — a bank fee, an interest " +
    "charge, a cost paid directly from the account.\n\n" +
    "This posts to the general ledger. Requires REAI_WRITE_MODE=full.",
  risk: "irreversible",
  apiPaths: [["POST", "/api/bank-reconciliations/{bankAccountId}/vouchers"]],
  inputSchema: {
    bankAccountId: z.number().int().positive().describe("Company bank account id."),
    transactionIds: z
      .array(z.number().int().positive())
      .min(1)
      .describe("Bank transaction ids to book, from reai_get_bank_reconciliation."),
    account: z
      .string()
      .min(1)
      .describe(
        "Counter-account to book them against. Either a base account number from " +
          'reai_list_accounts (e.g. "7770" for bank charges), or subledger syntax ' +
          '"accountNumber/subledgerId" to book against a specific subledger entry — e.g. ' +
          '"2400/123" books against supplier 123, which is what keeps the supplier ledger ' +
          "reconciled rather than leaving a bare balance on 2400.",
      ),
    vatCode: z.string().optional().describe("VAT code for the posting, from reai_list_vat_codes."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, bankAccountId, ...body } = args;
    const res = await ctx.client.request({
      method: "POST",
      path: `/api/bank-reconciliations/${bankAccountId}/vouchers`,
      body,
      tenantId: requireTenantId(tenantId, ctx),
    });
    return ok(res.data, {
      note: `Booked ${args.transactionIds.length} transaction(s) to account ${args.account}.`,
    });
  },
});

const applyReconciliationRules = defineTool({
  name: "reai_apply_reconciliation_rules",
  title: "Apply reconciliation rules",
  description:
    "Run the reconciliation rules against a bank account's unmatched transactions, booking every " +
    "match. Scope it with EITHER a month (yyyy-MM) or a complete startDate/endDate range — not " +
    "both, and not a half-open range.\n\n" +
    "This starts a BACKGROUND job and returns immediately, so the work is not done when the call " +
    "returns; re-read reai_get_bank_reconciliation to see the result. It books vouchers for " +
    "everything the rules match and can post many entries at once, so review the rules with " +
    "reai_list_reconciliation_rules first. Requires REAI_WRITE_MODE=full.",
  risk: "irreversible",
  apiPaths: [["POST", "/api/bank-reconciliations/{bankAccountId}/apply-rules"]],
  inputSchema: {
    bankAccountId: z.number().int().positive().describe("Company bank account id."),
    month: month.optional().describe("Month to apply rules to, as yyyy-MM."),
    startDate: isoDate.optional().describe("Start of an explicit date range instead of a month."),
    endDate: isoDate.optional().describe("End of an explicit date range."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, bankAccountId, ...body } = args;
    // A single bound is not a scope: the API fills the missing one itself, so
    // `startDate: "2018-01-01"` alone would apply rules across the account's
    // entire history — the exact outcome this guard exists to prevent.
    const hasRange = args.startDate !== undefined && args.endDate !== undefined;
    const hasPartialRange =
      (args.startDate === undefined) !== (args.endDate === undefined);
    if (args.month && (args.startDate || args.endDate)) {
      return fail(
        "Give either a month or a startDate/endDate range, not both — which one takes precedence " +
          "is undefined.",
      );
    }
    if (hasPartialRange) {
      return fail(
        "A date range needs BOTH startDate and endDate. With only one bound the API supplies the " +
          "other itself, which can apply rules across the account's whole history.",
      );
    }
    if (!args.month && !hasRange) {
      return fail(
        "Give either a month (yyyy-MM) or a complete startDate/endDate range. Applying rules " +
          "unscoped would book every unmatched transaction on the account.",
      );
    }
    const res = await ctx.client.request<{ status?: string }>({
      method: "POST",
      path: `/api/bank-reconciliations/${bankAccountId}/apply-rules`,
      body,
      tenantId: requireTenantId(tenantId, ctx),
    });

    // This is a background job (HTTP 202) that can also decline to start, so
    // reporting "applied" unconditionally would claim work that never happened.
    const scope = args.month ?? `${args.startDate} to ${args.endDate}`;
    const note =
      res.data?.status === "already_running"
        ? `A rule run is ALREADY IN PROGRESS on bank account ${bankAccountId}; nothing new was ` +
          `started. Re-read reai_get_bank_reconciliation once it finishes.`
        : `Rule run started for bank account ${bankAccountId} (${scope}). It runs in the ` +
          `background, so it is not finished yet — re-read reai_get_bank_reconciliation to see ` +
          `what it booked.`;
    return ok(res.data, { note });
  },
});

// --- VAT and tax -----------------------------------------------------------

const createVatReturn = defineTool({
  name: "reai_create_vat_return",
  title: "Settle and lock a VAT period",
  description:
    "Settle the VAT postings for a period, create or replace its VAT return voucher, and LOCK the " +
    "period. If the period has no VAT postings it is locked without a voucher.\n\n" +
    "This does NOT submit anything to Skatteetaten or Altinn. There is no submission endpoint in " +
    "the public API — filing happens in the ReAI UI, and POST /api/vat-returns/complete-manually " +
    "exists to record that a return was submitted through another system. Do not tell the user " +
    "their VAT return has been filed after calling this; it has been settled and locked.\n\n" +
    "Locking an accounting period is still among the least reversible things here. Reopening exists " +
    "(reai_request POST /api/vat-returns/reopen, which also needs year and period as query " +
    "parameters) but it reverses the settlement voucher and is an exception process, not an undo, " +
    "and it fails outright once the period is closed for posting. Confirm the period is genuinely " +
    "complete first — reai_general_ledger over it is the check. Requires REAI_WRITE_MODE=full.",
  risk: "irreversible",
  apiPaths: [["POST", "/api/vat-returns"]],
  inputSchema: {
    year: z
      .string()
      .regex(/^\d{4}$/, "Year must be four digits, e.g. 2026")
      .describe("Fiscal year."),
    period: z
      .enum(["1", "2", "3", "4", "5", "6"])
      .describe(
        "VAT term index, NOT a month number. 1 = Jan–Feb, 2 = Mar–Apr, 3 = May–Jun, 4 = Jul–Aug, " +
          "5 = Sep–Oct, 6 = Nov–Dec. A tenant on an annual term uses 1. Getting this wrong locks " +
          'the wrong period: asking for "April" means period 2, not 4.',
      ),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "POST",
      path: "/api/vat-returns",
      // year and period are query parameters here, not a body.
      query: { year: args.year, period: args.period },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data ?? "(no content)", {
      note:
        `VAT term ${args.period}/${args.year} (${VAT_TERM_MONTHS[args.period]}) settled and locked. ` +
        `NOT submitted to Skatteetaten — this only settles the books and locks the period.`,
    });
  },
});

const getTaxReturn = defineTool({
  name: "reai_get_tax_return",
  title: "Get the tax return for a year",
  description:
    "Read the tax return (skattemelding) for a fiscal year, including its computed figures and " +
    "submission status. Read-only: validating and filing are separate calls, and filing is " +
    "irreversible — reach them through reai_request with REAI_WRITE_MODE=full if you need them.",
  risk: "read",
  apiPaths: [["GET", "/api/tax-returns/{year}"]],
  inputSchema: {
    year: z
      .string()
      .regex(/^\d{4}$/, "Year must be four digits, e.g. 2026")
      .describe("Fiscal year."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "GET",
      path: `/api/tax-returns/${args.year}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data, { note: `Tax return for ${args.year}.` });
  },
});

export const bankVatTools: ToolDef[] = [
  listCompanyBanks,
  createCompanyBank,
  getBankReconciliation,
  getBankTransaction,
  listReconciliationRules,
  createReconciliationRule,
  deleteReconciliationRule,
  matchBankTransactions,
  bookBankTransactions,
  applyReconciliationRules,
  createVatReturn,
  getTaxReturn,
] as ToolDef[];
