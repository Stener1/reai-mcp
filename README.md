# reai-mcp

An [MCP](https://modelcontextprotocol.io) server for **[ReAI](https://app.reai.no)**, the Norwegian cloud accounting system — so an AI agent can read the books, look up accounts and VAT codes, and do real bookkeeping through the API.

Not affiliated with or endorsed by ReAI. Community-built, MIT licensed.

```
You:   What did we spend on inventory this year, and which account is it on?
Agent: [reai_general_ledger] Account 1460 "Innkjøpte varer for videresalg" — 12 postings, closing balance 4 812,60 NOK.
```

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

### A full replacement can erase where money goes by leaving it out

Two endpoints replace the whole record and do **not** require the account number, so a body that satisfies the schema without mentioning it clears it. Measured on a live tenant, both with a rename as the intent:

```
PUT /api/company-banks/{id} {name, countryCode, currency}  → 200, bban AND iban emptied
PUT /api/creditors/{id}     {name}                          → 200, bankAccountNumber null
```

This defeats the routing rule below, which escalates a body that *contains* a destination — it cannot see one whose danger is the omission. Both PUTs are therefore classified **irreversible** outright, creating either record stays reversible (adding diverts nothing), and a quirk tells a `reai_request` caller, because a `200` says nothing. `reai_set_customer_address` had the same shape on a smaller scale — the address PUT requires only street, city and country, so setting a street emptied the postcode — and it now reads the current address and merges.

#### And the escape hatch now refuses to send one blind

Naming the two worst instances is not the same as covering the class. Sweeping the document turns up **31 public `PUT` endpoints that can clear at least one documented field by omission**, and only 15 of them have a curated tool — the other 16 are reachable solely through `reai_request`, which cannot merge on a caller's behalf. Every instance of this bug in this repo was found *after* the write, on a live tenant, so a warning attached to the response is a post-mortem rather than a control.

So `reai_request` now refuses a `PUT` whose body omits documented optional fields, and names them:

```
PUT /api/company-banks/1561 REPLACES the record, and this body leaves out 3 of its 6
documented field(s), which the API stores as empty:

  bban, swiftCode, excludeFromReconciliationTodos

Nothing was sent.
```

Two ways past it, both deliberate: `GET` the record, merge your change over it and send the whole thing — which is what the curated tools do — or pass `clearOmittedFields: true` when emptying those fields is genuinely the intent. Verified on the live tenant in both directions: after the refusal the account number was still `"15201353103"`, and the same call with the flag set left it `""`.

Three details worth stating, because each is a decision rather than an omission:

- **`PATCH` is never checked.** Measured, `PATCH` on this API really does patch — a body carrying only `phone` left an employee's address, bank account, start date and employment lines untouched. Gating it would refuse ordinary partial updates on a rule that does not hold there.
- **Required fields are excluded.** The API rejects a body missing one and `missingRequired` already explains that; listing them here would bury the fields that get *silently* dropped, which are the only ones a caller cannot otherwise find out about.
- **The write policy speaks first.** A call the current write mode forbids is refused for that reason, not for this one — otherwise an agent goes after the wrong permission.
- **Both path forms are resolved.** ReAI decodes before routing and this server does not: `GET /api/company%2Dbanks` and `GET /api/employe%65s` both answer `200`, while the spec lookup matches the literal string. So the first version of this gate resolved nothing for an encoded path and therefore refused nothing — `PUT /api/company%2Dbanks/{id}` with a partial body went straight through and cleared the account number. Caught in review, and fixed the way the write ladder already handled it: resolve every form the request might route as. Verified live — the encoded call is now refused and the account number is untouched. The same blind spot was silencing the quirk note on successful writes reached that way.

### Changing where money goes is treated as irreversible

A few fields are ordinary master data as *records* and permanent as *consequences*. Undoing the edit is trivial; undoing what follows is not, because it happens later and through someone acting perfectly normally.

| Fields | Where | What happens later |
|---|---|---|
| `iban`, `bankAccountNumber`, `swiftCode`, `swiftBic`, `routingNumber`, `accountNumber`, `bban`, `rentAccountNumber`, `depositAccountNumber` | suppliers, customers, creditors, **employees**, supplier invoices (including `paymentDetails` nested inside them), invoice-reception documents, and **editing** an existing company bank or lease | Whoever pays that counterparty next — quite possibly a person clicking through the ReAI web UI weeks afterwards — sends money to whatever account is on file. On an employee it is their salary, paid on a schedule by machinery nobody re-reads each month. On a company bank it is your own customers who are redirected, and invoices already issued name that account. *Adding* a company bank stays ordinary work; repointing one does not |
| `invoiceEmail` | customers, orders, subscriptions | Every future invoice is delivered to that address. Not a payment — a disclosure — so the refusal says so, and tells you to confirm the address through a channel you already trust rather than to check bank details. **Emptying one counts too, in a partial body**: `invoiceEmail: ""` through a `PATCH` or through any curated tool stops invoices reaching the address someone chose, and needs `full` mode exactly as setting one does. Measured on `PATCH /api/customers/{id}`: `""` clears the address, `null` is the documented no-op, `" "` is a `400` — so the form that empties a billing address is the one that looks like a typo, and `""` is also the schema's declared default. Not on a `POST`, where no stored address exists to redirect, and **not on a replacement `PUT`**, where an empty value cannot be told apart from faithfully carrying back an address that is already empty — the omission gate covers that case instead |

The field list is not path-specific: any of them reaching any of those paths escalates. An earlier version of this table split them up, which read as though `bban` mattered only on company banks.

Two of those entries were found by checking the table against the API rather than trusting it, and the process is now a test (`test/payment-routing.test.mjs`) that reads the OpenAPI document on every run:

- **Employees were missing.** `PATCH /api/employees/{id}` accepts `accountNumber` — the account that employee's salary is paid to — and was classified as ordinary reversible master data. That is the sharpest member of this whole class, not a footnote: salary is paid on a schedule, by machinery nobody re-examines, and the person who notices is the employee whose pay did not arrive.
- **`swiftBic` and `routingNumber` were missing.** The field set was written against the supplier schema, which spells the same concepts `swiftCode` and `bankAccountNumber`. The supplier-invoice payment details use different names for them, so those writes went undetected.
- And the `/api/supplier-invoices/{id}/payment-details` sub-resource this table used to name **does not exist in the API**. The payment details are written through the invoice itself, which was not listed. No call was ever misclassified — creating or editing a supplier invoice is already irreversible by path — but the protection was pointing at nothing.

- **A lease's rent and deposit accounts were missed too**, and nearly dismissed. `PUT /api/agreements/rent-agreement/{id}` carries `rentAccountNumber` and `depositAccountNumber` — the accounts a tenant pays rent and their deposit into, which Norwegian law requires to be a separate escrow account. Both are bare strings, which is what made them look like ledger codes; it is in fact the evidence *for* them, since `AccountNumber` is documented as "Base chart of accounts number" and every genuine ledger field in the document `$ref`s it. These sit among `monthlyRent`, `rentDueDayOfMonth`, `depositAmount` and `guaranteeIssuer`.

The distinction the test has to make is that `accountNumber` means different things in different places: on an employee it is a bank account, on `POST /api/assets` it is a balance-sheet code the spec pins to `pattern: 1\d{3}`. Escalating the latter would refuse an ordinary booking with "this changes where a payment will go" — and a refusal that is false teaches an operator to distrust the true ones. So every routing-shaped field name in the document is either treated as a destination or explicitly exempted with its evidence, and a new one that is neither fails the build.

The one thing that guarantee does *not* cover: a field named simply `account`. The document already uses `account`, `creditAccount` and `debitAccount` for chart-of-accounts codes, so the scan cannot match bare `account` without burying the real signal — and the test names that blind spot rather than leaving it implied. Inward-facing records follow the company-bank rule: creating one is ordinary work, repointing one is not.

So a call carrying one of those fields is classified **irreversible** and refused in the default mode, on the curated tools and through `reai_request` alike, even though the endpoint itself is otherwise reversible. Every other field on the same tool is unaffected: renaming a supplier still works in `reversible`. Adding a new company bank stays ordinary work; repointing an existing one does not.

This was a real gap rather than a hypothetical: `reai_update_supplier` is declared `reversible`, its description promised that the bank fields "require `REAI_WRITE_MODE=full`", and nothing enforced it — while `reai_request` refused the identical `PATCH`. A control that is written down but not implemented is worse than none, because it invites running the default mode believing the fields are protected.

The same re-gating now covers the fields that **arm a send**, not only the ones that redirect money. `sendEhf`, `automaticBillingGeneration` and `outputMode: "create_invoice"` escalate a curated tool exactly as they already did through `reai_request`. No shipped tool accepts one of them, so nothing was ever reachable — the gap was found while designing a subscription tool that would have been the first, which is a better moment to find it than after shipping. A test checks the mechanism against a tool of that shape rather than only sweeping today's tools, because a guard that passes vacuously is not a guard.

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

**Token scope decides how much of this server is useful.** ReAI issues both kinds, and the API behaves differently for each — the OpenAPI spec says `X-Tenant-Id` is *"required for tenant-scoped requests when authenticating with a user access token"*, and `GET /api/me` returns *"the tenants available to the token"*.

| | tenant-scoped token | user-scoped token |
|---|---|---|
| `GET /api/me` lists | exactly one company | every company the user can open |
| `X-Tenant-Id` | **ignored** when the token reaches one company — any value, even a nonexistent id, returns that company's data | required on every tenant-scoped call, and honoured |
| `reai_use_tenant` | nothing to switch to | selects which company you are working in |

A user-scoped token is what makes this worth running for an accountant: one connection reaching every client company, with `reai_whoami` listing them and `reai_use_tenant` moving between them. `reai_whoami` reports what it can actually tell — that the token reaches one company or several — without guessing which kind it is, because `GET /api/me` has no field that distinguishes a tenant-scoped token from a user-scoped one belonging to a user with a single company. It also warns when the companies do not share a currency, and says to read the currency on each record rather than assume the company's: an invoice total is in the *invoice's* currency, which can differ again.

The safety consequence cuts the other way, which is why a remote connector binds one company at authorization time: a token that reaches thirty client companies should not hand an agent all thirty because it was asked about one. That applies to what is *disclosed* as well as what can be addressed — on a bound connection `reai_whoami` lists only the bound company, and says the others exist without naming them.

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

An authorization with **no** bound company is refused outright, at every point it could be used — issuing, redeeming and refreshing. Early builds could mint one when `GET /api/me` returned no companies, and such a grant had no tenant boundary at all. If you authorized before this and see `invalid_token` with "not bound to a company", remove and re-add the connector.

**Worth being precise about what this rests on**, because three different claims are easy to run together. Measured with a user-scoped token:

- **Selection is real.** `GET /api/chart-of-accounts` under two of the token's companies returns different payloads, so `X-Tenant-Id` chooses the company.
- **Isolation is real.** The same call with an id the token does not reach (`99999999`, `1`) returns `403`, so the API refuses a company the token has no access to.
- **The binding is not the API's.** A grant narrowed to one company is enforced *here* — ReAI sees the underlying user token, which legitimately reaches all of them, so it cannot know the authorization was scoped. Treating that as API-enforced would be a false assurance.

For a *tenant-scoped* token none of the first two applies: the header is ignored, any id returns that one company's data, and a request that appears to reach elsewhere has not. `scripts/check-token.sh` reports which case a token is in.

So the binding is exactly as strong as this process, which is the right architecture — the token is the user's own, and they were never prevented from calling ReAI directly — but do not read it as the API sandboxing them.

### Request limits

The MCP endpoint enforces two ceilings, both well above any real tool call:

| Limit | Value | Why |
|---|---|---|
| Request body | 8 MB | The transport otherwise parses an unbounded body: a 400 MB POST exhausted the heap of a 512 MiB container, taking every other in-flight request with it. Over the limit is answered `413` and the connection is closed — but see the note below, because a *far* oversized body gets no response at all |
| JSON-RPC batch | 50 messages | Every entry in a batch is dispatched concurrently, so 1000 of them meant 1000 simultaneous ReAI calls. The write policy is applied per call and never sees the aggregate, which in `full` mode made one HTTP request a route to thousands of postings |

**A `413` is not guaranteed.** To answer at all, the server has to finish reading the body it is rejecting: closing while data is still arriving makes the OS send `RST`, which discards the response the client has not read yet. So an oversized body is drained first — bounded at 32 MB and 5 seconds — and only then answered. Past either bound the request is destroyed with **no response**, which the client sees as a connection reset. The 400 MB case above is exactly that. Worth knowing before diagnosing a silent reset as a network fault.

`GET /mcp` answers **405**. A standalone SSE stream exists to carry server-initiated messages, which requires a session; this server is stateless by design — a fresh MCP server per request — so nothing could ever be sent on one. The spec permits either SSE or 405 here, and 405 is the honest answer. No client capability is lost: the server runs with `enableJsonResponse`, so a POST is answered with a single JSON response rather than an event stream, and there is nothing a standalone stream would have carried.

### The one UI surface

`reai_reconcile_ui` returns the unmatched bank transactions and unmatched ledger postings for a month side by side, so a person can pick which ones pair. It is off unless `REAI_ENABLE_UI=1`.

It is the only view here, and the bar it clears is narrow: **the user has to make a selection the agent cannot make for them, over items that are painful to name in prose.** "Match the 1,234.50 on the 3rd against the Europris posting" is worse than two columns and a click, and `reai_match_bank_transactions` already takes `transactionIds[]` and `postingIds[]` — the tool signature *is* a multi-select.

It is also the one payload that does not fit comfortably in text. A pending transaction serialises to roughly 750 characters, so a busy month runs into the result cap — and the way a truncated reconciliation failed is instructive: it showed unmatched transactions and zero unmatched postings, from which an agent would conclude there was nothing to match against and reach for the *booking* tool, which posts, instead of the matching one. (Result truncation itself is fixed — `ok()` now trims each list and names what it trimmed — but the shape of that failure is what this view is built not to repeat.)

Nothing else in this API clears that bar. A revenue chart, a voucher list, a dashboard — the answers are computable and belong in a sentence, which is the whole reason the API is worth wrapping in tools rather than screens.

It follows the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) shape: the view is a **resource** at `ui://reai/reconciliation` with MIME type `text/html;profile=mcp-app`, the tool points at it through `_meta.ui.resourceUri`, and each call's figures arrive separately as `structuredContent`. So the HTML is static and data-free, and the view renders the numbers itself. A host that does not support MCP Apps still gets the whole answer as text — the counts and totals *are* the answer; the rows are what the view is for.

Three things it holds deliberately:

- **It does not write.** Selecting is inert. Pressing *Match these* asks the host to call `reai_match_bank_transactions`, which the server re-checks under the same write policy — classified irreversible, so refused unless `REAI_WRITE_MODE=full`. It will not offer a call the tool would reject (both id lists are required), and it will not invent an account to book a difference to.
- **Counterparty text can never become markup.** Descriptions and payment references come from EHF documents and bank feeds, which is to say a supplier writes them. Every value reaches the page through `textContent`, and the test runs the view's own script against a DOM whose `innerHTML` throws.
- **No external request of any kind** — no CDN, font or image. Hosts render this under a strict CSP, and an accounting view should not phone anywhere.

One limit, stated rather than papered over: for a bank account whose currency differs from the books', postings carry two amounts and the OpenAPI document documents neither, so which is the bank figure could not be established against any reachable tenant. The view shows both and **declines to compute a difference** instead of guessing one — a wrong difference at that moment would prompt a fabricated discrepancy posting.

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
| `REAI_ENABLE_UI` | off | Expose the bank-reconciliation pairing view as an MCP Apps resource. Only useful for a host that supports them; see [The one UI surface](#the-one-ui-surface) |
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
| `reai_search_endpoints` | Keyword search across all 321 public operations |
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
| `reai_create_voucher` | Book a voucher; balance validated locally first, and postings to an account that requires a **sub-account** are refused with the choices named | **irreversible** |
| `reai_list_sub_accounts` · `reai_sub_accounts_for_account` | General sub-accounts (*underkonti*) — the named parts a ledger account is split into, and where `subAccountId` comes from | read |
| `reai_create_sub_account` · `reai_rename_sub_account` | Add a part to an account, or rename one. Creating cannot be undone — there is no `DELETE` | **irreversible** / reversible |
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
| `reai_create_customer` · `reai_update_customer` · `reai_set_customer_address` · `reai_delete_customer` | Customer master data. The delete **archives** instead when the customer has transactions, and reports which of the two happened | reversible |
| `reai_unarchive_customer` | Bring an archived customer back. An archived one is invisible to the list unless you pass `archived: true` | reversible |
| `reai_search_leads` | Prospecting: search the Norwegian company register (Brønnøysund) with this tenant's lead state on top — filter by legal form, industry, city, registration date, whether Brreg lists an accountant, whether an email or phone is on file | read |
| `reai_get_lead` | One company by **organisation number**, with its lead state if any | read |
| `reai_save_lead` | Start tracking a register company as a lead, with no state on it yet | reversible |
| `reai_update_lead` | Set **or clear** status, notes, email, phone, follow-up — omit to keep, null to clear, routed to whichever endpoint actually does that | reversible |
| `reai_log_lead_contact` | Record that contact happened (date, channel, short note). Sends nothing | reversible |
| `reai_convert_lead` | Convert a lead into a customer, saving it first because the endpoint is id-only | reversible |
| `reai_delete_lead` | Forget a company: status, notes, contact details and every contact event | reversible |
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
| `reai_list_expenses` · `reai_get_expense` | Employee expense claims, incl. per diems and mileage. The detail read also answers "has this been reversed", which the API cannot be asked directly | read |
| `reai_create_expense` · `reai_update_expense` | Draft a claim and edit it while it is open. The line arrays are each the **complete list** — sending one cost row deletes the others | **irreversible** |
| `reai_deliver_expense` · `reai_approve_expense` · `reai_unapprove_expense` | Move a claim through open → for_approval → approved. Unapproving refuses while a voucher exists, and says which one to delete | **irreversible** |
| `reai_book_expense_voucher` · `reai_delete_expense_voucher` | Post the expense to the ledger, and unlink it again. The delete is "delete **or** reverse" and reports which | **irreversible** |
| `reai_reverse_expense` | Withdraw a claim. It is not deleted, and no visible field changes — see below | **irreversible** |
| `reai_create_supplier` · `reai_update_supplier` · `reai_delete_supplier` | Supplier master data. Changing bank details (`iban`, `bankAccountNumber`, `swiftCode`) escalates the call to irreversible — see below. The delete **archives** instead when the supplier has transactions | reversible |
| `reai_unarchive_supplier` | Bring an archived supplier back | reversible |
| `reai_create_supplier_invoice` | Register a supplier invoice directly | **irreversible** |
| `reai_register_supplier_invoice_payment` | Record paying a supplier | **irreversible** |

Expense claims are the other half of payroll: a salary run arrives pre-populated with wage lines derived from expense postings for the period, so what is approved here is what gets paid out there. The whole state machine was driven on the test tenant — `open → deliver → for_approval → approve → approved → voucher`, and back down by deleting the voucher and unapproving — and three things it does are worth knowing before using it.

**`status` never says "booked".** A booked expense still reads `approved`; the only difference is that `voucherId` is set. Booking is also where the ledger moves: the voucher count went from 0 to 1 and came back as `{expenseId, voucherId, voucherNumber: "EX1-2026", voucherDate}`, its own number series. And booking an expense that is still `for_approval` **approves it as part of the same call**, so it can skip the approve step entirely.

**`status` never says "reversed" either, and that one hides.** `DELETE /api/expenses/{id}` answers `{"outcome":"reversed"}`, the expense vanishes from the list — and `GET /api/expenses/{id}` still returns it with whatever status it had before. No visible field changes. `?status=reversed` is rejected with a `400`, so the API cannot even be asked. The only positive signal is that a transition fails: `409 "Expense 2203 is reversed and can no longer be delivered"`. `reai_get_expense` spends one filtered list call to answer it properly, because acting on a withdrawn claim as though it were live is the mistake worth preventing.

**`category` is optional to create and required to deliver.** A cost row is accepted with no category, and then delivering answers `400 "Kategori må velges for kostnadsrad."` — naming no row. It is an enum of 28 values, so the tools take it as one and say when a row is missing it.

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

### Organisation
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_departments` · `reai_get_department` | Departments and their ids — what postings, employees and reports are tagged with | read |
| `reai_create_department` · `reai_update_department` · `reai_delete_department` | Manage departments. `DELETE` **archives instead of deleting** when something references the record, and says which in `{"outcome":…}`; departments have no unarchive endpoint | reversible |
| `reai_list_employees` | Everyone on the payroll, as a summary — the `id` is the `employeeId` postings, the ledger and expenses take | read |
| `reai_get_employee` | One full record. The national identity number and bank account are **redacted** unless `includePersonalData` is set | read |
| `reai_employee_ledger` | What is owed to or from each employee, with the postings behind it. `isOpenPosting` widens the window back to 2000, so an unsettled refund from last year is not hidden | read |
| `reai_create_employee` · `reai_update_employee` | Add and edit people. Passing `accountNumber` to the create escalates it to a payment-destination change; the update does not accept that field at all | reversible |
| `reai_set_employee_bank_account` | Set or change where a salary lands — a payment destination, and the sharpest one here. Reads the account before and after, so a *repoint* is visible rather than inferred | irreversible |
| `reai_add_employment_line` | Record a salary level, percentage or occupation code from a date. Reads the existing lines and writes them back with yours, because the field replaces | irreversible |
| `reai_delete_employee` | Hard delete — no archive branch and no undelete. `409` once any work data references them, including an empty draft salary run | reversible |

Employee master data is where this API's usual habit reverses, and it is worth stating in both directions. `PATCH /api/employees/{id}` is a **real patch** — verified by changing `phone` alone and finding city, postal code, street, bank account, start date and employment lines all untouched — which makes it the exception here, since company banks, creditors, agreements, subscriptions and salary wage lines all replace.

But `employmentLines` inside that patch **is** a replacement. An employee with two lines, PATCHed with one, came back with one: the other was gone and the survivor had a *new id*. So "add a raise from June" written the obvious way deletes the employment history, which is why `reai_add_employment_line` exists and `reai_update_employee` refuses the field.

Two more measured on the live tenant. Creating an employee with nothing but a name and an email is **not** a blank record: `dateOfEmployment` defaults to today and an employment relation with one empty line is created automatically, typed `ordinaertArbeidsforhold` — and employment is what the a-melding reports, so that date is not cosmetic. And `phone` is normalised to E.164 (`"22 33 44 55"` and `"0047 22334455"` both become `"+4722334455"`, a foreign number is fine) while an **unparseable** value is stored as `null` with a `200` and no error — `"nonsense"` silently replaced a stored number — so the tools read the phone back and say so when it did not survive.

| `reai_list_users` · `reai_get_user` | Who can reach the books, with roles and effective permissions — including people who have not accepted their invitation yet | read |
| `reai_list_roles` · `reai_list_permissions` | The roles this tenant can grant and what each actually carries, and the permission catalogue behind the codes | read |
| `reai_list_user_invitations` | Invitations sent and not yet accepted — standing access waiting to be claimed | read |

**The roles do not mean what their names suggest**, and this is the one finding here worth reading before granting anyone access. Measured on a live tenant by comparing the permission *sets*, not the counts:

```
ROLE_OWNER         51 permissions   not assignable
ROLE_TENANT_ADMIN  51 permissions   assignable   — identical to OWNER, 0 missing, 0 extra
ROLE_ACCOUNTANT    51 permissions   assignable   — identical to OWNER, 0 missing, 0 extra
ROLE_AUDITOR       20 permissions   assignable   — read-only
ROLE_EMPLOYEE       6 permissions   assignable   — self-scoped only
```

So "accountant" is not a narrower role than "admin": both are exactly the owner's access, including `tenant:user:write` — the permission to invite further people. The only thing `ROLE_OWNER` has that they do not is that it cannot be handed out. `reai_list_roles` computes that comparison against *your* tenant rather than repeating these numbers, so it stays true if the roles change.

Permission codes carry their scope as a prefix, and it is easy to miss: `self:…` reaches only the acting user's own records — their employee card, their expenses, their timesheets — while `tenant:…` reaches the company's. `ROLE_EMPLOYEE`'s six permissions are all `self:`.

The writes on these paths stay with `reai_request`, and are already gated: `POST /api/users` **invites** an email address and is classified as an external send, `PUT /api/users/{id}` changes what someone may do, and `DELETE` revokes access. Granting privilege is the one write in this API where what leaves the tenant is not data but authority.

**Leads are the company register, not a list of your records** — which is the thing to know before reading a result. `GET /api/leads` searches Brønnøysund and layers whatever lead state this tenant has on top: measured, every row of the default first page came back with `id: null` and `status: null`, i.e. companies nobody here has touched. `leadFilter` separates them (`all` / `saved` / `unsaved`).

Two addressing schemes exist and only one always works. An unsaved company has no id, so `GET /api/leads/null` answers `400 "Failed to convert 'id' with value: 'null'"` — the organisation number is on every row either way, which is why `reai_get_lead` takes that. And the envelope is `{items, page, hasPrevious, hasNext}` with **no total**, so "how many companies match" is not a question one call answers; the tool reports what it received and whether more exists rather than implying a figure. `pageSize` is capped at 200, above which the API answers a bare `400 "Validation failed"` naming no field, so the tool bounds it locally.

Nothing in these tools contacts anybody. Placing a call is a separate internal endpoint, already classified as an external send. `reai_log_lead_contact` *records* contact that already happened.

**Writing lead state: `null` means two opposite things depending on which endpoint you use.** `PATCH /api/leads/org/{orgNumber}` documents null as "leave unchanged" and does exactly that — measured, `{notes: null, email: null, phone: null, followUpAt: null}` against a lead holding all four returned `200` and changed nothing. The `PUT` setters (`/notes`, `/follow-up`, `/contact`) clear on the same null. So the endpoint that looks like the general update is the one that cannot clear a field, and the one that clears looks like a replacement. `reai_update_lead` presents a single rule — **omit to keep, null to clear** — and sends each field wherever that intent is honoured, then says which calls it made.

Four more, all measured on tenant 2783:

- **`PUT .../contact` needs both of its fields in the body, every time.** A single-key body does not have one behaviour: on a lead holding an email and a phone, `{phone: null}` sent on its own was a complete **no-op** — four trials out of four, re-read after four seconds, with the phone it named still in place — while the identical body sent straight after `PUT /notes` and `PUT /follow-up` behaved as a **full replacement** and cleared the omitted email. Nothing in the request accounted for the difference. `reai_update_lead` therefore reads the lead and carries over whichever field you did not mention, so the outcome is the same under either reading.
- **`PUT .../contact` answers `200` on an unsaved company and stores nothing.** Nearly every write materialises the lead row on first use — PATCH, `/status`, `/notes`, `/follow-up` and a contact event each turned `lead.id: null` into a real id. Contact left it null, so the email and phone were accepted and discarded. `reai_update_lead` saves the lead first before writing to a company nobody has touched.
- **A status cannot be unset once set**, and the spec claims otherwise: `PatchLeadReq.status` says to clear it via `PUT /status` with an explicit null, which answers `400 "Validation failed"` with the old status still in place. `active` ↔ `disqualified`, or delete the lead. Passing null is refused locally with that explanation rather than forwarded.
- **`convert` is addressable by id only** — the `/org/{orgNumber}` form answers `404 "No static resource"` — so an unsaved company cannot be converted until it has been saved. `reai_convert_lead` does that, then reads the new customer id back from the lead's `convertedCustomerId`, because the convert response body is the *company* record, not the customer. Converting twice is harmless: a repeat call, and a fresh lead for an org that already has a customer, each returned `200` without creating a second one.

Undoing a conversion has an order, and it is not the obvious one: **delete the lead first, the customer second.** Deleting the customer while the converted lead still points at it *archives* it instead, reported as `"it had transactions"` — on a customer minutes old with no ledger entry, no order and no invoice, where the lead reference is the transaction. With the lead gone, the same customer deletes outright, so nothing is permanently stuck; the wrong order just leaves an archived counterparty behind.

Deleting a lead is `destructive` in the sense that matters: contact events have **no delete of their own**, so `reai_delete_lead` is the only way to remove one and it takes the notes and every other event with it. A customer created by conversion survives — deleting the lead only forgets where it came from.

Projects are the obvious omission here, and deliberate: the Project module is disabled on every ReAI tenant this repo can reach, so `GET /api/projects` answers `403 "Project module is disabled"` and nothing about the success path could be verified. `reai_list_postings` and `reai_general_ledger` still take a `projectId` for tenants that have the module — you just have to find the id through `reai_request`.

### Fixed assets
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_assets` · `reai_get_asset` | The fixed-asset register (anleggsmidler): what is capitalised, on which balance-sheet account, and how it depreciates | read |
| `reai_create_asset` | Add an asset and its depreciation schedule. Posts **no voucher** — the register entry and the acquisition booking are separate | **irreversible** |
| `reai_set_asset_depreciation` | Replace the method and useful life. Changes every future depreciation posting | **irreversible** |
| `reai_write_off_asset` | Remove the remaining carrying value — the accounting act for something scrapped, lost or sold | **irreversible** |
| `reai_delete_asset` | Delete the record. Refused with **409** while a voucher references the asset — the spec's "deleted or reversed" does not happen | **irreversible** |

What each of these does was measured rather than read off the spec, and the spec turned out to be wrong about the most consequential one. Its DELETE description says a linked acquisition voucher is *"deleted when possible or reversed when accounting history must be retained"*. It is neither: with a posted voucher referencing the asset, the call answers `409 Asset with id N is used in existing vouchers and cannot be deleted` and changes nothing. That is the safer behaviour — there is no path here that quietly puts a counter-entry in your ledger.

Create, set-depreciation and write-off post **nothing** on an asset with no accounting history. They stay irreversible because `/api/assets` has always been classified that way and because write-off on an asset carrying real value could not be produced — this classifier fails closed on what it has not seen, and *not* because of any depreciation-posting mechanism, since no operation in this API posts depreciation at all.

### Subscriptions
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_subscriptions` · `reai_get_subscription` | What bills whom, how often, and whether it goes out on its own. The list calls out how many bill **automatically** | read |
| `reai_subscription_billing_history` | What a subscription has already produced. Nothing stops you billing the same period twice — this is how you check | read |
| `reai_create_subscription` | Set one up. Created **active** — what keeps a new one harmless is `automaticBillingGeneration: false`, not its newness | reversible |
| `reai_update_subscription` | Change one thing and keep the rest, including the lines. It does **not** disarm anything | reversible |
| `reai_activate_subscription` | Restart a stopped subscription. Reads it first and refuses, when external sending is off, to re-arm one that invoices on its own | **irreversible** |
| `reai_deactivate_subscription` | Stop it producing anything further. Undoing a standing risk, so available in the default mode | reversible |
| `reai_generate_subscription_billing` | Bill every DUE period now — a backdated subscription produced eight orders from one call. Reports the counts the API returns | **irreversible** + external send |
| `reai_delete_subscription` | Remove one that has never billed. One that has is refused with 409 — deactivate it instead | reversible |

`reai_update_subscription` reads, maps and merges rather than passing a body through, because echoing the GET back does not work: the response puts the lines under `lines` and the request wants `subscriptionLines`, a response line carries eleven fields where the request accepts eight, and a service recipient reads back as `companyName` and writes as `name`. Measured — a `PUT` carrying the eight required fields and one line answered `200` and left `invoiceEmail`, `invoiceComment` and `internalComment` all null with the second line gone. Mapped properly the round-trip is lossless, discounts included. It deliberately does **not** disarm: `outputMode`, `automaticBillingGeneration` and `sendEhf` are carried over, so an ordinary edit leaves a self-invoicing subscription self-invoicing, and the tool says so in its result.

Three fields decide whether a subscription reaches a customer on its own: `outputMode: "create_invoice"`, `automaticBillingGeneration`, and `sendEhf`. Together they are a machine that invoices real people while nobody is looking, so a body carrying any of them is treated as irreversible **and** as an external send — needing `REAI_WRITE_MODE=full` *and* `REAI_ALLOW_EXTERNAL_SEND`, because `full` alone does not lift the second. A subscription that produces a draft order and bills on request needs neither, and stays usable in the default mode.

`POST /api/subscriptions/generate-due` is deliberately **not** curated. It bills every due subscription in one call — the operation an agent would reach for to "catch up billing", and the one where a mistake is widest. It stays available through `reai_request`, where the refusal names what it is.

### Warehouses
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_warehouses` · `reai_get_warehouse` | The warehouses stock is held in. `archived` **selects** which set you get — no call returns both | read |
| `reai_get_warehouse_inventory` | Stock on hand per variant, with the two totals already computed. Quantities can be **negative** | read |
| `reai_create_warehouse` · `reai_rename_warehouse` | A name is the only field this resource has. Names are not unique, so identify one by id | reversible |
| `reai_delete_warehouse` | Deletes when nothing is on hand, **archives** when something is — the response says which | reversible |
| `reai_adjust_inventory` | Move stock in or out. A delta, not a new total. Posts **no voucher** and cannot be undone | **irreversible** |

Measured against the live API, and the sharpest edge here fails silently. `variantId` is optional in the schema and **required by this tool**: omitting it answers `200` with a real `transactionId` and moves **no stock at all** — four consecutive `+3` adjustments left `quantityOnHand` at 0. Nothing that can hold stock is exempt, because the API refuses a stock product with no variants, so requiring the field removes the failure mode rather than detecting it. The field to send is `variantId`; a variant in the product response is keyed `variantId`, not `id`, which is exactly how this was hit.

Two checks sit either side of the write. Before: the variant must be one of the warehouse's stock lines, which also supplies the quantity to measure against — a variant the warehouse does not track is refused with the valid ones listed, and nothing is written. After: the API echoes the variant it acted on, and a **null echo against a variant that was sent** is the no-op signature. That second check needs nothing from the pre-read, so it still holds when the inventory response cannot be read or matched.

Three more that the spec does not say. `occurredAt` is `date-time` and rejects a bare date with `400 "Failed to read request"` naming no field — this tool accepts `yyyy-MM-dd` and completes it. Stock goes **negative** without complaint: `-10` against 4 on hand gives `-6` and a stock value of `-600`. And an adjustment posts **no voucher** — the count never moved off 0 across every adjustment measured — so stock value never reaches the ledger, while no route lists or deletes a stock transaction, leaving an opposite adjustment as the only correction.

The delete is worth reading the response of: a warehouse holding 2 units was **archived**, kept its stock and vanished from the default list, while one whose adjustments netted back to zero was deleted outright. The trigger is current stock, not history — and since archived warehouses are only returned by `archived=true`, stock can sit somewhere the default list does not show.

### Agreements
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_agreements` · `reai_get_agreement` | Leases, employment contracts, purchase and service agreements, with signing status. The terms are **nested** under a sub-object named for the template | read |
| `reai_list_agreement_signers` | Who was asked to sign and what happened since. Reading sends nothing; asking does | read |
| `reai_update_agreement` | Change terms **without destroying the rest** — see below | **irreversible** |
| `reai_delete_agreement` | Remove an agreement and its document. Answers `204`, no outcome field, no archive branch | reversible |

### Renaming something must not erase where money goes
| Tool | Purpose | Risk |
|---|---|---|
| `reai_update_company_bank` | Change a company account — label, currency, SWIFT, or the number itself — **without emptying `bban`** | **irreversible** |
| `reai_list_creditors` · `reai_update_creditor` | Loan counterparties the company owes, and the account repayments go to | read / **irreversible** |
| `reai_set_supplier_address` | Change part of a supplier's address without dropping the postcode | reversible |

Each of these wraps a PUT that replaces rather than patches, on a record carrying a payment destination that the schema does not require — so the body a rename produces is accepted and empties the account. Measured: `PUT /api/company-banks/{id} {name, countryCode, currency}` → `200`, `bban` emptied; `PUT /api/creditors/{id} {name}` → `200`, `bankAccountNumber` null. All three read the record first and merge. For the company bank the question that matters is not whether the six settable fields survive being written back — they are what is sent — but whether omitting the other twelve resets them. Measured: after a rename, `manual`, `active`, `providerType`, `eligibleForPaymentCreation` and the rest came back unchanged, and only the derived `displayName` moved. `defaultForOutgoingPayment` was false throughout and no endpoint sets it, so that one is unverified.

The two account-carrying ones need `REAI_WRITE_MODE=full`, because the raw PUT can destroy a destination and a curated tool must not be a softer route to it. `reai_update_company_bank` additionally **refuses** to clear `bban` even when asked — an account with no number cannot be used for payments or reconciliation, so deleting the account is the honest way to retire it.

`reai_update_agreement` needs `REAI_WRITE_MODE=full`, and the reason is worth stating: not because this tool is dangerous — it is the safe way to do the job — but because the underlying `PUT` replaces the record, so the raw call is classified irreversible and a curated tool may not be the soft route around a gate the escape hatch is subject to. The same argument this repo already made for reconciliation rules.

`reai_update_agreement` exists because the underlying call does the opposite. `PUT` on an agreement is a **full replacement**: measured on a live lease, a `PUT` carrying only the landlord's name left `monthlyRent`, `tenantName`, `depositAmount`, `depositAccountNumber` and the house rules all null — and `GET /pdf` still returned `200`, producing a document that looks like a contract with nothing in it. The tool reads the agreement, merges your changes over the existing terms and writes the whole thing back; that the round-trip is lossless was verified rather than assumed, by writing a 78-key sub-object back verbatim and confirming no field changed.

Three more measured surprises. **Nothing is required** — `POST /api/agreements/rent-agreement {}` answers `201` with a draft in which every term is null. The identifier is **`agreementId`, not `id`**. And some fields the schema types as plain strings are validated as enums the spec never lists; the API names the allowed set in its `400` (`leaseDurationType` is `indefinite | fixed_standard | fixed_special_reason`, `depositType` is `deposit | guarantee`).

The five **create** endpoints are deliberately not curated: their bodies run to 78 fields for a lease (and 17–31 for the others) that the spec documents properly, `reai_describe_endpoint` shows them, and every trap above now reaches a `reai_request` caller as a quirk. The three **signing** endpoints are not curated either — they email a counterparty, so they need `REAI_ALLOW_EXTERNAL_SEND` and are better reached through `reai_request`, where the refusal names what would have gone out. The PDF is a download: `reai_request GET /api/agreements/{id}/pdf` with `binary=true`.

What the API does **not** check: Norwegian tenancy law caps a deposit at six months' rent (husleieloven § 3-5), and § 9-3's three-year minimum for a fixed-term *residential* lease means a shorter one counts as indefinite unless a statutory ground applies — not that it is rejected. A deposit of 9 999 999 against a rent of 10 000 was accepted, and so was a four-month fixed term with no reason. This server does not enforce either: that would be inventing law, on a template that also covers storage and other non-residential lets. The tools say so instead.

### Payroll
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_salary_runs` · `reai_get_salary_run` | Which periods have been run, what each pays, and each employee's wage lines | read |
| `reai_create_salary_run` | Open a run for a period. Arrives as a **draft** — measured, it posts no voucher | **irreversible** |
| `reai_add_salary_line` · `reai_update_salary_line` · `reai_delete_salary_line` | Manual wage lines on a draft run | **irreversible** |
| `reai_delete_salary_run` | Delete a run. **Refuses** anything not still `under_process` | **irreversible** |

**Completing a run is deliberately not a tool.** `POST /api/salary-payments/{id}/complete` does all of this in one call, by its own description: posts the voucher, creates payslips, creates *one employee payment per payable employee* against a company bank, and starts the **A-melding submission to Skatteetaten** — after which withholding tax and employer contributions are registered automatically. It is classified irreversible **and** external, so it needs `REAI_WRITE_MODE=full` *and* `REAI_ALLOW_EXTERNAL_SEND`, and it stays on `reai_request` for the same reason `subscriptions/generate-due` does: it is what an agent reaches for to "finish payroll", and it is where a mistake is widest. Its `manualPayment` flag is the same dual-mode trap as the supplier payment.

Three things measured on a live tenant. A run **cannot be created** until every included employee has a bank account — `400 "Følgende ansatte mangler bankkonto"`, naming them, and employees are created without one. Creating a run **posts nothing**: the ledger count did not move and `voucherId` stayed null, so a draft is safe to delete. And **half the gross was withheld** — a 5000 line produced 2500 payable at `taxDeductionRate: 50`, which is what this API applies when there is no tax card, so a payable amount is not take-home.

The wage-line endpoints are asymmetric in a way worth knowing: create **requires** `employeeId` and update **rejects** it (measured, `400 "Unknown field: employeeId"`), so a line cannot be moved between employees. The update is also a **full replacement** — a raw `PUT` omitting `comment` clears it, measured — so `reai_update_salary_line` reads the line and carries over what you do not mention: omit to keep, pass `null` to clear. Lines derived from expense postings cannot be edited at all — which is also why a fresh run is not empty, and why adding pay to one without reading it first is how the same wages go out twice.

Anything not listed — leads, projects, opening balances, annual accounts — is reachable through `reai_search_endpoints` + `reai_request`, and carries its known quirks automatically.

If 145 tools is more than your client wants to see, narrow it with `REAI_TOOLSETS` — list **only** the groups you want:

```
REAI_TOOLSETS=bookkeeping          # 19 tools
REAI_TOOLSETS=bookkeeping,sales    # 49 tools
REAI_TOOLSETS=purchase             # 33 tools
REAI_TOOLSETS=organisation         # 25 tools
REAI_TOOLSETS=assets               # 13 tools
REAI_TOOLSETS=subscriptions        # 16 tools
REAI_TOOLSETS=warehouses           # 14 tools
REAI_TOOLSETS=agreements           # 12 tools
REAI_TOOLSETS=salary               # 14 tools
REAI_TOOLSETS=reference            # 11 tools
(unset)                            # all 145
```

Valid groups are `bookkeeping`, `sales`, `purchase`, `bank`, `organisation`, `assets`, `subscriptions`, `warehouses`, `agreements`, `salary` and `reference`; listing all eleven is the same as leaving it unset. Orientation and discovery are never disabled, so a narrowed server still reaches every endpoint through `reai_search_endpoints` + `reai_request`.

## API quirks worth knowing

Discovery works in Norwegian, which for this API is not a nicety. Measured on one set of 31 realistic queries — 21 Norwegian, 10 English — before and after: **14 found before, 31 after**, top-three 12 → 28, and nothing ranked worse. `lønnskjøring` returned zero results while `lonn` was already a synonym; *"hvor mye lager har vi"* returned the chart of accounts.

Two causes. Most of the everyday vocabulary was missing. And Norwegian glues nouns together, so the word a user types is often a compound whose meaning lives in one half — `lønn+kjøring`, `vare+lager`, `lager+beholdning` — which no plural or diacritic rule reaches. Compound stems are matched at a word boundary with at least two characters left for the other element, because an unanchored search found `lønn` inside `kolonner` and `belønning`, and `lager` inside `slager`; `lønnsomhet` shares a root rather than merely containing one and is listed as an exception. `test/discovery-norwegian.test.mjs` holds the measurement, asserts English **ranks** rather than mere presence, and asserts that word order does not change the answer.

A third cause, found later: the table was **all nouns**. The API has 65 segments hanging off a resource instance — `/{id}/approve`, `/{id}/deliver`, `/{id}/depreciation`, `/{id}/close` — and not one of them had a Norwegian verb, so *"godkjenn utlegg"* ranked `/api/expenses` first and the endpoint that approves the claim fifth. The action vocabulary is enumerated from those segments rather than from any benchmark's phrasing, and covers both the imperative and the verbal noun, since a Norwegian query uses either.

**Three corpora, each measured once before being tuned against, and each retired to a regression floor afterwards** — because a benchmark you have read the failures of is no longer measuring anything:

| corpus | first measurement | after fixing only the queries that returned NOTHING | now |
|---|---|---|---|
| first (`discovery-norwegian`) | 17/45 | — | **39/41** top-3 |
| second (`FRESH`) | 19/28 | 23/28 | **26/28** |
| third (`EVERYDAY`) | 16/28 | 18/28 | **20/27**, 23 within the top ten |

The action words alone moved the second corpus 23 → 25. What moved all three was routing them through the tables that decide **method**: the vocabulary expanded to the right path segment and then lost to three `GET`s, because nothing in the query said a write was wanted. *"aktiver abonnement"* ranked `/activate` fifth; it ranks first now. A change that lifts the corpus you tuned against **and** the two you did not is the shape a general improvement has.

The rule held across all three: a query that returns **nothing** strands an agent and is worth fixing; a query that returns the right endpoint at rank five is not worth tuning for. Five of the third corpus's thirty targets named endpoints that do not exist — the fourth time in this work that a "ranking failure" was really a wrong assumption about the API.

An accounting API has more sharp edges than its schema admits, and most of what follows was learned from a rejected request rather than from reading the spec. Rather than leave that knowledge in commit messages, it lives in [`src/reai/quirks.ts`](src/reai/quirks.ts) as **105 quirks keyed to the operations they affect** — so they surface automatically in `reai_describe_endpoint` and `reai_search_endpoints`, including for the ~252 operations no curated tool covers.

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

#### Two posting fields that are not optional, whatever they are called

`reai_create_voucher` has always accepted `subAccountId` and `companyBankId`, described as "Optional general sub-account id" and "Link the posting to a company bank account". Measured, both are **conditionally mandatory**, and the API's refusal is a bare Norwegian `400` naming only the line:

```
POST /api/vouchers  → 400 "Linje 1: Konto 1320 må posteres med underkonto."
POST /api/vouchers  → 400 "Linje 1: Konto 1920 må posteres med bankkonto."
```

An account that has **any** sub-account requires one on every posting — even when the only one is called `Default`, which is the case on most of them. So the field was documented as optional precisely for the accounts where leaving it out cannot work, and there was no tool to discover a valid id with.

`reai_create_voucher` now reads the sub-account list once, before sending, and refuses with the actual choices:

```
Nothing was sent. 1 posting(s) are on an account that requires a general sub-account (underkonto),
and none was given:

  line 1, account 1320 → subAccountId 6231 (Default)
```

A failed lookup does **not** block the write. This document has understated requirements before, and refusing a voucher because a helper read failed would be the check doing harm — the API stays the authority, and its `400` is enriched by the quirk registry either way. The bank rule is documented rather than pre-checked, because nothing in the company-bank response says which ledger account each bank belongs to, so which accounts demand it cannot be established locally.

Sub-accounts are also **permanent**: `DELETE /api/general-sub-accounts/{id}` answers `405`, and `PUT` accepts only `name` (`accountNumber` answers `400 "Unknown field: accountNumber"`), so one cannot be removed or moved. Adding the *first* sub-account to an account changes that account's rules for everyone posting to it, and `reai_create_sub_account` says so when that is what you are about to do.

Where a curated tool exists, it enforces what it can locally so you get an explanation instead of a `400`: `reai_create_voucher` checks the debit/credit balance and reports the exact imbalance, `reai_create_supplier_invoice` checks cost-line signs against the document type, and `reai_apply_reconciliation_rules` refuses to run without a bounded period.

A test asserts every quirk still matches a real operation in the spec, so they can't quietly rot as the API changes.

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

### Reference data and company state
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_countries` | The country codes this API accepts, each with its default `currencyCode`. `query` filters **locally** — the endpoint takes no parameters. Needs no tenant | read |
| `reai_list_currencies` | The currency codes this API accepts. Same local filter, also tenant-free | read |
| `reai_get_opening_balance` | The ledger position the books start from — returned as a **voucher**, which is why its `DELETE` can reverse — or a plain answer that none is recorded | read |
| `reai_get_annual_accounts` | Whether a submission record exists for a fiscal year, and its `status` — the API's states are `incomplete`, `complete`, `signing`, `signed` and `submitted_in_other_system`, so existing is not the same as filed | read |

**Shape is not membership**, which is why the code lists are worth a tool. Every `countryCode` argument on this server checks that a value is two uppercase letters and every `currencyCode` that it is three, because a pattern is all the spec documents. `UK` passes that check and is not a code this API takes — the United Kingdom is `GB` — so the local validation says yes and the API says no, which is the worst division of labour available. These two endpoints are the actual lists, and nothing pointed at them before.

Both **do** document their response, and the live API agrees: `CountryRes` is `{code, name, currencyCode}` and `CurrencyRes` is `{code, name}`, confirmed against 170 and 129 real rows. An earlier draft of this section claimed the opposite on a miscount worth recording — **386 of the 430 operations here declare a 2xx schema**, but 368 declare it under the wildcard content type rather than `application/json`, and counting only `application/json` gives 12. What is true is that the spec **index** carries no response shapes at all, so `reai_describe_endpoint` cannot yet tell you what an endpoint returns. That is a gap in this server, not in the spec.

**Two 404s that are answers, not failures.** `GET /api/opening-balances` answers `404 "Opening balance not found"` and `GET /api/annual-accounts/{year}` answers `404 "No annual-accounts submission exists"` when there is nothing recorded — measured on both test tenants. A 404 from a collection-shaped path is otherwise indistinguishable from a wrong path, a wrong tenant, or a switched-off module, and this server has watched all three conclusions get drawn from one. Both tools report the real answer, and *only* for the documented message: a 403, a 401 or a 500 still fails, because a tool that calls every error "nothing recorded" will report an outage as a fact about someone's books.

Both 404 conversions turn on the typed error's `status`, not on its message text: a gateway `500` relaying a downstream body can contain "HTTP 404" and the documented phrase together, and a text match would have called that outage an empty set of books. The country and currency lists need **no tenant** — the spec declares no `X-Tenant-Id` for either, so asking what codes exist works immediately after authentication.

Writing an opening balance is left to `reai_request` on purpose. It is ledger position, so setting one restates every comparative figure the books produce, and `DELETE /api/opening-balances` is documented as **"delete OR reverse"** — the family this repo has been caught by five times, where a reversal *posts* rather than removes. Neither test tenant has an opening balance to watch those endpoints on, so no curated tool here claims to know what they do.

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

The production tree is clean: `npm audit --omit=dev` reports nothing, and CI enforces that at `--audit-level=moderate` as a blocking step. Two advisories arrived through `@modelcontextprotocol/sdk` and both are resolved by `package.json` overrides — `fast-uri` pinned to 3.1.5 (HIGH, host confusion via a backslash authority introducer) and `hono` to 4.12.34 (MODERATE, ReDoS in CORS middleware).

Both are **exact pins, not ranges**, and that is deliberate (`fast-uri` was a caret until this bit — see below). This project installs under a 7-day minimum-release-age policy, which is a supply-chain defence: a version published minutes ago has had no time for a compromised publish to be noticed. Landing a fix that is still inside that window needs `npm install --min-release-age=0` — and with the age check off, a caret range takes whatever is newest. `^4.12.34` resolved to `4.13.1`, published four hours earlier, which is precisely the exposure the policy guards against. Pinning exactly gets the fix and nothing else.

The bypass is also **narrow**, and getting that right took two attempts. Deleting the lockfile and reinstalling under the flag re-resolves *everything*, so `@hono/node-server`, `express-rate-limit`, `ip-address` and `jose` were all upgraded without the age check — a far wider exception than the one being made. Starting from the existing lockfile and adding only the override changes exactly one line. And it is one-time: `npm ci` installs from the lockfile without resolving, so CI never runs under a relaxed policy.


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
