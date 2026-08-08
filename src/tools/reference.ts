import { z } from "zod";
import { ReaiApiError } from "../reai/errors.js";
import {
  defineTool,
  ok,
  okList,
  requireTenantId,
  resolveTenantId,
  tenantIdArg,
  type ToolDef,
} from "./registry.js";

/**
 * Reference data and company-level financial state — four reads, three of them for questions this
 * API answers in a way that reads like failure.
 *
 * ## The codes this API accepts are a list, and the list is not in the spec
 *
 * `COUNTRY_CODE` and `CURRENCY_CODE` in registry.ts check the SHAPE of a code, because that is all
 * the spec gives them: two uppercase letters, three uppercase letters. Shape is not membership. `UK`
 * is a well-formed country code and not one this API takes — the code for the United Kingdom is `GB`
 * — so the local check passes and the call fails upstream, which is the worst division of labour
 * available. `GET /api/countries` and `GET /api/currencies` are the actual lists, and until now
 * nothing pointed at them.
 *
 * Both endpoints DO document their response, and it matches what the live API returns: `CountryRes`
 * is `{code, name, currencyCode}` and `CurrencyRes` is `{code, name}`, confirmed against 170 and 129
 * live rows. Worth saying because an earlier version of this file claimed the opposite, on a
 * measurement that counted wrong: 386 of the 430 operations here declare a 2xx schema, and 368 of
 * those declare it under the WILDCARD content type rather than under `application/json`. Counting
 * only `application/json` gives 12, which is how "almost nothing documents a response" came to be
 * written down as a fact.
 * The spec index carries no response shapes at all, which is a separate gap and not evidence about
 * the spec.
 *
 * The `currencyCode` on a country is its default currency, which is the field that makes the country
 * list worth reading before creating a foreign customer rather than after.
 *
 * ## A 404 that means "nothing recorded", not "wrong endpoint"
 *
 * `GET /api/opening-balances` and `GET /api/annual-accounts/{year}` both answer `404` when the thing
 * does not exist yet — measured on both test tenants: `404 "Opening balance not found"` and
 * `404 "No annual-accounts submission exists"`. That is a perfectly reasonable REST answer and a
 * terrible one for an agent, because a 404 on a collection-shaped path is indistinguishable from a
 * path that is wrong, a tenant that is wrong, or a module that is off — three conclusions this
 * server has seen drawn from a 404 already. Both tools turn it into the answer it actually is.
 */

type Country = { code?: string; name?: string; currencyCode?: string };
type Currency = { code?: string; name?: string };

/**
 * Filters a reference list HERE, not at the API.
 *
 * Both endpoints take no parameters at all, so any narrowing happens after the whole list arrives.
 * Said in the tool descriptions too: a caller who thinks the API is filtering will reason wrongly
 * about what a zero-result answer proves.
 */
function matching<T extends { code?: string; name?: string; currencyCode?: string }>(
  rows: T[],
  query: string | undefined,
): T[] {
  const needle = query?.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) =>
    // currencyCode is included because the country list's whole selling point is carrying it, so
    // "which countries use EUR" is the natural question — and it used to answer a confident zero.
    [row.code, row.name, row.currencyCode].some((field) => (field ?? "").toLowerCase().includes(needle)),
  );
}

/**
 * The query as the filter actually used it, or undefined.
 *
 * `matching` trims and ignores a blank query; the sentences below keyed on plain truthiness, so
 * `query: "   "` reported "5 country(s) matching \"   \", filtered locally out of 5" — a filter that
 * never ran, described as one that did, and on a single-row list it went on to claim that row matched.
 */
function effectiveQuery(query: string | undefined): string | undefined {
  const trimmed = query?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * A 404 from ReAI whose problem detail says the thing simply is not there.
 *
 * Both conditions matter and neither is enough alone. The STATUS has to come from the typed error
 * rather than from its rendered message: a 500 relaying a downstream body could contain the string
 * "HTTP 404", and a text-matched guard would report that outage as "no opening balance recorded" —
 * an outage turned into a fact about someone's accounts. The PHRASE then separates "there is nothing
 * recorded" from every other 404 the same path can produce, a mistyped path above all, which must
 * stay an error because it means the caller is not asking what they think they are.
 */
function isNotFound(err: unknown, phrase: RegExp): boolean {
  if (!(err instanceof ReaiApiError) || err.status !== 404) return false;
  return phrase.test(err.message) || phrase.test(err.rawBody ?? "");
}

const listCountries = defineTool({
  name: "reai_list_countries",
  title: "List the country codes this API accepts",
  description:
    "The countries ReAI supports, as `{code, name, currencyCode}` — the code to send in a " +
    "`countryCode` field, the English name, and that country's default currency.\n\n" +
    "Worth calling before guessing. Every countryCode argument on this server checks only that a " +
    "code is two uppercase letters, because that is all the spec documents; membership of this list " +
    "is a different question and only the API can answer it. `UK` is well formed and wrong — the " +
    "United Kingdom is `GB`.\n\n" +
    "`query` filters by code, name or default currency, case-insensitively, and it filters HERE: THIS " +
    "endpoint takes no parameters, so the whole list is fetched and narrowed locally. A no-match " +
    "answer therefore means no match in this list, not that the API was asked and said no. (The API " +
    "does have searchable variants, but they are internal endpoints this server does not expose.)\n\n" +
    "The response is documented as `array<CountryRes>` and the live API agrees with it: measured, " +
    "170 countries, every one a two-letter code carrying a currencyCode, with GB for the United " +
    "Kingdom and no UK at all.",
  risk: "read",
  apiPaths: [["GET", "/api/countries"]],
  idempotent: true,
  inputSchema: {
    query: z
      .string()
      .max(100)
      .optional()
      .describe('Filter by code or name, e.g. "sweden" or "SE". Applied locally, not by the API.'),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<Country[]>({
      method: "GET",
      path: "/api/countries",
      // GLOBAL data: the spec declares no X-Tenant-Id parameter for this endpoint, so requiring a
      // tenant would have made "what country codes does this API take" unanswerable until a company
      // was selected — and it is one of the first questions worth asking, right after authenticating.
      // `omitTenant` is how the meta tools already handle the same situation.
      tenantId: resolveTenantId(args.tenantId, ctx),
      omitTenant: args.tenantId === undefined,
    });
    const all = res.data;
    if (!Array.isArray(all)) {
      return ok(all, {
        note:
          `The countries endpoint did not return a list, so there is no count to give. The response ` +
          `is below as received, and this is NOT a report that the API supports no countries.`,
      });
    }
    const query = effectiveQuery(args.query);
    const rows = matching(all, query);
    return okList(rows, {
      noun: "country",
      suffix: query
        ? ` matching ${JSON.stringify(query)}, filtered locally out of ${all.length} the API ` +
          `returned.` +
          (rows.length === 1 && rows[0]?.code
            ? ` Send countryCode: ${JSON.stringify(rows[0].code)}.`
            : ``)
        : `. Each carries its default currencyCode, which is what to send as currencyCode on an ` +
          `invoice or order for that country unless you mean otherwise.`,
      empty: query
        ? `No country in this API's list matches ${JSON.stringify(query)}. The API was not ` +
          `asked — the endpoint takes no parameters, so this is a local search over the ` +
          `${all.length} countries it returned. Try a shorter fragment, or call this tool with no ` +
          `query and read the list.`
        : `The API returned an EMPTY country list, which is not a normal answer: countryCode fields ` +
          `elsewhere will reject everything. Treat this as an API problem, not as a fact about ` +
          `countries.`,
    });
  },
});

const listCurrencies = defineTool({
  name: "reai_list_currencies",
  title: "List the currency codes this API accepts",
  description:
    "The currencies ReAI supports, as `{code, name}` — the code to send in a `currencyCode` field " +
    "and its English name.\n\n" +
    "Same reason to call it as reai_list_countries: currencyCode arguments are checked for shape " +
    "only, three uppercase letters, because the spec documents a pattern and not a list. A " +
    "well-formed code that is not in this list fails at the API.\n\n" +
    "`query` filters by code or name, locally — THIS endpoint takes no parameters, so a no-match " +
    "answer is about this list and not about what the API would accept.\n\n" +
    "For the default currency of a COUNTRY, use reai_list_countries: each row carries a " +
    "currencyCode. Documented as `array<CurrencyRes>`, and measured live at 129 currencies.",
  risk: "read",
  apiPaths: [["GET", "/api/currencies"]],
  idempotent: true,
  inputSchema: {
    query: z
      .string()
      .max(100)
      .optional()
      .describe('Filter by code or name, e.g. "krone" or "SEK". Applied locally, not by the API.'),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<Currency[]>({
      method: "GET",
      path: "/api/currencies",
      // Global, like the country list: no X-Tenant-Id parameter in the spec, so no tenant needed.
      tenantId: resolveTenantId(args.tenantId, ctx),
      omitTenant: args.tenantId === undefined,
    });
    const all = res.data;
    if (!Array.isArray(all)) {
      return ok(all, {
        note:
          `The currencies endpoint did not return a list, so there is no count to give. The ` +
          `response is below as received, and this is NOT a report that the API supports no ` +
          `currencies.`,
      });
    }
    const query = effectiveQuery(args.query);
    const rows = matching(all, query);
    return okList(rows, {
      noun: "currency",
      suffix: query
        ? ` matching ${JSON.stringify(query)}, filtered locally out of ${all.length} the API ` +
          `returned.` +
          (rows.length === 1 && rows[0]?.code
            ? ` Send currencyCode: ${JSON.stringify(rows[0].code)}.`
            : ``)
        : `.`,
      empty: query
        ? `No currency in this API's list matches ${JSON.stringify(query)}. The API was not ` +
          `asked — this is a local search over the ${all.length} currencies it returned.`
        : `The API returned an EMPTY currency list, which is not a normal answer: currencyCode ` +
          `fields elsewhere will reject everything. Treat this as an API problem.`,
    });
  },
});

const getOpeningBalance = defineTool({
  name: "reai_get_opening_balance",
  title: "Get the opening balance, or establish that there is none",
  description:
    "The opening balance recorded for this tenant: the ledger position the books START from, before " +
    "any voucher in them.\n\n" +
    "Most tenants have none, and this tool exists for that case. The endpoint answers " +
    '`404 "Opening balance not found"` when none is recorded — measured on both test tenants — and a ' +
    "404 from a path shaped like a collection is indistinguishable from a wrong path, a wrong " +
    "tenant, or a module that is switched off. It is none of those: it is the answer.\n\n" +
    "Nothing here writes. `POST`, `PUT` and `DELETE /api/opening-balances` exist and are left to " +
    "reai_request deliberately, for two reasons. An opening balance IS ledger position, so setting " +
    "one restates every comparative figure the books produce. And the DELETE is documented as " +
    '"delete OR reverse" — the family this server has been caught by five times, where a reversal ' +
    "POSTS to the ledger rather than removing anything, so the 200 means the opposite of what it " +
    "looks like. Neither test tenant has an opening balance to experiment on, so this server has " +
    "never watched those three endpoints run: no curated tool will claim to know what they do.",
  risk: "read",
  apiPaths: [["GET", "/api/opening-balances"]],
  idempotent: true,
  inputSchema: { tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    try {
      const res = await ctx.client.request<unknown>({
        method: "GET",
        path: "/api/opening-balances",
        tenantId,
      });
      // The flag on BOTH branches, not just the 404 one. Review's point: a consumer keying on
      // `recorded` got `false` when nothing existed and `undefined` when something did, which is the
      // shape most likely to be read as falsy either way.
      return ok(
        { recorded: true, openingBalance: res.data ?? null },
        {
          note:
            `Tenant ${tenantId} HAS an opening balance recorded. The API returns it as a VOUCHER ` +
            `(VoucherDetailRes: id, number, date, description, postings, attachments), which is the ` +
            `clearest statement of what it is — a ledger document, not a settings page. That is also ` +
            `why its DELETE can reverse rather than remove.\n\n` +
            `Every comparative figure the books produce depends on it, and this server offers no ` +
            `tool that changes it.`,
        },
      );
    } catch (err) {
      // Only the documented "not found" case becomes an answer. Anything else is still a failure,
      // because turning every error into "nothing recorded" is how a 403 on a module or an expired
      // token gets reported as a fact about the books.
      //
      // Matched on the STRUCTURED status, not on the message. Review's point, and it is right: a 500
      // from a gateway relaying a downstream body could carry both "HTTP 404" and the phrase, and a
      // text search would have called that outage an empty set of books. ReaiApiError already knows
      // its own status; the phrase is then a second condition rather than the only one.
      if (isNotFound(err, /opening balance not found/i)) {
        return ok(
          { recorded: false, openingBalance: null },
          {
            note:
              `Tenant ${tenantId} has NO opening balance recorded, which is what the 404 on this ` +
              `endpoint means. Not a wrong path, not a wrong tenant, not a disabled module — the ` +
              `books simply start from zero and whatever the first vouchers say.\n\n` +
              `Both test tenants answer the same way, so if you are looking for a figure to ` +
              `reconcile against, there is none here to find.`,
          },
        );
      }
      throw err;
    }
  },
});

const getAnnualAccounts = defineTool({
  name: "reai_get_annual_accounts",
  title: "Get annual-accounts submission status for a year",
  description:
    "Whether a submission record exists for a fiscal year, and what state it is in.\n\n" +
    "Not a yes/no, because the API does not model one: the documented states are incomplete, " +
    "complete, signing, signed and submitted_in_other_system, so a record can exist with nothing " +
    "filed. This tool reports `submissionExists` and the `status` separately, on both the found and " +
    "the not-found paths, rather than inventing a `submitted` flag the API has no state for.\n\n" +
    'The endpoint answers `404 "No annual-accounts submission exists"` when there is none — measured ' +
    "for 2025 on both test tenants — and this tool reports that as the answer rather than as a " +
    "failure. Nothing has been filed is a normal, useful thing to know, and it is not the same as " +
    "the endpoint being wrong.\n\n" +
    "Read-only, and there is nothing else on offer: the spec has no endpoint that SUBMITS annual " +
    "accounts, so this server cannot file anything with the authorities here even with " +
    "REAI_ALLOW_EXTERNAL_SEND on. Filing happens in ReAI's own UI.",
  risk: "read",
  apiPaths: [["GET", "/api/annual-accounts/{year}"]],
  idempotent: true,
  inputSchema: {
    // A four-digit STRING, matching reai_get_tax_return and reai_create_vat_return, which take the
    // same fiscal year the same way. This shipped as a number, and the inconsistency was found by the
    // path-parameter sweep in test/spec-bounds.test.mjs: an agent that used two of these three tools
    // in one session had to guess which wanted 2025 and which wanted "2025".
    //
    // The spec declares this parameter `type: string` with `exclusiveMinimum: 0, maximum: 32767`,
    // which four digits satisfies for every year a real company could have books for. It is narrower
    // than the letter of the spec — year 5 and year 40000 are refused — and that is a deliberate
    // second-order choice, not the mistake an earlier floor of 2000 was: that one excluded 1999,
    // a year a real tenant could plausibly ask about.
    year: z
      .string()
      .regex(/^\d{4}$/, "Year must be four digits, e.g. 2026")
      .describe("Fiscal year, four digits, e.g. \"2025\"."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    try {
      const res = await ctx.client.request<unknown>({
        method: "GET",
        path: `/api/annual-accounts/${encodeURIComponent(args.year)}`,
        tenantId,
      });
      const status = (res.data as { status?: string } | undefined)?.status;
      return ok(
        { year: Number(args.year), submissionExists: true, status: status ?? null, submission: res.data ?? null },
        {
          note:
            `A submission record EXISTS for ${args.year} on tenant ${tenantId}, with status ` +
            `${JSON.stringify(status ?? null)}.\n\n` +
            `Existing is not the same as filed. The documented states are incomplete, complete, ` +
            `signing, signed and submitted_in_other_system — there is no state called "submitted", ` +
            `which is why this tool reports the status rather than a yes/no. ` +
            `submitted_in_other_system means the accounts were delivered outside ReAI and takes ` +
            `precedence over the rest.`,
        },
      );
    } catch (err) {
      if (isNotFound(err, /no annual-accounts submission/i)) {
        return ok(
          // `Number(...)` so both branches agree with the API's own type: AnnualAccountsSubmissionRes
          // declares year as an integer, and the argument is a four-digit string. Synthesizing a
          // string here would have made a consumer's `year` field change type with the outcome —
          // the same cross-branch inconsistency that `submissionExists` was fixed for.
          { year: Number(args.year), submissionExists: false, status: null, submission: null },
          {
            note:
              `NO annual-accounts submission exists for ${args.year} on tenant ${tenantId}. That is ` +
              `the 404 on this endpoint, and it is an answer rather than an error.\n\n` +
              `This server cannot file one either way — the API exposes no submission endpoint, ` +
              `only this status read.`,
          },
        );
      }
      throw err;
    }
  },
});

export const referenceTools: ToolDef[] = [
  listCountries,
  listCurrencies,
  getOpeningBalance,
  getAnnualAccounts,
];
