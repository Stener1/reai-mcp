import { test } from "node:test";
import assert from "node:assert/strict";
import { agreementTools } from "../dist/tools/agreements.js";
import { registeredTools } from "../dist/server.js";
import { classifyRequest, inPaymentRoutingScope } from "../dist/policy.js";

const tool = (name) => {
  const found = agreementTools.find((t) => t.name === name);
  assert.ok(found, `${name} is not registered`);
  return found;
};

/** `responses` may be a function of (request, callNumber), since the update reads before writing. */
async function run(name, args, responses) {
  const calls = [];
  const result = await tool(name).handler(
    { tenantId: 2783, ...args },
    {
      client: {
        request: async (req) => {
          calls.push(req);
          const data = typeof responses === "function" ? responses(req, calls.length) : responses;
          return { data, status: req.method === "DELETE" ? 204 : 200 };
        },
        deepLink: () => "link",
      },
      config: { writeMode: "full", tenantId: 2783, allowExternalSend: false },
      session: {},
    },
  );
  return { calls, result, text: result.content.find((c) => c.type === "text").text };
}

/** A lease as the live API returns one: a wrapper with one populated sub-object. */
const lease = (overrides = {}) => ({
  agreementId: 290,
  templateType: "rent_agreement",
  signStatus: "draft",
  signerEmail: null,
  documentId: null,
  accountingServices: null,
  employeeContract: null,
  serviceAgreement: null,
  purchaseAgreement: null,
  rentAgreement: {
    landlordName: "ZZ Utleier",
    tenantName: "ZZ Leietaker",
    propertyAddress: "Prøvegata 1",
    monthlyRent: 12000,
    rentDueDayOfMonth: 1,
    depositType: "deposit",
    depositAmount: 36000,
    depositAccountNumber: "15031234567",
    petsAllowed: true,
    otherTerms: "ZZ original terms",
    ...overrides,
  },
});

// ---------------------------------------------------------------------------
// The reason this toolset exists: PUT replaces, so a partial edit destroys terms.
// ---------------------------------------------------------------------------

test("an update reads first and writes back every field it was not asked to change", async () => {
  const { calls, text } = await run(
    "reai_update_agreement",
    { id: 290, changes: { monthlyRent: 13500 } },
    (req, n) => (n === 1 ? lease() : { ...lease({ monthlyRent: 13500 }) }),
  );
  assert.deepEqual(
    calls.map((c) => c.method),
    ["GET", "PUT"],
    "it must read before writing, or the PUT erases the rest of the contract",
  );
  const body = calls[1].body;
  // The whole point: the untouched terms are present in the write.
  assert.equal(body.monthlyRent, 13500);
  assert.equal(body.tenantName, "ZZ Leietaker");
  assert.equal(body.depositAmount, 36000);
  assert.equal(body.depositAccountNumber, "15031234567", "a payment destination must not be dropped");
  assert.equal(body.otherTerms, "ZZ original terms");
  assert.equal(body.petsAllowed, true);
  // Self-updating against the fixture, rather than a hardcoded count.
  assert.deepEqual(
    Object.keys(body).sort(),
    Object.keys(lease().rentAgreement).sort(),
    "the whole sub-object is written back, not a patch",
  );
  assert.match(text, /written back unchanged/);
});

test("the write goes to the path for the agreement's own template", async () => {
  for (const [templateType, segment] of [
    ["rent_agreement", "rent-agreement"],
    ["employee_contract", "employee-contract"],
    ["accounting_services", "accounting-services"],
    ["service_agreement", "service-agreement"],
    ["purchase_agreement", "purchase-agreement"],
  ]) {
    const subKey = {
      rent_agreement: "rentAgreement",
      employee_contract: "employeeContract",
      accounting_services: "accountingServices",
      service_agreement: "serviceAgreement",
      purchase_agreement: "purchaseAgreement",
    }[templateType];
    const record = { agreementId: 7, templateType, [subKey]: { otherTerms: "x" } };
    const { calls } = await run(
      "reai_update_agreement",
      { id: 7, changes: { otherTerms: "y" } },
      () => record,
    );
    // Editing through the wrong template path is refused by the API with a Norwegian message,
    // so picking it from templateType rather than guessing is what makes this work at all.
    assert.equal(calls[1].path, `/api/agreements/${segment}/7`, templateType);
  }
});

test("an update refuses when the current terms cannot be read", async () => {
  // A merge with no base IS the destructive replacement this tool exists to prevent, with the
  // caller believing they made a small edit.
  const { calls, result, text } = await run(
    "reai_update_agreement",
    { id: 290, changes: { monthlyRent: 13500 } },
    () => ({ agreementId: 290, templateType: "rent_agreement", rentAgreement: null }),
  );
  assert.equal(result.isError, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET"], "nothing may be written");
  assert.match(text, /Nothing was written/);
  assert.match(text, /would have erased everything/);
});

test("an unknown template is refused rather than sent to a guessed path", async () => {
  const { calls, result, text } = await run(
    "reai_update_agreement",
    { id: 7, changes: { otherTerms: "y" } },
    () => ({ agreementId: 7, templateType: "franchise_agreement", rentAgreement: { a: 1 } }),
  );
  assert.equal(result.isError, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  assert.match(text, /franchise_agreement/);
  assert.match(text, /riktig avtalemal/, "the API's own refusal is worth quoting");
});

test("an empty change set is refused, not turned into a pointless rewrite", async () => {
  const { calls, result } = await run("reai_update_agreement", { id: 290, changes: {} }, () => lease());
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0, "it must not even read");
});

test("a value the API silently did not store is reported, not assumed", async () => {
  // A non-enum field, since an unrecognised enum member is now refused locally before the write.
  const { text } = await run(
    "reai_update_agreement",
    { id: 290, changes: { monthlyRent: 13500 } },
    (req, n) => (n === 1 ? lease() : lease({ monthlyRent: 12000 })),
  );
  assert.match(text, /WARNING/);
  assert.match(text, /monthlyRent: sent 13500, stored 12000/);
});

// The enums ARE in the spec — an earlier version of this toolset claimed they were not, which
// was simply wrong. Since they are documented, they can be checked locally, and the members are
// lowercase snake_case, which is not what anyone guesses from a Norwegian contract form.
test("a value outside a documented enum is refused before the write, naming the members", async () => {
  const { calls, result, text } = await run(
    "reai_update_agreement",
    { id: 290, changes: { depositType: "escrow" } },
    () => lease(),
  );
  assert.equal(result.isError, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET"], "nothing may be written");
  assert.match(text, /depositType/);
  assert.match(text, /deposit \| guarantee/);
  assert.match(text, /lowercase snake_case/);
});

test("the enum check reads the spec rather than a copy of it", async () => {
  // If it were a hand-written list, a field the document constrains and the list forgot would
  // pass through to a bare 400 — which is the failure the check exists to remove.
  const { findOperation } = await import("../dist/reai/spec.js");
  const fields = findOperation("PUT", "/api/agreements/rent-agreement/{id}")?.body?.fields ?? {};
  const enums = Object.entries(fields).filter(([, v]) => typeof v === "string" && v.startsWith("enum("));
  assert.ok(enums.length >= 6, `expected the lease's documented enums; found ${enums.length}`);
  // Every one of them must be enforced, not just the two that were measured by hand.
  for (const [name, declared] of enums) {
    const { result } = await run(
      "reai_update_agreement",
      { id: 290, changes: { [name]: "ZZ-not-a-member" } },
      () => lease(),
    );
    assert.equal(result.isError, true, `${name} (${declared}) must be checked`);
  }
  // ...and a legitimate member passes.
  const good = await run(
    "reai_update_agreement",
    { id: 290, changes: { leaseDurationType: "fixed_standard" } },
    (req, n) => (n === 1 ? lease() : lease({ leaseDurationType: "fixed_standard" })),
  );
  assert.notEqual(good.result.isError, true);
});

test("an empty template sub-object is not accepted as a base to merge into", async () => {
  // `{}` is truthy, so the first version let it through: the merge then wrote only the caller's
  // changes — the destructive replacement this tool exists to prevent — and the note reported
  // "the other -1 field(s) written back unchanged".
  const { calls, result, text } = await run(
    "reai_update_agreement",
    { id: 290, changes: { monthlyRent: 13500 } },
    () => ({ agreementId: 290, templateType: "rent_agreement", rentAgreement: {} }),
  );
  assert.equal(result.isError, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  assert.match(text, /would have erased everything/);
});

test("the untouched-field count is right when a term is set for the first time", async () => {
  const { text } = await run(
    "reai_update_agreement",
    { id: 290, changes: { landlordEmail: "zz@example.invalid" } },
    (req, n) => (n === 1 ? lease() : lease({ landlordEmail: "zz@example.invalid" })),
  );
  // The fixture carries 10 fields and landlordEmail is not one of them, so all 10 are carried
  // over. Subtracting the change count would have said 9.
  assert.match(text, /the other 10 field\(s\)/);
});

test("the terms are located by templateType, not by whichever sub-object comes first", async () => {
  // Scanning in declaration order reported a lease's fields as living under accountingServices,
  // and on a PUT response produced "stored undefined" for a value that was stored correctly.
  const twoPopulated = {
    agreementId: 290,
    templateType: "rent_agreement",
    accountingServices: { clientCompanyName: "ZZ Decoy" },
    rentAgreement: lease().rentAgreement,
  };
  const read = await run("reai_get_agreement", { id: 290 }, twoPopulated);
  // The NOTE only — the body below it echoes the record, decoy key included.
  const note = read.text.split("\n\n")[0];
  assert.match(note, /under `rentAgreement`/);
  assert.doesNotMatch(note, /accountingServices/);

  const { calls, text } = await run(
    "reai_update_agreement",
    { id: 290, changes: { monthlyRent: 13500 } },
    (req, n) => (n === 1 ? twoPopulated : { ...twoPopulated, rentAgreement: lease({ monthlyRent: 13500 }).rentAgreement }),
  );
  assert.equal(calls[1].body.tenantName, "ZZ Leietaker", "it merged the lease, not the decoy");
  assert.doesNotMatch(text, /WARNING/, "the response diff must read the same sub-object it wrote");

  // The response is where re-scanning actually bites: with templateType absent from IT, a
  // rescan lands on the decoy and reports every change as "stored undefined" — which an agent
  // reads as "the edit did not take" for a value that was stored correctly.
  const noTypeOnResponse = await run(
    "reai_update_agreement",
    { id: 290, changes: { monthlyRent: 13500 } },
    (req, n) =>
      n === 1
        ? twoPopulated
        // A response carrying only the DECOY and no templateType. Re-scanning finds
        // accountingServices confidently, sees no monthlyRent in it, and reports
        // "sent 13500, stored undefined" for a value that was stored correctly. Keying off the
        // sub-object the request wrote to instead yields nothing to compare, and the diff is
        // skipped rather than inverted.
        : { agreementId: 290, accountingServices: { clientCompanyName: "ZZ Decoy" } },
  );
  assert.doesNotMatch(
    noTypeOnResponse.text,
    /WARNING/,
    "the diff must use the key the REQUEST wrote to, not re-scan a response that cannot say",
  );
});

test("an agreement with no templateType is refused by the update, before any guessing", async () => {
  // The templateType guard fires first, which is the right order: without it there is no path to
  // write to, and picking one would edit through the wrong template.
  const { calls, result, text } = await run(
    "reai_update_agreement",
    { id: 290, changes: { monthlyRent: 13500 } },
    () => ({ agreementId: 290, accountingServices: { a: 1 }, rentAgreement: { b: 2 } }),
  );
  assert.equal(result.isError, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  assert.match(text, /does not know how to edit/);
});

test("reading an agreement with two populated templates and no templateType reports ambiguity", async () => {
  // The read tool has no path to choose, so it can still say what it found — and must not pick
  // the first sub-object and present it as the terms.
  const { text } = await run("reai_get_agreement", { id: 290 }, {
    agreementId: 290,
    accountingServices: { clientCompanyName: "ZZ" },
    rentAgreement: { monthlyRent: 12000 },
  });
  const note = text.split("\n\n")[0];
  assert.match(note, /more than one/i);
  assert.doesNotMatch(note, /the terms are under/);
});

test("a field the agreement does not already carry is flagged as possibly misspelt", async () => {
  const { text } = await run(
    "reai_update_agreement",
    { id: 290, changes: { monthlyRentt: 13500 } },
    (req, n) => (n === 1 ? lease() : lease({ monthlyRentt: 13500 })),
  );
  assert.match(text, /monthlyRentt/);
  assert.match(text, /misspelt name looks exactly the same/);
});

test("a deliberate null is passed through, since clearing a term is legitimate", async () => {
  const { calls } = await run(
    "reai_update_agreement",
    { id: 290, changes: { otherTerms: null } },
    (req, n) => (n === 1 ? lease() : lease({ otherTerms: null })),
  );
  assert.equal(calls[1].body.otherTerms, null);
  // ...and the rest still survives.
  assert.equal(calls[1].body.monthlyRent, 12000);
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test("reading an agreement says where the terms actually are", async () => {
  const { text } = await run("reai_get_agreement", { id: 290 }, lease());
  assert.match(text, /under `rentAgreement`/);
  assert.match(text, /10 of 10 fields are set/);
});

test("an all-but-empty draft is called out, because the API will still render its PDF", async () => {
  const { text } = await run("reai_get_agreement", { id: 291, changes: {} }, {
    agreementId: 291,
    templateType: "rent_agreement",
    rentAgreement: { landlordName: "ZZ", tenantName: null, monthlyRent: null, otherTerms: null },
  });
  assert.match(text, /effectively an empty draft/);
  assert.match(text, /still render a PDF/);
});

test("a wrapper with nothing populated is not reported as an agreement with terms", async () => {
  const { text } = await run("reai_get_agreement", { id: 292 }, {
    agreementId: 292,
    templateType: "rent_agreement",
    rentAgreement: null,
    employeeContract: null,
  });
  assert.match(text, /None of the five template sub-objects is populated/);
});

test("a non-draft signing status is surfaced when reading", async () => {
  const sent = lease();
  sent.signStatus = "sent";
  const { text } = await run("reai_get_agreement", { id: 290 }, sent);
  assert.match(text, /Signing status is "sent"/);
  assert.match(text, /may not change the document anyone has already received/);
});

test("the list counts drafts and does not read an empty list as having no contracts", async () => {
  const listed = await run("reai_list_agreements", {}, [
    { agreementId: 1, templateType: "rent_agreement", signStatus: "draft" },
    { agreementId: 2, templateType: "employee_contract", signStatus: "signed" },
  ]);
  assert.match(listed.text, /1 still in draft/);
  assert.match(listed.text, /rent_agreement, employee_contract/);

  const empty = await run("reai_list_agreements", {}, []);
  assert.match(empty.text, /on paper or in another system does not appear here/);
});

test("the signers response is read as an object, not a list", async () => {
  const some = await run("reai_list_agreement_signers", { id: 290 }, {
    agreementId: 290,
    documentId: 5,
    signStatus: "sent",
    signRequests: [{ signRequestId: 1, signerEmail: "a@b.invalid", status: "pending" }],
  });
  assert.match(some.text, /1 signing request\(s\)/);

  const none = await run("reai_list_agreement_signers", { id: 290 }, {
    agreementId: 290,
    signStatus: "draft",
    signRequests: [],
  });
  assert.match(none.text, /Nobody has been asked to sign yet/);
  assert.match(none.text, /draft document, not a contract in force/);

  // A shape change must not read as "nobody has signed".
  const wrong = await run("reai_list_agreement_signers", { id: 290 }, [{ signRequestId: 1 }]);
  assert.match(wrong.text, /no `signRequests` array/);
  assert.doesNotMatch(wrong.text, /Nobody has been asked/);
});

test("delete reports the status, since the endpoint returns no body at all", async () => {
  const { calls, text } = await run("reai_delete_agreement", { id: 290 }, (req, n) =>
    n === 1 ? { agreementId: 290, signStatus: "draft" } : undefined,
  );
  assert.deepEqual(calls.map((c) => c.method), ["GET", "DELETE"], "it reads the signing status first");
  assert.equal(calls[1].path, "/api/agreements/290");
  assert.match(text, /deleted \(HTTP 204\)/);
  assert.match(text, /returns no body/);
  assert.match(text, /reai_list_agreements is how to check/);
});

// The description said "prefer keeping the record" and then deleted unconditionally, in the
// DEFAULT write mode, with a 204 and no body to check afterwards.
test("a signed agreement is not deleted, because that behaviour was never established", async () => {
  for (const signStatus of ["sent", "signed", "partially_signed"]) {
    const { calls, result, text } = await run("reai_delete_agreement", { id: 290 }, () => ({
      agreementId: 290,
      signStatus,
    }));
    assert.equal(result.isError, true, signStatus);
    assert.deepEqual(calls.map((c) => c.method), ["GET"], `${signStatus}: nothing may be deleted`);
    assert.match(text, /Nothing was deleted/);
    // And it says how to proceed deliberately, rather than just refusing.
    assert.match(text, /reai_request DELETE/);
  }
  // A draft, and a record whose status the response omits, still delete: refusing on an absent
  // field would block the ordinary case on a shape surprise.
  for (const record of [{ signStatus: "draft" }, {}]) {
    const { calls, result } = await run("reai_delete_agreement", { id: 290 }, (req, n) =>
      n === 1 ? { agreementId: 290, ...record } : undefined,
    );
    assert.notEqual(result.isError, true, JSON.stringify(record));
    assert.equal(calls.length, 2);
  }
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

test("every agreement tool is inside the sweeps and none transmits", () => {
  assert.equal(agreementTools.length, 6);
  for (const t of agreementTools) {
    assert.ok(registeredTools.includes(t), `${t.name} must be inside the invariant sweeps`);
    assert.ok(!t.transmits, `${t.name} must not leave the tenant`);
    for (const [method, path] of t.apiPaths ?? []) {
      const viaPolicy = classifyRequest(method, path.replace(/\{[^}]+\}/g, "7"));
      if (viaPolicy === "irreversible") assert.equal(t.risk, "irreversible", `${t.name}`);
    }
  }
  for (const name of ["reai_list_agreements", "reai_get_agreement", "reai_list_agreement_signers"]) {
    assert.equal(tool(name).risk, "read", name);
  }
  assert.equal(tool("reai_delete_agreement").destructive, true);
});

test("changing terms is irreversible, in step with the raw PUT it wraps", async () => {
  // Not because this tool is dangerous — it is the safe way to do the job — but because the
  // underlying PUT replaces the record, and a curated tool must not be a softer route to an
  // operation the escape hatch is gated on. Both halves are asserted, since the whole point is
  // that they agree.
  assert.equal(tool("reai_update_agreement").risk, "irreversible");
  assert.equal(classifyRequest("PUT", "/api/agreements/rent-agreement/7"), "irreversible");
  const { isAllowed } = await import("../dist/policy.js");
  assert.equal(isAllowed("irreversible", "reversible"), false);
  // Creating one stays reversible: it is additive and DELETE answers 204, verified live.
  assert.equal(classifyRequest("POST", "/api/agreements/rent-agreement"), "reversible");
  // And the id-shaped sub-resources must not be swept up by the template-segment rule.
  assert.equal(classifyRequest("PUT", "/api/agreements/290"), "reversible");
});

// The first version of this matched sign-request paths and asserted transmits — and no tool
// declares one, so it pinned nothing at all. Derived from the policy instead, it constrains four
// real declarations today.
test("any curated tool that declares a transmitting write says so", async () => {
  const { classifyTransmission } = await import("../dist/policy.js");
  // reai_register_supplier_invoice_payment is external only for the bank-integrated branch, and
  // it gates that in its handler — declaring transmits would hide the books-only use entirely.
  const GATES_IN_ITS_HANDLER = new Set(["reai_register_supplier_invoice_payment"]);
  const checked = [];
  for (const t of registeredTools) {
    for (const [method, path] of t.apiPaths ?? []) {
      if (method === "GET") continue;
      if (classifyTransmission(method, path.replace(/\{[^}]+\}/g, "7")) !== "external") continue;
      checked.push(`${t.name}: ${method} ${path}`);
      if (GATES_IN_ITS_HANDLER.has(t.name)) continue;
      assert.ok(t.transmits, `${t.name} declares ${method} ${path} but not transmits: true`);
    }
  }
  assert.ok(checked.length >= 3, `expected real transmitting declarations; found ${checked.length}`);
});

test("a lease's payment destinations escalate from INSIDE the changes object", async () => {
  // The load-bearing fact is nested reachability: `changes` carries the whole lease, and only
  // paymentRoutingFields recurses (the sibling inspectors are top-level only). Asserting
  // inPaymentRoutingScope alone was a restatement of policy.test.mjs — swapping the recursive
  // walk for a shallow one would have left it green while the gate went silent.
  const { curatedArgsEscalate } = await import("../dist/policy.js");
  const paths = tool("reai_update_agreement").apiPaths;
  for (const field of ["depositAccountNumber", "rentAccountNumber"]) {
    const escalated = curatedArgsEscalate(paths, { id: 7, changes: { [field]: "15031234567" } });
    assert.ok(escalated, `${field} nested inside changes must escalate`);
    assert.equal(escalated.risk, "irreversible");
    assert.ok(escalated.fields.includes(field), `the refusal must name ${field}`);
  }
  // An ordinary term nested the same way must NOT escalate, or the gate is just noise.
  assert.equal(curatedArgsEscalate(paths, { id: 7, changes: { monthlyRent: 12000 } }), undefined);
  assert.equal(inPaymentRoutingScope("/api/agreements/rent-agreement/7", "PUT"), true);
});

/**
 * The agreement enums ARE declared, and four places said they were not.
 *
 * `src/tools/agreements.ts` already carried the correction in its file header — "The enums ARE
 * documented — an earlier version of this comment said otherwise … there are 14 such fields across
 * the five templates". The correction had been applied to that comment and to nowhere a reader or an
 * agent could see it:
 *
 *   src/reai/quirks.ts       "enums the document does not list"     <- served by reai_describe_endpoint
 *   src/tools/agreements.ts  "enums that the spec does not list"    <- the tool description
 *   docs/tools.md            "enums the spec never lists"
 *   README.md                "the enums the spec types as plain strings"
 *
 * The quirk is the one that mattered: an agent told the document does not list the members will not
 * call reai_describe_endpoint to get them, and will guess — which the header records as having
 * produced 400s ("The rejected values were simply wrong guesses").
 *
 * The first version of the guard below caught three of those four and its comment claimed all four.
 * The README's wording carries the claim by IMPLICATION rather than by denial — a field the document
 * "types as plain strings" is one whose members it does not give — so no pattern looking for "does
 * not", "never" or "silent" could match it. Found by Codex on PR #123, and the reason the check now
 * also runs against the rendered quirk notes and tool descriptions rather than only source lines.
 */
test("the spec declares every agreement enum, and nothing says otherwise", async () => {
  const { findOperation } = await import("../dist/reai/spec.js");
  const segments = [
    "accounting-services",
    "employee-contract",
    "rent-agreement",
    "service-agreement",
    "purchase-agreement",
  ];
  const declared = [];
  for (const segment of segments) {
    const fields = findOperation("POST", `/api/agreements/${segment}`)?.body?.fields ?? {};
    for (const [name, type] of Object.entries(fields)) {
      if (typeof type === "string" && type.startsWith("enum(")) declared.push(`${segment}.${name}`);
    }
  }
  // The figure the docs now state. Asserted so a spec refresh that drops the declarations makes the
  // prose stale HERE, rather than leaving four documents quietly wrong again.
  assert.equal(declared.length, 14, `enum fields declared: ${declared.join(", ")}`);
  // FOUR of the five templates, not five: purchase-agreement declares none. And 14 occurrences are only 12
  // distinct names, because clientEntityType and billingFrequency appear on two templates each. Both were
  // stated wrongly in the first version of this work and are asserted here so the prose cannot drift again.
  const withEnums = new Set(declared.map((d) => d.split(".")[0]));
  assert.equal(withEnums.size, 4, `templates declaring an enum: ${[...withEnums].join(", ")}`);
  assert.ok(!withEnums.has("purchase-agreement"), "purchase-agreement declares no enum");
  assert.equal(new Set(declared.map((d) => d.split(".")[1])).size, 12, "distinct enum field names");
  // And the two the prose names by hand have to be among them, with the members it quotes.
  const lease = findOperation("POST", "/api/agreements/rent-agreement")?.body?.fields ?? {};
  assert.match(String(lease.leaseDurationType), /^enum\(indefinite\|fixed_standard\|fixed_special_reason\)/);
  assert.match(String(lease.depositType), /^enum\(deposit\|guarantee\)/);
});

test("no agent-facing text claims the agreement enums are undocumented", async () => {
  const { readFileSync } = await import("node:fs");
  const { QUIRKS } = await import("../dist/reai/quirks.js");
  // The claim in every form it has taken, plus the shape a future rewrite would most likely use.
  const false_claims = [
    /enums?[^.]{0,40}(the )?(document|spec|schema)[^.]{0,20}(does not|never|doesn't)\s+(list|document|declare)/i,
    /(document|spec)[^.]{0,30}(is )?silent[^.]{0,20}enum/i,
    // The README's own wording, which the FIRST version of this guard missed while its comment claimed to
    // cover all four. "Types as plain strings" is the same claim by implication — a field the document types
    // as a plain string is one whose members it does not give — and it contains no "does not", "never" or
    // "silent" for the patterns above to catch. Found by Codex on PR #123.
    /(spec|document|schema)\s+types[^.]{0,25}as\s+plain\s+strings/i,
    /types?\s+as\s+plain\s+strings[^.]{0,30}(enum|validated)/i,
  ];
  const sources = [
    ["src/reai/quirks.ts", readFileSync("src/reai/quirks.ts", "utf8")],
    ["src/tools/agreements.ts", readFileSync("src/tools/agreements.ts", "utf8")],
    ["docs/tools.md", readFileSync("docs/tools.md", "utf8")],
    ["README.md", readFileSync("README.md", "utf8")],
  ];
  // QUOTED spans are stripped rather than whole lines skipped, and that distinction is the finding.
  // The first version skipped any line containing "an earlier version", "for a while" and so on, so that
  // recording the mistake stayed legal. But markdown puts a whole paragraph on one line: adding "This
  // paragraph said the opposite for a while" to docs/tools.md switched the guard OFF for the entire
  // agreements paragraph, and the independent review of PR #123 proved it by appending a fresh false sentence
  // there and watching the test stay green. Removing the quotes instead keeps the correction legal and leaves
  // every other word on the line checked.
  const stripQuotes = (line) =>
    line.replace(/"[^"]*"/g, " ").replace(/\u201c[^\u201d]*\u201d/g, " ").replace(/`[^`]*`/g, " ");
  const offenders = [];
  for (const [file, text] of sources) {
    for (const line of text.split("\n")) {
      const naked = stripQuotes(line);
      if (false_claims.some((re) => re.test(naked))) offenders.push(`${file}: ${line.trim().slice(0, 90)}`);
    }
  }
  assert.deepEqual(offenders, [], `these still say the enums are undocumented:\n  ${offenders.join("\n  ")}`);

  // The four wordings this guard exists for, as they actually stood, asserted to be caught. Written as a
  // fixture rather than trusted: the first version matched three of them while its comment claimed four, and
  // the one it missed — the README's — was the most-read surface of the four. A pattern list is only as good
  // as the examples it is checked against.
  const historical = {
    "quirks.ts": "schema types as plain strings are validated as enums the document does not list, and the",
    "agreements.ts": "schema types as plain strings are validated as enums that the spec does not list; the API",
    "docs/tools.md": "some fields the schema types as plain strings are validated as enums the spec never lists",
    "README.md": "That, the enums the spec types as plain strings, and why the five create endpoints",
  };
  const uncaught = Object.entries(historical)
    .filter(([, wording]) => !false_claims.some((re) => re.test(wording)))
    .map(([where]) => where);
  assert.deepEqual(uncaught, [], `the guard would not catch these historical wordings: ${uncaught.join(", ")}`);

  // Then the same check on the strings as SERVED rather than as written, which is the version that matters and
  // the one a line-by-line scan cannot see: a description is concatenated from a dozen literals, so a claim
  // split across two of them matches no single line. Codex made this point on PR #123 and it is the better
  // instrument.
  const served = QUIRKS.filter((q) => (q.paths ?? []).some((p) => /agreement/.test(p)))
    .map((q) => q.note ?? "")
    .join("\n");
  assert.ok(served.length > 0, "there should be agreement quirks to check");
  const { registeredTools } = await import("../dist/server.js");
  const descriptions = registeredTools
    .filter((t) => (t.apiPaths ?? []).some(([, path]) => /agreement/.test(path)))
    .map((t) => `${t.name}: ${t.description ?? ""}`)
    .join("\n");
  assert.ok(descriptions.includes("reai_update_agreement"), "the agreement tool descriptions should be readable");
  for (const re of false_claims) {
    assert.doesNotMatch(served, re, "a quirk served to agents says the enums are undocumented");
    assert.doesNotMatch(descriptions, re, "a tool description says the enums are undocumented");
  }
});

/**
 * `reai_create_agreement`.
 *
 * The toolset could update and delete an agreement but not make one, so the only route to the five
 * POST endpoints was `reai_request` — and endpoint search answers "create agreement" with
 * `POST /api/agreements/{id}/sign-request`, an irreversible EXTERNAL send, ranked above all five
 * creation calls. The gap is why the wrong answer was the reachable one.
 */

/** The five templates and the sub-object each response carries its terms in. */
const TEMPLATES = {
  rent_agreement: { segment: "rent-agreement", sub: "rentAgreement" },
  employee_contract: { segment: "employee-contract", sub: "employeeContract" },
  accounting_services: { segment: "accounting-services", sub: "accountingServices" },
  service_agreement: { segment: "service-agreement", sub: "serviceAgreement" },
  purchase_agreement: { segment: "purchase-agreement", sub: "purchaseAgreement" },
};

/** A create response: the wrapper, with the created terms echoed under the template's own key. */
const created = (templateType, fields, overrides = {}) => ({
  agreementId: 601,
  templateType,
  signStatus: "draft",
  ...Object.fromEntries(Object.values(TEMPLATES).map(({ sub }) => [sub, null])),
  [TEMPLATES[templateType].sub]: fields,
  ...overrides,
});

test("creating with no terms is refused, and nothing is sent", async () => {
  // The API marks no field required, so POST {} answers 201 with every term null — and the PDF
  // renders that. An agent that lost the terms would otherwise create a contract saying nothing.
  const { calls, result, text } = await run(
    "reai_create_agreement",
    { templateType: "rent_agreement", terms: {} },
    () => created("rent_agreement", {}),
  );
  assert.equal(result.isError, true);
  assert.deepEqual(calls, [], "a refusal must not reach the API");
  assert.match(text, /every term is null/);
  assert.match(text, /reai_request/, "the deliberate blank-draft route is named");
});

test("every documented enum is checked on every template, before anything is created", async () => {
  const { findOperation } = await import("../dist/reai/spec.js");
  let checked = 0;
  for (const [templateType, { segment }] of Object.entries(TEMPLATES)) {
    const fields = findOperation("POST", `/api/agreements/${segment}`)?.body?.fields ?? {};
    for (const [name, declared] of Object.entries(fields)) {
      if (typeof declared !== "string" || !declared.startsWith("enum(")) continue;
      checked += 1;
      const { calls, result } = await run(
        "reai_create_agreement",
        { templateType, terms: { [name]: "ZZ-not-a-member" } },
        () => created(templateType, {}),
      );
      assert.equal(result.isError, true, `${templateType}.${name} (${declared}) must be checked`);
      assert.deepEqual(calls, [], `${templateType}.${name} refused but still called the API`);
    }
  }
  // The document declares 14 across four templates; purchase_agreement carries none. A refresh that
  // drops them all would otherwise leave this test asserting nothing.
  assert.equal(checked, 14, `expected the 14 documented enums, checked ${checked}`);
});

test("a legitimate value posts to the template's own path, with the terms as the body", async () => {
  const terms = { employmentType: "permanent", salaryType: "monthly", employeeName: "ZZ Ansatt" };
  const { calls, result, text } = await run(
    "reai_create_agreement",
    { templateType: "employee_contract", terms },
    () => created("employee_contract", terms),
  );
  assert.notEqual(result.isError, true);
  assert.equal(calls.length, 1, "creating reads nothing first");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/api/agreements/employee-contract");
  assert.deepEqual(calls[0].body, terms, "the terms are the body, unwrapped");
  assert.match(text, /agreementId 601/);
  assert.match(text, /unsigned draft/, "an agent must not read this as having sent anything");
});

test("a term the template does not declare is reported, not silently dropped", async () => {
  // A misspelt field name is accepted by the API and simply missing from the finished contract.
  const { calls, result, text } = await run(
    "reai_create_agreement",
    { templateType: "rent_agreement", terms: { monthlyRent: 12000, mnthlyRnt: 999, tenantName: "ZZ" } },
    (req) => created("rent_agreement", { monthlyRent: 12000, tenantName: "ZZ" }),
  );
  assert.notEqual(result.isError, true, "the spec can lag the API, so this warns rather than refuses");
  assert.equal(calls.length, 1);
  assert.match(text, /mnthlyRnt/);
  assert.match(text, /not declared in/);
});

test("a term the API did not store is reported against what was sent", async () => {
  const { text } = await run(
    "reai_create_agreement",
    { templateType: "rent_agreement", terms: { monthlyRent: 12000, tenantName: "ZZ Leietaker" } },
    () => created("rent_agreement", { monthlyRent: null, tenantName: "ZZ Leietaker" }),
  );
  assert.match(text, /WARNING/);
  assert.match(text, /monthlyRent: sent 12000, stored null/);
});

test("a near-empty created contract says so, because the PDF will render anyway", async () => {
  const { text } = await run(
    "reai_create_agreement",
    { templateType: "purchase_agreement", terms: { sellerName: "ZZ Selger" } },
    () => created("purchase_agreement", { sellerName: "ZZ Selger" }),
  );
  assert.match(text, /very few terms/);
});

test("a term named after an Object prototype member is treated as a term, not as declared", async () => {
  // `k in declared` walks the prototype chain, so `toString` looked like a declared field and
  // skipped the warning. Object.hasOwn is why this reports it.
  const { result, text } = await run(
    "reai_create_agreement",
    { templateType: "purchase_agreement", terms: { toString: "ZZ", constructor: "ZZ" } },
    () => created("purchase_agreement", {}),
  );
  assert.notEqual(result.isError, true);
  assert.match(text, /toString/);
  assert.match(text, /constructor/);
});

test("creating is reversible and transmits nothing, unlike the sign-request it outranks", async () => {
  const create = tool("reai_create_agreement");
  assert.equal(create.risk, "reversible");
  const { classifyTransmission } = await import("../dist/policy.js");
  for (const [method, path] of create.apiPaths) {
    assert.equal(classifyRequest(method, path), "reversible", `${method} ${path}`);
    assert.equal(classifyTransmission(method, path), "none", `${method} ${path}`);
  }
  // The five it covers are exactly the five templates, and none of them is a signing call.
  assert.equal(create.apiPaths.length, 5);
  for (const [, path] of create.apiPaths) assert.doesNotMatch(path, /sign/);
});
