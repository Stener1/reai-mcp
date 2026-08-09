import { z } from "zod";
import {
  asScalar,
  confirmAgainstResponse,
  defineTool,
  describeConfirmation,
  describeShape,
  isRecord,
  ok,
  okList,
  requireTenantId,
  tenantIdArg,
  type ToolDef,
} from "./registry.js";

/**
 * General sub-accounts (underkonti) — the partition inside a ledger account.
 *
 * A sub-account splits one chart-of-accounts number into named parts: on a live tenant, account
 * 1579 carries both "Default" and "Shopify sales". Postings, reconciliation rules and the chart of
 * accounts all reference them by `subAccountId`.
 *
 * This existed as a field before it existed as a tool, which is the reason for the file. Both
 * `reai_create_voucher` and `reai_create_reconciliation_rule` already accepted `subAccountId`,
 * described as "Optional general sub-account id" — with no way to discover a valid value and no
 * statement of what omitting it does. Measured, the description was also wrong:
 *
 *   POST /api/vouchers  → 400 "Linje 1: Konto 1320 må posteres med underkonto."
 *
 * An account that HAS sub-accounts requires one on every posting, even when it has exactly one, so
 * the field is conditionally mandatory rather than optional. The refusal is a bare Norwegian 400
 * naming the line, which a caller with no way to list sub-accounts cannot act on.
 *
 * Two more measured facts. The selector endpoint returns a `selectableAccountNumber` of the form
 * "1300/6229" — account/sub-account — which is how the UI names the pair. And there is NO DELETE:
 * a sub-account, once created, is permanent, and `PUT` accepts only `name` (sending accountNumber
 * answers 400 "Unknown field: accountNumber"), so it cannot be moved to another account either.
 */

type SubAccount = {
  id?: number;
  accountNumber?: string;
  name?: string;
  selectableAccountNumber?: string;
};

const listSubAccounts = defineTool({
  name: "reai_list_sub_accounts",
  title: "List general sub-accounts",
  description:
    "Every general sub-account (underkonto) on this tenant, with the ledger account each belongs " +
    "to. A sub-account splits one account into named parts — account 1579 might carry both " +
    "\"Default\" and \"Shopify sales\" — and this is where the `subAccountId` that " +
    "reai_create_voucher and reai_create_reconciliation_rule take comes from.\n\n" +
    "Worth reading before posting to any balance-sheet account: an account that HAS sub-accounts " +
    "REQUIRES one on every posting, even if it has only the single \"Default\". Measured, omitting " +
    'it answers 400 "Linje 1: Konto 1320 må posteres med underkonto." naming the line and nothing ' +
    "else. reai_create_voucher checks this before sending and names the choices.",
  risk: "read",
  apiPaths: [["GET", "/api/general-sub-accounts"]],
  inputSchema: { tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<SubAccount[]>({
      method: "GET",
      path: "/api/general-sub-accounts",
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const rows = Array.isArray(res.data) ? res.data : undefined;
    const accounts = new Set(rows?.map((s) => s.accountNumber));
    return okList(res.data, {
      noun: "general sub-account",
      suffix: rows
        ? ` across ${accounts.size} ledger account(s). Every one of those accounts requires a ` +
          `subAccountId on each posting to it.`
        : ".",
      empty:
        "No general sub-accounts are defined, so no account requires a subAccountId on its " +
        "postings. That is a statement about this tenant, not about the API.",
    });
  },
});

const subAccountsForAccount = defineTool({
  name: "reai_sub_accounts_for_account",
  title: "Sub-accounts for one ledger account",
  description:
    "The sub-accounts available on a single ledger account — the choices for a posting to it. " +
    "Returns the API's `selectableAccountNumber` too, which is the \"1300/6229\" account/sub-account " +
    "form the ReAI interface uses.\n\n" +
    "A non-empty result means postings to that account REQUIRE one of these ids. An empty one means " +
    "they do not.\n\n" +
    "And a 400 is a third answer, not an error to route around: measured, account 3000 replies " +
    '400 "accountNumber 3000 does not support general sub-accounts" — some accounts cannot have them ' +
    "at all, which is also a clear no.",
  risk: "read",
  apiPaths: [["GET", "/api/general-sub-accounts/accounts/{accountNumber}"]],
  inputSchema: {
    accountNumber: z
      .string()
      .min(1)
      .describe('Chart-of-accounts number, e.g. "1300". From reai_list_accounts.'),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    let res;
    try {
      res = await ctx.client.request<SubAccount[]>({
        method: "GET",
        path: `/api/general-sub-accounts/accounts/${encodeURIComponent(args.accountNumber)}`,
        tenantId: requireTenantId(args.tenantId, ctx),
      });
    } catch (err) {
      // The documented third outcome, delivered as an ANSWER rather than a failure. An account that
      // cannot have sub-accounts replies 400 "accountNumber 3000 does not support general
      // sub-accounts", and letting that surface as an error result contradicted this tool's own
      // description and invited a caller to retry a normal capability check.
      const message = err instanceof Error ? err.message : String(err);
      if (/does not support general sub-accounts/i.test(message)) {
        return ok(
          { accountNumber: args.accountNumber, supportsSubAccounts: false, subAccounts: [] },
          {
            note:
              `Account ${args.accountNumber} does not support general sub-accounts at all — the API ` +
              `says so with a 400, which is a clear NO rather than a problem. Postings to it need no ` +
              `subAccountId.`,
          },
        );
      }
      throw err;
    }
    const rows = Array.isArray(res.data) ? res.data : undefined;
    return okList(res.data, {
      noun: "sub-account",
      suffix: rows?.length
        ? ` on account ${args.accountNumber}, so a posting to it MUST carry one of these ` +
          `subAccountId values: ${rows.map((s) => `${s.id} (${s.name ?? "?"})`).join(", ")}.`
        : ".",
      empty:
        `Account ${args.accountNumber} has no sub-accounts, so its postings need no subAccountId.`,
    });
  },
});

const createSubAccount = defineTool({
  name: "reai_create_sub_account",
  title: "Create a general sub-account",
  description:
    "Add a named sub-account to a ledger account — a way to split one account into parts that are " +
    "reported separately.\n\n" +
    "THIS CANNOT BE UNDONE. There is no DELETE on this resource: measured, " +
    "DELETE /api/general-sub-accounts/{id} answers 405, so a sub-account created by mistake is " +
    "permanent. `PUT` accepts only `name`, so it cannot be moved to a different account either.\n\n" +
    "And it changes how the account behaves: once an account has ANY sub-account, every posting to " +
    "it must name one. Adding the first sub-account to an account therefore breaks any routine that " +
    "posts to it without a subAccountId — measured, those postings answer " +
    '400 "må posteres med underkonto".',
  risk: "irreversible",
  apiPaths: [
    ["GET", "/api/general-sub-accounts/accounts/{accountNumber}"],
    ["POST", "/api/general-sub-accounts"],
  ],
  inputSchema: {
    accountNumber: z
      .string()
      .min(1)
      .max(10, "The API caps accountNumber at 10 characters.")
      .describe('Ledger account to split, e.g. "1579". Cannot be changed afterwards.'),
    name: z
      .string()
      .min(1)
      .max(150, "The API caps a sub-account name at 150 characters.")
      .describe('Name of the part, e.g. "Shopify sales".'),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const { tenantId, ...body } = args;
    const resolved = requireTenantId(tenantId, ctx);
    // Read first, so the note can say whether this is the FIRST sub-account on the account — which
    // is the case that changes the account's posting rules for everyone.
    // Informational only, so a failure here must not stop the create. The `existing === undefined`
    // branch below was written for an unreadable response and was unreachable for a THROWN one —
    // the same care the voucher preflight takes, missing two hundred lines away in the same change.
    let existing: number | undefined;
    try {
      const before = await ctx.client.request<SubAccount[]>({
        method: "GET",
        path: `/api/general-sub-accounts/accounts/${encodeURIComponent(args.accountNumber)}`,
        tenantId: resolved,
      });
      existing = Array.isArray(before.data) ? before.data.length : undefined;
    } catch {
      existing = undefined;
    }
    const res = await ctx.client.request<SubAccount>({
      method: "POST",
      path: "/api/general-sub-accounts",
      body,
      tenantId: resolved,
    });
    // The stored name, not `args.name`. Widening the census caught this one ten lines from the rename it was
    // fixed alongside: the same GeneralSubAccountRes carries `name`, and this tool is declared IRREVERSIBLE
    // with no DELETE, so the name it reports is the name that is permanent.
    const createdRecord = isRecord(res.data) ? res.data : undefined;
    const storedName = asScalar(createdRecord?.name);
    return ok(res.data, {
      note:
        `Sub-account ${createdRecord?.id ?? "?"} ${
          storedName === undefined
            ? `"${args.name}" (as SENT — ${
                createdRecord === undefined
                  ? `the response came back as ${describeShape(res.data)}`
                  : createdRecord.name === null || createdRecord.name === undefined
                    ? `the response carries name: ${JSON.stringify(createdRecord.name ?? null)}`
                    : `the response carries name as ${describeShape(createdRecord.name)}`
              })`
            : JSON.stringify(storedName)
        } created on account ${args.accountNumber}. ` +
        `There is no DELETE for this resource, so it is permanent.` +
        describeConfirmation(
          confirmAgainstResponse({ name: args.name }, res.data, { wholeRecord: true }),
          `sub-account ${createdRecord?.id ?? "?"}`,
        )
          .map((n) => `\n\n${n}`)
          .join("") +
        (existing === 0
          ? `\n\nThis is the FIRST sub-account on ${args.accountNumber}, which changes the rules for ` +
            `that account: every posting to it must now name a subAccountId, and anything that ` +
            `posted to it without one will start failing with 400 "må posteres med underkonto".`
          : existing === undefined
            ? `\n\nWhether the account already had sub-accounts could not be read, so whether this ` +
              `changed its posting rules is unknown — check with reai_sub_accounts_for_account.`
            : `\n\nThe account already had ${existing}, so its postings already required a ` +
              `subAccountId and nothing about that changed.`),
    });
  },
});

const renameSubAccount = defineTool({
  name: "reai_rename_sub_account",
  title: "Rename a general sub-account",
  description:
    "Change a sub-account's name. That is all this endpoint accepts: sending accountNumber answers " +
    '400 "Unknown field: accountNumber" — measured — so a sub-account cannot be moved to another ' +
    "ledger account, and there is no DELETE to remove it either.",
  risk: "reversible",
  apiPaths: [["PUT", "/api/general-sub-accounts/{id}"]],
  idempotent: true,
  inputSchema: {
    id: z.number().int().positive().describe("Sub-account id, from reai_list_sub_accounts."),
    name: z
      .string()
      .min(1)
      .max(150, "The API caps a sub-account name at 150 characters.")
      .describe("New name."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<SubAccount>({
      method: "PUT",
      path: `/api/general-sub-accounts/${args.id}`,
      body: { name: args.name },
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    // From the RESPONSE, not from `args`. A rename is the case where quoting the request back is least
    // defensible: `reai_create_customer` already documents this API storing a name title-cased, so the
    // stored name is the one thing here a caller cannot assume. `GeneralSubAccountRes` carries `name`, so
    // there is nothing to infer — the previous version simply did not look.
    // A USABLE value, not merely a present one: `!== undefined` reported "is now named null, read back from
    // the response", stating a value this API is documented as substituting. An unreadable shape is a third
    // case, distinct from a missing field.
    const record = isRecord(res.data) ? res.data : undefined;
    const stored = asScalar(record?.name);
    const confirmation = confirmAgainstResponse({ name: args.name }, res.data, { wholeRecord: true });
    return ok(res.data, {
      note: [
        (stored === undefined
          ? `Sub-account ${args.id} was sent the name "${args.name}", and ` +
            (record === undefined
              ? `the response is not a record (it came back as ${describeShape(res.data)})`
              : record.name === null || record.name === undefined
                ? `the response carries name: ${JSON.stringify(record.name ?? null)}`
                : `the response carries name as ${describeShape(record.name)}, which is not a value this ` +
                  `can state`) +
            ` — so that is what was SENT rather than what is stored.`
          : `Sub-account ${args.id} is now named ${JSON.stringify(stored)}, read back from the response.`) +
          ` Only the name changed — the ledger account it belongs to cannot be changed through this endpoint.`,
        ...describeConfirmation(confirmation, `sub-account ${args.id}`),
      ].join("\n\n"),
    });
  },
});

export const subAccountTools: ToolDef[] = [
  listSubAccounts,
  subAccountsForAccount,
  createSubAccount,
  renameSubAccount,
];
