#!/usr/bin/env node
/**
 * Does the API still produce the REFUSAL STRINGS this repository matches on?
 *
 * That is the whole scope. The first version of this file claimed more than it delivered, so "What
 * this cannot catch" below is part of the contract now rather than a footnote.
 *
 * Nineteen places in `src/` turn a ReAI error into something an agent can act on by reading its text:
 * a Norwegian validation message becomes an explanation and a next step. Each is a silent dependency
 * on upstream wording. Rephrase the message and the match stops firing, the agent gets raw Norwegian,
 * and nothing fails — the unit tests stub the error, so they keep passing against a string the API no
 * longer produces. This repository shipped exactly that once: a quirk quoting "…kan skrives uten +"
 * against a live "…kan skrives uten +47.".
 *
 * ## Safety
 *
 * Every case is a request the API should REFUSE, so nothing is created. That is a claim about each
 * request, and the first version got it wrong twice — the independent review of PR #114 found two
 * probes issuing calls this repo's own policy classifies IRREVERSIBLE:
 *
 *   - `DELETE /api/share-investments/{first row}`, with no check that the position had transactions.
 *     It passed only because the one position in the test tenant happened to be undeletable; a clean
 *     position would have been destroyed. Removed — that string is an exemption with the reason now.
 *   - `POST /api/general-sub-accounts`. `classifyRequest` returns irreversible, because once an
 *     account has any sub-account every posting to it must name one and there is no DELETE. It was
 *     also the WRONG endpoint: `subaccounts.ts` catches that string from a read-only GET.
 *
 * What remains: five reads, three refused POSTs, one refused PATCH. The three cases that need a
 * customer create one, record it in `created`, and delete it in a `finally` — the idiom
 * `test/smoke-cleanup.test.mjs` checks. A cleanup that cannot confirm deletion FAILS the run, because
 * `DELETE /api/customers/{id}` can legitimately answer `{"outcome":"archived"}`, and an archived
 * customer is invisible to the default list, so it would otherwise vanish quietly.
 *
 * ## Three outcomes
 *
 *   OK            the shipped pattern matches, against the same text the shipped code reads
 *   DRIFT         the rule was reached and the wording or the status changed — act on this
 *   INCONCLUSIVE  the request never reached the rule; the probe is what needs fixing
 *
 * The classifier is what the review broke hardest, in both directions:
 *
 *   - It inferred "the probe was malformed" from `fieldErrors` being present. ReAI answers a type or
 *     format error with `{"detail":"Failed to read request"}` and NO fieldErrors, so a malformed probe
 *     was reported as DRIFT. Shape errors are recognised by an explicit marker list covering both.
 *   - Worse, DRIFT was unreachable whenever `fieldErrors` was non-empty: a message that MOVED from
 *     `detail` into `fieldErrors` — which sales.ts records ReAI doing "often enough that detail-only
 *     translation fails open" — was reported INCONCLUSIVE, hiding the likeliest drift there is. Each
 *     case now mirrors the haystack of the code it guards, so a message changing fields is a DRIFT
 *     against a site reading `detail` and an OK against one reading the raw body — which is the truth.
 *   - `reachedRule: (r) => r.status === 400` treated ANY 400 as the rule being reached, so an
 *     unrelated blank-name refusal was reported as drift in the phone rule. Gone: the status is
 *     asserted, never used to infer reachability.
 *
 * ## What this cannot catch
 *
 * Every case is a refusal, so nothing here observes what the API ACCEPTS, normalises or stores. Two of
 * the five false claims that motivated this file are therefore still out of reach:
 *
 *   - `skipRegistryLookup` (#113) drifts on a 201 — whose name came back, and whose address.
 *   - The phone rule (#111, #112) is a STORAGE claim: default region NO, canonicalised to E.164, a
 *     Norway-valid bare number stored under +47. Only the refusal text is checked here.
 *
 * Also uncovered: which of two ambiguous causes produced a message (the reconciliation and contact
 * 404s both assert ambiguity as measured fact), anything about a 2xx body, and the four exemptions.
 *
 *   REAI_USER_API_TOKEN=… REAI_WRITE_TEST_TENANTS=2783 node scripts/audit-messages.mjs --tenant 2783
 */

import { installProtectedTenantFetchGuard, requireWritableTenant } from "./lib/write-guard.mjs";

const args = process.argv.slice(2);
const tenantArg = args.indexOf("--tenant");
const tenantId = tenantArg >= 0 ? Number(args[tenantArg + 1]) : undefined;
const token = process.env.REAI_USER_API_TOKEN;
const baseUrl = process.env.REAI_BASE_URL ?? "https://app.reai.no";
const TIMEOUT_MS = 30_000;

if (!token) {
  console.error("REAI_USER_API_TOKEN is not set.");
  process.exit(2);
}
if (!tenantId) {
  console.error("Pass --tenant <id>.");
  process.exit(2);
}

// The allowlist AND the protected-tenant denylist, in one place for all four writing scripts. Four
// divergent copies used to check only that --tenant appeared in REAI_WRITE_TEST_TENANTS, which is a
// consistency check between two operator-supplied values: set both to the same wrong number and every
// one of them proceeded. Measured — all FOUR did, and between them attempted POST /api/vouchers,
// POST /api/salary-payments, POST /api/loans, POST /api/employees and DELETE /api/vouchers against
// tenant 2634 with the env var agreeing. See scripts/lib/write-guard.mjs.
requireWritableTenant(tenantId, { scriptName: "scripts/audit-messages.mjs" });
// And a runtime refusal at the socket, because every check above reads a number the caller supplied
// and the coverage test reads the caller's source. PR #129 established that source-level checks lose to
// ordinary indirection; this one fires when the request is actually made.
installProtectedTenantFetchGuard();

const call = async (method, path, body, { omitTenant = false } = {}) => {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      // /api/me is asked WITHOUT the tenant header, the way src/auth/oauth.ts asks it. With the header
      // set to a tenant the token cannot reach, the answer is a 403 about the header rather than the
      // list of tenants — so the first version of this check reported "could not read /api/me" when
      // the real and more useful answer was "the token does not reach that tenant".
      ...(omitTenant ? {} : { "X-Tenant-Id": String(tenantId) }),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch {}
  return { status: res.status, body: parsed };
};

/**
 * The allowlist checks the tenant NUMBER on the command line. It cannot check the one thing that
 * actually decides where a write lands: which company the TOKEN reaches.
 *
 * This repository documents the hazard itself, in the `tenant-header-ignored-single-tenant` quirk —
 * when a token reaches exactly one tenant, X-Tenant-Id is IGNORED and every value returns that
 * tenant's data. So `REAI_WRITE_TEST_TENANTS=2783 --tenant 2783` with a token scoped to a different
 * company writes to that company while every guard passes. Codex caught this on PR #114; no script in
 * this repository checked it, including the two that post to the ledger.
 */
async function assertTokenReachesTenant() {
  const me = await call("GET", "/api/me", undefined, { omitTenant: true });
  if (me.status !== 200) {
    console.error(`Could not read /api/me to confirm the token's tenants (HTTP ${me.status}).`);
    process.exit(2);
  }
  const reachable = (me.body?.tenants ?? []).map((t) => Number(t.id));
  if (!reachable.includes(tenantId)) {
    console.error(
      `Refusing to run: the token does not reach tenant ${tenantId}.\n` +
        `It reaches ${reachable.join(", ") || "(none)"}.\n\n` +
        `This matters more than it looks: a token scoped to a SINGLE tenant ignores X-Tenant-Id\n` +
        `entirely, so every probe below would have run against ${reachable[0] ?? "another company"}\n` +
        `while --tenant and REAI_WRITE_TEST_TENANTS both said ${tenantId}.`,
    );
    process.exit(2);
  }
  if (reachable.length === 1) {
    console.log(
      `Note: this token reaches only tenant ${reachable[0]}, so X-Tenant-Id is ignored — which is ` +
        `fine here, because that tenant is the one requested and allowlisted.`,
    );
  }
}

/** Records created, so the `finally` can remove them. The idiom test/smoke-cleanup.test.mjs checks. */
const created = {};

const DATE = "2026-08-08";
const posting = (accountNumber, amount) => ({
  accountNumber,
  postingDate: DATE,
  amount,
  currency: "NOK",
  description: "Zz message audit probe",
});

/**
 * The API complaining about the REQUEST instead of evaluating the rule. BOTH shapes, because assuming
 * one of them is what made a malformed probe look like drift: a missing required field comes back as
 * `Validation failed` with `fieldErrors`, while a bad date or a non-numeric amount comes back as
 * `{"detail":"Failed to read request"}` with no fieldErrors at all.
 */
const SHAPE_ERROR = [
  /Failed to read request/i,
  /is required/i,
  /Cannot deserialize/i,
  /JSON parse error/i,
  /Failed to convert/i,
];

/**
 * `haystack` mirrors what the guarded code reads, so an OK here means the shipped match would fire:
 *   "message" — `err.message`, i.e. detail || title || rawBody. Does NOT include fieldErrors.
 *   "raw"     — detail + the whole body, which the sales.ts translations use deliberately.
 *   "detail"  — detail alone, for an anchored pattern.
 */
const messageOf = (body) => String(body?.detail ?? body?.title ?? JSON.stringify(body ?? ""));
const rawOf = (body) => `${body?.detail ?? ""} ${JSON.stringify(body ?? "")}`;

const CASES = [
  {
    id: "Bankkonto ikke funnet",
    where: "src/tools/bankvat.ts",
    pattern: /Bankkonto ikke funnet/,
    haystack: "message",
    expectStatus: 404,
    what: "the manual-reconciliation 404 a whole quirk is about",
    run: () => call("GET", "/api/manual-reconciliations/999999?month=2026-07"),
  },
  {
    id: "må posteres med underkonto",
    where: "src/tools/bookkeeping.ts",
    pattern: /må posteres med underkonto/,
    haystack: "message",
    expectStatus: 400,
    what: "an account that requires a sub-account",
    undo: (id) => call("DELETE", `/api/vouchers/${id}`),
    run: () =>
      call("POST", "/api/vouchers", {
        date: DATE,
        description: "Zz message audit probe (expected to fail)",
        postings: [posting("1320", 100), posting("1920", -100)],
      }),
  },
  {
    id: "må posteres med bankkonto",
    where: "src/tools/bookkeeping.ts",
    pattern: /må posteres med bankkonto/,
    haystack: "message",
    expectStatus: 400,
    what: "an account that requires a bank account",
    undo: (id) => call("DELETE", `/api/vouchers/${id}`),
    run: () =>
      call("POST", "/api/vouchers", {
        date: DATE,
        description: "Zz message audit probe (expected to fail)",
        postings: [posting("1920", 100), posting("3000", -100)],
      }),
  },
  {
    id: "does not support general sub-accounts",
    where: "src/tools/subaccounts.ts",
    pattern: /does not support general sub-accounts/,
    haystack: "message",
    expectStatus: 400,
    // A GET, which is what subaccounts.ts declares and catches from. The first version POSTed to
    // /api/general-sub-accounts — a different controller, and irreversible per classifyRequest.
    what: "reading sub-accounts for an account that cannot have them",
    run: () => call("GET", "/api/general-sub-accounts/accounts/3000"),
  },
  {
    id: "Creditor|Debtor with id=",
    where: "src/tools/loans.ts",
    pattern: /(Creditor|Debtor) with id=(\d+) not found/,
    haystack: "raw",
    expectStatus: 404,
    // Missed entirely by the first version, which only saw `.test(` and this uses `.exec(`. It needs
    // no loan to exist, so "tenant 2783 has no loans" never applied to it.
    what: "the wrong-table diagnosis in translateLoanError",
    undo: (id) => call("DELETE", `/api/loans/${id}`),
    run: () =>
      call("POST", "/api/loans", {
        reference: "Zz-audit-probe",
        loanType: "bank_loan",
        perspective: "borrower",
        counterpartyId: 999999,
        currency: "NOK",
        principalAmount: 1000,
        disbursementDate: DATE,
        // The counterparty is resolved AFTER the body is validated, so every required field has to be
        // present or the probe never reaches the rule. The classifier said so twice while this was
        // being written — first `currency`, then `interestRateAnnual` — and each time it named the
        // probe rather than loans.ts, which is the behaviour the three outcomes exist for.
        interestRateAnnual: 5,
        repaymentType: "annuity",
        maturityDate: "2030-08-08",
      }),
  },
  {
    id: "only be added to company customers",
    where: "src/tools/sales.ts",
    pattern: /only be added to company customers/,
    haystack: "raw",
    expectStatus: 400,
    what: "a contact person on a private customer",
    run: async () => {
      const made = await call("POST", "/api/customers", {
        name: "Zz Message Audit Private",
        privateContact: true,
      });
      created.privateCustomer = made.body?.id;
      if (!created.privateCustomer) {
        return { skip: `could not create the private customer probe (HTTP ${made.status})` };
      }
      return call("POST", `/api/customers/${created.privateCustomer}/contact-persons`, {
        name: "Zz Probe",
      });
    },
  },
  {
    id: "gyldig telefonnummer",
    where: "src/tools/sales.ts",
    pattern: /gyldig telefonnummer/,
    haystack: "raw",
    expectStatus: 400,
    what: "an unparseable phone number — only the REFUSAL, not the storage rule",
    // On the CONTACT-PERSON route, because that is where translateContactError consumes this string.
    // The first version PATCHed the customer's own phone: the same message today, but if the wording
    // ever diverged by route the audit would pass while the shipped translation was broken. Codex's
    // finding on #114. A company customer, since contacts are refused on private ones.
    run: async () => {
      const made = await call("POST", "/api/customers", {
        name: "Zz Message Audit Phone As",
        organizationNumber: "812345680",
        skipRegistryLookup: true,
      });
      created.phoneCustomer = made.body?.id;
      if (!created.phoneCustomer) {
        return { skip: `could not create the phone probe customer (HTTP ${made.status})` };
      }
      return call("POST", `/api/customers/${created.phoneCustomer}/contact-persons`, {
        name: "Zz Phone Probe",
        phone: "nonsense",
      });
    },
  },
  {
    id: "Contact person with id=",
    where: "src/tools/sales.ts",
    pattern: /Contact person with id=/,
    haystack: "raw",
    expectStatus: 404,
    what: "the ambiguous contact 404 — same wording for deleted and wrong-parent",
    run: async () => {
      const made = await call("POST", "/api/customers", {
        name: "Zz Message Audit Company As",
        organizationNumber: "812345672",
        skipRegistryLookup: true,
      });
      created.companyCustomer = made.body?.id;
      if (!created.companyCustomer) {
        return { skip: `could not create the company probe (HTTP ${made.status})` };
      }
      return call("GET", `/api/customers/${created.companyCustomer}/contact-persons/999999`);
    },
  },
  {
    id: "^Customer with id=",
    where: "src/tools/sales.ts",
    pattern: /^Customer with id=/,
    // Anchored and case-SENSITIVE in the shipped code, deliberately: matching it loosely is how a
    // healthy customer was once reported as nonexistent. So compare against `detail` alone.
    haystack: "detail",
    expectStatus: 404,
    what: "the missing-customer 404, which must stay distinguishable from the contact one",
    run: () => call("GET", "/api/customers/999999/contact-persons"),
  },
];

let ok = 0;
let drift = 0;
let inconclusive = 0;

/**
 * Wrapped in `main()` with a top-level `finally`, which is the shape test/smoke-cleanup.test.mjs
 * checks for — this script is now in its SUITES list, because the review of PR #114 pointed out a
 * third record-creating script had been written outside a guard that exists precisely because the
 * same cleanup mistake was made three times in three iterations.
 */
let unexpectedWrites = 0;

async function main() {
  await assertTokenReachesTenant();
  try {
    for (const probe of CASES) {
      let result;
      try {
        result = await probe.run();
      } catch (err) {
        inconclusive += 1;
        console.log(`INCONCLUSIVE  ${probe.id}\n              the probe threw: ${err.message}`);
        continue;
      }
      if (result.skip) {
        inconclusive += 1;
        console.log(`INCONCLUSIVE  ${probe.id}\n              ${result.skip}`);
        continue;
      }

      // A case is a request that should be REFUSED. If it succeeded, the precondition it relies on has
      // changed — account 1320 no longer requiring a sub-account, say — and the probe has just written
      // to real books. That is a safety failure, not a drift: Codex's finding on #114. Undo it if the
      // record is undoable, and say so loudly either way.
      if (result.status >= 200 && result.status < 300) {
        unexpectedWrites += 1;
        const id = result.body?.id;
        let undone = "nothing to undo";
        if (id && probe.undo) {
          const gone = await probe.undo(id);
          undone = `undo answered HTTP ${gone.status}`;
        } else if (id) {
          undone = `NOT UNDONE — record ${id} remains, and this probe declares no undo`;
        }
        console.error(
          `SAFETY        ${probe.id}\n` +
            `              expected a refusal and got HTTP ${result.status}. The precondition has ` +
            `changed and this probe WROTE to tenant ${tenantId}.\n` +
            `              ${undone}. ${probe.what} no longer refuses — fix the probe before running ` +
            `this again.`,
        );
        continue;
      }

      const detail = String(result.body?.detail ?? "");
      const haystack =
        probe.haystack === "detail"
          ? detail
          : probe.haystack === "raw"
            ? rawOf(result.body)
            : messageOf(result.body);
      const matches = probe.pattern.test(haystack);

      // Statuses that mean the request never got as far as the rule: authentication, throttling, a
      // server fault, or a period lock that refuses the write for an unrelated reason. Reporting any
      // of these as DRIFT would send someone to rewrite a correct regex — Codex's finding on #114, and
      // the hard-coded probe date makes the 409 case a matter of time rather than luck.
      const UNRELATED = [401, 403, 404, 405, 409, 429, 500, 502, 503, 504];
      if (!matches && result.status !== probe.expectStatus && UNRELATED.includes(result.status)) {
        inconclusive += 1;
        console.log(
          `INCONCLUSIVE  ${probe.id}\n` +
            `              HTTP ${result.status} — the request did not reach the rule (expected ` +
            `${probe.expectStatus}): ${detail.slice(0, 90)}\n` +
            `              Fix the probe or the environment. Do NOT touch ${probe.where}.`,
        );
        continue;
      }

      // A shape complaint means the rule was never evaluated — unless the pattern matched anyway, in
      // which case we plainly reached it.
      if (!matches && SHAPE_ERROR.some((p) => p.test(rawOf(result.body)))) {
        inconclusive += 1;
        console.log(
          `INCONCLUSIVE  ${probe.id}\n` +
            `              the request never reached the rule — HTTP ${result.status}: ${detail.slice(0, 100)}\n` +
            `              Fix the probe. Do NOT touch ${probe.where}.`,
        );
        continue;
      }

      if (matches && result.status === probe.expectStatus) {
        ok += 1;
        console.log(`OK            ${probe.id}\n              HTTP ${result.status}: ${detail.slice(0, 110)}`);
        continue;
      }

      drift += 1;
      if (matches) {
        // Wording held, status moved. Six sites gate on the status as well as the text, so this breaks
        // them just as thoroughly — and the first version could not see it at all.
        console.log(
          `DRIFT         ${probe.id}  (${probe.where})\n` +
            `              the wording still matches but the STATUS changed: expected ` +
            `${probe.expectStatus}, got ${result.status}\n` +
            `              Any translation gated on the status has stopped firing.`,
        );
      } else {
        console.log(
          `DRIFT         ${probe.id}  (${probe.where} depends on this)\n` +
            `              expected to match ${probe.pattern} in the ${probe.haystack} the code reads\n` +
            `              got HTTP ${result.status}: ${detail.slice(0, 140)}\n` +
            `              This is ${probe.what}. The translation is no longer firing.`,
        );
      }
    }
  } finally {
  // Cleanup is part of the result, not a courtesy: a record stranded on real books is a failure even
  // when every message matched. "archived" is NOT deleted, and an archived customer does not appear in
  // the default list, so it would otherwise vanish quietly.
  let leaked = 0;
  for (const [key, id] of Object.entries(created)) {
    if (!id) continue;
    try {
      const gone = await call("DELETE", `/api/customers/${id}`);
      if (gone.body?.outcome !== "deleted") {
        leaked += 1;
        console.error(
          `  !! ${key} (customer ${id}) was not deleted: ${JSON.stringify(gone.body)}\n` +
            `     Remove it by hand. "archived" counts as left behind.`,
        );
      }
    } catch (err) {
      leaked += 1;
      console.error(`  !! ${key} (customer ${id}) could not be deleted: ${err.message}`);
    }
  }
  console.log(`\n${ok} unchanged, ${drift} drifted, ${inconclusive} inconclusive`);
  if (drift > 0) {
    console.log(
      "\nA drifted message means an agent is now getting raw Norwegian where it used to get an\n" +
        "explanation. Re-measure the wording and update the pattern AND whatever quotes it.",
    );
  }
  if (leaked > 0) {
    console.error(`\n${leaked} record(s) left on tenant ${tenantId}. Remove them.`);
  }
    process.exit(drift > 0 || leaked > 0 || unexpectedWrites > 0 ? 1 : 0);
  }
}

await main();
