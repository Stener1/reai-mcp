import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QUIRKS } from "../dist/reai/quirks.js";
import { classifyRequest } from "../dist/policy.js";

/**
 * `scripts/audit-quirks.mjs` asks whether the quirks this server serves are still true. This keeps it
 * honest, in the two ways a live audit can quietly stop meaning anything.
 *
 * **It can drift from the text it claims to check.** The audit's `claim` is a sentence written here; the
 * thing an agent actually reads is `note` in `src/reai/quirks.ts`. Nothing stops the note being rewritten
 * to say the opposite while the probe keeps reporting OK against its own paraphrase. So each case names a
 * `marker` phrase from the note that predicts what the probe measures, and this file asserts it is still
 * there. Edit the note past that phrase and CI fails here — which is the moment claim and measurement can
 * diverge. Same relationship as `storage-drift.test.mjs`, for the same reason.
 *
 * **It can stop being able to fail.** A case whose `check` has no drift branch reports OK or INCONCLUSIVE
 * forever and adds a line to a passing report. That is the vacuous-guard failure this repository has now
 * shipped several times: a `notEnum.length <= 2` that licensed holes, sweep tests satisfiable by a literal
 * array, an `assert.equal` on a query with no read verb. So every case must contain a drift branch, and
 * comments are stripped before looking — a commented-out `"drift"` is not a drift branch, and that exact
 * trick defeated two assertions in `storage-drift.test.mjs` when PR #116 was reviewed.
 *
 * The read-only property is asserted against `classifyRequest`, the same policy code the server enforces
 * with, rather than by grepping for method names. This audit runs against tenant **2634**, real books, and
 * "it only does GETs" is the entire reason that is allowed.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIT = path.join(HERE, "..", "scripts/audit-quirks.mjs");

/**
 * Comments stripped first — see the header. Block comments, whole-line `//`, AND trailing `//`.
 *
 * The trailing case was a real hole: review of PR #128 pointed out that `return ["ok", ...]; // return
 * ["drift", ...]` satisfied `canDrift`, defeating the exact vacuous-guard protection this file claims to
 * enforce. The mutation I had tested was a whole-line comment, which the line filter caught, so the guard
 * looked verified while the cheaper version of the same trick worked.
 *
 * Stripping trailing `//` needs care, because `//` occurs inside string literals ("https://…") and inside
 * regex literals (`/[^a-z]//`). So this is a small character scanner that tracks quote and regex context
 * rather than a regex — a regex cannot know whether it is inside a string, which is how the naive version
 * would have mangled every URL in the file.
 */
function stripComments(src) {
  let out = "";
  let quote = null; // ' " ` when inside a string
  let inRegex = false;
  let inBlock = false;
  let inLine = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const next = src[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i += 1;
      } else if (c === "\n") {
        out += c; // keep line numbering usable
      }
      continue;
    }
    if (quote) {
      out += c;
      if (c === "\\") {
        out += src[i + 1] ?? "";
        i += 1;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (inRegex) {
      out += c;
      if (c === "\\") {
        out += src[i + 1] ?? "";
        i += 1;
      } else if (c === "/") {
        inRegex = false;
      } else if (c === "\n") {
        inRegex = false; // an unterminated regex cannot span lines; fail open rather than swallow the file
      }
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    // A `/` starts a regex only where a value is expected. Looking back at the last significant character
    // distinguishes `/re/` from division; this file has no division, so erring toward regex is safe.
    if (c === "/") {
      const prev = out.replace(/\s+$/, "").slice(-1);
      if (prev === "" || "(,=:[!&|?{};+".includes(prev)) {
        inRegex = true;
        out += c;
        continue;
      }
    }
    out += c;
  }
  return out;
}

function auditSource() {
  return stripComments(readFileSync(AUDIT, "utf8"));
}

/** String entries of a named array field within one case chunk. */
function arrayField(chunk, name) {
  const body = new RegExp(`${name}:\\s*\\[([\\s\\S]*?)\\]`).exec(chunk)?.[1] ?? "";
  return [...body.matchAll(/"([^"]+)"/g)].map(([, v]) => v);
}

/** The first `{...}` block after `from`, brace-matched, so a decoy declared afterwards cannot satisfy a check. */
function balancedBlockAfter(src, from) {
  const open = src.indexOf("{", from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

/** True when a concrete path instantiates a templated one: /api/annual-accounts/1997 vs /{year}. */
function instantiates(concrete, templated) {
  if (!templated.includes("{")) return false;
  const pattern = new RegExp(
    `^${templated.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]*\\\}/g, "[^/]+")}$`,
  );
  return pattern.test(concrete);
}

/**
 * Split on the case boundary and read each key independently, rather than with one multi-line regex that
 * requires a fixed key order. The review of PR #116 dropped two cases out of `storage-drift`'s population
 * by reordering keys and inserting a comment, and that test passed on the smaller set.
 */
function auditCases() {
  const src = auditSource();
  const body = src.slice(src.indexOf("const CASES = ["));
  // Split on a case boundary that does not depend on the newline after `{`. Review added a 9th case opened
  // as `  { quirk: "…",` — one line instead of two — and it was absorbed into the previous chunk: the count
  // stayed 8, all tests passed, and the audit ran a case with no marker, no drift branch, empty probes and a
  // second `conditional:`. So both the count floor and the conditional cap fell to whitespace.
  // Any indentation. `split(/\n  \{/)` bound the boundary to exactly two spaces, so review added a 17th case
  // indented FOUR and it was absorbed into its predecessor: the count stayed 16, all tests passed, and the
  // audit ran a case with no marker, no drift branch and a path its quirk is not served on. Nothing lints
  // .mjs here (`npm run lint` is `tsc --noEmit`), so indentation is free and must not be load-bearing.
  return body
    .split(/\n[ \t]*\{[ \t]*\n?/)
    .slice(1)
    .map((chunk) => ({
      quirk: /quirk:\s*"([^"]+)"/.exec(chunk)?.[1],
      claim: /claim:\s*\n?\s*"([^"]+)"/.exec(chunk)?.[1],
      marker: (/marker:\s*"((?:[^"\\]|\\.)+)"/.exec(chunk) ?? /marker:\s*'([^']+)'/.exec(chunk))?.[1]?.replace(
        /\\"/g,
        '"',
      ),
      // The branch that makes the case able to fail at all.
      canDrift: /return\s*\[\s*"drift"/.test(chunk) || /\[\s*\n?\s*"drift"/.test(chunk),
      conditional: (/conditional:\s*"((?:[^"\\]|\\.)+)"/.exec(chunk) ?? /conditional:\s*'([^']+)'/.exec(chunk))?.[1],
      // Declared concrete endpoints. Read from the `probes` array so the coverage check below compares
      // against the quirk's own `paths` rather than against whatever the check() body happens to fetch.
      probes: arrayField(chunk, "probes"),
      // Operations the claim deliberately does NOT hold for, and families represented by one concrete probe.
      exceptions: arrayField(chunk, "exceptions"),
      samples: arrayField(chunk, "samples"),
      // path -> reason. Served but unanswerable by a GET, which is NOT the same as the claim being false
      // there; conflating the two would force a note to assert something untrue.
      unmeasured: Object.fromEntries(
        [...(/unmeasured:\s*\{([\s\S]*?)\n {4}\}/.exec(chunk)?.[1] ?? "").matchAll(
          /"([^"]+)":\s*\n?\s*"([^"]+)"/g,
        )].map(([, k, v]) => [k, v]),
      ),
      chunk,
    }))
    .filter((c) => c.quirk);
}

test("every quirk probe names a real quirk, and binds to text that still PREDICTS what it measures", () => {
  const cases = auditCases();
  // The count itself is the floor. A "6 of 8" style threshold licenses two cases silently falling out of
  // the population, which is how `storage-drift` was defeated; removing a case on purpose is a
  // one-character edit here.
  // Cross-checked against an independent count of `quirk:` keys, so a case the boundary split misses still
  // shows up as a mismatch rather than silently vanishing.
  const quirkKeys = [...auditSource().slice(auditSource().indexOf("const CASES = [")).matchAll(/^\s*quirk:\s*"/gm)];
  assert.equal(
    cases.length,
    quirkKeys.length,
    `extracted ${cases.length} cases but found ${quirkKeys.length} \`quirk:\` keys — the boundary split is ` +
      `missing a case, which is how a 17th one hid inside its predecessor`,
  );
  assert.equal(
    cases.length,
    16,
    `expected 16 quirk cases, extracted ${cases.length} — either a case was added without updating this ` +
      `number, or the extraction has stopped matching`,
  );

  const byId = new Map(QUIRKS.map((q) => [q.id, q]));
  for (const { quirk, claim, marker } of cases) {
    const q = byId.get(quirk);
    assert.ok(q, `the audit probes "${quirk}", which is not a quirk id in src/reai/quirks.ts`);
    assert.ok(claim, `${quirk} declares no claim`);
    assert.ok(marker, `${quirk} declares no marker phrase from its note`);
    // Long enough to bind something. `marker: "e"` and `marker: " "` both satisfied a naive version of
    // the equivalent assertion in storage-drift.
    assert.ok(
      marker.length >= 12,
      `${quirk} has marker ${JSON.stringify(marker)}, too short to bind anything — use a phrase`,
    );
    assert.ok(
      q.note.includes(marker),
      `${quirk}: the note no longer contains ${JSON.stringify(marker)}. The probe measures something the ` +
        `note may no longer claim — re-read both before editing this test.`,
    );
    // A marker must be a claim, not a fragment. Review bound thirteen characters by splitting the string
    // ("Omitting them" + " returns …"), and a marker that survives any rewrite binds nothing.
    assert.ok(
      /\s/.test(marker.trim()) && marker.trim().split(/\s+/).length >= 3,
      `${quirk}'s marker ${JSON.stringify(marker)} is too fragmentary — bind a phrase that states the claim`,
    );
  }
});

test("every quirk probe can report drift, and its comparisons are not tautologies", () => {
  const cases = auditCases();
  const offenders = cases.filter((c) => !c.canDrift);
  assert.deepEqual(
    offenders.map((c) => c.quirk),
    [],
    "these have no drift branch, so they can only ever report OK or INCONCLUSIVE and are decoration",
  );

  // What the check above CANNOT do, stated because an earlier version of this comment claimed it stopped
  // cases that "can only return OK or INCONCLUSIVE". It is a text search: it sees a drift branch, not whether
  // anything can reach it. Review neutered two cases with the branch left intact — `sameKeys(got, got)`, and
  // widening a regex to `/[\s\S]*/` — and all tests passed. A static test cannot decide reachability in
  // general, so it does not pretend to. What it can do is reject the specific tautologies that produce it:
  for (const c of cases) {
    assert.doesNotMatch(
      c.chunk,
      /sameKeys\(\s*(\w+)\s*,\s*\1\s*\)/,
      `${c.quirk} compares a value with itself, which can never fail`,
    );
    // A regex that matches everything, in a case that decides drift by matching one.
    assert.doesNotMatch(
      c.chunk,
      /\/(\[\\s\\S\]|\.)\*\/(?![a-z]*\.exec)/,
      `${c.quirk} tests against a catch-all pattern, so its text comparison cannot fail`,
    );
    // Every shape claim must compare against a literal list, not against keys read from the response.
    const shapeCompares = [...c.chunk.matchAll(/sameKeys\(\s*(\w+)\s*,\s*([^)]+)\)/g)];
    for (const [, , expected] of shapeCompares) {
      assert.match(
        expected.trim(),
        /^\[|^expected$/,
        `${c.quirk} compares keys against ${expected.trim()}, which must be a literal list (or the loop's ` +
          `\`expected\`) so the assertion cannot be built from the response`,
      );
    }
  }
});

/**
 * The read-only property, checked from the AST rather than from patterns.
 *
 * Three review rounds each defeated a text-level version of this test, and the third one named the reason:
 * every check was a regex over source text, so any indirection across statements sailed through. The bypasses
 * were not exotic —
 *
 *   `...EXTRA` spread over `method: "GET"`            → real POSTs, 9/9 green
 *   `init.method = "POST"` after the check            → real POSTs, 10/10 green
 *   `import http from "node:http"`                    → real PUT,  10/10 green
 *   `import * as x from 'node:http'` (single quotes)   → real PUT,  10/10 green
 *   `nativeFetch(...)` (case-sensitive /fetch\(/)      → real POST, 10/10 green
 *   `const raw = fetch;` placed ABOVE the guard IIFE  → real POST, 10/10 green
 *   `const N = ["node","http"].join(":"); import(N)`  → real PUT,  10/10 green
 *
 * The last two are the general form: name the unguarded function without writing `globalThis.fetch`, or build a
 * forbidden module specifier before the `import()` call. No pattern over one line can see either.
 *
 * So this parses the file with the TypeScript compiler (already a devDependency, used by `npm run lint`) and
 * asks structural questions instead. `const raw = fetch` is a VariableDeclaration whose initializer is the
 * identifier `fetch`; `import(N)` is a CallExpression whose argument is an Identifier rather than a string.
 * Both are exact, not heuristic.
 *
 * ## What this still does not do, stated because the prose here has overclaimed twice
 *
 * It constrains the file **as committed**. It cannot stop a determined rewrite: `node:net` sockets, a
 * hand-rolled `http.ClientRequest`, `createRequire`. Monkey-patching the http module was tried and does not
 * close it either — patching `.default.request` is invisible through the NAMED export
 * (`const { request } = await import("node:http")` gets the original binding), which is exactly what the
 * working bypass destructured.
 *
 * The honest claim is therefore narrower than "read-only is enforced": **no accidental or casual edit can make
 * this file write, and CI proves the committed text has no second network path.** Defeating it now requires
 * deliberately writing an HTTP client to defeat a guard, which is no longer a mistake someone makes while
 * adding a probe. That is the property worth having for a script pointed at a real company's books, and the
 * runtime wrapper below is what covers the case the AST cannot see.
 */
test("the quirk audit is read-only, checked from the AST rather than from patterns", async () => {
  const { default: ts } = await import("typescript");
  const text = readFileSync(AUDIT, "utf8");
  const sf = ts.createSourceFile(AUDIT, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);

  // The guard-installing IIFE is the one place allowed to name the unguarded function. Locate it by position
  // so everything else can be judged as "outside it".
  const guard = { start: -1, end: -1 };
  const findGuard = (n) => {
    if (
      ts.isExpressionStatement(n) &&
      ts.isCallExpression(n.expression) &&
      (ts.isArrowFunction(n.expression.expression) || ts.isParenthesizedExpression(n.expression.expression)) &&
      /globalThis\.fetch\s*=/.test(n.getText(sf))
    ) {
      guard.start = n.getStart(sf);
      guard.end = n.getEnd();
    }
    ts.forEachChild(n, findGuard);
  };
  findGuard(sf);
  assert.ok(guard.start >= 0, "the guard-installing IIFE was not found");

  // FIRST executable statement. `const raw = fetch` above the IIFE captured the native function and delivered a
  // POST; ordering closes that by construction, since anything captured afterwards is the wrapper.
  const firstExecutable = sf.statements.find((st) => !ts.isImportDeclaration(st));
  assert.equal(
    firstExecutable?.getStart(sf),
    guard.start,
    "the fetch guard must be the first executable statement, or there is a window in which the native " +
      "function can be captured under another name",
  );

  const outside = (n) => n.getStart(sf) < guard.start || n.getEnd() > guard.end;
  const problems = [];
  const dynamicImports = [];
  let bareFetchCalls = 0;

  const walk = (n) => {
    // Any binding that captures fetch, however it is spelled: `= fetch`, `= globalThis.fetch`,
    // `= globalThis["fetch"]`, `{ fetch: alias } = globalThis`.
    if (outside(n)) {
      if (ts.isIdentifier(n) && n.text === "globalThis") {
        problems.push(`\`globalThis\` is referenced outside the guard at line ${line(n)} — the only legitimate ` +
          `use is installing the wrapper, and every bypass so far went through a handle on it`);
      }
      if (ts.isIdentifier(n) && n.text === "fetch") {
        const parent = n.parent;
        const isCallee = ts.isCallExpression(parent) && parent.expression === n;
        if (!isCallee) {
          problems.push(`the identifier \`fetch\` appears at line ${line(n)} somewhere other than as a call — ` +
            `capturing it under another name is how the guard was bypassed`);
        } else {
          bareFetchCalls += 1;
        }
      }
      // require / createRequire / process.binding are other ways to a socket.
      if (ts.isIdentifier(n) && ["require", "createRequire"].includes(n.text)) {
        problems.push(`\`${n.text}\` at line ${line(n)} can load a network module outside the import checks`);
      }
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      dynamicImports.push(n.arguments[0]);
    }
    ts.forEachChild(n, walk);
  };
  function line(n) {
    return sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  }
  walk(sf);

  assert.deepEqual(problems, [], `read-only violations:\n${problems.join("\n")}`);
  assert.equal(
    bareFetchCalls,
    1,
    `expected exactly one call to \`fetch\` outside the guard, found ${bareFetchCalls}`,
  );

  // Static imports: an allowlist, from the AST, so quote style and `import x from` vs bare `import "…"` are
  // irrelevant — a single-quoted namespace import defeated the regex version and issued a real PUT.
  // node:fs is permitted because it cannot reach the network; it reads the pinned OpenAPI document.
  const allowed = new Set(["node:url", "node:path", "node:fs"]);
  const staticSpecs = sf.statements
    .filter(ts.isImportDeclaration)
    .map((d) => d.moduleSpecifier.text);
  assert.deepEqual(
    staticSpecs.filter((m) => !allowed.has(m)),
    [],
    `this audit may only import ${[...allowed].join(", ")} — node:http, node:https and node:net reach the ` +
      `network without passing the fetch wrapper`,
  );

  // Dynamic imports must be a plain string literal, or pathToFileURL(...) for a dist/ module. An Identifier is
  // refused outright: `const N = ["node","http"].join(":"); await import(N)` is a working bypass that no
  // inspection of the argument TEXT can catch.
  for (const arg of dynamicImports) {
    if (ts.isStringLiteral(arg)) {
      assert.doesNotMatch(
        arg.text,
        /^node:(http|https|net|dgram|tls)/,
        `dynamic import of ${arg.text} bypasses the fetch wrapper`,
      );
      continue;
    }
    // `pathToFileURL(join(process.cwd(), "dist/…")).href` — a property access on the call, which is the form
    // actually used. The check is on the whole expression being rooted at pathToFileURL, so an identifier or
    // any assembled string still fails.
    const rooted = arg.getText(sf).startsWith("pathToFileURL(");
    const viaPathToFileUrl =
      rooted && /^pathToFileURL\(join\(process\.cwd\(\), "dist\/[a-z/.-]+"\)\)(\.href)?$/.test(arg.getText(sf));
    assert.ok(
      viaPathToFileUrl,
      `the dynamic import at line ${line(arg)} takes ${ts.SyntaxKind[arg.kind]} \`${arg.getText(sf)}\` — only a ` +
        `string literal or pathToFileURL(...) is allowed, because a specifier assembled at runtime cannot be ` +
        `checked at all`,
    );
  }

  // The runtime layer, which is what covers the paths the AST cannot see.
  const src = auditSource();
  assert.match(
    src,
    /if \(init\.method !== "GET"\)[\s\S]{0,200}throw new Error/,
    "the request helper must check the assembled init object at runtime and throw on any non-GET",
  );
  assert.match(
    src,
    /Object\.freeze\(init\);\n\s*const res = await fetch/,
    "the init object must be frozen between the check and the fetch, or the check can be undone after it",
  );
  const wrapperBody = balancedBlockAfter(text, text.indexOf("=>", text.indexOf("globalThis.fetch =")));
  assert.match(
    wrapperBody ?? "",
    /method\.toUpperCase\(\) !== "GET"[\s\S]{0,200}throw new Error/,
    "the function assigned to globalThis.fetch must itself reject any non-GET",
  );

  // And the stakes, which is the honest use of classifyRequest: `classifyRequest("GET", …)` returns "read" for
  // every path by an early return in policy.ts, so asserting that could not fail. What it can show is that
  // these paths are destructive under a write verb, which is why the guard exists.
  const paths = [
    ...new Set([
      ...[...src.matchAll(/probes:\s*\[([\s\S]*?)\]/g)].flatMap(([, body]) =>
        [...body.matchAll(/"(\/api\/[^"]+)"/g)].map(([, v]) => v),
      ),
      ...[...src.matchAll(/get\(\s*[`"](\/api\/[^`"?]*)/g)].map(([, v]) => v),
    ]),
  ];
  assert.ok(paths.length >= 24, `only ${paths.length} requests extracted — the extraction has stopped matching`);
  const dangerous = paths.filter((pth) => {
    const concrete = pth.replace(/\$\{[^}]*\}/g, "7");
    return ["POST", "PUT", "PATCH", "DELETE"].some((m) => classifyRequest(m, concrete) === "irreversible");
  });
  assert.ok(
    dangerous.length >= 5,
    `expected several audited paths to be irreversible under a write verb (found ${dangerous.length})`,
  );

  // Read-only is why there is no write guard, so the absence has to be deliberate rather than forgotten.
  assert.doesNotMatch(src, /REAI_WRITE_TEST_TENANTS/, "a read-only audit must not consult the write guard");
});

test("probes that depend on validation ORDER send a full request", () => {
  // Pinned because it is the exact mistake made while writing this audit, and it produced a false DRIFT
  // against a correct quirk. `/api/timesheets?projectId=1` returns "startDate is required": the date
  // validator runs first, so the response says nothing about the module the claim is about.
  const cases = auditCases();
  const timesheets = cases.find((c) => c.quirk === "timesheets-need-project-module");
  assert.ok(timesheets, "the timesheets case has gone missing");
  assert.match(
    timesheets.chunk,
    /projectId=1&\$\{DATES\}/,
    "the timesheets probe must send the date range too, or it measures the date validator instead of the " +
      "module check and reports a correct quirk as drift",
  );
  // The claim is two-sided ("required AND rejected"), so both halves must be probed.
  assert.match(timesheets.chunk, /projectid is required/i, "it must also verify projectId is required");
});

test("shape probes compare the whole wrapper, not just the keys they hope for", () => {
  // `keys.includes("items")` passes on a wrapper that has grown three paging fields, and these claims are
  // specifically about which fields are present — the hazard is an agent assuming the wrong shape.
  const src = auditSource();
  // Not `assert.match(src, /const sameKeys =/)`. Review rewrote the helper to a one-directional
  // `want.every(k => got.includes(k))` — a subset check that passes on a wrapper which has grown three
  // paging fields — and the name assertion still matched. A name is not a semantics check, which is the exact
  // vacuous-guard shape this file exists to prevent, so the implementation is exercised instead.
  const helper = /const sameKeys = ([\s\S]*?);\n/.exec(src)?.[1];
  assert.ok(helper, "the exact-shape helper must be present");
  // eslint-disable-next-line no-new-func -- deliberately evaluating the shipped expression, not user input
  const sameKeys = new Function(`return (${helper});`)();
  assert.equal(sameKeys(["a", "b"], ["a", "b"]), true, "identical key sets must compare equal");
  assert.equal(sameKeys(["b", "a"], ["a", "b"]), true, "order must not matter");
  assert.equal(
    sameKeys(["a", "b", "page"], ["a", "b"]),
    false,
    "an EXTRA key must not compare equal — a subset check passes on a wrapper that has grown paging fields, " +
      "which is precisely the drift these shape claims are about",
  );
  assert.equal(sameKeys(["a"], ["a", "b"]), false, "a missing key must not compare equal");
  for (const quirk of ["leads-paginated-object", "person-role-matches-shape", "warehouse-inventory-object"]) {
    const c = auditCases().find((x) => x.quirk === quirk);
    assert.ok(c, `${quirk} case is missing`);
    assert.match(c.chunk, /sameKeys\(/, `${quirk} must compare the full key set`);
  }
});

test("the audited quirks are a documented subset, not a claim of coverage", () => {
  // 8 of 122. The number in the report has to be honest about that, because "the quirk audit passes" is
  // otherwise read as "the quirks are verified" — the same over-claim `storage-drift` was corrected for.
  const src = readFileSync(AUDIT, "utf8");
  assert.match(src, /QUIRKS\.length/, "the report must print the total, not only the probed count");
  assert.match(
    src,
    /the subset a GET can answer/,
    "the report must say the probed set is a subset and why",
  );
  // And the distinct-quirk arithmetic, which has now been wrong three times — including once where the docs
  // were corrected and this script's header was not, so the same tree stated both 8/113 and 17/105.
  assert.match(src, /have a live case across all three audits/, "the report must state how many quirks are covered in total");
  assert.ok(QUIRKS.length > 100, `sanity: expected >100 quirks, found ${QUIRKS.length}`);
});

test("an unverifiable claim fails the run unless it says WHY it cannot be verified", () => {
  // `audit-storage.mjs` exits 3 on inconclusive, for the reason docs/development.md records: "a claim
  // nobody checked is not a claim that held". This audit adopts that — but one case is unanswerable by
  // construction rather than by accident (the tenant-header claim needs a single-tenant token; ours reaches
  // four), and a gate that fails forever is a gate everyone learns to ignore. So the escape hatch exists
  // and is narrow: declare `conditional:` with the reason, in the file, where review can see it.
  const src = auditSource();
  assert.match(src, /process\.exit\(3\)/, "an unexpected inconclusive must exit 3, as the storage audit does");
  assert.match(
    src,
    /!c\.conditional/,
    "the exit status must ignore only the cases that declare themselves conditional",
  );

  for (const c of auditCases().filter((x) => x.conditional)) {
    // A reason, not a shrug. This is the field that suppresses a failure, so it is the field most worth
    // making expensive to add.
    assert.ok(
      c.conditional.length >= 20,
      `${c.quirk} declares conditional: ${JSON.stringify(c.conditional)} — say what would answer it`,
    );
    // Against `c.conditional`, not `c.chunk`. Review passed a reason of
    // "aaaaaaaaaaaaaaaaaaaaaaaa" because the pattern was matched against the whole case body, which
    // contains "cannot be tested from here" — as almost every chunk does.
    assert.match(
      c.conditional,
      /\bneeds\b|\brequires\b|\bwithout\b|\bwhere it is\b/i,
      `${c.quirk}'s conditional reason must name the missing precondition, got ${JSON.stringify(c.conditional)}`,
    );
  }

  // The cap used to be one. Review showed that made the audit exit 3 on any tenant with the Project, Leads
  // or Warehouse module in the opposite state — several of these claims are ABOUT a module being off, and are
  // genuinely unanswerable where it is on, with no way to say so. Scarcity was the wrong control.
  //
  // What is controlled instead: a declared reason cannot be reached by a branch that merely failed to get an
  // answer (the audit downgrades an undeclared "conditional" to inconclusive), the reason must name its
  // precondition, and a case may not be conditional in EVERY branch — something must still be able to pass.
  const cases = auditCases();
  const conditional = cases.filter((c) => c.conditional);
  assert.ok(
    conditional.length < cases.length,
    "every case is conditional, so a clean run would assert nothing at all",
  );
  for (const c of conditional) {
    // Against the comment-stripped chunk. Broadening this pattern to accept a ternary's else-arm made it read
    // RAW source, so commenting out a conditional case's only `return ["ok", …]` left the literal in a comment
    // and the guard still passed — the exact failure this file strips comments for elsewhere.
    // Anchored on `return` or a ternary arm. Dropping the anchor to accept an else-arm made a bare STRING
    // literal satisfy it — review replaced a case's only OK return with
    // `return ["conditional", 'the literal ["ok"] in this string is all the guard sees']` and it passed.
    // stripComments does not help, because it preserves string contents.
    assert.match(
      stripComments(c.chunk),
      /(?:return|[?:])\s*\[\s*\n?\s*"ok"/,
      `${c.quirk} declares itself conditional but has no branch that can report OK, so it can never verify ` +
        `anything on any tenant`,
    );
  }
});

test("every case probes every OPERATION its quirk is served on, or names why not", async () => {
  // The fragment problem, and this file's own history twice over.
  //
  // First version: `date-range-required` was verified on /api/vouchers while `quirksFor()` also serves it for
  // /api/postings and the /api/ledger family. Second version compared `probes` against `q.paths` — three
  // entries — and called that coverage. Review pointed out the quirk carries `match: "descendants"`, so it is
  // actually served on FOURTEEN operations, and the ones it is FALSE on (/api/vouchers/{id},
  // /api/postings/groups) were still unprobed and still asserted to agents. The test was named for a property
  // it did not check.
  //
  // So ask the registry the same question the server asks: which operations would receive this quirk? Then
  // every GET among them must be probed, sampled under a declared prefix, or listed as an exception whose
  // reason appears in the note. Non-GET operations are exempt by construction — a read-only audit cannot
  // probe a POST — and are counted rather than quietly dropped.
  const { quirkMatches } = await import("../dist/reai/quirks.js");
  const { getSpecIndex } = await import("../dist/reai/spec.js");
  const operations = getSpecIndex().operations;

  const byId = new Map(QUIRKS.map((q) => [q.id, q]));
  const gaps = [];
  const census = [];
  for (const c of auditCases()) {
    const q = byId.get(c.quirk);
    assert.ok(q, `${c.quirk} is not a known quirk`);
    assert.ok(c.probes.length > 0, `${c.quirk} declares no probes`);

    const served = operations.filter((op) => quirkMatches(q, op.method, op.path));
    assert.ok(served.length > 0, `${c.quirk} is served on no operation at all — is its path list stale?`);

    // `samples` was the ungated hatch, and strictly more powerful than the gated `exceptions`: review
    // silenced four named gaps by adding "/api/customers" to it, and `samples: ["/api"]` covered every served
    // GET of every case. Worse, in the shipped shape, dropping /api/ledger/general from `probes` left the
    // census reporting "2 probed, 9 sampled, 0 gaps" while the audit touched no ledger endpoint at all.
    //
    // A sample is a family REPRESENTED BY A PROBE, so it must be a path the quirk actually declares and it
    // must contain at least one probe. Both conditions are what make "sampled" mean anything.
    for (const prefix of c.samples) {
      assert.ok(
        q.paths.includes(prefix),
        `${c.quirk} samples ${prefix}, which is not one of the paths the quirk declares (${q.paths.join(", ")})`,
      );
      assert.ok(
        c.probes.some((probe) => probe === prefix || probe.startsWith(`${prefix}/`)),
        `${c.quirk} samples ${prefix} but probes nothing beneath it, so that family is not sampled — it is ` +
          `simply unchecked`,
      );
    }

    // The reverse direction, which the census dropped. 4c77c66 asserted probes ⊆ q.paths; replacing it with
    // the served-operations census left padding unchecked, so "/api/customers" could be added to `probes` and
    // the audit would issue live GETs asserting a claim on an operation the quirk is not served on.
    for (const probe of c.probes) {
      assert.ok(
        served.some((op) => op.method === "GET" && (op.path === probe || instantiates(probe, op.path))),
        `${c.quirk} probes ${probe}, which is not a GET operation this quirk is served on — the result would ` +
          `describe something the quirk never claimed`,
      );
    }

    const gettable = served.filter((op) => op.method === "GET");
    const skipped = served.length - gettable.length;
    let probed = 0;
    let sampled = 0;
    let unmeasured = 0;
    for (const op of gettable) {
      // Exact, or a template the probe instantiates (/api/annual-accounts/{year} needs a concrete year).
      const exact = c.probes.some((probe) => probe === op.path || instantiates(probe, op.path));
      if (exact) {
        probed += 1;
        continue;
      }
      const underSample = c.samples.some((prefix) => op.path === prefix || op.path.startsWith(`${prefix}/`));
      if (underSample) {
        sampled += 1;
        continue;
      }

      if (c.exceptions.some((ex) => ex === op.path)) continue;
      if (op.path in c.unmeasured) {
        unmeasured += 1;
        continue;
      }
      gaps.push(
        `${c.quirk} is served on GET ${op.path}, which is neither probed, sampled, excepted nor declared ` +
          `unmeasured`,
      );
    }
    census.push(
      `${c.quirk}: ${served.length} served, ${probed} probed, ${sampled} sampled, ` +
        `${c.exceptions.length} excepted, ${unmeasured} unmeasured, ${skipped} non-GET`,
    );

    // `unmeasured` is the third hatch, so it gets the same treatment as the other two: a reason that says
    // what is missing, and it may not swallow the whole case. `exceptions` earned its note requirement by
    // asserting the claim is false somewhere; this one asserts only that a GET cannot reach it, which is a
    // statement about the audit rather than about the API, so the reason lives in the script and not in a
    // note an agent reads.
    for (const [path, why] of Object.entries(c.unmeasured)) {
      assert.ok(
        gettable.some((op) => op.path === path),
        `${c.quirk} declares ${path} unmeasured, but the quirk is not served on that GET operation`,
      );
      // The premise, not just a sentence. `unmeasured` claims no GET can REACH the claim, and review moved a
      // plainly reachable collection path (/api/postings) into it with the reason "needs nothing whatsoever;
      // a plain GET reaches it" — 10/10 green, and the audit silently stopped requesting it. A collection path
      // is always reachable; only a path needing an identifier this audit cannot obtain is not.
      assert.match(
        path,
        /\{[^}]+\}/,
        `${c.quirk} declares ${path} unmeasured, but it takes no path parameter — a GET can reach it, so it ` +
          `must be probed rather than excused`,
      );
      assert.ok(
        why.length >= 20 && /needs|requires|cannot|write/i.test(why),
        `${c.quirk}'s reason for not measuring ${path} must say what is missing, got ${JSON.stringify(why)}`,
      );
      // Padding defeats a keyword-plus-length rule: "needs aaaaaaaaaaaaaaaaaaaaaaaa" satisfied both. Require
      // real words, the same shape of check the conditional reason needed.
      const words = why.split(/\s+/).filter((w) => /^[a-z][a-z-]{2,}$/i.test(w));
      assert.ok(
        new Set(words).size >= 6,
        `${c.quirk}'s reason for not measuring ${path} reads as padding (${new Set(words).size} distinct ` +
          `words): ${JSON.stringify(why)}`,
      );
    }
    assert.ok(
      Object.keys(c.unmeasured).length < Math.max(gettable.length, 1),
      `${c.quirk} declares every one of its GET operations unmeasured, so the case verifies nothing`,
    );
  }
  assert.deepEqual(gaps, [], `quirks asserted to agents on operations the audit never checks:\n${gaps.join("\n")}`);
  // Printed, not asserted: a coverage number pinned in a test becomes a number nobody reads.
  console.log(`  coverage:\n    ${census.join("\n    ")}`);
});

test("an exception must be justified in the note the agent reads", () => {
  // `exceptions` is the field that removes an operation from the coverage requirement, so it is the one worth
  // making expensive. A path where the claim does not hold is not a testing detail — it is something the
  // agent needs to know, because the quirk is served there anyway. So the note must name it.
  const byId = new Map(QUIRKS.map((q) => [q.id, q]));
  for (const c of auditCases()) {
    for (const path of c.exceptions) {
      const note = byId.get(c.quirk).note;
      // The LITERAL path, templated braces included. The first version also accepted the last two
      // non-template segments, so `/api/vouchers/{id}` was satisfied by any note mentioning `/api/vouchers` —
      // and review passed a note asserting the OPPOSITE ("on /api/vouchers the range IS required, for the
      // collection and for a single voucher alike") while keeping the exception. For one-segment-deep
      // sub-resources, which is most of them, the tail was the parent collection.
      assert.ok(
        note.includes(path),
        `${c.quirk} excepts ${path}, but its note never names that exact path — an agent describing that ` +
          `operation still receives the quirk, so silence there is misinformation, not a gap in a test. ` +
          `Write the path literally, ${path}, so a note about the parent cannot stand in for it.`,
      );
    }
  }
});

test("a case that declares many probes actually requests them all", () => {
  // `probes` is metadata; the guard above compares metadata to metadata. If check() ignores it, the
  // coverage claim is decoration. The two multi-path cases iterate `this.probes`, so the request set and
  // the declared set are the same object by construction — assert that rather than trusting it.
  for (const quirk of ["date-range-required", "module-gating"]) {
    const c = auditCases().find((x) => x.quirk === quirk);
    assert.ok(c, `${quirk} case is missing`);
    assert.match(
      c.chunk,
      /for \(const path of this\.probes\)/,
      `${quirk} must iterate this.probes, or its declared coverage is not what it requests`,
    );
    // Presence is not enough. `date-range-required` has TWO loops over this.probes — one for the schema
    // half, one for the live half — and hardcoding either shrinks coverage while the assertion above still
    // matches on the other. That mutation passed, so the rule is that NO loop in these cases may iterate a
    // literal path list.
    assert.doesNotMatch(
      c.chunk,
      /for \(const \w+ of \s*\[/,
      `${quirk} iterates a literal array somewhere; every path loop must go through this.probes so the ` +
        `declared coverage is what actually gets requested`,
    );
  }
});
