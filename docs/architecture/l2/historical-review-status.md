# Historical L2 review status

**Scope:** August 2026 ESU6, NQU6, AAPL and TSLA Historical Mode. Crypto and exact Replay are deferred. Code review and production activation are separate acceptance points.

## Current state

| Layer | State |
|---|---|
| Published depth/events | 92 qualified instrument-days; 32 dates explicitly unavailable |
| Wall and individual-print indexes | 84 of 92 days qualified locally; eight await repaired-code qualification |
| Serving coverage | Four independently qualified pilot days; complete month registries are not emitted yet |
| Reader and gateway | Authenticated, pinned, bounded states/events/walls/prints queries |
| Browser implementation | All 12 existing L2 entries connected to their required historical inputs |
| Normal terminal | Reviewed `12f52bdb` reader/gateway activated; local preview uses the normal authenticated route |
| Display repair | `fix/historical-l2-visible-delivery`: seven missing settings dialogs, top-ten heatmap defaults and direct bounded-window controls |
| Task processes | Local C/D running; month retry stays stopped; collectors preserved |

The immutable L2 release is `49a225fdd4b7f36bbf1e946b36a201508a3c13a505f5d2dd93bce21c27d51c2f`. Wall and print indexes are additional locally qualified outputs; they do not alter that published release.

## Code checks

- Development base: `49555af6`; Node 24.21.0 and Python 3.12.12.
- Full runtime: **5,682 passed, six skipped**, using two Jest workers.
- Full web: **4,331 passed, five skipped**. Typecheck and build pass.
- Full conversion: **1,458 passed, ten skipped**.
- Repository ESLint, oxlint, documentation and stale-mutation checks pass; zero blocking or stale targets against the development base.
- **18 retargeted mutation guards and four burst guards killed** in isolated copies using pinned executables. The burst guards independently enforce the measured auction capacity, smaller burst capacity, count limit and byte limit.
- Four real-data pilot days have independent original-source wall/print comparisons and authenticated candle/L1/L2 compatibility checks. Model tests use synthetic compatibility candles and do not prove actual canvas behavior.

## Repairs in the review checkpoint

- Wall projection admits at most **65,536 pending engine events / 8 MiB encoded payloads** between samples. Both limits fail closed. The heaviest observed AAPL auction second contains 49,160 contiguous events; the earlier 8,192 and 16,384 count limits were insufficient. Source analysis found no sequence gaps on the eight refused days. A full native-qualified retry is still required for each one.
- Returning to the same successfully loaded chart window reuses one cached input bundle under the same snapshot. Instrument, interval, selected input requirements or generation changes discard it. Failed optional inputs are retried rather than cached as successful.
- Windows reservation-owner checks use process handles rather than `os.kill(pid, 0)`, which can terminate a process on Windows. A real child-process regression verifies that inspection preserves a live process and detects its exit.
- Unit server fixtures stub provider metadata, preventing external requests after teardown. The telemetry test supplies a simulated download delay rather than requiring a zero-latency fake to exceed Windows clock resolution.

## Data and chart limits

MBP-10 observes ten levels on each side. Leaving that range is loss of observation, not a proven cancellation. One-second states are interval-close observations. Unknown trade direction remains unknown.

The visible request is **one UTC day/contract, at most one hour**, with up to ten preceding minutes of same-day warm-up. Fixed indexed wall settings retain a minimum of **40 contracts / 800 shares**. Display filters cannot recover evidence below that floor. Missing indexes keep dependent indicators unavailable. Oversized requests refuse explicitly; wider chart views are not qualified.

The unfinished index dates are AAPL August 4/31, TSLA August 6/21 and NQU6 August 7/12/13/28. Failed or interrupted attempts cannot become serving coverage. The repair retry remains stopped, and completed receipts are preserved.

## Next acceptance points

1. Review the display repair against merged PR #50 (`12f52bdb`). Host application release: `20261010T140843Z-12f52bdbe1a9.8PGtnw`; previous rollback release: `20261005T220750Z-f214625fb86e.qwaTPm`.
2. In Historical Mode select ES, then **Open L2 sample** (August 5, 13:30–13:45 UTC) to use a date with walls and individual trades. **Last 30m of depth** opens the latest loaded date; its wall/print coverage may be absent. Sample dates come from the authenticated index catalog. Settings use separate historical storage and do not change live tuning.
3. Four real normal-route captures pass transport/model checks with provider candles and nonzero heatmap pixel output in a test canvas. This is not desktop visual acceptance. Owner checks the rebuilt preview, all 12 entries, settings and rapid panning; record actual chart load, frame time and memory.
4. Resume the eight index retries when requested, require full original-source native comparisons and produce complete month registries.
5. Accept August coverage and supported settings, document wider-view behavior, and verify production health and rollback.

**A2 and Report 67 remain open.** Automated code checks do not establish visible delivery or whole-chart speed. The worktree and ignored evidence stay available during review.

See [serving contract](historical-serving.md), [output contract](historical-core-contract.md) and [activation runbook](../../operations/10-historical-l2-service.md).
