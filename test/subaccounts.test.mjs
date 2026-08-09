import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { subAccountTools } from "../dist/tools/subaccounts.js";
import { allTools, registeredTools } from "../dist/server.js";
import { classifyRequest } from "../dist/policy.js";
import { quirksFor } from "../dist/reai/quirks.js";

const tool = (name) => {
  const found = [...subAccountTools, ...allTools].find((t) => t.name === name);
  assert.ok(found, `${name} is not registered`);
  return found;
};

async function run(name, args, responder, { status = 200 } = {}) {
  const calls = [];
  const validated = z.object(tool(name).inputSchema).parse({ tenantId: 2783, ...args });
  const result = await tool(name).handler(validated, {
    client: {
      request: async (req) => {
        calls.push(req);
        return { data: responder(req), status };
      },
      deepLink: () => "link",
    },
    config: { writeMode: "full", tenantId: 2783, allowExternalSend: false },
    session: {},
  });
  return { calls, result, text: result.content.find((c) => c.type === "text").text };
}

const SUBS = [
  { id: 6229, accountNumber: "1300", name: "Default" },
  { id: 6231, accountNumber: "1320", name: "Default" },
  { id: 4505, accountNumber: "1579", name: "Shopify sales" },
];

test("the four sub-account tools are registered with the right risks", () => {
  const registered = new Set(registeredTools.map((t) => t.name));
  for (const [name, risk] of [
    ["reai_list_sub_accounts", "read"],
    ["reai_sub_accounts_for_account", "read"],
    ["reai_create_sub_account", "irreversible"],
    ["reai_rename_sub_account", "reversible"],
  ]) {
    assert.ok(registered.has(name), name);
    assert.equal(tool(name).risk, risk, name);
  }
  // Creating one cannot be undone — there is no DELETE — so it must not sit in the default mode.
  assert.equal(classifyRequest("POST", "/api/general-sub-accounts"), "irreversible");
});

// The reason this toolset exists: reai_create_voucher accepted subAccountId with no way to find a
// valid value, and described as optional a field the API demands for exactly those accounts.
test("a posting to an account with sub-accounts is refused locally, with the choices", async () => {
  const { calls, result, text } = await run(
    "reai_create_voucher",
    {
      date: "2026-08-08",
      description: "Zz",
      postings: [
        { accountNumber: "1320", amount: 50 },
        { accountNumber: "3000", amount: -50 },
      ],
    },
    (req) => (req.method === "GET" ? SUBS : { id: 1 }),
  );
  // Deduped: the dimension pass now makes two kinds of read (sub-accounts, then the chart per account).
  // What matters is that NO write went out.
  assert.deepEqual([...new Set(calls.map((c) => c.method))], ["GET"], "no voucher may be sent");
  assert.equal(result.isError, true);
  assert.match(text, /line 1, account 1320 → subAccountId 6231 \(Default\)/);
  assert.match(text, /even when the only one is called "Default"/);
  assert.match(text, /Nothing was sent/);
  assert.match(text, /reai_sub_accounts_for_account/, "the sub-account lookup tool must be offered");
});

test("a posting that supplies one, or is on an account without any, goes through", async () => {
  const supplied = await run(
    "reai_create_voucher",
    {
      date: "2026-08-08",
      description: "Zz",
      postings: [
        { accountNumber: "1320", amount: 50, subAccountId: 6231 },
        { accountNumber: "3000", amount: -50 },
      ],
    },
    (req) => (req.method === "GET" ? SUBS : { id: 7, number: "MV1-2026" }),
  );
  assert.equal(supplied.result.isError, undefined);
  const post = supplied.calls.find((c) => c.method === "POST");
  assert.equal(post.body.postings[0].subAccountId, 6231);
  // 3000 has no sub-accounts, so it needs nothing.
  assert.equal(post.body.postings[1].subAccountId, undefined);
});

test("a failed sub-account lookup does NOT block the voucher", async () => {
  // The spec has understated requirements before, and refusing a ledger write because a helper read
  // failed would be the check doing harm. The API stays the authority.
  const { calls, result } = await run(
    "reai_create_voucher",
    {
      date: "2026-08-08",
      description: "Zz",
      postings: [
        { accountNumber: "1320", amount: 50 },
        { accountNumber: "3000", amount: -50 },
      ],
    },
    (req) => {
      if (req.method === "GET") throw new Error("sub-account list unavailable");
      return { id: 7 };
    },
  );
  assert.equal(result.isError, undefined);
  assert.ok(calls.some((c) => c.method === "POST"), "the voucher must still be sent");
});

test("a non-list sub-account response is not read as 'no account needs one'", async () => {
  for (const data of [null, {}, { items: SUBS }]) {
    const { calls } = await run(
      "reai_create_voucher",
      {
        date: "2026-08-08",
        description: "Zz",
        postings: [
          { accountNumber: "1320", amount: 50 },
          { accountNumber: "3000", amount: -50 },
        ],
      },
      (req) => (req.method === "GET" ? data : { id: 7 }),
    );
    // Unreadable means the API decides, not that the requirement is absent — the voucher is sent
    // and the API's own 400 explains it.
    assert.ok(calls.some((c) => c.method === "POST"), JSON.stringify(data));
  }
});

test("the per-account tool says whether a subAccountId is required at all", async () => {
  const has = await run("reai_sub_accounts_for_account", { accountNumber: "1320" }, () => [SUBS[1]]);
  assert.match(has.text, /MUST carry one of these subAccountId values: 6231 \(Default\)/);

  const none = await run("reai_sub_accounts_for_account", { accountNumber: "3000" }, () => []);
  assert.match(none.text, /Account 3000 has no sub-accounts, so its postings need no subAccountId/);
});

test("creating the FIRST sub-account on an account says it changes that account's rules", async () => {
  const first = await run(
    "reai_create_sub_account",
    { accountNumber: "3000", name: "Zz Part" },
    (req) => (req.method === "GET" ? [] : { id: 9999, accountNumber: "3000", name: "Zz Part" }),
  );
  assert.deepEqual(first.calls.map((c) => c.method), ["GET", "POST"]);
  assert.match(first.text, /This is the FIRST sub-account on 3000/);
  assert.match(first.text, /will start failing/);
  assert.match(first.text, /no DELETE for this resource, so it is permanent/);

  const later = await run(
    "reai_create_sub_account",
    { accountNumber: "1320", name: "Zz Part" },
    (req) => (req.method === "GET" ? [SUBS[1]] : { id: 9999 }),
  );
  assert.match(later.text, /already had 1, so its postings already required/);
  assert.ok(!/FIRST sub-account/.test(later.text));
});

test("an unreadable existing list is reported as unknown, not as 'nothing changed'", async () => {
  const { text } = await run(
    "reai_create_sub_account",
    { accountNumber: "3000", name: "Zz Part" },
    (req) => (req.method === "GET" ? { nope: true } : { id: 9999 }),
  );
  assert.match(text, /could not be read/);
  assert.ok(!/FIRST sub-account/.test(text));
});

test("the rename tool sends only the name, because accountNumber is rejected", async () => {
  const { calls } = await run("reai_rename_sub_account", { id: 6229, name: "Zz New" }, () => ({ id: 6229 }));
  assert.deepEqual(calls[0].body, { name: "Zz New" });
  assert.match(tool("reai_rename_sub_account").description, /Unknown field: accountNumber/);
});

test("both posting fields say they are conditionally required, and the quirks carry it", () => {
  const voucher = tool("reai_create_voucher");
  const element = voucher.inputSchema.postings._def.type;
  const posting = element._def.shape();
  for (const [field, needle] of [
    ["subAccountId", /må posteres med underkonto/],
    ["companyBankId", /må posteres med bankkonto/],
  ]) {
    assert.match(posting[field]._def.description, needle, field);
    assert.match(posting[field]._def.description, /REQUIRE[SD]/, field);
  }
  const q = quirksFor("POST", "/api/vouchers").map((x) => x.id);
  assert.ok(q.includes("some-accounts-demand-a-dimension"));
  assert.ok(
    quirksFor("PUT", "/api/general-sub-accounts/{id}")
      .map((x) => x.id)
      .includes("a-sub-account-cannot-be-removed"),
  );
});

// Review found four inconsistencies with care taken elsewhere in the same change, and two claims
// that were not true. These pin them.

test("the create tool's informational pre-read cannot block the create", async () => {
  const { calls, result, text } = await run(
    "reai_create_sub_account",
    { accountNumber: "3000", name: "Zz Part" },
    (req) => {
      if (req.method === "GET") throw new Error("selector unavailable");
      return { id: 9999, accountNumber: "3000", name: "Zz Part" };
    },
  );
  assert.equal(result.isError, undefined, "a failed helper read must not stop the write");
  assert.ok(calls.some((c) => c.method === "POST"));
  assert.match(text, /could not be read/);
});

test("both tools declare the GET they perform", () => {
  assert.deepEqual(tool("reai_create_sub_account").apiPaths, [
    ["GET", "/api/general-sub-accounts/accounts/{accountNumber}"],
    ["POST", "/api/general-sub-accounts"],
  ]);
  assert.ok(
    tool("reai_create_voucher").apiPaths.some(
      ([m, p]) => m === "GET" && p === "/api/general-sub-accounts",
    ),
  );
});

test("an account that cannot have sub-accounts is a successful answer, not an error", async () => {
  const { result, text } = await run("reai_sub_accounts_for_account", { accountNumber: "3000" }, () => {
    throw new Error('ReAI GET /api/general-sub-accounts/accounts/3000 failed with HTTP 400: accountNumber 3000 does not support general sub-accounts');
  });
  assert.equal(result.isError, undefined, "the documented third outcome is an answer");
  assert.match(text, /does not support general sub-accounts at all/);
  assert.match(text, /clear NO rather than a problem/);
  assert.match(text, /"supportsSubAccounts": false/);
});

test("any other failure from the selector still surfaces as a failure", async () => {
  await assert.rejects(
    () => run("reai_sub_accounts_for_account", { accountNumber: "3000" }, () => {
      throw new Error("HTTP 500: upstream exploded");
    }),
    /upstream exploded/,
  );
});

// The preflight lets the write through when its own lookup failed — so the API's Norwegian 400 has
// to be translated on the way back, which the original comment claimed happened via the quirk
// registry. It does not: server.ts turns a curated tool's thrown error into a plain tool error.
test("the API's dimension errors are explained even when the preflight could not run", async () => {
  for (const [message, needle] of [
    ["ReAI POST /api/vouchers failed with HTTP 400: Linje 1: Konto 1320 må posteres med underkonto.", /reai_sub_accounts_for_account/],
    ["ReAI POST /api/vouchers failed with HTTP 400: Linje 2: Konto 1920 må posteres med bankkonto.", /reai_list_company_banks/],
  ]) {
    await assert.rejects(
      () =>
        run(
          "reai_create_voucher",
          {
            date: "2026-08-08",
            description: "Zz",
            postings: [
              { accountNumber: "1320", amount: 50 },
              { accountNumber: "3000", amount: -50 },
            ],
          },
          (req) => {
            if (req.method === "GET") throw new Error("lookup unavailable");
            throw new Error(message);
          },
        ),
      needle,
    );
  }
});

test("the reconciliation-rule quirk does not mention companyBankId", () => {
  // ReconciliationRuleMutationReq has subAccountId and no companyBankId, so advising a bank account
  // there would send the caller into a second rejection for an unknown field.
  const rule = quirksFor("POST", "/api/reconciliation-rules").find(
    (q) => q.id === "reconciliation-rules-take-a-sub-account",
  );
  assert.ok(rule, "rules need the sub-account half of the guidance");
  assert.match(rule.note, /NO companyBankId/);
  const voucherOnly = quirksFor("POST", "/api/reconciliation-rules").map((q) => q.id);
  assert.ok(!voucherOnly.includes("some-accounts-demand-a-dimension"));
  // And the voucher keeps the full version.
  assert.ok(
    quirksFor("POST", "/api/vouchers")
      .map((q) => q.id)
      .includes("some-accounts-demand-a-dimension"),
  );
});

/**
 * The OTHER conditionally-mandatory dimension, pre-checked the same way.
 *
 * `reai_create_voucher` already refused a posting missing a `subAccountId` and named the choices. It did
 * not do the same for `companyBankId`, and the reason given in the argument's own description was that
 * "nothing in the company-bank response says which ledger account each bank belongs to". That premise is
 * true — measured, `/api/company-banks` returns id, name, bban, iban, currency, providerType and no
 * account number — but the conclusion was wrong, which the review of PR #132 pointed out.
 *
 * `GET /api/chart-of-accounts/accounts` pairs them. Measured on tenant 2634, which has three company
 * banks (1337, 1338, 1339):
 *
 *   accountNumberPrefix=1920 -> 1920/1337 {type:"bank", id:1337, name:"mva"}
 *                               1920/1338 {type:"bank", id:1338, name:"drift"}
 *                               1920/1339 {type:"bank", id:1339, name:"Skatt tilsidesatt - NOK"}
 *
 * and `subsidiaryLedger.id` is the companyBankId exactly. So the 400 the API would answer —
 * "Linje 1: Konto 1920 må posteres med bankkonto." naming the line and nothing else — is replaceable with
 * the actual ids, before anything is sent.
 */
const BANK_ROWS = [
  { number: "1920/1337", accountNumber: "1920", subsidiaryLedger: { type: "bank", id: 1337, name: "mva" } },
  { number: "1920/1338", accountNumber: "1920", subsidiaryLedger: { type: "bank", id: 1338, name: "drift" } },
  { number: "1920/1339", accountNumber: "1920", subsidiaryLedger: { type: "bank", id: 1339, name: "Skatt tilsidesatt - NOK" } },
  // A row with NO dimension. The live API returns these for a bare account (1900 subsidiaryLedger: null),
  // and without one here `subsidiaryLedger?.type` could lose its optional chain and nothing would notice —
  // the mutant throws, the catch eats it, and the check silently disables. Review demonstrated that.
  { number: "1900", accountNumber: "1900", subsidiaryLedger: null },
  // And a NON-bank dimension, so the discriminator is tested. Without it, matching any non-null dimension
  // passes every test while offering subAccountIds and supplier ids AS company bank ids — the worst false
  // positive in scope, and live-reachable: 2400 carries supplier dimensions on a real tenant.
  { number: "2400/5802", accountNumber: "2400", subsidiaryLedger: { type: "supplier", id: 5802, name: "A supplier" } },
  { number: "1300/6229", accountNumber: "1300", subsidiaryLedger: { type: "general", id: 6229, name: "Default" } },
];

/**
 * The chart search is a PREFIX search, and the stub must behave like one AND read the request the way the
 * tool actually sends it.
 *
 * It used to parse a query string out of `req.path`. When the tool moved to the client's `query` option, the
 * stub silently found nothing, defaulted the prefix to "" and returned EVERY row — so the bank tests kept
 * passing while testing nothing about filtering. That is why several mutations survived: a renamed or
 * removed parameter changed a request the stub was not reading. Reading `req.query` is what makes those
 * mutations visible.
 */
const chartResponder = (rows) => (req) => {
  if (req.path === "/api/general-sub-accounts") return [];
  if (req.path.startsWith("/api/chart-of-accounts/accounts")) {
    const prefix = req.query?.accountNumberPrefix;
    // No prefix means the tool did not filter — the live endpoint would answer an unrelated page, so the
    // stub must not quietly behave as though it had.
    if (prefix === undefined) return rows.slice(0, 1);
    const limit = Number(req.query?.limit ?? 20);
    return rows.filter((r) => String(r.accountNumber).startsWith(String(prefix))).slice(0, limit);
  }
  return { id: 1, number: "MV1-2026" };
};

const bankPostings = (extra = {}) => [
  { accountNumber: "1920", amount: 100, description: "d", ...extra },
  { accountNumber: "3000", amount: -100, description: "d" },
];

test("a posting to a bank account is refused locally, with the company bank ids", async () => {
  const { calls, result, text } = await run(
    "reai_create_voucher",
    { date: "2026-08-08", description: "Zz", postings: bankPostings() },
    chartResponder(BANK_ROWS),
  );
  assert.deepEqual([...new Set(calls.map((c) => c.method))], ["GET"], "no voucher may be sent");
  assert.equal(result.isError, true);
  assert.match(text, /Nothing was sent/);
  assert.match(text, /line 1, account 1920 → companyBankId/);
  // The ids themselves, which is the whole point — a refusal naming only the line is what the API
  // already does.
  for (const id of [1337, 1338, 1339]) assert.match(text, new RegExp(String(id)));
  assert.match(text, /mva/, "and the bank names, so a caller can pick the right one");
  assert.match(text, /reai_list_company_banks/, "with the tool for the full records");
});

test("supplying a companyBankId, or posting to an account without one, goes through", async () => {
  const supplied = await run(
    "reai_create_voucher",
    { date: "2026-08-08", description: "Zz", postings: bankPostings({ companyBankId: 1338 }) },
    chartResponder(BANK_ROWS),
  );
  assert.notEqual(supplied.result.isError, true);
  assert.ok(supplied.calls.some((c) => c.method === "POST"), "the voucher must be sent");

  // An account with no bank dimension must not be blocked. On a tenant with no company banks the prefix
  // search returns nothing at all — measured on 2783 — so absence is the normal case, not a signal.
  const noBanks = await run(
    "reai_create_voucher",
    {
      date: "2026-08-08",
      description: "Zz",
      postings: [
        { accountNumber: "3000", amount: 100, description: "d" },
        { accountNumber: "4000", amount: -100, description: "d" },
      ],
    },
    chartResponder([]),
  );
  assert.notEqual(noBanks.result.isError, true);
  assert.ok(noBanks.calls.some((c) => c.method === "POST"));
});

test("a failed dimension lookup does not block a voucher the API would accept", async () => {
  // Same discipline as the sub-account lookup: this spec has under-stated requirements before, and
  // refusing a write because a helper read failed would be the check doing harm. The API stays the
  // authority, and the catch after the POST still translates its Norwegian refusal.
  const calls = [];
  const validated = z.object(tool("reai_create_voucher").inputSchema).parse({
    tenantId: 2783,
    date: "2026-08-08",
    description: "Zz",
    postings: bankPostings(),
  });
  const result = await tool("reai_create_voucher").handler(validated, {
    client: {
      request: async (req) => {
        calls.push(req);
        if (req.path === "/api/general-sub-accounts") return { data: [], status: 200 };
        if (req.path.startsWith("/api/chart-of-accounts")) throw new Error("network down");
        return { data: { id: 1, number: "MV1-2026" }, status: 200 };
      },
      deepLink: () => "link",
    },
    config: { writeMode: "full", tenantId: 2783, allowExternalSend: false },
    session: {},
  });
  assert.notEqual(result.isError, true, "a failed lookup must not refuse the write");
  assert.ok(calls.some((c) => c.method === "POST"), "the voucher must still be sent");
});

test("the bank lookup matches the account EXACTLY, because the search is a prefix search", async () => {
  // accountNumberPrefix=1920 also returns 19205 if such an account exists, and `query` is worse — it
  // matches names too, so query=bank returns 1920 AND 7770 (measured). A posting to 1921 must not inherit
  // 1920's banks.
  const neighbour = [
    ...BANK_ROWS,
    { number: "19205/1400", accountNumber: "19205", subsidiaryLedger: { type: "bank", id: 1400, name: "other" } },
  ];
  const { result, text } = await run(
    "reai_create_voucher",
    {
      date: "2026-08-08",
      description: "Zz",
      postings: [
        { accountNumber: "1920", amount: 100, description: "d" },
        { accountNumber: "3000", amount: -100, description: "d" },
      ],
    },
    chartResponder(neighbour),
  );
  assert.equal(result.isError, true);
  assert.doesNotMatch(text, /1400/, "a neighbouring account's bank must not be offered for 1920");
});

test("the budget checks the first N and SAYS what it skipped, rather than silently standing down", async () => {
  // It used to be all-or-nothing: nine distinct accounts meant zero protection AND no mention of it, while
  // the argument description advertises the check — so an agent could read the absence of a refusal as
  // evidence no dimension was needed. Review of #133 called that the wrong trade, and it is: partial
  // coverage plus disclosure beats a cliff nobody is told about.
  // Balanced, or the debit/credit check returns before the dimension pass ever runs — which is how the
  // first version of this test reported 0 lookups and looked like a budget bug.
  const many = [{ accountNumber: "1920", amount: 110, description: "d" }];
  for (let i = 0; i < 11; i += 1) many.push({ accountNumber: `40${10 + i}`, amount: -10, description: "d" });
  const { calls, result, text } = await run(
    "reai_create_voucher",
    { date: "2026-08-08", description: "Zz", postings: many },
    chartResponder(BANK_ROWS),
  );
  const lookups = calls.filter((c) => String(c.path).startsWith("/api/chart-of-accounts")).length;
  assert.equal(lookups, 8, "the first eight distinct accounts must still be checked");
  // 1920 is among them, so the refusal must still fire — and must name what went unchecked.
  assert.equal(result.isError, true);
  assert.match(text, /line 1, account 1920 → companyBankId/);
  assert.match(text, /Not checked/, "the skipped accounts must be disclosed");
  assert.match(text, /lookup budget/);
});

test("the budget boundary is exact, so an off-by-one is caught", async () => {
  // Eight distinct accounts must all be checked; the ninth is the first to be skipped.
  const eight = [];
  for (let i = 0; i < 8; i += 1) eight.push({ accountNumber: `50${10 + i}`, amount: i % 2 ? -10 : 10, description: "d" });
  const atLimit = await run(
    "reai_create_voucher",
    { date: "2026-08-08", description: "Zz", postings: eight },
    chartResponder(BANK_ROWS),
  );
  assert.equal(
    atLimit.calls.filter((c) => String(c.path).startsWith("/api/chart-of-accounts")).length,
    8,
    "exactly at the budget, every account is checked",
  );
  assert.doesNotMatch(atLimit.text, /Not checked/, "and nothing is reported as skipped");
});

test("the companyBankId description no longer says the pre-check is missing", () => {
  const posting = tool("reai_create_voucher").inputSchema.postings._def.type._def.shape();
  const desc = posting.companyBankId._def.description;
  assert.match(desc, /PRE-CHECKS/, "the argument must say the check now happens");
  assert.doesNotMatch(
    desc,
    /has\s+not\s+made\s+yet/,
    "the deferral note must go now that the check exists",
  );
  assert.match(desc, /subsidiaryLedger/, "and name where the pairing comes from");
});

test("the accounts description says to post the BASE number, not the composed one", async () => {
  // A defect shipped in #132 and caught while reviewing my own pre-check. The description called the
  // composed `number` ("1920/1337") "the subledger syntax vouchers accept", generalising from
  // reai_book_bank_transactions, whose `account` field is a different field on a different endpoint and
  // does take that form. The voucher field does not: the spec's AccountNumber schema reads "Base chart of
  // accounts number. Use the `number` value returned by GET /api/chart-of-accounts or the `accountNumber`
  // value returned by GET /api/chart-of-accounts/accounts" — this endpoint's `accountNumber`, not its
  // `number`. An agent following the old text would have posted "1920/1337" into a field wanting "1920".
  const { registeredTools } = await import("../dist/server.js");
  const t = registeredTools.find((x) => x.name === "reai_list_accounts");
  assert.match(t.description, /Post the `accountNumber`, not the `number`/);
  assert.doesNotMatch(
    t.description,
    /subledger syntax vouchers accept/,
    "the retracted claim must not come back",
  );
  // And it must not name the bank-booking tool to make the point: that tool is in the `bank` toolset while
  // this one is in `bookkeeping`, so naming it would add a cross-toolset dependency for a historical aside.
  // My own cross-group invariant from #132 caught that.
  assert.doesNotMatch(t.description, /reai_book_bank_transactions/);

  // And the spec still says what the correction rests on, so this cannot rot silently.
  const { readFileSync } = await import("node:fs");
  const spec = JSON.parse(readFileSync(new URL("../spec/reai-openapi.json", import.meta.url), "utf8"));
  const accountNumber = spec.components.schemas.AccountNumber;
  assert.match(
    accountNumber.description,
    /Base chart of accounts number/,
    "the voucher field is documented as the BASE number; if that changes, revisit this description",
  );
  assert.match(accountNumber.description, /`accountNumber` value returned by/);
});

test("the lookup sends accountNumberPrefix and a limit, through `query` not the path", async () => {
  // Both halves matter. The parameter name is what makes the search a prefix search rather than a
  // name-matching one, and the limit is what stops a truncated list being offered as "pick from these".
  // And it must travel through `query`: an accountNumber containing "/" percent-encodes to %2F, which
  // hasAmbiguousSegments refuses, so interpolating it into `path` made the client throw and the catch
  // disable the check for the whole voucher. Review of #133 measured that.
  const { calls } = await run(
    "reai_create_voucher",
    { date: "2026-08-08", description: "Zz", postings: bankPostings({ companyBankId: 1338 }) },
    chartResponder(BANK_ROWS),
  );
  const lookup = calls.find((c) => String(c.path).startsWith("/api/chart-of-accounts"));
  assert.ok(lookup, "the chart must be consulted");
  assert.equal(lookup.path, "/api/chart-of-accounts/accounts", "no query string may be built into the path");
  assert.equal(lookup.query?.accountNumberPrefix, "3000", "the prefix parameter must be sent by name");
  assert.ok(Number(lookup.query?.limit) >= 100, "a limit must be sent, or a long list is silently truncated");
});

test("only a BANK dimension counts — a supplier or general one must not be offered as a bank id", async () => {
  // The discriminator, which nothing pinned. Matching any non-null dimension passes every other test while
  // refusing postings to 1300 and 2400 and presenting subAccountIds and SUPPLIER ids as company bank ids.
  // Both accounts carry real dimensions on a live tenant, so this is not hypothetical.
  for (const accountNumber of ["2400", "1300"]) {
    const { result, text, calls } = await run(
      "reai_create_voucher",
      {
        date: "2026-08-08",
        description: "Zz",
        postings: [
          { accountNumber, amount: 100, description: "d", subAccountId: 1 },
          { accountNumber: "3000", amount: -100, description: "d" },
        ],
      },
      chartResponder(BANK_ROWS),
    );
    assert.notEqual(result.isError, true, `${accountNumber} has a non-bank dimension and must not be refused`);
    assert.ok(calls.some((c) => c.method === "POST"), `the voucher for ${accountNumber} must be sent`);
    assert.doesNotMatch(text ?? "", /companyBankId/, `${accountNumber}'s dimension is not a bank`);
  }
});

test("a row with no dimension at all is handled, not thrown on", async () => {
  // The live API returns subsidiaryLedger: null for a bare account — the tool's own description shows
  // "1900 subsidiaryLedger: null". Without such a row in a RESPONSE, dropping the optional chain goes
  // unnoticed: the mutant throws, the catch swallows it, and the check silently disables.
  const { result, calls, text } = await run(
    "reai_create_voucher",
    {
      date: "2026-08-08",
      description: "Zz",
      postings: [
        { accountNumber: "1900", amount: 100, description: "d" },
        { accountNumber: "3000", amount: -100, description: "d" },
      ],
    },
    chartResponder(BANK_ROWS),
  );
  assert.notEqual(result.isError, true, "1900 needs no dimension and must go through");
  assert.ok(calls.some((c) => c.method === "POST"));
  // And the lookup must have SUCCEEDED, not thrown and been swallowed. Without this the mutation that
  // drops the optional chain is invisible: the null row throws, the catch eats it, the voucher goes through
  // and every other assertion still holds. The success note reports an unverified dimension, so its
  // absence is the evidence that the row was handled.
  assert.doesNotMatch(text, /NOT verified/, "the null-dimension row must be handled, not error out");
});

test("a bank posting is reported on ITS line, not always line 1", async () => {
  const { result, text } = await run(
    "reai_create_voucher",
    {
      date: "2026-08-08",
      description: "Zz",
      postings: [
        { accountNumber: "3000", amount: -100, description: "d" },
        { accountNumber: "1920", amount: 100, description: "d" },
      ],
    },
    chartResponder(BANK_ROWS),
  );
  assert.equal(result.isError, true);
  assert.match(text, /line 2, account 1920 → companyBankId/, "the line number must follow the posting");
  assert.doesNotMatch(text, /line 1, account 1920/);
});

test("a saturated page is not offered as a list to pick from", async () => {
  // The endpoint caps at 100 and does not order exact matches first. If a response comes back at the cap,
  // there may be more than were returned — so presenting those ids under "pick from the ids above" is how
  // an agent books to the WRONG bank, irreversibly. Worse than the bare 400, which named nothing.
  const many = [];
  for (let i = 0; i < 100; i += 1) {
    many.push({ number: `1920/${2000 + i}`, accountNumber: "1920", subsidiaryLedger: { type: "bank", id: 2000 + i, name: `b${i}` } });
  }
  const { result, text, calls } = await run(
    "reai_create_voucher",
    { date: "2026-08-08", description: "Zz", postings: bankPostings() },
    chartResponder(many),
  );
  assert.notEqual(result.isError, true, "a truncated list must not become a refusal offering ids");
  assert.ok(calls.some((c) => c.method === "POST"), "the API stays the authority");
  assert.doesNotMatch(text ?? "", /Pick from the ids above/);
});

test("a voucher needing BOTH dimensions is refused once, naming both", async () => {
  // It used to take two round trips: the sub-account block returned before the bank block ran, so a
  // caller fixed one, resubmitted and was refused again. "Bank pays an invoice" is the commonest voucher
  // shape there is, so that was the normal path.
  const { result, text } = await run(
    "reai_create_voucher",
    {
      date: "2026-08-08",
      description: "Zz",
      postings: [
        { accountNumber: "1300", amount: 100, description: "d" },
        { accountNumber: "1920", amount: -100, description: "d" },
      ],
    },
    (req) => {
      if (req.path === "/api/general-sub-accounts") return [{ id: 6229, accountNumber: "1300", name: "Default" }];
      return chartResponder(BANK_ROWS)(req);
    },
  );
  assert.equal(result.isError, true);
  assert.match(text, /line 1, account 1300 → subAccountId 6229/);
  assert.match(text, /line 2, account 1920 → companyBankId/);
  assert.match(text, /2 posting\(s\)/, "both are counted in one refusal");
});

test("renaming a sub-account states the name the response carries, not the one sent", async () => {
  // reai_rename_sub_account: GeneralSubAccountRes carries `name`, so echoing args was never necessary.
  const { text } = await run("reai_rename_sub_account", { id: 12, name: "shopify sales" }, () => ({
    id: 12,
    accountNumber: "1579",
    name: "Shopify sales",
  }));
  assert.match(text, /is now named "Shopify sales", read back from the response/);
  assert.match(text, /WARNING: name \(sent "shopify sales", sub-account 12 came back with "Shopify sales"\)/);
});

test("renaming a sub-account says so plainly when the response carries no name", async () => {
  const { text } = await run("reai_rename_sub_account", { id: 12, name: "Nytt" }, () => undefined);
  assert.match(text, /was sent the name "Nytt", but the response does not carry it/);
  assert.doesNotMatch(text, /read back from the response/);
});

test("renaming a sub-account to the name it stores reports no discrepancy", async () => {
  const { text } = await run("reai_rename_sub_account", { id: 12, name: "Shopify sales" }, () => ({
    id: 12,
    accountNumber: "1579",
    name: "Shopify sales",
  }));
  assert.doesNotMatch(text, /WARNING/);
  // The standing caveat about the ledger account must survive the rewrite.
  assert.match(text, /the ledger account it belongs to cannot be changed/);
});

test("creating a sub-account states the name the response stored, not the one sent", async () => {
  // reai_create_sub_account: found by widening the census, ten lines from the rename it shares a response
  // schema with. Declared irreversible with no DELETE, so the name it reports is the permanent one.
  const { text } = await run("reai_create_sub_account", { accountNumber: "1579", name: "shopify sales" }, (req) =>
    req.method === "GET" ? [{ id: 1, accountNumber: "1579", name: "Default" }] : { id: 12, accountNumber: "1579", name: "Shopify sales" },
  );
  assert.match(text, /Sub-account 12 "Shopify sales" created on account 1579/);
  assert.match(text, /WARNING: name \(sent "shopify sales", sub-account 12 came back with "Shopify sales"\)/);
});

test("creating a sub-account marks the name as SENT when the response omits it", async () => {
  const { text } = await run("reai_create_sub_account", { accountNumber: "1579", name: "Nytt" }, (req) =>
    req.method === "GET" ? [{ id: 1, accountNumber: "1579", name: "Default" }] : { id: 12 },
  );
  assert.match(text, /"Nytt" \(as SENT — the response does not carry the name back\)/);
});

test("creating a sub-account with the name it stores reports no discrepancy", async () => {
  const { text } = await run("reai_create_sub_account", { accountNumber: "1579", name: "Shopify sales" }, (req) =>
    req.method === "GET" ? [{ id: 1, accountNumber: "1579", name: "Default" }] : { id: 12, accountNumber: "1579", name: "Shopify sales" },
  );
  assert.doesNotMatch(text, /WARNING/);
  assert.match(text, /There is no DELETE for this resource/);
});
