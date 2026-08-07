# Changelog

All notable changes to `reai-mcp`. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[semantic](https://semver.org/), pre-1.0 while the tool surface settles.

> **Nothing has been published to npm yet.** Install from source or run the
> Docker image. The version below describes what is on `main`.

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
