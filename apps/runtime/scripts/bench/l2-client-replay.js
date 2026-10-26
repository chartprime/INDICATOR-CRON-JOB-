"use strict";

const fs = require("node:fs");
const { parseArgs } = require("./l2-engine-bench");
const { run } = require("./l2-publisher-golden");
const { requireWeb } = require("./web-modules");

const { parseServerFrame } = requireWeb("src/types/frames.ts");
const { L2Store } = requireWeb("src/lib/l2/l2Store.ts");
const { LiquidityGrid, LiquidityDecoder } = requireWeb("src/lib/indicators/passive-liquidity/liquidityGrid.ts");
const { LaneDecoder } = requireWeb("src/lib/l2/laneGrids.ts");

function gridState(grid) {
  const columns = (list) => list.map((column) => [column.ts, column.lo, column.hi, Array.from(column.bid), Array.from(column.ask), column.reference ?? null, column.median ?? null]);
  return JSON.stringify({
    fine: columns(grid.columns), deep: columns(grid.deepColumns), coarse: columns(grid.coarseColumns),
    rowWidth: grid.rowWidth, reference: grid.referenceSize, version: grid.version, epoch: grid.epoch, synced: grid.synced, rejected: grid.rejected,
  });
}

function shipped(frame, result, columns) {
  const transfer = columns.flatMap((column) => [column.bid.buffer, column.ask.buffer]);
  return structuredClone({ frame: { ...frame, columns: frame.columns.map((column) => ({ ...column, bid: [], ask: [] })) }, result }, { transfer });
}

function percentiles(values) {
  if (values.length === 0) return null;
  const sorted = Float64Array.from(values).sort();
  const at = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] * 1_000) / 1_000;
  return { count: sorted.length, p50Ms: at(0.5), p99Ms: at(0.99), maxMs: at(1) };
}

function laneColumns(store) {
  const out = {};
  for (const info of store.lanes.lanes()) {
    const view = store.lanes.view(info.lane);
    const tiers = [["fine", view.fine]];
    if (view.deep) tiers.push(["deep", view.deep]);
    for (const [name, tier] of tiers) {
      out[`${info.lane}:${name}`] = tier.columns.map((column) => ({ ts: column.ts, lo: column.lo, hi: column.hi, bid: Array.from(column.bid), ask: Array.from(column.ask) }));
    }
  }
  return out;
}

function lastEventsByTs(store, count) {
  const events = store.events.since().events;
  return events.slice(Math.max(0, events.length - count)).map((event, index) => ({ event, index })).sort((a, b) => a.event.ts - b.event.ts || a.index - b.index).map((entry) => entry.event);
}

function coverage(join) {
  const lanes = laneColumns(join);
  return {
    walls: join.walls.list().length,
    events: join.events.since().events.length,
    laneTiers: Object.keys(lanes).length,
    laneColumns: Object.values(lanes).reduce((sum, columns) => sum + columns.length, 0),
    ladderLevels: join.ladder.ladder === null ? 0 : join.ladder.ladder.bids.length + join.ladder.ladder.asks.length,
  };
}

function compare(live, join) {
  const mismatches = [];
  const same = (label, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push(label);
  };
  same("walls", live.walls.list(), join.walls.list());
  same("wallSeq", live.walls.seq, join.walls.seq);
  const joinCount = join.events.since().events.length;
  same("eventSeq", live.events.seq, join.events.seq);
  same("events", lastEventsByTs(live, joinCount), lastEventsByTs(join, joinCount));
  same("ladder", live.ladder.ladder, join.ladder.ladder);
  same("segment", live.segment, join.segment);
  const liveLanes = laneColumns(live);
  const joinLanes = laneColumns(join);
  same("laneKeys", Object.keys(liveLanes).sort(), Object.keys(joinLanes).sort());
  for (const [key, columns] of Object.entries(joinLanes)) {
    const mine = liveLanes[key] ?? [];
    same(`lane ${key}`, mine.slice(mine.length - columns.length), columns);
  }
  for (const channel of ["l2_view", "l2_walls", "l2_events"]) if (!live.status(channel).synced) mismatches.push(`${channel} untrusted`);
  return mismatches;
}

function laneBytes(store) {
  let bytes = 0;
  for (const info of store.lanes.lanes()) {
    const view = store.lanes.view(info.lane);
    for (const tier of [view.fine, view.deep]) if (tier) for (const column of tier.columns) bytes += column.bid.byteLength + column.ask.byteLength;
  }
  return bytes;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const dropWallsIncrement = Number(process.env.L2_REPLAY_DROP_WALLS_INCREMENT ?? 0);
  let wallsIncrements = 0;
  const compared = { walls: 0, events: 0, laneTiers: 0, laneColumns: 0, ladderLevels: 0 };
  const resyncs = [];
  const live = new L2Store({ requestResync: (channel) => resyncs.push(channel) });
  let join = null;
  let joinName = null;
  const joins = [];
  const applyMs = [];
  const perSecond = new Map();
  let rejected = 0;
  const heatSingle = new LiquidityGrid();
  const heatSplit = new LiquidityGrid();
  const heatDecoder = new LiquidityDecoder();
  const split = new L2Store();
  const splitLanes = new LaneDecoder();
  const cost = { singleMain: [], splitMain: [], splitWorker: [] };
  const costPerSecond = { singleMain: new Map(), splitMain: new Map(), splitWorker: new Map() };
  const addCost = (name, ts, ms) => {
    cost[name].push(ms);
    const second = Math.floor(ts / 1_000);
    costPerSecond[name].set(second, (costPerSecond[name].get(second) ?? 0) + ms);
  };
  const splitChecks = [];
  let heatFrames = 0;
  const checkSplit = (label) => {
    const mismatches = [];
    if (gridState(heatSingle) !== gridState(heatSplit)) mismatches.push("heatmap");
    if (JSON.stringify(laneColumns(live)) !== JSON.stringify(laneColumns(split))) mismatches.push("lanes");
    const laneStatus = (store) => {
      const { synced, seq, lastTs } = store.status("l2_view");
      return JSON.stringify({ synced, seq, lastTs, lanes: store.lanes.lanes() });
    };
    if (laneStatus(live) !== laneStatus(split)) mismatches.push("lane status");
    splitChecks.push({ label, mismatches, heatColumns: heatSingle.columns.length + heatSingle.deepColumns.length + heatSingle.coarseColumns.length });
  };
  const finishJoin = () => {
    if (join === null) return;
    joins.push({ name: joinName, mismatches: compare(live, join) });
    for (const [key, value] of Object.entries(coverage(join))) compared[key] += value;
    join = null;
    joinName = null;
  };
  const onFrame = (kind, frame) => {
    if (kind === "live" && frame && frame.type === "liquidity") {
      const parsed = parseServerFrame(frame);
      if (parsed === null) {
        rejected += 1;
        return;
      }
      heatFrames += 1;
      let at = performance.now();
      heatSingle.apply(parsed);
      addCost("singleMain", frame.ts, performance.now() - at);
      at = performance.now();
      const decoded = heatDecoder.decode(parsed);
      const message = shipped(parsed, decoded, decoded.columns);
      addCost("splitWorker", frame.ts, performance.now() - at);
      at = performance.now();
      heatSplit.applyDecoded(message.frame, message.result);
      addCost("splitMain", frame.ts, performance.now() - at);
    } else if (kind === "l2:joined") {
      finishJoin();
      checkSplit(`join ${joins.length}`);
    } else if (kind === "l2:live") {
      if (frame.type === "l2_walls" && !frame.reset) {
        wallsIncrements += 1;
        if (wallsIncrements === dropWallsIncrement) return;
      }
      const started = performance.now();
      const parsed = parseServerFrame(frame);
      if (parsed === null) {
        rejected += 1;
        return;
      }
      const applyStarted = performance.now();
      live.apply(parsed);
      const took = performance.now() - started;
      applyMs.push(took);
      const second = Math.floor(frame.ts / 1_000);
      perSecond.set(second, (perSecond.get(second) ?? 0) + took);
      if (parsed.type === "l2_view") {
        addCost("singleMain", frame.ts, performance.now() - applyStarted);
        let at = performance.now();
        const result = splitLanes.decode(parsed);
        const message = shipped(parsed, result, result.decoded === null ? [] : result.decoded.columns);
        addCost("splitWorker", frame.ts, performance.now() - at);
        at = performance.now();
        split.apply(message.frame, message.result);
        addCost("splitMain", frame.ts, performance.now() - at);
      } else {
        split.apply(parsed);
      }
    } else if (kind === "l2:join") {
      if (join === null) {
        join = new L2Store();
        joinName = `join ${joins.length + 1}`;
      }
      const parsed = parseServerFrame(frame);
      if (parsed === null) rejected += 1;
      else join.apply(parsed);
    }
  };
  const result = run({ ...options, onFrame });
  finishJoin();
  checkSplit("end");
  const perSecondOf = (map) => percentiles([...map.values()]);
  const summary = {
    kind: "l2-client-replay",
    symbol: options.symbol,
    provider: options.provider,
    window: result.window,
    framesApplied: applyMs.length,
    rejected,
    resyncRequests: resyncs.length,
    ...(dropWallsIncrement > 0 ? { negativeControl: `dropped live walls increment ${dropWallsIncrement}`, resyncChannels: [...new Set(resyncs)] } : {}),
    joins: joins.length,
    compared,
    joinsWithMismatches: joins.filter((entry) => entry.mismatches.length > 0),
    applyPerFrame: percentiles(applyMs),
    applyPerSecond: percentiles([...perSecond.values()]),
    laneTypedArrayMiB: Math.round((laneBytes(live) / 1_048_576) * 10) / 10,
    finalWalls: live.walls.list().length,
    finalEventsHeld: live.events.since().events.length,
    workerDecode: {
      heatmapFrames: heatFrames,
      checks: splitChecks.length,
      checksWithMismatches: splitChecks.filter((check) => check.mismatches.length > 0),
      heatmapColumnsAtEnd: splitChecks.length > 0 ? splitChecks[splitChecks.length - 1].heatColumns : 0,
      mainThreadBefore: { perFrame: percentiles(cost.singleMain), perSecond: perSecondOf(costPerSecond.singleMain) },
      mainThreadAfter: { perFrame: percentiles(cost.splitMain), perSecond: perSecondOf(costPerSecond.splitMain) },
      worker: { perFrame: percentiles(cost.splitWorker), perSecond: perSecondOf(costPerSecond.splitWorker) },
    },
    l2GoldenSha256: result.l2GoldenSha256,
  };
  const text = `${JSON.stringify(summary, null, 2)}\n`;
  if (options.out) fs.writeFileSync(options.out, text);
  process.stdout.write(text);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { compare };
