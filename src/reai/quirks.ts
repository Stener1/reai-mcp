import type { HttpMethod } from "./client.js";

/**
 * Known quirks of the ReAI API, keyed to the operations they apply to.
 *
 * Curated tools can carry their hard-won knowledge in their own descriptions.
 * The other ~256 public operations cannot — they are reached through
 * `reai_search_endpoints` and `reai_request`, which until now handed back the raw
 * OpenAPI schema and nothing else. So everything learned the hard way about, say,
 * subscriptions or offers was invisible the moment an agent stepped outside the
 * curated set, and it was left to rediscover it from a 400.
 *
 * This registry closes that gap: every entry below was found by reading the spec
 * closely or by being surprised by the live API, and each is attached to the
 * paths it concerns so discovery surfaces it automatically.
 *
 * A test asserts every quirk matches at least one real operation, so these
 * cannot quietly rot as the API changes.
 */

export type QuirkKind =
  /** The request or response shape is not what the endpoint name suggests. */
  | "shape"
  /** Reaching this requires a specific sequence of other calls. */
  | "workflow"
  /** Doing this cannot be undone, or is harder to undo than it appears. */
  | "irreversible"
  /** A constraint the schema does not state, usually learned from a 400. */
  | "validation"
  /** Behaviour that is simply surprising. */
  | "gotcha";

export type Quirk = {
  id: string;
  /** Spec-form paths, with `{braces}`. See `match` for how they are compared. */
  paths: readonly string[];
  /**
   * Whether the quirk reaches sub-operations of `paths`.
   *
   * Defaults to `"exact"`, and that default matters: matching every entry as a
   * prefix leaked parent quirks onto unrelated children. `POST
   * /api/invoices/{id}/email` inherited "an invoice is created FROM AN ORDER" and
   * was told to send an `orderId`; `POST /api/customers/{id}/contact-persons`
   * inherited the customer-creation field restrictions and the Brønnøysund
   * lookup note. Since these are presented next to the real schema and read as
   * authoritative, a wrong one is worse than none.
   *
   * Use `"descendants"` only where the note genuinely holds for everything below
   * the path.
   */
  match?: "exact" | "descendants";
  /** Restrict to specific methods. Omit to apply to all methods on those paths. */
  methods?: readonly HttpMethod[];
  /**
   * HTTP statuses this note explains, for quirks whose prose is about one.
   *
   * Discovery shows every quirk for a path, which is right — an agent reading a
   * schema wants all of them. But `reai_request` also appends them to a FAILED
   * call, and there a status-specific note attached to a different status states
   * something false. A 403 on /api/opening-balances was being answered with "a 404
   * here means nothing has been set up yet — report it as empty", so an agent would
   * report a company as having no opening balances when the truth was that it may
   * not read them. Omit for notes that hold regardless of outcome.
   */
  statuses?: readonly number[];
  kind: QuirkKind;
  note: string;
};

export const QUIRKS: readonly Quirk[] = [
  // --- Cross-cutting -------------------------------------------------------
  // Note: quirks true of the whole API (tenant scoping, deep links needing
  // ?tenantId) deliberately live in the server instructions instead. Attached
  // here they would match all 321 operations and drown the endpoint-specific
  // notes that are the point of this registry.
  {
    id: "tenant-header-ignored-single-tenant",
    paths: ["/api/me"],
    kind: "gotcha",
    note:
      "Verified against the live API: when a token reaches exactly ONE tenant, X-Tenant-Id is " +
      "IGNORED — every value returns that one tenant's data, including a tenant id that does not " +
      "exist and one belonging to another user. Data stays isolated between USERS (two tokens never " +
      "see each other's books), so this is not a leak; but it means a successful response is NOT " +
      "evidence that the tenant you asked for is the tenant you got. Trust GET /api/me for what a " +
      "token can reach, and never infer access from a 200.",
  },
  {
    id: "me-may-under-report-tenants",
    paths: ["/api/me"],
    kind: "gotcha",
    note:
      "A tenant can exist and be visible in the ReAI UI while GET /api/me does not list it — seen " +
      "with a company added but not finished onboarding, or not yet granted to the user. Combined " +
      "with the ignored tenant header, that is a trap: probing the tenant returns 200 with the " +
      "WRONG tenant's data, which looks like success. Treat /api/me as authoritative and wait for " +
      "the tenant to appear there.",
  },
  {
    id: "module-gating",
    match: "descendants",
    paths: [
      "/api/projects",
      "/api/warehouses",
      "/api/timesheets",
      "/api/salary-payments",
      "/api/share-investments",
    ],
    kind: "gotcha",
    statuses: [403],
    note:
      'A 403 here is usually a disabled MODULE, not a permission problem — the detail reads like ' +
      '"Project module is disabled". Do not go hunting for missing roles; the feature is off for ' +
      "this tenant. /api/share-investments is the exception worth knowing: it returns 403 with an " +
      "ENTIRELY EMPTY body and no content-type, so there is no detail to read. Treat a bare 403 " +
      "here the same way — the module is off.",
  },
  {
    id: "date-range-required",
    match: "descendants",
    paths: ["/api/vouchers", "/api/postings", "/api/ledger"],
    methods: ["GET"],
    kind: "validation",
    statuses: [400],
    note:
      "startDate and endDate are required, even where the schema does not mark them so. Omitting " +
      'them returns 400 "startDate is required".',
  },
  {
    id: "timesheets-need-project-module",
    paths: ["/api/timesheets"],
    methods: ["GET"],
    kind: "gotcha",
    statuses: [400, 403],
    note:
      "Unreachable on a tenant without the Project module, in a way no schema can express: " +
      "projectId is a REQUIRED query parameter, and supplying it returns 400 " +
      '"projectId cannot be used when the Project module is disabled". Required and rejected at ' +
      "the same time, so no request succeeds. On that exact message, stop — the module is off and " +
      "no combination of parameters helps. Say so instead of retrying.",
  },
  {
    id: "empty-state-is-404",
    paths: ["/api/opening-balances", "/api/annual-accounts/{year}"],
    methods: ["GET"],
    kind: "gotcha",
    statuses: [404],
    note:
      "A 404 here means NOTHING HAS BEEN SET UP YET, not a wrong path — the normal state for most " +
      'companies. The detail says so ("Opening balance not found", "No annual-accounts submission ' +
      'exists for fiscal year 2025"). Report it as empty rather than retrying or hunting for ' +
      "another endpoint.",
  },
  {
    id: "salary-lives-under-salary-payments",
    match: "descendants",
    paths: ["/api/salary-payments"],
    methods: ["GET", "POST"],
    kind: "workflow",
    note:
      "Payroll is under /api/salary-payments; there is no /api/salaries. POST /api/salary-payments " +
      "creates a run that ALREADY CONTAINS wage lines derived from expense postings — read it back " +
      "before adding anything. POST /api/salary-payments/{id}/wage-specs adds a MANUAL line only " +
      "(a commission, say); using it to re-enter lines that are already there inflates both salary " +
      "and the expense amounts, and the expense-derived lines cannot be edited or deleted to " +
      "correct it. Add only what is genuinely missing. " +
      "POST /api/salary-payments/{id}/complete then creates the voucher, the payslips and one " +
      "payment per payable employee, and on Norwegian tenants starts A-melding submission to " +
      "Skatteetaten — so it is treated as an external send and needs REAI_ALLOW_EXTERNAL_SEND.",
  },

  // --- Bookkeeping ---------------------------------------------------------
  {
    id: "voucher-signed-amounts",
    paths: ["/api/vouchers", "/api/vouchers/{id}"],
    methods: ["POST", "PUT"],
    kind: "shape",
    note:
      "Voucher postings use ONE signed amount: positive debits the account, negative credits it, " +
      "and all postings must sum to exactly zero. Note this differs from supplier invoice cost " +
      "lines, which name debit and credit accounts explicitly.",
  },
  {
    id: "voucher-row-merge",
    paths: ["/api/vouchers", "/api/vouchers/{id}"],
    methods: ["POST", "PUT"],
    kind: "validation",
    note:
      "Postings sharing a `rowNumber` are MERGED into one voucher row and must therefore agree on " +
      "what that row carries — notably `description`. An omitted rowNumber puts every posting in " +
      "row 0, so giving two postings different descriptions makes the voucher fail with " +
      '"postings with rowNumber 0 cannot be merged into one voucher row. Book the debit side as a ' +
      'positive amount and the credit side as a negative amount" — which blames the sign convention ' +
      "even when the signs are already correct. Either give the postings the same description, or " +
      "distinct rowNumbers. Verified against the live API.",
  },
  {
    id: "voucher-not-deletable",
    paths: ["/api/vouchers/{id}"],
    methods: ["DELETE"],
    kind: "irreversible",
    note:
      "DELETE here means delete OR REVERSE, and ReAI chooses which. It deletes when no audit history " +
      'need be kept; otherwise it books the counter-posting itself and answers {"outcome":"reversed"} ' +
      "with the original still in the ledger. A 2xx therefore does NOT mean the transaction is gone — " +
      "read the outcome, and never re-book on the strength of a successful delete. Postings report " +
      "canDelete and lockReasons, which is how to know in advance.",
  },

  {
    id: "leads-paginated-object",
    paths: ["/api/leads", "/api/leads/person-profiles"],
    methods: ["GET"],
    kind: "shape",
    note:
      "These return a PAGE OBJECT, not the bare array almost every other collection here returns, " +
      "so iterating the response or reading .length yields nothing. /api/leads gives " +
      "{ items, page, hasPrevious, hasNext, latestRegisteredAt } and takes page plus pageSize " +
      "(1-200, default 50); /api/leads/person-profiles gives { items, hasMore, nextStartOrgNo, limit } " +
      "and pages by nextStartOrgNo rather than by number. Read the wrapper before assuming a count. " +
      "/api/leads/person-role-matches is an object too but a DIFFERENT one — " +
      "{ matched, companyMatched, items } with no paging fields at all — so do not assume these " +
      "three share a shape.",
  },
  {
    id: "person-role-matches-shape",
    paths: ["/api/leads/person-role-matches"],
    methods: ["GET"],
    kind: "shape",
    note:
      "Returns { matched, companyMatched, items } — an object, but NOT the page object the other " +
      "lead endpoints use: no page, hasNext, hasMore, nextStartOrgNo or limit. So it needs reading " +
      "differently from /api/leads and /api/leads/person-profiles, and there is nothing to paginate " +
      "through. Requires the linkedinSlug query parameter, and omitting it returns a bare " +
      '400 "Validation failed" that names nothing.',
  },
  {
    id: "leads-unsaved-rows-have-no-id",
    paths: ["/api/leads"],
    methods: ["GET"],
    kind: "gotcha",
    note:
      "A row's `id` is null only while the lead is UNSAVED — those rows are live Brønnøysund " +
      "register entries rather than stored records. Saved leads do have an id, and it is the key to " +
      "the whole workflow: GET/PATCH /api/leads/{id}, POST /api/leads/{id}/convert, and the notes, " +
      "status and follow-up endpoints. Filter with leadFilter=saved|unsaved|all, and keep any id you " +
      "are given rather than discarding it.",
  },  {
    id: "warehouse-inventory-object",
    paths: ["/api/warehouses/inventory"],
    methods: ["GET"],
    kind: "shape",
    note:
      "Returns an object, not an array: { warehouseId, rows, totalStockValue, totalRetailValue }. " +
      "The stock lines are under `rows`, and the two totals are already computed — do not sum rows " +
      "to get stock value, it is there.",
  },
  {
    id: "inventory-adjust-silent-noop-without-variant",
    paths: ["/api/warehouses/inventory/adjust"],
    methods: ["POST"],
    kind: "gotcha",
    note:
      "variantId is optional in the schema and REQUIRED in practice for any product that has " +
      "variants. Omitting it answers 200 with a real transactionId and moves NO stock: measured " +
      "on a live tenant, four consecutive +3 adjustments left quantityOnHand at 0 and stockValue " +
      "at 0, each returning variantId: null. Nothing in the status or the transaction id says the " +
      "write did nothing — the only honest signals are `quantityOnHand` in the response and a " +
      "null `variantId` echoed back, so read them. The field to send is the one a variant carries " +
      "in ProductRes, which is `variantId`, NOT `id`; reading `.id` yields undefined, " +
      "JSON.stringify drops it, and the call becomes this no-op. Nothing that can hold stock is " +
      "exempt, because the API refuses a stock product with no variants — so treat variantId as " +
      "REQUIRED on this endpoint. reai_adjust_inventory does: it requires the field, refuses when " +
      "the variant is not one of the warehouse's stock lines, and reports a null echo afterwards.",
  },
  {
    id: "inventory-adjust-occurredat-needs-time",
    paths: ["/api/warehouses/inventory/adjust"],
    methods: ["POST"],
    statuses: [400],
    kind: "validation",
    note:
      'occurredAt is format date-time and a date-only value is refused: "2026-08-01" answers 400 ' +
      '{"detail":"Failed to read request"} with NO fieldErrors, because deserialisation fails ' +
      "before field validation runs — so the error names neither the field nor the reason. " +
      '"2026-08-01T10:00:00Z" and "2026-08-01T10:00:00+02:00" are both accepted (the offset form ' +
      'is normalised to UTC, echoed back as "2026-08-01T08:00:00Z"). Every other date field in ' +
      "this API is yyyy-MM-dd, which is what makes this easy to get wrong.",
  },
  {
    id: "inventory-adjust-not-a-posting",
    paths: ["/api/warehouses/inventory/adjust"],
    methods: ["POST"],
    kind: "irreversible",
    note:
      "An adjustment posts NO voucher — measured before and after every adjustment on a live " +
      "tenant with a voucher lister that throws on a non-200, and the count never left 0. Stock " +
      "value does not reach the ledger through this call, so book the accounting side separately. " +
      "It also cannot be undone: DELETE /api/warehouses/inventory/transactions/{id}, DELETE " +
      "/api/warehouses/inventory/adjust/{id} and GET /api/warehouses/inventory/transactions all " +
      "404, so no route lists or removes a stock transaction and the only correction is an " +
      "opposite adjustment, leaving both movements in the history. And stock goes NEGATIVE " +
      "without complaint: -10 against 4 on hand gives -6 on hand and a stock value of -600, with " +
      "no clamp and no refusal, so a sign error is absorbed silently.",
  },
  {
    id: "warehouse-delete-archives-on-stock",
    paths: ["/api/warehouses/{id}"],
    methods: ["DELETE"],
    kind: "gotcha",
    note:
      'The response says which happened ({"outcome":"deleted"} or {"outcome":"archived"}), and the ' +
      "trigger is CURRENT STOCK ON HAND rather than transaction history — which is where this " +
      "endpoint differs from the other records that archive on delete, and why it is not covered " +
      "by delete-may-archive. Measured: a warehouse holding 2 units was archived, kept its stock, " +
      "still answered 200 by id with archived: true and could still be renamed; one whose " +
      "adjustments netted back to zero on hand was DELETED outright, its stock transaction history " +
      "with it. There is no unarchive endpoint for warehouses, so the archive branch is one-way, " +
      "and archived warehouses are returned only by GET /api/warehouses?archived=true — while GET " +
      "/api/warehouses/inventory still reports their stock. Bring stock to zero first if a real " +
      "delete is what you want.",
  },
  {
    id: "warehouse-archived-is-a-filter",
    paths: ["/api/warehouses"],
    methods: ["GET"],
    kind: "gotcha",
    note:
      "`archived` selects which set to return, it does not widen it. Measured on a tenant with " +
      "one active and one archived warehouse: omitting it and archived=false both return only the " +
      "active one, archived=true returns only the archived one. No single call returns both. This " +
      "matters because a warehouse still holding stock is ARCHIVED rather than deleted, so stock " +
      "can sit in a warehouse the default list does not show — GET /api/warehouses/inventory " +
      "still reports it. Names are also not unique: creating a second warehouse with an existing " +
      "name is accepted and returns a new id, so identify one by id.",
  },
  {
    id: "stock-product-needs-a-variant",
    paths: ["/api/products"],
    methods: ["POST"],
    statuses: [400],
    kind: "validation",
    note:
      "A product with stockItem: true is rejected unless it carries at least one variant: 400 " +
      'fieldErrors [{field: "stockProductVariantSelectionValid", message: "Stock products must ' +
      'contain at least one variant."}]. That field name is a synthetic validation flag, not ' +
      "something to send — the fix is a `variants` array, whose entries require `sku` " +
      "(ProductVariantReq also takes barcode, costPrice, sellingPrice, options, inventory, " +
      "warehouseName, inventoryLevels). ProductReq itself only requires `title`, so nothing in " +
      "the schema hints at this. Note the asymmetry in the response: a created variant comes back " +
      "keyed `variantId`, not `id`.",
  },

  // --- Sales ---------------------------------------------------------------
  {
    id: "invoice-from-order-only",
    paths: ["/api/invoices"],
    methods: ["POST"],
    kind: "workflow",
    note:
      "An invoice is created FROM AN ORDER — this takes an orderId, not line items. There is no " +
      "endpoint that builds an invoice from lines, so create an order first (POST /api/orders); " +
      "the order carries the lines.",
  },
  {
    id: "invoice-credit-not-delete",
    paths: ["/api/invoices/{id}"],
    kind: "irreversible",
    note:
      "An issued invoice is a numbered legal document and cannot be deleted. Undo it with a credit " +
      "note: POST /api/invoices/{id}/credit.",
  },
  {
    id: "offer-lines-stricter",
    paths: ["/api/offers", "/api/offers/{id}"],
    methods: ["POST", "PUT"],
    kind: "validation",
    statuses: [400, 422],
    note:
      "Offer lines are STRICTER than order lines: itemName and vatCode are both required on an " +
      "offer line, but optional on an order line. Reusing an order-shaped line here returns 400.",
  },
  {
    id: "line-vat-code-subset",
    paths: ["/api/orders", "/api/offers", "/api/offers/{id}", "/api/subscriptions", "/api/subscriptions/{id}"],
    methods: ["POST", "PUT"],
    kind: "validation",
    note:
      'ORDER and subscription lines accept only the VAT codes from GET ' +
      '/api/vat-codes?usage=customer-invoice — a purchase-side code is rejected with ' +
      '"Mva-kode N er ikke tillatt. Tillatte koder: ...".\n' +
      'OFFER lines are NOT checked against that list. Verified on a tenant where the list is just ' +
      '["0"]: an offer line with vatCode "3" was accepted, stored as "3", and read back unchanged, ' +
      'while an identical order line was rejected. So an offer can carry a code that fails later, ' +
      'when the same work becomes an order or an invoice. Validate an offer line against ' +
      '?usage=customer-invoice yourself rather than trusting acceptance.',
  },
  {
    id: "days-until-due-mandatory",
    paths: ["/api/orders", "/api/offers", "/api/offers/{id}"],
    methods: ["POST", "PUT"],
    kind: "gotcha",
    note:
      "daysUntilDue is required and non-nullable, so the API can never fall back to the customer's " +
      "own payment terms — whatever you send OVERRIDES them. Read the customer's daysUntilDue " +
      "first if you want their terms respected.",
  },
  {
    id: "order-send-ehf",
    paths: ["/api/orders", "/api/orders/{id}"],
    methods: ["POST", "PUT"],
    kind: "irreversible",
    note:
      "sendEhf: true arms EHF/Peppol transmission of the resulting invoice to the counterparty. " +
      "That cannot be recalled once it happens, so this server classifies any body carrying it as " +
      "irreversible even though creating an order is otherwise reversible.",
  },
  {
    id: "customer-create-fields",
    paths: ["/api/customers"],
    methods: ["POST"],
    kind: "shape",
    note:
      "Creation does NOT accept invoiceEmail, phone or daysUntilDue — those exist only on PATCH " +
      "/api/customers/{id}. The schema has no additionalProperties:false, so they are silently " +
      "discarded rather than rejected. Set them in a follow-up PATCH.",
  },
  {
    // Measured on a live tenant. The schema declares minLength 0 on the name and the
    // tools claimed an org number alone sufficed; neither survives contact with the API.
    id: "brreg-lookup-requires-and-overwrites-name",
    paths: ["/api/customers", "/api/suppliers"],
    methods: ["POST"],
    kind: "gotcha",
    note:
      "The Brønnøysund lookup fills the ADDRESS from organizationNumber but neither accepts nor " +
      'keeps the name. A blank name is refused with "name is required" even alongside a valid ' +
      "organizationNumber — so the org number alone is NOT enough, whatever minLength 0 in the " +
      "schema suggests. And the name you do send is discarded: creating with " +
      'name="Lookup Probe" and org number 974761076 stores "Skatteetaten". Send the real name ' +
      "if you know it, and do not treat the echoed value as confirmation of what you sent.",
  },
  {
    id: "customer-name-title-cased",
    paths: ["/api/customers", "/api/customers/{id}", "/api/suppliers", "/api/suppliers/{id}"],
    methods: ["POST", "PATCH"],
    kind: "gotcha",
    note:
      "ReAI normalizes stored names to title case, so a round-trip comparison is not byte-equal " +
      'with what you sent ("acme as" comes back "Acme As").',
  },
  {
    id: "phone-no-plus47",
    paths: ["/api/customers", "/api/customers/{id}", "/api/suppliers", "/api/suppliers/{id}"],
    methods: ["POST", "PATCH"],
    kind: "validation",
    statuses: [400, 422],
    note:
      "Two phone fields, opposite rules — check which one you are filling.\n" +
      'The ENTITY phone (customer.phone, supplier.phone) rejects a "+47" prefix on a Norwegian ' +
      'number: 400 "Skriv inn et gyldig telefonnummer. Norske nummer kan skrives uten +". Send ' +
      '"22334455". Observed live.\n' +
      "A CONTACT PERSON's phone is the reverse: the spec documents contactPersons[].phone as " +
      '"Phone number in international E.164 format", example +4799999999, so stripping the prefix ' +
      "there is wrong. Same request body, two conventions.",
  },
  {
    id: "brreg-lookup",
    paths: ["/api/customers", "/api/suppliers"],
    methods: ["POST"],
    kind: "gotcha",
    note:
      "A Norwegian company is looked up in Brønnøysundregistrene from organizationNumber and its " +
      "name and address are filled in for you. Pass skipRegistryLookup to use exactly what you sent.",
  },
  {
    id: "subscription-read-and-write-shapes-differ",
    paths: ["/api/subscriptions/{id}"],
    methods: ["PUT"],
    kind: "shape",
    note:
      "This REPLACES the subscription, and echoing the GET back does not work — the read and the " +
      "write disagree about shape in three ways. The response puts the lines under `lines`; the " +
      "request wants `subscriptionLines`. A response line carries eleven fields and " +
      "SubscriptionLineReq accepts eight (vatTitle, vatRate and amounts are computed). A service " +
      "recipient reads back as `companyName` and writes as `name`.\n\n" +
      "Measured: a PUT carrying the eight required fields and one line answered 200 and left " +
      "invoiceEmail, invoiceComment and internalComment all null with the second line gone. Mapped " +
      "properly the round-trip is lossless, discounts included. reai_update_subscription does the " +
      "mapping and the merge; a raw caller has to do both.",
  },
  {
    id: "salary-complete-does-everything-at-once",
    paths: ["/api/salary-payments/{id}/complete"],
    methods: ["POST"],
    kind: "irreversible",
    note:
      "The most consequential single call in this API, and its own description says why: it " +
      '"finalizes the salary payment, creates its voucher and payslips, and creates one employee ' +
      'payment per payable employee using the selected company bank. For Norwegian tenants, the ' +
      'same A-melding validation and asynchronous submission flow as the web application is ' +
      'started." Once Skatteetaten accepts, withholding tax and employer contribution payments are ' +
      "registered automatically. So one call posts to the ledger, schedules real transfers to real " +
      "people, and files with the state.\n\n" +
      "manualPayment is the same dual-mode flag as on a supplier-invoice payment: false schedules " +
      "the transfers, true records them as already made. companyBankId is required either way. " +
      "There is deliberately no curated tool for this — the refusal here names what it would have " +
      "done, which is the point.",
  },
  {
    id: "salary-run-needs-employee-bank-accounts",
    paths: ["/api/salary-payments"],
    methods: ["POST"],
    kind: "validation",
    statuses: [400],
    note:
      'Refused with 400 "Følgende ansatte mangler bankkonto: <names>" — Norwegian for "the ' +
      'following employees are missing a bank account" — when any INCLUDED employee has none, and ' +
      "it names them. Employees are created without one, so this is the normal first failure: set " +
      "it with `accountNumber` on POST /api/employees or PATCH /api/employees/{id}.\n\n" +
      "Two more things measured here. Omitting employeeIds includes EVERY employee, so passing " +
      "nothing is not passing nobody. And creating a run posts NO voucher — the count did not move " +
      "and voucherId stayed null; the voucher is made at completion, which is why a run in status " +
      "under_process can be deleted without touching the ledger.",
  },
  {
    id: "salary-wage-line-create-and-update-differ",
    paths: [
      "/api/salary-payments/{id}/wage-specs",
      "/api/salary-payments/{id}/wage-specs/{wageSpecId}",
    ],
    methods: ["POST", "PUT"],
    kind: "shape",
    note:
      "CreateSalaryWageSpecReq REQUIRES employeeId; UpdateSalaryWageSpecReq does not accept it, and " +
      'sending it answers 400 "Unknown field: employeeId". A line belongs to the employee it was ' +
      "created for and cannot be moved. The update replaces the line, so send it as it should " +
      "end up.\n\n" +
      "Lines derived from EXPENSE POSTINGS cannot be changed at all — the API says so on the update " +
      "endpoint. That is also why a fresh run is not empty: it arrives pre-populated from the " +
      "period's expense postings, and adding the same pay again is how wages go out twice.\n\n" +
      "The response is the whole run with tax recalculated. On a tenant with no tax cards the rate " +
      "is 50%: a 1 × 5000 COMMISSION line produced payableAmount 2500 and totalTaxDeducted 2500.",
  },
  {
    id: "employee-name-must-be-unique",
    paths: ["/api/employees"],
    methods: ["POST"],
    kind: "validation",
    statuses: [409],
    note:
      'Two employees cannot share a NAME: 409 "Ansatt med dette navnet finnes allerede" (an ' +
      "employee with this name already exists). Not the email, the name — so real namesakes need " +
      "distinguishing, and a leftover test record blocks the name until someone deletes it.",
  },
  {
    id: "employee-with-work-data-cannot-be-deleted",
    paths: ["/api/employees/{id}"],
    methods: ["DELETE"],
    kind: "gotcha",
    statuses: [409],
    note:
      '409 "Employee cannot be deleted because related work data exists" — measured with nothing ' +
      "but an EMPTY DRAFT salary run referencing them, so the bar for \"work data\" is low and the " +
      "message does not say what the data is. Delete the salary run first and the same DELETE " +
      "answers 204. If a payroll run has been completed the employee is presumably permanent, " +
      "which is what a payroll record should be.",
  },
  {
    id: "employee-account-goes-in-flat-and-comes-back-split",
    paths: ["/api/employees", "/api/employees/{id}"],
    methods: ["POST", "PATCH", "GET"],
    kind: "shape",
    note:
      "The request field is `accountNumber` and takes the whole number; the response field is " +
      "`bankAccount`, an OBJECT, with the number split. Measured: sending accountNumber " +
      '"15201353103" reads back as bankAccount { employeeBankAccountId, countryCode: "NO", ' +
      'bankCode: "1520", accountNumber: "1353103", currency: "NOK", iban: "NO1615201353103" }. So a ' +
      "caller checking the write by comparing `accountNumber` sees \"1353103\" against what it " +
      "sent and concludes it failed; read `bankAccount.iban`, or reassemble bankCode + " +
      "accountNumber. Note EmployeeRes has no flat accountNumber at all.",
  },
  {
    id: "swift-code-is-normalised",
    paths: ["/api/company-banks", "/api/company-banks/{id}"],
    methods: ["POST", "PUT"],
    kind: "gotcha",
    note:
      'A SWIFT/BIC is stored NORMALISED: the 11-character form ending in the "XXX" ' +
      'primary-branch suffix comes back as the 8-character form, so sending "DNBANOKKXXX" reads ' +
      'back as "DNBANOKK". Measured on a live tenant at create time. That is the API doing its ' +
      "job, not a failed write — but a caller that compares what it sent with what is stored, in " +
      "order to check the write took effect, will see a difference and should not treat it as one. " +
      "Echoing the stored value back on a later replacement is unaffected.",
  },
  {
    id: "full-replacement-clears-a-payment-destination",
    paths: ["/api/company-banks/{id}", "/api/creditors/{id}"],
    methods: ["PUT"],
    kind: "irreversible",
    note:
      "This REPLACES the record, and the account number is NOT among the required fields — so a " +
      "body that satisfies the schema and omits it CLEARS it. Measured on a live tenant:\n" +
      "  PUT /api/company-banks/{id} {name, countryCode, currency} → 200, bban AND iban emptied\n" +
      "  PUT /api/creditors/{id} {name}                            → 200, bankAccountNumber null\n" +
      "In both cases the intent was a rename. Nothing in the response says an account number was " +
      "removed, and the next payment has nowhere to go.\n\n" +
      "Note what this defeats: the payment-routing guard escalates a body that CONTAINS a " +
      "destination, so it never sees a body whose danger is the omission. Both PUTs are therefore " +
      "classified irreversible outright. Read the record first and send back every field you want " +
      "kept — GET /api/company-banks/{id} or GET /api/creditors/{id} — the way " +
      "reai_update_agreement does for the same class of trap.",
  },
  {
    id: "address-put-clears-what-it-omits",
    paths: [
      "/api/customers/{id}/address",
      "/api/customers/{id}/delivery-address",
      "/api/suppliers/{id}/address",
    ],
    methods: ["PUT"],
    kind: "gotcha",
    note:
      "A full replacement whose required set is only addressPart1, city and countryCode — so a " +
      "body carrying those three is accepted and empties the rest. Measured: postalCode " +
      '"0150" → null, province "Oslo" → null, addressPart2 "Oppgang B" → null, on a 200. An ' +
      "invoice addressed without a postcode is the visible consequence.\n\n" +
      "reai_set_customer_address and reai_set_supplier_address both read the current address and " +
      "merge, so every one of these three paths has a safe route — prefer them. A raw call has to " +
      "read the record back itself (GET /api/customers/{id} or /api/suppliers/{id}) and send every " +
      "part it wants kept.",
  },
  // --- Agreements -----------------------------------------------------------
  {
    id: "agreement-put-replaces-everything",
    paths: [
      "/api/agreements/rent-agreement/{id}",
      "/api/agreements/employee-contract/{id}",
      "/api/agreements/accounting-services/{id}",
      "/api/agreements/service-agreement/{id}",
      "/api/agreements/purchase-agreement/{id}",
    ],
    methods: ["PUT"],
    kind: "irreversible",
    note:
      "This REPLACES the agreement — it does not patch it. Send the one field you mean to change " +
      "and every other term is set to null. Measured on a live lease: a PUT carrying only " +
      "landlordName left monthlyRent, tenantName, depositAmount, depositAccountNumber and the " +
      "house rules all empty, answered 200, and GET /pdf still rendered a document — so the " +
      "result looks like a contract with nothing in it. Read the agreement first, merge your " +
      "change into the template sub-object it returns, and write the whole thing back; that " +
      "round-trip is lossless (a 78-key sub-object written back verbatim changed no field). " +
      "reai_update_agreement does exactly this. Editing through the wrong template's path is " +
      'refused: 400 "Avtalen må redigeres fra riktig avtalemal."',
  },
  {
    id: "agreement-accepts-an-empty-body",
    paths: [
      "/api/agreements/rent-agreement",
      "/api/agreements/employee-contract",
      "/api/agreements/accounting-services",
      "/api/agreements/service-agreement",
      "/api/agreements/purchase-agreement",
    ],
    methods: ["POST"],
    kind: "gotcha",
    note:
      "No field is required in any of the five agreement schemas, so POST {} answers 201 and " +
      "creates a draft in which every term is null — and the PDF renders for it. A 201 here is " +
      "not evidence that a usable contract exists; count the populated fields. Some values the " +
      "schema types as plain strings are validated as enums the document does not list, and the " +
      "API names the allowed set in its 400: leaseDurationType is indefinite | fixed_standard | " +
      "fixed_special_reason, depositType is deposit | guarantee. Norwegian tenancy law caps a " +
      "deposit at six months' rent and wants a statutory reason for a fixed term under three " +
      "years; neither is enforced — a deposit of 9 999 999 against a rent of 10 000 was accepted, " +
      "as was a four-month fixed_standard lease with no reason.",
  },
  {
    id: "agreement-shapes",
    paths: ["/api/agreements", "/api/agreements/{id}", "/api/agreements/{id}/sign-requests"],
    methods: ["GET"],
    kind: "shape",
    note:
      "Three shapes worth knowing. The identifier is `agreementId`, NOT `id` — reading `.id` " +
      "yields undefined, and a cleanup loop keyed on it deletes nothing. GET /api/agreements/{id} " +
      "returns a WRAPPER: { agreementId, templateType, signStatus, documentId, ... } plus five " +
      "nullable sub-objects (accountingServices, employeeContract, rentAgreement, " +
      "serviceAgreement, purchaseAgreement) of which exactly one is populated, so a lease's rent " +
      "is at rentAgreement.monthlyRent and not at the top level. GET .../sign-requests returns an " +
      "OBJECT — { agreementId, documentId, signStatus, signRequests } — with the signers under " +
      "`signRequests`. The list endpoint carries only a summary and none of the terms.",
  },
  {
    id: "agreement-delete-has-no-body",
    paths: ["/api/agreements/{id}"],
    methods: ["DELETE"],
    kind: "gotcha",
    note:
      "Answers 204 with an EMPTY body: no {\"outcome\": ...} field and no archive branch, unlike " +
      "customers, suppliers, departments, products or warehouses. So there is nothing in the " +
      "response to read — the status is the whole answer, and GET /api/agreements is how to " +
      "confirm. What this does to an agreement already SIGNED is not established: producing a " +
      "signature needs a signing request sent to a real person, which cannot be done with " +
      "external sending off.",
  },
  {
    id: "delete-may-archive",
    paths: [
      "/api/customers/{id}",
      "/api/suppliers/{id}",
      "/api/departments/{id}",
      "/api/documents/{id}",
      // Same wording verbatim in the spec, and previously uncovered — so a
      // reai_request caller got no warning, even though the curated tools say it.
      "/api/products/{id}",
      "/api/company-banks/{id}",
      // The last two sharing the identical spec wording, found by matching on the
      // sentence rather than by listing them from memory.
      "/api/projects/{id}",
      // /api/warehouses/{id} is deliberately NOT here. It shares the spec wording, but the
      // trigger was measured to be current stock ON HAND rather than transaction history —
      // a warehouse whose adjustments netted back to zero was deleted outright, history and
      // all. Listing it would hand a reai_request caller the disproved version, which is
      // worse than no note. See warehouse-delete-archives-on-stock.
    ],
    methods: ["DELETE"],
    kind: "gotcha",
    note:
      "DELETE archives instead of deleting when the record already has transactions, preserving the " +
      'audit trail. The response says which happened (outcome: "deleted" | "archived") — read it ' +
      "rather than treating 200 as deletion. ONLY customers and suppliers can be unarchived " +
      "(POST /api/{customers,suppliers}/{id}/unarchive); for the other five an archive is one-way, " +
      "and the record stays hidden from the active list.",
  },

  {
    id: "asset-register-posts-nothing",
    paths: ["/api/assets", "/api/assets/{id}/depreciation", "/api/assets/{id}/write-off"],
    methods: ["POST", "PUT"],
    kind: "gotcha",
    note:
      "Registering an asset, changing its depreciation schedule and writing it off all post NO " +
      "voucher on an asset with no accounting history — measured on a live tenant with a voucher " +
      "list that fails loudly on a non-200. The register entry and the acquisition booking are " +
      "separate: capitalising something already booked will not double-book it, and creating the " +
      "register entry will not book it for you. usefulLifeInMonths and depreciationMethod are " +
      "OPTIONAL despite the tooling that suggests otherwise — omit both for land and other " +
      "non-depreciable assets (1150 Tomter, 1292 Andre ikke avskrivbare eiendeler).",
  },
  {
    id: "asset-delete-refused-when-referenced",
    paths: ["/api/assets/{id}"],
    methods: ["DELETE"],
    kind: "gotcha",
    note:
      "The endpoint description says a linked acquisition voucher is \"deleted when possible or " +
      "reversed when accounting history must be retained\". Neither happens: with a posted voucher " +
      "referencing the asset the call answers 409 \"Asset with id N is used in existing vouchers " +
      "and cannot be deleted\" and changes nothing. Verified by booking a voucher against an asset " +
      "and deleting it. Delete the vouchers first, or write the asset off instead. This is the " +
      "safer behaviour than the document promises — nothing here reverses a posting silently.",
  },
  {
    id: "manual-voucher-needs-manual-asset",
    paths: ["/api/vouchers", "/api/vouchers/{id}"],
    methods: ["POST", "PUT"],
    kind: "gotcha",
    note:
      "A posting line carrying assetId is refused with 409 \"Manuelle bilag kan bare posteres på " +
      "eiendeler med manuell avskrivningsmetode\" unless that asset's depreciationMethod is " +
      "'manual'. An asset on 'linear' is driven by its schedule and will not accept manual " +
      "postings, so book the acquisition before setting the asset to linear, or create it as " +
      "manual. Also observed on the same endpoint: a bank account such as 1920 must be posted " +
      "with a companyBankId (\"Konto 1920 må posteres med bankkonto\"), and every posting line " +
      "needs its own postingDate and currency even though the voucher carries a date.",
  },
  {
    id: "employee-list-is-a-projection",
    paths: ["/api/employees"],
    methods: ["GET"],
    kind: "shape",
    note:
      "The COLLECTION returns id, name and email only — EmployeeSummaryRes, not the full " +
      "record. Department, phone, employment dates, bank account and national identity number " +
      "come from GET /api/employees/{id}. Verified by creating an employee and reading the list " +
      "back. Filtering the list on a field it does not return finds nothing, rather than failing.",
  },
  {
    id: "employee-name-is-title-cased",
    paths: ["/api/employees", "/api/employees/{id}"],
    methods: ["POST", "PATCH"],
    kind: "gotcha",
    note:
      'The API normalises the name\'s capitalisation: "ZZ MCP Shape Probe" was stored as ' +
      '"Zz Mcp Shape Probe". Observed on a live create. So a read-back will not match what was ' +
      "sent for names with deliberate casing (McDonald, van der Berg, initialisms), and an " +
      "equality check against the value you sent will fail.",
  },
  {
    id: "employee-delete-is-hard",
    paths: ["/api/employees/{id}"],
    methods: ["DELETE"],
    kind: "gotcha",
    note:
      "DELETE answers 204 with no body and the record is gone — employees do NOT follow the " +
      "delete-or-archive contract that customers, suppliers, departments and five others use, " +
      "and there is no outcome field to read. Verified on a live create/delete round-trip.",
  },

  // --- Subscriptions -------------------------------------------------------
  {
    id: "subscription-generate-catches-up",
    paths: ["/api/subscriptions/{id}/generate", "/api/subscriptions/generate-due"],
    methods: ["POST"],
    kind: "gotcha",
    note:
      "Generates every DUE period, not the next one. A subscription backdated to January and " +
      "generated in August produced EIGHT orders from a single call — measured live. Re-running " +
      "is safe: the next two calls returned generatedBillings 0, so the API bills only what is " +
      "due rather than repeating a period. The response is counts " +
      "(generatedBillings, generatedOrders, generatedInvoices, safetyCapHits), never the " +
      "documents themselves, and a non-zero safetyCapHits means some periods were skipped.",
  },
  {
    id: "subscription-with-history-cannot-be-deleted",
    paths: ["/api/subscriptions/{id}"],
    methods: ["DELETE"],
    kind: "gotcha",
    note:
      "A subscription that has generated billing history cannot be deleted: 409 \"Kan ikke " +
      "slette et abonnement som har generert faktureringshistorikk\". This is NOT the " +
      "delete-or-archive behaviour other records have — nothing is archived and there is no " +
      "outcome field, the call simply fails. Deactivate it instead. Verified live.",
  },
  {
    id: "order-delete-can-be-refused-with-500",
    paths: ["/api/orders/{id}"],
    methods: ["DELETE"],
    kind: "gotcha",
    statuses: [500],
    note:
      'Deleting an order can answer 500 "Referenced record is not accessible" and leave the ' +
      "order in place — a 500 here is a refusal, not necessarily a server fault, so do not " +
      "retry it. Eight orders on a test tenant have been stuck this way since being generated " +
      "by a subscription.\n\n" +
      "DELETE THE ORDERS BEFORE THEIR CUSTOMER. Deleting the customer first is how these eight " +
      "were stranded, and it remains the one prescription worth following, because it is the " +
      "part a caller controls.\n\n" +
      "Two things are known about repairing it, and neither works: POST " +
      "/api/customers/{id}/unarchive restores the customer to active and the order delete still " +
      "answers 500, so the reference is not mended by putting the record back. And these orders " +
      "were generated by a subscription that cannot itself be deleted once it has billing " +
      "history (409), which may be holding them independently — that could not be isolated, " +
      "because deleting the subscription to find out is precisely what the API refuses. So do " +
      "not read 'the customer was restored and it still failed' as 'the customer was not the " +
      "cause': the reference may break at deletion time and stay broken. Order your cleanup " +
      "accordingly, and prefer deactivating a subscription over unpicking what it produced.",
  },
  {
    id: "subscription-created-active",
    paths: ["/api/subscriptions"],
    methods: ["POST"],
    kind: "gotcha",
    note:
      "A created subscription comes back active: true — there is no inert draft stage, and " +
      "POST /api/subscriptions/{id}/activate is for restarting a deactivated one. Verified on a " +
      "live create. What makes a new subscription harmless is automaticBillingGeneration: false, " +
      "which leaves it waiting for an explicit generate call; being newly created does not.",
  },
  {
    id: "subscription-self-invoicing",
    paths: ["/api/subscriptions", "/api/subscriptions/{id}"],
    methods: ["POST", "PUT"],
    kind: "irreversible",
    note:
      'outputMode: "create_invoice" together with automaticBillingGeneration: true makes ReAI issue ' +
      "numbered invoices on a recurring schedule with no further API call. This server treats such " +
      'a body as irreversible. Use outputMode: "create_order" for a reviewable draft instead.',
  },
  {
    id: "subscription-generate",
    paths: [
      "/api/subscriptions/{id}/generate",
      "/api/subscriptions/generate-due",
      "/api/subscriptions/{id}/activate",
    ],
    methods: ["POST"],
    kind: "irreversible",
    note:
      "These ISSUE invoices despite living under an otherwise reversible resource. generate-due " +
      "does it for every due subscription in the tenant at once.",
  },

  // --- Purchase ------------------------------------------------------------
  {
    id: "cost-line-amount-is-gross",
    paths: ["/api/supplier-invoices", "/api/supplier-invoices/{id}"],
    methods: ["POST", "PATCH"],
    kind: "shape",
    note:
      "The cost-line `amount` is VAT-INCLUSIVE, and neither the field name nor the spec says so. " +
      "Verified on live books: amount 1000 with a 25% debitVatCode produced 800 on the cost " +
      "account, 200 on input VAT (2711) and -1000 on the payable. So send the gross figure the " +
      "supplier billed. Sending the net 800 books 640 cost and 160 VAT instead — a 20% " +
      "understatement of the cost that still BALANCES, so neither the API nor a balance check will " +
      "flag it. The sibling reception endpoints name the same field `amountInclVat`, which is the " +
      "only hint anywhere.",
  },
  {
    id: "cost-line-explicit-accounts",
    paths: ["/api/supplier-invoices", "/api/supplier-invoices/{id}"],
    methods: ["POST", "PATCH"],
    kind: "shape",
    note:
      "Cost lines do NOT use the voucher sign convention. Each line names debitAccount and " +
      "creditAccount explicitly, and the sign of `amount` encodes DOCUMENT TYPE: at least 0.01 on " +
      "an invoice, at most -0.01 on a credit note.",
  },
  {
    // Verified against a live tenant rather than read off the schema: the spec states
    // the rule in prose but declares no `minimum`, so it was not knowable which way the
    // API would go until a real POST settled it.
    id: "supplier-invoice-costline-signs",
    paths: ["/api/supplier-invoices"],
    methods: ["POST"],
    kind: "validation",
    statuses: [400],
    note:
      "Cost-line signs are enforced PER LINE, not per document: every amount must be at least " +
      "0.01 on documentType=invoice and at most -0.01 on credit_note. Verified live — " +
      "[1000, 250] posts, [1000, -200] and even [1000, -0.4] are rejected with " +
      '"costLines amount must be at least 0.01 for invoice and at most -0.01 for credit_note". ' +
      "So a discount or an øre-rounding line cannot ride along as a negative line on an " +
      "invoice, which is how such a document usually looks on paper. Net it into the line it " +
      "discounts, or send the credit as its own credit_note document with all amounts negative.",
  },
  {
    // The consequence half of supplier-invoice-reverses, scoped to the endpoint where
    // it actually bites. It was recorded only on the DELETE, so an agent asking "is
    // this invoice already registered?" through the LIST got no warning — and
    // re-registering posts to the ledger a second time.
    id: "supplier-invoices-hide-reversed",
    paths: ["/api/supplier-invoices"],
    methods: ["GET"],
    kind: "gotcha",
    note:
      "Returns only NON-REVERSED supplier invoices and credit notes — the spec says so " +
      "outright. So absence from this list is not evidence of anything: a reversed invoice is " +
      "invisible here, and \"have we already booked invoice 10009?\" cannot be answered from it. " +
      "Re-registering one that was reversed posts to the ledger again. Fetch it by id, or check " +
      "the supplier ledger, before concluding it was never registered.",
  },
  {
    id: "supplier-invoice-reverses",
    paths: ["/api/supplier-invoices/{id}"],
    methods: ["DELETE"],
    kind: "irreversible",
    statuses: [200, 204],
    note:
      'ALWAYS answers {"outcome":"reversed"} — the spec states it unconditionally, and it does not ' +
      "offer a \"deleted\" outcome. But the outcome string does NOT tell you what happened to the " +
      "ledger. Verified end to end on an open period: the invoice was created (one voucher " +
      'appeared), DELETE returned {"outcome":"reversed"}, and afterwards the tenant had ZERO ' +
      "vouchers and ZERO postings and GET on the invoice returned 404 — nothing was left behind, " +
      "despite the word. In a closed period a counter-posting is what remains instead, which is " +
      "the case the wording is written for. So do not infer ledger state from the outcome: check " +
      "reai_list_postings. Note also that GET /api/supplier-invoices returns only NON-REVERSED " +
      "invoices, so absence from that list is not evidence of anything.",
  },  {
    id: "reception-cost-line-shape",
    paths: [
      "/api/invoice-reception-documents/{id}/supplier-invoice",
      "/api/receipt-reception-documents/{id}/registration",
    ],
    methods: ["POST"],
    kind: "shape",
    note:
      "Cost lines here are NOT shaped like the ones on /api/supplier-invoices. Each line is " +
      "{ account, amountInclVat, vatCode, description, assetId, projectId } with account and " +
      "amountInclVat required — there is no debitAccount, no creditAccount, and no `amount`. The " +
      "figure is VAT-INCLUSIVE, unlike the supplier-invoice `amount`, so reusing that shape here " +
      "puts the wrong number in the wrong field.",
  },
  {
    id: "reception-inbox-preferred",
    match: "descendants",
    paths: ["/api/invoice-reception-documents", "/api/receipt-reception-documents"],
    kind: "workflow",
    note:
      "Incoming supplier invoices normally arrive here as PDF or EHF and are registered from the " +
      "inbox, which keeps the original document attached to the posting — what the documentation " +
      "rules require. Prefer this over POST /api/supplier-invoices when a file exists. Parse an EHF " +
      "first with GET /api/attachments/{id}/ehf.",
  },
  {
    id: "ehf-embedded-files",
    paths: ["/api/attachments/{id}/ehf", "/api/attachments/{id}/embedded-files"],
    kind: "gotcha",
    note:
      "GET /api/attachments/{id}/ehf returns the parsed EHF as structured JSON (supplier, dates, " +
      "lines, totals). An EHF often also carries an embedded human-readable PDF, available from " +
      "GET /api/attachments/{id}/embedded-files.",
  },
  {
    id: "expense-lifecycle",
    match: "descendants",
    paths: ["/api/expenses"],
    kind: "workflow",
    note:
      "An expense claim moves create → deliver → approve → book the voucher, and each step is its " +
      "own call (/deliver, /approve, /voucher). Nothing posts until /voucher. DELETE " +
      "/api/expenses/{id} reverses rather than removes.",
  },

  // --- Bank ----------------------------------------------------------------
  {
    id: "no-bank-transaction-list",
    match: "descendants",
    paths: ["/api/bank-transactions", "/api/bank-reconciliations"],
    kind: "shape",
    note:
      "There is NO endpoint that lists bank transactions — GET /api/bank-transactions/{id} fetches " +
      "one by id and that is all. Transactions are seen through GET " +
      "/api/bank-reconciliations/{bankAccountId}?month=yyyy-MM, which splits them into pending " +
      "transactions, pending postings and matched groups. That view is the entry point for all bank " +
      "work.",
  },
  {
    id: "manual-vs-synced-reconciliation",
    match: "descendants",
    paths: ["/api/bank-reconciliations", "/api/manual-reconciliations"],
    kind: "workflow",
    note:
      'Two reconciliation views exist. /api/bank-reconciliations/{id} is for bank-SYNCED accounts. ' +
      'An account whose providerType is "manual" has no synced transactions and is reconciled ' +
      "against a statement balance through /api/manual-reconciliations/{id} instead. Check " +
      "providerType from GET /api/company-banks before choosing.",
  },
  {
    id: "reconciliation-month-format",
    match: "descendants",
    paths: ["/api/bank-reconciliations", "/api/manual-reconciliations"],
    kind: "validation",
    note: "These take `month` as a yyyy-MM string, not a date or a date range.",
  },
  {
    id: "apply-rules-async",
    paths: ["/api/bank-reconciliations/{bankAccountId}/apply-rules"],
    methods: ["POST"],
    kind: "gotcha",
    note:
      'Returns HTTP 202 with status "started" or "already_running" — a BACKGROUND job that can ' +
      "decline to start. The work is not done when the call returns; re-read the reconciliation " +
      "view. Also: supplying only startDate or only endDate makes the API fill the other bound " +
      "itself, which can apply rules across the account's entire history.",
  },
  {
    id: "book-transactions-subledger",
    paths: ["/api/bank-reconciliations/{bankAccountId}/vouchers"],
    methods: ["POST"],
    kind: "shape",
    note:
      'The `account` field accepts a base account number ("7770") or subledger syntax ' +
      '"accountNumber/subledgerId" ("2400/123" to book against supplier 123). Using the bare ' +
      "control account leaves the subledger unreconciled.",
  },
  {
    id: "reconciliation-rule-standing-authority",
    paths: ["/api/reconciliation-rules", "/api/reconciliation-rules/{id}"],
    methods: ["POST", "PUT"],
    kind: "gotcha",
    note:
      "A rule is standing authority to post: it books nothing on creation, but applying it creates " +
      "vouchers and DELETING the rule afterwards does not reverse what it already booked. The API " +
      'also documents an "auto-reconciliation" step at bank-sync time without saying whether that ' +
      "consults these rules.",
  },
  {
    id: "company-bank-bban",
    paths: ["/api/company-banks", "/api/company-banks/{id}"],
    methods: ["POST", "PUT"],
    kind: "validation",
    note:
      "bban is absent from the required list but is non-nullable, so omitting it creates an account " +
      "with an empty account number that cannot be used for payments or reconciliation. Always " +
      "send it.",
  },

  // --- VAT and tax ---------------------------------------------------------
  {
    id: "vat-return-does-not-file",
    match: "descendants",
    paths: ["/api/vat-returns"],
    methods: ["POST"],
    kind: "irreversible",
    note:
      "POST /api/vat-returns settles the VAT postings, creates the settlement voucher and LOCKS the " +
      "period. It does NOT submit anything to Skatteetaten or Altinn — there is no submission " +
      "endpoint in the public API. /complete-manually exists to record that a return was filed " +
      "elsewhere. Never report a VAT return as filed after calling this.",
  },
  {
    id: "vat-return-query-params",
    paths: ["/api/vat-returns"],
    methods: ["POST"],
    kind: "shape",
    note:
      "year and period are QUERY parameters, not a request body. `period` is a TERM index capped at " +
      "6, not a month: 1 = Jan–Feb, 2 = Mar–Apr, 3 = May–Jun, 4 = Jul–Aug, 5 = Sep–Oct, " +
      "6 = Nov–Dec (annual terms use 1). Passing 4 for April locks Jul–Aug.",
  },
  {
    id: "vat-codes-tenant-specific",
    match: "descendants",
    paths: ["/api/vat-codes"],
    kind: "gotcha",
    note:
      "GET /api/vat-codes with no usage returns EVERY code ReAI supports, not the tenant's — the " +
      "spec is explicit about it. Only usage=customer-invoice narrows to what the tenant can write, " +
      "and only for order and subscription lines. So the plain list shows 25% codes even on a tenant " +
      "that is not VAT-registered, and booking one invents VAT that does not exist. Offer lines are " +
      "not validated against that narrowed set at all (see the line-vat-code quirk).",
  },
  {
    id: "tax-return-filing",
    paths: ["/api/tax-returns/{year}/submit", "/api/tax-returns/{year}/validate"],
    methods: ["POST"],
    kind: "irreversible",
    note:
      "/validate is a dry run and /submit files the tax return with the authorities. This server " +
      "classifies both as irreversible, /validate conservatively so a filing path is never one " +
      "typo away in a permissive mode.",
  },

  // --- Transport -----------------------------------------------------------
  {
    id: "peppol-transmits",
    match: "descendants",
    paths: ["/api/peppol"],
    kind: "irreversible",
    note:
      "These endpoints transmit documents to counterparties over the Peppol network. Nothing sent " +
      "can be recalled.",
  },
  {
    id: "array-query-comma-joined",
    paths: ["/api/bank-reconciliations/{bankAccountId}"],
    methods: ["GET"],
    kind: "shape",
    note:
      "The `include` parameter is the only array query parameter in the API and uses " +
      "style=form, explode=false — i.e. ?include=summary,pending_postings, comma-joined rather than " +
      "a repeated key. This server handles that for you.",
  },
];

/** Normalize for prefix comparison: lowercase, no trailing slash. */
function normalize(path: string): string {
  return (path.split("?")[0] ?? path).replace(/\/+$/, "").toLowerCase();
}

/**
 * Quirks applying to one operation.
 *
 * Exact by default; only a quirk explicitly marked `descendants` reaches
 * sub-operations. Anything else would attach parent advice to children it does
 * not describe.
 */
export function quirksFor(method: HttpMethod, path: string): Quirk[] {
  const target = normalize(path);
  return QUIRKS.filter((q) => {
    if (q.methods && !q.methods.includes(method)) return false;
    return q.paths.some((p) => {
      const candidate = normalize(p);
      if (target === candidate) return true;
      return q.match === "descendants" && target.startsWith(candidate + "/");
    });
  });
}

/** True when `quirk` would apply to `method path`. Exposed for tests. */
export function quirkMatches(q: Quirk, method: HttpMethod, path: string): boolean {
  if (q.methods && !q.methods.includes(method)) return false;
  const target = normalize(path);
  return q.paths.some((p) => {
    const candidate = normalize(p);
    if (target === candidate) return true;
    return q.match === "descendants" && target.startsWith(candidate + "/");
  });
}

/** All quirks, optionally narrowed to those mentioning a search term. */
export function findQuirks(query?: string): Quirk[] {
  if (!query?.trim()) return [...QUIRKS];
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return QUIRKS.filter((q) => {
    const haystack = `${q.id} ${q.kind} ${q.paths.join(" ")} ${q.note}`.toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}
