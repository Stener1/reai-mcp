import { test } from "node:test";
import assert from "node:assert/strict";
import { registeredTools } from "../dist/server.js";
import { okList } from "../dist/tools/registry.js";

/**
 * "The API returned nothing" and "the API returned something I did not expect" are
 * different answers, and only one of them means the company has no customers.
 *
 * Thirteen list tools wrote `Array.isArray(data) ? data.length : 0` and stated that number,
 * so a 200 carrying `{content: [...]}` — a shape this API already uses on `/api/leads` and
 * `/api/warehouses/inventory` — came back as "0 customer(s)". The rows themselves survived;
 * every one of those tools still passed `res.data` to `ok()`, so only the sentence was
 * false. Nothing is wrong on today's endpoints. The day one starts paginating, thirteen
 * tools begin answering "there are none" about a company's customers, invoices and
 * vouchers, and an agent would believe them.
 *
 * The sweep below is how that was found, kept as a test so the fourteenth list tool cannot
 * reintroduce it.
 */

/** Plausible arguments for a tool, so its handler runs rather than failing validation. */
function argumentsFor(tool) {
  const args = { tenantId: 2634 };
  for (const [name, schema] of Object.entries(tool.inputSchema ?? {})) {
    if (name === "tenantId" || schema.isOptional?.()) continue;
    args[name] = /month/i.test(name)
      ? "2026-07"
      : /date/i.test(name)
        ? "2026-01-01"
        : /id$|number|count|year/i.test(name)
          ? 1
          : "1";
  }
  return args;
}

/** Run a read tool against a stubbed 200, reporting whether it consumed the body. */
async function against(tool, data) {
  let called = false;
  const ctx = {
    client: {
      request: async () => {
        called = true;
        return { data, status: 200 };
      },
      deepLink: () => "link",
    },
    // `defaultTenantId`, which is the key the real config carries — `tenantId` was dead here, in a
    // harness whose whole value is fidelity. It never showed because argumentsFor() seeds tenantId
    // into the ARGUMENTS, so resolveTenantId returns the explicit value and never reads the config.
    // Named by the review of PR #108, along with the correction that this is why breaking
    // config.defaultTenantId does not move these two sweeps' counts — not, as I wrote in a commit
    // message, because they "never go through resolveTenantId". They do; it just answers earlier.
    config: { writeMode: "read-only", defaultTenantId: 2634 },
    session: {},
  };
  let text;
  try {
    const result = await tool.handler(argumentsFor(tool), ctx);
    text = result.content.find((c) => c.type === "text")?.text ?? "";
  } catch (err) {
    // A throw BEFORE the request is uninteresting — bad stub arguments. A throw AFTER it is
    // the sweep's business: `res.data.map(...)` on a wrapper shape is the most natural way a
    // fourteenth list tool acquires this bug, and swallowing it here left the guard green.
    return { called, text: "", threw: called ? String(err) : undefined };
  }
  return { called, text, note: noteOf(text) };
}

/**
 * The NOTE, without the serialised body.
 *
 * `ok()` returns `note + "\n\n" + body`, so comparing whole results always finds a
 * difference — the bodies differ even when the sentence above them is identically wrong.
 * The first version of the comparison below did exactly that, and passed happily with the
 * bug reintroduced in `reai_list_customers`: "0 customer(s)." for both inputs, but the
 * payloads differed, so it saw two distinct answers. The claim being tested is about what
 * the tool SAYS.
 */
function noteOf(text) {
  return text.split("\n\n")[0] ?? "";
}

/**
 * The property, stated without matching prose: a tool must answer DIFFERENTLY for "the API
 * returned an empty list" and "the API returned something that is not a list".
 *
 * The first version of this sweep grepped the note for claims of emptiness and exempted
 * hedging phrases. That was fragile in both directions. It exempted a fully buggy tool,
 * because this repo's own empty-message for departments contains "not the same as" — revert
 * organisation.ts to the inline count and all four tests stayed green. And it then flagged
 * two CORRECT tools for the words in their disclaimers: "nothing below states one" and
 * "Neither side was reported by the endpoint". Chasing that with a longer regex is
 * whack-a-mole against English.
 *
 * Comparing the two answers needs no vocabulary at all. If a tool cannot tell an empty list
 * from a shape it did not expect, its note is identical for both, and that is the bug.
 */
/**
 * What "the API returned nothing" looks like for a tool that reads a FIELD of the response
 * rather than the response itself.
 *
 * For those, a bare `[]` is just as shapeless as `{content: […]}`, so comparing the two
 * would flag them for answering the same thing about two equally-broken inputs — which is
 * correct behaviour, not the bug. Each entry says which field the tool reads; the test below
 * asserts every override is load-bearing, so one cannot be used to hide a real conflation.
 */
const EMPTY_SHAPE = {
  reai_whoami: { tenants: [] },
  reai_use_tenant: { tenants: [] },
  reai_reconcile_ui: { pendingTransactionCount: 0, pendingPostingCount: 0, pendingTransactions: [], pendingPostings: [] },
};

/**
 * Whether a tool's note depends on HOW MANY rows came back.
 *
 * Only a tool that states a count can state a false one. A single-record getter whose note
 * is a deep link, or a ledger that states only its date range, answers the same thing for
 * every input — correctly, because it is claiming nothing about quantity. Detected by
 * whether one row and two rows produce different notes, so this needs no vocabulary either.
 */
async function statesACount(tool) {
  const one = await against(tool, [{ id: 1, name: "A" }]);
  const two = await against(tool, [{ id: 1, name: "A" }, { id: 2, name: "B" }]);
  return one.called && two.called && one.note !== two.note;
}

/** How many tools this sweep really compared, as opposed to filtered and then skipped. */
let conflateExamined = 0;

async function conflatesEmptyWithSurprise(tool) {
  const empty = await against(tool, EMPTY_SHAPE[tool.name] ?? []);
  const wrapped = await against(tool, { content: [{ id: 1, name: "A real row" }], totalElements: 1 });
  if (!empty.called || !wrapped.called) return null; // never read the body
  if (wrapped.threw) return `threw on an unexpected shape — ${wrapped.threw.slice(0, 60)}`;
  // A tool that never states a quantity cannot state a wrong one.
  if (!EMPTY_SHAPE[tool.name] && !(await statesACount(tool))) return null;
  conflateExamined += 1;
  if (empty.note === wrapped.note) return `same note for [] and {content:[…]}: ${empty.note.split("\n")[0].slice(0, 64)}`;
  return null;
}

test("no read tool gives the same answer for an empty list and a shape surprise", async () => {
  // A population floor is not enough here: every tool in this sweep can be SKIPPED at runtime
  // (the stub never reached the request, or the tool states no count), and a harness that stops
  // reaching the request skips all of them while the population stays intact. Found by the
  // independent review of PR #108: breaking tenant resolution took this sweep from 52 tools
  // examined to 7, and it still passed. So the floor counts what was actually exercised.
  conflateExamined = 0;
  const offenders = [];
  for (const tool of registeredTools) {
    if (tool.risk !== "read" || tool.name === "reai_request") continue;
    const verdict = await conflatesEmptyWithSurprise(tool);
    if (verdict) offenders.push(`${tool.name}: ${verdict}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "a tool told the model there is nothing, about a response that contained something",
  );
  assert.ok(
    conflateExamined >= 31,
    `only ${conflateExamined} tools were actually compared (of 42 today) — the sweep is skipping its subjects`,
  );
});

// An override is a claim that `[]` is not this tool's empty shape. If the tool answers the
// same for its override as for a wrapper, the override is hiding a conflation rather than
// describing one.
test("every empty-shape override is load-bearing", async () => {
  const useless = [];
  for (const [name, shape] of Object.entries(EMPTY_SHAPE)) {
    const tool = registeredTools.find((t) => t.name === name);
    assert.ok(tool, `override names an unknown tool: ${name}`);
    const override = await against(tool, shape);
    const bare = await against(tool, []);
    const wrapped = await against(tool, { content: [{ id: 1 }] });
    assert.notEqual(override.note, wrapped.note, `${name}: override answers the same as a surprise`);
    // And it has to be NEEDED — if `[]` already differed from the surprise, the tool reads
    // the root as a list and does not belong here.
    if (bare.note !== wrapped.note) useless.push(name);
  }
  assert.deepEqual(useless, [], "these tools read the response root as a list; drop the override");
});

test("and the rows are not thrown away either", async () => {
  // Reporting the surprise is only half of it: the payload has to survive, or an operator
  // cannot see what the endpoint actually sent. Checked by marker rather than by wording.
  // Floor on tools actually exercised, for the reason given on the sweep above.
  let exercised = 0;
  const marker = "UNIQUE-MARKER-9c1f";
  const wrapped = { content: [{ id: 1, name: marker }], totalElements: 1 };
  const swallowed = [];
  for (const tool of registeredTools) {
    if (tool.risk !== "read" || tool.name === "reai_request") continue;
    // A field-reader never echoes a root-level row, and is not expected to: whoami rebuilds
    // its payload deliberately. Its own version of this property — that the unexpected value
    // reaches the result — is asserted in test/meta.test.mjs against rawTenants.
    if (EMPTY_SHAPE[tool.name]) continue;
    const { called, text } = await against(tool, wrapped);
    if (!called || !text) continue;
    exercised += 1;
    if (!text.includes(marker)) swallowed.push(`${tool.name}: ${text.split("\n")[0].slice(0, 70)}`);
  }
  assert.deepEqual(swallowed, [], "a tool dropped the response and said nothing about it");
  assert.ok(
    exercised >= 51,
    `only ${exercised} read tools echoed anything (of 68 today) — the sweep is skipping its subjects`,
  );
});

test("okList separates the three answers", () => {
  const note = (result) => result.content[0].text.split("\n")[0];

  // Empty is an answer.
  assert.match(note(okList([], { noun: "customer", suffix: "." })), /^0 customer\(s\)\./);
  assert.match(
    note(okList([], { noun: "department", empty: "No departments are defined." })),
    /No departments are defined\./,
  );
  // A list is counted.
  assert.match(note(okList([{ id: 1 }, { id: 2 }], { noun: "order", suffix: "." })), /^2 order\(s\)\./);
  // Anything else is neither, and says so — and the body survives.
  const surprise = okList({ content: [{ id: 7 }] }, { noun: "order", suffix: "." });
  assert.match(note(surprise), /did not return a list/);
  assert.match(note(surprise), /NOT a report of "no orders"/);
  // "unchanged" was a promise okList cannot keep: ok() truncates a large payload and says so.
  assert.doesNotMatch(note(surprise), /unchanged/);
  // A fact-carrying suffix survives at zero — because the tools that have one pass no
  // `empty`, which is how orders, offers and invoices actually call this.
  const widened = okList([], { noun: "order", suffix: ". Window widened back to 2000-01-01." });
  assert.equal(note(widened), "0 order(s). Window widened back to 2000-01-01.");
  // And `empty` replaces the note outright, rather than appending a sentence about what a
  // collection returns when it returned nothing. This produced a doubled full stop live.
  const none = okList([], { noun: "employee", suffix: ". The collection returns id and name.", empty: "No employees are registered." });
  assert.equal(note(none), "No employees are registered.");
  assert.match(surprise.content[0].text, /"id": 7/);
  // null and undefined are not lists either, and must not be counted as zero.
  for (const value of [null, undefined, "text", 42]) {
    assert.match(note(okList(value, { noun: "invoice", suffix: "." })), /did not return a list/);
  }
});

// The helper exists so there is ONE implementation. Hand-written variants are how three
// tools ended up with three different sentences for the same situation.
test("list tools use the shared helper rather than counting inline", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL("../src/tools/", import.meta.url);
  const inline = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    // Comments quote the bug on purpose — okList's own docstring names the shape it
    // replaced — so strip them before scanning, or the guard flags its own explanation.
    const source = readFileSync(new URL(file, dir), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // The exact shape that caused this: coerce a non-array to a count of zero.
    for (const match of source.matchAll(/Array\.isArray\([^)]*\)\s*\?\s*[^:]*\.length\s*:\s*0/g)) {
      inline.push(`${file}: ${match[0].slice(0, 60)}`);
    }
  }
  assert.deepEqual(inline, [], "use okList — counting a non-array as zero is the bug this file is about");
});

// whoami rebuilds its payload deliberately, so the marker sweep skips it — which means the
// same property needs asserting here: the value the API actually sent has to reach the
// result, since the note promises it. It previously said "the raw response is below" while
// ok() received a rebuilt object whose tenants field was `[]`.
test("whoami surfaces the tenant value it could not read", async () => {
  const { registeredTools: tools } = await import("../dist/server.js");
  const whoami = tools.find((t) => t.name === "reai_whoami");
  const run = async (data, config = {}) => {
    const ctx = {
      client: { request: async () => ({ data, status: 200 }), deepLink: () => "link" },
      config: { writeMode: "read-only", ...config },
      session: {},
    };
    return (await whoami.handler({}, ctx)).content[0].text;
  };

  const surprise = await run({ email: "a@b.no", tenants: { content: [{ id: 99 }] } });
  assert.match(surprise, /which companies this token reaches is UNKNOWN/);
  assert.match(surprise, /rawTenants/, "the note promises the raw value; it has to be there");
  assert.match(surprise, /"id": 99/);
  // And none of the count-derived sentences may fire on a list that never arrived.
  assert.doesNotMatch(surprise, /reaches 0 companies/);
  assert.doesNotMatch(surprise, /reaches exactly one company/);
  assert.doesNotMatch(surprise, /the tenant header is load-bearing/);

  // The confident-wrong-answer that reai_use_tenant refuses to give, one function away.
  const withActive = await run({ email: "a@b.no", tenants: null }, { defaultTenantId: 2634 });
  assert.match(withActive, /Whether this token reaches it could not be checked/);
  assert.doesNotMatch(withActive, /is NOT in this token's tenant list/);

  // A bound connection must not have the raw payload leak the companies the binding hides.
  const bound = await run({ email: "a@b.no", tenants: { content: [{ id: 77, companyName: "Other" }] } }, { boundTenantId: 2634 });
  assert.doesNotMatch(bound, /Other/, "the binding hides the other companies; the raw value must not leak them");
  assert.doesNotMatch(bound, /under rawTenants/, "and the note must not promise a value the payload withholds");
  assert.match(bound, /raw value is withheld because this connection is bound/);

  // The normal path is untouched.
  const normal = await run({ email: "a@b.no", tenants: [{ id: 1, companyName: "One" }] });
  assert.match(normal, /reaches exactly one company/);
  assert.doesNotMatch(normal, /UNKNOWN/);
  assert.doesNotMatch(normal, /rawTenants/);
});

// A bound connection is a disclosure boundary, not just an addressing one — reai_whoami
// filters its tenant list for that reason. The boundary was tool-dependent: GET /api/me
// through the escape hatch returned every company the underlying token reaches, and the
// recovery instruction added in this PR pointed an agent straight at it.
test("the tenant-disclosure boundary holds whichever tool is used", async () => {
  const { registeredTools: tools } = await import("../dist/server.js");
  const request = tools.find((t) => t.name === "reai_request");
  const whoami = tools.find((t) => t.name === "reai_whoami");
  const others = /SOMEONE ELSES COMPANY|ANOTHER CLIENT/;
  const me = {
    email: "a@b.no",
    tenants: [
      { id: 2634, companyName: "Bound Company" },
      { id: 1581, companyName: "SOMEONE ELSES COMPANY" },
      { id: 2613, companyName: "ANOTHER CLIENT" },
    ],
  };
  const ctx = (data, config) => ({
    client: { request: async () => ({ data, status: 200 }), deepLink: () => "link" },
    config: { writeMode: "read-only", allowExternalSend: false, ...config },
    session: {},
  });
  const text = async (tool, args, data, config) =>
    (await tool.handler(args, ctx(data, config))).content[0].text;

  const bound = { boundTenantId: 2634 };
  const viaHatch = await text(request, { method: "GET", path: "/api/me" }, me, bound);
  assert.doesNotMatch(viaHatch, others, "the escape hatch must not disclose what the binding hides");
  assert.match(viaHatch, /Bound Company/, "and it must still return the bound company");
  assert.match(viaHatch, /Filtered to tenant 2634/, "silently filtering would be its own surprise");
  assert.doesNotMatch(await text(whoami, {}, me, bound), others);

  // An unrecognised shape is withheld rather than assumed harmless.
  const wrapped = { email: "a@b.no", tenants: { content: [{ id: 1581, companyName: "SOMEONE ELSES COMPANY" }] } };
  const viaWrapper = await text(request, { method: "GET", path: "/api/me" }, wrapped, bound);
  assert.doesNotMatch(viaWrapper, others);
  assert.match(viaWrapper, /tenants field was withheld/);

  // /api/tenants is the same disclosure, and it can come back as a bare array.
  const bare = await text(request, { method: "GET", path: "/api/tenants" }, me.tenants, bound);
  assert.doesNotMatch(bare, others);

  // With no binding there is no boundary, and the full list is the correct answer.
  assert.match(await text(request, { method: "GET", path: "/api/me" }, me, {}), others);
});

/**
 * The same question one step further out: does any tool THROW on a 200 it did not expect?
 *
 * The sweep above covers read tools and what they SAY. This one covers every tool, including the writes, and
 * what they DO — because for a write the failure mode is worse than a wrong sentence. A handler that throws
 * after its POST returned 200 hands the caller something indistinguishable from the call never landing, so an
 * agent's natural next move is to retry an irreversible write.
 *
 * Found four that way: `reai_create_expense` (`(expense.costs ?? []).filter` on a non-array),
 * `reai_match_bank_transactions`, `reai_add_salary_line` and `reai_get_user`. Two declared irreversible. Every
 * one type-checked, because the declared response types are this repo's reading of the API rather than a
 * promise from it — which is the whole reason a `?? []` fallback is not enough and `asArray` exists.
 */

/** A minimal value satisfying a zod schema, so write tools can be driven past their own validation. */
function sampleFor(schema, key, depth = 0) {
  const def = schema?._def;
  if (!def || depth > 4) return { skip: "undrivable" };
  const kind = def.typeName;
  if (kind === "ZodOptional" || kind === "ZodNullable" || kind === "ZodDefault") return { skip: "optional" };
  if (kind === "ZodEffects") return sampleFor(def.schema, key, depth + 1);
  if (kind === "ZodEnum") return { value: def.values[0] };
  if (kind === "ZodNativeEnum") return { value: Object.values(def.values)[0] };
  if (kind === "ZodLiteral") return { value: def.value };
  if (kind === "ZodBoolean") return { value: false };
  if (kind === "ZodNumber") return { value: (def.checks ?? []).some((c) => c.kind === "int") ? 7 : 7.5 };
  if (kind === "ZodString") {
    const checks = def.checks ?? [];
    const pattern = checks.find((c) => c.kind === "regex")?.regex;
    if (pattern) {
      // Candidates rather than a generator: these are the shapes this API's regexes actually ask for.
      for (const candidate of ["2026-08-09", "2026-08", "1500", "NO", "NOK", "12345678901", "930000000", "0150", "ZZ"])
        if (pattern.test(candidate)) return { value: candidate };
      return { skip: "undrivable" };
    }
    if (/date/i.test(key)) return { value: "2026-08-09" };
    const max = checks.find((c) => c.kind === "max")?.value ?? 40;
    return { value: "ZZ probe".slice(0, Math.max(2, Math.min(max, 40))) };
  }
  if (kind === "ZodArray") {
    const inner = sampleFor(def.type, key, depth + 1);
    if (inner.skip) return (def.minLength?.value ?? 1) > 0 ? { skip: "undrivable" } : { value: [] };
    return { value: [inner.value] };
  }
  if (kind === "ZodObject") {
    const out = {};
    for (const [k, v] of Object.entries(def.shape())) {
      const r = sampleFor(v, k, depth + 1);
      if (r.skip === "optional") continue;
      if (r.skip) return { skip: "undrivable" };
      out[k] = r.value;
    }
    return { value: out };
  }
  if (kind === "ZodUnion") {
    for (const option of def.options) {
      const r = sampleFor(option, key, depth + 1);
      if (!r.skip) return r;
    }
    return { skip: "undrivable" };
  }
  return { skip: "undrivable" };
}

test("no tool throws on a 200 whose shape is not what its declared type promises", async () => {
  const { z } = await import("zod");
  // A plausible record, then variants that keep the keys and break the shapes. The array-to-string case is the
  // one that found all four; the others are here because a wrapper or a bare string is equally undeclared.
  const base = {
    id: 4242, number: "ZZ-1", name: "ZZ", status: "open", webUrl: "https://x", amounts: {},
    lines: [{ id: 1 }], rows: [{ id: 1 }], costs: [{}], perDiems: [{}], mileageAllowances: [{}],
    employees: [{ wageSpecs: [{ id: 1 }] }], errors: [], roles: ["a"], roleCodes: ["a"],
    directPermissionCodes: [], effectivePermissionCodes: [], contactEvents: [{}], postings: [{}],
    transactions: [{}], users: [{}], wageSpecs: [{ id: 1 }], data: [], content: [],
    reconciledTransactionIds: [1], reconciledPostingIds: [1], voucherIds: [1],
  };
  const swap = (fn) => Object.fromEntries(Object.entries(base).map(([k, v]) => [k, Array.isArray(v) ? fn() : v]));
  const bodies = [
    ["a bare string", "unexpected"],
    ["an array at the top level", [base]],
    ["arrays returned as strings", swap(() => "oops")],
    ["arrays returned as objects", swap(() => ({ a: 1 }))],
    ["arrays returned as null", swap(() => null)],
  ];

  const failures = [];
  const undrivable = [];
  for (const tool of registeredTools) {
    const args = { tenantId: 2783 };
    let blocked = false;
    for (const [name, schema] of Object.entries(tool.inputSchema ?? {})) {
      if (name === "tenantId") continue;
      const picked = sampleFor(schema, name);
      if (picked.skip === "optional") continue;
      if (picked.skip) { blocked = true; break; }
      args[name] = picked.value;
    }
    const parsed = blocked ? undefined : z.object(tool.inputSchema ?? {}).safeParse(args);
    if (!parsed?.success) { undrivable.push(tool.name); continue; }
    for (const [label, data] of bodies) {
      let reached = false;
      let call = 0;
      try {
        await tool.handler(parsed.data, {
          client: {
            // The hostile body goes to the FIRST request; later requests get the plausible record.
            //
            // Returning it to every endpoint hid branches, which review found concretely: `reai_get_user` reads
            // its user record and then `/api/users/roles`, and feeding the malformed body to BOTH made the roles
            // lookup return nothing, so the guard exited before ever touching the malformed field. The sweep
            // reported the tool safe for exactly the shape it was meant to test.
            request: async () => {
              reached = true;
              call += 1;
              return { data: call === 1 ? data : base, status: 200 };
            },
            deepLink: () => "link",
          },
          config: { writeMode: "full", tenantId: 2783, allowExternalSend: false },
          session: {},
        });
      } catch (err) {
        // Only a throw AFTER the request matters. Before it means the stub arguments were wrong, which is this
        // harness's problem and not the tool's — the same distinction the sweep above draws.
        if (reached) failures.push(`${tool.name} [${tool.risk}] on ${label}: ${String(err.message).slice(0, 90)}`);
      }
    }
  }

  assert.deepEqual(
    failures,
    [],
    `these tools threw on a 200 they did not expect, AFTER the request went out — for a write that reads as ` +
      `the call never landing:\n  ${failures.join("\n  ")}`,
  );

  // The tools this harness cannot drive are named, not counted away. A silent skip is how a guard stops
  // guarding: the count is asserted so a new undrivable tool has to be looked at rather than absorbed.
  assert.deepEqual(
    undrivable.sort(),
    [
      // Measured, not guessed: the first version of this list had `reai_request` in it, which this harness
      // drives fine, and omitted `reai_update_agreement`, which it cannot.
      "reai_create_agreement",
      "reai_create_subscription",
      "reai_create_voucher",
      "reai_update_agreement",
    ],
    `the set of tools this sweep cannot generate arguments for has changed. It is not covered by this test — ` +
      `either teach sampleFor the shape it needs, or accept the gap deliberately: ${undrivable.join(", ")}`,
  );
});

test("no truncation note or description promises a paging parameter the tool does not have", async () => {
  // The shared array-truncation note used to end "or use the limit/page parameters". Measured against the live
  // API and the spec, that was wrong twice over:
  //
  //   - 102 of 105 curated GET endpoints declare NO paging parameter, and only three tools expose one, so for
  //     almost every tool that can emit the note the advice named something unreachable;
  //   - passing it anyway does not fail. `GET /api/postings` with `limit=5`, `page=2` and `size=5` each returned
  //     all 160 rows, 200, no complaint — so an agent that followed the advice would believe it had limited a
  //     result it had not.
  //
  // The property, stated generally so a fourteenth list tool cannot reintroduce it: nothing an agent reads may
  // name a paging argument unless the tool it is reading actually takes one.
  const { okList } = await import("../dist/tools/registry.js");
  const PAGING = ["limit", "page", "size", "offset", "pageSize"];

  /**
   * Does this text promise a paging parameter the reader cannot use?
   *
   * The first version was `/\b(limit|page)\s+(parameter|argument)|use the (limit|page)\b|paginat/i` and review
   * defeated it with the repo's OWN house style: every parameter name in this codebase is written in backticks,
   * and `` `limit` parameter `` has a backtick where that regex demands whitespace. Eleven of thirteen realistic
   * phrasings bypassed it — ``pass `limit` to cap the rows``, `accepts offset and limit for paging`,
   * `use limit=50`, `the limit param`, `results are paged 50 at a time`. It caught essentially only the one
   * literal phrasing that had just been deleted.
   *
   * So: strip the punctuation that decorates parameter names, then look for a paging WORD near paging language.
   * Per-parameter, because the old check skipped a tool entirely as soon as it exposed any paging key — review
   * added "use the page parameter and the offset parameter" to `reai_list_accounts`, which takes only `limit`,
   * and it passed. That is the allowlist-shaped exemption this repo has been bitten by before.
   */
  const promisesParam = (text, param) => {
    const bare = text.replace(/[`'"*]/g, "").toLowerCase();
    // WARNING about a parameter is the opposite of promising it, and the first version of this check could not
    // tell them apart: it flagged `reai_list_accounts`, whose description says "there is no paging at all
    // (offset and page are accepted and ignored)" — a measured warning, and the very fact the new quirk
    // generalises. A guard that punishes honest text teaches people to delete it.
    const warns = new RegExp(
      `(no paging|not supported|unsupported|ignored|has none|takes no|do not|does not|cannot|never)` +
        `[^.]{0,60}?\\b${param}\\b|\\b${param}\\b[^.]{0,60}?` +
        `(are ignored|is ignored|accepted and ignored|not supported|has no effect|does nothing)`,
      "i",
    );
    // Known limit, stated rather than contorted around: a genuine false promise in the SAME sentence as an
    // unrelated "no paging" remark is suppressed. Sixteen realistic phrasings were checked against this and it
    // gets them all; the contrived overlap is not worth widening the regex and re-flagging honest text.
    if (warns.test(bare)) return false;
    const near = new RegExp(
      `\\b${param}\\b[^.]{0,40}?(parameter|param\\b|argument|arg\\b|=|to (cap|page|limit|walk)|for paging)` +
        `|\\b(use|pass|supply|send|set|increment|walk)\\b[^.]{0,20}?\\b${param}\\b` +
        `|\\b${param}\\b[^.]{0,20}?\\b(paging|paged|pagination|next batch|per page)\\b` +
        `|\\b(paging|paged|pagination)\\b[^.]{0,20}?\\b${param}\\b`,
      "i",
    );
    return near.test(bare);
  };

  // BOTH arms of the truncation note. Review put the original false advice into the count === 0 arm and this
  // test passed, because the fixture only drove the other one — half the notes in the function it guards.
  const bulky = Array.from({ length: 400 }, (_, i) => ({ id: i, filler: "x".repeat(200) }));
  const oneHuge = [{ id: 1, blob: "z".repeat(40000) }, { id: 2 }, { id: 3 }];
  for (const [label, fixture, expected] of [
    ["truncated", bulky, /response truncated/],
    ["nothing fits", oneHuge, /nothing is shown/],
  ]) {
    const note = okList(fixture, { noun: "posting" }).content
      .map((c) => c.text ?? "")
      .join("\n")
      .split("\n\n")[0];
    assert.match(note, expected, `the ${label} fixture must drive its own arm: ${note}`);
    for (const param of PAGING) {
      assert.ok(
        !promisesParam(note, param),
        `the ${label} note promises \`${param}\`, which its callers do not have: ${note}`,
      );
    }
    // And it must still say something USEFUL — deleting the advice entirely would pass the checks above.
    assert.match(note, /filters|by id/, `the ${label} note must still say what to do instead: ${note}`);
  }

  const offenders = [];
  for (const tool of registeredTools) {
    const exposes = new Set(PAGING.filter((k) => k in (tool.inputSchema ?? {})));
    const readable = [
      tool.description ?? "",
      ...Object.values(tool.inputSchema ?? {}).map((schema) => schema?._def?.description ?? ""),
    ].join(" ");
    for (const param of PAGING) {
      // Per parameter: exposing `limit` does not license talking about `page`.
      if (!exposes.has(param) && promisesParam(readable, param)) offenders.push(`${tool.name}.${param}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these tools tell a caller about a paging parameter they do not accept: ${offenders.join(", ")}`,
  );
  // What mutation testing could NOT pin here, said plainly rather than left as an implied guarantee: with zero
  // offenders today, reverting the per-parameter check to the old skip-the-whole-tool version fails nothing —
  // an emptiness assertion cannot demonstrate its own strictness. The per-parameter and backtick behaviour was
  // instead verified directly against seventeen phrasings, including the ones review used to bypass the first
  // version. The two arms of the truncation note ARE pinned: putting the old advice back in either fails by name.
});
