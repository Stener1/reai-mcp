import { test } from "node:test";
import assert from "node:assert/strict";
import { salaryTools } from "../dist/tools/salary.js";
import { registeredTools, destructiveHintFor } from "../dist/server.js";
import { classifyRequest, classifyTransmission } from "../dist/policy.js";
import { quirksFor } from "../dist/reai/quirks.js";
import { resolveOperation } from "../dist/reai/spec.js";
import { z } from "zod";

const tool = (name) => {
  const found = salaryTools.find((t) => t.name === name);
  assert.ok(found, `${name} is not registered`);
  return found;
};

/**
 * Drives a tool the way a client does: the arguments go through the tool's own input schema first.
 *
 * Not a formality. Calling `handler` directly accepts any argument names at all, and a test written
 * against invented ones passes while the real tool rejects them — which happened: this file
 * exercised `reai_create_salary_run` with periodFrom/periodTo for a whole iteration, green, and the
 * live run answered "Required at period, Required at paymentDate" the first time a client called it.
 *
 * `responses` may be a function of (request, callNumber) — the delete reads before writing.
 * `raw` skips validation, for the checks that are about what the HANDLER sends regardless of what
 * the schema would have stripped.
 */
async function run(name, args, responses, { status = 200, raw = false } = {}) {
  const calls = [];
  const withTenant = { tenantId: 2783, ...args };
  const validated = raw ? withTenant : z.object(tool(name).inputSchema).parse(withTenant);
  const result = await tool(name).handler(
    validated,
    {
      client: {
        request: async (req) => {
          calls.push(req);
          const data = typeof responses === "function" ? responses(req, calls.length) : responses;
          return { data, status };
        },
        deepLink: () => "link",
      },
      config: { writeMode: "full", tenantId: 2783, allowExternalSend: false },
      session: {},
    },
  );
  return { calls, result, text: result.content.find((c) => c.type === "text").text };
}

/** A run carrying one wage line, which the update tool reads before replacing it. */
const storedLine = (line = {}) => (req) =>
  req.method === "GET"
    ? runRecord({
        employees: [
          {
            employeeId: 987,
            wageSpecs: [
              {
                id: 7,
                specificationCode: "COMMISSION",
                quantity: 1,
                rate: 5000,
                comment: "STORED COMMENT",
                holidayAllowanceEarningYear: null,
                ...line,
              },
            ],
          },
        ],
      })
    : runRecord();

const runRecord = (overrides = {}) => ({
  id: 1360,
  number: "2026-1",
  status: "under_process",
  payableAmount: 0,
  totalTaxDeducted: 0,
  voucherId: null,
  employees: [],
  ...overrides,
});

test("every salary tool is registered on the server and carries a risk", () => {
  const registered = new Map(registeredTools.map((t) => [t.name, t]));
  assert.equal(salaryTools.length, 7);
  for (const t of salaryTools) {
    assert.ok(registered.has(t.name), `${t.name} missing from the server`);
    assert.ok(["read", "reversible", "irreversible"].includes(t.risk), `${t.name}: ${t.risk}`);
  }
});

test("the two reads are reads; everything that changes payroll is irreversible", () => {
  assert.equal(tool("reai_list_salary_runs").risk, "read");
  assert.equal(tool("reai_get_salary_run").risk, "read");
  for (const name of [
    "reai_create_salary_run",
    "reai_add_salary_line",
    "reai_update_salary_line",
    "reai_delete_salary_line",
    "reai_delete_salary_run",
  ]) {
    assert.equal(tool(name).risk, "irreversible", name);
    assert.equal(destructiveHintFor(tool(name)), true, `${name} should hint destructive`);
  }
});

// The whole reason this toolset stops where it does. `/complete` posts the voucher, creates
// payslips, creates one employee payment each and starts the a-melding submission. A curated
// tool for it would be a one-line way to pay people and file with the state, so there isn't one
// — and this test fails if a later edit adds one.
test("no curated salary tool can complete a run or register its payment", () => {
  // An absence claim needs its population pinned, or it is satisfied by there being no salary tools at
  // all — which is how it would read the day the toolset is renamed or fails to register. Emptying the
  // tool corpus left this green, along with twenty-nine other sweeps.
  const salaryTools = registeredTools.filter((t) => (t.apiPaths ?? []).some(([, p]) => /^\/api\/salary/.test(p)));
  assert.ok(salaryTools.length >= 5, `only ${salaryTools.length} salary tools found — the claim below is about nothing`);
  const forbidden = [/\/complete$/, /register-payment$/, /payment-date$/];
  for (const t of registeredTools) {
    for (const [method, path] of t.apiPaths ?? []) {
      for (const re of forbidden) {
        assert.ok(
          !re.test(path),
          `${t.name} reaches ${method} ${path}, which this server deliberately leaves to reai_request`,
        );
      }
    }
  }
});

test("completing a run and filing the a-melding are external transmissions", () => {
  // So `full` write mode alone does not reach them: REAI_ALLOW_EXTERNAL_SEND has to be lifted too.
  assert.equal(
    classifyTransmission("POST", "/api/salary-payments/1360/complete", undefined),
    "external",
  );
  assert.equal(classifyTransmission("POST", "/api/amelding/submit", undefined), "external");
  // Opening or deleting a draft is local accounting, not a transmission.
  assert.equal(classifyTransmission("POST", "/api/salary-payments", undefined), "none");
  assert.equal(classifyTransmission("DELETE", "/api/salary-payments/1360", undefined), "none");
});

test("payroll writes classify as irreversible on the write axis", () => {
  for (const [method, path] of [
    ["POST", "/api/salary-payments"],
    ["POST", "/api/salary-payments/1360/wage-specs"],
    ["PUT", "/api/salary-payments/1360/wage-specs/7"],
    ["DELETE", "/api/salary-payments/1360/wage-specs/7"],
    ["DELETE", "/api/salary-payments/1360"],
  ]) {
    assert.equal(classifyRequest(method, path), "irreversible", `${method} ${path}`);
  }
});

test("a run is created with the dates and employees given, and nothing else", async () => {
  const { calls, text } = await run(
    "reai_create_salary_run",
    { period: "2026-08", paymentDate: "2026-08-31", employeeIds: [987] },
    runRecord(),
    { status: 201 },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/api/salary-payments");
  assert.deepEqual(calls[0].body.employeeIds, [987]);
  assert.equal(calls[0].body.period, "2026-08");
  assert.equal(calls[0].body.paymentDate, "2026-08-31");
  assert.equal(calls[0].tenantId, 2783);
  // The measured facts a caller acts on: it is a draft, and it posted nothing.
  assert.match(text, /under_process/);
  assert.match(text, /voucher/i);
});

test("omitting employeeIds is not passing nobody — the tool says so", () => {
  const t = tool("reai_create_salary_run");
  const described = JSON.stringify(t.inputSchema.employeeIds?._def?.description ?? "");
  assert.match(described + t.description, /every employee|all employees/i);
});

for (const name of ["reai_add_salary_line", "reai_update_salary_line"]) {
  // The update tool reads the line before replacing it, so it needs one to find; the add tool does
  // not read at all and is unaffected by the extra GET response.
  const responses = name === "reai_update_salary_line" ? storedLine() : runRecord();
  test(`${name} refuses holidayAllowanceEarningYear on a non-holiday line without calling out`, async () => {
    const { calls, result, text } = await run(
      name,
      {
        id: 1360,
        wageSpecId: 7,
        employeeId: 987,
        specificationCode: "COMMISSION",
        quantity: 1,
        rate: 5000,
        holidayAllowanceEarningYear: 2025,
      },
      responses,
    );
    assert.ok(
      !calls.some((c) => c.method !== "GET"),
      "nothing may be WRITTEN — only the update tool's read is allowed",
    );
    assert.equal(result.isError, true);
    assert.match(text, /HOLIDAY_ALLOWANCE/);
    assert.match(text, /COMMISSION/);
  });

  test(`${name} lets the field through on a HOLIDAY_ALLOWANCE line`, async () => {
    // The refusal above must be the handler's, not the schema's — a schema that rejected the
    // value would make the explanation unreachable, which has bitten this server twice.
    const parsed = tool(name).inputSchema.holidayAllowanceEarningYear.safeParse(2025);
    assert.equal(parsed.success, true);
    const { calls } = await run(
      name,
      {
        id: 1360,
        wageSpecId: 7,
        employeeId: 987,
        specificationCode: "HOLIDAY_ALLOWANCE",
        quantity: 1,
        rate: 5000,
        holidayAllowanceEarningYear: 2025,
      },
      responses,
    );
    const write = calls.find((c) => c.method !== "GET");
    assert.ok(write, "the value must reach a real request");
    assert.equal(write.body.holidayAllowanceEarningYear, 2025);
  });
}

// Deliberately `raw`: the guarantee is that the HANDLER builds the body field by field, so a
// stray argument cannot ride along even if schema stripping ever stopped catching it.
test("adding a line sends employeeId; updating one must not (measured: 400)", async () => {
  const line = {
    id: 1360,
    wageSpecId: 7,
    employeeId: 987,
    specificationCode: "COMMISSION",
    quantity: 1,
    rate: 5000,
  };
  const added = await run("reai_add_salary_line", line, runRecord(), { raw: true });
  assert.equal(added.calls[0].method, "POST");
  assert.equal(added.calls[0].body.employeeId, 987);
  assert.ok(!("wageSpecId" in added.calls[0].body), "the create takes no line id");

  const updated = await run("reai_update_salary_line", line, storedLine(), { raw: true });
  const put = updated.calls.find((c) => c.method === "PUT");
  assert.ok(put, "the update must issue a PUT");
  assert.equal(put.path, "/api/salary-payments/1360/wage-specs/7");
  assert.ok(
    !("employeeId" in put.body),
    "UpdateSalaryWageSpecReq rejects employeeId — sending it answers 400",
  );
});

test("deleting a run reads its status first and refuses anything but a draft", async () => {
  for (const status of ["unpaid", "complete", "reversed"]) {
    const { calls, result, text } = await run(
      "reai_delete_salary_run",
      { id: 1360 },
      runRecord({ status }),
    );
    assert.equal(calls.length, 1, `${status}: only the read may happen`);
    assert.equal(calls[0].method, "GET");
    assert.equal(result.isError, true);
    assert.match(text, new RegExp(status));
    assert.match(text, /Nothing was\s+deleted/);
    // It says how to proceed deliberately rather than pretending the door is shut.
    assert.match(text, /reai_request DELETE \/api\/salary-payments\/1360/);
  }
});

test("an unreadable run is not assumed to be a draft", async () => {
  for (const data of [undefined, null, "nope", {}, { unrelated: 1 }, []]) {
    const { calls, result, text } = await run("reai_delete_salary_run", { id: 1360 }, data);
    assert.equal(calls.length, 1, `${JSON.stringify(data)}: no DELETE may be issued`);
    assert.equal(result.isError, true);
    assert.match(text, /status is unknown|could not be read/);
  }
});

test("deleting a draft run goes through, and says why the ledger is safe", async () => {
  const { calls, result, text } = await run("reai_delete_salary_run", { id: 1360 }, (req) =>
    req.method === "GET" ? runRecord() : { outcome: "deleted" },
  );
  assert.equal(result.isError, undefined);
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ["GET /api/salary-payments/1360", "DELETE /api/salary-payments/1360"],
  );
  assert.match(text, /ledger is unaffected/);
});

// The status check is a precondition, not a lock: this endpoint takes no version or conditional
// parameter, so a completion landing between the GET and the DELETE turns the same call into a
// REVERSAL, which posts. The API says which of the two happened; the tool has to read it rather
// than repeat what the expired check implied.
test("a run completed between the read and the delete is reported as REVERSED, not safe", async () => {
  const { result, text } = await run("reai_delete_salary_run", { id: 1360 }, (req) =>
    req.method === "GET" ? runRecord() : { outcome: "reversed" },
  );
  assert.equal(result.isError, undefined);
  assert.match(text, /REVERSED, not deleted/);
  assert.match(text, /POSTS\s+TO THE LEDGER/);
  assert.ok(
    !/ledger is unaffected/.test(text),
    "a reversal must never be reported as leaving the ledger untouched",
  );
});

test("an unrecognised delete outcome is reported as unknown rather than as a clean delete", async () => {
  for (const data of [null, {}, { outcome: "something-new" }, { outcome: null }]) {
    const { text } = await run("reai_delete_salary_run", { id: 1360 }, (req) =>
      req.method === "GET" ? runRecord() : data,
    );
    assert.match(text, /no recognised outcome/, JSON.stringify(data));
    assert.ok(!/ledger is unaffected/.test(text), JSON.stringify(data));
  }
});

// The schema says "all employees eligible for the period", which is not the same as the whole
// register — and what makes an employee ineligible is documented nowhere.
test("omitting employeeIds is described as eligible-for-the-period, not as everybody", async () => {
  const t = tool("reai_create_salary_run");
  const described = t.inputSchema.employeeIds._def.description ?? "";
  for (const text of [described, t.description]) {
    assert.match(text, /eligible/i);
  }
  const { text } = await run(
    "reai_create_salary_run",
    { period: "2026-08", paymentDate: "2026-08-31" },
    { ...runRecord(), employeeIds: [987, 988] },
    { status: 201 },
  );
  assert.match(text, /ELIGIBLE/);
  assert.match(text, /2 employee\(s\)/);
  assert.match(text, /987, 988/);
  assert.ok(
    !/EVERY employee/.test(text),
    "the note must not claim the run covers every employee on the books",
  );
});

test("deleting a line hits the line, not the run", async () => {
  const { calls } = await run(
    "reai_delete_salary_line",
    { id: 1360, wageSpecId: 7 },
    runRecord({ payableAmount: 0 }),
  );
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ["DELETE /api/salary-payments/1360/wage-specs/7"],
  );
});

test("the list handler survives a response that is not an array", async () => {
  // The live API has answered with an envelope here before; a `.filter` on that used to throw.
  for (const data of [[], null, { data: [] }, { items: [runRecord()] }]) {
    const { result } = await run("reai_list_salary_runs", {}, data);
    assert.equal(result.isError, undefined, JSON.stringify(data));
  }
});

test("the list handler counts drafts when it does get rows", async () => {
  const { text } = await run("reai_list_salary_runs", {}, [
    runRecord({ id: 1 }),
    runRecord({ id: 2, status: "complete" }),
  ]);
  assert.match(text, /1 still under_process/);
});

test("the payroll quirks are attached where a caller meets them", () => {
  const ids = (m, p) => quirksFor(m, p).map((q) => q.id);
  assert.ok(
    ids("POST", "/api/salary-payments").includes("salary-run-needs-employee-bank-accounts"),
    "the bank-account precondition is the normal first failure — it must be on the create",
  );
  assert.ok(
    ids("POST", "/api/salary-payments/{id}/complete").includes(
      "salary-complete-does-everything-at-once",
    ),
  );
  for (const m of ["POST", "PUT"]) {
    assert.ok(
      ids(m, "/api/salary-payments/{id}/wage-specs").includes(
        "salary-wage-line-create-and-update-differ",
      ) ||
        ids(m, "/api/salary-payments/{id}/wage-specs/{wageSpecId}").includes(
          "salary-wage-line-create-and-update-differ",
        ),
      m,
    );
  }
  // The employee bank account is the precondition for payroll, and its field is renamed and
  // split in the response — a caller verifying its own write needs to know before it panics.
  assert.ok(
    ids("POST", "/api/employees").includes("employee-account-goes-in-flat-and-comes-back-split"),
  );
  for (const m of ["GET", "PATCH"]) {
    assert.ok(ids(m, "/api/employees/{id}").includes("employee-account-split-on-read-and-update"), m);
  }
  // And NOT on the collection GET, which returns the id/name/email projection: two quirks on one
  // operation saying opposite things about the same field is worse than one of them missing.
  const collection = ids("GET", "/api/employees");
  assert.ok(
    !collection.some((id) => id.startsWith("employee-account")),
    `GET /api/employees carries ${collection.join(", ")} — the list has no bankAccount to describe`,
  );
});

test("the tool text names the a-melding consequence rather than only refusing", () => {
  const all = salaryTools.map((t) => `${t.description} ${t.title}`).join("\n");
  assert.match(all, /a-melding/i);
  assert.match(all, /payslip/i);
  assert.match(all, /bank account/i);
});

// Three payroll endpoints live outside /api under the salary-ctrl tag with no summary, no
// description and no required fields in the spec, so discovery would show them as bare names.
// Two of them are the A-melding submission and a payment instruction.
test("the undocumented /salary aliases carry a quirk, and reach it from a concrete path", () => {
  for (const path of [
    "/salary/{id}/complete",
    "/salary/{id}/payment-date",
    "/salary/{id}/register-payment",
  ]) {
    assert.ok(
      quirksFor("POST", path).some((q) => q.id === "salary-ctrl-aliases-have-no-documentation"),
      path,
    );
  }
  // reai_request is given a CONCRETE path and looks the quirks up through resolveOperation, so
  // the template match above is not enough on its own to prove a caller sees this.
  for (const concrete of ["/salary/1360/complete", "/salary/1360/payment-date"]) {
    const op = resolveOperation("POST", concrete);
    assert.ok(op, `${concrete} does not resolve to a spec operation`);
    assert.ok(
      quirksFor("POST", op.path).some((q) => q.id === "salary-ctrl-aliases-have-no-documentation"),
      concrete,
    );
  }
});

test("both /salary aliases that transmit are gated on the send axis; payment-date is not, on purpose", () => {
  assert.equal(classifyTransmission("POST", "/salary/1360/complete", undefined), "external");
  assert.equal(classifyTransmission("POST", "/salary/1360/register-payment", undefined), "external");
  // Recorded, not endorsed: with no documentation and no way to reach a completed run without
  // sending, whether this moves money is unestablished. The quirk says so in those words, and
  // this assertion exists so a later change to either has to change the other.
  assert.equal(classifyTransmission("POST", "/salary/1360/payment-date", undefined), "none");
  assert.equal(classifyRequest("POST", "/salary/1360/payment-date"), "irreversible");
  const quirk = quirksFor("POST", "/salary/{id}/payment-date").find(
    (q) => q.id === "salary-ctrl-aliases-have-no-documentation",
  );
  assert.match(quirk.note, /NOT gated as a send/);
});

// The PUT is a full replacement — measured on the test tenant, a line carrying comment
// "PROBE COMMENT" updated without the comment field came back with comment null, confirmed on a
// re-read. So the tool reads the line and carries over what the caller did not mention.
test("changing a line's rate does not erase its comment", async () => {
  const { calls, text } = await run("reai_update_salary_line", {
    id: 1360,
    wageSpecId: 7,
    specificationCode: "COMMISSION",
    quantity: 1,
    rate: 2500,
  }, storedLine({ comment: "KEEP ME", holidayAllowanceEarningYear: null }));
  assert.deepEqual(
    calls.map((c) => c.method),
    ["GET", "PUT"],
    "the line has to be read before it is replaced",
  );
  const put = calls[1];
  assert.equal(put.body.comment, "KEEP ME");
  assert.equal(put.body.rate, 2500);
  assert.match(text, /Written back unchanged/);
  assert.match(text, /comment/);
});

test("an explicit null still clears — omission and null must not collapse", async () => {
  const { calls, text } = await run("reai_update_salary_line", {
    id: 1360,
    wageSpecId: 7,
    specificationCode: "COMMISSION",
    quantity: 1,
    rate: 2500,
    comment: null,
  }, storedLine({ comment: "GOODBYE" }));
  assert.equal(calls[1].body.comment, null);
  assert.ok(
    !/Written back unchanged because you did not mention them: comment/.test(text),
    "a field the caller cleared must not be reported as kept",
  );
});

test("a line that is not on the run is refused rather than replaced blind", async () => {
  const { calls, result, text } = await run(
    "reai_update_salary_line",
    { id: 1360, wageSpecId: 999, specificationCode: "COMMISSION", quantity: 1, rate: 1 },
    storedLine(),
  );
  assert.deepEqual(calls.map((c) => c.method), ["GET"], "no PUT may be issued");
  assert.equal(result.isError, true);
  assert.match(text, /was not found on salary run 1360/);
});

// The refusal the merge itself introduced: changing a HOLIDAY_ALLOWANCE line to another code
// would carry its stored year onto a code the API refuses it on — built out of a field the caller
// never mentioned. The message has to say that, not just restate the rule.
test("carrying a stored holiday year onto a non-holiday line is refused, and says why", async () => {
  const { calls, result, text } = await run(
    "reai_update_salary_line",
    { id: 1360, wageSpecId: 7, specificationCode: "COMMISSION", quantity: 1, rate: 1000 },
    storedLine({ specificationCode: "HOLIDAY_ALLOWANCE", holidayAllowanceEarningYear: 2025 }),
  );
  assert.deepEqual(calls.map((c) => c.method), ["GET"], "nothing may be written");
  assert.equal(result.isError, true);
  assert.match(text, /You did not pass that field/);
  assert.match(text, /holidayAllowanceEarningYear: null/);
});

test("clearing the year in the same call as the type change goes through", async () => {
  const { calls, result } = await run(
    "reai_update_salary_line",
    {
      id: 1360,
      wageSpecId: 7,
      specificationCode: "COMMISSION",
      quantity: 1,
      rate: 1000,
      holidayAllowanceEarningYear: null,
    },
    storedLine({ specificationCode: "HOLIDAY_ALLOWANCE", holidayAllowanceEarningYear: 2025 }),
  );
  assert.equal(result.isError, undefined);
  assert.equal(calls[1].body.holidayAllowanceEarningYear, null);
  assert.equal(calls[1].body.specificationCode, "COMMISSION");
});

// The update already reads the run for the merge, so the status is free — and a wage line changed
// on a run whose voucher is posted would leave the line and the ledger disagreeing.
test("changing a line on a run that is no longer a draft is refused before the PUT", async () => {
  for (const status of ["unpaid", "complete", "reversed"]) {
    const { calls, result, text } = await run(
      "reai_update_salary_line",
      { id: 1360, wageSpecId: 7, specificationCode: "COMMISSION", quantity: 1, rate: 1000 },
      (req) =>
        req.method === "GET"
          ? {
              ...runRecord({ status }),
              employees: [{ employeeId: 987, wageSpecs: [{ id: 7, comment: "x" }] }],
            }
          : runRecord(),
    );
    assert.deepEqual(calls.map((c) => c.method), ["GET"], `${status}: no PUT may be issued`);
    assert.equal(result.isError, true);
    assert.match(text, new RegExp(status));
    // It says the refusal is this server's caution rather than a measured API rule, and names the
    // way through — the repo's standing rule about not dressing an inference as a measurement.
    assert.match(text, /was not established/);
    assert.match(text, /reai_request PUT/);
  }
});
