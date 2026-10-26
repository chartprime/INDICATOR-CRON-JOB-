const fs = require("fs");
const path = require("path");
const frames = require("../../src/server/exhaustion-frames");
const monitorFrames = require("../../src/server/candle-monitor-frames");
const { VALUE_CAP, RAW_CAP, RAW_KEYS, CANDLE_MS } = require("../../src/indicators/exhaustion/exhaustion-engine");
const { frameKindOf, FRAME_KIND_INCREMENTAL } = require("../../src/server/frames");
const { CAPABILITY_FLAGS } = require("../../src/server/l2-frames");

const SCHEMA_PATH = path.resolve(__dirname, "../../../../docs/contracts/ws-frame-contract/v1/ws-frame-contract-v1.schema.json");
const SERVER_PATH = path.resolve(__dirname, "../../src/server/exhaustion-frames.js");
const CLIENT_PATH = path.resolve(__dirname, "../../../web/src/types/frames.ts");
const readSchema = () => JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
const identityKeys = new Set(["type", "symbol", "provider", "marketKind", "assetClass"]);

function readNumericConstant(source, name) {
  const match = source.match(new RegExp(`\\bconst ${name}\\s*=\\s*([0-9_]+)`));
  return match ? Number(match[1].replace(/_/g, "")) : null;
}

function readSetConstant(source, name) {
  const match = source.match(new RegExp(`\\bconst ${name}[^=]*=\\s*(?:new Set\\()?(?:Object\\.freeze\\()?\\[([^\\]]*)\\]`));
  return match ? match[1].split(",").map((part) => part.trim().replace(/^"|"$/g, "")).filter(Boolean).map((part) => (/^[0-9_]+$/.test(part) ? Number(part.replace(/_/g, "")) : part)) : null;
}

const identity = { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" };
const built = frames.exhaustionShadesFrame(identity, {
  ts: 1_700_000_300_000, seq: 2, reset: false, liveSince: 1_699_990_000_000, shades: [
    { id: "60000|buyers|1700000040000", candleMs: 60_000, side: "buyers", status: "held", intensity: 2, score: 4, readings: { rate: true, progress: true, delta: true, divergence: false, prints: true, book: false }, values: { rate: 0.3, progress: 0.2, delta: -0.25, divergence: 0.1, prints: 0.2, book: 0.95 }, raw: { own: 3, other: 7, legOwn: 14.222, moved: 0, legMoved: 1.778, big: 0, legBig: 0, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 }, startTs: 1_700_000_040_000, endTs: 1_700_000_100_000, extremeTs: 1_699_999_980_000, extremePrice: 31188.25, legStartTs: 1_699_999_800_000, legStartPrice: 31170, legSize: 18.25, efficiency: 0.8, atr: 3.25, judgedAt: 1_700_000_280_000, updatedAt: 1_700_000_280_000, origin: "runtime" },
    { id: "300000|sellers|1700000100000", candleMs: 300_000, side: "sellers", status: "open", intensity: 1, score: 3, readings: { rate: false, progress: false, delta: true, divergence: true, prints: true, book: false }, values: { rate: 0.62, progress: 0.8, delta: -0.3, divergence: -0.5, prints: 0, book: 1.1 }, raw: { own: 3, other: 7, legOwn: 14.222, moved: 0, legMoved: 1.778, big: 0, legBig: 0, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 }, startTs: 1_700_000_100_000, endTs: 1_700_000_400_000, extremeTs: 1_699_999_800_000, extremePrice: 31160, legStartTs: 1_699_998_000_000, legStartPrice: 31200, legSize: 40, efficiency: 0.6, atr: 7.5, judgedAt: null, updatedAt: 1_700_000_200_000, origin: "stored" },
  ],
});

const builtMonitor = monitorFrames.candleMonitorFrame(identity, {
  ts: 1_700_000_330_000, entries: [
    { candleMs: 60_000, candleTs: 1_700_000_220_000, buy: 2.97, sell: 0.56, biggestBuy: { price: 31190, size: 1.21 }, biggestSell: { price: 31186.5, size: 0.4 } },
    { candleMs: 300_000, candleTs: 1_700_000_100_000, buy: 0, sell: 0, biggestBuy: null, biggestSell: null },
  ],
});

describe("ws-frame contract: candle_monitor", () => {
  test("the builder emits exactly the schema's frame, entry and trade fields, all required, and the capability is the shades'", () => {
    const def = readSchema().$defs.candleMonitorFrame;
    const keys = Object.keys(builtMonitor).filter((key) => !identityKeys.has(key)).sort();
    expect(keys).toEqual(Object.keys(def.properties).filter((key) => !identityKeys.has(key)).sort());
    expect(keys).toEqual(def.required.filter((key) => !identityKeys.has(key)).sort());
    expect(def.properties.type.const).toBe("candle_monitor");
    expect(def["x-capability"]).toBeUndefined();
    expect(def["x-sent-with"]).toBe("exhaustion_shades");
    expect(def.properties.entries.maxItems).toBe(monitorFrames.MAX_CANDLE_MONITOR_ENTRIES);
    const entry = readSchema().$defs.candleMonitorEntry;
    for (const built of builtMonitor.entries) expect(Object.keys(built).sort()).toEqual(Object.keys(entry.properties).sort());
    expect([...entry.required].sort()).toEqual(Object.keys(entry.properties).sort());
    expect(entry.properties.candleMs.enum).toEqual(readSchema().$defs.exhaustionShade.properties.candleMs.enum);
    const trade = readSchema().$defs.candleMonitorTrade;
    expect(Object.keys(trade.properties).sort()).toEqual([...monitorFrames.CANDLE_MONITOR_TRADE_KEYS].sort());
    expect([...trade.required].sort()).toEqual([...monitorFrames.CANDLE_MONITOR_TRADE_KEYS].sort());
    expect(frameKindOf(builtMonitor)).toBe("latest-state");
  });

  test("the raw sums, their keys and the book bands, and the candle monitor's entry cap and amount ceiling, are the schema's, stated once on the server and once in the browser", () => {
    const schema = readSchema();
    const client = fs.readFileSync(CLIENT_PATH, "utf8");
    const server = fs.readFileSync(SERVER_PATH, "utf8");
    expect(schema.$defs.exhaustionRawValue.oneOf).toEqual([{ type: "null" }, { type: "number", minimum: -RAW_CAP, maximum: RAW_CAP }]);
    expect(frames.MAX_EXHAUSTION_RAW).toBe(RAW_CAP);
    expect(server.match(/\bconst MAX_EXHAUSTION_RAW\s*=\s*RAW_CAP;/g)).toHaveLength(1);
    expect(readNumericConstant(client, "MAX_EXHAUSTION_RAW")).toBe(RAW_CAP);
    expect(Object.keys(schema.$defs.exhaustionRaw.properties)).toEqual([...RAW_KEYS]);
    expect(schema.$defs.exhaustionRaw.required).toEqual([...RAW_KEYS]);
    expect(frames.EXHAUSTION_RAW_KEYS).toEqual([...RAW_KEYS]);
    expect(readSetConstant(client, "EXHAUSTION_RAW_KEYS")).toEqual([...RAW_KEYS]);
    expect(schema.$defs.exhaustionRaw.properties.bookBand.oneOf[1].enum).toEqual([...frames.EXHAUSTION_BOOK_BANDS]);
    expect(schema.$defs.candleMonitorFrame.properties.entries.maxItems).toBe(CANDLE_MS.length);
    expect(monitorFrames.MAX_CANDLE_MONITOR_ENTRIES).toBe(CANDLE_MS.length);
    expect(readNumericConstant(client, "MAX_CANDLE_MONITOR_ENTRIES")).toBe(CANDLE_MS.length);
    for (const bound of [schema.$defs.candleMonitorEntry.properties.buy.maximum, schema.$defs.candleMonitorEntry.properties.sell.maximum, schema.$defs.candleMonitorTrade.properties.size.maximum]) expect(bound).toBe(RAW_CAP);
    expect(readNumericConstant(client, "MAX_CANDLE_MONITOR_AMOUNT")).toBe(RAW_CAP);
    const { parseServerFrame } = require("../helpers/browser-frame-parser").loadBrowserFrames();
    const full = monitorFrames.candleMonitorFrame(identity, { ts: 1_700_000_330_000, entries: CANDLE_MS.map((candleMs) => ({ candleMs, candleTs: Math.floor(1_700_000_000_000 / candleMs) * candleMs, buy: 1, sell: 1, biggestBuy: null, biggestSell: null })) });
    expect(parseServerFrame(JSON.parse(JSON.stringify(full)))).toEqual(JSON.parse(JSON.stringify(full)));
    expect(full.entries).toHaveLength(CANDLE_MS.length);
  });

  test("the browser parser admits the builder's candle monitor and returns every field unchanged, and rejects what the builder refuses", () => {
    const { parseServerFrame } = require("../helpers/browser-frame-parser").loadBrowserFrames();
    const raw = JSON.parse(JSON.stringify(builtMonitor));
    expect(parseServerFrame(raw)).toEqual(raw);
    const [one, five] = raw.entries;
    expect(parseServerFrame({ ...raw, entries: [] })).toBeNull();
    expect(parseServerFrame({ ...raw, entries: [one, one] })).toBeNull();
    expect(parseServerFrame({ ...raw, entries: [five, one] })).toBeNull();
    expect(parseServerFrame({ ...raw, entries: Array.from({ length: monitorFrames.MAX_CANDLE_MONITOR_ENTRIES + 1 }, (_, i) => ({ ...one, candleMs: 60_000 + i })) })).toBeNull();
    expect(parseServerFrame({ ...raw, extra: 1 })).toBeNull();
    const noTs = { ...raw };
    delete noTs.ts;
    expect(parseServerFrame(noTs)).toBeNull();
    for (const bad of [{ ...one, extra: 1 }, { ...one, candleMs: 240_000 }, { ...one, candleTs: 1_700_000_240_001 }, { ...one, candleTs: 1.5 }, { ...one, buy: -1 }, { ...one, buy: 1e9 + 1 }, { ...one, sell: null }, { ...one, biggestBuy: { price: 1 } }, { ...one, biggestBuy: { price: 0, size: 1 } }, { ...one, biggestSell: { price: 1, size: 0 } }, { ...one, biggestSell: { price: 1, size: 1, extra: 1 } }, { ...one, biggestBuy: [1, 2] }, { ...one, biggestBuy: undefined }]) {
      expect(parseServerFrame({ ...raw, entries: [bad] })).toBeNull();
    }
    expect(parseServerFrame({ ...raw, entries: [{ ...one, buy: 1e9, sell: 0, biggestBuy: { price: 1e7, size: 1e9 } }] })).toMatchObject({ entries: [{ buy: 1e9, biggestBuy: { price: 1e7, size: 1e9 } }] });
    for (const bad of [{ ...one, biggestBuy: { price: 1e7 + 1, size: 1 } }, { ...one, biggestSell: { price: 1, size: 1e9 + 1 } }]) expect(parseServerFrame({ ...raw, entries: [bad] })).toBeNull();
  });
});

describe("ws-frame contract: exhaustion_shades", () => {
  test("the builder emits exactly the schema's frame fields, all of them required, and the type matches", () => {
    const def = readSchema().$defs.exhaustionShadesFrame;
    const keys = Object.keys(built).filter((key) => !identityKeys.has(key)).sort();
    expect(keys).toEqual(Object.keys(def.properties).filter((key) => !identityKeys.has(key)).sort());
    expect(keys).toEqual(def.required.filter((key) => !identityKeys.has(key)).sort());
    expect(def.properties.type.const).toBe(built.type);
    expect(def["x-capability"]).toBe("exhaustion_shades");
  });

  test("a shade is exactly the schema's twenty-one fields, all required, the readings and their values its six, and the vocabularies are the schema's", () => {
    const def = readSchema().$defs.exhaustionShade;
    for (const shade of built.shades) expect(Object.keys(shade).sort()).toEqual(Object.keys(def.properties).sort());
    expect([...def.required].sort()).toEqual(Object.keys(def.properties).sort());
    expect(Object.keys(def.properties.readings.properties)).toEqual([...frames.EXHAUSTION_READINGS]);
    expect(def.properties.readings.required).toEqual([...frames.EXHAUSTION_READINGS]);
    expect(Object.keys(def.properties.values.properties)).toEqual([...frames.EXHAUSTION_READINGS]);
    expect(def.properties.values.required).toEqual([...frames.EXHAUSTION_READINGS]);
    expect(def.properties.values.additionalProperties).toBe(false);
    const value = readSchema().$defs.exhaustionReadingValue.oneOf;
    expect(value).toEqual([{ type: "null" }, { type: "number", minimum: -frames.MAX_EXHAUSTION_VALUE, maximum: frames.MAX_EXHAUSTION_VALUE }]);
    expect(VALUE_CAP).toBe(frames.MAX_EXHAUSTION_VALUE);
    expect(def.properties.candleMs.enum).toEqual([...frames.EXHAUSTION_CANDLE_MS]);
    expect(def.properties.side.enum).toEqual([...frames.EXHAUSTION_SIDES]);
    expect(def.properties.status.enum).toEqual([...frames.EXHAUSTION_STATUSES]);
    expect(def.properties.origin.enum).toEqual([...frames.EXHAUSTION_ORIGINS]);
    expect(def.properties.intensity.maximum).toBe(frames.MAX_EXHAUSTION_INTENSITY);
    expect(def.properties.score.maximum).toBe(frames.MAX_EXHAUSTION_SCORE);
    expect(def.properties.score.minimum).toBe(0);
  });

  test.each([
    ["shades per frame", (s) => s.$defs.exhaustionShadesFrame.properties.shades.maxItems, "MAX_EXHAUSTION_SHADES"],
    ["id length", (s) => s.$defs.exhaustionShade.properties.id.maxLength, "MAX_EXHAUSTION_ID_LENGTH"],
    ["intensity", (s) => s.$defs.exhaustionShade.properties.intensity.maximum, "MAX_EXHAUSTION_INTENSITY"],
    ["score", (s) => s.$defs.exhaustionShade.properties.score.maximum, "MAX_EXHAUSTION_SCORE"],
    ["reading value", (s) => s.$defs.exhaustionReadingValue.oneOf[1].maximum, "MAX_EXHAUSTION_VALUE"],
  ])("the %s bound is the schema's, stated once in exhaustion-frames.js and once in the browser parser", (_label, schemaValue, name) => {
    const server = fs.readFileSync(SERVER_PATH, "utf8");
    const client = fs.readFileSync(CLIENT_PATH, "utf8");
    const value = schemaValue(readSchema());
    expect(Number.isFinite(value)).toBe(true);
    expect(server.match(new RegExp(`\\bconst ${name}\\s*=`, "g"))).toHaveLength(1);
    expect(readNumericConstant(server, name)).toBe(value);
    expect(frames[name]).toBe(value);
    expect(client.match(new RegExp(`\\bconst ${name}\\s*=`, "g"))).toHaveLength(1);
    expect(readNumericConstant(client, name)).toBe(value);
  });

  test.each([
    ["EXHAUSTION_CANDLE_MS", (s) => s.$defs.exhaustionShade.properties.candleMs.enum],
    ["EXHAUSTION_SIDES", (s) => s.$defs.exhaustionShade.properties.side.enum],
    ["EXHAUSTION_STATUSES", (s) => s.$defs.exhaustionShade.properties.status.enum],
    ["EXHAUSTION_FINAL_STATUSES", () => [...frames.EXHAUSTION_FINAL_STATUSES]],
    ["EXHAUSTION_ORIGINS", (s) => s.$defs.exhaustionShade.properties.origin.enum],
    ["EXHAUSTION_READINGS", (s) => Object.keys(s.$defs.exhaustionShade.properties.readings.properties)],
  ])("the browser's %s set is the schema's", (name, schemaValues) => {
    const client = fs.readFileSync(CLIENT_PATH, "utf8");
    expect(readSetConstant(client, name)).toEqual(schemaValues(readSchema()));
  });

  test("the browser parser admits the builder's output and returns every field unchanged, for both identities", () => {
    const { parseServerFrame } = require("../helpers/browser-frame-parser").loadBrowserFrames();
    expect(parseServerFrame(JSON.parse(JSON.stringify(built)))).toEqual(JSON.parse(JSON.stringify(built)));
    const crypto = frames.exhaustionShadesFrame({ provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" }, { ts: 1_700_000_200_000, seq: 0, reset: true, liveSince: 1_699_990_000_000, shades: [built.shades[1]] });
    expect(parseServerFrame(JSON.parse(JSON.stringify(crypto)))).toEqual(JSON.parse(JSON.stringify(crypto)));
  });

  test("the browser rejects what the builder refuses: an empty increment, a duplicate id, a twenty-second field, a seventh reading or value, a start out of order, a judged shade without judgedAt, an open one with it, a vocabulary miss", () => {
    const { parseServerFrame } = require("../helpers/browser-frame-parser").loadBrowserFrames();
    const raw = JSON.parse(JSON.stringify(built));
    const [held, open] = raw.shades;
    expect(parseServerFrame({ ...raw, shades: [] })).toBeNull();
    expect(parseServerFrame({ ...raw, reset: true, shades: [] })).not.toBeNull();
    expect(parseServerFrame({ ...raw, shades: [held, held] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, extra: 1 }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, readings: { ...held.readings, wall: true } }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, readings: { rate: true, progress: true, delta: true, divergence: false, prints: true } }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, score: -1 }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, score: 7 }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, atr: 0 }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, values: { ...held.values, wall: 1 } }] })).toBeNull();
    const { book, ...fiveValues } = held.values;
    expect(book).toBe(0.95);
    expect(parseServerFrame({ ...raw, shades: [{ ...held, values: fiveValues }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, values: { ...held.values, rate: "0.2" } }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, raw: { ...held.raw, own: "3" } }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, raw: { ...held.raw, extra: 1 } }] })).toBeNull();
    for (const bookBand of [3, -1, 0.5, "0"]) expect(parseServerFrame({ ...raw, shades: [{ ...held, raw: { ...held.raw, bookBand } }] })).toBeNull();
    for (const bookBand of [0, 1, 2, null]) expect(parseServerFrame({ ...raw, shades: [{ ...held, raw: { ...held.raw, bookBand } }] })).toMatchObject({ shades: [{ raw: { bookBand } }] });
    const { bookAt, ...elevenRaw } = held.raw;
    expect(bookAt).toBe(2);
    expect(parseServerFrame({ ...raw, shades: [{ ...held, raw: elevenRaw }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, raw: { ...held.raw, own: frames.MAX_EXHAUSTION_RAW + 1 } }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, raw: { ...held.raw, own: frames.MAX_EXHAUSTION_RAW, other: null } }] })).toMatchObject({ shades: [{ raw: { own: frames.MAX_EXHAUSTION_RAW, other: null } }] });
    expect(parseServerFrame({ ...raw, shades: [{ ...held, values: { ...held.values, prints: frames.MAX_EXHAUSTION_VALUE + 1 } }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, values: { ...held.values, book: -frames.MAX_EXHAUSTION_VALUE - 1 } }] })).toBeNull();
    const edge = { rate: frames.MAX_EXHAUSTION_VALUE, progress: -frames.MAX_EXHAUSTION_VALUE, delta: 0, divergence: 0, prints: 0, book: 0 };
    expect(parseServerFrame({ ...raw, shades: [{ ...held, values: edge }] })).toMatchObject({ shades: [{ values: edge }] });
    for (const status of frames.EXHAUSTION_FINAL_STATUSES) {
      expect(parseServerFrame({ ...raw, shades: [{ ...held, status }] })).toMatchObject({ shades: [{ status, judgedAt: held.judgedAt }] });
      expect(parseServerFrame({ ...raw, shades: [{ ...held, status, judgedAt: null }] })).toBeNull();
    }
    const blanks = { rate: null, progress: null, delta: null, divergence: null, prints: null, book: null };
    expect(parseServerFrame({ ...raw, shades: [{ ...held, values: blanks }] })).toMatchObject({ shades: [{ values: blanks }] });
    expect(parseServerFrame({ ...raw, shades: [{ ...open, status: "pending" }] })).toMatchObject({ shades: [{ status: "pending", judgedAt: null }] });
    expect(parseServerFrame({ ...raw, shades: [{ ...open, status: "pending", judgedAt: open.endTs }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, efficiency: 0 }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, efficiency: 1.01 }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [open, held] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, judgedAt: null }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...open, judgedAt: open.updatedAt }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, judgedAt: held.endTs - 1 }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, endTs: held.startTs }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, extremeTs: held.endTs }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, legStartTs: held.extremeTs + 1 }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, candleMs: 240_000 }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, side: "bulls" }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, status: "won" }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, origin: "laptop" }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, origin: "host" }, open] })).toMatchObject({ shades: [{ origin: "host" }, { origin: "stored" }] });
    expect(parseServerFrame({ ...raw, shades: [{ ...held, intensity: 0 }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, intensity: 4 }] })).toBeNull();
    expect(parseServerFrame({ ...raw, shades: [{ ...held, legSize: 0 }] })).toBeNull();
    const noSince = { ...raw };
    delete noSince.liveSince;
    expect(parseServerFrame(noSince)).toBeNull();
    for (const bad of ["1000", -1, 1.5, null]) expect(parseServerFrame({ ...raw, liveSince: bad })).toBeNull();
    const noLoading = { ...raw };
    delete noLoading.loading;
    expect(parseServerFrame(noLoading)).toBeNull();
    for (const bad of ["1000", -1, 1.5, undefined, true]) expect(parseServerFrame({ ...raw, loading: bad })).toBeNull();
    expect(parseServerFrame({ ...raw, loading: 1_699_900_000_000 })).toMatchObject({ loading: 1_699_900_000_000 });
    expect(parseServerFrame({ ...raw, loading: null })).toMatchObject({ loading: null });
  });

  test("the capability is accepted by the server and declared by the browser, and the frame is incremental", () => {
    const { CLIENT_CAPABILITIES } = require("../helpers/browser-frame-parser").loadBrowserFrames();
    expect(CAPABILITY_FLAGS).toContain("exhaustion_shades");
    expect(CLIENT_CAPABILITIES).toContain("exhaustion_shades");
    expect(frameKindOf(built)).toBe(FRAME_KIND_INCREMENTAL);
  });
});
