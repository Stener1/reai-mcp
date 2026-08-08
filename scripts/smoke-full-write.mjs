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
      const wipe = await client.callTool({
        name: "reai_request",
        arguments: {
          method: "PUT",
          path: `/api/company-banks/${created.doomedBankId}`,
          // Exactly the required set: an agent renaming the account.
          body: { name: `${STAMP} renamed`, countryCode: "NO", currency: "NOK" },
        },
      });
      const after = await readBban();
      // Both reads must have SUCCEEDED. `!bbanAfter` alone reported a failed second read as
      // proof of the very claim under test, in a block whose whole point is that a 200 hides it.
      const proven =
        !wipe.isError && before !== undefined && after !== undefined && !!before.value && !after.value;
      report(
        "a rename that omits the account number really does clear it",
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
      const rawRes = await client.callTool({
        name: "reai_request",
        arguments: {
          method: "PUT",
          path: `/api/agreements/rent-agreement/${created.agreementId}`,
          body: { landlordName: `${STAMP} utleier` },
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

    const payable = await makeEmployee("Paid", { accountNumber: "15201353103" });
    report(
      "a test employee exists, with a bank account",
      Number.isInteger(payable.id),
      payable.id ? `id=${payable.id}` : textOf(payable.res).slice(0, 160),
    );
    // The renamed-and-split response field. A caller that compares what it sent to the
    // `accountNumber` it reads back concludes the write failed; this pins why.
    report(
      "accountNumber goes in flat and comes back split under bankAccount",
      payable.data?.bankAccount?.bankCode === "1520" &&
        payable.data?.bankAccount?.accountNumber === "1353103" &&
        payable.data?.accountNumber === undefined,
      JSON.stringify(payable.data?.bankAccount ?? payable.data ?? null).slice(0, 160),
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
          const withEmployee = await client.callTool({
            name: "reai_request",
            arguments: {
              method: "PUT",
              path: `/api/salary-payments/${runId}/wage-specs/${wageSpecId}`,
              body: { employeeId: payable.id, specificationCode: "COMMISSION", quantity: 1, rate: 5000 },
              tenantId,
            },
          });
          report(
            "a wage-line update carrying employeeId is refused by the API",
            withEmployee.isError === true || /\b400\b/.test(textOf(withEmployee)),
            firstLineOf(textOf(withEmployee)),
          );

          const changed = await client.callTool({
            name: "reai_update_salary_line",
            arguments: {
              id: runId,
              wageSpecId,
              specificationCode: "COMMISSION",
              quantity: 1,
              rate: 2500,
              comment: STAMP,
            },
          });
          const after = changed.isError ? undefined : jsonOf(changed);
          report(
            "reai_update_salary_line halves the line without employeeId",
            !changed.isError && (after?.payableAmount ?? 0) < (withLine?.payableAmount ?? 0),
            after ? `payable=${after.payableAmount}` : textOf(changed).slice(0, 200),
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

    // The salary run before its employees: an employee referenced by a run is a dependent
    // record, and deleting the parent first is what left four orders stranded on this tenant
    // once already. A draft run deletes cleanly (measured 200) because it posted nothing.
    if (created.salaryRunId) {
      await attempt(
        "test salary run deleted",
        () => client.callTool({ name: "reai_delete_salary_run", arguments: { id: created.salaryRunId } }),
        (r) => firstLineOf(textOf(r)),
      );
    }
    for (const employeeId of created.salaryEmployeeIds) {
      await attempt(
        `test employee ${employeeId} deleted`,
        () =>
          client.callTool({
            name: "reai_request",
            arguments: { method: "DELETE", path: `/api/employees/${employeeId}`, tenantId },
          }),
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
      await attempt(
        "supplier deleted or archived",
        () => client.callTool({ name: "reai_delete_supplier", arguments: { id: created.supplierId } }),
        (r) => textOf(r).slice(0, 90),
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
