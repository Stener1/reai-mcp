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
    config: { writeMode: "read-only", tenantId: 2634 },
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

async function conflatesEmptyWithSurprise(tool) {
  const empty = await against(tool, EMPTY_SHAPE[tool.name] ?? []);
  const wrapped = await against(tool, { content: [{ id: 1, name: "A real row" }], totalElements: 1 });
  if (!empty.called || !wrapped.called) return null; // never read the body
  if (wrapped.threw) return `threw on an unexpected shape — ${wrapped.threw.slice(0, 60)}`;
  // A tool that never states a quantity cannot state a wrong one.
  if (!EMPTY_SHAPE[tool.name] && !(await statesACount(tool))) return null;
  if (empty.note === wrapped.note) return `same note for [] and {content:[…]}: ${empty.note.split("\n")[0].slice(0, 64)}`;
  return null;
}

test("no read tool gives the same answer for an empty list and a shape surprise", async () => {
  // A floor, because this sweep narrows and a narrowing filter that stops matching leaves the assertions
  // below about the empty set. See test/README.md — the audit that found this class listed thirty sweeps
  // passing with an emptied registry, and my first pass wrongly claimed this one had no filter to break.
  {
    const { registeredTools } = await import("../dist/server.js");
    const reads = registeredTools.filter((t) => t.risk === "read");
    assert.ok(reads.length >= 30, `only ${reads.length} read tools — the risk filter has stopped matching`);
  }
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
  // Floor: same read filter as the sweep above, same failure mode if it stops matching.
  const reads = registeredTools.filter((t) => t.risk === "read");
  assert.ok(reads.length >= 30, `only ${reads.length} read tools — the risk filter has stopped matching`);
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
    if (!text.includes(marker)) swallowed.push(`${tool.name}: ${text.split("\n")[0].slice(0, 70)}`);
  }
  assert.deepEqual(swallowed, [], "a tool dropped the response and said nothing about it");
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
