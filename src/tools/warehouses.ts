import { z } from "zod";
import {
  asScalar,
  confirmAgainstResponse,
  defineTool,
  describeConfirmation,
  describeShape,
  isRecord,
  fail,
  ok,
  okList,
  requiredName,
  requireTenantId,
  tenantIdArg,
  type ToolDef,
} from "./registry.js";

/**
 * Warehouses and stock on hand (lager).
 *
 * Everything below was measured against test tenant 2783 by creating a warehouse and a stock
 * product with one variant, adjusting stock, and reading the ledger before and after with a
 * voucher lister that throws on a non-200. Four results are worth having in the tool text
 * because the API states none of them and two of them fail silently.
 *
 * ## An adjustment without variantId is accepted and changes nothing
 *
 * The worst of the four, and the reason `variantId` is REQUIRED by this tool although the API
 * marks it optional. Omitting it on a product that has variants answers 200 with a real
 * `transactionId` — and moves no stock at all:
 *
 *   POST /api/warehouses/inventory/adjust {productId, warehouseId, quantityChange: 3}
 *     → 200 {"transactionId":147036, "variantId":null, "quantityChange":3, "quantityOnHand":0}
 *
 * Four such calls in a row (net +12) left `quantityOnHand` at 0 and `stockValue` at 0. The
 * response is honest — `quantityOnHand` is the truth and `variantId` comes back null — but
 * nothing in the status code or the transaction id says the write was a no-op.
 *
 * Nothing that can hold stock is exempt: the API refuses a stock product with no variants
 * (see the `stock-product-needs-a-variant` quirk), so there is no adjustment worth making
 * that omits the field. Requiring it removes the failure mode instead of detecting it.
 *
 * Two checks sit either side of the write. Before: the variant must be one of the
 * warehouse's stock lines, which also supplies the quantity to measure against. After: the
 * API echoes the variant it acted on, and a null echo against a variant that was sent is the
 * no-op signature — that one needs nothing from the pre-read, so it still holds when the
 * inventory response cannot be read or matched.
 *
 * Note the field name that made this easy to hit: a variant in ProductRes is keyed
 * `variantId`, not `id`. Reading `.id` yields undefined, `JSON.stringify` drops it, and the
 * call silently becomes the no-op above. That is exactly how it was hit here.
 *
 * ## occurredAt must be a full timestamp
 *
 * `format: date-time`, and it means it. A date-only value is rejected by the deserialiser
 * before any field validation runs, so the error names no field:
 *
 *   occurredAt: "2026-08-01"              → 400 {"detail":"Failed to read request"}
 *   occurredAt: "2026-08-01T10:00:00Z"    → 200
 *   occurredAt: "2026-08-01T10:00:00+02:00" → 200, echoed back as "2026-08-01T08:00:00Z"
 *
 * Every other date argument in this server is `yyyy-MM-dd`, so this tool accepts that form
 * too and appends the time itself rather than passing on a 400 that explains nothing.
 *
 * ## Stock goes negative, and no adjustment reaches the ledger
 *
 * Adjusting -10 against 4 on hand is accepted: on-hand -6, stockValue -600. There is no
 * refusal and no clamp. And vouchers stayed at 0 across every adjustment measured — stock
 * value is not in the books, so an adjustment is not a posting.
 *
 * ## Why the adjustment is still irreversible
 *
 * There is no route that lists or deletes a stock transaction: transactions/{id} and
 * adjust/{id} both 404 on DELETE, and GET transactions 404s. The only correction is an
 * opposite adjustment, which leaves both movements in the history. `/api/warehouses/inventory
 * /adjust` was also already the one entry under `/api/warehouses` in IRREVERSIBLE_PREFIXES,
 * ahead of this toolset; the rest of `/api/warehouses` is in the reversible list.
 */

/** The API's own field name, and the one to pass back. Documented because `.id` is the trap. */
const VARIANT_ID_FIELD = "variantId";

type InventoryRow = {
  productId?: number;
  productTitle?: string;
  variantId?: number | null;
  sku?: string;
  quantityOnHand?: number;
  stockUnitCost?: number;
  retailUnitPrice?: number;
  stockValue?: number;
};

type InventoryRes = {
  warehouseId?: number | null;
  rows?: InventoryRow[];
  totalStockValue?: number;
  totalRetailValue?: number;
};

const listWarehouses = defineTool({
  name: "reai_list_warehouses",
  title: "List warehouses",
  description:
    "The warehouses (lager) stock is held in.\n\n" +
    "`archived` is a filter on the flag, not an include-toggle: measured on a tenant with one " +
    "active and one archived warehouse, omitting it and archived=false both return only the " +
    "active one, and archived=true returns only the archived one. There is no single call that " +
    "returns both.\n\n" +
    "Names are not unique — creating a second warehouse with a name already in use is accepted " +
    "(200, a new id). Identify a warehouse by id, never by name.",
  risk: "read",
  apiPaths: [["GET", "/api/warehouses"]],
  inputSchema: {
    archived: z
      .boolean()
      .optional()
      .describe(
        "true returns ONLY archived warehouses; false or omitted returns only active ones.",
      ),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/warehouses",
      query: args.archived === undefined ? undefined : { archived: String(args.archived) },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return okList(res.data, {
      noun: args.archived ? "archived warehouse" : "warehouse",
      suffix: ".",
      empty: args.archived
        ? "No archived warehouses. Active ones are not listed here — call again without " +
          "`archived` to see those."
        : "No active warehouses. Stock cannot be held without one. Note that this does not " +
          "rule out archived warehouses still holding stock: a warehouse with stock on hand is " +
          "archived rather than deleted, and archived ones are only returned by archived=true.",
    });
  },
});

const getWarehouse = defineTool({
  name: "reai_get_warehouse",
  title: "Get one warehouse",
  description:
    "One warehouse by id: its name and whether it is archived. Works on archived warehouses " +
    "too — an archived one still answers 200 here even though it is gone from the default list.",
  risk: "read",
  apiPaths: [["GET", "/api/warehouses/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Warehouse id, from reai_list_warehouses."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<{ archived?: boolean; name?: string }>({
      method: "GET",
      path: `/api/warehouses/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data, {
      note: res.data?.archived
        ? `Warehouse ${args.id} is ARCHIVED. It can still hold stock and can still be ` +
          `read and renamed, but it does not appear in the default warehouse list.`
        : undefined,
    });
  },
});

const createWarehouse = defineTool({
  name: "reai_create_warehouse",
  title: "Create a warehouse",
  description:
    "Add a warehouse. A name is the only field the API takes — there is no address, code or " +
    "default flag on this resource.\n\n" +
    "Names are not checked for uniqueness, so creating one that already exists gives you two " +
    "warehouses with the same name and different ids. Check reai_list_warehouses first.",
  risk: "reversible",
  apiPaths: [["POST", "/api/warehouses"]],
  inputSchema: {
    name: requiredName(160).describe("What the warehouse is called. The API caps this at 160 characters."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "POST",
      path: "/api/warehouses",
      body: { name: args.name },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    // The stored name, for the same reason as reai_rename_warehouse alongside it: `WarehouseRes` carries it,
    // and this API is documented as storing a name title-cased. Found by driving every unexamined tool with a
    // response that disagreed with the request — which is also why the name matters here specifically: the
    // description immediately below says names are NOT unique, so telling a caller the wrong one leaves them
    // unable to identify which of two warehouses they just made.
    const record = isRecord(res.data) ? res.data : undefined;
    const storedName = asScalar(record?.name);
    return ok(res.data, {
      note: [
        `Created warehouse ${record?.id ?? "?"} (` +
          (storedName === undefined || storedName === null
            ? `${JSON.stringify(args.name)} as SENT — ` +
              (record === undefined
                ? `the response came back as ${describeShape(res.data)}`
                : `the response does not carry the name`)
            : `${JSON.stringify(storedName)}, read back from the response`) +
          `). It holds no stock yet; use reai_adjust_inventory to put stock in it.`,
        ...describeConfirmation(
          confirmAgainstResponse({ name: args.name }, record, { wholeRecord: true }),
          `warehouse ${record?.id ?? "?"}`,
        ),
      ].join("\n\n"),
    });
  },
});

const renameWarehouse = defineTool({
  name: "reai_rename_warehouse",
  title: "Rename a warehouse",
  description:
    "Change a warehouse's name. Name is the only field the request carries, so this is the " +
    "whole of what can be updated — it cannot archive or unarchive a warehouse.\n\n" +
    "An archived warehouse can still be renamed (measured: 200).",
  risk: "reversible",
  apiPaths: [["PUT", "/api/warehouses/{id}"]],
  inputSchema: {
    warehouseId: z.number().int().positive().describe("Warehouse id."),
    name: requiredName(160).describe("The new name. The API caps this at 160 characters."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<{ name?: string }>({
      method: "PUT",
      path: `/api/warehouses/${args.warehouseId}`,
      body: { name: args.name },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    // From the RESPONSE. `WarehouseRes` carries `name`, and a rename is exactly where this API is known to
    // rewrite what it was given — reai_create_customer documents a stored name coming back title-cased.
    //
    // Gated on a USABLE value, not merely a present one. Keying on `!== undefined` produced
    // "Warehouse 4 is now named null, read back from the response" — a confident sentence stating a value the
    // API is documented as substituting, with the contradiction warning only afterwards. And a response that
    // is an array or a string is not a record at all, which is a different thing from a missing field: the
    // note used to deny a name the payload printed directly below it.
    const record = isRecord(res.data) ? res.data : undefined;
    const stored = asScalar(record?.name);
    return ok(res.data, {
      note: [
        stored === undefined
          ? `Warehouse ${args.warehouseId} was sent the name ${JSON.stringify(args.name)}, and ` +
            (record === undefined
              ? `the response is not a record (it came back as ${describeShape(res.data)}), so nothing ` +
                `could be read from it`
              : record.name === null || record.name === undefined
                ? `the response carries name: ${JSON.stringify(record.name ?? null)}`
                : `the response carries name as ${describeShape(record.name)}, which is not a value this ` +
                  `can state`) +
            ` — that is what was SENT rather than what is stored.`
          : `Warehouse ${args.warehouseId} is now named ${JSON.stringify(stored)}, read back from the response.`,
        ...describeConfirmation(
          confirmAgainstResponse({ name: args.name }, res.data, { wholeRecord: true }),
          `warehouse ${args.warehouseId}`,
        ),
      ].join("\n\n"),
    });
  },
});

const deleteWarehouse = defineTool({
  name: "reai_delete_warehouse",
  title: "Delete or archive a warehouse",
  description:
    "Remove a warehouse. What actually happens depends on what it currently holds, and the " +
    'response says which: {"outcome":"deleted"} or {"outcome":"archived"}. Read that field ' +
    "rather than treating a 200 as deletion.\n\n" +
    "Measured on the live API: a warehouse holding 2 units was ARCHIVED — it left the default " +
    "list, kept its stock, and still answered 200 by id with archived: true. A warehouse whose " +
    "adjustments netted back to zero on hand was DELETED outright, transaction history and all. " +
    "So the trigger is current stock on hand, not whether the warehouse was ever used.\n\n" +
    "There is no unarchive endpoint for warehouses — only customers and suppliers have one — so " +
    "the archive branch is one-way. An archived warehouse still holding stock is easy to lose " +
    "sight of, because the default warehouse list does not show it.\n\n" +
    "Worth knowing about the tier this sits in, because it is not obvious: reai_adjust_inventory " +
    "needs REAI_WRITE_MODE=full precisely because a stock transaction cannot be deleted, while " +
    "this call is available one tier down and the delete branch removes that whole history at " +
    "once. It is classified the way every other archive-on-delete tool here is classified, and " +
    "it is marked destructive so a client can confirm it — but if that asymmetry matters for a " +
    "deployment, read-only is the setting that closes it.",
  risk: "reversible",
  destructive: true,
  apiPaths: [["DELETE", "/api/warehouses/{id}"]],
  inputSchema: {
    warehouseId: z.number().int().positive().describe("Warehouse id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<{ outcome?: string }>({
      method: "DELETE",
      path: `/api/warehouses/${args.warehouseId}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const outcome = res.data?.outcome;
    const note =
      outcome === "archived"
        ? `Warehouse ${args.warehouseId} was ARCHIVED, not deleted — it still holds whatever ` +
          `stock was on hand, and reai_get_warehouse_inventory still reports it. It is hidden ` +
          `from the default list (archived=true to see it) and there is no unarchive endpoint. ` +
          `To delete it for real, bring its stock to zero with reai_adjust_inventory first.`
        : outcome === "deleted"
          ? `Warehouse ${args.warehouseId} deleted, along with its stock transaction history. ` +
            `Measured behaviour is that this branch is taken when nothing is on hand.`
          : `Warehouse ${args.warehouseId}: the API reported outcome ${JSON.stringify(outcome)}. ` +
            `Check reai_list_warehouses with archived=true before assuming it is gone.`;
    return ok(res.data ?? { outcome }, { note });
  },
});

const getInventory = defineTool({
  name: "reai_get_warehouse_inventory",
  title: "Get stock on hand",
  description:
    "Stock on hand: one line per product variant, with quantity, unit cost, retail price and " +
    "the value of each line.\n\n" +
    "This returns an OBJECT, not a list: { warehouseId, rows, totalStockValue, totalRetailValue }. " +
    "The two totals are already computed — read them rather than summing rows.\n\n" +
    "Omitting warehouseId reports across all warehouses (with warehouseId null on the envelope). " +
    "Archived warehouses still report their stock here, which is the way to find stock stranded " +
    "in one. Quantities can be negative: the API accepts an adjustment past zero without " +
    "complaint, so a negative line means more was taken out than was ever put in.",
  risk: "read",
  apiPaths: [["GET", "/api/warehouses/inventory"]],
  inputSchema: {
    warehouseId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Restrict to one warehouse. Omit for every warehouse at once."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<InventoryRes>({
      method: "GET",
      path: "/api/warehouses/inventory",
      query: args.warehouseId === undefined ? undefined : { warehouseId: String(args.warehouseId) },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const rows = res.data?.rows;
    if (!Array.isArray(rows)) {
      return ok(res.data, {
        note:
          `The inventory response had no \`rows\` array — the shape may have changed. Read the ` +
          `body below rather than assuming stock is zero.`,
      });
    }
    const negative = rows.filter((r) => (r.quantityOnHand ?? 0) < 0);
    const note =
      rows.length === 0
        ? `No stock lines${args.warehouseId ? ` in warehouse ${args.warehouseId}` : ""}. Only ` +
          `stock-tracked product variants appear here; a product that is not a stock item never ` +
          `will, whether or not it has been bought or sold.`
        : `${rows.length} stock line(s), total stock value ${res.data?.totalStockValue ?? "?"}, ` +
          `total retail value ${res.data?.totalRetailValue ?? "?"}.` +
          (negative.length ? ` ${describeNegative(negative)}` : "");
    return ok(res.data, { note });
  },
});

/** At most this many negative lines are named; the rest are counted. */
const NEGATIVE_SAMPLE = 10;

/**
 * Names the negative lines, bounded.
 *
 * ok() truncates the response BODY to the result budget but does not shorten a note the tool
 * supplied, so joining every negative line could push the result past the advertised cap on a
 * warehouse with a lot of them — and an all-warehouse read is one call.
 */
function describeNegative(negative: InventoryRow[]): string {
  const named = negative
    .slice(0, NEGATIVE_SAMPLE)
    .map((r) => `${r.sku ?? r.productTitle ?? r.productId}: ${r.quantityOnHand}`)
    .join(", ");
  const rest = negative.length - Math.min(negative.length, NEGATIVE_SAMPLE);
  return (
    `${negative.length} line(s) are NEGATIVE (${named}${rest > 0 ? `, and ${rest} more` : ""}) — ` +
    `more was taken out than was put in.`
  );
}

/**
 * `yyyy-MM-dd` or a full ISO timestamp, and nothing else.
 *
 * Accepting the date form is the point — every other date argument in this server uses it, and
 * the API's rejection of one here names no field. But an unvalidated `z.string()` passed
 * "01.08.2026" and "2026-8-1" straight through to produce exactly the bare 400 the argument
 * promises to prevent, which is the looseness commit 25925c0 went through fifteen arguments
 * to remove.
 */
const STOCK_MOVEMENT_TIME = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/,
    "Use yyyy-MM-dd or a full ISO timestamp such as 2026-08-01T10:00:00Z. The API's field is " +
      "date-time and rejects anything else with a 400 that names no field.",
  );

/**
 * Accepts the `yyyy-MM-dd` every other date argument here uses, as well as a full timestamp,
 * because the API's own rejection of a date-only value names no field (see the header).
 */
function normaliseOccurredAt(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
}

const adjustInventory = defineTool({
  name: "reai_adjust_inventory",
  title: "Adjust stock on hand",
  description:
    "Move stock in or out of a warehouse: a stocktake correction, breakage, or an opening " +
    "quantity. quantityChange is a DELTA, not a new total — +5 adds five to whatever is there.\n\n" +
    "Measured against the live API:\n" +
    "- It posts NO voucher. Vouchers stayed at 0 across every adjustment measured, so stock " +
    "value never reaches the ledger and this is not a posting. Book the accounting side " +
    "separately if it needs booking.\n" +
    "- Stock goes NEGATIVE without complaint: -10 against 4 on hand gave -6 on hand and a " +
    "stock value of -600. There is no clamp and no refusal, so a sign error is silently absorbed.\n" +
    "- It cannot be undone. No route lists or deletes a stock transaction (DELETE " +
    "transactions/{id}, DELETE adjust/{id} and GET transactions all 404), so the only " +
    "correction is an opposite adjustment, and both movements stay in the history. That is why " +
    "this needs REAI_WRITE_MODE=full.\n\n" +
    "variantId is optional in the API and REQUIRED here. Anything that can hold stock has at " +
    "least one variant — the API refuses a stock product without one — and an adjustment that " +
    "omits variantId answers 200 with a real transaction id while moving nothing at all. So " +
    "there is no call this tool could make without it that would do what the caller asked. It " +
    "also reads the warehouse's stock lines first and refuses if the variant is not one of " +
    "them, checks the resulting quantity against the pre-read plus the delta, and reports the " +
    "API's echoed variantId coming back null — which is the no-op signature — whatever the " +
    "pre-read said.",
  risk: "irreversible",
  apiPaths: [
    ["POST", "/api/warehouses/inventory/adjust"],
    // Read first, to catch the silent no-op before writing rather than reporting it after.
    ["GET", "/api/warehouses/inventory"],
  ],
  inputSchema: {
    productId: z.number().int().positive().describe("Product id, from reai_list_products."),
    warehouseId: z.number().int().positive().describe("Warehouse id, from reai_list_warehouses."),
    quantityChange: z
      .number()
      .int()
      .describe(
        "How much to add (positive) or remove (negative). A DELTA against current stock, not a " +
          "new total. 0 is rejected here — it would create a transaction that moves nothing.",
      )
      .refine((v) => v !== 0, "quantityChange must not be 0: it would record a movement of nothing."),
    variantId: z
      .number()
      .int()
      .positive()
      .describe(
        "Which variant of the product. Optional in the API and required here: without it the " +
          "API accepts the call and moves no stock. Read it from the `variantId` field of a " +
          "product's variants (NOT `id`, which does not exist there) or from a stock line in " +
          "reai_get_warehouse_inventory.",
      ),
    unitCost: z
      .number()
      .optional()
      .describe(
        "Stock unit cost to value the movement at. What the API uses when this is omitted was " +
          "not established — a movement made without it valued the line at the variant's cost " +
          "price, but that was the only case measured, so pass it if the valuation matters.",
      ),
    occurredAt: STOCK_MOVEMENT_TIME.optional().describe(
      "When the movement happened. Accepts yyyy-MM-dd (sent as 00:00:00Z) or a full ISO " +
        "timestamp. Defaults to now. The API's field is date-time and it refuses a bare date " +
        "with an error naming no field, so this tool completes the date — but anything that is " +
        "neither form is rejected here rather than passed on to produce that error.",
    ),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);

    const before = await ctx.client.request<InventoryRes>({
      method: "GET",
      path: "/api/warehouses/inventory",
      query: { warehouseId: String(args.warehouseId) },
      tenantId,
    });
    // `?? []` would only cover null and undefined. A non-array `rows` — the shape change the
    // sibling read tool already guards against — made `.filter` throw a TypeError here, so the
    // pre-read that exists to prevent a silent write instead crashed the call. Checked the same
    // way in both places now.
    const rows = before.data?.rows;
    const stockLinesReadable = Array.isArray(rows);
    const rowsForProduct = stockLinesReadable ? rows.filter((r) => r.productId === args.productId) : [];

    // The variant has to be one this warehouse actually tracks. A stock line exists at
    // quantity 0 for every stock variant, including in a warehouse created after the product
    // — measured both ways round — so an absent line means this is not something the
    // warehouse holds, and the adjustment would be the accepted-but-moved-nothing write.
    if (stockLinesReadable) {
      const matching = rowsForProduct.filter((r) => r.variantId === args.variantId);
      if (matching.length !== 1) {
        const available = rowsForProduct.length
          ? `Stock lines for product ${args.productId} in this warehouse:\n` +
            rowsForProduct
              .map(
                (r) =>
                  `  ${VARIANT_ID_FIELD} ${r.variantId ?? "(none)"}  ${r.sku ?? "(no sku)"}  ` +
                  `${r.quantityOnHand ?? 0} on hand${r.productTitle ? `  — ${r.productTitle}` : ""}`,
              )
              .join("\n")
          : `Product ${args.productId} has no stock line in warehouse ${args.warehouseId} at all. ` +
            `Only stock-tracked variants get one, so check that this product is a stock item.`;
        return fail(
          (matching.length === 0
            ? `Variant ${args.variantId} is not a stock line of product ${args.productId} in ` +
              `warehouse ${args.warehouseId}.`
            : `Variant ${args.variantId} matches ${matching.length} stock lines of product ` +
              `${args.productId} in warehouse ${args.warehouseId}, so which one to measure ` +
              `against is ambiguous.`) +
            ` Nothing was written — an adjustment the warehouse does not track is accepted with ` +
            `a transaction id and moves no stock.\n\n${available}`,
        );
      }
    }

    const quantityBefore = stockLinesReadable
      ? rowsForProduct.find((r) => r.variantId === args.variantId)?.quantityOnHand
      : undefined;

    const body: Record<string, unknown> = {
      productId: args.productId,
      warehouseId: args.warehouseId,
      quantityChange: args.quantityChange,
      variantId: args.variantId,
    };
    if (args.unitCost !== undefined) body.unitCost = args.unitCost;
    if (args.occurredAt !== undefined) body.occurredAt = normaliseOccurredAt(args.occurredAt);

    const res = await ctx.client.request<{
      transactionId?: number;
      quantityOnHand?: number;
      variantId?: number | null;
      productId?: number | null;
      warehouseId?: number | null;
      quantityChange?: number | null;
    }>({
      method: "POST",
      path: "/api/warehouses/inventory/adjust",
      body,
      tenantId,
    });

    const after = res.data?.quantityOnHand;
    // WHICH product, variant and warehouse the movement landed on, from the response. This tool stated all four
    // figures from `args` — the identifiers AND the quantity — while it is declared irreversible and its own
    // note two paragraphs down says the movement cannot be deleted. A stock movement attributed to the wrong
    // variant is found by a stock count, not by re-reading this note.
    //
    // Found by driving every candidate against a contradicting response, but only after the sweep stopped
    // sampling integers as a single digit: every integer field in the repo had been dropped as "too short to
    // find in prose", which is exactly the set these four are in.
    const num = (v: unknown) => (typeof v === "number" ? v : undefined);
    const shown = {
      productId: num(res.data?.productId) ?? args.productId,
      variantId: num(res.data?.variantId) ?? args.variantId,
      warehouseId: num(res.data?.warehouseId) ?? args.warehouseId,
      quantityChange: num(res.data?.quantityChange) ?? args.quantityChange,
    };
    const fromRecord =
      num(res.data?.productId) !== undefined &&
      num(res.data?.variantId) !== undefined &&
      num(res.data?.warehouseId) !== undefined &&
      num(res.data?.quantityChange) !== undefined;
    const parts = [
      `Adjusted product ${shown.productId} variant ${shown.variantId} in warehouse ` +
        `${shown.warehouseId} by ${shown.quantityChange > 0 ? "+" : ""}${shown.quantityChange}` +
        `${after === undefined ? "" : `; ${after} now on hand`}` +
        `${res.data?.transactionId ? ` (transaction ${res.data.transactionId})` : ""}` +
        `${fromRecord ? `, read back from the response` : `, as SENT — the response does not identify the movement, so read the stock back with reai_get_warehouse_inventory`}.`,
      ...describeConfirmation(
        confirmAgainstResponse(
          { productId: args.productId, variantId: args.variantId, warehouseId: args.warehouseId, quantityChange: args.quantityChange },
          res.data,
          { wholeRecord: true },
        ),
        `this movement`,
      ),
    ];

    // The detector that needs nothing from the pre-read: the API echoes the variant it acted
    // on, and a null echo against a variant that was sent is the no-op signature itself. The
    // first version declared this field in the response type and never read it, leaving the
    // pre-read comparison as the only check — which is silent whenever the pre-read could not
    // be matched or read.
    if (res.data?.variantId == null) {
      parts.push(
        `WARNING: the API echoed back variantId: null although variant ${args.variantId} was ` +
          `sent, which is the signature of an adjustment that is accepted and moves no stock. ` +
          `Treat this as having changed nothing until reai_get_warehouse_inventory says otherwise.`,
      );
    }

    if (quantityBefore !== undefined && after !== undefined) {
      const expected = quantityBefore + args.quantityChange;
      if (after !== expected) {
        parts.push(
          `WARNING: stock did NOT move as asked. It was ${quantityBefore} before, ${args.quantityChange} ` +
            `was requested, so ${expected} was expected — the API reports ${after}. The call was ` +
            `accepted regardless. Verify with reai_get_warehouse_inventory before adjusting again.`,
        );
      }
    } else {
      // No comparison was possible. Which of the two reasons it was matters to what the caller
      // should check, and neither may pass for a clean result — an absent field reported as
      // nothing wrong is the failure this server exists to prevent.
      parts.push(
        after === undefined
          ? `The response carried no quantityOnHand, so what this call left on hand is UNKNOWN — ` +
            `not zero, and not what was asked for. Read it with reai_get_warehouse_inventory.`
          : `The stock lines for this warehouse could not be read beforehand, so ${after} on hand ` +
            `was NOT verified against an expected total. Confirm with reai_get_warehouse_inventory.`,
      );
    }

    if (after !== undefined && after < 0) {
      parts.push(
        `Stock is now NEGATIVE (${after}). The API allows this; it usually means a sign error or ` +
          `stock that was never booked in.`,
      );
    }

    parts.push(
      `No voucher was posted — stock value does not reach the ledger through this call. The ` +
        `movement cannot be deleted; correct it with an opposite adjustment if it was wrong.`,
    );

    return ok(res.data, { note: parts.join("\n\n") });
  },
});

export const warehouseTools: ToolDef[] = [
  listWarehouses,
  getWarehouse,
  createWarehouse,
  renameWarehouse,
  deleteWarehouse,
  getInventory,
  adjustInventory,
];
