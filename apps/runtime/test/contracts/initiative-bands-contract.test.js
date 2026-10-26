const fs = require("fs");
const path = require("path");
const frames = require("../../src/server/initiative-frames");
const { frameKindOf, FRAME_KIND_INCREMENTAL } = require("../../src/server/frames");
const { CAPABILITY_FLAGS } = require("../../src/server/l2-frames");

const SCHEMA_PATH = path.resolve(__dirname, "../../../../docs/contracts/ws-frame-contract/v1/ws-frame-contract-v1.schema.json");
const SERVER_PATH = path.resolve(__dirname, "../../src/server/initiative-frames.js");
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
const facts = { efficiency: { yes: true, value: 0.714 }, closes: { yes: true, value: 2 }, burst: { yes: false, value: 0.8 }, delta: { yes: true, rank: 1, share: 0.75 }, prints: { yes: true, rank: 0.833, perCandle: 1 } };
const built = frames.initiativeBandsFrame(identity, {
  ts: 1_700_000_300_000, seq: 2, reset: false, liveSince: 1_699_990_000_000, bands: [
    { id: "60000|down|1700000040000", candleMs: 60_000, side: "down", dominant: "sellers", dominantShare: 0.75, score: 4, facts, pivotTs: 1_700_000_040_000, pivotPrice: 31188.25, frozenTs: 1_700_000_220_000, frozenPrice: 31170, windowCandles: 3, atr: 3.25, legExtremePrice: 31168.5, legExtremeTs: 1_700_000_220_000, legEndTs: null, updatedAt: 1_700_000_280_000, origin: "runtime" },
    { id: "300000|up|1700000100000", candleMs: 300_000, side: "up", dominant: "sellers", dominantShare: 0.52, score: 2, facts: { efficiency: { yes: false, value: 0.556 }, closes: { yes: true, value: 1 }, burst: { yes: false, value: null }, delta: { yes: false, rank: 0.2, share: 0.48 }, prints: { yes: true, rank: 0.9, perCandle: 2 } }, pivotTs: 1_700_000_100_000, pivotPrice: 31160, frozenTs: 1_700_000_400_000, frozenPrice: 31190, windowCandles: 1, atr: 7.5, legExtremePrice: 31200, legExtremeTs: 1_700_000_700_000, legEndTs: 1_700_001_000_000, updatedAt: 1_700_001_000_000, origin: "stored" },
  ],
});

describe("ws-frame contract: initiative_bands", () => {
  test("the builder emits exactly the schema's frame fields, all of them required, the type matches, the capability is its own, the kind incremental", () => {
    const def = readSchema().$defs.initiativeBandsFrame;
    const keys = Object.keys(built).filter((key) => !identityKeys.has(key)).sort();
    expect(keys).toEqual(Object.keys(def.properties).filter((key) => !identityKeys.has(key)).sort());
    expect(keys).toEqual(def.required.filter((key) => !identityKeys.has(key)).sort());
    expect(def.properties.type.const).toBe(built.type);
    expect(def["x-capability"]).toBe("initiative_bands");
    expect(CAPABILITY_FLAGS).toContain("initiative_bands");
    expect(frameKindOf(built)).toBe(FRAME_KIND_INCREMENTAL);
  });

  test("a band is exactly the schema's eighteen fields, all required, the facts their five with their exact keys, and the vocabularies are the schema's", () => {
    const def = readSchema().$defs.initiativeBand;
    for (const band of built.bands) expect(Object.keys(band).sort()).toEqual(Object.keys(def.properties).sort());
    expect([...def.required].sort()).toEqual(Object.keys(def.properties).sort());
    expect(def.additionalProperties).toBe(false);
    const factsDef = def.properties.facts;
    expect(Object.keys(factsDef.properties)).toEqual([...frames.INITIATIVE_FACTS]);
    expect(factsDef.required).toEqual([...frames.INITIATIVE_FACTS]);
    expect(factsDef.additionalProperties).toBe(false);
    for (const key of frames.INITIATIVE_FACTS) {
      expect(Object.keys(factsDef.properties[key].properties)).toEqual([...frames.INITIATIVE_FACT_KEYS[key]]);
      expect(factsDef.properties[key].required).toEqual([...frames.INITIATIVE_FACT_KEYS[key]]);
      expect(factsDef.properties[key].additionalProperties).toBe(false);
    }
    expect(def.properties.candleMs.enum).toEqual([...frames.INITIATIVE_CANDLE_MS]);
    expect(def.properties.side.enum).toEqual([...frames.INITIATIVE_SIDES]);
    expect(def.properties.dominant.enum).toEqual([...frames.INITIATIVE_DOMINANTS]);
    expect(def.properties.origin.enum).toEqual([...frames.INITIATIVE_ORIGINS]);
    expect(def.properties.score.maximum).toBe(frames.MAX_INITIATIVE_SCORE);
    expect(def.properties.score.minimum).toBe(0);
    expect(def.properties.windowCandles.minimum).toBe(1);
    expect(def.properties.dominantShare).toEqual({ type: "number", minimum: 0, maximum: 1 });
    expect(readSchema().$defs.initiativeUnit).toEqual({ oneOf: [{ type: "null" }, { type: "number", minimum: 0, maximum: 1 }] });
    expect(readSchema().$defs.initiativeAmount).toEqual({ oneOf: [{ type: "null" }, { type: "number", minimum: 0, maximum: frames.MAX_INITIATIVE_VALUE }] });
    expect(factsDef.properties.closes.properties.value).toEqual({ type: "integer", minimum: 0, maximum: frames.MAX_INITIATIVE_WINDOW });
  });

  test.each([
    ["bands per frame", (s) => s.$defs.initiativeBandsFrame.properties.bands.maxItems, "MAX_INITIATIVE_BANDS"],
    ["id length", (s) => s.$defs.initiativeBand.properties.id.maxLength, "MAX_INITIATIVE_ID_LENGTH"],
    ["score", (s) => s.$defs.initiativeBand.properties.score.maximum, "MAX_INITIATIVE_SCORE"],
    ["amount", (s) => s.$defs.initiativeAmount.oneOf[1].maximum, "MAX_INITIATIVE_VALUE"],
    ["window candles", (s) => s.$defs.initiativeBand.properties.windowCandles.maximum, "MAX_INITIATIVE_WINDOW"],
  ])("the %s bound is the schema's, stated once in initiative-frames.js and once in the browser parser", (_label, schemaValue, name) => {
    const server = fs.readFileSync(SERVER_PATH, "utf8");
    const client = fs.readFileSync(CLIENT_PATH, "utf8");
    const value = schemaValue(readSchema());
    expect(Number.isFinite(value)).toBe(true);
    expect(server.match(new RegExp(`\\bconst ${name}\\s*=`, "g"))).toHaveLength(1);
    expect(frames[name]).toBe(value);
    expect(client.match(new RegExp(`\\bconst ${name}\\s*=`, "g"))).toHaveLength(1);
    expect(readNumericConstant(client, name)).toBe(value);
  });

  test.each([
    ["INITIATIVE_CANDLE_MS", (s) => s.$defs.initiativeBand.properties.candleMs.enum],
    ["INITIATIVE_SIDES", (s) => s.$defs.initiativeBand.properties.side.enum],
    ["INITIATIVE_DOMINANTS", (s) => s.$defs.initiativeBand.properties.dominant.enum],
    ["INITIATIVE_ORIGINS", (s) => s.$defs.initiativeBand.properties.origin.enum],
    ["INITIATIVE_FACTS", (s) => Object.keys(s.$defs.initiativeBand.properties.facts.properties)],
  ])("the browser's %s set is the schema's", (name, schemaValues) => {
    const client = fs.readFileSync(CLIENT_PATH, "utf8");
    expect(readSetConstant(client, name)).toEqual(schemaValues(readSchema()));
  });

  test("the browser parser admits the builder's output and returns every field unchanged, for both identities", () => {
    const { parseServerFrame } = require("../helpers/browser-frame-parser").loadBrowserFrames();
    expect(parseServerFrame(JSON.parse(JSON.stringify(built)))).toEqual(JSON.parse(JSON.stringify(built)));
    const crypto = frames.initiativeBandsFrame({ provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" }, { ts: 1_700_000_200_000, seq: 0, reset: true, liveSince: 1_699_990_000_000, loading: 1_699_900_000_000, bands: [built.bands[1]] });
    expect(parseServerFrame(JSON.parse(JSON.stringify(crypto)))).toEqual(JSON.parse(JSON.stringify(crypto)));
  });

  test("the browser rejects what the builder refuses: an empty increment, a duplicate id, a nineteenth field, a missing or wrong-typed field, a sixth fact or a fact key off the list, a pivot out of order, times out of order, a vocabulary miss, a bound passed", () => {
    const { parseServerFrame } = require("../helpers/browser-frame-parser").loadBrowserFrames();
    const raw = JSON.parse(JSON.stringify(built));
    const [down, up] = raw.bands;
    const accepts = (bands) => parseServerFrame({ ...raw, bands });
    expect(accepts([])).toBeNull();
    expect(parseServerFrame({ ...raw, reset: true, bands: [] })).not.toBeNull();
    expect(accepts([down, down])).toBeNull();
    expect(accepts([up, down])).toBeNull();
    expect(accepts([{ ...down, extra: 1 }])).toBeNull();
    for (const key of Object.keys(down)) {
      const missing = { ...down };
      delete missing[key];
      expect(accepts([missing])).toBeNull();
      expect(accepts([{ ...down, [key]: key === "id" ? 5 : "x" }])).toBeNull();
    }
    expect(accepts([{ ...down, facts: { ...down.facts, volume: { yes: true, value: 1 } } }])).toBeNull();
    const { prints, ...fourFacts } = down.facts;
    expect(prints.perCandle).toBe(1);
    expect(accepts([{ ...down, facts: fourFacts }])).toBeNull();
    expect(accepts([{ ...down, facts: { ...down.facts, delta: { yes: true, rank: 1, share: 0.75, extra: 1 } } }])).toBeNull();
    expect(accepts([{ ...down, facts: { ...down.facts, delta: { yes: true, rank: 1 } } }])).toBeNull();
    expect(accepts([{ ...down, facts: { ...down.facts, closes: { yes: 1, value: 2 } } }])).toBeNull();
    expect(accepts([{ ...down, facts: { ...down.facts, closes: { yes: true, value: 4 } } }])).toBeNull();
    expect(accepts([{ ...down, facts: { ...down.facts, closes: { yes: true, value: 1.5 } } }])).toBeNull();
    expect(accepts([{ ...down, facts: { ...down.facts, efficiency: { yes: true, value: 1.5 } } }])).toBeNull();
    expect(accepts([{ ...down, facts: { ...down.facts, efficiency: { yes: true, value: -0.1 } } }])).toBeNull();
    expect(accepts([{ ...down, facts: { ...down.facts, burst: { yes: true, value: frames.MAX_INITIATIVE_VALUE + 1 } } }])).toBeNull();
    expect(accepts([{ ...down, facts: { ...down.facts, burst: { yes: true, value: -1 } } }])).toBeNull();
    expect(accepts([{ ...down, facts: { ...down.facts, delta: { yes: true, rank: 1.5, share: 0.75 } } }])).toBeNull();
    expect(accepts([{ ...down, facts: { ...down.facts, prints: { yes: true, rank: 0.9, perCandle: "1" } } }])).toBeNull();
    expect(accepts([{ ...down, facts: { ...down.facts, prints: { yes: true, rank: null, perCandle: null } } }])).toMatchObject({ bands: [{ facts: { prints: { rank: null, perCandle: null } } }] });
    expect(accepts([{ ...down, facts: { ...down.facts, efficiency: { yes: false, value: null }, burst: { yes: false, value: null }, delta: { yes: false, rank: null, share: null } } }])).not.toBeNull();
    expect(accepts([{ ...down, side: "buyers" }])).toBeNull();
    expect(accepts([{ ...down, dominant: "down" }])).toBeNull();
    expect(accepts([{ ...down, origin: "laptop" }])).toBeNull();
    expect(accepts([{ ...down, candleMs: 240_000 }])).toBeNull();
    expect(accepts([{ ...down, score: -1 }])).toBeNull();
    expect(accepts([{ ...down, score: frames.MAX_INITIATIVE_SCORE + 1 }])).toBeNull();
    expect(accepts([{ ...down, score: 2.5 }])).toBeNull();
    expect(accepts([{ ...down, dominantShare: 1.5 }])).toBeNull();
    expect(accepts([{ ...down, dominantShare: null }])).toBeNull();
    expect(accepts([{ ...down, windowCandles: 0, facts: { ...down.facts, closes: { yes: false, value: 0 } } }])).toBeNull();
    expect(accepts([{ ...down, windowCandles: frames.MAX_INITIATIVE_WINDOW + 1 }])).toBeNull();
    expect(accepts([{ ...down, id: "" }])).toBeNull();
    expect(accepts([{ ...down, id: "x".repeat(frames.MAX_INITIATIVE_ID_LENGTH + 1) }])).toBeNull();
    expect(accepts([{ ...down, frozenTs: down.pivotTs }])).toBeNull();
    expect(accepts([{ ...down, legExtremeTs: down.frozenTs - 1 }])).toBeNull();
    expect(accepts([{ ...down, legEndTs: down.frozenTs - 1 }])).toBeNull();
    expect(accepts([{ ...down, legEndTs: 1.5 }])).toBeNull();
    expect(accepts([{ ...down, updatedAt: down.frozenTs - 1 }])).toBeNull();
    expect(accepts([{ ...down, pivotPrice: 0 }])).toBeNull();
    expect(accepts([{ ...down, frozenPrice: -1 }])).toBeNull();
    expect(accepts([{ ...down, legExtremePrice: 0 }])).toBeNull();
    expect(accepts([{ ...down, atr: 0 }])).toBeNull();
    expect(accepts([{ ...down, pivotTs: 1.5 }])).toBeNull();
    const padded = (count) => Array.from({ length: count }, (_, i) => ({ ...down, id: `b${String(i).padStart(4, "0")}` }));
    expect(accepts(padded(frames.MAX_INITIATIVE_BANDS))).not.toBeNull();
    expect(accepts(padded(frames.MAX_INITIATIVE_BANDS + 1))).toBeNull();
    expect(parseServerFrame({ ...raw, loading: -1 })).toBeNull();
    expect(parseServerFrame({ ...raw, liveSince: "1" })).toBeNull();
    expect(parseServerFrame({ ...raw, reset: "no" })).toBeNull();
    expect(parseServerFrame({ ...raw, seq: -1 })).toBeNull();
    expect(parseServerFrame({ ...raw, extra: 1 })).toBeNull();
    const noLoading = { ...raw };
    delete noLoading.loading;
    expect(parseServerFrame(noLoading)).toBeNull();
  });
});
