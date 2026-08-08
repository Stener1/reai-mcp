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
