import { test } from "node:test";
import assert from "node:assert/strict";
import { externalReferences, isSelfContained } from "../scripts/lib/self-contained-html.mjs";

/**
 * The predicate behind "resources/read returns a self-contained template".
 *
 * It was wrong twice in opposite directions, and both times the reason it survived was that it lived inside
 * `scripts/smoke.mjs`, where no unit test could reach it: the only way to exercise it was to run the script
 * against a live server and mutate the real template. So the cases that mattered — a fragment link, a data URI,
 * the string `href=` inside the script — were never tried. Extracting it is the fix for that, and this table is
 * the reason the extraction was worth doing.
 */

const MUST_PASS = [
  ["a bare document", "<!doctype html><html><body><p>hi</p></body></html>"],
  ["an inline script", "<script>const a = 1;</script>"],
  ["an inline style", "<style>body{color:red}</style>"],
  // Review's three false positives, each of which failed the over-broad version.
  ["a fragment link", '<a href="#details">details</a>'],
  ["a data: image", '<img src="data:image/png;base64,iVBORw0KGgo=">'],
  ["href= as text inside the script", "<script>el.outerHTML = '<a href=\"/x\">';</script>"],
  ["src= as text inside the script", "<script>const s = 'src=\"http://x/y.js\"';</script>"],
  ["href= inside a style block", "<style>/* href=\"http://x\" */</style>"],
  ["an empty src", '<img src="">'],
  ["a same-document SVG use", '<svg><use href="#icon"/></svg>'],
  ["a same-document SVG use via xlink", '<svg><use xlink:href="#icon"/></svg>'],
  ["an anchor to an external site", '<a href="https://example.com">docs</a>'],
  // A quoted attribute containing ">" must not derail the tag scan, and must not itself be read as a URL.
  ["an attribute containing a greater-than", '<div data-note=">">x</div>'],
  ["an aria-label containing a greater-than", '<button aria-label="a > b">go</button>'],
  ["an empty srcset", '<img srcset="">'],
  ["a data: URI in srcset", '<img srcset="data:image/png;base64,iVBORw0KGgo= 1x">'],
  // --- Review round 5. Each of these FAILED the previous version. -----------------------------------------
  ["markup inside a comment", '<!-- <img srcset="example.png 1x"> -->'],
  ["a script inside a comment", '<!-- <script src="old.js"></script> -->'],
  ["a hidden input with a src", '<input type="hidden" src="remote.png">'],
  ["a text input with a src", '<input src="remote.png">'],
  ["xlink:href ignored because href is present", '<svg><use href="#icon" xlink:href="legacy.svg#icon"/></svg>'],
];

const MUST_FAIL = [
  ["an absolute script", '<script src="https://cdn.example.com/x.js"></script>', "script"],
  ["a relative script", '<script src="widget.js"></script>', "script"],
  ["a root-relative image", '<img src="/logo.svg">', "img"],
  ["a protocol-relative script", '<script src="//cdn.example.com/x.js"></script>', "script"],
  ["a stylesheet", '<link rel="stylesheet" href="theme.css">', "link"],
  ["an iframe", '<iframe src="https://example.com"></iframe>', "iframe"],
  ["an object", '<object data="thing.swf"></object>', "object"],
  ["an SVG use pulling another file", '<svg><use href="sprite.svg#icon"/></svg>', "use"],
  ["a bare unquoted src", "<script src=widget.js></script>", "script"],
  ["a single-quoted src", "<script src='widget.js'></script>", "script"],
  ["src before other attributes", '<script src="w.js" defer type="module"></script>', "script"],
  ["src after other attributes", '<script defer type="module" src="w.js"></script>', "script"],
  // --- Review round 4. Each of these passed the previous version. ---------------------------------------
  // srcset fetches, and was not inspected at all.
  ["a bare srcset with no src", '<img srcset="logo.png 1x">', "img"],
  ["a srcset on <source>", '<source srcset="logo.png 2x">', "source"],
  // The tag scan stopped at the ">" inside the quoted value, so src was never seen. Ordinary markup.
  ['a quoted ">" before the src', '<script data-note=">" src="widget.js"></script>', "script"],
  ["an aria-label with > before the src", '<img aria-label="a > b" src="/logo.svg">', "img"],
  // blob: names an entry in the creating context's Blob store; it does not carry its bytes.
  ["a blob: script", '<script src="blob:abc-123"></script>', "script"],
  // A fragment is not read as the resource for a loader: it resolves against the document URL.
  ["a fragment as a script src", '<script src="#payload"></script>', "script"],
  ["a fragment as an img src", '<img src="#icon">', "img"],
  ["a video poster", '<video poster="thumb.jpg"></video>', "video"],
  // A candidate URL whose whole name looks like a descriptor is still the URL: position, not shape.
  ["a srcset URL named 2x", '<img srcset="2x">', "img"],
  ["a srcset URL named 640w", '<img srcset="640w">', "img"],
  ["a second srcset candidate", '<img srcset="data:image/png;base64,AAA 1x, other.png 2x">', "img"],
  // An image-button input DOES load.
  ["an image-button input", '<input type="image" src="remote.png">', "input"],
  // xlink:href is consulted when href is absent.
  ["xlink:href alone pulling a file", '<svg><use xlink:href="sprite.svg#icon"/></svg>', "use"],
];

test("a self-contained document is not reported as external", () => {
  for (const [label, html] of MUST_PASS) {
    const refs = externalReferences(html);
    assert.deepEqual(refs, [], `${label} should be self-contained, got ${JSON.stringify(refs)}`);
    assert.equal(isSelfContained(html), true, label);
  }
});

test("every reference that requires a fetch is reported, with the element that causes it", () => {
  for (const [label, html, element] of MUST_FAIL) {
    const refs = externalReferences(html);
    assert.equal(refs.length, 1, `${label} should report exactly one reference, got ${JSON.stringify(refs)}`);
    assert.equal(refs[0].element, element, `${label} should name <${element}>`);
    assert.equal(isSelfContained(html), false, label);
  }
});

test("the real reconciliation template is self-contained", async () => {
  // Checked against `renderTemplate()`, which is the exact function `server.registerResource` serves as the
  // resource body — not a copy of the markup that a test happened to inline. So a future edit adding a CDN
  // reference fails here, in the unit suite, rather than only in a live smoke run against a deployment.
  const { renderTemplate, RECONCILE_TEMPLATE_URI } = await import("../dist/ui/reconciliation.js");
  assert.equal(RECONCILE_TEMPLATE_URI, "ui://reai/reconciliation");

  const body = renderTemplate();
  assert.ok(body.length > 1000, `template came back as ${body.length} chars`);
  assert.match(body, /<script/i, "no script at all would mean the view cannot render");
  assert.deepEqual(
    externalReferences(body),
    [],
    "the shipped template now requires an external fetch, so the view would render blank in a sandbox",
  );

  // And the predicate must be capable of failing on this document, or the assertion above is decoration.
  assert.equal(
    externalReferences(body.replace("<script>", '<script src="widget.js"></script><script>')).length,
    1,
    "injecting a relative script into the real template was not detected",
  );
});
