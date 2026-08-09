import { z } from "zod";
import {
  defineTool,
  fail,
  isoDate,
  ok,
  okList,
  confirmAgainstResponse,
  describeConfirmation,
  readableRecord,
  requireTenantId,
  tenantIdArg,
  type ToolDef,
} from "./registry.js";

/**
 * Payroll (lønn): salary runs, their wage lines, and everything short of completing one.
 *
 * Measured against test tenant 2783 by creating an employee, giving it a bank account, running a
 * period, adding and removing a manual line, and deleting the run. What follows is what that
 * showed, plus one thing deliberately left out.
 *
 * ## Completing a run is NOT here, and that is the point
 *
 * `POST /api/salary-payments/{id}/complete` is the most consequential single call in this API. Its
 * own description: it "finalizes the salary payment, creates its voucher and payslips, and creates
 * one employee payment per payable employee using the selected company bank. For Norwegian
 * tenants, the same A-melding validation and asynchronous submission flow as the web application
 * is started." So one call posts to the ledger, schedules real bank payments to real people, and
 * files with Skatteetaten — and once Skatteetaten accepts, withholding tax and employer
 * contribution payments are registered automatically.
 *
 * It is classified irreversible AND external, so it needs `REAI_WRITE_MODE=full` and
 * `REAI_ALLOW_EXTERNAL_SEND`. It is left to `reai_request` on the same reasoning the repo already
 * applied to `POST /api/subscriptions/generate-due`: the operation an agent would reach for to
 * "finish payroll" is the one where a mistake is widest, and the refusal there names exactly what
 * it would have done. Its `manualPayment` flag is the same dual-mode trap as the supplier-invoice
 * payment — false schedules real transfers.
 *
 * ## A run cannot be created until every employee has a bank account
 *
 * `POST /api/salary-payments` refuses with `400 "Følgende ansatte mangler bankkonto: <names>"` —
 * Norwegian for "the following employees are missing a bank account" — and it names them. Employees
 * are created WITHOUT one, so this is the normal first failure. Set it with `accountNumber` on
 * create or on `PATCH /api/employees/{id}`, which is a payment destination and gated accordingly.
 *
 * ## Creating a run posts nothing
 *
 * Measured before and after with a voucher lister that throws on a non-200: the count did not
 * move, and `voucherId` on the run stays null. That matches the completion description, which is
 * where the voucher is made. So a created run is a draft, and deleting it leaves no trace in the
 * ledger — verified, DELETE answered 200 and the count stayed at zero.
 *
 * ## Half the gross was withheld, because there is no tax card
 *
 * A COMMISSION line of 1 × 5000 produced `payableAmount: 2500` and `totalTaxDeducted: 2500`, with
 * `taxDeductionRate: 50` on the employee entry. On a tenant with real tax cards the rate comes
 * from those; with none, 50% is what this API applies. Worth knowing before reading a payable
 * amount as what somebody will receive.
 */

/** The wage-line types the API accepts, from the spec's own enum. */
const SPECIFICATION_CODES = [
  "FIXED_SALARY",
  "HOURLY_SALARY",
  "COMMISSION",
  "VACATION_DEDUCTION",
  "DEBT_TO_EMPLOYEES_EXPENSE",
  "EMPLOYEES_TRAVEL_EXPENSE",
  "OTHER_REPORTABLE_EXPENSE_ALLOWANCE",
  "HOLIDAY_ALLOWANCE",
] as const;

const specificationCode = z
  .enum(SPECIFICATION_CODES)
  .describe(
    "What kind of line this is. COMMISSION is reported as honorarAkkordProsentProvisjon in the " +
      "a-melding; HOLIDAY_ALLOWANCE is the only one that may carry holidayAllowanceEarningYear.",
  );

const quantity = z
  .number()
  .describe("Hours for HOURLY_SALARY; 1 for an amount-based line such as COMMISSION.");

const rate = z.number().describe("Amount per unit. The line is quantity × rate.");

type SalaryRun = {
  id?: number;
  number?: string;
  status?: string;
  payableAmount?: number;
  totalTaxDeducted?: number;
  voucherId?: number | null;
  paymentDate?: string | null;
  employees?: Array<{
    employeeId?: number;
    employeeName?: string;
    payableAmount?: number;
    taxDeducted?: number;
    taxDeductionRate?: number;
    wageSpecs?: Array<Record<string, unknown>>;
  }>;
};

/** What a run's status means for whether it can still be changed. */
function describeStatus(status: string | undefined): string {
  switch (status) {
    case "under_process":
      return "Status under_process: still a draft. Nothing is in the ledger and no payment exists.";
    case "unpaid":
      return "Status unpaid: finalised but not paid out. The voucher exists; the money has not moved.";
    case "complete":
      return "Status complete: the voucher is posted, payslips exist, employee payments were created " +
        "and — on a Norwegian tenant — the a-melding was submitted. Wage lines can no longer be changed.";
    case "reversed":
      return "Status reversed: this run was undone. Read the ledger to see what the reversal posted.";
    default:
      return `Status ${JSON.stringify(status)} is not one this server has seen (the enum is ` +
        `under_process | unpaid | complete | reversed). Read the record before acting on it.`;
  }
}

const listSalaryRuns = defineTool({
  name: "reai_list_salary_runs",
  title: "List salary runs",
  description:
    "Payroll runs (lønnskjøringer): which periods have been run, what each pays out, and how far " +
    "along it is.\n\n" +
    "A run is a draft while its status is under_process — nothing is in the ledger and nobody has " +
    "been paid. The statuses are under_process | unpaid | complete | reversed.",
  risk: "read",
  apiPaths: [["GET", "/api/salary-payments"]],
  inputSchema: { tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<Array<{ status?: string }>>({
      method: "GET",
      path: "/api/salary-payments",
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    // Narrowed once rather than coerced: `Array.isArray(x) ? x.length : 0` is the shape the
    // list-shape guard exists to catch, because reporting a non-array as zero is how "no runs" gets
    // said about a response nobody read.
    const rows = Array.isArray(res.data) ? res.data : undefined;
    const drafts = rows?.filter((r) => r.status === "under_process").length;
    return okList(res.data, {
      noun: "salary run",
      suffix: rows?.length ? `. ${drafts} still under_process (draft).` : ".",
      empty:
        "No salary runs. That means none has been created through this API or the web app — not " +
        "that nobody has been paid, since wages could have been booked as ordinary vouchers.",
    });
  },
});

const getSalaryRun = defineTool({
  name: "reai_get_salary_run",
  title: "Get one salary run",
  description:
    "One payroll run: its status, what it will pay, the tax withheld, and each employee's wage " +
    "lines.\n\n" +
    "Read the tax rate before reading the payable amount as take-home. Measured on a tenant with " +
    "no tax cards, `taxDeductionRate` was 50 and a 5000 line produced 2500 payable and 2500 " +
    "withheld — the rate comes from the employee's tax card where there is one.",
  risk: "read",
  apiPaths: [["GET", "/api/salary-payments/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Salary run id, from reai_list_salary_runs."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<SalaryRun>({
      method: "GET",
      path: `/api/salary-payments/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const run = res.data;
    const notes = [describeStatus(run?.status)];
    const employees = run?.employees;
    if (Array.isArray(employees)) {
      const lines = employees.reduce((n, e) => n + (e.wageSpecs?.length ?? 0), 0);
      notes.push(
        `${employees.length} employee(s), ${lines} wage line(s), ${run?.payableAmount ?? "?"} payable ` +
          `and ${run?.totalTaxDeducted ?? "?"} withheld.` +
          (lines === 0
            ? " No wage lines at all, so this run pays nothing yet — lines come from expense " +
              "postings or from reai_add_salary_line."
            : ""),
      );
      const rates = [...new Set(employees.map((e) => e.taxDeductionRate).filter((r) => r !== undefined))];
      if (rates.length === 1 && rates[0] === 50) {
        notes.push(
          `Every employee is at a 50% deduction rate, which is what this API applies when there is ` +
            `no tax card. If these people have tax cards, something has not been read.`,
        );
      }
    } else if (run) {
      notes.push("The response carried no `employees` array — read the body rather than assuming it is empty.");
    }
    if (run?.voucherId) {
      notes.push(`Voucher ${run.voucherId} is posted for this run; it is in the ledger.`);
    }
    return ok(run, { note: notes.join("\n\n") });
  },
});

const createSalaryRun = defineTool({
  name: "reai_create_salary_run",
  title: "Start a salary run",
  description:
    "Open a payroll run for a period. It arrives as a DRAFT: status under_process, no voucher, " +
    "nobody paid — measured, the ledger count did not move and voucherId stayed null.\n\n" +
    "What it does contain is not nothing: a run is pre-populated with wage lines derived from " +
    "expense postings for the period, and those lines cannot be edited (the API says so on the " +
    "update endpoint). So read the run before adding anything, or the same pay goes in twice.\n\n" +
    "Omitting employeeIds includes everyone the API considers ELIGIBLE for the period, which is " +
    "its wording and not the same as every employee on the books — read employeeIds on the " +
    "response when it matters who is in the run.\n\n" +
    "Every employee included must already have a bank account, or the whole call is refused with " +
    '400 "Følgende ansatte mangler bankkonto" naming the ones that do not. Employees are created ' +
    "without one; set it with accountNumber on the employee.\n\n" +
    "Requires REAI_WRITE_MODE=full. Completing the run is a separate operation and deliberately " +
    "not a tool here — see reai_api_notes for POST /api/salary-payments/{id}/complete, which posts " +
    "the voucher, creates the payslips, schedules real payments and files the a-melding.",
  risk: "irreversible",
  apiPaths: [["POST", "/api/salary-payments"]],
  inputSchema: {
    period: z
      .string()
      .regex(/^\d{4}-\d{2}$/, "The salary period is YYYY-MM, e.g. 2026-08.")
      .describe("Salary period, YYYY-MM."),
    paymentDate: isoDate.describe("When the salary is to be paid out, yyyy-MM-dd."),
    employeeIds: z
      .array(z.number().int().positive())
      .min(1)
      .optional()
      .describe(
        "Which employees to include. Omitting it, or sending an empty list, includes every employee " +
          "ELIGIBLE FOR THE PERIOD — the API's own wording — so passing nothing is not the same as " +
          "passing nobody. It is not the whole register either: who counts as eligible is the API's " +
          "rule and is not documented, so read employeeIds on the response when coverage matters.",
      ),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...body } = args;
    const res = await ctx.client.request<SalaryRun & { employeeIds?: number[] }>({
      method: "POST",
      path: "/api/salary-payments",
      body,
      tenantId: requireTenantId(tenantId, ctx),
    });
    const run = res.data;
    const notes = [
      `Salary run ${run?.id ?? "?"} (${run?.number ?? "no number"}) opened for ${args.period}, ` +
        `paying ${run?.paymentDate ?? args.paymentDate}. ${describeStatus(run?.status)}`,
    ];
    if (args.employeeIds === undefined) {
      // Deliberately reports the count the API came back with rather than describing the set. The
      // endpoint includes everyone ELIGIBLE for the period, and what makes an employee ineligible
      // is undocumented, so "every employee" would be an overstatement a caller could act on —
      // reading a run as covering the whole register and missing someone left out.
      const included = run?.employeeIds;
      notes.push(
        Array.isArray(included)
          ? `No employeeIds were given, so the API included everyone it considers ELIGIBLE for ` +
            `${args.period}: ${included.length} employee(s) — ids ${included.join(", ") || "none"}. ` +
            `That is not necessarily every employee on the books. Compare it against ` +
            `reai_list_employees if coverage matters.`
          : `No employeeIds were given, so the API included everyone it considers ELIGIBLE for ` +
            `${args.period} — which is not necessarily every employee. The response carried no ` +
            `employeeIds, so read the run back to see who is actually in it.`,
      );
    }
    notes.push(
      `Read it with reai_get_salary_run before adding lines: a run comes pre-populated from ` +
        `expense postings for the period, and adding the same pay again is the way to double it.`,
    );
    return ok(run, { note: notes.join("\n\n") });
  },
});

const addSalaryLine = defineTool({
  name: "reai_add_salary_line",
  title: "Add a wage line",
  description:
    "Add a manual wage line to an employee in a run that is still under_process — a commission, " +
    "an hourly amount, a holiday allowance.\n\n" +
    "The response is the whole run with tax and payable amounts recalculated, so read what came " +
    "back rather than assuming the line's amount is what the employee receives: measured, a 5000 " +
    "line on a tenant with no tax card produced 2500 payable and 2500 withheld.\n\n" +
    "This ADDS. It does not replace, and a run already carries lines derived from expense " +
    "postings — check reai_get_salary_run first if you do not want to pay something twice.",
  risk: "irreversible",
  apiPaths: [["POST", "/api/salary-payments/{id}/wage-specs"]],
  inputSchema: {
    id: z.number().int().positive().describe("Salary run id."),
    employeeId: z
      .number()
      .int()
      .positive()
      .describe("Which employee the line belongs to. Required here — and NOT accepted on an update."),
    specificationCode,
    quantity,
    rate,
    comment: z.string().nullable().optional().describe("Shown on the payslip."),
    holidayAllowanceEarningYear: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe("Only allowed on a HOLIDAY_ALLOWANCE line; the API refuses it on the others."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id } = args;
    // Listed field by field, like the update tool, so the body is exactly what this endpoint
    // takes and no argument can ride along into it.
    const body = {
      employeeId: args.employeeId,
      specificationCode: args.specificationCode,
      quantity: args.quantity,
      rate: args.rate,
      comment: args.comment,
      holidayAllowanceEarningYear: args.holidayAllowanceEarningYear,
    };
    if (body.holidayAllowanceEarningYear != null && body.specificationCode !== "HOLIDAY_ALLOWANCE") {
      return fail(
        `holidayAllowanceEarningYear is only allowed on a HOLIDAY_ALLOWANCE line, and this one is ` +
          `${body.specificationCode}. Nothing was sent — the API refuses the combination.`,
      );
    }
    const res = await ctx.client.request<SalaryRun>({
      method: "POST",
      path: `/api/salary-payments/${id}/wage-specs`,
      body,
      tenantId: requireTenantId(tenantId, ctx),
    });
    const run = res.data;
    const employee = run?.employees?.find((e) => e.employeeId === args.employeeId);
    return ok(run, {
      note:
        `Added ${args.quantity} × ${args.rate} as ${args.specificationCode} to employee ` +
        `${args.employeeId} in run ${id}. ` +
        (employee
          ? `That employee is now at ${employee.payableAmount ?? "?"} payable and ` +
            `${employee.taxDeducted ?? "?"} withheld (rate ${employee.taxDeductionRate ?? "?"}%). `
          : `The response carried no entry for that employee — read the body below. `) +
        `Run total: ${run?.payableAmount ?? "?"} payable. ${describeStatus(run?.status)}`,
    });
  },
});

const updateSalaryLine = defineTool({
  name: "reai_update_salary_line",
  title: "Change a wage line",
  description:
    "Change a manual wage line on a run that is still under_process.\n\n" +
    "The underlying PUT is a FULL REPLACEMENT: measured on the test tenant, a line carrying " +
    'comment "PROBE COMMENT" was updated with the same quantity and rate but no comment field, and ' +
    "the comment came back null — confirmed on a re-read. So this tool reads the line first and " +
    "carries over what you do not mention. Omit a field to KEEP it; pass null to CLEAR it. " +
    "quantity, rate and specificationCode are required by the API, so they are required here.\n\n" +
    "Note what this does NOT take: employeeId. The create endpoint requires it and the update " +
    'endpoint rejects it — measured, sending it answers 400 "Unknown field: employeeId". A line ' +
    "belongs to the employee it was created for and cannot be moved.\n\n" +
    "Lines derived from EXPENSE POSTINGS cannot be changed at all; the API says so on this " +
    "endpoint. Only lines added by hand are editable.",
  risk: "irreversible",
  apiPaths: [
    ["GET", "/api/salary-payments/{id}"],
    ["PUT", "/api/salary-payments/{id}/wage-specs/{wageSpecId}"],
  ],
  inputSchema: {
    id: z.number().int().positive().describe("Salary run id."),
    wageSpecId: z
      .number()
      .int()
      .positive()
      .describe("The line's id, from the wageSpecs array in reai_get_salary_run."),
    specificationCode,
    quantity,
    rate,
    comment: z
      .string()
      .nullable()
      .optional()
      .describe("Shown on the payslip. Omit to keep the current one; pass null to clear it."),
    holidayAllowanceEarningYear: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe(
        "Only allowed on a HOLIDAY_ALLOWANCE line. Omit to keep the current value; null to clear it.",
      ),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, wageSpecId } = args;
    const resolvedTenant = requireTenantId(tenantId, ctx);

    // Read before writing, because the PUT replaces rather than patches — measured: a line with a
    // comment, updated without the comment field, came back with comment null. Reading the line and
    // carrying over what the caller did not mention is the same shape used for company banks,
    // creditors, agreements and subscriptions, all of which erased a field by omission first.
    const current = await ctx.client.request<SalaryRun>({
      method: "GET",
      path: `/api/salary-payments/${id}`,
      tenantId: resolvedTenant,
    });
    // The read is already happening for the merge, so the run's status is in hand for free. Using
    // it turns a raw 400 into a sentence that says what state the run is in — and refuses rather
    // than letting a wage line drift out of step with a voucher that is already posted.
    //
    // Stated honestly: that the API rejects this is INFERRED from the completion description, not
    // measured, because producing a completed run requires filing the a-melding. If the inference
    // is wrong, this refusal is the only thing in the way and it names the way around it.
    const runStatus = current.data?.status;
    if (runStatus !== undefined && runStatus !== "under_process") {
      return fail(
        `Salary run ${id} has status ${JSON.stringify(runStatus)}, not under_process. Nothing was ` +
          `sent.\n\n` +
          `${describeStatus(typeof runStatus === "string" ? runStatus : undefined)}\n\n` +
          `Changing a wage line on a run whose voucher is already posted would leave the line and ` +
          `the ledger disagreeing. This server refuses rather than find out on real books; whether ` +
          `the API would also refuse was not established, since producing such a run means filing ` +
          `the a-melding. If you have decided otherwise, reai_request PUT ` +
          `/api/salary-payments/${id}/wage-specs/${wageSpecId} will do it.`,
      );
    }
    const stored = current.data?.employees
      ?.flatMap((e) => e.wageSpecs ?? [])
      .find((line) => line.id === wageSpecId);
    if (stored === undefined) {
      return fail(
        `Wage line ${wageSpecId} was not found on salary run ${id}, so there is nothing to merge ` +
          `over and nothing was sent. This PUT replaces the line, so writing without reading it ` +
          `first is how a comment or a holiday-allowance year gets erased. Read the run with ` +
          `reai_get_salary_run and check the wageSpecs ids — a line derived from an expense posting ` +
          `is also not editable, and this run's status may no longer allow changes at all.`,
      );
    }

    // Listed field by field rather than spread from the arguments, because the ONE field that must
    // never reach this endpoint is a field the sibling create tool requires: employeeId answers 400
    // here. A spread would send whatever a caller passed and rely on schema stripping to save it.
    //
    // `undefined` means "not mentioned" and takes the stored value; an explicit null clears, which
    // is the only way to clear either field, so the two cases must stay distinguishable.
    const kept: string[] = [];
    const carry = <T>(name: string, given: T | null | undefined, existing: unknown): T | null => {
      if (given !== undefined) return given;
      kept.push(name);
      return (existing ?? null) as T | null;
    };
    const body = {
      specificationCode: args.specificationCode,
      quantity: args.quantity,
      rate: args.rate,
      comment: carry("comment", args.comment, stored.comment),
      holidayAllowanceEarningYear: carry(
        "holidayAllowanceEarningYear",
        args.holidayAllowanceEarningYear,
        stored.holidayAllowanceEarningYear,
      ),
    };
    if (body.holidayAllowanceEarningYear != null && body.specificationCode !== "HOLIDAY_ALLOWANCE") {
      // Two ways to get here, and they need different advice. Passing the year explicitly on a
      // non-holiday line is a plain mistake. Carrying one over is a mistake this merge INTRODUCED:
      // changing a HOLIDAY_ALLOWANCE line to another code while its stored year came along would
      // build the one combination the API refuses, out of fields the caller never mentioned.
      const carried = args.holidayAllowanceEarningYear === undefined;
      return fail(
        `holidayAllowanceEarningYear is only allowed on a HOLIDAY_ALLOWANCE line, and this one ` +
          `would be ${body.specificationCode}. Nothing was sent.\n\n` +
          (carried
            ? `You did not pass that field — line ${wageSpecId} already carries ` +
              `${JSON.stringify(body.holidayAllowanceEarningYear)}, and this tool keeps what you do ` +
              `not mention. To change the line's type, clear the year in the same call: pass ` +
              `holidayAllowanceEarningYear: null.`
            : `The API refuses the combination, so it was not attempted.`),
      );
    }
    const res = await ctx.client.request<SalaryRun>({
      method: "PUT",
      path: `/api/salary-payments/${id}/wage-specs/${wageSpecId}`,
      body,
      tenantId: resolvedTenant,
    });
    // The amounts come from the RESPONSE's own line, not from `args`. This is payroll: quoting the request
    // back as "Line N is now Q × R" states a figure nobody checked, and the response nests the stored line at
    // employees[].wageSpecs[] where it can be found by id. Of the five tools that reported an outcome from the
    // request, this was the one whose numbers matter most.
    // `SalaryWageSpecRes.id` is assumed to BE the wageSpecId the path takes — both are int32 and the parameter
    // carries no description, so that is read off the schema rather than measured. If the assumption is wrong
    // the lookup finds nothing and the note falls back to reporting what was sent, which is safe; the two
    // fallback messages are worded differently so a wrong assumption shows up as "no line matched" instead of
    // hiding behind "the response did not carry the line".
    const returnedLines = (Array.isArray(res.data?.employees) ? res.data.employees : []).flatMap(
      (e: { wageSpecs?: unknown }) => (Array.isArray(e?.wageSpecs) ? e.wageSpecs : []),
    );
    const storedLine = returnedLines.find((l: { id?: unknown }) => l?.id === wageSpecId) as
      | Record<string, unknown>
      | undefined;
    const confirmation = confirmAgainstResponse(body, storedLine);
    const notes = [
      (storedLine
        ? `Line ${wageSpecId} in run ${id} is now ${storedLine.quantity} × ${storedLine.rate} as ` +
          `${storedLine.specificationCode}, read back from the response.`
        : `Line ${wageSpecId} in run ${id} was sent as ${args.quantity} × ${args.rate} as ` +
          `${args.specificationCode}. ` +
          (returnedLines.length === 0
            ? `The response carried no lines, so that is what was SENT, not what is stored`
            : `The response carried ${returnedLines.length} line(s) but none with id ${wageSpecId}, so that ` +
              `is what was SENT, not what is stored`) +
          ` — read it back with reai_get_salary_run.`) +
        ` Run total: ${res.data?.payableAmount ?? "?"} payable, ${res.data?.totalTaxDeducted ?? "?"} withheld.`,
      ...describeConfirmation(confirmation, `line ${wageSpecId}`),
    ];
    if (kept.length > 0) {
      notes.push(
        `Written back unchanged because you did not mention them: ${kept.join(", ")}. ` +
          `This PUT replaces the line, so omitting a field would otherwise have cleared it — ` +
          `pass null explicitly when clearing is what you want.`,
      );
    }
    return ok(res.data, { note: notes.join("\n\n") });
  },
});

const deleteSalaryLine = defineTool({
  name: "reai_delete_salary_line",
  title: "Remove a wage line",
  description:
    "Remove a manual wage line from a run that is still under_process. The run's tax and payable " +
    "amounts are recalculated — measured, removing the only line took the payable back to 0.\n\n" +
    "A line derived from an expense posting is not editable, so if a removal is refused, that is " +
    "the likely reason.",
  risk: "irreversible",
  destructive: true,
  apiPaths: [["DELETE", "/api/salary-payments/{id}/wage-specs/{wageSpecId}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Salary run id."),
    wageSpecId: z.number().int().positive().describe("The line's id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<SalaryRun>({
      method: "DELETE",
      path: `/api/salary-payments/${args.id}/wage-specs/${args.wageSpecId}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data ?? { removed: args.wageSpecId }, {
      note:
        `Line ${args.wageSpecId} removed from run ${args.id}` +
        (res.data?.payableAmount !== undefined
          ? `; the run now pays ${res.data.payableAmount}.`
          : `. The response carried no total — read the run back to see where it stands.`),
    });
  },
});

const deleteSalaryRun = defineTool({
  name: "reai_delete_salary_run",
  title: "Delete a salary run",
  description:
    "Delete a payroll run that is still a draft. Measured on one (under_process): DELETE answers " +
    '200 with {"outcome":"deleted"} and the ledger is untouched, because a draft has posted ' +
    "nothing.\n\n" +
    "The endpoint is really \"delete OR REVERSE\": by its own description it deletes when no " +
    'accounting reversal is needed and RECORDS A REVERSAL when audit history must be kept, ' +
    'answering {"outcome":"reversed"} instead. A reversal posts to the ledger.\n\n' +
    "So this tool reads the run first and refuses anything not still under_process — and then " +
    "reads the outcome the API returned rather than assuming the precondition held. There is no " +
    "conditional-delete or version parameter on this endpoint, so the check cannot be atomic: if " +
    "someone completes the run in the window between the two calls, the DELETE lands on a " +
    "completed run and reverses it. That is what the outcome field is read for, and the tool says " +
    "plainly which of the two happened instead of claiming the ledger is safe.\n\n" +
    "To delete a completed run deliberately, use reai_request — the refusal here names it.",
  risk: "irreversible",
  destructive: true,
  apiPaths: [
    ["GET", "/api/salary-payments/{id}"],
    ["DELETE", "/api/salary-payments/{id}"],
  ],
  inputSchema: {
    id: z.number().int().positive().describe("Salary run id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const current = await ctx.client.request<SalaryRun>({
      method: "GET",
      path: `/api/salary-payments/${args.id}`,
      tenantId,
    });
    const { record, problem } = readableRecord(current.data, undefined, [
      "id",
      "number",
      "status",
    ]);
    if (problem !== undefined || record === undefined) {
      return fail(
        `Salary run ${args.id} could not be read back before deleting (${problem ?? "no record"}), so its status ` +
          `is unknown. Nothing was deleted: this tool only deletes a run it has confirmed is still ` +
          `a draft, and "probably a draft" is not that. Read it with reai_get_salary_run first.`,
      );
    }
    const status = record.status;
    if (status !== "under_process") {
      return fail(
        `Salary run ${args.id} has status ${JSON.stringify(status)}, not under_process. Nothing was ` +
          `deleted.\n\n` +
          `${describeStatus(typeof status === "string" ? status : undefined)}\n\n` +
          `What deleting a run in that state does was never established — producing one requires ` +
          `completing it, which posts a voucher, creates payslips, schedules payments and files the ` +
          `a-melding. If you ` +
          `have decided to do it anyway, reai_request DELETE /api/salary-payments/${args.id} will.`,
      );
    }
    const res = await ctx.client.request<{ outcome?: string }>({
      method: "DELETE",
      path: `/api/salary-payments/${args.id}`,
      tenantId,
    });
    // The status check above is a precondition, not a lock: this endpoint takes no version or
    // conditional parameter, so a completion landing between the GET and the DELETE turns the same
    // call into a REVERSAL. The outcome field is the only thing that knows which happened, and
    // reporting "the ledger is unaffected" without reading it would be a claim about the books
    // made from a check that had already expired.
    const outcome = res.data?.outcome;
    return ok(res.data ?? { deleted: args.id }, {
      note:
        outcome === "deleted"
          ? `Draft salary run ${args.id} deleted (HTTP ${res.status}), outcome "deleted". Nothing ` +
            `was posted for a draft, so the ledger is unaffected.`
          : outcome === "reversed"
            ? `Salary run ${args.id} was REVERSED, not deleted (HTTP ${res.status}, outcome ` +
              `"reversed"). The API records a reversal when audit history must be kept, which ` +
              `means this run was no longer a draft by the time the delete landed — it was read ` +
              `as under_process moments earlier, so it was completed in between. A reversal POSTS ` +
              `TO THE LEDGER. Read the run and its voucher before doing anything else, and tell ` +
              `whoever completed it.`
            : `Salary run ${args.id}: DELETE answered HTTP ${res.status}, but the response carried ` +
              `no recognised outcome (${JSON.stringify(outcome)}). This endpoint deletes OR ` +
              `records a reversal and says which, so with neither word present, whether anything ` +
              `was posted is unknown — read the run and the ledger rather than assuming it was a ` +
              `clean delete.`,
    });
  },
});

export const salaryTools: ToolDef[] = [
  listSalaryRuns,
  getSalaryRun,
  createSalaryRun,
  addSalaryLine,
  updateSalaryLine,
  deleteSalaryLine,
  deleteSalaryRun,
];
