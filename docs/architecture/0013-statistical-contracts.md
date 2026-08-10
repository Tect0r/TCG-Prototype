# ADR 0013 — Statistical contracts for the balance laboratory (Phase 4 hardening)

**Status:** accepted · **Date:** 2026-08-09

## Context

Phase 4 shipped a laboratory that ran. An audit against
[PHASE4_HARDENING.md](../PHASE4_HARDENING.md) found that several of its
headline numbers did not measure what their names said, in ways that a passing
test suite could not catch:

- Replacement and baseline/candidate experiments deliberately used common random
  numbers so both arms played the same games — and were then analysed with
  independent-sample intervals, throwing the design away and reporting a wider
  interval than the experiment had paid for.
- Card-pair "synergy" compared the joint win rate against the better single card
  and drew its interval from the joint cell alone. Two independently strong
  cards therefore looked like a combination, and the uncertainty of the three
  other groups in the contrast never reached the result.
- Reports scanned hundreds of cards and pairs and presented the surviving flags
  with no indication of how wide the scan had been.
- `timesPlayed / timesDrawn` was named `playRatePerDrawn` and rendered as a
  percentage, so a card that could be replayed could print a play rate above
  100%.

These are not tuning questions. A wrong estimator produces a confident number,
and a confident wrong number is worse than no number: it is exactly the thing a
designer would act on.

## Decision

### One statistics module, versioned

`apps/simulator/src/analysis/paired.ts` owns every resampling procedure, and
exports `ANALYSIS_STATS_VERSION`. That version is recorded in every manifest and
folded into the configuration hash. Changing a generator or an interval method
changes published numbers, so it is a versioned break rather than a silent one.

Resampling is seeded from a caller-supplied string through a xorshift128 stream
and never reads a clock, a counter or `Math.random()`. Two runs of the analyser
over the same records produce byte-identical intervals.

`stats.ts` remains closed-form and is used wherever a closed form is honest. A
bootstrap is used only where the estimand is a contrast of several correlated
groups and no closed form can carry every group's error.

### Paired designs are analysed as paired

Where both arms played the same experimental units — the same deck pair, game
index, seat, shuffles and pilot streams — the estimate is paired:

- **Binary outcomes** (`pairedBinary`): the delta over complete pairs, the
  discordant counts in both directions, the concordant count, and a stratified
  percentile bootstrap over pairs. Strata are `pilot | seat`, so a resample
  cannot re-weight the pilots.
- **Continuous outcomes** (`pairedMean`, e.g. match length): the within-pair
  differences _are_ the sample, so their ordinary interval is already the paired
  one and no resampling is needed.

A pair that is incomplete or unmatched is **excluded, counted, and reported with
a reason code**. There is no fallback that quietly treats the observations as
independent, because that fallback is the defect.

The discordant counts are reported alongside the delta because they are the
whole sample the difference is estimated from. Two hundred pairs with two
discordant ones carry about as much information as two coin flips, and a reader
deserves to see that rather than infer it from a wide interval.

### Synergy is a difference-in-differences over four cells

For cards A and B, every seat-match falls in exactly one cell by what the deck
contained, and the estimand is stated in the output:

```text
interaction = (p11 − p10) − (p01 − p00)
```

What the second card adds _on top of_ the first, minus what it adds on its own.
Two independently strong cards produce an interaction near zero however high
`p11` is.

The interval is a stratified bootstrap over seat-matches that recomputes all
four cells on each draw, so every cell contributes its sampling error. A
resample that empties a cell is discarded and counted rather than substituted
with a zero, which would bias the interval toward the remaining cells.

Every cell must independently clear `minPairCellSupport`. A pair that never
appears apart has no marginal; a pair with no `neither` cell has no baseline.
Both return `insufficientEvidence`, because the contrast is then **undefined**,
not merely imprecise. `liftOverBestSingle` is kept as a descriptive number under
a name that says what it is.

These are archive associations. Decks were not assigned their cards at random —
a search chose them — so the output never uses causal wording. The controlled
replacement experiment is the tool for the causal question.

### Multiplicity is reported, never used to suppress

`describeMultiplicity` records how many subjects were examined, how many raw
flags were raised, and how many flags a scan of that width would produce from
noise alone. `benjaminiHochberg` is available and returns adjusted values in
input order; unadjusted values are never discarded.

Flags are review guidance, so nothing is hidden because a scan was wide — that
would trade a false positive for a false negative without telling the reader.

### Metric names state their bounds

- `playsPerDraw` — play events over draw events. **Unbounded**; formatted as a
  multiplier and never as a percentage.
- `drawnCopyPlayConversion` — distinct drawn copies played at least once, over
  distinct drawn copies. Bounded 0–1. `null`, meaning _unavailable_, when the
  records predate per-copy tracking, rather than a fabricated value.
- `gamesDrawnAndPlayedShare` — games where the card was drawn and played, over
  games where it was drawn. Bounded 0–1.

A metric whose denominator counts _events_ and one whose denominator counts
_copies_ answer different questions and now have different names.

### Every threshold is named, unitful and separate

Thresholds live in the validated `analysisSettings` block, each with an explicit
unit in its documentation. Deck share, cluster share and game-observation
minimums are **separate settings** even where their default values coincide, so
tuning one cannot silently move another. The full set is printed in every
report beside the flags it produced.

## Consequences

- Old summaries cannot be read under the new field meanings. Report, summary and
  manifest schemas moved to version 2; the renamed metrics have no migration
  because the underlying observations were never recorded.
- Intervals on paired experiments are narrower than before. This is the design
  being honoured, not a loosening: the previous intervals were wrong in the
  conservative direction, which is still wrong.
- More results come back as `insufficient_evidence`. A sparse cell used to
  produce a number; it now produces a refusal. At current sample sizes this is
  the common case for card pairs, and that is the accurate answer.
- Analysis is slower: a bootstrap at 2000 iterations per pair costs real time on
  a large card pool. Iteration count is configurable, and the seed makes any
  count reproducible.
