import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRequest, classifyWithBody, classifyTransmission, isAllowed, WRITE_MODES } from "../dist/policy.js";
import { allTools } from "../dist/server.js";

/**
 * A safety invariant for verification scripts, not for the server itself.
 *
 * `scripts/smoke-http.mjs` checks that a deployment refuses to transmit, and the
 * only honest way to check that is to attempt the transmitting paths and see them
 * refused. That is safe exactly as long as they really are refused — on a
 * deployment where they are not, the attempt IS the send: an EHF invoice over
 * Peppol, an email to a customer, a tax return filed with Skatteetaten. None of
 * those can be recalled.
 *
 * The script therefore reads the deployment's posture from `tools/list` first,
 * which sends nothing, and skips the probe when a transmitting tool is visible.
 * That is only sound if a visible transmitting tool is a reliable signal — which
 * is what these tests pin down. The first version of that check had this wrong in
 * the other direction (it probed first and warned afterwards), so this is
 * asserted rather than assumed.
 */

/** Mirrors the list in scripts/smoke-http.mjs. */
const TRANSMITTING_TOOLS = ["reai_create_invoice_from_order", "reai_credit_invoice"];

/** Mirrors the paths that script probes. */
const PROBED = [
  { method: "POST", path: "/api/invoices/1/ehf", body: {} },
  { method: "POST", path: "/api/invoices/1/email", body: { email: "x@example.invalid" } },
  { method: "POST", path: "/api/peppol/messages/sendsbdh", body: {} },
  { method: "POST", path: "/api/tax-returns/2026/submit", body: {} },
  { method: "POST", path: "/api/orders", body: { customerId: 1, sendEhf: true, orderLines: [] } },
];

const riskOf = (p) => classifyWithBody(classifyRequest(p.method, p.path), p.body);

test("the tools the script watches for are really marked as transmitting", () => {
  // If a tool were renamed or its `transmits` flag dropped, the script's posture
  // check would silently stop detecting an unsafe deployment.
  for (const name of TRANSMITTING_TOOLS) {
    const tool = allTools.find((t) => t.name === name);
    assert.ok(tool, `${name} should exist — smoke-http.mjs watches for it by name`);
    assert.equal(tool.transmits, true, `${name} must be marked transmits: true`);
  }
});

test("every tool marked transmitting is on the script's watch list", () => {
  // The reverse direction: a NEW transmitting tool would become visible on a
  // send-enabled deployment without the script noticing, so the probe would run
  // when it should have been skipped.
  const marked = allTools.filter((t) => t.transmits === true).map((t) => t.name).sort();
  assert.deepEqual(
    marked,
    [...TRANSMITTING_TOOLS].sort(),
    "add any new transmitting tool to TRANSMITTING_TOOLS in scripts/smoke-http.mjs",
  );
});

test("every probed path is classified irreversible", () => {
  // This is what makes the probe safe below `full` mode: the write policy refuses
  // these before a request is ever built, regardless of the external-send switch.
  for (const p of PROBED) {
    assert.equal(
      riskOf(p),
      "irreversible",
      `${p.method} ${p.path} must classify irreversible, or the probe could reach the network`,
    );
  }
});

test("every probed path is recognised as transmitting", () => {
  for (const p of PROBED) {
    assert.notEqual(
      classifyTransmission(p.method, p.path, p.body),
      "none",
      `${p.method} ${p.path} should be recognised as transmitting`,
    );
  }
});

test("no configuration lets a probed path through while tools/list looks safe", () => {
  // The actual invariant. For every (write mode x external send) combination:
  // either the probe is refused by policy, or a transmitting tool is visible so
  // the script skips the probe. There must be no configuration that is both
  // permissive and undetectable.
  for (const mode of WRITE_MODES) {
    for (const allowExternalSend of [false, true]) {
      const transmittersVisible = allTools.some(
        (t) => t.transmits === true && isAllowed(t.risk, mode) && allowExternalSend,
      );

      for (const p of PROBED) {
        const risk = riskOf(p);
        const refusedByWriteMode = !isAllowed(risk, mode);
        const refusedByExternalSend =
          !allowExternalSend && classifyTransmission(p.method, p.path, p.body) !== "none";
        const refused = refusedByWriteMode || refusedByExternalSend;

        assert.ok(
          refused || transmittersVisible,
          `${mode} + externalSend=${allowExternalSend}: ${p.method} ${p.path} would be sent, ` +
            "and tools/list gives no warning — smoke-http.mjs would transmit for real",
        );
      }
    }
  }
});

test("the one dangerous configuration is exactly full + external send", () => {
  // Pinning which combination triggers the skip, so a change to tool gating that
  // widened it would fail here rather than in production.
  const dangerous = [];
  for (const mode of WRITE_MODES) {
    for (const allowExternalSend of [false, true]) {
      const anyAllowed = PROBED.some((p) => {
        const risk = riskOf(p);
        const byMode = !isAllowed(risk, mode);
        const bySend = !allowExternalSend && classifyTransmission(p.method, p.path, p.body) !== "none";
        return !(byMode || bySend);
      });
      if (anyAllowed) dangerous.push(`${mode}+${allowExternalSend}`);
    }
  }
  assert.deepEqual(dangerous, ["full+true"]);
});
