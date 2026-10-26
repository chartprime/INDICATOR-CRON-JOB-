"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const INVENTORY_VERSION = 1;

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (let read = fs.readSync(descriptor, buffer, 0, buffer.length, null); read > 0; read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

function digestTable(db, table, orderBy) {
  const columns = tableColumns(db, table);
  const statement = db.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${orderBy}`).raw(true);
  const hash = crypto.createHash("sha256");
  let rows = 0;
  for (const row of statement.iterate()) {
    hash.update(JSON.stringify(row));
    hash.update("\n");
    rows += 1;
  }
  return { rows, sha256: hash.digest("hex") };
}

function describeTables(db, tables) {
  return Object.fromEntries(tables.map(({ table, orderBy }) => [table, digestTable(db, table, orderBy)]));
}

function nearestRank(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarizeNumbers(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mean = sorted.length === 0 ? null : Math.round(sorted.reduce((total, value) => total + value, 0) / sorted.length * 100) / 100;
  return { mean, p50: nearestRank(sorted, 0.5), p95: nearestRank(sorted, 0.95), max: sorted.at(-1) ?? null };
}

function perSecond(count, windowMs) {
  return windowMs > 0 ? Math.round(count / (windowMs / 1_000) * 100) / 100 : null;
}

function readInventory(inventoryPath) {
  if (!fs.existsSync(inventoryPath)) return { version: INVENTORY_VERSION, fixtures: [] };
  const parsed = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  if (parsed?.version !== INVENTORY_VERSION || !Array.isArray(parsed.fixtures)) throw new Error("fixture-lib: unsupported inventory format");
  return parsed;
}

function writeInventory(inventoryPath, inventory) {
  const fixtures = [...inventory.fixtures].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const serialized = `${JSON.stringify({ ...inventory, fixtures }, null, 2)}\n`;
  fs.mkdirSync(path.dirname(inventoryPath), { recursive: true });
  const temporaryPath = `${inventoryPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporaryPath, inventoryPath);
}

function upsertInventoryEntry(inventoryPath, entry) {
  const inventory = readInventory(inventoryPath);
  const index = inventory.fixtures.findIndex((fixture) => fixture.id === entry.id);
  if (index === -1) inventory.fixtures.push(entry);
  else inventory.fixtures[index] = entry;
  writeInventory(inventoryPath, inventory);
  return inventory;
}

const BINANCE_ACCEPTANCE_FACTORS = Object.freeze({
  "events.perSecond": Object.freeze([0.8, 1.25]),
  "events.levelsPerEvent.mean": Object.freeze([0.5, 2]),
  "trades.perSecond": Object.freeze([0.5, 2]),
});

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function buildBinanceAcceptance({ referenceKey, reference }) {
  const seconds = (reference.window.toTs - reference.window.fromTs) / 1_000;
  const referenceValues = {
    "events.perSecond": reference.events / seconds,
    "events.levelsPerEvent.mean": reference.levelsPerEventMean,
    "trades.perSecond": reference.trades / seconds,
  };
  const criteria = Object.entries(BINANCE_ACCEPTANCE_FACTORS).map(([metric, [low, high]]) => ({
    metric, min: roundTo(referenceValues[metric] * low, 2), max: roundTo(referenceValues[metric] * high, 2),
  }));
  if (reference.snapshots > 0) criteria.push({ metric: "snapshots.gapMs.p50", max: Math.round((reference.window.toTs - reference.window.fromTs) / reference.snapshots) });
  return { referenceKey, criteria };
}

function buildDxFeedAcceptance({ referenceKey, reference }) {
  const seconds = (reference.window.toTs - reference.window.fromTs) / 1_000;
  const referenceValues = {
    "orders.perSecond": reference.orderBookRows / seconds,
    "tape.perSecond": reference.timeAndSales / seconds,
  };
  const atLeast = reference.acceptance === "at-least";
  const criteria = Object.entries(referenceValues).map(([metric, value]) => (
    atLeast
      ? { metric, min: roundTo(value, 2) }
      : { metric, min: roundTo(value * 0.5, 2), max: roundTo(value * 2, 2) }
  ));
  return { referenceKey, mode: atLeast ? "at-least" : "band", criteria };
}

function valueAtPath(object, metric) {
  return metric.split(".").reduce((value, key) => value?.[key], object);
}

function evaluateAcceptance(stats, criteria) {
  const results = criteria.map((criterion) => {
    const observed = valueAtPath(stats, criterion.metric);
    const pass = Number.isFinite(observed)
      && (criterion.min === undefined || observed >= criterion.min)
      && (criterion.max === undefined || observed <= criterion.max);
    return { ...criterion, observed: Number.isFinite(observed) ? observed : null, pass };
  });
  return { results, pass: results.every((result) => result.pass) };
}

const HOST_PATH_PATTERN = /(?:^|[\s"'=])(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|srv|Users|opt|var|tmp|mnt|root|etc)\/)/;
const SECRET_KEY_PATTERN = /token|secret|password|passwd|credential|api[-_]?key|authorization|bearer/i;
const HEX_64 = /^[0-9a-f]{64}$/;
const ENTRY_ID = /^[a-z0-9][a-z0-9-]{2,79}$/;
const PROVIDERS = Object.freeze(["binance", "dxfeed"]);
const DATA_CLASSES = Object.freeze(["public-exchange-market-data", "licensed-vendor-market-data"]);

function walk(value, visit, keyPath = "") {
  visit(value, keyPath);
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, visit, `${keyPath}[${index}]`));
  else if (value !== null && typeof value === "object") Object.entries(value).forEach(([key, item]) => walk(item, visit, keyPath === "" ? key : `${keyPath}.${key}`));
}

function validateInventoryEntry(entry) {
  const problems = [];
  const need = (condition, message) => { if (!condition) problems.push(message); };
  need(entry !== null && typeof entry === "object" && !Array.isArray(entry), "entry must be an object");
  if (problems.length > 0) return problems;
  need(typeof entry.id === "string" && ENTRY_ID.test(entry.id), "id must be a lowercase slug");
  need(PROVIDERS.includes(entry.provider), `provider must be one of ${PROVIDERS.join(", ")}`);
  need(typeof entry.symbol === "string" && entry.symbol.length > 0, "symbol is required");
  need(typeof entry.marketKind === "string" || typeof entry.assetClass === "string", "marketKind or assetClass is required");
  need(Number.isSafeInteger(entry.window?.fromTs) && Number.isSafeInteger(entry.window?.toTs) && entry.window.toTs > entry.window.fromTs, "window must have integer fromTs < toTs");
  need(typeof entry.source?.basename === "string" && !/[\\/]/.test(entry.source.basename), "source.basename must be a bare file name");
  need(Number.isSafeInteger(entry.source?.schemaVersion), "source.schemaVersion must be an integer");
  need(Number.isSafeInteger(entry.exporter?.version), "exporter.version must be an integer");
  need(entry.file?.name === `${entry.id}.sqlite`, "file.name must be <id>.sqlite");
  need(HEX_64.test(entry.file?.sha256 ?? ""), "file.sha256 must be a 64-digit hex digest");
  need(Number.isSafeInteger(entry.file?.sizeBytes) && entry.file.sizeBytes > 0, "file.sizeBytes must be a positive integer");
  const tables = entry.tables ?? {};
  need(Object.keys(tables).length > 0, "tables must list at least one table");
  for (const [name, table] of Object.entries(tables)) {
    need(Number.isSafeInteger(table?.rows) && table.rows >= 0, `tables.${name}.rows must be a non-negative integer`);
    need(HEX_64.test(table?.sha256 ?? ""), `tables.${name}.sha256 must be a 64-digit hex digest`);
  }
  need(entry.integrity?.quickCheck === "ok" && entry.integrity?.foreignKeyViolations === 0, "integrity must be ok with no foreign-key violations");
  need(entry.stats !== null && typeof entry.stats === "object", "stats are required");
  need(DATA_CLASSES.includes(entry.governance?.dataClass), `governance.dataClass must be one of ${DATA_CLASSES.join(", ")}`);
  need(entry.governance?.retention === "local-only-git-ignored", "governance.retention must be local-only-git-ignored");
  need(typeof entry.governance?.basis === "string" && entry.governance.basis.length > 0, "governance.basis must say why the data may be kept");
  walk(entry, (value, keyPath) => {
    if (typeof value === "string" && HOST_PATH_PATTERN.test(value)) problems.push(`${keyPath} looks like a host path`);
    const key = keyPath.split(/[.[]/).pop();
    if (SECRET_KEY_PATTERN.test(key ?? "")) problems.push(`${keyPath} looks like a credential field`);
  });
  return problems;
}

module.exports = {
  buildBinanceAcceptance, buildDxFeedAcceptance, evaluateAcceptance, BINANCE_ACCEPTANCE_FACTORS,
  validateInventoryEntry,
  INVENTORY_VERSION, sha256File, tableColumns, digestTable, describeTables, nearestRank, summarizeNumbers, perSecond,
  readInventory, writeInventory, upsertInventoryEntry,
};
