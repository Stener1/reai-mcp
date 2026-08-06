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
gcloud run deploy reai-mcp \
  --source . \
  --region europe-north1 \
  --allow-unauthenticated \
  --set-env-vars "REAI_WRITE_MODE=reversible" \
  --set-secrets "REAI_ENCRYPTION_KEY=reai-mcp-encryption-key:latest"

# Then pin PUBLIC_URL to the URL Cloud Run assigned:
gcloud run services update reai-mcp --region europe-north1 \
  --set-env-vars "PUBLIC_URL=$(gcloud run services describe reai-mcp --region europe-north1 --format='value(status.url)')"
```

`--allow-unauthenticated` is required — the MCP client must be able to reach the OAuth endpoints. The server does its own authentication; every `/mcp` request needs a valid token, and unauthenticated requests get a `401` with a `WWW-Authenticate` challenge.

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

### Verify a deployment

```bash
REAI_USER_API_TOKEN=your-token node scripts/smoke-http.mjs --url https://reai-mcp.example.com
```

This walks the entire OAuth flow the way a real client does — discovery, registration, PKCE authorization, token exchange, refresh — then connects over Streamable HTTP and calls read-only tools. It also asserts the negative cases: that PKCE is mandatory, that an authorization code cannot be replayed, that a forged token is refused, and that the ReAI token is never echoed back.

### Remote configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `PUBLIC_URL` | inferred from `Host` | **Set in production.** Published in OAuth metadata, so it must match what clients connect to |
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
| `reai_list_api_tags` | All 51 API domains with operation counts — a map of what the system can do |
| `reai_search_endpoints` | Keyword search across all 313 public operations |
| `reai_describe_endpoint` | Full schema for one endpoint, nested objects resolved |
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
| `reai_create_product` | Create a product (no variants or price — see the tool's note) | reversible |
| `reai_create_order` | Create an order with lines. Sends nothing to the customer | reversible |
| `reai_create_offer` | Create an offer. Lines require `itemName` **and** `vatCode` | reversible |
| `reai_create_invoice_from_order` | Issue an invoice from an order | **irreversible** |
| `reai_credit_invoice` | Credit note — the correct way to undo an invoice | **irreversible** |
| `reai_register_invoice_payment` | Record a customer payment | **irreversible** |

Anything not listed — suppliers, supplier invoices, expenses, bank reconciliation, leads, agreements, salary, assets, subscriptions — is reachable through `reai_search_endpoints` + `reai_request` today, and more curated tools are landing.

## Bookkeeping conventions worth knowing

- **Dates** are ISO `yyyy-MM-dd`.
- **Signs**: in a voucher a **positive** amount *debits* an account, a **negative** amount *credits* it, and all postings must sum to exactly zero. `reai_create_voucher` checks this locally and tells you the exact imbalance.
- **Account numbers and VAT codes are tenant-specific.** Look them up rather than assuming; which VAT codes are valid depends on the tenant's VAT registration.
- **Billing is a two-step chain**: an **order** carries the line items, and invoicing that order creates the invoice. There is no endpoint that builds an invoice from lines directly — this surprises everyone once.
- **To undo an issued invoice, raise a credit note.** An invoice is a numbered legal document; it is not deletable.
- **Order lines and offer lines differ.** An offer line requires `itemName` and `vatCode`; an order line does not. Both accept only VAT codes from `reai_list_vat_codes` with `usage="customer-invoice"`.
- **`daysUntilDue` is mandatory** on orders and offers, so the API can never apply the customer's own terms by itself. The tools read the customer's terms for you and say which source they used.
- **Deep links** need the tenant: `https://app.reai.no/vouchers/123?tenantId=2634`. The tools return these already formed.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `REAI_USER_API_TOKEN` | — | **Required.** ReAI user API token |
| `REAI_TENANT_ID` | — | Default tenant, so `tenantId` can be omitted |
| `REAI_WRITE_MODE` | `reversible` | `read-only`, `reversible` or `full` — see [Safety](#safety-this-writes-to-real-accounting-books) |
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

Two live harnesses, both of which assert the **negatives** as well as the happy path:

```bash
REAI_USER_API_TOKEN=... node scripts/smoke.mjs --tenant 1234       # read-only, safe on production books
REAI_USER_API_TOKEN=... node scripts/smoke-http.mjs --url https://…  # the whole OAuth flow
REAI_USER_API_TOKEN=... node scripts/smoke-write.mjs --tenant 1234 # WRITES: reversible round-trip
```

`smoke-write.mjs` creates real master data, reads it back, updates it and deletes it again, cleaning up in a `finally` so a mid-run failure still removes the record. It requires `--tenant` explicitly so it cannot write to the wrong company by accident, and it verifies that the ledger, invoicing, VAT-return and user-admin paths all stay refused.

### A note on `npm audit`

Two advisories currently surface from transitive dependencies of `@modelcontextprotocol/sdk` (`hono` and `fast-uri`). Neither is on this server's request path — it uses `node:http` directly and never resolves remote JSON-Schema references. They clear when the upstream SDK bumps them.

## Contributing

Issues and PRs welcome. Adding a curated tool is deliberately mechanical:

1. Add a `defineTool({...})` in the relevant `src/tools/*.ts`, declaring its `risk`.
2. Export it from that module's array.
3. Add it to `allTools` in `src/server.ts` if you created a new module.

Declaring `risk` correctly is the part that matters — it is what gates the tool behind `REAI_WRITE_MODE`.

## License

MIT — see [LICENSE](LICENSE).
