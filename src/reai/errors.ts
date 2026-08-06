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
  403: "The token authenticated but lacks permission for this tenant or operation. Confirm the tenantId is one returned by reai_whoami, and that the user's role allows it.",
  404: "Not found. Either the id does not exist, or the resource belongs to a different tenant than the one requested — check tenantId.",
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
