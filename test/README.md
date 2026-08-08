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

# 3. Empty the corpora in dist: allTools, registeredTools, TOOL_GROUPS, QUIRKS.
#    (Rewrite each `export const X = [...]` to `export const X = [];`.)

# 4. Anything still passing that mentions a corpus is a candidate.
node --test test/ 2>&1 | grep -E '^ok [0-9]+ -' | sed 's/^ok [0-9]* - //' | sort > /tmp/empty.txt
comm -12 /tmp/baseline.txt /tmp/empty.txt
```

Then read each candidate. Not every one is a defect: a test of policy arithmetic legitimately
never touches the registry, and `tool names are unique` cannot be broken by a filter narrowing.
The ones that matter are those whose **filter is a name prefix, a risk tier or a boolean flag**,
because those stop matching after an ordinary rename.

## What the first run found

Thirty sweeps passed with every corpus emptied. Five had fragile filters and now carry a floor:

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

The remaining twenty-five were left alone deliberately: they iterate the whole registry without a
narrowing filter, so the only way to empty them is to empty the registry itself, which would fail
dozens of other tests first. Adding floors there would be ritual rather than protection.
