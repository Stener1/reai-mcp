# Changelog

All notable changes to `reai-mcp`. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[semantic](https://semver.org/), pre-1.0 while the tool surface settles.

> **Nothing has been published to npm yet.** Install from source or run the
> Docker image. The version below describes what is on `main`.

## Unreleased

**145 tools**: 138 across eleven accounting domains, plus 7 always-on.

### Added

- **The `-en`/`-et` definite class too**, which the first version of this work left out and which is
  the bigger of the two. `reiseregningen`, `beholdningen`, `kontoen`, `utgiften`,
  `innbetalingen`, `dokumentet`, `vedlegget`, `tilgangen` and `refusjonen` all returned **nothing
  at all**; they now reach expenses, inventory, the chart of accounts, the customer ledger,
  documents, attachments, permissions and refunds respectively. Inflection invariance across the
  whole synonym table is now **169 of 174 keys** whose definite form resolves as well as the bare
  one.
  - Free of regression by construction, which is what made extending cheap: the same gate applies,
    so the stem must be a key. `token`, `given`, `budget` and `asset` derive nothing, because
    `tok`, `giv`, `budg` and `ass` are not words this table knows. Verified against `main` on the
    English cases the ungated rule had broken — `annual return`, `vat return`, `product
    documentation`, `transaction product` all rank as they did before any of this.
  - Both rules mutation-tested individually. The `-et` half had no test at first: removing it left
    every other case passing.

### Fixed

- **Six findings from an independent review of the definite-form work**, all live:
  - A comment claimed the length guard was what kept `lån` from being stripped. It is not — the
    **gate** is, since `lå` is not a synonym key, and removing both length guards leaves the whole
    suite green. That is the same failure this changelog credits an earlier review with catching: a
    comment asserting something is load-bearing when it cannot be reached. The fix commit had
    appended a new paragraph instead of correcting the false sentence.
  - The definite-article test asserted `rank < 5` where every row ranks its target **first** in both
    forms — four ranks of slack, in a test named "the definite article does not change the answer".
    It asserts equality now, as the word-order test it cites as its model already did.
  - One row was worse than nothing: it asserted `anleggsmidler`, the indefinite **plural**, which is
    its own synonym key — so it passed on `main`, exercised neither rule, and read as if the
    stem-changing class were covered. Replaced with live `-en` and `-et` cases; the real limit
    (`anleggsmiddel` → `anleggsmidlet` drops a vowel) is stated where that row used to be.
  - The gate test's second row was inert — identical top-3 with and without the gate. Replaced with
    two cases the ungated rule actually broke, both of which had ranked the annual income-tax return
    above the right answer.
  - A test pinned a **create** as the answer to a **terminate**: *"si opp leieavtalen"* means
    terminate a lease, and the asserted target creates one. Not a regression — `main` ranked it the
    same — but a passing test made it ground truth. Rephrased to a question the endpoint can answer.
  - "A quarter of the synonym keys" overstated the affected population: 44 of 176 keys end in `-e`,
    but 25 of those are verbs, adjectives or plurals that take no definite article. The
    definite-able `-e` nouns were **19 of 176**, roughly one key in ten.
  - The third corpus's top-10 floor is ratcheted 23 → 24, locking in the case the rules earned.

- **Norwegian definite forms resolve.** The definite article is a suffix, and it is how people
  actually speak: *"send fakturaen"*, *"endre kunden"*, *"si opp leieavtalen"* — nobody says
  *"send faktura"*. Most definite forms already worked by accident, because the compound-stem
  rule finds `faktura` inside `fakturaen`. But it requires two characters left over, and the
  commonest Norwegian noun class ends in `-e` and takes a single `-n`: so `kunden`, `ordren`,
  `leieavtalen` and `husleien` returned **nothing at all**, which is a quarter of the keys in
  the synonym table.
  - `-n` and `-ne` suffix rules cover that class. *"endre kunden"* now ranks
    `PATCH /api/customers/{id}` first where it previously found no endpoint; the three corpora
    are unchanged at 39/41 and 26/28, with the third gaining a case within the top ten (23 → 24).
  - Asserted as a **property**, the way word-order independence already is: inflection must not
    change the answer. Both rules are mutation-tested, and the `-ne` rule's test case was chosen
    by measurement — `kundene`, `leverandørene` and `fakturaene` all resolve by other paths, so a
    test built from those would have passed with the rule deleted. `avtalene` is the one that
    needs it.
  - The rules fire **only when the stripped stem is a synonym key**, which review made necessary
    and is better than the precaution it looks like. Blind stripping also turned
    `documentation` into `documentatio`, and `matchStrength` matched both forms against the same
    endpoint token — so one word counted twice and *"product documentation"* ranked the
    document-reception endpoints above every product endpoint, **worse than not having the rule
    at all**. A derived form that is not a key buys nothing and can only distort. Pinned by a
    test that fails with the gate removed.
  - Two limits are stated rather than hidden. A **stem-changing** definite is out of reach
    (`anleggsmiddel` → `anleggsmidlet` drops a vowel), so that case is written into the test as
    an exclusion with the reason. And the length guard that stops `lån` being stripped to `lå`
    is **precautionary**: relaxing it breaks no query I can find, so the test says it does not
    prove the guard — the same mistake a review caught here before, where a comment claimed both
    halves of a check were load-bearing when one could not be reached.

- **Norwegian action vocabulary, enumerated from the API's own action segments.** The synonym
  table was all nouns. The API has **65 segments hanging off a resource instance** —
  `/{id}/approve`, `/{id}/deliver`, `/{id}/depreciation`, `/{id}/close`, `/{id}/unarchive` and
  so on — and not one had a Norwegian verb, so *"godkjenn utlegg"* ranked `/api/expenses`
  first and `/api/expenses/{id}/approve` fifth. Both the imperative and the verbal noun are
  covered, since a Norwegian query uses either (*"godkjenn reiseregningen"*, *"til
  godkjenning"*).
  - Enumerated from the spec's action segments rather than from any benchmark's phrasings —
    the difference between covering a category and fitting a score.
  - **Half of it was missing at first**, and review found it: the words went into the synonym
    table but not into `METHOD_INTENT` and `WRITE_INTENT_VERBS`, which the file's own comments
    say must be kept in step. So *"aktiver abonnement"* expanded to `activate`, matched the
    right path segment, and still lost to three `GET`s because nothing said a write was
    wanted — `/activate` ranked fifth. Routing the imperatives through those tables put it
    first and lifted **all three** corpora: 36 → 39, 23 → 26, 18 → 20. Verbal nouns and
    participles stay out (*"hvilke venter på godkjenning"* is a question, *"avsluttet"* is a
    participle), as those tables' own exclusions require.
  - **And that spent the second corpus as a measurement**, which is said plainly where it
    used to claim otherwise: I read its failures before doing this work, so it is a regression
    floor now, exactly like the tuned one, and its floor moved to 25 to match.

- **A third corpus, written afterwards and measured once.** Different angle again: questions a
  business owner asks their bookkeeper, and instructions a bookkeeper gives the system — half
  naming an action, half plain reads, so the score says something about both.
  - The honest sequence, corrected after review pointed out that my "first measurement" was
    taken with the action vocabulary **already applied** and so was never a baseline:
    **14 of 28** on `main` → 16 with the action words → 18 after fixing the empties → 20 once
    those words reached the method tables → **19 of 27** after removing three homograph
    collisions. So what the vocabulary generalises to is **+2 of 28 on a corpus it was not
    fitted to** — the same +2 it bought on the one whose failures I had read. That is the
    number worth quoting and the PR did not state it until review worked it out.
  - The last step is a deliberate **loss** of one case. Keeping `aktiver` would have held this
    corpus a case higher while answering *"hvilke aktiver har selskapet"* with a subscription
    activation. A corpus is a proxy; that is a real question. Those two were
    `land` — the plainest way to ask which countries the API accepts, whose vocabulary was
    never added when the country list became a tool — and `skylder` (owes), for *"hvem skylder
    oss penger"*, which is the customer ledger.
  - Same rule as before, and it is the whole discipline: an empty result strands an agent and
    is worth fixing; a right answer at rank five is not worth tuning for.
  - **Six words were removed on semantic grounds, not string grounds**, every one found by
    review. Three are accounting errors:
    - `nedskriv` (impair — write the value down, keep the asset) had been mapped to
      `POST /api/assets/{id}/write-off`, which takes no amount and is the **destructive
      disposal** for something scrapped, lost or sold. *"nedskriv maskinen"* would have
      steered an agent toward disposing of the machine. There is no write-down endpoint, so
      the word maps to nothing — the same call as `valutakurs`, where a confident wrong answer
      is worse than no result.
    - `underkjenn` (reject a claim) had been mapped to `/unapprove`, which by its own
      description returns an **already approved** expense to `for_approval` and is refused
      otherwise. Rejecting a pending claim has no endpoint at all.
    - `åpne` alone is an adjective as often as an imperative: *"åpne poster"* — open items,
      i.e. unpaid — is a read, and the mapping put three mutating
      `POST /api/postings/*/open` operations above `GET /api/postings/groups`. `gjenåpne`
      carries the meaning unambiguously.
  - And three are **homographs** that made the ranker worse than before this PR — the only net
    regressions it introduced, each verified against `main`:
    - `levere` is how a Norwegian **files a return**. *"lever mva-meldingen"*, *"levere
      skattemeldingen"* and *"lever årsregnskapet"* were all answered correctly before and all
      pointed at `POST /api/expenses/{id}/deliver` after — `deliver` exists on exactly one
      endpoint in this API. The expense sense survives as a phrase mapping, where the object of
      the verb can be seen; the bare word maps to nothing.
    - `aktiver` is the balance-sheet noun for **assets** (*aktiver og passiver*) as well as the
      imperative. *"hvilke aktiver har selskapet"* ranked a subscription activation. Removed;
      `aktivere` carries the verb sense, and the unambiguous noun `aktiva` was added.
    - `avslutt` means **terminate** — an employment, a lease — not close a period.
      *"avslutt arbeidsforholdet"* ranked the bank-reconciliation close endpoints. Removed;
      `lukk`/`lukke` carry the period sense.
    - All three also came out of `METHOD_INTENT` and `WRITE_INTENT_VERBS`, where they would have
      implied a write on a read question — the same trap those tables already document for `lag`
      (a team) and `betal` (from *"hvilke betalinger"*).
  - Two claims here were **overstated and are corrected**: the table was not verbless
    (`avstemme`, `reconcile`, `signing`, `owe`, `owes` were already in it, and `skylder` is a
    translation of `owes`), and the API does not have 65 *action* segments — it has 65 distinct
    trailing segments after a path placeholder, of which roughly 25–30 are actions and the rest
    are sub-resources like `address`, `attachments` and `pdf`. About a dozen real actions still
    have no Norwegian word.
  - `skylder` (owes) is **direction-neutral** now. Hard-coding the customer side ranked both
    customer-ledger routes above the supplier ledger for *"hva skylder vi"* — the opposite
    side of the books. The direction lives in `PHRASE_SYNONYMS`, which can tell *"skylder
    oss"* from *"skylder vi"*.
  - Five of the thirty targets I wrote named endpoints that **do not exist** — no
    `/api/offers/{id}/convert`, no `/api/vat-returns/{id}/submit`, no
    `/api/warehouses/{id}/name`, no `/api/invoices/{id}/register-payment`, and validation only
    on tax returns. Three were repointed, two dropped. That is the fourth time in this work a
    "ranking failure" turned out to be my own wrong assumption about the API — and a **sixth**
    target was wrong in a way the existence check could not catch: `nedskriv maskinen` pointed
    at an endpoint that exists and means something else. Dropped, leaving 27 cases.

### Fixed

- **The bounds sweep gained its third leg — PATH parameters — and the first thing it found
  was mine.** `reai_get_annual_accounts` shipped taking the fiscal year as a **number**
  while `reai_get_tax_return` and `reai_create_vat_return`, which take the same fiscal year,
  both take a four-digit **string**. An agent using two of the three in one session had to
  guess which wanted `2025` and which wanted `"2025"`. All three agree now, and the test
  pins the property rather than three separate bounds: whatever the convention is, every tool
  taking a year shares it.
  - The synthesized payload carries `year` as a **number on both branches**, matching the
    API's own `AnnualAccountsSubmissionRes.year`. Echoing the string argument would have made
    a consumer's field change type with the outcome — the same cross-branch inconsistency
    `submissionExists` was fixed for.
  - A shared **`fiscalYear`** schema in `registry.ts` is what makes the three agree, rather
    than three copies compared by a test after the fact. It requires **1000 or later**, not
    merely "greater than zero": four digits alone admitted `"0000"`, which every one of these
    parameters rules out with `exclusiveMinimum: 0`, and a bare positive check still admitted
    `"0999"` — which this tool converts with `Number()` and would have reported as year **999**
    for a request to `/api/annual-accounts/0999`, losing the round-trip the conversion exists
    to preserve. The sweep no longer skips year parameters outright, which is exactly why that
    escaped it: a year argument must now refuse a leading-zero year and accept a real one.
  - Both directions are swept: no tool refuses a path value the API accepts, and no tool
    accepts an id below the spec's floor. Mutation-tested — reverting the year to a number
    names the disagreeing tool, and dropping `.positive()` from any path id names it with the
    values it wrongly accepts.
  - **A renamed placeholder is no longer a blind spot.** Skipping every path parameter whose
    tool argument has a different name left 11 of 109 unswept, and seven tools could lose
    `.positive()` on `assetId`, `departmentId` or `warehouseId` with the whole suite green.
    Eight of the eleven resolve structurally — one path parameter, one `…Id` argument, nothing
    else it could be — and the remaining three are listed by name so the blind spot cannot grow
    in silence. The floors sit near the measured values now (100 of 107 operations, 90 of 98
    arguments) rather than at half of them: last iteration's lesson was that slack is where
    coverage disappears.
  - Two things are deliberately **not** enforced, each pinned as a test so the absence is a
    decision on the record and not a gap nobody noticed. **int32 ceilings**: 231 path
    parameters declare `format: int32` (167 distinct path+name pairs) and **67 distinct tool
    arguments** accept 2147483648; adding `.max(2147483647)` to each would be 67 edits for a
    value no caller reaches by accident, against a clear upstream `400`. The test counts
    distinct arguments rather than occurrences — counting occurrences meant one tool
    contributed six of 84, so ceilings could have been added to 59 of the 67 while the failure
    message still claimed none had been. Membership of the int32 range
    is the API's to judge — the same division of labour `reai_list_countries` documents for
    country codes. **The letter of `exclusiveMinimum: 0` on a string-typed year**, which would
    admit `"1"` and `"40000"`; four digits is narrower than the spec and different in kind
    from the floor of 2000 that an earlier version had, which excluded 1999.

- **A 404 that names the wrong problem**, found while looking for a manual bank account to
  build tools against. `GET /api/manual-reconciliations/{bankAccountId}` answers
  `404 "Bankkonto ikke funnet"` — *bank account not found* — for a **bank-synced** account
  that exists and reads perfectly through `reai_get_bank_reconciliation`. Measured on all
  three of tenant 2634's company banks, every one `providerType "ztl"`.
  - The 404 is **ambiguous**, and the obvious reading is the less likely one: it also means
    what it says when an id is stale, foreign to the tenant, or genuinely wrong. So the quirk
    names both readings and how to tell them apart — if the id appears in
    `reai_list_company_banks` the account exists and simply is not manual; if it does not, the
    id really is wrong. An earlier draft stated the "not manual" reading as *the* answer, which
    would have sent a caller with a bad id to the synced endpoint instead of correcting it.
    Said in the description of the tool that sends callers there, which had pointed at that
    endpoint with no warning at all.
  - Neither test tenant has a manual bank account (2783 has no company banks at all), so the
    manual-reconciliation endpoints get no curated tools: there is nothing to verify them
    against, and closing a reconciliation is not something to try blind on a real company.


- **Two more tools were reporting "deleted or archived" on endpoints that say which.**
  `reai_delete_product` and `reai_delete_company_bank` returned literally
  `"deleted or archived (HTTP 200)"`. Both endpoints' 200 is documented as
  `ApiLifecycleOutcomeRes` — `{outcome: deleted | archived | reversed}` — and **19
  operations declare it**. This repo had already fixed the same bug five separate times,
  one endpoint at a time, each found by hand: customers, suppliers, salary runs, expense
  vouchers, expenses.
  - The product one is the sharpest of the set. A deleted product is what strands other
    records permanently — eight orders on the test tenant can never be deleted because the
    product their lines name was deleted first — and products have **no unarchive
    endpoint**, so "archived" is the recoverable-looking outcome that is not recoverable.
    Both tools now say which happened and what it means.
  - **A spec-driven audit replaces finding these by hand.** `test/archive.test.mjs` reads
    every operation whose `200`/`201` schema is the lifecycle envelope, drives every curated
    tool on one three times — once per outcome value — and requires all three pairs to produce
    different words from the tool itself. What it enforces is *distinguishable*, not
    *explained*: a note reading `outcome "deleted"` and nothing else would satisfy it. That
    the two tools fixed here explain the consequence is a separate, per-tool test, and it
    catches exactly that say-nothing shape.
  - Coverage is **pinned, not floored**: exactly 11 curated tools on the 19 endpoints, and
    the 8 endpoints with no curated tool are listed by name. `apiPaths: []` would otherwise
    remove a tool from the audit in silence — no other test requires that list to be
    complete, only present — and a floor left three tools' worth of slack to vanish into.
  - The audit went through **four wrong observables** before this one, every one of which
    passed while the bug was present, and they are recorded because each is a general trap:
    1. Comparing the tool's **whole output** — which includes the echoed body, and that body
       *is* the outcome envelope, so the pre-fix handlers "differed" without having said
       anything.
    2. Slicing the body off at the first line starting with `{`. That fails whenever the body
       is not pretty-printed JSON: `ok("a string")` renders raw, so a handler saying literally
       "deleted or archived (HTTP 200)" passed again as soon as it interpolated the response —
       and `ok(res.data ?? \`…\`)` is house style in four handlers. The body is now subtracted
       *exactly*, by rendering it through `ok()` itself.
    3. Asserting each outcome **positively** ("given `archived`, say ARCHIVED"). Wrong,
       because the enum is shared across all 19 endpoints and each uses a subset: a voucher
       cannot be archived and a customer cannot be reversed, and calling an impossible value
       "no recognised outcome" is the honest answer, not a defect.
    4. Building arguments as `{id}`, so three tools taking `departmentId`, `assetId` and
       `warehouseId` threw identically and were reported as ignoring the outcome **when they
       were reading it correctly**.
    A tool that refuses, or that never reaches its `DELETE`, is now "could not exercise" — its
    own assertion — because a test that accuses the innocent is worse than no test.
  - The full-write suite deletes the company bank through the curated tool now rather than
    `reai_request`, so the fix is exercised live. Its own label had said "deleted or
    archived" for the same reason the tools did — and its `attempt()` helper gained an
    optional pass predicate, because the first version returned a `NO OUTCOME REPORTED`
    detail string while still counting as a pass: a regression visible in the log and not in
    the exit code.
  - The audit compares all **three** outcomes pairwise, not just deleted against archived.
    The harness was already driving `reversed` and ignoring what came back, so a tool folding
    a reversal into its archived or unknown branch would have passed — on vouchers, expenses
    and salary runs, where a reversal POSTS to the ledger and is the most consequential of
    the three to misreport.
  - `reai_delete_company_bank` gave the same unfollowable advice the product note had, and it
    was missed the first time: `GET /api/company-banks` takes **no** `archived` parameter
    (measured — its only parameter is the tenant header), unlike `/api/warehouses` and
    `/api/customers` which do. So "stays out of the default view" implied a non-default view
    that does not exist, and "check `reai_list_company_banks`" could not tell deleted from
    archived, the record being absent either way. Both notes now say the response is the only
    place that distinction exists.
  - Three further claims in the new notes were wrong and are corrected. There is **no invoice DELETE
    endpoint at all**, so "a dependent invoice can no longer be deleted" attributed an
    impossible operation to product deletion — crediting was always the only route.
    `GET /api/products` takes **no archived filter** (measured: its only parameter is the
    tenant header), so the advice to list archived products was unfollowable — and the real
    fact is worse and now stated: an archived product cannot be listed through this API at
    all. And archival of a company bank is not evidence that any payment was ever made
    through it; any retained posting or reconciliation will do.


- **The invoice-delivery gate read only one direction, and the other one was reachable
  through a curated tool.** `invoiceEmail: "attacker@example.com"` escalated to
  `irreversible` and needed `full` mode; `invoiceEmail: ""` on the same endpoint stayed
  `reversible` and went through in the default mode. Same field, same disclosure axis:
  one sends invoices to a chosen address, the other stops them reaching the address
  someone chose.
  - Reachable, not theoretical: `reai_update_customer` is declared `reversible`, accepts
    `invoiceEmail` as a plain string, and forwards `""` unchanged. Measured against
    `PATCH /api/customers/{id}` on tenant 2783, `""` cleared the stored address, `null` was
    the documented **no-op**, and `" "` answered `400 "Validation failed"`. So the value
    that empties a billing address is the one that looks like a typo — and `""` is also the
    schema's declared *default*, so a client that fills defaults in rather than omitting
    them clears the address without meaning to.
  - **Only in a partial body**, and that qualifier took a false positive to find. In a
    whole-record `PUT`, an empty `invoiceEmail` cannot be told apart from faithfully
    carrying back an address that is already empty — which is exactly what `reai_request`
    tells callers to do. Escalating it made **every possible body** for
    `PUT /api/orders/{id}` irreversible (omit the optional field and a replacement empties
    it; name it and it is either a new address or an empty one), leaving an agent in the
    default mode no way to edit an order at all, there being no curated order-update tool.
    So: a `PATCH`, or any curated tool's arguments — which are always partial, because those
    tools read and merge — escalate; a replacement body does not, and the
    replacement-omission gate remains the mechanism there. A `POST` never escalates on
    clearing, since it has no stored address to redirect.
  - The residual, stated rather than glossed: someone who deliberately empties a set address
    through a replacement `PUT` is not escalated. Distinguishing that from the round-trip
    would mean reading the record inside the policy check and comparing, which makes an
    allow/refuse decision depend on a second network call and on what to do when it fails.
  - `invoiceDeliveryClearedFields` is now exactly complementary to `presentFields`, so no
    value falls between "set" and "emptied" — `invoiceEmail: []` and `[""]` both stringify
    blank and used to be neither.

- **Operation-keyed gates now see the path a router would see.** The risk classifiers read
  every form of a request (matrix parameters stripped, doubled slashes collapsed, a trailing
  dot dropped); anything resolving an OPERATION read only the raw and percent-decoded forms.
  So `PUT /api/orders/1;x=1`, `/api/orders/1;`, `/api/orders//1` and `/api/orders/1.` each
  resolved to nothing, and the replacement-omission gate — which lists the fields a body
  would empty — had nothing to list and let the call through unremarked, while the same call
  spelled plainly was refused. Not exploitable against ReAI today (measured: its
  StrictHttpFirewall answers 400 to the matrix parameter and the doubled slash, 404 to the
  trailing dot), which is the reason to fix it rather than a reason not to.

- **`reai_request` names every reason a call was refused, not the first one.** A body
  carrying both an `iban` and an emptied `invoiceEmail` was refused for the `iban` alone, so
  dropping that field earned a second refusal for a reason never mentioned.
  `curatedArgsEscalate` already fixed exactly this on the curated side; the escape hatch
  kept the shape its comment was written about.

### Added

- **Reference data and company state (4 read tools), and a new `reference` toolset.**
  `reai_list_countries`, `reai_list_currencies`, `reai_get_opening_balance`,
  `reai_get_annual_accounts`.
  - **Shape is not membership.** `countryCode` arguments are checked for being two
    uppercase letters and `currencyCode` for three, because a pattern is all the spec
    documents — so `UK` passes locally and fails at the API, where the United Kingdom is
    `GB`. `GET /api/countries` and `GET /api/currencies` are the real lists and nothing
    pointed at them. Each country carries its default `currencyCode`, and `query` searches
    that too — "which countries use NOK" is the natural question and used to answer zero.
  - Both endpoints **do** document their response (`array<CountryRes>`, `array<CurrencyRes>`)
    and the live API agrees. An earlier draft of this entry claimed the opposite on a
    miscount: **386 of 430** operations declare a 2xx schema, 368 of them under the wildcard
    content type, and counting only `application/json` gives 12. The real gap is that the
    spec **index** carries no response shapes at all — so `reai_describe_endpoint` cannot say
    what any endpoint returns, for 386 documented operations. Left for its own change.
  - `query` filters **locally**, since neither endpoint accepts a parameter. Recorded in
    `SHAPES_THE_RESPONSE` with a test that proves the request is identical either way while
    the output differs — otherwise it is a dropped input, which is the class that sweep
    exists to catch. The exemption self-test now handles non-boolean fields; it only ever
    looked for `field: true`.
  - **Two 404s turned into answers.** `GET /api/opening-balances` answers
    `404 "Opening balance not found"` and `GET /api/annual-accounts/{year}` answers
    `404 "No annual-accounts submission exists"` — measured on both test tenants. A 404 on a
    collection-shaped path is otherwise indistinguishable from a wrong path, a wrong tenant
    or a disabled module. Narrowly: only the documented message becomes an answer, and a
    403, 401 or 500 still fails, because a tool that reports every error as "nothing
    recorded" turns an outage into a fact about the books.
  - Opening-balance **writes stay on `reai_request`** and the tool says why: it is ledger
    position, `DELETE` is documented "delete OR reverse", and neither test tenant has one to
    watch those endpoints on.
  - The 404 conversion is decided on the typed `ReaiApiError.status`, not on the rendered
    message. A gateway `500` relaying a downstream body can carry both "HTTP 404" and the
    documented phrase, and a text-matched guard would have reported that outage as an empty
    set of books. The phrase is a second condition, not the only one.
  - The two code lists need **no tenant at all** — the spec declares no `X-Tenant-Id`
    parameter for either, so they now send none and answer immediately after authentication,
    which is when "what country codes does this API take" is actually asked. Verified live
    with no tenant selected: both answer, while the tenant-scoped opening-balance read still
    refuses.
  - `year` accepts what the API accepts: the spec says `exclusiveMinimum 0, maximum 32767`,
    and an earlier floor of 2000 was an assumption about when ReAI's fiscal years start that
    would have rejected a legacy year the API would have answered.

- **Lead writes (5 tools), and the reason they are not a thin wrapper.** `reai_save_lead`,
  `reai_update_lead`, `reai_log_lead_contact`, `reai_convert_lead`, `reai_delete_lead`.
  Measured on tenant 2783, the CRM half of the leads domain has six traps. Four are a 200
  that means something other than what was asked for; two are a documented route that does
  not exist (a status-clearing null answers 400, the org form of convert answers 404):
  - **Null means two opposite things depending on the endpoint.** `PATCH /api/leads/...`
    documents null as "leave unchanged" and honours that — `{notes: null, email: null,
    phone: null, followUpAt: null}` against a lead holding all four returned 200 and
    changed nothing. The `PUT` setters clear on the same null. So the general-looking
    endpoint cannot clear a field at all. `reai_update_lead` takes one rule — omit to
    keep, null to clear — and routes each field to whichever endpoint does that,
    reporting the calls it made.
  - **`PUT .../contact` answers 200 on an unsaved company and stores nothing.** Every
    other write materialises the lead row (PATCH, status, notes, follow-up and a contact
    event each turned `lead.id: null` into a real id); contact left it null, which means
    the email and phone were accepted and discarded. `reai_update_lead` therefore saves
    the lead first before writing to a company that has never been touched.
  - **`PUT .../contact` needs both fields in the body, every time.** A single-key body has no
    single behaviour: `{phone: null}` alone was a complete no-op in 4 of 4 trials, re-read
    after four seconds, with the phone it named still in place — while the identical body
    sent straight after `PUT /notes` and `PUT /follow-up` behaved as a full replacement and
    cleared the omitted email. Nothing in the request accounted for the difference, so the
    tool reads the lead and carries over what the caller did not mention, which is correct
    under either reading. The unit-test fake throws on a single-key body rather than
    modelling one, since sending one is the defect.
  - **Undoing a conversion has an order**: the lead first, the customer second. Deleting the
    customer while the converted lead still pointed at it ARCHIVED it — `"it had
    transactions"`, on a customer minutes old with no ledger entry, order or invoice. With
    the lead gone it deleted outright.
  - **A status cannot be unset**, and the spec says it can: `PatchLeadReq.status` points
    at `PUT /status` with an explicit null, which answers `400 "Validation failed"` and
    leaves the old status in place. Passing null is refused up front with that
    explanation instead of forwarded.
  - **`convert` exists only by id** — the `/org/{orgNumber}` form 404s — so an unsaved
    company cannot be converted at all until it has been saved. The tool does that first,
    and reads the new customer id back from the lead, because the convert response body
    is the *company* record. Repeat conversions are safe: a second call, and a fresh lead
    for an org that already has a customer, each returned 200 without creating a second
    one.
  - Five quirks record all of it against the operations concerned, so `reai_request`
    callers get the same warnings.
  - **Every verified non-outcome is an error, not just prose**: a POST that saved no lead,
    a DELETE that removed none, a convert that produced no customer id. And
    `reai_update_lead` now compares the readback against what it was asked for, field by
    field, and reports which values did not take — worth the arithmetic in a domain where
    one endpoint answered 200 and stored nothing. Phone is compared loosely, since ReAI
    normalises it.
  - A clear-only request on a company with no lead state no longer creates a lead in order
    to empty it.

- **Nullability now survives the enum rendering in the spec index.** `enumType()` threw
  away the fallback string that carried the trailing `?`, so all **65** enum-typed body
  fields read as non-nullable — **36 of them wrongly**. Not cosmetic:
  `test/merge-tools.test.mjs` decides from that exact string whether a curated tool may
  accept null, so a correctly nullable enum field looked like a tool defect whose
  suggested fix was to delete a `.nullable()` the API honours. Found while adding a lead
  tool that tripped the guard. The new test asserts the property against the raw spec
  rather than a list of examples.

- **The bounds sweep now covers QUERY parameters, not just write bodies.** Review of
  the lead search caught three unenforced maxima by reading, and the reason nothing
  caught them automatically is that `writeOperations()` walks request **bodies** — so a
  read tool's filters had never been checked by anything, and a guard that only covers
  write bodies cannot claim to cover "arguments the API rejects".
  - Ten tool operations carry documented query bounds; three of them a `maxLength`.
    The sweep found **three real violations** and they are fixed:
    `reai_list_customers.organizationNumber` (36), `reai_list_customers.email` (255),
    `reai_list_orders.externalReference` (100).
  - It includes writes and `DELETE` too, since a `POST` or `PATCH` can carry query
    parameters and `DELETE` has no body for the other sweep to walk.
  - Two tests guard the guard: one asserts it resolves a useful number of operations
    rather than passing on zero, and one asserts it would catch the case that prompted
    it (`reai_search_leads.query` at 200). Removing any of the three bounds from the
    source fails it — verified by mutation, not assumed.
  - **Exclusive bounds were being dropped entirely.** OpenAPI 3.1 writes many bounds as
    `exclusiveMinimum`, and this document does it 28 times on query parameters alone —
    every id filter. `scalarConstraints` read only the inclusive keys, so those
    parameters vanished from the sweep and **twelve more violations** were hiding behind
    it: `voucherId`, `customerId`, `supplierId`, `projectId`, `employeeId` and
    `companyBankId` filters declared `z.number().int()` without `.positive()`, accepting
    0 and negative ids. All fixed.
  - **Array parameters keep their constraints on `items`.** `/api/bank-reconciliations`
    holds `include`'s allowed values as an enum there, so probing the outer schema found
    nothing — replacing that tool's `z.array(z.enum(…))` with plain strings would have
    left the sweep green. There is no violation today, so the fix is proven the other
    way round: weakening the tool makes the sweep fail.
  - `RENAMED_QUERY_ARGS` now **resolves** through the map instead of merely listing it.
    Its first version held a single entry stating that the tool and the spec agreed on
    the name — documenting nothing — while the sweep went on skipping genuine renames in
    silence. A map that records a blind spot without closing it is worse than no map,
    because it reads as coverage. It is empty, asserted to contain only real renames of
    genuinely constrained parameters, and the resolution mechanism is proved against a
    synthetic entry so it is not first exercised in anger.

- **Leads** (2 read tools) — `reai_search_leads` and `reai_get_lead`. The last
  substantial uncovered domain with real data on it, and it is not what the name
  suggests: `GET /api/leads` searches the Norwegian company register (Brønnøysund)
  and layers whatever lead state this tenant has on top. Prospecting, with 21 filters
  — legal form, industry-code prefix, city, registration date range, whether Brreg
  lists an **accountant**, whether an email or phone is on file, follow-up due dates,
  dedupe by owner.
  - **Most results are not leads.** Measured, every row of the default first page came
    back with `id: null` and `status: null` — companies nobody here has touched.
    `leadFilter` separates them (`all` / `saved` / `unsaved`), and the search reports
    how many of the rows it returned are unsaved rather than leaving that to be noticed.
  - **Two addressing schemes, one of which cannot work.** `/api/leads/{id}` and
    `/api/leads/org/{orgNumber}` both exist, but an unsaved company has no id:
    `GET /api/leads/null` answers `400 "Failed to convert 'id' with value: 'null'"`.
    The organisation number is on every row either way, so `reai_get_lead` takes that
    and validates its nine digits.
  - **The response carries no total.** The envelope is `{items, page, hasPrevious,
    hasNext, latestRegisteredAt}`, so "how many companies match" is not a question one
    call answers — the tool reports the count it received and whether more exists, and
    a response with no `items` array is reported as **unknown** rather than as none,
    which for a question about the whole register would be a confidently wrong answer.
  - `pageSize` is bounded locally at 200 because the API's refusal above it is a bare
    `400 "Validation failed"` naming no field.
  - **The detail response and a search row disagree about shape**, which review caught
    and my own test had hidden: `LeadRes` nests lead state under
    `lead: { id, status, notes, followUpAt, convertedCustomerId, … }`, while a search
    row flattens `id` and `status` to the top level. `reai_get_lead` read the top
    level, so it reported every *saved* lead as untouched — and the test passed because
    it mocked the search shape for a detail response. It reads `lead.id` now, keeps the
    flattened form as a fallback, and a quirk records the difference. An untouched
    company still returns the object with every field null rather than omitting it.
  - The collection quirk is attached **exactly**, not to descendants: the envelope and
    `pageSize` guidance does not apply to the two detail endpoints, which return a
    single `LeadRes` and accept neither.
  - The documented query-parameter maxima are enforced locally (`query` 200,
    `legalFormCode` and `industryCodePrefix` 500, `city` 1000). Worth noting these were
    invisible to `test/spec-bounds.test.mjs`, which sweeps write **bodies** rather than
    query parameters — so this class had to be caught by reading.
  - Neither tool contacts anybody. Placing a call is a separate internal endpoint,
    already classified as an external send, and a test asserts that stays true.

- **General sub-accounts** (4 tools) — `reai_list_sub_accounts`,
  `reai_sub_accounts_for_account`, `reai_create_sub_account`,
  `reai_rename_sub_account`. A sub-account (*underkonto*) splits one ledger account
  into named parts: on a live tenant, account 1579 carries both `Default` and
  `Shopify sales`.
  - This existed as a **field before it existed as a tool**. `reai_create_voucher`
    and `reai_create_reconciliation_rule` already accepted `subAccountId`, described
    as *"Optional general sub-account id"*, with no way to discover a valid value —
    and the description was wrong. Measured, an account that has **any** sub-account
    requires one on **every** posting, including an account whose only sub-account is
    called `Default`, which is the usual case:
    `400 "Linje 1: Konto 1320 må posteres med underkonto."`
  - So the field read as optional precisely for the accounts where omitting it cannot
    work, and the API's refusal is a bare Norwegian message naming only the line.
  - **`reai_create_voucher` now pre-checks it**, with one read of the sub-account list
    however many postings the voucher has, and refuses with the actual choices:
    `line 1, account 1320 → subAccountId 6230 (Default)`. A **failed** lookup does not
    block the write — this document has understated requirements before, and refusing
    a ledger write because a helper read failed would be the check doing harm.
  - `companyBankId` is the same shape of rule (`400 "Konto 1920 må posteres med
    bankkonto."`) and is documented rather than pre-checked, because nothing in the
    company-bank response says which ledger account each bank belongs to.
  - Sub-accounts are **permanent**: `DELETE` answers `405` and `PUT` accepts only
    `name` (`accountNumber` → `400 "Unknown field: accountNumber"`), so one can be
    neither removed nor moved. Creating the *first* one on an account changes that
    account's rules for everyone posting to it, and the create tool says so when that
    is what is about to happen. `POST /api/general-sub-accounts` is therefore
    classified **irreversible** in the policy, not merely reversible.
  - The per-account selector has **three** answers, not two: a list, an empty list, or
    `400 "accountNumber 3000 does not support general sub-accounts"` for an account
    that cannot have them at all.

- **Discovery ranking, measured on queries it was not tuned on.** The two existing
  eval sets were written by me and then tuned against, which makes them regression
  tests rather than evidence that the ranking generalises. Scored against a
  **held-out** set of Norwegian bookkeeping vocabulary instead, it managed **17 of 45
  in the top 3**, and a dozen queries returned **nothing at all** — the outcome that
  leaves an agent stuck rather than merely misdirected.
  - After adding the missing vocabulary: **36 of 41 in the top 3, 38 in the top 10**,
    and nothing returns empty. Four of the original 45 named endpoints that do not
    exist (`/api/reports`, `/api/accruals`, `/api/accounting-periods`, and the
    `/api/peppol` paths are internal), so they were dropped rather than "fixed" —
    tuning the scorer toward a target the API does not have is a mistake this repo
    has made once already, and the new test asserts every target exists before using it.
  - **That corpus is no longer held out**, and review was right to say so: the same
    change read its failures, added synonyms for its vocabulary, and set the floors
    from the result. A **second corpus** was written afterwards and measured once —
    **19 of 28 in the top 3, 23 after fixing only the queries that returned nothing
    at all**. That is the honest figure for vocabulary nobody has thought of yet, and
    the gap to 36/41 is the standing cost of a synonym table. Two more of its thirty
    targets were also mine being wrong (every `/kassasystem/` path is internal, and
    there is no `GET /api/vouchers/{id}/attachments`) — the third time in this work
    that a "ranking failure" turned out to be a target the API does not have.
  - The terms that found nothing were the everyday ones: `reiseregning`, `utlegg`,
    `kjøregodtgjørelse`, `diett`, `feriepenger`, `timeføring`, `vedlegg`,
    `dokumenter`, `kontaktpersoner`, `organisasjonsnummer`, `produkter`,
    `valutakurs`, `kontoutskrift`, and the whole access-control vocabulary
    (`tilgang`, `brukere`, `roller`, `rettigheter`) added with the tools that read it.
  - **`METHOD_INTENT` held no Norwegian at all** while `WRITE_INTENT_VERBS` already
    held four, which the comment above that table explicitly warns against: a word
    that licenses a write must also say which method, or the write gets the weak
    generic bonus and a `GET` on the same resource still wins. Measured: *"opprett
    kreditnota"* ranked the endpoint first while *"lag kreditnota"* did not find it at
    all — and `lag` is the commoner verb. Both tables now carry the same Norwegian
    verbs, in both spellings, since these are consulted with raw rather than
    ASCII-folded tokens (`oppdater` matched, `bokfør` did not).
  - `betal`/`betale` were left **out** of the read verbs deliberately: a stemmer
    stripping `-ing` turns the read phrasing *"hvilke betalinger"* into a create verb,
    which is the exact false positive that table's note was written about.
  - **A matched phrase is now consumed rather than annotated.** Its replacement terms
    were being added while the phrase's own words stayed in the text and scored on
    their own, so a mapping could be outvoted by the thing it exists to override.
    That is why `a-melding` still ranked the income-tax return: `melding` kept its
    own vote. `POST /api/salary-payments/{id}/complete` now ranks first for all three
    spellings, and `mva-melding` reaches the VAT return rather than the income-tax
    one. The `fixed assets` rule needed both singular and plural after the change,
    which the existing ranking suite caught.
  - Terms that were **too ambiguous to keep**, each measured doing harm: `lag` (also
    the noun for a team — *"ansatte per lag"* became a create), `varer` (also the verb
    "lasts" — *"hvor lenge varer abonnementet"* ranked products), `bruker` (also
    "uses" — *"hvilken konto bruker fakturaen"* filled the results with users),
    `valutakurs` (`/api/currencies` returns only code and name, so it cannot answer an
    exchange-rate question), and the generic `tax` on `forskuddstrekk` and
    `arbeidsgiveravgift` (which ranked the annual income-tax return above payroll).
  - The Norwegian actions also went into **`VERB_TERMS`**, a third table I had missed:
    left out, they scored as full-weight resource words, and *"registrer dokumenter"*
    ranked a registration sub-operation above `POST /api/documents`.
  - `a-melding` gets a phrase rule and its own test. It tokenises to `a` + `melding`,
    and `melding` maps to return/returns, so the payroll filing query ranked the **tax
    return** first — two different filings to the same authority, and acting on the
    wrong one files the wrong thing with Skatteetaten.

- **Access control** (5 read tools) — `reai_list_users`, `reai_get_user`,
  `reai_list_roles`, `reai_list_permissions`, `reai_list_user_invitations`. The
  Users domain was entirely uncovered, and "who can reach our books" is a question
  worth being able to ask.
  - **The roles do not mean what their names suggest.** Measured on a live tenant by
    comparing the permission *sets* rather than their sizes: `ROLE_TENANT_ADMIN` and
    `ROLE_ACCOUNTANT` are **identical to `ROLE_OWNER`** — 51 permissions each, zero
    missing, zero extra — and both are assignable while `ROLE_OWNER` is not. So
    inviting someone as an accountant grants exactly what the owner has, including
    `tenant:user:write`, the permission to invite more people. `ROLE_AUDITOR` is 20
    read-only permissions and `ROLE_EMPLOYEE` is 6, all self-scoped.
  - **All five tools compute that comparison against your tenant** rather than
    repeating the numbers, so they stay true if ReAI ever narrows a role. The first
    version only did it in `reai_list_roles` and hardcoded the role codes in the
    other three — which, on a tenant with a narrowed `ROLE_ACCOUNTANT`, would have
    reported a narrowed user as holding full owner access. In an access audit that is
    the one direction that must not be wrong. Judgement is now on each user's own
    `effectivePermissionCodes`, so a **direct grant** can make a narrow role
    owner-equivalent and a **narrowed** role does not stay so by keeping its title.
    Tests cover both directions, plus an unreadable role list reported as *unknown*
    rather than as "nobody".
  - Permission codes are scoped by prefix: `self:` reaches only the acting user's own
    records, `tenant:` the company's. And the catalogue is not the whole vocabulary —
    measured, `GET /api/users/permissions` returns 45 codes, all `tenant:`, while the
    owner's effective set is 51, so the six `self:` codes appear on users and roles
    but are never published.
  - The pending-invitation summary is bounded at ten with a count of the rest:
    `ok()` caps the serialised body but not a caller-supplied note, so an
    unbounded enumeration built here could have pushed the result past the limit the
    rest of the server holds itself to.
  - The writes stay with `reai_request` and are already gated: `POST /api/users`
    invites an email address and is classified as an external send, `PUT` changes what
    someone may do, `DELETE` revokes. A test asserts no curated tool reaches anything
    but `GET` under `/api/users`.

### Fixed

- **`scripts/smoke.mjs` silently skipped a check it could have run.** Its
  `firstIdOf` looked only for `id`, and users are keyed `userId`, so
  `reai_get_user` was reported as "returned nothing to fetch on this tenant" — a
  false statement about a tenant that plainly has a user. The id field list is now
  shared with the verifier, which had the same assumption and would otherwise have
  failed the check it had just fetched by that id.
- **And its `parseBody` assumed a single note paragraph.** It tried the whole text
  and then everything after the *first* blank line, so a tool emitting two notes had
  its body never parse. It now scans blank-line-separated blocks from the last
  backwards — the same fix the write suite's `jsonOf` needed when quirk notes started
  appearing above bodies.

- **A stray sweep in the write suite**, and the reason it was needed. Eight orders
  had been sitting on the test tenant since an ad-hoc subscription-billing probe,
  along with the subscription that generated them, and nothing noticed for weeks.
  The existing sweep only looks for records carrying *this run's* stamp, so it
  could not have: the litter came from a different run.
  - The new sweep matches the naming convention every test record here uses
    (`Zz…`, `reai-mcp…`, `smoke…`, `probe…`) across the eleven domains the suite
    touches, and **reports rather than deletes** — it is looking at records it did
    not create, and removing those quietly would be a worse habit than leaving them.
  - Records that genuinely cannot be removed are listed in `KNOWN_UNRECOVERABLE`
    with the reason, and printed every run so they stay visible instead of becoming
    background noise. Proven to fail: emptying that list turns the run red with
    `LEFTOVER ORDERS 4105, 4104, …`.
  - The first version of the sweep was **vacuous in six separate ways**, all caught
    in review and each of which made a domain report clean unconditionally: products
    are labelled `title` not `name`; orders expose `internalComment` not `comment`;
    agreements are keyed `agreementId` and labelled `clientName`, while
    `signerEmail` is absent from the list and `templateType` is a fixed enum; orders
    default to a **one-year** window and expenses to the current year, so old leaks
    age out of view; archived rows are hidden unless asked for; and a **truncated**
    list was being read as exhaustive.
  - Fixing the last two is what made it work. It now sweeps **per test-name prefix**
    where a `name` filter exists, because 69 archived suppliers do not fit the result
    budget and a truncated list cannot support a claim of cleanliness — and that
    change immediately surfaced **four strays hidden past the cut** (`Payprobe-…`,
    `Signprobe-…`, `Vat Basis Probe As`, `Reversal Probe As`), all unremovable, now
    recorded by id.
- **The write suite reuses one supplier instead of creating a new one each run.**
  It posts a real supplier invoice, and `DELETE` on a supplier invoice *reverses* it,
  so the supplier keeps a transaction and its own delete can only archive — 64
  archived `Reai-mcp Fullwrite …` suppliers had accumulated, one per run. It now
  finds its supplier by name and **unarchives** it, which is where
  `reai_unarchive_supplier` earns its place, and leaves it archived for the next run.
  Verified live across two runs: created on the first, `unarchived from the last run`
  on the second.
- **`reai_unarchive_customer` and `reai_unarchive_supplier`** — two uncovered
  endpoints that are the documented recovery for a counterparty archived too
  eagerly. The customer path was measured end to end (a customer reading
  `archived: true` answered 200 and read back `archived: false`); the supplier path
  is exercised by the write suite against the supplier it archives, then restored
  and re-archived so the tenant is left as found.

### Fixed

- **`reai_delete_customer` and `reai_delete_supplier` said "deleted or archived"
  without reading which.** Both endpoints answer `{"outcome":"deleted"}` or
  `{"outcome":"archived"}`, and the difference is between an unrecoverable state and
  a recoverable one. They now report it, name `archived: true` as the way to see an
  archived record again, and point at the matching unarchive tool. An unrecognised
  outcome is reported as unknown.

- **Expense claims** (9 tools) — the whole state machine, which was 1 of 10 operations
  covered. `reai_get_expense`, `reai_create_expense`, `reai_update_expense`,
  `reai_deliver_expense`, `reai_approve_expense`, `reai_unapprove_expense`,
  `reai_book_expense_voucher`, `reai_delete_expense_voucher`,
  `reai_reverse_expense`. It is also the other half of payroll: a salary run
  arrives pre-populated with wage lines derived from expense postings, so what is
  approved here is what gets paid there.
  - Driven end to end on the test tenant: `open → deliver → for_approval →
    approve → approved → voucher`, and back down by deleting the voucher and
    unapproving. Booking is where the ledger moves — the voucher count went up by
    one and came back as `{expenseId, voucherId, voucherNumber: "EX1-2026",
    voucherDate}`, its own number series.
  - **`status` never says "booked".** A posted expense still reads `approved`;
    `voucherId` is the only thing that says it is in the ledger. And **booking
    approves a `for_approval` expense as part of the same call**, so it can skip
    `/approve` entirely — which also means it is not a safe way to "check" anything.
  - **`status` never says "reversed" either, and that one hides.** `DELETE` answers
    `{"outcome":"reversed"}`, the expense vanishes from the list, and the detail read
    still returns it with whatever status it had before — no visible field changes.
    `?status=reversed` is rejected with a `400`, so the API cannot be asked. The only
    positive signal is a failed transition (`409 "is reversed and can no longer be
    delivered"`). `reai_get_expense` spends one filtered list call and answers it
    properly; a failed check reports *unknown* rather than implying the claim is live.
  - **`category` is optional to create and required to deliver**, and the API's
    `400 "Kategori må velges for kostnadsrad."` names no row. It is an enum of 28
    values driving account mapping, so the tools take it as one and count the rows
    missing it at create time, before delivery fails.
  - **The line arrays are complete lists** while the scalars patch, in the same
    request: two cost rows updated with one came back with one and the total fell
    from 300 to 100. Omitting an array preserves it (measured), so the tools report
    which list was replaced and the resulting row counts.
  - `reai_unapprove_expense` reads first and refuses while a voucher exists, naming
    the voucher to delete rather than relaying
    `409 "har allerede et bilag og kan ikke lenger avvises"`. Per-diems and mileage
    on a non-travel claim are refused locally. `reai_delete_expense_voucher` reads
    the `{"outcome":…}` rather than trusting the 200, and says plainly when a
    reversal posted instead.
  - `reai_get_expense`'s liveness lookup sends an **explicit date window** derived
    from the expense's own dates, padded a year either side. `GET /api/expenses`
    defaults `startDate` to 1 January of the current year and `endDate` to *today*,
    so a claim from last year — or one dated tomorrow — was absent from the default
    window and would have been reported as REVERSED. A false "this was withdrawn" is
    worse than not checking, so when no date can be read the check is abandoned and
    says so.
  - The update tool's line arrays take each row's **`id`**, documented as "Id of an
    existing cost line on this expense. Omit to add a new cost line." Since the
    arrays are complete lists, a kept row sent without its id was being deleted and
    recreated — the same defect as employment lines, and the same fix.
  - `reai_reverse_expense` **takes the voucher with it**, which the first version of
    its description denied. Measured after review questioned it: an expense booked to
    voucher 30808 was reversed, the day's voucher count went from 1 back to 0, and
    `DELETE /api/vouchers/30808` then answered `404 "Bilag ikke funnet"`. Nothing is
    stranded, so a booked expense need not be unlinked first — and afterwards the
    unlink answers `409 "Kan ikke slette bilag fra et slettet utlegg"` simply because
    there is no expense left to unlink from. The description and a new quirk now say
    that; adding an unlink to the cleanup on the strength of the old claim made the
    suite fail, which is how the claim was caught.
  - `describeExpense` no longer says "nothing is in the ledger" for an approved
    expense with no voucher. If a voucher was previously **reversed** rather than
    deleted, the original and its reversal both remain posted while the link goes back
    to null, and the detail response cannot tell the two apart.
  - The write suite covers all of it (16 checks), including both halves of the
    reversal finding: that the API returns the old status, and that the read tool
    detects it anyway. Expense cleanup runs before the employee's, since a record
    referencing an employee is what makes their `DELETE` answer `409`.

- **`reai_request` refuses a `PUT` that would clear the fields it does not mention.**
  Naming the worst instances of the full-replacement class was never the same as
  covering it: sweeping the document turns up **31 public `PUT` endpoints that can
  clear at least one documented field by omission**, and only 15 have a curated
  tool. The other 16 are reachable solely through the escape hatch, which cannot
  merge on a caller's behalf. Every instance of this bug in this repo — a company
  bank, a creditor, a lease, a subscription, a wage line — was found *after* the
  write on a live tenant, which is why this refuses rather than warns.
  - The refusal names the fields and the count (`leaves out 3 of its 6 documented
    field(s)`), points at read-merge-write as the usual answer, and offers
    `clearOmittedFields: true` for when emptying them is the intent.
  - Verified live in both directions: after the refusal the account number was
    still `"15201353103"`; the same call with the flag left it `""`. The write suite
    now proves both halves on two independent endpoints — a 6-field company bank and
    a 78-field lease where the body mentions one field.
  - **`PATCH` is never checked**, because `PATCH` on this API really patches
    (measured). **Required fields are excluded**, because the API rejects those and
    naming them would bury the silently-dropped ones. **The write policy speaks
    first**, so a call the mode forbids is refused for that reason.
  - **Both path forms are resolved**, after review caught the first version
    refusing nothing for a percent-encoded path. ReAI decodes before routing and
    this server does not — `GET /api/company%2Dbanks` and `GET /api/employe%65s`
    both answer `200` — so `PUT /api/company%2Dbanks/{id}` with a partial body
    skipped the gate entirely and cleared the account number. Fixed the way the
    write ladder already handled it, with `resolveRoutedOperation`; the same blind
    spot had been silencing the quirk note on successful writes reached that way.
    Verified live: the encoded call is refused and the account survives.

- **Employee master data** (5 tools) — `reai_create_employee`,
  `reai_update_employee`, `reai_set_employee_bank_account`,
  `reai_add_employment_line`, `reai_delete_employee`. Payroll shipped first,
  which made the gap plain: a salary run cannot be created until every included
  employee has a bank account, and the only way to give one was a raw `PATCH` on
  a payment destination.
  - `PATCH /api/employees/{id}` is a **real patch** — verified by changing `phone`
    alone and finding city, postal code, street, bank account, start date and
    employment lines all untouched. Worth stating because it makes this endpoint
    the exception: company banks, creditors, agreements, subscriptions and salary
    wage lines all replace.
  - **Except `employmentLines`, which replaces.** An employee with two lines,
    PATCHed with one, came back with one: the other gone, the survivor recreated
    with a new id. So "add a raise from June" written the obvious way deletes the
    employment history, which the a-melding reports. `reai_add_employment_line`
    reads the existing lines and sends them back **with their ids** so rows are
    updated rather than recreated, and refuses if the history cannot be read.
    `employmentLines: []` clears every line; `employmentLines: null` leaves them
    alone — measured on an employee that had one, so not a vacuous reading of an
    already-empty list.
  - A line dated **before** the employee's `dateOfEmployment` is refused with
    `400 "Ansettelseslinje N: Fra-dato kan ikke være før ansettelsesstart"`, where
    N counts position in the request array rather than naming a line. The tool
    already reads the employee, so it checks locally and says which two dates
    conflict. The API's rejection is atomic — the existing lines survived it.
  - `phone` is normalised to E.164 and an **unparseable value is stored as `null`
    with a 200 and no error**: `"nonsense"` silently replaced a stored
    `"+4722334455"`. `"22 33 44 55"`, `"0047 22334455"` and `"+1 415 555 0100"`
    all normalise fine, so the rule is the parser, not the format. Both write
    tools read the phone back and say plainly when it did not survive. Note
    suppliers *reject* a `+47` prefix — same-looking field, opposite handling.
  - Creating an employee with only name and email is **not** a blank record:
    `dateOfEmployment` defaults to today and an employment relation with one empty
    line is created automatically, typed `ordinaertArbeidsforhold`. Employment is
    what the a-melding reports, so the create says so when it had to default.
  - `reai_set_employee_bank_account` is separate from the update so a payment
    destination is never changed while fixing a postal code, and
    `reai_update_employee` does not accept the field at all. It reads the account
    before and after and reports **ADDED** versus **REPOINTED** with both IBANs,
    because a repoint deserves to be seen rather than inferred.
  - `reai_delete_employee` hard-deletes: 204, no body, no archive branch, no
    undelete — and `409` once anything references them, including an empty draft
    salary run. For someone who has left, `endDateOfEmployment` is usually what is
    wanted, and the tool says so.

  - `null` does **not** mean "clear" on this endpoint in general, whatever the
    field types suggest — only the fields whose own descriptions say so.
    `endDateOfEmployment: null` cleared a stored date; `phone: null`,
    `email: null` and `accountNumber: null` were all silently **ignored**, with the
    stored values still in place afterwards. So there is no way to remove a phone
    or an email here, and an empty email answers `409 "Employee email is
    required"`. The tools say that rather than offering a null that would do
    nothing while reporting a change.
  - Both `nationalIdentityNumber` and `accountNumber` are validated: an invalid
    fødselsnummer answers `400 "Ugyldig fødselsnummer"` (checksummed), `"12345"`
    answers `400` naming the expected BBAN length, and a non-numeric account
    answers `"must contain only digits"`.
  - `reai_set_employee_bank_account` **verifies what was stored** before saying the
    destination changed. A 200 is not evidence here — the same API stores an
    unparseable phone as `null` and answers 200 — so the tool compares the digits
    it sent against `bankCode + accountNumber` (which concatenate back exactly,
    measured) or the IBAN tail, and flags a mismatch or a missing account as an
    error result while still returning what was stored.
  - `reai_add_employment_line` checks **every** relation's `employmentLines`, not
    just the outer array. A relation whose lines were `null` or some other shape was
    being flattened to zero and then written over — and since the field replaces,
    that deletes whatever the malformed relation held. An empty array is readable
    and still accepted.

### Fixed

- **Redacting an absent field stated something false.** An employee with no salary
  account came back as `bankAccount: "[redacted — pass includePersonalData: true
  to see it]"`, which reads as "there is one, you just cannot see it" — while the
  same response said they had none and could not be included in a salary run. The
  write suite caught the contradiction. `redact` now leaves `null` alone, matching
  `personalFieldsIn`, which had always skipped absent values.
- `test/merge-tools.test.mjs` selected merge tools by "declares a GET **and** a
  PUT or PATCH" and then asserted specifically `PUT`, so the first GET+PATCH merge
  to arrive failed a test that had deliberately selected it. It asserts the write
  verb it filtered on now.

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

- **Four tools closing the gap the previous change named.** Gating the two
  destructive PUTs left no safe route to a rename: `reai_request` in `full` mode
  was the only way, to perform an operation that needs a read-and-merge. The
  agreements work shipped its gate with a merge tool; that one did not.
  - `reai_update_company_bank` reads the account, merges, and writes back the six
    SETTABLE fields — not the eighteen the response carries. Measured on the half
    that could actually fail: omitting the twelve response-only fields does NOT
    reset them — after a rename `manual`, `active`, `providerType` and
    `eligibleForPaymentCreation` all came back unchanged and only the derived
    `displayName` moved. `defaultForOutgoingPayment` was false throughout and no
    endpoint in this API sets it, so that one field is unverified.
    It also **refuses to clear `bban`**
    even on request: an account with no number cannot be used for payments or
    reconciliation, so `reai_delete_company_bank` is the honest way to retire one.
  - `reai_update_creditor`, with `reai_list_creditors` so the id is findable. What
    a creditor IS was read off the document rather than guessed: `LoanRes` carries
    `creditorId` and `debtorId` and the loan write takes a `counterpartyId` with a
    `perspective`, so a creditor is the counterparty when the company borrows and
    its `bankAccountNumber` is where repayments go. That is also why creditors
    carry an account number and debtors do not.
  - `reai_set_supplier_address`, the supplier half of a fix the customer side
    already had.
  - The pure part is now one shared, tested helper (`mergeForReplacement`,
    `readableRecord`) rather than four copies: filter to settable, overlay the
    changes, keep a deliberate `null`, drop an absent `undefined`, and report what
    was carried over, what is missing, and what the record did not already have.
  - Also recorded: the API NORMALISES a SWIFT code, storing `"DNBANOKKXXX"` as
    `"DNBANOKK"`. A merge that echoes it back is unaffected, but a caller comparing
    what it sent to what is stored would otherwise read that as a failed write.

- **Payroll toolset** (7 tools) — salary runs and their wage lines, and
  deliberately nothing that completes one. Measured on the test tenant by creating
  an employee, giving it a bank account, running a period, adding and removing a
  line, and deleting the run.
  - **Completing a run is not a tool.** By its own description
    `POST /api/salary-payments/{id}/complete` posts the voucher, creates payslips,
    creates one employee payment per payable employee against a company bank, and
    starts the **A-melding submission to Skatteetaten** — after which withholding
    tax and employer contributions are registered automatically. It is already
    classified irreversible AND external, and it stays on `reai_request` for the
    same reason `subscriptions/generate-due` does: it is what an agent reaches for
    to "finish payroll", and it is where a mistake is widest. Its `manualPayment`
    flag is the same dual-mode trap as the supplier payment.
  - A run **cannot be created** until every included employee has a bank account:
    `400 "Følgende ansatte mangler bankkonto"`, naming them. Employees are created
    without one, so this is the normal first failure.
  - Creating a run **posts nothing** — the ledger count did not move and
    `voucherId` stayed null, which is why `reai_delete_salary_run` can say a draft
    is safe to delete. It refuses anything not still `under_process`, because what
    deleting a completed run does could not be produced without enabling sending.
  - **Half the gross was withheld**: a 5000 COMMISSION line produced 2500 payable
    at `taxDeductionRate: 50`, which is what this API applies with no tax card. A
    payable amount is not take-home, and the read tool says so when every rate is 50.
  - The wage-line endpoints are asymmetric: create **requires** `employeeId`,
    update **rejects** it (measured, `400 "Unknown field: employeeId"`), so a line
    cannot be moved between employees. Both curated tools now build their request
    body field by field rather than spreading their arguments, so a stray argument
    cannot ride into the one endpoint that refuses it.
  - `PUT .../wage-specs/{wageSpecId}` is another member of the **full-replacement**
    class, and this one was measured rather than inferred: a line carrying comment
    `"PROBE COMMENT"` was PUT back with the same quantity, rate and code but no
    comment field, and the comment came back `null` — confirmed on a re-read. So
    `reai_update_salary_line` reads the line first and carries over what the caller
    did not mention; **omit to keep, pass `null` to clear**. It refuses when the
    line is not on the run, because a merge with no base is the replacement it
    exists to prevent.
    - The merge introduces one refusal of its own, which is the pattern this repo
      has now seen twice: changing a `HOLIDAY_ALLOWANCE` line to another code would
      carry its stored `holidayAllowanceEarningYear` onto a code the API refuses it
      on — built out of a field the caller never mentioned. The message says that,
      and says to pass `holidayAllowanceEarningYear: null` in the same call.
    - Since the tool now reads the run anyway, it also refuses to change a line on a
      run that is no longer `under_process` — a wage line altered after the voucher
      is posted would leave the line and the ledger disagreeing. Said honestly in
      the refusal: that the API would also reject it is **inferred** from the
      completion description, not measured, because producing such a run means
      filing the a-melding. The message names `reai_request` for anyone who has
      decided otherwise.
    - The write suite asserts **both halves in one run**: the curated tool
      preserves the comment through an update that never mentions it, and a raw
      `PUT` in the same session clears it. The precondition ("the line was created
      with a comment, so there is something to lose") is asserted first, so
      "the comment survived" cannot pass on a line that never had one. Lines derived from expense postings cannot be edited at all — which
    is also why a fresh run is not empty, and why adding pay without reading it
    first is how the same wages go out twice.
  - `holidayAllowanceEarningYear` is refused locally on any line that is not
    HOLIDAY_ALLOWANCE, which is what the spec says and what the API enforces.
  - `reai_delete_salary_run` refuses when the run cannot be READ back, not only
    when its status is wrong. "Probably a draft" is not a basis for deleting
    payroll.
  - That check is a **precondition, not a lock**, and the tool now says so. The
    endpoint is really "delete **or reverse**": it deletes when no accounting
    reversal is needed and records a reversal when audit history must be kept,
    answering `{"outcome":"deleted"}` or `{"outcome":"reversed"}`. It takes no
    version or conditional parameter, so a run completed in the window between the
    read and the delete gets reversed — which posts. The tool reads the outcome and
    reports which of the two happened; only `"deleted"` gets the sentence about the
    ledger being unaffected, and an unrecognised outcome is reported as unknown.
    The full-write suite asserts a draft comes back `"deleted"`.
  - Omitting `employeeIds` includes every employee **eligible for the period** —
    the schema's wording, and not the whole register, since what makes an employee
    ineligible is documented nowhere. The tool text said "every employee"; it now
    reports the `employeeIds` the API actually returned and says to compare them
    against `reai_list_employees` when coverage matters.
  - The employee bank-account quirk is two entries, not one. `methods` applies to
    every path in an entry, so a single entry covering POST/PATCH/GET on both
    `/api/employees` and `/api/employees/{id}` also claimed the COLLECTION list
    returns a split `bankAccount` — it returns the id/name/email projection, which
    the neighbouring `employee-list-is-a-projection` quirk says, so discovery on
    that one operation showed two notes contradicting each other.
  - Employee master data carries two traps of its own, both now quirks. The request
    field is `accountNumber` and takes the whole number; the response field is
    `bankAccount`, an object, with it **split** — `"15201353103"` in reads back as
    `{ bankCode: "1520", accountNumber: "1353103", iban: "NO1615201353103" }`, and
    `EmployeeRes` has no flat `accountNumber` at all, so a caller verifying its own
    write by comparing that field concludes it failed. And an employee **name** must
    be unique per tenant (`409 "Ansatt med dette navnet finnes allerede"`).
  - An employee referenced by nothing but an **empty draft** salary run cannot be
    deleted: `409 "Employee cannot be deleted because related work data exists"`.
    Delete the run first and the same call answers `204`.
- **`scripts/smoke-full-write.mjs` now covers payroll** (13 checks), which it
  previously listed as untested. The draft half only: create a run, add, change and
  remove a wage line, delete the run, with the voucher count compared across the
  whole section so "a draft posts nothing" is measured rather than asserted, and
  the refusal at `/complete` asserted before anything is written. Completing a run
  stays untested and says so.
  - Writing it produced the bug it exists to catch, twice over. A rename left
    `created.salaryRunId = run.id` reading `runId = run.id` **above** that local's
    own `const`, so the assignment threw in the temporal dead zone — after the run
    had been created. The cleanup then had nothing recorded, stranded a draft run
    on the live tenant, and the employee attached to it could not be deleted
    either. The recording now sits on its own line before the local, and the run is
    deleted before its employees.
  - The test employee's **name** is timestamped too, not just its email: with a
    fixed name, one stranded record blocks every later run with a `409` reported
    against the wrong check.
- `test/salary.test.mjs` (20 tests). Its harness runs every tool's arguments
  through the tool's **own input schema** before calling the handler, because
  calling a handler directly accepts any argument names at all: this file tested
  `reai_create_salary_run` with invented `periodFrom`/`periodTo` for a full
  iteration, green, and the live API answered "Required at period, Required at
  paymentDate" the first time a real client called it.

### Fixed

- **`reai_update_subscription` passed a partial body straight through**, and its
  own description told the caller to "read it first and send back what you do not
  intend to change" — advice that could not be followed, because the read and the
  write disagree about shape in three ways: the response puts the lines under
  `lines` and the request wants `subscriptionLines`; a response line carries eleven
  fields where `SubscriptionLineReq` accepts eight (`vatTitle`, `vatRate` and
  `amounts` are computed); and a service recipient reads back as `companyName` and
  writes as `name`. A caller echoing the response verbatim gets none of it right.

  Measured on a live subscription: a `PUT` carrying the eight required fields and
  one line answered `200` and left `invoiceEmail`, `invoiceComment` and
  `internalComment` all null, with the second line gone. Mapped properly the
  round-trip is lossless, discounts included — verified before relying on it.

  The tool now reads, maps and merges, with every field optional because the stored
  subscription supplies the rest. It deliberately does **not** disarm: `outputMode`,
  `automaticBillingGeneration` and `sendEhf` are carried over, so an ordinary edit
  leaves a self-invoicing subscription self-invoicing — and the result says so,
  because silence there would read as "the edit made it safe". The write gate reads
  the caller's ARGUMENTS, not the merged body, so carrying an armed value over does
  not misfire, and passing `sendEhf: false` still needs nothing: turning a send off
  is not a send.

  **What that costs, stated plainly because the first version of this entry did not.**
  Before the merge, `outputMode` and `automaticBillingGeneration` were REQUIRED
  arguments, so every update that succeeded with sending off had necessarily
  DISARMED the subscription — preserving the arming was refused. Making
  preservation the default therefore created a new capability: an unattended
  invoicing machine could be repointed at another customer, given another amount,
  or backdated, in the default mode with `REAI_ALLOW_EXTERNAL_SEND` unset. The
  booleans were unchanged; who is billed, how much and on what schedule were not,
  and those are what reach a third party. Found by the independent review, which
  also pointed at `reai_activate_subscription` forty lines below closing the
  identical gap for the identical reason.

  So when the STORED subscription is armed, a change to `customerId`,
  `serviceRecipients`, `subscriptionLines`, `startDate`, `intervalMonths`,
  `billingTiming` or `currencyCode` now needs `REAI_ALLOW_EXTERNAL_SEND`. Scoped
  deliberately: a comment, a due-day or a project link reaches nobody, and gating
  those would make ordinary maintenance on a live subscription need the send flag.
  Both directions are tested, and both directions of the mutation fail.

  Not coverable live, and the attempt is the finding: creating an armed
  subscription requires the same switch, so neither write suite can construct the
  precondition without enabling what those runs exist to keep off. The state is
  reachable in practice — somebody arms it in the ReAI UI and an agent edits it
  later — just not from here.
  It also refuses to leave a subscription with no billing lines, naming
  `reai_deactivate_subscription` as the way to pause billing. That refusal needed
  the schema loosened to accept `[]` — with `.min(1)` it was unreachable and the
  caller got a bare validation error, the same trap found in
  `reai_update_company_bank`'s `bban` check one iteration ago. The create tool keeps
  the stricter rule, since it has no stored record to fall back on.
- `null` now unlinks. Omission means "carry over", which left no way at all to
  detach a subscription from its project or agreement — `optionalShape` adds only
  `.optional()`. Fixed for the five OPTIONAL fields the document types as nullable;
  the other four optional fields are not nullable upstream, so `null` stays refused
  for them rather than passing local validation and failing at the API.
- The service-recipient mapping is the **fourth** shape difference, not one of
  three: `companyName` becomes `name`, and `companyId` is response-only. It also
  now filters absent values like the line mapping does — every
  `SubscriptionServiceRecipientRes` property is optional while the write REQUIRES
  `organizationNumber`, so a recipient without one is refused locally with an
  explanation instead of producing a body the API answers `400` to. Measured.
- Subscriptions had **no live write coverage at all** — the one domain in this API
  that invoices real people unattended. The reversible suite now creates one, edits
  a field and asserts the lines, the discount and both comments survived, then
  asserts that emptying the lines is refused with the right alternative and that
  changing the delivery address is still refused in the default mode.

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
