"use strict";

const { createContractService, MAX_BATCH_ROWS } = require("../../src/conversion/contract-service");

const T = "1788807187569123456";
const aapl = { venue: "XNAS", market: "EQUITY", symbol: "AAPL", currency: "USD", sizeUnit: "SHARE", contract: null };
const tsla = { ...aapl, symbol: "TSLA" };
const mappingsFor = (instrument, sourceSymbol = "38") => [{
  provider: "DATABENTO", dataset: "XNAS.ITCH", sourceSymbol,
  fromNs: "0", toNs: "18446744073709551614", instrument,
  mappingVersion: "fixture/1", reference: "fixture://identity",
}];

const baseContext = {
  mappings: mappingsFor(aapl), dataset: "XNAS.ITCH", sourceSymbol: "38",
  population: "XNAS.ITCH:mbp-1", datasetVersion: "v1", streamId: "stream/1",
  schema: "mbp-1", ingestNs: T, lineage: { object: "s3://raw/x.dbn.zst", sha256: "a".repeat(64) },
};

const mbpRow = {
  instrument_id: "38", publisher_id: "1", ts_event: T, ts_recv: "1788807187569123500",
  sequence: "42", action: "T", side: "B", price: "195123456789", size: "10", flags: "0",
  bid_px_00: "195120000000", bid_sz_00: "5", ask_px_00: "195130000000", ask_sz_00: "7",
};
const ohlcvRow = { instrument_id: "38", ts_event: T, open: "195000000000", high: "195500000000", low: "194900000000", close: "195200000000", volume: "8123" };

const req = (overrides = {}) => ({
  batchId: "b1", provider: "DATABENTO", family: "mbp",
  rows: [{ row: mbpRow, position: 0 }], context: baseContext, ...overrides,
});

describe("contract-service", () => {
  test("maps a Databento mbp batch, echoes batchId, preserves row count", () => {
    const svc = createContractService();
    const out = svc.handle(req());
    expect(out.batchId).toBe("b1");
    expect(out.results).toHaveLength(1);
    expect(out.results[0].ok).toBe(true);
    expect(out.results[0].records.map((r) => r.family)).toEqual(["trade", "quote"]);
    expect(out.results[0].records[0].time.eventNs).toBe(T);
  });

  test("per-row: position drives lineage.row and order.position", () => {
    const svc = createContractService();
    const out = svc.handle(req({ rows: [{ row: mbpRow, position: 0 }, { row: mbpRow, position: 7 }] }));
    expect(out.results).toHaveLength(2);
    expect(out.results[1].records[0].lineage.row).toBe("7");
    expect(out.results[1].records[0].order.position).toBe("7");
    expect(out.results[0].records[0].id).not.toBe(out.results[1].records[0].id);
  });

  test("an explicit lineage row names the row inside its own file while position keeps the stream's arrival order", () => {
    const svc = createContractService();
    const out = svc.handle(req({ rows: [{ row: mbpRow, position: 9000000001, lineageRow: 1 }, { row: mbpRow, position: 9000000002 }] }));
    expect(out.results[0].records[0].lineage.row).toBe("1");
    expect(out.results[0].records[0].order.position).toBe("9000000001");
    expect(out.results[1].records[0].lineage.row).toBe("9000000002");
    const bad = svc.handle(req({ rows: [{ row: mbpRow, position: 0, lineageRow: "x" }] }));
    expect(bad.results[0].ok).toBe(false);
  });

  test("a bad row is quarantined in place; the good row still maps; length is preserved", () => {
    const svc = createContractService();
    const out = svc.handle(req({ rows: [
      { row: mbpRow, position: 0 },
      { row: { ...mbpRow, action: "Z" }, position: 1 },
    ] }));
    expect(out.results).toHaveLength(2);
    expect(out.results[0].ok).toBe(true);
    expect(out.results[1].ok).toBe(false);
    expect(out.results[1].quarantine.reason).toBe("UNSUPPORTED_MBP_ACTION");
    expect(out.results[1].quarantine.lineage.row).toBe("1");
  });

  // The shape that stopped L1 on 2025-09-04: interleaved F fills among ordinary
  // rows, 2 for AAPL and 3 for TSLA (raw positions 3,622,428/430/432). Before the
  // allowlist fix every one of these quarantined and aborted the whole symbol.
  test.each([
    ["AAPL", aapl, 2],
    ["TSLA", tsla, 3],
  ])("%s F fills map to quotes instead of aborting the symbol", (symbol, instrument, fills) => {
    const svc = createContractService();
    const rows = [{ row: mbpRow, position: 0 }];
    for (let i = 0; i < fills; i += 1) {
      rows.push({ row: { ...mbpRow, action: "F", sequence: String(3622428 + i * 2) }, position: 1 + i });
    }
    const out = svc.handle(req({ rows, context: { ...baseContext, mappings: mappingsFor(instrument) } }));

    expect(out.results).toHaveLength(1 + fills);
    expect(out.results.every((r) => r.ok)).toBe(true);
    const fillResults = out.results.slice(1);
    for (const result of fillResults) {
      expect(result.records.map((r) => r.family)).toEqual(["quote"]);
      expect(result.records[0].data.sourceAction).toBe("F");
      expect(result.records[0].instrument.symbol).toBe(symbol);
    }
    expect(out.results[0].records.map((r) => r.family)).toEqual(["trade", "quote"]);
  });

  test("routes an ohlcv batch to the candle family", () => {
    const svc = createContractService();
    const out = svc.handle(req({
      family: "candle",
      rows: [{ row: ohlcvRow, position: 0 }],
      context: { ...baseContext, schema: "ohlcv-1s", population: "XNAS.ITCH:ohlcv-1s" },
    }));
    expect(out.results[0].ok).toBe(true);
    expect(out.results[0].records.map((r) => r.family)).toEqual(["candle"]);
    expect(out.results[0].records[0].data.closeNs).toBe((BigInt(T) + 1000000000n).toString());
  });

  test("the identity resolver is reused across calls but tracks a changed mapping set", () => {
    const svc = createContractService();
    const a = svc.handle(req());
    const b = svc.handle(req({ batchId: "b2" }));
    expect(a.results[0].records[0].instrument.id).toBe(b.results[0].records[0].instrument.id);
    const c = svc.handle(req({
      batchId: "b3",
      context: { ...baseContext, mappings: mappingsFor(tsla) },
    }));
    expect(c.results[0].records[0].instrument.symbol).toBe("TSLA");
  });

  test("job-level failures throw rather than quarantining every row", () => {
    const svc = createContractService();
    expect(() => svc.handle(req({ rows: "nope" }))).toThrow("ROWS_NOT_ARRAY");
    expect(() => svc.handle(req({ batchId: "" }))).toThrow("MISSING_BATCH_ID");
    expect(() => svc.handle(req({ context: { ...baseContext, mappings: undefined } }))).toThrow("MISSING_MAPPINGS");
    expect(() => svc.handle(req({ context: { ...baseContext, ingestNs: "abc" } }))).toThrow();
    expect(() => svc.handle(req({ rows: [] }))).toThrow("BATCH_ROW_COUNT");
    const many = Array.from({ length: MAX_BATCH_ROWS + 1 }, (_, i) => ({ row: mbpRow, position: i }));
    expect(() => svc.handle(req({ rows: many }))).toThrow("BATCH_ROW_COUNT");
    expect(() => svc.handle(req({ rows: [{ position: 0 }] }))).toThrow("MALFORMED_ROW_ENTRY");
  });
});
