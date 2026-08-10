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
  // `src` on an input loads ONLY in the Image Button state. `<input type="hidden" src="x.png">` is inert, and
  // the default (absent type) is text, so this is conditional rather than unconditional.
  input: ["src"],
  // SVG resolves `href` in preference to the deprecated `xlink:href`. When both are present the fallback is
  // IGNORED, so treating them as two independent loads reports a reference the host never follows.
  use: ["href", "xlink:href"],
  image: ["href", "xlink:href"], // SVG <image>
};

/** Elements whose loader attributes only apply in a particular state. */
const CONDITIONAL_LOADERS = {
  input: (attrs) => (attributeValue(attrs, "type") ?? "").toLowerCase() === "image",
};

/** Attributes that are only consulted when a preferred attribute is absent. */
const FALLBACK_FOR = { "xlink:href": "href" };

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
/**
 * The document with comments and raw-text bodies removed, leaving only live markup.
 *
 * This is ONE left-to-right pass, and it has to be. Comments and raw-text elements (`script`, `style`) can each
 * open a context inside the other, so two independent global replacements are wrong in whichever order they
 * run — measured, both ways:
 *
 *   comments first:  <script>const m="<!--";</script><img src="remote.png"><!-- footer -->
 *                    the script-local `<!--` pairs with the real `-->` and the img is erased.
 *   raw text first:  <!-- stale <script> --><img src="remote.png"><script>ok</script>
 *                    the comment-local `<script>` pairs with the real `</script>` and the img is erased.
 *
 * Both are false PASSes on a document that fetches an ordinary image. I shipped the first, review caught it, I
 * shipped the second fixing it, and review caught that — which is the signal that ordering was never the
 * question. A scan that recognises whichever context STARTS first cannot have either bug.
 *
 * The opening tag of a raw-text element is kept, because `<script src=…>` is itself a reference.
 */
function liveMarkup(html) {
  let out = "";
  let i = 0;
  while (i < html.length) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    const rawText = /^<(script|style)\b/i.exec(html.slice(i));
    if (rawText) {
      const tagEnd = endOfTag(html, i);
      out += html.slice(i, tagEnd); // keep the opening tag; it may carry src=
      const close = new RegExp(`</${rawText[1]}\\s*>`, "i").exec(html.slice(tagEnd));
      i = close ? tagEnd + close.index + close[0].length : html.length;
      continue;
    }
    out += html[i];
    i += 1;
  }
  return out;
}

/**
 * Index just past the `>` that closes the tag starting at `start`.
 *
 * Quote-aware for the same reason the tag scan is: a quoted attribute value may contain `>`, and stopping there
 * would cut the tag short and spill its attributes into the surrounding text.
 */
function endOfTag(html, start) {
  let quote;
  for (let i = start + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i + 1;
    }
  }
  return html.length;
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
  return srcsetUrls(value);
}

/**
 * URLs in a `srcset`, by position rather than by shape.
 *
 * The first token of each candidate IS the URL — even when it looks like a descriptor. Filtering
 * descriptor-shaped tokens globally, which is what this did first, discarded a candidate URL literally named
 * `2x` or `640w` and then reported the document as self-contained. Position is the rule; shape is a guess.
 *
 * Commas separate candidates, but a `data:` URI contains one, so the URL is read as a non-whitespace run and a
 * TRAILING comma is what ends a candidate. That keeps `data:image/png;base64,AAA 1x` intact.
 */
function srcsetUrls(value) {
  const urls = [];
  let rest = String(value);
  while (rest.length > 0) {
    rest = rest.replace(/^[\s,]+/, "");
    if (rest === "") break;

    const token = /^\S+/.exec(rest)?.[0] ?? "";
    rest = rest.slice(token.length);

    const endedCandidate = token.endsWith(",");
    const url = token.replace(/,+$/, "");
    if (url !== "") urls.push(url);

    // Without a trailing comma the descriptor follows, and runs to the next comma.
    if (!endedCandidate) rest = rest.slice((/^[^,]*/.exec(rest)?.[0] ?? "").length);
  }
  return urls;
}

/**
 * Every reference in `html` that would require an external fetch.
 *
 * Returns `{ element, attribute, url }` entries, empty when the document is self-contained. Callers should
 * treat a non-empty result as a failure and print it — naming the offending element is the difference between
 * "not self-contained" and something actionable.
 */
export function externalReferences(html) {
  const scanned = liveMarkup(String(html));
  const found = [];

  for (const match of scanned.matchAll(TAG)) {
    const element = match[1].toLowerCase();
    const attributes = LOADERS[element];
    if (attributes === undefined) continue;

    const attrs = match[2] ?? "";
    const applies = CONDITIONAL_LOADERS[element];
    if (applies !== undefined && !applies(attrs)) continue;

    for (const attribute of attributes) {
      // A fallback attribute is inert when the attribute it stands in for is present.
      const preferred = FALLBACK_FOR[attribute];
      if (preferred !== undefined && attributeValue(attrs, preferred) !== undefined) continue;

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
