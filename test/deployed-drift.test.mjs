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
 * The commits merged and the deployment was not updated for two days, so the live connector went on
 * serving both. Nothing could have noticed: the deploy recorded no commit.
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
  // This matters as much as the positive case. Six of the last seven merges here were tests and scripts
  // only; if those reported "stale deployment" the reader would learn to ignore the check, and then miss
  // the one that mattered.
  const verdict = classify([
    "test/storage-drift.test.mjs",
    "scripts/audit-storage.mjs",
    "docs/development.md",
    "CHANGELOG.md",
    "package.json",
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
  // Without this the check has nothing to read, which was the state that allowed two days of false
  // guidance to be served with no way to detect it.
  const deploy = readFileSync(path.join(ROOT, "scripts/deploy-cloud-run.sh"), "utf8");
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
  const src = readFileSync(path.join(ROOT, "scripts/check-deployed.mjs"), "utf8");
  assert.match(src, /What it cannot tell you/);
  assert.match(src, /smoke-http/, "it should point at the thing that does answer that");
});
