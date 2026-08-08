// Loans, and specifically the three things the API does that a caller cannot guess. Every fact
// asserted here was measured against the write test tenant before it was written down; the module
// doc in src/tools/loans.ts records the measurements themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registeredTools } from "../dist/server.js";
import { classifyRequest } from "../dist/policy.js";

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
