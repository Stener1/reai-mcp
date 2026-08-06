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
  kind: QuirkKind;
  note: string;
};

export const QUIRKS: readonly Quirk[] = [
  // --- Cross-cutting -------------------------------------------------------
  // Note: quirks true of the whole API (tenant scoping, deep links needing
  // ?tenantId) deliberately live in the server instructions instead. Attached
  // here they would match all 313 operations and drown the endpoint-specific
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
    note:
      "startDate and endDate are required, even where the schema does not mark them so. Omitting " +
      'them returns 400 "startDate is required".',
  },
  {
    id: "timesheets-need-project-module",
    paths: ["/api/timesheets"],
    methods: ["GET"],
    kind: "gotcha",
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
      "Only possible while the period is open and no posting is locked. Postings report canDelete " +
      "and lockReasons — check those first. In a closed period the remedy is a reversing voucher.",
  },

  {
    id: "leads-paginated-object",
    paths: ["/api/leads"],
    methods: ["GET"],
    kind: "shape",
    note:
      "The ONLY paginated collection in this API, and the only one that does not return a bare " +
      "array. The response is an object: { items, page, hasPrevious, hasNext, latestRegisteredAt }, " +
      "50 rows per page — so iterating the response directly, or reading .length, yields nothing. " +
      "Rows also carry \"id\": null, because these are Brønnøysund register entries rather than " +
      "stored records; there is no local id to fetch one by.",
  },
  {
    id: "warehouse-inventory-object",
    paths: ["/api/warehouses/inventory"],
    methods: ["GET"],
    kind: "shape",
    note:
      "Returns an object, not an array: { warehouseId, rows, totalStockValue, totalRetailValue }. " +
      "The stock lines are under `rows`, and the two totals are already computed — do not sum rows " +
      "to get stock value, it is there.",
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
      'Order, offer and subscription lines accept only the VAT codes from GET ' +
      '/api/vat-codes?usage=customer-invoice — a purchase-side code is rejected.',
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
    note:
      'Phone numbers are validated and a "+47" prefix on a Norwegian number is REJECTED — ' +
      '400 "Skriv inn et gyldig telefonnummer. Norske nummer kan skrives uten +". Send "22334455".',
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
    id: "delete-may-archive",
    paths: ["/api/customers/{id}", "/api/suppliers/{id}", "/api/departments/{id}", "/api/documents/{id}"],
    methods: ["DELETE"],
    kind: "gotcha",
    note:
      "DELETE archives instead of deleting when the record already has transactions, preserving the " +
      'audit trail. The response says which happened (outcome: "deleted" | "archived"). Customers ' +
      "can be unarchived with POST /api/customers/{id}/unarchive.",
  },

  // --- Subscriptions -------------------------------------------------------
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
    id: "cost-line-explicit-accounts",
    paths: [
      "/api/supplier-invoices",
      "/api/supplier-invoices/{id}",
      "/api/invoice-reception-documents/{id}/supplier-invoice",
      "/api/receipt-reception-documents/{id}/registration",
    ],
    methods: ["POST", "PATCH"],
    kind: "shape",
    note:
      "Cost lines do NOT use the voucher sign convention. Each line names debitAccount and " +
      "creditAccount explicitly, and the sign of `amount` encodes DOCUMENT TYPE: at least 0.01 on " +
      "an invoice, at most -0.01 on a credit note.",
  },
  {
    id: "supplier-invoice-reverses",
    paths: ["/api/supplier-invoices/{id}"],
    methods: ["DELETE"],
    kind: "irreversible",
    note:
      "DELETE on a registered supplier invoice is only cleanly reversible while its period is " +
      "open. Verified on live books: deleting a same-day invoice in an open period removed it " +
      "and its postings entirely, leaving nothing behind. Once the period is closed, bokføringsloven " +
      "does not allow that, and the delete becomes a counter-posting that leaves the original in " +
      "the audit trail. Treat it as irreversible unless you know the period is open.",
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
      "Which VAT codes are valid depends on the tenant's VAT registration, so look them up rather " +
      "than assuming. Pass usage=customer-invoice for the subset valid on invoice, order, offer and " +
      "subscription lines.",
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
