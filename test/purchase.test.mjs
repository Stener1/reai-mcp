import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { purchaseTools } from "../dist/tools/purchase.js";

/**
 * Purchase-side tools whose notes make a claim about what the API stored.
 *
 * This file exists because there was no purchase test file at all, and a tool needed one: the
 * behavioural sweep in test/confirm-against-response.test.mjs cannot judge `documentType`, because its
 * value is a word and the note prints a LABEL derived from it — "invoice" for anything that is not
 * `credit_note` — so an echo and a read-back produce the same sentence.
 */
const tool = (name) => {
  const found = purchaseTools.find((t) => t.name === name);
  assert.ok(found, `${name} is not registered`);
  return found;
};

async function run(name, args, data) {
  const calls = [];
  const validated = z.object(tool(name).inputSchema).parse({ tenantId: 2783, ...args });
  const result = await tool(name).handler(validated, {
    client: {
      request: async (req) => {
        calls.push(req);
        return { data, status: 200 };
      },
      deepLink: () => "link",
    },
    config: { writeMode: "full", tenantId: 2783, allowExternalSend: false },
    session: {},
  });
  return { calls, result, text: result.content.find((c) => c.type === "text").text };
}

/** A supplier invoice body the tool accepts, so the tests below differ only in what the response says. */
const INVOICE = {
  supplierId: 42,
  documentType: "invoice",
  number: "ZZ-1",
  date: "2026-08-09",
  dueDate: "2026-09-09",
  currency: "NOK",
  costLines: [{ accountNumber: "6800", amount: 1000, vatCode: "0" }],
};

test("a supplier document stored as the other kind is named from the record", async () => {
  // reai_create_supplier_invoice: the note named the kind from `args.documentType`. The two kinds are OPPOSITE
  // SIGNS in the ledger, so calling a stored credit note an "invoice" describes a debit where the books hold a
  // credit — and this tool is declared irreversible, with its own next sentence saying the document cannot be
  // deleted outright.
  const { text } = await run("reai_create_supplier_invoice", INVOICE, {
    id: 7,
    documentType: "credit_note",
  });
  assert.match(text, /Supplier credit note registered, read back from the response/);
  assert.match(text, /NOT the invoice this call sent, which is the opposite sign in the ledger/);
});

test("a supplier document the response does not classify is marked as SENT", async () => {
  // The negative branch: a response that does not say which kind it stored must not be reported as agreeing.
  const { text } = await run("reai_create_supplier_invoice", INVOICE, { id: 7 });
  assert.match(text, /Supplier invoice registered as SENT — the response does not say which kind it stored/);
  assert.doesNotMatch(text, /read back from the response/);
});

test("a supplier document stored as the kind it was sent reports no discrepancy", async () => {
  // The positive control: a warning on every call would pass both tests above while making the tool worse.
  const { text } = await run("reai_create_supplier_invoice", INVOICE, { id: 7, documentType: "invoice" });
  assert.match(text, /Supplier invoice registered, read back from the response/);
  assert.doesNotMatch(text, /NOT the/);
  assert.match(text, /it cannot be deleted outright/, "the standing caveat survives the rewrite");
});

test("omitting documentType does not raise a false opposite-sign alarm", async () => {
  // reai_create_supplier_invoice: `documentType` is OPTIONAL and defaults to "invoice" — the request body
  // already writes `args.documentType ?? "invoice"`. Comparing the stored kind against `args.documentType`
  // reported "NOT the invoice this call sent" on every call that omitted the field and got exactly what it
  // asked for. A false alarm about the SIGN of a ledger posting, on an irreversible tool.
  const { documentType, ...withoutKind } = INVOICE;
  const { text } = await run("reai_create_supplier_invoice", withoutKind, {
    id: 7,
    documentType: "invoice",
  });
  assert.match(text, /Supplier invoice registered, read back from the response/);
  assert.doesNotMatch(text, /NOT the/, `omitting the field is asking for an invoice: ${text}`);
  assert.doesNotMatch(text, /opposite sign/);
});

test("a stored kind this tool does not recognise is not called an invoice", async () => {
  // reai_create_supplier_invoice: the label mapped anything that was not literally `credit_note` to "invoice",
  // so a stored "CREDIT_NOTE" — a spelling this API could plausibly return, in a file whose whole premise is
  // that it rewrites what it stores — was reported as an invoice.
  for (const spelling of ["CREDIT_NOTE", "creditNote", "zz_unknown"]) {
    const { text } = await run("reai_create_supplier_invoice", INVOICE, { id: 7, documentType: spelling });
    if (spelling === "zz_unknown") {
      assert.match(text, /a value this tool does not recognise as either an invoice or a credit note/);
      assert.match(text, /Check it before relying on the sign/);
    } else {
      assert.match(text, /Supplier credit note registered, read back from the response/, `${spelling}: ${text}`);
    }
    assert.doesNotMatch(
      text,
      /^Supplier invoice registered, read back/,
      `${spelling} must not be reported as an invoice`,
    );
  }
});
