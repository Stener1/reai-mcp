import { z, type ZodRawShape, type ZodTypeAny } from "zod";
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

/**
 * Text is what every tool returns.
 *
 * The UI surface adds `structuredContent` alongside it rather than a second content block:
 * under MCP Apps the view is a registered resource the host fetches once, so a tool result
 * never carries markup. An embedded-resource arm existed here for the first version of that
 * view and is gone with it.
 */
export type ToolContentBlock = { type: "text"; text: string };

export type ToolResult = {
  content: ToolContentBlock[];
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
  /**
   * Passed through as the tool's `_meta`.
   *
   * Used for the MCP Apps `ui.resourceUri` pointer, which is how a host finds the view a
   * tool renders into. Kept as a passthrough rather than a typed field because `_meta` is
   * an extension point: what belongs in it is decided by the extension, not by us.
   */
  meta?: Record<string, unknown>;
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
      //
      // Sized against the REAL note, not the fixed reserve. The reserve is a worst case
      // for the nested-object note, which names every trimmed field; the array note is a
      // single sentence. Using it here threw away 1200 characters of headroom, and for
      // one item between the reserved budget and the true cap that meant discarding it
      // entirely while claiming it "exceeds the 24000-character limit" — a 23,026-char
      // item was dropped with 23,769 characters left unused.
      const arrayNote = (count: number): string =>
        count === 0
          ? `NOTE: nothing is shown — the FIRST of ${data.length} item(s) alone exceeds the ` +
            `${MAX_RESULT_CHARS}-character limit, so no whole item fits. This is NOT an empty ` +
            `result. Fetch the item by id, or use a tool that returns a summary rather than the ` +
            `full record.`
          : `NOTE: response truncated — showing the first ${count} of ${data.length} items, complete. ` +
            `Narrow the result with date, status or id filters, or use the limit/page parameters.`;

      const overhead = parts.reduce((n, part) => n + part.length + 1, 0) + 2;
      let shown = countFittingSerialized(data, BODY_BUDGET);
      const refined = countFittingSerialized(
        data,
        MAX_RESULT_CHARS - overhead - arrayNote(Math.max(shown, 1)).length,
      );
      if (refined > shown) shown = refined;
      // The note grows by a digit or two as the count rises, so confirm rather than
      // assume: step down until the assembled result genuinely fits.
      while (
        shown > 0 &&
        stringify(data.slice(0, shown)).length + arrayNote(shown).length + overhead > MAX_RESULT_CHARS
      ) {
        shown -= 1;
      }

      // An empty array is not "nothing shown", it is "no results" — valid JSON that
      // reads as an answer. The object branch already returns nothing in this case for
      // exactly that reason; these two disagreed. And the note omitted the total, so
      // ok([oversized, {id:10}, {id:11}]) said "[]" and never mentioned three items.
      body = shown === 0 ? "" : stringify(data.slice(0, shown));
      parts.push(arrayNote(shown));
    } else if (typeof data === "string") {
      // Plain text is not serialised with indentation, so the line-boundary rule below
      // has nothing to cut back to and discarded the entire response — 40,000 characters
      // came back as the note alone, which read as "the call returned nothing". Text has
      // no JSON token to split, so a prefix is safe; it is simply partial, and the note
      // has to say that rather than the opposite.
      const total = body.length;
      body = body.slice(0, BODY_BUDGET);
      parts.push(
        `NOTE: text truncated — showing the first ${BODY_BUDGET} of ${total} characters. ` +
          `It ends mid-text, so do not read the tail as the end of the document.`,
      );
    } else if (trimNestedArrays(data) !== undefined) {
      // A nested object whose bulk is in its arrays. The line-boundary rule below keeps
      // every SCALAR whole, but it cut those arrays mid-item and then claimed "no value
      // shown is partial" — and, worse, dropped later fields with no field-level signal.
      // Measured on a real bank reconciliation: 200 pending transactions came back as 92
      // whole ones plus a half, with pendingPostings and matchedGroups gone entirely. An
      // agent asking "what still needs reconciling" saw unmatched transactions and NO
      // unmatched postings, concluded there was nothing on the ledger side to match, and
      // would reach for the booking tool — which posts — instead of the matching one.
      //
      // Trimming the arrays themselves keeps the result valid JSON, keeps every item
      // whole, keeps every field present, and says per field what was cut.
      const { value, trims } = trimNestedArrays(data)!;
      body = stringify(value);
      const trimmed = trims.filter((t) => t.shown < t.total);
      const named = trimmed
        .slice(0, TRUNCATION_NOTE_MAX_FIELDS)
        .map((t) => `${t.field} shows ${t.shown} of ${t.total}`)
        .join(", ");
      const rest = trimmed.length - TRUNCATION_NOTE_MAX_FIELDS;
      parts.push(
        `NOTE: response truncated to fit ${MAX_RESULT_CHARS} characters. It is still valid JSON ` +
          `and every value in it is complete — the long lists were shortened, not cut mid-item: ` +
          named +
          (rest > 0 ? `, and ${rest} further list(s) shortened` : "") +
          `. Every other field is present and whole. Do not read a shortened list as exhaustive; ` +
          `the count fields in the response give the real totals.`,
      );
    } else {
      // Otherwise drop back to a line boundary and discard the final line, which may
      // be a partial token. JSON.stringify with indentation puts each scalar on its
      // own line, so a whole-line cut cannot split a number or a string.
      const cut = body.slice(0, BODY_BUDGET);
      const lastNewline = cut.lastIndexOf("\n");
      const kept = lastNewline > 0 ? cut.slice(0, lastNewline) : "";
      // One early oversized field — a base64 attachment, a long description — pushes the
      // first line boundary past the cut, leaving nothing but the opening brace. Saying
      // "truncated, fields after the cut are missing" over a lone `{` invites the reader
      // to treat it as a partial record; there is no record.
      if (kept.replace(/[\s{[]/g, "").length === 0) {
        body = "";
        parts.push(
          `NOTE: nothing is shown — the first field of this response alone exceeds the ` +
            `${MAX_RESULT_CHARS}-character limit, so no whole value fits. This usually means an ` +
            `embedded file or a long text field. Fetch the record with a tool that omits it, or ` +
            `request the attachment separately.`,
        );
      } else {
        body = kept;
        parts.push(
          `NOTE: response truncated at about ${MAX_RESULT_CHARS} characters and is NOT valid JSON — ` +
            `it stops at a line boundary, so no value shown is partial, but fields after the cut are ` +
            `missing entirely. Request a narrower slice rather than reading totals from this.`,
        );
      }
    }
  }

  const text = parts.length ? `${parts.join("\n")}\n\n${body}` : body;
  return { content: [{ type: "text", text }] };
}

/**
 * A list result, where "the API did not return a list" and "the list is empty" are
 * different answers.
 *
 * Thirteen list tools wrote `Array.isArray(data) ? data.length : 0` and then stated that
 * number. So a 200 carrying `{content: [...]}` — a shape this API already uses on
 * `/api/leads` and `/api/warehouses/inventory` — was reported as "0 customer(s)".
 *
 * The rows were NOT lost: every one of those tools passed `res.data` to `ok()`, so the
 * payload always survived and only the sentence above it was false. That is a smaller bug
 * than the first version of this comment claimed, and worth stating accurately — an agent
 * reads the sentence, but the data was there to be looked at.
 *
 * Nothing is wrong on today's endpoints, which return bare arrays. The day one of them
 * starts paginating, thirteen tools begin answering "there are none" about a company's
 * customers, invoices and vouchers at once.
 *
 * An HTTP error cannot reach here — the client throws ReaiApiError on any non-2xx — so this
 * is specifically about a successful response whose shape is not the expected one.
 */
export function okList(
  data: unknown,
  opts: { noun: string; suffix?: string; empty?: string },
): ToolResult {
  const { noun, suffix = "", empty } = opts;
  if (!Array.isArray(data)) {
    return ok(data, {
      note:
        `The ${noun} endpoint did not return a list, so there is no count to give. The response ` +
        `is returned below as received — subject to the usual truncation note if it is large — ` +
        `and this is NOT a report of "no ${noun}s".`,
    });
  }
  return ok(data, {
    // `empty` REPLACES the whole note, suffix included.
    //
    // A previous version appended the suffix to it, to keep a fact-carrying suffix — the
    // widened-window sentences on orders, offers and invoices — from being lost at zero.
    // That was solving a case that does not exist: those tools pass no `empty` at all, so
    // they already read "0 order(s). Window widened back to 2000-01-01." at zero, which is
    // exactly right. What it did instead was produce
    //
    //   "No employees are registered on this tenant.. The collection returns id, name and
    //    email only"
    //
    // against the live API — a doubled full stop, and a sentence about what the collection
    // returns when it returned nothing. A suffix describing the RESULT SET is noise once
    // there is no result set; one describing the QUERY belongs in the count branch, where
    // it already is.
    note: data.length === 0 && empty ? empty : `${data.length} ${noun}(s)${suffix}`,
  });
}

/** A plain textual answer, for tools whose output is prose rather than data. */
export function okText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Space held back for the truncation note, which is part of what the caller sees. */
const TRUNCATION_NOTE_RESERVE = 1200;

/**
 * What the BODY may occupy, for every branch.
 *
 * The cap is on what the caller receives, and the note is part of that. Three of the
 * four branches sized only the body and then prepended the note, so a "24,000-character"
 * response came back at 24,127 / 24,139 / 24,159. Each branch was internally consistent
 * and they disagreed with each other, which is what happens when two rewrites each
 * define the same constant for themselves.
 */
const BODY_BUDGET = MAX_RESULT_CHARS - TRUNCATION_NOTE_RESERVE;

/** How many trimmed fields the note names before summarising the rest. */
const TRUNCATION_NOTE_MAX_FIELDS = 6;

/**
 * Shorten the array-valued properties of an object until the whole thing fits.
 *
 * Returns undefined when this cannot help — the value is not a plain object, has no
 * arrays, or does not fit even with every array emptied — leaving the caller to fall
 * back to the line-boundary rule.
 *
 * Arrays are grown round-robin from empty rather than one at a time, so a single huge
 * list cannot consume the whole budget and leave the others showing nothing. Seeing
 * that a list exists but is empty is the specific wrong answer worth avoiding here.
 *
 * Per-item costs are measured EXACTLY, once, rather than sampled. A sampled average
 * was wrong in both directions: a list of five short strings followed by 1 KB strings
 * admitted thousands of items that then had to be removed one at a time, which is
 * quadratic — about 1972 full serialisations, some 23 seconds, blocking the event loop
 * — and in the other direction an average inflated by a few large entries could reject
 * a field whose FIRST item would have fitted, reproducing the empty-list outcome this
 * function exists to prevent. One pass of `stringify` per item costs the same as
 * serialising the payload once.
 */
function trimNestedArrays(
  data: unknown,
): { value: Record<string, unknown>; trims: Array<{ field: string; shown: number; total: number }> } | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const entries = Object.entries(data as Record<string, unknown>);
  const arrayFields = entries.filter(([, v]) => Array.isArray(v) && (v as unknown[]).length > 0) as Array<
    [string, unknown[]]
  >;
  if (arrayFields.length === 0) return undefined;

  const counts = new Map(arrayFields.map(([k]) => [k, 0]));
  const build = (): Record<string, unknown> =>
    Object.fromEntries(
      entries.map(([k, v]) => (Array.isArray(v) && counts.has(k) ? [k, v.slice(0, counts.get(k))] : [k, v])),
    );

  // The note counts against the cap too: it names every trimmed field, so an object
  // with a thousand short arrays produced a 23.9 KB body under an 18.7 KB note — a
  // "capped" response of 42.6 KB, still crowding out the conversation.
  const budget = BODY_BUDGET;
  const base = stringify(build()).length;
  if (base > budget) return undefined;

  const itemCost = new Map(
    arrayFields.map(([k, items]) => [k, items.map((item) => stringify(item).length + 8)]),
  );

  let used = base;
  let grew = true;
  while (grew) {
    grew = false;
    for (const [field, items] of arrayFields) {
      const at = counts.get(field) ?? 0;
      if (at >= items.length) continue;
      // The cost of the NEXT item specifically, not an average over the list.
      const next = used + (itemCost.get(field)?.[at] ?? 1);
      if (next > budget) continue;
      counts.set(field, at + 1);
      used = next;
      grew = true;
    }
  }

  // Verify against the real serialisation. Exact costs make this a formality, but the
  // separator arithmetic is still an approximation, so halve rather than decrement:
  // that bounds the work at O(log n) serialisations however wrong the estimate was.
  while (stringify(build()).length > budget) {
    const largest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!largest || largest[1] === 0) return undefined;
    counts.set(largest[0], Math.floor(largest[1] / 2));
  }

  return {
    value: build(),
    trims: arrayFields.map(([field, items]) => ({
      field,
      shown: counts.get(field) ?? 0,
      total: items.length,
    })),
  };
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
function countFittingSerialized(items: unknown[], budget: number): number {
  if (items.length === 0) return 0;
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (stringify(items.slice(0, mid)).length <= budget) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Whether a number is a whole number of øre.
 *
 * A fixed 1e-9 tolerance is smaller than floating-point error at the magnitudes this
 * API accepts: 279796.4 is a valid multiple of 0.01, yet 279796.4 * 100 differs from
 * its rounded value by about 3.7e-9, so a fixed epsilon rejected a perfectly valid
 * quantity. Comparing the decimal representation avoids the arithmetic entirely.
 */
export function isWholeOre(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const text = String(value);
  // Exponential notation is checked on the WHOLE string, not just the fraction. 1e-7
  // stringifies as "1e-7" with no decimal point at all, so a fraction-only check saw
  // an empty decimals part and passed it — which is how a quantity of 1e-7 got through.
  if (text.includes("e") || text.includes("E")) return false;
  const decimals = text.split(".")[1] ?? "";
  return decimals.length <= 2;
}

/** A monetary amount in whole øre, which is the only precision ReAI accepts. */
export const oreAmount = z
  .number()
  .refine(isWholeOre, { message: "Amount must be a whole number of øre (at most 2 decimals)." });

/**
 * A name the API will accept: present, and not just whitespace.
 *
 * Verified against the live API rather than read off the schema, because the schema is
 * wrong here — `CreateCustomerReq.name` declares `minLength: 0`, and an earlier review
 * concluded from that an empty name was "correctly permitted". It is not:
 *
 *   POST /api/customers {"name": ""}                          -> 400 name="name is required"
 *   POST /api/customers {"name": "   "}                       -> 400 name="name is required"
 *   POST /api/customers {"name": "", organizationNumber: ...} -> 400 name="name is required"
 *
 * That last one also disproves the claim these tools carried, that a name may be
 * omitted when a Brønnøysund lookup can fill it in.
 *
 * A factory rather than a constant because `.refine()` yields a ZodEffects, which has
 * no `.max()` to chain — the length bound has to be applied to the string first.
 */
export function requiredName(maxLength?: number) {
  const base = maxLength === undefined ? z.string() : z.string().max(maxLength);
  return base.refine((v) => v.trim().length > 0, {
    message: "name is required — whitespace alone is rejected",
  });
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
/**
 * Two-letter uppercase ISO country code, matching the spec's `CountryCode` pattern.
 *
 * Was defined identically in sales.ts and purchase.ts, and the third place that needed it —
 * a subscription's service recipients — got a bare `z.string()` instead, so `"no"` was
 * accepted there and rejected by the API.
 */
/**
 * A fiscal year as this API takes it: four digits, and greater than zero.
 *
 * Shared rather than copied, which is the point. Three tools read the same fiscal year —
 * reai_get_tax_return, reai_create_vat_return and reai_get_annual_accounts — and they disagreed:
 * two took a four-digit string and the third, added later, took a number. An agent using two of them
 * in one session had to guess. A test can compare three copies and did, but one definition cannot
 * diverge in the first place.
 *
 * `"0000"` is refused. The spec declares `exclusiveMinimum: 0` on every one of these parameters, so
 * year zero is a value the API rejects, and four digits alone admitted it — review caught that: the
 * numeric schema the annual-accounts tool started with had refused 0, and the move to a string
 * quietly let it back in on all three.
 *
 * Declared as a string because that is the type the spec gives these path parameters, and it removes
 * the 2025-versus-"2025" question an agent otherwise has to answer per tool.
 */
export const fiscalYear = z
  .string()
  .regex(/^\d{4}$/, "Year must be four digits, e.g. 2026")
  // Four digits AND at least 1000, which is stricter than "greater than zero" for a reason review
  // found: `"0999"` passed a `> 0` refinement, and reai_get_annual_accounts converts the argument with
  // `Number(...)` so its payload reported year 999 for a request to /api/annual-accounts/0999. A
  // leading-zero year is not a fiscal year anybody has books for, and refusing it makes the conversion
  // injective — the field a consumer keys on identifies the year that was asked for.
  .refine(
    (value) => Number(value) >= 1000,
    "Year must be 1000 or later; a leading-zero year is not a fiscal year, and the API declares year > 0.",
  );

export const COUNTRY_CODE = z
  .string()
  .regex(/^[A-Z]{2}$/, 'Must be a two-letter uppercase ISO country code, e.g. "NO".');

/**
 * Three-letter uppercase currency code, matching the spec's `CurrencyCode` pattern.
 *
 * Its pattern lives behind a `$ref`, which the first version of the bounds sweep did not
 * follow — so four tools accepted "nok" and "norwegian" and failed at the API.
 */
export const CURRENCY_CODE = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Must be a three-letter uppercase ISO currency code, e.g. "NOK".');

/**
 * The phone rule, in one place, because three places said three different things and one of them was
 * false.
 *
 * Measured on the live API (tenant 2783, 2026-08-08) across `customer.phone`, `supplier.phone` and
 * `contactPersons[].phone`, which behave IDENTICALLY:
 *
 *  - The value is parsed with **Norway as the default region** and stored **canonicalised to E.164**.
 *    Nothing is stored as sent: `+46 70 123 45 67` becomes `+46701234567`, `(40) 12 34 56` becomes
 *    `+4740123456`, and even `tel:40123456` parses. Punctuation and spaces are ignored.
 *  - A leading `+CC`, `00CC`, or a bare `47` selects the country. Anything else is read as NORWEGIAN.
 *  - The digits must be valid for whichever country that resolved to, else 400.
 *
 * The trap is the combination of the last two. A bare number that happens to be valid in Norway is
 * stored under +47 with no warning, whatever the caller meant: the Danish mobile `40123456` becomes
 * `+4740123456`, while `20123456` is refused — not because it is Danish, but because `20` is
 * unallocated in Norway (`21123456` and `22334455` are both fine). So the risk is a foreign number
 * saved quietly as the wrong number, and the remedy is always sending the country code with a `+`.
 * A bare `47` counts as one; a bare `45` does not (`4540123456` is refused, `004540123456` is not).
 *
 * What this replaced: a quirk asserting "two phone fields, opposite rules — the ENTITY phone rejects
 * a +47 prefix", with two tool descriptions telling agents to strip it. Measured false — `PATCH
 * /api/customers/{id}` and `/api/suppliers/{id}` both answer 200 to `+4722334455` and store it. There
 * is one rule, not two.
 *
 * The one endpoint that genuinely differs is the EMPLOYEE phone, which stores an unparseable value as
 * null with a 200 instead of refusing it; `organisation.ts` documents that separately and reads the
 * write back. Everywhere else an unparseable value is a 400 and the stored value is untouched.
 */
export const PHONE_RULE =
  "Stored canonicalised to E.164, so it will not come back exactly as sent — spaces and punctuation " +
  "are ignored and a Norwegian number sent bare or 0047-prefixed becomes +47…. " +
  "ALWAYS include the country code with a + for a non-Norwegian number: bare digits are parsed as " +
  "NORWEGIAN, and if they are valid as such they are stored under +47 with no warning (measured: the " +
  "Danish mobile 40123456 became +4740123456). Foreign numbers are otherwise accepted — +46701234567, " +
  "+14155552671, +447911123456 all verified. An unparseable value is refused with 400, worded in " +
  "Norwegian whatever the number's country, which is not evidence that a Norwegian one was expected.";

/**
 * What `skipRegistryLookup` does, in one place, because two tools carry the flag and both described it
 * wrongly — and because the honest account needs more room than an argument description.
 *
 * Measured on 29 organisation numbers against POST /api/customers and POST /api/suppliers (tenant
 * 2783, 2026-08-08), each record read back and deleted:
 *
 *  - Without the flag, a Norwegian company is looked up and the registry's name replaces the one you
 *    sent, for every number tested. That part was already documented and holds.
 *  - With the flag, an ORDINARY company keeps the name AND the address you sent: Equinor 923609016,
 *    Symfoni 915772137, VN Norge 821083052, Telenor ASA 982463718, two sole proprietorships, a
 *    sub-unit, NAV 889640782, Politidirektoratet, Digdir, Lånekassen — all respected it.
 *  - But roughly half of the well-known BILLING counterparties ignore the flag entirely: banks,
 *    insurers, telecoms, power, post, fuel and the fee-collecting agencies. Sixteen of the
 *    twenty-nine, including Skatteetaten, Brønnøysundregistrene, Statens vegvesen, Kartverket,
 *    Husbanken, DNB, Nordea, SpareBank 1, Telia, Telenor Norge, Elvia, Posten Bring, If, Gjensidige
 *    and Circle K. Their name overwrites yours and so does their address, even one you supplied in the
 *    same request. Deterministic on re-run.
 *
 * **The override does not come from Brønnøysundregistrene**, which the first version of this note got
 * wrong. Three results rule the registry out:
 *
 *   971648198  Brreg: "INNKREVINGSMYNDIGHETEN"     ReAI: "Statens Innkrevingssentral"  (a former name)
 *   920058817  Brreg: "NORDEA BANK ABP NUF"        ReAI: "First Card (nor)"            (a card brand)
 *   976967631  Brreg: Postboks 800, 1331 Fornebu   ReAI: Postboks 800, 7900 Rørvik     (wrong postcode)
 *
 * So the source is a ReAI-maintained directory of standard counterparties, and it is STALE. That is a
 * worse hazard than "the registry wins": a customer can be created carrying a superseded name or an
 * address that is simply wrong, with a 201 and no warning. The Telenor pair is the cleanest test —
 * the holding company respects the flag, the billing entity does not.
 *
 * The flag also has one load-bearing use nothing documented: **an organisation number that is mod-11
 * valid but not registered can only be created WITH it.** Without, the lookup fails and the API answers
 * 500 `{"detail":"404 : [no body]"}`; with, the same request is a 201.
 */
export const SKIP_REGISTRY_LOOKUP_RULE =
  "Skips the Brønnøysund lookup, so an ordinary company keeps the name and address you send — and it " +
  "is the only way to create one whose organisation number is not registered (without it that request " +
  "fails with a 500 wrapping a 404). It is NOT a guarantee. Roughly half of the well-known Norwegian " +
  "billing counterparties — banks, insurers, telecoms, power, post, fuel, and the fee-collecting " +
  "public agencies — overwrite both name and address regardless of the flag, from a ReAI-maintained " +
  "directory rather than from the registry. That directory is stale: 971648198 comes back under a " +
  "superseded name and 976967631 with the wrong postcode. So read the created record back whenever the " +
  "name or address matters.";

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

/**
 * Merge a caller's changes into a record that must be written back WHOLE.
 *
 * Several endpoints here replace rather than patch, so a body carrying one field clears every
 * other one it omits — measured on agreements (every lease term), company banks and creditors
 * (the account number), and the address sub-resources (the postcode). The safe shape is always
 * the same: read the record, overlay the changes, send back everything settable.
 *
 * Six tools now do that, and FOUR use this: reai_update_company_bank, reai_update_creditor,
 * reai_set_supplier_address and reai_update_subscription. reai_set_customer_address and
 * reai_update_agreement still hand-roll it — the first predates this helper and keeps its own parts
 * list, the second dispatches on a template and merges into a sub-object of a wrapper, which is a
 * different enough shape that folding it in would complicate both. Worth saying rather than
 * claiming the de-duplication is finished: it is two thirds done, deliberately for the agreement
 * tool and only by inertia for the customer one.
 *
 * `settable` matters as much as the merge: a response usually carries more than its request
 * accepts — CompanyBankRes has 18 properties against CompanyBankReq's six — so echoing a GET
 * verbatim sends fields the endpoint has no place for.
 *
 * A `null` in `changes` is kept, because clearing a field deliberately is a legitimate edit; an
 * `undefined` is dropped, because that is what "I did not mention this" looks like after Zod
 * has parsed absent optional arguments.
 */
export function mergeForReplacement(opts: {
  existing: Record<string, unknown>;
  changes: Record<string, unknown>;
  settable: readonly string[];
  required?: readonly string[];
}): {
  merged: Record<string, unknown>;
  /** Fields carried over from the record because the caller did not mention them. */
  kept: string[];
  /** Change keys the record does not already have — a new value, or a misspelling. */
  unknown: string[];
  /** Required fields that neither the change nor the record supplies. */
  missing: string[];
  /** Change keys the caller actually supplied. */
  given: string[];
} {
  const given = Object.entries(opts.changes).filter(([, v]) => v !== undefined);
  const base: Record<string, unknown> = {};
  for (const key of opts.settable) {
    const value = opts.existing[key];
    if (value !== undefined && value !== null) base[key] = value;
  }
  // The CHANGES half is filtered too. The base was, and this was not — so a key outside
  // `settable` was sent when supplied and dropped when carried over, which is the one asymmetry
  // this helper advertises against. No caller can hit it today (every tool's arguments are in its
  // list), but adding an argument and forgetting the list is exactly how that stops being true.
  const settableGiven = given.filter(([k]) => opts.settable.includes(k));
  const merged = { ...base, ...Object.fromEntries(settableGiven) };
  const givenKeys = settableGiven.map(([k]) => k);
  return {
    merged,
    kept: Object.keys(base).filter((k) => !givenKeys.includes(k)),
    // Own properties only: `in` walks the prototype chain, so a change named `toString` looked
    // like an existing field and skipped the warning this exists to give.
    unknown: givenKeys.filter((k) => !Object.hasOwn(opts.existing, k)),
    missing: (opts.required ?? []).filter((k) => {
      const value = merged[k];
      return value === undefined || value === null || value === "";
    }),
    given: givenKeys,
  };
}

/**
 * The record a merge will write into, or a refusal.
 *
 * `?? {}` was the first shape of this, and it collapsed "no record yet" into "I could not read
 * the response" — so a body that came back as text, or with the key renamed, produced an empty
 * base, and the write then sent the caller's fields alone. That is the destruction the merge
 * exists to prevent, with the caller believing they made a small edit.
 */
export function readableRecord(
  data: unknown,
  field?: string,
  /**
   * Keys the record is expected to carry, for the WHOLE-record case.
   *
   * Without this, any object passed: a response envelope, a body with renamed keys, or `{}` all
   * became a valid base, and the write then sent the caller's fields alone. That is the exact
   * destruction the merge exists to prevent — and for a creditor, whose only required field is
   * `name`, a rename supplies everything the API needs, so nothing downstream refuses either.
   * Verified: a GET returning `{"data": {...}}` produced `PUT {"name": "Renamed AS"}` and the
   * account number was gone, while the note said the other fields were "written back unchanged".
   *
   * A record that shares no expected key is therefore treated as unreadable rather than empty.
   */
  expect?: readonly string[],
): { record?: Record<string, unknown>; problem?: string } {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObject(data)) {
    return { problem: "the response was not a record object" };
  }
  if (field === undefined) {
    if (expect !== undefined) {
      const recognised = expect.filter((key) => Object.hasOwn(data, key));
      if (recognised.length === 0) {
        return {
          problem:
            Object.keys(data).length === 0
              ? "the response was an empty object, which is not a record of this kind"
              : `the response carried none of the fields this record should have ` +
                `(${expect.slice(0, 4).join(", ")}${expect.length > 4 ? ", …" : ""}) — its keys were ` +
                `${Object.keys(data).slice(0, 6).join(", ")}`,
        };
      }
    }
    return { record: data };
  }
  const nested = data[field];
  // Absent or null genuinely means "not set yet", which is a legitimate starting point.
  if (nested === undefined || nested === null) return { record: {} };
  if (!isObject(nested)) return { problem: `\`${field}\` was not an object` };
  return { record: nested };
}

/**
 * The same argument shape with every field optional.
 *
 * A merge tool needs this: the stored record supplies whatever the caller leaves out, so making
 * the API's required fields required HERE would mean "change the interval" also meant "and retype
 * the customer, the currency, the start date and every line" — which is the shape that loses data
 * in the first place. The create tool keeps the required versions, where they belong.
 */
export function optionalShape<S extends ZodRawShape>(shape: S): { [K in keyof S]: ZodTypeAny } {
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [
      key,
      // isOptional() is true for ZodOptional and for anything already accepting undefined, so an
      // already-optional field is left exactly as it is rather than double-wrapped.
      schema.isOptional() ? schema : schema.optional(),
    ]),
  ) as { [K in keyof S]: ZodTypeAny };
}
