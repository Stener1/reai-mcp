import { DEFAULT_BASE_URL } from "./reai/client.js";
import { ReaiConfigError } from "./reai/errors.js";
import type { WriteMode } from "./policy.js";
import { parseWriteMode } from "./policy.js";

export type ServerConfig = {
  baseUrl: string;
  /** Absent in remote mode, where each session supplies its own token. */
  token: string | undefined;
  defaultTenantId: number | undefined;
  /**
   * A hard tenant boundary, not a default.
   *
   * Set in remote mode from the tenant the user picked on the consent page. When
   * present, no tool may address a different tenant — otherwise the consent
   * page's promise ("pick the company this connection should use") would be
   * cosmetic, since a tool argument could silently reach any other company the
   * underlying ReAI token happens to unlock.
   */
  boundTenantId: number | undefined;
  writeMode: WriteMode;
  /**
   * Whether this server may send anything to a third party — EHF/Peppol
   * invoices, invoice emails, payment reminders, signing requests.
   *
   * Off by default, and independent of writeMode. Even REAI_WRITE_MODE=full
   * cannot transmit without this, because a posting can be reversed and a sent
   * invoice cannot be recalled.
   */
  allowExternalSend: boolean;
  timeoutMs: number;
  maxRetries: number;
  /** Log one line per API request to stderr. Never logs tokens. */
  verbose: boolean;
  /**
   * Which curated tool groups to expose. Empty means all of them.
   *
   * The whole premise of this server is that 321 API operations cannot all be
   * tools; as the curated set grows, the same pressure applies to it. An agent
   * doing bookkeeping does not need thirteen purchase-side tools competing for
   * attention, so an operator can narrow the surface without losing coverage —
   * the discovery escape hatch still reaches everything.
   */
  toolsets: string[];

  // --- Remote (connector) mode ---
  port: number;
  /**
   * Public base URL of this deployment. Must match what clients connect to,
   * because it is published in the OAuth metadata documents.
   */
  publicUrl: string | undefined;
  /** Raw REAI_ENCRYPTION_KEY; validated when the sealer is constructed. */
  encryptionKey: string | undefined;
  /**
   * Accept a raw ReAI token in the Authorization header instead of requiring the
   * OAuth flow. Convenient for private deployments, but it means anyone who can
   * reach the URL acts as whoever's token they present.
   */
  allowTokenPassthrough: boolean;
  /**
   * Whether to expose the bank-reconciliation pairing view as an HTML resource.
   *
   * Off by default, because a client that does not render HTML would receive a few
   * kilobytes of markup where it expected an answer — noise in the model's context,
   * for no benefit. Turn it on for a client known to render MCP UI resources.
   *
   * It adds no capability: the view selects, it does not write. Matching still goes
   * through reai_match_bank_transactions and the same write policy.
   */
  enableUi: boolean;
  /** Extra hostnames to accept, for DNS-rebinding protection. */
  allowedHosts: string[];
  /**
   * True when each request builds its own server, i.e. the remote transport.
   * Session-local state cannot persist there, so tools that would set it must say
   * so rather than reporting a success that evaporates.
   */
  statelessSession: boolean;
  /**
   * Hosts permitted as OAuth redirect targets. Empty means "any https host",
   * which is what MCP clients expect but also lets anyone register a client and
   * drive a genuine-looking consent page at their own callback. Operators who
   * know which clients they use should set this.
   */
  allowedRedirectHosts: string[];
};

/**
 * `minimum` exists because zero is meaningful for exactly one of these settings:
 * REAI_MAX_RETRIES=0 means "attempt every request once and never repeat it",
 * which is what you want when writes land in real accounting records. A shared
 * "must be positive" rule made the safest configuration unexpressible. A timeout
 * or a page size of zero is still nonsense, so those keep a minimum of 1.
 */
function intFromEnv(name: string, fallback: number, minimum = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < minimum) {
    throw new ReaiConfigError(
      minimum === 0
        ? `${name} must be zero or a positive number, got "${raw}".`
        : `${name} must be a positive number, got "${raw}".`,
    );
  }
  return Math.floor(n);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const token = env.REAI_USER_API_TOKEN?.trim() || env.REAI_TOKEN?.trim() || undefined;

  let defaultTenantId: number | undefined;
  const rawTenant = env.REAI_TENANT_ID?.trim();
  if (rawTenant) {
    const n = Number(rawTenant);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ReaiConfigError(
        `REAI_TENANT_ID must be a positive integer tenant id (see reai_whoami), got "${rawTenant}".`,
      );
    }
    defaultTenantId = n;
  }

  const publicUrl = env.PUBLIC_URL?.trim() || env.REAI_PUBLIC_URL?.trim();
  if (publicUrl) {
    let parsed: URL;
    try {
      parsed = new URL(publicUrl);
    } catch {
      throw new ReaiConfigError(`PUBLIC_URL must be an absolute URL, got "${publicUrl}".`);
    }
    if (parsed.protocol !== "https:" && !isLoopbackHost(parsed.hostname)) {
      throw new ReaiConfigError(
        `PUBLIC_URL must use https (got "${publicUrl}"). OAuth redirect and metadata URLs are ` +
          "only valid over TLS, except on localhost for development.",
      );
    }
    // Refused rather than half-supported. The consent form posts to a
    // root-relative /authorize, so under a path prefix the user's ReAI token
    // would be sent to the wrong place -- a 404 at best, an unrelated service at
    // worst. Serving under a subpath would need every generated URL to carry the
    // prefix; until that is done, say so instead of failing obscurely.
    // Every OAuth endpoint is formed by concatenation (`${base}/authorize`), so a
    // path, query or fragment all corrupt the result rather than being carried.
    const path = parsed.pathname.replace(/\/+$/, "");
    if (path !== "" || parsed.search !== "" || parsed.hash !== "") {
      const offending = [
        path !== "" ? "a path" : null,
        parsed.search !== "" ? "a query string" : null,
        parsed.hash !== "" ? "a fragment" : null,
      ]
        .filter(Boolean)
        .join(", ");
      throw new ReaiConfigError(
        `PUBLIC_URL must be a bare origin, but "${publicUrl}" contains ${offending}. ` +
          `Endpoint URLs are built by appending to it, so this would produce ` +
          `"${publicUrl}/authorize" instead of a usable authorization endpoint — and the consent ` +
          `form, which posts to a root-relative /authorize, would send the user's ReAI token ` +
          `somewhere else entirely. Use "${parsed.origin}".`,
      );
    }
  }

  return {
    baseUrl: (env.REAI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    token,
    defaultTenantId,
    // Only the remote transport binds a tenant; local stdio uses a plain default.
    boundTenantId: undefined,
    // stdio keeps one long-lived server, so session state persists there.
    statelessSession: false,
    writeMode: parseWriteMode(env.REAI_WRITE_MODE),
    allowExternalSend:
      env.REAI_ALLOW_EXTERNAL_SEND === "1" || env.REAI_ALLOW_EXTERNAL_SEND === "true",
    timeoutMs: intFromEnv("REAI_TIMEOUT_MS", 30_000),
    maxRetries: intFromEnv("REAI_MAX_RETRIES", 2, 0),
    verbose: env.REAI_VERBOSE === "1" || env.REAI_VERBOSE === "true",
    toolsets: parseToolsets(env.REAI_TOOLSETS),
    port: intFromEnv("PORT", 8080),
    publicUrl: publicUrl ? publicUrl.replace(/\/+$/, "") : undefined,
    encryptionKey: env.REAI_ENCRYPTION_KEY?.trim() || undefined,
    enableUi: env.REAI_ENABLE_UI === "1" || env.REAI_ENABLE_UI === "true",
    allowTokenPassthrough:
      env.REAI_ALLOW_TOKEN_PASSTHROUGH === "1" || env.REAI_ALLOW_TOKEN_PASSTHROUGH === "true",
    allowedHosts: splitHosts(env.REAI_ALLOWED_HOSTS),
    allowedRedirectHosts: splitHosts(env.REAI_ALLOWED_REDIRECT_HOSTS),
  };
}

/** Known curated tool groups. `meta` and `discovery` are always on. */
export const TOOLSETS = ["bookkeeping", "sales", "purchase", "bank", "organisation", "assets", "subscriptions", "warehouses", "agreements"] as const;
export type Toolset = (typeof TOOLSETS)[number];

function parseToolsets(raw: string | undefined): string[] {
  const requested = (raw ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (requested.length === 0) return [];

  const unknown = requested.filter((t) => !(TOOLSETS as readonly string[]).includes(t));
  if (unknown.length > 0) {
    throw new ReaiConfigError(
      `REAI_TOOLSETS contains unknown group(s): ${unknown.join(", ")}. ` +
        `Valid groups are ${TOOLSETS.join(", ")}. Leave it unset to enable all of them.`,
    );
  }
  return requested;
}

function splitHosts(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/**
 * The rightmost value of a proxy-appended header.
 *
 * `firstHeader` is right for ordinary headers, where a comma list is not a hop
 * chain. For X-Forwarded-* it is exactly wrong: each proxy appends, so the leftmost
 * entry is client-supplied and the rightmost is the one added by the proxy closest
 * to us — the only one with any claim to being trustworthy.
 */
export function lastForwardedValue(value: string | string[] | undefined): string | undefined {
  const flat = Array.isArray(value) ? value.join(",") : value;
  if (!flat) return undefined;
  const parts = flat.split(",").map((v) => v.trim()).filter(Boolean);
  return parts[parts.length - 1];
}
