#!/usr/bin/env node
/**
 * Does the API still say what this repository claims it says?
 *
 * Twelve places in `src/` pattern-match on the TEXT of a ReAI error to turn it into something an
 * agent can act on: a Norwegian validation message becomes an explanation and a next step. Every one
 * of those regexes is a silent dependency on upstream wording. If a message is rephrased, the match
 * stops firing, the translation disappears, and the agent gets the raw Norwegian instead — with
 * nothing failing anywhere. This repository has already shipped one such case: a quirk quoted
 * "…kan skrives uten +" while the live string was "…kan skrives uten +47.".
 *
 * So the wording is checked rather than trusted. Each case below is a request DESIGNED TO FAIL, which
 * is what makes this safe to run against a real tenant: a refused write creates nothing. The two
 * three cases that need a customer to exist create one, delete it in a `finally`, and shout if the
 * deletion did not take.
 *
 * THREE outcomes, not two, and the third is the point:
 *
 *   OK            the shipped regex matches what came back
 *   DRIFT         the request reached the rule and the wording no longer matches — act on this
 *   INCONCLUSIVE  the request never reached the rule (usually a shape error in the probe itself)
 *
 * That distinction is not decoration. Writing this, two probes reported DRIFT because the voucher
 * body was missing `postings[].postingDate` and then `postings[].currency` — the API answered
 * "Validation failed" about MY request and never evaluated the account rule at all. A two-outcome
 * audit would have sent someone to rewrite two regexes that were perfectly correct. An audit that
 * cannot tell "the wording changed" from "I asked wrongly" is worse than no audit.
 *
 *   REAI_USER_API_TOKEN=… REAI_WRITE_TEST_TENANTS=2783 node scripts/audit-messages.mjs --tenant 2783
 */

const args = process.argv.slice(2);
const tenantArg = args.indexOf("--tenant");
const tenantId = tenantArg >= 0 ? Number(args[tenantArg + 1]) : undefined;
const token = process.env.REAI_USER_API_TOKEN;
const baseUrl = process.env.REAI_BASE_URL ?? "https://app.reai.no";

if (!token) {
  console.error("REAI_USER_API_TOKEN is not set.");
  process.exit(2);
}
if (!tenantId) {
  console.error("Pass --tenant <id>.");
  process.exit(2);
}

// The same guard the write scripts carry, for the same reason: most cases here are refused writes,
// but "refused" is a property of the request being wrong, and a probe can be wrong in the other
// direction too. A tenant holding real books must be opted in deliberately or not at all.
const declaredTestTenants = (process.env.REAI_WRITE_TEST_TENANTS ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
if (!declaredTestTenants.includes(String(tenantId))) {
  console.error(
    `Refusing to run against tenant ${tenantId}: it is not in REAI_WRITE_TEST_TENANTS ` +
      `(${declaredTestTenants.join(", ") || "unset"}).\n\n` +
      `Every case here is a request designed to FAIL, so nothing should be created — but a probe that\n` +
      `is wrong in the other direction would write to real books, so the opt-in is required anyway.`,
  );
  process.exit(2);
}

const call = async (method, path, body) => {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Tenant-Id": String(tenantId),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try { parsed = await res.json(); } catch {}
  return { status: res.status, body: parsed };
};

const DATE = "2026-08-08";
const posting = (accountNumber, amount) => ({
  accountNumber,
  postingDate: DATE,
  amount,
  currency: "NOK",
  description: "Zz message audit probe",
});

/**
 * `shapeError` is how a case says "this response is about my request, not about the rule". ReAI puts
 * request-shape complaints in `fieldErrors`, so their presence means the rule was never reached.
 */
const CASES = [
  {
    id: "Bankkonto ikke funnet",
    where: "src/tools/bankvat.ts",
    pattern: /Bankkonto ikke funnet/,
    what: "the manual-reconciliation 404, whose ambiguity a whole quirk is about",
    run: () => call("GET", `/api/manual-reconciliations/999999?month=2026-07`),
  },
  {
    id: "må posteres med underkonto",
    where: "src/tools/bookkeeping.ts",
    pattern: /må posteres med underkonto/,
    what: "an account that requires a sub-account, reported per line",
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
    what: "an account that requires a bank account, reported per line",
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
    what: "creating a sub-account under an account that cannot have one",
    run: () => call("POST", "/api/general-sub-accounts", { accountNumber: "3000", name: "Zz Probe" }),
  },
  {
    id: "registrerte transaksjoner og kan ikke slettes",
    where: "src/tools/investments.ts",
    pattern: /registrerte transaksjoner og kan ikke slettes/,
    what: "a share position that has transactions and so cannot be removed",
    run: async () => {
      const list = await call("GET", "/api/share-investments");
      const rows = list.body?.content ?? list.body ?? [];
      if (!Array.isArray(rows) || rows.length === 0) {
        return { skip: "no share investments in this tenant to attempt a delete on" };
      }
      return call("DELETE", `/api/share-investments/${rows[0].id}`);
    },
  },
  {
    id: "only be added to company customers",
    where: "src/tools/sales.ts",
    pattern: /only be added to company customers/,
    what: "a contact person on a private customer",
    run: async () => {
      const created = await call("POST", "/api/customers", {
        name: "Zz Message Audit Private",
        privateContact: true,
      });
      const id = created.body?.id;
      if (!id) return { skip: `could not create the private customer probe (HTTP ${created.status})` };
      try {
        return await call("POST", `/api/customers/${id}/contact-persons`, { name: "Zz Probe" });
      } finally {
        const gone = await call("DELETE", `/api/customers/${id}`);
        if (gone.body?.outcome !== "deleted") {
          console.error(`  !! probe customer ${id} was not deleted: ${JSON.stringify(gone.body)}`);
        }
      }
    },
  },
  {
    id: "gyldig telefonnummer",
    where: "src/tools/sales.ts",
    pattern: /gyldig telefonnummer/,
    what: "an unparseable phone number, whose whole guidance hangs off this string",
    // A nonexistent customer id was the first attempt, and the audit correctly called it
    // INCONCLUSIVE: the 404 arrives before the phone is parsed, so the rule was never reached. It
    // needs a real customer — the PATCH itself still fails, so the phone is never stored.
    run: async () => {
      const created = await call("POST", "/api/customers", {
        name: "Zz Message Audit Phone",
        privateContact: true,
      });
      const id = created.body?.id;
      if (!id) return { skip: `could not create the phone probe customer (HTTP ${created.status})` };
      try {
        return await call("PATCH", `/api/customers/${id}`, { phone: "nonsense" });
      } finally {
        const gone = await call("DELETE", `/api/customers/${id}`);
        if (gone.body?.outcome !== "deleted") {
          console.error(`  !! probe customer ${id} was not deleted: ${JSON.stringify(gone.body)}`);
        }
      }
    },
    reachedRule: (r) => r.status === 400,
  },
  {
    id: "Contact person with id=",
    where: "src/tools/sales.ts",
    pattern: /Contact person with id=/,
    what: "the ambiguous contact 404 — same wording for deleted and wrong-parent",
    run: async () => {
      const created = await call("POST", "/api/customers", {
        name: "Zz Message Audit Company As",
        organizationNumber: "812345672",
        skipRegistryLookup: true,
      });
      const id = created.body?.id;
      if (!id) return { skip: `could not create the company probe (HTTP ${created.status})` };
      try {
        return await call("GET", `/api/customers/${id}/contact-persons/999999`);
      } finally {
        const gone = await call("DELETE", `/api/customers/${id}`);
        if (gone.body?.outcome !== "deleted") {
          console.error(`  !! probe customer ${id} was not deleted: ${JSON.stringify(gone.body)}`);
        }
      }
    },
  },
  {
    id: "Customer with id=",
    where: "src/tools/sales.ts",
    pattern: /^Customer with id=/,
    what: "the missing-customer 404, which must stay distinguishable from the one above",
    run: () => call("GET", "/api/customers/999999/contact-persons"),
    detailOnly: true, // the shipped regex is anchored, so compare it against `detail` alone
  },
];

let ok = 0;
let drift = 0;
let inconclusive = 0;

for (const probe of CASES) {
  const result = await probe.run();
  if (result.skip) {
    inconclusive += 1;
    console.log(`INCONCLUSIVE  ${probe.id}\n              ${result.skip}`);
    continue;
  }
  const detail = result.body?.detail ?? "";
  const fieldErrors = result.body?.fieldErrors ?? [];
  const haystack = probe.detailOnly ? String(detail) : `${detail} ${JSON.stringify(result.body ?? "")}`;

  // Did the request reach the rule at all? A `fieldErrors` list is the API complaining about the
  // request's SHAPE, which means the rule was never evaluated.
  const reached = probe.reachedRule
    ? probe.reachedRule(result)
    : fieldErrors.length === 0 || probe.pattern.test(haystack);
  if (!reached) {
    inconclusive += 1;
    console.log(
      `INCONCLUSIVE  ${probe.id}\n              the probe never reached the rule — HTTP ${result.status}, ` +
        `fieldErrors: ${fieldErrors.map((f) => f.message).join("; ")}\n` +
        `              Fix the probe, do NOT touch ${probe.where}.`,
    );
    continue;
  }
  if (probe.pattern.test(haystack)) {
    ok += 1;
    console.log(`OK            ${probe.id}\n              HTTP ${result.status}: ${String(detail).slice(0, 110)}`);
  } else {
    drift += 1;
    console.log(
      `DRIFT         ${probe.id}  (${probe.where} depends on this)\n` +
        `              expected to match ${probe.pattern}\n` +
        `              got HTTP ${result.status}: ${String(detail).slice(0, 140)}\n` +
        `              This is ${probe.what}. The translation is no longer firing.`,
    );
  }
}

console.log(`\n${ok} unchanged, ${drift} drifted, ${inconclusive} inconclusive`);
if (drift > 0) {
  console.log(
    "\nA drifted message means an agent is now getting raw Norwegian where it used to get an\n" +
      "explanation. Re-measure the new wording and update the regex AND whatever quotes it.",
  );
}
process.exit(drift > 0 ? 1 : 0);
