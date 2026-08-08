# Tool notes: measured behaviour by domain

Every curated tool, with its purpose and its risk classification, is listed in
[the README's tool tables](../README.md#tools). This page holds what could only be learned by
driving each domain against a live tenant — the state machines that do not say what state they are
in, the fields that replace when they look like they patch, and the `200`s that mean nothing
happened. It is written to be read *before* using a domain, and it is arranged in the same order as
the README's tables.

## Sales: leads

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

## Purchase: expense claims

Expense claims are the other half of payroll: a salary run arrives pre-populated with wage lines derived from expense postings for the period, so what is approved here is what gets paid out there. The whole state machine was driven on the test tenant — `open → deliver → for_approval → approve → approved → voucher`, and back down by deleting the voucher and unapproving — and three things it does are worth knowing before using it.

**`status` never says "booked".** A booked expense still reads `approved`; the only difference is that `voucherId` is set. Booking is also where the ledger moves: the voucher count went from 0 to 1 and came back as `{expenseId, voucherId, voucherNumber: "EX1-2026", voucherDate}`, its own number series. And booking an expense that is still `for_approval` **approves it as part of the same call**, so it can skip the approve step entirely.

**`status` never says "reversed" either, and that one hides.** `DELETE /api/expenses/{id}` answers `{"outcome":"reversed"}`, the expense vanishes from the list — and `GET /api/expenses/{id}` still returns it with whatever status it had before. No visible field changes. `?status=reversed` is rejected with a `400`, so the API cannot even be asked. The only positive signal is that a transition fails: `409 "Expense 2203 is reversed and can no longer be delivered"`. `reai_get_expense` spends one filtered list call to answer it properly, because acting on a withdrawn claim as though it were live is the mistake worth preventing.

**`category` is optional to create and required to deliver.** A cost row is accepted with no category, and then delivering answers `400 "Kategori må velges for kostnadsrad."` — naming no row. It is an enum of 28 values, so the tools take it as one and say when a row is missing it.

## Organisation: employees

Employee master data is where this API's usual habit reverses, and it is worth stating in both directions. `PATCH /api/employees/{id}` is a **real patch** — verified by changing `phone` alone and finding city, postal code, street, bank account, start date and employment lines all untouched — which makes it the exception here, since company banks, creditors, agreements, subscriptions and salary wage lines all replace.

But `employmentLines` inside that patch **is** a replacement. An employee with two lines, PATCHed with one, came back with one: the other was gone and the survivor had a *new id*. So "add a raise from June" written the obvious way deletes the employment history, which is why `reai_add_employment_line` exists and `reai_update_employee` refuses the field.

Two more measured on the live tenant. Creating an employee with nothing but a name and an email is **not** a blank record: `dateOfEmployment` defaults to today and an employment relation with one empty line is created automatically, typed `ordinaertArbeidsforhold` — and employment is what the a-melding reports, so that date is not cosmetic. And `phone` is normalised to E.164 (`"22 33 44 55"` and `"0047 22334455"` both become `"+4722334455"`, a foreign number is fine) while an **unparseable** value is stored as `null` with a `200` and no error — `"nonsense"` silently replaced a stored number — so the tools read the phone back and say so when it did not survive.

## Organisation: roles and permissions

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

What each of these does was measured rather than read off the spec, and the spec turned out to be wrong about the most consequential one. Its DELETE description says a linked acquisition voucher is *"deleted when possible or reversed when accounting history must be retained"*. It is neither: with a posted voucher referencing the asset, the call answers `409 Asset with id N is used in existing vouchers and cannot be deleted` and changes nothing. That is the safer behaviour — there is no path here that quietly puts a counter-entry in your ledger.

Create, set-depreciation and write-off post **nothing** on an asset with no accounting history. They stay irreversible because `/api/assets` has always been classified that way and because write-off on an asset carrying real value could not be produced — this classifier fails closed on what it has not seen, and *not* because of any depreciation-posting mechanism, since no operation in this API posts depreciation at all.

## Subscriptions

`reai_update_subscription` reads, maps and merges rather than passing a body through, because echoing the GET back does not work: the response puts the lines under `lines` and the request wants `subscriptionLines`, a response line carries eleven fields where the request accepts eight, and a service recipient reads back as `companyName` and writes as `name`. Measured — a `PUT` carrying the eight required fields and one line answered `200` and left `invoiceEmail`, `invoiceComment` and `internalComment` all null with the second line gone. Mapped properly the round-trip is lossless, discounts included. It deliberately does **not** disarm: `outputMode`, `automaticBillingGeneration` and `sendEhf` are carried over, so an ordinary edit leaves a self-invoicing subscription self-invoicing, and the tool says so in its result.

Three fields decide whether a subscription reaches a customer on its own: `outputMode: "create_invoice"`, `automaticBillingGeneration`, and `sendEhf`. Together they are a machine that invoices real people while nobody is looking, so a body carrying any of them is treated as irreversible **and** as an external send — needing `REAI_WRITE_MODE=full` *and* `REAI_ALLOW_EXTERNAL_SEND`, because `full` alone does not lift the second. A subscription that produces a draft order and bills on request needs neither, and stays usable in the default mode.

`POST /api/subscriptions/generate-due` is deliberately **not** curated. It bills every due subscription in one call — the operation an agent would reach for to "catch up billing", and the one where a mistake is widest. It stays available through `reai_request`, where the refusal names what it is.

## Warehouses

Measured against the live API, and the sharpest edge here fails silently. `variantId` is optional in the schema and **required by this tool**: omitting it answers `200` with a real `transactionId` and moves **no stock at all** — four consecutive `+3` adjustments left `quantityOnHand` at 0. Nothing that can hold stock is exempt, because the API refuses a stock product with no variants, so requiring the field removes the failure mode rather than detecting it. The field to send is `variantId`; a variant in the product response is keyed `variantId`, not `id`, which is exactly how this was hit.

Two checks sit either side of the write. Before: the variant must be one of the warehouse's stock lines, which also supplies the quantity to measure against — a variant the warehouse does not track is refused with the valid ones listed, and nothing is written. After: the API echoes the variant it acted on, and a **null echo against a variant that was sent** is the no-op signature. That second check needs nothing from the pre-read, so it still holds when the inventory response cannot be read or matched.

Three more that the spec does not say. `occurredAt` is `date-time` and rejects a bare date with `400 "Failed to read request"` naming no field — this tool accepts `yyyy-MM-dd` and completes it. Stock goes **negative** without complaint: `-10` against 4 on hand gives `-6` and a stock value of `-600`. And an adjustment posts **no voucher** — the count never moved off 0 across every adjustment measured — so stock value never reaches the ledger, while no route lists or deletes a stock transaction, leaving an opposite adjustment as the only correction.

The delete is worth reading the response of: a warehouse holding 2 units was **archived**, kept its stock and vanished from the default list, while one whose adjustments netted back to zero was deleted outright. The trigger is current stock, not history — and since archived warehouses are only returned by `archived=true`, stock can sit somewhere the default list does not show.

## Agreements

`reai_update_agreement` needs `REAI_WRITE_MODE=full`, and the reason is worth stating: not because this tool is dangerous — it is the safe way to do the job — but because the underlying `PUT` replaces the record, so the raw call is classified irreversible and a curated tool may not be the soft route around a gate the escape hatch is subject to. The same argument this repo already made for reconciliation rules.

`reai_update_agreement` exists because the underlying call does the opposite. `PUT` on an agreement is a **full replacement**: measured on a live lease, a `PUT` carrying only the landlord's name left `monthlyRent`, `tenantName`, `depositAmount`, `depositAccountNumber` and the house rules all null — and `GET /pdf` still returned `200`, producing a document that looks like a contract with nothing in it. The tool reads the agreement, merges your changes over the existing terms and writes the whole thing back; that the round-trip is lossless was verified rather than assumed, by writing a 78-key sub-object back verbatim and confirming no field changed.

Three more measured surprises. **Nothing is required** — `POST /api/agreements/rent-agreement {}` answers `201` with a draft in which every term is null. The identifier is **`agreementId`, not `id`**. And some fields the schema types as plain strings are validated as enums the spec never lists; the API names the allowed set in its `400` (`leaseDurationType` is `indefinite | fixed_standard | fixed_special_reason`, `depositType` is `deposit | guarantee`).

The five **create** endpoints are deliberately not curated: their bodies run to 78 fields for a lease (and 17–31 for the others) that the spec documents properly, `reai_describe_endpoint` shows them, and every trap above now reaches a `reai_request` caller as a quirk. The three **signing** endpoints are not curated either — they email a counterparty, so they need `REAI_ALLOW_EXTERNAL_SEND` and are better reached through `reai_request`, where the refusal names what would have gone out. The PDF is a download: `reai_request GET /api/agreements/{id}/pdf` with `binary=true`.

What the API does **not** check: Norwegian tenancy law caps a deposit at six months' rent (husleieloven § 3-5), and § 9-3's three-year minimum for a fixed-term *residential* lease means a shorter one counts as indefinite unless a statutory ground applies — not that it is rejected. A deposit of 9 999 999 against a rent of 10 000 was accepted, and so was a four-month fixed term with no reason. This server does not enforce either: that would be inventing law, on a template that also covers storage and other non-residential lets. The tools say so instead.

## Payroll

**Completing a run is deliberately not a tool.** `POST /api/salary-payments/{id}/complete` does all of this in one call, by its own description: posts the voucher, creates payslips, creates *one employee payment per payable employee* against a company bank, and starts the **A-melding submission to Skatteetaten** — after which withholding tax and employer contributions are registered automatically. It is classified irreversible **and** external, so it needs `REAI_WRITE_MODE=full` *and* `REAI_ALLOW_EXTERNAL_SEND`, and it stays on `reai_request` for the same reason `subscriptions/generate-due` does: it is what an agent reaches for to "finish payroll", and it is where a mistake is widest. Its `manualPayment` flag is the same dual-mode trap as the supplier payment.

Three things measured on a live tenant. A run **cannot be created** until every included employee has a bank account — `400 "Følgende ansatte mangler bankkonto"`, naming them, and employees are created without one. Creating a run **posts nothing**: the ledger count did not move and `voucherId` stayed null, so a draft is safe to delete. And **half the gross was withheld** — a 5000 line produced 2500 payable at `taxDeductionRate: 50`, which is what this API applies when there is no tax card, so a payable amount is not take-home.

The wage-line endpoints are asymmetric in a way worth knowing: create **requires** `employeeId` and update **rejects** it (measured, `400 "Unknown field: employeeId"`), so a line cannot be moved between employees. The update is also a **full replacement** — a raw `PUT` omitting `comment` clears it, measured — so `reai_update_salary_line` reads the line and carries over what you do not mention: omit to keep, pass `null` to clear. Lines derived from expense postings cannot be edited at all — which is also why a fresh run is not empty, and why adding pay to one without reading it first is how the same wages go out twice.

## Reference data and company state

**Shape is not membership**, which is why the code lists are worth a tool. Every `countryCode` argument on this server checks that a value is two uppercase letters and every `currencyCode` that it is three, because a pattern is all the spec documents. `UK` passes that check and is not a code this API takes — the United Kingdom is `GB` — so the local validation says yes and the API says no, which is the worst division of labour available. These two endpoints are the actual lists, and nothing pointed at them before.

Both **do** document their response, and the live API agrees: `CountryRes` is `{code, name, currencyCode}` and `CurrencyRes` is `{code, name}`, confirmed against 170 and 129 real rows. An earlier draft of this section claimed the opposite on a miscount worth recording — **388 of the 430 operations here declare a 2xx schema**, but 369 declare it under the wildcard content type rather than `application/json`, and counting only `application/json` gives 13. What is true is that the spec **index** carries no response shapes at all, so `reai_describe_endpoint` cannot yet tell you what an endpoint returns. That is a gap in this server, not in the spec.

**Two 404s that are answers, not failures.** `GET /api/opening-balances` answers `404 "Opening balance not found"` and `GET /api/annual-accounts/{year}` answers `404 "No annual-accounts submission exists"` when there is nothing recorded — measured on both test tenants. A 404 from a collection-shaped path is otherwise indistinguishable from a wrong path, a wrong tenant, or a switched-off module, and this server has watched all three conclusions get drawn from one. Both tools report the real answer, and *only* for the documented message: a 403, a 401 or a 500 still fails, because a tool that calls every error "nothing recorded" will report an outage as a fact about someone's books.

Both 404 conversions turn on the typed error's `status`, not on its message text: a gateway `500` relaying a downstream body can contain "HTTP 404" and the documented phrase together, and a text match would have called that outage an empty set of books. The country and currency lists need **no tenant** — the spec declares no `X-Tenant-Id` for either, so asking what codes exist works immediately after authentication.

Writing an opening balance is left to `reai_request` on purpose. It is ledger position, so setting one restates every comparative figure the books produce, and `DELETE /api/opening-balances` is documented as **"delete OR reverse"** — the family this repo has been caught by five times, where a reversal *posts* rather than removes. Neither test tenant has an opening balance to watch those endpoints on, so no curated tool here claims to know what they do.

## Projects

Projects are the obvious omission here, and deliberate: the Project module is disabled on every ReAI tenant this repo can reach, so `GET /api/projects` answers `403 "Project module is disabled"` and nothing about the success path could be verified. `reai_list_postings` and `reai_general_ledger` still take a `projectId` for tenants that have the module — you just have to find the id through `reai_request`.

## The one UI surface

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

## Loans

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

## Share investments

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

## Manual bank reconciliation

`reai_get_bank_reconciliation` covers the accounts ReAI syncs. This is the other kind, and until now the only route to it was `reai_request`: an account whose `providerType` is manual has no transaction feed, so reconciling means asserting the closing balance from a paper statement and letting the API compare it with the books.

Where a manual account comes from is not obvious, and it matters: **a company bank created through this API is manual.** Measured — `POST /api/company-banks` answers with `manual: true` and a `displayName` ending "[Manual]". Tenant 2634's three accounts are all `providerType: "ztl"`, so they belong to the synced tool; anything an agent creates belongs here.

The state machine, measured end to end:

| state | statement balance | difference | locked | `canClose` | `canReopen` |
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

## Customer contact persons

The named humans on a customer, as distinct from the customer record's own `email` and `phone`, which belong to the company. Five tools: `reai_list_customer_contacts`, `reai_get_customer_contact`, `reai_create_customer_contact`, `reai_update_customer_contact`, `reai_delete_customer_contact`.

**Where they overlap something you already have.** `reai_get_customer` returns the same array as `contactPersons`, so if you are fetching the customer anyway, you have them. The customer *list* omits it — that is the gap the list tool fills, along with fetching one contact without the customer payload around it, and being able to write them at all.

Measured on tenant 2783 on 2026-08-08, every probe record deleted afterwards.

**Company customers only.** A customer created with `privateContact: true` refuses a contact with `400 "Contact persons can only be added to company customers"`. The rule *is* in the spec, but as a sentence on `CreateCustomerReq.contactPersons` — the nested array used when creating a customer — not on this endpoint, so it is easy to miss from here. A private customer's own email and phone go on the customer record instead.

**The phone number is normalised, and the field is international — those are two separate facts, and conflating them produced bad advice.** A Norwegian number may be sent bare (`90123456`) or `0047`-prefixed, and both are stored as `+4790123456`, so a Norwegian value does not come back as it was sent. The tools report that renormalisation, on the update as well as the create — more important there, since a previous value was overwritten.

But foreign numbers are accepted and stored **exactly as sent**: `+46701234567`, `+14155552671`, `+447911123456` and `+4915112345678` all verified.

**Always send a non-Norwegian number with its country code**, and the reason is sharper than "otherwise it is refused" — which is what an earlier version of this page said, and it was wrong in the direction that costs something. Bare digits are interpreted as *Norwegian*, and that has two outcomes:

| sent bare | stored | why |
|---|---|---|
| `90123456` | `+4790123456` | valid Norwegian, and meant as such |
| `40123456` | **`+4740123456`** | a real **Danish** mobile, also valid Norwegian — accepted silently as `+47` |
| `20123456` | *refused* | Danish landline prefix, not valid Norwegian |
| `701234567` | *refused* | Swedish, nine digits |

So the failure mode to fear is not a rejection but a foreign number **saved quietly as the wrong one** — someone then calls the wrong person. Codex caught the categorical claim on PR #111.

The refusal is `"Skriv inn et gyldig telefonnummer. Norske nummer kan skrives uten +47."`, **and it says that for a malformed Swedish or American number too.** The first version of the translation read that as "the number must be Norwegian and start with 4 or 9", which for a foreign contact points the agent at the one part of the number that was correct. Codex caught it on PR #110. The message is not evidence about the number's country.

**On the update, `null` and `""` are not the same.** Omitting a field or sending `null` leaves it unchanged; `""` clears it. Worth stating how that was established, because the obvious test cannot tell them apart: clear a field first and then send `null`, and an already-empty field reports "unchanged" whichever the API does. Each case was run from a freshly populated contact. `name` is the exception — it cannot be cleared, and a blank or whitespace-only one is refused with `400 "Validation failed"`.

**The 404 is ambiguous, and reading it wrongly is how this shipped saying something false.** `"Contact person with id=N not found for customer with id=C"` is the answer *both* when the contact never existed or was already deleted *and* when the id is real but belongs to a different customer — measured, the same sentence word for word, because ids are scoped to the tenant rather than to the customer. A missing customer is a different message, `"Customer with id=C not found."` The first version of the translation matched the customer sentence case-insensitively, which the contact sentence also contains, so the commonest failure on these endpoints was reported as "the customer does not exist in this tenant" about a customer that was fine. The tools now name both readings and tell you to settle it with the list.

That ambiguity is also why the delete does not simply report a 404 as "already gone": a wrong `customerId` answers 404 while the contact survives, so claiming the job is done would be a guess. It reports what it knows — nothing was changed — and how to confirm which case it was.
