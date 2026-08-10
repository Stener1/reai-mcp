/**
 * Does this HTML document need an external fetch to render?
 *
 * An MCP Apps template is handed to a host that renders it in a sandbox with no network. Any reference that
 * requires a fetch leaves the view loaded and blank — and that failure is invisible from the server side, which
 * is why the smoke check exists at all.
 *
 * This predicate has been wrong four times, which is the reason it lives in its own module with a table test
 * rather than inside `scripts/smoke.mjs`:
 *
 *   1. `/(?:src|href)\s*=\s*["']https?:/` — too NARROW. `<script src="widget.js">` is equally unfetchable.
 *   2. `/\bsrc\s*=|\bhref\s*=|<link\b|<img\b/` — too BROAD. Failed on `<a href="#details">`, on a `data:` URI,
 *      and on the string `href=` inside the inline script.
 *   3. One attribute per element, `[^>]*` for the attribute text, `blob:` treated as embedded, and every
 *      `#fragment` exempt. Four separate holes, all found by review at once:
 *        - `<img srcset="logo.png 1x">` with no `src` fetches, and was not inspected at all.
 *        - `<script data-note=">" src="widget.js">` — the tag scan stopped at the `>` INSIDE the quoted value,
 *          so `src` was never seen. An `aria-label` or `data-*` containing `>` is ordinary markup, not a
 *          contrived case, so this was the most consequential of the four.
 *        - `blob:` does NOT carry its bytes; it names an entry in the Blob URL store of the context that
 *          created it. A serialized template referencing one cannot resolve it.
 *        - `<script src="#payload">` does not read the fragment: the browser resolves it against the document
 *          URL and fetches that. The fragment exemption is right for SVG `<use href="#icon">` and wrong for
 *          every loader.
 *
 * The lesson each round has repeated: "self-contained" is a property of resource-LOADING attributes and of the
 * URL scheme. Enumerating one attribute per element, or one scheme, leaves a hole for whatever was not listed.
 */

/**
 * Resource-loading attributes per element. A LIST per element, because `<img>` fetches through `src` and
 * `srcset` independently and checking only the first accepts a template that depends on the second.
 *
 * `<a href>` is deliberately absent: navigation is not a fetch.
 */
const LOADERS = {
  script: ["src"],
  link: ["href"],
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  iframe: ["src"],
  frame: ["src"],
  embed: ["src"],
  track: ["src"],
  video: ["src", "poster"],
  audio: ["src"],
  object: ["data"],
  input: ["src"],
  use: ["href", "xlink:href"],
  image: ["href", "xlink:href"], // SVG <image>
};

/**
 * Attributes that legitimately reference the SAME document by fragment.
 *
 * Only SVG's `use`/`image` resolve `#id` inside the current document. `<script src="#x">` does not read the
 * fragment — it resolves against the document URL and fetches that — so the exemption cannot be global.
 */
const SAME_DOCUMENT_FRAGMENT = new Set(["use:href", "use:xlink:href", "image:href", "image:xlink:href"]);

/**
 * Schemes whose bytes are IN the URL. `data:` only.
 *
 * `blob:` is not one: it refers to the Blob URL store of the browsing context that created it, so a template
 * serialized and handed to another host cannot resolve it.
 */
const EMBEDDED_SCHEME = /^data:/i;

/**
 * Replace the CONTENT of every script and style block with a placeholder, keeping the tags.
 *
 * Without this, `href=` written inside the inline script — ordinary for code that builds markup — reads as a
 * reference. The opening tag is preserved so `<script src=…>` is still visible.
 */
function blankInlineCode(html) {
  // The attribute run is quote-aware for the SAME reason the tag scan below is: `[^>]*` stops at a `>` inside a
  // quoted value, which truncated the opening tag and then blanked the REST of it as if it were script content.
  // `<script data-note=">" src="widget.js">` lost its src that way — the fix was applied to the tag scan and
  // not here, so the hole moved rather than closed. Both places parse attributes; both need the same rule.
  return html.replace(
    /(<(script|style)\b(?:"[^"]*"|'[^']*'|[^>"'])*>)([\s\S]*?)(<\/\2\s*>)/gi,
    (_m, open, _tag, _body, close) => `${open}/* inline */${close}`,
  );
}

/**
 * Opening tags, with attribute text that may contain `>` inside quotes.
 *
 * `[^>]*` was wrong: a quoted value is allowed to contain `>`, and stopping there truncated the attribute text
 * before the resource attribute was reached. This alternation consumes a quoted run OR a single character that
 * is neither a quote nor `>`, so quoted `>` is swallowed and an unquoted one still ends the tag.
 */
const TAG = /<([a-z][a-z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;

/** Read one attribute's value out of a tag's attribute text. Quoted, single-quoted or bare. */
function attributeValue(attrs, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  if (!m) return undefined;
  return (m[2] ?? m[3] ?? m[4] ?? "").trim();
}

/**
 * Candidate URLs in a value.
 *
 * `srcset` is a comma-separated list of `url descriptor` pairs, so the URL is the first token of each entry.
 * Every other attribute holds a single URL.
 */
function candidateUrls(attribute, value) {
  if (attribute !== "srcset") return [value];
  // Split on WHITESPACE, not on commas. A srcset URL cannot contain whitespace, but it certainly can contain a
  // comma — `srcset="data:image/png;base64,AAA 1x"` — and splitting on commas tore that data URI in half and
  // then reported its tail as an external reference. Found by this module's own test table, which is the point
  // of having one. Tokens shaped like a descriptor (`1x`, `2.5x`, `640w`) are descriptors; the rest are URLs.
  return value
    .split(/\s+/)
    .map((token) => token.replace(/,+$/, "").replace(/^,+/, ""))
    .filter((token) => token !== "" && !/^\d+(?:\.\d+)?[wx]$/i.test(token));
}

/**
 * Every reference in `html` that would require an external fetch.
 *
 * Returns `{ element, attribute, url }` entries, empty when the document is self-contained. Callers should
 * treat a non-empty result as a failure and print it — naming the offending element is the difference between
 * "not self-contained" and something actionable.
 */
export function externalReferences(html) {
  const scanned = blankInlineCode(String(html));
  const found = [];

  for (const match of scanned.matchAll(TAG)) {
    const element = match[1].toLowerCase();
    const attributes = LOADERS[element];
    if (attributes === undefined) continue;

    const attrs = match[2] ?? "";
    for (const attribute of attributes) {
      const raw = attributeValue(attrs, attribute);
      if (raw === undefined || raw === "") continue;

      for (const url of candidateUrls(attribute, raw)) {
        if (EMBEDDED_SCHEME.test(url)) continue;
        if (url.startsWith("#") && SAME_DOCUMENT_FRAGMENT.has(`${element}:${attribute}`)) continue;
        found.push({ element, attribute, url });
      }
    }
  }
  return found;
}

/** True when nothing in the document requires a fetch. */
export function isSelfContained(html) {
  return externalReferences(html).length === 0;
}
