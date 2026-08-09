#!/usr/bin/env node
/**
 * Are the quirks about REFUSALS still true — the ones a GET cannot reach?
 *
 * `audit-quirks.mjs` covers the 16 claims a GET can answer and is read-only by construction. This covers a
 * slice of what it cannot: quirks whose claim is that a WRITE is refused, and what the refusal says.
 *
 * ## Why this is safe, and where the line is
 *
 * Every probe here is a request built to FAIL. A refused write creates nothing, which is what makes it safe to
 * run against a tenant that holds books — the same reasoning `audit-messages.mjs` documents. Three rules keep
 * that true rather than merely intended:
 *
 *   1. Nothing irreversible or transmitting is probed at all. If a refusal ever stops working, the request goes
 *      through — so a probe is only safe if success would be harmless. `POST /api/orders` with a bad line is;
 *      anything that sends an EHF invoice, completes a salary run or files with Skatteetaten is not, and those
 *      are excluded by classification rather than by judgement.
 *   2. An unexpected 2xx is a SAFETY failure, not drift. It means the rule changed AND this script has written
 *      to real books.
 *   3. Record counts are snapshotted before and after. A refusal-only audit must leave the tenant byte-identical,
 *      so any change at all fails the run — and the run says which collection moved.
 *
 * Rule 3 is not theoretical. Scoping this file by hand, an order-line probe unexpectedly returned 201 and my
 * cleanup filtered the list response for a field the list does not return, so it reported "cleaning up 0
 * orders" while order 4109 sat there. It was deleted by hand a minute later. A count check would have caught it
 * immediately; a filter that has to be right would not.
 *
 * ## Probe the request that is valid EXCEPT for the thing under test
 *
 * Fourth appearance of this trap in these audits, and it cost three rounds of measurement here:
 *
 *   POST /api/offers {lines: [...]}          → 400 "currencyCode is required"      (never reached the lines)
 *   POST /api/offers {currencyCode, lines}   → 400 "offerLines is required"        (wrong field name)
 *   POST /api/offers {…, offerLines: [...]}  → 400 "offerLines[0].itemName is required"   ← the actual claim
 *
 * A probe missing anything else tests the first validator that trips. The required-field sets come from the
 * pinned spec, not from memory.
 *
 * Usage:
 *   REAI_WRITE_TEST_TENANTS=2783 REAI_USER_API_TOKEN=… node scripts/audit-quirks-write.mjs --tenant 2783
 */

import { pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  installProtectedTenantFetchGuard,
  requireTokenReachesTenant,
  requireWritableTenant,
} from "./lib/write-guard.mjs";

// The policy engine the server enforces with, used to classify each probe as it is sent.
const { classifyRequest, classifyTransmission } = await import(
  pathToFileURL(join(process.cwd(), "dist/policy.js")).href
);

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
  console.error("Pass --tenant <id>. This script sends write requests, so the tenant is never implicit.");
  process.exit(2);
}

// The allowlist, the protected-tenant denylist, and a runtime refusal at the socket. Every probe below is
// designed to fail, but "designed to" is not a guarantee, and this is the file that would find out.
requireWritableTenant(tenantId, { scriptName: "scripts/audit-quirks-write.mjs" });
installProtectedTenantFetchGuard();
// And where the token ACTUALLY points. The two guards above check a number on the command line; a token scoped
// to a single tenant IGNORES X-Tenant-Id, so `--tenant 2783` on a token reaching only 2634 satisfies both while
// every write lands in 2634. This was imported and then never called — the exact hazard PR #130 existed to fix,
// reintroduced one file later by forgetting a line.
await requireTokenReachesTenant(tenantId, { token, baseUrl });

/**
 * Every non-GET path this run actually sent, canonicalised. The safety rules are checked HERE, at the moment of
 * sending, rather than by a test reading this file's source.
 *
 * Review defeated the source-reading version with two lines: a template-literal path
 * (`` `/api/salary-payments/${id}/complete` ``) and a path held in a variable were invisible to the regex that
 * extracted literal method/path pairs from this file — so a transmitting probe and an uncounted `POST /api/suppliers`
 * were delivered to tenant 2634 with all 996 tests green. That is the same failure mode PR #129 spent three
 * rounds on: a guard that reads source loses to ordinary indirection. So the guard moved into the call.
 */
const writePathsSent = new Set();

const call = async (method, path, body) => {
  const canonical = path.split("?")[0];
  if (method !== "GET") {
    // Rule 1, enforced rather than asserted: a probe is only safe if accidental SUCCESS would be harmless.
    const risk = classifyRequest(method, canonical);
    const transmission = classifyTransmission(method, canonical);
    if (risk === "irreversible" || transmission === "external") {
      throw new Error(
        `Refusing to probe ${method} ${canonical}: classified ${risk}/${transmission}. This audit only sends ` +
          `requests whose accidental success would be harmless, and a refusal that stops working means the ` +
          `request goes through.`,
      );
    }
    writePathsSent.add(`${method} ${canonical}`);
  }
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Tenant-Id": String(tenantId),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {}
  return { status: res.status, body: parsed };
};

/** Field errors as `field: message`, which is where ReAI puts the useful part of a 400. */
const fieldErrorsOf = (r) =>
  (r.body?.fieldErrors ?? []).map((e) => `${e.field}: ${e.message}`).join("; ");

const detailOf = (r) => String(r.body?.detail ?? r.body?.message ?? r.body?.title ?? "");

/** Everything the API said, for a claim that could be in either place. */
const errorTextOf = (r) => [detailOf(r), fieldErrorsOf(r)].filter(Boolean).join(" | ");

const rowsOf = (r) => (Array.isArray(r.body) ? r.body : (r.body?.items ?? []));

/**
 * The collections a probe here could possibly add to. Snapshotted before and after; any change fails the run.
 *
 * Counted rather than diffed by id because the invariant is "nothing was created", and a count is the one check
 * that cannot be defeated by a filter that does not match the list's shape — which is exactly how a stray order
 * survived a cleanup pass while scoping this file.
 */
const WATCHED = [
  "/api/products",
  "/api/offers",
  // An explicit range, because the order list takes startDate/endDate and a default window would hide a stray
  // record the moment its date fell outside it — which is the one thing this snapshot exists to notice.
  "/api/orders?startDate=2000-01-01&endDate=2099-12-31",
  "/api/customers",
  "/api/employees",
  // pageSize large enough not to saturate. At pageSize=1 this entry is a constant on any tenant that already
  // has a saved lead — the same masking the order entry was just fixed for, one line below it.
  "/api/leads?leadFilter=saved&pageSize=200",
];

/**
 * Only date bounds and page size may appear in a WATCHED entry.
 *
 * The count check is the backstop for every probe, so an entry that filters is an entry that lies. Review kept
 * the required wide-date-range string in a comment and set the orders entry to `?status=closed`, which returns 0
 * on this tenant permanently — the run then printed "Record counts unchanged … so nothing was created" while
 * any created order sat outside the filter. Checked here rather than in a test, because a test asserting that a
 * string appears SOMEWHERE in the file is what let that through.
 */
const COUNT_SAFE_PARAMS = new Set(["startDate", "endDate", "pageSize", "leadFilter", "archived"]);
for (const entry of WATCHED) {
  const query = entry.split("?")[1] ?? "";
  for (const pair of query.split("&").filter(Boolean)) {
    const key = pair.split("=")[0];
    if (!COUNT_SAFE_PARAMS.has(key)) {
      console.error(
        `WATCHED entry "${entry}" filters on ${key}, so its count could stay constant while a probe creates a ` +
          `record. Only ${[...COUNT_SAFE_PARAMS].join(", ")} may appear.`,
      );
      process.exit(2);
    }
  }
  if (/pageSize=(\d+)/.test(query) && Number(/pageSize=(\d+)/.exec(query)[1]) < 50) {
    console.error(`WATCHED entry "${entry}" has a small pageSize, which saturates and hides changes.`);
    process.exit(2);
  }
}

async function snapshot() {
  const counts = {};
  for (const path of WATCHED) {
    const r = await call("GET", path);
    // A non-200 used to be recorded as the string "HTTP 403" and compared with itself, so a collection whose GET
    // started failing — a gated module, say — was silently unwatched while the summary still said "unchanged
    // across 6 collections, so nothing was created". An unreadable collection means the check did not happen.
    if (r.status !== 200) {
      throw new Error(
        `Cannot count ${path}: HTTP ${r.status}. The before/after check is what makes this audit safe, so a ` +
          `collection that cannot be read is a stop, not a footnote.`,
      );
    }
    if (!Array.isArray(r.body) && !Array.isArray(r.body?.items)) {
      throw new Error(
        `Cannot count ${path}: the response is neither an array nor a page object (keys: ` +
          `${Object.keys(r.body ?? {}).join(", ") || "none"}). rowsOf would return [] and mask any change.`,
      );
    }
    counts[path] = rowsOf(r).length;
  }
  return counts;
}

const SPEC = await import(pathToFileURL(join(process.cwd(), "dist/reai/spec.js")).href);

/** The declared required fields for a POST body, so a probe is valid except for the field under test. */
function requiredFor(path) {
  const op = SPEC.getSpecIndex().operations.find((o) => o.method === "POST" && o.path === path);
  return op?.body?.required ?? [];
}

/**
 * Each case: the quirk it checks, a marker from that quirk's note, and a probe whose expected outcome is a
 * refusal. `check` returns ["ok" | "drift" | "inconclusive" | "conditional", sentence].
 */
const CASES = [
  {
    quirk: "stock-product-needs-a-variant",
    probes: ["/api/products"],
    claim: "a stock product with no variants is refused, naming the synthetic validation field",
    marker: "Stock products must contain at least one variant",
    async check() {
      const r = await call("POST", "/api/products", { title: "audit-refusal-probe", stockItem: true });
      if (r.status < 300) return ["safety", `a stock product with no variants was CREATED (id ${r.body?.id})`];
      if (r.status !== 400) return ["inconclusive", `answered ${r.status}, not the documented 400`];
      const errs = fieldErrorsOf(r);
      if (!/stockProductVariantSelectionValid/.test(errs)) {
        return ["drift", `the 400 no longer names the synthetic field: ${errs || detailOf(r)}`];
      }
      return /at least one variant/i.test(errs)
        ? ["ok", `400 ${errs}`]
        : ["drift", `the field is named but the message changed: ${errs}`];
    },
  },
  {
    quirk: "offer-lines-stricter",
    probes: ["/api/offers"],
    unprobedClaims:
      "that vatCode is OPTIONAL on an order line — showing it needs a line that SUCCEEDS, which would create " +
      "an order; measured by hand while scoping (itemName only -> 201, order deleted)",
    claim: "an offer line requires itemName AND vatCode; an order line requires itemName but not vatCode",
    marker: "itemName is NOT: an order line without it is refused",
    async check() {
      // Valid except for the line fields. `offerLines`, not `lines` — and every other required field present,
      // or the first validator to trip is currencyCode and the claim is never reached.
      const customerId = await anyCustomerId();
      if (customerId === undefined) return ["conditional", "no customer on this tenant to attach a line to"];

      const offerBase = { customerId, currencyCode: "NOK", daysUntilDue: 14 };
      const missing = { quantity: 1, unitPrice: 100 };
      // Against the spec, not a remembered list. If a refreshed spec adds a required offer field this probe does
      // not supply, the request fails on THAT field and the case would report drift in the line validation —
      // a false positive pointing at the wrong thing. Better to say so.
      const unsupplied = requiredFor("/api/offers").filter(
        (f) => !(f in offerBase) && f !== "offerLines",
      );
      if (unsupplied.length > 0) {
        return [
          "inconclusive",
          `the spec now requires ${unsupplied.join(", ")} on an offer, which this probe does not supply — it ` +
            `would fail on that instead of on the line fields this case is about`,
        ];
      }

      const noItem = await call("POST", "/api/offers", { ...offerBase, offerLines: [{ ...missing, vatCode: "0" }] });
      if (noItem.status < 300) return ["safety", `an offer line with no itemName was ACCEPTED (id ${noItem.body?.id})`];
      if (!/offerLines\[0\]\.itemName/.test(fieldErrorsOf(noItem))) {
        return ["drift", `an offer line without itemName is no longer refused for it: ${errorTextOf(noItem)}`];
      }
      const noVat = await call("POST", "/api/offers", { ...offerBase, offerLines: [{ ...missing, itemName: "x" }] });
      if (noVat.status < 300) return ["safety", `an offer line with no vatCode was ACCEPTED (id ${noVat.body?.id})`];
      if (!/offerLines\[0\]\.vatCode/.test(fieldErrorsOf(noVat))) {
        return ["drift", `an offer line without vatCode is no longer refused for it: ${errorTextOf(noVat)}`];
      }

      // The comparison half, which is where the note is wrong. It says both fields are "optional on an order
      // line"; an order line with neither is refused with "Produkt er obligatorisk for alle ordrelinjer."
      const orderBase = { customerId, currencyCode: "NOK", daysUntilDue: 14, issueDate: today() };
      const orderNoItem = await call("POST", "/api/orders", { ...orderBase, orderLines: [missing] });
      if (orderNoItem.status < 300) {
        // SAFETY, not drift. A drift outcome tells the operator to correct a note; this outcome means an order
        // now exists in the tenant. The count check will also fire, but the classification has to say which
        // kind of problem it is.
        return [
          "safety",
          `an order line with no itemName was ACCEPTED (order id ${orderNoItem.body?.id}) — the note's "optional ` +
            `on an order line" is true again AND this probe created an order that must be deleted`,
        ];
      }
      if (!/produkt er obligatorisk/i.test(errorTextOf(orderNoItem))) {
        return ["drift", `an order line without itemName is refused differently now: ${errorTextOf(orderNoItem)}`];
      }
      // The remaining half — that vatCode is OPTIONAL on an order line — cannot be shown by a refusal, because
      // demonstrating it means sending a line that SUCCEEDS and creating an order. Measured by hand while
      // scoping this (itemName only -> 201, order deleted afterwards), and deliberately not probed here: this
      // file's guarantee is that nothing is created, and one case is not worth trading it for.
      return [
        "ok",
        `offer line refused for itemName and for vatCode; order line without itemName refused with ` +
          `"${detailOf(orderNoItem)}" — so itemName is required on BOTH. The claim that vatCode is optional on ` +
          `an ORDER line is NOT verified here: showing it requires a line that succeeds, which would create an ` +
          `order`,
      ];
    },
  },
  {
    quirk: "brreg-lookup-requires-and-overwrites-name",
    probes: ["/api/customers"],
    unprobedClaims:
      "that the address is filled from organizationNumber and the name you send is DISCARDED (stored as " +
      "the registry's own name) " +
      "— both need a successful create, which audit-storage.mjs covers",
    claim: "a blank name is refused even alongside a valid organizationNumber",
    marker: 'A blank name is refused with "name is required"',
    async check() {
      const r = await call("POST", "/api/customers", { name: "", organizationNumber: "974761076" });
      if (r.status < 300) {
        return ["safety", `a blank name was ACCEPTED alongside an org number (id ${r.body?.id})`];
      }
      if (r.status !== 400) return ["inconclusive", `answered ${r.status}, not the documented 400`];
      const errs = fieldErrorsOf(r);
      return /name.*is required/i.test(errs)
        ? ["ok", `400 ${errs} — the org number alone is not enough, whatever minLength 0 suggests`]
        : ["drift", `a blank name is refused, but not for the name: ${errs || detailOf(r)}`];
    },
  },
  {
    quirk: "lead-convert-is-addressable-by-id-only",
    probes: ["/api/leads/{id}/convert"],
    unprobedClaims:
      "that converting is idempotent and the response body is the company record rather than the customer — " +
      "both need a saved lead and a successful convert",
    claim: "the /org/{orgNumber} form of convert does not exist and answers 404 No static resource",
    marker: "the org form answers 404",
    async check() {
      // A 404 for a route that does not exist creates nothing, which is what makes probing a POST here safe.
      const r = await call("POST", "/api/leads/org/974761076/convert", {});
      if (r.status < 300) {
        return ["safety", "the /org/ form of convert EXISTS now and this probe just converted a lead"];
      }
      if (r.status !== 404) return ["inconclusive", `answered ${r.status}, not the documented 404`];
      return /no static resource/i.test(detailOf(r))
        ? ["ok", `404 "${detailOf(r)}"`]
        : ["drift", `404 but with a different body: "${detailOf(r).slice(0, 80)}"`];
    },
  },
  {
    quirk: "days-until-due-mandatory",
    probes: ["/api/orders", "/api/offers"],
    unprobedClaims:
      "the headline claim that whatever you send OVERRIDES the customer\u2019s payment terms — that needs a " +
      "successful create and a read-back",
    claim: "daysUntilDue is declared required on both offers and orders, and omitting it is refused",
    marker: 'it answers a bare 400 "Failed to read request", with no fieldErrors',
    async check() {
      // The schema half first, from the pinned spec — the claim is about the CONTRACT, and a runtime 400 alone
      // cannot distinguish "required" from "rejected for another reason".
      const notRequired = ["/api/offers", "/api/orders"].filter((p) => !requiredFor(p).includes("daysUntilDue"));
      if (notRequired.length > 0) {
        return ["drift", `the spec no longer marks daysUntilDue required on ${notRequired.join(", ")}`];
      }
      const customerId = await anyCustomerId();
      if (customerId === undefined) return ["conditional", "no customer on this tenant to build a valid order from"];

      // Valid except for daysUntilDue, both omitted and explicitly null, since the claim is "non-nullable".
      const base = {
        customerId,
        currencyCode: "NOK",
        issueDate: today(),
        orderLines: [{ quantity: 1, unitPrice: 100, itemName: "audit-refusal-probe" }],
      };
      let refusal;
      for (const [label, body] of [["omitted", base], ["null", { ...base, daysUntilDue: null }]]) {
        const r = await call("POST", "/api/orders", body);
        refusal ??= r;
        if (r.status < 300) {
          return [
            "safety",
            `an order with daysUntilDue ${label} was ACCEPTED (order id ${r.body?.id}) — it is no longer ` +
              `mandatory AND this probe created an order that must be deleted`,
          ];
        }
        if (r.status !== 400) return ["inconclusive", `daysUntilDue ${label} answered ${r.status}`];
      }
      // The response the loop ALREADY saw. A first version re-issued the request purely to quote its detail,
      // which meant one more chance to create an order and no check on the result — it would have printed the
      // new text as though it had been verified.
      //
      // Worth stating: the refusal is a deserialization failure, not a field error, so an agent gets no clue
      // which field was missing. That is the practical consequence of "non-nullable", and the note says it.
      if (fieldErrorsOf(refusal)) {
        return [
          "drift",
          `omitting daysUntilDue now returns field errors (${fieldErrorsOf(refusal)}) rather than the bare ` +
            `deserialization failure the note describes — the note should be updated to the better behaviour`,
        ];
      }
      if (!/failed to read request/i.test(detailOf(refusal))) {
        return ["drift", `the refusal now reads "${detailOf(refusal).slice(0, 80)}", not the documented bare failure`];
      }
      return [
        "ok",
        `declared required on offers and orders; omitting it gives 400 "${detailOf(refusal)}" with no field named`,
      ];
    },
  },
  {
    quirk: "line-vat-code-subset",
    probes: ["/api/orders"],
    unprobedClaims:
      "that SUBSCRIPTION lines are checked against the same list, and that OFFER lines are NOT — an offer can " +
      "store a code that fails later; both need a successful create",
    claim: "an order line's vatCode must be one of the tenant's own codes, and the refusal lists them",
    marker: 'a purchase-side code is rejected with "Mva-kode N er ikke tillatt',
    async check() {
      const customerId = await anyCustomerId();
      if (customerId === undefined) return ["conditional", "no customer on this tenant to build an order from"];
      const r = await call("POST", "/api/orders", {
        customerId,
        currencyCode: "NOK",
        daysUntilDue: 14,
        issueDate: today(),
        // A code deliberately outside any plausible set. If the subset check has gone, this is accepted.
        orderLines: [{ quantity: 1, unitPrice: 100, itemName: "audit-refusal-probe", vatCode: "999" }],
      });
      if (r.status < 300) {
        return [
          "safety",
          `vatCode 999 was ACCEPTED (order id ${r.body?.id}) — the subset is no longer enforced AND this probe ` +
            `created an order that must be deleted`,
        ];
      }
      if (r.status !== 400) return ["inconclusive", `answered ${r.status}`];
      const text = errorTextOf(r);
      if (!/ikke tillatt/i.test(text) || !/tillatte koder/i.test(text)) {
        return ["drift", `refused, but without listing the allowed codes: ${text.slice(0, 90)}`];
      }
      // The claim is that it lists the TENANT'S OWN codes, so compare them. Accepting any text containing the
      // two Norwegian phrases would pass on a hard-coded or stale list.
      const codesRes = await call("GET", "/api/vat-codes?usage=customer-invoice");
      if (codesRes.status !== 200) {
        return ["inconclusive", `the refusal lists codes, but /api/vat-codes answered ${codesRes.status} so they ` +
          `could not be compared with the tenant's own`];
      }
      const own = rowsOf(codesRes)
        .map((c) => String(c.code ?? c.vatCode ?? c.id))
        .filter(Boolean)
        .sort();
      const listed = (/tillatte koder:\s*([^."]+)/i.exec(text)?.[1] ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .sort();
      if (own.length === 0) return ["inconclusive", "the tenant reports no customer-invoice VAT codes to compare"];
      return listed.join(",") === own.join(",")
        ? ["ok", `400 "${detailOf(r)}" — and the listed codes match the tenant's own [${own.join(", ")}]`]
        : [
            "drift",
            `the refusal lists [${listed.join(", ")}] but the tenant's customer-invoice codes are ` +
              `[${own.join(", ")}] — the message is not reporting this tenant's set`,
          ];
    },
  },
];

/** An existing customer id, archived ones included — a line needs one and this tenant may have no active ones. */
let cachedCustomerId;
async function anyCustomerId() {
  if (cachedCustomerId !== undefined) return cachedCustomerId || undefined;
  for (const path of ["/api/customers", "/api/customers?archived=true"]) {
    const r = await call("GET", path);
    const id = rowsOf(r)[0]?.id;
    if (id !== undefined) return (cachedCustomerId = id);
  }
  cachedCustomerId = 0;
  return undefined;
}

function today() {
  // Derived, not pinned. A fixed 2026-01-02 would drift out of `/api/orders`' default window once the year
  // rolled over, and then a probe order created by accident would be invisible to the count check that is
  // supposed to catch exactly that. The snapshot also asks for an explicit wide range for the same reason.
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const { QUIRKS } = await import(pathToFileURL(join(process.cwd(), "dist/reai/quirks.js")).href);
  const known = new Map(QUIRKS.map((q) => [q.id, q]));
  const unknown = CASES.map((c) => c.quirk).filter((id) => !known.has(id));
  if (unknown.length > 0) {
    console.error(`These cases name quirks that no longer exist: ${unknown.join(", ")}`);
    process.exit(2);
  }

  console.log(`Checking ${CASES.length} refusal claims against tenant ${tenantId}.`);
  console.log("Every probe is built to FAIL: a refused write creates nothing.\n");

  // What each case does NOT cover, printed rather than left for someone to reconstruct. The read-only audit
  // fails the build unless a case covers every path its quirk is served on; this one cannot reach that bar —
  // several of these quirks are served on PUT and on paths whose probe would need a fixture — so the honest
  // substitute is disclosure. Review was right that "five verified exactly as written" overstated it: the
  // sentences these notes lead with are often not the ones probed.
  for (const c of CASES) {
    const q = known.get(c.quirk);
    const probed = new Set([...(c.probes ?? [])]);
    const unprobed = q.paths.filter((p) => !probed.has(p));
    if (unprobed.length > 0) {
      console.log(`  ${c.quirk}: served on ${q.paths.length} path(s); NOT probed on ${unprobed.join(", ")}`);
    }
    if (c.unprobedClaims) console.log(`  ${c.quirk}: claim not covered — ${c.unprobedClaims}`);
  }
  console.log("");

  const before = await snapshot();
  const tally = { ok: 0, drift: 0, inconclusive: 0, conditional: 0, safety: 0 };

  for (const c of CASES) {
    let outcome;
    let note;
    try {
      [outcome, note] = await c.check();
    } catch (err) {
      outcome = "inconclusive";
      note = `the probe threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    tally[outcome] = (tally[outcome] ?? 0) + 1;
    const label =
      outcome === "ok"
        ? "OK    "
        : outcome === "drift"
          ? "DRIFT "
          : outcome === "safety"
            ? "SAFETY"
            : outcome === "conditional"
              ? "N/A   "
              : "??????";
    console.log(`${label} ${c.quirk}`);
    console.log(`       ${c.claim}`);
    console.log(`       ${note}`);
  }

  // The invariant that makes this file safe. Not "I believe the probes were refused" — check.
  const after = await snapshot();

  // Completeness, from what was SENT rather than from a regex over this file. A probe that added a row to a
  // collection nothing counted would otherwise be invisible — review reached `POST /api/suppliers` that way.
  const watchedCollections = new Set(WATCHED.map((p) => p.split("?")[0]));
  const uncounted = [...writePathsSent]
    .map((entry) => entry.split(" ")[1])
    .filter((p) => /^\/api\/[a-z-]+$/.test(p) && !watchedCollections.has(p));
  if (uncounted.length > 0) {
    console.log(
      `\nA probe wrote to ${[...new Set(uncounted)].join(", ")}, which the snapshot does not count, so a ` +
        `record created there would be invisible. Add it to WATCHED.`,
    );
    process.exit(1);
  }

  const moved = Object.keys(before).filter((k) => before[k] !== after[k]);
  console.log(
    `\n${tally.ok} unchanged, ${tally.drift} drifted, ${tally.safety} SAFETY, ` +
      `${tally.inconclusive} inconclusive, ${tally.conditional} not answerable (of ${CASES.length})`,
  );
  if (moved.length > 0) {
    console.log(
      `\nRECORD COUNTS CHANGED, so a probe was not refused after all:\n` +
        moved.map((k) => `  ${k}: ${before[k]} -> ${after[k]}`).join("\n") +
        `\n\nFind what was created and delete it. A refusal-only audit must leave the tenant as it found it.`,
    );
    process.exit(1);
  }
  console.log(`Record counts unchanged across ${WATCHED.length} collections, so nothing was created.`);

  if (tally.safety > 0) {
    console.log(`\n${tally.safety} probe(s) SUCCEEDED that should have been refused. Treat as an incident.`);
    process.exit(1);
  }
  if (tally.drift > 0) {
    console.log(`\nCorrect the note in src/reai/quirks.ts — and check the probe was valid except for the field under test.`);
    process.exit(1);
  }
  if (tally.inconclusive > 0) process.exit(3);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
