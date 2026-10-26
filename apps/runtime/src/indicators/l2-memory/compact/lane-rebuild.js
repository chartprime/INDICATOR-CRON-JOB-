"use strict";

const { isClosedThroughout } = require("../../../providers/shared/market-calendar");
const { WINDOW_MS } = require("../pyramid/pyramid-levels");

const REPAIR_MIN_MS = 60_000;
const REPAIR_SETTLE_MS = 120_000;
const MAX_STANDING = 400;

function createLaneRebuild(ctx, lane, store) {
  const {
    scheduler, historyS, backfillMaxMs, floorMs, columnMs, deepS, deepColumnMs, deepChunkMs, coarseMaxAgeMs, coarseColumnMs,
    coarseChunkMs, coarseRows, coarseSampleMs, announceMs, remoteReplay, dbPath, sizeDigits, slowStepMs, states, now, log, fillMs, storeEnabled,
  } = ctx;

  function runPass(state, request) {
    return scheduler.run({ ...request, key: state.key }, { urgent: state.key === ctx.activeKey });
  }

  function settleStanding(state) {
    let settled = 0;
    let progress = state.standing.length > 0;
    while (progress) {
      progress = false;
      for (const pending of [...state.standing]) {
        if (state.tracker.extend([pending.level], { until: pending.until, toleranceMs: pending.toleranceMs }).length === 0) continue;
        state.wallHistory.extend([pending.level], { until: pending.until, toleranceMs: pending.toleranceMs });
        state.standing.splice(state.standing.indexOf(pending), 1);
        settled += 1;
        progress = true;
      }
    }
    const horizon = now() - state.trackerOptions.deepKeepEndedMs;
    state.standing = state.standing.filter((pending) => pending.until >= horizon).slice(-MAX_STANDING);
    if (settled > 0) log(`liquidity-publisher: ${settled} wall${settled === 1 ? "" : "s"} for ${state.key} got ${settled === 1 ? "its" : "their"} birth from an earlier window`);
    return settled;
  }

  // A batch is what one replay or one host window saw over [from, until): the history skips what it already holds
  // there, so a span asked for twice, by this run or a restart, is counted once.
  function mergeEvents(state, events, origin, from, until) {
    if (!events) return false;
    if (state.eventHistory.merge(events, { from, until })) return true;
    log(`liquidity-publisher: the event history for ${state.key} could not take the events of ${origin} (columnMs ${events.columnMs}, deepColumnMs ${events.deepColumnMs})`);
    return false;
  }

  function noteEmpty(state, from, until) {
    const floor = now() - fillMs;
    const joined = [];
    for (const [lo, hi] of [...state.emptyPasses, [from, until]].sort((a, b) => a[0] - b[0])) {
      if (hi <= floor) continue;
      const last = joined[joined.length - 1];
      if (last !== undefined && lo <= last[1]) last[1] = Math.max(last[1], hi);
      else joined.push([lo, hi]);
    }
    state.emptyPasses = joined;
  }

  function outside(ranges, holes) {
    const out = [];
    for (const [lo, hi] of ranges) {
      let cursor = lo;
      for (const [from, until] of holes) {
        if (until <= cursor) continue;
        if (from >= hi) break;
        if (from > cursor) out.push([cursor, from]);
        cursor = Math.max(cursor, until);
      }
      if (cursor < hi) out.push([cursor, hi]);
    }
    return out;
  }

  function adoptPass(state, levels, from, until, events = null, noData = false) {
    const past = levels.filter((level) => level.endedBy && level.endTs < until);
    if (past.length > 0) state.tracker.adopt(past);
    for (const level of levels) if (!level.endedBy) state.standing.push({ level, until, toleranceMs: columnMs });
    settleStanding(state);
    const replayed = mergeEvents(state, events, "a deep pass", from, until) || noData;
    if (!replayed) return past.length;
    if (noData && !events) noteEmpty(state, from, until);
    if (Number.isSafeInteger(state.liveFrom) && until >= state.liveFrom - Math.round(historyS * 1_000)) state.birthsFromPass = true;
    return past.length;
  }

  function fillHorizon(state, at) {
    const horizon = Math.max(0, at - fillMs, floorMs);
    const deepFloor = Math.max(0, at - Math.round(deepS * 1_000), floorMs);
    const first = state.deep.length > 0 ? state.deep.toArray()[0].ts : deepFloor;
    const until = Number.isSafeInteger(state.liveFrom) ? state.liveFrom - Math.round(historyS * 1_000) : first;
    return { horizon, first, until };
  }

  function pyramidRanges(state, at) {
    const { horizon, until } = fillHorizon(state, at);
    return until > horizon ? state.eventHistory.uncovered(horizon, until) : [];
  }

  async function fillHistoriesFromPyramid(state, engine, at) {
    if (!ctx.pyramid || typeof ctx.pyramid.wallHistory !== "function" || typeof ctx.pyramid.eventHistory !== "function") return;
    if (fillMs <= 0 || !storeEnabled || !state.deep) return;
    const ranges = pyramidRanges(state, at);
    if (ranges.length === 0) return;
    const startedAt = now();
    const geometry = { rowWidth: state.rowWidth, tickSize: engine.tickSize, clusterTicks: engine.clusterTicks };
    const settled = (promise, empty) => promise.catch((error) => ({ ...empty, reason: `READ_FAILED: ${error?.message ?? error}` }));
    const answers = await Promise.all(ranges.map(async ([fromTs, toTs]) => {
      const ask = { marketKind: state.marketKind, symbol: state.symbol, fromTs, toTs, geometry };
      const [walls, events] = await Promise.all([settled(ctx.pyramid.wallHistory(ask), { walls: [] }), settled(ctx.pyramid.eventHistory(ask), { windows: [] })]);
      return { fromTs, toTs, walls, events };
    }));
    if (states.get(state.key) !== state || ctx.stopped) return;
    let recorded = 0;
    let merged = 0;
    let refused = 0;
    let oldest = Infinity;
    let newest = -Infinity;
    let reason = null;
    for (const { fromTs, toTs, walls, events } of answers) {
      const asked = walls.walls.filter((wall) => wall.endTs >= fromTs && wall.endTs < toTs);
      refused += walls.walls.length - asked.length;
      const took = state.wallHistory.record(asked);
      recorded += took.added + took.updated;
      for (const window of events.windows) {
        if (window.ts < fromTs || window.ts >= toTs || !mergeEvents(state, window.events, "the heatmap pyramid", window.ts, window.ts + WINDOW_MS)) {
          refused += 1;
          continue;
        }
        merged += 1;
        oldest = Math.min(oldest, window.ts);
        newest = Math.max(newest, window.ts + WINDOW_MS);
      }
      reason ??= walls.reason ?? events.reason;
    }
    if (merged > 0) {
      const before = state.eventHistory.fill;
      state.eventHistory.setFill({ from: before === null ? oldest : Math.min(before.from, oldest), until: before === null ? newest : Math.max(before.until, newest) });
      state.eventHistory.advance(now());
    }
    state.pyramidFill = { walls: recorded, windows: merged, refused, reason, ms: now() - startedAt };
    if (recorded + merged > 0) log(`liquidity-publisher: took ${recorded} walls and ${merged} event windows for ${state.key} from the heatmap pyramid in ${now() - startedAt} ms`);
    else if (reason !== null) log(`liquidity-publisher: no histories for ${state.key} from the heatmap pyramid (${reason}), the recording fills them`);
  }

  function fillWindows(state, at) {
    if (fillMs <= 0 || !storeEnabled || !state.deep) return [];
    const { horizon, until } = fillHorizon(state, at);
    if (until <= horizon) return [];
    const windows = [];
    for (const [lo, hi] of outside(state.eventHistory.uncovered(horizon, until), state.emptyPasses).reverse()) {
      let cursor = hi;
      while (cursor - deepColumnMs >= lo) {
        const from = Math.max(lo, cursor - deepChunkMs);
        windows.push({ from, until: cursor });
        cursor = from;
      }
    }
    if (!state.birthsFromPass && (windows.length === 0 || windows[0].until !== until)) windows.unshift({ from: Math.max(horizon, until - deepChunkMs), until });
    return windows;
  }

  function startFill(state, engine, at) {
    if (fillMs <= 0 || !storeEnabled || !state.deep || !scheduler || state.fillBusy) return Promise.resolve();
    const covered = () => (state.eventHistory.fill === null ? {} : { from: state.eventHistory.fill.from, until: state.eventHistory.fill.until });
    const windows = fillWindows(state, at);
    if (windows.length === 0) {
      state.fillReadiness = { state: "READY", reason: null, completedAt: now(), chunks: 0, pyramid: state.pyramidFill, ...covered() };
      return Promise.resolve();
    }
    state.fillBusy = true;
    const startedAt = now();
    state.fillReadiness = { state: "RUNNING", reason: "IN_PROGRESS", startedAt, chunks: 0, pyramid: state.pyramidFill };
    let stopped = null;
    let chunks = 0;
    let empty = 0;
    return windows.reduce((chain, window) => chain.then(() => {
      if (stopped !== null || states.get(state.key) !== state || ctx.stopped) return undefined;
      return runPass(state, {
        ...backfillRequest(state, engine),
        lanes: [],
        aggressiveOptions: undefined,
        background: true,
        fromTs: window.from,
        toTs: window.until,
        columnMs,
        foldMs: deepColumnMs,
        onColumn: () => {},
      }).then((result) => {
        if (states.get(state.key) !== state || ctx.stopped) return;
        if (result && result.reason && result.reason !== "NO_DATA_IN_WINDOW") {
          stopped = result.reason;
          return;
        }
        if (result && result.reason === "NO_DATA_IN_WINDOW") empty += 1;
        const levels = result && result.levels ? result.levels : [];
        state.wallHistory.record(levels.filter((level) => level.endedBy && level.endTs < window.until));
        state.wallHistory.extend(levels.filter((level) => !level.endedBy), { until: window.until, toleranceMs: columnMs });
        for (const level of levels) if (!level.endedBy) state.standing.push({ level, until: window.until, toleranceMs: columnMs });
        settleStanding(state);
        const evictedBefore = state.eventHistory.stats().evicted;
        if (result && result.events && !mergeEvents(state, result.events, "the fill", window.from, window.until)) {
          stopped = "EVENTS_REFUSED";
          return;
        }
        const before = state.eventHistory.fill;
        state.eventHistory.setFill({ from: before === null ? window.from : Math.min(before.from, window.from), until: before === null ? window.until : Math.max(before.until, window.until) });
        state.eventHistory.advance(now());
        chunks += 1;
        state.fillReadiness = { ...state.fillReadiness, chunks };
        if (state.eventHistory.stats().evicted > evictedBefore) stopped = "EVENT_HISTORY_FULL";
      }).catch((error) => {
        stopped = `WORKER_ERROR: ${error?.message ?? error}`;
      });
    }), Promise.resolve()).finally(() => {
      state.fillBusy = false;
      if (states.get(state.key) !== state) return;
      const ms = now() - startedAt;
      const range = covered();
      if (stopped === null) {
        state.fillReadiness = { state: "READY", reason: null, completedAt: now(), chunks, emptyChunks: empty, ms, pyramid: state.pyramidFill, ...range };
        log(`liquidity-publisher: filled the wall and event histories for ${state.key} from the recording: ${chunks} chunks in ${Math.round(ms / 1_000)} s${range.from === undefined ? "" : ` back to ${new Date(range.from).toISOString()}`}`);
      } else {
        state.fillReadiness = { state: "DEGRADED", reason: stopped, completedAt: now(), chunks, emptyChunks: empty, ms, pyramid: state.pyramidFill, ...range };
        log(`liquidity-publisher: the history fill for ${state.key} stopped after ${chunks} chunks (${stopped})`);
      }
    });
  }

  function backfillRequest(state, engine) {
    return {
      ...(remoteReplay === null ? { dbPath } : {
        sourceModule: require.resolve("../remote-replay-source"),
        remote: remoteReplay,
      }),
      symbol: state.symbol,
      marketKind: state.marketKind,
      rowClusters: state.rowClusters,
      windowRows: state.windowRows,
      referenceRows: state.referenceRows,
      sizeDigits,
      tickSize: engine.tickSize,
      clusterTicks: engine.clusterTicks,
      snapshotDepth: engine.snapshotDepth,
      trackerOptions: state.trackerOptions,
      aggressiveOptions: state.aggressive ? state.aggressiveOptions : undefined,
      shouldContinue: () => states.get(state.key) === state && !ctx.stopped,
      lanes: lane.laneSpecs(state),
    };
  }

  function laneCollector(state, rebuiltByLane) {
    return (index, column) => {
      if (states.get(state.key) !== state || ctx.stopped) return;
      const target = rebuiltByLane[index];
      if (target) target.push(column);
    };
  }

  function startBackfill(state, engine, gapFrom = null) {
    const at = now();
    const windowFrom = Math.max(0, at - Math.round(historyS * 1_000));
    const recentFrom = Math.max(gapFrom === null ? windowFrom : gapFrom, at - backfillMaxMs, floorMs);
    state.backfilling = true;
    state.backfillStatus = { status: "RUNNING", reason: null };
    state.recentReadiness = { state: "RUNNING", reason: "IN_PROGRESS", startedAt: at };
    state.deepBusy = true;
    state.rebuilt = [];
    state.liveDuringPass = [];
    state.priorColumns = state.history.toArray();
    state.deepPending = [];
    for (const entry of state.lanes) entry.rebuilt = [];
    Promise.resolve()
      .then(() => runPass(state, {
        ...backfillRequest(state, engine),
        fromTs: recentFrom,
        toTs: at,
        columnMs,
        onLaneColumn: laneCollector(state, state.lanes.map((entry) => entry.rebuilt)),
        onColumn: (column) => {
          if (states.get(state.key) !== state || ctx.stopped || !state.rebuilt) return;
          state.rebuilt.push(column);
          if (state.rebuilt.length === 1 || now() - state.lastAnnounceAt >= announceMs) {
            lane.mergeRebuilt(state);
            state.lastAnnounceAt = now();
            state.announce = true;
          }
        },
      }))
      .then((result) => {
        if (states.get(state.key) !== state) return;
        lane.finishRecentPass(state);
        lane.finishLanePass(state);
        state.backfillStatus = { status: "COMPLETE", reason: result?.reason ?? null };
        state.recentReadiness = { state: "READY", reason: null, completedAt: now(), columns: result?.columns ?? 0 };
        if (result && result.levels && result.levels.length > 0) state.tracker.adopt(result.levels);
        settleStanding(state);
        if (result && result.events) mergeEvents(state, result.events, "the startup pass", recentFrom, at);
        if (state.aggressive && result && result.aggressive && result.aggressive.length > 0) state.aggressive.adopt(result.aggressive);
        if (result && result.columns > 0) {
          log(`liquidity-publisher: backfilled ${result.columns} columns and ${result.levels.length} walls for ${state.key} from the collector's recording`);
        } else if (result && result.reason && result.reason !== "NO_DATABASE") {
          log(`liquidity-publisher: no backfill for ${state.key} (${result.reason}), starting live`);
        }
        store.saveStateInBackground(state, now());
        startDeepBackfill(state, engine, recentFrom, at);
      })
      .catch((error) => {
        log(`liquidity-publisher: backfill failed for ${state.key}, starting live: ${error?.message ?? error}`);
        if (states.get(state.key) !== state) return;
        const rebuilt = state.rebuilt.length;
        lane.finishRecentPass(state);
        lane.finishLanePass(state);
        state.backfillStatus = { status: "FAILED", reason: "WORKER_ERROR" };
        state.recentReadiness = { state: "FAILED", reason: "WORKER_ERROR", completedAt: now() };
        state.announce = rebuilt > 0;
        startDeepBackfill(state, engine, recentFrom, at);
      });
  }

  function deepWindows(state, until, at) {
    if (!state.deep) return [];
    const floor = Math.max(0, at - Math.round(deepS * 1_000), floorMs);
    const last = state.deep.latest();
    const windows = [];
    const from = Math.max(floor, last === null ? 0 : last.ts + deepColumnMs);
    for (let lo = from; lo < until; lo += deepChunkMs) windows.push({ from: lo, until: Math.min(until, lo + deepChunkMs), behind: false });
    const first = state.deep.length > 0 ? state.deep.toArray()[0] : null;
    if (first !== null) {
      let hi = first.ts;
      while (hi - deepColumnMs >= floor) {
        const lo = Math.max(floor, hi - deepChunkMs);
        windows.push({ from: lo, until: hi, behind: true });
        hi = lo;
      }
    }
    return windows;
  }

  function lostFlow(column) {
    return column.buy !== undefined && column.sell !== undefined && column.buy.length === 0 && column.sell.length === 0;
  }

  function repairWindows(state, at) {
    if (!state.deep) return [];
    const columns = state.deep.toArray();
    const windows = [];
    let start = -1;
    for (let i = 0; i <= columns.length; i += 1) {
      const lost = i < columns.length && lostFlow(columns[i]);
      if (lost && start < 0) start = i;
      if (!lost && start >= 0) {
        const from = columns[start].ts;
        const until = columns[i - 1].ts + deepColumnMs;
        if (until - from >= REPAIR_MIN_MS && until <= at - REPAIR_SETTLE_MS && !state.repairTried.has(from)) {
          windows.push({ from, until, kind: "repair" });
        }
        start = -1;
      }
    }
    return windows;
  }

  function mergeDeepRepair(state, window, rebuilt) {
    state.repairTried.add(window.from);
    if (!rebuilt.some((column) => !lostFlow(column))) return false;
    const kept = state.deep.toArray().filter((column) => column.ts < window.from || column.ts >= window.until);
    state.deep.clear();
    for (const column of kept.concat(rebuilt).sort((a, b) => a.ts - b.ts)) state.deep.push(column);
    lane.rebuildCoarse(state);
    state.announce = lane.retained(state) > 0;
    state.announceNow = state.announce;
    return true;
  }

  function mergeDeepBehind(state, behind) {
    if (behind.length === 0) return;
    if (lane.mergeLaneColumns(state.deep, behind) === 0) return;
    lane.rebuildCoarse(state);
    state.announce = lane.retained(state) > 0;
  }

  async function fillDeepFromPyramid(state, engine, until, at) {
    if (!ctx.pyramid || !state.deep) return;
    const fromTs = Math.max(0, at - Math.round(deepS * 1_000), floorMs);
    if (until <= fromTs) return;
    const startedAt = now();
    let result;
    try {
      result = await ctx.pyramid.deepColumns({
        marketKind: state.marketKind,
        symbol: state.symbol,
        fromTs,
        toTs: until,
        geometry: { rowWidth: state.rowWidth, tickSize: engine.tickSize, clusterTicks: engine.clusterTicks },
      });
    } catch (error) {
      result = { columns: [], reason: `READ_FAILED: ${error?.message ?? error}` };
    }
    if (states.get(state.key) !== state || ctx.stopped) return;
    const open = state.deepFolder.open;
    const columns = result.columns.filter((column) => open === null || column.ts < open);
    const added = columns.length > 0 ? lane.mergeLaneColumns(state.deep, columns) : 0;
    state.pyramidDeep = { columns: added, reason: result.reason, ms: now() - startedAt };
    if (added > 0) {
      lane.rebuildCoarse(state);
      state.announce = true;
      log(`liquidity-publisher: filled ${added} deep columns for ${state.key} from the heatmap pyramid in ${now() - startedAt} ms`);
    } else if (result.reason !== null) {
      log(`liquidity-publisher: no heatmap pyramid for ${state.key} (${result.reason}), rebuilding the deep tier from the recording`);
    }
  }

  function mergeCoarseBehind(state, behind) {
    const existing = state.coarse.toArray();
    const first = existing.length > 0 ? existing[0].ts : Infinity;
    const older = behind.filter((column) => column.ts < first);
    if (older.length === 0) return 0;
    state.coarse.clear();
    for (const column of older) state.coarse.push(column);
    for (const column of existing) state.coarse.push(column);
    if (existing.length === 0) state.coarseFoldedThrough = older[older.length - 1].ts + coarseColumnMs - 1;
    state.announce = lane.retained(state) > 0;
    state.announceNow = state.announce;
    return older.length;
  }

  function coarseWindows(state, at) {
    if (!state.coarse) return [];
    const floor = Math.max(0, at - coarseMaxAgeMs, floorMs);
    const coarseFirst = state.coarse.length > 0 ? state.coarse.toArray()[0].ts : null;
    const deepFirst = state.deep.length > 0 ? state.deep.toArray()[0].ts : null;
    let hi = Math.floor((coarseFirst ?? deepFirst ?? at) / coarseColumnMs) * coarseColumnMs;
    const windows = [];
    while (hi - coarseColumnMs >= floor) {
      const lo = Math.max(floor, hi - coarseChunkMs);
      windows.push({ from: lo, until: hi });
      hi = lo;
    }
    return windows;
  }

  function startCoarseBackfill(state, engine, at) {
    if (!state.coarse || !scheduler || state.coarseBusy) return Promise.resolve();
    const windows = coarseWindows(state, at);
    if (windows.length === 0) {
      state.coarseReadiness = { state: "READY", reason: null, completedAt: now(), columns: state.coarse.length };
      return Promise.resolve();
    }
    state.coarseBusy = true;
    state.coarseReadiness = { state: "RUNNING", reason: "IN_PROGRESS", startedAt: now() };
    const tally = { empty: 0, reason: null };
    return windows.reduce((chain, window) => chain.then(() => {
      if (states.get(state.key) !== state || ctx.stopped) return undefined;
      const rebuilt = [];
      const hours = Math.round((window.until - window.from) / 360_000) / 10;
      return runPass(state, {
        ...backfillRequest(state, engine),
        rowClusters: state.rowClusters * coarseRows,
        windowRows: Math.ceil(state.windowRows / coarseRows),
        referenceRows: Math.max(1, Math.ceil(state.referenceRows / coarseRows)),
        trackerOptions: undefined,
        aggressiveOptions: undefined,
        lanes: [],
        fromTs: window.from,
        toTs: window.until,
        columnMs: coarseSampleMs,
        foldMs: coarseColumnMs,
        onColumn: (column) => {
          if (states.get(state.key) !== state || ctx.stopped) return;
          rebuilt.push(column);
        },
      }).then((result) => {
        if (states.get(state.key) !== state) return;
        const landed = mergeCoarseBehind(state, rebuilt);
        if (landed > 0) {
          log(`liquidity-publisher: coarse-backfilled ${landed} columns for ${state.key} (${hours} h back to ${new Date(window.from).toISOString()})`);
        } else if (result && result.reason && result.reason !== "NO_DATABASE") {
          tally.empty += 1;
          tally.reason = result.reason;
        }
        store.saveState(state, now());
      }).catch((error) => {
        log(`liquidity-publisher: coarse backfill failed for ${state.key} (${hours} h from ${new Date(window.from).toISOString()}): ${error?.message ?? error}`);
      });
    }), Promise.resolve()).finally(() => {
      state.coarseBusy = false;
      if (states.get(state.key) !== state) return;
      if (tally.empty > 0) log(`liquidity-publisher: no coarse backfill for ${state.key} (${tally.reason}) over ${tally.empty} of ${windows.length} chunks`);
      state.coarseReadiness = tally.empty > 0
        ? { state: "DEGRADED", reason: "PARTIAL_COVERAGE", completedAt: now(), emptyChunks: tally.empty }
        : { state: "READY", reason: null, completedAt: now(), columns: state.coarse.length };
    });
  }

  function runDeepPasses(state, engine, windows) {
    return windows.reduce((chain, window) => chain.then(() => {
      if (states.get(state.key) !== state || ctx.stopped) return undefined;
      const rebuilt = [];
      const repair = window.kind === "repair";
      const laneRebuilt = repair ? [] : state.lanes.map(() => []);
      return runPass(state, {
        ...backfillRequest(state, engine),
        ...(repair ? { lanes: [] } : { onLaneColumn: laneCollector(state, laneRebuilt) }),
        fromTs: window.from,
        toTs: window.until,
        columnMs,
        foldMs: deepColumnMs,
        onColumn: (column) => {
          if (states.get(state.key) !== state || ctx.stopped) return;
          rebuilt.push(column);
        },
      }).then((result) => {
        if (states.get(state.key) !== state) return;
        if (window.kind === "repair") {
          const minutes = Math.round((window.until - window.from) / 60_000);
          const mergeStartedAt = performance.now();
          const merged = mergeDeepRepair(state, window, rebuilt);
          const mergeMs = performance.now() - mergeStartedAt;
          if (mergeMs > slowStepMs) log(`liquidity-publisher: slow step: deep repair merge for ${state.key} took ${Math.round(mergeMs)} ms (${rebuilt.length} columns)`);
          if (merged) {
            log(`liquidity-publisher: repaired ${rebuilt.length} columns for ${state.key} that had lost their flow (${minutes} min from ${new Date(window.from).toISOString()})`);
          } else if (isClosedThroughout(state.key.split(":")[0], window.from, window.until)) {
            log(`liquidity-publisher: no trades for ${state.key} over the ${minutes} min from ${new Date(window.from).toISOString()}, as expected: the market was closed`);
          } else {
            log(`liquidity-publisher: the recording holds no trades for ${state.key} over the ${minutes} min from ${new Date(window.from).toISOString()}; its columns keep no flow`);
          }
          store.saveStateInBackground(state, now());
          return;
        }
        mergeDeepBehind(state, rebuilt);
        lane.mergeLaneDeep(state, laneRebuilt);
        const past = adoptPass(state, result && result.levels ? result.levels : [], window.from, window.until, result && result.events ? result.events : null, result?.reason === "NO_DATA_IN_WINDOW");
        const pastBubbles = (result && result.aggressive ? result.aggressive : []).filter((event) => event.endTs !== null && event.endTs < window.until);
        if (state.aggressive && pastBubbles.length > 0) state.aggressive.adopt(pastBubbles);
        if (result && result.columns > 0) {
          log(`liquidity-publisher: deep-backfilled ${result.columns} columns and ${past} past walls for ${state.key} behind the stored tier (${Math.round((window.until - window.from) / 60_000)} min back to ${new Date(window.from).toISOString()})`);
        } else if (result && result.reason && result.reason !== "NO_DATABASE") {
          log(`liquidity-publisher: no deep backfill for ${state.key} behind the stored tier (${result.reason})`);
        }
        store.saveStateInBackground(state, now());
      }).catch((error) => {
        log(`liquidity-publisher: deep backfill behind the stored tier failed for ${state.key} (${Math.round((window.until - window.from) / 60_000)} min from ${new Date(window.from).toISOString()}): ${error?.message ?? error}`);
      });
    }), Promise.resolve()).finally(() => {
      state.deepBusy = false;
    });
  }

  function startDeepRepair(state, engine, at) {
    if (state.deepBusy || !scheduler) return;
    const windows = repairWindows(state, at);
    if (windows.length === 0) return;
    state.deepBusy = true;
    runDeepPasses(state, engine, windows);
  }

  function runHolePass(state, engine, window, tally) {
    if (states.get(state.key) !== state || ctx.stopped) return Promise.resolve();
    const minutes = Math.round((window.until - window.from) / 60_000);
    const laneRebuilt = state.lanes.map(() => []);
    const rebuilt = [];
    return runPass(state, {
      ...backfillRequest(state, engine),
      onLaneColumn: laneCollector(state, laneRebuilt),
      fromTs: window.from,
      toTs: window.until,
      columnMs,
      foldMs: deepColumnMs,
      onColumn: (column) => {
        if (states.get(state.key) !== state || ctx.stopped || !state.deepPending) return;
        rebuilt.push(column);
      },
    }).then((result) => {
      if (states.get(state.key) !== state) return;
      lane.mergeLaneColumns(state.deep, rebuilt);
      const past = adoptPass(state, result && result.levels ? result.levels : [], window.from, window.until, result && result.events ? result.events : null, result?.reason === "NO_DATA_IN_WINDOW");
      const pastBubbles = (result && result.aggressive ? result.aggressive : []).filter((event) => event.endTs !== null && event.endTs < window.until);
      if (state.aggressive && pastBubbles.length > 0) state.aggressive.adopt(pastBubbles);
      lane.mergeLaneDeep(state, laneRebuilt);
      lane.syncCoarse(state);
      state.announce = lane.retained(state) > 0;
      if (result && result.columns > 0) {
        log(`liquidity-publisher: deep-backfilled ${result.columns} columns and ${past} past walls for ${state.key} (${minutes} min from ${new Date(window.from).toISOString()}, before the live window)`);
      } else if (result && result.reason && result.reason !== "NO_DATABASE") {
        tally.empty += 1;
        tally.reason = result.reason;
      }
      store.saveStateInBackground(state, now());
    }).catch((error) => {
      log(`liquidity-publisher: deep backfill failed for ${state.key} (${minutes} min from ${new Date(window.from).toISOString()}): ${error?.message ?? error}`);
    });
  }

  function admitDeep(state) {
    if (ctx.deepAdmission === null) return Promise.resolve();
    let admission;
    try {
      admission = ctx.deepAdmission(state.key);
    } catch (error) {
      log(`liquidity-publisher: deep admission failed for ${state.key}, starting the deep tier now: ${error?.message ?? error}`);
      return Promise.resolve();
    }
    return Promise.resolve(admission).catch((error) => {
      log(`liquidity-publisher: deep admission failed for ${state.key}, starting the deep tier now: ${error?.message ?? error}`);
    });
  }

  // The runtime treats an unhandled rejection as fatal, so the whole chain is
  // one promise with one catch: a failure here degrades this pair, not the process.
  function startDeepBackfill(state, engine, until, at) {
    state.deepReadiness = state.deep ? { state: "RUNNING", reason: "IN_PROGRESS", startedAt: now() } : { state: "DISABLED", reason: "DISABLED_BY_CONFIG" };
    let windows = [];
    let repairs = [];
    let stage = "deep";
    return admitDeep(state).then(() => {
      if (states.get(state.key) !== state || ctx.stopped) return undefined;
      windows = deepWindows(state, until, at);
      repairs = repairWindows(state, at);
      return fillDeepFromPyramid(state, engine, until, at);
    }).then(() => {
      if (states.get(state.key) !== state || ctx.stopped) {
        state.deepBusy = false;
        return undefined;
      }
      const holes = windows.filter((window) => !window.behind);
      const later = repairs.concat(windows.filter((window) => window.behind).map((window) => ({ ...window, kind: "behind" })));
      const tally = { empty: 0, reason: null };
      return holes.reduce((chain, window) => chain.then(() => runHolePass(state, engine, window, tally)), Promise.resolve()).then(() => {
        if (states.get(state.key) !== state) {
          state.deepBusy = false;
          return undefined;
        }
        if (tally.empty > 0) log(`liquidity-publisher: no deep backfill for ${state.key} (${tally.reason}) over ${tally.empty} of ${holes.length} chunks before the live window`);
        flushDeepPending(state);
        return runDeepPasses(state, engine, later).then(() => {
          if (states.get(state.key) !== state) return undefined;
          state.deepReadiness = tally.empty > 0
            ? { state: "DEGRADED", reason: "PARTIAL_COVERAGE", completedAt: now(), emptyChunks: tally.empty, pyramid: state.pyramidDeep }
            : { state: "READY", reason: null, completedAt: now(), columns: state.deep ? state.deep.length : 0, pyramid: state.pyramidDeep };
          stage = "history";
          return startCoarseBackfill(state, engine, at).then(() => fillHistoriesFromPyramid(state, engine, at)).then(() => startFill(state, engine, at));
        });
      });
    }).catch((error) => {
      const reason = `WORKER_ERROR: ${error?.message ?? error}`;
      log(`liquidity-publisher: the ${stage === "deep" ? "deep tier" : "history fill"} for ${state.key} failed: ${error?.message ?? error}`);
      if (states.get(state.key) !== state) return;
      state.deepBusy = false;
      if (stage === "deep") state.deepReadiness = { state: "DEGRADED", reason, completedAt: now() };
      else if (state.fillReadiness?.state !== "READY") state.fillReadiness = { state: "DEGRADED", reason, completedAt: now(), pyramid: state.pyramidFill ?? null };
    });
  }

  function flushDeepPending(state) {
    const pending = state.deepPending;
    state.deepPending = null;
    if (!pending || !state.deep) return;
    for (const column of pending) {
      const last = state.deep.latest();
      if (last && column.ts <= last.ts) continue;
      state.deep.push(column);
    }
    lane.syncCoarse(state);
    state.announce = lane.retained(state) > 0;
    state.announceNow = state.announce;
  }

  return Object.freeze({
    runPass, backfillRequest, startBackfill, deepWindows, repairWindows, startCoarseBackfill, runDeepPasses,
    startDeepRepair, startDeepBackfill, flushDeepPending, fillWindows, fillHistoriesFromPyramid, startFill,
  });
}

module.exports = { createLaneRebuild, REPAIR_MIN_MS, REPAIR_SETTLE_MS };
