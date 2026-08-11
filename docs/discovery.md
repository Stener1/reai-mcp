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

## Sentence-length queries, and the `legg til` gap they found

A third corpus, `test/discovery-heldout-sentences.test.mjs`: 20 whole sentences of the kind an accountant
would type at an agent ("hvor mye skylder kundene meg", "book a supplier invoice to an expense account"),
written before looking at what the ranker did with any of them. The two older sets are mostly single terms
and short phrases, so what is new here is sentence LENGTH — filler words, subordinate clauses and
prepositional phrases around the resource word.

Not question forms, which the first version of this claimed: `test/discovery-heldout.test.mjs` already
holds "hvor mye skylder vi leverandørene", "hva er neste fakturanummer" and "hvilke varer er på lager",
and `src/reai/spec.ts` says so in its own words. One of the new cases is a near-duplicate of an existing
one.

**15 of 20 at rank 1, 18 of 20 in the top 3**, after one fix (13 and 16 before it). All five that are not
at rank 1 are named in that file with their causes.

### The fix: `legg til` is a write, and was not recognised

`legg til` is the commonest Norwegian way to say *add*. Measured before the change:

| query | rank of the write it asks for, before |
|---|---|
| `legg til en leverandor` | POST `/api/suppliers` **11th** — nine GETs and `DELETE /api/suppliers/{id}` ahead of it |
| `legg til en ny kunde` | POST `/api/customers` **5th**, behind four customer GETs |
| `opprett en ny kunde` | rank 1 |

The first version of this table said 5th and 3rd. Both were measured with a **path-only** comparison, so
they were the ranks of the GET on the same path — the identical inflation recorded two sections down. The
supplier case is sharper than the number I published: a `DELETE` outranked the create.

So the gap was purely which synonym the caller happened to use. It went into `PHRASE_INTENT` rather than
`METHOD_INTENT` for the reason `lag` is excluded from the latter: bare `legg` is not a create request, but
the two-word phrase is unambiguous — the same argument `last opp` already rests on.

**Imperative and infinitive only** — `legg til`, `legge til`. Two conjugations are excluded, and the second
one had to be found in review:

- `lagt til` is the past participle. "hvor mange kunder ble lagt til i fjor" asks about history, and matching
  it would offer a POST in answer to a question — the trap that keeps `make`, `cancel`, `new` and `start` out
  of `WRITE_INTENT_VERBS`. Excluded from the start.
- `legger til` is the present tense, and the first version matched it **while claiming present tense was
  unambiguous**. It is not: a present-tense verb turns up inside a relative clause of an explicit read
  request.

      vis kunder vi legger til i år          ->  POST /api/customers
      vis leverandorer vi legger til i år    ->  POST /api/suppliers/{id}/unarchive

  `vis` is as plain a read verb as exists, and the phrase beat it, because `writeIntent` is evaluated before
  `readIntent` so that a query holding both reads as a write. The supplier case is worse than a wrong
  resource: it offers to **unarchive** a supplier in answer to "show me". Dropping `er` fixes both and costs
  nothing measurable — "jeg legger til en kunde" is a statement about what the speaker is doing, not a
  request.

Two idioms are excluded by lookahead for the same reason, and they are commoner in accounting prose than
either conjugation above: **`legge til grunn`** ("to base on", "to assume") and **`legge til rette`** ("to
facilitate"). Both contain the phrase contiguously, and both promoted *irreversible* writes over a read —
"hvilket beløp skal jeg legge til grunn for mva" offered `POST /api/vat-returns/reopen` in answer to a
question about which figure to use.

And the phrase is recognised only **contiguously**, which is a real limitation rather than a decision:
Norwegian separable particles allow an object in between, so `legg kunden til` and `legger vedlegget til
ordren` still rank reads. So does `legg inn`, an equally common "enter". Covering those needs particle
handling, not another table entry.

### Two measurement errors worth recording, both mine

- **The harness, not the ranker.** The first run scored **0 of 20** with all twenty queries returning the
  same three operations. `searchOperations` takes one options object and had been called positionally, so
  every query ran as the empty string. A total ranking collapse and a broken probe look identical; the tell
  was that the results never varied.
- **Scoring on the path alone inflates by two.** `lag et tilbud til en kunde` targets POST `/api/offers`,
  the ranker returns GET `/api/offers` first, and a path-only comparison counted that as rank 1 — passing
  the very case the corpus existed to record. A method is half of what an agent needs.
- **Two agreeing phrases were treated as competing.** `phraseMethodsFor` discarded its hint whenever two
  entries matched, which was indistinguishable from "one phrase only" while `last opp`/`last ned` were the
  whole table. With a second POST phrase in it, "last opp og legg til vedlegg" — the natural way to ask for
  both — matched twice, lost the hint, and inverted its whole top three from writes to reads. Fixed by
  intersecting the matched method sets: two phrases naming the same method are one statement made twice,
  and the original reasoning applies only when they disagree.
- **`-1 <= 2` is true.** The assertion pinning the one known miss in the top three read
  `rankOf(...) <= 2`, and `rankOf` returns `-1` for a target outside the ten-result window — so it passed
  when the operation was **entirely absent** while claiming it stayed in the top three. Found in review, in
  a test written to guard against exactly this.

And two of the original labels were simply worse than what the ranker returned: `change a customers
address` → PUT `/api/customers/{id}/address`, and `hvilke varer har jeg pa lager` → GET
`/api/warehouses/inventory`. Both are the endpoint that does the job. Scoring them as failures would have
set a floor punishing the ranker for being right, and invited a "fix" that made it wronger.

## More than half the API documents nothing, and prose is worth a flat +3 whatever it says

Measured 2026-08-10 on the refreshed spec: **173 of the 320 public operations carry neither a summary nor a
description.** (Five more operations were bare on the spec pinned through 2026-08-09; the refresh that moved
voucher writes to `/api/manual-vouchers` also brought prose for a handful of them. A stale figure is not quoted
here on purpose — `test/docs.test.mjs` requires every stated count to equal the current one, and it cannot tell
history from a live claim.) Not thin prose — nothing at all. Verified against the raw document, not just the index: none of the 173 has prose that `scripts/build-spec-index.mjs` dropped, so this is a fact about ReAI's API rather than about the builder.

It shows up as this, identically for "create agreement", "opprett avtale" and "create lease agreement":

```
19  POST /api/agreements/{id}/sign-request                      irreversible / external
18  POST /api/agreements/{id}/sign-requests                     irreversible / external
16  POST /api/agreements/accounting-services                    reversible / none
16  … and the other four creation templates, tied at 16
16  POST /api/agreements/{id}/sign-requests/{signRequestId}/send irreversible / external
```

An agent asking to create a contract is offered **two** ways to email a counterparty first.

It was three until the tie-break stopped using `localeCompare` (see the caveat at the end of this section). That
change moved the first creation template from rank 4 to rank 3 and the third send from rank 3 to rank 8 — the
whole 16-point group is a tie, so nothing about *merit* changed, only which member of a tie is named first. The
defect this section is about is untouched: two irreversible external sends still outrank every creation template,
for the reason decomposed below.

### The mechanism is narrower than it looks, and worth stating exactly

The obvious reading — that the signing call matches more of the query — is **wrong**, and it was the first thing this page claimed. Decomposed:

```
POST /api/agreements/rent-agreement       path 6 + tag 5 + id 3 = 14   prose 0
POST /api/agreements/{id}/sign-request     path 6 + tag 5 + id 3 = 14   prose 4.875 -> capped at 3
```

Both score **14** on structure. The margin is exactly `PROSE_CAP`. Three things follow, none of them what the naive story says:

- The summary's 4.000 is the term **`agreement`** — the *same* term the creation endpoints already match, in the path, the tag and the operation id. It is that word scored a second time, not new evidence.
- "Send agreement signing **requests**" contributes nothing: `requests` is not a query term in any of the three queries.
- The description's "**Creates** one signing request…" contributes 0.875, which falls **entirely above the cap**. Delete the description and the score is still 19. The word that looks like the smoking gun is causally inert.

So the bias is not "better documented endpoints match more". It is: **having any prose at all is worth a flat +3, whether or not the prose is about what you asked for** — and where everything else ties, +3 decides it. Strip both prose fields from `sign-request` and it falls to 16, into the tie.

This is not an unknown bias. `PROSE_CAP` and `IDENTITY_BONUS` exist for it and say so at their definitions ("Verbose documentation should not outrank being the right resource"). What this case shows is that the cap bounds the bias without removing it: 3 points is small, and still decisive when 173 operations bring nothing to the other side.

### Three blockers, sequential — and fixing the two obvious ones does not fix the symptom

There is already a rule for this shape: an irreversible or transmitting action hanging off a resource, where the query does not name the action. It does not fire, and would not be enough if it did.

1. **`sign-request` is hyphenated**, and the rule is deliberately scoped to single-word segments, so the block never executes. Removing that scope fails the test pinning it (`test/ranking.test.mjs`, "the demotion is scoped to single-word segments"): it inverts "Apply a manual credit note to an invoice" into the DELETE that *unapplies* it, and drops the rounding-adjustment endpoint for "Settle insignificant invoice outstanding" from rank 2 to 31, outside the default limit.
2. **Even then the cut is ×0.9, not ×0.45** — 19.0 → 17.1, so it still wins. `familyOffersNonNested` compares `familyOf` values, and `familyOf` truncates at the first `{param}`: the signing call is in family `/api/agreements`, while `/api/agreements/rent-agreement` has no parameter and is its own family. The check that asks "is there a better alternative?" cannot see the five alternatives. Note the order — fixing this *alone* changes nothing, because blocker 1 means the block never runs.
3. **Fixing both used to leave an external send at rank 1, and no longer does.** Applying both changes, `sign-request` correctly collapses to 8.55 and disappears. `POST /api/agreements/{id}/sign-requests/{signRequestId}/send` is still exempt from the block for a third reason — `nestedActionSegments` returns **two** segments (`sign-requests`, `send`), so the single-segment requirement excludes it whatever the hyphen guard does — but it no longer takes rank 1: it used to win the 16-point tie on `localeCompare`, and by codepoint the concrete creation templates do. (Where exactly it lands after both fixes is not measured here — the two changes are hypothetical, and the last version of this paragraph stated a rank for it that came from a review rather than a run.) So this blocker is now about a wasted slot rather than a wrong first answer, which weakens the "sequential blockers" argument rather than removing it: the first two fixes on their own still do not surface a creation template above the 19 and 18.

An earlier version of this page called blocker 2 "the real defect". That was wrong: it is *a* blocker, and the implied fix path does not fix the reported symptom.

### A third lever, considered and set aside

`isExactly` refuses `IDENTITY_BONUS` to any last path segment containing a hyphen, which is exactly why `POST /api/agreements/rent-agreement` gets no credit for *being* the resource the query names. Dropping that guard fixes all three queries outright — the creation templates come out at 19.5 and take the top places. It also re-breaks the documented `documents` case: `/api/invoice-reception-documents` and `/api/receipt-reception-documents` reach 43.4 and push `/api/documents` out of the top three. So it is not the fix either, but it is the mechanism closest to the actual complaint and should not be left unmentioned.

### One thing tried and rejected: a derived phrase for the bare operations

Give the 173 bare operations a phrase from method plus path, in a separate field so it is never shown as the API's own words, so ranking can see the verb a path cannot carry. The naive form double-counts — it restates resource words the path already scores at 6 — and displaced five known-good answers, including `finn kunde amelding` moving to `/api/customers` from `/api/ledger/customer` and a salary run falling to rank 7. Constrained to contribute **only terms the path lacks**, with no phrase bonus, it reached zero regressions against the committed sweep.

**It was dropped, but the measurement that justified dropping it was weak, and that is worth recording honestly.** A probe of all 173 bare operations, each queried as `<verb> <last path segment>`, returned one improvement and one regression. Four reasons that is thin:

- **Almost no headroom.** Of the 173 bare operations, 129 are *already* at rank 1 on `main` and 176 are already in the top 3; the worst sits at rank 4. "Unchanged: 176" mostly means "already correct". That is structural, not luck: the query is built from the operation's own path, and the path is the heaviest haystack.
- **The probe assumes its own conclusion.** Constrained to terms the path lacks, the field effectively contributes the verb — and the probe always states the verb, so `writeIntent` and `impliedMethodsFor` always fire. "The verb is already supplied by write intent" is built into the corpus rather than tested by it.
- **The motivating query was absent, and unwinnable anyway.** `create agreement` is not in the corpus, and simulated as a seventh haystack the creation templates reach 17.31 at weight 3 and 18.63 at weight 6 — equal to the path, the heaviest field there is — still behind 19. Only an indefensible weight 10 wins. The mechanism could not have fixed the defect it was written for.
- **It used rank-1 only**, the metric this page calls "the least informative alone", for a change whose purpose was making undocumented endpoints *reachable*. An operation moving 9 → 3 counted as unchanged.

Regressions were measured with the committed sweep; benefit with a throwaway script over the same 173 bare operations, which is not committed and so cannot be re-run. So the decision stands on **redundancy with `writeIntent`/`impliedMethods` plus regression risk on a change that could not win the case it was built for** — not on a measured absence of benefit.

### What is actually protecting the live case

Not ranking. `reai_create_agreement` exists, so an agent has a curated tool and does not depend on the search result. The bias remains for the **53** bare operations no curated tool covers.

One caveat on the table above, now resolved: among the operations tied at 16, which one is named first comes from
the path tie-break. It used to be `a.path.localeCompare(b.path)`, under which `{` sorts before letters, so a
`{param}` route beat a concrete sibling on equal scores. `searchOperations` now uses codepoint order, matching
`scripts/build-spec-index.mjs`, which refuses `localeCompare` for a stated reason — "under LANG=nb_NO Node sorts
'aa' as 'å' (after z)" — on an API whose paths are Norwegian. Search was the last place ordering results by a
locale-dependent comparison, so identical queries could rank ties differently between machines. The two
collations do differ: `"aa".localeCompare("å")` is `1`, codepoint order gives `-1`.

That is a reproducibility fix that happens to help here, not a ranking change: by codepoint `{` is `0x7B` and
sorts after `a`–`z`, so the concrete creation templates take the earlier places in their own tie. Measured on the
three queries above, the effect is exactly one position for the first creation template and five for the third
send.

And with prose stripped from the whole family, `sign-requests` **still** comes out first — so "if only ReAI
documented these evenly" would not by itself fix the symptom. Measured on the current tie-break, stripping
`summary` and `description` from all six documented `/api/agreements*` operations:

```
18     POST /api/agreements/{id}/sign-requests
16.88  POST /api/agreements/{id}/sign-request
16     the five creation templates, then .../sign-requests/{signRequestId}/send at eighth
```

Two things worth noting from that. The eight do **not** all collapse to 16 — `sign-requests` keeps 18 and
`sign-request` 16.88, so prose is not the only thing separating them from the creation templates, which is a
caveat this page did not have before. And the tie-break's effect here is the same one position as everywhere else:
under `localeCompare` the third place went to `.../send`, by codepoint it goes to a creation template.

(A review of the tie-break change reported that the creation templates take ranks 1–5 once prose is evened out,
which would have reversed this section's conclusion. Measured here, they do not — ranks 1 and 2 are still sends.
Recorded because the claim was nearly written into this page on the strength of the review rather than a
measurement.)
