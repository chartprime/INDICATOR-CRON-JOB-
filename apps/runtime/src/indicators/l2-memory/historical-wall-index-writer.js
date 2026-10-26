"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createHistoricalWallIndex } = require("./historical-wall-index");
const { createHistoricalWallStream } = require("./historical-wall-stream");

function writeSynced(file, bytes) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (written < 1) throw new Error("historical-wall-index-writer: short write");
      offset += written;
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function syncDirectory(directory) {
  // Node cannot open/flush a directory on Windows; sealed bytes are reverified on admission.
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function verifyPart(directory, part) {
  const file = path.join(directory, part.key);
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error("historical-wall-index-writer: part symlink refused");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size !== part.bytes) throw new Error("historical-wall-index-writer: stored part size differs");
    const bytes = Buffer.alloc(part.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset);
      if (read < 1) throw new Error("historical-wall-index-writer: stored part truncated");
      offset += read;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || createHash("sha256").update(bytes).digest("hex") !== part.sha256) {
      throw new Error("historical-wall-index-writer: stored part bytes differ");
    }
  } finally { fs.closeSync(fd); }
}

// Directory belongs to a trusted operator and must not exist. Never resumes provisional files.
function createHistoricalWallIndexWriter({ directory, ...config } = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error("historical-wall-index-writer: absolute private directory required");
  const resolved = path.resolve(directory);
  const index = createHistoricalWallIndex({ ...config, onPart: (part, bytes) => {
    if (!/^part-[0-9]{4}\.jsonl\.gz$/.test(part.key) || bytes.length !== part.bytes
        || createHash("sha256").update(bytes).digest("hex") !== part.sha256) {
      throw new Error("historical-wall-index-writer: encoded part differs");
    }
    writeSynced(path.join(resolved, part.key), bytes);
  } });
  const stream = createHistoricalWallStream({ ...config, onSample: index.sample, onSegmentEnd: index.end });
  fs.mkdirSync(resolved, { mode: 0o700 });
  let failed = false, finished = false;
  function guarded(operation) {
    if (failed || finished) throw new Error("historical-wall-index-writer: failed or finished writer");
    try { return operation(); } catch (error) { failed = true; throw error; }
  }
  return Object.freeze({
    consume: (rows) => guarded(() => stream.consume(rows)),
    finish: () => guarded(() => {
      const proof = stream.finish();
      const manifest = index.finish(proof);
      for (const part of manifest.parts) verifyPart(resolved, part);
      const body = Buffer.from(JSON.stringify(manifest) + "\n");
      if (body.length > 4 * 1024 * 1024) throw new Error("historical-wall-index-writer: manifest byte budget exceeded");
      writeSynced(path.join(resolved, "manifest.json.pending"), body);
      syncDirectory(resolved);
      fs.renameSync(path.join(resolved, "manifest.json.pending"), path.join(resolved, "manifest.json"));
      syncDirectory(resolved); finished = true;
      return Object.freeze({ manifest, manifestSha256: createHash("sha256").update(body).digest("hex"),
        manifestBytes: body.length, proof });
    }),
  });
}

module.exports = { createHistoricalWallIndexWriter };
