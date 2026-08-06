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
import { loadConfig, type ServerConfig } from "./config.js";
import { WRITE_MODES, type WriteMode } from "./policy.js";
import { Sealer } from "./auth/crypto.js";
import {
  CodeReplayGuard,
  OAuthProvider,
  readBody,
  sendHtml,
  sendJson,
  ACCESS_TOKEN_TTL,
  type GrantPayload,
} from "./auth/oauth.js";
import { escapeHtml, renderErrorPage } from "./auth/pages.js";
import { ReaiConfigError } from "./reai/errors.js";

const MCP_PATH = "/mcp";

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
        "PUBLIC_URL is not set; it will be inferred per-request from the Host header. " +
          "Set it explicitly in production so OAuth metadata is stable.",
      );
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
  const url = new URL(req.url ?? "/", publicUrl);
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
      let parsed: unknown;
      try {
        parsed = JSON.parse((await readBody(req)) || "{}");
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
  await transport.handleRequest(req, res);
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

  const forwardedProto = firstHeader(req.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeader(req.headers["x-forwarded-host"]);
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
