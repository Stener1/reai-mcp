#!/usr/bin/env node
/**
 * Remote entry point — serves MCP over Streamable HTTP so this can be added as a
 * hosted connector rather than only spawned locally over stdio.
 *
 * Routes:
 *   GET  /                                             human-readable status page
 *   GET  /health                                       liveness probe
 *   GET  /.well-known/oauth-protected-resource         RFC 9728
 *   GET  /.well-known/oauth-authorization-server       RFC 8414
 *   POST /register                                     RFC 7591 dynamic client registration
 *   GET|POST /authorize                                consent page and submission
 *   POST /token                                        authorization_code / refresh_token
 *   POST|GET|DELETE /mcp                               the MCP endpoint itself
 *
 * Each MCP request builds a server instance scoped to the caller's own grant, so
 * one deployment can serve several users without their credentials or their
 * chosen tenant leaking across requests.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { loadConfig, lastForwardedValue, type ServerConfig } from "./config.js";
import { WRITE_MODES, type WriteMode } from "./policy.js";
import { Sealer } from "./auth/crypto.js";
import {
  CodeReplayGuard,
  OAuthProvider,
  readBody,
  BodyTooLargeError,
  sendPayloadTooLarge,
  sendHtml,
  sendJson,
  ACCESS_TOKEN_TTL,
  type GrantPayload,
} from "./auth/oauth.js";
import { escapeHtml, renderErrorPage } from "./auth/pages.js";
import { ReaiConfigError } from "./reai/errors.js";

const MCP_PATH = "/mcp";

/**
 * The OAuth endpoints cap bodies at 512 KB, but /mcp handed the raw stream to the
 * SDK, which parses it with no limit at all. A single authenticated POST with a
 * 400 MB body OOM-killed a container started with --max-old-space-size=192, taking
 * every other in-flight request with it; the deploy script provisions 512 Mi across
 * three instances, so one caller could cycle all of them.
 *
 * 8 MB is far above any real tool call — the largest are voucher batches and
 * base64 attachments — and far below what threatens the heap.
 */
const MAX_MCP_BODY_BYTES = 8 * 1024 * 1024;

/**
 * JSON-RPC allows an array of messages, and the SDK dispatches them all at once with
 * no concurrency limit: 1000 tools/call entries in a 130 KB body produced 1000
 * simultaneous upstream ReAI calls in one second, and 20,000 saturated the event
 * loop for 49 seconds. The write policy is enforced per call, so it never sees the
 * aggregate — in `full` mode a single HTTP request could push thousands of postings
 * into real books. Agents batch a handful of calls at most.
 */
const MAX_MCP_BATCH = 50;

function log(message: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const sealer = Sealer.fromEnv(config.encryptionKey);
  // Created once per process: an OAuthProvider is per-request, so a guard held
  // on it would forget every redeemed code immediately.
  const replayGuard = new CodeReplayGuard();

  if (sealer.ephemeral) {
    log(
      "WARNING: REAI_ENCRYPTION_KEY is not set, so a random key was generated at startup. " +
        "Every existing connector authorization becomes invalid on restart, and the key is not " +
        "shared between instances — so a multi-instance deployment will reject its own tokens. " +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }

  const server = createServer((req, res) => {
    handle(req, res, config, sealer, replayGuard).catch((err: unknown) => {
      if (err instanceof BodyTooLargeError) {
        sendPayloadTooLarge(res, err.message);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      log(`unhandled error on ${req.method} ${req.url}: ${message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      else res.end();
    });
  });

  server.listen(config.port, "0.0.0.0", () => {
    log(
      `${SERVER_VERSION} listening on 0.0.0.0:${config.port} — ReAI ${config.baseUrl}, ` +
        `write mode ${config.writeMode}, key ${sealer.ephemeral ? "ephemeral" : sealer.keyFingerprint}`,
    );
    if (!config.publicUrl) {
      log(
        "PUBLIC_URL is not set; it will be inferred per-request from the Host and X-Forwarded-Host " +
          "headers. Set it explicitly in production so OAuth metadata is stable.",
      );
      if (config.allowedHosts.length === 0) {
        log(
          "WARNING: neither PUBLIC_URL nor REAI_ALLOWED_HOSTS is set, so a client-supplied " +
            "X-Forwarded-Host decides what this server claims to be — including the issuer in its " +
            "OAuth metadata and the resource_metadata pointer in its 401 challenge. Cloud Run does " +
            "not strip that header. Set PUBLIC_URL.",
        );
      }
    }
    if (config.allowTokenPassthrough) {
      log(
        "REAI_ALLOW_TOKEN_PASSTHROUGH is enabled: a raw ReAI token in the Authorization header is " +
          "accepted. Do not expose this deployment publicly.",
      );
    }
  });

  const shutdown = () => {
    log("shutting down");
    server.close(() => process.exit(0));
    // Don't let a hung keep-alive connection block the exit.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  sealer: Sealer,
  replayGuard: CodeReplayGuard,
): Promise<void> {
  const publicUrl = resolvePublicUrl(req, config);
  // A request target beginning with "//" is a protocol-relative reference, so
  // `new URL` reads the authority from the target rather than from the base: the
  // pathname of "//evil.example/mcp" is "/mcp", and "//mcp" has no path at all and
  // resolved to "/", which served the HTML status page in answer to a POST that a
  // client believed was going to the MCP endpoint. Collapsing leading slashes keeps
  // routing keyed on the path the client actually asked for. Origin-form targets are
  // what HTTP/1.1 requires here anyway.
  const target = (req.url ?? "/").replace(/^\/+/, "/");
  const url = new URL(target, publicUrl);
  const oauth = new OAuthProvider({ config, sealer, publicUrl, replayGuard });
  const path = url.pathname.replace(/\/+$/, "") || "/";

  // CORS: browser-based MCP clients need these. Credentials are never sent via
  // cookies, so a wildcard origin is safe here.
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  switch (path) {
    case "/health":
      sendJson(res, 200, { status: "ok", name: SERVER_NAME, version: SERVER_VERSION });
      return;

    case "/":
      sendHtml(res, 200, statusPage(config, publicUrl));
      return;

    case "/.well-known/oauth-protected-resource":
      sendJson(res, 200, oauth.protectedResourceMetadata());
      return;

    case "/.well-known/oauth-authorization-server":
    case "/.well-known/openid-configuration":
      sendJson(res, 200, oauth.authorizationServerMetadata());
      return;

    case "/register": {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      // Read first, parse second: folding both into one try reported an oversized
      // body as "Body must be JSON.", which sends whoever is debugging it looking
      // at their payload's syntax instead of its size.
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw || "{}");
      } catch {
        sendJson(res, 400, { error: "invalid_request", error_description: "Body must be JSON." });
        return;
      }
      const result = oauth.register(parsed);
      sendJson(res, result.status, result.json);
      return;
    }

    case "/authorize": {
      if (req.method === "GET") {
        oauth.handleAuthorizeGet(url, res);
        return;
      }
      if (req.method === "POST") {
        // A browser cannot forge either of these, so together they reject a
        // cross-site form post that would send the victim's pasted ReAI token
        // to an authorization request bound to someone else's redirect URI.
        const contentType = (firstHeader(req.headers["content-type"]) ?? "").toLowerCase();
        if (!contentType.startsWith("application/x-www-form-urlencoded")) {
          sendHtml(
            res,
            415,
            renderErrorPage(
              "Unsupported content type",
              "The consent form must be submitted as application/x-www-form-urlencoded.",
            ),
          );
          return;
        }
        if (!isSameOriginSubmission(req, publicUrl)) {
          sendHtml(
            res,
            403,
            renderErrorPage(
              "Cross-site submission blocked",
              "This form must be submitted from the authorization page itself. " +
                "Start the connection again from your MCP client.",
            ),
          );
          return;
        }
        const body = await readBody(req);
        await oauth.handleAuthorizePost(new URLSearchParams(body), res);
        return;
      }
      sendHtml(res, 405, renderErrorPage("Method not allowed", "Use GET or POST."));
      return;
    }

    case "/token": {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      const body = await readBody(req);
      const result = await oauth.handleToken(new URLSearchParams(body));
      sendJson(res, result.status, result.json);
      return;
    }

    case MCP_PATH:
      // A standalone SSE stream carries server-initiated messages, which requires a
      // session to deliver them to. This server is stateless by design — a fresh
      // MCP server per request — so nothing can ever be sent on one. The SDK opened
      // it anyway, with a keep-alive ping and no server-side lifetime, ending only
      // when the client left: 400 concurrent held GETs cost the server nothing in
      // memory but consume Cloud Run's per-instance concurrency, and the 300-second
      // request timeout was the only thing that ever closed them. The spec's other
      // permitted answer is 405, which is the honest one here.
      if (req.method === "GET") {
        res.setHeader("Allow", "POST, DELETE");
        sendJson(res, 405, {
          error: "method_not_allowed",
          error_description:
            "This server runs in stateless mode, so it has no session on which to deliver " +
            "server-initiated messages and does not offer a standalone SSE stream. Send " +
            "requests as POST; responses stream on the POST itself.",
        });
        return;
      }
      await handleMcp(req, res, config, oauth);
      return;

    default:
      sendJson(res, 404, { error: "not_found", error_description: `No route for ${path}.` });
  }
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  oauth: OAuthProvider,
): Promise<void> {
  const auth = oauth.authenticate(req.headers.authorization);
  if (!auth.ok) {
    res.setHeader("WWW-Authenticate", oauth.challengeHeader(auth.error, auth.description));
    sendJson(res, auth.status, { error: auth.error, error_description: auth.description });
    return;
  }

  const grant: GrantPayload = auth.grant;

  // The write mode is re-clamped against current config below, for reasons that
  // apply just as much here: a sealed grant is unforgeable but it is not fresh.
  // The tenant binding was never re-checked, and `boundTenantId` was set ONLY when
  // the grant carried a tenant — so a grant without one had no tenant boundary at
  // all and could reach every company its ReAI token could see. Grants like that
  // are not hypothetical: they are what this server minted before the consent flow
  // began failing closed on an empty company list, and they stay valid for the full
  // 90-day absolute TTL, re-minted on every refresh. Refuse them at redemption too,
  // so the promise the consent page makes ("pick the company this connection should
  // use") holds for every token in circulation rather than only for new ones.
  // Passthrough is exempt, and deliberately so: it is a different mode with a
  // different tenant model. A raw ReAI token never went through the consent page, so
  // there is no company it could have been bound to, and unless REAI_TENANT_ID pins
  // one the documented behaviour is to choose per tool call. Rejecting it here broke
  // that mode outright and told the user to "re-authorize the connector" — advice
  // that makes no sense when passthrough is what skips OAuth in the first place.
  if (!auth.passthrough && grant.tenantId === undefined) {
    res.setHeader(
      "WWW-Authenticate",
      oauth.challengeHeader(
        "invalid_token",
        "This authorization is not bound to a company. Re-authorize the connector.",
      ),
    );
    sendJson(res, 401, {
      error: "invalid_token",
      error_description:
        "This authorization carries no bound company, so it has no tenant boundary. It was " +
        "issued before that became mandatory. Remove and re-add the connector to authorize " +
        "again; the new grant will be bound to the company you pick.",
    });
    return;
  }

  // Re-clamp the grant against the operator's *current* ceiling. Grants are
  // sealed and unforgeable, but they are minted at authorization time and live
  // for hours (refreshable for weeks). Without this, an operator who redeploys
  // with a tighter REAI_WRITE_MODE would keep serving the old, wider mode to
  // every outstanding token, and key rotation would be the only real remedy.
  const effectiveWriteMode = narrower(grant.writeMode, config.writeMode);

  // A fresh server and transport per request. Stateless mode keeps the deployment
  // horizontally scalable, which matters on platforms that scale to zero.
  const server = buildServer({
    config: {
      ...config,
      writeMode: effectiveWriteMode,
      // Stateless mode: a fresh server per request means session-local state does
      // not survive, and reai_use_tenant must not claim otherwise.
      statelessSession: true,
      ...(grant.tenantId !== undefined
        ? { defaultTenantId: grant.tenantId, boundTenantId: grant.tenantId }
        : {}),
    },
    token: grant.reaiToken,
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    ...(config.allowedHosts.length > 0
      ? { allowedHosts: config.allowedHosts, enableDnsRebindingProtection: true }
      : {}),
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);

  if (req.method !== "POST") {
    await transport.handleRequest(req, res);
    return;
  }

  // Read and validate before the SDK sees it. `parsedBody` short-circuits the
  // transport's own unbounded `req.json()`.
  const raw = await readBody(req, MAX_MCP_BODY_BYTES);
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(raw || "null");
  } catch {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error: Invalid JSON" },
      id: null,
    });
    return;
  }

  if (Array.isArray(parsedBody) && parsedBody.length > MAX_MCP_BATCH) {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      error: {
        code: -32600,
        message:
          `Batch of ${parsedBody.length} exceeds the limit of ${MAX_MCP_BATCH}. Every entry is ` +
          `dispatched concurrently, so a large batch is a burst of simultaneous ReAI calls — ` +
          `and the write policy is applied per call, not to the batch. Split it up.`,
      },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, parsedBody);
}

/** The more restrictive of two write modes. */
function narrower(a: WriteMode, b: WriteMode): WriteMode {
  return WRITE_MODES.indexOf(a) <= WRITE_MODES.indexOf(b) ? a : b;
}

/**
 * The canonical public URL. A configured PUBLIC_URL always wins; otherwise it is
 * inferred from forwarding headers, which is what a platform like Cloud Run
 * provides in front of TLS termination.
 *
 * `Host` and `X-Forwarded-Host` are client-controlled, so an inferred host is
 * only honoured when it appears in REAI_ALLOWED_HOSTS (if that is configured).
 * Anything unexpected falls back to the first allowed host rather than becoming
 * this deployment's advertised OAuth issuer.
 */
function resolvePublicUrl(req: IncomingMessage, config: ServerConfig): string {
  if (config.publicUrl) return config.publicUrl;

  // The LAST value, not the first. Proxies APPEND to X-Forwarded-*, so index 0 is
  // whatever the client sent and the rightmost entry is what the nearest proxy added.
  // Taking the first meant a client-supplied "X-Forwarded-Host: attacker.example,
  // real.host" won outright — the opposite of the intent. Cloud Run does not strip a
  // client-supplied X-Forwarded-Host, so this is reachable in the documented
  // deployment; setting PUBLIC_URL closes it entirely, which is why the deploy script
  // always does and why startup now warns when it is absent.
  const forwardedProto = lastForwardedValue(req.headers["x-forwarded-proto"]);
  const forwardedHost = lastForwardedValue(req.headers["x-forwarded-host"]);
  let host = forwardedHost ?? req.headers.host ?? `localhost:${config.port}`;

  if (config.allowedHosts.length > 0) {
    const hostname = host.split(":")[0] ?? "";
    const permitted = config.allowedHosts.some(
      (allowed) => allowed === host || allowed === hostname,
    );
    if (!permitted) host = config.allowedHosts[0] as string;
  }

  const proto = forwardedProto === "http" || forwardedProto === "https"
    ? forwardedProto
    : isLocalHost(host)
      ? "http"
      : "https";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

/**
 * True when a form submission demonstrably came from this origin.
 *
 * `Sec-Fetch-Site` is set by the browser and cannot be overridden by page
 * script; `Origin` is likewise unforgeable cross-site. When neither is present
 * the caller is not a browser (curl, a test harness), which is allowed —
 * cross-site request forgery requires a browser to be the one submitting.
 */
function isSameOriginSubmission(req: IncomingMessage, publicUrl: string): boolean {
  const fetchSite = firstHeader(req.headers["sec-fetch-site"]);
  if (fetchSite) return fetchSite === "same-origin" || fetchSite === "none";

  const origin = firstHeader(req.headers.origin);
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(publicUrl).host;
  } catch {
    return false;
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]?.split(",")[0]?.trim();
  return value?.split(",")[0]?.trim();
}


function isLocalHost(host: string): boolean {
  const name = host.split(":")[0] ?? "";
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

function statusPage(config: ServerConfig, publicUrl: string): string {
  // Deliberately the same escaper as the consent page: a second, ad-hoc one here
  // omitted the apostrophe and would silently be wrong the day this page gains a
  // single-quoted attribute.
  const esc = escapeHtml;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>reai-mcp</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    padding:24px; font:15px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
    background:#f6f7f9; color:#14171a; }
  main { max-width:540px; background:#fff; border:1px solid #e3e6ea; border-radius:14px; padding:28px; }
  h1 { margin:0 0 4px; font-size:19px; }
  p { color:#5c6670; font-size:13.5px; }
  code { background:#f2f4f6; padding:1px 5px; border-radius:4px; font-size:12.5px; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:6px 14px; font-size:13.5px; margin:20px 0 0; }
  dt { color:#6b747d; }
  a { color:#2f6feb; }
  @media (prefers-color-scheme: dark) {
    body { background:#101214; color:#e6e9ec; }
    main { background:#191c1f; border-color:#2b3034; }
    p, dt { color:#98a1aa; } code { background:#22262a; }
  }
</style></head><body><main>
<h1>reai-mcp ${esc(SERVER_VERSION)}</h1>
<p>An MCP server for ReAI, the Norwegian accounting system. This is the connector endpoint —
add <code>${esc(publicUrl)}${MCP_PATH}</code> as a custom connector in your MCP client and
authorize with your ReAI API token.</p>
<dl>
  <dt>MCP endpoint</dt><dd><code>${esc(publicUrl)}${MCP_PATH}</code></dd>
  <dt>ReAI API</dt><dd><code>${esc(config.baseUrl)}</code></dd>
  <dt>Write mode ceiling</dt><dd><code>${esc(config.writeMode)}</code></dd>
  <dt>Auth</dt><dd>OAuth 2.1 with PKCE and dynamic client registration</dd>
</dl>
<p style="margin-top:22px"><a href="https://github.com/Stener1/reai-mcp" rel="noreferrer noopener">Source and self-hosting guide</a>
&middot; access tokens last ${Math.round(ACCESS_TOKEN_TTL / 3600)}h</p>
</main></body></html>`;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `[${SERVER_NAME}] fatal: ${message}\n` +
      (err instanceof ReaiConfigError ? "" : `${err instanceof Error ? (err.stack ?? "") : ""}\n`),
  );
  process.exit(1);
});
