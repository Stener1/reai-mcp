import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReaiClient } from "./reai/client.js";
import { ReaiApiError, ReaiConfigError, ReaiTransportError } from "./reai/errors.js";
import { isAllowed, WriteBlockedError } from "./policy.js";
import type { ServerConfig } from "./config.js";
import { getSpecIndex } from "./reai/spec.js";
import type { SessionState, ToolContext, ToolDef, ToolResult } from "./tools/registry.js";
import { metaTools } from "./tools/meta.js";
import { discoveryTools } from "./tools/discovery.js";
import { bookkeepingTools } from "./tools/bookkeeping.js";

export const SERVER_NAME = "reai-mcp";
export const SERVER_VERSION = "0.1.0";

export const allTools: ToolDef[] = [...metaTools, ...discoveryTools, ...bookkeepingTools];

export type BuildServerOptions = {
  config: ServerConfig;
  /** Token for this session. Overrides `config.token` — used by the remote transport. */
  token?: string;
  session?: SessionState;
};

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

  const visible = allTools.filter((t) => isAllowed(t.risk, config.writeMode));
  const hidden = allTools.length - visible.length;

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: buildInstructions(config, visible.length, hidden) },
  );

  for (const tool of visible) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.risk === "read" && !tool.destructive,
          destructiveHint: tool.destructive === true || tool.risk === "irreversible",
          idempotentHint: tool.idempotent === true,
          openWorldHint: true,
        },
      },
      // The SDK's inferred arg type depends on each tool's own schema; the
      // registry already validates and narrows, so the bridge is untyped here.
      (async (args: Record<string, unknown>) => {
        try {
          return await tool.handler(args ?? {}, ctx);
        } catch (err) {
          return toolError(err, tool.name);
        }
      }) as never,
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

function buildInstructions(config: ServerConfig, visibleCount: number, hiddenCount: number): string {
  const index = getSpecIndex();
  const lines = [
    `ReAI (${config.baseUrl}) is a Norwegian cloud accounting system. This server exposes its API ` +
      `as ${visibleCount} tools, backed by ${index.counts.public} documented API operations.`,
    "",
    "Getting oriented:",
    "- Call reai_whoami first. Almost everything is tenant-scoped, and the tenant id selects which " +
      "company's books you are in. Set it once with reai_use_tenant.",
    "- Curated tools cover the chart of accounts, VAT codes, vouchers, postings and the general ledger.",
    "- For anything else — invoices, suppliers, leads, agreements, salary, assets, bank " +
      "reconciliation — use reai_search_endpoints to find the endpoint, reai_describe_endpoint for " +
      "its schema, then reai_request to call it.",
    "",
    "Bookkeeping conventions:",
    "- Dates are ISO yyyy-MM-dd.",
    "- In a voucher, a POSITIVE amount debits an account and a NEGATIVE amount credits it. " +
      "Postings must sum to exactly zero.",
    "- Look up account numbers with reai_list_accounts and VAT codes with reai_list_vat_codes " +
      "rather than assuming; both are tenant-specific.",
    "- When you link a user to a created object, include the tenant: " +
      "https://app.reai.no/...?tenantId=<id>",
    "",
    `Write policy: REAI_WRITE_MODE=${config.writeMode}.`,
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

  if (hiddenCount > 0) {
    lines.push(`${hiddenCount} tool(s) are hidden by the current write policy.`);
  }

  return lines.join("\n");
}
