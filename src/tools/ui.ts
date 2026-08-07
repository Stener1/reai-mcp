import { z } from "zod";
import { defineTool, ok, requireTenantId, tenantIdArg, type ToolDef } from "./registry.js";
import { renderReconciliation, type ReconciliationView } from "../ui/reconciliation.js";

/**
 * The one UI surface in this server, and deliberately the only one.
 *
 * A view earns its place when the user must make a selection the agent cannot make for
 * them, over items that are painful to name in prose. Bank reconciliation is the single
 * case in this API that qualifies: the interaction IS pairing, the tool it feeds already
 * takes two id arrays, and it is the one payload too large for text — a pending
 * transaction serialises to roughly 750 characters, so a busy month truncates.
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
    "by side, so a human can pick which ones pair. Returns an interactive view for clients " +
    "that render MCP UI resources, plus the same summary as text for those that do not.\n\n" +
    "This SELECTS; it does not post. When the pairing is chosen, matching still runs through " +
    "reai_match_bank_transactions and the same write policy — which classifies it irreversible, " +
    "because a match writes reconciliation state and can book a discrepancy.\n\n" +
    "Prefer reai_get_bank_reconciliation when you only need to read the state or answer a " +
    "question about it; this exists for the case where a person has to choose.",
  risk: "read",
  apiPaths: [["GET", "/api/bank-reconciliations/{bankAccountId}"]],
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
    const res = await ctx.client.request<ReconciliationView>({
      method: "GET",
      path: `/api/bank-reconciliations/${bankAccountId}`,
      query: { month },
      tenantId: requireTenantId(tenantId, ctx),
    });
    const data = res.data ?? {};

    const txCount = data.pendingTransactionCount ?? data.pendingTransactions?.length ?? 0;
    const postCount = data.pendingPostingCount ?? data.pendingPostings?.length ?? 0;
    const note =
      `${txCount} unmatched transaction(s) and ${postCount} unmatched posting(s) on ` +
      `${data.bankAccountName ?? `account ${bankAccountId}`} for ${month}.` +
      (txCount === 0 && postCount === 0
        ? " Nothing to pair — this month is reconciled."
        : " Pick a pairing in the view, then call reai_match_bank_transactions with the ids.") +
      (data.closed || data.reconciliationLocked
        ? " Note the period is closed or locked, so matching will be refused until it is reopened."
        : "");

    // The counts and totals as TEXT, not just inside the view. A client that does not
    // render the resource must still get an answer, and the numbers are what the answer
    // is made of — the arrays are what the view is for.
    const summary = {
      bankAccountId: data.bankAccountId ?? bankAccountId,
      bankAccountName: data.bankAccountName,
      month: data.month ?? month,
      closed: data.closed ?? false,
      reconciliationLocked: data.reconciliationLocked ?? false,
      pendingTransactionCount: txCount,
      pendingPostingCount: postCount,
      pendingTransactionsTotal: data.pendingTransactionsTotal,
      pendingPostingsTotal: data.pendingPostingsTotal,
      pendingDiscrepancy: data.pendingDiscrepancy,
    };

    const result = ok(summary, { note });
    result.content.push({
      type: "resource",
      resource: {
        uri: `ui://reai/reconciliation/${bankAccountId}/${month}`,
        mimeType: "text/html",
        text: renderReconciliation(data),
      },
    });
    return result;
  },
});

/**
 * Registered only when REAI_ENABLE_UI is set.
 *
 * A client that does not render HTML resources would otherwise receive several kilobytes
 * of markup where it expected an answer, which costs the model context and gains nothing.
 * Off by default is the honest setting while it is unknown what a given client renders.
 */
export const uiTools: ToolDef[] = [reconcileUi];
