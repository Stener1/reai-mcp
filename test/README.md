# Auditing these tests for vacuity

Three times in one day a guard in this repository turned out to do less than the comment above it
claimed: a documentation check that read one file and would have passed if the tables moved, a
count check whose band was satisfied by the wrong number, and an enum check that skipped every
enum nested inside an array. Each was found by review rather than by the suite, and each had the
same shape — **an assertion over a filtered collection, with nothing asserting the filter still
matched anything.**

That class is mechanically detectable. This is the method, so it can be repeated rather than
rediscovered.

## The method

Empty the corpora the sweeps examine, at the `dist/` boundary, and see which tests still pass. A
test that examines the tool registry and passes when the registry is empty is asserting something
about the empty set.

```sh
# 1. A throwaway copy, so the real checkout is untouched.
D=$(mktemp -d) && tar -c --exclude=node_modules --exclude=.git . | tar -x -C "$D"
ln -s "$PWD/node_modules" "$D/node_modules" && cd "$D" && npm run build

# 2. Baseline: what passes normally.
node --test test/ 2>&1 | grep -E '^ok [0-9]+ -' | sed 's/^ok [0-9]* - //' | sort > /tmp/baseline.txt

# 3. Empty the corpora in dist. The exports are arrays, so appending statements that clear them
#    empties every consumer at the module boundary, after registration has run:
#      allTools.length = 0; registeredTools.length = 0;
#      for (const k of Object.keys(TOOL_GROUPS)) TOOL_GROUPS[k] = [];
#      QUIRKS.length = 0; escalatingBodyFieldNames.length = 0;
#      alwaysOnTools.length = 0;   // omitted from the first three runs; it survives with 7 tools,
#                                  // which is the only reason `orientation and the escape hatch are
#                                  // never groupable away` appeared as a candidate at all
#
#    NOT a registry corpus, and the audit missed it entirely for three runs: the SPEC INDEX. With
#    spec/index.json's `operations: []`, 752 of 859 tests still pass, and two sweeps in
#    spec.test.mjs were vacuous — one read the precomputed `counts` instead of the array it claims
#    to cover, the other used the same filter as its neighbour twelve lines up without the
#    `exposed.length > 0` that neighbour carries. Empty this too:
#      node -e "const j=require('./spec/index.json'); j.operations=[]; require('fs').writeFileSync('./spec/index.json', JSON.stringify(j))"
#
#    A compiled file ends with `//# sourceMappingURL=...` and NO trailing newline, so a bare
#    `>>` append lands inside that comment and does nothing. Write a newline first. This is not a
#    footnote: it silently invalidated the second run of this audit, which reported two floors as
#    firing when the corpus they guard had never been emptied. Assert the corpus is empty before
#    trusting a single result:
#      node -e "import('./dist/reai/quirks.js').then(m=>console.log(m.QUIRKS.length))"  # must be 0

# 4. Still passing WITH the corpus gone, and referencing a corpus. Both halves matter: `comm -12`
#    alone is the ~600 tests that pass either way, virtually none of which touch the registry.
node --test test/ 2>&1 | grep -E '^ok [0-9]+ -' | sed 's/^ok [0-9]* - //' | sort > /tmp/empty.txt
comm -12 /tmp/baseline.txt /tmp/empty.txt > /tmp/survivors.txt   # passed before AND after
comm -23 /tmp/baseline.txt /tmp/empty.txt                        # broke: the corpus really was emptied
#    Then keep only the survivors whose test body names a corpus — this is the step that takes ~600
#    down to the reported handful, and it was NOT mechanised in the first version of this recipe, so
#    the "thirty sweeps" headline was not reproducible from it. A reconstruction that splits each
#    file on /^test\(/ and greps the body for a corpus name gives 28 at the first commit, not 30.
```

Note two things about the copy in step 1. `--exclude=.git` makes `no symlink is tracked in git` and
`no gitlink is tracked in git` fail in the BASELINE — expected, not a broken copy. And the numbers in
this file come from `tar -c | tar -x` plus `node --test test/` on macOS with Node 20.

Then read each candidate. Not every one is a defect: a test of policy arithmetic legitimately
never touches the registry, and `tool names are unique` cannot be broken by a filter narrowing.
The ones that matter are those whose **filter is a name prefix, a risk tier or a boolean flag** *in
the unsafe direction* — where a rename makes the sweep examine FEWER things. A narrowing that makes
it stricter (`every curated tool declares the API paths it calls` exempts a fixed list of six names;
losing a name means one more tool is required to declare) needs no floor, and the unqualified rule
would wrongly demand one.

**Emptying a corpus tests a floor's denominator, not its predicate.** A floor can pass this audit
and still be unable to catch the drift it names — `every tool that deletes is annotated destructive`
filtered on `reai_delete_` prefix OR `DELETE` method, and since no tool matched the prefix without
also matching the method, renaming every `reai_delete_*` left the count unmoved. The acceptance bar
is *observed failing under a mutation of the filter's own key*, not under an emptied corpus.

## What the first run found

Thirty sweeps passed with every corpus emptied. Five had fragile filters and got the first floors:

| sweep | filter that could stop matching |
|---|---|
| `every tool that deletes is annotated destructive` | `reai_delete_` prefix / `DELETE` method |
| `a getter that takes one record id calls it id` | `reai_get_` prefix **and** `risk === "read"` |
| `a transmitting tool names both switches it needs` | the `transmits` flag |
| `no access tool can grant, change or revoke access` | absence claim over `/api/users` paths |
| `no curated salary tool can complete a run` | absence claim over `/api/salary` paths |

The last two are **absence** claims — "no tool reaches this" — and for those the floor is not a
count of offenders but a count of the population being constrained. "No salary tool completes a
run" is satisfied by there being no salary tools at all, which is exactly what it would read the
day the toolset fails to register.

## What the second run found, and the claim it refuted

The paragraph that stood here said the remaining twenty-five were left alone deliberately, because
"they iterate the whole registry without a narrowing filter". **That was wrong, and it was wrong in
the same way as the guards this audit exists to find: asserted rather than measured.** Grepping the
twenty-five for narrowing constructs found fifteen that do narrow — by risk tier, by name prefix,
or by a `.filter()` — including two of the safety invariants and the read-shape sweep that had
already caught a real bug in the loans toolset.

Seven more now carry a floor:

| sweep | filter that could stop matching |
|---|---|
| `anything creatable in reversible mode is also deletable in it` | mode visibility **and** `reai_create_` prefix |
| `every delete tool's endpoint is classified no worse than the tool claims` | `reai_delete_` prefix |
| `no read tool gives the same answer for an empty list and a shape surprise` | `risk === "read"` |
| `and the rows are not thrown away either` | `risk === "read"` |
| `no read tool accepts an input it never sends` | `risk === "read"` |
| `no tool is softer than the policy for any path it declares` | declared paths classifying `irreversible` |
| `a curated tool accepting an arms-a-send field escalates like the escape hatch` | `escalatingBodyFieldNames` |

### A population floor is not always the right floor

The independent review of this PR found the next layer down. Three of these sweeps can **skip** a
tool at runtime — the stub never reached the request, the tool states no count, the handler refused
the argument combination locally — and a floor on the filtered population says nothing about that.
Breaking tenant resolution in one line took the preflight sweep from 52 tools examined to 7, and it
passed, floor and all, because the 76 read tools were still there to be counted.

So for those three the floor counts **what the sweep actually exercised**, not what it selected:
tools compared (31 of 42 — stated as 41 first, and a measured number stated wrongly in a document
about measuring is worth naming), tools that echoed the payload (51 of 68), tools that reached the
request (39 of 52). Verified against a realistic regression — every `reai_list_*` handler returning without
calling the API — where all three fail and the population floors did not.

The question to ask of any floor: *if the thing this test examines silently stopped happening, would
this number change?* A count of the population answers no. A count of the work answers yes.

Searching the rest of the suite for the same shape — a `continue` on a runtime or spec-derived
condition rather than on a property of the tool — turned up four more sweeps and two things worth
knowing:

- **`archive.test.mjs` was already right**, and better than a floor: it asserts `checked === 11`
  exactly, so both a loss and an unnoticed gain fail.
- **The two payment-destination sweeps had no floor at all.** Renaming the whole routing field set
  makes both examine zero operations and pass. They now floor at 8 of 11. Stated precisely, because
  the first version of this note overclaimed: that same rename fails *seven other tests* in the file,
  so the floors are defence in depth for the pair rather than a hole in the payment guard.
- **`replacement-clears.test.mjs`** floors the spec-derived population its two sweeps share (4 PUTs
  carrying a destination, 3 that can clear one by omission).

One more mistake worth recording, since it is the same error a third time: the first floor written
here was `>= 12`, from instrumenting the shared helper and counting **16** — the helper is called by
four tests, so that was four times the real population of 4. The floor failed immediately on a green
tree, which is the only reason it was caught. **Instrument the value the test uses, not the number of
times a line runs.**

### Floors go stale

`policy.test.mjs` floored its escalating-fields census at 14 against a measured 16. The census is 25
now, and the mixed-risk count 18 against a floor of 9 — 56% and 50%, back to catching only the
collapse the tightening was meant to rule out. Nobody loosened them; the codebase grew around them.
Re-measure when adding tools of the kind a floor counts, and state today's number in the message so
the drift is visible in the failure rather than buried in a comment.

### Choosing the threshold

A floor at 1 only catches total collapse, which the rest of the suite already catches. The rule used
here is **⌊0.75 × the measured population⌋**, so a filter losing a quarter of its matches still
passes but a halving fails. That mattered: four of the first floors were written by eye and came out
at 29–39% of their population — `/api/users` paths at 2 of 7, `reai_get_*` read tools at 8 of 25,
read-tier tools at 30 of 76, irreversible declared paths at 20 of 51. A regression turning half the
read tools into writes would have sailed past all of them. **A floor low enough to survive the
regression it is meant to catch is decoration**; the populations are now measured and the floors sit
at 16/22, 17/23, 18/25, 5/7, 38/51 and 10/12 — that last one 83%, because ⌊0.75 × 12⌋ = 9 would sit
below a population this small usefully allows.

Two are not floors at all but **pins**: `transmits` at 3 of 3 and `escalatingBodyFieldNames` at 3 of 3.
Deliberately removing the last transmitting tool fails them with "the filter has stopped matching",
which is a false diagnosis of a correct change. They are kept because the alternative — no guard on a
population of three — is worse, but the next person to un-curate `reai_credit_invoice` should expect
to edit the test, not to have found a bug.

The recalibration reached three pre-existing floors too, since the same argument applies to them:
`writeOperations` at 20 of 67 and the query sweep at 10 of 18 in `spec-bounds.test.mjs`, and
`withRouting` at 10 of 19 in `payment-routing.test.mjs`. One reported as slack was not:
`escalatingFieldNames` measures 13, so its floor of 12 is 92%.

**This idiom is older than this note.** `archive.test.mjs` pins exactly (`checked === 11`) and says a
floor of 8 "left three tools' worth of slack to disappear into"; `spec-bounds.test.mjs` uses 100 of
124 for the same reason. The stricter standard already applied in this suite before it was written
down here — and the first floor this audit produced, `examined >= 8` against 25, is literally the
number `archive.test.mjs` names as the bad example.

All twelve floors were then checked to fire with every corpus emptied. That check caught two floors
landing in the wrong place — one written into the neighbouring test, one swallowed by the
`sourceMappingURL` line. But it is a weaker bar than it sounds: see the note above on the denominator.
**A floor that has not been observed failing under a mutation of its own filter key is a claim, not a
guard.**

## What is genuinely left alone

Twenty-two sweeps still pass with every corpus emptied (a mechanised reconstruction gives 20 — the
difference is which bodies count as "references a corpus", not a disagreement about any one test).
**Three of them narrow.** An earlier version of this section said eight and then listed examples of
the non-narrowing kind, so the three that matter were never named. They are:

- `no curated tool is more permissive than the escape hatch would be` — narrowed on `if (!tool.apiPaths)
  continue`, which an empty array satisfies. That was a real hole, not a bucketing question: an
  irreversible delete tool with `apiPaths: []` and its risk downgraded to `reversible` passed the whole
  suite except one documentation count. Fixed, not filed.
- `every curated tool declares the API paths it calls` — narrows on an exempt list of six names, in the
  safe direction: losing a name makes the sweep stricter. No floor; this is the exception the rule needs
  a direction qualifier for.
- `every curated tool's declared apiPaths still resolve` — narrows on `if (!method || !path) continue`.
  If `apiPaths` entries ever became objects rather than tuples, every entry is skipped and it passes.
  Left alone deliberately: `apiPaths` being tuples is asserted directly elsewhere, and a floor here
  would duplicate that.

The buckets the rest fall into:

- **Whole-corpus sweeps** (`tool names are unique`, `every tool declares a risk the policy knows`,
  `declared API paths exist in the spec`, the toolset-selection tests). Their only route to vacuity
  is an empty registry, and an empty registry fails 263 tests in this suite — measured, not assumed.
  A floor here adds nothing a caller would ever see.
- **Audits of hand-written lists** (`every DELIBERATELY_LOOSER entry is real`, `every
  RENAMED_QUERY_ARGS entry is a real rename`). An empty list means there is genuinely nothing to
  audit; a floor would forbid removing the last exemption. Both lists are `{}` today, so **those two
  tests currently assert nothing** — correct behaviour, but say it plainly rather than leaving
  "audits of hand-written lists" to imply the lists exist.
- **Deliberate-omission claims** (`generate-due is deliberately not curated`, `the Nordnet import is
  uncurated on the record`). These assert a tool is absent, so an empty registry satisfying them is
  not a false pass — the corresponding presence is pinned by the count tests.

The distinction that matters is not "does it filter" but **can the filter stop matching while the
software is still working**. A risk tier or a name prefix can; an exemption list cannot.
