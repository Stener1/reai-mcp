# reai-mcp

[![CI](https://github.com/Stener1/reai-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Stener1/reai-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen.svg)](package.json)

An [MCP](https://modelcontextprotocol.io) server for **[ReAI](https://app.reai.no)**, the Norwegian cloud accounting system — so an AI agent can read the books, look up accounts and VAT codes, and do real bookkeeping through the API.

Not affiliated with or endorsed by ReAI. Community-built, MIT licensed.

```
You:   What did we spend on inventory this year, and which account is it on?
Agent: [reai_general_ledger] Account 1460 "Innkjøpte varer for videresalg" — 12 postings, closing balance 4 812,60 NOK.
```

- **177 tools**: 170 curated across thirteen accounting domains, plus 7 always-on — orientation, and a discovery escape hatch that reaches all 321 public API operations.
- **Two independent safety switches.** One bounds what can be undone in the books; the other decides whether anything may leave the tenant at all. Both default to the cautious setting, and the first does not lift the second.
- **126 measured API quirks** keyed to the operations they affect, so `reai_describe_endpoint` warns you before the API rejects you.
- **Discovery works in Norwegian** — *"lønnskjøring"*, *"send fakturaen"* — measured against three query corpora.
- **Self-hosted, and deliberately not on npm.** Run it as local stdio, or deploy your own Streamable HTTP connector with OAuth 2.1. Nothing is published to the registry until it has been seen working against real books, so there is no `npx reai-mcp` to copy.

Full reference material lives in [`docs/`](docs/): [every tool and what each domain actually does](docs/tools.md), [the write policy in detail](docs/safety.md), [the quirk registry](docs/api-quirks.md), [discovery](docs/discovery.md), [self-hosting](docs/self-hosting.md), [development](docs/development.md) and [the live audit harnesses](docs/audits.md).

## Why this exists

ReAI's API is genuinely good — 321 documented operations covering the whole accounting domain. But that is far too many to expose as 321 MCP tools: it would exhaust any client's tool budget and bury the agent in choices.

So this server does two things at once:

- **Curated tools** for the operations that matter most, with real guardrails — account lookup, VAT codes, vouchers, postings, the general ledger. A voucher's debit/credit balance is checked *before* the request is sent, so you get a useful explanation instead of a generic `422`.
- **A discovery escape hatch** — `reai_search_endpoints`, `reai_describe_endpoint` and `reai_request` — so nothing in the API is out of reach. Leads, agreements, subscriptions, assets, payroll, Peppol: all callable, with schemas on demand.

You get ergonomics where it counts and full coverage everywhere else.

## Safety: this writes to real accounting books

Accounting data is not ordinary application data. Under the Norwegian Bookkeeping Act (*bokføringsloven*), a voucher posted in a closed period **cannot simply be deleted** — it must be corrected with a reversing entry. A submitted VAT return cannot be unsubmitted.

An agent exploring an API by trial and error is therefore genuinely dangerous here, so every operation is classified and gated by `REAI_WRITE_MODE`:

| Mode | Allows | Use it when |
|---|---|---|
| `read-only` | `GET` only | Reporting, analysis, letting an agent answer questions about the books |
| **`reversible`** (default) | Reads, plus master data that can be cleanly deleted — customers, suppliers, products, departments, offers | Day-to-day agent work |
| `full` | Everything: ledger postings, invoices, payments, payroll, VAT returns | You are prepared to correct mistakes by hand |

Two properties make this more than a label:

- **Tools you cannot use are not advertised.** In `reversible` mode the ledger-write tools are not registered at all, so the agent never sees them and cannot try.
- **The escape hatch fails closed.** `reai_request` classifies each call by method and path. An *unrecognised* write path is treated as irreversible and blocked — so a future endpoint this server has never heard of cannot slip through as "probably fine". Dot segments cannot straddle two paths either: `POST /api/customers/../vouchers` is refused, not resolved.
- **The body is inspected too, not just the path.** Some payloads are more dangerous than their endpoint suggests: an order carrying `sendEhf: true` arms Peppol transmission to a real counterparty, and a subscription with `outputMode: "create_invoice"` issues numbered invoices on a schedule. Both escalate to irreversible.

The default is deliberately the middle setting, not the permissive one.

Both switches sit on one path, and a curated tool is not a softer route to the API than the escape
hatch is — they converge on the same gates, in this order:

```
  curated tool (168) ---+
                        +---> 1. write policy .......... REAI_WRITE_MODE
  reai_request (321) ---+     2. external-send gate .... REAI_ALLOW_EXTERNAL_SEND  ---> ReAI API
                              3. PUT omission gate ..... reai_request only
```

The write policy speaks first, so a call the mode forbids is refused for that reason rather than for
a send it also happens to arm. Of the 18 public operations classified as reaching a third party, 17
are *also* classified irreversible — the exception is `GET /vat-return/altinn-sync`, which is
read-shaped and still talks to Altinn. So the two switches are not redundant in either direction:
turning on external send grants almost nothing by itself, and `full` alone reaches nothing that
leaves the tenant.

That asymmetry is the whole reason there are two switches rather than one setting with six values:

```
                             REAI_ALLOW_EXTERNAL_SEND
                        off (default)                 1
                     +-------------------------------+----------------------------+
   read-only         | read the books                | + altinn-sync              |
                     +-------------------------------+----------------------------+
   reversible        | + master data that            | nothing more — 17 of the   |
   (default)         |   deletes cleanly             |   18 sends are ALSO        |
                     |                               |   irreversible             |
                     +-------------------------------+----------------------------+
   full              | + the ledger, VAT settlement, | + issuing invoices, EHF/   |
                     |   asset write-offs, draft     |   Peppol, invoice email,   |
   REAI_WRITE_MODE   |   payroll runs                |   reminders, the a-melding,|
                     |                               |   the tax return, users    |
                     +-------------------------------+----------------------------+
```

Two measured cases shaped that classification, and both are worth reading before running anything in
`full`. The first is a pair of endpoints: **a full replacement can erase where money goes by leaving
it out.** `PUT /api/company-banks/{id}` carrying `{name, countryCode, currency}` — which is what a
rename looks like — answers `200` and empties the account number its own customers pay into. Sweeping
the document turned up 31 public `PUT`s that can clear a documented field by omission, so
`reai_request` now refuses one rather than reporting it afterwards, and the curated tools read and
merge instead: [docs/safety.md](docs/safety.md#a-full-replacement-can-erase-where-money-goes-by-leaving-it-out).

The second is a field set rather than a pair of endpoints, and it has its own section.

### Changing where money goes is treated as irreversible

A few fields are ordinary master data as *records* and permanent as *consequences*. Undoing the edit
is trivial; undoing what follows is not, because it happens later and through someone acting
perfectly normally. Nine of them name a bank account — `iban`, `bankAccountNumber`, `swiftCode`,
`swiftBic`, `routingNumber`, `accountNumber`, `bban`, `rentAccountNumber`, `depositAccountNumber` —
and one, `invoiceEmail`, names where invoices are delivered.

A call carrying any of them, on any of the paths that accept them, is classified **irreversible** and
refused in the default mode, through the curated tools and `reai_request` alike, even though the
endpoint itself is otherwise reversible. Every other field on the same tool is unaffected: renaming a
supplier still works in `reversible`. *Adding* a company bank stays ordinary work; repointing an
existing one does not — and on an employee the field is their salary, paid on a schedule by machinery
nobody re-reads each month.

The exact field set, which paths it reaches, what happens later in each case, and why emptying an
`invoiceEmail` counts as much as setting one are in
[docs/safety.md](docs/safety.md#changing-where-money-goes-is-treated-as-irreversible). The table is
not maintained by hand: `test/payment-routing.test.mjs` reads the OpenAPI document on every run and
fails the build on a routing-shaped field name that is neither treated as a destination nor
explicitly exempted with its evidence — which is how employees, `swiftBic`, `routingNumber` and a
lease's two escrow accounts were found missing from it.

### Sending things to other people is a separate switch

`REAI_WRITE_MODE` answers *what can be undone in the books*. It deliberately does **not** answer *does this reach someone else* — those are different questions, and one setting cannot serve both.

So `REAI_ALLOW_EXTERNAL_SEND` gates everything that leaves the tenant, independently of the write mode:

- EHF/Peppol transmission, and any order carrying `sendEhf: true`
- Invoice email, payment reminders, agreement signing requests
- **Issuing a customer invoice** — `POST /api/invoices` starts delivery asynchronously (eFaktura, then EHF, then PDF by email), so it is not a books-only operation
- Government filings: the tax return, and completing a payroll run (the a-melding)
- **Granting a user access** — `POST /api/users` creates a `pending_invitation` with an `invitationId` and an expiry, which reaches the invitee by email. What it sends is not data but privilege: `roleCode` accepts `ROLE_TENANT_ADMIN`, to an address the caller chooses
- **A bank-integrated supplier payment** — `manualPayment: false` can return an `approvalUrl` that starts a real BankID transfer. `manualPayment: true` records a payment that has already left the bank and needs nothing

It is **off by default**, and `REAI_WRITE_MODE=full` does not lift it. A posting can be reversed; an invoice that has gone over Peppol cannot be recalled.

**Turn it on if this deployment does your invoicing.** That is the ordinary case and the reason an accounting integration exists:

```
REAI_WRITE_MODE=full
REAI_ALLOW_EXTERNAL_SEND=1
```

Leave it off while evaluating, or when working against books whose real counterparties should not hear from you — which is exactly the situation when there is no sandbox and you are testing against a live company. The combination `full` + no external send is a genuinely useful place to be: the agent can do real bookkeeping and still cannot email anybody.

## Install

Requires Node.js 20 or newer, and a ReAI API token (app.reai.no → settings → API tokens).

### There is no npm package

`reai-mcp` is **deliberately unpublished**: nothing goes to the registry until this has been seen
working against real books, and the CHANGELOG says so too. Install from source, or build the Docker
image for a remote deployment. Any `npx -y reai-mcp` recipe you find is wrong — the name does not
resolve.

```bash
git clone https://github.com/Stener1/reai-mcp.git
cd reai-mcp
npm install
npm run build
```

That leaves an executable server at `dist/index.js`. Started with no token it exits non-zero and
names the missing variable, which CI asserts on every push.

### Claude Code

```bash
claude mcp add reai --env REAI_USER_API_TOKEN=your-token -- node /absolute/path/to/reai-mcp/dist/index.js
```

### Claude Desktop / Cursor / any stdio client

```json
{
  "mcpServers": {
    "reai": {
      "command": "node",
      "args": ["/absolute/path/to/reai-mcp/dist/index.js"],
      "env": {
        "REAI_USER_API_TOKEN": "your-token",
        "REAI_WRITE_MODE": "reversible"
      }
    }
  }
}
```

An absolute path is required: the client's working directory is not yours.

### Verify it works

```bash
REAI_USER_API_TOKEN=your-token npm run smoke
```

This launches the server as a real MCP client would, then exercises read-only tools against the live API and asserts that the write policy blocks a ledger write. It touches nothing, so it is safe against production books.

### Which kind of token you have matters

ReAI issues both kinds, and the API behaves differently for each — the OpenAPI spec says `X-Tenant-Id` is *"required for tenant-scoped requests when authenticating with a user access token"*, and `GET /api/me` returns *"the tenants available to the token"*.

| | tenant-scoped token | user-scoped token |
|---|---|---|
| `GET /api/me` lists | exactly one company | every company the user can open |
| `X-Tenant-Id` | **ignored** when the token reaches one company — any value, even a nonexistent id, returns that company's data | required on every tenant-scoped call, and honoured |
| `reai_use_tenant` | nothing to switch to | selects which company you are working in |

A user-scoped token is what makes this worth running for an accountant: one connection reaching every
client company, with `reai_whoami` listing them and `reai_use_tenant` moving between them. What
`reai_whoami` can and cannot tell you about which kind you hold — `GET /api/me` has no field that
distinguishes them — is in [docs/tools.md](docs/tools.md#orientation).

The safety consequence cuts the other way, and is why a remote connector binds one company at
authorization time rather than handing an agent all thirty because it was asked about one:
[docs/self-hosting.md](docs/self-hosting.md#one-tenant-per-authorization).

## First steps with an agent

Almost every endpoint is tenant-scoped — the tenant id selects *which company's books* you are in — so start there:

1. `reai_whoami` — who the token belongs to, and which companies it reaches.
2. `reai_use_tenant` — pick one for the session. Validated against the real list, so a typo fails immediately instead of silently writing into the wrong company.

Then work normally. Set `REAI_TENANT_ID` to skip step 2.

## Tools

7 tools are always on: `reai_whoami` and `reai_use_tenant` for orientation, and the escape hatch —
`reai_list_api_tags`, `reai_search_endpoints`, `reai_describe_endpoint`, `reai_api_notes` and
`reai_request` — which between them reach all 321 public operations. They cannot be disabled, so a
narrowed server still reaches everything.

The other 168 are curated, in thirteen groups. **[docs/tools.md](docs/tools.md) is the reference**:
every tool with its purpose and its risk classification, and per domain what driving it against live
books actually turned out to do.

| Group | What it covers |
|---|---|
| [Bookkeeping](docs/tools.md#bookkeeping) | The chart of accounts, VAT codes, vouchers, postings, the general ledger, sub-accounts |
| [Sales](docs/tools.md#sales) | Customers and their contact people, products, orders, offers, invoices, the customer ledger, and lead prospecting against Brønnøysund |
| [Purchase](docs/tools.md#purchase) | Suppliers, supplier invoices, the document inbox, EHF parsing, employee expense claims |
| [Bank & VAT](docs/tools.md#bank--vat) | Company bank accounts, reconciliation both synced and manual, booking rules, the tax return, settling a VAT term |
| [Organisation](docs/tools.md#organisation) | Departments, employees and the employee ledger, users, roles and permissions |
| [Fixed assets](docs/tools.md#fixed-assets) | The *anleggsmidler* register, depreciation schedules, write-offs |
| [Subscriptions](docs/tools.md#subscriptions) | Recurring billing, its history, and whether it goes out on its own |
| [Warehouses](docs/tools.md#warehouses) | Warehouses, stock on hand per variant, inventory adjustments |
| [Agreements](docs/tools.md#agreements) | Leases, employment contracts, purchase and service agreements, signing status |
| [Payroll](docs/tools.md#payroll) | Salary runs and their wage lines. Completing a run is deliberately not a tool |
| [Reference data](docs/tools.md#reference-data-and-company-state) | Country and currency codes, the opening balance, annual-accounts status |
| [Loans](docs/tools.md#loans) | Loans borrowed and lent, and the creditors and debtors at each end |
| [Share investments](docs/tools.md#share-investments) | The portfolio and its events — purchases, sales, dividends, write-downs |

Three tools are documented together, apart from their domains, because they exist for one reason: to
stop a rename destroying a payment destination
([docs/tools.md](docs/tools.md#renaming-something-must-not-erase-where-money-goes)). That is a
documentation grouping only — `reai_update_company_bank` belongs to `bank`,
`reai_set_supplier_address` to `purchase` and `reai_update_creditor` to `loans`, they are inside the
168, and narrowing with `REAI_TOOLSETS` enables each one with its own domain. One tool genuinely is
outside all thirteen: `reai_reconcile_ui` is off unless `REAI_ENABLE_UI=1`, because it is the only *view* here, and the only
payload in this API that does not fit comfortably in text
([why](docs/tools.md#the-one-ui-surface)).

Anything not listed — projects, timesheets, documents — is reachable through
`reai_search_endpoints` + `reai_request`, and carries its known quirks automatically.

If 177 tools is more than your client wants to see, narrow it with `REAI_TOOLSETS` — list **only**
the groups you want. Each count below includes the 7 always-on tools:

```
REAI_TOOLSETS=bookkeeping          # 19 tools
REAI_TOOLSETS=bookkeeping,sales    # 56 tools
REAI_TOOLSETS=purchase             # 33 tools
REAI_TOOLSETS=bank                 # 25 tools
REAI_TOOLSETS=organisation         # 25 tools
REAI_TOOLSETS=assets               # 13 tools
REAI_TOOLSETS=subscriptions        # 16 tools
REAI_TOOLSETS=warehouses           # 14 tools
REAI_TOOLSETS=agreements           # 13 tools
REAI_TOOLSETS=salary               # 14 tools
REAI_TOOLSETS=reference            # 11 tools
REAI_TOOLSETS=loans                # 20 tools
REAI_TOOLSETS=investments          # 14 tools
(unset)                            # all 175
```

Valid groups are `bookkeeping`, `sales`, `purchase`, `bank`, `organisation`, `assets`, `subscriptions`, `warehouses`, `agreements`, `salary`, `reference`, `loans` and `investments`; listing all thirteen is the same as leaving it unset. Orientation and discovery are never disabled, so a narrowed server still reaches every endpoint through `reai_search_endpoints` + `reai_request`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `REAI_USER_API_TOKEN` | — | **Required.** ReAI user API token. `REAI_TOKEN` is accepted as an alias |
| `REAI_TENANT_ID` | — | Default tenant, so `tenantId` can be omitted |
| `REAI_WRITE_MODE` | `reversible` | `read-only`, `reversible` or `full` — see [Safety](#safety-this-writes-to-real-accounting-books) |
| `REAI_ALLOW_EXTERNAL_SEND` | off | Permit anything that reaches a third party: EHF/Peppol, invoice email, reminders, signing requests, issuing an invoice, government filings, a user invitation, and a bank-integrated supplier payment. **Enable this for a business doing its own invoicing** — see [below](#sending-things-to-other-people-is-a-separate-switch) |
| `REAI_BASE_URL` | `https://app.reai.no` | Override for a staging environment |
| `REAI_TIMEOUT_MS` | `30000` | Per-request timeout |
| `REAI_MAX_RETRIES` | `2` | Retries on 429/502/503/504, with exponential backoff and jitter |
| `REAI_VERBOSE` | off | Log one line per API request to stderr. Never logs tokens |

See [`.env.example`](.env.example) for the annotated version. `REAI_TOOLSETS` is described
[above](#tools); `REAI_ENABLE_UI` under [the one UI surface](docs/tools.md#the-one-ui-surface); and
the variables that only matter to a remote deployment — `PORT`, `PUBLIC_URL`, `REAI_ENCRYPTION_KEY`,
`REAI_ALLOWED_HOSTS`, `REAI_ALLOWED_REDIRECT_HOSTS`, `REAI_ALLOW_TOKEN_PASSTHROUGH` — are in
[docs/self-hosting.md](docs/self-hosting.md#remote-configuration).

## API quirks worth knowing

Most of what this server knows about ReAI was learned from a rejected request rather than from
reading the spec. Rather than leave that in commit messages, it lives in
[`src/reai/quirks.ts`](src/reai/quirks.ts) as **126 quirks keyed to the operations they affect** — so
they surface automatically in `reai_describe_endpoint` and `reai_search_endpoints`, including for the
132 public operations no curated tool covers. A test asserts every quirk still matches a real
operation in the spec, so they cannot quietly rot as the API changes.

Four to give the flavour: an invoice is created from an *order*, not from line items; there is no
endpoint that lists bank transactions; `period` on a VAT return is a two-month term index, so passing
`4` for April locks Jul–Aug; and a `403` is usually a disabled module rather than a permissions
problem. Browse them from an agent with `reai_api_notes`, or read the whole registry as prose in
[docs/api-quirks.md](docs/api-quirks.md).

## Discovery works in Norwegian

This is a Norwegian accounting system and its users type Norwegian, where the definite article is a
suffix and nouns glue together — so *"lønnskjøring"*, *"varelager"* and *"send fakturaen"* have to
resolve to endpoints whose paths are in English. They do, and the definite article is handled rather
than hoped for: the suffixes `-n`, `-ne`, `-en` and `-et` are stripped and retried whenever the
remaining stem is a word the synonym table already knows, so `kunden`, `ordren`, `utgiften` and
`dokumentet` all resolve — and a test asserts inflection does not change the *rank*, not merely that
something comes back. A stem-*changing* definite (`anleggsmiddel` → `anleggsmidlet`, which drops a
vowel) is still out of reach, and the test names that case rather than omitting it.

On a 31-query bilingual set — 21 Norwegian, 10 English — all 31 find their endpoint and 28 of them rank
it in the top three. Three further corpora hold the measurement as regression floors in
`test/discovery-heldout.test.mjs`, each scored once before anything was tuned against it, because a
benchmark whose failures you have read is no longer measuring anything.
[docs/discovery.md](docs/discovery.md) has those numbers, the four causes that were fixed, why the
stem gate is load-bearing rather than precautionary, and the sweep that answers "what did this
ranking change do to every *other* query".

## Self-hosting as a remote connector

The same server speaks MCP over Streamable HTTP, so it can be added as a **custom connector** rather
than spawned locally. There is no hosted instance — you run your own, which means your ReAI token
never leaves infrastructure you control. It implements OAuth 2.1 as its own authorization server
(dynamic client registration, PKCE, refresh tokens) and bridges that to ReAI's static API tokens: the
user pastes a ReAI token on the consent page, and the server seals it into its own access tokens, so
there is no session database and a scale-to-zero deployment works.

```bash
./scripts/deploy-cloud-run.sh --project my-gcp-project
```

Remotely, the write ceiling is **composed rather than chosen once**. A grant is sealed at
authorization time carrying the mode the user picked on the consent page, and every request applies
whichever of that and the server's *current* `REAI_WRITE_MODE` is narrower — so tightening the
deployment binds tokens that were already issued, and a permissive server never widens a grant
somebody deliberately narrowed:
[docs/safety.md](docs/safety.md#the-remote-write-ceiling-is-the-narrower-of-two).

Docker, the Cloud Run script's three easy-to-get-wrong steps, why an authorization is bound to one
company and cannot address another, an honest account of what locking a public connector down can and
cannot achieve, how the OAuth flow is verified end to end, and the remote-only environment variables
are all in [docs/self-hosting.md](docs/self-hosting.md).

The MCP endpoint also enforces two transport ceilings, both well above any real tool call: an **8 MB**
request body and a **50-message** JSON-RPC batch. Each has a surprise in it worth reading before
diagnosing one as a network fault — an oversized body does not reliably get a `413`, and `GET /mcp`
answers `405` on purpose, not by omission:
[docs/self-hosting.md](docs/self-hosting.md#request-limits).

## Development

```bash
npm install
npm run build        # rebuild the spec index, then compile
npm test             # build + the unit suite (no credentials needed)
npm run typecheck
npm run smoke        # read-only, end-to-end against the live API (needs a token)
```

Unit tests cover the write-policy classifier, the discovery ranker, spec search/describe, the OAuth
server and every curated tool's request shaping, and need no network access or credentials.
[docs/development.md](docs/development.md) covers adding a tool, running CI's whole matrix locally,
refreshing the pinned OpenAPI snapshot, and the live harnesses — which refuse to run unless the
tenant is named in `REAI_WRITE_TEST_TENANTS`, because a `--tenant` flag is not consent.

Because there is no sandbox, the documented claims are re-checked against live books rather than
trusted: four audit harnesses ask whether the refusals, the stored values and the 126 quirks still
say what this repository says they say, and each one has found something false.
[docs/audits.md](docs/audits.md) has what each covers, what it deliberately does not, and what it
found.

## Contributing

Issues and PRs welcome. Adding a curated tool is deliberately mechanical, and
[docs/development.md](docs/development.md#adding-a-curated-tool) has the three steps. Declaring
`risk` correctly is the part that matters — it is what gates the tool behind `REAI_WRITE_MODE`.

## Changelog

See [CHANGELOG.md](CHANGELOG.md), which also records the known limitations —
tokens cannot be individually revoked, path-prefix deployments are unsupported,
and the irreversible write paths have not been exercised end to end against live
books because ReAI has no sandbox.

## License

MIT — see [LICENSE](LICENSE).
