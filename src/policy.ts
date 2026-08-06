import { ReaiConfigError } from "./reai/errors.js";
import type { HttpMethod } from "./reai/client.js";

/**
 * How much damage the server is permitted to do.
 *
 * Accounting data is not ordinary application data: under the Norwegian
 * Bookkeeping Act (bokføringsloven) a posted voucher in a closed period cannot
 * simply be deleted, and a submitted VAT return cannot be unsubmitted. An agent
 * exploring an API by trial and error is therefore genuinely dangerous here, so
 * the default is the middle setting rather than the permissive one.
 */
export type WriteMode = "read-only" | "reversible" | "full";

export const WRITE_MODES: readonly WriteMode[] = ["read-only", "reversible", "full"] as const;

/**
 * `reversible` is the default: useful out of the box, but it cannot touch the
 * ledger, issue legal documents, move money, or file anything with the state.
 */
export const DEFAULT_WRITE_MODE: WriteMode = "reversible";

export function parseWriteMode(raw: string | undefined): WriteMode {
  const value = raw?.trim().toLowerCase();
  if (!value) return DEFAULT_WRITE_MODE;
  const normalized = value.replace(/[_\s]+/g, "-");
  const aliases: Record<string, WriteMode> = {
    "read-only": "read-only",
    readonly: "read-only",
    read: "read-only",
    ro: "read-only",
    reversible: "reversible",
    safe: "reversible",
    full: "full",
    all: "full",
    write: "full",
    rw: "full",
  };
  const mode = aliases[normalized];
  if (!mode) {
    throw new ReaiConfigError(
      `REAI_WRITE_MODE must be one of ${WRITE_MODES.join(", ")} — got "${raw}".`,
    );
  }
  return mode;
}

export type Risk =
  /** Reads nothing but data. Always allowed. */
  | "read"
  /** Creates or edits master data that can be cleanly deleted again. */
  | "reversible"
  /**
   * Touches the ledger, issues a legal document, moves money, runs payroll,
   * files with the tax authority, or administers users and tenants.
   */
  | "irreversible";

const MODE_ALLOWS: Record<WriteMode, ReadonlySet<Risk>> = {
  "read-only": new Set<Risk>(["read"]),
  reversible: new Set<Risk>(["read", "reversible"]),
  full: new Set<Risk>(["read", "reversible", "irreversible"]),
};

export function isAllowed(risk: Risk, mode: WriteMode): boolean {
  return MODE_ALLOWS[mode].has(risk);
}

/**
 * Path prefixes whose mutations hit the general ledger, produce a legally
 * binding document, move money, or change who can access the tenant.
 * Matched before the reversible list, so more specific entries win.
 */
const IRREVERSIBLE_PREFIXES: readonly string[] = [
  "/api/vouchers",
  "/api/postings",
  "/api/invoices",
  "/api/supplier-invoices",
  "/api/expenses",
  "/api/salary-payments",
  "/api/salary",
  "/api/vat-returns",
  "/api/tax-returns",
  "/api/annual-accounts",
  "/api/amelding",
  "/api/opening-balances",
  "/api/bank-reconciliations",
  "/api/manual-bank-reconciliations",
  "/api/bank-transactions",
  "/api/assets",
  "/api/loans",
  "/api/share-investments",
  "/api/ledger",
  "/api/timesheets",
  // User, tenant and permission administration is not "master data" — it changes
  // who can reach the books at all.
  "/api/users",
  "/api/tenants",
  "/api/admin",
  "/admin",
  // Peppol actually transmits invoices to counterparties over the network.
  "/api/peppol",
];

/** Master data: reference records an agent can safely create and clean up. */
const REVERSIBLE_PREFIXES: readonly string[] = [
  "/api/customers",
  "/api/suppliers",
  "/api/products",
  "/api/departments",
  "/api/projects",
  "/api/warehouses",
  "/api/employees",
  "/api/offers",
  "/api/orders",
  "/api/leads",
  "/api/agreements",
  "/api/documents",
  "/api/attachments",
  "/api/company-banks",
  "/api/general-sub-accounts",
  "/api/debtors",
  "/api/creditors",
  "/api/subscriptions",
  "/api/reconciliation-rules",
  "/api/accountant-clients",
  "/api/invoice-reception-documents",
  "/api/receipt-reception-documents",
  "/api/chart-of-accounts",
];

/**
 * Sub-paths that escalate an otherwise-reversible resource, because they settle
 * money or transmit a document rather than editing a record.
 */
const ESCALATING_SEGMENTS: readonly string[] = [
  "/payments",
  "/payment",
  "/sign-request",
  "/sign-requests",
  "/send",
  "/complete",
  "/registration",
  "/supplier-invoice",
  "/invoice",
  "/credit-note",
  "/book",
  "/post",
];

function matchesPrefix(path: string, prefixes: readonly string[]): boolean {
  const p = path.toLowerCase();
  return prefixes.some((prefix) => p === prefix || p.startsWith(prefix + "/"));
}

/** Opaque base used only to resolve relative paths; never contacted. */
const PATH_RESOLUTION_BASE = "https://reai-mcp.invalid";

/**
 * Resolve a caller-supplied path to the exact form the HTTP layer will request.
 *
 * This must be applied *before* classification, and the same result must be the
 * path actually sent. `new URL()` resolves `..`, `.`, backslashes and
 * percent-encoded dot segments, so classifying the raw string while requesting
 * the resolved one lets a caller straddle two different paths: the string
 * `/api/customers/../vouchers` matches the reversible `/api/customers` prefix
 * but lands on `/api/vouchers`, posting to the general ledger from a mode that
 * forbids it.
 *
 * Returns undefined for anything that does not resolve to a path on our own
 * origin — which also rejects an absolute URL pointing at another host.
 */
export function canonicalizeApiPath(
  rawPath: string,
): { pathname: string; search: string } | undefined {
  const trimmed = rawPath.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed, PATH_RESOLUTION_BASE);
  } catch {
    return undefined;
  }
  if (url.origin !== PATH_RESOLUTION_BASE) return undefined;

  // `new URL()` resolves literal dot segments but deliberately leaves an
  // *encoded* slash alone, so "/api/customers/..%2fvouchers" survives resolution
  // intact. Whether the upstream server then collapses it is not ours to assume,
  // so anything still ambiguous after resolution is refused outright.
  if (hasAmbiguousSegments(url.pathname)) return undefined;

  return { pathname: url.pathname, search: url.search };
}

/**
 * Detects path segments whose meaning depends on who decodes them: encoded
 * slashes and backslashes, and any surviving `.`/`..` segment.
 */
export function hasAmbiguousSegments(path: string): boolean {
  if (/%2f|%5c/i.test(path)) return true;
  const decoded = path.replace(/%2e/gi, ".");
  if (decoded.includes("\\")) return true;
  return decoded.split("/").some((segment) => segment === "." || segment === "..");
}

/**
 * Classify an arbitrary API call. Used by the generic `reai_request` escape
 * hatch, where the target is not known ahead of time.
 *
 * Unknown write paths are classified `irreversible` on purpose: in an accounting
 * system, failing closed on something unrecognised is the only safe default.
 */
export function classifyRequest(method: HttpMethod, path: string): Risk {
  if (method === "GET") return "read";

  // Canonicalize first: classifying a raw string that resolves to a different
  // path is how a reversible-looking call reaches the ledger. A path we cannot
  // resolve is treated as the most dangerous case.
  const canonical = canonicalizeApiPath(path);
  if (!canonical) return "irreversible";
  const normalized = normalize(canonical.pathname);

  if (matchesPrefix(normalized, IRREVERSIBLE_PREFIXES)) return "irreversible";

  if (matchesPrefix(normalized, REVERSIBLE_PREFIXES)) {
    // e.g. POST /api/orders/{id}/payments is not reversible master-data editing.
    if (ESCALATING_SEGMENTS.some((seg) => normalized.includes(seg + "/") || normalized.endsWith(seg))) {
      return "irreversible";
    }
    return "reversible";
  }

  return "irreversible";
}

/** Strip the query string and trailing slash; lowercase for prefix comparison. */
function normalize(path: string): string {
  const withoutQuery = path.split("?")[0] ?? path;
  const trimmed = withoutQuery.replace(/\/+$/, "") || "/";
  return trimmed.startsWith("/") ? trimmed.toLowerCase() : "/" + trimmed.toLowerCase();
}

export class WriteBlockedError extends Error {
  readonly risk: Risk;
  readonly mode: WriteMode;

  constructor(args: { risk: Risk; mode: WriteMode; what: string }) {
    super(
      `Blocked by write policy: ${args.what} is classified "${args.risk}", ` +
        `but this server runs in REAI_WRITE_MODE=${args.mode}.\n` +
        explain(args.risk, args.mode),
    );
    this.name = "WriteBlockedError";
    this.risk = args.risk;
    this.mode = args.mode;
  }
}

function explain(risk: Risk, mode: WriteMode): string {
  if (risk === "irreversible") {
    return (
      "Operations in this class post to the general ledger, issue legal documents, move money, " +
      "run payroll, file with the tax authority, or administer users — none of which can be " +
      'cleanly undone. To allow them, restart the server with REAI_WRITE_MODE=full. ' +
      "Do not enable this against production books you are not prepared to correct by hand."
    );
  }
  if (mode === "read-only") {
    return "This server is read-only. To allow master-data changes, set REAI_WRITE_MODE=reversible.";
  }
  return `Set REAI_WRITE_MODE to a level that permits "${risk}".`;
}

/** Throws unless `risk` is permitted under `mode`. */
export function assertAllowed(risk: Risk, mode: WriteMode, what: string): void {
  if (!isAllowed(risk, mode)) throw new WriteBlockedError({ risk, mode, what });
}
