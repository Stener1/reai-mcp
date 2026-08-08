# The write policy in detail

`REAI_WRITE_MODE` classifies every operation as read, reversible or irreversible, and
[the README](../README.md#safety-this-writes-to-real-accounting-books) states the three modes and the
two properties that make them more than a label. This page is the reasoning underneath: the two
places where an *apparently* reversible call destroys something, how each was found, and what the
gates do about it. Every measurement here was taken against a live ReAI tenant, because there is no
sandbox.

## A full replacement can erase where money goes by leaving it out

Two endpoints replace the whole record and do **not** require the account number, so a body that satisfies the schema without mentioning it clears it. Measured on a live tenant, both with a rename as the intent:

```
PUT /api/company-banks/{id} {name, countryCode, currency}  → 200, bban AND iban emptied
PUT /api/creditors/{id}     {name}                          → 200, bankAccountNumber null
```

This defeats the routing rule below, which escalates a body that *contains* a destination — it cannot see one whose danger is the omission. Both PUTs are therefore classified **irreversible** outright, creating either record stays reversible (adding diverts nothing), and a quirk tells a `reai_request` caller, because a `200` says nothing. `reai_set_customer_address` had the same shape on a smaller scale — the address PUT requires only street, city and country, so setting a street emptied the postcode — and it now reads the current address and merges.

### And the escape hatch now refuses to send one blind

Naming the two worst instances is not the same as covering the class. Sweeping the document turns up **31 public `PUT` endpoints that can clear at least one documented field by omission**, and only 15 of them have a curated tool — the other 16 are reachable solely through `reai_request`, which cannot merge on a caller's behalf. Every instance of this bug in this repo was found *after* the write, on a live tenant, so a warning attached to the response is a post-mortem rather than a control.

So `reai_request` now refuses a `PUT` whose body omits documented optional fields, and names them:

```
PUT /api/company-banks/1561 REPLACES the record, and this body leaves out 3 of its 6
documented field(s), which the API stores as empty:

  bban, swiftCode, excludeFromReconciliationTodos

Nothing was sent.
```

Two ways past it, both deliberate: `GET` the record, merge your change over it and send the whole thing — which is what the curated tools do — or pass `clearOmittedFields: true` when emptying those fields is genuinely the intent. Verified on the live tenant in both directions: after the refusal the account number was still `"15201353103"`, and the same call with the flag set left it `""`.

Three details worth stating, because each is a decision rather than an omission:

- **`PATCH` is never checked.** Measured, `PATCH` on this API really does patch — a body carrying only `phone` left an employee's address, bank account, start date and employment lines untouched. Gating it would refuse ordinary partial updates on a rule that does not hold there.
- **Required fields are excluded.** The API rejects a body missing one and `missingRequired` already explains that; listing them here would bury the fields that get *silently* dropped, which are the only ones a caller cannot otherwise find out about.
- **The write policy speaks first.** A call the current write mode forbids is refused for that reason, not for this one — otherwise an agent goes after the wrong permission.
- **Both path forms are resolved.** ReAI decodes before routing and this server does not: `GET /api/company%2Dbanks` and `GET /api/employe%65s` both answer `200`, while the spec lookup matches the literal string. So the first version of this gate resolved nothing for an encoded path and therefore refused nothing — `PUT /api/company%2Dbanks/{id}` with a partial body went straight through and cleared the account number. Caught in review, and fixed the way the write ladder already handled it: resolve every form the request might route as. Verified live — the encoded call is now refused and the account number is untouched. The same blind spot was silencing the quirk note on successful writes reached that way.

## How the payment-destination field set was checked

[The README](../README.md#changing-where-money-goes-is-treated-as-irreversible) states the rule and
the field set it applies to. This is how that table came to be trusted.

Two of its entries were found by checking the table against the API rather than trusting it, and the process is now a test (`test/payment-routing.test.mjs`) that reads the OpenAPI document on every run:

- **Employees were missing.** `PATCH /api/employees/{id}` accepts `accountNumber` — the account that employee's salary is paid to — and was classified as ordinary reversible master data. That is the sharpest member of this whole class, not a footnote: salary is paid on a schedule, by machinery nobody re-examines, and the person who notices is the employee whose pay did not arrive.
- **`swiftBic` and `routingNumber` were missing.** The field set was written against the supplier schema, which spells the same concepts `swiftCode` and `bankAccountNumber`. The supplier-invoice payment details use different names for them, so those writes went undetected.
- And the `/api/supplier-invoices/{id}/payment-details` sub-resource this table used to name **does not exist in the API**. The payment details are written through the invoice itself, which was not listed. No call was ever misclassified — creating or editing a supplier invoice is already irreversible by path — but the protection was pointing at nothing.

- **A lease's rent and deposit accounts were missed too**, and nearly dismissed. `PUT /api/agreements/rent-agreement/{id}` carries `rentAccountNumber` and `depositAccountNumber` — the accounts a tenant pays rent and their deposit into, which Norwegian law requires to be a separate escrow account. Both are bare strings, which is what made them look like ledger codes; it is in fact the evidence *for* them, since `AccountNumber` is documented as "Base chart of accounts number" and every genuine ledger field in the document `$ref`s it. These sit among `monthlyRent`, `rentDueDayOfMonth`, `depositAmount` and `guaranteeIssuer`.

The distinction the test has to make is that `accountNumber` means different things in different places: on an employee it is a bank account, on `POST /api/assets` it is a balance-sheet code the spec pins to `pattern: 1\d{3}`. Escalating the latter would refuse an ordinary booking with "this changes where a payment will go" — and a refusal that is false teaches an operator to distrust the true ones. So every routing-shaped field name in the document is either treated as a destination or explicitly exempted with its evidence, and a new one that is neither fails the build.

The one thing that guarantee does *not* cover: a field named simply `account`. The document already uses `account`, `creditAccount` and `debitAccount` for chart-of-accounts codes, so the scan cannot match bare `account` without burying the real signal — and the test names that blind spot rather than leaving it implied. Inward-facing records follow the company-bank rule: creating one is ordinary work, repointing one is not.

This was a real gap rather than a hypothetical: `reai_update_supplier` is declared `reversible`, its description promised that the bank fields "require `REAI_WRITE_MODE=full`", and nothing enforced it — while `reai_request` refused the identical `PATCH`. A control that is written down but not implemented is worse than none, because it invites running the default mode believing the fields are protected.

The same re-gating now covers the fields that **arm a send**, not only the ones that redirect money. `sendEhf`, `automaticBillingGeneration` and `outputMode: "create_invoice"` escalate a curated tool exactly as they already did through `reai_request`. No shipped tool accepts one of them, so nothing was ever reachable — the gap was found while designing a subscription tool that would have been the first, which is a better moment to find it than after shipping. A test checks the mechanism against a tool of that shape rather than only sweeping today's tools, because a guard that passes vacuously is not a guard.

## The three curated merge tools

Each of these wraps a PUT that replaces rather than patches, on a record carrying a payment destination that the schema does not require — so the body a rename produces is accepted and empties the account. Measured: `PUT /api/company-banks/{id} {name, countryCode, currency}` → `200`, `bban` emptied; `PUT /api/creditors/{id} {name}` → `200`, `bankAccountNumber` null. All three read the record first and merge. For the company bank the question that matters is not whether the six settable fields survive being written back — they are what is sent — but whether omitting the other twelve resets them. Measured: after a rename, `manual`, `active`, `providerType`, `eligibleForPaymentCreation` and the rest came back unchanged, and only the derived `displayName` moved. `defaultForOutgoingPayment` was false throughout and no endpoint sets it, so that one is unverified.

The two account-carrying ones need `REAI_WRITE_MODE=full`, because the raw PUT can destroy a destination and a curated tool must not be a softer route to it. `reai_update_company_bank` additionally **refuses** to clear `bban` even when asked — an account with no number cannot be used for payments or reconciliation, so deleting the account is the honest way to retire it.
