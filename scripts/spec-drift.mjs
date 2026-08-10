#!/usr/bin/env node
/**
 * Has ReAI's API moved away from the spec this repo pins?
 *
 * WHY THIS EXISTS. On 2026-08-10 the API renamed `/api/opening-balances` to the singular and moved voucher
 * WRITES from `/api/vouchers` to `/api/manual-vouchers`. Nothing here noticed for three iterations. What finally
 * surfaced it was a smoke check going red on the renamed path — and the far more serious half, two curated
 * ledger-write tools pointing at a route that now answers `405`, was found only afterwards by diffing the spec
 * by hand. `reai_create_voucher` and `reai_delete_voucher` are both irreversible and both were broken.
 *
 * Three properties of that incident shaped this script:
 *
 *   1. THE DIFF MUST BE PER OPERATION, not per path. `/api/vouchers` still exists — its GET never moved. A
 *      path-level diff would have reported it unchanged while POST, PUT and DELETE had all left.
 *   2. A REMOVED OPERATION MATTERS ONLY IF SOMETHING DEPENDS ON IT. 12 paths appeared and 1 vanished in that
 *      refresh; reporting all thirteen equally is how a report gets skimmed. What deserves attention is the
 *      operation a curated tool calls, a quirk is keyed to, or an audit probes.
 *   3. A FIELD BECOMING REQUIRED IS AS BREAKING AS A ROUTE VANISHING, and quieter. ReAI declares no
 *      `additionalProperties: false` anywhere, so a field the endpoint stops accepting is silently discarded
 *      rather than refused — the caller sees a 200 and loses the value.
 *
 * Read-only. It fetches the spec and reads local files; it makes no tenant-scoped call and cannot write.
 *
 * Usage:
 *   REAI_USER_API_TOKEN=… node scripts/spec-drift.mjs [--json]
 *
 * Exit codes:  0 nothing that breaks anything   1 a dependency is broken   2 could not fetch or parse
 */
// GET-ONLY, enforced rather than claimed, and installed before any other statement so the native fetch is never
// reachable. The wrapper lives in scripts/lib so a test can exercise it — importing THIS file to test it is not
// possible, because its top level calls process.exit and would take the runner with it.
//
// The first version cited installProtectedTenantFetchGuard() as the enforcement. Review showed that was empty:
// that guard refuses a non-GET only when it carries a protected tenant header, and this script sends none. So it
// did nothing here while the EXEMPT entry it justified caused the AST coverage test to skip this file.
import { installGetOnlyFetch } from "./lib/get-only-fetch.mjs";

installGetOnlyFetch();

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const asJson = process.argv.includes("--json");

const SPEC_URL = "https://app.reai.no/openapi";
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

const token = process.env.REAI_USER_API_TOKEN;
if (!token) {
  console.error("REAI_USER_API_TOKEN is not set. This script reads the live spec and nothing else.");
  process.exit(2);
}

/** Every operation in an OpenAPI document, as "METHOD /path" keys mapped to their required body fields. */
function operationsOf(spec) {
  const out = new Map();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = item?.[method];
      if (!op) continue;
      out.set(`${method.toUpperCase()} ${path}`, {
        method: method.toUpperCase(),
        path,
        // Resolved one level, which is all this needs: a $ref to a schema whose `required` array is what a
        // caller must send. Deeper nesting is out of scope — the index flattens it too, and a report that
        // half-resolves would be worse than one that says what it looked at.
        required: requiredFieldsOf(spec, op),
      });
    }
  }
  return out;
}

function requiredFieldsOf(spec, op) {
  const schema = op?.requestBody?.content?.["application/json"]?.schema;
  if (!schema) return [];
  const resolved = schema.$ref ? spec.components?.schemas?.[schema.$ref.split("/").pop()] : schema;
  return [...(resolved?.required ?? [])].sort();
}

/**
 * What in this repository depends on a given operation.
 *
 * Derived from the built artefacts and the source, so a new tool or quirk is covered without editing this list —
 * the mistake this repo has made repeatedly is enumerating what to inspect and thereby exempting whatever
 * nobody listed.
 */
async function dependenciesOn(key, { tools, quirkPaths, scriptText }) {
  const [method, path] = key.split(" ");
  const reasons = [];

  for (const tool of tools) {
    if ((tool.apiPaths ?? []).some(([m, p]) => m === method && p === path)) {
      reasons.push(`curated tool ${tool.name} (${tool.risk})`);
    }
  }
  for (const quirk of quirkPaths) {
    const methodsMatch = quirk.methods === undefined || quirk.methods.includes(method);
    if (methodsMatch && quirk.paths.includes(path)) reasons.push(`quirk ${quirk.id}`);
  }
  // A probe in an audit or smoke script. Matched on METHOD AND a NORMALISED path, because the first version
  // matched the path string alone and was wrong in both directions:
  //
  //   FALSE POSITIVE — a script probing GET /api/vouchers was reported as depending on the REMOVED
  //   POST /api/vouchers. My own replay printed exactly that for audit-quirks.mjs, which is read-only by
  //   construction and cannot have been probing the POST. I presented that line as a success.
  //
  //   FALSE NEGATIVE — smoke-full-write.mjs calls "/api/invoices/1/ehf" while the operation key is
  //   "/api/invoices/{id}/ehf", so the concrete id never matched and its dependency was invisible. Removing that
  //   operation would have been classified an orphan and exited 0.
  //
  // This remains a heuristic over source text, and says so: it looks for a method and a path within a short
  // window of each other, covering the two shapes these scripts use — `method: "POST", path: "/x"` and
  // `call("POST", "/x")`. A probe that assembles its path from variables is not found, and no text scan will
  // find it; the tool and quirk dependencies above are structured data and carry no such caveat.
  const template = (candidate) => candidate.replace(/\/\d+(?=\/|$)/g, "/{id}");
  for (const [file, text] of Object.entries(scriptText)) {
    for (const found of text.matchAll(/"(GET|POST|PUT|PATCH|DELETE)"[^"]{0,40}"([^"`]+?)"|`(GET|POST|PUT|PATCH|DELETE) ([^`"]+?)`/g)) {
      const probeMethod = found[1] ?? found[3];
      const probePath = found[2] ?? found[4];
      if (probeMethod !== method || probePath === undefined) continue;
      // Compare with numeric ids folded to {id}, in both directions: the script may write the concrete id, and
      // the spec's parameter may be named something other than `id`.
      if (template(probePath) === template(path) || probePath === path) reasons.push(`probe in ${file}`);
    }
  }
  return [...new Set(reasons)];
}

async function main() {
  const pinned = JSON.parse(readFileSync(join(repo, "spec", "reai-openapi.json"), "utf8"));

  const res = await fetch(SPEC_URL, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  if (!res.ok) {
    console.error(`Could not fetch ${SPEC_URL}: HTTP ${res.status}`);
    process.exit(2);
  }
  const live = await res.json();
  if (!live?.paths) {
    console.error(`${SPEC_URL} returned no paths — refusing to report drift against an empty document.`);
    process.exit(2);
  }

  const before = operationsOf(pinned);
  const after = operationsOf(live);

  const { allTools } = await import("../dist/server.js");
  const { uiTools } = await import("../dist/tools/ui.js");
  const { findQuirks } = await import("../dist/reai/quirks.js");
  const tools = [...allTools, ...uiTools];
  const quirkPaths = findQuirks("").map((q) => ({ id: q.id, paths: q.paths, methods: q.methods }));

  const { readdirSync } = await import("node:fs");
  const scriptText = {};
  for (const file of readdirSync(join(repo, "scripts")).filter((f) => f.endsWith(".mjs") && f !== "spec-drift.mjs")) {
    scriptText[file] = readFileSync(join(repo, "scripts", file), "utf8");
  }

  const context = { tools, quirkPaths, scriptText };
  const removed = [];
  const added = [];
  const requiredChanged = [];
  const relaxed = [];

  for (const key of before.keys()) {
    if (after.has(key)) continue;
    removed.push({ key, dependencies: await dependenciesOn(key, context) });
  }
  for (const key of after.keys()) if (!before.has(key)) added.push(key);

  for (const [key, now] of after) {
    const was = before.get(key);
    if (!was) continue;
    const gained = now.required.filter((f) => !was.required.includes(f));
    const lost = was.required.filter((f) => !now.required.includes(f));
    if (gained.length === 0 && lost.length === 0) continue;
    const dependencies = await dependenciesOn(key, context);
    // A required-field change matters where something calls the operation. Elsewhere it is noise: 320 public
    // operations churn their schemas and this report has to stay readable enough to be run.
    //
    // Only a GAINED requirement breaks a caller. Losing one makes the operation LESS restrictive, so every
    // existing call stays valid — the first version counted both and would have exited 1 with a remediation
    // message on a change that requires none. My own verification used the `lost` direction and called it
    // breaking, so the test exercised the wrong half of this.
    if (dependencies.length === 0) continue;
    if (gained.length > 0) requiredChanged.push({ key, gained, lost, dependencies });
    else relaxed.push({ key, lost, dependencies });
  }

  const breaking = [...removed.filter((r) => r.dependencies.length > 0), ...requiredChanged];

  if (asJson) {
    console.log(JSON.stringify({ removed, added, requiredChanged, relaxed, breaking: breaking.length }, null, 2));
  } else {
    console.log(`\nSpec drift: pinned ${before.size} operations, live ${after.size}\n`);

    const orphaned = removed.filter((r) => r.dependencies.length === 0);
    if (removed.length === 0) console.log("  No operation has been removed.");
    for (const { key, dependencies } of removed) {
      if (dependencies.length === 0) continue;
      console.log(`  [BREAKING] ${key} is GONE, and it is depended on by:`);
      for (const reason of dependencies) console.log(`               - ${reason}`);
    }
    for (const { key, gained, lost, dependencies } of requiredChanged) {
      console.log(`  [BREAKING] ${key} changed its required fields:`);
      if (gained.length) console.log(`               now required: ${gained.join(", ")}`);
      if (lost.length) console.log(`               no longer required: ${lost.join(", ")}`);
      for (const reason of dependencies) console.log(`               - ${reason}`);
    }
    if (orphaned.length > 0) {
      console.log(`\n  ${orphaned.length} removed operation(s) nothing here depends on:`);
      for (const { key } of orphaned) console.log(`    - ${key}`);
    }
    if (relaxed.length > 0) {
      console.log(`\n  ${relaxed.length} operation(s) became LESS restrictive — informational, nothing to fix:`);
      for (const { key, lost, dependencies } of relaxed) {
        console.log(`    ~ ${key} no longer requires: ${lost.join(", ")}  (${dependencies.length} dependent)`);
      }
    }
    if (added.length > 0) {
      console.log(`\n  ${added.length} new operation(s), which may deserve curated tools:`);
      for (const key of added) console.log(`    + ${key}`);
    }
    console.log(
      breaking.length === 0
        ? "\nNothing this repository depends on has moved.\n"
        : `\n${breaking.length} dependency/dependencies broken. Refresh the spec with npm run build:spec and ` +
            "repoint what is named above — handlers AND apiPaths, which are separate strings.\n",
    );
  }
  process.exit(breaking.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("spec-drift crashed:", err);
  process.exit(2);
});
