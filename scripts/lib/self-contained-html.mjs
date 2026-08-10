/**
 * Does this HTML document need an external fetch to render?
 *
 * An MCP Apps template is handed to a host that renders it in a sandbox with no network. Any reference that
 * requires a fetch leaves the view loaded and blank — and that failure is invisible from the server side, which
 * is why the smoke check exists at all.
 *
 * Extracted into its own module because the two previous versions of this predicate were both wrong in
 * opposite directions, and neither could be unit-tested while it lived inside `scripts/smoke.mjs`:
 *
 *   1. `/(?:src|href)\s*=\s*["']https?:/` — too NARROW. A relative asset (`<script src="widget.js">`) is
 *      equally unfetchable in a sandbox and passed.
 *   2. `/\bsrc\s*=|\bhref\s*=|<link\b|<img\b/` — too BROAD. It failed on `<a href="#details">`, on a `data:`
 *      URI, and on the literal text `href=` occurring inside the inline script.
 *
 * Both were caught by review. The lesson is that "self-contained" is a property of resource-LOADING elements
 * and of the URL scheme, not of whether the string `src=` appears somewhere in the file.
 */

/** Elements that fetch, mapped to the attribute that names what they fetch. `<a href>` is NOT one of them. */
const LOADERS = {
  script: "src",
  link: "href",
  img: "src",
  iframe: "src",
  frame: "src",
  embed: "src",
  source: "src",
  track: "src",
  video: "src",
  audio: "src",
  object: "data",
  use: "href",
  image: "href", // SVG <image>
};

/** Schemes that carry their own payload, so no fetch happens. */
const INLINE_SCHEMES = /^(?:data:|blob:)/i;

/**
 * Replace the CONTENT of every script and style block with a placeholder, keeping the tags.
 *
 * Without this, `href=` written inside the inline script — a perfectly ordinary thing for code that builds
 * markup — reads as a reference. The opening tag is preserved so `<script src=…>` is still visible.
 */
function blankInlineCode(html) {
  return html.replace(
    /(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi,
    (_m, open, _tag, _body, close) => `${open}/* inline */${close}`,
  );
}

/**
 * Every reference in `html` that would require an external fetch.
 *
 * Returns an array of `{ element, attribute, url }`, empty when the document is self-contained. Callers should
 * treat a non-empty result as a failure and print it — naming the offending element is the difference between
 * "not self-contained" and something actionable.
 */
export function externalReferences(html) {
  const scanned = blankInlineCode(String(html));
  const found = [];

  // One pass over opening tags. Attribute order is arbitrary, so the attribute is searched inside the tag
  // rather than assumed to follow the name.
  for (const match of scanned.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const element = match[1].toLowerCase();
    const attribute = LOADERS[element];
    if (attribute === undefined) continue;

    const attrs = match[2] ?? "";
    // Quoted or bare. `xlink:href` counts for SVG <use>.
    const urlMatch =
      new RegExp(`(?:^|\\s)(?:xlink:)?${attribute}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
    if (!urlMatch) continue; // e.g. an inline <script> with no src

    const url = (urlMatch[2] ?? urlMatch[3] ?? urlMatch[4] ?? "").trim();
    if (url === "") continue;
    if (url.startsWith("#")) continue; // same-document reference
    if (INLINE_SCHEMES.test(url)) continue; // carries its own payload

    found.push({ element, attribute, url });
  }
  return found;
}

/** True when nothing in the document requires a fetch. */
export function isSelfContained(html) {
  return externalReferences(html).length === 0;
}
