import { test } from "node:test";
import assert from "node:assert/strict";
import { organisationTools } from "../dist/tools/organisation.js";
import { registeredTools } from "../dist/server.js";

const tool = (name) => {
  const found = organisationTools.find((t) => t.name === name);
  assert.ok(found, `${name} is not registered`);
  return found;
};

/** Run a tool against a stubbed client, recording what it asked the API for. */
async function run(name, args, response) {
  const calls = [];
  const result = await tool(name).handler(
    { tenantId: 2634, ...args },
    {
      client: {
        request: async (req) => {
          calls.push(req);
          return { data: response, status: 200 };
        },
        deepLink: () => "link",
      },
      config: { writeMode: "full", tenantId: 2634 },
      session: {},
    },
  );
  return { calls, text: result.content.find((c) => c.type === "text").text, result };
}

/** An employee record shaped like the live one, personal fields included. */
const employee = () => ({
  id: 12,
  name: "Kari Nordmann",
  email: "kari@example.no",
  phone: "99887766",
  departmentId: 3,
  dateOfEmployment: "2024-01-15",
  endDateOfEmployment: null,
  nationalIdentityNumber: "15057512345",
  bankAccount: { accountNumber: "12345678903", iban: "NO9386011117947", currency: "NOK" },
  address: { city: "Trondheim", addressPart1: "Kongens gate 1" },
  employmentRelations: [{ id: 1, startDate: "2024-01-15", employmentLines: [{ annualSalary: 650000 }] }],
});

// This is the test the preflight exemption points at. `includePersonalData` never reaches
// the API — it shapes the response — so the sweep that catches silently dropped inputs
// has to be told, and an exemption is only honest if the field demonstrably does something.
test("an employee's national identity number is redacted unless asked for", async () => {
  const hidden = await run("reai_get_employee", { id: 12 }, employee());
  // The path, so a stale argument name cannot sit here unnoticed. These callers kept
  // passing `employeeId` after the rename and built /api/employees/undefined for a while:
  // the handler takes args directly in this harness, nothing validates them, and no
  // assertion looked at the request.
  assert.equal(hidden.calls[0].path, "/api/employees/12");
  assert.ok(!hidden.text.includes("15057512345"), "the fødselsnummer must not be in the result");
  assert.ok(!hidden.text.includes("12345678903"), "nor the salary account number");
  assert.ok(!hidden.text.includes("NO9386011117947"), "nor the IBAN");
  assert.match(hidden.text, /redacted/);
  // Everything else is untouched — this redacts two fields, it does not summarise.
  assert.match(hidden.text, /Kari Nordmann/);
  assert.match(hidden.text, /Kongens gate 1/);
  assert.match(hidden.text, /650000/);

  const shown = await run("reai_get_employee", { id: 12, includePersonalData: true }, employee());
  assert.match(shown.text, /15057512345/);
  assert.match(shown.text, /12345678903/);
  assert.doesNotMatch(shown.text, /redacted/);

  // The two must actually differ, which is the whole claim the exemption rests on.
  assert.notEqual(hidden.text, shown.text);

  // A record without those fields says so rather than claiming a redaction that did not
  // happen — otherwise "redacted" reads as "there is one here and I am hiding it".
  const bare = await run("reai_get_employee", { id: 12 }, { id: 12, name: "Ola" });
  assert.match(bare.text, /No national identity number or bank account was found/);
  assert.doesNotMatch(bare.text, /redacted/);
});

// The collection's real projection, established by POSTing an employee to the test tenant
// and reading the list back: exactly id, name and email — matching the spec's
// EmployeeSummaryRes, and NOT the full record. An earlier version of this test fed the
// list endpoint an EmployeeRes-shaped row and asserted departmentId came through, which
// would have passed against a shape the endpoint never sends.
const listRow = (over = {}) => ({ id: 12, name: "Kari Nordmann", email: "kari@example.no", ...over });

test("the employee list is what the API really returns, and carries no personal data", async () => {
  const { text } = await run("reai_list_employees", {}, [listRow(), listRow({ id: 13, name: "Ola" })]);
  assert.match(text, /Kari Nordmann/);
  assert.match(text, /"id": 12/);
  assert.match(text, /2 employee\(s\)/);
  assert.match(text, /id, name and email only/);
  // No claim that anything was stripped, because the endpoint never sent it.
  assert.ok(!text.includes("redacted"));

  // summarise() earns its place only if the projection ever widens: fed a full record it
  // still drops the identity number and bank details rather than passing them through.
  const wide = await run("reai_list_employees", {}, [employee()]);
  assert.ok(!wide.text.includes("15057512345"), "a widened projection must not leak fødselsnummer");
  assert.ok(!wide.text.includes("12345678903"));
  assert.ok(!wide.text.includes("employmentRelations"));
});

// Absence manufactured out of a shape surprise is the failure this repo has shipped once.
test("a list endpoint that stops returning a list does not become zero", async () => {
  const wrapped = { content: [listRow()], totalElements: 1 };
  const employees = await run("reai_list_employees", {}, wrapped);
  assert.doesNotMatch(employees.text, /No employees are registered/);
  assert.match(employees.text, /did not return a list/);
  assert.match(employees.text, /Kari Nordmann/, "the payload must survive, not be replaced by []");

  const departments = await run("reai_list_departments", {}, { content: [{ id: 1, name: "Drift" }] });
  assert.doesNotMatch(departments.text, /No departments/);
  assert.match(departments.text, /did not return a list/);
  assert.match(departments.text, /Drift/);

  // A row that is not an object must not throw, and must not vanish from a stated count.
  const ragged = await run("reai_list_employees", {}, [listRow(), null]);
  assert.match(ragged.text, /2 employee\(s\)/);
  assert.match(ragged.text, /unexpectedRow/);
});

// The note asserts a NEGATIVE, so it has to be true of the whole record, not of two keys.
test("redaction reaches nested copies, and the note only claims what was checked", async () => {
  const nested = await run("reai_get_employee", { id: 12 }, {
    id: 12,
    name: "Kari",
    employmentRelations: [{ id: 1, bankAccount: { iban: "NO9386011117947" } }],
    previous: { nationalIdentityNumber: "15057512345" },
  });
  assert.ok(!nested.text.includes("NO9386011117947"), "an IBAN nested in an array must not survive");
  assert.ok(!nested.text.includes("15057512345"), "nor a nested identity number");
  assert.match(nested.text, /nationalIdentityNumber and bankAccount redacted|bankAccount and nationalIdentityNumber redacted/);
  // The surrounding structure is preserved — this redacts, it does not flatten.
  assert.match(nested.text, /employmentRelations/);
});

// An empty list is an answer; "no employees" and "employees unavailable" are different
// things, and this repo has already shipped one bug where absence read as zero.
test("an empty list says what it means", async () => {
  const employees = await run("reai_list_employees", {}, []);
  assert.match(employees.text, /No employees are registered/);
  const departments = await run("reai_list_departments", {}, []);
  assert.match(departments.text, /not the same as departments being unavailable/);
});

// DELETE deletes when nothing references the record and ARCHIVES when something does,
// answering 200 either way. A caller reading the status alone concludes it is gone.
test("a delete that archived instead says so", async () => {
  const archived = await run("reai_delete_department", { departmentId: 7 }, { outcome: "archived" });
  assert.match(archived.text, /was ARCHIVED, not deleted/);
  assert.match(archived.text, /no unarchive endpoint/);

  const deleted = await run("reai_delete_department", { departmentId: 7 }, { outcome: "deleted" });
  assert.match(deleted.text, /deleted outright/);

  // And an API that stops answering with an outcome must not be read as either.
  const silent = await run("reai_delete_department", { departmentId: 7 }, {});
  assert.match(silent.text, /did not say whether it was deleted or archived/);
});

// "window widened" is a claim about what this tool DID. Saying it when the caller supplied
// the window would tell an agent its deliberately-scoped query reached back to 2000.
test("the ledger only claims to widen the window when it actually did", async () => {
  const widened = await run("reai_employee_ledger", { isOpenPosting: true }, {});
  assert.match(widened.text, /window widened/);
  const scoped = await run("reai_employee_ledger", { isOpenPosting: true, startDate: "2026-01-01" }, {});
  assert.equal(scoped.calls[0].query.startDate, "2026-01-01");
  assert.match(scoped.text, /open postings only/);
  assert.doesNotMatch(scoped.text, /window widened/);
});

test("the employee ledger fills in the dates the API requires", async () => {
  // Omitting them is a 400 "startDate is required", verified against the live API — so
  // these are defaults for a required parameter, not optional conveniences.
  const year = new Date().getFullYear();
  const plain = await run("reai_employee_ledger", {}, {});
  assert.equal(plain.calls[0].path, "/api/ledger/employee");
  assert.equal(plain.calls[0].query.startDate, `${year}-01-01`);
  assert.ok(plain.calls[0].query.endDate);

  // Open items reach back, because the ledger only returns employees with activity in the
  // window — a current-year default would hide last year's unpaid expense refund.
  const open = await run("reai_employee_ledger", { isOpenPosting: true }, {});
  assert.equal(open.calls[0].query.startDate, "2000-01-01");
  assert.match(open.text, /window widened/);

  const one = await run("reai_employee_ledger", { employeeId: 12 }, {});
  assert.equal(one.calls[0].path, "/api/ledger/employee/12");
});

test("departments send only the field the API accepts", async () => {
  const created = await run("reai_create_department", { name: "Drift" }, { id: 9, name: "Drift" });
  assert.equal(created.calls[0].method, "POST");
  assert.deepEqual(created.calls[0].body, { name: "Drift" });

  const renamed = await run("reai_update_department", { departmentId: 9, name: "Salg" }, { id: 9 });
  assert.equal(renamed.calls[0].method, "PUT");
  assert.equal(renamed.calls[0].path, "/api/departments/9");
  assert.deepEqual(renamed.calls[0].body, { name: "Salg" });
});

test("the toolset is registered, read-only where it should be, and transmits nothing", () => {
  assert.equal(organisationTools.length, 8);
  for (const t of organisationTools) {
    assert.ok(registeredTools.includes(t), `${t.name} must be inside the invariant sweeps`);
    assert.ok(!t.transmits, `${t.name} must not leave the tenant`);
  }
  const reads = ["reai_list_departments", "reai_get_department", "reai_list_employees", "reai_get_employee", "reai_employee_ledger"];
  for (const name of reads) assert.equal(tool(name).risk, "read", name);
  // Master data that can be put back, which is what `reversible` means here.
  for (const name of ["reai_create_department", "reai_update_department", "reai_delete_department"]) {
    assert.equal(tool(name).risk, "reversible", name);
  }
  // Reversible, but still a delete — and the one whose archive branch is one-way.
  assert.equal(tool("reai_delete_department").destructive, true);
  // No project tools: the Project module is off on every tenant this repo can reach, so
  // nothing about their success path could be verified.
  assert.equal(registeredTools.filter((t) => /project/i.test(t.name)).length, 0);
});
