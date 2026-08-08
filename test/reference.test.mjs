import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { referenceTools } from "../dist/tools/reference.js";
import { registeredTools } from "../dist/server.js";
import { classifyRequest } from "../dist/policy.js";

/**
 * Reference reads: the code lists this API accepts, and two 404s that are answers.
 *
 * The 404 handling is the part worth testing hard. Turning an error into an answer is only safe if it
 * is narrow — a tool that reports "nothing recorded" for any failure will report an expired token, a
 * disabled module and a 403 on someone else's tenant as facts about the books.
 */

const tool = (name) => {
  const found = referenceTools.find((t) => t.name === name);
  assert.ok(found, `${name} is not registered`);
  return found;
};

async function run(name, args, respond) {
  const calls = [];
  const validated = z.object(tool(name).inputSchema).parse({ tenantId: 2634, ...args });
  const result = await tool(name).handler(validated, {
    client: {
      request: async (req) => {
        calls.push(req);
        return respond(req);
      },
      deepLink: () => "link",
    },
    config: { writeMode: "read-only", tenantId: 2634, allowExternalSend: false },
    session: {},
  });
  return { calls, result, text: result.content.find((c) => c.type === "text").text };
}

const COUNTRIES = [
  { code: "NO", name: "Norway", currencyCode: "NOK" },
  { code: "SE", name: "Sweden", currencyCode: "SEK" },
  { code: "GB", name: "United Kingdom", currencyCode: "GBP" },
];
const CURRENCIES = [
  { code: "NOK", name: "Norwegian Krone" },
  { code: "SEK", name: "Swedish Krona" },
];

test("all four reference tools are reads on read paths", () => {
  const registered = new Set(registeredTools.map((t) => t.name));
  for (const name of [
    "reai_list_countries",
    "reai_list_currencies",
    "reai_get_opening_balance",
    "reai_get_annual_accounts",
  ]) {
    assert.ok(registered.has(name), name);
    assert.equal(tool(name).risk, "read");
    for (const [method, path] of tool(name).apiPaths) {
      assert.equal(method, "GET");
      assert.equal(classifyRequest("GET", path.replace("{year}", "2025")), "read");
    }
  }
});

// The local-filter test the exemption in test/preflight.test.mjs names. It has to show two things:
// the request is identical either way, and the OUTPUT differs — otherwise the argument is a dropped
// input, which is the bug that sweep exists to catch.
test("the local-filter test: query narrows the output without changing the request", async () => {
  const respond = async () => ({ data: COUNTRIES, status: 200 });
  const all = await run("reai_list_countries", {}, respond);
  const one = await run("reai_list_countries", { query: "sweden" }, respond);

  assert.deepEqual(
    all.calls.map((c) => ({ method: c.method, path: c.path, query: c.query })),
    one.calls.map((c) => ({ method: c.method, path: c.path, query: c.query })),
    "the endpoint takes no parameters, so both calls must be identical",
  );
  assert.match(all.text, /3 country\(s\)/);
  assert.match(one.text, /1 country\(s\) matching "sweden"/);
  assert.match(one.text, /filtered locally out of 3/);
  // A single hit names the code to send, which is the question a caller actually has.
  assert.match(one.text, /Send countryCode: "SE"/);

  // Matching on the CODE too, not only the name.
  const byCode = await run("reai_list_countries", { query: "gb" }, respond);
  assert.match(byCode.text, /Send countryCode: "GB"/);
});

test("currencies filter the same way, and a currency query says so", async () => {
  const respond = async () => ({ data: CURRENCIES, status: 200 });
  const one = await run("reai_list_currencies", { query: "krona" }, respond);
  assert.match(one.text, /1 currency\(s\) matching "krona"/);
  assert.match(one.text, /Send currencyCode: "SEK"/);
});

test("a no-match answer says the API was never asked", async () => {
  // The distinction that matters: this is a local search, so no-match is not evidence that the API
  // would reject the code.
  const respond = async () => ({ data: COUNTRIES, status: 200 });
  const none = await run("reai_list_countries", { query: "atlantis" }, respond);
  assert.match(none.text, /No country in this API's list matches "atlantis"/);
  assert.match(none.text, /The API was not\s+asked/);
});

test("an empty list from the API is reported as an API problem, not as a fact", async () => {
  const empty = await run("reai_list_countries", {}, async () => ({ data: [], status: 200 }));
  assert.match(empty.text, /EMPTY country list, which is not a normal answer/);
  assert.ok(!/0 country\(s\)/.test(empty.text), "the generic count would read as a fact about countries");
});

test("a non-list response is not reported as an empty list", async () => {
  const odd = await run("reai_list_countries", {}, async () => ({ data: { unexpected: true }, status: 200 }));
  assert.match(odd.text, /did not return a list/);
  assert.match(odd.text, /NOT a report that the API supports no countries/);
});

// The 404-as-answer pair. Narrowness is the whole point.
test("a documented 404 becomes the answer, for both status reads", async () => {
  const notFound = (message) => async () => {
    throw new Error(`ReAI GET /x failed with HTTP 404: ${message}`);
  };

  const balance = await run("reai_get_opening_balance", {}, notFound("Opening balance not found"));
  assert.match(balance.text, /has NO opening balance recorded/);
  assert.match(balance.text, /Not a wrong path, not a wrong tenant, not a disabled module/);
  assert.notEqual(balance.result.isError, true, "a 404 that means 'none' is not a failure");

  const accounts = await run(
    "reai_get_annual_accounts",
    { year: 2025 },
    notFound("No annual-accounts submission exists for this year"),
  );
  assert.match(accounts.text, /NO annual-accounts submission exists for 2025/);
  assert.notEqual(accounts.result.isError, true);
});

test("any OTHER failure still fails, so an outage is never reported as an empty book", async () => {
  // The dangerous version of the tool above: catch everything, call it "nothing recorded". A 403 on a
  // module, an expired token or a 500 would then read as a fact about the tenant's accounts.
  for (const message of [
    "ReAI GET /x failed with HTTP 403: Forbidden",
    "ReAI GET /x failed with HTTP 401: Unauthorized",
    "ReAI GET /x failed with HTTP 500: Internal error",
    // A 404 that is NOT the documented one — a mistyped path, say — must not be swallowed either.
    "ReAI GET /x failed with HTTP 404: No static resource api/opening-balance",
  ]) {
    await assert.rejects(
      () => run("reai_get_opening_balance", {}, async () => { throw new Error(message); }),
      /failed with HTTP/,
      message,
    );
    await assert.rejects(
      () => run("reai_get_annual_accounts", { year: 2025 }, async () => { throw new Error(message); }),
      /failed with HTTP/,
      message,
    );
  }
});

test("a balance that DOES exist is reported as ledger position, not as master data", async () => {
  const present = await run("reai_get_opening_balance", {}, async () => ({
    data: { lines: [{ accountNumber: "1500", amount: 125000 }] },
    status: 200,
  }));
  assert.match(present.text, /HAS an opening balance recorded/);
  assert.match(present.text, /every comparative figure depends on it/);
  assert.match(present.text, /no tool that does/);
});

test("the opening-balance tool says why its write endpoints are not curated", () => {
  // POST/PUT/DELETE all exist. The DELETE is "delete OR reverse", the family this repo has been
  // caught by five times, and neither test tenant has a balance to watch it on — so the honest
  // position is to say that rather than to ship a tool that guesses.
  const description = tool("reai_get_opening_balance").description;
  assert.match(description, /delete OR reverse/);
  assert.match(description, /never watched those three endpoints run/);
  assert.match(description, /reai_request/);
});

test("the code-list tools point at the gap they close", () => {
  // The validators check shape, not membership: "UK" is well formed and not accepted.
  for (const name of ["reai_list_countries", "reai_list_currencies"]) {
    assert.match(tool(name).description, /filters HERE|locally/);
  }
  assert.match(tool("reai_list_countries").description, /`UK` is well formed and wrong/);
  assert.match(tool("reai_list_countries").description, /GB/);
});
