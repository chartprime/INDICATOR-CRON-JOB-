const { createDxFeedStorageDb } = require("../../../src/storage/dxfeed/dxfeed-storage-db");
const { auditOrderBookTransactionContinuityDay } = require("../../../src/storage/dxfeed/dxfeed-gap-audit");
const { listCollectorInstruments } = require("../../../src/providers/dxfeed/dxfeed-instrument-catalog");

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_START = 20 * DAY_MS;

const SNAPSHOT_BEGIN = 4;
const SNAPSHOT_END = 8;
const SNAPSHOT_SNIP = 16;
const TX_PENDING = 1;
const NONE = 0;

function baseRow(overrides = {}) {
  return {
    eventTime: DAY_START + 1000, receivedAt: DAY_START + 1000, provider: "DXFEED", venue: "XCME",
    assetClass: "FUTURE", symbol: "/NQZ26:XCME", stale: 0, recoveryState: "READY",
    orderIndex: "1", eventFlags: SNAPSHOT_BEGIN, time: 1000, action: "NEW", actionTime: 1000,
    orderId: 0, price: 29139.75, size: 7, side: "SELL", scope: "ORDER", source: "GLBX", marketMaker: null,
    ...overrides,
  };
}

function insertRow(storageDb, overrides) {
  storageDb.insert("dxfeed_order_book_capture", baseRow(overrides));
}

describe("auditOrderBookTransactionContinuityDay", () => {
  test("a snapshot that opens and cleanly closes, with no pending transaction left open, is CLEAN", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    insertRow(storageDb, { eventFlags: SNAPSHOT_BEGIN, eventTime: DAY_START + 1000 });
    insertRow(storageDb, { eventFlags: SNAPSHOT_END, eventTime: DAY_START + 2000, orderIndex: "2" });
    insertRow(storageDb, { eventFlags: NONE, eventTime: DAY_START + 3000, orderIndex: "3" });

    const result = auditOrderBookTransactionContinuityDay(storageDb, { dayStartMs: DAY_START });

    expect(result.perPair["/NQZ26:XCME:GLBX"]).toEqual({ rowsChecked: 3, danglingAtDayEnd: false, anchorStatus: "CLEAN", snippedSnapshots: 0 });
    expect(result.interruptedCount).toBe(0);
    storageDb.close();
  });

  // A2.20 / L1L2-V2-035. dxfeed-book-assembler.js has handled SNAPSHOT_SNIP
  // (0x10) since it was written -- a snipped snapshot resets the book to
  // UNAVAILABLE with reason SNIPPED_SNAPSHOT. This audit knew only BEGIN and
  // END, so a SNIP-terminated snapshot left snapshotOpen true forever: the day
  // records INTERRUPTED, and because the continuation scan then runs from that
  // row and never finds a close, so does every following day. A clean capture
  // would be reported as a permanent cut.
  //
  // Latent when found -- (event_flags & 16) is set on zero of the last
  // 3,000,000 capture rows -- which is exactly why two components could
  // disagree about what the flag means without anything failing.
  test("a snapshot terminated by SNIP closes, rather than dangling open forever", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    insertRow(storageDb, { eventFlags: SNAPSHOT_BEGIN, eventTime: DAY_START + 1000 });
    insertRow(storageDb, { eventFlags: SNAPSHOT_SNIP, eventTime: DAY_START + 2000, orderIndex: "2" });
    insertRow(storageDb, { eventFlags: NONE, eventTime: DAY_START + 3000, orderIndex: "3" });

    const result = auditOrderBookTransactionContinuityDay(storageDb, { dayStartMs: DAY_START });

    expect(result.perPair["/NQZ26:XCME:GLBX"].danglingAtDayEnd).toBe(false);
    expect(result.interruptedCount).toBe(0);
    storageDb.close();
  });

  test("a SNIP that also carries the END bit still closes exactly once", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    insertRow(storageDb, { eventFlags: SNAPSHOT_BEGIN, eventTime: DAY_START + 1000 });
    insertRow(storageDb, { eventFlags: SNAPSHOT_SNIP | SNAPSHOT_END, eventTime: DAY_START + 2000, orderIndex: "2" });

    const result = auditOrderBookTransactionContinuityDay(storageDb, { dayStartMs: DAY_START });

    expect(result.perPair["/NQZ26:XCME:GLBX"].danglingAtDayEnd).toBe(false);
    storageDb.close();
  });

  // A SNIP is not a clean end -- the assembler throws the book away when it
  // sees one -- so the day must not be silently indistinguishable from a
  // snapshot that completed normally.
  test("reports how many snipped snapshots it saw, so a snip is visible rather than merely non-dangling", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    insertRow(storageDb, { eventFlags: SNAPSHOT_BEGIN, eventTime: DAY_START + 1000 });
    insertRow(storageDb, { eventFlags: SNAPSHOT_SNIP, eventTime: DAY_START + 2000, orderIndex: "2" });

    const result = auditOrderBookTransactionContinuityDay(storageDb, { dayStartMs: DAY_START });

    expect(result.perPair["/NQZ26:XCME:GLBX"].snippedSnapshots).toBe(1);
    expect(result.snippedCount).toBe(1);
    storageDb.close();
  });

  test("a snapshot begun but never ended by day's end is INTERRUPTED -- a real capture cutoff, not fabricated as clean", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    insertRow(storageDb, { eventFlags: SNAPSHOT_BEGIN, eventTime: DAY_START + 1000 });

    const result = auditOrderBookTransactionContinuityDay(storageDb, { dayStartMs: DAY_START });

    expect(result.perPair["/NQZ26:XCME:GLBX"]).toEqual({ rowsChecked: 1, danglingAtDayEnd: true, anchorStatus: "INTERRUPTED", snippedSnapshots: 0 });
    expect(result.interruptedCount).toBe(1);
    storageDb.close();
  });

  test("a transaction still marked TX_PENDING at the last captured row is INTERRUPTED, even after a completed snapshot", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    insertRow(storageDb, { eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, eventTime: DAY_START + 1000 });
    insertRow(storageDb, { eventFlags: TX_PENDING, eventTime: DAY_START + 2000, orderIndex: "2" });

    const result = auditOrderBookTransactionContinuityDay(storageDb, { dayStartMs: DAY_START });

    expect(result.perPair["/NQZ26:XCME:GLBX"].anchorStatus).toBe("INTERRUPTED");
    storageDb.close();
  });

  test("a later non-pending event closes an earlier TX_PENDING -- not a false INTERRUPTED verdict", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    insertRow(storageDb, { eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, eventTime: DAY_START + 1000 });
    insertRow(storageDb, { eventFlags: TX_PENDING, eventTime: DAY_START + 2000, orderIndex: "2" });
    insertRow(storageDb, { eventFlags: NONE, eventTime: DAY_START + 3000, orderIndex: "3" });

    const result = auditOrderBookTransactionContinuityDay(storageDb, { dayStartMs: DAY_START });

    expect(result.perPair["/NQZ26:XCME:GLBX"].anchorStatus).toBe("CLEAN");
    storageDb.close();
  });

  test("a transaction that crosses UTC midnight is CLEAN once its ordered continuation closes -- midnight is not a capture cutoff", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    insertRow(storageDb, { eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, eventTime: DAY_START + 1000 });
    insertRow(storageDb, { eventFlags: TX_PENDING, eventTime: DAY_START + DAY_MS - 1, orderIndex: "2" });
    insertRow(storageDb, { eventFlags: NONE, eventTime: DAY_START + DAY_MS + 1, orderIndex: "3" });

    const result = auditOrderBookTransactionContinuityDay(storageDb, { dayStartMs: DAY_START });

    expect(result.perPair["/NQZ26:XCME:GLBX"]).toEqual({ rowsChecked: 2, danglingAtDayEnd: false, anchorStatus: "CLEAN", snippedSnapshots: 0 });
    storageDb.close();
  });

  test("a bounded continuation scan remains fail-closed when the transaction cannot be resolved within its configured audit budget", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    insertRow(storageDb, { eventFlags: TX_PENDING, eventTime: DAY_START + DAY_MS - 1, orderIndex: "1" });
    insertRow(storageDb, { eventFlags: TX_PENDING, eventTime: DAY_START + DAY_MS + 1, orderIndex: "2" });
    insertRow(storageDb, { eventFlags: NONE, eventTime: DAY_START + DAY_MS + 2, orderIndex: "3" });

    const result = auditOrderBookTransactionContinuityDay(storageDb, { dayStartMs: DAY_START, maxContinuationRows: 1 });

    expect(result.perPair["/NQZ26:XCME:GLBX"].anchorStatus).toBe("INTERRUPTED");
    storageDb.close();
  });

  test("a pair with zero captured rows that day is NO_DATA, not silently reported as clean", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });

    const result = auditOrderBookTransactionContinuityDay(storageDb, { dayStartMs: DAY_START });

    for (const { symbol, orderSource } of listCollectorInstruments()) {
      expect(result.perPair[`${symbol}:${orderSource}`]).toEqual({ rowsChecked: 0, danglingAtDayEnd: false, anchorStatus: "NO_DATA", snippedSnapshots: 0 });
    }
    expect(result.noDataCount).toBe(listCollectorInstruments().length);
    storageDb.close();
  });

  test("every collector instrument is audited independently -- one pair's interruption never contaminates another's clean verdict", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    insertRow(storageDb, {
      symbol: "/NQZ26:XCME", assetClass: "FUTURE", source: "GLBX", eventFlags: SNAPSHOT_BEGIN, eventTime: DAY_START + 1000,
    });
    insertRow(storageDb, {
      symbol: "/ESZ26:XCME", assetClass: "FUTURE", source: "GLBX", eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END,
      eventTime: DAY_START + 1000, orderIndex: "9",
    });

    const result = auditOrderBookTransactionContinuityDay(storageDb, { dayStartMs: DAY_START });

    expect(result.perPair["/NQZ26:XCME:GLBX"].anchorStatus).toBe("INTERRUPTED");
    expect(result.perPair["/ESZ26:XCME:GLBX"].anchorStatus).toBe("CLEAN");
    storageDb.close();
  });

  test("rows outside the audited day's window are excluded from both sides of the boundary", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    insertRow(storageDb, { eventFlags: SNAPSHOT_BEGIN, eventTime: DAY_START - 1000, orderIndex: "1" }); // yesterday
    insertRow(storageDb, { eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, eventTime: DAY_START + 1000, orderIndex: "2" }); // today
    insertRow(storageDb, { eventFlags: SNAPSHOT_BEGIN, eventTime: DAY_START + DAY_MS + 1000, orderIndex: "3" }); // tomorrow

    const result = auditOrderBookTransactionContinuityDay(storageDb, { dayStartMs: DAY_START });

    expect(result.perPair["/NQZ26:XCME:GLBX"]).toEqual({ rowsChecked: 1, danglingAtDayEnd: false, anchorStatus: "CLEAN", snippedSnapshots: 0 });
    storageDb.close();
  });

  test("durably records the verdict for every instrument, queryable directly from the ledger table", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    insertRow(storageDb, { eventFlags: SNAPSHOT_BEGIN | SNAPSHOT_END, eventTime: DAY_START + 1000 });

    auditOrderBookTransactionContinuityDay(storageDb, { dayStartMs: DAY_START, auditedAt: 5000 });

    const row = storageDb.raw.prepare(
      "SELECT rows_checked, dangling_at_day_end, anchor_status, audited_at FROM dxfeed_order_book_continuity_audits " +
      "WHERE symbol = ? AND asset_class = ? AND source = ? AND day_start = ?",
    ).get("/NQZ26:XCME", "FUTURE", "GLBX", DAY_START);
    expect(row).toEqual({ rows_checked: 1, dangling_at_day_end: 0, anchor_status: "CLEAN", audited_at: 5000 });
    storageDb.close();
  });

  test("rejects a non-day-aligned or negative dayStartMs before touching the database", () => {
    const storageDb = createDxFeedStorageDb({ dbPath: ":memory:" });
    expect(() => auditOrderBookTransactionContinuityDay(storageDb, { dayStartMs: DAY_START + 1 })).toThrow(/dayStartMs/);
    expect(() => auditOrderBookTransactionContinuityDay(storageDb, { dayStartMs: -1 })).toThrow(/dayStartMs/);
    storageDb.close();
  });
});
