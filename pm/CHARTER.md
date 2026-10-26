# Team charter: indicator product line for Terminal-L1-L2

## Objective (from the owner)

Build tools that answer a specific trading question, reveal something useful,
and make sense within seconds of opening the chart.

## Team

| Role | Agent | Owns | Required deliverable |
|---|---|---|---|
| PM | the coordinating agent (this session) | problem selection, capability sheet, scoring, handoffs, acceptance, the product package, the backlog and logs | a coherent indicator lineup with evidence |
| 1. Product researcher | worker | competing tools, trader complaints, underserved workflows, positioning | ranked concepts: target user, problem solved, differentiation, required data, one-sentence pitch |
| 2. OHLCV specialist | worker | candles and volume: structure, volatility, trend quality, compression, breakout context, session behavior, unusual volume | working indicator, calculation explanation, defaults, alert conditions, example charts |
| 3. L1 tick specialist | worker | trades and best bid/ask: intensity, unusual sizes, pressure estimates, price response, intrabar behavior | working indicator, exact feed requirements, estimation methods, evidence beyond candles |
| 4. L2 specialist | worker | depth: persistent liquidity, pulling/stacking, gaps, replenishment, liquidity-versus-trades interactions | working indicator, noise filtering, live/historical consistency, observation versus inference made explicit |
| 5. UX and visualization | worker | appearance, settings, presets, tooltips, alert presentation, first use; inspects rendered charts at several zoom levels | polished interface, clean defaults, short explanation, screenshots |
| 6. Validation and performance | worker | challenges calculations and claims: future-data leakage, misleading history, gaps, duplicates, excess alerts, load time, memory, live performance | pass/fail report with reproducible evidence and required fixes |
| Codex (OpenAI) | external reviewer and implementer via the `codex` CLI | independent second opinion at every gate; optional implementer of baselines and fixes | plan verdicts, code review verdicts, challenge reports |

## Where Codex sits in the pipeline

Codex is a different model from the one running every other seat, so it is the
team's independent check. It is used at four points; the PM runs each call
through the scripts in `PM/codex/` so prompts, sandboxing and logging are
identical every time.

| Gate | Script | Mode | What it gets | What it must return |
|---|---|---|---|---|
| G1 Plan review | `codex-review-plan.sh <plan.md>` | read-only | the selected concept's build brief: user, decision, data, calculation, success criteria | VERDICT: APPROVED or REVISE with specific objections; the PM revises, at most 3 rounds |
| G2 Code review | `codex-review-diff.sh <branch>` | read-only | the specialist's branch diff against `main` plus the brief | findings by severity with file and line, VERDICT; the specialist fixes CRITICAL and WARNING items, at most 3 rounds |
| G3 Validation challenge | `codex-challenge.sh <branch> <claims.md>` | read-only | the indicator's claims, tests and doc; asked to find leakage, misleading signals, duplicate events, missing gates | a challenge list the validation specialist must answer with evidence |
| G4 Baseline implementation (optional) | `codex-implement.sh <task.md>` | workspace-write in a throwaway worktree | a self-contained task, typically the simpler baseline an indicator must beat | a branch the validator compares against |

Rules: Codex never commits to `main`. A Codex verdict is evidence the PM weighs,
not an order; a disagreement between Codex and a specialist is decided by the
PM and recorded in `DECISIONS.md`. Every Codex transcript is kept under
`PM/log/codex/`.

Preflight: `PM/codex/codex-preflight.sh` must print `ok` before any gate runs.
It needs `OPENAI_API_KEY` in the environment (added as a network secret in the
cloud environment settings; a new session picks it up).

## Pipeline for one indicator

1. Researcher proposes; each data specialist proposes five concepts grounded
   in `CAPABILITIES.md` (no code yet, feasibility notes only).
2. PM scores (rubric below), combines overlaps, shortlists three, writes a
   build brief for one: target user, trading decision, data, calculation,
   default view with at most three primary controls, success criteria,
   baseline to beat, budget.
3. G1: Codex reviews the brief. PM revises.
4. Specialist builds in a worktree branch following `WORKER-BRIEF.md`.
   UX joins before the build is finished: default view, control grouping,
   colors, copy, first-use behavior.
5. G2: Codex reviews the branch. Specialist fixes.
6. Validator challenges (own protocol plus G3 Codex challenge). Specialist
   fixes. At most two validation loops; a third failure returns the concept
   to the backlog with the evidence attached.
7. PM reviews, merges to `main`, reruns the full web suite, and writes the
   product package: name, purpose, code, presets, alert conditions, doc,
   screenshots, data requirements, limitations, short demo. Marketing claims
   must match what validation established.

## Scoring rubric (PM)

Each concept scored 1 to 5 on usefulness, differentiation, clarity (makes
sense in seconds), feasibility (against the capability sheet), speed to build,
marketability. Weighted sum with usefulness and clarity doubled. Anything
scoring 1 on feasibility is rejected regardless of total. Overlapping concepts
are combined before scoring.

## Evidence standards

- Every indicator is compared against a simpler baseline (for example a
  rolling average, a plain RVOL, a raw imbalance line). The comparison states
  what the new tool shows that the baseline hides.
- Descriptive tools are judged on detection accuracy on labelled fixtures,
  clarity and usefulness, never forced into a profitability test.
- Predictive claims need an unseen period and forward observation; selecting
  the best of many variants on history is overfitting and is rejected.
- Replay-versus-live consistency: the value for a bar computed by replay must
  equal the value computed live for the same bar, or the difference must be
  documented (tick-only indicators are honest nulls in replay).
- No future data: a bar's output may use only data with timestamps at or
  before that bar's close.

## Budgets and bounds

| Task | Budget |
|---|---|
| Concept proposals (per specialist) | one agent run, no code, five concepts |
| Build of one indicator | one agent run, plus at most two fix rounds |
| UX pass | one agent run during the build, one after validation |
| Validation | one agent run per loop, at most two loops |
| Codex gates | at most 3 rounds each |

Blocked or repeatedly failing work returns to the backlog with its evidence.
The PM reports completed work, rejected ideas, evidence, and remaining blockers
after each cycle in `PM/log/cycle-<n>-report.md`.

## Cycle 1 plan

Five concepts from each data specialist, researcher's ranked list, shortlist of
three, one indicator finished end to end with a clear default view, at most
three primary controls, and deeper customization under an advanced group. This
is the benchmark for the whole process before scaling production.

Cross-layer theme offered to all three specialists: **breakouts**. OHLCV asks
about compression, structure and the surrounding trend; L1 asks whether trade
activity and price response change during the break; L2 asks how nearby
displayed liquidity behaves as price approaches. The PM decides whether these
become separate indicators or one integrated tool. Any combined confidence
score must have an explained calculation and its own validation.
