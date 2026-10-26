#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createHistoricalLevelEvents } = require("../../../src/indicators/l2-memory/historical-level-events");
const { createHistoricalSecondSampler } = require("../../../src/indicators/l2-memory/historical-second-sampler");
const { createHistoricalTopNFrames } = require("../../../src/indicators/l2-memory/historical-topn-frames");
const { createHistoricalSourceRunner } = require("../../../src/indicators/l2-memory/historical-source-runner");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { tradeFrame } = require("../../../src/indicators/l2-memory/input-frames");

const fixturePath = path.resolve(__dirname, "../../../test/fixtures/golden/historical-cme-source-witnesses.json");
const root = path.resolve(__dirname, "../../../src/indicators/l2-memory");
const digest = (value) => createHash("sha256").update(value).digest("hex");
function price(raw) {
  const value = BigInt(raw);
  return `${value / 1_000_000_000n}.${String(value % 1_000_000_000n).padStart(9, "0")}`;
}
function levels(native, side) {
  return native.levels.filter((level) => level[`${side}_px`] !== "9223372036854775807" && level[`${side}_sz`] > 0)
    .map((level) => ({ price: price(level[`${side}_px`]), size: String(level[`${side}_sz`]) }));
}

function pilot(instrument) {
  const bytes = fs.readFileSync(fixturePath);
  if (bytes.length > 64 * 1024) throw new Error("lifecycle pilot fixture exceeds admission");
  const fixture = JSON.parse(bytes).cases.find((item) => item.instrument === instrument);
  if (!fixture || fixture.rows.length < 1 || fixture.rows.length > 128) throw new Error("bounded ES/NQ witness required");
  const dependencies = ["memory-engine", "level-ledger", "flow-window", "size-history", "input-frames",
    "historical-topn-frames", "historical-source-runner", "historical-event-tap", "historical-level-events", "historical-second-sampler"];
  const identity = { method: "native-cme-bounded-lifecycle-pilot/1", instrument, rawSha256: fixture.raw_sha256,
    fixtureSha256: digest(bytes), code: dependencies.map((name) => [name, digest(fs.readFileSync(path.join(root, `${name}.js`)))]),
    producerSha256: digest(fs.readFileSync(__filename)), nodeVersion: process.versions.node,
    tickSize: "0.25", depthLimit: 10, pruneEveryMs: 1000 };
  const derivationId = digest(JSON.stringify(identity));
  const keyFor = (native) => [native.event_ns, "2", native.native_index, "0"];
  const fromNs = String(BigInt(fixture.rows[0].event_ns) / 1_000_000_000n * 1_000_000_000n);
  const toNs = String((BigInt(fixture.rows.at(-1).event_ns) / 1_000_000_000n + 2n) * 1_000_000_000n);
  const observer = createHistoricalLevelEvents({ derivationId, instrumentId: instrument,
    seedKey: keyFor(fixture.rows[0]), tickSize: "0.25" });
  const sampler = createHistoricalSecondSampler({ derivationId, instrumentId: instrument, tickSize: "0.25", fromNs, toNs });
  const source = createHistoricalTopNFrames({ depthLimit: 10 });
  const runner = createHistoricalSourceRunner({ createEngine: () => createMemoryEngine({ tickSize: 0.25, snapshotDepth: 10 }) });
  const events = [];
  const seconds = [];
  let prunedAt = null;
  let lastKnown;
  for (const [index, native] of fixture.rows.entries()) {
    if (BigInt(native.native_index) !== BigInt(fixture.rows[0].native_index) + BigInt(index)) throw new Error("non-contiguous native witness");
    const bids = levels(native, "bid");
    const asks = levels(native, "ask");
    const row = { event_ns: native.event_ns, source_rank: "2", stable_position: native.native_index, ordinal: "0",
      instrument_id: instrument, depth_action: "SNAPSHOT", depth_model: "TOP_N", depth_limit: 10,
      bids, asks, continuity: "OK", book_epoch: "1", date: fixture.date };
    const transition = source.push(row, { observationOnly: native.action === "T" });
    const engine = runner.applyTransition(transition);
    if (!engine || runner.segment !== 1) throw new Error("unqualified source boundary in lifecycle witness");
    const ts = Number(BigInt(native.event_ns) / 1_000_000n);
    const pruned = prunedAt === null || ts - prunedAt >= 1000;
    if (pruned) prunedAt = ts;
    let trade = null;
    if (native.action === "T") {
      const side = { B: "BUY", A: "SELL" }[native.side];
      if (!side) throw new Error("unqualified trade side in witness");
      trade = { event_ns: native.event_ns, side, price: price(native.price), size: String(native.size) };
      runner.applyTransition({ restartEngine: false, frames: [tradeFrame(ts, trade.price, trade.size,
        side.toLowerCase(), `raw:${fixture.raw_sha256}:${native.native_index}`)] });
      if (engine.drainPrints().length !== 1) throw new Error("lifecycle witness print drain disagrees");
    }
    lastKnown = String(BigInt(native.receive_ns) > BigInt(native.event_ns) ? native.receive_ns : native.event_ns);
    events.push(...observer.capture(engine, { sourceKey: keyFor(native), knownNs: lastKnown,
      bookFrame: transition.frames.find((frame) => frame.kind === "book"), pruned }));
    seconds.push(...sampler.observe({ sourceKey: keyFor(native), knownNs: lastKnown,
      segmentId: observer.segmentId, bids, asks, trade }));
  }
  events.push(...observer.close(runner.engine, { sourceKey: keyFor(fixture.rows.at(-1)), knownNs: lastKnown, cause: "EOF" }));
  seconds.push(...sampler.finish());
  return { identity, derivationId, fromNs, toNs, events, seconds,
    scope: "bounded retained source lifecycle/state integration; no full-day or publication acceptance" };
}

if (require.main === module) {
  const result = pilot(process.argv[2]);
  console.error(JSON.stringify({ ...result, events: result.events.length, seconds: result.seconds.length }));
  for (const row of result.events) console.log(JSON.stringify({ family: "l2_level_event", row }));
  for (const row of result.seconds) console.log(JSON.stringify({ family: row.family, row }));
}
module.exports = { pilot };
