const fs = require("fs");
const path = require("path");
const frames = require("../../src/server/iceberg-frames");
const { frameKindOf, FRAME_KIND_INCREMENTAL } = require("../../src/server/frames");
const { CAPABILITY_FLAGS } = require("../../src/server/l2-frames");

const SCHEMA_PATH = path.resolve(__dirname, "../../../../docs/contracts/ws-frame-contract/v1/ws-frame-contract-v1.schema.json");
const SERVER_PATH = path.resolve(__dirname, "../../src/server/iceberg-frames.js");
const SERVER_FIELDS_PATH = path.resolve(__dirname, "../../src/server/iceberg-wire-fields.js");
const CLIENT_PATH = path.resolve(__dirname, "../../../web/src/types/frames.ts");
const readSchema = () => JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
const identityKeys = new Set(["type", "symbol", "provider", "marketKind", "assetClass"]);

function readNumericConstant(source, name) {
  const match = source.match(new RegExp(`\\bconst ${name}\\s*=\\s*([0-9_]+)`));
  return match ? Number(match[1].replace(/_/g, "")) : null;
}

function readSetConstant(source, name) {
  const match = source.match(new RegExp(`\\bconst ${name}[^=]*=\\s*(?:new Set\\()?(?:Object\\.freeze\\()?\\[([^\\]]*)\\]`));
  return match ? match[1].split(",").map((part) => part.trim().replace(/^"|"$/g, "")).filter(Boolean) : null;
}

const identity = { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" };
const built = frames.icebergOrdersFrame(identity, {
  ts: 20_000, seq: 2, reset: false, liveSince: 1000, icebergs: [
    { id: "/NQZ26:XCME|5137554220647449213|1000", kind: "native", confidence: "certain", origin: "runtime", side: "bid", price: 31188, display: 10, tranches: 4, executed: 32, startedAt: 1000, markedAt: 1500, updatedAt: 9000, status: "filled" },
    { id: "BTCUSDT|PERPETUAL|ask|80924.2|5000", kind: "probable", confidence: "strong", origin: "runtime", side: "ask", price: 80924.2, display: 1.545, tranches: 2, executed: 12.475, startedAt: 5000, markedAt: 10_000, updatedAt: 11_200, status: "active" },
  ],
});

describe("ws-frame contract: iceberg_orders", () => {
  test("the builder emits exactly the schema's frame fields, all of them required, and the type matches", () => {
    const def = readSchema().$defs.icebergOrdersFrame;
    const keys = Object.keys(built).filter((key) => !identityKeys.has(key)).sort();
    expect(keys).toEqual(Object.keys(def.properties).filter((key) => !identityKeys.has(key)).sort());
    expect(keys).toEqual(def.required.filter((key) => !identityKeys.has(key)).sort());
    expect(def.properties.type.const).toBe(built.type);
    expect(def["x-capability"]).toBe("iceberg_orders");
  });

  test("an iceberg is exactly the schema's thirteen fields, all required, and the vocabularies are the schema's", () => {
    const def = readSchema().$defs.icebergOrder;
    for (const iceberg of built.icebergs) expect(Object.keys(iceberg).sort()).toEqual(Object.keys(def.properties).sort());
    expect([...def.required].sort()).toEqual(Object.keys(def.properties).sort());
    expect(def.properties.kind.enum).toEqual([...frames.ICEBERG_KINDS]);
    expect(def.properties.confidence.enum).toEqual([...frames.ICEBERG_CONFIDENCES]);
    expect(def.properties.side.enum).toEqual([...frames.ICEBERG_SIDES]);
    expect(def.properties.status.enum).toEqual([...frames.ICEBERG_STATUSES]);
    expect(def.properties.origin.enum).toEqual([...frames.ICEBERG_ORIGINS]);
  });

  test.each([
    ["icebergs per frame", (s) => s.$defs.icebergOrdersFrame.properties.icebergs.maxItems, "MAX_ICEBERG_ORDERS", SERVER_PATH],
    ["id length", (s) => s.$defs.icebergOrder.properties.id.maxLength, "MAX_ICEBERG_ID_LENGTH", SERVER_FIELDS_PATH],
    ["watched spans", (s) => s.$defs.icebergOrdersFrame.properties.watched.maxItems, "MAX_WATCHED_SPANS", SERVER_PATH],
  ])("the %s bound is the schema's, stated once on the server and once in the browser parser", (_label, schemaValue, name, serverPath) => {
    const server = fs.readFileSync(serverPath, "utf8");
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
    ["ICEBERG_KINDS", (s) => s.$defs.icebergOrder.properties.kind.enum],
    ["ICEBERG_CONFIDENCES", (s) => s.$defs.icebergOrder.properties.confidence.enum],
    ["ICEBERG_STATUSES", (s) => s.$defs.icebergOrder.properties.status.enum],
    ["ICEBERG_ORIGINS", (s) => s.$defs.icebergOrder.properties.origin.enum],
  ])("the browser's %s set is the schema's enum", (name, schemaValues) => {
    const client = fs.readFileSync(CLIENT_PATH, "utf8");
    expect(readSetConstant(client, name)).toEqual(schemaValues(readSchema()));
  });

  test("the browser parser admits the builder's output and returns every field unchanged, for both identities", () => {
    const { parseServerFrame } = require("../helpers/browser-frame-parser").loadBrowserFrames();
    expect(parseServerFrame(JSON.parse(JSON.stringify(built)))).toEqual(JSON.parse(JSON.stringify(built)));
    const crypto = frames.icebergOrdersFrame({ provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" }, { ts: 20_000, seq: 0, reset: true, liveSince: 1000, icebergs: [built.icebergs[1]] });
    expect(parseServerFrame(JSON.parse(JSON.stringify(crypto)))).toEqual(JSON.parse(JSON.stringify(crypto)));
  });

  test("the browser rejects what the builder refuses: an empty increment, a duplicate id, a fourteenth field, a mark out of order, an origin outside the vocabulary or missing", () => {
    const { parseServerFrame } = require("../helpers/browser-frame-parser").loadBrowserFrames();
    const raw = JSON.parse(JSON.stringify(built));
    expect(parseServerFrame({ ...raw, icebergs: [] })).toBeNull();
    expect(parseServerFrame({ ...raw, icebergs: [raw.icebergs[0], raw.icebergs[0]] })).toBeNull();
    expect(parseServerFrame({ ...raw, icebergs: [{ ...raw.icebergs[0], extra: 1 }] })).toBeNull();
    expect(parseServerFrame({ ...raw, icebergs: [raw.icebergs[1], raw.icebergs[0]] })).toBeNull();
    expect(parseServerFrame({ ...raw, icebergs: [{ ...raw.icebergs[0], confidence: "sure" }] })).toBeNull();
    expect(parseServerFrame({ ...raw, icebergs: [{ ...raw.icebergs[0], origin: "laptop" }] })).toBeNull();
    const bare = { ...raw.icebergs[0] };
    delete bare.origin;
    expect(parseServerFrame({ ...raw, icebergs: [bare] })).toBeNull();
    expect(parseServerFrame({ ...raw, icebergs: [{ ...bare, origin: "host" }] })).toMatchObject({ icebergs: [{ origin: "host" }] });
    expect(parseServerFrame({ ...raw, reset: true, icebergs: [] })).not.toBeNull();
    const noSpans = { ...raw };
    delete noSpans.watched;
    expect(parseServerFrame(noSpans)).toBeNull();
    const noSince = { ...raw };
    delete noSince.liveSince;
    expect(parseServerFrame(noSince)).toBeNull();
    for (const bad of ["1000", -1, 1.5, null]) expect(parseServerFrame({ ...raw, liveSince: bad })).toBeNull();
    expect(parseServerFrame({ ...raw, liveSince: 1000 })).toMatchObject({ liveSince: 1000 });
    for (const bad of [[[2, 1]], [[1, 2], [1, 3]], [[1, 2, 3]], [[1, "2"]], "x", Array.from({ length: 65 }, (_, i) => [i * 10, i * 10 + 5])]) expect(parseServerFrame({ ...raw, watched: bad })).toBeNull();
    expect(parseServerFrame({ ...raw, watched: [[1000, 2000], [2000, 3000]] })).toMatchObject({ watched: [[1000, 2000], [2000, 3000]] });
  });

  test("the capability is accepted by the server and declared by the browser, and the frame is incremental", () => {
    const { CLIENT_CAPABILITIES } = require("../helpers/browser-frame-parser").loadBrowserFrames();
    expect(CAPABILITY_FLAGS).toContain("iceberg_orders");
    expect(CLIENT_CAPABILITIES).toContain("iceberg_orders");
    expect(frameKindOf(built)).toBe(FRAME_KIND_INCREMENTAL);
  });
});
