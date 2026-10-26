"use strict";

const { initiativeBandsFrame, initiativeBandsFrames, MAX_INITIATIVE_BANDS } = require("./initiative-frames");
const { createLiquidityReplayer } = require("./market-data-server-shared");
const { MAX_VALID_EPOCH_MS } = require("./wire-fields");

const CAPABILITY = "initiative_bands";

function pairKeyOf(pair) {
  return `${pair.marketKind}:${pair.symbol}`;
}

function parseInitiativeHistory(message) {
  if (!message || typeof message !== "object" || message.type !== "initiative_history") return null;
  const keys = Object.keys(message).sort();
  if (keys.length !== 2 || keys[0] !== "from_ts" || keys[1] !== "type") return null;
  const fromTs = message.from_ts;
  if (!Number.isSafeInteger(fromTs) || fromTs < 0 || fromTs > MAX_VALID_EPOCH_MS) return null;
  return fromTs;
}

function createInitiativeChannel({
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
  if (typeof logPrefix !== "string" || logPrefix.length === 0) throw new Error("initiative-channel: logPrefix must be a non-empty string");
  for (const [name, value] of [["safelySend", safelySend], ["safelySendSerialized", safelySendSerialized], ["activePair", activePair], ["identityOf", identityOf], ["snapshotOf", snapshotOf]]) {
    if (typeof value !== "function") throw new Error(`initiative-channel: ${name} must be a function`);
  }
  const subscribers = new Set();
  const seqByPair = new Map();

  function snapshotFrames() {
    const pair = activePair();
    if (!pair) return [];
    try {
      const snap = snapshotOf(pair);
      if (!snap) return [];
      return initiativeBandsFrames(identityOf(pair), snap.ts, snap.bands, { liveSince: snap.liveSince, loading: snap.loading ?? null });
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

  function publish(bands, pair, ts, liveSince, loading = null) {
    if (!Array.isArray(bands) || bands.length === 0 || subscribers.size === 0) return 0;
    const active = activePair();
    if (!active || active.marketKind !== pair.marketKind || active.symbol !== pair.symbol) return 0;
    const identity = identityOf(pair);
    let sent = 0;
    for (let start = 0; start < bands.length; start += MAX_INITIATIVE_BANDS) {
      let frame;
      try {
        frame = initiativeBandsFrame(identity, { ts, seq: nextSeq(pair), reset: false, bands: bands.slice(start, start + MAX_INITIATIVE_BANDS), liveSince, loading });
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

module.exports = { createInitiativeChannel, parseInitiativeHistory, INITIATIVE_CAPABILITY: CAPABILITY };
