import { z } from "zod";
import { defineTool, fail, ok, okList, requireTenantId, tenantIdArg, type ToolDef } from "./registry.js";

/**
 * Contracts (avtaler): leases, employment contracts, purchase and service agreements.
 *
 * ReAI generates a formatted Norwegian contract document from a form, and the document can then
 * be sent out for electronic signature. Everything below was measured against test tenant 2783.
 *
 * ## Updating an agreement REPLACES it, and the API says nothing about that
 *
 * The reason this toolset exists. `PUT /api/agreements/rent-agreement/{id}` is a full
 * replacement, so a caller who sends the one field they meant to change silently destroys every
 * other term. Measured on a lease with rent, tenant, deposit and house rules filled in:
 *
 *   PUT { landlordName: "..." }  → 200
 *   GET → monthlyRent: null, tenantName: null, depositAmount: null,
 *         depositAccountNumber: null, petsAllowed: false, otherTerms: null
 *
 * The deposit ACCOUNT NUMBER is among the casualties, and `GET /pdf` afterwards still answers
 * 200 with a rendered PDF — so the failure produces a document that looks like a contract and
 * has no terms in it. Nothing in the response hints at any of this.
 *
 * `reai_update_agreement` reads the agreement, merges the requested changes over what is
 * already there, and writes the whole thing back. That the round-trip is lossless was verified
 * rather than assumed: the 78-key sub-object a GET returns can be PUT back verbatim with no
 * field changing value.
 *
 * ## Nothing is required, so an empty body creates a contract
 *
 * `POST /api/agreements/rent-agreement {}` answers 201 with a draft agreement in which every
 * term is null. No field is marked required in any of the five request schemas, and the PDF
 * renders for that too.
 *
 * ## The shapes are not what the endpoint names suggest
 *
 * The identifier is `agreementId`, NOT `id` — reading `.id` yields undefined, which is how the
 * first cleanup in this toolset's own measurement deleted nothing. `GET /api/agreements/{id}`
 * returns a WRAPPER with five nullable sub-objects (`accountingServices`, `employeeContract`,
 * `rentAgreement`, `serviceAgreement`, `purchaseAgreement`), exactly one of which is populated,
 * so a lease's terms are under `rentAgreement` rather than at the top level. DELETE answers
 * 204 with no body — there is no `{"outcome": ...}` here, unlike the records that archive.
 *
 * ## What the API does NOT check
 *
 * Norwegian tenancy law caps a deposit at six months' rent (husleieloven § 3-5) and requires a
 * statutory reason for a fixed term under three years (§ 9-3). Measured: a deposit of 9 999 999
 * against a monthly rent of 10 000 is accepted, and a four-month `fixed_standard` lease with no
 * reason given is accepted. The API is a document generator, not a compliance check — so
 * neither is enforced here either, because refusing them would be this server inventing law.
 * They are stated in the tool text instead.
 */

/** The five templates, and the path segment each one is edited through. */
const TEMPLATE_PATHS: Readonly<Record<string, string>> = {
  accounting_services: "accounting-services",
  employee_contract: "employee-contract",
  rent_agreement: "rent-agreement",
  service_agreement: "service-agreement",
  purchase_agreement: "purchase-agreement",
};

/** Where each template's fields live inside the AgreementRes wrapper. */
const TEMPLATE_SUBOBJECTS: Readonly<Record<string, string>> = {
  accounting_services: "accountingServices",
  employee_contract: "employeeContract",
  rent_agreement: "rentAgreement",
  service_agreement: "serviceAgreement",
  purchase_agreement: "purchaseAgreement",
};

type AgreementRes = {
  agreementId?: number;
  templateType?: string;
  signStatus?: string;
  signerEmail?: string | null;
  documentId?: number | null;
} & Record<string, unknown>;

/** The populated template sub-object, with the key it was found under. */
function unwrapTemplate(res: AgreementRes | undefined): { key?: string; fields?: Record<string, unknown> } {
  if (!res) return {};
  const expected = res.templateType ? TEMPLATE_SUBOBJECTS[res.templateType] : undefined;
  const candidates = expected ? [expected] : Object.values(TEMPLATE_SUBOBJECTS);
  for (const key of candidates) {
    const value = res[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { key, fields: value as Record<string, unknown> };
    }
  }
  return {};
}

const populatedCount = (fields: Record<string, unknown>): number =>
  Object.values(fields).filter((v) => v !== null && v !== undefined && v !== false && v !== "").length;

const listAgreements = defineTool({
  name: "reai_list_agreements",
  title: "List agreements",
  description:
    "Contracts held in ReAI: leases, employment contracts, purchase and service agreements, " +
    "with the signing status of each.\n\n" +
    "The list carries only a summary — agreementId, templateType, clientName, signStatus and " +
    "timestamps. The terms themselves are on the individual agreement, under a sub-object named " +
    "for its template. Note the identifier is `agreementId`, not `id`.",
  risk: "read",
  apiPaths: [["GET", "/api/agreements"]],
  inputSchema: { tenantId: tenantIdArg },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<Array<{ signStatus?: string; templateType?: string }>>({
      method: "GET",
      path: "/api/agreements",
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const rows = res.data;
    if (!Array.isArray(rows)) {
      return okList(rows, { noun: "agreement", suffix: ".", empty: "No agreements." });
    }
    const drafts = rows.filter((r) => r.signStatus === "draft").length;
    const byType = [...new Set(rows.map((r) => r.templateType ?? "unknown"))].join(", ");
    return okList(rows, {
      noun: "agreement",
      suffix: rows.length
        ? `. ${drafts} still in draft (unsigned). Templates present: ${byType}.`
        : ".",
      empty:
        "No agreements. Note this covers ReAI's contract documents only — an agreement the " +
        "company has on paper or in another system does not appear here.",
    });
  },
});

const getAgreement = defineTool({
  name: "reai_get_agreement",
  title: "Get one agreement",
  description:
    "One agreement with its terms. The response nests them: it is a wrapper carrying five " +
    "nullable sub-objects — accountingServices, employeeContract, rentAgreement, " +
    "serviceAgreement, purchaseAgreement — of which exactly one is populated, so a lease's rent " +
    "is at `rentAgreement.monthlyRent` and not at the top level. This tool says which sub-object " +
    "holds the terms and how many of its fields are actually filled in.\n\n" +
    "For the contract document use reai_request GET /api/agreements/{id}/pdf with binary=true.",
  risk: "read",
  apiPaths: [["GET", "/api/agreements/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Agreement id — the `agreementId` field, not `id`."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<AgreementRes>({
      method: "GET",
      path: `/api/agreements/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const { key, fields } = unwrapTemplate(res.data);
    const notes: string[] = [];
    if (key && fields) {
      const filled = populatedCount(fields);
      notes.push(
        `Template ${res.data?.templateType ?? "?"}; the terms are under \`${key}\`, where ` +
          `${filled} of ${Object.keys(fields).length} fields are set.`,
      );
      // Measured: an empty body creates a valid-looking agreement, and the PDF renders for it.
      if (filled <= 3) {
        notes.push(
          `Only ${filled} field(s) carry a value, so this is effectively an empty draft. The API ` +
            `requires none of them and will still render a PDF for it.`,
        );
      }
    } else if (res.data) {
      notes.push(
        `None of the five template sub-objects is populated, so this agreement has no terms ` +
          `recorded at all — or the response shape has changed. Read the body below.`,
      );
    }
    if (res.data?.signStatus && res.data.signStatus !== "draft") {
      notes.push(
        `Signing status is "${res.data.signStatus}". Editing an agreement that has been sent for ` +
          `signature may not change the document anyone has already received.`,
      );
    }
    return ok(res.data, { note: notes.join("\n\n") || undefined });
  },
});

const updateAgreement = defineTool({
  name: "reai_update_agreement",
  title: "Change terms on an agreement",
  description:
    "Change one or more terms on an existing agreement, leaving the rest alone.\n\n" +
    "This exists because the underlying API call does the opposite. PUT on an agreement is a " +
    "FULL REPLACEMENT: sending only the field you meant to change sets every other term to " +
    "null. Measured on a live lease, a PUT carrying just the landlord's name left monthlyRent, " +
    "tenantName, depositAmount, depositAccountNumber and the house rules all empty — and the " +
    "PDF still rendered, producing a document that looks like a contract with nothing in it.\n\n" +
    "So this tool reads the agreement, merges your changes over the existing terms, and writes " +
    "the whole thing back. The round-trip was verified lossless against the live API: the " +
    "sub-object a GET returns can be written back verbatim with no field changing value.\n\n" +
    "Field names are the template's own — read them with reai_get_agreement, or from " +
    "reai_describe_endpoint on the matching POST /api/agreements/{template}. Some values the " +
    "schema types as plain strings are validated as enums that the spec does not list; the API " +
    "names the allowed set in its 400, e.g. leaseDurationType is " +
    "indefinite | fixed_standard | fixed_special_reason and depositType is deposit | guarantee.\n\n" +
    "Setting `rentAccountNumber` or `depositAccountNumber` on a lease changes where a tenant's " +
    "money goes, which is a payment destination like any other.\n\n" +
    "Needs REAI_WRITE_MODE=full, and the reason is worth stating: not because THIS tool is " +
    "dangerous — it is the safe way to do it — but because the underlying PUT replaces the " +
    "record, and the write ladder classifies the operation rather than the care taken over it. " +
    "Leaving the curated tool a tier below would have made it the soft route around a gate the " +
    "raw call is subject to.",
  risk: "irreversible",
  apiPaths: [
    ["GET", "/api/agreements/{id}"],
    ["PUT", "/api/agreements/rent-agreement/{id}"],
    ["PUT", "/api/agreements/employee-contract/{id}"],
    ["PUT", "/api/agreements/accounting-services/{id}"],
    ["PUT", "/api/agreements/service-agreement/{id}"],
    ["PUT", "/api/agreements/purchase-agreement/{id}"],
  ],
  inputSchema: {
    id: z.number().int().positive().describe("Agreement id — the `agreementId` field."),
    changes: z
      .record(z.unknown())
      .describe(
        "Only the terms to change, as the template's own field names. Everything else is kept " +
          "as it is. A null value clears that field deliberately.",
      ),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);
    const changeKeys = Object.keys(args.changes ?? {});
    if (changeKeys.length === 0) {
      return fail(
        "No changes were given, so nothing was written. Passing an empty object here would " +
          "rewrite the agreement with its current terms, which is a pointless write to a " +
          "contract record.",
      );
    }

    const current = await ctx.client.request<AgreementRes>({
      method: "GET",
      path: `/api/agreements/${args.id}`,
      tenantId,
    });
    const templateType = current.data?.templateType;
    // Narrowed together so the sub-object lookup below is typed too: a templateType this tool
    // does not know is exactly the case where guessing a path would edit the wrong template.
    const segment = templateType === undefined ? undefined : TEMPLATE_PATHS[templateType];
    if (templateType === undefined || segment === undefined) {
      return fail(
        `Agreement ${args.id} reports templateType ${JSON.stringify(templateType)}, which this ` +
          `tool does not know how to edit. Nothing was written. The five it knows are ` +
          `${Object.keys(TEMPLATE_PATHS).join(", ")}; a new template would need adding here. ` +
          `Editing through the wrong template path is refused by the API anyway ` +
          `("Avtalen må redigeres fra riktig avtalemal").`,
      );
    }

    const { key, fields } = unwrapTemplate(current.data);
    if (!fields) {
      // Writing the merge without a base would be the destructive replacement this tool exists
      // to prevent — with the caller believing they had made a small edit.
      return fail(
        `Could not read the existing terms of agreement ${args.id}: the ` +
          `${TEMPLATE_SUBOBJECTS[templateType] ?? "template"} sub-object was absent from the ` +
          `response. Nothing was written, because a PUT here REPLACES the agreement — without ` +
          `the current terms to merge into, this would have erased everything except the ` +
          `field(s) you passed.`,
      );
    }

    const unknown = changeKeys.filter((k) => !(k in fields));
    const merged = { ...fields, ...args.changes };
    const res = await ctx.client.request<AgreementRes>({
      method: "PUT",
      path: `/api/agreements/${segment}/${args.id}`,
      body: merged,
      tenantId,
    });

    const after = unwrapTemplate(res.data).fields ?? {};
    const notes = [
      `Changed ${changeKeys.join(", ")} on agreement ${args.id} (${templateType}); the other ` +
        `${Object.keys(fields).length - changeKeys.length} field(s) under \`${key}\` were read ` +
        `first and written back unchanged, because this API replaces rather than patches.`,
    ];
    // Report what the API actually stored, not what was asked for.
    const notApplied = changeKeys.filter(
      (k) => JSON.stringify(after[k]) !== JSON.stringify((args.changes as Record<string, unknown>)[k]),
    );
    if (Object.keys(after).length > 0 && notApplied.length > 0) {
      notes.push(
        `WARNING: ${notApplied.join(", ")} did not come back with the value sent — ` +
          notApplied
            .map(
              (k) =>
                `${k}: sent ${JSON.stringify((args.changes as Record<string, unknown>)[k])}, ` +
                `stored ${JSON.stringify(after[k])}`,
            )
            .join("; ") +
          `. Check the value is one the API accepts for that field.`,
      );
    }
    if (unknown.length > 0) {
      notes.push(
        `Note: ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not among the ` +
          `fields this agreement already carries. That is fine for a term being set for the ` +
          `first time, but a misspelt name looks exactly the same — confirm it took effect above.`,
      );
    }
    return ok(res.data, { note: notes.join("\n\n") });
  },
});

const listAgreementSigners = defineTool({
  name: "reai_list_agreement_signers",
  title: "List signing requests on an agreement",
  description:
    "Who has been asked to sign an agreement and what has happened since — requestedAt, " +
    "emailSentAt, signedAt and status per signer.\n\n" +
    "Returns an OBJECT, not a list: { agreementId, documentId, signStatus, signRequests }. The " +
    "signers are under `signRequests`.\n\n" +
    "Reading this sends nothing. Asking someone to sign DOES send — POST on the same path, and " +
    "POST /api/agreements/{id}/sign-request — so those need REAI_ALLOW_EXTERNAL_SEND and are " +
    "left to reai_request, where the refusal names what would have gone out.",
  risk: "read",
  apiPaths: [["GET", "/api/agreements/{id}/sign-requests"]],
  inputSchema: {
    id: z.number().int().positive().describe("Agreement id — the `agreementId` field."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<{
      signStatus?: string;
      documentId?: number | null;
      signRequests?: unknown[];
    }>({
      method: "GET",
      path: `/api/agreements/${args.id}/sign-requests`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    const signers = res.data?.signRequests;
    const note = !Array.isArray(signers)
      ? `The response carried no \`signRequests\` array — read the body below rather than ` +
        `concluding nobody has been asked to sign.`
      : signers.length === 0
        ? `Nobody has been asked to sign yet; status is "${res.data?.signStatus ?? "?"}". An ` +
          `unsigned agreement is a draft document, not a contract in force.`
        : `${signers.length} signing request(s); status "${res.data?.signStatus ?? "?"}".`;
    return ok(res.data, { note });
  },
});

const deleteAgreement = defineTool({
  name: "reai_delete_agreement",
  title: "Delete an agreement",
  description:
    "Remove an agreement and its generated document.\n\n" +
    "Answers 204 with an empty body — there is no {\"outcome\": ...} here and no archive " +
    "branch, unlike customers, suppliers or warehouses. Measured on a live tenant: the record " +
    "is gone from the list afterwards.\n\n" +
    "What this does to an agreement already SIGNED was not established — no signature could be " +
    "produced without sending a request to a real person, which this server will not do with " +
    "external sending off. Treat deleting a signed contract as unverified, and prefer keeping " +
    "the record.",
  risk: "reversible",
  destructive: true,
  apiPaths: [["DELETE", "/api/agreements/{id}"]],
  inputSchema: {
    id: z.number().int().positive().describe("Agreement id — the `agreementId` field."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const res = await ctx.client.request<unknown>({
      method: "DELETE",
      path: `/api/agreements/${args.id}`,
      tenantId: requireTenantId(args.tenantId, ctx),
    });
    return ok(res.data ?? { deleted: args.id }, {
      note:
        `Agreement ${args.id} deleted (HTTP ${res.status}). This endpoint returns no body, so ` +
        `there is nothing in the response to confirm beyond the status — reai_list_agreements ` +
        `is how to check.`,
    });
  },
});

export const agreementTools: ToolDef[] = [
  listAgreements,
  getAgreement,
  updateAgreement,
  listAgreementSigners,
  deleteAgreement,
];
