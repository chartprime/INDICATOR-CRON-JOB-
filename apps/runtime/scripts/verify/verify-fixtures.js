#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const { verifyStorageIntegrity } = require("../../src/storage/storage-db");
const { verifyDxFeedStorageIntegrity } = require("../../src/storage/dxfeed/dxfeed-storage-db");
const { sha256File, describeTables, readInventory, evaluateAcceptance } = require("../maintain/fixture-lib");
const {
  BINANCE_TABLES, DXFEED_TABLES, computeBinanceStats, computeDxFeedStats, DEFAULT_FIXTURE_DIR, DEFAULT_INVENTORY,
} = require("../maintain/export-fixture-slice");
const { computeReplayPin } = require("../maintain/fixture-replay-pin");

const STATUS_OK = "OK";
const STATUS_SKIPPED = "SKIPPED";
const STATUS_DRIFT = "DRIFT";

function differences(expected, actual, label) {
  return JSON.stringify(expected) === JSON.stringify(actual) ? [] : [{ what: label, expected, actual }];
}

function adapterFor(fixture) {
  if (fixture.provider === "dxfeed") {
    return {
      tables: DXFEED_TABLES,
      verifyIntegrity: (dbPath) => verifyDxFeedStorageIntegrity({ dbPath }),
      replayIdentity: fixture.assetClass,
      stats: (db) => computeDxFeedStats(db, {
        symbol: fixture.symbol, assetClass: fixture.assetClass, orderSource: fixture.orderSource, fromTs: fixture.window.fromTs, toTs: fixture.window.toTs,
        anchor: { eventTime: fixture.window.anchorEventTime },
      }),
    };
  }
  return {
    tables: BINANCE_TABLES,
    verifyIntegrity: (dbPath) => verifyStorageIntegrity({ dbPath }),
    replayIdentity: fixture.marketKind,
    stats: (db) => computeBinanceStats(db, {
      symbol: fixture.symbol, marketKind: fixture.marketKind, fromTs: fixture.window.fromTs, toTs: fixture.window.toTs,
      anchor: { captured_at: fixture.window.anchorCapturedAt },
    }),
  };
}

async function verifyOne(fixture, { fixtureDir, replay }) {
  const adapter = adapterFor(fixture);
  const filePath = path.join(fixtureDir, fixture.file.name);
  if (!fs.existsSync(filePath)) return { id: fixture.id, status: STATUS_SKIPPED, reason: "fixture file is not present on this machine", drift: [] };
  const drift = [];
  const sizeBytes = fs.statSync(filePath).size;
  const fileSha256 = sha256File(filePath);
  drift.push(...differences(fixture.file.sizeBytes, sizeBytes, "file.sizeBytes"));
  drift.push(...differences(fixture.file.sha256, fileSha256, "file.sha256"));
  let readable = true;
  try {
    drift.push(...differences("ok", adapter.verifyIntegrity(filePath).integrity, "integrity"));
    const db = new Database(filePath, { readonly: true, fileMustExist: true });
    try {
      drift.push(...differences(fixture.integrity.quickCheck, db.pragma("quick_check", { simple: true }), "integrity.quickCheck"));
      drift.push(...differences(0, db.pragma("foreign_key_check").length, "integrity.foreignKeyViolations"));
      drift.push(...differences(fixture.tables, describeTables(db, adapter.tables), "tables"));
      const recomputed = adapter.stats(db);
      drift.push(...differences(fixture.stats, recomputed, "stats"));
      if (fixture.acceptance !== undefined) {
        const evaluated = evaluateAcceptance(recomputed, fixture.acceptance.criteria);
        drift.push(...differences({ results: fixture.acceptance.results, pass: fixture.acceptance.pass }, evaluated, "acceptance"));
        if (!evaluated.pass) drift.push({ what: "acceptance.pass", expected: true, actual: false });
      }
    } finally {
      db.close();
    }
  } catch (error) {
    readable = false;
    drift.push({ what: "readable", expected: "a database that opens and passes integrity checks", actual: String(error?.message ?? error).slice(0, 200) });
  }
  if (readable && replay && fixture.replayPin !== undefined) {
    const replayWindow = fixture.replayPin.window ?? fixture.window;
    const pin = await computeReplayPin({
      provider: fixture.provider, dbPath: filePath, symbol: fixture.symbol, marketKind: adapter.replayIdentity, fromTs: replayWindow.fromTs, toTs: replayWindow.toTs,
      ...(fixture.replayPin.window === undefined ? {} : { pinWindow: replayWindow }),
      ...(fixture.replayPin.pageLimit === undefined ? {} : { pageLimit: fixture.replayPin.pageLimit }),
      geometry: fixture.replayPin.geometry, limits: Object.fromEntries(Object.entries(fixture.replayPin.limits).filter(([, value]) => value !== null)),
    });
    drift.push(...differences(fixture.replayPin, pin, "replayPin"));
  }
  return { id: fixture.id, status: drift.length === 0 ? STATUS_OK : STATUS_DRIFT, drift };
}

async function verifyFixtures({ inventoryPath = DEFAULT_INVENTORY, fixtureDir = DEFAULT_FIXTURE_DIR, replay = false, ids = null, requirePresent = false } = {}) {
  const inventory = readInventory(inventoryPath);
  const selected = ids === null ? inventory.fixtures : inventory.fixtures.filter((fixture) => ids.includes(fixture.id));
  if (ids !== null) {
    const unknown = ids.filter((id) => !inventory.fixtures.some((fixture) => fixture.id === id));
    if (unknown.length > 0) throw new Error(`verify-fixtures: unknown fixture ids ${unknown.join(", ")}`);
  }
  const results = [];
  for (const fixture of selected) results.push(await verifyOne(fixture, { fixtureDir, replay }));
  const failed = results.filter((result) => result.status === STATUS_DRIFT || (requirePresent && result.status === STATUS_SKIPPED));
  return { results, ok: failed.length === 0, checked: results.filter((result) => result.status !== STATUS_SKIPPED).length, skipped: results.filter((result) => result.status === STATUS_SKIPPED).length };
}

async function main(argv = process.argv.slice(2)) {
  const options = { replay: false, requirePresent: false, ids: null, inventoryPath: DEFAULT_INVENTORY, fixtureDir: DEFAULT_FIXTURE_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--replay") options.replay = true;
    else if (flag === "--require") options.requirePresent = true;
    else if (flag === "--id" && argv[index + 1] !== undefined) { options.ids = [...(options.ids ?? []), argv[index + 1]]; index += 1; }
    else if (flag === "--inventory" && argv[index + 1] !== undefined) { options.inventoryPath = path.resolve(argv[index + 1]); index += 1; }
    else if (flag === "--fixture-dir" && argv[index + 1] !== undefined) { options.fixtureDir = path.resolve(argv[index + 1]); index += 1; }
    else throw new Error(`usage: verify-fixtures [--replay] [--require] [--id <id>]... [--inventory <path>] [--fixture-dir <dir>] (unexpected ${flag})`);
  }
  const report = await verifyFixtures(options);
  for (const result of report.results) {
    process.stdout.write(`${result.status.padEnd(8)} ${result.id}${result.status === STATUS_SKIPPED ? ` (${result.reason})` : ""}\n`);
    for (const item of result.drift) process.stdout.write(`         drift in ${item.what}: expected ${JSON.stringify(item.expected).slice(0, 200)} but found ${JSON.stringify(item.actual).slice(0, 200)}\n`);
  }
  process.stdout.write(`${report.checked} verified, ${report.skipped} skipped, ${report.ok ? "no drift" : "DRIFT OR MISSING FIXTURES"}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 2;
  });
}

module.exports = { verifyFixtures, main, STATUS_OK, STATUS_SKIPPED, STATUS_DRIFT };
