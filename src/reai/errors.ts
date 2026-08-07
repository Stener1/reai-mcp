/**
 * ReAI returns RFC 7807 `application/problem+json` for errors. Preserving the
 * `detail` field matters a lot: it carries the actual accounting complaint
 * ("voucher is not balanced", "account 3000 requires a VAT code"), which is what
 * an agent needs in order to correct itself and retry.
 */
export type ProblemDetails = {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  /** Field-level validation errors, when the API supplies them. */
  errors?: unknown;
  [key: string]: unknown;
};

export class ReaiApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly problem: ProblemDetails | undefined;
  readonly rawBody: string;
  readonly requestId: string | undefined;

  constructor(args: {
    status: number;
    method: string;
    path: string;
    problem?: ProblemDetails;
    rawBody: string;
    requestId?: string;
  }) {
    super(ReaiApiError.describe(args));
    this.name = "ReaiApiError";
    this.status = args.status;
    this.method = args.method;
    this.path = args.path;
    this.problem = args.problem;
    this.rawBody = args.rawBody;
    this.requestId = args.requestId;
  }

  private static describe(args: {
    status: number;
    method: string;
    path: string;
    problem?: ProblemDetails;
    rawBody: string;
  }): string {
    const p = args.problem;
    const headline = p?.detail || p?.title || args.rawBody.slice(0, 400) || "(empty response body)";
    let msg = `ReAI ${args.method} ${args.path} failed with HTTP ${args.status}: ${headline}`;
    if (p?.errors) {
      msg += `\nValidation errors: ${JSON.stringify(p.errors).slice(0, 800)}`;
    }
    const hint = ERROR_HINTS[args.status];
    if (hint) msg += `\nHint: ${hint}`;
    return msg;
  }

  /** True when retrying the identical request could plausibly succeed. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

const ERROR_HINTS: Record<number, string> = {
  400: "The request body or query parameters were rejected. Call reai_describe_endpoint for this path to check required fields, types and formats (dates are ISO yyyy-MM-dd).",
  401: "The API token is missing, expired or malformed. Verify REAI_USER_API_TOKEN, or re-authorize the connector.",
  // This hint is keyed on status alone, so it is appended to EVERY 403 regardless
  // of path — which is why it must not assert a cause. An earlier version said to
  // assume a disabled module, and ReAI also enforces granular role permissions
  // (tenant:invoice:read and the like), so that would have told an agent to give up
  // on a feature when the real problem was an actionable missing role. Both
  // possibilities are offered, and the detail decides. The module-specific advice,
  // including the empty-body case, lives in the module-gating quirk instead, where
  // it is scoped to the endpoints that actually gate.
  403: "Two quite different causes. Either the tenant does not have the MODULE this endpoint belongs to — the detail usually says so outright (\"Project module is disabled\") — or the user's role lacks a permission for it. Read the detail before deciding which: if it names a module, the feature is off and no role change helps; if it is absent or generic, confirm the tenantId is one returned by reai_whoami and check the role. Call reai_describe_endpoint for known quirks on the path, some of which return 403 with an empty body.",
  // Two different meanings, and the detail says which. "No static resource api/..."
  // means the ROUTE does not exist — a typo or wrong capitalisation — and sending the
  // agent to check tenantId for that wastes calls on the wrong thing. Several
  // endpoints also express an empty state as 404, which is neither a missing id nor a
  // tenant problem.
  404: "Read the detail before deciding what this means. \"No static resource api/...\" means the ROUTE does not exist — check spelling and capitalisation (routes are case-sensitive) and use reai_search_endpoints; do NOT change tenantId. Otherwise the id may not exist, the resource may belong to a different tenant, or nothing has been set up yet — several endpoints report an empty state as 404, and reai_describe_endpoint lists the ones that do.",
  409: "Conflict. The resource is in a state that forbids this change (for example a posted voucher in a closed accounting period, or a duplicate number).",
  415: "Unsupported media type. This endpoint likely expects multipart/form-data (a file upload) rather than JSON.",
  422: "The payload was well-formed but semantically invalid for accounting rules — most often an unbalanced voucher, or a missing/incorrect VAT code.",
  429: "Rate limited. Back off and retry.",
};

/** Network failure, DNS error, or timeout — no HTTP response was received. */
export class ReaiTransportError extends Error {
  readonly method: string;
  readonly path: string;
  override readonly cause: unknown;

  constructor(args: { method: string; path: string; cause: unknown; timeoutMs?: number }) {
    const c = args.cause;
    const reason =
      c instanceof Error && c.name === "AbortError"
        ? `request timed out after ${args.timeoutMs}ms`
        : c instanceof Error
          ? c.message
          : String(c);
    super(`ReAI ${args.method} ${args.path} could not reach the API: ${reason}`);
    this.name = "ReaiTransportError";
    this.method = args.method;
    this.path = args.path;
    this.cause = args.cause;
  }
}

/** A configuration problem on our side — surfaced without ever echoing the token. */
export class ReaiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReaiConfigError";
  }
}
