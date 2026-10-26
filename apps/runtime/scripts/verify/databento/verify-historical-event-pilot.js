#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createHistoricalTopNFrames } = require("../../../src/indicators/l2-memory/historical-topn-frames");
const { createHistoricalSourceRunner } = require("../../../src/indicators/l2-memory/historical-source-runner");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { createHistoricalEventTap } = require("../../../src/indicators/l2-memory/historical-event-tap");
const { tradeFrame } = require("../../../src/indicators/l2-memory/input-frames");

const root = path.resolve(__dirname, "../../../src/indicators/l2-memory");
const fixturePath = path.resolve(__dirname, "../../../test/fixtures/golden/historical-cme-source-witnesses.json");
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function price(raw) {
  const integer = BigInt(raw);
  return `${integer / 1_000_000_000n}.${String(integer % 1_000_000_000n).padStart(9, "0")}`;
}
function levels(record, side) {
  return record.levels.filter((level) => level[`${side}_px`] !== "9223372036854775807" && level[`${side}_sz`] > 0)
    .map((level) => ({ price: price(level[`${side}_px`]), size: String(level[`${side}_sz`]) }));
}

function pilot(instrument) {
  const bytes = fs.readFileSync(fixturePath);
  if (bytes.length > 64 * 1024) throw new Error("event pilot fixture exceeds admission");
  const fixture = JSON.parse(bytes).cases.find((item) => item.instrument === instrument);
  if (!fixture || fixture.rows.length > 128) throw new Error("bounded ES/NQ witness required");
  const dependencies = ["memory-engine", "level-ledger", "flow-window", "size-history", "input-frames",
    "historical-topn-frames", "historical-source-runner", "historical-event-tap"];
  const code = dependencies.map((name) => [name, digest(fs.readFileSync(path.join(root, name + ".js")))]);
  code.push(["producer", digest(fs.readFileSync(__filename))]);
  const identity = { method: "native-cme-bounded-event-pilot/1", instrument, rawSha256: fixture.raw_sha256,
    fixtureSha256: digest(bytes), code, nodeVersion: process.versions.node, tickSize: 0.25, pruneEveryMs: 1000, observedDepth: 10 };
  const derivationId = digest(JSON.stringify(identity));
  const first = fixture.rows[0];
  const keyFor = (record) => [record.event_ns, "2", record.native_index, "0"];
  const tap = createHistoricalEventTap({ derivationId, instrumentId: instrument, seedKey: keyFor(first) });
  const source = createHistoricalTopNFrames({ depthLimit: 10 });
  const runner = createHistoricalSourceRunner({ createEngine: () => createMemoryEngine({ tickSize: 0.25, snapshotDepth: 10 }) });
  const rows = [];
  let previousBook = null;
  for (const native of fixture.rows) {
    const row = { event_ns: native.event_ns, source_rank: "2", stable_position: native.native_index, ordinal: "0",
      instrument_id: instrument, depth_action: "SNAPSHOT", depth_model: "TOP_N", depth_limit: 10,
      bids: levels(native, "bid"), asks: levels(native, "ask"), continuity: "OK", book_epoch: "1", date: fixture.date };
    const engine = runner.applyTransition(source.push(row, { observationOnly: native.action === "T" }));
    if (!engine || runner.segment !== 1) throw new Error("event witness crosses an unqualified trust boundary");
    if (native.action === "T") {
      const side = { B: "buy", A: "sell" }[native.side];
      if (!side) throw new Error("event witness has unqualified trade direction");
      runner.applyTransition({ restartEngine: false, frames: [tradeFrame(Number(BigInt(native.event_ns) / 1_000_000n),
        price(native.price), String(native.size), side, `raw:${fixture.raw_sha256}:${native.native_index}`)] });
      if (engine.drainPrints().length !== 1) throw new Error("event witness trade drain disagrees");
    }
    const coverage = Object.fromEntries([["bid", row.bids], ["ask", row.asks]].map(([side, values]) => {
      const observedValues = native.action === "T" ? values : [...values, ...(previousBook?.[side] ?? [])];
      const keys = observedValues.map((level) => engine.keyFor(level.price));
      return [side, [Math.min(...keys), Math.max(...keys)]];
    }));
    const knownNs = String(BigInt(native.receive_ns) > BigInt(native.event_ns) ? native.receive_ns : native.event_ns);
    rows.push(...tap.drain(engine, { knownKey: keyFor(native), knownNs, coverage }));
    previousBook = { bid: row.bids, ask: row.asks };
  }
  return { identity, derivationId, rows, scope: "bounded native examples only; no complete state or lifecycle acceptance" };
}

if (require.main === module) {
  const result = pilot(process.argv[2]);
  console.error(JSON.stringify({ ...result, rows: result.rows.length }));
  for (const row of result.rows) console.log(JSON.stringify(row));
}
module.exports = { pilot };
