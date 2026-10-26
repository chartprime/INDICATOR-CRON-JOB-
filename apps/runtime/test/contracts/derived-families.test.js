const { createIdentityResolver } = require("../../src/data-contracts/v1/identity");
const { validateData, createRecord, DERIVED_FAMILIES, DERIVED_INTERVAL_NS } = require("../../src/data-contracts/v1/record");
const { mapObservation } = require("../../src/data-contracts/v1/adapters");
const { createContractService } = require("../../src/conversion/contract-service");

// Report 54 Phase 1: the four trade-derived families are contract families
// like every other record. Rows arrive from the Python stage as plain decimal
// strings; the contract turns them into exact decimals and refuses anything
// that is not a well-formed aggregate of executions.
const future = { venue: "XCME", market: "FUTURE", symbol: "ESU6", currency: "USD", sizeUnit: "CONTRACT", contract: "ESU6" };
const MINUTE = 60000000000n;
const OPEN = "1785850200000000000";
const SOURCE_SHA = "c".repeat(64);

function context(family, overrides = {}) {
  const mapping = { provider: "DATABENTO", dataset: "GLBX.MDP3", sourceSymbol: "ESU6", fromNs: "0", toNs: "18446744073709551614", instrument: future, mappingVersion: "derived-from-trade/1", reference: `curated:${SOURCE_SHA}` };
  return {
    dataset: "GLBX.MDP3", sourceSymbol: "ESU6", population: "GLBX.MDP3:mbp-1", datasetVersion: "w606-l1agg-v1-glbx-mdp3-es-2026-08",
    streamId: `derived:trade:${family}`, schema: `${family}/1`, position: "7", ingestNs: "1790000000000000000",
    lineage: { object: `curated://trade/${SOURCE_SHA}`, sha256: SOURCE_SHA, row: "7" },
    resolveIdentity: createIdentityResolver([mapping]), ...overrides,
  };
}

const ROWS = {
  trade_minute: { source_symbol: "ESU6", open_ns: OPEN, ordinal: "0", volume: "42", buy_volume: "23", sell_volume: "19", undefined_volume: "0", buy_notional: "176005.5", sell_notional: "145453.25", trade_count: "318" },
  trade_level: { source_symbol: "ESU6", open_ns: OPEN, ordinal: "3", tick_size: "0.25", price_bucket: "30630", volume: "5", buy_volume: "2", sell_volume: "2", trade_count: "4" },
  trade_slice: { source_symbol: "ESU6", open_ns: OPEN, ordinal: "0", last_trade_ns: "1785850201999999999", buy_notional: "7657.5", sell_notional: "0", trade_count: "1" },
  trade_prints: { source_symbol: "ESU6", open_ns: OPEN, ordinal: "5", side: "SELL", rank: "2", trade_ns: "1785850230123456789", price: "7657.25", size: "40", trade_entity_id: "raw:" + "a".repeat(64) + ":91" },
};

function map(family, overrides = {}, ctx = context(family)) {
  return mapObservation("DATABENTO", family, { ...ROWS[family], ...overrides }, ctx);
}

describe("derived families map through the contract", () => {
  test.each(DERIVED_FAMILIES)("%s maps to an exact, grid-aligned record whose ordinal is the in-bucket index", family => {
    const result = map(family);
    expect(result.ok).toBe(true);
    const [record] = result.records;
    expect(record.family).toBe(family);
    expect(record.time.eventNs).toBe(OPEN);
    expect(record.time.precision).toBe("ns");
    expect(record.time.origin).toBe("EXCHANGE");
    expect(record.order.ordinal).toBe(ROWS[family].ordinal);
    expect(record.order.position).toBe("7");
    expect(record.data.openNs).toBe(OPEN);
    expect(BigInt(record.data.closeNs) - BigInt(record.data.openNs)).toBe(DERIVED_INTERVAL_NS[family]);
    expect(record.data.method).toBe(`${family}/1`);
    expect(record.instrument.id).toBe(JSON.stringify(["XCME", "FUTURE", "ESU6", "USD", "CONTRACT"]));
    expect(record.lineage.sha256).toBe(SOURCE_SHA);
  });

  test("decimals stay exact: coefficient and scale, never a float", () => {
    const minute = map("trade_minute").records[0].data;
    expect(minute.buyNotional).toEqual({ coefficient: "1760055", scale: 1 });
    expect(minute.sellNotional).toEqual({ coefficient: "14545325", scale: 2 });
    const level = map("trade_level").records[0].data;
    expect(level.tickSize).toEqual({ coefficient: "25", scale: 2 });
    expect(level.priceBucket).toBe("30630");
    const prints = map("trade_prints").records[0].data;
    expect(prints.price).toEqual({ coefficient: "765725", scale: 2 });
    expect(prints.rank).toBe("2");
  });

  test("record ids are deterministic and distinct across families, buckets and positions", () => {
    const a = map("trade_minute").records[0].id;
    expect(map("trade_minute").records[0].id).toBe(a);
    expect(map("trade_level").records[0].id).not.toBe(a);
    expect(map("trade_minute", { open_ns: (BigInt(OPEN) + MINUTE).toString() }, context("trade_minute", { position: "8", lineage: { object: "curated://x", sha256: SOURCE_SHA, row: "8" } })).records[0].id).not.toBe(a);
    expect(map("trade_minute", { ordinal: "1" }).records[0].id).not.toBe(a);
  });

  test("the row is bound to its source: schema, provider and symbol must match the context", () => {
    expect(map("trade_minute", {}, context("trade_minute", { schema: "trade_level/1" })).quarantine.reason).toBe("DERIVED_SCHEMA_MISMATCH");
    expect(map("trade_minute", { source_symbol: "NQU6" }).quarantine.reason).toBe("SOURCE_IDENTITY_MISMATCH");
    expect(mapObservation("DXFEED", "trade_minute", ROWS.trade_minute, context("trade_minute")).quarantine.reason).toBe("UNSUPPORTED_DERIVED_SOURCE_PROVIDER");
  });
  test.each(DERIVED_FAMILIES)("Tardis %s maps successfully with the crypto source identity", family => {
    const instrument = { venue: "BINANCE", market: "PERPETUAL", symbol: "BTCUSDT", currency: "USDT", sizeUnit: "COIN", contract: null };
    const mapping = { provider: "TARDIS", dataset: "binance-futures", sourceSymbol: "BTCUSDT", fromNs: "0", toNs: "18446744073709551614", instrument, mappingVersion: "derived-from-trade/1", reference: `curated:${SOURCE_SHA}` };
    const ctx = context(family, { dataset: "binance-futures", sourceSymbol: "BTCUSDT", population: "binance-futures:trades", resolveIdentity: createIdentityResolver([mapping]) });
    const result = mapObservation("TARDIS", family, { ...ROWS[family], source_symbol: "BTCUSDT" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.records[0].instrument).toMatchObject(instrument);
    expect(result.records[0].source.provider).toBe("TARDIS");
    expect(result.records[0].family).toBe(family);
  });
});

describe("derived family invariants refuse", () => {
  const cases = [
    ["trade_minute", { volume: "41" }, "SIDE_VOLUMES_DO_NOT_SUM_TO_VOLUME"],
    ["trade_minute", { volume: "43" }, "SIDE_VOLUMES_DO_NOT_SUM_TO_VOLUME"],
    ["trade_minute", { undefined_volume: "-1", volume: "41" }, "NEGATIVE_QUANTITY"],
    ["trade_minute", { trade_count: "0" }, "EMPTY_BUCKET"],
    ["trade_minute", { open_ns: "1785850200000000001" }, "BUCKET_NOT_GRID_ALIGNED"],
    ["trade_minute", { buy_notional: "1.5e3" }, "INVALID_DECIMAL"],
    ["trade_level", { buy_volume: "4", sell_volume: "2" }, "SIDE_VOLUMES_EXCEED_VOLUME"],
    ["trade_level", { tick_size: "0" }, "INVALID_TICK_SIZE"],
    ["trade_level", { price_bucket: "30630.5" }, "INVALID_INTEGER"],
    ["trade_level", { trade_count: "0" }, "EMPTY_BUCKET"],
    ["trade_slice", { last_trade_ns: "1785850202000000000" }, "LAST_TRADE_OUTSIDE_SLICE"],
    ["trade_slice", { last_trade_ns: "1785850199999999999" }, "LAST_TRADE_OUTSIDE_SLICE"],
    ["trade_slice", { open_ns: "1785850201000000000" }, "BUCKET_NOT_GRID_ALIGNED"],
    ["trade_prints", { side: "UNKNOWN" }, "INVALID_SIDE"],
    ["trade_prints", { rank: "0" }, "INVALID_PRINT_RANK"],
    ["trade_prints", { rank: "65" }, "INVALID_PRINT_RANK"],
    ["trade_prints", { trade_ns: "1785850260000000000" }, "PRINT_OUTSIDE_BUCKET"],
    ["trade_prints", { size: "0" }, "EMPTY_PRINT"],
    ["trade_prints", { trade_entity_id: "" }, "INVALID_TOKEN"],
  ];
  test.each(cases)("%s with %j is refused as %s", (family, overrides, reason) => {
    const result = map(family, overrides);
    expect(result.ok).toBe(false);
    expect(result.quarantine.reason).toBe(reason);
  });

  test("validateData enforces the interval from the family, not from the row", () => {
    const record = map("trade_slice").records[0];
    expect(() => validateData("trade_slice", { ...record.data, closeNs: (BigInt(record.data.openNs) + MINUTE).toString() })).toThrow("INVALID_BUCKET_INTERVAL");
    expect(() => createRecord({ ...record, data: { ...record.data, method: "" } })).toThrow("INVALID_TOKEN");
  });
});

describe("the contract service maps derived batches like any other", () => {
  test("a batch of minute rows returns validated records with the batch id", () => {
    const service = createContractService();
    const ctx = context("trade_minute");
    const response = service.handle({
      batchId: "job:2026-08-04:ESU6:trade_minute:0",
      provider: "DATABENTO", family: "trade_minute",
      rows: [{ position: "0", row: ROWS.trade_minute }, { position: "1", row: { ...ROWS.trade_minute, open_ns: (BigInt(OPEN) + MINUTE).toString() } }],
      context: {
        mappings: [{ provider: "DATABENTO", dataset: "GLBX.MDP3", sourceSymbol: "ESU6", fromNs: "0", toNs: "18446744073709551614", instrument: future, mappingVersion: "derived-from-trade/1", reference: `curated:${SOURCE_SHA}` }],
        dataset: ctx.dataset, sourceSymbol: ctx.sourceSymbol, population: ctx.population, datasetVersion: ctx.datasetVersion,
        streamId: ctx.streamId, schema: ctx.schema, ingestNs: ctx.ingestNs, lineage: { object: ctx.lineage.object, sha256: SOURCE_SHA },
      },
    });
    expect(response.batchId).toBe("job:2026-08-04:ESU6:trade_minute:0");
    expect(response.results.map(r => r.ok)).toEqual([true, true]);
    expect(response.results[1].records[0].lineage.row).toBe("1");
    expect(response.results[0].records[0].id).not.toBe(response.results[1].records[0].id);
  });
});
