# API quirks worth knowing

An accounting API has more sharp edges than its schema admits, and most of what follows was learned
from a rejected request rather than from reading the spec. Rather than leave that knowledge in commit
messages, it lives in [`src/reai/quirks.ts`](../src/reai/quirks.ts) as **122 quirks keyed to the
operations they affect** — so they surface automatically in `reai_describe_endpoint` and
`reai_search_endpoints`, including for the 143 public operations no curated tool covers.

Browse them from an agent with `reai_api_notes`, or read the highlights below.

**Shapes that aren't what the name suggests**
- **An invoice is created from an ORDER, not from line items.** `POST /api/invoices` takes an `orderId`. There is no endpoint that builds an invoice from lines — the order carries them.
- **There is no endpoint that lists bank transactions.** Only get-by-id. Transactions are visible solely through the reconciliation view for one account and one month, which makes that view the entry point for all bank work.
- **Voucher postings and supplier-invoice cost lines use different conventions.** A voucher posting is one *signed* amount (positive debits, negative credits, summing to zero). A cost line names debit and credit accounts explicitly, and its sign encodes *document type* — positive on an invoice, negative on a credit note.
- **`POST /api/vat-returns` takes `year` and `period` as query parameters**, not a body.

**Constraints the schema omits**
- **Voucher postings sharing a `rowNumber` are merged into one row**, so they must agree on the row's fields — notably `description`. An omitted `rowNumber` puts everything in row 0, so two postings with different descriptions fail with an error that blames the *sign convention*. `reai_create_voucher` assigns rows for you.
- `startDate`/`endDate` are required on vouchers, postings and ledgers even where not marked so.
- **Offer lines are stricter than order lines** — `itemName` and `vatCode` are both required on an offer.
- **Order** and subscription lines accept only VAT codes from `?usage=customer-invoice`; **offer** lines are not checked against it, so an offer can be accepted carrying a code that fails once the work becomes an order or invoice.
- A phone number is parsed with Norway as the default region and stored canonicalised to E.164 — a `+47` prefix is **accepted**, and a bare number that is valid in Norway is stored under `+47` whatever was meant. This list previously said a `+47` prefix was rejected; measured false.
- `POST /api/customers` silently discards `invoiceEmail`, `phone` and `daysUntilDue` — those live on the `PATCH`.
- **`GET /api/timesheets` is unusable without the Project module** — `projectId` is a *required* query parameter, and supplying it returns `400 "projectId cannot be used when the Project module is disabled"`. Required and rejected at once, so no request succeeds.

**Collections that are not arrays**
- **The lead endpoints return a page object**, not the bare array nearly every other collection does — so iterating the response or reading `.length` gets you nothing. `/api/leads` gives `{ items, page, hasPrevious, hasNext, … }` with `pageSize` 1–200 (default 50); `/api/leads/person-profiles` gives `{ items, hasMore, nextStartOrgNo, limit }` and pages by `nextStartOrgNo` instead of by number.
- A lead row's `id` is null only while it is **unsaved** (a live Brønnøysund entry). Saved leads have ids, and they are the key to `GET`/`PATCH /api/leads/{id}` and `…/convert` — keep them rather than discarding them.
- **`/api/warehouses/inventory`** returns `{ warehouseId, rows, totalStockValue, totalRetailValue }`. The totals are already computed; do not sum `rows`.

**Empty states that look like errors**
- **A 404 from `/api/opening-balances` or `/api/annual-accounts/{year}` means "nothing set up yet"**, which is the normal state for most companies — not a wrong path. The `detail` says as much; report it as empty instead of hunting for another endpoint.
- Payroll lives under **`/api/salary-payments`**; `/api/salaries` does not exist. A new run **already contains wage lines derived from expense postings** — read it back before adding any, because `…/wage-specs` adds a *manual* line and re-entering existing ones inflates salary and expenses, and expense-derived lines cannot be edited or deleted to fix it. `…/{id}/complete` starts A-melding submission to Skatteetaten, so it counts as an external send.

**Things harder to undo than they look**
- **Settling a VAT period locks it but files nothing.** There is no submission endpoint in the public API; `/complete-manually` exists to record that a return was filed elsewhere. Never report a VAT return as submitted.
- `period` is a **term index, not a month**: 1 = Jan–Feb … 6 = Nov–Dec. Passing `4` for April locks Jul–Aug.
- An **issued invoice cannot be deleted** — credit it.
- `sendEhf: true` on an order **arms Peppol transmission** to a real counterparty at invoicing time.
- A subscription with `outputMode: "create_invoice"` and `automaticBillingGeneration: true` **issues invoices on a schedule with no further call**.
- `DELETE` on a supplier invoice **reverses** it rather than removing it.

**Surprises**
- **`X-Tenant-Id` is ignored when a token reaches only one company.** Verified live: every tenant id returns that one company's data — including an id that does not exist, and one belonging to another user. Data stays isolated *between users*, so this is not a leak; but **a 200 is not evidence you reached the tenant you asked for.** Treat `GET /api/me` as the only authority on what a token can reach.
- **`/api/me` can under-report.** A company can exist in the ReAI UI while `/api/me` omits it — seen with one added but not finished onboarding. Combined with the point above this is a trap: probing it returns 200 with the *wrong* company's data, which looks like success.
- ReAI **title-cases stored names**, so a round-trip is not byte-equal.
- `DELETE` **archives instead of deleting** when a record has transactions; the response says which.
- A **403 is often a disabled module**, not a permissions problem — read the `detail`.
- `apply-rules` is a **background job** returning `started` or `already_running`; the work isn't done when the call returns.
- Two reconciliation views exist: synced accounts use `/api/bank-reconciliations/{id}`, accounts with `providerType: "manual"` use `/api/manual-reconciliations/{id}`.

**Conventions that are simply true everywhere**
- Dates are ISO `yyyy-MM-dd`; reconciliation months are `yyyy-MM`.
- Account numbers and VAT codes are **tenant-specific** — look them up, never assume.
- `daysUntilDue` is mandatory on orders and offers, so the API can never apply the customer's own terms by itself. The curated tools read the customer's terms for you and report which source they used.
- Deep links need the tenant: `https://app.reai.no/vouchers/123?tenantId=2634`. The tools return these already formed.

## Two posting fields that are not optional, whatever they are called

`reai_create_voucher` has always accepted `subAccountId` and `companyBankId`, described as "Optional general sub-account id" and "Link the posting to a company bank account". Measured, both are **conditionally mandatory**, and the API's refusal is a bare Norwegian `400` naming only the line:

```
POST /api/vouchers  → 400 "Linje 1: Konto 1320 må posteres med underkonto."
POST /api/vouchers  → 400 "Linje 1: Konto 1920 må posteres med bankkonto."
```

An account that has **any** sub-account requires one on every posting — even when the only one is called `Default`, which is the case on most of them. So the field was documented as optional precisely for the accounts where leaving it out cannot work, and there was no tool to discover a valid id with.

`reai_create_voucher` now reads the sub-account list once, before sending, and refuses with the actual choices:

```
Nothing was sent. 1 posting(s) are on an account that requires a general sub-account (underkonto),
and none was given:

  line 1, account 1320 → subAccountId 6231 (Default)
```

A failed lookup does **not** block the write. This document has understated requirements before, and refusing a voucher because a helper read failed would be the check doing harm — the API stays the authority, and its `400` is enriched by the quirk registry either way. The bank rule is documented rather than pre-checked, because nothing in the company-bank response says which ledger account each bank belongs to, so which accounts demand it cannot be established locally.

Sub-accounts are also **permanent**: `DELETE /api/general-sub-accounts/{id}` answers `405`, and `PUT` accepts only `name` (`accountNumber` answers `400 "Unknown field: accountNumber"`), so one cannot be removed or moved. Adding the *first* sub-account to an account changes that account's rules for everyone posting to it, and `reai_create_sub_account` says so when that is what you are about to do.

Where a curated tool exists, it enforces what it can locally so you get an explanation instead of a `400`: `reai_create_voucher` checks the debit/credit balance and reports the exact imbalance, `reai_create_supplier_invoice` checks cost-line signs against the document type, and `reai_apply_reconciliation_rules` refuses to run without a bounded period.

A test asserts every quirk still matches a real operation in the spec, so they can't quietly rot as the API changes.
