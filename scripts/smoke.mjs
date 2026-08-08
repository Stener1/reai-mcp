#!/usr/bin/env node
/**
 * End-to-end smoke test: launches the built server over stdio as a real MCP
 * client, then exercises read-only tools against the live ReAI API.
 *
 * Usage:
 *   REAI_USER_API_TOKEN=... node scripts/smoke.mjs --tenant 1234 [--verbose]
 *   REAI_READ_TENANTS=1234 REAI_USER_API_TOKEN=... node scripts/smoke.mjs
 *
 * Only read-only tools are called, so this is safe to run against production
 * books. It is the fastest way to confirm a self-hosted deployment works.
 *
 * The tenant must be named, either by --tenant or by REAI_READ_TENANTS. It used to
 * take the first id from GET /api/me, which was harmless while every token reached
 * exactly one company. With a user-scoped token that first id is whatever company
 * happens to sort first — someone else's business, quite possibly — and this script
 * then reads 40-odd endpoints from it. Reads are not writes, but choosing which of
 * a user's companies to open is not a decision a script should make silently.
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
      // Only a tenant that has been explicitly declared safe to READ. This used to
      // take the first id out of /api/me, which was harmless while every token
      // reached exactly one company — and stopped being harmless the moment a
      // user-scoped token arrived: the first id became someone else's business, and
      // this script read 41 endpoints from it. Reads are not writes, but "which of
      // your companies shall I open" is not a decision a script gets to make.
      const allowed = (process.env.REAI_READ_TENANTS ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const ids = [...text.matchAll(/"id":\s*(\d+)/g)].map((m) => m[1]);
      const pick = ids.find((id) => allowed.includes(id));
      if (pick) {
        tenantId = Number(pick);
        console.log(`  (using tenant ${tenantId}, declared in REAI_READ_TENANTS)`);
      } else if (ids.length > 0) {
        console.log(
          `  This token reaches ${ids.length} companies and none is declared in\n` +
            `  REAI_READ_TENANTS, so every tenant-scoped check will be skipped. Name the one\n` +
            `  you want read:\n\n` +
            `    REAI_READ_TENANTS=2634 node scripts/smoke.mjs\n` +
            `    node scripts/smoke.mjs --tenant 2634\n\n` +
            `  It is not for this script to choose which of your companies to open.`,
        );
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
      // Organisation. An empty tenant is the common case here, and the assertion is on the
      // sentence that distinguishes "none are defined" from "unavailable" — the two readings
      // this server exists to keep apart.
      [
        "reai_list_departments",
        { tenantId },
        (t) => /department\(s\)\.$/m.test(t) || /No departments\. That is not the same/.test(t),
      ],
      // Access control. Every tenant has at least the owner, so unlike departments there IS a
      // non-empty answer to assert — and the role comparison is computed from the response, so
      // this checks the computation against whatever the live tenant actually returns.
      [
        "reai_list_users",
        { tenantId },
        (t) => /\d+ user\(s\) with access\./.test(t) && !/UNKNOWN/.test(t),
      ],
      [
        "reai_list_roles",
        { tenantId },
        // The finding this toolset exists for: an assignable role identical to the owner's. If ReAI
        // ever narrows ROLE_ACCOUNTANT this check fails, which is the point — the claim is measured
        // per tenant rather than asserted from a comment.
        (t) => /IDENTICAL to ROLE_OWNER/.test(t) && /ASSIGNABLE role\(s\) carry everything/.test(t),
      ],
      [
        "reai_list_permissions",
        { tenantId },
        (t) => /permission\(s\), in \d+ group\(s\)/.test(t) && /tenant-wide and \d+ self-scoped/.test(t),
      ],
      [
        "reai_list_user_invitations",
        { tenantId },
        (t) => /pending invitation\(s\)/.test(t) || /No pending invitations/.test(t),
      ],
      [
        "reai_list_employees",
        { tenantId },
        (t) => /employee\(s\), summarised/.test(t) || /No employees are registered/.test(t),
      ],
      ["reai_employee_ledger", { tenantId }, (t) => /Employee ledger \d{4}-\d{2}-\d{2} to/.test(t)],
      // Fixed assets. Empty is the common case, and the assertion is on the sentence that
      // keeps "nothing capitalised" apart from "the company owns nothing".
      [
        "reai_list_assets",
        { tenantId },
        (t) => /fixed asset\(s\)\.$/m.test(t) || /register is empty/.test(t),
      ],
      [
        "reai_employee_ledger",
        { tenantId, isOpenPosting: true },
        (t) => /Employee ledger 2000-01-01 to/.test(t) && /window widened/.test(t),
      ],
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

    // 7bb. Bank & VAT reads. Bank transactions have no list endpoint, so the
    //      reconciliation view is the entry point — and it needs a real bank
    //      account id, so this chains off reai_list_company_banks.
    for (const [name, args, check] of [
      // Assert on fields the API returns, not on the note strings this codebase
      // emits itself — the latter is only "the call did not throw".
      // An empty tenant genuinely has no bank accounts, so requiring a
      // providerType/bban field made this suite unrunnable against a fresh
      // company — the state every new user of this server starts in. Accept an
      // empty list; only a response that is neither empty nor shaped like a bank
      // account is a failure.
      [
        "reai_list_company_banks",
        { tenantId },
        (t) => /"providerType"|"bban"/.test(t) || /\b0 bank account\(s\)/.test(t),
      ],
      ["reai_list_reconciliation_rules", { tenantId }, (t) => /reconciliation rule\(s\)/.test(t)],
    ]) {
      try {
        const res = await client.callTool({ name, arguments: args });
        const text = textOf(res);
        const okFlag = !res.isError && check(text);
        report(name, okFlag, okFlag ? firstLine(text) : text.slice(0, 200));
      } catch (err) {
        report(name, false, String(err));
      }
    }

    // The tax return may simply not exist for a young tenant — that is a skip,
    // not a failure.
    try {
      const year = String(new Date().getUTCFullYear() - 1);
      const res = await client.callTool({ name: "reai_get_tax_return", arguments: { tenantId, year } });
      const text = textOf(res);
      if (res.isError && /HTTP 404/.test(text)) {
        console.log(`  [SKIP] reai_get_tax_return — no tax return data for ${year} on this tenant`);
      } else {
        report(`reai_get_tax_return ${year}`, !res.isError, firstLine(text));
      }
    } catch (err) {
      report("reai_get_tax_return", false, String(err));
    }

    try {
      const banksRes = await client.callTool({
        name: "reai_list_company_banks",
        arguments: { tenantId },
      });
      // The synced-account view only applies to synced accounts; a manual-only
      // tenant should skip, not fail.
      const banks = (() => {
        const t = textOf(banksRes);
        const start = t.indexOf("[");
        const end = t.lastIndexOf("]");
        if (start === -1 || end <= start) return [];
        try {
          return JSON.parse(t.slice(start, end + 1));
        } catch {
          return [];
        }
      })();
      const synced = banks.find(
        (b) => !b?.archived && (b?.providerType ?? "manual") !== "manual",
      );
      const bankId = Number(synced?.id);
      if (Number.isInteger(bankId)) {
        const thisMonth = new Date().toISOString().slice(0, 7);
        const rec = await client.callTool({
          name: "reai_get_bank_reconciliation",
          arguments: { tenantId, bankAccountId: bankId, month: thisMonth, include: ["summary"] },
        });
        const okFlag = !rec.isError && /Reconciliation for bank account/.test(textOf(rec));
        report(
          `reai_get_bank_reconciliation (account ${bankId}, ${thisMonth})`,
          okFlag,
          okFlag ? firstLine(textOf(rec)) : textOf(rec).slice(0, 220),
        );
      } else {
        console.log(
          `  [SKIP] reai_get_bank_reconciliation — no bank-synced account on this tenant ` +
            `(${banks.length} account(s), all manual or archived)`,
        );
      }
    } catch (err) {
      report("reai_get_bank_reconciliation", false, String(err));
    }

    // 7c. If the reception inbox has an EHF document, parse it for real. This is
    //     the only check here that exercises a document the tenant actually
    //     received, so it is skipped rather than failed when the inbox is empty.
    try {
      const inbox = await client.callTool({
        name: "reai_list_reception_documents",
        arguments: { tenantId, kind: "invoice" },
      });
      // Pick a document whose OWN mime type is XML. Matching the two fields
      // independently across the whole payload could pair a PDF's attachmentId
      // with a different document's xml type, and fail on a healthy server.
      const text = textOf(inbox);
      const parsedInbox = (() => {
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start === -1 || end <= start) return undefined;
        try {
          return JSON.parse(text.slice(start, end + 1));
        } catch {
          return undefined;
        }
      })();
      const ehfDoc = (parsedInbox?.invoiceInbox ?? []).find((d) =>
        /xml/i.test(d?.attachmentMimeType ?? ""),
      );
      const attachmentId = Number(ehfDoc?.attachmentId);
      if (Number.isInteger(attachmentId)) {
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
        console.log("  [SKIP] reai_parse_ehf_attachment — no XML/EHF document in the reception inbox");
      }
    } catch (err) {
      report("reai_parse_ehf_attachment", false, String(err));
    }

    // 7e. Single-record getters, chained off the list tools the way the bank-reconciliation
    //     check already chains off company banks.
    //
    //     Of 43 read tools, 13 were not named in this file and 9 were not named in ANY
    //     smoke script — seven of those nine were GETs by id, unexercised because no suite
    //     had an id to pass them. (The other two are reai_api_notes, which reads the
    //     bundled spec, and reai_reconcile_ui.) Several getters WERE already covered, but
    //     only inside the write suites, which do not run against a real company by default:
    //     reai_get_voucher and reai_get_customer read back what those scripts create.
    //
    //     An empty collection is the common case on a fresh tenant and reports SKIP with
    //     the reason. That is deliberately not a pass: "never ran" and "ran and worked"
    //     are the distinction this whole server is about, and a silent pass here would be
    //     the same absence-read-as-success the tools themselves are guarded against.
    const recentMonths = (count) => {
      const out = [];
      const now = new Date();
      for (let i = 0; i < count; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      }
      return out;
    };
    // A getter must return ONE record whose own id is the one requested. Matching the id
    // anywhere in the response would pass a getter that called its collection endpoint by
    // mistake and returned the list — which contains that very row — and would also pass on
    // a nested object that happens to carry the same id.
    // ok() emits `note + "\n\n" + body`, but a tool that adds no note emits the body
    // alone — reai_get_bank_transaction does, and assuming the blank line reported its
    // perfectly good record as "not a record". Try both, whole text first.
    // Every blank-line-separated block, tried from the LAST backwards, because ok() puts the body
    // last and the notes before it. The previous version tried the whole text and then everything
    // after the FIRST blank line, which assumed a single note paragraph — and reai_get_user emits
    // two, so its body never parsed and the check reported "id=1853 but the response is not a
    // record" about a record it had just fetched by that id. The write suite's jsonOf was rewritten
    // for the same reason when quirk notes started appearing above bodies; this is the same bug in
    // the other script.
    const parseBody = (text) => {
      const blocks = text.split("\n\n");
      for (let i = blocks.length - 1; i >= 0; i--) {
        const candidate = blocks[i].trim();
        if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
        try {
          return JSON.parse(candidate);
        } catch {
          /* not the body after all — keep looking rather than giving up on the first candidate */
        }
      }
      // Some tools return the body alone, with no note at all.
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    };
    // Shared with firstIdOf below, because the two must agree about what an id is called: users are
    // keyed `userId` and agreements `agreementId`, and having the finder look at one field while the
    // verifier looked at another is how this produced "id=1853 → but the response is not a record"
    // for a record it had just fetched by that id.
    const ID_FIELDS = ["id", "userId", "agreementId", "voucherId", "customerId", "supplierId"];
    const idOfRecord = (body) => {
      for (const field of ID_FIELDS) {
        if (typeof body?.[field] === "number") return body[field];
      }
      return undefined;
    };
    const isRecordWithId = (text, id) => {
      const body = parseBody(text);
      return !!body && !Array.isArray(body) && typeof body === "object" && idOfRecord(body) === id;
    };
    const describeRecord = (text, id) => {
      const body = parseBody(text);
      if (Array.isArray(body)) return `id=${id} but the response is a LIST of ${body.length}`;
      if (!body || typeof body !== "object") return `id=${id} but the response is not a record`;
      return idOfRecord(body) === id ? `id=${id}` : `asked for ${id}, got ${JSON.stringify(idOfRecord(body))}`;
    };
    // A hardcoded `.id` returned null for users, so the getter was SKIPPED — silently, on every
    // run, for a tenant that plainly has a user to fetch, and the skip line said "returned nothing
    // to fetch", which was false. Same shape as the field-name bugs in the write suite's stray
    // sweep: a check that cannot run reads exactly like a check that passed.
    const firstIdOf = (text) => {
      const parsed = parseBody(text);
      if (parsed === undefined) return null;
      const rows = Array.isArray(parsed) ? parsed : (parsed?.content ?? parsed?.items ?? []);
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return idOfRecord(rows[0]) ?? null;
    };
    // Three of these default their window to the current year (vouchers) or the last year
    // (orders, invoices), so on a tenant whose records are older the list comes back empty
    // and the getter is skipped although a record exists to fetch. Reach back explicitly:
    // this is a discovery call looking for ANY id, not a report.
    const anyPeriod = { tenantId, startDate: "2000-01-01" };
    for (const [listName, getName, listArgs] of [
      ["reai_list_vouchers", "reai_get_voucher", anyPeriod],
      ["reai_list_customers", "reai_get_customer", { tenantId }],
      ["reai_list_orders", "reai_get_order", anyPeriod],
      ["reai_list_invoices", "reai_get_invoice", anyPeriod],
      ["reai_list_suppliers", "reai_get_supplier", { tenantId }],
      ["reai_list_supplier_invoices", "reai_get_supplier_invoice", { tenantId }],
      ["reai_list_departments", "reai_get_department", { tenantId }],
      ["reai_list_employees", "reai_get_employee", { tenantId }],
      ["reai_list_users", "reai_get_user", { tenantId }],
      ["reai_list_assets", "reai_get_asset", { tenantId }],
    ]) {
      try {
        const listed = await client.callTool({ name: listName, arguments: listArgs });
        // A list tool that FAILED is not a list tool that returned nothing. 403 module
        // gating is real on this API, and reporting it as "nothing to fetch on this
        // tenant" would be a false statement plus two silently skipped checks — the
        // absence-read-as-success this block's own comment claims to avoid.
        if (listed.isError) {
          report(getName, false, `${listName} failed: ${textOf(listed).split("\n")[0].slice(0, 60)}`);
          continue;
        }
        const id = firstIdOf(textOf(listed));
        if (id === null) {
          console.log(`  [SKIP] ${getName} — ${listName} returned nothing to fetch on this tenant`);
          continue;
        }
        const res = await client.callTool({ name: getName, arguments: { id, tenantId } });
        const text = textOf(res);
        report(getName, !res.isError && isRecordWithId(text, id), `id=${id} → ${describeRecord(text, id)}`);
      } catch (err) {
        report(getName, false, String(err));
      }
    }

    // 7f. The one getter with no list endpoint behind it. Bank transactions are only
    //     reachable through a reconciliation, so this walks company banks → the current
    //     month's reconciliation → the first transaction id it can find, in either the
    //     pending or the matched groups.
    try {
      const banks = await client.callTool({ name: "reai_list_company_banks", arguments: { tenantId } });
      if (banks.isError) throw new Error(`reai_list_company_banks failed: ${textOf(banks).split("\n")[0]}`);
      // The same selection the reconciliation check above makes, and for the same reason:
      // the synced view does not apply to a manual account, and an archived one is not a
      // working account. Taking banks[0] would have blamed the tenant for a wrong-view call.
      const bankAccountId = (() => {
        const rows = parseBody(textOf(banks));
        if (!Array.isArray(rows)) return null;
        const synced = rows.find((b) => !b?.archived && (b?.providerType ?? "manual") !== "manual");
        return Number.isInteger(Number(synced?.id)) ? Number(synced.id) : null;
      })();
      let transactionId = null;
      if (bankAccountId !== null) {
        for (const month of recentMonths(4)) {
          const rec = await client.callTool({
            name: "reai_get_bank_reconciliation",
            arguments: { bankAccountId, month, tenantId },
          });
          if (rec.isError) continue;
          // BOTH shapes. The overview carries pendingTransactions and matchedGroups[].
          // transactions — there is no bare `transactions` at the top level — so matching
          // only the latter meant a tenant with unmatched transactions and no matched
          // groups, which is precisely the state the bank workflow exists for, reported
          // "no bank transaction on this tenant" and skipped the check.
          const found =
            /"pendingTransactions"\s*:\s*\[\s*\{[\s\S]*?"id"\s*:\s*(\d+)/.exec(textOf(rec)) ??
            /"transactions"\s*:\s*\[\s*\{[\s\S]*?"id"\s*:\s*(\d+)/.exec(textOf(rec));
          if (found) {
            transactionId = Number(found[1]);
            break;
          }
        }
      }
      if (transactionId === null) {
        console.log("  [SKIP] reai_get_bank_transaction — no bank transaction on this tenant to fetch");
      } else {
        const res = await client.callTool({
          name: "reai_get_bank_transaction",
          arguments: { id: transactionId, tenantId },
        });
        const text = textOf(res);
        report(
          "reai_get_bank_transaction",
          !res.isError && isRecordWithId(text, transactionId),
          describeRecord(text, transactionId),
        );
      }
    } catch (err) {
      report("reai_get_bank_transaction", false, String(err));
    }

    // 8. Irreversible sales tools must be hidden in this mode, and the escape
    // hatch must refuse a transmitting flag on an otherwise-reversible path.
    // Derive the diagnostic from the same list the assertion uses, so a genuine
    // regression names the offending tool instead of printing "hidden".
    const mustBeHidden = [
      "reai_create_voucher",
      "reai_delete_voucher",
      "reai_create_invoice_from_order",
      "reai_credit_invoice",
      "reai_register_invoice_payment",
      "reai_create_supplier_invoice",
      "reai_register_supplier_invoice_payment",
      "reai_match_bank_transactions",
      "reai_book_bank_transactions",
      "reai_apply_reconciliation_rules",
      "reai_create_vat_return",
    ];
    const names = new Set(tools.map((t) => t.name));
    const leaked = mustBeHidden.filter((n) => names.has(n));
    report(
      "irreversible tools are not advertised in this write mode",
      leaked.length === 0,
      leaked.length === 0 ? `all ${mustBeHidden.length} hidden` : `LEAKED: ${leaked.join(", ")}`,
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

    for (const path of [
      "/api/subscriptions/7/generate",
      "/api/subscriptions/generate-due",
      "/api/manual-reconciliations/1/close",
      "/api/vat-returns",
      "/api/bank-reconciliations/1/vouchers",
    ]) {
      const res = await client.callTool({
        name: "reai_request",
        arguments: { method: "POST", path, tenantId, body: {} },
      });
      // In read-only mode every write is blocked, so also require the refusal to
      // name the irreversible class — otherwise this passes even if the path were
      // reclassified as merely reversible.
      const text = textOf(res);
      const blocked = res.isError === true && /classified "irreversible"/.test(text);
      report(
        `blocked as irreversible: POST ${path}`,
        blocked,
        blocked ? "refused, classification named" : text.slice(0, 180),
      );
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
