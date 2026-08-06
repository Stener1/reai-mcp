#!/usr/bin/env node
/**
 * Local stdio entry point — the transport MCP clients use when they spawn the
 * server as a child process (Claude Desktop, Claude Code, Cursor).
 *
 * Nothing may be written to stdout except MCP protocol frames, so all
 * diagnostics go to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { loadConfig } from "./config.js";
import { ReaiConfigError } from "./reai/errors.js";

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.token) {
    throw new ReaiConfigError(
      "REAI_USER_API_TOKEN is not set.\n\n" +
        "Create a token in ReAI (app.reai.no → settings → API tokens) and pass it in the MCP client " +
        "config, for example:\n\n" +
        '  "reai": {\n' +
        '    "command": "npx",\n' +
        '    "args": ["-y", "reai-mcp"],\n' +
        '    "env": { "REAI_USER_API_TOKEN": "<your-token>" }\n' +
        "  }",
    );
  }

  const server = buildServer({ config });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[${SERVER_NAME} ${SERVER_VERSION}] ready on stdio — ${config.baseUrl}, ` +
      `write mode ${config.writeMode}` +
      `${config.defaultTenantId !== undefined ? `, tenant ${config.defaultTenantId}` : ""}\n`,
  );

  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[${SERVER_NAME}] fatal: ${message}\n`);
  process.exit(1);
});
