"use strict";

const fs = require("fs");
const path = require("path");
const { dataRoot } = require("../../platform/runtime-paths");

const MAX_EXHAUSTION_FILE_BYTES = 8 * 1024 * 1024;
const EXHAUSTION_STORE_VERSION = 1;
let writeSequence = 0;

function defaultStoreDir() {
  return path.join(dataRoot(), "exhaustion");
}

function exhaustionHistoryPath(dir, pairKey) {
  if (typeof pairKey !== "string" || pairKey.length === 0) throw new Error("exhaustion-store: pairKey must be a non-empty string");
  return path.join(dir, `${pairKey.replace(/[^A-Za-z0-9_.-]+/g, "_")}.exhaustion.json`);
}

function payloadOf({ pairKey, savedAt, rulesVersion, coveredUntil = null, coveredFrom = null, shades, scales }) {
  return JSON.stringify({ version: EXHAUSTION_STORE_VERSION, pairKey, savedAt, rulesVersion, coveredUntil, coveredFrom, shades, scales });
}

function saveExhaustionHistory({ dir = defaultStoreDir(), pairKey, savedAt = Date.now(), rulesVersion, coveredUntil = null, coveredFrom = null, shades, scales, maxBytes = MAX_EXHAUSTION_FILE_BYTES }) {
  try {
    const file = exhaustionHistoryPath(dir, pairKey);
    const payload = payloadOf({ pairKey, savedAt, rulesVersion, coveredUntil, coveredFrom, shades, scales });
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

async function saveExhaustionHistoryAsync({ dir = defaultStoreDir(), pairKey, savedAt = Date.now(), rulesVersion, coveredUntil = null, coveredFrom = null, shades, scales, maxBytes = MAX_EXHAUSTION_FILE_BYTES, superseded = () => false }) {
  let temporary = null;
  try {
    const file = exhaustionHistoryPath(dir, pairKey);
    const payload = payloadOf({ pairKey, savedAt, rulesVersion, coveredUntil, coveredFrom, shades, scales });
    const bytes = Buffer.byteLength(payload);
    if (bytes > maxBytes) return { ok: false, reason: "OVER_BUDGET", bytes };
    await fs.promises.mkdir(dir, { recursive: true });
    writeSequence += 1;
    temporary = `${file}.${process.pid}.${writeSequence}.tmp`;
    await fs.promises.writeFile(temporary, payload);
    if (superseded()) return { ok: false, reason: "SUPERSEDED" };
    await fs.promises.rename(temporary, file);
    temporary = null;
    return { ok: true, bytes, file };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  } finally {
    if (temporary !== null) await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

function loadExhaustionHistory({ dir = defaultStoreDir(), pairKey, rulesVersion, maxFileBytes = MAX_EXHAUSTION_FILE_BYTES, onReject = () => {} }) {
  const reject = (reason) => {
    onReject(reason);
    return null;
  };
  let raw;
  try {
    const file = exhaustionHistoryPath(dir, pairKey);
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
  if (!saved || saved.version !== EXHAUSTION_STORE_VERSION || saved.pairKey !== pairKey) return reject("FOREIGN");
  if (saved.rulesVersion !== rulesVersion) return reject("STALE_RULES");
  if (!Number.isSafeInteger(saved.savedAt) || !Array.isArray(saved.shades) || !Array.isArray(saved.scales)) return reject("MALFORMED");
  const coveredUntil = saved.coveredUntil ?? null;
  if (coveredUntil !== null && !Number.isSafeInteger(coveredUntil)) return reject("MALFORMED");
  const coveredFrom = saved.coveredFrom ?? null;
  if (coveredFrom !== null && !Number.isSafeInteger(coveredFrom)) return reject("MALFORMED");
  return { savedAt: saved.savedAt, coveredUntil, coveredFrom, shades: saved.shades, scales: saved.scales };
}

function dropExhaustionHistory({ dir = defaultStoreDir(), pairKey }) {
  try {
    fs.rmSync(exhaustionHistoryPath(dir, pairKey), { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = { saveExhaustionHistory, saveExhaustionHistoryAsync, loadExhaustionHistory, dropExhaustionHistory, exhaustionHistoryPath, defaultStoreDir, MAX_EXHAUSTION_FILE_BYTES, EXHAUSTION_STORE_VERSION };
