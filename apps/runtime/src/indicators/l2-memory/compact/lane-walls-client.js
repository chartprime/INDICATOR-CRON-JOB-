"use strict";

const path = require("path");
const { Worker } = require("worker_threads");
const { packRecords } = require("./lane-walls");

const WORKER_PATH = path.join(__dirname, "lane-walls-worker.js");

function createLaneWallsClient({ enabled = true, spawn = null, log = () => {} } = {}) {
  const inFlight = new Map();
  const walls = new Map();
  const configured = new Set();
  const counters = { posted: 0, dropped: 0, replies: 0, errors: 0 };
  let worker = null;
  let failed = false;

  function die(reason) {
    if (failed) return;
    failed = true;
    worker = null;
    walls.clear();
    inFlight.clear();
    configured.clear();
    log(`liquidity-publisher: lane walls worker ${reason}, the wider lanes carry no walls until a restart`);
  }

  function keyOf(pair, lane) {
    return `${pair}\0${lane}`;
  }

  function receive(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "error") {
      counters.errors += 1;
      inFlight.delete(keyOf(message.pair, message.lane));
      log(`liquidity-publisher: lane walls failed for ${message.pair} lane ${message.lane}: ${message.message}`);
      return;
    }
    if (message.type !== "walls") return;
    counters.replies += 1;
    inFlight.delete(keyOf(message.pair, message.lane));
    if (message.levels !== null) walls.set(keyOf(message.pair, message.lane), { ts: message.ts, levels: message.levels });
  }

  function ensure() {
    if (!enabled || failed) return null;
    if (worker !== null) return worker;
    try {
      worker = spawn !== null ? spawn(receive) : new Worker(WORKER_PATH);
    } catch (error) {
      failed = true;
      log(`liquidity-publisher: lane walls worker could not start, the wider lanes carry no walls: ${error?.message ?? error}`);
      return null;
    }
    const spawned = worker;
    if (spawn === null) {
      spawned.on("message", receive);
      spawned.unref?.();
    }
    if (typeof spawned.on === "function") {
      spawned.on("error", (error) => {
        if (worker === spawned) die(`died: ${error?.message ?? error}`);
      });
      spawned.on("exit", (code) => {
        if (worker === spawned) die(`exited (code ${code})`);
      });
    }
    return spawned;
  }

  function send(message, transfer = []) {
    const target = ensure();
    if (target === null) return false;
    target.postMessage(message, transfer);
    return true;
  }

  function configure(pair, lanes, trackerOptions) {
    if (configured.has(pair)) return;
    if (!send({ type: "configure", pair, lanes: lanes.map((lane) => ({ k: lane.k, rowClusters: lane.rowClusters })), trackerOptions })) return;
    configured.add(pair);
  }

  function forget(pair) {
    if (!configured.has(pair)) return;
    configured.delete(pair);
    for (const key of [...walls.keys()]) if (key.startsWith(`${pair}\0`)) walls.delete(key);
    for (const key of [...inFlight.keys()]) if (key.startsWith(`${pair}\0`)) inFlight.delete(key);
    send({ type: "forget", pair });
  }

  function post({ pair, lane, ts, column, snapshot, referenceRows }) {
    if (!configured.has(pair)) return false;
    const key = keyOf(pair, lane);
    if (inFlight.has(key)) {
      counters.dropped += 1;
      return false;
    }
    const bids = packRecords(snapshot.bids);
    const asks = packRecords(snapshot.asks);
    const bid = Float64Array.from(column.bid);
    const ask = Float64Array.from(column.ask);
    const sent = send({ type: "column", pair, lane, ts, lo: column.lo, hi: column.hi, bid, ask, bids, asks, referenceRows }, [bid.buffer, ask.buffer, bids.buffer, asks.buffer]);
    if (!sent) return false;
    inFlight.set(key, ts);
    counters.posted += 1;
    return true;
  }

  function wallsOf(pair) {
    const out = [];
    for (const [key, entry] of walls) if (key.startsWith(`${pair}\0`)) out.push(...entry.levels);
    return out;
  }

  function stop() {
    if (worker !== null && spawn === null) worker.terminate().catch(() => {});
    worker = null;
    inFlight.clear();
    walls.clear();
    configured.clear();
  }

  function stats() {
    return Object.freeze({ ...counters, inFlight: inFlight.size, pairs: configured.size, enabled: enabled && !failed });
  }

  return Object.freeze({ configure, forget, post, wallsOf, receive, stop, stats, get enabled() { return enabled && !failed; } });
}

module.exports = { createLaneWallsClient, WORKER_PATH };
