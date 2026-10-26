const fs = require("node:fs");
const path = require("node:path");

// A2.20 / L1L2-V2-060 and L1L2-V2-051.
//
// The wire limits were hardcoded three times over: once in the server's frame
// builders, once in the browser's parsers, and nowhere authoritative. Nothing
// reconciled them, and the failure is asymmetric -- raising the SERVER limit
// without the client makes the client reject every oversized frame, which is
// the failCurrentSocket reconnect loop of L1L2-V2-059; raising the CLIENT
// limit alone breaks nothing. A mistake that is only dangerous in one
// direction is an easy mistake to make.
//
// The contract is now the authority: ws-frame-contract-v1.schema.json carries
// the bounds as real JSON Schema constraints, and this test reads them back
// out of the schema and asserts both implementations agree. The two apps are
// separate npm workspaces and apps/web/tsconfig.app.json includes only src, so
// the browser cannot import from the runtime -- one shared module is not
// available across this boundary. An enforced invariant is.

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SCHEMA_PATH = path.join(
  REPO_ROOT, "docs", "contracts", "ws-frame-contract", "v1", "ws-frame-contract-v1.schema.json",
);
const SERVER_FRAMES_PATH = path.join(REPO_ROOT, "apps", "runtime", "src", "server", "frames.js");
const SERVER_WIRE_FIELDS_PATH = path.join(REPO_ROOT, "apps", "runtime", "src", "server", "wire-fields.js");
const CLIENT_FRAMES_PATH = path.join(REPO_ROOT, "apps", "web", "src", "types", "frames.ts");

function readSchema() {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
}

function readNumericConstant(source, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*([0-9_]+)\\b`).exec(source);
  return match ? Number(match[1].replace(/_/g, "")) : null;
}

// The two sides do not agree on names -- the server calls the magnitude
// ceiling MAX_WIRE_MAGNITUDE and the browser calls it MAX_REASONABLE_MAGNITUDE
// -- which is precisely why a grep for one name would not have found the
// other, and why the drift was invisible.
const LIMITS = [
  {
    label: "equity trade size ceiling",
    schema: (s) => s.$defs.equityTradeSize.maximum,
    serverName: "MAX_EQUITY_TRADE_SIZE",
    clientName: "MAX_EQUITY_TRADE_SIZE",
  },
  {
    label: "wire magnitude ceiling",
    schema: (s) => s.$defs.wireMagnitude.maximum,
    serverName: "MAX_WIRE_MAGNITUDE",
    clientName: "MAX_REASONABLE_MAGNITUDE",
  },
  {
    label: "profile row volume ceiling",
    schema: (s) => s.$defs.profileVolume.maximum,
    serverName: "MAX_PROFILE_VOLUME",
    clientName: "MAX_PROFILE_VOLUME",
  },
  {
    label: "bar volume ceiling",
    schema: (s) => s.$defs.barVolume.maximum,
    serverName: "MAX_BAR_VOLUME",
    clientName: "MAX_BAR_VOLUME",
  },
  {
    label: "maximum valid epoch",
    schema: (s) => s.$defs.epochMs.maximum,
    serverName: "MAX_VALID_EPOCH_MS",
    clientName: "MAX_VALID_EPOCH_MS",
  },
  {
    label: "trade id length",
    schema: (s) => s.$defs.tradeId.maxLength,
    serverName: "MAX_TRADE_ID_LENGTH",
    clientName: "MAX_TRADE_ID_LENGTH",
  },
  {
    label: "reason length",
    schema: (s) => s.$defs.reason.maxLength,
    serverName: "MAX_REASON_LENGTH",
    clientName: "MAX_REASON_LENGTH",
  },
  {
    label: "book depth levels",
    schema: (s) => s.$defs.bookFrame.properties.bids.maxItems,
    serverName: "BOOK_DEPTH_LEVELS",
    clientName: "MAX_BOOK_LEVELS",
  },
  {
    label: "snapshot bars",
    schema: (s) => s.$defs.snapshotFrame.properties.bars.maxItems,
    serverName: "MAX_SNAPSHOT_BARS",
    clientName: "MAX_SNAPSHOT_BARS",
  },
  {
    label: "snapshot trades",
    schema: (s) => s.$defs.snapshotFrame.properties.trades.maxItems,
    serverName: "MAX_SNAPSHOT_TRADES",
    clientName: "MAX_SNAPSHOT_TRADES",
  },
  {
    label: "liquidity columns per frame",
    schema: (s) => s.$defs.liquidityFrame.properties.columns.maxItems,
    serverName: "MAX_LIQUIDITY_COLUMNS",
    clientName: "MAX_LIQUIDITY_COLUMNS",
  },
  {
    label: "liquidity rows per column",
    schema: (s) => s.$defs.liquidityColumn.properties.bid.maxItems,
    serverName: "MAX_LIQUIDITY_ROWS",
    clientName: "MAX_LIQUIDITY_ROWS",
  },
  {
    label: "aggressive prints per snapshot",
    schema: (s) => s.$defs.snapshotFrame.properties.aggressive_prints.maxItems,
    serverName: "MAX_AGGRESSIVE_POOL_PRINTS",
    clientName: "MAX_AGGRESSIVE_POOL_PRINTS",
  },
  {
    label: "liquidity prints per column",
    schema: (s) => s.$defs.liquidityColumn.properties.prints.maxItems,
    serverName: "MAX_LIQUIDITY_PRINTS",
    clientName: "MAX_LIQUIDITY_PRINTS",
  },
  {
    label: "liquidity levels per frame",
    schema: (s) => s.$defs.liquidityFrame.properties.levels.maxItems,
    serverName: "MAX_LIQUIDITY_LEVELS",
    clientName: "MAX_LIQUIDITY_LEVELS",
  },
  {
    label: "aggressive clusters per liquidity frame",
    schema: (s) => s.$defs.liquidityFrame.properties.aggressive.maxItems,
    serverName: "MAX_AGGRESSIVE_EVENTS",
    clientName: "MAX_AGGRESSIVE_EVENTS",
  },
  {
    label: "aggressive history trades per reply",
    schema: (s) => s.$defs.aggressiveHistoryFrame.properties.trades.maxItems,
    serverName: "MAX_AGGRESSIVE_HISTORY_TRADES",
    clientName: "MAX_AGGRESSIVE_HISTORY_TRADES",
  },
  {
    label: "delta profile rows per piece",
    schema: (s) => s.$defs.deltaProfileFrame.properties.rows.maxItems,
    serverName: "MAX_DELTA_PROFILE_ROWS",
    clientName: "MAX_DELTA_PROFILE_ROWS",
  },
  {
    label: "band history columns per reply",
    schema: (s) => s.$defs.bandHistoryFrame.properties.columns.maxItems,
    serverName: "MAX_BAND_HISTORY_COLUMNS",
    clientName: "MAX_BAND_HISTORY_COLUMNS",
  },
  {
    label: "band history rows per column",
    schema: (s) => s.$defs.bandHistoryColumn.properties.bid.maxItems,
    serverName: "MAX_BAND_HISTORY_ROWS",
    clientName: "MAX_BAND_HISTORY_ROWS",
  },
];

function keysOfFrozenBlock(source, opener) {
  const block = new RegExp(`return Object\\.freeze\\(\\{\\s*\\n\\s*${opener}([\\s\\S]*?)\\n\\s*\\}\\);`).exec(source)?.[1];
  return block ? block.match(/^\s*([a-z_]+)[:,]/gm).map((line) => line.trim().replace(/[:,]$/, "")) : null;
}

// Like keysOfFrozenBlock, but the opener does not have to be the block's
// very first field -- it may come after identity fields (type/provider/
// symbol/marketKind/assetClass). Separates plain `key,`/`key: value,` lines
// (required) from `...(cond ? {...} : {})`-style optional spreads.
function fieldsAfterOpener(source, opener) {
  const block = new RegExp(`return Object\\.freeze\\(\\{[\\s\\S]*?\\n\\s*${opener}([\\s\\S]*?)\\n\\s*\\}\\);`).exec(source)?.[1];
  if (!block) return null;
  const required = [];
  const optional = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const spread = /^\.\.\.\(.*?\{ ?([a-zA-Z_]+)/.exec(line);
    if (spread) { optional.push(spread[1]); continue; }
    const plain = /^([a-zA-Z_]+)[:,]/.exec(line);
    if (plain) required.push(plain[1]);
  }
  return { required, optional };
}

describe("ws-frame contract limits", () => {
  test("band history permits zero book and flow cells while retaining finite non-negative bounds", () => {
    const schema = readSchema();
    const { bandHistoryFrame } = require("../../src/server/frames");
    const { parseServerFrame } = require("../helpers/browser-frame-parser").loadBrowserFrames();
    for (const field of ["bid", "ask", "buy", "sell"]) {
      const ref = schema.$defs.bandHistoryColumn.properties[field].items.$ref;
      const bound = schema.$defs[ref.replace("#/$defs/", "")];
      expect(bound.minimum).toBe(0);
      expect(bound.exclusiveMinimum).toBeUndefined();
      expect(bound.maximum).toBe(schema.$defs.equityTradeSize.maximum);
    }
    const identity = { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "SPOT" };
    const args = { requestId: 1, fromTs: 1_000, toTs: 3_000, priceLo: 100, priceHi: 100, columnMs: 1_000, rowWidth: 1, rowLo: 100, rowHi: 100, complete: true };
    const column = { ts: 2_000, bid: [0], ask: [0], buy: [0], sell: [0] };
    const frame = bandHistoryFrame(identity, { ...args, columns: [column] });
    expect(parseServerFrame(frame)?.columns).toEqual([column]);
    expect(() => bandHistoryFrame(identity, { ...args, columns: [{ ...column, bid: [-1] }] })).toThrow();
    expect(() => bandHistoryFrame(identity, { ...args, columns: [{ ...column, sell: [schema.$defs.wireMagnitude.maximum + 1] }] })).toThrow(/ceiling 10000000/);
  });

  test("the contract ships a machine-readable schema alongside its prose", () => {
    expect(fs.existsSync(SCHEMA_PATH)).toBe(true);
    const schema = readSchema();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://terminal-l1-l2/contracts/ws-frame-contract/v1");
  });

  test("the schema covers every frame kind the server can broadcast", () => {
    const covered = readSchema().$defs.serverFrame.oneOf
      .map((entry) => entry.$ref.replace("#/$defs/", ""))
      .sort();

    expect(covered).toEqual([
      "aggressiveHistoryFrame", "analyticsStatusFrame", "bandHistoryFrame", "barFrame", "bookFrame", "candleMonitorFrame", "deltaProfileFrame", "exhaustionShadesFrame", "healthFrame",
      "icebergOrdersFrame", "initiativeBandsFrame", "l2EventsFrame", "l2LadderFrame", "l2ViewFrame", "l2WallsFrame", "liquidityFrame",
      "markerFrame", "markerHistoryFrame", "profileFrame", "selectionFrame", "snapshotFrame", "tradeFrame", "vpinFrame",
    ]);
  });

  // The liquidity level (a "wall") is spelled out in three places -- the schema
  // $defs.liquidityLevel, the server builder frames.js liquidityLevels(), and
  // the browser parser frames.ts parseLiquidityLevel()'s hasExactKeys list.
  // The schema shipped one field short (`eaten` missing, additionalProperties
  // false), so a real frame with `levels` would have failed schema validation
  // while both implementations already agreed on it. Reconcile the field sets
  // the same way this file reconciles the numeric limits.
  test("the liquidity level field set agrees across schema, server builder, and browser parser", () => {
    const schema = readSchema();
    const schemaProps = Object.keys(schema.$defs.liquidityLevel.properties).sort();
    const schemaRequired = [...schema.$defs.liquidityLevel.required].sort();

    const clientSource = fs.readFileSync(CLIENT_FRAMES_PATH, "utf8");
    const clientKeys = /hasExactKeys\(\s*level\s*,\s*\[([^\]]+)\]/.exec(clientSource)?.[1]
      .match(/"([^"]+)"/g)
      ?.map((token) => token.slice(1, -1))
      .sort();

    const serverSource = fs.readFileSync(SERVER_FRAMES_PATH, "utf8");
    const serverBlock = /return Object\.freeze\(\{\s*\n\s*side: level\.side,([\s\S]*?)\n\s*\}\);/.exec(serverSource)?.[1];
    const serverKeys = serverBlock
      ? ["side", ...serverBlock.match(/^\s*([a-z_]+)[:,]/gm).map((line) => line.trim().replace(/[:,]$/, ""))].sort()
      : null;

    expect(schemaRequired).toEqual(schemaProps); // every property is required -- a wall carries all fields
    expect(clientKeys).toEqual(schemaProps);
    expect(serverKeys).toEqual(schemaProps);
    expect(schemaProps).toContain("eaten"); // the field the schema originally dropped
  });

  test("the liquidity column field set agrees across schema, server builder, and browser parser", () => {
    const schema = readSchema();
    const schemaProps = Object.keys(schema.$defs.liquidityColumn.properties).sort();
    const schemaRequired = [...schema.$defs.liquidityColumn.required].sort();
    const listOf = (source) => /const LIQUIDITY_COLUMN_KEYS = (?:Object\.freeze\()?\[([^\]]+)\]/.exec(source)?.[1].match(/"([^"]+)"/g)?.map((token) => token.slice(1, -1)).sort();
    const serverKeys = listOf(fs.readFileSync(SERVER_FRAMES_PATH, "utf8"));
    const clientKeys = listOf(fs.readFileSync(CLIENT_FRAMES_PATH, "utf8"));
    expect(schemaRequired).toEqual(["ask", "bid", "hi", "lo", "ts"]);
    expect(serverKeys).toEqual(schemaProps);
    expect(clientKeys).toEqual(schemaProps);
    expect(schemaProps).toContain("prints_floor");
  });

  test("the liquidity print field set agrees across schema, server builder, and browser parser", () => {
    const schema = readSchema();
    const schemaProps = Object.keys(schema.$defs.liquidityPrint.properties).sort();
    expect([...schema.$defs.liquidityPrint.required].sort()).toEqual(schemaProps);
    const serverBlock = /return Object\.freeze\(\{\s*\n\s*ts: print\.ts,([\s\S]*?)\n\s*\}\);/.exec(fs.readFileSync(SERVER_FRAMES_PATH, "utf8"))?.[1];
    const serverKeys = serverBlock ? ["ts", ...serverBlock.match(/^\s*([a-z_]+)[:,]/gm).map((line) => line.trim().replace(/[:,]$/, ""))].sort() : null;
    const clientKeys = /hasExactKeys\(\s*print\s*,\s*\[([^\]]+)\]/.exec(fs.readFileSync(CLIENT_FRAMES_PATH, "utf8"))?.[1].match(/"([^"]+)"/g)?.map((token) => token.slice(1, -1)).sort();
    expect(serverKeys).toEqual(schemaProps);
    expect(clientKeys).toEqual(schemaProps);
  });

  describe.each(LIMITS)("$label", ({ schema, serverName, clientName }) => {
    const schemaValue = schema(readSchema());
    const serverSource = [SERVER_FRAMES_PATH, SERVER_WIRE_FIELDS_PATH]
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    const clientSource = fs.readFileSync(CLIENT_FRAMES_PATH, "utf8");

    test("is stated by the contract schema", () => {
      expect(Number.isFinite(schemaValue)).toBe(true);
    });

    test(`the server's ${serverName} matches the contract`, () => {
      expect(serverSource.match(new RegExp(`\\bconst ${serverName}\\s*=`, "g"))).toHaveLength(1);
      expect(readNumericConstant(serverSource, serverName)).toBe(schemaValue);
    });

    test(`the browser's ${clientName} matches the contract`, () => {
      expect(readNumericConstant(clientSource, clientName)).toBe(schemaValue);
    });
  });

  // These two are not literals in the server's own file -- it imports them --
  // so they are checked against their defining modules rather than by regex,
  // which would silently read null and pass.
  test("the inline snapshot marker cap and the marker history page cap agree across schema, server and browser", () => {
    const { MAX_SNAPSHOT_MARKERS, MAX_MARKER_HISTORY_ROWS } = require("../../src/server/frames");
    const schema = readSchema();
    const client = fs.readFileSync(CLIENT_FRAMES_PATH, "utf8");
    expect(MAX_SNAPSHOT_MARKERS).toBe(schema.$defs.snapshotFrame.properties.markers.maxItems);
    expect(readNumericConstant(client, "MAX_SNAPSHOT_MARKERS")).toBe(MAX_SNAPSHOT_MARKERS);
    expect(MAX_MARKER_HISTORY_ROWS).toBe(schema.$defs.markerHistoryFrame.properties.rows.maxItems);
    expect(readNumericConstant(client, "MAX_MARKER_HISTORY_ROWS")).toBe(MAX_MARKER_HISTORY_ROWS);
  });

  test("the retained marker cap is the same number on the server and in the browser, and exceeds the inline cap", () => {
    const { DEFAULT_MAX_MARKERS } = require("../../src/server/history");
    const { MAX_SNAPSHOT_MARKERS } = require("../../src/server/frames");
    const hook = fs.readFileSync(path.join(REPO_ROOT, "apps", "web", "src", "hooks", "useMarketData.ts"), "utf8");
    expect(readNumericConstant(hook, "MAX_BINANCE_MARKERS")).toBe(DEFAULT_MAX_MARKERS);
    expect(DEFAULT_MAX_MARKERS).toBeGreaterThan(MAX_SNAPSHOT_MARKERS);
  });

  test("profile bucket cap matches the volume-profile engine the server imports it from", () => {
    const { MAX_PROFILE_BUCKETS } = require("../../src/indicators/volume-profile/volume-profile-engine");
    expect(MAX_PROFILE_BUCKETS).toBe(readSchema().$defs.profileFrame.properties.buckets.maxItems);
    expect(readNumericConstant(fs.readFileSync(CLIENT_FRAMES_PATH, "utf8"), "MAX_PROFILE_BUCKETS"))
      .toBe(MAX_PROFILE_BUCKETS);
  });

  test("Historical Mode never asks the archive for a bin size below the archive study's own floor", () => {
    const { ARCHIVE_MIN_BIN_SIZE_MULTIPLIER } = require("../../src/server/archive-study");
    const client = fs.readFileSync(path.join(REPO_ROOT, "apps", "web", "src", "lib", "archive", "archiveStudyClient.ts"), "utf8");
    const match = /\bARCHIVE_MIN_BIN_SIZE_MULTIPLIER\s*=\s*([0-9.]+)\b/.exec(client);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBe(ARCHIVE_MIN_BIN_SIZE_MULTIPLIER);
  });

  test("snapshot vpin reading cap matches the browser's parser bound", () => {
    expect(readNumericConstant(fs.readFileSync(CLIENT_FRAMES_PATH, "utf8"), "MAX_SNAPSHOT_VPIN_READINGS"))
      .toBe(readSchema().$defs.snapshotFrame.properties.vpin_readings.maxItems);
  });

  test("snapshot VPIN status values agree across schema, server, and browser", () => {
    const values = readSchema().$defs.snapshotFrame.properties.vpin_status.enum;
    const server = fs.readFileSync(SERVER_FRAMES_PATH, "utf8");
    const client = fs.readFileSync(CLIENT_FRAMES_PATH, "utf8");
    expect(values).toEqual(["DISABLED", "IDLE", "WARMING", "READY", "UNAVAILABLE"]);
    for (const value of values) {
      expect(server).toContain(`"${value}"`);
      expect(client).toContain(`"${value}"`);
    }
  });

  test("the aggressive tracker's default event cap is the contract's, and its magnitude ceiling is imported, not copied", () => {
    const { DEFAULT_MAX_EVENTS } = require("../../src/indicators/passive_liquidity/aggressive-orders-tracker");
    expect(DEFAULT_MAX_EVENTS).toBe(readSchema().$defs.liquidityFrame.properties.aggressive.maxItems);
    const trackerSource = fs.readFileSync(path.join(REPO_ROOT, "apps", "runtime", "src", "indicators", "passive_liquidity", "aggressive-orders-tracker.js"), "utf8");
    expect(trackerSource).toMatch(/MAX_WIRE_MAGNITUDE\s*\}\s*=\s*require\("\.\.\/\.\.\/server\/frames"\)/);
    expect(readNumericConstant(trackerSource, "MAX_REPORTED_VOLUME")).toBeNull();
  });

  test("the aggressive event field set agrees across schema, server builder, and browser parser", () => {
    const schema = readSchema();
    const schemaProps = Object.keys(schema.$defs.liquidityAggressive.properties).sort();
    const schemaRequired = [...schema.$defs.liquidityAggressive.required].sort();
    const clientKeys = /hasExactKeys\(\s*event\s*,\s*\[([^\]]+)\]/.exec(fs.readFileSync(CLIENT_FRAMES_PATH, "utf8"))?.[1]
      .match(/"([^"]+)"/g)
      ?.map((token) => token.slice(1, -1))
      .sort();
    const serverBlock = keysOfFrozenBlock(fs.readFileSync(SERVER_FRAMES_PATH, "utf8"), "side: event\\.side,");
    const serverKeys = serverBlock ? ["side", ...serverBlock].sort() : null;
    expect(schemaRequired).toEqual(schemaProps);
    expect(clientKeys).toEqual(schemaProps);
    expect(serverKeys).toEqual(schemaProps);
    expect(schemaProps).toContain("floor");
  });

  test("the aggressive history reply field set agrees across schema, server builder, and browser parser", () => {
    const schema = readSchema();
    const identityKeys = new Set(["type", "symbol", "provider", "marketKind", "assetClass"]);
    const schemaProps = Object.keys(schema.$defs.aggressiveHistoryFrame.properties).filter((key) => !identityKeys.has(key)).sort();
    const schemaRequired = [...schema.$defs.aggressiveHistoryFrame.required].filter((key) => !identityKeys.has(key)).sort();
    const clientKeys = /AGGRESSIVE_HISTORY_FRAME_FIELDS\s*=\s*\[([^\]]+)\]/.exec(fs.readFileSync(CLIENT_FRAMES_PATH, "utf8"))?.[1]
      .match(/"([^"]+)"/g)
      ?.map((token) => token.slice(1, -1))
      .sort();
    const serverKeys = keysOfFrozenBlock(fs.readFileSync(SERVER_FRAMES_PATH, "utf8"), "\\.\\.\\.selection,\\s*\\n\\s*type: \"aggressive_history\",")?.sort();
    expect(schemaRequired).toEqual(schemaProps);
    expect(clientKeys).toEqual(schemaProps);
    expect(serverKeys).toEqual(schemaProps);
    expect(schemaProps).toContain("reason");
  });

  test("the delta profile reasons agree across schema, server builder, and browser parser", () => {
    const schemaReasons = readSchema().$defs.deltaProfileFrame.properties.reason.enum.filter((reason) => reason !== null).sort();
    const { DELTA_PROFILE_REASONS } = require(SERVER_FRAMES_PATH);
    const clientReasons = /DELTA_PROFILE_REASONS\s*=\s*\[([^\]]+)\]/.exec(fs.readFileSync(CLIENT_FRAMES_PATH, "utf8"))?.[1]
      .match(/"([^"]+)"/g)
      ?.map((token) => token.slice(1, -1))
      .sort();
    expect([...DELTA_PROFILE_REASONS].sort()).toEqual(schemaReasons);
    expect(clientReasons).toEqual(schemaReasons);
    expect(schemaReasons).toContain("BAD_REQUEST");
  });

  test("the delta profile piece field set agrees across schema, server builder, and browser parser", () => {
    const schema = readSchema();
    const identityKeys = new Set(["type", "symbol", "provider", "marketKind", "assetClass"]);
    const schemaProps = Object.keys(schema.$defs.deltaProfileFrame.properties).filter((key) => !identityKeys.has(key)).sort();
    const schemaRequired = [...schema.$defs.deltaProfileFrame.required].filter((key) => !identityKeys.has(key)).sort();
    const clientKeys = /DELTA_PROFILE_FRAME_FIELDS\s*=\s*\[([^\]]+)\]/.exec(fs.readFileSync(CLIENT_FRAMES_PATH, "utf8"))?.[1]
      .match(/"([^"]+)"/g)
      ?.map((token) => token.slice(1, -1))
      .sort();
    const serverKeys = keysOfFrozenBlock(fs.readFileSync(SERVER_FRAMES_PATH, "utf8"), "\\.\\.\\.selection,\\s*\\n\\s*type: \"delta_profile\",")?.sort();
    expect(schemaRequired).toEqual(schemaProps);
    expect(clientKeys).toEqual(schemaProps);
    expect(serverKeys).toEqual(schemaProps);
    expect(schemaProps).toContain("pending");
  });

  // The bug that motivated this whole extension: a `backfill` field was
  // added to liquidityWireBody's output and to this schema, but never to
  // the client parser's LIQUIDITY_FRAME_OPTIONAL_FIELDS allowlist. The
  // client rejected every liquidity frame carrying it and forced a
  // reconnect loop -- and this file's existing field-set checks covered
  // liquidityLevel/liquidityColumn/liquidityPrint/liquidityAggressive but
  // never the liquidity frame's own top-level field set, so 300+ passing
  // tests never caught it.
  function liquidityWireBodyFields(source) {
    const block = /function liquidityWireBody\([\s\S]*?\r?\n {2}return \{\r?\n([\s\S]*?)\r?\n {2}\};\r?\n\}/.exec(source)?.[1];
    if (!block) return null;
    const required = [];
    const optional = [];
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      const optionalField = /^\.\.\.\([a-zA-Z]+ === undefined \? \{\} : \{ ([a-z_]+):/.exec(line);
      if (optionalField) { optional.push(optionalField[1]); continue; }
      const plainField = /^([a-z_]+)[:,]/.exec(line);
      if (plainField) required.push(plainField[1]);
    }
    return { required: required.sort(), optional: optional.sort() };
  }

  test("the liquidity frame's own top-level field set agrees across schema, server builder, and browser parser", () => {
    const schema = readSchema();
    const identityKeys = new Set(["type", "symbol", "provider", "marketKind", "assetClass"]);
    const schemaRequired = [...schema.$defs.liquidityFrame.required].filter((key) => !identityKeys.has(key)).sort();
    const schemaOptional = Object.keys(schema.$defs.liquidityFrame.properties)
      .filter((key) => !identityKeys.has(key) && !schema.$defs.liquidityFrame.required.includes(key))
      .sort();

    const server = liquidityWireBodyFields(fs.readFileSync(SERVER_FRAMES_PATH, "utf8"));
    const clientSource = fs.readFileSync(CLIENT_FRAMES_PATH, "utf8");
    const clientRequired = /const LIQUIDITY_FRAME_FIELDS = \[([^\]]+)\]/.exec(clientSource)?.[1]
      .match(/"([^"]+)"/g)?.map((token) => token.slice(1, -1)).sort();
    const clientOptional = /const LIQUIDITY_FRAME_OPTIONAL_FIELDS = \[([^\]]+)\]/.exec(clientSource)?.[1]
      .match(/"([^"]+)"/g)?.map((token) => token.slice(1, -1)).sort();

    expect(server).not.toBeNull();
    expect(schemaRequired).toEqual(server.required);
    expect(schemaOptional).toEqual(server.optional);
    expect(clientRequired).toEqual(server.required);
    expect(clientOptional).toEqual(server.optional);
    expect(schemaOptional).toContain("backfill");
  });

  // The other frame types this file's field-set checks never covered
  // (trade/marker/bar/health) -- part of the same closure-audit sweep that
  // added the liquidity frame check above. These are the highest-traffic
  // frame types on the wire, so the same silent-drift risk applies to them.
  test("the trade frame field set agrees across schema, server builder, and browser parser", () => {
    const schema = readSchema();
    const identityKeys = new Set(["type", "symbol", "provider", "marketKind", "assetClass"]);
    const schemaProps = Object.keys(schema.$defs.tradeFrame.properties).filter((key) => !identityKeys.has(key)).sort();
    const schemaRequired = [...schema.$defs.tradeFrame.required].filter((key) => !identityKeys.has(key)).sort();

    const server = fieldsAfterOpener(fs.readFileSync(SERVER_FRAMES_PATH, "utf8"), "ts_exchange: tsExchange,");
    const serverKeys = server ? ["ts_exchange", ...server.required].sort() : null;
    const clientKeys = /const TRADE_FRAME_FIELDS = \[([^\]]+)\]/.exec(fs.readFileSync(CLIENT_FRAMES_PATH, "utf8"))?.[1]
      .match(/"([^"]+)"/g)?.map((token) => token.slice(1, -1)).sort();

    expect(schemaProps.filter((key) => key !== "auction")).toEqual(schemaRequired);
    expect(schemaProps.filter((key) => !schemaRequired.includes(key))).toEqual(["auction"]);
    expect(serverKeys).toEqual(schemaRequired);
    expect(clientKeys).toEqual(schemaRequired);
    expect(server.optional).toEqual([]);
    expect(schema.$defs.tradeFrame.properties.auction.const).toBe(true);
    expect(schema.$defs.tradeFrame.dependentSchemas.auction.properties.provider.const).toBe("DXFEED");
    const serverSource = fs.readFileSync(SERVER_FRAMES_PATH, "utf8");
    const dxfeedBuilder = serverSource.slice(serverSource.indexOf("function dxfeedTradeFrame("), serverSource.indexOf("function dxfeedMarkerFrame("));
    const clientSource = fs.readFileSync(CLIENT_FRAMES_PATH, "utf8");
    expect(dxfeedBuilder).toContain("...(auction ? { auction: true } : {})");
    expect(clientSource).toContain('identity.provider === "DXFEED" ? ["auction"] : []');
  });

  test("the marker frame field set agrees across schema and browser parser (the deprecated baseline fields are genuinely never emitted)", () => {
    const schema = readSchema();
    const identityKeys = new Set(["type", "symbol", "provider", "marketKind", "assetClass"]);
    const schemaProps = Object.keys(schema.$defs.markerFrame.properties).filter((key) => !identityKeys.has(key)).sort();
    const schemaRequired = [...schema.$defs.markerFrame.required].filter((key) => !identityKeys.has(key)).sort();
    const schemaOptional = schemaProps.filter((key) => !schemaRequired.includes(key)).sort();

    const serverSource = fs.readFileSync(SERVER_FRAMES_PATH, "utf8");
    const server = fieldsAfterOpener(serverSource, "ts_exchange: timestampToWireNumber\\(trade\\.ts_exchange,");
    const serverKeys = server ? ["ts_exchange", ...server.required].sort() : null;
    const clientSource = fs.readFileSync(CLIENT_FRAMES_PATH, "utf8");
    const clientRequired = /const TRADE_FRAME_FIELDS = \[([^\]]+)\]/.exec(clientSource)?.[1]
      .match(/"([^"]+)"/g)?.map((token) => token.slice(1, -1)).sort();
    const clientOptional = /const MARKER_FRAME_OPTIONAL_FIELDS = \[([^\]]+)\]/.exec(clientSource)?.[1]
      .match(/"([^"]+)"/g)?.map((token) => token.slice(1, -1)).sort();

    expect(schemaRequired).toEqual(clientRequired);
    expect(serverKeys).toEqual(schemaRequired);
    expect(clientOptional).toEqual(schemaOptional);
    expect(server.optional).toEqual([]); // baseline_log_median/mad: deprecated, no builder emits them
  });

  test("the bar frame field set agrees across schema, every server builder (live/REST-backfill/dxFeed), and browser parser", () => {
    const schema = readSchema();
    const identityKeys = new Set(["type", "symbol", "provider", "marketKind", "assetClass"]);
    const schemaProps = Object.keys(schema.$defs.barFrame.properties).filter((key) => !identityKeys.has(key)).sort();
    const schemaRequired = [...schema.$defs.barFrame.required].filter((key) => !identityKeys.has(key)).sort();
    const schemaOptional = schemaProps.filter((key) => !schemaRequired.includes(key)).sort();

    const serverSource = fs.readFileSync(SERVER_FRAMES_PATH, "utf8");
    const live = fieldsAfterOpener(serverSource, "interval_ms: intervalMs,\\s*\\n\\s*ts_open: openTime,");
    const rest = fieldsAfterOpener(serverSource, "interval_ms: intervalMs,\\s*\\n\\s*ts_open: row\\.openTime,");
    const dxfeed = fieldsAfterOpener(serverSource, "interval_ms: DXFEED_CANDLE_INTERVAL_MS,\\s*\\n\\s*ts_open: tsOpen,");
    const requiredKeys = (result) => result
      ? ["interval_ms", "ts_open", ...result.required.filter((key) => key !== "reconstructed")].sort()
      : null;

    expect(requiredKeys(live)).toEqual(schemaRequired);
    expect(requiredKeys(rest)).toEqual(schemaRequired);
    expect(requiredKeys(dxfeed)).toEqual(schemaRequired);
    // reconstructed is real: restKlineRowToBarFrame emits it unconditionally
    // (every REST-backfilled candle is reconstructed), so it's required
    // *within that one builder* but optional from the wire type's own
    // perspective, since the live/dxFeed builders never set it.
    expect(rest?.required).toContain("reconstructed");
    expect(schemaOptional).toContain("reconstructed");
    expect(live?.optional.sort()).toEqual(["buy_volume"]);
    expect(dxfeed?.optional.sort()).toEqual(["buy_volume", "sell_volume"]);

    const clientSource = fs.readFileSync(CLIENT_FRAMES_PATH, "utf8");
    const clientRequired = /const BAR_FRAME_FIELDS = \[([^\]]+)\]/.exec(clientSource)?.[1]
      .match(/"([^"]+)"/g)?.map((token) => token.slice(1, -1)).sort();
    const clientBinanceOptional = /const BINANCE_BAR_OPTIONAL_FIELDS = \[([^\]]+)\]/.exec(clientSource)?.[1]
      .match(/"([^"]+)"/g)?.map((token) => token.slice(1, -1)).sort();
    const clientDxfeedOptional = /const DXFEED_BAR_OPTIONAL_FIELDS = \[([^\]]+)\]/.exec(clientSource)?.[1]
      .match(/"([^"]+)"/g)?.map((token) => token.slice(1, -1)).sort();
    expect(clientRequired).toEqual(schemaRequired);
    expect(clientBinanceOptional).toEqual(schemaOptional);
    expect(clientDxfeedOptional).toEqual(["buy_volume", "sell_volume"]);
  });

  test("the health frame field set agrees across schema, server builders (Binance/dxFeed), and browser parser", () => {
    const schema = readSchema();
    const identityKeys = new Set(["type", "symbol", "provider", "marketKind", "assetClass"]);
    const schemaProps = Object.keys(schema.$defs.healthFrame.properties).filter((key) => !identityKeys.has(key)).sort();
    const schemaRequired = [...schema.$defs.healthFrame.required].filter((key) => !identityKeys.has(key)).sort();
    const schemaOptional = schemaProps.filter((key) => !schemaRequired.includes(key)).sort();

    const serverSource = fs.readFileSync(SERVER_FRAMES_PATH, "utf8");
    const binance = fieldsAfterOpener(serverSource, "marketKind,\\s*\\n\\s*recoveryState,\\s*\\n\\s*stale,");
    const dxfeed = fieldsAfterOpener(serverSource, "assetClass,\\s*\\n\\s*recoveryState,\\s*\\n\\s*stale,");
    const requiredKeys = (result) => result ? ["recoveryState", "stale", ...result.required].sort() : null;
    expect(requiredKeys(binance)).toEqual(schemaRequired);
    expect(requiredKeys(dxfeed)).toEqual(schemaRequired);
    expect(binance?.optional.sort()).toEqual(["reason", "recordingLatestTs", "recordingStale"].sort());
    expect(dxfeed?.optional.sort()).toEqual(["printsQuiet", "reason"]);

    const clientSource = fs.readFileSync(CLIENT_FRAMES_PATH, "utf8");
    const clientRequired = /const HEALTH_FRAME_FIELDS = \[([^\]]+)\]/.exec(clientSource)?.[1]
      .match(/"([^"]+)"/g)?.map((token) => token.slice(1, -1)).sort();
    const clientBinanceOptional = /const BINANCE_HEALTH_OPTIONAL_FIELDS = \[([^\]]+)\]/.exec(clientSource)?.[1]
      .match(/"([^"]+)"/g)?.map((token) => token.slice(1, -1)).sort();
    const clientDxfeedOptional = /const DXFEED_HEALTH_OPTIONAL_FIELDS = \[([^\]]+)\]/.exec(clientSource)?.[1]
      .match(/"([^"]+)"/g)?.map((token) => token.slice(1, -1)).sort();
    expect(clientRequired).toEqual(schemaRequired);
    expect(clientBinanceOptional).toEqual(binance?.optional.sort());
    expect(clientDxfeedOptional).toEqual(dxfeed?.optional.sort());
    // schemaOptional is the union across both providers -- printsQuiet is
    // dxFeed-only and reason is shared, so it's neither client list alone.
    expect(schemaOptional).toEqual([...new Set([...clientBinanceOptional, ...clientDxfeedOptional])].sort());
  });

  // The regex helper is the weak point of this file: if it silently returned
  // null for a renamed constant, every assertion above would compare null to
  // null-ish and could pass for the wrong reason. Pin that it actually reads.
  test("the constant reader returns a number for a present name and null for an absent one", () => {
    const source = "const MAX_THING = 1_234;\n";
    expect(readNumericConstant(source, "MAX_THING")).toBe(1234);
    expect(readNumericConstant(source, "MAX_MISSING")).toBeNull();
    expect(readNumericConstant(source, "MAX_THING")).not.toBeNull();
  });
});

// Report 61 P4a: the opt-in L2 channels. The server's bounds live in
// l2-frames.js and are read back against the schema here. The browser's parser
// arrives in P4b and joins these checks then; until it does, no browser is sent
// these frames, because the server only sends them to a client that declared
// the capability.
describe("ws-frame contract: the L2 channels (report 61 P4a)", () => {
  const L2_FRAMES_PATH = path.join(REPO_ROOT, "apps", "runtime", "src", "server", "l2-frames.js");
  const l2 = require("../../src/server/l2-frames");
  const { frameKindOf, FRAME_KIND_INCREMENTAL, FRAME_KIND_LATEST_STATE } = require("../../src/server/frames");
  const identity = { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" };
  const segment = { id: "PERPETUAL:BTCUSDT:1000:LIVE", state: "LIVE" };
  const detail = {
    lifeMs: 5, firstShrinkTs: 1_000, firstShrinkExact: true, reachedAtFirstShrink: true, traded: 1, absorbed: 1, swept: 0, hidden: 0,
    cleared: 0, fillRatio: 0.5, crossSide: 0, crossSideShare: 0, endDistanceRows: 1, endDistancePct: 0.1, clearedByTrades: false,
    continuity: { gapMs: 10 }, repeats: 2, repeatsComplete: true, evidenceGap: false,
  };
  const wall = {
    id: 3, side: "bid", row: 10, span: 1, startTs: 1_000, endTs: 2_000, size: 5, peak: 9, endedBy: "filled", ratio: 3, chain: 0,
    fill: 0.5, eaten: 0.5, absorbing: false, detail,
  };
  const events = [
    { event: "segment", ts: 1_000, segment: segment.id, state: "LIVE", cause: "SEED" },
    { event: "wall_born", ts: 1_000, wall: 3, side: "bid", row: 10, span: 1, size: 9 },
    { event: "wall_trade", ts: 1_100, wall: 3, mode: "absorbed", price: 100, size: 1 },
    { event: "wall_hidden", ts: 1_150, wall: 3, volume: 1 },
    { event: "wall_shrink", ts: 1_200, wall: 3, exact: true, reached: true },
    { event: "trade", ts: 1_300, side: "ask", aggressor: "buy", mode: "swept", price: 101, size: 1, late: false },
    { event: "hidden", ts: 1_400, side: "bid", price: 100, volume: 1 },
    { event: "wall_end", ts: 2_000, wall: 3, endedBy: "filled", distanceRows: 1 },
  ];
  const built = {
    l2ViewFrame: l2.l2ViewFrame(identity, { lane: 1, tier: "deep", ts: 2_000, seq: 1, reset: true, rowWidth: 1, columnMs: 2_000, columns: [{ ts: 2_000, lo: 1, hi: 2, bid: [[0, 1]], ask: [[1, 1]] }], segment }),
    l2WallsFrame: l2.l2WallsFrame(identity, { ts: 2_000, seq: 1, reset: true, rowWidth: 1, walls: [wall], segment }),
    l2EventsFrame: l2.l2EventsFrame(identity, { ts: 2_000, seq: 8, reset: false, events, missed: 0 }),
    l2LadderFrame: l2.l2LadderFrame(identity, { ts: 2_000, depth: 50, bids: [[100, 1]], asks: [[101, 1]], segment }),
  };
  const identityKeys = new Set(["type", "symbol", "provider", "marketKind", "assetClass"]);
  const propsOf = (def) => Object.keys(def.properties).filter((key) => !identityKeys.has(key)).sort();
  const requiredOf = (def) => def.required.filter((key) => !identityKeys.has(key)).sort();

  test.each(Object.keys(built))("%s: the builder emits exactly the schema's fields, all of them required", (name) => {
    const schema = readSchema();
    const keys = Object.keys(built[name]).filter((key) => !identityKeys.has(key)).sort();
    expect(keys).toEqual(propsOf(schema.$defs[name]));
    expect(keys).toEqual(requiredOf(schema.$defs[name]));
    expect(schema.$defs[name].properties.type.const).toBe(built[name].type);
  });

  test("a wall is every liquidity level field plus id and detail, lane only for a client that declared l2_walls_lanes, and the detail's fields are the schema's", () => {
    const schema = readSchema();
    const [wire] = built.l2WallsFrame.walls;
    expect(Object.keys(wire).sort()).toEqual(Object.keys(schema.$defs.l2Wall.properties).filter((key) => key !== "lane").sort());
    expect([...schema.$defs.l2Wall.required].sort()).toEqual(Object.keys(wire).sort());
    const laned = l2.l2WallsFrame(identity, { ts: 2_000, seq: 1, reset: true, rowWidth: 1, walls: [wall, { ...wall, id: 10_000_003, lane: 1 }], segment, lanes: true });
    expect(laned.walls.map((entry) => Object.keys(entry).sort())).toEqual([0, 1].map(() => Object.keys(schema.$defs.l2Wall.properties).sort()));
    const { parseServerFrame } = require("../helpers/browser-frame-parser").loadBrowserFrames();
    expect(parseServerFrame(JSON.parse(JSON.stringify(laned)))).toEqual(JSON.parse(JSON.stringify(laned)));
    expect(Object.keys(schema.$defs.l2Wall.properties).filter((key) => key !== "id" && key !== "lane" && key !== "detail").sort())
      .toEqual(Object.keys(schema.$defs.liquidityLevel.properties).sort());
    const detailSchema = schema.$defs.l2WallDetail.oneOf[0];
    expect(Object.keys(wire.detail).sort()).toEqual(Object.keys(detailSchema.properties).sort());
    expect([...detailSchema.required].sort()).toEqual(Object.keys(detailSchema.properties).sort());
  });

  test("every event kind the builder accepts is in the schema with exactly the builder's fields", () => {
    const schema = readSchema();
    const byKind = Object.fromEntries(schema.$defs.l2Event.oneOf.map((entry) => [entry.properties.event.const, entry]));
    expect(Object.keys(byKind).sort()).toEqual([...l2.L2_EVENT_KINDS].sort());
    for (const event of built.l2EventsFrame.events) {
      expect(Object.keys(event).sort()).toEqual(Object.keys(byKind[event.event].properties).sort());
      expect([...byKind[event.event].required].sort()).toEqual(Object.keys(byKind[event.event].properties).sort());
    }
  });

  test("the segment's fields and states agree", () => {
    const schema = readSchema();
    const segmentSchema = schema.$defs.l2Segment.oneOf[0];
    expect(Object.keys(built.l2LadderFrame.segment).sort()).toEqual(Object.keys(segmentSchema.properties).sort());
    expect(segmentSchema.properties.state.enum).toEqual(["LIVE", "GAP"]);
    expect(schema.$defs.l2ViewFrame.properties.tier.enum).toEqual([...l2.L2_VIEW_TIERS]);
  });

  test.each([
    ["lane", (s) => s.$defs.l2ViewFrame.properties.lane.maximum, "MAX_L2_LANE"],
    ["walls per frame", (s) => s.$defs.l2WallsFrame.properties.walls.maxItems, "MAX_L2_WALLS"],
    ["removed ids per frame", (s) => s.$defs.l2WallsFrame.properties.removed.maxItems, "MAX_L2_REMOVED"],
    ["events per frame", (s) => s.$defs.l2EventsFrame.properties.events.maxItems, "MAX_L2_EVENTS"],
    ["ladder levels a side", (s) => s.$defs.l2LadderFrame.properties.bids.maxItems, "MAX_L2_LADDER_LEVELS"],
    ["ladder depth", (s) => s.$defs.l2LadderFrame.properties.depth.maximum, "MAX_L2_LADDER_LEVELS"],
    ["segment id length", (s) => s.$defs.l2Segment.oneOf[0].properties.id.maxLength, "MAX_L2_SEGMENT_ID_LENGTH"],
  ])("the %s bound is the schema's, stated once in l2-frames.js and once in the browser parser", (_label, schemaValue, serverName) => {
    const source = fs.readFileSync(L2_FRAMES_PATH, "utf8");
    const client = fs.readFileSync(CLIENT_FRAMES_PATH, "utf8");
    const value = schemaValue(readSchema());
    expect(Number.isFinite(value)).toBe(true);
    expect(source.match(new RegExp(`\\bconst ${serverName}\\s*=`, "g"))).toHaveLength(1);
    expect(readNumericConstant(source, serverName)).toBe(value);
    expect(l2[serverName]).toBe(value);
    expect(client.match(new RegExp(`\\bconst ${serverName}\\s*=`, "g"))).toHaveLength(1);
    expect(readNumericConstant(client, serverName)).toBe(value);
  });

  test("the browser declares every capability the server accepts, and names the same four L2 channels", () => {
    const { CLIENT_CAPABILITIES, L2_CHANNELS } = require("../helpers/browser-frame-parser").loadBrowserFrames();
    expect([...CLIENT_CAPABILITIES].sort()).toEqual([...l2.CAPABILITY_FLAGS].sort());
    expect([...L2_CHANNELS]).toEqual([...l2.L2_CHANNELS]);
  });

  test.each(Object.keys(built))("%s: the browser parser admits the builder's output and returns every field unchanged", (name) => {
    const { parseServerFrame } = require("../helpers/browser-frame-parser").loadBrowserFrames();
    const parsed = parseServerFrame(JSON.parse(JSON.stringify(built[name])));
    expect(parsed).toEqual(JSON.parse(JSON.stringify(built[name])));
  });

  test("every capability the server accepts gates exactly the kind of the same name, or is a variant of one the schema names, and the schema says so", () => {
    const schema = readSchema();
    const defs = schema.$defs.serverFrame.oneOf.map((entry) => schema.$defs[entry.$ref.replace("#/$defs/", "")]);
    const gated = Object.fromEntries(defs.filter((def) => def["x-capability"] !== undefined).map((def) => [def.properties.type.const, def["x-capability"]]));
    const variants = Object.fromEntries(defs.filter((def) => def["x-capability-variant"] !== undefined).map((def) => [def["x-capability-variant"], def.properties.type.const]));
    expect(variants).toEqual({ l2_walls_lanes: "l2_walls" });
    expect([...Object.values(gated), ...Object.keys(variants)].sort()).toEqual([...l2.CAPABILITY_FLAGS].sort());
    for (const [type, capability] of Object.entries(gated)) expect(capability).toBe(type);
    expect(Object.keys(gated).sort()).toEqual(["exhaustion_shades", "iceberg_orders", "initiative_bands", "l2_events", "l2_ladder", "l2_view", "l2_walls", "marker_history"]);
  });

  test("walls per frame is lane 0's level cap plus each wider lane's own, so a full set always fits one reset; a client without lanes keeps lane 0's cap", () => {
    const { MAX_LIQUIDITY_LEVELS } = require("../../src/server/frames");
    expect(l2.MAX_L2_WALLS).toBe(MAX_LIQUIDITY_LEVELS + l2.MAX_L2_LANE * l2.MAX_L2_LANE_WALLS);
    expect(l2.MAX_L2_LEGACY_WALLS).toBe(MAX_LIQUIDITY_LEVELS);
  });

  test("the chains are incremental frames and the ladder is latest state, for slow-client handling", () => {
    expect(FRAME_KIND_INCREMENTAL).toEqual(expect.any(String));
    expect(frameKindOf(built.l2ViewFrame)).toBe(FRAME_KIND_INCREMENTAL);
    expect(frameKindOf(built.l2WallsFrame)).toBe(FRAME_KIND_INCREMENTAL);
    expect(frameKindOf(built.l2EventsFrame)).toBe(FRAME_KIND_INCREMENTAL);
    expect(frameKindOf(built.l2LadderFrame)).toBe(FRAME_KIND_LATEST_STATE);
  });
});

// A2.21 / L1L2-V2-062 and L1L2-V2-068. Two more values that both sides of the
// boundary must agree on, under different names, with nothing reconciling them.
//
// L1L2-V2-062's original form -- an entire scoring algorithm duplicated, with
// MIN_MEANINGFUL_LOG_MAD and MAD_CONSTANT retyped as literals -- dissolved when
// Phase 15 replaced statistical scoring with magnitude ranking. What survives
// is the retention geometry: both sides key markers as
// `${floor(ts / bucketMs)}:${side}` and both hardcode the bucket size and the
// per-bucket-side cap. If they drift, the browser keeps a different set of
// markers than the server believes it sent, and nothing anywhere errors.
//
// L1L2-V2-068 is narrower and deliberate: the sensitivity dial is a zOn the
// server never sees, so the client MUST re-derive activation. What must not
// differ is the arithmetic -- the server implies its ratio from
// DEFAULT_Z_OFF / DEFAULT_Z_ON while the client hardcodes the quotient.
describe("cross-boundary constants that are not wire fields", () => {
  const CLIENT_MARKER_RETENTION = path.join(REPO_ROOT, "apps", "web", "src", "lib", "chart", "markerRetention.ts");
  const CLIENT_VPIN_SENSITIVITY = path.join(REPO_ROOT, "apps", "web", "src", "lib", "indicators", "vpin-cloud", "vpinSensitivity.ts");

  test("marker retention geometry matches on both sides", () => {
    const { MARKER_BUCKET_MS, MARKERS_PER_BUCKET_SIDE } = require("../../src/indicators/large-trade/large-trade-detection");
    const client = fs.readFileSync(CLIENT_MARKER_RETENTION, "utf8");

    expect(readNumericConstant(client, "DEFAULT_MARKER_COVERAGE_BUCKET_MS")).toBe(MARKER_BUCKET_MS);
    expect(readNumericConstant(client, "DEFAULT_MAX_MARKERS_PER_BUCKET_SIDE")).toBe(MARKERS_PER_BUCKET_SIDE);
  });

  test("the client's hysteresis ratio is the server's zOff/zOn, not an independent constant", () => {
    const { DEFAULT_Z_ON, DEFAULT_Z_OFF } = require("../../src/indicators/vpin/vpin-engine");
    const client = fs.readFileSync(CLIENT_VPIN_SENSITIVITY, "utf8");
    const ratio = Number(/DEFAULT_ZOFF_RATIO\s*=\s*([0-9.]+)/.exec(client)[1]);

    expect(ratio).toBeCloseTo(DEFAULT_Z_OFF / DEFAULT_Z_ON, 10);
  });

  // Both sides compute strength as min(1, |zActive| / (zOn * 3)). The 3 is a
  // literal in two files; if one changes, the cloud's opacity silently stops
  // matching the reading the backend produced.
  test("the strength divisor is the same literal on both sides", () => {
    const server = fs.readFileSync(path.join(REPO_ROOT, "apps", "runtime", "src", "indicators", "vpin", "vpin-engine.js"), "utf8");
    const client = fs.readFileSync(CLIENT_VPIN_SENSITIVITY, "utf8");
    const divisor = (source) => Number(/zOn\s*\*\s*(\d+)/.exec(source)[1]);

    expect(divisor(client)).toBe(divisor(server));
  });
});
