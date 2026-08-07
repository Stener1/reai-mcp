# reai-mcp

An [MCP](https://modelcontextprotocol.io) server for **[ReAI](https://app.reai.no)**, the Norwegian cloud accounting system — so an AI agent can read the books, look up accounts and VAT codes, and do real bookkeeping through the API.

Not affiliated with or endorsed by ReAI. Community-built, MIT licensed.

```
You:   What did we spend on inventory this year, and which account is it on?
Agent: [reai_general_ledger] Account 1460 "Innkjøpte varer for videresalg" — 12 postings, closing balance 4 812,60 NOK.
```

## Why this exists

ReAI's API is genuinely good — 313 documented operations covering the whole accounting domain. But that is far too many to expose as 313 MCP tools: it would exhaust any client's tool budget and bury the agent in choices.

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

### Sending things to other people is a separate switch

`REAI_WRITE_MODE` answers *what can be undone in the books*. It deliberately does **not** answer *does this reach someone else* — those are different questions, and one setting cannot serve both.

So `REAI_ALLOW_EXTERNAL_SEND` gates everything that leaves the tenant, independently of the write mode:

- EHF/Peppol transmission, and any order carrying `sendEhf: true`
- Invoice email, payment reminders, agreement signing requests
- **Issuing a customer invoice** — `POST /api/invoices` starts delivery asynchronously (eFaktura, then EHF, then PDF by email), so it is not a books-only operation

It is **off by default**, and `REAI_WRITE_MODE=full` does not lift it. A posting can be reversed; an invoice that has gone over Peppol cannot be recalled.

**Turn it on if this deployment does your invoicing.** That is the ordinary case and the reason an accounting integration exists:

```
REAI_WRITE_MODE=full
REAI_ALLOW_EXTERNAL_SEND=1
```

Leave it off while evaluating, or when working against books whose real counterparties should not hear from you — which is exactly the situation when there is no sandbox and you are testing against a live company. The combination `full` + no external send is a genuinely useful place to be: the agent can do real bookkeeping and still cannot email anybody.

## Install

Requires Node.js 20 or newer, and a ReAI **user API token** (app.reai.no → settings → API tokens). A user token reaches every company your ReAI user can access; the server discovers them for you.

### Claude Code

```bash
claude mcp add reai --env REAI_USER_API_TOKEN=your-token -- npx -y reai-mcp
```

### Claude Desktop / Cursor / any stdio client

```json
{
  "mcpServers": {
    "reai": {
      "command": "npx",
      "args": ["-y", "reai-mcp"],
      "env": {
        "REAI_USER_API_TOKEN": "your-token",
        "REAI_WRITE_MODE": "reversible"
      }
    }
  }
}
```

### From source

```bash
git clone https://github.com/Stener1/reai-mcp.git
cd reai-mcp
npm install
npm run build
REAI_USER_API_TOKEN=your-token npm start
```

## Self-hosting as a remote connector

The same server also speaks MCP over Streamable HTTP, so it can be added as a **custom connector** rather than spawned locally. There is no hosted instance — you run your own, which means your ReAI token never leaves infrastructure you control.

It implements OAuth 2.1 as its own authorization server: dynamic client registration (RFC 7591), authorization code + PKCE (S256 only), resource metadata (RFC 9728), and refresh tokens. ReAI itself uses static API tokens and has no OAuth endpoints, so the flow bridges the two — the user pastes a ReAI token on the consent page, the server verifies it against `GET /api/me`, and then mints its own tokens carrying it.

### Docker

```bash
docker build -t reai-mcp .
docker run -p 8080:8080 \
  -e REAI_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" \
  -e PUBLIC_URL=https://reai-mcp.example.com \
  -e REAI_WRITE_MODE=reversible \
  reai-mcp
```

Then add `https://reai-mcp.example.com/mcp` as a custom connector. No `REAI_USER_API_TOKEN` is needed in remote mode — each user supplies their own during authorization.

### Google Cloud Run

```bash
./scripts/deploy-cloud-run.sh --project my-gcp-project
```

That is a single command because the manual version has three steps that are easy to get wrong, and the script handles all of them:

1. **Creates `REAI_ENCRYPTION_KEY` in Secret Manager** and grants the runtime service account access. Without a stable key, every authorization breaks on each cold start and separate instances reject each other's tokens.
2. **Sets `PUBLIC_URL` in a second pass.** The URL is not knowable before the first deploy, and if it does not match, the OAuth metadata advertises the wrong issuer.
3. **Pins `REAI_ALLOWED_HOSTS`** to the deployed host, so a client-supplied `Host` header cannot decide what the deployment claims to be.

It then verifies `/health` and checks the advertised issuer matches the deployed URL.

Useful flags: `--region`, `--service`, `--write-mode` (defaults to `reversible`; `full` prints a warning and pauses), `--allowed-redirect-hosts` (defaults to `claude.ai`).

`--allow-unauthenticated` is required and is not a mistake — the MCP client must reach the OAuth endpoints before it has a token. The server does its own authentication: every `/mcp` request needs a valid token, and anonymous ones get a `401` with a `WWW-Authenticate` challenge.

Two things learned deploying this for real:

- **Cloud Run may serve one service on more than one hostname.** Pinning `PUBLIC_URL` means every hostname advertises the *same* issuer, so a client connecting via an alias follows the metadata to the canonical URL rather than seeing the issuer change per request.
- **It scales to zero**, so it costs essentially nothing idle — but it is *your* deployment. Anyone who reaches the URL can authorize with their own ReAI token and reach their own books on your compute.

**On locking it down, honestly:** a public MCP connector is reachable by design, and the usual advice does not straightforwardly apply.

- **IAP does not work for this.** It requires an external HTTPS load balancer, and once IAP is enforcing, `claude.ai` cannot authenticate to it — the connector simply stops working. IAP is the right answer only for a *private* deployment you drive yourself, which is the `REAI_ALLOW_TOKEN_PASSTHROUGH` story behind Tailscale.
- **Cloud Armor alone is bypassable.** Putting a load balancer with Cloud Armor in front does nothing while the default `run.app` URL is still reachable and unauthenticated — callers just use that instead. If you go this route you must also set `--ingress=internal-and-cloud-load-balancing` so the service only accepts traffic arriving through the balancer. Note that Anthropic publishes no stable egress IP ranges, so an IP allowlist cannot reliably permit `claude.ai` anyway.

What actually helps: `--max-instances` caps the spend, `REAI_ALLOWED_REDIRECT_HOSTS` means only your own client's callback can start a flow, `REAI_WRITE_MODE` bounds what any authorized session can do, and not advertising the URL is the practical control. Every authorized user reaches only their *own* books, because the grant carries their own ReAI token — so the exposure is your compute bill, not your data.

### Why there is no database

Access tokens are **sealed**: the user's ReAI token is encrypted into the token itself with AES-256-GCM, along with the tenant and write mode chosen at authorization time. Any instance can therefore serve any request with no shared session store — which is what makes a scale-to-zero, multi-instance deployment practical.

The trade-offs are worth stating plainly:

- **`REAI_ENCRYPTION_KEY` is required in production.** Without it a random key is generated at startup, so every existing authorization breaks on restart, and separate instances reject each other's tokens. The server warns loudly.
- **Individual tokens cannot be revoked** before they expire (8 hours). Rotating `REAI_ENCRYPTION_KEY` invalidates all of them at once, which is the intended remedy.
- **Treat the key like a credential.** It decrypts every user's ReAI token. Use Secret Manager, not an env var in source control.

### Restrict who can register a client

Client registration is open, because that is what MCP clients expect. On a public deployment that has a consequence worth understanding: anyone can register a client with their own callback URL and send someone a link to *your* server's genuine consent page, on your domain, with valid TLS — then collect the ReAI token that gets pasted there.

The consent page pushes back on this. It names the **redirect host** as the party requesting access, treats the client's self-reported name as unverified, and shows the full callback URL next to a warning that whoever controls it gains full access to the books. But the real fix is to say which clients you actually use:

```
REAI_ALLOWED_REDIRECT_HOSTS=claude.ai
```

Unknown callback hosts are then refused at registration and never reach the consent page. Loopback stays allowed so local clients and MCP Inspector keep working.

### One tenant per authorization

The company selected during authorization is a **boundary, not a default**. A grant bound to tenant 4711 cannot address any other tenant, even though the underlying ReAI token may unlock dozens — relevant for an accountant whose token reaches every client company. Tools that pass a different `tenantId`, and `reai_use_tenant`, are both refused with an explanation. To work in another company, re-authorize and pick it.

**Worth being precise about what this rests on.** The boundary is enforced *here*, in this server — it is not the API refusing the call. ReAI ignores `X-Tenant-Id` for a single-tenant token (see the quirks above), so we could not verify that the API itself enforces a tenant switch, and every tenant we have to test with reaches exactly one company. The guarantee is therefore only as strong as this process: it holds for anything going through these tools, and says nothing about a caller with the same ReAI token talking to ReAI directly. That is the right architecture — the token is the user's own, so they were never prevented from doing that — but do not read it as the API sandboxing them.

### Verify a deployment

```bash
REAI_USER_API_TOKEN=your-token node scripts/smoke-http.mjs --url https://reai-mcp.example.com
```

This walks the entire OAuth flow the way a real client does — discovery, registration, PKCE authorization, token exchange, refresh — then connects over Streamable HTTP and calls read-only tools. It also asserts the negative cases: that PKCE is mandatory, that an authorization code cannot be replayed, that a forged token is refused, and that the ReAI token is never echoed back.

### Remote configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `PUBLIC_URL` | inferred from `Host` | **Set in production.** Published in OAuth metadata, so it must match what clients connect to. Must be a bare origin — a path, query or fragment is rejected at startup. `REAI_PUBLIC_URL` is accepted as an alias |
| `REAI_ENCRYPTION_KEY` | random per boot | **Set in production.** 32 bytes, base64 or hex. Seals access tokens |
| `REAI_ALLOWED_HOSTS` | — | Comma-separated hostnames to accept; enables DNS-rebinding protection and pins the advertised OAuth issuer |
| `REAI_ALLOWED_REDIRECT_HOSTS` | any https host | Comma-separated hosts allowed as OAuth redirect targets. **Recommended on a public deployment** — see below. Loopback is always permitted |
| `REAI_ALLOW_TOKEN_PASSTHROUGH` | off | Accept a raw ReAI token in the `Authorization` header, skipping OAuth. Convenient behind Tailscale or IAP; **anyone who reaches the URL acts as whoever's token they present**, so never enable it on a public deployment |

## Verify it works

```bash
REAI_USER_API_TOKEN=your-token npm run smoke
```

This launches the server as a real MCP client would, then exercises read-only tools against the live API and asserts that the write policy blocks a ledger write. It touches nothing, so it is safe against production books.

## First steps with an agent

Almost every endpoint is tenant-scoped — the tenant id selects *which company's books* you are in — so start there:

1. `reai_whoami` — who the token belongs to, and which companies it reaches.
2. `reai_use_tenant` — pick one for the session. Validated against the real list, so a typo fails immediately instead of silently writing into the wrong company.

Then work normally. Set `REAI_TENANT_ID` to skip step 2.

## Tools

### Orientation
| Tool | Purpose |
|---|---|
| `reai_whoami` | Authenticated user, accessible tenants, active tenant, current write policy |
| `reai_use_tenant` | Select the active company for this session |

### Discovery — the escape hatch
| Tool | Purpose |
|---|---|
| `reai_list_api_tags` | All 52 API domains with operation counts — a map of what the system can do |
| `reai_search_endpoints` | Keyword search across all 313 public operations |
| `reai_describe_endpoint` | Full schema for one endpoint, nested objects resolved — **with known quirks first** |
| `reai_api_notes` | Browse the known API quirks (see [below](#api-quirks-worth-knowing)) |
| `reai_request` | Call any endpoint. Auth and tenant handled; writes are policy-checked |

### Bookkeeping
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_accounts` | Search the chart of accounts (*kontoplan*) | read |
| `reai_list_vat_codes` | VAT (*mva*) codes with rates — tenant-specific, so look them up | read |
| `reai_list_vouchers` | Vouchers (*bilag*) in a date range, with postings | read |
| `reai_get_voucher` | One voucher with postings and attachments | read |
| `reai_list_postings` | Ledger postings, filterable; reports `canDelete` and `lockReasons` | read |
| `reai_general_ledger` | Hovedbok: per-account opening balance, postings, closing balance | read |
| `reai_create_voucher` | Book a voucher; balance validated locally first | **irreversible** |
| `reai_delete_voucher` | Delete a voucher, if the period is still open | **irreversible** |

### Sales
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_customers` · `reai_get_customer` | Find and read customers (*kunder*) | read |
| `reai_customer_ledger` | Kundereskontro — who owes what; `isOpenPosting` answers "who owes us money" | read |
| `reai_list_products` | Products and their variants; order lines reference a `variantId` | read |
| `reai_list_orders` · `reai_get_order` | Orders and their lines | read |
| `reai_list_offers` | Offers / quotes (*tilbud*) | read |
| `reai_list_invoices` · `reai_get_invoice` | Invoices and credit notes; filter `outstanding` + `overdue` | read |
| `reai_create_customer` · `reai_update_customer` · `reai_set_customer_address` · `reai_delete_customer` | Customer master data | reversible |
| `reai_create_product` · `reai_delete_product` | Create a product (no variants or price — see the tool's note); delete archives it once used | reversible |
| `reai_create_order` · `reai_delete_order` | Create an order with lines. Sends nothing to the customer; delete works until it is invoiced | reversible |
| `reai_create_offer` · `reai_delete_offer` | Create an offer. Lines require `itemName` **and** `vatCode`; an offer is a draft, so delete removes it outright | reversible |
| `reai_create_invoice_from_order` | Issue an invoice from an order | **irreversible** |
| `reai_credit_invoice` | Credit note — the correct way to undo an invoice | **irreversible** |
| `reai_register_invoice_payment` | Record a customer payment | **irreversible** |

### Purchase
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_suppliers` · `reai_get_supplier` | Find and read suppliers (*leverandører*) | read |
| `reai_supplier_ledger` | Leverandørreskontro — `isUnpaid` answers "what do we owe" | read |
| `reai_list_supplier_invoices` · `reai_get_supplier_invoice` | Registered supplier invoices and credit notes | read |
| `reai_list_reception_documents` | The document inbox — incoming invoices and receipts not yet booked | read |
| `reai_parse_ehf_attachment` | Parse an incoming EHF invoice into structured data | read |
| `reai_list_expenses` | Employee expense claims, incl. per diems and mileage | read |
| `reai_create_supplier` · `reai_update_supplier` · `reai_delete_supplier` | Supplier master data and bank details | reversible |
| `reai_create_supplier_invoice` | Register a supplier invoice directly | **irreversible** |
| `reai_register_supplier_invoice_payment` | Record paying a supplier | **irreversible** |

### Bank & VAT
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_company_banks` | The company's own accounts; the `id` is the `companyBankId` others need | read |
| `reai_get_bank_reconciliation` | Reconciliation state for one account and month — **the only way to see bank transactions** | read |
| `reai_get_bank_transaction` | One transaction by id | read |
| `reai_list_reconciliation_rules` | Automatic booking rules | read |
| `reai_get_tax_return` | Skattemelding for a year, with submission status | read |
| `reai_create_company_bank` · `reai_delete_company_bank` | Register a bank account, or remove one. Neither touches anything at the bank | reversible |
| `reai_create_reconciliation_rule` · `reai_delete_reconciliation_rule` | Manage booking rules. A rule is *standing authority to post* — applying it books vouchers, and deleting it does not reverse them | **irreversible** |
| `reai_match_bank_transactions` | Reconcile transactions against existing postings | **irreversible** |
| `reai_book_bank_transactions` | Book transactions to a counter-account | **irreversible** |
| `reai_apply_reconciliation_rules` | Run the rules over a period (background job) | **irreversible** |
| `reai_create_vat_return` | Settle and **lock** a VAT term — does *not* file with Skatteetaten | **irreversible** |

Anything not listed — leads, agreements, subscriptions, projects, assets, warehouses, employees, salary, opening balances, annual accounts — is reachable through `reai_search_endpoints` + `reai_request`, and carries its known quirks automatically.

If 63 tools is more than your client wants to see, narrow it with `REAI_TOOLSETS` — list **only** the groups you want:

```
REAI_TOOLSETS=bookkeeping          # 15 tools
REAI_TOOLSETS=bookkeeping,sales    # 37 tools
REAI_TOOLSETS=purchase             # 20 tools
(unset)                            # all 59
```

Valid groups are `bookkeeping`, `sales`, `purchase` and `bank`; listing all four is the same as leaving it unset. Orientation and discovery are never disabled, so a narrowed server still reaches every endpoint through `reai_search_endpoints` + `reai_request`.

## API quirks worth knowing

An accounting API has more sharp edges than its schema admits, and most of what follows was learned from a rejected request rather than from reading the spec. Rather than leave that knowledge in commit messages, it lives in [`src/reai/quirks.ts`](src/reai/quirks.ts) as **46 quirks keyed to the operations they affect** — so they surface automatically in `reai_describe_endpoint` and `reai_search_endpoints`, including for the ~256 operations no curated tool covers.

Browse them with `reai_api_notes`, or read the highlights:

**Shapes that aren't what the name suggests**
- **An invoice is created from an ORDER, not from line items.** `POST /api/invoices` takes an `orderId`. There is no endpoint that builds an invoice from lines — the order carries them.
- **There is no endpoint that lists bank transactions.** Only get-by-id. Transactions are visible solely through the reconciliation view for one account and one month, which makes that view the entry point for all bank work.
- **Voucher postings and supplier-invoice cost lines use different conventions.** A voucher posting is one *signed* amount (positive debits, negative credits, summing to zero). A cost line names debit and credit accounts explicitly, and its sign encodes *document type* — positive on an invoice, negative on a credit note.
- **`POST /api/vat-returns` takes `year` and `period` as query parameters**, not a body.

**Constraints the schema omits**
- **Voucher postings sharing a `rowNumber` are merged into one row**, so they must agree on the row's fields — notably `description`. An omitted `rowNumber` puts everything in row 0, so two postings with different descriptions fail with an error that blames the *sign convention*. `reai_create_voucher` assigns rows for you.
- `startDate`/`endDate` are required on vouchers, postings and ledgers even where not marked so.
- **Offer lines are stricter than order lines** — `itemName` and `vatCode` are both required on an offer.
- **Order** and subscription lines accept only VAT codes from `?usage=customer-invoice`; **offer** lines are not checked against it, so an offer can be accepted carrying a code that fails once the work becomes an order or invoice.
- A **`+47` prefix on a Norwegian phone number is rejected**.
- `POST /api/customers` silently discards `invoiceEmail`, `phone` and `daysUntilDue` — those live on the `PATCH`.
- **`GET /api/timesheets` is unusable without the Project module** — `projectId` is a *required* query parameter, and supplying it returns `400 "projectId cannot be used when the Project module is disabled"`. Required and rejected at once, so no request succeeds.

**Collections that are not arrays**
- **The lead endpoints return a page object**, not the bare array nearly every other collection does — so iterating the response or reading `.length` gets you nothing. `/api/leads` gives `{ items, page, hasPrevious, hasNext, … }` with `pageSize` 1–200 (default 50); `/api/leads/person-profiles` gives `{ items, hasMore, nextStartOrgNo, limit }` and pages by `nextStartOrgNo` instead of by number.
- A lead row's `id` is null only while it is **unsaved** (a live Brønnøysund entry). Saved leads have ids, and they are the key to `GET`/`PATCH /api/leads/{id}` and `…/convert` — keep them rather than discarding them.
- **`/api/warehouses/inventory`** returns `{ warehouseId, rows, totalStockValue, totalRetailValue }`. The totals are already computed; do not sum `rows`.

**Empty states that look like errors**
- **A 404 from `/api/opening-balances` or `/api/annual-accounts/{year}` means "nothing set up yet"**, which is the normal state for most companies — not a wrong path. The `detail` says as much; report it as empty instead of hunting for another endpoint.
- Payroll lives under **`/api/salary-payments`**; `/api/salaries` does not exist. A new run **already contains wage lines derived from expense postings** — read it back before adding any, because `…/wage-specs` adds a *manual* line and re-entering existing ones inflates salary and expenses, and expense-derived lines cannot be edited or deleted to fix it. `…/{id}/complete` starts A-melding submission to Skatteetaten, so it counts as an external send.

**Things harder to undo than they look**
- **Settling a VAT period locks it but files nothing.** There is no submission endpoint in the public API; `/complete-manually` exists to record that a return was filed elsewhere. Never report a VAT return as submitted.
- `period` is a **term index, not a month**: 1 = Jan–Feb … 6 = Nov–Dec. Passing `4` for April locks Jul–Aug.
- An **issued invoice cannot be deleted** — credit it.
- `sendEhf: true` on an order **arms Peppol transmission** to a real counterparty at invoicing time.
- A subscription with `outputMode: "create_invoice"` and `automaticBillingGeneration: true` **issues invoices on a schedule with no further call**.
- `DELETE` on a supplier invoice **reverses** it rather than removing it.

**Surprises**
- **`X-Tenant-Id` is ignored when a token reaches only one company.** Verified live: every tenant id returns that one company's data — including an id that does not exist, and one belonging to another user. Data stays isolated *between users*, so this is not a leak; but **a 200 is not evidence you reached the tenant you asked for.** Treat `GET /api/me` as the only authority on what a token can reach.
- **`/api/me` can under-report.** A company can exist in the ReAI UI while `/api/me` omits it — seen with one added but not finished onboarding. Combined with the point above this is a trap: probing it returns 200 with the *wrong* company's data, which looks like success.
- ReAI **title-cases stored names**, so a round-trip is not byte-equal.
- `DELETE` **archives instead of deleting** when a record has transactions; the response says which.
- A **403 is often a disabled module**, not a permissions problem — read the `detail`.
- `apply-rules` is a **background job** returning `started` or `already_running`; the work isn't done when the call returns.
- Two reconciliation views exist: synced accounts use `/api/bank-reconciliations/{id}`, accounts with `providerType: "manual"` use `/api/manual-reconciliations/{id}`.

**Conventions that are simply true everywhere**
- Dates are ISO `yyyy-MM-dd`; reconciliation months are `yyyy-MM`.
- Account numbers and VAT codes are **tenant-specific** — look them up, never assume.
- `daysUntilDue` is mandatory on orders and offers, so the API can never apply the customer's own terms by itself. The curated tools read the customer's terms for you and report which source they used.
- Deep links need the tenant: `https://app.reai.no/vouchers/123?tenantId=2634`. The tools return these already formed.

Where a curated tool exists, it enforces what it can locally so you get an explanation instead of a `400`: `reai_create_voucher` checks the debit/credit balance and reports the exact imbalance, `reai_create_supplier_invoice` checks cost-line signs against the document type, and `reai_apply_reconciliation_rules` refuses to run without a bounded period.

A test asserts every quirk still matches a real operation in the spec, so they can't quietly rot as the API changes.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `REAI_USER_API_TOKEN` | — | **Required.** ReAI user API token. `REAI_TOKEN` is accepted as an alias |
| `REAI_TENANT_ID` | — | Default tenant, so `tenantId` can be omitted |
| `REAI_WRITE_MODE` | `reversible` | `read-only`, `reversible` or `full` — see [Safety](#safety-this-writes-to-real-accounting-books) |
| `REAI_ALLOW_EXTERNAL_SEND` | off | Permit sending to third parties: EHF/Peppol, invoice email, reminders, signing requests, and issuing an invoice. **Enable this for a business doing its own invoicing** — see [below](#sending-things-to-other-people-is-a-separate-switch) |
| `REAI_BASE_URL` | `https://app.reai.no` | Override for a staging environment |
| `REAI_TIMEOUT_MS` | `30000` | Per-request timeout |
| `REAI_MAX_RETRIES` | `2` | Retries on 429/502/503/504, with exponential backoff and jitter |
| `REAI_VERBOSE` | off | Log one line per API request to stderr. Never logs tokens |

See [`.env.example`](.env.example) for the annotated version.

## How the API surface is kept current

`spec/reai-openapi.json` is a pinned snapshot of <https://app.reai.no/openapi>. `npm run build:spec` compresses it into a 195 KB searchable index (from 907 KB), keeping only what is needed to *find* an operation; full schemas are resolved from the snapshot on demand. Refresh it with:

```bash
curl -H 'Accept: application/json' https://app.reai.no/openapi -o spec/reai-openapi.json
npm run build
```

## Development

```bash
npm install
npm run build        # rebuild the spec index, then compile
npm test             # build + unit tests (no credentials needed)
npm run typecheck
npm run smoke        # read-only, end-to-end against the live API (needs a token)
```

Unit tests cover the write-policy classifier and spec search/describe, and need no network access or credentials.

### Running CI's checks locally

```bash
./scripts/ci-local.sh          # the working tree
./scripts/ci-local.sh main     # a specific ref
```

This runs everything `.github/workflows/ci.yml` runs — typecheck, build, the unit tests, and the published-package check — against every Node version in the matrix, and exits non-zero if any of it would fail.

It was written during a multi-hour GitHub Actions outage, when no workflow could start at all: "wait for a green tick" stops being a quality gate while the service producing the tick is down. It is **not** a substitute for CI, because it cannot reproduce the clean-room `npm ci` on Linux, and it says so on every run. If a Node version in the matrix is not installed locally it warns and tells you not to treat the result as equivalent.

Live harnesses, all of which assert the **negatives** as well as the happy path:

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

### A note on `npm audit`

Two advisories currently surface from transitive dependencies of `@modelcontextprotocol/sdk` (`hono` and `fast-uri`). Neither is on this server's request path — it uses `node:http` directly and never resolves remote JSON-Schema references. They clear when the upstream SDK bumps them.

## Contributing

Issues and PRs welcome. Adding a curated tool is deliberately mechanical:

1. Add a `defineTool({...})` in the relevant `src/tools/*.ts`, declaring its `risk`.
2. Export it from that module's array.
3. Add it to `allTools` in `src/server.ts` if you created a new module.

Declaring `risk` correctly is the part that matters — it is what gates the tool behind `REAI_WRITE_MODE`.

## Changelog

See [CHANGELOG.md](CHANGELOG.md), which also records the known limitations —
tokens cannot be individually revoked, path-prefix deployments are unsupported,
and the irreversible write paths have not been exercised end to end against live
books because ReAI has no sandbox.

## License

MIT — see [LICENSE](LICENSE).
