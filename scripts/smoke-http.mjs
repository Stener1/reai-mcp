#!/usr/bin/env node
/**
 * End-to-end verification of a remote (connector) deployment.
 *
 * Walks the whole OAuth 2.1 flow exactly as an MCP client does — discovery,
 * dynamic client registration, authorization with PKCE, token exchange — then
 * connects over Streamable HTTP and calls read-only tools.
 *
 * Usage:
 *   REAI_USER_API_TOKEN=... node scripts/smoke-http.mjs --url http://localhost:8080
 *
 * The one thing a script cannot do is click the consent page, so it posts the
 * form the way a browser would. Everything else is the real protocol.
 */
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const BASE = (arg("url", "http://localhost:8080") ?? "").replace(/\/+$/, "");
const REDIRECT_URI = "http://localhost:6274/callback";
const token = process.env.REAI_USER_API_TOKEN ?? process.env.REAI_TOKEN;
const tenantArg = arg("tenant");

if (!token) {
  console.error("REAI_USER_API_TOKEN is not set.");
  process.exit(2);
}

let passed = 0;
let failed = 0;
function report(name, okFlag, detail) {
  if (okFlag) passed++;
  else failed++;
  console.log(`  [${okFlag ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const textOf = (result) =>
  (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

async function main() {
  console.log(`\nVerifying reai-mcp deployment at ${BASE}\n`);

  // 1. Discovery.
  const prMeta = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
  report(
    "protected resource metadata",
    prMeta.resource === `${BASE}/mcp`,
    `resource=${prMeta.resource}`,
  );

  const asUrl = prMeta.authorization_servers?.[0] ?? BASE;
  const asMeta = await (await fetch(`${asUrl}/.well-known/oauth-authorization-server`)).json();
  report(
    "authorization server metadata advertises S256",
    asMeta.code_challenge_methods_supported?.includes("S256") === true,
  );

  // 2. The MCP endpoint must challenge an unauthenticated request.
  const unauth = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  report(
    "unauthenticated request is challenged",
    unauth.status === 401 && (unauth.headers.get("www-authenticate") ?? "").includes("resource_metadata"),
    `HTTP ${unauth.status}`,
  );

  // 3. Dynamic client registration.
  const regRes = await fetch(asMeta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: "reai-mcp smoke test" }),
  });
  const reg = await regRes.json();
  report("dynamic client registration", regRes.status === 201 && Boolean(reg.client_id));
  if (!reg.client_id) throw new Error(`registration failed: ${JSON.stringify(reg)}`);

  // A registration with a non-HTTPS, non-loopback redirect must be refused.
  const badReg = await fetch(asMeta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"] }),
  });
  report("registration refuses a non-loopback http redirect", badReg.status === 400);

  // 4. Authorization with PKCE.
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const state = randomBytes(12).toString("base64url");

  const authorizeUrl = new URL(asMeta.authorization_endpoint);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", reg.client_id);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("resource", `${BASE}/mcp`);

  const consentRes = await fetch(authorizeUrl);
  const consentHtml = await consentRes.text();
  report(
    "consent page renders",
    consentRes.status === 200 && consentHtml.includes('name="request"'),
    `HTTP ${consentRes.status}`,
  );

  // A request without PKCE must be rejected rather than downgraded.
  const noPkce = new URL(authorizeUrl);
  noPkce.searchParams.delete("code_challenge");
  noPkce.searchParams.delete("code_challenge_method");
  const noPkceRes = await fetch(noPkce, { redirect: "manual" });
  const noPkceLocation = noPkceRes.headers.get("location") ?? "";
  report(
    "authorization without PKCE is rejected",
    noPkceRes.status >= 300 && noPkceLocation.includes("error="),
    noPkceLocation ? new URL(noPkceLocation).searchParams.get("error_description") ?? "" : `HTTP ${noPkceRes.status}`,
  );

  const sealedRequest = /name="request" value="([^"]+)"/.exec(consentHtml)?.[1];
  if (!sealedRequest) throw new Error("could not find the sealed request field on the consent page");

  // 5. Submit the consent form the way a browser would.
  const form = new URLSearchParams({ request: decodeHtml(sealedRequest), token });
  if (tenantArg) form.set("tenantId", tenantArg);

  let postRes = await fetch(asMeta.authorization_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  });

  // If the token reaches several companies, the server asks which one.
  if (postRes.status === 200) {
    const html = await postRes.text();
    const verified = /name="verified" value="([^"]+)"/.exec(html)?.[1];
    const firstTenant = /<option value="(\d+)"/.exec(html)?.[1];
    report("multi-tenant token prompts for a company", Boolean(verified && firstTenant));
    if (!verified || !firstTenant) throw new Error("unexpected consent response");
    postRes = await fetch(asMeta.authorization_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        request: decodeHtml(sealedRequest),
        verified: decodeHtml(verified),
        tenantId: firstTenant,
      }).toString(),
      redirect: "manual",
    });
  }

  const location = postRes.headers.get("location");
  report(
    "consent redirects back with a code",
    postRes.status === 302 && Boolean(location),
    postRes.status === 302 ? "" : `HTTP ${postRes.status}: ${(await postRes.text()).slice(0, 200)}`,
  );
  if (!location) throw new Error("no redirect after consent");

  const redirected = new URL(location);
  const code = redirected.searchParams.get("code");
  report("state is round-tripped unchanged", redirected.searchParams.get("state") === state);
  if (!code) throw new Error(`no code in redirect: ${location}`);

  // 6. Token exchange. A wrong verifier must fail first.
  const badExchange = await fetch(asMeta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: randomBytes(48).toString("base64url"),
      redirect_uri: REDIRECT_URI,
      client_id: reg.client_id,
    }).toString(),
  });
  report("token exchange rejects a wrong PKCE verifier", badExchange.status === 400);

  const tokenRes = await fetch(asMeta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: reg.client_id,
    }).toString(),
  });
  const tokens = await tokenRes.json();
  report(
    "token exchange issues an access token",
    tokenRes.status === 200 && typeof tokens.access_token === "string",
    tokenRes.status === 200 ? `expires_in=${tokens.expires_in}` : JSON.stringify(tokens),
  );
  if (!tokens.access_token) throw new Error("no access token issued");

  report(
    "the ReAI token is not echoed in the token response",
    !JSON.stringify(tokens).includes(token),
  );

  // Replay of the same code must fail.
  const replay = await fetch(asMeta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: reg.client_id,
    }).toString(),
  });
  report("an authorization code cannot be replayed", replay.status === 400);

  // 7. Refresh.
  if (tokens.refresh_token) {
    const refreshed = await fetch(asMeta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: reg.client_id,
      }).toString(),
    });
    const next = await refreshed.json();
    report("refresh token yields a new access token", refreshed.status === 200 && Boolean(next.access_token));
  }

  // 8. Speak MCP over the authenticated transport.
  console.log("\n  Connecting over Streamable HTTP:");
  const client = new Client({ name: "reai-mcp-http-smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  });
  await client.connect(transport);

  const { tools } = await client.listTools();
  report("tools/list over HTTP", tools.length > 0, `${tools.length} tools`);

  const who = await client.callTool({ name: "reai_whoami", arguments: {} });
  const whoText = textOf(who);
  report(
    "reai_whoami through the connector",
    !who.isError && whoText.includes("tenants"),
    firstLine(whoText),
  );

  const accounts = await client.callTool({ name: "reai_list_accounts", arguments: { query: "bank" } });
  report(
    "tenant bound at authorization time needs no tenantId argument",
    !accounts.isError && /"number"/.test(textOf(accounts)),
    firstLine(textOf(accounts)),
  );

  const vouchers = await client.callTool({ name: "reai_list_vouchers", arguments: {} });
  report("reai_list_vouchers through the connector", !vouchers.isError, firstLine(textOf(vouchers)));

  await client.close();

  // 9. A garbage bearer token must be refused.
  const badToken = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer reaimcp_at.forged" },
    body: "{}",
  });
  report("a forged access token is refused", badToken.status === 401);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

/** The sealed values are HTML-escaped in the page; undo that before posting. */
function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function firstLine(text) {
  return (text.split("\n").find((l) => l.trim()) ?? "").slice(0, 130);
}

main().catch((err) => {
  console.error("\nHTTP smoke test crashed:", err);
  process.exit(1);
});
