import type { IncomingMessage, ServerResponse } from "node:http";
import { ReaiClient } from "../reai/client.js";
import { ReaiApiError } from "../reai/errors.js";
import { parseWriteMode, WRITE_MODES, type WriteMode } from "../policy.js";
import { Sealer, verifyPkceS256, randomId, isSealedToken } from "./crypto.js";
import { createHash } from "node:crypto";
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
/**
 * Absolute ceiling on a grant, regardless of how often it is refreshed.
 *
 * Without this, each refresh minted a token with a fresh 30-day TTL while the
 * redeemed one stayed valid, so anyone holding a single refresh token could roll
 * it forward indefinitely and keep access to the books forever. The grant now
 * carries the time it was authorized, and a refresh can never extend past it.
 */
export const GRANT_ABSOLUTE_TTL = 60 * 60 * 24 * 90; // 90 days
/**
 * Client registrations are just a sealed list of redirect URIs and confer no
 * authority on their own, so they outlive a grant by a wide margin. Tying them to
 * the refresh TTL made a working connector start failing with invalid_client
 * after 30 days, with nothing in the registration response hinting at it.
 */
export const CLIENT_REGISTRATION_TTL = 60 * 60 * 24 * 365 * 5; // 5 years
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
  /** Unix seconds when the user authorized. Bounds the whole refresh chain. */
  authTime?: number;
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
  /**
   * `passthrough` marks a grant synthesised from a raw ReAI token rather than
   * issued by this server's OAuth flow. The distinction matters because the two
   * have different tenant models: an OAuth grant is bound to one company at
   * authorization time and must be, whereas passthrough deliberately leaves the
   * tenant to each tool call unless REAI_TENANT_ID pins one. Carried explicitly
   * rather than inferred from `subject`, so a security check never rests on a
   * string comparison.
   */
  | { ok: true; grant: GrantPayload; passthrough?: true }
  | { ok: false; status: 401 | 403; error: string; description: string };

export class OAuthProvider {
  private readonly deps: OAuthDeps;

  constructor(deps: OAuthDeps) {
    this.deps = deps;
  }

  get resourceUrl(): string {
    return `${this.deps.publicUrl}/mcp`;
  }

  /**
   * RFC 9728 — tells the client which authorization server protects this resource.
   *
   * `resource` MUST equal the identifier the client used to locate this document, and the RFC is emphatic:
   * "If these values are not identical, the data contained in the response MUST NOT be used." The metadata URL
   * is derived by inserting `/.well-known/oauth-protected-resource` BETWEEN the host and the resource's path,
   * so the two endpoints this server accepts have two different metadata locations:
   *
   *   https://host/mcp  ->  https://host/.well-known/oauth-protected-resource/mcp
   *   https://host      ->  https://host/.well-known/oauth-protected-resource
   *
   * Both were previously served from the second location with `resource` fixed at `${publicUrl}/mcp`. That
   * made the canonical location for the /mcp resource a 404, and gave a client connecting to the root a
   * document it is required to discard. Nothing broke in practice only because the clients tried so far do not
   * enforce the comparison — which is exactly the kind of thing that works until it doesn't.
   */
  protectedResourceMetadata(resource: string = this.resourceUrl): Record<string, unknown> {
    return {
      resource,
      authorization_servers: [this.deps.publicUrl],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://github.com/Stener1/reai-mcp",
      scopes_supported: ["reai"],
    };
  }

  /** The RFC 9728 metadata URL for a resource identifier, by the insertion rule above. */
  resourceMetadataUrl(resource: string): string {
    const path = resource.startsWith(this.deps.publicUrl)
      ? resource.slice(this.deps.publicUrl.length).replace(/\/+$/, "")
      : "";
    return `${this.deps.publicUrl}/.well-known/oauth-protected-resource${path}`;
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
    const allowedHosts = this.deps.config.allowedRedirectHosts;
    for (const uri of uris) {
      const problem = validateRedirectUri(uri);
      if (problem) {
        return { status: 400, json: { error: "invalid_redirect_uri", error_description: problem } };
      }
      // When the operator has declared which clients they use, an unknown
      // callback host cannot reach the consent page at all -- which is what
      // stops a stranger registering a client and phishing a token through this
      // deployment's own, genuine authorization page.
      if (allowedHosts.length > 0 && !isRedirectHostAllowed(uri, allowedHosts)) {
        return {
          status: 400,
          json: {
            error: "invalid_redirect_uri",
            error_description:
              `redirect_uri host is not permitted by this deployment. ` +
              `The operator allows: ${allowedHosts.join(", ")}.`,
          },
        };
      }
    }

    const name = typeof req.client_name === "string" ? req.client_name.slice(0, 120) : undefined;
    // The client_id *is* the registration: sealed, so no server-side store.
    const clientId = this.deps.sealer.seal(
      "client",
      { redirectUris: uris, ...(name ? { name } : {}) } satisfies ClientPayload,
      CLIENT_REGISTRATION_TTL,
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
      parsed.request.redirectUri,
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
    let carriedWriteMode: string | undefined;
    if (!reaiToken && verified) {
      const carried = this.deps.sealer.unseal<{
        reaiToken: string;
        requestBinding: string;
        writeMode: string;
      }>("verified", verified);
      // Bound to the authorization request it was issued under, so it cannot be
      // paired with a different request (e.g. one pointing at an attacker's
      // redirect URI) to convert someone else's credential into a grant.
      if (carried && carried.requestBinding !== bindingOf(sealedRequest)) {
        sendHtml(
          res,
          400,
          renderErrorPage(
            "This authorization page does not match",
            "Start the connection again from your MCP client.",
          ),
        );
        return;
      }
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
      carriedWriteMode = carried.writeMode;
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
        request.redirectUri,
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
        request.redirectUri,
      );
      return;
    }

    // The consent page may narrow the write mode, never widen it -- neither past
    // the operator's ceiling, nor past what was chosen in step 1.
    let writeMode = this.narrowWriteMode(form.get("writeMode"));
    if (carriedWriteMode) writeMode = this.narrowWriteMode(carriedWriteMode, writeMode);

    // Fails CLOSED when the tenant list is missing or empty. It used to fall through
    // with `?? []`, leaving both defaultTenantId and boundTenantId unset — i.e. no
    // tenant boundary at all, silently, for every grant minted afterwards. A single
    // upstream response-shape drift (or any user for whom ReAI omits `tenants`) was
    // enough to remove the guarantee the consent page makes, with no warning.
    const tenants = me.tenants ?? [];
    if (tenants.length === 0) {
      sendHtml(
        res,
        400,
        renderConsentPage({
          sealedRequest,
          redirectUri: request.redirectUri,
          serverWriteMode: this.deps.config.writeMode,
          baseUrl: this.deps.config.baseUrl,
          error:
            "That token authenticated, but GET /api/me returned no companies — so there is no " +
            "company to bind this connection to. A connection with no bound tenant would have no " +
            "tenant boundary at all, so it is refused rather than issued. Check that the ReAI user " +
            "has access to at least one company.",
        }),
        request.redirectUri,
      );
      return;
    }
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
          sealedToken: this.deps.sealer.seal(
            "verified",
            { reaiToken, requestBinding: bindingOf(sealedRequest), writeMode },
            AUTHREQ_TTL,
          ),
          tenants,
          subject: me.email ?? me.name,
          carriedWriteMode: writeMode,
        }),
        request.redirectUri,
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
      authTime: Math.floor(Date.now() / 1000),
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
      // RFC 6749 4.1.3 makes both REQUIRED for a public client. Comparing them
      // only when present let a caller skip the check by omitting the parameter.
      if (!redirectUri) {
        return err(400, "invalid_request", "redirect_uri is required.");
      }
      if (redirectUri !== payload.redirectUri) {
        return err(400, "invalid_grant", "redirect_uri does not match the authorization request.");
      }
      if (!clientId) {
        return err(400, "invalid_request", "client_id is required.");
      }
      if (clientId !== payload.clientId) {
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
      const clientId = form.get("client_id") ?? "";
      const payload = this.deps.sealer.unseal<{ grant: GrantPayload }>("refresh", token);
      if (!payload) {
        return err(400, "invalid_grant", "The refresh token is invalid or has expired.");
      }
      // A refresh token is only usable by the client it was issued to. Comparing the two
      // only when client_id was present let a caller skip the check by omitting it --
      // exactly the shape the authorization_code branch above was fixed for, kept here.
      // RFC 6749 6 requires the check, and since every client here is public
      // (token_endpoint_auth_methods_supported is ["none"]) client_id is REQUIRED on the
      // request. It is not a secret, so this is a conformance and blast-radius boundary
      // rather than a credential: whoever holds the refresh token already holds the
      // grant. What it stops is one registered client redeeming another's token.
      if (!clientId) {
        return err(400, "invalid_request", "client_id is required.");
      }
      if (clientId !== payload.grant.clientId) {
        return err(400, "invalid_grant", "client_id does not match the refresh token.");
      }
      // A grant with no bound tenant has no tenant boundary, and /mcp now refuses it.
      // Minting a replacement pair anyway would hand the client credentials that can
      // never work, and — because the new refresh token is just as untenanted — a
      // refresh path it can loop on indefinitely instead of starting authorization.
      // invalid_grant is the signal that sends a well-behaved client back to /authorize.
      if (payload.grant.tenantId === undefined) {
        return err(
          400,
          "invalid_grant",
          "This authorization is not bound to a company, so it has no tenant boundary. It was " +
            "issued before that became mandatory and cannot be refreshed. Authorize the " +
            "connector again to pick a company.",
        );
      }
      // For a legacy grant, the token's own iat is the best evidence of when the
      // authorization existed, and it is trustworthy because we sealed it.
      const effectiveAuthTime = payload.grant.authTime ?? payload.iat;
      if (effectiveAuthTime + GRANT_ABSOLUTE_TTL <= Math.floor(Date.now() / 1000)) {
        return err(
          400,
          "invalid_grant",
          "This authorization has reached its maximum lifetime. Authorize the connector again.",
        );
      }
      return { status: 200, json: this.issueTokens(payload.grant, payload.iat) };
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
  private narrowWriteMode(requested: string | null | undefined, ceiling?: WriteMode): WriteMode {
    const limit = ceiling ?? this.deps.config.writeMode;
    // Normalized rather than compared raw: "READ-ONLY" or "readonly" previously
    // fell through to the ceiling, i.e. failed *open* to the widest mode.
    let value: WriteMode;
    try {
      value = parseWriteMode(requested ?? undefined);
    } catch {
      return "read-only";
    }
    if (!requested) return limit;
    return rank(value) <= rank(limit) ? value : limit;
  }

  /**
   * Clamp both tokens to what is left of the grant's absolute lifetime.
   *
   * `fallbackAuthTime` matters for grants sealed before authTime existed: without
   * it, each refresh would treat "now" as the authorization time, mint a
   * replacement that again carried no authTime, and reset the 90-day window
   * forever -- preserving exactly the indefinite access this is meant to end. The
   * caller passes the redeemed token's own `iat`, which we sealed and can trust.
   */
  private issueTokens(grant: GrantPayload, fallbackAuthTime?: number): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    const authTime = grant.authTime ?? fallbackAuthTime ?? now;
    // Persist it, so the replacement token is no longer legacy.
    const sealedGrant: GrantPayload = { ...grant, authTime };
    const remaining = Math.max(0, authTime + GRANT_ABSOLUTE_TTL - now);

    const accessTtl = Math.min(ACCESS_TOKEN_TTL, remaining);
    const refreshTtl = Math.min(REFRESH_TOKEN_TTL, remaining);

    const out: Record<string, unknown> = {
      access_token: this.deps.sealer.seal("access", { grant: sealedGrant }, accessTtl),
      token_type: "Bearer",
      expires_in: accessTtl,
      scope: "reai",
    };
    // Past the absolute ceiling there is nothing left to refresh with; omitting
    // it tells the client to start a new authorization rather than retry.
    if (refreshTtl > 0) {
      out.refresh_token = this.deps.sealer.seal("refresh", { grant: sealedGrant }, refreshTtl);
    }
    return out;
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

    // A bearer that is unmistakably one of ours but failed to unseal is expired,
    // tampered with, or sealed under a rotated key. Telling the client to
    // re-authorize is right; forwarding our own ciphertext to ReAI as a
    // credential is not.
    if (isSealedToken(bearer)) {
      return {
        ok: false,
        status: 401,
        error: "invalid_token",
        description: "The access token is invalid or has expired. Re-authorize the connector.",
      };
    }

    if (this.deps.config.allowTokenPassthrough) {
      return {
        ok: true,
        passthrough: true,
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
  challengeHeader(error: string, description: string, resource: string = this.resourceUrl): string {
    // Every interpolated value is quote-stripped: publicUrl can be derived from
    // a client-supplied Host header, and an unescaped quote would inject an
    // extra auth-param into the header.
    const quoteless = (value: string) => value.replace(/["\\]/g, "");
    return (
      `Bearer error="${quoteless(error)}", error_description="${quoteless(description)}", ` +
      // Points at the document for the endpoint the client actually called, not always the /mcp one: a client
      // that connected to the root and is handed the /mcp document must discard it (RFC 9728).
      `resource_metadata="${quoteless(this.resourceMetadataUrl(resource))}"`
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
    // Re-checked against the operator's allowlist HERE, not only at registration.
    // Registrations are sealed and live five years, and the allowlist is empty by
    // default — so a callback registered before an operator set
    // REAI_ALLOWED_REDIRECT_HOSTS kept working forever afterwards. That is a phishing
    // primitive on the operator's own domain: send a victim to the genuine consent
    // page, they paste their ReAI token, and the code is delivered to a callback the
    // operator has since forbidden. Tightening the config now takes effect for
    // existing registrations too, which is what an operator setting it expects.
    const allowedRedirectHosts = this.deps.config.allowedRedirectHosts;
    if (allowedRedirectHosts.length > 0 && !isRedirectHostAllowed(redirectUri, allowedRedirectHosts)) {
      return {
        error: "invalid_request",
        description:
          "redirect_uri host is not allowed by this deployment. It may have been registered " +
          "before the operator restricted REAI_ALLOWED_REDIRECT_HOSTS; register again.",
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

/** Stable fingerprint of a sealed authorization request, for binding step 2 to step 1. */
function bindingOf(sealedRequest: string): string {
  return createHash("sha256").update(sealedRequest, "utf8").digest("base64url").slice(0, 32);
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

/** Host (not full URI) membership test; loopback is always permitted for local clients. */
export function isRedirectHostAllowed(uri: string, allowedHosts: readonly string[]): boolean {
  let hostname: string;
  try {
    hostname = new URL(uri).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (isLoopback(hostname)) return true;
  return allowedHosts.some((allowed) => allowed === hostname);
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * `formActionTarget` is the redirect_uri this page's form will end up at, and omitting it breaks the flow in
 * Safari ONLY.
 *
 * The consent form posts to /authorize — same origin, allowed by `form-action 'self'` — and /authorize answers
 * 302 to the client's redirect_uri on claude.ai. WebKit applies form-action to the REDIRECT of a form submission,
 * not just its immediate action, so it blocks that hop; Chrome and Firefox check only the action. The visible
 * symptom is the button spinning briefly and then nothing at all, with no console error and no network failure
 * — and every non-browser check passes, because curl and `scripts/smoke-http.mjs` follow the 302 themselves.
 * That is how this shipped: 29/29 end-to-end checks green against a flow no iPhone could complete.
 *
 * Pass the request's ALREADY-VALIDATED redirect_uri. It is widened to that one origin rather than to the
 * configured host allowlist, so a deployment permitting several clients still only ever names the one this
 * request is actually going to.
 */
export function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
  formActionTarget?: string,
): void {
  let formAction = "'self'";
  if (formActionTarget) {
    try {
      const { origin } = new URL(formActionTarget);
      // Only http(s). A custom-scheme loopback redirect (native clients use those) is not a form-action
      // source, and naming it would make the directive unparseable rather than permissive.
      if (origin !== "null" && /^https?:$/.test(new URL(formActionTarget).protocol)) {
        formAction = `'self' ${origin}`;
      }
    } catch {
      // A redirect_uri that will not parse cannot be reached anyway; leave the directive at its tightest.
    }
  }
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; ` +
      "frame-ancestors 'none'",
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

/**
 * Distinguishable so callers can answer 413 rather than 500, and so a caller that
 * wraps the read in a JSON.parse try/catch does not report an oversized body as
 * "Body must be JSON." — which is what /register did, telling an operator exactly
 * the wrong thing.
 */
export class BodyTooLargeError extends Error {
  readonly limitBytes: number;
  constructor(limitBytes: number) {
    super(`Request body exceeds the ${limitBytes}-byte limit.`);
    this.name = "BodyTooLargeError";
    this.limitBytes = limitBytes;
  }
}

/** Bounds on discarding the remainder of a body we have already decided to reject. */
const DISCARD_MAX_BYTES = 32 * 1024 * 1024;
const DISCARD_MAX_MS = 5000;

/** Thrown when the rest of an oversized body could not be discarded within bounds. */
export class BodyAbandonedError extends Error {
  constructor() {
    super("Request body exceeded the limit and could not be drained.");
    this.name = "BodyAbandonedError";
  }
}

/**
 * Read and size-limit a request body.
 *
 * Two things here are deliberate, and both were settled by measurement rather than
 * reasoning.
 *
 * It does not use `for await (const chunk of req)`: throwing out of an async iterator
 * destroys the request stream, and Node tears the socket down with it — including
 * response bytes already written but not yet flushed.
 *
 * And on overflow it keeps reading, discarding as it goes, instead of answering at
 * once. A client that has already queued megabytes is still sending when we decide to
 * reject it; closing with unread data in the receive buffer makes the OS send RST, and
 * an RST discards whatever sits in the *client's* receive buffer — including the 413
 * that explains what went wrong. Measured over 50 uploads of a 2 MB body against a
 * 512 KB limit: answering immediately delivered the 413 to 36 of them, answering and
 * then lingering to 42, and draining to completion first to all 50. Memory stays flat
 * because discarded bytes are never retained. The ceilings below stop a genuinely
 * unbounded upload, and a client that trips them gets a reset — the right answer for
 * something that is no longer a mistake.
 */
export function readBody(req: IncomingMessage, limitBytes = 1024 * 512): Promise<string> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let total = 0;
    let overflowed = false;
    let settled = false;
    let discardTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (discardTimer) clearTimeout(discardTimer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const abandon = (): void => {
      done(() => {
        req.destroy();
        reject(new BodyAbandonedError());
      });
    };
    const onData = (chunk: Buffer | string): void => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (overflowed) {
        if (total > DISCARD_MAX_BYTES) abandon();
        return;
      }
      if (total > limitBytes) {
        // Release what we have and switch to discarding, so the client can finish
        // sending and we can close with nothing left unread.
        overflowed = true;
        chunks = [];
        discardTimer = setTimeout(abandon, DISCARD_MAX_MS);
        discardTimer.unref();
        return;
      }
      chunks.push(buf);
    };
    const onEnd = (): void =>
      done(() =>
        overflowed
          ? reject(new BodyTooLargeError(limitBytes))
          : resolve(Buffer.concat(chunks).toString("utf8")),
      );
    const onError = (err: Error): void => done(() => reject(err));
    const onAborted = (): void =>
      done(() => reject(new Error("The client disconnected before the body was received.")));

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}

/**
 * Answer an oversized body and end the connection.
 *
 * Throwing out of `for await (const chunk of req)` destroys the request stream
 * mid-body, which leaves the HTTP parser unable to advance past the bytes still
 * arriving. Writing a response and leaving keep-alive on therefore produced a
 * connection that answered nothing further and was not closed either — it sat open
 * until the 128-second socket timeout, and a caller could hold many of them for the
 * cost of a partial upload and no credentials. Announcing `Connection: close` and
 * ending the socket makes the outcome immediate and unambiguous.
 */
export function sendPayloadTooLarge(res: ServerResponse, description: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify({ error: "payload_too_large", error_description: description });
  res.writeHead(413, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    Connection: "close",
  });
  // readBody has already drained the request, so nothing is left unread to provoke an
  // RST. Close only once the response has actually been written: ending the socket
  // alongside res.end() raced the flush.
  res.end(body, () => {
    res.socket?.end();
  });
}
