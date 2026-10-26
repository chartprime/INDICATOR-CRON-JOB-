"use strict";

function readPositiveInt(envName) {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") return undefined;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${envName} must be a positive integer of bytes, received ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${envName}=${raw} exceeds the safe integer range`);
  }
  return value;
}

function collectorCapacityLimits() {
  const limits = {};
  const maxDbBytes = readPositiveInt("TT_MAX_DB_BYTES");
  if (maxDbBytes !== undefined) limits.maxDbBytes = maxDbBytes;
  const minFreeDiskBytes = readPositiveInt("TT_MIN_FREE_DISK_BYTES");
  if (minFreeDiskBytes !== undefined) limits.minFreeDiskBytes = minFreeDiskBytes;
  return limits;
}

module.exports = { readPositiveInt, collectorCapacityLimits };
