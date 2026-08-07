import { z } from "zod";
import { defineTool, ok, okText, resolveTenantId, type ToolDef } from "./registry.js";
import { WRITE_MODES } from "../policy.js";

type MeResponse = {
  email?: string;
  name?: string;
  tenants?: Array<{ id: number; slug?: string; companyName?: string; currencyCode?: string }>;
};

/**
 * The tenant list from /api/me, keeping "reached no companies" apart from "the field was
 * not there".
 *
 * `me.tenants ?? []` collapsed the two, which is the same absence-as-zero mistake the list
 * tools had — and here the consequence is sharper than a wrong count: reai_use_tenant would
 * tell a user that a perfectly valid company "is not accessible with this token" and send
 * them off to ask for access that they already have.
 */
function tenantsFrom(me: MeResponse | undefined): { tenants: NonNullable<MeResponse["tenants"]>; reported: boolean } {
  return Array.isArray(me?.tenants)
    ? { tenants: me.tenants, reported: true }
    : { tenants: [], reported: false };
}

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
    const { tenants, reported } = tenantsFrom(me);

    const notes: string[] = [];
    // A grant bound at authorization time must not enumerate the OTHER companies the
    // underlying ReAI token can reach. /api/me returns all of them, and returning them
    // handed the agent every client company's name, id, currency and deep link — while
    // the README claimed the binding prevented exactly that. The binding is a boundary
    // on what can be addressed; it has to be a boundary on what is disclosed too.
    const bound = ctx.config.boundTenantId;
    const visible = bound === undefined ? tenants : tenants.filter((t) => t.id === bound);

    if (!reported) {
      notes.push(
        "GET /api/me did not return a tenant list: the field was absent or not an array, so " +
          "which companies this token reaches is UNKNOWN. That is not a count of zero, and " +
          "nothing below states one — the guidance that depends on knowing the list is omitted " +
          "rather than guessed. " +
          // The payload withholds the raw value on a bound connection, so the note must not
          // promise it there. Promising something the payload does not carry is the same
          // mismatch this whole change is about.
          (bound === undefined
            ? "The value the API actually sent is under rawTenants."
            : "The raw value is withheld because this connection is bound to one company, and " +
              "it could name the others."),
      );
    }

    if (bound !== undefined) {
      notes.push(
        `This connection is BOUND to tenant ${bound}` +
          `${visible[0]?.companyName ? ` (${visible[0].companyName})` : ""} and cannot address any ` +
          `other, so there is no tenant to select and no tenantId to pass. The underlying ReAI ` +
          `token may reach other companies; they are deliberately not listed here. To work in a ` +
          `different one, re-authorize and pick it.`,
      );
    } else if (active !== undefined) {
      const match = tenants.find((t) => t.id === active);
      notes.push(
        match
          ? `Active tenant: ${active} (${match.companyName ?? match.slug ?? "unnamed"}).`
          : // Only a REPORTED list can establish that an id is absent from it. Saying "that id
            // is NOT in this token's tenant list — calls will fail with 403 or 404" on the
            // strength of a list that never arrived is the same confident wrong answer
            // reai_use_tenant refuses to give, one function away in this file.
            reported
            ? `Active tenant is set to ${active}, but that id is NOT in this token's tenant list — ` +
              `calls will fail with 403 or 404. Pick one of the ids below.`
            : `Active tenant is set to ${active}. Whether this token reaches it could not be ` +
              `checked, because /api/me returned no tenant list — this is NOT a report that the ` +
              `id is invalid.`,
      );
    } else if (!reported) {
      // No active tenant and no list: there is nothing truthful to say about how many
      // companies are reachable, so say only that.
      notes.push(
        "No active tenant set, and the reachable companies could not be listed. Pass tenantId " +
          "per call, or retry — reai_use_tenant cannot verify an id either while this persists.",
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
    if (reported && tenants.length === 1) {
      // Deliberately describes the OBSERVED behaviour rather than naming the token kind.
      // A user-scoped token belonging to a user with access to one company also returns a
      // one-element list, and /api/me exposes no field that distinguishes the two — so
      // "this is a tenant-scoped token" would be a guess presented as fact.
      notes.push(
        `This token reaches exactly one company. In that situation ReAI has been observed to ` +
          `IGNORE the tenant header — any tenant id returns this company's data, including ids that ` +
          `do not exist — so a successful response is not evidence you reached the tenant you asked ` +
          `for. This list is authoritative: a company missing from it is not reachable, even if it ` +
          `exists in the UI. If you expected more companies, the token may be scoped to this one; a ` +
          `token covering the whole user account lists every company they can open.`,
      );
    } else if (tenants.length > 1 && bound === undefined) {
      // The multi-tenant branch had no guidance at all, because no token available during
      // development reached more than one company. The rules genuinely invert: the tenant
      // header goes from ignored to load-bearing. Skipped when bound, where selecting is
      // exactly what the connection forbids.
      notes.push(
        `This token reaches ${tenants.length} companies, so the tenant header is load-bearing ` +
          `rather than ignored: every tenant-scoped call needs one, and it selects which company ` +
          `you are writing to. Set it once with reai_use_tenant, or pass tenantId per call — do not ` +
          `rely on a default.`,
      );
      const currencies = [...new Set(tenants.map((t) => t.currencyCode).filter(Boolean))];
      if (currencies.length > 1) {
        notes.push(
          `These companies do not share a currency (${currencies.join(", ")}). The currency below is ` +
            `the COMPANY's; individual records carry their own — an invoice total, for instance, is ` +
            `in the invoice's currency, which may differ again. Read the currency on each result ` +
            `rather than assuming the company's, and do not add figures across companies.`,
        );
      }
    }

    return ok(
      {
        user: { email: me.email, name: me.name },
        activeTenantId: active ?? null,
        writeMode: ctx.config.writeMode,
        tenants: visible.map((t) => ({
          ...t,
          url: ctx.client.deepLink("/", t.id),
        })),
        // The note promises this, and without it the ONE thing the caller needs to see —
        // what the API actually sent instead of a list — was the one thing rebuilt away.
        // Withheld when the connection is bound, where not disclosing other companies is
        // the point and a raw payload would leak exactly what the binding hides.
        ...(reported || bound !== undefined ? {} : { rawTenants: me?.tenants ?? null }),
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
    const { tenants, reported } = tenantsFrom(res.data);
    if (!reported) {
      return okText(
        `Cannot verify tenant ${args.tenantId}: GET /api/me did not return a tenant list, so ` +
          `whether this token reaches that company is unknown. This is deliberately NOT read as ` +
          `"no access" — that would be a confident wrong answer. Retry, and check the raw ` +
          `response with reai_request GET /api/me.`,
      );
    }
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
