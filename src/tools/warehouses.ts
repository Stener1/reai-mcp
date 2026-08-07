import { z } from "zod";
import {
  defineTool,
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
 * The worst of the four. `variantId` is optional in the schema, and omitting it on a product
 * that has variants answers 200 with a real `transactionId` — and moves no stock at all:
 *
 *   POST /api/warehouses/inventory/adjust {productId, warehouseId, quantityChange: 3}
 *     → 200 {"transactionId":147036, "variantId":null, "quantityChange":3, "quantityOnHand":0}
 *
 * Four such calls in a row (net +12) left `quantityOnHand` at 0 and `stockValue` at 0. The
 * response is honest — `quantityOnHand` is the truth and `variantId` comes back null — but
 * nothing in the status code or the transaction id says the write was a no-op. So this tool
 * reads the warehouse's stock lines FIRST and refuses before writing when the product has
 * variant rows and no variantId was given, then verifies the resulting on-hand against the
 * expected total afterwards.
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
 * opposite adjustment, which leaves both movements in the history. `/api/warehouses` has
 * also been in IRREVERSIBLE_PREFIXES for the adjust path since before this toolset existed.
 */

/** The API's own field name, and the one to pass back. Documented because `.id` is the trap. */
const VARIANT_ID_FIELD = "variantId";

type InventoryRow = {
  productId?: number;
  productTitle?: string;
  variantId?: number | null;
  sku?: string;
  quantityOnHand?: number;
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
    const res = await ctx.client.request<{ id?: number }>({
      method: "POST",
      path: "/api/warehouses",
      body: { name: args.name },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data, {
      note:
        `Created warehouse ${res.data?.id ?? "?"} (${args.name}). It holds no stock yet; use ` +
        `reai_adjust_inventory to put stock in it.`,
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
    const res = await ctx.client.request({
      method: "PUT",
      path: `/api/warehouses/${args.warehouseId}`,
      body: { name: args.name },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data, { note: `Warehouse ${args.warehouseId} renamed to ${args.name}.` });
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
    "sight of, because the default warehouse list does not show it.",
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
          (negative.length
            ? ` ${negative.length} line(s) are NEGATIVE (${negative
                .map((r) => `${r.sku ?? r.productTitle ?? r.productId}: ${r.quantityOnHand}`)
                .join(", ")}) — more was taken out than was put in.`
            : "");
    return ok(res.data, { note });
  },
});

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
    "variantId is optional in the API but required in practice for a product that has variants: " +
    "omitting it answers 200 with a real transaction id and moves nothing at all. This tool " +
    "reads the warehouse's stock lines first and refuses before writing in that case, then " +
    "checks the resulting quantity against what was asked for.",
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
      .optional()
      .describe(
        "Which variant of the product. Required whenever the product has variants — without it " +
          "the API accepts the call and moves no stock. Read it from the `variantId` field of a " +
          "product's variants (NOT `id`, which does not exist there) or from a stock line.",
      ),
    unitCost: z
      .number()
      .optional()
      .describe("Stock unit cost to value the movement at. Defaults to the variant's cost price."),
    occurredAt: z
      .string()
      .optional()
      .describe(
        "When the movement happened. Accepts yyyy-MM-dd (sent as 00:00:00Z) or a full " +
          "timestamp. Defaults to now. The API rejects a bare date itself with an error naming " +
          "no field, so this tool completes the date for you.",
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
    const variantRows = rowsForProduct.filter((r) => r.variantId != null);

    if (!stockLinesReadable && args.variantId === undefined) {
      // Fail closed on exactly the case the pre-read exists for. Without the stock lines
      // there is no way to tell whether this product is variant-tracked, and proceeding
      // would risk the accepted-but-moved-nothing write with nothing left to detect it.
      // A supplied variantId removes that failure mode, so that path is allowed through
      // below with the missing check stated.
      return fail(
        `Could not read the stock lines for warehouse ${args.warehouseId}: the inventory ` +
          `response had no \`rows\` array, so there is no way to tell whether product ` +
          `${args.productId} is tracked per variant. Nothing was written.\n\n` +
          `An adjustment that omits ${VARIANT_ID_FIELD} on a variant-tracked product is ` +
          `accepted with a transaction id and moves no stock, so this refuses rather than ` +
          `guess. Pass ${VARIANT_ID_FIELD} explicitly, or check ` +
          `reai_get_warehouse_inventory first.`,
      );
    }

    if (args.variantId === undefined && variantRows.length > 0) {
      // Refusing is the whole point: the API would answer 200 here and move nothing.
      return fail(
        `Product ${args.productId} is tracked per variant in warehouse ${args.warehouseId}, and ` +
          `no variantId was given. Nothing was written — the API would have accepted this and ` +
          `moved no stock, returning a transaction id anyway.\n\n` +
          `Pass one of these as ${VARIANT_ID_FIELD}:\n` +
          variantRows
            .map(
              (r) =>
                `  ${r.variantId}  ${r.sku ?? "(no sku)"}  ${r.quantityOnHand ?? 0} on hand` +
                `${r.productTitle ? `  — ${r.productTitle}` : ""}`,
            )
            .join("\n"),
      );
    }

    const matching = rowsForProduct.find((r) =>
      args.variantId === undefined ? true : r.variantId === args.variantId,
    );
    const quantityBefore = matching?.quantityOnHand;

    const body: Record<string, unknown> = {
      productId: args.productId,
      warehouseId: args.warehouseId,
      quantityChange: args.quantityChange,
    };
    if (args.variantId !== undefined) body.variantId = args.variantId;
    if (args.unitCost !== undefined) body.unitCost = args.unitCost;
    if (args.occurredAt !== undefined) body.occurredAt = normaliseOccurredAt(args.occurredAt);

    const res = await ctx.client.request<{
      transactionId?: number;
      quantityOnHand?: number;
      variantId?: number | null;
    }>({
      method: "POST",
      path: "/api/warehouses/inventory/adjust",
      body,
      tenantId,
    });

    const after = res.data?.quantityOnHand;
    const parts = [
      `Adjusted product ${args.productId}${args.variantId ? ` variant ${args.variantId}` : ""} in ` +
        `warehouse ${args.warehouseId} by ${args.quantityChange > 0 ? "+" : ""}${args.quantityChange}` +
        `${after === undefined ? "" : `; ${after} now on hand`}` +
        `${res.data?.transactionId ? ` (transaction ${res.data.transactionId})` : ""}.`,
    ];

    // The check the silent no-op needs: the response's on-hand is the only honest signal, so
    // compare it against what the pre-read plus the delta says it should be.
    if (quantityBefore !== undefined && after !== undefined) {
      const expected = quantityBefore + args.quantityChange;
      if (after !== expected) {
        parts.push(
          `WARNING: stock did NOT move as asked. It was ${quantityBefore} before, ${args.quantityChange} ` +
            `was requested, so ${expected} was expected — the API reports ${after}. The call was ` +
            `accepted regardless. Verify with reai_get_warehouse_inventory before adjusting again, ` +
            `and check that variantId names the right variant.`,
        );
      }
    } else if (!stockLinesReadable) {
      // The comparison is the only thing that would have caught a no-op here, and it could
      // not run. Saying so beats letting its absence pass for a clean result.
      parts.push(
        `The stock lines for this warehouse could not be read beforehand, so the resulting ` +
          `quantity was NOT verified against an expected total. Confirm with ` +
          `reai_get_warehouse_inventory.`,
      );
    } else if (after !== undefined && args.quantityChange !== 0 && after === 0 && quantityBefore === undefined) {
      parts.push(
        `Note: this product had no stock line in warehouse ${args.warehouseId} beforehand, and ` +
          `on-hand is 0 after a change of ${args.quantityChange}. That is the signature of an ` +
          `adjustment that was accepted but moved nothing. Confirm with ` +
          `reai_get_warehouse_inventory.`,
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
