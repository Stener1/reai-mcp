import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Sealer, verifyPkceS256, isSealedToken } from "../dist/auth/crypto.js";
import { OAuthProvider, CodeReplayGuard, validateRedirectUri } from "../dist/auth/oauth.js";
import { renderConsentPage, escapeHtml } from "../dist/auth/pages.js";

const KEY = randomBytes(32).toString("base64");

function makeProvider(overrides = {}) {
  const sealer = Sealer.fromEnv(KEY);
  const config = {
    baseUrl: "https://app.reai.no",
    writeMode: "reversible",
    timeoutMs: 5000,
    maxRetries: 0,
    allowTokenPassthrough: false,
    allowedHosts: [],
    allowedRedirectHosts: [],
    verbose: false,
    port: 8080,
    ...overrides,
  };
  const replayGuard = overrides.replayGuard ?? new CodeReplayGuard();
  return {
    provider: new OAuthProvider({ config, sealer, publicUrl: "https://reai.example.com", replayGuard }),
    sealer,
    config,
    replayGuard,
  };
}

// --- Sealed tokens ---------------------------------------------------------

test("sealed tokens round-trip", () => {
  const sealer = Sealer.fromEnv(KEY);
  const token = sealer.seal("access", { grant: { reaiToken: "secret-abc" } }, 60);
  assert.ok(isSealedToken(token));
  assert.match(token, /^reaimcp_at\./);
  const out = sealer.unseal("access", token);
  assert.equal(out.grant.reaiToken, "secret-abc");
});

test("a sealed token does not expose its payload", () => {
  const sealer = Sealer.fromEnv(KEY);
  const token = sealer.seal("access", { grant: { reaiToken: "super-secret-token" } }, 60);
  assert.ok(
    !token.includes("super-secret-token"),
    "the ReAI token must not appear in the sealed value",
  );
  // Not readable as base64 plaintext either.
  const decoded = Buffer.from(token.split(".")[1], "base64url").toString("latin1");
  assert.ok(!decoded.includes("super-secret"), "payload must be encrypted, not merely encoded");
});

test("purposes are not interchangeable", () => {
  const sealer = Sealer.fromEnv(KEY);
  const access = sealer.seal("access", { grant: { reaiToken: "x" } }, 60);
  // An access token must not be redeemable as a refresh token.
  assert.equal(sealer.unseal("refresh", access), undefined);
  assert.equal(sealer.unseal("code", access), undefined);
});

test("a token sealed with another key is rejected", () => {
  const a = Sealer.fromEnv(randomBytes(32).toString("base64"));
  const b = Sealer.fromEnv(randomBytes(32).toString("base64"));
  const token = a.seal("access", { grant: { reaiToken: "x" } }, 60);
  assert.equal(b.unseal("access", token), undefined);
});

test("tampering with the ciphertext is detected", () => {
  const sealer = Sealer.fromEnv(KEY);
  const token = sealer.seal("access", { grant: { reaiToken: "x" } }, 60);
  const [prefix, packed] = token.split(".");
  const raw = Buffer.from(packed, "base64url");
  raw[raw.length - 1] ^= 0xff;
  assert.equal(sealer.unseal("access", `${prefix}.${raw.toString("base64url")}`), undefined);
});

test("expired tokens are rejected", () => {
  const sealer = Sealer.fromEnv(KEY);
  const token = sealer.seal("access", { grant: { reaiToken: "x" } }, -1);
  assert.equal(sealer.unseal("access", token), undefined);
});

test("garbage input is rejected without throwing", () => {
  const sealer = Sealer.fromEnv(KEY);
  for (const bad of ["", "nope", "reaimcp_at.", "reaimcp_at.!!!!", "reaimcp_at.YWJj"]) {
    assert.equal(sealer.unseal("access", bad), undefined, bad);
  }
});

test("encryption keys are accepted as base64 or hex, and bad ones rejected", () => {
  assert.doesNotThrow(() => Sealer.fromEnv(randomBytes(32).toString("base64")));
  assert.doesNotThrow(() => Sealer.fromEnv(randomBytes(32).toString("hex")));
  assert.throws(() => Sealer.fromEnv("too-short"), /must be 32 bytes/);
  // An absent key yields a working ephemeral sealer, flagged as such.
  assert.equal(Sealer.fromEnv(undefined).ephemeral, true);
  assert.equal(Sealer.fromEnv(KEY).ephemeral, false);
});

// --- PKCE ------------------------------------------------------------------

test("PKCE S256 verification accepts a correct verifier", () => {
  const verifier = randomBytes(40).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  assert.equal(verifyPkceS256(verifier, challenge), true);
  assert.equal(verifyPkceS256(verifier + "x", challenge), false);
  assert.equal(verifyPkceS256("short", challenge), false);
});

// --- Redirect URI validation ----------------------------------------------

test("redirect URIs must be https or loopback http", () => {
  assert.equal(validateRedirectUri("https://claude.ai/api/mcp/auth_callback"), undefined);
  assert.equal(validateRedirectUri("http://localhost:6274/callback"), undefined);
  assert.equal(validateRedirectUri("http://127.0.0.1:8080/cb"), undefined);
  assert.ok(validateRedirectUri("http://evil.example.com/cb"));
  assert.ok(validateRedirectUri("javascript:alert(1)"));
  assert.ok(validateRedirectUri("not a url"));
  assert.ok(validateRedirectUri("https://ok.example.com/cb#frag"));
});

// --- Metadata --------------------------------------------------------------

test("metadata documents advertise PKCE and the right endpoints", () => {
  const { provider } = makeProvider();
  const as = provider.authorizationServerMetadata();
  assert.equal(as.issuer, "https://reai.example.com");
  assert.equal(as.authorization_endpoint, "https://reai.example.com/authorize");
  assert.equal(as.token_endpoint, "https://reai.example.com/token");
  assert.equal(as.registration_endpoint, "https://reai.example.com/register");
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.ok(as.grant_types_supported.includes("refresh_token"));

  const pr = provider.protectedResourceMetadata();
  assert.equal(pr.resource, "https://reai.example.com/mcp");
  assert.deepEqual(pr.authorization_servers, ["https://reai.example.com"]);
});

// --- Dynamic client registration ------------------------------------------

test("registration requires at least one valid redirect_uri", () => {
  const { provider } = makeProvider();
  assert.equal(provider.register({}).status, 400);
  assert.equal(provider.register({ redirect_uris: [] }).status, 400);
  assert.equal(provider.register({ redirect_uris: ["http://evil.com/cb"] }).status, 400);
});

test("registration returns a sealed client_id carrying its redirect URIs", () => {
  const { provider, sealer } = makeProvider();
  const res = provider.register({
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    client_name: "Claude",
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.token_endpoint_auth_method, "none");

  const unsealed = sealer.unseal("client", res.json.client_id);
  assert.deepEqual(unsealed.redirectUris, ["https://claude.ai/api/mcp/auth_callback"]);
  assert.equal(unsealed.name, "Claude");
});

// --- Token endpoint --------------------------------------------------------

const GRANT = {
  reaiToken: "reai-secret-token",
  tenantId: 2634,
  writeMode: "reversible",
  subject: "user@example.com",
  clientId: "client-1",
};

function mintCode(sealer, { challenge, redirectUri = "https://claude.ai/cb", clientId = "client-1", ttl = 60 }) {
  return sealer.seal(
    "code",
    { grant: GRANT, codeChallenge: challenge, redirectUri, clientId, nonce: randomBytes(8).toString("hex") },
    ttl,
  );
}

test("authorization_code exchange requires a valid PKCE verifier", async () => {
  const { provider, sealer } = makeProvider();
  const verifier = randomBytes(40).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");

  const missing = await provider.handleToken(
    new URLSearchParams({ grant_type: "authorization_code", code: mintCode(sealer, { challenge }) }),
  );
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error, "invalid_request");

  const wrong = await provider.handleToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: mintCode(sealer, { challenge }),
      code_verifier: randomBytes(40).toString("base64url"),
      redirect_uri: "https://claude.ai/cb",
      client_id: "client-1",
    }),
  );
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error, "invalid_grant");
});

test("a valid code exchange issues access and refresh tokens", async () => {
  const { provider, sealer } = makeProvider();
  const verifier = randomBytes(40).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");

  const res = await provider.handleToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: mintCode(sealer, { challenge }),
      code_verifier: verifier,
      redirect_uri: "https://claude.ai/cb",
      client_id: "client-1",
    }),
  );

  assert.equal(res.status, 200);
  assert.equal(res.json.token_type, "Bearer");
  assert.ok(res.json.access_token.startsWith("reaimcp_at."));
  assert.ok(res.json.refresh_token.startsWith("reaimcp_rt."));
  assert.ok(res.json.expires_in > 0);
  // The ReAI token must not be exposed in the token response.
  assert.ok(!JSON.stringify(res.json).includes(GRANT.reaiToken));
});

test("an authorization code cannot be redeemed twice", async () => {
  const { provider, sealer } = makeProvider();
  const verifier = randomBytes(40).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const code = mintCode(sealer, { challenge });

  const first = await provider.handleToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: "https://claude.ai/cb",
      client_id: "client-1",
    }),
  );
  assert.equal(first.status, 200);

  const second = await provider.handleToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: "https://claude.ai/cb",
      client_id: "client-1",
    }),
  );
  assert.equal(second.status, 400);
  assert.match(second.json.error_description, /already been redeemed/);
});

test("replay protection survives across provider instances", async () => {
  // Regression: the HTTP layer builds a new OAuthProvider per request, so a
  // guard held on the instance forgot every redeemed code immediately and the
  // one-time-use rule silently did nothing.
  const guard = new CodeReplayGuard();
  const first = makeProvider({ replayGuard: guard });
  const verifier = randomBytes(40).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const code = mintCode(first.sealer, { challenge });

  const ok = await first.provider.handleToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: "https://claude.ai/cb",
      client_id: "client-1",
    }),
  );
  assert.equal(ok.status, 200);

  // A different provider instance, as a second HTTP request would build.
  const second = new OAuthProvider({
    config: first.config,
    sealer: first.sealer,
    publicUrl: "https://reai.example.com",
    replayGuard: guard,
  });
  const replayed = await second.handleToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: "https://claude.ai/cb",
      client_id: "client-1",
    }),
  );
  assert.equal(replayed.status, 400);
  assert.match(replayed.json.error_description, /already been redeemed/);
});

test("code exchange rejects a mismatched redirect_uri or client_id", async () => {
  const { provider, sealer } = makeProvider();
  const verifier = randomBytes(40).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");

  const badRedirect = await provider.handleToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: mintCode(sealer, { challenge }),
      code_verifier: verifier,
      redirect_uri: "https://attacker.example.com/cb",
      client_id: "client-1",
    }),
  );
  assert.equal(badRedirect.json.error, "invalid_grant");

  const badClient = await provider.handleToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: mintCode(sealer, { challenge }),
      code_verifier: verifier,
      redirect_uri: "https://claude.ai/cb",
      client_id: "someone-else",
    }),
  );
  assert.equal(badClient.json.error, "invalid_grant");
});

test("redirect_uri and client_id are required, not merely compared when present", async () => {
  // Previously both checks were guarded on truthiness, so omitting the parameter
  // skipped the comparison entirely. RFC 6749 4.1.3 makes both REQUIRED here.
  const { provider, sealer } = makeProvider();
  const verifier = randomBytes(40).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");

  const noRedirect = await provider.handleToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: mintCode(sealer, { challenge }),
      code_verifier: verifier,
      client_id: "client-1",
    }),
  );
  assert.equal(noRedirect.status, 400);
  assert.equal(noRedirect.json.error, "invalid_request");

  const noClient = await provider.handleToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: mintCode(sealer, { challenge }),
      code_verifier: verifier,
      redirect_uri: "https://claude.ai/cb",
    }),
  );
  assert.equal(noClient.status, 400);
  assert.equal(noClient.json.error, "invalid_request");
});

test("a refresh token is only usable by the client it was issued to", async () => {
  const { provider, sealer } = makeProvider();
  const refresh = sealer.seal("refresh", { grant: GRANT }, 600);

  const wrongClient = await provider.handleToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: "a-different-client",
    }),
  );
  assert.equal(wrongClient.status, 400);
  assert.equal(wrongClient.json.error, "invalid_grant");

  const rightClient = await provider.handleToken(
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: "client-1" }),
  );
  assert.equal(rightClient.status, 200);
});

test("one of our own tokens is never forwarded to ReAI as a credential", () => {
  // With passthrough enabled, an expired or key-rotated sealed token must still
  // produce a 401 telling the client to re-authorize -- not be sent upstream as
  // if it were a ReAI token.
  const { provider, sealer } = makeProvider({ allowTokenPassthrough: true });
  const expired = sealer.seal("access", { grant: GRANT }, -1);

  const result = provider.authenticate(`Bearer ${expired}`);
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_token");

  // A genuinely foreign token still passes through when the operator allows it.
  assert.equal(provider.authenticate("Bearer raw-reai-token").ok, true);
});

test("the challenge header cannot be broken out of with a quote", () => {
  const { sealer, config } = makeProvider();
  const provider = new OAuthProvider({
    config,
    sealer,
    publicUrl: 'https://evil.example.com/", injected="yes',
    replayGuard: new CodeReplayGuard(),
  });
  const header = provider.challengeHeader("invalid_token", 'say "hi"');
  assert.ok(!header.includes('injected="yes"'), `header must not gain params: ${header}`);
  // Exactly the three parameters we intend, so no extra quoted pair was injected.
  assert.equal((header.match(/="/g) ?? []).length, 3, header);
});

test("the redirect-host allowlist blocks registration of unknown callbacks", () => {
  const { provider } = makeProvider({ allowedRedirectHosts: ["claude.ai"] });

  assert.equal(provider.register({ redirect_uris: ["https://claude.ai/cb"] }).status, 201);
  // Loopback stays available for local clients like MCP Inspector.
  assert.equal(provider.register({ redirect_uris: ["http://localhost:6274/cb"] }).status, 201);

  const blocked = provider.register({ redirect_uris: ["https://evil.example.com/cb"] });
  assert.equal(blocked.status, 400);
  assert.match(blocked.json.error_description, /not permitted/);
});

test("with no allowlist configured any https callback may register", () => {
  const { provider } = makeProvider();
  assert.equal(provider.register({ redirect_uris: ["https://anything.example.com/cb"] }).status, 201);
});

test("expired codes are rejected", async () => {
  const { provider, sealer } = makeProvider();
  const verifier = randomBytes(40).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const res = await provider.handleToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: mintCode(sealer, { challenge, ttl: -1 }),
      code_verifier: verifier,
      redirect_uri: "https://claude.ai/cb",
      client_id: "client-1",
    }),
  );
  assert.equal(res.json.error, "invalid_grant");
});

test("refresh_token grant issues a fresh access token", async () => {
  const { provider, sealer } = makeProvider();
  const refresh = sealer.seal("refresh", { grant: GRANT }, 600);
  const res = await provider.handleToken(
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
  );
  assert.equal(res.status, 200);
  assert.ok(res.json.access_token.startsWith("reaimcp_at."));
});

test("unsupported grant types are refused", async () => {
  const { provider } = makeProvider();
  const res = await provider.handleToken(new URLSearchParams({ grant_type: "password" }));
  assert.equal(res.status, 400);
  assert.equal(res.json.error, "unsupported_grant_type");
});

// --- Request authentication -----------------------------------------------

test("authenticate accepts our own access token and recovers the grant", () => {
  const { provider, sealer } = makeProvider();
  const token = sealer.seal("access", { grant: GRANT }, 600);
  const result = provider.authenticate(`Bearer ${token}`);
  assert.equal(result.ok, true);
  assert.equal(result.grant.reaiToken, GRANT.reaiToken);
  assert.equal(result.grant.tenantId, 2634);
  assert.equal(result.grant.writeMode, "reversible");
});

test("authenticate rejects missing, malformed and foreign tokens", () => {
  const { provider } = makeProvider();
  for (const header of [undefined, "", "Basic abc", "Bearer", "Bearer not-a-real-token"]) {
    const result = provider.authenticate(header);
    assert.equal(result.ok, false, JSON.stringify(header));
    assert.equal(result.status, 401);
  }
});

test("a raw ReAI token is refused unless passthrough is enabled", () => {
  const closed = makeProvider().provider;
  assert.equal(closed.authenticate("Bearer some-raw-reai-token").ok, false);

  const open = makeProvider({ allowTokenPassthrough: true, defaultTenantId: 99 }).provider;
  const result = open.authenticate("Bearer some-raw-reai-token");
  assert.equal(result.ok, true);
  assert.equal(result.grant.reaiToken, "some-raw-reai-token");
  assert.equal(result.grant.tenantId, 99);
});

test("the challenge header points at the resource metadata", () => {
  const { provider } = makeProvider();
  const header = provider.challengeHeader("invalid_token", "expired");
  assert.match(header, /^Bearer /);
  assert.match(header, /resource_metadata="https:\/\/reai\.example\.com\/\.well-known\/oauth-protected-resource"/);
});

// --- Consent page ----------------------------------------------------------

test("the consent page escapes reflected values", () => {
  const html = renderConsentPage({
    sealedRequest: 'abc"><script>alert(1)</script>',
    redirectUri: "https://claude.ai/cb",
    serverWriteMode: "full",
    baseUrl: "https://app.reai.no",
    clientName: '<img src=x onerror=alert(1)>',
  });
  assert.ok(!html.includes("<script>alert(1)</script>"), "sealed request must be escaped");
  assert.ok(!html.includes("<img src=x"), "client name must be escaped");
  assert.ok(html.includes("&lt;"), "escaping should be visible");
});

test("the consent page offers only modes at or below the server ceiling", () => {
  const readOnly = renderConsentPage({
    sealedRequest: "r",
    redirectUri: "https://claude.ai/cb",
    serverWriteMode: "read-only",
    baseUrl: "https://app.reai.no",
  });
  // A single available mode needs no chooser at all.
  assert.ok(!readOnly.includes('name="writeMode"'));

  const reversible = renderConsentPage({
    sealedRequest: "r",
    redirectUri: "https://claude.ai/cb",
    serverWriteMode: "reversible",
    baseUrl: "https://app.reai.no",
  });
  assert.ok(reversible.includes('value="read-only"'));
  assert.ok(reversible.includes('value="reversible"'));
  assert.ok(!reversible.includes('value="full"'), "must not offer to widen beyond the ceiling");

  const full = renderConsentPage({
    sealedRequest: "r",
    redirectUri: "https://claude.ai/cb",
    serverWriteMode: "full",
    baseUrl: "https://app.reai.no",
  });
  assert.ok(full.includes('value="full"'));
});

test("the company-selection step carries the token sealed and the chosen mode", () => {
  const html = renderConsentPage({
    sealedRequest: "r",
    redirectUri: "https://claude.ai/cb",
    serverWriteMode: "full",
    baseUrl: "https://app.reai.no",
    sealedToken: "reaimcp_rq.sealed",
    carriedWriteMode: "reversible",
    tenants: [
      { id: 1, companyName: "Alpha AS" },
      { id: 2, companyName: "Beta AS" },
    ],
    subject: "user@example.com",
  });
  assert.ok(html.includes('name="verified"'));
  assert.ok(html.includes('name="writeMode" value="reversible"'));
  assert.ok(html.includes("Alpha AS"));
  assert.ok(html.includes("Beta AS"));
  assert.ok(!html.includes('name="token"'), "the token field is not shown again on step 2");
});

test("escapeHtml handles the dangerous characters", () => {
  assert.equal(escapeHtml('<>&"\''), "&lt;&gt;&amp;&quot;&#39;");
});

test("the redirect allowlist is enforced at authorize, not only at registration", () => {
  // Registrations are sealed and live five years, and the allowlist is empty by
  // default — so a callback registered before an operator set
  // REAI_ALLOWED_REDIRECT_HOSTS kept working forever after. That is a phishing
  // primitive on the operator's own domain: the victim sees the genuine consent page
  // on the real host, pastes their ReAI token, and the code goes to a callback the
  // operator has since forbidden. Tightening the config has to be retroactive.
  const open = makeProvider({ allowedRedirectHosts: [] });
  const registered = open.provider.register({
    redirect_uris: ["https://attacker.example/cb"],
    client_name: "registered before the operator locked things down",
  });
  assert.equal(registered.status, 201, "registration succeeds while nothing is restricted");
  const clientId = registered.json.client_id;
  assert.ok(clientId);

  // A second deployment (or the same one, restarted) sharing the encryption key, now
  // with the allowlist set. The sealed client_id is still valid and still decrypts.
  const tight = makeProvider({ allowedRedirectHosts: ["claude.ai"] });
  const url = new URL("https://reai.example.com/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", String(clientId));
  url.searchParams.set("redirect_uri", "https://attacker.example/cb");
  url.searchParams.set("code_challenge", "a".repeat(43));
  url.searchParams.set("code_challenge_method", "S256");

  const captured = { status: 0, body: "", headers: {} };
  const res = {
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers ?? {};
      return this;
    },
    setHeader(k, v) {
      captured.headers[k.toLowerCase()] = v;
    },
    end(body) {
      captured.body = String(body ?? "");
    },
  };
  tight.provider.handleAuthorizeGet(url, res);

  // It must NOT reach the consent page, and must not redirect to the attacker.
  const location = captured.headers.location ?? captured.headers.Location ?? "";
  assert.doesNotMatch(captured.body, /name="request"/, "the consent form must not be rendered");
  assert.ok(
    !String(location).startsWith("https://attacker.example"),
    `must not bounce to the forbidden host, got ${location}`,
  );
});

test("an allowed redirect host still reaches the consent page", () => {
  const tight = makeProvider({ allowedRedirectHosts: ["claude.ai"] });
  const registered = tight.provider.register({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
  assert.equal(registered.status, 201);

  const url = new URL("https://reai.example.com/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", String(registered.json.client_id));
  url.searchParams.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
  url.searchParams.set("code_challenge", "a".repeat(43));
  url.searchParams.set("code_challenge_method", "S256");

  let body = "";
  const res = {
    writeHead() { return this; },
    setHeader() {},
    end(b) { body = String(b ?? ""); },
  };
  tight.provider.handleAuthorizeGet(url, res);
  assert.match(body, /name="request"/, "an allowed host must still get the consent form");
});

test("X-Forwarded-* uses the value the nearest proxy added, not the client's", async () => {
  // Proxies APPEND to these headers, so index 0 is whatever the client sent and the
  // rightmost entry is the one added closest to us. Taking the first meant a
  // client-supplied "X-Forwarded-Host: attacker.example, real.host" won outright —
  // spoofing the OAuth issuer and the resource_metadata pointer in the 401 challenge.
  // Cloud Run does not strip a client-supplied X-Forwarded-Host, so it is reachable in
  // the documented deployment; PUBLIC_URL closes it, which is why the deploy script
  // always sets it and startup now warns when it is missing.
  const { lastForwardedValue } = await import("../dist/config.js");

  assert.equal(lastForwardedValue("attacker.example, real.host"), "real.host");
  assert.equal(lastForwardedValue("real.host"), "real.host");
  assert.equal(lastForwardedValue(["attacker.example", "real.host"]), "real.host");
  assert.equal(lastForwardedValue(["a, b", "c"]), "c");
  assert.equal(lastForwardedValue("  spaced.host  "), "spaced.host");
  assert.equal(lastForwardedValue(undefined), undefined);
  assert.equal(lastForwardedValue(""), undefined);
  assert.equal(lastForwardedValue(", ,"), undefined);
});
