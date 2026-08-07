// The HTTP transport had no test coverage at all: `grep -l "handleMcp\|createServer"
// test/*.mjs` matched nothing, and every finding of the transport review sat in the
// one file the suite never loaded. `src/http.ts` is a script — importing it starts a
// listener — so these drive a real process over real HTTP, which is also the only way
// to observe connection-level behaviour like a wedged keep-alive.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import net from "node:net";
import { Sealer } from "../dist/auth/crypto.js";

const KEY = randomBytes(32).toString("base64");
const sealer = Sealer.fromEnv(KEY);

let server;
let upstream;
let base;
let upstreamHits = [];

/** A stand-in for app.reai.no, so no test can reach the real API. */
function startUpstream() {
  return new Promise((resolve) => {
    upstream = createServer((req, res) => {
      upstreamHits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: 1, tenants: [{ id: 1111, name: "Test" }] }));
    });
    upstream.listen(0, "127.0.0.1", () => resolve(upstream.address().port));
  });
}

function waitForHealth(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      fetch(`${url}/health`)
        .then((r) => (r.ok ? resolve() : retry()))
        .catch(retry);
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error("server did not become healthy"));
      else setTimeout(attempt, 100);
    };
    attempt();
  });
}

before(async () => {
  const upstreamPort = await startUpstream();
  const port = 18000 + Number(process.hrtime.bigint() % 900n);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["dist/http.js"], {
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_URL: base,
      REAI_USER_API_TOKEN: "test-token",
      REAI_ENCRYPTION_KEY: KEY,
      REAI_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      REAI_WRITE_MODE: "read-only",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHealth(base);
});

after(() => {
  server?.kill("SIGKILL");
  upstream?.close();
});

/** Mint an access token the running server will accept, with whatever grant we want. */
function accessToken(grant) {
  return sealer.seal("access", { grant }, 3600);
}

const TENANTED = {
  reaiToken: "test-token",
  tenantId: 1111,
  writeMode: "read-only",
  subject: "test",
  clientId: "test-client",
  authTime: Math.floor(Date.now() / 1000),
};

function initializeBody(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  };
}

function mcpPost(body, token, extraHeaders = {}) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("an unauthenticated MCP call is refused", async () => {
  const res = await mcpPost(initializeBody());
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /Bearer/);
});

// The write mode is re-clamped per request against current config, with an explicit
// rationale — a sealed grant is unforgeable but not fresh. The tenant binding was
// never re-checked, and boundTenantId was set only when the grant carried a tenant,
// so a grant minted before the consent flow began failing closed had NO tenant
// boundary and could reach every company its ReAI token could see, for the full
// 90-day TTL, re-minted on every refresh.
test("a grant with no bound tenant is refused at redemption, not just at issuance", async () => {
  const { tenantId, ...untenanted } = TENANTED;
  assert.equal(tenantId, 1111); // the field really is absent below
  const res = await mcpPost(initializeBody(), accessToken(untenanted));
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, "invalid_token");
  assert.match(body.error_description, /no bound company/i);
});

test("a properly bound grant is accepted", async () => {
  const res = await mcpPost(initializeBody(), accessToken(TENANTED));
  assert.equal(res.status, 200);
});

// One authenticated POST with a 400 MB body OOM-killed a 192 MB container, taking
// every other in-flight request with it. /mcp bypassed the 512 KB cap the OAuth
// endpoints use because the raw stream went straight to the SDK.
test("an oversized MCP body is rejected with 413, not swallowed by the heap", async () => {
  const res = await mcpPost("x".repeat(9 * 1024 * 1024), accessToken(TENANTED));
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.error, "payload_too_large");
});

// 1000 tools/call entries in a 130 KB body produced 1000 concurrent upstream calls.
// The write policy is applied per call, so it never sees the aggregate.
test("an oversized JSON-RPC batch is rejected before anything is dispatched", async () => {
  upstreamHits = [];
  const batch = Array.from({ length: 200 }, (_, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "tools/call",
    params: { name: "reai_whoami", arguments: {} },
  }));
  const res = await mcpPost(batch, accessToken(TENANTED));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, -32600);
  assert.match(body.error.message, /exceeds the limit/);
  assert.equal(upstreamHits.length, 0, "nothing should have reached the API");
});

test("a batch within the limit is still accepted", async () => {
  const res = await mcpPost([initializeBody(1)], accessToken(TENANTED));
  assert.equal(res.status, 200);
});

// Stateless mode has no session to deliver server-initiated messages to, so the SDK's
// standalone SSE stream could never carry anything — but it stayed open with no
// server-side lifetime, and 400 concurrent held GETs consume the per-instance
// concurrency Cloud Run allows.
test("GET /mcp does not open a stream that can never carry anything", async () => {
  const res = await fetch(`${base}/mcp`, {
    method: "GET",
    headers: { Accept: "text/event-stream", Authorization: `Bearer ${accessToken(TENANTED)}` },
  });
  assert.equal(res.status, 405);
  assert.match(res.headers.get("allow") ?? "", /POST/);
  await res.text();
});

// "//evil.example/mcp" is a protocol-relative reference: new URL took the authority
// from the target, so the pathname was "/mcp". "//mcp" resolved to "/" and answered a
// POST to what the client believed was the MCP endpoint with the HTML status page.
test("a protocol-relative request target routes by path, not by its authority", async () => {
  const res = await fetch(`${base}//mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(initializeBody()),
  });
  assert.equal(res.status, 401, "should reach the MCP auth check, not the HTML status page");
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
});

test("a doubled-slash health path is not served as something else", async () => {
  const res = await fetch(`${base}//health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "ok");
});

// readBody threw out of `for await (const chunk of req)`, destroying the request
// stream mid-body; the 500 written afterwards went onto a connection whose parser
// could no longer advance. It answered nothing further and was not closed either —
// open at 45s, RST at 128s — and 100 of them cost an unauthenticated caller ~600 KB
// each. This asserts the connection is closed promptly instead.
test("an oversized body on an unauthenticated endpoint closes the connection", async () => {
  const port = Number(new URL(base).port);
  const socket = net.connect(port, "127.0.0.1");
  const closed = new Promise((resolve) => {
    socket.on("close", () => resolve("closed"));
    socket.on("error", () => resolve("closed"));
  });
  const timeout = new Promise((resolve) => setTimeout(() => resolve("still open"), 10000));

  const chunk = "a".repeat(64 * 1024);
  await new Promise((resolve) => {
    socket.write(
      "POST /token HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
        "Content-Type: application/x-www-form-urlencoded\r\n" +
        `Content-Length: ${2 * 1024 * 1024}\r\n\r\n`,
      resolve,
    );
  });
  let response = "";
  socket.on("data", (d) => (response += d.toString()));
  for (let i = 0; i < 32; i++) socket.write(chunk);

  const outcome = await Promise.race([closed, timeout]);
  socket.destroy();
  assert.equal(outcome, "closed", "the connection must not be left wedged");
  assert.match(response, /413|Connection: close/i, `unexpected response: ${response.slice(0, 200)}`);
});

test("an oversized /register body says so, rather than blaming the JSON", async () => {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://localhost/cb"], pad: "x".repeat(600 * 1024) }),
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.error, "payload_too_large");
});
