# The live audit harnesses

ReAI has no sandbox, so every claim in these pages was measured against real books — and a
measurement taken once rots silently when the API changes its wording, its validation order or what
it stores. Four harnesses re-ask the questions. Between them they have caught claims this repository
was making that were false: the `+47` phone rule, the four places calling the agreement enums
undocumented, `offer-lines-stricter`, two notes on leads and manual reconciliation, and the source of
the `skipRegistryLookup` override. Each section records what its run currently says; the numbers live
there rather than here, because a result restated in two places goes stale in one.

| harness | channel it checks | writes? |
|---|---|---|
| [`audit-quirks.mjs`](#audit-quirksmjs-the-128-claims-nobody-was-checking) | the 128 quirks, via the claims a `GET` can answer | no — safe against any tenant |
| [`audit-quirks-write.mjs`](#audit-quirks-writemjs-the-refusal-claims-a-get-cannot-reach) | quirks whose claim is that a **write is refused** | only requests built to fail |
| [`audit-messages.mjs`](#why-audit-messagesmjs-exists-and-what-it-does-not-cover) | the nineteen places in `src/` that read a ReAI error's **text** | only requests built to fail |
| [`audit-storage.mjs`](#audit-storagemjs-the-half-the-message-audit-cannot-reach) | claims about what the API **accepts, normalises or stores** | yes — customers, deleted in a `finally` |

Everything that writes refuses to run unless the tenant is named in `REAI_WRITE_TEST_TENANTS`, and
refuses tenant 2634 whatever that says: see
[the tenant guard](development.md#the-tenant-guard-and-why-the-old-one-protected-nothing), which is
the precondition for all of this and is documented next to the invocations rather than here.

There is a fifth harness that is not a live audit — the discovery sweep, which asks what a ranking
change did to every *other* query. It lives with the ranking work in
[docs/discovery.md](discovery.md#what-did-a-ranking-change-do-to-every-other-query).

## `audit-quirks.mjs`: the 128 claims nobody was checking

The other two audits check `src/tools/*.ts`. **Quirks** are the third channel, and the largest: 128 of
them, reaching agents through `reai_describe_endpoint` and `reai_api_notes`. Before this script, the two
audits named **2 of them** — `tenant-header-ignored-single-tenant` and `customer-name-title-cased`. Both
defects that motivated those audits were in this channel: the `+47` phone claim (PR #115) and the four
places calling the agreement enums undocumented (PR #123).

Resist quoting how many of the remaining 126 are "checkable": a keyword sweep over `note` prose gives 86 or
95 depending on the word list, so it is a lower bound dressed as a measurement — the false precision
`audit:census` exists to print rather than assert. The checkable figures: **128** quirks, of which **24** now
have a live case — **16** here, **7** in [`audit-quirks-write.mjs`](#audit-quirks-writemjs-the-refusal-claims-a-get-cannot-reach)
(whose claims a `GET` cannot reach), and `customer-name-title-cased` in `audit-storage.mjs` — leaving **104**
unnamed.

The arithmetic here has been wrong three times, in three directions: first 2 + 8 + 114 = 124 out of 122
(double-counting the tenant-header quirk), then the 8-case accounting left beside a 16-case audit, then a
17/111 split that ignored the write audit's six cases entirely. Count distinct ids and check the total — and
note that counting *mentions* of a quirk id rather than *cases* gives 26, because four scripts name an id in
prose without probing it. `test/docs.test.mjs` now derives all four numbers from the case arrays themselves,
so the next edit to either audit fails the build instead of quietly falsifying this paragraph.

This covers the **16 that a GET can answer**, and the report prints `of 128` so a pass is not read as
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

## `audit-quirks-write.mjs`: the refusal claims a GET cannot reach

`audit-quirks.mjs` covers the 16 claims a GET can answer and is read-only by construction. This covers a slice
of what it cannot: quirks whose claim is that a **write is refused**, and what the refusal says.

**Why it is safe, and where the line is.** Every probe is a request built to FAIL, and a refused write creates
nothing — the same reasoning `audit-messages.mjs` documents. Three rules keep that true rather than merely
intended:

1. **Nothing irreversible or transmitting is probed.** A probe is only safe if accidental success would be
   harmless, because a refusal that stops working means the request goes through. Enforced by asking
   `classifyRequest` and `classifyTransmission`, not by a hand-kept list.
2. **An unexpected 2xx is a SAFETY outcome**, distinct from drift, and exits non-zero. It means the rule changed
   *and* this script has written to real books.
3. **Record counts are snapshotted before and after**, across every collection a probe could add to, and any
   change fails the run.

Rule 3 is not theoretical. Scoping this file by hand, an order-line probe unexpectedly returned 201 and the
ad-hoc cleanup filtered the list response for a field the list does not return — so it printed "cleaning up 0
orders" while order 4109 sat in the tenant. Deleted by hand a minute later. A count check catches that; a
filter that has to be correct does not.

**Probe the request that is valid EXCEPT for the thing under test.** Fourth appearance of this trap in these
audits, and it cost three rounds of measurement here:

```
POST /api/offers {lines: […]}              → 400 "currencyCode is required"           (never reached the lines)
POST /api/offers {currencyCode, lines}     → 400 "offerLines is required"             (wrong field name)
POST /api/offers {…, offerLines: […]}      → 400 "offerLines[0].itemName is required" ← the actual claim
```

The required-field sets come from the pinned spec, and a test asserts that rather than trusting memory.

**It found `offer-lines-stricter` half false.** The note said `itemName` and `vatCode` are both required on an
offer line "but optional on an order line". `vatCode` is optional on an order line; `itemName` is **not** — an
order line without it is refused with 400 `"Produkt er obligatorisk for alle ordrelinjer."`, as a plain
Norwegian detail with no `fieldErrors`. An agent following the old note would build an order line with neither
and get a refusal it was told not to expect.

Currently **6 unchanged, 0 drifted, 0 SAFETY** against 2783, with record counts unchanged across six
collections. It refuses 2634 through the same guard as every other writing script.

## Why `audit-messages.mjs` exists, and what it does not cover

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

## `audit-storage.mjs`: the half the message audit cannot reach

`audit-messages.mjs` checks the wording of **refusals**, and says so plainly: every case there is a
request built to fail, so nothing observes what the API *accepts, normalises or stores*. Two of the five
false claims that motivated it live in that gap — `skipRegistryLookup` drifts on a `201`, and the phone
rule was wrong three times about what gets **stored**.

So this one writes. That difference dictates the design: only customers, which do delete cleanly on a tenant where they carry no references, and which
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
`npm run audit:census` counts them. Today: **162 distinct agent-facing literals assert something about what is
stored; 17 probes cover them, binding to 6 distinct source texts — different units, so not a percentage.** That ratio is printed rather than asserted, because a keyword sweep over prose is
a lower bound and pinning it would be false precision — but hiding it made 11-of-many look like coverage.
The cheap unprobed ones are named in the header of `test/storage-drift.test.mjs`, including the flagship
claim of `reai_create_customer` ("the name you send is then DISCARDED") on the **default**, no-flag path.

Latest run: **17 of 17 claims verified**, including that the `skipRegistryLookup` override is a stale
internal directory rather than Brønnøysundregistrene — and that one asks the registry live rather than
hardcoding a name, because a hardcoded string would report OK if Brreg ever converged on it, and DRIFT if
ReAI merely *updated* its directory, which would confirm the account rather than refute it.

## Why there is no argument-conformance check

An obvious-looking audit does not work, and this section exists so nobody spends another afternoon rediscovering
that. The idea: every argument a curated tool accepts should correspond to a field or parameter its endpoint
declares, because an argument the API does not know is answered `400 "Unknown field: x"` at call time.

**Measured 2026-08-10: there are zero real divergences.** Across every single-endpoint write tool, eleven
arguments are not declared by the spec and all eleven are deliberate — ten are the repo's `<resource>Id`
convention for a `{id}` path parameter (`assetId`, `warehouseId`, `departmentId`), and the eleventh is
`acceptPermanentPosition`, a `z.literal(true)` gate that is never sent.

Widened to every tool, the check reports **18** arguments, and all eighteen are correct code in three patterns a
naive conformance model cannot see:

- **Routing discriminators.** `kind` on the customer-address setter picks which endpoint to call —
  `kind === "delivery" ? "delivery-address" : "address"`. It is consumed by the handler, never sent.
- **Client-side filters.** `query` on the country and currency listers: the endpoint takes no query parameter, so
  the tool filters the response locally and says so — *"filtered locally out of 5"*.
- **Nested body fields.** The employment-line arguments (`percentage`, `occupationCode`, `municipality`, …) build
  a line *inside* the PATCH body, and the spec index records top-level fields only.

A note on why this list is prose rather than a table: `test/docs.test.mjs` reads a tool name in a documentation
table row as a claim about that tool's risk, and rejected an earlier draft for appearing to call an irreversible
tool something else. The guard is right to be suspicious of tool names in table cells, so the examples above name
the arguments and describe the tools instead.

Two of the three are undetectable structurally. A routing discriminator looks like any enum; a client-side filter
looks like any string. So the check can only pass by carrying an eighteen-name exemption list — which is the
[allowlist failure this repo has shipped three times](#audit-quirksmjs-the-128-claims-nobody-was-checking): a
roster of what to excuse exempts the nineteenth case too, silently, and the guard then reads as coverage.

Against zero measured divergences, that trade is not worth making. **What would change the answer:** a spec index
that records nested body fields, which would collapse the third pattern and leave only two — at which point
requiring routing and filter arguments to be declared in the tool definition (rather than inferred) could make
the remainder derivable. Until then, per-tool certifying tests and `confirm-against-response.mjs` cover this
ground with real API responses instead of a static model of them.
