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
  assert.deepEqual(calls.map((c) => c.method), ["GET"], "no voucher may be sent");
  assert.equal(result.isError, true);
  assert.match(text, /line 1, account 1320 → subAccountId 6231 \(Default\)/);
  assert.match(text, /even when the only one is called "Default"/);
  assert.match(text, /Nothing was sent/);
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
];

/** The chart search is a PREFIX search, so the stub must behave like one — see the exact-match test. */
const chartResponder = (rows) => (req) => {
  if (req.path === "/api/general-sub-accounts") return [];
  if (req.path.startsWith("/api/chart-of-accounts/accounts")) {
    const want = decodeURIComponent(new URL(`http://x/${req.path}`).searchParams.get("accountNumberPrefix") ?? "");
    return rows.filter((r) => r.accountNumber.startsWith(want));
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

test("the lookup is bounded, so a wide voucher does not burst a read per line", async () => {
  // One read per DISTINCT account lacking a companyBankId. Beyond a small budget the check steps aside
  // rather than spending a burst of reads before the API has even been asked.
  const many = [];
  for (let i = 0; i < 12; i += 1) many.push({ accountNumber: `40${10 + i}`, amount: i % 2 ? -10 : 10, description: "d" });
  const { calls, result } = await run(
    "reai_create_voucher",
    { date: "2026-08-08", description: "Zz", postings: many },
    chartResponder(BANK_ROWS),
  );
  const lookups = calls.filter((c) => String(c.path).startsWith("/api/chart-of-accounts")).length;
  assert.equal(lookups, 0, "past the budget the check must step aside, not issue 12 reads");
  assert.notEqual(result.isError, true, "and must not block the voucher");
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
