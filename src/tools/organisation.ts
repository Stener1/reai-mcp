import { z } from "zod";
import {
  defineTool,
  isoDate,
  ok,
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

function redact(employee: EmployeeRecord): EmployeeRecord {
  const out: EmployeeRecord = { ...employee };
  for (const field of PERSONAL_FIELDS) {
    if (out[field] === undefined || out[field] === null) continue;
    out[field] = `[redacted — pass includePersonalData: true to see it]`;
  }
  return out;
}

/** The fields that answer "who is this and where do they sit". */
function summarise(employee: EmployeeRecord): EmployeeRecord {
  const keep = [
    "id",
    "name",
    "email",
    "phone",
    "departmentId",
    "dateOfEmployment",
    "endDateOfEmployment",
  ];
  return Object.fromEntries(keep.filter((k) => employee[k] !== undefined).map((k) => [k, employee[k]]));
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
    const rows = Array.isArray(res.data) ? res.data : [];
    return ok(res.data, {
      note:
        rows.length === 0
          ? "No departments. That is not the same as departments being unavailable — an empty " +
            "list means none are defined, so nothing can be tagged with one yet."
          : `${rows.length} department(s).`,
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
  apiPaths: [["DELETE", "/api/departments/{id}"]],
  idempotent: false,
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
    "Everyone on the payroll, as a summary: id, name, email, phone, department and employment " +
    "dates. The id is what reai_list_postings, reai_general_ledger and reai_list_expenses take " +
    "as employeeId.\n\n" +
    "Deliberately a summary. The full record carries a national identity number and the bank " +
    "account salary is paid into, and a question about who works here should not put either in " +
    "the conversation. Use reai_get_employee with includePersonalData for one person when you " +
    "actually need them.",
  risk: "read",
  apiPaths: [["GET", "/api/employees"]],
  inputSchema: { tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<EmployeeRecord[]>({
      method: "GET",
      path: "/api/employees",
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const rows = Array.isArray(res.data) ? res.data : [];
    return ok(rows.map(summarise), {
      note:
        rows.length === 0
          ? "No employees are registered on this tenant."
          : `${rows.length} employee(s), summarised — national identity numbers and bank details ` +
            `are not included. reai_get_employee returns one full record.`,
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
    const held = PERSONAL_FIELDS.filter((f) => record[f] !== undefined && record[f] !== null);
    if (args.includePersonalData === true) {
      return ok(record, {
        note:
          held.length > 0
            ? `Includes ${held.join(" and ")} because includePersonalData was set.`
            : `The record carries no national identity number or bank account.`,
      });
    }
    return ok(redact(record), {
      note:
        held.length > 0
          ? `${held.join(" and ")} redacted. Pass includePersonalData: true if the task needs them.`
          : `The record carries no national identity number or bank account.`,
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
        `${args.isOpenPosting ? " (open postings only — window widened to catch older unsettled items)" : ""}.`,
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
