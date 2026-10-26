"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const HASHES = {
  "databento-mbp1.dbn": "b6ea8469368c6e3c1e857ea6e7efebac7be5079473ca7176c870eb888ba4e9e0",
  "databento-tbbo.dbn": "c9b7ca671ec6a26664802557fe2d9d76b5d078ebedfbaea2e579a2b6d4b8fc5d",
};
// Test-only decoder for these two hash-pinned DBN v2 fixtures, NOT arbitrary DBN.
// Layout: official dbn RecordHeader + Mbp1Msg + BidAskPair (80 bytes).
function decodePinned(name) {
  assert(Object.hasOwn(HASHES, name));
  const b = fs.readFileSync(path.join(__dirname, name));
  assert.equal(createHash("sha256").update(b).digest("hex"), HASHES[name]);
  assert.equal(b.length, 513); assert.equal(b.subarray(0, 3).toString(), "DBN"); assert.equal(b[3], 2);
  const rows = [];
  for (let p = 8 + b.readUInt32LE(4); p < b.length; p += 80) {
    assert(p + 80 <= b.length); assert.equal(b[p] * 4, 80); assert.equal(b[p + 1], 1);
    rows.push({ publisher_id: String(b.readUInt16LE(p + 2)), instrument_id: String(b.readUInt32LE(p + 4)), ts_event: b.readBigUInt64LE(p + 8).toString(), price: b.readBigInt64LE(p + 16).toString(), size: String(b.readUInt32LE(p + 24)), action: String.fromCharCode(b[p + 28]), side: String.fromCharCode(b[p + 29]), depth: String(b[p + 30]), flags: String(b[p + 31]), ts_recv: b.readBigUInt64LE(p + 32).toString(), sequence: String(b.readUInt32LE(p + 44)), bid_px_00: b.readBigInt64LE(p + 48).toString(), ask_px_00: b.readBigInt64LE(p + 56).toString(), bid_sz_00: String(b.readUInt32LE(p + 64)), ask_sz_00: String(b.readUInt32LE(p + 68)) });
  }
  assert.equal(rows.length, 2);
  return { rows, sha256: HASHES[name] };
}
module.exports = { decodePinned };
