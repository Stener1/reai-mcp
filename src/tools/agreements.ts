import { z } from "zod";
import { findOperation } from "../reai/spec.js";
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
 * field changing value. Measured on `rent_agreement`; for the other four the SPEC supports it —
 * each `…Res` and `…Req` pair carries an identical property set, so there is no read-only field
 * to send back — but only the lease was exercised live.
 *
 * The window this leaves is a lost update: between the read and the write, an edit made in the
 * ReAI UI is silently reverted. There is no ETag, If-Match or version field to prevent it, so
 * the tool states it rather than pretending the merge is atomic.
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
 * `rentAgreement`, `serviceAgreement`, `purchaseAgreement`); the one named by `templateType`
 * carries the terms, so a lease's rent is at `rentAgreement.monthlyRent` rather than at the top
 * level. Only one was ever seen populated, on one template on one tenant, which is why the code
 * prefers `templateType` over scanning and says so when more than one is non-null instead of
 * taking the first.
 *
 * DELETE answers 204 with an empty body, so there is no `{"outcome": ...}` to read. That is
 * evidence for "no outcome field" and NOT for "no archive branch": the record leaving the list
 * is exactly what an archived warehouse also does, and `GET /api/agreements` takes no
 * `archived` parameter, so an archive here would be invisible either way. Unestablished.
 *
 * ## The enums ARE documented — an earlier version of this comment said otherwise
 *
 * A 400 naming allowed values ("leaseDurationType has invalid value 'OPEN_ENDED'. Allowed
 * values: indefinite, fixed_standard, fixed_special_reason") was read here as the spec being
 * silent about them. It is not: `leaseDurationType` and `depositType` are declared enums in the
 * document with exactly those members, and there are 14 such fields across the five templates.
 * The rejected values were simply wrong guesses.
 *
 * What is worth knowing is narrower: the members are lowercase snake_case, which is not what an
 * agent guesses from a Norwegian contract form. So `reai_update_agreement` checks values against
 * the documented enum before writing and names the allowed set locally, rather than letting the
 * API answer with one.
 *
 * ## What the API does NOT check
 *
 * Norwegian tenancy law caps a deposit at six months' rent (husleieloven § 3-5), and § 9-3 sets
 * a three-year minimum for a fixed-term residential lease — its effect on a shorter one is that
 * the term counts as INDEFINITE unless a statutory ground applies, which is a different thing
 * from being rejected. Both are residential rules, while the template also covers
 * `storage_or_other`.
 *
 * Measured: a deposit of 9 999 999 against a monthly rent of 10 000 is accepted, and a
 * four-month `fixed_standard` lease with no reason given is accepted. The API is a document
 * generator, not a compliance check — and neither is enforced here either, because refusing them
 * would be this server inventing law on a template that is not always residential. Stated in the
 * tool text instead.
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

/**
 * The template sub-object carrying the terms, with the key it was found under.
 *
 * `templateType` decides it. Scanning was the first version, and it picks whichever sub-object
 * happens to come first in declaration order — which, on a body where two are non-null, reported
 * a lease's 78 fields as living under `accountingServices`, and on a PUT response produced
 * "sent 13500, stored undefined" for a value that had been stored correctly. AgreementRes has no
 * `required` list, so an absent templateType is permitted by the document; `ambiguous` is
 * returned rather than a guess when more than one is populated.
 */
function unwrapTemplate(res: AgreementRes | undefined): {
  key?: string;
  fields?: Record<string, unknown>;
  ambiguous?: string[];
} {
  if (!res) return {};
  const isFields = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);

  const expected =
    res.templateType !== undefined && Object.hasOwn(TEMPLATE_SUBOBJECTS, res.templateType)
      ? TEMPLATE_SUBOBJECTS[res.templateType]
      : undefined;
  if (expected !== undefined) {
    const value = res[expected];
    return isFields(value) ? { key: expected, fields: value } : {};
  }

  const populated = Object.values(TEMPLATE_SUBOBJECTS).filter((key) => isFields(res[key]));
  if (populated.length === 1) {
    const key = populated[0] as string;
    return { key, fields: res[key] as Record<string, unknown> };
  }
  return populated.length > 1 ? { ambiguous: populated } : {};
}

/**
 * How many fields carry something.
 *
 * `false` counts as unset deliberately: the API returns booleans as false rather than null for a
 * template's unanswered yes/no questions — the wiped lease came back with petsAllowed: false —
 * so counting them would make an empty draft look populated. The cost is that a lease genuinely
 * saying "no pets, no smoking, no cable TV" undercounts, which is why the low-field warning is
 * worded as a prompt to look rather than as a verdict.
 */
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
    const { key, fields, ambiguous } = unwrapTemplate(res.data);
    const notes: string[] = [];
    if (ambiguous) {
      // Picking the first would present one template's fields as the agreement's terms. Only
      // one sub-object was ever seen populated, so this is a shape surprise worth naming rather
      // than papering over.
      notes.push(
        `This agreement has more than one template sub-object populated ` +
          `(${ambiguous.join(", ")}) and carries no templateType to choose between them, so ` +
          `which one holds the terms cannot be determined from the response. Read the body below.`,
      );
    } else if (key && fields) {
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
    "reai_describe_endpoint on the matching POST /api/agreements/{template}, which also DECLARES " +
    "the enums — 14 fields across four of the five templates carry one, purchase-agreement none, " +
    "and the document names every " +
    "member, so they can be read rather than guessed. The members are lowercase snake_case, " +
    "which is not what a Norwegian contract form suggests: leaseDurationType is indefinite | " +
    "fixed_standard | fixed_special_reason, depositType is deposit | guarantee. This tool checks " +
    "values against those declarations before writing anything.\n\n" +
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
    // Object.hasOwn, because a plain-object lookup on "constructor" returns the Object function
    // and would pass an `undefined` check.
    const segment =
      templateType !== undefined && Object.hasOwn(TEMPLATE_PATHS, templateType)
        ? TEMPLATE_PATHS[templateType]
        : undefined;
    if (templateType === undefined || segment === undefined) {
      return fail(
        `Agreement ${args.id} reports templateType ${JSON.stringify(templateType)}, which this ` +
          `tool does not know how to edit. Nothing was written. The five it knows are ` +
          `${Object.keys(TEMPLATE_PATHS).join(", ")}; a new template would need adding here. ` +
          `Editing through the wrong template path is refused by the API anyway ` +
          `("Avtalen må redigeres fra riktig avtalemal").`,
      );
    }

    const { key, fields, ambiguous } = unwrapTemplate(current.data);
    if (ambiguous) {
      return fail(
        `Agreement ${args.id} has more than one template sub-object populated ` +
          `(${ambiguous.join(", ")}) and no templateType to choose between them, so which terms ` +
          `to merge into is ambiguous. Nothing was written — guessing here would write one ` +
          `template's fields over another's.`,
      );
    }
    // `{}` is truthy, so `!fields` let an empty sub-object through as a valid base. The merge
    // then wrote only the caller's changes, which is the destructive replacement this tool
    // exists to prevent — and the note reported "the other -1 field(s) written back unchanged".
    if (!fields || Object.keys(fields).length === 0) {
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

    // Own properties only: `k in fields` walks the prototype chain, so a change named
    // `toString` or `constructor` looked like an existing field and skipped the warning below.
    const unknown = changeKeys.filter((k) => !Object.hasOwn(fields, k));

    // The documented enums, checked locally. The members are lowercase snake_case, which is not
    // what an agent guesses from a Norwegian contract form — and the alternative is a 400 that
    // arrives after the read, having written nothing but wasted the round-trip. Read from the
    // spec index rather than restated here: 14 fields across the five templates carry an enum,
    // and a copy would rot the moment one changes.
    const operation = findOperation("PUT", `/api/agreements/${segment}/{id}`);
    const rejected: string[] = [];
    for (const [name, value] of Object.entries(args.changes as Record<string, unknown>)) {
      const declared = operation?.body?.fields?.[name];
      const members = typeof declared === "string" ? /^enum\(([^)]*)\)/.exec(declared)?.[1] : undefined;
      if (members === undefined || value === null || value === undefined) continue;
      const allowed = members.split("|");
      if (!allowed.includes(String(value))) {
        rejected.push(`${name}: ${JSON.stringify(value)} is not one of ${allowed.join(" | ")}`);
      }
    }
    if (rejected.length > 0) {
      return fail(
        `Nothing was written — ${rejected.length === 1 ? "a value is" : "values are"} not among ` +
          `the ones this field accepts:\n  ${rejected.join("\n  ")}\n\n` +
          `The members are lowercase snake_case. The API would reject these too, so this is the ` +
          `same answer sooner.`,
      );
    }

    const merged = { ...fields, ...args.changes };
    const res = await ctx.client.request<AgreementRes>({
      method: "PUT",
      path: `/api/agreements/${segment}/${args.id}`,
      body: merged,
      tenantId,
    });

    // Read the response through the key the REQUEST used, not by unwrapping again: re-scanning a
    // response whose templateType is absent can land on a different sub-object and then report
    // every change as "stored undefined", which reads as "the edit did not take".
    const after =
      key !== undefined && res.data?.[key] && typeof res.data[key] === "object"
        ? (res.data[key] as Record<string, unknown>)
        : {};
    // Count the fields actually carried over, rather than subtracting the change count: a change
    // that sets a term for the FIRST time is not one of the existing fields, so subtracting
    // undercounted — and on an empty base it printed a negative number.
    const untouched = Object.keys(fields).filter((k) => !changeKeys.includes(k)).length;
    const notes = [
      `Changed ${changeKeys.join(", ")} on agreement ${args.id} (${templateType}); the other ` +
        `${untouched} field(s) under \`${key}\` were read first and written back unchanged, ` +
        `because this API replaces rather than patches.`,
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
    "Answers 204 with an empty body, so unlike customers, suppliers or warehouses there is no " +
    "{\"outcome\": ...} to read. Measured on a live tenant, the record is gone from the list " +
    "afterwards — which is evidence that it left the ACTIVE list and NOT that no archive exists: " +
    "an archived warehouse does exactly the same, and GET /api/agreements takes no `archived` " +
    "parameter, so an archive here would be invisible either way. Unestablished.\n\n" +
    "What this does to an agreement already SIGNED was not established — no signature could be " +
    "produced without sending a request to a real person, which this server will not do with " +
    "external sending off. So this tool reads the signing status first and REFUSES anything that " +
    "is not a draft, rather than deleting a signed contract on unverified behaviour. Use " +
    "reai_request if you have decided to do it anyway.",
  risk: "reversible",
  destructive: true,
  apiPaths: [
    ["GET", "/api/agreements/{id}"],
    ["DELETE", "/api/agreements/{id}"],
  ],
  inputSchema: {
    id: z.number().int().positive().describe("Agreement id — the `agreementId` field."),
    tenantId: tenantIdArg,
  },
  handler: async (args, ctx) => {
    const tenantId = requireTenantId(args.tenantId, ctx);

    // The description said "prefer keeping the record" and then deleted unconditionally, in the
    // DEFAULT write mode, with a 204 and no body to confirm anything afterwards. Reading first
    // costs one GET and is the same pattern reai_update_agreement already uses.
    const current = await ctx.client.request<AgreementRes>({
      method: "GET",
      path: `/api/agreements/${args.id}`,
      tenantId,
    });
    const signStatus = current.data?.signStatus;
    if (signStatus !== undefined && signStatus !== "draft") {
      return fail(
        `Agreement ${args.id} has signing status "${signStatus}", so it is not a draft. Nothing ` +
          `was deleted.\n\n` +
          `What deleting a signed agreement does was never established — producing a signature ` +
          `requires sending a request to a real person, which this server will not do with ` +
          `external sending off — and the endpoint answers 204 with no body, so there would be ` +
          `nothing to check afterwards. If you have decided to do it regardless, reai_request ` +
          `DELETE /api/agreements/${args.id} will.`,
      );
    }

    const res = await ctx.client.request<unknown>({
      method: "DELETE",
      path: `/api/agreements/${args.id}`,
      tenantId,
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
