import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every place that reads an API error's TEXT must have a live probe in scripts/audit-messages.mjs.
 *
 * These matches are the repository's silent dependency on upstream wording. When a message is
 * rephrased the translation stops firing, the agent gets raw Norwegian instead of an explanation, and
 * nothing anywhere fails — the tests stub the error, so they keep passing on a string the API no longer
 * produces. That has already happened once: a quirk quoting "…kan skrives uten +" against a live
 * "…kan skrives uten +47.".
 *
 * A unit test cannot check the wording — only the live API can. What it CAN do is make sure no such
 * dependency exists without a probe. The audit answers whether the wording still holds; this answers
 * whether the audit is complete.
 *
 * ## What the first version missed, and why the extraction looks like this
 *
 * It matched exactly one shape: a single-line literal `/prose/.test(`. The independent review of PR
 * #114 demonstrated, by adding each to `src/` and re-running, that all of these passed unnoticed:
 *
 *     detail.includes("kontoen er sperret for postering")
 *     /Fakturaen er allerede sendt/i.exec(detail)
 *     detail.startsWith("Perioden er avsluttet")
 *     switch (title) { case "Voucher is not balanced": … }
 *     /kontoplanen/i.test(detail)                       // one word, so the prose test rejected it
 *
 * Six real dependencies were invisible for those reasons, including `loans.ts`'s wrong-table
 * diagnosis — which uses `.exec(` and needed no test data at all, so the "tenant 2783 has no loans"
 * exemption never applied to it. The count in the shipped comments was wrong four times over, and
 * 9 probed + 4 exempt did not even equal the 12 claimed.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SRC = path.join(ROOT, "src");
const AUDIT = path.join(ROOT, "scripts/audit-messages.mjs");

/** Exemptions, each stating the test data that is missing rather than shrugging. */
const NO_PROBE_YET = {
  "referenced by one or more loans":
    "needs a loan with a counterparty attached; tenant 2783 has no loans, and creating one to delete " +
    "is not reversible — the delete answers 409 once postings exist",
  "finnes allerede":
    "needs an existing loan whose reference can be duplicated; tenant 2783 has no loans",
  "Angi sluttsaldoen":
    "needs a MANUAL company bank account; tenant 2783 has none, and creating one through the API is " +
    "the only way to get one",
  "ikke låst":
    "same as Angi sluttsaldoen — needs a manual company bank account to reconcile against",
  "Godkjenning er kun tilgjengelig for":
    "needs a manual reconciliation in a nominated month; same missing company bank account",
  "registrerte transaksjoner og kan ikke slettes":
    "needs a share position, and the probe would be DELETE /api/share-investments/{id}, which " +
    "classifyRequest calls irreversible — it would destroy a clean position instead of being refused. " +
    "The first version of the audit shipped that probe and only passed because the one position in " +
    "tenant 2783 happened to be undeletable",
  verdipapirkontoen:
    "needs a share-investment event without companyBankId; safe to probe, but it needs an existing " +
    "position to attach an event to and tenant 2783's only one is a labelled leftover",
  "opening balance not found":
    "needs a tenant with NO opening balance recorded; 2783 already has one, and removing it is not " +
    "something to do to a real company's books",
  "no annual-accounts submission":
    "same shape as the opening balance — needs a fiscal year with nothing submitted, and this tenant " +
    "cannot be put into that state safely",
  TransientPropertyValueException:
    "a Hibernate leak from an expense voucher delete; reproducing it needs an expense with a voucher, " +
    "and DELETE /api/expenses/{id}/voucher is what produces it — a write this audit will not make",
};

/**
 * Strings the matchers pick up that are not API ERROR text at all, kept separate from NO_PROBE_YET on
 * purpose: that list means "a real dependency we cannot probe yet", this one means "not in scope".
 * Merging them would make the guard's population meaningless.
 */
const NOT_ERROR_TEXT = {
  officedocument:
    "src/reai/client.ts sniffs a CONTENT-TYPE to decide whether a response is a spreadsheet — it is " +
    "not reading an error message, and no translation depends on it",
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
 * Every shape of "read the API's words", not just the one that was easy to grep.
 *
 * The discriminator for "is this API prose" is deliberately looser than the first version's: a space
 * OR a Norwegian letter OR CamelCase-with-a-capital (which is how `TransientPropertyValueException`
 * and `Godkjenning` got missed). False positives here cost an exemption entry; false negatives cost a
 * silent dependency, which is the whole subject.
 */
const MATCHERS = [
  // /prose/.test(…), /prose/.exec(…), /prose/i.test(…)
  { kind: "regex", re: /\/((?:[^/\n\\]|\\.){4,120})\/[gimsuy]*\.(?:test|exec)\(/g },
  // isNotFound(err, /prose/) — a regex handed to a helper rather than applied inline
  { kind: "regex-arg", re: /\(\s*err\s*,\s*\/((?:[^/\n\\]|\\.){4,120})\//g },
  // .includes("prose") / .startsWith / .endsWith on ANY receiver.
  //
  // The first attempt at this matcher listed the receiver names it expected — detail, message, title,
  // rawBody — and a probe written as `(d) => d.includes("kontoen er sperret")` walked straight past it.
  // That is the same narrow-filter mistake this repository keeps paying for: the prose discriminator
  // below is what decides whether a string is API text, so the variable's name is irrelevant and
  // guessing it only creates a blind spot. A false positive costs one exemption entry.
  { kind: "includes", re: /\.(?:includes|startsWith|endsWith)\(\s*"([^"\n]{4,120})"/g },
  // case "prose": inside a switch over a message
  { kind: "case", re: /case\s+"([^"\n]{4,120})"\s*:/g },
];

const looksLikeApiProse = (s) =>
  /[a-zæøå] /.test(s) ||
  /[æøåÆØÅ]/.test(s) ||
  /^[A-Z][a-z]+[A-Z]/.test(s) ||
  // A single long word, which is how Norwegian compounds arrive:  has no space and
  // no æøå, so both this repo's earlier discriminators dropped it — and it is a real dependency in
  // investments.ts. Twelve characters is above every identifier-ish token these matchers can capture.
  /^[a-zæøå]{12,}$/.test(s);

function messageDependencies() {
  const found = [];
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, "utf8");
    for (const { kind, re } of MATCHERS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        const pattern = m[1];
        if (!looksLikeApiProse(pattern)) continue;
        // Not API text: this one sniffs an HTML error page, where the "message" is markup.
        if (/doctype html|html\[/i.test(pattern)) continue;
        found.push({
          file: path.relative(ROOT, file),
          line: src.slice(0, m.index).split("\n").length,
          pattern,
          kind,
        });
      }
    }
  }
  return found;
}

/** The audit's probe patterns, with comments stripped — a commented-out probe is not a probe. */
function auditPatterns() {
  const src = readFileSync(AUDIT, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  return [...src.matchAll(/pattern:\s*\/((?:[^/\n\\]|\\.)+)\//g)].map((m) => m[1]);
}

test("every place that reads an API message has a live probe, or a stated reason it cannot", () => {
  const deps = messageDependencies();
  // A floor on the WORK, at ~0.75 of the measured population of 19 distinct patterns across 20 sites.
  // The first version floored at 9 against 14 — so five could vanish silently, and the review showed
  // an ordinary refactor doing exactly that: hoisting five regexes into named constants took the
  // guarded population from 14 to 9 with every assertion still passing.
  const distinct = new Set(deps.map((d) => d.pattern));
  assert.ok(
    distinct.size >= 14,
    `only ${distinct.size} distinct message dependencies found (19 today across 20 sites) — the ` +
      `extraction has stopped matching. Shapes covered: ${MATCHERS.map((m) => m.kind).join(", ")}`,
  );

  const probes = auditPatterns();
  assert.ok(probes.length >= 7, `only ${probes.length} probes in the audit script`);

  const unprobed = [];
  for (const dep of deps) {
    // Exact, or the probe pattern contains the dependency's pattern — NOT the reverse. The first
    // version accepted `pattern.includes(p)` too, so the review replaced all nine probes with /e/ and
    // every assertion still passed: every regex in src/ contains an "e".
    const covered = probes.some((p) => p === dep.pattern || p.includes(dep.pattern));
    const exempt = Object.keys(NO_PROBE_YET).some((k) => dep.pattern.includes(k));
    const outOfScope = Object.keys(NOT_ERROR_TEXT).some((k) => dep.pattern.includes(k));
    if (!covered && !exempt && !outOfScope) {
      unprobed.push(`${dep.file}:${dep.line} (${dep.kind}) ${dep.pattern}`);
    }
  }
  assert.deepEqual(
    unprobed,
    [],
    "these depend on upstream wording with nothing checking it. Add a case to " +
      "scripts/audit-messages.mjs, or an entry to NO_PROBE_YET saying what setup is missing:\n  " +
      unprobed.join("\n  "),
  );
});

test("a probe pattern cannot cover a dependency by being shorter than it", () => {
  // The review's sharpest test finding: with `pattern.includes(p)` accepted, a one-character probe
  // pattern satisfied the whole population. This asserts the matcher direction directly rather than
  // trusting it, because the failure is invisible — everything still passes.
  const deps = messageDependencies().map((d) => d.pattern);
  const short = "e";
  const wouldCover = deps.filter((d) => d === short || short.includes(d));
  assert.deepEqual(
    wouldCover,
    [],
    `a probe pattern of "${short}" must not cover anything; it covers ${wouldCover.length}`,
  );
});

test("every exemption names a real dependency, so the list cannot rot", () => {
  const patterns = messageDependencies().map((d) => d.pattern);
  for (const [key, reason] of Object.entries({ ...NO_PROBE_YET, ...NOT_ERROR_TEXT })) {
    assert.ok(
      patterns.some((p) => p.includes(key)),
      `NO_PROBE_YET names "${key}", which nothing in src/ matches any more — delete the entry`,
    );
    assert.ok(reason.length > 40, `${key}: the reason is too short to act on`);
    assert.match(
      reason,
      /needs|same as|would|classifyRequest|not reading|not an error/,
      `${key}: say what setup is missing, why probing it is unsafe, or why it is out of scope`,
    );
  }
});

test("the audit refuses a tenant that has not been opted in, and reports a leak as failure", async () => {
  const src = readFileSync(AUDIT, "utf8");
  // The tenant check moved out of this file into scripts/lib/write-guard.mjs, because four scripts each had
  // their own copy of it and all four checked only that --tenant appeared in REAI_WRITE_TEST_TENANTS — a
  // comparison between two operator-supplied values, which agreed with the mistake that put a full-write test
  // on real books. So this asserts the guard is CALLED rather than that a message string is present, and
  // test/write-guard.test.mjs exercises the guard's behaviour directly.
  const { default: ts } = await import("typescript");
  const sf = ts.createSourceFile(AUDIT, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const calls = sf.statements.filter(
    (st) =>
      ts.isExpressionStatement(st) &&
      ts.isCallExpression(st.expression) &&
      st.expression.expression.getText(sf) === "requireWritableTenant",
  );
  assert.equal(calls.length, 1, "this audit must call requireWritableTenant exactly once at the top level");
  // A stranded record is a failed run, not a warning. DELETE /api/customers/{id} can answer
  // "archived", and an archived customer is invisible to the default list — so the first version could
  // leave a record on real books and still exit 0.
  assert.match(src, /outcome !== "deleted"/);
  assert.match(src, /drift > 0 \|\| leaked > 0/, "a leak must affect the exit code");
});

test("the audit reports INCONCLUSIVE separately, and recognises BOTH shapes of a shape error", () => {
  const src = readFileSync(AUDIT, "utf8");
  assert.match(src, /INCONCLUSIVE/);
  assert.match(src, /never reached the rule/);
  assert.match(src, /Do NOT touch/, "an inconclusive result must say the code is not the problem");
  // The first version inferred "malformed probe" from `fieldErrors` alone. ReAI answers a type or
  // format error with {"detail":"Failed to read request"} and no fieldErrors, so a malformed probe was
  // reported as DRIFT — and, worse, a message that MOVED into fieldErrors could never be reported as
  // drift at all. Both shapes have to be named.
  assert.match(src, /Failed to read request/);
  assert.match(src, /is required/);
});

test("the audit asserts the status, not only the wording", () => {
  // Six src sites gate on the status as well as the text: keep the wording, change 404 to 400, and the
  // translation is dead while a text-only audit reports OK.
  const src = readFileSync(AUDIT, "utf8");
  assert.match(src, /expectStatus/);
  assert.match(src, /the STATUS changed/);
  const cases = [...src.matchAll(/pattern:\s*\//g)].length;
  const statuses = [...src.matchAll(/expectStatus:/g)].length;
  assert.equal(statuses, cases, "every case must declare the status it expects");
});

test("each case declares which haystack the guarded code actually reads", () => {
  // `err.message` is detail || title || rawBody and never includes fieldErrors, while the sales.ts
  // translations deliberately search the raw body. An audit with a wider haystack than production's
  // reports OK for a match the shipped code would miss.
  const src = readFileSync(AUDIT, "utf8");
  const cases = [...src.matchAll(/pattern:\s*\//g)].length;
  const haystacks = [...src.matchAll(/haystack:\s*"(message|raw|detail)"/g)].length;
  assert.equal(haystacks, cases, "every case must say which text it compares against");
});

test("every record-creating script verifies the TOKEN's tenant, not just the argument", () => {
  // The allowlist checks a number on the command line. This repository's own
  // `tenant-header-ignored-single-tenant` quirk says a token reaching exactly one tenant IGNORES
  // X-Tenant-Id — so an allowlisted `--tenant 2783` with a token scoped elsewhere writes to that other
  // company while every guard passes. Codex found it on PR #114 against the audit; nothing in the repo
  // checked it, including the two scripts that post to the general ledger. Pinned for all three.
  for (const script of [
    "scripts/audit-messages.mjs",
    "scripts/smoke-write.mjs",
    "scripts/smoke-full-write.mjs",
  ]) {
    const src = readFileSync(path.join(ROOT, script), "utf8");
    assert.match(
      src,
      /does not reach tenant/,
      `${script} does not verify that the token reaches the tenant it was told to use`,
    );
    assert.match(src, /IGNORES? X-Tenant-Id/i, `${script} should say why the check matters`);
  }
});

test("the audit treats an unexpected SUCCESS as a safety failure", () => {
  // Every case is a request that should be refused, so a 2xx means the precondition changed and the
  // probe has written to real books — account 1320 no longer requiring a sub-account, say. Codex's
  // finding on PR #114: the first version reported that as DRIFT and moved on.
  const src = readFileSync(AUDIT, "utf8");
  assert.match(src, /SAFETY/);
  assert.match(src, /expected a refusal and got HTTP/);
  assert.match(src, /unexpectedWrites/);
  assert.match(src, /undo/, "a probe that can undo its own accidental write should declare how");
});

test("a status that cannot have reached the rule is INCONCLUSIVE, not DRIFT", () => {
  // 401/403/429/5xx, and a 409 once the probe date falls in a closed period — reporting any of those as
  // drift sends someone to rewrite a correct regex, which is the one thing this script must never do.
  const src = readFileSync(AUDIT, "utf8");
  assert.match(src, /UNRELATED/);
  assert.match(src, /429/);
  assert.match(src, /did not reach the rule/);
});
