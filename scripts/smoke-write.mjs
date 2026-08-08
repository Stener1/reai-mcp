#!/usr/bin/env node
/**
 * Reversible write round-trip against a live tenant.
 *
 * Creates master data, verifies it, then deletes it again — proving the
 * `reversible` write mode actually works end to end, and that the things it must
 * NOT permit are still refused.
 *
 * Usage:
 *   REAI_USER_API_TOKEN=... node scripts/smoke-write.mjs --tenant 2634
 *
 * Separate from smoke.mjs and opt-in on purpose: this one writes. It only ever
 * touches records it created itself, and cleans up in a finally block so a
 * mid-run failure still removes them. It never posts to the ledger, issues a
 * document, or moves money — those are `irreversible` and the server refuses
 * them in this mode.
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
if (!token) {
  console.error("REAI_USER_API_TOKEN is not set.");
  process.exit(2);
}
if (!tenantId) {
  console.error("--tenant <id> is required, so this cannot write to the wrong company by accident.");
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

/** Pull the first JSON object out of a tool's text response. */
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

// A marker that makes anything this script leaves behind obvious in the UI.
const STAMP = `reai-mcp smoke ${new Date().toISOString().replace(/[:.]/g, "-")}`;

/**
 * ReAI normalizes customer names to title case on save, so a round-trip
 * comparison has to be case-insensitive.
 */
const containsStamp = (text) => text.toLowerCase().includes(STAMP.toLowerCase());

const firstLineOf = (text) => (text.split("\n").find((l) => l.trim()) ?? "").slice(0, 130);

async function main() {
  const client = new Client({ name: "reai-mcp-write-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repo, "dist", "index.js")],
    env: {
      ...process.env,
      REAI_USER_API_TOKEN: token,
      REAI_TENANT_ID: String(tenantId),
      REAI_WRITE_MODE: "reversible",
    },
    stderr: "pipe",
  });

  await client.connect(transport);
  console.log(`\nReversible write round-trip against tenant ${tenantId} (mode: reversible)\n`);

  const created = {
    customerId: undefined,
    offerId: undefined,
    supplierId: undefined,
    warehouseId: undefined,
    agreementId: undefined,
    subscriptionId: undefined,
  };

  // The allowlist checks the tenant NUMBER on the command line. It cannot check the one thing that
  // decides where a write lands: which company the TOKEN reaches. This repository documents that
  // hazard itself — when a token reaches exactly ONE tenant, X-Tenant-Id is ignored and every value
  // returns that tenant's data — so `REAI_WRITE_TEST_TENANTS=2783 --tenant 2783` with a token scoped
  // to another company posts to that company while every guard here passes. Codex found this on
  // PR #114, on a script that only refuses writes; it applies with far more force to this one, which
  // posts to the general ledger. Nothing in this repository checked it.
  const whoami = await client.callTool({ name: "reai_whoami", arguments: {} });
  const reachable = [...textOf(whoami).matchAll(/\b(\d{4,})\b/g)].map((m) => Number(m[1]));
  if (!reachable.includes(tenantId)) {
    console.error(
      `Refusing to write: the token does not reach tenant ${tenantId}.\n` +
        `reai_whoami reports ${reachable.join(", ") || "(none)"}.\n\n` +
        `A token scoped to a single tenant IGNORES X-Tenant-Id, so this run would have written to\n` +
        `${reachable[0] ?? "another company"} while --tenant said ${tenantId}.`,
    );
    process.exit(2);
  }

  try {
    // 0. Warehouse round-trip. Nothing else depends on it, and it is the cheapest
    //    proof that create/rename/read/delete all agree about the same record.
    const whRes = await client.callTool({
      name: "reai_create_warehouse",
      arguments: { name: `${STAMP} lager` },
    });
    const wh = whRes.isError ? undefined : jsonOf(whRes);
    if (Number.isInteger(wh?.id)) created.warehouseId = wh.id;
    report(
      "reai_create_warehouse",
      !whRes.isError && Number.isInteger(created.warehouseId),
      created.warehouseId ? `id=${created.warehouseId}` : textOf(whRes).slice(0, 200),
    );

    if (created.warehouseId) {
      const renameRes = await client.callTool({
        name: "reai_rename_warehouse",
        arguments: { warehouseId: created.warehouseId, name: `${STAMP} lager 2` },
      });
      report("reai_rename_warehouse", !renameRes.isError, firstLineOf(textOf(renameRes)));

      const getRes = await client.callTool({
        name: "reai_get_warehouse",
        arguments: { id: created.warehouseId },
      });
      const fetched = getRes.isError ? undefined : jsonOf(getRes);
      report(
        "reai_get_warehouse reads back the new name",
        fetched?.name === `${STAMP} lager 2` && fetched?.archived === false,
        fetched ? `name=${fetched.name} archived=${fetched.archived}` : textOf(getRes).slice(0, 160),
      );

      // The empty inventory of a brand-new warehouse: an OBJECT with rows, not an array.
      // A list-shaped read here would be the bug the quirk exists for.
      const invRes = await client.callTool({
        name: "reai_get_warehouse_inventory",
        arguments: { warehouseId: created.warehouseId },
      });
      const inv = invRes.isError ? undefined : jsonOf(invRes);
      report(
        "reai_get_warehouse_inventory returns the envelope, not an array",
        !invRes.isError && Array.isArray(inv?.rows) && inv.rows.length === 0,
        invRes.isError ? textOf(invRes).slice(0, 160) : `rows=${inv?.rows?.length} totalStockValue=${inv?.totalStockValue}`,
      );

    }

    // The write ceiling, asserted independently of whether the warehouse above was created —
    // this is about the server's gate, not about the record, and nesting it inside a
    // successful create meant a failed create silently skipped the most safety-relevant
    // check in this suite.
    //
    // Asserted by LISTING the tools rather than by calling the adjustment and reading the
    // error: "tool not found" would also be the answer if the tool were simply renamed, so
    // the call-and-match version would have passed for the wrong reason.
    const exposed = new Set((await client.listTools()).tools.map((tool) => tool.name));
    report(
      "reai_adjust_inventory is not exposed in reversible mode",
      !exposed.has("reai_adjust_inventory"),
      exposed.has("reai_adjust_inventory") ? "EXPOSED — an irreversible tool is reachable" : "hidden",
    );
    // ...and the read-only ones from the same toolset are, so the absence above is the write
    // ceiling rather than the whole toolset failing to register.
    report(
      "its read-only siblings are exposed",
      exposed.has("reai_get_warehouse_inventory") && exposed.has("reai_list_warehouses"),
      `${[...exposed].filter((n) => n.includes("warehouse")).length} warehouse tools visible`,
    );

    // 0b. Agreements. Changing terms is IRREVERSIBLE — the underlying PUT replaces the record
    //     — so the round-trip lives in smoke-full-write.mjs. What this suite proves is the
    //     ceiling: the tool is not exposed here, while its read-only siblings are.
    {
      const exposed = new Set((await client.listTools()).tools.map((tool) => tool.name));
      report(
        "reai_update_agreement is not exposed in reversible mode",
        !exposed.has("reai_update_agreement"),
        exposed.has("reai_update_agreement") ? "EXPOSED — it wraps a destructive PUT" : "hidden",
      );
      report(
        "the read-only agreement tools are exposed",
        exposed.has("reai_list_agreements") && exposed.has("reai_get_agreement"),
        `${[...exposed].filter((n) => n.includes("agreement")).length} agreement tools visible`,
      );
      // Creating one stays reversible: additive, and DELETE answers 204.
      const agRes = await client.callTool({
        name: "reai_request",
        arguments: {
          method: "POST",
          path: "/api/agreements/rent-agreement",
          body: {
            landlordName: `${STAMP} utleier`,
            tenantName: `${STAMP} leietaker`,
            monthlyRent: 12000,
            leaseDurationType: "indefinite",
          },
        },
      });
      const agreement = agRes.isError ? undefined : jsonOf(agRes);
      // The id field is `agreementId`, not `id`.
      if (Number.isInteger(agreement?.agreementId)) created.agreementId = agreement.agreementId;
      report(
        "a rent agreement can still be created in the default mode",
        !agRes.isError && Number.isInteger(created.agreementId),
        created.agreementId ? `agreementId=${created.agreementId}` : textOf(agRes).slice(0, 180),
      );
    if (created.agreementId) {
        const readRes = await client.callTool({
          name: "reai_get_agreement",
          arguments: { id: created.agreementId },
        });
        const wrapper = readRes.isError ? undefined : jsonOf(readRes);
        report(
          "reai_get_agreement finds the terms in the template sub-object",
          wrapper?.rentAgreement?.monthlyRent === 12000 && /under `rentAgreement`/.test(textOf(readRes)),
          readRes.isError ? textOf(readRes).slice(0, 160) : `rent=${wrapper?.rentAgreement?.monthlyRent}`,
        );
        const signersRes = await client.callTool({
          name: "reai_list_agreement_signers",
          arguments: { id: created.agreementId },
        });
        report(
          "reai_list_agreement_signers reads the object shape",
          !signersRes.isError && /Nobody has been asked to sign/.test(textOf(signersRes)),
          firstLineOf(textOf(signersRes)),
        );
      }
    }

    // 0c. Subscriptions had no live write coverage at all, which is a gap for the one thing in
    //     this API that invoices real people unattended. The property under test is the merge:
    //     change one field, and the lines and comments must survive.
    //
    //     outputMode create_order with automaticBillingGeneration false is the harmless
    //     configuration, and invoiceEmail is deliberately omitted — it is an invoice-delivery
    //     field, so setting it is refused in this mode, which the suite asserts below.
    const subCustRes = await client.callTool({
      name: "reai_create_customer",
      arguments: { name: `${STAMP} sub customer`, privateContact: true, skipRegistryLookup: true },
    });
    const subCustomer = subCustRes.isError ? undefined : jsonOf(subCustRes)?.id;
    // Recorded BEFORE the next remote call. It used to be assigned after the subscription work,
    // so a transport failure anywhere in between left the finally with nothing to delete and the
    // customer alive on the tenant. Note the cleanup-placement guard cannot see this: the key IS
    // referenced in the finally, and what was wrong was when it got set.
    if (Number.isInteger(subCustomer)) created.subscriptionCustomerId = subCustomer;
    if (Number.isInteger(subCustomer)) {
      const subRes = await client.callTool({
        name: "reai_create_subscription",
        arguments: {
          customerId: subCustomer,
          startDate: "2026-09-01",
          intervalMonths: 1,
          billingTiming: "in_advance",
          outputMode: "create_order",
          automaticBillingGeneration: false,
          daysUntilDue: 14,
          currencyCode: "NOK",
          invoiceComment: `${STAMP} invoice note`,
          internalComment: `${STAMP} internal note`,
          subscriptionLines: [
            // vatCode 0 because this tenant is not VAT-registered and the API allows only that.
            { rowNumber: 1, itemName: "ZZ line one", quantity: 2, unitPrice: 1500, vatCode: "0" },
            { rowNumber: 2, itemName: "ZZ line two", quantity: 1, unitPrice: 500, discount: 10, vatCode: "0" },
          ],
        },
      });
      if (!subRes.isError && Number.isInteger(jsonOf(subRes)?.id)) created.subscriptionId = jsonOf(subRes).id;
      report(
        "a subscription exists to edit",
        Number.isInteger(created.subscriptionId),
        created.subscriptionId ? `id=${created.subscriptionId}` : textOf(subRes).slice(0, 200),
      );

      if (created.subscriptionId) {
        const edit = await client.callTool({
          name: "reai_update_subscription",
          arguments: { id: created.subscriptionId, intervalMonths: 3 },
        });
        report("reai_update_subscription changes one field", !edit.isError, firstLineOf(textOf(edit)));

        const after = await client.callTool({
          name: "reai_get_subscription",
          arguments: { id: created.subscriptionId },
        });
        const sub = after.isError ? undefined : jsonOf(after);
        const survived =
          sub?.intervalMonths === 3 &&
          sub?.invoiceComment === `${STAMP} invoice note` &&
          sub?.internalComment === `${STAMP} internal note` &&
          sub?.lines?.length === 2 &&
          // Keyed on rowNumber, not position: the assertion should not depend on the API
          // returning lines in order.
          sub?.lines?.find((l) => l.rowNumber === 2)?.discount === 10;
        report(
          "the lines and comments survived an edit that replaces",
          survived,
          survived
            ? "interval changed; 2 lines, the discount and both comments intact"
            : `LOST — interval=${sub?.intervalMonths} lines=${sub?.lines?.length} ` +
              `discount=${sub?.lines?.[1]?.discount} comment=${JSON.stringify(sub?.invoiceComment)}`,
        );

        // Emptying the lines is a plausible wrong way to pause billing, and the refusal has to
        // reach the caller with the right alternative — through the schema AND the handler, which
        // is the path a client actually takes.
        const emptied = await client.callTool({
          name: "reai_update_subscription",
          arguments: { id: created.subscriptionId, subscriptionLines: [] },
        });
        report(
          "emptying the billing lines is refused, naming deactivate instead",
          emptied.isError === true && /reai_deactivate_subscription/.test(textOf(emptied)),
          firstLineOf(textOf(emptied)),
        );

        // An ARMED subscription's substance must not be editable with sending off. Arming it needs
        // full mode, so this suite cannot create an armed one — what it can prove is the other
        // half: on an UNARMED subscription the same change goes through, so the gate above is
        // scoped rather than blanket. The armed refusal itself is covered in the unit tests and in
        // smoke-full-write.
        const unarmedSubstance = await client.callTool({
          name: "reai_update_subscription",
          arguments: { id: created.subscriptionId, intervalMonths: 6 },
        });
        report(
          "changing the substance of an UNARMED subscription is ordinary work",
          !unarmedSubstance.isError,
          firstLineOf(textOf(unarmedSubstance)),
        );

        // And the invoice-delivery gate still bites on an explicit change in this mode.
        const delivery = await client.callTool({
          name: "reai_update_subscription",
          arguments: { id: created.subscriptionId, invoiceEmail: "zz@example.invalid" },
        });
        report(
          "changing where invoices are delivered is refused in reversible mode",
          delivery.isError === true && /delivered/.test(textOf(delivery)),
          firstLineOf(textOf(delivery)),
        );
      }
    }

    // 1. Create a customer. Private contact avoids a Brønnøysund lookup, so no
    //    real company gets attached to the test record.
    const createRes = await client.callTool({
      name: "reai_create_customer",
      arguments: {
        name: STAMP,
        privateContact: true,
        email: "smoke-test@example.invalid",
        skipRegistryLookup: true,
      },
    });
    // Only adopt an id from a SUCCESSFUL create. An error body could contain an
    // `id` of its own, and this value is what the cleanup block deletes.
    const customer = createRes.isError ? undefined : jsonOf(createRes);
    if (Number.isInteger(customer?.id)) created.customerId = customer.id;
    report(
      "reai_create_customer",
      !createRes.isError && Number.isInteger(created.customerId),
      created.customerId ? `id=${created.customerId}` : textOf(createRes).slice(0, 220),
    );
    if (!created.customerId) {
      // A create that succeeded but whose id we failed to parse leaves a real
      // record behind that cleanup cannot reach — say so loudly rather than
      // exiting quietly.
      if (!createRes.isError) {
        report(
          "customer id could be parsed from the create response",
          false,
          `A customer WAS created in tenant ${tenantId} but its id could not be read, so it ` +
            `cannot be cleaned up automatically. Find and remove it by hand: name starts "${STAMP}".`,
        );
      }
      throw new Error("cannot continue without a customer id");
    }

    // 2. Read it back.
    const getRes = await client.callTool({
      name: "reai_get_customer",
      arguments: { id: created.customerId },
    });
    report(
      "reai_get_customer returns what was created",
      !getRes.isError && containsStamp(textOf(getRes)),
      containsStamp(textOf(getRes)) ? "name matches (ReAI title-cases it)" : textOf(getRes).slice(0, 220),
    );

    // 3. It appears in the list.
    const listRes = await client.callTool({
      name: "reai_list_customers",
      arguments: { name: STAMP },
    });
    report(
      "reai_list_customers finds it by name",
      !listRes.isError && containsStamp(textOf(listRes)),
      textOf(listRes).split("\n")[0],
    );

    // 4. Update it.
    const patchRes = await client.callTool({
      name: "reai_update_customer",
      arguments: { id: created.customerId, phone: "22334455", daysUntilDue: 30 },
    });
    report("reai_update_customer", !patchRes.isError, textOf(patchRes).slice(0, 120));

    // 5. An empty update should be refused locally, not sent as a no-op.
    const emptyRes = await client.callTool({
      name: "reai_update_customer",
      arguments: { id: created.customerId },
    });
    report(
      "an empty update is rejected before it is sent",
      /Nothing to update/i.test(textOf(emptyRes)),
      textOf(emptyRes).slice(0, 120),
    );

    // 6. Set an address.
    const addrRes = await client.callTool({
      name: "reai_set_customer_address",
      arguments: {
        id: created.customerId,
        addressPart1: "Testveien 1",
        city: "Oslo",
        postalCode: "0150",
        countryCode: "NO",
      },
    });
    report("reai_set_customer_address", !addrRes.isError, textOf(addrRes).slice(0, 120));

    // 7. Offer round-trip. This exists because offer lines are STRICTER than
    //    order lines — OfferLineReq requires itemName and vatCode — so a
    //    line shaped like an order line 400s here. Regression cover for that.
    const vatRes = await client.callTool({
      name: "reai_list_vat_codes",
      arguments: { usage: "customer-invoice" },
    });
    const vatCode = /"code":\s*"([^"]+)"/.exec(textOf(vatRes))?.[1];
    report("a customer-invoice VAT code is available", Boolean(vatCode), `code=${vatCode}`);

    if (vatCode) {
      const offerRes = await client.callTool({
        name: "reai_create_offer",
        arguments: {
          customerId: created.customerId,
          offerLines: [
            { itemName: "Smoke test line", quantity: 2, unitPrice: 1500, vatCode },
          ],
        },
      });
      const offer = offerRes.isError ? undefined : jsonOf(offerRes);
      if (Number.isInteger(offer?.id)) created.offerId = offer.id;
      report(
        "reai_create_offer with a properly shaped offer line",
        !offerRes.isError && Number.isInteger(created.offerId),
        created.offerId ? `id=${created.offerId}` : textOf(offerRes).slice(0, 260),
      );

      // Payment terms should come from the customer record (30 days, set above),
      // not the hardcoded 14-day fallback.
      report(
        "payment terms are taken from the customer, not defaulted to 14",
        /terms 30 days .*customer's default/.test(textOf(offerRes)),
        (textOf(offerRes).match(/payment terms[^.]*/i) ?? ["(no terms note)"])[0],
      );

      const listOffersRes = await client.callTool({ name: "reai_list_offers", arguments: {} });
      report(
        "reai_list_offers sees it",
        !listOffersRes.isError && /offer\(s\)/.test(textOf(listOffersRes)),
        textOf(listOffersRes).split("\n")[0],
      );
    }

    // 7b. Supplier round-trip: create, read back, update bank details, delete.
    const supRes = await client.callTool({
      name: "reai_create_supplier",
      arguments: { name: `${STAMP} supplier`, privateContact: true, skipRegistryLookup: true },
    });
    const supplier = supRes.isError ? undefined : jsonOf(supRes);
    if (Number.isInteger(supplier?.id)) created.supplierId = supplier.id;
    report(
      "reai_create_supplier",
      !supRes.isError && Number.isInteger(created.supplierId),
      created.supplierId ? `id=${created.supplierId}` : textOf(supRes).slice(0, 240),
    );
    if (!created.supplierId && !supRes.isError) {
      report(
        "supplier id could be parsed from the create response",
        false,
        `A supplier WAS created in tenant ${tenantId} but its id could not be read, so cleanup ` +
          `cannot reach it. Remove it by hand: name starts "${STAMP}".`,
      );
    }

    if (created.supplierId) {
      // Bank details are the one part of this tool that is NOT reversible in effect: the
      // record can be changed back, but whoever pays this supplier next sends money to
      // whatever account is on file, quite possibly a person in the ReAI UI weeks later.
      // So the call escalates to irreversible and `reversible` mode must refuse it —
      // this assertion used to expect it to succeed, which is what the tool's own
      // description promised and nothing enforced.
      const supPatch = await client.callTool({
        name: "reai_update_supplier",
        arguments: { id: created.supplierId, bankAccountNumber: "15201353103" },
      });
      const bankRefused = supPatch.isError && /where money is sent/i.test(textOf(supPatch));
      report(
        "reai_update_supplier REFUSES bank details in reversible mode",
        bankRefused,
        bankRefused ? "escalated to irreversible, as it should be" : textOf(supPatch).slice(0, 160),
      );

      // The rest of the tool is ordinary master data and must still work.
      const supRename = await client.callTool({
        name: "reai_update_supplier",
        arguments: { id: created.supplierId, email: "smoke@example.invalid" },
      });
      report(
        "reai_update_supplier still edits ordinary fields",
        !supRename.isError,
        textOf(supRename).slice(0, 120),
      );

      const supGet = await client.callTool({
        name: "reai_get_supplier",
        arguments: { id: created.supplierId },
      });
      report(
        "reai_get_supplier returns it",
        !supGet.isError && containsStamp(textOf(supGet)),
        containsStamp(textOf(supGet)) ? "name matches" : textOf(supGet).slice(0, 200),
      );

      // The address merge, on a real supplier: change the street, keep the postcode. The PUT
      // underneath replaces, and its required set does not include postalCode or province.
      const fullAddr = await client.callTool({
        name: "reai_set_supplier_address",
        arguments: {
          id: created.supplierId,
          addressPart1: "Gata 1",
          addressPart2: "Oppgang B",
          postalCode: "0150",
          city: "Oslo",
          province: "Oslo",
          countryCode: "NO",
        },
      });
      report("reai_set_supplier_address sets a full address", !fullAddr.isError, firstLineOf(textOf(fullAddr)));
      const streetOnly = await client.callTool({
        name: "reai_set_supplier_address",
        arguments: { id: created.supplierId, addressPart1: "Gata 2" },
      });
      const supAfter = await client.callTool({
        name: "reai_get_supplier",
        arguments: { id: created.supplierId },
      });
      const addr = supAfter.isError ? undefined : jsonOf(supAfter)?.address;
      report(
        "changing the street kept the postcode and province",
        !streetOnly.isError &&
          addr?.addressPart1 === "Gata 2" &&
          addr?.postalCode === "0150" &&
          addr?.province === "Oslo" &&
          addr?.addressPart2 === "Oppgang B",
        addr ? JSON.stringify(addr) : firstLineOf(textOf(streetOnly)),
      );
    }

    // 7c. Reconciliation rules moved to irreversible: a rule is standing authority
    //     to post, and deleting it does not reverse what it booked. So in this
    //     mode both the tool and the raw path must be refused.
    const ruleTools = new Set((await client.listTools()).tools.map((t) => t.name));
    report(
      "reconciliation rule write tools are hidden in reversible mode",
      !ruleTools.has("reai_create_reconciliation_rule") &&
        !ruleTools.has("reai_delete_reconciliation_rule"),
      [...ruleTools].filter((n) => /reconciliation_rule/.test(n)).join(", ") || "hidden",
    );
    report(
      "reading rules is still available",
      ruleTools.has("reai_list_reconciliation_rules"),
      ruleTools.has("reai_list_reconciliation_rules") ? "present" : "MISSING",
    );

    // 8. The things this mode must refuse. These matter more than the successes:
    //    they are the guarantee the consent page and README advertise.
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    report(
      "ledger and invoicing tools are not advertised",
      !names.has("reai_create_voucher") &&
        !names.has("reai_create_invoice_from_order") &&
        !names.has("reai_register_invoice_payment"),
      "hidden",
    );

    for (const [label, args] of [
      ["POST /api/vouchers", { method: "POST", path: "/api/vouchers", body: { date: "2026-01-01", postings: [] } }],
      ["POST /api/invoices", { method: "POST", path: "/api/invoices", body: { orderId: 1 } }],
      ["POST /api/vat-returns", { method: "POST", path: "/api/vat-returns", body: {} }],
      ["POST /api/users", { method: "POST", path: "/api/users", body: {} }],
      ["POST /api/supplier-invoices", { method: "POST", path: "/api/supplier-invoices", body: { supplierId: 1, costLines: [] } }],
      ["POST /api/expenses/1/voucher", { method: "POST", path: "/api/expenses/1/voucher", body: {} }],
      ["POST /api/bank-reconciliations/1/apply-rules", { method: "POST", path: "/api/bank-reconciliations/1/apply-rules", body: { month: "2026-08" } }],
      ["POST /api/reconciliation-rules", { method: "POST", path: "/api/reconciliation-rules", body: { matchText: "X", accountNumber: "7710", description: "X" } }],
    ]) {
      const res = await client.callTool({ name: "reai_request", arguments: { ...args, tenantId } });
      const blocked = res.isError === true && /write policy/i.test(textOf(res));
      report(`escape hatch refuses ${label}`, blocked, blocked ? "blocked" : textOf(res).slice(0, 160));
    }
  } finally {
    // 9. Clean up whatever was created, even if an assertion above threw.
    //    Offer first: it references the customer.
    if (created.offerId) {
      try {
        const res = await client.callTool({
          name: "reai_request",
          arguments: { method: "DELETE", path: `/api/offers/${created.offerId}`, tenantId },
        });
        report("the test offer is deleted", !res.isError, textOf(res).slice(0, 120));
      } catch (err) {
        report("offer cleanup", false, `remove offer ${created.offerId} by hand: ${err}`);
      }
    }
    if (created.supplierId) {
      try {
        const res = await client.callTool({
          name: "reai_delete_supplier",
          arguments: { id: created.supplierId },
        });
        report("the test supplier is deleted", !res.isError, textOf(res).slice(0, 120));

        const after = await client.callTool({
          name: "reai_get_supplier",
          arguments: { id: created.supplierId },
        });
        const remaining = after.isError === true ? undefined : jsonOf(after);
        const goneOrArchived = after.isError === true || remaining?.archived === true;
        report(
          "the test supplier is gone or archived afterwards",
          goneOrArchived,
          goneOrArchived ? "verified" : `STILL ACTIVE — clean up supplier ${created.supplierId} by hand`,
        );
      } catch (err) {
        report("supplier cleanup", false, `remove supplier ${created.supplierId} by hand: ${err}`);
      }
    }
      if (created.subscriptionId) {
      try {
        const delRes = await client.callTool({
          name: "reai_delete_subscription",
          arguments: { id: created.subscriptionId },
        });
        report("reai_delete_subscription cleans up", !delRes.isError, firstLineOf(textOf(delRes)));
      } catch (err) {
        report("subscription cleanup", false, `remove subscription ${created.subscriptionId} by hand: ${err}`);
      }
    }
    if (created.subscriptionCustomerId) {
      try {
        const delRes = await client.callTool({
          name: "reai_delete_customer",
          arguments: { id: created.subscriptionCustomerId },
        });
        report("its customer is cleaned up too", !delRes.isError, firstLineOf(textOf(delRes)));
      } catch (err) {
        report("subscription customer cleanup", false, `remove customer ${created.subscriptionCustomerId} by hand: ${err}`);
      }
    }
    if (created.agreementId) {
      try {
        const delRes = await client.callTool({
          name: "reai_delete_agreement",
          arguments: { id: created.agreementId },
        });
        report("reai_delete_agreement cleans up", !delRes.isError, firstLineOf(textOf(delRes)));
        // 204 with no body, so the list is the only confirmation available.
        const after = await client.callTool({ name: "reai_list_agreements", arguments: {} });
        const gone = after.isError !== true && !textOf(after).includes(String(created.agreementId));
        report(
          "the test agreement is gone afterwards",
          gone,
          gone ? "verified" : `STILL PRESENT — delete agreement ${created.agreementId} by hand`,
        );
      } catch (err) {
        report("agreement cleanup", false, `remove agreement ${created.agreementId} by hand: ${err}`);
      }
    }
    if (created.warehouseId) {
      try {
        const delRes = await client.callTool({
          name: "reai_delete_warehouse",
          arguments: { warehouseId: created.warehouseId },
        });
        // An empty warehouse is deleted outright; one holding stock is archived instead.
        // This one never held any, so anything but "deleted" is worth seeing.
        const outcome = delRes.isError ? undefined : jsonOf(delRes)?.outcome;
        report(
          "reai_delete_warehouse cleans up",
          !delRes.isError && outcome === "deleted",
          outcome ? `outcome=${outcome}` : textOf(delRes).slice(0, 160),
        );

        const after = await client.callTool({
          name: "reai_get_warehouse",
          arguments: { id: created.warehouseId },
        });
        const remaining = after.isError === true ? undefined : jsonOf(after);
        const goneOrArchived = after.isError === true || remaining?.archived === true;
        report(
          "the test warehouse is gone or archived afterwards",
          goneOrArchived,
          goneOrArchived ? "verified" : `STILL ACTIVE — clean up warehouse ${created.warehouseId} by hand`,
        );
      } catch (err) {
        report("warehouse cleanup", false, `remove warehouse ${created.warehouseId} by hand: ${err}`);
      }
    }
    if (created.customerId) {
      try {
        const delRes = await client.callTool({
          name: "reai_delete_customer",
          arguments: { id: created.customerId },
        });
        report(
          "reai_delete_customer cleans up",
          !delRes.isError,
          textOf(delRes).slice(0, 160),
        );

        // Confirm it is really gone (or archived, which ReAI does when the
        // record already has transactions).
        const after = await client.callTool({
          name: "reai_get_customer",
          arguments: { id: created.customerId },
        });
        // Parse rather than pattern-match: CustomerRes always carries an
        // `archived` field, so a regex for /archived/ also matches
        // `"archived": false` and the warning branch became unreachable.
        const stillThere = after.isError === true ? undefined : jsonOf(after);
        const goneOrArchived = after.isError === true || stillThere?.archived === true;
        report(
          "the test customer is gone or archived afterwards",
          goneOrArchived,
          goneOrArchived ? "verified" : `STILL ACTIVE — clean up id ${created.customerId} by hand`,
        );
      } catch (err) {
        report("cleanup", false, `FAILED — remove customer ${created.customerId} by hand: ${err}`);
      }
    }
    await client.close();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nWrite smoke test crashed:", err);
  process.exit(1);
});
