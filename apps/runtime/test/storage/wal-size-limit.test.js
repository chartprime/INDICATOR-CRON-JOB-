"use strict";

// Report 57 W3: the collectors' WAL files sat at their 3-4 GB high-water
// size between the daily TRUNCATE checkpoints. journal_size_limit makes
// SQLite trim the WAL back to 256 MiB whenever a checkpoint resets it.
const os = require("node:os");
const path = require("node:path");
const { createStorageDb } = require("../../src/storage/storage-db");
const { createDxFeedStorageDb } = require("../../src/storage/dxfeed/dxfeed-storage-db");
const { safeRm } = require("../helpers/temp-files");

const temp = (name) => path.join(os.tmpdir(), `wal-limit-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);

describe("collector databases cap the WAL file size (W3)", () => {
  test.each([
    ["binance", createStorageDb],
    ["dxfeed", createDxFeedStorageDb],
  ])("%s writer sets journal_size_limit to 256 MiB", (name, create) => {
    const dbPath = temp(name);
    const db = create({ dbPath });
    try {
      expect(db.raw.pragma("journal_size_limit", { simple: true })).toBe(256 * 1024 * 1024);
      expect(db.raw.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      db.close();
      for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
    }
  });
});
