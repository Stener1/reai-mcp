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
  const hidden = await run("reai_get_employee", { employeeId: 12 }, employee());
  assert.ok(!hidden.text.includes("15057512345"), "the fødselsnummer must not be in the result");
  assert.ok(!hidden.text.includes("12345678903"), "nor the salary account number");
  assert.ok(!hidden.text.includes("NO9386011117947"), "nor the IBAN");
  assert.match(hidden.text, /redacted/);
  // Everything else is untouched — this redacts two fields, it does not summarise.
  assert.match(hidden.text, /Kari Nordmann/);
  assert.match(hidden.text, /Kongens gate 1/);
  assert.match(hidden.text, /650000/);

  const shown = await run("reai_get_employee", { employeeId: 12, includePersonalData: true }, employee());
  assert.match(shown.text, /15057512345/);
  assert.match(shown.text, /12345678903/);
  assert.doesNotMatch(shown.text, /redacted/);

  // The two must actually differ, which is the whole claim the exemption rests on.
  assert.notEqual(hidden.text, shown.text);

  // A record without those fields says so rather than claiming a redaction that did not
  // happen — otherwise "redacted" reads as "there is one here and I am hiding it".
  const bare = await run("reai_get_employee", { employeeId: 12 }, { id: 12, name: "Ola" });
  assert.match(bare.text, /carries no national identity number or bank account/);
  assert.doesNotMatch(bare.text, /redacted/);
});

test("the employee list is a summary, and never carries personal data", async () => {
  const { text } = await run("reai_list_employees", {}, [employee(), { ...employee(), id: 13 }]);
  assert.ok(!text.includes("15057512345"), "a list of who works here must not carry fødselsnummer");
  assert.ok(!text.includes("12345678903"));
  // Not merely redacted — absent, along with the rest of the record's bulk.
  assert.ok(!text.includes("redacted"));
  assert.ok(!text.includes("employmentRelations"));
  assert.ok(!text.includes("Kongens gate"));
  // What it IS for: resolving a name to the id other tools take.
  assert.match(text, /Kari Nordmann/);
  assert.match(text, /"id": 12/);
  assert.match(text, /"departmentId": 3/);
  assert.match(text, /2 employee\(s\)/);
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
  // No project tools: the Project module is off on every tenant this repo can reach, so
  // nothing about their success path could be verified.
  assert.equal(registeredTools.filter((t) => /project/i.test(t.name)).length, 0);
});
