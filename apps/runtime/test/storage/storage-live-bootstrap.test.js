const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createStorageDb, SCHEMA_VERSION } = require("../../src/storage/storage-db");
const { createStorageService } = require("../../src/storage/storage-service");
const { safeRm } = require("../helpers/temp-files");

function tempDbPath() {
  return path.join(os.tmpdir(), `terminal-live-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function fakeConnection() {
  let listener = null;
  return {
    onMessage: jest.fn((nextListener) => {
      listener = nextListener;
      return () => { listener = null; };
    }),
    emit(envelope) { listener?.(envelope); },
  };
}

describe("live storage bootstrap boundary", () => {
  let dbPath;

  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm", ".lock"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test("a new database is initialized during first launch", () => {
    dbPath = tempDbPath();
    const service = createStorageService({ connection: fakeConnection(), dbPath });
    service.start();
    service.stop();

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT version FROM storage_schema").get()).toEqual({ version: SCHEMA_VERSION });
    db.close();
  });

  test("an existing old schema fails fast without performing an online migration", () => {
    dbPath = tempDbPath();
    const initialized = createStorageDb({ dbPath });
    initialized.close();
    const db = new Database(dbPath);
    db.prepare("UPDATE storage_schema SET version = ?").run(SCHEMA_VERSION - 1);
    db.close();

    const service = createStorageService({ connection: fakeConnection(), dbPath });
    expect(() => service.start()).toThrow(/migrate:storage-schema/);

    const unchanged = new Database(dbPath, { readonly: true });
    expect(unchanged.prepare("SELECT version FROM storage_schema").get()).toEqual({ version: SCHEMA_VERSION - 1 });
    unchanged.close();
  });

  test("a current-version database with a missing required index is rejected instead of running degraded", () => {
    dbPath = tempDbPath();
    const initialized = createStorageDb({ dbPath });
    initialized.raw.exec("DROP INDEX idx_l2_depth_events_symbol_market_id");
    initialized.close();

    const service = createStorageService({ connection: fakeConnection(), dbPath });
    expect(() => service.start()).toThrow(/missing index idx_l2_depth_events_symbol_market_id/);
  });

});
