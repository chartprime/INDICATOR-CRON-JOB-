"use strict";

const { MAX_LIQUIDITY_ROWS } = require("../../../server/frames");
const { decodeColumn } = require("../../passive_liquidity/liquidity-history");
const { laneFoldFor } = require("../../passive_liquidity/liquidity-sampler");
const { sameLaneGeometry } = require("../liquidity-store");

function yieldTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createLaneStore(ctx, lane) {
  const {
    storeEnabled, storeDir, storeMaxAgeMs, storeMaxBytes, historyS, columnMs, deepColumnMs, coarseColumnMs, coarseRows, coarseMaxAgeMs,
    floorMs, restoreSliceColumns, saveHistory, saveHistoryInBackground, loadHistory, loadHistoryAsync, storeMs, now, log, states,
    saveWallHistory, saveWallHistoryInBackground, loadWallHistory, wallHistoryMaxBytes, tradeHistoryMaxBytes, wallTradeHistoryMaxBytes, histories,
  } = ctx;

  function wallGeometry(state) {
    return { rowWidth: state.rowWidth, rowClusters: state.rowClusters, tickSize: state.tickSize, clusterTicks: state.clusterTicks };
  }

  function sweepWallHistory(state, at) {
    const history = state.wallHistory;
    history.prune(at);
    history.record(state.tracker.walls().filter((wall) => wall.endTs !== null));
    history.trim();
  }

  // The live tracker records every trade near the mid from the moment the pair's ticks start, so the history holds
  // everything since then; a restart reads that back and asks the host only for what lies outside it.
  function sweepEventHistory(state, at) {
    if (Number.isSafeInteger(state.liveFrom) && at > state.liveFrom) state.eventHistory.cover(state.liveFrom, at);
    state.eventHistory.advance(at);
  }

  function seriesOf(state) {
    return [
      { suffix: "walls", unit: "ended walls", model: state.wallHistory, maxBytes: wallHistoryMaxBytes, sweep: (at) => sweepWallHistory(state, at), flag: "wallHistorySaving" },
      { suffix: "events", unit: "event buckets", model: state.eventHistory, maxBytes: tradeHistoryMaxBytes + wallTradeHistoryMaxBytes, sweep: (at) => sweepEventHistory(state, at), flag: "eventHistorySaving" },
    ];
  }

  function historyRequest(state, series, at) {
    return { dir: storeDir, pairKey: state.key, geometry: wallGeometry(state), savedAt: at, history: series.model.toJSON(), maxBytes: series.maxBytes, suffix: series.suffix };
  }

  function settleHistorySave(state, series, result) {
    state[series.flag] = false;
    if (result?.ok) {
      series.model.markSaved();
      return;
    }
    if (result?.reason === "OVER_BUDGET") {
      const dropped = series.model.trimToBytes(result.bytes);
      log(`liquidity-publisher: dropped the ${dropped} least meaningful stored ${series.unit} for ${state.key} to keep the ${series.suffix} history under ${series.maxBytes} bytes (was ${result.bytes})`);
      return;
    }
    log(`liquidity-publisher: could not store the ${series.suffix} history for ${state.key}: ${result?.reason ?? "unknown"}`);
  }

  function saveHistoriesInBackground(state, at) {
    if (!storeEnabled || !histories || saveWallHistoryInBackground === null) return;
    for (const series of seriesOf(state)) {
      if (!series.model || state[series.flag]) continue;
      series.sweep(at);
      if (!series.model.dirty) continue;
      state[series.flag] = true;
      try {
        const pending = saveWallHistoryInBackground(historyRequest(state, series, at));
        if (pending && typeof pending.then === "function") {
          pending.then((result) => settleHistorySave(state, series, result), (error) => settleHistorySave(state, series, { ok: false, reason: error?.message ?? String(error) }));
        } else {
          settleHistorySave(state, series, pending);
        }
      } catch (error) {
        settleHistorySave(state, series, { ok: false, reason: error?.message ?? String(error) });
      }
    }
  }

  function saveHistories(state, at) {
    if (!storeEnabled || !histories || saveWallHistory === null) return;
    for (const series of seriesOf(state)) {
      if (!series.model) continue;
      series.sweep(at);
      if (!series.model.dirty) continue;
      let result = saveWallHistory(historyRequest(state, series, at));
      if (result?.reason === "OVER_BUDGET" && series.model.trimToBytes(result.bytes) > 0) result = saveWallHistory(historyRequest(state, series, at));
      if (result?.ok) series.model.markSaved();
      else log(`liquidity-publisher: could not store the ${series.suffix} history for ${state.key}: ${result?.reason ?? "unknown"}`);
    }
  }

  function restoreHistories(state, at) {
    if (!storeEnabled || !histories || loadWallHistory === null) return 0;
    let restored = 0;
    for (const series of seriesOf(state)) {
      if (!series.model) continue;
      let saved = null;
      try {
        saved = loadWallHistory({ dir: storeDir, pairKey: state.key, geometry: wallGeometry(state), suffix: series.suffix, onReject: (reason) => log(`liquidity-publisher: the stored ${series.suffix} history for ${state.key} was not restored (${reason}), it refills`) });
      } catch (error) {
        log(`liquidity-publisher: could not read the stored ${series.suffix} history for ${state.key}: ${error?.message ?? error}`);
        continue;
      }
      if (!saved) continue;
      if (!series.model.load(saved.history)) {
        log(`liquidity-publisher: the stored ${series.suffix} history for ${state.key} was not restored (MALFORMED), it refills`);
        continue;
      }
      series.sweep(at);
      log(`liquidity-publisher: restored ${series.model.size} ${series.unit} for ${state.key} from the ${series.suffix} history`);
      restored += series.model.size;
    }
    return restored;
  }

  function storeRequest(state, at, recent) {
    return {
      dir: storeDir,
      pairKey: state.key,
      geometry: lane.geometryOf(state),
      savedAt: at,
      recent,
      deep: lane.deepColumnsForStore(state),
      coarse: state.coarse ? { columnMs: coarseColumnMs, rows: coarseRows, columns: lane.encodedColumns(state.coarse) } : null,
      levels: state.tracker.levels(),
      aggressive: state.aggressive ? state.aggressive.events() : [],
      ...(state.lanes.length > 0 ? { lanes: state.lanes.map((entry) => ({ ...lane.laneGeometry(entry), fold: laneFoldFor(state.marketKind), recent: lane.encodedColumns(entry.history), deep: lane.encodedColumns(entry.deep) })) } : {}),
      ...(state.shelfTrimmedBefore !== null ? { trimmedBefore: state.shelfTrimmedBefore } : {}),
      maxBytes: storeMaxBytes,
    };
  }

  function tierMark(tier) {
    return tier ? `${tier.seq}+${tier.merges ?? 0}` : "0";
  }

  function storeFingerprint(state) {
    const lanes = state.lanes.map((entry) => `${tierMark(entry.history)}:${tierMark(entry.deep)}`).join(",");
    return `${tierMark(state.history)}|${tierMark(state.deep)}|${tierMark(state.coarse)}|${state.shelf.length}|${lanes}`;
  }

  function settleBackgroundSave(state, result, fingerprint) {
    state.saving = false;
    if (result?.ok) state.savedFingerprint = fingerprint;
    if (result?.reason === "OVER_BUDGET") {
      lane.trimShelfToBudget(state, result.bytes);
      return;
    }
    if ((!result || !result.ok) && result?.reason !== "SUPERSEDED") log(`liquidity-publisher: could not store the history for ${state.key}: ${result?.reason ?? "unknown"}`);
  }

  function saveStateInBackground(state, at = now()) {
    if (!storeEnabled || !state || state.backfilling || state.saving || state.restoring) return;
    saveHistoriesInBackground(state, at);
    try {
      lane.pruneShelf(state, at);
      const fingerprint = storeFingerprint(state);
      if (fingerprint === state.savedFingerprint) {
        state.savedAt = at;
        return;
      }
      const recent = lane.encodedColumns(state.history);
      if (recent.length === 0) return;
      state.saveGeneration += 1;
      const generation = state.saveGeneration;
      state.saving = true;
      state.savedAt = at;
      const pending = saveHistoryInBackground(storeRequest(state, at, recent), { shouldCommit: () => state.saveGeneration === generation });
      if (pending && typeof pending.then === "function") {
        pending.then((result) => settleBackgroundSave(state, result, fingerprint), (error) => settleBackgroundSave(state, { ok: false, reason: error?.message ?? String(error) }, fingerprint));
      } else {
        settleBackgroundSave(state, pending, fingerprint);
      }
    } catch (error) {
      state.saving = false;
      state.savedAt = at;
      log(`liquidity-publisher: could not store the history for ${state.key}: ${error?.message ?? error}`);
    }
  }

  function saveState(state, at = now()) {
    if (!storeEnabled || !state || state.backfilling || state.restoring) return null;
    saveHistories(state, at);
    try {
      lane.pruneShelf(state, at);
      const fingerprint = storeFingerprint(state);
      if (fingerprint === state.savedFingerprint) {
        state.savedAt = at;
        return null;
      }
      const recent = lane.encodedColumns(state.history);
      if (recent.length === 0) return null;
      state.saveGeneration += 1;
      const write = () => saveHistory(storeRequest(state, at, recent));
      let result = write();
      if (result?.reason === "OVER_BUDGET" && lane.trimShelfToBudget(state, result.bytes)) result = write();
      state.savedAt = at;
      if (result?.ok) state.savedFingerprint = fingerprint;
      if (!result || !result.ok) log(`liquidity-publisher: could not store the history for ${state.key}: ${result?.reason ?? "unknown"}`);
      return result;
    } catch (error) {
      state.savedAt = at;
      log(`liquidity-publisher: could not store the history for ${state.key}: ${error?.message ?? error}`);
      return null;
    }
  }

  function loadRequest(state, at) {
    const recentMaxAge = Math.round(historyS * 1_000);
    return {
      dir: storeDir,
      pairKey: state.key,
      geometry: lane.geometryOf(state),
      maxAgeMs: state.deep ? Math.max(recentMaxAge, storeMaxAgeMs, state.coarse ? coarseMaxAgeMs : 0) : recentMaxAge,
      now: at,
      onReject: (reason) => log(`liquidity-publisher: stored history for ${state.key} was not restored (${reason}), rebuilding from the recording`),
    };
  }

  function restoreState(state, at) {
    if (!storeEnabled) return null;
    let saved = null;
    try {
      saved = loadHistory(loadRequest(state, at));
    } catch (error) {
      log(`liquidity-publisher: could not read the stored history for ${state.key}: ${error?.message ?? error}`);
      return null;
    }
    if (!saved) return null;
    const steps = applySaved(state, saved, at);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }

  async function restoreStateAsync(state, at) {
    if (!storeEnabled) return null;
    const startedAt = performance.now();
    let saved = null;
    try {
      saved = await loadHistoryAsync(loadRequest(state, at));
    } catch (error) {
      log(`liquidity-publisher: could not read the stored history for ${state.key}: ${error?.message ?? error}`);
      return null;
    }
    if (!saved || states.get(state.key) !== state || ctx.stopped) return null;
    const steps = applySaved(state, saved, at);
    let step = steps.next();
    while (!step.done) {
      await yieldTurn();
      if (states.get(state.key) !== state || ctx.stopped) return null;
      step = steps.next();
    }
    log(`liquidity-publisher: restore of ${state.key} took ${Math.round(performance.now() - startedAt)} ms in slices`);
    return step.value;
  }

  function* applySaved(state, saved, at) {
    const recentMaxAge = Math.round(historyS * 1_000);
    const fresh = at - saved.savedAt <= recentMaxAge;
    let levelsRestored = 0;
    let decoded = 0;
    try {
      if (fresh) {
        let prev = null;
        for (const wire of saved.recent) {
          prev = decodeColumn(prev, wire);
          if (prev.ts >= floorMs) state.history.push(prev);
          if (++decoded % restoreSliceColumns === 0) yield;
        }
      }
      if (state.deep) {
        let prevDeep = null;
        let dropped = 0;
        let hidden = 0;
        let hiddenFrom = 0;
        let hiddenTo = 0;
        for (const wire of saved.deep) {
          if (++decoded % restoreSliceColumns === 0) yield;
          prevDeep = decodeColumn(prevDeep, wire);
          if (prevDeep.hi - prevDeep.lo + 1 > MAX_LIQUIDITY_ROWS) {
            dropped += 1;
            continue;
          }
          if (prevDeep.ts < at - storeMaxAgeMs) continue;
          if (prevDeep.ts < floorMs) {
            if (hidden === 0) hiddenFrom = prevDeep.ts;
            hiddenTo = prevDeep.ts;
            hidden += 1;
            lane.shelve(state, prevDeep);
            continue;
          }
          state.deep.push(prevDeep);
        }
        if (dropped > 0) log(`liquidity-publisher: dropped ${dropped} stored deep columns for ${state.key} that span more than ${MAX_LIQUIDITY_ROWS} rows`);
        if (hidden > 0) log(`liquidity-publisher: the history floor hides ${hidden} stored deep columns for ${state.key} (${new Date(hiddenFrom).toISOString()} to ${new Date(hiddenTo).toISOString()}); they stay in the store`);
      }
      if (state.coarse && saved.coarse && saved.coarse.columnMs === coarseColumnMs && saved.coarse.rows === coarseRows) {
        let prevCoarse = null;
        for (const wire of saved.coarse.columns) {
          if (++decoded % restoreSliceColumns === 0) yield;
          prevCoarse = decodeColumn(prevCoarse, wire);
          if (prevCoarse.ts < at - coarseMaxAgeMs || prevCoarse.ts < floorMs || prevCoarse.ts + coarseColumnMs > saved.savedAt) continue;
          state.coarse.push(prevCoarse);
        }
        const lastCoarse = state.coarse.latest();
        state.coarseFoldedThrough = lastCoarse === null ? -Infinity : lastCoarse.ts + coarseColumnMs - 1;
      }
      for (const savedLane of saved.lanes ?? []) {
        const target = state.lanes.find((entry) => entry.k === savedLane.k);
        if (!target || !sameLaneGeometry({ ...lane.laneGeometry(target), fold: laneFoldFor(state.marketKind) }, savedLane)) continue;
        if (fresh) {
          let prevLane = null;
          for (const wire of savedLane.recent) {
            if (++decoded % restoreSliceColumns === 0) yield;
            prevLane = decodeColumn(prevLane, wire);
            if (prevLane.ts >= floorMs) target.history.push(prevLane);
          }
        }
        if (target.deep) {
          let prevLaneDeep = null;
          for (const wire of savedLane.deep) {
            if (++decoded % restoreSliceColumns === 0) yield;
            prevLaneDeep = decodeColumn(prevLaneDeep, wire);
            if (prevLaneDeep.ts < at - storeMaxAgeMs || prevLaneDeep.ts < floorMs) continue;
            target.deep.push(prevLaneDeep);
          }
        }
      }
      const levels = (fresh ? saved.levels : saved.levels.filter((level) => level.endedBy)).filter((level) => level.startTs >= floorMs);
      if (levels.length > 0) state.tracker.adopt(levels);
      levelsRestored = levels.length;
      if (!fresh) {
        for (const level of saved.levels) {
          if (level.endedBy || level.startTs < floorMs) continue;
          state.standing.push({ level, until: saved.savedAt, toleranceMs: storeMs + deepColumnMs + columnMs });
        }
      }
      if (state.aggressive) {
        const savedEvents = saved.aggressive ?? [];
        const events = (fresh ? savedEvents : savedEvents.filter((event) => event.endTs !== null)).filter((event) => event.startTs >= floorMs);
        if (events.length > 0) state.aggressive.adopt(events);
      }
    } catch (error) {
      log(`liquidity-publisher: stored history for ${state.key} would not load (${error?.message ?? error}), rebuilding from the recording`);
      state.history.clear();
      if (state.deep) state.deep.clear();
      if (state.coarse) {
        state.coarse.clear();
        state.coarseFoldedThrough = -Infinity;
      }
      state.shelf = [];
      state.shelfLast = null;
      state.standing = [];
      for (const entry of state.lanes) {
        entry.history.clear();
        if (entry.deep) entry.deep.clear();
      }
      state.tracker.clear();
      if (state.aggressive) state.aggressive.clear();
      return null;
    }
    state.announce = true;
    state.restoredFrom = saved.savedAt;
    state.shelfTrimmedBefore = Number.isSafeInteger(saved.trimmedBefore) ? saved.trimmedBefore : null;
    const last = state.history.latest();
    if (last === null && (!state.deep || state.deep.length === 0) && (!state.coarse || state.coarse.length === 0) && levelsRestored === 0) return null;
    const age = Math.round((at - saved.savedAt) / 1_000);
    log(fresh
      ? `liquidity-publisher: restored ${state.history.length} columns, ${state.deep ? state.deep.length : 0} deep${state.coarse ? `, ${state.coarse.length} coarse` : ""} and ${levelsRestored} walls for ${state.key} from the store, ${last ? `last column ${Math.round((at - last.ts) / 1_000)}s old` : "no recent column after the history floor"}`
      : `liquidity-publisher: the store for ${state.key} is ${age}s old: kept ${state.deep ? state.deep.length : 0} deep columns${state.coarse ? ` and ${state.coarse.length} coarse` : ""} and its past walls, rebuilding the recent window`);
    return last ? { gapFrom: last.ts + columnMs } : null;
  }

  return Object.freeze({ storeRequest, settleBackgroundSave, saveStateInBackground, saveState, loadRequest, restoreState, restoreStateAsync, applySaved, restoreHistories, sweepWallHistory, sweepEventHistory });
}

module.exports = { createLaneStore };
