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
  assert.equal(Object.keys(body).length, 10, "the whole sub-object is written back, not a patch");
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
  // Measured behaviour elsewhere in this API: an unrecognised enum is refused, but a stored
  // value that differs from the one sent would otherwise read as success.
  const { text } = await run(
    "reai_update_agreement",
    { id: 290, changes: { depositType: "escrow" } },
    (req, n) => (n === 1 ? lease() : lease({ depositType: "deposit" })),
  );
  assert.match(text, /WARNING/);
  assert.match(text, /sent "escrow", stored "deposit"/);
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
  const { calls, text } = await run("reai_delete_agreement", { id: 290 }, undefined);
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].path, "/api/agreements/290");
  assert.match(text, /deleted \(HTTP 204\)/);
  assert.match(text, /returns no body/);
  assert.match(text, /reai_list_agreements is how to check/);
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

test("no signing endpoint is curated, because every one of them sends", () => {
  // Reading who was asked is fine; asking is not. If a future tool declares one of these
  // paths, it must also declare transmits, and that is what this pins.
  const sending = [/sign-request$/, /sign-requests$/, /sign-requests\/[^/]+\/send$/];
  for (const t of registeredTools) {
    for (const [method, path] of t.apiPaths ?? []) {
      if (method === "GET") continue;
      if (sending.some((re) => re.test(path))) {
        assert.ok(t.transmits, `${t.name} declares ${method} ${path} but not transmits: true`);
      }
    }
  }
});

test("a lease's payment destinations still escalate through the update tool", () => {
  // rentAccountNumber and depositAccountNumber name where a tenant's money goes. The tool is
  // declared reversible, so the routing layer is the only thing that stops a body carrying one
  // in the default mode — assert the path it writes to is actually in that scope.
  assert.equal(inPaymentRoutingScope("/api/agreements/rent-agreement/7", "PUT"), true);
  const declared = tool("reai_update_agreement").apiPaths.map(([, p]) => p);
  assert.ok(declared.includes("/api/agreements/rent-agreement/{id}"));
});
