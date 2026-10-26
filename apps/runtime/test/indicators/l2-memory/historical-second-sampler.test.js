"use strict";

const { createHistoricalSecondSampler } = require("../../../src/indicators/l2-memory/historical-second-sampler");

const segment = "b".repeat(64);
const config = { derivationId: "a".repeat(64), instrumentId: "ES", tickSize: "1", fromNs: "0", toNs: "4000000000" };
const book = { bids: [{ price: "99", size: "10" }, { price: "97", size: "8" }],
  asks: [{ price: "101", size: "5" }, { price: "103", size: "9" }] };
const at = (ms, position, changes = {}) => ({ sourceKey: [String(ms * 1_000_000), "2", String(position), "0"],
  knownNs: String(ms * 1_000_000), segmentId: segment, ...book, ...changes });
const trade = (ms, side, price, size) => ({ event_ns: String(ms * 1_000_000), side, price, size });
const coverage = (rows) => rows.filter((row) => row.payload.row_kind === "coverage");

test("unknown off-grid equity prints retain volume without inventing price attribution", () => {
  const sampler = createHistoricalSecondSampler({ ...config, tickSize: "0.01" });
  const output = [...sampler.observe(at(0, 0, { trade: trade(0, "UNKNOWN", "101.005000000000", "7") })),
    ...sampler.observe(at(1000, 1)), ...sampler.finish()];
  expect(coverage(output)[0].payload.flow).toEqual({ BUY: 0, SELL: 0, UNKNOWN: 7, count: 1 });
  expect(output.filter((row) => row.payload.row_kind === "level").every((row) =>
    row.payload.buy_volume === 0 && row.payload.sell_volume === 0)).toBe(true);
  for (const [side, price] of [["BUY", "101.005"], ["UNKNOWN", "0"], ["UNKNOWN", "invalid"]]) {
    const invalid = createHistoricalSecondSampler({ ...config, tickSize: "0.01" });
    expect(() => [...invalid.observe(at(0, 0, { trade: trade(0, side, price, "7") }))]).toThrow();
    expect(() => [...invalid.finish()]).toThrow(/failed/);
  }
});

test("half-open seconds separate boundary trades; source sizes, unknown flow and depth remain explicit", () => {
  const sampler = createHistoricalSecondSampler(config);
  const rows = [...sampler.observe(at(0, 0)), ...sampler.observe(at(500, 1, { trade: trade(500, "BUY", "102", "3") })),
    ...sampler.observe(at(500, 2, { trade: trade(500, "UNKNOWN", "101", "4") })),
    ...sampler.observe(at(1000, 3, { trade: trade(1000, "SELL", "96", "2") })),
    ...sampler.observe(at(2000, 4, { knownNs: "2500000000" })), ...sampler.finish()];
  const states = coverage(rows);
  expect(states[0].payload).toMatchObject({ open_ns: "0", close_ns: "1000000000", complete: true,
    flow: { BUY: 3, SELL: 0, UNKNOWN: 4, count: 2 }, bid_range: [97, 99], ask_range: [101, 103] });
  expect(states[1].payload.flow).toEqual({ BUY: 0, SELL: 2, UNKNOWN: 0, count: 1 });
  const within = rows.find((row) => row.payload.close_ns === "1000000000" && row.payload.price_key === 102);
  expect(within.payload).toMatchObject({ bid_size: null, ask_size: 0, buy_volume: 3 });
  const beyond = rows.find((row) => row.payload.close_ns === "2000000000" && row.payload.price_key === 96);
  expect(beyond.payload).toMatchObject({ bid_size: null, ask_size: null, sell_volume: 2 });
  const partial = states.find((row) => row.payload.reason === "FINAL_SOURCE_PREFIX");
  expect(partial).toMatchObject({ known_ns: "2500000000" });
  expect(partial.payload).toMatchObject({ complete: false, close_ns: "2000000001" });
  expect(states.at(-1).payload).toMatchObject({ trusted: false, reason: "TAIL_NOT_VERIFIED" });
});

test("a crossed/unavailable period keeps its trades outside trust and does not mix segment flow", () => {
  const sampler = createHistoricalSecondSampler(config);
  const rows = [...sampler.observe(at(0, 0)), ...sampler.observe(at(100, 1, { trade: trade(100, "BUY", "101", "2") })),
    ...sampler.observe(at(200, 2, { segmentId: null, unavailableReason: "CROSSED_BOOK", trade: trade(200, "BUY", "101", "3") })),
    ...sampler.observe(at(300, 3, { segmentId: "c".repeat(64) })), ...sampler.observe(at(1000, 4, { segmentId: "c".repeat(64) })),
    ...sampler.finish()];
  const states = coverage(rows);
  expect(states[0].payload).toMatchObject({ complete: false, flow: { BUY: 2, count: 1 } });
  expect(states[1].payload).toMatchObject({ trusted: false, outside_trust: { BUY: 3, count: 1 }, flow: { count: 0 } });
  expect(states[2].payload).toMatchObject({ segment_id: "c".repeat(64), complete: false, flow: { count: 0 } });
});

test("a suspected gap never carries the old trusted book across the unknown interval", () => {
  const sampler = createHistoricalSecondSampler(config);
  const rows = [...sampler.observe(at(0, 0)), ...sampler.observe(at(100, 1)),
    ...sampler.observe(at(3000, 2, { segmentId: null, unavailableReason: "SOURCE_GAP_SUSPECTED" })), ...sampler.finish()];
  const states = coverage(rows);
  expect(states[0].payload).toMatchObject({ trusted: true, complete: false, close_ns: "100000001" });
  expect(states.filter((row) => row.payload.complete).every((row) => row.payload.trusted === false)).toBe(true);
  expect(states.find((row) => row.payload.reason === "SOURCE_INTERVAL_UNVERIFIED")).toMatchObject({ known_ns: "3000000000" });
});

test("same-nanosecond reset preserves the old segment's point-prefix trades", () => {
  const sampler = createHistoricalSecondSampler(config);
  const rows = [...sampler.observe(at(0, 0, { trade: trade(0, "BUY", "101", "2") })),
    ...sampler.observe(at(0, 1, { segmentId: "c".repeat(64), trade: trade(0, "SELL", "99", "3") })),
    ...sampler.observe(at(1000, 2, { segmentId: "c".repeat(64) })), ...sampler.finish()];
  expect(coverage(rows)[0].payload).toMatchObject({ point_prefix: true, complete: false, segment_id: segment, flow: { BUY: 2 } });
  expect(coverage(rows)[1].payload).toMatchObject({ point_prefix: false, segment_id: "c".repeat(64), flow: { SELL: 3, BUY: 0 } });
});

test("late first seed and an empty source retain explicit unavailable coverage", () => {
  const sampler = createHistoricalSecondSampler(config);
  const rows = [...sampler.observe(at(500, 0)), ...sampler.finish()];
  expect(coverage(rows)[0].payload).toMatchObject({ trusted: false, close_ns: "500000000", reason: "SEGMENT_BOUNDARY" });
  const empty = createHistoricalSecondSampler(config);
  expect(coverage([...empty.finish()])).toHaveLength(4);
});

test("off-grid prices, crossed books, cursor regression and cancelled iteration poison the partition", () => {
  for (const change of [{ asks: [{ price: "98", size: "5" }] }, { asks: [{ price: "101.5", size: "5" }] },
    { asks: [{ price: "101", size: "1.5" }] }]) {
    const sampler = createHistoricalSecondSampler(config);
    expect(() => [...sampler.observe(at(0, 0, change))]).toThrow();
    expect(() => [...sampler.finish()]).toThrow(/failed/);
  }
  const sampler = createHistoricalSecondSampler(config);
  const interrupted = sampler.observe(at(0, 0));
  interrupted.next();
  interrupted.return();
  expect(() => [...sampler.finish()]).toThrow(/failed/);
  const ordered = createHistoricalSecondSampler(config);
  [...ordered.observe(at(0, 0))];
  expect(() => [...ordered.observe(at(0, 0))]).toThrow(/order/);
});

test("logical rows and IDs repeat exactly; decimal tick geometry is exact", () => {
  function run() {
    const sampler = createHistoricalSecondSampler(config);
    return [...sampler.observe(at(0, 0)), ...sampler.observe(at(1000, 1)), ...sampler.finish()];
  }
  expect(run()).toEqual(run());
  const fractional = createHistoricalSecondSampler({ ...config, tickSize: "0.01" });
  expect(fractional.priceKey("123.450000000000")).toBe(12345);
});

test("late first receipt preserves monotone knowledge and a source-free unknown prefix", () => {
  const sampler = createHistoricalSecondSampler(config);
  const rows = [...sampler.observe(at(1500, 0, { knownNs: "2500000000" })), ...sampler.finish()];
  expect(rows[0]).toMatchObject({ known_ns: "0", known_key: null });
  for (let index = 1; index < rows.length; index += 1) {
    expect(BigInt(rows[index].known_ns) >= BigInt(rows[index - 1].known_ns)).toBe(true);
  }
  const trusted = coverage(rows).filter((row) => row.payload.trusted);
  expect(trusted.every((row) => BigInt(row.known_ns) >= 2_500_000_000n)).toBe(true);
});

test("an observation at the final nanosecond closes once without inventing an unavailable tail", () => {
  const sampler = createHistoricalSecondSampler(config);
  const rows = [...sampler.observe(at(0, 0)), ...sampler.observe({ ...at(0, 1),
    sourceKey: ["3999999999", "2", "1", "0"], knownNs: "3999999999" }), ...sampler.finish()];
  expect(coverage(rows).every((row) => row.payload.trusted && row.payload.complete)).toBe(true);
  expect(rows.filter((row) => row.family === "l2_book_segment" && row.payload.action === "close"
    && row.payload.segment_id === segment)).toHaveLength(1);
  expect(rows.at(-1).payload).toMatchObject({ final: true, boundary_ns: "4000000000" });
});

test("price and integer-flow limits refuse overflow instead of dropping trades", () => {
  const bounded = createHistoricalSecondSampler({ ...config, maxPriceKeysPerSecond: 20 });
  for (let index = 0; index < 20; index += 1) {
    [...bounded.observe(at(0, index, { trade: trade(0, "BUY", String(110 + index), "1") }))];
  }
  expect(() => [...bounded.observe(at(0, 20, { trade: trade(0, "BUY", "200", "1") }))]).toThrow(/budget/);
  expect(() => [...bounded.finish()]).toThrow(/failed/);
  const overflow = createHistoricalSecondSampler(config);
  [...overflow.observe(at(0, 0, { trade: trade(0, "BUY", "101", String(Number.MAX_SAFE_INTEGER)) }))];
  expect(() => [...overflow.observe(at(0, 1, { trade: trade(0, "BUY", "101", "1") }))]).toThrow(/integer range/);
});
