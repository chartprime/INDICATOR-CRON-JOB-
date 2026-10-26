const fs = require("fs");
const os = require("os");
const path = require("path");
const { saveInitiativeHistory, saveInitiativeHistoryAsync, loadInitiativeHistory, dropInitiativeHistory, initiativeHistoryPath, MAX_INITIATIVE_FILE_BYTES, INITIATIVE_STORE_VERSION } = require("../../../src/indicators/initiative/initiative-store");

const band = { id: "60000|down|1", candleMs: 60_000, side: "down", dominant: "sellers", dominantShare: 0.75, score: 4, facts: { efficiency: { yes: true, value: 0.714 }, closes: { yes: true, value: 2 }, burst: { yes: false, value: 0.8 }, delta: { yes: true, rank: 1, share: 0.75 }, prints: { yes: true, rank: 0.833, perCandle: 1 } }, pivotTs: 1, pivotPrice: 108, frozenTs: 4, frozenPrice: 105.5, windowCandles: 3, atr: 1, legExtremePrice: 105, legExtremeTs: 4, legEndTs: null, updatedAt: 5 };
const scales = [{ candleMs: 60_000, rowWidth: 1 }];

describe("indicators/initiative/initiative-store", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "initiative-store-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("the file is <pair>.initiative.json with unsafe characters replaced, in its own directory", () => {
    expect(path.basename(initiativeHistoryPath(dir, "PERPETUAL:BTCUSDT"))).toBe("PERPETUAL_BTCUSDT.initiative.json");
    expect(path.basename(initiativeHistoryPath(dir, "FUTURE:/NQZ26:XCME"))).toBe("FUTURE_NQZ26_XCME.initiative.json");
    expect(() => initiativeHistoryPath(dir, "")).toThrow(/pairKey/);
  });

  test("save then load round-trips the bands and the scales, atomically, leaving no temp file", async () => {
    const sync = saveInitiativeHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", savedAt: 10, rulesVersion: 1, coveredUntil: 9, coveredFrom: 2, bands: [band], scales });
    expect(sync).toMatchObject({ ok: true, file: initiativeHistoryPath(dir, "FUTURE:/NQZ26:XCME") });
    expect(loadInitiativeHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", rulesVersion: 1 })).toEqual({ savedAt: 10, coveredUntil: 9, coveredFrom: 2, bands: [band], scales });
    const async = await saveInitiativeHistoryAsync({ dir, pairKey: "FUTURE:/NQZ26:XCME", savedAt: 11, rulesVersion: 1, bands: [], scales: [] });
    expect(async.ok).toBe(true);
    expect(loadInitiativeHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", rulesVersion: 1 })).toEqual({ savedAt: 11, coveredUntil: null, coveredFrom: null, bands: [], scales: [] });
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(sync.file, "utf8")).version).toBe(INITIATIVE_STORE_VERSION);
  });

  test("a background save that was superseded before its rename leaves the file as it was and no temp file behind", async () => {
    saveInitiativeHistory({ dir, pairKey: "P:S", savedAt: 1, rulesVersion: 1, bands: [band], scales: [] });
    let asked = 0;
    const result = await saveInitiativeHistoryAsync({ dir, pairKey: "P:S", savedAt: 2, rulesVersion: 1, bands: [], scales: [], superseded: () => { asked += 1; return true; } });
    expect(result).toEqual({ ok: false, reason: "SUPERSEDED" });
    expect(asked).toBe(1);
    expect(loadInitiativeHistory({ dir, pairKey: "P:S", rulesVersion: 1 })).toMatchObject({ savedAt: 1, bands: [band] });
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a payload over the budget is refused before anything is written", async () => {
    const big = Array.from({ length: 2000 }, (_, i) => ({ ...band, id: `b${i}` }));
    expect(saveInitiativeHistory({ dir, pairKey: "P:X", rulesVersion: 1, bands: big, scales: [], maxBytes: 1000 })).toMatchObject({ ok: false, reason: "OVER_BUDGET" });
    expect(await saveInitiativeHistoryAsync({ dir, pairKey: "P:X", rulesVersion: 1, bands: big, scales: [], maxBytes: 1000 })).toMatchObject({ ok: false, reason: "OVER_BUDGET" });
    expect(fs.existsSync(initiativeHistoryPath(dir, "P:X"))).toBe(false);
    expect(MAX_INITIATIVE_FILE_BYTES).toBe(8 * 1024 * 1024);
  });

  test("a missing file loads as null without a rejection; a bad one is rejected with a reason and loads as null", () => {
    const rejections = [];
    const onReject = (reason) => rejections.push(reason);
    expect(loadInitiativeHistory({ dir, pairKey: "P:X", rulesVersion: 1, onReject })).toBeNull();
    const file = initiativeHistoryPath(dir, "P:X");
    fs.writeFileSync(file, "{not json");
    expect(loadInitiativeHistory({ dir, pairKey: "P:X", rulesVersion: 1, onReject })).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: INITIATIVE_STORE_VERSION, pairKey: "P:Y", savedAt: 1, rulesVersion: 1, bands: [], scales: [] }));
    expect(loadInitiativeHistory({ dir, pairKey: "P:X", rulesVersion: 1, onReject })).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: INITIATIVE_STORE_VERSION + 1, pairKey: "P:X", savedAt: 1, rulesVersion: 1, bands: [], scales: [] }));
    expect(loadInitiativeHistory({ dir, pairKey: "P:X", rulesVersion: 1, onReject })).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: INITIATIVE_STORE_VERSION, pairKey: "P:X", savedAt: 1, rulesVersion: 2, bands: [], scales: [] }));
    expect(loadInitiativeHistory({ dir, pairKey: "P:X", rulesVersion: 1, onReject })).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: INITIATIVE_STORE_VERSION, pairKey: "P:X", savedAt: 1, rulesVersion: 1, bands: {}, scales: [] }));
    expect(loadInitiativeHistory({ dir, pairKey: "P:X", rulesVersion: 1, onReject })).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: INITIATIVE_STORE_VERSION, pairKey: "P:X", savedAt: 1, rulesVersion: 1, bands: [], scales: {} }));
    expect(loadInitiativeHistory({ dir, pairKey: "P:X", rulesVersion: 1, onReject })).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: INITIATIVE_STORE_VERSION, pairKey: "P:X", savedAt: 1.5, rulesVersion: 1, bands: [], scales: [] }));
    expect(loadInitiativeHistory({ dir, pairKey: "P:X", rulesVersion: 1, onReject })).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: INITIATIVE_STORE_VERSION, pairKey: "P:X", savedAt: 1, rulesVersion: 1, coveredUntil: "x", bands: [], scales: [] }));
    expect(loadInitiativeHistory({ dir, pairKey: "P:X", rulesVersion: 1, onReject })).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: INITIATIVE_STORE_VERSION, pairKey: "P:X", savedAt: 1, rulesVersion: 1, coveredFrom: 1.5, bands: [], scales: [] }));
    expect(loadInitiativeHistory({ dir, pairKey: "P:X", rulesVersion: 1, onReject })).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: INITIATIVE_STORE_VERSION, pairKey: "P:X", savedAt: 1, rulesVersion: 1, bands: [], scales: [] }));
    expect(loadInitiativeHistory({ dir, pairKey: "P:X", rulesVersion: 1, maxFileBytes: 10, onReject })).toBeNull();
    fs.rmSync(file);
    fs.mkdirSync(file);
    expect(loadInitiativeHistory({ dir, pairKey: "P:X", rulesVersion: 1, onReject })).toBeNull();
    expect(rejections).toEqual(["MALFORMED", "FOREIGN", "FOREIGN", "STALE_RULES", "MALFORMED", "MALFORMED", "MALFORMED", "MALFORMED", "MALFORMED", "TOO_LARGE", "NOT_A_FILE"]);
  });

  test("drop removes the file and reports true when nothing is there", () => {
    saveInitiativeHistory({ dir, pairKey: "P:X", rulesVersion: 1, bands: [], scales: [] });
    expect(dropInitiativeHistory({ dir, pairKey: "P:X" })).toBe(true);
    expect(fs.existsSync(initiativeHistoryPath(dir, "P:X"))).toBe(false);
    expect(dropInitiativeHistory({ dir, pairKey: "P:X" })).toBe(true);
  });
});
