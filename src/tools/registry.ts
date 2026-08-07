import { z, type ZodRawShape } from "zod";
import type { ReaiClient } from "../reai/client.js";
import type { ServerConfig } from "../config.js";
import type { Risk } from "../policy.js";
import type { HttpMethod } from "../reai/client.js";

export type SessionState = {
  /** Tenant chosen at runtime via `reai_use_tenant`; overrides the env default. */
  activeTenantId?: number;
};

export type ToolContext = {
  client: ReaiClient;
  config: ServerConfig;
  session: SessionState;
};

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

export type ToolDef<S extends ZodRawShape = ZodRawShape> = {
  name: string;
  title: string;
  description: string;
  risk: Risk;
  /**
   * The API operations this tool calls, as [method, spec path] pairs.
   *
   * Declared so a test can assert that `risk` is never more permissive than what
   * `classifyRequest` would say about the same paths. Without it, the worst bug
   * class in this codebase — a curated tool that quietly does what the escape
   * hatch refuses — has no automated guard, because the method and path are
   * buried inside each handler where nothing can introspect them.
   */
  apiPaths?: ReadonlyArray<readonly [HttpMethod, string]>;
  inputSchema: S;
  /** Signals a genuinely destructive call so clients can prompt the user. */
  destructive?: boolean;
  /**
   * True when the tool sends something outside the tenant. Such tools are hidden
   * unless REAI_ALLOW_EXTERNAL_SEND is set, independently of the write mode.
   */
  transmits?: boolean;
  /** True when repeated identical calls have no additional effect. */
  idempotent?: boolean;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

/** Helper that keeps `inputSchema` inference while pinning the handler's arg type. */
export function defineTool<S extends ZodRawShape>(
  def: Omit<ToolDef<S>, "handler"> & {
    handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolResult>;
  },
): ToolDef<S> {
  return {
    ...def,
    handler: (args, ctx) => def.handler(args as z.infer<z.ZodObject<S>>, ctx),
  } as ToolDef<S>;
}

/**
 * Responses are capped before they reach the model. A single ReAI list call can
 * return hundreds of kilobytes (the voucher list on a modest tenant is already
 * ~28 KB), which would crowd out the conversation for no benefit.
 */
const MAX_RESULT_CHARS = 24_000;

export function ok(data: unknown, opts: { note?: string; link?: string } = {}): ToolResult {
  const parts: string[] = [];
  if (opts.note) parts.push(opts.note);
  if (opts.link) parts.push(`Open in ReAI: ${opts.link}`);

  let body = stringify(data);
  if (body.length > MAX_RESULT_CHARS) {
    // Truncation must never leave a value that LOOKS complete. Cutting the string at
    // a byte offset splits tokens, so a ledger could end `"closingBalance": 481`
    // where the figure was 4812.60 — a plausible wrong number, silently, in an
    // accounting answer. A note above it does not help: the number reads as finished.
    if (Array.isArray(data)) {
      // An array can be cut at an ITEM boundary and re-serialised, so what remains is
      // always valid JSON and every value in it is whole.
      const shown = countFittingSerialized(data);
      body = stringify(data.slice(0, shown));
      parts.push(
        shown === 0
          ? `NOTE: nothing is shown — the FIRST item alone exceeds the ${MAX_RESULT_CHARS}-character ` +
              `limit, so no whole item fits. Fetch it by id, or use a tool that returns a summary ` +
              `rather than the full record.`
          : `NOTE: response truncated — showing the first ${shown} of ${data.length} items, complete. ` +
              `Narrow the result with date, status or id filters, or use the limit/page parameters.`,
      );
    } else {
      // Otherwise drop back to a line boundary and discard the final line, which may
      // be a partial token. JSON.stringify with indentation puts each scalar on its
      // own line, so a whole-line cut cannot split a number or a string.
      const cut = body.slice(0, MAX_RESULT_CHARS);
      const lastNewline = cut.lastIndexOf("\n");
      body = lastNewline > 0 ? cut.slice(0, lastNewline) : "";
      parts.push(
        `NOTE: response truncated at about ${MAX_RESULT_CHARS} characters and is NOT valid JSON — ` +
          `it stops at a line boundary, so no value shown is partial, but fields after the cut are ` +
          `missing entirely. Request a narrower slice rather than reading totals from this.`,
      );
    }
  }

  const text = parts.length ? `${parts.join("\n")}\n\n${body}` : body;
  return { content: [{ type: "text", text }] };
}

/** A plain textual answer, for tools whose output is prose rather than data. */
export function okText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function stringify(data: unknown): string {
  if (data === null || data === undefined) return "(no content)";
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

/** How many leading array items fit inside the character budget. */
/**
 * The largest prefix of `items` whose ACTUAL serialization fits the cap.
 *
 * Measured by serializing the prefix, not by adding up the items. Summing
 * `stringify(item)` undercounted badly: it omits the indentation and commas that
 * array serialization adds, and `stringify` returns a string value unquoted and
 * unescaped, so a list of strings contributed almost nothing to the estimate. The
 * effect was a "truncated" response LARGER than the cap — 4000 ordinary objects came
 * out at 29216 characters against a 24000 limit, and 10000 empty strings at 60165.
 *
 * Binary search rather than a linear walk: each probe serializes up to the whole
 * prefix, so a walk would be quadratic on a long list.
 */
function countFittingSerialized(items: unknown[]): number {
  if (items.length === 0) return 0;
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (stringify(items.slice(0, mid)).length <= MAX_RESULT_CHARS) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Shared `tenantId` argument. Every tenant-scoped tool accepts it. */
export const tenantIdArg = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    "ReAI tenant (company) id. Omit to use the active tenant — set one with reai_use_tenant, " +
      "or list what this token can reach with reai_whoami.",
  );

/**
 * Resolve which tenant a call applies to.
 *
 * ReAI user tokens can reach several companies, and silently guessing the wrong
 * one would write real bookkeeping data into the wrong set of books — so an
 * ambiguous call fails loudly instead.
 */
export function resolveTenantId(explicit: number | undefined, ctx: ToolContext): number | undefined {
  const bound = ctx.config.boundTenantId;
  if (bound !== undefined) {
    // A bound tenant is a boundary, not a preference. Reject rather than
    // silently redirect, so the caller learns why instead of quietly reading
    // the wrong company's books.
    const requested = explicit ?? ctx.session.activeTenantId;
    if (requested !== undefined && requested !== bound) {
      throw new Error(
        `This connection is bound to tenant ${bound}, so it cannot address tenant ${requested}.\n` +
          `The tenant was chosen when the connector was authorized. To work in a different ` +
          `company, re-authorize the connection and select that company.`,
      );
    }
    return bound;
  }
  return explicit ?? ctx.session.activeTenantId ?? ctx.config.defaultTenantId;
}

export function requireTenantId(explicit: number | undefined, ctx: ToolContext): number {
  const id = resolveTenantId(explicit, ctx);
  if (id === undefined) {
    throw new Error(
      "No tenant selected. This endpoint is tenant-scoped, so a tenant id is required.\n" +
        "Call reai_whoami to see the companies this token can reach, then either pass tenantId " +
        "explicitly or call reai_use_tenant to set it for the session " +
        "(or start the server with REAI_TENANT_ID).",
    );
  }
  return id;
}

/** ISO `yyyy-MM-dd`, which is what every date field in the ReAI API expects. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be ISO format yyyy-MM-dd, e.g. 2026-03-31");

export function today(): string {
  return norwegianDate(new Date());
}

/**
 * The current date in Norway, not in UTC.
 *
 * `toISOString()` is UTC, so between midnight and 01:00 or 02:00 Norwegian time every
 * date default was a day early. That is mostly cosmetic and once a year it is not: at
 * 00:30 on 1 January, an order or offer defaulting its date would be stamped 31
 * December of the year just ended — posting revenue and VAT into a period that may
 * already be closed, which under bokføringsloven cannot simply be corrected by
 * deleting. The books are Norwegian, so the date should be too.
 *
 * "sv-SE" is used because its short date format is already YYYY-MM-DD.
 */
export function norwegianDate(when: Date): string {
  return when.toLocaleDateString("sv-SE", { timeZone: "Europe/Oslo" });
}

/**
 * ReAI requires an explicit `startDate` on vouchers, postings and ledger reads.
 * Defaulting to the start of the current calendar year matches how a Norwegian
 * accounting year is normally scoped and saves a failed round-trip.
 */
export function startOfYear(): string {
  // Also Norwegian: in the same small hours window getUTCFullYear() reports the
  // previous year, so "what have we spent this year" would answer for last year.
  return `${norwegianDate(new Date()).slice(0, 4)}-01-01`;
}
