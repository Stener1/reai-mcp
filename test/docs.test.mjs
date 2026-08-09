import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { allTools, alwaysOnTools, registeredTools, selectTools, TOOL_GROUPS, SERVER_VERSION } from "../dist/server.js";
import { uiTools } from "../dist/tools/ui.js";
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

/**
 * The README plus everything under `docs/`, as one haystack.
 *
 * These assertions exist to guarantee that something is DOCUMENTED — that all 172 tools are listed
 * somewhere a reader will find them, that an enforced transport limit is written down. They were
 * pinned to README.md, which quietly made them assertions about documentation ARCHITECTURE too: when
 * the README was split into a front door plus `docs/`, the three sections these tests name could not
 * move, and the split had to leave them behind on the front page. Corpus-wide now, which is what let
 * the tool tables move to `docs/tools.md` — the guarantee is that a reader can find the tool.
 *
 * A file list rather than a glob, so a new page has to be added deliberately and an unlinked stray
 * markdown file cannot start satisfying a guarantee by accident. Every entry is checked to exist, so
 * renaming a page fails here rather than silently shrinking the haystack.
 */
const DOC_FILES = [
  "README.md",
  "docs/README.md",
  "docs/safety.md",
  "docs/tools.md",
  "docs/api-quirks.md",
  "docs/discovery.md",
  "docs/self-hosting.md",
  "docs/development.md",
  "docs/audits.md",
];
const DOCS = DOC_FILES.map((f) => {
  const text = readFileSync(join(repo, f), "utf8");
  return { file: f, text };
});
const ALL_DOCS = DOCS.map((d) => d.text).join("\n");
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

test("every curated tool is documented, in the README or a linked page", () => {
  // This is what would have caught 32 tools shipping undocumented. It searches every documentation
  // file rather than only the README: the guarantee is that a reader can find the tool, not that it
  // appears on the front page.
  const missing = registeredTools
    .filter((t) => !ALL_DOCS.includes(`\`${t.name}\``))
    .map((t) => t.name);
  assert.deepEqual(missing, [], `tools documented nowhere: ${missing.join(", ")}`);
});

test("the documentation file list is real, so the haystack cannot shrink by a rename", () => {
  // Without this, renaming docs/tools.md to docs/tools-reference.md would make the list above stop
  // reading it — and every assertion built on the corpus would get quietly easier to satisfy.
  for (const { file, text } of DOCS) {
    assert.ok(text.length > 0, `${file} is listed as documentation but is empty`);
  }
  // And every docs/ page must be in the list, or it is documentation nothing checks.
  const onDisk = readdirSync(join(repo, "docs")).filter((f) => f.endsWith(".md")).sort();
  const listed = DOC_FILES.filter((f) => f.startsWith("docs/")).map((f) => f.slice("docs/".length)).sort();
  assert.deepEqual(onDisk, listed, "a docs/ page is not in DOC_FILES, so nothing above searches it");
});

test("every live audit has a documented invocation", () => {
  // The audit harness is only run by a maintainer following the docs. When the README split moved the
  // audits to docs/audits.md, `audit-quirks-write.mjs` was described there as one of the four audits but
  // its command never made it into the invocation block — so anyone following the documented workflow ran
  // three of four and silently skipped its six refusal probes. Presence in prose is not an invocation.
  // The population is every `scripts/audit-*.mjs` UNION every script an `audit:*` npm alias points at, so
  // renaming a harness out of the filename pattern does not quietly remove it from the guard —
  // `storage-census.mjs` is already an audit reached only through its `audit:census` alias.
  const scripts = PKG.scripts;
  const byAlias = Object.entries(scripts)
    .filter(([name]) => name.startsWith("audit:"))
    .flatMap(([, cmd]) => [...cmd.matchAll(/scripts\/([\w.-]+\.mjs)/g)].map((m) => m[1]));
  const audits = [...new Set([...readdirSync(join(repo, "scripts")).filter((f) => /^audit-.*\.mjs$/.test(f)), ...byAlias])].sort();
  // Only RUNNABLE lines count. Searching the whole corpus would accept a prose mention of the path, and
  // `docs/audits.md` names every audit in prose by design — the page that documents them is the page most
  // likely to satisfy a lax check while still showing no command. Commented lines are dropped for the same
  // reason: a `#`-prefixed line inside a fenced block is documentation of a command, not one.
  const COMMANDS = DOCS.flatMap(({ text }) => [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)])
    .flatMap((m) => m[1].split("\n"))
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  const undocumented = audits.filter((file) => {
    if (COMMANDS.includes(`scripts/${file}`)) return false;
    // Or via its npm alias, bounded on BOTH sides. `audit:quirks` is a prefix of `audit:quirks:write`, so
    // without a right boundary the write audit's command satisfies the read-only audit and hides the gap
    // this test exists to catch; without a left boundary the reverse holds for any alias that is a suffix
    // of a documented one.
    const aliases = Object.entries(scripts)
      .filter(([, cmd]) => cmd.includes(`scripts/${file}`))
      .map(([name]) => name);
    return !aliases.some((name) => new RegExp(`(?<![\\w:-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w:-])`).test(COMMANDS));
  });
  assert.deepEqual(undocumented, [], `live audits with no documented command: ${undocumented.join(", ")}`);
});

test("the README's group assignment for each rename-safety tool is the real one", () => {
  // The README described these three as sitting "outside those groups" when in fact each belongs to a
  // toolset and is enabled by it — an operator narrowing the server by that sentence would have expected a
  // smaller surface than they configured. The prose now names a group per tool, so the pairing is the thing
  // that can drift, and the pairing is what this asserts.
  //
  // A tempting assertion here is "no curated tool is in zero groups". It is VACUOUS: `allTools` is built as
  // `[...alwaysOnTools, ...groupArrays]`, so nothing in it can be ungrouped and the check cannot ever fail.
  // Asserting through `selectTools` instead tests the operator-visible claim rather than set arithmetic.
  const RENAME_SAFETY = { reai_update_company_bank: "bank", reai_set_supplier_address: "purchase", reai_update_creditor: "loans" };
  for (const [tool, group] of Object.entries(RENAME_SAFETY)) {
    const members = TOOL_GROUPS[group].map((t) => (typeof t === "string" ? t : t.name));
    assert.ok(members.includes(tool), `README puts ${tool} in ${group}; TOOL_GROUPS.${group} does not contain it`);
    const narrowed = selectTools([group]).map((t) => t.name);
    assert.ok(narrowed.includes(tool), `REAI_TOOLSETS=${group} does not enable ${tool}, which the README says it does`);
    assert.match(README, new RegExp(`\`${tool}\`(?: belongs)? to \`${group}\``),
      `the README must state which group ${tool} is in, so this pairing stays checkable`);
  }

  // The README's next sentence claims exactly ONE tool is outside all thirteen groups. A prose tripwire on
  // the phrase was tried and dropped: it fired on true sentences ("`reai_reconcile_ui` sits outside these
  // groups") while every paraphrase of the false one walked past it. This asserts the claim instead — and
  // unlike "no curated tool is ungrouped", it can fail, because `registeredTools` is not built from the
  // groups. A second independently gated tool added without a docs decision fails here.
  const grouped = new Set(Object.values(TOOL_GROUPS).flat().map((t) => (typeof t === "string" ? t : t.name)));
  const alwaysOn = new Set(alwaysOnTools.map((t) => t.name));
  const outside = registeredTools.map((t) => t.name).filter((n) => !grouped.has(n) && !alwaysOn.has(n));
  assert.deepEqual(outside, uiTools.map((t) => t.name),
    "the README says one tool is outside all thirteen groups; the set of such tools has changed");
});

test("no documentation table calls an irreversible tool reversible", () => {
  // A risk column kept saying "reversible" after reconciliation rules were
  // escalated, so anyone following the documented default found them missing.
  //
  // Searches every documentation page, not just the README. It read `README` alone, which made it
  // one file move away from being VACUOUS: the loop `continue`s when a tool is not named, so
  // relocating the tool tables into `docs/` — which #88 considered and a later pass may still do —
  // would have left it passing while checking nothing. The same trap #90 found in three other
  // assertions here. The rows are counted below, so emptiness fails instead of passing quietly.
  let rowsChecked = 0;
  for (const tool of registeredTools) {
    if (tool.risk !== "irreversible") continue;
    for (const { file, text } of DOCS) {
      for (const line of text.split("\n")) {
        if (!line.includes(`\`${tool.name}\``)) continue;
        if (!line.trimStart().startsWith("|")) continue;
        rowsChecked++;
        // The risk cell is the LAST one, and a row naming two tools writes it as `read / reversible`.
        // Matching `| reversible |` could not see that, so a bundled row was structurally invisible to
        // this check: two of them were added in the same PR that noticed, and the row this file used to
        // rely on (`read / **irreversible**`) had been invisible all along.
        const cells = line.split("|").map((c) => c.trim()).filter((c) => c !== "");
        const risk = (cells[cells.length - 1] ?? "").toLowerCase().replace(/\*/g, "");
        // MENTIONS irreversible, rather than equals it: a real cell can read `read / reversible` for a
        // two-tool row or `irreversible + external send` for a transmitting one, and both are correct.
        // The failure being guarded is a cell that says reversible or read INSTEAD of irreversible.
        assert.ok(
          risk.includes("irreversible"),
          `${tool.name} is irreversible but its row in ${file} claims ${JSON.stringify(risk)}:\n  ${line.trim()}`,
        );
      }
    }
  }
  // A floor, not a fixture: it exists so that moving or reshaping the tables fails here rather than
  // quietly reducing this test to a no-op. Measured at 34 rows when written.
  assert.ok(
    rowsChecked > 20,
    `only ${rowsChecked} documented rows named an irreversible tool — the tables have moved or ` +
      `changed shape, and this assertion is now checking almost nothing`,
  );
});

/**
 * Every sentence that states how many operations no curated tool covers, checked against the number.
 *
 * This is the third time that figure has been wrong. It was "~256" when the registry was small, then
 * "~250" in two test comments while the truth was 170 — corrected once — and by the time three more
 * toolsets had shipped the truth was 152 while **seven** places still said 170 or ~256. Each correction
 * was accurate on the day it was written and rotted the moment curated coverage grew, which is what a
 * hand-maintained number does.
 *
 * A band was the previous attempt and it was the wrong instrument: 152 sits inside 150–190, so the test
 * stayed green while the README's stated figure was 18 too high. The band watched the WORLD when the
 * thing that rots is the PROSE.
 *
 * So this reads the claims. Any "N operations no curated tool cover(s)" or "N uncovered operations" in
 * the README, in `docs/`, or in a test file has to equal the computed figure — and there must be at
 * least one, so deleting the sentences is not a way to pass. Adding curated tools now fails here, in a
 * message naming every file to update, which is the only kind of reminder that survives.
 */
test("every stated uncovered-operation count matches the registry", async () => {
  const { readdirSync } = await import("node:fs");
  const index = getSpecIndex();
  const publicOps = index.counts.public;

  // Declared pairs INTERSECTED with the public set, not counted raw. Subtracting a count that may
  // include an internal operation from a count that excludes them gives a figure that is too low, and
  // this test would then enforce it. No curated tool declares an internal path today — verified, the
  // intersection changes nothing — so this is about the day one does, or the day a spec refresh
  // reclassifies an endpoint.
  const publicPairs = new Set(index.operations.filter((o) => !o.internal).map((o) => `${o.method} ${o.path}`));
  const covered = new Set();
  for (const tool of allTools) {
    for (const [method, path] of tool.apiPaths ?? []) {
      if (publicPairs.has(`${method} ${path}`)) covered.add(`${method} ${path}`);
    }
  }
  const uncovered = publicOps - covered.size;

  assert.equal(publicOps, 321, "the README says 321 public operations in four places");

  // Both phrasings in use, and `~` allowed so an approximate claim is caught rather than excused.
  const CLAIM = /~?(\d+)\s+(?:public\s+)?(?:operations?\s+no curated tool covers?|uncovered operations?)/g;
  const files = [
    ...DOC_FILES,
    ...readdirSync(join(repo, "test"))
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => `test/${f}`),
  ];

  // Comment leaders stripped and whitespace collapsed BEFORE matching. Two of these sentences wrap
  // inside a JSDoc block, and the `*` that starts the continuation line sits between the words — so the
  // regex silently skipped them, which is the worst possible failure for a test whose whole job is
  // catching stale prose. Found in review of this very test: it was guarding four of six claims while
  // reporting itself satisfied.
  const readable = (file) =>
    readFileSync(join(repo, file), "utf8")
      .replace(/^[ \t]*\*[ \t]?/gm, "")
      .replace(/[ \t]*\n[ \t]*/g, " ");

  const wrong = [];
  let found = 0;
  for (const file of files) {
    for (const m of readable(file).matchAll(CLAIM)) {
      found++;
      if (Number(m[1]) !== uncovered) wrong.push(`${file}: says ${m[1]}`);
    }
  }

  // Six today. The floor is high enough that losing one is noticed, which matters because a claim this
  // test cannot see is indistinguishable from a claim that does not exist.
  assert.ok(
    found >= 6,
    `only ${found} statements of the uncovered count were found — if the sentences were removed rather ` +
      `than corrected, or a wrapped one stopped matching, this test has nothing left to guard`,
  );
  assert.deepEqual(
    wrong,
    [],
    `${uncovered} operations are uncovered (${publicOps} public − ${covered.size} declared by curated ` +
      `tools). These say otherwise:\n  ${wrong.join("\n  ")}`,
  );
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
  // The list ran out at "eight" the moment a ninth toolset shipped, and `words[9]` being
  // undefined made the failure read as a changelog problem rather than a test one.
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen"];
  const domains = Object.keys(TOOL_GROUPS).length;
  assert.ok(words[domains], `no word for ${domains} domains — extend the list above`);
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

// A `node_modules` SYMLINK reached main and nobody noticed. It was created in a git worktree so a
// second checkout could share the installed dependencies, and `git add -A` committed it: `.gitignore`
// held `node_modules/`, and a trailing slash matches a directory only, so a symlink of that name was
// never ignored. What landed in a public repository was an absolute path into one developer's home
// directory, and CI stayed green because `npm ci` replaced it — which is exactly why it survived.
//
// The gitignore gap is closed, but the general shape is worth a guard: nothing in this repository
// should be a symlink, and a tracked symlink is almost always someone's local convenience escaping.
test("no symlink is tracked in git", async () => {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  // Mode 120000 is git's mode for a symbolic link.
  const tracked = execFileSync("git", ["ls-files", "-s"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.startsWith("120000"))
    .map((line) => line.split("\t")[1]);
  assert.deepEqual(tracked, [], "these are tracked symlinks — almost certainly a local convenience");
});

// The same mistake with a different mode, and it happened again while writing PR #93: an agent was
// given its own git worktree under `.claude/worktrees/`, and `git add -A` staged it as mode 160000 —
// a gitlink, i.e. a submodule pointing at a commit that exists in no remote. A clone would fail to
// initialise it and CI would not care, exactly like the symlink. `.gitignore` now covers that path,
// but the mode is the durable guard: this repository has no submodules, so any gitlink is an
// accident.
test("no gitlink is tracked in git", async () => {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  // Mode 160000 is git's mode for a commit object embedded in a tree.
  const tracked = execFileSync("git", ["ls-files", "-s"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.startsWith("160000"))
    .map((line) => line.split("\t")[1]);
  assert.deepEqual(tracked, [], "these are tracked gitlinks — a submodule nobody can fetch");
  // And the file that is supposed to prevent it says so, so removing the rule fails here rather
  // than silently waiting for the next `git add -A`.
  const { readFileSync } = await import("node:fs");
  assert.match(
    readFileSync(new URL("../.gitignore", import.meta.url), "utf8"),
    /^\.claude\/worktrees\/$/m,
    ".gitignore no longer ignores agent worktrees, which is how a gitlink gets staged",
  );
});
