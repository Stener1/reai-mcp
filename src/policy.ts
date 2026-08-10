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
  /**
   * Everything this tier is defined by is an EXCLUSION: it does not touch the ledger, issue a legal document,
   * move money, run payroll, file with an authority, or administer users and tenants. That is what an operator
   * running at the default mode is agreeing to, and it is what the classifier below actually implements — the
   * irreversible list is the positive statement, and this is the remainder.
   *
   * Two attempts at a shorter phrase have both been wrong, so the exclusion list is the definition rather than a
   * gloss on one:
   *
   *   "master data that can be cleanly deleted again" — false. Several records in this tier ARCHIVE instead of
   *   deleting when they carry references, which `delete-may-archive` in the quirk registry documents, and four
   *   of the five examples the README used to give for this tier are among them.
   *
   *   "additive" — also false, and worse because it sounded principled. 23 of the 88 reversible operations are
   *   DELETEs, which neither create nor edit anything, and 17 of the 24 reversible PUTs can clear a documented
   *   field by omitting it. `POST /api/customers/{id}/sync-brreg` overwrites master data from the registry with
   *   no undo. The comment on agreement templates below makes exactly this argument about a replacing PUT, and
   *   17 such PUTs stay in the tier regardless.
   *
   * So: no adjective. Reversible means "none of the things the irreversible tier is for", which is narrower than
   * it sounds and is the only claim the code supports.
   */
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
  // Both voucher paths. The API moved voucher WRITES to /api/manual-vouchers on 2026-08-10 — measured, POST
  // /api/vouchers answers 405 "Method 'POST' is not supported" and POST /api/manual-vouchers validates — while
  // GET stayed on /api/vouchers.
  //
  // Listing the new path EXPLICITLY rather than relying on the fallthrough at the end of classifyRequest, which
  // already returns `irreversible` for anything unrecognised. That default made the move safe by accident:
  // /api/manual-vouchers classified exactly like /api/totally-made-up-thing, so the general ledger — the single
  // most consequential prefix in this list — had no intentional entry for its own writes. A later reader deciding
  // that a "manual voucher" sounds editable and adding it to REVERSIBLE_PREFIXES would have met no objection.
  //
  // /api/vouchers stays: GET is `read` regardless of this list, and if a write ever returns to that path it is
  // already covered.
  "/api/vouchers",
  "/api/manual-vouchers",
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
  // Loans stay here after being measured, which is worth recording because the measurement points
  // the other way. On the write test tenant, creating a loan posted NOTHING -- voucher count 0
  // before and 0 after -- and DELETE answered 204 with the id then reading 404, so by the letter of
  // the reversible list ("records an agent can safely create and clean up") a loan record qualifies.
  // It is not moved, for two reasons. The measurement was taken on a company with no loan history at
  // all, and says nothing about deleting a loan that has repayments or interest postings against it;
  // and the record is the BASIS for those postings rather than reference data, so the cost of being
  // wrong is asymmetric. Reads are unaffected -- reai_list_loans and reai_get_loan are read tier --
  // so what this costs is creating a loan in the default mode, which is a deliberate act anyway.
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

/** Master data: reference records outside the ledger, legal-document, money and payroll surfaces. */
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
  // "/deactivate" is deliberately NOT here. It is the exact inverse of activate — the
  // spec says one "marks the subscription active" and the other "marks it inactive" —
  // so it is reversible by definition, and it is the action that STOPS recurring
  // billing. Escalating it meant the default mode could not halt a subscription that
  // was issuing invoices unattended, which is the wrong way round: activate stays
  // irreversible because it starts that, and stopping it should not need `full`.
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
  // other than %2f/%5c untouched, while ReAI decodes the path before routing (Spring's
  // UrlPathHelper; verified live — GET /api/custom%65rs returns 200) — so "/api/agreements/3/sign-reques%74" was classified as an unknown
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

  // Canonicalize first: classifying a raw string that resolves to a different path is
  // how a reversible-looking call reaches the ledger. A path we cannot resolve is
  // treated as the most dangerous case.
  const canonical = canonicalizeApiPath(path);
  if (!canonical) return "irreversible";

  // Every form this request could be matched as, strictest answer wins.
  let worst: Risk = "read";
  // Including the percent-DECODED form. canonicalizeApiPath computes it and says it is
  // "carried alongside for classification" — and then only the raw form reached the
  // matchers, so classifyRequest("POST", "/api/agreements/3/sign-reques%74") answered
  // reversible. No live bypass, because discovery.ts classifies raw and decoded
  // separately and takes the stricter; but the guarantee belonged here, and any second
  // caller of classifyRequest would have inherited the weak answer.
  for (const normalized of pathForms(canonical.pathname, canonical.decodedPathname)) {
    worst = strictestRisk(worst, classifyNormalizedPath(method, normalized));
  }
  return worst;
}

function classifyNormalizedPath(method: HttpMethod, normalized: string): Risk {
  // Method-specific, because the same path differs sharply by verb. Replacing an
  // attachment's bytes "updates the bytes for every owner that references this
  // attachment id" — the spec's own words — so overwriting the file on a posted
  // voucher destroys the accounting documentation of every voucher pointing at it,
  // and no DELETE exists under /api/attachments to undo it. UPLOADING a new
  // attachment is additive and stays reversible, so a prefix would be too blunt.
  if ((method === "PATCH" || method === "PUT") && /^\/api\/attachments\/[^/]+$/i.test(normalized)) {
    return "irreversible";
  }

  // The same shape one domain over, and for the same reason. PUT on an agreement template
  // REPLACES the agreement: a body carrying one field clears every other term, measured on a
  // live lease — rent, tenant, deposit amount and the deposit ACCOUNT NUMBER all set to null,
  // answered 200, with the PDF still rendering afterwards. There is no archive, no version
  // history and no undo, so "reversible master data that can be cleanly deleted again" is not
  // what this is.
  //
  // Creating one IS additive and cleanly deletable (DELETE answers 204, verified), so a prefix
  // would be too blunt — POST stays reversible. The template segment is letters and hyphens,
  // which is what keeps this off /api/agreements/{numeric id}/... sub-resources.
  //
  // reai_update_agreement is classified irreversible in step with this. It is the SAFE way to
  // perform the operation — it reads, merges and writes the whole record back — but gating the
  // curated tool while reai_request still permitted the identical call would be theatre, and
  // that is the argument this repo already made for reconciliation rules.
  if (method === "PUT" && /^\/api\/agreements\/[a-z-]+\/[^/]+$/i.test(normalized)) {
    return "irreversible";
  }

  // Creating a general sub-account cannot be undone and changes how its ACCOUNT behaves for
  // everyone. Measured: DELETE /api/general-sub-accounts/{id} answers 405, PUT accepts only `name`
  // (accountNumber answers 400 "Unknown field: accountNumber"), and once an account has ANY
  // sub-account every posting to it must name one — so adding the first one to an account breaks
  // whatever was posting to it without a subAccountId. A create with no delete and a side effect on
  // other people's writes is not "reversible" in the sense the default mode means.
  if (method === "POST" && /^\/api\/general-sub-accounts$/i.test(normalized)) {
    return "irreversible";
  }

  // A full-replacement PUT on a record that CARRIES a payment destination can erase that
  // destination by leaving it out, and both of these were measured doing exactly that on a live
  // tenant:
  //
  //   PUT /api/company-banks/{id} {name, countryCode, currency}  → 200, bban AND iban cleared
  //   PUT /api/creditors/{id}     {name}                          → 200, bankAccountNumber cleared
  //
  // Neither body mentions an account, so the payment-routing rule — which escalates when a
  // routing field is PRESENT — cannot see it. That guard is defeated by omission here, which is
  // why this is a path rule rather than another field. "Rename the bank account" silently
  // removing the number a customer pays into is not reversible master-data editing.
  //
  // PUT only, because the class is REPLACEMENT. Creating cannot clear what is not there yet, and
  // PATCH was measured to be a genuine partial update — a name-only PATCH on a supplier left its
  // account number, IBAN and SWIFT untouched — so those paths keep the routing rule alone.
  //
  // What "creating stays reversible" means exactly, since the first version of this comment
  // overstated it: the PATH classification stays reversible for both. A creditor created WITH an
  // account number still escalates on the routing axis, because /api/creditors is not in
  // ADDING_IS_ORDINARY and a company bank is. That asymmetry is not defended here — the
  // add-diverts-nothing argument would apply equally to a creditor — but loosening a live guard
  // is not a tidiness change, so it is left as it stands and stated rather than smoothed over.
  //
  // Swept out of the whole document, and deliberately narrow:
  // /api/reconciliation-rules/{id} carries a destination too and REQUIRES it, so omission is
  // impossible; the rent agreement is covered by its own rule above; /api/debtors/{id} carries
  // none at all.
  if (
    method === "PUT" &&
    /^\/api\/(company-banks|creditors)\/[^/]+$/i.test(normalized)
  ) {
    return "irreversible";
  }

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
/**
 * Does a value bind to Java `true`?
 *
 * The backend is Spring Boot with Jackson — confirmed from the spec itself: 2138
 * references to Spring 6's `ProblemDetail`, springdoc's literal default server
 * description "Generated server url", and 172 operationIds carrying springdoc's
 * `_1`/`_2` disambiguation suffix. An earlier comment here asserted ASP.NET and
 * System.Text.Json, and the predicates were written to that model.
 *
 * It matters because Jackson's default CoercionConfig is looser than a strict
 * `=== true`: the string "true" and the integer 1 both bind to `true`. So
 * `{"sendEhf": "true"}` armed an external send that the policy scored as sending
 * nothing. Anything ambiguous counts as true, because the cost of being wrong is
 * an irrecoverable transmission in one direction and a refused call in the other.
 *
 * Exported because a curated tool that READS a flag off a record faces the same coercion: a tool checking
 * `record.sendEhf === true` before deciding whether an edit could re-arm a send would be fooled by exactly
 * the values this exists to catch. reai_update_order uses it for that.
 */
export function bindsToTrue(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    return t === "true" || t === "1" || t === "yes" || t === "on";
  }
  return false;
}

/**
 * Does a value bind to the `create_invoice` enum member?
 *
 * Jackson accepts an integer ORDINAL for an enum unless FAIL_ON_NUMBERS_FOR_ENUMS is
 * set, which is off by default. `outputMode` is declared ["create_order",
 * "create_invoice"], so `1` is create_invoice — and a strict string compare read it
 * as merely reversible. Case-insensitivity is kept for the same reason as before.
 *
 * Fails closed on anything that is neither a recognised string nor a known-safe
 * ordinal: an unrecognised shape means we cannot tell what it binds to, and the safe
 * reading of "cannot tell" is the dangerous one.
 */
export function bindsToCreateInvoice(v: unknown): boolean {
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    // Anything that is not plainly create_order is treated as create_invoice.
    return t !== "create_order" && t !== "" && (t === "create_invoice" || !KNOWN_OUTPUT_MODES.has(t));
  }
  if (typeof v === "number") return v !== 0; // ordinal 0 = create_order, anything else is not
  return v !== undefined && v !== null;
}

const KNOWN_OUTPUT_MODES = new Set(["create_order", "create_invoice"]);

/**
 * Where the arms-a-send fields actually live.
 *
 * The other two branches of `curatedArgsEscalate` are path-scoped and its docstring says
 * why: "the field names are ambiguous out of context". This one was not, and
 * `bindsToCreateInvoice` fails closed on an unrecognised string — so a future export tool
 * with `outputMode: "csv"` would have been refused in the default mode with a message
 * about Peppol transmission. That is the false refusal the README warns teaches operators
 * to distrust the true ones. In the whole document `outputMode` appears only on
 * subscriptions and `sendEhf` only on subscriptions and orders, so scoping costs nothing.
 */
const ARMS_A_SEND_PATHS: readonly RegExp[] = [
  /^\/api\/subscriptions(\/|$)/,
  /^\/api\/orders(\/|$)/,
];

const ESCALATING_BODY_FIELDS: Readonly<Record<string, (value: unknown) => boolean>> = {
  // Arms EHF/Peppol transmission of the resulting invoice.
  sendehf: bindsToTrue,
  // Lets ReAI issue numbered invoices on a recurring schedule with no further call.
  automaticbillinggeneration: bindsToTrue,
  // Decides whether a subscription produces a draft order or a real invoice.
  outputmode: bindsToCreateInvoice,
};

/**
 * The objects whose top-level fields the body inspectors examine.
 *
 * An object root yields itself. An ARRAY root yields each object element, because all
 * three inspectors previously returned early on an array and so saw nothing:
 *
 *   PATCH /api/suppliers/5  body={"iban":"..."}    -> irreversible, blocked
 *   PATCH /api/suppliers/5  body=[{"iban":"..."}]  -> reversible, permitted
 *
 * No operation in the spec takes an array root today, so this was latent — but
 * `reai_request` forwards whatever body it is given verbatim, so it becomes live the
 * day ReAI adds a bulk endpoint under a reversible prefix, with nothing here to notice.
 * "Not currently reachable" is a poor reason to leave a hole in a safety classifier.
 *
 * Still top level only, deliberately: recursing into arbitrary nested payloads would
 * flag fields that merely RECORD whether something was sent.
 */
function inspectableObjects(body: unknown): Array<Record<string, unknown>> {
  if (!body || typeof body !== "object") return [];
  if (Array.isArray(body)) {
    return body.filter(
      (element): element is Record<string, unknown> =>
        !!element && typeof element === "object" && !Array.isArray(element),
    );
  }
  return [body as Record<string, unknown>];
}

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

  for (const candidate of inspectableObjects(body)) {
    for (const [key, value] of Object.entries(candidate)) {
      if (ESCALATING_BODY_FIELDS[key.toLowerCase()]?.(value)) return "irreversible";
    }
  }
  return pathRisk;
}

/** Exported for the invariant that checks curated tools against these same fields. */
export const escalatingBodyFieldNames: readonly string[] = Object.keys(ESCALATING_BODY_FIELDS);

/** Names of body fields that escalate risk, for use in error messages. */
export function escalatingBodyFields(body: unknown): string[] {
  return [
    ...new Set(
      inspectableObjects(body).flatMap((candidate) =>
        Object.entries(candidate)
          .filter(([key, value]) => ESCALATING_BODY_FIELDS[key.toLowerCase()]?.(value) === true)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`),
      ),
    ),
  ];
}

/** Strip the query string and trailing slash; lowercase for prefix comparison. */
/**
 * Strip the query string and trailing slash; lowercase for prefix comparison.
 */
function normalize(path: string): string {
  const withoutQuery = path.split("?")[0] ?? path;
  const trimmed = withoutQuery.replace(/\/+$/, "") || "/";
  return trimmed.startsWith("/") ? trimmed.toLowerCase() : "/" + trimmed.toLowerCase();
}

/**
 * The path as a ROUTER would match it: matrix parameters gone, duplicate slashes
 * collapsed, a trailing dot dropped.
 *
 *   /api/subscriptions/1/generate;a=b   ->  /api/subscriptions/1/generate
 *   /api/attachments//9                 ->  /api/attachments/9
 *   /api/subscriptions/1/generate.      ->  /api/subscriptions/1/generate
 *
 * This is NOT a replacement for `normalize` — it is a second reading of the same
 * request, and every guard takes the STRICTER of the two, exactly as it already does
 * for the raw and percent-decoded forms.
 *
 * Substituting it outright was wrong, and wrong in the dangerous direction. The premise
 * "stripping can only make a path match a pattern it otherwise missed" does not hold:
 * `/api/suppliers;foo/5` matched no prefix and therefore failed CLOSED as irreversible,
 * and stripping made it match the reversible `/api/suppliers` prefix. Three shapes came
 * out weaker than before. A dot-only segment is left intact for the same reason —
 * emptying `...` shortens the path and can drop a pattern match entirely
 * (`/api/invoices/.../email` lost its transmission match).
 */
function routedPath(path: string): string {
  const withoutQuery = path.split("?")[0] ?? path;
  const routed = withoutQuery
    .split("/")
    .map((segment) => segment.split(";")[0] ?? segment)
    // Only a trailing dot on a segment that has other content. Never empty a segment
    // that was not already empty.
    .map((segment) => {
      const stripped = segment.replace(/\.+$/, "");
      return stripped === "" ? segment : stripped;
    })
    .filter((segment, index) => segment !== "" || index === 0)
    .join("/");
  const trimmed = routed.replace(/\/+$/, "") || "/";
  return trimmed.startsWith("/") ? trimmed : "/" + trimmed;
}

function routedForm(path: string): string {
  return routedPath(path).toLowerCase();
}

/**
 * The same request as paths an OPERATION LOOKUP can use: case preserved, one entry per reading.
 *
 * Exported because the risk classifiers and the spec-driven gates were reading the request
 * differently. `pathForms` gives every guard in this file the routed reading, but anything keyed on a
 * resolved OPERATION — the replacement-omission gate in reai_request, for one — resolved only the
 * raw and percent-decoded forms. Review demonstrated the consequence with four shapes:
 * `PUT /api/orders/1;x=1`, `/api/orders/1;`, `/api/orders//1` and `/api/orders/1.` each resolved to
 * no operation, so the gate that lists the fields a replacement would empty had nothing to list and
 * the call went out unremarked, while the identical call as `/api/orders/1` was refused.
 *
 * Not exploitable against ReAI today: measured, its StrictHttpFirewall answers 400 to the matrix
 * parameter and the doubled slash and 404 to the trailing dot. That is exactly why it is worth
 * fixing anyway — a guarantee that depends on another server rejecting malformed input is borrowed,
 * not held, and this file already says so about the risk classifiers.
 */
export function routedPathForms(...paths: ReadonlyArray<string | undefined>): string[] {
  const forms: string[] = [];
  for (const path of paths) {
    if (path === undefined) continue;
    for (const form of [path, routedPath(path)]) {
      if (!forms.includes(form)) forms.push(form);
    }
  }
  return forms;
}

/**
 * Every string form one request may be matched as. A guard that checks all of them and
 * takes the strictest answer cannot be weakened by a shape it did not anticipate.
 */
function pathForms(...paths: ReadonlyArray<string | undefined>): string[] {
  const forms = new Set<string>();
  for (const path of paths) {
    if (path === undefined) continue;
    forms.add(normalize(path));
    forms.add(routedForm(path));
  }
  return [...forms];
}

const RISK_SEVERITY: Record<Risk, number> = { read: 0, reversible: 1, irreversible: 2 };

/**
 * The stricter of two write ceilings.
 *
 * Counterpart to strictestRisk below, and it lived in src/http.ts as a module-private helper — which
 * meant the most consequential decision in remote mode had nothing testing it. That file exports
 * nothing and is spawned as a process, so the only way to reach it was to start a real server.
 *
 * What it decides: a grant is sealed at authorization time and refreshable for weeks, so an operator
 * who redeploys with a tighter REAI_WRITE_MODE would otherwise keep serving the old, wider ceiling to
 * every outstanding token. Taking the narrower of the two on every request means the operator's switch
 * wins immediately — and equally, that a user who narrowed their own grant on the consent page is
 * never widened back by a permissive server.
 */
export function narrowerWriteMode(a: WriteMode, b: WriteMode): WriteMode {
  const ra = WRITE_MODES.indexOf(a);
  const rb = WRITE_MODES.indexOf(b);
  // Both inputs are validated upstream, so this is unreachable today. It is spelled out
  // because indexOf answers -1 for a value outside the vocabulary, which would make an
  // unrecognised mode the *narrowest* one and return it -- so `narrowerWriteMode(undefined,
  // "read-only")` would hand back undefined and isAllowed would throw on it. A policy
  // primitive fails closed, like narrowWriteMode on the consent page does.
  if (ra < 0 || rb < 0) return "read-only";
  return ra <= rb ? a : b;
}

/** The more severe of two readings of the same request. */
export function strictestRisk(a: Risk, b: Risk): Risk {
  return RISK_SEVERITY[a] >= RISK_SEVERITY[b] ? a : b;
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

  // Agreement signing requests are emailed to the signer. Deliberately broad: it must
  // cover POST .../sign-requests AND POST .../sign-requests/{id}/send, which both
  // deliver. The one exception is the DELETE, handled by method above — narrowing this
  // pattern instead silently stopped covering /send.
  /^\/api\/agreements\/[^/]+\/sign-requests?(\/|$)/,

  // Granting access to an email address INVITES that address. UserAccessRes.status is
  // "active" | "pending_invitation" and carries an invitationId, CreateUserReq takes
  // { email, roleCode, expiresInDays }, and GET /api/users/invitations lists the pending
  // ones — an expiring invitation the invitee has to accept can only reach them by mail.
  //
  // Stated honestly: the endpoint has NO description, so the email itself is inferred from
  // that shape rather than documented. Failing closed is the easy call here, because what
  // this one sends is not data but PRIVILEGE — roleCode accepts ROLE_TENANT_ADMIN, to an
  // address the caller chooses. /api/users was already irreversible on the write axis
  // ("changes who can reach the books at all"), so `full` mode permitted it while the send
  // axis had never looked at it: a server trusted with the ledger could mail an admin
  // invitation to anyone. Exact, because the sub-operations read roles and permissions.
  /^\/api\/users$/,

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
 * `reversible` is defined by exclusion — not the ledger, not a legal document, not money, not payroll, not a
 * filing, not user administration — and "redirects a future payment" is squarely inside the money exclusion,
 * whoever presses the button later. (This argument used to cite the tier's old one-line gloss, "master data that
 * can be cleanly deleted"; that wording was removed for being false, and the argument is stronger without it.)
 *
 * Deliberately path-scoped rather than added to the body-field map: registering the
 * company's OWN bank account (POST /api/company-banks) also carries a swiftCode and
 * is an ordinary thing to do in the default mode. Only a counterparty's destination
 * escalates.
 */
export const PAYMENT_ROUTING_PATHS: readonly RegExp[] = [
  /^\/api\/suppliers(\/|$)/,
  /^\/api\/creditors(\/|$)/,
  /^\/api\/customers(\/|$)/,
  // An EMPLOYEE's account is where their salary lands, which makes this the sharpest
  // member of the class rather than an afterthought: salary is paid on a schedule, by
  // machinery nobody re-examines each month, and the person who notices is the employee
  // whose pay did not arrive. It was missing, so PATCH /api/employees/{id} carrying
  // accountNumber was ordinary reversible master data in the default mode.
  /^\/api\/employees(\/|$)/,
  // The supplier-invoice PAYMENT DETAILS, at every path that writes them. The nested
  // /payment-details sub-resource was covered and the parent was not — yet
  // POST /api/supplier-invoices and PATCH /api/supplier-invoices/{id} accept the same
  // paymentDetails object, and that account is what an outgoing payment actually uses.
  /^\/api\/supplier-invoices(\/|$)/,
  // Same object again, reached from the receiving side: turning a received EHF document
  // into a supplier invoice carries the beneficiary's bank details with it.
  /^\/api\/invoice-reception-documents\/[^/]+\/supplier-invoice(\/|$)/,
  // A lease carries the rent and deposit accounts the tenant pays into. Editing an
  // existing one redirects money inward, exactly as repointing a company bank does.
  /^\/api\/agreements\/rent-agreement(\/|$)/,
  // The company's OWN account, which its customers pay into. Previously reached through a
  // bespoke branch below rather than this list; folding it in is what let the lease reuse
  // the same add-versus-repoint rule instead of growing a second special case. Removing
  // the branch without adding it here dropped the protection outright, and the invariant
  // test caught that within a minute — which is the argument for having the test.
  /^\/api\/company-banks(\/|$)/,
];

/**
 * Paths where the money flows INWARD and creating the record is ordinary work.
 *
 * Repointing an existing company bank or lease redirects a stream someone is already
 * paying into — and for a lease, a signed contract in the tenant's hands names the old
 * account. Creating one establishes a new arrangement instead of diverting an existing
 * one, and a human signs it before anybody pays, so `POST` stays out of scope.
 */
const ADDING_IS_ORDINARY: readonly RegExp[] = [
  /^\/api\/company-banks(\/|$)/,
  /^\/api\/agreements\/rent-agreement(\/|$)/,
];

/**
 * Field names that NAME A DESTINATION for money.
 *
 * Two were missing because the set was written against the supplier and company-bank
 * schemas and never checked against the others: the supplier-invoice payment details call
 * the same concepts `swiftBic` ("The beneficiary bank SWIFT/BIC") and `routingNumber`
 * ("The bank routing number"). `test/payment-routing.test.mjs` now reads the OpenAPI
 * document and fails if any routing-shaped field is neither in this set nor explicitly
 * exempted, so the next rename does not slip through the same gap.
 *
 * Deliberately NOT here:
 *
 * - `bankAccountCategory`, `localClearingSystem`, `routingType` — they change the rails a
 *   payment travels on, not the account it arrives in. A destination is always written
 *   alongside them by one of the fields above, so the call is caught anyway.
 * - `bankCountryCode` — on its own it does not name an account, and it is settable on
 *   ordinary employee edits.
 * - Every `*AccountNumber` that is a CHART-OF-ACCOUNTS code: `accrualAccountNumber`,
 *   `principalAccountNumber`, `interestExpenseAccountNumber` and the rest carry
 *   `$ref: AccountNumber`, and `POST /api/assets` pins its own to `pattern: 1\d{3}`.
 *   Escalating those would refuse a booking with "this changes where a payment will go",
 *   which is false — a misleading refusal teaches an operator to distrust the real ones.
 */
const PAYMENT_ROUTING_FIELDS = new Set([
  "iban",
  "bankaccountnumber",
  // `bban` is the company-bank schema's account-number field. It was absent, so even
  // once /api/company-banks was in scope the account number itself went undetected.
  "bban",
  "accountnumber",
  "swiftcode",
  "swiftbic",
  "routingnumber",
  // A Norwegian lease names the accounts the tenant pays into: rent monthly, and the
  // deposit into a dedicated escrow account (depositumskonto), which the law requires to
  // be separate. Both were nearly dismissed as chart-of-accounts codes because they are
  // bare strings — but that is the evidence FOR them, not against: `AccountNumber` is
  // documented as "Base chart of accounts number" and every genuine ledger field in the
  // document $refs it. These do not, and they sit among `monthlyRent`,
  // `rentDueDayOfMonth`, `depositAmount`, `depositType` and `guaranteeIssuer`.
  "rentaccountnumber",
  "depositaccountnumber",
]);

/** Exported for the spec-driven invariant test, which has to see the real set. */
export const paymentRoutingFieldNames: ReadonlySet<string> = PAYMENT_ROUTING_FIELDS;

/**
 * Redirecting invoice DELIVERY. The same shape of harm as payment routing — trivially
 * reversible as a record, permanent as a disclosure, and realised later by a
 * legitimate human send — but a different consequence and a different thing to check,
 * so it is kept separate rather than folded into the payment set. Reporting "this
 * changes where a payment will go" for an email address tells the agent the wrong
 * thing to verify.
 *
 * Scoped more widely than the customer record: `invoiceEmail` is also a field on
 * CreateOrderReq, UpdateOrderReq and SubscriptionWriteReq, so an address set on an
 * order or a subscription reaches the same disclosure by a different door.
 */
const INVOICE_DELIVERY_FIELDS = new Set(["invoiceemail"]);

/**
 * Every field name that can escalate a call, for the destructive-annotation probe.
 *
 * Exported because that probe has to build an argument that TRIPS the gate, and a hand-written
 * list of names would be the mirror-of-the-thing-it-guards shape this repo keeps getting caught
 * by — a field added to one of the sets above and not to the copy would silently stop being
 * annotated.
 */
export const escalatingFieldNames: readonly string[] = [
  ...PAYMENT_ROUTING_FIELDS,
  ...INVOICE_DELIVERY_FIELDS,
  ...Object.keys(ESCALATING_BODY_FIELDS),
];

const INVOICE_DELIVERY_PATHS: readonly RegExp[] = [
  /^\/api\/customers(\/|$)/,
  /^\/api\/orders(\/|$)/,
  /^\/api\/subscriptions(\/|$)/,
];

/** Invoice-delivery fields present in a body with a value, for use in error messages. */
export function invoiceDeliveryFields(body: unknown): string[] {
  return presentFields(inspectableObjects(body), INVOICE_DELIVERY_FIELDS);
}

/**
 * Delivery fields a body EMPTIES: named, but with null or a blank string.
 *
 * Split out because the axis was blind in one direction. `presentFields` requires a non-empty
 * value, so `invoiceEmail: "attacker@example.com"` escalated and needed `full` mode, while
 * `invoiceEmail: null` on the same endpoint stayed `reversible` and went through in the default
 * mode. Same field, same axis, and both change which human receives the next invoice — one to a
 * chosen address, the other to whatever the API falls back to. Only one of them was gated.
 *
 * `undefined` deliberately does not count, and the reason is narrower than it looks: JSON cannot
 * carry it, so a key with an undefined value never survives the wire and never reaches a handler
 * from a real client. It is not that absence is handled elsewhere — `omittedReplacementFields`
 * treats a present-but-undefined key as SUPPLIED, so it would not appear there either.
 *
 * Both null and the empty string count, even though only one of them clears anything. Measured
 * against `PATCH /api/customers/{id}` on tenant 2783, seeding an address and sending each form:
 * `invoiceEmail: ""` cleared it, `invoiceEmail: null` was a no-op that left the address in place,
 * and `invoiceEmail: " "` answered 400 "Validation failed". So the value that empties a billing
 * address is the one that looks like a mistake, and the deliberate-looking one does nothing.
 *
 * This gate is about the CALLER'S INTENT, which is why both are escalated. Someone who wants the
 * address left alone omits the field; someone who names it with an empty value is asking for it to
 * go. Whether this API honours that differs by endpoint — the same divergence the lead endpoints
 * show, where PATCH ignores null and the PUT setters clear on it — and a guard that only covered the
 * form that happens to work today would reopen the moment another endpoint honoured the other one.
 */
export function invoiceDeliveryClearedFields(body: unknown): string[] {
  return [
    ...new Set(
      inspectableObjects(body).flatMap((candidate) =>
        Object.entries(candidate)
          .filter(
            ([key, value]) =>
              INVOICE_DELIVERY_FIELDS.has(key.toLowerCase()) &&
              // Exactly complementary to presentFields, which is the point: it counts a field as
              // SET when the value is neither undefined, nor null, nor blank once stringified. So
              // "cleared" has to be everything else a present key can hold, or a value falls
              // between the two and the axis calls it neither direction. Review found the gap with
              // `invoiceEmail: []` and `invoiceEmail: [""]` — both stringify blank, neither is a
              // string, so both went through as an ordinary write. The API would almost certainly
              // reject them, but "the server upstream will refuse it" is a borrowed guarantee.
              value !== undefined &&
              (value === null || String(value).trim() === ""),
          )
          .map(([key]) => key),
      ),
    ),
  ];
}

/** Whether a path is one where an invoiceEmail decides delivery. Mirrors inPaymentRoutingScope. */
export function inInvoiceDeliveryScope(path: string): boolean {
  return pathForms(path).some((n) => INVOICE_DELIVERY_PATHS.some((re) => re.test(n)));
}

/**
 * Escalate a call that changes where invoices are delivered — in either direction.
 *
 * `partialBody` is what makes the clearing half safe to have, and it took a false positive to work
 * out. The rule started as "naming a delivery field with an empty value escalates, on any method
 * that can overwrite what is stored". On `PUT /api/orders/{id}` that made EVERY possible body
 * irreversible: `invoiceEmail` is a documented optional field there, so a body either omits it —
 * which a replacement stores as empty — or names it, and naming it is either a new address or an
 * empty one. All four cases escalated, there is no curated order-update tool, and so an agent in the
 * default mode asked to change an order's due date had no legal move left except delete and
 * recreate. That is worse than the edit being guarded.
 *
 * The distinguishing question is not the method, it is whether the body is the WHOLE RECORD:
 *
 *   - In a PARTIAL body — a PATCH, or a curated tool's arguments, which are always partial because
 *     the tool reads and merges — naming `invoiceEmail` with an empty value can only mean "make it
 *     empty". Someone who wants it left alone omits it. So it escalates.
 *   - In a REPLACEMENT body, an empty `invoiceEmail` is indistinguishable from faithfully carrying
 *     back an address that is already empty, which is the common case and exactly what this server
 *     tells callers to do ("GET the record first, merge your changes over it, and send the whole
 *     thing"). So it does not escalate, and the replacement-omission gate in reai_request is the
 *     mechanism there instead: it lists every field the body leaves out, refuses by default, and
 *     needs an explicit opt-in.
 *
 * What that leaves uncovered, stated rather than glossed: a caller who deliberately empties a set
 * address through a replacement PUT is not escalated, because nothing in the request distinguishes
 * them from the round-trip above. Closing it would mean reading the record inside the policy check
 * and comparing — which makes an allow/refuse decision depend on a second network call and on what
 * to do when that call fails. Not worth it here: the curated tools carry the intent-bearing path,
 * and the omission gate covers the silent one.
 */
export function classifyInvoiceDelivery(
  pathRisk: Risk,
  path: string,
  body: unknown,
  // Required, with no default, for the same reason the method used to be: this is the parameter that
  // decides whether the clearing half applies, and a default would decide it silently for whichever
  // call site forgot. The compiler names them instead.
  partialBody: boolean,
): Risk {
  // Only a reversible write can be escalated, the same rule classifyWithBody applies
  // and states: "blocking a read because a stray field was passed alongside it would be
  // a false positive". These two guarded on irreversible alone, so a GET carrying an
  // `iban` in its body came back irreversible and was refused in read-only mode — the
  // mode people point at a live business. reai_request accepts a body on any method, so
  // it was reachable, and it blocked exactly the safe operation.
  if (pathRisk !== "reversible") return pathRisk;
  if (!inInvoiceDeliveryScope(path)) return pathRisk;
  if (invoiceDeliveryFields(body).length > 0) return "irreversible";
  if (!partialBody) return pathRisk;
  return invoiceDeliveryClearedFields(body).length > 0 ? "irreversible" : pathRisk;
}

/**
 * Every way a call can change invoice delivery, with the direction, for error messages.
 *
 * One function rather than three call sites assembling their own lists, because the message and the
 * classification disagreeing about WHY a call was refused is a bug this repo has already shipped
 * once — a refusal naming `iban` for a body that also armed a send.
 */
export function invoiceDeliveryChanges(body: unknown, partialBody: boolean): string[] {
  const changes: string[] = [];
  const set = invoiceDeliveryFields(body);
  if (set.length > 0) changes.push(`${set.join(", ")} set to a new address`);
  if (partialBody) {
    const cleared = invoiceDeliveryClearedFields(body);
    if (cleared.length > 0) changes.push(`${cleared.join(", ")} emptied`);
  }
  return changes;
}

function presentFields(
  candidates: Array<Record<string, unknown>>,
  names: ReadonlySet<string>,
): string[] {
  return [
    ...new Set(
      candidates.flatMap((candidate) =>
        Object.entries(candidate)
          .filter(
            ([key, value]) =>
              names.has(key.toLowerCase()) &&
              value !== undefined &&
              value !== null &&
              String(value).trim() !== "",
          )
          .map(([key]) => key),
      ),
    ),
  ];
}

/**
 * Payment-routing fields present in a body, for use in error messages.
 *
 * NESTED, unlike the other inspectors. The supplier invoice carries its destination one
 * object down — `{ paymentDetails: { iban } }`, described in the spec as "The beneficiary
 * IBAN" — so a top-level-only scan saw nothing and this whole guard did not apply to the
 * one payload most obviously about where a payment goes.
 *
 * The reason the other inspectors stay top-level is that recursing would flag fields which
 * merely RECORD whether something was sent. That does not apply here, and it is checked
 * rather than assumed: within payment-routing scope, every in-set field name appears
 * either at the top level or under `paymentDetails`, and no nested object in scope carries
 * one of these names meaning a chart-of-accounts code (the cost lines use
 * `accrualAccountNumber`, which is deliberately not in the set). So recursion cannot
 * produce the false claim "this changes where a payment will go".
 */
export function paymentRoutingFields(body: unknown): string[] {
  return presentFields(nestedObjects(body), PAYMENT_ROUTING_FIELDS);
}

/** Depth bound. `paymentDetails.beneficiaryAddress` is the deepest real nesting. */
const MAX_BODY_DEPTH = 4;

/** Every object reachable through objects and arrays, bounded. */
function nestedObjects(body: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > MAX_BODY_DEPTH || !body || typeof body !== "object") return [];
  if (Array.isArray(body)) return body.flatMap((element) => nestedObjects(element, depth + 1));
  const self = body as Record<string, unknown>;
  return [self, ...Object.values(self).flatMap((value) => nestedObjects(value, depth + 1))];
}

/**
 * Escalate a call that changes where money is sent.
 *
 * Reversible as a RECORD and irreversible as a PAYMENT: the loss happens later, when
 * a human pays the invoice in the ReAI UI to whatever account is on file.
 */
/**
 * Whether writing a destination on this path redirects money.
 *
 * Exported so the refusal MESSAGE can ask the same question as the verdict. The verdict
 * short-circuits on an already-irreversible path and never inspects the body, which left
 * the message describing a supplier-invoice write as an ordinary ledger post while it was
 * repointing the beneficiary's account.
 */
export function inPaymentRoutingScope(path: string, method?: string): boolean {
  const adding = method !== undefined && method.toUpperCase() === "POST";
  return pathForms(path).some((normalized) => {
    if (!PAYMENT_ROUTING_PATHS.some((re) => re.test(normalized))) return false;
    // Creating an inward-facing record is ordinary work; repointing one is not. The
    // original exemption was written for company banks and never distinguished adding
    // from repointing — this keeps that distinction and applies it to leases too.
    if (adding && ADDING_IS_ORDINARY.some((re) => re.test(normalized))) return false;
    return true;
  });
}

export function classifyPaymentRouting(
  pathRisk: Risk,
  path: string,
  body: unknown,
  method?: string,
): Risk {
  // Only a reversible write can be escalated, the same rule classifyWithBody applies
  // and states: "blocking a read because a stray field was passed alongside it would be
  // a false positive". These two guarded on irreversible alone, so a GET carrying an
  // `iban` in its body came back irreversible and was refused in read-only mode — the
  // mode people point at a live business. reai_request accepts a body on any method, so
  // it was reachable, and it blocked exactly the safe operation.
  if (pathRisk !== "reversible") return pathRisk;
  // Both readings of the path, or a matrix parameter would put the request outside the
  // scope of this guard while classifyRequest read it as an ordinary reversible write.
  if (!inPaymentRoutingScope(path, method)) return pathRisk;
  return paymentRoutingFields(body).length > 0 ? "irreversible" : pathRisk;
}


/**
 * Whether a CURATED tool's arguments escalate its declared risk.
 *
 * The escape hatch runs `classifyWithBody` and `classifyPaymentRouting` on every
 * request, but curated tools were gated on their static `risk` alone — so
 * `reai_update_supplier`, declared `reversible`, accepted `iban` and repointed a
 * supplier's bank account in the DEFAULT mode, while `reai_request` refused the
 * identical `PATCH /api/suppliers/{id}`. A curated tool quietly doing what the
 * escape hatch forbids is the exact failure this project treats as its worst.
 *
 * Scoped by the tool's declared `apiPaths`, because the field names are ambiguous
 * out of context: `accountNumber` on a supplier is a bank account, and on a
 * bookkeeping tool it is a chart-of-accounts code like 4300. Matching on the name
 * alone would refuse ordinary ledger work.
 *
 * An over-approximation by design — arguments are not the request body, and a
 * handler may rename or drop fields. It can therefore refuse a call the body would
 * not have escalated, and that is the direction to be wrong in.
 */
export function curatedArgsEscalate(
  apiPaths: ReadonlyArray<readonly [string, string]>,
  args: unknown,
): { risk: Risk; fields: string[]; consequence: string; verify: string; transmits: boolean } | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;

  // ALL the reasons, not the first one found.
  //
  // Returning on the first hit made the refusal message wrong rather than merely partial.
  // The server appends "Every other field on this tool is unaffected, so the same call
  // without those fields will work" — and for a body carrying both `iban` and `sendEhf`
  // it named only `iban`, so dropping that field earns a second refusal for a reason
  // never mentioned, with a contradictory explanation. The arms-a-send half is also the
  // more permanent consequence of the two, and it was the half omitted.
  const reasons: Array<{ fields: string[]; consequence: string; verify: string; transmits: boolean }> = [];
  const add = (fields: string[], consequence: string, verify: string, transmits = false) => {
    if (fields.length === 0) return;
    if (reasons.some((r) => r.consequence === consequence)) return;
    reasons.push({ fields, consequence, verify, transmits });
  };

  for (const [method, path] of apiPaths) {
    // A tool's READ operations cannot redirect anything, and a tool commonly declares both:
    // the supplier-invoice tools list `GET /api/supplier-invoices` alongside their writes.
    // Since this forces `pathRisk` to "reversible" to ask the question, a curated read whose
    // arguments happened to include an `iban` filter came back irreversible and was refused.
    // That is the same false positive `classifyPaymentRouting` documents fixing on the
    // escape-hatch side, and it arrived here the moment supplier-invoices entered routing
    // scope. Unreachable today — no curated read takes such an argument — but the next one
    // to do so would be blocked in read-only mode, the mode people point at a live business.
    if (method.toUpperCase() === "GET") continue;

    if (classifyPaymentRouting("reversible", path, args, method) === "irreversible") {
      add(
        paymentRoutingFields(args),
        "this changes where money is sent — whoever pays this counterparty next, quite " +
          "possibly a person in the ReAI UI long afterwards, sends to whatever account is on file",
        "confirm the new bank details against something outside this conversation",
      );
    }
    // A curated tool's arguments are always PARTIAL, whatever HTTP method it uses underneath: every
    // one of these tools reads the record and merges, so a caller who wants a field left alone
    // leaves the argument out. That makes naming it with an empty value unambiguous intent to empty
    // it — including for reai_update_subscription, whose endpoint is a whole-record PUT.
    //
    // Except on a POST, where there is no stored address to redirect. Without that exception
    // reai_create_subscription refused `invoiceEmail: ""` in the default mode, which is the same
    // false positive the classifier's own docstring records fixing for PUT /api/orders/{id}: a call
    // that changes nothing, blocked in the mode people point at a live business.
    if (
      classifyInvoiceDelivery("reversible", path, args, method.toUpperCase() !== "POST") ===
      "irreversible"
    ) {
      const cleared = invoiceDeliveryClearedFields(args);
      const isClearing = invoiceDeliveryFields(args).length === 0 && cleared.length > 0;
      add(
        isClearing ? cleared : invoiceDeliveryFields(args),
        isClearing
          ? "this empties where invoices are delivered — future invoices stop going to the " +
            "address someone chose, and where they go instead is not something this server has " +
            "measured; either way nobody finds out until one is issued"
          : "this changes where invoices are delivered — every future invoice goes to that " +
            "address, and the disclosure happens later, when someone issues one normally",
        isClearing
          ? "check with whoever set that address why it is there before removing it"
          : "confirm the address with the customer through a channel you already trust",
      );
    }
    // The same body fields the escape hatch escalates on. This helper checked payment
    // routing and invoice delivery only, so a curated tool declared `reversible` that
    // accepted sendEhf, outputMode or automaticBillingGeneration would have armed a send
    // in the default mode while reai_request refused the identical call — the exact bug
    // class this helper exists for, with the arms-a-send half missing. No shipped tool
    // took one of those fields; a subscription tool would have been the first.
    if (
      pathForms(path).some((n) => ARMS_A_SEND_PATHS.some((re) => re.test(n))) &&
      classifyWithBody("reversible", args) === "irreversible"
    ) {
      add(
        escalatingBodyFields(args),
        "this arms an external send or lets ReAI issue invoices on its own — the document " +
          "leaves for a counterparty later, without another call, and cannot be recalled",
        "confirm the recipient and the schedule, and check REAI_ALLOW_EXTERNAL_SEND is meant " +
          "to be on for this deployment",
        // The second axis. Write mode answers "can this be undone in the books";
        // REAI_ALLOW_EXTERNAL_SEND answers "does this reach someone else", and `full` does
        // not lift it. Escalating the risk alone left a curated tool transmitting in full
        // mode with sending off, where reai_request refuses the identical call — the two
        // switches collapsed into one for exactly the fields that arm a send.
        classifyWithBody("reversible", args) === "irreversible",
      );
    }
  }

  if (reasons.length === 0) return undefined;
  return {
    risk: "irreversible",
    fields: [...new Set(reasons.flatMap((r) => r.fields))],
    consequence: reasons.map((r) => r.consequence).join("; and "),
    verify: reasons.map((r) => r.verify).join("; and "),
    transmits: reasons.some((r) => r.transmits),
  };
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
  sendehf: bindsToTrue,
  // A subscription set to produce invoices, or to bill automatically, will issue and
  // DELIVER them with no further call. The write ladder already escalated these to
  // irreversible; transmission said "none", so `full` mode alone armed recurring
  // delivery to a real customer. That is exactly the case the two-axis design exists
  // to catch, and it was slipping between the axes.
  outputmode: bindsToCreateInvoice,
  automaticbillinggeneration: bindsToTrue,
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
  // Every reading of the path: a transmitting pattern that matches ANY of them counts,
  // so a matrix parameter or a doubled slash cannot hide an EHF send behind a shape.
  const forms = pathForms(canonical?.pathname ?? path, canonical?.decodedPathname);

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
    return forms.some((n) => TRANSMITTING_GETS.some((re) => re.test(n))) ? "external" : "none";
  }

  // Revoking a pending signer sends nothing: the spec calls it "Deletes a pending
  // signer and invalidates its signing link". The pattern below is method-blind, so it
  // caught the revocation along with the send — meaning you could email a signing
  // request and then be unable to withdraw it without enabling external send, the flag
  // refusing the action that undoes what it exists to control. Still irreversible: a
  // deleted signer cannot be restored.
  if (
    method === "DELETE" &&
    forms.some((n) => /^\/api\/agreements\/[^/]+\/sign-requests\/[^/]+$/.test(n))
  ) {
    return "none";
  }

  // Paying a supplier invoice can start a REAL outgoing bank transfer. The endpoint's own
  // description: "For a bank-integrated payment that requires customer approval, approvalUrl
  // provides the authenticated ReAI handoff that starts the BankID approval flow", and the
  // cancel path answers 409 with an scaRedirectUrl when the provider requires SCA. That is
  // money leaving for a third party, which is what already puts /adyen/payout and
  // /kassasystem/mobile/payment-request on this axis.
  //
  // Conditional rather than blanket, because the endpoint is two operations wearing one path:
  // manualPayment=true RECORDS a payment that has already left the bank, which is bookkeeping
  // and sends nothing. Anything else — including OMITTING the field — selects the integration
  // flow. That the default is the dangerous one is measured, not assumed: omitting it once
  // during live verification started the bank-integrated flow, which is why the curated tool
  // makes manualPayment required. reai_request has no such schema, so the gate belongs here
  // too, or the escape hatch is the one way to start a transfer with sending switched off.
  //
  // paidPrivately alone does NOT exempt it, deliberately. A private settlement returns a
  // voucherId rather than a payment id and takes no companyBankId, which reads like
  // bookkeeping — but nothing says a sole proprietor's private account cannot also be paid
  // through bank approval, and that is not a guess worth making in this direction. Pass
  // manualPayment: true alongside it to say plainly that the money has already moved.
  if (
    method === "POST" &&
    forms.some((n) => /^\/api\/supplier-invoices\/[^/]+\/payments$/.test(n)) &&
    !inspectableObjects(body).some((o) =>
      Object.entries(o).some(([k, v]) => k.toLowerCase() === "manualpayment" && bindsToTrue(v)),
    )
  ) {
    return "external";
  }

  if (forms.some((n) => TRANSMITTING_PATTERNS.some((re) => re.test(n)))) return "external";

  for (const candidate of inspectableObjects(body)) {
    for (const [key, value] of Object.entries(candidate)) {
      if (TRANSMITTING_BODY_FIELDS[key.toLowerCase()]?.(value)) return "external";
    }
  }
  return "none";
}

/** Names the body fields that made a call transmitting, for error messages. */
export function transmittingBodyFields(body: unknown): string[] {
  return [
    ...new Set(
      inspectableObjects(body).flatMap((candidate) =>
        Object.entries(candidate)
          .filter(([k, v]) => TRANSMITTING_BODY_FIELDS[k.toLowerCase()]?.(v) === true)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`),
      ),
    ),
  ];
}

export class ExternalSendBlockedError extends Error {
  constructor(what: string) {
    super(
      // "document, email or signing request" was the whole list until money movement and an
      // access invitation joined this axis. A refusal that names the wrong kind of thing reads
      // like a misfire, and an agent that thinks the gate misfired looks for a way around it.
      `${what} reaches someone outside this tenant — a document, an email, a signing request, a ` +
        `filing, an access invitation, or money leaving on a bank integration — and ` +
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
      // The list used to read as a description of THIS call, and for the path-specific rules it
      // was simply false: renaming a company bank was refused with "posts to the general ledger,
      // issues legal documents, runs payroll". The harm is directional — an agent told that asks
      // its operator for REAI_WRITE_MODE=full, which unlocks real ledger writes, when what the
      // call needed was to send the account number back. So the list is now offered as the class
      // it is, with a pointer at the endpoint's own note.
      "Operations in this class cannot be cleanly undone: posting to the general ledger, issuing " +
      "a legal document, moving money, running payroll, filing with the tax authority, " +
      "administering users, or REPLACING a record in a way that destroys the fields left out. " +
      "Which of those applies to this endpoint is on the endpoint — reai_describe_endpoint and " +
      "reai_api_notes carry its known quirks, and for a replacement the fix is usually to send " +
      "the missing fields rather than to raise the write mode. If it genuinely needs the higher " +
      'ceiling, restart the server with REAI_WRITE_MODE=full. ' +
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
