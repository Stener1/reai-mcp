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

  const created = { voucherId: undefined, bankId: undefined, ruleId: undefined };

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
    console.log("\n  Cleanup:");
    if (created.ruleId) {
      const r = await client.callTool({
        name: "reai_delete_reconciliation_rule",
        arguments: { id: created.ruleId },
      });
      report("reconciliation rule deleted", !r.isError, textOf(r).slice(0, 90));
    }
    if (created.bankId) {
      const r = await client.callTool({
        name: "reai_request",
        arguments: { method: "DELETE", path: `/api/company-banks/${created.bankId}`, tenantId },
      });
      report("company bank deleted or archived", !r.isError, textOf(r).slice(0, 90));
    }
    if (created.voucherId) {
      const r = await client.callTool({ name: "reai_delete_voucher", arguments: { id: created.voucherId } });
      report(
        "THE VOUCHER IS DELETED",
        !r.isError,
        r.isError ? `DELETE FAILED — remove voucher ${created.voucherId} by hand: ${textOf(r).slice(0, 140)}` : textOf(r).slice(0, 90),
      );

      const after = await client.callTool({ name: "reai_get_voucher", arguments: { id: created.voucherId } });
      const gone = after.isError === true;
      report(
        "the voucher is gone from the ledger",
        gone,
        gone ? "verified" : `STILL PRESENT — delete voucher ${created.voucherId} by hand`,
      );
    }
    await client.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(
    "\nDeliberately NOT tested, because they cannot be undone on real books:\n" +
      "  - issuing an invoice or credit note (transmits to the customer, not deletable)\n" +
      "  - registering a supplier invoice (DELETE reverses, leaving a permanent pair)\n" +
      "  - customer/supplier payments, salary payments, VAT settlement (locks a period)\n" +
      "  - tax return submission (files with Skatteetaten, no idempotency guard)",
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nFull-write run crashed:", err);
  process.exit(1);
});
