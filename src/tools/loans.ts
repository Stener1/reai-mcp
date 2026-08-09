import { z } from "zod";
import { ReaiApiError } from "../reai/errors.js";
import {
  CURRENCY_CODE,
  defineTool,
  requiredName,
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
  type ToolResult,
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

/**
 * ## The counterparties
 *
 * Creditors and debtors moved here from the purchase toolset, and the reason is a measurement rather
 * than taste: `creditorId` and `debtorId` appear **once each in the entire document**, both on
 * `LoanRes`. Nothing else in this API references either. They were grouped with suppliers because a
 * creditor sounds like a payables concept, but in ReAI they exist only as the two ends of a loan — so
 * a caller who enabled only `loans` could not create the counterparty its own tools require, and one
 * who enabled only `purchase` got two tools for a domain that toolset does not cover.
 *
 * Measured while adding the missing half:
 *
 *   - A creditor carries `{id, name, bankAccountNumber, createdAt, updatedAt}`; a debtor has no bank
 *     account at all, just `{id, name, createdAt, updatedAt}`. So the asymmetry the comment below
 *     calls "coherent, and unverified" is at least real in the shapes.
 *   - `PUT /api/creditors/{id} {name}` — what a rename looks like — answered 200 and set
 *     `bankAccountNumber` to **null**, freshly re-measured. The account number used throughout these
 *     probes is `1506 20 99533`, which is a value this repository SUPPLIED rather than read from
 *     anyone's books, and it fails the Norwegian mod-11 check digit, so it cannot be a real account.
 *     Worth saying because "measured on a live tenant" otherwise reads as though a real counterparty's
 *     bank details had been copied into a public repository. That is what `reai_update_creditor` exists
 *     to prevent.
 *   - **Names are not unique on either side.** Two debtors called the same thing were created without
 *     complaint, ids 19 and 20. Unlike a loan's `reference`, nothing collides, so an agent that
 *     creates before it lists can silently end up choosing between duplicates.
 *   - A blank name is refused: `400 "Validation failed"` with `fieldErrors[].field: "name"`.
 */

/**
 * Creditors and debtors: the counterparties on a LOAN.
 *
 * What a "creditor" is here is INFERRED from the document, not stated by it. The ingredients are
 * real: `LoanRes` carries `creditorId` and `debtorId`, `LoanReq` takes a `counterpartyId`, and
 * `perspective` is borrower | lender. The step from there to "a creditor is the counterparty when
 * the company borrows, and its bankAccountNumber is where repayments go" rests on the English
 * meaning of the word plus that enum — nothing says `creditorId` is the one populated on the
 * borrower side, and nothing documents what the account number is for. The same goes for the
 * tidy story about why creditors carry an account number and debtors do not: coherent, and
 * unverified. Treat it as the best available reading rather than as measured.
 *
 * `creditorId` appears exactly once in the whole document, on LoanRes, so nothing here claims a
 * creditor is used anywhere else.
 */
const CREDITOR_SETTABLE = ["name", "bankAccountNumber"] as const;

const listCreditors = defineTool({
  name: "reai_list_creditors",
  title: "List creditors",
  description:
    "Loan counterparties the company owes — each with the bank account its repayments go to. " +
    "The document links these to loans through `LoanRes.creditorId`; a debtor is the mirror " +
    "image, for a loan the company has made.",
  risk: "read",
  apiPaths: [["GET", "/api/creditors"]],
  inputSchema: { tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/creditors",
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const rows = res.data;
    const missingAccount = Array.isArray(rows)
      ? rows.filter((r) => !(r as { bankAccountNumber?: unknown }).bankAccountNumber).length
      : 0;
    return okList(rows, {
      noun: "creditor",
      suffix:
        missingAccount > 0
          ? `. ${missingAccount} ${missingAccount === 1 ? "has" : "have"} no bank account number.`
          : ".",
      empty:
        "No creditors. A loan can still exist without one — LoanRes.creditorId is nullable — so " +
        "this being empty does not mean the company has no debt.",
    });
  },
});

const updateCreditor = defineTool({
  name: "reai_update_creditor",
  title: "Change a creditor",
  description:
    "Rename a creditor, or change the bank account its loan repayments go to. Pass only what you " +
    "want different; the rest is kept.\n\n" +
    "Measured on the account number, because it is a payment destination and this API does not treat nulls uniformly: on /api/creditors/{id} the field is cleared by a null, by OMITTING it, and by an empty string alike — all three verified with a read-back. That is why the merge carries it, and why the note below reports what the response says rather than what was sent." +
    "This exists because the underlying call replaces rather than patches, and `bankAccountNumber` " +
    "is not required — so `PUT {name}`, which is what a rename looks like, is accepted with a 200 " +
    "and sets the account number to null. Measured on a live tenant. The next repayment has " +
    "nowhere to go, and nothing in the response says so.\n\n" +
    "Needs REAI_WRITE_MODE=full, because the raw PUT can destroy a payment destination and a " +
    "curated tool must not be a softer route to it. Between the read and the write there is a " +
    "lost-update window: an edit made in the ReAI UI in between is silently reverted.",
  risk: "irreversible",
  destructive: true,
  apiPaths: [
    ["GET", "/api/creditors/{id}"],
    ["PUT", "/api/creditors/{id}"],
  ],
  inputSchema: {
    id: z.number().int().positive().describe("Creditor id, from reai_list_creditors."),
    name: requiredName(255).optional().describe("What the creditor is called."),
    bankAccountNumber: z
      .string()
      .max(50)
      .nullable()
      .optional()
      .describe(
        "The account loan repayments are paid into. Changing it changes where money goes; null " +
          "clears it deliberately, which leaves the repayment with no destination.",
      ),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, ...changes } = args;
    const resolved = requireTenantId(tenantId, ctx);
    const current = await ctx.client.request<unknown>({
      method: "GET",
      path: `/api/creditors/${id}`,
      tenantId: resolved,
    });
    const { record, problem } = readableRecord(current.data, undefined, CREDITOR_SETTABLE);
    if (!record) {
      return fail(
        `Could not read creditor ${id}: ${problem}. Nothing was written — this endpoint REPLACES ` +
          `the record, so the bank account number you did not pass would have been erased.`,
      );
    }
    const { merged, kept, unknown, missing, given } = mergeForReplacement({
      existing: record,
      changes,
      settable: CREDITOR_SETTABLE,
      required: ["name"],
    });
    if (given.length === 0) return fail("No changes were given, so nothing was written.");
    if (missing.length > 0) {
      return fail(
        `The API requires ${missing.join(", ")} on a creditor, and neither your change nor the ` +
          `stored record supplies it. Nothing was written.`,
      );
    }
    const res = await ctx.client.request<Record<string, unknown>>({
      method: "PUT",
      path: `/api/creditors/${id}`,
      body: merged,
      tenantId: resolved,
    });
    const notes = [
      `Changed ${given.join(", ")} on creditor ${id}` +
        (kept.length
          ? `; ${kept.join(", ")} ${kept.length === 1 ? "was" : "were"} read first and written ` +
            `back unchanged, because this endpoint replaces rather than patches.`
          : `.`),
    ];
    // From the RESPONSE, not from what was sent.
    //
    // This said "This creditor now has NO bank account number" on the strength of `merged`, so it announced
    // where money no longer goes without ever checking that the API agreed — while reai_update_company_bank,
    // the sibling tool for the same hazard, has always compared `after.bban` against what it sent. On a field
    // that IS a payment destination, reporting the request as though it were the outcome is the wrong half to
    // trust: this API silently discards some values (see order-and-offer-put-ignores-most-nulls), so "sent"
    // and "stored" are not interchangeable.
    //
    // For creditors they do agree, and that is now measured rather than assumed: on 2783,
    // `bankAccountNumber` is cleared by a null, by omitting the field, AND by an empty string — three
    // throwaway creditors, one per shape, each read back with a separate GET. So the claim this tool has
    // always made is true here. It is verified anyway, because the cost of being wrong is a payment
    // destination and the check is two lines.
    const after = res.data ?? {};
    const carriesAccount = Object.hasOwn(after, "bankAccountNumber");
    const storedAccount = after.bankAccountNumber;
    if (given.includes("bankAccountNumber") && carriesAccount && storedAccount !== merged.bankAccountNumber) {
      notes.push(
        `WARNING: bankAccountNumber came back as ${JSON.stringify(storedAccount)}, not the ` +
          `${JSON.stringify(merged.bankAccountNumber)} that was sent. This API does silently discard some ` +
          `values, so read the creditor back before relying on where repayments go.`,
      );
    }
    const emptyNow = carriesAccount
      ? storedAccount === null || storedAccount === undefined || storedAccount === ""
      : merged.bankAccountNumber === null || merged.bankAccountNumber === undefined;
    if (emptyNow) {
      notes.push(
        `This creditor now has NO bank account number, so a loan repayment to it has no destination. ` +
          (carriesAccount
            ? `Confirmed from the response, not from what was sent.`
            : `Inferred from the request: this response did not carry bankAccountNumber, so read the ` +
              `creditor back to be sure.`),
      );
    }
    if (unknown.length > 0) {
      notes.push(
        `Note: ${unknown.join(", ")} was not already set. Fine for a first-time value; a misspelt ` +
          `name looks the same, so confirm it took effect.`,
      );
    }
    return ok(res.data, { note: notes.join("\n\n") });
  },
});

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

/**
 * Turn the two upstream errors that matter into something a caller can act on, for BOTH write tools.
 *
 * The wrong-table 404 is the one this whole module is about, and it was reaching callers raw: a debtor
 * id sent with `perspective: "borrower"` answers `404 "Creditor with id=78 not found"` — from a POST,
 * where a 404 reads as "the endpoint or the record was not found" rather than "your id is in the other
 * id space". The tool holds both the perspective and the id, so it can say which space was searched
 * and what to change.
 *
 * The duplicate reference was translated in `create` only, which left the curated PUT worse informed
 * than `reai_request` — the quirk covers PUT, the tool did not.
 */
function translateLoanError(
  err: unknown,
  ctx: { perspective?: unknown; counterpartyId?: unknown; reference?: unknown },
): ToolResult | undefined {
  if (!(err instanceof ReaiApiError)) return undefined;
  const detail = `${err.message} ${err.rawBody ?? ""}`;

  const wrongTable = /(Creditor|Debtor) with id=(\d+) not found/.exec(detail);
  if (err.status === 404 && wrongTable) {
    const searched = wrongTable[1] ?? "Creditor";
    const id = wrongTable[2] ?? "?";
    const other = searched === "Creditor" ? "Debtor" : "Creditor";
    const otherPerspective = searched === "Creditor" ? "lender" : "borrower";
    return fail(
      `Counterparty ${id} is not a ${searched.toLowerCase()}, and with perspective ` +
        `${JSON.stringify(ctx.perspective ?? null)} that is the id space this call searched. Nothing ` +
        `was written.\n\n` +
        `perspective decides the table: borrower reads counterpartyId as a CREDITOR id, lender as a ` +
        `DEBTOR id. So either ${id} is a ${other.toLowerCase()} and you meant ` +
        `perspective: ${JSON.stringify(otherPerspective)}, or the id is wrong for the direction you ` +
        `meant. The API's own answer is a bare 404, which reads as a missing endpoint rather than a ` +
        `misdirected id.`,
    );
  }

  if (err.status === 400 && /finnes allerede/.test(detail)) {
    return fail(
      `A loan with reference ${JSON.stringify(ctx.reference ?? null)} already exists on this company. ` +
        `The API requires the reference to be unique and says so only in Norwegian ("Lån med ` +
        `referanse ... finnes allerede"). Nothing was written — pick a different reference, or find ` +
        `the existing loan with reai_list_loans.`,
    );
  }
  return undefined;
}

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
  companyBankId?: number | null;
  dayCountConvention?: string;
  // Derived balances, present on every read and settable by nothing. Measured on a GET:
  // `outstandingPrincipal` and `accruedInterestBalance` come back alongside createdAt/updatedAt.
  outstandingPrincipal?: number | null;
  accruedInterestBalance?: number | null;
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

const counterpartyNote = (perspective: string | undefined): string => {
  // Three cases, not two. Reading an absent perspective as "borrower" made the tool ASSERT that a
  // record it could not classify was a borrower loan — a fabricated fact, and precisely the kind this
  // file spends its length trying to prevent.
  if (perspective === "lender") return "counterpartyId is read as a DEBTOR id because perspective is lender";
  if (perspective === "borrower") return "counterpartyId is read as a CREDITOR id because perspective is borrower";
  return (
    "This record does not say which perspective it has, so which id space its counterparty belongs to " +
    "cannot be stated: borrower means a creditor id, lender means a debtor id"
  );
};

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
    "One loan, with its derived ledger accounts, resolved counterparty and current balances. " +
    "`outstandingPrincipal` and `accruedInterestBalance` come back on every read and nothing here " +
    "sets them — they answer how much is left, and no endpoint in this API moves them, so repayments " +
    "happen in the ReAI UI.\n\n" +
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
    '404 "Creditor with id=N not found" or "Debtor with id=N not found", and this tool turns that ' +
    "into a sentence naming which id space it searched.\n\n" +
    "Create the counterparty first if it does not exist: reai_create_creditor for a borrower loan, " +
    "reai_create_debtor for a lender one, and reai_list_creditors / reai_list_debtors to find an " +
    "existing id. All four live in this toolset — names are unique on neither side, so listing first is " +
    "how you avoid choosing between duplicates later.\n\n" +
    "**The ledger accounts are derived here and only here.** Leave them out and the API wires up " +
    "the standard Norwegian accounts from loanType and perspective (measured: " +
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
    // The `??` is unreachable here -- loanType is a zod enum over exactly the six keys -- and kept for
    // the shape it shares with the update path, where merged.loanType comes from the API and the
    // fallback is live. Failing OPEN there is deliberate: a type this table has not heard of is one
    // whose rule nobody has measured, and the API refuses a bad pair anyway with the message the quirk
    // now documents.
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
      const translated = translateLoanError(err, {
        perspective: body.perspective,
        counterpartyId: body.counterpartyId,
        reference: body.reference,
      });
      if (translated) return translated;
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
          `Nothing was written. Change both fields together — and note that changing perspective also ` +
          `needs a counterpartyId, because it selects which table that id is read from — or pick a ` +
          `type that accepts the direction you mean, since intercompany and other accept either.`,
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

    let res;
    try {
      res = await ctx.client.request<LoanRecord>({
        method: "PUT",
        path: `/api/loans/${id}`,
        body: merged,
        tenantId: resolved,
      });
    } catch (err) {
      // Both translations apply here too. A 404 after a SUCCESSFUL GET of this loan can only be about
      // the counterparty, and `reference` is settable here, so the duplicate is reachable as well.
      const translated = translateLoanError(err, {
        perspective: merged.perspective,
        counterpartyId: merged.counterpartyId,
        reference: merged.reference,
      });
      if (translated) return translated;
      throw err;
    }
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


/**
 * The one refusal a counterparty delete can hit, in words rather than in Norwegian-flavoured English.
 *
 * Measured: `409 "Cannot delete creditor that is referenced by one or more loans"`. The message names
 * the constraint but not the way out, and the way out is an ordering — loans first — which the caller
 * cannot infer from a 409 alone.
 */
/**
 * A 409 on a create, reported rather than diagnosed.
 *
 * The document lists a 409 on both `POST /api/creditors` and `POST /api/debtors` and does not say what
 * causes it, while measurement points away from the obvious guess: two debtors with the same name were
 * accepted as separate ids. So this does not claim to know. It surfaces the API's own words and says
 * what the evidence does and does not support, which is the honest shape for a response nobody here has
 * reproduced.
 */
function counterpartyConflict(err: unknown, kind: "creditor" | "debtor", name: string): ToolResult | undefined {
  if (!(err instanceof ReaiApiError) || err.status !== 409) return undefined;
  const detail = err.problem?.detail ?? err.rawBody ?? "";
  return fail(
    `The API refused to create the ${kind} ${JSON.stringify(name)} with a 409 conflict. Nothing was ` +
      `created.\n\nIts words: ${JSON.stringify(String(detail).slice(0, 300))}\n\n` +
      `The document lists a 409 here without saying what causes it, and duplicate NAMES are known to be ` +
      `accepted — two debtors called the same thing were created as separate ids — so a name collision ` +
      `is probably not it. Read the message above, and list what exists with ` +
      `${kind === "creditor" ? "reai_list_creditors" : "reai_list_debtors"} rather than retrying with a ` +
      `different name.`,
  );
}

function referencedByLoan(err: unknown, kind: "creditor" | "debtor", id: number): ToolResult | undefined {
  if (!(err instanceof ReaiApiError) || err.status !== 409) return undefined;
  const detail = `${err.message} ${err.rawBody ?? ""}`;
  if (!/referenced by one or more loans/i.test(detail)) return undefined;
  return fail(
    `${kind === "creditor" ? "Creditor" : "Debtor"} ${id} is still named by at least one loan, so the API ` +
      `refuses to delete it. Nothing was deleted.\n\n` +
      `Delete the loans first — reai_list_loans shows which point here, under ` +
      `${kind === "creditor" ? "`creditorId`" : "`debtorId`"} — and then this. A loan delete is a real ` +
      `delete, so the reference goes with it rather than lingering in an archive.`,
  );
}

const createCreditor = defineTool({
  name: "reai_create_creditor",
  title: "Record a creditor",
  description:
    "A counterparty the company borrows FROM — the id `reai_create_loan` needs when `perspective` is " +
    "`borrower`. Nothing else in this API uses a creditor, so this exists to make a loan recordable.\n\n" +
    "`bankAccountNumber` is where repayments go, which makes it PAYMENT ROUTING: supplying it " +
    "escalates this call to irreversible, so on a server running the default REAI_WRITE_MODE=reversible " +
    "it is refused even though creating a creditor is otherwise reversible. That is deliberate — an " +
    "account number is where money ends up, and whoever pays next may be a person in the ReAI UI long " +
    "afterwards — but it means the two halves need different modes: create the creditor without an " +
    "account here, and set the account in full mode, with this tool or reai_update_creditor.\n\n" +
    "Worth setting as early as you can set it, because a later rename through the RAW endpoint erases " +
    "it: `PUT` replaces and the field is not required, so a body carrying only the name stores the " +
    "account as null — measured. reai_update_creditor merges and so does not do that.\n\n" +
    "Names are probably NOT unique, and the hedge is deliberate: two DEBTORS with the same name were " +
    "measured as separate records, and creditors were never tested. ReAI is inconsistent about this — " +
    'an employee name IS unique and answers 409 "Ansatt med dette navnet finnes allerede" — and both ' +
    "create endpoints document a 409 without saying what it is for. So list before creating, and if a " +
    "409 does come back this tool reports the API's own words rather than guessing. A blank name is " +
    "refused with a 400, which the document already implies with `minLength: 1`.",
  risk: "reversible",
  apiPaths: [["POST", "/api/creditors"]],
  inputSchema: {
    name: requiredName(255).describe("What the creditor is called. Not unique — check the list first."),
    bankAccountNumber: z
      .string()
      .max(50)
      .optional()
      .describe("The account loan repayments are paid into. Worth setting now; a raw PUT can erase it."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...body } = args;
    let res;
    try {
      res = await ctx.client.request<{ id?: number; name?: string; bankAccountNumber?: string | null }>({
        method: "POST",
        path: "/api/creditors",
        body,
        tenantId: requireTenantId(tenantId, ctx),
      });
    } catch (err) {
      const translated = counterpartyConflict(err, "creditor", args.name);
      if (translated) return translated;
      throw err;
    }
    const created = res.data ?? {};
    const notes = [
      `Creditor ${created.id ?? "?"} created${created.name ? `: ${created.name}` : ""}. Pass this id as ` +
        `counterpartyId on a loan with perspective "borrower".`,
    ];
    // Read off the RESPONSE, and it has to stay that way: keying this on the argument instead let the
    // tool announce "no destination" for a creditor that had one, or stay quiet about one that did not,
    // which is claiming an outcome the API never reported.
    if (!created.bankAccountNumber) {
      notes.push(
        args.bankAccountNumber
          ? `An account was sent but the response carries none, so the repayment destination is NOT ` +
            `established. Read the creditor back before relying on it.`
          : `No bankAccountNumber, so a repayment to this creditor has no destination yet. Setting one ` +
            `is payment routing and needs REAI_WRITE_MODE=full — with this tool at creation, or ` +
            `reai_update_creditor afterwards, which is itself only offered in full mode.`,
      );
    }
    return ok(created, { note: notes.join("\n\n") });
  },
});

const deleteCreditor = defineTool({
  name: "reai_delete_creditor",
  title: "Delete a creditor",
  description:
    "Remove a creditor. Delete its loans first: a creditor still referenced by one answers " +
    '409 "Cannot delete creditor that is referenced by one or more loans" — measured. ' +
    "reai_list_loans shows which loans point at it, under `creditorId`.",
  risk: "reversible",
  destructive: true,
  apiPaths: [["DELETE", "/api/creditors/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Creditor id, from reai_list_creditors."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    try {
      const res = await ctx.client.request<unknown>({
        method: "DELETE",
        path: `/api/creditors/${args.id}`,
        tenantId: requireTenantId(args.tenantId, ctx),
      });
      return ok(res.data ?? { deleted: args.id }, {
        note: `Creditor ${args.id} deleted — HTTP ${res.status}. Any loan that referenced it would have blocked this.`,
      });
    } catch (err) {
      const translated = referencedByLoan(err, "creditor", args.id);
      if (translated) return translated;
      throw err;
    }
  },
});

const listDebtors = defineTool({
  name: "reai_list_debtors",
  title: "List debtors",
  description:
    "Counterparties the company has lent TO — the id `reai_create_loan` needs when `perspective` is " +
    "`lender`, which is every `company_loan_to_owner`, every `company_loan_to_employee`, and the " +
    "lender side of `intercompany` and `other`.\n\n" +
    "A debtor carries NO bank account, unlike a creditor: the response is " +
    "`{id, name, createdAt, updatedAt}`. That is `DebtorRes`, the RESPONSE shape — the underlying " +
    "`Debtor` also has `archived` and `tenantId`, which nothing here exposes. Names are not unique, so " +
    "this list can legitimately hold two identical rows with different ids, and this tool counts them.\n\n" +
    "This endpoint takes NO parameters, so whether it hides archived debtors cannot be asked. A debtor " +
    "you expected and cannot find may be archived rather than absent.\n\n" +
    "Empty does not mean the company has lent nothing — `LoanRes.debtorId` is nullable.",
  risk: "read",
  apiPaths: [["GET", "/api/debtors"]],
  inputSchema: { tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/debtors",
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const rows = res.data;
    // Duplicate names are legal here, and an agent picking "the one called X" needs to know when that
    // phrase does not identify a record.
    // Keyed on a NORMALISED name and displayed as written. Comparing raw strings missed exactly the
    // collisions that cause the mistake: "Kari Nordmann" against "kari nordmann", and a trailing space.
    // Rows are guarded against being null, because a list with a null element used to throw a TypeError
    // out of a read tool.
    const seen = new Map<string, string>();
    const duplicated: string[] = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const raw = row && typeof row === "object" ? (row as { name?: unknown }).name : undefined;
      const display = typeof raw === "string" ? raw : "";
      const key = display.trim().toLowerCase();
      if (key === "") continue;
      if (seen.has(key)) {
        if (!duplicated.includes(seen.get(key) as string)) duplicated.push(seen.get(key) as string);
      } else {
        seen.set(key, display);
      }
    }
    return okList(rows, {
      noun: "debtor",
      suffix: duplicated.length
        ? `. ${duplicated.length} name(s) appear more than once (${duplicated.join(", ")}) — names are ` +
          `not unique here, so choose by id.`
        : ".",
      empty:
        "No debtors. A loan the company has made can still exist without one — LoanRes.debtorId is " +
        "nullable — so this being empty does not prove the company has lent nothing.",
    });
  },
});

const createDebtor = defineTool({
  name: "reai_create_debtor",
  title: "Record a debtor",
  description:
    "A counterparty the company lends TO — the id `reai_create_loan` needs when `perspective` is " +
    "`lender`. Without this, the whole lender half of the loan matrix could only be recorded through " +
    "reai_request.\n\n" +
    "`name` is the only field: a debtor has no bank account, which is the one asymmetry with a " +
    "creditor and is visible in the record shape rather than merely assumed. Names are NOT unique — " +
    "measured, two debtors with the same name were created as ids 19 and 20 without complaint — so " +
    "list first if you mean to reuse one. A blank name is refused with 400.",
  risk: "reversible",
  apiPaths: [["POST", "/api/debtors"]],
  inputSchema: {
    name: requiredName(255).describe("What the debtor is called. Not unique — check the list first."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    let res;
    try {
      res = await ctx.client.request<{ id?: number; name?: string }>({
        method: "POST",
        path: "/api/debtors",
        body: { name: args.name },
        tenantId: requireTenantId(args.tenantId, ctx),
      });
    } catch (err) {
      const translated = counterpartyConflict(err, "debtor", args.name);
      if (translated) return translated;
      throw err;
    }
    const created = res.data ?? {};
    return ok(created, {
      note:
        `Debtor ${created.id ?? "?"} created${created.name ? `: ${created.name}` : ""}. Pass this id as ` +
        `counterpartyId on a loan with perspective "lender" — a debtor id sent with "borrower" is ` +
        `looked up among CREDITORS and answers 404.`,
    });
  },
});

const updateDebtor = defineTool({
  name: "reai_update_debtor",
  title: "Rename a debtor",
  description:
    "Rename a debtor. `name` is the only field `DebtorReq` ACCEPTS, so this PUT cannot carry anything " +
    "else and there is nothing to merge — which is why this needs no read-merge-write and " +
    "reai_update_creditor does.\n\n" +
    "That argument is about the REQUEST shape, not the record. `components.schemas.Debtor` also carries " +
    "`archived` and `tenantId`, neither of which the response exposes, so whether a replacing PUT resets " +
    "`archived` is unknown and unobservable from here. It is not claimed either way.",
  risk: "reversible",
  idempotent: true,
  apiPaths: [["PUT", "/api/debtors/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Debtor id, from reai_list_debtors."),
    name: requiredName(255).describe("The new name."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<{ id?: number; name?: string }>({
      method: "PUT",
      path: `/api/debtors/${args.id}`,
      body: { name: args.name },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const stored = res.data ?? {};
    // The STORED name, not the argument. ReAI normalises names elsewhere in this API (suppliers are
    // title-cased), so echoing the request would report a value that was never written.
    const wrote = typeof stored.name === "string" ? stored.name : undefined;
    return ok(stored.id !== undefined ? stored : { id: args.id, name: args.name }, {
      note:
        wrote === undefined
          ? `Debtor ${args.id} was written — HTTP ${res.status} — but the response carries no name, so ` +
            `what is stored is unconfirmed. Read it back with reai_list_debtors.`
          : `Debtor ${args.id} is now ${JSON.stringify(wrote)}` +
            (wrote === args.name ? "." : ` — the API stored something other than the ${JSON.stringify(args.name)} that was sent.`) +
            ` Any loan pointing at it is unaffected.`,
    });
  },
});

const deleteDebtor = defineTool({
  name: "reai_delete_debtor",
  title: "Delete a debtor",
  description:
    "Remove a debtor. Delete its loans first: the creditor side answers " +
    '409 "Cannot delete creditor that is referenced by one or more loans" and a debtor is the mirror ' +
    "image. reai_list_loans shows which loans point at it, under `debtorId`.",
  risk: "reversible",
  destructive: true,
  apiPaths: [["DELETE", "/api/debtors/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Debtor id, from reai_list_debtors."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    try {
      const res = await ctx.client.request<unknown>({
        method: "DELETE",
        path: `/api/debtors/${args.id}`,
        tenantId: requireTenantId(args.tenantId, ctx),
      });
      return ok(res.data ?? { deleted: args.id }, {
        note: `Debtor ${args.id} deleted — HTTP ${res.status}. Any loan that referenced it would have blocked this.`,
      });
    } catch (err) {
      const translated = referencedByLoan(err, "debtor", args.id);
      if (translated) return translated;
      throw err;
    }
  },
});

export const loanTools: ToolDef[] = [
  listLoans,
  getLoan,
  createLoan,
  updateLoan,
  deleteLoan,
  listCreditors,
  createCreditor,
  updateCreditor,
  deleteCreditor,
  listDebtors,
  createDebtor,
  updateDebtor,
  deleteDebtor,
];
