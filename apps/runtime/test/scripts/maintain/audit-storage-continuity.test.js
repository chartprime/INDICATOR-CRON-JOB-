const { main, parseDay } = require("../../../scripts/maintain/audit-storage-continuity");
const path = require("node:path");
const { DAY_MS } = require("../../../src/storage/archive-schedule");

// path.resolve is platform-dependent, so the expectation has to be too.
const DB_PATH = path.resolve("/tmp/binance.sqlite");

// A2.19 / L1L2-V2-032. The Binance depth continuity ledger was built, correct
// and never run: auditAndRecordDepthContinuityDay had no CLI, no npm script
// and no scheduler -- only its own unit test required it, so the 8 rows in the
// live table came from an ad-hoc invocation. This script is the runbook entry
// point; these tests cover the parts a unit test of the audit function cannot:
// the lock discipline and the exit code an operator reads.

function fakeLogger() {
  const calls = { info: [], ok: [], error: [] };
  return {
    calls,
    info: (...args) => calls.info.push(args),
    ok: (...args) => calls.ok.push(args),
    error: (...args) => calls.error.push(args),
    flush: () => Promise.resolve(),
  };
}

function fakeLock(order, { acquireError = null } = {}) {
  return {
    acquire: () => {
      order.push("acquire");
      if (acquireError) throw acquireError;
    },
    release: () => order.push("release"),
  };
}

const CLEAN_REPORT = { dayStartMs: 0, perPair: {}, totalRows: 10, totalGaps: 0, unanchoredPairs: 0, noDataPairs: 0 };

function invoke(overrides = {}) {
  return main({
    logger: fakeLogger(),
    argv: ["/tmp/binance.sqlite"],
    now: () => 3 * DAY_MS,
    createLock: () => fakeLock([]),
    createDb: () => ({ close: () => {} }),
    audit: () => CLEAN_REPORT,
    exit: jest.fn(),
    ...overrides,
  });
}

describe("parseDay", () => {
  test("defaults to the UTC day before now, so a nightly run audits a complete day", () => {
    expect(parseDay(undefined, 5 * DAY_MS + 1_000)).toBe(4 * DAY_MS);
  });

  test("accepts an explicit UTC day", () => {
    expect(parseDay("1970-01-03", 0)).toBe(2 * DAY_MS);
  });

  test.each(["2026-9-01", "20260901", "2026-09-01T00:00:00Z", "yesterday", ""])(
    "rejects %p rather than auditing an unintended day",
    (bad) => {
      expect(() => parseDay(bad, 0)).toThrow(/day must be YYYY-MM-DD in UTC/);
    },
  );

  test("rejects a syntactically valid but unparseable date", () => {
    expect(() => parseDay("2026-13-45", 0)).toThrow(/outside the supported UTC range/);
  });
});

describe("audit-storage-continuity", () => {
  test("takes the exclusive lock before auditing and releases it after", async () => {
    const order = [];
    const exitCode = await invoke({
      createLock: () => fakeLock(order),
      createDb: () => {
        order.push("open");
        return { close: () => order.push("close") };
      },
      audit: () => {
        order.push("audit");
        return CLEAN_REPORT;
      },
    });

    expect(order).toEqual(["acquire", "open", "audit", "close", "release"]);
    expect(exitCode).toBe(0);
  });

  test("opens the ledger without bootstrapping, so an audit never migrates a live database", async () => {
    let dbOptions = null;
    await invoke({
      createDb: (options) => {
        dbOptions = options;
        return { close: () => {} };
      },
    });

    expect(dbOptions).toMatchObject({
      dbPath: DB_PATH,
      bootstrap: false,
      verifyIntegrity: false,
    });
  });

  test("locks the database it was asked to audit, not a default path", async () => {
    let lockPath = null;
    await invoke({
      createLock: (options) => {
        lockPath = options.lockPath;
        return fakeLock([]);
      },
    });

    expect(lockPath).toBe(`${DB_PATH}.lock`);
  });

  test("audits the requested day, passing a single consistent auditedAt", async () => {
    let auditArgs = null;
    await invoke({
      argv: ["/tmp/binance.sqlite", "1970-01-02"],
      audit: (_db, options) => {
        auditArgs = options;
        return CLEAN_REPORT;
      },
    });

    expect(auditArgs).toEqual({ dayStartMs: DAY_MS, auditedAt: 3 * DAY_MS });
  });

  // Exit 2 is what makes this usable from a scheduler: gaps found is a
  // different outcome from the audit itself failing, and both differ from a
  // clean run. Collapsing gaps into exit 0 would let a silent data loss pass
  // a nightly job.
  test("reports detected gaps as exit 2, distinct from success and from failure", async () => {
    const logger = fakeLogger();
    const exitCode = await invoke({
      logger,
      audit: () => ({ ...CLEAN_REPORT, totalGaps: 4 }),
    });

    expect(exitCode).toBe(2);
    expect(logger.calls.error).toHaveLength(1);
    expect(logger.calls.error[0][1]).toMatchObject({ totalGaps: 4 });
    expect(logger.calls.ok).toHaveLength(0);
  });

  test("reports a clean audit as exit 0 with the row count it actually checked", async () => {
    const logger = fakeLogger();
    const exitCode = await invoke({ logger });

    expect(exitCode).toBe(0);
    expect(logger.calls.ok).toHaveLength(1);
    expect(logger.calls.ok[0][1]).toMatchObject({ totalRows: 10, totalGaps: 0 });
    expect(logger.calls.error).toHaveLength(0);
  });

  test("releases the lock and reports exit 1 when the audit itself throws", async () => {
    const order = [];
    const exitCode = await invoke({
      createLock: () => fakeLock(order),
      createDb: () => ({ close: () => order.push("close") }),
      audit: () => {
        throw new Error("ledger unreadable");
      },
    });

    expect(order).toEqual(["acquire", "close", "release"]);
    expect(exitCode).toBe(1);
  });

  test("a lock it could not acquire is never released", async () => {
    const order = [];
    const exitCode = await invoke({
      createLock: () => fakeLock(order, { acquireError: new Error("already locked") }),
      createDb: () => {
        order.push("open");
        return { close: () => order.push("close") };
      },
    });

    expect(order).toEqual(["acquire", "release"]);
    expect(exitCode).toBe(1);
  });

  test("an unparseable day fails before the database is opened", async () => {
    let opened = false;
    const exitCode = await invoke({
      argv: ["/tmp/binance.sqlite", "not-a-day"],
      createDb: () => {
        opened = true;
        return { close: () => {} };
      },
    });

    expect(exitCode).toBe(1);
    expect(opened).toBe(false);
  });
});
