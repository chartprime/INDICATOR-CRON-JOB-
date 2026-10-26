# Cycle 1 report (2026-10-26)

## Completed

- Team process stood up: charter, capability sheet, worker brief, UX standard,
  validation protocol with a reusable harness (84 proving tests), Codex gate
  scripts for plan review, code review, challenge and baseline implementation.
- Research: market scan of 12 products, 13 quoted complaint themes, 7
  underserved workflows, 14 ranked concepts. Fifteen specialist concepts (five
  per data layer), each grounded in the capability sheet.
- Shortlist of three: Relative Volume by Time of Day, Squeeze Breakout
  Context, Size-Split Delta.
- Built, validated and merged: **Relative Volume (Time of Day)**. Package in
  `pm/cycle1/package-relative-volume.md`.
- SDK improvement merged: `tab: "advanced"` renders as a collapsed Advanced
  group in the generic settings dialog.
- Persistence: everything pushed to the owner's repository.

## Rejected or parked, with reasons

Supertrend and MACD (commodity direction tools); Market Sweep Detector
(covered by Flowprint Blocks and Aggressive Orders); Bar-Averaged Book
Imbalance (kept only as a baseline); Sticky Levels (invites a spoofing
reading the data cannot support). Weekend slot family and sustained marker
deferred from the built indicator.

## Evidence summary

Baseline comparison, performance and the ten validation checks are in the
package and in `pm/log/validation/relativeVolume/loop-2.md`. Codex transcripts
in `pm/log/codex/`.

## What the gates caught (why the process is worth its cost)

Plan gate: commit timing at bar close, denominators stored before insertion,
timestamp-keyed corrections with eviction rollback, a slot key that does not
collide on short equity bars, a duration normalisation the resampler cannot
support, a fair benchmark. Challenge gate: a cosmetic colour change that
changed numbers, partial buckets from feed gaps entering the baseline, a
median that was a mean at lookback two, published counts not pinned, a
performance probe that timed nulls. UX pass: colours that broke the house
semantics, and a learning screenshot taken under the wrong setting.

## Process lessons

- Review before merge: the first UX merge preceded its code gate; the gate
  script now refuses an empty diff.
- One brief, one document: UX amendments sent by message caused two moot
  Codex objections; amendments are now appended to the brief.
- The plan gate converges slowly on a detailed brief (five rounds); the
  three-round limit stands, with the PM deciding after it.
- Agents cannot push or receive email; persistence needs a repository and the
  editor needs its source, not a login.

## Blockers and asks

- Indicator editor (pine.beqa.me): invite-only web app with a Pine
  interpreter; its source or an export of saved scripts is needed to include
  it in the lineup.
- No live market data reaches this container; validation is on synthetic
  fixtures and the screenshots use a fixture server. First live observation
  should happen on the owner's machine.
- Rotate the OpenAI API key after the project; it passed through chat.

## Next cycle proposal

Build Squeeze Breakout Context (OHLCV, the cross-layer anchor) and Size-Split
Delta (L1) in parallel, then Break Defense Monitor (L2) against the anchor's
levels. Fix the one parked harness item (snapshot-only wall absorbing flag)
before the L1/L2 validations. Decide on Pine delivery once the editor source
arrives.
