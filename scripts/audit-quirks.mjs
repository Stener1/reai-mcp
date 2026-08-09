#!/usr/bin/env node
/**
 * Are the quirks this server SERVES still true of the live API?
 *
 * A quirk reaches an agent through `reai_describe_endpoint` and `reai_api_notes`. When one goes stale the
 * agent is told something false by the server that is supposed to know better, and nothing fails. That is
 * not hypothetical: PR #115 corrected two quirks measured false (agents were told a `+47` prefix is
 * rejected on a supplier phone, and that foreign numbers are stored as sent), and PR #123 corrected four
 * places claiming the agreement enums are undocumented when the document declares all fourteen.
 *
 * Two live audits already existed, and between them they named **2 of the 122 quirks**:
 * `tenant-header-ignored-single-tenant` and `customer-name-title-cased`. That 2, and the 122, are exact.
 *
 * How many of the remaining 120 assert something an API call could check is NOT exact, and the number is
 * deliberately not quoted here. A keyword sweep over `note` prose returns 86 or 95 depending on the word
 * list, which makes it a lower bound dressed as a measurement — the false precision `storage-drift` was
 * corrected for, and which its census script prints rather than asserts for the same reason. The exact,
 * checkable statement is the one that matters: 2 were named, this adds 8, and 114 remain unnamed.
 *
 * This closes the read-only part of that gap. Every request below is a GET, so it runs against any tenant
 * the token reaches, which is why there is no write guard and no `REAI_WRITE_TEST_TENANTS`: nothing here
 * can create, update or delete. `test/quirk-drift.test.mjs` asserts that offline, against the same policy
 * engine the server enforces with.
 *
 * ## Probe the request the note describes, not a shorter one
 *
 * The `timesheets-need-project-module` case is why this warning is at the top. The note predicts 400
 * "projectId cannot be used when the Project module is disabled". A first version of this audit sent
 * `GET /api/timesheets?projectId=1`, got 400 "startDate is required", and was about to report the quirk as
 * DRIFT. The quirk is correct. Validation is ORDERED — startDate, then projectId, then the module check —
 * so an under-specified request never reaches the layer the claim is about, and measures a different one.
 *
 * The general form: a probe that sends less than a valid request tests the first validator that trips, and
 * a claim about anything deeper is then reported false on evidence that never touched it. Where a case
 * depends on that ordering it now sends the full valid request and says so.
 *
 * ## Three outcomes, and the middle one is the point
 *
 *   OK            the claim still holds
 *   DRIFT         the API answers differently, so the quirk is misinformation an agent reads
 *   INCONCLUSIVE  this tenant cannot answer the question
 *
 * INCONCLUSIVE exists because both alternatives are worse. Some claims are conditional on tenant state — a
 * 404 meaning "nothing set up yet" is indistinguishable from drift on a tenant that HAS set it up — and
 * calling those OK inflates the pass count while calling them DRIFT cries wolf. Each one says what would
 * answer it.
 *
 * An UNEXPECTED inconclusive exits **3**, matching `audit-storage.mjs`, for the reason recorded in
 * `docs/development.md`: a claim nobody checked is not a claim that held, and "7 of 8" printed next to a
 * zero exit code reads as a pass. But one case here is inconclusive *by construction* — the tenant-header
 * claim is conditional on a token reaching exactly one tenant, and ours reaches four, so it can never be
 * answered from this repository's credentials. Failing the run forever on that would train everyone to
 * ignore the exit code, which is worse than either. So a case may declare `conditional:` with the reason,
 * and only cases WITHOUT that declaration affect the exit status. The test asserts the reason is stated
 * rather than left as a shrug.
 *
 * ## What this cannot reach
 *
 * Write behaviour: what the API stores, normalises or refuses on a POST. `audit-storage.mjs` covers 17 such
 * claims and `audit-messages.mjs` nine refusals. The rest of the 84 stay unchecked, and any needing a write
 * needs the test tenant.
 *
 * Usage:
 *   REAI_USER_API_TOKEN=… node scripts/audit-quirks.mjs --tenant 2634
 */

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const args = process.argv.slice(2);
const at = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const tenantId = Number(at("--tenant"));
const token = process.env.REAI_USER_API_TOKEN;
const baseUrl = process.env.REAI_BASE_URL ?? "https://app.reai.no";
const TIMEOUT_MS = 30_000;

if (!token) {
  console.error("REAI_USER_API_TOKEN is not set.");
  process.exit(2);
}
if (!Number.isInteger(tenantId)) {
  console.error("Pass --tenant <id>. Every request here is a GET, so any tenant the token reaches will do.");
  process.exit(2);
}

/** The only request this file can make. Named `get` so a write is a syntax error away, not a flag away. */
const get = async (path, { omitTenant = false } = {}) => {
  const res = await fetch(baseUrl + path, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(omitTenant ? {} : { "X-Tenant-Id": String(tenantId) }),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
};

/** Whatever the API used to carry the error text. */
const detailOf = (r) => {
  const b = r.body ?? {};
  return String(b.detail ?? b.message ?? b.title ?? (typeof b === "string" ? b : JSON.stringify(b) ?? ""));
};

const keysOf = (body) => (Array.isArray(body) ? ["ARRAY"] : Object.keys(body ?? {}));

/** Set comparison, because these claims enumerate a wrapper exactly and an extra key is drift too. */
const sameKeys = (got, want) =>
  got.length === want.length && want.every((k) => got.includes(k)) && got.every((k) => want.includes(k));

const DATES = "startDate=2026-01-01&endDate=2026-08-01";

/**
 * `quirk` names the id, so a DRIFT line points at the text to correct rather than at a symptom.
 * `marker` is a phrase from that quirk's note which predicts what the probe measures — the offline test
 * asserts it is still present, so editing the note to mean something else fails CI here rather than
 * leaving a probe silently checking a claim nobody makes any more. `check` returns
 * ["ok" | "drift" | "inconclusive", sentence].
 */
const CASES = [
  {
    quirk: "date-range-required",
    claim: "startDate and endDate are required on GET /api/vouchers even though the schema does not say so",
    marker: 'Omitting them returns 400 "startDate is required"',
    async check() {
      const bare = await get("/api/vouchers");
      if (bare.status === 200) return ["drift", "no date range answered 200; the quirk says it is a 400"];
      if (bare.status !== 400) return ["inconclusive", `expected 400, got ${bare.status}`];
      const detail = detailOf(bare);
      if (!/startdate is required/i.test(detail)) {
        return ["drift", `400 but the detail is now "${detail.slice(0, 90)}"`];
      }
      // The claim is that the range is required, so the range must also make it pass.
      const withRange = await get(`/api/vouchers?${DATES}`);
      return withRange.status === 200
        ? ["ok", `400 "${detail}" without the range, 200 with it`]
        : ["drift", `the range does not satisfy it either: ${withRange.status} ${detailOf(withRange).slice(0, 70)}`];
    },
  },
  {
    quirk: "leads-paginated-object",
    claim: "the three lead collections return three DIFFERENT wrappers, none of them a bare array",
    marker: "{ items, page, hasPrevious, hasNext, latestRegisteredAt }",
    async check() {
      // The note enumerates all three, so all three are checked — the hazard it warns about is assuming
      // they share a shape, which a probe of one endpoint cannot see.
      const want = {
        "/api/leads": ["items", "page", "hasPrevious", "hasNext", "latestRegisteredAt"],
        "/api/leads/person-profiles": ["items", "hasMore", "nextStartOrgNo", "limit"],
        "/api/leads/person-role-matches?linkedinSlug=nobody-xyz": ["matched", "companyMatched", "items"],
      };
      const seen = [];
      for (const [path, expected] of Object.entries(want)) {
        const r = await get(path);
        if (r.status === 403) return ["inconclusive", `${path} answered 403 — the Leads module is off here`];
        if (r.status !== 200) return ["inconclusive", `${path} answered ${r.status}`];
        const got = keysOf(r.body);
        if (!sameKeys(got, expected)) {
          return ["drift", `${path} is now { ${got.join(", ")} }, not { ${expected.join(", ")} }`];
        }
        seen.push(`${path.split("?")[0]} { ${got.join(", ")} }`);
      }
      return ["ok", seen.join("; ")];
    },
  },
  {
    quirk: "person-role-matches-shape",
    claim: "it needs linkedinSlug, refuses without it, and returns no paging fields at all",
    marker: 'omitting it returns a bare 400 "Validation failed" that names nothing',
    async check() {
      const bare = await get("/api/leads/person-role-matches");
      if (bare.status === 200) return ["drift", "linkedinSlug is no longer required — it answered 200"];
      if (bare.status !== 400) return ["inconclusive", `omitting linkedinSlug gave ${bare.status}`];
      const detail = detailOf(bare);
      if (!/validation failed/i.test(detail)) {
        return ["drift", `the 400 now reads "${detail.slice(0, 90)}"`];
      }
      // "names nothing" is half the claim: the point is the agent cannot learn WHICH parameter is missing.
      if (/linkedin/i.test(detail)) {
        return ["drift", `the 400 now names the parameter ("${detail.slice(0, 90)}") — the quirk says it does not`];
      }
      const ok = await get("/api/leads/person-role-matches?linkedinSlug=nobody-xyz");
      if (ok.status !== 200) return ["inconclusive", `with linkedinSlug it answered ${ok.status}`];
      const got = keysOf(ok.body);
      const paging = got.filter((k) => /^(page|hasNext|hasMore|nextStartOrgNo|limit)$/.test(k));
      if (paging.length > 0) return ["drift", `it carries paging fields now: ${paging.join(", ")}`];
      return sameKeys(got, ["matched", "companyMatched", "items"])
        ? ["ok", `400 "${detail}" bare; { ${got.join(", ")} } with the slug`]
        : ["drift", `shape is now { ${got.join(", ")} }`];
    },
  },
  {
    quirk: "warehouse-inventory-object",
    claim: "GET /api/warehouses/inventory returns { warehouseId, rows, totalStockValue, totalRetailValue }",
    marker: "the two totals are already computed",
    async check() {
      const r = await get("/api/warehouses/inventory");
      if (r.status === 403) return ["inconclusive", "403 — the Warehouse module is off on this tenant"];
      if (r.status !== 200) return ["inconclusive", `answered ${r.status} — ${detailOf(r).slice(0, 70)}`];
      const got = keysOf(r.body);
      if (!sameKeys(got, ["warehouseId", "rows", "totalStockValue", "totalRetailValue"])) {
        return ["drift", `it is now { ${got.join(", ")} }`];
      }
      // The advice is "do not sum rows, the totals are there", so the totals must actually be present.
      const totals = ["totalStockValue", "totalRetailValue"].filter((k) => r.body[k] == null);
      return totals.length === 0
        ? ["ok", `{ ${got.join(", ")} }, both totals populated`]
        : ["drift", `${totals.join(" and ")} came back null, so summing rows would be the only option`];
    },
  },
  {
    quirk: "empty-state-is-404",
    claim: "a 404 on these means nothing has been set up yet, and the detail says so in words",
    marker: '"No annual-accounts submission exists for fiscal year 2025"',
    async check() {
      // Both details the note quotes, because the claim is that the WORDING carries the meaning.
      const cases = [
        ["/api/opening-balances", /opening balance not found/i],
        ["/api/annual-accounts/2025", /no annual-accounts submission exists for fiscal year 2025/i],
      ];
      const seen = [];
      let answered = 0;
      for (const [path, expected] of cases) {
        const r = await get(path);
        if (r.status === 200) {
          seen.push(`${path} answered 200 — this tenant HAS one, so its empty state is untestable here`);
          continue;
        }
        if (r.status !== 404) {
          return ["drift", `${path} answered ${r.status}, not 404 — ${detailOf(r).slice(0, 70)}`];
        }
        const detail = detailOf(r);
        if (!expected.test(detail)) {
          return ["drift", `${path} 404s with "${detail.slice(0, 90)}", which no longer explains itself`];
        }
        answered += 1;
        seen.push(`${path} 404 "${detail}"`);
      }
      return answered === 0
        ? ["inconclusive", seen.join("; ")]
        : ["ok", seen.join("; ")];
    },
  },
  {
    quirk: "module-gating",
    claim: "a 403 is a disabled MODULE and the detail names it; share-investments is the empty-body exception",
    marker: 'the detail reads like "Project module is disabled"',
    async check() {
      const projects = await get("/api/projects");
      if (projects.status === 200) {
        return ["inconclusive", "the Project module is ON here, so there is no 403 to read the wording of"];
      }
      if (projects.status !== 403) return ["inconclusive", `/api/projects answered ${projects.status}`];
      const detail = detailOf(projects);
      if (!/module/i.test(detail)) {
        return ["drift", `403 but the detail does not mention a module: "${detail.slice(0, 90)}"`];
      }
      // The note was corrected on 2026-08-08 to say share investments are NOT gated on these tenants —
      // a conditional, so it is the half most likely to rot. If it 403s again the note is stale.
      const shares = await get("/api/share-investments");
      if (shares.status === 403) {
        return [
          "drift",
          `/api/share-investments is 403 again; the note says it was re-measured to 200 with an empty list`,
        ];
      }
      return ["ok", `/api/projects 403 "${detail}"; /api/share-investments ${shares.status} as re-measured`];
    },
  },
  {
    quirk: "timesheets-need-project-module",
    claim: "projectId is required AND rejected at once, so no request succeeds without the module",
    marker: '400 "projectId cannot be used when the Project module is disabled"',
    async check() {
      // A FULL request. Sending only projectId trips the date validator first and measures nothing about
      // the module — see the note at the top of this file.
      const withProject = await get(`/api/timesheets?projectId=1&${DATES}`);
      if (withProject.status === 200) {
        return ["inconclusive", "it succeeded, so the Project module is enabled on this tenant"];
      }
      const detail = detailOf(withProject);
      if (!/projectid cannot be used when the project module is disabled/i.test(detail)) {
        return [
          "drift",
          `a valid request now answers ${withProject.status} "${detail.slice(0, 90)}" rather than the ` +
            `message the quirk tells agents to stop on`,
        ];
      }
      // The other half: it is REQUIRED. Both must hold, or "required and rejected at once" is wrong.
      const without = await get(`/api/timesheets?${DATES}`);
      return /projectid is required/i.test(detailOf(without))
        ? ["ok", `required ("${detailOf(without)}") and rejected ("${detail}")`]
        : ["drift", `it is no longer required: ${without.status} "${detailOf(without).slice(0, 70)}"`];
    },
  },
  {
    quirk: "tenant-header-ignored-single-tenant",
    claim: "with a token reaching exactly ONE tenant, X-Tenant-Id is ignored",
    marker: "X-Tenant-Id is IGNORED",
    // Not answerable from here, and not a gap to be closed by trying harder: verifying it needs a token
    // scoped to ONE tenant, and the only token this repository has reaches four. Left in because the
    // claim is load-bearing — the write scripts' tenant guard exists because of it — so its absence from
    // the checked set should be visible rather than silently missing.
    conditional: "needs a single-tenant token; ours reaches four",
    async check() {
      const me = await get("/api/me", { omitTenant: true });
      if (me.status !== 200) return ["inconclusive", `GET /api/me answered ${me.status}`];
      const companies = me.body?.companies ?? me.body?.tenants ?? [];
      if (companies.length !== 1) {
        return [
          "inconclusive",
          `this token reaches ${companies.length} tenants (${companies.map((c) => c.id).join(", ")}) and the ` +
            `claim is conditional on reaching exactly one, so it cannot be tested from here. Worth stating ` +
            `rather than hiding: the tenant guard in the write scripts assumes the opposite case, and this ` +
            `is the token that makes that guard necessary`,
        ];
      }
      const other = await get("/api/me");
      return other.status === 200
        ? ["ok", `single-tenant token (${companies[0].id}); the header did not change the answer`]
        : ["drift", `the header now produces ${other.status} rather than being ignored`];
    },
  },
];

async function main() {
  // Resolved against the registry so a renamed or deleted quirk fails loudly instead of being "checked".
  const { QUIRKS } = await import(pathToFileURL(join(process.cwd(), "dist/reai/quirks.js")).href);
  const known = new Map(QUIRKS.map((q) => [q.id, q]));
  const unknown = CASES.map((c) => c.quirk).filter((id) => !known.has(id));
  if (unknown.length > 0) {
    console.error(`These cases name quirks that no longer exist: ${unknown.join(", ")}`);
    process.exit(2);
  }

  console.log(`Checking ${CASES.length} read-only quirk claims against tenant ${tenantId}.`);
  console.log(`(${QUIRKS.length} quirks exist; this covers the subset a GET can answer.)\n`);

  const tally = { ok: 0, drift: 0, inconclusive: 0 };
  const unexpected = [];
  for (const c of CASES) {
    let outcome;
    let note;
    try {
      [outcome, note] = await c.check();
    } catch (err) {
      outcome = "inconclusive";
      note = `the probe threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    tally[outcome] += 1;
    if (outcome === "inconclusive" && !c.conditional) unexpected.push(`${c.quirk}: ${note}`);
    const label = outcome === "ok" ? "OK   " : outcome === "drift" ? "DRIFT" : "?????";
    console.log(`${label}  ${c.quirk}${outcome === "inconclusive" && c.conditional ? " (conditional)" : ""}`);
    console.log(`       ${c.claim}`);
    console.log(`       ${note}`);
  }

  const conditional = CASES.filter((c) => c.conditional).length;
  console.log(
    `\n${tally.ok} unchanged, ${tally.drift} drifted, ${tally.inconclusive} inconclusive (of ${CASES.length}` +
      `${conditional > 0 ? `, ${conditional} of which cannot be answered by any tenant on this token` : ""})`,
  );
  if (tally.drift > 0) {
    console.log(
      `\nA drifted quirk is text an agent READS through reai_describe_endpoint. Correct the note in ` +
        `src/reai/quirks.ts — and check the probe sent a full valid request before believing it.`,
    );
    process.exit(1);
  }
  if (unexpected.length > 0) {
    console.log(
      `\n${unexpected.length} claim(s) could not be checked, and none of them declared itself conditional, ` +
        `so this run does NOT say those quirks held:\n  ${unexpected.join("\n  ")}`,
    );
    process.exit(3);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
