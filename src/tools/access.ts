import { z } from "zod";
import {
  defineTool,
  ok,
  okList,
  requireTenantId,
  tenantIdArg,
  type ToolContext,
  type ToolDef,
} from "./registry.js";

/**
 * Who can reach the books — the access-control side of a tenant, entirely uncovered until now.
 *
 * All reads. The writes on these paths stay with `reai_request` on purpose and are already gated:
 * `POST /api/users` INVITES an email address and is classified as an external send, `PUT
 * /api/users/{id}` changes what someone may do (and is a full replacement), and `DELETE` revokes
 * access. Granting privilege is the one write in this API where the thing that leaves the tenant is
 * not data but authority, so it keeps the refusal that names what it would have done.
 *
 * ## The roles do not mean what their names suggest
 *
 * Measured on a live tenant by comparing the sets, not the counts:
 *
 *   ROLE_OWNER         51 permissions   not assignable
 *   ROLE_TENANT_ADMIN  51 permissions   assignable   — identical to OWNER, 0 missing, 0 extra
 *   ROLE_ACCOUNTANT    51 permissions   assignable   — identical to OWNER, 0 missing, 0 extra
 *   ROLE_AUDITOR       20 permissions   assignable   — read-only
 *   ROLE_EMPLOYEE       6 permissions   assignable   — self-scoped only
 *
 * So "accountant" is not a narrower role than "admin". Both are exactly the owner's access,
 * including `tenant:user:write` — the permission to invite further people — and the only thing
 * ROLE_OWNER has that they do not is that it cannot be handed out. Anyone reasoning from the names
 * would get this wrong, which is why these tools say it.
 *
 * ## Two permission scopes, and the prefix is the whole difference
 *
 * `self:…` reaches only the acting user's own records — their employee card, their expenses, their
 * timesheets. `tenant:…` reaches the company's. ROLE_EMPLOYEE holds six permissions and every one
 * is `self:`; the owner holds 6 self and 45 tenant. A code read without its prefix says nothing
 * about how much of the company it covers.
 */

type UserRecord = {
  userId?: number;
  status?: string;
  email?: string;
  fullName?: string | null;
  phone?: string | null;
  owner?: boolean;
  invitationId?: number | null;
  expiresAt?: string | null;
  roleCodes?: string[];
  directPermissionCodes?: string[];
  effectivePermissionCodes?: string[];
};

type RoleRecord = {
  code?: string;
  title?: string;
  description?: string;
  assignable?: boolean;
  effectivePermissionCodes?: string[];
};

/**
 * The roles that carry the owner's full permission set ON THIS TENANT, computed rather than listed.
 *
 * A hardcoded list of role codes was the first version, and it contradicted the very thing this
 * toolset is for: `reai_list_roles` computes the comparison from the response, while the user,
 * single-user and invitation summaries asserted it from the code alone. On a tenant where ReAI has
 * narrowed ROLE_ACCOUNTANT, that would report a narrowed user as holding full owner access — a
 * false answer in an access audit, which is the one place it must not be wrong.
 *
 * Costs one extra GET per call. The alternative is a claim about someone's authority derived from a
 * measurement taken on a different company.
 */
async function ownerEquivalentRoles(
  ctx: ToolContext,
  tenantId: number,
): Promise<{ codes: Set<string>; ownerPermissions: Set<string> } | undefined> {
  try {
    const res = await ctx.client.request<RoleRecord[]>({
      method: "GET",
      path: "/api/users/roles",
      tenantId,
    });
    const rows = Array.isArray(res.data) ? res.data : undefined;
    if (rows === undefined) return undefined;
    const owner = rows.find((r) => r.code === "ROLE_OWNER");
    const ownerPermissions = new Set(owner?.effectivePermissionCodes ?? []);
    if (ownerPermissions.size === 0) return undefined;
    const codes = new Set<string>();
    for (const role of rows) {
      const set = new Set(role.effectivePermissionCodes ?? []);
      // COVERS the owner's set, not equals it. Requiring equal sizes was the first version and it
      // was stricter than the question: a role holding everything the owner has plus something else
      // still carries the owner's access, which is what this is used to warn about. It also left an
      // untested branch — a mutation removing the size check changed no test, because no fixture had
      // a superset role. Superset semantics match holdsOwnerAccess, so both now ask the same thing.
      if ([...ownerPermissions].every((p) => set.has(p))) {
        if (role.code !== undefined) codes.add(role.code);
      }
    }
    return { codes, ownerPermissions };
  } catch {
    return undefined;
  }
}

/** Whether a user's OWN effective permissions cover everything the owner has. */
function holdsOwnerAccess(
  user: UserRecord,
  yardstick: { codes: Set<string>; ownerPermissions: Set<string> } | undefined,
): boolean {
  if (yardstick === undefined) return false;
  const own = new Set(user.effectivePermissionCodes ?? []);
  // The permissions decide it, not the role name — a direct grant can lift a narrow role, and a
  // narrowed role does not become owner-equivalent by keeping its title.
  if (own.size > 0) return [...yardstick.ownerPermissions].every((p) => own.has(p));
  return (user.roleCodes ?? []).some((r) => yardstick.codes.has(r));
}

/** How much of the company a permission list reaches, by prefix. */
function scopeSummary(codes: readonly string[] | undefined): string {
  if (!Array.isArray(codes)) return "no permission list was returned";
  const self = codes.filter((c) => c.startsWith("self:")).length;
  const tenant = codes.filter((c) => c.startsWith("tenant:")).length;
  const other = codes.length - self - tenant;
  return (
    `${codes.length} effective permission(s): ${tenant} tenant-wide, ${self} self-scoped` +
    (other > 0 ? `, ${other} with an unrecognised prefix` : "")
  );
}

const listUsers = defineTool({
  name: "reai_list_users",
  title: "List who can reach this tenant",
  description:
    "Everyone with access to this company's books: their status, roles, and effective permissions. " +
    "This is the answer to \"who can see our accounting data\", and it includes people who have not " +
    "accepted yet — status is active or pending_invitation, and a pending one carries an " +
    "invitationId and an expiresAt.\n\n" +
    "Read the ROLES rather than trusting their names. Measured on a live tenant: " +
    "ROLE_TENANT_ADMIN and ROLE_ACCOUNTANT hold permission sets IDENTICAL to ROLE_OWNER — 51 " +
    "permissions each, nothing missing and nothing extra — and both are assignable while " +
    "ROLE_OWNER is not. Someone invited as an accountant has exactly what the owner has, including " +
    "the permission to invite others. This tool flags that rather than leaving it to be inferred.\n\n" +
    "Permission codes carry their scope as a prefix: self: reaches only that person's own records, " +
    "tenant: reaches the company's.",
  risk: "read",
  apiPaths: [["GET", "/api/users"]],
  inputSchema: { tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const res = await ctx.client.request<UserRecord[]>({
      method: "GET",
      path: "/api/users",
      tenantId,
    });
    const rows = Array.isArray(res.data) ? res.data : undefined;
    const yardstick = await ownerEquivalentRoles(ctx, tenantId);
    // Counted from the rows, never from their absence: a response that is not a list is reported as
    // unreadable rather than as an empty company, which for an access question would be the worst
    // possible wrong answer.
    const pending = rows?.filter((u) => u.status === "pending_invitation") ?? [];
    const ownerLike = rows?.filter((u) => holdsOwnerAccess(u, yardstick)) ?? [];
    const notes: string[] = [];
    if (rows === undefined) {
      notes.push(
        "The response was not a list, so how many people can reach this tenant is UNKNOWN — do not " +
          "read that as nobody. Look at the body below.",
      );
    } else {
      notes.push(
        `${rows.length} user(s) with access. ` +
          (yardstick === undefined
            ? `Whether any of them hold owner-equivalent access could not be established — the role ` +
              `list this compares against was unreadable. Do not read that as "none do".`
            : `${ownerLike.length} hold everything ROLE_OWNER has, judged on their own effective ` +
              `permissions rather than their role title` +
              (yardstick.codes.size > 1
                ? ` (on this tenant ${[...yardstick.codes].join(", ")} all carry the owner's full ` +
                  `${yardstick.ownerPermissions.size}-permission set)`
                : ``) +
              `.`) +
          ` ${pending.length} have not accepted yet.`,
      );
      if (pending.length > 0) {
        // Bounded, because ok() caps the serialised BODY and not a caller-supplied note: a tenant
        // with a long invitation list would otherwise push this result past the limit the rest of
        // the server holds itself to, from a string this tool built itself.
        const SHOWN = 10;
        notes.push(
          `PENDING INVITATIONS are standing access waiting to be claimed: ` +
            pending
              .slice(0, SHOWN)
              .map(
                (u) =>
                  `${u.email ?? "?"} as ${(u.roleCodes ?? []).join(", ") || "no role"}` +
                  `${u.expiresAt ? ` until ${u.expiresAt}` : ""}`,
              )
              .join("; ") +
            (pending.length > SHOWN
              ? ` — and ${pending.length - SHOWN} more, listed in the body below`
              : ``) +
            `. Revoking one is DELETE /api/users/{id} through reai_request.`,
        );
      }
    }
    return ok(res.data, { note: notes.join("\n\n") });
  },
});

const getUser = defineTool({
  name: "reai_get_user",
  title: "Get one user's access",
  description:
    "One user's access to this tenant: their roles, any permissions granted directly on top of " +
    "those, and the effective set that results. Use it to answer what a specific person can " +
    "actually do, rather than what their role is called.\n\n" +
    "directPermissionCodes is the part a role does not explain — permissions attached to the person " +
    "rather than inherited — so a user whose role looks narrow can still hold more.",
  risk: "read",
  apiPaths: [
    ["GET", "/api/users/{id}"],
    ["GET", "/api/users/roles"],
  ],
  inputSchema: {
    id: z.number().int().positive().describe("User id, from reai_list_users."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const res = await ctx.client.request<UserRecord>({
      method: "GET",
      path: `/api/users/${args.id}`,
      tenantId,
    });
    const user = res.data ?? {};
    const roles = user.roleCodes ?? [];
    const yardstick = await ownerEquivalentRoles(ctx, tenantId);
    const notes = [
      `${user.email ?? `User ${args.id}`}${user.fullName ? ` (${user.fullName})` : ""}: status ` +
        `${user.status ?? "unknown"}, role(s) ${roles.join(", ") || "none"}. ${scopeSummary(user.effectivePermissionCodes)}.`,
    ];
    if (holdsOwnerAccess(user, yardstick)) {
      notes.push(
        `This user holds OWNER-EQUIVALENT access: their effective permissions cover everything ` +
          `ROLE_OWNER has on this tenant (${yardstick?.ownerPermissions.size} permission(s)), so ` +
          `they can do anything the owner can, including inviting others. Judged on the permissions ` +
          `themselves — a role title is not evidence either way, since a direct grant can lift a ` +
          `narrow role and a narrowed role keeps its name.`,
      );
    } else if (yardstick === undefined) {
      notes.push(
        `Whether this is owner-equivalent access could not be established — the role list it is ` +
          `compared against was unreadable. Do not read that as "no".`,
      );
    }
    if ((user.directPermissionCodes ?? []).length > 0) {
      notes.push(
        `${user.directPermissionCodes?.length} permission(s) are granted DIRECTLY rather than by ` +
          `role: ${(user.directPermissionCodes ?? []).join(", ")}. Their role alone does not ` +
          `describe what they can do.`,
      );
    }
    if (user.status === "pending_invitation") {
      notes.push(
        `This is an unaccepted INVITATION${user.expiresAt ? `, expiring ${user.expiresAt}` : ""} — ` +
          `access waiting to be claimed by whoever controls that mailbox, not access already in use.`,
      );
    }
    return ok(user, { note: notes.join("\n\n") });
  },
});

const listRoles = defineTool({
  name: "reai_list_roles",
  title: "List the roles this tenant can grant",
  description:
    "The roles available on this tenant, each with its permission set and whether it can be " +
    "assigned. Worth reading before inviting anyone, because the names imply a hierarchy the " +
    "permissions do not implement.\n\n" +
    "Measured by comparing the SETS rather than the counts: ROLE_TENANT_ADMIN and ROLE_ACCOUNTANT " +
    "are identical to ROLE_OWNER — 51 permissions, nothing missing, nothing extra — and both are " +
    "assignable while ROLE_OWNER is not. ROLE_AUDITOR is 20 read-only permissions, and " +
    "ROLE_EMPLOYEE is 6, every one of them self-scoped. This tool reports the comparison it finds " +
    "on YOUR tenant rather than repeating those numbers, so it stays true if the roles change.",
  risk: "read",
  apiPaths: [["GET", "/api/users/roles"]],
  inputSchema: { tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<RoleRecord[]>({
      method: "GET",
      path: "/api/users/roles",
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const rows = Array.isArray(res.data) ? res.data : undefined;
    if (rows === undefined) {
      return ok(res.data, {
        note:
          "The response was not a list, so the roles on this tenant could not be compared — read " +
          "the body below rather than assuming there are none.",
      });
    }
    const owner = rows.find((r) => r.code === "ROLE_OWNER");
    const ownerSet = new Set(owner?.effectivePermissionCodes ?? []);
    const lines = rows.map((r) => {
      const set = new Set(r.effectivePermissionCodes ?? []);
      const missing = [...ownerSet].filter((p) => !set.has(p)).length;
      const extra = [...set].filter((p) => !ownerSet.has(p)).length;
      const sameAsOwner = ownerSet.size > 0 && missing === 0 && extra === 0;
      return (
        `${r.code ?? "?"} — ${set.size} permission(s), ` +
        `${r.assignable === true ? "assignable" : "NOT assignable"}` +
        (r.code === "ROLE_OWNER"
          ? ""
          : sameAsOwner
            ? ", IDENTICAL to ROLE_OWNER"
            : `, ${missing} fewer than ROLE_OWNER${extra > 0 ? ` and ${extra} it does not have` : ""}`)
      );
    });
    const grantableOwner = rows.filter(
      (r) =>
        r.code !== "ROLE_OWNER" &&
        r.assignable === true &&
        ownerSet.size > 0 &&
        [...ownerSet].every((p) => (r.effectivePermissionCodes ?? []).includes(p)),
    );
    const notes = [`${rows.length} role(s) on this tenant:\n${lines.map((l) => `  ${l}`).join("\n")}`];
    if (grantableOwner.length > 0) {
      notes.push(
        `${grantableOwner.length} ASSIGNABLE role(s) carry everything ROLE_OWNER has: ` +
          `${grantableOwner.map((r) => r.code).join(", ")}. Granting one of those is granting the ` +
          `company's books in full, whatever the title suggests — and it includes the permission to ` +
          `invite further people.`,
      );
    }
    return ok(res.data, { note: notes.join("\n\n") });
  },
});

const listPermissions = defineTool({
  name: "reai_list_permissions",
  title: "List the permission catalogue",
  description:
    "Every permission code this tenant recognises, with its group, title and type (View, Edit or " +
    "Approve). This is what the codes in reai_list_users mean.\n\n" +
    "The prefix is the important part and is easy to miss: self: reaches only the acting user's own " +
    "records — their employee card, their expenses, their timesheets — while tenant: reaches the " +
    "company's. A code quoted without its prefix says nothing about how much it covers.\n\n" +
    "The catalogue is NOT the whole vocabulary, measured: it returned 45 codes, all tenant-scoped, " +
    "while the owner's effective set holds 51 — the 6 self: codes appear on users and roles but are " +
    "absent here. So a code from reai_list_users that cannot be found in this list is not " +
    "necessarily invalid; the self-scoped ones are simply not published.",
  risk: "read",
  apiPaths: [["GET", "/api/users/permissions"]],
  inputSchema: { tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<
      Array<{ code?: string; groupName?: string; type?: string }>
    >({
      method: "GET",
      path: "/api/users/permissions",
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const rows = Array.isArray(res.data) ? res.data : undefined;
    const groups = new Set(rows?.map((p) => p.groupName ?? "?"));
    const types = [...new Set(rows?.map((p) => p.type ?? "?"))];
    return okList(res.data, {
      noun: "permission",
      suffix: rows
        ? `, in ${groups.size} group(s), of type(s) ${types.join(" / ")}. Codes are scoped by ` +
          `prefix: ${rows.filter((p) => p.code?.startsWith("tenant:")).length} tenant-wide and ` +
          `${rows.filter((p) => p.code?.startsWith("self:")).length} self-scoped.`
        : ".",
      empty:
        "No permissions were returned, which is not a state this tenant should be in — read the " +
        "body rather than treating it as an empty catalogue.",
    });
  },
});

const listInvitations = defineTool({
  name: "reai_list_user_invitations",
  title: "List pending invitations",
  description:
    "Invitations that have been sent and not yet accepted. Each one is standing access waiting to " +
    "be claimed by whoever controls that mailbox, so an old unaccepted invitation to a role with " +
    "owner-equivalent permissions is worth noticing.\n\n" +
    "reai_list_users shows these too, as status pending_invitation. This endpoint is the narrower " +
    "question. Revoking one is DELETE /api/users/{id} through reai_request; sending one is POST " +
    "/api/users, which mails the invitation and is therefore treated as an external send.",
  risk: "read",
  apiPaths: [
    ["GET", "/api/users/invitations"],
    ["GET", "/api/users/roles"],
  ],
  inputSchema: { tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const res = await ctx.client.request<UserRecord[]>({
      method: "GET",
      path: "/api/users/invitations",
      tenantId,
    });
    const rows = Array.isArray(res.data) ? res.data : undefined;
    const yardstick = rows && rows.length > 0 ? await ownerEquivalentRoles(ctx, tenantId) : undefined;
    const ownerLike = rows?.filter((u) => holdsOwnerAccess(u, yardstick));
    return okList(res.data, {
      noun: "pending invitation",
      suffix:
        rows && rows.length > 0
          ? yardstick === undefined
            ? `. Whether any would grant owner-equivalent access could not be established — the ` +
              `role list it is compared against was unreadable.`
            : `. ${ownerLike?.length ?? 0} of them would grant everything ROLE_OWNER has, judged on ` +
              `the permissions rather than the role title.`
          : ".",
      empty:
        "No pending invitations: everyone with access has accepted it. That is a statement about " +
        "invitations only — reai_list_users is what says who has access.",
    });
  },
});

export const accessTools: ToolDef[] = [
  listUsers,
  getUser,
  listRoles,
  listPermissions,
  listInvitations,
];
