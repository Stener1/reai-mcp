import { z } from "zod";
import {
  CURRENCY_CODE,
  defineTool,
  fail,
  isoDate,
  ok,
  okList,
  requireTenantId,
  startOfYear,
  tenantIdArg,
  today,
  type ToolDef,
} from "./registry.js";

const VOUCHER_TYPES = [
  "MANUAL",
  "OPENING_BALANCE",
  "SUPPLIER_INVOICE",
  "CUSTOMER_INVOICE",
  "INCOME",
  "PAYMENT",
  "EXPENSE",
  "SALARY",
  // The spec declares sixteen; eight were listed, so "show me the VAT settlement
  // voucher" or "which depreciation was booked" got a zod rejection from this server
  // rather than an answer, while the filter read as exhaustive.
  "CUSTOMS_DECLARATION",
  "ASSET",
  "ASSET_DEPRECIATION",
  "SHAREHOLDER_REGISTER_DIVIDEND",
  "VAT_RETURN",
  "LOAN",
  "CREDIT_NOTE_ASSIGNMENT",
  "CUSTOMER_INVOICE_ADJUSTMENT",
] as const;

const listAccounts = defineTool({
  name: "reai_list_accounts",
  title: "List chart of accounts",
  description:
    "Search the tenant's chart of accounts (kontoplan). Returns account numbers, names and types. " +
    "Use this to find the right account number before booking a voucher — every posting must " +
    "reference an account that exists in this list.",
  risk: "read",
  apiPaths: [["GET", "/api/chart-of-accounts/accounts"]],
  inputSchema: {
    query: z
      .string()
      .optional()
      .describe('Free-text search over account number and name, e.g. "bank", "salgsinntekt", "1920".'),
    accountNumberPrefix: z
      .string()
      .optional()
      .describe('Restrict to a leading digit range, e.g. "19" for bank accounts or "3" for revenue.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Maximum accounts to return. The API caps this at 100 and does so SILENTLY, so a larger " +
          "number used to look like it worked while quietly truncating the chart of accounts. " +
          "Narrow with accountNumberPrefix or query instead of asking for more.",
      ),
    filterRestricted: z
      .boolean()
      .optional()
      .describe(
        "Exclude accounts reserved for system use, which cannot be posted to directly. Worth " +
          "setting when you are choosing an account to book against.",
      ),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/chart-of-accounts/accounts",
      query: {
        query: args.query,
        accountNumberPrefix: args.accountNumberPrefix,
        limit: args.limit,
        filterRestricted: args.filterRestricted,
      },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const count = Array.isArray(res.data) ? res.data.length : undefined;
    return ok(res.data, {
      ...(count !== undefined ? { note: `${count} account(s).` } : {}),
    });
  },
});

const listVatCodes = defineTool({
  name: "reai_list_vat_codes",
  title: "List VAT codes",
  description:
    "List VAT (mva) codes, with rate, type and description. Postings to revenue and cost accounts " +
    "generally require one; look it up here rather than guessing.\n\n" +
    "Read the scope carefully, because the unfiltered call is NOT tenant-specific: it returns every " +
    "code ReAI supports, including ones this tenant cannot use. Only usage=\"customer-invoice\" " +
    "narrows it to what the tenant may actually write, and only for order and subscription lines. " +
    "So on a tenant that is not VAT-registered the plain list still shows 25% codes — booking one " +
    "would invent VAT that does not exist. When in doubt, cross-check against " +
    "usage=\"customer-invoice\" or ask the user.",
  risk: "read",
  apiPaths: [["GET", "/api/vat-codes"]],
  inputSchema: {
    usage: z
      .enum(["customer-invoice"])
      .optional()
      .describe("Filter to codes valid in a specific context, e.g. codes usable on a customer invoice."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "GET",
      path: "/api/vat-codes",
      query: { usage: args.usage },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data, {
      note:
        args.usage === "customer-invoice"
          ? "Narrowed to the codes this tenant can write on order and subscription lines."
          : "Every code ReAI supports — NOT filtered to this tenant. Some may be unusable here; " +
            'usage="customer-invoice" is the only tenant-narrowed view.',
    });
  },
});

const listVouchers = defineTool({
  name: "reai_list_vouchers",
  title: "List vouchers",
  description:
    "List vouchers (bilag) in a date range, each with its postings. A voucher is the atomic unit of " +
    "Norwegian bookkeeping: a dated, balanced set of debit and credit postings. " +
    "Defaults to the current calendar year if no dates are given.",
  risk: "read",
  apiPaths: [["GET", "/api/vouchers"]],
  inputSchema: {
    startDate: isoDate.optional().describe("Inclusive start date. Defaults to 1 January of the current year."),
    endDate: isoDate.optional().describe("Inclusive end date. Defaults to today."),
    voucherType: z.enum(VOUCHER_TYPES).optional().describe("Filter by how the voucher was created."),
    registeredBy: z.string().optional().describe("Filter by the user who registered the voucher."),
    includeReversed: z.boolean().optional().describe("Include reversed vouchers (excluded by default)."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const startDate = args.startDate ?? startOfYear();
    const endDate = args.endDate ?? today();
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/vouchers",
      query: {
        startDate,
        endDate,
        voucherType: args.voucherType,
        registeredBy: args.registeredBy,
        includeReversed: args.includeReversed,
      },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return okList(res.data, { noun: "voucher", suffix: ` between ${startDate} and ${endDate}.` });
  },
});

const getVoucher = defineTool({
  name: "reai_get_voucher",
  title: "Get one voucher",
  description: "Fetch a single voucher by id, including all its postings and attachments.",
  risk: "read",
  apiPaths: [["GET", "/api/vouchers/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Voucher id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const res = await ctx.client.request({
      method: "GET",
      path: `/api/vouchers/${args.id}`,
      tenantId,
    });
    return ok(res.data, { link: ctx.client.deepLink(`/vouchers/${args.id}`, tenantId) });
  },
});

const postingInput = z.object({
  accountNumber: z
    .string()
    .min(1, "A posting line needs an account number; the API requires a non-empty value.")
    .describe('Chart-of-accounts number, e.g. "1920". Must exist — check with reai_list_accounts.'),
  amount: z
    .number()
    .describe(
      "Signed amount in the tenant's currency. POSITIVE debits the account, NEGATIVE credits it. " +
        "All amounts across the voucher must sum to exactly zero.",
    ),
  postingDate: isoDate.optional().describe("Date for this posting. Defaults to the voucher date."),
  description: z.string().optional().describe("Line description. Falls back to the voucher description."),
  currency: CURRENCY_CODE.optional().describe('ISO 4217 code. Defaults to "NOK".'),
  currencyAmount: z
    .number()
    .optional()
    .describe("Signed amount in the foreign currency, when currency differs from the tenant's."),
  vatCode: z
    .string()
    .optional()
    .describe(
      "VAT code from reai_list_vat_codes. Required on most revenue and cost accounts. " +
        "Note that the unfiltered list returns EVERY code ReAI supports, not the ones THIS tenant " +
        "may use — it shows 25% codes even for a company that is not VAT-registered — and booking " +
        "one the tenant cannot use invents VAT that does not exist.",
    ),
  rowNumber: z
    .number()
    .int()
    // The spec's minimum is 0, and assignRowNumbers respects a caller-supplied value, so a
    // negative one was forwarded and failed the whole voucher POST with a bare 400.
    .min(0, "The API requires a rowNumber of 0 or more.")
    .optional()
    .describe("Groups postings into voucher rows; a matching debit and credit share a row number."),
  supplierId: z.number().int().optional().describe("Link the posting to a supplier."),
  customerId: z.number().int().optional().describe("Link the posting to a customer."),
  projectId: z.number().int().optional().describe("Link the posting to a project."),
  departmentId: z.number().int().optional().describe("Link the posting to a department."),
  employeeId: z.number().int().optional().describe("Link the posting to an employee."),
  companyBankId: z
    .number()
    .int()
    .optional()
    .describe(
      "Company bank account id, from reai_list_company_banks. Conditionally REQUIRED in the same way " +
        "subAccountId is: a posting to a bank account in the chart answers " +
        '400 "Linje 1: Konto 1920 må posteres med bankkonto." without it — measured. This tool does ' +
        "not pre-check that one, because nothing in the company-bank response says which ledger " +
        "account each bank belongs to, so which accounts demand it cannot be established here.",
    ),
  assetId: z.number().int().optional().describe("Link the posting to an asset."),
  subAccountId: z
    .number()
    .int()
    .optional()
    .describe(
      "General sub-account (underkonto) id, from reai_sub_accounts_for_account. NOT optional in the " +
        "way this reads: an account that HAS sub-accounts REQUIRES one on every posting, even when " +
        'it has only a single "Default" — measured, omitting it answers ' +
        '400 "Linje 1: Konto 1320 må posteres med underkonto." naming the line and nothing else. ' +
        "This tool checks before sending and names the choices.",
    ),
});

/**
 * Rounded to 2 decimals before comparison: floating-point sums of currency
 * amounts routinely land a fraction of an øre away from zero, and the API would
 * reject that as unbalanced without explaining why.
 */
function imbalance(postings: Array<{ amount: number }>): number {
  // Each posting is rounded to øre BEFORE summing, because that is what ReAI stores —
  // every money field in the API is multipleOf 0.01. Rounding the sum instead let a
  // real imbalance through: 100.002 + (-99.998) sums to 0.004, rounds to 0, and was
  // reported as balanced.
  const sum = postings.reduce((acc, p) => acc + Math.round(p.amount * 100), 0);
  return sum / 100;
}

/** Postings whose amount is finer than øre, which the API cannot store. */
function subOreAmounts(postings: Array<{ accountNumber: string; amount: number }>): string[] {
  return postings
    .filter((p) => Math.abs(p.amount * 100 - Math.round(p.amount * 100)) > 1e-9)
    .map((p) => `${p.accountNumber}: ${p.amount}`);
}

/**
 * Assign voucher row numbers when the caller has not.
 *
 * The rule comes from the API's own schema, and my earlier model of it was
 * backwards. What it actually says: "A balanced debit+credit entry for the same
 * amount, currency and date MUST share a single rowNumber so it becomes ONE voucher
 * row — never split the debit and credit of one entry across two rowNumbers... a
 * rowNumber holds at most one debit and one credit side, both with the same date,
 * description, currency and absolute amount. Assign a new rowNumber only for a
 * separate, unrelated entry."
 *
 * So a row is a MATCHED PAIR of equal absolute amount, not "postings that happen to
 * share a description". Grouping by description got both directions wrong:
 *
 *  - It early-returned when every description matched, assigning nothing. The
 *    ordinary Norwegian purchase voucher — debit cost 800, debit input VAT 200,
 *    credit payable -1000, one description throughout — was therefore sent with no
 *    row numbers at all, so two debits of different amounts landed in row 0 and the
 *    API rejected exactly the merge this function exists to prevent.
 *  - It split a matched debit/credit pair across two rows whenever their
 *    descriptions differed, which the schema says MUST NOT happen.
 *
 * Now: pair each debit with a credit of the same absolute amount, give each pair one
 * row, and give anything unpaired a row of its own (a row may hold a single side).
 * Explicit row numbers are always respected.
 */
export function assignRowNumbers<
  T extends {
    rowNumber?: number | undefined;
    description?: string | undefined;
    amount: number;
    currency?: string | undefined;
    postingDate?: string | undefined;
  },
>(postings: T[]): T[] {
  // Fully numbered: the caller has said exactly what they want.
  if (postings.every((p) => p.rowNumber !== undefined)) return postings;

  const takenRows = new Set<number>();
  for (const p of postings) if (p.rowNumber !== undefined) takenRows.add(p.rowNumber);
  let candidate = 0;
  const claimRow = (): number => {
    while (takenRows.has(candidate)) candidate += 1;
    takenRows.add(candidate);
    return candidate;
  };

  const assigned = new Map<number, number>(); // index -> rowNumber
  const unnumbered = postings
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.rowNumber === undefined);

  const debits = unnumbered.filter(({ p }) => p.amount > 0);
  const credits = unnumbered.filter(({ p }) => p.amount < 0);
  const usedCredits = new Set<number>();

  // Round to øre before comparing: currency arithmetic routinely leaves a matched
  // pair a fraction apart, and a pair that should share a row must not be split by
  // floating point.
  const cents = (n: number): number => Math.round(n * 100);

  // The schema requires both sides of a row to share amount, currency AND date.
  // Matching on amount alone put a multi-date or multi-currency pair into one row,
  // which ReAI then rejects — worse than giving each posting its own row.
  //
  // Description is on that list too, and it was missing. Verified against the live API:
  // two postings sharing a rowNumber but carrying different descriptions come back
  //   400 "postings with rowNumber 0 cannot be merged into one voucher row"
  // whereas the same two postings in rows 0 and 1 clear that check. So pairing them was
  // a guaranteed rejection, and separating them is a working voucher — the natural
  // reading of a caller who wrote "…debit" on one line and "…credit" on the other is
  // two rows, not one malformed one.
  const sameRowEligible = (a: T, b: T): boolean =>
    cents(Math.abs(a.amount)) === cents(Math.abs(b.amount)) &&
    (a.currency ?? "") === (b.currency ?? "") &&
    (a.postingDate ?? "") === (b.postingDate ?? "") &&
    (a.description ?? "") === (b.description ?? "");

  for (const debit of debits) {
    const match = credits.find(({ p, i }) => !usedCredits.has(i) && sameRowEligible(p, debit.p));
    const row = claimRow();
    assigned.set(debit.i, row);
    if (match) {
      usedCredits.add(match.i);
      assigned.set(match.i, row);
    }
  }
  // Credits with no debit of the same size get their own rows.
  for (const credit of credits) {
    if (usedCredits.has(credit.i) || assigned.has(credit.i)) continue;
    assigned.set(credit.i, claimRow());
  }
  // A zero-amount posting pairs with nothing; give it a row so it cannot collide.
  for (const { i } of unnumbered) if (!assigned.has(i)) assigned.set(i, claimRow());

  return postings.map((p, i) => {
    const row = assigned.get(i);
    return row === undefined ? p : { ...p, rowNumber: row };
  });
}

/**
 * A matched pair sharing a row must agree on its description, because the row
 * carries one. Reported locally rather than left to a 422 that blames the sign
 * convention.
 */
export function rowDescriptionConflicts<
  T extends { rowNumber?: number | undefined; description?: string | undefined },
>(postings: T[]): string[] {
  // An ABSENT description is "unspecified", not the empty string. Treating omission
  // as "" made a pair where only one side named a description look like a conflict,
  // and this check refuses the voucher locally — so it would have blocked a call over
  // a rule the bundled spec does not state anywhere. Only two explicitly different
  // descriptions are a real disagreement.
  const byRow = new Map<number, Set<string>>();
  for (const p of postings) {
    if (p.rowNumber === undefined) continue;
    if (p.description === undefined) continue;
    const set = byRow.get(p.rowNumber) ?? new Set<string>();
    set.add(p.description);
    byRow.set(p.rowNumber, set);
  }
  const conflicts: string[] = [];
  for (const [row, descriptions] of byRow) {
    if (descriptions.size > 1) {
      conflicts.push(
        `row ${row} has ${descriptions.size} different descriptions (${[...descriptions]
          .map((d) => JSON.stringify(d))
          .join(", ")})`,
      );
    }
  }
  return conflicts;
}

const createVoucher = defineTool({
  name: "reai_create_voucher",
  title: "Book a voucher",
  description:
    "Create (book) a voucher in the general ledger from a set of postings.\n\n" +
    "Sign convention: a POSITIVE amount debits the account, a NEGATIVE amount credits it, and the " +
    "postings must sum to exactly zero. The sum is checked locally before the request is sent, so " +
    "an unbalanced voucher fails with a clear explanation instead of a generic API error.\n\n" +
    "This posts to the general ledger and is NOT freely reversible — under Norwegian bookkeeping " +
    "rules a voucher in a closed period cannot be deleted. Requires REAI_WRITE_MODE=full.",
  risk: "irreversible",
  apiPaths: [
    ["GET", "/api/general-sub-accounts"],
    ["POST", "/api/vouchers"],
  ],
  inputSchema: {
    date: isoDate.describe("Voucher date. Determines the accounting period."),
    description: z
      .string()
      .optional()
      .describe("Voucher description. Strongly recommended — it is what a human sees in the audit trail."),
    postings: z
      .array(postingInput)
      .min(2)
      .describe("At least two postings, summing to exactly zero."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);

    // Refused before the balance check, because an amount ReAI cannot store makes the
    // balance meaningless: it rounds each posting to øre, which silently changes both
    // sides of a voucher that looked balanced at three decimals.
    const tooFine = subOreAmounts(args.postings);
    if (tooFine.length > 0) {
      return fail(
        `Amounts must be in whole øre (at most two decimals) — ReAI stores them that way and ` +
          `would round these, changing the voucher:\n  ${tooFine.join("\n  ")}\n\n` +
          `Round them yourself so you decide where the øre goes. Nothing was sent to ReAI.`,
      );
    }

    // A voucher where nothing moves is balanced but pointless, and almost always a
    // mistake upstream rather than an intention.
    if (args.postings.every((p) => Math.round(p.amount * 100) === 0)) {
      return fail(
        "Every posting is zero, so this voucher would record nothing. It balances, but there is " +
          "no transaction in it. Nothing was sent to ReAI.",
      );
    }

    const diff = imbalance(args.postings);
    if (diff !== 0) {
      const lines = args.postings
        .map((p) => `  ${p.accountNumber}: ${p.amount > 0 ? "debit" : "credit"} ${Math.abs(p.amount)}`)
        .join("\n");
      return fail(
        `Voucher is not balanced — the postings sum to ${diff}, but must sum to exactly 0.\n\n${lines}\n\n` +
          `Remember: positive amounts debit, negative amounts credit. ` +
          `Add or correct a posting of ${-diff} to balance it. Nothing was sent to ReAI.`,
      );
    }

    // A sub-account is mandatory on any account that HAS them, including an account with only a
    // single "Default" — measured, and the API's refusal is
    // 400 "Linje 1: Konto 1320 må posteres med underkonto.", which names the line and nothing a
    // caller can act on. One read of the whole sub-account list turns that into the actual choices,
    // and costs one call however many postings the voucher has.
    //
    // A failed lookup does NOT block the write: this spec has under-stated requirements before, and
    // refusing a voucher because a helper read failed would be the check doing harm. The API remains
    // the authority — but its 400 is NOT enriched by the quirk registry on a curated tool, which an
    // earlier version of this comment claimed. server.ts turns a thrown ReaiApiError into a plain
    // tool error, so the caller would have received exactly the bare Norwegian message this
    // preflight exists to replace. The catch below supplies the advice instead.
    const needSubAccount: Array<{ line: number; accountNumber: string; choices: string }> = [];
    try {
      const subs = await ctx.client.request<
        Array<{ id?: number; accountNumber?: string; name?: string }>
      >({ method: "GET", path: "/api/general-sub-accounts", tenantId });
      if (Array.isArray(subs.data)) {
        const byAccount = new Map<string, Array<{ id?: number; name?: string }>>();
        for (const row of subs.data) {
          if (typeof row.accountNumber !== "string") continue;
          byAccount.set(row.accountNumber, [...(byAccount.get(row.accountNumber) ?? []), row]);
        }
        args.postings.forEach((posting, index) => {
          if (posting.subAccountId !== undefined) return;
          const choices = byAccount.get(posting.accountNumber);
          if (choices === undefined || choices.length === 0) return;
          needSubAccount.push({
            line: index + 1,
            accountNumber: posting.accountNumber,
            choices: choices.map((c) => `${c.id} (${c.name ?? "?"})`).join(", "),
          });
        });
      }
    } catch {
      // Left to the API, deliberately — see above.
    }
    if (needSubAccount.length > 0) {
      return fail(
        `Nothing was sent. ${needSubAccount.length} posting(s) are on an account that requires a ` +
          `general sub-account (underkonto), and none was given:\n\n` +
          needSubAccount
            .map((n) => `  line ${n.line}, account ${n.accountNumber} → subAccountId ${n.choices}`)
            .join("\n") +
          `\n\nAn account that has ANY sub-account requires one on every posting, even when the only ` +
          `one is called "Default" — the API answers 400 "må posteres med underkonto" and names just ` +
          `the line. Pick from the ids above, or list them with reai_sub_accounts_for_account.`,
      );
    }

    const withRows = assignRowNumbers(args.postings);

    // A voucher row carries ONE description, so a matched debit/credit pair sharing a
    // row has to agree on it. Reported here rather than left to the API, whose error
    // for this blames the sign convention and sends you looking in the wrong place.
    const conflicts = rowDescriptionConflicts(withRows);
    if (conflicts.length > 0) {
      return fail(
        `Postings that form one voucher row must share a description, and ${conflicts.join("; ")}.\n\n` +
          `A row is a matched debit and credit of the same absolute amount — the API requires them ` +
          `to stay in one row, so they cannot be separated to keep different descriptions. Either ` +
          `give the pair the same description, or set rowNumber yourself if these really are ` +
          `unrelated entries. Nothing was sent to ReAI.`,
      );
    }

    const body = {
      date: args.date,
      ...(args.description !== undefined ? { description: args.description } : {}),
      postings: withRows.map((p) => ({
        ...p,
        postingDate: p.postingDate ?? args.date,
        currency: p.currency ?? "NOK",
      })),
    };

    let res;
    try {
      res = await ctx.client.request<{ id?: number; number?: string }>({
        method: "POST",
        path: "/api/vouchers",
        body,
        tenantId,
      });
    } catch (err) {
      // The two dimension rules again, this time on the way back. When the preflight's own lookup
      // failed we let the call through on purpose — but a curated tool's thrown error is turned into
      // a plain tool error by server.ts and never meets the quirk registry, so the caller would have
      // received the bare Norwegian message the preflight exists to replace. Translated here.
      const message = err instanceof Error ? err.message : String(err);
      if (/må posteres med underkonto/i.test(message)) {
        throw new Error(
          `${message}\n\n` +
            `That means: the account on the line named requires a general sub-account (underkonto), ` +
            `and the posting did not carry one. Every posting to an account that has ANY sub-account ` +
            `needs a subAccountId, including an account whose only one is called "Default". List the ` +
            `choices with reai_sub_accounts_for_account for that account number.`,
        );
      }
      if (/må posteres med bankkonto/i.test(message)) {
        throw new Error(
          `${message}\n\n` +
            `That means: the account on the line named is a bank account, and a posting to it must ` +
            `say WHICH company bank with companyBankId. List them with reai_list_company_banks.`,
        );
      }
      throw err;
    }

    const id = res.data?.id;
    return ok(res.data, {
      note:
        `Voucher booked${res.data?.number ? ` as ${res.data.number}` : ""}. ` +
        `Total debits and credits: ${args.postings.filter((p) => p.amount > 0).reduce((a, p) => a + p.amount, 0)}.`,
      ...(id ? { link: ctx.client.deepLink(`/vouchers/${id}`, tenantId) } : {}),
    });
  },
});

const deleteVoucher = defineTool({
  name: "reai_delete_voucher",
  title: "Delete a voucher",
  description:
    "Delete a voucher, OR reverse it — ReAI decides which, and they are not the same thing. It " +
    "deletes when no audit history has to be kept; otherwise it books a counter-posting and the " +
    "original stays in the ledger. The response says which happened, and this tool reports it: on " +
    '"reversed" the transaction is still there, now with an offsetting entry, so do NOT re-book it. ' +
    "Requires REAI_WRITE_MODE=full.",
  risk: "irreversible",
  apiPaths: [["DELETE", "/api/vouchers/{id}"]],
  destructive: true,
  inputSchema: {
    id: z.number().int().positive().describe("Voucher id to delete."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<{ outcome?: string }>({
      method: "DELETE",
      path: `/api/vouchers/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    // The outcome must be passed through, not assumed. This reported "deleted"
    // unconditionally while discarding the body, so an agent told a user a voucher
    // was gone when the ledger actually held the original PLUS a counter-posting —
    // and might then re-book the transaction, double-posting it. Every other delete
    // tool here already surfaces its outcome; this was the one that touches the
    // general ledger.
    const outcome = res.data?.outcome;
    if (outcome === "reversed") {
      return ok(res.data, {
        note:
          `Voucher ${args.id} was REVERSED, not deleted. ReAI kept the original and booked an ` +
          `offsetting counter-posting, because the audit history had to be retained. The ` +
          `transaction is still in the ledger — do not re-book it. Both entries will appear in ` +
          `reai_list_postings.`,
      });
    }
    if (outcome === "deleted") {
      return ok(res.data, {
        note: `Voucher ${args.id} was deleted outright; nothing remains in the ledger.`,
      });
    }
    // No outcome in the body. Report exactly that — an earlier version returned a
    // synthesized { outcome: "deleted" } next to a note saying the outcome was
    // unknown, so anything reading the structured value would have concluded the
    // voucher was gone when it may have been reversed.
    return ok(res.data ?? { outcome: null }, {
      note:
        `Voucher ${args.id}: HTTP ${res.status}, but ReAI did not say whether it was deleted or ` +
        `REVERSED, so do not assume the transaction is gone. Check reai_list_postings for a ` +
        `counter-posting before re-booking anything.`,
    });
  },
});

const listPostings = defineTool({
  name: "reai_list_postings",
  title: "List postings",
  description:
    "List individual ledger postings in a date range, with optional filters by account, voucher, " +
    "customer, supplier, project, employee or bank. Each posting reports `canDelete` and " +
    "`lockReasons`, which tell you whether it can still be changed. " +
    "Defaults to the current calendar year.",
  risk: "read",
  apiPaths: [["GET", "/api/postings"]],
  inputSchema: {
    startDate: isoDate.optional().describe("Inclusive start date. Defaults to 1 January of the current year."),
    endDate: isoDate.optional().describe("Inclusive end date. Defaults to today."),
    accountNumber: z.string().optional().describe("Filter by chart-of-accounts number."),
    voucherId: z.number().int().optional().describe("Filter to one voucher's postings."),
    customerId: z.number().int().optional().describe("Filter by customer."),
    supplierId: z.number().int().optional().describe("Filter by supplier."),
    projectId: z.number().int().optional().describe("Filter by project."),
    employeeId: z.number().int().optional().describe("Filter by employee."),
    companyBankId: z.number().int().optional().describe("Filter by company bank account."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const startDate = args.startDate ?? startOfYear();
    const endDate = args.endDate ?? today();
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/postings",
      query: {
        startDate,
        endDate,
        accountNumber: args.accountNumber,
        voucherId: args.voucherId,
        customerId: args.customerId,
        supplierId: args.supplierId,
        projectId: args.projectId,
        employeeId: args.employeeId,
        companyBankId: args.companyBankId,
      },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return okList(res.data, { noun: "posting", suffix: ` between ${startDate} and ${endDate}.` });
  },
});

const generalLedger = defineTool({
  name: "reai_general_ledger",
  title: "General ledger (hovedbok)",
  description:
    "Read the general ledger for a period: opening balance, postings and closing balance per " +
    "account. Good for 'what did we spend on X'. Narrow with accountNumber or an account range, " +
    "since a full-year ledger for an active tenant can be large.\n\n" +
    "Note what it does NOT cover: the API returns only accounts WITH ACTIVITY in the requested " +
    "period. An account carrying a balance forward but untouched in the window is simply absent, " +
    "so an empty result means 'no movement', not 'no balance'. To answer 'what is the balance of " +
    "account 1920' reliably, widen the period to include the last posting on it rather than " +
    "reporting zero.",
  risk: "read",
  apiPaths: [["GET", "/api/ledger/general"]],
  inputSchema: {
    startDate: isoDate.optional().describe("Inclusive start date. Defaults to 1 January of the current year."),
    endDate: isoDate.optional().describe("Inclusive end date. Defaults to today."),
    accountNumber: z.string().optional().describe("Restrict to a single account."),
    accountFrom: z.string().optional().describe("Start of an account-number range."),
    accountTo: z.string().optional().describe("End of an account-number range."),
    vatCode: z.string().optional().describe("Filter by VAT code."),
    voucherNumber: z.string().optional().describe("Filter by voucher number."),
    customerId: z.number().int().optional().describe("Filter by customer."),
    supplierId: z.number().int().optional().describe("Filter by supplier."),
    projectId: z.number().int().optional().describe("Filter by project."),
    amountFrom: z.number().optional().describe("Minimum posting amount."),
    amountTo: z.number().optional().describe("Maximum posting amount."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const startDate = args.startDate ?? startOfYear();
    const endDate = args.endDate ?? today();
    const { tenantId, ...filters } = args;
    const res = await ctx.client.request({
      method: "GET",
      path: "/api/ledger/general",
      query: { ...filters, startDate, endDate },
      tenantId: requireTenantId(tenantId, ctx),
    });
    return ok(res.data, { note: `General ledger ${startDate} to ${endDate}.` });
  },
});

export const bookkeepingTools: ToolDef[] = [
  listAccounts,
  listVatCodes,
  listVouchers,
  getVoucher,
  createVoucher,
  deleteVoucher,
  listPostings,
  generalLedger,
] as ToolDef[];
