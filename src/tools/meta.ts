import { z } from "zod";
import { defineTool, ok, okText, resolveTenantId, type ToolDef } from "./registry.js";
import { WRITE_MODES } from "../policy.js";

type MeResponse = {
  email?: string;
  name?: string;
  tenants?: Array<{ id: number; slug?: string; companyName?: string; currencyCode?: string }>;
};

const whoami = defineTool({
  name: "reai_whoami",
  title: "Who am I and which companies can I reach",
  description:
    "Identify the authenticated ReAI user and list every tenant (company) the token can access, " +
    "with each tenant's id, slug and currency. Call this first in any session: most other tools are " +
    "tenant-scoped, and the tenant id is what selects which company's books you are working in. " +
    "Also reports the active tenant and the server's current write policy.",
  risk: "read",
  apiPaths: [["GET", "/api/me"]],
  inputSchema: {},
  handler: async (_args, ctx) => {
    const res = await ctx.client.request<MeResponse>({
      method: "GET",
      path: "/api/me",
      omitTenant: true,
    });
    const me = res.data;
    const active = resolveTenantId(undefined, ctx);
    const tenants = me.tenants ?? [];

    const notes: string[] = [];
    if (active !== undefined) {
      const match = tenants.find((t) => t.id === active);
      notes.push(
        match
          ? `Active tenant: ${active} (${match.companyName ?? match.slug ?? "unnamed"}).`
          : `Active tenant is set to ${active}, but that id is NOT in this token's tenant list — ` +
              `calls will fail with 403 or 404. Pick one of the ids below.`,
      );
    } else if (tenants.length === 1) {
      notes.push(
        `No active tenant set, but this token reaches exactly one company: ${tenants[0]?.id} ` +
          `(${tenants[0]?.companyName ?? "unnamed"}). Call reai_use_tenant to select it.`,
      );
    } else {
      notes.push(
        `No active tenant set and this token reaches ${tenants.length} companies. ` +
          `Call reai_use_tenant before using tenant-scoped tools, or pass tenantId per call.`,
      );
    }
    notes.push(
      `Write policy: REAI_WRITE_MODE=${ctx.config.writeMode} ` +
        `(available modes: ${WRITE_MODES.join(", ")}).`,
    );
    if (tenants.length === 1) {
      notes.push(
        `This token reaches exactly one company, which means it is TENANT-SCOPED. ReAI ignores the ` +
          `tenant header for such a token — any tenant id returns this company's data, including ids ` +
          `that do not exist — so a successful response is not evidence you reached the tenant you ` +
          `asked for. This list is authoritative; a company missing from it is not reachable, even ` +
          `if it exists in the UI. A USER-scoped token would list every company the user can open, ` +
          `and then the tenant header is both required and honoured.`,
      );
    } else if (tenants.length > 1) {
      // The multi-tenant branch had no equivalent guidance, because no token available
      // during development reached more than one company. The rules genuinely invert:
      // the header goes from ignored to load-bearing.
      notes.push(
        `This token reaches ${tenants.length} companies, so it is USER-scoped and the tenant header ` +
          `is load-bearing rather than ignored: every tenant-scoped call needs one, and it selects ` +
          `which company you are writing to. Set it once with reai_use_tenant, or pass tenantId per ` +
          `call — do not rely on a default.`,
      );
      const currencies = [...new Set(tenants.map((t) => t.currencyCode).filter(Boolean))];
      if (currencies.length > 1) {
        notes.push(
          `These companies do not share a currency (${currencies.join(", ")}), and amounts are in ` +
            `the company's own currency — so a figure is only comparable across them after ` +
            `conversion. Check the currency below before reading any total.`,
        );
      }
    }

    return ok(
      {
        user: { email: me.email, name: me.name },
        activeTenantId: active ?? null,
        writeMode: ctx.config.writeMode,
        tenants: tenants.map((t) => ({
          ...t,
          url: ctx.client.deepLink("/", t.id),
        })),
      },
      { note: notes.join("\n") },
    );
  },
});

const useTenant = defineTool({
  name: "reai_use_tenant",
  title: "Select the active company",
  description:
    "Set the tenant (company) that subsequent tool calls apply to, for the rest of this session. " +
    "Only works where the session persists — a stateless remote deployment will tell you to pass " +
    "tenantId per call instead. " +
    "The id is validated against the tenants this token can actually reach, so a typo fails here " +
    "rather than silently writing into the wrong company's books. " +
    "Individual tools can still override it with their own tenantId argument.",
  risk: "read",
  apiPaths: [["GET", "/api/me"]], // Session-local state only; it changes no data in ReAI.
  idempotent: true,
  inputSchema: {
    tenantId: z
      .number()
      .int()
      .positive()
      .describe("Tenant id to make active. Get valid ids from reai_whoami."),
  },
  handler: async (args, ctx) => {
    // In stateless remote mode a new server -- and a new empty session -- is built
    // for every request, so setting an active tenant here would report success and
    // then be silently discarded before the next call. Say so instead of lying.
    if (ctx.config.statelessSession && ctx.config.boundTenantId === undefined) {
      return okText(
        `This connection cannot remember a tenant selection: it is served statelessly, so each ` +
          `request gets a fresh session.\n\n` +
          `Pass tenantId explicitly on each tool call instead — reai_whoami lists the ids. ` +
          `Alternatively the operator can set REAI_TENANT_ID on the deployment, or bind a tenant ` +
          `when authorizing the connector, and then no tenantId argument is needed at all.`,
      );
    }

    const bound = ctx.config.boundTenantId;
    if (bound !== undefined && args.tenantId !== bound) {
      return okText(
        `This connection is bound to tenant ${bound} and cannot be switched to ${args.tenantId}.\n` +
          `The company was chosen when the connector was authorized. To work in a different one, ` +
          `re-authorize the connection and select that company.`,
      );
    }

    const res = await ctx.client.request<MeResponse>({
      method: "GET",
      path: "/api/me",
      omitTenant: true,
    });
    const tenants = res.data.tenants ?? [];
    const match = tenants.find((t) => t.id === args.tenantId);
    if (!match) {
      const list = tenants.map((t) => `  ${t.id} — ${t.companyName ?? t.slug ?? "unnamed"}`).join("\n");
      return okText(
        `Tenant ${args.tenantId} is not accessible with this token. Available tenants:\n` +
          `${list || "  (none)"}\n\n` +
          `This is checked against GET /api/me rather than by trying the tenant, deliberately: ReAI ` +
          `ignores the tenant header when a token reaches only one company, so probing ${args.tenantId} ` +
          `would return 200 with the WRONG company's data and look like success.\n\n` +
          `If the company exists in the ReAI UI but is missing above, access has not been granted to ` +
          `this user yet — finish its onboarding, or have its owner grant access. It will appear here ` +
          `once that is done.`,
      );
    }

    ctx.session.activeTenantId = args.tenantId;
    return okText(
      `Active tenant is now ${match.id} — ${match.companyName ?? match.slug} ` +
        `(currency ${match.currencyCode ?? "unknown"}).\n` +
        `${ctx.client.deepLink("/", match.id)}`,
    );
  },
});

export const metaTools: ToolDef[] = [whoami, useTenant] as ToolDef[];
