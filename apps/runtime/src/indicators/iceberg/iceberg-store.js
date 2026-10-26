const fs = require("fs");
const path = require("path");
const { dataRoot } = require("../../platform/runtime-paths");

const MAX_ICEBERG_FILE_BYTES = 8 * 1024 * 1024;
const ICEBERG_STORE_VERSION = 2;
const STORE_VERSIONS = new Set([1, ICEBERG_STORE_VERSION]);
let writeSequence = 0;

function defaultStoreDir() {
  return path.join(dataRoot(), "icebergs");
}

function icebergHistoryPath(dir, pairKey) {
  if (typeof pairKey !== "string" || pairKey.length === 0) throw new Error("iceberg-store: pairKey must be a non-empty string");
  return path.join(dir, `${pairKey.replace(/[^A-Za-z0-9_.-]+/g, "_")}.icebergs.json`);
}

function payloadOf({ pairKey, savedAt, history, cuts = null, coverage = [] }) {
  return JSON.stringify({ version: ICEBERG_STORE_VERSION, pairKey, savedAt, history, cuts, coverage });
}

function saveIcebergHistory({ dir = defaultStoreDir(), pairKey, savedAt = Date.now(), history, cuts, coverage, maxBytes = MAX_ICEBERG_FILE_BYTES }) {
  try {
    const file = icebergHistoryPath(dir, pairKey);
    const payload = payloadOf({ pairKey, savedAt, history, cuts, coverage });
    const bytes = Buffer.byteLength(payload);
    if (bytes > maxBytes) return { ok: false, reason: "OVER_BUDGET", bytes };
    fs.mkdirSync(dir, { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, payload);
    fs.renameSync(temporary, file);
    return { ok: true, bytes, file };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
}

async function saveIcebergHistoryAsync({ dir = defaultStoreDir(), pairKey, savedAt = Date.now(), history, cuts, coverage, maxBytes = MAX_ICEBERG_FILE_BYTES, superseded = () => false }) {
  let temporary = null;
  try {
    const file = icebergHistoryPath(dir, pairKey);
    const payload = payloadOf({ pairKey, savedAt, history, cuts, coverage });
    const bytes = Buffer.byteLength(payload);
    if (bytes > maxBytes) return { ok: false, reason: "OVER_BUDGET", bytes };
    await fs.promises.mkdir(dir, { recursive: true });
    writeSequence += 1;
    temporary = `${file}.${process.pid}.${writeSequence}.tmp`;
    await fs.promises.writeFile(temporary, payload);
    if (superseded()) return { ok: false, reason: "SUPERSEDED" };
    fs.renameSync(temporary, file);
    temporary = null;
    return { ok: true, bytes, file };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  } finally {
    if (temporary !== null) await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

function loadIcebergHistory({ dir = defaultStoreDir(), pairKey, maxFileBytes = MAX_ICEBERG_FILE_BYTES, onReject = () => {} }) {
  const reject = (reason) => {
    onReject(reason);
    return null;
  };
  let raw;
  try {
    const file = icebergHistoryPath(dir, pairKey);
    const stats = fs.statSync(file, { throwIfNoEntry: false });
    if (!stats) return null;
    if (!stats.isFile()) return reject("NOT_A_FILE");
    if (stats.size > maxFileBytes) return reject("TOO_LARGE");
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return reject("UNREADABLE");
  }
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    return reject("MALFORMED");
  }
  if (!saved || !STORE_VERSIONS.has(saved.version) || saved.pairKey !== pairKey) return reject("FOREIGN");
  if (!Number.isSafeInteger(saved.savedAt) || !saved.history || typeof saved.history !== "object") return reject("MALFORMED");
  const carried = saved.version >= ICEBERG_STORE_VERSION;
  return { savedAt: saved.savedAt, history: saved.history, cuts: carried ? saved.cuts ?? null : null, coverage: carried && Array.isArray(saved.coverage) ? saved.coverage : [] };
}

function dropIcebergHistory({ dir = defaultStoreDir(), pairKey }) {
  try {
    fs.rmSync(icebergHistoryPath(dir, pairKey), { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = { saveIcebergHistory, saveIcebergHistoryAsync, loadIcebergHistory, dropIcebergHistory, icebergHistoryPath, defaultStoreDir, MAX_ICEBERG_FILE_BYTES, ICEBERG_STORE_VERSION };
