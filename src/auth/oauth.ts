import type { IncomingMessage, ServerResponse } from "node:http";
import { ReaiClient } from "../reai/client.js";
import { ReaiApiError } from "../reai/errors.js";
import { WRITE_MODES, type WriteMode } from "../policy.js";
import { Sealer, verifyPkceS256, randomId } from "./crypto.js";
import type { ServerConfig } from "../config.js";
import { renderConsentPage, renderErrorPage } from "./pages.js";

/**
 * A minimal OAuth 2.1 authorization server, just large enough to make this
 * server usable as a hosted MCP connector.
 *
 * ReAI authenticates with static API tokens and has no OAuth endpoints of its
 * own, so the flow here is a bridge: the user pastes a ReAI token on our consent
 * page, we verify it against `GET /api/me`, and then mint our own sealed tokens
 * that carry it. From the client's perspective this is an ordinary
 * authorization-code + PKCE flow with dynamic client registration.
 */

export const ACCESS_TOKEN_TTL = 60 * 60 * 8; // 8 hours
export const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 30; // 30 days
const CODE_TTL = 60; // RFC 6749 recommends <= 10 minutes; a paste-and-redirect needs far less
const AUTHREQ_TTL = 15 * 60; // how long a user may sit on the consent page

export type GrantPayload = {
  /** The user's ReAI API token, sealed inside our own token. */
  reaiToken: string;
  /** Tenant this grant is bound to, chosen at authorization time. */
  tenantId?: number;
  /** Write ceiling for this grant. Never exceeds the server's own mode. */
  writeMode: WriteMode;
  /** For audit lines; never the token itself. */
  subject: string;
  clientId: string;
};

type AuthRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  resource?: string;
  scope?: string;
};

type ClientPayload = {
  redirectUris: string[];
  name?: string;
};

/**
 * Tracks redeemed authorization codes.
 *
 * Lives outside `OAuthProvider` because a provider is constructed per request
 * (its `publicUrl` can be derived from the request's Host header), so anything
 * held on the instance would be discarded immediately. This must be created once
 * per process and injected.
 *
 * PKCE is the primary defence — a stolen code is useless without the verifier —
 * so a per-instance guard is defence in depth, not the only control.
 */
export class CodeReplayGuard {
  private readonly used = new Map<string, number>();

  isUsed(nonce: string): boolean {
    this.prune();
    return this.used.has(nonce);
  }

  markUsed(nonce: string): void {
    this.used.set(nonce, Date.now() + CODE_TTL * 1000);
  }

  private prune(): void {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.used) {
      if (expiresAt < now) this.used.delete(nonce);
    }
  }
}

export type OAuthDeps = {
  config: ServerConfig;
  sealer: Sealer;
  /** Canonical public base URL of this deployment, no trailing slash. */
  publicUrl: string;
  /** Shared across requests; see CodeReplayGuard. */
  replayGuard: CodeReplayGuard;
};

/** Result of authenticating an incoming MCP request. */
export type AuthResult =
  | { ok: true; grant: GrantPayload }
  | { ok: false; status: 401 | 403; error: string; description: string };

export class OAuthProvider {
  private readonly deps: OAuthDeps;

  constructor(deps: OAuthDeps) {
    this.deps = deps;
  }

  get resourceUrl(): string {
    return `${this.deps.publicUrl}/mcp`;
  }

  /** RFC 9728 — tells the client which authorization server protects this resource. */
  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resourceUrl,
      authorization_servers: [this.deps.publicUrl],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://github.com/Stener1/reai-mcp",
      scopes_supported: ["reai"],
    };
  }

  /** RFC 8414 — authorization server metadata. */
  authorizationServerMetadata(): Record<string, unknown> {
    const base = this.deps.publicUrl;
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      scopes_supported: ["reai"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      service_documentation: "https://github.com/Stener1/reai-mcp",
    };
  }

  /**
   * RFC 7591 dynamic client registration.
   *
   * Registration is open, which is what MCP clients expect. There are no client
   * secrets: clients are public and rely on PKCE, so a registration confers no
   * authority on its own — every grant still requires a human to paste a valid
   * ReAI token on the consent page.
   */
  register(body: unknown): { status: number; json: Record<string, unknown> } {
    const req = (body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
    const uris = Array.isArray(req.redirect_uris) ? req.redirect_uris.map(String) : [];

    if (uris.length === 0) {
      return {
        status: 400,
        json: { error: "invalid_redirect_uri", error_description: "redirect_uris is required." },
      };
    }
    for (const uri of uris) {
      const problem = validateRedirectUri(uri);
      if (problem) {
        return { status: 400, json: { error: "invalid_redirect_uri", error_description: problem } };
      }
    }

    const name = typeof req.client_name === "string" ? req.client_name.slice(0, 120) : undefined;
    // The client_id *is* the registration: sealed, so no server-side store.
    const clientId = this.deps.sealer.seal(
      "client",
      { redirectUris: uris, ...(name ? { name } : {}) } satisfies ClientPayload,
      REFRESH_TOKEN_TTL,
    );

    return {
      status: 201,
      json: {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: uris,
        ...(name ? { client_name: name } : {}),
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    };
  }

  /** GET /authorize — validate the request, then render the consent page. */
  handleAuthorizeGet(url: URL, res: ServerResponse): void {
    const parsed = this.parseAuthorizeRequest(url);
    if ("error" in parsed) {
      this.sendAuthorizeError(res, parsed);
      return;
    }

    const sealedRequest = this.deps.sealer.seal("authreq", parsed.request as never, AUTHREQ_TTL);
    const client = this.deps.sealer.unseal<ClientPayload>("client", parsed.request.clientId);

    sendHtml(
      res,
      200,
      renderConsentPage({
        sealedRequest,
        clientName: client?.name,
        redirectUri: parsed.request.redirectUri,
        serverWriteMode: this.deps.config.writeMode,
        baseUrl: this.deps.config.baseUrl,
      }),
    );
  }

  /**
   * POST /authorize — the user has pasted a ReAI token.
   *
   * The token is verified against the live API before any code is issued, so an
   * invalid paste fails here with a readable message rather than surfacing later
   * as a broken connector.
   */
  async handleAuthorizePost(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const sealedRequest = form.get("request") ?? "";
    const request = this.deps.sealer.unseal<AuthRequest>("authreq", sealedRequest);
    if (!request) {
      sendHtml(
        res,
        400,
        renderErrorPage(
          "This authorization page has expired",
          "Start the connection again from your MCP client.",
        ),
      );
      return;
    }

    // Step 1 posts the pasted token; step 2 (company selection) posts it back
    // sealed, so it never round-trips through the browser in the clear.
    let reaiToken = (form.get("token") ?? "").trim();
    const verified = form.get("verified");
    if (!reaiToken && verified) {
      const carried = this.deps.sealer.unseal<{ reaiToken: string }>("authreq", verified);
      if (!carried) {
        sendHtml(
          res,
          400,
          renderErrorPage(
            "This authorization page has expired",
            "Start the connection again from your MCP client.",
          ),
        );
        return;
      }
      reaiToken = carried.reaiToken;
    }

    if (!reaiToken) {
      sendHtml(
        res,
        400,
        renderConsentPage({
          sealedRequest,
          redirectUri: request.redirectUri,
          serverWriteMode: this.deps.config.writeMode,
          baseUrl: this.deps.config.baseUrl,
          error: "Paste your ReAI API token to continue.",
        }),
      );
      return;
    }

    // Verify the token and discover which companies it can reach.
    let me: { email?: string; name?: string; tenants?: Array<{ id: number; companyName?: string; slug?: string }> };
    try {
      const client = new ReaiClient({
        token: reaiToken,
        baseUrl: this.deps.config.baseUrl,
        timeoutMs: this.deps.config.timeoutMs,
        maxRetries: 1,
      });
      const meRes = await client.request<typeof me>({ method: "GET", path: "/api/me", omitTenant: true });
      me = meRes.data;
    } catch (err) {
      const detail =
        err instanceof ReaiApiError && err.status === 401
          ? "ReAI rejected that token. Check that you copied it completely and that it has not been revoked."
          : err instanceof Error
            ? `Could not verify the token: ${err.message}`
            : "Could not verify the token.";
      sendHtml(
        res,
        400,
        renderConsentPage({
          sealedRequest,
          redirectUri: request.redirectUri,
          serverWriteMode: this.deps.config.writeMode,
          baseUrl: this.deps.config.baseUrl,
          error: detail,
        }),
      );
      return;
    }

    // The consent page may narrow the write mode, never widen it.
    const writeMode = this.narrowWriteMode(form.get("writeMode"));

    const tenants = me.tenants ?? [];
    const rawTenant = (form.get("tenantId") ?? "").trim();

    // With several companies available, make the user choose explicitly rather
    // than guessing which set of books the agent should touch.
    if (!rawTenant && tenants.length > 1) {
      sendHtml(
        res,
        200,
        renderConsentPage({
          sealedRequest,
          redirectUri: request.redirectUri,
          serverWriteMode: this.deps.config.writeMode,
          baseUrl: this.deps.config.baseUrl,
          sealedToken: this.deps.sealer.seal("authreq", { reaiToken }, AUTHREQ_TTL),
          tenants,
          subject: me.email ?? me.name,
          carriedWriteMode: writeMode,
        }),
      );
      return;
    }

    let tenantId: number | undefined;
    if (rawTenant) {
      const n = Number(rawTenant);
      if (!Number.isInteger(n) || !tenants.some((t) => t.id === n)) {
        sendHtml(
          res,
          400,
          renderErrorPage("Unknown company", "That company is not available to this ReAI token."),
        );
        return;
      }
      tenantId = n;
    } else if (tenants.length === 1) {
      tenantId = tenants[0]?.id;
    }

    const grant: GrantPayload = {
      reaiToken,
      ...(tenantId !== undefined ? { tenantId } : {}),
      writeMode,
      subject: me.email ?? me.name ?? "unknown",
      clientId: request.clientId,
    };

    const code = this.deps.sealer.seal(
      "code",
      {
        grant,
        codeChallenge: request.codeChallenge,
        redirectUri: request.redirectUri,
        clientId: request.clientId,
        ...(request.resource ? { resource: request.resource } : {}),
        nonce: randomId(8),
      },
      CODE_TTL,
    );

    const location = new URL(request.redirectUri);
    location.searchParams.set("code", code);
    if (request.state) location.searchParams.set("state", request.state);
    res.writeHead(302, { Location: location.toString() });
    res.end();
  }

  /** POST /token — authorization_code and refresh_token grants. */
  async handleToken(form: URLSearchParams): Promise<{ status: number; json: Record<string, unknown> }> {
    const grantType = form.get("grant_type");

    if (grantType === "authorization_code") {
      const code = form.get("code") ?? "";
      const verifier = form.get("code_verifier") ?? "";
      const redirectUri = form.get("redirect_uri") ?? "";
      const clientId = form.get("client_id") ?? "";

      const payload = this.deps.sealer.unseal<{
        grant: GrantPayload;
        codeChallenge: string;
        redirectUri: string;
        clientId: string;
        resource?: string;
        nonce: string;
      }>("code", code);

      if (!payload) {
        return err(400, "invalid_grant", "The authorization code is invalid or has expired.");
      }
      if (this.deps.replayGuard.isUsed(payload.nonce)) {
        return err(400, "invalid_grant", "This authorization code has already been redeemed.");
      }
      if (redirectUri && redirectUri !== payload.redirectUri) {
        return err(400, "invalid_grant", "redirect_uri does not match the authorization request.");
      }
      if (clientId && clientId !== payload.clientId) {
        return err(400, "invalid_grant", "client_id does not match the authorization request.");
      }
      if (!verifier) {
        return err(400, "invalid_request", "code_verifier is required (PKCE).");
      }
      if (!verifyPkceS256(verifier, payload.codeChallenge)) {
        return err(400, "invalid_grant", "PKCE verification failed.");
      }

      this.deps.replayGuard.markUsed(payload.nonce);
      return { status: 200, json: this.issueTokens(payload.grant) };
    }

    if (grantType === "refresh_token") {
      const token = form.get("refresh_token") ?? "";
      const payload = this.deps.sealer.unseal<{ grant: GrantPayload }>("refresh", token);
      if (!payload) {
        return err(400, "invalid_grant", "The refresh token is invalid or has expired.");
      }
      return { status: 200, json: this.issueTokens(payload.grant) };
    }

    return err(
      400,
      "unsupported_grant_type",
      "Supported grant types are authorization_code and refresh_token.",
    );
  }

  /**
   * Clamp a user-selected write mode to the server's configured ceiling.
   * The consent page can only tighten what the operator already allowed.
   */
  private narrowWriteMode(requested: string | null): WriteMode {
    const ceiling = this.deps.config.writeMode;
    const value = (requested ?? "").trim() as WriteMode;
    if (!value || !WRITE_MODES.includes(value)) return ceiling;
    return rank(value) <= rank(ceiling) ? value : ceiling;
  }

  private issueTokens(grant: GrantPayload): Record<string, unknown> {
    return {
      access_token: this.deps.sealer.seal("access", { grant }, ACCESS_TOKEN_TTL),
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: this.deps.sealer.seal("refresh", { grant }, REFRESH_TOKEN_TTL),
      scope: "reai",
    };
  }

  /**
   * Authenticate an MCP request.
   *
   * Accepts a token this server minted. If `allowTokenPassthrough` is enabled it
   * also accepts a raw ReAI token, which is convenient for private deployments
   * and for clients that can set a static header, but means anyone reaching the
   * URL acts as whoever's token they present.
   */
  authenticate(authorizationHeader: string | undefined): AuthResult {
    const raw = (authorizationHeader ?? "").trim();
    if (!raw) {
      return {
        ok: false,
        status: 401,
        error: "invalid_request",
        description: "Authorization header is missing.",
      };
    }
    const match = /^Bearer\s+(.+)$/i.exec(raw);
    if (!match?.[1]) {
      return {
        ok: false,
        status: 401,
        error: "invalid_request",
        description: "Expected an Authorization: Bearer header.",
      };
    }
    const bearer = match[1].trim();

    const sealed = this.deps.sealer.unseal<{ grant: GrantPayload }>("access", bearer);
    if (sealed?.grant) return { ok: true, grant: sealed.grant };

    if (this.deps.config.allowTokenPassthrough) {
      return {
        ok: true,
        grant: {
          reaiToken: bearer,
          ...(this.deps.config.defaultTenantId !== undefined
            ? { tenantId: this.deps.config.defaultTenantId }
            : {}),
          writeMode: this.deps.config.writeMode,
          subject: "token-passthrough",
          clientId: "token-passthrough",
        },
      };
    }

    return {
      ok: false,
      status: 401,
      error: "invalid_token",
      description: "The access token is invalid or has expired. Re-authorize the connector.",
    };
  }

  /** `WWW-Authenticate` value pointing clients at our metadata (RFC 9728). */
  challengeHeader(error: string, description: string): string {
    return (
      `Bearer error="${error}", error_description="${description.replace(/"/g, "'")}", ` +
      `resource_metadata="${this.deps.publicUrl}/.well-known/oauth-protected-resource"`
    );
  }

  private parseAuthorizeRequest(
    url: URL,
  ): { request: AuthRequest } | { error: string; description: string; redirectUri?: string; state?: string } {
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const responseType = url.searchParams.get("response_type") ?? "";
    const codeChallenge = url.searchParams.get("code_challenge") ?? "";
    const method = url.searchParams.get("code_challenge_method") ?? "";
    const state = url.searchParams.get("state") ?? undefined;
    const resource = url.searchParams.get("resource") ?? undefined;
    const scope = url.searchParams.get("scope") ?? undefined;

    const client = this.deps.sealer.unseal<ClientPayload>("client", clientId);
    if (!client) {
      return {
        error: "invalid_client",
        description: "Unknown or expired client_id. Register the client again.",
      };
    }
    // Validated before any redirect, so we never bounce to an unregistered URI.
    if (!client.redirectUris.includes(redirectUri)) {
      return {
        error: "invalid_request",
        description: "redirect_uri is not registered for this client.",
      };
    }
    if (responseType !== "code") {
      return {
        error: "unsupported_response_type",
        description: 'Only response_type="code" is supported.',
        redirectUri,
        ...(state ? { state } : {}),
      };
    }
    if (!codeChallenge || method !== "S256") {
      return {
        error: "invalid_request",
        description: "PKCE with code_challenge_method=S256 is required.",
        redirectUri,
        ...(state ? { state } : {}),
      };
    }

    return {
      request: {
        clientId,
        redirectUri,
        codeChallenge,
        ...(state ? { state } : {}),
        ...(resource ? { resource } : {}),
        ...(scope ? { scope } : {}),
      },
    };
  }

  private sendAuthorizeError(
    res: ServerResponse,
    parsed: { error: string; description: string; redirectUri?: string; state?: string },
  ): void {
    // Only redirect an error when the redirect_uri itself was validated.
    if (parsed.redirectUri) {
      const location = new URL(parsed.redirectUri);
      location.searchParams.set("error", parsed.error);
      location.searchParams.set("error_description", parsed.description);
      if (parsed.state) location.searchParams.set("state", parsed.state);
      res.writeHead(302, { Location: location.toString() });
      res.end();
      return;
    }
    sendHtml(res, 400, renderErrorPage("Cannot start authorization", parsed.description));
  }

}

function rank(mode: WriteMode): number {
  return WRITE_MODES.indexOf(mode);
}

function err(status: number, error: string, description: string) {
  return { status, json: { error, error_description: description } };
}

/**
 * Redirect URIs must be https, or loopback http for local development. Anything
 * else (custom schemes, http on a public host) is refused.
 */
export function validateRedirectUri(uri: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return `redirect_uri is not a valid absolute URL: ${uri}`;
  }
  if (parsed.hash) return "redirect_uri must not contain a fragment.";
  if (parsed.protocol === "https:") return undefined;
  if (parsed.protocol === "http:" && isLoopback(parsed.hostname)) return undefined;
  return "redirect_uri must use https, or http on localhost for development.";
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(html);
}

export function sendJson(res: ServerResponse, status: number, json: unknown): void {
  const body = JSON.stringify(json);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Read and size-limit a request body. */
export async function readBody(req: IncomingMessage, limitBytes = 1024 * 512): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > limitBytes) throw new Error("Request body too large.");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}
