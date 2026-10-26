"use strict";

const { createHistoricalWallProjection } = require("./historical-wall-projection");
const { historicalWallProfile } = require("./historical-wall-profile");

const SHA = /^[a-f0-9]{64}$/;
const UINT64 = 18_446_744_073_709_551_615n;
function exact(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value) > UINT64) {
    throw new Error("historical-wall-stream: exact unsigned time/position required");
  }
  return BigInt(value);
}

// Input is the entire authenticated event manifest, including its segment seeds and closures.
// Output remains provisional until finish() verifies the complete input count.
function createHistoricalWallStream({ manifestSha256, expectedRows, fromNs, toNs, onSample, onSegmentEnd,
  sampleMs = 1000, ...projectionOptions } = {}) {
  const from = exact(fromNs), to = exact(toNs);
  if (!SHA.test(manifestSha256 ?? "") || !Number.isSafeInteger(expectedRows) || expectedRows < 1 || expectedRows > 100_000_000
      || to <= from || to - from > 86_400_000_000_000n || typeof onSample !== "function"
      || typeof onSegmentEnd !== "function" || !Number.isSafeInteger(sampleMs) || sampleMs < 1000
      || sampleMs > 60000 || sampleMs % 1000 !== 0 || from % (BigInt(sampleMs) * 1_000_000n) !== 0n) {
    throw new Error("historical-wall-stream: pinned full manifest, bounded window and callbacks required");
  }
  const period = BigInt(sampleMs) * 1_000_000n;
  const settings = historicalWallProfile({ ...projectionOptions, sampleMs });
  const pinnedOptions = { ...projectionOptions, sampleMs, trackerOptions: settings.profile.tracker };
  let count = 0, samples = 0, processedSamples = 0, segments = 0, group = [], groupBytes = 0, known = null;
  let projection = null, nextSample = null, failed = false, finished = false;
  function delivered(result) {
    if (result !== null && (typeof result === "object" || typeof result === "function") && typeof result.then === "function") {
      throw new Error("historical-wall-stream: callbacks must finish synchronously");
    }
  }
  function flush(next) {
    if (group.length === 0) return;
    if (projection === null) {
      projection = createHistoricalWallProjection(pinnedOptions);
      segments += 1;
    }
    projection.consume(group);
    if (projection.closed) {
      const last = group.at(-1);
      delivered(onSegmentEnd(Object.freeze({ segment_id: last.segment_id, known_ns: last.known_ns, cause: last.payload.cause })));
      projection = null;
    } else {
      if (next === null) throw new Error("historical-wall-stream: manifest ended without segment closure");
      projection.sealBefore(next);
      nextSample = nextSample === null || nextSample < known ? ((known + period - 1n) / period) * period : nextSample;
      const boundary = exact(next.known_ns);
      while (nextSample < boundary) {
        if (processedSamples >= 86401) throw new Error("historical-wall-stream: daily sampling budget exceeded");
        const sample = projection.sample(String(nextSample));
        processedSamples += 1;
        if (nextSample >= from && nextSample < to) { delivered(onSample(sample)); samples += 1; }
        nextSample += period;
      }
    }
    group = []; groupBytes = 0;
  }
  function consume(rows) {
    if (failed || finished) throw new Error("historical-wall-stream: failed or finished stream");
    try {
      if (!Array.isArray(rows) || rows.length === 0 || rows.length > 20000
          || Buffer.byteLength(JSON.stringify(rows)) > 8 * 1024 * 1024) throw new Error("historical-wall-stream: page budget exceeded");
      for (const row of rows) {
        const time = exact(row.known_ns);
        if (count >= expectedRows || exact(row.append_position) !== BigInt(count) || known !== null && time < known) {
          throw new Error("historical-wall-stream: complete ordered append prefix required");
        }
        if (group.length > 0 && (time !== known || row.segment_id !== group[0].segment_id)) flush(row);
        if (projection === null && group.length === 0 && row.event_type !== "segment_open") {
          throw new Error("historical-wall-stream: complete segment seed required");
        }
        groupBytes += Buffer.byteLength(JSON.stringify(row));
        if (group.length >= 20000 || groupBytes > 8 * 1024 * 1024) throw new Error("historical-wall-stream: knowledge group budget exceeded");
        group.push(row); known = time; count += 1;
      }
    } catch (error) { failed = true; throw error; }
  }
  function finish() {
    if (failed || finished) throw new Error("historical-wall-stream: failed or finished stream");
    try {
      if (count !== expectedRows) throw new Error("historical-wall-stream: incomplete manifest prefix");
      flush(null);
      finished = true;
      return Object.freeze({ schema: "historical-l2-wall-stream-proof/2", profile_id: settings.id, profile: settings.profile, manifest_sha256: manifestSha256,
        derivation_id: projectionOptions.derivationId, instrument_id: projectionOptions.instrumentId,
        rows: count, samples, processed_samples: processedSamples, segments, from_ns: fromNs, to_ns: toNs, sample_ms: sampleMs });
    } catch (error) { failed = true; throw error; }
  }
  return Object.freeze({ consume, finish });
}

module.exports = { createHistoricalWallStream };
