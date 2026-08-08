import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { accessTools } from "../dist/tools/access.js";
import { registeredTools } from "../dist/server.js";
import { classifyRequest, classifyTransmission } from "../dist/policy.js";
import { quirksFor } from "../dist/reai/quirks.js";

const tool = (name) => {
  const found = accessTools.find((t) => t.name === name);
  assert.ok(found, `${name} is not registered`);
  return found;
};

/**
 * `data` may be a value, or a function of the request.
 *
 * Three of these tools now fetch /api/users/roles as well, so owner-equivalence is computed from
 * this tenant's permission sets rather than asserted from a role code. `rolesData` supplies that
 * second response; passing null for it is how the "role list unreadable" branch is exercised.
 */
async function run(name, args, data, rolesData = roles()) {
  const calls = [];
  const validated = z.object(tool(name).inputSchema).parse({ tenantId: 2634, ...args });
  const result = await tool(name).handler(validated, {
    client: {
      request: async (req) => {
        calls.push(req);
        if (req.path === "/api/users/roles" && name !== "reai_list_roles") {
          return { data: rolesData, status: 200 };
        }
        return { data: typeof data === "function" ? data(req) : data, status: 200 };
      },
      deepLink: () => "link",
    },
    config: { writeMode: "read-only", tenantId: 2634, allowExternalSend: false },
    session: {},
  });
  return { calls, result, text: result.content.find((c) => c.type === "text").text };
}

/** Permission sets shaped like the live tenant's: owner-equivalent roles and a narrow one. */
const OWNER_PERMS = [
  ...Array.from({ length: 45 }, (_, i) => `tenant:thing${i}:read`),
  ...Array.from({ length: 6 }, (_, i) => `self:thing${i}:read`),
];
const roles = () => [
  { code: "ROLE_OWNER", assignable: false, effectivePermissionCodes: OWNER_PERMS },
  { code: "ROLE_TENANT_ADMIN", assignable: true, effectivePermissionCodes: OWNER_PERMS },
  { code: "ROLE_ACCOUNTANT", assignable: true, effectivePermissionCodes: OWNER_PERMS },
  { code: "ROLE_AUDITOR", assignable: true, effectivePermissionCodes: OWNER_PERMS.slice(0, 20) },
  { code: "ROLE_EMPLOYEE", assignable: true, effectivePermissionCodes: OWNER_PERMS.slice(45) },
];
const user = (o = {}) => ({
  userId: 1853,
  status: "active",
  email: "someone@example.invalid",
  fullName: "Some One",
  owner: true,
  roleCodes: ["ROLE_OWNER"],
  directPermissionCodes: [],
  effectivePermissionCodes: OWNER_PERMS,
  ...o,
});

const NAMES = [
  "reai_list_users",
  "reai_get_user",
  "reai_list_roles",
  "reai_list_permissions",
  "reai_list_user_invitations",
];

test("all five access tools are registered and are reads", () => {
  const registered = new Set(registeredTools.map((t) => t.name));
  for (const name of NAMES) {
    assert.ok(registered.has(name), name);
    assert.equal(tool(name).risk, "read");
    for (const [method, path] of tool(name).apiPaths) {
      assert.equal(method, "GET");
      assert.equal(classifyRequest("GET", path.replace("{id}", "1")), "read");
      assert.equal(classifyTransmission("GET", path.replace("{id}", "1"), undefined), "none");
    }
  }
});

// The write side is deliberately uncurated: POST /api/users mails an invitation and grants
// privilege, which is already classified as an external send.
test("no access tool can grant, change or revoke access", () => {
  // Same shape as the salary sweep: this says every /api/users path a tool declares is a GET, which is
  // vacuously true if no tool declares one. Pin the population so the claim is about something.
  const usersPaths = registeredTools.flatMap((t) => (t.apiPaths ?? []).filter(([, p]) => /^\/api\/users/.test(p)));
  assert.ok(usersPaths.length >= 5, `only ${usersPaths.length} /api/users paths declared — the claim below is about nothing`);
  for (const t of registeredTools) {
    for (const [method, path] of t.apiPaths ?? []) {
      if (!/^\/api\/users/.test(path)) continue;
      assert.equal(method, "GET", `${t.name} reaches ${method} ${path}`);
    }
  }
  // And the invite endpoint is still gated on the send axis, which is what justifies leaving it out.
  assert.equal(classifyTransmission("POST", "/api/users", undefined), "external");
});

test("the user list flags owner-equivalent access and unaccepted invitations", async () => {
  const { calls, text } = await run("reai_list_users", {}, [
    user(),
    user({ userId: 2, roleCodes: ["ROLE_ACCOUNTANT"], owner: false }),
    user({
      userId: 3,
      status: "pending_invitation",
      email: "invited@example.invalid",
      roleCodes: ["ROLE_TENANT_ADMIN"],
      invitationId: 9,
      expiresAt: "2026-09-01",
    }),
  ]);
  // The role list is fetched, because the comparison has to come from this tenant.
  assert.deepEqual(calls.map((c) => c.path), ["/api/users", "/api/users/roles"]);
  assert.match(text, /3 user\(s\) with access/);
  assert.match(text, /3 hold everything ROLE_OWNER has/);
  assert.match(text, /judged on their own effective permissions rather than their role title/);
  assert.match(text, /1 have not accepted/);
  assert.match(text, /PENDING INVITATIONS are standing access/);
  assert.match(text, /invited@example.invalid as ROLE_TENANT_ADMIN until 2026-09-01/);
});

// The finding this fix is for: a hardcoded role list would report these users as holding full owner
// access on a tenant where ReAI has narrowed the role. In an access audit that is the one direction
// that must not be wrong.
test("a user whose role has been NARROWED is not reported as owner-equivalent", async () => {
  const narrowedRoles = roles().map((r) =>
    r.code === "ROLE_ACCOUNTANT" ? { ...r, effectivePermissionCodes: OWNER_PERMS.slice(0, 30) } : r,
  );
  const { text } = await run(
    "reai_list_users",
    {},
    [
      user(),
      user({
        userId: 2,
        owner: false,
        roleCodes: ["ROLE_ACCOUNTANT"],
        effectivePermissionCodes: OWNER_PERMS.slice(0, 30),
      }),
    ],
    narrowedRoles,
  );
  assert.match(text, /1 hold everything ROLE_OWNER has/, "only the actual owner");
});

test("a direct grant can make a narrow role owner-equivalent, and is judged that way", async () => {
  // The other direction: the permissions decide, so ROLE_EMPLOYEE plus enough direct grants is
  // owner-equivalent however narrow the title sounds.
  const { text } = await run("reai_list_users", {}, [
    user(),
    user({
      userId: 2,
      owner: false,
      roleCodes: ["ROLE_EMPLOYEE"],
      directPermissionCodes: OWNER_PERMS.slice(0, 45),
      effectivePermissionCodes: OWNER_PERMS,
    }),
  ]);
  assert.match(text, /2 hold everything ROLE_OWNER has/);
});

test("an unreadable role list is reported as unknown, not as nobody", async () => {
  const { text } = await run("reai_list_users", {}, [user()], { roles: [] });
  assert.match(text, /could not be established/);
  assert.match(text, /Do not read that as "none do"/);
});

test("a non-list response is reported as unknown, never as an empty tenant", async () => {
  // For an access question, "nobody can reach this" derived from a shape surprise is the worst
  // possible wrong answer.
  for (const data of [null, {}, { users: [] }, "nope"]) {
    const { text } = await run("reai_list_users", {}, data);
    assert.match(text, /UNKNOWN/, JSON.stringify(data));
    assert.match(text, /do not read that as nobody/);
  }
});

test("an empty list is reported as empty, not as unknown", async () => {
  const { text } = await run("reai_list_users", {}, []);
  assert.match(text, /0 user\(s\) with access/);
  assert.ok(!/UNKNOWN/.test(text));
});

test("the role list computes the comparison against this tenant rather than quoting numbers", async () => {
  const { text } = await run("reai_list_roles", {}, roles());
  assert.match(text, /ROLE_TENANT_ADMIN — 51 permission\(s\), assignable, IDENTICAL to ROLE_OWNER/);
  assert.match(text, /ROLE_ACCOUNTANT — 51 permission\(s\), assignable, IDENTICAL to ROLE_OWNER/);
  assert.match(text, /ROLE_OWNER — 51 permission\(s\), NOT assignable/);
  assert.match(text, /ROLE_AUDITOR — 20 permission\(s\), assignable, 31 fewer/);
  assert.match(text, /ROLE_EMPLOYEE — 6 permission\(s\), assignable, 45 fewer/);
  assert.match(text, /2 ASSIGNABLE role\(s\) carry everything ROLE_OWNER has/);
  assert.match(text, /granting the company's books in full/);
});

test("a tenant whose roles genuinely differ is not told they are identical", async () => {
  // The claim has to come from the data. A hardcoded sentence would be wrong the moment ReAI
  // narrows ROLE_ACCOUNTANT, which is exactly the change this should survive.
  const narrowed = roles().map((r) =>
    r.code === "ROLE_ACCOUNTANT" ? { ...r, effectivePermissionCodes: OWNER_PERMS.slice(0, 30) } : r,
  );
  const { text } = await run("reai_list_roles", {}, narrowed);
  assert.match(text, /ROLE_ACCOUNTANT — 30 permission\(s\), assignable, 21 fewer than ROLE_OWNER/);
  assert.match(text, /1 ASSIGNABLE role\(s\) carry everything/);
  assert.ok(!/ROLE_ACCOUNTANT — 30 permission\(s\), assignable, IDENTICAL/.test(text));
});

test("the role list survives a response that is not a list", async () => {
  const { text } = await run("reai_list_roles", {}, { roles: [] });
  assert.match(text, /could not be compared/);
  assert.ok(!/IDENTICAL/.test(text));
});

test("one user's report names direct permissions and owner-equivalence", async () => {
  const { text } = await run("reai_get_user", { id: 2 }, user({
    userId: 2,
    roleCodes: ["ROLE_ACCOUNTANT"],
    directPermissionCodes: ["tenant:user:write"],
  }));
  assert.match(text, /OWNER-EQUIVALENT access/);
  assert.match(text, /Judged on the permissions themselves/);
  assert.match(text, /1 permission\(s\) are granted DIRECTLY/);
  assert.match(text, /tenant:user:write/);
  assert.match(text, /51 effective permission\(s\): 45 tenant-wide, 6 self-scoped/);
});

test("a narrow user is not described as owner-equivalent", async () => {
  const { text } = await run("reai_get_user", { id: 4 }, user({
    userId: 4,
    roleCodes: ["ROLE_EMPLOYEE"],
    effectivePermissionCodes: OWNER_PERMS.slice(45),
    owner: false,
  }));
  assert.ok(!/OWNER-EQUIVALENT/.test(text));
  assert.match(text, /6 effective permission\(s\): 0 tenant-wide, 6 self-scoped/);
});

test("a pending invitation is described as access not yet in use", async () => {
  const { text } = await run("reai_get_user", { id: 3 }, user({
    userId: 3,
    status: "pending_invitation",
    expiresAt: "2026-09-01",
    roleCodes: ["ROLE_AUDITOR"],
  }));
  assert.match(text, /unaccepted INVITATION, expiring 2026-09-01/);
  assert.match(text, /waiting to be claimed by whoever controls that mailbox/);
});

test("the permission catalogue reports its scope split", async () => {
  const { text } = await run("reai_list_permissions", {}, [
    { code: "tenant:user:read", groupName: "User", type: "View" },
    { code: "tenant:user:write", groupName: "User", type: "Edit" },
    { code: "self:expense:read", groupName: "Expense", type: "View" },
    { code: "tenant:expense:approve", groupName: "Expense", type: "Approve" },
  ]);
  assert.match(text, /in 2 group\(s\)/);
  assert.match(text, /View \/ Edit \/ Approve/);
  assert.match(text, /3 tenant-wide and 1 self-scoped/);
});

test("no pending invitations says so about invitations only", async () => {
  const { text } = await run("reai_list_user_invitations", {}, []);
  assert.match(text, /No pending invitations/);
  assert.match(text, /statement about invitations only/);
});

test("a pending invitation to an owner-equivalent role is counted", async () => {
  const { text } = await run("reai_list_user_invitations", {}, [
    user({ status: "pending_invitation", roleCodes: ["ROLE_ACCOUNTANT"] }),
    user({
      userId: 4,
      status: "pending_invitation",
      roleCodes: ["ROLE_EMPLOYEE"],
      effectivePermissionCodes: OWNER_PERMS.slice(45),
    }),
  ]);
  assert.match(text, /1 of them would grant everything ROLE_OWNER has/);
  assert.match(text, /judged on the permissions rather than the role title/);
});

// ok() caps the serialised body, not a caller-supplied note, so an unbounded summary built here
// could push the result past the limit the rest of the server holds itself to.
test("the pending-invitation summary is bounded, and says how many it left out", async () => {
  const many = Array.from({ length: 25 }, (_, i) =>
    user({
      userId: 100 + i,
      status: "pending_invitation",
      email: `invitee${i}@example.invalid`,
      roleCodes: ["ROLE_AUDITOR"],
      effectivePermissionCodes: OWNER_PERMS.slice(0, 20),
    }),
  );
  // reai_list_users is the one that enumerates them; the invitations tool only counts, so there is
  // nothing unbounded there.
  const { text } = await run("reai_list_users", {}, many);
  const note = text.split("\n\n").slice(0, 2).join("\n\n");
  assert.match(note, /and 15 more, listed in the body below/);
  assert.match(note, /invitee0@example.invalid/);
  assert.ok(!/invitee12@example.invalid/.test(note), "only the first ten belong in the note");
});

test("the role-equivalence quirk reaches the endpoints where it matters", () => {
  for (const [method, path] of [
    ["GET", "/api/users"],
    ["POST", "/api/users"],
    ["GET", "/api/users/roles"],
    ["GET", "/api/users/{id}"],
    // The last paragraph is specifically about this endpoint, and it was not attached to it — so
    // discovery on the catalogue published no warning that the self: codes are missing from it.
    ["GET", "/api/users/permissions"],
  ]) {
    assert.ok(
      quirksFor(method, path).some((q) => q.id === "three-roles-are-the-same-role"),
      `${method} ${path}`,
    );
  }
  const quirk = quirksFor("POST", "/api/users").find((q) => q.id === "three-roles-are-the-same-role");
  assert.match(quirk.note, /identical to OWNER/);
  assert.match(quirk.note, /not data but authority/);
  assert.match(quirk.note, /`self:` covers only/);
});

// Measured: the catalogue returns 45 codes and every one is tenant-scoped, while the owner's
// effective set is 51. The six self: codes appear on users and roles but are not published here, so
// "not in the catalogue" is not evidence that a code is invalid.
test("the catalogue's incompleteness is stated rather than left to surprise someone", () => {
  assert.match(tool("reai_list_permissions").description, /NOT the whole vocabulary/);
  assert.match(tool("reai_list_permissions").description, /simply not published/);
  const quirk = quirksFor("GET", "/api/users/roles").find((q) => q.id === "three-roles-are-the-same-role");
  assert.match(quirk.note, /does not list the self-scoped ones at all/);
});

// A role holding everything the owner has PLUS something else still carries the owner's access.
// Requiring equal set sizes was stricter than the question, and left a branch no fixture exercised.
test("a role with a superset of the owner's permissions counts as owner-equivalent", async () => {
  const withExtra = roles().map((r) =>
    r.code === "ROLE_ACCOUNTANT"
      ? { ...r, effectivePermissionCodes: [...OWNER_PERMS, "tenant:something:new"] }
      : r,
  );
  // The fallback path: a user with no effective list of its own, judged by role code.
  const { text } = await run(
    "reai_list_users",
    {},
    [user({ userId: 2, owner: false, roleCodes: ["ROLE_ACCOUNTANT"], effectivePermissionCodes: [] })],
    withExtra,
  );
  assert.match(text, /1 hold everything ROLE_OWNER has/);
  assert.match(text, /ROLE_ACCOUNTANT/);
});

test("the role-code fallback does not flag a narrow role as owner-equivalent", async () => {
  // Exercises the other side of the fallback: with no effective permission list on the row, the
  // role code decides — and ROLE_EMPLOYEE must not qualify. Without this, a mutation making every
  // role count as owner-equivalent changed no test.
  const { text } = await run("reai_list_users", {}, [
    user({ userId: 2, owner: false, roleCodes: ["ROLE_EMPLOYEE"], effectivePermissionCodes: [] }),
    user({ userId: 3, owner: false, roleCodes: ["ROLE_AUDITOR"], effectivePermissionCodes: [] }),
  ]);
  assert.match(text, /0 hold everything ROLE_OWNER has/);
});
