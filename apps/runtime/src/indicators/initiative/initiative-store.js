"use strict";

const fs = require("fs");
const path = require("path");
const { dataRoot } = require("../../platform/runtime-paths");

const MAX_INITIATIVE_FILE_BYTES = 8 * 1024 * 1024;
const INITIATIVE_STORE_VERSION = 1;
let writeSequence = 0;

function defaultStoreDir() {
  return path.join(dataRoot(), "initiative");
}

function initiativeHistoryPath(dir, pairKey) {
  if (typeof pairKey !== "string" || pairKey.length === 0) throw new Error("initiative-store: pairKey must be a non-empty string");
  return path.join(dir, `${pairKey.replace(/[^A-Za-z0-9_.-]+/g, "_")}.initiative.json`);
}

function payloadOf({ pairKey, savedAt, rulesVersion, coveredUntil = null, coveredFrom = null, bands, scales }) {
  return JSON.stringify({ version: INITIATIVE_STORE_VERSION, pairKey, savedAt, rulesVersion, coveredUntil, coveredFrom, bands, scales });
}

function saveInitiativeHistory({ dir = defaultStoreDir(), pairKey, savedAt = Date.now(), rulesVersion, coveredUntil = null, coveredFrom = null, bands, scales, maxBytes = MAX_INITIATIVE_FILE_BYTES }) {
  try {
    const file = initiativeHistoryPath(dir, pairKey);
    const payload = payloadOf({ pairKey, savedAt, rulesVersion, coveredUntil, coveredFrom, bands, scales });
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

async function saveInitiativeHistoryAsync({ dir = defaultStoreDir(), pairKey, savedAt = Date.now(), rulesVersion, coveredUntil = null, coveredFrom = null, bands, scales, maxBytes = MAX_INITIATIVE_FILE_BYTES, superseded = () => false }) {
  let temporary = null;
  try {
    const file = initiativeHistoryPath(dir, pairKey);
    const payload = payloadOf({ pairKey, savedAt, rulesVersion, coveredUntil, coveredFrom, bands, scales });
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

function loadInitiativeHistory({ dir = defaultStoreDir(), pairKey, rulesVersion, maxFileBytes = MAX_INITIATIVE_FILE_BYTES, onReject = () => {} }) {
  const reject = (reason) => {
    onReject(reason);
    return null;
  };
  let raw;
  try {
    const file = initiativeHistoryPath(dir, pairKey);
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
  if (!saved || saved.version !== INITIATIVE_STORE_VERSION || saved.pairKey !== pairKey) return reject("FOREIGN");
  if (saved.rulesVersion !== rulesVersion) return reject("STALE_RULES");
  if (!Number.isSafeInteger(saved.savedAt) || !Array.isArray(saved.bands) || !Array.isArray(saved.scales)) return reject("MALFORMED");
  const coveredUntil = saved.coveredUntil ?? null;
  if (coveredUntil !== null && !Number.isSafeInteger(coveredUntil)) return reject("MALFORMED");
  const coveredFrom = saved.coveredFrom ?? null;
  if (coveredFrom !== null && !Number.isSafeInteger(coveredFrom)) return reject("MALFORMED");
  return { savedAt: saved.savedAt, coveredUntil, coveredFrom, bands: saved.bands, scales: saved.scales };
}

function dropInitiativeHistory({ dir = defaultStoreDir(), pairKey }) {
  try {
    fs.rmSync(initiativeHistoryPath(dir, pairKey), { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = { saveInitiativeHistory, saveInitiativeHistoryAsync, loadInitiativeHistory, dropInitiativeHistory, initiativeHistoryPath, defaultStoreDir, MAX_INITIATIVE_FILE_BYTES, INITIATIVE_STORE_VERSION };
