// Share investments. Everything asserted here was measured against the write test tenant before it was
// written down — the module doc in src/tools/investments.ts records the measurements themselves, and one
// of them cost an unremovable record, which is why the create tool refuses an opening balance by default.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registeredTools } from "../dist/server.js";
import { classifyRequest } from "../dist/policy.js";
import { ReaiApiError } from "../dist/reai/errors.js";

const tool = (name) => {
  const found = registeredTools.find((t) => t.name === name);
  assert.ok(found, `${name} should exist`);
  return found;
};

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
          if (next instanceof Error) throw next;
          return next;
        },
        deepLink: () => "https://app.reai.no/",
      },
    },
  };
}

const textOf = (r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

const POSITION = {
  id: 19,
  name: "Zz Holding AS",
  ticker: "ZZ",
  isin: null,
  instrumentType: "LISTED_SHARE",
  currency: "NOK",
  withinExemptionMethod: true,
  status: "OPEN",
  assetAccountNumber: "1810",
  companyBankId: null,
  quantity: 100,
  costPrice: 50000,
};

const CREATE_ARGS = {
  name: "Zz Holding AS",
  instrumentType: "LISTED_SHARE",
};

test("an opening balance is refused unless the caller accepts a permanent record", async () => {
  // The measurement that cost something: openingQuantity/openingCostAmount/openingDate silently create a
  // PURCHASE event, and a position with any event can never be deleted — nothing removes an event. The
  // create response says none of this, and clearing the fields afterwards does not undo it. So the refusal
  // happens HERE, before anything exists.
  for (const field of ["openingQuantity", "openingCostAmount", "openingDate"]) {
    const value = field === "openingDate" ? "2026-01-02" : 100;
    const { ctx, sent } = ctxFor([]);
    const res = await tool("reai_create_share_investment").handler({ ...CREATE_ARGS, [field]: value }, ctx);
    assert.equal(res.isError, true, `${field} must not go through silently`);
    assert.equal(sent.length, 0, `${field}: nothing may be sent`);
    assert.match(textOf(res), /NEVER be deleted|never be deleted/);
    assert.match(textOf(res), /acceptPermanentPosition/);
    // The way out has to be named, not just the refusal.
    assert.match(textOf(res), /reai_add_share_investment_event/);
  }
});

test("with the acknowledgement, the opening balance goes through and is called permanent", async () => {
  const { ctx, sent } = ctxFor([{ status: 201, data: { ...POSITION } }]);
  const res = await tool("reai_create_share_investment").handler(
    { ...CREATE_ARGS, openingQuantity: 100, openingCostAmount: 50000, openingDate: "2026-01-02", acceptPermanentPosition: true },
    ctx,
  );
  assert.notEqual(res.isError, true, textOf(res));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.openingQuantity, 100, "the opening fields must actually be sent");
  assert.equal(sent[0].body.acceptPermanentPosition, undefined, "the acknowledgement is ours, not the API's");
  assert.match(textOf(res), /CANNOT be deleted/);
});

test("a position created without an opening balance is reported as still deletable", async () => {
  const { ctx, sent } = ctxFor([{ status: 201, data: { ...POSITION, quantity: null, costPrice: null } }]);
  const res = await tool("reai_create_share_investment").handler(CREATE_ARGS, ctx);
  assert.notEqual(res.isError, true, textOf(res));
  assert.match(textOf(res), /still deletable/);
  assert.match(textOf(res), /1810/, "the derived asset account is the thing to check now");
  assert.match(textOf(res), /Nothing was posted/);
  assert.equal(sent[0].body.openingQuantity, undefined);
});

test("the position and the event are classified apart, because only one of them posts", async () => {
  // Creating a position posted nothing — voucher count 0 before and after. An event books a voucher.
  // Both are irreversible under the policy for /api/share-investments, and the tools must not be softer.
  for (const name of [
    "reai_create_share_investment",
    "reai_update_share_investment",
    "reai_add_share_investment_event",
    "reai_delete_share_investment",
  ]) {
    assert.equal(tool(name).risk, "irreversible", `${name} must match the policy tier`);
  }
  assert.equal(classifyRequest("POST", "/api/share-investments"), "irreversible");
  assert.equal(classifyRequest("POST", "/api/share-investments/7/events"), "irreversible");
  // The reads stay reads.
  for (const name of [
    "reai_list_share_investments",
    "reai_get_share_investment",
    "reai_list_share_investment_events",
  ]) {
    assert.equal(tool(name).risk, "read");
  }
  // The event is the one that moves money into the books, so it is flagged destructive as well.
  assert.equal(tool("reai_add_share_investment_event").destructive, true);
});

test("an event reports the voucher it booked, and says when it cannot confirm one", async () => {
  const { ctx } = ctxFor([{ status: 201, data: { id: 43, eventType: "DIVIDEND", eventDate: "2026-06-01", amount: 1000, voucherId: 30997 } }]);
  const res = await tool("reai_add_share_investment_event").handler(
    { id: 19, eventType: "DIVIDEND", eventDate: "2026-06-01", amount: 1000, companyBankId: 1643 },
    ctx,
  );
  const text = textOf(res);
  assert.match(text, /POSTED to the ledger as voucher 30997/);
  assert.match(text, /no way to delete the event/);
  assert.match(text, /reversed/, "the only undo is a reversal, and it leaves the original");
  assert.match(text, /can no longer be deleted/);

  // No voucherId in the response is an unknown, not a "did not post".
  const silent = ctxFor([{ status: 201, data: { id: 44, eventType: "DIVIDEND" } }]);
  const quiet = await tool("reai_add_share_investment_event").handler(
    { id: 19, eventType: "DIVIDEND", eventDate: "2026-06-01", amount: 1000, companyBankId: 1643 },
    silent.ctx,
  );
  assert.match(textOf(quiet), /UNCONFIRMED/);
});

test("the two Norwegian refusals are translated, wherever they surface", async () => {
  // "Choose the securities account the transaction was settled against" — asking for companyBankId, on a
  // body the document marks as requiring nothing.
  const noAccount = new ReaiApiError({
    status: 400,
    method: "POST",
    path: "/api/share-investments/19/events",
    rawBody: '{"detail":"Velg verdipapirkontoen transaksjonen ble gjort opp mot."}',
    problem: { detail: "Velg verdipapirkontoen transaksjonen ble gjort opp mot." },
  });
  const eventCtx = ctxFor([noAccount]);
  const evres = await tool("reai_add_share_investment_event").handler(
    { id: 19, eventType: "DIVIDEND", eventDate: "2026-06-01", amount: 1000, companyBankId: 1 },
    eventCtx.ctx,
  );
  assert.equal(evres.isError, true);
  assert.match(textOf(evres), /companyBankId/);
  assert.match(textOf(evres), /reai_list_company_banks/);

  // "The share position has registered transactions and cannot be deleted" — final, not an ordering.
  const hasEvents = new ReaiApiError({
    status: 400,
    method: "DELETE",
    path: "/api/share-investments/19",
    rawBody: '{"detail":"Aksjeposten har registrerte transaksjoner og kan ikke slettes."}',
    problem: { detail: "Aksjeposten har registrerte transaksjoner og kan ikke slettes." },
  });
  const delCtx = ctxFor([hasEvents]);
  const delres = await tool("reai_delete_share_investment").handler({ id: 19 }, delCtx.ctx);
  assert.equal(delres.isError, true);
  assert.match(textOf(delres), /refusal is final/);
  assert.match(textOf(delres), /opening balance/, "the cause is usually a decision taken at creation");
  assert.match(textOf(delres), /reai_list_share_investment_events/);

  // Anything else must propagate rather than be explained as one of these two.
  const other = new ReaiApiError({ status: 400, method: "DELETE", path: "/api/share-investments/19", rawBody: '{"detail":"Something else"}' });
  await assert.rejects(() => tool("reai_delete_share_investment").handler({ id: 19 }, ctxFor([other]).ctx), /Something else/);
});

test("update merges, and requires the field the document does not admit is required", async () => {
  // Measured: PUT {name} is refused for instrumentType, which `required` does not list; and a body of
  // name+instrumentType set ticker to null by omission.
  const { ctx, sent } = ctxFor([
    { status: 200, data: { ...POSITION } },
    { status: 200, data: { ...POSITION, name: "Renamed AS" } },
  ]);
  const res = await tool("reai_update_share_investment").handler({ id: 19, name: "Renamed AS" }, ctx);
  assert.notEqual(res.isError, true, textOf(res));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body.instrumentType, "LISTED_SHARE", "carried back, or the API refuses the write");
  assert.equal(sent[1].body.ticker, "ZZ", "carried back, or a replacing PUT erases it");
  assert.match(textOf(res), /written back unchanged/);
  assert.match(textOf(res), /Nothing here changes what the position holds/);

  // An unreadable record must stop the write, because the PUT replaces.
  const blind = ctxFor([{ status: 200, data: "not a record" }]);
  const refused = await tool("reai_update_share_investment").handler({ id: 19, name: "X" }, blind.ctx);
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /REPLACES/);
  assert.equal(blind.sent.length, 1);
});

test("the event list explains why a position is undeletable, including the invisible opening purchase", async () => {
  const { ctx } = ctxFor([
    { status: 200, data: [
      { id: 42, eventType: "PURCHASE", eventDate: "2026-01-02", quantity: 100, voucherId: null },
      { id: 43, eventType: "DIVIDEND", eventDate: "2026-06-01", amount: 1000, voucherId: 30997 },
    ] },
  ]);
  const text = textOf(await tool("reai_list_share_investment_events").handler({ id: 19 }, ctx));
  assert.match(text, /2 event\(s\)/);
  assert.match(text, /1 of them booked a ledger voucher/);
  assert.match(text, /opening balance given at creation looks like/);
  assert.match(text, /cannot be deleted/);

  // No events is the deletable state, and worth saying so plainly.
  const empty = ctxFor([{ status: 200, data: [] }]);
  assert.match(textOf(await tool("reai_list_share_investment_events").handler({ id: 19 }, empty.ctx)), /still deletable/);
});

test("query filters the position list locally, because the endpoint takes no parameters", async () => {
  const rows = [
    { ...POSITION, id: 1, name: "Alpha AS", ticker: "ALP" },
    { ...POSITION, id: 2, name: "Beta AS", ticker: "BET" },
  ];
  const { ctx, sent } = ctxFor([{ status: 200, data: rows }]);
  const res = await tool("reai_list_share_investments").handler({ query: "beta" }, ctx);
  assert.match(textOf(res), /1 share investment\(s\)/);
  assert.match(textOf(res), /filtered locally/);
  assert.equal(sent[0].query, undefined, "this endpoint takes no parameters");
  assert.match(textOf(res), /Beta AS/);
  assert.doesNotMatch(textOf(res), /Alpha AS/);
});

test("an unexpected list shape is not reported as an empty portfolio", async () => {
  const { ctx } = ctxFor([{ status: 200, data: { content: [POSITION] } }]);
  const text = textOf(await tool("reai_list_share_investments").handler({}, ctx));
  assert.doesNotMatch(text, /No share investments are recorded/);
  assert.match(text, /did not return a list/);
  assert.match(text, /Zz Holding AS/);
});

test("the Nordnet bulk import is deliberately not curated", () => {
  // One call, an unknown number of events, every one of them a posting and every position it touches made
  // permanent. Recorded as a decision rather than an oversight, next to the reasoning in the module doc.
  const names = registeredTools.map((t) => t.name);
  assert.ok(!names.some((n) => /nordnet/i.test(n)), "no curated Nordnet import");
  assert.match(
    tool("reai_create_share_investment").description + tool("reai_add_share_investment_event").description,
    /ledger/,
  );
});
