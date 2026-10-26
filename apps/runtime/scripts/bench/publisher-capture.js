"use strict";

const crypto = require("node:crypto");
const { createLiquidityPublisher } = require("../../src/indicators/passive_liquidity/liquidity-publisher");
const { createL2Channel } = require("../../src/server/l2-channel");
const { L2_CHANNELS, MAX_L2_EVENTS } = require("../../src/server/l2-frames");

const DEFAULT_SNAPSHOT_EVERY_MS = 300_000;
const WS_OPEN = 1;

function createL2Client(name, onFrame) {
  const model = { walls: new Map(), wallSeq: null, eventSeq: null, events: [], viewSeq: new Map(), ladder: null, segment: null };
  const stats = Object.fromEntries(L2_CHANNELS.map((channel) => [channel, { frames: 0, bytes: 0, resets: 0, items: 0, maxItems: 0, missed: 0 }]));
  const hashes = Object.fromEntries(L2_CHANNELS.map((channel) => [channel, crypto.createHash("sha256")]));
  const breaks = Object.fromEntries(L2_CHANNELS.map((channel) => [channel, 0]));
  const changedFields = {};
  const eventKinds = {};
  const capped = { frames: 0, lifecycleAtCap: 0 };

  function apply(frame) {
    if (frame.segment !== undefined) model.segment = frame.segment;
    if (frame.type === "l2_walls") {
      if (frame.reset) model.walls = new Map(frame.walls.map((wall) => [wall.id, wall]));
      else {
        if (model.wallSeq !== null && frame.seq !== model.wallSeq + 1) breaks.l2_walls += 1;
        for (const wall of frame.walls) {
          const before = model.walls.get(wall.id);
          if (before === undefined) changedFields.new = (changedFields.new ?? 0) + 1;
          else {
            const fields = Object.keys(wall).filter((key) => key !== "detail" && JSON.stringify(wall[key]) !== JSON.stringify(before[key]));
            if (wall.detail && before.detail) for (const key of Object.keys(wall.detail)) if (JSON.stringify(wall.detail[key]) !== JSON.stringify(before.detail[key])) fields.push(`detail.${key}`);
            const label = fields.sort().join("+") || "(none)";
            changedFields[label] = (changedFields[label] ?? 0) + 1;
          }
          model.walls.set(wall.id, wall);
        }
        for (const id of frame.removed) model.walls.delete(id);
      }
      model.wallSeq = frame.seq;
      return frame.walls.length + frame.removed.length;
    }
    if (frame.type === "l2_events") {
      if (!frame.reset && model.eventSeq !== null && frame.seq !== model.eventSeq + frame.events.length) breaks.l2_events += 1;
      model.eventSeq = frame.seq;
      model.events = (frame.reset ? frame.events : [...model.events, ...frame.events]).slice(-MAX_L2_EVENTS);
      stats.l2_events.missed += frame.missed;
      if (!frame.reset) for (const event of frame.events) eventKinds[event.event] = (eventKinds[event.event] ?? 0) + 1;
      if (frame.missed > 0) {
        const ranked = frame.events.filter((event) => event.event !== "trade" && event.event !== "hidden").length;
        capped.frames += 1;
        if (ranked >= frame.events.length) capped.lifecycleAtCap += 1;
      }
      return frame.events.length;
    }
    if (frame.type === "l2_view") {
      const key = `${frame.lane}:${frame.tier}`;
      const last = model.viewSeq.get(key);
      if (!frame.reset && last !== undefined && frame.seq !== last + frame.columns.length) breaks.l2_view += 1;
      model.viewSeq.set(key, frame.seq);
      return frame.columns.length;
    }
    model.ladder = frame;
    return frame.bids.length + frame.asks.length;
  }

  const pending = [];

  function absorb(serialized) {
    const frame = JSON.parse(serialized);
    const entry = stats[frame.type];
    entry.frames += 1;
    entry.bytes += Buffer.byteLength(serialized);
    if (frame.reset === true) entry.resets += 1;
    const items = apply(frame);
    entry.items += items;
    entry.maxItems = Math.max(entry.maxItems, items);
    hashes[frame.type].update(serialized);
    hashes[frame.type].update("\n");
    if (onFrame) onFrame(`l2:${name}`, frame);
  }

  const client = {
    name,
    readyState: WS_OPEN,
    bufferedAmount: 0,
    receive(serialized) {
      pending.push(serialized);
    },
  };

  function drain() {
    for (const serialized of pending.splice(0)) absorb(serialized);
  }

  return { client, drain, model, stats, breaks, changedFields, eventKinds, capped, digests:() => Object.fromEntries(L2_CHANNELS.map((channel) => [channel, hashes[channel].digest("hex")])) };
}

function sortedWalls(walls) {
  return JSON.stringify([...walls.values()].sort((a, b) => a.id - b.id));
}

function createPublisherCapture({
  engine,
  marketKind,
  symbol,
  rowClusters = null,
  notionalMultiplier = 1,
  snapshotEveryMs = DEFAULT_SNAPSHOT_EVERY_MS,
  publisherOptions = {},
  onFrame = null,
  l2Identity = null,
}) {
  let clock = 0;
  let nextSnapshotTs = null;
  const hashes = { live: crypto.createHash("sha256"), snapshots: crypto.createHash("sha256"), store: crypto.createHash("sha256") };
  const counts = { ticks: 0, nullTicks: 0, liveFrames: 0, resets: 0, snapshots: 0, snapshotFrames: 0, stores: 0, storeBytes: 0 };
  const columnMsSeen = {};
  const tickMs = [];
  const saveTickMs = [];
  const tickThroughL2Ms = [];
  const saveTickThroughL2Ms = [];
  let savedThisTick = false;
  let liveBytes = 0;
  const memory = {
    getEngine: (kind, sym) => (kind === marketKind && sym === symbol ? engine : null),
    notionalMultiplier: () => notionalMultiplier,
    ...(rowClusters === null ? {} : { rowClusters: () => rowClusters }),
  };
  const publisher = createLiquidityPublisher({
    memory,
    backfillEnabled: false,
    storeEnabled: true,
    saveHistory: (request) => {
      savedThisTick = true;
      const text = JSON.stringify(request);
      hashes.store.update(text);
      counts.stores += 1;
      counts.storeBytes += text.length;
      if (onFrame) onFrame("store", request);
      return { ok: true, bytes: text.length };
    },
    loadHistory: () => null,
    now: () => clock,
    log: () => {},
    ...publisherOptions,
  });
  const pair = Object.freeze({ marketKind, symbol });
  const l2PublishMs = [];
  const l2TaskMs = [];
  const joins = { count: 0, wallMismatches: 0, eventSeqMismatches: 0, eventRingMismatches: 0, viewSeqMismatches: 0, ladderMismatches: 0, segmentMismatches: 0 };
  let live = null;
  let channel = null;
  if (l2Identity !== null) {
    const send = (client, serialized) => {
      client.receive(serialized);
      return true;
    };
    channel = createL2Channel({
      logPrefix: "publisher-capture l2",
      wsOpen: WS_OPEN,
      safelySend: (client, frame) => send(client, JSON.stringify(frame)),
      safelySendSerialized: send,
      softBytes: 1_048_576,
      activePair: () => pair,
      identityOf: () => l2Identity,
      snapshotOf: () => publisher.l2Snapshot(marketKind, symbol),
      now: () => clock,
      log: { error: (...args) => { throw new Error(`l2 channel error: ${args.join(" ")}`); } },
      replayerOptions: { batch: Number.MAX_SAFE_INTEGER },
    });
    live = createL2Client("live", onFrame);
    channel.subscribe(live.client, new Set(L2_CHANNELS));
    live.drain();
  }

  function joinCheck() {
    const joiner = createL2Client("join", onFrame);
    channel.subscribe(joiner.client, new Set(L2_CHANNELS));
    channel.forget(joiner.client);
    joiner.drain();
    live.drain();
    if (onFrame) onFrame("l2:joined", null);
    joins.count += 1;
    if (sortedWalls(joiner.model.walls) !== sortedWalls(live.model.walls)) joins.wallMismatches += 1;
    if (joiner.model.eventSeq !== live.model.eventSeq) joins.eventSeqMismatches += 1;
    const sortedEvents = (events) => JSON.stringify([...events].sort((a, b) => a.ts - b.ts));
    if (sortedEvents(joiner.model.events) !== sortedEvents(live.model.events)) joins.eventRingMismatches += 1;
    const sortedViewSeq = (seqs) => JSON.stringify([...seqs].sort(([a], [b]) => a.localeCompare(b)));
    if (sortedViewSeq(joiner.model.viewSeq) !== sortedViewSeq(live.model.viewSeq)) joins.viewSeqMismatches += 1;
    if (JSON.stringify(joiner.model.ladder) !== JSON.stringify(live.model.ladder)) joins.ladderMismatches += 1;
    if (JSON.stringify(joiner.model.segment) !== JSON.stringify(live.model.segment)) joins.segmentMismatches += 1;
    for (const channelName of L2_CHANNELS) {
      const entry = joiner.stats[channelName];
      joins[`${channelName}Bytes`] = (joins[`${channelName}Bytes`] ?? 0) + entry.bytes;
    }
  }

  function record(kind, hash, frame) {
    const text = JSON.stringify(frame);
    hash.update(text);
    hash.update("\n");
    if (kind === "live") liveBytes += Buffer.byteLength(text);
    if (frame && frame.reset === true) counts.resets += 1;
    const columnMs = frame?.column_ms ?? null;
    if (columnMs !== null) columnMsSeen[columnMs] = (columnMsSeen[columnMs] ?? 0) + 1;
    if (onFrame) onFrame(kind, frame);
  }

  function tick(at) {
    clock = at;
    counts.ticks += 1;
    savedThisTick = false;
    const startedAt = performance.now();
    const out = publisher.tick(marketKind, symbol, at);
    (savedThisTick ? saveTickMs : tickMs).push(performance.now() - startedAt);
    if (out === null || out === undefined) {
      counts.nullTicks += 1;
    } else {
      for (const frame of Array.isArray(out) ? out : [out]) {
        counts.liveFrames += 1;
        record("live", hashes.live, frame);
      }
    }
    if (channel !== null) {
      const taskAt = performance.now();
      const l2Out = publisher.takeL2(marketKind, symbol);
      if (l2Out) {
        const publishedAt = performance.now();
        channel.publish(l2Out, pair);
        l2PublishMs.push(performance.now() - publishedAt);
      }
      const doneAt = performance.now();
      l2TaskMs.push(doneAt - taskAt);
      (savedThisTick ? saveTickThroughL2Ms : tickThroughL2Ms).push(doneAt - startedAt);
      live.drain();
    }
    if (nextSnapshotTs === null) nextSnapshotTs = at + snapshotEveryMs;
    if (at >= nextSnapshotTs) {
      nextSnapshotTs += snapshotEveryMs;
      const frames = publisher.snapshotFrames(marketKind, symbol);
      counts.snapshots += 1;
      for (const frame of frames) {
        counts.snapshotFrames += 1;
        record("snapshot", hashes.snapshots, frame);
      }
      if (channel !== null) joinCheck();
    }
  }

  function l2Summary() {
    if (channel === null) return null;
    live.drain();
    const wallChanges = Object.fromEntries(Object.entries(live.changedFields).sort((a, b) => b[1] - a[1]).slice(0, 12));
    return { liquidityBytes: liveBytes, stats: live.stats, eventKinds: live.eventKinds, capped: live.capped, chainBreaks: live.breaks, wallChanges, joins, digests: live.digests() };
  }

  function laneSummary() {
    const view = publisher.lanes(marketKind, symbol);
    if (!view || view.lanes.length === 0) return null;
    return {
      windowPct: view.windowPct,
      lanes: view.lanes.map((lane) => ({
        k: lane.k,
        rowWidth: lane.rowWidth,
        columnMs: lane.columnMs,
        reachPct: Math.round(lane.reachPct * 100) / 100,
        recent: lane.recent.length,
        deep: lane.deep.length,
        rows: lane.recent.length > 0 ? lane.recent[lane.recent.length - 1].hi - lane.recent[lane.recent.length - 1].lo + 1 : 0,
      })),
    };
  }

  function spread(values) {
    if (values.length === 0) return null;
    const sorted = Float64Array.from(values).sort();
    const at = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] * 1_000) / 1_000;
    return { count: sorted.length, p50Ms: at(0.5), p99Ms: at(0.99), maxMs: at(1) };
  }

  function timing() {
    const stats = publisher.stats().retentionByPair[`${marketKind}:${symbol}`];
    const view = publisher.lanes(marketKind, symbol);
    return {
      ticks: spread(tickMs),
      saveTicks: spread(saveTickMs),
      l2Publish: spread(l2PublishMs),
      l2Task: spread(l2TaskMs),
      ...(channel === null ? {} : { ticksThroughL2: spread(tickThroughL2Ms), saveTicksThroughL2: spread(saveTickThroughL2Ms) }),
      lane0SideBufferBytes: stats ? stats.sideBufferBytes : null,
      laneSideBufferBytes: view ? view.lanes.map((lane) => lane.sideBufferBytes) : [],
    };
  }

  function finish() {
    const lanes = laneSummary();
    const l2 = l2Summary();
    publisher.stop();
    return {
      counts,
      columnMsSeen,
      ...(lanes === null ? {} : { lanes }),
      ...(l2 === null ? {} : { l2 }),
      digests: {
        live: hashes.live.digest("hex"),
        snapshots: hashes.snapshots.digest("hex"),
        store: hashes.store.digest("hex"),
      },
    };
  }

  return Object.freeze({ tick, finish, timing, publisher });
}

module.exports = { createPublisherCapture, DEFAULT_SNAPSHOT_EVERY_MS };
