import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { allTools, alwaysOnTools, registeredTools, selectTools, TOOL_GROUPS, SERVER_VERSION } from "../dist/server.js";
import { QUIRKS } from "../dist/reai/quirks.js";
import { getSpecIndex } from "../dist/reai/spec.js";
import { TOOLSETS } from "../dist/config.js";

/**
 * Documentation drift has been a recurring defect here, not a hypothetical one:
 * two tool tables shipped missing entirely, a risk column kept saying
 * "reversible" after the classification changed, and the toolset counts silently
 * went stale when a discovery tool was added. Every number below is asserted
 * against the code rather than trusted.
 */

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const README = readFileSync(join(repo, "README.md"), "utf8");
const ENV_EXAMPLE = readFileSync(join(repo, ".env.example"), "utf8");
const CHANGELOG = readFileSync(join(repo, "CHANGELOG.md"), "utf8");
const PKG = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));

test("the README's tool count matches reality", () => {
  const claimed = [...README.matchAll(/\b(\d+)\s+tools\b/g)].map((m) => Number(m[1]));
  assert.ok(claimed.length > 0, "the README should state a tool count somewhere");
  // Group subtotals are also stated, so only check that the total appears and
  // that no stated count exceeds it.
  assert.ok(claimed.includes(allTools.length), `README should mention ${allTools.length} tools`);
  for (const n of claimed) {
    assert.ok(n <= allTools.length, `README claims ${n} tools, but only ${allTools.length} exist`);
  }
});

test("every toolset count stated in the README is correct", () => {
  // Matches the `REAI_TOOLSETS=a,b   # N tools` lines.
  const rows = [...README.matchAll(/REAI_TOOLSETS=([a-z,]+)\s*#\s*(\d+)\s+tools/g)];
  assert.ok(rows.length >= 2, "the README should show at least two toolset examples");
  for (const [, groups, count] of rows) {
    const selected = selectTools(groups.split(","));
    assert.equal(
      selected.length,
      Number(count),
      `README says REAI_TOOLSETS=${groups} gives ${count} tools; it gives ${selected.length}`,
    );
  }
});

test("toolset counts stated in .env.example are correct", () => {
  const rows = [...ENV_EXAMPLE.matchAll(/^#\s{3}([a-z,]+)\s*->\s*(\d+)\s+tools/gm)];
  for (const [, groups, count] of rows) {
    assert.equal(
      selectTools(groups.split(",")).length,
      Number(count),
      `.env.example says ${groups} -> ${count} tools`,
    );
  }
});

test("the README's API-surface numbers match the spec index", () => {
  const index = getSpecIndex();
  assert.ok(
    README.includes(`${index.counts.public} documented operations`) ||
      README.includes(`${index.counts.public} public operations`),
    `README should state ${index.counts.public} public operations`,
  );
  const domains = /(\d+) API domains/.exec(README);
  if (domains) {
    assert.equal(
      Number(domains[1]),
      Object.keys(index.tags).length,
      `README claims ${domains[1]} API domains; the index has ${Object.keys(index.tags).length}`,
    );
  }
});

test("the README's quirk count matches the registry", () => {
  const m = /(\d+) quirks/.exec(README);
  assert.ok(m, "the README should state how many quirks exist");
  assert.equal(Number(m[1]), QUIRKS.length, `README claims ${m[1]} quirks; there are ${QUIRKS.length}`);
});

test("every curated tool appears in a README table", () => {
  // This is what would have caught 32 tools shipping undocumented.
  const missing = registeredTools.filter((t) => !README.includes(`\`${t.name}\``)).map((t) => t.name);
  assert.deepEqual(missing, [], `tools absent from the README: ${missing.join(", ")}`);
});

test("no README table calls an irreversible tool reversible", () => {
  // A risk column kept saying "reversible" after reconciliation rules were
  // escalated, so anyone following the documented default found them missing.
  for (const tool of registeredTools) {
    if (tool.risk !== "irreversible") continue;
    for (const line of README.split("\n")) {
      if (!line.includes(`\`${tool.name}\``)) continue;
      if (!line.trimStart().startsWith("|")) continue;
      assert.ok(
        !/\|\s*reversible\s*\|/.test(line) && !/\|\s*read\s*\|/.test(line),
        `${tool.name} is irreversible but its README row says otherwise:\n  ${line.trim()}`,
      );
    }
  }
});

test("every documented toolset group exists", () => {
  for (const group of TOOLSETS) {
    assert.ok(group in TOOL_GROUPS, `${group} is documented but has no tool group`);
  }
  assert.equal(alwaysOnTools.length + Object.values(TOOL_GROUPS).flat().length, allTools.length);
});

test("every environment variable the code reads is documented", () => {
  const configSrc = readFileSync(join(repo, "src", "config.ts"), "utf8");
  const used = new Set([...configSrc.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]));
  // PORT is a platform convention rather than one of ours, but document it anyway.
  const undocumented = [...used].filter(
    (v) => !README.includes(v) && !ENV_EXAMPLE.includes(v),
  );
  assert.deepEqual(undocumented, [], `env vars read but undocumented: ${undocumented.join(", ")}`);
});

test("the version is consistent across package.json, the server and the changelog", () => {
  assert.equal(
    SERVER_VERSION,
    PKG.version,
    `SERVER_VERSION (${SERVER_VERSION}) must match package.json (${PKG.version}) — clients see this in the MCP handshake`,
  );
  assert.ok(
    CHANGELOG.includes(`## ${PKG.version}`),
    `CHANGELOG.md has no entry for ${PKG.version}`,
  );
});

test("the changelog does not claim an npm release that has not happened", () => {
  // Stener wants to see it working before anything is published, so the changelog
  // must not imply otherwise.
  assert.ok(
    /(nothing|not|never)\b[^.]{0,40}published|unreleased/i.test(CHANGELOG),
    "the changelog should state plainly that nothing is published to npm yet",
  );
});

test("the lockfile version tracks package.json", () => {
  // `npm pkg set version` does not touch the lockfile, so a bump silently left
  // it behind — making release metadata inconsistent and producing a surprise
  // diff on the next ordinary `npm install`.
  const lock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8"));
  assert.equal(lock.version, PKG.version, "package-lock.json root version");
  assert.equal(lock.packages[""].version, PKG.version, 'package-lock.json packages[""] version');
});

// The (unset) row in .env.example claimed "all 59" while the real total was 71, and the
// existing sweep could not see it: its regex only matches rows naming a group, so the row
// stating the TOTAL — the one an operator reads first — was the one nothing checked.
test(".env.example states the real total, not just the per-group counts", () => {
  const row = /^#\s+\(unset\)\s+->\s+all (\d+)$/m.exec(ENV_EXAMPLE);
  assert.ok(row, ".env.example should keep an (unset) -> all N row");
  assert.equal(Number(row[1]), allTools.length, "the (unset) total is stale");

  // And the prose listing the valid groups has to name every group that exists. It said
  // "bookkeeping, sales, purchase, bank" for a while after a fifth group shipped.
  const groups = Object.keys(TOOL_GROUPS);
  for (const source of [ENV_EXAMPLE, README]) {
    const sentence = /Valid groups[^.]*\./.exec(source)?.[0] ?? "";
    if (!sentence) continue;
    for (const group of groups) {
      assert.ok(sentence.includes(group), `"Valid groups" omits ${group}: ${sentence}`);
    }
  }
});

test("tool counts stated in the changelog match the groups", () => {
  // The changelog said "59 curated tools across four domains, plus discovery",
  // which read as 59 domain tools with discovery on top. It is 52 + 7.
  const domainTotal = Object.values(TOOL_GROUPS).flat().length;
  // The domain COUNT is part of the sentence, and it was hardcoded to "four" — so adding a
  // fifth group made this fail against the 0.3.0 entry, which is a historical record and
  // correct as written. The current total belongs in the unreleased section; released
  // entries describe what shipped then.
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];
  const domains = Object.keys(TOOL_GROUPS).length;
  assert.ok(
    CHANGELOG.includes(`${domainTotal} across ${words[domains]} accounting domains`),
    `changelog should say ${domainTotal} tools across ${words[domains]} accounting domains`,
  );
  assert.ok(
    CHANGELOG.includes(`${alwaysOnTools.length} always-on`),
    `changelog should say ${alwaysOnTools.length} always-on tools`,
  );
  // Per-group subtotals, written as "(8)" after the group name.
  for (const [name, tools] of Object.entries(TOOL_GROUPS)) {
    const label = name === "bank" ? "Bank & VAT" : name[0].toUpperCase() + name.slice(1);
    const m = new RegExp(`\\\\*${label}\\\\*\\\\s*\\\\((\\\\d+)\\\\)`).exec(CHANGELOG);
    if (m) {
      assert.equal(Number(m[1]), tools.length, `changelog subtotal for ${name}`);
    }
  }
});
