import type { WriteMode } from "../policy.js";

/**
 * Server-rendered consent pages for the OAuth flow.
 *
 * Deliberately dependency-free and inline-styled: this is the one place a user
 * hands over a credential that unlocks their accounting system, so it should not
 * load anything from a third-party origin. The CSP set in `sendHtml` allows only
 * inline styles and same-origin form submission.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px;
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #f6f7f9; color: #14171a;
  }
  main {
    width: 100%; max-width: 480px; background: #fff; border: 1px solid #e3e6ea;
    border-radius: 14px; padding: 28px; box-shadow: 0 1px 3px rgba(0,0,0,.06);
  }
  h1 { margin: 0 0 6px; font-size: 19px; letter-spacing: -.01em; }
  .sub { margin: 0 0 22px; color: #5c6670; font-size: 13.5px; }
  label { display: block; font-weight: 600; font-size: 13px; margin: 18px 0 6px; }
  .hint { font-weight: 400; color: #6b747d; font-size: 12.5px; margin: 4px 0 0; }
  input[type=password], input[type=text], select {
    width: 100%; padding: 10px 12px; font-size: 14px; font-family: inherit;
    border: 1px solid #ccd2d8; border-radius: 8px; background: #fff; color: inherit;
  }
  input:focus, select:focus { outline: 2px solid #2f6feb; outline-offset: -1px; border-color: #2f6feb; }
  button {
    width: 100%; margin-top: 24px; padding: 11px 16px; font-size: 14.5px; font-weight: 600;
    font-family: inherit; color: #fff; background: #1a1d21; border: 0; border-radius: 8px;
    cursor: pointer;
  }
  button:hover { background: #2f3439; }
  .err {
    margin: 0 0 18px; padding: 11px 13px; border-radius: 8px; font-size: 13.5px;
    background: #fdeceb; border: 1px solid #f5c2c0; color: #8c1d18;
  }
  .meta {
    margin: 22px 0 0; padding-top: 16px; border-top: 1px solid #eceff2;
    font-size: 12.5px; color: #6b747d;
  }
  .meta code { font-size: 12px; background: #f2f4f6; padding: 1px 5px; border-radius: 4px; }
  .modes { display: grid; gap: 8px; margin-top: 8px; }
  .mode {
    display: flex; gap: 10px; padding: 10px 12px; border: 1px solid #ccd2d8;
    border-radius: 8px; cursor: pointer; align-items: flex-start;
  }
  .mode:hover { border-color: #9aa3ac; }
  .mode input { margin: 3px 0 0; flex: none; }
  .mode b { display: block; font-size: 13.5px; }
  .mode span { display: block; font-size: 12.5px; color: #6b747d; }
  a { color: #2f6feb; }
  @media (prefers-color-scheme: dark) {
    body { background: #101214; color: #e6e9ec; }
    main { background: #191c1f; border-color: #2b3034; box-shadow: none; }
    .sub, .hint, .meta, .mode span { color: #98a1aa; }
    input[type=password], input[type=text], select, .mode {
      background: #101214; border-color: #363c42; color: #e6e9ec;
    }
    button { background: #e6e9ec; color: #101214; }
    button:hover { background: #fff; }
    .err { background: #3b1a19; border-color: #6b2b28; color: #f5b7b4; }
    .meta code { background: #22262a; }
    .modes .mode:hover { border-color: #4a5158; }
    .meta { border-top-color: #2b3034; }
  }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head><body><main>${body}</main></body></html>`;
}

export type ConsentPageOptions = {
  sealedRequest: string;
  redirectUri: string;
  serverWriteMode: WriteMode;
  baseUrl: string;
  clientName?: string;
  error?: string;
  /** Present on the second step, carrying the already-verified ReAI token. */
  sealedToken?: string;
  /** Offered on the second step when the token reaches several companies. */
  tenants?: Array<{ id: number; companyName?: string; slug?: string }>;
  subject?: string;
  /** Carries the step-1 write-mode choice through the company-selection step. */
  carriedWriteMode?: WriteMode;
};

export function renderConsentPage(opts: ConsentPageOptions): string {
  const client = opts.clientName ? escapeHtml(opts.clientName) : "An MCP client";
  const host = safeHost(opts.redirectUri);
  const isTenantStep = Boolean(opts.tenants?.length);

  const parts: string[] = [];

  parts.push(`<h1>${isTenantStep ? "Choose a company" : "Connect ReAI"}</h1>`);
  parts.push(
    isTenantStep
      ? `<p class="sub">Signed in as <strong>${escapeHtml(opts.subject ?? "your ReAI user")}</strong>. ` +
          `This token can reach several companies — pick the one this connection should use.</p>`
      : `<p class="sub"><strong>${client}</strong> at <code>${escapeHtml(host)}</code> is requesting ` +
          `access to your ReAI accounting data.</p>`,
  );

  if (opts.error) parts.push(`<p class="err">${escapeHtml(opts.error)}</p>`);

  parts.push(`<form method="post" action="/authorize" autocomplete="off">`);
  parts.push(`<input type="hidden" name="request" value="${escapeHtml(opts.sealedRequest)}">`);

  if (isTenantStep && opts.sealedToken) {
    parts.push(`<input type="hidden" name="verified" value="${escapeHtml(opts.sealedToken)}">`);
    if (opts.carriedWriteMode) {
      parts.push(`<input type="hidden" name="writeMode" value="${escapeHtml(opts.carriedWriteMode)}">`);
    }
    parts.push(`<label for="tenantId">Company</label>`);
    parts.push(`<select id="tenantId" name="tenantId" required>`);
    for (const t of opts.tenants ?? []) {
      const label = t.companyName ?? t.slug ?? `Tenant ${t.id}`;
      parts.push(`<option value="${t.id}">${escapeHtml(label)} (${t.id})</option>`);
    }
    parts.push(`</select>`);
  } else {
    parts.push(`<label for="token">ReAI API token</label>`);
    parts.push(
      `<input id="token" name="token" type="password" required autofocus ` +
        `spellcheck="false" autocomplete="off" placeholder="Paste your token">`,
    );
    parts.push(
      `<p class="hint">Create one in ReAI under settings &rarr; API tokens. ` +
        `It is encrypted into this connection's access token and never written to disk or logs.</p>`,
    );
  }

  // Offer to narrow the write ceiling, never to widen it.
  const selectable = narrowerModes(opts.serverWriteMode);
  if (!isTenantStep && selectable.length > 1) {
    parts.push(`<label>What may this connection change?</label><div class="modes">`);
    for (const mode of selectable) {
      const checked = mode === opts.serverWriteMode ? " checked" : "";
      parts.push(
        `<label class="mode"><input type="radio" name="writeMode" value="${mode}"${checked}>` +
          `<span><b>${MODE_LABELS[mode].title}</b><span>${MODE_LABELS[mode].body}</span></span></label>`,
      );
    }
    parts.push(`</div>`);
  }

  parts.push(`<button type="submit">${isTenantStep ? "Connect" : "Authorize"}</button>`);
  parts.push(`</form>`);

  parts.push(
    `<p class="meta">Connecting to <code>${escapeHtml(opts.baseUrl)}</code>. ` +
      `This server is self-hosted — you are trusting whoever operates it. ` +
      `<a href="https://github.com/Stener1/reai-mcp" rel="noreferrer noopener">Source</a>.</p>`,
  );

  return page("Connect ReAI", parts.join("\n"));
}

const MODE_LABELS: Record<WriteMode, { title: string; body: string }> = {
  "read-only": {
    title: "Read only",
    body: "Look at the books, change nothing.",
  },
  reversible: {
    title: "Read and edit master data",
    body: "Also customers, suppliers, products and departments — things that can be deleted again.",
  },
  full: {
    title: "Full access",
    body: "Also ledger postings, invoices, payments, payroll and VAT returns. These cannot be cleanly undone.",
  },
};

/** Modes at or below the server's ceiling, most restrictive first. */
function narrowerModes(ceiling: WriteMode): WriteMode[] {
  const ladder: WriteMode[] = ["read-only", "reversible", "full"];
  return ladder.slice(0, ladder.indexOf(ceiling) + 1);
}

export function renderErrorPage(title: string, detail: string): string {
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1><p class="sub">${escapeHtml(detail)}</p>` +
      `<p class="meta"><a href="https://github.com/Stener1/reai-mcp" rel="noreferrer noopener">reai-mcp</a></p>`,
  );
}

function safeHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri.slice(0, 60);
  }
}
