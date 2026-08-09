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
 * Two live audits already existed, and between them they named **2 of the 126 quirks**:
 * `tenant-header-ignored-single-tenant` and `customer-name-title-cased`. That 2, and the 126, are exact.
 *
 * How many of the remaining 124 assert something an API call could check is NOT exact, and the number is
 * deliberately not quoted here. A keyword sweep over `note` prose returns 86 or 95 depending on the word
 * list, which makes it a lower bound dressed as a measurement — the false precision `storage-drift` was
 * corrected for, and which its census script prints rather than asserts for the same reason. The exact,
 * checkable statement is the one that matters: of **126** quirks, **17** now have a live case — the 16 here plus
 * `customer-name-title-cased` in audit-storage.mjs, with `tenant-header-ignored-single-tenant` in both sets —
 * leaving **109** unnamed. This arithmetic has been wrong FOUR times: 124-out-of-122 from double-counting,
 * then an 8-case accounting left standing beside a 16-case audit, then this header still saying 8/113 after the
 * docs were corrected, then a PR that added three quirks bumped four of the six places this number is written
 * and left this file and two lines of docs/audits.md behind — which is why a test now checks every stated count
 * rather than the first one in the README. Count distinct ids and check the total against 126.
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
 * `docs/audits.md`: a claim nobody checked is not a claim that held, and "7 of 8" printed next to a
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
 * claims and `audit-messages.mjs` nine refusals. The rest stay unchecked, and any needing a write needs the
 * test tenant. Not "the rest of the 84" — that figure is retracted above as invented precision, and it
 * survived here for sixty-odd lines after the retraction.
 *
 * Usage:
 *   REAI_USER_API_TOKEN=… npm run audit:quirks -- --tenant 2634
 *
 * Through the npm script, because it rebuilds `dist/` first. Running the file directly reads whatever `dist/`
 * happens to hold, and a stale one describes a quirk registry `src/` does not — the same false-clean hazard
 * `sweep:discovery` prepends a build for.
 */

import { pathToFileURL } from "node:url";
import { join } from "node:path";
// node:fs reads the pinned OpenAPI document, whose `style`/`explode` the compact spec index drops. It is on
// the import allowlist because it cannot reach the network, which is the only thing that allowlist exists to
// prevent — see the fetch wrapper below.
import { readFileSync } from "node:fs";

(() => {
  const unguarded = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const method = String(init?.method ?? (typeof input === "object" && input ? input.method : "GET") ?? "GET");
    if (method.toUpperCase() !== "GET") {
      throw new Error(
        `audit-quirks may only issue GET; a ${method.toUpperCase()} was attempted. This audit runs against ` +
          `real books and nothing here is permitted to write.`,
      );
    }
    return unguarded(input, init);
  };
})();

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
/**
 * Every fetch in this process is checked, not just the one below.
 *
 * The guard used to live inside the single request helper, and the test counted `fetch(` occurrences to prove
 * there was only one. Review added fourteen lines of `node:http` and issued a real POST /api/vouchers and a
 * DELETE /api/share-investments/1 with all ten tests green and the occurrence count still 1. Counting call
 * sites cannot establish that no other channel exists.
 *
 * So the check moves to the channel itself: any non-GET through globalThis.fetch throws, wherever it is
 * called from and whenever it is added. The companion test forbids importing node:http/https/net, which is
 * the remaining way to reach the network without passing through here — a static check, and named as such,
 * because a determined edit to this file can always add one. What this makes impossible is doing it by
 * ACCIDENT, which is the realistic failure mode for an audit pointed at a real company's books.
 */
// Installed inside an IIFE so the UNGUARDED function is closure-scoped and unreachable from the rest of the
// file, and installed as the FIRST executable statement so there is no window in which the native function is
// nameable. Both matter, and each was learned from a working exploit:
//
//   1. A module-scope `const nativeFetch = globalThis.fetch` was callable directly, and the call-site counter
//      used a case-sensitive /fetch\(/ that never saw the capital F.
//   2. With the IIFE in place but not first, `const raw = fetch;` placed ABOVE it captured the still-native
//      function without ever naming `globalThis.fetch`, dodging the alias check entirely.
//
// Ordering closes (2) by construction: any `fetch` captured after this line is the wrapper. `test/quirk-drift`
// enforces both properties from the AST rather than from a regex, because every text-level version of these
// checks was defeated by an indirection a pattern could not see.

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
  // Frozen, because the check above was check-then-USE: review inserted `init.method = "POST"` on the next
  // line and every request in the run went out as a POST with all ten tests green. Object.assign and a
  // defineProperty getter did the same. ESM is strict mode, so a write to a frozen property throws.
  Object.freeze(init);
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

/** The note's "ENTIRELY EMPTY body" — nothing at all, not merely nothing this code recognises. */
const isEmptyBody = (body) =>
  body == null ||
  body === "" ||
  (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0);

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
    // stands in for the NINE-operation ledger family — five collections plus four /{id} lookups; an earlier
    // comment here said eight. All five collections were measured directly (general, customer, supplier,
    // asset, employee: each 400 bare, 200 with the range) and review measured all four /{id} lookups as 400
    // bare. The schema half below reads only `this.probes`, so it does NOT check the other six — stated
    // because the previous version of this comment claimed it did.
    samples: ["/api/ledger"],
    // Where the claim does not hold. /api/vouchers/{id} and /api/postings/groups were MEASURED answering 200
    // with no date range. /api/postings/groups/{postingGroupId} declares no date parameters either but could
    // not be measured — neither test tenant has a posting group, so it 404s — and the note now says that
    // rather than implying three measurements where there were two.
    //
    // Being single-resource is NOT what exempts them: review measured /api/ledger/customer/1 and its asset,
    // employee and supplier siblings all returning 400 "startDate is required", and an earlier version of
    // this note told agents the opposite.
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
    claim: "the two lead page endpoints return DIFFERENT wrappers, and neither is a bare array",
    marker: "{ items, page, hasPrevious, hasNext, latestRegisteredAt }",
    conditional: "needs the Leads module ENABLED; where it is off every wrapper is a 403 instead",
    // Not /api/leads/person-role-matches, even though this note contrasts with it. The quirk is not SERVED
    // there — its paths are the two page-object endpoints — so verifying that third wrapper here attributed
    // the result to a claim the agent never receives at that operation. `person-role-matches-shape` has its
    // own case, which asserts exactly { matched, companyMatched, items } and the absence of paging fields, so
    // the contrast is still checked; it is checked where the claim actually lands.
    probes: ["/api/leads", "/api/leads/person-profiles"],
    async check() {
      // The note enumerates all three, so all three are checked — the hazard it warns about is assuming
      // they share a shape, which a probe of one endpoint cannot see.
      const want = {
        "/api/leads": ["items", "page", "hasPrevious", "hasNext", "latestRegisteredAt"],
        "/api/leads/person-profiles": ["items", "hasMore", "nextStartOrgNo", "limit"],
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
          // stopped turning a null body into "{}" — and then it was too WIDE: `!detail` means "no
          // detail/message/title key", so a real refusal like {"error":"Insufficient permission for user"}
          // got laundered into "the module is off, as the note documents". For a drift audit a false OK is
          // the worse direction, so the test is on the BODY being empty, which is what the note claims.
          if (isEmptyBody(r.body)) {
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
  {
    quirk: "leads-are-the-company-register-not-your-records",
    claim: "pageSize caps at 200, and the over-cap 400 names the field in fieldErrors",
    marker: "Read fieldErrors before concluding a validation failure is opaque",
    // Not /api/leads/null: this quirk is served only on /api/leads, so verifying the addressing claim here
    // would attribute the result to a claim the agent never receives at that operation. It is checked by
    // lead-detail-nests-what-the-search-flattens, which IS served on /api/leads/{id}. Same mis-attribution
    // the reverse-coverage check caught for the third lead wrapper in #128.
    probes: ["/api/leads"],
    conditional: "needs the Leads module ENABLED; where it is off every probe here is a 403",
    async check() {
      const capped = await get("/api/leads?pageSize=200");
      if (capped.status === 403) return ["conditional", "403 — the Leads module is off on this tenant"];
      if (capped.status !== 200) return ["inconclusive", `pageSize=200 answered ${capped.status}`];

      // 201, not 500. Rejecting 500 is consistent with a cap anywhere from 200 to 499, so it cannot show the
      // cap IS 200 — and the note tells agents 200 exactly.
      const over = await get("/api/leads?pageSize=201");
      if (over.status !== 400) return ["drift", `pageSize=201 was accepted, so 200 is no longer the cap`];
      // The corrected half. The note used to say this 400 "names no field"; it names it in fieldErrors, and
      // an agent told otherwise never looks there. So the probe reads exactly that.
      const named = (over.body?.fieldErrors ?? []).find((e) => e.field === "pageSize");
      if (!named) {
        return [
          "drift",
          `the over-cap 400 no longer names pageSize in fieldErrors: ${JSON.stringify(over.body?.fieldErrors)}`,
        ];
      }
      // The message too, because the note quotes the limit. A field error saying "must be less than or equal
      // to 1000" names the field and would have passed while the quoted guidance went stale.
      if (!/less than or equal to 200/i.test(String(named.message ?? ""))) {
        return [
          "drift",
          `the pageSize field error now reads "${named.message}", so the documented limit of 200 is stale`,
        ];
      }
      // And the contrast the note draws, because "read fieldErrors" is only useful advice if it is sometimes
      // empty — which is what /api/leads/person-role-matches does, and what its own quirk claims.
      const bare = await get("/api/leads/person-role-matches");
      // Asserted, not decorated. A first version computed this and only used it to add a parenthetical to the
      // log, so the sentence the note now rests on ("populated here and empty there") was unaudited.
      if (bare.status !== 400) {
        return ["inconclusive", `/api/leads/person-role-matches answered ${bare.status}, so the contrast is unreadable`];
      }
      if (!Array.isArray(bare.body?.fieldErrors) || bare.body.fieldErrors.length !== 0) {
        return [
          "drift",
          `the note contrasts these two, but person-role-matches now reports ` +
            `fieldErrors=${JSON.stringify(bare.body?.fieldErrors)} rather than an empty array`,
        ];
      }

      return [
        "ok",
        `cap 200 accepted, 201 -> 400 with fieldErrors "${named.message}"; empty fieldErrors on ` +
          `person-role-matches, as the note contrasts`,
      ];
    },
  },
  {
    quirk: "leads-unsaved-rows-have-no-id",
    claim: "leadFilter selects saved/unsaved/all, and an unsaved row's id is null",
    marker: "A row's `id` is null only while the lead is UNSAVED",
    probes: ["/api/leads"],
    conditional:
      "needs the Leads module ENABLED, and needs at least one SAVED lead — without one the claim that a saved " +
      "lead carries an id cannot be read at all",
    async check() {
      const accepted = {};
      for (const f of ["all", "saved", "unsaved"]) {
        const r = await get(`/api/leads?leadFilter=${f}&pageSize=5`);
        if (r.status === 403) return ["conditional", "403 — the Leads module is off on this tenant"];
        if (r.status !== 200) return ["drift", `leadFilter=${f} answered ${r.status}, but the note offers it`];
        accepted[f] = (r.body?.items ?? []).length;
      }
      // The filter has to be a real filter: a value outside the three must be refused, or "filter with
      // leadFilter=saved|unsaved|all" is describing something that ignores its input.
      const bogus = await get("/api/leads?leadFilter=definitely-not-a-filter");
      if (bogus.status !== 400) {
        return ["drift", `an unknown leadFilter answered ${bogus.status}, so the parameter is not validated`];
      }
      const unsaved = await get("/api/leads?leadFilter=unsaved&pageSize=10");
      const rows = unsaved.body?.items ?? [];
      if (rows.length === 0) {
        return ["conditional", "no unsaved rows on this tenant, so the null-id claim has nothing to read"];
      }
      const withId = rows.filter((r) => r.id !== null);
      if (withId.length > 0) {
        return ["drift", `${withId.length} of ${rows.length} UNSAVED rows carry an id, e.g. ${withId[0].id}`];
      }
      // The other half of the claim — "Saved leads DO have an id, and it is the key to the whole workflow".
      // A first version reduced the saved response to a count and threw the rows away, so a saved row with a
      // null id would have passed while the workflow guidance was broken.
      const savedRows = (await get("/api/leads?leadFilter=saved&pageSize=10")).body?.items ?? [];
      const savedWithout = savedRows.filter((r) => r.id === null);
      if (savedWithout.length > 0) {
        return [
          "drift",
          `${savedWithout.length} of ${savedRows.length} SAVED rows have id null, so the id is no longer the ` +
            `handle the note says it is`,
        ];
      }
      // OK requires BOTH halves. A first version printed "no saved rows here, so that half is unread" next to
      // the word OK, which is the report saying it verified something it just said it had not.
      if (savedRows.length === 0) {
        return [
          "conditional",
          `all ${rows.length} unsaved rows have id null, but there are no SAVED leads on this tenant, so the ` +
            `other half of the claim — that a saved lead does have an id — could not be read`,
        ];
      }
      return [
        "ok",
        `leadFilter all/saved/unsaved = ${accepted.all}/${accepted.saved}/${accepted.unsaved}; all ${rows.length} ` +
          `unsaved rows have id null; all ${savedRows.length} saved rows carry an id`,
      ];
    },
  },
  {
    quirk: "lead-detail-nests-what-the-search-flattens",
    claim: "the detail nests lead state under `lead`; a search row flattens id and status to the top",
    marker: "code that reads `id` at the top level of a detail response gets undefined",
    probes: ["/api/leads/org/{orgNumber}", "/api/leads/null"],
    conditional:
      "needs the Leads module ENABLED, an UNTOUCHED company to read the all-null claim from, and a SAVED lead " +
      "to observe the shape at /api/leads/{id}",
    async check() {
      const list = await get("/api/leads?leadFilter=unsaved&pageSize=5");
      if (list.status === 403) return ["conditional", "403 — the Leads module is off on this tenant"];
      // A non-403 failure must NOT fall through to the "no rows" conditional: an empty `items` from a 500 or
      // a 429 would otherwise excuse the case and let the run exit 0 without checking the quirk.
      if (list.status !== 200) return ["inconclusive", `/api/leads answered ${list.status}`];
      // Specifically an UNTOUCHED row, because the all-null assertion below is only meaningful for one. The
      // first version took the first row of the default page and would have read a saved lead's values.
      const row = (list.body?.items ?? []).find((r) => r.id === null);
      if (!row) return ["conditional", "no untouched lead rows on this tenant, so there is nothing to compare"];

      // The ROW half: flattened.
      const flat = ["id", "status"].filter((k) => k in row);
      if (flat.length !== 2) {
        return ["drift", `a search row no longer carries id and status at the top level (has: ${flat.join(", ") || "neither"})`];
      }
      if ("lead" in row) return ["drift", "a search row now nests a `lead` object too, so the contrast is gone"];

      // The DETAIL half: nested, and present-but-null rather than omitted for an untouched company.
      const detail = await get(`/api/leads/org/${row.orgNumber}`);
      if (detail.status !== 200) return ["inconclusive", `the org lookup answered ${detail.status}`];
      if ("id" in (detail.body ?? {})) {
        return ["drift", "the detail response now carries `id` at the top level, so reading it no longer misleads"];
      }
      if (!detail.body || typeof detail.body.lead !== "object" || detail.body.lead === null) {
        return ["drift", `the detail response has no \`lead\` object: ${Object.keys(detail.body ?? {}).slice(0, 8).join(", ")}`];
      }
      const leadKeys = Object.keys(detail.body.lead);
      const documented = ["id", "status", "notes", "email", "phone", "followUpAt", "convertedCustomerId", "convertedAt"];
      for (const k of documented) {
        if (!leadKeys.includes(k)) return ["drift", `lead.${k} is gone; lead has ${leadKeys.join(", ")}`];
      }
      // "An untouched company still returns the `lead` object, with every field null, rather than omitting
      // it." Checking only that the keys EXIST left that sentence unaudited — the values are the claim.
      const populated = documented.filter((k) => detail.body.lead[k] !== null);
      if (populated.length > 0) {
        return [
          "drift",
          `this company has no lead state, but lead.${populated.join(", lead.")} came back non-null, so ` +
            `"every field null" no longer holds`,
        ];
      }
      if (!Array.isArray(detail.body.contactEvents)) {
        return ["drift", `contactEvents is ${JSON.stringify(detail.body.contactEvents)}, not an array`];
      }
      // And the path that cannot address an untouched company at all.
      const nullId = await get("/api/leads/null");
      if (nullId.status !== 400) return ["drift", `GET /api/leads/null answered ${nullId.status}, not the documented 400`];

      // The note's central claim is the SHAPE of a LeadRes, and /api/leads/{id} is one of the two paths it is
      // served on — but reaching it needs a saved lead's id, and an error-path probe (null -> 400) shows only
      // that the path is unusable without one. Counting that as coverage of the shape would be the
      // fragment-verification this audit keeps rediscovering, so say so instead.
      const saved = (await get("/api/leads?leadFilter=saved&pageSize=1")).body?.items ?? [];
      if (saved.length === 0) {
        return [
          "conditional",
          `the org-number path checks out — row flattens {id, status}; detail nests lead ` +
            `{ ${leadKeys.slice(0, 4).join(", ")}… } all null, contactEvents [] — and /api/leads/null still 400. ` +
            `But there is no SAVED lead on this tenant, so the LeadRes shape at /api/leads/{id} was never observed`,
        ];
      }
      const byId = await get(`/api/leads/${saved[0].id}`);
      if (byId.status !== 200) return ["inconclusive", `/api/leads/${saved[0].id} answered ${byId.status}`];
      if (typeof byId.body?.lead !== "object" || byId.body.lead === null) {
        return ["drift", `/api/leads/{id} does not nest a lead object: ${Object.keys(byId.body ?? {}).slice(0, 8).join(", ")}`];
      }
      return [
        "ok",
        `row flattens {id, status}; both detail paths nest lead { ${leadKeys.slice(0, 4).join(", ")}… }; ` +
          `untouched company all null with contactEvents []; /api/leads/null still 400`,
      ];
    },
  },
  {
    quirk: "archived-records-need-an-explicit-filter-to-see",
    claim: "archived=true is exclusive, and includeArchived=true is silently ignored rather than empty",
    marker: "it is silently IGNORED rather than rejected: it returns the plain list",
    probes: ["/api/customers", "/api/suppliers"],
    conditional: "needs at least one ARCHIVED customer or supplier on the tenant; 2634 has none",
    async check() {
      const seen = [];
      let observed = 0;
      for (const path of this.probes) {
        const plain = await get(path);
        const archived = await get(`${path}?archived=true`);
        const include = await get(`${path}?includeArchived=true`);
        for (const [label, r] of [["plain", plain], ["archived=true", archived], ["includeArchived=true", include]]) {
          if (r.status !== 200) return ["inconclusive", `${path} ${label} answered ${r.status}`];
        }
        const rows = (r) => (Array.isArray(r.body) ? r.body : (r.body?.items ?? []));
        const ids = (r) => new Set(rows(r).map((x) => x.id));
        const n = (r) => rows(r).length;
        if (n(archived) === 0) {
          seen.push(`${path}: nothing archived here`);
          continue;
        }
        observed += 1;
        const plainIds = ids(plain);
        // `includeArchived=true` is IGNORED, not empty. Two versions of this probe asserted it returns zero
        // rows, which was an artifact of measuring on tenants with no active records: on 2634 /api/suppliers
        // gives plain 1, includeArchived=true 1, and ?totallyBogusParam=true 1 — an unknown parameter is
        // dropped. So the check is that it matches the PLAIN list, which is what makes it dangerous: an agent
        // gets an unfiltered list and believes it is filtered.
        const bogus = await get(`${path}?totallyBogusParam=true`);
        if (bogus.status !== 200) return ["inconclusive", `${path} with an unknown parameter answered ${bogus.status}`];
        if (n(include) !== n(plain) || n(bogus) !== n(plain)) {
          return [
            "drift",
            `${path}: plain ${n(plain)}, includeArchived=true ${n(include)}, unknown-parameter ${n(bogus)} — ` +
              `includeArchived is no longer simply ignored, so the note's explanation is stale`,
          ];
        }
        // And archived=true must be EXCLUSIVE, not a superset: no single call returns both sets.
        if ([...ids(archived)].some((id) => plainIds.has(id))) {
          return ["drift", `${path}?archived=true now includes active records too, so it is not exclusive`];
        }
        // IDENTITIES, not sizes. `n(plain) >= n(archived)` was the comparison, and it reports DRIFT on any
        // tenant with more active records than archived ones — 100 active and 2 archived would have failed a
        // correctly-behaving API. The claim is that an archived record is ABSENT from the plain list, which is
        // a statement about which rows, not how many.
        const leaked = [...ids(archived)].filter((id) => plainIds.has(id));
        if (leaked.length > 0) {
          return [
            "drift",
            `${path}: archived record(s) ${leaked.slice(0, 3).join(", ")} also appear in the plain list, so it ` +
              `no longer hides them`,
          ];
        }
        seen.push(
          `${path}: plain ${n(plain)}, archived=true ${n(archived)} (exclusive, none in the plain list), ` +
            `includeArchived=true ${n(include)} (= plain, ignored)`,
        );
      }
      return observed === 0
        ? ["conditional", `no archived records on this tenant: ${seen.join("; ")}`]
        : ["ok", seen.join(" | ")];
    },
  },
  {
    quirk: "expense-status-never-says-booked-or-reversed",
    claim: "the status filter rejects `reversed`, so reversed expenses cannot be listed by status",
    marker: "?status=reversed cannot be used to find them",
    probes: ["/api/expenses"],
    // GET /api/expenses/{id} carries the other half of this claim — that a booked expense still reads
    // "approved" and only voucherId distinguishes it, and that a reversed one is still returned by id. Both
    // need an expense to exist, and creating one is a write. Declared rather than quietly skipped.
    unmeasured: {
      "/api/expenses/{id}":
        "requires an expense id, which cannot be obtained without creating one — a write, and out of scope " +
        "for this audit whatever the current row count happens to be",
    },
    async check() {
      // The documented values must be accepted...
      for (const v of ["open", "for_approval", "approved"]) {
        const r = await get(`/api/expenses?status=${v}`);
        if (r.status === 200) continue;
        // DRIFT only for a REJECTION of the value. A 401, 429 or 500 says nothing about whether the value is
        // still valid, and reporting "correct the quirk" for an outage is how a drift audit loses its
        // credibility.
        if (r.status === 400) {
          return ["drift", `status=${v} was rejected with 400 "${detailOf(r).slice(0, 70)}", but the note lists it`];
        }
        return ["inconclusive", `status=${v} answered ${r.status}, which says nothing about the value's validity`];
      }
      // ...and the one the note says cannot be used must still be refused, by name.
      // BOTH words in the quirk's name. `booked` is refused the same way and costs one GET; checking only
      // `reversed` left half the title unverified.
      for (const absent of ["booked", "reversed"]) {
        const r = await get(`/api/expenses?status=${absent}`);
        if (r.status === 200) {
          return ["drift", `status=${absent} is accepted now, so it IS a status and the note is stale`];
        }
        if (r.status !== 400) return ["inconclusive", `status=${absent} answered ${r.status}`];
        if (!new RegExp(`failed to convert 'status' with value: '${absent}'`, "i").test(detailOf(r))) {
          return ["drift", `status=${absent} is refused, but with "${detailOf(r).slice(0, 70)}"`];
        }
      }
      const reversed = await get("/api/expenses?status=reversed");
      if (reversed.status === 200) {
        return ["drift", "status=reversed is accepted now, so reversed expenses CAN be listed and the note is stale"];
      }
      if (reversed.status !== 400) return ["inconclusive", `status=reversed answered ${reversed.status}`];
      const detail = detailOf(reversed);
      return /failed to convert 'status' with value: 'reversed'/i.test(detail)
        ? ["ok", `open/for_approval/approved accepted; reversed refused with 400 "${detail}"`]
        : ["drift", `status=reversed is refused, but with "${detail.slice(0, 80)}" rather than the documented message`];
    },
  },
  {
    quirk: "manual-reconciliation-404-means-not-manual-not-missing",
    claim: "month is validated first, then a bank-synced id and a nonexistent id 404 identically",
    marker: "`month` is required, and it is validated BEFORE the account is looked up",
    probes: ["/api/manual-reconciliations/{bankAccountId}"],
    conditional: "needs at least one company bank to compare a real id against a nonexistent one",
    async check() {
      const banks = await get("/api/company-banks");
      if (banks.status !== 200) return ["inconclusive", `/api/company-banks answered ${banks.status}`];
      const rows = Array.isArray(banks.body) ? banks.body : (banks.body?.items ?? []);
      if (rows.length === 0) return ["conditional", "no company banks on this tenant, so there is no real id to contrast"];

      // The ordering half, which the note used to omit: bare, the endpoint complains about month and says
      // nothing about the id at all.
      // An IMPOSSIBLE id, bare. Asking with a REAL id cannot discriminate: 400 "month is required" is equally
      // consistent with the account being looked up first and found. Only an id that could not resolve shows
      // that validation runs before the lookup. Third round in a row an ordering claim was probed with a
      // request that could not establish it.
      const bare = await get("/api/manual-reconciliations/999999999");
      if (bare.status !== 400 || !/month is required/i.test(detailOf(bare))) {
        return [
          "drift",
          `without month it answers ${bare.status} "${detailOf(bare).slice(0, 60)}" rather than the documented ` +
            `400 "month is required" — the validation order has changed`,
        ];
      }

      // The ambiguity half. A synced (non-manual) account and an id that cannot exist must be
      // indistinguishable, because that is the entire warning.
      const synced = rows.filter((b) => b.providerType && b.providerType !== "manual");
      if (synced.length === 0) {
        return ["conditional", "every company bank here is manual, so the not-manual 404 cannot be produced"];
      }
      // Every synced account, not just the first: the note says all of 2634's three banks answer this.
      const reals = [];
      for (const b of synced) reals.push([b, await get(`/api/manual-reconciliations/${b.id}?month=2026-07`)]);
      const notFourOhFour = reals.filter(([, r]) => r.status !== 404);
      if (notFourOhFour.length > 0) {
        return [
          "drift",
          `${notFourOhFour.length} of ${reals.length} non-manual accounts answered something other than 404, ` +
            `e.g. id ${notFourOhFour[0][0].id} -> ${notFourOhFour[0][1].status}`,
        ];
      }
      const real = reals[0][1];
      const fake = await get("/api/manual-reconciliations/999999999?month=2026-07");
      if (fake.status !== 404) {
        return ["drift", `a nonexistent id answered ${fake.status}, so the two cases ARE distinguishable now`];
      }
      // Equality alone only shows the two responses still match. If BOTH messages changed, the quoted text an
      // agent reads would be stale and this would still report OK — so the documented detail is asserted too.
      for (const [label, r] of [[`${synced[0].providerType} account`, real], ["a nonexistent id", fake]]) {
        if (!/bankkonto ikke funnet/i.test(detailOf(r))) {
          return ["drift", `${label} now 404s with "${detailOf(r).slice(0, 70)}", not the documented message`];
        }
      }
      return detailOf(real) === detailOf(fake)
        ? ["ok", `an impossible id bare -> 400 "month is required"; all ${reals.length} ${synced[0].providerType} accounts and a nonexistent id 404 "${detailOf(real)}"`]
        : ["drift", `the two 404s now differ: "${detailOf(real)}" vs "${detailOf(fake)}" — they are distinguishable`];
    },
  },
  {
    quirk: "supplier-invoices-hide-reversed",
    claim: "the spec itself says the list returns only non-reversed documents",
    marker: "the spec says so outright",
    probes: ["/api/supplier-invoices"],
    async check() {
      // A SPEC claim, checked against the pinned document rather than the live API — the same pattern as
      // date-range-required's schema half, and the only kind of claim this repository verifies end to end.
      // A live GET cannot show it: a list with no reversed documents in it looks identical either way.
      const { getSpecIndex } = await import(pathToFileURL(join(process.cwd(), "dist/reai/spec.js")).href);
      const op = getSpecIndex().operations.find((o) => o.method === "GET" && o.path === "/api/supplier-invoices");
      if (!op) return ["inconclusive", "/api/supplier-invoices is not in the pinned spec"];
      const text = `${op.summary ?? ""} ${op.description ?? ""}`;
      // "Returns all non-reversed …" — the qualifier has to govern the RETURNED SET. A bare substring test
      // passes on "returns reversed and non-reversed supplier invoices", which asserts the opposite, and no
      // live GET could tell the difference.
      if (/\breversed and non-reversed\b|\bincluding reversed\b|\bboth reversed\b/i.test(text)) {
        return [
          "drift",
          `the spec now describes the list as INCLUDING reversed documents, so the quirk asserts the ` +
            `opposite: "${text.slice(0, 120)}"`,
        ];
      }
      if (!/returns?\s+(all\s+)?non-reversed/i.test(text)) {
        return [
          "drift",
          `the spec no longer says "non-reversed" for this endpoint, so the note is citing something it does ` +
            `not say: "${text.slice(0, 110)}"`,
        ];
      }
      // And the endpoint must still answer, or the note describes something unreachable.
      const live = await get("/api/supplier-invoices");
      return live.status === 200
        ? ["ok", `the spec states it: "${/[^.]*non-reversed[^.]*\./i.exec(text)?.[0]?.trim().slice(0, 90)}"`]
        : ["inconclusive", `the spec still says non-reversed, but the endpoint answered ${live.status}`];
    },
  },
  {
    quirk: "array-query-comma-joined",
    claim: "`include` is the only array query parameter on the agent-facing surface, declared explode=false",
    marker: "is the only array query parameter on the surface this server EXPOSES",
    probes: ["/api/bank-reconciliations/{bankAccountId}"],
    conditional: "needs a company bank id to call the reconciliation endpoint with",
    async check() {
      const { getSpecIndex } = await import(pathToFileURL(join(process.cwd(), "dist/reai/spec.js")).href);
      const ops = getSpecIndex().operations;
      // "the only array query parameter in the API" — scoped to what agents can reach. Three internal
      // /account/search endpoints also take one (accountNumberPrefix) and do NOT declare explode=false, so
      // the claim is only true of the exposed surface, and that is what is checked.
      const arrays = [];
      for (const op of ops) {
        if (op.internal) continue;
        for (const a of op.params ?? []) {
          if (a.in === "query" && /\[\]$/.test(String(a.type ?? ""))) arrays.push(`${op.method} ${op.path} ?${a.name}`);
        }
      }
      if (arrays.length !== 1 || !arrays[0].endsWith("?include")) {
        return [
          "drift",
          `the agent-facing surface now has ${arrays.length} array query parameters (${arrays.join("; ")}), so ` +
            `"the only one" is no longer true`,
        ];
      }

      // And the DECLARED serialization, which is half the claim. getSpecIndex()'s compact parameter objects
      // carry name/in/required/type/description only — no style or explode — so a first version asserted
      // "explode=false" while checking neither. Read from the pinned document instead.
      const raw = JSON.parse(readFileSync(join(process.cwd(), "spec/reai-openapi.json"), "utf8"));
      const param = (raw.paths?.["/api/bank-reconciliations/{bankAccountId}"]?.get?.parameters ?? []).find(
        (a) => a.name === "include",
      );
      if (!param) return ["inconclusive", "the pinned document no longer declares an `include` parameter here"];
      if (param.style !== "form" || param.explode !== false) {
        return [
          "drift",
          `the document now declares include with style=${param.style} explode=${param.explode}, so ` +
            `comma-joining is no longer what it specifies`,
        ];
      }

      const banks = await get("/api/company-banks");
      const rows = banks.status === 200 ? (Array.isArray(banks.body) ? banks.body : (banks.body?.items ?? [])) : [];
      // A SYNCED account: /api/bank-reconciliations is the synced-account view, and this repository's own
      // manual-vs-synced-reconciliation quirk says so. Sending it a manual account's id would produce a
      // refusal that this case would have reported as a serialization failure.
      const synced = rows.filter((b) => b.providerType && b.providerType !== "manual");
      if (synced.length === 0) {
        return ["conditional", "no bank-synced company bank here, so this endpoint has nothing to reconcile"];
      }
      const id = synced[0].id;
      const joined = await get(`/api/bank-reconciliations/${id}?month=2026-07&include=summary,pending_postings`);
      if (joined.status !== 200) {
        return ["drift", `a comma-joined include answered ${joined.status} "${detailOf(joined).slice(0, 60)}"`];
      }
      // A value outside the enum must still be refused, or "include" is not being parsed at all and the 200
      // above proves nothing about serialization.
      const bogus = await get(`/api/bank-reconciliations/${id}?month=2026-07&include=not-a-section`);
      if (bogus.status !== 400) {
        return ["drift", `include=not-a-section answered ${bogus.status}, so the parameter is not validated`];
      }
      return [
        "ok",
        "`include` is the only agent-facing array query param, declared style=form explode=false; " +
          "comma-joined accepted, bogus value refused",
      ];
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
  console.log(
    `(${QUIRKS.length} quirks exist; this covers ${CASES.length} of them — the subset a GET can answer.)`,
  );
  console.log(`(17 of the ${QUIRKS.length} have a live case across all three audits; ${QUIRKS.length - 17} do not.)`);
  // No silent caps. These quirks are served on more operations than are probed, and the two reasons — a
  // family represented by one endpoint, and an operation where the claim does not hold — are stated here
  // rather than left for someone to reconstruct from the case list. test/quirk-drift.test.mjs fails if any
  // served GET operation is neither probed, sampled nor excepted.
  for (const c of CASES) {
    if (c.samples?.length) console.log(`  ${c.quirk}: families sampled — ${c.samples.join(", ")}`);
    // Only exceptions that actually remove something are listed. One already covered by a sample removes
    // nothing, and printing it inflated the coverage figure the PR body quotes.
    const live = (c.exceptions ?? []).filter(
      (ex) => !(c.samples ?? []).some((pre) => ex === pre || ex.startsWith(`${pre}/`)),
    );
    if (live.length) console.log(`  ${c.quirk}: claim does NOT hold on — ${live.join(", ")}`);
    // Served, but not answerable by a GET — almost always because the claim needs a record to exist and
    // creating one is a write. Distinct from an exception, which asserts the claim is FALSE there. Printed
    // because "8 of 122" already understates coverage, and a silent skip would overstate it.
    for (const [path, why] of Object.entries(c.unmeasured ?? {})) {
      console.log(`  ${c.quirk}: NOT measured on ${path} — ${why}`);
    }
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
