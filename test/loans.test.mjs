// Loans, and specifically the three things the API does that a caller cannot guess. Every fact
// asserted here was measured against the write test tenant before it was written down; the module
// doc in src/tools/loans.ts records the measurements themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registeredTools } from "../dist/server.js";
import { classifyRequest } from "../dist/policy.js";
import { ReaiApiError } from "../dist/reai/errors.js";

/** The one perspective each direction-locked type accepts, for tests that need a valid pair. */
const ALLOWED_FOR = {
  bank_loan: "borrower",
  owner_loan_to_company: "borrower",
  company_loan_to_owner: "lender",
  company_loan_to_employee: "lender",
  intercompany: "borrower",
  other: "borrower",
};

const tool = (name) => {
  const found = registeredTools.find((t) => t.name === name);
  assert.ok(found, `${name} should exist`);
  return found;
};

/** A context whose client records what was sent and answers with whatever the test supplies. */
function ctxFor(responses) {
  const sent = [];
  const queue = [...responses];
  return {
    sent,
    ctx: {
      config: { boundTenantId: undefined, defaultTenantId: 2783, writeMode: "full", allowExternalSend: false },
      session: {},
      client: {
        request: async (opts) => {
          sent.push(opts);
          const next = queue.shift();
          if (next === undefined) throw new Error(`no canned response for ${opts.method} ${opts.path}`);
          return next;
        },
        deepLink: () => "https://app.reai.no/",
      },
    },
  };
}

const textOf = (res) => (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

const LOAN = {
  id: 13,
  reference: "L-1",
  description: "the original description",
  loanType: "bank_loan",
  perspective: "borrower",
  status: "open",
  currency: "NOK",
  principalAmount: 100000,
  interestRateAnnual: 5.5,
  disbursementDate: "2026-08-08",
  maturityDate: "2030-08-08",
  repaymentType: "annuity",
  dayCountConvention: "thirty_360",
  interestTreatment: "pay_separately",
  relatedParty: false,
  counterpartyName: "A Bank AS",
  counterpartyType: "bank",
  creditorId: 78,
  debtorId: null,
  principalAccountNumber: "2220",
  interestExpenseAccountNumber: "8150",
  interestIncomeAccountNumber: null,
  accruedInterestAccountNumber: "2950",
};

test("the loans toolset is not softer than the escape hatch", () => {
  for (const name of ["reai_create_loan", "reai_update_loan", "reai_delete_loan"]) {
    assert.equal(tool(name).risk, "irreversible", `${name} must match the policy tier for /api/loans`);
  }
  for (const [method, path] of [["POST", "/api/loans"], ["PUT", "/api/loans/7"], ["DELETE", "/api/loans/7"]]) {
    assert.equal(classifyRequest(method, path), "irreversible");
  }
  // The reads stay reads, which is the whole reason gating the writes costs so little.
  assert.equal(tool("reai_list_loans").risk, "read");
  assert.equal(tool("reai_get_loan").risk, "read");
});

test("query filters the loan list locally, because the endpoint takes no parameters", async () => {
  const rows = [
    { ...LOAN, id: 1, reference: "BANK-1", counterpartyName: "A Bank AS", loanType: "bank_loan" },
    { ...LOAN, id: 2, reference: "OWNER-1", counterpartyName: "Kari Nordmann", loanType: "company_loan_to_owner" },
  ];
  const { ctx, sent } = ctxFor([{ status: 200, data: rows }]);
  const res = await tool("reai_list_loans").handler({ query: "kari" }, ctx);

  // The filter really narrowed, and the API was not asked to.
  assert.match(textOf(res), /1 loan\(s\)/);
  assert.match(textOf(res), /filtered locally/i);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].query, undefined, "the query must not be forwarded — this endpoint takes none");
  assert.match(textOf(res), /OWNER-1/);
  assert.doesNotMatch(textOf(res), /BANK-1/);
});

test("an unexpected list shape is not reported as an empty company", async () => {
  // The failure this guards is a model being told "no loans are recorded" about a response that
  // contained loans under an envelope key.
  const { ctx } = ctxFor([{ status: 200, data: { content: [LOAN] } }]);
  const res = await tool("reai_list_loans").handler({}, ctx);
  assert.doesNotMatch(textOf(res), /No loans are recorded/);
  assert.match(textOf(res), /did not return a list/);
  assert.match(textOf(res), /L-1/, "the rows still have to come back");
});

test("a loan whose treatment has no account to post to is called out", async () => {
  // Measured with interestTreatment held constant, so the cause is omission and not the treatment: a
  // PUT that leaves interestExpenseAccountNumber and accruedInterestAccountNumber out clears them,
  // 8150/2950 -> null/null, and nothing re-derives them. principalAccountNumber survives, which is
  // what makes it easy to check the wrong field and conclude the loan is fine. Only reachable through
  // reai_request or the ReAI UI, because reai_update_loan merges them back.
  const wrecked = { ...LOAN, interestExpenseAccountNumber: null, accruedInterestAccountNumber: null };
  const { ctx } = ctxFor([{ status: 200, data: wrecked }]);
  const res = await tool("reai_get_loan").handler({ id: 13 }, ctx);
  const text = textOf(res);
  assert.match(text, /INCONSISTENT/);
  assert.match(text, /interestExpenseAccountNumber/);
  assert.match(text, /accruedInterestAccountNumber/);
  assert.match(text, /never again|re-derive/i);

  // And a coherent loan is not nagged about.
  const clean = ctxFor([{ status: 200, data: LOAN }]);
  assert.doesNotMatch(textOf(await tool("reai_get_loan").handler({ id: 13 }, clean.ctx)), /INCONSISTENT/);
});

test("update merges into the stored loan instead of replacing it", async () => {
  // PUT replaces: measured, a body of only the nine required fields nulled description and
  // maturityDate and reverted repaymentType, dayCountConvention, interestTreatment and relatedParty.
  const { ctx, sent } = ctxFor([
    { status: 200, data: LOAN },
    { status: 200, data: { ...LOAN, interestRateAnnual: 6 } },
  ]);
  const res = await tool("reai_update_loan").handler({ id: 13, interestRateAnnual: 6 }, ctx);
  assert.equal(sent.length, 2);
  const body = sent[1].body;
  assert.equal(body.interestRateAnnual, 6, "the change has to be sent");
  for (const [field, value] of [
    ["description", "the original description"],
    ["maturityDate", "2030-08-08"],
    ["repaymentType", "annuity"],
    ["dayCountConvention", "thirty_360"],
    ["interestTreatment", "pay_separately"],
  ]) {
    assert.equal(body[field], value, `${field} must be carried back, or this PUT erases it`);
  }
  // The record answers with creditorId; the request needs counterpartyId. Without the translation the
  // merge would send no counterparty at all.
  assert.equal(body.counterpartyId, 78, "creditorId must be translated back into counterpartyId");
  assert.match(textOf(res), /written back unchanged/);
});

test("update refuses a perspective flip that would re-point the counterparty", async () => {
  // Two independent reasons a flip is refused, and they fire in this order. A bank_loan is
  // direction-locked, so it never reaches the counterparty question.
  const locked = ctxFor([{ status: 200, data: LOAN }]);
  const first = await tool("reai_update_loan").handler({ id: 13, perspective: "lender" }, locked.ctx);
  assert.equal(first.isError, true);
  assert.match(textOf(first), /bank_loan with perspective lender/);
  assert.equal(locked.sent.length, 1, "nothing may be written");

  // On a type that accepts both directions, the dangerous merge is the one that would SUCCEED:
  // perspective selects which table the id is read from, so carrying 78 over from a borrower loan
  // looks it up as a debtor instead — a different party if that id exists, a 404 if it does not.
  const both = { ...LOAN, loanType: "other" };
  const open = ctxFor([{ status: 200, data: both }]);
  const second = await tool("reai_update_loan").handler({ id: 13, perspective: "lender" }, open.ctx);
  assert.equal(second.isError, true);
  assert.match(textOf(second), /DEBTOR/);
  assert.equal(open.sent.length, 1, "nothing may be written");

  // With an explicit counterpartyId AND the accounts for the new classification it goes through. Both
  // are required, and by different guards: the counterparty because the id would mean another party,
  // the accounts because a perspective change changes which accounts the API would have derived.
  const ok = ctxFor([
    { status: 200, data: both },
    { status: 200, data: { ...both, perspective: "lender", debtorId: 16, creditorId: null } },
  ]);
  const third = await tool("reai_update_loan").handler(
    {
      id: 13,
      perspective: "lender",
      counterpartyId: 16,
      principalAccountNumber: "1320",
      interestIncomeAccountNumber: "8050",
      accruedInterestAccountNumber: "1760",
    },
    ok.ctx,
  );
  assert.notEqual(third.isError, true, textOf(third));
  assert.equal(ok.sent[1].body.counterpartyId, 16);
});

test("restating the perspective it already has is not a change", async () => {
  // `{ perspective: "borrower", interestRateAnnual: 6 }` on a borrower loan is an idempotent
  // restatement — what a caller echoing a record back sends — and demanding a redundant counterpartyId
  // for a table change that is not happening was wrong.
  const { ctx, sent } = ctxFor([
    { status: 200, data: LOAN },
    { status: 200, data: { ...LOAN, interestRateAnnual: 6 } },
  ]);
  const res = await tool("reai_update_loan").handler({ id: 13, perspective: "borrower", interestRateAnnual: 6 }, ctx);
  assert.notEqual(res.isError, true, textOf(res));
  assert.equal(sent.length, 2, "the write should have happened");
});

test("reclassifying a loan will not carry the old classification's accounts", async () => {
  // The merge doing its job is the hazard here: accounts are derived at CREATION only, so moving a
  // bank_loan to owner_loan_to_company would keep 2220/8150 where the API would have derived
  // 2255/8159 — a loan filed against the wrong balance-sheet line by an edit that looks like a
  // relabelling. The tool cannot tell a derived number from a deliberate one, so it refuses and names
  // what the API would have picked.
  const { ctx, sent } = ctxFor([{ status: 200, data: LOAN }]);
  const res = await tool("reai_update_loan").handler({ id: 13, loanType: "owner_loan_to_company" }, ctx);
  assert.equal(res.isError, true);
  assert.match(textOf(res), /2255/, "the refusal must name the accounts the API would derive");
  assert.match(textOf(res), /8159/);
  assert.match(textOf(res), /2950/);
  assert.equal(sent.length, 1, "nothing may be written");

  // Supplying any account field is the caller taking the decision, so it proceeds.
  const ok = ctxFor([
    { status: 200, data: LOAN },
    { status: 200, data: { ...LOAN, loanType: "owner_loan_to_company", principalAccountNumber: "2255" } },
  ]);
  const second = await ok.ctx
    ? await tool("reai_update_loan").handler(
        { id: 13, loanType: "owner_loan_to_company", principalAccountNumber: "2255", interestExpenseAccountNumber: "8159" },
        ok.ctx,
      )
    : undefined;
  assert.notEqual(second.isError, true, textOf(second));
  assert.equal(ok.sent[1].body.principalAccountNumber, "2255");
});

test("reclassifying into a related-party type sets relatedParty, as create does", async () => {
  // Reachable by an edit rather than a creation, which is how it bypassed the create-side inference:
  // change a bank_loan to intercompany and the stored `false` was carried into the write, leaving note
  // disclosure understating a related party.
  const { ctx, sent } = ctxFor([
    { status: 200, data: LOAN },
    { status: 200, data: { ...LOAN, loanType: "intercompany", relatedParty: true } },
  ]);
  const res = await tool("reai_update_loan").handler(
    { id: 13, loanType: "intercompany", principalAccountNumber: "2260" },
    ctx,
  );
  assert.notEqual(res.isError, true, textOf(res));
  assert.equal(sent[1].body.relatedParty, true, "the API does not infer this — measured");
  assert.match(textOf(res), /relatedParty was set to true/);

  // And an explicit false still wins: the inference must not overrule the caller.
  const explicit = ctxFor([
    { status: 200, data: LOAN },
    { status: 200, data: { ...LOAN, loanType: "intercompany", relatedParty: false } },
  ]);
  await tool("reai_update_loan").handler(
    { id: 13, loanType: "intercompany", relatedParty: false, principalAccountNumber: "2260" },
    explicit.ctx,
  );
  assert.equal(explicit.sent[1].body.relatedParty, false);
});

test("a loan's bank association can be detached", async () => {
  // LoanReq permits companyBankId: null, and omission means "keep" under the merge — so without a
  // nullable argument the supported edit was unreachable.
  const withBank = { ...LOAN, companyBankId: 99 };
  const { ctx, sent } = ctxFor([
    { status: 200, data: withBank },
    { status: 200, data: { ...withBank, companyBankId: null } },
  ]);
  const res = await tool("reai_update_loan").handler({ id: 13, companyBankId: null }, ctx);
  assert.notEqual(res.isError, true, textOf(res));
  assert.equal(sent[1].body.companyBankId, null);
});

test("the local filter searches the description it promises to search", async () => {
  const rows = [
    { ...LOAN, id: 1, reference: "A-1", description: "refinancing the warehouse" },
    { ...LOAN, id: 2, reference: "B-2", description: "car" },
  ];
  const { ctx } = ctxFor([{ status: 200, data: rows }]);
  const res = await tool("reai_list_loans").handler({ query: "warehouse" }, ctx);
  assert.match(textOf(res), /1 loan\(s\)/);
  assert.match(textOf(res), /A-1/);
  assert.doesNotMatch(textOf(res), /B-2/);
});

test("the update tool declares the read it performs", () => {
  // The handler always GETs before it PUTs. Declaring only the write understates what the tool
  // touches, and the merge-tool invariant finds read-merge-write tools by exactly this pair.
  const paths = tool("reai_update_loan").apiPaths ?? [];
  assert.ok(paths.some(([m, p]) => m === "GET" && p === "/api/loans/{id}"), "the pre-read must be declared");
  assert.ok(paths.some(([m]) => m === "PUT"));
});

test("the loanType and perspective pair is checked before anything is sent", async () => {
  // Measured for all twelve combinations: four of the six types are direction-locked and the API
  // refuses the rest with `400 "Lånetypen er ikke gyldig for valgt låneperspektiv"` — a Norwegian
  // sentence about a rule the spec never states.
  const attempt = async (loanType, perspective) => {
    const { ctx, sent } = ctxFor([]);
    const res = await tool("reai_create_loan").handler(
      {
        reference: "X",
        loanType,
        perspective,
        counterpartyId: 1,
        currency: "NOK",
        principalAmount: 1000,
        interestRateAnnual: 1,
        disbursementDate: "2026-08-08",
        repaymentType: "bullet",
      },
      ctx,
    );
    return { res, sent };
  };

  for (const [loanType, perspective] of [
    ["bank_loan", "lender"],
    ["owner_loan_to_company", "lender"],
    ["company_loan_to_owner", "borrower"],
    ["company_loan_to_employee", "borrower"],
  ]) {
    const { res, sent } = await attempt(loanType, perspective);
    assert.equal(res.isError, true, `${loanType}/${perspective} should be refused`);
    assert.equal(sent.length, 0, `${loanType}/${perspective} must not reach the API`);
    assert.match(textOf(res), /Nothing was sent/);
  }

  // And the pairs that are real must not be blocked. These reach the client, which is all this
  // asserts — the canned queue is empty, so the call throws once it gets there.
  for (const [loanType, perspective] of [
    ["bank_loan", "borrower"],
    ["company_loan_to_owner", "lender"],
    ["intercompany", "borrower"],
    ["intercompany", "lender"],
    ["other", "borrower"],
    ["other", "lender"],
  ]) {
    await assert.rejects(
      () => attempt(loanType, perspective).then((r) => (r.sent.length ? Promise.reject(new Error("sent")) : r)),
      /no canned response|sent/,
      `${loanType}/${perspective} is a valid pair and must not be refused locally`,
    );
  }
});

test("update will not write when the record cannot be read", async () => {
  // A replacement PUT with no base is the destruction the merge exists to prevent.
  const { ctx, sent } = ctxFor([{ status: 200, data: "not a record" }]);
  const res = await tool("reai_update_loan").handler({ id: 13, reference: "X" }, ctx);
  assert.equal(res.isError, true);
  assert.match(textOf(res), /REPLACES/);
  assert.equal(sent.length, 1);
});

test("create infers relatedParty for a loan that is one by construction", async () => {
  const { ctx, sent } = ctxFor([{ status: 201, data: { ...LOAN, id: 15, loanType: "company_loan_to_owner", relatedParty: true } }]);
  const res = await tool("reai_create_loan").handler(
    {
      reference: "OWNER-1",
      loanType: "company_loan_to_owner",
      perspective: "lender",
      counterpartyId: 16,
      currency: "NOK",
      principalAmount: 25000,
      interestRateAnnual: 3,
      disbursementDate: "2026-08-08",
      repaymentType: "bullet",
    },
    ctx,
  );
  assert.equal(sent[0].body.relatedParty, true, "the API stores false unless told — measured");
  assert.match(textOf(res), /relatedParty was set to true/);

  // An explicit false is respected: the inference must not overrule the caller.
  const explicit = ctxFor([{ status: 201, data: { ...LOAN, id: 16, loanType: "intercompany", relatedParty: false } }]);
  await tool("reai_create_loan").handler(
    {
      reference: "IC-1",
      loanType: "intercompany",
      perspective: "borrower",
      counterpartyId: 78,
      currency: "NOK",
      principalAmount: 1000,
      interestRateAnnual: 0,
      disbursementDate: "2026-08-08",
      repaymentType: "bullet",
      relatedParty: false,
    },
    explicit.ctx,
  );
  assert.equal(explicit.sent[0].body.relatedParty, false);
});

test("create reports the accounts the API derived, since nothing re-derives them", async () => {
  const { ctx } = ctxFor([{ status: 201, data: LOAN }]);
  const res = await tool("reai_create_loan").handler(
    {
      reference: "L-1",
      loanType: "bank_loan",
      perspective: "borrower",
      counterpartyId: 78,
      currency: "NOK",
      principalAmount: 100000,
      interestRateAnnual: 5.5,
      disbursementDate: "2026-08-08",
      repaymentType: "bullet",
    },
    ctx,
  );
  const text = textOf(res);
  assert.match(text, /2220/);
  assert.match(text, /8150/);
  assert.match(text, /2950/);
  assert.match(text, /never\s+re-derived/);
  assert.match(text, /CREDITOR id because perspective is borrower/);
});

/**
 * The notes and the error translations, which an independent review found survived deliberate mutation
 * of `src/` — twelve behaviours the module doc argues for and nothing pinned. The matrix and the merge
 * were genuinely covered; everything that only *speaks* to the caller was not, which is the half a
 * reader of the tool descriptions relies on most.
 */
const LENDER_LOAN = {
  ...LOAN,
  id: 15,
  loanType: "company_loan_to_owner",
  perspective: "lender",
  counterpartyName: "Kari Nordmann",
  counterpartyType: "owner",
  creditorId: null,
  debtorId: 16,
  principalAccountNumber: "1370",
  interestExpenseAccountNumber: null,
  interestIncomeAccountNumber: "8050",
  accruedInterestAccountNumber: "1760",
};

test("a lender loan is judged against the INCOME account, not the expense one", async () => {
  // `missingInterestAccounts` branches on perspective, and no test drove a lender loan through either
  // read tool — so hardcoding `wantsExpense = true` passed the whole suite. A lender loan legitimately
  // has no expense account; complaining about it would be a false alarm on every receivable.
  const clean = ctxFor([{ status: 200, data: LENDER_LOAN }]);
  assert.doesNotMatch(textOf(await tool("reai_get_loan").handler({ id: 15 }, clean.ctx)), /INCONSISTENT/);

  // And when the income account IS missing, that is what gets named.
  const broken = ctxFor([{ status: 200, data: { ...LENDER_LOAN, interestIncomeAccountNumber: null } }]);
  const text = textOf(await tool("reai_get_loan").handler({ id: 15 }, broken.ctx));
  assert.match(text, /INCONSISTENT/);
  // The SENTENCE, not the whole result: the record is echoed below it and names every field it has.
  const sentence = /INCONSISTENT[^\n]*/.exec(text)?.[0] ?? "";
  assert.match(sentence, /interestIncomeAccountNumber/);
  assert.doesNotMatch(sentence, /interestExpenseAccountNumber/, "a lender loan has no expense account to miss");
});

test("accrue is judged like pay_separately, and capitalize is exempt", async () => {
  // Both post interest somewhere other than the principal, so both need the accounts. capitalize adds
  // interest to the principal and legitimately has neither — flagging it would train callers to ignore
  // the warning.
  const accrue = ctxFor([{ status: 200, data: { ...LOAN, interestTreatment: "accrue", interestExpenseAccountNumber: null, accruedInterestAccountNumber: null } }]);
  assert.match(textOf(await tool("reai_get_loan").handler({ id: 13 }, accrue.ctx)), /INCONSISTENT/);

  const capitalize = ctxFor([{ status: 200, data: { ...LOAN, interestTreatment: "capitalize", interestExpenseAccountNumber: null, accruedInterestAccountNumber: null } }]);
  assert.doesNotMatch(textOf(await tool("reai_get_loan").handler({ id: 13 }, capitalize.ctx)), /INCONSISTENT/);
});

test("the list names every loan that cannot post its interest", async () => {
  // The whole INCONSISTENT branch of reai_list_loans was untested: `contradictory.length > 99` passed.
  const rows = [
    { ...LOAN, id: 1 },
    { ...LOAN, id: 2, interestExpenseAccountNumber: null, accruedInterestAccountNumber: null },
  ];
  const { ctx } = ctxFor([{ status: 200, data: rows }]);
  const text = textOf(await tool("reai_list_loans").handler({}, ctx));
  assert.match(text, /1 loan\(s\) claim an interest treatment they have no account for/);
  assert.match(text, /2 \(pay_separately/, "the offending loan must be named");
});

test("the wrong-table 404 is translated, in both write tools", async () => {
  // The failure this whole module is about, and it was reaching callers raw: a 404 from a POST reads as
  // "endpoint or record not found", not "your id is in the other id space".
  const err = new ReaiApiError({
    status: 404,
    method: "POST",
    path: "/api/loans",
    rawBody: "Creditor with id=78 not found",
  });
  const throwing = {
    config: { boundTenantId: undefined, defaultTenantId: 2783, writeMode: "full", allowExternalSend: false },
    session: {},
    client: { request: async () => { throw err; }, deepLink: () => "" },
  };
  const created = await tool("reai_create_loan").handler(
    {
      reference: "X", loanType: "bank_loan", perspective: "borrower", counterpartyId: 78,
      currency: "NOK", principalAmount: 1000, interestRateAnnual: 1,
      disbursementDate: "2026-08-08", repaymentType: "bullet",
    },
    throwing,
  );
  assert.equal(created.isError, true);
  assert.match(textOf(created), /not a creditor/i);
  assert.match(textOf(created), /perspective: "lender"/, "it must name the perspective that would fit");

  // The same on update, where a 404 after a successful GET can only be the counterparty.
  let call = 0;
  const updating = {
    ...throwing,
    client: {
      request: async () => { if (call++ === 0) return { status: 200, data: LOAN }; throw err; },
      deepLink: () => "",
    },
  };
  const updated = await tool("reai_update_loan").handler({ id: 13, counterpartyId: 78 }, updating);
  assert.equal(updated.isError, true);
  assert.match(textOf(updated), /not a creditor/i);
});

test("the duplicate reference is translated, in both write tools", async () => {
  // One of the four headline claims, and it had no coverage at all in either tool.
  const err = new ReaiApiError({
    status: 400,
    method: "POST",
    path: "/api/loans",
    rawBody: '{"detail":"Lån med referanse X finnes allerede."}',
  });
  const base = {
    config: { boundTenantId: undefined, defaultTenantId: 2783, writeMode: "full", allowExternalSend: false },
    session: {},
  };
  const create = await tool("reai_create_loan").handler(
    {
      reference: "X", loanType: "bank_loan", perspective: "borrower", counterpartyId: 78,
      currency: "NOK", principalAmount: 1000, interestRateAnnual: 1,
      disbursementDate: "2026-08-08", repaymentType: "bullet",
    },
    { ...base, client: { request: async () => { throw err; }, deepLink: () => "" } },
  );
  assert.equal(create.isError, true);
  assert.match(textOf(create), /already exists/);
  assert.match(textOf(create), /unique/);

  let n = 0;
  const update = await tool("reai_update_loan").handler(
    { id: 13, reference: "X" },
    { ...base, client: { request: async () => { if (n++ === 0) return { status: 200, data: LOAN }; throw err; }, deepLink: () => "" } },
  );
  assert.equal(update.isError, true, "the curated PUT was worse informed than reai_request");
  assert.match(textOf(update), /already exists/);
});

test("every inherently related loan type is inferred, not just one", async () => {
  // INHERENTLY_RELATED could be cut to a single entry and the suite still passed, so three of the four
  // types were only claimed.
  for (const loanType of ["owner_loan_to_company", "company_loan_to_owner", "company_loan_to_employee", "intercompany"]) {
    const perspective = ALLOWED_FOR[loanType];
    const { ctx, sent } = ctxFor([{ status: 201, data: { ...LOAN, loanType, perspective, relatedParty: true } }]);
    await tool("reai_create_loan").handler(
      {
        reference: "R-" + loanType, loanType, perspective, counterpartyId: 1,
        currency: "NOK", principalAmount: 1000, interestRateAnnual: 1,
        disbursementDate: "2026-08-08", repaymentType: "bullet",
      },
      ctx,
    );
    assert.equal(sent[0].body.relatedParty, true, `${loanType} is a related party by construction`);
  }
  // bank_loan is not one, and must not be tampered with.
  const arms = ctxFor([{ status: 201, data: LOAN }]);
  await tool("reai_create_loan").handler(
    {
      reference: "B-1", loanType: "bank_loan", perspective: "borrower", counterpartyId: 1,
      currency: "NOK", principalAmount: 1000, interestRateAnnual: 1,
      disbursementDate: "2026-08-08", repaymentType: "bullet",
    },
    arms.ctx,
  );
  assert.equal(arms.sent[0].body.relatedParty, undefined, "a bank loan must be left alone");
});

test("create warns when the API stored relatedParty false on a related-party type", async () => {
  // The caller can pass `false` deliberately; the record then disagrees with what note disclosure
  // needs, so the answer says so rather than staying silent.
  const { ctx } = ctxFor([{ status: 201, data: { ...LOAN, loanType: "intercompany", relatedParty: false } }]);
  const res = await tool("reai_create_loan").handler(
    {
      reference: "IC-2", loanType: "intercompany", perspective: "borrower", counterpartyId: 1,
      currency: "NOK", principalAmount: 1000, interestRateAnnual: 1,
      disbursementDate: "2026-08-08", repaymentType: "bullet", relatedParty: false,
    },
    ctx,
  );
  assert.match(textOf(res), /WARNING/);
  assert.match(textOf(res), /relatedParty is false/);
});

test("an update with no changes writes nothing", async () => {
  const { ctx, sent } = ctxFor([{ status: 200, data: LOAN }]);
  const res = await tool("reai_update_loan").handler({ id: 13 }, ctx);
  assert.equal(res.isError, true);
  assert.match(textOf(res), /No changes were given/);
  assert.equal(sent.length, 1);
});

test("a record with no perspective is not assumed to be a borrower loan", async () => {
  // The note read `perspective === "lender" ? … : "because perspective is borrower"`, so an absent
  // value produced a confident false statement about which id space applied.
  const { perspective, ...noPerspective } = LOAN;
  const { ctx } = ctxFor([{ status: 200, data: noPerspective }]);
  const text = textOf(await tool("reai_get_loan").handler({ id: 13 }, ctx));
  assert.match(text, /does not say which perspective/);
  assert.doesNotMatch(text, /because perspective is borrower/);
});

test("both loan quirks are scoped to the right methods and statuses", async () => {
  // PR #97 fixed a quirk that explained every failure on its endpoint as one specific defect. Nothing
  // pinned that fix for these entries, so a later edit could reintroduce it silently.
  const { quirksFor, QUIRKS } = await import("../dist/reai/quirks.js");
  const pair = QUIRKS.find((q) => q.id === "loan-type-and-perspective-are-constrained-pairs");
  assert.deepEqual(pair.statuses, [400], "the pair rule explains one status only");
  assert.deepEqual([...pair.methods].sort(), ["POST", "PUT"]);

  const omission = QUIRKS.find((q) => q.id === "loan-interest-accounts-are-cleared-by-omission");
  assert.equal(omission.statuses, undefined, "a success-path hazard is not keyed to a status");
  assert.deepEqual(omission.methods, ["PUT"]);

  // A read must attract neither.
  assert.deepEqual(quirksFor("GET", "/api/loans").map((q) => q.id), []);
  assert.deepEqual(quirksFor("GET", "/api/loans/{id}").map((q) => q.id), []);
});

/**
 * The counterparties, which are the reason the lender half of the loan matrix was unusable: every
 * `company_loan_to_owner`, every `company_loan_to_employee` and the lender side of `intercompany` and
 * `other` need a DEBTOR id, and nothing listed or created one.
 */
test("the counterparty tools live in the loans toolset, not purchase", async () => {
  const { TOOL_GROUPS } = await import("../dist/server.js");
  const names = TOOL_GROUPS.loans.map((t) => t.name);
  for (const name of [
    "reai_list_creditors",
    "reai_create_creditor",
    "reai_update_creditor",
    "reai_delete_creditor",
    "reai_list_debtors",
    "reai_create_debtor",
    "reai_update_debtor",
    "reai_delete_debtor",
  ]) {
    assert.ok(names.includes(name), `${name} belongs with the loans it exists for`);
  }
  // The point of the move: enabling only `loans` must be a workable configuration.
  assert.ok(
    !TOOL_GROUPS.purchase.some((t) => /creditor|debtor/.test(t.name)),
    "a counterparty tool left behind in purchase defeats the move",
  );
});

test("a debtor list warns when a name identifies more than one record", async () => {
  // Measured: two debtors with the same name were created as ids 19 and 20 without complaint. An agent
  // told to use "the debtor called X" needs to know when that phrase does not name a record.
  const { ctx } = ctxFor([
    { status: 200, data: [
      { id: 19, name: "Kari Nordmann" },
      { id: 20, name: "Kari Nordmann" },
      { id: 21, name: "Ola Nordmann" },
    ] },
  ]);
  const text = textOf(await tool("reai_list_debtors").handler({}, ctx));
  assert.match(text, /3 debtor\(s\)/);
  assert.match(text, /appear more than once/);
  assert.match(text, /Kari Nordmann/);
  assert.match(text, /choose by id/);

  // And it stays quiet when every name is distinct.
  const distinct = ctxFor([{ status: 200, data: [{ id: 1, name: "A" }, { id: 2, name: "B" }] }]);
  assert.doesNotMatch(textOf(await tool("reai_list_debtors").handler({}, distinct.ctx)), /more than once/);
});

test("creating a creditor without an account says the repayment has nowhere to go", async () => {
  const { ctx, sent } = ctxFor([{ status: 201, data: { id: 91, name: "A Bank AS", bankAccountNumber: null } }]);
  const res = await tool("reai_create_creditor").handler({ name: "A Bank AS" }, ctx);
  assert.equal(sent[0].path, "/api/creditors");
  assert.match(textOf(res), /no destination yet/i);
  assert.match(textOf(res), /perspective "borrower"/);

  // With an account it does not nag. (The account number here is a value this repository made up; it
  // fails the Norwegian mod-11 check, so it is nobody's account.)
  const withAccount = ctxFor([{ status: 201, data: { id: 92, name: "A Bank AS", bankAccountNumber: "15062099533" } }]);
  const ok = await tool("reai_create_creditor").handler({ name: "A Bank AS", bankAccountNumber: "15062099533" }, withAccount.ctx);
  assert.doesNotMatch(textOf(ok), /no destination/i);

  // The case that distinguishes a note about the RESPONSE from one about the request: an account was
  // sent and the response carries none. Keying the branch on the argument makes this silent, which is a
  // tool reporting an outcome the API never confirmed.
  const mismatch = ctxFor([{ status: 201, data: { id: 93, name: "A Bank AS" } }]);
  const warned = await tool("reai_create_creditor").handler(
    { name: "A Bank AS", bankAccountNumber: "15062099533" },
    mismatch.ctx,
  );
  assert.match(textOf(warned), /An account was sent but the response carries none/);
  assert.match(textOf(warned), /NOT established/);
});

test("creating a debtor points at the perspective its id belongs to", async () => {
  const { ctx, sent } = ctxFor([{ status: 201, data: { id: 19, name: "Kari Nordmann" } }]);
  const res = await tool("reai_create_debtor").handler({ name: "Kari Nordmann" }, ctx);
  assert.deepEqual(sent[0].body, { name: "Kari Nordmann" }, "a debtor has no other field");
  assert.match(textOf(res), /perspective "lender"/);
  // The trap worth naming at the moment the id is handed over.
  assert.match(textOf(res), /looked up among CREDITORS and answers 404/);
});

test("deleting a referenced counterparty explains the ordering, both sides", async () => {
  // Measured: 409 "Cannot delete creditor that is referenced by one or more loans". The message names
  // the constraint and not the way out, which is an ordering the caller cannot infer from a 409.
  for (const [toolName, kind, field] of [
    ["reai_delete_creditor", "Creditor", "creditorId"],
    ["reai_delete_debtor", "Debtor", "debtorId"],
  ]) {
    const err = new ReaiApiError({
      status: 409,
      method: "DELETE",
      path: "/api/creditors/91",
      rawBody: '{"detail":"Cannot delete creditor that is referenced by one or more loans"}',
    });
    const ctx = {
      config: { boundTenantId: undefined, defaultTenantId: 2783, writeMode: "full", allowExternalSend: false },
      session: {},
      client: { request: async () => { throw err; }, deepLink: () => "" },
    };
    const res = await tool(toolName).handler({ id: 91 }, ctx);
    assert.equal(res.isError, true);
    assert.match(textOf(res), new RegExp(`${kind} 91 is still named by at least one loan`));
    assert.match(textOf(res), /Delete the loans first/);
    assert.match(textOf(res), new RegExp(field));
  }
});

test("an unrelated 409 is not explained as a loan reference", async () => {
  // The PR #97 lesson: a confident wrong explanation is worse than none. Anything else must rethrow.
  const err = new ReaiApiError({
    status: 409,
    method: "DELETE",
    path: "/api/creditors/91",
    rawBody: '{"detail":"Some other conflict entirely"}',
  });
  const ctx = {
    config: { boundTenantId: undefined, defaultTenantId: 2783, writeMode: "full", allowExternalSend: false },
    session: {},
    client: { request: async () => { throw err; }, deepLink: () => "" },
  };
  await assert.rejects(() => tool("reai_delete_creditor").handler({ id: 91 }, ctx), /Some other conflict/);
});

test("the creditor account is payment routing, and the tool says so", async () => {
  // reai_create_creditor is `reversible`, so it is offered on a default server — but supplying
  // bankAccountNumber escalates it to irreversible through the payment-routing gate, and the call is
  // then refused before the handler runs. That is the right classification (an account number is where
  // money ends up) and the wrong thing to leave unsaid: the first version of the description told the
  // caller to "set it here if you know it", which is a use the default mode rejects.
  const { curatedArgsEscalate } = await import("../dist/policy.js");
  const create = tool("reai_create_creditor");
  assert.equal(create.risk, "reversible");

  const escalated = curatedArgsEscalate(create.apiPaths ?? [], { name: "A Bank AS", bankAccountNumber: "15062099533" });
  assert.equal(escalated?.risk, "irreversible", "an account number must escalate — it is a payment destination");
  assert.deepEqual(escalated?.fields, ["bankAccountNumber"]);
  assert.equal(
    curatedArgsEscalate(create.apiPaths ?? [], { name: "A Bank AS" }),
    undefined,
    "a creditor with no account routes no payment",
  );

  // The description has to carry it, or the tool is offered for a use that fails.
  assert.match(create.description, /payment routing/i);
  assert.match(create.description, /reversible/);
});

test("the loan tools point at the counterparty tools that now exist", () => {
  // #98 said to use reai_request because nothing curated existed. This PR made that false, and a
  // description telling an agent to reach past a tool that exists is the same class of error as naming
  // a tool that does not.
  const create = tool("reai_create_loan").description;
  assert.doesNotMatch(create, /reai_request on \/api\/creditors/);
  assert.match(create, /reai_create_creditor/);
  assert.match(create, /reai_create_debtor/);
  for (const name of ["reai_create_creditor", "reai_create_debtor", "reai_list_creditors", "reai_list_debtors"]) {
    assert.ok(create.includes(name), `${name} is how a caller gets a counterparty id`);
  }
});

/**
 * What the counterparty tools actually SEND. Review mutated `src/` and found three survivors here, the
 * worst being `reai_update_debtor` sending `body: {}` — the rename fails upstream and the tool still
 * reports "Debtor 19 renamed to …", because the note was built from the argument instead of the
 * response. Two others wrote to `/api/creditors/{id}` from the debtor tools and nothing noticed, because
 * the only tests touching those paths stubbed the client to throw and never asserted where it went.
 */
test("the counterparty writes go to the path and body they claim", async () => {
  const update = ctxFor([{ status: 200, data: { id: 19, name: "Renamed AS" } }]);
  const res = await tool("reai_update_debtor").handler({ id: 19, name: "Renamed AS" }, update.ctx);
  assert.equal(update.sent[0].method, "PUT");
  assert.equal(update.sent[0].path, "/api/debtors/19", "a debtor rename must not write to a creditor");
  assert.deepEqual(update.sent[0].body, { name: "Renamed AS" }, "an empty body would fail upstream and still read as success");
  assert.match(textOf(res), /is now "Renamed AS"/);

  const delDebtor = ctxFor([{ status: 204, data: undefined }]);
  await tool("reai_delete_debtor").handler({ id: 19 }, delDebtor.ctx);
  assert.equal(delDebtor.sent[0].method, "DELETE");
  assert.equal(delDebtor.sent[0].path, "/api/debtors/19");

  const delCreditor = ctxFor([{ status: 204, data: undefined }]);
  await tool("reai_delete_creditor").handler({ id: 91 }, delCreditor.ctx);
  assert.equal(delCreditor.sent[0].path, "/api/creditors/91");

  const createDebtor = ctxFor([{ status: 201, data: { id: 20, name: "New AS" } }]);
  await tool("reai_create_debtor").handler({ name: "New AS" }, createDebtor.ctx);
  assert.equal(createDebtor.sent[0].path, "/api/debtors");
});

test("a rename reports what was stored, not what was asked for", async () => {
  // ReAI normalises names elsewhere in this API — suppliers come back title-cased — so echoing the
  // argument can report a value that was never written.
  const normalised = ctxFor([{ status: 200, data: { id: 19, name: "Kari Nordmann" } }]);
  const res = await tool("reai_update_debtor").handler({ id: 19, name: "kari nordmann" }, normalised.ctx);
  assert.match(textOf(res), /stored something other than/);
  assert.match(textOf(res), /"Kari Nordmann"/);

  // And a response with no name at all must not be reported as a confirmed rename.
  const silent = ctxFor([{ status: 200, data: {} }]);
  const quiet = await tool("reai_update_debtor").handler({ id: 19, name: "X" }, silent.ctx);
  assert.match(textOf(quiet), /unconfirmed/);
});

test("duplicate names are caught however they differ in case or spacing", async () => {
  // The collisions that actually cause the mistake. Comparing raw strings missed all of these.
  for (const [label, rows] of [
    ["case", [{ id: 1, name: "Kari Nordmann" }, { id: 2, name: "kari nordmann" }]],
    ["trailing space", [{ id: 1, name: "Kari" }, { id: 2, name: "Kari " }]],
    ["both", [{ id: 1, name: " KARI " }, { id: 2, name: "kari" }]],
  ]) {
    const { ctx } = ctxFor([{ status: 200, data: rows }]);
    const text = textOf(await tool("reai_list_debtors").handler({}, ctx));
    assert.match(text, /appear more than once/, `${label} collision missed`);
    assert.match(text, /1 name\(s\)/, `${label}: the count must be of names, not rows`);
  }

  // Unnamed rows are not duplicates of each other, and a null row must not throw out of a read tool.
  const odd = ctxFor([{ status: 200, data: [null, { id: 1 }, { id: 2, name: "" }, { id: 3, name: "A" }] }]);
  const text = textOf(await tool("reai_list_debtors").handler({}, odd.ctx));
  assert.match(text, /4 debtor\(s\)/);
  assert.doesNotMatch(text, /appear more than once/);
});

test("a 409 on creating a counterparty is reported, not diagnosed", async () => {
  // Both creates document a 409 and the document does not say what it is for, while measurement says
  // duplicate names are accepted. So the tool must surface the API's words without inventing a cause.
  for (const [toolName, kind] of [["reai_create_creditor", "creditor"], ["reai_create_debtor", "debtor"]]) {
    const err = new ReaiApiError({
      status: 409,
      method: "POST",
      path: `/api/${kind}s`,
      rawBody: '{"detail":"Some conflict the document does not explain"}',
      problem: { detail: "Some conflict the document does not explain" },
    });
    const ctx = {
      config: { boundTenantId: undefined, defaultTenantId: 2783, writeMode: "full", allowExternalSend: false },
      session: {},
      client: { request: async () => { throw err; }, deepLink: () => "" },
    };
    const res = await tool(toolName).handler({ name: "X" }, ctx);
    assert.equal(res.isError, true);
    assert.match(textOf(res), /409 conflict/);
    assert.match(textOf(res), /Some conflict the document does not explain/, "the API's own words must survive");
    assert.match(textOf(res), /probably not it/, "it must not assert a cause it cannot know");
  }
});
