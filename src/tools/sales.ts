import { z } from "zod";
import {
  COUNTRY_CODE,
  defineTool,
  fail,
  isoDate,
  ok,
  okList,
  requireTenantId,
  startOfYear,
  tenantIdArg,
  today,
  type ToolDef,
  type ToolContext,
  isWholeOre,
  requiredName,
  okText,
  PHONE_RULE,
  SKIP_REGISTRY_LOOKUP_RULE,
} from "./registry.js";
import { ReaiApiError } from "../reai/errors.js";

/**
 * The sales side: customers, products, orders, invoices, offers.
 *
 * The shape of this domain is worth stating up front, because it is not
 * guessable from the endpoint names: **an invoice is created from an order**, not
 * from line items. `POST /api/invoices` takes an `orderId` and nothing else of
 * substance. So the flow is customer → order (which carries the lines) →
 * invoice → payment, and an agent that tries to build an invoice directly will
 * get nowhere. Every tool description below points along that chain.
 */

/**
 * Floor date for open-item questions.
 *
 * Both the customer ledger and the invoice list are period-scoped: the ledger
 * returns customers "with activity in the period", and the invoice list defaults
 * startDate to one year before endDate. So asking "who owes us money" with a
 * current-year window silently omits an invoice that went unpaid in an earlier
 * year -- the single case the question most cares about. When the caller filters
 * for open or overdue items and gives no start date, reach back instead.
 */
const OPEN_ITEM_FLOOR = "2000-01-01";


const CURRENCY = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Must be an uppercase ISO 4217 code, e.g. "NOK".')
  .describe('ISO 4217 currency code, e.g. "NOK". Use reai_request GET /api/currencies for the full list.');

// --- Customers -------------------------------------------------------------

const listCustomers = defineTool({
  name: "reai_list_customers",
  title: "List customers",
  description:
    "List or search customers (kunder). Filter by name, organisation number or email. " +
    "Archived customers are excluded unless you ask for them.",
  risk: "read",
  apiPaths: [["GET", "/api/customers"]],
  inputSchema: {
    name: z.string().optional().describe("Filter by name (partial match)."),
    organizationNumber: z
      .string()
      .max(36, "The API caps organizationNumber at 36 characters.")
      .optional()
      .describe("Filter by Norwegian organisation number."),
    email: z
      .string()
      .max(255, "The API caps the email filter at 255 characters.")
      .optional()
      .describe("Filter by email address."),
    archived: z
      .boolean()
      .optional()
      .describe(
        "Whether this REPLACES the default set or adds to it is not settled for customers. The " +
          "supplier spec says outright that true means archived-only and false active-only, and " +
          "that is confirmed live; the customer spec says only \"Include archived customers\", which " +
          "reads the other way, and no tenant available for testing has any customers. Treat the " +
          "result as archived-only and check the records you get back rather than assuming a total.",
      ),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...query } = args;
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/customers",
      query,
      tenantId: requireTenantId(tenantId, ctx),
    });
    return okList(res.data, { noun: "customer", suffix: "." });
  },
});

const getCustomer = defineTool({
  name: "reai_get_customer",
  title: "Get one customer",
  description: "Fetch a single customer by id, including addresses and invoicing settings.",
  risk: "read",
  apiPaths: [["GET", "/api/customers/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Customer id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const res = await ctx.client.request({
      method: "GET",
      path: `/api/customers/${args.id}`,
      tenantId,
    });
    return ok(res.data, { link: ctx.client.deepLink(`/customers/${args.id}`, tenantId) });
  },
});

const createCustomer = defineTool({
  name: "reai_create_customer",
  title: "Create a customer",
  description:
    "Create a customer. Two kinds exist: set privateContact=true for a private individual, " +
    "otherwise a company is created and a Norwegian company requires a valid organizationNumber. " +
    "ReAI looks the company up in Brønnøysundregistrene from the organizationNumber and fills in " +
    "the address — pass skipRegistryLookup to opt out, though that flag is not a guarantee (see its " +
    "own description). Two things about that lookup are worth knowing, both measured against the " +
    "live API rather than inferred:\n" +
    "  - A name is still REQUIRED. An empty one is refused with \"name is required\" even when a " +
    "valid organizationNumber is supplied, so \"the org number alone is enough\" — which this " +
    "description used to claim — does not work.\n" +
    "  - The name you send is then DISCARDED. Sending name=\"Lookup Probe\" with Skatteetaten's " +
    "org number stores \"Skatteetaten\". So pass the real name if you know it, and expect the " +
    "registry to win if you do not.\n\n" +
    "Note that ReAI normalizes the stored name to title case, so it may not come back exactly as sent.\n\n" +
    "Creation accepts only the fields listed here. Invoice email, phone and payment terms are not " +
    "among them — set those with reai_update_customer afterwards.\n\n" +
    "One refusal is worth knowing because it names the wrong field: a duplicate is reported as " +
    "\"En kunde med navnet <NAME> finnes allerede.\", and that NAME is the existing customer's, not " +
    "the one you sent. Isolated on the live API — a duplicate organizationNumber under a brand-new " +
    "name gives the same sentence, quoting a name that is nowhere in the request. Check the org " +
    "number before renaming anything.",
  risk: "reversible",
  apiPaths: [["POST", "/api/customers"]],
  inputSchema: {
    name: requiredName(75)
      .describe(
        "Customer or company name, at most 75 characters. Required, and whitespace alone will " +
          "not do — the API answers \"name is required\" for both. This field was previously " +
          "documented as optional when organizationNumber is supplied, on the reading that the " +
          "Brønnøysund lookup fills it in; tested against the live API, that is not so, and a " +
          "blank name is rejected with or without an org number.",
      ),
    organizationNumber: z
      .string()
      .max(36, "The API caps organizationNumber at 36 characters.")
      .optional()
      .describe("Norwegian organisation number. Required for Norwegian company customers."),
    privateContact: z
      .boolean()
      .optional()
      .describe("True for a private individual rather than a company."),
    email: z.string().optional().describe("General email address."),
    nationalIdentityNumber: z
      .string()
      .regex(/^\d{11}$/, "nationalIdentityNumber must be exactly 11 digits, and digits only")
      .optional()
      .describe(
        "Fødselsnummer, for private customers. Exactly 11 digits, no spaces or separators — the " +
          'API answers "must contain only digits" and "must be exactly 11 digits".',
      ),
    countryCode: COUNTRY_CODE.optional().describe('ISO country code. Defaults to "NO".'),
    addressPart1: z.string().optional().describe("Street address."),
    addressPart2: z.string().optional().describe("Second address line."),
    postalCode: z.string().optional().describe("Postal code."),
    city: z.string().optional().describe("City."),
    province: z.string().optional().describe("Province or region."),
    skipRegistryLookup: z
      .boolean()
      .optional()
      .describe(SKIP_REGISTRY_LOOKUP_RULE),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...body } = args;
    const resolved = requireTenantId(tenantId, ctx);
    const res = await ctx.client.request<{ id?: number; name?: string }>({
      method: "POST",
      path: "/api/customers",
      body,
      tenantId: resolved,
    });
    const id = res.data?.id;
    return ok(res.data, {
      note: `Customer created${res.data?.name ? `: ${res.data.name}` : ""}.`,
      ...(id ? { link: ctx.client.deepLink(`/customers/${id}`, resolved) } : {}),
    });
  },
});

const updateCustomer = defineTool({
  name: "reai_update_customer",
  title: "Update a customer",
  description:
    "Update customer details. Only the fields you pass are changed. " +
    "Note that the postal address is a separate call — use reai_set_customer_address for that.",
  risk: "reversible",
  apiPaths: [["PATCH", "/api/customers/{id}"]],
  idempotent: true,
  inputSchema: {
    id: z.number().int().positive().describe("Customer id."),
    // The API's pattern is .*\S.* — a blank name is rejected, so refuse it here with the
    // reason rather than sending an update that cannot succeed.
    name: z
      .string()
      .max(75)
      .refine((v) => v.trim().length > 0, { message: "A name cannot be blank; the API rejects it." })
      .optional()
      .describe("New name. At most 75 characters, and not blank."),
    email: z.string().optional().describe("New email address."),
    invoiceEmail: z.string().optional().describe("Where invoices should be sent."),
    invoiceInEnglish: z.boolean().optional().describe("Issue this customer's invoices in English."),
    daysUntilDue: z.number().int().optional().describe("Default payment terms in days."),
    phone: z
      .string()
      .optional()
      // Was: 'a "+47" prefix on a Norwegian number is rejected — write it plain'. Measured false.
      // PATCH /api/customers/{id} answers 200 to +4722334455 and stores it. See PHONE_RULE.
      .describe(`Phone number. ${PHONE_RULE}`),
    nationalIdentityNumber: z
      .string()
      .regex(/^\d{11}$/, "nationalIdentityNumber must be exactly 11 digits, and digits only")
      .optional()
      .describe(
        "Fødselsnummer, for private customers. Exactly 11 digits, no spaces or separators — the " +
          'API answers "must contain only digits" and "must be exactly 11 digits".',
      ),
    iban: z.string().optional().describe("IBAN."),
    bankAccountNumber: z.string().optional().describe("Norwegian bank account number."),
    swiftCode: z.string().optional().describe("SWIFT/BIC code."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, ...body } = args;
    if (Object.keys(body).length === 0) {
      return fail("Nothing to update — pass at least one field to change.");
    }
    const resolved = requireTenantId(tenantId, ctx);
    const res = await ctx.client.request({
      method: "PATCH",
      path: `/api/customers/${id}`,
      body,
      tenantId: resolved,
    });
    return ok(res.data, { link: ctx.client.deepLink(`/customers/${id}`, resolved) });
  },
});

const setCustomerAddress = defineTool({
  name: "reai_set_customer_address",
  title: "Change a customer's address",
  description:
    "Change a customer's postal address, or their delivery address. Pass only the parts you want " +
    "different; the rest is kept.\n\n" +
    "The API call underneath is a full REPLACEMENT whose required set is only addressPart1, city " +
    "and countryCode — so a body carrying those three is accepted and empties everything else. " +
    "Measured on a live tenant: postalCode \"0150\" became null, province \"Oslo\" became null and " +
    "the second address line was emptied, on a 200. So this tool reads the current address first " +
    "and merges your changes into it. Pass null to clear one of the OPTIONAL parts — addressPart2, " +
    "postalCode or province. The other three are required by the endpoint, so there is no way to " +
    "clear them and null is refused.\n\n" +
    "Between that read and the write there is a lost-update window: an address edited in the " +
    "ReAI UI in between is silently reverted. There is no ETag or version field to prevent it.",
  risk: "reversible",
  apiPaths: [
    // The read that makes the merge possible.
    ["GET", "/api/customers/{id}"],
    ["PUT", "/api/customers/{id}/address"],
    ["PUT", "/api/customers/{id}/delivery-address"],
  ],
  idempotent: true,
  inputSchema: {
    id: z.number().int().positive().describe("Customer id."),
    kind: z
      .enum(["postal", "delivery"])
      .optional()
      .describe('Which address to set. Defaults to "postal".'),
    // Every part is optional now that the current address is merged in: requiring the three the
    // API requires would have made "change the street" mean "and retype the city", which is the
    // shape that lost postcodes in the first place. Null clears a part deliberately.
    // These three are REQUIRED by the endpoint and non-nullable in the document, so a null is not
    // something a caller can mean: there is no way to clear a required field. They were nullable
    // by reflex, alongside the optional three below where the document does allow it.
    addressPart1: z.string().optional().describe("Street address."),
    city: z.string().optional().describe("City."),
    countryCode: COUNTRY_CODE.optional().describe('ISO country code, e.g. "NO".'),
    addressPart2: z.string().nullable().optional().describe("Second address line."),
    postalCode: z.string().nullable().optional().describe("Postal code."),
    province: z.string().nullable().optional().describe("Province or region."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, kind, ...changes } = args;
    const resolved = requireTenantId(tenantId, ctx);
    const segment = kind === "delivery" ? "delivery-address" : "address";
    const given = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
    if (Object.keys(given).length === 0) {
      return fail(
        "No address parts were given, so nothing was written. Sending an empty body here would " +
          "replace the address with an empty one.",
      );
    }

    // Read first: the PUT replaces, and the parts it does not require are the ones that go
    // missing. `delivery` and `postal` live on different keys of the customer record.
    const current = await ctx.client.request<{
      address?: Record<string, unknown> | null;
      deliveryAddress?: Record<string, unknown> | null;
    }>({ method: "GET", path: `/api/customers/${id}`, tenantId: resolved });

    // Fail closed on a response this cannot read, rather than treating it as "no address yet".
    // `?? {}` collapsed both cases into one: a body that came back as text, or with the key
    // renamed, produced an empty base — so the PUT sent the caller's fields alone, which is the
    // wipe this tool exists to prevent, and the note then said "Nothing else was set on it
    // beforehand". reai_update_agreement refuses in exactly this situation.
    const record = current.data;
    const readable = !!record && typeof record === "object" && !Array.isArray(record);
    const field = kind === "delivery" ? "deliveryAddress" : "address";
    const stored = readable ? record[field] : undefined;
    const storedIsAddress = stored !== null && stored !== undefined
      ? typeof stored === "object" && !Array.isArray(stored)
      : true; // null/absent genuinely means "no address set yet"
    if (!readable || !storedIsAddress) {
      return fail(
        `Could not read customer ${id}'s current ${kind ?? "postal"} address: the response was ` +
          `not a customer record with ${
            stored === undefined ? `an \`${field}\` field` : `an object at \`${field}\``
          }. Nothing was written — this endpoint REPLACES the address, so without the current ` +
          `one to merge into, the parts you did not pass would have been erased.`,
      );
    }
    const existing = (stored as Record<string, unknown> | null) ?? {};
    // Only the parts this endpoint accepts.
    //
    // An earlier comment justified this as "the record carries more, and an unknown field is
    // refused" — both halves were invented. ContactAddressRes carries exactly the six fields
    // UpdateCustomerAddressReq takes, and this API has no additionalProperties: false anywhere;
    // the repo's own measured note for this domain says extra fields are silently DISCARDED. The
    // whitelist stays because echoing an unrecognised key back is not something to rely on being
    // ignored, and because it makes the write independent of what the read happens to include.
    const ADDRESS_PARTS = ["addressPart1", "addressPart2", "postalCode", "city", "province", "countryCode"];
    const base = Object.fromEntries(
      ADDRESS_PARTS.filter((k) => existing[k] !== undefined && existing[k] !== null).map((k) => [k, existing[k]]),
    );
    const merged = { ...base, ...given };

    const missing = ["addressPart1", "city", "countryCode"].filter(
      (k) => merged[k] === undefined || merged[k] === null || merged[k] === "",
    );
    if (missing.length > 0) {
      return fail(
        `The API requires ${missing.join(", ")} on an address, and neither your change nor the ` +
          `customer's current address supplies ${missing.length === 1 ? "it" : "them"}. Nothing ` +
          `was written — pass ${missing.join(" and ")} explicitly.`,
      );
    }

    const res = await ctx.client.request({
      method: "PUT",
      path: `/api/customers/${id}/${segment}`,
      body: merged,
      tenantId: resolved,
    });
    const kept = Object.keys(base).filter((k) => !(k in given));
    return ok(res.data ?? `${kind ?? "postal"} address updated.`, {
      note:
        `Changed ${Object.keys(given).join(", ")} on customer ${id}'s ${kind ?? "postal"} address` +
        (kept.length
          ? `; ${kept.join(", ")} ${kept.length === 1 ? "was" : "were"} read first and sent back ` +
            `unchanged, because this endpoint replaces rather than patches.`
          : `. Nothing else was set on it beforehand.`),
    });
  },
});

const deleteCustomer = defineTool({
  name: "reai_delete_customer",
  title: "Delete or archive a customer",
  description:
    "Delete a customer. ReAI archives rather than deletes when the customer already has " +
    "transactions, which keeps the audit trail intact, and answers " +
    '{"outcome":"deleted"} or {"outcome":"archived"} to say which. This tool reads that and tells ' +
    "you, because the two leave the tenant in very different states.\n\n" +
    "An ARCHIVED customer is reversible with reai_unarchive_customer — measured. But archiving one " +
    "whose ORDERS still exist is how those orders become permanently undeletable: they then answer " +
    '500 "Referenced record is not accessible". Delete the dependents first.',
  risk: "reversible",
  apiPaths: [["DELETE", "/api/customers/{id}"]],
  destructive: true,
  inputSchema: {
    id: z.number().int().positive().describe("Customer id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "DELETE",
      path: `/api/customers/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    // Which of the two happened is the whole point of this endpoint, and reporting "deleted or
    // archived" left the caller to guess. An archive is recoverable and leaves the record visible
    // only under ?archived=true; a delete is not recoverable at all.
    const outcome = (res.data as { outcome?: string } | undefined)?.outcome;
    return ok(res.data ?? { customerId: args.id }, {
      note:
        outcome === "deleted"
          ? `Customer ${args.id} was DELETED outright — the record is gone, and there is nothing to ` +
            `unarchive.`
          : outcome === "archived"
            ? `Customer ${args.id} was ARCHIVED, not deleted: it had transactions, so the audit ` +
              `trail is kept. It is hidden from reai_list_customers unless you pass archived: true, ` +
              `and reai_unarchive_customer brings it back.`
            : `Customer ${args.id}: DELETE answered HTTP ${res.status} with no recognised outcome ` +
              `(${JSON.stringify(outcome)}). This endpoint deletes OR archives and says which, so ` +
              `with neither word present, which one happened is unknown — read it back with ` +
              `reai_list_customers archived: true before assuming.`,
    });
  },
});


/**
 * Deleting what this server can create.
 *
 * `reversible` mode is defined as "reads, plus master data that can be cleanly
 * deleted", and it registers tools that create products, orders and offers — but
 * shipped no way to remove any of them. A walkthrough as an agent would experience
 * it hit this immediately: it drafted an offer and then had nothing to call. The
 * DELETE endpoints exist and classify as reversible, so the capability was always
 * permitted; only the curated tool was missing, leaving the agent to discover the
 * escape hatch to undo something the default mode had just encouraged it to do.
 */
const deleteProduct = defineTool({
  name: "reai_delete_product",
  title: "Delete or archive a product",
  description:
    "Delete a product. As with customers, ReAI archives instead of deleting once the product has " +
    "been used on an order or invoice, which keeps the audit trail intact — the response says " +
    "which happened.\n\n" +
    "Unlike customers and suppliers, there is NO unarchive endpoint for products, so through the " +
    "API this is one-way. It can presumably be undone in the ReAI web UI, but not from here.",
  risk: "reversible",
  apiPaths: [["DELETE", "/api/products/{id}"]],
  destructive: true,
  inputSchema: {
    id: z.number().int().positive().describe("Product id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "DELETE",
      path: `/api/products/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    // "deleted or archived" was what this said, and the endpoint tells you which: its 200 is
    // documented as ApiLifecycleOutcomeRes, `{outcome: deleted|archived|reversed}`. The difference
    // matters more here than almost anywhere else in this API, because a product is the reference
    // that strands other records — eight orders on the test tenant are permanently undeletable
    // because the PRODUCT their lines name was deleted first, and products have no unarchive
    // endpoint at all. Archived is the recoverable-looking outcome that is not recoverable.
    const outcome = (res.data as { outcome?: string } | undefined)?.outcome;
    // `outcome: null` rather than a bare record, following reai_delete_voucher — see the comment
    // there: a synthesized outcome beside an "unknown" note tells a structured reader the opposite
    // of the prose.
    return ok(res.data ?? { outcome: null, productId: args.id }, {
      note:
        outcome === "deleted"
          ? `Product ${args.id} was DELETED outright. Any ORDER whose lines still name it can now ` +
            `never be deleted through the API: every DELETE on one answers 500 "Referenced record ` +
            `is not accessible", and there is no product unarchive endpoint to restore the ` +
            `reference with. Remove dependents BEFORE their master data. (Invoices are not part of ` +
            `this: the API has no invoice DELETE at all, so an invoice was never deletable and ` +
            `crediting it with reai_credit_invoice is the only route regardless.)`
          : outcome === "archived"
            ? `Product ${args.id} was ARCHIVED, not deleted: something references it, so the audit ` +
              `trail is kept and those references still resolve. Two things follow, and neither is ` +
              `good news. Products have NO unarchive endpoint, so this is not a state you can ` +
              `reverse through the API. And GET /api/products takes no archived filter — measured, ` +
              `its only parameter is the tenant header — so an archived product cannot be listed ` +
              `through this API at all. reai_list_products will simply not show it.`
            : `Product ${args.id}: the DELETE returned HTTP ${res.status} with no recognised outcome ` +
              `(${JSON.stringify(outcome)}). Whether it was deleted or archived is NOT established, ` +
              `and this API gives you no way to settle it: there is no archived filter on the ` +
              `product list, so an absent product is either gone or archived and the two look the ` +
              `same. Check in the ReAI UI if it matters.`,
    });
  },
});

const deleteOrder = defineTool({
  name: "reai_delete_order",
  title: "Delete an order",
  description:
    "Delete an order that has not been invoiced. Once an order has been invoiced the invoice is " +
    "the legal document and the order cannot be removed — credit the invoice instead " +
    "(reai_credit_invoice, which requires external send to be enabled).",
  risk: "reversible",
  apiPaths: [["DELETE", "/api/orders/{id}"]],
  destructive: true,
  inputSchema: {
    id: z.number().int().positive().describe("Order id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "DELETE",
      path: `/api/orders/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data ?? `Order ${args.id} deleted (HTTP ${res.status}).`);
  },
});

const deleteOffer = defineTool({
  name: "reai_delete_offer",
  title: "Delete an offer",
  description:
    "Delete an offer. An offer is a draft quotation, so this removes it outright — nothing has " +
    "been posted to the books and, unless it was sent, the customer never saw it.",
  risk: "reversible",
  apiPaths: [["DELETE", "/api/offers/{id}"]],
  destructive: true,
  inputSchema: {
    id: z.number().int().positive().describe("Offer id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "DELETE",
      path: `/api/offers/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data ?? `Offer ${args.id} deleted (HTTP ${res.status}).`);
  },
});

const customerLedger = defineTool({
  name: "reai_customer_ledger",
  title: "Customer ledger (kundereskontro)",
  description:
    "Read the customer ledger: what each customer owes, with the postings behind it. Omit " +
    "customerId for every customer, or pass one to drill in. Set isOpenPosting to see only " +
    "unsettled items — that is the answer to 'who owes us money'.\n\n" +
    "Defaults to the current calendar year, EXCEPT with isOpenPosting, where the window reaches " +
    "back to 2000 instead. The ledger only returns customers with activity in the period, so a " +
    "current-year default would hide an invoice that went unpaid in an earlier year.",
  risk: "read",
  apiPaths: [["GET", "/api/ledger/customer"], ["GET", "/api/ledger/customer/{customerId}"]],
  inputSchema: {
    customerId: z.number().int().positive().optional().describe("Restrict to one customer."),
    startDate: isoDate.optional().describe("Inclusive start date. Defaults to 1 January of the current year."),
    endDate: isoDate.optional().describe("Inclusive end date. Defaults to today."),
    isOpenPosting: z.boolean().optional().describe("Only unsettled (open) postings."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    // The ledger only returns customers with activity IN the period, so defaulting
    // an open-items query to the current year would hide exactly the old unpaid
    // invoices it is being asked about.
    const widened = args.startDate === undefined && args.isOpenPosting === true;
    const startDate = args.startDate ?? (args.isOpenPosting ? OPEN_ITEM_FLOOR : startOfYear());
    const endDate = args.endDate ?? today();
    const path = args.customerId ? `/api/ledger/customer/${args.customerId}` : "/api/ledger/customer";
    const res = await ctx.client.request({
      method: "GET",
      path,
      query: { startDate, endDate, isOpenPosting: args.isOpenPosting },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data, {
      note:
        `Customer ledger ${startDate} to ${endDate}` +
        // Only claim the widening when it happened. A caller who scoped the query itself was
        // told the window reached back to 2000, and would have read a current-year figure as
        // total outstanding. reai_supplier_ledger already gates this; this one did not.
        `${args.isOpenPosting ? " (open postings only" : ""}` +
        `${widened ? " — window widened to catch older unpaid items" : ""}` +
        `${args.isOpenPosting ? ")" : ""}.`,
    });
  },
});

// --- Products --------------------------------------------------------------

const listProducts = defineTool({
  name: "reai_list_products",
  title: "List products",
  description:
    "List products (varer og tjenester) with their variants. Order lines can reference a variant " +
    "by variantId, which is how a line inherits the product's price and VAT code.",
  risk: "read",
  apiPaths: [["GET", "/api/products"]],
  inputSchema: { tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/products",
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return okList(res.data, { noun: "product", suffix: "." });
  },
});

const createProduct = defineTool({
  name: "reai_create_product",
  title: "Create a product",
  description:
    "Create a product or service. Set stockItem=true for something tracked in inventory. " +
    "This creates a product with NO variants and no selling price — those live in the `variants` " +
    "array, which is not exposed here. Since order lines reference a variantId to inherit price and " +
    "VAT code, a product created this way may not be usable on a line yet. For anything involving " +
    "variants, stock or pricing, check the schema with reai_describe_endpoint POST /api/products " +
    "and use reai_request.",
  risk: "reversible",
  apiPaths: [["POST", "/api/products"]],
  inputSchema: {
    title: requiredName().describe(
      "Product name. Required and non-blank: the schema says minLength 1 and the API enforces it.",
    ),
    description: z.string().optional().describe("Product description."),
    stockItem: z.boolean().optional().describe("Track this product in inventory."),
    vatCode: z
      .string()
      .optional()
      .describe(
        "Default VAT code for this product, from reai_list_vat_codes. The unfiltered list returns " +
          "EVERY code ReAI supports rather than the ones THIS tenant may use, and a wrong default " +
          "here propagates onto every order and invoice line that picks the product up.",
      ),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...body } = args;
    const res = await ctx.client.request({
      method: "POST",
      path: "/api/products",
      body,
      tenantId: requireTenantId(tenantId, ctx),
    });
    return ok(res.data, { note: "Product created." });
  },
});

// --- Orders ----------------------------------------------------------------

/**
 * Shared line fields. Order and offer lines differ in what is REQUIRED: an order
 * line needs only quantity and unitPrice, while an offer line also demands
 * itemName and vatCode. Sending an order-shaped line to /api/offers is a 400, so
 * the two are built separately below rather than shared wholesale.
 */
// Orders and offers differ here, and the difference only shows up later, so each
// gets its own wording rather than sharing one description that is wrong for one of
// them. Someone using the curated tool reads this schema, not the quirks registry.
const ORDER_VAT_CODE = z
  .string()
  .describe(
    'VAT code. Order lines accept ONLY the codes returned by reai_list_vat_codes with ' +
      'usage="customer-invoice"; anything else is rejected outright with "Mva-kode N er ikke ' +
      'tillatt".',
  );

const OFFER_VAT_CODE = z
  .string()
  .describe(
    'VAT code. Offer lines are NOT validated against usage="customer-invoice", so a code outside ' +
      'that list is accepted and stored here and then rejected later, when the offer becomes an ' +
      'order or invoice. Acceptance is not confirmation: check the code against ' +
      'reai_list_vat_codes with usage="customer-invoice" yourself.',
  );

const lineBase = {
  quantity: z
    .number()
    .min(0)
    .max(99_999_999.99)
    .refine(isWholeOre, { message: "quantity must be in steps of 0.01" })
    .describe("Quantity. Zero or positive, at most 99999999.99, in steps of 0.01."),
  // Bounds are shared; the nonzero rule is NOT. Only CreateOrderLineReq documents
  // "must not be exactly zero" — OfferLineReq permits it, and a zero-priced quote line
  // (a free item, or something informational) is a real thing to send.
  unitPrice: z
    .number()
    .min(-10_000_000)
    .max(10_000_000)
    .describe("Unit price, between -10000000 and 10000000. Negative is allowed for a discount line."),
  comment: z.string().optional().describe("Extra line comment."),
  discount: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe("Discount percentage, a whole number 0–100."),
  variantId: z.number().int().optional().describe("Product variant id, from reai_list_products."),
};

const orderLine = z.object({
  ...lineBase,
  unitPrice: lineBase.unitPrice
    .refine((v) => v !== 0, { message: "unitPrice must not be exactly zero on an order line" })
    .describe(
      "Unit price. Must NOT be exactly zero on an order line, which the API states explicitly; " +
        "negative is allowed for a credit line. Offer lines do permit zero.",
    ),
  itemName: z.string().optional().describe("Line text. Falls back to the product name when variantId is set."),
  vatCode: ORDER_VAT_CODE.optional(),
});

const offerLine = z.object({
  ...lineBase,
  // Both required by OfferLineReq, unlike on an order line.
  itemName: z.string().min(1).describe("Line text. Required on offer lines."),
  vatCode: OFFER_VAT_CODE,
});

/**
 * Resolve the payment terms to send on an order or offer.
 *
 * The API requires `daysUntilDue` and it is non-nullable, so something must
 * supply a number — it can never fall through to the customer record on ReAI's
 * side. To avoid silently overriding terms the user already configured, read the
 * customer's own `daysUntilDue` first and only then fall back to 14.
 */
async function resolveDaysUntilDue(
  explicit: number | undefined,
  customerId: number,
  tenantId: number,
  ctx: ToolContext,
): Promise<{ days: number; source: "argument" | "customer" | "fallback" }> {
  if (explicit !== undefined) return { days: explicit, source: "argument" };
  try {
    const res = await ctx.client.request<{ daysUntilDue?: number | null }>({
      method: "GET",
      path: `/api/customers/${customerId}`,
      tenantId,
    });
    const fromCustomer = res.data?.daysUntilDue;
    if (typeof fromCustomer === "number" && fromCustomer > 0) {
      return { days: fromCustomer, source: "customer" };
    }
  } catch {
    // A failed lookup must not block creating the document; 14 days is the
    // conventional Norwegian default.
  }
  return { days: 14, source: "fallback" };
}

const listOrders = defineTool({
  name: "reai_list_orders",
  title: "List orders",
  description:
    "List orders (ordrer) with their lines. An order is the document that carries the line items; " +
    "invoicing it later creates the invoice. Filter by status, customer, date range or reference.",
  risk: "read",
  apiPaths: [["GET", "/api/orders"]],
  inputSchema: {
    status: z
      .enum(["all", "open", "closed"])
      .optional()
      .describe(
        'Filter by order status. With "open" the date window is widened automatically — see the ' +
          "note on startDate.",
      ),
    customerId: z.number().int().positive().optional().describe("Filter by customer."),
    orderNumber: z.string().optional().describe("Filter by order number."),
    externalReference: z
      .string()
      .max(100, "The API caps externalReference at 100 characters.")
      .optional()
      .describe("Filter by an external system's reference."),
    startDate: isoDate
      .optional()
      .describe(
        "Inclusive start date. The API defaults this to ONE YEAR before endDate, so an order left " +
          'unbilled longer than that is invisible unless you widen it. With status="open" this tool ' +
          "reaches back to 2000 instead, because that is the question people are really asking.",
      ),
    endDate: isoDate.optional().describe("Inclusive end date."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...query } = args;
    // The API defaults startDate to one year before endDate, and the endpoint returns
    // only orders in that window — so "which orders are still unbilled" silently
    // omitted anything older, exactly as the customer ledger did before it was
    // widened. An unbilled order from two years ago is precisely the one worth seeing.
    const widened = args.status === "open" && args.startDate === undefined;
    if (widened) query.startDate = OPEN_ITEM_FLOOR;
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/orders",
      query,
      tenantId: requireTenantId(tenantId, ctx),
    });
    return okList(res.data, {
      noun: "order",
      suffix:
        "." +
        (widened
          ? ` Window widened back to ${OPEN_ITEM_FLOOR}: the API would otherwise default to one ` +
            `year and hide older unbilled orders.`
          : ""),
    });
  },
});

const getOrder = defineTool({
  name: "reai_get_order",
  title: "Get one order",
  description: "Fetch a single order by id, with its lines and totals.",
  risk: "read",
  apiPaths: [["GET", "/api/orders/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Order id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const res = await ctx.client.request({
      method: "GET",
      path: `/api/orders/${args.id}`,
      tenantId,
    });
    return ok(res.data, { link: ctx.client.deepLink(`/orders/${args.id}`, tenantId) });
  },
});

const createOrder = defineTool({
  name: "reai_create_order",
  title: "Create an order",
  description:
    "Create an order with line items. This is the first half of billing a customer: the order holds " +
    "the lines, and reai_create_invoice_from_order then turns it into an invoice.\n\n" +
    "An order on its own sends nothing to the customer, which is why it is reversible. Note that " +
    "sendEhf is deliberately NOT offered here: it arms EHF/Peppol transmission at invoicing time, " +
    "which cannot be recalled once it happens, so setting it requires REAI_WRITE_MODE=full via " +
    "reai_request.",
  risk: "reversible",
  apiPaths: [["POST", "/api/orders"], ["GET", "/api/customers/{id}"]],
  inputSchema: {
    customerId: z.number().int().positive().describe("Customer to bill. Find one with reai_list_customers."),
    orderLines: z.array(orderLine).min(1).describe("At least one line item."),
    currencyCode: CURRENCY.optional().describe('ISO 4217 code. Defaults to "NOK".'),
    daysUntilDue: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Payment terms in days. The API requires a value, so when omitted this reads the customer's " +
          "own daysUntilDue and falls back to 14 — meaning anything you pass here OVERRIDES the " +
          "customer's default terms.",
      ),
    issueDate: isoDate.optional().describe("Order date. Defaults to today."),
    comment: z.string().optional().describe("Comment visible to the customer."),
    internalComment: z.string().optional().describe("Internal note, not shown to the customer."),
    buyerReference: z
      .string()
      .max(255, "The API caps buyerReference at 255 characters.")
      .optional()
      .describe("The customer's own reference (deres ref)."),
    externalReference: z
      .string()
      .max(100, "The API caps externalReference at 100 characters.")
      .optional()
      .describe("Your reference from an external system."),
    projectId: z.number().int().optional().describe("Link the order to a project."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...rest } = args;
    const resolved = requireTenantId(tenantId, ctx);
    const terms = await resolveDaysUntilDue(args.daysUntilDue, args.customerId, resolved, ctx);
    const res = await ctx.client.request<{ id?: number; number?: string; webUrl?: string }>({
      method: "POST",
      path: "/api/orders",
      body: {
        ...rest,
        currencyCode: args.currencyCode ?? "NOK",
        daysUntilDue: terms.days,
        issueDate: args.issueDate ?? today(),
      },
      tenantId: resolved,
    });
    const id = res.data?.id;
    return ok(res.data, {
      note:
        // The API returns `number`, not `orderNumber`, so this read undefined every
        // time and the document number — the one thing a user wants back — was dropped.
        `Order created${res.data?.number ? ` (${res.data.number})` : ""}. ` +
        `Payment terms ${terms.days} days (${describeTermsSource(terms.source)}). ` +
        `Nothing has been sent to the customer yet — invoice it with reai_create_invoice_from_order.`,
      // Prefer the URL the API itself returns over a guessed one.
      ...(res.data?.webUrl
        ? { link: res.data.webUrl }
        : id
          ? { link: ctx.client.deepLink(`/orders/${id}`, resolved) }
          : {}),
    });
  },
});

/**
 * Fields the order PUT accepts on a line, and the ones a GET adds that it does not.
 *
 * The response and the request disagree, which is the whole reason this tool exists. `GET /api/orders/{id}`
 * returns the lines under **`lines`**; `PUT /api/orders/{id}` requires them under **`orderLines`**. And each
 * line the GET returns carries four fields the PUT schema does not declare — `id`, `vatTitle`, `vatRate`,
 * `amounts` — three of which are computed. Measured against the document and against order 4105 on 2783.
 */
const ORDER_LINE_REQUEST_FIELDS = [
  "itemName",
  "comment",
  "quantity",
  "unitPrice",
  "discount",
  "vatCode",
  "variantId",
  "accrualEnabled",
  "accrualPeriod",
  "accrualPeriodCount",
] as const;

/** The optional top-level fields a partial PUT would silently drop. */
const ORDER_CARRIED_FIELDS = [
  "comment",
  "internalComment",
  "buyerReference",
  "externalReference",
  "projectId",
  "invoiceEmail",
] as const;

type OrderRes = {
  id?: number;
  number?: string;
  status?: string;
  invoiceId?: number | null;
  sendEhf?: boolean;
  lines?: Array<Record<string, unknown>>;
  webUrl?: string;
} & Record<string, unknown>;

const updateOrder = defineTool({
  name: "reai_update_order",
  title: "Change an order without losing its lines",
  description:
    "Change one or more fields on an existing order, leaving the rest alone.\n\n" +
    "`PUT /api/orders/{id}` is a FULL REPLACEMENT, and the response does not have the shape the request " +
    "wants — so a read-modify-write done by hand goes wrong in three separate ways. The lines come back " +
    "under `lines` and must be sent as `orderLines`. Each line the GET returns carries `id`, `vatTitle`, " +
    "`vatRate` and `amounts`, none of which the PUT declares. And `comment`, `internalComment`, " +
    "`buyerReference`, `externalReference`, `projectId` and `invoiceEmail` are all optional, so a PUT that " +
    "omits them keeps the order but empties those fields.\n\n" +
    "The API does protect the money: `orderLines`, `currencyCode`, `customerId`, `daysUntilDue` and " +
    "`issueDate` are REQUIRED, so a partial PUT is refused with a 400 rather than quietly dropping the " +
    "lines. That is the one thing you cannot break here by accident — everything else in the list above " +
    "you can. This tool reads the order, maps the lines back into the shape the request wants, carries the " +
    "optional fields, and applies your changes on top.\n\n" +
    "`sendEhf` is not offered, matching reai_create_order, and an order that ALREADY has it set is " +
    "refused rather than updated. Carrying the flag forward would re-arm EHF/Peppol on an edit that had " +
    "nothing to do with sending — the policy classifies a body carrying sendEhf as an external " +
    "transmission, which is verified — and dropping it would silently change what happens at invoicing " +
    "time. Neither is a choice this tool should make for you: reai_request can do it deliberately.\n\n" +
    "An order that has already been invoiced is refused too. The invoice is the legal document and " +
    "editing the order behind it does not change it; what the API actually does in that case was NOT " +
    "established, because no invoiced order was available to measure. Stated rather than guessed.",
  risk: "reversible",
  apiPaths: [
    ["GET", "/api/orders/{id}"],
    ["PUT", "/api/orders/{id}"],
  ],
  inputSchema: {
    id: z.number().int().positive().describe("Order id, as returned by reai_list_orders."),
    orderLines: z
      .array(orderLine)
      .min(1)
      .optional()
      .describe(
        "Replace the line items. Omit to keep the existing lines exactly as they are — they are read and " +
          "sent back for you, which is what the underlying PUT requires.",
      ),
    customerId: z.number().int().positive().optional().describe("Move the order to a different customer."),
    currencyCode: CURRENCY.optional(),
    daysUntilDue: z.number().int().positive().optional().describe("Payment terms in days."),
    issueDate: isoDate.optional().describe("Order date."),
    comment: z.string().optional().describe("Comment visible to the customer."),
    internalComment: z.string().optional().describe("Internal note, not shown to the customer."),
    buyerReference: z
      .string()
      .max(255, "The API caps buyerReference at 255 characters.")
      .optional()
      .describe("The customer's own reference (deres ref)."),
    externalReference: z
      .string()
      .max(100, "The API caps externalReference at 100 characters.")
      .optional()
      .describe("Your reference from an external system."),
    projectId: z.number().int().optional().describe("Link the order to a project."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, ...changes } = args;
    const resolved = requireTenantId(tenantId, ctx);
    const asked = Object.entries(changes).filter(([, v]) => v !== undefined);
    if (asked.length === 0) {
      return fail(
        `No changes were given, so nothing was written. Passing nothing here would rewrite the order with ` +
          `its current values, which is a pointless full replacement of a billing record.`,
      );
    }

    const current = await ctx.client.request<OrderRes>({
      method: "GET",
      path: `/api/orders/${id}`,
      tenantId: resolved,
    });
    const order = current.data;
    if (!order) {
      return fail(`Order ${id} could not be read, so nothing was written. A PUT here REPLACES the order.`);
    }

    if (order.sendEhf === true) {
      return fail(
        `Order ${id} has sendEhf set, so this tool will not update it. Nothing was written.\n\n` +
          `A PUT replaces the record, so the flag must either be sent again — which the write policy reads ` +
          `as an external transmission, the same as arming the send in the first place — or left out, which ` +
          `would silently disarm EHF at invoicing time without you asking. Both are decisions about whether ` +
          `something leaves the tenant, and this tool does not make them.\n\n` +
          `reai_request PUT /api/orders/${id} will do either, deliberately, under the gates that apply.`,
      );
    }
    if (order.invoiceId !== null && order.invoiceId !== undefined) {
      return fail(
        `Order ${id} has already been invoiced (invoiceId ${order.invoiceId}${order.status ? `, status ${order.status}` : ""}), ` +
          `so nothing was written. The invoice is the legal document and changing the order behind it does ` +
          `not change the invoice — the remedy for a wrong invoice is a credit note, via ` +
          `reai_credit_invoice.\n\n` +
          `What the API itself does to an invoiced order was not established: none was available to ` +
          `measure. So this refuses rather than finding out on your books. reai_request PUT ` +
          `/api/orders/${id} will if you have decided to.`,
      );
    }

    // The lines, renamed and stripped. Sending `id`, `vatTitle`, `vatRate` or `amounts` back is sending
    // fields the request schema does not declare, three of which the API computes.
    const existingLines = Array.isArray(order.lines) ? order.lines : undefined;
    if (!changes.orderLines && (!existingLines || existingLines.length === 0)) {
      return fail(
        `Order ${id} came back with no readable lines, so nothing was written. \`orderLines\` is required ` +
          `by the PUT, and inventing one would replace the order's contents. Pass \`orderLines\` ` +
          `explicitly if you mean to set them.`,
      );
    }
    const mappedLines = (existingLines ?? []).map((line) =>
      Object.fromEntries(
        ORDER_LINE_REQUEST_FIELDS.filter((f) => line[f] !== undefined).map((f) => [f, line[f]]),
      ),
    );

    const carried = Object.fromEntries(
      ORDER_CARRIED_FIELDS.filter((f) => order[f] !== undefined && order[f] !== null).map((f) => [f, order[f]]),
    );

    const body: Record<string, unknown> = {
      // Required by the PUT, so they come from the record rather than being left out.
      currencyCode: order.currencyCode,
      customerId: order.customerId,
      daysUntilDue: order.daysUntilDue,
      issueDate: order.issueDate,
      orderLines: mappedLines,
      ...carried,
      // The caller's changes last.
      ...Object.fromEntries(asked),
    };

    const res = await ctx.client.request<OrderRes>({
      method: "PUT",
      path: `/api/orders/${id}`,
      body,
      tenantId: resolved,
    });

    const changedKeys = asked.map(([k]) => k);
    const notes = [
      `Changed ${changedKeys.join(", ")} on order ${order.number ?? id}. ` +
        `${changes.orderLines ? `${changes.orderLines.length} line(s) replaced` : `${mappedLines.length} existing line(s) read and sent back unchanged`}` +
        `${Object.keys(carried).length > 0 ? `, and ${Object.keys(carried).join(", ")} carried over` : ""} — ` +
        `because this API replaces rather than patches.`,
    ];
    const after = res.data;
    const notApplied = changedKeys.filter(
      (k) => k !== "orderLines" && after?.[k] !== undefined && JSON.stringify(after[k]) !== JSON.stringify((changes as Record<string, unknown>)[k]),
    );
    if (notApplied.length > 0) {
      notes.push(
        `WARNING: ${notApplied
          .map((k) => `${k}: sent ${JSON.stringify((changes as Record<string, unknown>)[k])}, stored ${JSON.stringify(after?.[k])}`)
          .join("; ")}. Check the value is one the API accepts.`,
      );
    }
    return ok(res.data, {
      note: notes.join("\n\n"),
      ...(res.data?.webUrl ? { link: res.data.webUrl } : { link: ctx.client.deepLink(`/orders/${id}`, resolved) }),
    });
  },
});

// --- Offers ----------------------------------------------------------------

function describeTermsSource(source: "argument" | "customer" | "fallback"): string {
  if (source === "argument") return "as requested, overriding the customer's default";
  if (source === "customer") return "from the customer's default terms";
  return "default, as the customer has no terms set";
}

const listOffers = defineTool({
  name: "reai_list_offers",
  title: "List offers",
  description:
    "List offers/quotes (tilbud), optionally filtered by customer, number or date range.\n\n" +
    "The API defaults this to the LAST YEAR (startDate defaults to one year before endDate, " +
    "endDate to today), and offers routinely sit open longer than that. Unlike /api/orders, no " +
    "filter here disables those defaults — a customerId or offerNumber search is windowed too — " +
    "so this tool widens startDate when you do not give one, and says so in the result.",
  risk: "read",
  apiPaths: [["GET", "/api/offers"]],
  inputSchema: {
    customerId: z.number().int().positive().optional().describe("Filter by customer."),
    offerNumber: z.string().optional().describe("Filter by offer number."),
    startDate: isoDate
      .optional()
      .describe(
        "Inclusive start date. Omit to search from " +
          OPEN_ITEM_FLOOR +
          ", rather than the API's default of one year back.",
      ),
    endDate: isoDate.optional().describe("Inclusive end date. Defaults to today."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...query } = args;
    // The API windows this to one year and NO filter here disables that, unlike
    // /api/orders where externalReference does. So "find the offer we sent Acme" was
    // silently limited to the last twelve months, and the tool reported the truncated
    // result as a bare count with no caveat. Offers stay open longer than a year.
    const widened = args.startDate === undefined;
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/offers",
      query: { ...query, ...(widened ? { startDate: OPEN_ITEM_FLOOR } : {}) },
      tenantId: requireTenantId(tenantId, ctx),
    });
    return okList(res.data, {
      noun: "offer",
      suffix: `${widened ? ` from ${OPEN_ITEM_FLOOR} onwards — the API would otherwise have shown only the last year` : ""}.`,
    });
  },
});

const createOffer = defineTool({
  name: "reai_create_offer",
  title: "Create an offer",
  description:
    "Create an offer/quote (tilbud) for a customer. Creating it does not send it; delivery is a " +
    "separate step.\n\n" +
    "Offer lines are stricter than order lines: itemName and vatCode are both required.",
  risk: "reversible",
  apiPaths: [["POST", "/api/offers"], ["GET", "/api/customers/{id}"]],
  inputSchema: {
    customerId: z.number().int().positive().describe("Customer the offer is for."),
    offerLines: z
      .array(offerLine)
      .min(1)
      .describe("At least one line item. Offer lines require itemName and vatCode, unlike order lines."),
    currencyCode: CURRENCY.optional().describe('ISO 4217 code. Defaults to "NOK".'),
    daysUntilDue: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Payment terms in days. Required by the API, so when omitted the customer's own " +
          "daysUntilDue is used, falling back to 14.",
      ),
    issueDate: isoDate.optional().describe("Offer date. Defaults to today."),
    comment: z.string().optional().describe("Comment visible to the customer."),
    internalComment: z.string().optional().describe("Internal note."),
    projectId: z.number().int().optional().describe("Link the offer to a project."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...rest } = args;
    const resolved = requireTenantId(tenantId, ctx);
    const terms = await resolveDaysUntilDue(args.daysUntilDue, args.customerId, resolved, ctx);
    const res = await ctx.client.request<{ id?: number }>({
      method: "POST",
      path: "/api/offers",
      body: {
        ...rest,
        currencyCode: args.currencyCode ?? "NOK",
        daysUntilDue: terms.days,
        issueDate: args.issueDate ?? today(),
      },
      tenantId: resolved,
    });
    const id = res.data?.id;
    return ok(res.data, {
      note:
        `Offer created with payment terms ${terms.days} days ` +
        `(${describeTermsSource(terms.source)}). It has not been sent to the customer.`,
      ...(id ? { link: ctx.client.deepLink(`/offers/${id}`, resolved) } : {}),
    });
  },
});

// --- Invoices --------------------------------------------------------------

const listInvoices = defineTool({
  name: "reai_list_invoices",
  title: "List invoices",
  description:
    "List customer invoices and credit notes. The useful filters are paymentStatus=outstanding " +
    "(unpaid) and dueDateStatus=overdue — together they answer 'what is overdue'. " +
    "Use type to separate invoices from credit notes.\n\n" +
    "The API restricts an undated query to the last year. When you filter for outstanding or " +
    "overdue invoices without a startDate, this tool reaches back to 2000 instead, so a long-" +
    "overdue invoice is not silently omitted.",
  risk: "read",
  apiPaths: [["GET", "/api/invoices"]],
  inputSchema: {
    paymentStatus: z
      .enum(["all", "outstanding", "closed"])
      .optional()
      .describe("Filter by whether the invoice is settled."),
    dueDateStatus: z
      .enum(["all", "overdue", "not_overdue"])
      .optional()
      .describe("Filter by whether the due date has passed."),
    type: z.enum(["all", "invoice", "credit_note"]).optional().describe("Filter by document type."),
    customerId: z.number().int().positive().optional().describe("Filter by customer."),
    invoiceNumber: z.string().optional().describe("Filter by invoice number."),
    startDate: isoDate.optional().describe("Inclusive start date."),
    endDate: isoDate.optional().describe("Inclusive end date."),
    updatedSince: z
      .string()
      .optional()
      .describe("Only invoices changed since this timestamp — useful for incremental sync."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...query } = args;

    // The API defaults startDate to one year before endDate, so asking for
    // outstanding or overdue invoices without dates silently excludes anything
    // more than a year old -- i.e. the worst debts.
    const wantsOpenItems =
      args.paymentStatus === "outstanding" || args.dueDateStatus === "overdue";
    const widened =
      wantsOpenItems && args.startDate === undefined && args.updatedSince === undefined;
    if (widened) query.startDate = OPEN_ITEM_FLOOR;

    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/invoices",
      query,
      tenantId: requireTenantId(tenantId, ctx),
    });
    return okList(res.data, {
      noun: "invoice",
      suffix:
        "." +
        (widened
          ? ` Searched from ${OPEN_ITEM_FLOOR}: the API would otherwise default to the last year ` +
            `only, hiding invoices overdue for longer than that.`
          : ""),
    });
  },
});

const getInvoice = defineTool({
  name: "reai_get_invoice",
  title: "Get one invoice",
  description:
    "Fetch a single invoice by id, with lines, totals and payment status. " +
    "For the PDF use reai_request GET /api/invoices/{id}/pdf with binary=true.",
  risk: "read",
  apiPaths: [["GET", "/api/invoices/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Invoice id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const res = await ctx.client.request({
      method: "GET",
      path: `/api/invoices/${args.id}`,
      tenantId,
    });
    return ok(res.data, { link: ctx.client.deepLink(`/invoices/${args.id}`, tenantId) });
  },
});

const createInvoiceFromOrder = defineTool({
  name: "reai_create_invoice_from_order",
  title: "Invoice an order",
  description:
    "Turn an existing order into an invoice. This is the only way to create a customer invoice — " +
    "there is no endpoint that builds one from line items directly, so create an order first with " +
    "reai_create_order.\n\n" +
    "Issuing an invoice posts revenue and VAT to the ledger and produces a numbered legal document. " +
    "It cannot be deleted; the remedy for a mistake is a credit note.\n\n" +
    "It also STARTS DELIVERY TO THE CUSTOMER asynchronously — ReAI tries eFaktura for eligible " +
    "Norwegian private customers, then EHF if the order has sendEhf and the customer can receive " +
    "it, then the invoice PDF by email. So this is not a books-only operation: assume the customer " +
    "will receive it. Requires REAI_WRITE_MODE=full AND REAI_ALLOW_EXTERNAL_SEND — both, because " +
    "the write mode governs what can be undone in the books and external send governs what reaches " +
    "someone else, and this does both.",
  risk: "irreversible",
  // Issuing an invoice starts delivery to the customer, so it is gated by
  // REAI_ALLOW_EXTERNAL_SEND as well as by the write mode.
  transmits: true,
  apiPaths: [["POST", "/api/invoices"]],
  inputSchema: {
    orderId: z.number().int().positive().describe("Order to invoice. Find one with reai_list_orders."),
    issueDate: isoDate
      .optional()
      .describe(
        "Invoice date, which determines the accounting period. If omitted the API uses the " +
          "ORDER's invoice date, falling back to today only when the order has none — so an old " +
          "order can post into an unexpected period. Pass this explicitly when the period matters.",
      ),
    comment: z.string().optional().describe("Comment on the invoice."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...body } = args;
    const resolved = requireTenantId(tenantId, ctx);
    const res = await ctx.client.request<{
      id?: number;
      number?: string;
      webUrl?: string;
      issueDate?: string;
    }>({
      method: "POST",
      path: "/api/invoices",
      body,
      tenantId: resolved,
    });
    const id = res.data?.id;
    // Report the date the API actually used. Saying "dated from the order" would
    // be a false assurance whenever the order had no invoice date and the API
    // fell back to today -- and the accounting period is the whole reason to care.
    const actualDate = res.data?.issueDate;
    const dateNote = args.issueDate
      ? ` dated ${args.issueDate}`
      : actualDate
        ? ` dated ${actualDate} (chosen by the API from the order, or today if it had no date)`
        : " (the API chose the date; check it if the accounting period matters)";
    return ok(res.data, {
      note:
        // `invoiceNumber` exists on InvoiceRes only nested under `order`; the invoice's
        // own number is `number`.
        `Invoice issued${res.data?.number ? ` as ${res.data.number}` : ""}` +
        `${dateNote}. ` +
        `Delivery to the customer has been started. This is now a numbered legal document — ` +
        `correct any mistake with a credit note, not by deleting it.`,
      ...(id ? { link: ctx.client.deepLink(`/invoices/${id}`, resolved) } : {}),
    });
  },
});

const creditInvoice = defineTool({
  name: "reai_credit_invoice",
  title: "Credit an invoice",
  description:
    "Create a credit note (kreditnota) reversing an issued invoice. This is the correct way to undo " +
    "an invoice: it posts an offsetting entry and leaves both documents in the audit trail, which is " +
    "what Norwegian bookkeeping rules require.\n\n" +
    "It also STARTS DELIVERY of the credit note to the customer, using the original order's " +
    "settings — so it needs REAI_ALLOW_EXTERNAL_SEND as well as REAI_WRITE_MODE=full.",
  risk: "irreversible",
  // Creating a credit note "starts credit note delivery asynchronously", using
  // the original order's settings — so it reaches the customer.
  transmits: true,
  apiPaths: [["POST", "/api/invoices/{id}/credit"]],
  inputSchema: {
    id: z.number().int().positive().describe("Id of the invoice to credit."),
    issueDate: isoDate.describe("Date of the credit note. Determines the accounting period."),
    comment: z.string().optional().describe("Reason for the credit note. Worth filling in for the audit trail."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, ...body } = args;
    const resolved = requireTenantId(tenantId, ctx);
    const res = await ctx.client.request<{
      id?: number;
      number?: string;
      webUrl?: string;
      creditedInvoiceNumber?: string;
    }>({
      method: "POST",
      path: `/api/invoices/${id}/credit`,
      body,
      tenantId: resolved,
    });
    const creditId = res.data?.id;
    return ok(res.data, {
      note:
        `Credit note created${res.data?.number ? ` (${res.data.number})` : ""} for invoice ` +
        `${res.data?.creditedInvoiceNumber ?? id}.`,
      ...(creditId ? { link: ctx.client.deepLink(`/invoices/${creditId}`, resolved) } : {}),
    });
  },
});

const registerInvoicePayment = defineTool({
  name: "reai_register_invoice_payment",
  title: "Register a payment on an invoice",
  description:
    "Record that a customer paid an invoice. This settles the customer ledger and posts to the bank " +
    "account, so it moves money in the books. A partial amount is allowed and leaves the rest " +
    "outstanding. Requires REAI_WRITE_MODE=full.\n\n" +
    "companyBankId is required unless paidPrivately is true, and registerRestAsBankFee must be " +
    "false when it is. For a foreign-currency invoice, receivedAmount is what landed in the " +
    "company account and paidInvoiceCurrencyAmount is what the customer paid.",
  risk: "irreversible",
  apiPaths: [["POST", "/api/invoices/{id}/payments"]],
  inputSchema: {
    id: z.number().int().positive().describe("Invoice id."),
    paymentDate: isoDate.describe("Date the money was received."),
    receivedAmount: z
      .number()
      .min(0.01)
      .max(99_999_999.99)
      // The money field on an irreversible payment tool, and it accepted 1234.567.
      .refine(isWholeOre, { message: "receivedAmount must be a whole number of øre." })
      .describe(
        "Amount received, in the company's currency. May be less than the invoice total, leaving " +
          "the rest outstanding. Must be positive — this endpoint records money arriving.",
      ),
    companyBankId: z
      .number()
      .int()
      .optional()
      .describe("Bank account that received it. List them with reai_request GET /api/company-banks."),
    paidInvoiceCurrencyAmount: z
      .number()
      .min(0.01)
      .max(99_999_999.99)
      .refine(isWholeOre, { message: "paidInvoiceCurrencyAmount must be a whole number of øre." })
      .optional()
      .describe(
        "Amount the customer paid in the INVOICE's currency, required when that differs from the " +
          "tenant's currency.",
      ),
    registerRestAsBankFee: z
      .boolean()
      .optional()
      .describe(
        "Book any shortfall as a bank fee rather than leaving it outstanding. When this is true, " +
          "receivedAmount must be the NET amount that reached the account after the fee — not the " +
          "invoice total. Sending the gross figure leaves nothing for the fee and the shortfall " +
          "silently disappears.",
      ),
    paidPrivately: z
      .boolean()
      .optional()
      .describe("The payment went to an owner privately rather than to a company account."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, ...body } = args;
    const resolved = requireTenantId(tenantId, ctx);

    // The same pairings the supplier-side tool enforces, which this one had none of —
    // and this is a money endpoint. Checked locally so the failure explains itself
    // instead of arriving as a generic 400 from a call that has already been made.
    if (args.paidPrivately === true) {
      const offenders = [
        args.companyBankId !== undefined ? "companyBankId" : null,
        args.registerRestAsBankFee === true ? "registerRestAsBankFee=true" : null,
      ].filter(Boolean);
      if (offenders.length > 0) {
        return fail(
          `paidPrivately=true records the payment against the owner's private account, so ` +
            `${offenders.join(" and ")} must be omitted. Nothing was sent to ReAI.`,
        );
      }
    } else if (args.companyBankId === undefined) {
      return fail(
        "companyBankId is required unless paidPrivately is true — the payment has to land " +
          "somewhere. List the accounts with reai_list_company_banks. Nothing was sent to ReAI.",
      );
    }

    const res = await ctx.client.request({
      method: "POST",
      path: `/api/invoices/${id}/payments`,
      body,
      tenantId: resolved,
    });
    return ok(res.data, {
      note: `Payment of ${args.receivedAmount} registered on invoice ${id} dated ${args.paymentDate}.`,
      link: ctx.client.deepLink(`/invoices/${id}`, resolved),
    });
  },
});


const unarchiveCustomer = defineTool({
  name: "reai_unarchive_customer",
  title: "Unarchive a customer",
  description:
    "Bring an archived customer back into use. ReAI archives rather than deletes a customer that " +
    "has transactions, and an archived one is invisible to reai_list_customers unless you pass " +
    "archived: true — so this is how a counterparty that was tidied away too eagerly is recovered.\n\n" +
    "Measured on the test tenant: a customer reading archived: true answered 200 here and read " +
    "back archived: false.\n\n" +
    "One thing it does NOT fix, stated because it is the case that made this tool worth adding: an " +
    "order whose customer was archived answers 500 \"Referenced record is not accessible\" on " +
    "DELETE, and unarchiving the customer does not make that order deletable again — tried, the 500 " +
    "persists. What blocks such an order is usually a deleted PRODUCT on its line, and products " +
    "have no unarchive endpoint at all.",
  risk: "reversible",
  apiPaths: [["POST", "/api/customers/{id}/unarchive"]],
  inputSchema: {
    id: z
      .number()
      .int()
      .positive()
      .describe("Customer id. Find archived ones with reai_list_customers archived: true."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<{ archived?: boolean; name?: string }>({
      method: "POST",
      path: `/api/customers/${args.id}/unarchive`,
      body: {},
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    // Only `archived: false` supports the success sentence. `=== true` made an ABSENT field read as
    // recovered, so a null or fieldless 200 would have been reported as "active again" without
    // anything having been verified — the same absence-is-not-evidence rule this server applies to
    // list shapes and delete outcomes.
    const archived = res.data?.archived;
    return ok(res.data ?? { customerId: args.id }, {
      note:
        archived === false
          ? `Customer ${args.id}${res.data?.name ? ` (${res.data.name})` : ""} is active again and ` +
            `back in reai_list_customers.`
          : archived === true
            ? `Customer ${args.id} still reads archived: true after the call answered HTTP ` +
              `${res.status}. Nothing was recovered — read it with reai_get_customer before relying on it.`
            : `Customer ${args.id}: the call answered HTTP ${res.status} but the response carried no ` +
              `archived field (${JSON.stringify(archived)}), so whether it is active again is NOT ` +
              `established. Read it with reai_list_customers archived: true — if it still appears ` +
              `there, nothing was recovered.`,
    });
  },
});


/**
 * Contact persons on a customer: the named humans, as distinct from the customer record's own
 * `email` and `phone`, which are the company's.
 *
 * Everything asserted below was measured against the live API on tenant 2783 on 2026-08-08, with
 * every probe record deleted afterwards. Most of it is not in the spec, or is in a place an agent
 * working on this endpoint would not read:
 *
 *   - **Company customers only.** Adding one to a private customer (`privateContact: true`) is
 *     refused with 400 "Contact persons can only be added to company customers". The spec does say so,
 *     but in a different place than an agent adding a contact would look: it is a sentence on
 *     `CreateCustomerReq.contactPersons`, the nested array used when CREATING a customer, not on this
 *     endpoint. An earlier version of this comment claimed "nothing in the schema hints at this",
 *     which was wrong.
 *   - **The phone number is parsed and canonicalised, not merely validated** — and the rule is not
 *     local to contacts. It is the same one on `customer.phone` and `supplier.phone`, and it lives in
 *     `PHONE_RULE` in registry.ts with the measurements behind it, because three places in this
 *     repository described this behaviour three different ways and one of them was false. Short
 *     version: default region NO, stored as E.164, and a bare number that is valid in Norway is
 *     stored under +47 whatever the caller meant.
 *   - **`null` and `""` differ on the update.** `null` (or omitting) leaves a field unchanged; `""`
 *     clears it. That is what the spec says, and it is easy to verify wrongly: clearing a field and
 *     then testing `null` on the already-empty field shows "unchanged" either way. Each case here
 *     was run from a freshly populated contact.
 *   - **A blank name is refused**, on the update as well as the create, with 400 "Validation failed"
 *     and a `fieldErrors` list. Duplicate names are allowed.
 *   - **Deleting the customer takes its contacts with it** — the list 404s afterwards rather than
 *     returning an empty array, which is why every tool here reports the customer 404 distinctly.
 */
/**
 * The API's own words for the refusals an agent will actually hit, translated once.
 *
 * Matched over detail AND the raw body, as bankvat.ts and investments.ts do: ReAI puts a validation
 * message in `fieldErrors` rather than `detail` often enough that detail-only translation fails open
 * on the commonest 400.
 */
function translateContactError(err: unknown, customerId: number, contactPersonId?: number): unknown {
  if (!(err instanceof ReaiApiError)) return err;
  const detail = err.problem?.detail ?? "";
  const haystack = `${detail} ${err.rawBody ?? ""} ${err.message}`;
  if (err.status === 400 && /only be added to company customers/i.test(haystack)) {
    return new Error(
      `Customer ${customerId} is a private individual, and ReAI only allows contact persons on ` +
        `company customers. Its own email and phone are on the customer record — set those with ` +
        `reai_update_customer instead.`,
    );
  }
  if (err.status === 400 && /gyldig telefonnummer/i.test(haystack)) {
    return new Error(
      `The phone number could not be parsed as a valid number for its country, so nothing was ` +
        `written. This error does NOT tell you which country was resolved: the same 400 answers a ` +
        `bare number read as Norwegian AND a number sent with a country code that is simply ` +
        `malformed, so do not "fix" a foreign number by changing its country code on the strength ` +
        `of it.\n${PHONE_RULE}\nThe API's own words: ${detail}`,
    );
  }
  // The order of these two matters, and getting it wrong is how this shipped saying something false.
  //
  // ReAI distinguishes the cases perfectly — "Customer with id=999999 not found." for a missing
  // customer, "Contact person with id=22 not found for customer with id=6022" for a contact that
  // exists but under someone else. The first version matched /Customer with id=/i, CASE-INSENSITIVELY,
  // which the SECOND message also contains ("...not found for customer with id=6022"). So the most
  // common 404 on these endpoints was translated into "Customer N does not exist in this tenant" —
  // about a customer that is fine, sending the agent off to re-check or re-create it. Found by the
  // independent review of PR #110; it is the same shape as the reconciliation finding Codex caught,
  // a phrase-gated translation turning one failure into a confident verdict about a different one.
  if (err.status === 404 && /Contact person with id=/i.test(haystack)) {
    return new Error(
      `Contact person ${contactPersonId ?? "(unknown)"} is not on customer ${customerId}. ` +
        `AMBIGUOUS, and the API does not say which: the contact may never have existed or been ` +
        `deleted already, or the id may be real but belong to a DIFFERENT customer — ids are scoped ` +
        `to the tenant, not to the customer, so the pair has to match. Measured: both cases answer ` +
        `this same sentence, word for word. Settle it with reai_list_customer_contacts on the ` +
        `customer you meant. The API's own message: ${detail}`,
    );
  }
  if (err.status === 404 && /^Customer with id=/.test(detail)) {
    return new Error(
      `Customer ${customerId} does not exist in this tenant. Note that a deleted customer takes its ` +
        `contact persons out of reach with it, so a contact id that worked before may now answer this.`,
    );
  }
  return err;
}

const listCustomerContacts = defineTool({
  name: "reai_list_customer_contacts",
  title: "List a customer's contact persons",
  description:
    "List the named contact persons on a customer. These are people; the customer record's own " +
    "`email` and `phone` belong to the company.\n\n" +
    "Worth knowing before reaching for this: reai_get_customer ALREADY returns the same array as " +
    "`contactPersons`, so if you are fetching the customer anyway you have them. What it does not " +
    "come from is the customer LIST, which omits the array — that is the gap this fills, along with " +
    "not having to know the contacts are nested inside a customer payload.\n\n" +
    "A company customer with no contacts answers with an empty list. A customer that does not " +
    "exist answers 404, and so does one that has been deleted — deleting a customer deletes its " +
    "contacts too.",
  risk: "read",
  apiPaths: [["GET", "/api/customers/{id}/contact-persons"]],
  inputSchema: {
    customerId: z.number().int().positive().describe("Customer id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    try {
      const res = await ctx.client.request({
        method: "GET",
        path: `/api/customers/${args.customerId}/contact-persons`,
        tenantId: requireTenantId(args.tenantId, ctx),
      });
      return okList(res.data, {
        noun: "contact person",
        empty: `Customer ${args.customerId} has no contact persons recorded.`,
      });
    } catch (err) {
      throw translateContactError(err, args.customerId);
    }
  },
});

const getCustomerContact = defineTool({
  name: "reai_get_customer_contact",
  title: "Get one contact person",
  description:
    "Read one contact person by id. The id is scoped to the tenant, not to the customer, so the pair " +
    "has to match: naming a contact that exists under a DIFFERENT customer answers 404 about the " +
    "CONTACT — \"Contact person with id=22 not found for customer with id=6022\". An earlier version " +
    "of this description had that backwards, and the code made the same mistake: the 404 translation " +
    "matched the customer sentence case-insensitively, which that message also contains, so the " +
    "commonest failure here was reported as \"the customer does not exist\".\n\n" +
    "Note that reai_get_customer already returns the whole `contactPersons` array, so this tool is " +
    "for fetching ONE contact without the customer payload around it. The customer LIST omits them, " +
    "which is the gap reai_list_customer_contacts fills.",
  risk: "read",
  apiPaths: [["GET", "/api/customers/{id}/contact-persons/{contactPersonId}"]],
  inputSchema: {
    customerId: z.number().int().positive().describe("Customer id."),
    contactPersonId: z.number().int().positive().describe("Contact person id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    try {
      const res = await ctx.client.request({
        method: "GET",
        path: `/api/customers/${args.customerId}/contact-persons/${args.contactPersonId}`,
        tenantId: requireTenantId(args.tenantId, ctx),
      });
      return ok(res.data);
    } catch (err) {
      throw translateContactError(err, args.customerId, args.contactPersonId);
    }
  },
});

const createCustomerContact = defineTool({
  name: "reai_create_customer_contact",
  title: "Add a contact person to a customer",
  description:
    "Add a named contact person to a COMPANY customer. A private customer cannot have contacts — " +
    "ReAI refuses with \"Contact persons can only be added to company customers\", and this tool " +
    "says so in those terms and points at reai_update_customer instead.\n\n" +
    "Only `name` is required, and a blank or whitespace-only one is refused. Duplicate names are " +
    "allowed, so adding the same person twice creates two records.\n\n" +
    `The phone field: ${PHONE_RULE}\n\n` +
    "Reversible: remove it again with reai_delete_customer_contact.",
  risk: "reversible",
  apiPaths: [["POST", "/api/customers/{id}/contact-persons"]],
  inputSchema: {
    customerId: z.number().int().positive().describe("Customer id. Must be a company, not a private individual."),
    name: requiredName(75).describe(
      "Contact person's name, at most 75 characters. Whitespace alone is refused with " +
        '"Validation failed".',
    ),
    email: z
      .string()
      // `""` is allowed through deliberately: the API accepts it and stores null, and it is the
      // documented way to clear the field on the update. Refusing it here made create and update
      // disagree about the same value, which the review of PR #110 called out.
      .refine((v) => v === "" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), {
        message: 'Must be an email address, or "" to leave it empty. The API answers 400 otherwise.',
      })
      .optional()
      .describe('Email address. Optional; "" is accepted and stores nothing.'),
    // No maxLength: neither CreateCustomerContactPersonReq.phone nor its update counterpart declares
    // one. The first version invented `.max(30)`, which is the sort of guessed bound this repo's
    // spec-bounds test exists to catch on the other side.
    phone: z
      .string()
      .optional()
      .describe(`Phone number. ${PHONE_RULE}`),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const body: Record<string, unknown> = { name: args.name };
    if (args.email !== undefined) body.email = args.email;
    if (args.phone !== undefined) body.phone = args.phone;
    try {
      const res = await ctx.client.request({
        method: "POST",
        path: `/api/customers/${args.customerId}/contact-persons`,
        body,
        tenantId: requireTenantId(args.tenantId, ctx),
      });
      const stored = res.data as { phone?: string | null } | undefined;
      const renormalised =
        args.phone !== undefined && stored?.phone && stored.phone !== args.phone
          ? ` The phone was stored as ${stored.phone}, normalised from ${args.phone}.`
          : "";
      return ok(res.data, {
        note: `Added a contact person to customer ${args.customerId}.${renormalised}`,
      });
    } catch (err) {
      throw translateContactError(err, args.customerId);
    }
  },
});

const updateCustomerContact = defineTool({
  name: "reai_update_customer_contact",
  title: "Update a contact person",
  description:
    "Change a contact person's name, email or phone. This is a PATCH, so only what you pass is " +
    "touched — but the two ways of passing nothing differ, and the difference is the whole reason " +
    "to read this description:\n" +
    "  - Omitting a field, or passing null, leaves it UNCHANGED.\n" +
    "  - Passing an empty string CLEARS it.\n\n" +
    "Measured from a freshly populated contact for each case, because the obvious way to test it — " +
    "clear a field, then pass null — reports \"unchanged\" whichever the API does.\n\n" +
    "A blank name is refused rather than treated as a clear: `name` is the one field that cannot be " +
    "emptied.\n\n" +
    `The phone rule applies here exactly as on create, and matters MORE, because an update overwrites a ` +
    `number that may have been right: ${PHONE_RULE}\n\n` +
    "The renormalisation is reported in the note, so a value that changed on the way in is visible " +
    "rather than silent.",
  risk: "reversible",
  apiPaths: [["PATCH", "/api/customers/{id}/contact-persons/{contactPersonId}"]],
  inputSchema: {
    customerId: z.number().int().positive().describe("Customer id."),
    contactPersonId: z.number().int().positive().describe("Contact person id."),
    // `.nullable()`, because the description promises null and the API accepts it. The first version
    // was `z.string().optional()`, which zod REFUSES null on — so three descriptions documented an
    // input the tool answered "Invalid arguments for tool" to, and an agent copying the wording out of
    // the spec ("Omit or null to leave unchanged") hit it. Found by the independent review of PR #110.
    // A null is stripped from the body below rather than forwarded, since omitting is what the API
    // already treats as unchanged and it keeps one code path for the two spellings.
    name: requiredName(75)
      .nullable()
      .optional()
      .describe("New name. Omit or pass null to leave unchanged; it cannot be cleared."),
    email: z
      .string()
      .nullable()
      .optional()
      .describe('New email. Omit or null to leave unchanged, "" to clear. Validated when non-empty.'),
    phone: z
      .string()
      .nullable()
      .optional()
      .describe(`New phone. Omit or null to leave unchanged, "" to clear. ${PHONE_RULE}`),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    // null and undefined both mean "leave alone", so neither reaches the body. "" is NOT the same
    // thing — it is the API's clear — which is why this cannot be a truthiness check.
    const body: Record<string, unknown> = {};
    if (args.name !== undefined && args.name !== null) body.name = args.name;
    if (args.email !== undefined && args.email !== null) body.email = args.email;
    if (args.phone !== undefined && args.phone !== null) body.phone = args.phone;
    if (Object.keys(body).length === 0) {
      return fail(
        "Nothing to change. Pass name, email or phone. An empty update is accepted by the API and " +
          'changes nothing, so it is refused here instead — and note that "" CLEARS a field while ' +
          "omitting it leaves it alone.",
      );
    }
    try {
      const res = await ctx.client.request({
        method: "PATCH",
        path: `/api/customers/${args.customerId}/contact-persons/${args.contactPersonId}`,
        body,
        tenantId: requireTenantId(args.tenantId, ctx),
      });
      const cleared = Object.entries(body)
        .filter(([, v]) => v === "")
        .map(([k]) => k);
      const stored = res.data as { phone?: string | null } | undefined;
      const renormalised =
        typeof args.phone === "string" && args.phone !== "" && stored?.phone && stored.phone !== args.phone
          ? ` The phone was stored as ${stored.phone}, normalised from ${args.phone}.`
          : "";
      return ok(res.data, {
        note:
          `Updated contact person ${args.contactPersonId}.` +
          (cleared.length > 0 ? ` Cleared: ${cleared.join(", ")}.` : "") +
          renormalised,
      });
    } catch (err) {
      throw translateContactError(err, args.customerId, args.contactPersonId);
    }
  },
});

const deleteCustomerContact = defineTool({
  name: "reai_delete_customer_contact",
  title: "Remove a contact person",
  description:
    "Remove a contact person from a customer. Answers 204 the first time and 404 the second, so a " +
    "404 here means it is already gone rather than that something failed.\n\n" +
    "This removes the contact only. The customer is untouched.",
  risk: "reversible",
  apiPaths: [["DELETE", "/api/customers/{id}/contact-persons/{contactPersonId}"]],
  destructive: true,
  inputSchema: {
    customerId: z.number().int().positive().describe("Customer id."),
    contactPersonId: z.number().int().positive().describe("Contact person id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    try {
      await ctx.client.request({
        method: "DELETE",
        path: `/api/customers/${args.customerId}/contact-persons/${args.contactPersonId}`,
        tenantId: requireTenantId(args.tenantId, ctx),
      });
      return okText(
        `Removed contact person ${args.contactPersonId} from customer ${args.customerId}. Re-add it with ` +
          `reai_create_customer_contact — the id will be a new one.`,
      );
    } catch (err) {
      // A 404 here does NOT simply mean "already gone", and the first version reporting it as a plain
      // success told the agent its goal was met when it might not be. Measured by the independent
      // review of PR #110: with contact 22 owned by customer 6021,
      // DELETE /api/customers/6022/contact-persons/22 answers 404 and the contact SURVIVES. A typo in
      // customerId did the same.
      //
      // Then measuring the wording settled it the other way from the obvious fix: a genuinely-deleted
      // contact answers "Contact person with id=40 not found for customer with id=6025" — the SAME
      // sentence as the wrong-parent case, word for word. So the two readings cannot be separated, and
      // narrowing the match to one of them would have been a second guess dressed as a fix. It is
      // reported as ambiguous instead, with the way to settle it, and a nonexistent CUSTOMER still
      // reaches the translator rather than being absorbed here.
      const body = `${err instanceof ReaiApiError ? (err.problem?.detail ?? "") : ""} ${
        err instanceof ReaiApiError ? (err.rawBody ?? "") : ""
      }`;
      if (err instanceof ReaiApiError && err.status === 404 && /Contact person with id=/i.test(body)) {
        return okText(
          `Nothing was changed: contact person ${args.contactPersonId} is not on customer ` +
            `${args.customerId}. AMBIGUOUS — either it was already removed (or never existed), or the ` +
            `id belongs to a DIFFERENT customer, since ids are scoped to the tenant rather than to the ` +
            `customer. Both cases answer with the same sentence, so this tool cannot tell you which. ` +
            `If you meant to remove it, confirm with reai_list_customer_contacts: absent there means ` +
            `the job is done, present there means the customerId was wrong.`,
        );
      }
      throw translateContactError(err, args.customerId, args.contactPersonId);
    }
  },
});

export const salesTools: ToolDef[] = [
  listCustomers,
  getCustomer,
  createCustomer,
  unarchiveCustomer,
  updateCustomer,
  setCustomerAddress,
  deleteCustomer,
  deleteProduct,
  deleteOrder,
  deleteOffer,
  customerLedger,
  listProducts,
  createProduct,
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  listOffers,
  createOffer,
  listInvoices,
  getInvoice,
  createInvoiceFromOrder,
  creditInvoice,
  registerInvoicePayment,
  listCustomerContacts,
  getCustomerContact,
  createCustomerContact,
  updateCustomerContact,
  deleteCustomerContact,
] as ToolDef[];
