import { z } from "zod";
import {
  defineTool,
  fail,
  isoDate,
  ok,
  okList,
  requiredName,
  requireTenantId,
  startOfYear,
  tenantIdArg,
  today,
  type ToolDef,
} from "./registry.js";

/**
 * Departments and employees — the dimensions the rest of this server already refers to.
 *
 * `reai_list_postings` and `reai_general_ledger` take `projectId` and `employeeId`,
 * `reai_list_expenses` takes `employeeIds`, and until now nothing here could turn a name
 * into any of those ids. An agent asked "what did we pay Kari this year" had to reach for
 * the discovery escape hatch to find out who Kari is.
 *
 * Projects are the other half of that gap and are deliberately absent: the Project module
 * is disabled on every tenant this repo can reach, so `GET /api/projects` answers
 * 403 "Project module is disabled" and nothing about the success path could be verified.
 * The spec has been wrong about this API often enough that shipping unverified tools is
 * not a neutral act.
 */

/**
 * ## Employee master data, measured on the test tenant
 *
 * `PATCH /api/employees/{id}` is a TRUE patch, which in this API is the exception rather than the
 * rule — company banks, creditors, agreements, subscriptions and salary wage lines all turned out
 * to replace. Verified: patching `phone` alone left city, postal code, street, bank account,
 * `dateOfEmployment` and the employment lines exactly as they were.
 *
 * With ONE exception inside it. `employmentLines` is a full replacement: an employee with two lines,
 * PATCHed with one, came back with one — the other was gone, and the survivor had a NEW id. So
 * "add a raise from June" written as a single-line PATCH deletes the employment history. That is
 * what `reai_add_employment_line` exists for; `reai_update_employee` does not accept the field.
 *
 * Two more things worth knowing before writing here:
 *  - Creating an employee with nothing but name and email is not a blank record. `dateOfEmployment`
 *    defaults to TODAY and an employment relation with one (empty) employment line is created
 *    automatically, typed `ordinaertArbeidsforhold`. The a-melding reports employment, so that
 *    start date is not cosmetic.
 *  - `phone` is normalised to E.164 and an UNPARSEABLE value is stored as null with a 200. Measured:
 *    "22 33 44 55", "0047 22334455" and "+1 415 555 0100" all normalised fine, and "nonsense"
 *    silently replaced a stored "+4722334455" with null. No error, so a write has to be read back.
 */

/** How far back an open-items query reaches. Same floor as the customer ledger. */
const OPEN_ITEM_FLOOR = "2000-01-01";

/**
 * Fields removed from an employee record unless explicitly asked for.
 *
 * `nationalIdentityNumber` is a fødselsnummer and `bankAccount` holds the account salary
 * is paid into. Both are ordinary API data and neither is a secret to the operator — but a
 * tool result goes into a model's context and out to whatever provider serves it, and
 * "which department is Kari in" should not carry her national identity number with it.
 *
 * This is a DEFAULT, not a control. `reai_request` returns the raw record, and it is meant
 * to: an operator who wants the field can have it, from this tool with
 * `includePersonalData` or from the escape hatch. Calling it a protection would be false.
 */
const PERSONAL_FIELDS = ["nationalIdentityNumber", "bankAccount"] as const;

type EmployeeRecord = Record<string, unknown>;

/**
 * Remove the personal fields wherever they appear, not only at the top level.
 *
 * The documented record puts both at the top level and a shallow copy was adequate for it.
 * But the note this tool prints asserts a NEGATIVE — "carries no national identity number"
 * — and a two-key top-level check cannot support that claim for a shape it has not seen.
 * Walking the record makes the claim true instead of narrowing it, which is the version
 * worth having when the thing being claimed is that a fødselsnummer is not in the output.
 */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((element) => redact(element, depth + 1));
  const out: EmployeeRecord = {};
  for (const [key, inner] of Object.entries(value as EmployeeRecord)) {
    // A null is left as a null. Redacting one states something FALSE: an employee with no salary
    // account came back as bankAccount "[redacted — pass includePersonalData: true to see it]",
    // which reads as "there is one, you just cannot see it" — and reai_create_employee says in the
    // same breath that they have none and cannot be put in a salary run. The write suite caught the
    // contradiction. There is nothing to hide in an absent value, so hiding it only misleads.
    const personal = PERSONAL_FIELDS.includes(key as (typeof PERSONAL_FIELDS)[number]);
    out[key] =
      personal && inner !== null && inner !== undefined
        ? "[redacted — pass includePersonalData: true to see it]"
        : personal
          ? inner
          : redact(inner, depth + 1);
  }
  return out;
}

/** Where the personal fields actually occur, so the note describes what was found. */
function personalFieldsIn(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return [...new Set(value.flatMap((e) => personalFieldsIn(e, depth + 1)))];
  const found: string[] = [];
  for (const [key, inner] of Object.entries(value as EmployeeRecord)) {
    if (PERSONAL_FIELDS.includes(key as (typeof PERSONAL_FIELDS)[number])) {
      if (inner !== null && inner !== undefined) found.push(key);
    } else {
      found.push(...personalFieldsIn(inner, depth + 1));
    }
  }
  return [...new Set(found)];
}

/** The fields that answer "who is this and where do they sit". */
function summarise(employee: unknown): EmployeeRecord {
  if (!employee || typeof employee !== "object" || Array.isArray(employee)) {
    // A row that is not an object cannot be summarised, and dropping it silently would
    // shrink a count the note is about to state. Hand it back untouched.
    return { unexpectedRow: employee } as EmployeeRecord;
  }
  const record = employee as EmployeeRecord;
  const keep = [
    "id",
    "name",
    "email",
    "phone",
    "departmentId",
    "dateOfEmployment",
    "endDateOfEmployment",
  ];
  return Object.fromEntries(keep.filter((k) => record[k] !== undefined).map((k) => [k, record[k]]));
}

const listDepartments = defineTool({
  name: "reai_list_departments",
  title: "List departments",
  description:
    "Every department in the company, with its id — which is what postings, employees and " +
    "reports are tagged with. Archived departments are hidden from this list by the API.",
  risk: "read",
  apiPaths: [["GET", "/api/departments"]],
  inputSchema: { tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<unknown[]>({
      method: "GET",
      path: "/api/departments",
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return okList(res.data, {
      noun: "department",
      suffix: ".",
      empty:
        "No departments. That is not the same as departments being unavailable — an empty " +
        "list means none are defined, so nothing can be tagged with one yet.",
    });
  },
});

const getDepartment = defineTool({
  name: "reai_get_department",
  title: "Get one department",
  description: "One department by id, including whether it is archived.",
  risk: "read",
  apiPaths: [["GET", "/api/departments/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Department id, from reai_list_departments."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "GET",
      path: `/api/departments/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data);
  },
});

const createDepartment = defineTool({
  name: "reai_create_department",
  title: "Create a department",
  description:
    "Create a department. Name is the only field the API accepts — the id it returns is what " +
    "postings and employees are tagged with.",
  risk: "reversible",
  apiPaths: [["POST", "/api/departments"]],
  inputSchema: {
    name: requiredName().describe("Department name."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<{ id?: number; name?: string }>({
      method: "POST",
      path: "/api/departments",
      body: { name: args.name },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data, { note: `Created department ${res.data?.id ?? "?"}.` });
  },
});

const updateDepartment = defineTool({
  name: "reai_update_department",
  title: "Rename a department",
  description:
    "Rename a department. The API takes a full replacement body whose only field is the name, " +
    "so this renames and nothing else.",
  risk: "reversible",
  apiPaths: [["PUT", "/api/departments/{id}"]],
  inputSchema: {
    departmentId: z.number().int().positive().describe("Department id."),
    name: requiredName().describe("New name."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "PUT",
      path: `/api/departments/${args.departmentId}`,
      body: { name: args.name },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data, { note: `Renamed department ${args.departmentId}.` });
  },
});

const deleteDepartment = defineTool({
  name: "reai_delete_department",
  title: "Delete or archive a department",
  description:
    "Remove a department. The API deletes it outright only when nothing references it; if " +
    "postings or employees do, it ARCHIVES it instead to keep the audit trail, and says which " +
    'happened in the response ({"outcome":"deleted"} or {"outcome":"archived"}). Read that field ' +
    "rather than treating a 200 as deletion.\n\n" +
    "There is no unarchive endpoint for departments — only customers and suppliers have one — so " +
    "an archived department stays hidden from the active list.",
  risk: "reversible",
  // Every other delete tool in this server carries this, and it is what a host keys on to
  // ask before running one. Omitting it here would have singled out the one delete whose
  // archive branch is ONE-WAY — departments have no unarchive — as the only one not worth
  // confirming. (`idempotent: false` was set instead, which does nothing: the annotation
  // is `idempotent === true`, and the HTTP client already treats DELETE as retry-safe.)
  destructive: true,
  apiPaths: [["DELETE", "/api/departments/{id}"]],
  inputSchema: {
    departmentId: z.number().int().positive().describe("Department id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<{ outcome?: string }>({
      method: "DELETE",
      path: `/api/departments/${args.departmentId}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const outcome = res.data?.outcome;
    // The distinction is the whole point of the endpoint, so state it rather than
    // leaving the caller to notice a field it did not know to look for.
    const note =
      outcome === "archived"
        ? `Department ${args.departmentId} was ARCHIVED, not deleted — something references it, ` +
          `so the record is kept for the audit trail and hidden from the active list. Departments ` +
          `have no unarchive endpoint.`
        : outcome === "deleted"
          ? `Department ${args.departmentId} was deleted outright — nothing referenced it.`
          : `Department ${args.departmentId} removed; the API did not say whether it was deleted or ` +
            `archived. Read the response before assuming.`;
    return ok(res.data ?? { outcome }, { note });
  },
});

const listEmployees = defineTool({
  name: "reai_list_employees",
  title: "List employees",
  description:
    "Everyone on the payroll: id, name and email. That is the whole projection the API returns " +
    "for the collection — department, phone and employment dates need reai_get_employee for one " +
    "person. The id is what reai_list_postings, reai_general_ledger and reai_list_expenses take " +
    "as employeeId, which is what this exists for.\n\n" +
    "The list carries no national identity number and no bank account, because the endpoint does " +
    "not return them. reai_get_employee redacts both unless asked.",
  risk: "read",
  apiPaths: [["GET", "/api/employees"]],
  inputSchema: { tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<EmployeeRecord[]>({
      method: "GET",
      path: "/api/employees",
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    // Verified against the live API rather than the description: POST an employee, read the
    // collection, and it comes back with exactly id, name and email — matching the spec's
    // EmployeeSummaryRes. summarise() therefore removes nothing today and is kept only so a
    // widened projection cannot start leaking a fødselsnummer into a list result.
    // Summarised BEFORE the count, so a widened projection cannot leak a fødselsnummer into
    // a list result — but only when it really is a list, since mapping a non-array is how
    // "absence manufactured out of a shape surprise" happened here in the first place.
    return okList(Array.isArray(res.data) ? res.data.map(summarise) : res.data, {
      noun: "employee",
      suffix: ". The collection returns id, name and email only; reai_get_employee returns one full record.",
      empty: "No employees are registered on this tenant.",
    });
  },
});

const getEmployee = defineTool({
  name: "reai_get_employee",
  title: "Get one employee",
  description:
    "One employee's full record: contact details, department, address, and employment relations " +
    "with their salary lines.\n\n" +
    "The national identity number and bank account are REDACTED unless includePersonalData is " +
    "set. That is a default rather than a restriction — the data is yours and reai_request " +
    "returns it raw — but a tool result travels into a model's context, and most questions about " +
    "an employee do not need a fødselsnummer to answer.",
  risk: "read",
  apiPaths: [["GET", "/api/employees/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Employee id, from reai_list_employees."),
    includePersonalData: z
      .boolean()
      .optional()
      .describe(
        "Return nationalIdentityNumber and bankAccount instead of redacting them. Ask only when " +
          "the task genuinely needs them.",
      ),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<EmployeeRecord>({
      method: "GET",
      path: `/api/employees/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const record = res.data ?? {};
    const held = personalFieldsIn(record);
    if (args.includePersonalData === true) {
      return ok(record, {
        note:
          held.length > 0
            ? `Includes ${held.join(" and ")} because includePersonalData was set.`
            : `No national identity number or bank account was found in this record.`,
      });
    }
    return ok(redact(record), {
      note:
        held.length > 0
          ? `${held.join(" and ")} redacted. Pass includePersonalData: true if the task needs them.`
          : `No national identity number or bank account was found in this record.`,
    });
  },
});

const employeeLedger = defineTool({
  name: "reai_employee_ledger",
  title: "Employee ledger",
  description:
    "The employee ledger: what is owed to or from each employee, with the postings behind it — " +
    "salary payable, expense refunds, advances. Omit employeeId for everyone, or pass one to " +
    "drill in. Set isOpenPosting to see only unsettled items, which is the answer to 'what do we " +
    "still owe staff'.\n\n" +
    "Defaults to the current calendar year, EXCEPT with isOpenPosting, where the window reaches " +
    "back to 2000 instead: the ledger only returns employees with activity in the period, so a " +
    "current-year default would hide an expense refund still unpaid from last year.",
  risk: "read",
  apiPaths: [
    ["GET", "/api/ledger/employee"],
    ["GET", "/api/ledger/employee/{employeeId}"],
  ],
  inputSchema: {
    employeeId: z.number().int().positive().optional().describe("Restrict to one employee."),
    startDate: isoDate
      .optional()
      .describe("Inclusive start date. Defaults to 1 January of the current year."),
    endDate: isoDate.optional().describe("Inclusive end date. Defaults to today."),
    isOpenPosting: z.boolean().optional().describe("Only unsettled (open) postings."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    // startDate and endDate are REQUIRED by the API — omitting them answers
    // 400 "startDate is required" rather than defaulting — so they are filled in here.
    const widened = args.startDate === undefined && args.isOpenPosting === true;
    const startDate = args.startDate ?? (args.isOpenPosting ? OPEN_ITEM_FLOOR : startOfYear());
    const endDate = args.endDate ?? today();
    const path = args.employeeId
      ? `/api/ledger/employee/${args.employeeId}`
      : "/api/ledger/employee";
    const res = await ctx.client.request({
      method: "GET",
      path,
      query: { startDate, endDate, isOpenPosting: args.isOpenPosting },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data, {
      note:
        `Employee ledger ${startDate} to ${endDate}` +
        `${args.isOpenPosting ? " (open postings only" : ""}` +
        `${widened ? " — window widened to catch older unsettled items" : ""}` +
        `${args.isOpenPosting ? ")" : ""}.`,
    });
  },
});


// --- Employee writes ---------------------------------------------------------
//
// Payroll landed before any of this existed, which made the gap obvious: a salary run cannot be
// created until every included employee has a bank account, and the only way to give one was a raw
// PATCH on a payment destination. See the header for what was measured.

/** Shared by create and update — the phone rule is the same on both. */
const phoneArg = z
  .string()
  .max(30, "The API caps phone at 30 characters.")
  .describe(
    'Phone number. Stored in E.164: "22 33 44 55" and "0047 22334455" both become ' +
      '"+4722334455", and a foreign number is accepted. An UNPARSEABLE value is stored as NULL ' +
      "with a 200 and no error — measured, \"nonsense\" replaced a stored number with null — so " +
      "this tool reads the result back and says so if the number did not survive.",
  );

const employeeAccountArg = z
  .string()
  .min(1)
  .describe(
    "Bank account number the salary is paid into, whole and unpunctuated (11 digits for a " +
      "Norwegian account). Goes in FLAT and comes back SPLIT: the response has no accountNumber " +
      "field at all, only bankAccount { bankCode, accountNumber, iban }, so do not read a shorter " +
      "string back as a failed write.",
  );

/** Whether a phone value survived the API's parser, for the note. */
function phoneOutcome(sent: string | undefined, stored: unknown): string | undefined {
  if (sent === undefined) return undefined;
  if (typeof stored === "string" && stored.length > 0) {
    return stored === sent
      ? undefined
      : `Phone stored as ${JSON.stringify(stored)} — normalised from ${JSON.stringify(sent)}, ` +
        `which is the API doing its job, not a failed write.`;
  }
  return (
    `THE PHONE NUMBER DID NOT SURVIVE: ${JSON.stringify(sent)} was sent and the record now holds ` +
    `${JSON.stringify(stored ?? null)}. The API answers 200 and stores null when it cannot parse a ` +
    `number, so nothing failed loudly — but any number that was there before is gone. Send a form ` +
    `it can read (a plain Norwegian number, or E.164 with the country code).`
  );
}

const createEmployee = defineTool({
  name: "reai_create_employee",
  title: "Create an employee",
  description:
    "Add a person to the payroll. Only name and email are required — but the record that comes " +
    "back is NOT blank, and that is the thing to know before calling this: dateOfEmployment " +
    "defaults to TODAY and an employment relation with one empty employment line is created " +
    "automatically, typed ordinaertArbeidsforhold. Employment is reported in the a-melding, so " +
    "pass the real start date rather than letting today's stand.\n\n" +
    "Two names cannot match: the API answers 409 \"Ansatt med dette navnet finnes allerede\" on a " +
    "duplicate NAME, not email, so real namesakes need distinguishing.\n\n" +
    "Passing accountNumber makes this a PAYMENT DESTINATION change and requires " +
    "REAI_WRITE_MODE=full — that account is where this person's salary will land, paid by " +
    "machinery nobody re-examines each month. Leave it out here and set it deliberately with " +
    "reai_set_employee_bank_account, which shows what changed.",
  risk: "reversible",
  apiPaths: [["POST", "/api/employees"]],
  inputSchema: {
    name: requiredName(75).describe(
      "Full name, at most 75 characters. Must be unique on the tenant — a duplicate is a 409.",
    ),
    email: z.string().describe("Email address. Required by the API."),
    phone: phoneArg.optional(),
    dateOfEmployment: isoDate
      .optional()
      .describe(
        "First day of employment, yyyy-MM-dd. Defaults to TODAY if omitted, and that date is " +
          "reported in the a-melding — pass the real one.",
      ),
    nationalIdentityNumber: z
      .string()
      .optional()
      .describe(
        "Fødselsnummer. Needed for the a-melding; omit if you do not have it yet. Checksum-" +
          'validated — an invalid one answers 400 "Ugyldig fødselsnummer".',
      ),
    accountNumber: employeeAccountArg
      .optional()
      .describe(
        "Salary account. Supplying it here escalates this call to a payment-destination change " +
          "(REAI_WRITE_MODE=full). Prefer reai_set_employee_bank_account.",
      ),
    addressPart1: z.string().optional().describe("Street address."),
    postalCode: z.string().optional().describe("Postal code."),
    city: z.string().optional().describe("City."),
    departmentId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Department id, from reai_list_departments."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...body } = args;
    const resolved = requireTenantId(tenantId, ctx);
    const res = await ctx.client.request<EmployeeRecord>({
      method: "POST",
      path: "/api/employees",
      body,
      tenantId: resolved,
    });
    const record = res.data ?? {};
    const id = typeof record.id === "number" ? record.id : undefined;
    const notes = [
      `Employee ${id ?? "?"} created: ${String(record.name ?? args.name)}.`,
      args.dateOfEmployment === undefined
        ? `No dateOfEmployment was given, so the API set ${JSON.stringify(record.dateOfEmployment ?? null)} ` +
          `— today. An employment relation was created with it, and employment is what the ` +
          `a-melding reports. Correct it with reai_update_employee if that is not the real start date.`
        : `Employment starts ${JSON.stringify(record.dateOfEmployment ?? null)}.`,
      args.accountNumber === undefined
        ? `No bank account, which means this employee cannot be included in a salary run yet — ` +
          `POST /api/salary-payments refuses the whole run and names them. Set one with ` +
          `reai_set_employee_bank_account.`
        : `Salary account set: ${JSON.stringify((record.bankAccount as EmployeeRecord | null)?.iban ?? null)}.`,
    ];
    const phoneNote = phoneOutcome(args.phone, record.phone);
    if (phoneNote) notes.push(phoneNote);
    return ok(redact(record), {
      note: notes.join("\n\n"),
      ...(id ? { link: ctx.client.deepLink(`/employees/${id}`, resolved) } : {}),
    });
  },
});

const updateEmployee = defineTool({
  name: "reai_update_employee",
  title: "Update an employee",
  description:
    "Change an employee's details. This endpoint is a REAL patch — verified by changing phone " +
    "alone and finding city, postal code, street, bank account, start date and employment lines " +
    "all untouched — so only the fields you pass are affected. That makes it unusual in this API; " +
    "most of its writes replace.\n\n" +
    "It deliberately does NOT take employmentLines, even though the endpoint accepts them: that " +
    "field IS a full replacement. Measured, an employee with two lines PATCHed with one came back " +
    "with one, the other gone and the survivor holding a new id — so a raise written that way " +
    "deletes the employment history. Use reai_add_employment_line, which reads the existing lines " +
    "and keeps them.\n\n" +
    "Nor does it take accountNumber; that is reai_set_employee_bank_account, so a payment " +
    "destination is never changed as a side effect of fixing a postal code.\n\n" +
    "Setting endDateOfEmployment ends the employment, which the a-melding reports. Pass null to " +
    "clear it — that one really does clear, measured.\n\n" +
    "What CANNOT be cleared here: phone and email. `null` on either is silently IGNORED — measured, " +
    "a stored \"+4722334455\" and a stored address both survived a PATCH that sent null for them — " +
    'and an empty email answers 409 "Employee email is required". So there is no way to remove ' +
    "either through this endpoint, and this tool does not pretend otherwise by accepting a null " +
    "that would do nothing while reporting a change. Overwrite them with a real value instead.",
  risk: "reversible",
  apiPaths: [["PATCH", "/api/employees/{id}"]],
  idempotent: true,
  inputSchema: {
    id: z.number().int().positive().describe("Employee id, from reai_list_employees."),
    name: requiredName(75)
      .optional()
      .describe("New name, at most 75 characters. Must stay unique on the tenant."),
    email: z.string().optional().describe("Email address."),
    phone: phoneArg.optional(),
    dateOfEmployment: isoDate.optional().describe("First day of employment, yyyy-MM-dd."),
    endDateOfEmployment: isoDate
      .nullable()
      .optional()
      .describe("Last day of employment. Ends the employment, which the a-melding reports; null clears it."),
    nationalIdentityNumber: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Fødselsnummer. Checksum-validated — an invalid one answers 400 "Ugyldig fødselsnummer", ' +
          "so this is not a field to fill in with a plausible-looking number. The spec types it " +
          "nullable and null is accepted; whether it actually clears a stored one was NOT " +
          "established, because setting one requires a real fødselsnummer.",
      ),
    addressPart1: z.string().optional().describe("Street address."),
    postalCode: z.string().optional().describe("Postal code."),
    city: z.string().optional().describe("City."),
    departmentId: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe("Department id; null detaches the employee from their department."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, ...body } = args;
    if (Object.values(body).every((value) => value === undefined)) {
      return fail(
        `No fields were given, so there is nothing to change on employee ${id}. Pass at least one.`,
      );
    }
    const res = await ctx.client.request<EmployeeRecord>({
      method: "PATCH",
      path: `/api/employees/${id}`,
      body,
      tenantId: requireTenantId(tenantId, ctx),
    });
    const record = res.data ?? {};
    const changed = Object.keys(body).filter((key) => body[key as keyof typeof body] !== undefined);
    const notes = [
      `Employee ${id} updated: ${changed.join(", ")}. This endpoint patches rather than replaces, ` +
        `so nothing else moved — verified against the live API.`,
    ];
    const phoneNote = phoneOutcome(args.phone, record.phone);
    if (phoneNote) notes.push(phoneNote);
    if (args.endDateOfEmployment != null) {
      notes.push(
        `endDateOfEmployment is now ${JSON.stringify(record.endDateOfEmployment ?? null)}. Ending an ` +
          `employment is reported to Skatteetaten in the a-melding for the period it is completed in.`,
      );
    }
    return ok(redact(record), { note: notes.join("\n\n") });
  },
});

const setEmployeeBankAccount = defineTool({
  name: "reai_set_employee_bank_account",
  title: "Set an employee's salary account",
  description:
    "Set or change the account an employee's salary is paid into. Separate from " +
    "reai_update_employee on purpose: this is a PAYMENT DESTINATION, and it is the sharpest one " +
    "in this API. Salary goes out on a schedule, through machinery nobody re-examines each month, " +
    "and the person who notices a wrong account is the employee whose pay did not arrive. It " +
    "requires REAI_WRITE_MODE=full and is worth confirming against something outside the " +
    "conversation — a signed form, not an email in a thread.\n\n" +
    "This is also the payroll precondition: POST /api/salary-payments refuses the WHOLE run with " +
    '400 "Følgende ansatte mangler bankkonto" when any included employee has no account, naming ' +
    "them. Employees are created without one.\n\n" +
    "The number goes in whole and comes back SPLIT — the response has no accountNumber field, " +
    "only bankAccount { bankCode, accountNumber, iban } — so this tool reads the account before " +
    "and after and reports both, because a repoint is worth seeing rather than inferring.",
  risk: "irreversible",
  apiPaths: [
    ["GET", "/api/employees/{id}"],
    ["PATCH", "/api/employees/{id}"],
  ],
  inputSchema: {
    id: z.number().int().positive().describe("Employee id, from reai_list_employees."),
    accountNumber: employeeAccountArg,
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    // Read first so the note can say whether this ADDED an account or REPOINTED one. The
    // difference matters: adding one is setup, repointing one redirects a salary that is already
    // being paid somewhere, and the caller should see which they just did.
    const before = await ctx.client.request<EmployeeRecord>({
      method: "GET",
      path: `/api/employees/${args.id}`,
      tenantId,
    });
    const previous = (before.data?.bankAccount ?? null) as EmployeeRecord | null;
    const res = await ctx.client.request<EmployeeRecord>({
      method: "PATCH",
      path: `/api/employees/${args.id}`,
      body: { accountNumber: args.accountNumber },
      tenantId,
    });
    const now = (res.data?.bankAccount ?? null) as EmployeeRecord | null;
    const name = String(res.data?.name ?? before.data?.name ?? args.id);

    // A 200 is not evidence that the account stored is the account sent, and on this operation
    // that difference is somebody's salary. The same API stores an unparseable PHONE as null and
    // answers 200, so "it did not error" carries no weight here.
    //
    // The comparison is on digits: the number goes in whole and comes back split, and measured,
    // bankCode + accountNumber concatenates back to exactly what was sent ("15201353103" →
    // "1520" + "1353103"). A non-Norwegian account need not split that way, so a mismatch is
    // reported loudly rather than treated as proof of failure — the write has already happened,
    // and refusing after the fact would only hide it.
    const digits = (value: unknown) => String(value ?? "").replace(/\D/g, "");
    const sent = digits(args.accountNumber);
    const storedDigits = `${digits(now?.bankCode)}${digits(now?.accountNumber)}`;
    const ibanDigits = digits(now?.iban);
    const stored =
      now !== null && (storedDigits === sent || ibanDigits.endsWith(sent));

    const verdict = !now
      ? `THE ACCOUNT WAS NOT STORED. The request answered HTTP ${res.status} but the record now ` +
        `holds no bankAccount at all, so ${name} still has nowhere for a salary to go — and a ` +
        `salary run including them will be refused. Read the employee with reai_get_employee, ` +
        `includePersonalData: true and try again.`
      : !stored
        ? `WHAT WAS STORED DOES NOT MATCH WHAT WAS SENT. ${JSON.stringify(args.accountNumber)} was ` +
          `sent; the record now holds bankCode ${JSON.stringify(now.bankCode ?? null)} + ` +
          `accountNumber ${JSON.stringify(now.accountNumber ?? null)} (iban ` +
          `${JSON.stringify(now.iban ?? null)}). For a Norwegian account those concatenate back to ` +
          `the number sent, so this needs looking at before anyone is paid — check it against the ` +
          `employee's own written details, not against this conversation. A foreign account may ` +
          `legitimately be stored differently.`
        : previous === null
          ? `Salary account ADDED for ${name}: ${JSON.stringify(now.iban ?? null)}, verified against ` +
            `what was sent. They had none, so they could not be included in a salary run until now.`
          : `Salary account REPOINTED for ${name}: was ${JSON.stringify(previous.iban ?? null)}, now ` +
            `${JSON.stringify(now.iban ?? null)}, verified against what was sent. Their next salary ` +
            `payment goes to the new one.`;

    const result = ok(res.data?.bankAccount ?? res.data, {
      note:
        verdict +
        `\n\nStored split, as this API does: bankCode ${JSON.stringify(now?.bankCode ?? null)} + ` +
        `accountNumber ${JSON.stringify(now?.accountNumber ?? null)}. Compare the iban with what you ` +
        `sent, not the accountNumber field.`,
    });
    // Flagged on the RESULT rather than passed to ok(), which takes no isError — a spread of
    // `{ isError: true }` into its options compiled fine and did nothing, since excess-property
    // checking does not reach a spread. And not fail(), because the write already happened: an
    // error that discards the body would hide what was actually stored.
    if (!stored) result.isError = true;
    return result;
  },
});

const addEmploymentLine = defineTool({
  name: "reai_add_employment_line",
  title: "Add an employment line",
  description:
    "Add an employment line to an employee — a salary level, a percentage, an occupation code, " +
    "each effective from a date. This is how a raise or a change of hours is recorded.\n\n" +
    "It exists because the obvious way is destructive. `employmentLines` on " +
    "PATCH /api/employees/{id} is a FULL REPLACEMENT inside an endpoint that otherwise patches: " +
    "measured, an employee with two lines PATCHed with one line came back with one, the other " +
    "gone, and even the survivor was recreated with a new id. So this tool reads the existing " +
    "lines, appends yours, and writes the whole set back — the shape this repo uses everywhere a " +
    "write replaces.\n\n" +
    "It refuses if the current lines cannot be read, because appending to nothing is the " +
    "replacement it exists to prevent.",
  risk: "irreversible",
  apiPaths: [
    ["GET", "/api/employees/{id}"],
    ["PATCH", "/api/employees/{id}"],
  ],
  inputSchema: {
    id: z.number().int().positive().describe("Employee id, from reai_list_employees."),
    fromDate: isoDate.describe(
      "The date this line takes effect, yyyy-MM-dd. Required by the API, and it cannot be before " +
        "the employee's dateOfEmployment — the API refuses the whole request if it is.",
    ),
    percentage: z
      .number()
      .optional()
      .describe("Employment percentage — 100 for full time, 50 for half."),
    annualSalary: z.number().optional().describe("Annual salary in NOK, for a fixed-salary employee."),
    hourlyWage: z.number().optional().describe("Hourly wage in NOK, for an hourly employee."),
    occupationCode: z
      .string()
      .optional()
      .describe("STYRK-08 occupation code, which the a-melding reports. Search /employee/occupation-codes/search."),
    municipality: z.string().optional().describe("Municipality number for the workplace."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const current = await ctx.client.request<EmployeeRecord>({
      method: "GET",
      path: `/api/employees/${args.id}`,
      tenantId,
    });
    const relations = current.data?.employmentRelations;
    if (!Array.isArray(relations)) {
      return fail(
        `Employee ${args.id}'s employment relations could not be read (the response had no ` +
          `employmentRelations array), so the existing lines are unknown and nothing was sent. ` +
          `Writing employmentLines REPLACES every line — measured — so a blind append would delete ` +
          `the employment history. Read the employee with reai_get_employee and check the shape.`,
      );
    }
    // The employee's own start date is in the record already, so the rule can be checked here
    // instead of coming back as a numbered Norwegian 400. Measured:
    // `400 "Ansettelseslinje 4: Fra-dato kan ikke være før ansettelsesstart"` — the number counts
    // lines in the REQUEST array, so it does not identify the offending line to a caller who did
    // not build that array. The rejection is atomic, verified: the existing lines all survived it.
    const employmentStart = current.data?.dateOfEmployment;
    if (typeof employmentStart === "string" && args.fromDate < employmentStart) {
      return fail(
        `An employment line cannot start before the employment does. Employee ${args.id} began on ` +
          `${employmentStart} and this line is dated ${args.fromDate}, so the API would refuse the ` +
          `whole request with "Ansettelseslinje N: Fra-dato kan ikke være før ansettelsesstart" — ` +
          `nothing was sent.\n\n` +
          `If ${args.fromDate} is genuinely when this person started, the employment start date is ` +
          `what is wrong: fix it with reai_update_employee dateOfEmployment first. That happens ` +
          `easily, because creating an employee without a start date sets it to TODAY.`,
      );
    }
    // Every relation checked, not just the top-level array. A relation whose employmentLines is
    // null, absent or some other shape was being flattened to zero lines and then written over —
    // and since this field REPLACES, that silently deletes whatever the malformed relation was
    // hiding. The refusal above claimed to cover "the lines cannot be read"; it only covered the
    // outer array. An EMPTY array is readable and fine; a non-array is not.
    const unreadable = relations.filter(
      (relation) => !Array.isArray((relation as EmployeeRecord).employmentLines),
    );
    if (unreadable.length > 0) {
      return fail(
        `Employee ${args.id} has ${unreadable.length} employment relation(s) whose employmentLines ` +
          `could not be read — ` +
          unreadable
            .map((relation) => {
              const record = relation as EmployeeRecord;
              return `relation ${JSON.stringify(record.id ?? null)} has ` +
                `${JSON.stringify(record.employmentLines ?? null)}`;
            })
            .join("; ") +
          `. Nothing was sent.\n\n` +
          `Writing employmentLines REPLACES every line on the employee — measured — so treating an ` +
          `unreadable relation as empty would delete whatever it holds. Read the record with ` +
          `reai_get_employee to see the real shape. An empty array is fine and this tool accepts ` +
          `it; only a missing or non-array value stops it.`,
      );
    }
    const existing = relations.flatMap(
      (relation) => (relation as EmployeeRecord).employmentLines as EmployeeRecord[],
    );
    // Sent back with their ids, so the API updates the rows it already has rather than
    // recreating them. Only the fields the request schema accepts — employmentType comes back as
    // an object and is not a request field, so echoing it verbatim would be sending the response
    // shape to a request endpoint.
    const carried = existing.map((line) => ({
      id: line.id,
      fromDate: line.fromDate,
      municipality: line.municipality,
      remunerationType: line.remunerationType,
      occupationCode: line.occupationCode,
      percentage: line.percentage,
      annualSalary: line.annualSalary,
      hourlyWage: line.hourlyWage,
    }));
    const added = {
      fromDate: args.fromDate,
      municipality: args.municipality ?? null,
      occupationCode: args.occupationCode ?? null,
      percentage: args.percentage ?? null,
      annualSalary: args.annualSalary ?? null,
      hourlyWage: args.hourlyWage ?? null,
    };
    const res = await ctx.client.request<EmployeeRecord>({
      method: "PATCH",
      path: `/api/employees/${args.id}`,
      body: { employmentLines: [...carried, added] },
      tenantId,
    });
    const after = Array.isArray(res.data?.employmentRelations)
      ? (res.data.employmentRelations as EmployeeRecord[]).flatMap((relation) =>
          Array.isArray(relation.employmentLines) ? (relation.employmentLines as EmployeeRecord[]) : [],
        )
      : [];
    return ok(redact(res.data), {
      note:
        `Employment line from ${args.fromDate} added to employee ${args.id}. ` +
        `${existing.length} existing line(s) were read and written back with it; the employee now ` +
        `has ${after.length}.` +
        (after.length === existing.length + 1
          ? ``
          : `\n\nTHAT DOES NOT ADD UP — ${existing.length} + 1 should be ${existing.length + 1}. ` +
            `Writing employmentLines replaces the whole set, so read the record with ` +
            `reai_get_employee and check what survived before doing anything else.`),
    });
  },
});

const deleteEmployee = defineTool({
  name: "reai_delete_employee",
  title: "Delete an employee",
  description:
    "Delete an employee record. Measured: DELETE answers 204 with no body and the record is GONE " +
    "— employees do not follow this API's archive-instead pattern, and there is no undelete.\n\n" +
    'It refuses with 409 "Employee cannot be deleted because related work data exists" once ' +
    "anything references them, and the bar is low: an EMPTY DRAFT salary run was enough. The " +
    "message does not say what the data is. Delete the salary run first and the same call answers " +
    "204.\n\n" +
    "For someone who has left, an end date is usually what is wanted rather than deletion — a " +
    "deleted employee takes their record out of the books, while endDateOfEmployment on " +
    "reai_update_employee records the leaving, which is what the a-melding reports.",
  risk: "reversible",
  destructive: true,
  apiPaths: [["DELETE", "/api/employees/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Employee id, from reai_list_employees."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<unknown>({
      method: "DELETE",
      path: `/api/employees/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data ?? { deleted: args.id }, {
      note:
        `Employee ${args.id} deleted (HTTP ${res.status}). This endpoint returns no body, so the ` +
        `status is the whole confirmation — the record is gone rather than archived, and there is ` +
        `no undelete. A 409 here would have meant work data still references them.`,
    });
  },
});

export const organisationTools: ToolDef[] = [
  listDepartments,
  getDepartment,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  listEmployees,
  getEmployee,
  employeeLedger,
  createEmployee,
  updateEmployee,
  setEmployeeBankAccount,
  addEmploymentLine,
  deleteEmployee,
];
