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
// FIRST executable statement, before anything can name the unguarded fetch. This script only ever issues one
// GET, for the spec document, and the guard enforces that at runtime rather than by argument. The AST invariant
// in test/write-guard.test.mjs demanded it because `method.toUpperCase()` appears here — that is spec ITERATION,
// not a request, but the checker cannot prove it, and a checker that trusts my reading of my own code is worth
// less than one that does not.
import { installProtectedTenantFetchGuard } from "./lib/write-guard.mjs";

installProtectedTenantFetchGuard();

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
  // An audit or smoke script naming the concrete path. A string match is right here: these scripts write the
  // path literally, and the point is to catch a probe that will start 404ing.
  for (const [file, text] of Object.entries(scriptText)) {
    if (text.includes(`"${path}"`) || text.includes(`\`${path}`)) reasons.push(`probe in ${file}`);
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
    if (dependencies.length > 0) requiredChanged.push({ key, gained, lost, dependencies });
  }

  const breaking = [...removed.filter((r) => r.dependencies.length > 0), ...requiredChanged];

  if (asJson) {
    console.log(JSON.stringify({ removed, added, requiredChanged, breaking: breaking.length }, null, 2));
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
