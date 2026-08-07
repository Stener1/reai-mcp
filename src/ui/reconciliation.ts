/**
 * A pairing view for bank reconciliation — the one UI surface in this server.
 *
 * The test it passes is narrow: the user has to make a selection the agent cannot make
 * for them, over items that are painful to name in prose. "Match the 1,234.50 on the 3rd
 * against the Europris posting" is worse than two columns and a click, and
 * `reai_match_bank_transactions` already takes `transactionIds[]` and `postingIds[]` —
 * the tool signature *is* a multi-select.
 *
 * It is also the one payload that does not fit in text. A pending transaction serialises
 * to roughly 750 characters, so a busy month exceeds the result cap; a cumulative review
 * found a truncated reconciliation showing unmatched transactions and zero unmatched
 * postings, from which an agent would conclude there was nothing to match against and
 * reach for the booking tool — which posts — instead of the matching tool.
 *
 * Everything else in this API is computable and belongs in a sentence. A dashboard would
 * be decoration.
 *
 * ## Why the template is static
 *
 * MCP Apps registers the UI as a RESOURCE that the host fetches once, and delivers each
 * call's data separately as a `ui/notifications/tool-result` notification carrying
 * `structuredContent`. So the HTML here takes no data at all: the server sends numbers,
 * the view renders them. That is not merely the spec's shape, it is the safer one —
 * descriptions and payment references are written by counterparties, and inserting them
 * as DOM text nodes cannot be an injection the way interpolating them into markup can.
 */

/** The URI the tool's `_meta.ui.resourceUri` points at, and the resource is served from. */
export const RECONCILE_TEMPLATE_URI = "ui://reai/reconciliation";

/**
 * The MIME type MCP Apps hosts key on.
 *
 * A host that does not recognise it falls back to treating the resource as inert, which
 * is why the tool also returns the whole answer as text.
 */
export const RECONCILE_TEMPLATE_MIME = "text/html;profile=mcp-app";

/**
 * Rows sent per column.
 *
 * A cap rather than "all of them", because the point of this view is a decision and 400
 * rows is not a decision. It also bounds `structuredContent`, which several hosts put in
 * front of the model. The TRUE total travels alongside and is always displayed, so a
 * trimmed column cannot be mistaken for a complete one — the failure that made this view
 * worth building.
 */
export const MAX_ROWS = 120;

/** What the reconciliation endpoint returns, narrowed to what this view reads. */
export type ReconciliationView = {
  bankAccountId?: number;
  bankAccountName?: string;
  bankCurrency?: string;
  /**
   * The books' currency. Present because it can differ from `bankCurrency`, which is the
   * whole reason postings carry two amounts.
   */
  tenantCurrency?: string;
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
    description?: string | null;
    paymentReference?: string | null;
  }>;
  pendingPostings?: ReadonlyArray<{
    id?: number;
    amount?: number;
    /** The same posting in the other currency. Which one is which — see `comparable`. */
    currencyAmount?: number;
    voucherNumber?: string | null;
    postingDate?: string;
    description?: string | null;
  }>;
};

/** Exactly what the view is given. Nothing here is markup. */
export type ReconcileData = {
  bankAccountId: number;
  bankAccountName: string;
  bankCurrency: string;
  tenantCurrency: string;
  month: string;
  /** Carried so the call the view offers to make names the same tenant the read used. */
  tenantId?: number;
  locked: boolean;
  /** True totals, independent of how many rows travelled. */
  transactionTotal: number;
  postingTotal: number;
  /**
   * Whether the two columns' amounts are in the same currency and may therefore be
   * subtracted. When false the view shows both figures and declines to state a
   * difference — see the note in `buildReconcileData`.
   */
  comparable: boolean;
  transactions: Array<{
    id: number;
    date: string;
    amount: number;
    currency: string;
    description: string;
    reference: string;
  }>;
  postings: Array<{
    id: number;
    date: string;
    amount: number;
    currencyAmount: number | null;
    voucherNumber: string;
    description: string;
  }>;
};

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Reduce the API's reconciliation to what the view needs, capped and honest about it.
 *
 * ## The currency decision
 *
 * `BankReconciliationPostingRes` carries both `amount` and `currencyAmount`, and the
 * overview carries both `bankCurrency` and `tenantCurrency`. For a foreign-currency bank
 * account one of the posting figures is the books' amount and the other is the bank's —
 * but the OpenAPI document gives neither field a description, and no tenant this repo may
 * read has a non-NOK bank account, so which is which could not be established. Guessing
 * would produce a confident wrong difference (a USD 100 transaction against a NOK 1,050 /
 * USD 100 posting reads as a USD 950 discrepancy) at the exact moment the user is deciding
 * an irreversible match.
 *
 * So: when the currencies agree — every case that exists in reachable data — subtract as
 * normal. When they differ, mark the data `comparable: false`, ship both posting figures,
 * and let the view show them side by side without asserting a difference.
 */
export function buildReconcileData(
  view: ReconciliationView,
  fallback: { bankAccountId: number; month: string; tenantId?: number },
): ReconcileData {
  const bankCurrency = str(view.bankCurrency) || "NOK";
  const tenantCurrency = str(view.tenantCurrency) || bankCurrency;
  const transactions = (view.pendingTransactions ?? []).slice(0, MAX_ROWS);
  const postings = (view.pendingPostings ?? []).slice(0, MAX_ROWS);

  return {
    bankAccountId: view.bankAccountId ?? fallback.bankAccountId,
    bankAccountName: str(view.bankAccountName) || `account ${fallback.bankAccountId}`,
    bankCurrency,
    tenantCurrency,
    month: str(view.month) || fallback.month,
    ...(fallback.tenantId === undefined ? {} : { tenantId: fallback.tenantId }),
    locked: view.closed === true || view.reconciliationLocked === true,
    transactionTotal: view.pendingTransactionCount ?? (view.pendingTransactions ?? []).length,
    postingTotal: view.pendingPostingCount ?? (view.pendingPostings ?? []).length,
    comparable: bankCurrency === tenantCurrency,
    transactions: transactions.map((t) => ({
      id: num(t.id),
      date: str(t.transactionDate),
      amount: num(t.amount),
      currency: str(t.currency) || bankCurrency,
      description: str(t.description),
      reference: str(t.paymentReference),
    })),
    postings: postings.map((p) => ({
      id: num(p.id),
      date: str(p.postingDate),
      amount: num(p.amount),
      currencyAmount: typeof p.currencyAmount === "number" ? p.currencyAmount : null,
      voucherNumber: str(p.voucherNumber),
      description: str(p.description),
    })),
  };
}

const STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 14px; font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; color: #111; }
  h2 { font-size: 15px; margin: 0 0 2px; }
  .sub { color: #666; font-size: 12px; margin: 0 0 14px; }
  .cols { display: flex; gap: 16px; flex-wrap: wrap; }
  .col { flex: 1 1 320px; min-width: 260px; }
  .col > h3 { font-size: 13px; margin: 0 0 6px; color: #333; }
  .rows { max-height: 340px; overflow-y: auto; border: 1px solid #e3e3e6; border-radius: 8px; }
  .row { display: grid; grid-template-columns: 20px 78px 1fr auto auto; gap: 8px;
    align-items: center; padding: 7px 10px; border-bottom: 1px solid #f0f0f2; cursor: pointer; }
  .row:last-child { border-bottom: 0; }
  .row:hover { background: #f7f7f9; }
  .date { color: #666; font-variant-numeric: tabular-nums; font-size: 12px; }
  .desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .muted { color: #999; font-style: italic; }
  .meta { color: #888; font-size: 11px; }
  .amt { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
  .alt { color: #888; font-size: 11px; display: block; }
  .bar { margin-top: 14px; padding: 10px 12px; border: 1px solid #e3e3e6; border-radius: 8px;
    display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  .diff { font-variant-numeric: tabular-nums; font-weight: 600; }
  .balanced { color: #0a7d33; }
  .unbalanced { color: #b3261e; }
  button { font: inherit; padding: 6px 12px; border-radius: 7px; border: 1px solid #c9c9ce;
    background: #fff; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  input[type=text] { font: inherit; padding: 5px 8px; border-radius: 6px;
    border: 1px solid #c9c9ce; width: 15ch; }
  .call { margin: 10px 0 0; padding: 10px; background: #f5f5f7; border-radius: 8px;
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap;
    word-break: break-word; }
  .trimmed, .note { color: #666; font-size: 12px; margin: 6px 0 0; }
  .warn { background: #fff4e5; border: 1px solid #f0c48a; padding: 8px 10px; border-radius: 8px;
    margin-bottom: 12px; font-size: 12px; }
  .empty { padding: 14px; color: #666; font-size: 12px; margin: 0; }
  @media (prefers-color-scheme: dark) {
    body { color: #e8e8ea; }
    .sub, .date, .meta, .alt, .trimmed, .note, .empty { color: #a0a0a6; }
    .col > h3 { color: #d0d0d4; }
    .rows, .bar { border-color: #3a3a3f; }
    .row { border-bottom-color: #2c2c30; }
    .row:hover { background: #26262a; }
    .call { background: #26262a; }
    button, input[type=text] { background: #1f1f23; color: #e8e8ea; border-color: #3a3a3f; }
    .balanced { color: #4ade80; }
    .unbalanced { color: #f87171; }
    .warn { background: #3a2e1a; border-color: #6b5220; }
  }
`;

/**
 * The view's own script.
 *
 * `String.raw` so the regexes and escapes read as they will run, and deliberately free of
 * `${`: this template is static, and a single interpolation site would reintroduce the
 * whole class of injection that rendering data client-side removes.
 *
 * Every value from the API reaches the DOM through `textContent` or `dataset`. There is no
 * `innerHTML`, `insertAdjacentHTML`, `document.write`, `eval` or `new Function` here, and
 * the test enforces that by handing this script a DOM whose `innerHTML` throws.
 */
const SCRIPT = String.raw`
(function () {
  var rpcId = 1;
  var data = null;

  function send(method, params) {
    // The host is the MCP client on the other side of this frame; the view speaks
    // JSON-RPC to it over postMessage, per the MCP Apps transport.
    var msg = { jsonrpc: "2.0", method: method };
    if (params) msg.params = params;
    if (method.indexOf("notifications/") === -1) msg.id = rpcId++;
    window.parent.postMessage(msg, "*");
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    // textContent, always. A supplier writes its own invoice description, so this is
    // the boundary where a counterparty's string stops being able to become markup.
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function money(value, currency) {
    var n = typeof value === "number" && isFinite(value) ? value : 0;
    var formatted = n.toLocaleString("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // U+00A0 so the amount cannot wrap away from its currency code.
    return currency ? formatted + " " + currency : formatted;
  }

  function rowNode(kind, item, currency, altCurrency) {
    var label = el("label", "row");
    var box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.kind = kind;
    box.dataset.id = String(item.id);
    // The NUMBER, not the formatted string. Parsing "1 234,50 NOK" back out of the
    // display was one bug waiting to happen per locale.
    box.dataset.amount = String(item.amount);
    box.addEventListener("change", update);
    label.appendChild(box);
    label.appendChild(el("span", "date", item.date));

    var desc = item.description
      ? el("span", "desc", item.description)
      : el("span", "desc muted", "(no description)");
    desc.title = item.description || "";
    label.appendChild(desc);

    label.appendChild(el("span", "meta", kind === "tx"
      ? (item.reference ? "ref " + item.reference : "")
      : (item.voucherNumber || "")));

    var amt = el("span", "amt", money(item.amount, currency));
    if (altCurrency && item.currencyAmount !== null && item.currencyAmount !== undefined) {
      amt.appendChild(el("span", "alt", money(item.currencyAmount, altCurrency)));
    }
    label.appendChild(amt);
    return label;
  }

  function fill(hostId, kind, items, total, currency, altCurrency, emptyText) {
    var host = document.getElementById(hostId);
    host.textContent = "";
    if (!items.length) {
      host.appendChild(el("p", "empty", emptyText));
    } else {
      for (var i = 0; i < items.length; i++) {
        host.appendChild(rowNode(kind, items[i], currency, altCurrency));
      }
    }
    var trimmedEl = document.getElementById(hostId + "-trimmed");
    trimmedEl.textContent = items.length < total
      ? "Showing " + items.length + " of " + total + ". Match these first, or narrow the month — a partial column is not the whole job."
      : "";
  }

  function selection() {
    var boxes = document.querySelectorAll("input[type=checkbox]");
    var tx = [], post = [], txSum = 0, postSum = 0;
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (!b.checked) continue;
      var amount = parseFloat(b.dataset.amount);
      if (!isFinite(amount)) amount = 0;
      if (b.dataset.kind === "tx") { tx.push(Number(b.dataset.id)); txSum += amount; }
      else { post.push(Number(b.dataset.id)); postSum += amount; }
    }
    // Round the SUM to whole øre once. Adding 0.1 + 0.2 in float and comparing to zero
    // reports a discrepancy of 5.55e-17 on a pair that balances exactly.
    return { tx: tx, post: post, diff: Math.round((txSum - postSum) * 100) / 100 };
  }

  function args(sel, account) {
    var out = { bankAccountId: data.bankAccountId, transactionIds: sel.tx, postingIds: sel.post };
    // Carried through so the offered call names the tenant the read used. Without it a
    // caller who passed tenantId explicitly, with no session tenant bound, gets
    // "No tenant selected" from a call this view told them to make.
    if (data.tenantId !== undefined && data.tenantId !== null) out.tenantId = data.tenantId;
    if (account) out.discrepancyAccount = account;
    return out;
  }

  function update() {
    if (!data) return;
    var sel = selection();
    var countEl = document.getElementById("count");
    var diffEl = document.getElementById("diff");
    var callEl = document.getElementById("call");
    var button = document.getElementById("match");
    var accountWrap = document.getElementById("account-wrap");
    var accountEl = document.getElementById("account");

    countEl.textContent = sel.tx.length + " transaction(s), " + sel.post.length + " posting(s) selected";

    // Both arrays are required, so a one-sided selection has no call to show. Offering
    // one would hand over something the tool's own schema rejects.
    var ready = sel.tx.length > 0 && sel.post.length > 0;
    if (!ready) {
      diffEl.textContent = "";
      diffEl.className = "diff";
      accountWrap.hidden = true;
      button.disabled = true;
      callEl.textContent = "Select at least one on each side — a match needs both.";
      return;
    }

    if (!data.comparable) {
      // Cross-currency: the two columns are not in the same unit, so any difference this
      // view printed would be arithmetic on unlike quantities.
      diffEl.textContent = data.bankCurrency + " against " + data.tenantCurrency + " — difference not computed here";
      diffEl.className = "diff unbalanced";
      accountWrap.hidden = true;
      button.disabled = true;
      callEl.textContent = "reai_match_bank_transactions " + JSON.stringify(args(sel, null))
        + "\n\nRun this yourself once you have checked the currency conversion in ReAI. It is not offered as a button because the totals above cannot be compared.";
      return;
    }

    var balanced = sel.diff === 0;
    diffEl.textContent = balanced
      ? "balanced"
      : "difference " + money(sel.diff, data.bankCurrency);
    diffEl.className = "diff " + (balanced ? "balanced" : "unbalanced");
    accountWrap.hidden = balanced;
    var account = balanced ? null : String(accountEl.value || "").trim();
    // A difference has to be booked somewhere, and this view will not invent the account.
    button.disabled = !balanced && !account;
    callEl.textContent = "reai_match_bank_transactions " + JSON.stringify(args(sel, account || null))
      + (balanced ? "" : "\n\nThe difference is booked as a real posting to that account.");
  }

  function render() {
    document.getElementById("title").textContent =
      "Bank reconciliation — " + data.bankAccountName + " " + data.month;
    document.getElementById("subtitle").textContent =
      data.transactionTotal + " unmatched transaction(s), " + data.postingTotal
      + " unmatched posting(s). Pick one side and the other; the difference tells you whether they pair.";

    var lockedEl = document.getElementById("locked");
    lockedEl.hidden = !data.locked;
    if (data.locked) {
      lockedEl.textContent = "This period is closed or locked, so matching will be refused until it is reopened.";
    }

    var currencyEl = document.getElementById("currency-warning");
    currencyEl.hidden = data.comparable;
    if (!data.comparable) {
      currencyEl.textContent = "This bank account is in " + data.bankCurrency + " while the books are in "
        + data.tenantCurrency + ". Postings are shown in both, and no difference is calculated — the two columns are not in the same unit.";
    }

    var alt = data.comparable ? null : data.tenantCurrency;
    fill("tx-rows", "tx", data.transactions, data.transactionTotal, data.bankCurrency, null,
      "Nothing unmatched on the bank side.");
    fill("post-rows", "post", data.postings, data.postingTotal,
      data.comparable ? data.bankCurrency : data.tenantCurrency, alt,
      "Nothing unmatched on the ledger side.");
    update();
  }

  function apply(payload) {
    if (!payload || typeof payload !== "object") return;
    if (!Array.isArray(payload.transactions) || !Array.isArray(payload.postings)) return;
    data = payload;
    render();
  }

  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.method === "ui/notifications/tool-result") {
      var p = msg.params || {};
      // Hosts have been observed to nest the result; accept either shape rather than
      // render nothing because of one level of wrapping.
      apply(p.structuredContent || (p.result && p.result.structuredContent));
    }
  });

  document.getElementById("match").addEventListener("click", function () {
    if (!data || !data.comparable) return;
    var sel = selection();
    if (!sel.tx.length || !sel.post.length) return;
    var accountEl = document.getElementById("account");
    var account = sel.diff === 0 ? null : String(accountEl.value || "").trim();
    if (sel.diff !== 0 && !account) return;
    // The host mediates this and the server re-checks it: matching is classified
    // irreversible, so it is refused unless REAI_WRITE_MODE=full. Pressing the button
    // is a request, not the write itself.
    send("tools/call", { name: "reai_match_bank_transactions", arguments: args(sel, account) });
  });

  document.getElementById("account").addEventListener("input", update);

  send("ui/initialize", { protocolVersion: "2026-01-26" });
})();
`;

/**
 * The view, as a single self-contained document.
 *
 * No external request of any kind — no CDN, font or image. Hosts render this under a
 * strict CSP so anything fetched would fail silently, and an accounting view should not
 * phone anywhere regardless.
 *
 * Takes no arguments: see the note at the top of this file.
 */
export function renderTemplate(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bank reconciliation</title>
<style>${STYLE}</style>
</head>
<body>
<h2 id="title">Bank reconciliation</h2>
<p class="sub" id="subtitle">Waiting for this month's figures…</p>
<p class="warn" id="locked" hidden></p>
<p class="warn" id="currency-warning" hidden></p>

<div class="cols">
  <div class="col">
    <h3>Bank transactions</h3>
    <div class="rows" id="tx-rows"></div>
    <p class="trimmed" id="tx-rows-trimmed"></p>
  </div>
  <div class="col">
    <h3>Ledger postings</h3>
    <div class="rows" id="post-rows"></div>
    <p class="trimmed" id="post-rows-trimmed"></p>
  </div>
</div>

<div class="bar">
  <span id="count">0 transaction(s), 0 posting(s) selected</span>
  <span class="diff" id="diff"></span>
  <span id="account-wrap" hidden>
    <label for="account">Book the difference to</label>
    <input type="text" id="account" placeholder="account" inputmode="numeric">
  </span>
  <button id="match" disabled>Match these</button>
</div>

<p class="call" id="call">Select at least one on each side — a match needs both.</p>
<p class="note">Selecting posts nothing. Matching is an irreversible write: it runs only when you
ask for it, and only if this server is configured to allow one.</p>

<script>${SCRIPT}</script>
</body>
</html>`;
}
