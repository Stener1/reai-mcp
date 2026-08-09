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

### The tenant guard, and why the old one protected nothing

Every script here that writes calls `requireWritableTenant()` from `scripts/lib/write-guard.mjs`, at the top
level, before it can issue anything. There are two layers and they do different jobs:

- **an allowlist** — `REAI_WRITE_TEST_TENANTS` must name the `--tenant` being written to. Catches the ordinary
  typo.
- **a denylist** — module-private in that module, reachable only through `isProtectedTenant()`. It is
  **env-addable and never env-removable**: `REAI_PROTECTED_TENANTS` can add your own production tenants, and
  nothing can take one off the list. It was briefly an exported `Set`, and review defeated the whole guard with
  one line — `PROTECTED_TENANTS.delete(2634)` in a caller, then 41 non-GET requests to 2634 with every test
  passing, because `export const` blocks rebinding rather than mutation.
- **a runtime refusal at the socket** — `installProtectedTenantFetchGuard()` throws on any non-GET whose
  `X-Tenant-Id` names a protected tenant. The two number-based layers read values the caller supplied and the
  coverage test reads the caller's *source*; this one fires when the request is actually made. It covers the two
  audits, which call `fetch` in-process. It does **not** cover the two smoke scripts, which spawn the MCP server
  — for those the control point is the tenant handed to the child, checked before it starts.

The second layer exists because the first one is not a protection. It compares two values the *operator*
supplies, so setting both to the same wrong number makes it agree with the mistake — and that is precisely the
incident this repository already had: a full-write test reached tenant **2634**, a real business's books,
because the intended test tenant was unreachable and the run was pointed elsewhere. The books were restored
(37 vouchers, 84 postings, no MV-number gap), but the guard that should have stopped it had approved it.

Measured 2026-08-09, before the denylist existed. With `REAI_WRITE_TEST_TENANTS=2634 --tenant 2634` against a
local server mimicking `/api/me`, **all four** write scripts proceeded. The first version of this paragraph said
"three" and listed only master data; review reproduced all four and the real reach is the ledger and payroll:

```
POST /api/vouchers ×3       DELETE /api/vouchers        POST /api/loans
POST /api/salary-payments   POST /api/employees         POST /api/company-banks
POST /api/expenses/{id}/voucher                         POST /api/creditors, /api/debtors
POST /api/customers         POST /api/suppliers         POST /api/warehouses
POST /api/subscriptions     POST /api/agreements/rent-agreement
plus PATCH and DELETE follow-ups on customers, suppliers, warehouses and leads
```

`POST /api/vouchers` is the shape of the original incident.

There is deliberately **no override flag**. The thing that failed was an environment variable, so adding
another one would reintroduce it; if a protected tenant ever genuinely needs writing to, that is a code change
in a diff someone reads. `2634` is not a fact about ReAI — it is this repository's operator's own company, and
anyone self-hosting should put their own production tenants in that list.

**Two layers, because the number is not the destination.** A token scoped to a single tenant IGNORES
`X-Tenant-Id`, so both the allowlist and the denylist check a number that may not be where the write lands.
`requireTokenReachesTenant()` reads the structured `tenants` list from `/api/me` and refuses if the token does
not reach the declared tenant — or if it reaches exactly one tenant and that one is protected.

It must be the structured list. The version this replaces harvested four-digit numbers out of `reai_whoami`'s
prose, and `src/tools/meta.ts` emits *"Active tenant is set to 2783, but that id is NOT in this token's tenant
list"* — so the warning that a tenant was unreachable contained the number that made it look reachable, and
`--tenant 2783` on a token scoped to 2634 passed. Parse the list, never the sentence.

**`smoke.mjs` forces `REAI_WRITE_MODE=read-only`** rather than forwarding it. It POSTs to `/api/vat-returns`,
`/api/manual-reconciliations/{id}/close`, `/api/bank-reconciliations/{id}/vouchers` and `/api/subscriptions`
expecting refusals; with an ambient `full` those became real writes, and that file has no tenant guard. Forcing
the mode is also what makes its assertions mean anything, since all of them are written for read-only.

**The guard used to be four divergent copies**, one per script. It is one module now, so it cannot drift, and
`test/write-guard.test.mjs` checks it two ways: the behavioural tests **call** `assertWritableTenant` rather
than grepping for its message, and a coverage test **parses every script with the TypeScript compiler** and
fails if one can issue a non-GET without calling the guard. That shape is deliberate — PR #129 spent three
review rounds watching **one** guard get worded around **seven** different ways, and a new write script that
forgets the guard is the realistic way this protection would be lost. Verified by removing the guard, hiding it behind an
`if`, and adding a fresh writing script: each fails the build.


These run against the real API, and all of them assert the **negatives** as well as the happy path:

```bash
# Read-only. Safe against production books.
REAI_USER_API_TOKEN=... node scripts/smoke.mjs --tenant 1234

# The whole OAuth flow against a deployment.
REAI_USER_API_TOKEN=... node scripts/smoke-http.mjs --url https://…

# WRITES. Reversible master data only. 2634 is refused whatever these say — see the tenant guard below.
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
`audit:census` exists to print rather than assert. The checkable figures, **restated for the 16-case audit**: **122** quirks, of which **17** now have a live
case — 16 here plus `customer-name-title-cased` in `audit-storage.mjs`, with
`tenant-header-ignored-single-tenant` in both sets — leaving **105** unnamed.

The arithmetic here has been wrong twice, in opposite directions: first 2 + 8 + 114 = 124 out of 122
(double-counting the tenant-header quirk), then the 8-case accounting left in place beside a 16-case
audit. Count distinct ids and check the total.

This covers the **16 that a GET can answer**, and the report prints `of 122` so a pass is not read as
coverage. Everything here is a read, which is what makes it safe against tenant 2634's real books — there
is no write guard and no `REAI_WRITE_TEST_TENANTS`.

**How that is enforced — and this took four rounds, because every text-level version was defeated.** The
first version claimed the property was asserted "against `classifyRequest` rather than by grepping for method
names", which was backwards: `classifyRequest("GET", …)` returns `read` for every path by an early return, so
it could not fail. Each subsequent fix was a better pattern, and each was beaten:

| bypass | result |
|---|---|
| `...EXTRA` spread over `method: "GET"` | real POSTs, all tests green |
| `init.method = "POST"` *after* the check | real POSTs, all tests green |
| `import http from "node:http"` | real PUT, all tests green |
| `import * as x from 'node:http'` (single quotes) | real PUT, all tests green |
| `nativeFetch(...)` — the counter used a case-sensitive `/fetch\(/` | real POST, all tests green |
| `const raw = fetch;` placed **above** the guard IIFE | real POST, all tests green |
| `const N = ["node","http"].join(":"); await import(N)` | real PUT, all tests green |

The last two are the general form — name the unguarded function without writing `globalThis.fetch`, or build a
forbidden specifier before the `import()` — and **no pattern over one line can see either**.

So the check now **parses the file** with the TypeScript compiler (already a devDependency) and asks
structural questions: is any binding initialised from the identifier `fetch`; is `globalThis` referenced
outside the guard at all; is every dynamic `import()` argument a string literal or `pathToFileURL(...)`; is
there more than one call to `fetch`. `const raw = fetch` is a VariableDeclaration with an Identifier
initialiser, and `import(N)` is a CallExpression with an Identifier argument. Both are exact rather than
heuristic. The guard is also installed as the **first executable statement**, so there is no window in which
the native function is nameable. Two runtime layers remain: the `globalThis.fetch` wrapper rejects any non-GET
wherever it is called from, and the `init` object is frozen between its check and the fetch.

**What this does not do, stated because the prose here overclaimed twice.** It constrains the file *as
committed*. It cannot stop a determined rewrite — `node:net` sockets, a hand-rolled `http.ClientRequest`.
Monkey-patching the http module was tried and does not close that either: patching `.default.request` is
invisible through the **named** export, and `const { request } = await import("node:http")` is exactly what
the working bypass destructured. So the honest claim is narrower than "read-only is enforced": **no accidental
or casual edit can make this file write, and CI proves the committed text has no second network path.**
Defeating it now means deliberately writing an HTTP client to defeat a guard, which is not a mistake someone
makes while adding a probe.

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
PR #116 was reviewed. Every way of defeating these guards that has been thought of was applied, and each fails the build with the
file byte-identical afterwards. The list rather than a headline count, because a count here has been wrong
twice: marker absent from the note · marker split into a 13-character fragment · nonexistent quirk id · drift
branch deleted · drift branch left in a whole-line comment · drift branch left in a **trailing** comment ·
`sameKeys(got, got)` · a catch-all `/[\s\S]*/` · `sameKeys` rewritten as a one-directional subset check ·
HTTP method turned into a parameter with a `"GET"` default · `...EXTRA` spread over the method ·
`init.method = "POST"` **after** the check · a decoy `globalThis.fetch` wrapper · reassigning
`globalThis.fetch` afterwards · importing `node:http` · the shallow timesheets probe · a dropped declared
path · `probes` padded with an unrelated path · a `check()` ignoring `this.probes` (either of its two loops) ·
a `samples` prefix absent from the quirk's paths · a `samples` prefix with no probe beneath it · a path added
to the quirk itself · a note that stops naming an exception · a `conditional:` reason too short · one long but
vague · a 9th case opened as `  { quirk:` on one line.

An unexpected INCONCLUSIVE exits **3**, as the storage audit does. Some claims are unanswerable by
construction rather than by accident — `tenant-header-ignored-single-tenant` needs a token reaching exactly
one tenant and this repository's reaches four; `module-gating` and `timesheets-need-project-module` need a
module to be OFF — and a gate that fails forever is a gate everyone learns to ignore. So a case may declare
`conditional:` with the missing precondition, and only cases carrying it affect the exit status.

**There is no cap on how many may.** An earlier version of this paragraph said "at most one case may use the
hatch; both are asserted" — no such assertion existed, and **five of the eight** cases legitimately declare
one, because several of these claims are *about* a module being off. Capping it made the audit exit 3 on any
tenant whose modules sit the other way. What is enforced instead: the reason must be twenty characters and
name its precondition (checked against the reason, not the surrounding case body, which contains "cannot" in
nearly every case); a case may not be conditional in *every* branch, so it must still be able to verify
something somewhere; and a case that returns `"conditional"` without declaring one is downgraded to
inconclusive by the runner, so the exemption cannot be reached by a branch that merely failed to get an
answer.

Currently **12 unchanged, 0 drifted, 4 conditional** against tenant 2634, from **16 cases**. Two of those
conditionals are cases that could have printed OK: neither test tenant has a *saved* lead, so "a saved lead
does have an id" and the `LeadRes` shape at `/api/leads/{id}` cannot be observed, and a case that reports OK
beside the words "that half is unread" is the report contradicting itself.

**Coverage is stated as a census, not a pass mark**, because these quirks are served on far more operations
than they have ids — `match: "descendants"` expands them past their path lists, and `module-gating` alone
reaches 34. Every served GET must be one of four things, and the test fails if it is none of them, so adding
a path to a quirk breaks the build until it is accounted for:

| | meaning |
|---|---|
| **probed** | called directly |
| **sampled** | represented by a probe beneath a declared family prefix — the prefix must be one of the quirk's own paths **and** must contain a probe |
| **excepted** | the claim does **not hold** there, and the note must name that exact path, because an agent describing it still receives the quirk |
| **unmeasured** | served, but no GET can reach the claim — almost always because it needs a record to exist and creating one is a write. Distinct from an exception, which would force a note to assert something untrue. The reason must name what is missing, and a case may not declare every one of its GET operations unmeasured. |

The report prints the samples, exceptions and unmeasured operations on every run, so a reader is not left
reconstructing coverage from the case list.

The remaining unprobed quirks are mostly claims about what a write stores or refuses, which needs the test
tenant — **48 of them are attached to a reversible write**, and that is the next slice. Tenant 2783 is
reachable, so it is no longer blocked.

**Two more false notes surfaced adding these cases**, both corrected in `src/reai/quirks.ts`:
`leads-are-the-company-register-not-your-records` said the over-cap 400 *"names no field"*, while its
`fieldErrors` names `pageSize` and carries the fix — advice that pointed agents away from the one useful part
of the body. And `manual-reconciliation-404-means-not-manual-not-missing` described a 404 without mentioning
that `month` is required and validated first, so following it bare produces 400 `"month is required"` and
nothing about the id. The validation-order lesson for a third time; the probe now sends the full request and
the note states the order.


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
