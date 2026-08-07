/**
 * A pairing view for bank reconciliation.
 *
 * This is the one place in ReAI where a UI earns its keep, and the test it passes is
 * narrow: the user has to make a selection the agent cannot make for them, over items
 * that are painful to name in prose. "Match the 1,234.50 on the 3rd against the Europris
 * posting" is worse than two columns and a click, and `reai_match_bank_transactions`
 * already takes `transactionIds[]` and `postingIds[]` — the tool signature *is* a
 * multi-select.
 *
 * It is also the one payload that does not fit in text. A pending transaction serialises
 * to roughly 750 characters, so a busy month exceeds the result cap; a cumulative review
 * found a truncated reconciliation showing unmatched transactions and zero unmatched
 * postings, from which an agent would conclude there was nothing to match against and
 * reach for the booking tool — which posts — instead of the matching tool.
 *
 * Everything else in this API is computable and belongs in a sentence. A dashboard would
 * be decoration.
 */

/** What the reconciliation endpoint returns, narrowed to what this view reads. */
export type ReconciliationView = {
  bankAccountId?: number;
  bankAccountName?: string;
  bankCurrency?: string;
  month?: string;
  closed?: boolean;
  reconciliationLocked?: boolean;
  pendingTransactionCount?: number;
  pendingPostingCount?: number;
  pendingTransactionsTotal?: number;
  pendingPostingsTotal?: number;
  pendingDiscrepancy?: number;
  pendingTransactions?: ReadonlyArray<{
    id?: number;
    amount?: number;
    currency?: string;
    transactionDate?: string;
    description?: string;
    paymentReference?: string | null;
  }>;
  pendingPostings?: ReadonlyArray<{
    id?: number;
    amount?: number;
    voucherNumber?: string;
    postingDate?: string;
    description?: string;
  }>;
};

/**
 * Rows rendered per column.
 *
 * A cap rather than "all of them", because the point of this view is a decision and
 * 400 rows is not a decision. The count is always stated, so a truncated column cannot
 * be mistaken for a complete one — the failure that made this view worth building.
 */
const MAX_ROWS = 120;

/**
 * Escape for HTML text and attribute context.
 *
 * Not optional here. Descriptions and payment references arrive from EHF documents and
 * bank feeds, which is to say from counterparties — a supplier controls the text of its
 * own invoice line. This view is rendered inside the user's client, so an unescaped
 * `description` is script injection with an external author.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Norwegian-format amount, so figures read the way the books do. */
function money(value: unknown, currency?: string): string {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const formatted = n.toLocaleString("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Non-breaking space, spelled out rather than typed: an amount must not wrap away from
  // its currency code, and an invisible U+00A0 in the source reads as a typo.
  return currency ? `${formatted}\u00a0${currency}` : formatted;
}

function row(
  kind: "tx" | "post",
  id: number,
  date: string,
  amount: string,
  description: string,
  secondary: string,
): string {
  const inputId = `${kind}-${id}`;
  return `<label class="row" for="${escapeHtml(inputId)}">
  <input type="checkbox" id="${escapeHtml(inputId)}" data-kind="${kind}" data-id="${escapeHtml(id)}" data-amount="${escapeHtml(amount)}">
  <span class="date">${escapeHtml(date)}</span>
  <span class="desc" title="${escapeHtml(description)}">${escapeHtml(description) || "<em>(no description)</em>"}</span>
  <span class="meta">${escapeHtml(secondary)}</span>
  <span class="amt">${escapeHtml(amount)}</span>
</label>`;
}

/**
 * Render the pairing view as a single self-contained document.
 *
 * No external requests of any kind — no CDN, no font, no image. A client renders this in
 * a sandboxed frame and a strict CSP is the norm, so anything fetched would silently
 * fail; more to the point, an accounting view should not phone anywhere.
 */
export function renderReconciliation(data: ReconciliationView): string {
  const currency = data.bankCurrency ?? "NOK";
  const transactions = (data.pendingTransactions ?? []).slice(0, MAX_ROWS);
  const postings = (data.pendingPostings ?? []).slice(0, MAX_ROWS);
  const txTotal = data.pendingTransactionCount ?? data.pendingTransactions?.length ?? 0;
  const postTotal = data.pendingPostingCount ?? data.pendingPostings?.length ?? 0;

  const txRows = transactions
    .map((t) =>
      row(
        "tx",
        t.id ?? 0,
        t.transactionDate ?? "",
        money(t.amount, t.currency ?? currency),
        t.description ?? "",
        t.paymentReference ? `ref ${t.paymentReference}` : "",
      ),
    )
    .join("\n");

  const postRows = postings
    .map((p) =>
      row(
        "post",
        p.id ?? 0,
        p.postingDate ?? "",
        money(p.amount, currency),
        p.description ?? "",
        p.voucherNumber ?? "",
      ),
    )
    .join("\n");

  const trimmed = (shown: number, total: number): string =>
    shown < total
      ? `<p class="trimmed">Showing ${shown} of ${total}. Narrow the month, or match these first — a
         partial column is not the whole job.</p>`
      : "";

  const locked = data.closed || data.reconciliationLocked;

  return `<div id="reai-reconcile">
<style>
  #reai-reconcile { font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; color: #111; }
  #reai-reconcile * { box-sizing: border-box; }
  #reai-reconcile h2 { font-size: 15px; margin: 0 0 2px; }
  #reai-reconcile .sub { color: #666; font-size: 12px; margin: 0 0 14px; }
  #reai-reconcile .cols { display: flex; gap: 16px; flex-wrap: wrap; }
  #reai-reconcile .col { flex: 1 1 320px; min-width: 280px; }
  #reai-reconcile .col > h3 { font-size: 13px; margin: 0 0 6px; color: #333; }
  #reai-reconcile .rows { max-height: 340px; overflow-y: auto; border: 1px solid #e3e3e6; border-radius: 8px; }
  #reai-reconcile .row { display: grid; grid-template-columns: 20px 78px 1fr auto auto;
    gap: 8px; align-items: center; padding: 7px 10px; border-bottom: 1px solid #f0f0f2; cursor: pointer; }
  #reai-reconcile .row:last-child { border-bottom: 0; }
  #reai-reconcile .row:hover { background: #f7f7f9; }
  #reai-reconcile .date { color: #666; font-variant-numeric: tabular-nums; font-size: 12px; }
  #reai-reconcile .desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #reai-reconcile .meta { color: #888; font-size: 11px; }
  #reai-reconcile .amt { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
  #reai-reconcile .bar { margin-top: 14px; padding: 10px 12px; border: 1px solid #e3e3e6;
    border-radius: 8px; display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  #reai-reconcile .diff { font-variant-numeric: tabular-nums; font-weight: 600; }
  #reai-reconcile .balanced { color: #0a7d33; }
  #reai-reconcile .unbalanced { color: #b3261e; }
  #reai-reconcile .call { margin: 10px 0 0; padding: 10px; background: #f5f5f7; border-radius: 8px;
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
  #reai-reconcile .trimmed, #reai-reconcile .note { color: #666; font-size: 12px; margin: 6px 0 0; }
  #reai-reconcile .locked { background: #fff4e5; border: 1px solid #f0c48a; padding: 8px 10px;
    border-radius: 8px; margin-bottom: 12px; font-size: 12px; }
  #reai-reconcile .empty { padding: 14px; color: #666; font-size: 12px; }
  @media (prefers-color-scheme: dark) {
    #reai-reconcile { color: #e8e8ea; }
    #reai-reconcile .sub, #reai-reconcile .date, #reai-reconcile .meta,
    #reai-reconcile .trimmed, #reai-reconcile .note, #reai-reconcile .empty { color: #a0a0a6; }
    #reai-reconcile .col > h3 { color: #d0d0d4; }
    #reai-reconcile .rows, #reai-reconcile .bar { border-color: #3a3a3f; }
    #reai-reconcile .row { border-bottom-color: #2c2c30; }
    #reai-reconcile .row:hover { background: #26262a; }
    #reai-reconcile .call { background: #26262a; }
    #reai-reconcile .balanced { color: #4ade80; }
    #reai-reconcile .unbalanced { color: #f87171; }
    #reai-reconcile .locked { background: #3a2e1a; border-color: #6b5220; }
  }
</style>

<h2>Bank reconciliation — ${escapeHtml(data.bankAccountName ?? "account")} ${escapeHtml(data.month ?? "")}</h2>
<p class="sub">${escapeHtml(txTotal)} unmatched transaction(s), ${escapeHtml(postTotal)} unmatched posting(s).
Pick one side and the other; the difference tells you whether they pair.</p>

${locked ? `<p class="locked">This period is closed or locked, so matching will be refused until it is reopened.</p>` : ""}

<div class="cols">
  <div class="col">
    <h3>Bank transactions</h3>
    <div class="rows">${txRows || `<p class="empty">Nothing unmatched on the bank side.</p>`}</div>
    ${trimmed(transactions.length, txTotal)}
  </div>
  <div class="col">
    <h3>Ledger postings</h3>
    <div class="rows">${postRows || `<p class="empty">Nothing unmatched on the ledger side.</p>`}</div>
    ${trimmed(postings.length, postTotal)}
  </div>
</div>

<div class="bar">
  <span id="reai-count">0 transactions, 0 postings selected</span>
  <span class="diff" id="reai-diff"></span>
</div>
<p class="call" id="reai-call">Select on both sides to see the exact call to run.</p>
<p class="note">Selecting here does not post anything. Matching is an irreversible write, so it runs
only when you ask for it — through the same write policy as every other call.</p>

<script>
(function () {
  var root = document.getElementById("reai-reconcile");
  if (!root) return;
  var boxes = root.querySelectorAll('input[type=checkbox]');
  var countEl = root.querySelector("#reai-count");
  var diffEl = root.querySelector("#reai-diff");
  var callEl = root.querySelector("#reai-call");

  // Amounts are rendered nb-NO ("1 234,50 NOK"), so parse back rather than trusting a
  // dot-decimal read: a comma decimal silently parses as an integer otherwise.
  function amountOf(el) {
    var raw = String(el.getAttribute("data-amount") || "");
    var cleaned = raw.replace(/[^0-9,.\\-]/g, "").replace(/\\./g, "").replace(",", ".");
    var n = parseFloat(cleaned);
    return isFinite(n) ? n : 0;
  }

  function update() {
    var tx = [], post = [], txSum = 0, postSum = 0;
    boxes.forEach(function (b) {
      if (!b.checked) return;
      var id = Number(b.getAttribute("data-id"));
      if (b.getAttribute("data-kind") === "tx") { tx.push(id); txSum += amountOf(b); }
      else { post.push(id); postSum += amountOf(b); }
    });
    countEl.textContent = tx.length + " transaction(s), " + post.length + " posting(s) selected";
    var diff = Math.round((txSum - postSum) * 100) / 100;
    if (!tx.length && !post.length) {
      diffEl.textContent = "";
      callEl.textContent = "Select on both sides to see the exact call to run.";
      return;
    }
    diffEl.textContent = diff === 0 ? "balanced" : "difference " + diff.toFixed(2);
    diffEl.className = "diff " + (diff === 0 ? "balanced" : "unbalanced");
    var args = { bankAccountId: ${escapeHtml(data.bankAccountId ?? 0)}, transactionIds: tx, postingIds: post };
    if (diff !== 0) args.discrepancyAccount = "SET_THE_ACCOUNT_TO_BOOK_THE_DIFFERENCE_TO";
    callEl.textContent = "reai_match_bank_transactions " + JSON.stringify(args);
  }

  boxes.forEach(function (b) { b.addEventListener("change", update); });
  update();
})();
</script>
</div>`;
}
