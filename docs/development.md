# Development

```bash
npm install
npm run build        # rebuild the spec index, then compile
npm test             # build + unit tests (no credentials needed)
npm run typecheck
npm run smoke        # read-only, end-to-end against the live API (needs a token)
```

The suite covers the write-policy classifier, the discovery ranker, spec search/describe, the OAuth
server and every curated tool's request shaping. `npm test` prints the count on the last line; it moves
with almost every PR, which is why no figure is written down here. None of it needs network access or
credentials: the ReAI client is faked, and the OpenAPI snapshot in `spec/` is the fixture.

## Adding a curated tool

1. Add a `defineTool({...})` in the relevant `src/tools/*.ts`, declaring its `risk`.
2. Export it from that module's array.
3. Add that array to the right `TOOL_GROUPS` entry in `src/server.ts` if you created a new module.
   `allTools` is derived from `TOOL_GROUPS` plus the always-on tools, so the group is what you edit —
   and the group is also what `REAI_TOOLSETS` selects on.

Declaring `risk` correctly is the part that matters — it is what gates the tool behind
`REAI_WRITE_MODE`. `test/docs.test.mjs` then requires the tool to be named somewhere in the README or
a page under `docs/`, and separately requires that no README table row mentioning it contradicts the
code's `risk` — so an undocumented or mis-labelled tool fails the build.

## How the API surface is kept current

`spec/reai-openapi.json` is a pinned snapshot of <https://app.reai.no/openapi>. `npm run build:spec` compresses it into a 199 KB searchable index (from 907 KB), keeping only what is needed to *find* an operation; full schemas are resolved from the snapshot on demand. Refresh it with:

```bash
curl -H 'Accept: application/json' https://app.reai.no/openapi -o spec/reai-openapi.json
npm run build
```

## Running CI's checks locally

```bash
./scripts/ci-local.sh          # the working tree
./scripts/ci-local.sh main     # a specific ref
```

This runs everything `.github/workflows/ci.yml` runs — typecheck, build, the unit tests, and the published-package check — against every Node version in the matrix, and exits non-zero if any of it would fail.

It was written during a multi-hour GitHub Actions outage, when no workflow could start at all: "wait for a green tick" stops being a quality gate while the service producing the tick is down. It is **not** a substitute for CI, because it cannot reproduce the clean-room `npm ci` on Linux, and it says so on every run. If a Node version in the matrix is not installed locally it warns and tells you not to treat the result as equivalent.

## Live harnesses

These run against the real API, and all of them assert the **negatives** as well as the happy path:

```bash
# Read-only. Safe against production books.
REAI_USER_API_TOKEN=... node scripts/smoke.mjs --tenant 1234

# The whole OAuth flow against a deployment.
REAI_USER_API_TOKEN=... node scripts/smoke-http.mjs --url https://…

# WRITES. Reversible master data only.
REAI_WRITE_TEST_TENANTS=1234 REAI_USER_API_TOKEN=... \
  node scripts/smoke-write.mjs --tenant 1234

# WRITES TO THE GENERAL LEDGER. Posts and deletes a real voucher.
REAI_WRITE_TEST_TENANTS=1234 REAI_USER_API_TOKEN=... \
  node scripts/smoke-full-write.mjs --tenant 1234 --i-understand-this-posts-to-real-books

# Does the API still say what we claim it says? Every case is designed to FAIL.
REAI_WRITE_TEST_TENANTS=1234 REAI_USER_API_TOKEN=... \
  node scripts/audit-messages.mjs --tenant 1234

# Does it still STORE what we claim it stores? Creates records, deletes them.
REAI_WRITE_TEST_TENANTS=2783 REAI_USER_API_TOKEN=... \
  node scripts/audit-storage.mjs --tenant 2783

# Are the QUIRKS still true? Read-only, so this one is safe against any tenant.
REAI_USER_API_TOKEN=... node scripts/audit-quirks.mjs --tenant 2634

# How many storage claims exist, and how many are probed?
npm run audit:census
```

### Why `audit-messages.mjs` exists, and what it does not cover

Nineteen places in `src/` turn a ReAI error into something an agent can act on by reading its **text** —
a Norwegian validation message becomes an explanation and a next step. Each is a silent dependency on
upstream wording: rephrase the message and the match stops firing, the agent gets raw Norwegian, and
nothing fails, because the unit tests stub the error and keep passing against a string the API no
longer produces. This repository shipped exactly that once, a quirk quoting `"…kan skrives uten +"`
against a live `"…kan skrives uten +47."`.

Every case is a request built to be **refused**, which is what makes it safe against a real tenant: a
rejected write creates nothing. Three cases need a customer to exist; they create one, record it in
`created`, and delete it in a `finally` — the idiom `test/smoke-cleanup.test.mjs` checks, which the
script is now listed in. **A cleanup that cannot confirm deletion fails the run**, because
`DELETE /api/customers/{id}` can legitimately answer `{"outcome":"archived"}`, and an archived customer
is invisible to the default list.

It carries the same `REAI_WRITE_TEST_TENANTS` guard as the write scripts, because a probe wrong in the
*other* direction would write for real. That is not hypothetical: the first version of this script
shipped two probes that this repo's own `classifyRequest` calls **irreversible** — a
`DELETE /api/share-investments/{first row}` with no check that the position had transactions, and a
`POST /api/general-sub-accounts`, which was also the wrong endpoint (the string is caught from a
read-only GET). Both are gone; the share-investment string is an exemption with the reason.

Three outcomes, and the third is what makes it trustworthy:

| outcome | meaning |
|---|---|
| `OK` | the shipped pattern matches, **in the same text the shipped code reads** |
| `DRIFT` | the rule was reached and the wording *or the status* changed — act on this |
| `INCONCLUSIVE` | the request never reached the rule, so the code is not the problem |

Each case declares which haystack it compares against, because `err.message` is `detail || title ||
rawBody` and never includes `fieldErrors`, while the `sales.ts` translations deliberately search the
raw body. An audit with a wider haystack than production's reports `OK` for a match the shipped code
would miss. Each case also declares the status it expects: six sites gate on the status as well as the
text, so a 404 becoming a 400 kills a translation that a text-only check calls fine.

`INCONCLUSIVE` earned its place three times over. Writing this, probes reported drift because the
voucher body was missing `postings[].postingDate`, then `postings[].currency`, then because the loan
body was missing `currency` and `interestRateAnnual` — every time, the API was complaining about the
*request* and never evaluated the rule. So a shape error names the probe as the thing to fix and says
`Do NOT touch` the source file. Both shapes of shape-error are recognised: `Validation failed` with
`fieldErrors`, **and** `{"detail":"Failed to read request"}` with none, which is what a bad date or a
non-numeric amount returns.

**What it cannot catch.** Every case is a refusal, so nothing here observes what the API *accepts,
normalises or stores*. Two of the five false claims that motivated the script are therefore still out
of reach: `skipRegistryLookup` drifts on a `201`, and the phone rule is a storage claim (default region
NO, canonicalised to E.164, a Norway-valid bare number stored under `+47`). Also uncovered: which of two
ambiguous causes produced a message, anything in a 2xx body, and the ten exemptions.

`test/message-drift.test.mjs` keeps the audit complete in the other direction. It fails if a
text-reading dependency is added to `src/` without a probe, or if an exemption names something that no
longer exists. It covers four shapes — `/re/.test`, `/re/.exec`, `.includes`/`.startsWith`/`.endsWith`
on any receiver, and `case "…":` — because the first version saw only the first and was demonstrably
blind to the rest, including `loans.ts`'s wrong-table diagnosis, which needed no test data at all.

### `audit-storage.mjs`: the half the message audit cannot reach

`audit-messages.mjs` checks the wording of **refusals**, and says so plainly: every case there is a
request built to fail, so nothing observes what the API *accepts, normalises or stores*. Two of the five
false claims that motivated it live in that gap — `skipRegistryLookup` drifts on a `201`, and the phone
rule was wrong three times about what gets **stored**.

So this one writes. That difference dictates the design: only customers, which delete cleanly and which
`classifyRequest` calls reversible; everything recorded in `created` and removed in a `finally`; a record
that cannot be confirmed deleted **fails the run**; and the token's reachable tenants verified before
anything is written, since a single-tenant token ignores `X-Tenant-Id`. A test asserts it never writes to
`/api/vouchers`, `/api/share-investments` or `/api/general-sub-accounts` — the three paths the message
audit had to have removed from it.

**Every case reads the record back**, and that is not caution for its own sake — three of the first eight
compared the POST echo, in the very family whose constant ends "read the created record back whenever the
name or address matters". A
create can echo a field it silently dropped. `phone` is not a create field — `reai_create_customer` says
so — and the first version of these probes sent it to `POST /api/customers` and reported **four DRIFTs
against `PHONE_RULE`, all `stored null`**, when the value had never been written at all. The phone claims
go through `PATCH` now, and a test pins that.

Each case names the **constant** that makes its claim, a marker phrase from it, and — the part a marker
cannot do — the **value that text predicts**. A phrase survives a rewrite that reverses its meaning: the
review of PR #115 replaced `PHONE_RULE` with text saying the *opposite* of every phone claim while keeping
all four markers, and the guard passed 4/4. So each probe pins the literal too, and markers
must be at least twelve characters (`marker: "e"` passed the first version).

**What that guard cannot do, stated plainly because two rounds of prose here overclaimed it.** The check
is `text.includes(...)`, which is blind to direction: the review of PR #116 rewrote both constants to
assert the *opposite* of all seventeen claims while retaining every marker and every predicted literal,
and the test passed 6/6. A unit test reading prose for meaning would be pretending. So the honest job of
this guard is narrow — stop a probe outliving the sentence it verifies — and **the live audit is the only
authority on whether a claim is true.** That is why `INCONCLUSIVE` now exits non-zero: a claim nobody
checked is not a claim that held.

**On completeness, the first version was a cop-out.** It said the population "cannot be measured
mechanically" because a storage claim is prose. It can be measured, roughly: the claims live in exactly
two places — `description:`/`.describe()` in `src/tools/*.ts` and `note:` in `src/reai/quirks.ts` — and
`npm run audit:census` counts them. Today: **160 distinct agent-facing literals assert something about what is
stored; 17 probes cover them, binding to 6 distinct source texts — different units, so not a percentage.** That ratio is printed rather than asserted, because a keyword sweep over prose is
a lower bound and pinning it would be false precision — but hiding it made 11-of-many look like coverage.
The cheap unprobed ones are named in the header of `test/storage-drift.test.mjs`, including the flagship
claim of `reai_create_customer` ("the name you send is then DISCARDED") on the **default**, no-flag path.

Latest run: **17 of 17 claims verified**, including that the `skipRegistryLookup` override is a stale
internal directory rather than Brønnøysundregistrene — and that one asks the registry live rather than
hardcoding a name, because a hardcoded string would report OK if Brreg ever converged on it, and DRIFT if
ReAI merely *updated* its directory, which would confirm the account rather than refute it.

### `audit-quirks.mjs`: the 122 claims nobody was checking

The other two audits check `src/tools/*.ts`. **Quirks** are the third channel, and the largest: 122 of
them, reaching agents through `reai_describe_endpoint` and `reai_api_notes`. Before this script, the two
audits named **2 of them** — `tenant-header-ignored-single-tenant` and `customer-name-title-cased`. Both
defects that motivated those audits were in this channel: the `+47` phone claim (PR #115) and the four
places calling the agreement enums undocumented (PR #123).

Resist quoting how many of the remaining 120 are "checkable": a keyword sweep over `note` prose gives 86 or
95 depending on the word list, so it is a lower bound dressed as a measurement — the false precision
`audit:census` exists to print rather than assert. 122 total, 2 named before, 8 now, 114 unnamed are the
figures that can be checked.

This covers the **8 that a GET can answer**, and the report prints `of 122` so a pass is not read as
coverage. Everything here is a read, which is what makes it safe against tenant 2634's real books — there
is no write guard and no `REAI_WRITE_TEST_TENANTS`.

**How that is enforced, after a first version claimed something false.** The original text said the property
was asserted "against `classifyRequest` rather than by grepping for method names". It was the reverse:
`classifyRequest("GET", …)` returns `read` for every path by an early return, so the assertion could not
fail, and the only live checks were greps — which review defeated in one line by keeping `method: "GET"` and
adding `...EXTRA` after it, making the audit issue real POSTs to `/api/vouchers` and `/api/opening-balances`
with every test green. Now the request helper builds its `init` object, **checks it at runtime** and throws
on any non-GET, so a source edit fails before the socket opens; the test additionally requires the literal
method and forbids a top-level spread, and uses `classifyRequest` for what it can honestly show — that
these paths are `irreversible` under a write verb, which is why the runtime guard is there at all.

**Probe the request the note describes, not a shorter one.** This is the lesson worth carrying to the next
audit, because it produced a false DRIFT against a correct quirk while this script was being written.
`timesheets-need-project-module` predicts 400 `"projectId cannot be used when the Project module is
disabled"`. Sending `GET /api/timesheets?projectId=1` returns 400 `"startDate is required"` — validation is
**ordered**, so an under-specified request trips the first validator and never reaches the layer the claim
is about. The probe now sends the full valid request and a test pins that it does. Generalised: a probe
that sends less than a valid request measures a different claim than the one it reports on.

**Probe every path the quirk is SERVED for.** The same failure by another route, and this file had it
twice. A quirk carries a `paths` list and `quirksFor()` serves it for every entry, so verifying
`date-range-required` on `/api/vouchers` alone left it asserted for `/api/postings` and the nine
`/api/ledger/*` endpoints on no evidence, and `module-gating` was checked on two of its five. Each case now
declares `probes`, and the test fails unless they cover every path the quirk declares — so adding a path to
a quirk in `src/reai/quirks.ts` breaks the build until the audit probes it. Coverage handles both shapes
`paths` uses: `/api/ledger` is a **prefix** (not an endpoint — it 404s "No static resource"), and
`/api/annual-accounts/{year}` is **templated**, so only a concrete year can be fetched. Padding `probes`
with an unrelated path fails too, and a `check()` that ignores `this.probes` fails, so the declared
coverage is what is actually requested.

Each case names its quirk id, a `marker` phrase from that quirk's `note`, and a `check`. The marker is the
same binding `storage-drift` uses and has the same narrow job — stop a probe outliving the sentence it
verifies — with the same limitation: `includes` is blind to direction, so **the live run is the only
authority on whether a claim is true.** The guard adds one thing that file cannot: every case must contain
a **drift branch**, because a case that can only return OK or INCONCLUSIVE is decoration. Comments are
stripped before checking, since a commented-out `"drift"` defeated exactly that kind of assertion when
PR #116 was reviewed. Every way of defeating these guards that has been thought of — eighteen so far, eight of them found by
review rather than by me — was applied and each fails the build, with the file byte-identical afterwards.

An unexpected INCONCLUSIVE exits **3**, as the storage audit does. One case is unanswerable by
construction rather than by accident — `tenant-header-ignored-single-tenant` needs a token reaching exactly
one tenant, and this repository's reaches four — and a gate that fails forever is a gate everyone learns to
ignore. So a case may declare `conditional:` with the missing precondition, and only cases without it
affect the exit status. The reason must be at least twenty characters and name what is missing, and at most
one case may use the hatch; both are asserted, because it is the field that suppresses a failure.

Currently **7 unchanged, 0 drifted, 1 conditional** against tenant 2634.

**Coverage is stated as a census, not a pass mark**, because these eight quirks are served on **56
operations** — `match: "descendants"` expands them well past their path lists, and `module-gating` alone
reaches 34. Of those: 16 probed, 16 sampled through a declared family representative, 3 excepted as
operations where the claim does not hold (named in the note, since an agent describing them still receives
the quirk), and 21 non-GET and therefore unreachable by a read-only audit. The test fails if any served GET
is none of those, so adding a path to a quirk breaks the build until it is accounted for.

The 114 unprobed quirks are mostly claims about what a write stores or refuses, which needs the test tenant,
and that is the next slice.


## What did a ranking change do to every other query?

```bash
npm run sweep:discovery -- --against main
npm run sweep:discovery -- --baseline /tmp/some-built-checkout   # faster for several variants
```

It extracts the revision with `git archive`, builds it, rebuilds HEAD, and compares ~69,000 generated queries
against what HEAD answers. The npm script runs `npm run build` first because it imports HEAD's `dist/`: without
that, editing `src/reai/spec.ts` and forgetting to build compares a fresh baseline against stale output and
prints zero changes in every category — a false clean, which is the worst thing this tool could do. This exists because of a repeated failure rather than a hypothetical: **three PRs in a row added
a synonym or a phrase rule, swept it, reported the sweep, and had an independent review find an over-match the
sweep had not covered.**

| PR | what over-matched | the dimension that found it |
|---|---|---|
| #120 | `krediter → credit-note` moved "krediter faktura" off the operation that *creates* a credit note onto the one that applies an existing one | the synonym table's own keys, crossed with nouns |
| #122 | a demotion made "Apply a manual credit note to an invoice" return the DELETE that *unapplies* it | each endpoint's own **summary** as a query |
| #125 | `inngående + faktura` swallowed "endre inngående faktura"; `faktura + abonnement` erased the invoice family from "vis faktura for abonnementet" | adjective × noun, and noun × noun in both orders |

Each time the harness was rebuilt by hand in a scratch directory, differently and covering less. The
dimensions are not clever — they are simply the ones that have caught something — so they are committed and
`test/discovery-sweep.test.mjs` asserts that none of them silently disappears.

Four numbers come back. **Rank-1 changes** is the headline and the least informative alone. **Answer no longer
reachable** is the baseline's top result absent from the new window — the measure two CHANGELOG entries got
wrong by counting *empty result sets* instead, which with no score floor in `searchOperations` can never happen
and so was always zero. **Newly answered** was nothing and is now something. **Writes newly at rank 1** is
split out by risk, because a query stating no intent to write and handed an irreversible or
externally-transmitting operation is the failure this repository treats as most serious.

Verified by reconstructing each defect and reading what the output actually names — the first version of this
section claimed the dimensions "would have caught" all three, and an independent review refuted that for two of
them, because `rankOneChanged` printed a count and no query:

| reconstruction | what the sweep names |
|---|---|
| #125's unscoped `faktura + abonnement` | 24 rank-1 changes, **24 lost answers**, naming `fakturagebyr abonnement` and `fakturalinjer for abonnement` |
| #122's general demotion | the inversion itself: `POST …/manual-credit-note-applications → DELETE …/{creditNoteInvoiceId} [irreversible]` |
| #120's global exact-compound | the `krediter` over-match, on 9 lines. **`diett` is not named** — generated, but its ranking change is not one the report surfaces |

The #122 case is why there is a **risky new answers** category at all: that inversion is write-to-write, which
`writesPromoted` deliberately excludes, so the defect appeared only inside an unnamed count of 346. A rank-1
target that is irreversible or transmitting is now named whatever the previous method was.


### What it does not cover, stated rather than discovered later

- **Only 146 of 430 operations have a `summary`**, so the endpoint-summary dimension covers about a third of the
  surface.
- **109 operations are internal** and `searchOperations` excludes them, so a ranking change confined to those is
  invisible; their path segments still generate queries, which is part of why 489 of the corpus return nothing.
- The four categories **overlap by design** — one query can appear in three — so they must not be summed. The
  "24 rank-1 changes and 24 lost answers" above is the same 24 queries counted twice.
- `NOUNS` is curated and thin in some domains; the synonym-key dimension is what covers the rest, and it is
  derived from the table rather than hand-copied for exactly that reason.
- Both spellings of `å` are kept deliberately. They fold to the same tokens, so for TERM matching they are
  redundant — but `PHRASE_SYNONYMS` matches raw text **before** folding, and #125 needed `inngaaende` added to a
  phrase rule for precisely that reason. Dropping them would stop the sweep noticing the next missing spelling.

Nothing it prints is automatically a regression: a phrase rule narrowing a query to the family it names shows
as "no longer reachable" for the family it replaced. Read the lines rather than counting them.

## Is the deployment current?

```bash
npm run check:deployed
```

`scripts/deploy-cloud-run.sh` stamps `commit=<sha>` as a Cloud Run label; this reads it back and reports
which commits the running service does not have. It exists because of a specific failure rather than a
hypothetical: PR #115 corrected two quirks that had been **measured false** — agents were told a `+47`
prefix is rejected on a supplier phone, and that foreign numbers are stored "exactly as sent". The commits
merged and the live connector went on serving both to anything that called `reai_describe_endpoint`, for
**31 minutes** — measured after the review of #117 caught the first version of this paragraph claiming "two
days", which the repository was not old enough for. It was 31 minutes because someone looked, not because
anything checked: the deploy recorded no commit, so "is this current" could only be answered by comparing a
revision timestamp against `git log` — which cannot distinguish a commit made *before* the deploy from one
merged *after* it.

Drift is split by whether a client can read it, and only the first is an error:

| class | files | verdict |
|---|---|---|
| `AGENT-FACING` | `src/reai/quirks.ts`, `src/tools/`, `src/server.ts`, `src/policy.ts` | exits **1** — deploy |
| `BEHAVIOURAL` | other `src/` | reported, exit 0 — probably deploy |
| `INERT` | tests, scripts, docs | reported, exit 0 — no deploy needed |

That distinction is the point, though not for the reason first given here. "Six of the last seven merges
touched only tests and scripts" was asserted without measuring; running the exported `classify()` over them
gives **five agent-facing and two inert**. So this exits 1 on most merges, and its value is not being quiet
— it is naming *which* commits a client can read, so the decision to deploy has a reason attached.

**It cannot tell you the deployment works** — it compares a label against `git log`, nothing more. A
revision can carry the right commit and still be broken; `scripts/smoke-http.mjs` is what answers that.
`test/deployed-drift.test.mjs` exercises the classifier by calling it, because every guard in this
repository that verified a script by pattern-matching its source has since been defeated by a comment or a
rename.

## A note on `npm audit`

The production tree is clean: `npm audit --omit=dev` reports nothing, and CI enforces that at `--audit-level=moderate` as a blocking step. Two advisories arrived through `@modelcontextprotocol/sdk` and both are resolved by `package.json` overrides — `fast-uri` pinned to 3.1.5 (HIGH, host confusion via a backslash authority introducer) and `hono` to 4.12.34 (MODERATE, ReDoS in CORS middleware).

Both are **exact pins, not ranges**, and that is deliberate (`fast-uri` was a caret until this bit — see below). This project installs under a 7-day minimum-release-age policy, which is a supply-chain defence: a version published minutes ago has had no time for a compromised publish to be noticed. Landing a fix that is still inside that window needs `npm install --min-release-age=0` — and with the age check off, a caret range takes whatever is newest. `^4.12.34` resolved to `4.13.1`, published four hours earlier, which is precisely the exposure the policy guards against. Pinning exactly gets the fix and nothing else.

The bypass is also **narrow**, and getting that right took two attempts. Deleting the lockfile and reinstalling under the flag re-resolves *everything*, so `@hono/node-server`, `express-rate-limit`, `ip-address` and `jose` were all upgraded without the age check — a far wider exception than the one being made. Starting from the existing lockfile and adding only the override changes exactly one line. And it is one-time: `npm ci` installs from the lockfile without resolving, so CI never runs under a relaxed policy.
