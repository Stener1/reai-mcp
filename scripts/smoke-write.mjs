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

// A marker that makes anything this script leaves behind obvious in the UI.
const STAMP = `reai-mcp smoke ${new Date().toISOString().replace(/[:.]/g, "-")}`;

/**
 * ReAI normalizes customer names to title case on save, so a round-trip
 * comparison has to be case-insensitive.
 */
const containsStamp = (text) => text.toLowerCase().includes(STAMP.toLowerCase());

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

  const created = { customerId: undefined, offerId: undefined, supplierId: undefined };

  try {
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
      const supPatch = await client.callTool({
        name: "reai_update_supplier",
        arguments: { id: created.supplierId, bankAccountNumber: "15201353103" },
      });
      report("reai_update_supplier sets bank details", !supPatch.isError, textOf(supPatch).slice(0, 120));

      const supGet = await client.callTool({
        name: "reai_get_supplier",
        arguments: { id: created.supplierId },
      });
      report(
        "reai_get_supplier returns it",
        !supGet.isError && containsStamp(textOf(supGet)),
        containsStamp(textOf(supGet)) ? "name matches" : textOf(supGet).slice(0, 200),
      );
    }

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
