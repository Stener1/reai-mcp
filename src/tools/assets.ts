import { z } from "zod";
import { defineTool, ok, okList, requiredName, requireTenantId, tenantIdArg, type ToolDef } from "./registry.js";

/**
 * The fixed-asset register (anleggsmidler).
 *
 * What these operations do was established by running them against the test tenant, and
 * two things came out of that which the API's own document gets wrong.
 *
 * ## Deleting a referenced asset is refused, not reversed
 *
 * The DELETE description says a linked acquisition voucher is "deleted when possible or
 * reversed when accounting history must be retained". It is neither. With a posted voucher
 * referencing the asset, the call answers:
 *
 *   409  Asset with id 237 is used in existing vouchers and cannot be deleted
 *
 * Nothing is deleted and nothing is reversed. That is a better guarantee than the document
 * promises — there is no path here that quietly puts a counter-entry in the ledger — and
 * the tool says so rather than repeating the warning the spec invites.
 *
 * ## None of these post a voucher
 *
 * Create, set-depreciation and write-off post nothing, measured before and after each call
 * on an asset with no accounting history. Worth recording HOW that was established, because
 * the first attempt got the right answer for the wrong reason: the probe listed vouchers
 * with `fromDate`/`toDate`, the API answered 400 "startDate is required", and the script
 * turned that error into an empty array. Every "0 vouchers" it printed was an error counted
 * as zero — the same absence-read-as-zero failure this server exists to prevent, in the
 * harness measuring it. Re-run with a lister that throws on a non-200, the counts hold.
 *
 * ## Why the writes are still irreversible
 *
 * Not because of a depreciation-posting mechanism: no operation in this API posts
 * depreciation at all, so calling an asset "standing authority to post" would be an
 * analogy with nothing behind it. The honest reasons are narrower. `/api/assets` has been
 * in IRREVERSIBLE_PREFIXES since the first commit, so this was never a live choice. And
 * write-off on an asset that actually carries value is unverified — producing one needs a
 * posted acquisition, and an asset with one cannot be cleaned up afterwards, per the 409
 * above. Failing closed on the unverified case is this classifier's stated default.
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
    return okList(res.data, {
      noun: "fixed asset",
      suffix: ".",
      empty:
        "The fixed-asset register is empty. That means no assets are registered, not that " +
        "the company owns nothing — anything expensed rather than capitalised never appears here.",
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
    id: z.number().int().positive().describe("Asset id, from reai_list_assets."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "GET",
      path: `/api/assets/${args.id}`,
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
    "acquisition booking are separate things, so capitalising something already in the ledger " +
    "will not double-book it, and this will not book it for you either.\n\n" +
    "Requires REAI_WRITE_MODE=full, which is where /api/assets has always sat. Not because " +
    "creating one posts anything — it does not — but because the surrounding operations were not " +
    "all verifiable, and this classifier fails closed on what it has not seen.",
  risk: "irreversible",
  apiPaths: [["POST", "/api/assets"]],
  inputSchema: {
    name: requiredName(255).describe("What the asset is. The API caps this at 255 characters."),
    accountNumber: balanceSheetAccount.describe(
      "Balance-sheet account to carry it on, from reai_list_accounts. Read from the live chart " +
        "of accounts: 1150 Tomter (land, never depreciated), 1200 Maskiner og anlegg, 1250 " +
        "Inventar, verktøy o.l., 1290 Andre driftsmidler, 1292 Andre ikke avskrivbare eiendeler.",
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
      .optional()
      .describe(
        "Depreciation period in MONTHS, not years — 5 years is 60. Optional: the API accepts " +
          "an asset with no schedule, which is what land and other non-depreciable assets need.",
      ),
    depreciationMethod: z
      .enum(["linear", "manual"])
      .optional()
      .describe(
        "'linear' for straight-line; 'manual' when you post depreciation yourself. Omit for a " +
          "non-depreciable asset. Note that a manual voucher can only be posted against an asset " +
          "whose method is 'manual' — the API refuses with 409 otherwise.",
      ),
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
    "governs is how this asset depreciates from here, which is why it needs " +
    "REAI_WRITE_MODE=full. How the API redistributes depreciation over a shortened life — " +
    "spread across the remaining periods, or caught up at once — is NOT established here, so " +
    "check the resulting schedule rather than assuming either.",
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
    "Write an asset off — the accounting act for something scrapped, lost or sold. Takes no " +
    "arguments beyond the asset.\n\n" +
    "What it does on an asset that carries value is NOT established here: on one with no " +
    "accounting history it was measured to post nothing and to leave the record readable, and " +
    "that is the only case that could be produced. The API documents neither this endpoint nor " +
    "its effect, and AssetRes carries no carrying-value or written-off field to read the result " +
    "from. Treated as irreversible for that reason — check the ledger afterwards.",
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
        `Called write-off on asset ${args.assetId}; the API returned the asset record, so it is ` +
        `still in the register. What was posted, if anything, is not visible in this response — ` +
        `check the ledger for this asset's account.`,
    });
  },
});

const deleteAsset = defineTool({
  name: "reai_delete_asset",
  title: "Delete a fixed asset",
  description:
    "Remove an asset from the register. Only possible while nothing references it: with a " +
    "posted voucher against the asset the API answers 409 \"Asset with id N is used in existing " +
    "vouchers and cannot be deleted\", and nothing is changed.\n\n" +
    "That contradicts the API's own description, which says a linked acquisition voucher is " +
    "deleted or REVERSED — it is not, it is refused. Verified by booking a voucher against an " +
    "asset and deleting it. The practical consequence is the good one: this cannot put a " +
    "counter-entry in the ledger behind your back.\n\n" +
    "Prefer reai_write_off_asset for something the company actually had and no longer has — " +
    "deleting the record erases the history instead of recording the disposal.",
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
    // The response schema is the shared ApiLifecycleOutcomeRes, whose enum is
    // deleted | archived | reversed. Only "deleted" has been observed here, and a referenced
    // asset is refused outright rather than archived or reversed — but all three are reported
    // distinctly, because "removed" is false for an archived record and silence about a
    // reversal is the worst of the three to get wrong.
    const note =
      outcome === "archived"
        ? `Asset ${args.assetId} was ARCHIVED, not deleted — the record is kept and hidden from ` +
          `the active register. It still exists in the books.`
        : outcome === "reversed"
          ? `Asset ${args.assetId} was removed and a linked voucher REVERSED — a counter-entry is ` +
            `now in the ledger. This has not been observed; check the ledger.`
          : outcome === "deleted"
            // Says nothing about a voucher. `outcome` reports what happened to the ASSET, and
            // the enum does not establish that it describes the acquisition voucher too — so
            // inferring "nothing referenced it" from "deleted" would generalise one observed
            // case (a manual posting line, refused with 409) over a path the endpoint's own
            // description contemplates and that could not be produced here.
            ? `Asset ${args.assetId} deleted. That is the outcome for the ASSET; if it had an ` +
              `acquisition booked, check the ledger — a manual posting referencing an asset makes ` +
              `this call fail with 409 instead, but the API documents a reversal path that could ` +
              `not be reproduced.`
            : `Asset ${args.assetId}: the API reported outcome ${JSON.stringify(outcome)}. ` +
              `Check the register and the ledger before assuming what happened.`;
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
