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
  assert.equal(agreementTools.length, 5);
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
