import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { referenceTools } from "../dist/tools/reference.js";
import { registeredTools } from "../dist/server.js";
import { classifyRequest } from "../dist/policy.js";
import { ReaiApiError } from "../dist/reai/errors.js";

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

// The 404-as-answer pair. Narrowness is the whole point, and it is decided on the TYPED status
// rather than on the rendered message — so these tests throw the real error type, which is what the
// handler now inspects. A stub throwing `new Error("... HTTP 404 ...")` used to satisfy it, and that
// was the weakness review named: any failure whose text happened to contain both "HTTP 404" and the
// phrase would have been reported as an empty set of books.
const apiError = (status, message, path = "/api/opening-balances") =>
  new ReaiApiError({
    status,
    method: "GET",
    path,
    problem: { detail: message },
    rawBody: JSON.stringify({ detail: message }),
  });

test("a documented 404 becomes the answer, for both status reads", async () => {
  const balance = await run("reai_get_opening_balance", {}, async () => {
    throw apiError(404, "Opening balance not found");
  });
  assert.match(balance.text, /has NO opening balance recorded/);
  assert.match(balance.text, /Not a wrong path, not a wrong tenant, not a disabled module/);
  assert.notEqual(balance.result.isError, true, "a 404 that means 'none' is not a failure");

  const accounts = await run("reai_get_annual_accounts", { year: "2025" }, async () => {
    throw apiError(404, "No annual-accounts submission exists for this year", "/api/annual-accounts/2025");
  });
  assert.match(accounts.text, /NO annual-accounts submission exists for 2025/);
  assert.notEqual(accounts.result.isError, true);
});

test("a NON-404 carrying the same words is still a failure", async () => {
  // Review's finding, and the reason the check reads err.status: a gateway 500 relaying a downstream
  // body can contain both "HTTP 404" and the documented phrase. Reporting that as "nothing recorded"
  // turns an outage into a fact about someone's accounts.
  await assert.rejects(
    () =>
      run("reai_get_opening_balance", {}, async () => {
        throw apiError(500, "upstream said: HTTP 404 Opening balance not found");
      }),
    (err) => err instanceof ReaiApiError && err.status === 500,
    "a 500 quoting the 404 phrase must propagate",
  );
  await assert.rejects(
    () =>
      run("reai_get_annual_accounts", { year: "2025" }, async () => {
        throw apiError(502, "gateway: HTTP 404 No annual-accounts submission exists");
      }),
    (err) => err instanceof ReaiApiError && err.status === 502,
  );
});

test("any OTHER failure still fails, so an outage is never reported as an empty book", async () => {
  // The dangerous version of these tools: catch everything, call it "nothing recorded". A 403 on a
  // module, an expired token or a 500 would then read as a fact about the tenant's accounts.
  const cases = [
    apiError(403, "Forbidden"),
    apiError(401, "Unauthorized"),
    apiError(500, "Internal error"),
    // A 404 that is NOT the documented one — a mistyped path, say — must not be swallowed either,
    // because it means the caller is not asking what they think they are.
    apiError(404, "No static resource api/opening-balance"),
    // And a failure that is not a ReaiApiError at all: a socket hangup, an aborted request.
    new Error("fetch failed: ECONNRESET (HTTP 404 Opening balance not found)"),
  ];
  for (const thrown of cases) {
    await assert.rejects(
      () => run("reai_get_opening_balance", {}, async () => { throw thrown; }),
      (err) => err === thrown,
      `${thrown.message} must propagate unchanged`,
    );
    await assert.rejects(
      () => run("reai_get_annual_accounts", { year: "2025" }, async () => { throw thrown; }),
      (err) => err === thrown,
    );
  }
});

test("a balance that DOES exist is reported as a voucher, with the same flag as the absent case", async () => {
  const voucher = { id: 9, number: "OB-1", date: "2025-01-01", postings: [{ accountNumber: "1500", amount: 125000 }] };
  const present = await run("reai_get_opening_balance", {}, async () => ({ data: voucher, status: 200 }));
  assert.match(present.text, /HAS an opening balance recorded/);
  assert.match(present.text, /VOUCHER/);
  assert.match(present.text, /why its DELETE can reverse/);
  assert.match(present.text, /no\s+tool that changes it/);
  // The PAYLOAD, not only the prose. A consumer keys on `recorded`, and it has to exist on both
  // branches or it reads as falsy whichever way the answer went.
  const body = JSON.parse(present.text.slice(present.text.indexOf("{")));
  assert.equal(body.recorded, true);
  assert.deepEqual(body.openingBalance, voucher);
});

test("the synthesized payloads carry the flag a consumer keys on, on both branches", async () => {
  // Flipping either flag used to leave every test green: the assertions were all on the note.
  const absent = await run("reai_get_opening_balance", {}, async () => {
    throw apiError(404, "Opening balance not found");
  });
  const absentBody = JSON.parse(absent.text.slice(absent.text.indexOf("{")));
  assert.equal(absentBody.recorded, false);
  assert.equal(absentBody.openingBalance, null);

  const unfiled = await run("reai_get_annual_accounts", { year: "2025" }, async () => {
    throw apiError(404, "No annual-accounts submission exists", "/api/annual-accounts/2025");
  });
  const unfiledBody = JSON.parse(unfiled.text.slice(unfiled.text.indexOf("{")));
  assert.equal(unfiledBody.submissionExists, false);
  assert.equal(unfiledBody.status, null);
  assert.equal(unfiledBody.year, 2025);
});

test("an existing submission reports its status, not an invented submitted flag", async () => {
  // The API's states are incomplete, complete, signing, signed and submitted_in_other_system. There
  // is no "submitted", so a boolean would have to invent one — and "incomplete" is exactly the state
  // where a record exists and nothing has been filed.
  const incomplete = await run("reai_get_annual_accounts", { year: "2025" }, async () => ({
    data: { year: 2025, status: "incomplete" },
    status: 200,
  }));
  const body = JSON.parse(incomplete.text.slice(incomplete.text.indexOf("{")));
  assert.equal(body.submissionExists, true);
  assert.equal(body.status, "incomplete");
  assert.ok(!("submitted" in body), "no invented boolean");
  assert.match(incomplete.text, /Existing is not the same as filed/);
  assert.match(incomplete.text, /submitted_in_other_system/);
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

test("the global code lists work with no tenant selected, and send no tenant header", async () => {
  // The spec declares no X-Tenant-Id parameter for either endpoint. Requiring one made "what country
  // codes does this API accept" unanswerable until a company was selected, which is backwards for a
  // question worth asking immediately after authenticating.
  for (const [name, rows] of [
    ["reai_list_countries", COUNTRIES],
    ["reai_list_currencies", CURRENCIES],
  ]) {
    const calls = [];
    const validated = z.object(tool(name).inputSchema).parse({}); // no tenantId at all
    const result = await tool(name).handler(validated, {
      client: {
        request: async (req) => {
          calls.push(req);
          return { data: rows, status: 200 };
        },
        deepLink: () => "link",
      },
      // No bound tenant and no default: the state right after authenticating.
      config: { writeMode: "read-only", tenantId: undefined, allowExternalSend: false },
      session: {},
    });
    const text = result.content.find((c) => c.type === "text").text;
    assert.notEqual(result.isError, true, `${name} must not require a tenant`);
    assert.match(text, new RegExp(`${rows.length} (country|currency)\\(s\\)`));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].omitTenant, true, `${name} should send no tenant header`);
    assert.equal(calls[0].tenantId, undefined);
  }
});

test("the fiscal year is a four-digit string, the same as its two sibling tools", async () => {
  // Found by the path-parameter sweep: this shipped as a NUMBER while reai_get_tax_return and
  // reai_create_vat_return, which take the same fiscal year, both take a four-digit string. An agent
  // using two of the three in one session had to guess which wanted 2025 and which wanted "2025".
  const { registeredTools } = await import("../dist/server.js");
  const year = tool("reai_get_annual_accounts").inputSchema.year;
  assert.equal(year.safeParse("2025").success, true);
  assert.equal(year.safeParse("1999").success, true, "a legacy fiscal year is not this server's to refuse");
  assert.equal(year.safeParse(2025).success, false, "a number is not the shape the spec declares");
  // "0999" among them: `Number("0999")` is 999, so admitting it would make the payload's `year` stop
  // identifying the year requested — the round-trip the number conversion exists to preserve.
  for (const bad of ["1", "20255", "", "abcd", "202 5", "0000", "0999"]) {
    assert.equal(year.safeParse(bad).success, false, bad);
  }

  // And the property that matters more than any single bound: all three agree.
  for (const name of ["reai_get_tax_return", "reai_create_vat_return"]) {
    const sibling = registeredTools.find((t) => t.name === name);
    assert.ok(sibling?.inputSchema?.year, `${name} should take a year`);
    for (const probe of ["2025", "1999", "1", "20255"]) {
      assert.equal(
        sibling.inputSchema.year.safeParse(probe).success,
        year.safeParse(probe).success,
        `${name} and reai_get_annual_accounts disagree about ${JSON.stringify(probe)}`,
      );
    }
  }
});

test("the filter is case-insensitive, which the description promises", async () => {
  // Every other query in this file is already lowercase, so a needle that stopped being lowercased
  // would have regressed silently.
  const respond = async () => ({ data: COUNTRIES, status: 200 });
  for (const query of ["Sweden", "SWEDEN", "sWeDeN", "Se"]) {
    const r = await run("reai_list_countries", { query }, respond);
    assert.match(r.text, /Send countryCode: "SE"/, query);
  }
});

test("a country can be found by the currency it uses", async () => {
  // The country list's selling point is carrying a default currency, so this is the natural question.
  // It used to answer a confident zero plus advice to try a shorter fragment.
  const respond = async () => ({ data: COUNTRIES, status: 200 });
  const nok = await run("reai_list_countries", { query: "NOK" }, respond);
  assert.match(nok.text, /Send countryCode: "NO"/);
});

test("a blank query is treated as no query, not as a filter that matched everything", async () => {
  // `matching` ignores a whitespace query, but the sentences keyed on truthiness — so "   " reported
  // "3 country(s) matching \"   \", filtered locally out of 3", and on a one-row list it claimed that
  // row matched a string of spaces.
  const respond = async () => ({ data: COUNTRIES, status: 200 });
  for (const query of ["   ", "\t", ""]) {
    const r = await run("reai_list_countries", { query }, respond);
    assert.match(r.text, /3 country\(s\)\./, JSON.stringify(query));
    assert.ok(!/matching/.test(r.text), `${JSON.stringify(query)} must not claim to have filtered`);
  }
  const single = await run("reai_list_countries", { query: "  " }, async () => ({
    data: [COUNTRIES[0]],
    status: 200,
  }));
  assert.ok(!/Send countryCode/.test(single.text), "a blank query must not claim a single match");
});

test("the code hint fires only on a single match", async () => {
  // Otherwise "Send countryCode: X" names an arbitrary row out of several.
  const respond = async () => ({ data: COUNTRIES, status: 200 });
  const many = await run("reai_list_countries", { query: "united" }, async () => ({
    data: [COUNTRIES[2], { code: "US", name: "United States", currencyCode: "USD" }],
    status: 200,
  }));
  assert.match(many.text, /2 country\(s\) matching "united"/);
  assert.ok(!/Send countryCode/.test(many.text), "two matches must not name one code");
  const one = await run("reai_list_countries", { query: "norway" }, respond);
  assert.match(one.text, /Send countryCode: "NO"/);
});

test("the documented phrase is found in the raw body too, not only in the message", async () => {
  // The annual-accounts 404 is documented as returning AnnualAccountsSubmissionRes, not a
  // ProblemDetail — so if ReAI ever honours that, `problem.detail` is absent and the raw body is
  // where the phrase would live.
  //
  // Honest about what this proves: review showed the `|| phrase.test(err.rawBody)` half of the check
  // cannot currently be reached, because ReaiApiError.describe() already embeds rawBody in the
  // message, so the message test matches first for every error the class can build. The half stays as
  // defence against that rendering changing, and this test pins the OUTCOME rather than the branch —
  // it would still catch the tool ceasing to recognise a body-only 404.
  const bodyOnly = new ReaiApiError({
    status: 404,
    method: "GET",
    path: "/api/annual-accounts/2025",
    rawBody: '{"message":"No annual-accounts submission exists for the fiscal year"}',
  });
  const r = await run("reai_get_annual_accounts", { year: "2025" }, async () => {
    throw bodyOnly;
  });
  assert.match(r.text, /NO annual-accounts submission exists for 2025/);
  assert.notEqual(r.result.isError, true);
});

/**
 * `reai_list_accounts` is a SEARCH that reads like a listing, and its description used to say so.
 *
 * Measured 2026-08-09 against `GET /api/chart-of-accounts/accounts` on tenant 2783:
 *
 *   no parameters        -> 20 rows
 *   ?limit=5             ->  5 rows
 *   ?limit=500           -> 100 rows   (silently capped; the `limit` argument documents that)
 *   ?query=1320          ->  1 row
 *
 * against a chart of **399** accounts. The old description ended "every posting must reference an
 * account that exists in this list", which invites an agent that searched, saw 20 rows and missed 1320
 * to conclude the account does not exist. Same shape as the `includeArchived` defect the quirk audits
 * found: a result that looks unfiltered and is not.
 *
 * Pinned here because the fix is prose, and prose is what rots.
 */
test("the accounts search says it is a search, and that absence is not evidence", async () => {
  const { registeredTools } = await import("../dist/server.js");
  const t = registeredTools.find((x) => x.name === "reai_list_accounts");
  assert.ok(t, "reai_list_accounts must exist — five places in src/ tell agents to call it");

  // The default is the part nothing documented. 20 of 399 is the number that matters.
  assert.match(t.description, /returns 20 accounts/, "the default page size must be stated");
  assert.match(t.description, /capped at 100/, "and the cap, so no call can return the whole chart");
  assert.match(
    t.description,
    /ABSENT from a result is therefore not evidence/,
    "the wrong inference must be closed off explicitly",
  );
  // Specific to the CLAIM, not the quotation. The description quotes what it retracted — which is
  // useful for anyone diffing it — so a bare substring check fires on the retraction itself. The old
  // text was the closing sentence "…before booking a voucher — every posting must reference an account
  // that exists in this list", so the sentence shape is what must not return. Same trick as the
  // `returns nothing —` pin in test/archive.test.mjs.
  assert.doesNotMatch(
    t.description,
    /voucher\s*—\s*every posting must reference/,
    "the retracted framing must not come back as a claim",
  );
  assert.match(
    t.description,
    /An earlier version of this text said/,
    "and the retraction itself should stay, so the change is legible",
  );

  // The endpoint cannot page, and the complete chart lives elsewhere. Saying "no single call can return
  // the whole thing" without that would read as "the whole chart is unobtainable", which is false —
  // GET /api/chart-of-accounts returns all 399, and no curated tool exposes it.
  assert.match(t.description, /no paging/, "the absence of paging must be stated, not implied");
  assert.match(
    t.description,
    /COMPLETE chart is a different endpoint/,
    "and the route that does return everything must be named",
  );
  assert.match(t.description, /reai_request/, "with the honest fallback for reaching it");

  // The dimensions ARE here, and an earlier version of this description claimed the opposite. Measured:
  // `accountNumberPrefix=19` on a tenant with three company banks returns 1900 with
  // `subsidiaryLedger: null` and three 1920 rows — "1920/1337" etc — each carrying
  // `{type:"bank", id:<companyBankId>}`. So the row is an account-plus-dimension and the id to post with
  // is in it. Checking for the field name `generalSubAccounts` (which this endpoint does NOT use) is how
  // that got missed.
  assert.match(t.description, /subsidiaryLedger/, "the field that carries the dimension must be named");
  assert.match(t.description, /1920\/1337/, "with the measured example of a composed account number");
  assert.match(t.description, /companyBankId/);
  assert.match(t.description, /subAccountId/);
  assert.doesNotMatch(
    t.description,
    /does not tell you what a posting to an account will DEMAND/,
    "the retracted claim that the dimensions are invisible must not come back",
  );
  assert.match(t.description, /reai_sub_accounts_for_account/);
  assert.match(t.description, /reai_list_company_banks/);

  // And the tool it points at has to exist, or the advice is a dead end.
  for (const name of ["reai_sub_accounts_for_account", "reai_list_company_banks"]) {
    assert.ok(
      registeredTools.some((x) => x.name === name),
      `${name} is named in the description but is not registered`,
    );
  }
});

/**
 * Cross-toolset references, recorded rather than banned.
 *
 * `REAI_TOOLSETS=bookkeeping` gives 19 tools plus the seven always-on ones. `reai_list_accounts` is in
 * that selection and `reai_list_company_banks` is not — it is in `bank` — so a description pointing at
 * it names a tool the agent cannot see. Codex found that on this PR, and the union check below could not
 * see it because `registeredTools` is every group at once.
 *
 * The fix is NOT to delete the references. "Take the VAT code from reai_list_vat_codes" is good advice
 * that happens to cross a group boundary, and 19 of them already existed before this PR. What matters is
 * that each is a deliberate, visible choice — so they are enumerated here, and a new one fails until it
 * is added with the group it lives in. The always-on `reai_request` and `reai_search_endpoints` are the
 * escape hatch in every narrowed configuration, which is what makes a cross-group reference survivable.
 */
const CROSS_GROUP_REFERENCES = new Set([
  "bookkeeping: reai_list_accounts -> reai_list_company_banks",
  "bookkeeping: reai_list_sub_accounts -> reai_create_reconciliation_rule",
  "sales: reai_create_product -> reai_list_vat_codes",
  "purchase: reai_unarchive_supplier -> reai_unarchive_customer",
  "purchase: reai_register_supplier_invoice_payment -> reai_list_company_banks",
  "bank: reai_create_reconciliation_rule -> reai_list_accounts",
  "bank: reai_create_reconciliation_rule -> reai_list_vat_codes",
  "bank: reai_book_bank_transactions -> reai_list_accounts",
  "bank: reai_book_bank_transactions -> reai_list_vat_codes",
  "bank: reai_create_vat_return -> reai_general_ledger",
  "organisation: reai_list_employees -> reai_list_postings",
  "organisation: reai_list_employees -> reai_general_ledger",
  "organisation: reai_list_employees -> reai_list_expenses",
  "assets: reai_create_asset -> reai_list_accounts",
  "subscriptions: reai_create_subscription -> reai_list_customers",
  "subscriptions: reai_update_subscription -> reai_list_customers",
  "warehouses: reai_adjust_inventory -> reai_list_products",
  "investments: reai_add_share_investment_event -> reai_list_vouchers",
  "investments: reai_add_share_investment_event -> reai_list_company_banks",
]);

test("a description that points across toolsets is recorded, not accidental", async () => {
  const { TOOL_GROUPS, selectTools, alwaysOnTools } = await import("../dist/server.js");
  const always = new Set((alwaysOnTools ?? []).map((t) => t.name));
  // The escape hatch that makes any of this survivable — if these ever stop being always-on, every
  // cross-group reference becomes a dead end and this whole allowance has to be revisited.
  for (const escape of ["reai_request", "reai_search_endpoints", "reai_describe_endpoint"]) {
    assert.ok(always.has(escape), `${escape} must be always-on for a narrowed toolset to recover`);
  }

  const found = new Set();
  for (const group of Object.keys(TOOL_GROUPS)) {
    const selection = selectTools([group]);
    const present = new Set([...selection.map((t) => t.name), ...always]);
    for (const t of selection) {
      const text = `${t.description ?? ""} ${JSON.stringify(t.inputSchema ?? {})}`;
      for (const [, ref] of text.matchAll(/\b(reai_[a-z0-9_]+)/g)) {
        if (ref === t.name || present.has(ref)) continue;
        found.add(`${group}: ${t.name} -> ${ref}`);
      }
    }
  }

  const added = [...found].filter((f) => !CROSS_GROUP_REFERENCES.has(f));
  assert.deepEqual(
    added,
    [],
    "these descriptions point at a tool a narrowed REAI_TOOLSETS would not include. That can be fine — " +
      "the always-on discovery tools reach any endpoint — but say so in the description and add it here.",
  );
  const gone = [...CROSS_GROUP_REFERENCES].filter((f) => !found.has(f));
  assert.deepEqual(gone, [], "these recorded references no longer exist; drop them from the list");
});

test("every tool named in another tool's description is actually registered", async () => {
  // The check that would have caught this class earlier. Descriptions point agents at other tools by
  // name, and a name that does not resolve is a dead end an agent cannot recover from — it reads as a
  // capability the server has and then does not.
  const { registeredTools } = await import("../dist/server.js");
  const names = new Set(registeredTools.map((t) => t.name));
  const dangling = [];
  for (const t of registeredTools) {
    const text = `${t.description ?? ""} ${JSON.stringify(t.inputSchema ?? {})}`;
    for (const [, referenced] of text.matchAll(/\b(reai_[a-z0-9_]+)/g)) {
      if (referenced === t.name) continue;
      if (!names.has(referenced)) dangling.push(`${t.name} -> ${referenced}`);
    }
  }
  assert.deepEqual(dangling, [], "these descriptions name tools that do not exist");
});
