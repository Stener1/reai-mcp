#!/usr/bin/env node
/**
 * When this repository says "you send X and the API stores Y", is that still true?
 *
 * `scripts/audit-messages.mjs` checks the wording of REFUSALS, and says plainly that it cannot reach
 * the other half: every case there is a request built to fail, so nothing observes what the API
 * ACCEPTS, normalises or stores. Two of the five false claims that motivated that script live in this
 * half and were left unguarded:
 *
 *   - `skipRegistryLookup` promised "use exactly the details supplied". Sixteen of twenty-nine
 *     organisation numbers overwrite both name and address anyway. It drifts on a 201.
 *   - The phone rule was wrong three separate times, and what was wrong each time was a STORAGE claim:
 *     that foreign numbers come back "exactly as sent" (they are canonicalised), that a bare foreign
 *     number is refused (a Norway-valid one is silently stored under +47).
 *
 * A storage claim can only be checked by writing and reading back, so unlike the message audit this
 * script creates records. That is the whole difference, and it dictates the design:
 *
 *   - Only records this repo classifies REVERSIBLE. Customers, which delete cleanly.
 *   - Everything created is recorded in `created` and removed in a `finally`, and a record that
 *     cannot be confirmed deleted FAILS the run — `{"outcome":"archived"}` is not deleted, and an
 *     archived customer is invisible to the default list.
 *   - The token's own reachable tenants are checked before anything is written, because a token scoped
 *     to a single tenant IGNORES X-Tenant-Id, so an allowlisted `--tenant` proves nothing on its own.
 *
 * Three outcomes, for the reason the message audit needed them: a probe that could not create its
 * fixture has not disproved anything, and reporting that as drift would send someone to rewrite a
 * correct description.
 *
 *   OK            the stored value is what the claim says
 *   DRIFT         the fixture was created and the stored value contradicts the claim — act on this
 *   INCONCLUSIVE  the fixture could not be created; fix the probe, not the description
 *
 * Each case names the CONSTANT that makes the claim, so a failure points at the text to fix rather
 * than leaving someone to grep. `test/storage-drift.test.mjs` asserts those constants still contain
 * the claim, so editing one forces the probe to be revisited.
 *
 *   REAI_USER_API_TOKEN=… REAI_WRITE_TEST_TENANTS=2783 node scripts/audit-storage.mjs --tenant 2783
 */

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

const declaredTestTenants = (process.env.REAI_WRITE_TEST_TENANTS ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
if (declaredTestTenants.length === 0) {
  console.error(
    "REAI_WRITE_TEST_TENANTS is not set.\n\n" +
      "This script CREATES records — that is the only way to see what the API stores — so it runs\n" +
      "only against a tenant declared safe to write to:\n\n" +
      "  REAI_WRITE_TEST_TENANTS=2783 node scripts/audit-storage.mjs --tenant 2783\n\n" +
      "Do not list a tenant that holds a real business's books.",
  );
  process.exit(2);
}
if (!declaredTestTenants.includes(String(tenantId))) {
  console.error(
    `Refusing to write to tenant ${tenantId}: it is not in REAI_WRITE_TEST_TENANTS ` +
      `(${declaredTestTenants.join(", ")}).`,
  );
  process.exit(2);
}

const call = async (method, path, body, { omitTenant = false } = {}) => {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
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
 * The allowlist checks a number on the command line; this checks where the token actually points. A
 * token reaching exactly one tenant IGNORES X-Tenant-Id and answers for that tenant whatever value is
 * sent, so without this a run allowlisted for 2783 could write to a production company. Asked without
 * the tenant header, because with an unreachable one the answer is a 403 about the header.
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
      `Refusing to write: the token does not reach tenant ${tenantId}.\n` +
        `It reaches ${reachable.join(", ") || "(none)"}.\n\n` +
        `A token scoped to a single tenant IGNORES X-Tenant-Id, so every write below would have\n` +
        `landed on ${reachable[0] ?? "another company"} while --tenant said ${tenantId}.`,
    );
    process.exit(2);
  }
}

/** Records created, so the `finally` can remove them. The idiom test/smoke-cleanup.test.mjs checks. */
const created = {};
let serial = 0;

/**
 * A customer to read a stored value back off. PRIVATE by default: a company requires a valid
 * organisation number, and the entity phone and the name normalisation behave the same either way. The
 * first version omitted `privateContact` and every phone case came back INCONCLUSIVE with
 * "organizationNumber is required" — the classifier pointing at the probe, correctly, for the fourth
 * time across these two audits.
 */
async function makeCustomer(extra = {}) {
  serial += 1;
  const key = `customer${serial}`;
  const made = await call("POST", "/api/customers", {
    name: `Zz Storage Audit ${serial} As`,
    privateContact: true,
    ...extra,
  });
  if (made.status >= 300 || !made.body?.id) {
    return { problem: `POST /api/customers answered ${made.status}: ${made.body?.detail ?? ""}` };
  }
  created[key] = made.body.id;
  return { id: made.body.id, record: made.body };
}

/**
 * Read the record back, rather than trusting what the write echoed.
 *
 * A storage claim is about what is STORED, and the two are not the same thing: a create can echo a
 * field it silently dropped, and then an audit comparing against the response reports OK for a value
 * that was never written. Costs one request and removes that whole class of false pass.
 */
async function readBack(id) {
  const got = await call("GET", `/api/customers/${id}`);
  if (got.status !== 200) return { problem: `GET /api/customers/${id} answered ${got.status}` };
  return { record: got.body };
}

/**
 * Set a field the CREATE endpoint does not accept, then read it back.
 *
 * `phone` is not a create field — `reai_create_customer` says so, "set those with
 * reai_update_customer afterwards" — and sending it to POST /api/customers is silently ignored. The
 * first version of these probes did exactly that and reported four DRIFTs against PHONE_RULE, all
 * `stored null`, when the phone had simply never been written. Reading back confirmed it: the POST
 * response and the GET agreed on null. That is the fourth time across these two audits that a probe
 * was wrong rather than the description, which is why nothing here reports drift off a create alone.
 */
async function patchAndRead(field, value) {
  const made = await makeCustomer();
  if (made.problem) return { problem: made.problem };
  const patched = await call("PATCH", `/api/customers/${made.id}`, { [field]: value });
  if (patched.status >= 300) {
    return { problem: `PATCH ${field} answered ${patched.status}: ${patched.body?.detail ?? ""}` };
  }
  const back = await readBack(made.id);
  if (back.problem) return { problem: back.problem };
  return { record: back.record };
}

const CASES = [
  {
    claim: "a bare Norwegian number is stored as +47",
    source: "PHONE_RULE",
    marker: "canonicalised to E.164",
    run: async () => {
      const made = await patchAndRead("phone", "90123456");
      if (made.problem) return { problem: made.problem };
      return { got: made.record.phone, want: "+4790123456" };
    },
  },
  {
    claim: "a foreign E.164 number is kept, not rewritten to +47",
    source: "PHONE_RULE",
    marker: "ALWAYS include the country code",
    run: async () => {
      const made = await patchAndRead("phone", "+46701234567");
      if (made.problem) return { problem: made.problem };
      return { got: made.record.phone, want: "+46701234567" };
    },
  },
  {
    claim: "a foreign number is CANONICALISED, not stored as sent",
    source: "PHONE_RULE",
    marker: "not come back exactly as sent",
    // The claim three PRs got wrong. Sent with spaces; the point is that it does NOT come back with
    // them, which is the opposite of what two versions of this description said.
    run: async () => {
      const made = await patchAndRead("phone", "+46 70 123 45 67");
      if (made.problem) return { problem: made.problem };
      return { got: made.record.phone, want: "+46701234567" };
    },
  },
  {
    claim: "a bare number that is valid in Norway is stored under +47 whatever was meant",
    source: "PHONE_RULE",
    marker: "with no warning",
    // A real Danish mobile. The hazard the guidance leads with: stored as Norwegian, silently.
    run: async () => {
      const made = await patchAndRead("phone", "40123456");
      if (made.problem) return { problem: made.problem };
      return { got: made.record.phone, want: "+4740123456" };
    },
  },
  {
    claim: "an ordinary company keeps the name you send when skipRegistryLookup is set",
    source: "SKIP_REGISTRY_LOOKUP_RULE",
    marker: "keeps the name and address you send",
    run: async () => {
      serial += 1;
      const key = `customer${serial}`;
      const sent = `Zz Storage Ordinary ${serial} As`;
      const made = await call("POST", "/api/customers", {
        name: sent,
        organizationNumber: "923609016", // Equinor ASA — measured to respect the flag
        skipRegistryLookup: true,
      });
      if (made.status >= 300 || !made.body?.id) {
        return { problem: `POST /api/customers answered ${made.status}: ${made.body?.detail ?? ""}` };
      }
      created[key] = made.body.id;
      // Compared case-insensitively: the stored name is title-cased, which is its own claim below and
      // once made a probe report a KEPT name as overridden.
      return { got: String(made.body.name).toLowerCase(), want: sent.toLowerCase() };
    },
  },
  {
    claim: "a standard billing counterparty overwrites the name even with the flag set",
    source: "SKIP_REGISTRY_LOOKUP_RULE",
    marker: "overwrite both name and address regardless of the flag",
    run: async () => {
      serial += 1;
      const key = `customer${serial}`;
      const made = await call("POST", "/api/customers", {
        name: `Zz Storage Counterparty ${serial} As`,
        organizationNumber: "974761076", // Skatteetaten
        skipRegistryLookup: true,
      });
      if (made.status >= 300 || !made.body?.id) {
        return { problem: `POST /api/customers answered ${made.status}: ${made.body?.detail ?? ""}` };
      }
      created[key] = made.body.id;
      return { got: made.body.name, want: "Skatteetaten" };
    },
  },
  {
    claim: "the overriding directory is STALE, not the registry",
    source: "SKIP_REGISTRY_LOOKUP_RULE",
    marker: "stale",
    // The evidence for "not the registry": Brønnøysundregistrene calls 971648198
    // INNKREVINGSMYNDIGHETEN. If this ever comes back as the registry's name, the whole account of the
    // mechanism is wrong and the description needs rewriting.
    run: async () => {
      serial += 1;
      const key = `customer${serial}`;
      const made = await call("POST", "/api/customers", {
        name: `Zz Storage Stale ${serial} As`,
        organizationNumber: "971648198",
        skipRegistryLookup: true,
      });
      if (made.status >= 300 || !made.body?.id) {
        return { problem: `POST /api/customers answered ${made.status}: ${made.body?.detail ?? ""}` };
      }
      created[key] = made.body.id;
      return { got: made.body.name, want: "Statens Innkrevingssentral" };
    },
  },
  {
    claim: "a stored name is normalised to title case",
    source: "reai_create_customer description",
    marker: "title case",
    run: async () => {
      const made = await makeCustomer({ name: "Zz STORAGE CAPS AS" });
      if (made.problem) return { problem: made.problem };
      const back = await readBack(made.id);
      if (back.problem) return { problem: back.problem };
      return { got: back.record.name, want: "Zz Storage Caps As" };
    },
  },
];

let ok = 0;
let drift = 0;
let inconclusive = 0;

async function main() {
  await assertTokenReachesTenant();
  try {
    for (const probe of CASES) {
      let result;
      try {
        result = await probe.run();
      } catch (err) {
        inconclusive += 1;
        console.log(`INCONCLUSIVE  ${probe.claim}\n              the probe threw: ${err.message}`);
        continue;
      }
      if (result.problem) {
        inconclusive += 1;
        console.log(
          `INCONCLUSIVE  ${probe.claim}\n              could not create the fixture: ${result.problem}\n` +
            `              Fix the probe. This says nothing about ${probe.source}.`,
        );
        continue;
      }
      if (result.got === result.want) {
        ok += 1;
        console.log(`OK            ${probe.claim}\n              stored ${JSON.stringify(result.got)}`);
      } else {
        drift += 1;
        console.log(
          `DRIFT         ${probe.claim}\n` +
            `              ${probe.source} says this, and it is no longer true.\n` +
            `              expected ${JSON.stringify(result.want)}, stored ${JSON.stringify(result.got)}`,
        );
      }
    }
  } finally {
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
        "\nA drifted storage claim means a tool description is telling agents something false about\n" +
          "what gets written. Re-measure, then fix the named constant and everything quoting it.",
      );
    }
    if (leaked > 0) {
      console.error(`\n${leaked} record(s) left on tenant ${tenantId}. Remove them.`);
    }
    process.exit(drift > 0 || leaked > 0 ? 1 : 0);
  }
}

await main();
