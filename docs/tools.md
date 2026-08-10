# Tools: every tool, and what each domain actually does

Two things live on this page. First, **every tool this server registers**, with its purpose and its
risk classification — the tables the README used to carry. Second, per domain, what could only be
learned by driving that domain against a live tenant: the state machines that do not say what state
they are in, the fields that replace when they look like they patch, and the `200`s that mean nothing
happened.

The **Risk** column is what `REAI_WRITE_MODE` gates, so it is the column to read before running
anything: `read` works in every mode, `reversible` in the default `reversible` mode and above,
`irreversible` only in `full`. A few rows also need `REAI_ALLOW_EXTERNAL_SEND`, and say so. Both
switches, and why they are two rather than one, are in
[the README](../README.md#safety-this-writes-to-real-accounting-books) and
[docs/safety.md](safety.md).

Nothing here was read off the OpenAPI document and believed. ReAI has no sandbox, so every
measurement was taken against live books — which is also why the spec being wrong is a recurring
theme rather than an aside.

Anything not listed — projects, timesheets, documents — is reachable through
`reai_search_endpoints` + `reai_request`, and carries its known quirks automatically. Share
investments used to be in that sentence and now has [a toolset of its own](#share-investments).

## Orientation
| Tool | Purpose |
|---|---|
| `reai_whoami` | Authenticated user, accessible tenants, active tenant, current write policy |
| `reai_use_tenant` | Select the active company for this session |

`reai_whoami` reports what it can actually tell — that the token reaches one company or several — without guessing which kind it is, because `GET /api/me` has no field that distinguishes a tenant-scoped token from a user-scoped one belonging to a user with a single company. It also warns when the companies do not share a currency, and says to read the currency on each record rather than assume the company's: an invoice total is in the *invoice's* currency, which can differ again.

On a [bound remote connection](self-hosting.md#one-tenant-per-authorization) `reai_whoami` lists only the bound company, and says the others exist without naming them.

## Discovery — the escape hatch
| Tool | Purpose |
|---|---|
| `reai_list_api_tags` | All 52 API domains with operation counts — a map of what the system can do |
| `reai_search_endpoints` | Keyword search across all 321 public operations |
| `reai_describe_endpoint` | Full schema for one endpoint, nested objects resolved — **with known quirks first** |
| `reai_api_notes` | Browse the known API quirks (see [docs/api-quirks.md](api-quirks.md)) |
| `reai_request` | Call any endpoint. Auth and tenant handled; writes are policy-checked |

## Bookkeeping
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_accounts` | Search the chart of accounts (*kontoplan*) | read |
| `reai_list_vat_codes` | VAT (*mva*) codes with rates — tenant-specific, so look them up | read |
| `reai_list_vouchers` | Vouchers (*bilag*) in a date range, with postings | read |
| `reai_get_voucher` | One voucher with postings and attachments | read |
| `reai_list_postings` | Ledger postings, filterable; reports `canDelete` and `lockReasons` | read |
| `reai_general_ledger` | Hovedbok: per-account opening balance, postings, closing balance | read |
| `reai_create_voucher` | Book a voucher; balance validated locally first, and postings to an account that requires a **sub-account** are refused with the choices named | **irreversible** |
| `reai_list_sub_accounts` · `reai_sub_accounts_for_account` | General sub-accounts (*underkonti*) — the named parts a ledger account is split into, and where `subAccountId` comes from | read |
| `reai_create_sub_account` · `reai_rename_sub_account` | Add a part to an account, or rename one. Creating cannot be undone — there is no `DELETE` | **irreversible** / reversible |
| `reai_delete_voucher` | Delete a voucher, if the period is still open | **irreversible** |

`subAccountId` and `companyBankId` are documented as optional and are in fact conditionally mandatory — an account with *any* general sub-account requires one on every posting, even when the only one is called `Default`. `reai_create_voucher` reads the list before sending and refuses with the valid ids named: [docs/api-quirks.md](api-quirks.md#two-posting-fields-that-are-not-optional-whatever-they-are-called).

## Sales
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_customers` · `reai_get_customer` | Find and read customers (*kunder*) | read |
| `reai_customer_ledger` | Kundereskontro — who owes what; `isOpenPosting` answers "who owes us money" | read |
| `reai_list_products` | Products and their variants; order lines reference a `variantId` | read |
| `reai_list_orders` · `reai_get_order` | Orders and their lines | read |
| `reai_update_order` | Change an order **without losing its lines** — the response and the request disagree about their shape, so a hand-rolled read-modify-write goes wrong three ways. See the note below | **irreversible** |
| `reai_list_offers` | Offers / quotes (*tilbud*) | read |
| `reai_list_invoices` · `reai_get_invoice` | Invoices and credit notes; filter `outstanding` + `overdue` | read |
| `reai_create_customer` · `reai_update_customer` · `reai_set_customer_address` · `reai_delete_customer` | Customer master data. The delete **archives** instead when the customer has transactions, and reports which of the two happened | reversible |
| `reai_unarchive_customer` | Bring an archived customer back. An archived one is invisible to the list unless you pass `archived: true` | reversible |
| `reai_list_customer_contacts` · `reai_get_customer_contact` | Named contact people on a customer, as distinct from the company's own email and phone | read |
| `reai_create_customer_contact` · `reai_update_customer_contact` · `reai_delete_customer_contact` | Contact-person master data. **Company customers only** — a private customer is refused. Phone numbers are normalised to E.164, and on the update `""` clears a field while omitting it leaves it alone | reversible |
| `reai_search_leads` | Prospecting: search the Norwegian company register (Brønnøysund) with this tenant's lead state on top — filter by legal form, industry, city, registration date, whether Brreg lists an accountant, whether an email or phone is on file | read |
| `reai_get_lead` | One company by **organisation number**, with its lead state if any | read |
| `reai_save_lead` | Start tracking a register company as a lead, with no state on it yet | reversible |
| `reai_update_lead` | Set **or clear** status, notes, email, phone, follow-up — omit to keep, null to clear, routed to whichever endpoint actually does that | reversible |
| `reai_log_lead_contact` | Record that contact happened (date, channel, short note). Sends nothing | reversible |
| `reai_convert_lead` | Convert a lead into a customer, saving it first because the endpoint is id-only | reversible |
| `reai_delete_lead` | Forget a company: status, notes, contact details and every contact event | reversible |
| `reai_create_product` · `reai_delete_product` | Create a product (no variants or price — see the tool's note); delete archives it once used | reversible |
| `reai_create_order` · `reai_delete_order` | Create an order with lines. Sends nothing to the customer; delete works until it is invoiced | reversible |
| `reai_create_offer` · `reai_delete_offer` | Create an offer. Lines require `itemName` **and** `vatCode`; an offer is a draft, so delete removes it outright | reversible |
| `reai_update_offer` | Change an offer **without losing its lines** — same response/request mismatch as orders, but everything is carryable, so it runs in the default write mode. See the note below | reversible |
| `reai_create_invoice_from_order` | Issue an invoice from an order | **irreversible** |
| `reai_credit_invoice` | Credit note — the correct way to undo an invoice | **irreversible** |
| `reai_register_invoice_payment` | Record a customer payment | **irreversible** |

### Sales: leads

**Leads are the company register, not a list of your records** — which is the thing to know before reading a result. `GET /api/leads` searches Brønnøysund and layers whatever lead state this tenant has on top: measured, every row of the default first page came back with `id: null` and `status: null`, i.e. companies nobody here has touched. `leadFilter` separates them (`all` / `saved` / `unsaved`).

Two addressing schemes exist and only one always works. An unsaved company has no id, so `GET /api/leads/null` answers `400 "Failed to convert 'id' with value: 'null'"` — the organisation number is on every row either way, which is why `reai_get_lead` takes that. And the envelope is `{items, page, hasPrevious, hasNext}` with **no total**, so "how many companies match" is not a question one call answers; the tool reports what it received and whether more exists rather than implying a figure. `pageSize` is capped at 200, above which the API answers a bare `400 "Validation failed"` naming no field, so the tool bounds it locally.

Nothing in these tools contacts anybody. Placing a call is a separate internal endpoint, already classified as an external send. `reai_log_lead_contact` *records* contact that already happened.

**Writing lead state: `null` means two opposite things depending on which endpoint you use.** `PATCH /api/leads/org/{orgNumber}` documents null as "leave unchanged" and does exactly that — measured, `{notes: null, email: null, phone: null, followUpAt: null}` against a lead holding all four returned `200` and changed nothing. The `PUT` setters (`/notes`, `/follow-up`, `/contact`) clear on the same null. So the endpoint that looks like the general update is the one that cannot clear a field, and the one that clears looks like a replacement. `reai_update_lead` presents a single rule — **omit to keep, null to clear** — and sends each field wherever that intent is honoured, then says which calls it made.

Four more, all measured on tenant 2783:

- **`PUT .../contact` needs both of its fields in the body, every time.** A single-key body does not have one behaviour: on a lead holding an email and a phone, `{phone: null}` sent on its own was a complete **no-op** — four trials out of four, re-read after four seconds, with the phone it named still in place — while the identical body sent straight after `PUT /notes` and `PUT /follow-up` behaved as a **full replacement** and cleared the omitted email. Nothing in the request accounted for the difference. `reai_update_lead` therefore reads the lead and carries over whichever field you did not mention, so the outcome is the same under either reading.
- **`PUT .../contact` answers `200` on an unsaved company and stores nothing.** Nearly every write materialises the lead row on first use — PATCH, `/status`, `/notes`, `/follow-up` and a contact event each turned `lead.id: null` into a real id. Contact left it null, so the email and phone were accepted and discarded. `reai_update_lead` saves the lead first before writing to a company nobody has touched.
- **A status cannot be unset once set**, and the spec claims otherwise: `PatchLeadReq.status` says to clear it via `PUT /status` with an explicit null, which answers `400 "Validation failed"` with the old status still in place. `active` ↔ `disqualified`, or delete the lead. Passing null is refused locally with that explanation rather than forwarded.
- **`convert` is addressable by id only** — the `/org/{orgNumber}` form answers `404 "No static resource"` — so an unsaved company cannot be converted until it has been saved. `reai_convert_lead` does that, then reads the new customer id back from the lead's `convertedCustomerId`, because the convert response body is the *company* record, not the customer. Converting twice is harmless: a repeat call, and a fresh lead for an org that already has a customer, each returned `200` without creating a second one.

Undoing a conversion has an order, and it is not the obvious one: **delete the lead first, the customer second.** Deleting the customer while the converted lead still points at it *archives* it instead, reported as `"it had transactions"` — on a customer minutes old with no ledger entry, no order and no invoice, where the lead reference is the transaction. With the lead gone, the same customer deletes outright, so nothing is permanently stuck; the wrong order just leaves an archived counterparty behind.

Deleting a lead is `destructive` in the sense that matters: contact events have **no delete of their own**, so `reai_delete_lead` is the only way to remove one and it takes the notes and every other event with it. A customer created by conversion survives — deleting the lead only forgets where it came from.

### Sales: customer contact persons

The named humans on a customer, as distinct from the customer record's own `email` and `phone`, which belong to the company. Five tools: `reai_list_customer_contacts`, `reai_get_customer_contact`, `reai_create_customer_contact`, `reai_update_customer_contact`, `reai_delete_customer_contact`.

**Where they overlap something you already have.** `reai_get_customer` returns the same array as `contactPersons`, so if you are fetching the customer anyway, you have them. The customer *list* omits it — that is the gap the list tool fills, along with fetching one contact without the customer payload around it, and being able to write them at all.

Measured on tenant 2783 on 2026-08-08, every probe record deleted afterwards.

**Company customers only.** A customer created with `privateContact: true` refuses a contact with `400 "Contact persons can only be added to company customers"`. The rule *is* in the spec, but as a sentence on `CreateCustomerReq.contactPersons` — the nested array used when creating a customer — not on this endpoint, so it is easy to miss from here. A private customer's own email and phone go on the customer record instead.

**The phone rule is not local to contacts, and it is written down once** — `PHONE_RULE` in `src/tools/registry.ts`, with the measurements behind it. Three places in this repository described this behaviour three different ways and one of them was false, so the tools now all point at the same sentence rather than paraphrasing it.

The rule, measured on `customer.phone`, `supplier.phone` and `contactPersons[].phone`, which behave **identically**: the value is parsed with **Norway as the default region** and stored **canonicalised to E.164**. Nothing is stored as sent — `+46 70 123 45 67` comes back `+46701234567`, `(40) 12 34 56` comes back `+4740123456`, and even `tel:40123456` parses. A leading `+CC`, `00CC` or a bare `47` selects the country; anything else is read as Norwegian, and the digits must be valid for whatever country that resolved to or the write is refused with 400.

The trap is those last two together:

| sent bare | stored | why |
|---|---|---|
| `90123456` | `+4790123456` | valid Norwegian, meant as such |
| `40123456` | **`+4740123456`** | a real **Danish** mobile, also valid Norwegian — stored as `+47` with no warning |
| `21123456`, `22334455` | `+4721…`, `+4722…` | accepted — Norwegian fixed-line ranges |
| `20123456` | *refused* | **not** because it is Danish: `20` is unallocated **in Norway** |
| `701234567`, `401234567`, `612345678` | *refused* | Swedish, Finnish, Dutch — nine digits, invalid as Norwegian |

So the failure to fear is not a rejection but a foreign number **saved quietly as the wrong one** — someone then calls the wrong person. Always send a non-Norwegian number with a `+` and its country code. A bare `47` counts as a country code; a bare `45` does not (`4540123456` is refused, `004540123456` is not).

**What this replaced, because the correction is the point.** A quirk asserted "two phone fields, opposite rules — the ENTITY phone rejects a `+47` prefix", and `reai_update_customer` and `reai_update_supplier` told agents to strip it. Measured false: `PATCH /api/customers/{id}` and `PATCH /api/suppliers/{id}` both answer 200 to `+4722334455` and store it unchanged. There is one rule, not two, and the old guidance removed a correct prefix.

The one genuine exception in the API is the **employee** phone, which stores an unparseable value as `null` with a 200 instead of refusing it — `organisation.ts` documents that separately and reads the write back.

**On the update, `null` and `""` are not the same.** Omitting a field or sending `null` leaves it unchanged; `""` clears it. Worth stating how that was established, because the obvious test cannot tell them apart: clear a field first and then send `null`, and an already-empty field reports "unchanged" whichever the API does. Each case was run from a freshly populated contact. `name` is the exception — it cannot be cleared, and a blank or whitespace-only one is refused with `400 "Validation failed"`.

**The 404 is ambiguous, and reading it wrongly is how this shipped saying something false.** `"Contact person with id=N not found for customer with id=C"` is the answer *both* when the contact never existed or was already deleted *and* when the id is real but belongs to a different customer — measured, the same sentence word for word, because ids are scoped to the tenant rather than to the customer. A missing customer is a different message, `"Customer with id=C not found."` The first version of the translation matched the customer sentence case-insensitively, which the contact sentence also contains, so the commonest failure on these endpoints was reported as "the customer does not exist in this tenant" about a customer that was fine. The tools now name both readings and tell you to settle it with the list.

That ambiguity is also why the delete does not simply report a 404 as "already gone": a wrong `customerId` answers 404 while the contact survives, so claiming the job is done would be a guess. It reports what it knows — nothing was changed — and how to confirm which case it was.

## Purchase
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_suppliers` · `reai_get_supplier` | Find and read suppliers (*leverandører*) | read |
| `reai_supplier_ledger` | Leverandørreskontro — `isUnpaid` answers "what do we owe" | read |
| `reai_list_supplier_invoices` · `reai_get_supplier_invoice` | Registered supplier invoices and credit notes | read |
| `reai_list_reception_documents` | The document inbox — incoming invoices and receipts not yet booked | read |
| `reai_parse_ehf_attachment` | Parse an incoming EHF invoice into structured data | read |
| `reai_list_attachments` | The files on an order or a supplier invoice — the **only** way to discover an attachment id, since `GET /api/attachments` answers 405. `usedBy` is null on every row here | read |
| `reai_get_attachment` | One attachment, and the `usedBy` array the scoped list omits — what else references this file, which is the question to ask before deleting it | read |
| `reai_list_expenses` · `reai_get_expense` | Employee expense claims, incl. per diems and mileage. The detail read also answers "has this been reversed", which the API cannot be asked directly | read |
| `reai_create_expense` · `reai_update_expense` | Draft a claim and edit it while it is open. The line arrays are each the **complete list** — sending one cost row deletes the others | **irreversible** |
| `reai_deliver_expense` · `reai_approve_expense` · `reai_unapprove_expense` | Move a claim through open → for_approval → approved. Unapproving refuses while a voucher exists, and says which one to delete | **irreversible** |
| `reai_book_expense_voucher` · `reai_delete_expense_voucher` | Post the expense to the ledger, and unlink it again. The delete is "delete **or** reverse" and reports which | **irreversible** |
| `reai_reverse_expense` | Withdraw a claim. It is not deleted, and no visible field changes — see [the expense notes](#purchase-expense-claims) | **irreversible** |
| `reai_create_supplier` · `reai_update_supplier` · `reai_delete_supplier` | Supplier master data. Changing bank details (`iban`, `bankAccountNumber`, `swiftCode`) escalates the call to irreversible — see [the rule](../README.md#changing-where-money-goes-is-treated-as-irreversible). The delete **archives** instead when the supplier has transactions | reversible |
| `reai_unarchive_supplier` | Bring an archived supplier back | reversible |
| `reai_create_supplier_invoice` | Register a supplier invoice directly | **irreversible** |
| `reai_register_supplier_invoice_payment` | Record paying a supplier | **irreversible** |

### Purchase: expense claims

Expense claims are the other half of payroll: a salary run arrives pre-populated with wage lines derived from expense postings for the period, so what is approved here is what gets paid out there. The whole state machine was driven on the test tenant — `open → deliver → for_approval → approve → approved → voucher`, and back down by deleting the voucher and unapproving — and three things it does are worth knowing before using it.

**`status` never says "booked".** A booked expense still reads `approved`; the only difference is that `voucherId` is set. Booking is also where the ledger moves: the voucher count went from 0 to 1 and came back as `{expenseId, voucherId, voucherNumber: "EX1-2026", voucherDate}`, its own number series. And booking an expense that is still `for_approval` **approves it as part of the same call**, so it can skip the approve step entirely.

**`status` never says "reversed" either, and that one hides.** `DELETE /api/expenses/{id}` answers `{"outcome":"reversed"}`, the expense vanishes from the list — and `GET /api/expenses/{id}` still returns it with whatever status it had before. No visible field changes. `?status=reversed` is rejected with a `400`, so the API cannot even be asked. The only positive signal is that a transition fails: `409 "Expense 2203 is reversed and can no longer be delivered"`. `reai_get_expense` spends one filtered list call to answer it properly, because acting on a withdrawn claim as though it were live is the mistake worth preventing.

**`category` is optional to create and required to deliver.** A cost row is accepted with no category, and then delivering answers `400 "Kategori må velges for kostnadsrad."` — naming no row. It is an enum of 28 values, so the tools take it as one and say when a row is missing it.

## Bank & VAT
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_company_banks` | The company's own accounts; the `id` is the `companyBankId` others need | read |
| `reai_get_bank_reconciliation` | Reconciliation state for one account and month — **the only way to see bank transactions** | read |
| `reai_get_manual_reconciliation` | The same for an account with **no feed**: opening balance, closing balance per the books, the statement figure you entered, the difference, and the API's own `canClose`/`canReopen` | read |
| `reai_set_bank_statement_balance` | Record what the statement says the account held at month end — the figure the books are compared against. Posts nothing | irreversible |
| `reai_close_manual_reconciliation` · `reai_reopen_manual_reconciliation` | Lock a month once the two agree, and unlock it again. Posts nothing, and closing is reversible by the same caller | irreversible |
| `reai_get_bank_transaction` | One transaction by id | read |
| `reai_list_reconciliation_rules` | Automatic booking rules | read |
| `reai_get_tax_return` | Skattemelding for a year, with submission status | read |
| `reai_create_company_bank` · `reai_delete_company_bank` | Register a bank account, or remove one. Neither touches anything at the bank | reversible |
| `reai_create_reconciliation_rule` · `reai_delete_reconciliation_rule` | Manage booking rules. A rule is *standing authority to post* — applying it books vouchers, and deleting it does not reverse them | **irreversible** |
| `reai_match_bank_transactions` | Reconcile transactions against existing postings | **irreversible** |
| `reai_book_bank_transactions` | Book transactions to a counter-account | **irreversible** |
| `reai_apply_reconciliation_rules` | Run the rules over a period (background job) | **irreversible** |
| `reai_create_vat_return` | Settle and **lock** a VAT term — does *not* file with Skatteetaten | **irreversible** |

### Manual bank reconciliation

`reai_get_bank_reconciliation` covers the accounts ReAI syncs. This is the other kind, and until now the only route to it was `reai_request`: an account whose `providerType` is manual has no transaction feed, so reconciling means asserting the closing balance from a paper statement and letting the API compare it with the books.

Where a manual account comes from is not obvious, and it matters: **a company bank created through this API is manual.** Measured — `POST /api/company-banks` answers with `manual: true` and a `displayName` ending "[Manual]". Tenant 2634's three accounts are all `providerType: "ztl"`, so they belong to the synced tool; anything an agent creates belongs here.

The state machine, measured end to end:

| state | statement balance | difference | `reconciliationLocked` | `canClose` | `canReopen` |
|---|---|---|---|---|---|
| fresh | `null` | `null` | false | false | false |
| balance set, agrees with the books | 0 | 0 | false | **true** | false |
| closed | 0 | 0 | **true** | false | **true** |
| reopened | 0 | 0 | false | true | false |
| balance set, does **not** agree | 500 | **500** | false | **false** | false |

Two things fall out of the last row. `difference` is the statement minus the books, and `canClose` is false whenever it is non-zero — a month that does not balance cannot be closed, which is the point of the exercise. And the API states both permissions itself, so no tool here has to guess: the read tool reports `canClose` and `canReopen` as the API's answers rather than as inferences.

**Only one month is closable at a time, and it need not be the one you asked for.** Measured with today at 2026-08-08: closing the current month answered `409 "Godkjenning er kun tilgjengelig for 2026-07."` — naming the month the API *will* accept — and a future month answered the same, while an earlier month fell through to the balance check instead. So reconciliation runs in order and a month that has not ended cannot be closed. The refusal carries its own answer, so the tool reads the nominated month out of it rather than leaving the caller with a Norwegian sentence.

The field for the balance is `bankStatementEndingBalance`; any other name is refused with `400 "Validation failed"` naming it. Both refusals on the transitions are Norwegian and describe states rather than mistakes: closing without a balance answers `409 "Angi sluttsaldoen før du lukker avstemmingen."` and reopening a month that is not locked answers `409 "Avstemmingen er ikke låst for <month>."`

**Nothing here posts.** Across the whole flow — setting the balance, closing, reopening — the voucher count stayed at 0 and the posting count did not move. This is a lock on a period, not a booking, and reopening is available to the same caller who closed (`canReopen: true` immediately after), unlike a VAT period. The three writes are still classified `irreversible` to match the policy tier for `/api/manual-reconciliations` and the rest of the reconciliation family: a curated tool softer than `reai_request` for the same call is a hole, and a period lock is a control an accountant relies on rather than reference data. The read is unaffected.

## Organisation
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_departments` · `reai_get_department` | Departments and their ids — what postings, employees and reports are tagged with | read |
| `reai_create_department` · `reai_update_department` · `reai_delete_department` | Manage departments. `DELETE` **archives instead of deleting** when something references the record, and says which in `{"outcome":…}`; departments have no unarchive endpoint | reversible |
| `reai_list_employees` | Everyone on the payroll, as a summary — the `id` is the `employeeId` postings, the ledger and expenses take | read |
| `reai_get_employee` | One full record. The national identity number and bank account are **redacted** unless `includePersonalData` is set | read |
| `reai_employee_ledger` | What is owed to or from each employee, with the postings behind it. `isOpenPosting` widens the window back to 2000, so an unsettled refund from last year is not hidden | read |
| `reai_create_employee` · `reai_update_employee` | Add and edit people. Passing `accountNumber` to the create escalates it to a payment-destination change; the update does not accept that field at all | reversible |
| `reai_set_employee_bank_account` | Set or change where a salary lands — a payment destination, and the sharpest one here. Reads the account before and after, so a *repoint* is visible rather than inferred | irreversible |
| `reai_add_employment_line` | Record a salary level, percentage or occupation code from a date. Reads the existing lines and writes them back with yours, because the field replaces | irreversible |
| `reai_delete_employee` | Hard delete — no archive branch and no undelete. `409` once any work data references them, including an empty draft salary run | reversible |
| `reai_list_users` · `reai_get_user` | Who can reach the books, with roles and effective permissions — including people who have not accepted their invitation yet | read |
| `reai_list_roles` · `reai_list_permissions` | The roles this tenant can grant and what each actually carries, and the permission catalogue behind the codes | read |
| `reai_list_user_invitations` | Invitations sent and not yet accepted — standing access waiting to be claimed | read |

### Organisation: employees

Employee master data is where this API's usual habit reverses, and it is worth stating in both directions. `PATCH /api/employees/{id}` is a **real patch** — verified by changing `phone` alone and finding city, postal code, street, bank account, start date and employment lines all untouched — which makes it the exception here, since company banks, creditors, agreements, subscriptions and salary wage lines all replace.

But `employmentLines` inside that patch **is** a replacement. An employee with two lines, PATCHed with one, came back with one: the other was gone and the survivor had a *new id*. So "add a raise from June" written the obvious way deletes the employment history, which is why `reai_add_employment_line` exists and `reai_update_employee` refuses the field.

Two more measured on the live tenant. Creating an employee with nothing but a name and an email is **not** a blank record: `dateOfEmployment` defaults to today and an employment relation with one empty line is created automatically, typed `ordinaertArbeidsforhold` — and employment is what the a-melding reports, so that date is not cosmetic. And `phone` is normalised to E.164 (`"22 33 44 55"` and `"0047 22334455"` both become `"+4722334455"`, a foreign number is fine) while an **unparseable** value is stored as `null` with a `200` and no error — `"nonsense"` silently replaced a stored number — so the tools read the phone back and say so when it did not survive.

### Organisation: roles and permissions

**The roles do not mean what their names suggest**, and this is the one finding here worth reading before granting anyone access. Measured on a live tenant by comparing the permission *sets*, not the counts:

```
ROLE_OWNER         51 permissions   not assignable
ROLE_TENANT_ADMIN  51 permissions   assignable   — identical to OWNER, 0 missing, 0 extra
ROLE_ACCOUNTANT    51 permissions   assignable   — identical to OWNER, 0 missing, 0 extra
ROLE_AUDITOR       20 permissions   assignable   — read-only
ROLE_EMPLOYEE       6 permissions   assignable   — self-scoped only
```

So "accountant" is not a narrower role than "admin": both are exactly the owner's access, including `tenant:user:write` — the permission to invite further people. The only thing `ROLE_OWNER` has that they do not is that it cannot be handed out. `reai_list_roles` computes that comparison against *your* tenant rather than repeating these numbers, so it stays true if the roles change.

Permission codes carry their scope as a prefix, and it is easy to miss: `self:…` reaches only the acting user's own records — their employee card, their expenses, their timesheets — while `tenant:…` reaches the company's. `ROLE_EMPLOYEE`'s six permissions are all `self:`.

The writes on these paths stay with `reai_request`, and are already gated: `POST /api/users` **invites** an email address and is classified as an external send, `PUT /api/users/{id}` changes what someone may do, and `DELETE` revokes access. Granting privilege is the one write in this API where what leaves the tenant is not data but authority.

## Fixed assets
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_assets` · `reai_get_asset` | The fixed-asset register (anleggsmidler): what is capitalised, on which balance-sheet account, and how it depreciates | read |
| `reai_create_asset` | Add an asset and its depreciation schedule. Posts **no voucher** — the register entry and the acquisition booking are separate | **irreversible** |
| `reai_set_asset_depreciation` | Replace the method and useful life. Changes every future depreciation posting | **irreversible** |
| `reai_write_off_asset` | Remove the remaining carrying value — the accounting act for something scrapped, lost or sold | **irreversible** |
| `reai_delete_asset` | Delete the record. Refused with **409** while a voucher references the asset — the spec's "deleted or reversed" does not happen | **irreversible** |

What each of these does was measured rather than read off the spec, and the spec turned out to be wrong about the most consequential one. Its DELETE description says a linked acquisition voucher is *"deleted when possible or reversed when accounting history must be retained"*. It is neither: with a posted voucher referencing the asset, the call answers `409 Asset with id N is used in existing vouchers and cannot be deleted` and changes nothing. That is the safer behaviour — there is no path here that quietly puts a counter-entry in your ledger.

Create, set-depreciation and write-off post **nothing** on an asset with no accounting history. They stay irreversible because `/api/assets` has always been classified that way and because write-off on an asset carrying real value could not be produced — this classifier fails closed on what it has not seen, and *not* because of any depreciation-posting mechanism, since no operation in this API posts depreciation at all.

## Subscriptions
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_subscriptions` · `reai_get_subscription` | What bills whom, how often, and whether it goes out on its own. The list calls out how many bill **automatically** | read |
| `reai_subscription_billing_history` | What a subscription has already produced. Nothing stops you billing the same period twice — this is how you check | read |
| `reai_create_subscription` | Set one up. Created **active** — what keeps a new one harmless is `automaticBillingGeneration: false`, not its newness | reversible |
| `reai_update_subscription` | Change one thing and keep the rest, including the lines. It does **not** disarm anything | reversible |
| `reai_activate_subscription` | Restart a stopped subscription. Reads it first and refuses, when external sending is off, to re-arm one that invoices on its own | **irreversible** |
| `reai_deactivate_subscription` | Stop it producing anything further. Undoing a standing risk, so available in the default mode | reversible |
| `reai_generate_subscription_billing` | Bill every DUE period now — a backdated subscription produced eight orders from one call. Reports the counts the API returns | **irreversible** + external send |
| `reai_delete_subscription` | Remove one that has never billed. One that has is refused with 409 — deactivate it instead | reversible |

`reai_update_subscription` reads, maps and merges rather than passing a body through, because echoing the GET back does not work: the response puts the lines under `lines` and the request wants `subscriptionLines`, a response line carries eleven fields where the request accepts eight, and a service recipient reads back as `companyName` and writes as `name`. Measured — a `PUT` carrying the eight required fields and one line answered `200` and left `invoiceEmail`, `invoiceComment` and `internalComment` all null with the second line gone. Mapped properly the round-trip is lossless, discounts included. It deliberately does **not** disarm: `outputMode`, `automaticBillingGeneration` and `sendEhf` are carried over, so an ordinary edit leaves a self-invoicing subscription self-invoicing, and the tool says so in its result.

Three fields decide whether a subscription reaches a customer on its own: `outputMode: "create_invoice"`, `automaticBillingGeneration`, and `sendEhf`. Together they are a machine that invoices real people while nobody is looking, so a body carrying any of them is treated as irreversible **and** as an external send — needing `REAI_WRITE_MODE=full` *and* `REAI_ALLOW_EXTERNAL_SEND`, because `full` alone does not lift the second. A subscription that produces a draft order and bills on request needs neither, and stays usable in the default mode.

`POST /api/subscriptions/generate-due` is deliberately **not** curated. It bills every due subscription in one call — the operation an agent would reach for to "catch up billing", and the one where a mistake is widest. It stays available through `reai_request`, where the refusal names what it is.

## Warehouses
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_warehouses` · `reai_get_warehouse` | The warehouses stock is held in. `archived` **selects** which set you get — no call returns both | read |
| `reai_get_warehouse_inventory` | Stock on hand per variant, with the two totals already computed. Quantities can be **negative** | read |
| `reai_create_warehouse` · `reai_rename_warehouse` | A name is the only field this resource has. Names are not unique, so identify one by id | reversible |
| `reai_delete_warehouse` | Deletes when nothing is on hand, **archives** when something is — the response says which | reversible |
| `reai_adjust_inventory` | Move stock in or out. A delta, not a new total. Posts **no voucher** and cannot be undone | **irreversible** |

Measured against the live API, and the sharpest edge here fails silently. `variantId` is optional in the schema and **required by this tool**: omitting it answers `200` with a real `transactionId` and moves **no stock at all** — four consecutive `+3` adjustments left `quantityOnHand` at 0. Nothing that can hold stock is exempt, because the API refuses a stock product with no variants, so requiring the field removes the failure mode rather than detecting it. The field to send is `variantId`; a variant in the product response is keyed `variantId`, not `id`, which is exactly how this was hit.

Two checks sit either side of the write. Before: the variant must be one of the warehouse's stock lines, which also supplies the quantity to measure against — a variant the warehouse does not track is refused with the valid ones listed, and nothing is written. After: the API echoes the variant it acted on, and a **null echo against a variant that was sent** is the no-op signature. That second check needs nothing from the pre-read, so it still holds when the inventory response cannot be read or matched.

Three more that the spec does not say. `occurredAt` is `date-time` and rejects a bare date with `400 "Failed to read request"` naming no field — this tool accepts `yyyy-MM-dd` and completes it. Stock goes **negative** without complaint: `-10` against 4 on hand gives `-6` and a stock value of `-600`. And an adjustment posts **no voucher** — the count never moved off 0 across every adjustment measured — so stock value never reaches the ledger, while no route lists or deletes a stock transaction, leaving an opposite adjustment as the only correction.

The delete is worth reading the response of: a warehouse holding 2 units was **archived**, kept its stock and vanished from the default list, while one whose adjustments netted back to zero was deleted outright. The trigger is current stock, not history — and since archived warehouses are only returned by `archived=true`, stock can sit somewhere the default list does not show.

## Agreements
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_agreements` · `reai_get_agreement` | Leases, employment contracts, purchase and service agreements, with signing status. The terms are **nested** under a sub-object named for the template | read |
| `reai_list_agreement_signers` | Who was asked to sign and what happened since. Reading sends nothing; asking does | read |
| `reai_create_agreement` | Create a lease, employment contract, accounting-services, service or purchase agreement as an unsigned **draft**. Refuses an empty body, checks the enums first | reversible |
| `reai_update_agreement` | Change terms **without destroying the rest** — see the note below the table | **irreversible** |
| `reai_delete_agreement` | Remove an agreement and its document. Answers `204`, no outcome field, no archive branch | reversible |

`reai_update_agreement` needs `REAI_WRITE_MODE=full`, and the reason is worth stating: not because this tool is dangerous — it is the safe way to do the job — but because the underlying `PUT` replaces the record, so the raw call is classified irreversible and a curated tool may not be the soft route around a gate the escape hatch is subject to. The same argument this repo already made for reconciliation rules.

`reai_update_agreement` exists because the underlying call does the opposite. `PUT` on an agreement is a **full replacement**: measured on a live lease, a `PUT` carrying only the landlord's name left `monthlyRent`, `tenantName`, `depositAmount`, `depositAccountNumber` and the house rules all null — and `GET /pdf` still returned `200`, producing a document that looks like a contract with nothing in it. The tool reads the agreement, merges your changes over the existing terms and writes the whole thing back; that the round-trip is lossless was verified rather than assumed, by writing a 78-key sub-object back verbatim and confirming no field changed.

Three more measured surprises. **Nothing is required** — `POST /api/agreements/rent-agreement {}` answers `201` with a draft in which every term is null. The identifier is **`agreementId`, not `id`**. And **fourteen fields across four of the five templates are enums whose members the spec declares** (purchase-agreement declares none) — so they can be read with `reai_describe_endpoint` rather than guessed. This paragraph said the opposite for a while ("enums the spec never lists"), and the correction had been made in the source comment and nowhere a reader could see it. The members are lowercase snake_case, which is not what a Norwegian contract form suggests: `leaseDurationType` is `indefinite | fixed_standard | fixed_special_reason`, `depositType` is `deposit | guarantee`. `reai_update_agreement` checks values against the declarations before writing.

The five **create** endpoints were deliberately NOT curated for a while, and that is worth recording because the reasoning was sound and one of its premises turned out to be false. The argument was: the bodies run to 78 fields for a lease (17–31 for the others), the spec documents them properly, `reai_describe_endpoint` shows them, and every trap above reaches a `reai_request` caller as a quirk. Two things overturned it. The 78 fields were only an objection to a tool that declares each one as an argument — `reai_create_agreement` takes a free-form `terms` record, exactly as `reai_update_agreement` takes `changes`, so the field count costs nothing. And "reach it through `reai_request`" assumed discovery would point there: measured, `reai_search_endpoints` answers **create agreement**, **opprett avtale** and **create lease agreement** with three **irreversible external sends** in the top three places — `sign-request`, `sign-requests` and `sign-requests/{id}/send` — and all five creation endpoints tied for fourth through eighth. A quirk that describes a trap also does not prevent it: `reai_create_agreement` refuses an empty body rather than reporting that one is accepted, checks the 14 enum-carrying fields against the members the document declares before writing, and names any term the template does not declare. That last one was measured rather than assumed: creating a lease on 2783 with one undeclared field name answered `201` and dropped it silently — absent from the 78-key `rentAgreement` sub-object and from the top level alike — while the declared terms came back exactly as sent. `DELETE` then answered `204` and the record read `404`. The three **signing** endpoints are not curated either — they email a counterparty, so they need `REAI_ALLOW_EXTERNAL_SEND` and are better reached through `reai_request`, where the refusal names what would have gone out. The PDF is a download: `reai_request GET /api/agreements/{id}/pdf` with `binary=true`.

What the API does **not** check: Norwegian tenancy law caps a deposit at six months' rent (husleieloven § 3-5), and § 9-3's three-year minimum for a fixed-term *residential* lease means a shorter one counts as indefinite unless a statutory ground applies — not that it is rejected. A deposit of 9 999 999 against a rent of 10 000 was accepted, and so was a four-month fixed term with no reason. This server does not enforce either: that would be inventing law, on a template that also covers storage and other non-residential lets. The tools say so instead.

## Renaming something must not erase where money goes
| Tool | Purpose | Risk |
|---|---|---|
| `reai_update_company_bank` | Change a company account — label, currency, SWIFT, or the number itself — **without emptying `bban`** — in the [bank](#bank--vat) toolset | **irreversible** |
| `reai_set_supplier_address` | Change part of a supplier's address without dropping the postcode — in the [purchase](#purchase) toolset | reversible |
| `reai_update_creditor` | Rename a loan counterparty **without emptying the account its repayments go to** — in the [loans](#loans) toolset, listed with it below | **irreversible** |

Each of these wraps a `PUT` that replaces rather than patches, on a record carrying a payment destination the schema does not require — so the body an ordinary rename produces is accepted and empties the account. All three read the record first and merge. The measurements, and why the two account-carrying ones need `REAI_WRITE_MODE=full` even though they are the *safe* way to do the job, are in [docs/safety.md](safety.md#the-three-curated-merge-tools).

`reai_update_order` exists because `PUT /api/orders/{id}` is a full replacement whose **response does not match its request**. Measured against order 4105 on 2783: the lines come back under **`lines`** and must be sent as **`orderLines`**; each line the GET returns carries `id`, `vatTitle`, `vatRate` and `amounts`, none of which the PUT declares and three of which the API computes; and `comment`, `internalComment`, `buyerReference`, `externalReference`, `projectId` and `invoiceEmail` are optional, so a PUT that omits them keeps the order and empties those fields.

What the API *does* protect is the money: `orderLines`, `currencyCode`, `customerId`, `daysUntilDue` and `issueDate` are all required, so a partial PUT is refused with a `400` rather than silently dropping the lines.

It needs `REAI_WRITE_MODE=full`, and the reason is the same one `reai_update_agreement` gives: not because the tool is dangerous — it is the safe way to do the job — but because the write ladder classifies the operation rather than the care taken over it. A raw `PUT` omitting any of `projectId`, `internalComment`, `buyerReference`, `externalReference`, `invoiceEmail` or `sendEhf` is **already refused in the default mode** by the replacement-omission gate. This tool omits `invoiceEmail` unless you pass it, so leaving it a tier below would have made the curated tool the soft route around a gate the escape hatch is subject to. (An earlier version of this page claimed the tier followed from "nothing is required on the agreement PUT". That was a post-hoc story this repo falsifies — `reai_update_subscription` is `reversible` and its own partial PUT erases fields too. The classification is a path rule, and the tier here answers to the omission gate.)

**`invoiceEmail` is the field that cannot be preserved.** `UpdateOrderReq` declares it; no order response returns it — verified against the document and against the live response. So the tool cannot tell whether an order has an order-specific invoice address, cannot carry it, and **every successful update says so**, whether or not you passed one. Pass it to set it back. Offers are luckier: everything `OfferReq` accepts, `OfferRes` returns.

Two refusals, both deliberate. An order with **`sendEhf` already set** is not updated: a replacement must either send the flag again — which the write policy reads as an external transmission, verified — or omit it, which silently disarms EHF at invoicing time. The flag is read with `bindsToTrue`, not `=== true`, because the backend coerces `"true"` and `1`. And an **already-invoiced** order is refused, because the invoice is the legal document and editing the order behind it does not change it; what the API does in that case was **not established**, since no invoiced order was available to measure. `reai_request` does either deliberately.

Smaller things it handles, each because a review found the version that did not: `comment`, `internalComment`, `buyerReference`, `externalReference`, `projectId` and `invoiceEmail` are nullable, so a field can be edited to *nothing* rather than only to another value; replacement lines accept the accrual fields, which the create tool's line schema does not declare and zod would otherwise strip, silently changing a line's periodisation; the base is checked with `readableRecord` so `{}` or a response envelope cannot become a merge base; the fields the PUT requires are pre-checked against the record rather than sent as `undefined` into a bare `400`; and moving an order to another customer reports that it **kept the old customer's payment terms**, naming the new customer's own, because `daysUntilDue` is required and non-nullable so the replacement always carries a number.

Like every read-merge-write here, it leaves a **lost-update window**: an edit made in the ReAI UI or by another client between the read and the write is silently reverted, lines included. There is no ETag, `If-Match` or version field, so it is stated rather than papered over.

`reai_update_offer` exists for the same reason `reai_update_order` does: `PUT /api/offers/{id}` is a full replacement whose response does not have the shape the request wants. The lines come back under **`lines`** and must be sent as **`offerLines`** — which is required, so a body echoing `lines` back has no lines at all — and each returned line carries **seven** fields the PUT does not declare (`id`, `rowNumber`, `vatRate`, `lineTotal`, `lineTotalExclVat`, `lineVat`, `lineDiscount`), five of them computed. `projectId`, `issueDate`, `comment`, `internalComment`, `email` and `deliveryAddress` are optional, so a replacement that omits them empties them.

Two differences from orders. Offer lines are stricter in **exactly one field, not two**: `vatCode` is required here and genuinely optional on an order line — but `itemName` is required on **both**, and an order line without it is refused with `400 "Produkt er obligatorisk for alle ordrelinjer."`. That was re-measured on 2026-08-09 and is recorded in `offer-lines-stricter`; an earlier version of this page read the spec's `required` list as measured behaviour and got it wrong. And `issueDate` is genuinely **not** required here though it is on an order.

And it runs in the **default** write mode where the order tool needs `full`. That is a real difference, not a looser rule: everything `OfferReq` accepts, `OfferRes` returns — including `email` and a `deliveryAddress` whose request and response shapes are property-for-property identical — so this tool carries every field and its replacement omits nothing. Verified: `omittedReplacementFields` returns no fields for the body it sends, where a partial body omits six. An order update cannot do that, because `invoiceEmail` is accepted and never returned, so that tool omits a field the replacement-omission gate refuses by default and sits at `full` rather than becoming the soft route around it.

Like every read-merge-write here it leaves a **lost-update window**: an edit made between the read and the write is silently reverted, lines included, and there is no ETag or version field to prevent it.

`PUT /api/offers/{id}` is now curated too — see `reai_update_offer` under [Sales](#sales). The measured differences from an order are recorded there: `issueDate` is not required, per-line `vatCode` is (`itemName` is required on both), seven returned line fields are unaccepted rather than four, and everything `OfferReq` accepts `OfferRes` returns — which is why that tool runs in the default write mode and this one does not.

## Null, the empty string, and omission

This repo has measured these three separately on several endpoints and they **disagree per field**, so it has one home rather than four. Measured on 2783 on 2026-08-09, after both update tools shipped telling agents "pass null to clear it" — which is false for most fields.

On `PUT /api/orders/{id}` and `PUT /api/offers/{id}` there are **two families**, and omission follows the same split as null:

| field | omitted | `null` | `""` |
|---|---|---|---|
| `comment` | **kept** | **kept** | **clears**, stored back as `null` |
| `internalComment` | **kept** | **kept** | **clears** |
| `buyerReference` (order) | **emptied** | **clears** | — |
| `externalReference` (order) | **emptied** | **clears** | — |
| `projectId` | **emptied** | — | — |
| `email` — **offers only** | — | **kept** | not measured |
| `issueDate` — **offers only** | — | **kept**, existing date preserved | on an *order* `issueDate` is **required**, so a null there is a different question and was not measured |
| `deliveryAddress` — **offers only** | — | **kept**, existing object preserved | `UpdateOrderReq` does not declare this field at all |

The first two behave like `if (value != null) set(value)`; the rest like a plain replacement. An earlier version of this page said a partial PUT "empties those fields" for all six — true for three of them, false for the two comments.

Both tools therefore report from the **response** rather than from what was sent: a value the API discarded is named as `IGNORED by the API`, the headline drops it (down to `Changed NOTHING you asked for` if that is all there was — the record may still have changed, which is why the sentence is qualified), and for the two clearable fields the note says to send an empty string. An earlier version *refused* a null on those two, which covered two of the five ignored fields and refused legitimate calls — including a null against an already-empty field, whose outcome is what the caller asked for.

### Which tools state what the API stored, and which state what you sent

A note that says *"renamed to X"* while X is the value you just passed is not a report, it is an echo. It matters
here because ReAI **rewrites what it stores** — a name comes back title-cased, a phone in E.164, a date as a
timestamp — so on a rename the stored value is the one thing the caller cannot assume.

Two populations, both derived rather than listed by hand, and both enforced by
`test/confirm-against-response.test.mjs`:

| population | how it is found | state |
|---|---|---|
| read-merge-write | declares a `GET` **and** a `PUT`/`PATCH` | 13 tools, 11 certified against the response, 2 recorded as unverified with the reason |
| not a merge tool | a write endpoint answers with a schema carrying a field the tool's own `inputSchema` accepts, at ANY depth | 47 tools, 7 proven, 5 the sweep cannot drive |

The second row is the blind spot that let tools echo their arguments through five rediscoveries. Three refinements
were each forced by a tool that escaped:

- **not gated on declaring a `GET`.** The first version was, because that is what a merge tool looks like — and it
  then excluded anything with a GET, while the merge census only owns GET-*plus*-PUT/PATCH. Tools with a POST and
  an ancillary GET fell between the two.
- **every `2xx`, not just 200/201.** A POST documented as `202` fell out entirely.
- **fields at ANY depth.** `reai_add_salary_line` echoed its figures while the response carried the stored line
  at `employees[].wageSpecs[]`; comparing top-level names only found nothing. `reai_log_lead_contact` escaped the
  same way, through `contactEvents[]`. `allOf` members are followed for the same reason.

Identity fields (`id`, `orgNumber`) are excluded — they go out in the path and come back unchanged whatever the
API did with the payload, so they confirm nothing.

That third column used to read **40 not examined**, and it was a list of names meaning "nobody has checked". A
ratchet on a hand-kept list is only as good as the hand, so it was replaced by a **measurement**: every candidate
is driven with arguments built from its own schema against a response whose fields DISAGREE with the request,
and the note is read. Three outcomes — it states the stored value (good), it states the sent one (a defect), or
it mentions neither (no claim to be wrong about).

That found **ten** tools echoing their arguments, all of which had been sitting on the list:
`reai_create_asset` (irreversible, and the field was the balance-sheet account carrying the asset),
`reai_create_warehouse` (whose own description says names are not unique, so the wrong name leaves a caller
unable to tell which of two they just made) and the three manual-reconciliation tools —
`reai_set_bank_statement_balance`, `reai_close_manual_reconciliation` and `reai_reopen_manual_reconciliation`,
all irreversible, in the one family where this repo already documents the API having its own opinion about which
month is in play (`"Godkjenning er kun tilgjengelig for 2026-07."`). A note reading "2026-08 is closed for this
account" when the record says otherwise is a lock an agent will believe it holds.

— plus `reai_adjust_inventory` (irreversible, and it stated all four of product, variant, warehouse and quantity
from the request, on a movement its own note says cannot be deleted), `reai_create_order` and
`reai_create_offer` (the payment terms — a money figure), `reai_create_invoice_from_order` (the invoice date,
which decides the accounting period) and `reai_create_supplier_invoice` (whether the document is an invoice or a
credit note — opposite signs in the ledger).

**Each of those five was found by fixing the sweep, not by running it.** In order: reading the whole note instead
of the headline let a tool assert the sent value in its first sentence while a confirmation paragraph below
mentioned the stored one; sampling integers as `7` made every integer field in the repo too short to find in
prose; sampling every field to the SAME value flagged whole groups at once and buried the real hits in
artifacts; and skipping optional fields meant seven update tools were driven while being judged on nothing. A
green sweep is only as good as its samples.

**What it still cannot see**, named rather than implied: a value the note RENDERS rather than prints (nine enum
fields), a value it reformats, and five tools it cannot drive — three because the sampler cannot construct their
arguments, and **two because they refuse before sending anything**, each requiring one of two arguments in a way
no schema expresses. Those are different problems and the list stopped calling them one.

Thirteen further tools mention **neither** the sent nor the stored value in any note it could read. That is not a
defect — a note making no claim cannot make a false one — but it is not evidence either, and they are listed by
name so "covered" is not read into them.

All nine rendered fields have since been driven **by hand** with a response naming a different member, and the
result is more mixed than "the other eight already report from the record", which is what an earlier version of
this page said:

- **two were echoing.** `documentType` on a supplier document, where the two kinds are opposite signs in the
  ledger; and `eventType`/`eventDate` on a share-investment event, which fell back to the request whenever the
  response was silent — irreversible, and once it posts its voucher can only be reversed, never deleted.
- **three report from the record**, now with tests that drive a disagreeing response.
- **four are never named by their tool's note at all.** Nothing to state means nothing to get wrong, which is a
  weaker guarantee than a test and is recorded as `null` rather than counted as coverage. An echo could be
  reintroduced into any of the four and nothing would fail.

Each carries either a named test or that explicit `null`. The references are checked — the test must open with
the title, be in the tool's own module or its test file, name the tool as an identifier or a whole string rather
than inside prose, assert something, assert on stored-versus-sent, and **not** be `skip`ped or `todo`. That is
not "the same checks as the census", which is what this page claimed: it is stricter in two places (skip, and
the duplicate-title guard) and it still cannot establish that a test proves anything.

Of the five tools the sweep cannot drive, two *refuse before sending anything* — each requires one of two
arguments, which no schema expresses. One of those, `reai_apply_reconciliation_rules`, had been counted as
covered while never reaching the API stub at all; the sweep now checks the request actually went out, which is
the same "measured nothing" hole that made `reai_update_expense` look covered while it returned *"No fields were
given"*. Each tool is driven twice, with required fields only and with the optional fields the response can
answer for, and counts as unreachable only if both attempts fail.

What is left on the list is the residue the sweep genuinely cannot construct arguments for — 3 tools, named
rather than counted. **What the sweep cannot see:** a note that RE-FORMATS the value it echoes reads as "mentions
neither", so a green sweep means no tool echoes a value *verbatim*, not that every note is honest. The
hand-written certifications remain the stronger per-tool evidence.

Counter-examples elsewhere, all measured: `PUT /api/leads/{…}/notes` clears on null, so does an employee's `endDateOfEmployment`, and so does `bankAccountNumber` on `PUT /api/creditors/{id}` — cleared by a null, by omitting the field and by an empty string alike, on three throwaway creditors. Creditors therefore fall in the **plain replacement** family above, with `buyerReference`, rather than in the comment family. **The split is per-field, not per-endpoint** — which is the rule, and the reason each field has to be measured where it matters.

**Scope, stated because the fix is much narrower than the hazard.** Fourteen curated tools take a nullable argument on a `PUT` or `PATCH` — twelve besides these two — and the phrase "null clears it" appears in **eight** source files. Those remain unverified against the behaviour above, with one exception now measured: `reai_update_creditor` promised a null clears `bankAccountNumber`, a *payment destination*, and its success note was computed from what was **sent** rather than from the response. Measured on three throwaway creditors — the field is cleared by a null, by omitting it, and by an empty string alike — so the claim was true, and creditors behave like `buyerReference` rather than like a comment. That is the **third** endpoint to disagree with the other two, which is the whole reason for the rule above. The tool now reports from the response regardless, because the cost of being wrong there is a payment destination and the check is two lines. `reai_update_subscription` was deliberately not probed: subscriptions are created **active**, so a throwaway one on a real company could generate an invoice.

## Payroll
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_salary_runs` · `reai_get_salary_run` | Which periods have been run, what each pays, and each employee's wage lines | read |
| `reai_create_salary_run` | Open a run for a period. Arrives as a **draft** — measured, it posts no voucher | **irreversible** |
| `reai_add_salary_line` · `reai_update_salary_line` · `reai_delete_salary_line` | Manual wage lines on a draft run | **irreversible** |
| `reai_delete_salary_run` | Delete a run. **Refuses** anything not still `under_process` | **irreversible** |

**Completing a run is deliberately not a tool.** `POST /api/salary-payments/{id}/complete` does all of this in one call, by its own description: posts the voucher, creates payslips, creates *one employee payment per payable employee* against a company bank, and starts the **A-melding submission to Skatteetaten** — after which withholding tax and employer contributions are registered automatically. It is classified irreversible **and** external, so it needs `REAI_WRITE_MODE=full` *and* `REAI_ALLOW_EXTERNAL_SEND`, and it stays on `reai_request` for the same reason `subscriptions/generate-due` does: it is what an agent reaches for to "finish payroll", and it is where a mistake is widest. Its `manualPayment` flag is the same dual-mode trap as the supplier payment.

Three things measured on a live tenant. A run **cannot be created** until every included employee has a bank account — `400 "Følgende ansatte mangler bankkonto"`, naming them, and employees are created without one. Creating a run **posts nothing**: the ledger count did not move and `voucherId` stayed null, so a draft is safe to delete. And **half the gross was withheld** — a 5000 line produced 2500 payable at `taxDeductionRate: 50`, which is what this API applies when there is no tax card, so a payable amount is not take-home.

The wage-line endpoints are asymmetric in a way worth knowing: create **requires** `employeeId` and update **rejects** it (measured, `400 "Unknown field: employeeId"`), so a line cannot be moved between employees. The update is also a **full replacement** — a raw `PUT` omitting `comment` clears it, measured — so `reai_update_salary_line` reads the line and carries over what you do not mention: omit to keep, pass `null` to clear. Lines derived from expense postings cannot be edited at all — which is also why a fresh run is not empty, and why adding pay to one without reading it first is how the same wages go out twice.

## Reference data and company state
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_countries` | The country codes this API accepts, each with its default `currencyCode`. `query` filters **locally** — the endpoint takes no parameters. Needs no tenant | read |
| `reai_list_currencies` | The currency codes this API accepts. Same local filter, also tenant-free | read |
| `reai_get_opening_balance` | The ledger position the books start from — returned as a **voucher**, which is why its `DELETE` can reverse — or a plain answer that none is recorded | read |
| `reai_get_annual_accounts` | Whether a submission record exists for a fiscal year, and its `status` — the API's states are `incomplete`, `complete`, `signing`, `signed` and `submitted_in_other_system`, so existing is not the same as filed | read |

**Shape is not membership**, which is why the code lists are worth a tool. Every `countryCode` argument on this server checks that a value is two uppercase letters and every `currencyCode` that it is three, because a pattern is all the spec documents. `UK` passes that check and is not a code this API takes — the United Kingdom is `GB` — so the local validation says yes and the API says no, which is the worst division of labour available. These two endpoints are the actual lists, and nothing pointed at them before.

Both **do** document their response, and the live API agrees: `CountryRes` is `{code, name, currencyCode}` and `CurrencyRes` is `{code, name}`, confirmed against 170 and 129 real rows. An earlier draft of this section claimed the opposite on a miscount worth recording — **388 of the 430 operations here declare a 2xx schema**, but 369 declare it under the wildcard content type rather than `application/json`, and counting only `application/json` gives 13. What is true is that the spec **index** carries no response shapes at all, so `reai_describe_endpoint` cannot yet tell you what an endpoint returns. That is a gap in this server, not in the spec.

**Two 404s that are answers, not failures.** `GET /api/opening-balances` answers `404 "Opening balance not found"` and `GET /api/annual-accounts/{year}` answers `404 "No annual-accounts submission exists"` when there is nothing recorded — measured on both test tenants. A 404 from a collection-shaped path is otherwise indistinguishable from a wrong path, a wrong tenant, or a switched-off module, and this server has watched all three conclusions get drawn from one. Both tools report the real answer, and *only* for the documented message: a 403, a 401 or a 500 still fails, because a tool that calls every error "nothing recorded" will report an outage as a fact about someone's books.

Both 404 conversions turn on the typed error's `status`, not on its message text: a gateway `500` relaying a downstream body can contain "HTTP 404" and the documented phrase together, and a text match would have called that outage an empty set of books. The country and currency lists need **no tenant** — the spec declares no `X-Tenant-Id` for either, so asking what codes exist works immediately after authentication.

### Attachments: finding the document behind a record

Measured on 2634 against supplier invoice 5830 and its attachment 19780 (`faktura_2026_10009.pdf`, 1,784,632 bytes) on 2026-08-10.

There is **no global attachment list** — `GET /api/attachments` answers **405**, because only `POST` exists on that collection. `reai_list_attachments` wraps the two owner-scoped routes: `GET /api/orders/{id}/attachments` and `GET /api/supplier-invoices/{id}/attachments`. An unknown owner answers **404 naming the owner**, so an empty list means the record exists and has no files — a different answer.

**There are three ways to reach an attachment id, and an earlier version of this page claimed this tool was the only one.** It is often not even the right one:

| route | when | how it was established |
|---|---|---|
| `reai_list_vouchers` · `reai_get_voucher` | a voucher **embeds** its attachments | measured — six of 58 vouchers on 2634, against one supplier invoice, so vouchers held six of the seven attachments on the tenant |
| `reai_list_reception_documents` | a document that has **not yet** become an order or invoice — the case this tool structurally cannot reach | from the schema: `attachmentId` is on every reception row, and `reai_parse_ehf_attachment` has always relied on it. Both inboxes were empty on the tenant available, so not measured |
| `reai_list_attachments` | already attached to an order or a supplier invoice | measured |

There is no `/api/vouchers/{id}/attachments` route (404), which is why `voucher` is not an `ownerType` here; when `usedBy` names one, `reai_get_attachment` points at the voucher read instead.

**The two routes disagree on four fields, not one.** The owner-scoped list leaves `usedBy` null; reading the same attachment by id fills it in (`[{"ownerType":"SUPPLIER_INVOICE","ownerId":5830}]`). So "what else points at this file" is a question only `reai_get_attachment` can answer, and it is the one to ask before deleting. `contentUrl` and `downloadUrl` point at the **owner** path rather than `/api/attachments/{id}/content` — both serve the same bytes, verified byte-identical. And **`createdAt` differs by two days** between the routes (`2026-08-07T10:21:49` scoped against `2026-08-05T17:22:28` by id). Which one means "when the document arrived" is **not established**, so neither tool reports it as that. Voucher-embedded rows carry the by-id value, so the drift belongs to the supplier-invoice route rather than to scoped listing in general.

**Attaching a file: uploading is impossible through this server, and linking uses opposite paths per owner.** Measured on 2783 on 2026-08-10, with all probes failing so nothing was created.

| | upload a new file | link an existing one | detach |
|---|---|---|---|
| **order** | no route — multipart answers **415** | `POST /api/orders/{id}/attachments`, JSON `{"attachmentId": N}`; a bad id answers `404 "Attachment not found"` | `DELETE /api/orders/{id}/attachments/{attachmentId}` |
| **supplier invoice** | `POST /api/supplier-invoices/{id}/attachments`, multipart — answers **415** to JSON | `POST …/attachments/existing`, the same JSON body an order takes at its *plain* `/attachments` | **nothing** |
| **voucher** | no route | no route | `DELETE /api/vouchers/{id}/attachments/{attachmentId}` |
| **the file itself** | `POST /api/attachments`, multipart | — | **nothing** — `/api/attachments/{id}` is `GET` and `PATCH` only |

Three things follow, and the first two were wrong in an earlier version of this page.

**Uploading cannot be done here at all.** `reai_request` transports its `body` as JSON and nothing in this server ever constructs a `FormData`, so neither multipart route is reachable through it — the upload belongs in the ReAI web UI or another client. The repo had already recorded this once (`src/tools/investments.ts` documents the same conclusion for a different upload), and this page reintroduced it before review caught it.

**The order of checks is content type, then owner, then attachment id** — not owner first. Measured: a nonexistent order with a *valid* multipart body answers **415**, not the owner's 404, so a 415 tells you nothing about whether the record exists. With a valid JSON body the same nonexistent order answers `404 "No order with id 999999"`. A *malformed* multipart body answers `400 "Failed to parse multipart request"` instead of 415, so the three failures mean three different things.

**The 415 detail echoes the `Content-Type` header back including its boundary and charset**, so it differs on every request. Match the status, not the message — an earlier version of this page quoted a truncated form of it as though it were the API's exact words.

And the asymmetry has a sharper instance than the attach one: **a supplier invoice is the only owner that takes a file directly and the only one with no detach route**, while an uploaded attachment cannot be deleted at all. So step 1 of an upload-then-link workflow is not undoable even if step 2 fails. (`POST /api/attachments` is classified `reversible`, whose own definition is "can be cleanly deleted again" — that is not true here. Left as-is rather than retiered in this change, since it is a shared classifier and the call is unreachable anyway, but it is wrong.)

**Neither tool returns the file.** Content is the raw document — `application/pdf`, 1.7 MB for that one — so the tools report the URL and leave fetching to the caller. Two adjacent routes are EHF-only despite their names: `/ehf` **and** `/embedded-files` both answer `400 "Attachment is not a valid EHF XML"` on a PDF, so check `mimeType` before reaching for `reai_parse_ehf_attachment`.

One thing the spec lists that is not an API endpoint at all: `GET /attachments/{id}` and `GET /attachments/{id}/view/{filename}` (no `/api` prefix) are **web routes**. Measured: they answer **302** to `/auth/login?redirect=…`, which lands on the login page — and they ignore an API token entirely, so `Authorization: Bearer` makes no difference. A nonsense path behaves the same way, though not identically: each login page embeds its own `redirect=` parameter, so the bodies differ by a few bytes.

An earlier version of this paragraph said "200, the app shell, identical to a nonsense path", which was wrong on all three counts — `fetch` follows the redirect by default, so the 302 was invisible unless you looked for it. What does hold is the consequence: `reai_request` recognises an HTML response and says so rather than handing it back as data, verified live for both routes.

Writing an opening balance is left to `reai_request` on purpose. It is ledger position, so setting one restates every comparative figure the books produce, and `DELETE /api/opening-balances` is documented as **"delete OR reverse"** — the family this repo has been caught by five times, where a reversal *posts* rather than removes. Neither test tenant has an opening balance to watch those endpoints on, so no curated tool here claims to know what they do.

## Loans

| Tool | What it does | Risk |
|---|---|---|
| `reai_list_loans` | Every loan, borrowed and lent, with its derived ledger accounts and resolved counterparty. `query` filters **locally** — the endpoint takes no parameters | read |
| `reai_get_loan` | One loan, and a warning when its `interestTreatment` has no account to post interest to | read |
| `reai_create_loan` | Record a loan. Infers `relatedParty` for owner, employee and intercompany loans, which the API never does | irreversible |
| `reai_update_loan` | Change a loan. Reads and merges, because the `PUT` replaces; refuses a `perspective` flip without a new `counterpartyId` | irreversible |
| `reai_delete_loan` | Remove the record outright — measured `204`, then `404` | irreversible |
| `reai_list_creditors` · `reai_create_creditor` | Counterparties the company borrows **from** — the id a `borrower` loan needs. Creating one is reversible; giving it a `bankAccountNumber` is **payment routing** and needs `full` | read / reversible |
| `reai_update_creditor` | Rename one, or change that account. Reads and merges: a raw `PUT {name}` sets `bankAccountNumber` to null, measured | **irreversible** |
| `reai_delete_creditor` | Remove one. Its loans first — a referenced creditor answers `409` | reversible |
| `reai_list_debtors` · `reai_create_debtor` | Counterparties the company lends **to** — the id every `lender` loan needs. A debtor has no bank account, just a name | read / reversible |
| `reai_update_debtor` · `reai_delete_debtor` | Rename or remove one. Nothing a replacing `PUT` can erase here, which is why this needs no merge and the creditor one does | reversible |

Five operations, and the two that matter are undocumented in the spec.

`perspective` is not a label on the loan — it selects **which table `counterpartyId` is read from**. Measured on the write test tenant: `borrower` resolves the id against creditors and answers `404 "Creditor with id=N not found"` for a miss, `lender` resolves the same id against debtors and answers `404 "Debtor with id=N not found"`. So flipping `perspective` on an existing loan silently changes what an unchanged id means, which is why `reai_update_loan` refuses that edit unless a `counterpartyId` comes with it. The response renames the field a second time: what goes in as `counterpartyId` comes back as `creditorId` or `debtorId`, with the other null, plus a derived `counterpartyName` and `counterpartyType`.

`loanType` and `perspective` are also constrained *pairs*, which nothing documents. Measured, all twelve combinations, with the derived accounts as principal / interest / accrued:

| `loanType` | `borrower` | `lender` |
|---|---|---|
| `bank_loan` | 2220 / 8150 / 2950 (bank) | refused |
| `owner_loan_to_company` | 2255 / 8159 / 2950 (owner) | refused |
| `company_loan_to_owner` | refused | 1370 / 8050 / 1760 (owner) |
| `company_loan_to_employee` | refused | 1572 / 8050 / 1760 (other) |
| `intercompany` | 2260 / 8130 / 2950 (company) | 1320 / 8030 / 1760 (company) |
| `other` | 2220 / 8159 / 2950 (other) | 1320 / 8050 / 1760 (other) |

The lock is just the direction the name already states — a bank loan is one the company took, a company loan to the owner is one it granted — and `intercompany` and `other` say nothing about direction, so both are allowed. A wrong pair answers `400 "Lånetypen er ikke gyldig for valgt låneperspektiv"`, so `reai_create_loan` refuses it locally and says which direction the type means. `reference` is unique per company too: `400 "Lån med referanse X finnes allerede."`, explained in English rather than passed through.

That account wiring is the useful half of this domain, and it is derived *once*. The trap is that `PUT` treats the accounts like every other field: **omit them and they are cleared**, and nothing re-derives them. Measured with `interestTreatment` held constant, so it is omission and nothing else: `8150`/`2950` → `null`/`null`. `principalAccountNumber` is the exception and survives, so a caller who checks one field concludes the wrong thing about the other two.

This was first written up here as a consequence of switching `interestTreatment` to `capitalize`, because that is when it was first seen, and re-measuring is what corrected it: carrying the accounts through a switch to `capitalize` keeps them, and omitting them clears them with the treatment untouched. The treatment has nothing to do with it.

So the hazard belongs to the raw endpoint, and this server already has two layers against it — both checked live rather than assumed. `reai_update_loan` merges, so a partial edit carries the accounts back; and `reai_request` refuses the same `PUT` through its omission gate, which named all ten missing fields including the three accounts. Producing the broken state required `clearOmittedFields: true`, the deliberate override, which is the right amount of difficulty. When the read tools do report a loan as inconsistent it came from the ReAI UI, another client, or that override, and the repair is to pass the numbers explicitly.

`PUT /api/loans/{id}` replaces rather than patches — measured, a body of only the nine required fields nulled `description` and `maturityDate` and reverted `repaymentType`, `dayCountConvention`, `interestTreatment` and `relatedParty` to their defaults — so `reai_update_loan` reads the loan and merges, like the other replacement `PUT`s here.

`relatedParty` is never inferred: it stayed `false` on a `company_loan_to_owner` with everything else set. `reai_create_loan` sets it for owner, employee and intercompany loans unless told otherwise, and says that it did, because the field feeds note disclosure and a filed record that understates a related party is wrong in a way nobody reads back. A company loan to a personal shareholder also has tax consequences a bookkeeping record does not capture; the tool says to ask an accountant rather than pretending to know.

The counterparties moved into this toolset from `purchase`, on evidence rather than taste: `creditorId` and `debtorId` occur once each in the entire document, both on `LoanRes`, and nothing else in the API mentions either. A creditor *sounds* like a payables concept, which is presumably how they came to sit with suppliers, but in ReAI they are the two ends of a loan — so enabling only `loans` left a caller unable to create what its own tools demand, and enabling only `purchase` gave two tools for a domain that toolset does not cover. The asymmetry between them is real and visible in the shapes: a creditor is `{id, name, bankAccountNumber}`, a debtor is `{id, name}` with no account at all, which is why `reai_update_creditor` reads and merges (a raw `PUT {name}` sets the account to null — re-measured; the probe account number, `1506 20 99533`, is one this repository supplied and fails the Norwegian mod-11 check, so it is not anyone's account) and `reai_update_debtor` does not need to. **Names are unique on neither side**: two debtors called the same thing were created as ids 19 and 20 without complaint, so `reai_list_debtors` counts duplicates and says to choose by id.

Deleting is real: `204`, then `404`, with no archive and no reversal. Order matters — a creditor or debtor still referenced by a loan cannot be deleted, measured `409 "Cannot delete creditor that is referenced by one or more loans"`.

**The three loan writes** — `reai_create_loan`, `reai_update_loan`, `reai_delete_loan` — are `irreversible` even though a loan record posts nothing (measured, the voucher count did not move), because the record is the basis for later interest and repayment postings and the measurement came from a company with no loan history to lose. Everything else in this table is a read or a `reversible` counterparty write, so the loan **reads** are available in every mode.

## Share investments

| Tool | What it does | Risk |
|---|---|---|
| `reai_list_share_investments` | The portfolio, each position with its derived asset account and current `quantity`/`costPrice` — both computed from its events. `query` filters **locally** | read |
| `reai_get_share_investment` | One position | read |
| `reai_list_share_investment_events` | Purchases, sales, dividends, capital repayments and write-downs, with the `voucherId` each one booked | read |
| `reai_create_share_investment` | Record a position. Posts **nothing** — measured, the voucher count did not move | irreversible |
| `reai_update_share_investment` | Change the descriptive fields. Reads and merges, because the `PUT` replaces and also requires `instrumentType`; refuses a type change that does not name an `assetAccountNumber`, since the account does not follow the type | irreversible |
| `reai_add_share_investment_event` | **Posts to the ledger** — its own `SH` voucher series | irreversible |
| `reai_delete_share_investment` | Remove a position that has no events. With any event, the refusal is final | irreversible |

Seven operations, measured before any of them was curated, because the document is unusually quiet here: one field marked required on the create, nothing required on an event, and no statement anywhere about what any of it does to the ledger.

**An event posts; the position does not.** Creating a position left the voucher count at 0. A `DIVIDEND` of 1000 booked `SH1-2026` with postings on 1920 and 8071, and the event response carries its `voucherId` — share investments have their own voucher series. There is no `DELETE` for an event: the document has `GET` and `POST` on that path and nothing else. The only undo is on the voucher, and that answers `{"outcome":"reversed"}` rather than `"deleted"` — two offsetting postings are booked, the original stays, and the voucher then disappears from `GET /api/vouchers` while still reading `200` by id. The net effect is zero and the trace is permanent.

**An opening position IS an event.** `openingQuantity`, `openingCostAmount` and `openingDate` look like fields on a record and silently create a `PURCHASE` event — measured, quantity 100 with `pricePerUnit` derived as 500 from 50000/100. Because a position with any event cannot be deleted (`400 "Aksjeposten har registrerte transaksjoner og kan ikke slettes."`) and nothing removes an event, a position created with an opening balance is permanent from birth, and the create response says none of it. Clearing the fields afterwards does not help: the `PUT` answered 200 and the event stayed. `reai_create_share_investment` therefore refuses an opening balance unless `acceptPermanentPosition: true` is passed — the only argument on this server that exists purely to make someone stop and think, and it is there because one position on the write test tenant is unremovable for exactly this reason.

**Reclassifying a position leaves it on the old type's account, so the update tool refuses to do it silently.** The account is derived at creation and the API does not move it. Measured: a `LISTED_SHARE` position on 1810 was changed to `BOND`, `FUND`, `UNLISTED_SHARE` and `OTHER` in turn — every `PUT` answered `200` and the account stayed **1810** — while fresh positions of those types derive:

| `instrumentType` | account a fresh position gets |
|---|---|
| `LISTED_SHARE` | 1810 |
| `FUND` | 1810 |
| `UNLISTED_SHARE` | 1350 |
| `BOND` | 1830 |
| `OTHER` | 1820 |

So correcting a mislabelled holding from `LISTED_SHARE` to `BOND` would leave it booked on 1810 where 1830 belongs, and nothing in the response would say the balance sheet now disagrees with the label. `reai_update_share_investment` refuses a type change that does not name an `assetAccountNumber`, and quotes the number a fresh position of the new type would get — the same shape as the loan reclassification guard, for the same reason: the merge cannot tell a derived number from a deliberate one.

The smaller undocumented things: `assetAccountNumber` is derived at creation and never re-derived; an event needs `companyBankId` and asks for it in Norwegian (`400 "Velg verdipapirkontoen transaksjonen ble gjort opp mot."`) on a body the document marks as requiring nothing; and `PUT` requires `instrumentType` although `required` lists only `name`, while replacing everything omitted — `ticker` went from `"ZZ"` to null, and `quantity`/`costPrice`/`assetAccountNumber` survived only because they are derived rather than settable, so checking one of those and concluding the record is intact would be wrong.

`withinExemptionMethod` is fritaksmetoden. Whether a holding qualifies has real tax consequences and is not something this server can determine, so the flag is stored as given and the tool says so rather than defaulting.

**The Nordnet import is deliberately not curated.** `POST /api/share-investments/import/nordnet` takes a file and creates transactions in bulk; every one is an event, so it posts, and every position it touches becomes permanent. One call turning into an unknown number of irreversible postings is not something to hand an agent casually, and `reai_request` reaches it for anyone who means it.

## Projects

Projects are the obvious omission here, and deliberate: the Project module is disabled on every ReAI tenant this repo can reach, so `GET /api/projects` answers `403 "Project module is disabled"` and nothing about the success path could be verified. `reai_list_postings` and `reai_general_ledger` still take a `projectId` for tenants that have the module — you just have to find the id through `reai_request`.

## The one UI surface

| Tool | Purpose | Risk |
|---|---|---|
| `reai_reconcile_ui` | Unmatched bank transactions and unmatched ledger postings for a month, side by side, so a person can pick which ones pair. Off unless `REAI_ENABLE_UI=1` | read |

It sits outside the default surface rather than inside it — every count on this page and in the README is the default 175, and `REAI_ENABLE_UI=1` registers a 176th tool.

`reai_reconcile_ui` returns the unmatched bank transactions and unmatched ledger postings for a month side by side, so a person can pick which ones pair. It is off unless `REAI_ENABLE_UI=1`.

It is the only view here, and the bar it clears is narrow: **the user has to make a selection the agent cannot make for them, over items that are painful to name in prose.** "Match the 1,234.50 on the 3rd against the Europris posting" is worse than two columns and a click, and `reai_match_bank_transactions` already takes `transactionIds[]` and `postingIds[]` — the tool signature *is* a multi-select.

It is also the one payload that does not fit comfortably in text. A pending transaction serialises to roughly 750 characters, so a busy month runs into the result cap — and the way a truncated reconciliation failed is instructive: it showed unmatched transactions and zero unmatched postings, from which an agent would conclude there was nothing to match against and reach for the *booking* tool, which posts, instead of the matching one. (Result truncation itself is fixed — `ok()` now trims each list and names what it trimmed — but the shape of that failure is what this view is built not to repeat.)

Nothing else in this API clears that bar. A revenue chart, a voucher list, a dashboard — the answers are computable and belong in a sentence, which is the whole reason the API is worth wrapping in tools rather than screens.

It follows the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) shape: the view is a **resource** at `ui://reai/reconciliation` with MIME type `text/html;profile=mcp-app`, the tool points at it through `_meta.ui.resourceUri`, and each call's figures arrive separately as `structuredContent`. So the HTML is static and data-free, and the view renders the numbers itself. A host that does not support MCP Apps still gets the whole answer as text — the counts and totals *are* the answer; the rows are what the view is for.

Three things it holds deliberately:

- **It does not write.** Selecting is inert. Pressing *Match these* asks the host to call `reai_match_bank_transactions`, which the server re-checks under the same write policy — classified irreversible, so refused unless `REAI_WRITE_MODE=full`. It will not offer a call the tool would reject (both id lists are required), and it will not invent an account to book a difference to.
- **Counterparty text can never become markup.** Descriptions and payment references come from EHF documents and bank feeds, which is to say a supplier writes them. Every value reaches the page through `textContent`, and the test runs the view's own script against a DOM whose `innerHTML` throws.
- **No external request of any kind** — no CDN, font or image. Hosts render this under a strict CSP, and an accounting view should not phone anywhere.

One limit, stated rather than papered over: for a bank account whose currency differs from the books', postings carry two amounts and the OpenAPI document documents neither, so which is the bank figure could not be established against any reachable tenant. The view shows both and **declines to compute a difference** instead of guessing one — a wrong difference at that moment would prompt a fabricated discrepancy posting.

## What `skipRegistryLookup` actually does

Two tools carry the flag — `reai_create_customer` and `reai_create_supplier` — and both described it as "skip the Brønnøysund lookup and use exactly the details supplied". Measured on **29 organisation numbers**, each record read back and deleted, that is not safe.

**With the flag set, an ordinary company keeps the name AND the address you send.** Equinor, Symfoni, VN Norge, Telenor ASA, two sole proprietorships, a sub-unit, and the agencies that do not invoice small companies (NAV, Politidirektoratet, Digdir, Lånekassen) all respected it — a supplied address came back byte-identical.

**Sixteen of the twenty-nine ignored it**, overwriting both name and address, including an address supplied in the same request: Skatteetaten, Brønnøysundregistrene, Statens vegvesen, Kartverket, Husbanken, Innkrevingsmyndigheten, DNB, Nordea, SpareBank 1, Telia, Telenor Norge, Elvia, Posten Bring, If, Gjensidige, Circle K. They are the standard billing counterparties — banks, insurers, telecoms, power, post, fuel and the fee-collecting public agencies. Deterministic on re-run.

Telenor is the cleanest demonstration: the **holding** company `982463718` respects the flag, the **billing** entity `976967631` does not.

### The override is not the registry, and that is the real hazard

An earlier version of this page said these came back with "the registry's name and address". Three measurements rule that out:

| org number | Brønnøysundregistrene says | ReAI stored |
|---|---|---|
| `971648198` | INNKREVINGSMYNDIGHETEN | **Statens Innkrevingssentral** — a superseded name |
| `920058817` | NORDEA BANK ABP NUF | **First Card (nor)** — not a registry name at all |
| `976967631` | Postboks 800, **1331 Fornebu** | Postboks 800, **7900 Rørvik** — wrong postcode |

So the source is a ReAI-maintained directory of standard counterparties, and it is **stale**. That is worse than "the registry wins": a customer or supplier can be created carrying a superseded name or an address that is simply wrong, with a `201` and no warning. Which is why the rule ends with *read the created record back*.

### The one thing the flag is required for

Nothing documented this, and it is the flag's genuine purpose. An organisation number that is mod-11 valid but **not registered** cannot be created without it — the lookup fails and the API answers `500 {"detail":"404 : [no body]"}`. With the flag, the same request is a `201`.
