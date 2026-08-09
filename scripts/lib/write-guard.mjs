/**
 * The one check that decides whether a script may write to a ReAI tenant.
 *
 * ## Why this exists as its own module
 *
 * There were four copies of this logic — `smoke-write.mjs`, `smoke-full-write.mjs`, `audit-storage.mjs`,
 * `audit-messages.mjs` — and all four implemented the same thing: read `REAI_WRITE_TEST_TENANTS`, and refuse
 * if `--tenant` is not in it. That is a **consistency check between two values the operator supplies**, not a
 * protection of anything. Set both to the same wrong number and every one of them proceeds.
 *
 * Which is exactly the incident this repository already had: a full-write test ran against tenant 2634, a real
 * business's books, because the intended test tenant was unreachable and the operator pointed the run
 * somewhere else. The books were restored — 37 vouchers, 84 postings, no MV-number gap — but the guard that
 * was supposed to prevent it had agreed with the mistake.
 *
 * Measured 2026-08-09, before this module existed. With `REAI_WRITE_TEST_TENANTS=2634 --tenant 2634` against a
 * local server mimicking `/api/me`, all three runnable write scripts sailed through and attempted:
 *
 *   POST /api/customers      PATCH /api/customers/{id}
 *   POST /api/suppliers      PATCH /api/suppliers/{id}
 *   POST /api/warehouses     PUT   /api/warehouses/{id}
 *   POST /api/subscriptions  POST  /api/agreements/rent-agreement
 *
 * So the allowlist is kept — it catches the ordinary typo — and a **denylist that no environment variable can
 * override** is added underneath it. One misremembered number can no longer reach real books.
 *
 * ## Why the denylist is hard-coded
 *
 * Because the thing that failed was an environment variable, and an override would reintroduce it. There is
 * deliberately no `REAI_ALLOW_PROTECTED_TENANT` escape hatch: if a tenant in this list ever genuinely needs to
 * be written to, that is a code change, on a branch, in a diff someone reads.
 *
 * `2634` is not a general fact about ReAI — it is this repository's operator's own company, and its id is
 * already all over these scripts' comments and quirk notes. Anyone self-hosting should put their own
 * production tenants here; the list is the point, not the number.
 */

/**
 * Tenants that may never be written to, whatever the environment says.
 *
 * Numbers, and compared numerically, so `"2634"`, `" 2634"` and `2634` are all the same tenant. A
 * string-equality version of this check would be bypassed by a stray space.
 */
export const PROTECTED_TENANTS = new Set([2634]);

/** Parsed `REAI_WRITE_TEST_TENANTS`, for messages and for the allowlist check. */
export function declaredTestTenants(env = process.env) {
  return (env.REAI_WRITE_TEST_TENANTS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Throws unless `tenantId` may be written to. Returns nothing on success.
 *
 * Order matters: the PROTECTED check runs first, so a protected tenant is refused with the reason that
 * actually applies rather than "not in the allowlist", which an operator would immediately try to fix by
 * adding it to the allowlist.
 */
export function assertWritableTenant(tenantId, { env = process.env, scriptName = "this script" } = {}) {
  const id = Number(tenantId);
  if (!Number.isInteger(id)) {
    throw new Error(`Refusing to write: ${JSON.stringify(tenantId)} is not a tenant id.`);
  }

  if (PROTECTED_TENANTS.has(id)) {
    throw new Error(
      `Refusing to write to tenant ${id}: it is on the PROTECTED list in scripts/lib/write-guard.mjs, ` +
        `which no environment variable can override.\n\n` +
        `This tenant holds a real business's books. A full-write test reached it once already, because the ` +
        `only guard was that REAI_WRITE_TEST_TENANTS and --tenant agreed with each other — and they agreed ` +
        `on the wrong number.\n\n` +
        `If you genuinely need to write here, change PROTECTED_TENANTS in a commit someone can read. Do not ` +
        `add a flag.`,
    );
  }

  const declared = declaredTestTenants(env);
  if (declared.length === 0) {
    throw new Error(
      `REAI_WRITE_TEST_TENANTS is not set.\n\n` +
        `${scriptName} writes to the API, so it runs only against a tenant declared safe to write to:\n\n` +
        `  REAI_WRITE_TEST_TENANTS=2783 node ${scriptName} --tenant 2783\n\n` +
        `Do not list a tenant that holds a real business's books.`,
    );
  }
  if (!declared.map(Number).includes(id)) {
    throw new Error(
      `Refusing to write to tenant ${id}: it is not in REAI_WRITE_TEST_TENANTS (${declared.join(", ")}).`,
    );
  }
}

/**
 * The same check, for a script's top level: prints the reason and exits 2 rather than throwing a stack trace
 * at someone who mistyped a tenant id.
 */
export function requireWritableTenant(tenantId, opts) {
  try {
    assertWritableTenant(tenantId, opts);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}

/**
 * The tenant the token ACTUALLY reaches, read from the structured `/api/me` list.
 *
 * A token scoped to a single tenant IGNORES `X-Tenant-Id` and answers for its own tenant whatever value is
 * sent. So the allowlist and the denylist both check a number on the command line, and neither can tell you
 * where a write will land. This can.
 *
 * The version this replaces read `reai_whoami`'s PROSE and harvested every four-digit number from it:
 *
 *     const reachable = [...textOf(whoami).matchAll(/\b(\d{4,})\b/g)].map(Number);
 *
 * `src/tools/meta.ts` emits "Active tenant is set to 2783, but that id is NOT in this token's tenant list"
 * when the id is absent — so the warning that the tenant is unreachable contained the number that made it look
 * reachable, and `--tenant 2783` on a token scoped to 2634 passed the check and wrote to 2634. Found by review
 * on PR #130. Parse the list, never the sentence.
 */
export async function reachableTenants({ token, baseUrl = "https://app.reai.no", timeoutMs = 30_000 } = {}) {
  const res = await fetch(`${baseUrl}/api/me`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status !== 200) {
    throw new Error(`Could not read /api/me to confirm which tenants this token reaches (HTTP ${res.status}).`);
  }
  const body = await res.json();
  const list = body?.tenants;
  if (!Array.isArray(list)) {
    // Not "assume it is fine": an unrecognised shape means the check did not happen.
    throw new Error(
      `/api/me returned no \`tenants\` array (keys: ${Object.keys(body ?? {}).join(", ") || "none"}), so which ` +
        `tenants this token reaches could not be established. Refusing to write.`,
    );
  }
  return list.map((t) => Number(t.id)).filter(Number.isInteger);
}

/**
 * Refuses unless the token reaches `tenantId` AND reaches no protected tenant that a single-tenant token
 * would silently redirect to. Call this before any write, in addition to `requireWritableTenant`.
 */
export async function requireTokenReachesTenant(tenantId, opts) {
  let reachable;
  try {
    reachable = await reachableTenants(opts);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  const id = Number(tenantId);
  if (!reachable.includes(id)) {
    console.error(
      `Refusing to write: the token does not reach tenant ${id}.\n` +
        `/api/me reports ${reachable.join(", ") || "(none)"}.\n\n` +
        `A token scoped to a single tenant IGNORES X-Tenant-Id, so this run would have written to ` +
        `${reachable[0] ?? "another company"} while --tenant said ${id}.`,
    );
    process.exit(2);
  }
  // The case the number-based guards cannot see: one reachable tenant, and it is protected. Then every write
  // lands there regardless of --tenant.
  if (reachable.length === 1 && PROTECTED_TENANTS.has(reachable[0])) {
    console.error(
      `Refusing to write: this token reaches only tenant ${reachable[0]}, which is PROTECTED. A single-tenant ` +
        `token ignores X-Tenant-Id, so every write would land there whatever --tenant says.`,
    );
    process.exit(2);
  }
}
