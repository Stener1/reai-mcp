import { z } from "zod";
import { defineTool, ok, requireTenantId, tenantIdArg, type ToolDef } from "./registry.js";
import {
  buildReconcileData,
  MAX_ROWS,
  RECONCILE_TEMPLATE_URI,
  type ReconcileData,
  type ReconciliationView,
} from "../ui/reconciliation.js";

/**
 * What `structuredContent` may occupy.
 *
 * The template is static and fetched once, so the per-call payload is this JSON — and
 * several hosts put `structuredContent` in front of the model, which makes it a context
 * cost, not just a rendering input. Sized well under the 24,000-character result cap the
 * rest of this server holds itself to, because this travels *in addition* to the text
 * summary rather than instead of it.
 */
const MAX_DATA_CHARS = 12_000;

/**
 * Drop rows until the payload fits, from the bottom of both columns evenly.
 *
 * The counts are never touched, so trimming stays visible: the view reads them, not the
 * array lengths, and says "Showing 40 of 300". A silent trim here would recreate the
 * defect this whole surface exists to avoid.
 */
function fitToBudget(data: ReconcileData): ReconcileData {
  let out = data;
  while (JSON.stringify(out).length > MAX_DATA_CHARS) {
    const longer = out.transactions.length >= out.postings.length ? "transactions" : "postings";
    const rows = out[longer];
    if (rows.length === 0) break;
    // A tenth at a time. Halving converges in fewer passes but overshoots badly — a
    // 400-row month landed at 60 rows inside a budget that fits well over 100, which
    // discards rows the user could have matched.
    const keep = Math.max(0, rows.length - Math.max(1, Math.ceil(rows.length / 10)));
    out = { ...out, [longer]: rows.slice(0, keep) };
  }
  return out;
}

/**
 * The one UI surface in this server, and deliberately the only one.
 *
 * A view earns its place when the user must make a selection the agent cannot make for
 * them, over items that are painful to name in prose. Bank reconciliation is the single
 * case in this API that qualifies: the interaction IS pairing, and the tool it feeds
 * already takes two id arrays.
 *
 * Everything else here is computable and belongs in a sentence. A revenue chart or a
 * voucher list would be decoration, and each additional view is another surface to keep
 * in step with 63 tools.
 */
const reconcileUi = defineTool({
  name: "reai_reconcile_ui",
  title: "Bank reconciliation pairing view",
  description:
    "Show the unmatched bank transactions and unmatched ledger postings for one month side " +
    "by side, so a human can pick which ones pair. Returns an interactive view for hosts " +
    "that support MCP Apps, plus the same summary as text for those that do not.\n\n" +
    "This SELECTS; it does not post. When the pairing is chosen, matching still runs through " +
    "reai_match_bank_transactions and the same write policy — which classifies it irreversible, " +
    "because a match writes reconciliation state and can book a discrepancy.\n\n" +
    "Only meaningful for a bank account with a real feed. For providerType 'manual' this " +
    "endpoint is not the working view — use reai_list_bank_transactions instead, or the view " +
    "will look reconciled when nothing has been reconciled.\n\n" +
    "Prefer reai_get_bank_reconciliation when you only need to read the state or answer a " +
    "question about it; this exists for the case where a person has to choose.",
  risk: "read",
  apiPaths: [["GET", "/api/bank-reconciliations/{bankAccountId}"]],
  // How an MCP Apps host finds the view. Without it the HTML is just an inert resource.
  meta: { ui: { resourceUri: RECONCILE_TEMPLATE_URI } },
  inputSchema: {
    bankAccountId: z
      .number()
      .int()
      .positive()
      .describe("Company bank account id, from reai_list_company_banks."),
    month: z
      .string()
      .regex(/^\d{4}-\d{2}$/, "Month must be yyyy-MM.")
      .describe("Month to reconcile, yyyy-MM."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, bankAccountId, month } = args;
    const tenant = requireTenantId(tenantId, ctx);
    const res = await ctx.client.request<ReconciliationView>({
      method: "GET",
      path: `/api/bank-reconciliations/${bankAccountId}`,
      query: { month },
      tenantId: tenant,
    });
    const view = res.data ?? {};

    // Absence and zero are different answers, and conflating them is the failure this
    // view exists to prevent — just moved one layer down. An empty body reported as
    // "nothing to pair, this month is reconciled" is a positive claim about the books
    // made from no evidence, and it is the sentence the MODEL reads.
    const txList = Array.isArray(view.pendingTransactions) ? view.pendingTransactions : undefined;
    const postList = Array.isArray(view.pendingPostings) ? view.pendingPostings : undefined;
    const txCount = view.pendingTransactionCount ?? txList?.length;
    const postCount = view.pendingPostingCount ?? postList?.length;
    const knowNothing = txCount === undefined && postCount === undefined;
    const countsWithoutRows =
      (txCount !== undefined && txCount > 0 && txList === undefined) ||
      (postCount !== undefined && postCount > 0 && postList === undefined);

    const data = fitToBudget(buildReconcileData(view, { bankAccountId, month, tenantId: tenant }));

    const where = `${data.bankAccountName} for ${data.month}`;
    let note: string;
    if (knowNothing) {
      note =
        `The reconciliation endpoint returned no counts and no lists for ${where}, so whether ` +
        `anything is unmatched is unknown — this is NOT a reconciled month. Check the account ` +
        `exists and has a bank feed (providerType 'manual' has no reconciliation view), then ` +
        `read reai_list_bank_transactions directly.`;
    } else if (countsWithoutRows) {
      note =
        `${txCount ?? "?"} unmatched transaction(s) and ${postCount ?? "?"} unmatched posting(s) ` +
        `on ${where}, but the endpoint returned counts without the corresponding list, so the ` +
        `view cannot show them. Read reai_get_bank_reconciliation to see the raw response.`;
    } else if (data.transactionTotal === 0 && data.postingTotal === 0) {
      note = `Nothing unmatched on ${where} — this month is reconciled.`;
    } else {
      note =
        `${data.transactionTotal} unmatched transaction(s) and ${data.postingTotal} unmatched ` +
        `posting(s) on ${where}. Pick a pairing in the view, then call ` +
        `reai_match_bank_transactions with the ids.`;
    }
    if (data.locked) {
      note += ` The period is closed or locked, so matching will be refused until it is reopened.`;
    }
    if (!data.comparable) {
      note +=
        ` This account is in ${data.bankCurrency} while the books are in ${data.tenantCurrency}, ` +
        `so the view shows both figures per posting and does not compute a difference.`;
    }
    const shownTx = data.transactions.length;
    const shownPost = data.postings.length;
    if (shownTx < data.transactionTotal || shownPost < data.postingTotal) {
      note +=
        ` The view shows ${shownTx} of ${data.transactionTotal} transaction(s) and ${shownPost} ` +
        `of ${data.postingTotal} posting(s); match those first, or narrow the month.`;
    }

    // The counts and totals as TEXT, not only inside the view. A host that does not
    // support MCP Apps must still get an answer, and the numbers are what the answer is
    // made of — the rows are what the view is for.
    const summary = {
      bankAccountId: data.bankAccountId,
      bankAccountName: data.bankAccountName,
      month: data.month,
      bankCurrency: data.bankCurrency,
      tenantCurrency: data.tenantCurrency,
      closed: view.closed ?? false,
      reconciliationLocked: view.reconciliationLocked ?? false,
      pendingTransactionCount: txCount ?? null,
      pendingPostingCount: postCount ?? null,
      rowsShown: { transactions: shownTx, postings: shownPost, cap: MAX_ROWS },
      pendingTransactionsTotal: view.pendingTransactionsTotal,
      pendingPostingsTotal: view.pendingPostingsTotal,
      pendingDiscrepancy: view.pendingDiscrepancy,
    };

    const result = ok(summary, { note });
    // What the host hands the view, as `ui/notifications/tool-result`.
    result.structuredContent = data as unknown as Record<string, unknown>;
    return result;
  },
});

/**
 * Registered only when REAI_ENABLE_UI is set.
 *
 * A host that cannot render the view still receives the whole answer as text, but it also
 * receives a tool whose point it cannot honour and a `structuredContent` payload it will
 * put in front of the model. Off by default is the honest setting while it is unknown
 * what a given client supports.
 */
export const uiTools: ToolDef[] = [reconcileUi];
