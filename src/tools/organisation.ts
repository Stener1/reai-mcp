import { z } from "zod";
import {
  defineTool,
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
    out[key] = PERSONAL_FIELDS.includes(key as (typeof PERSONAL_FIELDS)[number])
      ? "[redacted — pass includePersonalData: true to see it]"
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
    departmentId: z.number().int().positive().describe("Department id, from reai_list_departments."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request({
      method: "GET",
      path: `/api/departments/${args.departmentId}`,
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
    employeeId: z.number().int().positive().describe("Employee id, from reai_list_employees."),
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
      path: `/api/employees/${args.employeeId}`,
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

export const organisationTools: ToolDef[] = [
  listDepartments,
  getDepartment,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  listEmployees,
  getEmployee,
  employeeLedger,
];
