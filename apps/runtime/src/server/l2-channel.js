"use strict";

const { frameKindOf } = require("./frames");
const { l2ViewFrame, l2WallsFrame, l2EventsFrame, l2LadderFrame, L2_CHANNELS } = require("./l2-frames");
const { createLiquidityReplayer, LIQUIDITY_RESYNC_MIN_INTERVAL_MS } = require("./market-data-server-shared");

const LANED_WALLS = "l2_walls_lanes";
const REPLAYED_CHANNELS = Object.freeze(["l2_view", "l2_walls", LANED_WALLS, "l2_events"]);
const CHANNELS = Object.freeze([...L2_CHANNELS, LANED_WALLS]);

function wireChannelOf(channel) {
  return channel === LANED_WALLS ? "l2_walls" : channel;
}

function parseL2Resync(message) {
  if (!message || typeof message !== "object" || message.type !== "l2_resync") return null;
  const keys = Object.keys(message).sort();
  if (keys.length !== 2 || keys[0] !== "channel" || keys[1] !== "type") return null;
  return L2_CHANNELS.includes(message.channel) ? message.channel : null;
}

function lastColumnTs(entry) {
  return entry.columns[entry.columns.length - 1].ts;
}

function viewFrames(identity, entries, segment) {
  return entries.map((entry) => l2ViewFrame(identity, {
    lane: entry.lane,
    tier: entry.tier,
    ts: lastColumnTs(entry),
    seq: entry.seq,
    reset: entry.reset,
    rowWidth: entry.rowWidth,
    columnMs: entry.columnMs,
    columns: entry.columns,
    segment,
  }));
}

function snapshotFramesOf(channel, identity, snap) {
  if (channel === "l2_view") return viewFrames(identity, snap.view, snap.segment);
  if (channel === "l2_walls") {
    return [l2WallsFrame(identity, { ts: snap.ts, seq: snap.walls.seq, reset: true, rowWidth: snap.rowWidth, walls: snap.walls.walls, segment: snap.segment })];
  }
  if (channel === LANED_WALLS) {
    return [l2WallsFrame(identity, { ts: snap.ts, seq: snap.lanedWalls.seq, reset: true, rowWidth: snap.rowWidth, walls: snap.lanedWalls.walls, segment: snap.segment, lanes: true })];
  }
  if (channel === "l2_events") {
    return [l2EventsFrame(identity, { ts: snap.ts, seq: snap.events.seq, reset: true, events: snap.events.events, missed: 0 })];
  }
  return snap.ladder ? [l2LadderFrame(identity, { ts: snap.ts, ...snap.ladder, segment: snap.segment })] : [];
}

function createL2Channel({
  logPrefix,
  wsOpen,
  safelySend,
  safelySendSerialized,
  softBytes,
  activePair,
  identityOf,
  snapshotOf,
  now = () => Date.now(),
  log = console,
  replayerOptions = {},
  rejoinMinIntervalMs = LIQUIDITY_RESYNC_MIN_INTERVAL_MS,
}) {
  if (typeof logPrefix !== "string" || logPrefix.length === 0) throw new Error("l2-channel: logPrefix must be a non-empty string");
  for (const [name, value] of [["safelySend", safelySend], ["safelySendSerialized", safelySendSerialized], ["activePair", activePair], ["identityOf", identityOf], ["snapshotOf", snapshotOf]]) {
    if (typeof value !== "function") throw new Error(`l2-channel: ${name} must be a function`);
  }
  const subscribers = new Map(CHANNELS.map((channel) => [channel, new Set()]));
  const flagsByClient = new Map();
  const joinedAt = new Map();
  const pendingJoins = new Map();
  let latestLadder = null;
  let batching = false;
  let batchSnapshot = null;

  function inBatch(fn) {
    if (batching) return fn();
    batching = true;
    batchSnapshot = null;
    try {
      return fn();
    } finally {
      batching = false;
      batchSnapshot = null;
    }
  }

  function snapshotFor(pair) {
    const key = `${pair.marketKind}:${pair.symbol}`;
    if (batching && batchSnapshot !== null && batchSnapshot.key === key) return batchSnapshot.snap;
    const snap = snapshotOf(pair);
    if (batching) batchSnapshot = { key, snap };
    return snap;
  }

  function channelSnapshot(channel) {
    const pair = activePair();
    if (!pair) return [];
    try {
      const snap = snapshotFor(pair);
      if (!snap) return [];
      return snapshotFramesOf(channel, identityOf(pair), snap);
    } catch (error) {
      log.error(`${logPrefix}: ${channel} snapshot failed`, error?.message ?? error);
      return [];
    }
  }

  const replayers = new Map(REPLAYED_CHANNELS.map((channel) => [channel, createLiquidityReplayer({
    logPrefix: `${logPrefix} ${wireChannelOf(channel)}`,
    clients: subscribers.get(channel),
    wsOpen,
    safelySend,
    safelySendSerialized,
    snapshotFrames: () => channelSnapshot(channel),
    softBytes,
    now,
    log,
    ...replayerOptions,
  })]));

  function sendLadder(client) {
    if (latestLadder === null) {
      const [frame] = channelSnapshot("l2_ladder");
      if (!frame) return true;
      latestLadder = { serialized: JSON.stringify(frame), kind: frameKindOf(frame) };
    }
    return safelySendSerialized(client, latestLadder.serialized, latestLadder.kind);
  }

  function join(client, channel) {
    subscribers.get(channel).add(client);
    if (channel === "l2_ladder") {
      sendLadder(client);
      return;
    }
    const byChannel = joinedAt.get(client) ?? new Map();
    byChannel.set(channel, now());
    joinedAt.set(client, byChannel);
    replayers.get(channel).start(client, channelSnapshot(channel));
  }

  function cancelPending(client, channel) {
    const timers = pendingJoins.get(client);
    const timer = timers?.get(channel);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(channel);
    if (timers.size === 0) pendingJoins.delete(client);
  }

  function admit(client, channel) {
    const last = joinedAt.get(client)?.get(channel);
    const wait = channel === "l2_ladder" || last === undefined ? 0 : last + rejoinMinIntervalMs - now();
    if (wait <= 0) {
      join(client, channel);
      return;
    }
    cancelPending(client, channel);
    const timer = setTimeout(() => {
      cancelPending(client, channel);
      inBatch(() => join(client, channel));
    }, wait);
    timer.unref?.();
    const timers = pendingJoins.get(client) ?? new Map();
    timers.set(channel, timer);
    pendingJoins.set(client, timers);
  }

  function leave(client, channel) {
    cancelPending(client, channel);
    subscribers.get(channel).delete(client);
    if (channel !== "l2_ladder") replayers.get(channel).forget(client);
  }

  function subscribe(client, flags) {
    inBatch(() => {
      const wanted = new Set(L2_CHANNELS.filter((channel) => flags.has(channel)));
      if (wanted.has("l2_walls") && flags.has(LANED_WALLS)) {
        wanted.delete("l2_walls");
        wanted.add(LANED_WALLS);
      }
      const had = flagsByClient.get(client) ?? new Set();
      for (const channel of had) if (!wanted.has(channel)) leave(client, channel);
      if (wanted.size === 0) flagsByClient.delete(client);
      else flagsByClient.set(client, wanted);
      for (const channel of wanted) {
        if (had.has(channel)) continue;
        admit(client, channel);
      }
    });
  }

  function flagsOf(client) {
    const flags = new Set();
    for (const channel of flagsByClient.get(client) ?? []) {
      flags.add(wireChannelOf(channel));
      if (channel === LANED_WALLS) flags.add(LANED_WALLS);
    }
    return flags;
  }

  function restart(channel) {
    const clients = subscribers.get(channel);
    if (clients.size === 0) return;
    if (channel === "l2_ladder") {
      for (const client of clients) sendLadder(client);
      return;
    }
    const frames = channelSnapshot(channel);
    const replayer = replayers.get(channel);
    for (const client of clients) replayer.start(client, frames);
  }

  function send(channel, frames) {
    if (channel === "l2_ladder") {
      const frame = frames[frames.length - 1];
      latestLadder = { serialized: JSON.stringify(frame), kind: frameKindOf(frame) };
      for (const client of subscribers.get(channel)) {
        if (client.readyState === wsOpen) safelySendSerialized(client, latestLadder.serialized, latestLadder.kind);
      }
      return;
    }
    const replayer = replayers.get(channel);
    for (const frame of frames) replayer.broadcast(frame);
  }

  function incrementFrames(channel, identity, out) {
    if (channel === "l2_view") return out.viewReset ? null : viewFrames(identity, out.view, out.segment);
    if (channel === "l2_walls") {
      if (!out.walls) return [];
      return [l2WallsFrame(identity, { ts: out.ts, seq: out.walls.seq, reset: out.walls.reset, rowWidth: out.rowWidth, walls: out.walls.walls, removed: out.walls.removed, segment: out.segment })];
    }
    if (channel === LANED_WALLS) {
      if (!out.lanedWalls) return [];
      return [l2WallsFrame(identity, { ts: out.ts, seq: out.lanedWalls.seq, reset: out.lanedWalls.reset, rowWidth: out.rowWidth, walls: out.lanedWalls.walls, removed: out.lanedWalls.removed, segment: out.segment, lanes: true })];
    }
    if (channel === "l2_events") {
      if (!out.events) return [];
      return [l2EventsFrame(identity, { ts: out.ts, seq: out.events.seq, reset: false, events: out.events.events, missed: out.events.missed })];
    }
    return out.ladder ? [l2LadderFrame(identity, { ts: out.ts, ...out.ladder, segment: out.segment })] : [];
  }

  function publish(out, pair) {
    inBatch(() => publishNow(out, pair));
  }

  function publishNow(out, pair) {
    if (!out) return;
    const active = activePair();
    if (!active || active.marketKind !== pair.marketKind || active.symbol !== pair.symbol) return;
    const identity = identityOf(pair);
    for (const channel of CHANNELS) {
      if (channel === "l2_ladder") {
        if (!out.ladder) continue;
      } else if (subscribers.get(channel).size === 0) {
        continue;
      }
      if (out.fresh && channel !== "l2_ladder") {
        restart(channel);
        continue;
      }
      let frames;
      try {
        frames = incrementFrames(channel, identity, out);
      } catch (error) {
        log.error(`${logPrefix}: ${channel} increment failed; resending the snapshot`, error?.message ?? error);
        restart(channel);
        continue;
      }
      if (frames === null) {
        restart(channel);
        continue;
      }
      if (frames.length > 0) send(channel, frames);
    }
  }

  function resync(client, wireChannel) {
    const channel = wireChannel === "l2_walls" && subscribers.get(LANED_WALLS).has(client) ? LANED_WALLS : wireChannel;
    if (!subscribers.get(channel)?.has(client)) return false;
    if (channel === "l2_ladder") return sendLadder(client);
    return replayers.get(channel).resync(client);
  }

  function reselect() {
    inBatch(() => {
      latestLadder = null;
      for (const channel of REPLAYED_CHANNELS) restart(channel);
      restart("l2_ladder");
    });
  }

  function forget(client) {
    for (const channel of CHANNELS) leave(client, channel);
    flagsByClient.delete(client);
    joinedAt.delete(client);
  }

  function stopAll() {
    for (const replayer of replayers.values()) replayer.stopAll();
    for (const timers of pendingJoins.values()) for (const timer of timers.values()) clearTimeout(timer);
    pendingJoins.clear();
    joinedAt.clear();
    for (const clients of subscribers.values()) clients.clear();
    flagsByClient.clear();
    latestLadder = null;
  }

  return Object.freeze({
    subscribe,
    flagsOf,
    publish,
    resync,
    reselect,
    forget,
    stopAll,
    subscribers: (channel) => subscribers.get(channel)?.size ?? 0,
  });
}

module.exports = { createL2Channel, parseL2Resync, snapshotFramesOf, REPLAYED_CHANNELS };
