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
```

**Both write scripts refuse to run unless the tenant is listed in `REAI_WRITE_TEST_TENANTS`.** A tenant id on the command line is not consent — the tenant has to be declared safe to write to, out of band, in the environment. This exists because passing the wrong `--tenant` was once all it took to post a voucher into a live business's books. They also clean up in a `finally` so a mid-run failure still removes what was created, and report loudly enough to act on when they cannot.

`smoke-full-write.mjs` additionally requires `--i-understand-this-posts-to-real-books`, and asserts the whole external-send guard **before** it writes anything: if EHF, invoice email or a tax filing turns out to be reachable, it aborts without touching the ledger.

## A note on `npm audit`

The production tree is clean: `npm audit --omit=dev` reports nothing, and CI enforces that at `--audit-level=moderate` as a blocking step. Two advisories arrived through `@modelcontextprotocol/sdk` and both are resolved by `package.json` overrides — `fast-uri` pinned to 3.1.5 (HIGH, host confusion via a backslash authority introducer) and `hono` to 4.12.34 (MODERATE, ReDoS in CORS middleware).

Both are **exact pins, not ranges**, and that is deliberate (`fast-uri` was a caret until this bit — see below). This project installs under a 7-day minimum-release-age policy, which is a supply-chain defence: a version published minutes ago has had no time for a compromised publish to be noticed. Landing a fix that is still inside that window needs `npm install --min-release-age=0` — and with the age check off, a caret range takes whatever is newest. `^4.12.34` resolved to `4.13.1`, published four hours earlier, which is precisely the exposure the policy guards against. Pinning exactly gets the fix and nothing else.

The bypass is also **narrow**, and getting that right took two attempts. Deleting the lockfile and reinstalling under the flag re-resolves *everything*, so `@hono/node-server`, `express-rate-limit`, `ip-address` and `jose` were all upgraded without the age check — a far wider exception than the one being made. Starting from the existing lockfile and adding only the override changes exactly one line. And it is one-time: `npm ci` installs from the lockfile without resolving, so CI never runs under a relaxed policy.
