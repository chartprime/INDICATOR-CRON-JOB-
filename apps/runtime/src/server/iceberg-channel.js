"use strict";

const { icebergOrdersFrame, icebergOrdersFrames, MAX_ICEBERG_ORDERS } = require("./iceberg-frames");
const { createLiquidityReplayer } = require("./market-data-server-shared");

const CAPABILITY = "iceberg_orders";

function pairKeyOf(pair) {
  return `${pair.marketKind}:${pair.symbol}`;
}

function createIcebergChannel({
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
}) {
  if (typeof logPrefix !== "string" || logPrefix.length === 0) throw new Error("iceberg-channel: logPrefix must be a non-empty string");
  for (const [name, value] of [["safelySend", safelySend], ["safelySendSerialized", safelySendSerialized], ["activePair", activePair], ["identityOf", identityOf], ["snapshotOf", snapshotOf]]) {
    if (typeof value !== "function") throw new Error(`iceberg-channel: ${name} must be a function`);
  }
  const subscribers = new Set();
  const seqByPair = new Map();

  function snapshotFrames() {
    const pair = activePair();
    if (!pair) return [];
    try {
      const snap = snapshotOf(pair);
      if (!snap) return [];
      return icebergOrdersFrames(identityOf(pair), snap.ts, snap.icebergs, { watched: snap.watched ?? [], liveSince: snap.liveSince });
    } catch (error) {
      log.error(`${logPrefix}: ${CAPABILITY} snapshot failed`, error?.message ?? error);
      return [];
    }
  }

  const replayer = createLiquidityReplayer({
    logPrefix: `${logPrefix} ${CAPABILITY}`,
    clients: subscribers,
    wsOpen,
    safelySend,
    safelySendSerialized,
    snapshotFrames,
    softBytes,
    now,
    log,
    ...replayerOptions,
  });

  function leave(client) {
    subscribers.delete(client);
    replayer.forget(client);
  }

  function subscribe(client, flags) {
    const wanted = flags.has(CAPABILITY);
    if (!wanted) {
      if (subscribers.has(client)) leave(client);
      return;
    }
    if (subscribers.has(client)) return;
    subscribers.add(client);
    replayer.start(client, snapshotFrames());
  }

  function nextSeq(pair) {
    const key = pairKeyOf(pair);
    const seq = (seqByPair.get(key) ?? 0) + 1;
    seqByPair.set(key, seq);
    return seq;
  }

  function publish(icebergs, pair, ts, watched = [], liveSince) {
    if (!Array.isArray(icebergs) || icebergs.length === 0 || subscribers.size === 0) return 0;
    const active = activePair();
    if (!active || active.marketKind !== pair.marketKind || active.symbol !== pair.symbol) return 0;
    const identity = identityOf(pair);
    let sent = 0;
    for (let start = 0; start < icebergs.length; start += MAX_ICEBERG_ORDERS) {
      let frame;
      try {
        frame = icebergOrdersFrame(identity, { ts, seq: nextSeq(pair), reset: false, icebergs: icebergs.slice(start, start + MAX_ICEBERG_ORDERS), watched, liveSince });
      } catch (error) {
        log.error(`${logPrefix}: ${CAPABILITY} increment failed; resending the snapshot`, error?.message ?? error);
        reselect();
        return sent;
      }
      replayer.broadcast(frame);
      sent += 1;
    }
    return sent;
  }

  function reselect() {
    if (subscribers.size === 0) return;
    const frames = snapshotFrames();
    for (const client of subscribers) replayer.start(client, frames);
  }

  function forget(client) {
    leave(client);
  }

  function stopAll() {
    replayer.stopAll();
    subscribers.clear();
    seqByPair.clear();
  }

  function subscribed(client) {
    return subscribers.has(client);
  }

  return Object.freeze({
    subscribe,
    publish,
    reselect,
    forget,
    stopAll,
    subscribed,
    get size() {
      return subscribers.size;
    },
  });
}

module.exports = { createIcebergChannel, ICEBERG_CAPABILITY: CAPABILITY };
