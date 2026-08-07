# Changelog

All notable changes to `reai-mcp`. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[semantic](https://semver.org/), pre-1.0 while the tool surface settles.

> **Nothing has been published to npm yet.** Install from source or run the
> Docker image. The version below describes what is on `main`.

## Unreleased

**98 tools**: 91 across nine accounting domains, plus 7 always-on.

### Added

- **Agreements toolset** (5 tools) — leases, employment contracts, purchase and
  service agreements: list, read, change terms, read signers, delete. Measured on
  the test tenant, and the headline is a trap the API documents nowhere.
  - `reai_update_agreement` exists because `PUT` on an agreement is a **full
    replacement**. On a live lease, a `PUT` carrying only the landlord's name left
    `monthlyRent`, `tenantName`, `depositAmount`, `depositAccountNumber` and the
    house rules all null — and `GET /pdf` still answered `200`, producing a
    document that looks like a contract with no terms in it. The tool reads the
    agreement, merges the requested changes over the existing terms and writes the
    whole thing back. That the round-trip is lossless was verified rather than
    assumed: the 78-key sub-object a GET returns was written back verbatim with no
    field changing value. Measured on the lease; for the other four the spec
    supports it — each Res/Req pair carries an identical property set, so there is
    no read-only field to send back — but only the lease was exercised live. It refuses outright if it cannot read the current terms,
    since a merge with no base is the destructive replacement it exists to prevent.
  - **Nothing is required**: `POST /api/agreements/rent-agreement {}` answers `201`
    with a draft in which every term is null, and the PDF renders for that too.
  - The identifier is `agreementId`, **not** `id` — the same shape of trap as
    `variantId` in warehouses, and it swallowed the first cleanup in this
    toolset's own measurement.
  - `GET /api/agreements/{id}` is a **wrapper** with five nullable sub-objects, one
    populated, so a lease's rent is at `rentAgreement.monthlyRent`. DELETE answers
    `204` with no body — no outcome field and no archive branch.
  - Some fields the schema types as plain strings are validated as enums the spec
    never lists; the API names the allowed set in its `400`.
  - Deliberately **not** curated: the five create endpoints (78 fields for a
    lease, 17-31 for the others, all documented by the
    spec documents, with every trap above now carried as a quirk), the three
    signing endpoints (they email a counterparty, so `reai_request` is the right
    route — the refusal there names what would have gone out), and the PDF
    download, following the invoice-PDF precedent.
  - Not enforced, and said so in the tools: Norwegian tenancy law caps a deposit at
    six months' rent and wants a statutory reason for a short fixed term. A deposit
    of 9 999 999 against a rent of 10 000 was accepted, as was a four-month fixed
    term with no reason. Refusing those would be this server inventing law.
- **Warehouses toolset** (7 tools) — warehouses, stock on hand, and stock
  adjustments. Everything in the tool text was measured on the test tenant by
  creating a warehouse and a stock product, adjusting stock, and reading the
  ledger before and after with a voucher lister that throws on a non-200.
  - `reai_adjust_inventory` **requires `variantId`**, which the API marks
    optional. An adjustment that omits it is accepted with `200` and a real
    `transactionId` while moving no stock at all — four consecutive `+3`
    adjustments left `quantityOnHand` at 0 — and nothing that can hold stock is
    exempt, because the API refuses a stock product with no variants. Requiring
    the field removes the failure mode instead of detecting it.
  - Two checks sit either side of the write. Before: the variant must be one of
    the warehouse's stock lines, which also supplies the quantity to measure
    against; a variant the warehouse does not track is refused with the valid
    ones listed. After: the API echoes the variant it acted on, and a **null echo
    against a variant that was sent** is the no-op signature — that check needs
    nothing from the pre-read, so it still holds when the inventory response
    cannot be read or matched.
  - It also accepts `yyyy-MM-dd` for `occurredAt` and completes the timestamp
    itself: the API's field is `date-time`, and a bare date is refused by the
    deserialiser with `400 "Failed to read request"` and no `fieldErrors`, so the
    error names neither the field nor the reason.
  - Measured and stated in the tool: an adjustment posts **no voucher**, stock
    goes **negative** without complaint (`-10` against 4 on hand gives `-6`), and
    no route lists or deletes a stock transaction, so the only correction is an
    opposite adjustment. That last one is why it is irreversible.
  - `reai_delete_warehouse` reports deleted vs archived. A warehouse holding 2
    units was archived and kept its stock; one whose adjustments netted back to
    zero was deleted outright — the trigger is current stock, not history.
  - `archived` on the list is a **filter**, not an include-toggle: archived=true
    returns only archived warehouses, and nothing returns both sets. Combined
    with the archive-on-delete behaviour, stock can sit in a warehouse the
    default list does not show.
- **Whole-spec guard for the external-send gate** (`test/transmit-coverage.test.mjs`),
  in three halves because none of them covers all three failures: enforcement
  derived from the policy (every transmitting operation refused by the real
  handler in every write mode, asserting the API was never reached and that in
  `full` mode the SEND gate is what refuses); coverage from an independent keyword
  sweep of the spec with reasoned exceptions; and named pins for the transmitting
  operations no other test mentions — seven Peppol paths and two that place a
  phone call. The derived half alone would have been the mistake this repo keeps
  making: it takes its own subject from the policy, so deleting a transmitting
  pattern shrinks the set and stays green.
- **A raw agreement PUT is now classified irreversible.** Codex's point was the
  decisive one: a quirk only reaches a `reai_request` caller when the request
  FAILS, and a partial PUT answers 200 — so the default mode still permitted
  silently clearing every term of a contract, which is the exact failure the
  curated tool exists to prevent. Gating the tool while the escape hatch allowed
  the identical call is the theatre this repo already rejected for reconciliation
  rules. Method-specific, following the `/api/attachments/{id}` precedent:
  creating an agreement stays reversible because it is additive and cleanly
  deletable (DELETE answers 204, verified). `reai_update_agreement` moves to
  irreversible in step — not because it is dangerous, it is the safe way to do the
  job, but because a curated tool must not be the soft route around a gate. The
  live suites now demonstrate the destruction rather than asserting it: the
  full-write run performs a raw partial PUT on a throwaway lease and confirms the
  other terms come back null.
- **The destructive annotation could not see inside an object-valued argument.**
  `hasEscalatingFields` probed each tool argument with scalars, so everything
  nested inside `changes` was invisible to it — `rentAccountNumber` and
  `depositAccountNumber` were live in the runtime gate while the tool advertised
  `destructiveHint: false`, and a client that confirms destructive calls would
  have shown redirecting a tenant's deposit account as an ordinary edit. The probe
  now also tries each escalating field name nested one level down, using a union
  exported from the policy rather than a copy, so a new escalating field cannot be
  added without becoming probeable. The invariant test calls the real probe rather
  than reimplementing it.
- Corrected in review, and worth recording because the claim was simply wrong: an
  earlier version of this entry said some agreement fields are "validated as enums
  the spec does not list". They ARE listed — `leaseDurationType` and `depositType`
  are declared enums with exactly the members quoted, and there are **14 such
  fields** across the five templates. The rejected values in the original probe
  were just wrong guesses. Since they are documented, they can be checked:
  `reai_update_agreement` now reads the enum members out of the spec index at call
  time and refuses a non-member locally, naming the allowed set, instead of letting
  the API answer with a 400 after the read. The members are lowercase snake_case,
  which is the part actually worth knowing.
- Five more review findings on the same tool, all fixed: the untouched-field count
  subtracted the change count, so a term set for the FIRST time was undercounted
  and an empty base printed "the other -1 field(s)"; `{}` is truthy, so an empty
  template sub-object passed the merge-base guard and produced exactly the
  destructive replacement the tool exists to prevent; the sub-object lookup fell
  back to declaration order when `templateType` was absent, which could report a
  lease's terms as living under `accountingServices` and, on a PUT response, emit
  "sent 13500, stored undefined" for a value that was stored correctly; the
  response diff now reads the key the REQUEST wrote to rather than re-scanning; and
  `reai_delete_agreement` deleted unconditionally while its own description said to
  prefer keeping a signed contract — it now reads the signing status first and
  refuses anything that is not a draft.
- Two over-claims softened rather than restated: "no archive branch" was inferred
  from the record leaving the list, which is exactly what an archived warehouse
  also does — and `GET /api/agreements` takes no `archived` parameter, so an
  archive would be invisible either way. And "exactly one sub-object is populated"
  became "the one named by templateType", with ambiguity reported instead of
  guessed. The husleieloven citations were made precise: § 9-3's effect on a short
  fixed term is that it counts as indefinite unless a statutory ground applies, not
  that it is rejected, and both rules are residential while the template also
  covers storage.
- **Four agreement quirks** carrying the traps above to a reai_request caller,
  since the five create endpoints and the signing flow are reached that way.
- **Six quirks** for the same measurements, so a `reai_request` caller gets the
  warnings the curated tools give — including `stock-product-needs-a-variant`,
  which is a `POST /api/products` rejection whose `fieldErrors` name a synthetic
  flag (`stockProductVariantSelectionValid`) rather than a field you can send.

- **Organisation toolset** (8 tools) — departments, employees and the employee
  ledger. `reai_list_postings`, `reai_general_ledger` and `reai_list_expenses`
  already took an `employeeId`, and nothing here could turn a name into one.
  - `reai_get_employee` **redacts** `nationalIdentityNumber` and `bankAccount`
    unless `includePersonalData` is set, and `reai_list_employees` omits them
    entirely. A default rather than a control — `reai_request` returns the raw
    record — but a question about who works here should not put a fødselsnummer
    into a model's context.
  - `reai_delete_department` reports whether the record was deleted or
    **archived**, which is the difference between a 200 that removed it and a 200
    that hid it. Departments have no unarchive endpoint.
  - Verified against the live API: the department create/read/rename/delete
    round-trip was run end to end on the test tenant, and `DELETE` answered
    `{"outcome":"deleted"}`.
  - No project tools. The Project module is disabled on every reachable tenant,
    so `GET /api/projects` answers 403 and the success path is unverifiable.

- **Fixed-asset toolset** (6 tools) — the register, its depreciation schedules,
  write-off and delete. What each write actually does was measured on the test
  tenant rather than read off the spec, and the spec implies more than happens:
  create, set-depreciation and write-off post **no voucher** on an asset with no
  accounting history. They stay irreversible because `/api/assets` has always
  been classified that way and because write-off on an asset carrying value
  could not be produced — not because of any depreciation-posting mechanism,
  since no operation in this API posts depreciation.
  - Deleting an asset that a voucher references is **refused with 409**, not
    reversed as the endpoint's own description claims. Verified by booking a
    voucher against an asset and deleting it.

- **Subscriptions toolset** (9 tools) — recurring billing: list, read, billing
  history, create, replace, activate, deactivate, bill-now and delete. The three
  fields that make a subscription reach a customer on its own —
  `outputMode: "create_invoice"`, `automaticBillingGeneration`, `sendEhf` — are
  refused unless the server runs with `REAI_WRITE_MODE=full` **and**
  `REAI_ALLOW_EXTERNAL_SEND`; a draft-order subscription that bills on request
  needs neither. `POST /api/subscriptions/generate-due` is deliberately not
  curated: it bills every due subscription at once.

### Fixed

- **A full-replacement write can erase a payment destination by omitting it, and
  the routing guard could not see that.** Found by sweeping the document for the
  shape that bit on agreements and asking which full-replacement writes the
  payment-routing rule cannot cover. (Worth being accurate about the method: "a
  PUT with no PATCH sibling" selected every PUT, because no path in this document
  has both verbs. What narrowed it to two was carrying an optional destination.) It escalates a body that
  CONTAINS a destination; a body whose danger is leaving one out is invisible to
  it. Two paths do exactly that, both measured on a live tenant with a rename as
  the intent:
  - `PUT /api/company-banks/{id} {name, countryCode, currency}` → `200`, `bban`
    **and** `iban` emptied.
  - `PUT /api/creditors/{id} {name}` → `200`, `bankAccountNumber` null.

  Both are now classified irreversible outright, so the default write mode cannot
  reach them. Creating either record stays reversible — adding an account diverts
  nothing, which is the reasoning company banks were already exempted on — and a
  quirk carries it to `reai_request`, where a `200` is otherwise the only signal.
  `/api/reconciliation-rules/{id}` carries a destination too and is deliberately
  NOT swept up: it requires the field, so omission is impossible. The full-write
  suite now demonstrates the clearing on a throwaway bank rather than asserting it.
- Two gaps this change does NOT close, named rather than left for the reader to
  infer from the general reasoning:
  - There is no curated tool for updating a company bank, a creditor or a
    supplier's address. Having gated the first two PUTs, the only route to a
    rename is `reai_request` in `full` mode — the mode that also unlocks vouchers,
    VAT and payroll — to perform an operation this change argues needs a
    read-and-merge. The agreements work shipped the merge tool alongside the gate;
    this did not. The quirk therefore names the SETTABLE fields rather than saying
    "echo the GET back", which does not transfer here: `CompanyBankRes` carries 18
    properties against `CompanyBankReq`'s six.
  - The invoice-delivery axis has the identical omission blindness.
    `INVOICE_DELIVERY_FIELDS` is presence-only, and `PUT /api/orders/{id}` and
    `PUT /api/subscriptions/{id}` are full replacements carrying an optional
    `invoiceEmail`, both still reversible. Omitting it stops delivery rather than
    redirecting it, so the harm is smaller and gating would make an ordinary order
    edit need `full` — a deliberate decision, with a test that records the set so
    it surfaces if it grows.
- **`reai_set_customer_address` silently dropped the parts it was not given.** The
  same shape on a smaller scale: the address PUT requires only `addressPart1`,
  `city` and `countryCode`, so a body carrying those three is accepted and empties
  the rest — measured, `postalCode "0150"` → null, `province "Oslo"` → null, second
  line emptied, on a `200`. An invoice addressed without a postcode is the visible
  consequence. The tool now reads the current address and merges, takes `null` to
  clear a part deliberately, sends back only the parts this endpoint accepts (an
  unknown field is refused outright), reads the DELIVERY address from its own field
  rather than the postal one, and refuses locally when neither the change nor the
  stored address supplies a required part.

- **Two operations that reach third parties were not on the send axis.** Found by
  auditing every operation in the spec, after the audit's own guard passed on all
  counts and review went looking for what it could not see. Both were permitted
  by `REAI_WRITE_MODE=full` with `REAI_ALLOW_EXTERNAL_SEND` unset — a documented,
  intended configuration.
  - `POST /api/users` **emails an access invitation**. `UserAccessRes.status` is
    `active | pending_invitation` with an `invitationId`, the request takes
    `{ email, roleCode, expiresInDays }`, and `GET /api/users/invitations` lists
    the pending ones: an expiring invitation the invitee must accept can only
    reach them by mail. The endpoint has no description, so the email itself is
    inferred from that shape — an easy call to fail closed on, because what it
    sends is privilege rather than data, and `roleCode` accepts
    `ROLE_TENANT_ADMIN` to an address the caller chooses. The write axis had
    already reviewed `/api/users` ("changes who can reach the books at all"); the
    send axis never had.
  - `POST /api/supplier-invoices/{id}/payments` can **start a real bank
    transfer**: its own description says `approvalUrl` "starts the BankID approval
    flow". Gated conditionally rather than outright, because the path is two
    operations in one — `manualPayment: true` records a payment that has already
    left the bank and sends nothing. Anything else, **including omitting the
    field**, selects the integration flow; that the default is the dangerous one
    is measured, not assumed, which is why the curated tool already required the
    field. `paidPrivately` alone does not exempt it: nothing says a sole
    proprietor's private account cannot also be paid through bank approval.
  - Gated in the curated tool as well as in the policy. `curatedArgsEscalate`
    does not consult `classifyTransmission`, so the policy rule alone left
    `reai_request` **stricter** than
    `reai_register_supplier_invoice_payment` — backwards, since the curated tool
    is what an agent reaches for. Routing it through that helper was tried and
    reverted: it reads a tool's arguments as an API body, so a report tool's
    `outputMode` read as arming a send. The tool now calls
    `assertTransmitAllowed` itself, as `reai_activate_subscription` already did.
- The refusal message listed "a document, email or signing request" while the axis
  had grown to cover money movement and an access invitation. A refusal that names
  the wrong kind of thing reads like a misfire, and an agent that thinks a gate
  misfired looks for a way past it.
- The README's `reai_delete_asset` row repeated the spec's claim that a linked
  acquisition voucher is "deleted **or reversed**", which the paragraph directly
  below it already contradicted and the tool's own description refutes: the call
  is refused with `409` and changes nothing.
- `delete-may-archive` covered `/api/warehouses/{id}` with the wrong trigger
  ("already has transactions"). Measured, it is current stock **on hand** — a
  warehouse whose adjustments netted back to zero was deleted outright, history
  and all — so warehouses now have their own quirk and are no longer listed under
  the generic one. Handing a `reai_request` caller the disproved version is worse
  than giving them no note.

- The `delete-may-archive` quirk was missing `/api/projects/{id}` and
  `/api/warehouses/{id}`, and said only customers could be unarchived — suppliers
  can too, and the others cannot, which makes an archive there one-way.
  (`/api/warehouses/{id}` was later removed from it again, on measurement: its
  trigger is stock on hand rather than transaction history. See
  `warehouse-delete-archives-on-stock` under Unreleased.)

## 0.3.0

First version worth using. Covers the bookkeeping core, sales, purchase, and bank
reconciliation and VAT, runs either locally over stdio or as a self-hosted remote
connector, and has been verified against live ReAI data throughout.

The jump from 0.2.0 is not new surface — the tool count is unchanged — but a large
number of safety fixes found by review, several of which were reachable in the
default configuration, and a handful of behaviour changes a client will notice:
`GET /mcp` now answers 405, request bodies are capped at 8 MB and JSON-RPC batches
at 50, an authorization not bound to a company is refused, and several tool schemas
reject input the API would have rejected anyway. Most of what follows was verified
by writing to a real test company rather than read off the spec, which is a
different standard from what the spec alone supports — and in five places the two
disagreed.

### Added

- **63 tools**: 56 across four accounting domains, plus 7 always-on
  (orientation and discovery, which no configuration can disable).
  - *Bookkeeping* (8) — chart of accounts, VAT codes, vouchers, postings, general
    ledger. `reai_create_voucher` checks the debit/credit balance locally and
    reports the exact imbalance rather than letting the API return a bare 422.
  - *Sales* (22) — customers, products, orders, offers, invoices, customer ledger.
  - *Purchase* (13) — suppliers, supplier invoices, the document inbox, EHF
    parsing, expenses, supplier ledger.
  - *Bank & VAT* (13) — company accounts, the reconciliation view, reconciliation
    rules, transaction matching and booking, VAT settlement, tax return.
- **Discovery escape hatch** (part of the 7 always-on) —
  `reai_search_endpoints`, `reai_describe_endpoint`, `reai_list_api_tags`,
  `reai_api_notes` and `reai_request` reach all 321 documented operations, so the
  264 with no curated tool are still usable.
- **A write policy**, which is the core safety contract. Every operation is
  classified `read` / `reversible` / `irreversible` and gated by
  `REAI_WRITE_MODE` (default `reversible`). Tools a mode forbids are never
  registered, so an agent cannot attempt them, and the escape hatch classifies
  each call by method *and* request body — an unrecognised write path fails
  closed.
- **Remote connector mode** — Streamable HTTP with a full OAuth 2.1
  authorization server: dynamic client registration (RFC 7591), authorization
  code + PKCE (S256 only), protected-resource metadata (RFC 9728), AS metadata
  (RFC 8414), refresh tokens. ReAI issues static API tokens and has no OAuth of
  its own, so the consent page bridges the two.
- **Sealed tokens instead of a session store.** The user's ReAI token, the tenant
  they chose and the write ceiling are encrypted into the access token with
  AES-256-GCM, purpose-bound so one token type cannot be replayed as another.
  Any instance can serve any request, which is what makes a scale-to-zero
  deployment practical with no database.
- **A tenant bound at authorization time is a boundary, not a default** — a grant
  scoped to one company cannot address another, even though the underlying ReAI
  token may reach dozens.
- **50 known API quirks** keyed to the operations they affect, surfacing
  automatically in discovery. Request shapes that differ from what an endpoint
  name suggests, constraints the schema omits, multi-step workflows, and
  operations that are harder to undo than they look.
- **`REAI_TOOLSETS`** to narrow the curated surface to
  `bookkeeping` / `sales` / `purchase` / `bank`. Orientation and discovery are
  never disabled.
- **`scripts/deploy-cloud-run.sh`** — one command, running as a dedicated service
  account with no project-level roles, pinning `PUBLIC_URL` and every hostname
  Cloud Run serves, and failing non-zero when the result is not actually
  reachable.
- **Four live verification harnesses**: `smoke.mjs` (read-only, safe against
  production books), `smoke-write.mjs` (a reversible round-trip), `smoke-http.mjs`
  (the whole OAuth flow as a real client) and `smoke-full-write.mjs` (posts and
  deletes a real voucher). All assert the negative cases too, not just the happy
  path. Both write scripts refuse to run unless the tenant is named in
  `REAI_WRITE_TEST_TENANTS` — a tenant id on the command line is not consent.
- A build step compressing the 907 KB OpenAPI snapshot into a 195 KB searchable
  index.
- CI across Node 20, 22 and 24, plus a check that the published package contains
  what it should.
- **`scripts/ci-local.sh`**, which runs everything that workflow runs, on every
  Node version in its matrix. Written during a multi-hour GitHub Actions outage,
  when no workflow could start at all — "wait for a green tick" is not a quality
  gate while the service producing the tick is down. It says outright that it is
  not a CI run, because it cannot reproduce the clean-room `npm ci` on Linux, and
  it skips-with-warning rather than silently passing when a Node version is
  missing locally.

### Fixed

Found by review — Codex on each pull request, plus independent subagent reviews.
Recorded because most were reachable in the default configuration:

- **The write policy could be bypassed four different ways in the path alone.**
  Classification ran on the raw string while the URL was built with `new URL()`,
  which resolves dot segments — so `POST /api/customers/../vouchers` was classified
  against the reversible `/api/customers` prefix and posted to the general ledger.
  Percent-encoding did the same thing more quietly: `%74` for `t` turned
  `sign-request` into an unrecognised sub-path of the reversible `/api/agreements`,
  and the call still landed on the endpoint that emails a counterparty — every guard
  in the file reduced to a spelling convention. Matrix parameters (`;a=b`), a
  trailing dot and a doubled slash each lost the escalating-segment match the same
  way. A request is now read in every form it could route as — literal, percent-
  decoded, and as a router would normalize it — and the strictest answer wins.

- **A curated tool could repoint a supplier's bank account in the default mode.**
  The body-level guards ran only in `reai_request`; curated tools were gated on
  their declared risk alone. `reai_update_supplier` is `reversible` and takes
  `iban`, `bankAccountNumber` and `swiftCode` as ordinary arguments, so it did what
  the escape hatch refused for the identical `PATCH`. Nothing transmits and nothing
  posts, so no other guard fired: the loss lands later, when a person pays that
  supplier through the ReAI UI. Its own description had promised those fields
  required `full` mode, which nothing enforced — a documented control that does not
  exist is worse than none. Arguments are now classified with the same rules as
  bodies, across `iban`, `bankAccountNumber`, `swiftCode`, `accountNumber`, `bban`
  and `invoiceEmail`.

- **An array wrapper defeated every body guard.** `PATCH /api/suppliers/5` with
  `{"iban": …}` was refused; the same call with `[{"iban": …}]` was permitted,
  because all three inspectors returned early on an array. No operation takes an
  array body today, so this was latent — but `reai_request` forwards whatever it is
  given, so it would have become live the day ReAI added a bulk endpoint.

- **Values were judged by their JavaScript type rather than what they bind to.**
  The backend is Spring with Jackson, not ASP.NET as the comments claimed, and
  Jackson coerces `"true"` and `1` to `true` and accepts an integer ordinal for an
  enum. So `{"sendEhf": "true"}` armed an external send that the policy scored as
  sending nothing, and `{"outputMode": 1}` armed recurring invoice issuance. Two
  tests asserted the old behaviour outright, which is how the gap survived.
- **A supplier payment could start a real bank transfer.** `manualPayment` was
  optional and the API defaults it to `false`, selecting the bank-integrated flow
  that can return an approval URL beginning a BankID payment — while the tool
  described itself as merely recording an already-paid invoice. It is now
  required, and an approval URL is reported as *not yet paid*.
- **The VAT tool claimed to file returns.** `POST /api/vat-returns` settles and
  locks the period; it submits nothing to Skatteetaten. Retitled, with the
  distinction stated in the description and the success message.
- **A lost response could book a voucher twice.** The client retried any request
  on a gateway error or timeout, including `POST /api/vouchers`, which has no
  idempotency key — so a write that ReAI had already committed could be repeated,
  and the duplicate cannot simply be deleted once the period closes. Retries after
  an *ambiguous* failure are now limited to methods where repeating is harmless;
  `429` is still retried for every method, because it is rejected before being
  processed. `REAI_MAX_RETRIES=0` also works now — it was rejected by a shared
  "must be positive" check, which made the safest setting unexpressible.
- **A partially numbered voucher hit the row-merge error it was meant to prevent.**
  Row assignment bailed out as soon as *one* posting carried a `rowNumber`,
  leaving the others defaulted to row 0; an explicit row 0 plus an unnumbered
  posting with a different description then failed to merge. Explicit rows are now
  honoured while unnumbered postings are fitted around them.
- **Refresh tokens could be rolled forward indefinitely.** Grants now carry an
  authorization time and are clamped to a 90-day absolute ceiling.
- Two questions the tools advertised answering were answered wrongly: "who owes
  us money" and "what is overdue" both silently excluded items older than a
  recent window.
- Subscriptions with `outputMode: "create_invoice"` and reconciliation rules are
  now treated as irreversible, because both let ReAI issue postings with no
  further call.
- Quirks matched by prefix, so parent advice leaked onto unrelated
  sub-operations — `POST /api/invoices/{id}/email` was told to send an `orderId`.
  Matching is exact unless a quirk opts into descendants.
- Cloud Run serves a service on more than one hostname, and the OAuth flow
  completed on an alias before every MCP call failed with `Invalid Host header`.
  All hostnames are now allowed.
- `reai_use_tenant` was a no-op in stateless remote mode: it reported success and
  the next request discarded it.

Found by a second round of review, aimed at ground the first had not covered —
the HTTP transport, the build and deploy pipeline, and the result formatter:

- **A grant with no bound tenant had no tenant boundary at all.** The write mode
  was re-clamped against current config on every request, for the right reason: a
  sealed grant is unforgeable but not fresh. The tenant was never re-checked, and
  the binding was applied only when the grant carried one — so a grant issued
  before the consent flow began failing closed reached every company its ReAI
  token could see, stayed valid for the full 90-day ceiling, and was re-minted on
  every refresh. Both redemption and refresh now refuse them.
- **The deploy script's `--env` silently overrode its own safety gates.** gcloud
  keeps the last occurrence of a key, and extra pairs were appended after the
  script's own, so `--env REAI_WRITE_MODE=full` bypassed the confirmation prompt
  and `--env REAI_ALLOW_EXTERNAL_SEND=1` armed EHF/Peppol — while the closing
  summary printed the safe values, because it read local shell variables. Managed
  keys are refused with a pointer to the real flag, and verification now reads the
  deployed revision back.
- **`REAI_ALLOW_TOKEN_PASSTHROUGH` survived redeploys** onto a service this script
  always publishes `--allow-unauthenticated`, which is the one combination the
  README says never to create. Reset on every deploy unless passed again.
- **One POST could take the container down.** `/mcp` handed the raw stream to the
  SDK, which parses with no limit; a 400 MB body exhausted the heap. Capped at
  8 MB. A JSON-RPC batch was unbounded too — 1000 entries produced 1000 concurrent
  upstream calls, and the write policy is applied per call, so it never saw the
  aggregate. Capped at 50.
- **An oversized body wedged the connection**, unauthenticated: it answered
  nothing further and was not closed either, sitting open until the 128-second
  socket timeout. Now 413 and closed — and delivered reliably, which took draining
  the body before answering, since closing with unread data makes the OS send RST
  and an RST discards the response already in the client's buffer.
- **Enums were published truncated and unmarked**, at 8 values in the index and 12
  in `reai_describe_endpoint`. `GET /api/vouchers` advertised 8 of its 16 voucher
  types, so an agent asked for VAT-return vouchers would conclude the filter did
  not exist. Array-valued enums lost their values entirely.
- **The spec-index builder had no assertions**, so a spec that lost its tags built
  cleanly as "430 operations, 0 public" — an empty discovery surface, exit 0. It
  now fails rather than writing a plausible degraded index.
- **Truncation could return an empty body** under a note describing content that
  was not there: plain text has no line boundary to cut back to, so a 40,000-
  character response came back as the note alone.
- **`GET /mcp` opened an SSE stream that could never carry anything** in stateless
  mode, with no server-side lifetime — 400 concurrent held GETs consume the
  per-instance concurrency Cloud Run allows. It answers 405, which the spec
  permits.
- Protocol-relative request targets (`//mcp`) routed by their authority rather
  than their path, so a POST to what a client believed was the MCP endpoint was
  answered with the HTML status page.

### Changed

- **Eight operations hidden by the `*-ctrl` tag heuristic are now discoverable.**
  The heuristic is right about the other 77 — UI typeahead, Adyen and Shopify
  webhooks, point-of-sale auth — but registering a payroll payment is not an
  undocumented internal, and hiding it made an agent report the capability as
  absent, which is worse than refusing because it is false. Five further
  candidates were dropped for duplicating a documented endpoint and one for taking
  an object-valued query parameter `reai_request` cannot send; both rules are
  enforced by tests. This does not widen what may be called: `internal` is a
  discovery flag, not a policy boundary, and every one of the writes classifies as
  irreversible, so the default `reversible` mode still refuses them.

### Known limitations

- **What the API enforces, and what only this server enforces** — measured with a
  user-scoped token, and worth separating carefully because an earlier version of
  this entry ran the three together.

  *Selection* works: `GET /api/chart-of-accounts` under two of the token's own
  companies returned different payloads (76,313 vs 89,238 bytes), so `X-Tenant-Id`
  chooses the company rather than being decorative.

  *Isolation* works: the same call with a tenant id the token does not reach
  (`99999999`, `1`) returns **403**, so the API refuses a company the token has no
  access to.

  *The per-authorization binding does not come from the API.* A remote connector
  grant scoped to one company is enforced **here only** — ReAI sees the underlying
  user token, which legitimately reaches every company on it, so it cannot tell
  that a given authorization was narrowed to one. Calling that an API-enforced
  boundary would be a false assurance.

  And for a **tenant-scoped** token none of this applies: the header is ignored, any
  id returns that one company's data, and an apparent cross-tenant read has not
  happened. `scripts/check-token.sh` reports which case a token is in and runs all
  three probes.

- **Individual tokens cannot be revoked** before they expire. Sealed tokens carry
  no server-side record, so rotating `REAI_ENCRYPTION_KEY` — which invalidates
  every authorization at once — is the remedy.
- **Serving under a path prefix is unsupported.** A `PUBLIC_URL` containing a
  path, query or fragment is rejected at startup rather than half-working.
- **The production dependency tree is clean.** Both advisories that came through
  `@modelcontextprotocol/sdk` are resolved by `package.json` overrides: `fast-uri`
  pinned to 3.1.5 (HIGH — host confusion via a backslash authority introducer) and
  `hono` to 4.12.34 (MODERATE — ReDoS in CORS middleware). `npm audit --omit=dev`
  reports nothing, and CI enforces that at `--audit-level=moderate`.

  Worth recording how the second one landed, because the mechanism has a sharp edge.
  This project installs under a 7-day minimum-release-age policy, so `hono@4.12.34`
  (published 2026-08-03) was not installable on the 7th. Overriding it needs
  `npm install --min-release-age=0`, and with the age check off a caret range takes
  whatever is newest: `^4.12.34` resolved to `4.13.1`, published four hours earlier.
  That is exactly the exposure the policy exists to prevent. Both overrides are
  therefore EXACT pins rather than ranges.

  The bypass also has to be narrow, which took two attempts. Deleting the lockfile
  and reinstalling under the flag re-resolves everything, so `@hono/node-server`,
  `express-rate-limit`, `ip-address` and `jose` were all upgraded without the age
  check — a much wider exception than the one intended. Starting from the existing
  lockfile and adding only the override changes exactly one line. And the flag is
  used once: `npm ci` installs from the lockfile and needs no bypass, so CI never
  resolves under a relaxed policy.


- **No sandbox exists** for ReAI. Write paths are therefore verified against a
  real but empty tenant, and two of them remain untested end to end: issuing an
  invoice or credit note (it transmits, and cannot be recalled), and settling a VAT
  period or filing a tax return (both change a real company's period state).

  A manual **supplier payment** is now covered, which previously was not. The
  hazard there was never the record but the flow: `manualPayment: false` selects the
  bank integration and can return an approval URL that begins a BankID transfer.
  With `manualPayment: true` the API handles it manually, and the suite asserts the
  response carries no `approvalUrl` rather than trusting that — an approval URL being
  exactly the signal that a transfer is waiting on a human. Customer and salary
  payments stay out: the first needs an issued invoice, which transmits, and the
  second pays a person.

  Everything else — ledger postings, the supplier-invoice chain, bank accounts and
  reconciliation rules — has been posted to live books and cleaned up again, with the
  tenant verified empty afterwards.

## 0.1.0

Initial scaffold. Never published.
