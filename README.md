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

- **145 tools**: 138 curated across eleven accounting domains, plus 7 always-on — orientation, and a discovery escape hatch that reaches all 321 public API operations.
- **Two independent safety switches.** One bounds what can be undone in the books; the other decides whether anything may leave the tenant at all. Both default to the cautious setting, and the first does not lift the second.
- **106 measured API quirks** keyed to the operations they affect, so `reai_describe_endpoint` warns you before the API rejects you.
- **Discovery works in Norwegian** — *"lønnskjøring"*, *"send fakturaen"* — measured against three query corpora.
- **Self-hosted, and deliberately not on npm.** Run it as local stdio, or deploy your own Streamable HTTP connector with OAuth 2.1. Nothing is published to the registry until it has been seen working against real books, so there is no `npx reai-mcp` to copy.

Full reference material lives in [`docs/`](docs/): [the write policy in detail](docs/safety.md), [measured tool behaviour by domain](docs/tools.md), [the quirk registry](docs/api-quirks.md), [discovery](docs/discovery.md), [self-hosting](docs/self-hosting.md) and [development](docs/development.md).

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

On a remote deployment the ceiling is **composed rather than chosen once**. A grant is sealed at
authorization time carrying the mode the user picked on the consent page, and every request applies
whichever of that and the server's *current* `REAI_WRITE_MODE` is narrower — so tightening the
deployment binds tokens that were already issued, and a permissive server never widens a grant
somebody deliberately narrowed:
[docs/safety.md](docs/safety.md#the-remote-write-ceiling-is-the-narrower-of-two).

Both switches sit on one path, and a curated tool is not a softer route to the API than the escape
hatch is — they converge on the same gates, in this order:

```
  curated tool (138) ---+
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

Two measured cases shaped that classification, and both are worth reading before running anything in
`full`. The first is a pair of endpoints: **a full replacement can erase where money goes by leaving
it out.** `PUT /api/company-banks/{id}` carrying `{name, countryCode, currency}` — which is what a
rename looks like — answers `200` and empties the account number its own customers pay into. Sweeping
the document turned up 31 public `PUT`s that can clear a documented field by omission, so
`reai_request` now refuses one rather than reporting it afterwards, and the curated tools read and
merge instead: [docs/safety.md](docs/safety.md#a-full-replacement-can-erase-where-money-goes-by-leaving-it-out).

The second is a field set rather than a pair of endpoints, and it has its own section.

### Changing where money goes is treated as irreversible

A few fields are ordinary master data as *records* and permanent as *consequences*. Undoing the edit is trivial; undoing what follows is not, because it happens later and through someone acting perfectly normally.

| Fields | Where | What happens later |
|---|---|---|
| `iban`, `bankAccountNumber`, `swiftCode`, `swiftBic`, `routingNumber`, `accountNumber`, `bban`, `rentAccountNumber`, `depositAccountNumber` | suppliers, customers, creditors, **employees**, supplier invoices (including `paymentDetails` nested inside them), invoice-reception documents, and **editing** an existing company bank or lease | Whoever pays that counterparty next — quite possibly a person clicking through the ReAI web UI weeks afterwards — sends money to whatever account is on file. On an employee it is their salary, paid on a schedule by machinery nobody re-reads each month. On a company bank it is your own customers who are redirected, and invoices already issued name that account. *Adding* a company bank stays ordinary work; repointing one does not |
| `invoiceEmail` | customers, orders, subscriptions | Every future invoice is delivered to that address. Not a payment — a disclosure — so the refusal says so, and tells you to confirm the address through a channel you already trust rather than to check bank details. **Emptying one counts too, in a partial body**: `invoiceEmail: ""` through a `PATCH` or through any curated tool stops invoices reaching the address someone chose, and needs `full` mode exactly as setting one does. Measured on `PATCH /api/customers/{id}`: `""` clears the address, `null` is the documented no-op, `" "` is a `400` — so the form that empties a billing address is the one that looks like a typo, and `""` is also the schema's declared default. Not on a `POST`, where no stored address exists to redirect, and **not on a replacement `PUT`**, where an empty value cannot be told apart from faithfully carrying back an address that is already empty — the omission gate covers that case instead |

The field list is not path-specific: any of them reaching any of those paths escalates. An earlier version of this table split them up, which read as though `bban` mattered only on company banks.

So a call carrying one of those fields is classified **irreversible** and refused in the default mode, on the curated tools and through `reai_request` alike, even though the endpoint itself is otherwise reversible. Every other field on the same tool is unaffected: renaming a supplier still works in `reversible`. Adding a new company bank stays ordinary work; repointing an existing one does not.

Two of those entries, and a whole lease's worth of a third, were found by checking this table against the API rather than trusting it — employees were missing, which is the sharpest member of the class, and so were `swiftBic` and `routingNumber`. The process is now a test (`test/payment-routing.test.mjs`) that reads the OpenAPI document on every run and fails the build on a routing-shaped field name that is neither treated as a destination nor explicitly exempted with its evidence. What it found, why `accountNumber` cannot simply be escalated everywhere, and the one blind spot it does not cover are in [docs/safety.md](docs/safety.md#how-the-payment-destination-field-set-was-checked).

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

A user-scoped token is what makes this worth running for an accountant: one connection reaching every client company, with `reai_whoami` listing them and `reai_use_tenant` moving between them. `reai_whoami` reports what it can actually tell — that the token reaches one company or several — without guessing which kind it is, because `GET /api/me` has no field that distinguishes a tenant-scoped token from a user-scoped one belonging to a user with a single company. It also warns when the companies do not share a currency, and says to read the currency on each record rather than assume the company's: an invoice total is in the *invoice's* currency, which can differ again.

The safety consequence cuts the other way, which is why a remote connector binds one company at authorization time: a token that reaches thirty client companies should not hand an agent all thirty because it was asked about one. That applies to what is *disclosed* as well as what can be addressed — on a bound connection `reai_whoami` lists only the bound company, and says the others exist without naming them.

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

`subAccountId` and `companyBankId` are documented as optional and are in fact conditionally mandatory — an account with *any* general sub-account requires one on every posting, even when the only one is called `Default`. `reai_create_voucher` reads the list before sending and refuses with the valid ids named: [docs/api-quirks.md](docs/api-quirks.md#two-posting-fields-that-are-not-optional-whatever-they-are-called).

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

Leads are the one group here that is not a list of your own records: `GET /api/leads` searches the Brønnøysund company register and layers this tenant's state on top, so most rows come back with `id: null`. Writing that state has a `null` rule that reverses between two endpoints — the general-looking `PATCH` cannot clear a field and the replacement-looking `PUT` can — which is why `reai_update_lead` routes each field to whichever endpoint honours the intent: [docs/tools.md](docs/tools.md#sales-leads).

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
| `reai_reverse_expense` | Withdraw a claim. It is not deleted, and no visible field changes — see [the expense notes](docs/tools.md#purchase-expense-claims) | **irreversible** |
| `reai_create_supplier` · `reai_update_supplier` · `reai_delete_supplier` | Supplier master data. Changing bank details (`iban`, `bankAccountNumber`, `swiftCode`) escalates the call to irreversible — see [the rule](#changing-where-money-goes-is-treated-as-irreversible). The delete **archives** instead when the supplier has transactions | reversible |
| `reai_unarchive_supplier` | Bring an archived supplier back | reversible |
| `reai_create_supplier_invoice` | Register a supplier invoice directly | **irreversible** |
| `reai_register_supplier_invoice_payment` | Record paying a supplier | **irreversible** |

Expense claims are the other half of payroll — a salary run arrives pre-populated with wage lines derived from expense postings, so what is approved here is what gets paid out there. Their `status` field never says either "booked" or "reversed": a withdrawn claim still reads `approved` and still answers a `GET`, so `reai_get_expense` spends a filtered list call to find out. The whole state machine, driven end to end on a test tenant, is in [docs/tools.md](docs/tools.md#purchase-expense-claims).

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
| `reai_list_users` · `reai_get_user` | Who can reach the books, with roles and effective permissions — including people who have not accepted their invitation yet | read |
| `reai_list_roles` · `reai_list_permissions` | The roles this tenant can grant and what each actually carries, and the permission catalogue behind the codes | read |
| `reai_list_user_invitations` | Invitations sent and not yet accepted — standing access waiting to be claimed | read |

Two findings here are worth reading before granting anyone access or editing an employee. `ROLE_ACCOUNTANT` and `ROLE_TENANT_ADMIN` carry permission sets **identical** to the owner's, including the permission to invite further people — so "accountant" is not a narrower role than "admin". And `PATCH /api/employees/{id}` is a genuine partial update except for `employmentLines`, which replaces, so adding a raise the obvious way deletes the employment history. Both measured, in [docs/tools.md](docs/tools.md#organisation-roles-and-permissions) and [docs/tools.md](docs/tools.md#organisation-employees).

### Fixed assets
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_assets` · `reai_get_asset` | The fixed-asset register (anleggsmidler): what is capitalised, on which balance-sheet account, and how it depreciates | read |
| `reai_create_asset` | Add an asset and its depreciation schedule. Posts **no voucher** — the register entry and the acquisition booking are separate | **irreversible** |
| `reai_set_asset_depreciation` | Replace the method and useful life. Changes every future depreciation posting | **irreversible** |
| `reai_write_off_asset` | Remove the remaining carrying value — the accounting act for something scrapped, lost or sold | **irreversible** |
| `reai_delete_asset` | Delete the record. Refused with **409** while a voucher references the asset — the spec's "deleted or reversed" does not happen | **irreversible** |

The spec is wrong about the most consequential one: `DELETE` documents a linked acquisition voucher as "deleted when possible or reversed when accounting history must be retained", and it is neither — the call answers `409` and changes nothing, which is the safer behaviour. What create, set-depreciation and write-off actually post (nothing, in every case measured) is in [docs/tools.md](docs/tools.md#fixed-assets).

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

Three fields decide whether a subscription reaches a customer on its own — `outputMode: "create_invoice"`, `automaticBillingGeneration` and `sendEhf` — so a body carrying any of them needs `REAI_WRITE_MODE=full` **and** `REAI_ALLOW_EXTERNAL_SEND`. `reai_update_subscription` carries them over rather than quietly disarming them, and says so in its result; `POST /api/subscriptions/generate-due` is deliberately left to `reai_request`. Why the round-trip has to be mapped rather than echoed back: [docs/tools.md](docs/tools.md#subscriptions).

### Warehouses
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_warehouses` · `reai_get_warehouse` | The warehouses stock is held in. `archived` **selects** which set you get — no call returns both | read |
| `reai_get_warehouse_inventory` | Stock on hand per variant, with the two totals already computed. Quantities can be **negative** | read |
| `reai_create_warehouse` · `reai_rename_warehouse` | A name is the only field this resource has. Names are not unique, so identify one by id | reversible |
| `reai_delete_warehouse` | Deletes when nothing is on hand, **archives** when something is — the response says which | reversible |
| `reai_adjust_inventory` | Move stock in or out. A delta, not a new total. Posts **no voucher** and cannot be undone | **irreversible** |

The sharp edge here fails silently. `variantId` is optional in the schema and required by this tool: omitting it answers `200` with a real `transactionId` and moves no stock at all. `reai_adjust_inventory` checks the variant against the warehouse's stock lines before writing and checks the API's echo afterwards, because a null echo is the no-op signature: [docs/tools.md](docs/tools.md#warehouses).

### Agreements
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_agreements` · `reai_get_agreement` | Leases, employment contracts, purchase and service agreements, with signing status. The terms are **nested** under a sub-object named for the template | read |
| `reai_list_agreement_signers` | Who was asked to sign and what happened since. Reading sends nothing; asking does | read |
| `reai_update_agreement` | Change terms **without destroying the rest** — see the note below the table | **irreversible** |
| `reai_delete_agreement` | Remove an agreement and its document. Answers `204`, no outcome field, no archive branch | reversible |

`PUT` on an agreement is a **full replacement**: measured on a live lease, a body carrying only the landlord's name left `monthlyRent`, `tenantName`, `depositAmount`, `depositAccountNumber` and the house rules all null — while `GET /pdf` still returned `200`, producing a document that looks like a contract with nothing in it. `reai_update_agreement` reads, merges and writes the whole thing back. That, the enums the spec types as plain strings, and why the five create endpoints are deliberately not curated: [docs/tools.md](docs/tools.md#agreements).

### Renaming something must not erase where money goes
| Tool | Purpose | Risk |
|---|---|---|
| `reai_update_company_bank` | Change a company account — label, currency, SWIFT, or the number itself — **without emptying `bban`** | **irreversible** |
| `reai_list_creditors` · `reai_update_creditor` | Loan counterparties the company owes, and the account repayments go to | read / **irreversible** |
| `reai_set_supplier_address` | Change part of a supplier's address without dropping the postcode | reversible |

Each of these wraps a `PUT` that replaces rather than patches, on a record carrying a payment destination the schema does not require — so the body an ordinary rename produces is accepted and empties the account. All three read the record first and merge. The measurements, and why the two account-carrying ones need `REAI_WRITE_MODE=full` even though they are the *safe* way to do the job, are in [docs/safety.md](docs/safety.md#the-three-curated-merge-tools).

### Payroll
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_salary_runs` · `reai_get_salary_run` | Which periods have been run, what each pays, and each employee's wage lines | read |
| `reai_create_salary_run` | Open a run for a period. Arrives as a **draft** — measured, it posts no voucher | **irreversible** |
| `reai_add_salary_line` · `reai_update_salary_line` · `reai_delete_salary_line` | Manual wage lines on a draft run | **irreversible** |
| `reai_delete_salary_run` | Delete a run. **Refuses** anything not still `under_process` | **irreversible** |

**Completing a run is deliberately not a tool.** `POST /api/salary-payments/{id}/complete` posts the voucher, creates the payslips, creates one employee payment per payable employee, and starts the **A-melding submission to Skatteetaten** — all in one call. It is classified irreversible *and* external, so it needs both switches, and it stays on `reai_request` for the same reason `subscriptions/generate-due` does: it is what an agent reaches for to "finish payroll", and it is where a mistake is widest. Three things measured on a live run — including half the gross being withheld when there is no tax card — are in [docs/tools.md](docs/tools.md#payroll).

### Reference data and company state
| Tool | Purpose | Risk |
|---|---|---|
| `reai_list_countries` | The country codes this API accepts, each with its default `currencyCode`. `query` filters **locally** — the endpoint takes no parameters. Needs no tenant | read |
| `reai_list_currencies` | The currency codes this API accepts. Same local filter, also tenant-free | read |
| `reai_get_opening_balance` | The ledger position the books start from — returned as a **voucher**, which is why its `DELETE` can reverse — or a plain answer that none is recorded | read |
| `reai_get_annual_accounts` | Whether a submission record exists for a fiscal year, and its `status` — the API's states are `incomplete`, `complete`, `signing`, `signed` and `submitted_in_other_system`, so existing is not the same as filed | read |

**Shape is not membership.** Every `countryCode` argument here checks two uppercase letters and every `currencyCode` three, because a pattern is all the spec documents — so `UK` passes local validation and is refused by the API, which is the worst division of labour available. These two endpoints are the actual lists. Both `404`s above are answers rather than failures, and only for the documented message: [docs/tools.md](docs/tools.md#reference-data-and-company-state).

### Optional: the one UI surface

| Tool | Purpose | Risk |
|---|---|---|
| `reai_reconcile_ui` | Unmatched bank transactions and unmatched ledger postings for a month, side by side, so a person can pick which ones pair. Off unless `REAI_ENABLE_UI=1` | read |

It sits outside the default surface rather than inside it — every count in this README is the default 145, and `REAI_ENABLE_UI=1` registers a 146th tool. It is the only view here, and the bar it clears is narrow: the user has to make a selection the agent cannot make for them, over items that are painful to name in prose. It follows the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) shape, writes nothing, makes no external request, and declines to compute a difference it cannot establish. Why nothing else in this API clears that bar: [docs/tools.md](docs/tools.md#the-one-ui-surface).

Anything not listed — projects, timesheets, share investments, loans — is reachable through `reai_search_endpoints` + `reai_request`, and carries its known quirks automatically.

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
[above](#tools); `REAI_ENABLE_UI` under [the one UI surface](#optional-the-one-ui-surface); and the
variables that only matter to a remote deployment — `PORT`, `PUBLIC_URL`, `REAI_ENCRYPTION_KEY`,
`REAI_ALLOWED_HOSTS`, `REAI_ALLOWED_REDIRECT_HOSTS`, `REAI_ALLOW_TOKEN_PASSTHROUGH` — are in
[docs/self-hosting.md](docs/self-hosting.md#remote-configuration).

## API quirks worth knowing

Most of what this server knows about ReAI was learned from a rejected request rather than from
reading the spec. Rather than leave that in commit messages, it lives in
[`src/reai/quirks.ts`](src/reai/quirks.ts) as **106 quirks keyed to the operations they affect** — so
they surface automatically in `reai_describe_endpoint` and `reai_search_endpoints`, including for the
170 public operations no curated tool covers. A test asserts every quirk still matches a real
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
[docs/discovery.md](docs/discovery.md) has those numbers, the four causes that were fixed, and why the
stem gate is load-bearing rather than precautionary.

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

Docker, the Cloud Run script's three easy-to-get-wrong steps, why an authorization is bound to one
company and cannot address another, an honest account of what locking a public connector down can and
cannot achieve, how the OAuth flow is verified end to end, and the remote-only environment variables
are all in [docs/self-hosting.md](docs/self-hosting.md).

### Request limits

The MCP endpoint enforces two transport ceilings, both well above any real tool call: an **8 MB**
request body and a **50-message** JSON-RPC batch. Each has a surprise in it worth reading before
diagnosing one as a network fault — an oversized body does not reliably get a `413`, and `GET /mcp`
answers `405` on purpose, not by omission. The measurements behind both numbers, and both
explanations, are in [docs/self-hosting.md](docs/self-hosting.md#request-limits).

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
refreshing the pinned OpenAPI snapshot, and the live write harnesses — which refuse to run unless the
tenant is named in `REAI_WRITE_TEST_TENANTS`, because a `--tenant` flag is not consent.

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
