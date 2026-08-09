# Changelog

All notable changes to `reai-mcp`. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[semantic](https://semver.org/), pre-1.0 while the tool surface settles.

> **Nothing has been published to npm yet.** Install from source or run the
> Docker image. The version below describes what is on `main`.

### Fixed

- **Four places told agents the agreement enums are undocumented. The spec declares all fourteen.** The source
  file already carried the correction — "The enums ARE documented — an earlier version of this comment said
  otherwise … there are 14 such fields across the five templates" — and it had been applied to that comment and
  to nowhere a reader or an agent could see:

  ```
  src/reai/quirks.ts       "enums the document does not list"    <- served by reai_describe_endpoint
  src/tools/agreements.ts  "enums that the spec does not list"   <- the tool description
  docs/tools.md            "enums the spec never lists"
  README.md                "the enums the spec types as plain strings"
  ```

  - **The quirk is the one that mattered.** An agent told the document does not list the members will not call
    `reai_describe_endpoint` to get them, and will guess — which the file header records as exactly what
    happened: "The rejected values were simply wrong guesses." All four now say the members are declared, that
    they are lowercase snake_case, and that they can be read from the endpoint.
  - Verified rather than asserted: **14 enum fields across the five POST templates**, every member named in the
    document — `clientEntityType`, `pricingModel`, `billingFrequency`, `employmentType`, `salaryType`,
    `rentObjectType`, `electricityTerms`, `waterTerms`, `leaseDurationType`, `shortFixedTermReasonType`,
    `depositType` and `issuerRole`. That is **twelve distinct names in fourteen places** —
    `clientEntityType` and `billingFrequency` each appear on two templates — and across **four** of the five,
    because `purchase-agreement` declares none. An earlier draft of this entry said "and two more", which named
    all twelve and then claimed two unnamed extras; the independent review counted. The total matches the figure
    the file header states.
  - Two tests guard it. One asserts the spec really does declare fourteen, with the two members the prose quotes
    by hand, so a spec refresh that drops them makes the prose stale *there* rather than leaving four documents
    quietly wrong again. The other scans the quirk notes as **served**, the tool descriptions, the README and the
    docs for the claim in every form it has taken — while deliberately skipping lines that quote the old wording
    in order to correct it, because forbidding the record of a mistake is the opposite of what this repo wants.
    It fails against `main`.
  - **The first version of that guard caught three of the four and its comment claimed all four.** The README's
    wording carries the claim by IMPLICATION rather than denial — a field the document "types as plain strings"
    is one whose members it does not give — so no pattern looking for "does not", "never" or "silent" could
    match it. Found by Codex. Two patterns were added, and the check now also runs against the **rendered**
    quirk notes and tool descriptions rather than only source lines: a description is concatenated from a dozen
    literals, so a claim split across two of them matches no single line. Verified load-bearing — with only that
    one wording restored, the guard still fails.
  - **And the skip-list switched the guard off for a whole paragraph.** It skipped any line containing "an
    earlier version", "for a while" and similar, so that recording the mistake stayed legal — but markdown puts
    a paragraph on one line, and the new prose in `docs/tools.md` added "said the opposite for a while" to the
    very paragraph being protected. The independent review proved it by appending a fresh false sentence there
    and watching the test stay green. Quoted spans are now stripped instead of lines skipped, which keeps the
    correction legal and leaves every other word checked. The four historical wordings are also asserted as a
    fixture, so the pattern list is checked against the examples it exists for.

- **An action the query never asked for could outrank the resource it did name** (#122). `/api/salary-payments` is the
  collection and `/api/salary-payments/{id}/complete` is the action that **files payroll with Skatteetaten**.
  Measured on `main`:

  ```
  opprett salary payments   POST /api/salary-payments/{id}/complete   63.8   <- files with Skatteetaten
                            POST /api/salary-payments                 61.3   <- creates one, fifth
  salary run                /api/salary-payments at rank 8
  ```
  - Found by auditing **804 resource-only queries** — each collection's own name, with and without a create or
    read verb, nothing compound: **108 ranked a nested action first, 56 of them irreversible and 24
    transmitting outside the tenant.**
  - **The general rule over all of those was written, measured, and cut back**, because two independent reviews
    found it doing more damage than the defect. Recorded because the failures are the useful part:
    - It **inverted a request into its own undo.** "Apply a manual credit note to an invoice" — the endpoint's
      own summary, verbatim — returned `DELETE .../manual-credit-note-applications/{creditNoteInvoiceId}` first,
      because `applications` never appears in the query while the DELETE took a milder cut. Requiring every
      hyphen part of a segment to be named makes a four-part segment effectively unexemptable.
    - It **pushed legitimate requests down or out.** "signer avtalen" lost the signing operations from the top
      three, and the rounding-adjustment endpoint lost its own summary as a query at **rank 29** — past the
      default limit of 25, so out of reach altogether.
  - What ships is **single-word action segments only**, and only when there is exactly one. That is what makes
    exemption realistic: a one-word segment is a word a user can plausibly say. It excludes every harm above,
    all of which are multi-part or multi-segment, and it keeps the measured defect fixed —
    "opprett lonnskjoring" reaches `POST /api/salary-payments`, and `salary run` moved from rank 8 to 7.
  - Exemption is checked against the **expanded** terms, which is what makes it usable: "godkjenn utlegg"
    reaches `.../approve` because `godkjenn` expands to `approve`, and the a-melding filing survives because the
    phrase replacement `salary-payments-complete` carries `complete` as one of its parts.
  - The cut is hard (0.45) only where a same-method resource-level operation exists to replace it, and a
    tie-breaker (0.9) where none does. "åpne avstemmingen på nytt" asks to reopen a reconciliation, never says
    "reopen", and its family has no collection POST — 0.8 moved it from rank 9 to 10.
  - **`familyOf` was taking the first two path segments**, so a parameter counted as one and ten nonsense
    families appeared — `/salary/{id}`, `/amelding/{id}`, `/attachments/{id}`. The same action scored differently
    depending on where it lived. It now stops at the first parameter. Found by the independent review.
  - **Not a general safety property, and not claimed as one.** Actions with no path parameter are untouched.
    Two were named here as uncovered dangers, and one of those was **wrong**: `POST /api/peppol/messages/sendsbdh`
    is `internal: true`, so search never returns it unless a caller asks for internal operations — I repeated the
    review's concern without checking the flag. `POST /api/invoices/reminders/bulk` is public and does transmit,
    but no reminder query ranks it first: measured over 190 phrasings, the reminders GET wins every one.
    `POST /api/subscriptions/generate-due` is the one that does: it transmits, it is param-less, and it ranks
    **first** both for "generate due" and for its own summary "Generate due subscription billing" — only the
    Norwegian "generer forfalte abonnement" puts the per-subscription generate above it. So the param-less hole
    is real AND reachable at rank 1, which is the opposite of what a first draft of this paragraph said. Caught
    by the independent review, in the paragraph whose whole purpose was admitting an unchecked claim. Nor is
    `POST /api/invoices/{id}/reminders/forgive` ranking above the reminder-creation endpoint fixed — that is
    rank 1 on `main` too, pre-existing rather than introduced.
  - Measured over **12,193 queries**, this time including **every endpoint's own summary** as a query, which is
    the dimension the review used to find the worst case: **205 rank-1 changes, no empty result sets, no write
    newly at rank 1, one write demoted.** Six queries lost main's rank-1 answer from the default limit of 25 —
    all of the shape "close/lukk/fullfor invoices" → `POST /api/invoices/{id}/payments`, where registering a
    payment was a poor answer to closing an invoice in the first place. Named rather than averaged away.

### Investigated and deliberately not changed

- **A curated create for agreements was written and then reverted.** 143 public operations had no curated tool
  and the five agreement creates were among them, so this looked like a capability gap — an agent could amend a
  lease but not start one. It is not: `docs/tools.md` already records the decision and the reason, that the
  bodies "run to 78 fields for a lease … that the spec documents properly", `reai_describe_endpoint` shows them,
  and every trap reaches a `reai_request` caller as a quirk. My justification, that the toolset was unusable
  from scratch, was simply wrong. Re-litigating a documented decision without new evidence is not an
  improvement, and the tool was removed before it was committed.
- **The 143 figure also overstates the gap.** Most of the eleven uncovered Leads operations are `{id}` duplicates
  of `org/{orgNumber}` paths already covered — alternate addressing for one capability, counted twice. The real
  Leads gap is three capabilities, not eleven.
- **`opprett postings` ranks `POST /api/postings/customer/close`**, a close operation for a create query.
  Adding `postings` to the synonym table was measured and does not fix it: the word matches
  `/api/postings/customer/close` literally, so an injected `voucher` cannot outweigh it — unlike `postering`,
  which reaches `POST /api/vouchers` because it matches no path. The real fix is the param-less action demotion
  that #122 deferred, which needs its own design.

### Added

- **Round two of the Norwegian vocabulary work: one term mapped, eight withdrawn, the rest refused.** This
  entry began as "nine terms mapped" and is a retraction. Eight of the nine additions were withdrawn, and
  the headline claim was false in both halves.
  - **`aga` → `/api/salary-payments`** is the only addition that survives, and it does what the
    unabbreviated `arbeidsgiveravgift` already did.
  - **`fordring` was withdrawn last, after passing review, and it is the one worth reading about.** Its read
    sense is right — a receivable *is* the kundereskontro, and `fordring`, `fordringer`, "sum fordringer" and
    "vis fordringer" reached nothing or `/api/tax-returns/{year}` before. It is given up anyway, because
    `/api/ledger/customer` cannot be named without naming `/api/customers`, and this API has no POST for a
    receivable, so a write verb had nowhere correct to land: `opprett fordring` → `POST /api/customers`
    (creating a *customer*), `slett fordringer` → `DELETE /api/customers/{id}`, `endre fordring` →
    `PATCH /api/customers/{id}`. That is the `kontonummer` defect — a synonym broad enough to promote a write
    on the wrong resource — reappearing in the mapping that had survived. Three measured attempts to keep the
    read and drop the write each produced a *different* wrong write: two tokens displaced `/api/invoices`,
    `/api/vouchers` and `/api/postings` in compounds; routing write verbs to the invoice put `endre fordring`
    on the **supplier** side; routing them to the credit note (`POST /api/invoices/{id}/credit`, which is how
    a receivable is actually cancelled) lost to `slett`, which ranked a DELETE of a credit-note *application*
    instead. Recovering the read value needs the ranker to name an exact path without its resource family —
    an engine change, not another table row, and not something to bolt onto a PR about overreaching in this
    table.
  - **The claim this PR opened with was wrong twice over.** "Two of the nine fix a confident wrong answer
    rather than an empty one" — `aga` had returned seven operations **all tied at the bare-substring floor
    of 0.16**, so the top hit was index order rather than a confident answer, and `inngaende` had returned
    **nothing at all**, so it was the empty case it was cited as being better than. Noise is not confidence.
  - **Also withdrawn, each with the measurement in the source:** `kontonummer` (two different things are called
    kontonummer here, and mapping it to `account` promoted `PUT /api/general-sub-accounts/{id}` — a write on
    the wrong resource — to first place for "endre kontonummer på bankkonto", where `PUT /api/company-banks/{id}`
    had been correct); `dimensjon` (the premise was false — `departmentId` appears on two employee writes,
    `projectId` is the posting dimension — and it demoted `/api/projects`); `driftskostnader` (`/api/expenses`
    is employee expense *claims*, as this repository's own tool description says, not operating costs);
    `inngaende` (right for one sense of a standard pair, and it evicted all three vat-return operations from
    "inngående mva" and three of four `/api/opening-balances` from "inngående balanse"); `termin` (a loan
    instalment as well as a VAT period, and "betale termin" pointed at VAT filing); `anskaffelseskost`
    (evicted `/api/share-investments` from "anskaffelseskost aksjer", where PURCHASE events carry a
    `pricePerUnit`); and `fordringer`, dead code the `-er` rule already derives.
  - **Four refusal reasons were fabricated and are corrected in place.** The first version said `kredit`'s
    "closest match is `/api/creditors`", and that `trekk`, `styre` and `valutakurs` reached named endpoints.
    All four return **zero hits**. The refusals stand; the measurements never existed. Also corrected:
    `utbytte` was refused as "no endpoint reports it" when DIVIDEND is an eventType on
    `/api/share-investments/{id}/events`, and `valutakurs`'s note contradicted the correct note twelve lines
    above it.
  - **Codex reached six of the eight withdrawals independently**, and added one the author's review did not:
    `/vat-return/altinn-sync`, which bare `termin` ranked first, is classified by `test/policy.test.mjs` as
    an external transmission — so a neutral discovery query was steering toward a side-effecting call to
    Altinn.
  - These stay refused, with reasons in the source: `debet`, `kredit`, `egenkapital`, `omsetning`,
    `utbytte`, `varekostnad`, `permisjon`, `fravaer`, `sykepenger`, `trekk`, `kid`/`kidnummer`, `valutakurs`,
    `saldobalanse`, `arsberetning`, `generalforsamling`, `styre`.
  - **`betalingsbetingelser` was mapped and then removed.** The target exists and is public — `POST
    /invoice/setting/daysUntilDue`, and querying `daysuntildue` reaches it — but the synonym is outvoted by
    compound decomposition: the word splits into `betaling` + `betingelser`, and the payment endpoints win.
    The English "payment terms" fails the same way.
  - **The regression harness was the root cause and was replaced.** The first version compared rank lists
    across 388 queries and reported two changes; it drew every query from strings already committed to test
    files, which contain almost no multi-word Norwegian, so it could not see any of the regressions
    above. The replacement generates **1170 queries** — each candidate term crossed with 25 domain nouns and
    10 Norwegian verbs, plus every path segment in the spec — and it is what found both `fordring` defects,
    which the review itself had not.


- **Nine core Norwegian bookkeeping terms reached the wrong endpoint, or nothing at all.** The escape hatch
  is how an agent reaches operations no curated tool covers, and it is reached by searching — so a term that
  does not resolve costs it the endpoint it was looking for. `merverdiavgift`, the name on the Norwegian tax
  form, returned **nothing**, while the abbreviation `mva` reached `/api/vat-codes`. `arsoppgjor`,
  `aarsoppgjor` and `arsavslutning` returned nothing while `arsregnskap` was mapped. `postering`,
  `posteringer` and `posteringsgruppe` reached `/api/invoice-reception-documents`. `periodisering` reached
  the VAT-return endpoints.
  - **Two motivating claims in the first version of this entry were false, and are corrected rather than
    dropped.** It said no curated tool covers `/api/postings` or `/api/annual-accounts`. Both are false:
    `reai_list_postings` wraps `GET /api/postings`, and annual-accounts has exactly ONE operation, which
    `reai_get_annual_accounts` wraps — so the reason given for four of the nine cases was wrong. What was
    measured still stands: a query in the country's standard bookkeeping words returned nothing or the wrong
    resource. Found by the independent review of PR #118.
  - Found by probing 34 standard accounting terms written from the DOMAIN rather than from the synonym table,
    so a miss is a gap rather than a tautology: 22 landed, and only these nine had an existing target. That
    distinction did the work — `hovedbok` "missed" by returning `/api/ledger/general` and `kontoplan` by
    returning `/api/chart-of-accounts`, both **exactly right and my expectation wrong**, and three more named
    families this API does not have. The corpus is committed as `DOMAIN_PROBE`: the first version reported its
    headline number from a scratch file that no longer existed, which a reviewer cannot check.
  - `periodisering: ["voucher"]` was defended as "a judgement about Norwegian practice" the API had no opinion
    on. **The API has an opinion**: `accrualEnabled`, `accrualPeriod`, `accrualPeriodCount` and
    `accrualAccountNumber` are first-class fields on supplier-invoice cost lines and order lines, so
    periodisering is a flag on a line rather than a manual voucher. The review found that by grepping for the
    word, which I had not done before writing a comment that declared the question closed. It still maps to
    `voucher`, because `fieldNamesOf` excludes request-body fields so `["accrual"]` would match nothing — the
    comment now calls it the best REACHABLE answer rather than the correct one. English `accrual`,
    `accruals` and `periodisation` were empty and are mapped too.
  - **Two of the nine entries were dead code, and "each synonym verified load-bearing" was false** — I checked
    four of them. `posteringer` is derived by lookupForms' `-er` rule and `merverdiavgiften` by the
    definite-suffix rule; both removed. The plural in `postering: ["posting", "postings"]` **demoted the
    curated operation**, putting `/api/postings/groups` above the `GET /api/postings` that
    `reai_list_postings` wraps; dropped. And `"mva"` in the merverdiavgift list matches nothing in any of the
    430 operations while inflating the coverage multiplier — 18.9 with it, 19.18 without.
  - `arsoppgjor` maps to the `annual-accounts` path token and deliberately NOT to `accounts`, which appears in
    chart-of-accounts, general-sub-accounts and company bank accounts.
  - The tests assert **method and exact path**, not a prefix. The review repointed `merverdiavgift` at
    `vat-returns` — three filing WRITES — and the prefix version still passed, in a repository whose ranking
    design exists to stop neutral nouns surfacing writes. The phantom guard needs an exact operation too: it
    previously accepted `/api/vat`, and even `/api`, as "a family that exists". Both defeats re-verified as
    caught. Regression checked at rank level across 96 held-out queries: **not one moved a single rank.**

- **The deployment served guidance that had already been measured false, and nothing could have noticed.** PR #115 corrected two agent-facing quirks — one told agents a `+47` prefix is REJECTED on
  a supplier phone, one said foreign numbers are stored "exactly as sent", and both are wrong. Those
  commits merged; revision 00135 kept serving the old text to anything that called
  `reai_describe_endpoint` or `reai_api_notes` — for **31 minutes**, measured. The first version of this
  entry said "two days", which was invented and which the repository was not old enough for; it was 31
  minutes because someone looked, not because anything checked. The deploy recorded no commit, so the only
  way to ask "is
  this current" was to compare a revision timestamp against `git log`, which cannot distinguish a commit
  made before a deploy from one merged after it.
  - `scripts/deploy-cloud-run.sh` now stamps `commit=<sha>` as a Cloud Run label, and marks it `-dirty`
    rather than letting a label describe a build it does not match. `npm run check:deployed` reads it back.
  - Drift is split by whether a client can READ it: agent-facing (`quirks.ts`, tool files, server
    instructions, policy) exits non-zero; other `src/` changes and test-only changes are reported and pass.
    That split names which commits a client can read rather than reporting a bare "stale". The first
    version justified it with "six of the last seven merges were tests and scripts only" — asserted without
    measuring, and wrong: the exported classifier gives **five agent-facing, two inert**, so this exits 1 on
    most merges.
  - The classifier is exported and `test/deployed-drift.test.mjs` calls it, rather than grepping the script
    for a regex. Every guard in this repository that verified a script by pattern-matching its source has
    since been defeated by a comment or a rename — three times in the last four PRs.
  - Stated in the script and the docs: it cannot tell you the deployment WORKS. It compares a label against
    `git log`; `smoke-http.mjs` is what answers the other question.

- **Raised the storage floor from 12 claims to 17, starting with the two that carry real consequence.**
  The census exists to make the gap actionable rather than to make a number look good, so this worked
  through the list it names.
  - **The default path.** `reai_create_customer`'s flagship claim — "the name you send is then DISCARDED"
    when the registry is consulted — was unprobed while both `skipRegistryLookup` cases were covered. It is
    the path an agent takes when it does nothing special.
  - **The address half**, which the review of PR #115 pointed out is where the documented hazard lives. A
    supplied address survives on an ordinary company with the flag set; a directory counterparty overwrites
    it — and the overwrite is verified against **Brønnøysundregistrene** rather than a remembered string:
    stored postcode `7900` against the registry's `1331`. "Wrong postcode" is a claim about the registry,
    so a constant cannot settle it, and an agent could invoice to that address.
  - `countryCode` defaulting to `NO`, which also settles whether that default is upstream's or ours — it
    is upstream's, since nothing is sent. And `PHONE_RULE` on a **supplier** — the contact-person probe shipped in #115 — three
    of the five fields it governs; the lead field stays named-but-unprobed in the census.
  - One case came back INCONCLUSIVE first time, correctly: creating a second customer for `974761076`
    collided with the one an earlier case had already made, and the API reported it as a duplicate **name**
    — the quirk this repository documents about a duplicate organisation number. The classifier pointed at
    the probe, which now uses a company no other case touches.

- **`scripts/audit-storage.mjs` — the half `audit-messages.mjs` said it could not reach.** That script
  checks the wording of refusals, and its own contract admits every case is a request built to fail, so
  nothing there observes what the API *accepts, normalises or stores*. Two of the five false claims that
  motivated it live in exactly that gap: `skipRegistryLookup` drifts on a `201`, and the phone rule was
  wrong three separate times about what gets **stored**. Seventeen claims now checked against the live API;
  first run **17 of 17 verified**, including the evidence that the `skipRegistryLookup` override comes from
  a stale internal directory rather than the registry (`971648198` stores as "Statens Innkrevingssentral",
  a superseded name).
  - It writes, which is the whole difference. Only customers — reversible, and they delete cleanly.
    Everything is recorded in `created` and removed in a `finally`; a record that cannot be confirmed
    deleted **fails the run**; the token's reachable tenants are verified first, since a single-tenant
    token ignores `X-Tenant-Id`; and a test asserts it never touches `/api/vouchers`,
    `/api/share-investments` or `/api/general-sub-accounts`, the three paths the message audit had to have
    removed from it.
  - **Every case reads the record back** — three of the first eight compared the POST echo, in the family
    whose own constant ends "read the created record back whenever the name or address matters". And the
    staleness case asks Brønnøysundregistrene live instead of hardcoding a name: hardcoded, it would report
    OK if the registry ever converged on that name, and DRIFT if ReAI merely updated its directory — which
    would confirm the account rather than refute it.
  - **A create that succeeds on the server and fails on the way back left a record behind.** The review
    reproduced it with a proxy returning 502 after forwarding the create: the id never reached `created`, so
    the `finally` had nothing to delete and the run still exited 0. There is a baseline and an orphan sweep
    now, which is the pattern `smoke-full-write.mjs` already used and this script had declined to copy, plus
    SIGINT/SIGTERM handlers that report what an interrupted run left.
  - **It reads the record back instead of trusting the write.** Not caution for its own sake: `phone` is
    not a create field, which `reai_create_customer` already documents, and the first version of these
    probes sent it to `POST /api/customers` and reported **four DRIFTs against `PHONE_RULE`, all
    `stored null`** — when the value had never been written. The phone claims go through `PATCH` now and a
    test pins that. Counting both audits, that is the fourth time the three-outcome design has pointed at
    a broken probe instead of a correct description.
  - Each case names the **constant** making its claim, a marker phrase, and the **value that text
    predicts**. The marker alone was theatre: the review of PR #115 rewrote `PHONE_RULE` to say the
    OPPOSITE of every phone claim while keeping all four markers, and the guard passed 4/4 — markers sit in
    the opening sentences while the measured content is further down. A predicted literal cannot survive
    that. Markers must also be ≥12 characters; `marker: "e"` and `marker: " "` both passed before.
  - **The completeness bound was a cop-out and is now a number.** The first version said the population
    "cannot be measured mechanically" because a storage claim is prose. The review enumerated it anyway,
    from the two places it lives. `npm run audit:census` now prints it: **160 distinct agent-facing literals assert
    something about what is stored; 17 probes cover them, binding to 6 distinct source texts.** Different
    units, so deliberately not presented as a percentage — and the first version both double-counted
    fragments of concatenated strings and missed every backtick literal, which hid the five consumers of
    the most error-prone rule in the repository. Printed rather than asserted, since a keyword sweep is a
    lower bound — but hiding the ratio made 11-of-many read as coverage. The cheap unprobed ones are named,
    including `reai_create_customer`'s flagship "the name you send is then DISCARDED" on the DEFAULT path.
  - `test/smoke-cleanup.test.mjs` learned a second cleanup shape for it: fixtures recorded under
    **computed** keys with a `for (… of Object.entries(created))` sweep, which cannot forget a key.
    Accepted only when the sweep really deletes — verified by making it report-only and watching the guard
    fail.

- **`scripts/audit-messages.mjs` — does the API still produce the refusal strings this repository
  matches on?** Five consecutive iterations found a false *measured* claim in shipped guidance (the phone
  rule three times, `skipRegistryLookup`, a quirk telling agents to strip a correct `+47`, a 404
  translation blaming the wrong record). Every one was found by accident or by review; none by the suite.
  The reason is structural: nineteen places in `src/` match on the **text** of a ReAI error, the unit
  tests stub that text, and so they keep passing against a string the API no longer produces. This
  repository shipped exactly that once — a quirk quoting `"…kan skrives uten +"` against a live
  `"…kan skrives uten +47."`. First run: **9 of 9 triggerable messages unchanged, 0 drifted.**
  - Every case is a request built to be **refused**, so nothing is created. The first version got that
    claim wrong twice, and the independent review caught it: two probes issued calls this repo's own
    `classifyRequest` calls **irreversible** — `DELETE /api/share-investments/{first row}` with no check
    that the position had transactions (it passed only because the one position in the test tenant
    happened to be undeletable; a clean one would have been destroyed) and `POST /api/general-sub-accounts`,
    which was also the **wrong endpoint**, since that string is caught from a read-only GET.
  - It reports **three** outcomes, and `INCONCLUSIVE` earned its place three times over: probes reported
    drift because the voucher body was missing `postings[].postingDate`, then `postings[].currency`, then
    because the loan body was missing `currency` and `interestRateAnnual`. Each time the API was
    complaining about the *request* and never evaluated the rule, so the result names the probe as the
    thing to fix and says `Do NOT touch` the source file. Both shapes of shape-error are recognised now —
    `Validation failed` with `fieldErrors`, **and** `{"detail":"Failed to read request"}` with none, which
    the first version misread as drift. Worse, that version made `DRIFT` **unreachable** whenever
    `fieldErrors` was present, hiding the likeliest drift of all: a message moving from `detail` into
    `fieldErrors`.
  - Each case declares which **haystack** it compares against, because `err.message` never includes
    `fieldErrors` while the `sales.ts` translations deliberately search the raw body — a wider haystack
    than production's reports `OK` for a match the shipped code would miss. Each also declares the
    **status** it expects: six sites gate on the status, so a 404 becoming a 400 kills a translation that
    a text-only check calls fine.
  - Cleanup is part of the result. A record that cannot be confirmed deleted **fails the run**, because
    `DELETE /api/customers/{id}` can answer `{"outcome":"archived"}` and an archived customer is invisible
    to the default list. The script is now in `test/smoke-cleanup.test.mjs`'s SUITES — the review pointed
    out a third record-creating script had been written outside a guard that exists because the same
    mistake was made three times. That guard now also recognises a `for (… of Object.entries(created))`
    sweep, which covers every key by construction, but only when the loop really issues a delete.
  - `test/message-drift.test.mjs` keeps the audit complete. The first version covered exactly one shape,
    `/prose/.test(`, and the review proved it blind to `.includes`, `.exec`, `.startsWith`, a `switch`
    over a message, and single-word Norwegian compounds — six real dependencies invisible, including
    `loans.ts`'s wrong-table diagnosis, which needed no test data and so was never covered by the "no
    loans in this tenant" exemption. It also accepted `pattern.includes(probe)`, so nine probe patterns
    replaced with `/e/` satisfied everything, and floored the population at 9 against 14, so an ordinary
    refactor hoisting regexes into constants dropped five silently. All fixed and each evasion verified.
  - **Codex found a hole neither I nor the reviewer saw, and it was not confined to this script.** The
    allowlist checks the tenant NUMBER on the command line; it cannot check which company the TOKEN
    reaches. This repository's own `tenant-header-ignored-single-tenant` quirk says a token reaching
    exactly one tenant **ignores** `X-Tenant-Id` — so `REAI_WRITE_TEST_TENANTS=2783 --tenant 2783` with a
    token scoped to another company writes to that company while every guard passes. **Nothing in the
    repository checked it, including the two scripts that post to the general ledger.** All three now
    verify the token's reachable tenants first and refuse otherwise, and a test pins it for each.
  - Also from Codex: a probe that unexpectedly **succeeds** is a safety failure, not a drift. Every case
    is supposed to be refused, so a 2xx means the precondition changed — account 1320 no longer requiring
    a sub-account, say — and the probe has written to real books. It now undoes what it can, reports
    `SAFETY`, and fails the run. And a status that cannot have reached the rule (401/403/429/5xx, or a 409
    once the probe date falls in a closed period) is INCONCLUSIVE rather than DRIFT, which is the one
    thing this script must never get wrong. The phone probe also moved to the **contact-person** route,
    which is where the translation is actually consumed.
  - **What it cannot catch is now part of the contract**, in the script, the docs and here: every case is
    a refusal, so nothing observes what the API accepts, normalises or stores. Two of the five motivating
    failures remain out of reach — `skipRegistryLookup` drifts on a `201`, and the phone rule is a storage
    claim.

### Fixed

- **One phone rule, measured, replacing three accounts of it — one of which was false and told agents
  to strip a correct prefix.** This started as a wording fix and turned into a real defect: a quirk
  asserted "two phone fields, opposite rules — the ENTITY phone rejects a `+47` prefix", and
  `reai_update_customer` and `reai_update_supplier` repeated it. Measured 2026-08-08: `PATCH
  /api/customers/{id}` and `PATCH /api/suppliers/{id}` both answer **200** to `+4722334455` and store it
  unchanged. There is one rule, not two, and the old guidance removed a prefix that was right.
  - The rule now lives once, in `PHONE_RULE` in `src/tools/registry.ts`, and every phone-bearing
    argument points at it — customer, supplier, lead and contact person. Measured across all of them:
    the value is parsed with **Norway as the default region** and stored **canonicalised to E.164**.
    Nothing is stored as sent — `+46 70 123 45 67` comes back `+46701234567`, `(40) 12 34 56` comes back
    `+4740123456`, and `tel:40123456` parses. A leading `+CC`, `00CC` or a bare `47` picks the country;
    anything else is read as Norwegian and must be valid as such or the write is refused with 400.
  - The trap is those last two together, and three consecutive PRs described it wrongly in three
    different ways. A bare number that is *also* valid in Norway is stored under `+47` **with no
    warning**: the Danish mobile `40123456` becomes `+4740123456`. `20123456` is refused — and **not**
    because it is Danish, which an earlier version of this changelog implied: `20` is unallocated in
    Norway, while `21123456` and `22334455` are both accepted. So the failure to fear is a foreign
    number saved quietly as the wrong one, not a rejection.
  - The error translation no longer claims to know which country was resolved. The same 400 answers a
    bare number read as Norwegian and a number sent *with* a country code that is merely malformed, so
    the previous "refused, as here" attributed the refusal to a cause it could not observe.
  - Guarded structurally rather than by phrase, because phrase guards did not stop any of this: a test
    asserts every phone argument in the registry carries `PHONE_RULE` and that the constant itself does
    not contain the three superseded claims. A contradiction now requires editing the one place the
    measurements live. The `employee` phone remains the documented exception — it stores an unparseable
    value as `null` with a 200 instead of refusing it.

### Added

- **Contact persons on a customer** — `reai_list_customer_contacts`, `reai_get_customer_contact`,
  `reai_create_customer_contact`, `reai_update_customer_contact`, `reai_delete_customer_contact`. The named
  humans, as opposed to the customer record's own email and phone, which belong to the company. **172 tools**:
  165 across thirteen accounting domains, plus 7 always-on.
  - Measured against the live API on tenant 2783, every probe record deleted afterwards, and most of it is
    not in the spec. **Contacts can only be added to COMPANY customers** — a private one is refused with 400
    "Contact persons can only be added to company customers", which is exactly what an agent hits after
    creating a private customer and trying to name someone on it; the tool says so in those words and points
    at `reai_update_customer`. **Phone numbers are normalised, not merely validated**: `90123456` and
    `004790123456` both come back `+4790123456`, so the spec's "E.164 format" describes the stored value, not
    the input, and the tool reports the renormalisation rather than letting it look like a silent edit. An
    unparseable number is refused in Norwegian whatever the number's country, translated here. (That
    bullet described the behaviour as Norwegian-only; see the phone-rule entry above for the measured
    account, which supersedes it.)
  - On the update, `null` and omitting leave a field unchanged while `""` clears it — which the spec does say,
    and which is easy to verify wrongly: clear a field first and `null` then reports "unchanged" whichever the
    API does. Each case was run from a freshly populated contact. A blank name is refused rather than treated
    as a clear.
  - **The independent review found the descriptions were confidently wrong in four places, one of them
    dangerous.** The 404 translation matched `/Customer with id=/i` case-insensitively — and the
    contact-not-found sentence is "Contact person with id=22 not found **for customer with id=6022**",
    which contains it. So the commonest 404 on these endpoints was reported as "Customer N does not
    exist in this tenant" about a customer that was fine, sending the agent off to re-check or
    re-create it. Same shape as the reconciliation finding Codex caught: a phrase-gated translation
    turning one failure into a confident verdict about a different one.
  - Measuring the wording then ruled out the obvious fix. A genuinely deleted contact answers the
    **same sentence** as a wrong-parent one, word for word, so the two cannot be separated. Both are
    reported as ambiguous with the way to settle them. That also fixed the delete, which returned a
    flat success for any 404 — including a typo'd `customerId`, where the contact demonstrably
    survives — telling the agent its goal was met when it might not be.
  - Three descriptions promised `null` for "leave unchanged" while the schema was
    `z.string().optional()`, which zod refuses; an agent copying the wording out of the spec got
    "Invalid arguments for tool". Now `.nullable()`, with nulls stripped so null and omitting share one
    path. `reai_get_customer_contact` had the 404 backwards (it is about the contact, not the customer).
    The header comment claimed "nothing in the schema hints at" the company-only rule — the spec does
    say it, on `CreateCustomerReq.contactPersons`. And the two read tools overlap `reai_get_customer`,
    which already returns `contactPersons`; the descriptions now say so instead of implying otherwise.
  - Four **quirks** for the escape-hatch path, which had none: the company-only rule, the phone
    normalisation, the blank-vs-null semantics and the ambiguous 404. Plus a fifth found while
    re-verifying: `POST /api/customers` reports a duplicate **organizationNumber** as
    "En kunde med navnet <NAME> finnes allerede." — quoting the EXISTING customer's name, which appears
    nowhere in the request. Isolated on the live API. 121 quirks.
  - The suite's own guards caught two things on the way in, both worth more than the tools. The
    path-placeholder sweep could not attribute `{id}` in `/api/customers/{id}/contact-persons/...` to a
    `customerId` argument, so `resolveArg` now resolves a placeholder against the **owning path segment** —
    structure, not domain knowledge, and it generalises to every nested resource in this API. That also
    attributed two placeholders previously listed as unattributable, `reai_create_offer {id}` and
    `reai_create_order {id}`, whose bounds had never been swept and now are; one entry is left on that list.

## Unreleased

### Fixed

- **`skipRegistryLookup` promised "use exactly the details supplied" on both tools that carry it, and
  the first correction was wrong twice over.** Measured on **29** organisation numbers rather than the
  five the first attempt used: sixteen ignore the flag and overwrite both name and address, including an
  address supplied in the same request. They are the standard billing counterparties — Skatteetaten,
  Brønnøysundregistrene, Statens vegvesen, Kartverket, Husbanken, Innkrevingsmyndigheten, DNB, Nordea,
  SpareBank 1, Telia, Telenor Norge, Elvia, Posten Bring, If, Gjensidige, Circle K. Ordinary companies,
  sole proprietorships, sub-units, unregistered numbers, and agencies that do not invoice small
  companies respect it. Telenor is the clean pair: holding company `982463718` respects the flag, billing
  entity `976967631` does not.
  - **The override does not come from Brønnøysundregistrene**, which both earlier versions asserted.
    `971648198` comes back as "Statens Innkrevingssentral" (a superseded name), `920058817` as
    "First Card (nor)" (not a registry name), and `976967631` with postcode 7900 Rørvik where the
    registry says 1331 Fornebu. The source is a stale ReAI-maintained directory — a materially worse
    hazard, because a record can be created with an address that is simply **wrong**, at `201` and with
    no warning. That is what justifies "read the created record back".
  - **The flag has one load-bearing use nothing documented**: an organisation number that is mod-11
    valid but not registered can only be created WITH it. Without, the lookup fails and the API answers
    `500 {"detail":"404 : [no body]"}`.
  - The correction now lives once, in `SKIP_REGISTRY_LOOKUP_RULE`, and **`reai_create_supplier` uses it
    too** — the first pass corrected the customer tool and left the identical false string on the
    supplier tool, whose endpoint behaves the same way. A quirk that told agents "pass
    skipRegistryLookup to use exactly what you sent" was still attached to the same operation as its own
    correction, so `reai_describe_endpoint` answered with both at once; fixed, and a test now asserts no
    quirk on that operation promises exactness.
  - The first test pinned `974761076` as *the* counterexample, "or the warning is unusable" — locking in
    the claim the wider measurement refuted, so correcting the description required editing the test.
    It now pins the **shape** of an honest warning (a class of counterparty, the real source, the
    load-bearing use) rather than any sentence, matches case-insensitively, and lives in its own file
    instead of the contact-persons one.
  - Two measurement bugs of my own are worth recording. A probe sent a nested `address` object, which
    `CreateCustomerReq` does not declare — the fields are flat — so it was silently ignored and I
    concluded a supplied address was dropped. And an earlier helper compared names case-sensitively,
    reporting a kept name as overridden, because ReAI title-cases what it stores.

- **One phone rule, measured, replacing three accounts of it — one of which was false and told agents
  to strip a correct prefix.** This started as a wording fix and turned into a real defect: a quirk
  asserted "two phone fields, opposite rules — the ENTITY phone rejects a `+47` prefix", and
  `reai_update_customer` and `reai_update_supplier` repeated it. Measured 2026-08-08: `PATCH
  /api/customers/{id}` and `PATCH /api/suppliers/{id}` both answer **200** to `+4722334455` and store it
  unchanged. There is one rule, not two, and the old guidance removed a prefix that was right.
  - The rule now lives once, in `PHONE_RULE` in `src/tools/registry.ts`, and every phone-bearing
    argument points at it — customer, supplier, lead and contact person. Measured across all of them:
    the value is parsed with **Norway as the default region** and stored **canonicalised to E.164**.
    Nothing is stored as sent — `+46 70 123 45 67` comes back `+46701234567`, `(40) 12 34 56` comes back
    `+4740123456`, and `tel:40123456` parses. A leading `+CC`, `00CC` or a bare `47` picks the country;
    anything else is read as Norwegian and must be valid as such or the write is refused with 400.
  - The trap is those last two together, and three consecutive PRs described it wrongly in three
    different ways. A bare number that is *also* valid in Norway is stored under `+47` **with no
    warning**: the Danish mobile `40123456` becomes `+4740123456`. `20123456` is refused — and **not**
    because it is Danish, which an earlier version of this changelog implied: `20` is unallocated in
    Norway, while `21123456` and `22334455` are both accepted. So the failure to fear is a foreign
    number saved quietly as the wrong one, not a rejection.
  - The error translation no longer claims to know which country was resolved. The same 400 answers a
    bare number read as Norwegian and a number sent *with* a country code that is merely malformed, so
    the previous "refused, as here" attributed the refusal to a cause it could not observe.
  - Guarded structurally rather than by phrase, because phrase guards did not stop any of this: a test
    asserts every phone argument in the registry carries `PHONE_RULE` and that the constant itself does
    not contain the three superseded claims. A contradiction now requires editing the one place the
    measurements live. The `employee` phone remains the documented exception — it stores an unparseable
    value as `null` with a 200 instead of refusing it.

### Added

- **Contact persons on a customer** — `reai_list_customer_contacts`, `reai_get_customer_contact`,
  `reai_create_customer_contact`, `reai_update_customer_contact`, `reai_delete_customer_contact`. The named
  humans, as opposed to the customer record's own email and phone, which belong to the company. **172 tools**:
  165 across thirteen accounting domains, plus 7 always-on.
  - Measured against the live API on tenant 2783, every probe record deleted afterwards, and most of it is
    not in the spec. **Contacts can only be added to COMPANY customers** — a private one is refused with 400
    "Contact persons can only be added to company customers", which is exactly what an agent hits after
    creating a private customer and trying to name someone on it; the tool says so in those words and points
    at `reai_update_customer`. **Phone numbers are normalised, not merely validated**: `90123456` and
    `004790123456` both come back `+4790123456`, so the spec's "E.164 format" describes the stored value, not
    the input, and the tool reports the renormalisation rather than letting it look like a silent edit. An
    unparseable number is refused in Norwegian whatever the number's country, translated here. (That
    bullet described the behaviour as Norwegian-only; see the phone-rule entry above for the measured
    account, which supersedes it.)
  - On the update, `null` and omitting leave a field unchanged while `""` clears it — which the spec does say,
    and which is easy to verify wrongly: clear a field first and `null` then reports "unchanged" whichever the
    API does. Each case was run from a freshly populated contact. A blank name is refused rather than treated
    as a clear.
  - **The independent review found the descriptions were confidently wrong in four places, one of them
    dangerous.** The 404 translation matched `/Customer with id=/i` case-insensitively — and the
    contact-not-found sentence is "Contact person with id=22 not found **for customer with id=6022**",
    which contains it. So the commonest 404 on these endpoints was reported as "Customer N does not
    exist in this tenant" about a customer that was fine, sending the agent off to re-check or
    re-create it. Same shape as the reconciliation finding Codex caught: a phrase-gated translation
    turning one failure into a confident verdict about a different one.
  - Measuring the wording then ruled out the obvious fix. A genuinely deleted contact answers the
    **same sentence** as a wrong-parent one, word for word, so the two cannot be separated. Both are
    reported as ambiguous with the way to settle them. That also fixed the delete, which returned a
    flat success for any 404 — including a typo'd `customerId`, where the contact demonstrably
    survives — telling the agent its goal was met when it might not be.
  - Three descriptions promised `null` for "leave unchanged" while the schema was
    `z.string().optional()`, which zod refuses; an agent copying the wording out of the spec got
    "Invalid arguments for tool". Now `.nullable()`, with nulls stripped so null and omitting share one
    path. `reai_get_customer_contact` had the 404 backwards (it is about the contact, not the customer).
    The header comment claimed "nothing in the schema hints at" the company-only rule — the spec does
    say it, on `CreateCustomerReq.contactPersons`. And the two read tools overlap `reai_get_customer`,
    which already returns `contactPersons`; the descriptions now say so instead of implying otherwise.
  - Four **quirks** for the escape-hatch path, which had none: the company-only rule, the phone
    normalisation, the blank-vs-null semantics and the ambiguous 404. Plus a fifth found while
    re-verifying: `POST /api/customers` reports a duplicate **organizationNumber** as
    "En kunde med navnet <NAME> finnes allerede." — quoting the EXISTING customer's name, which appears
    nowhere in the request. Isolated on the live API. 121 quirks.
  - The suite's own guards caught two things on the way in, both worth more than the tools. The
    path-placeholder sweep could not attribute `{id}` in `/api/customers/{id}/contact-persons/...` to a
    `customerId` argument, so `resolveArg` now resolves a placeholder against the **owning path segment** —
    structure, not domain knowledge, and it generalises to every nested resource in this API. That also
    attributed two placeholders previously listed as unattributable, `reai_create_offer {id}` and
    `reai_create_order {id}`, whose bounds had never been swept and now are; one entry is left on that list.

## Unreleased

### Fixed

- **`skipRegistryLookup` promised "use exactly the details supplied", and that is not safe.** Flagged
  by the review of PR #112 and measured properly here, on five real organisation numbers with the flag
  set: four were respected (Equinor, Symfoni, VN Norge, NAV — name kept, address left empty) and
  `974761076` (Skatteetaten) was not, coming back with the registry's name **and** address and
  overwriting an address supplied in the same request. Why that number differs is **not established** —
  most likely a built-in company record for the tax authority, but nothing in the API exposes those, so
  the note says hypothesis rather than fact. NAV is also a public agency and did respect the flag, so
  that is not the rule either. The description now says what was measured and tells the caller to read
  the record back; a flag that works four times in five is worse than one that never works, because the
  caller stops checking.
  - The first attempt at the new description **quoted the old promise while correcting it** — and the
    new test caught it. An argument description is injected into the agent's context, where a skimmed
    quotation reads as the claim, so the assertion is that the phrase is absent rather than merely
    contradicted. Same lesson as the phone quirk, which now keeps its history at the end.

- **The tenant boundary rested on the position of one line, and `Authorization` was never protected at
  all.** `ReaiClient.request` spread caller-supplied headers into its header object and assigned
  `X-Tenant-Id` afterwards, so the bound tenant won only because that assignment came second. Moving the
  spread after it — a refactor, not a formatter; no formatter reorders statements — lets a caller override
  the tenant, with 859 tests still passing. Latent, since `reai_request` has no `headers` argument and no
  caller in the repository passes one, but it is the last line of the boundary the consent page promises.
  - The wire behaviour was measured through the real build against a local server, and the first attempt
    at this fix recorded it wrongly twice. Object keys are case-sensitive and header names are not, so a
    caller's `x-tenant-id` did not collide with the `X-Tenant-Id` set below it — but undici does not then
    send two headers: building `Headers` from a record appends, which comma-**folds**. What went out was a
    single `x-tenant-id: 2634, 2783`, caller's value first. Upstream answers 400 to that, and not because
    it rejects duplicates: the folded value fails an integer parse. Sent as two genuine header lines,
    upstream honours the **first** — 200, with the caller's company's data.
  - So the old code failed closed only because of how one fetch implementation flattens a record. The
    client now **refuses** `authorization`, `x-tenant-id` and `content-type` from a caller rather than
    racing them, which is the choice `buildUrl` already makes for an ambiguous path segment: refuse
    rather than resolve it silently. Substituting the bearer token is a larger break than redirecting one
    request, and it sat unprotected one line above the tenant header. `content-type` had the identical
    case-collision bug: a caller's `text/plain` with a JSON body folded to `text/plain, application/json`.
  - Recorded with it: a read-only re-probe of the live API on `GET /api/company-banks`, which
    discriminates cleanly (tenant 2634 holds three, 2783 none). Query spellings of a tenant id are
    ignored, a matrix parameter is rejected, and `/api/company-banks/2634` is read as a **record** id —
    which is why the guard consults the spec for path parameters and nowhere else. A scan refusing every
    tenant-shaped path segment would refuse `/api/customers/2634`, an ordinary call.

- **Swept the test suite for the failure it has produced three times in one day, instead of waiting for a
  fourth.** A documentation check that read one file, a count check whose band admitted the wrong number,
  and an enum check that skipped everything nested in an array — all three were found by review, and all
  three were the same shape: an assertion over a filtered collection with nothing asserting the filter
  still matched anything.
  - That class is mechanically detectable, so it was measured rather than reasoned about: empty the
    corpora at the `dist/` boundary — `allTools`, `registeredTools`, `TOOL_GROUPS`, `QUIRKS` — and see
    which tests still pass. **Thirty sweeps stayed green with nothing to examine.**
  - Five had filters that could realistically stop matching, and now carry a floor: the destructive-tool
    sweep (a `reai_delete_` prefix), the getter-id convention (a prefix *and* a risk tier), the
    transmitting-tool check (a single boolean flag), and two **absence** claims — no salary tool completes
    a payroll run, no access tool writes to `/api/users`. For an absence claim the floor is not a count of
    offenders but of the population being constrained: "no salary tool completes a run" is satisfied by
    there being no salary tools at all, which is what it would read the day that toolset failed to
    register.
  - The other twenty-five were left alone deliberately, and `test/README.md` says why: they iterate the
    whole registry with no narrowing filter, so emptying them means emptying the registry, which fails
    dozens of tests first. A floor there would be ritual rather than protection.
  - Verified the way the problem was found: with the corpora emptied, 604 tests passed before this change
    and 599 after — exactly the five, and no others disturbed. `test/README.md` records the method so the
    next person repeats it rather than rediscovering it.

### Added

- **A guard for the other direction of spec drift: a tool enum that has fallen behind the document.**
  `test/spec-bounds.test.mjs` has always guarded looseness — a tool accepting what the API will reject, so
  the caller gets a bare 400 instead of a reason. The mirror was unguarded and is quieter: a hardcoded
  `z.enum` that no longer matches the document REFUSES a value the API accepts, locally, with a validation
  error that reads like the caller's own mistake. Nothing upstream is consulted, so nothing ever corrects
  it.
  - There are eighteen such lists across the curated tools, seven of them added by this repository in a
    single day: loan types, perspectives, repayment types, day-count conventions, interest treatments,
    instrument types, event types. Each is a copy of something the document states, and a copy is a claim
    with a shelf life — the same shape as the operation count that had to be fixed three times.
  - **No drift today**, which is the point of adding it now rather than after a spec refresh has quietly
    broken a domain. It reads parameters as well as bodies, following `$ref`s into
    `components.parameters` too, since several query enums live there.
  - Mutation-verified: dropping `company_loan_to_employee` from the loan types and `BOND`/`OTHER` from the
    instrument types each fail with the refused values named.
  - **Then review found the first version weaker than its own claim, in three ways.** It iterated top-level
    arguments only, so every enum inside an array of objects was invisible —
    `reai_create_expense.perDiems[].tripType` and `costs[].category` among them, both backed by documented
    enums. It is keyed on dotted LOCATIONS now, the way `constraintsOf` already does it for bounds and for
    the same recorded reason, and shortening a nested list fails where before it passed silently.
  - The exemption map held argument names, so one entry suppressed the comparison for **every** value of
    that argument — the day the document gained another, that drift would hide behind an exemption written
    for something else. It holds specific values now, verified: exempting `other` still catches
    `intercompany` going missing.
  - And the vacuity floor of eight was far too low: it let the sweep lose most of its comparisons and stay
    green, while counting operation occurrences rather than distinct locations made it easier still, since a
    create and an update sharing an argument both counted. The complete set of **39** comparisons is pinned,
    so losing one fails and gaining one fails with a nudge to record it.
- **Manual bank reconciliation: four curated tools for the accounts ReAI does not sync.** The roadmap had
  this blocked on "no data", and the blocker turned out to be a misreading — **a company bank created
  through this API is manual**, measured (`manual: true`, `displayName` ending "[Manual]"), so the domain
  was always testable. Tenant 2634's three accounts are all `providerType: ztl` and belong to the existing
  synced tool. 167 tools.
  - The state machine measured end to end: entering the statement balance makes `canClose` true **only when
    the difference is zero**, closing sets `reconciliationLocked` and `canReopen: true`, and reopening
    returns it. `difference` is the statement minus the books, and the API reports `canClose`/`canReopen`
    itself — so the read tool passes those on as the API's answers rather than inferring them.
  - **Nothing in the flow posts.** Across setting the balance, closing and reopening, the voucher count
    stayed at 0 and the posting count did not move: this is a period lock, not a booking, and closing is
    reversible by the same caller, unlike a VAT period. The three writes are still `irreversible` to match
    the policy tier for `/api/manual-reconciliations` — recorded rather than relaxed, as with loans.
  - **Four Norwegian refusals translated, one of them found by driving the tools live.** The close handed
    back `409 "Angi sluttsaldoen før du lukker avstemmingen."` raw, which is precisely the gap two reviews
    have caught elsewhere: documenting a refusal and then forwarding it untranslated. Closed before a third
    review had to say it.
  - The most useful of the four was not in the original measurement at all. Closing the **current** month
    answers `409 "Godkjenning er kun tilgjengelig for 2026-07."` — the refusal *names the month the API will
    accept* — and a future month answers the same while an earlier one falls through to the balance check.
    So reconciliation runs in order, a month that has not ended cannot be closed, and the answer was sitting
    inside a sentence the caller could not read. The tool now reads the nominated month out of it.
  - The ambiguous `404 "Bankkonto ikke funnet"` is translated too: it is what a missing id says *and* what a
    perfectly good synced account says, so the refusal names `reai_list_company_banks` as the way to tell
    them apart and points at the synced tool.
  - **Three more from review, and the first is the one that would have wasted the whole PR.** The
    connect-time instructions every session receives still sent agents to `/api/manual-reconciliations/{id}`
    through the escape hatch, and the UI tool repeated it twice — so the curated tools, and the translations
    that are the reason they exist, would have been routed around. Updated in both places, with a test that
    fails if either points at the raw endpoint again.
  - The amounts were printed unlabelled while the API returns `bankCurrency`, `tenantCurrency` and
    `bankInTenantCurrency`. A company bank can be created in any currency, so an EUR statement balance read
    as kroner; the figures now carry their unit and say when the account is not in the tenant currency.
  - The three state translations matched on the message alone, so a 5xx whose body happened to contain one
    of those Norwegian sentences would have been converted into a definitive *"Nothing was changed"* — and a
    failed POST or PUT is precisely what this client treats as ambiguous and will not retry, so that is the
    one claim not to make. All three are gated on 409 now, the status they were measured at.
  - Verified live on 2783 in three passes, each cleaning up: the full state machine, then every refusal in
    English, then the nominated-month path through to a successful close.

### Fixed

- **A number that has now been wrong three times is computed instead of maintained.** How many operations
  no curated tool covers was stated as "~256" when the registry was small, then corrected to 170 in two
  test comments that had said "~250" — and by the time loans, counterparties and share investments had
  shipped, the truth was **152** while **seven** places still said 170 or ~256, including the README and
  `docs/api-quirks.md`. Every one of those corrections was accurate the day it was written.
  - The previous guard was a band (150–190) and it was the wrong instrument: 152 sits inside it, so the
    test stayed green while the README's figure was 18 too high. A band watches the world; what rots is
    the prose.
  - It now **reads the claims**. Any "N operations no curated tool cover(s)" or "N uncovered operations"
    in the README, in `docs/`, or in any test file must equal the computed figure, and there must be at
    least four such sentences — so deleting them is not a way to pass. Adding a curated toolset now fails
    here with every stale file named, which is the only sort of reminder that survives contact with a
    later iteration.
  - Mutation-verified in both directions: putting 170 back in the README fails with
    *"README.md: says 170"*, and stripping the sentences fails with *"only 0 statements of the uncovered
    count were found"*.
  - **And then review found the new guard was itself blind to two of the six claims.** Both wrap inside a
    JSDoc block, and the `*` starting the continuation line sits between the words, so the regex skipped
    them — a test whose entire job is catching stale prose, reporting itself satisfied while guarding four
    of six. Comment leaders are stripped and whitespace collapsed before matching now, the floor is six
    rather than four, and drift in a previously invisible claim fails with the file named.
  - The subtraction also counted declared pairs without checking they are public, so a curated tool
    declaring an internal path would have made the enforced figure too low. Intersected now. It changes
    nothing today — no tool declares one, verified — but with a synthetic internal declaration the naive
    form yields 151 against the correct 152, which is exactly the wrong number this test would then
    enforce everywhere.
- **Reclassifying a share investment left it booked on the old type's account.** Raised in review as a
  documentation point; measuring it made it behaviour. The asset account is derived at creation and the
  API does not move it — a `LISTED_SHARE` position on 1810 was changed to `BOND`, `FUND`,
  `UNLISTED_SHARE` and `OTHER` in turn, every `PUT` answered 200, and the account stayed **1810** every
  time. Fresh positions of those types derive **1830**, 1810, **1350** and **1820**, so the numbers
  genuinely differ per type and a bare relabelling leaves the holding on the wrong balance-sheet line
  with nothing in the response saying so.
  - `reai_update_share_investment` now refuses a type change that does not name an `assetAccountNumber`,
    and quotes what a fresh position of the new type derives so the caller can accept or override — the
    same shape as the loan reclassification guard, for the same reason: the merge cannot tell a derived
    number from a deliberate one. Restating the type a position already has is not a change and still
    writes.
  - The measured table is kept as data next to the enum rather than as prose, so the refusal can name a
    number, and there is a test that fails if a type loses its measured account.
  - Verified live on tenant 2783: the bare reclassification is refused naming both 1810 and 1830, the
    same call with `assetAccountNumber: "1830"` goes through and stores `BOND`/1830, and the position was
    deleted afterwards.

### Added

- **The live write suite now covers loans and their counterparties**, which had none — the domain with the
  most measured, undocumented behaviour in this repository and no standing check that any of it is still
  true. An upstream change to the direction rule, the derived accounts, the reference uniqueness or the
  deletion ordering now shows up in a suite run rather than in someone's books, which is how the
  expense-voucher regression was found only by luck.
  - Eleven checks: the direction-locked pair refused before anything is sent, a borrower loan created with
    the derived 2220/8150/2950, the voucher count **not** moving (a loan record posts nothing), the
    duplicate reference refused in English, a partial edit keeping `repaymentType` and both interest
    accounts, the reclassification refusal quoting the accounts the API would derive, and a creditor a
    loan still names refusing deletion with the ordering.
  - Cleanup runs loan-first, which is the other half of that last assertion, and three new sweeps
    (`loans`, `creditors`, `debtors`) fail if anything test-named survives. All three are fully removable,
    measured, so a leftover there is a cleanup that did not run rather than a record the API refuses.
  - The suite now uses `reai_create_creditor` and `reai_delete_creditor` where it previously reached for
    `reai_request`, so the curated path is what gets exercised.
  - Share investments are deliberately NOT exercised: an event there is permanent and posts to a real
    ledger, so a suite that ran it would leave a record behind every time. The section says so.
- **A leftover sub-account explained rather than ignored.** The suite flagged `zz-si-probe` on account 1810
  as unaccounted for. Measured: creating a share investment **auto-creates a general sub-account** on its
  derived asset account, named after the position — and deleting the position removes it again, so this is
  not a leak in the normal case. It is stuck here because that particular position has an event and cannot
  be deleted, and sub-accounts have no `DELETE` endpoint at all. Recorded as known-unrecoverable with the
  reason, which makes the suite green at 158/0 without hiding anything.
- **Share investments: seven curated tools, built around the constraints that were measured first.** The
  domain was recorded as module-disabled and was only empty; the previous entry records the four quirks
  that came out of driving it. 163 tools across thirteen domains.
  - **The create tool refuses an opening balance unless the caller says a permanent record is intended.**
    `openingQuantity`, `openingCostAmount` and `openingDate` look like fields on a record and silently
    produce a `PURCHASE` event; a position with any event can never be deleted, and nothing removes an
    event. `acceptPermanentPosition: true` is the only argument on this server whose job is to make
    someone stop and think, and it exists because one position on the write test tenant is unremovable
    for exactly this reason. The refusal names both ways forward — create it empty and add the purchase
    as an explicit event, which is also the only way to give it a settlement account and a fee.
  - **The position and the event are classified apart** because only one of them posts: creating a
    position left the voucher count at 0, while a `DIVIDEND` booked `SH1-2026` on 1920/8071. The event
    tool is `destructive` as well as `irreversible`, reports the `voucherId` it booked, and says
    *unconfirmed* rather than guessing when the response carries none.
  - Both Norwegian refusals are translated where they surface: the securities account an event needs
    (`"Velg verdipapirkontoen transaksjonen ble gjort opp mot."`, on a body the document marks as
    requiring nothing) and the deletion refusal — which is really about a decision taken at creation, so
    the message says so and points at the event list. Anything else propagates.
  - `reai_update_share_investment` reads and merges, because the `PUT` replaces *and* requires
    `instrumentType`, which the document does not list as required.
  - **The Nordnet bulk import is deliberately not curated.** One call, an unknown number of events, every
    one a posting, and every position it touches made permanent. `reai_request` reaches it for anyone who
    means it, and there is a test recording the decision so it reads as a choice rather than an oversight.
  - The repository's own guards caught two things before review did: `test/spec-bounds.test.mjs` rejected
    five argument bounds I had guessed at (the spec caps `name` at 150, `ticker` 20, `isin` 12,
    `organizationNumber` 9, `assetAccountNumber` 10, and requires `amount` ≥ 0.01), and the read-tool
    sweep required the local `query` filter to be declared with the test that proves it.
  - **One structural weakness found and closed before review.** `INVESTMENT_SETTABLE` — the vocabulary the
    update merge may carry — listed the opening fields, because they are part of the `PUT` body. That meant
    the only thing stopping `reai_update_share_investment` from creating the very event the create tool
    guards against was zod stripping an undeclared argument: verified through the real server, the PUT body
    comes out clean, but calling the handler directly forwards it, and one `.passthrough()` or one added
    argument would make that the live path. The opening fields are out of that list, so the update cannot
    express an opening balance at all, and there is a test driving the handler directly to keep it that way.
    `mergeForReplacement`'s own comment warns about this exact shape.
  - **Two reviews found thirteen more things, and three were claims of mine that were simply false.**
    - `assetAccountNumber` is **settable** — it is in `ShareInvestmentReq` and this server sends it — so
      "it survived the omitting PUT because it is derived rather than settable" was the wrong mechanism,
      stated in the module doc, the tool description, `docs/tools.md` and a quirk. `quantity` and
      `costPrice` genuinely are derived and cannot be sent; the account number survived once, and why is
      unmeasured. Corrected everywhere, because the mechanism is what a reader reasons from.
    - The description asserted facts the API never reported: an absent `withinExemptionMethod` read as
      *"outside the exemption method"* — a tax classification inferred from a missing field, three lines
      from a sentence saying this server does not judge that — and a missing account number printed as
      *"Asset account none"*. Both now say unknown. This is the defect class the repo already names in
      `test/writes.test.mjs`.
    - *"`reai_request` reaches it for anyone who means it"*, about the Nordnet import, is very likely
      false: nothing here constructs a `FormData`, and a JSON-transported MCP argument never is one. The
      honest version says the import belongs in the ReAI UI and that the JSON form is unverified —
      establishing it would require a call that posts.
    - `reai_create_share_investment` did not translate the settlement-account refusal, which **its own
      accepted opening balance can provoke**, since that balance is an event. The caller who acknowledged
      permanence in writing got the raw Norwegian back. Both write tools translate it now.
    - "Deleting its voucher answers `reversed`" was one measurement stated as a rule, and this repo's own
      `reai_delete_voucher` says ReAI chooses delete or reverse — with a quirk recording a "reversed" that
      left no postings at all. Hedged to the observation.
    - `destructive: true` on the event tool changed nothing (`destructiveHintFor` already returns true for
      anything irreversible) and no other ledger-posting POST here carries it. Dropped, along with the
      claim that it added protection; the test now asserts the hint the client actually receives.
    - `quantity`, `pricePerUnit` and the opening amounts are bounded positive locally — the document
      leaves them bare, and a negative-unit PURCHASE would be a permanent event. Recorded as a local
      decision rather than a documented bound, which is the distinction `spec-bounds` keeps honest. The
      genuinely unknown failure modes (a SALE larger than the holding, a non-`OPEN` status, an event in a
      closed period) are now stated as unknown instead of implied.
    - Five mutations that had survived are now caught: the query filter losing fields, derived fields
      echoed into the replacing PUT, `INVESTMENT_REQUIRED` losing `instrumentType`, the exemption ternary,
      and `readableRecord` losing its expect-list. The "Nordnet not curated" test was vacuous — it
      asserted a name does not exist and that the word "ledger" appears somewhere — and now asserts the
      reasoning survives, which is the only thing that makes an absence a decision.
  - Verified live on tenant 2783 without creating a single event: the opening-balance refusal fires, a
    position created empty reports itself deletable and deletes, the merge keeps `ticker` through a
    rename, and the known-permanent record refuses deletion with the reason. Nothing new was left behind.

### Changed

- **`reai_list_creditors` and `reai_update_creditor` moved from the `purchase` toolset to `loans`.**
  A deployment pinned to `REAI_TOOLSETS=purchase` loses both: add `loans` to keep them. `purchase` goes
  from 33 tools to 31, `loans` from 12 to 20. The reasoning is under Added below — in short, `creditorId`
  and `debtorId` occur once each in the whole API document, both on `LoanRes`, so a creditor is not a
  payables concept in ReAI.

### Added

- **The lender half of the loan matrix was unrecordable, and the counterparties were in the wrong
  toolset.** Deferred deliberately from the loans PR and closed here. Every `company_loan_to_owner`,
  every `company_loan_to_employee` and the lender side of `intercompany` and `other` needs a **debtor**
  id, and nothing listed or created one — so four of the eight legal type/perspective combinations could
  only be recorded by dropping to `reai_request`.
  - Four new tools: `reai_list_debtors`, `reai_create_debtor`, `reai_update_debtor`, `reai_delete_debtor`,
    plus `reai_create_creditor` and `reai_delete_creditor` for the side that had a list and an update but
    no way to make or remove one. 156 tools.
  - **`reai_list_creditors` and `reai_update_creditor` moved from `purchase` to `loans`,** on evidence
    rather than taste: `creditorId` and `debtorId` occur **once each in the entire API document**, both
    on `LoanRes`, and nothing else references either. A creditor *sounds* like a payables concept, which
    is presumably how it came to sit with suppliers, but in ReAI it is one end of a loan. The practical
    cost of the old placement: enabling only `loans` left a caller unable to create what its own tools
    demand, while enabling only `purchase` gave two tools for a domain that toolset does not cover.
  - **Names are unique on neither side.** Measured: two debtors called the same thing were created as
    ids 19 and 20 without complaint — unlike a loan's `reference`, which is rejected. So an agent told
    to use "the debtor called X" can be choosing between duplicates, and `reai_list_debtors` counts
    repeated names and says to choose by id.
  - The asymmetry between the two is real and visible in the shapes, not merely the tidy story the old
    comment admitted was unverified: a creditor is `{id, name, bankAccountNumber, …}`, a debtor is
    `{id, name, …}` with no account at all. Re-measured while moving it: answered 200 and set `bankAccountNumber` to **null** (the probe value, `1506 20 99533`, was supplied by this repository and fails the Norwegian mod-11 check — not anyone's account),
    which is what `reai_update_creditor`'s read-merge-write exists to prevent and why
    `reai_update_debtor` needs none.
  - Both deletes translate the `409` the ordering causes: the API says
    *"Cannot delete creditor that is referenced by one or more loans"*, which names the constraint but
    not the way out — loans first, and `reai_list_loans` shows which point where. An unrelated 409 is
    rethrown rather than explained as a loan reference, which is the PR #97 lesson.
  - **Fifteen review findings addressed, and the first one is about my own prose.** An account number
    appeared in a tool *description* — which ships in the MCP manifest to every connecting model — with
    surrounding text asserting it was read off a live tenant. It was a value this repository supplied, and
    it fails the Norwegian mod-11 check digit, so it can be nobody's account; but "measured on a live
    tenant" next to eleven digits reads as a real counterparty's bank details in a public repo. The
    description now carries no digits at all, and the three places that keep the number say what it is.
    - *`reai_update_debtor` had zero coverage*, and three mutations proved it: sending `body: {}` still
      reported *"Debtor 19 renamed to …"* because the note was built from the argument, and writing to
      `/api/creditors/{id}` from either debtor tool went unnoticed. The notes now report what the API
      **stored** — including "unconfirmed" when the response carries no name, and a warning when the API
      stored something other than what was sent, since ReAI title-cases names elsewhere.
    - *The duplicate-name detection missed the collisions that matter*: `"Kari Nordmann"` against
      `"kari nordmann"`, and a trailing space. It now keys on a normalised name and displays the
      original — and it no longer throws a `TypeError` out of a read tool on a list containing `null`.
    - *"A debtor is `{id, name}` — measured" was a claim about the RESPONSE*, presented as one about the
      record. `components.schemas.Debtor` also carries `archived` and `tenantId`, which `DebtorRes` does
      not expose, so whether a replacing `PUT` resets `archived` is unknown and unobservable from here.
      The argument for `reai_update_debtor` needing no merge is now the true one — `DebtorReq` accepts
      only `name`, so the request cannot carry anything else — and the unknown is stated instead of
      papered over. `reai_list_debtors` also says an expected-but-absent debtor may be archived, since
      that endpoint takes no parameters and cannot be asked.
    - *Creditor name non-uniqueness was asserted flatly and only debtors were measured.* Hedged, with the
      counter-example named: an employee name IS unique here (`409 "Ansatt med dette navnet finnes
      allerede"`), so ReAI is inconsistent and a mirror-image inference is not safe. Both creates also
      document a 409 that nobody has reproduced — both now surface the API's own words rather than
      guessing a cause, and there is a quirk (111 total) so the raw path is told too.
    - *In the default write mode the tool invited a call the server refuses.* `bankAccountNumber` is
      payment routing, so supplying it escalates `POST /api/creditors` to irreversible and it is rejected
      — while the description said "set it here if you know it" and the fallback advice pointed at
      `reai_update_creditor`, which is not even visible in that mode. Said plainly now, in the
      description and in the README row.
    - *Two README paragraphs became false when I edited the tables under them*: "All three read the
      record first and merge" over a two-row table, and "These are irreversible … the two reads are
      unaffected" over a ten-row one. Both fixed, and the risk-column guard now parses a slash-joined
      cell — it could not see a two-tool row at all, which is how the row this PR deleted had been
      invisible all along. Strengthening it immediately caught `irreversible + external send`.
    - The move is a breaking change for `REAI_TOOLSETS=purchase` and now has a `### Changed` entry saying
      so, the rethrow uses the house form rather than a `throw` smuggled into an IIFE, and
      `reai_update_debtor` declares `idempotent`.
  - Verified live through the curated tools only, on tenant 2783: a `company_loan_to_owner` recorded
    end to end (accounts 1370/8050 derived, `relatedParty` inferred), the duplicate-name warning fired,
    deleting the referenced debtor was refused with the ordering, deleting the loan then let it through,
    and a creditor rename kept its bank account. 0 debtors and 0 creditors left behind.

### Added

- **Share investments measured, before building anything for them — and the measuring cost a permanent
  record in a real company, which is the finding.** Two roadmap domains recorded as "module-disabled"
  turned out not to be: `GET /api/share-investments` and `GET /api/documents` both answer **200 with an
  empty list** on both test tenants. Only Projects is genuinely off (`403 "Project module is disabled"`,
  which also puts Timesheets out of reach since they need a `projectId`) along with accountant-clients
  (`403 "only available for accountant tenants"`). The `module-gating` quirk read as though share
  investments were gated outright; it now states the measurement and keeps the 403 guidance as the
  conditional it is.
- Five quirks from driving the domain on tenant 2783 (116 total), all of them undocumented:
  - **An EVENT posts to the ledger; the investment itself does not.** Voucher count 0 before and after
    creating a position, then a `DIVIDEND` of 1000 booked voucher `SH1-2026` with postings on 1920 and
    8071 — share investments have their own voucher series, and the event response carries its
    `voucherId`. There is no `DELETE` for an event: the document has `GET` and `POST` on that path and
    nothing else.
  - **An investment with any event can never be deleted** — `400 "Aksjeposten har registrerte
    transaksjoner og kan ikke slettes."` — and *an opening position is an event*. Review caught that this
    warning was attached to the `DELETE`, so a caller met it only when trying to remove the record, after
    the decision that made it permanent: the hazard is now a quirk on `POST /api/share-investments` with
    no `statuses`, since it is a success-path consequence, and the `400` explanation stays on the delete
    and points back at the create. That ordering is exactly how this repository learned the rule. Passing
    `openingQuantity`/`openingCostAmount`/`openingDate` to the create silently produces a `PURCHASE`
    event (measured: quantity 100, `pricePerUnit` derived as 500 from 50000/100), so a position created
    with an opening balance is permanent from birth, and nothing in the response says so. Clearing those
    fields afterwards does not remove the event: the PUT answered 200 and the event stayed.
  - **An event needs a settlement account, and says so only in Norwegian**:
    `400 "Velg verdipapirkontoen transaksjonen ble gjort opp mot."` is asking for `companyBankId`, which
    the document marks as required nowhere.
  - **`PUT` requires `instrumentType`** although the document says `required: [name]` — measured, 400
    with `fieldErrors[].field: "instrumentType"` — and it replaces: `ticker` went from `"ZZ"` to null by
    omission, while `quantity`, `costPrice` and `assetAccountNumber` survived because they are derived
    rather than settable. So checking one of those and concluding the record is intact would be wrong.
  - Also measured: `assetAccountNumber` is derived at creation as **1810**, the same derive-once pattern
    as the loan accounts.
- **One consequence to own.** Learning the deletion rule required creating a position, and the position
  is now unremovable on tenant 2783 — the API offers no way to delete its events. It is renamed
  `zz-UNREMOVABLE reai-mcp probe 2026-08-08 — safe to ignore` so anyone who meets it knows what it is.
  The ledger is neutral: the dividend voucher's own delete answered `{"outcome":"reversed"}`, which
  booked two offsetting postings, so the four postings net to zero — and that voucher now reads 200 by id
  while being absent from `GET /api/vouchers`, the same invisible-reversal shape this repository already
  records for expenses. Nothing else was left behind: 0 loans, 0 creditors, 0 debtors, 0 employees,
  0 expenses, 0 company banks, 0 vouchers listed.

### Added

- **Loans: five curated tools, and four constraints the spec does not state.** `/api/loans` had no
  curated coverage and was listed as blocked on "no data" — both test companies have zero loans. With
  a write tenant available the domain could be *measured* instead of guessed, which is the only way any
  of this was findable.
  - **`perspective` decides which table `counterpartyId` is read from.** The spec types it
    `integer/int32` and stops. Measured: `borrower` resolves it against **creditors** and answers
    `404 "Creditor with id=N not found"`, `lender` against **debtors** with `"Debtor with id=N not
    found"`. So flipping `perspective` silently changes what an unchanged id means — `reai_update_loan`
    refuses that edit unless a `counterpartyId` comes with it. The response then renames the field
    again, to `creditorId` or `debtorId`.
  - **`loanType` and `perspective` are constrained pairs**, and a wrong pair answers
    `400 "Lånetypen er ikke gyldig for valgt låneperspektiv"` — a Norwegian sentence about an
    undocumented rule. All twelve combinations measured: `bank_loan` and `owner_loan_to_company` are
    borrower-only, `company_loan_to_owner` and `company_loan_to_employee` lender-only, `intercompany`
    and `other` either. `reai_create_loan` refuses locally and says which direction the type means.
    Worth noting the counterparty is looked up *first*, so a bad id hides the pair error entirely —
    which is why an earlier probe of the same matrix read as all-valid and had to be redone.
  - **`reference` is unique per company**, also Norwegian-only:
    `400 "Lån med referanse X finnes allerede."` Translated, with a pointer at `reai_list_loans`.
  - **The ledger accounts are derived once and cleared by omission.** Leave them out at creation and
    the API wires up the standard Norwegian accounts from `loanType` and `perspective` — 2220/8150/2950
    for a borrower bank loan, 1370/8050/1760 for a company loan to the owner, and the full matrix is in
    the module doc. But `PUT` treats them like any other field: omitting
    `interestExpenseAccountNumber` and `accruedInterestAccountNumber` clears them, nothing re-derives
    them, and the loan is then self-contradictory with no response saying so.
    `principalAccountNumber` survives omission, so checking one field proves nothing about the others.
  - That last one was **first written up as a consequence of switching `interestTreatment` to
    `capitalize`**, because that is when it was first seen. Re-measuring with the treatment held
    constant corrected it: omission is the cause and the treatment is irrelevant — carrying the
    accounts through a `capitalize` switch keeps them. The wrong version had already reached the module
    doc, the README and `docs/tools.md` before the second measurement.
  - `relatedParty` is never inferred: it stayed `false` on a `company_loan_to_owner` with everything
    else set. `reai_create_loan` sets it for owner, employee and intercompany loans unless told
    otherwise, and says that it did.
  - Classified `irreversible`, matching the existing policy tier for `/api/loans`, even though the
    measurement points the other way — creating a loan posted **nothing** (voucher count 0 before and
    after) and `DELETE` answers 204 then 404. Not relaxed: the measurement came from a company with no
    loan history, says nothing about deleting a loan with repayments against it, and the record is the
    basis for postings rather than reference data. The two reads are unaffected.
  - **Six review findings, all accepted, two of them data-integrity bugs in the merge — which is
    exactly where the risk was said to be.**
    - *Reclassifying carried the old classification's accounts.* Accounts are derived at creation only,
      so moving a borrower loan from `bank_loan` to `owner_loan_to_company` kept 2220/8150 where the API
      would have derived 2255/8159 — a loan filed against the wrong balance-sheet line by an edit that
      reads like a relabelling. The merge cannot tell a derived number from a deliberate one, so the
      tool now refuses a reclassification that names no accounts, and quotes what the API would have
      derived for the new combination so the caller can accept or override.
    - *The same edit bypassed the `relatedParty` inference*, which ran only on create: changing a
      `bank_loan` to `intercompany` carried the stored `false` into the write and left note disclosure
      understating a related party — the exact harm the create-side inference exists to prevent,
      reachable by an edit instead of a creation.
    - *An idempotent restatement was refused.* `{ perspective: "borrower", … }` on a loan that was
      already borrower demanded a redundant `counterpartyId` for a table change that was not happening.
      Keyed on the value changing now, not on the field being present.
    - *`companyBankId` could not be cleared*, though `LoanReq` permits null and omission means "keep"
      under the merge — so a supported edit was unreachable. Now nullable.
    - *The local filter did not search `description`*, which both the tool description and the argument
      description promised it did.
    - *The update tool declared only its `PUT`*, not the `GET` it always performs first — understating
      what it touches, and excluding it from the merge-tool invariant that finds read-merge-write tools
      by exactly that pair.
    - Each of the four behavioural fixes is mutation-verified on its own.
  - **An independent review then found nine more, and one of its findings is that my own summary was
    overstated.** "All three write-ups are fixed" was wrong: there was a fourth copy of the corrected
    `interestTreatment` claim, in the create tool's own description — the string an agent actually
    reads. Deleted.
    - The **wrong-table 404 was passed through raw**, which is the failure this whole domain is about.
      A debtor id sent with `perspective: "borrower"` answered `404 "Creditor with id=78 not found"`
      from a POST, where a 404 reads as a missing endpoint rather than a misdirected id. Both write
      tools now name the id space they searched and which perspective would fit. The duplicate-reference
      translation was in `create` only, leaving the curated `PUT` **worse informed than `reai_request`**,
      whose quirk covers it — both now share one helper.
    - `counterpartyNote` **fabricated a perspective**: an absent value read as "borrower", so the tool
      asserted a classification for a record it could not classify. Three cases now, not two.
    - The README said *"Anything not listed — projects, timesheets, share investments, **loans** — is
      reachable through the escape hatch"* three sections below a Loans table, and the `REAI_TOOLSETS`
      block gained no `loans` row (nor `bank`, which was missing already — `test/docs.test.mjs` only
      checks rows that are present, so an omission is invisible to CI).
    - **Twelve behaviours survived deliberate mutation of `src/`** — the matrix and the merge were
      pinned, but nothing that only *speaks* to the caller was: the lender branch of
      `missingInterestAccounts` (no test drove a lender loan through either read tool), the `accrue`
      arm, the `capitalize` exemption, the list's whole INCONSISTENT note, both error translations, the
      no-op guard, three of the four inherently-related types, and the quirk scoping that PR #97 exists
      to protect. Ten new tests, each verified against the mutation it was written for.
    - Two quirks added (110 total) for hazards recorded only where the wrong reader would look: the
      `409` on deleting a creditor or debtor still referenced by a loan was documented in
      `reai_delete_loan`'s description, which nobody deleting a creditor will read, and the loan `DELETE`
      being a real delete had no quirk at all. The pair quirk now leads with its trigger, since it fires
      on any 400 from those paths and there are other 400s.
    - `companyBankId` was flagged as possibly unverified — the one settable field with no evidence a GET
      returns it, and this API has a habit of renaming fields in responses. Measured: it comes back
      under the same name, so the merge preserves it. The same read turned up `outstandingPrincipal` and
      `accruedInterestBalance`, which no endpoint here moves — so repayments happen in the ReAI UI, and
      the read tools now say so.
  - Two new quirks (108 total) so the escape hatch warns as well, and both hazards were verified live
    through the real tools: the direction rule and duplicate reference are refused before anything is
    sent, a partial edit keeps all nine untouched fields, and reaching the unwired state at all
    required `reai_request` with `clearOmittedFields: true` — the ordinary path is refused by the
    omission gate, which named all ten omitted fields.

**167 tools**: 160 across thirteen accounting domains, plus 7 always-on.
### Fixed

- **A whole domain was almost unnameable, and one of its commonest words pointed at the wrong thing.**
  `/api/loans` answered to `lån` and `loan` and to very little else. Measured before this: `gjeld`,
  `avdrag`, `nedbetaling`, `hovedstol`, `aksjonærlån` and `borrowing` returned **nothing at all**, and
  `banklån` and `ansattlån` — ordinary Norwegian compounds — ranked company-banks and the employee
  ledger instead. Tools do not help with a domain nobody can name.
  - **`renter` was actively wrong rather than missing.** It is Norwegian for *interest*, and it ranked
    `/api/agreements/rent-agreement` **first**: the `-er` rule strips it to `rent`, which matches that
    path segment. Norwegian for rent is `leie`, so the collision is with English — the same shape as
    the `levere` (file a return) and `aktiver` (assets) homographs already recorded in this table, and
    fixed the same way, with an explicit entry that beats a derived stem. A user asking about the
    interest on a loan was being sent to rent agreements.
  - **The counterparty ledgers answered only to English.** `creditor` found `/api/creditors` while
    `kreditor` found nothing, and `debitor` ranked a supplier-invoice cost-line above `/api/debtors` —
    for endpoints named, in Norwegian, exactly those words. They matter because a loan's counterparty
    is a creditor or a debtor depending on its perspective, so they are the next call a caller makes.
  - 22 keys added, 176 → 198. All ten loan terms and all four ledger terms now rank their endpoint in
    the top 3, every held-out corpus holds its floor, and there is a test asserting the fix did not
    trade one confident wrong answer for another: `husleie`, `leiekontrakt` and `leieavtalen` still
    reach the agreements, and `renter` no longer reaches the rent agreement at all.
  - `banklån` is deliberately mapped to the loan terms only. Carrying `bank` as well ranked
    `/api/loans` fifth, behind the company-bank family, because the extra term pulls a whole domain up
    — a compound names one thing.
  - **The first version of this was too strong, and review measured how.** Every entry carried three or
    four tokens, so a broad word drowned the specific resource a query named: `gjeld til leverandør`
    pushed the supplier ledger from first to **fourth**, `nedbetaling av faktura` and `avdrag på faktura`
    moved off the invoice payments, `motpart på banktransaksjon` filled all four top places with
    creditors and debtors, and the English `renter agreement` — a person who rents — lost the rent
    agreement. That is a worse failure than the word missing, because the caller named the thing they
    wanted. Every entry carries one or two tokens now.
  - `nedbetaling` and `motpart` are **dropped rather than weakened**: they are genuinely ambiguous, and
    picking a side is the bug. An invoice is paid down too, and `nedbetaling` reaching the invoice
    payments is the better default; a counterparty belongs to anything, not only a loan.
  - One case is left imperfect and stated rather than hidden: `avdrag på faktura` ranks the invoice
    payments third, behind the invoice list and its e-invoice status. Accepted because `avdrag` is
    specifically a loan principal instalment in Norwegian accounting — an invoice is paid in
    `delbetaling` — so the phrase is unusual and the term is worth keeping. The fix, if it is ever
    needed, is a narrower-scope mechanism rather than a heavier synonym.
  - Mutation-verified: removing the new entries fails all three new tests.

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

- **The full-write suite was leaving records in a real company on every run, because its cleanup only
  worked on the happy path.** Found by running it against tenant 2783: nine failures, which looked
  like leftover contamination from an interrupted run — an employee, an expense and a voucher that
  "were not created by this run". They were not contamination. Re-running with the tenant emptied
  reproduced all nine with **fresh** ids, so the suite was creating the mess it then failed on, one
  set per run. Four such records were removed by hand; the run that found them created a fifth.
  - The root cause is **upstream and new**: `DELETE /api/expenses/{id}/voucher` now answers 409
    `application/problem+json` whose detail is a raw Java type —
    `org.hibernate.TransientPropertyValueException: Persistent instance of 'no.reai.ex.mdl.Expense'
    references an unsaved transient instance of 'no.reai.ldgr.mdl.Voucher'`. A persistence bug on
    ReAI's side, not a validation error, so no body fixes it. It worked when the tool was written —
    the description records the measured `{"outcome":"deleted"}`.
  - Because unbooking is impossible, everything downstream is blocked with it: unapprove refuses a
    booked expense, reverse will not take it, and `DELETE /api/expenses/{id}` answers the same 409.
    An expense booked today cannot be unwound through its own endpoints at all.
  - **The one route that works cascades, and that is why the tool will not take it.**
    `DELETE /api/vouchers/{voucherId}` answers `{"outcome":"deleted"}` — and destroys the expense as
    well (measured twice: expense 2241 answered 404 immediately after voucher 30980, and 2242 after
    30984). Silently turning "unlink the voucher, keep the expense" into "delete both" would destroy
    the record the caller asked to preserve, so the tool catches the 409 by name, explains that the
    defect is upstream, names the route and states its cost — and leaves the decision with the caller.
    Caught by name because the API's own message is a Java stack type: a caller cannot tell a ReAI bug
    from a body it got wrong, and will keep trying variations.
  - The suite now recognises that 409 as a known upstream defect instead of nine cascading failures,
    and its cleanup checks whether the expense is still booked **first**, then removes it through the
    cascade. The claim that this was "asserted positively, so it fails when ReAI fixes it" was **false
    as first written** — Codex caught that a successful unlink simply fell through to the normal checks
    and nothing said the special case had gone stale. Recovery is now itself a failing check, naming
    the three places that have to be deleted together. Failing on good news looks odd and is the only
    thing that would ever say so. Verified live: every check passes and tenant 2783 is left with 0 employees and 0 expenses,
    where the same run previously left one of each plus a voucher.
  - New quirk, `expense-voucher-unlink-is-broken-upstream`, so `reai_describe_endpoint` says all of
    this before an agent tries it. 106 quirks. Three corrections to it came from review, all fair:
    it is registered for `DELETE /api/expenses/{id}` as well, because the same 409 comes from there and
    that is the operation `reai_reverse_expense` actually sends; it is scoped `statuses: [409]`, since
    an unscoped note would answer a 401, 403 or a genuinely wrong id with authoritative text saying the
    problem is a Hibernate bug nothing can fix; and it cited `POST /api/expenses/{id}/reverse`, **which
    does not exist** — the reversal is the DELETE. That last one is precisely the error the new
    `test/tool-names.test.mjs` guard was written for, one level down: the guard checks tool names, not
    endpoint paths in prose.
  - Cleanup no longer asks the API what it needs to clean up. The voucher id is remembered at booking
    time, because an errored or timed-out read made it `undefined`, which read as "not booked", which
    sent cleanup down the path that cannot work — leaving the expense, the voucher and the employee
    behind exactly when the API is having a bad minute. And the cascade is now *proved* rather than
    assumed: `reai_delete_voucher` succeeds on `"deleted"`, on `"reversed"` and on an unrecognised
    outcome, so the outcome is asserted and the expense is then read back to confirm it is gone.

- **Two test comments overstated the case for discovery by 47%.** Both said "the ~250 uncovered
  operations"; the real figure is **170** — 321 public operations minus the 151 distinct
  `(method, path)` pairs curated tools declare. An inflated number in the comments that explain why
  discovery matters is the one place it flatters the work it justifies. Corrected, and now *computed*:
  a test derives it from the spec index and the registry, as a band rather than an equality, because
  adding curated tools should move it down and that is progress rather than a failure.
- **The risk-column assertion was one file move from being vacuous.** It read `README.md` alone, and
  its loop skips a tool that is not named — so relocating the tool tables into `docs/` would have left
  it green while checking nothing, the same trap found in three sibling assertions earlier. It now
  searches the whole documentation corpus and counts the rows it checked (34 today), so emptiness
  fails instead of passing quietly. Mutation-verified: removing the README from the corpus it searches
  reports *"only 0 documented rows named an irreversible tool"* rather than passing.
- **A length guard excluded the shortest real stem, and the definite plural of every consonant stem
  was missing.** Codex found the first on #88 and it was still open: the definite-form rules read
  `base.length > 5`, and `lån` (loan) folds to `lan`, so `lånet` folds to `lanet` — five characters,
  one short. Measured before the fix: `lån` ranked `GET /api/loans` first, `lånet` returned **nothing
  at all**, and `saldo på lånet` returned company-banks, departments and salary-payments, so it lost
  the loan endpoint rather than merely reordering it.
  - The single guard is replaced by a **per-suffix floor**, not lowered: three characters of stem for
    `-et`/`-en`/`-ne`/`-ene` and four for the one-character `-n` (see the Codex finding below for why
    that one is different). The gate — the remaining stem must be a synonym key — is still the real
    protection, and since no key is shorter than three characters (`vat`, `mva`, `owe`, `ehf`, `lan`),
    the floor can never be what blocks a legitimate stem. Two earlier versions of the comment above
    these rules got this wrong in opposite directions: one claimed the length kept a short word like
    `lan` safe, which was unreachable, and the next claimed removing the guards changed nothing, which
    was wrong in exactly the way Codex found.
  - Fixing the singular made the sibling gap obvious: **`-ene`, the plural definite of a consonant
    stem, had no rule at all.** `utgiften` resolved while `utgiftene` returned nothing. The -e nouns
    were already covered because their stem keeps its own -e (`kunde` → `kundene`), which is exactly
    why this survived — the class looked handled. Measured before: `lånene`, `utgiftene`,
    `dokumentene`, `kontoene`, `vedleggene` and `produktene` all returned nothing; all six now resolve.
  - **Removing the guards went one step too far, and Codex caught that too, on this PR.** A single -n
    strips one character, so it turns every four-letter word into a three-letter one — and three-letter
    keys are precisely what this change reaches for. `vatn` (Nynorsk for water) stemmed to the known
    key `vat` and returned the VAT endpoints; `owen` stemmed to `owe`, so *"faktura til owen"* — an
    invoice to a person — ranked the customer **ledger** above `/api/invoices`. The floor is now per
    suffix: four for `-n`, three for the rest. Not a fudge — every real Norwegian `-n` definite has an
    `-e` stem, so adding `-n` to each three-letter key gives `vatn`, `mvan`, `owen`, `ehfn`, `lann`,
    none of which is a definite form of it.
  - Three mutations verified separately: restoring the length guard fails only the three-letter-stem
    test, removing `-ene` fails that one and the plural test, and dropping the gate fails the
    pre-existing gate test plus both third-corpus score floors — which is also the evidence that the
    corpus floors do real work.
  - A fourth test was drafted for the gate and **deleted rather than kept**: the existing
    "a suffix rule only fires on a stem the table knows" already covers it and more strictly, and
    dropping the gate did not fail the draft. A test that survives the mutation it was written for is
    not coverage.
- **The tenant boundary asked the OpenAPI spec for permission to check.** A connection bound to one
  company at authorization time must not address another, and `reai_request` can name a tenant in
  four places: the header, the path, the query and the body. The gate read the spec to find where a
  tenant *was declared*, which left three holes, each reachable:
  - **An unresolvable path checked nothing at all** — `if (!op) return []`. Unknown paths are
    deliberately permitted here (the API decodes and normalises before routing, so refusing what
    this server cannot resolve would refuse legitimate calls), which made the one gate that must not
    depend on resolution the only one that did.
  - **An undeclared query parameter was invisible even on a resolved path.** `GET /api/vouchers`
    declares `startDate`, `endDate`, `voucherType`, `registeredBy`, `includeReversed` — and no
    tenant parameter, so `?tenantId=<other>` was not looked at. The spec declares what the API
    documents, not what it reads.
  - **The body was never read**, so `POST /api/x {"tenantId": <other>}` passed the boundary.
  - Now the path segments, every query key and the whole body (at depth, through arrays, and
    through a `tenant` object's own `id`) are scanned regardless of what the spec says. Each hole
    mutation-tested separately: restoring the give-up-on-unresolved line, removing the query scan
    and removing the body walk each fail their own test and nothing else.
  - **None of the three currently reaches another company's books.** Measured against the live API
    on 2026-08-08 with a read-only probe on tenant 2634 and a nonexistent tenant id: `tenantId`,
    `tenant_id`, `tenant` and `companyId` in the query are all ignored, a body tenant id is ignored,
    and a duplicate `X-Tenant-Id` does not displace the first — 57 vouchers returned in every case.
    That is upstream behaviour nobody here controls or is told about when it changes, and this gate
    is the promise the consent page makes to a user, so it fails closed on the request rather than
    trusting ReAI to keep ignoring it.
  - **The key vocabulary is narrow, and the narrowness is measured rather than guessed.** A plain
    `/tenant/i` over the spec's own field names matches `tenantNoticeMonths` (a small integer — a
    rental agreement with three months' notice would have read as "tenant 3"), `tenantPhone` (eight
    digits), `enkOwnerPersonIdentifierOnTenant` (eleven) and `tenantBirthDate`, so it would have
    refused ordinary writes. `companyId` is excluded for a stronger reason: it is a different id
    space — `Tenant` itself has a `companyId`, and `CustomerRes`, `SupplierRes` and
    `SubscriptionServiceRecipientRes` each carry one for a counterparty. A boundary that fires on
    innocent bodies gets switched off. There is a test asserting a body carrying all six of those
    fields goes through.
  - **Four ways through it survived the first version, all found by Codex on the PR and each
    demonstrated end to end — the request reached the client — before being fixed.** The unifying
    mistake was reading the request the way JavaScript reads it rather than the way the upstream Java
    does:
    - `{ tenantId: [5002] }`. The query schema permits arrays and `ReaiClient.buildUrl` comma-joins
      them, so a single-element array is transmitted as exactly `tenantId=5002` while the scan saw an
      array and ignored it. Arrays are walked now, at any nesting, in query and body alike.
    - `"+5002"` and `" 5002 "`. `Integer.parseInt` accepts a leading `+` and a container trims, so
      both address the same company while failing `/^\d+$/`.
    - `"٥٠٠٢"` — Arabic-Indic digits, which `parseInt` also accepts. Rather than reimplement Java's
      numeric parsing and get it subtly wrong, an all-decimal-digit string that is not ASCII is kept
      as its raw text: it can never equal the bound tenant, so it is always refused. Failing closed on
      a spelling nobody legitimate uses costs nothing.
    - A body nested **deeper than eight levels**, and a path in a router-normalised form such as
      `/api/accountant-clients;v=1/5002`. The depth ceiling was a bypass rather than a safeguard — an
      instruction to add one more wrapper — so it is gone, and the traversal is an explicit stack so
      that removing it cannot trade a bypass for a stack overflow. The path scan now runs over every
      `routedPathForms` variant, which the rest of the handler already reasoned about; a matrix
      parameter is the percent-encoding trick in a different alphabet.
    - Each fix mutation-tested on its own, and there is a mirror test asserting the spelling rules do
      not refuse `-5002`, `0`, `"not-a-number"`, or the bound tenant echoed back in any spelling.
  - Not keyed on risk, which is unchanged but now asserted: a *read* across the boundary is the
    disclosure the boundary exists to prevent.
  - Also deleted a doc comment the code it described had left behind, above `tenantIdsInRequest`.

- **A gitlink nearly reached main, the same way the `node_modules` symlink did.** An agent working in
  its own git worktree under `.claude/worktrees/` was staged by `git add -A` as mode 160000 — a
  submodule pointing at a commit that exists in no remote, so a clone cannot initialise it and CI
  does not care. Caught before merge this time, by the tracked-file audit written after the symlink.
  `.gitignore` now covers the path, and there is a guard on the mode: this repository has no
  submodules, so any gitlink is an accident, and the test also asserts the `.gitignore` rule still
  exists rather than waiting for the next `git add -A` to find out.
- **A tool description told agents, twice, to use a tool that does not exist.**
  `reai_get_bank_reconciliation` said that for a `providerType: 'manual'` account this endpoint is
  not the working view and to *"use `reai_list_bank_transactions` instead"* — once in the
  description, once in the runtime note it attaches to a suspicious reading. There is no
  `reai_list_bank_transactions` and there never was. This is a worse failure than an undocumented
  quirk: an agent that follows the instruction gets "unknown tool" and cannot tell whether the tool
  was removed, hidden by the operator's toolset selection, or imaginary — so it has no next move,
  where a missing sentence would at least have left it exploring. Both now point at what actually
  works for a manual account, `reai_request` on `/api/manual-reconciliations/{bankAccountId}`, which
  is what `reai_get_bank_reconciliation`'s own description and the
  `manual-reconciliation-404-means-not-manual-not-missing` quirk already said, and the runtime note
  names `reai_list_company_banks` as the way to check `providerType` in the first place.
  - Guarded generally, because a name is exactly the kind of error review does not catch — it reads
    like an ordinary instruction. `test/tool-names.test.mjs` requires every `reai_`-prefixed token
    in **all** of `src/` and in README plus `docs/` to be a registered tool. Not a list of surfaces
    to keep extending: one regex over the source, so descriptions, titles, quirk notes, the
    connect-time instructions and error strings are covered by construction. A census at the time
    found this was the only one, across 146 tools, 105 quirk notes and seven documentation pages.
    Mutation-verified by putting the dead name back, and the file carries a third test that fails if
    the scan itself stops seeing anything.
  - Also in `ui.ts`: its module doc reasoned about "another surface to keep in step with 63 tools".
    That was true when written and is now under half the real number. Rewritten to make the point
    without a count, since a number in a comment that nothing checks is a fact with an expiry date.

- **The most consequential decision in remote mode had nothing testing it.** A grant is sealed at
  authorization time — unforgeable, but minted then and refreshable for weeks — while the operator's
  `REAI_WRITE_MODE` is whatever the deployment runs now. `src/http.ts` takes the **narrower** of the
  two on every request, which is right in both directions: an operator who redeploys tighter has it
  apply immediately to tokens that already exist, and a user who narrowed their own grant on the
  consent page is never widened back by a permissive server. Nothing asserted any of it.
  - The helper was module-private in `src/http.ts`, a file that exports nothing and is spawned as a
    process, so reaching it meant starting a real server. It now lives in `policy.ts` as
    `narrowerWriteMode`, beside `strictestRisk`, which is the same idea for risks.
  - Two guards end to end through `/mcp`, both mutation-tested against the same mutation — dropping
    the re-clamp at the call site, which is the mutation an ordinary refactor could make and which
    leaves every arithmetic test green. A grant claiming `full` against a `read-only` server is
    served *no writing tool* (discovery), and its `reai_request` write is *refused and never reaches
    the API* (enforcement). The second matters because `reai_request` is visible at `read-only` by
    design, so hiding tools was never the whole boundary.
  - The listing guard originally filtered names by a verb regex. That is a vocabulary and it had
    already drifted: it misses `reai_deliver_expense`, `reai_unapprove_expense`, the three
    subscription tools and `reai_reconcile_ui`. It now also pins the served list to the exact
    read-only set, and asserts `full` is genuinely larger so the comparison cannot pass vacuously.
  - The arithmetic is asserted in both directions and symmetrically, and now fails closed: `indexOf`
    answers -1 for a mode outside the vocabulary, which would rank an unrecognised value as the
    *narrowest* and return it — so a stray `undefined` would reach `isAllowed` and 500 the request.
    Unreachable today, spelled out because this is exported policy now. A third test composes the
    ceiling with the visibility pipeline; it is labelled in the file as documenting a seam rather
    than guarding it, because no mutation was found that it alone catches.
  - **One claim this made about the refresh path was wrong, and the suite was what made it look
    right.** Three of four held on inspection: a refresh cannot widen a narrowed grant (it reissues
    the sealed grant unchanged), an untenanted grant cannot be refreshed at all, and the chain is
    bounded by an absolute TTL — from the original authorization for any grant carrying `authTime`,
    though for a *legacy* grant the fallback is the redeemed token's own `iat`, so a chain already
    rolled forward under the old code is bounded from its last refresh instead: a one-time extension
    of up to the TTL. The fourth was false. The check read `if (clientId && clientId !== …)`, so
    **omitting `client_id` skipped it entirely** and a refresh token could be redeemed as any client
    — the identical shape the `authorization_code` branch twenty lines above was fixed for, with a
    comment there saying why. `client_id` is not a secret for a public client, and every client here
    is public, so whoever holds the refresh token already holds the grant; this is conformance
    (RFC 6749 §6, and `client_id` is REQUIRED on a public-client token request) and a blast-radius
    boundary between registered clients, not a credential check. It now requires the parameter and
    compares it. The test asserting the absent case returned **200** was the reason this read as
    intended behaviour; it now asserts absent, empty and mismatched are all refused.

- **Three documentation assertions pinned the docs architecture to one file.** They exist to
  guarantee that something is *documented* — that all 146 tools are listed where a reader will
  find them, that the enforced transport limits are written down, that the payment-routing table
  matches the classifier. Reading only `README.md` quietly made them assertions about layout as
  well: when the README was split into a front door plus `docs/`, those three sections could not
  move and had to stay on the front page. They now search the README **and** every page under
  `docs/`, from an explicit file list with a test that the list matches what is on disk — so a
  renamed page fails loudly instead of silently shrinking the haystack.

- **The visibility pipeline had no unit test at all.** Four filters decide which tools an agent can
  even see — the toolset selection, the opt-in UI surface, the write ceiling, the external-send
  switch — and they were inline in `buildServer`, exercised only by the live smoke suites, one
  configuration each and needing a real token. Extracted as `visibleTools(config)` with the same
  four steps in the same order, and tested as a matrix: read-only exposes no writer, the default
  mode exposes nothing irreversible, and a transmitting tool stays hidden in `full` mode until
  external send is switched on — asserted in both directions, so the switch is proven to do
  something rather than merely to be consulted. Each of the three filters is mutation-tested
  individually.
  - This came from the README pass noticing that `registeredTools` is 146 while `allTools` is 145
    and reading it as a possible defect. It is not — that list is deliberately every tool the
    server can ever register — but the gate that makes it harmless had nothing asserting it.

- **Two more fixtures were pinning wrong answers**, both caught by Codex on the follow-up and both
  the same class as the review finding above:
  - *"Hva står i leieavtalen"* — what does the lease say — was asserted against
    `POST /api/agreements/rent-agreement`, which **creates** one. Rephrasing the question had not
    been enough: the target was still a mutating endpoint, so a read question stayed pinned to a
    write. It asserts `GET /api/agreements/{id}` now, which the ranker reaches at the same rank for
    both grammatical forms.
  - *"Last opp dokumentet"* was asserted against `GET /api/documents` when *"last opp"* is
    explicitly an upload and the spec's `POST /api/documents` is summarised "Upload one or more
    documents". The fixture was locking in the wrong method.

- **Intent can now come from a phrase, not only from a word.** *"Last opp"* is upload and *"last
  ned"* is download — opposite methods sharing a verb that means neither alone, and `last` is also
  the noun for a load and an English word. So neither the method table nor the write-intent set could
  hold it: the direction is in the particle and only the pair says anything. A new `PHRASE_INTENT`
  table matches the raw query text, the same reasoning `PHRASE_SYNONYMS` already uses for *"skylder
  oss"* versus *"skylder vi"*. `POST /api/documents` moves from rank 7 to rank 1 for both
  grammatical forms, while *"last ned"* keeps a `GET` first.
  - Asserted on the **first result**, which is what the mechanism promises: implied methods bias the
    ranking, they do not filter by method. A first version demanded zero writes in the top five and
    failed on *"last ned rapporten"*, where a `POST` sits at rank four behind three `GET`s — the
    intent was respected and the assertion was describing something the rule does not do.

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
