import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReaiClient } from "./reai/client.js";
import { ReaiApiError, ReaiConfigError, ReaiTransportError } from "./reai/errors.js";
import { assertTransmitAllowed, curatedArgsEscalate, escalatingFieldNames, isAllowed, WriteBlockedError } from "./policy.js";
import type { ServerConfig } from "./config.js";
import { getSpecIndex } from "./reai/spec.js";
import type { SessionState, ToolContext, ToolDef, ToolResult } from "./tools/registry.js";
import { metaTools } from "./tools/meta.js";
import { uiTools } from "./tools/ui.js";
import {
  RECONCILE_TEMPLATE_MIME,
  RECONCILE_TEMPLATE_URI,
  renderTemplate,
} from "./ui/reconciliation.js";
import { discoveryTools } from "./tools/discovery.js";
import { bookkeepingTools } from "./tools/bookkeeping.js";
import { salesTools } from "./tools/sales.js";
import { purchaseTools } from "./tools/purchase.js";
import { bankVatTools } from "./tools/bankvat.js";
import { organisationTools } from "./tools/organisation.js";
import { assetTools } from "./tools/assets.js";
import { subscriptionTools } from "./tools/subscriptions.js";
import { warehouseTools } from "./tools/warehouses.js";
import { agreementTools } from "./tools/agreements.js";

export const SERVER_NAME = "reai-mcp";
export const SERVER_VERSION = "0.3.0";

/**
 * Curated tools grouped by domain, so an operator can narrow the surface with
 * REAI_TOOLSETS. `meta` and `discovery` are not groupable — orientation and the
 * escape hatch are what make the rest usable.
 */
export const TOOL_GROUPS: Record<string, ToolDef[]> = {
  bookkeeping: bookkeepingTools,
  sales: salesTools,
  purchase: purchaseTools,
  bank: bankVatTools,
  organisation: organisationTools,
  assets: assetTools,
  subscriptions: subscriptionTools,
  warehouses: warehouseTools,
  agreements: agreementTools,
};

export const alwaysOnTools: ToolDef[] = [...metaTools, ...discoveryTools];

export const allTools: ToolDef[] = [
  ...alwaysOnTools,
  ...Object.values(TOOL_GROUPS).flat(),
];

/**
 * Every tool this server can ever register, including the independently gated ones.
 *
 * `allTools` is the DEFAULT surface, which is what the toolset arithmetic and the README
 * tool count are about. The repo-wide invariants — above all "no curated tool is more
 * permissive than the escape hatch would be" — have to iterate everything that can reach
 * a client, or a tool gated by its own flag is exempt from the guard this codebase treats
 * as its most important.
 */
export const registeredTools: ToolDef[] = [...allTools, ...uiTools];

/** The tools enabled by a given toolset selection. An empty selection means all. */
export function selectTools(toolsets: readonly string[]): ToolDef[] {
  if (toolsets.length === 0) return allTools;
  const enabled = Object.entries(TOOL_GROUPS)
    .filter(([name]) => toolsets.includes(name))
    .flatMap(([, tools]) => tools);
  return [...alwaysOnTools, ...enabled];
}

export type BuildServerOptions = {
  config: ServerConfig;
  /** Token for this session. Overrides `config.token` — used by the remote transport. */
  token?: string;
  session?: SessionState;
};

/**
 * Values the probe below tries for each argument.
 *
 * A single string was not enough. The probe used `"probe"` for every field, and the gate
 * escalates `sendEhf` and `automaticBillingGeneration` only on a value that binds to TRUE
 * — so both were invisible to the annotation while fully live in the gate, which is the
 * exact drift the probe exists to prevent. A boolean field needs a boolean.
 */
export const ESCALATION_PROBES: readonly unknown[] = ["probe", true, "create_invoice"];

/**
 * Whether any argument this tool accepts can escalate a call to irreversible. Probed
 * through the real classifier rather than a second list, so the annotation cannot
 * drift from the gate that enforces it — which only works if the probe values are ones
 * the gate actually reacts to.
 */
/**
 * Exported so the invariant test can assert the REAL probe rather than a copy of it. A test
 * that reimplements this passes on its own reimplementation — the mistake the comment inside
 * the function is about, one level up.
 */
export function hasEscalatingFields(tool: ToolDef): boolean {
  return Object.keys(tool.inputSchema ?? {}).some((field) =>
    ESCALATION_PROBES.some((value) => {
      if (curatedArgsEscalate(tool.apiPaths ?? [], { [field]: value }) !== undefined) return true;
      // A field that takes an OBJECT hides everything inside it from a scalar probe. The gate
      // itself walks nested bodies, so it catches those at runtime — but the annotation did
      // not, and the annotation is what a client keys on to ask before a destructive call.
      // reai_update_agreement was exactly this: `changes` carries the whole agreement, so
      // rentAccountNumber and depositAccountNumber were live in the gate and invisible here,
      // and a lease's payment destination could be redirected in `full` mode with the client
      // told it was an ordinary edit.
      return escalatingFieldNames.some(
        (nested) =>
          curatedArgsEscalate(tool.apiPaths ?? [], { [field]: { [nested]: value } }) !== undefined,
      );
    }),
  );
}

export function buildServer(opts: BuildServerOptions): McpServer {
  const { config } = opts;
  const token = opts.token ?? config.token;
  if (!token) {
    throw new ReaiConfigError(
      "No ReAI API token available. Set REAI_USER_API_TOKEN for local use, or authorize the " +
        "connector so the session can supply one.",
    );
  }

  const session: SessionState = opts.session ?? {};
  const client = new ReaiClient({
    token,
    baseUrl: config.baseUrl,
    ...(config.defaultTenantId !== undefined ? { defaultTenantId: config.defaultTenantId } : {}),
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    ...(config.verbose
      ? {
          onRequest: (e) => {
            const tenant = e.tenantId !== undefined ? ` tenant=${e.tenantId}` : "";
            const retries = e.retries > 0 ? ` retries=${e.retries}` : "";
            process.stderr.write(
              `[reai-mcp] ${e.method} ${e.path} → ${e.status} ${e.durationMs}ms${tenant}${retries}\n`,
            );
          },
        }
      : {}),
  });

  const ctx: ToolContext = { client, config, session };

  // The pairing view is opt-in. A client that does not render HTML resources would get
  // kilobytes of markup where it expected an answer, so it is off unless asked for.
  const byToolset = selectTools(config.toolsets);
  const selected = [...byToolset, ...(config.enableUi ? uiTools : [])];
  const allowedByWriteMode = selected.filter((t) => isAllowed(t.risk, config.writeMode));
  // A transmitting tool is hidden unless external send is explicitly enabled,
  // even in full mode: a posting can be reversed, a sent invoice cannot.
  const visible = allowedByWriteMode.filter(
    (t) => config.allowExternalSend || t.transmits !== true,
  );
  const hiddenByPolicy = selected.length - visible.length;
  // Counted against the TOOLSET selection, not against `selected`. Adding the UI tool to
  // `selected` while measuring the shortfall from `allTools` — which never contains it —
  // reported one fewer hidden tool than exists, in the instructions the model reads.
  const hiddenByToolset = allTools.length - byToolset.length;

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: buildInstructions(config, visible.length, hiddenByPolicy, hiddenByToolset) },
  );

  for (const tool of visible) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.meta ? { _meta: tool.meta } : {}),
        annotations: {
          title: tool.title,
          readOnlyHint: tool.risk === "read" && !tool.destructive,
          // Annotations are per TOOL and cannot vary per invocation, so a tool that
          // is ordinary for most of its fields and irreversible for a few has to be
          // annotated for the worst call it can make. Otherwise a client that asks
          // for confirmation before destructive tools would present "repoint this
          // supplier's bank account" as an ordinary edit — in `full` mode, where the
          // call is permitted, that annotation is the only thing left protecting it.
          destructiveHint:
            tool.destructive === true || tool.risk === "irreversible" || hasEscalatingFields(tool),
          idempotentHint: tool.idempotent === true,
          openWorldHint: true,
        },
      },
      // The SDK's inferred arg type depends on each tool's own schema; the
      // registry already validates and narrows, so the bridge is untyped here.
      (async (args: Record<string, unknown>) => {
        try {
          // Re-gate on the ARGUMENTS, not just the tool's declared risk. A tool can
          // be ordinary master-data work for most of its fields and something far
          // heavier for a few of them: reai_update_supplier is `reversible`, and its
          // own description promised that changing iban/swiftCode/bankAccountNumber
          // "requires REAI_WRITE_MODE=full" — a control that was written down and
          // never implemented, which is worse than none, because it invited running
          // the default mode believing bank details were protected.
          const escalated = curatedArgsEscalate(tool.apiPaths ?? [], args ?? {});
          // The external-send axis, checked BEFORE the write mode. A tool declared
          // transmits:false is the right declaration when its ordinary call sends nothing —
          // marking it true would hide the whole tool whenever sending is off, including the
          // benign case. But then only the ARGUMENTS can tell, and escalating the write risk
          // alone let `full` mode transmit with REAI_ALLOW_EXTERNAL_SEND unset, which is the
          // one thing that setting exists to prevent and which reai_request refuses.
          if (escalated?.transmits) {
            assertTransmitAllowed(
              "external",
              config.allowExternalSend,
              `${tool.name} with ${escalated.fields.join(", ")}`,
            );
          }
          if (escalated && !isAllowed(escalated.risk, config.writeMode)) {
            throw new WriteBlockedError({
              risk: escalated.risk,
              mode: config.writeMode,
              what:
                `${tool.name} called with ${escalated.fields.join(", ")} — ${escalated.consequence}. ` +
                `Every other field on this tool is unaffected, so the same call without those ` +
                `fields will work. Before changing them, ${escalated.verify}`,
            });
          }
          return await tool.handler(args ?? {}, ctx);
        } catch (err) {
          return toolError(err, tool.name);
        }
      }) as never,
    );
  }

  // The view is a RESOURCE, not something embedded in a tool result. An MCP Apps host
  // fetches it once from the `ui://` URI named in the tool's `_meta.ui.resourceUri`, and
  // then feeds each call's data to it as a notification. Embedding the HTML in the result
  // instead — which is what this did first — means a conforming host never launches it.
  if (visible.some((t) => t.meta?.ui !== undefined)) {
    server.registerResource(
      "reai-reconciliation-view",
      RECONCILE_TEMPLATE_URI,
      {
        title: "Bank reconciliation pairing view",
        description:
          "Interactive two-column view for pairing unmatched bank transactions with unmatched " +
          "ledger postings. Static template; the data arrives per tool call.",
        mimeType: RECONCILE_TEMPLATE_MIME,
      },
      () => ({
        contents: [
          {
            uri: RECONCILE_TEMPLATE_URI,
            mimeType: RECONCILE_TEMPLATE_MIME,
            text: renderTemplate(),
          },
        ],
      }),
    );
  }

  return server;
}

/**
 * Turn a thrown error into a tool result the model can act on.
 *
 * Returning `isError` rather than throwing keeps the conversation alive: an
 * unbalanced voucher or a missing VAT code is something the agent can fix and
 * retry, and it needs to read the API's complaint to do that.
 */
function toolError(err: unknown, toolName: string): ToolResult {
  let text: string;
  if (err instanceof WriteBlockedError) {
    text = err.message;
  } else if (err instanceof ReaiApiError) {
    text = err.message;
  } else if (err instanceof ReaiTransportError || err instanceof ReaiConfigError) {
    text = err.message;
  } else if (err instanceof Error) {
    text = `${toolName} failed: ${err.message}`;
  } else {
    text = `${toolName} failed: ${String(err)}`;
  }
  return { content: [{ type: "text", text }], isError: true };
}

const GROUP_BLURBS: Record<string, string> = {
  bookkeeping:
    "the bookkeeping core (accounts, VAT codes, vouchers, postings, general ledger)",
  sales: "the sales side (customers, products, orders, offers, invoices, customer ledger)",
  purchase:
    "the purchase side (suppliers, supplier invoices, the document inbox, EHF parsing, expenses)",
  bank: "bank reconciliation and VAT (company accounts, reconciliation rules, matching, VAT periods)",
  organisation: "departments and employees, and the employee ledger — the ids that postings and expenses are tagged with",
  assets: "the fixed-asset register (anleggsmidler): what the company capitalises, and how it depreciates",
  subscriptions: "recurring billing (abonnement): what bills whom, how often, and whether it goes out on its own",
  warehouses: "warehouses and stock on hand (lager), and the adjustments that move it",
  agreements:
    "contracts (avtaler): leases, employment contracts, purchase and service agreements, and their signing status",
};

function describeEnabledGroups(toolsets: readonly string[]): string {
  const enabled = Object.keys(TOOL_GROUPS).filter(
    (name) => toolsets.length === 0 || toolsets.includes(name),
  );
  const blurbs = enabled.map((name) => GROUP_BLURBS[name] ?? name);
  if (blurbs.length === 0) return "no domain-specific operations — use the discovery tools";
  if (blurbs.length === 1) return blurbs[0] as string;
  return `${blurbs.slice(0, -1).join(", ")} and ${blurbs[blurbs.length - 1]}`;
}

function buildInstructions(
  config: ServerConfig,
  visibleCount: number,
  hiddenByPolicy: number,
  hiddenByToolset: number,
): string {
  const index = getSpecIndex();
  const lines = [
    `ReAI (${config.baseUrl}) is a Norwegian cloud accounting system. This server exposes its API ` +
      `as ${visibleCount} tools, backed by ${index.counts.public} documented API operations.`,
    "",
    "Getting oriented:",
    "- Call reai_whoami first. Almost everything is tenant-scoped, and the tenant id selects which " +
      "company's books you are in. Set it once with reai_use_tenant.",
    // Built from the groups actually enabled: claiming coverage a disabled
    // toolset removed would have the model plan around tools that are not there.
    `- Curated tools cover ${describeEnabledGroups(config.toolsets)}.`,
    "- For anything else — and for every domain not listed above — use reai_search_endpoints to " +
      "find the endpoint, reai_describe_endpoint for its schema, then reai_request to call it. " +
      "Nothing in the API is out of reach that way.",
    "",
    "Bookkeeping conventions:",
    "- Dates are ISO yyyy-MM-dd.",
    "- In a voucher, a POSITIVE amount debits an account and a NEGATIVE amount credits it. " +
      "Postings must sum to exactly zero.",
    "- Look up account numbers with reai_list_accounts and VAT codes with reai_list_vat_codes " +
      "rather than assuming; both are tenant-specific.",
    "- Billing a customer is a two-step chain: an ORDER carries the line items, and invoicing that " +
      "order creates the invoice. There is no endpoint that builds an invoice from lines directly.",
    "- To undo an issued invoice, raise a credit note. Do not attempt to delete it.",
    "- There is NO endpoint that lists bank transactions. They are seen through " +
      "reai_get_bank_reconciliation for one account and one month (yyyy-MM), which is therefore the " +
      "entry point for any bank work — but that view is for bank-SYNCED accounts. An account with " +
      'providerType "manual" is reconciled against a statement balance through ' +
      "/api/manual-reconciliations/{id} instead.",
    "- Settling a VAT period locks the books for it; it does NOT file anything with Skatteetaten. " +
      "Never tell the user their VAT return has been submitted.",
    "- Supplier invoice COST LINES do not use the voucher sign convention: each line names its debit " +
      "and credit account, and the amount is positive on an invoice, negative on a credit note.",
    "- Incoming supplier invoices usually arrive in the reception inbox as PDF or EHF. Registering " +
      "them from there keeps the original document attached to the posting, which is what the " +
      "documentation rules require — prefer that over building one from scratch.",
    "- When you link a user to a created object, include the tenant: " +
      "https://app.reai.no/...?tenantId=<id>",
    "",
    `Write policy: REAI_WRITE_MODE=${config.writeMode}.`,
    config.allowExternalSend
      ? "EXTERNAL SEND IS ENABLED: this server may transmit EHF/Peppol invoices, invoice emails, " +
        "payment reminders and signing requests to real counterparties. Nothing sent can be " +
        "recalled. Confirm the recipient with the user before sending anything."
      : "External send is DISABLED on this deployment: nothing reaches a third party — no EHF/Peppol, " +
        "no invoice email, no reminders, no signing requests, and no invoice issuance (which starts " +
        "delivery). This is a separate switch from the write mode and is not lifted by " +
        "REAI_WRITE_MODE=full. If the user wants to send something, say plainly that the operator " +
        "enables it with REAI_ALLOW_EXTERNAL_SEND=1 — that is normal configuration for a business " +
        "doing its own invoicing, not something to discourage.",
  ];

  if (config.writeMode === "read-only") {
    lines.push(
      "This server cannot modify anything. Do not promise the user that a change was made.",
    );
  } else if (config.writeMode === "reversible") {
    lines.push(
      "You may create and edit master data (customers, suppliers, products, departments, offers). " +
        "You may NOT post to the ledger, issue invoices, register payments, run payroll, or file VAT " +
        "returns — those tools are hidden and the generic escape hatch will refuse them. " +
        "If the user asks for one, explain that the server must be restarted with " +
        "REAI_WRITE_MODE=full.",
    );
  } else {
    lines.push(
      "All operations are permitted, including ledger postings and other changes that cannot be " +
        "cleanly undone. Confirm intent before booking, deleting or filing anything, and prefer a " +
        "reversing voucher over deleting a voucher in a closed period.",
    );
  }

  if (hiddenByPolicy > 0) {
    lines.push(`${hiddenByPolicy} tool(s) are hidden by the current write policy.`);
  }
  if (hiddenByToolset > 0) {
    lines.push(
      `${hiddenByToolset} tool(s) are disabled by REAI_TOOLSETS=${config.toolsets.join(",")}. ` +
        `Those API endpoints remain reachable through reai_search_endpoints and reai_request.`,
    );
  }

  return lines.join("\n");
}
