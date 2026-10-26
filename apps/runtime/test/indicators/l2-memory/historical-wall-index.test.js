"use strict";

const { createHash } = require("node:crypto");
const { gunzipSync } = require("node:zlib");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHistoricalWallIndexWriter } = require("../../../src/indicators/l2-memory/historical-wall-index-writer");
const { createHistoricalWallIndex } = require("../../../src/indicators/l2-memory/historical-wall-index");
const { createHistoricalWallStream } = require("../../../src/indicators/l2-memory/historical-wall-stream");
const { createHistoricalLevelEvents } = require("../../../src/indicators/l2-memory/historical-level-events");
const { createHistoricalTopNFrames } = require("../../../src/indicators/l2-memory/historical-topn-frames");
const { createHistoricalSourceRunner } = require("../../../src/indicators/l2-memory/historical-source-runner");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");

const geometry = { derivationId: "a".repeat(64), instrumentId: "ES", tickSize: "1",
  rowClusters: 1, windowRows: 10, referenceRows: 10, fold: "max",
  trackerOptions: { minSize: 40, multiplier: 0, gapRows: 0, settleMs: 1000 } };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function source(offset = 0) {
  const engine = createMemoryEngine({ tickSize: 1, snapshotDepth: 2 });
  const runner = createHistoricalSourceRunner({ createEngine: () => engine });
  const frames = createHistoricalTopNFrames({ depthLimit: 2 });
  const key = [String((1000 + offset) * 1000000), "2", "0", "0"];
  const observer = createHistoricalLevelEvents({ ...geometry, depthLimit: 2, seedKey: key });
  const transition = frames.push({ event_ns: key[0], source_rank: key[1], stable_position: key[2], ordinal: key[3],
    instrument_id: "ES", depth_action: "SNAPSHOT", depth_model: "TOP_N", depth_limit: 2, continuity: "OK",
    book_epoch: "1", date: "2026-08-05", bids: [{ price: "99", size: "80" }, { price: "98", size: "8" }],
    asks: [{ price: "101", size: "90" }, { price: "102", size: "7" }] });
  runner.applyTransition(transition);
  return [...observer.capture(engine, { sourceKey: key, knownNs: key[0], bookFrame: transition.frames.find((frame) => frame.kind === "book") }),
    ...observer.close(engine, { sourceKey: key, knownNs: String((80000 + offset) * 1000000), cause: "EOF" })];
}

function harness({ secondSegment = false, sampleMs = 1000, onPart, onSample } = {}) {
  const rows = [...source(), ...(secondSegment ? source(100000) : [])].map((row, index) => ({ ...row, append_position: String(index) }));
  const config = { ...geometry, releaseId: "b".repeat(64), descriptorSha256: "c".repeat(64),
    manifestSha256: "d".repeat(64), expectedRows: rows.length, fromNs: "0", toNs: "200000000000", sampleMs };
  const parts = [], samples = [], ends = [];
  const index = createHistoricalWallIndex({ ...config, onPart: onPart ?? ((part, bytes) => { parts.push({ part, bytes }); }) });
  const stream = createHistoricalWallStream({ ...config, onSample: (value) => { samples.push(value); (onSample ?? index.sample)(value); },
    onSegmentEnd: (value) => { ends.push(value); index.end(value); } });
  return { config, rows, parts, samples, ends, index, stream };
}

test("minute parts retain exact seeded wall views and explicit closures and seal only after the complete matching proof", () => {
  const h = harness();
  for (const row of h.rows) h.stream.consume([row]);
  const proof = h.stream.finish();
  const manifest = h.index.finish(proof);
  expect(manifest).toMatchObject({ schema: "historical-l2-wall-index/1", samples: 79, segments: 1, rows: 80,
    input_rows: h.rows.length, release_id: h.config.releaseId, event_manifest_sha256: h.config.manifestSha256, profile_id: proof.profile_id });
  expect(manifest.parts).toHaveLength(2);
  const records = [];
  for (const { part, bytes } of h.parts) {
    const decoded = gunzipSync(bytes);
    expect(digest(bytes)).toBe(part.sha256);
    expect(digest(decoded)).toBe(part.decoded_sha256);
    expect(decoded.length).toBe(part.decoded_bytes);
    expect(decoded.length).toBeLessThanOrEqual(4 * 1024 * 1024);
    records.push(...decoded.toString("utf8").trim().split("\n").map(JSON.parse));
  }
  expect(records.slice(0, -1)).toEqual(h.samples);
  expect(records.at(-1)).toMatchObject({ schema: "historical-l2-wall-segment-end/2", ...h.ends[0] });
  expect(manifest.parts[0]).toMatchObject({ min_known_ns: "1000000000", max_known_ns: "59000000000", first_position: 0, last_position: 58 });
  expect(manifest.parts[1]).toMatchObject({ min_known_ns: "60000000000", max_known_ns: "80000000000", first_position: 59, last_position: 79 });
  expect(h.samples.at(-1).walls[0].startTs).toBe(1000);
  expect(Object.isFrozen(manifest.parts)).toBe(true);
  expect(() => h.index.finish(proof)).toThrow(/finished/);
});

test("segment gaps remain gaps with independently reset wall identities and no invented samples", () => {
  const h = harness({ secondSegment: true });
  h.stream.consume(h.rows);
  const manifest = h.index.finish(h.stream.finish());
  expect(manifest).toMatchObject({ samples: 158, segments: 2, rows: 160 });
  expect(h.samples.some((sample) => BigInt(sample.known_ns) >= 80000000000n && BigInt(sample.known_ns) < 101000000000n)).toBe(false);
  expect(h.samples[79].walls[0].startTs).toBe(101000);
});

test("a different sampling cadence binds every sample, proof and index to a different settings identity", () => {
  const h = harness({ sampleMs: 2000 }); h.stream.consume(h.rows); const proof = h.stream.finish();
  const manifest = h.index.finish(proof);
  expect(manifest).toMatchObject({ sample_ms: 2000, samples: 39, profile: { sample_ms: 2000 } });
  expect(h.samples.every((value) => value.profile_id === manifest.profile_id)).toBe(true);
  const normal = harness(); normal.stream.consume(normal.rows);
  expect(manifest.profile_id).not.toBe(normal.stream.finish().profile_id);
});

test.each([
  { rows: 1 }, { samples: 1 }, { processed_samples: 1 }, { segments: 2 }, { profile_id: "e".repeat(64) },
  { manifest_sha256: "e".repeat(64) }, { derivation_id: "e".repeat(64) }, { from_ns: "1" }, { sample_ms: 2000 },
])("an incomplete or rebound proof cannot seal provisional parts: %j", (changed) => {
  const h = harness(); h.stream.consume(h.rows);
  expect(() => h.index.finish({ ...h.stream.finish(), ...changed })).toThrow(/matching/);
  expect(() => h.index.finish({})).toThrow(/failed/);
});

test.each([
  (s) => ({ ...s, profile_id: "e".repeat(64) }), (s) => ({ ...s, schema: "historical-l2-wall-view/1" }),
  (s) => ({ ...s, row_width: 0.25 }), (s) => ({ ...s, through_known_key: ["2000000000", "2", "0", "0"] }),
  (s) => ({ ...s, walls: [{ bad: Infinity }] }),
  (s) => ({ ...s, walls: [{ ...s.walls[0], startTs: 2000 }] }),
  (s) => ({ ...s, trades: [{ ts: 2000 }] }),
])("unbound, legacy, future or inexact samples fail closed: %s", (change) => {
  const h = harness(); h.stream.consume(h.rows); h.stream.finish();
  const other = createHistoricalWallIndex({ ...h.config, onPart: () => {} });
  expect(() => other.sample(change(h.samples[0]))).toThrow();
  expect(() => other.finish({})).toThrow(/failed/);
});

test("dropped callbacks cannot falsely complete the index, including a missing terminal closure", () => {
  const h = harness(); h.stream.consume(h.rows); const proof = h.stream.finish();
  const other = createHistoricalWallIndex({ ...h.config, onPart: () => {} });
  other.sample(h.samples[0]);
  expect(() => other.sample(h.samples[2])).toThrow(/continuity/);
  const truncated = createHistoricalWallIndex({ ...h.config, onPart: () => {} });
  h.samples.forEach(truncated.sample);
  expect(() => truncated.finish(proof)).toThrow(/matching/);
  const skipped = harness({ onSample: () => {} }); skipped.stream.consume(skipped.rows);
  expect(() => skipped.index.finish(skipped.stream.finish())).toThrow(/matching/);
});

test.each([() => { throw new Error("disk full"); }, () => Promise.resolve()])("failed or unfinished writes poison the index and source stream", (onPart) => {
  const h = harness({ onPart });
  expect(() => { h.stream.consume(h.rows); h.index.finish(h.stream.finish()); }).toThrow(/disk full|synchronously/);
  expect(() => h.index.finish({})).toThrow(/failed/);
  expect(() => h.stream.finish()).toThrow(/failed/);
});

describe("private on-disk sealing", () => {
  let scratch;
  beforeEach(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), "l2-wall-index-")); });
  afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

  test("writes exact reverified parts, then atomically exposes their bounded manifest without replacing an existing directory", () => {
    const h = harness(), directory = path.join(scratch, "accepted");
    const writer = createHistoricalWallIndexWriter({ ...h.config, directory });
    writer.consume(h.rows);
    expect(fs.existsSync(path.join(directory, "manifest.json"))).toBe(false);
    const sealed = writer.finish();
    const body = fs.readFileSync(path.join(directory, "manifest.json"));
    expect(digest(body)).toBe(sealed.manifestSha256);
    expect(body.length).toBe(sealed.manifestBytes);
    expect(JSON.parse(body)).toEqual(sealed.manifest);
    expect(fs.existsSync(path.join(directory, "manifest.json.pending"))).toBe(false);
    for (const part of sealed.manifest.parts) expect(digest(fs.readFileSync(path.join(directory, part.key)))).toBe(part.sha256);
    expect(() => createHistoricalWallIndexWriter({ ...h.config, directory })).toThrow();
    expect(() => writer.finish()).toThrow(/finished/);
  });

  test("truncated source leaves only provisional parts and cannot be resumed as complete", () => {
    const h = harness(), directory = path.join(scratch, "truncated");
    const writer = createHistoricalWallIndexWriter({ ...h.config, directory });
    writer.consume(h.rows.slice(0, -1));
    expect(() => writer.finish()).toThrow(/incomplete/);
    expect(fs.existsSync(path.join(directory, "manifest.json"))).toBe(false);
    expect(() => writer.consume(h.rows.slice(-1))).toThrow(/failed/);
  });

  test.each(["corrupt", "missing"])("a %s stored part is caught before sealing, and no manifest is exposed", (kind) => {
    const h = harness(), directory = path.join(scratch, kind);
    const writer = createHistoricalWallIndexWriter({ ...h.config, directory }); writer.consume(h.rows);
    const part = path.join(directory, "part-0000.jsonl.gz");
    if (kind === "missing") fs.unlinkSync(part);
    else { const bytes = fs.readFileSync(part); bytes[10] ^= 1; fs.writeFileSync(part, bytes); }
    expect(() => writer.finish()).toThrow();
    expect(fs.existsSync(path.join(directory, "manifest.json"))).toBe(false);
    expect(() => writer.finish()).toThrow(/failed/);
  });
});
