import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Every regex that reads an API error's TEXT must have a live probe in scripts/audit-messages.mjs.
 *
 * These matches are the repository's only silent dependency on upstream wording. When a message is
 * rephrased the translation stops firing, the agent gets raw Norwegian instead of an explanation, and
 * nothing anywhere fails — the tests stub the error, so they keep passing on a string the API no
 * longer produces. That has already happened once here: a quirk quoted "…kan skrives uten +" against
 * a live "…kan skrives uten +47.".
 *
 * A unit test cannot check the wording — only the live API can. What it CAN do is make sure no such
 * dependency exists without a probe, which is what this file is. The audit then answers whether the
 * wording still holds; this answers whether the audit is complete.
 */

const SRC = "src";

/** Exemptions, each with what is missing rather than a shrug. */
const NO_PROBE_YET = {
  "referenced by one or more loans":
    "needs a loan that a counterparty is attached to; tenant 2783 has no loans, and creating one to " +
    "delete is not reversible — the delete answers 409 once postings exist",
  "finnes allerede":
    "needs an existing loan whose reference can be duplicated; tenant 2783 has no loans",
  "Angi sluttsaldoen":
    "needs a MANUAL company bank account; tenant 2783 has none, and a company bank created through " +
    "the API is the only way to get one",
  "ikke låst":
    "same as Angi sluttsaldoen — needs a manual company bank account to reconcile against",
};

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * A regex applied to error text, as opposed to one parsing a path or a number. The discriminator is
 * that the pattern contains a space or a Norwegian letter — API prose does, path patterns do not.
 */
function messageRegexes() {
  const found = [];
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, "utf8");
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      const m = line.match(/\/([^/\n]{6,90})\/i?\.test\(/);
      if (!m) return;
      const pattern = m[1];
      if (!/[a-zæøå] |[æøå]/.test(pattern)) return;
      // Not an API message: this one sniffs an HTML error page, where the "message" is markup.
      if (/doctype html|html\[/i.test(pattern)) return;
      found.push({ file, line: i + 1, pattern });
    });
  }
  return found;
}

function auditPatterns() {
  const src = readFileSync("scripts/audit-messages.mjs", "utf8");
  return [...src.matchAll(/pattern:\s*\/([^/\n]+)\/i?,/g)].map((m) => m[1]);
}

test("every API-message regex in src/ has a live probe, or a stated reason it cannot", () => {
  const regexes = messageRegexes();
  // A floor on the work: if the extraction stops matching, this sweep silently guards nothing. Twelve
  // today across bankvat, bookkeeping, investments, loans, sales and subaccounts.
  assert.ok(
    regexes.length >= 9,
    `only ${regexes.length} message regexes found (12 today) — the extraction has stopped matching`,
  );

  const probes = auditPatterns();
  assert.ok(probes.length >= 7, `only ${probes.length} probes in the audit script`);

  const unprobed = [];
  for (const { file, line, pattern } of regexes) {
    const covered = probes.some((p) => p === pattern || p.includes(pattern) || pattern.includes(p));
    const exempt = Object.keys(NO_PROBE_YET).some((k) => pattern.includes(k));
    if (!covered && !exempt) unprobed.push(`${file}:${line} /${pattern}/`);
  }
  assert.deepEqual(
    unprobed,
    [],
    "these depend on upstream wording with nothing checking it. Add a case to " +
      "scripts/audit-messages.mjs, or an entry to NO_PROBE_YET saying what setup is missing:\n  " +
      unprobed.join("\n  "),
  );
});

test("every exemption names a real regex, so the list cannot rot", () => {
  const patterns = messageRegexes().map((r) => r.pattern);
  for (const [key, reason] of Object.entries(NO_PROBE_YET)) {
    assert.ok(
      patterns.some((p) => p.includes(key)),
      `NO_PROBE_YET names "${key}", which no regex in src/ matches any more — delete the entry`,
    );
    // A reason has to say what is MISSING, not merely that it is hard. Each of these is blocked on
    // test data that tenant 2783 does not have, and saying which is what makes it actionable.
    assert.ok(reason.length > 40, `${key}: the reason is too short to act on`);
    assert.match(reason, /needs|same as/, `${key}: say what setup is missing`);
  }
});

test("the audit script refuses a tenant that has not been opted in", () => {
  // Every case in it is a request designed to fail, but a probe wrong in the other direction would
  // write to real books — so it carries the same REAI_WRITE_TEST_TENANTS guard as the write scripts.
  const src = readFileSync("scripts/audit-messages.mjs", "utf8");
  assert.match(src, /REAI_WRITE_TEST_TENANTS/);
  assert.match(src, /Refusing to run against tenant/);
  assert.match(src, /process\.exit\(2\)/);
});

test("the audit reports INCONCLUSIVE separately from DRIFT", () => {
  // The distinction is the whole reason the script is trustworthy: two of its own probes first
  // reported drift because the request body was malformed and never reached the rule being checked.
  // Collapsing that into "drift" would send someone to rewrite a correct regex.
  const src = readFileSync("scripts/audit-messages.mjs", "utf8");
  assert.match(src, /INCONCLUSIVE/);
  assert.match(src, /never reached the rule/);
  assert.match(src, /do NOT touch/, "an inconclusive result must say the code is not the problem");
  assert.match(src, /fieldErrors/, "shape errors are how the API says the rule was not evaluated");
});
