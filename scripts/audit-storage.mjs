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
/** Suppliers, kept separately because they delete through a different path than customers. */
const createdSuppliers = {};
let serial = 0;

/**
 * Every id present before this run, PER RESOURCE, so anything new is ours regardless of its name.
 *
 * A baseline is needed because `created` is not sufficient: a create can succeed on the server and fail
 * on the way back — a 502 from a proxy, the 30s timeout, an unparseable body — and then the id was never
 * recorded, so the `finally` has nothing to delete. The review of PR #115 reproduced that with a proxy
 * returning 502 after forwarding the create.
 *
 * The first baseline keyed the sweep on a FIXTURE NAME, and the review of PR #116 showed that cannot
 * work here. Four probes exist precisely because the API OVERWRITES the name they send, so those records
 * end up called "Skatteetaten", "Statens Innkrevingssentral", "Vn Norge As" and "Telenor Norge As" — the
 * sweep was structurally unable to see them, and a proxy that dropped `id` left one on a real company's
 * books beneath a line reading "sweep clean". Suppliers had no baseline at all, so both supplier probes
 * leaked silently.
 *
 * So identity, not naming: anything present afterwards that was absent before came from this run.
 */
const baseline = { customers: new Set(), suppliers: new Set() };

const RESOURCES = [
  { key: "customers", path: "/api/customers", label: "customer" },
  { key: "suppliers", path: "/api/suppliers", label: "supplier" },
];

/**
 * Every page, not the first 200.
 *
 * `?size=200` with no check for more was the first version. A truncated baseline is worse than a missing
 * one: it makes a pre-existing record look new, and then the sweep deletes somebody else's row.
 */
async function listAll(path) {
  const rows = [];
  for (let page = 0; page < 50; page += 1) {
    const res = await call("GET", `${path}?size=200&page=${page}`);
    if (res.status !== 200) return { problem: `GET ${path} answered ${res.status}`, rows };
    const batch = Array.isArray(res.body) ? res.body : (res.body?.content ?? []);
    rows.push(...batch);
    const last = Array.isArray(res.body) ? true : (res.body?.last ?? batch.length < 200);
    if (last || batch.length === 0) return { rows };
  }
  return { problem: `${path} did not terminate after 50 pages`, rows };
}

async function takeBaseline() {
  for (const { key, path, label } of RESOURCES) {
    const before = await listAll(path);
    if (before.problem) {
      console.error(`Could not list ${label}s to take a baseline: ${before.problem}`);
      process.exit(2);
    }
    baseline[key] = new Set(before.rows.map((r) => r.id));
  }
}

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
    // NOT a probe problem. Creating the customer is fixture setup; the PATCH is the behaviour under
    // test, and every claim here says this value is ACCEPTED. A refusal therefore makes the claim false
    // and has to be reported as drift — Codex's finding on PR #115, where this returned `problem` and
    // the run exited 0 while PHONE_RULE had become wrong.
    return {
      rejected: `PATCH ${field}=${JSON.stringify(value)} was REFUSED with HTTP ${patched.status}: ` +
        `${patched.body?.detail ?? ""}`,
    };
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
    // The value the claim predicts, which the text must contain: a phrase can survive a rewrite that
    // reverses its meaning (the review of PR #115 did exactly that), a predicted value cannot.
    mustPredict: "sent bare or 0047-prefixed becomes +47",
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
    mustPredict: "+46701234567",
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
    mustPredict: "+46701234567",
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
    mustPredict: "40123456 became +4740123456",
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
    // No literal to pin: the claim predicts the stored value EQUALS what was sent, so the assertion is
    // structural. Declared rather than left to look like an omission.
    predictsEcho: true,
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
      const back = await readBack(made.body.id);
      if (back.problem) return { problem: back.problem };
      // Compared exactly, not lowercased. The first version lowercased both sides "because the stored
      // name is title-cased" — but the fixture is ALREADY title case, so title-casing cannot alter it,
      // and lowercasing only disabled detection of a future casing change while printing a value that
      // was never stored. The review of PR #115 measured that: sent title case comes back byte-identical.
      return { got: back.record.name, want: sent };
    },
  },
  {
    claim: "a standard billing counterparty overwrites the name even with the flag set",
    source: "SKIP_REGISTRY_LOOKUP_RULE",
    marker: "overwrite both name and address regardless of the flag",
    // The constant names the CLASS ("billing counterparties … the fee-collecting public agencies")
    // rather than this instance, which is right for a rule an agent reads — so what the text must
    // predict is the class, and the probe supplies one member of it.
    mustPredict: "fee-collecting public agencies",
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
      const back = await readBack(made.body.id);
      if (back.problem) return { problem: back.problem };
      // The claim is "overwrites the name", so what is asserted is that the stored value is NOT what was
      // sent. A hardcoded "Skatteetaten" would report DRIFT if the directory were merely renamed, which
      // would CONFIRM the account rather than refute it.
      const sent6 = `Zz Storage Counterparty ${serial} As`;
      return {
        got: back.record.name === sent6 ? `kept ${JSON.stringify(sent6)}` : "overwritten",
        want: "overwritten",
      };
    },
  },
  {
    claim: "the overriding directory is STALE, not the registry",
    source: "SKIP_REGISTRY_LOOKUP_RULE",
    marker: "That directory is stale",
    mustPredict: "971648198",
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
      const back = await readBack(made.body.id);
      if (back.problem) return { problem: back.problem };
      // Staleness is a claim ABOUT THE REGISTRY, so ask the registry rather than hardcoding a string.
      // A hardcoded "Statens Innkrevingssentral" fails two ways, both found by the review of PR #115: if
      // Brønnøysundregistrene ever converged on that name the case would still report OK while the
      // conclusion "stale, not the registry" became unfounded, and if ReAI updated its directory the case
      // would report DRIFT when what happened actually confirms the directory account. The real assertion
      // is that the two disagree. Brreg's open API needs no key.
      let registryName = null;
      try {
        const brreg = await fetch("https://data.brreg.no/enhetsregisteret/api/enheter/971648198", {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (brreg.ok) registryName = (await brreg.json())?.navn ?? null;
      } catch {
        // Left null; reported as inconclusive below rather than guessed at.
      }
      if (!registryName) {
        return { problem: "could not read 971648198 from Brønnøysundregistrene to compare against" };
      }
      const stored = String(back.record.name);
      // A fixed literal, not an interpolation of what was just read. The first version made `got` and
      // `want` the same expression, which reduced the case to `stored !== registryName` and printed the
      // comparison as if it were an expectation — the vacuous shape the review of PR #116 named.
      if (!stored) return { got: "the stored name is empty", want: "differs from the registry" };
      console.log(`              (stored ${JSON.stringify(stored)}, Brreg ${JSON.stringify(registryName)})`);
      return {
        got:
          stored.toLowerCase() === registryName.toLowerCase()
            ? "matches the registry"
            : "differs from the registry",
        want: "differs from the registry",
      };
    },
  },
  {
    claim: "a stored name is normalised to title case",
    source: "reai_create_customer description",
    marker: "normalizes the stored name to title case",
    mustPredict: "may not come back exactly as sent",
    run: async () => {
      const made = await makeCustomer({ name: "Zz STORAGE CAPS AS" });
      if (made.problem) return { problem: made.problem };
      const back = await readBack(made.id);
      if (back.problem) return { problem: back.problem };
      return { got: back.record.name, want: "Zz Storage Caps As" };
    },
  },
  {
    claim: "a supplier's stored name is title-cased too, not only a customer's",
    source: "reai_create_supplier description",
    marker: "normalizes stored names to title case",
    mustPredict: "Acme As",
    // Named by the review of PR #115 as cheap and unprobed, and it ships its own vector: the description
    // says "acme as" becomes "Acme As". Suppliers delete cleanly, so this is as reversible as a customer.
    run: async () => {
      serial += 1;
      const key = `supplier${serial}`;
      const made = await call("POST", "/api/suppliers", { name: "Zz Storage supplier caps as" });
      if (made.status >= 300 || !made.body?.id) {
        return { problem: `POST /api/suppliers answered ${made.status}: ${made.body?.detail ?? ""}` };
      }
      createdSuppliers[key] = made.body.id;
      const back = await call("GET", `/api/suppliers/${made.body.id}`);
      if (back.status !== 200) return { problem: `GET /api/suppliers/${made.body.id} → ${back.status}` };
      return { got: back.body.name, want: "Zz Storage Supplier Caps As" };
    },
  },
  {
    claim: "title-casing applies on UPDATE as well as create",
    source: "customer-name-title-cased quirk",
    marker: "normalizes stored names to title case",
    mustPredict: "comes back \"Acme As\"",
    // The quirk lists both methods; probe 8 only ever covered POST.
    run: async () => {
      const made = await makeCustomer();
      if (made.problem) return { problem: made.problem };
      const patched = await call("PATCH", `/api/customers/${made.id}`, { name: "Zz STORAGE PATCHED CAPS" });
      if (patched.status >= 300) {
        return { problem: `PATCH name answered ${patched.status}: ${patched.body?.detail ?? ""}` };
      }
      const back = await readBack(made.id);
      if (back.problem) return { problem: back.problem };
      return { got: back.record.name, want: "Zz Storage Patched Caps" };
    },
  },
  {
    claim: "phone sent to CREATE is silently discarded, which is why the phone probes patch",
    source: "reai_create_customer description",
    marker: "not among them — set those with reai_update_customer",
    mustPredict: "Invoice email, phone and payment terms are not among them",
    // Measured against the API rather than asserted about our own Zod schema. This is the fact that cost
    // four false DRIFTs in the first version of this script, and it was pinned only as a schema check.
    run: async () => {
      const made = await makeCustomer({ phone: "90123456" });
      if (made.problem) return { problem: made.problem };
      const back = await readBack(made.id);
      if (back.problem) return { problem: back.problem };
      return { got: back.record.phone === null ? "discarded" : `stored ${back.record.phone}`, want: "discarded" };
    },
  },
  {
    claim: "the same phone rule holds on a CONTACT PERSON, not only the customer's own field",
    source: "PHONE_RULE",
    marker: "canonicalised to E.164",
    mustPredict: "+46701234567",
    // PHONE_RULE ships on five fields — customer, supplier, lead and both contact-person tools — and the
    // audit measured one. Codex's finding on PR #115. This is also the field whose quirk claimed foreign
    // numbers are "stored EXACTLY as sent" until this PR measured otherwise, so it is the field most
    // worth watching.
    run: async () => {
      serial += 1;
      const key = `customer${serial}`;
      const made = await call("POST", "/api/customers", {
        name: `Zz Storage Contact ${serial} As`,
        organizationNumber: "812345672",
        skipRegistryLookup: true,
      });
      if (made.status >= 300 || !made.body?.id) {
        return { problem: `POST /api/customers answered ${made.status}: ${made.body?.detail ?? ""}` };
      }
      created[key] = made.body.id;
      const contact = await call("POST", `/api/customers/${made.body.id}/contact-persons`, {
        name: "Zz Storage Contact Phone",
        phone: "+46 70 123 45 67",
      });
      if (contact.status >= 300) {
        return {
          rejected: `POST contact-persons with a spaced foreign number was REFUSED with HTTP ` +
            `${contact.status}: ${contact.body?.detail ?? ""}`,
        };
      }
      const back = await call("GET", `/api/customers/${made.body.id}/contact-persons`);
      if (back.status !== 200) return { problem: `GET contact-persons → ${back.status}` };
      const row = (back.body ?? [])[0];
      return { got: row?.phone, want: "+46701234567" };
    },
  },
  {
    claim: "WITHOUT the flag the registry name replaces yours — the default path agents take",
    source: "reai_create_customer description",
    marker: "The name you send is then DISCARDED",
    mustPredict: "stores \"Skatteetaten\"",
    // The flagship claim of the create tool, and it was unprobed while both flag cases were covered —
    // named in the census as the most valuable gap. No skipRegistryLookup here on purpose.
    run: async () => {
      serial += 1;
      const key = `customer${serial}`;
      const sent = `Zz Storage Noflag ${serial} As`;
      const made = await call("POST", "/api/customers", {
        name: sent,
        // NOT 974761076: the flag case above already created a customer named "Skatteetaten", and the
        // second create collides on the organisation number — refused with
        // "En kunde med navnet Skatteetaten finnes allerede", the quirk this repo documents about a
        // duplicate org number being reported as a duplicate NAME. Reported INCONCLUSIVE, correctly, so
        // this case uses a company no other case touches.
        organizationNumber: "821083052", // VN Norge AS
      });
      if (made.status >= 300 || !made.body?.id) {
        return { problem: `POST /api/customers answered ${made.status}: ${made.body?.detail ?? ""}` };
      }
      created[key] = made.body.id;
      const back = await readBack(made.body.id);
      if (back.problem) return { problem: back.problem };
      // NOT `stored !== sent`: the review of PR #116 proxied the read-back to return `name: null` and
      // this reported OK — a name DESTROYED satisfying a claim that it is REPLACED. Two hazards with
      // opposite fixes. So assert what the claim actually says: the stored name is the registry's.
      const stored = back.record.name;
      if (!stored) return { got: "the stored name is empty", want: "replaced with the registry's name" };
      let registryName = null;
      try {
        const brreg = await fetch("https://data.brreg.no/enhetsregisteret/api/enheter/821083052", {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (brreg.ok) registryName = (await brreg.json())?.navn ?? null;
      } catch {
        // reported as inconclusive rather than guessed at
      }
      if (!registryName) {
        return { problem: "could not read 821083052 from Brønnøysundregistrene to compare against" };
      }
      // Title-cased on the way in, so compared case-insensitively — the repo documents that separately.
      return {
        got:
          stored.toLowerCase() === registryName.toLowerCase()
            ? "replaced with the registry's name"
            : `stored ${JSON.stringify(stored)}, which is neither what I sent nor the registry's ` +
              `${JSON.stringify(registryName)}`,
        want: "replaced with the registry's name",
      };
    },
  },
  {
    claim: "an address you supply survives on an ordinary company with the flag set",
    source: "SKIP_REGISTRY_LOOKUP_RULE",
    marker: "keeps the name and address you send",
    predictsEcho: true,
    // The ADDRESS half of a claim whose name half was probed and whose address half was not — which the
    // review of PR #115 pointed out is where the documented hazard actually lives.
    run: async () => {
      serial += 1;
      const key = `customer${serial}`;
      const made = await call("POST", "/api/customers", {
        name: `Zz Storage Addr Keep ${serial} As`,
        organizationNumber: "915772137", // Symfoni AS — measured to respect the flag
        skipRegistryLookup: true,
        addressPart1: "Probegata 1",
        postalCode: "0001",
        city: "Probeby",
      });
      if (made.status >= 300 || !made.body?.id) {
        return { problem: `POST /api/customers answered ${made.status}: ${made.body?.detail ?? ""}` };
      }
      created[key] = made.body.id;
      const back = await readBack(made.body.id);
      if (back.problem) return { problem: back.problem };
      const a = back.record.address ?? {};
      return {
        got: [a.addressPart1, a.postalCode, a.city].join(", "),
        want: "Probegata 1, 0001, Probeby",
      };
    },
  },
  {
    claim: "a directory counterparty overwrites the address you supply, with the WRONG postcode",
    source: "SKIP_REGISTRY_LOOKUP_RULE",
    marker: "976967631 with the wrong postcode",
    mustPredict: "976967631",
    // The hazard with real consequence: an agent could invoice to this address. The claim is specific —
    // Brreg says 1331 Fornebu, ReAI stores 7900 Rørvik — so it is checkable against the registry rather
    // than against a remembered string.
    run: async () => {
      serial += 1;
      const key = `customer${serial}`;
      const made = await call("POST", "/api/customers", {
        name: `Zz Storage Addr Over ${serial} As`,
        organizationNumber: "976967631",
        skipRegistryLookup: true,
        addressPart1: "Probegata 1",
        postalCode: "0001",
        city: "Probeby",
      });
      if (made.status >= 300 || !made.body?.id) {
        return { problem: `POST /api/customers answered ${made.status}: ${made.body?.detail ?? ""}` };
      }
      created[key] = made.body.id;
      const back = await readBack(made.body.id);
      if (back.problem) return { problem: back.problem };
      const a = back.record.address ?? {};
      const stored = [a.addressPart1, a.postalCode, a.city].filter(Boolean).join(", ");
      if (stored === "Probegata 1, 0001, Probeby") return { got: "kept mine", want: "overwritten" };
      // An address that is simply GONE is not an address overwritten with a wrong postcode, and the two
      // have opposite fixes. The review of PR #116 proxied the read-back to return no address and this
      // reported OK with the word "undefined" in the line, still counting toward the headline number.
      if (!a.postalCode) {
        return { got: "no address was stored at all", want: "overwritten with a different postcode" };
      }

      // And it should disagree with the registry, which is what "wrong postcode" means.
      let registryPostcode = null;
      try {
        const brreg = await fetch("https://data.brreg.no/enhetsregisteret/api/enheter/976967631", {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (brreg.ok) {
          const body = await brreg.json();
          // BOTH, because they disagree for this company — 1331 (postadresse) and 1360
          // (forretningsadresse) — and preferring one made "differs from the registry" depend on which
          // was present. "Wrong" has to mean wrong against every address the registry holds.
          registryPostcode = [
            body?.postadresse?.postnummer,
            body?.forretningsadresse?.postnummer,
          ].filter(Boolean);
        }
      } catch {
        // reported as inconclusive rather than guessed at
      }
      if (!registryPostcode || registryPostcode.length === 0) {
        return { problem: "could not read 976967631's postcode(s) from Brønnøysundregistrene" };
      }
      const matchesRegistry = registryPostcode.includes(a.postalCode);
      return {
        got: matchesRegistry
          ? `matches a registry postcode (${a.postalCode})`
          : "overwritten with a postcode the registry does not hold",
        want: "overwritten with a postcode the registry does not hold",
      };
    },
  },
  {
    claim: "countryCode defaults to NO when omitted",
    source: "reai_create_customer countryCode argument",
    marker: "Defaults to \"NO\"",
    mustPredict: "Defaults to \"NO\"",
    // Cheap, named in the census, and it settles a question the description does not: whether that
    // default is the API's or this server's. Nothing is sent, so the answer is upstream's.
    run: async () => {
      const made = await makeCustomer();
      if (made.problem) return { problem: made.problem };
      const back = await readBack(made.id);
      if (back.problem) return { problem: back.problem };
      return { got: back.record.address?.countryCode ?? null, want: "NO" };
    },
  },
  {
    claim: "the same phone rule holds on a SUPPLIER, the fourth field it governs",
    source: "PHONE_RULE",
    marker: "canonicalised to E.164",
    mustPredict: "sent bare or 0047-prefixed becomes +47",
    run: async () => {
      serial += 1;
      const key = `supplier${serial}`;
      const made = await call("POST", "/api/suppliers", { name: `Zz Storage Supp Phone ${serial} As` });
      if (made.status >= 300 || !made.body?.id) {
        return { problem: `POST /api/suppliers answered ${made.status}: ${made.body?.detail ?? ""}` };
      }
      createdSuppliers[key] = made.body.id;
      const patched = await call("PATCH", `/api/suppliers/${made.body.id}`, { phone: "90123456" });
      if (patched.status >= 300) {
        return {
          rejected: `PATCH supplier phone="90123456" was REFUSED with HTTP ${patched.status}: ` +
            `${patched.body?.detail ?? ""}`,
        };
      }
      const back = await call("GET", `/api/suppliers/${made.body.id}`);
      if (back.status !== 200) return { problem: `GET /api/suppliers/${made.body.id} → ${back.status}` };
      return { got: back.body.phone, want: "+4790123456" };
    },
  },
];

let ok = 0;
let drift = 0;
let inconclusive = 0;

async function main() {
  await assertTokenReachesTenant();
  await takeBaseline();
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
      if (result.rejected) {
        drift += 1;
        console.log(
          `DRIFT         ${probe.claim}\n` +
            `              ${probe.source} says this value is accepted. It is not.\n` +
            `              ${result.rejected}`,
        );
        continue;
      }
      if (result.problem) {
        inconclusive += 1;
        // "could not create the fixture" was wrong for the registry cases, where the fixture was created
        // and deleted fine and the fix is neither the probe nor the description — it is that Brreg was
        // unreachable. The message says what actually failed.
        console.log(
          `INCONCLUSIVE  ${probe.claim}\n              ${result.problem}\n` +
            `              Not verified either way. This says nothing about ${probe.source}.`,
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
        if (gone.status >= 300 || gone.body?.outcome !== "deleted") {
          leaked += 1;
          console.error(
            `  !! ${key} (customer ${id}) was not deleted: HTTP ${gone.status} ` +
              `${JSON.stringify(gone.body)}\n     Remove it by hand. "archived" counts as left behind.`,
          );
        }
      } catch (err) {
        leaked += 1;
        console.error(`  !! ${key} (customer ${id}) could not be deleted: ${err.message}`);
      }
    }

    for (const [key, id] of Object.entries(createdSuppliers)) {
      if (!id) continue;
      try {
        const gone = await call("DELETE", `/api/suppliers/${id}`);
        if (gone.status >= 300 || gone.body?.outcome !== "deleted") {
          leaked += 1;
          console.error(
            `  !! ${key} (supplier ${id}) was not deleted: HTTP ${gone.status} ` +
              `${JSON.stringify(gone.body)}\n     Remove it by hand. "archived" counts as left behind.`,
          );
        }
      } catch (err) {
        leaked += 1;
        console.error(`  !! ${key} (supplier ${id}) could not be deleted: ${err.message}`);
      }
    }

    // The part `created` cannot cover: anything the server made whose id never reached this script.
    // By IDENTITY against the baseline, for every resource written — the name-based version could not see
    // the four probes whose names the API overwrites, nor suppliers at all.
    for (const { key, path, label } of RESOURCES) {
      try {
        const after = await listAll(path);
        if (after.problem) {
          leaked += 1;
          console.error(`  !! could not re-list ${label}s to sweep for orphans: ${after.problem}`);
          continue;
        }
        const orphans = after.rows.filter((r) => !baseline[key].has(r.id));
        for (const orphan of orphans) {
          const gone = await call("DELETE", `${path}/${orphan.id}`);
          const removed = gone.status < 300 && gone.body?.outcome === "deleted";
          if (!removed) leaked += 1;
          console.error(
            `  !! orphan ${label} ${orphan.id} ${JSON.stringify(orphan.name)} was created without its ` +
              `id reaching this script — ${removed ? "removed by the sweep" : "COULD NOT REMOVE"}.`,
          );
        }

        // Re-read AFTER the deletions, which the first version did not: it re-filtered the same
        // pre-delete rows, so "the tenant must end where it started" was never actually measured.
        const settled = await listAll(path);
        const remaining = settled.problem
          ? null
          : settled.rows.filter((r) => !baseline[key].has(r.id));
        if (remaining === null) {
          leaked += 1;
          console.error(`  !! could not confirm the ${label} list settled: ${settled.problem}`);
        } else if (remaining.length > 0) {
          leaked += remaining.length;
          console.error(
            `  !! ${remaining.length} ${label}(s) beyond the baseline remain: ` +
              remaining.map((r) => `${r.id} ${JSON.stringify(r.name)}`).join(", "),
          );
        } else {
          console.log(`Sweep: ${label}s are back to the ${baseline[key].size} present before the run.`);
        }
      } catch (err) {
        leaked += 1;
        console.error(`  !! sweeping ${label}s threw: ${err.message}`);
      }
    }
    console.log(`\n${ok} unchanged, ${drift} drifted, ${inconclusive} inconclusive (of ${CASES.length})`);
    if (inconclusive > 0) {
      console.error(
        `\n${inconclusive} claim(s) could NOT be verified, so "${CASES.length} of ${CASES.length}" is ` +
          `not what this run established. That is a non-zero exit on purpose: a third-party outage or a ` +
          `broken probe silently downgrading the headline number is how a green run comes to mean less ` +
          `than it says.`,
      );
    }
    if (drift > 0) {
      console.log(
        "\nA drifted storage claim means a tool description is telling agents something false about\n" +
          "what gets written. Re-measure, then fix the named constant and everything quoting it.",
      );
    }
    if (leaked > 0) {
      console.error(`\n${leaked} record(s) left on tenant ${tenantId}. Remove them.`);
    }
    // Exit codes distinguish the three: 1 = a claim is false or a record leaked, 3 = something could not
    // be verified. The review of PR #116 stubbed Brønnøysundregistrene and watched "17 of 17" become 15
    // with the run still green.
    process.exit(drift > 0 || leaked > 0 ? 1 : inconclusive > 0 ? 3 : 0);
  }
}

// An interrupt mid-run would otherwise leave every fixture behind, since the `finally` never executes.
// The handler cannot await, so it reports what to remove rather than pretending to remove it. BOTH maps
// and the right label for each: the first version enumerated `created` only and called every entry a
// customer, so an interrupt after a supplier probe left suppliers behind unreported.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    const outstanding = [
      ...Object.entries(created).map(([k, id]) => [k, id, "customer"]),
      ...Object.entries(createdSuppliers).map(([k, id]) => [k, id, "supplier"]),
    ].filter(([, id]) => id);
    if (outstanding.length > 0) {
      console.error(
        `\n${signal} with ${outstanding.length} fixture(s) still on tenant ${tenantId}:\n` +
          outstanding.map(([k, id, label]) => `  ${k}: ${label} ${id}`).join("\n") +
          `\nRemove them by hand; an interrupted run cannot finish its own cleanup.`,
      );
    }
    process.exit(130);
  });
}

await main();
