#!/usr/bin/env node
/**
 * Exercises the IRREVERSIBLE write paths against a live tenant.
 *
 * Usage:
 *   REAI_USER_API_TOKEN=... node scripts/smoke-full-write.mjs \
 *     --tenant 1234 --i-understand-this-posts-to-real-books
 *
 * This is different in kind from smoke-write.mjs, which only touches master data
 * that can be deleted. This one POSTS TO THE GENERAL LEDGER of a real company.
 * Norwegian bookkeeping law does not permit deleting a voucher once its period is
 * closed, so everything here:
 *
 *   - runs with REAI_ALLOW_EXTERNAL_SEND deliberately UNSET, and asserts that
 *     nothing can be transmitted BEFORE writing anything at all;
 *   - stamps every record it creates with a recognisable description;
 *   - deletes what it created, in a `finally`, and verifies the deletion;
 *   - refuses to run without both flags, and reports what it could not clean up
 *     loudly enough that a human will act on it.
 *
 * It deliberately does NOT test: issuing invoices or credit notes (they transmit
 * to the customer and cannot be deleted), supplier invoices (DELETE reverses
 * rather than removes, leaving a permanent pair of entries in real books),
 * payments, payroll, or VAT settlement (which locks a period). Those are listed
 * at the end as untested, because claiming otherwise would be worse than the gap.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const token = process.env.REAI_USER_API_TOKEN ?? process.env.REAI_TOKEN;
const tenantId = arg("tenant") ? Number(arg("tenant")) : undefined;
const acknowledged = process.argv.includes("--i-understand-this-posts-to-real-books");

if (!token) {
  console.error("REAI_USER_API_TOKEN is not set.");
  process.exit(2);
}
if (!tenantId) {
  console.error("--tenant <id> is required, so this cannot post to the wrong company.");
  process.exit(2);
}
if (!acknowledged) {
  console.error(
    "Refusing to run without --i-understand-this-posts-to-real-books.\n" +
      "This posts to the general ledger of a real company. There is no ReAI sandbox.",
  );
  process.exit(2);
}

// --- Write-tenant allowlist -------------------------------------------------
// A tenant id alone is not consent. This script must never be able to write to a
// real business just because someone passed its id, so the tenant has to be
// declared a test tenant OUT OF BAND, in the environment, before any write.
//
// Added after a full-write run went against a live company: the intended test
// tenant was unreachable, and "--tenant <the other one>" was all it took.
const declaredTestTenants = (process.env.REAI_WRITE_TEST_TENANTS ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

if (declaredTestTenants.length === 0) {
  console.error(
    "REAI_WRITE_TEST_TENANTS is not set.\n\n" +
      "This script writes to a live ReAI tenant, so it will only run against a tenant that has\n" +
      "been explicitly declared safe to write to:\n\n" +
      "  REAI_WRITE_TEST_TENANTS=2783 node " + process.argv[1].split("/").pop() + " --tenant 2783 ...\n\n" +
      "Do not list a tenant that holds a real business's books.",
  );
  process.exit(2);
}
if (!declaredTestTenants.includes(String(tenantId))) {
  console.error(
    `Refusing to write to tenant ${tenantId}: it is not in REAI_WRITE_TEST_TENANTS ` +
      `(${declaredTestTenants.join(", ")}).\n\n` +
      `If ${tenantId} really is a test tenant, add it there deliberately. If it belongs to a real\n` +
      `business, this refusal is the point.`,
  );
  process.exit(2);
}

let passed = 0;
let failed = 0;
function report(name, okFlag, detail) {
  if (okFlag) passed++;
  else failed++;
  console.log(`  [${okFlag ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const textOf = (r) =>
  (r.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

function jsonOf(result) {
  const text = textOf(result);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

const STAMP = `reai-mcp fullwrite ${new Date().toISOString().replace(/[:.]/g, "-")}`;

/** First non-blank line of a tool's text, which is where ok() puts the note. */
const firstLineOf = (text) => (text.split("\n").find((l) => l.trim()) ?? "").slice(0, 130);

/**
 * The ARRAY a list tool returned, or undefined.
 *
 * jsonOf takes the first `{` to the last `}`, which cannot read a list — on a voucher list
 * it silently produced garbage and a count of `undefined`. Parsing the body rather than the
 * note is deliberate: the note is prose, and a count read out of prose would pass whatever
 * the tool claimed instead of whatever it returned. Blocks are tried from the end because
 * ok() puts the note first and the body last.
 */
function listOf(result) {
  const blocks = textOf(result).split("\n\n");
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i].trim();
    if (!block.startsWith("[")) continue;
    try {
      const parsed = JSON.parse(block);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Truncated or not JSON — keep looking rather than reporting a count of zero.
    }
  }
  return undefined;
}
const today = new Date().toISOString().slice(0, 10);

async function main() {
  const client = new Client({ name: "reai-mcp-full-write", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repo, "dist", "index.js")],
    env: {
      ...process.env,
      REAI_USER_API_TOKEN: token,
      REAI_TENANT_ID: String(tenantId),
      REAI_WRITE_MODE: "full",
      // The client no longer retries non-idempotent writes after an ambiguous
      // failure, but this run posts to real books, so it opts out of retries
      // entirely rather than relying on that classification being right.
      REAI_MAX_RETRIES: "0",
      // Left unset on purpose. The point of this run is to prove that ledger
      // writes and external sending are genuinely independent.
      REAI_ALLOW_EXTERNAL_SEND: "",
    },
    stderr: "pipe",
  });

  await client.connect(transport);
  const tools = new Set((await client.listTools()).tools.map((t) => t.name));
  console.log(`\nFull-write run against tenant ${tenantId} (write mode: full, external send: OFF)`);
  console.log(`Stamp: ${STAMP}\n`);

  const created = {
    warehouseId: undefined,
    productId: undefined,
    variantId: undefined,
    voucherId: undefined,
    bankId: undefined,
    supplierPaymentId: undefined,
    ruleId: undefined,
    supplierInvoiceId: undefined,
    supplierId: undefined,
  };

  try {
    // --- 1. Safety first, before anything is written --------------------------
    console.log("  Safety assertions (before any write):");
    report(
      "invoice issuance is hidden — it would transmit",
      !tools.has("reai_create_invoice_from_order"),
      tools.has("reai_create_invoice_from_order") ? "VISIBLE — abort" : "hidden",
    );
    report(
      "crediting an invoice is hidden — it would transmit",
      !tools.has("reai_credit_invoice"),
      tools.has("reai_credit_invoice") ? "VISIBLE — abort" : "hidden",
    );
    report(
      "ledger tools ARE available (full mode really is on)",
      tools.has("reai_create_voucher") && tools.has("reai_delete_voucher"),
      `${tools.size} tools`,
    );

    for (const [label, args] of [
      ["POST /api/invoices/{id}/ehf", { method: "POST", path: "/api/invoices/1/ehf", body: {} }],
      ["POST /api/invoices/{id}/email", { method: "POST", path: "/api/invoices/1/email", body: { email: "x@example.invalid" } }],
      ["POST /api/orders with sendEhf", { method: "POST", path: "/api/orders", body: { customerId: 1, sendEhf: true, orderLines: [] } }],
      ["POST /api/peppol/messages/sendsbdh", { method: "POST", path: "/api/peppol/messages/sendsbdh", body: {} }],
      ["POST /api/tax-returns/2026/submit", { method: "POST", path: "/api/tax-returns/2026/submit", body: {} }],
    ]) {
      const res = await client.callTool({ name: "reai_request", arguments: { ...args, tenantId } });
      const blocked = res.isError === true && /REAI_ALLOW_EXTERNAL_SEND/.test(textOf(res));
      report(`external send refused: ${label}`, blocked, blocked ? "refused" : textOf(res).slice(0, 120));
    }

    if (failed > 0) {
      throw new Error("safety assertions failed — refusing to write anything");
    }

    // --- 2. Local validation still guards the ledger --------------------------
    console.log("\n  Local validation:");
    const unbalanced = await client.callTool({
      name: "reai_create_voucher",
      arguments: {
        date: today,
        description: `${STAMP} SHOULD NOT EXIST`,
        postings: [
          { accountNumber: "1576", amount: 100 },
          { accountNumber: "1580", amount: -99 },
        ],
      },
    });
    report(
      "an unbalanced voucher is refused before it is sent",
      unbalanced.isError === true && /not balanced/i.test(textOf(unbalanced)),
      (textOf(unbalanced).split("\n")[0] ?? "").slice(0, 100),
    );

    // --- 3. The voucher round-trip: the actual bookkeeping core ---------------
    console.log("\n  Voucher round-trip (posts to the general ledger):");
    const createRes = await client.callTool({
      name: "reai_create_voucher",
      arguments: {
        date: today,
        description: `${STAMP} — automated test, safe to delete`,
        postings: [
          { accountNumber: "1576", amount: 1, description: `${STAMP} debit` },
          { accountNumber: "1580", amount: -1, description: `${STAMP} credit` },
        ],
      },
    });
    const voucher = createRes.isError ? undefined : jsonOf(createRes);
    if (Number.isInteger(voucher?.id)) created.voucherId = voucher.id;
    report(
      "reai_create_voucher posts a balanced voucher",
      !createRes.isError && Number.isInteger(created.voucherId),
      created.voucherId ? `id=${created.voucherId} number=${voucher?.number ?? "?"}` : textOf(createRes).slice(0, 240),
    );
    if (!created.voucherId && !createRes.isError) {
      report(
        "voucher id could be parsed",
        false,
        `A VOUCHER WAS POSTED to tenant ${tenantId} but its id could not be read. Find and delete ` +
          `it by hand — description starts "${STAMP}".`,
      );
    }

    if (created.voucherId) {
      const getRes = await client.callTool({
        name: "reai_get_voucher",
        arguments: { id: created.voucherId },
      });
      report(
        "the voucher reads back with both postings",
        !getRes.isError && textOf(getRes).includes(STAMP),
        !getRes.isError ? "found" : textOf(getRes).slice(0, 160),
      );

      const postingsRes = await client.callTool({
        name: "reai_list_postings",
        arguments: { voucherId: created.voucherId },
      });
      const pText = textOf(postingsRes);
      const signsCorrect = /"amount":\s*1(\.0+)?\b/.test(pText) && /"amount":\s*-1(\.0+)?\b/.test(pText);
      report(
        "the sign convention landed as documented (+1 debit, -1 credit)",
        signsCorrect,
        signsCorrect ? "confirmed against the ledger" : pText.slice(0, 200),
      );
      report(
        "the new postings report canDelete",
        /"canDelete":\s*true/.test(pText),
        /"canDelete":\s*true/.test(pText) ? "deletable" : "NOT deletable — manual cleanup needed",
      );
    }

    // --- 4. Other irreversible-classified writes that clean up fully ---------
    console.log("\n  Other writes classified irreversible:");
    const bankRes = await client.callTool({
      name: "reai_create_company_bank",
      arguments: { name: `${STAMP}`, countryCode: "NO", currency: "NOK", bban: "15201353103" },
    });
    const bank = bankRes.isError ? undefined : jsonOf(bankRes);
    if (Number.isInteger(bank?.id)) created.bankId = bank.id;
    report(
      "reai_create_company_bank",
      !bankRes.isError && Number.isInteger(created.bankId),
      created.bankId ? `id=${created.bankId}` : textOf(bankRes).slice(0, 200),
    );

    // --- 4a. The stock adjustment --------------------------------------------
    //
    // Irreversible for a reason no other tool here shares: nothing lists or deletes a stock
    // transaction, so the only correction is an opposite adjustment. Both the refusal and
    // the round-trip are exercised, and the ledger is checked either side — an adjustment
    // posts no voucher, which is the claim the tool makes.
    console.log("\n  Stock adjustment (posts NO voucher — that is what is being verified):");
    const whRes = await client.callTool({
      name: "reai_create_warehouse",
      arguments: { name: `${STAMP} lager` },
    });
    if (!whRes.isError) {
      const wh = jsonOf(whRes);
      if (Number.isInteger(wh?.id)) created.warehouseId = wh.id;
    }
    report("a warehouse to adjust exists", Number.isInteger(created.warehouseId), `id=${created.warehouseId}`);

    // A stock product needs at least one variant, and reai_create_product does not expose
    // variants — so this goes through the escape hatch, which is also what the quirk says.
    if (created.warehouseId) {
      const prodRes = await client.callTool({
        name: "reai_request",
        arguments: {
          method: "POST",
          path: "/api/products",
          body: {
            title: `${STAMP} stock item`,
            stockItem: true,
            variants: [{ sku: `SMOKE-${Date.now()}`, sellingPrice: 200, costPrice: 100 }],
          },
        },
      });
      const prod = prodRes.isError ? undefined : jsonOf(prodRes);
      if (Number.isInteger(prod?.id)) created.productId = prod.id;
      report(
        "a stock product with a variant exists",
        Number.isInteger(created.productId),
        created.productId ? `id=${created.productId}` : textOf(prodRes).slice(0, 200),
      );
    }

    if (created.productId && created.warehouseId) {
      // The variant id is on the stock line, and it is keyed `variantId`, not `id`.
      const invRes = await client.callTool({
        name: "reai_get_warehouse_inventory",
        arguments: { warehouseId: created.warehouseId },
      });
      const row = invRes.isError ? undefined : jsonOf(invRes)?.rows?.find((r) => r.productId === created.productId);
      created.variantId = row?.variantId ?? undefined;
      report(
        "the new product appears as a stock line at zero",
        Number.isInteger(created.variantId) && row?.quantityOnHand === 0,
        row ? `variantId=${created.variantId} qty=${row.quantityOnHand}` : textOf(invRes).slice(0, 200),
      );

      // The refusal. Without a variantId the API would answer 200 and move nothing, so the
      // tool must not send it — and must not have written anything when it declines.
      const refused = await client.callTool({
        name: "reai_adjust_inventory",
        arguments: { productId: created.productId, warehouseId: created.warehouseId, quantityChange: 3 },
      });
      report(
        "an adjustment with no variantId is refused, not silently dropped",
        refused.isError === true && /Nothing was written/.test(textOf(refused)),
        firstLineOf(textOf(refused)),
      );
      const afterRefusal = await client.callTool({
        name: "reai_get_warehouse_inventory",
        arguments: { warehouseId: created.warehouseId },
      });
      const stillZero =
        !afterRefusal.isError &&
        jsonOf(afterRefusal)?.rows?.find((r) => r.productId === created.productId)?.quantityOnHand === 0;
      report("the refused adjustment moved no stock", stillZero, stillZero ? "still 0 on hand" : "STOCK MOVED");

      // A bare date is refused by the API itself; the tool completes it. If this passes,
      // the yyyy-MM-dd form reached the API as a timestamp.
      const vouchersBefore = await client.callTool({
        name: "reai_list_vouchers",
        arguments: { startDate: "2000-01-01", endDate: "2030-12-31" },
      });
      const countBefore = vouchersBefore.isError ? undefined : listOf(vouchersBefore)?.length;

      const upRes = await client.callTool({
        name: "reai_adjust_inventory",
        arguments: {
          productId: created.productId,
          warehouseId: created.warehouseId,
          variantId: created.variantId,
          quantityChange: 4,
          unitCost: 100,
          occurredAt: "2026-08-01",
        },
      });
      const up = upRes.isError ? undefined : jsonOf(upRes);
      report(
        "reai_adjust_inventory +4 with a yyyy-MM-dd occurredAt",
        !upRes.isError && up?.quantityOnHand === 4,
        upRes.isError ? textOf(upRes).slice(0, 220) : `onHand=${up?.quantityOnHand} occurredAt=${up?.occurredAt}`,
      );
      report(
        "the date was completed to a timestamp the API accepted",
        typeof up?.occurredAt === "string" && up.occurredAt.startsWith("2026-08-01T"),
        String(up?.occurredAt),
      );
      report(
        "the tool did not warn, because the stock actually moved",
        !upRes.isError && !/WARNING: stock did NOT move/.test(textOf(upRes)),
        firstLineOf(textOf(upRes)),
      );

      const vouchersAfter = await client.callTool({
        name: "reai_list_vouchers",
        arguments: { startDate: "2000-01-01", endDate: "2030-12-31" },
      });
      const countAfter = vouchersAfter.isError ? undefined : listOf(vouchersAfter)?.length;
      report(
        "the adjustment posted NO voucher",
        Number.isInteger(countBefore) && Number.isInteger(countAfter) && countBefore === countAfter,
        Number.isInteger(countBefore) && Number.isInteger(countAfter)
          ? `${countBefore} → ${countAfter}`
          : `COULD NOT COUNT VOUCHERS (${countBefore} → ${countAfter}) — this proves nothing`,
      );

      // Restore to zero, which is also the only correction this API offers.
      const downRes = await client.callTool({
        name: "reai_adjust_inventory",
        arguments: {
          productId: created.productId,
          warehouseId: created.warehouseId,
          variantId: created.variantId,
          quantityChange: -4,
          unitCost: 100,
        },
      });
      const down = downRes.isError ? undefined : jsonOf(downRes);
      report(
        "an opposite adjustment brings it back to zero",
        !downRes.isError && down?.quantityOnHand === 0,
        downRes.isError ? textOf(downRes).slice(0, 200) : `onHand=${down?.quantityOnHand}`,
      );
    }

    // --- 4b. The supplier-invoice chain --------------------------------------
    //
    // A supplier invoice is an INCOMING document, so registering one transmits
    // nothing — which is what makes it testable when issuing a customer invoice
    // is not. It posts to the ledger and to the supplier's reskontro, and its
    // cost lines deliberately do NOT follow the voucher sign convention, so this
    // is the only place that difference is exercised against live books.
    console.log("\n  Supplier-invoice chain (posts to the ledger and the reskontro):");
    const supRes = await client.callTool({
      name: "reai_create_supplier",
      arguments: { name: `${STAMP} supplier`, privateContact: true, skipRegistryLookup: true },
    });
    const supplier = supRes.isError ? undefined : jsonOf(supRes);
    if (Number.isInteger(supplier?.id)) created.supplierId = supplier.id;
    report("a supplier is created", !supRes.isError && Number.isInteger(created.supplierId), `id=${created.supplierId}`);

    const acctRes = await client.callTool({ name: "reai_list_accounts", arguments: { accountNumberPrefix: "67" } });
    const costAccount = /"accountNumber":\s*"(\d+)"/.exec(textOf(acctRes))?.[1];
    report("a cost account is available to book against", Boolean(costAccount), `account=${costAccount}`);

    if (created.supplierId && costAccount) {
      // The sign rule differs from a voucher's, so a negative amount on an
      // invoice is a caller mistake and must be caught before it is sent.
      const wrongSign = await client.callTool({
        name: "reai_create_supplier_invoice",
        arguments: {
          supplierId: created.supplierId,
          date: today,
          dueDate: today,
          costLines: [{ amount: -100, debitAccount: costAccount, description: STAMP }],
        },
      });
      report(
        "a negative cost line on an invoice is refused locally",
        wrongSign.isError === true && /documentType/i.test(textOf(wrongSign)),
        (textOf(wrongSign).split("\n")[0] ?? "").slice(0, 100),
      );

      const invRes = await client.callTool({
        name: "reai_create_supplier_invoice",
        arguments: {
          supplierId: created.supplierId,
          date: today,
          dueDate: today,
          number: `${STAMP}`.slice(0, 30),
          costLines: [{ amount: 125, debitAccount: costAccount, description: `${STAMP} cost` }],
        },
      });
      const invoice = invRes.isError ? undefined : jsonOf(invRes);
      if (Number.isInteger(invoice?.id)) created.supplierInvoiceId = invoice.id;
      report(
        "a supplier invoice is registered and posted",
        !invRes.isError && Number.isInteger(created.supplierInvoiceId),
        created.supplierInvoiceId ? `id=${created.supplierInvoiceId}` : textOf(invRes).slice(0, 200),
      );

      if (created.supplierInvoiceId) {
        const ledgerRes = await client.callTool({ name: "reai_supplier_ledger", arguments: { isUnpaid: true } });
        report(
          "it appears in the supplier ledger as unpaid",
          !ledgerRes.isError && textOf(ledgerRes).includes(String(created.supplierId)),
          (textOf(ledgerRes).split("\n")[0] ?? "").slice(0, 80),
        );

        // The payment tool must not be usable without saying which flow it is:
        // omitting manualPayment once meant the API default selected the
        // bank-integrated flow, which can begin a real BankID transfer.
        const noMode = await client.callTool({
          name: "reai_register_supplier_invoice_payment",
          arguments: { id: created.supplierInvoiceId, paymentDate: today, invoiceAmount: 125 },
        });
        report(
          "a payment without an explicit manualPayment is rejected",
          noMode.isError === true,
          (textOf(noMode).split("\n")[0] ?? "").slice(0, 100),
        );

        // Actually register one. This was on the untested list because the tool can
        // start a real bank transfer — but only via manualPayment=false, which selects
        // the integration flow. With manualPayment=true the spec says the payment is
        // "handled manually", and that is verified rather than assumed below: the
        // response must carry no approvalUrl, since an approvalUrl is precisely the
        // signal that ReAI has asked a human to authorise a transfer.
        if (created.bankId) {
          const payRes = await client.callTool({
            name: "reai_register_supplier_invoice_payment",
            arguments: {
              id: created.supplierInvoiceId,
              paymentDate: today,
              invoiceAmount: 125,
              manualPayment: true,
              companyBankId: created.bankId,
              bankDebitAmount: 125,
            },
          });
          const payData = payRes.isError ? undefined : jsonOf(payRes);
          const payText = textOf(payRes);
          report(
            "a manual supplier payment is registered",
            !payRes.isError && Number.isInteger(payData?.paymentId),
            payData?.paymentId ? `paymentId=${payData.paymentId} status=${payData.status}` : payText.slice(0, 160),
          );
          // The whole reason this path was left untested. An approvalUrl here would mean
          // a transfer is waiting on a human, which is not something a smoke test may do.
          report(
            "no bank approval was started (manualPayment=true instructs no bank)",
            !payRes.isError && !payData?.approvalUrl,
            payData?.approvalUrl ? `approvalUrl PRESENT: ${payData.approvalUrl}` : "approvalUrl is null",
          );
          report(
            "the tool reports the status the API returned",
            payText.includes(String(payData?.status ?? "")),
            (payText.split("\n")[0] ?? "").slice(0, 120),
          );
          if (Number.isInteger(payData?.paymentId)) {
            created.supplierPaymentId = payData.paymentId;
          }
        }
      }
    }

    const ruleRes = await client.callTool({
      name: "reai_create_reconciliation_rule",
      arguments: { matchText: `SMOKE-${Date.now()}`, accountNumber: "7710", description: `${STAMP} rule` },
    });
    const rule = ruleRes.isError ? undefined : jsonOf(ruleRes);
    if (Number.isInteger(rule?.id)) created.ruleId = rule.id;
    report(
      "reai_create_reconciliation_rule",
      !ruleRes.isError && Number.isInteger(created.ruleId),
      created.ruleId ? `id=${created.ruleId}` : textOf(ruleRes).slice(0, 200),
    );
  } finally {
    // --- 5. Clean up, most dependent first -----------------------------------
    //
    // Every deletion is isolated. A single `await` that rejects here — a
    // transport hiccup, a timeout — would otherwise abandon the rest of the
    // block, and the voucher is cleaned up last, so one failed request could
    // leave a test entry sitting in someone's real ledger. A failure has to be
    // reported and stepped over, not allowed to propagate.
    console.log("\n  Cleanup:");

    const attempt = async (label, call, describe) => {
      try {
        const r = await call();
        report(label, !r.isError, describe(r));
        return r;
      } catch (err) {
        report(label, false, `CLEANUP REQUEST THREW — ${err?.message ?? err}`);
        return undefined;
      }
    };

    // The product before the warehouse: deleting a record whose dependents are still
    // around answers 500 "Referenced record is not accessible", which is how a previous
    // run stranded four orders. Dependency order, cheapest first.
    if (created.productId) {
      await attempt(
        "stock product deleted",
        () => client.callTool({ name: "reai_delete_product", arguments: { id: created.productId } }),
        (r) => textOf(r).slice(0, 90),
      );
    }
    if (created.warehouseId) {
      const r = await attempt(
        "warehouse deleted",
        () => client.callTool({ name: "reai_delete_warehouse", arguments: { warehouseId: created.warehouseId } }),
        (res) => firstLineOf(textOf(res)),
      );
      // "archived" here would mean stock was left on hand — the adjustment did not net to
      // zero — and an archived warehouse is invisible in the default list. Say so loudly.
      const outcome = r && !r.isError ? jsonOf(r)?.outcome : undefined;
      report(
        "the warehouse was deleted, not archived",
        outcome === "deleted",
        outcome === "archived"
          ? `ARCHIVED — stock was left on hand; warehouse ${created.warehouseId} needs manual cleanup`
          : `outcome=${outcome}`,
      );
    }
    if (created.ruleId) {
      await attempt(
        "reconciliation rule deleted",
        () => client.callTool({ name: "reai_delete_reconciliation_rule", arguments: { id: created.ruleId } }),
        (r) => textOf(r).slice(0, 90),
      );
    }
    if (created.supplierPaymentId && created.supplierInvoiceId) {
      await attempt(
        "supplier payment deleted",
        () =>
          client.callTool({
            name: "reai_request",
            arguments: {
              method: "DELETE",
              path: `/api/supplier-invoices/${created.supplierInvoiceId}/payments/${created.supplierPaymentId}`,
            },
          }),
        (r) => textOf(r).slice(0, 90),
      );
    }
    if (created.supplierInvoiceId) {
      await attempt(
        "supplier invoice reversed",
        () =>
          client.callTool({
            name: "reai_request",
            arguments: { method: "DELETE", path: `/api/supplier-invoices/${created.supplierInvoiceId}`, tenantId },
          }),
        (r) =>
          r.isError
            ? `REVERSAL FAILED — check supplier invoice ${created.supplierInvoiceId} by hand: ${textOf(r).slice(0, 120)}`
            : textOf(r).slice(0, 90),
      );
    }
    if (created.supplierId) {
      await attempt(
        "supplier deleted or archived",
        () => client.callTool({ name: "reai_delete_supplier", arguments: { id: created.supplierId } }),
        (r) => textOf(r).slice(0, 90),
      );
    }
    if (created.bankId) {
      await attempt(
        "company bank deleted or archived",
        () =>
          client.callTool({
            name: "reai_request",
            arguments: { method: "DELETE", path: `/api/company-banks/${created.bankId}`, tenantId },
          }),
        (r) => textOf(r).slice(0, 90),
      );
    }
    if (created.voucherId) {
      await attempt(
        "THE VOUCHER IS DELETED",
        () => client.callTool({ name: "reai_delete_voucher", arguments: { id: created.voucherId } }),
        (r) =>
          r.isError
            ? `DELETE FAILED — remove voucher ${created.voucherId} by hand: ${textOf(r).slice(0, 140)}`
            : textOf(r).slice(0, 90),
      );

      // Only a 404 proves the voucher is gone. Treating any error as proof made
      // an auth failure, a 500 or an exhausted retry print "verified" while the
      // voucher was never actually checked — the one report in this script that
      // must never be optimistic.
      try {
        const after = await client.callTool({ name: "reai_get_voucher", arguments: { id: created.voucherId } });
        const body = textOf(after);
        const notFound = after.isError === true && /\b404\b|not found/i.test(body);
        const stillThere = after.isError !== true;
        report(
          "the voucher is gone from the ledger (confirmed by a 404)",
          notFound,
          notFound
            ? "verified"
            : stillThere
              ? `STILL PRESENT — delete voucher ${created.voucherId} by hand`
              : `INCONCLUSIVE, not a 404 — verify voucher ${created.voucherId} by hand: ${body.slice(0, 140)}`,
        );
      } catch (err) {
        report(
          "the voucher is gone from the ledger (confirmed by a 404)",
          false,
          `COULD NOT VERIFY — check voucher ${created.voucherId} by hand: ${err?.message ?? err}`,
        );
      }
    }

    // A last sweep by stamp, independent of the ids we think we hold. If a
    // create was committed but its response never arrived, no id was recorded
    // and none of the cleanup above would have touched it.
    try {
      const sweep = await client.callTool({
        name: "reai_list_vouchers",
        arguments: { startDate: today, endDate: today },
      });
      const leftovers = [...textOf(sweep).matchAll(/"id":\s*(\d+)[^}]*?"description":\s*"([^"]*)"/g)]
        .filter(([, , description]) => description.includes(STAMP))
        .map(([, id]) => Number(id))
        .filter((id) => id !== created.voucherId);
      report(
        "no stray vouchers carrying this run's stamp remain",
        leftovers.length === 0,
        leftovers.length === 0 ? "none" : `LEFTOVER VOUCHERS ${leftovers.join(", ")} — delete by hand`,
      );
    } catch (err) {
      report("no stray vouchers carrying this run's stamp remain", false, `sweep failed: ${err?.message ?? err}`);
    }

    await client.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(
    "\nDeliberately NOT tested:\n" +
      "  - issuing an invoice or credit note — TRANSMITS to the customer and cannot be\n" +
      "    recalled. Not a reversibility question, and no flag in this script enables it.\n" +
      "  - registering a CUSTOMER or SALARY payment — a customer payment needs an issued\n" +
      "    invoice, which transmits, and a salary run pays a person. A manual SUPPLIER\n" +
      "    payment IS registered above: manualPayment=true is handled manually rather than\n" +
      "    through the bank integration, and the absence of an approvalUrl is asserted\n" +
      "    rather than assumed, since that is the signal a transfer awaits a human.\n" +
      "  - settling a VAT period — locks the books for it, and reopening is a privileged\n" +
      "    operation, so a test would leave a real company's period in a changed state.\n" +
      "  - tax return submission — files with Skatteetaten, with no idempotency guard.",
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nFull-write run crashed:", err);
  process.exit(1);
});
