import { z } from "zod";
import { defineTool, ok, requiredName, requireTenantId, tenantIdArg, type ToolDef } from "./registry.js";

/**
 * The fixed-asset register (anleggsmidler).
 *
 * What each operation actually does was established by running it against the test tenant
 * rather than read off the document, and the answer was not what the document implies.
 * On an asset with no accounting history behind it — created straight into the register —
 * NONE of create, set-depreciation or write-off posts a voucher. Measured before and
 * after each call: 0 vouchers throughout, and DELETE answered `{"outcome":"deleted"}`
 * with the register back to empty.
 *
 * The linked case is the one that matters and is NOT verified. The API's own DELETE
 * description says that when an asset has a linked acquisition voucher, that voucher is
 * "deleted when possible or reversed when accounting history must be retained" — so the
 * same call that is inert on a bare entry reaches into the ledger on a real one. Producing
 * that state needs an acquisition booked against an asset, which the reachable tenants
 * have no data for.
 *
 * So every write here stays `irreversible`, which is where the policy already had them.
 * Two reasons, and the first is the weaker one:
 *
 * - DELETE can reverse a posted voucher, and write-off disposes of a carrying value.
 * - An asset carries a depreciation schedule, and depreciation posts. That makes creating
 *   one standing authority to post later — the same reasoning this server already applies
 *   to reconciliation rules, which are irreversible for exactly that reason even though
 *   creating one posts nothing at the moment you create it.
 */

/** Balance-sheet account. The spec pins the pattern, so reject early with the reason. */
const balanceSheetAccount = z
  .string()
  .regex(
    /^1\d{3}$/,
    "A fixed asset must sit on a balance-sheet account: four digits starting with 1. " +
      "The API pins this to /1\\d{3}/ and rejects anything else.",
  );

const listAssets = defineTool({
  name: "reai_list_assets",
  title: "List fixed assets",
  description:
    "The fixed-asset register: what the company owns and carries on the balance sheet, with " +
    "each asset's account, acquisition cost and depreciation schedule.",
  risk: "read",
  apiPaths: [["GET", "/api/assets"]],
  inputSchema: { tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/assets",
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    if (!Array.isArray(res.data)) {
      return ok(res.data, {
        note:
          "The assets endpoint did not return a list. The response is passed through unchanged " +
          "— do NOT read this as 'no assets'.",
      });
    }
    return ok(res.data, {
      note:
        res.data.length === 0
          ? "The fixed-asset register is empty. That means no assets are registered, not that " +
            "the company owns nothing — anything expensed rather than capitalised never appears here."
          : `${res.data.length} fixed asset(s).`,
    });
  },
});

const getAsset = defineTool({
  name: "reai_get_asset",
  title: "Get one fixed asset",
  description: "One asset by id: its account, acquisition cost and date, and depreciation schedule.",
  risk: "read",
  apiPaths: [["GET", "/api/assets/{id}"]],
  inputSchema: {
    assetId: z.number().int().positive().describe("Asset id, from reai_list_assets."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "GET",
      path: `/api/assets/${args.assetId}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data);
  },
});

const createAsset = defineTool({
  name: "reai_create_asset",
  title: "Register a fixed asset",
  description:
    "Add an asset to the fixed-asset register, on a balance-sheet account, with the depreciation " +
    "schedule it will follow.\n\n" +
    "Measured against the live API: this posts NO voucher of its own — the register entry and any " +
    "acquisition booking are separate things. It is still classified irreversible, because the " +
    "depreciation schedule it sets up is standing authority to post later, the same reason a " +
    "reconciliation rule is irreversible. Requires REAI_WRITE_MODE=full.\n\n" +
    "usefulLifeInMonths drives linear depreciation; use depreciationMethod 'manual' when the " +
    "schedule is not straight-line and you intend to post depreciation yourself.",
  risk: "irreversible",
  apiPaths: [["POST", "/api/assets"]],
  inputSchema: {
    name: requiredName().describe("What the asset is."),
    accountNumber: balanceSheetAccount.describe(
      "Balance-sheet account to carry it on, from reai_list_accounts — 1200 for machinery and " +
        "equipment, 1250 for other operating equipment, and so on.",
    ),
    acquisitionDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use yyyy-MM-dd.")
      .optional()
      .describe("When it was acquired. Depreciation runs from here."),
    acquisitionCost: z.number().optional().describe("What it cost, in the company's currency."),
    usefulLifeInMonths: z
      .number()
      .int()
      .positive()
      .describe("Depreciation period in MONTHS, not years — 5 years is 60."),
    depreciationMethod: z
      .enum(["linear", "manual"])
      .describe("'linear' for straight-line; 'manual' when you post depreciation yourself."),
    description: z.string().optional().describe("Free text."),
    currencyCode: z.string().optional().describe("Defaults to the company's currency."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...body } = args;
    const res = await ctx.client.request<{ id?: number }>({
      method: "POST",
      path: "/api/assets",
      body,
      tenantId: requireTenantId(tenantId, ctx),
    });
    return ok(res.data, {
      note:
        `Registered asset ${res.data?.id ?? "?"} on account ${args.accountNumber}. No voucher was ` +
        `posted by this call — book the acquisition separately if it is not already in the ledger.`,
    });
  },
});

const setAssetDepreciation = defineTool({
  name: "reai_set_asset_depreciation",
  title: "Change an asset's depreciation schedule",
  description:
    "Replace an asset's depreciation method and useful life. Both fields are required — this is " +
    "a full replacement of the schedule, not a patch.\n\n" +
    "Measured against the live API: changing the schedule posts no voucher by itself. What it " +
    "changes is every future depreciation posting for this asset, which is why it needs " +
    "REAI_WRITE_MODE=full. Shortening the useful life of an asset already part-way through its " +
    "life increases the charge in every remaining period.",
  risk: "irreversible",
  apiPaths: [["PUT", "/api/assets/{id}/depreciation"]],
  inputSchema: {
    assetId: z.number().int().positive().describe("Asset id."),
    usefulLifeInMonths: z.number().int().positive().describe("Depreciation period in MONTHS."),
    depreciationMethod: z.enum(["linear", "manual"]).describe("'linear' or 'manual'."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "PUT",
      path: `/api/assets/${args.assetId}/depreciation`,
      body: {
        usefulLifeInMonths: args.usefulLifeInMonths,
        depreciationMethod: args.depreciationMethod,
      },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data, {
      note:
        `Asset ${args.assetId} now depreciates ${args.depreciationMethod} over ` +
        `${args.usefulLifeInMonths} month(s). Future depreciation follows the new schedule.`,
    });
  },
});

const writeOffAsset = defineTool({
  name: "reai_write_off_asset",
  title: "Write off a fixed asset",
  description:
    "Write an asset off — the accounting act of removing its remaining carrying value, for " +
    "something scrapped, lost or sold. Takes no arguments beyond the asset: the API decides the " +
    "amount from what is left on the books.\n\n" +
    "On an asset with no accounting history this was measured to post nothing, which is the only " +
    "case that could be verified here. On one carrying value it disposes of that value, and that " +
    "is a real posting — so REAI_WRITE_MODE=full, and check the asset's carrying amount before " +
    "calling rather than after.",
  risk: "irreversible",
  destructive: true,
  apiPaths: [["POST", "/api/assets/{id}/write-off"]],
  inputSchema: {
    assetId: z.number().int().positive().describe("Asset id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "POST",
      path: `/api/assets/${args.assetId}/write-off`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data, {
      note:
        `Wrote off asset ${args.assetId}. The asset stays in the register — write-off removes the ` +
        `carrying value, it does not delete the record.`,
    });
  },
});

const deleteAsset = defineTool({
  name: "reai_delete_asset",
  title: "Delete a fixed asset",
  description:
    "Remove an asset from the register. This is NOT only a register edit: the API's own " +
    "description says that if the asset has a linked acquisition voucher, that voucher is " +
    "deleted when possible, or REVERSED when accounting history has to be retained. So a call " +
    "that looks like tidying master data can put a reversing entry in the ledger.\n\n" +
    "On an asset with no linked voucher it was measured to be clean: outcome 'deleted', no " +
    "change to the voucher count. Prefer reai_write_off_asset for something the company actually " +
    "had and no longer has — deleting the record erases the history instead of recording the " +
    "disposal.",
  risk: "irreversible",
  destructive: true,
  apiPaths: [["DELETE", "/api/assets/{id}"]],
  inputSchema: {
    assetId: z.number().int().positive().describe("Asset id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<{ outcome?: string }>({
      method: "DELETE",
      path: `/api/assets/${args.assetId}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const outcome = res.data?.outcome;
    // The spec's description says the body is always {"outcome":"deleted"}, but the response
    // schema is the shared ApiLifecycleOutcomeRes whose enum also contains "reversed". Only
    // "deleted" has been observed, on an asset with no linked voucher — so report whatever
    // arrives rather than restating the description.
    const note =
      outcome === "reversed"
        ? `Asset ${args.assetId} was removed and its acquisition voucher REVERSED — a counter-entry ` +
          `is now in the ledger, because the accounting history had to be retained.`
        : outcome === "deleted"
          ? `Asset ${args.assetId} deleted. Any linked acquisition voucher was deleted with it.`
          : `Asset ${args.assetId} removed; the API reported outcome ${JSON.stringify(outcome)}. ` +
            `Check the ledger before assuming nothing was posted.`;
    return ok(res.data ?? { outcome }, { note });
  },
});

export const assetTools: ToolDef[] = [
  listAssets,
  getAsset,
  createAsset,
  setAssetDepreciation,
  writeOffAsset,
  deleteAsset,
];
