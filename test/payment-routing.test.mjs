import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  classifyRequest,
  classifyPaymentRouting,
  classifyWithBody,
  isAllowed,
  PAYMENT_ROUTING_PATHS,
  paymentRoutingFieldNames,
} from "../dist/policy.js";

const SPEC = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "spec", "reai-openapi.json"), "utf8"),
);
const SCHEMAS = SPEC.components.schemas;

/**
 * Anything whose NAME suggests it might name a bank destination.
 *
 * Deliberately wider than the real field set: the point is that a new field which looks
 * like it routes money cannot be added to the API without someone deciding whether it
 * does. A narrow pattern would only re-assert what the set already contains.
 */
const ROUTING_SHAPED =
  /iban|swift|^bic$|bic(code|number)|bban|routing|accountnumber|account_?no\b|bankaccount|bankgiro|clearing|sort_?code|aba(number|routing)|beneficiar|payee|payout|recipient|destination|escrow|konto/i;

/**
 * Names the pattern above is known NOT to catch, so the claim it supports stays honest.
 *
 * It cannot be widened to bare `account`: the document already uses `account`,
 * `creditAccount`, `debitAccount` and `discrepancyAccount` for chart-of-accounts codes,
 * and flagging those would bury the real signal. So a field called simply `account` that
 * turned out to hold an IBAN would still slip through, and the README says so rather than
 * promising a guarantee this cannot give.
 */
const KNOWN_BLIND_SPOTS = ["account", "creditAccount", "debitAccount", "toAccount"];

/**
 * Routing-shaped names that do NOT name a destination, each with the evidence.
 *
 * Every entry here was checked against the OpenAPI document, not assumed. The large
 * group is chart-of-accounts codes: a ledger account to book against, which is a
 * completely different thing from a bank account that money arrives in. Escalating one of
 * those would refuse an ordinary booking with "this changes where a payment will go" —
 * and a refusal that is false teaches an operator to distrust the true ones.
 */
const NOT_A_DESTINATION = {
  accrualaccountnumber: "chart-of-accounts code: $ref AccountNumber on supplier-invoice cost lines",
  accruedinterestaccountnumber: "chart-of-accounts code: $ref AccountNumber on LoanReq",
  // The Req is a bare string with maxLength 10; only ShareInvestmentRes $refs
  // AccountNumber. The conclusion holds — it is the balance-sheet account a holding is
  // carried on — but the first version of this line cited the Res as if it were the Req,
  // which is the same Req/Res confusion that nearly got the rent-agreement fields
  // dismissed. Corrected rather than quietly reworded.
  assetaccountnumber: "chart-of-accounts code: ShareInvestmentRes $refs AccountNumber; the Req is the same field",
  interestexpenseaccountnumber: "chart-of-accounts code: $ref AccountNumber on LoanReq",
  interestincomeaccountnumber: "chart-of-accounts code: $ref AccountNumber on LoanReq",
  principalaccountnumber: "chart-of-accounts code: $ref AccountNumber on LoanReq",
  // These three select the rails a payment travels on and never name an account. Note the
  // weaker claim than the first version of this block made: it argued a destination is
  // "always written alongside them, so the call is caught anyway", which is false for a
  // PATCH — a partial update can legally carry localClearingSystem on its own. They are
  // exempt because they do not identify an account, full stop, not because something else
  // catches them.
  bankaccountcategory: "classifies an account; does not identify one (spec: 'The bank account category')",
  localclearingsystem: "names a clearing scheme, not an account",
  routingtype: "qualifies routingNumber, which is itself in the set",
  // Caught only once the pattern was widened, and each has to be decided rather than
  // waved through — which is the point of widening it.
  beneficiaryname:
    "names the payee, not the account. Where money lands is decided by accountNumber/iban; " +
    "a mismatched name fails or is ignored depending on whether the rail does Confirmation of Payee",
  beneficiaryaddress: "a postal address on the payment details, not an account",
  servicerecipients: "who receives the subscribed service; no bank details in the object",
  recipientemail: "an email address on an internal warning endpoint",
};

/** Every property name reachable in a request body, following $ref, arrays and unions. */
function fieldsOf(node, seen = new Set(), depth = 0) {
  if (depth > 6 || !node || typeof node !== "object") return new Set();
  if (node.$ref) {
    const name = node.$ref.split("/").pop();
    if (seen.has(name)) return new Set();
    return fieldsOf(SCHEMAS[name] ?? {}, new Set([...seen, name]), depth + 1);
  }
  const out = new Set();
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    for (const sub of node[key] ?? []) for (const f of fieldsOf(sub, seen, depth + 1)) out.add(f);
  }
  if (node.items) for (const f of fieldsOf(node.items, seen, depth + 1)) out.add(f);
  for (const [name, schema] of Object.entries(node.properties ?? {})) {
    out.add(name);
    for (const f of fieldsOf(schema, seen, depth + 1)) out.add(f);
  }
  return out;
}

/** [{ method, path, fields }] for every write operation, from the spec. */
function writeOperations() {
  const ops = [];
  for (const [path, item] of Object.entries(SPEC.paths)) {
    for (const [method, op] of Object.entries(item)) {
      const m = method.toUpperCase();
      if (!["POST", "PUT", "PATCH"].includes(m)) continue;
      const fields = new Set();
      for (const media of Object.values(op?.requestBody?.content ?? {})) {
        for (const f of fieldsOf(media.schema ?? {})) fields.add(f);
      }
      ops.push({ method: m, path, fields });
    }
  }
  return ops;
}

/** A concrete path, so the policy's regexes have something to match. */
const concrete = (path) => path.replace(/\{[^}]+\}/g, "7");

// Both invariants below are "assert this list is empty", which is exactly the shape that
// passes when the list cannot be populated. Hoisting every requestBody into
// components/requestBodies — an ordinary springdoc regeneration — empties `fieldsOf` and
// both tests go green having checked nothing. So pin the scan itself first.
test("the spec scan finds what it is looking for", () => {
  const ops = writeOperations();
  assert.ok(ops.length > 150, `only ${ops.length} write operations found — did the spec shape change?`);

  const withRouting = ops.filter(({ fields }) =>
    [...fields].some((f) => paymentRoutingFieldNames.has(f.toLowerCase())),
  );
  assert.ok(withRouting.length >= 10, `only ${withRouting.length} ops carry a routing field`);

  // Named operations, so a traversal that silently stops following $ref or oneOf fails
  // here rather than passing two empty assertions further down.
  const find = (method, path) => ops.find((o) => o.method === method && o.path === path);
  assert.ok(find("PATCH", "/api/suppliers/{id}")?.fields.has("iban"), "top-level field lost");
  assert.ok(
    find("PATCH", "/api/employees/{id}")?.fields.has("accountNumber"),
    "the field this whole PR is about is not being found",
  );
  assert.ok(
    find("POST", "/api/supplier-invoices")?.fields.has("iban"),
    "nested oneOf traversal lost paymentDetails.iban",
  );
  assert.ok(
    find("PUT", "/api/agreements/rent-agreement/{id}")?.fields.has("depositAccountNumber"),
    "rent-agreement fields lost",
  );
  // And the regex has to match the names it exists to match.
  for (const field of paymentRoutingFieldNames) {
    assert.ok(ROUTING_SHAPED.test(field), `${field} is in the set but the scan pattern misses it`);
  }
  for (const blind of KNOWN_BLIND_SPOTS) {
    assert.ok(!ROUTING_SHAPED.test(blind), `${blind} is documented as a blind spot but now matches`);
  }
});

// This is the test that would have caught the gap. It was found by hand, which is exactly
// the failure mode: the field set was written against the supplier and company-bank
// schemas, and nothing compared it with the rest of the document.
test("every routing-shaped field in the API is classified, one way or the other", () => {
  const unclassified = new Map();
  for (const { method, path, fields } of writeOperations()) {
    for (const field of fields) {
      if (!ROUTING_SHAPED.test(field)) continue;
      const key = field.toLowerCase();
      if (paymentRoutingFieldNames.has(key) || key in NOT_A_DESTINATION) continue;
      if (!unclassified.has(field)) unclassified.set(field, []);
      unclassified.get(field).push(`${method} ${path}`);
    }
  }
  assert.deepEqual(
    [...unclassified.entries()].map(([f, where]) => `${f} (${where.join(", ")})`),
    [],
    "a field that looks like it names a bank destination is neither treated as one nor " +
      "explicitly exempted — decide which, in policy.ts or NOT_A_DESTINATION above",
  );
});

/**
 * Paths where an in-set field name is NOT a bank destination.
 *
 * This is why the policy is path-scoped rather than field-only: `accountNumber` on an
 * employee is where their salary lands, and on a general sub-account it is a
 * chart-of-accounts code. The field name alone cannot tell you which.
 */
const NOT_A_DESTINATION_PATH = {
  "POST /api/general-sub-accounts":
    "accountNumber is the sub-account's own chart-of-accounts code ($ref AccountNumber)",
  "POST /api/company-banks":
    "registering the company's OWN account is ordinary work; only repointing one escalates",
  "POST /api/agreements/rent-agreement":
    "a new lease establishes an arrangement rather than diverting one, and a human signs it before anyone pays; PUT escalates",
};

// The other half: knowing a field routes money is useless if the path carrying it is out
// of scope. This asks the POLICY, rather than re-deriving which paths are in scope — the
// first version of this test matched PAYMENT_ROUTING_PATHS itself and reported
// PUT /api/company-banks/{id} as unprotected, because that escalation lives in a separate
// rule. A guard that reimplements what it is guarding tests the reimplementation.
test("every write path that accepts a routing field is refused in the default mode", () => {
  const unprotected = [];
  for (const { method, path, fields } of writeOperations()) {
    const routing = [...fields].filter((f) => paymentRoutingFieldNames.has(f.toLowerCase()));
    if (routing.length === 0) continue;
    if (`${method} ${path}` in NOT_A_DESTINATION_PATH) continue;

    const target = concrete(path);
    // Already refused on the strength of the path alone — creating a supplier invoice, or
    // posting a voucher — which is a legitimate way to be safe.
    if (classifyRequest(method, target) === "irreversible") continue;

    // Otherwise the routing rules must escalate it, for every routing field it accepts.
    for (const field of routing) {
      const body = { [field]: "12345678903" };
      const verdict = classifyPaymentRouting(
        classifyWithBody(classifyRequest(method, target), body),
        target,
        body,
        method,
      );
      if (isAllowed(verdict, "reversible")) {
        unprotected.push(`${method} ${path} accepts ${field} and classifies ${verdict}`);
      }
    }
  }
  assert.deepEqual(unprotected, [], "a payment destination can be written in the default write mode");
});

// The exemptions are claims about the API, so check them rather than trusting the comment.
test("the exempted paths really do mean a chart-of-accounts code", () => {
  const sub = SPEC.paths["/api/general-sub-accounts"].post.requestBody.content["application/json"].schema.$ref;
  const props = SCHEMAS[sub.split("/").pop()].properties;
  assert.match(JSON.stringify(props.accountNumber), /AccountNumber/);

  // And adding a company bank stays ordinary while repointing one does not — the whole
  // point of that exemption being method-scoped.
  const bban = { bban: "12345678903" };
  assert.equal(classifyPaymentRouting("reversible", "/api/company-banks", bban, "POST"), "reversible");
  assert.equal(classifyPaymentRouting("reversible", "/api/company-banks/7", bban, "PUT"), "irreversible");
});

test("an employee's salary account is treated like every other payment destination", () => {
  const routed = (method, path, body) =>
    classifyPaymentRouting(classifyWithBody(classifyRequest(method, path), body), path, body, method);

  // The live gap: salary is paid on a schedule by machinery nobody re-reads, and the
  // person who notices is the employee whose pay did not arrive.
  assert.equal(routed("PATCH", "/api/employees/42", { accountNumber: "12345678903" }), "irreversible");
  assert.equal(
    routed("POST", "/api/employees", { name: "A", email: "a@b.no", accountNumber: "12345678903" }),
    "irreversible",
  );
  assert.equal(isAllowed(routed("PATCH", "/api/employees/42", { accountNumber: "1" }), "reversible"), false);

  // And every other field on the same endpoint is untouched, so renaming still works.
  assert.equal(routed("PATCH", "/api/employees/42", { name: "New Name" }), "reversible");
  assert.equal(routed("PATCH", "/api/employees/42", { email: "new@b.no", phone: "99887766" }), "reversible");
  assert.equal(routed("PATCH", "/api/employees/42", { departmentId: 3 }), "reversible");
  // A country code alone does not name an account.
  assert.equal(routed("PATCH", "/api/employees/42", { bankCountryCode: "SE" }), "reversible");
});

test("the field set covers the names the supplier-invoice schema actually uses", () => {
  // `swiftBic` and `routingNumber` were absent because the set was written against the
  // supplier schema, which spells the same concepts `swiftCode` and `bankAccountNumber`.
  for (const field of ["swiftBic", "routingNumber", "iban", "accountNumber"]) {
    assert.equal(
      classifyPaymentRouting("reversible", "/api/suppliers/7", { [field]: "X" }, "PATCH"),
      "irreversible",
      `${field} must be treated as a destination`,
    );
  }
  // The spec's own descriptions are the evidence, so pin them: if ReAI renames these, the
  // scan test above catches the new name and this one catches the loss of the old.
  const details = SCHEMAS.UpdateSupplierInvoicePaymentDetailsReq.properties;
  assert.match(details.swiftBic.description, /SWIFT\/BIC/);
  assert.match(details.routingNumber.description, /routing number/);
});

test("a chart-of-accounts code never produces a payment-routing verdict", () => {
  // The distinction that makes the field set path-scoped in the first place:
  // `accountNumber` on an employee is a bank account, and on an asset it is a
  // balance-sheet code the spec pins to /1\d{3}/.
  assert.match(SPEC.paths["/api/assets"].post.requestBody.content["application/json"].schema.$ref, /AssetReq/);
  assert.equal(SCHEMAS.AssetReq.properties.accountNumber.pattern, "1\\d{3}");

  assert.equal(classifyPaymentRouting("reversible", "/api/assets", { accountNumber: "1250" }, "POST"), "reversible");
  assert.equal(
    classifyPaymentRouting("reversible", "/api/loans", { principalAccountNumber: "2220" }, "POST"),
    "reversible",
  );
  assert.equal(
    classifyPaymentRouting(
      "reversible",
      "/api/supplier-invoices",
      { costLines: [{ accrualAccountNumber: "1460" }] },
      "POST",
    ),
    "reversible",
  );
});

// Recorded as a negative result rather than left as an assumption. The policy has always
// listed a /payment-details sub-resource and the README described it as protected — it
// matches no operation in the document, and the object it guards is written through the
// invoice itself. Kept because the protection should not depend on that staying true.
test("the payment-details sub-resource the policy guards does not exist in the spec", () => {
  const matching = Object.keys(SPEC.paths).filter((p) => /payment-details/.test(p));
  assert.deepEqual(matching, [], "if ReAI has added it, tighten this test into a positive one");

  // The place those fields really are written, and both are refused in the default mode.
  for (const [method, path] of [
    ["POST", "/api/supplier-invoices"],
    ["PATCH", "/api/supplier-invoices/7"],
    ["POST", "/api/invoice-reception-documents/9/supplier-invoice"],
  ]) {
    assert.equal(isAllowed(classifyRequest(method, path), "reversible"), false, `${method} ${path}`);
    assert.ok(
      PAYMENT_ROUTING_PATHS.some((re) => re.test(path)),
      `${path} should also be in payment-routing scope, so the protection does not rely on the path risk`,
    );
  }
});

// A curated tool commonly declares its reads and its writes together, and this helper has
// to force pathRisk to "reversible" in order to ask the question at all — so without a
// method check a GET carrying a routing-shaped argument came back irreversible. That is
// the same false positive the escape-hatch side documents fixing, and it became reachable
// the moment supplier-invoices entered routing scope.
test("a curated tool's READ operations are never escalated by their arguments", async () => {
  const { curatedArgsEscalate } = await import("../dist/policy.js");
  assert.equal(curatedArgsEscalate([["GET", "/api/supplier-invoices"]], { iban: "NO93" }), undefined);
  assert.equal(curatedArgsEscalate([["GET", "/api/employees"]], { accountNumber: "123" }), undefined);
  assert.equal(curatedArgsEscalate([["GET", "/api/suppliers/{id}"]], { iban: "NO93" }), undefined);

  // And the writes still escalate, including from a tool that declares both.
  const both = curatedArgsEscalate(
    [
      ["GET", "/api/employees"],
      ["PATCH", "/api/employees/{id}"],
    ],
    { accountNumber: "12345678903" },
  );
  assert.equal(both?.risk, "irreversible");
  assert.deepEqual(both?.fields, ["accountNumber"]);
  assert.match(both?.consequence, /where money is sent/);
});

// The nested walk is what makes the supplier-invoice paths mean anything. Before it, the
// scope regex matched and the body inspector looked only at the top level, so the guard
// did not apply to the one payload most obviously about where a payment goes.
test("a destination nested under paymentDetails is found", async () => {
  const { classifyPaymentRouting, paymentRoutingFields } = await import("../dist/policy.js");
  const body = { supplierId: 1, paymentDetails: { iban: "NO9386011117947" } };
  assert.deepEqual(paymentRoutingFields(body), ["iban"]);
  assert.equal(
    classifyPaymentRouting("reversible", "/api/supplier-invoices", body, "POST"),
    "irreversible",
    "nested beneficiary details must escalate on their own, not only via the path risk",
  );
  // Depth-bounded, and an array on the way down does not stop the walk.
  assert.deepEqual(paymentRoutingFields({ a: { b: [{ c: { iban: "X" } }] } }), ["iban"]);
  assert.deepEqual(paymentRoutingFields({ a: { b: { c: { d: { e: { iban: "X" } } } } } }), []);
  // A cost line's chart-of-accounts field is still not a destination.
  assert.deepEqual(paymentRoutingFields({ costLines: [{ accrualAccountNumber: "1460" }] }), []);
});

// Repointing an existing lease redirects rent and the deposit; creating one does not.
test("a lease's rent and deposit accounts are payment destinations", async () => {
  const { classifyPaymentRouting, classifyRequest, isAllowed } = await import("../dist/policy.js");
  const routed = (method, path, body) =>
    classifyPaymentRouting(classifyRequest(method, path), path, body, method);

  for (const field of ["rentAccountNumber", "depositAccountNumber"]) {
    assert.equal(
      routed("PUT", "/api/agreements/rent-agreement/7", { [field]: "12345678903" }),
      "irreversible",
      `${field} redirects money the tenant pays in`,
    );
  }
  // Editing the terms is ordinary work.
  assert.equal(routed("PUT", "/api/agreements/rent-agreement/7", { monthlyRent: 12000 }), "reversible");
  assert.equal(routed("PUT", "/api/agreements/rent-agreement/7", { petsAllowed: true }), "reversible");
  // And creating a lease is, on the same reasoning as adding a company bank: nothing is
  // diverted, and a human signs it before anyone pays.
  assert.ok(
    isAllowed(routed("POST", "/api/agreements/rent-agreement", { depositAccountNumber: "1" }), "reversible"),
  );
  assert.equal(
    routed("POST", "/api/company-banks", { bban: "12345678903" }),
    "reversible",
    "the company-bank exemption must survive being folded into the shared rule",
  );
  assert.equal(routed("PUT", "/api/company-banks/7", { bban: "12345678903" }), "irreversible");
});
