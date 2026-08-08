import { z } from "zod";
import {
  defineTool,
  fail,
  isoDate,
  ok,
  requireTenantId,
  tenantIdArg,
  type ToolDef,
} from "./registry.js";

/**
 * Employee expense claims (utlegg og reiseregninger) — the whole state machine, measured.
 *
 * `GET /api/expenses` was the only covered operation of ten. The rest is a real workflow with a
 * real ledger consequence at the end of it, and it is the other half of something this server
 * already knows about: a salary run arrives pre-populated with wage lines derived from expense
 * postings for the period, so what happens here is what a payroll run pays out.
 *
 * ## The lifecycle, driven end to end on the test tenant
 *
 *   open  --deliver-->  for_approval  --approve-->  approved  --voucher-->  approved + voucherId
 *
 * And back down again: DELETE the voucher, then unapprove, and the expense is editable once more.
 * Booking is where the ledger moves — the voucher count went 0 to 1 and the voucher came back as
 * `{expenseId, voucherId, voucherNumber: "EX1-2026", voucherDate}`, its own number series.
 *
 * ## Three traps, all measured
 *
 * 1. `status` NEVER says "booked". A booked expense still reads `approved`; the only difference is
 *    that `voucherId` is set. So "is this in the ledger" is answered by voucherId, not by status.
 *
 * 2. `status` never says "reversed" either, and this one is worse. `DELETE /api/expenses/{id}`
 *    answers `{"outcome":"reversed"}` and the expense then VANISHES from the list — while
 *    `GET /api/expenses/{id}` still returns it with whatever status it had before. A reversed
 *    expense is therefore indistinguishable from a live one on a detail read. `?status=reversed`
 *    is not a way to ask: the filter rejects the word with a 400. The only positive signal the API
 *    offers is that a transition fails, e.g. `409 "Expense 2203 is reversed and can no longer be
 *    delivered"`. `reai_get_expense` spends one filtered list call to answer the question properly.
 *
 * 3. `category` on a cost row is optional to CREATE and required to DELIVER — the row is accepted
 *    with a null category and then `POST .../deliver` answers
 *    `400 "Kategori må velges for kostnadsrad."`, which names no row. It is an enum of 28 values.
 */

/** The cost categories the API accepts, from its own enum. They drive account mapping. */
const EXPENSE_CATEGORIES = [
  "advertising",
  "broadband",
  "exchange_fee",
  "flight",
  "food_non_taxable",
  "food_taxable",
  "fuel_company_vehicles",
  "fuel_rental_car",
  "hotel",
  "it_expense",
  "meeting_course_training",
  "newspapers_magazines_books",
  "office_supplies",
  "other_office_expense",
  "parking",
  "postage",
  "public_transport",
  "rental_car",
  "representation_deductible",
  "representation_non_deductible",
  "road_toll",
  "social",
  "software",
  "taxi",
  "telephone",
  "travel_non_taxable",
  "vehicle_maintenance",
  "work_clothes",
] as const;

/** Per-diem trip types. A day trip has no dateTo; an overnight stay requires one. */
const TRIP_TYPES = ["with_overnight_stay", "day_trip_6_to_12_hours", "day_trip_over_12_hours"] as const;

type ExpenseRecord = {
  id?: number;
  startDate?: string | null;
  endDate?: string | null;
  number?: number;
  title?: string;
  status?: string;
  employeeId?: number | null;
  employeeName?: string | null;
  travel?: boolean;
  includedInPayslip?: boolean;
  totalAmount?: number;
  voucherId?: number | null;
  voucherNumber?: string | null;
  voucherDate?: string | null;
  costs?: Array<Record<string, unknown>>;
  perDiems?: Array<Record<string, unknown>>;
  mileageAllowances?: Array<Record<string, unknown>>;
};

/**
 * A date window guaranteed to contain this expense, for the liveness lookup.
 *
 * GET /api/expenses defaults startDate to 1 January of the current year and endDate to today. Both
 * ends matter: a claim from last year and a claim dated tomorrow are each outside the default
 * window, and the lookup reads absence as a reversal. So the window is derived from the record's own
 * dates — its startDate/endDate when present, otherwise the span of its rows — and then padded a
 * year in both directions, because the field the list filters on is not documented and being
 * generous costs nothing while being wrong costs a false "this was withdrawn".
 *
 * Returns undefined when no date can be found at all, so the caller can decline to guess.
 */
function expenseWindow(expense: ExpenseRecord): { startDate: string; endDate: string } | undefined {
  const isDate = (value: unknown): value is string =>
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value);
  const dates = [
    expense.startDate,
    expense.endDate,
    ...(expense.costs ?? []).map((row) => row.date),
    ...(expense.perDiems ?? []).flatMap((row) => [row.dateFrom, row.dateTo]),
    ...(expense.mileageAllowances ?? []).map((row) => row.date),
  ]
    .filter(isDate)
    .map((value) => value.slice(0, 10))
    .sort();
  const earliest = dates[0];
  const latest = dates[dates.length - 1];
  if (earliest === undefined || latest === undefined) return undefined;
  const shift = (day: string, years: number): string =>
    `${String(Number(day.slice(0, 4)) + years).padStart(4, "0")}${day.slice(4)}`;
  return { startDate: shift(earliest, -1), endDate: shift(latest, 1) };
}

/** What a status means for what can be done next, and what the field does NOT tell you. */
function describeExpense(expense: ExpenseRecord): string {
  const booked = expense.voucherId != null;
  switch (expense.status) {
    case "open":
      return "Status open: still a draft. Nothing is posted; edit it freely, then deliver it.";
    case "for_approval":
      return (
        "Status for_approval: delivered and waiting. It can be approved, or booked directly — " +
        "booking approves it as part of the same call."
      );
    case "approved":
      return booked
        ? `Status approved AND voucher ${expense.voucherId} is posted — this IS in the ledger. ` +
          `The status field does not say "booked"; voucherId is the only thing that does. Delete ` +
          `the voucher before changing anything.`
        : "Status approved with NO voucher linked right now. That is not the same as no ledger " +
          "history: if a voucher was previously REVERSED rather than deleted, the original and its " +
          "reversal both remain posted while this field goes back to null, and nothing in this " +
          "response can tell the two cases apart — read the ledger if it matters. Book it to post " +
          "a voucher, or unapprove it to edit it again.";
    default:
      return (
        `Status ${JSON.stringify(expense.status)} is not one this server has seen (the response ` +
        `enum is open | for_approval | approved). Read the record before acting on it.`
      );
  }
}

const costLine = z.object({
  date: isoDate.describe("Date the cost occurred, yyyy-MM-dd. Required."),
  description: z
    .string()
    .max(255, "The API caps a cost description at 255 characters.")
    .optional()
    .describe("What the cost was."),
  amount: z.number().optional().describe("Amount in the tenant's currency."),
  currencyAmount: z.number().optional().describe("Original amount, when the receipt is in another currency."),
  currency: z
    .string()
    .length(3, "An ISO currency code is exactly 3 characters, e.g. EUR.")
    .optional()
    .describe("Currency of currencyAmount, e.g. EUR."),
  category: z
    .enum(EXPENSE_CATEGORIES)
    .optional()
    .describe(
      "Cost category, which drives the account it maps to. OPTIONAL here and REQUIRED to deliver " +
        'the expense — measured, delivering without one answers 400 "Kategori må velges for ' +
        'kostnadsrad." naming no row, so set it now rather than debugging it later.',
    ),
  vatCode: z
    .string()
    .max(10, "The API caps vatCode at 10 characters.")
    .optional()
    .describe(
      "VAT code for the line, from reai_list_vat_codes. Booking this expense posts with it, so the " +
        "same caveat applies as anywhere else in this server: the unfiltered list returns EVERY " +
        "code ReAI supports rather than the ones THIS tenant may use — it shows 25% codes for a " +
        "company that is not VAT-registered — and booking one the tenant cannot use invents VAT " +
        "that does not exist.",
    ),
});

/**
 * The update variants, which differ from the create ones by ONE field that matters.
 *
 * `UpdateExpenseCostReq.id` is documented as "Id of an existing cost line on this expense. Omit to
 * add a new cost line." Since the arrays are complete lists, a row sent WITHOUT its id is not a
 * retained row — it is a new one, and the old is deleted. So a caller keeping two rows and editing
 * a third would silently replace all three with fresh records. Same shape as the employment-line
 * ids in organisation.ts, and the same fix: carry the id.
 */
const updateLineId = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    "The id of an existing row on this expense, to KEEP it. Omit to add a new row — and since this " +
      "array is the complete list, omitting the id of a row you meant to keep deletes it and " +
      "recreates it with a new one.",
  );

const perDiemLine = z.object({
  dateFrom: isoDate.describe("First day of the trip, yyyy-MM-dd."),
  tripType: z.enum(TRIP_TYPES).describe("with_overnight_stay needs dateTo; the day-trip rates do not."),
  dateTo: isoDate.optional().describe("Last day. Required for an overnight stay, ignored for a day trip."),
  countryCode: z
    .string()
    .length(2, "An ISO country code is exactly 2 characters, e.g. NO.")
    .optional()
    .describe("Country visited, for the applicable rate."),
  address: z.string().optional().describe("Where the trip went, free-form."),
  breakfastDeducted: z.boolean().optional().describe("Breakfast was provided, so deduct it."),
  lunchDeducted: z.boolean().optional().describe("Lunch was provided, so deduct it."),
  dinnerDeducted: z.boolean().optional().describe("Dinner was provided, so deduct it."),
  amount: z.number().optional().describe("Override the calculated amount. Omit to let the API compute it."),
});

const mileageLine = z.object({
  date: isoDate.describe("Date of the journey, yyyy-MM-dd."),
  kilometers: z.number().optional().describe("Distance driven."),
  purpose: z
    .string()
    .max(255, "The API caps a mileage purpose at 255 characters.")
    .optional()
    .describe("Business purpose of the journey."),
  companyCar: z.boolean().optional().describe("A company car pays no allowance to the employee."),
  kilometerRateOverride: z.number().optional().describe("Replace the default rate per kilometre."),
});

const updateCostLine = costLine.extend({ id: updateLineId });
const updatePerDiemLine = perDiemLine.extend({ id: updateLineId });
const updateMileageLine = mileageLine.extend({ id: updateLineId });

const getExpense = defineTool({
  name: "reai_get_expense",
  title: "Get one expense claim",
  description:
    "One expense claim in full: its status, total, cost rows, per-diems and mileage, and whether " +
    "it has been booked to a voucher.\n\n" +
    "Two things this tool establishes that the response alone cannot. A booked expense still reads " +
    'status "approved" — voucherId is the only thing that says it is in the ledger. And a REVERSED ' +
    "expense also keeps its old status: the API drops it from the list but returns it unchanged " +
    "here, and `?status=reversed` is rejected outright, so there is no way to ask. This tool " +
    "checks whether the expense still appears in the filtered list and tells you, because acting " +
    "on a reversed claim as though it were live is the mistake worth preventing.",
  risk: "read",
  apiPaths: [
    ["GET", "/api/expenses/{id}"],
    ["GET", "/api/expenses"],
  ],
  inputSchema: {
    id: z.number().int().positive().describe("Expense id, from reai_list_expenses."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const res = await ctx.client.request<ExpenseRecord>({
      method: "GET",
      path: `/api/expenses/${args.id}`,
      tenantId,
    });
    const expense = res.data ?? {};
    const notes = [describeExpense(expense)];

    // The reversal check. Narrowed by the expense's OWN status and employee so the list stays
    // small: a reversed expense is absent from every filtered view, because the filter cannot
    // express "reversed" at all. Only attempted when the status is one the filter accepts —
    // sending a status the API rejects would 400 and prove nothing.
    //
    // And the DATES have to be sent explicitly, which the first version of this missed. The list
    // defaults startDate to 1 January of the CURRENT YEAR and endDate to TODAY, both documented, so
    // a claim from last year or one dated tomorrow is absent from the default window — and absence
    // is exactly what this check reads as "reversed". A live historical claim would have been
    // reported as withdrawn, which is worse than not checking at all. Found in review.
    //
    // The window is taken from the expense's own dates and only widened, never narrowed. If no date
    // can be established the check is ABANDONED rather than run on a window that might exclude the
    // expense for an innocent reason.
    const window = expenseWindow(expense);
    if (
      typeof expense.status === "string" &&
      ["open", "for_approval", "approved"].includes(expense.status) &&
      window !== undefined
    ) {
      let live: number[] | undefined;
      try {
        const listed = await ctx.client.request<Array<{ id?: number }>>({
          method: "GET",
          path: "/api/expenses",
          query: {
            status: expense.status,
            startDate: window.startDate,
            endDate: window.endDate,
            ...(expense.employeeId != null ? { employeeIds: String(expense.employeeId) } : {}),
          },
          tenantId,
        });
        live = Array.isArray(listed.data)
          ? listed.data.map((row) => row.id).filter((id): id is number => typeof id === "number")
          : undefined;
      } catch {
        live = undefined;
      }
      notes.push(
        live === undefined
          ? `Whether this expense has been REVERSED could not be established — the list call that ` +
            `answers it failed. Its status field cannot tell you: a reversed expense keeps the ` +
            `status it had. Treat that as unknown rather than as live.`
          : live.includes(args.id)
            ? `Not reversed: it still appears among this tenant's ${expense.status} expenses.`
            : `THIS EXPENSE HAS BEEN REVERSED. It is absent from the list of ${expense.status} ` +
              `expenses while still reading ${JSON.stringify(expense.status)} here, which is how the ` +
              `API represents a reversal — DELETE answers {"outcome":"reversed"} and changes no ` +
              `field a caller can see. It cannot be delivered, approved or booked; a transition ` +
              `would answer 409 "is reversed and can no longer be delivered".`,
      );
    }
    else if (typeof expense.status === "string" && ["open", "for_approval", "approved"].includes(expense.status)) {
      notes.push(
        `Whether this expense has been REVERSED was not checked: the list call that answers it is ` +
          `date-filtered, and no date could be read from this record to scope it with. Running it ` +
          `on the API's default window — 1 January of the current year to today — would report a ` +
          `claim from outside that window as reversed, which is worse than not checking. Its status ` +
          `field cannot tell you either; a reversed expense keeps the status it had.`,
      );
    }
    if (expense.includedInPayslip === true) {
      notes.push(
        `includedInPayslip is true, so this has been picked up by a payroll run — its cost is on a ` +
          `payslip and paid with salary. Changing it now means changing what someone was paid.`,
      );
    }
    return ok(expense, { note: notes.join("\n\n") });
  },
});

const createExpense = defineTool({
  name: "reai_create_expense",
  title: "Create an expense claim",
  description:
    "Start an expense claim for an employee — receipted costs, and on a travel claim also " +
    "per-diems and mileage. It arrives as status open and posts NOTHING: measured, the voucher " +
    "count did not move.\n\n" +
    "Only title and travel are required, but an expense that cannot be delivered is not much use, " +
    "so supply the rest: delivering runs the API's completion validation and needs an employee, a " +
    "payable amount, and a CATEGORY on every cost row. The category is optional here and required " +
    'there — measured, 400 "Kategori må velges for kostnadsrad." — and the message names no row.\n\n' +
    "perDiems and mileageAllowances are only allowed when travel is true; the API rejects them on " +
    "a non-travel claim.",
  risk: "irreversible",
  apiPaths: [["POST", "/api/expenses"]],
  inputSchema: {
    title: z
      .string()
      .min(1)
      .max(255, "The API caps title at 255 characters.")
      .describe("Title shown on the expense row."),
    travel: z
      .boolean()
      .describe(
        "True for a travel claim (reiseregning), which is what allows per-diems and mileage. " +
          "False for an ordinary expense (utlegg).",
      ),
    employeeId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Who is claiming. Optional until delivery, and required to deliver — set it now unless you " +
          "genuinely do not know yet.",
      ),
    purpose: z
      .string()
      .max(255, "The API caps purpose at 255 characters.")
      .optional()
      .describe("Business reason for the expense."),
    projectId: z.number().int().positive().optional().describe("Project to book it against."),
    costs: z.array(costLine).optional().describe("Receipted cost rows."),
    perDiems: z.array(perDiemLine).optional().describe("Per-diem rows. Travel claims only."),
    mileageAllowances: z.array(mileageLine).optional().describe("Mileage rows. Travel claims only."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...body } = args;
    // Refused locally because the API's own message for this is about the row rather than the
    // combination, and the fix is to flip `travel` or drop the rows — worth saying before sending.
    if (args.travel === false) {
      const offending = [
        ...(args.perDiems?.length ? ["perDiems"] : []),
        ...(args.mileageAllowances?.length ? ["mileageAllowances"] : []),
      ];
      if (offending.length > 0) {
        return fail(
          `${offending.join(" and ")} are only allowed on a TRAVEL claim, and travel is false. ` +
            `Nothing was sent. Set travel: true if this is a reiseregning, or move those amounts ` +
            `into costs as receipted rows.`,
        );
      }
    }
    const resolved = requireTenantId(tenantId, ctx);
    const res = await ctx.client.request<ExpenseRecord>({
      method: "POST",
      path: "/api/expenses",
      body,
      tenantId: resolved,
    });
    const expense = res.data ?? {};
    const missingCategory = (expense.costs ?? []).filter((row) => row.category == null).length;
    const notes = [
      `Expense ${expense.id ?? "?"} created: ${String(expense.title ?? args.title)}, total ` +
        `${expense.totalAmount ?? "?"}. Nothing is posted — a draft expense has no voucher.`,
    ];
    if (missingCategory > 0) {
      notes.push(
        `${missingCategory} cost row(s) have no category, so DELIVERING THIS WILL FAIL with ` +
          `400 "Kategori må velges for kostnadsrad." — and that message does not say which row. ` +
          `Set them with reai_update_expense before delivering.`,
      );
    }
    if (args.employeeId === undefined) {
      notes.push(
        `No employeeId, so this cannot be delivered yet: the API's completion validation rejects an ` +
          `expense with no employee. Set one with reai_update_expense.`,
      );
    }
    return ok(expense, { note: notes.join("\n\n") });
  },
});

const updateExpense = defineTool({
  name: "reai_update_expense",
  title: "Update an expense claim",
  description:
    "Change an expense that is still open. Scalars patch — omitting title or purpose leaves them " +
    "alone — and purpose, employeeId and projectId are cleared by passing null.\n\n" +
    "Keep a row by sending its `id`. A row without one is a NEW row, so an id left off a row you " +
    "meant to keep deletes the original and recreates it — read the expense first and carry the " +
    "ids across.\n\n" +
    "THE LINE ARRAYS ARE DIFFERENT: costs, perDiems and mileageAllowances are each the COMPLETE " +
    "list. Measured, an expense with two cost rows updated with one came back with one and its " +
    "total fell from 300 to 100 — the other row is gone. Omitting an array preserves it (also " +
    "measured, a title-only update left the rows untouched), so pass one only when you mean to " +
    "replace the whole set, and include the rows you are keeping.\n\n" +
    "Only an OPEN expense can be changed. Once delivered, approved, booked or reversed the API " +
    'answers 409 — "er bokført på bilag og kan ikke lenger endres" for a booked one. To edit a ' +
    "booked expense: delete its voucher, unapprove it, and it is open again.",
  risk: "irreversible",
  apiPaths: [["PATCH", "/api/expenses/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Expense id."),
    title: z
      .string()
      .min(1)
      .max(255, "The API caps title at 255 characters.")
      .optional()
      .describe("New title. Omit to keep the current one."),
    purpose: z
      .string()
      .max(255, "The API caps purpose at 255 characters.")
      .nullable()
      .optional()
      .describe("Business reason; null clears it."),
    employeeId: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe("Who is claiming; null detaches them, which also makes the expense undeliverable."),
    projectId: z.number().int().positive().nullable().optional().describe("Project; null clears it."),
    costs: z
      .array(updateCostLine)
      .optional()
      .describe(
        "The COMPLETE list of cost rows. Sending fewer rows deletes the others, and a row sent " +
          "without its `id` is treated as a NEW row rather than a kept one.",
      ),
    perDiems: z
      .array(updatePerDiemLine)
      .optional()
      .describe("The COMPLETE list of per-diem rows, each with its `id` to keep it. Travel only."),
    mileageAllowances: z
      .array(updateMileageLine)
      .optional()
      .describe("The COMPLETE list of mileage rows, each with its `id` to keep it. Travel only."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, id, ...body } = args;
    if (Object.values(body).every((value) => value === undefined)) {
      return fail(`No fields were given, so there is nothing to change on expense ${id}.`);
    }
    const res = await ctx.client.request<ExpenseRecord>({
      method: "PATCH",
      path: `/api/expenses/${id}`,
      body,
      tenantId: requireTenantId(tenantId, ctx),
    });
    const expense = res.data ?? {};
    const replaced = (["costs", "perDiems", "mileageAllowances"] as const).filter(
      (key) => args[key] !== undefined,
    );
    const notes = [
      `Expense ${id} updated. Total is now ${expense.totalAmount ?? "?"}. ${describeExpense(expense)}`,
    ];
    if (replaced.length > 0) {
      notes.push(
        `${replaced.join(", ")} was sent, so that list was REPLACED rather than added to — the ` +
          `expense now has ${expense.costs?.length ?? "?"} cost row(s), ` +
          `${expense.perDiems?.length ?? 0} per-diem row(s) and ` +
          `${expense.mileageAllowances?.length ?? 0} mileage row(s). If a row you meant to keep is ` +
          `missing, send the whole set again.`,
      );
    }
    const missingCategory = (expense.costs ?? []).filter((row) => row.category == null).length;
    if (missingCategory > 0) {
      notes.push(
        `${missingCategory} cost row(s) still have no category, so delivering will fail with ` +
          `400 "Kategori må velges for kostnadsrad.".`,
      );
    }
    return ok(expense, { note: notes.join("\n\n") });
  },
});

const deliverExpense = defineTool({
  name: "reai_deliver_expense",
  title: "Deliver an expense for approval",
  description:
    "Submit an open expense for approval: status open becomes for_approval. This runs the API's " +
    "completion validation, which is where an incomplete claim is caught — it needs an employee, a " +
    "payable amount, and a category on every cost row.\n\n" +
    "There is no un-deliver. An approved expense can be unapproved back to for_approval, but " +
    "nothing returns it to open, so the way out of a delivered expense is to reverse it and start " +
    "again. Nothing is posted at this step.",
  risk: "irreversible",
  apiPaths: [["POST", "/api/expenses/{id}/deliver"]],
  inputSchema: {
    id: z.number().int().positive().describe("Expense id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<ExpenseRecord>({
      method: "POST",
      path: `/api/expenses/${args.id}/deliver`,
      body: {},
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data ?? { delivered: args.id }, {
      note:
        `Expense ${args.id} delivered for approval. ${describeExpense(res.data ?? {})}\n\n` +
        `Nothing is posted yet, and there is no un-deliver — only reversing the whole expense.`,
    });
  },
});

const approveExpense = defineTool({
  name: "reai_approve_expense",
  title: "Approve an expense",
  description:
    "Approve an expense that is waiting for approval, so it can be booked and paid out with " +
    "salary. It must have status for_approval; the same completion validation runs again.\n\n" +
    "Approving posts nothing by itself — the voucher is a separate call. Note that call does not " +
    "need this one: booking an expense that is still for_approval approves it as part of the same " +
    "operation, measured.",
  risk: "irreversible",
  apiPaths: [["POST", "/api/expenses/{id}/approve"]],
  inputSchema: {
    id: z.number().int().positive().describe("Expense id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<ExpenseRecord>({
      method: "POST",
      path: `/api/expenses/${args.id}/approve`,
      body: {},
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data ?? { approved: args.id }, {
      note:
        `Expense ${args.id} approved. ${describeExpense(res.data ?? {})}\n\n` +
        `Nothing is in the ledger until reai_book_expense_voucher runs.`,
    });
  },
});

const unapproveExpense = defineTool({
  name: "reai_unapprove_expense",
  title: "Unapprove an expense",
  description:
    "Send an approved expense back to for_approval so it can be corrected. It must have status " +
    "approved and must NOT have a voucher: measured, the API answers " +
    '409 "Utlegget/reiseregningen har allerede et bilag og kan ikke lenger avvises" once one ' +
    "exists. This tool reads the expense first and says that plainly, naming the voucher to delete.",
  risk: "irreversible",
  apiPaths: [
    ["GET", "/api/expenses/{id}"],
    ["POST", "/api/expenses/{id}/unapprove"],
  ],
  inputSchema: {
    id: z.number().int().positive().describe("Expense id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const current = await ctx.client.request<ExpenseRecord>({
      method: "GET",
      path: `/api/expenses/${args.id}`,
      tenantId,
    });
    const voucherId = current.data?.voucherId;
    if (voucherId != null) {
      return fail(
        `Expense ${args.id} is booked to voucher ${voucherId}` +
          `${current.data?.voucherNumber ? ` (${current.data.voucherNumber})` : ""}, so it cannot be ` +
          `unapproved — the API refuses that outright. Nothing was sent.\n\n` +
          `Delete the voucher first with reai_delete_expense_voucher, which unlinks it and leaves ` +
          `the expense bookable again, then unapprove.`,
      );
    }
    const res = await ctx.client.request<ExpenseRecord>({
      method: "POST",
      path: `/api/expenses/${args.id}/unapprove`,
      body: {},
      tenantId,
    });
    return ok(res.data ?? { unapproved: args.id }, {
      note:
        `Expense ${args.id} is back to for_approval. ${describeExpense(res.data ?? {})}\n\n` +
        `Nothing returns it to open, so its cost rows still cannot be edited — reai_update_expense ` +
        `only accepts an open expense.`,
    });
  },
});

const bookExpenseVoucher = defineTool({
  name: "reai_book_expense_voucher",
  title: "Book the expense voucher",
  description:
    "POST THE EXPENSE TO THE LEDGER. This creates the accounting voucher for the expense, using " +
    "the same booking rules as the web application. Measured: the voucher count went up by one and " +
    'the response came back as {expenseId, voucherId, voucherNumber: "EX1-2026", voucherDate} — ' +
    "expenses have their own number series.\n\n" +
    "It also APPROVES an expense that is still for_approval, as part of the same call, so this can " +
    "skip reai_approve_expense entirely. Worth knowing before reaching for it to 'check' anything.\n\n" +
    "The voucher can be unlinked afterwards with reai_delete_expense_voucher, which answers " +
    '"deleted" while no accounting history need be kept and "reversed" once it must — and a ' +
    "reversal posts. The expense survives either way and can be booked again.",
  risk: "irreversible",
  apiPaths: [["POST", "/api/expenses/{id}/voucher"]],
  inputSchema: {
    id: z.number().int().positive().describe("Expense id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<{
      expenseId?: number;
      voucherId?: number;
      voucherNumber?: string;
      voucherDate?: string;
    }>({
      method: "POST",
      path: `/api/expenses/${args.id}/voucher`,
      body: {},
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const booked = res.data ?? {};
    return ok(booked, {
      note:
        booked.voucherId != null
          ? `Expense ${args.id} is posted: voucher ${booked.voucherId}` +
            `${booked.voucherNumber ? ` (${booked.voucherNumber})` : ""} dated ` +
            `${booked.voucherDate ?? "?"}. This is in the ledger now.\n\n` +
            `The expense still reads status "approved" — that field never says "booked", so ` +
            `voucherId is what tells you. It can no longer be edited until the voucher is deleted.`
          : `Expense ${args.id}: the call answered HTTP ${res.status} but no voucherId came back, ` +
            `so whether anything was posted is unknown. Read it with reai_get_expense and check ` +
            `voucherId before booking again — a second call would post a second voucher.`,
    });
  },
});

const deleteExpenseVoucher = defineTool({
  name: "reai_delete_expense_voucher",
  title: "Delete the expense voucher",
  description:
    "Unlink the accounting voucher from an expense, which is what makes a booked expense editable " +
    'again. Like the salary-run delete, this endpoint is "delete OR reverse": it deletes when no ' +
    "accounting reversal is needed and RECORDS A REVERSAL when audit history must be kept, " +
    'answering {"outcome":"deleted"} or {"outcome":"reversed"}. A reversal posts to the ledger.\n\n' +
    "So this tool reads the outcome rather than reporting success from a 200. Measured on a " +
    'freshly booked voucher: {"outcome":"deleted"}, and the ledger count went back down.\n\n' +
    "The expense itself is kept and can be booked again.",
  risk: "irreversible",
  destructive: true,
  apiPaths: [["DELETE", "/api/expenses/{id}/voucher"]],
  inputSchema: {
    id: z.number().int().positive().describe("Expense id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<{ outcome?: string }>({
      method: "DELETE",
      path: `/api/expenses/${args.id}/voucher`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const outcome = res.data?.outcome;
    return ok(res.data ?? { expenseId: args.id }, {
      note:
        outcome === "deleted"
          ? `The voucher on expense ${args.id} was DELETED outright — nothing remains in the ` +
            `ledger for it. The expense is kept and can be booked again.`
          : outcome === "reversed"
            ? `The voucher on expense ${args.id} was REVERSED, not deleted: the API records a ` +
              `reversal once accounting history has to be kept, and a reversal POSTS to the ledger. ` +
              `Two entries now exist for this expense — the original and its reversal — and no ` +
              `amount of deleting will remove them. Read the ledger before booking it again.`
            : `The voucher on expense ${args.id}: DELETE answered HTTP ${res.status} with no ` +
              `recognised outcome (${JSON.stringify(outcome)}). This endpoint deletes OR reverses ` +
              `and says which, so with neither word present, whether anything was posted is ` +
              `unknown — read the expense and the ledger rather than assuming it was clean.`,
    });
  },
});

const reverseExpense = defineTool({
  name: "reai_reverse_expense",
  title: "Reverse an expense claim",
  description:
    "Withdraw an expense claim. The API does not delete it: the response is " +
    '{"outcome":"reversed"} and the record stays.\n\n' +
    "What makes this worth care is how invisible it is. Measured: a reversed expense DISAPPEARS " +
    "from reai_list_expenses, while reai_get_expense still returns it with the status it had " +
    "before — open, for_approval or approved. No field changes. `?status=reversed` is rejected " +
    "with a 400, so the API cannot even be asked. The only positive signal is that a transition " +
    'fails: 409 "is reversed and can no longer be delivered".\n\n' +
    "reai_get_expense compensates by checking list membership. Nothing else does, so a reversed " +
    "expense read through reai_request looks live.\n\n" +
    "It DOES take the voucher with it, which an earlier version of this description got wrong. " +
    "Measured: an expense booked to voucher 30808 was reversed, the day's voucher count went from 1 " +
    "back to 0, and DELETE /api/vouchers/30808 then answered 404 \"Bilag ikke funnet\" — the voucher " +
    "is gone, not stranded. So reversing a booked expense unposts it, and there is no need to " +
    "unlink the voucher first. Afterwards reai_delete_expense_voucher answers " +
    '409 "Kan ikke slette bilag fra et slettet utlegg/reiseregning." because there is no longer an ' +
    "expense to unlink it from.",
  risk: "irreversible",
  destructive: true,
  apiPaths: [["DELETE", "/api/expenses/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Expense id."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<{ outcome?: string }>({
      method: "DELETE",
      path: `/api/expenses/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const outcome = res.data?.outcome;
    return ok(res.data ?? { expenseId: args.id }, {
      note:
        outcome === "reversed"
          ? `Expense ${args.id} is reversed.\n\nIt will no longer appear in reai_list_expenses, but ` +
            `reai_get_expense will still return it with its old status — that is how this API ` +
            `represents a reversal, and it is why reading one through reai_request makes it look live.`
          : // The sentences above describe what a REVERSAL does, and were being appended to every
            // outcome. On an unexpected one they would assert that a record vanished from the list
            // and survives by id, neither of which is established — it might still be live, or
            // actually gone. Left unknown instead.
            `Expense ${args.id}: DELETE answered HTTP ${res.status} with outcome ` +
            `${JSON.stringify(outcome)} rather than "reversed". This endpoint is documented to ` +
            `reverse rather than delete, so what happened is NOT established: whether the expense ` +
            `is still live, reversed, or gone. Read it back with reai_get_expense before doing ` +
            `anything else, and do not assume it is still there.`,
    });
  },
});

export const expenseTools: ToolDef[] = [
  getExpense,
  createExpense,
  updateExpense,
  deliverExpense,
  approveExpense,
  unapproveExpense,
  bookExpenseVoucher,
  deleteExpenseVoucher,
  reverseExpense,
];
