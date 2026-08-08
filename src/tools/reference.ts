import { z } from "zod";
import { defineTool, ok, okList, requireTenantId, tenantIdArg, type ToolDef } from "./registry.js";

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
 * Neither endpoint documents a response schema. Almost nothing here does — measured, 12 of 430
 * operations in this spec declare one — so the shapes below are what the live API returned, not what
 * it promises: `{code, name, currencyCode}` for a country and `{code, name}` for a currency. The
 * `currencyCode` on a country is its default currency, which is the field that makes the country list
 * worth reading before creating a foreign customer rather than after.
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
function matching<T extends { code?: string; name?: string }>(rows: T[], query: string | undefined): T[] {
  if (!query?.trim()) return rows;
  const needle = query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (row.code ?? "").toLowerCase().includes(needle) || (row.name ?? "").toLowerCase().includes(needle),
  );
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
    "`query` filters by code or name, case-insensitively, and it filters HERE: the endpoint takes no " +
    "parameters, so the whole list is fetched and narrowed locally. A no-match answer therefore " +
    "means no match in this list, not that the API was asked and said no.\n\n" +
    "The response shape is measured rather than documented — this spec declares a response schema " +
    "for 12 of its 430 operations, and this is not one of them. Measured live: 170 countries, every " +
    "one a two-letter code carrying a currencyCode, with GB for the United Kingdom and no UK at all.",
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
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const all = res.data;
    if (!Array.isArray(all)) {
      return ok(all, {
        note:
          `The countries endpoint did not return a list, so there is no count to give. The response ` +
          `is below as received, and this is NOT a report that the API supports no countries.`,
      });
    }
    const rows = matching(all, args.query);
    return okList(rows, {
      noun: "country",
      suffix: args.query
        ? ` matching ${JSON.stringify(args.query)}, filtered locally out of ${all.length} the API ` +
          `returned.` +
          (rows.length === 1 && rows[0]?.code
            ? ` Send countryCode: ${JSON.stringify(rows[0].code)}.`
            : ``)
        : `. Each carries its default currencyCode, which is what to send as currencyCode on an ` +
          `invoice or order for that country unless you mean otherwise.`,
      empty: args.query
        ? `No country in this API's list matches ${JSON.stringify(args.query)}. The API was not ` +
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
    "`query` filters by code or name, locally — the endpoint takes no parameters, so a no-match " +
    "answer is about this list and not about what the API would accept.\n\n" +
    "For the default currency of a COUNTRY, use reai_list_countries: each row carries a " +
    "currencyCode. Measured live: 129 currencies.",
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
      tenantId: requireTenantId(args.tenantId, ctx),
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
    const rows = matching(all, args.query);
    return okList(rows, {
      noun: "currency",
      suffix: args.query
        ? ` matching ${JSON.stringify(args.query)}, filtered locally out of ${all.length} the API ` +
          `returned.` +
          (rows.length === 1 && rows[0]?.code
            ? ` Send currencyCode: ${JSON.stringify(rows[0].code)}.`
            : ``)
        : `.`,
      empty: args.query
        ? `No currency in this API's list matches ${JSON.stringify(args.query)}. The API was not ` +
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
      return ok(res.data, {
        note:
          `Tenant ${tenantId} HAS an opening balance recorded. It is the starting position of the ` +
          `books, so every comparative figure depends on it — changing it is not master-data work, ` +
          `and this server offers no tool that does.`,
      });
    } catch (err) {
      // Only the documented "not found" case becomes an answer. Anything else is still a failure,
      // because turning every error into "nothing recorded" is how a 403 on a module or an expired
      // token gets reported as a fact about the books.
      const message = err instanceof Error ? err.message : String(err);
      if (/HTTP 404/.test(message) && /opening balance not found/i.test(message)) {
        return ok(
          { openingBalance: null, recorded: false },
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
    "Whether annual accounts have been submitted for a fiscal year, and what state that submission " +
    "is in.\n\n" +
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
    year: z
      .number()
      .int()
      .min(2000, "ReAI's fiscal years start well after this.")
      .max(2100)
      .describe("Fiscal year, e.g. 2025."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    try {
      const res = await ctx.client.request<unknown>({
        method: "GET",
        path: `/api/annual-accounts/${args.year}`,
        tenantId,
      });
      return ok(res.data, {
        note: `A submission exists for ${args.year} on tenant ${tenantId}. Its state is in the body below.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/HTTP 404/.test(message) && /no annual-accounts submission/i.test(message)) {
        return ok(
          { year: args.year, submission: null, submitted: false },
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
