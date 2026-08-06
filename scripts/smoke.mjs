#!/usr/bin/env node
/**
 * End-to-end smoke test: launches the built server over stdio as a real MCP
 * client, then exercises read-only tools against the live ReAI API.
 *
 * Usage:
 *   REAI_USER_API_TOKEN=... node scripts/smoke.mjs [--tenant 1234] [--verbose]
 *
 * Only read-only tools are called, so this is safe to run against production
 * books. It is the fastest way to confirm a self-hosted deployment works.
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
const verbose = process.argv.includes("--verbose");

const token = process.env.REAI_USER_API_TOKEN ?? process.env.REAI_TOKEN;
if (!token) {
  console.error("REAI_USER_API_TOKEN is not set.");
  process.exit(2);
}

let passed = 0;
let failed = 0;

function report(name, okFlag, detail) {
  const mark = okFlag ? "PASS" : "FAIL";
  if (okFlag) passed++;
  else failed++;
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Extract the concatenated text content of a tool result. */
function textOf(result) {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

async function main() {
  const client = new Client({ name: "reai-mcp-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repo, "dist", "index.js")],
    env: {
      ...process.env,
      REAI_USER_API_TOKEN: token,
      ...(arg("tenant") ? { REAI_TENANT_ID: arg("tenant") } : {}),
      REAI_WRITE_MODE: process.env.REAI_WRITE_MODE ?? "read-only",
      ...(verbose ? { REAI_VERBOSE: "1" } : {}),
    },
    stderr: verbose ? "inherit" : "pipe",
  });

  await client.connect(transport);
  console.log("\nConnected to reai-mcp over stdio.");

  const { tools } = await client.listTools();
  console.log(`\nTools exposed: ${tools.length}`);
  for (const t of tools) console.log(`  - ${t.name}`);

  console.log("\nRunning read-only checks:");

  // 1. Identity and tenant discovery.
  let tenantId = arg("tenant") ? Number(arg("tenant")) : undefined;
  try {
    const res = await client.callTool({ name: "reai_whoami", arguments: {} });
    const text = textOf(res);
    const okFlag = !res.isError && text.includes("tenants");
    report("reai_whoami", okFlag, okFlag ? firstLine(text) : text.slice(0, 200));
    if (!tenantId) {
      const match = /"id":\s*(\d+)/.exec(text);
      if (match) {
        tenantId = Number(match[1]);
        console.log(`  (using discovered tenant ${tenantId})`);
      }
    }
  } catch (err) {
    report("reai_whoami", false, String(err));
  }

  // 2. Spec-driven discovery needs no network at all.
  for (const [name, args, expect] of [
    ["reai_list_api_tags", {}, "Invoices"],
    ["reai_search_endpoints", { query: "bank reconciliation" }, "/api/bank-reconciliations"],
    ["reai_search_endpoints", { query: "credit note" }, "/api/"],
    ["reai_describe_endpoint", { method: "POST", path: "/api/vouchers" }, "postings"],
  ]) {
    try {
      const res = await client.callTool({ name, arguments: args });
      const text = textOf(res);
      report(
        `${name} ${JSON.stringify(args)}`,
        !res.isError && text.includes(expect),
        !res.isError && text.includes(expect) ? `found "${expect}"` : text.slice(0, 200),
      );
    } catch (err) {
      report(name, false, String(err));
    }
  }

  // 3. Tenant-scoped reads.
  if (tenantId) {
    for (const [name, args, check] of [
      ["reai_list_accounts", { tenantId, query: "bank" }, (t) => /"number"/.test(t)],
      ["reai_list_vat_codes", { tenantId }, (t) => /"code"/.test(t)],
      ["reai_list_vouchers", { tenantId }, (t) => /voucher\(s\)/.test(t)],
      ["reai_list_postings", { tenantId }, (t) => /posting\(s\)/.test(t)],
      ["reai_general_ledger", { tenantId, accountFrom: "1900", accountTo: "1999" }, (t) => /General ledger/.test(t)],
    ]) {
      try {
        const res = await client.callTool({ name, arguments: args });
        const text = textOf(res);
        const okFlag = !res.isError && check(text);
        report(name, okFlag, okFlag ? firstLine(text) : text.slice(0, 220));
      } catch (err) {
        report(name, false, String(err));
      }
    }

    // 4. The escape hatch must reach an endpoint with no curated tool.
    try {
      const res = await client.callTool({
        name: "reai_request",
        arguments: { method: "GET", path: "/api/currencies", tenantId },
      });
      const text = textOf(res);
      const okFlag = !res.isError && text.includes("NOK");
      report("reai_request GET /api/currencies", okFlag, okFlag ? "reached the API" : text.slice(0, 200));
    } catch (err) {
      report("reai_request", false, String(err));
    }

    // 5. The write policy must actually block a ledger write in read-only mode.
    try {
      const res = await client.callTool({
        name: "reai_request",
        arguments: {
          method: "POST",
          path: "/api/vouchers",
          tenantId,
          body: { date: "2026-01-01", postings: [] },
        },
      });
      const text = textOf(res);
      const blocked = res.isError === true && /write policy/i.test(text);
      report(
        "write policy blocks POST /api/vouchers in read-only mode",
        blocked,
        blocked ? "blocked as expected" : `NOT BLOCKED: ${text.slice(0, 200)}`,
      );
    } catch (err) {
      report("write policy guard", false, String(err));
    }
    // 6. The write policy must not be bypassable by path traversal. Regression:
    // classification ran on the raw string while the request was built with
    // new URL(), so "/api/customers/../vouchers" was classified against the
    // reversible /api/customers prefix but posted to the general ledger.
    for (const smuggle of [
      "/api/customers/../vouchers",
      "/api/customers/%2e%2e/vouchers",
      "/api/documents/../users",
    ]) {
      try {
        const res = await client.callTool({
          name: "reai_request",
          arguments: { method: "POST", path: smuggle, tenantId, body: {} },
        });
        const text = textOf(res);
        const blocked = res.isError === true && /write policy|not a usable API path/i.test(text);
        report(
          `path traversal blocked: POST ${smuggle}`,
          blocked,
          blocked ? "blocked" : `NOT BLOCKED: ${text.slice(0, 160)}`,
        );
      } catch (err) {
        report(`path traversal blocked: POST ${smuggle}`, false, String(err));
      }
    }
  } else {
    console.log("  (skipped tenant-scoped checks — no tenant id available)");
  }

  // 7. Sales-side reads.
  if (tenantId) {
    for (const [name, args, check] of [
      ["reai_list_customers", { tenantId }, (t) => /customer\(s\)/.test(t)],
      ["reai_list_products", { tenantId }, (t) => /product\(s\)/.test(t)],
      ["reai_list_orders", { tenantId }, (t) => /order\(s\)/.test(t)],
      ["reai_list_invoices", { tenantId }, (t) => /invoice\(s\)/.test(t)],
      ["reai_list_offers", { tenantId }, (t) => /offer\(s\)/.test(t)],
      ["reai_customer_ledger", { tenantId }, (t) => /Customer ledger/.test(t)],
      ["reai_customer_ledger", { tenantId, isOpenPosting: true }, (t) => /open postings only/.test(t)],
    ]) {
      try {
        const res = await client.callTool({ name, arguments: args });
        const text = textOf(res);
        const okFlag = !res.isError && check(text);
        report(`${name}${args.isOpenPosting ? " (open)" : ""}`, okFlag, okFlag ? firstLine(text) : text.slice(0, 200));
      } catch (err) {
        report(name, false, String(err));
      }
    }

    // 7b. Purchase-side reads.
    for (const [name, args, check] of [
      ["reai_list_suppliers", { tenantId }, (t) => /supplier\(s\)/.test(t)],
      ["reai_list_supplier_invoices", { tenantId }, (t) => /supplier invoice\(s\)/.test(t)],
      ["reai_supplier_ledger", { tenantId }, (t) => /Supplier ledger/.test(t)],
      ["reai_supplier_ledger", { tenantId, isUnpaid: true }, (t) => /Supplier ledger/.test(t)],
      ["reai_list_reception_documents", { tenantId }, (t) => /document\(s\) awaiting processing/.test(t)],
      ["reai_list_reception_documents", { tenantId, kind: "invoice" }, (t) => /invoice document\(s\)/.test(t)],
      ["reai_list_expenses", { tenantId }, (t) => /expense claim\(s\)/.test(t)],
    ]) {
      try {
        const res = await client.callTool({ name, arguments: args });
        const text = textOf(res);
        const okFlag = !res.isError && check(text);
        report(
          `${name}${args.isUnpaid ? " (unpaid)" : args.kind ? ` (${args.kind})` : ""}`,
          okFlag,
          okFlag ? firstLine(text) : text.slice(0, 220),
        );
      } catch (err) {
        report(name, false, String(err));
      }
    }

    // 7c. If the reception inbox has an EHF document, parse it for real. This is
    //     the only check here that exercises a document the tenant actually
    //     received, so it is skipped rather than failed when the inbox is empty.
    try {
      const inbox = await client.callTool({
        name: "reai_list_reception_documents",
        arguments: { tenantId, kind: "invoice" },
      });
      const attachmentId = Number(/"attachmentId":\s*(\d+)/.exec(textOf(inbox))?.[1]);
      const isXml = /"attachmentMimeType":\s*"[^"]*xml/i.test(textOf(inbox));
      if (Number.isInteger(attachmentId) && isXml) {
        const res = await client.callTool({
          name: "reai_parse_ehf_attachment",
          arguments: { tenantId, attachmentId },
        });
        const text = textOf(res);
        const parsed = !res.isError && /"supplier"/.test(text) && /"payableAmount"/.test(text);
        report(
          `reai_parse_ehf_attachment on real document ${attachmentId}`,
          parsed,
          parsed
            ? `${/"name":\s*"([^"]+)"/.exec(text)?.[1] ?? "?"} — ${/"payableAmount":\s*([\d.]+)/.exec(text)?.[1] ?? "?"}`
            : text.slice(0, 220),
        );
      } else {
        console.log("  [SKIP] reai_parse_ehf_attachment — no EHF document in the reception inbox");
      }
    } catch (err) {
      report("reai_parse_ehf_attachment", false, String(err));
    }

    // 8. Irreversible sales tools must be hidden in this mode, and the escape
    // hatch must refuse a transmitting flag on an otherwise-reversible path.
    const names = new Set(tools.map((t) => t.name));
    report(
      "irreversible sales tools are not advertised in this write mode",
      !names.has("reai_create_invoice_from_order") &&
        !names.has("reai_credit_invoice") &&
        !names.has("reai_register_invoice_payment") &&
        !names.has("reai_create_supplier_invoice") &&
        !names.has("reai_register_supplier_invoice_payment"),
      [...names].filter((n) => /invoice_from_order|credit_invoice|register_invoice/.test(n)).join(", ") || "hidden",
    );

    for (const [label, body] of [
      ["POST /api/subscriptions with outputMode=create_invoice", { customerId: 1, outputMode: "create_invoice" }],
      ["POST /api/subscriptions with automaticBillingGeneration", { customerId: 1, automaticBillingGeneration: true }],
    ]) {
      const res = await client.callTool({
        name: "reai_request",
        arguments: { method: "POST", path: "/api/subscriptions", tenantId, body },
      });
      const blocked = res.isError === true && /write policy/i.test(textOf(res));
      report(`self-invoicing subscription blocked: ${label}`, blocked, blocked ? "blocked" : textOf(res).slice(0, 160));
    }

    for (const path of ["/api/subscriptions/7/generate", "/api/subscriptions/generate-due"]) {
      const res = await client.callTool({
        name: "reai_request",
        arguments: { method: "POST", path, tenantId, body: {} },
      });
      const blocked = res.isError === true && /write policy/i.test(textOf(res));
      report(`subscription billing blocked: POST ${path}`, blocked, blocked ? "blocked" : textOf(res).slice(0, 160));
    }

    try {
      const res = await client.callTool({
        name: "reai_request",
        arguments: {
          method: "POST",
          path: "/api/orders",
          tenantId,
          body: { customerId: 1, orderLines: [], sendEhf: true },
        },
      });
      const text = textOf(res);
      const blocked = res.isError === true && /write policy/i.test(text) && /sendEhf/.test(text);
      report(
        "sendEhf=true escalates a reversible path and is blocked",
        blocked,
        blocked ? "blocked, and the flag is named" : `NOT BLOCKED: ${text.slice(0, 200)}`,
      );
    } catch (err) {
      report("sendEhf escalation", false, String(err));
    }
  }

  await client.close();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

function firstLine(text) {
  return (text.split("\n").find((l) => l.trim()) ?? "").slice(0, 150);
}

main().catch((err) => {
  console.error("\nSmoke test crashed:", err);
  process.exit(1);
});
