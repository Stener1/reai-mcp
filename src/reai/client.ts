import { ReaiApiError, ReaiConfigError, ReaiTransportError, type ProblemDetails } from "./errors.js";
import { hasAmbiguousSegments } from "../policy.js";

export const DEFAULT_BASE_URL = "https://app.reai.no";

export type ReaiClientOptions = {
  /** ReAI user API token. Sent as `Authorization: Bearer <token>`. */
  token: string;
  baseUrl?: string;
  /** Tenant applied to requests that do not name one explicitly. */
  defaultTenantId?: number;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  /** Called once per completed request. Used for stderr logging; never receives the token. */
  onRequest?: (event: RequestLogEvent) => void;
};

export type RequestLogEvent = {
  method: string;
  path: string;
  status: number | "error";
  durationMs: number;
  tenantId?: number;
  retries: number;
};

export type RequestOptions = {
  method: HttpMethod;
  path: string;
  query?: Record<string, unknown> | undefined;
  body?: unknown;
  tenantId?: number | undefined;
  /** Skip the tenant header entirely — for meta endpoints like /api/me. */
  omitTenant?: boolean;
  /** Expect binary content (PDFs, attachment downloads) rather than JSON. */
  binary?: boolean;
  /**
   * Extra request headers. Names are lowercased before use, and `authorization`, `x-tenant-id` and
   * `content-type` are REFUSED — this client owns those three. Pass `tenantId` for the tenant.
   */
  headers?: Record<string, string>;
  timeoutMs?: number;
};

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ReaiResponse<T = unknown> = {
  status: number;
  /** Parsed JSON, decoded text, or `{ base64, contentType, bytes }` for binary. */
  data: T;
  contentType: string | undefined;
  location: string | undefined;
};

export type BinaryPayload = {
  base64: string;
  contentType: string;
  bytes: number;
  filename?: string;
};

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const MAX_ERROR_BODY = 4000;

/**
 * Methods that may be retried after an *ambiguous* failure — one where the
 * request might already have reached ReAI and been committed.
 *
 * This matters more here than in most API clients. `POST /api/vouchers` is not
 * idempotent and carries no idempotency key, so retrying it after a lost
 * response can book the same voucher twice into real accounting records, where
 * the duplicate cannot simply be deleted once the period closes. A gateway
 * timeout is exactly the case where the write most likely *did* land.
 *
 * DELETE is included because ReAI treats a repeated delete as already-deleted
 * rather than as a second destructive act.
 */
const RETRY_SAFE_METHODS = new Set(["GET", "HEAD", "DELETE"]);

/**
 * 429 is different from the 5xx family: it means the request was rejected
 * *before* being processed, so retrying it cannot duplicate anything.
 */
function mayRetry(method: string, cause: "status-429" | "ambiguous"): boolean {
  return cause === "status-429" || RETRY_SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Headers a caller may not set, because each one is a boundary the caller is on the wrong side of.
 *
 * Refused rather than dropped, which is the same choice `buildUrl` makes below for an ambiguous
 * path segment: "refuse rather than resolve it silently". Nothing in this repository passes any of
 * these — verified across every `client.request` call site — so a caller who does is a programming
 * error or an attack, and silently binding their request to a different company than they asked for
 * is how that becomes a post-mortem instead of a stack trace. The obvious way to write a
 * cross-tenant probe is `headers: {"X-Tenant-Id": n}`; this tells that author to pass `tenantId`.
 *
 * `authorization` is on the list for a stronger reason than the tenant: substituting the bearer
 * token is a larger break than redirecting one request, and it sat one line above the tenant header
 * unprotected while that one was being fixed.
 */
const RESERVED_HEADERS = new Set(["authorization", "x-tenant-id", "content-type"]);

function normaliseCallerHeaders(supplied: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(supplied ?? {})) {
    const lower = name.toLowerCase();
    if (RESERVED_HEADERS.has(lower)) {
      throw new ReaiConfigError(
        `The ${lower} header is set by this client and cannot be supplied by a caller. ` +
          (lower === "x-tenant-id"
            ? "Pass `tenantId` on the request instead — the tenant is a boundary, not a header."
            : lower === "authorization"
              ? "The token comes from the client's configuration."
              : "It follows from the body being JSON or multipart."),
      );
    }
    // Lowercased so the internal object cannot hold two keys for one header. This is tidiness, not
    // the guard: `Headers` normalises names anyway, so keeping the caller's casing here changes
    // nothing observable — measured, and stated because an unfalsifiable line invites being read as
    // load-bearing. The refusal above is what does the work.
    out[lower] = value;
  }
  return out;
}

export class ReaiClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onRequest: ((event: RequestLogEvent) => void) | undefined;
  defaultTenantId: number | undefined;

  constructor(opts: ReaiClientOptions) {
    if (!opts.token || !opts.token.trim()) {
      throw new ReaiConfigError(
        "No ReAI API token supplied. Set REAI_USER_API_TOKEN (get one from app.reai.no → settings → API tokens).",
      );
    }
    this.token = opts.token.trim();
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.defaultTenantId = opts.defaultTenantId;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.onRequest = opts.onRequest;
  }

  /** Build a UI deep link. ReAI's UI needs `?tenantId=` to open the right company. */
  deepLink(uiPath: string, tenantId?: number): string {
    const tid = tenantId ?? this.defaultTenantId;
    const path = uiPath.startsWith("/") ? uiPath : `/${uiPath}`;
    const url = new URL(this.baseUrl + path);
    if (tid !== undefined) url.searchParams.set("tenantId", String(tid));
    return url.toString();
  }

  async request<T = unknown>(opts: RequestOptions): Promise<ReaiResponse<T>> {
    const url = this.buildUrl(opts.path, opts.query);
    const tenantId = opts.omitTenant ? undefined : (opts.tenantId ?? this.defaultTenantId);
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    // Header names are LOWERCASE throughout, which is not cosmetic. HTTP names are
    // case-insensitive but object keys are not, so `{"content-type": x, "Content-Type": y}` is two
    // keys for one header, and undici resolves that by comma-FOLDING them into `x, y` — with the
    // caller's value first, because the spread came first. Measured on the pre-fix build: a caller
    // passing `x-tenant-id: 2634` against bound tenant 2783 put `X-Tenant-Id: 2634, 2783` on the
    // wire. Upstream answered 400, but for the wrong reason — the folded value fails an integer
    // parse. A genuine duplicate (two header lines, which an HTTP/2 path or a Headers instance
    // would produce) is NOT rejected: upstream honours the FIRST value, so the same shape would
    // have crossed with 200. Lowercasing every name means a collision is an overwrite, which is a
    // thing one can reason about, instead of a fold.
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: opts.binary ? "*/*" : "application/json",
      "user-agent": "reai-mcp",
      ...normaliseCallerHeaders(opts.headers),
    };
    if (tenantId !== undefined) headers["x-tenant-id"] = String(tenantId);

    let payload: RequestInit["body"];
    if (opts.body instanceof FormData) {
      payload = opts.body; // fetch sets the multipart boundary itself
    } else if (opts.body !== undefined && opts.body !== null) {
      payload = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }

    const started = Date.now();
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(backoffMs(attempt));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method: opts.method,
          headers,
          body: payload,
          signal: controller.signal,
        });

        if (!res.ok) {
          const raw = (await safeText(res)).slice(0, MAX_ERROR_BODY);
          const err = new ReaiApiError({
            status: res.status,
            method: opts.method,
            path: opts.path,
            problem: parseProblem(raw),
            rawBody: raw,
            requestId: res.headers.get("x-request-id") ?? undefined,
          });
          if (
            RETRYABLE_STATUSES.has(res.status) &&
            attempt < this.maxRetries &&
            mayRetry(opts.method, res.status === 429 ? "status-429" : "ambiguous")
          ) {
            lastError = err;
            continue;
          }
          this.log(opts, res.status, started, attempt, tenantId);
          throw err;
        }

        this.log(opts, res.status, started, attempt, tenantId);
        return {
          status: res.status,
          data: (await this.parseBody(res, opts.binary === true)) as T,
          contentType: res.headers.get("content-type") ?? undefined,
          location: res.headers.get("location") ?? undefined,
        };
      } catch (err) {
        if (err instanceof ReaiApiError) throw err;
        lastError = err;
        // A transport failure is the ambiguous case: the write may already have
        // been committed, so only retry methods where repeating it is harmless.
        const isLast = attempt === this.maxRetries || !mayRetry(opts.method, "ambiguous");
        if (isLast) {
          this.log(opts, "error", started, attempt, tenantId);
          throw new ReaiTransportError({
            method: opts.method,
            path: opts.path,
            cause: err,
            timeoutMs,
          });
        }
      } finally {
        clearTimeout(timer);
      }
    }

    // Only reachable if the loop exhausted retries on a retryable HTTP status.
    if (lastError instanceof ReaiApiError) throw lastError;
    throw new ReaiTransportError({ method: opts.method, path: opts.path, cause: lastError, timeoutMs });
  }

  private log(
    opts: RequestOptions,
    status: number | "error",
    started: number,
    attempt: number,
    tenantId: number | undefined,
  ): void {
    this.onRequest?.({
      method: opts.method,
      path: opts.path,
      status,
      durationMs: Date.now() - started,
      tenantId,
      retries: attempt,
    });
  }

  private buildUrl(path: string, query?: Record<string, unknown>): string {
    if (/^https?:\/\//i.test(path)) {
      throw new ReaiConfigError(
        `Expected an API path such as "/api/customers", got an absolute URL: ${path}`,
      );
    }
    // Defence in depth. Callers are expected to have canonicalized already
    // (see canonicalizeApiPath); a dot segment or backslash arriving here means
    // the path the write policy classified is not the path about to be
    // requested, so refuse rather than resolve it silently.
    if (hasAmbiguousSegments(path)) {
      throw new ReaiConfigError(
        `Refusing a path containing relative or encoded path segments: ${path}. ` +
          `Pass a fully resolved path such as "/api/customers/1234".`,
      );
    }
    const url = new URL(this.baseUrl + (path.startsWith("/") ? path : `/${path}`));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        // Comma-joined, not repeated keys. The only array query parameter in the
        // ReAI API (`include` on the bank-reconciliation view) declares
        // `style: form, explode: false`, i.e. ?include=a,b.
        const parts = value.filter((v) => v !== undefined && v !== null).map(String);
        if (parts.length > 0) url.searchParams.set(key, parts.join(","));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async parseBody(res: Response, binary: boolean): Promise<unknown> {
    if (res.status === 204) return null;
    const contentType = res.headers.get("content-type") ?? "";

    if (binary || isBinaryContentType(contentType)) {
      const buf = Buffer.from(await res.arrayBuffer());
      const payload: BinaryPayload = {
        base64: buf.toString("base64"),
        contentType: contentType.split(";")[0]?.trim() || "application/octet-stream",
        bytes: buf.byteLength,
      };
      const filename = filenameFromDisposition(res.headers.get("content-disposition"));
      if (filename) payload.filename = filename;
      return payload;
    }

    const text = await safeText(res);
    if (!text) return null;
    if (contentType.includes("json")) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  }
}

function isBinaryContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (!ct) return false;
  if (ct.startsWith("text/") || ct.includes("json") || ct.includes("xml")) return false;
  return (
    ct.startsWith("application/pdf") ||
    ct.startsWith("image/") ||
    ct.startsWith("application/octet-stream") ||
    ct.startsWith("application/zip") ||
    ct.includes("spreadsheet") ||
    ct.includes("msword") ||
    ct.includes("officedocument")
  );
}

function filenameFromDisposition(value: string | null): string | undefined {
  if (!value) return undefined;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(value);
  return plain?.[1]?.trim();
}

function parseProblem(raw: string): ProblemDetails | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ProblemDetails;
    }
  } catch {
    /* non-JSON error body; the raw text is kept on the error */
  }
  return undefined;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Exponential backoff with jitter, so parallel tool calls do not retry in lockstep. */
function backoffMs(attempt: number): number {
  const base = Math.min(250 * 2 ** (attempt - 1), 4000);
  return base + Math.floor(Math.random() * 150);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
