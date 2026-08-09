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
a page under `docs/` — in practice [docs/tools.md](tools.md), which carries the tables — and
separately requires that no documentation table row mentioning it contradicts the code's `risk`, in
any of those files. So an undocumented or mis-labelled tool fails the build.

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

These run against the real API, and all of them assert the **negatives** as well as the happy path.
What each one covers, what it deliberately does not, and what it found are in
[docs/audits.md](audits.md); the invocations and the guard that makes them safe are here.

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
