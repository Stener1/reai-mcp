import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { organisationTools } from "../dist/tools/organisation.js";
import { registeredTools, destructiveHintFor } from "../dist/server.js";
import { classifyRequest, curatedArgsEscalate, inPaymentRoutingScope } from "../dist/policy.js";
import { quirksFor } from "../dist/reai/quirks.js";

const tool = (name) => {
  const found = organisationTools.find((t) => t.name === name);
  assert.ok(found, `${name} is not registered`);
  return found;
};

/** Arguments go through the tool's own schema first, as a client's would. */
async function run(name, args, responses, { status = 200, raw = false } = {}) {
  const calls = [];
  const withTenant = { tenantId: 2783, ...args };
  const validated = raw ? withTenant : z.object(tool(name).inputSchema).parse(withTenant);
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

/** An employee as the live API returns one: address and bankAccount nested, lines under relations. */
const employee = (overrides = {}) => ({
  id: 1005,
  name: "Zz Probe",
  email: "zz@example.invalid",
  phone: "+4722334455",
  dateOfEmployment: "2026-01-15",
  endDateOfEmployment: null,
  nationalIdentityNumber: null,
  address: { countryCode: "  ", city: "Oslo", postalCode: "0150", addressPart1: "Prøvegata 1" },
  bankAccount: {
    employeeBankAccountId: 1005,
    countryCode: "NO",
    bankCode: "1520",
    accountNumber: "1353103",
    currency: "NOK",
    iban: "NO1615201353103",
  },
  employmentRelations: [
    {
      id: 1004,
      startDate: "2026-01-15",
      employmentLines: [
        {
          id: 997,
          fromDate: "2026-01-15",
          municipality: null,
          remunerationType: null,
          occupationCode: "1211101",
          percentage: 100,
          annualSalary: 600000,
          hourlyWage: null,
          employmentType: { code: "ordinaertArbeidsforhold", displayName: "Ordinary employment" },
        },
      ],
    },
  ],
  ...overrides,
});

const NAMES = [
  "reai_create_employee",
  "reai_update_employee",
  "reai_set_employee_bank_account",
  "reai_add_employment_line",
  "reai_delete_employee",
];

test("all five employee write tools are registered", () => {
  const registered = new Set(registeredTools.map((t) => t.name));
  for (const name of NAMES) assert.ok(registered.has(name), name);
});

test("the two payment-destination tools are irreversible; the master-data ones are not", () => {
  assert.equal(tool("reai_set_employee_bank_account").risk, "irreversible");
  assert.equal(tool("reai_add_employment_line").risk, "irreversible");
  assert.equal(tool("reai_create_employee").risk, "reversible");
  assert.equal(tool("reai_update_employee").risk, "reversible");
  assert.equal(tool("reai_delete_employee").risk, "reversible");
  assert.equal(destructiveHintFor(tool("reai_delete_employee")), true);
});

// An employee's account is where their salary lands. The escalation machinery already covers the
// path; this asserts the curated tools actually sit on the right side of it.
test("passing accountNumber to the create escalates it to a payment-destination change", () => {
  assert.ok(inPaymentRoutingScope("/api/employees/1005"));
  const paths = tool("reai_create_employee").apiPaths;
  assert.equal(curatedArgsEscalate(paths, { name: "A", email: "b@c.d" }), undefined);
  const escalated = curatedArgsEscalate(paths, { name: "A", accountNumber: "15201353103" });
  assert.equal(escalated?.risk, "irreversible");
  assert.deepEqual(escalated?.fields, ["accountNumber"]);
});

test("reai_update_employee cannot change a bank account or an employment line at all", () => {
  const shape = tool("reai_update_employee").inputSchema;
  for (const field of ["accountNumber", "employmentLines", "bankCountryCode"]) {
    assert.equal(shape[field], undefined, `${field} must not be settable here`);
  }
  // And the schema strips it rather than passing it through, so a caller cannot smuggle one in.
  const parsed = z.object(shape).parse({ id: 1, phone: "22334455", accountNumber: "15201353103" });
  assert.ok(!("accountNumber" in parsed));
});

test("an update with no fields is refused instead of sending an empty patch", async () => {
  const { calls, result, text } = await run("reai_update_employee", { id: 1005 }, employee());
  assert.equal(calls.length, 0);
  assert.equal(result.isError, true);
  assert.match(text, /nothing to change/);
});

test("the create says the employee cannot be put in a salary run without an account", async () => {
  const { text } = await run(
    "reai_create_employee",
    { name: "Zz New", email: "zz@example.invalid" },
    employee({ bankAccount: null, dateOfEmployment: "2026-08-08" }),
    { status: 201 },
  );
  assert.match(text, /cannot be included in a salary run/);
  assert.match(text, /reai_set_employee_bank_account/);
  // And that the API filled the start date in, because employment is what the a-melding reports.
  assert.match(text, /2026-08-08/);
  assert.match(text, /a-melding/);
});

test("a create that supplies the start date does not claim the API invented one", async () => {
  const { text } = await run(
    "reai_create_employee",
    { name: "Zz New", email: "zz@example.invalid", dateOfEmployment: "2026-01-15" },
    employee(),
    { status: 201 },
  );
  assert.match(text, /Employment starts "2026-01-15"/);
  assert.ok(!/a-melding reports/.test(text), "no lecture about a default that was not used");
});

// The API answers 200 and stores null when it cannot parse a phone number, so a write can destroy
// the number that was there with nothing to signal it. Measured: "nonsense" wiped "+4722334455".
test("a phone number that did not survive is reported, loudly", async () => {
  const { text } = await run(
    "reai_update_employee",
    { id: 1005, phone: "nonsense" },
    employee({ phone: null }),
  );
  assert.match(text, /DID NOT SURVIVE/);
  assert.match(text, /"nonsense"/);
});

test("a normalised phone number is explained, not reported as a failure", async () => {
  const { text } = await run(
    "reai_update_employee",
    { id: 1005, phone: "22 33 44 55" },
    employee({ phone: "+4722334455" }),
  );
  assert.match(text, /normalised/);
  assert.ok(!/DID NOT SURVIVE/.test(text));
});

test("setting a bank account reads it first and says whether it was ADDED or REPOINTED", async () => {
  const added = await run("reai_set_employee_bank_account", { id: 1005, accountNumber: "15201353103" }, (req) =>
    req.method === "GET" ? employee({ bankAccount: null }) : employee(),
  );
  assert.deepEqual(added.calls.map((c) => c.method), ["GET", "PATCH"]);
  assert.deepEqual(added.calls[1].body, { accountNumber: "15201353103" });
  assert.match(added.text, /ADDED/);
  assert.match(added.text, /could not be included in a salary run until now/);

  const repointed = await run("reai_set_employee_bank_account", { id: 1005, accountNumber: "15060012345" }, (req) =>
    req.method === "GET"
      ? employee()
      : employee({ bankAccount: { bankCode: "1506", accountNumber: "0012345", iban: "NO9815060012345" } }),
  );
  assert.match(repointed.text, /REPOINTED/);
  // Both accounts named, so the change is visible rather than inferred.
  assert.match(repointed.text, /NO1615201353103/);
  assert.match(repointed.text, /NO9815060012345/);
  assert.match(repointed.text, /next salary payment goes to the new one/);
});

// `employmentLines` is a full replacement inside an endpoint that otherwise patches: two lines
// PATCHed with one came back with one, the survivor recreated with a new id.
test("adding an employment line carries the existing ones, with their ids", async () => {
  const { calls, text } = await run(
    "reai_add_employment_line",
    { id: 1005, fromDate: "2026-06-01", percentage: 80, annualSalary: 500000 },
    (req) =>
      req.method === "GET"
        ? employee()
        : employee({
            employmentRelations: [
              {
                id: 1004,
                employmentLines: [
                  { id: 997, fromDate: "2026-01-15" },
                  { id: 998, fromDate: "2026-06-01" },
                ],
              },
            ],
          }),
  );
  assert.deepEqual(calls.map((c) => c.method), ["GET", "PATCH"]);
  const sent = calls[1].body.employmentLines;
  assert.equal(sent.length, 2, "the existing line must be sent back with the new one");
  assert.equal(sent[0].id, 997, "the existing line keeps its id so the row is updated, not recreated");
  assert.equal(sent[0].annualSalary, 600000);
  assert.equal(sent[1].fromDate, "2026-06-01");
  assert.equal(sent[1].annualSalary, 500000);
  // The response shape must not be echoed back into a request: employmentType is an object the
  // request schema does not have.
  assert.ok(!("employmentType" in sent[0]), "employmentType is response-only");
  assert.match(text, /1 existing line\(s\) were read/);
});

test("an unreadable employment history is refused rather than replaced with one line", async () => {
  for (const data of [{}, { employmentRelations: null }, { employmentRelations: "nope" }, null]) {
    const { calls, result, text } = await run(
      "reai_add_employment_line",
      { id: 1005, fromDate: "2026-06-01" },
      data,
    );
    assert.deepEqual(calls.map((c) => c.method), ["GET"], JSON.stringify(data));
    assert.equal(result.isError, true);
    assert.match(text, /could not be read/);
  }
});

// The count is the only evidence the merge worked, so a wrong one has to be said out loud rather
// than reported as success.
test("a line count that does not add up is called out", async () => {
  const { text } = await run(
    "reai_add_employment_line",
    { id: 1005, fromDate: "2026-06-01" },
    (req) =>
      req.method === "GET"
        ? employee()
        : employee({ employmentRelations: [{ id: 1004, employmentLines: [{ id: 998 }] }] }),
  );
  assert.match(text, /THAT DOES NOT ADD UP/);
  assert.match(text, /1 \+ 1 should be 2/);
});

test("an employee with no lines yet can still have one added", async () => {
  const { calls } = await run(
    "reai_add_employment_line",
    { id: 1005, fromDate: "2026-06-01" },
    (req) =>
      req.method === "GET"
        ? employee({ employmentRelations: [] })
        : employee({ employmentRelations: [{ id: 1, employmentLines: [{ id: 2 }] }] }),
  );
  assert.equal(calls[1].body.employmentLines.length, 1);
});

test("deleting an employee says the record is gone, not archived", async () => {
  const { calls, text } = await run("reai_delete_employee", { id: 1005 }, null, { status: 204 });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["DELETE /api/employees/1005"]);
  assert.match(text, /gone rather than archived/);
  assert.match(text, /409/);
});

test("employee writes classify as reversible, and stay inside payment-routing scope", () => {
  for (const [method, path] of [
    ["POST", "/api/employees"],
    ["PATCH", "/api/employees/1005"],
    ["DELETE", "/api/employees/1005"],
  ]) {
    assert.equal(classifyRequest(method, path), "reversible", `${method} ${path}`);
    assert.ok(inPaymentRoutingScope(path), `${method} ${path} must stay in routing scope`);
  }
});

test("the measured employee quirks reach the operations that meet them", () => {
  const ids = (m, p) => quirksFor(m, p).map((q) => q.id);
  assert.ok(
    ids("PATCH", "/api/employees/{id}").includes("employee-patch-really-patches-except-one-field"),
  );
  for (const m of ["POST", "PATCH"]) {
    assert.ok(
      ids(m, m === "POST" ? "/api/employees" : "/api/employees/{id}").includes(
        "employee-phone-is-normalised-or-silently-nulled",
      ),
      m,
    );
  }
  assert.ok(ids("POST", "/api/employees").includes("employee-create-is-not-a-blank-record"));
  // The patch quirk is about PATCH — putting it on the create would state something untested.
  assert.ok(
    !ids("POST", "/api/employees").includes("employee-patch-really-patches-except-one-field"),
  );
});

test("the tool text names the payroll precondition and the history-replacing field", () => {
  const all = NAMES.map((n) => tool(n).description).join("\n");
  assert.match(all, /mangler bankkonto/);
  assert.match(all, /employmentLines/);
  assert.match(all, /full replacement/i);
  assert.match(all, /a-melding/);
});

// Measured: `400 "Ansettelseslinje 4: Fra-dato kan ikke være før ansettelsesstart"`. The tool has
// the start date in hand from the read it already does, so the refusal can name the real problem
// instead of relaying a numbered Norwegian error about a request array the caller never built.
test("a line dated before the employment start is refused locally, with the reason", async () => {
  const { calls, result, text } = await run(
    "reai_add_employment_line",
    { id: 1005, fromDate: "2025-06-01", percentage: 50 },
    employee({ dateOfEmployment: "2026-01-15" }),
  );
  assert.deepEqual(calls.map((c) => c.method), ["GET"], "nothing may be sent");
  assert.equal(result.isError, true);
  assert.match(text, /cannot start before the employment does/);
  assert.match(text, /2026-01-15/);
  assert.match(text, /2025-06-01/);
  // The likely real cause, since a create without a start date sets it to today.
  assert.match(text, /reai_update_employee dateOfEmployment/);
});

test("a line on or after the employment start goes through", async () => {
  for (const fromDate of ["2026-01-15", "2026-06-01"]) {
    const { calls } = await run(
      "reai_add_employment_line",
      { id: 1005, fromDate },
      (req) =>
        req.method === "GET"
          ? employee({ dateOfEmployment: "2026-01-15" })
          : employee({
              employmentRelations: [{ id: 1, employmentLines: [{ id: 997 }, { id: 998 }] }],
            }),
    );
    assert.equal(calls.length, 2, fromDate);
  }
});

test("an employee whose start date is unreadable is not blocked by the local rule", async () => {
  // The API is the authority; this guard exists to explain, not to invent a refusal where the
  // record does not say anything.
  const { calls } = await run(
    "reai_add_employment_line",
    { id: 1005, fromDate: "2020-01-01" },
    (req) =>
      req.method === "GET"
        ? employee({ dateOfEmployment: null })
        : employee({ employmentRelations: [{ id: 1, employmentLines: [{ id: 997 }, { id: 9 }] }] }),
  );
  assert.equal(calls.length, 2, "with no start date on file the API decides");
});

// Redacting an ABSENT value states something false. An employee with no salary account came back
// as bankAccount "[redacted — pass includePersonalData: true to see it]", which reads as "there is
// one, you just cannot see it" — while the same response said they had none and could not be put
// in a salary run. The write suite caught the contradiction.
test("a null personal field is left null, not reported as redacted", async () => {
  const { text, result } = await run(
    "reai_create_employee",
    { name: "Zz New", email: "zz@example.invalid" },
    employee({ bankAccount: null, nationalIdentityNumber: null }),
    { status: 201 },
  );
  const record = JSON.parse(text.split("\n\n").at(-1));
  assert.equal(record.bankAccount, null);
  assert.equal(record.nationalIdentityNumber, null);
  assert.ok(!/redacted/.test(text), "nothing was there to redact");
  assert.equal(result.isError, undefined);
});

test("a personal field that IS present is still redacted", async () => {
  const { text } = await run("reai_get_employee", { id: 1005 }, employee({ nationalIdentityNumber: "01019012345" }));
  assert.match(text, /redacted/);
  assert.ok(!/01019012345/.test(text), "the fødselsnummer must not reach the result");
  assert.ok(!/NO1615201353103/.test(text), "nor the account");
});
