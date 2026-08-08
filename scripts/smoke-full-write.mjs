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
 * to the customer and cannot be deleted), VAT settlement (which locks a period),
 * or COMPLETING a payroll run — that posts the voucher, creates payslips, creates
 * one employee payment each and files the a-melding with Skatteetaten. Payroll up
 * to that line IS tested, because a run in status under_process has posted
 * nothing, and the voucher count is compared across the whole section to prove it
 * rather than assert it. Everything still untested is listed at the end, because
 * claiming otherwise would be worse than the gap.
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
  // The BODY, which ok() puts in the last blank-line-separated block.
  //
  // This used to scan from the first `{` to the last `}`. That worked only while every note
  // above the body was brace-free — and the moment reai_request began appending quirk notes to a
  // SUCCESSFUL write, notes containing `{ agreementId, templateType, ... }` made the span start
  // inside the prose and the parse fail. The symptom was a passing API call reported as a failed
  // check ("a lease exists to edit — HTTP 201"), which is the worst shape of test bug: it blames
  // the wrong thing.
  const blocks = textOf(result).split("\n\n");
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i].trim();
    if (!block.startsWith("{") && !block.startsWith("[")) continue;
    try {
      return JSON.parse(block);
    } catch {
      // Not the body after all — keep looking rather than giving up on the first candidate.
    }
  }
  return undefined;
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

/**
 * How many items a list tool ACTUALLY matched, truncation included.
 *
 * listOf alone is not enough for a count: ok() trims an oversized array at an item boundary
 * and re-serialises it as valid JSON, so 200, 201, 400 and 401 vouchers all come back as a
 * parsable array of 186. Comparing those lengths before and after a write would satisfy the
 * "posted no voucher" invariant automatically on any tenant with real history — the check
 * passing because it could not see, which is the failure mode this suite exists to catch.
 *
 * The truncation note carries the real total ("showing the first 186 of 400 items"), so read
 * it when present and use the array length only when it is not. Returns undefined when
 * neither is available, so the caller reports "could not count" instead of a number.
 */
function countOf(result) {
  if (result.isError) return undefined;
  const truncated = /showing the first \d+ of (\d+) items/.exec(textOf(result));
  if (truncated) return Number(truncated[1]);
  return listOf(result)?.length;
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

  // The allowlist checks the tenant NUMBER on the command line. It cannot check the one thing that
  // decides where a write lands: which company the TOKEN reaches. This repository documents that
  // hazard itself — when a token reaches exactly ONE tenant, X-Tenant-Id is IGNORED and every value
  // returns that tenant's data — so `REAI_WRITE_TEST_TENANTS=2783 --tenant 2783` with a token scoped
  // to another company posts to THAT company while every guard here passes. Codex found this on
  // PR #114, against a script that only refuses writes; it applies with far more force here, where the
  // next few hundred lines post to the general ledger. Nothing in this repository checked it.
  const whoamiRes = await client.callTool({ name: "reai_whoami", arguments: {} });
  const reachable = [...textOf(whoamiRes).matchAll(/\b(\d{4,})\b/g)].map((m) => Number(m[1]));
  if (!reachable.includes(tenantId)) {
    console.error(
      `Refusing to write: the token does not reach tenant ${tenantId}.\n` +
        `reai_whoami reports ${reachable.join(", ") || "(none)"}.\n\n` +
        `A token scoped to a single tenant IGNORES X-Tenant-Id, so this run would have posted to\n` +
        `${reachable[0] ?? "another company"} while --tenant said ${tenantId}.`,
    );
    process.exit(2);
  }

  console.log(`\nFull-write run against tenant ${tenantId} (write mode: full, external send: OFF)`);
  console.log(`Stamp: ${STAMP}\n`);

  const created = {
    agreementId: undefined,
    creditorId: undefined,
    doomedBankId: undefined,
    warehouseId: undefined,
    productId: undefined,
    variantId: undefined,
    voucherId: undefined,
    bankId: undefined,
    supplierPaymentId: undefined,
    ruleId: undefined,
    supplierInvoiceId: undefined,
    supplierId: undefined,
    salaryRunId: undefined,
    salaryEmployeeIds: [],
    expenseIds: [],
    /** expenseId -> voucherId, captured at booking so cleanup never has to ask. */
    expenseVoucherIds: {},
    loanId: undefined,
    loanCreditorId: undefined,
    debtorId: undefined,
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
      "no curated tool completes a payroll run — that files the a-melding",
      !tools.has("reai_complete_salary_run") && !tools.has("reai_pay_salary_run"),
      "absent by design",
    );
    report(
      "payroll drafting IS available (the toolset loaded)",
      tools.has("reai_create_salary_run") && tools.has("reai_delete_salary_run"),
      `${[...tools].filter((n) => n.includes("salary")).length} salary tools`,
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
      // Payroll's point of no return: it posts the voucher, creates payslips, creates one
      // employee payment each AND starts the a-melding submission to Skatteetaten. The id is
      // deliberately one that does not exist — the refusal has to happen before the API is asked.
      ["POST /api/salary-payments/{id}/complete", { method: "POST", path: "/api/salary-payments/999999/complete", body: { companyBankId: 1, manualPayment: true } }],
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

    // A full-replacement PUT on this record clears the account number when the body omits it —
    // and the payment-routing guard cannot see an omission, which is why the path is classified
    // irreversible outright. Demonstrated here on the throwaway bank above rather than asserted,
    // because the whole claim is that a 200 hides it.
    // The merge tools, on real records. Each wraps a PUT that replaces, so the property under
    // test is always the same: the fields nobody asked about must survive.
    if (created.bankId) {
      const renamed = await client.callTool({
        name: "reai_update_company_bank",
        arguments: { id: created.bankId, name: `${STAMP} renamed safely` },
      });
      const readBack = await client.callTool({
        name: "reai_request",
        arguments: { method: "GET", path: `/api/company-banks/${created.bankId}` },
      });
      const bank = readBack.isError ? undefined : jsonOf(readBack);
      report(
        "reai_update_company_bank renames without emptying the account",
        !renamed.isError && bank?.bban === "15201353103",
        renamed.isError ? firstLineOf(textOf(renamed)) : `bban=${JSON.stringify(bank?.bban)}`,
      );
      // And it refuses to clear the number even when asked — through the SCHEMA and handler
      // together, which is the path a client actually takes.
      const refused = await client.callTool({
        name: "reai_update_company_bank",
        arguments: { id: created.bankId, bban: null },
      });
      report(
        "clearing the account number is refused with a reason",
        refused.isError === true && /cannot be used for payments/.test(textOf(refused)),
        firstLineOf(textOf(refused)),
      );
    }

    const credRes = await client.callTool({
      name: "reai_request",
      arguments: {
        method: "POST",
        path: "/api/creditors",
        body: { name: `${STAMP} creditor`, bankAccountNumber: "15201353103" },
      },
    });
    if (!credRes.isError && Number.isInteger(jsonOf(credRes)?.id)) created.creditorId = jsonOf(credRes).id;
    report(
      "a creditor exists to rename",
      Number.isInteger(created.creditorId),
      created.creditorId ? `id=${created.creditorId}` : textOf(credRes).slice(0, 160),
    );
    if (created.creditorId) {
      const renamed = await client.callTool({
        name: "reai_update_creditor",
        arguments: { id: created.creditorId, name: `${STAMP} creditor renamed` },
      });
      const readBack = await client.callTool({
        name: "reai_request",
        arguments: { method: "GET", path: `/api/creditors/${created.creditorId}` },
      });
      const creditor = readBack.isError ? undefined : jsonOf(readBack);
      report(
        "reai_update_creditor renames without dropping the repayment account",
        !renamed.isError && creditor?.bankAccountNumber === "15201353103",
        renamed.isError ? firstLineOf(textOf(renamed)) : `account=${JSON.stringify(creditor?.bankAccountNumber)}`,
      );
    }

    // A SECOND, throwaway bank. The first one is used as the payment source further down, and an
    // account with an emptied bban "cannot be used for payments or reconciliation" — this repo's
    // own quirk. Demonstrating the wipe on it would have sabotaged the payment step and pinned
    // the failure on the payment tool.
    const doomedRes = await client.callTool({
      name: "reai_create_company_bank",
      arguments: { name: `${STAMP} doomed`, countryCode: "NO", currency: "NOK", bban: "15202296179" },
    });
    const doomed = doomedRes.isError ? undefined : jsonOf(doomedRes);
    if (Number.isInteger(doomed?.id)) created.doomedBankId = doomed.id;
    report(
      "a throwaway bank exists for the wipe demonstration",
      Number.isInteger(created.doomedBankId),
      created.doomedBankId ? `id=${created.doomedBankId}` : textOf(doomedRes).slice(0, 160),
    );

    if (created.doomedBankId) {
      const readBban = async () => {
        const r = await client.callTool({
          name: "reai_request",
          arguments: { method: "GET", path: `/api/company-banks/${created.doomedBankId}` },
        });
        // undefined means "could not read", which must never look like "the field is empty".
        return r.isError ? undefined : { value: jsonOf(r)?.bban };
      };
      const before = await readBban();

      // The rename an agent would actually write, sent FIRST without acknowledging anything. The
      // omission gate has to refuse it, and — the part that matters — the account number has to
      // still be there afterwards. A refusal that arrives after the field is gone is a post-mortem.
      const renameBody = { name: `${STAMP} renamed`, countryCode: "NO", currency: "NOK" };
      const gated = await client.callTool({
        name: "reai_request",
        arguments: {
          method: "PUT",
          path: `/api/company-banks/${created.doomedBankId}`,
          body: renameBody,
        },
      });
      const afterRefusal = await readBban();
      report(
        "the omission gate refuses a rename that would clear the account number",
        /leaves out 3 of its 6/.test(textOf(gated)) && /bban/.test(textOf(gated)),
        firstLineOf(textOf(gated)),
      );
      report(
        "and the account number is still there — the refusal came BEFORE the write",
        before !== undefined &&
          afterRefusal !== undefined &&
          !!before.value &&
          afterRefusal.value === before.value,
        before === undefined || afterRefusal === undefined
          ? "COULD NOT READ the account before or after — this demonstrates nothing either way"
          : `bban ${JSON.stringify(before.value)} → ${JSON.stringify(afterRefusal.value)}`,
      );

      // Now the same call with the clearing acknowledged, which is the damage the gate exists to
      // stop. Proving it still happens is what justifies the gate: if this ever stops clearing,
      // the refusal has become a false alarm and should be reconsidered rather than kept on faith.
      const wipe = await client.callTool({
        name: "reai_request",
        arguments: {
          method: "PUT",
          path: `/api/company-banks/${created.doomedBankId}`,
          body: renameBody,
          clearOmittedFields: true,
        },
      });
      const after = await readBban();
      // Both reads must have SUCCEEDED. `!bbanAfter` alone reported a failed second read as
      // proof of the very claim under test, in a block whose whole point is that a 200 hides it.
      const proven =
        !wipe.isError && before !== undefined && after !== undefined && !!before.value && !after.value;
      report(
        "acknowledged, that same rename really does clear the account number",
        proven,
        before === undefined || after === undefined
          ? "COULD NOT READ the account before or after — this demonstrates nothing either way"
          : `bban ${JSON.stringify(before.value)} → ${JSON.stringify(after.value)} — the reason ` +
            `this PUT is irreversible, and why the routing guard alone was not enough`,
      );
      // And the quirk must reach a caller whose write SUCCEEDED, which is the only signal here.
      report(
        "the successful write carried its quirk",
        !wipe.isError && /Known quirk/.test(textOf(wipe)) && /clears it|CLEARS it/.test(textOf(wipe)),
        firstLineOf(textOf(wipe)),
      );
    }

    // NOT covered live: an ARMED subscription being edited.
    //
    // Attempted, and the attempt is the finding. Creating one requires REAI_ALLOW_EXTERNAL_SEND —
    // arming IS a send, so reai_create_subscription with automaticBillingGeneration=true is refused
    // here exactly as it should be, and reai_request cannot get round it because the body-field gate
    // catches the same flag. So neither write suite can construct the precondition without enabling
    // the switch these runs exist to keep off.
    //
    // Which is worth stating rather than leaving as a gap: the state the gate protects is reachable
    // in practice — somebody arms a subscription in the ReAI UI, and an agent later edits it — but
    // not from here. The refusal is covered in test/subscriptions.test.mjs, driven through the
    // handler with allowExternalSend false, including the scoping (a comment edit still works) and
    // the three ways to disarm.

    // --- 4z. Agreement terms, on real data -----------------------------------
    //
    // The PUT behind this REPLACES the agreement, which is why the tool reads and merges and
    // why it sits at this tier. Verified here on live data rather than only against a fake
    // client: the whole value of the tool is that the terms it was not asked about survive.
    console.log("\n  Agreement terms (the underlying PUT replaces the record):");
    const agMade = await client.callTool({
      name: "reai_request",
      arguments: {
        method: "POST",
        path: "/api/agreements/rent-agreement",
        body: {
          landlordName: `${STAMP} utleier`,
          tenantName: `${STAMP} leietaker`,
          propertyAddress: "Prøvegata 1",
          monthlyRent: 12000,
          rentDueDayOfMonth: 1,
          leaseDurationType: "indefinite",
          depositType: "deposit",
          depositAmount: 36000,
          otherTerms: `${STAMP} original terms`,
        },
      },
    });
    const agreement = agMade.isError ? undefined : jsonOf(agMade);
    if (Number.isInteger(agreement?.agreementId)) created.agreementId = agreement.agreementId;
    report(
      "a lease exists to edit",
      Number.isInteger(created.agreementId),
      created.agreementId ? `agreementId=${created.agreementId}` : textOf(agMade).slice(0, 180),
    );

    if (created.agreementId) {
      const updRes = await client.callTool({
        name: "reai_update_agreement",
        arguments: { id: created.agreementId, changes: { monthlyRent: 13500 } },
      });
      report("reai_update_agreement changes one term", !updRes.isError, firstLineOf(textOf(updRes)));

      const afterRes = await client.callTool({
        name: "reai_get_agreement",
        arguments: { id: created.agreementId },
      });
      const after = afterRes.isError ? undefined : jsonOf(afterRes)?.rentAgreement;
      const kept =
        after?.monthlyRent === 13500 &&
        after?.tenantName === `${STAMP} leietaker` &&
        after?.depositAmount === 36000 &&
        after?.otherTerms === `${STAMP} original terms`;
      report(
        "every term it was not asked to change survived",
        kept,
        kept
          ? "rent changed; tenant, deposit and terms intact"
          : `TERMS LOST — rent=${after?.monthlyRent} tenant=${JSON.stringify(after?.tenantName)} ` +
            `deposit=${after?.depositAmount} terms=${JSON.stringify(after?.otherTerms)}`,
      );

      // And the raw partial PUT, which is what the tool exists to avoid. Run deliberately to
      // confirm the destruction is real rather than inferred — on a throwaway lease, in full
      // mode, where the write ladder permits it.
      //
      // clearOmittedFields is required now: the omission gate refuses this body, which is the
      // whole point of it. Asserted first, so the protection is proven on THIS endpoint too and
      // not only on company banks — 78 fields, of which the body below mentions one.
      const gatedLease = await client.callTool({
        name: "reai_request",
        arguments: {
          method: "PUT",
          path: `/api/agreements/rent-agreement/${created.agreementId}`,
          body: { landlordName: `${STAMP} utleier` },
        },
      });
      report(
        "the omission gate refuses a one-field PUT to a 78-field lease",
        /leaves out 77 of its 78/.test(textOf(gatedLease)),
        firstLineOf(textOf(gatedLease)),
      );
      const rawRes = await client.callTool({
        name: "reai_request",
        arguments: {
          method: "PUT",
          path: `/api/agreements/rent-agreement/${created.agreementId}`,
          body: { landlordName: `${STAMP} utleier` },
          clearOmittedFields: true,
        },
      });
      const wiped = await client.callTool({
        name: "reai_get_agreement",
        arguments: { id: created.agreementId },
      });
      const gone = wiped.isError ? undefined : jsonOf(wiped)?.rentAgreement;
      report(
        "a raw partial PUT really does clear the other terms",
        !rawRes.isError && gone?.monthlyRent === null && gone?.tenantName === null,
        `rent=${JSON.stringify(gone?.monthlyRent)} tenant=${JSON.stringify(gone?.tenantName)} ` +
          `deposit=${JSON.stringify(gone?.depositAmount)} — this is the behaviour the tool prevents`,
      );
    }

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

      // Without a variantId the API would answer 200 and move nothing. The tool requires the
      // field, so this is refused at the schema layer — before the handler runs and therefore
      // before any request is made, which is a stronger guarantee than declining after a read.
      const refused = await client.callTool({
        name: "reai_adjust_inventory",
        arguments: { productId: created.productId, warehouseId: created.warehouseId, quantityChange: 3 },
      });
      report(
        "an adjustment with no variantId cannot be made at all",
        refused.isError === true && /variantId/.test(textOf(refused)),
        firstLineOf(textOf(refused)),
      );

      // And a variant this warehouse does not track is refused by the pre-read, which is the
      // check that cannot be expressed in a schema.
      const untracked = await client.callTool({
        name: "reai_adjust_inventory",
        arguments: {
          productId: created.productId,
          warehouseId: created.warehouseId,
          variantId: created.variantId + 900000,
          quantityChange: 3,
        },
      });
      report(
        "a variant the warehouse does not track is refused before writing",
        untracked.isError === true && /Nothing was written/.test(textOf(untracked)),
        firstLineOf(textOf(untracked)),
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
      const countBefore = countOf(vouchersBefore);

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
      const countAfter = countOf(vouchersAfter);
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
    // ONE supplier, reused across runs, rather than a fresh one each time.
    //
    // This section posts a real supplier invoice, and DELETE on a supplier invoice REVERSES it —
    // the entries are permanent. A supplier with transactions cannot be deleted, only archived, so
    // every previous run left an archived supplier behind and they accumulated: 64 of them named
    // "Reai-mcp Fullwrite …" were sitting on the test tenant when the stray sweep below finally
    // looked. Nothing was wrong with the cleanup; the residue is inherent to what this section
    // tests. Reusing one supplier is what stops it growing, and unarchiving is how it comes back.
    const SUITE_SUPPLIER = "reai-mcp fullwrite suite supplier";
    const findSuiteSupplier = async () => {
      for (const args of [{ name: SUITE_SUPPLIER }, { name: SUITE_SUPPLIER, archived: true }]) {
        const res = await client.callTool({ name: "reai_list_suppliers", arguments: args });
        if (res.isError) continue;
        const hit = (listOf(res) ?? []).find(
          (row) => String(row?.name ?? "").toLowerCase() === SUITE_SUPPLIER,
        );
        if (hit) return { id: hit.id, archived: hit.archived === true };
      }
      return undefined;
    };
    const existing = await findSuiteSupplier();
    if (existing === undefined) {
      const supRes = await client.callTool({
        name: "reai_create_supplier",
        arguments: { name: SUITE_SUPPLIER, privateContact: true, skipRegistryLookup: true },
      });
      const supplier = supRes.isError ? undefined : jsonOf(supRes);
      if (Number.isInteger(supplier?.id)) created.supplierId = supplier.id;
      report(
        "the suite's supplier is created (first run on this tenant)",
        !supRes.isError && Number.isInteger(created.supplierId),
        `id=${created.supplierId}`,
      );
    } else {
      created.supplierId = existing.id;
      if (existing.archived) {
        // Where reai_unarchive_supplier earns its place: the previous run archived this supplier
        // because it had an invoice, and this is what brings it back.
        const restored = await client.callTool({
          name: "reai_unarchive_supplier",
          arguments: { id: existing.id },
        });
        report(
          "the suite's supplier is reused, unarchived from the last run",
          !restored.isError && /is active again/.test(textOf(restored)),
          firstLineOf(textOf(restored)),
        );
      } else {
        report("the suite's supplier is reused, already active", true, `id=${existing.id}`);
      }
    }
    // Whichever branch ran, the invoice chain below needs it usable.
    report(
      "a supplier is available to book against",
      Number.isInteger(created.supplierId),
      `id=${created.supplierId}`,
    );

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

    // --- Payroll: a DRAFT run, which posts nothing ---------------------------
    //
    // Payroll was on this suite's untested list, and half of it stays there: completing a run
    // is the one call that pays real people and files with the state, and it is refused above
    // rather than exercised. What IS testable is everything up to that line, because a run in
    // status under_process has posted no voucher — measured, and re-measured here against the
    // voucher count so the claim is not taken on faith.
    console.log("\n  Payroll draft (posts NO voucher — that is what is being verified):");

    const vouchersBeforePayroll = countOf(
      await client.callTool({ name: "reai_list_vouchers", arguments: { from: today, to: today } }),
    );

    // An employee is the precondition for a run, and its bank account is the precondition for
    // creating one at all. Two are made: one payable, one deliberately without an account.
    // The curated tools now own this. The raw POST is kept for the UNBANKED employee below, so
    // both the tool path and the raw path stay exercised in one run.
    const makeEmployee = async (label, extra) => {
      // The NAME is timestamped, not only the email: an employee name is unique per tenant
      // (409 "Ansatt med dette navnet finnes allerede"), so a record stranded by an earlier
      // crashed run blocks every later run until someone deletes it by hand. Measured — that is
      // exactly what happened, and the run it blocked reported a failure in the wrong place.
      const suffix = `${Date.now()}`.slice(-7);
      const res = await client.callTool({
        name: "reai_request",
        arguments: {
          method: "POST",
          path: "/api/employees",
          body: {
            name: `Zz Payroll ${label} ${suffix}`,
            email: `zz-payroll-${label}-${suffix}@example.invalid`,
            ...extra,
          },
          tenantId,
        },
      });
      const id = res.isError ? undefined : jsonOf(res)?.id;
      if (Number.isInteger(id)) created.salaryEmployeeIds.push(id);
      return { res, id, data: res.isError ? undefined : jsonOf(res) };
    };

    // --- Employee master data, through the curated tools ----------------------
    //
    // Payroll's precondition is an employee with a bank account, so this runs first and hands its
    // employee to the payroll section below. Everything here was measured before it was written:
    // the PATCH really patches, `employmentLines` inside it does not, and an unparseable phone is
    // stored as null with a 200.
    console.log("\n  Employee master data:");
    const empStamp = `${Date.now()}`.slice(-7);
    const createdEmp = await client.callTool({
      name: "reai_create_employee",
      arguments: {
        name: `Zz Master ${empStamp}`,
        email: `zz-master-${empStamp}@example.invalid`,
        phone: "22 33 44 55",
        dateOfEmployment: "2026-01-01",
        city: "Oslo",
        postalCode: "0150",
      },
    });
    const empData = createdEmp.isError ? undefined : jsonOf(createdEmp);
    const empId = empData?.id;
    if (Number.isInteger(empId)) created.salaryEmployeeIds.push(empId);
    report(
      "reai_create_employee",
      !createdEmp.isError && Number.isInteger(empId),
      empId ? `id=${empId}` : textOf(createdEmp).slice(0, 180),
    );
    report(
      "a plain Norwegian number is normalised to E.164, and the tool says so",
      empData?.phone === "+4722334455" && /normalised/.test(textOf(createdEmp)),
      `phone=${JSON.stringify(empData?.phone ?? null)}`,
    );
    report(
      "a new employee has no bank account, so payroll would refuse them",
      (empData?.bankAccount ?? null) === null &&
        /cannot be included in a salary run/.test(textOf(createdEmp)),
      `bankAccount=${JSON.stringify(empData?.bankAccount ?? null)}`,
    );

    if (Number.isInteger(empId)) {
      const setAccount = await client.callTool({
        name: "reai_set_employee_bank_account",
        arguments: { id: empId, accountNumber: "15201353103" },
      });
      report(
        "reai_set_employee_bank_account reports an ADD, and splits the number",
        !setAccount.isError &&
          jsonOf(setAccount)?.iban === "NO1615201353103" &&
          /ADDED/.test(textOf(setAccount)),
        firstLineOf(textOf(setAccount)),
      );
      const repoint = await client.callTool({
        name: "reai_set_employee_bank_account",
        arguments: { id: empId, accountNumber: "15060012345" },
      });
      report(
        "changing it again reports a REPOINT, naming both accounts",
        !repoint.isError &&
          /REPOINTED/.test(textOf(repoint)) &&
          /NO1615201353103/.test(textOf(repoint)) &&
          /NO9815060012345/.test(textOf(repoint)),
        firstLineOf(textOf(repoint)),
      );

      // Two lines added one at a time. The second is the one that matters: if `employmentLines`
      // were sent naively the first would be gone, and the create already made one, so a correct
      // run ends with three.
      const lineCount = async () => {
        const r = await client.callTool({
          name: "reai_get_employee",
          arguments: { id: empId, includePersonalData: true },
        });
        const relations = r.isError ? undefined : jsonOf(r)?.employmentRelations;
        return Array.isArray(relations)
          ? relations.flatMap((rel) => rel.employmentLines ?? []).length
          : undefined;
      };
      const linesAtStart = await lineCount();
      report(
        "creating an employee already made one employment line",
        linesAtStart === 1,
        `lines=${linesAtStart}`,
      );
      for (const [label, line] of [
        ["a salary line from the start date", { fromDate: "2026-01-01", percentage: 100, annualSalary: 600000 }],
        ["a raise from June", { fromDate: "2026-06-01", percentage: 80, annualSalary: 500000 }],
      ]) {
        const added = await client.callTool({
          name: "reai_add_employment_line",
          arguments: { id: empId, ...line },
        });
        report(`reai_add_employment_line: ${label}`, !added.isError, firstLineOf(textOf(added)));
      }
      const linesAfter = await lineCount();
      report(
        "every earlier line survived — the field replaces, so this is the whole point",
        linesAfter === 3,
        `${linesAtStart} + 2 = ${linesAfter} (3 expected)`,
      );

      // A line before employment start: refused locally, and the existing lines must be intact.
      const tooEarly = await client.callTool({
        name: "reai_add_employment_line",
        arguments: { id: empId, fromDate: "2025-06-01", percentage: 50 },
      });
      report(
        "a line dated before employment start is refused without calling the API",
        tooEarly.isError === true && /cannot start before the employment does/.test(textOf(tooEarly)),
        firstLineOf(textOf(tooEarly)),
      );
      report(
        "the refusal cost nothing — the lines are still there",
        (await lineCount()) === 3,
        `lines=${await lineCount()}`,
      );

      // The patch really patches: change the city and check that the account, phone and lines
      // are all still what they were. This is the claim the tool text makes.
      const patched = await client.callTool({
        name: "reai_update_employee",
        arguments: { id: empId, city: "Bergen", postalCode: "5003" },
      });
      const afterPatch = patched.isError ? undefined : jsonOf(patched);
      // The account is read through reai_get_employee with includePersonalData, because the write
      // tools redact it — asserting on the redacted value would be asserting on the placeholder.
      const unredacted = await client.callTool({
        name: "reai_get_employee",
        arguments: { id: empId, includePersonalData: true },
      });
      const ibanAfterPatch = unredacted.isError ? undefined : jsonOf(unredacted)?.bankAccount?.iban;
      report(
        "reai_update_employee changes only what it was given",
        !patched.isError &&
          afterPatch?.address?.city === "Bergen" &&
          afterPatch?.phone === "+4722334455" &&
          ibanAfterPatch === "NO9815060012345" &&
          (await lineCount()) === 3,
        `city=${afterPatch?.address?.city} phone=${JSON.stringify(afterPatch?.phone ?? null)} ` +
          `iban=${JSON.stringify(ibanAfterPatch ?? null)} lines=${await lineCount()}`,
      );

      // And the silent one. The number is set, so this is not a vacuous check.
      const badPhone = await client.callTool({
        name: "reai_update_employee",
        arguments: { id: empId, phone: "nonsense" },
      });
      report(
        "an unparseable phone answers 200 and stores null — and the tool says so",
        !badPhone.isError &&
          (jsonOf(badPhone)?.phone ?? null) === null &&
          /DID NOT SURVIVE/.test(textOf(badPhone)),
        `phone=${JSON.stringify(jsonOf(badPhone)?.phone ?? null)}`,
      );
      await client.callTool({
        name: "reai_update_employee",
        arguments: { id: empId, phone: "22334455" },
      });
    }

    // Reuses the employee the master-data section built, rather than making a second one: it
    // already has an account, and payroll's precondition is exactly that.
    const payable = { id: empId, data: empData };
    report(
      "a test employee exists, with a bank account",
      Number.isInteger(payable.id),
      payable.id ? `id=${payable.id}` : "no employee was created above",
    );
    // The renamed-and-split response field. A caller that compares what it sent to the
    // `accountNumber` it reads back concludes the write failed; this pins why.
    // The create response is the one checked here: accountNumber was NOT passed to it, so the
    // absence of a flat field is read from a record that has a bankAccount by now — read it fresh.
    const payableNow = Number.isInteger(payable.id)
      ? await client.callTool({
          name: "reai_get_employee",
          arguments: { id: payable.id, includePersonalData: true },
        })
      : undefined;
    const payableRecord = payableNow && !payableNow.isError ? jsonOf(payableNow) : undefined;
    report(
      "accountNumber goes in flat and comes back split under bankAccount",
      payableRecord?.bankAccount?.bankCode === "1506" &&
        payableRecord?.bankAccount?.accountNumber === "0012345" &&
        payableRecord?.accountNumber === undefined,
      JSON.stringify(payableRecord?.bankAccount ?? null).slice(0, 160),
    );

    const unbanked = await makeEmployee("Unbanked", {});
    if (Number.isInteger(payable.id) && Number.isInteger(unbanked.id)) {
      // The normal first failure, and it names the employee. Asserted before the happy path,
      // because a run created here would have to be cleaned up either way.
      const refused = await client.callTool({
        name: "reai_create_salary_run",
        arguments: {
          period: today.slice(0, 7),
          paymentDate: today,
          employeeIds: [payable.id, unbanked.id],
        },
      });
      report(
        "a run including an employee with no bank account is refused, by name",
        refused.isError === true && /mangler bankkonto/i.test(textOf(refused)),
        firstLineOf(textOf(refused)),
      );

      const runRes = await client.callTool({
        name: "reai_create_salary_run",
        arguments: {
          period: today.slice(0, 7),
          paymentDate: today,
          employeeIds: [payable.id],
        },
      });
      const run = runRes.isError ? undefined : jsonOf(runRes);
      // Recorded in `created` for the cleanup, and used from a LOCAL for the rest of the
      // exercise. Deleting a wage LINE is part of the test, not cleanup of the run, and
      // `created.salaryRunId` inside that call reads to the cleanup guard — correctly — as a
      // record being deleted in the try half.
      //
      // The recording comes FIRST and on its own line, because it is the line that makes the
      // cleanup possible: an earlier version of this file assigned the local here instead, threw
      // in the temporal dead zone, and stranded the run it had just created on a live tenant with
      // an employee attached that then could not be deleted either.
      if (Number.isInteger(run?.id)) created.salaryRunId = run.id;
      const runId = created.salaryRunId;
      // The API's own wording is "all employees eligible for the period", so the response's
      // employeeIds is what says who is in — asserted here because the tool's note reports that
      // list and a wrong one would read as coverage the run does not have.
      report(
        "the run includes exactly the employee asked for",
        !runRes.isError && JSON.stringify(run?.employeeIds ?? null) === JSON.stringify([payable.id]),
        `employeeIds=${JSON.stringify(run?.employeeIds ?? null)} (asked for [${payable.id}])`,
      );
      report(
        "reai_create_salary_run opens a DRAFT",
        !runRes.isError && run?.status === "under_process",
        run ? `id=${run.id} number=${run.number} status=${run.status}` : textOf(runRes).slice(0, 200),
      );
      report(
        "the draft carries no voucher",
        !runRes.isError && (run?.voucherId ?? null) === null,
        `voucherId=${JSON.stringify(run?.voucherId ?? null)}`,
      );

      if (Number.isInteger(runId)) {
        const lineRes = await client.callTool({
          name: "reai_add_salary_line",
          arguments: {
            id: runId,
            employeeId: payable.id,
            specificationCode: "COMMISSION",
            quantity: 1,
            rate: 5000,
            comment: STAMP,
          },
        });
        const withLine = lineRes.isError ? undefined : jsonOf(lineRes);
        const wageSpecId = withLine?.employees?.[0]?.wageSpecs?.[0]?.id;
        report(
          "reai_add_salary_line moves the run's payable total",
          !lineRes.isError && (withLine?.payableAmount ?? 0) > 0,
          withLine
            ? `payable=${withLine.payableAmount} withheld=${withLine.totalTaxDeducted} rate=${withLine.employees?.[0]?.taxDeductionRate}%`
            : textOf(lineRes).slice(0, 200),
        );

        // The measured asymmetry, asserted against the live API rather than only in the tool
        // text: create REQUIRES employeeId, update REJECTS it. The curated update tool cannot
        // send it at all, so this goes through reai_request on purpose.
        if (Number.isInteger(wageSpecId)) {
          // clearOmittedFields because this body omits comment and holidayAllowanceEarningYear,
          // so the omission gate would otherwise refuse it before the API could — and what is
          // under test here is the API's own rejection of employeeId.
          const withEmployee = await client.callTool({
            name: "reai_request",
            arguments: {
              method: "PUT",
              path: `/api/salary-payments/${runId}/wage-specs/${wageSpecId}`,
              body: { employeeId: payable.id, specificationCode: "COMMISSION", quantity: 1, rate: 5000 },
              clearOmittedFields: true,
              tenantId,
            },
          });
          report(
            "a wage-line update carrying employeeId is refused by the API",
            withEmployee.isError === true || /\b400\b/.test(textOf(withEmployee)),
            firstLineOf(textOf(withEmployee)),
          );

          // The line was created WITH a comment and is updated WITHOUT one on purpose. The PUT
          // replaces rather than patches — measured: a raw update omitting the field came back
          // with comment null — so this asserts the tool's read-merge-write actually preserves it.
          // The precondition is asserted first, because "the comment survived" passes trivially
          // if there was never a comment to lose.
          report(
            "the line was created with a comment, so there is something to lose",
            (withLine?.employees?.[0]?.wageSpecs?.[0]?.comment ?? null) === STAMP,
            `comment=${JSON.stringify(withLine?.employees?.[0]?.wageSpecs?.[0]?.comment ?? null)}`,
          );
          const changed = await client.callTool({
            name: "reai_update_salary_line",
            arguments: {
              id: runId,
              wageSpecId,
              specificationCode: "COMMISSION",
              quantity: 1,
              rate: 2500,
            },
          });
          const after = changed.isError ? undefined : jsonOf(changed);
          report(
            "reai_update_salary_line halves the line without employeeId",
            !changed.isError && (after?.payableAmount ?? 0) < (withLine?.payableAmount ?? 0),
            after ? `payable=${after.payableAmount}` : textOf(changed).slice(0, 200),
          );
          report(
            "the comment survived an update that never mentioned it",
            (after?.employees?.[0]?.wageSpecs?.[0]?.comment ?? null) === STAMP,
            `comment=${JSON.stringify(after?.employees?.[0]?.wageSpecs?.[0]?.comment ?? null)}`,
          );
          // And the raw PUT, the one a caller reaches for without the tool, still clears it. This
          // is the measurement the merge exists for, made in the same run rather than quoted.
          const rawPut = await client.callTool({
            name: "reai_request",
            arguments: {
              method: "PUT",
              path: `/api/salary-payments/${runId}/wage-specs/${wageSpecId}`,
              body: { specificationCode: "COMMISSION", quantity: 1, rate: 2500 },
              // Deliberate: this call exists to show the clearing, so it acknowledges it.
              clearOmittedFields: true,
              tenantId,
            },
          });
          const wiped = rawPut.isError ? undefined : jsonOf(rawPut);
          report(
            "a RAW PUT omitting the comment clears it — which is why the tool merges",
            !rawPut.isError &&
              (wiped?.employees?.[0]?.wageSpecs?.[0]?.comment ?? null) === null,
            rawPut.isError
              ? textOf(rawPut).slice(0, 160)
              : `comment=${JSON.stringify(wiped?.employees?.[0]?.wageSpecs?.[0]?.comment ?? null)}`,
          );

          const removed = await client.callTool({
            name: "reai_delete_salary_line",
            arguments: { id: runId, wageSpecId },
          });
          const emptied = removed.isError ? undefined : jsonOf(removed);
          report(
            "reai_delete_salary_line returns the run to zero payable",
            !removed.isError && (emptied?.payableAmount ?? -1) === 0,
            emptied ? `payable=${emptied.payableAmount}` : textOf(removed).slice(0, 200),
          );
        }

        const vouchersAfterPayroll = countOf(
          await client.callTool({ name: "reai_list_vouchers", arguments: { from: today, to: today } }),
        );
        report(
          "drafting payroll posted no voucher",
          vouchersBeforePayroll !== undefined && vouchersAfterPayroll === vouchersBeforePayroll,
          `${vouchersBeforePayroll} → ${vouchersAfterPayroll}`,
        );
      }
    }

    // --- Expense claims: the state machine, and the ledger step in the middle -
    //
    // Placed after payroll deliberately. A salary run is pre-populated with wage lines derived from
    // expense postings for the period, so booking an expense BEFORE that section would change what
    // the run contains and quietly invalidate its assertions.
    console.log("\n  Expense claims:");
    if (Number.isInteger(empId)) {
      const vouchersBeforeExpense = countOf(
        await client.callTool({ name: "reai_list_vouchers", arguments: { from: today, to: today } }),
      );
      const createdExp = await client.callTool({
        name: "reai_create_expense",
        arguments: {
          title: `${STAMP} expense`,
          travel: false,
          employeeId: empId,
          costs: [
            { date: today, description: `${STAMP} taxi`, amount: 500, category: "taxi", vatCode: "0" },
            { date: today, description: `${STAMP} hotel`, amount: 900, category: "hotel", vatCode: "0" },
          ],
        },
      });
      const expData = createdExp.isError ? undefined : jsonOf(createdExp);
      const expenseId = expData?.id;
      if (Number.isInteger(expenseId)) created.expenseIds.push(expenseId);
      report(
        "reai_create_expense",
        !createdExp.isError && Number.isInteger(expenseId) && expData?.totalAmount === 1400,
        expenseId ? `id=${expenseId} total=${expData?.totalAmount}` : textOf(createdExp).slice(0, 180),
      );
      report(
        "a draft expense posts nothing",
        vouchersBeforeExpense !== undefined &&
          (await countOf(
            await client.callTool({ name: "reai_list_vouchers", arguments: { from: today, to: today } }),
          )) === vouchersBeforeExpense,
        `vouchers still ${vouchersBeforeExpense}`,
      );

      if (Number.isInteger(expenseId)) {
        // The line arrays are complete lists: two rows in, one row sent, one row left.
        const replaced = await client.callTool({
          name: "reai_update_expense",
          arguments: {
            id: expenseId,
            costs: [{ date: today, description: `${STAMP} taxi only`, amount: 500, category: "taxi", vatCode: "0" }],
          },
        });
        const afterReplace = replaced.isError ? undefined : jsonOf(replaced);
        report(
          "sending one cost row REPLACES the list — 1400 becomes 500",
          !replaced.isError && afterReplace?.totalAmount === 500 && afterReplace?.costs?.length === 1,
          `total=${afterReplace?.totalAmount} rows=${afterReplace?.costs?.length}`,
        );

        for (const [label, name] of [
          ["reai_deliver_expense", "reai_deliver_expense"],
          ["reai_approve_expense", "reai_approve_expense"],
        ]) {
          const r = await client.callTool({ name, arguments: { id: expenseId } });
          report(label, !r.isError, firstLineOf(textOf(r)));
        }

        const booked = await client.callTool({
          name: "reai_book_expense_voucher",
          arguments: { id: expenseId },
        });
        const voucher = booked.isError ? undefined : jsonOf(booked);
        // Remembered here, not re-read during cleanup. A cleanup that asks the API what it needs to
        // clean up fails exactly when the API is having a bad minute: an errored or timed-out
        // reai_get_expense made voucherId undefined, which read as "not booked", which sent cleanup
        // down the reversal path that cannot work — leaving the expense, its voucher and the employee
        // that depends on it in a live tenant. The id is known at the moment it is created, so it is
        // kept.
        if (Number.isInteger(voucher?.voucherId)) created.expenseVoucherIds[expenseId] = voucher.voucherId;
        report(
          "reai_book_expense_voucher POSTS a voucher, in its own EX series",
          !booked.isError &&
            Number.isInteger(voucher?.voucherId) &&
            /^EX/.test(String(voucher?.voucherNumber ?? "")),
          voucher ? `voucher=${voucher.voucherId} number=${voucher.voucherNumber}` : textOf(booked).slice(0, 160),
        );
        report(
          "and the ledger moved by exactly one",
          (await countOf(
            await client.callTool({ name: "reai_list_vouchers", arguments: { from: today, to: today } }),
          )) === (vouchersBeforeExpense ?? 0) + 1,
          `${vouchersBeforeExpense} → ${await countOf(
            await client.callTool({ name: "reai_list_vouchers", arguments: { from: today, to: today } }),
          )}`,
        );
        // status STILL says approved, which is the trap the read tool exists to explain.
        const readBooked = await client.callTool({ name: "reai_get_expense", arguments: { id: expenseId } });
        report(
          'a booked expense still reads status "approved" — voucherId is the only tell',
          jsonOf(readBooked)?.status === "approved" && /IS in the ledger/.test(textOf(readBooked)),
          `status=${jsonOf(readBooked)?.status} voucherId=${jsonOf(readBooked)?.voucherId}`,
        );

        const blocked = await client.callTool({ name: "reai_unapprove_expense", arguments: { id: expenseId } });
        report(
          "unapproving a booked expense is refused locally, naming the voucher",
          blocked.isError === true && /booked to voucher/.test(textOf(blocked)),
          firstLineOf(textOf(blocked)),
        );

        const unlinked = await client.callTool({
          name: "reai_delete_expense_voucher",
          arguments: { id: expenseId },
        });
        // Upstream is broken here as of 2026-08-08, and the shape of the break matters more than
        // the count of failures it causes: DELETE /api/expenses/{id}/voucher answers
        // 409 application/problem+json with a raw Hibernate TransientPropertyValueException on a
        // freshly booked voucher. The tool's own description records it answering
        // {"outcome":"deleted"} when it was written, so this is a regression on ReAI's side, not
        // ours. Reported as a known upstream defect rather than a failure, because a red suite that
        // stays red teaches everyone to ignore it — but asserted POSITIVELY, so the day ReAI fixes
        // it this line fails and tells us to delete this branch.
        const upstreamCannotUnbook =
          unlinked.isError === true && /TransientPropertyValueException/.test(textOf(unlinked));
        if (upstreamCannotUnbook) {
          report(
            "KNOWN UPSTREAM DEFECT: DELETE /api/expenses/{id}/voucher 409s with a Hibernate error",
            true,
            "unbooking is impossible on ReAI's side today — remove this branch when it starts working",
          );
          console.log(
            "         the four checks that need an unbooked expense cannot run: unapprove, " +
              "reversal, and the two reads that observe it.",
          );
        } else {
          // The claim "asserted positively, so it fails when ReAI fixes it" was false as first
          // written: a successful unlink simply fell through to the normal checks and nothing said the
          // special case had gone stale. So the recovery is itself a failing check. Failing on good
          // news looks odd and is the point — the quirk, the tool's BROKEN UPSTREAM paragraph and the
          // branch above all have to be deleted together, and nothing else would ever say so.
          report(
            "the KNOWN UPSTREAM DEFECT branch is now STALE — delete it",
            false,
            "DELETE /api/expenses/{id}/voucher worked: remove the branch in this script, the " +
              "expense-voucher-unlink-is-broken-upstream quirk, and the upstream paragraphs in " +
              "reai_delete_expense_voucher and reai_reverse_expense",
          );
          report(
            "reai_delete_expense_voucher reports DELETED, not merely 200",
            !unlinked.isError && jsonOf(unlinked)?.outcome === "deleted",
            `outcome=${JSON.stringify(jsonOf(unlinked)?.outcome ?? null)}`,
          );
          report(
            "and the ledger is back where it started",
            (await countOf(
              await client.callTool({ name: "reai_list_vouchers", arguments: { from: today, to: today } }),
            )) === vouchersBeforeExpense,
            `vouchers=${await countOf(
              await client.callTool({ name: "reai_list_vouchers", arguments: { from: today, to: today } }),
            )}`,
          );

          const unapproved = await client.callTool({ name: "reai_unapprove_expense", arguments: { id: expenseId } });
          report("reai_unapprove_expense once the voucher is gone", !unapproved.isError, firstLineOf(textOf(unapproved)));

          // The finding this toolset exists for: reversal is invisible on a detail read.
          const reversed = await client.callTool({ name: "reai_reverse_expense", arguments: { id: expenseId } });
          report(
            "reai_reverse_expense reports the reversal",
            !reversed.isError && jsonOf(reversed)?.outcome === "reversed",
            `outcome=${JSON.stringify(jsonOf(reversed)?.outcome ?? null)}`,
          );
          const readReversed = await client.callTool({ name: "reai_get_expense", arguments: { id: expenseId } });
          report(
            "the API still returns it with its OLD status — no field changed",
            ["open", "for_approval", "approved"].includes(String(jsonOf(readReversed)?.status)),
            `status=${JSON.stringify(jsonOf(readReversed)?.status ?? null)}`,
          );
          report(
            "and reai_get_expense detects the reversal anyway, from list membership",
            /HAS BEEN REVERSED/.test(textOf(readReversed)),
            firstLineOf(textOf(readReversed).split("\n\n")[1] ?? ""),
          );
        }
      }
    }

    // --- 4c. Loans and their counterparties ----------------------------------
    //
    // The whole domain is undocumented in the ways that matter, and every one of those was learned by
    // measurement rather than from the spec. This section is what keeps them true: an upstream change to
    // any of it — the direction rule, the derived accounts, the reference uniqueness, the deletion
    // ordering — shows up here rather than in someone's books. Everything created is fully removable,
    // measured, which is why the domain is exercised end to end and share investments are not: an event
    // there is permanent, so the suite must never create one.
    console.log("\n  Loans and counterparties:");
    {
      const creditorRes = await client.callTool({
        name: "reai_create_creditor",
        arguments: { name: `${STAMP} loan creditor` },
      });
      if (!creditorRes.isError) created.loanCreditorId = jsonOf(creditorRes)?.id;
      report(
        "reai_create_creditor gives a borrower loan its counterparty",
        Number.isInteger(created.loanCreditorId),
        created.loanCreditorId ? `id=${created.loanCreditorId}` : firstLineOf(textOf(creditorRes)),
      );

      const debtorRes = await client.callTool({
        name: "reai_create_debtor",
        arguments: { name: `${STAMP} loan debtor` },
      });
      if (!debtorRes.isError) created.debtorId = jsonOf(debtorRes)?.id;
      report(
        "reai_create_debtor gives a lender loan its counterparty",
        Number.isInteger(created.debtorId),
        created.debtorId ? `id=${created.debtorId}` : firstLineOf(textOf(debtorRes)),
      );

      if (created.loanCreditorId) {
        // The direction rule, refused locally: nothing may reach the API, because the API's own answer is
        // a Norwegian sentence about a rule it never documents.
        const wrongPair = await client.callTool({
          name: "reai_create_loan",
          arguments: {
            reference: `${STAMP.slice(0, 20)}-bad`,
            loanType: "company_loan_to_owner",
            perspective: "borrower",
            counterpartyId: created.loanCreditorId,
            currency: "NOK",
            principalAmount: 1000,
            interestRateAnnual: 1,
            disbursementDate: today,
            repaymentType: "bullet",
          },
        });
        report(
          "a direction-locked loanType/perspective pair is refused before anything is sent",
          wrongPair.isError === true && /Nothing was sent/.test(textOf(wrongPair)),
          firstLineOf(textOf(wrongPair)),
        );

        const vouchersBeforeLoan = await countOf(
          await client.callTool({ name: "reai_list_vouchers", arguments: { from: today, to: today } }),
        );
        const reference = `${STAMP.slice(0, 22)}-L`;
        const loanRes = await client.callTool({
          name: "reai_create_loan",
          arguments: {
            reference,
            loanType: "bank_loan",
            perspective: "borrower",
            counterpartyId: created.loanCreditorId,
            currency: "NOK",
            principalAmount: 100000,
            interestRateAnnual: 5.5,
            disbursementDate: today,
            repaymentType: "annuity",
          },
        });
        const loan = loanRes.isError ? undefined : jsonOf(loanRes);
        created.loanId = loan?.id;
        report(
          "reai_create_loan records a borrower loan with the derived Norwegian accounts",
          !loanRes.isError &&
            loan?.principalAccountNumber === "2220" &&
            loan?.interestExpenseAccountNumber === "8150" &&
            loan?.accruedInterestAccountNumber === "2950",
          loanRes.isError
            ? firstLineOf(textOf(loanRes))
            : `id=${loan?.id} accounts=${loan?.principalAccountNumber}/${loan?.interestExpenseAccountNumber}/${loan?.accruedInterestAccountNumber}`,
        );
        const vouchersAfterLoan = await countOf(
          await client.callTool({ name: "reai_list_vouchers", arguments: { from: today, to: today } }),
        );
        report(
          "recording a loan posts NOTHING to the ledger",
          // Both counts have to be NUMBERS. `undefined === undefined` passed this when the list failed or
          // came back in a shape countOf cannot read, so the suite could claim it had watched the ledger
          // during an outage in which it saw nothing at all.
          typeof vouchersBeforeLoan === "number" &&
            typeof vouchersAfterLoan === "number" &&
            vouchersAfterLoan === vouchersBeforeLoan,
          typeof vouchersBeforeLoan === "number" && typeof vouchersAfterLoan === "number"
            ? `vouchers ${vouchersBeforeLoan} before, ${vouchersAfterLoan} after`
            : `the voucher count was UNREADABLE (${vouchersBeforeLoan} → ${vouchersAfterLoan}), so nothing was observed`,
        );

        // Only when the first create actually committed. Otherwise a temporary 5xx on the first call
        // followed by a recovery would make this a REAL create — of a loan whose id is never assigned to
        // created.loanId, so the finally could not delete it and the sweep would find it next run.
        const duplicate = created.loanId === undefined ? undefined : await client.callTool({
          name: "reai_create_loan",
          arguments: {
            reference,
            loanType: "bank_loan",
            perspective: "borrower",
            counterpartyId: created.loanCreditorId,
            currency: "NOK",
            principalAmount: 1,
            interestRateAnnual: 0,
            disbursementDate: today,
            repaymentType: "bullet",
          },
        });
        if (duplicate === undefined) {
          report(
            "a duplicate loan reference is refused, in English",
            false,
            "SKIPPED — the first loan did not commit, and probing a duplicate then risks creating a real " +
              "one this run cannot clean up",
          );
        } else {
          report(
            "a duplicate loan reference is refused, in English",
            duplicate.isError === true && /unique/.test(textOf(duplicate)),
            firstLineOf(textOf(duplicate)),
          );
        }
      }

      if (created.loanId) {
        // The merge: a partial edit must not clear the fields it did not mention, and must not carry the
        // old classification's accounts into a new one.
        const edited = await client.callTool({
          name: "reai_update_loan",
          arguments: { id: created.loanId, interestRateAnnual: 6.25 },
        });
        const after = edited.isError ? undefined : jsonOf(edited);
        report(
          "a partial loan edit keeps repaymentType and the interest accounts",
          !edited.isError &&
            after?.repaymentType === "annuity" &&
            after?.interestExpenseAccountNumber === "8150" &&
            after?.accruedInterestAccountNumber === "2950",
          edited.isError
            ? firstLineOf(textOf(edited))
            : `repaymentType=${after?.repaymentType} accounts=${after?.interestExpenseAccountNumber}/${after?.accruedInterestAccountNumber}`,
        );

        const reclassified = await client.callTool({
          name: "reai_update_loan",
          arguments: { id: created.loanId, loanType: "owner_loan_to_company" },
        });
        report(
          "reclassifying without naming accounts is refused, and quotes the ones the API would derive",
          reclassified.isError === true && /2255/.test(textOf(reclassified)) && /8159/.test(textOf(reclassified)),
          firstLineOf(textOf(reclassified)),
        );

        // The ordering: a counterparty a loan still names cannot be deleted.
        const blocked = await client.callTool({
          name: "reai_delete_creditor",
          arguments: { id: created.loanCreditorId },
        });
        report(
          "a creditor a loan still names cannot be deleted, and the refusal says loans first",
          blocked.isError === true && /Delete the loans first/.test(textOf(blocked)),
          firstLineOf(textOf(blocked)),
        );
      }
    }

  } finally {
    // --- 5. Clean up, most dependent first -----------------------------------
    //
    // Every deletion is isolated. A single `await` that rejects here — a
    // transport hiccup, a timeout — would otherwise abandon the rest of the
    // block, and the voucher is cleaned up last, so one failed request could
    // leave a test entry sitting in someone's real ledger. A failure has to be
    // reported and stepped over, not allowed to propagate.
    console.log("\n  Cleanup:");

    // `passed` is optional and defaults to "the call did not error". Without it, a cleanup check could
    // only ever assert that something was sent: review caught the outcome check below returning a
    // "NO OUTCOME REPORTED" detail string while still counting as a pass, which is the shape where a
    // regression shows up in the log and not in the exit code.
    const attempt = async (label, call, describe, passed = (r) => !r.isError) => {
      try {
        const r = await call();
        report(label, passed(r), describe(r));
        return r;
      } catch (err) {
        report(label, false, `CLEANUP REQUEST THREW — ${err?.message ?? err}`);
        return undefined;
      }
    };

    // Expenses before the employee they belong to, for the same dependency reason as the salary
    // run: a record referencing an employee is what makes DELETE /api/employees/{id} answer 409.
    // Reversal is the only removal this API offers for an expense, and it is idempotent — a second
    // reverse of an already-reversed expense answered ok, measured — so this is safe to repeat.
    for (const expenseId of created.expenseIds) {
      // Reversing is enough, including for an expense still carrying a posted voucher. Review
      // raised the opposite concern — that a throw between booking and the normal unlink would
      // leave an EX voucher in a live ledger — on the strength of this tool's own description,
      // which claimed reversing "does not touch a voucher". That claim was wrong. Measured: a
      // booked expense reversed with its voucher live took the voucher with it, the count went 1
      // back to 0, and the voucher then answered 404. The description is corrected; the cleanup
      // needed no change, and adding an unlink here made it FAIL, because a reversed expense
      // answers 409 "Kan ikke slette bilag fra et slettet utlegg/reiseregning."
      // Booked first, because the order is the whole point. While upstream cannot unbook (see the
      // 409 above), reversal CANNOT succeed on a booked expense — attempting it anyway produced a
      // failing cleanup line that blamed this suite for a defect at ReAI, which is the worst kind of
      // red: it is not actionable and it trains the reader to skip the output.
      const readBack = await client
        .callTool({ name: "reai_get_expense", arguments: { id: expenseId } })
        .catch(() => undefined);
      // The remembered id wins, and the read is only a fallback for an expense this run did not book.
      // An unreadable expense must never be treated as an unbooked one.
      const bookedVoucherId =
        created.expenseVoucherIds[expenseId] ??
        (readBack && !readBack.isError ? jsonOf(readBack)?.voucherId : undefined);
      if (!bookedVoucherId) {
        await attempt(
          `test expense ${expenseId} reversed`,
          () => client.callTool({ name: "reai_reverse_expense", arguments: { id: expenseId } }),
          (r) => firstLineOf(textOf(r)),
        );
      }
      // If it is still booked, reversal cannot touch it and neither can DELETE /api/expenses/{id}
      // (409, the same Hibernate error). Deleting the VOUCHER by id is the only route that works
      // while upstream is broken — and it CASCADES: measured on 2026-08-08, expense 2241 answered
      // 404 immediately after its voucher 30980 was deleted, and again for 2242/30984. So this is
      // NOT an unlink, it destroys the expense, which is exactly why the tool must not do it
      // silently and why it lives here in the cleanup instead.
      //
      // Without it this suite left an employee, an expense and a voucher in a REAL company on every
      // run: four such records were found and removed by hand before this was written, and the run
      // that found them created a fifth. Cleanup that only works on the happy path is not cleanup.
      if (bookedVoucherId) {
        const cascaded = await attempt(
          `test expense ${expenseId} removed with its voucher ${bookedVoucherId} (cascade)`,
          () => client.callTool({ name: "reai_delete_voucher", arguments: { id: bookedVoucherId } }),
          (r) => firstLineOf(textOf(r)),
        );
        // `attempt` counts any non-error result as success, and this endpoint deliberately succeeds on
        // "deleted", on "reversed" and on an unrecognised outcome. Only "deleted" is the cascade that
        // takes the expense with it — a reversal leaves both the expense and the employee behind while
        // this line reads green. So the outcome is asserted, and then the expense itself is checked,
        // because the cascade is upstream behaviour rather than a promise anyone made us.
        if (cascaded && !cascaded.isError) {
          const outcome = jsonOf(cascaded)?.outcome;
          report(
            `the voucher was DELETED outright, which is what takes expense ${expenseId} with it`,
            outcome === "deleted",
            `outcome=${JSON.stringify(outcome ?? null)}`,
          );
          const gone = await client
            .callTool({ name: "reai_get_expense", arguments: { id: expenseId } })
            .catch(() => ({ isError: true }));
          report(
            `expense ${expenseId} is really gone, not merely unbooked`,
            gone.isError === true,
            gone.isError === true ? "reads 404" : firstLineOf(textOf(gone)),
          );
        }
      }
    }
    // The salary run before its employees: an employee referenced by a run is a dependent
    // record, and deleting the parent first is what left four orders stranded on this tenant
    // once already. A draft run deletes cleanly (measured 200) because it posted nothing.
    if (created.salaryRunId) {
      // Asserting the OUTCOME, not just the absence of an error: this endpoint deletes OR records
      // a reversal and says which in {"outcome":...}. A draft must come back "deleted" — if it
      // ever answers "reversed" here, something posted to a live tenant's ledger and the cleanup
      // is the last place that would notice.
      const del = await attempt(
        "test salary run deleted",
        () => client.callTool({ name: "reai_delete_salary_run", arguments: { id: created.salaryRunId } }),
        (r) => firstLineOf(textOf(r)),
      );
      if (del && !del.isError) {
        const outcome = jsonOf(del)?.outcome;
        report(
          "the draft was DELETED, not reversed",
          outcome === "deleted",
          `outcome=${JSON.stringify(outcome)}`,
        );
      }
    }
    for (const employeeId of created.salaryEmployeeIds) {
      await attempt(
        `test employee ${employeeId} deleted`,
        () => client.callTool({ name: "reai_delete_employee", arguments: { id: employeeId } }),
        (r) => firstLineOf(textOf(r)),
      );
    }
    if (created.agreementId) {
      await attempt(
        "test lease deleted",
        () => client.callTool({ name: "reai_delete_agreement", arguments: { id: created.agreementId } }),
        (r) => firstLineOf(textOf(r)),
      );
    }
    // The product before the warehouse: deleting a record whose dependents are still
    // around answers 500 "Referenced record is not accessible", which is how a previous
    // run stranded four orders. Dependency order, cheapest first.
    // Zero the stock before deleting anything. The -4 inside the try only runs on the happy
    // path; any failure after the +4 would otherwise leave stock on hand, which makes the
    // delete ARCHIVE the warehouse — and there is no unarchive endpoint, and archived
    // warehouses are absent from the default list. That is permanent invisible litter on a
    // live tenant, so the cleanup does not depend on the happy path having completed.
    if (created.warehouseId && created.productId && created.variantId) {
      const inv = await client.callTool({
        name: "reai_get_warehouse_inventory",
        arguments: { warehouseId: created.warehouseId },
      });
      const onHand = inv.isError
        ? undefined
        : jsonOf(inv)?.rows?.find((r) => r.variantId === created.variantId)?.quantityOnHand;
      if (Number.isInteger(onHand) && onHand !== 0) {
        await attempt(
          `stock returned to zero (was ${onHand})`,
          () =>
            client.callTool({
              name: "reai_adjust_inventory",
              arguments: {
                productId: created.productId,
                warehouseId: created.warehouseId,
                variantId: created.variantId,
                quantityChange: -onHand,
              },
            }),
          (r) => firstLineOf(textOf(r)),
        );
      } else if (!Number.isInteger(onHand)) {
        report(
          "stock on hand could be read before cleanup",
          false,
          `could not read on-hand for warehouse ${created.warehouseId} — if stock is left, the ` +
            `delete will archive it and it will not show in the default list`,
        );
      }
    }
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
      // Archived, not deleted — it has an invoice, and a supplier invoice can only be reversed. That
      // is where this supplier is left, and the next run unarchives the same one rather than
      // creating another.
      const supplierOutcome = await attempt(
        "the suite's supplier is archived again, ready for the next run",
        () => client.callTool({ name: "reai_delete_supplier", arguments: { id: created.supplierId } }),
        (r) => textOf(r).slice(0, 90),
      );
      report(
        "and the outcome really was 'archived', not 'deleted'",
        supplierOutcome !== undefined &&
          !supplierOutcome.isError &&
          jsonOf(supplierOutcome)?.outcome === "archived",
        `outcome=${JSON.stringify(jsonOf(supplierOutcome ?? {})?.outcome ?? null)}`,
      );
    }
    if (created.loanId) {
      await attempt(
        `test loan ${created.loanId} deleted`,
        () => client.callTool({ name: "reai_delete_loan", arguments: { id: created.loanId } }),
        (r) => firstLineOf(textOf(r)),
      );
    }
    for (const [label, id, toolName] of [
      ["loan creditor", created.loanCreditorId, "reai_delete_creditor"],
      ["loan debtor", created.debtorId, "reai_delete_debtor"],
    ]) {
      if (!id) continue;
      // After the loan, never before: the API refuses a counterparty a loan still names, and this suite
      // asserts that refusal above, so the order here is the other half of the same fact.
      await attempt(
        `test ${label} ${id} deleted`,
        () => client.callTool({ name: toolName, arguments: { id } }),
        (r) => firstLineOf(textOf(r)),
      );
    }
    if (created.creditorId) {
      await attempt(
        "test creditor deleted",
        () =>
          client.callTool({
            name: "reai_request",
            arguments: { method: "DELETE", path: `/api/creditors/${created.creditorId}` },
          }),
        (r) => textOf(r).slice(0, 60),
      );
    }
    if (created.doomedBankId) {
      await attempt(
        "throwaway bank deleted",
        () =>
          client.callTool({
            name: "reai_request",
            arguments: { method: "DELETE", path: `/api/company-banks/${created.doomedBankId}` },
          }),
        (r) => firstLineOf(textOf(r)),
      );
    }
    if (created.bankId) {
      // Through the CURATED tool, so its reading of the {outcome} envelope is exercised against the
      // live API rather than only in a unit test. It used to go through reai_request, which is why
      // this check's own label said "deleted or archived" — the thing the endpoint tells you.
      await attempt(
        "company bank deleted, and which happened is reported",
        () => client.callTool({ name: "reai_delete_company_bank", arguments: { id: created.bankId, tenantId } }),
        (r) => {
          const text = textOf(r);
          return /was (DELETED|ARCHIVED)/.test(text)
            ? firstLineOf(text)
            : `NO OUTCOME REPORTED — ${firstLineOf(text)}`;
        },
        (r) => !r.isError && /was (DELETED|ARCHIVED)/.test(textOf(r)),
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

    // --- Leads: the CRM state, and the two 200s that do not mean what they say ---
    //
    // Every check here exists because the endpoint underneath it lies in a specific way. A mocked
    // unit test cannot catch any of them, since the lie IS the API's behaviour: null ignored by
    // PATCH, and a contact write accepted against a company that has no row to store it in.
    //
    // The subject is a real register company (Brønnøysund is the source, so there is no such thing
    // as a test one). Nothing here contacts it: lead state is private CRM data on this tenant, and
    // the suite removes what it writes.
    if (tools.has("reai_update_lead")) {
      console.log("\n  Leads (CRM state on a register company):");
      const org = "938225605";
      // The scenario below runs inside its own try/finally. It materialises a lead and, briefly, a
      // customer, and it sits BEFORE the residue sweeps: a throw anywhere in it would otherwise
      // escape to the outer cleanup block, skipping both the lead deletion and every sweep, and
      // leave exactly the litter the sweeps exist to notice.
      let leadCustomerId;
      const lead = async (args = {}) =>
        await client.callTool({ name: "reai_get_lead", arguments: { orgNumber: org, tenantId, ...args } });
      // An unreadable response must never look like an empty one. Collapsing it to {} made
      // `id === undefined` mean "no lead", so a 401 or a shape change would have been reported as a
      // clean tenant — the check passing because it could not see, which is the failure this whole
      // suite exists to catch. UNREADABLE is returned instead and every check treats it as a fail.
      const UNREADABLE = Symbol("unreadable");
      const stateOf = async () => {
        try {
          const res = await lead();
          if (res.isError) return UNREADABLE;
          const record = jsonOf(res);
          // `lead` may legitimately be absent on a company with no state, but the ENVELOPE must be
          // there: no orgNumber means this is not a lead response at all.
          if (!record || typeof record !== "object" || record.orgNumber === undefined) return UNREADABLE;
          return record.lead ?? {};
        } catch {
          return UNREADABLE;
        }
      };
      const unsaved = (state) => state !== UNREADABLE && (state.id === null || state.id === undefined);
      const describeState = (state) => (state === UNREADABLE ? "COULD NOT READ the lead" : `lead id ${state.id}`);
      const callLead = async (name, args) =>
        await client.callTool({ name, arguments: { orgNumber: org, tenantId, ...args } });
      // Customers for this org, or UNREADABLE. Used for the pre-conversion baseline and the
      // after-the-fact check, both of which must fail rather than pass when the list cannot be read.
      const customersForOrg = async (archived) => {
        try {
          const res = await client.callTool({
            name: "reai_list_customers",
            // No pageSize: reai_list_customers does not take one, and zod strips it silently.
            arguments: { organizationNumber: org, ...(archived ? { archived: true } : {}), tenantId },
          });
          if (res.isError) return UNREADABLE;
          const rows = listOf(res);
          return Array.isArray(rows) ? rows.map((r) => r.id) : UNREADABLE;
        } catch {
          return UNREADABLE;
        }
      };

      try {
      // Start from nothing, whatever an interrupted earlier run left behind.
      await callLead("reai_delete_lead", {});
      const before = await stateOf();
      report(
        "the subject starts as a register entry with no lead state",
        unsaved(before),
        unsaved(before) ? "unsaved" : `${describeState(before)} — abort`,
      );
      // Which customers for this org existed BEFORE anything was converted. Conversion reuses an
      // existing customer for the same organisation number rather than making a second one, so
      // without this the cleanup below would delete a customer the suite did not create — on a
      // tenant where a real one could exist under this org number.
      const activeBefore = await customersForOrg(false);
      const archivedBefore = await customersForOrg(true);
      const baselineReadable = activeBefore !== UNREADABLE && archivedBefore !== UNREADABLE;
      const customerBaseline = new Set(
        baselineReadable ? [...activeBefore, ...archivedBefore] : [],
      );
      report(
        "the customer baseline for the subject org could be read",
        baselineReadable,
        baselineReadable
          ? customerBaseline.size === 0
            ? "no pre-existing customer for this org"
            : `${customerBaseline.size} pre-existing: ${[...customerBaseline].join(", ")} — these will NOT be deleted`
          : "COULD NOT READ the customer list — cleanup cannot tell new from pre-existing",
      );

      // 1. Setting everything, which PATCH can do.
      const set = await callLead("reai_update_lead", {
        status: "active",
        notes: `Zz ${STAMP} lead notes`,
        email: "zz@example.invalid",
        phone: "40000000",
        followUpAt: today,
      });
      const seeded = await stateOf();
      report(
        "one call sets status, notes, contact details and follow-up",
        !set.isError &&
          seeded.status === "active" &&
          seeded.notes?.includes(STAMP) === true &&
          seeded.email === "zz@example.invalid" &&
          seeded.followUpAt === today,
        set.isError ? firstLineOf(textOf(set)) : `status ${seeded.status}, follow-up ${seeded.followUpAt}`,
      );
      // Phone normalisation, which is why the tool says so rather than echoing the input.
      report(
        "the phone comes back normalised to E.164",
        seeded.phone === "+4740000000",
        `sent 40000000, stored ${JSON.stringify(seeded.phone)}`,
      );
      report(
        "creating the lead is reported as creation, not as an update",
        /CREATED lead/.test(textOf(set)),
        firstLineOf(textOf(set)),
      );

      // 2. Clearing, which PATCH CANNOT do — the whole reason this tool dispatches.
      const cleared = await callLead("reai_update_lead", {
        notes: null,
        followUpAt: null,
        phone: null,
      });
      const empty = await stateOf();
      report(
        "null clears notes, follow-up and phone — the fields PATCH would have ignored",
        !cleared.isError && empty.notes === null && empty.followUpAt === null && empty.phone === null,
        cleared.isError
          ? firstLineOf(textOf(cleared))
          : `notes ${JSON.stringify(empty.notes)}, follow-up ${JSON.stringify(empty.followUpAt)}, phone ${JSON.stringify(empty.phone)}`,
      );
      report(
        "an untouched field survives a call that clears its neighbours",
        empty.email === "zz@example.invalid" && empty.status === "active",
        `email ${JSON.stringify(empty.email)}, status ${JSON.stringify(empty.status)}`,
      );

      // 3. The status that cannot be unset, refused locally rather than sent.
      const refused = await callLead("reai_update_lead", { status: null });
      const afterRefusal = await stateOf();
      report(
        "clearing a status is refused with the reason, and changes nothing",
        refused.isError === true && /cannot be cleared/.test(textOf(refused)) && afterRefusal.status === "active",
        refused.isError ? "refused locally" : `NOT REFUSED — status is now ${afterRefusal.status}`,
      );

      // 4. A contact write on an UNSAVED company: 200, and stores nothing. The tool has to have
      //    saved the lead first, so this is the check that the save-first is really there.
      await callLead("reai_delete_lead", {});
      const onUnsaved = await callLead("reai_update_lead", { email: "zz2@example.invalid" });
      const materialised = await stateOf();
      report(
        "contact details written to an unsaved company actually land",
        !onUnsaved.isError &&
          materialised !== UNREADABLE &&
          materialised.id !== null &&
          materialised.id !== undefined &&
          materialised.email === "zz2@example.invalid",
        onUnsaved.isError
          ? firstLineOf(textOf(onUnsaved))
          : `lead ${materialised.id}, email ${JSON.stringify(materialised.email)}`,
      );

      // 4b. A clear-only request on a company with no lead state must not create one to empty it.
      await callLead("reai_delete_lead", {});
      const clearOnUnsaved = await callLead("reai_update_lead", { notes: null, followUpAt: null });
      const stillUnsaved = await stateOf();
      report(
        "clearing fields on an untouched company creates no lead",
        !clearOnUnsaved.isError && unsaved(stillUnsaved),
        clearOnUnsaved.isError
          ? firstLineOf(textOf(clearOnUnsaved))
          : unsaved(stillUnsaved)
            ? "no lead created"
            : `${describeState(stillUnsaved)} — created in order to empty it`,
      );

      // 5. A contact event, which is append-only: nothing can remove it but deleting the lead.
      const eventNote = `Zz ${STAMP}`.slice(0, 180);
      const logged = await callLead("reai_log_lead_contact", {
        contactedOn: today,
        source: "phone",
        note: eventNote,
      });
      report(
        "logging a contact event reports it as unremovable",
        !logged.isError && /cannot be removed on its own/.test(textOf(logged)),
        firstLineOf(textOf(logged)),
      );
      // Read the event BACK, rather than trusting the 200 and the tool's own prose. This domain has
      // already produced a write that answered 200 and stored nothing (PUT .../contact on an unsaved
      // company), so a check that only reads the response would miss the same failure here. The
      // detail endpoint carries contactEvents, which is what makes the read-back possible at all.
      const detail = jsonOf(await lead());
      const events = detail?.contactEvents;
      report(
        "the contact event is actually there when the lead is read back",
        Array.isArray(events) && events.some((e) => e?.note === eventNote && e?.source === "phone"),
        !Array.isArray(events)
          ? `COULD NOT READ contactEvents (${JSON.stringify(events)}) — this proves nothing`
          : events.some((e) => e?.note === eventNote)
            ? `${events.length} event(s), including this run's`
            : `STORED NOTHING — ${events.length} event(s) and none is this run's`,
      );

      // 6. Conversion, then back out of it completely. The endpoint is id-only, so this also proves
      //    the tool saved the lead before converting — an unsaved company cannot be converted at all.
      const converted = await callLead("reai_convert_lead", {});
      const convertedState = await stateOf();
      const customerId = convertedState === UNREADABLE ? undefined : convertedState.convertedCustomerId;
      // Handed to the finally as soon as it is known, which is what makes the cleanup independent of
      // reaching the end of the scenario. It is set ONLY for a customer proven new against the
      // baseline taken before the conversion, so a throw can never make the finally delete a record
      // this run did not create. Cleared again once the scenario has removed it itself.
      if (typeof customerId === "number" && baselineReadable && !customerBaseline.has(customerId)) {
        leadCustomerId = customerId;
      }
      report(
        "converting a lead produces a customer and names it",
        !converted.isError && typeof customerId === "number",
        converted.isError ? firstLineOf(textOf(converted)) : `customer ${customerId}`,
      );
      const again = await callLead("reai_convert_lead", {});
      report(
        "a repeat conversion reports the same customer without calling convert",
        !again.isError && new RegExp(`already converted to customer ${customerId}`).test(textOf(again)),
        firstLineOf(textOf(again)),
      );

      // Undo in this order, which is not the obvious one. Deleting the customer FIRST archived it
      // instead: "it had transactions", on a customer minutes old with no ledger entry, no order and
      // no invoice — the converted lead still pointing at it is what counts as a transaction. Once
      // the lead was gone, unarchiving and deleting the same customer removed it outright. So the
      // lead is deleted first here, and the customer after.
      const removed = await callLead("reai_delete_lead", {});
      const finalState = await stateOf();
      report(
        "deleting the lead returns the company to register-only",
        !removed.isError && unsaved(finalState),
        removed.isError ? firstLineOf(textOf(removed)) : unsaved(finalState) ? "unsaved again" : describeState(finalState),
      );
      // Only a customer this run PROVED to be new. Conversion reuses an existing customer for the
      // same organisation number, so deleting whatever convertedCustomerId names would remove a
      // record the suite did not create — and this script's rule is that it never deletes those.
      const customerIsNew = leadCustomerId === customerId && typeof customerId === "number";
      if (typeof customerId === "number" && !customerIsNew) {
        report(
          "the converted customer is left alone, because this run did not create it",
          baselineReadable,
          baselineReadable
            ? `customer ${customerId} pre-dates this run — not deleted`
            : `customer ${customerId} may or may not be new (baseline unreadable) — NOT deleted; ` +
              `check by hand whether it should be`,
        );
      }
      if (customerIsNew) {
        const del = await client.callTool({
          name: "reai_delete_customer",
          arguments: { id: customerId, tenantId },
        });
        const gone = !del.isError && /was DELETED outright/.test(textOf(del));
        report(
          "with the lead gone, the converted customer deletes outright",
          gone,
          firstLineOf(textOf(del)) +
            (/ARCHIVED/.test(textOf(del))
              ? ` — unarchive and delete customer ${customerId} by hand`
              : ""),
        );
        // Removed here, so the finally does not try again and report a 404 as a cleanup failure.
        if (gone) leadCustomerId = undefined;
      }
      // The customer is the part that survives a lead delete, so prove it is gone by its own path
      // rather than inferring it from the lead. A stray customer named after a real company is
      // exactly the litter this suite exists to prevent.
      if (typeof customerId === "number") {
        for (const archived of [false, true]) {
          const ids = await customersForOrg(archived);
          const label = `no ${archived ? "archived" : "active"} customer is left for the converted org`;
          if (ids === UNREADABLE) {
            report(label, false, "COULD NOT READ the customer list — this proves nothing either way");
            continue;
          }
          // The baseline, not zero: a pre-existing customer for this org is allowed to remain, and
          // demanding zero would report someone else's data as this run's litter.
          const extra = ids.filter((id) => !customerBaseline.has(id));
          report(
            label,
            extra.length === 0,
            extra.length === 0
              ? customerBaseline.size === 0
                ? "none"
                : `only the ${customerBaseline.size} pre-existing`
              : `STILL PRESENT — delete customer(s) ${extra.join(", ")} by hand`,
          );
        }
      }
      } catch (err) {
        // Reported and swallowed rather than rethrown. Rethrowing would take out the residue sweeps
        // that run after this section, which is precisely when they are most worth having.
        report("the lead scenario ran to completion", false, `THREW — ${err?.message ?? err}`);
      } finally {
        // Runs whether the scenario finished or threw. It reports what it had to clean up, because a
        // silent tidy-up would hide the fact that the run did not complete normally.
        const leftover = await stateOf();
        if (leftover === UNREADABLE || !unsaved(leftover)) {
          const removedLate = await callLead("reai_delete_lead", {}).catch((err) => ({
            isError: true,
            content: [{ type: "text", text: String(err?.message ?? err) }],
          }));
          const nowState = await stateOf();
          report(
            "cleanup: no lead state survives this section",
            unsaved(nowState),
            unsaved(nowState)
              ? "removed after an incomplete run"
              : `${describeState(nowState)} — delete it by hand with reai_delete_lead: ${firstLineOf(textOf(removedLate))}`,
          );
        }
        if (typeof leadCustomerId === "number") {
          const del = await client
            .callTool({ name: "reai_delete_customer", arguments: { id: leadCustomerId, tenantId } })
            .catch((err) => ({ isError: true, content: [{ type: "text", text: String(err?.message ?? err) }] }));
          report(
            "cleanup: the customer this section created is gone",
            !del.isError && /was DELETED outright/.test(textOf(del)),
            firstLineOf(textOf(del)) || `delete customer ${leadCustomerId} by hand`,
          );
        }
      }
    }

    // --- A sweep for test records this run did NOT create -------------------
    //
    // The stamp sweep below catches leaks from THIS run. It cannot catch leaks from any other, and
    // that is the gap that actually bit: eight orders sat on this tenant from an ad-hoc probe until
    // they were noticed by hand weeks later, along with the subscription that generated them. A
    // stamp-based check would never have mentioned them.
    //
    // So this one matches on the naming convention every test record here uses instead, across the
    // domains this suite touches. It REPORTS and never deletes: it is looking at records it did not
    // create, and quietly removing those would be a worse habit than leaving them.
    const KNOWN_UNRECOVERABLE = {
      // Measured, and there is no way back: these orders were generated from subscription 223 by a
      // subscription-billing probe, and their line references a PRODUCT that was later deleted.
      // DELETE now answers 500 "Referenced record is not accessible". Unarchiving the customer does
      // NOT help — tried, the 500 persists — and products have no unarchive endpoint at all (only
      // customers and suppliers do). Subscription 223 in turn answers 409 "Kan ikke slette et
      // abonnement som har generert faktureringshistorikk" because of those very orders, so neither
      // can go. They need removing through the ReAI web UI, or they stay.
      orders: [4098, 4099, 4100, 4101, 4102, 4103, 4104, 4105],
      subscriptions: [223],
      // Archived test customers from earlier runs. Archiving is what a delete does to a customer
      // with transactions, so these are the expected residue rather than a leak — and 5941 is the
      // one the eight stranded orders point at, which is why it cannot go.
      customers: [5922, 5941],
      // Four suppliers from ad-hoc probes before this sweep existed: Payprobe-…, Signprobe-…,
      // "Vat Basis Probe As" and "Reversal Probe As". Each carries a reversed supplier invoice, so
      // DELETE archives rather than deletes and always will — unarchiving and deleting again just
      // re-archives, measured. They were hidden past the truncation cut of the whole-list query
      // until the sweep started asking per name prefix, which is what found them.
      suppliers: [5631, 5632, 5642, 5645],
      // A general sub-account created while measuring the posting rules, before there were tools
      // for them. There is NO DELETE on that resource — measured, 405 — and PUT accepts only
      // `name`, so it cannot be removed or moved. Renamed to say what it is; it will sit on account
      // 1300 of this tenant permanently.
      // 6312 came from a probe before this sweep existed. 6323 is "zz-si-probe" on account 1810, and it
      // is a consequence rather than a separate accident: creating a share investment auto-creates a
      // general sub-account on its derived asset account, named after the position — measured, and
      // deleting the position removes it again. Share investment 19 cannot be deleted (it has events),
      // so its sub-account cannot go either, and sub-accounts have no DELETE endpoint at all.
      "sub-accounts": [6312, 6323],
    };
    // Deliberately mixed anchoring, which the first version had by accident: `^` bound only to the
    // `zz` alternative and everything else matched anywhere. Review flagged that as a false-positive
    // risk, and it is — but making them all prefixes would have been wrong too, because the API's
    // own `name` filter matches on SUBSTRING, and that is exactly how the four strays this sweep
    // found were found: "Payprobe-…" and "Signprobe-…" contain "probe" without starting with it.
    //
    // So: `zz` is anchored, because as a substring it matches buzz, pizza and puzzle. The other four
    // are distinctive enough to match anywhere, and on a tenant declared safe to write to a false
    // positive costs one message asking a human to look, while a false negative is litter that hides
    // forever — which is the failure this exists to prevent.
    const TEST_NAME = /(?:^zz|reai-mcp|smoke|probe|walkthrough)/i;
    // Residue this suite CANNOT avoid, matched by name rather than id because the id differs per
    // tenant. The supplier invoice this suite posts can only be reversed, so its supplier keeps a
    // transaction and its delete archives — one archived supplier is the permanent, expected state.
    // The 64 older ones are the same thing before the suite started reusing a single supplier;
    // they are counted and named here rather than allowlisted away, so the number stays visible.
    const EXPECTED_RESIDUE = {
      // The suite's own marker IS the residue marker here, and deliberately the whole prefix rather
      // than "reai-mcp fullwrite": every supplier this repo has ever named that way carries a
      // reversed supplier invoice, so its DELETE archives and always will. Counting them keeps the
      // number visible without the whole-list query truncating — 65 of them do not fit the result
      // budget, and a truncated list cannot support a claim of cleanliness.
      suppliers: /^reai-mcp/i,
    };
    // Every entry states the ID FIELD, the fields that can actually carry a test marker, and the
    // query variants needed to see everything. All three were wrong in the first version, and each
    // wrong one made a domain report clean unconditionally — a sweep that cannot fail is worse than
    // no sweep, because it is evidence of an absence it never checked. Review caught all of it:
    //
    //  - products are labelled `title`, not `name` (ProductRes), and the suite stamps `title`;
    //  - orders expose `internalComment`, not `comment` (OrderOverviewRes);
    //  - agreements are keyed `agreementId` and labelled `clientName` — `signerEmail` is not in the
    //    list at all and `templateType` is a fixed enum, so nothing could ever match;
    //  - orders default to a ONE YEAR window and expenses to the current year, so old leaks age out
    //    of view and the sweep turns green on its own;
    //  - customers, suppliers and warehouses hide ARCHIVED rows, which is exactly what a delete
    //    leaves behind when the record has transactions.
    const FLOOR = "2000-01-01";
    const CEILING = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
    // Where a list supports a `name` filter, the sweep asks per test PREFIX instead of for the whole
    // list. That is what keeps it exhaustive: 69 archived suppliers do not fit the result budget, so
    // the whole-list query truncates and can prove nothing, while each prefix query returns a
    // handful. The residue prefix is counted rather than listed — every row it can match is
    // residue by definition, so truncation there is harmless.
    const TEST_PREFIXES = ["zz", "smoke", "probe", "walkthrough", "reai-mcp"];
    const SWEPT = [
      ["orders", "reai_list_orders", "id", ["customerName", "internalComment"], [{ startDate: FLOOR, endDate: CEILING }]],
      ["customers", "reai_list_customers", "id", ["name"], "byName"],
      ["suppliers", "reai_list_suppliers", "id", ["name"], "byName"],
      ["products", "reai_list_products", "id", ["title", "description"], [{}]],
      ["employees", "reai_list_employees", "id", ["name"], [{}]],
      ["expenses", "reai_list_expenses", "id", ["title"], [{ startDate: FLOOR, endDate: CEILING }]],
      ["subscriptions", "reai_list_subscriptions", "id", ["customerName"], [{}]],
      ["company banks", "reai_list_company_banks", "id", ["name"], [{}]],
      ["warehouses", "reai_list_warehouses", "id", ["name"], [{}, { archived: true }]],
      ["agreements", "reai_list_agreements", "agreementId", ["clientName"], [{}]],
      ["reconciliation rules", "reai_list_reconciliation_rules", "id", ["matchText", "description"], [{}]],
      // Added after review pointed out that KNOWN_UNRECOVERABLE carried a "sub-accounts" key that
      // nothing consulted — so the permanent record was neither verified as present nor reported if
      // it went, and a future test-named sub-account would never have been noticed. They cannot be
      // deleted, so noticing is the only thing available.
      ["sub-accounts", "reai_list_sub_accounts", "id", ["name"], [{}]],
      // Loans and their counterparties. All three are fully removable — measured — so anything left with
      // a test prefix on it is a cleanup that did not run, not a record the API refuses to release. The
      // loan list has no filter, hence the single empty query; the counterparty lists take none either.
      ["loans", "reai_list_loans", "id", ["reference", "counterpartyName"], [{}]],
      ["creditors", "reai_list_creditors", "id", ["name"], [{}]],
      ["debtors", "reai_list_debtors", "id", ["name"], [{}]],
    ];
    for (const [label, toolName, idField, fields, variants] of SWEPT) {
      try {
        const allowed = new Set(KNOWN_UNRECOVERABLE[label] ?? []);
        const residuePattern = EXPECTED_RESIDUE[label];
        const strays = new Map();
        const seen = new Set();
        let explained = 0;
        let truncated;
        // "byName" expands to one query per test prefix, in both the active and archived views.
        // Prefixes wholly covered by the residue pattern are COUNTED, not listed: the filter itself
        // guarantees every row matches, so a truncated answer there hides nothing.
        let queries = variants;
        if (variants === "byName") {
          queries = [];
          for (const prefix of TEST_PREFIXES) {
            const covered = residuePattern !== undefined && residuePattern.test(prefix);
            for (const archived of [false, true]) {
              queries.push({ name: prefix, ...(archived ? { archived: true } : {}), ...(covered ? { countOnly: true } : {}) });
            }
          }
        }
        for (const query of queries) {
          const { countOnly, ...args } = query;
          if (countOnly === true) {
            const res = await client.callTool({ name: toolName, arguments: args });
            if (!res.isError) explained += countOf(res) ?? (listOf(res) ?? []).length;
            continue;
          }
          const res = await client.callTool({ name: toolName, arguments: args });
          if (res.isError) {
            truncated = `could not be listed with ${JSON.stringify(args)} — ${firstLineOf(textOf(res))}`;
            break;
          }
          // A truncated list cannot support a claim of cleanliness: ok() trims at an item boundary
          // and the remainder is simply not there. The suite already learned this for voucher
          // counts; the sweep has to refuse rather than read the visible part as the whole.
          const cut = /showing the first (\d+) of (\d+) items/.exec(textOf(res));
          if (cut) {
            // A truncated list cannot prove cleanliness, and saying otherwise is the vacuity this
            // sweep exists to avoid. It is reported with the real total from the note, which is
            // information even when the rows are not all visible.
            truncated = `the ${label} list came back TRUNCATED (${cut[1]} of ${cut[2]}), so what is ` +
              `past the cut was not examined — narrow the query, or clear the backlog so the whole ` +
              `list fits`;
          }
          // A list this suite cannot READ proves nothing, and `?? []` silently turned that into "clean".
          // Codex found it on the three new sweeps; it applies to every one of them, so it is fixed in
          // the shared loop rather than beside the new entries. This is the same failure the truncation
          // branch above exists for, in a different shape: no rows because the shape was unrecognised,
          // not because the tenant is tidy.
          const rows = listOf(res);
          if (rows === undefined) {
            truncated = `the ${label} list came back in a shape this suite cannot read, so nothing was ` +
              `examined — a successful response with no recognisable rows is not evidence of a clean tenant`;
            continue;
          }
          for (const row of rows) {
            const id = row?.[idField];
            if (allowed.has(id)) {
              // Counted as SEEN, so the summary reports what is actually still there. Printing the
              // static list meant that after someone cleaned a record in the ReAI UI, the sweep would
              // go on announcing it as live tenant state indefinitely.
              seen.add(id);
              continue;
            }
            const residue = EXPECTED_RESIDUE[label];
            if (residue && fields.some((field) => residue.test(String(row?.[field] ?? "")))) {
              explained += 1;
              continue;
            }
            if (fields.some((field) => TEST_NAME.test(String(row?.[field] ?? "")))) strays.set(id, row);
          }
        }
        report(
          `sweep: no unexplained test ${label} left behind`,
          truncated === undefined && strays.size === 0,
          strays.size > 0
            ? `LEFTOVER ${label.toUpperCase()} ${[...strays.keys()].join(", ")} — not created by this ` +
              `run and not explained. Identify what made them and remove them, or record why they stay.`
            : truncated !== undefined
              ? truncated
              : strays.size === 0
              ? [
                  "clean",
                  seen.size > 0
                    ? `${seen.size} known-unrecoverable record(s) still present: ${[...seen].join(", ")}`
                    : "",
                  // Named rather than silently dropped: an allowlist entry that no longer exists is
                  // either a record someone cleaned up by hand, or an id that was wrong all along,
                  // and both are worth one line so the list does not rot.
                  truncated === undefined && allowed.size > seen.size
                    ? `${allowed.size - seen.size} allowlisted id(s) no longer present ` +
                      `(${[...allowed].filter((id) => !seen.has(id)).join(", ")}) — remove them from ` +
                      `KNOWN_UNRECOVERABLE`
                    : "",
                  explained > 0 ? `${explained} expected residue row(s)` : "",
                ]
                  .filter(Boolean)
                  .join("; ")
                : "",
        );
      } catch (err) {
        report(`sweep: ${label}`, false, `sweep threw — ${err?.message ?? err}`);
      }
    }

    // Leads cannot join the sweep above, because a lead's name is the REGISTER's name — a real
    // company, never "Zz something". Nothing about the row says "test". What makes them sweepable
    // instead is the baseline: measured, both 2783 and 2634 have 0 saved leads, so on this tenant a
    // saved lead is residue by definition, and listing every one of them is cheap. If a human ever
    // starts doing real CRM work here, this check turns into a list of their leads and should become
    // a baseline comparison rather than a zero.
    try {
      const saved = await client.callTool({
        name: "reai_search_leads",
        arguments: { leadFilter: "saved", pageSize: 200, tenantId },
      });
      const rows = jsonOf(saved)?.items;
      if (!Array.isArray(rows)) {
        report("sweep: no lead state left behind", false, `could not read the saved-lead list: ${firstLineOf(textOf(saved))}`);
      } else {
        report(
          "sweep: no lead state left behind",
          rows.length === 0,
          rows.length === 0
            ? "clean (0 saved leads, which is this tenant's baseline)"
            : `LEFTOVER LEAD(S) ${rows.map((r) => `${r.id} ${r.companyName}`).join(", ")} — remove with ` +
              `reai_delete_lead, or record why they stay`,
        );
      }
    } catch (err) {
      report("sweep: no lead state left behind", false, `sweep threw — ${err?.message ?? err}`);
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
      "  - COMPLETING a payroll run — one call posts the voucher, creates payslips, creates\n" +
      "    one employee payment per payable employee AND starts the a-melding submission to\n" +
      "    Skatteetaten. Drafting a run IS tested above (create, add, change and remove wage\n" +
      "    lines, delete the run), and the voucher count is compared across it to show that a\n" +
      "    draft posts nothing. The refusal at /complete is asserted before any write.\n" +
      "  - registering a CUSTOMER payment — it needs an issued invoice, which transmits.\n" +
      "    A manual SUPPLIER\n" +
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
