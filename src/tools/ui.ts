import { z } from "zod";
import { defineTool, ok, requireTenantId, tenantIdArg, type ToolDef } from "./registry.js";
import { isAllowed } from "../policy.js";
import {
  buildReconcileData,
  MAX_ROWS,
  RECONCILE_TEMPLATE_URI,
  resolveSide,
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
    // By COST, not by row count. Counting rows meant one 20,000-character description
    // emptied the *other* column: the cheap side kept losing rows to pay for a defect in
    // the expensive one.
    const dearer =
      JSON.stringify(out.transactions).length >= JSON.stringify(out.postings).length
        ? "transactions"
        : "postings";
    const rows = out[dearer];
    // Nothing left to drop means the overage is not in the rows. `buildReconcileData`
    // bounds every scalar, so that is unreachable through the API — but silently returning
    // an over-budget payload would be the wrong way to discover otherwise.
    if (rows.length === 0) break;
    // A tenth at a time. Halving converges in fewer passes but overshoots badly — a
    // 400-row month landed at 60 rows inside a budget that fits well over 100.
    const keep = Math.max(0, rows.length - Math.max(1, Math.ceil(rows.length / 10)));
    out = { ...out, [dearer]: rows.slice(0, keep) };
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
    // view exists to prevent — just moved one layer down. "Nothing to pair, this month is
    // reconciled" derived from an empty body is a positive claim about the books made from
    // no evidence, and it is the sentence the MODEL reads.
    //
    // Per SIDE, not for the pair. The first attempt required BOTH sides to be absent
    // before it would admit ignorance, so a response mentioning only transactions was
    // announced as reconciled on the strength of a ledger side nobody had reported — and a
    // response with 3 transactions and no posting field printed "3 unmatched transaction(s)
    // and 0 unmatched posting(s)", which is verbatim the shape that sends an agent to the
    // booking tool.
    const tx = resolveSide(view.pendingTransactionCount, view.pendingTransactions);
    const post = resolveSide(view.pendingPostingCount, view.pendingPostings);

    const data = fitToBudget(
      buildReconcileData(view, {
        bankAccountId,
        month,
        tenantId: tenant,
        canMatch: isAllowed("irreversible", ctx.config.writeMode),
        writeMode: ctx.config.writeMode,
      }),
    );

    const where = `${data.bankAccountName} for ${data.month}`;
    const said = (facts: typeof tx, noun: string): string =>
      facts.total === null ? `an unreported number of unmatched ${noun}(s)` : `${facts.total} unmatched ${noun}(s)`;

    let note = `${said(tx, "transaction")} and ${said(post, "posting")} on ${where}.`;
    if (tx.total === null || post.total === null) {
      const which =
        tx.total === null && post.total === null
          ? "Neither side was"
          : tx.total === null
            ? "The bank side was not"
            : "The ledger side was not";
      note +=
        ` ${which} reported by the endpoint, so this is NOT an established reconciliation — ` +
        `unreported is not the same as nothing unmatched. Check the account has a bank feed ` +
        `(providerType 'manual' has no reconciliation view), then read ` +
        `reai_list_bank_transactions directly.`;
    } else if (tx.rowsMissing || post.rowsMissing) {
      note +=
        ` The endpoint gave counts without the corresponding list, so the view cannot show ` +
        `those rows. Read reai_get_bank_reconciliation to see the raw response.`;
    } else if (tx.total === 0 && post.total === 0) {
      note = `Nothing unmatched on ${where} — this month is reconciled.`;
    } else {
      note += ` Pick a pairing in the view, then call reai_match_bank_transactions with the ids.`;
    }
    if (tx.disagreed || post.disagreed) {
      note +=
        ` Note the endpoint's count disagreed with the list it returned; the list was ` +
        `believed, because rows that exist are the harder fact.`;
    }
    if (data.locked) {
      note += ` The period is closed or locked, so matching will be refused until it is reopened.`;
    }
    if (!data.comparable) {
      note +=
        ` This account is in ${data.bankCurrency} while the books are in ${data.tenantCurrency}, ` +
        `so the view shows each posting's two figures by field name and computes no difference — ` +
        `the API documents neither field, so which one is the bank's could not be established.`;
    }
    if (!data.canMatch) {
      note +=
        ` Matching is not available in write mode '${data.writeMode}': it is an irreversible ` +
        `write, so reai_match_bank_transactions is not registered and the view's button is ` +
        `disabled. The view still shows the exact call.`;
    }
    const shownTx = data.transactions.length;
    const shownPost = data.postings.length;
    if (shownTx < (tx.total ?? 0) || shownPost < (post.total ?? 0)) {
      note +=
        ` The view shows ${shownTx} of ${tx.total} transaction(s) and ${shownPost} ` +
        `of ${post.total} posting(s); match those first, or narrow the month.`;
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
      writeMode: data.writeMode,
      matchingAvailable: data.canMatch,
      pendingTransactionCount: tx.total,
      pendingPostingCount: post.total,
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
