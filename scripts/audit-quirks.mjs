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
 * DRIFT. The quirk is correct: validation is ORDERED, so an under-specified request never reaches the layer
 * the claim is about and measures a different one.
 *
 * The order, MEASURED 2026-08-09 rather than inferred — an earlier version of this comment asserted
 * "startDate, then projectId" from one response and had those two backwards:
 *
 *   (nothing)              400 "projectId is required"
 *   dates only             400 "projectId is required"
 *   projectId only         400 "startDate is required"
 *   projectId + startDate  400 "endDate is required"
 *   all three              400 "projectId cannot be used when the Project module is disabled"
 *
 * The general form: a probe that sends less than a valid request tests the first validator that trips, and
 * a claim about anything deeper is then reported false on evidence that never touched it. Where a case
 * depends on that ordering it now sends the full valid request and says so.
 *
 * ## Probe every path the quirk is SERVED for, not the convenient one
 *
 * The same failure by another route, and the first version of this file had it twice. A quirk carries a
 * `paths` list and `quirksFor()` serves it for every entry — so verifying `date-range-required` against
 * `/api/vouchers` alone left it asserted for `/api/postings` and the nine `/api/ledger/*` endpoints on no
 * evidence, and `module-gating` was checked on two of the five paths it declares. Each case now declares
 * `probes`, and `test/quirk-drift.test.mjs` fails unless those cover every path the quirk itself declares.
 * Adding a path to a quirk therefore breaks the build until the audit probes it.
 *
 * `paths` entries can be PREFIXES: `/api/ledger` is not an endpoint — it 404s "No static resource" — it
 * matches the nine real `/api/ledger/*` operations. So a probe covers a declared path by equalling it or by
 * sitting beneath it, and a prefix needs a concrete endpoint standing in for it.
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

/**
 * The only request this file makes, and the place read-only is actually ENFORCED.
 *
 * The first version relied on the method being a literal in the source plus a test that grepped for it.
 * Review broke that in one line: keep `method: "GET"` and add `...EXTRA` after it, where EXTRA computes
 * `{ method: "POST" }` — the audit then issued real POSTs to /api/vouchers and /api/opening-balances with
 * all nine guard tests green. The same review showed the classification assertion was tautological:
 * `classifyRequest("GET", anything)` returns "read" by an early return in policy.ts, so it could not fail
 * for any path.
 *
 * So the init object is built first and CHECKED at runtime, after every spread and override has been
 * applied. A source edit that overrides the method now throws before the socket opens, instead of being
 * argued about in a test. That matters more than the usual defence-in-depth line, because read-only is the
 * entire reason this file may run against a real company's books.
 */
const request = async (path, { omitTenant = false, tenantOverride } = {}) => {
  const init = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      // tenantOverride exists for one claim: that a single-tenant token IGNORES this header, which cannot
      // be shown by sending the tenant the token already resolves to.
      ...(omitTenant ? {} : { "X-Tenant-Id": String(tenantOverride ?? tenantId) }),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  if (init.method !== "GET") {
    throw new Error(
      `audit-quirks may only issue GET; something set method=${init.method}. This audit runs against real ` +
        `books and nothing here is permitted to write.`,
    );
  }
  const res = await fetch(baseUrl + path, init);
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
};

const get = request;

/**
 * Whatever the API used to carry the error text, and "" when it carried none.
 *
 * It used to fall back to `JSON.stringify(body ?? {})`, which turned an EMPTY body into the string "{}".
 * That is truthy, so `module-gating`'s `!detail` branch — the one recognising the empty-body 403 the note
 * documents — was unreachable, and an empty-body 403 was reported as drift for "not naming a module".
 */
const detailOf = (r) => {
  const b = r.body;
  if (b == null) return "";
  if (typeof b === "string") return b;
  const text = b.detail ?? b.message ?? b.title;
  return text == null ? "" : String(text);
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
    claim: "the collections 400 without a date range, and the schema marks it required (both halves)",
    marker: 'omitting them returns 400 "startDate is required"',
    probes: ["/api/vouchers", "/api/postings", "/api/ledger/general"],
    // The quirk uses `match: "descendants"`, so it is served on fourteen operations. /api/ledger/general
    // stands in for the eight-strong ledger family: all five collections were measured directly (asset,
    // customer, employee, supplier, general — each 400 bare, 200 with the range) and all eight mark both
    // parameters required in the pinned spec, which the schema half above checks. Disclosed in the report
    // rather than silently treated as coverage.
    samples: ["/api/ledger"],
    // Where the claim is FALSE. Measured on 2634: both answer 200 with no date range, because they are
    // single-resource and grouping endpoints rather than the dated collections. They are named in the note,
    // which is what an agent describing them actually reads.
    exceptions: ["/api/vouchers/{id}", "/api/postings/groups", "/api/postings/groups/{postingGroupId}"],
    async check() {
      // The SCHEMA half, checked against the pinned spec rather than the live API — because this quirk
      // used to claim the opposite and nothing noticed. Its note said the dates are required "even where
      // the schema does not mark them so", while every collection marks both required and
      // test/spec.test.mjs asserts it for /api/vouchers. Review of PR #128 caught it; the note is corrected,
      // and this is here so the schema half cannot rot the way the note did.
      const { getSpecIndex } = await import(pathToFileURL(join(process.cwd(), "dist/reai/spec.js")).href);
      const ops = getSpecIndex().operations;
      const unmarked = [];
      for (const path of this.probes) {
        const op = ops.find((o) => o.method === "GET" && o.path === path);
        if (!op) return ["inconclusive", `${path} is not in the pinned spec, so its schema cannot be read`];
        const required = (op.params ?? [])
          .filter((a) => /^(startDate|endDate)$/.test(a.name) && a.required)
          .map((a) => a.name);
        if (required.length !== 2) unmarked.push(`${path} marks only [${required.join(", ")}]`);
      }
      if (unmarked.length > 0) {
        return [
          "drift",
          `the note says the schema marks both required, but ${unmarked.join("; ")} — correct the note`,
        ];
      }

      const seen = [];
      for (const path of this.probes) {
        const bare = await get(path);
        if (bare.status === 200) return ["drift", `${path} answered 200 with no date range`];
        if (bare.status !== 400) return ["inconclusive", `${path} answered ${bare.status}, expected 400`];
        const detail = detailOf(bare);
        if (!/startdate is required/i.test(detail)) {
          return ["drift", `${path} 400s with "${detail.slice(0, 80)}" instead`];
        }
        // The claim is that the range is what is missing, so supplying it must also make the call pass.
        const withRange = await get(`${path}?${DATES}`);
        if (withRange.status !== 200) {
          return [
            "drift",
            `${path}: the range does not satisfy it either — ${withRange.status} ${detailOf(withRange).slice(0, 60)}`,
          ];
        }
        seen.push(path);
      }
      return [
        "ok",
        `schema marks both required, and live: 400 "startDate is required" bare / 200 with the range on ` +
          seen.join(", "),
      ];
    },
  },
  {
    quirk: "leads-paginated-object",
    claim: "the three lead collections return three DIFFERENT wrappers, none of them a bare array",
    marker: "{ items, page, hasPrevious, hasNext, latestRegisteredAt }",
    conditional: "needs the Leads module ENABLED; where it is off every wrapper is a 403 instead",
    probes: ["/api/leads", "/api/leads/person-profiles", "/api/leads/person-role-matches"],
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
        if (r.status === 403) return ["conditional", `${path} answered 403 — the Leads module is off here`];
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
    probes: ["/api/leads/person-role-matches"],
    async check() {
      const bare = await get("/api/leads/person-role-matches");
      if (bare.status === 200) return ["drift", "linkedinSlug is no longer required — it answered 200"];
      if (bare.status !== 400) return ["inconclusive", `omitting linkedinSlug gave ${bare.status}`];
      const detail = detailOf(bare);
      if (!/validation failed/i.test(detail)) {
        return ["drift", `the 400 now reads "${detail.slice(0, 90)}"`];
      }
      // "names nothing" is half the claim, and it is a claim about the WHOLE body. Checking only the field
      // detailOf happened to pick would report OK on `{ detail: "Validation failed", fieldErrors: [{ field:
      // "linkedinSlug" }] }` — a body that DOES name the parameter, making the quirk stale.
      const whole = JSON.stringify(bare.body ?? "");
      if (/linkedin/i.test(whole)) {
        return ["drift", `the 400 body now names the parameter, so the quirk is stale: ${whole.slice(0, 120)}`];
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
    conditional: "needs the Warehouse module ENABLED; where it is off there is no inventory object to shape",
    probes: ["/api/warehouses/inventory"],
    async check() {
      const r = await get("/api/warehouses/inventory");
      if (r.status === 403) return ["conditional", "403 — the Warehouse module is off on this tenant"];
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
    marker: "A 404 here means NOTHING HAS BEEN SET UP YET",
    probes: ["/api/opening-balances", "/api/annual-accounts/1997"],
    async check() {
      // Both details the note quotes, because the claim is that the WORDING carries the meaning.
      // 1997 rather than 2025: 2634 is a real company that will plausibly file 2025, and the moment it does
      // this case loses a probe and (under the both-must-answer rule below) goes inconclusive forever. A
      // fiscal year before the company existed can never be filed, so the empty state stays observable.
      const cases = [
        ["/api/opening-balances", /opening balance not found/i],
        ["/api/annual-accounts/1997", /no annual-accounts submission exists for fiscal year 1997/i],
      ];
      const seen = [];
      const untested = [];
      for (const [path, expected] of cases) {
        const r = await get(path);
        if (r.status === 200) {
          untested.push(path);
          seen.push(`${path} answered 200 — this tenant HAS one, so its empty state is untestable here`);
          continue;
        }
        if (r.status !== 404) {
          // A 403 here is a real documented state (quirks.ts records one that already caused a bug) and a 500
          // is an outage. Neither is evidence about what a 404 MEANS, and reporting drift for them turns a
          // known tenant condition into "the quirk is wrong".
          return [
            "inconclusive",
            `${path} answered ${r.status} — ${detailOf(r).slice(0, 60) || "(no detail)"} — which says nothing ` +
              `about the 404 wording this claim is about`,
          ];
        }
        const detail = detailOf(r);
        if (!expected.test(detail)) {
          return ["drift", `${path} 404s with "${detail.slice(0, 90)}", which no longer explains itself`];
        }
        seen.push(`${path} 404 "${detail}"`);
      }
      // OK only when EVERY path answered. A first version returned OK as soon as one did, leaving the other
      // path's 404 wording asserted to agents and unmeasured — the fragment problem again, this time inside
      // a single case.
      if (untested.length > 0) {
        return [
          "inconclusive",
          `${seen.join("; ")} — so the 404 wording on ${untested.join(" and ")} was never read`,
        ];
      }
      return ["ok", seen.join("; ")];
    },
  },
  {
    quirk: "module-gating",
    claim: "a 403 is a disabled MODULE and the detail names it; share-investments is the empty-body exception",
    marker: 'the detail reads like "Project module is disabled"',
    conditional: "needs at least one module DISABLED; a fully-enabled tenant has no 403 to read",
    probes: [
      "/api/projects",
      "/api/warehouses",
      "/api/timesheets",
      "/api/salary-payments",
      "/api/share-investments",
    ],
    // Sub-resources are gated by the same module as the collection above them, which is probed directly. A
    // 403 on /api/projects/{id} is the Project module being off, not a separate claim.
    samples: [
      "/api/projects",
      "/api/salary-payments",
      "/api/share-investments",
      "/api/warehouses",
    ],
    async check() {
      // All five, because the claim is about what a 403 MEANS on any of them. Four are enabled on our
      // tenants and simply answer 200 — not evidence for or against the claim, but evidence the day one of
      // them starts refusing with wording that means something else.
      const gated = [];
      const open = [];
      const unreadable = [];
      for (const path of this.probes) {
        const r = await get(path);
        if (r.status === 403) {
          const detail = detailOf(r);
          // The documented exception: it refuses with an ENTIRELY EMPTY body, so there is no detail to read
          // and a bare 403 must be accepted as the module being off. This branch was DEAD until detailOf
          // stopped turning a null body into "{}".
          if (!detail) {
            gated.push(`${path} 403 with an empty body, as the note documents`);
            continue;
          }
          if (!/module|modul/i.test(detail)) {
            return ["drift", `${path} 403s with "${detail.slice(0, 80)}", which does not name a module`];
          }
          gated.push(`${path} 403 "${detail}"`);
        } else if (r.status === 200) {
          open.push(`${path} 200`);
        } else {
          // Neither gated nor cleanly working, so this PATH cannot speak to the claim — but it must not sink
          // the paths that can. /api/timesheets is the standing example: a bare GET is 400 "projectId is
          // required", because validation runs before the module gate, so the module state is simply not
          // observable there. Recorded rather than swallowed; counting it as "the module is on" is what let
          // an earlier version print OK during an outage.
          unreadable.push(`${path} ${r.status} ${detailOf(r).slice(0, 40) || "(no detail)"}`);
        }
      }
      if (gated.length === 0) {
        // Declared, not accidental: on a tenant with every module enabled there is no 403 anywhere, and this
        // claim is only about what a 403 means. Review found the audit exiting 3 on such a tenant with no way
        // to say why, which would make the exit code noise on any tenant but ours.
        return [
          "conditional",
          `nothing is gated on this tenant, so no 403 wording exists to read: ${open.join(", ")}` +
            (unreadable.length ? ` | could not speak to it: ${unreadable.join(", ")}` : ""),
        ];
      }
      // A first version re-fetched /api/share-investments here and called a 403 DRIFT, because the note
      // records it answering 200 on OUR tenants as of 2026-08-08. Review was right that this inverts the
      // quirk: the note's actual claim is that a bare 403 there means the module is off, so on a tenant
      // where it IS off, 403-with-empty-body is the note being CORRECT. Tenant configuration must not
      // decide whether a claim reads as drift. Both outcomes are accepted and reported above, and the loop
      // still fails a 403 whose body says something other than "module".
      // Everything observed is reported, including the paths that could not answer — a silent omission here
      // would read as "all five checked".
      return [
        "ok",
        `gated: ${gated.join("; ")} | open: ${open.join(", ")}` +
          (unreadable.length ? ` | could not speak to it: ${unreadable.join(", ")}` : ""),
      ];
    },
  },
  {
    quirk: "timesheets-need-project-module",
    claim: "projectId is required AND rejected at once, so no request succeeds without the module",
    marker: '400 "projectId cannot be used when the Project module is disabled"',
    conditional: "needs the Project module DISABLED; where it is enabled the request simply succeeds",
    probes: ["/api/timesheets"],
    async check() {
      // A FULL request. Sending only projectId trips the date validator first and measures nothing about
      // the module — see the note at the top of this file.
      const withProject = await get(`/api/timesheets?projectId=1&${DATES}`);
      if (withProject.status === 200) {
        return ["conditional", "it succeeded, so the Project module is enabled and there is no refusal to read"];
      }
      // The documented status FIRST. Reading the text of a 401, 429 or 500 as evidence about a validation
      // rule the request never reached would report drift for a claim that was never tested.
      if (withProject.status !== 400) {
        return ["inconclusive", `a full request answered ${withProject.status}, not the documented 400`];
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
      if (without.status !== 400) {
        return ["inconclusive", `omitting projectId answered ${without.status}, not the documented 400`];
      }
      return /projectid is required/i.test(detailOf(without))
        ? ["ok", `required ("${detailOf(without)}") and rejected ("${detail}")`]
        : ["drift", `it is no longer required: 400 "${detailOf(without).slice(0, 70)}"`];
    },
  },
  {
    quirk: "tenant-header-ignored-single-tenant",
    claim: "with a token reaching exactly ONE tenant, X-Tenant-Id is ignored",
    marker: "X-Tenant-Id is IGNORED",
    probes: ["/api/me"],
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
        // "conditional", not "inconclusive": the DECLARED precondition is what is missing, and only this
        // branch may be excused. Any other way of failing to answer stays inconclusive and fails the run.
        return [
          "conditional",
          `this token reaches ${companies.length} tenants (${companies.map((c) => c.id).join(", ")}) and the ` +
            `claim is conditional on reaching exactly one, so it cannot be tested from here. Worth stating ` +
            `rather than hiding: the tenant guard in the write scripts assumes the opposite case, and this ` +
            `is the token that makes that guard necessary`,
        ];
      }
      // A header EQUAL to the only tenant proves nothing: 200 is also what a correctly-honoured header
      // gives. The claim is that even a nonexistent or foreign id is ignored, so send one that DIFFERS.
      const only = companies[0].id;
      const bogus = String(only) === "999999999" ? 999_999_998 : 999_999_999;
      const other = await get("/api/me", { tenantOverride: bogus });
      if (other.status !== 200) {
        return ["drift", `X-Tenant-Id: ${bogus} produced ${other.status}, so the header is no longer ignored`];
      }
      const got = (other.body?.companies ?? other.body?.tenants ?? []).map((c) => c.id);
      return got.length === 1 && String(got[0]) === String(only)
        ? ["ok", `X-Tenant-Id: ${bogus} still returned tenant ${only} — ignored, as claimed`]
        : ["drift", `X-Tenant-Id: ${bogus} returned ${JSON.stringify(got)} rather than only ${only}`];
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
  console.log(`(${QUIRKS.length} quirks exist; this covers the subset a GET can answer.)`);
  // No silent caps. These quirks are served on more operations than are probed, and the two reasons — a
  // family represented by one endpoint, and an operation where the claim does not hold — are stated here
  // rather than left for someone to reconstruct from the case list. test/quirk-drift.test.mjs fails if any
  // served GET operation is neither probed, sampled nor excepted.
  for (const c of CASES) {
    if (c.samples?.length) console.log(`  ${c.quirk}: families sampled — ${c.samples.join(", ")}`);
    if (c.exceptions?.length) console.log(`  ${c.quirk}: claim does NOT hold on — ${c.exceptions.join(", ")}`);
  }
  console.log("");

  const tally = { ok: 0, drift: 0, inconclusive: 0, conditional: 0 };
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
    // A case may only return "conditional" if it DECLARED one, so the exemption cannot be reached by a
    // branch that merely failed to get an answer. Review found the first version excused every inconclusive
    // outcome from a case carrying the field — a 500 from /api/me included — which let a zero exit stand for
    // a claim nobody had checked, for a reason nobody had declared.
    if (outcome === "conditional" && !c.conditional) {
      outcome = "inconclusive";
      note = `${note} [returned "conditional" without declaring one, so it is not excused]`;
    }
    tally[outcome] += 1;
    if (outcome === "inconclusive") unexpected.push(`${c.quirk}: ${note}`);
    const label =
      outcome === "ok" ? "OK   " : outcome === "drift" ? "DRIFT" : outcome === "conditional" ? "N/A  " : "?????";
    console.log(`${label}  ${c.quirk}${outcome === "conditional" ? " (conditional, declared)" : ""}`);
    console.log(`       ${c.claim}`);
    console.log(`       ${note}`);
  }

  console.log(
    `\n${tally.ok} unchanged, ${tally.drift} drifted, ${tally.inconclusive} inconclusive, ` +
      `${tally.conditional} not answerable by this token (of ${CASES.length})`,
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
      `\n${unexpected.length} claim(s) could not be checked for a reason nothing declared, so this run does ` +
        `NOT say those quirks held:\n  ${unexpected.join("\n  ")}`,
    );
    process.exit(3);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
