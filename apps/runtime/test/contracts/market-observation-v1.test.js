const { decimal, decimalText, timestamp, fixed9 } = require("../../src/data-contracts/v1/exact");
const { instrument, createIdentityResolver } = require("../../src/data-contracts/v1/identity");
const { createRecord, validateRecord, validateData, quarantine } = require("../../src/data-contracts/v1/record");
const { mapObservation } = require("../../src/data-contracts/v1/adapters");
const { createAuthorityPolicy, selectAuthoritative, createTradeLedger } = require("../../src/data-contracts/v1/authority");
const { decodePinned } = require("./fixtures/market-observation-v1/decode-pinned-dbn");

// Deliberately constructed golden vectors. Not evidence of archive completeness.
const crypto = { venue: "BINANCE", market: "SPOT", symbol: "BTCUSDT", currency: "USDT", sizeUnit: "BASE", contract: null };
const future = { venue: "XCME", market: "FUTURE", symbol: "ESU26", currency: "USD", sizeUnit: "CONTRACT", contract: "ESU26" };
const t = "1788807187569123456";
function context(provider, sourceSymbol, dataset = provider, target = crypto) {
  return { dataset, sourceSymbol, population: "fixture-population", datasetVersion: "fixture-v1", streamId: "fixture-stream", position: "1", ingestNs: t, receiveMs: "1788807187570", lineage: { object: "fixture://golden", sha256: "a".repeat(64), row: "0" }, resolveIdentity: createIdentityResolver([{ provider, dataset, sourceSymbol, fromNs: "0", toNs: "18446744073709551614", instrument: target, mappingVersion: "fixture-map/1", reference: "fixture://identity" }]) };
}
function binance(overrides = {}, ctx = context("BINANCE", "BTCUSDT")) {
  return mapObservation("BINANCE", "trade", { e: "trade", s: "BTCUSDT", T: "1788807187569", t: "9007199254740993", p: "62500.123456789", q: "0.00000001", m: false, ...overrides }, ctx);
}
function mbp(overrides = {}, family = "mbp", ctx = { ...context("DATABENTO", "123", "GLBX.MDP3", future), schema: "mbp-1" }) {
  return mapObservation("DATABENTO", family, { instrument_id: "123", publisher_id: "1", ts_event: t, ts_recv: "1788807187569123500", sequence: "4294967295", action: "T", side: "B", price: "6250123456789", size: "3", flags: "128", bid_px_00: "6250000000000", bid_sz_00: "5", ask_px_00: "6250250000000", ask_sz_00: "7", ...overrides }, ctx);
}
function dx(type = "NEW", index = "9007199254740993", position = "1") {
  const ctx = { ...context("DXFEED", "/ESZ26:XCME", "GLBX", future), position, lineage: { object: "fixture://dx", sha256: "b".repeat(64), row: position } };
  return mapObservation("DXFEED", "trade", { eventType: "TimeAndSale", eventSymbol: "/ESZ26:XCME", time: "1788807187569", timeNanoPart: "123456", sequence: "4", index, type, aggressorSide: "UNDEFINED", validTick: true, eventFlags: "0", price: "6250.25", size: "2" }, ctx);
}

describe("exact values and temporal identity", () => {
  test.each(["0", "-12.3400", "0.000000000000000001", "9007199254740993.125"])("decimal token round-trip %s", value => expect(decimalText(decimal(value))).toBe(value));
  test("nanoseconds survive JSON and provider unit conversion", () => {
    expect(timestamp(JSON.parse(JSON.stringify(t)))).toBe(t);
    expect(timestamp("1788807187569123", "us")).toBe("1788807187569123000");
    expect(() => timestamp(Number(t))).toThrow("UNSAFE_INTEGER");
    expect(() => decimal(0.1)).toThrow("INVALID_DECIMAL");
    expect(() => timestamp("18446744073709551615")).toThrow("INVALID_TIMESTAMP");
    expect(() => fixed9("9223372036854775807")).toThrow("INVALID_DBN_PRICE");
  });
  test("continuous alias resolves at the exact roll boundary; ambiguous and absent mappings fail", () => {
    const base = { provider: "DATABENTO", dataset: "GLBX.MDP3", sourceSymbol: "ES.n.0", mappingVersion: "roll/1", reference: "fixture://definitions" };
    const rows = [{ ...base, fromNs: "1", toNs: "10", instrument: future }, { ...base, fromNs: "10", toNs: "20", instrument: { ...future, symbol: "ESZ26", contract: "ESZ26" } }];
    const resolve = createIdentityResolver(rows);
    expect(resolve({ ...base, eventNs: "9" }).instrument.symbol).toBe("ESU26");
    expect(resolve({ ...base, eventNs: "10" }).instrument.symbol).toBe("ESZ26");
    expect(() => resolve({ ...base, eventNs: "20" })).toThrow("UNRESOLVED_IDENTITY");
    expect(() => createIdentityResolver([rows[0], rows[0]])).toThrow("AMBIGUOUS_MAPPING");
    expect(() => instrument({ ...future, symbol: "ES.n.0", contract: "ES.n.0" })).toThrow("CONTINUOUS_ALIAS_NOT_INSTRUMENT");
  });
});
describe("provider golden mappings", () => {
  test("unmodified public DBN fixtures decode exact quote and trade records", () => {
    const outputs = [];
    for (const name of ["databento-mbp1.dbn", "databento-tbbo.dbn"]) {
      const fixture = decodePinned(name);
      for (const [index, row] of fixture.rows.entries()) {
        const ctx = { ...context("DATABENTO", row.instrument_id, "PUBLIC_FIXTURE", future), schema: name.includes("tbbo") ? "tbbo" : "mbp-1", position: String(index), lineage: { object: `fixture://${name}`, sha256: fixture.sha256, row: String(index) } };
        const result = mapObservation("DATABENTO", "mbp", row, ctx);
        expect(result.ok).toBe(true);
        expect(result.records[0].time.eventNs).toBe(row.ts_event);
        if (row.action === "T") expect(result.records[0].data.price.coefficient).toBe(row.price);
        outputs.push(...result.records);
      }
    }
    expect(outputs.filter(r => r.family === "trade")).toHaveLength(2);
    expect(outputs.filter(r => r.family === "quote")).toHaveLength(4);
    expect(outputs[0].time.eventNs).toBe("1609160400006001487");
  });
  test("dxFeed indexed aggregate removal preserves transaction flags without inventing an order", () => {
    const result = mapObservation("DXFEED", "order", { eventType: "Order", eventSymbol: "/ESZ26:XCME", eventTime: "1788807187569", eventFlags: "3", index: "9007199254740993", source: "GLBX" }, context("DXFEED", "/ESZ26:XCME", "GLBX", future));
    expect(result.ok).toBe(true); expect(result.records[0].data.remove).toBe(true); expect(result.records[0].data.eventFlags).toBe("3"); expect(result.records[0].data.orderId).toBeNull();
  });
  test("Binance exact trade ID, decimal and maker/aggressor inversion", () => {
    const r = binance().records[0];
    expect(r.data.entityId).toBe("9007199254740993");
    expect(decimalText(r.data.price)).toBe("62500.123456789");
    expect(r.time.eventNs).toBe("1788807187569000000");
    expect(r.data.side).toBe("BUY");
    expect(binance({ m: true }).records[0].data.side).toBe("SELL");
    expect(binance({ t: 9007199254740992 }).quarantine.reason).toBe("UNSAFE_INTEGER");
  });
  test("Tardis microseconds and unknown side remain explicit", () => {
    const r = mapObservation("TARDIS", "trade", { exchange: "binance", symbol: "BTCUSDT", timestamp: "1788807187569123", local_timestamp: "1788807187569999", id: "abc-1", side: "unknown", price: "62500.125", amount: "0.01" }, context("TARDIS", "BTCUSDT", "binance"));
    expect(r.ok).toBe(true); expect(r.records[0].time.eventNs).toBe("1788807187569123000");
    expect(r.records[0].data.side).toBe("UNKNOWN");
  });
  test("dxFeed time nano part, correction identity and unknown side", () => {
    const r = dx("CORRECTION").records[0];
    expect(r.time.eventNs).toBe(t); expect(r.data.replaces).toBe("9007199254740993"); expect(r.data.side).toBe("UNKNOWN");
    expect(dx("CANCEL").records[0].data.price).toBeNull();
  });
  // F is a fill of a resting order: a real Databento action that does not itself
  // move the book. A 5,677,364,774-row census of the frozen L1 archive saw only
  // A C F M R T -- F 37 times (ES 1, NQ 4, AAPL 12, TSLA 20) -- and rejecting it
  // stopped the 2025-09-04 AAPL and TSLA conversions. It maps to a quote like the
  // other non-trade actions; emitting a trade would double-count the paired T row.
  test.each(["A", "C", "F", "M", "R"])("Databento %s is a quote observation, never an execution", action => {
    const result = mbp({ action }); expect(result.ok).toBe(true); expect(result.records.map(r => r.family)).toEqual(["quote"]);
    expect(result.records[0].data.sourceAction).toBe(action);
  });
  // N is documented by the provider but absent from this frozen archive, so it
  // stays rejected until a census shows it and a test defines its semantics.
  test.each(["N", "Z", "", "t"])("Databento %s is still refused rather than guessed at", action => {
    expect(mbp({ action }).quarantine.reason).toBe("UNSUPPORTED_MBP_ACTION");
  });
  test("Databento trade plus quote retain exact nanoseconds and fixed-point prices", () => {
    const result = mbp(); expect(result.ok).toBe(true); expect(result.records.map(r => r.family)).toEqual(["trade", "quote"]);
    expect(result.records[0].time.eventNs).toBe(t);
    expect(decimalText(result.records[0].data.price)).toBe("6250.123456789");
    expect(mbp({}, "quote").records[0].id).toBe(result.records[1].id);
  });
  test("undefined book prices are null and are never trades", () => {
    const r = mbp({ action: "R", bid_px_00: "9223372036854775807", ask_px_00: "9223372036854775807" });
    expect(r.records[0].data.bid.price).toBeNull(); expect(r.records).toHaveLength(1);
  });
  test("top ten snapshots retain ten-level fidelity", () => {
    const fields = {}; for (let i = 0; i < 10; i++) for (const s of ["bid", "ask"]) { fields[`${s}_px_${String(i).padStart(2, "0")}`] = "6250000000000"; fields[`${s}_sz_${String(i).padStart(2, "0")}`] = "1"; }
    const r = mbp(fields, "depth", { ...context("DATABENTO", "123", "GLBX.MDP3", future), schema: "mbp-10" });
    expect(r.ok).toBe(true); expect(r.records[0].data.depthLimit).toBe(10); expect(r.records[0].data.model).toBe("TOP_N");
  });
  test("a Binance trade through Tardis carries the exchange trade time, at the precision each market publishes", () => {
    const spot = { exchange: "binance", symbol: "BTCUSDT", timestamp: "1760140799999619", local_timestamp: "1760140800002497", id: "5314998734", side: "sell", price: "113000.01", amount: "0.00012" };
    const perp = { ...spot, exchange: "binance-futures", timestamp: "1760140800025000", local_timestamp: "1760140800028358", id: "6709718101" };
    const s = mapObservation("TARDIS", "trade", spot, context("TARDIS", "BTCUSDT", "binance")).records[0];
    const p = mapObservation("TARDIS", "trade", perp, context("TARDIS", "BTCUSDT", "binance-futures")).records[0];
    expect(s.time).toMatchObject({ eventNs: "1760140799999619000", receiveNs: "1760140800002497000", precision: "us", origin: "EXCHANGE" });
    expect(p.time).toMatchObject({ eventNs: "1760140800025000000", precision: "ms", origin: "EXCHANGE" });
    expect(s.quality.flags).not.toContain("EXCHANGE_OR_PROVIDER_FALLBACK");
    expect(s.data).toMatchObject({ entityId: "5314998734", side: "SELL" });
  });
  test("an exchange time within 50 ms after a lagging receive clock keeps its exchange label and carries a flag", () => {
    const perp = { exchange: "binance-futures", symbol: "BTCUSDT", timestamp: "1760140800025000", local_timestamp: "1760140800028358", id: "1", side: "buy", price: "1", amount: "1" };
    const ctx = context("TARDIS", "BTCUSDT", "binance-futures");
    const ordered = mapObservation("TARDIS", "trade", perp, ctx).records[0];
    expect(ordered.quality.flags).not.toContain("RECEIVE_BEFORE_EXCHANGE_TIME");
    const equal = mapObservation("TARDIS", "trade", { ...perp, local_timestamp: "1760140800025000" }, ctx).records[0];
    expect(equal.quality.flags).not.toContain("RECEIVE_BEFORE_EXCHANGE_TIME");
    for (const local_timestamp of ["1760140800024999", "1760140799975000"]) {
      const lagged = mapObservation("TARDIS", "trade", { ...perp, local_timestamp }, ctx).records[0];
      expect(lagged.time).toMatchObject({ eventNs: "1760140800025000000", receiveNs: `${local_timestamp}000`, precision: "ms", origin: "EXCHANGE" });
      expect(lagged.quality.flags).toContain("RECEIVE_BEFORE_EXCHANGE_TIME");
      expect(lagged.quality.flags).not.toContain("EXCHANGE_OR_PROVIDER_FALLBACK");
    }
  });
  test("an exchange time more than 50 ms after its receive time, or a sub-millisecond perpetual time, is refused rather than labelled", () => {
    const perp = { exchange: "binance-futures", symbol: "BTCUSDT", timestamp: "1760140800025000", local_timestamp: "1760140800028358", id: "1", side: "buy", price: "1", amount: "1" };
    const ctx = context("TARDIS", "BTCUSDT", "binance-futures");
    expect(mapObservation("TARDIS", "trade", { ...perp, local_timestamp: "1760140799974999" }, ctx).quarantine.reason).toBe("EXCHANGE_TIME_AFTER_RECEIVE");
    expect(mapObservation("TARDIS", "trade", { ...perp, timestamp: "1760140800025001" }, ctx).quarantine.reason).toBe("EXCHANGE_TIME_PRECISION_MISMATCH");
    const liquidation = mapObservation("TARDIS", "liquidation", perp, ctx).records[0];
    expect(liquidation.time.origin).toBe("PROVIDER");
    expect(liquidation.quality.flags).toContain("EXCHANGE_OR_PROVIDER_FALLBACK");
  });
  test("Tardis snapshot rows require explicit boundaries, preserving zero-size removal", () => {
    const row = { exchange: "binance", symbol: "BTCUSDT", timestamp: "1788807187569123", local_timestamp: "1788807187569999", is_snapshot: "true", side: "bid", price: "62500", amount: "0" };
    const ctx = context("TARDIS", "BTCUSDT", "binance");
    expect(mapObservation("TARDIS", "depth", row, ctx).quarantine.reason).toBe("BATCH_BOUNDARY_REQUIRED");
    const r = mapObservation("TARDIS", "depth", row, { ...ctx, batchEnd: false, snapshotStart: true, batchId: "batch1" });
    expect(r.records[0].data.reset).toBe(true); expect(r.records[0].data.batchEnd).toBe(false);
    expect(r.records[0].data.bids[0].size.coefficient).toBe("0");
  });
  function ohlcv(overrides = {}, schema = "ohlcv-1s", family = "candle") {
    const ctx = { ...context("DATABENTO", "123", "GLBX.MDP3", future), schema };
    return mapObservation("DATABENTO", family, { instrument_id: "123", ts_event: t, open: "6250000000000", high: "6251000000000", low: "6249000000000", close: "6250500000000", volume: "1234", ...overrides }, ctx);
  }
  test("Databento OHLCV-1s maps to one closed candle with exact fixed-point OHLC and a derived close time", () => {
    const r = ohlcv();
    expect(r.ok).toBe(true); expect(r.records.map(x => x.family)).toEqual(["candle"]);
    const c = r.records[0];
    expect(c.time.eventNs).toBe(t); expect(c.time.origin).toBe("PROVIDER"); expect(c.time.precision).toBe("ns");
    expect(c.data.openNs).toBe(t); expect(c.data.closeNs).toBe((BigInt(t) + 1000000000n).toString());
    expect(decimalText(c.data.open)).toBe("6250.000000000"); expect(decimalText(c.data.close)).toBe("6250.500000000");
    expect(c.data.volume.coefficient).toBe("1234"); expect(c.data.volume.scale).toBe(0);
    expect(c.data.buyVolume).toBeNull(); expect(c.data.closed).toBe(true); expect(c.data.method).toBe("databento-ohlcv-1s/1");
    expect(c.order.sequence).toBeNull(); expect(c.time.receiveNs).toBeNull();
  });
  test("Databento OHLCV-1m derives a 60-second close time and its own method tag", () => {
    const c = ohlcv({}, "ohlcv-1m").records[0];
    expect(c.data.closeNs).toBe((BigInt(t) + 60000000000n).toString()); expect(c.data.method).toBe("databento-ohlcv-1m/1");
  });
  test("Databento OHLCV-1h derives a 3600-second close time and its own method tag", () => {
    const c = ohlcv({}, "ohlcv-1h").records[0];
    expect(c.data.closeNs).toBe((BigInt(t) + 3600000000000n).toString()); expect(c.data.method).toBe("databento-ohlcv-1h/1");
  });
  test("Databento OHLCV-1d derives a UTC-day close time and its own method tag", () => {
    const c = ohlcv({}, "ohlcv-1d").records[0];
    expect(c.data.closeNs).toBe((BigInt(t) + 86400000000000n).toString()); expect(c.data.method).toBe("databento-ohlcv-1d/1");
  });
  test("OHLCV only maps to the candle family; other families and inconsistent OHLC quarantine", () => {
    expect(ohlcv({}, "ohlcv-1s", "trade").quarantine.reason).toBe("OHLCV_MAPS_TO_CANDLE_ONLY");
    expect(ohlcv({ low: "6252000000000" }).quarantine.reason).toBe("INVALID_OHLC");
    expect(mbp({}, "mbp", { ...context("DATABENTO", "123", "GLBX.MDP3", future), schema: "ohlcv-5m" }).quarantine.reason).toBe("DECODED_DATABENTO_SCHEMA_REQUIRED");
  });
  test("an inherited Object property name is not a schema", () => {
    // The interval table is looked up by schema name. Held as a plain object it
    // would inherit Object.prototype, so "constructor" or "toString" would read
    // back a truthy value and be treated as a real OHLCV resolution.
    for (const schema of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(ohlcv({}, schema).quarantine.reason).toBe("DECODED_DATABENTO_SCHEMA_REQUIRED");
    }
  });
});
describe("authority, deduplication and correction semantics", () => {
  const base = () => binance().records[0];
  function policy(r) { return createAuthorityPolicy([{ instrumentId: r.instrument.id, family: r.family, population: r.source.population, fromNs: "0", toNs: "18446744073709551614", provider: r.source.provider, dataset: r.source.dataset, schema: r.source.schema, datasetVersion: r.source.datasetVersion, methodVersion: r.source.methodVersion, policyVersion: "authority/1" }]); }
  test("one selected source wins overlapping populations; missing winner is not substituted", () => {
    const a = base(); const b = createRecord({ ...a, source: { ...a.source, provider: "TARDIS" } }); const p = policy(a);
    expect(selectAuthoritative([b, a, a], p).records).toEqual([a]);
    expect(selectAuthoritative([a, b], p).records).toEqual(selectAuthoritative([b, a], p).records);
    expect(selectAuthoritative([b], p).records).toEqual([]);
    expect(() => p(createRecord({ ...a, source: { ...a.source, population: "different-venue" } }))).toThrow("NO_AUTHORITY_FOR_INTERVAL");
  });
  test("conflicting duplicate and bounded batch fail instead of choosing arbitrarily", () => {
    const a = base(), b = structuredClone(a); b.data.price = decimal("1");
    expect(() => selectAuthoritative([a, b], policy(a))).toThrow("CONFLICTING_DUPLICATE");
    expect(() => selectAuthoritative([a, a], policy(a), { maxRecords: 1 })).toThrow("BATCH_LIMIT_EXCEEDED");
  });
  test("authority pins extraction schema; ambiguous overlap rules fail", () => {
    const a = base(); const b = createRecord({ ...a, source: { ...a.source, schema: "other-trade-projection" } });
    expect(selectAuthoritative([a, b], policy(a)).records).toEqual([a]);
    const rule = { instrumentId: a.instrument.id, family: a.family, population: a.source.population, provider: a.source.provider, dataset: a.source.dataset, schema: a.source.schema, datasetVersion: a.source.datasetVersion, methodVersion: a.source.methodVersion, policyVersion: "1", fromNs: "1", toNs: "10" };
    expect(() => createAuthorityPolicy([rule, { ...rule, fromNs: "9", toNs: "20" }])).toThrow("AMBIGUOUS_AUTHORITY");
    expect(() => createAuthorityPolicy([rule, { ...rule, fromNs: "10", toNs: "20" }])).not.toThrow();
  });
  test("NEW -> CORRECTION -> CANCEL does not add three trades", () => {
    const ledger = createTradeLedger(); ledger.apply(dx("NEW", "1", "1").records[0]);
    const correction = dx("CORRECTION", "1", "2").records[0]; correction.data.size = decimal("5"); ledger.apply(correction);
    expect(ledger.snapshot()).toHaveLength(1); expect(ledger.snapshot()[0].data.size.coefficient).toBe("5");
    ledger.apply(dx("CANCEL", "1", "3").records[0]); expect(ledger.snapshot()).toEqual([]);
    expect(() => ledger.apply(dx("CORRECTION", "2", "4").records[0])).toThrow("ORPHAN_CORRECTION");
  });
  test("ledger rejects backwards capture positions without mutating state", () => {
    const ledger = createTradeLedger(); ledger.apply(dx("NEW", "1", "2").records[0]);
    expect(() => ledger.apply(dx("CANCEL", "1", "1").records[0])).toThrow("NON_MONOTONIC_CAPTURE_POSITION"); expect(ledger.snapshot()).toHaveLength(1);
  });
});
describe("family contracts and quarantine", () => {
  test("ordinary OHLCV retains unknown buy volume, never all-sell delta", () => {
    const bar = { openNs: "1", closeNs: "2", open: decimal("2"), high: decimal("3"), low: decimal("1"), close: decimal("2"), volume: decimal("10"), buyVolume: null, closed: true, method: "provider-ohlcv/1" };
    expect(() => validateData("candle", bar)).not.toThrow();
    expect(() => validateData("candle", { ...bar, buyVolume: decimal("11") })).toThrow("INVALID_BUY_VOLUME");
  });
  test.each([
    ["order", { index: "9007199254740993", source: "GLBX", scope: "AGGREGATE", action: "REMOVE", eventFlags: "2", side: "UNKNOWN", remove: true, price: null, size: null, orderId: null }],
    ["derivative", { fundingRate: decimal("-0.001"), markPrice: null, indexPrice: null, openInterest: null, fundingTimeNs: null }],
    ["reference", { validFromNs: "1", validToNs: "2", referenceVersion: "1", sourceSymbol: "ESU26", tickSize: decimal("0.25"), multiplier: decimal("50") }],
    ["status", { code: "HALTED", scope: "VENUE" }],
    ["statistic", { name: "OPEN_INTEREST", value: decimal("10"), unit: "CONTRACT", updateAction: "SET" }],
  ])("validates %s without collapsing its meaning", (family, payload) => expect(() => validateData(family, payload)).not.toThrow());
  test("bad input produces lineage-bearing quarantine; programming failures remain visible", () => {
    const result = binance({ p: "NaN" }); expect(result.records).toEqual([]); expect(result.quarantine.reason).toBe("INVALID_DECIMAL"); expect(result.quarantine.lineage.sha256).toBe("a".repeat(64));
    expect(() => quarantine(() => { throw new Error("programmer failure"); }, null)).toThrow("programmer failure");
    const bad = binance().records[0]; delete bad.source; expect(() => validateRecord(bad)).toThrow("MISSING_ENVELOPE_FIELD");
  });
});
describe("Binance monthly kline archives", () => {
  // Field values are the real first bars of the September 2025 BTCUSDT monthly
  // klines. Spot publishes microseconds with no header row; USDs-M publishes
  // milliseconds with one. Close times are inclusive in both, which is what
  // makes the bar's own span identify its unit instead of its magnitude.
  function kline(overrides = {}, schema = "klines-1m") {
    const ctx = { ...context("BINANCE", "BTCUSDT"), schema };
    return mapObservation("BINANCE", "candle", {
      open_time: "1756684800000", open: "108208.40", high: "108221.40", low: "108168.70",
      close: "108221.40", volume: "87.806", close_time: "1756684859999",
      quote_volume: "9499660.71900", count: "2278", taker_buy_volume: "28.216",
      taker_buy_quote_volume: "3053808.85", ignore: "0", ...overrides,
    }, ctx);
  }
  const SPOT_US = {
    open_time: "1756684800000000", close_time: "1756684859999999",
    open: "108246.36000000", high: "108260.00000000", low: "108210.66000000",
    close: "108260.00000000", volume: "15.88924000", quote_volume: "1719711.24871140",
    count: "2717", taker_buy_volume: "3.23174000", taker_buy_quote_volume: "349930.63",
  };

  test("a millisecond futures bar becomes one closed canonical candle", () => {
    const r = kline();
    expect(r.ok).toBe(true);
    const c = r.records[0];
    expect(c.family).toBe("candle");
    expect(c.time.precision).toBe("ms");
    expect(c.data.closeNs).toBe((BigInt(c.data.openNs) + 60000000000n).toString());
    expect(c.data.closed).toBe(true);
    expect(c.data.method).toBe("binance-klines-1m/1");
    expect(decimalText(c.data.takerSellBaseVolume)).toBe("59.590");
    expect(c.data.tradeCount).toBe("2278");
  });

  test("a microsecond spot bar becomes the same shape without being told its unit", () => {
    const c = kline(SPOT_US).records[0];
    expect(c.time.precision).toBe("us");
    expect(c.data.closeNs).toBe((BigInt(c.data.openNs) + 60000000000n).toString());
    expect(decimalText(c.data.takerSellBaseVolume)).toBe("12.65750000");
  });

  test("a span matching neither clock is refused rather than guessed", () => {
    expect(kline({ close_time: "1756684859998" }).quarantine.reason).toBe("BINANCE_KLINE_INTERVAL_MISMATCH");
    expect(kline({}, "klines-1h").quarantine.reason).toBe("BINANCE_KLINE_INTERVAL_MISMATCH");
    expect(kline({ close_time: "1756771199999" }, "klines-1d").ok).toBe(true);
  });

  test("taker volume above the total it is part of is a corrupt row, not a clamp", () => {
    expect(kline({ taker_buy_volume: "87.807" }).quarantine.reason).toBe("TAKER_BUY_EXCEEDS_VOLUME");
    expect(kline({ taker_buy_quote_volume: "9499660.71901" }).quarantine.reason)
      .toBe("TAKER_BUY_EXCEEDS_QUOTE_VOLUME");
    expect(kline({ quote_volume: "-1" }).quarantine.reason).toBe("NEGATIVE_QUOTE_VOLUME");
    expect(kline({ taker_buy_quote_volume: "-1" }).quarantine.reason)
      .toBe("NEGATIVE_TAKER_BUY_QUOTE_VOLUME");
    expect(kline({ count: "-1" }).quarantine.reason).toBe("NEGATIVE_TRADE_COUNT");
    expect(kline({ count: "9223372036854775808" }).quarantine.reason).toBe("TRADE_COUNT_OUT_OF_RANGE");
    expect(kline({ taker_buy_volume: "87.806" }).ok).toBe(true);
  });

  test("the live Binance mapping is untouched by the archive branch", () => {
    const live = binance();
    expect(live.ok).toBe(true);
    expect(live.records[0].family).toBe("trade");
    expect(live.records[0].time.precision).toBe("ms");
    expect(binance({}, { ...context("BINANCE", "BTCUSDT") }).ok).toBe(true);
  });
});
