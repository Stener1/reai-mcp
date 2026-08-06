import { z } from "zod";
import {
  defineTool,
  isoDate,
  ok,
  okText,
  requireTenantId,
  startOfYear,
  tenantIdArg,
  today,
  type ToolDef,
  type ToolContext,
} from "./registry.js";

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

const CURRENCY = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Must be an uppercase ISO 4217 code, e.g. "NOK".')
  .describe('ISO 4217 currency code, e.g. "NOK". Use reai_request GET /api/currencies for the full list.');

const COUNTRY_CODE = z
  .string()
  .regex(/^[A-Z]{2}$/, 'Must be a two-letter uppercase ISO country code, e.g. "NO".');

// --- Customers -------------------------------------------------------------

const listCustomers = defineTool({
  name: "reai_list_customers",
  title: "List customers",
  description:
    "List or search customers (kunder). Filter by name, organisation number or email. " +
    "Archived customers are excluded unless you ask for them.",
  risk: "read",
  inputSchema: {
    name: z.string().optional().describe("Filter by name (partial match)."),
    organizationNumber: z.string().optional().describe("Filter by Norwegian organisation number."),
    email: z.string().optional().describe("Filter by email address."),
    archived: z.boolean().optional().describe("Include archived customers instead of active ones."),
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
    const count = Array.isArray(res.data) ? res.data.length : 0;
    return ok(res.data, { note: `${count} customer(s).` });
  },
});

const getCustomer = defineTool({
  name: "reai_get_customer",
  title: "Get one customer",
  description: "Fetch a single customer by id, including addresses and invoicing settings.",
  risk: "read",
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
    "ReAI looks the company up in Brønnøysundregistrene and fills in the name and address, so " +
    "supplying just the organisation number is usually enough — pass skipRegistryLookup to opt out.\n\n" +
    "Note that ReAI normalizes the stored name to title case, so it may not come back exactly as sent.\n\n" +
    "Creation accepts only the fields listed here. Invoice email, phone and payment terms are not " +
    "among them — set those with reai_update_customer afterwards.",
  risk: "reversible",
  inputSchema: {
    name: z.string().describe("Customer or company name."),
    organizationNumber: z
      .string()
      .optional()
      .describe("Norwegian organisation number. Required for Norwegian company customers."),
    privateContact: z
      .boolean()
      .optional()
      .describe("True for a private individual rather than a company."),
    email: z.string().optional().describe("General email address."),
    nationalIdentityNumber: z.string().optional().describe("Fødselsnummer, for private customers."),
    countryCode: COUNTRY_CODE.optional().describe('ISO country code. Defaults to "NO".'),
    addressPart1: z.string().optional().describe("Street address."),
    addressPart2: z.string().optional().describe("Second address line."),
    postalCode: z.string().optional().describe("Postal code."),
    city: z.string().optional().describe("City."),
    province: z.string().optional().describe("Province or region."),
    skipRegistryLookup: z
      .boolean()
      .optional()
      .describe("Skip the Brønnøysund lookup and use exactly the details supplied."),
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
  idempotent: true,
  inputSchema: {
    id: z.number().int().positive().describe("Customer id."),
    name: z.string().optional().describe("New name."),
    email: z.string().optional().describe("New email address."),
    invoiceEmail: z.string().optional().describe("Where invoices should be sent."),
    invoiceInEnglish: z.boolean().optional().describe("Issue this customer's invoices in English."),
    daysUntilDue: z.number().int().optional().describe("Default payment terms in days."),
    phone: z
      .string()
      .optional()
      .describe('Phone number. A "+47" prefix on a Norwegian number is rejected — write it plain, e.g. "22334455".'),
    nationalIdentityNumber: z.string().optional().describe("Fødselsnummer, for private customers."),
    iban: z.string().optional().describe("IBAN."),
    bankAccountNumber: z.string().optional().describe("Norwegian bank account number."),
    swiftCode: z.string().optional().describe("SWIFT/BIC code."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, ...body } = args;
    if (Object.keys(body).length === 0) {
      return okText("Nothing to update — pass at least one field to change.");
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
  title: "Set a customer's address",
  description:
    "Replace a customer's postal address, or their delivery address. This is a full replacement, " +
    "not a partial update, so pass every field you want kept.",
  risk: "reversible",
  idempotent: true,
  inputSchema: {
    id: z.number().int().positive().describe("Customer id."),
    kind: z
      .enum(["postal", "delivery"])
      .optional()
      .describe('Which address to set. Defaults to "postal".'),
    addressPart1: z.string().describe("Street address."),
    city: z.string().describe("City."),
    countryCode: COUNTRY_CODE.describe('ISO country code, e.g. "NO".'),
    addressPart2: z.string().optional().describe("Second address line."),
    postalCode: z.string().optional().describe("Postal code."),
    province: z.string().optional().describe("Province or region."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, kind, ...body } = args;
    const segment = kind === "delivery" ? "delivery-address" : "address";
    const res = await ctx.client.request({
      method: "PUT",
      path: `/api/customers/${id}/${segment}`,
      body,
      tenantId: requireTenantId(tenantId, ctx),
    });
    return ok(res.data ?? `${kind ?? "postal"} address updated.`);
  },
});

const deleteCustomer = defineTool({
  name: "reai_delete_customer",
  title: "Delete or archive a customer",
  description:
    "Delete a customer. ReAI archives rather than deletes when the customer already has " +
    "transactions, which keeps the audit trail intact — the response tells you which happened. " +
    "Archiving is reversible via reai_request POST /api/customers/{id}/unarchive.",
  risk: "reversible",
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
    return ok(res.data ?? `Customer ${args.id} deleted or archived (HTTP ${res.status}).`);
  },
});

const customerLedger = defineTool({
  name: "reai_customer_ledger",
  title: "Customer ledger (kundereskontro)",
  description:
    "Read the customer ledger: what each customer owes, with the postings behind it. Omit " +
    "customerId for every customer, or pass one to drill in. Set isOpenPosting to see only " +
    "unsettled items — that is the answer to 'who owes us money'. " +
    "Defaults to the current calendar year.",
  risk: "read",
  inputSchema: {
    customerId: z.number().int().positive().optional().describe("Restrict to one customer."),
    startDate: isoDate.optional().describe("Inclusive start date. Defaults to 1 January of the current year."),
    endDate: isoDate.optional().describe("Inclusive end date. Defaults to today."),
    isOpenPosting: z.boolean().optional().describe("Only unsettled (open) postings."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const startDate = args.startDate ?? startOfYear();
    const endDate = args.endDate ?? today();
    const path = args.customerId ? `/api/ledger/customer/${args.customerId}` : "/api/ledger/customer";
    const res = await ctx.client.request({
      method: "GET",
      path,
      query: { startDate, endDate, isOpenPosting: args.isOpenPosting },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data, {
      note: `Customer ledger ${startDate} to ${endDate}${args.isOpenPosting ? " (open postings only)" : ""}.`,
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
  inputSchema: { tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/products",
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const count = Array.isArray(res.data) ? res.data.length : 0;
    return ok(res.data, { note: `${count} product(s).` });
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
  inputSchema: {
    title: z.string().describe("Product name."),
    description: z.string().optional().describe("Product description."),
    stockItem: z.boolean().optional().describe("Track this product in inventory."),
    vatCode: z.string().optional().describe("VAT code from reai_list_vat_codes."),
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
const LINE_VAT_CODE = z
  .string()
  .describe(
    'VAT code. Order and offer lines accept ONLY the codes returned by reai_list_vat_codes with ' +
      'usage="customer-invoice" — a purchase-side code is rejected.',
  );

const lineBase = {
  quantity: z
    .number()
    .min(0)
    .max(99_999_999.99)
    .describe("Quantity. Zero or positive, at most 99999999.99."),
  unitPrice: z.number().describe("Unit price. Must not be exactly zero; negative is allowed."),
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
  itemName: z.string().optional().describe("Line text. Falls back to the product name when variantId is set."),
  vatCode: LINE_VAT_CODE.optional(),
});

const offerLine = z.object({
  ...lineBase,
  // Both required by OfferLineReq, unlike on an order line.
  itemName: z.string().min(1).describe("Line text. Required on offer lines."),
  vatCode: LINE_VAT_CODE,
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
  inputSchema: {
    status: z.enum(["all", "open", "closed"]).optional().describe("Filter by order status."),
    customerId: z.number().int().optional().describe("Filter by customer."),
    orderNumber: z.string().optional().describe("Filter by order number."),
    externalReference: z.string().optional().describe("Filter by an external system's reference."),
    startDate: isoDate.optional().describe("Inclusive start date."),
    endDate: isoDate.optional().describe("Inclusive end date."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...query } = args;
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/orders",
      query,
      tenantId: requireTenantId(tenantId, ctx),
    });
    const count = Array.isArray(res.data) ? res.data.length : 0;
    return ok(res.data, { note: `${count} order(s).` });
  },
});

const getOrder = defineTool({
  name: "reai_get_order",
  title: "Get one order",
  description: "Fetch a single order by id, with its lines and totals.",
  risk: "read",
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
    buyerReference: z.string().optional().describe("The customer's own reference (deres ref)."),
    externalReference: z.string().optional().describe("Your reference from an external system."),
    projectId: z.number().int().optional().describe("Link the order to a project."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...rest } = args;
    const resolved = requireTenantId(tenantId, ctx);
    const terms = await resolveDaysUntilDue(args.daysUntilDue, args.customerId, resolved, ctx);
    const res = await ctx.client.request<{ id?: number; orderNumber?: string }>({
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
        `Order created${res.data?.orderNumber ? ` (${res.data.orderNumber})` : ""}. ` +
        `Payment terms ${terms.days} days (${describeTermsSource(terms.source)}). ` +
        `Nothing has been sent to the customer yet — invoice it with reai_create_invoice_from_order.`,
      ...(id ? { link: ctx.client.deepLink(`/orders/${id}`, resolved) } : {}),
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
  description: "List offers/quotes (tilbud), optionally filtered by customer, number or date range.",
  risk: "read",
  inputSchema: {
    customerId: z.number().int().optional().describe("Filter by customer."),
    offerNumber: z.string().optional().describe("Filter by offer number."),
    startDate: isoDate.optional().describe("Inclusive start date."),
    endDate: isoDate.optional().describe("Inclusive end date."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...query } = args;
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/offers",
      query,
      tenantId: requireTenantId(tenantId, ctx),
    });
    const count = Array.isArray(res.data) ? res.data.length : 0;
    return ok(res.data, { note: `${count} offer(s).` });
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
    "Use type to separate invoices from credit notes.",
  risk: "read",
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
    customerId: z.number().int().optional().describe("Filter by customer."),
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
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/invoices",
      query,
      tenantId: requireTenantId(tenantId, ctx),
    });
    const count = Array.isArray(res.data) ? res.data.length : 0;
    return ok(res.data, { note: `${count} invoice(s).` });
  },
});

const getInvoice = defineTool({
  name: "reai_get_invoice",
  title: "Get one invoice",
  description:
    "Fetch a single invoice by id, with lines, totals and payment status. " +
    "For the PDF use reai_request GET /api/invoices/{id}/pdf with binary=true.",
  risk: "read",
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
    "It cannot be deleted; the remedy for a mistake is a credit note. Requires " +
    "REAI_WRITE_MODE=full.",
  risk: "irreversible",
  inputSchema: {
    orderId: z.number().int().positive().describe("Order to invoice. Find one with reai_list_orders."),
    issueDate: isoDate.optional().describe("Invoice date. Determines the accounting period. Defaults to today."),
    comment: z.string().optional().describe("Comment on the invoice."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...body } = args;
    const resolved = requireTenantId(tenantId, ctx);
    const res = await ctx.client.request<{ id?: number; invoiceNumber?: string }>({
      method: "POST",
      path: "/api/invoices",
      body,
      tenantId: resolved,
    });
    const id = res.data?.id;
    return ok(res.data, {
      note:
        `Invoice issued${res.data?.invoiceNumber ? ` as ${res.data.invoiceNumber}` : ""}. ` +
        `This is now a numbered legal document — correct any mistake with a credit note, ` +
        `not by deleting it.`,
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
    "what Norwegian bookkeeping rules require. Requires REAI_WRITE_MODE=full.",
  risk: "irreversible",
  inputSchema: {
    id: z.number().int().positive().describe("Id of the invoice to credit."),
    issueDate: isoDate.describe("Date of the credit note. Determines the accounting period."),
    comment: z.string().optional().describe("Reason for the credit note. Worth filling in for the audit trail."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, ...body } = args;
    const resolved = requireTenantId(tenantId, ctx);
    const res = await ctx.client.request<{ id?: number; invoiceNumber?: string }>({
      method: "POST",
      path: `/api/invoices/${id}/credit`,
      body,
      tenantId: resolved,
    });
    const creditId = res.data?.id;
    return ok(res.data, {
      note: `Credit note created${res.data?.invoiceNumber ? ` (${res.data.invoiceNumber})` : ""} for invoice ${id}.`,
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
    "outstanding. Requires REAI_WRITE_MODE=full.",
  risk: "irreversible",
  inputSchema: {
    id: z.number().int().positive().describe("Invoice id."),
    paymentDate: isoDate.describe("Date the money was received."),
    receivedAmount: z.number().describe("Amount received. May be less than the invoice total."),
    companyBankId: z
      .number()
      .int()
      .optional()
      .describe("Bank account that received it. List them with reai_list_company_banks."),
    paidInvoiceCurrencyAmount: z
      .number()
      .optional()
      .describe("Amount in the invoice's currency, when it differs from the tenant's."),
    registerRestAsBankFee: z
      .boolean()
      .optional()
      .describe("Book any shortfall as a bank fee rather than leaving it outstanding."),
    paidPrivately: z
      .boolean()
      .optional()
      .describe("The payment went to an owner privately rather than to a company account."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, ...body } = args;
    const resolved = requireTenantId(tenantId, ctx);
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

export const salesTools: ToolDef[] = [
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  setCustomerAddress,
  deleteCustomer,
  customerLedger,
  listProducts,
  createProduct,
  listOrders,
  getOrder,
  createOrder,
  listOffers,
  createOffer,
  listInvoices,
  getInvoice,
  createInvoiceFromOrder,
  creditInvoice,
  registerInvoicePayment,
] as ToolDef[];
