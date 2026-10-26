# Testing and gates

How to prove a change before it is pushed: the one command that runs every
check, and the mutation tools that show the tests would catch a regression.
Run everything with the repository's Node (24.21.0, from `.nvmrc`); the gate
and the mutation check refuse any other.

## The gate

```powershell
npm run gate
```

Checks the Node version, then runs side by side: the docs check, `eslint .`,
the web app's `oxlint`, its type check and build, the runtime's jest suite,
the web app's vitest suite, the conversion suite (`uv run pytest`, skipped
with a reason when uv is not installed) and the stale-mutant check against
`origin/development-indicator-sdk`. The WebSocket fan-out load benchmark
(`ws-fanout-load.test.js`) is left out of the runtime suite and runs last, on
its own: it checks that every healthy client receives every trade at a fixed
rate, which a CPU shared with the other suites cannot promise. It prints a
Markdown report with the test counts and times of each step, keeps every
step's full log, and exits non-zero if any step fails.

| Option | Effect |
|---|---|
| `--base <ref>` | Compare the stale-mutant check with another branch |
| `--no-base` | Skip the stale-mutant check |
| `--heavy <n>` | How many of the three test suites run at once (default 3; 1 on a machine with few cores) |
| `--report <file>` | Also write the report to a file, for a PR comment |

On a 4-core machine the whole gate takes about seven minutes, most of it the conversion suite.

## Mutation checks

A mutation spec names a small change to the code (`find` → `replace`), the test
command that must catch it, and the test that should fail (`mustFail`). The
specs live in `benchmarks/mutations/`. `benchmarks/mutation-ledger.jsonl` holds
each mutant's latest run, one line per mutant sorted by id: a run appends its
results, then folds them in. Older runs are in git's history. The file merges
as a union, and the next run folds a mutant that both sides ran back to one
line.

```powershell
node apps/runtime/scripts/verify/mutation-check.js benchmarks/mutations/<spec>.json [more specs...]
```

| Option | Effect |
|---|---|
| `--workers <n>` | Mutants run at once, each on its own copy of the working tree (default: one fewer than the cores, at most four) |
| `--only <id,...>` | Run just these mutants |
| `--progress <file>` | Record outcomes; a second run skips the mutants already killed |
| `--in-place` | Mutate the checkout itself, one at a time |
| `--ledger <file>` | Write the ledger somewhere else |

The checkout is never edited, except by Python specs, which run in place one
at a time; a mutant written in place is journalled in `.mutation-inflight/`
and put back by the next run if the process died. Outcomes:

| Outcome | Meaning |
|---|---|
| `KILLED` | The named test failed: the mutant is caught |
| `SURVIVED` | Nothing failed: a gap in the tests, or an equivalent mutant |
| `KILLED_BY_UNEXPECTED_TEST` | A test failed, but not the one named |
| `BASELINE_FAILED` | The command fails without the mutant, so nothing was learned |
| `STALE` | The find text is gone, repeated, or its file was deleted |
| `ERROR` | The run of this one mutant broke; the others went on |

A survivor whose command filters tests with `-t` may be filtering out its own
`mustFail` test: run it once without the filter before calling it a gap.

## Stale mutants

```powershell
npm run mutation:stale -- --base origin/development-indicator-sdk
```

Lists every mutant whose find text no longer occurs exactly once. With
`--base` it fails only on what the branch did: a mutant that matched at the
base and does not now, or one the branch added or changed that does not
match. Run it before pushing a change that touches code a spec targets.

## Web tests and the browser

Vitest runs in Node. A test file that needs a browser (`document`, `window`,
React rendering) starts with `// @vitest-environment jsdom`, and so does one
that reaches code which branches on a browser API, so the test covers the
branch the browser takes.
