import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { expenseTools } from "../dist/tools/expenses.js";
import { registeredTools, destructiveHintFor } from "../dist/server.js";
import { classifyRequest, classifyTransmission } from "../dist/policy.js";
import { quirksFor } from "../dist/reai/quirks.js";

const tool = (name) => {
  const found = expenseTools.find((t) => t.name === name);
  assert.ok(found, `${name} is not registered`);
  return found;
};

/** Arguments go through the tool's own schema first, as a real client's would. */
async function run(name, args, responses, { status = 200 } = {}) {
  const calls = [];
  const validated = z.object(tool(name).inputSchema).parse({ tenantId: 2783, ...args });
  const result = await tool(name).handler(validated, {
    client: {
      request: async (req) => {
        calls.push(req);
        return {
          data: typeof responses === "function" ? responses(req, calls.length) : responses,
          status,
        };
      },
      deepLink: () => "link",
    },
    config: { writeMode: "full", tenantId: 2783, allowExternalSend: false },
    session: {},
  });
  return { calls, result, text: result.content.find((c) => c.type === "text").text };
}

const expense = (overrides = {}) => ({
  id: 2199,
  number: 1,
  title: "Zz Expense",
  status: "open",
  employeeId: 1028,
  travel: false,
  includedInPayslip: false,
  totalAmount: 500,
  voucherId: null,
  costs: [{ id: 3316, date: "2026-08-08", description: "Zz taxi", amount: 500, category: "taxi" }],
  perDiems: [],
  mileageAllowances: [],
  ...overrides,
});

const NAMES = [
  "reai_get_expense",
  "reai_create_expense",
  "reai_update_expense",
  "reai_deliver_expense",
  "reai_approve_expense",
  "reai_unapprove_expense",
  "reai_book_expense_voucher",
  "reai_delete_expense_voucher",
  "reai_reverse_expense",
];

test("all nine expense tools are registered", () => {
  const registered = new Set(registeredTools.map((t) => t.name));
  for (const name of NAMES) assert.ok(registered.has(name), name);
  assert.equal(expenseTools.length, 9);
});

test("the read is a read and every write is irreversible, matching the policy", () => {
  assert.equal(tool("reai_get_expense").risk, "read");
  for (const name of NAMES.filter((n) => n !== "reai_get_expense")) {
    assert.equal(tool(name).risk, "irreversible", name);
    assert.equal(destructiveHintFor(tool(name)), true, name);
  }
  // And the policy agrees for every path they declare — a tool must never be softer than its
  // endpoints. Judged per METHOD, not per tool: reai_unapprove_expense declares the GET it reads
  // before writing, and a GET is a read however irreversible the tool as a whole is.
  for (const name of NAMES) {
    for (const [method, path] of tool(name).apiPaths) {
      const policy = classifyRequest(method, path.replace(/\{[^}]+\}/g, "1"));
      if (method === "GET") assert.equal(policy, "read", `${method} ${path}`);
      else assert.equal(policy, "irreversible", `${method} ${path}`);
    }
  }
  // The read-before-write tools, stated so a later edit cannot quietly drop the read.
  assert.deepEqual(
    tool("reai_unapprove_expense").apiPaths.map(([m]) => m),
    ["GET", "POST"],
  );
  assert.deepEqual(
    tool("reai_get_expense").apiPaths.map(([m, p]) => `${m} ${p}`),
    ["GET /api/expenses/{id}", "GET /api/expenses"],
  );
});

test("nothing here transmits, so no expense tool can leave the tenant", () => {
  for (const name of NAMES) {
    for (const [method, path] of tool(name).apiPaths) {
      assert.equal(
        classifyTransmission(method, path.replace(/\{[^}]+\}/g, "1"), undefined),
        "none",
        `${method} ${path}`,
      );
    }
  }
});

// The trap the tools exist to close: a reversed expense keeps its old status and vanishes from the
// list, and ?status=reversed is rejected — so a detail read alone cannot tell you.
test("a reversed expense is identified by its absence from the filtered list", async () => {
  const { calls, text } = await run("reai_get_expense", { id: 2199 }, (req) =>
    req.path === "/api/expenses/2199" ? expense() : [{ id: 2200 }, { id: 2201 }],
  );
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ["GET /api/expenses/2199", "GET /api/expenses"],
  );
  // Filtered by the expense's OWN status and employee, so the list stays small.
  assert.equal(calls[1].query.status, "open");
  assert.equal(calls[1].query.employeeIds, "1028");
  assert.match(text, /HAS BEEN REVERSED/);
  assert.match(text, /can no longer be delivered/);
});

test("an expense present in the list is reported as not reversed", async () => {
  const { text } = await run("reai_get_expense", { id: 2199 }, (req) =>
    req.path === "/api/expenses/2199" ? expense() : [{ id: 2199 }],
  );
  assert.match(text, /Not reversed/);
  assert.ok(!/HAS BEEN REVERSED/.test(text));
});

test("a failed confirmation says unknown rather than implying the expense is live", async () => {
  const { text } = await run("reai_get_expense", { id: 2199 }, (req) => {
    if (req.path === "/api/expenses/2199") return expense();
    throw new Error("list unavailable");
  });
  assert.match(text, /could not be established/);
  assert.match(text, /rather than as live/);
  assert.ok(!/Not reversed/.test(text));
});

test("a status the filter would reject is not sent as a filter at all", async () => {
  // ?status=<anything else> answers 400, so asking would prove nothing and lose the read.
  const { calls, text } = await run("reai_get_expense", { id: 2199 }, (req) =>
    req.path === "/api/expenses/2199" ? expense({ status: "something_new" }) : [],
  );
  assert.equal(calls.length, 1, "no list call may be attempted for an unknown status");
  assert.match(text, /not one this server has seen/);
});

test("a booked expense is reported as being in the ledger, since status will not say so", async () => {
  const { text } = await run("reai_get_expense", { id: 2199 }, (req) =>
    req.path === "/api/expenses/2199"
      ? expense({ status: "approved", voucherId: 30797, voucherNumber: "EX1-2026" })
      : [{ id: 2199 }],
  );
  assert.match(text, /voucher 30797 is posted/);
  assert.match(text, /IS in the ledger/);
  assert.match(text, /does not say "booked"/);
});

test("an approved expense with no voucher is reported as not posted", async () => {
  const { text } = await run("reai_get_expense", { id: 2199 }, (req) =>
    req.path === "/api/expenses/2199" ? expense({ status: "approved" }) : [{ id: 2199 }],
  );
  assert.match(text, /no voucher yet: nothing is in the ledger/);
});

test("an expense already on a payslip says so, because changing it changes someone's pay", async () => {
  const { text } = await run("reai_get_expense", { id: 2199 }, (req) =>
    req.path === "/api/expenses/2199" ? expense({ includedInPayslip: true }) : [{ id: 2199 }],
  );
  assert.match(text, /picked up by a payroll run/);
});

// travel=false with per-diems is refused locally: the API's own message is about the row rather
// than the combination, and the fix is to flip `travel` or move the amounts.
test("per-diems on a non-travel claim are refused before anything is sent", async () => {
  for (const extra of [
    { perDiems: [{ dateFrom: "2026-08-08", tripType: "day_trip_over_12_hours" }] },
    { mileageAllowances: [{ date: "2026-08-08", kilometers: 12 }] },
  ]) {
    const { calls, result, text } = await run(
      "reai_create_expense",
      { title: "Zz", travel: false, ...extra },
      expense(),
    );
    assert.equal(calls.length, 0, JSON.stringify(extra));
    assert.equal(result.isError, true);
    assert.match(text, /only allowed on a TRAVEL claim/);
  }
});

test("the same rows are accepted on a travel claim", async () => {
  const { calls } = await run(
    "reai_create_expense",
    {
      title: "Zz trip",
      travel: true,
      perDiems: [{ dateFrom: "2026-08-08", tripType: "day_trip_over_12_hours" }],
    },
    expense({ travel: true }),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.travel, true);
});

// category is optional to create and required to deliver, and the API's message names no row.
test("a cost row with no category is flagged at create, before delivering fails", async () => {
  const { text } = await run(
    "reai_create_expense",
    { title: "Zz", travel: false, employeeId: 1, costs: [{ date: "2026-08-08", amount: 100 }] },
    expense({ costs: [{ id: 1, date: "2026-08-08", amount: 100, category: null }] }),
    { status: 201 },
  );
  assert.match(text, /1 cost row\(s\) have no category/);
  assert.match(text, /Kategori må velges/);
  assert.match(text, /does not say which row/);
});

test("a create with no employee says it cannot be delivered yet", async () => {
  const { text } = await run(
    "reai_create_expense",
    { title: "Zz", travel: false },
    expense({ employeeId: null }),
    { status: 201 },
  );
  assert.match(text, /cannot be delivered yet/);
});

test("the category argument is an enum, so a wrong value fails locally", () => {
  const shape = tool("reai_create_expense").inputSchema;
  const line = { date: "2026-08-08", amount: 1 };
  assert.equal(z.object(shape).safeParse({ title: "x", travel: false, costs: [{ ...line, category: "taxi" }] }).success, true);
  assert.equal(z.object(shape).safeParse({ title: "x", travel: false, costs: [{ ...line, category: "taxicab" }] }).success, false);
});

// Scalars patch, arrays replace, in the same request.
test("sending a line array is reported as a REPLACEMENT with the resulting counts", async () => {
  const { text } = await run(
    "reai_update_expense",
    { id: 2199, costs: [{ date: "2026-08-08", amount: 100, category: "taxi" }] },
    expense({ totalAmount: 100, costs: [{ id: 9, category: "taxi" }] }),
  );
  assert.match(text, /costs was sent, so that list was REPLACED/);
  assert.match(text, /1 cost row\(s\)/);
  assert.match(text, /send the whole set again/);
});

test("a scalar-only update is not described as replacing anything", async () => {
  const { text } = await run("reai_update_expense", { id: 2199, title: "Zz new" }, expense());
  assert.ok(!/REPLACED/.test(text), "nothing was replaced, so nothing should say so");
});

test("an empty update is refused rather than sent", async () => {
  const { calls, result, text } = await run("reai_update_expense", { id: 2199 }, expense());
  assert.equal(calls.length, 0);
  assert.equal(result.isError, true);
  assert.match(text, /nothing to change/);
});

// Unapproving with a voucher present answers 409. The tool reads first so the message names the
// voucher to delete rather than relaying Norwegian.
test("unapproving a booked expense is refused locally, naming the voucher", async () => {
  const { calls, result, text } = await run("reai_unapprove_expense", { id: 2199 }, (req) =>
    req.method === "GET" ? expense({ status: "approved", voucherId: 30797, voucherNumber: "EX1-2026" }) : {},
  );
  assert.deepEqual(calls.map((c) => c.method), ["GET"], "no unapprove may be sent");
  assert.equal(result.isError, true);
  assert.match(text, /booked to voucher 30797/);
  assert.match(text, /EX1-2026/);
  assert.match(text, /reai_delete_expense_voucher/);
});

test("unapproving an unbooked expense goes through", async () => {
  const { calls } = await run("reai_unapprove_expense", { id: 2199 }, (req) =>
    req.method === "GET" ? expense({ status: "approved" }) : expense({ status: "for_approval" }),
  );
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ["GET /api/expenses/2199", "POST /api/expenses/2199/unapprove"],
  );
});

test("booking reports the voucher, and that the status will not mention it", async () => {
  const { text } = await run("reai_book_expense_voucher", { id: 2199 }, {
    expenseId: 2199,
    voucherId: 30797,
    voucherNumber: "EX1-2026",
    voucherDate: "2026-08-08",
  });
  assert.match(text, /voucher 30797 \(EX1-2026\)/);
  assert.match(text, /in the ledger now/);
  assert.match(text, /never says "booked"/);
});

test("a booking that returns no voucherId is reported as unknown, not as success", async () => {
  // Saying "posted" here and then booking again is how an expense gets two vouchers.
  for (const data of [{}, null, { expenseId: 2199 }]) {
    const { text } = await run("reai_book_expense_voucher", { id: 2199 }, data);
    assert.match(text, /no voucherId came back/, JSON.stringify(data));
    assert.match(text, /a second call would post a second voucher/);
  }
});

test("the voucher delete reads its outcome instead of trusting the status", async () => {
  const deleted = await run("reai_delete_expense_voucher", { id: 2199 }, { outcome: "deleted" });
  assert.match(deleted.text, /DELETED outright/);
  assert.match(deleted.text, /can be booked again/);

  const reversed = await run("reai_delete_expense_voucher", { id: 2199 }, { outcome: "reversed" });
  assert.match(reversed.text, /REVERSED, not deleted/);
  assert.match(reversed.text, /POSTS to the ledger/);
  assert.match(reversed.text, /Two entries now exist/);
  assert.ok(!/DELETED outright/.test(reversed.text));

  for (const data of [{}, null, { outcome: "something" }]) {
    const { text } = await run("reai_delete_expense_voucher", { id: 2199 }, data);
    assert.match(text, /no recognised outcome/, JSON.stringify(data));
  }
});

test("reversing says the record stays and that no field will show it", async () => {
  const { calls, text } = await run("reai_reverse_expense", { id: 2199 }, { outcome: "reversed" });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["DELETE /api/expenses/2199"]);
  assert.match(text, /is reversed/);
  assert.match(text, /no longer appear in reai_list_expenses/);
  assert.match(text, /still return it with its old status/);
});

test("a reversal that answers something else is not reported as reversed", async () => {
  const { text } = await run("reai_reverse_expense", { id: 2199 }, { outcome: "deleted" });
  assert.match(text, /rather than "reversed"/);
  assert.match(text, /read it back before assuming/);
});

test("the measured expense quirks reach the operations that meet them", () => {
  const ids = (m, p) => quirksFor(m, p).map((q) => q.id);
  assert.ok(ids("GET", "/api/expenses/{id}").includes("expense-status-never-says-booked-or-reversed"));
  assert.ok(ids("PATCH", "/api/expenses/{id}").includes("expense-line-arrays-are-complete-lists"));
  assert.ok(ids("POST", "/api/expenses/{id}/voucher").includes("booking-an-expense-approves-it-too"));
  for (const m of ["POST", "PATCH"]) {
    assert.ok(
      ids(m, m === "POST" ? "/api/expenses" : "/api/expenses/{id}").includes(
        "expense-category-optional-to-create-required-to-deliver",
      ),
      m,
    );
  }
  // The overview quirk must not imply /approve is required, now that booking is known to approve.
  const overview = quirksFor("POST", "/api/expenses/{id}/approve").find((q) => q.id === "expense-lifecycle");
  assert.ok(overview, "the lifecycle overview should still cover /approve");
  assert.match(overview.note, /does NOT need \/approve first/);
});

test("the tool text names the ledger consequence and the reversal blindness", () => {
  const all = NAMES.map((n) => tool(n).description).join("\n");
  assert.match(all, /POST THE EXPENSE TO THE LEDGER/);
  assert.match(all, /Kategori må velges/);
  assert.match(all, /complete/i);
  assert.match(all, /outcome/);
});
