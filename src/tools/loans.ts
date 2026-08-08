import { z } from "zod";
import { ReaiApiError } from "../reai/errors.js";
import {
  CURRENCY_CODE,
  defineTool,
  fail,
  isoDate,
  mergeForReplacement,
  ok,
  okList,
  readableRecord,
  requireTenantId,
  resolveTenantId,
  tenantIdArg,
  type ToolDef,
} from "./registry.js";

/**
 * Loans — five operations, and almost everything that matters about them is undocumented.
 *
 * The spec gives `POST /api/loans` nine required fields and five enums, and says nothing about the
 * two things a caller cannot get right by guessing. Both were measured on the write test tenant.
 *
 * ## `perspective` decides which TABLE `counterpartyId` is read from
 *
 * The spec types it `integer/int32` and stops. It is not one id space:
 *
 *   - `perspective: "borrower"` → the id is a **Creditor**. A wrong id answers
 *     `404 "Creditor with id=N not found"`.
 *   - `perspective: "lender"` → the id is a **Debtor**, and the same wrong id answers
 *     `404 "Debtor with id=N not found"`.
 *
 * So flipping `perspective` silently changes what an unchanged `counterpartyId` means. Measured both
 * directions. The response then renames the field again: what went in as `counterpartyId` comes back
 * as `creditorId` or `debtorId`, with the other one null, plus a derived `counterpartyName` and
 * `counterpartyType`.
 *
 * ## The ledger accounts are derived ONCE, and an ordinary edit silently unwires them
 *
 * Nothing in the request mentions accounts unless you name them, and the API fills them in from
 * `loanType` and `perspective` — the full matrix is on ALLOWED_PERSPECTIVES below. For a borrower
 * bank loan that is principal **2220**, interest expense **8150**, accrued interest **2950**; for a
 * company loan to the owner, **1370**, interest income **8050**, accrued **1760**. Standard
 * Norwegian chart-of-accounts wiring, for free, and it is the useful half.
 *
 * The trap is that `PUT` treats them like every other field: **omit them and they are cleared**, and
 * nothing ever re-derives them. Measured with `interestTreatment` held constant, so the effect is
 * omission and nothing else: `8150`/`2950` → `null`/`null`. `principalAccountNumber` is the exception
 * and survives omission — `2220` stayed — so a caller who checks one field concludes the wrong thing
 * about the other two.
 *
 * This was first written up here as a consequence of switching `interestTreatment` to `capitalize`,
 * because that is when it was first seen. That was wrong, and re-measuring is what caught it:
 * carrying the accounts through a switch to `capitalize` keeps them (`8150`/`2950` intact with
 * `treatment: capitalize`), and omitting them clears them with the treatment untouched. The treatment
 * has nothing to do with it.
 *
 * So the hazard belongs to the raw endpoint, and this server is already hard to hurt with it. Two
 * layers, both verified live rather than assumed: `reai_update_loan` merges, so a partial edit through
 * it carries the accounts back; and `reai_request` refuses the same PUT through its omission gate,
 * which named all ten missing fields including the three accounts. Reaching the broken state took
 * `clearOmittedFields: true` — the deliberate override — which is the right amount of difficulty.
 *
 * `missingInterestAccounts` is therefore about records broken deliberately or from outside: the ReAI
 * UI, another API client, or that override. Both read tools report it, because the record is
 * self-contradictory and no response says so. Verified end to end: the override produced the state,
 * `reai_get_loan` and `reai_list_loans` both named the two missing accounts, and passing them to
 * `reai_update_loan` cleared the warning.
 *
 * ## PUT replaces
 *
 * Measured with a body carrying only the nine required fields: `description` and `maturityDate` went
 * to null, and `repaymentType`, `dayCountConvention`, `interestTreatment` and `relatedParty` reverted
 * to `bullet`, `actual_365`, `pay_separately` and `false`. `reai_update_loan` merges rather than
 * sends what it was given, like the other replacement PUTs on this server.
 *
 * ## `relatedParty` is never inferred
 *
 * It stayed `false` on a `company_loan_to_owner` created with everything else set — a loan between a
 * company and its owner, which is a related party by construction. The API will not work that out,
 * and the field feeds note disclosure, so the create tool says so rather than leaving a filed record
 * quietly wrong.
 *
 * ## Reclassifying is not relabelling
 *
 * Because the accounts are derived at creation only, changing `loanType` or `perspective` on an
 * existing loan would keep the accounts of the classification it is leaving — a borrower loan moved
 * from `bank_loan` to `owner_loan_to_company` keeps 2220/8150 where the API would have derived
 * 2255/8159, which is a loan filed against the wrong balance-sheet line by an edit that reads like a
 * relabelling. The merge cannot fix that: it has no way to tell a derived number from one the caller
 * chose deliberately. So `reai_update_loan` refuses a reclassification that does not name accounts,
 * and names what the API would have derived (DERIVED_ACCOUNTS) so the caller can accept or override.
 *
 * The same edit also bypassed the `relatedParty` inference, which only ran on create: changing a
 * `bank_loan` to `intercompany` carried the stored `false` into the write and left note disclosure
 * understating a related party. The inference runs on update now, and says when it fired.
 *
 * ## Deleting
 *
 * `DELETE /api/loans/{id}` answers `204` and the id then reads `404` — a real delete, no archive, no
 * reversal. A creditor or debtor still referenced by a loan cannot be deleted: measured
 * `409 "Cannot delete creditor that is referenced by one or more loans"`, so loans go first.
 */

/** Every field `PUT /api/loans/{id}` accepts, which is the same set `POST` accepts. */
const LOAN_SETTABLE = [
  "reference",
  "description",
  "loanType",
  "perspective",
  "currency",
  "principalAmount",
  "interestRateAnnual",
  "disbursementDate",
  "maturityDate",
  "repaymentType",
  "dayCountConvention",
  "interestTreatment",
  "relatedParty",
  "counterpartyId",
  "principalAccountNumber",
  "interestExpenseAccountNumber",
  "interestIncomeAccountNumber",
  "accruedInterestAccountNumber",
  "companyBankId",
] as const;

/** What the API requires on both POST and PUT. */
const LOAN_REQUIRED = [
  "reference",
  "loanType",
  "perspective",
  "currency",
  "principalAmount",
  "interestRateAnnual",
  "disbursementDate",
  "repaymentType",
  "counterpartyId",
] as const;

const LOAN_TYPES = [
  "bank_loan",
  "owner_loan_to_company",
  "company_loan_to_owner",
  "company_loan_to_employee",
  "intercompany",
  "other",
] as const;

const PERSPECTIVES = ["borrower", "lender"] as const;
const REPAYMENT_TYPES = ["bullet", "annuity", "linear", "interest_only", "manual"] as const;
const DAY_COUNTS = ["actual_365", "thirty_360", "simple_monthly"] as const;
const TREATMENTS = ["pay_separately", "capitalize", "accrue"] as const;

/**
 * Which perspectives each loan type accepts, and the accounts each combination derives.
 *
 * Neither is in the spec, and the first is a hard constraint: four of the six types are
 * direction-locked, and getting it wrong answers `400 "Lånetypen er ikke gyldig for valgt
 * låneperspektiv"` — a Norwegian sentence about a rule the caller was never told. Measured, the whole
 * matrix, on the write test tenant:
 *
 * | loanType                 | borrower                    | lender                      |
 * |--------------------------|-----------------------------|-----------------------------|
 * | bank_loan                | 2220 / 8150 / 2950 (bank)   | refused                     |
 * | owner_loan_to_company    | 2255 / 8159 / 2950 (owner)  | refused                     |
 * | company_loan_to_owner    | refused                     | 1370 / 8050 / 1760 (owner)  |
 * | company_loan_to_employee | refused                     | 1572 / 8050 / 1760 (other)  |
 * | intercompany             | 2260 / 8130 / 2950 (company)| 1320 / 8030 / 1760 (company)|
 * | other                    | 2220 / 8159 / 2950 (other)  | 1320 / 8050 / 1760 (other)  |
 *
 * The lock is just the direction the name already states: a bank loan is one the company took, a
 * company loan to the owner is one it granted. `intercompany` and `other` say nothing about
 * direction, so both are allowed. The accounts are principal / interest / accrued, and the bracket is
 * the derived `counterpartyType`.
 */
const ALLOWED_PERSPECTIVES: Record<string, readonly string[]> = {
  bank_loan: ["borrower"],
  owner_loan_to_company: ["borrower"],
  company_loan_to_owner: ["lender"],
  company_loan_to_employee: ["lender"],
  intercompany: ["borrower", "lender"],
  other: ["borrower", "lender"],
};

/**
 * The accounts the API derived for each combination, as principal / interest / accrued.
 *
 * Recorded so a refusal can name the right numbers instead of only saying that the stored ones are
 * wrong. It is a measurement, not a rule this server enforces: the API derives these at creation and
 * never again, so on a reclassification the caller has to pass them and these are what to pass.
 */
const DERIVED_ACCOUNTS: Record<string, { principal: string; interest: string; accrued: string }> = {
  "bank_loan/borrower": { principal: "2220", interest: "8150", accrued: "2950" },
  "owner_loan_to_company/borrower": { principal: "2255", interest: "8159", accrued: "2950" },
  "company_loan_to_owner/lender": { principal: "1370", interest: "8050", accrued: "1760" },
  "company_loan_to_employee/lender": { principal: "1572", interest: "8050", accrued: "1760" },
  "intercompany/borrower": { principal: "2260", interest: "8130", accrued: "2950" },
  "intercompany/lender": { principal: "1320", interest: "8030", accrued: "1760" },
  "other/borrower": { principal: "2220", interest: "8159", accrued: "2950" },
  "other/lender": { principal: "1320", interest: "8050", accrued: "1760" },
};

/** What the name says the direction is, for a refusal that explains rather than quotes a 400. */
const DIRECTION_REASON: Record<string, string> = {
  bank_loan: "a bank loan is money the company borrowed, so the company is the borrower",
  owner_loan_to_company: "the owner lent to the company, so the company is the borrower",
  company_loan_to_owner: "the company lent to its owner, so the company is the lender",
  company_loan_to_employee: "the company lent to an employee, so the company is the lender",
};

/** Loan types where the counterparty is, by construction, a related party. */
const INHERENTLY_RELATED: readonly string[] = [
  "owner_loan_to_company",
  "company_loan_to_owner",
  "company_loan_to_employee",
  "intercompany",
];

type LoanRecord = {
  id?: number;
  reference?: string;
  description?: string | null;
  loanType?: string;
  perspective?: string;
  status?: string;
  currency?: string;
  principalAmount?: number;
  interestRateAnnual?: number;
  disbursementDate?: string;
  maturityDate?: string | null;
  repaymentType?: string;
  interestTreatment?: string;
  relatedParty?: boolean;
  counterpartyName?: string | null;
  counterpartyType?: string | null;
  creditorId?: number | null;
  debtorId?: number | null;
  principalAccountNumber?: string | null;
  interestExpenseAccountNumber?: string | null;
  interestIncomeAccountNumber?: string | null;
  accruedInterestAccountNumber?: string | null;
};

const describeLoan = (loan: LoanRecord): string => {
  const bits = [
    loan.reference,
    loan.loanType,
    loan.perspective,
    loan.principalAmount !== undefined ? `${loan.principalAmount} ${loan.currency ?? ""}`.trim() : undefined,
    loan.interestRateAnnual !== undefined ? `${loan.interestRateAnnual}% p.a.` : undefined,
    loan.counterpartyName ? `counterparty ${loan.counterpartyName}` : undefined,
    loan.status,
  ].filter(Boolean);
  return bits.join(" · ");
};

/**
 * Accounts the loan needs for the treatment it claims, and does not have.
 *
 * Reachable only through the raw endpoint or the ReAI UI, since this server's update tool merges the
 * accounts back — a PUT that omits them clears them. `accrue` is grouped with `pay_separately`
 * because both post interest somewhere other than the principal; `capitalize` legitimately has
 * neither, so it is not flagged.
 */
function missingInterestAccounts(loan: LoanRecord): string[] {
  const treatment = loan.interestTreatment;
  if (treatment !== "pay_separately" && treatment !== "accrue") return [];
  const missing: string[] = [];
  const wantsExpense = loan.perspective === "borrower";
  if (wantsExpense && !loan.interestExpenseAccountNumber) missing.push("interestExpenseAccountNumber");
  if (!wantsExpense && !loan.interestIncomeAccountNumber) missing.push("interestIncomeAccountNumber");
  if (!loan.accruedInterestAccountNumber) missing.push("accruedInterestAccountNumber");
  return missing;
}

const counterpartyNote = (perspective: string | undefined): string =>
  perspective === "lender"
    ? "counterpartyId is read as a DEBTOR id because perspective is lender"
    : "counterpartyId is read as a CREDITOR id because perspective is borrower";

const listLoans = defineTool({
  name: "reai_list_loans",
  title: "List loans",
  description:
    "Every loan on the company, borrowed and lent. Each row carries the derived ledger accounts and " +
    "the resolved counterparty, so this answers most questions without a second call.\n\n" +
    "Read `creditorId` / `debtorId` rather than looking for `counterpartyId`: the field is called " +
    "counterpartyId on the way in and comes back under whichever of the two the perspective " +
    "selected, with the other null. `counterpartyName` and `counterpartyType` are derived.\n\n" +
    "This endpoint takes no filters, so `query` narrows the list HERE, on reference, description, " +
    "counterparty name, loanType and perspective, case-insensitively. A no-match answer is about " +
    "this list, not about what the API would accept.",
  risk: "read",
  apiPaths: [["GET", "/api/loans"]],
  inputSchema: {
    query: z.string().optional().describe("Narrow by reference, description, counterparty, type or perspective."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<LoanRecord[]>({
      method: "GET",
      path: "/api/loans",
      tenantId: resolveTenantId(args.tenantId, ctx),
    });
    // NOT `Array.isArray(...) ? ... : []`. Collapsing an unexpected shape into an empty array makes
    // "the response was an envelope I did not understand" indistinguishable from "this company has no
    // loans" -- and the second is a statement a model will act on. okList says which it is.
    if (!Array.isArray(res.data)) return okList(res.data, { noun: "loan" });
    const all = res.data;
    const needle = args.query?.trim().toLowerCase();
    const rows = needle
      ? all.filter((loan) =>
          // `description` belongs here: both this tool's description and the `query` argument's promise
          // it, and leaving it out made the tool quietly contradict its own documentation.
          [loan.reference, loan.description, loan.counterpartyName, loan.loanType, loan.perspective, loan.status]
            .filter((v): v is string => typeof v === "string")
            .some((v) => v.toLowerCase().includes(needle)),
        )
      : all;

    const contradictory = rows.filter((loan) => missingInterestAccounts(loan).length > 0);
    const notes: string[] = [];
    if (needle) {
      notes.push(
        `Filtered locally to ${rows.length} of ${all.length} loan(s): this endpoint takes no ` +
          `parameters, so no-match means no match in this list.`,
      );
    }
    if (contradictory.length > 0) {
      notes.push(
        `${contradictory.length} loan(s) claim an interest treatment they have no account for — ` +
          contradictory
            .map((l) => `${l.id} (${l.interestTreatment}, missing ${missingInterestAccounts(l).join(" and ")})`)
            .join("; ") +
          `. The API derives these accounts once, at creation, and a PUT that omits them clears ` +
          `them for good — reai_update_loan merges, so the damage came from reai_request or the ReAI ` +
          `UI. Pass the account numbers explicitly with reai_update_loan to put them back.`,
      );
    }
    return okList(rows, {
      noun: "loan",
      suffix: notes.length ? `. ${notes.join(" ")}` : "",
      empty: needle
        ? `No loan matches ${JSON.stringify(args.query)} among the ${all.length} on this company. ` +
          `This endpoint takes no parameters, so the filter ran here.`
        : "No loans are recorded on this company.",
    });
  },
});

const getLoan = defineTool({
  name: "reai_get_loan",
  title: "Read one loan",
  description:
    "One loan, with its derived ledger accounts and resolved counterparty.\n\n" +
    "The accounts are the part worth reading. They are derived at creation from loanType, " +
    "perspective — measured: a borrower bank loan gets principal 2220, interest expense 8150, " +
    "accrued interest 2950; a company loan to the owner gets 1370, interest income 8050, accrued " +
    "1760 — and they are NEVER re-derived. A PUT that omits them clears them, so if this loan says " +
    "pay_separately with no interest account, it was edited through reai_request or the ReAI UI and " +
    "needs the numbers passed back explicitly. reai_update_loan merges, so it cannot cause this.",
  risk: "read",
  apiPaths: [["GET", "/api/loans/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Loan id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<LoanRecord>({
      method: "GET",
      path: `/api/loans/${args.id}`,
      tenantId: resolveTenantId(args.tenantId, ctx),
    });
    const loan = res.data ?? {};
    const missing = missingInterestAccounts(loan);
    const notes = [describeLoan(loan), counterpartyNote(loan.perspective)];
    if (missing.length > 0) {
      notes.push(
        `INCONSISTENT: interestTreatment is ${loan.interestTreatment} but ${missing.join(" and ")} ` +
          `${missing.length === 1 ? "is" : "are"} empty, so there is nowhere to post the interest. ` +
          `The API derives these once and never again — pass them explicitly with reai_update_loan.`,
      );
    }
    return ok(loan, { note: notes.join("\n\n") });
  },
});

const createLoan = defineTool({
  name: "reai_create_loan",
  title: "Record a loan",
  description:
    "Record a loan the company has taken or granted. Nine fields are required and two of them are " +
    "easy to get wrong.\n\n" +
    "**`counterpartyId` is not one id space.** `perspective: \"borrower\"` reads it as a CREDITOR " +
    "id; `perspective: \"lender\"` reads it as a DEBTOR id. Measured: the wrong one answers " +
    '404 "Creditor with id=N not found" or "Debtor with id=N not found". Create the counterparty ' +
    "first if it does not exist — both take just a name.\n\n" +
    "**The ledger accounts are derived here and only here.** Leave them out and the API wires up " +
    "the standard Norwegian accounts from loanType, perspective and interestTreatment (measured: " +
    "2220/8150/2950 for a borrower bank loan; 1370/8050/1760 for a company loan to the owner). " +
    "Nothing re-derives them later, so a wrong loanType now means hand-written account numbers " +
    "forever.\n\n" +
    "**`relatedParty` is never inferred.** A loan to the owner, from the owner, to an employee or " +
    "between group companies is a related party by construction, and the API still stores `false` " +
    "unless told. This tool sets it for those loan types when you do not say, and reports that it " +
    "did.\n\n" +
    "A company loan to a personal shareholder has tax consequences in Norway that a bookkeeping " +
    "record does not capture — it can be taxed as a dividend. Recording it here is not advice about " +
    "how it should be treated; ask an accountant.\n\n" +
    "Recording a loan is gated to full write mode. Measured, creating one posts nothing to the " +
    "ledger — voucher count 0 before and after — and DELETE removes it (204, then 404), so it is " +
    "recoverable in the sense that matters here. It is still gated, because the record is the basis " +
    "for later interest and repayment postings rather than reference data, and that measurement was " +
    "taken on a company with no loan history to lose.",
  // irreversible to match the policy tier for /api/loans, which classifies the whole prefix that way
  // -- see the note there for why the measurement was not taken as licence to relax it. A curated
  // tool that is softer than reai_request for the same call is a hole, not a convenience.
  risk: "irreversible",
  apiPaths: [["POST", "/api/loans"]],
  inputSchema: {
    reference: z
      .string()
      .min(1)
      .max(30)
      .describe("Your reference for the loan. The API caps this at 30 characters."),
    loanType: z.enum(LOAN_TYPES).describe("What kind of loan this is. Also selects the ledger accounts."),
    perspective: z
      .enum(PERSPECTIVES)
      .describe("borrower if the company owes, lender if it is owed. Selects how counterpartyId is read."),
    counterpartyId: z
      .number()
      .int()
      .positive()
      .describe("A CREDITOR id when perspective is borrower, a DEBTOR id when it is lender."),
    currency: CURRENCY_CODE.describe("Three-letter currency code, e.g. NOK."),
    principalAmount: z.number().min(0.01).describe("The principal. The API requires at least 0.01."),
    interestRateAnnual: z.number().min(0).describe("Annual interest rate in percent. 0 is accepted."),
    disbursementDate: isoDate.describe("When the money moved, yyyy-MM-dd."),
    repaymentType: z.enum(REPAYMENT_TYPES).describe("How the principal is repaid."),
    description: z.string().optional().describe("Free text."),
    maturityDate: isoDate.optional().describe("When the loan matures, yyyy-MM-dd."),
    dayCountConvention: z.enum(DAY_COUNTS).optional().describe("Defaults to actual_365."),
    interestTreatment: z
      .enum(TREATMENTS)
      .optional()
      .describe("Defaults to pay_separately. capitalize means no separate interest account is derived."),
    relatedParty: z
      .boolean()
      .optional()
      .describe("Left unset, this is inferred for owner, employee and intercompany loans."),
    principalAccountNumber: z.string().optional().describe("Overrides the derived principal account."),
    interestExpenseAccountNumber: z.string().optional().describe("Overrides the derived interest expense account."),
    interestIncomeAccountNumber: z.string().optional().describe("Overrides the derived interest income account."),
    accruedInterestAccountNumber: z.string().optional().describe("Overrides the derived accrued interest account."),
    companyBankId: z.number().int().positive().optional().describe("The company bank account the money moved through."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...body } = args;
    const resolved = requireTenantId(tenantId, ctx);

    // Refused here rather than upstream, because upstream refuses in Norwegian and does not say what
    // the rule is: `400 "Lånetypen er ikke gyldig for valgt låneperspektiv"`. Measured for all twelve
    // combinations -- see ALLOWED_PERSPECTIVES.
    const allowed = ALLOWED_PERSPECTIVES[body.loanType] ?? ["borrower", "lender"];
    if (!allowed.includes(body.perspective)) {
      const reason = DIRECTION_REASON[body.loanType];
      return fail(
        `loanType ${body.loanType} cannot be recorded with perspective ${body.perspective}: ` +
          `${reason ?? `it only accepts ${allowed.join(" or ")}`}. Nothing was sent — the API refuses ` +
          `this pair with a 400 that does not say why ("Lånetypen er ikke gyldig for valgt ` +
          `låneperspektiv"). Use perspective ${allowed.join(" or ")}, or a loanType that matches the ` +
          `direction you mean: intercompany and other accept both.`,
      );
    }

    // Inferred rather than defaulted at the schema, so the answer can say it happened. A filed
    // record that understates a related party is wrong in a way nobody reads back.
    const inferredRelatedParty =
      body.relatedParty === undefined && INHERENTLY_RELATED.includes(body.loanType) ? true : undefined;
    const payload = { ...body, ...(inferredRelatedParty !== undefined ? { relatedParty: true } : {}) };

    let res;
    try {
      res = await ctx.client.request<LoanRecord>({
        method: "POST",
        path: "/api/loans",
        body: payload,
        tenantId: resolved,
      });
    } catch (err) {
      // `reference` is UNIQUE per company, which the spec does not say. Measured:
      // `400 "Lån med referanse X finnes allerede."` Named here because the message is Norwegian and
      // a caller retrying with the same reference will keep getting it.
      const detail = err instanceof ReaiApiError ? `${err.message} ${err.rawBody ?? ""}` : String(err);
      if (err instanceof ReaiApiError && err.status === 400 && /finnes allerede/.test(detail)) {
        return fail(
          `A loan with reference ${JSON.stringify(body.reference)} already exists on this company. ` +
            `The API requires the reference to be unique and says so only in Norwegian ("Lån med ` +
            `referanse ... finnes allerede"). Nothing was created — pick a different reference, or ` +
            `find the existing loan with reai_list_loans and edit that one.`,
        );
      }
      throw err;
    }
    const loan = res.data ?? {};

    const notes = [
      `Loan ${loan.id ?? "?"} recorded: ${describeLoan(loan)}.`,
      `Ledger accounts derived by the API: principal ${loan.principalAccountNumber ?? "none"}, ` +
        `interest ${loan.interestExpenseAccountNumber ?? loan.interestIncomeAccountNumber ?? "none"}, ` +
        `accrued ${loan.accruedInterestAccountNumber ?? "none"}. These are set once and never ` +
        `re-derived, so check them now rather than after the first posting.`,
      counterpartyNote(loan.perspective) +
        `, and it resolved to ${JSON.stringify(loan.counterpartyName ?? null)}` +
        ` (${loan.creditorId !== null && loan.creditorId !== undefined ? `creditorId ${loan.creditorId}` : `debtorId ${loan.debtorId}`}).`,
    ];
    if (inferredRelatedParty !== undefined) {
      notes.push(
        `relatedParty was set to true because loanType is ${body.loanType}, which is a related ` +
          `party by construction. The API does not infer this — measured, it stores false. Pass ` +
          `relatedParty: false explicitly if this really is at arm's length.`,
      );
    }
    if (loan.relatedParty === false && INHERENTLY_RELATED.includes(String(loan.loanType))) {
      notes.push(
        `WARNING: this is a ${loan.loanType} and the stored relatedParty is false, which the note ` +
          `disclosure will follow.`,
      );
    }
    return ok(loan, { note: notes.join("\n\n") });
  },
});

const updateLoan = defineTool({
  name: "reai_update_loan",
  title: "Change a loan",
  description:
    "Change a loan. This endpoint REPLACES the record rather than patching it, so the tool reads " +
    "the loan first and merges your change into it.\n\n" +
    "Measured, with a body carrying only the nine required fields: `description` and `maturityDate` " +
    "went to null, and `repaymentType`, `dayCountConvention`, `interestTreatment` and " +
    "`relatedParty` reverted to bullet, actual_365, pay_separately and false. Sending only what you " +
    "want to change would erase the rest.\n\n" +
    "That merge is also what keeps the ledger accounts. On the raw endpoint, omitting " +
    "`interestExpenseAccountNumber` and `accruedInterestAccountNumber` CLEARS them — measured with " +
    "`interestTreatment` held constant, so it is omission and not the treatment — and nothing ever " +
    "re-derives them, leaving a loan with nowhere to post its interest. `principalAccountNumber` " +
    "survives omission, so checking that one proves nothing about the other two. Because this tool " +
    "carries them back, a partial edit here cannot unwire a loan; if it reports a loan as " +
    "INCONSISTENT, the damage was done through reai_request or in the ReAI UI, and the fix is to " +
    "pass the numbers explicitly.\n\n" +
    "**Changing `perspective` re-points `counterpartyId` at a different table** — creditors for " +
    "borrower, debtors for lender — so an unchanged id means a different party, or a 404.",
  risk: "irreversible",
  // The GET is declared as well as the PUT, because the handler really performs both: the merge cannot
  // work without reading first. Understating that hides an operation the tool touches, and the
  // repository's merge-tool invariant discovers read-merge-write tools BY this pair, so omitting the
  // GET also excluded this tool from the check written for exactly its shape.
  apiPaths: [
    ["GET", "/api/loans/{id}"],
    ["PUT", "/api/loans/{id}"],
  ],
  inputSchema: {
    id: z.number().int().positive().describe("Loan id."),
    reference: z.string().min(1).max(30).optional().describe("The API caps this at 30 characters."),
    description: z.string().nullable().optional().describe("Free text. null clears it."),
    loanType: z.enum(LOAN_TYPES).optional(),
    perspective: z.enum(PERSPECTIVES).optional().describe("Changing this re-points counterpartyId at another table."),
    counterpartyId: z.number().int().positive().optional().describe("Creditor id for borrower, debtor id for lender."),
    currency: CURRENCY_CODE.optional(),
    principalAmount: z.number().min(0.01).optional(),
    interestRateAnnual: z.number().min(0).optional(),
    disbursementDate: isoDate.optional(),
    maturityDate: isoDate.nullable().optional().describe("null clears it."),
    repaymentType: z.enum(REPAYMENT_TYPES).optional(),
    dayCountConvention: z.enum(DAY_COUNTS).optional(),
    interestTreatment: z.enum(TREATMENTS).optional().describe("capitalize means interest joins the principal rather than being posted separately."),
    relatedParty: z.boolean().optional(),
    principalAccountNumber: z.string().optional(),
    interestExpenseAccountNumber: z.string().optional().describe("Pass this to restore an account a raw PUT cleared."),
    interestIncomeAccountNumber: z.string().optional().describe("Pass this to restore an account a raw PUT cleared."),
    accruedInterestAccountNumber: z.string().optional().describe("Pass this to restore an account a raw PUT cleared."),
    // Nullable, because `LoanReq` says so and detaching a loan from its bank account is a real edit.
    // With `.optional()` alone the only way to express it was omission, which the merge turns into
    // "keep the old id" -- so the supported change was unreachable through this tool.
    companyBankId: z.number().int().positive().nullable().optional(),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, ...changes } = args;
    const resolved = requireTenantId(tenantId, ctx);

    const current = await ctx.client.request<unknown>({
      method: "GET",
      path: `/api/loans/${id}`,
      tenantId: resolved,
    });
    const { record, problem } = readableRecord(current.data, undefined, LOAN_SETTABLE);
    if (!record) {
      return fail(
        `Could not read loan ${id}: ${problem}. Nothing was written — this endpoint REPLACES the ` +
          `record, so without the current values to merge into, every field you did not pass would ` +
          `have been erased, including the derived ledger accounts.`,
      );
    }

    // The record answers with creditorId/debtorId; the request wants counterpartyId. Without this
    // the merge would carry no counterparty at all and the write would fail its required check --
    // or worse, if the API ever stopped requiring it, silently unlink the party.
    const existing: Record<string, unknown> = { ...record };
    if (existing.counterpartyId === undefined) {
      const fromRecord = record.perspective === "lender" ? record.debtorId : record.creditorId;
      if (typeof fromRecord === "number") existing.counterpartyId = fromRecord;
    }

    const { merged, kept, unknown, missing, given } = mergeForReplacement({
      existing,
      changes,
      settable: LOAN_SETTABLE,
      required: LOAN_REQUIRED,
    });
    if (given.length === 0) return fail(`No changes were given, so nothing was written to loan ${id}.`);
    if (missing.length > 0) {
      return fail(
        `The API requires ${missing.join(", ")} on a loan, and neither your change nor the stored ` +
          `record supplies ${missing.length === 1 ? "it" : "them"}. Nothing was written — pass ` +
          `${missing.join(" and ")} explicitly.`,
      );
    }

    // The same direction rule as create, on the MERGED record rather than on the change: changing only
    // loanType can break a pair that was valid before, and the merge is what the API will see.
    const mergedType = String(merged.loanType);
    const mergedPerspective = String(merged.perspective);
    const allowed = ALLOWED_PERSPECTIVES[mergedType] ?? ["borrower", "lender"];
    if (!allowed.includes(mergedPerspective)) {
      return fail(
        `loan ${id} would end up as loanType ${mergedType} with perspective ${mergedPerspective}, ` +
          `which the API refuses: ${DIRECTION_REASON[mergedType] ?? `that type only accepts ${allowed.join(" or ")}`}. ` +
          `Nothing was written. Change both fields together, or pick a type that accepts the ` +
          `direction you mean — intercompany and other accept either.`,
      );
    }

    // A perspective flip with the id carried over from the record is the one merge that is
    // dangerous BECAUSE it succeeds: the number is valid, it just now means a different party.
    //
    // Keyed on the perspective actually CHANGING, not on the field being present. The first version
    // refused `{ perspective: "borrower", interestRateAnnual: 6 }` on a loan that was already
    // borrower — an idempotent restatement, which is exactly what a caller echoing a record back
    // sends — and demanded a redundant counterpartyId for a table change that was not happening.
    const perspectiveChanged =
      given.includes("perspective") && changes.perspective !== existing.perspective;
    if (perspectiveChanged && !given.includes("counterpartyId")) {
      const table = changes.perspective === "lender" ? "DEBTOR" : "CREDITOR";
      return fail(
        `Refusing to change perspective on loan ${id} without a counterpartyId. perspective ` +
          `selects which table the id is read from, so carrying over ${JSON.stringify(existing.counterpartyId)} ` +
          `would look it up as a ${table} id instead — a different party if that id exists, and a ` +
          `404 if it does not. Nothing was written. Pass counterpartyId with the new perspective.`,
      );
    }

    // Reclassifying a loan changes which accounts it SHOULD post to, and the API derives accounts only
    // at creation — so the merge, doing its job, would carry the old classification's accounts into the
    // new one. A borrower loan moved from bank_loan to owner_loan_to_company would keep 2220/8150 where
    // the API would have derived 2255/8159: a loan filed against the wrong balance-sheet line, from an
    // edit that looked like a relabelling. The merge cannot fix this, because it has no way to know
    // whether the stored numbers were derived or deliberately chosen. So it refuses and says what the
    // API would have picked.
    const typeChanged = given.includes("loanType") && changes.loanType !== existing.loanType;
    const accountFields = [
      "principalAccountNumber",
      "interestExpenseAccountNumber",
      "interestIncomeAccountNumber",
      "accruedInterestAccountNumber",
    ];
    if ((typeChanged || perspectiveChanged) && !accountFields.some((f) => given.includes(f))) {
      const derived = DERIVED_ACCOUNTS[`${mergedType}/${mergedPerspective}`];
      const wants = mergedPerspective === "borrower" ? "interestExpenseAccountNumber" : "interestIncomeAccountNumber";
      return fail(
        `Refusing to reclassify loan ${id} as ${mergedType}/${mergedPerspective} without saying which ` +
          `ledger accounts it should use. The API derives accounts once, at CREATION, and never ` +
          `re-derives them — so this edit would keep ` +
          `${JSON.stringify(existing.principalAccountNumber ?? null)}/` +
          `${JSON.stringify(existing.interestExpenseAccountNumber ?? existing.interestIncomeAccountNumber ?? null)}, ` +
          `which belong to the old classification. Nothing was written.\n\n` +
          (derived
            ? `Measured, the API derives principal ${derived.principal}, ${wants} ${derived.interest} ` +
              `and accruedInterestAccountNumber ${derived.accrued} for ${mergedType}/${mergedPerspective}. ` +
              `Pass those to accept them, or your own numbers to override.`
            : `Pass principalAccountNumber, ${wants} and accruedInterestAccountNumber explicitly.`) +
          `\n\nIf the classification was the mistake and the accounts are right, delete this loan and ` +
          `record it again — creation is the only thing that derives them.`,
      );
    }

    // relatedParty is inferred on create for the types that are related by construction, and the merge
    // would have quietly bypassed that: change a bank_loan to intercompany and the stored `false` gets
    // carried into the write, leaving note disclosure understating a related party — the exact harm the
    // create-side inference exists to prevent, reachable by an edit instead of a creation.
    if (
      typeChanged &&
      !given.includes("relatedParty") &&
      INHERENTLY_RELATED.includes(mergedType) &&
      merged.relatedParty !== true
    ) {
      merged.relatedParty = true;
    }
    const inferredOnUpdate = typeChanged && !given.includes("relatedParty") && INHERENTLY_RELATED.includes(mergedType);

    const res = await ctx.client.request<LoanRecord>({
      method: "PUT",
      path: `/api/loans/${id}`,
      body: merged,
      tenantId: resolved,
    });
    const after = res.data ?? {};

    const notes = [
      `Changed ${given.join(", ")} on loan ${id}` +
        (kept.length
          ? `; ${kept.join(", ")} ${kept.length === 1 ? "was" : "were"} read first and written back ` +
            `unchanged, because this endpoint replaces rather than patches.`
          : `.`),
    ];
    const missingAccounts = missingInterestAccounts(after);
    if (missingAccounts.length > 0) {
      notes.push(
        `INCONSISTENT after this write: interestTreatment is ${after.interestTreatment} but ` +
          `${missingAccounts.join(" and ")} ${missingAccounts.length === 1 ? "is" : "are"} empty. ` +
          `This tool merges, so it did not clear them: a PUT that omits them does, which means this ` +
          `loan was edited through reai_request or in the ReAI UI. ` +
          `Nothing re-derives an account, so pass ${missingAccounts.join(" and ")} explicitly to ` +
          `put ${missingAccounts.length === 1 ? "it" : "them"} back.`,
      );
    }
    if (inferredOnUpdate) {
      notes.push(
        `relatedParty was set to true because the loan is now a ${mergedType}, which is a related ` +
          `party by construction. The stored value was ${JSON.stringify(existing.relatedParty ?? null)} ` +
          `and the API does not infer this. Pass relatedParty: false explicitly if this really is at ` +
          `arm's length.`,
      );
    }
    if (unknown.length > 0) {
      notes.push(`The stored loan had no ${unknown.join(", ")} before this write.`);
    }
    return ok(after, { note: notes.join("\n\n") });
  },
});

const deleteLoan = defineTool({
  name: "reai_delete_loan",
  title: "Delete a loan",
  description:
    "Remove a loan record outright. Measured: 204, and the id then reads 404 — a real delete, with " +
    "no archive and no reversal, so nothing here brings it back.\n\n" +
    "Delete the loan before its counterparty: a creditor or debtor still referenced by a loan " +
    'cannot be removed, measured 409 "Cannot delete creditor that is referenced by one or more ' +
    'loans".',
  risk: "irreversible",
  destructive: true,
  apiPaths: [["DELETE", "/api/loans/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Loan id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<unknown>({
      method: "DELETE",
      path: `/api/loans/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data ?? { deleted: args.id }, {
      note:
        `Loan ${args.id} was deleted outright — HTTP ${res.status}, and the record is gone rather ` +
        `than archived. Its creditor or debtor is untouched and can now be deleted too, if nothing ` +
        `else references it.`,
    });
  },
});

export const loanTools: ToolDef[] = [listLoans, getLoan, createLoan, updateLoan, deleteLoan];
