import { test } from "node:test";
import assert from "node:assert/strict";
import { registeredTools } from "../dist/server.js";
import { okList } from "../dist/tools/registry.js";

/**
 * "The API returned nothing" and "the API returned something I did not expect" are
 * different answers, and only one of them means the company has no customers.
 *
 * Thirteen list tools wrote `Array.isArray(data) ? data.length : 0` and stated that number,
 * so a 200 carrying `{content: [...]}` — a shape this API already uses on `/api/leads` and
 * `/api/warehouses/inventory` — came back as "0 customer(s)" with the rows dropped. Nothing
 * was wrong on today's endpoints. The day one of them starts paginating, eight tools would
 * begin answering "there are none" about a company's customers, invoices and vouchers at
 * once, and an agent would believe them.
 *
 * The sweep below is how that was found, kept as a test so the fourteenth list tool cannot
 * reintroduce it.
 */

/** Plausible arguments for a tool, so its handler runs rather than failing validation. */
function argumentsFor(tool) {
  const args = { tenantId: 2634 };
  for (const [name, schema] of Object.entries(tool.inputSchema ?? {})) {
    if (name === "tenantId" || schema.isOptional?.()) continue;
    args[name] = /month/i.test(name)
      ? "2026-07"
      : /date/i.test(name)
        ? "2026-01-01"
        : /id$|number|count|year/i.test(name)
          ? 1
          : "1";
  }
  return args;
}

/** Run a read tool against a stubbed 200, reporting whether it consumed the body. */
async function against(tool, data) {
  let called = false;
  const ctx = {
    client: {
      request: async () => {
        called = true;
        return { data, status: 200 };
      },
      deepLink: () => "link",
    },
    config: { writeMode: "read-only", tenantId: 2634 },
    session: {},
  };
  let text;
  try {
    const result = await tool.handler(argumentsFor(tool), ctx);
    text = result.content.find((c) => c.type === "text")?.text ?? "";
  } catch {
    return { called: false, text: "" };
  }
  return { called, text };
}

const CLAIMS_EMPTINESS = /\b0 [a-z ]+\(s\)|No [a-z]+ (are|is)|is empty|Nothing /i;

/**
 * Phrasings that mean "I do not know", which is the correct answer to a shape surprise.
 *
 * A tool that says so has passed, even if the same sentence also contains a zero — the
 * reconciliation view reports "an unreported number of unmatched transaction(s)", which is
 * exactly right and would otherwise be flagged for the word "Nothing" further down.
 */
const ACKNOWLEDGES_UNKNOWN =
  /did not return a list|not known to be empty|unreported|not reported|is unknown|NOT the same as/i;

test("no read tool reports emptiness for a 200 that carried rows", async () => {
  // A wrapper shape — pagination is the obvious way for any of these endpoints to change.
  const wrapped = { content: [{ id: 1, name: "A real row" }], totalElements: 1 };
  const offenders = [];
  for (const tool of registeredTools) {
    if (tool.risk !== "read" || tool.name === "reai_request") continue;
    const { called, text } = await against(tool, wrapped);
    if (!called) continue; // never read the body; not what this sweep is about
    if (CLAIMS_EMPTINESS.test(text) && !ACKNOWLEDGES_UNKNOWN.test(text)) {
      offenders.push(`${tool.name}: ${text.split("\n")[0].slice(0, 70)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a tool told the model there is nothing, about a response that contained something",
  );
});

test("and the rows are not thrown away either", async () => {
  // Reporting the surprise is only half of it: the payload has to survive, or an operator
  // cannot see what the endpoint actually sent.
  const wrapped = { content: [{ id: 1, name: "UNIQUE-MARKER-9c1f" }], totalElements: 1 };
  const swallowed = [];
  for (const tool of registeredTools) {
    if (tool.risk !== "read" || tool.name === "reai_request") continue;
    const { called, text } = await against(tool, wrapped);
    if (!called || !text) continue;
    // Tools that deliberately project a subset (the employee list) are allowed to drop
    // fields, but must still surface the row's presence rather than pretending to none.
    if (!text.includes("UNIQUE-MARKER-9c1f") && !ACKNOWLEDGES_UNKNOWN.test(text)) {
      swallowed.push(`${tool.name}: ${text.split("\n")[0].slice(0, 70)}`);
    }
  }
  assert.deepEqual(swallowed, [], "a tool dropped the response and said nothing about it");
});

test("okList separates the three answers", () => {
  const note = (result) => result.content[0].text.split("\n")[0];

  // Empty is an answer.
  assert.match(note(okList([], { noun: "customer", suffix: "." })), /^0 customer\(s\)\./);
  assert.match(
    note(okList([], { noun: "department", empty: "No departments are defined." })),
    /No departments are defined\./,
  );
  // A list is counted.
  assert.match(note(okList([{ id: 1 }, { id: 2 }], { noun: "order", suffix: "." })), /^2 order\(s\)\./);
  // Anything else is neither, and says so — and the body survives.
  const surprise = okList({ content: [{ id: 7 }] }, { noun: "order", suffix: "." });
  assert.match(note(surprise), /did not return a list/);
  assert.match(note(surprise), /do NOT read this as "no orders"/);
  assert.match(surprise.content[0].text, /"id": 7/);
  // null and undefined are not lists either, and must not be counted as zero.
  for (const value of [null, undefined, "text", 42]) {
    assert.match(note(okList(value, { noun: "invoice", suffix: "." })), /did not return a list/);
  }
});

// The helper exists so there is ONE implementation. Hand-written variants are how three
// tools ended up with three different sentences for the same situation.
test("list tools use the shared helper rather than counting inline", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL("../src/tools/", import.meta.url);
  const inline = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    // Comments quote the bug on purpose — okList's own docstring names the shape it
    // replaced — so strip them before scanning, or the guard flags its own explanation.
    const source = readFileSync(new URL(file, dir), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // The exact shape that caused this: coerce a non-array to a count of zero.
    for (const match of source.matchAll(/Array\.isArray\([^)]*\)\s*\?\s*[^:]*\.length\s*:\s*0/g)) {
      inline.push(`${file}: ${match[0].slice(0, 60)}`);
    }
  }
  assert.deepEqual(inline, [], "use okList — counting a non-array as zero is the bug this file is about");
});
