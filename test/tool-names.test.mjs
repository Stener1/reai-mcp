// Every `reai_*` name this repository writes down must be a tool that exists.
//
// Why this file exists: `src/tools/ui.ts` told agents, twice, to use
// `reai_list_bank_transactions`. There is no such tool and there never was. It read as a
// perfectly ordinary instruction, it survived review, and the only way to notice was to
// check a name against the registry by hand — which nothing did.
//
// A wrong name is worse than a missing sentence. An agent reading "use X instead" will
// try X, get "unknown tool", and have no way to tell whether the tool is gone, gated off
// by the operator's toolset selection, or was never real. So the assertion is total: not
// "the important surfaces", but every `reai_`-prefixed token anywhere in `src/` and in
// the documentation. Descriptions, titles, quirk notes, the instructions the model reads
// at connect time, error and remediation strings — all of it is one regex over the source
// rather than a list of surfaces someone has to remember to extend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { registeredTools } from "../dist/server.js";

const KNOWN = new Set(registeredTools.map((t) => t.name));

// `registeredTools` is the whole registry, not what one configuration exposes: a
// description may legitimately name a tool the current toolset selection hides, and
// telling a reader about `reai_reconcile_ui` is not a broken reference just because the
// UI is off by default.
const TOOL_NAME = /\breai_[a-z0-9_]+/g;

/**
 * Non-tool identifiers that happen to share the prefix. Empty today, and it is worth
 * keeping it that way: anything added here is a name a reader can mistake for a tool.
 */
const NOT_A_TOOL = new Set([]);

// Two surfaces are deliberately NOT scanned, and both would produce false failures if someone
// "improved" this by widening it — so the reasons are here rather than in a commit message.
//
//   - `scripts/`. smoke-full-write.mjs asserts that `reai_complete_salary_run` and
//     `reai_pay_salary_run` do NOT exist: completing a payroll run posts the voucher, creates the
//     payslips and the employee payments AND starts the a-melding submission to Skatteetaten, so the
//     check is that no tool offers it. Naming an unregistered tool is the whole point there.
//   - `CHANGELOG.md`. It records that `reai_list_bank_transactions` was named by a description and
//     never existed. A history that cannot mention a removed name is not a history.
//
// One thing this genuinely does not catch: a name assembled at runtime, `"reai_" + "list_x"` or a
// template with an interpolated suffix. The regex needs the literal. That is a limit worth stating
// plainly rather than describing this as total — no tool description in this repository builds its
// cross-references that way, and if one ever does, this test will not save it.

function unknownNames(text) {
  const found = new Set([...String(text).matchAll(TOOL_NAME)].map((m) => m[0]));
  return [...found].filter((n) => !KNOWN.has(n) && !NOT_A_TOOL.has(n)).sort();
}

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = `${dir}/${entry}`;
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

test("no source file names a tool that does not exist", () => {
  const files = sourceFiles("src");
  assert.ok(files.length > 20, `only ${files.length} source files found, so this scanned almost nothing`);

  const offenders = files
    .map((file) => ({ file, unknown: unknownNames(readFileSync(file, "utf8")) }))
    .filter((r) => r.unknown.length > 0);

  assert.deepEqual(
    offenders,
    [],
    "these files name tools that are not registered:\n" +
      offenders.map((o) => `  ${o.file}: ${o.unknown.join(", ")}`).join("\n"),
  );
});

test("no documentation page names a tool that does not exist", () => {
  const files = ["README.md", ...readdirSync("docs").map((f) => `docs/${f}`)].filter((f) => f.endsWith(".md"));
  assert.ok(files.length > 1, "expected README plus docs/ pages");

  const offenders = files
    .map((file) => ({ file, unknown: unknownNames(readFileSync(file, "utf8")) }))
    .filter((r) => r.unknown.length > 0);

  assert.deepEqual(
    offenders,
    [],
    "these pages name tools that are not registered:\n" +
      offenders.map((o) => `  ${o.file}: ${o.unknown.join(", ")}`).join("\n"),
  );
});

test("the scan can actually see a bad name", () => {
  // The two tests above pass when the corpus is empty, when the regex stops matching, or
  // when a refactor renames `registeredTools`. This one fails in all three cases, so a
  // green run above means the check ran rather than merely not-failing.
  assert.deepEqual(unknownNames("use reai_list_bank_transactions instead"), ["reai_list_bank_transactions"]);
  assert.deepEqual(unknownNames("use reai_get_bank_reconciliation instead"), []);
  assert.ok(KNOWN.size > 100, `registry looks empty: ${KNOWN.size} tools`);
});
