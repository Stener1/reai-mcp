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

/** An attachment as the live API returns one, measured on 2634: supplier invoice 5830, attachment 19780. */
const ATTACHMENT = {
  id: 19780,
  filename: "faktura_2026_10009.pdf",
  mimeType: "application/pdf",
  createdAt: "2026-08-07T10:21:49.663759Z",
  size: 1784632,
  contentUrl: "/api/supplier-invoices/5830/attachments/19780/content",
  downloadUrl: "/api/supplier-invoices/5830/attachments/19780/content?download=true",
  usedBy: null,
};

test("reai_list_attachments reaches the owner-scoped route for each owner type", async () => {
  // reai_list_attachments: the scoped routes are the ONLY way to discover an attachment id — measured,
  // GET /api/attachments answers 405 because only POST exists on that collection.
  const invoice = await run("reai_list_attachments", { ownerType: "supplierInvoice", ownerId: 5830 }, [ATTACHMENT]);
  assert.equal(invoice.calls[0].path, "/api/supplier-invoices/5830/attachments");
  assert.match(invoice.text, /1 attachment\(s\) on supplier invoice 5830/);

  const order = await run("reai_list_attachments", { ownerType: "order", ownerId: 4105 }, []);
  assert.equal(order.calls[0].path, "/api/orders/4105/attachments");
  assert.match(order.text, /0 attachment\(s\) on order 4105/);
  // An unknown owner 404s naming the OWNER, so empty means "exists, has none" — a different answer.
  assert.match(order.text, /An empty list means the record has none/);
});

test("reai_list_attachments reads usedBy off the rows instead of asserting it", async () => {
  // reai_list_attachments: the first version stated "usedBy is null on every row here" as a FIXED sentence, and
  // review drove a populated row straight through it — a claim generalised from one route and one row, with the
  // `order` branch never measured at all. Three cases, because the sentence has to follow the data.
  const nulled = await run("reai_list_attachments", { ownerType: "supplierInvoice", ownerId: 5830 }, [ATTACHMENT]);
  assert.match(nulled.text, /`usedBy` is null on all 1 row\(s\) here/);
  assert.match(nulled.text, /read an attachment by id with reai_get_attachment/);

  // A populated row must NOT be described as null.
  const populated = await run("reai_list_attachments", { ownerType: "supplierInvoice", ownerId: 5830 }, [
    { ...ATTACHMENT, usedBy: [{ ownerType: "SUPPLIER_INVOICE", ownerId: 5830 }] },
    ATTACHMENT,
  ]);
  assert.match(populated.text, /1 of 2 row\(s\) carry a `usedBy`/);
  assert.doesNotMatch(populated.text, /is null on all/);

  // And a zero-row list must say nothing about rows that do not exist.
  const empty = await run("reai_list_attachments", { ownerType: "order", ownerId: 4105 }, []);
  assert.doesNotMatch(empty.text, /usedBy/, `no rows means no claim about rows: ${empty.text}`);
});

test("reai_get_attachment resolves usedBy into the records that reference the file", async () => {
  // reai_get_attachment: the by-id route fills usedBy in, which is the whole reason this tool exists next to
  // the list. Measured on 19780: [{"ownerType":"SUPPLIER_INVOICE","ownerId":5830}].
  const { text, calls } = await run("reai_get_attachment", { id: 19780 }, {
    ...ATTACHMENT,
    usedBy: [{ ownerType: "SUPPLIER_INVOICE", ownerId: 5830 }],
  });
  assert.equal(calls[0].path, "/api/attachments/19780");
  assert.match(text, /faktura_2026_10009\.pdf, application\/pdf, 1784632 bytes, read back from the response/);
  // A SECOND response, whose filename differs from every literal in this file, so a hardcoded name cannot pass.
  // The first version of this test used only the fixture's own name, and substituting that name as a literal in
  // the handler survived the mutation — the sixth time in this line of work that a fixture equal to the value
  // under test made an assertion unable to tell a read-back from an echo.
  const other = await run("reai_get_attachment", { id: 19780 }, {
    ...ATTACHMENT,
    filename: "kvittering-ZZ-8842.pdf",
    mimeType: "image/png",
    size: 4211,
  });
  assert.match(other.text, /kvittering-ZZ-8842\.pdf, image\/png, 4211 bytes, read back from the response/);
  assert.match(text, /Referenced by 1 record\(s\): SUPPLIER_INVOICE 5830\. Deleting the file affects all of them/);
  // The bytes are deliberately not returned; the note must say where they are.
  assert.match(text, /bytes are not in this response.*\/api\/attachments\/19780\/content/s);
});

test("reai_get_attachment does not read a null usedBy as nothing referencing the file", async () => {
  // reai_get_attachment: null is the API's "not populated" — it is what the scoped list always returns — and
  // reading it as "nothing uses this" is how a file attached to two records gets deleted.
  const nulled = await run("reai_get_attachment", { id: 19780 }, ATTACHMENT);
  assert.match(nulled.text, /`usedBy` came back null, so what references this file is NOT established/);
  assert.match(nulled.text, /not the same as nothing referencing it/);
  assert.doesNotMatch(nulled.text, /nothing references this attachment/);

  // An EMPTY array is a different answer, and it is the one that means nothing references it.
  const empty = await run("reai_get_attachment", { id: 19780 }, { ...ATTACHMENT, usedBy: [] });
  assert.match(empty.text, /`usedBy` is an empty list, so nothing references this attachment/);
  assert.doesNotMatch(empty.text, /NOT established/);
});

test("reai_get_attachment says so when the response is not a record", async () => {
  const { text } = await run("reai_get_attachment", { id: 19780 }, [ATTACHMENT]);
  assert.match(text, /came back as an array of 1, so nothing could be read from it/);
  assert.doesNotMatch(text, /read back from the response/);
});

test("reai_get_attachment distinguishes absent, null, and a non-list usedBy", async () => {
  // reai_get_attachment: review collapsed these and found two false sentences. A non-array went through
  // `asArray` to `[]` and was reported as "an empty list, so nothing references this attachment" — directly
  // above a payload showing the reference, and it is the one sentence this tool exists to be trusted on.
  const { usedBy, ...withoutField } = ATTACHMENT;
  const absent = await run("reai_get_attachment", { id: 19780 }, withoutField);
  assert.match(absent.text, /carries no `usedBy` field at all, so what references this file is NOT established/);

  const notAList = await run("reai_get_attachment", { id: 19780 }, {
    ...ATTACHMENT,
    usedBy: { ownerType: "ORDER", ownerId: 7 },
  });
  assert.match(notAList.text, /came back as an object rather than a list/);
  assert.match(notAList.text, /do not treat this as nothing referencing it/);
  assert.doesNotMatch(notAList.text, /nothing references this attachment/);

  // And when nothing could be read at all, it must not claim usedBy "came back" anything.
  const unreadable = await run("reai_get_attachment", { id: 19780 }, "<!DOCTYPE html>");
  assert.match(unreadable.text, /Nothing could be read, so what references this file is unknown/);
  assert.doesNotMatch(unreadable.text, /came back null/);
});

test("reai_get_attachment sends a VOUCHER owner to the tool that can actually reach it", async () => {
  // reai_get_attachment: measured on 2634 — attachment 18925 is owned by VOUCHER 27967, and there is no
  // /api/vouchers/{id}/attachments route (404 "No static resource"). So reai_list_attachments cannot follow a
  // VOUCHER owner, and saying "Referenced by VOUCHER 27967" without saying that leaves the caller stuck.
  const { text } = await run("reai_get_attachment", { id: 18925 }, {
    id: 18925,
    filename: "kvittering.pdf",
    mimeType: "application/pdf",
    size: 341986,
    usedBy: [{ ownerType: "VOUCHER", ownerId: 27967 }],
  });
  assert.match(text, /Referenced by 1 record\(s\): VOUCHER 27967/);
  assert.match(text, /not reachable with reai_list_attachments/);
  assert.match(text, /Read the voucher with reai_get_voucher; it embeds its attachments/);

  // A supplier-invoice owner must NOT get that pointer.
  const invoice = await run("reai_get_attachment", { id: 19780 }, {
    ...ATTACHMENT,
    usedBy: [{ ownerType: "SUPPLIER_INVOICE", ownerId: 5830 }],
  });
  assert.doesNotMatch(invoice.text, /reai_get_voucher/);
});

test("reai_list_attachments names all three ways to reach an attachment id", async () => {
  // reai_list_attachments: its first version said "this is the ONLY way to discover attachment ids". Two
  // reviews found two other routes, and both matter more than this tool for the cases they cover:
  //
  //   a VOUCHER embeds its attachments — six of seven attachments on the measured tenant were there;
  //   the RECEPTION INBOX carries attachmentId — the case this tool structurally cannot reach, because it
  //   takes an order or a supplier invoice and a document in the inbox is neither yet.
  //
  // Pinned because the claim is about what an agent will not find on its own: a tool that says "only" sends
  // them away from the route that would have worked.
  const description = tool("reai_list_attachments").description;
  assert.match(description, /reai_list_vouchers|reai_get_voucher/, "the voucher route must be named");
  assert.match(description, /reai_list_reception_documents/, "the reception inbox must be named");
  assert.doesNotMatch(description, /ONLY way/, "the claim this text used to make was false");
  // And the reception one must be marked as unmeasured, because both inboxes were empty on the tenant used.
  assert.match(description, /schema rather than\s+"?\s*\+?\s*"?measured/s, "say it is from the schema, not measured");
});

test("the attach workflow says which owner takes a file and which takes a link", async () => {
  // Measured on 2783 on 2026-08-10, all three probes failing so nothing was created:
  //
  //   JSON {attachmentId: 99999999} -> POST /api/orders/4105/attachments
  //     404 "Attachment not found" — it parsed the body and looked the attachment up, so it LINKS
  //   multipart -> the same route
  //     415 "Content-Type 'multipart/form-data' is not supported" — so a file cannot be uploaded there
  //   JSON -> POST /api/supplier-invoices/1/attachments/existing
  //     404 "Supplier invoice 1 not found" — the route exists and validates the owner first
  //
  // The consequence is the point: the two owners wire the same two capabilities to OPPOSITE paths, so an agent
  // that learns one and applies it to the other gets a 415 or a 404 instead of a hint.
  const { quirksFor } = await import("../dist/reai/quirks.js");
  for (const path of ["/api/orders/{id}/attachments", "/api/supplier-invoices/{id}/attachments"]) {
    const found = quirksFor("POST", path).map((q) => q.id);
    assert.ok(
      found.includes("attaching-a-file-differs-by-owner"),
      `${path} should carry the attach-workflow quirk, got ${found.join(", ") || "none"}`,
    );
  }
  // A GET must NOT get it — it is about the POST bodies.
  assert.ok(
    !quirksFor("GET", "/api/orders/{id}/attachments").some((q) => q.id === "attaching-a-file-differs-by-owner"),
    "the attach quirk is about POSTing, not listing",
  );

  const note = quirksFor("POST", "/api/orders/{id}/attachments").find(
    (q) => q.id === "attaching-a-file-differs-by-owner",
  ).note;
  // VERBATIM for the two quoted upstream messages, loose for the rest. A reword of a message the note presents
  // as the API's own words is a drift this repo cares about — the first version asserted only "415", so
  // changing "is not supported" to "is unsupported" survived while the note still claimed to quote ReAI.
  for (const verbatim of ["Content-Type 'multipart/form-data' is not supported", '404 "Attachment not found"']) {
    assert.ok(note.includes(verbatim), `the note should quote ${verbatim} exactly, as measured`);
  }
  for (const measured of ["415", "attachments/existing", "opposite paths"]) {
    assert.ok(note.includes(measured), `the note should carry the measured ${measured}`);
  }

  // And the tool an agent is holding when it wants to attach something must point at all this.
  const description = tool("reai_list_attachments").description;
  assert.match(description, /An ORDER only LINKS/);
  assert.match(description, /answers 415/);
  assert.match(description, /attachments\/existing/);
});
