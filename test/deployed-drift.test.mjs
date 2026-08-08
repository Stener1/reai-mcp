import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_FACING, classify } from "../scripts/check-deployed.mjs";

/**
 * The deployment-drift check, tested by CALLING it rather than by grepping it.
 *
 * Worth stating why, because this repository has learned it the hard way three times: every guard here
 * that verified a script by pattern-matching its source has been defeated — by a commented-out line, by a
 * string in a log message, by a rename. `check-deployed.mjs` exports its classifier for that reason, and
 * these tests exercise the real function.
 *
 * What the check exists for: PR #115 corrected two quirks that had been measured FALSE — agents were told
 * a `+47` prefix is rejected on a supplier phone, and that foreign numbers are stored exactly as sent.
 * The commits merged and the deployment kept serving both for 31 minutes — measured, after the review of
 * PR #117 caught the first version of this comment claiming "two days", which the repository was not even
 * old enough for. It was 31 minutes because someone looked, not because anything checked.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

test("everything a client reads is classified agent-facing", () => {
  // Each of these reaches an agent: quirks through reai_describe_endpoint and reai_api_notes, tool files
  // through the tool list, server.ts through the per-session instructions, policy.ts through the wording
  // of a refusal the agent then has to act on.
  for (const file of [
    "src/reai/quirks.ts",
    "src/tools/sales.ts",
    "src/tools/registry.ts",
    "src/server.ts",
    "src/policy.ts",
  ]) {
    assert.equal(classify([file]).kind, "agent-facing", `${file} should count as agent-facing`);
  }
});

test("one agent-facing file in a mixed commit makes the whole commit agent-facing", () => {
  // The realistic shape: a PR that fixes a quirk and adds tests for it. Classifying by the majority of
  // files would have hidden exactly the commit this check was built for.
  const mixed = ["test/quirks.test.mjs", "docs/api-quirks.md", "src/reai/quirks.ts", "CHANGELOG.md"];
  const verdict = classify(mixed);
  assert.equal(verdict.kind, "agent-facing");
  assert.deepEqual(verdict.agentFacing, ["src/reai/quirks.ts"]);
});

test("a change no client can read is INERT, so the check does not cry wolf", () => {
  // This matters as much as the positive case, though not for the reason first claimed here: "six of the
  // last seven merges were tests and scripts only" was asserted without measuring, and running the
  // exported classify() over them gives FIVE agent-facing and two inert. The split earns its place by
  // naming which commits matter, not by being quiet most of the time.
  // `package.json` is deliberately NOT here: a dep bump or a changed script changes what runs in the
  // image, so it is agent-facing. Having it in this fixture was the mistake the widened classifier caught.
  const verdict = classify([
    "test/storage-drift.test.mjs",
    "scripts/audit-storage.mjs",
    "docs/development.md",
    "CHANGELOG.md",
    "README.md",
  ]);
  assert.equal(verdict.kind, "inert");
  assert.deepEqual(verdict.agentFacing, []);
});

test("other src/ changes are behavioural, not inert", () => {
  // The HTTP transport and the API client cannot be read by an agent, but they decide what it gets. Not a
  // correctness emergency, not nothing either.
  for (const file of ["src/reai/client.ts", "src/http.ts", "src/auth/oauth.ts", "src/config.ts"]) {
    assert.equal(classify([file]).kind, "behavioural", `${file} should count as behavioural`);
  }
});

test("every agent-facing directory that exists is actually matched", () => {
  // A floor against the pattern rotting: if a tool directory is renamed, or a new one added, this fails
  // rather than silently classifying real agent-facing changes as inert.
  const dirs = ["src/tools/loans.ts", "src/tools/bankvat.ts", "src/tools/discovery.ts"];
  for (const file of dirs) assert.match(file, AGENT_FACING, `${file} must match AGENT_FACING`);
  // And the negative: a path that only LOOKS like one.
  assert.doesNotMatch("test/tools/sales.test.mjs", AGENT_FACING);
  assert.doesNotMatch("docs/tools.md", AGENT_FACING);
});

test("the deploy script stamps the commit it built from", () => {
  // Without this the check has nothing to read, which was the state that let false guidance be served
  // with no way to detect it.
  // Comment lines stripped. The review of PR #117 deleted the --labels line, commented out the COMMIT
  // assignment and turned the dirty check into `if false`, and all of these still passed — because the
  // explanatory comment block above them mentions the same phrases. A guard satisfied by prose about the
  // thing it checks is the exact failure this repository has now hit four times.
  const deploy = readFileSync(path.join(ROOT, "scripts/deploy-cloud-run.sh"), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  assert.match(deploy, /--labels="commit=/);
  assert.match(deploy, /rev-parse --short HEAD/);
  // A dirty tree must not be stamped as though the commit described what was built.
  assert.match(deploy, /-dirty/);
  assert.match(deploy, /git status --porcelain/);
});

test("the check reports what it cannot know", () => {
  // It compares a label against git log. It says nothing about whether the deployment WORKS, and claiming
  // otherwise would make a green run mean less than it says — the failure mode two audits in this
  // repository were corrected for.
  // These two DO read prose, deliberately and with the limit acknowledged: the claim being guarded IS a
  // sentence in the header, so there is nothing else to assert against. It is a reminder, not a proof.
  const src = readFileSync(path.join(ROOT, "scripts/check-deployed.mjs"), "utf8");
  assert.match(src, /What it cannot tell you/);
  assert.match(src, /smoke-http/, "it should point at the thing that does answer that");
});

test("agent-facing content OUTSIDE src/ is classified as such", () => {
  // The hole the review of PR #117 found: a PR that only regenerates `spec/index.json` changes exactly the
  // text reai_describe_endpoint serves, and the first classifier called it INERT — "no deploy is required
  // for correctness". `spec.ts` reads that file at runtime and the Dockerfile copies it into the image.
  for (const file of [
    "spec/index.json",
    "spec/reai-openapi.json",
    "scripts/build-spec-index.mjs",
    "src/reai/errors.ts",
    "src/reai/spec.ts",
    "Dockerfile",
    "package.json",
    "package-lock.json",
  ]) {
    assert.equal(classify([file]).kind, "agent-facing", `${file} should count as agent-facing`);
  }
});

test("the main-module guard compares URLs, not a basename suffix", () => {
  // `import.meta.url.endsWith(basename)` failed three ways: it ran main() when any script whose name is a
  // tail of this one imported it, it silently did nothing through a symlink or rename (no output, exit 0 —
  // indistinguishable from "no drift"), and an argv[1] ending in "/" gave an empty basename that
  // endsWith("") accepts. Asserted on the source because the alternative is spawning processes.
  const src = readFileSync(path.join(ROOT, "scripts/check-deployed.mjs"), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  assert.match(src, /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
  assert.doesNotMatch(src, /import\.meta\.url\.endsWith/);
});

test("importing this module does not shell out", async () => {
  // The positive form of the guard: if it fired on import, this test process would have run gcloud.
  const mod = await import("../scripts/check-deployed.mjs");
  assert.equal(typeof mod.classify, "function");
  assert.ok(mod.AGENT_FACING instanceof RegExp);
});
