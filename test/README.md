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
#
#    A compiled file ends with `//# sourceMappingURL=...` and NO trailing newline, so a bare
#    `>>` append lands inside that comment and does nothing. Write a newline first. This is not a
#    footnote: it silently invalidated the second run of this audit, which reported two floors as
#    firing when the corpus they guard had never been emptied. Assert the corpus is empty before
#    trusting a single result:
#      node -e "import('./dist/reai/quirks.js').then(m=>console.log(m.QUIRKS.length))"  # must be 0

# 4. Anything still passing that mentions a corpus is a candidate.
node --test test/ 2>&1 | grep -E '^ok [0-9]+ -' | sed 's/^ok [0-9]* - //' | sort > /tmp/empty.txt
comm -12 /tmp/baseline.txt /tmp/empty.txt
```

Then read each candidate. Not every one is a defect: a test of policy arithmetic legitimately
never touches the registry, and `tool names are unique` cannot be broken by a filter narrowing.
The ones that matter are those whose **filter is a name prefix, a risk tier or a boolean flag**,
because those stop matching after an ordinary rename.

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

### Choosing the threshold

A floor at 1 only catches total collapse, which the rest of the suite already catches. The rule used
here is **⌊0.75 × the measured population⌋**, so a filter losing a quarter of its matches still
passes but a halving fails. That mattered: four of the first floors were written by eye and came out
at 29–39% of their population — `/api/users` paths at 2 of 7, `reai_get_*` read tools at 8 of 25,
read-tier tools at 30 of 76, irreversible declared paths at 20 of 51. A regression turning half the
read tools into writes would have sailed past all of them. **A floor low enough to survive the
regression it is meant to catch is decoration**; the populations are now measured and the floors sit
at 16/22, 17/23, 18/25, 5/7, 57/76, 38/51, 10/12, and 3/3 where the population is the whole list.

All twelve floors were then checked to fire: with every corpus emptied, each of the twelve fails.
That check is the only reason the two floors landing in the wrong place — one written into the
neighbouring test, one swallowed by the `sourceMappingURL` line — were caught at all. **A floor
that has not been observed failing is a claim, not a guard.**

## What is genuinely left alone

Twenty-two sweeps still pass with every corpus emptied. Eight of them narrow, and each was checked
individually rather than as a group:

- **Whole-corpus sweeps** (`tool names are unique`, `every tool declares a risk the policy knows`,
  `declared API paths exist in the spec`, the toolset-selection tests). Their only route to vacuity
  is an empty registry, and an empty registry fails 263 tests in this suite — measured, not assumed.
  A floor here adds nothing a caller would ever see.
- **Audits of hand-written lists** (`every DELIBERATELY_LOOSER entry is real`, `every
  RENAMED_QUERY_ARGS entry is a real rename`). An empty list means there is genuinely nothing to
  audit; a floor would forbid removing the last exemption.
- **Deliberate-omission claims** (`generate-due is deliberately not curated`, `the Nordnet import is
  uncurated on the record`). These assert a tool is absent, so an empty registry satisfying them is
  not a false pass — the corresponding presence is pinned by the count tests.

The distinction that matters is not "does it filter" but **can the filter stop matching while the
software is still working**. A risk tier or a name prefix can; an exemption list cannot.
