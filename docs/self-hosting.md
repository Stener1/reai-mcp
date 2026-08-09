# Self-hosting as a remote connector

The same server also speaks MCP over Streamable HTTP, so it can be added as a **custom connector** rather than spawned locally. There is no hosted instance — you run your own, which means your ReAI token never leaves infrastructure you control.

It implements OAuth 2.1 as its own authorization server: dynamic client registration (RFC 7591), authorization code + PKCE (S256 only), resource metadata (RFC 9728), and refresh tokens. ReAI itself uses static API tokens and has no OAuth endpoints, so the flow bridges the two — the user pastes a ReAI token on the consent page, the server verifies it against `GET /api/me`, and then mints its own tokens carrying it.

## Docker

```bash
docker build -t reai-mcp .
docker run -p 8080:8080 \
  -e REAI_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" \
  -e PUBLIC_URL=https://reai-mcp.example.com \
  -e REAI_WRITE_MODE=reversible \
  reai-mcp
```

Then add `https://reai-mcp.example.com/mcp` as a custom connector. No `REAI_USER_API_TOKEN` is needed in remote mode — each user supplies their own during authorization.

## Google Cloud Run

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

## Why there is no database

Access tokens are **sealed**: the user's ReAI token is encrypted into the token itself with AES-256-GCM, along with the tenant and write mode chosen at authorization time. Any instance can therefore serve any request with no shared session store — which is what makes a scale-to-zero, multi-instance deployment practical.

The sealed write mode is not the last word on it. Every request applies the narrower of that and the operator's *current* `REAI_WRITE_MODE`, so redeploying with a tighter ceiling binds tokens that were already issued — [safety.md](safety.md#the-remote-write-ceiling-is-the-narrower-of-two) has both directions of that rule and why each matters.

The trade-offs are worth stating plainly:

- **`REAI_ENCRYPTION_KEY` is required in production.** Without it a random key is generated at startup, so every existing authorization breaks on restart, and separate instances reject each other's tokens. The server warns loudly.
- **Individual tokens cannot be revoked** before they expire (8 hours). Rotating `REAI_ENCRYPTION_KEY` invalidates all of them at once, which is the intended remedy.
- **Treat the key like a credential.** It decrypts every user's ReAI token. Use Secret Manager, not an env var in source control.

## Restrict who can register a client

Client registration is open, because that is what MCP clients expect. On a public deployment that has a consequence worth understanding: anyone can register a client with their own callback URL and send someone a link to *your* server's genuine consent page, on your domain, with valid TLS — then collect the ReAI token that gets pasted there.

The consent page pushes back on this. It names the **redirect host** as the party requesting access, treats the client's self-reported name as unverified, and shows the full callback URL next to a warning that whoever controls it gains full access to the books. But the real fix is to say which clients you actually use:

```
REAI_ALLOWED_REDIRECT_HOSTS=claude.ai
```

Unknown callback hosts are then refused at registration and never reach the consent page. Loopback stays allowed so local clients and MCP Inspector keep working.

## One tenant per authorization

A user-scoped ReAI token is what makes this server worth running for an accountant — one connection
reaching every client company. The safety consequence cuts the other way, which is why an
authorization binds one company: a token that reaches thirty client companies should not hand an agent
all thirty because it was asked about one. That applies to what is *disclosed* as well as what can be
addressed — on a bound connection `reai_whoami` lists only the bound company, and says the others
exist without naming them.

The company selected during authorization is a **boundary, not a default**. A grant bound to tenant 4711 cannot address any other tenant, even though the underlying ReAI token may unlock dozens — relevant for an accountant whose token reaches every client company. Tools that pass a different `tenantId`, and `reai_use_tenant`, are both refused with an explanation. To work in another company, re-authorize and pick it.

An authorization with **no** bound company is refused outright, at every point it could be used — issuing, redeeming and refreshing. Early builds could mint one when `GET /api/me` returned no companies, and such a grant had no tenant boundary at all. If you authorized before this and see `invalid_token` with "not bound to a company", remove and re-add the connector.

**Worth being precise about what this rests on**, because three different claims are easy to run together. Measured with a user-scoped token:

- **Selection is real.** `GET /api/chart-of-accounts` under two of the token's companies returns different payloads, so `X-Tenant-Id` chooses the company.
- **Isolation is real.** The same call with an id the token does not reach (`99999999`, `1`) returns `403`, so the API refuses a company the token has no access to.
- **The binding is not the API's.** A grant narrowed to one company is enforced *here* — ReAI sees the underlying user token, which legitimately reaches all of them, so it cannot know the authorization was scoped. Treating that as API-enforced would be a false assurance.

For a *tenant-scoped* token none of the first two applies: the header is ignored, any id returns that one company's data, and a request that appears to reach elsewhere has not. `scripts/check-token.sh` reports which case a token is in.

So the binding is exactly as strong as this process, which is the right architecture — the token is the user's own, and they were never prevented from calling ReAI directly — but do not read it as the API sandboxing them.

## Request limits

The MCP endpoint enforces two ceilings, both well above any real tool call:

| Limit | Value | Why |
|---|---|---|
| Request body | 8 MB | The transport otherwise parses an unbounded body: a 400 MB POST exhausted the heap of a 512 MiB container, taking every other in-flight request with it. Over the limit is answered `413` and the connection is closed — but see the note below, because a *far* oversized body gets no response at all |
| JSON-RPC batch | 50 messages | Every entry in a batch is dispatched concurrently, so 1000 of them meant 1000 simultaneous ReAI calls. The write policy is applied per call and never sees the aggregate, which in `full` mode made one HTTP request a route to thousands of postings |

**A `413` is not guaranteed.** To answer at all, the server has to finish reading the body it is rejecting: closing while data is still arriving makes the OS send `RST`, which discards the response the client has not read yet. So an oversized body is drained first — bounded at 32 MB and 5 seconds — and only then answered. Past either bound the request is destroyed with **no response**, which the client sees as a connection reset. The 400 MB case above is exactly that. Worth knowing before diagnosing a silent reset as a network fault.

`GET /mcp` answers **405**. A standalone SSE stream exists to carry server-initiated messages, which requires a session; this server is stateless by design — a fresh MCP server per request — so nothing could ever be sent on one. The spec permits either SSE or 405 here, and 405 is the honest answer. No client capability is lost: the server runs with `enableJsonResponse`, so a POST is answered with a single JSON response rather than an event stream, and there is nothing a standalone stream would have carried.

## Verify a deployment

```bash
REAI_USER_API_TOKEN=your-token node scripts/smoke-http.mjs --url https://reai-mcp.example.com
```

This walks the entire OAuth flow the way a real client does — discovery, registration, PKCE authorization, token exchange, refresh — then connects over Streamable HTTP and calls read-only tools. It also asserts the negative cases: that PKCE is mandatory, that an authorization code cannot be replayed, that a forged token is refused, and that the ReAI token is never echoed back.

## Remote configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `PUBLIC_URL` | inferred from `Host` | **Set in production.** Published in OAuth metadata, so it must match what clients connect to. Must be a bare origin — a path, query or fragment is rejected at startup. `REAI_PUBLIC_URL` is accepted as an alias |
| `REAI_ENCRYPTION_KEY` | random per boot | **Set in production.** 32 bytes, base64 or hex. Seals access tokens |
| `REAI_ALLOWED_HOSTS` | — | Comma-separated hostnames to accept; enables DNS-rebinding protection and pins the advertised OAuth issuer |
| `REAI_ALLOWED_REDIRECT_HOSTS` | any https host | Comma-separated hosts allowed as OAuth redirect targets. **Recommended on a public deployment** — see [Restrict who can register a client](#restrict-who-can-register-a-client). Loopback is always permitted |
| `REAI_ENABLE_UI` | off | Expose the bank-reconciliation pairing view as an MCP Apps resource. Only useful for a host that supports them; see [The one UI surface](tools.md#the-one-ui-surface) |
| `REAI_ALLOW_TOKEN_PASSTHROUGH` | off | Accept a raw ReAI token in the `Authorization` header, skipping OAuth. Convenient behind Tailscale or IAP; **anyone who reaches the URL acts as whoever's token they present**, so never enable it on a public deployment |
