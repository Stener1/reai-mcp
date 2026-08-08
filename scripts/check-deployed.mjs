#!/usr/bin/env node
/**
 * Is what agents are talking to the same thing that is in git?
 *
 * This exists because of a specific failure. PR #115 measured two quirks false and corrected them — one
 * told agents a `+47` prefix is REJECTED on a supplier phone, which it is not, and one said foreign
 * numbers are stored "EXACTLY as sent", which they are not. Both are agent-facing: they reach a client
 * through `reai_describe_endpoint`, `reai_api_notes` and a failed `reai_request`. The commits merged and
 * the deployment kept serving the old text.
 *
 * MEASURED, because the first version of this comment said "for two days" and that was invented: the
 * corrections were committed at 22:29Z and the next deploy was 23:00Z. **31 minutes.** The repository was
 * 2.5 days old at the time, so two days was not even arithmetically possible. The window was short
 * because someone happened to look, not because anything would have noticed — which is the actual
 * argument for this script, and it does not need an exaggerated number.
 *
 * Nothing could have noticed: the deploy recorded no commit, so "is the deployment current" could only be
 * answered by comparing a revision timestamp against `git log` — which cannot distinguish a commit made
 * before the deploy from one merged after it.
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
 * Agent-facing drift exits non-zero; the other two are reported and pass.
 *
 * The first version justified that split by claiming "six of the last seven merges touched only tests and
 * scripts". Measured with the exported `classify()` below, it is the other way round: FIVE of the last
 * seven were agent-facing, two inert. So this will exit 1 on most merges, and the split is not a
 * cry-wolf defence — it earns its place by saying WHICH commits matter and why, so a reader deciding
 * whether to deploy has the reason in front of them rather than a bare "stale".
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
import { pathToFileURL } from "node:url";

/**
 * Paths whose contents reach a client.
 *
 * The first version listed four paths under `src/` and stopped there, which left a hole the review of
 * PR #117 walked straight through: agent-facing content that does not live in `src/` at all.
 *
 *   spec/index.json                spec.ts reads it at RUNTIME — it IS reai_describe_endpoint's content
 *   spec/reai-openapi.json         the same, and both are COPYed into the image
 *   scripts/build-spec-index.mjs   the Dockerfile runs the build, so this GENERATES the above in-image
 *   src/reai/errors.ts             ERROR_HINTS is verbatim prose appended to every failure an agent sees,
 *                                  and it names the tool to call next
 *   src/reai/spec.ts               shapes and labels the describe_endpoint payload
 *   Dockerfile, package*.json      decide what actually runs; a dep bump is not "no deploy needed"
 *
 * A false INERT is the failure mode that matters here — a PR that only regenerates `spec/index.json`
 * changes precisely the kind of text this script was written about, and was reported as needing no deploy.
 */
export const AGENT_FACING =
  /^(src\/(reai\/(quirks|errors|spec)\.ts|tools\/|server\.ts|policy\.ts)|spec\/|scripts\/build-spec-index\.mjs|Dockerfile|package(-lock)?\.json)/;

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
  // Both `--flag value` and `--flag=value`. The first version only did the former, so
  // `--project=other` was silently ignored and the script reported confidently on a service nobody
  // asked about.
  const arg = (name, fallback) => {
    const equals = args.find((a) => a.startsWith(`--${name}=`));
    if (equals) return equals.slice(`--${name}=`.length);
    const i = args.indexOf(`--${name}`);
    const value = i >= 0 ? args[i + 1] : undefined;
    if (i >= 0 && (value === undefined || value.startsWith("--"))) {
      console.error(`--${name} needs a value.`);
      process.exit(2);
    }
    return value ?? fallback;
  };
  const project = arg("project", "sales-moitoring");
  const region = arg("region", "europe-north1");
  const service = arg("service", "reai-mcp");

  const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();

  // From the revision(s) RECEIVING TRAFFIC, not from the service's own labels.
  //
  // The service label records the last deploy ATTEMPT. `gcloud run deploy` applies labels and image in
  // one replace, so if the new revision never becomes ready, traffic stays on the old one while the
  // service label already claims the new SHA — and this script would print "the deployment is current"
  // while agents read the old text. That is this script's own failure mode, inverted and made invisible.
  // A rollback or `update-traffic` does the same. Found by the review of PR #117.
  let serving;
  try {
    const raw = execFileSync(
      "gcloud",
      [
        "run",
        "services",
        "describe",
        service,
        `--project=${project}`,
        `--region=${region}`,
        "--format=json",
      ],
      { encoding: "utf8" },
    );
    const described = JSON.parse(raw);
    const traffic = (described.status?.traffic ?? []).filter((t) => (t.percent ?? 0) > 0);
    if (traffic.length === 0) {
      console.error("The service reports no revision receiving traffic.");
      process.exit(2);
    }
    serving = [];
    for (const t of traffic) {
      const label = execFileSync(
        "gcloud",
        [
          "run",
          "revisions",
          "describe",
          t.revisionName,
          `--project=${project}`,
          `--region=${region}`,
          "--format=value(metadata.labels.commit)",
        ],
        { encoding: "utf8" },
      ).trim();
      serving.push({ revision: t.revisionName, percent: t.percent, label });
    }
  } catch (err) {
    console.error(`Could not read the serving revision's commit label: ${err.message}`);
    process.exit(2);
  }

  if (serving.length > 1) {
    console.log(
      `Traffic is split across ${serving.length} revisions:\n` +
        serving.map((r) => `  ${r.percent}%  ${r.revision}  ${r.label || "(no commit label)"}`).join("\n"),
    );
    const distinct = new Set(serving.map((r) => r.label));
    if (distinct.size > 1) {
      console.error(
        `\nThose revisions were built from different commits, so "what is deployed" has no single answer.` +
          `\nSend all traffic to one revision before asking this question.`,
      );
      process.exit(1);
    }
  }
  const deployed = serving[0].label;

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

  // Ancestry ASKED, not inferred from a throw. `git log A..HEAD` succeeds for any commit the object store
  // knows — it only throws on an unknown revision — so the previous version's "not an ancestor" branch was
  // unreachable in the case that matters. The review of PR #117 built a diverged branch whose tip changed
  // quirks.ts, pointed the label at it, and got "no deploy is required for correctness" while the running
  // revision contained agent-facing code that is not in HEAD at all. This repository squash-merges and
  // deploys from the feature branch, so a stamped SHA routinely stops being an ancestor of main.
  let isAncestor = true;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", deployedSha, "HEAD"], { stdio: "ignore" });
  } catch {
    isAncestor = false;
  }
  if (!isAncestor) {
    let onlyDeployed = "";
    try {
      onlyDeployed = git("log", "--oneline", `HEAD..${deployedSha}`);
    } catch {
      console.error(
        `\n${deployedSha} is not a commit this checkout contains at all. Fetch, or deploy from the\n` +
          `branch that is actually live.`,
      );
      process.exit(1);
    }
    console.error(
      `\n${deployedSha} is NOT an ancestor of HEAD: the running service contains commits that are not\n` +
        `in this branch, so "what is missing from the deployment" is not the whole story.\n\n` +
        `Only in the DEPLOYMENT:\n  ${onlyDeployed.split("\n").join("\n  ")}`,
    );
    process.exit(1);
  }

  const range = git("log", "--oneline", `${deployedSha}..HEAD`);

  if (!range) {
    console.log(
      dirty
        ? "\nNo commits between them, but the deployment was built from a dirty tree, so what is running\n" +
            "is not any commit. Re-deploy from a clean checkout to make this answerable."
        : "\nNo commits between them; the deployment is current.",
    );
    process.exit(dirty ? 1 : 0);
  }

  // `--no-renames`, because with rename detection `--name-only` prints only the DESTINATION path. Moving
  // src/tools/foo.ts out of tools/ would therefore drop the agent-facing path entirely and classify the
  // commit as behavioural. Codex's finding on PR #117; with --no-renames a rename shows as delete + add,
  // so both paths are seen.
  const commits = range.split("\n").map((line) => {
    const sha = line.split(" ")[0];
    const files = git("show", "--name-only", "--no-renames", "--format=", sha).split("\n").filter(Boolean);
    return { line, ...classify(files) };
  });

  // The VERDICT comes from the net diff, not from the union of the commits.
  //
  // Codex's other finding: an agent-facing change followed by a complete revert marks both commits
  // agent-facing and exits 1, when the deployed revision and HEAD in fact contain identical agent-facing
  // content and no deploy is required. The per-commit list stays, because it is what tells a reader WHY —
  // but what is served is decided by what differs, and nothing else.
  const netFiles = git("diff", "--name-only", "--no-renames", `${deployedSha}..HEAD`)
    .split("\n")
    .filter(Boolean);
  const net = classify(netFiles);

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

  // A `-dirty` deployment is running code that is no commit and may contain uncommitted agent-facing
  // edits, so it cannot be "current" whatever the commit list says. The first version honoured the flag
  // only when the commit range was empty and dropped it here.
  if (dirty) {
    console.error(
      `\nThe running service was built from a DIRTY tree, so what is deployed is not any commit and the\n` +
        `list above cannot be complete. Re-deploy from a clean checkout.`,
    );
    process.exit(1);
  }

  if (net.kind === "agent-facing") {
    console.error(
      `\n${net.agentFacing.length} file(s) an agent reads differ between the deployment and HEAD:\n` +
        `  ${net.agentFacing.join("\n  ")}\n` +
        `deployment does not have them. Revision 00135 was in that state for 31 minutes while serving two\n` +
        `quirks already measured false — agents were told a "+47" prefix is rejected on a supplier phone,\n` +
        `and that foreign numbers are stored exactly as sent. Neither is true. It was 31 minutes because\n` +
        `someone looked, not because anything checked.\n\n` +
        `  bash scripts/deploy-cloud-run.sh --project ${project} --region ${region} \\\n` +
        `    --service ${service} --write-mode reversible`,
    );
    process.exit(1);
  }

  if (groups["agent-facing"].length > 0) {
    console.log(
      `\n${groups["agent-facing"].length} commit(s) touched agent-facing files, but the NET difference\n` +
        `between the deployment and HEAD does not — a change and its revert, or a file returned to its\n` +
        `deployed content. No deploy is required for correctness.`,
    );
    process.exit(0);
  }

  console.log("\nNothing an agent reads has changed, so no deploy is required for correctness.");
  process.exit(0);
}

// Guarded, so importing this module for its classifier does not shell out to gcloud.
//
// The first version compared `import.meta.url.endsWith(basename)`, which the review of PR #117 broke three
// ways: it fired on ANY entry script whose basename is a tail of this one (`d.mjs` importing this ran
// main()), it silently did NOTHING when invoked through a symlink or a rename — printing no output and
// exiting 0, indistinguishable from "no drift" in a CI step — and an argv[1] ending in "/" gave an empty
// basename, which `endsWith("")` accepts. A URL comparison has none of those failure modes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
