const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { safeRm } = require("../../helpers/temp-files");
const {
  createDxFeedStorageDb,
  SCHEMA_VERSION,
  MIGRATION_STEPS,
  REQUIRED_INDEXES,
} = require("../../../src/storage/dxfeed/dxfeed-storage-db");

// A2.19 / L1L2-V2-038. initializeSchema calls createCurrentIndexes(db)
// unconditionally after every migration path, so a migration whose whole body
// is index creation could be emptied and the end-to-end migration suites would
// still pass -- they observe the schema after createCurrentIndexes has already
// rebuilt it. These tests call each step directly and assert its own effect,
// which is the only place the body is load-bearing.

function tempDbPath() {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "dxfeed-migrations-")),
    "dxfeed.sqlite",
  );
}

function withRawDb(run) {
  const dbPath = tempDbPath();
  createDxFeedStorageDb({ dbPath }).close();
  const db = new Database(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
    safeRm(path.dirname(dbPath), { recursive: true, force: true });
  }
}

function stampVersion(db, version) {
  db.exec(`DELETE FROM dxfeed_storage_schema; INSERT INTO dxfeed_storage_schema (version) VALUES (${version});`);
}

function currentVersion(db) {
  return db.prepare("SELECT version FROM dxfeed_storage_schema").pluck().get();
}

function indexNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
    .pluck()
    .all();
}

describe("dxfeed storage migration steps", () => {
  test("every from-version in the chain has an exported step, up to the current version", () => {
    const froms = Object.keys(MIGRATION_STEPS).map(Number).sort((a, b) => a - b);
    expect(froms).toEqual(Array.from({ length: SCHEMA_VERSION - 1 }, (_, i) => i + 1));
  });

  // The step chain is what a real 40GB database at an older version walks. If
  // a step stops stamping its own version, the chain still lands on
  // SCHEMA_VERSION because a later step overwrites the row -- so the stamp has
  // to be asserted per step, in isolation.
  //
  // A2.21 / L1L2-V2-096: migrations no longer create indexes at all. They used
  // to, redundantly -- initializeSchema calls createCurrentIndexes after every
  // path, which is precisely why L1L2-V2-038 found their bodies could be
  // emptied without any test noticing. Index creation now has one home,
  // INDEX_DEFINITIONS, so a migration's only job is its version stamp.
  test.each([16, 17, 18, 19, 20])("the v%i step stamps its way to the current version", (from) => {
    withRawDb((db) => {
      stampVersion(db, from);

      MIGRATION_STEPS[from](db);

      expect(currentVersion(db)).toBe(SCHEMA_VERSION);
    });
  });

  // L1L2-V2-084 retired the two fixed-floor partial indexes along with the
  // z-score detector they were built for. The v17 step that created them now
  // only stamps its version, and v18->v19 drops them from any database that
  // still carries them.
  test("v18 drops every index the retired large-trade detector left behind", () => {
    withRawDb((db) => {
      // A genuine v18 database carries all three. A fresh one does not, so
      // without recreating them here the absence assertions below would pass
      // whether or not the migration actually drops anything.
      db.exec(`
        CREATE INDEX idx_dxfeed_time_and_sales_large_trade_z_score
          ON dxfeed_time_and_sales(symbol, asset_class, baseline_log_median);
        CREATE INDEX idx_dxfeed_time_and_sales_futures_fixed_floor
          ON dxfeed_time_and_sales(symbol, size);
        CREATE INDEX idx_dxfeed_time_and_sales_equity_fixed_floor
          ON dxfeed_time_and_sales(symbol, price);
      `);
      for (const name of [
        "idx_dxfeed_time_and_sales_large_trade_z_score",
        "idx_dxfeed_time_and_sales_futures_fixed_floor",
        "idx_dxfeed_time_and_sales_equity_fixed_floor",
      ]) {
        expect(indexNames(db)).toContain(name);
      }
      stampVersion(db, 18);

      MIGRATION_STEPS[18](db);

      const names = indexNames(db);
      expect(names).not.toContain("idx_dxfeed_time_and_sales_futures_fixed_floor");
      expect(names).not.toContain("idx_dxfeed_time_and_sales_equity_fixed_floor");
      expect(names).not.toContain("idx_dxfeed_time_and_sales_large_trade_z_score");
      expect(currentVersion(db)).toBe(SCHEMA_VERSION);
    });
  });

  // L1L2-V2-100. v19->v20 retired dxfeed_orders as a concept but deliberately
  // kept the table and its rows -- captured data is not something a schema
  // migration should destroy. Its two indexes are a different matter: they are
  // derived data, nothing reads or writes the table any more, and on the live
  // database they were measured at 5.66 GiB. v20->v21 drops them.
  //
  // This has to be its own step. The live database had already reached v20 by
  // the time this was found, so widening the v19->v20 body would never have run
  // there.
  test("v20 drops the retired order table's indexes but keeps the table and its rows", () => {
    withRawDb((db) => {
      // A real database carries these from back when dxfeed_orders was live. A
      // fresh one has neither the table nor the indexes, so without building
      // them here the absence assertions would pass no matter what v20 does.
      db.exec(`
        CREATE TABLE dxfeed_orders (
          id INTEGER PRIMARY KEY,
          symbol TEXT NOT NULL,
          asset_class TEXT NOT NULL,
          event_time INTEGER NOT NULL
        );
        CREATE INDEX idx_dxfeed_orders_symbol_time ON dxfeed_orders(symbol, asset_class, event_time);
        CREATE INDEX idx_dxfeed_orders_event_time ON dxfeed_orders(event_time);
        INSERT INTO dxfeed_orders (symbol, asset_class, event_time) VALUES ('AAPL', 'EQUITY', 1);
      `);
      expect(indexNames(db)).toContain("idx_dxfeed_orders_symbol_time");
      expect(indexNames(db)).toContain("idx_dxfeed_orders_event_time");
      stampVersion(db, 20);

      MIGRATION_STEPS[20](db);

      const names = indexNames(db);
      expect(names).not.toContain("idx_dxfeed_orders_symbol_time");
      expect(names).not.toContain("idx_dxfeed_orders_event_time");
      expect(db.prepare("SELECT count(*) FROM dxfeed_orders").pluck().get()).toBe(1);
      expect(currentVersion(db)).toBe(SCHEMA_VERSION);
    });
  });

  // A database that never had the retired table must migrate cleanly rather
  // than failing on a DROP INDEX for something that was never there.
  test("v20 is safe on a database that never carried the retired table", () => {
    withRawDb((db) => {
      stampVersion(db, 20);

      expect(() => MIGRATION_STEPS[20](db)).not.toThrow();
      expect(currentVersion(db)).toBe(SCHEMA_VERSION);
    });
  });

  // Index creation is centralised, so a dropped index is restored by REOPENING
  // the database (createCurrentIndexes), not by any migration step.
  test("a full open restores every required index, which is now their only source", () => {
    const dbPath = tempDbPath();
    try {
      createDxFeedStorageDb({ dbPath }).close();
      const tampered = new Database(dbPath);
      for (const name of REQUIRED_INDEXES) tampered.exec(`DROP INDEX IF EXISTS ${name}`);
      expect(indexNames(tampered)).toHaveLength(0);
      tampered.close();

      const reopened = createDxFeedStorageDb({ dbPath });
      try {
        expect(indexNames(reopened.raw).sort()).toEqual([...REQUIRED_INDEXES].sort());
      } finally {
        reopened.close();
      }
    } finally {
      safeRm(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  // Bumping SCHEMA_VERSION without adding the matching entry-point branch to
  // initializeSchema leaves every database written by the previous release
  // unopenable -- and nothing else in the suite would notice, because fresh
  // databases are created at the current version and never migrate at all.
  test.each(Array.from({ length: SCHEMA_VERSION - 1 }, (_, i) => i + 1))(
    "a database at version %i is a supported entry point and migrates to the current version",
    (from) => {
      const dbPath = tempDbPath();
      try {
        createDxFeedStorageDb({ dbPath }).close();
        const tampered = new Database(dbPath);
        stampVersion(tampered, from);
        tampered.close();

        const migrated = createDxFeedStorageDb({ dbPath });
        try {
          expect(currentVersion(migrated.raw)).toBe(SCHEMA_VERSION);
        } finally {
          migrated.close();
        }
      } finally {
        safeRm(path.dirname(dbPath), { recursive: true, force: true });
      }
    },
  );

  // createCurrentIndexes runs on every open, and the same index is spelled out
  // in three places (the create-schema SQL, createCurrentIndexes, and the
  // migration that introduced it). Only this path exercises the second copy:
  // a database already at the current version whose index has gone missing.
  test.each([
    "idx_dxfeed_time_and_sales_vpin_covering",
  ])("reopening restores %s when it has gone missing at the current version", (indexName) => {
    const dbPath = tempDbPath();
    try {
      createDxFeedStorageDb({ dbPath }).close();
      const tampered = new Database(dbPath);
      tampered.exec(`DROP INDEX IF EXISTS ${indexName}`);
      expect(indexNames(tampered)).not.toContain(indexName);
      tampered.close();

      const reopened = createDxFeedStorageDb({ dbPath });
      try {
        expect(indexNames(reopened.raw)).toContain(indexName);
      } finally {
        reopened.close();
      }
    } finally {
      safeRm(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("a version the migration ladder does not cover is refused rather than opened", () => {
    const dbPath = tempDbPath();
    createDxFeedStorageDb({ dbPath }).close();
    const tampered = new Database(dbPath);
    stampVersion(tampered, SCHEMA_VERSION + 1);
    tampered.close();

    expect(() => createDxFeedStorageDb({ dbPath }))
      .toThrow(new RegExp(`unsupported schema version ${SCHEMA_VERSION + 1}`));

    safeRm(path.dirname(dbPath), { recursive: true, force: true });
  });
});
