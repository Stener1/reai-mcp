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
  // Restates stock quantity and valuation, which is a balance-sheet input. The only
  // correction is an offsetting adjustment, which is precisely the reverse-don't-delete
  // property that puts vouchers in this tier.
  "/api/warehouses/inventory/adjust",
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
  // Note the path really is "manual-reconciliations", with no "bank" segment.
  // An earlier "/api/manual-bank-reconciliations" entry here matched nothing;
  // those endpoints were only protected by the unknown-path fail-closed rule.
  "/api/manual-reconciliations",
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
  // A reconciliation rule creates no posting itself, but it is standing
  // authority to post: applying it books vouchers, the API documents an
  // auto-reconciliation step at bank-sync time that may act on it without any
  // further call, and deleting the rule does not reverse what it booked.
  // Classified here rather than only on the curated tool -- gating the tool
  // while reai_request still permitted the same call would be theatre.
  "/api/reconciliation-rules",
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
  // Subscription billing: /generate issues a numbered invoice for one
  // subscription, /generate-due does it for every due subscription in the
  // tenant, and activating one arms that schedule. All reachable under
  // /api/subscriptions, which is otherwise reversible master data.
  "/generate",
  "/generate-due",
  "/activate",
  "/deactivate",
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
): { pathname: string; search: string; decodedPathname: string } | undefined {
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

  // The value that gets CLASSIFIED must be the value the upstream server will
  // ROUTE on, and those are not the same string. `new URL()` leaves percent-escapes
  // other than %2f/%5c untouched, while ReAI is ASP.NET and decodes the path before
  // routing — so "/api/agreements/3/sign-reques%74" was classified as an unknown
  // sub-path of the reversible /api/agreements prefix and then landed on the real
  // sign-request endpoint, which emails a counterparty. Every guard in this file
  // reduced to a spelling convention: %66 for f, %65 for e, %74 for t defeated both
  // the write ladder and the transmission patterns from the default configuration.
  //
  // So the decoded form is carried alongside for classification. The raw form is
  // still what gets sent, because legitimate path parameters (a filename, say) need
  // their escapes preserved.
  const decodedPathname = decodePathForRouting(url.pathname);
  if (decodedPathname === undefined) return undefined;

  return { pathname: url.pathname, search: url.search, decodedPathname };
}

/**
 * Percent-decode each path segment the way a router would, or refuse.
 *
 * Refuses when decoding changes the SHAPE of the path — introducing a separator or
 * a dot segment — because then one string means two different routes depending on
 * who decodes it, which is the ambiguity `hasAmbiguousSegments` exists to reject.
 */
function decodePathForRouting(pathname: string): string | undefined {
  const segments = pathname.split("/");
  const decoded: string[] = [];
  for (const segment of segments) {
    let out: string;
    try {
      out = decodeURIComponent(segment);
    } catch {
      return undefined; // malformed escape; refuse rather than guess
    }
    if (out.includes("/") || out.includes("\\") || out === "." || out === "..") return undefined;
    decoded.push(out);
  }
  return decoded.join("/");
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

  // Method-specific, because the same path differs sharply by verb. Replacing an
  // attachment's bytes "updates the bytes for every owner that references this
  // attachment id" — the spec's own words — so overwriting the file on a posted
  // voucher destroys the accounting documentation of every voucher pointing at it,
  // and no DELETE exists under /api/attachments to undo it. UPLOADING a new
  // attachment is additive and stays reversible, so a prefix would be too blunt.
  if ((method === "PATCH" || method === "PUT") && /^\/api\/attachments\/[^/]+$/i.test(path.replace(/\/+$/, ""))) {
    return "irreversible";
  }

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

/**
 * Some request *bodies* are more dangerous than their path suggests.
 *
 * Creating an order or a subscription is ordinary reversible master data — until
 * a field in the body arms invoice issuance or external transmission. Path-based
 * classification cannot see that.
 *
 * Deliberately a predicate map rather than a list of field names: the most
 * consequential trigger in this API is `outputMode: "create_invoice"`, a string,
 * so a "flag is true" test would miss it by construction. Every entry below was
 * checked against the OpenAPI document — earlier guesses at plausible-sounding
 * names (`sendEmail`, `sendDirectly`) do not exist as body fields at all.
 */
const ESCALATING_BODY_FIELDS: Readonly<Record<string, (value: unknown) => boolean>> = {
  // Arms EHF/Peppol transmission of the resulting invoice.
  sendehf: (v) => v === true,
  // Lets ReAI issue numbered invoices on a recurring schedule with no further call.
  automaticbillinggeneration: (v) => v === true,
  // Decides whether a subscription produces a draft order or a real invoice.
  // Compared case-insensitively: System.Text.Json falls back to case-insensitive
  // enum-name matching, so "CREATE_INVOICE" binds just as well and an exact compare
  // let it through as merely reversible.
  outputmode: (v) => typeof v === "string" && v.toLowerCase() === "create_invoice",
};

/**
 * Re-classify a call once its body is known. Returns the more severe of the
 * path-based risk and anything the body implies.
 *
 * Only inspects the top level: these are flat flags in the ReAI API, and
 * recursing into arbitrary nested payloads would invite false positives on
 * fields that merely record whether something was sent.
 */
export function classifyWithBody(pathRisk: Risk, body: unknown): Risk {
  // Only a reversible write can be escalated. A read stays a read — blocking one
  // because a stray field was passed alongside it would be a false positive —
  // and an irreversible call is already at the ceiling.
  if (pathRisk !== "reversible") return pathRisk;
  if (!body || typeof body !== "object" || Array.isArray(body)) return pathRisk;

  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const trigger = ESCALATING_BODY_FIELDS[key.toLowerCase()];
    if (trigger?.(value)) return "irreversible";
  }
  return pathRisk;
}

/** Names of body fields that escalate risk, for use in error messages. */
export function escalatingBodyFields(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.entries(body as Record<string, unknown>)
    .filter(([key, value]) => ESCALATING_BODY_FIELDS[key.toLowerCase()]?.(value) === true)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
}

/** Strip the query string and trailing slash; lowercase for prefix comparison. */
function normalize(path: string): string {
  const withoutQuery = path.split("?")[0] ?? path;
  const trimmed = withoutQuery.replace(/\/+$/, "") || "/";
  return trimmed.startsWith("/") ? trimmed.toLowerCase() : "/" + trimmed.toLowerCase();
}

/**
 * Whether a call sends something to a third party.
 *
 * Deliberately a SEPARATE axis from Risk. Reversibility and "does this leave the
 * building" are different questions, and conflating them is what made this
 * dangerous: every transmitting endpoint is already classified `irreversible`,
 * so `REAI_WRITE_MODE=full` — which an operator sets to permit ledger postings —
 * silently also permitted EHF invoices to real counterparties over Peppol.
 *
 * That matters concretely in both directions. Testing against a live company
 * (there is no ReAI sandbox) needs ledger writes but must send nothing to anyone.
 * A real business doing its invoicing needs the opposite. Neither is served by
 * one combined setting, so they are independent — and a production deployment
 * that should send invoices simply sets REAI_ALLOW_EXTERNAL_SEND=1.
 */
export type Transmission = "none" | "external";

/**
 * Calls that send something outside the tenant, as precise patterns.
 *
 * Patterns rather than prefixes, because a prefix is wrong in both directions
 * here. `/api/invoices` as a prefix swept in `/payments`, `/refunds`,
 * `/rounding-adjustment` and `/manual-credit-note-applications`, which are local
 * bookkeeping — so `full` plus no-external-send could not do ordinary
 * customer-ledger work. And a prefix list missed government filings entirely.
 */
const TRANSMITTING_PATTERNS: readonly RegExp[] = [
  // The Peppol transport itself.
  /^\/api\/peppol(\/|$)/,

  // Issuing a customer invoice starts delivery asynchronously (eFaktura, then
  // EHF when the order carries sendEhf, then PDF by email). Exact: the
  // sub-operations below it are mostly local accounting.
  /^\/api\/invoices$/,

  // Explicitly transmitting invoice sub-operations. `/credit` is here because
  // creating a credit note "starts credit note delivery asynchronously" using
  // the original order's settings.
  /^\/api\/invoices\/[^/]+\/(ehf|email|reminders|credit)(\/|$)/,
  /^\/api\/invoices\/reminders(\/|$)/,

  // Agreement signing requests are emailed to the signer.
  /^\/api\/agreements\/[^/]+\/sign-requests?(\/|$)/,

  // Government filings. These leave for Skatteetaten, which is as external as it
  // gets — and the tax return has no idempotency guard, so a repeated call
  // re-files.
  /^\/api\/tax-returns\/[^/]+\/submit$/,
  /^\/api\/salary-payments\/[^/]+\/complete$/,
  /^\/api\/amelding(\/|$)/,

  // Subscription billing ISSUES invoices, and issuing one starts delivery — the same
  // reason /api/invoices is here. These were classified irreversible but not
  // transmitting, so `full` mode alone sent them: /generate bills one subscription,
  // /generate-due bills EVERY due subscription in the tenant.
  /^\/api\/subscriptions\/[^/]+\/generate$/,
  /^\/api\/subscriptions\/generate-due$/,

  // The same operations under their non-/api aliases. Every pattern above is
  // /api/-anchored, and ~100 indexed operations live outside it — reachable through
  // reai_request, which never checks a path against the spec. /salary/{id}/complete
  // is literally the A-melding submission the /api/ pattern guards.
  /^\/salary\/[^/]+\/(complete|register-payment)$/,
  /^\/amelding(\/|$)/,
  /^\/vat-return(\/|$)/,

  // Notifications and payment rails outside /api/: bank-approval reminders and
  // failed-payment notices email real approvers; the card and payout endpoints move
  // money through third parties.
  /^\/ztl\/.*\/(approval-reminders|failed-payment-notifications)$/,
  /^\/kassasystem\/mobile\/payment-request(\/|$)/,
  /^\/adyen\/(payout|payment)(\/|$)/,
  /^\/cf-worker\/email(-|\/|$)/,
  /^\/lead\/[^/]+\/person-phone-call$/,
  /^\/lead\/company\/[^/]+\/phone-call$/,
];


/**
 * Paths where a body can change WHERE MONEY GOES, as opposed to changing a record.
 *
 * Editing a supplier is reversible — the record can be put back. The payment is not:
 * a human later pays the invoice in the ReAI UI, to whatever account is on file, and
 * that transfer is outside anything this policy can see. So a prompt-injected agent
 * in the DEFAULT configuration could repoint a supplier's bank details and the loss
 * would happen later, through a legitimate action by a person.
 *
 * `reversible` is documented as "master data that can be cleanly deleted", and that
 * criterion simply does not describe "redirects a future payment".
 *
 * Deliberately path-scoped rather than added to the body-field map: registering the
 * company's OWN bank account (POST /api/company-banks) also carries a swiftCode and
 * is an ordinary thing to do in the default mode. Only a counterparty's destination
 * escalates.
 */
const PAYMENT_ROUTING_PATHS: readonly RegExp[] = [
  /^\/api\/suppliers(\/|$)/,
  /^\/api\/creditors(\/|$)/,
  /^\/api\/customers(\/|$)/,
  /^\/api\/supplier-invoices\/[^/]+\/payment-details(\/|$)/,
];

const PAYMENT_ROUTING_FIELDS = new Set(["iban", "bankaccountnumber", "swiftcode", "accountnumber"]);

/** Payment-routing fields present in a body, for use in error messages. */
export function paymentRoutingFields(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.entries(body as Record<string, unknown>)
    .filter(
      ([key, value]) =>
        PAYMENT_ROUTING_FIELDS.has(key.toLowerCase()) &&
        value !== undefined &&
        value !== null &&
        String(value).trim() !== "",
    )
    .map(([key]) => key);
}

/**
 * Escalate a counterparty write that changes payment routing.
 *
 * Separate from `classifyWithBody` because it needs the path: the same field on
 * /api/company-banks is benign.
 */
export function classifyPaymentRouting(pathRisk: Risk, path: string, body: unknown): Risk {
  if (pathRisk === "irreversible") return pathRisk;
  const normalized = path.toLowerCase().replace(/\/+$/, "");
  if (!PAYMENT_ROUTING_PATHS.some((re) => re.test(normalized))) return pathRisk;
  return paymentRoutingFields(body).length > 0 ? "irreversible" : pathRisk;
}

/**
 * The only GETs believed to reach outside the tenant. Deliberately an explicit short
 * list, not a pattern: everything else about GET being safe holds.
 */
const TRANSMITTING_GETS: readonly RegExp[] = [
  /^\/api\/peppol\/messages\/phase4ping$/,
  /^\/vat-return\/altinn-sync$/,
];

/** Body fields that arm an external send even on a non-transmitting path. */
const TRANSMITTING_BODY_FIELDS: Readonly<Record<string, (value: unknown) => boolean>> = {
  sendehf: (v) => v === true,
  // A subscription set to produce invoices, or to bill automatically, will issue and
  // DELIVER them with no further call. The write ladder already escalated these to
  // irreversible; transmission said "none", so `full` mode alone armed recurring
  // delivery to a real customer. That is exactly the case the two-axis design exists
  // to catch, and it was slipping between the axes.
  outputmode: (v) => typeof v === "string" && v.toLowerCase() === "create_invoice",
  automaticbillinggeneration: (v) => v === true,
};

/**
 * Does this call send something to a third party?
 *
 * GET is never transmitting. Everything else is judged on path, sub-path and
 * body, and an unknown path is NOT assumed to transmit — unlike the write
 * classifier, which fails closed. The asymmetry is deliberate: failing closed
 * here would block most of the API for no safety gain, because an unrecognised
 * write is already refused by the write policy.
 */
export function classifyTransmission(
  method: HttpMethod,
  path: string,
  body?: unknown,
): Transmission {
  const canonical = canonicalizeApiPath(path);
  const normalized = normalize(canonical?.pathname ?? path);

  // GET is normally a read, and treating it as such is right for the whole API bar
  // two endpoints that reach a third party despite the verb. `read-only` is the mode
  // people point at a live business, so these are exactly the wrong thing to let
  // through there.
  //
  // Stated honestly: NEITHER carries a description in the spec, so the effect is
  // inferred from the path and its controller (peppol-sender-ctrl, vat-return-ctrl)
  // rather than documented. Erring toward "this leaves the tenant" is the safe
  // direction when the alternative is an unannounced AS4 ping onto the Peppol network
  // or a sync with Altinn.
  if (method === "GET") {
    return TRANSMITTING_GETS.some((re) => re.test(normalized)) ? "external" : "none";
  }

  if (TRANSMITTING_PATTERNS.some((re) => re.test(normalized))) return "external";

  if (body && typeof body === "object" && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (TRANSMITTING_BODY_FIELDS[key.toLowerCase()]?.(value)) return "external";
    }
  }
  return "none";
}

/** Names the body fields that made a call transmitting, for error messages. */
export function transmittingBodyFields(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.entries(body as Record<string, unknown>)
    .filter(([k, v]) => TRANSMITTING_BODY_FIELDS[k.toLowerCase()]?.(v) === true)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
}

export class ExternalSendBlockedError extends Error {
  constructor(what: string) {
    super(
      `${what} sends a document, email or signing request outside this tenant, and ` +
        `REAI_ALLOW_EXTERNAL_SEND is not enabled on this server.\n\n` +
        `This is a separate switch from REAI_WRITE_MODE by design. A write mode governs what can be ` +
        `undone in the books; this governs whether anything reaches a third party, which cannot be ` +
        `undone at all. Keeping them separate means a server can be trusted with the ledger while ` +
        `still being unable to email a customer — useful while evaluating, or when working against ` +
        `a tenant whose real counterparties should not hear from you.\n\n` +
        `Sending invoices is of course the point of an accounting system. If this deployment is ` +
        `meant to do that, the operator enables it with REAI_ALLOW_EXTERNAL_SEND=1 and everything ` +
        `above becomes available. Tell the user that is the fix — it is ordinary configuration, ` +
        `not a warning sign.`,
    );
    this.name = "ExternalSendBlockedError";
  }
}

/** Throws unless external transmission is permitted. */
export function assertTransmitAllowed(
  transmission: Transmission,
  allowExternalSend: boolean,
  what: string,
): void {
  if (transmission === "external" && !allowExternalSend) {
    throw new ExternalSendBlockedError(what);
  }
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
