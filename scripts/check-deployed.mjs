#!/usr/bin/env node
/**
 * Is what agents are talking to the same thing that is in git?
 *
 * This exists because of a specific failure, not a hypothetical. PR #115 measured two quirks false and
 * corrected them — one told agents a `+47` prefix is REJECTED on a supplier phone, which it is not, and
 * one said foreign numbers are stored "EXACTLY as sent", which they are not. Both are agent-facing: they
 * reach a client through `reai_describe_endpoint`, `reai_api_notes` and a failed `reai_request`. The
 * commits merged; the deployment was not updated for two days; the live connector went on serving the
 * false guidance to anything that asked.
 *
 * Nothing noticed, and nothing could have: the deploy recorded no commit, so "is the deployment current"
 * could only be answered by comparing a revision timestamp against `git log` — which cannot distinguish a
 * commit made before the deploy from one merged after it.
 *
 * So the deploy stamps `commit=<sha>` as a Cloud Run label, and this reads it back.
 *
 * ## What it reports, and why the distinction matters
 *
 * Not every undeployed commit is worth a deploy. A test-only change is invisible to agents; a changed
 * tool description or quirk is what they read. So the drift is split:
 *
 *   AGENT-FACING   src/reai/quirks.ts, tool files, server instructions, policy — deploy
 *   BEHAVIOURAL    other src/ changes — probably deploy
 *   INERT          tests, scripts, docs — no deploy needed
 *
 * Agent-facing drift exits non-zero, because that is the case that has already caused harm. Calling a
 * test-only change "stale deployment" would train the reader to ignore this check, which is how a real
 * one gets missed.
 *
 * ## What it cannot tell you
 *
 * That the deployment WORKS. It compares a label against `git log` and nothing more: a revision can carry
 * the right commit and still be broken, and `scripts/smoke-http.mjs` is what answers that. It also cannot
 * see a deploy made from another machine's dirty tree beyond the `-dirty` suffix on the label.
 *
 *   node scripts/check-deployed.mjs --project sales-moitoring --region europe-north1 --service reai-mcp
 */
import { execFileSync } from "node:child_process";

/**
 * Paths whose contents reach a client.
 *
 * `quirks.ts` and the tool files are what `reai_describe_endpoint` and the tool list surface; `server.ts`
 * holds the instructions every session receives; `policy.ts` decides what is refused, and its refusal
 * messages are read by the agent that hit them.
 */
export const AGENT_FACING = /^src\/(reai\/quirks\.ts|tools\/|server\.ts|policy\.ts)/;

/**
 * Exported so `test/deployed-drift.test.mjs` exercises the real classification rather than grepping this
 * file for a regex. Every guard in this repository that checked a script by pattern-matching its source
 * has been defeated by a comment or a rename; a function can be called.
 */
export function classify(files) {
  const agentFacing = files.filter((f) => AGENT_FACING.test(f));
  const behavioural = files.filter((f) => f.startsWith("src/") && !AGENT_FACING.test(f));
  if (agentFacing.length > 0) return { kind: "agent-facing", agentFacing, behavioural };
  if (behavioural.length > 0) return { kind: "behavioural", agentFacing, behavioural };
  return { kind: "inert", agentFacing, behavioural };
}

function main() {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const project = arg("project", "sales-moitoring");
  const region = arg("region", "europe-north1");
  const service = arg("service", "reai-mcp");

  const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();

  let deployed;
  try {
    deployed = execFileSync(
      "gcloud",
      [
        "run",
        "services",
        "describe",
        service,
        `--project=${project}`,
        `--region=${region}`,
        "--format=value(metadata.labels.commit)",
      ],
      { encoding: "utf8" },
    ).trim();
  } catch (err) {
    console.error(`Could not read the deployed service's commit label: ${err.message}`);
    process.exit(2);
  }

  if (!deployed) {
    console.error(
      `The deployed service carries no commit label.\n\n` +
        `Deployments made before scripts/deploy-cloud-run.sh started stamping one cannot be identified,\n` +
        `which is the situation this check exists to end. Deploy once and the label appears.`,
    );
    process.exit(2);
  }

  const dirty = deployed.endsWith("-dirty");
  const deployedSha = dirty ? deployed.slice(0, -"-dirty".length) : deployed;
  const head = git("rev-parse", "--short", "HEAD");

  console.log(
    `deployed: ${deployed}${dirty ? "  (built from a DIRTY tree — the label does not describe a commit)" : ""}`,
  );
  console.log(`HEAD:     ${head}`);

  if (deployedSha === head && !dirty) {
    console.log("\nThe deployment is current.");
    process.exit(0);
  }

  let range;
  try {
    range = git("log", "--oneline", `${deployedSha}..HEAD`);
  } catch {
    console.error(
      `\n${deployedSha} is not an ancestor of HEAD — the deployment was built from a commit this\n` +
        `checkout does not contain. Fetch, or deploy from the branch that is actually live.`,
    );
    process.exit(1);
  }

  if (!range) {
    console.log(
      dirty
        ? "\nNo commits between them, but the deployment was built from a dirty tree, so what is running\n" +
            "is not any commit. Re-deploy from a clean checkout to make this answerable."
        : "\nNo commits between them; the deployment is current.",
    );
    process.exit(dirty ? 1 : 0);
  }

  const commits = range.split("\n").map((line) => {
    const sha = line.split(" ")[0];
    const files = git("show", "--name-only", "--format=", sha).split("\n").filter(Boolean);
    return { line, ...classify(files) };
  });

  const groups = {
    "agent-facing": commits.filter((c) => c.kind === "agent-facing"),
    behavioural: commits.filter((c) => c.kind === "behavioural"),
    inert: commits.filter((c) => c.kind === "inert"),
  };

  console.log(`\n${commits.length} commit(s) not deployed:`);
  for (const [label, note] of [
    ["agent-facing", "a client reads this — deploy"],
    ["behavioural", "other src/ changes — probably deploy"],
    ["inert", "tests, scripts, docs — no deploy needed"],
  ]) {
    const list = groups[label];
    if (list.length === 0) continue;
    console.log(`\n  ${label.toUpperCase()} (${list.length}) — ${note}`);
    for (const c of list) {
      console.log(`    ${c.line}`);
      for (const f of c.agentFacing) console.log(`      ${f}`);
    }
  }

  if (groups["agent-facing"].length > 0) {
    console.error(
      `\n${groups["agent-facing"].length} commit(s) changed text or behaviour an agent reads, and the\n` +
        `deployment does not have them. That is the exact state revisions 00135–00136 were in while\n` +
        `serving two quirks already measured false: agents were told a "+47" prefix is rejected on a\n` +
        `supplier phone, and that foreign numbers are stored exactly as sent. Neither is true.\n\n` +
        `  bash scripts/deploy-cloud-run.sh --project ${project} --region ${region} \\\n` +
        `    --service ${service} --write-mode reversible`,
    );
    process.exit(1);
  }

  console.log("\nNothing an agent reads has changed, so no deploy is required for correctness.");
  process.exit(0);
}

// Guarded, so importing this module for its classifier does not shell out to gcloud.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main();
}
