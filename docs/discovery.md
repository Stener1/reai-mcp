# Discovery, and why it has to work in Norwegian

The escape hatch is only as good as the search in front of it: a query that returns nothing strands an
agent. What follows is the measurement rather than the intention, and the four causes that were fixed.

Discovery works in Norwegian, which for this API is not a nicety. Measured on one set of 31 realistic queries — 21 Norwegian, 10 English — before and after: **14 found before, 31 after**, top-three 12 → 28, and nothing ranked worse. `lønnskjøring` returned zero results while `lonn` was already a synonym; *"hvor mye lager har vi"* returned the chart of accounts.

Two causes. Most of the everyday vocabulary was missing. And Norwegian glues nouns together, so the word a user types is often a compound whose meaning lives in one half — `lønn+kjøring`, `vare+lager`, `lager+beholdning` — which no plural or diacritic rule reaches. Compound stems are matched at a word boundary with at least two characters left for the other element, because an unanchored search found `lønn` inside `kolonner` and `belønning`, and `lager` inside `slager`; `lønnsomhet` shares a root rather than merely containing one and is listed as an exception. `test/discovery-norwegian.test.mjs` holds the measurement, asserts English **ranks** rather than mere presence, and asserts that word order does not change the answer.

A third cause, found later: the table was **almost all nouns** — it held a handful of verbs (`avstemme`, `reconcile`, `signing`, `owes`) and none for any action endpoint. Of the 65 distinct trailing segments after a path placeholder, roughly 25–30 are actions — `/{id}/approve`, `/{id}/deliver`, `/{id}/depreciation`, `/{id}/close` — and not one had a Norwegian verb, so *"godkjenn utlegg"* ranked `/api/expenses` first and the endpoint that approves the claim fifth.

Three of the words had to come back out, all homographs and all found by review: `aktiver` is the balance-sheet noun for **assets** as well as "activate", `avslutt` means **terminate** a contract rather than close a period, and `levere` is how a Norwegian **files a return** — that one took three filing queries the ranker had answered correctly and pointed them all at an expense claim. The expense sense survives as a phrase mapping, where the object of the verb can be seen. The action vocabulary is enumerated from those segments rather than from any benchmark's phrasing, and covers both the imperative and the verbal noun, since a Norwegian query uses either.

A fourth cause, and the plainest: **the definite article is a suffix in Norwegian, and nobody speaks in the indefinite.** People say *"send fakturaen"*, *"endre kunden"*, *"si opp leieavtalen"* — not *"send faktura"*. Most definite forms already resolved by accident, because the compound-stem rule finds `faktura` inside `fakturaen`; but it needs two characters left over, and the commonest noun class ends in `-e` and takes a single `-n`. So `kunden`, `ordren`, `leieavtalen` and `husleien` resolved to **nothing at all** — 19 of the table's keys, which numbered 176 when that was measured and 198 since the loan vocabulary was added. (An earlier version of this sentence said "a quarter of the synonym keys", which overstated it: 44 keys end in `-e`, but 25 of those are verbs, adjectives, English nouns or plurals with no definite form at all.) `-n` and `-ne` rules cover that class now — firing **only when the stripped stem is a word the table knows**, because blind stripping turned `documentation` into `documentatio` and made one word count twice, ranking document endpoints above products for *"product documentation"*. The property is asserted the same way word-order independence is: inflection must not change the answer. A stem-changing definite (`anleggsmiddel` → `anleggsmidlet`) is still out of reach, and the test says so rather than omitting the case. The larger **`-en`/`-et` consonant-stem class** — `utgiften`, `beholdningen`, `kontoen`, `dokumentet`, `vedlegget` — was added afterwards behind the same gate, which is what made extending it cheap: the stripped stem must already be a key, so `token`, `given` and `budget` derive nothing.

**Three corpora, each measured once before being tuned against, and each retired to a regression floor afterwards** — because a benchmark you have read the failures of is no longer measuring anything:

All three live in `test/discovery-heldout.test.mjs` (`CASES`, `FRESH`, `EVERYDAY`); `test/discovery-norwegian.test.mjs` holds a separate 31-case set, 28 of them top-3, which asserts English **ranks** and word-order stability.

| corpus | before this work | after fixing only the queries that returned NOTHING | now |
|---|---|---|---|
| first (`CASES`, 41) | 17 | — | **39** top-3, 41 top-10 |
| second (`FRESH`, 28) | 19 | 23 | **26** top-3 |
| third (`EVERYDAY`, 27) | 14 | 18 | **19** top-3, 24 top-10 |

What the action vocabulary generalises to is **+2 of 28 on the corpus it was not fitted to** — the same +2 it bought on the one whose failures I had read, which is the comparison worth quoting. What moved all three further was routing the words through the tables that decide **method**: the vocabulary expanded to the right path segment and then lost to three `GET`s, because nothing in the query said a write was wanted. *"aktiver abonnement"* ranked `/activate` fifth; it ranks first now. A change that lifts the corpus you tuned against **and** the two you did not is the shape a general improvement has.

The rule held across all three: a query that returns **nothing** strands an agent and is worth fixing; a query that returns the right endpoint at rank five is not worth tuning for. Five of the third corpus's thirty targets named endpoints that do not exist — the fourth time in this work that a "ranking failure" was really a wrong assumption about the API.

## What did a ranking change do to every other query?

```bash
npm run sweep:discovery -- --against main
npm run sweep:discovery -- --baseline /tmp/some-built-checkout   # faster for several variants
```

It extracts the revision with `git archive`, builds it, rebuilds HEAD, and compares ~69,000 generated queries
against what HEAD answers. The npm script runs `npm run build` first because it imports HEAD's `dist/`: without
that, editing `src/reai/spec.ts` and forgetting to build compares a fresh baseline against stale output and
prints zero changes in every category — a false clean, which is the worst thing this tool could do. This exists because of a repeated failure rather than a hypothetical: **three PRs in a row added
a synonym or a phrase rule, swept it, reported the sweep, and had an independent review find an over-match the
sweep had not covered.**

| PR | what over-matched | the dimension that found it |
|---|---|---|
| #120 | `krediter → credit-note` moved "krediter faktura" off the operation that *creates* a credit note onto the one that applies an existing one | the synonym table's own keys, crossed with nouns |
| #122 | a demotion made "Apply a manual credit note to an invoice" return the DELETE that *unapplies* it | each endpoint's own **summary** as a query |
| #125 | `inngående + faktura` swallowed "endre inngående faktura"; `faktura + abonnement` erased the invoice family from "vis faktura for abonnementet" | adjective × noun, and noun × noun in both orders |

Each time the harness was rebuilt by hand in a scratch directory, differently and covering less. The
dimensions are not clever — they are simply the ones that have caught something — so they are committed and
`test/discovery-sweep.test.mjs` asserts that none of them silently disappears.

Four numbers come back. **Rank-1 changes** is the headline and the least informative alone. **Answer no longer
reachable** is the baseline's top result absent from the new window — the measure two CHANGELOG entries got
wrong by counting *empty result sets* instead, which with no score floor in `searchOperations` can never happen
and so was always zero. **Newly answered** was nothing and is now something. **Writes newly at rank 1** is
split out by risk, because a query stating no intent to write and handed an irreversible or
externally-transmitting operation is the failure this repository treats as most serious.

Verified by reconstructing each defect and reading what the output actually names — the first version of this
section claimed the dimensions "would have caught" all three, and an independent review refuted that for two of
them, because `rankOneChanged` printed a count and no query:

| reconstruction | what the sweep names |
|---|---|
| #125's unscoped `faktura + abonnement` | 24 rank-1 changes, **24 lost answers**, naming `fakturagebyr abonnement` and `fakturalinjer for abonnement` |
| #122's general demotion | the inversion itself: `POST …/manual-credit-note-applications → DELETE …/{creditNoteInvoiceId} [irreversible]` |
| #120's global exact-compound | the `krediter` over-match, on 9 lines. **`diett` is not named** — generated, but its ranking change is not one the report surfaces |

The #122 case is why there is a **risky new answers** category at all: that inversion is write-to-write, which
`writesPromoted` deliberately excludes, so the defect appeared only inside an unnamed count of 346. A rank-1
target that is irreversible or transmitting is now named whatever the previous method was.


### What it does not cover, stated rather than discovered later

- **Only 146 of 430 operations have a `summary`**, so the endpoint-summary dimension covers about a third of the
  surface.
- **109 operations are internal** and `searchOperations` excludes them, so a ranking change confined to those is
  invisible; their path segments still generate queries, which is part of why 489 of the corpus return nothing.
- The four categories **overlap by design** — one query can appear in three — so they must not be summed. The
  "24 rank-1 changes and 24 lost answers" above is the same 24 queries counted twice.
- `NOUNS` is curated and thin in some domains; the synonym-key dimension is what covers the rest, and it is
  derived from the table rather than hand-copied for exactly that reason.
- Both spellings of `å` are kept deliberately. They fold to the same tokens, so for TERM matching they are
  redundant — but `PHRASE_SYNONYMS` matches raw text **before** folding, and #125 needed `inngaaende` added to a
  phrase rule for precisely that reason. Dropping them would stop the sweep noticing the next missing spelling.

Nothing it prints is automatically a regression: a phrase rule narrowing a query to the family it names shows
as "no longer reachable" for the family it replaced. Read the lines rather than counting them.

## More than half the API documents nothing, and that is not fixable from this end

Measured 2026-08-09: **178 of the 321 public operations carry neither a summary nor a description.** Not "thin prose" — nothing at all. `POST /api/agreements/rent-agreement` and its four sibling templates are among them.

That matters because the scorer's haystacks include the summary (weight 4) and the description (2) on top of the path (6). A documented operation is scored on strictly more evidence than an undocumented one, so **ranking is biased toward whatever ReAI happened to write prose about, independent of which endpoint is right.** The clearest case: every one of "create agreement", "opprett avtale" and "create lease agreement" answers with

```
19  POST /api/agreements/{id}/sign-request            irreversible / external
18  POST /api/agreements/{id}/sign-requests           irreversible / external
16  POST /api/agreements/{id}/sign-requests/{id}/send irreversible / external
16  POST /api/agreements/accounting-services          reversible / none
16  … and the other four creation templates, tied
```

The signing call wins because its summary says "Send agreement signing **requests**" and its description opens "**Creates** one signing request…" — so it matches both query terms, while the endpoints that actually create an agreement match only `agreement`, from the path. An agent asking to create a contract is offered three ways to email a counterparty first.

### Two fixes were tried and neither is the answer

**Deriving a phrase from method and path** for the 178 bare operations, so ranking could see the verb a path cannot carry (`create agreements rent agreement`). The naive form double-counts: the derived text restates resource words the path already scores at 6, and it displaced five known-good answers — `finn kunde amelding` moved to `/api/customers` from `/api/ledger/customer`, `gjeld til leverandør` lost first place, a salary run fell to rank 7. Constraining it to contribute **only terms the path lacks**, with no phrase bonus, brought regressions to zero. Then the benefit was measured across all 178 bare operations, querying each by its own natural phrasing: **one improvement, one regression.** The verb is already supplied by write intent and implied methods, and the resource by the path, so the derived field earned nothing and was dropped rather than kept as plausible-looking machinery.

**Demoting the nested action.** There is already a rule for "an irreversible or transmitting action hanging off a resource, where the query does not name the action" — which is this case exactly. It does not fire, for two independent reasons, both recorded at the demotion site in `src/reai/spec.ts`. `sign-request` is hyphenated and the rule is deliberately scoped to single-word segments (PR #122's reviews rejected the general form; a test pins it). And even with that scope widened the cut is only ×0.9, because `familyOffersNonNested` compares `familyOf` values and `familyOf` truncates at the first `{param}` — so `/api/agreements/{id}/sign-request` sits in family `/api/agreements` while `/api/agreements/rent-agreement` is its own family. **The check that asks "is there a better alternative?" cannot see the five alternatives.**

That last sentence is the real defect, and it is not in the demotion rule. Fixing it means widening the family notion to the resource root — which is the "register ancestors" change PR #122 rejected on separate evidence, so it needs its own measurement rather than being smuggled in.

What made the live case safe in the meantime was not ranking at all: `reai_create_agreement` now exists, so an agent has a curated tool and does not depend on the search result. The ranking bias remains for the 60 bare operations no curated tool covers.
