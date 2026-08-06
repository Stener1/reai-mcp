import { z, type ZodRawShape } from "zod";
import type { ReaiClient } from "../reai/client.js";
import type { ServerConfig } from "../config.js";
import type { Risk } from "../policy.js";

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
  inputSchema: S;
  /** Signals a genuinely destructive call so clients can prompt the user. */
  destructive?: boolean;
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
    const total = Array.isArray(data) ? data.length : undefined;
    const shown = Array.isArray(data) ? countFitting(data) : undefined;
    body = body.slice(0, MAX_RESULT_CHARS);
    parts.push(
      shown !== undefined && total !== undefined
        ? `NOTE: response truncated — showing roughly the first ${shown} of ${total} items. ` +
            `Narrow the result with date, status or id filters, or use the limit/page parameters.`
        : `NOTE: response truncated at ${MAX_RESULT_CHARS} characters. Request a narrower slice of data.`,
    );
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
function countFitting(items: unknown[]): number {
  let used = 2;
  for (let i = 0; i < items.length; i++) {
    used += stringify(items[i]).length + 2;
    if (used > MAX_RESULT_CHARS) return i;
  }
  return items.length;
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
  return new Date().toISOString().slice(0, 10);
}

/**
 * ReAI requires an explicit `startDate` on vouchers, postings and ledger reads.
 * Defaulting to the start of the current calendar year matches how a Norwegian
 * accounting year is normally scoped and saves a failed round-trip.
 */
export function startOfYear(): string {
  return `${new Date().getUTCFullYear()}-01-01`;
}
