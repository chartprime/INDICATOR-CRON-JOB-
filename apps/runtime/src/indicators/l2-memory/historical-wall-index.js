"use strict";

const { createHash } = require("node:crypto");
const { gzipSync } = require("node:zlib");
const { historicalWallProfile } = require("./historical-wall-profile");

const SHA = /^[a-f0-9]{64}$/;
const PART_BYTES = 4 * 1024 * 1024;
const PART_NS = 60_000_000_000n;
const UINT64 = 18_446_744_073_709_551_615n;
const hash = (value) => createHash("sha256").update(value).digest("hex");
function exact(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value) > UINT64) {
    throw new Error("historical-wall-index: exact unsigned time required");
  }
  return BigInt(value);
}
function safe(value) {
  if (typeof value === "number") return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (Array.isArray(value)) return value.every(safe);
  if (value && typeof value === "object") return Object.values(value).every(safe);
  return value === null || typeof value === "string" || typeof value === "boolean";
}

// Parts stay provisional; consumers may admit them only through a completed manifest.
function createHistoricalWallIndex({ releaseId, descriptorSha256, manifestSha256, expectedRows,
  derivationId, instrumentId, fromNs, toNs, sampleMs = 1000, onPart, ...options } = {}) {
  const from = exact(fromNs), to = exact(toNs), settings = historicalWallProfile({ ...options, sampleMs });
  if (![releaseId, descriptorSha256, manifestSha256, derivationId].every((value) => typeof value === "string" && SHA.test(value))
      || typeof instrumentId !== "string" || !instrumentId || instrumentId.length > 128
      || !Number.isSafeInteger(expectedRows) || expectedRows < 1 || expectedRows > 100000000
      || to <= from || to - from > 86400000000000n || typeof onPart !== "function"
      || !Number.isSafeInteger(sampleMs) || sampleMs < 1000 || sampleMs > 60000 || sampleMs % 1000 !== 0
      || from % (BigInt(sampleMs) * 1000000n) !== 0n) throw new Error("historical-wall-index: pinned identity/window required");
  const period = BigInt(sampleMs) * 1000000n;
  const parts = [], ended = new Set();
  let chunks = [], bytes = 0, partFirst = null, partLast = null, rows = 0, samples = 0;
  let active = null, lastSample = null, lastKnown = null, failed = false, finished = false, encodedBytes = 0;
  function flush() {
    if (!chunks.length) return;
    if (parts.length >= 4096) throw new Error("historical-wall-index: part budget exceeded");
    const decoded = Buffer.concat(chunks, bytes), encoded = gzipSync(decoded, { level: 6 });
    const part = Object.freeze({ key: `part-${String(parts.length).padStart(4, "0")}.jsonl.gz`,
      bytes: encoded.length, sha256: hash(encoded), decoded_bytes: decoded.length, decoded_sha256: hash(decoded),
      rows: chunks.length, first_position: rows - chunks.length, last_position: rows - 1,
      min_known_ns: partFirst, max_known_ns: partLast });
    encodedBytes += encoded.length;
    if (encodedBytes > 256 * 1024 * 1024) throw new Error("historical-wall-index: encoded day budget exceeded");
    const result = onPart(part, encoded);
    if (result && typeof result.then === "function") throw new Error("historical-wall-index: output must finish synchronously");
    parts.push(part);
    chunks = []; bytes = 0; partFirst = null; partLast = null;
  }
  function write(value) {
    if (!safe(value)) throw new Error("historical-wall-index: inexact output");
    const known = exact(value.known_ns);
    if (known < from || known > to || lastKnown !== null && known < lastKnown) throw new Error("historical-wall-index: time order/window differs");
    const line = Buffer.from(JSON.stringify(value) + "\n");
    if (line.length > PART_BYTES) throw new Error("historical-wall-index: record byte budget exceeded");
    if (chunks.length && (bytes + line.length > PART_BYTES || known / PART_NS !== exact(partFirst) / PART_NS)) flush();
    partFirst ??= value.known_ns; partLast = value.known_ns; lastKnown = known;
    chunks.push(line); bytes += line.length; rows += 1;
  }
  function guarded(operation) {
    if (failed || finished) throw new Error("historical-wall-index: failed or finished index");
    try { return operation(); } catch (error) { failed = true; throw error; }
  }
  function sample(value) {
    return guarded(() => {
      const known = exact(value.known_ns);
      if (value.schema !== "historical-l2-wall-view/2" || value.profile_id !== settings.id
          || value.derivation_id !== derivationId || value.instrument_id !== instrumentId || !SHA.test(value.segment_id ?? "")
          || known >= to || known % period !== 0n || exact(value.observed_through_ns) > known
          || !Array.isArray(value.through_known_key) || value.through_known_key.length !== 4
          || exact(value.through_known_key[0]) > exact(value.observed_through_ns)
          || !value.through_known_key.every((part) => { exact(part); return true; })
          || !Number.isSafeInteger(value.through_event_seq) || value.through_event_seq < 0
          || value.row_width !== Number(settings.profile.tick_size) * settings.profile.row_clusters
          || !Array.isArray(value.walls) || value.walls.length > settings.profile.tracker.maxLevels
          || ![value.lifecycle, value.trades, value.wall_trades].every(Array.isArray)
          || active !== null && value.segment_id !== active || ended.has(value.segment_id)
          || lastSample !== null && known <= lastSample || active !== null && known !== lastSample + period
          || samples >= 86401) throw new Error("historical-wall-index: sample identity/continuity differs");
      const cutoffMs = Number(known / 1000000n);
      for (const wall of value.walls) {
        if (!Number.isSafeInteger(wall.startTs) || wall.startTs < 0 || wall.startTs > cutoffMs
            || wall.endTs !== null && (!Number.isSafeInteger(wall.endTs) || wall.endTs < wall.startTs || wall.endTs > cutoffMs)) {
          throw new Error("historical-wall-index: future or invalid wall time");
        }
      }
      for (const event of [...value.lifecycle, ...value.trades, ...value.wall_trades]) {
        if (!Number.isSafeInteger(event.ts) || event.ts < 0 || event.ts > cutoffMs) {
          throw new Error("historical-wall-index: future or invalid evidence time");
        }
      }
      active = value.segment_id; lastSample = known;
      write(value); samples += 1;
    });
  }
  function end(value) {
    return guarded(() => {
      if (!SHA.test(value.segment_id ?? "") || ended.has(value.segment_id)
          || active !== null && value.segment_id !== active || typeof value.cause !== "string"
          || !value.cause || value.cause.length > 128 || ended.size >= 4096) {
        throw new Error("historical-wall-index: segment closure differs");
      }
      write({ schema: "historical-l2-wall-segment-end/2", profile_id: settings.id,
        segment_id: value.segment_id, known_ns: value.known_ns, cause: value.cause });
      ended.add(value.segment_id); active = null;
    });
  }
  function finish(proof) {
    return guarded(() => {
      if (proof?.schema !== "historical-l2-wall-stream-proof/2" || proof.manifest_sha256 !== manifestSha256
          || proof.derivation_id !== derivationId || proof.instrument_id !== instrumentId
          || proof.from_ns !== fromNs || proof.to_ns !== toNs || proof.sample_ms !== sampleMs
          || proof.rows !== expectedRows || proof.samples !== samples || proof.processed_samples !== samples
          || proof.segments !== ended.size || active !== null || samples < 1
          || proof.profile_id !== settings.id || JSON.stringify(proof.profile) !== JSON.stringify(settings.profile)) {
        throw new Error("historical-wall-index: complete matching stream proof required");
      }
      flush(); finished = true;
      return Object.freeze({ schema: "historical-l2-wall-index/1", release_id: releaseId,
        descriptor_sha256: descriptorSha256, event_manifest_sha256: manifestSha256, derivation_id: derivationId,
        instrument_id: instrumentId, profile_id: settings.id, profile: settings.profile,
        from_ns: fromNs, to_ns: toNs, sample_ms: sampleMs, samples, segments: ended.size, rows,
        input_rows: expectedRows, encoded_bytes: encodedBytes, parts: Object.freeze(parts.slice()) });
    });
  }
  return Object.freeze({ sample, end, finish });
}

module.exports = { createHistoricalWallIndex };
