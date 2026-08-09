// Share investments. Everything asserted here was measured against the write test tenant before it was
// written down — the module doc in src/tools/investments.ts records the measurements themselves, and one
// of them cost an unremovable record, which is why the create tool refuses an opening balance by default.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
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
  // NOT asserting `destructive: true` on the event tool. Review showed the flag changes nothing for an
  // irreversible tool — `destructiveHintFor` already returns true — and that no other ledger-posting POST
  // in this repo carries it. What matters is the hint the client actually receives, so that is what this
  // asserts instead.
  const { destructiveHintFor } = await import("../dist/server.js");
  if (typeof destructiveHintFor === "function") {
    assert.equal(destructiveHintFor(tool("reai_add_share_investment_event")), true);
  }
  assert.equal(tool("reai_add_share_investment_event").destructive, undefined);
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
  assert.match(text, /1 of them report a ledger voucher/);
  assert.match(text, /one way to get it, and not the only/, "the cause is offered, not asserted");
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

test("the Nordnet import is uncurated on the record, not by omission", async () => {
  // The first version of this test asserted that no tool name matches /nordnet/i and that the word
  // "ledger" appears somewhere in two unrelated descriptions. Review called it vacuous and was right:
  // neither half would fail if the reasoning were deleted, which is the only thing that makes an absence
  // a decision. So it asserts the reasoning survives, in the file a maintainer would read.
  const { readFileSync } = await import("node:fs");
  assert.ok(!registeredTools.some((t) => /nordnet/i.test(t.name)), "no curated Nordnet import");
  const source = readFileSync(new URL("../src/tools/investments.ts", import.meta.url), "utf8");
  const section = /## Nordnet import[\s\S]*?\*\//.exec(source)?.[0] ?? "";
  assert.ok(section, "the module doc must carry the reasoning for leaving it out");
  assert.match(section, /bulk|unknown number/i, "why one call is different from one posting");
  assert.match(section, /permanent/i);
  // And the claim that was corrected: reai_request cannot send multipart, so it is NOT a way in.
  assert.match(section, /multipart/i, "the reachability claim has to be the true one");
});

test("update refuses when a required field is missing from both the change and the record", () => {
  // Named but untested before: the merge test only proved instrumentType was carried BACK. Deleting it
  // from INVESTMENT_REQUIRED, or removing the refusal branch entirely, passed the whole suite.
  const REQUIRED_CASES = [
    [{ id: 19, name: "X" }, { id: 19, name: "old" }, "instrumentType"],
    [{ id: 19, instrumentType: "BOND" }, { id: 19, instrumentType: "LISTED_SHARE" }, "name"],
  ];
  return Promise.all(
    REQUIRED_CASES.map(async ([changes, record, missing]) => {
      const { ctx, sent } = ctxFor([{ status: 200, data: record }]);
      const res = await tool("reai_update_share_investment").handler(changes, ctx);
      assert.equal(res.isError, true, `a record with no ${missing} must not be written`);
      assert.match(textOf(res), new RegExp(missing));
      assert.match(textOf(res), /required in fact/);
      assert.equal(sent.length, 1, "nothing may be written");
    }),
  );
});

test("update writes exactly the fields it is allowed to, and no derived ones", async () => {
  // The stronger assertion the repo already uses for the address tool: the whole key set, not two fields.
  // It is what catches a derived field being echoed into a replacing PUT, and an opening field slipping
  // into the merge vocabulary.
  const { ctx, sent } = ctxFor([
    { status: 200, data: { ...POSITION } },
    { status: 200, data: { ...POSITION, name: "Renamed" } },
  ]);
  await tool("reai_update_share_investment").handler({ id: 19, name: "Renamed" }, ctx);
  const body = sent.find((x) => x.method === "PUT").body;
  assert.deepEqual(
    Object.keys(body).sort(),
    ["assetAccountNumber", "instrumentType", "name", "ticker", "withinExemptionMethod"].sort(),
    "quantity, costPrice, status and currency are derived and must never be sent; neither may an opening field",
  );
});

test("an envelope response stops the write, not just a non-object", async () => {
  // The previous version passed `"not a record"`, which fails readableRecord's !isObject branch whatever
  // the expect-list says — so it never exercised the guard it appeared to. The dangerous shape is the
  // envelope, which readableRecord's own docstring records producing a destructive PUT on a live tenant.
  for (const data of [{ data: { ...POSITION } }, { content: [POSITION] }, {}]) {
    const { ctx, sent } = ctxFor([{ status: 200, data }]);
    const res = await tool("reai_update_share_investment").handler({ id: 19, name: "X" }, ctx);
    assert.equal(res.isError, true, `envelope ${JSON.stringify(data).slice(0, 30)} must stop the write`);
    assert.match(textOf(res), /REPLACES/);
    assert.equal(sent.length, 1, "nothing may be written");
  }
});

test("an absent exemption flag or asset account is reported as unknown, not as a fact", async () => {
  // The repo's named defect class, and this file had it twice: a bare ternary read an ABSENT
  // withinExemptionMethod as "outside the exemption method" — a tax classification asserted from a
  // missing field — and `?? "none"` turned a missing account into a claim about state.
  const { ctx } = ctxFor([{ status: 200, data: { id: 19, name: "Acme AS", instrumentType: "LISTED_SHARE" } }]);
  const text = textOf(await tool("reai_get_share_investment").handler({ id: 19 }, ctx));
  assert.doesNotMatch(text, /outside the exemption method/);
  assert.doesNotMatch(text, /Asset account none/);
  assert.match(text, /carries no assetAccountNumber/);

  // A stored false IS a fact and must still be reported.
  const explicit = ctxFor([{ status: 200, data: { ...POSITION, withinExemptionMethod: false } }]);
  assert.match(textOf(await tool("reai_get_share_investment").handler({ id: 19 }, explicit.ctx)), /outside the exemption method/);
});

test("the create translates the settlement-account refusal its own opening balance can provoke", async () => {
  // An accepted opening balance IS an event, so this path can hit the refusal the event tool translates.
  // Before this, the caller who acknowledged permanence in writing got raw Norwegian back.
  const err = new ReaiApiError({
    status: 400,
    method: "POST",
    path: "/api/share-investments",
    rawBody: '{"detail":"Velg verdipapirkontoen transaksjonen ble gjort opp mot."}',
    problem: { detail: "Velg verdipapirkontoen transaksjonen ble gjort opp mot." },
  });
  const { ctx } = ctxFor([err]);
  const res = await tool("reai_create_share_investment").handler(
    { ...CREATE_ARGS, openingQuantity: 100, openingCostAmount: 5000, openingDate: "2026-01-02", acceptPermanentPosition: true },
    ctx,
  );
  assert.equal(res.isError, true);
  assert.match(textOf(res), /companyBankId/);
  assert.match(textOf(res), /OPENING BALANCE/);
});

test("the query filter searches every field it claims to", async () => {
  // Dropping isin or instrumentType from the filter, or swapping includes for startsWith, all survived.
  const rows = [
    { ...POSITION, id: 1, name: "Alpha", ticker: "ALP", isin: "NO0010000001", instrumentType: "FUND" },
    { ...POSITION, id: 2, name: "Beta", ticker: "BET", isin: "NO0010000002", instrumentType: "BOND" },
  ];
  for (const [needle, wanted] of [["no0010000001", "Alpha"], ["fund", "Alpha"], ["bet", "Beta"], ["eta", "Beta"]]) {
    const { ctx } = ctxFor([{ status: 200, data: rows }]);
    const text = textOf(await tool("reai_list_share_investments").handler({ query: needle }, ctx));
    assert.match(text, /1 share investment\(s\)/, `"${needle}" should match exactly one`);
    assert.match(text, new RegExp(wanted), `"${needle}" should find ${wanted} — mid-string too`);
  }
});

test("an event with no voucher is unconfirmed, not classified as an opening balance", async () => {
  // The list called a voucherless PURCHASE an opening balance. Absence of a voucherId only means the
  // posting is unconfirmed — the add-event handler says exactly that about the same shape.
  const { ctx } = ctxFor([{ status: 200, data: [{ id: 43, eventType: "PURCHASE", eventDate: "2026-06-01", voucherId: null }] }]);
  const text = textOf(await tool("reai_list_share_investment_events").handler({ id: 19 }, ctx));
  assert.match(text, /1 event\(s\)/);
  assert.match(text, /UNCONFIRMED/, "absence of a voucherId is an unknown, not a classification");
  assert.doesNotMatch(text, /is what an opening balance/, "it must not assert the cause it cannot know");
  assert.match(text, /cannot be deleted/, "the position is still permanent, whatever the voucher says");
});

test("the delete succeeds loudly when there are no events", async () => {
  // Only the error path was covered.
  const { ctx, sent } = ctxFor([{ status: 204, data: undefined }]);
  const res = await tool("reai_delete_share_investment").handler({ id: 19 }, ctx);
  assert.notEqual(res.isError, true, textOf(res));
  assert.equal(sent[0].method, "DELETE");
  assert.equal(sent[0].path, "/api/share-investments/19");
  assert.match(textOf(res), /had no events/);
});

test("a negative quantity cannot become a permanent event", async () => {
  // Unbounded in the document, and an event cannot be deleted, so a negative-unit PURCHASE would be
  // permanent. Refused locally, and recorded as a local decision rather than a documented bound.
  const schema = tool("reai_add_share_investment_event").inputSchema;
  const { z } = await import("zod");
  const parsed = z.object(schema).safeParse({
    id: 19, eventType: "PURCHASE", eventDate: "2026-06-01", amount: 1000, companyBankId: 1, quantity: -5,
  });
  assert.equal(parsed.success, false, "a negative quantity must not reach a permanent event");
  const okParse = z.object(schema).safeParse({
    id: 19, eventType: "PURCHASE", eventDate: "2026-06-01", amount: 1000, companyBankId: 1, quantity: 5,
  });
  assert.equal(okParse.success, true);
});

test("the update path cannot express an opening balance, even when handed one", async () => {
  // The gate on `reai_create_share_investment` is worth nothing if the update can do the same thing
  // unguarded. Verified through the real server, zod strips an undeclared argument and the PUT body is
  // clean — but that leaves the guarantee resting on validation defaults, so the merge vocabulary itself
  // must not contain the opening fields. This drives the handler DIRECTLY, which is the layer where the
  // difference shows.
  const { ctx, sent } = ctxFor([
    { status: 200, data: { ...POSITION } },
    { status: 200, data: { ...POSITION, name: "Renamed" } },
  ]);
  await tool("reai_update_share_investment").handler(
    { id: 19, name: "Renamed", openingQuantity: 100, openingCostAmount: 5000, openingDate: "2026-01-02" },
    ctx,
  );
  const put = sent.find((s) => s.method === "PUT");
  assert.ok(put, "the write should still happen");
  for (const field of ["openingQuantity", "openingCostAmount", "openingDate"]) {
    assert.ok(!(field in put.body), `${field} must not reach the API through the update path`);
  }
});

test("reclassifying a position will not leave it booked where the old type belonged", async () => {
  // Codex raised this as documentation; measuring it made it behaviour. A LISTED_SHARE position on 1810
  // was changed to BOND, FUND, UNLISTED_SHARE and OTHER in turn — every PUT answered 200 and the account
  // stayed 1810 — while fresh positions of those types derive 1830, 1810, 1350 and 1820. The merge doing
  // its job is what carries the wrong account across, exactly as on a loan reclassification.
  const { ctx, sent } = ctxFor([{ status: 200, data: { ...POSITION } }]);
  const res = await tool("reai_update_share_investment").handler({ id: 19, instrumentType: "BOND" }, ctx);
  assert.equal(res.isError, true);
  assert.match(textOf(res), /1830/, "the refusal must name what a fresh BOND derives");
  assert.match(textOf(res), /1810/, "and where the position would otherwise stay");
  assert.equal(sent.length, 1, "nothing may be written");

  // Naming an account is the caller taking the decision.
  const ok = ctxFor([
    { status: 200, data: { ...POSITION } },
    { status: 200, data: { ...POSITION, instrumentType: "BOND", assetAccountNumber: "1830" } },
  ]);
  const second = await tool("reai_update_share_investment").handler(
    { id: 19, instrumentType: "BOND", assetAccountNumber: "1830" },
    ok.ctx,
  );
  assert.notEqual(second.isError, true, textOf(second));
  assert.equal(ok.sent[1].body.assetAccountNumber, "1830");

  // Restating the type it already has is not a change, so it must not be refused.
  const same = ctxFor([
    { status: 200, data: { ...POSITION } },
    { status: 200, data: { ...POSITION, name: "Renamed" } },
  ]);
  const third = await tool("reai_update_share_investment").handler(
    { id: 19, instrumentType: "LISTED_SHARE", name: "Renamed" },
    same.ctx,
  );
  assert.notEqual(third.isError, true, textOf(third));
  assert.equal(same.sent.length, 2, "an idempotent restatement should still write");
});

test("every instrument type has a measured asset account, or the refusal cannot help", async () => {
  // The refusal is only useful because it can name the right number. If a type is missing from the table
  // the message degrades to "pass it explicitly", which is the state this test exists to notice.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/tools/investments.ts", import.meta.url), "utf8");
  const table = /DERIVED_ASSET_ACCOUNTS[\s\S]*?\};/.exec(source)?.[0] ?? "";
  assert.ok(table, "the measured table must exist");
  for (const type of ["LISTED_SHARE", "UNLISTED_SHARE", "FUND", "BOND", "OTHER"]) {
    assert.match(table, new RegExp(`${type}:\\s*"\\d{4}"`), `${type} needs a measured account`);
  }
});

test("reai_create_share_investment names the instrument type the record stored", async () => {
  // One of nine enum fields the behavioural sweep cannot judge: their value is a WORD, so a note may print a
  // label derived from it and an echo looks identical to a read-back. All nine were driven by hand with a
  // response naming a DIFFERENT member; this tool already reported from the record, and this test says so
  // rather than leaving the claim resting on a probe nobody kept.
  const { ctx } = ctxFor([{ data: { ...POSITION, id: 77, instrumentType: "UNLISTED_SHARE" }, status: 200 }]);
  const res = await tool("reai_create_share_investment").handler(
    { name: "Zz Holding AS", instrumentType: "LISTED_SHARE", tenantId: 2783 },
    ctx,
  );
  const text = textOf(res).split("\n\n")[0];
  assert.match(text, /UNLISTED_SHARE/, `the stored member, not the sent one: ${text}`);
  // A boundary BEFORE the token: "LISTED_SHARE" is a substring of "UNLISTED_SHARE", so the obvious negative
  // assertion matches the correct note and fails it. Fifth regex-scoping slip in this line of work.
  assert.doesNotMatch(text, /(^|[^A-Z_])LISTED_SHARE/, `the sent member must not appear: ${text}`);
});

/**
 * The arguments this tool actually declares.
 *
 * Validated through its own schema, because the first version of the test below did not: it passed
 * `investmentId`, which is not a key this tool accepts, and omitted the required `amount` and `companyBankId`.
 * The handler therefore requested `/api/share-investments/undefined/events` and reported "recorded on share
 * investment undefined" — and the test passed anyway, because it only grepped for /SALE/.
 */
const EVENT_ARGS = {
  id: 19,
  eventType: "PURCHASE",
  eventDate: "2026-08-09",
  amount: 5000,
  companyBankId: 3,
  quantity: 10,
  pricePerUnit: 100,
  tenantId: 2783,
};

test("reai_add_share_investment_event names the event type the record stored", async () => {
  // reai_add_share_investment_event: one of the nine enum fields the sweep cannot judge. A PURCHASE reported as
  // a SALE is a sign error on a position, and this tool posts to the ledger.
  const { ctx, sent } = ctxFor([
    { data: { id: 88, eventType: "SALE", eventDate: "2026-08-10", quantity: 10 }, status: 200 },
  ]);
  const res = await tool("reai_add_share_investment_event").handler(
    z.object(tool("reai_add_share_investment_event").inputSchema).parse(EVENT_ARGS),
    ctx,
  );
  assert.match(sent[0].path, /share-investments\/19\/events/, `the id must reach the path: ${sent[0].path}`);
  const text = textOf(res).split("\n\n")[0];
  assert.match(text, /SALE on 2026-08-10, read back from the response/, text);
  assert.doesNotMatch(text, /PURCHASE/);
});

test("an event the response does not describe is not reported as the event that was sent", async () => {
  // reai_add_share_investment_event: `?? args.eventType` fell back to the REQUEST and stated it as fact. A
  // response carrying only {id, voucherId} produced "recorded on share investment 19: PURCHASE on 2026-08-09"
  // with no hedge — irreversible, and once it posts the voucher can only be reversed, never deleted.
  const { ctx } = ctxFor([{ data: { id: 88, voucherId: 5 }, status: 200 }]);
  const res = await tool("reai_add_share_investment_event").handler(
    z.object(tool("reai_add_share_investment_event").inputSchema).parse(EVENT_ARGS),
    ctx,
  );
  const text = textOf(res).split("\n\n")[0];
  assert.match(text, /sent as PURCHASE on 2026-08-09/);
  assert.match(text, /carries neither the type nor the date/);
  assert.match(text, /not confirmed here/);
  assert.doesNotMatch(text, /read back from the response/);
});
