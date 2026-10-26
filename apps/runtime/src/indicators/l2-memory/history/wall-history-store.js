"use strict";

const fs = require("fs");
const path = require("path");
const { DEFAULT_STORE_DIR } = require("../liquidity-store");
const { VERSION } = require("./wall-history");

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const GEOMETRY_KEYS = Object.freeze(["rowWidth", "rowClusters", "tickSize", "clusterTicks"]);
const SUFFIXES = new Set(["walls", "events"]);
let writeSequence = 0;

function wallHistoryPath(dir, pairKey, suffix = "walls") {
  if (typeof pairKey !== "string" || pairKey.length === 0) throw new Error("wall-history-store: pairKey must be a non-empty string");
  if (!SUFFIXES.has(suffix)) throw new Error("wall-history-store: suffix must be walls or events");
  return path.join(dir, `${pairKey.replace(/[^A-Za-z0-9_.-]+/g, "_")}.${suffix}.json`);
}

function sameGeometry(a, b) {
  if (!a || !b) return false;
  for (const key of GEOMETRY_KEYS) if (a[key] !== b[key]) return false;
  return true;
}

function payloadOf({ pairKey, geometry, savedAt, history }) {
  return JSON.stringify({ version: VERSION, pairKey, savedAt, geometry, history });
}

function saveWallHistory({ dir = DEFAULT_STORE_DIR, pairKey, geometry, savedAt = Date.now(), history, maxBytes = MAX_FILE_BYTES, suffix = "walls" }) {
  try {
    const file = wallHistoryPath(dir, pairKey, suffix);
    const payload = payloadOf({ pairKey, geometry, savedAt, history });
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

async function saveWallHistoryAsync({ dir = DEFAULT_STORE_DIR, pairKey, geometry, savedAt = Date.now(), history, maxBytes = MAX_FILE_BYTES, suffix = "walls" }) {
  let temporary = null;
  try {
    const file = wallHistoryPath(dir, pairKey, suffix);
    const payload = payloadOf({ pairKey, geometry, savedAt, history });
    const bytes = Buffer.byteLength(payload);
    if (bytes > maxBytes) return { ok: false, reason: "OVER_BUDGET", bytes };
    await fs.promises.mkdir(dir, { recursive: true });
    writeSequence += 1;
    temporary = `${file}.${process.pid}.${writeSequence}.tmp`;
    await fs.promises.writeFile(temporary, payload);
    await fs.promises.rename(temporary, file);
    temporary = null;
    return { ok: true, bytes, file };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  } finally {
    if (temporary !== null) await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

function loadWallHistory({ dir = DEFAULT_STORE_DIR, pairKey, geometry, maxFileBytes = MAX_FILE_BYTES, onReject = () => {}, suffix = "walls" }) {
  const reject = (reason) => {
    onReject(reason);
    return null;
  };
  let raw;
  try {
    const file = wallHistoryPath(dir, pairKey, suffix);
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
  if (!saved || saved.version !== VERSION || saved.pairKey !== pairKey) return reject("FOREIGN");
  if (!Number.isSafeInteger(saved.savedAt) || !saved.history || typeof saved.history !== "object") return reject("MALFORMED");
  if (geometry !== undefined && !sameGeometry(saved.geometry, geometry)) return reject("GEOMETRY_MISMATCH");
  return { savedAt: saved.savedAt, geometry: saved.geometry, history: saved.history };
}

function dropWallHistory({ dir = DEFAULT_STORE_DIR, pairKey, suffix = "walls" }) {
  try {
    fs.rmSync(wallHistoryPath(dir, pairKey, suffix), { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = { saveWallHistory, saveWallHistoryAsync, loadWallHistory, dropWallHistory, wallHistoryPath, sameGeometry, MAX_FILE_BYTES };
