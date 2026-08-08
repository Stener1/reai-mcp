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
all four markers, and the guard passed 4/4. Text that predicts `+46701234567` cannot simultaneously claim
foreign numbers are rewritten to `+47`, so each probe pins the literal too, and markers must be at least
twelve characters (`marker: "e"` passed the first version).

**On completeness, the first version was a cop-out.** It said the population "cannot be measured
mechanically" because a storage claim is prose. It can be measured, roughly: the claims live in exactly
two places — `description:`/`.describe()` in `src/tools/*.ts` and `note:` in `src/reai/quirks.ts` — and
`npm run audit:census` counts them. Today: **129 agent-facing literals assert something about what is
stored; 11 are probed.** That ratio is printed rather than asserted, because a keyword sweep over prose is
a lower bound and pinning it would be false precision — but hiding it made 11-of-many look like coverage.
The cheap unprobed ones are named in the header of `test/storage-drift.test.mjs`, including the flagship
claim of `reai_create_customer` ("the name you send is then DISCARDED") on the **default**, no-flag path.

First run: **11 of 11 claims verified**, including that the `skipRegistryLookup` override is a stale
internal directory rather than Brønnøysundregistrene — and that one asks the registry live rather than
hardcoding a name, because a hardcoded string would report OK if Brreg ever converged on it, and DRIFT if
ReAI merely *updated* its directory, which would confirm the account rather than refute it.

## A note on `npm audit`

The production tree is clean: `npm audit --omit=dev` reports nothing, and CI enforces that at `--audit-level=moderate` as a blocking step. Two advisories arrived through `@modelcontextprotocol/sdk` and both are resolved by `package.json` overrides — `fast-uri` pinned to 3.1.5 (HIGH, host confusion via a backslash authority introducer) and `hono` to 4.12.34 (MODERATE, ReDoS in CORS middleware).

Both are **exact pins, not ranges**, and that is deliberate (`fast-uri` was a caret until this bit — see below). This project installs under a 7-day minimum-release-age policy, which is a supply-chain defence: a version published minutes ago has had no time for a compromised publish to be noticed. Landing a fix that is still inside that window needs `npm install --min-release-age=0` — and with the age check off, a caret range takes whatever is newest. `^4.12.34` resolved to `4.13.1`, published four hours earlier, which is precisely the exposure the policy guards against. Pinning exactly gets the fix and nothing else.

The bypass is also **narrow**, and getting that right took two attempts. Deleting the lockfile and reinstalling under the flag re-resolves *everything*, so `@hono/node-server`, `express-rate-limit`, `ip-address` and `jose` were all upgraded without the age check — a far wider exception than the one being made. Starting from the existing lockfile and adding only the override changes exactly one line. And it is one-time: `npm ci` installs from the lockfile without resolving, so CI never runs under a relaxed policy.
