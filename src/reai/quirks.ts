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

/**
 * Shared by the two employee-account quirks below — see the comment there for why it is two
 * entries and not one.
 */
const EMPLOYEE_ACCOUNT_SPLIT_NOTE =
  "The request field is `accountNumber` and takes the whole number; the response field is " +
  "`bankAccount`, an OBJECT, with the number split. Measured: sending accountNumber " +
  '"15201353103" reads back as bankAccount { employeeBankAccountId, countryCode: "NO", ' +
  'bankCode: "1520", accountNumber: "1353103", currency: "NOK", iban: "NO1615201353103" }. So a ' +
  'caller checking the write by comparing `accountNumber` sees "1353103" against what it sent and ' +
  "concludes it failed; read `bankAccount.iban`, or reassemble bankCode + accountNumber. Note " +
  "EmployeeRes has no flat accountNumber at all, and the COLLECTION list is a thinner projection " +
  "still — id, name and email only.";

export const QUIRKS: readonly Quirk[] = [
  {
    id: "skip-registry-lookup-is-not-a-guarantee",
    paths: ["/api/customers", "/api/suppliers"],
    methods: ["POST"],
    kind: "gotcha",
    note:
      "skipRegistryLookup=true keeps the name and address you send for an ORDINARY company, and it is " +
      "the only way to create one whose organisation number is not registered — without it that " +
      "request fails with 500 {\"detail\":\"404 : [no body]\"}. It is not a guarantee.\n" +
      "Measured on 29 organisation numbers, each read back: 16 ignore the flag and overwrite BOTH the " +
      "name and the address, including an address supplied in the same request. They are the standard " +
      "billing counterparties — Skatteetaten, Brønnøysundregistrene, Statens vegvesen, Kartverket, " +
      "Husbanken, DNB, Nordea, SpareBank 1, Telia, Telenor Norge, Elvia, Posten Bring, If, Gjensidige, " +
      "Circle K, Innkrevingsmyndigheten. Ordinary companies, sole proprietorships, sub-units, " +
      "unregistered numbers and agencies that do not invoice small companies (NAV, Politidirektoratet, " +
      "Digdir, Lånekassen) all respect it. Telenor is the clean pair: the holding company 982463718 " +
      "respects the flag, the billing entity 976967631 does not.\n" +
      "The override is NOT the Brønnøysund registry, and an earlier version of this note said it was. " +
      "It comes from a ReAI-maintained directory, and that directory is STALE: 971648198 comes back as " +
      "\"Statens Innkrevingssentral\" (a superseded name), 920058817 as \"First Card (nor)\" (not a " +
      "registry name at all), and 976967631 with postcode 7900 Rørvik where the registry says 1331 " +
      "Fornebu. So a record can be created carrying a wrong address with a 201 and no warning, which is " +
      "why the name or address has to be read back rather than assumed.",
  },
  {
    id: "customer-duplicate-org-number-reported-as-name",
    paths: ["/api/customers"],
    methods: ["POST"],
    statuses: [400],
    kind: "gotcha",
    note:
      "A customer that collides with an existing one is refused with " +
      "\"En kunde med navnet <NAME> finnes allerede.\" — and that is the EXISTING customer's name, " +
      "not the one you sent. Isolated on the live API: sending a duplicate organizationNumber under a " +
      "brand-new name produces exactly the same sentence as sending a duplicate name, quoting a name " +
      "that appears nowhere in the request. So do not read it as \"pick another name\": search by " +
      "organizationNumber first, because that is the field that is more likely to be the real clash.",
  },
  // --- Customer contact persons --------------------------------------------
  // Curated as reai_*_customer_contact, but these reach an agent that has narrowed REAI_TOOLSETS
  // away from `sales` and is going through reai_request, which is exactly when it has no tool
  // description to read. Measured on tenant 2783 on 2026-08-08.
  {
    id: "contact-persons-company-customers-only",
    paths: ["/api/customers/{id}/contact-persons"],
    methods: ["POST"],
    statuses: [400],
    kind: "gotcha",
    note:
      "Contact persons can only be added to COMPANY customers. A customer created with " +
      "privateContact=true answers 400 \"Contact persons can only be added to company customers\". " +
      "The rule is in the spec, but on CreateCustomerReq.contactPersons rather than here, so it is " +
      "easy to miss from this endpoint. A private customer's own email and phone live on the " +
      "customer record instead — PATCH /api/customers/{id}.",
  },
  {
    id: "contact-person-phone-normalised-to-e164",
    paths: ["/api/customers/{id}/contact-persons", "/api/customers/{id}/contact-persons/{contactPersonId}"],
    methods: ["POST", "PATCH"],
    kind: "gotcha",
    note:
      "The phone number is NORMALISED, not merely validated: 90123456, 004790123456 and " +
      "+4790123456 are all stored as +4790123456, so a Norwegian value does not come back as it was " +
      "sent. But the field really is international — +46701234567, +14155552671, +447911123456 and " +
      "+4915112345678 are all accepted rather than refused. NOT \"exactly as sent\", which this note " +
      "claimed until 2026-08-09: a foreign number is canonicalised too, measured on this very field — " +
      "\"+46 70 123 45 67\" is stored \"+46701234567\".\n" +
      "Bare digits are interpreted as NORWEGIAN, and that has two outcomes rather than one. An " +
      "earlier version of this note said a bare foreign number is simply refused; it is not. If the " +
      "digits are valid Norwegian they are stored under +47 SILENTLY — measured, the Danish mobile " +
      "40123456 became +4740123456, while 20123456 was refused. Always send a non-Norwegian number " +
      "with its country code: the failure mode to fear here is a wrong number saved without " +
      "complaint, not a rejection.\n" +
      "The refusal is \"Skriv inn et gyldig telefonnummer. Norske nummer kan skrives uten +47.\" — " +
      "and it says that for a malformed SWEDISH or American number too, so do not read it as \"this " +
      "number must be Norwegian\" and start rewriting country codes.",
  },
  {
    id: "contact-person-patch-blank-clears-null-keeps",
    paths: ["/api/customers/{id}/contact-persons/{contactPersonId}"],
    methods: ["PATCH"],
    kind: "gotcha",
    note:
      "Omitting a field or sending null leaves it UNCHANGED; sending \"\" CLEARS it. Verify this " +
      "the right way round if you test it: clearing a field first and then sending null reports " +
      "\"unchanged\" whichever the API does, so each case has to start from a populated record. " +
      "`name` is the exception — it cannot be cleared, and a blank or whitespace-only one is " +
      "refused with 400 \"Validation failed\" and a fieldErrors list.",
  },
  {
    id: "contact-person-404-ambiguous",
    paths: ["/api/customers/{id}/contact-persons/{contactPersonId}"],
    statuses: [404],
    kind: "gotcha",
    note:
      "AMBIGUOUS. \"Contact person with id=N not found for customer with id=C\" is the answer both " +
      "when the contact never existed or was already deleted AND when the id is real but belongs to " +
      "a DIFFERENT customer — measured, the same sentence word for word, because ids are scoped to " +
      "the tenant rather than to the customer. Do not read it as either one. Settle it with GET " +
      "/api/customers/{id}/contact-persons on the customer you meant. A missing CUSTOMER is a " +
      "different message, \"Customer with id=C not found.\", and matching the two loosely is how " +
      "the curated tool once reported a healthy customer as nonexistent.",
  },
  // --- Cross-cutting -------------------------------------------------------
  // Note: quirks true of the whole API (tenant scoping, deep links needing
  // ?tenantId) deliberately live in the server instructions instead. Attached
  // here they would match all 320 operations and drown the endpoint-specific
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
      'Measured on tenant 2634: GET /api/projects answers 403 with detail "Project module is disabled" — ' +
      'verbatim. A 403 here is usually a disabled MODULE, not a permission problem — the detail reads like ' +
      '"Project module is disabled". Do not go hunting for missing roles; the feature is off for ' +
      "this tenant. /api/share-investments is the exception worth knowing: when it refuses it does so " +
      "with an ENTIRELY EMPTY body and no content-type, so there is no detail to read. Treat a bare 403 " +
      "here the same way — the module is off.\n\n" +
      "Which is a CONDITIONAL, and worth stating because an earlier version of this note read as though " +
      "share investments were gated outright: re-measured 2026-08-08, GET /api/share-investments answers " +
      "200 with an empty list on both test tenants, so the module is on for them. Projects is the one " +
      'that is genuinely off on both — 403 "Project module is disabled" — which also puts timesheets out ' +
      "of reach, since they require a projectId.",
  },
  {
    id: "date-range-required",
    match: "descendants",
    paths: ["/api/vouchers", "/api/postings", "/api/ledger"],
    methods: ["GET"],
    kind: "validation",
    statuses: [400],
    note:
      'startDate and endDate are required, and omitting them returns 400 "startDate is required". ' +
      "Measured 2026-08-09 on eleven operations, all of which require it: /api/vouchers, /api/postings, " +
      "the five /api/ledger collections (general, customer, supplier, asset, employee) and the four " +
      "/api/ledger/{customer,supplier,asset,employee}/{id} lookups — so a SINGLE-RESOURCE path is not " +
      "automatically exempt, and a ledger lookup for one customer needs the range just as the list does. " +
      "The schema also marks both required on all eleven; an earlier version of this note said the schema " +
      "does NOT mark them, which was false. The range is validated EARLY, so a request missing it tells " +
      "you nothing about whether its other parameters would have been accepted. " +
      "Two operations this quirk matches genuinely do NOT take a date range, both measured answering 200 " +
      "without one: GET /api/vouchers/{id} and GET /api/postings/groups. " +
      "GET /api/postings/groups/{postingGroupId} declares no date parameters either, but could not be " +
      "measured — neither test tenant has a posting group, so it answers 404.",
  },
  {
    id: "timesheets-need-project-module",
    paths: ["/api/timesheets"],
    methods: ["GET"],
    kind: "gotcha",
    statuses: [400, 403],
    note:
      "Unreachable on a tenant without the Project module, in a way no schema can express: " +
      "projectId is a REQUIRED query parameter, and a request that supplies it AND a full date range " +
      'returns 400 "projectId cannot be used when the Project module is disabled". Required and ' +
      "rejected at the same time, so no request succeeds. On that exact message, stop — the module is " +
      "off and no combination of parameters helps. Say so instead of retrying. " +
      "Validation is ordered projectId, then startDate, then endDate, then the module check (measured " +
      "2026-08-09), so a partial request answers about the parameter it is missing and says nothing " +
      "about the module: bare gives \"projectId is required\", projectId alone gives \"startDate is " +
      'required", and projectId+startDate gives "endDate is required". Do not read those as the module ' +
      "being available.",
  },
  {
    id: "empty-state-is-404",
    paths: ["/api/opening-balance", "/api/annual-accounts/{year}"],
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
    paths: ["/api/manual-vouchers", "/api/manual-vouchers/{id}"],
    methods: ["POST", "PUT"],
    kind: "shape",
    note:
      "Voucher postings use ONE signed amount: positive debits the account, negative credits it, " +
      "and all postings must sum to exactly zero. Note this differs from supplier invoice cost " +
      "lines, which name debit and credit accounts explicitly.",
  },
  {
    id: "voucher-row-merge",
    paths: ["/api/manual-vouchers", "/api/manual-vouchers/{id}"],
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
    paths: ["/api/manual-vouchers/{id}"],
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
      "(1-200, default 50). `page` is ONE-based and says so: page=0 is refused, not clamped — 400 with " +
      "fieldErrors [{ field: \"page\", message: \"must be greater than or equal to 1\" }], measured on 2783 " +
      "on 2026-08-10. Worth stating because paging on this API usually goes the other way: see " +
      "paging-parameters-are-ignored-not-refused, where an unsupported paging parameter is silently " +
      "ignored on a 200. Here it genuinely pages — page=1 and page=2 at pageSize=5 returned disjoint rows. " +
      "/api/leads/person-profiles gives { items, hasMore, nextStartOrgNo, limit } " +
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
      "Offer lines are STRICTER than order lines, but only in ONE field. Both itemName and vatCode are " +
      "required on an OFFER line, and each is refused with a fieldError naming it exactly " +
      '("offerLines[0].itemName is required"). On an ORDER line vatCode is genuinely optional — but ' +
      "itemName is NOT: an order line without it is refused with 400 \"Produkt er obligatorisk for alle " +
      "ordrelinjer.\", as a plain Norwegian detail with no fieldErrors at all. Re-measured 2026-08-09; an " +
      "earlier version of this note said both fields are \"optional on an order line\", which would send an " +
      "agent to build an order line with neither and get a refusal it was told not to expect. So: a line " +
      "carrying itemName works on both, and adding vatCode is what an offer additionally needs."
  },
  {
    id: "line-vat-code-subset",
    paths: ["/api/orders", "/api/orders/{id}", "/api/offers", "/api/offers/{id}", "/api/subscriptions", "/api/subscriptions/{id}"],
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
    id: "order-and-offer-put-ignores-most-nulls",
    paths: ["/api/orders/{id}", "/api/offers/{id}"],
    methods: ["PUT"],
    kind: "gotcha",
    note:
      "A null in the body is accepted with 200 and then SILENTLY IGNORED for some fields — the stored value " +
      "does not change, and nothing in the response says the value you sent was discarded. It is TWO families " +
      "rather than one rule, and OMITTING a field follows the same split, so measured on 2783 field by field:\n\n" +
      "  BOTH endpoints\n" +
      "    comment            omitted KEPT      null KEPT      \"\" CLEARS (stored back as null)\n" +
      "    internalComment    omitted KEPT      null KEPT      \"\" CLEARS\n" +
      "    projectId          omitted EMPTIED\n" +
      "  ORDERS only\n" +
      "    buyerReference     omitted EMPTIED   null CLEARS\n" +
      "    externalReference  omitted EMPTIED   null CLEARS\n" +
      "  OFFERS only — measured there, and NOT transferable to an order\n" +
      "    email              null KEPT\n" +
      "    issueDate          null KEPT, the existing date preserved. On an ORDER issueDate is REQUIRED, so a\n" +
      "                       null is a different question there and was not measured.\n" +
      "    deliveryAddress    null KEPT, the existing object preserved. UpdateOrderReq does not declare this\n" +
      "                       field at all, so it says nothing about orders.\n\n" +
      "So to empty a comment send an EMPTY STRING; a null there is a no-op that answers 200. The first two " +
      "behave like `if (value != null) set(value)`; the rest like a plain replacement. Do not generalise from " +
      "one to the other.\n\n" +
      "Also worth knowing when creating: the API fills in `issueDate` (today), `email` (the customer's) and " +
      "`deliveryAddress` (an object) even when the POST omits them, so a freshly created order or offer does " +
      "not have them null in the first place — which is why this went unnoticed.\n\n" +
      "SCOPE: measured on these two endpoints only, and it does NOT generalise. 14 curated tools take a " +
      "nullable argument on a PUT or PATCH — 12 besides these two — and the phrase \"null clears it\" appears " +
      "in eight source files. Those remain unverified against this behaviour, with one exception now measured: " +
      "PUT /api/creditors/{id} honours a null on bankAccountNumber — cleared by a null, by omitting the field " +
      "and by an empty string alike, on three throwaway creditors. So creditors fall in the PLAIN REPLACEMENT " +
      "family, alongside buyerReference and externalReference above, rather than in the comment family. Worth " +
      "stating precisely because the earlier wording called it \"the third endpoint to disagree\", which was " +
      "wrong twice: the split here is per-FIELD rather than per-endpoint, and other endpoints that clear on " +
      "null were already recorded (PUT /api/leads/{orgNumber}/notes, an employee endDateOfEmployment). The " +
      "rule is that each field on each endpoint has to be measured, not that endpoints disagree.\n\n" +
      "reai_update_subscription used to report \"Still armed\" for outputMode, automaticBillingGeneration and " +
      "sendEhf from what it SENT, so a discarded disarming produced no note and silence read as confirmation. " +
      "It reports those from the RESPONSE now, warns when the response disagrees with what was sent in either " +
      "direction, and says so when the response does not answer. Whether this API ever discards such a value " +
      "is still unmeasured — not because subscriptions are created active (subscription-created-active " +
      "measured that an inert one is constructible: automaticBillingGeneration: false is what makes it " +
      "harmless) but because measuring means creating a subscription on a real company, and the only one on " +
      "the test tenant is real.",
  },
  {
    id: "order-and-offer-put-rename-the-lines",

    paths: ["/api/orders/{id}", "/api/offers/{id}"],
    methods: ["PUT"],
    kind: "gotcha",
    note:
      "The RESPONSE does not have the shape the REQUEST wants, so a read-modify-write built by hand fails " +
      "or mangles the document. GET returns the line items under `lines`; the PUT requires them under " +
      "`orderLines` (orders) or `offerLines` (offers) — and both are REQUIRED, so a body echoing `lines` " +
      "back is a body with no lines at all.\n\n" +
      "Each line the GET returns also carries fields the PUT does not declare, most of them computed: on an " +
      "order `id`, `vatTitle`, `vatRate`, `amounts`; on an offer `id`, `rowNumber`, `vatRate`, `lineTotal`, " +
      "`lineTotalExclVat`, `lineVat`, `lineDiscount`. Strip them.\n\n" +
      "And the optional top-level fields are dropped by any replacement that omits them: on an order " +
      "`comment`, `internalComment`, `buyerReference`, `externalReference`, `projectId`, `invoiceEmail`. " +
      "`invoiceEmail` is the one that cannot be recovered — the PUT accepts it and no order response returns " +
      "it, so a replacement silently clears an order-specific invoice address and nothing reads back to " +
      "prove it. Offers are luckier: everything OfferReq accepts, OfferRes returns.\n\n" +
      "reai_update_order and reai_update_offer do all of this, each for its own endpoint. Measured on order " +
      "4105 and offer 81 on a test tenant.",
  },
  {
    id: "days-until-due-mandatory",

    paths: ["/api/orders", "/api/orders/{id}", "/api/offers", "/api/offers/{id}"],
    methods: ["POST", "PUT"],
    kind: "gotcha",
    note:
      "daysUntilDue is required and non-nullable, so the API can never fall back to the customer's " +
      "own payment terms — whatever you send OVERRIDES them. Read the customer's daysUntilDue " +
      "first if you want their terms respected.\n\n" +
      'Omitting it does NOT produce a field error: it answers a bare 400 "Failed to read request", with no ' +
      "fieldErrors and nothing naming the field, because a non-nullable field that fails to deserialise never " +
      "reaches validation. Measured 2026-08-09 on orders, both omitted and explicitly null. On that message, " +
      "re-check your required fields rather than hunting for a field name that will not come.",
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
    id: "phone-one-rule-parsed-as-norwegian",
    paths: [
      "/api/customers",
      "/api/customers/{id}",
      "/api/suppliers",
      "/api/suppliers/{id}",
      "/api/customers/{id}/contact-persons",
      "/api/customers/{id}/contact-persons/{contactPersonId}",
    ],
    methods: ["POST", "PATCH"],
    kind: "gotcha",
    note:
      "ONE rule for every phone field here — customer.phone, supplier.phone and " +
      "contactPersons[].phone all behave identically, and a \"+47\" prefix is ACCEPTED on all three.\n" +
      "The rule, measured across customer.phone, supplier.phone and contactPersons[].phone, which " +
      "behave identically: the value is parsed with NORWAY as the default region and stored " +
      "canonicalised to E.164 — nothing is stored as sent, so \"+46 70 123 45 67\" comes back " +
      "\"+46701234567\" and \"(40) 12 34 56\" comes back \"+4740123456\". A leading +CC, 00CC or a " +
      "bare 47 selects the country; anything else is read as Norwegian, and the digits must be valid " +
      "for whichever country that resolved to or the write is refused with 400.\n" +
      "The trap is those last two together: a bare number that is also valid in Norway is stored " +
      "under +47 with no warning, whatever was meant. The Danish mobile 40123456 becomes " +
      "+4740123456; 20123456 is refused, and NOT because it is Danish — 20 is unallocated in Norway, " +
      "while 21123456 and 22334455 are both accepted. Always send a non-Norwegian number with a + and " +
      "its country code. A bare 47 counts as one, a bare 45 does not.\n" +
      "The employee phone is the one exception in the API: it stores an unparseable value as NULL " +
      "with a 200 rather than refusing it, so a write there has to be read back.\n" +
      "History, because the correction matters: until 2026-08-08 this note claimed \"two phone " +
      "fields, opposite rules\" and that the entity phone REJECTED a +47 prefix. Measured false — " +
      "PATCH /api/customers/{id} and /api/suppliers/{id} both answer 200 to \"+4722334455\" and store " +
      "it. Two tool descriptions built on it told agents to strip a prefix that was correct.",
  },
  {
    id: "brreg-lookup",
    paths: ["/api/customers", "/api/suppliers"],
    methods: ["POST"],
    kind: "gotcha",
    note:
      "A Norwegian company is looked up in Brønnøysundregistrene from organizationNumber and its " +
      "name and address are filled in for you. skipRegistryLookup opts out of that — but only for an " +
      "ORDINARY company: see skip-registry-lookup-is-not-a-guarantee, which is about this same " +
      "operation and lists the sixteen counterparties that overwrite you regardless.",
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
    id: "salary-ctrl-aliases-have-no-documentation",
    paths: [
      "/salary/{id}/complete",
      "/salary/{id}/payment-date",
      "/salary/{id}/register-payment",
    ],
    methods: ["POST"],
    kind: "gotcha",
    note:
      "Three payroll endpoints live OUTSIDE /api, under the salary-ctrl tag, and the spec gives " +
      "them no summary, no description and no required fields — an endpoint list shows them as " +
      "bare names. What they are is not a mystery, though:\n\n" +
      "/salary/{id}/complete is the same operation as POST /api/salary-payments/{id}/complete, " +
      "which is to say it posts the voucher, creates payslips and payments and files the A-melding " +
      "with Skatteetaten. /register-payment records or instructs payment of a run. Both are " +
      "treated as EXTERNAL SENDS and refused unless REAI_ALLOW_EXTERNAL_SEND is on — the /api " +
      "patterns alone would not have caught them, since they are not under /api.\n\n" +
      "/payment-date is NOT gated as a send, and this is stated rather than glossed: it reads as " +
      "setting the payout date on a run, which is local, but with no documentation and no way to " +
      "test it on a run that has not been completed, that is inference. It is classified " +
      "irreversible, so `full` mode is required. Treat it as unknown, and prefer the documented " +
      "/api paths for anything you intend to be sure about.",
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
      "Two more things. Omitting employeeIds — or sending an empty list — includes every employee " +
      "ELIGIBLE FOR THE PERIOD, which is the schema's own wording: passing nothing is not passing " +
      "nobody, and it is not the whole register either, since what makes an employee ineligible is " +
      "documented nowhere. Read employeeIds on the response to see who is actually in.\n\n" +
      "And creating a run posts NO voucher — measured, the count did not move and voucherId stayed " +
      "null; the voucher is made at completion, which is why a run in status under_process can be " +
      "deleted without touching the ledger. Note the DELETE is really \"delete OR REVERSE\" and " +
      'says which in {"outcome":"deleted"|"reversed"} — a reversal is what you get once there is ' +
      "audit history to keep, and it posts.",
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
      "created for and cannot be moved.\n\n" +
      "The update is a FULL REPLACEMENT, measured: a line carrying comment \"PROBE COMMENT\" was " +
      "PUT back with the same quantity, rate and code but no comment field, and the comment came " +
      "back null — confirmed on a re-read, and reproduced in the write suite. comment and " +
      "holidayAllowanceEarningYear are the two optional fields, so those are the two a raw PUT " +
      "silently erases. reai_update_salary_line reads the line and carries over what the caller " +
      "did not mention; a raw call has to send the line as it should END UP.\n\n" +
      "Lines derived from EXPENSE POSTINGS cannot be changed at all — the API says so on the update " +
      "endpoint. That is also why a fresh run is not empty: it arrives pre-populated from the " +
      "period's expense postings, and adding the same pay again is how wages go out twice.\n\n" +
      "The response is the whole run with tax recalculated. On a tenant with no tax cards the rate " +
      "is 50%: a 1 × 5000 COMMISSION line produced payableAmount 2500 and totalTaxDeducted 2500.",
  },
  {
    id: "reversing-an-expense-unposts-its-voucher",
    paths: ["/api/expenses/{id}", "/api/expenses/{id}/voucher"],
    methods: ["DELETE"],
    kind: "workflow",
    note:
      "Reversing an expense TAKES ITS VOUCHER WITH IT. Measured: an expense booked to voucher 30808 " +
      "was reversed with DELETE /api/expenses/{id}, the day's voucher count went from 1 back to 0, " +
      'and DELETE /api/vouchers/30808 then answered 404 "Bilag ikke funnet". The voucher is gone ' +
      "rather than stranded, so a booked expense does NOT have to be unlinked before it is " +
      "reversed.\n\n" +
      "The consequence for ordering is the other way round from what it looks like. Once the expense " +
      "is reversed, DELETE /api/expenses/{id}/voucher answers " +
      '409 "Kan ikke slette bilag fra et slettet utlegg/reiseregning." — not because the voucher is ' +
      "stuck, but because there is no longer an expense to unlink it from. A 409 there after a " +
      "reversal is expected and means nothing is left to do.",
  },
  {
    // Vouchers only. ReconciliationRuleMutationReq has subAccountId and NO companyBankId, so
    // telling a rule caller that a bank account may be mandatory would send them into a second
    // rejection for an unknown field. The sub-account half that DOES apply to rules is the entry
    // below.
    id: "some-accounts-demand-a-dimension",
    paths: ["/api/manual-vouchers"],
    methods: ["POST"],
    kind: "validation",
    statuses: [400],
    note:
      "Two posting fields are conditionally MANDATORY although both read as optional, and the API " +
      "says so only in Norwegian, naming the line and nothing else:\n\n" +
      '  400 "Linje 1: Konto 1320 må posteres med underkonto."   (needs subAccountId)\n' +
      '  400 "Linje 1: Konto 1920 må posteres med bankkonto."    (needs companyBankId)\n\n' +
      "The sub-account rule is the surprising one: an account that has ANY general sub-account " +
      "requires one on every posting to it, INCLUDING an account whose only sub-account is called " +
      '"Default" — which is the usual case. Measured on two accounts, one with a single sub-account ' +
      "and one with two; both refused. So the field cannot be left out precisely where it looks " +
      "harmless.\n\n" +
      "Find the valid ids with GET /api/general-sub-accounts, or per account with " +
      "GET /api/general-sub-accounts/accounts/{accountNumber}, which also returns a " +
      '`selectableAccountNumber` of the form "1300/6229" — the account/sub-account pair as the ReAI ' +
      "interface names it. reai_create_voucher pre-checks this and names the choices.\n\n" +
      "Note the selector has THREE answers, not two: a list, an empty list, or " +
      '400 "accountNumber 3000 does not support general sub-accounts" for an account that cannot ' +
      "have them at all. The 400 is a clear no rather than a failure to work around.",
  },
  {
    id: "reconciliation-rules-take-a-sub-account",
    paths: ["/api/reconciliation-rules", "/api/reconciliation-rules/{id}"],
    methods: ["POST", "PUT"],
    kind: "validation",
    note:
      "A reconciliation rule carries `subAccountId`, and the same rule applies as for a voucher " +
      "posting: an account that has ANY general sub-account requires one, including an account whose " +
      'only sub-account is called "Default". Find the ids with ' +
      "GET /api/general-sub-accounts/accounts/{accountNumber}.\n\n" +
      "Unlike a voucher posting, ReconciliationRuleMutationReq has NO companyBankId — sending one " +
      "would be rejected as an unknown field — so the bank-account requirement documented on " +
      "/api/vouchers does not apply here.",
  },
  {
    id: "a-sub-account-cannot-be-removed",
    paths: ["/api/general-sub-accounts", "/api/general-sub-accounts/{id}"],
    kind: "irreversible",
    note:
      "A general sub-account is permanent. There is no DELETE — measured, " +
      "DELETE /api/general-sub-accounts/{id} answers 405 — and PUT accepts only `name`: sending " +
      'accountNumber answers 400 "Unknown field: accountNumber", so it cannot be moved to another ' +
      "ledger account either. Create/update asymmetry of the same shape as the salary wage lines.\n\n" +
      "Creating one also changes how its ACCOUNT behaves for everybody: once an account has any " +
      "sub-account, every posting to it must name one, so adding the first sub-account to an account " +
      "breaks any routine that posts to it without a subAccountId.",
  },
  {
    // Exact, NOT descendants. This note is about the collection: the envelope, the pagination and
    // pageSize. Attached to descendants it also landed on GET /api/leads/org/{orgNumber} and
    // /api/leads/{id}, which return a single LeadRes, accept no pageSize, and have no envelope — so
    // discovery presented confident, wrong response guidance for the two detail endpoints. The part
    // that DOES apply to them is the entry below.
    id: "leads-are-the-company-register-not-your-records",
    paths: ["/api/leads"],
    methods: ["GET"],
    kind: "shape",
    note:
      "This is not a list of records the tenant owns. GET /api/leads searches the Norwegian company " +
      "register (Brønnøysund) and layers whatever lead state the tenant has on top — measured, every " +
      "row of the default first page came back with id null and status null, i.e. companies nobody " +
      "here has touched. `leadFilter` is what separates them: all | saved | unsaved.\n\n" +
      "TWO ADDRESSING SCHEMES, and only one always works. /api/leads/{id} and " +
      "/api/leads/org/{orgNumber} both exist, but an unsaved company has no id: " +
      '`GET /api/leads/null` answers 400 "Failed to convert \'id\' with value: \'null\'". The ' +
      "organisation number is on every row either way, so it is the handle to use.\n\n" +
      "The envelope is {items, page, hasPrevious, hasNext, latestRegisteredAt} — a page marker and no " +
      "TOTAL, so \"how many companies match\" cannot be answered from one call. And pageSize is " +
      'capped at 200: 500 answers 400 "Validation failed", whose top-level detail names nothing but whose ' +
      "fieldErrors DOES: [{ field: \"pageSize\", message: \"must be less than or equal to 200\" }]. " +
      "Re-measured 2026-08-09 — an earlier version of this note said that 400 \"names no field\", which " +
      "sent agents past the one part of the body carrying the fix. Read fieldErrors before concluding a " +
      "validation failure is opaque: it is populated here and empty on /api/leads/person-role-matches, so " +
      "the two cannot be treated alike.",
  },
  {
    id: "lead-detail-nests-what-the-search-flattens",
    paths: ["/api/leads/org/{orgNumber}", "/api/leads/{id}"],
    methods: ["GET"],
    kind: "shape",
    note:
      "The detail response and a search ROW disagree about where lead state lives, which is easy to " +
      "miss because the two look alike otherwise. LeadRes nests it: " +
      "`lead: { id, status, notes, email, phone, followUpAt, convertedCustomerId, convertedAt, " +
      "createdAt, updatedAt }` — ten fields, not the eight an earlier version of this note listed; " +
      "measured on a live response. A row from GET /api/leads flattens `id` and `status` to the top " +
      "level instead.\n\n" +
      "So code that reads `id` at the top level of a detail response gets undefined and concludes " +
      "the company has no lead state — which for an untouched company is coincidentally right and " +
      "for a saved one is wrong. Read `lead.id`.\n\n" +
      "An untouched company still returns the `lead` object, with every field null, rather than " +
      "omitting it. `contactEvents` comes back as [].\n\n" +
      "And /api/leads/{id} cannot address an untouched company at all: it has no id, so that path is " +
      "only usable once something has been written. The org-number path always works.",
  },
  {
    id: "three-roles-are-the-same-role",
    // /api/users/permissions is here because the last paragraph is specifically about it — the
    // quirk warned that the catalogue omits the self-scoped codes while not being attached to the
    // catalogue, so discovery on that endpoint published nothing.
    paths: ["/api/users", "/api/users/{id}", "/api/users/roles", "/api/users/permissions"],
    kind: "gotcha",
    note:
      "The role NAMES imply a hierarchy the permissions do not implement. Measured on a live tenant " +
      "by comparing the permission SETS rather than their sizes:\n\n" +
      "  ROLE_OWNER         51 permissions   NOT assignable\n" +
      "  ROLE_TENANT_ADMIN  51 permissions   assignable   identical to OWNER (0 missing, 0 extra)\n" +
      "  ROLE_ACCOUNTANT    51 permissions   assignable   identical to OWNER (0 missing, 0 extra)\n" +
      "  ROLE_AUDITOR       20 permissions   assignable   read-only\n" +
      "  ROLE_EMPLOYEE       6 permissions   assignable   self-scoped only\n\n" +
      "So inviting someone as an ACCOUNTANT grants exactly what the owner has, including " +
      "tenant:user:write — the permission to invite more people. The only thing ROLE_OWNER has that " +
      "the other two do not is that it cannot be handed out. Anyone reasoning from the titles will " +
      "grant more than they meant to.\n\n" +
      "POST /api/users takes roleCode and mails an invitation, which is why this server treats it as " +
      "an external send: what leaves the tenant is not data but authority.\n\n" +
      "Permission codes are scoped by PREFIX, and it decides how much of the company they reach. " +
      "`self:` covers only the acting user's own records — employee card, expenses, timesheets — " +
      "and `tenant:` covers the company's. All six of ROLE_EMPLOYEE's are `self:`; the owner holds " +
      "6 self and 45 tenant.\n\n" +
      "GET /api/users/permissions does not list the self-scoped ones at all — measured, it returns 45 " +
      "codes and every one is tenant:, while the owner's effective set is 51. So a code seen on a " +
      "user that is missing from the catalogue is not evidence that the code is wrong.",
  },
  {
    id: "delete-a-parent-and-its-children-become-undeletable",
    paths: ["/api/orders/{id}", "/api/customers/{id}", "/api/products/{id}", "/api/suppliers/{id}"],
    methods: ["DELETE"],
    kind: "irreversible",
    note:
      'DELETE answering 500 "Referenced record is not accessible" means this record points at ' +
      "something that has already been removed, and it is NOT recoverable. Found the slow way: eight " +
      "orders on the test tenant cannot be deleted through the API at all, because the PRODUCT their " +
      "lines name was deleted first. Every DELETE on them answers that 500, and there is no product " +
      "unarchive endpoint to restore the reference with.\n\n" +
      "So the ordering rule is: remove dependents BEFORE the master data they point at. Orders " +
      "before products and customers, invoices before either.\n\n" +
      "What recovery exists is narrow. /api/customers/{id}/unarchive and /api/suppliers/{id}/unarchive " +
      "exist and work — a customer reading archived: true came back archived: false, measured — but " +
      "unarchiving the customer does NOT rescue an order blocked this way; that was tried and the 500 " +
      "persisted, because the customer was never the missing reference. Products, warehouses and " +
      "employees have no unarchive at all.\n\n" +
      "One consequence worth planning for: a subscription that generated such orders cannot be " +
      'deleted either — 409 "Kan ikke slette et abonnement som har generert faktureringshistorikk" — ' +
      "so an undeletable order takes its subscription with it.",
  },
  {
    id: "archived-records-need-an-explicit-filter-to-see",
    paths: ["/api/customers", "/api/suppliers"],
    methods: ["GET"],
    kind: "gotcha",
    note:
      "DELETE on a customer or supplier with transactions ARCHIVES it rather than deleting, and an " +
      "archived record is absent from the plain list. `archived=true` is what shows them, and it is " +
      "EXCLUSIVE rather than a superset: it returns the archived records ONLY, so no single call " +
      "returns both sets. `includeArchived=true` is not a parameter this API has, and — re-measured " +
      "2026-08-09 — it is silently IGNORED rather than rejected: it returns the plain list, exactly as " +
      "any unknown parameter does (?totallyBogusParam=true returns the same rows). An earlier version " +
      "of this note said it \"returns nothing\", which was an artifact of measuring on a tenant with no " +
      "active records; believing it would leave you reading an unfiltered list while thinking it was " +
      "filtered. So \"the customer is gone\" read off the default list is " +
      "not evidence that it was deleted, and a name collision on create can come from a record you " +
      "cannot see.",
  },
  {
    id: "expense-status-never-says-booked-or-reversed",
    paths: ["/api/expenses/{id}", "/api/expenses"],
    methods: ["GET"],
    kind: "shape",
    note:
      "The status field answers less than it appears to. Its enum is open | for_approval | " +
      "approved, and TWO important states are missing from it.\n\n" +
      "BOOKED is not a status. An expense posted to the ledger still reads \"approved\" — the only " +
      "difference is that voucherId is set, so that is what \"is this in the ledger\" is answered " +
      "by. Measured.\n\n" +
      "REVERSED is not a status either, and it hides. DELETE /api/expenses/{id} answers " +
      '{"outcome":"reversed"} and the expense then disappears from GET /api/expenses — while ' +
      "GET /api/expenses/{id} still returns it with whatever status it had before, unchanged. " +
      "?status=reversed cannot be used to find them: the filter rejects the word with a 400 " +
      "(\"Failed to convert 'status' with value: 'reversed'\"). The only positive signal is that a " +
      'transition fails, e.g. 409 "Expense 2203 is reversed and can no longer be delivered". To ' +
      "establish whether one specific expense is reversed, ask for the LIST filtered by its own " +
      "status and see whether the id is in it — absent means reversed. reai_get_expense does that.",
  },
  {
    id: "expense-category-optional-to-create-required-to-deliver",
    paths: ["/api/expenses", "/api/expenses/{id}", "/api/expenses/{id}/deliver"],
    methods: ["POST", "PATCH"],
    kind: "validation",
    note:
      "A cost row's `category` is typed nullable and is genuinely optional on POST /api/expenses — " +
      "the row is accepted with none. It is REQUIRED to deliver: measured, " +
      '400 "Kategori må velges for kostnadsrad." ("a category must be selected for the cost row"), ' +
      "and the message names no row, so on a claim with several the offender has to be found by " +
      "hand. It is an enum of 28 values (advertising, flight, hotel, taxi, software, " +
      "representation_deductible, work_clothes and so on) which drive the account the cost maps " +
      "to, so guessing has a bookkeeping consequence rather than just a validation one.\n\n" +
      "The same shape applies to the rest of the completion validation: an employee and a payable " +
      "amount are optional to create and required to deliver.",
  },
  {
    id: "expense-line-arrays-are-complete-lists",
    paths: ["/api/expenses/{id}"],
    methods: ["PATCH"],
    kind: "shape",
    note:
      "Scalars patch and the ARRAYS REPLACE, in the same request. Omitting title or purpose leaves " +
      "them alone, and purpose, employeeId and projectId are cleared by sending null. But costs, " +
      "perDiems and mileageAllowances are each \"the complete list\": measured, an expense with two " +
      "cost rows PATCHed with one came back with one and its total fell from 300 to 100 — the other " +
      "row is gone. Omitting an array preserves it (also measured: a title-only PATCH left the rows " +
      "untouched), so the danger is only in sending one. Include the rows you are keeping.\n\n" +
      "Only an OPEN expense can be changed at all. Delivered, approved, booked or reversed all " +
      'answer 409 — "er bokført på bilag og kan ikke lenger endres" for a booked one. The way back ' +
      "is: delete the voucher, unapprove, edit.",
  },
  {
    id: "booking-an-expense-approves-it-too",
    paths: ["/api/expenses/{id}/voucher"],
    methods: ["POST"],
    kind: "workflow",
    note:
      "This POSTS TO THE LEDGER: the voucher count moved by one, and the response is " +
      '{expenseId, voucherId, voucherNumber, voucherDate} with its own series ("EX1-2026").\n\n' +
      "It also APPROVES an expense that is still for_approval, as part of the same call — measured, " +
      "an expense went straight from for_approval to approved-with-a-voucher. So this is not a " +
      "step that needs /approve first, and it is not a safe way to \"check\" anything.\n\n" +
      "The DELETE on the same path is \"delete OR reverse\", answering " +
      '{"outcome":"deleted"} or {"outcome":"reversed"} — deleted while no accounting history has to ' +
      "be kept, reversed once it must, and a reversal posts. The expense survives either way and " +
      "can be booked again, which means a second booking is a second voucher.",
  },
  {
    id: "employee-patch-really-patches-except-one-field",
    paths: ["/api/employees/{id}"],
    methods: ["PATCH"],
    kind: "shape",
    note:
      "This is a REAL patch, which in this API is the exception: measured, a PATCH carrying only " +
      "`phone` left city, postalCode, addressPart1, bankAccount, dateOfEmployment and the " +
      "employment lines exactly as they were. Company banks, creditors, agreements, subscriptions " +
      "and salary wage lines all replace; this one does not.\n\n" +
      "With one exception INSIDE it. `employmentLines` is a FULL REPLACEMENT: an employee with two " +
      "lines, PATCHed with one, came back with one — the other gone, and the survivor recreated " +
      "with a NEW id. So adding a raise as a single-line PATCH deletes the employment history, " +
      "which the a-melding reports. Read the current lines and send them back with the new one. " +
      "`employmentLines: []` clears every line; `employmentLines: null` leaves them ALONE (measured " +
      "on an employee that had one, so it is not a vacuous reading of an already-empty list).\n\n" +
      "One validation rule on those lines, measured: a line whose fromDate is BEFORE the employee's " +
      'dateOfEmployment is refused with 400 "Ansettelseslinje N: Fra-dato kan ikke være før ' +
      'ansettelsesstart". The N counts position in the REQUEST array, not a line id. The rejection ' +
      "is atomic — the lines already on the employee all survived it — so a refused write is safe, " +
      "but it is easy to hit: an employee created without a start date has one of TODAY, and any " +
      "historical line then predates it.\n\n" +
      "And null does NOT mean \"clear\" here in general, whatever the field types suggest — only the " +
      "fields whose own descriptions say so behave that way. Measured: endDateOfEmployment: null " +
      "cleared a stored date, while phone: null, email: null and accountNumber: null were all " +
      "silently IGNORED, the stored values still there afterwards. So there is no way to REMOVE a " +
      'phone or an email through this endpoint; an empty email answers 409 "Employee email is ' +
      'required". A fødselsnummer is checksum-validated (400 "Ugyldig fødselsnummer"), and so is an ' +
      'account number — "12345" answers 400 naming the expected BBAN length, and a non-numeric one ' +
      '"must contain only digits".',
  },
  {
    id: "employee-phone-is-normalised-or-silently-nulled",
    paths: ["/api/employees", "/api/employees/{id}"],
    methods: ["POST", "PATCH"],
    kind: "gotcha",
    note:
      "`phone` is stored in E.164 and the parser is generous: \"22 33 44 55\", \"0047 22334455\" " +
      'and "+4722334455" all store as "+4722334455", and "+1 415 555 0100" stores as ' +
      '"+14155550100". What it does with a value it CANNOT parse is the problem — it stores NULL, ' +
      "answers 200, and says nothing. Measured: \"nonsense\" replaced a stored \"+4722334455\" " +
      "with null. So a phone write can destroy the number that was there with no error at all; " +
      "read the field back rather than trusting the status.\n\n" +
      "This note claimed until 2026-08-09 that suppliers differ, \"where a +47 prefix is REJECTED " +
      "outright\". That is false and was known to be false: PR #112 measured PATCH /api/suppliers/{id} " +
      "answering 200 to \"+4722334455\" and storing it, and corrected the claim in registry.ts while " +
      "leaving this sentence standing. Re-measured 2026-08-09, same result. One rule applies to every " +
      "phone field — see PHONE_RULE — and the employee field's only difference is the silent null " +
      "above, not the prefix.",
  },
  {
    id: "employee-create-is-not-a-blank-record",
    paths: ["/api/employees"],
    methods: ["POST"],
    kind: "gotcha",
    note:
      "Only name and email are required, but what comes back is not an empty shell. Measured with " +
      "exactly those two fields: `dateOfEmployment` was set to TODAY, and an employment relation " +
      "containing ONE employment line was created automatically, typed " +
      "`ordinaertArbeidsforhold` with every other field null. Employment and its start date are " +
      "what the a-melding reports, so today's date is a fact about the company's filings rather " +
      "than a placeholder — pass the real one.\n\n" +
      "Also measured: `address.countryCode` comes back as two SPACES (\"  \") rather than null or " +
      '"NO" when no address is given, so do not compare it against "" or treat it as absent.',
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
    // Two entries for one fact, and deliberately not one entry listing both paths: `methods`
    // applies to EVERY path in an entry, so a single entry covering POST/PATCH/GET on both also
    // claimed the COLLECTION GET returns a bankAccount object. It does not — that response is the
    // EmployeeSummaryRes projection of id, name and email, which `employee-list-is-a-projection`
    // says a few entries down. Discovery on GET /api/employees therefore showed two notes that
    // contradicted each other, and the wrong one sent a caller looking for payroll account details
    // that cannot be in that response at all.
    id: "employee-account-goes-in-flat-and-comes-back-split",
    paths: ["/api/employees"],
    methods: ["POST"],
    kind: "shape",
    note: EMPLOYEE_ACCOUNT_SPLIT_NOTE,
  },
  {
    id: "employee-account-split-on-read-and-update",
    paths: ["/api/employees/{id}"],
    methods: ["GET", "PATCH"],
    kind: "shape",
    note: EMPLOYEE_ACCOUNT_SPLIT_NOTE,
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
      "not evidence that a usable contract exists; count the populated fields. Fourteen fields " +
      "across FOUR of the five templates are ENUMS — purchase-agreement declares none — and the " +
      "document names every member, so read them " +
      "from this endpoint rather than guessing: the members are lowercase snake_case, which is " +
      "not what the Norwegian contract form suggests. leaseDurationType is indefinite | " +
      "fixed_standard | fixed_special_reason and depositType is deposit | guarantee. Norwegian " +
      "tenancy law caps a " +
      "deposit at six months' rent and wants a statutory reason for a fixed term under three " +
      "years; neither is enforced — a deposit of 9 999 999 against a rent of 10 000 was accepted, " +
      "as was a four-month fixed_standard lease with no reason. And a field name the template does " +
      "not declare is SILENTLY DROPPED: measured on a lease, an undeclared name was accepted with " +
      "the 201 and then came back nowhere — not under the template sub-object and not at the top " +
      "level — so a misspelt term is simply absent from the finished contract with nothing in the " +
      "response to say so. reai_create_agreement names any undeclared term before you rely on it.",
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
    paths: ["/api/manual-vouchers", "/api/manual-vouchers/{id}"],
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
      "An expense claim moves create → deliver → approve → book the voucher, each step its own " +
      "call (/deliver, /approve, /voucher). Nothing posts until /voucher — and /voucher does NOT " +
      "need /approve first: it approves a for_approval expense as part of booking, measured, so " +
      "\"each step is its own call\" does not mean each step is required. DELETE /api/expenses/{id} " +
      "reverses rather than removes, and leaves no visible trace of having done so. The " +
      "endpoint-specific entries say what each of those actually does.",
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
    id: "provider-balance-is-not-month-scoped",
    paths: ["/api/bank-reconciliations/{bankAccountId}"],
    methods: ["GET"],
    kind: "gotcha",
    note:
      "`providerBalance` is the bank feed's CURRENT balance, not the balance at the end of the month you asked " +
      "for. Comparing it against `bankLedgerClosingBalance` invents a discrepancy that does not exist — and " +
      "\"your bank does not match your books\" is an alarming answer to give wrongly.\n\n" +
      "Measured on 2634, account 1338, two months in one sync:\n" +
      "  month=2026-07  bankLedgerClosingBalance 554.31   providerBalance 1039.70\n" +
      "  month=2026-08  bankLedgerClosingBalance 1002.36  providerBalance 1039.70\n" +
      "`providerBalance` is IDENTICAL across both, with the same lastSyncedAt (2026-08-10T16:37:54Z), which is " +
      "what shows it to be one live snapshot rather than a month-end figure. Reading July that way would report " +
      "a 485.39 shortfall against books that balance.\n\n" +
      "The month-scoped comparable is `actualBankDisplayedBalance`, which equalled the ledger closing balance " +
      "exactly in both months — BUT only when the currencies match. `bankCurrency` and `tenantCurrency` are " +
      "both in the response, and this repository already refuses the comparison when they differ: " +
      "src/ui/reconciliation.ts sets `comparable: bankCurrency === tenantCurrency` and the view hides the " +
      "difference rather than computing one. All three accounts on 2634 are NOK, so the foreign-currency " +
      "case is unobservable here and one NOK account establishes nothing about it — on a currency account, " +
      "subtracting a bank figure from a book figure manufactures a discrepancy the size of the exchange " +
      "rate. Check the two currencies first, and when they differ report that no comparison is available " +
      "rather than producing one. `bankInTenantCurrency` does NOT rescue this: it says whether the account " +
      "runs in the tenant currency, not which response figure is stated in which currency. Postings carry " +
      "both `amount` and `currencyAmount`, and the OpenAPI document describes neither, so which one is the " +
      "bank side is not established anywhere — src/ui/reconciliation.ts records exactly that as the reason " +
      "it refuses. Do not convert, and do not infer the side from a boolean.\n\n" +
      "THE DISCREPANCY FIELDS DO NOT ANSWER THIS QUESTION EITHER, which was a mistake in an earlier version " +
      "of this note. `pendingDiscrepancy` is pendingTransactionsTotal minus pendingPostingsTotal and " +
      "`matchedDiscrepancy` is matchedTransactionsTotal minus matchedPostingsTotal — both compare the two " +
      "sides WITHIN one bucket of the month's activity. Neither looks at a balance. The response ships " +
      "`actualBankMonthStartBalance` and `bankLedgerOpeningBalance` as separate fields, so an opening gap is " +
      "a representable state, and it passes straight through to the closing balances while both discrepancy " +
      "fields stay 0.\n\n" +
      "DO NOT DO THIS ARITHMETIC BY HAND. `reai_get_bank_reconciliation` computes it and puts the result on " +
      "a \"Bank vs books:\" line above the data, and `reai_reconcile_ui` says the same thing in its note. " +
      "It compares `actualBankDisplayedBalance` against `bankLedgerClosingBalance`, refuses when the two " +
      "currencies differ, says UNKNOWN rather than \"matches\" when a balance is absent, and splits the gap " +
      "into what was carried in and what changed this month. An earlier version of this note told you to " +
      "compare the balances yourself and then use the discrepancy fields to tell carried-in from arisen — " +
      "which is the same error twice over, since those fields only ever see this month's activity. It is " +
      "`actualBankMonthStartBalance` against `bankLedgerOpeningBalance` that separates the two, and the " +
      "tool already does it.\n\n" +
      "Every month reachable on " +
      "2634 has the two openings equal (0/0 for July, 554.31/554.31 for August), so this comes from what " +
      "the fields are, not from a divergence anyone here could observe.\n\n" +
      "For the CURRENT month a gap between the ledger and the feed is expected rather than a fault — August " +
      "shows 1002.36 against 1039.70 because the feed has movements not yet booked. `actualBankCurrentMonth` " +
      "is true exactly then, so it is the flag that tells you a difference is not yet a problem.",
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
    id: "some-spec-paths-are-web-routes-not-api",
    // /vat/search is keyed here as well as named in the note. Quirks match declared paths EXACTLY, so an agent
    // describing GET /vat/search got no warning while a sibling note said the route returns a login redirect —
    // the information existed and did not reach the call that needed it.
    paths: ["/vat-return/altinn-sync", "/vat/search", "/amelding/{id}/feedback-raw"],
    methods: ["GET"],
    kind: "gotcha",
    note:
      "These are the WEB APPLICATION's own routes, not API endpoints, and an API token cannot call them. " +
      "Measured 2026-08-11: both answer 302 with " +
      "location: https://app.reai.no/auth/login?redirect=… — they want a browser session cookie, so the token " +
      "this server holds does not authenticate them at all. Nothing is returned to parse.\n\n" +
      "They matter because they surface in search. `reai_search_endpoints` ranked /vat-return/altinn-sync third " +
      "for \"vat position for the term\" — the one question with no read endpoint at all, so an agent is most " +
      "likely to reach for it exactly there. See vat-position-has-no-read-endpoint for what does answer it.\n\n" +
      "Do NOT generalise this to every path outside /api/. Measured: /kassasystem/mobile/terminal answers 405 " +
      "on a GET, so it is a real API route that simply does not take one, while /invoice/payment/{id}/company-bank, " +
      "/payments/{id}/payment-date, /lead/{id}/owner and /product/filter-search all answer 302 on a GET. That " +
      "makes the namespace MIXED and a prefix rule wrong. The four 302s are only evidence about GET: whether " +
      "their POST is reachable with a token is unverified, because probing it means making a real " +
      "payment-routing or lead-ownership call.",
  },
  {
    id: "vat-position-has-no-read-endpoint",
    paths: ["/api/vat-returns", "/api/vat-returns/complete-manually", "/api/vat-returns/reopen"],
    kind: "workflow",
    note:
      "There is NO endpoint that reads a VAT return or a VAT position. Every route here is a POST, and " +
      "GET /api/vat-returns does not exist — measured 2026-08-11, it answers " +
      "405 \"Method 'GET' is not supported.\" The two GET routes the spec lists under VAT, " +
      "/vat-return/altinn-sync and /vat/search, are not JSON APIs: both answer 302, they are the web UI's own " +
      "routes. So an agent asked \"what is our VAT for this term\" will find only a tool that FILES one, which " +
      "is irreversible and hidden unless the write mode allows it.\n\n" +
      "The answer is derived from the ledger instead. Every posting carries a `vatCode`, and " +
      "GET /api/ledger/general accepts `vatCode` as a filter — measured on 2634: vatCode=0 returns all 160 " +
      "postings, vatCode=1 returns none, so the filter discriminates rather than being ignored. " +
      "GET /api/vat-codes gives each code its `rate` and a `vatType`. The schema declares FIVE: input_vat, " +
      "output_vat, exempt, outside_scope and reverse_charge. Summing per output_vat and per input_vat code " +
      "and taking the difference is the position for an ordinary tenant. reverse_charge needs care, and the first " +
      "version of this note got the direction wrong.\n\n" +
      "Norwegian reverse charge (snudd avregning, on imported services and some domestic trades) has the " +
      "BUYER self-account: they record the output VAT as if they had sold it, and claim input VAT as their own " +
      "deduction. Where the purchase is FULLY deductible those two are equal, so leaving the transaction out " +
      "of both sums changes both by the same amount and the difference — the liability — is unaffected. It is " +
      "net-neutral, not a missing amount.\n\n" +
      "The hazard is the opposite one: assuming full deductibility. Where the buyer can deduct only part of " +
      "the input — pro-rata for mixed taxable and exempt activity, or an expense in a non-deductible " +
      "category — the output is due in full while the deduction is limited, so the transaction does NOT " +
      "contribute equally to both sides and treating it as if it did understates what is owed. Which case a " +
      "given purchase falls in is a judgement about the tenant's activity that this server cannot make. If " +
      "reverse_charge codes appear in a period, say so and ask, rather than defaulting either way.\n\n" +
      "Only four types appear on 2634 (8 input_vat, 5 output_vat, 1 exempt, 1 outside_scope), so none of this " +
      "has been observed live. The four must NOT be read as the whole set: a tenant importing services will " +
      "have the fifth, and measurement on this tenant would have confirmed an incomplete list forever.\n\n" +
      "What is NOT verified, stated because it matters: neither tenant available for measurement has any VAT " +
      "activity at all — every posting on 2634 carries vatCode 0 and there are no 27xx accounts — so the " +
      "derivation above is verified as far as the filter reaching the API and discriminating, and no further. " +
      "The arithmetic of a real term has not been checked against a real return.",
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
      "The `include` parameter is the only array query parameter on the surface this server EXPOSES " +
      "(three internal /account/search* operations also take one, with the opposite serialization) and uses " +
      "style=form, explode=false — i.e. ?include=summary,pending_postings, comma-joined rather than " +
      "a repeated key. This server handles that for you.",
  },
  {
    id: "share-investment-event-posts-a-voucher",
    paths: ["/api/share-investments/{id}/events"],
    methods: ["POST"],
    kind: "irreversible",
    note:
      "This POSTS TO THE LEDGER. Creating the investment itself posts nothing — measured, the voucher " +
      "count was 0 before and 0 after — but an EVENT books a voucher in its own SH series and the " +
      "response carries its `voucherId`. Measured on tenant 2783: a DIVIDEND of 1000 produced voucher " +
      '30997 "SH1-2026 Utbytte …" with postings on 1920 and 8071.\n\n' +
      "There is no DELETE for an event: the document has GET and POST on this path and nothing else. " +
      "The only undo is on the VOUCHER, and there it answers {\"outcome\":\"reversed\"} rather than " +
      '"deleted" — measured — which books two offsetting postings and leaves the original in place. The ' +
      "voucher then vanishes from GET /api/vouchers while still reading 200 by id, so a caller checking " +
      "the list concludes the posting is gone when four postings remain. Net effect on the accounts is " +
      "zero; the trace is permanent.\n\n" +
      "So an event is a real accounting entry. Get it right the first time rather than expecting to " +
      "tidy up afterwards.",
  },
  {
    // On the CREATE, with no `statuses`, because this is a success-path hazard and the moment to know is
    // BEFORE the record exists. It was first written on the DELETE, which meant the warning arrived only
    // when a caller tried to remove the position — by which time the decision that made it permanent was
    // several steps in the past. Found in review; the sequence is exactly how this repository learned it.
    id: "share-investment-opening-position-is-permanent",
    paths: ["/api/share-investments"],
    methods: ["POST"],
    kind: "irreversible",
    note:
      "An OPENING POSITION IS AN EVENT, and an event makes this record permanent. Passing " +
      "openingQuantity, openingCostAmount and openingDate silently creates a PURCHASE event — measured " +
      "on tenant 2783: event 42, quantity 100, pricePerUnit derived as 500 from 50000/100 — and a " +
      "position with any event cannot be deleted: " +
      'DELETE answers 400 "Aksjeposten har registrerte transaksjoner og kan ikke slettes." There is no ' +
      "endpoint that removes an event, so from that first event the record is there for good. Nothing in " +
      "the create response says any of this.\n\n" +
      "Clearing the opening fields afterwards does NOT undo it: measured, the PUT answered 200 and the " +
      "event stayed.\n\n" +
      "So decide here. Create the position WITHOUT an opening balance if you might need to remove it, " +
      "check it looks right, and then add the purchase as an explicit event. One share investment on the " +
      "write test tenant is unremovable because this was learned in the other order; it is renamed to say " +
      "so.",
  },
  {
    id: "share-investment-with-events-cannot-be-deleted",
    paths: ["/api/share-investments/{id}"],
    methods: ["DELETE"],
    statuses: [400],
    kind: "irreversible",
    note:
      'A 400 "Aksjeposten har registrerte transaksjoner og kan ikke slettes." means the position has ' +
      "events and the API will not remove it. There is no endpoint that removes an event either, so the " +
      "record is permanent from its first event onward and this refusal is final rather than an ordering " +
      "problem to work around.\n\n" +
      "If you did not knowingly add an event, the likely cause is an opening position: openingQuantity, " +
      "openingCostAmount and openingDate on the create silently produce a PURCHASE event. See the quirk " +
      "on POST /api/share-investments, which is where that decision gets made.",
  },
  {
    id: "share-investment-event-needs-a-settlement-account",
    paths: ["/api/share-investments/{id}/events"],
    methods: ["POST"],
    statuses: [400],
    kind: "validation",
    note:
      'A 400 "Velg verdipapirkontoen transaksjonen ble gjort opp mot." is asking for `companyBankId` — ' +
      '"choose the securities account the transaction was settled against". The document marks NOTHING ' +
      "required on this body, so nothing warns you, and the message is Norwegian. Measured: a DIVIDEND " +
      "with eventType, eventDate, amount and feeAmount was refused, and the same body with a " +
      "companyBankId answered 201.\n\n" +
      "reai_list_company_banks gives the id. A tenant with no company bank cannot record an event at all.",
  },
  {
    id: "share-investment-put-requires-more-than-the-document-says",
    paths: ["/api/share-investments/{id}"],
    methods: ["PUT"],
    kind: "shape",
    note:
      "The document says `required: [name]`. The API also requires `instrumentType`: measured, " +
      'PUT {name} answered 400 "Validation failed" with fieldErrors[].field "instrumentType", and ' +
      "adding it answered 200.\n\n" +
      "And this PUT REPLACES. In the same measurement `ticker` went from \"ZZ\" to null because the body " +
      "omitted it. `quantity`, `costPrice` and `assetAccountNumber` survived — they are derived from the " +
      "events and from creation, not settable here — so checking one of those and concluding the record " +
      "is intact would be wrong. Send every descriptive field you want to keep: ticker, isin, " +
      "organizationNumber, withinExemptionMethod, companyBankId.",
  },
  {
    id: "loan-type-and-perspective-are-constrained-pairs",
    paths: ["/api/loans", "/api/loans/{id}"],
    methods: ["POST", "PUT"],
    statuses: [400],
    kind: "validation",
    note:
      'IF the 400 reads "Lånetypen er ikke gyldig for valgt låneperspektiv", it is this: loanType and ' +
      "perspective are not independent, and that sentence is the whole explanation the API gives for a " +
      "rule nothing documents. (This endpoint has other 400s — a principalAmount under 0.01, a " +
      "reference over 30 characters, a malformed date — and they are not this one.) Four of the six " +
      "types are direction-locked, because the name already states the direction. Measured, all twelve " +
      "combinations, on tenant 2783:\n\n" +
      "  bank_loan                 borrower only\n" +
      "  owner_loan_to_company     borrower only\n" +
      "  company_loan_to_owner     lender only\n" +
      "  company_loan_to_employee  lender only\n" +
      "  intercompany              either\n" +
      "  other                     either\n\n" +
      "The counterparty is looked up BEFORE this check, so a bad counterpartyId hides it: a wrong id " +
      "answers 404 first and the pair error only appears once the id is real.\n\n" +
      "`reference` is unique per company as well, and says so in Norwegian too: " +
      '400 "Lån med referanse X finnes allerede." reai_create_loan checks the pair locally and ' +
      "translates both.",
  },
  {
    id: "counterparty-names-are-not-unique",
    paths: ["/api/creditors", "/api/debtors"],
    methods: ["POST"],
    kind: "gotcha",
    note:
      "A duplicate NAME is accepted here. Measured on tenant 2783: two debtors called the same thing " +
      "were created as ids 19 and 20, with no complaint. So creating before listing can leave two " +
      "records nobody can tell apart, and an instruction like \"use the debtor called X\" then names no " +
      "record at all.\n\n" +
      "Worth stating because this API is INCONSISTENT about it: an employee name is unique and answers " +
      '409 "Ansatt med dette navnet finnes allerede". Both of these endpoints do document a 409 without ' +
      "saying what causes it, and nobody here has reproduced one, so a 409 should be read rather than " +
      "assumed to be a name collision.\n\n" +
      "Only creditors were left untested — the measurement above is on debtors, and the mirror is an " +
      "inference. List with GET /api/creditors or GET /api/debtors first; neither takes any parameter, " +
      "so neither can be asked to search or to include archived rows, though `Creditor` and `Debtor` both " +
      "carry an `archived` flag that the response shapes do not expose.",
  },
  {
    id: "creditor-or-debtor-referenced-by-a-loan-cannot-be-deleted",
    paths: ["/api/creditors/{id}", "/api/debtors/{id}"],
    methods: ["DELETE"],
    statuses: [409],
    kind: "workflow",
    note:
      'A 409 "Cannot delete creditor that is referenced by one or more loans" means what it says, and ' +
      "the order is the fix: delete the loans first, then the counterparty. Measured on tenant 2783 for " +
      "a creditor; a debtor is the mirror image, since a loan names exactly one of the two depending on " +
      "its perspective.\n\n" +
      "reai_list_loans shows which loans point where — read `creditorId` and `debtorId` rather than " +
      "looking for `counterpartyId`, which is the request-side name only. Deleting a loan is a real " +
      "delete (204, then 404), so this is not an archive that keeps the link alive.",
  },
  {
    id: "loan-delete-is-real-not-an-archive",
    paths: ["/api/loans/{id}"],
    methods: ["DELETE"],
    kind: "irreversible",
    note:
      "204, and the id then reads 404. A real delete: no archive, no {\"outcome\"} variant, nothing " +
      "that brings the record back, and no endpoint here recreates one with its history. Measured on " +
      "tenant 2783.\n\n" +
      "The derived ledger accounts go with it, along with `outstandingPrincipal` and " +
      "`accruedInterestBalance`. Since the API derives those accounts only at CREATION, re-recording " +
      "the loan afterwards will derive them from the new loanType and perspective rather than restore " +
      "what was there.",
  },
  {
    id: "loan-interest-accounts-are-cleared-by-omission",
    paths: ["/api/loans/{id}"],
    methods: ["PUT"],
    kind: "irreversible",
    note:
      "This PUT replaces, and the LEDGER ACCOUNTS are part of what it replaces. Omitting " +
      "interestExpenseAccountNumber and accruedInterestAccountNumber clears them — measured with " +
      "interestTreatment held constant, so it is the omission and nothing else: 8150 and 2950 both " +
      "became null. Nothing re-derives them; the API derives the accounts once, at creation, from " +
      "loanType and perspective. The loan is then self-contradictory (a treatment that posts interest, " +
      "with no account to post it to) and no response says so.\n\n" +
      "principalAccountNumber is the EXCEPTION and survives omission, which is what makes this easy to " +
      "miss: check that one field and the record looks intact.\n\n" +
      "Worth knowing what this is NOT. It was first recorded here as a consequence of switching " +
      "interestTreatment to capitalize, because that is when it was first seen. Re-measured: carrying " +
      "the accounts through a switch to capitalize keeps them, and omitting them clears them with the " +
      "treatment untouched. The treatment is irrelevant.\n\n" +
      "reai_update_loan reads the loan and merges, so it cannot cause this. Use it, or send every " +
      "account number on every PUT.",
  },
  {
    id: "expense-voucher-unlink-is-broken-upstream",
    // Both endpoints, because the note is about both: the same 409 comes back from the plain expense
    // delete, which is the operation `reai_reverse_expense` actually sends. Registering only the
    // /voucher path meant a caller inspecting the endpoint they were about to be blocked on saw
    // nothing.
    paths: ["/api/expenses/{id}/voucher", "/api/expenses/{id}"],
    methods: ["DELETE"],
    // Scoped to the status the prose explains. Without this the failed-request path treats the note as
    // universal, so a 401, 403 or a genuinely missing expense id would come back with authoritative
    // text saying the problem is a Hibernate bug and that nothing the caller changes can help --
    // sending them away from the credentials, permissions or wrong id that actually caused it.
    statuses: [409],
    kind: "gotcha",
    note:
      "BROKEN UPSTREAM as of 2026-08-08, and the 409 says so in a way no caller should have to " +
      "decode. On a freshly booked expense voucher this answers HTTP 409 " +
      "application/problem+json whose detail is a raw Java stack type: " +
      '"org.hibernate.TransientPropertyValueException: Persistent instance of ' +
      "'no.reai.ex.mdl.Expense' references an unsaved transient instance of 'no.reai.ldgr.mdl.Voucher'" +
      '". That is a server-side persistence bug on ReAI\'s side, not a validation error, so there is ' +
      "no body a caller can change to make it work. It used to work: this repository measured " +
      '{"outcome":"deleted"} and the ledger count going back down when the tool was written.\n\n' +
      "Because unbooking is impossible, everything downstream of it is too: the expense stays " +
      "approved and booked, POST /api/expenses/{id}/unapprove refuses it for being booked, and " +
      "DELETE /api/expenses/{id} -- which is the reversal, the operation reai_reverse_expense sends " +
      "-- answers the same 409. An expense booked today cannot be unwound through its own endpoints " +
      "at all. (An earlier draft of this note cited POST /api/expenses/{id}/reverse, which does not " +
      "exist in the spec. Reversal is the DELETE.)\n\n" +
      "The one route that works is DELETE /api/vouchers/{voucherId} on the voucher named by the " +
      'expense\'s voucherId, which answers {"outcome":"deleted"} — but it CASCADES. Measured twice: ' +
      "expense 2241 answered 404 immediately after voucher 30980 was deleted, and 2242 after 30984. " +
      "So it is not the unlink this endpoint promises; it destroys the expense as well. Do not reach " +
      "for it to make an expense editable again — there is nothing left to edit. It is a cleanup " +
      "instrument, and on a real company's books deleting a voucher leaves a gap in its number " +
      "series.",
  },
  {
    id: "manual-reconciliation-404-means-not-manual-not-missing",
    paths: ["/api/manual-reconciliations/{bankAccountId}"],
    methods: ["GET"],
    kind: "gotcha",
    note:
      "`month` is required, and it is validated BEFORE the account is looked up: without it you get 400 " +
      '"month is required" and learn nothing about the id. Supply month=YYYY-MM first — an earlier version ' +
      "of this note described the 404 below without mentioning that, so following it bare produced a " +
      "different error than the one it explains.\n\n" +
      'With a month supplied, a 404 "Bankkonto ikke funnet." here is AMBIGUOUS, and the obvious reading ' +
      "is the less likely one. It does occur for an id that genuinely does not exist, or belongs to " +
      "another tenant — but it also occurs for a perfectly good id that simply is not a MANUAL account. " +
      'Measured on tenant 2634: all three of its company banks are providerType "ztl" — bank-synced — and ' +
      "every one answers that 404 here while appearing normally in reai_list_company_banks, and a " +
      "plainly nonexistent id answers exactly the same thing.\n\n" +
      "So the response cannot tell you which it is, and this quirk is not licence to assume either. " +
      "Settle it with reai_list_company_banks: if the id is in that list, the 404 was about the " +
      'account not being manual, and its reconciliation lives at GET ' +
      "/api/bank-reconciliations/{bankAccountId} (reai_get_bank_reconciliation). If the id is not in " +
      "the list, the id really is wrong. Reading providerType first avoids the question entirely.",
  },
  {
    id: "invoice-email-is-cleared-by-an-empty-string-not-by-null",
    paths: ["/api/customers/{id}"],
    methods: ["PATCH"],
    kind: "gotcha",
    note:
      "To remove a customer's invoice email, send an EMPTY STRING. Measured on tenant 2783, seeding " +
      'an address and sending each form: `invoiceEmail: ""` cleared it, `invoiceEmail: null` was a ' +
      'no-op that left the address in place, and `invoiceEmail: " "` answered 400 "Validation ' +
      'failed". Omitting the field keeps it, since PATCH really does patch here. The null behaviour ' +
      'is the documented one — the schema says "Omit or null to leave unchanged" — so the surprise ' +
      "is the other half: the value that empties a billing address is the one that looks like a " +
      'typo. Worth knowing that `""` is also the schema\'s declared DEFAULT for this field, so a ' +
      "client that fills defaults in rather than omitting them clears the address without meaning " +
      "to. Either way this server treats naming the field with an empty value as intent to change " +
      "delivery and asks for REAI_WRITE_MODE=full, exactly as setting a new address does: the " +
      "address someone deliberately chose stops receiving invoices, and nobody finds out until one " +
      "is issued. Where they go instead is not something this server has measured.",
  },
  {
    id: "lead-patch-cannot-clear-a-field-only-the-put-setters-can",
    paths: ["/api/leads/{id}", "/api/leads/org/{orgNumber}"],
    methods: ["PATCH"],
    kind: "gotcha",
    note:
      "PATCH on a lead can only SET. Null means 'leave unchanged', which the schema does say — " +
      "measured, `{notes: null, email: null, phone: null, followUpAt: null}` against a lead holding " +
      "all four returned 200 and changed nothing. Clearing goes through the setters instead, where " +
      "null does clear: PUT .../notes, PUT .../follow-up, PUT .../contact. So the same null is a " +
      "no-op on one endpoint and a delete on another, and the general-looking one is the no-op. " +
      "reai_update_lead hides this: omit to keep, null to clear, whichever endpoint that takes.",
  },
  {
    id: "lead-status-cannot-be-unset-once-set",
    paths: ["/api/leads/{id}/status", "/api/leads/org/{orgNumber}/status"],
    methods: ["PUT"],
    kind: "gotcha",
    note:
      "A lead status cannot be returned to null, and the spec says otherwise: PatchLeadReq.status " +
      "documents \"To clear an existing status use PUT /status with explicit null\". Measured, that " +
      'answers 400 "Validation failed" and the status stays as it was. The only moves are active ↔ ' +
      "disqualified, or DELETE the lead and lose everything else on it. `converted` is refused here " +
      "too (400 listing the allowed values) — it is produced by POST /api/leads/{id}/convert.",
  },
  {
    id: "lead-rows-are-created-by-the-first-write-except-contact",
    paths: [
      "/api/leads",
      "/api/leads/org/{orgNumber}",
      "/api/leads/org/{orgNumber}/status",
      "/api/leads/org/{orgNumber}/notes",
      "/api/leads/org/{orgNumber}/follow-up",
      "/api/leads/org/{orgNumber}/contact",
      "/api/leads/org/{orgNumber}/contact-events",
    ],
    methods: ["POST", "PUT", "PATCH"],
    kind: "gotcha",
    note:
      "A lead search returns REGISTER companies, most with lead.id null, and the row is created by " +
      "the first write to it — measured, PATCH, PUT /status, PUT /notes, PUT /follow-up and " +
      "POST /contact-events each turned a null id into a real one. `PUT .../contact` is the " +
      "exception and the dangerous one: against an unsaved company it answers 200 and leaves the id " +
      "null, so the email and phone are accepted and stored nowhere. POST /api/leads first, which " +
      "is what reai_update_lead does before any write to an unsaved company.",
  },
  {
    id: "lead-contact-put-needs-both-fields-in-the-body",
    paths: ["/api/leads/{id}/contact", "/api/leads/org/{orgNumber}/contact"],
    methods: ["PUT"],
    kind: "gotcha",
    note:
      "Send email AND phone every time, even to change one of them. A body carrying only one of the " +
      "two did not behave consistently: on a lead holding both, `{phone: null}` on its own was a " +
      "complete no-op in 4 of 4 trials — re-read after four seconds, with the phone it named still " +
      "in place — while the same body sent straight after PUT .../notes and PUT .../follow-up " +
      "behaved as a full replacement and cleared the omitted email. Nothing in the request " +
      "accounted for the difference. With both fields present the outcome is unambiguous either " +
      "way, so read the lead first and carry over what you are not changing. reai_update_lead does " +
      "this for you.",
  },
  {
    id: "lead-convert-is-addressable-by-id-only",
    paths: ["/api/leads/{id}/convert"],
    methods: ["POST"],
    kind: "gotcha",
    note:
      "Every other lead endpoint has an /org/{orgNumber} twin; convert does not, and the org form " +
      'answers 404 "No static resource". An unsaved company has no id, so it cannot be converted ' +
      "at all until POST /api/leads gives it one — reai_convert_lead does that first. Converting " +
      "is also safe to repeat: measured, a second call returned 200 without creating a second " +
      "customer, and converting a FRESH lead for an org that already has a customer likewise added " +
      "none. The response body is the company record, not the customer, so the new customer id has " +
      "to be read back from the lead's convertedCustomerId.",
  },
  {
    id: "attachments-listed-per-owner-not-globally",
    // Keyed to the POST, because the registry's own guard refuses a quirk whose operation does not exist — and
    // the GET on this collection is precisely the one that does not.
    paths: ["/api/attachments"],
    methods: ["POST"],
    kind: "workflow",
    note:
      "There is no GLOBAL attachment list — measured, GET /api/attachments answers 405 Method Not Allowed, " +
      "because only POST exists on this collection. But attachments ARE enumerable per owner, and that is " +
      "where ids come from: GET /api/orders/{id}/attachments and GET /api/supplier-invoices/{id}/attachments " +
      "both return arrays of AttachmentRes. Measured on 2634, supplier invoice 5830 returned one " +
      "(faktura_2026_10009.pdf, 1.7 MB).\n\n" +
      "Two differences between the two routes are worth knowing. The scoped list leaves `usedBy` NULL, while " +
      "GET /api/attachments/{id} fills it in — the same attachment read by id came back with " +
      '`[{"ownerType":"SUPPLIER_INVOICE","ownerId":5830}]` — so to learn what else references a file you must ' +
      "fetch it by id. And `contentUrl` on the scoped row points at the OWNER path " +
      "(/api/supplier-invoices/5830/attachments/19780/content), not at /api/attachments/{id}/content.\n\n" +
      "Also measured: GET /api/attachments/0 answers 400 because the id must be positive, while a " +
      "valid-but-absent id answers 404, so those two mean different things. And the /ehf parse endpoint " +
      'answers 400 "Attachment is not a valid EHF XML" on a PDF rather than returning an empty document.',
  },
  {
    id: "paging-parameters-are-ignored-not-refused",
    paths: ["/api/postings"],
    methods: ["GET"],
    kind: "gotcha",
    note:
      "This endpoint takes no paging parameter, and sending one anyway is NOT an error. Measured on tenant 2634 " +
      "against 160 postings: limit=5, page=2 and size=5 each returned all 160 rows with a 200 and no complaint. " +
      "So a caller who adds one believes it narrowed a result it did not narrow — the dangerous direction, " +
      "because nothing signals the mistake. Narrow with the filters the endpoint documents (accountNumber, " +
      "voucherId, customerId, supplierId, projectId, employeeId, companyBankId), which do work and combine as " +
      "AND. Of the 78 distinct GET endpoints this server curates, 76 declare no paging parameter at all — the " +
      "two that do are /api/chart-of-accounts/accounts (limit) and /api/leads (page, pageSize), and both HONOUR " +
      "it. So paging is absent here and on nearly everything else, but it is not absent everywhere: check " +
      "whether the tool you are using takes it as an argument.",
  },
  {
    id: "attaching-a-file-differs-by-owner",
    paths: [
      "/api/orders/{id}/attachments",
      "/api/supplier-invoices/{id}/attachments",
      // The LINK route an agent is sent to, and the UPLOAD route it is told to use first. Review found both
      // missing: `quirksFor` is exact-match, so an agent that followed this note to `/existing` and asked
      // reai_describe_endpoint about it saw nothing at all.
      "/api/supplier-invoices/{id}/attachments/existing",
      "/api/attachments",
    ],
    methods: ["POST"],
    kind: "workflow",
    note:
      "The two owners do NOT take a file the same way, and the same JSON body lives at a different path for " +
      "each. Measured on tenant 2783 on 2026-08-10, every probe failing so nothing was created.\n\n" +
      "An ORDER only LINKS an attachment that already exists. POST /api/orders/{id}/attachments takes " +
      'application/json — {"attachmentId": N} — and a bad id answers 404 "Attachment not found", which is the ' +
      "proof it parsed the body and looked the attachment up. A multipart body there answers 415 Unsupported " +
      "Media Type, and a MALFORMED one answers 400 \"Failed to parse multipart request\" instead.\n\n" +
      "A SUPPLIER INVOICE is multipart-only on its plain route: POST " +
      "/api/supplier-invoices/{id}/attachments answers 415 to application/json. Its LINK route is a different " +
      "path — .../attachments/existing — with the same JSON body an order takes at its plain /attachments. So " +
      "the two owners wire the same two capabilities to opposite paths, and an agent that learns one and " +
      "applies it to the other gets a 415 or a 404 rather than a hint.\n\n" +
      "The order of checks is CONTENT TYPE, then owner, then attachment id. Measured: a nonexistent order with " +
      "a valid multipart body answers 415, not the owner's 404 — so a 415 tells you nothing about whether the " +
      "record exists. With a valid JSON body the same nonexistent order answers 404 naming it.\n\n" +
      "The 415 detail echoes the Content-Type header back INCLUDING its boundary and charset, so it differs on " +
      "every request and is not a string to match on. Match the status, not the message.\n\n" +
      "The two upload routes also sit at different WRITE TIERS, which matters before the multipart problem " +
      "below is even reached: POST /api/supplier-invoices/{id}/attachments is classified irreversible and is " +
      "therefore refused at the default REAI_WRITE_MODE=reversible, while POST /api/attachments and the two " +
      "link routes are reversible.\n\n" +
      "TWO THINGS THIS SERVER CANNOT DO, so plan around them rather than retrying. It never constructs a " +
      "multipart body — reai_request transports its `body` as JSON — so neither upload route is reachable " +
      "through it at all; the upload belongs in the ReAI web UI or another client. And an attachment, once " +
      "uploaded, has NO delete route: /api/attachments/{id} is GET and PATCH only, and only orders and " +
      "vouchers have an unlink route. A supplier invoice has none, so a file attached to one cannot be " +
      "detached through the API either.",
  },
  {
    id: "lead-sub-resources-need-a-saved-lead-in-the-id-form",
    paths: [
      // The five sub-resources...
      "/api/leads/{id}/contact",
      "/api/leads/{id}/contact-events",
      "/api/leads/{id}/follow-up",
      "/api/leads/{id}/notes",
      "/api/leads/{id}/status",
      // ...and the record itself. PATCH and DELETE carry the identical trap — measured 2026-08-10, both answer
      // 404 "CRM lead with id=99999999 not found" on a valid-but-absent id. DELETE had no quirk at all before
      // this. PATCH already has one (lead-patch-cannot-clear-a-field-only-the-put-setters-can); two notes on one
      // call is fine when they say DIFFERENT things — that one is about clearing fields, this one about
      // addressing. The duplicate-quirk mistake made with /api/projects was two notes saying the same thing.
      // GET /api/leads/{id} is deliberately absent: lead-detail-nests-what-the-search-flattens is keyed there
      // and the addressing advice already lives in that family's prose.
      "/api/leads/{id}",
      // NOT /convert. `lead-convert-is-addressable-by-id-only` already covers it, and says more: that the org
      // form answers 404 "No static resource" and that converting twice is safe.
    ],
    // These are the calls that WRITE, so the methods are named rather than left to match everything: a GET on
    // the same paths is a different question and has its own notes.
    methods: ["POST", "PUT", "PATCH", "DELETE"],
    kind: "workflow",
    note:
      "Every one of these has an /api/leads/org/{orgNumber} twin, and the org form is the one to use — with " +
      "ONE exception that has to come first, because taking the advice literally there is worse than the " +
      "error it replaces. On /contact, the org twin does NOT create the row: measured 2026-08-10 on 2783, " +
      "PUT /api/leads/org/{orgNumber}/contact against a company with no lead row answers 200, echoes the " +
      "company back, and stores neither email nor phone. So for contact details, create the lead FIRST " +
      "(POST /api/leads, or reai_save_lead) and then set them — reai_update_lead already does exactly " +
      "that, in that order, for this reason. For every other field the org form is safe to write " +
      "directly, because the first write creates the row " +
      "(lead-rows-are-created-by-the-first-write-except-contact).\n\n" +
      "A row from GET /api/leads carries `id: null` for any company nobody on this tenant has touched — which " +
      "is not the exception but the rule, because the search covers the Norwegian company register rather than " +
      "the tenant's own records: measured 2026-08-10, 250 of 250 distinct rows on 2783 AND 250 of 250 on 2634 " +
      "came back with id: null. Substituting that null gives 400 \"Failed to convert 'id' with value: 'null'\" " +
      "on /contact, /contact-events, /follow-up, /notes and /status alike, and on PATCH and DELETE of the " +
      "record. A numerically valid but absent id is a DIFFERENT failure — 404 \"CRM lead with id=99999999 not " +
      "found\" — so the two say different things: the first means you have no lead yet, the second means you " +
      "have the wrong one.\n\n" +
      "(One wrinkle on PATCH: it validates the BODY before the id, so an unrecognised field answers 400 " +
      "\"Unknown field: <name>\" even when the id is also absent. Send a documented field — status, notes, " +
      "email, phone, followUpAt — before concluding anything about the id.)\n\n" +
      "What makes the org form the right default is that an organisation number is on every row whether the " +
      "company is saved or not, so it can address a company that has no id yet — which the id form, by " +
      "construction, cannot.\n\n" +
      "That is why NO curated lead tool on this server is addressed by lead id: 6 of the 7 take `orgNumber`, " +
      "and the seventh is reai_search_leads, which is the search that produces the rows. reai_convert_lead " +
      "takes an orgNumber too and resolves the id itself, because /convert is the exception in the other " +
      "direction — id-only, so it needs a saved lead first. It has its own note: " +
      "lead-convert-is-addressable-by-id-only.",
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
