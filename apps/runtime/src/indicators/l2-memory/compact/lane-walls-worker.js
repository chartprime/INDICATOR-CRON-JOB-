"use strict";

const { parentPort } = require("worker_threads");
const { createLaneWallTrackers, unpackRecords } = require("./lane-walls");

function createLaneWallsWorker(post) {
  const pairs = new Map();

  function handle(message) {
    if (message.type === "configure") {
      pairs.set(message.pair, createLaneWallTrackers({ lanes: message.lanes, trackerOptions: message.trackerOptions }));
      return;
    }
    if (message.type === "forget") {
      pairs.delete(message.pair);
      return;
    }
    if (message.type !== "column") return;
    const trackers = pairs.get(message.pair);
    if (trackers === undefined) {
      post({ type: "walls", pair: message.pair, lane: message.lane, ts: message.ts, levels: null });
      return;
    }
    const column = { ts: message.ts, lo: message.lo, hi: message.hi, bid: message.bid, ask: message.ask };
    const changed = trackers.update({ lane: message.lane, ts: message.ts, column, bids: unpackRecords(message.bids), asks: unpackRecords(message.asks), referenceRows: message.referenceRows });
    post({ type: "walls", pair: message.pair, lane: message.lane, ts: message.ts, levels: changed ? trackers.walls(message.lane) : null });
  }

  return Object.freeze({ handle });
}

if (parentPort !== null) {
  const worker = createLaneWallsWorker((message) => parentPort.postMessage(message));
  parentPort.on("message", (message) => {
    try {
      worker.handle(message);
    } catch (error) {
      parentPort.postMessage({ type: "error", pair: message?.pair ?? null, lane: message?.lane ?? null, message: error?.message ?? String(error) });
    }
  });
}

module.exports = { createLaneWallsWorker };
