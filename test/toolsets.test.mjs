import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { allTools, alwaysOnTools, registeredTools, selectTools, TOOL_GROUPS } from "../dist/server.js";
import { loadConfig, TOOLSETS } from "../dist/config.js";
import { classifyRequest } from "../dist/policy.js";
import { findOperation } from "../dist/reai/spec.js";

/**
 * The premise of this server is that 320 API operations cannot all be tools. As
 * the curated set grows the same pressure applies to it, so an operator can
 * narrow it — without ever losing reach, since discovery stays on.
 */

/**
 * Every documentation file as one string: the README and each page under `docs/`.
 *
 * These two tests assert that a rule the CODE enforces is written down. Reading only README.md made
 * them assertions about layout as well, and the README split had to work around them.
 */
function docsCorpus(base) {
  const repo = join(dirname(fileURLToPath(base)), "..");
  const files = ["README.md", ...readdirSync(join(repo, "docs")).filter((f) => f.endsWith(".md")).map((f) => join("docs", f))];
  return files.map((f) => readFileSync(join(repo, f), "utf8")).join("\n");
}

test("every curated tool belongs to exactly one group", () => {
  const grouped = Object.values(TOOL_GROUPS).flat();
  const names = grouped.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "a tool appears in two groups");
  assert.equal(allTools.length, alwaysOnTools.length + grouped.length);
});

test("group names match the documented toolset list", () => {
  assert.deepEqual(Object.keys(TOOL_GROUPS).sort(), [...TOOLSETS].sort());
});

test("no selection means everything", () => {
  assert.equal(selectTools([]).length, allTools.length);
});

test("selecting one group keeps it plus the always-on tools", () => {
  const only = selectTools(["bookkeeping"]);
  const names = new Set(only.map((t) => t.name));

  for (const t of alwaysOnTools) assert.ok(names.has(t.name), `${t.name} must always be present`);
  for (const t of TOOL_GROUPS.bookkeeping) assert.ok(names.has(t.name), `${t.name} missing`);
  for (const t of TOOL_GROUPS.sales) assert.ok(!names.has(t.name), `${t.name} should be excluded`);
  for (const t of TOOL_GROUPS.purchase) assert.ok(!names.has(t.name), `${t.name} should be excluded`);
});

test("orientation and the escape hatch are never groupable away", () => {
  const names = new Set(selectTools(["purchase"]).map((t) => t.name));
  for (const required of [
    "reai_whoami",
    "reai_use_tenant",
    "reai_search_endpoints",
    "reai_describe_endpoint",
    "reai_request",
  ]) {
    assert.ok(names.has(required), `${required} must survive any toolset selection`);
  }
});

test("selecting several groups unions them", () => {
  const two = selectTools(["sales", "purchase"]);
  assert.equal(
    two.length,
    alwaysOnTools.length + TOOL_GROUPS.sales.length + TOOL_GROUPS.purchase.length,
  );
});

test("REAI_TOOLSETS is parsed, normalized and validated", () => {
  assert.deepEqual(loadConfig({ REAI_USER_API_TOKEN: "t" }).toolsets, []);
  assert.deepEqual(
    loadConfig({ REAI_USER_API_TOKEN: "t", REAI_TOOLSETS: " Sales , PURCHASE " }).toolsets,
    ["sales", "purchase"],
  );
  assert.throws(
    () => loadConfig({ REAI_USER_API_TOKEN: "t", REAI_TOOLSETS: "sales,nope" }),
    /unknown group\(s\): nope/,
  );
});

test("tool names are unique and consistently prefixed", () => {
  const names = allTools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "duplicate tool name");
  for (const n of names) assert.match(n, /^reai_[a-z0-9_]+$/, n);
});

test("every tool declares a risk the policy knows", () => {
  for (const t of allTools) {
    assert.ok(["read", "reversible", "irreversible"].includes(t.risk), `${t.name}: ${t.risk}`);
    assert.ok(t.description.length > 40, `${t.name} needs a real description`);
    assert.ok(t.title.length > 0, `${t.name} needs a title`);
  }
});

// --- The guard that matters most -------------------------------------------

// reai_delete_department shipped without `destructive: true` while all eight other delete
// tools had it — so a host that prompts before destructive tools would have confirmed
// deleting a customer, which can be unarchived, and run the one delete whose archive branch
// is one-way. The annotation is the only thing left protecting a call the write mode allows,
// so the sweep is mechanical rather than per-tool.
test("every tool that deletes is annotated destructive", () => {
  const deleting = registeredTools.filter(
    (t) => t.name.startsWith("reai_delete_") || (t.apiPaths ?? []).some(([m]) => m === "DELETE"),
  );
  // The population first. This sweep asserts a property of the deleting tools, and a filter keyed on a
  // NAME PREFIX is exactly the kind that stops matching after a rename — at which point the assertion
  // below is about the empty set and passes for the wrong reason.
  //
  // But the filter is a DISJUNCTION, and 22 tools match the prefix while 23 match the method and none
  // match the prefix without also matching the method. So a floor on the union is unfalsifiable by the
  // rename it names: renaming every reai_delete_* to reai_remove_* leaves the total at 23. Found by the
  // independent review of PR #108, whose sharper point is that emptying the corpus tests a floor's
  // DENOMINATOR, not the predicate it claims to watch. Both halves are pinned separately.
  const byPrefix = deleting.filter((t) => t.name.startsWith("reai_delete_"));
  const byMethod = deleting.filter((t) => (t.apiPaths ?? []).some(([m]) => m === "DELETE"));
  assert.ok(deleting.length >= 17, `only ${deleting.length} of 23 deleting tools found — the filter has stopped matching`);
  assert.ok(byPrefix.length >= 16, `only ${byPrefix.length} of 22 tools match reai_delete_ — the prefix has stopped matching`);
  assert.ok(byMethod.length >= 17, `only ${byMethod.length} of 23 tools declare a DELETE — the method match has stopped matching`);
  const undeclared = deleting
    .filter((t) => t.destructive !== true && t.risk !== "irreversible")
    .map((t) => t.name);
  assert.deepEqual(
    undeclared,
    [],
    "a DELETE tool without destructive:true gets destructiveHint:false, so a client that " +
      "asks before destructive actions will run it silently",
  );
});

// The gap was in curatedArgsEscalate, the RUNTIME gate: it re-checked a curated tool's
// arguments for payment routing and invoice delivery but not for the fields that arm a
// send, so a tool declared `reversible` accepting sendEhf, outputMode or
// automaticBillingGeneration would have transmitted in the default mode while reai_request
// refused the identical call.
//
// No static test could have caught that, and it is worth being precise about why: the
// invariant further down this file ("no curated tool is more permissive than the escape
// hatch would be") compares a declared risk against classifyRequest on the PATH, and a body
// field is invisible to it. Nothing was reachable — no shipped tool takes one of these
// fields — and a subscription tool would have been the first.
test("a curated tool accepting an arms-a-send field escalates like the escape hatch", async () => {
  const { escalatingBodyFieldNames, curatedArgsEscalate, classifyWithBody, isAllowed } = await import(
    "../dist/policy.js"
  );
  // A value each field actually escalates on, so the probe means something.
  const arming = {
    sendehf: true,
    automaticbillinggeneration: true,
    outputmode: "create_invoice",
  };
  // Floor: if the exported list empties, every assertion below is about nothing and the
  // send-arming check silently stops testing. See test/README.md.
  assert.ok(
    escalatingBodyFieldNames.length >= 3,
    `only ${escalatingBodyFieldNames.length} escalating body fields — policy has stopped exporting them`,
  );
  for (const name of escalatingBodyFieldNames) {
    assert.ok(name in arming, `no probe value for the escalating field ${name} — add one`);
    assert.equal(
      classifyWithBody("reversible", { [name]: arming[name] }),
      "irreversible",
      `${name} is declared escalating but does not escalate on ${JSON.stringify(arming[name])}`,
    );
  }

  const unguarded = [];
  for (const tool of registeredTools) {
    if (!tool.apiPaths || tool.risk === "read") continue;
    for (const input of Object.keys(tool.inputSchema ?? {})) {
      const key = input.toLowerCase();
      if (!escalatingBodyFieldNames.includes(key)) continue;
      const args = { [input]: arming[key] };
      const escalated = curatedArgsEscalate(tool.apiPaths, args);
      const effective = escalated?.risk ?? tool.risk;
      if (isAllowed(effective, "reversible")) {
        unguarded.push(`${tool.name} accepts ${input} and stays ${effective}`);
      }
    }
  }
  assert.deepEqual(unguarded, [], "a curated tool can arm a send in the default write mode");

  // No shipped tool accepts one of these fields, so the sweep above passes vacuously today
  // — neutering the escalation in policy.ts leaves it green. What it is really guarding is
  // the NEXT tool, so check the mechanism against a tool shaped like that one: a reversible
  // subscription create, which is exactly what prompted this.
  // curatedArgsEscalate reads only apiPaths and args, so a fuller tool object here would be
  // decoration that reads like coverage. This is the path a subscription create would
  // declare, and the arguments its schema would accept.
  const subscriptionPaths = [["POST", "/api/subscriptions"]];
  for (const [field, value] of [
    ["sendEhf", true],
    ["outputMode", "create_invoice"],
    ["automaticBillingGeneration", true],
  ]) {
    const escalated = curatedArgsEscalate(subscriptionPaths, { [field]: value });
    assert.equal(escalated?.risk, "irreversible", `${field} must escalate a curated tool`);
    assert.match(escalated.consequence, /arms an external send|issue invoices on its own/);
    assert.equal(isAllowed(escalated.risk, "reversible"), false);
  }
  // And the benign values must NOT escalate, or the tool becomes unusable for the ordinary
  // case: a subscription that produces a draft order and bills nobody automatically.
  assert.equal(curatedArgsEscalate(subscriptionPaths, { outputMode: "create_order" }), undefined);
  assert.equal(curatedArgsEscalate(subscriptionPaths, { automaticBillingGeneration: false }), undefined);
  assert.equal(curatedArgsEscalate(subscriptionPaths, { sendEhf: false }), undefined);

  // Scoped to where these fields exist. bindsToCreateInvoice fails closed on an
  // unrecognised string, so without the path check a future export tool taking
  // outputMode: "csv" would be refused in the default mode with a message about Peppol.
  assert.equal(curatedArgsEscalate([["POST", "/api/manual-vouchers"]], { outputMode: "csv" }), undefined);
  assert.equal(curatedArgsEscalate([["POST", "/api/manual-vouchers"]], { sendEhf: true }), undefined);
  assert.ok(curatedArgsEscalate([["POST", "/api/orders"]], { sendEhf: true }), "orders carry sendEhf too");

  // And every reason is reported, not the first one found: the server tells the caller
  // "the same call without those fields will work", which is false if a second category
  // is waiting behind the first.
  const both = curatedArgsEscalate([["PATCH", "/api/subscriptions/7"]], {
    invoiceEmail: "x@y.no",
    sendEhf: true,
  });
  assert.deepEqual(both.fields, ["invoiceEmail", "sendEhf=true"]);
  assert.match(both.consequence, /where invoices are delivered/);
  assert.match(both.consequence, /arms an external send/);
  assert.match(both.verify, /confirm the address/);
  assert.match(both.verify, /confirm the recipient/);
});

test("no curated tool is more permissive than the escape hatch would be", () => {
  // The worst bug class in this codebase is a curated tool that quietly does
  // what reai_request refuses -- it would silently defeat REAI_WRITE_MODE. Each
  // tool declares the API paths it calls so this can be checked mechanically
  // rather than by eye, which is how the previous reviews had to do it.
  const rank = { read: 0, reversible: 1, irreversible: 2 };
  // Work count, not a population count: this loop skips a tool that declares nothing, so a tool
  // can leave the invariant by emptying its own list. The test above now forbids that, and this
  // pins how many tools the invariant actually classified (161 of 168 today; the seven exempt
  // ones are listed there).
  let classified = 0;

  for (const tool of registeredTools) {
    if (!tool.apiPaths?.length) continue;
    classified += 1;
    for (const [method, path] of tool.apiPaths) {
      // Substitute the template parameters, since classifyRequest sees concrete paths.
      const concrete = path.replace(/\{[^}]+\}/g, "1");
      const fromPolicy = classifyRequest(method, concrete);
      assert.ok(
        rank[tool.risk] >= rank[fromPolicy],
        `${tool.name} declares risk="${tool.risk}" but ${method} ${concrete} classifies as ` +
          `"${fromPolicy}" — the tool would be usable in a mode that forbids the same call ` +
          `through reai_request.`,
      );
    }
  }
});

test("every curated tool declares the API paths it calls", () => {
  // Not decoration: an undeclared tool silently opts out of the check above.
  //
  // `?.length`, not `!t.apiPaths` — an EMPTY list satisfied the old form while opting the tool
  // out of every invariant that iterates the declared paths. Found by the independent review of
  // PR #108: setting `apiPaths: []` on reai_delete_reconciliation_rule and downgrading it from
  // irreversible to reversible — an irreversible delete, now registered in the default write
  // mode — left the entire suite green except one documentation count.
  const missing = allTools
    .filter((t) => !alwaysOnTools.includes(t) || t.name.startsWith("reai_whoami"))
    .filter((t) => !t.apiPaths?.length)
    .map((t) => t.name);
  const exempt = new Set([
    // Discovery reads the bundled spec, or targets a path chosen at call time and
    // classified per-call inside the handler.
    "reai_search_endpoints",
    "reai_describe_endpoint",
    "reai_list_api_tags",
    "reai_api_notes",
    "reai_request",
    // Session-local state only; touches no API path of its own beyond /api/me.
    "reai_use_tenant",
  ]);
  const unexpected = missing.filter((n) => !exempt.has(n));
  assert.deepEqual(unexpected, [], `tools missing apiPaths: ${unexpected.join(", ")}`);
});

test("declared API paths exist in the OpenAPI spec", () => {
  // Catches a typo'd path, which would make the guard above check nothing.
  for (const tool of registeredTools) {
    for (const [method, path] of tool.apiPaths ?? []) {
      assert.ok(
        findOperation(method, path),
        `${tool.name} declares ${method} ${path}, which is not in the spec`,
      );
    }
  }
});

// Quirk vat-codes-tenant-specific warns that the unfiltered VAT-code list returns every
// code ReAI supports rather than the tenant's, so "booking one invents VAT that does not
// exist". Several tools take a vatCode and post to the ledger with it — and a
// reconciliation rule does so repeatedly and unattended — while pointing at
// reai_list_vat_codes.
//
// The first version of this test named two tools by hand and passed while
// reai_create_voucher, which accepts postings[].vatCode and is irreversible, had the
// identical gap. A test that lists its own subjects cannot enforce a rule; it walks the
// schemas now, nested fields included.
function vatCodeFields(schema, depth = 0, path = "") {
  if (!schema || depth > 6) return [];
  const def = schema._def ?? schema;
  const found = [];
  const shape = typeof def.shape === "function" ? def.shape() : def.shape;
  if (shape) {
    for (const [key, value] of Object.entries(shape)) {
      const here = path ? `${path}.${key}` : key;
      if (/^vatcode$/i.test(key)) {
        found.push({ path: here, description: value._def?.description ?? value.description ?? "" });
      }
      found.push(...vatCodeFields(value, depth + 1, here));
    }
  }
  for (const key of ["innerType", "type", "schema", "element", "valueType"]) {
    if (def[key]) found.push(...vatCodeFields(def[key], depth + 1, path));
  }
  return found;
}

test("every ledger-booking tool that takes a vatCode carries the tenant-specific caveat", async () => {
  let checked = 0;
  for (const tool of registeredTools) {
    if (tool.risk !== "irreversible") continue;
    for (const [name, schema] of Object.entries(tool.inputSchema ?? {})) {
      const fields = /^vatcode$/i.test(name)
        ? [{ path: name, description: schema._def?.description ?? "" }, ...vatCodeFields(schema, 0, name)]
        : vatCodeFields(schema, 0, name);
      for (const field of fields) {
        checked += 1;
        assert.match(
          field.description,
          /not VAT-registered|THIS tenant|invents VAT/i,
          `${tool.name}.${field.path} takes a VAT code and books with it, but gives no caveat`,
        );
      }
    }
  }
  assert.ok(checked >= 3, `expected several booking tools with a vatCode, found ${checked}`);
});

// Issuing an invoice needs BOTH switches, and saying only "requires full" invites an
// operator to set full and wonder why the tool is still missing.
test("a transmitting tool names both switches it needs", async () => {
  const transmitting = registeredTools.filter((t) => t.transmits === true);
  // The class first. This is the most consequential group on the server and the filter is a single flag:
  // rename it, or drop it from a tool, and this sweep quietly covers nothing.
  assert.ok(transmitting.length >= 3, `only ${transmitting.length} transmitting tools found — the filter has stopped matching`);
  for (const tool of transmitting) {
    assert.match(
      tool.description,
      /REAI_ALLOW_EXTERNAL_SEND/,
      `${tool.name} transmits but never mentions REAI_ALLOW_EXTERNAL_SEND`,
    );
  }
});

// The multi-tenant branch of reai_whoami had no guidance at all, because no token
// available during development reached more than one company — so the case this server
// exists to serve well was the one never exercised. The rules genuinely invert between
// token scopes: the tenant header goes from ignored to load-bearing.
test("reai_whoami explains the token scope it is actually looking at", async () => {
  const { allTools } = await import("../dist/server.js");
  const whoami = allTools.find((t) => t.name === "reai_whoami");
  const config = {
    baseUrl: "https://app.reai.no",
    writeMode: "reversible",
    timeoutMs: 5000,
    maxRetries: 0,
    verbose: false,
  };
  const ctxWith = (tenants) => ({
    client: { request: async () => ({ data: { email: "a@b.no", name: "A", tenants } }), deepLink: (_p, t) => `x/${t}` },
    config,
    session: {},
  });

  const single = (await whoami.handler({}, ctxWith([{ id: 2634, companyName: "One", currencyCode: "NOK" }])))
    .content[0].text;
  assert.match(single, /has been observed to\s+IGNORE the tenant header|observed to IGNORE/i);
  // Must NOT claim the token kind: a user-scoped token for a user with one company also
  // returns a one-element list, and /api/me has no field that tells them apart.
  assert.ok(!/TENANT-SCOPED/.test(single), `must not assert a token kind: ${single.slice(0, 200)}`);
  assert.match(single, /may be scoped to this one/i, "should still explain why one company appears");

  const many = (
    await whoami.handler(
      {},
      ctxWith([
        { id: 2634, companyName: "One", currencyCode: "NOK" },
        { id: 2783, companyName: "Two", currencyCode: "NOK" },
        { id: 9001, companyName: "Three", currencyCode: "EUR" },
      ]),
    )
  ).content[0].text;
  assert.match(many, /load-bearing/, "the header stops being ignored — say so");
  assert.ok(!/observed to IGNORE/i.test(many), "must not repeat the single-tenant caveat");
  assert.match(many, /do not share a currency \(NOK, EUR\)/);
  // Not every amount is in the company's currency — an invoice total is in the invoice's.
  assert.match(many, /read the currency on each result/i);

  const sameCurrency = (
    await whoami.handler(
      {},
      ctxWith([
        { id: 1, companyName: "A", currencyCode: "NOK" },
        { id: 2, companyName: "B", currencyCode: "NOK" },
      ]),
    )
  ).content[0].text;
  assert.ok(!/do not share a currency/.test(sameCurrency), "no warning when they agree");
});

// A grant bound at authorization time is a boundary on what may be ADDRESSED. /api/me
// returns every company the underlying ReAI token reaches, so reai_whoami handed the
// agent each client company's name, id, currency and deep link — while the README
// claimed the binding prevented exactly that. A boundary that leaks the thing it is
// meant to protect is not a boundary.
test("a bound connection discloses only the company it is bound to", async () => {
  const { allTools } = await import("../dist/server.js");
  const whoami = allTools.find((t) => t.name === "reai_whoami");
  const tenants = [
    { id: 2634, companyName: "Torstensen Digital", currencyCode: "NOK" },
    { id: 2783, companyName: "bedre standard", currencyCode: "NOK" },
    { id: 9001, companyName: "Client AS", currencyCode: "EUR" },
  ];
  const result = await whoami.handler(
    {},
    {
      client: { request: async () => ({ data: { email: "a@b.no", name: "A", tenants } }), deepLink: (_p, t) => `x/${t}` },
      config: {
        baseUrl: "https://app.reai.no",
        writeMode: "reversible",
        timeoutMs: 5000,
        maxRetries: 0,
        verbose: false,
        boundTenantId: 2783,
      },
      session: {},
    },
  );
  const [note, body] = result.content[0].text.split("\n\n");
  const parsed = JSON.parse(body);

  assert.deepEqual(parsed.tenants.map((t) => t.id), [2783], "only the bound company may be listed");
  const serialised = JSON.stringify(parsed);
  for (const leaked of ["Torstensen Digital", "Client AS", "2634", "9001"]) {
    assert.ok(!serialised.includes(leaked), `leaked ${leaked} on a bound connection`);
  }
  assert.match(note, /BOUND to tenant 2783/);
  // And it must not tell the agent to select a tenant, which is what binding forbids.
  assert.ok(!/load-bearing/.test(note), "selection guidance contradicts the binding");
  assert.match(note, /deliberately not listed/i, "say that others exist without naming them");
});

// A README section documenting an enforced limit went missing in an unrelated edit —
// a text slice that reached past its intended end took the whole "Request limits"
// section with it, and the limits stayed in force undocumented. Operators find out
// about a 413 or a 405 from the README or not at all, so the numbers are pinned to the
// constants that produce them.
test("the README documents the transport limits the code enforces", async () => {
  const { readFileSync } = await import("node:fs");
  // README plus docs/, because the guarantee is that the limits are written down where an operator
  // will find them — not that they sit on the front page. Self-hosting moved to docs/ in the README
  // split, and pinning this to README.md would have held the enforced limits hostage to that layout.
  const readme = docsCorpus(import.meta.url);
  const http = readFileSync(new URL("../src/http.ts", import.meta.url), "utf8");

  const bodyBytes = /MAX_MCP_BODY_BYTES = (\d+) \* 1024 \* 1024/.exec(http)?.[1];
  const batch = /MAX_MCP_BATCH = (\d+)/.exec(http)?.[1];
  assert.ok(bodyBytes, "could not read the body limit from src/http.ts");
  assert.ok(batch, "could not read the batch limit from src/http.ts");

  // `## ` rather than `### `, which also matches a `###` heading: the section used to exist at both
  // levels — a summary on the front page and the detail in docs/self-hosting.md — and the front-page
  // one is now a sentence plus a link. The heading LEVEL was never the guarantee; the section being
  // findable in the corpus is. The three content assertions below are unchanged.
  assert.match(readme, /## Request limits/, "the Request limits section is missing");
  assert.ok(
    readme.includes(`${bodyBytes} MB`),
    `the README does not mention the ${bodyBytes} MB body limit the code enforces`,
  );
  assert.ok(
    readme.includes(`${batch} messages`),
    `the README does not mention the ${batch}-message batch limit the code enforces`,
  );
  // And the 405, which looks like a defect to anyone who has not read why.
  assert.match(readme, /GET \/mcp` answers \*\*405\*\*/);
});

// The README presented these fields as path-specific — `iban` for counterparties,
// `bban` for company banks — when all five apply to every in-scope path, and it omitted
// `accountNumber` and the supplier-invoice payment-details path entirely. A table that
// describes a safety rule has to match the rule.
test("the README's payment-routing table matches the classifier", async () => {
  const { readFileSync } = await import("node:fs");
  const { classifyPaymentRouting, classifyInvoiceDelivery } = await import("../dist/policy.js");
  const readme = docsCorpus(import.meta.url);

  const paymentFields = ["iban", "bankAccountNumber", "swiftCode", "accountNumber", "bban"];
  const paths = [
    ["PATCH", "/api/suppliers/5"],
    ["PATCH", "/api/customers/5"],
    ["PATCH", "/api/creditors/5"],
    ["PUT", "/api/company-banks/5"],
    ["PATCH", "/api/supplier-invoices/5/payment-details"],
  ];
  // Every field escalates on every one of these paths — that is the claim the table now
  // makes, so it is the claim the code has to keep true.
  for (const field of paymentFields) {
    for (const [method, path] of paths) {
      assert.equal(
        classifyPaymentRouting("reversible", path, { [field]: "x" }, method),
        "irreversible",
        `${method} ${path} with ${field} should escalate`,
      );
    }
    assert.ok(readme.includes(`\`${field}\``), `the README must list ${field}`);
  }
  // Adding a company bank is deliberately not escalated, and the table says so.
  assert.equal(classifyPaymentRouting("reversible", "/api/company-banks", { bban: "x" }, "POST"), "reversible");
  assert.match(readme, /Adding\* a company bank stays ordinary work|\*Adding\* a company bank/);

  // Invoice delivery is the second row, and its scope is wider than customers.
  for (const path of ["/api/customers/5", "/api/orders", "/api/subscriptions/3"]) {
    assert.equal(classifyInvoiceDelivery("reversible", path, { invoiceEmail: "a@b.c" }, false), "irreversible", path);
  }
  assert.match(readme, /`invoiceEmail` \| customers, orders, subscriptions/);
});

/**
 * `reai_get_*` tools that fetch one record by id but keep an explicit name, with the reason.
 *
 * The first version of this test used "at most two non-tenant keys" to exclude them, which
 * was arbitrary in both directions: a future getter taking `fooId` plus two other params
 * would slip through, and reai_get_bank_reconciliation was excluded only because `include`
 * happens to make a third key — drop that optional parameter and the test would demand
 * renaming `bankAccountId` to `id`, which is the wrong answer.
 */
const KEEPS_AN_EXPLICIT_ID = {
  reai_get_bank_reconciliation:
    "queries a PERIOD for an account (bankAccountId + month), rather than fetching a record by id",
  reai_get_manual_reconciliation:
    "the same shape as its synced sibling above: it queries a PERIOD for an account " +
    "(bankAccountId + month) rather than fetching a record by id, and a manual reconciliation has no id " +
    "of its own",
  reai_get_warehouse_inventory:
    "reports stock lines, which have no id of their own; warehouseId is an OPTIONAL filter and " +
    "omitting it reports across every warehouse, so `id` would name the wrong thing",
  reai_get_customer_contact:
    "a contact person is nested under a customer, so the tool takes TWO ids and one of them has to " +
    "carry a qualifier. `customerId` trips this sweep whichever way the other is spelled, so the " +
    "choice was made for the OTHER guard: naming it `contactPersonId` matches the path placeholder, " +
    "which is what makes its `.positive()` bound attributable to the spec sweep in spec-bounds " +
    "rather than unpinned",
};

// Seven getters took `id` and the three added in the last two iterations took `<noun>Id`.
// Two conventions is one too many: an agent that guesses wrong gets "Invalid arguments for
// tool", which is what happened writing a probe against this repo's own tools.
test("every explicit-id exception is a real tool", () => {
  for (const [name, reason] of Object.entries(KEEPS_AN_EXPLICIT_ID)) {
    const tool = registeredTools.find((t) => t.name === name);
    assert.ok(tool, `exception names an unknown tool: ${name}`);
    assert.ok(reason.length > 20, `${name} needs a reason, not a placeholder`);
    // And it must actually take an explicit id, or the exception is dead.
    const keys = Object.keys(tool.inputSchema ?? {}).filter((k) => k !== "tenantId");
    assert.ok(keys.some((k) => /(^|[a-z_])id$/i.test(k) && k !== "id"), `${name} takes no explicit id`);
  }
});

test("a getter that takes one record id calls it `id`", () => {
  const wrong = [];
  let examined = 0;
  let inspected = 0;
  for (const tool of registeredTools) {
    if (tool.risk !== "read" || !tool.name.startsWith("reai_get_")) continue;
    examined++;
    if (tool.name in KEEPS_AN_EXPLICIT_ID) continue;
    const keys = Object.keys(tool.inputSchema ?? {}).filter((k) => k !== "tenantId");
    if (keys.length > 0) inspected += 1;
    // Any spelling of an id-shaped name, so fooId and foo_id are both caught.
    const ids = keys.filter((k) => /(^|[a-z_])id$/i.test(k) && k !== "id");
    if (ids.length === 0) continue;
    wrong.push(`${tool.name}: ${ids.join(", ")}`);
  }
  // Two counts, because they fail to different things. `examined` is the population — a rename or a
  // risk-tier change stops the filter matching. `inspected` is the work: this sweep reads argument
  // names out of `Object.keys(inputSchema)`, and anything that stops those keys being enumerable
  // (moving them onto a shared prototype, for one) empties every `keys` array while the population
  // stays at 25 and the sweep proves nothing. The review of PR #108 demonstrated exactly that, and
  // it is why `examined` alone was never the guard I claimed it was.
  assert.ok(examined >= 18, `only ${examined} of 25 reai_get_* read tools were examined — the filter has stopped matching`);
  assert.ok(inspected >= 18, `only ${inspected} of 24 getters had any argument to inspect — the sweep is reading nothing`);
  assert.deepEqual(wrong, [], "a reai_get_* record fetch should take `id`, or be listed in KEEPS_AN_EXPLICIT_ID with a reason");
});

// The annotation clients key on to ask before a destructive call is derived by probing each
// input through the real gate — "so the annotation cannot drift from the gate that enforces
// it", as server.ts puts it. It probed with the literal string "probe", and the gate
// escalates sendEhf and automaticBillingGeneration only on a value that binds to TRUE, so
// both were invisible to the annotation while fully live in the gate. That is the drift the
// probe exists to prevent, reproduced one layer up from the hole this PR closed.
test("the destructiveHint probe sees every field the gate reacts to", async () => {
  const { curatedArgsEscalate, escalatingBodyFieldNames } = await import("../dist/policy.js");
  // The REAL probe set, imported rather than copied. A local copy would test the copy:
  // narrowing ESCALATION_PROBES back to ["probe"] in the build left this green, which is
  // the same "a guard that reimplements what it guards" mistake this file has hit before.
  const { ESCALATION_PROBES: probes } = await import("../dist/server.js");
  const armed = { sendehf: true, automaticbillinggeneration: true, outputmode: "create_invoice" };
  const paths = [["POST", "/api/subscriptions"]];

  for (const field of escalatingBodyFieldNames) {
    const live = curatedArgsEscalate(paths, { [field]: armed[field] }) !== undefined;
    const seen = probes.some((v) => curatedArgsEscalate(paths, { [field]: v }) !== undefined);
    assert.equal(live, true, `${field} should escalate on ${JSON.stringify(armed[field])}`);
    assert.equal(seen, true, `${field} escalates the gate but no probe value reaches it`);
  }
  // A payment-routing field is a string, and was always visible — kept so the probe set
  // cannot shrink back to booleans only.
  assert.ok(
    probes.some((v) => curatedArgsEscalate([["PATCH", "/api/suppliers/7"]], { iban: v }) !== undefined),
  );
});

/**
 * The same drift one level down: a tool argument that takes an OBJECT.
 *
 * The gate walks nested bodies, so it caught these at runtime — but the annotation probed with
 * scalars only, so everything inside such an argument was invisible to it. reai_update_agreement
 * was exactly that: `changes` carries a whole lease, so rentAccountNumber and
 * depositAccountNumber were live in the gate while the tool advertised destructiveHint: false,
 * and a client that asks before destructive calls would have shown redirecting a tenant's
 * deposit account as an ordinary edit.
 */
test("the probe sees escalating fields nested inside an object-valued argument", async () => {
  const { curatedArgsEscalate, escalatingFieldNames } = await import("../dist/policy.js");
  const { ESCALATION_PROBES: probes, registeredTools } = await import("../dist/server.js");

  // The union is derived from the real sets, so a new escalating field cannot be added to the
  // policy without becoming probeable here. 13 today, so 12 is 92% — the review of PR #108 reported
  // this one as 12 of 41 and slack; measured, it is not.
  assert.ok(escalatingFieldNames.length >= 12, `expected the real field union of 13; got ${escalatingFieldNames.length}`);
  for (const name of ["depositaccountnumber", "rentaccountnumber", "iban", "sendehf"]) {
    assert.ok(escalatingFieldNames.includes(name), `${name} must be in the probeable union`);
  }

  // The concrete case, stated as the two halves that disagreed.
  const paths = [["PUT", "/api/agreements/rent-agreement/{id}"]];
  const scalarOnly = probes.some((v) => curatedArgsEscalate(paths, { changes: v }) !== undefined);
  const nested = probes.some((v) =>
    escalatingFieldNames.some((n) => curatedArgsEscalate(paths, { changes: { [n]: v } }) !== undefined),
  );
  assert.equal(scalarOnly, false, "if a scalar probe now reaches this, the premise has changed");
  assert.equal(nested, true, "a routing field inside `changes` must be discoverable by probing");

  // The REAL probe, imported rather than reimplemented — the assertions above describe the
  // mechanism, and this one is the thing the server actually publishes as destructiveHint.
  const { hasEscalatingFields } = await import("../dist/server.js");
  const tool = registeredTools.find((x) => x.name === "reai_update_agreement");
  assert.ok(tool, "reai_update_agreement must exist for this to mean anything");
  assert.equal(
    hasEscalatingFields(tool),
    true,
    "reai_update_agreement can redirect a tenant's deposit account, so it must be annotated destructive",
  );

  // Every tool taking an object-valued argument that could carry one, for the same reason.
  const byObjectArg = registeredTools.filter((t) =>
    escalatingFieldNames.some((n) =>
      probes.some((v) =>
        Object.keys(t.inputSchema ?? {}).some(
          (f) => curatedArgsEscalate(t.apiPaths ?? [], { [f]: { [n]: v } }) !== undefined,
        ),
      ),
    ),
  );
  for (const t of byObjectArg) {
    assert.equal(hasEscalatingFields(t), true, `${t.name} hides an escalating field in an object arg`);
  }
});

// REAI_WRITE_MODE answers "can this be undone in the books". REAI_ALLOW_EXTERNAL_SEND
// answers "does this reach someone else", and `full` deliberately does not lift it.
// Escalating the write risk alone collapsed the two into one for exactly the fields that
// arm a send: in full mode with sending off, a curated tool would have transmitted where
// reai_request refuses the identical call.
//
// tool.transmits cannot carry this. Declaring the tool transmits:true would hide it
// whenever sending is off, including for the ordinary call that sends nothing — only the
// arguments can tell.
test("arguments that arm a send are refused when external sending is off", async () => {
  const { curatedArgsEscalate } = await import("../dist/policy.js");
  const subscriptionPaths = [["POST", "/api/subscriptions"]];

  for (const [field, value] of [
    ["sendEhf", true],
    ["outputMode", "create_invoice"],
    ["automaticBillingGeneration", true],
  ]) {
    const escalated = curatedArgsEscalate(subscriptionPaths, { [field]: value });
    assert.equal(escalated?.transmits, true, `${field} reaches a counterparty`);
  }

  // Redirecting a payment or an invoice address is irreversible but sends nothing itself,
  // so it must NOT be caught by the send gate — that would refuse a bank-detail correction
  // on a deployment that has sending switched off, which is most of them.
  const routing = curatedArgsEscalate([["PATCH", "/api/suppliers/7"]], { iban: "NO93" });
  assert.equal(routing.risk, "irreversible");
  assert.equal(routing.transmits, false);
  const delivery = curatedArgsEscalate([["PATCH", "/api/customers/7"]], { invoiceEmail: "x@y.no" });
  assert.equal(delivery.transmits, false);

  // And the benign values stay benign on both axes.
  assert.equal(curatedArgsEscalate(subscriptionPaths, { outputMode: "create_order" }), undefined);
  assert.equal(curatedArgsEscalate(subscriptionPaths, { sendEhf: false }), undefined);
});

/**
 * Manual bank reconciliation. Every state below was measured against the write test tenant before it was
 * written down — see the module doc in src/tools/bankvat.ts for the table.
 */
test("the manual reconciliation tools report the API's own permissions, not guesses", async () => {
  const { registeredTools } = await import("../dist/server.js");
  const tool = (name) => {
    const found = registeredTools.find((t) => t.name === name);
    assert.ok(found, `${name} should exist`);
    return found;
  };
  const textOf = (r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const ctxFor = (data) => ({
    config: { boundTenantId: undefined, defaultTenantId: 2783, writeMode: "full", allowExternalSend: false },
    session: {},
    client: { request: async () => ({ status: 200, data }), deepLink: () => "" },
  });

  // A month with no statement balance: nothing to compare, and closing is impossible.
  const fresh = await tool("reai_get_manual_reconciliation").handler(
    { bankAccountId: 1655, month: "2026-07" },
    ctxFor({ bankAccountId: 1655, month: "2026-07", monthEndingBalance: 0, bankStatementEndingBalance: null, difference: null, reconciliationLocked: false, canClose: false, canReopen: false }),
  );
  assert.match(textOf(fresh), /No statement balance/);
  assert.match(textOf(fresh), /cannot be closed/);
  assert.match(textOf(fresh), /canClose=false/);

  // A difference is the finding, and the tool must say not to make it disappear.
  const mismatch = await tool("reai_get_manual_reconciliation").handler(
    { bankAccountId: 1655, month: "2026-07" },
    ctxFor({ month: "2026-07", monthEndingBalance: 0, bankStatementEndingBalance: 500, difference: 500, reconciliationLocked: false, canClose: false, canReopen: false }),
  );
  assert.match(textOf(mismatch), /difference is why this month cannot be closed/);
  assert.match(textOf(mismatch), /rather than adjusting the statement figure/);

  // Agreement: the API says canClose, and the tool passes that on rather than deciding for itself.
  const agrees = await tool("reai_get_manual_reconciliation").handler(
    { bankAccountId: 1655, month: "2026-07" },
    ctxFor({ month: "2026-07", monthEndingBalance: 0, bankStatementEndingBalance: 0, difference: 0, reconciliationLocked: false, canClose: true, canReopen: false }),
  );
  assert.match(textOf(agrees), /canClose=true/);
  assert.doesNotMatch(textOf(agrees), /cannot be closed/);

  // Closing says what it did and did not do, and that it is undoable.
  const closed = await tool("reai_close_manual_reconciliation").handler(
    { bankAccountId: 1655, month: "2026-07" },
    ctxFor({ month: "2026-07", bankStatementEndingBalance: 0, difference: 0, reconciliationLocked: true, canClose: false, canReopen: true }),
  );
  assert.match(textOf(closed), /Nothing was posted/);
  assert.match(textOf(closed), /reai_reopen_manual_reconciliation can undo it/);
  assert.match(textOf(closed), /canReopen=true/);
});

test("the manual reconciliation writes are not softer than the escape hatch", async () => {
  const { registeredTools } = await import("../dist/server.js");
  const { classifyRequest } = await import("../dist/policy.js");
  for (const name of [
    "reai_set_bank_statement_balance",
    "reai_close_manual_reconciliation",
    "reai_reopen_manual_reconciliation",
  ]) {
    const t = registeredTools.find((x) => x.name === name);
    assert.equal(t.risk, "irreversible", `${name} must match the policy tier for /api/manual-reconciliations`);
  }
  assert.equal(classifyRequest("POST", "/api/manual-reconciliations/7/close"), "irreversible");
  assert.equal(classifyRequest("PUT", "/api/manual-reconciliations/7/ending-balance"), "irreversible");
  // The read stays a read, which is why gating the writes costs so little.
  const read = registeredTools.find((x) => x.name === "reai_get_manual_reconciliation");
  assert.equal(read.risk, "read");
  // And the month argument is validated locally, so a bad shape does not become an upstream 400.
  const { z } = await import("zod");
  const monthSchema = z.object(read.inputSchema);
  assert.equal(monthSchema.safeParse({ bankAccountId: 1, month: "2026-7" }).success, false);
  assert.equal(monthSchema.safeParse({ bankAccountId: 1, month: "2026-13" }).success, false);
  assert.equal(monthSchema.safeParse({ bankAccountId: 1, month: "2026-07" }).success, true);
});

test("the three Norwegian reconciliation refusals are translated, not passed through", async () => {
  // Written after driving these live and watching the close hand back
  // `409 "Angi sluttsaldoen før du lukker avstemmingen."` raw. Documenting a refusal and then forwarding
  // it untranslated is the gap two reviews have caught elsewhere in this repo.
  const { registeredTools } = await import("../dist/server.js");
  const { ReaiApiError } = await import("../dist/reai/errors.js");
  const textOf = (r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const throwing = (err) => ({
    config: { boundTenantId: undefined, defaultTenantId: 2783, writeMode: "full", allowExternalSend: false },
    session: {},
    client: { request: async () => { throw err; }, deepLink: () => "" },
  });
  const tool = (name) => registeredTools.find((t) => t.name === name);

  const cases = [
    ["reai_close_manual_reconciliation", 409, "Angi sluttsaldoen før du lukker avstemmingen.", /reai_set_bank_statement_balance/],
    ["reai_reopen_manual_reconciliation", 409, "Avstemmingen er ikke låst for 2026-07.", /nothing to reopen/],
    ["reai_get_manual_reconciliation", 404, "Bankkonto ikke funnet", /AMBIGUOUS/],
  ];
  for (const [name, status, norwegian, expected] of cases) {
    const err = new ReaiApiError({
      status,
      method: "POST",
      path: "/api/manual-reconciliations/1657/close",
      rawBody: JSON.stringify({ detail: norwegian }),
      problem: { detail: norwegian },
    });
    const res = await tool(name).handler({ bankAccountId: 1657, month: "2026-07" }, throwing(err));
    assert.equal(res.isError, true, `${name} should refuse`);
    assert.match(textOf(res), expected, `${name} must explain, not forward the Norwegian`);
    assert.doesNotMatch(textOf(res), /^ReAI (POST|GET|PUT)/m, `${name} still forwarded the raw API error`);
  }

  // The 404 translation names the way to settle the ambiguity, since the message alone cannot.
  const err404 = new ReaiApiError({
    status: 404, method: "GET", path: "/api/manual-reconciliations/1657",
    rawBody: '{"detail":"Bankkonto ikke funnet"}', problem: { detail: "Bankkonto ikke funnet" },
  });
  const amb = await tool("reai_get_manual_reconciliation").handler({ bankAccountId: 1657, month: "2026-07" }, throwing(err404));
  assert.match(textOf(amb), /reai_list_company_banks/);
  assert.match(textOf(amb), /reai_get_bank_reconciliation/);

  // Anything else propagates rather than being explained as one of these three.
  const other = new ReaiApiError({ status: 409, method: "POST", path: "/api/manual-reconciliations/1657/close", rawBody: '{"detail":"Something else"}' });
  await assert.rejects(
    () => tool("reai_close_manual_reconciliation").handler({ bankAccountId: 1657, month: "2026-07" }, throwing(other)),
    /Something else/,
  );
});

test("the close refusal that nominates a different month says which one", async () => {
  // `409 "Godkjenning er kun tilgjengelig for 2026-07."` — the refusal carries its own answer, and leaving
  // it in Norwegian throws that away. Measured with today at 2026-08-08: the current month and a future one
  // are both refused this way naming 2026-07, while an earlier month falls through to the balance check.
  const { registeredTools } = await import("../dist/server.js");
  const { ReaiApiError } = await import("../dist/reai/errors.js");
  const textOf = (r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const err = new ReaiApiError({
    status: 409,
    method: "POST",
    path: "/api/manual-reconciliations/1658/close",
    rawBody: '{"detail":"Godkjenning er kun tilgjengelig for 2026-07."}',
    problem: { detail: "Godkjenning er kun tilgjengelig for 2026-07." },
  });
  const res = await registeredTools
    .find((t) => t.name === "reai_close_manual_reconciliation")
    .handler({ bankAccountId: 1658, month: "2026-08" }, {
      config: { boundTenantId: undefined, defaultTenantId: 2783, writeMode: "full", allowExternalSend: false },
      session: {},
      client: { request: async () => { throw err; }, deepLink: () => "" },
    });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /only permits closing 2026-07/, "the nominated month is the answer");
  assert.match(textOf(res), /2026-08 cannot be closed/, "and the month asked for has to be named too");
  assert.match(textOf(res), /runs in order/);
  assert.doesNotMatch(textOf(res), /Godkjenning/, "the Norwegian must not be all the caller gets");
});

test("a foreign-currency reconciliation labels its amounts", async () => {
  // The API returns bankCurrency, tenantCurrency and bankInTenantCurrency, and a company bank can be
  // created in any currency — so bare numbers would let an EUR statement balance read as kroner.
  const { registeredTools } = await import("../dist/server.js");
  const textOf = (r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const read = (data) =>
    registeredTools.find((t) => t.name === "reai_get_manual_reconciliation").handler(
      { bankAccountId: 1, month: "2026-07" },
      {
        config: { boundTenantId: undefined, defaultTenantId: 2783, writeMode: "full", allowExternalSend: false },
        session: {},
        client: { request: async () => ({ status: 200, data }), deepLink: () => "" },
      },
    );

  const foreign = await read({
    month: "2026-07", bankCurrency: "EUR", tenantCurrency: "NOK", bankInTenantCurrency: false,
    monthEndingBalance: 100, bankStatementEndingBalance: 100, difference: 0, reconciliationLocked: false,
    canClose: true, canReopen: false,
  });
  assert.match(textOf(foreign), /100 EUR/, "the amounts must carry their unit");
  assert.match(textOf(foreign), /NOT in the tenant currency \(NOK\)/, "and say the books are in another");

  const domestic = await read({
    month: "2026-07", bankCurrency: "NOK", tenantCurrency: "NOK", bankInTenantCurrency: true,
    monthEndingBalance: 0, bankStatementEndingBalance: 0, difference: 0, reconciliationLocked: false,
    canClose: true, canReopen: false,
  });
  assert.match(textOf(domestic), /0 NOK/);
  assert.doesNotMatch(textOf(domestic), /NOT in the tenant currency/, "no warning when it matches");
});

test("a 5xx carrying a state phrase is not reported as nothing having changed", async () => {
  // A failed POST or PUT is the case this client treats as ambiguous and will not retry, so "Nothing was
  // changed" is the one claim not to make. All three state translations are gated on 409, the status they
  // were measured at.
  const { registeredTools } = await import("../dist/server.js");
  const { ReaiApiError } = await import("../dist/reai/errors.js");
  const err = new ReaiApiError({
    status: 500,
    method: "POST",
    path: "/api/manual-reconciliations/1/close",
    rawBody: '{"detail":"Angi sluttsaldoen før du lukker avstemmingen."}',
    problem: { detail: "Angi sluttsaldoen før du lukker avstemmingen." },
  });
  await assert.rejects(
    () =>
      registeredTools.find((t) => t.name === "reai_close_manual_reconciliation").handler(
        { bankAccountId: 1, month: "2026-07" },
        {
          config: { boundTenantId: undefined, defaultTenantId: 2783, writeMode: "full", allowExternalSend: false },
          session: {},
          client: { request: async () => { throw err; }, deepLink: () => "" },
        },
      ),
    /HTTP 500/,
    "a 5xx must propagate as the ambiguous failure it is",
  );
});

test("the session instructions and the UI tool point at the curated reconciliation tools", async () => {
  // The tools landed and the guidance every session receives still named the raw endpoint, so an agent
  // would route around them — and around the translations, which are the reason they exist.
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../src/tools/ui.ts", import.meta.url), "utf8");
  for (const [label, text] of [["src/server.ts", server], ["src/tools/ui.ts", ui]]) {
    assert.match(text, /reai_get_manual_reconciliation/, `${label} should name the curated tool`);
    assert.doesNotMatch(
      text,
      /reai_request[^\n]*manual-reconciliations/,
      `${label} still sends the caller to the raw endpoint`,
    );
  }
});
