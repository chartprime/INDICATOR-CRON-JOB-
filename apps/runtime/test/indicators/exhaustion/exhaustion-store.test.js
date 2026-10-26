const fs = require("fs");
const os = require("os");
const path = require("path");
const { saveExhaustionHistory, saveExhaustionHistoryAsync, loadExhaustionHistory, dropExhaustionHistory, exhaustionHistoryPath, MAX_EXHAUSTION_FILE_BYTES, EXHAUSTION_STORE_VERSION } = require("../../../src/indicators/exhaustion/exhaustion-store");

const shade = { id: "60000|buyers|1", candleMs: 60_000, side: "buyers", status: "held", intensity: 1, score: 3, readings: { rate: true, progress: false, delta: true, divergence: false, prints: true, book: false }, values: { rate: 0.211, progress: 0, delta: -0.4, divergence: -1.4, prints: null, book: 0.5 }, raw: { own: 3, other: 7, legOwn: 14.222, moved: 0, legMoved: 1.778, big: 0, legBig: 0, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 }, startTs: 1, endTs: 2, extremeTs: 1, extremePrice: 104, legStartTs: 0, legStartPrice: 101, legSize: 3, efficiency: 1, atr: 1, judgedAt: 5, updatedAt: 5 };
const scales = [{ candleMs: 60_000, rowWidth: 1 }];

describe("indicators/exhaustion/exhaustion-store", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "exhaustion-store-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("the file is <pair>.exhaustion.json with unsafe characters replaced, in its own directory", () => {
    expect(path.basename(exhaustionHistoryPath(dir, "PERPETUAL:BTCUSDT"))).toBe("PERPETUAL_BTCUSDT.exhaustion.json");
    expect(path.basename(exhaustionHistoryPath(dir, "FUTURE:/NQZ26:XCME"))).toBe("FUTURE_NQZ26_XCME.exhaustion.json");
    expect(() => exhaustionHistoryPath(dir, "")).toThrow(/pairKey/);
  });

  test("save then load round-trips the shades and the scales, atomically, leaving no temp file", async () => {
    const sync = saveExhaustionHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", savedAt: 10, rulesVersion: 1, coveredUntil: 9, coveredFrom: 2, shades: [shade], scales });
    expect(sync).toMatchObject({ ok: true, file: exhaustionHistoryPath(dir, "FUTURE:/NQZ26:XCME") });
    expect(loadExhaustionHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", rulesVersion: 1 })).toEqual({ savedAt: 10, coveredUntil: 9, coveredFrom: 2, shades: [shade], scales });
    const async = await saveExhaustionHistoryAsync({ dir, pairKey: "FUTURE:/NQZ26:XCME", savedAt: 11, rulesVersion: 1, shades: [], scales: [] });
    expect(async.ok).toBe(true);
    expect(loadExhaustionHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", rulesVersion: 1 })).toEqual({ savedAt: 11, coveredUntil: null, coveredFrom: null, shades: [], scales: [] });
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(sync.file, "utf8")).version).toBe(EXHAUSTION_STORE_VERSION);
  });

  test("a background save that was superseded before its rename leaves the file as it was and no temp file behind", async () => {
    saveExhaustionHistory({ dir, pairKey: "P:S", savedAt: 1, rulesVersion: 1, shades: [shade], scales: [] });
    let asked = 0;
    const result = await saveExhaustionHistoryAsync({ dir, pairKey: "P:S", savedAt: 2, rulesVersion: 1, shades: [], scales: [], superseded: () => { asked += 1; return true; } });
    expect(result).toEqual({ ok: false, reason: "SUPERSEDED" });
    expect(asked).toBe(1);
    expect(loadExhaustionHistory({ dir, pairKey: "P:S", rulesVersion: 1 })).toMatchObject({ savedAt: 1, shades: [shade] });
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a payload over the budget is refused before anything is written", async () => {
    const big = Array.from({ length: 2000 }, (_, i) => ({ ...shade, id: `s${i}` }));
    expect(saveExhaustionHistory({ dir, pairKey: "P:X", rulesVersion: 1, shades: big, scales: [], maxBytes: 1000 })).toMatchObject({ ok: false, reason: "OVER_BUDGET" });
    expect(await saveExhaustionHistoryAsync({ dir, pairKey: "P:X", rulesVersion: 1, shades: big, scales: [], maxBytes: 1000 })).toMatchObject({ ok: false, reason: "OVER_BUDGET" });
    expect(fs.existsSync(exhaustionHistoryPath(dir, "P:X"))).toBe(false);
    expect(MAX_EXHAUSTION_FILE_BYTES).toBe(8 * 1024 * 1024);
  });

  test("a missing file loads as null without a rejection; a bad one is rejected with a reason and loads as null", () => {
    const rejections = [];
    const onReject = (reason) => rejections.push(reason);
    expect(loadExhaustionHistory({ dir, pairKey: "P:X", rulesVersion: 1, onReject })).toBeNull();
    const file = exhaustionHistoryPath(dir, "P:X");
    fs.writeFileSync(file, "{not json");
    expect(loadExhaustionHistory({ dir, pairKey: "P:X", rulesVersion: 1, onReject })).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: EXHAUSTION_STORE_VERSION, pairKey: "P:Y", savedAt: 1, rulesVersion: 1, shades: [], scales: [] }));
    expect(loadExhaustionHistory({ dir, pairKey: "P:X", rulesVersion: 1, onReject })).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: EXHAUSTION_STORE_VERSION, pairKey: "P:X", savedAt: 1, rulesVersion: 2, shades: [], scales: [] }));
    expect(loadExhaustionHistory({ dir, pairKey: "P:X", rulesVersion: 1, onReject })).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: EXHAUSTION_STORE_VERSION, pairKey: "P:X", savedAt: 1, rulesVersion: 1, shades: {}, scales: [] }));
    expect(loadExhaustionHistory({ dir, pairKey: "P:X", rulesVersion: 1, onReject })).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: EXHAUSTION_STORE_VERSION, pairKey: "P:X", savedAt: 1, rulesVersion: 1, coveredUntil: "x", shades: [], scales: [] }));
    expect(loadExhaustionHistory({ dir, pairKey: "P:X", rulesVersion: 1, onReject })).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: EXHAUSTION_STORE_VERSION, pairKey: "P:X", savedAt: 1, rulesVersion: 1, shades: [], scales: [] }));
    expect(loadExhaustionHistory({ dir, pairKey: "P:X", rulesVersion: 1, maxFileBytes: 10, onReject })).toBeNull();
    fs.rmSync(file);
    fs.mkdirSync(file);
    expect(loadExhaustionHistory({ dir, pairKey: "P:X", rulesVersion: 1, onReject })).toBeNull();
    expect(rejections).toEqual(["MALFORMED", "FOREIGN", "STALE_RULES", "MALFORMED", "MALFORMED", "TOO_LARGE", "NOT_A_FILE"]);
  });

  test("drop removes the file and reports true when nothing is there", () => {
    saveExhaustionHistory({ dir, pairKey: "P:X", rulesVersion: 1, shades: [], scales: [] });
    expect(dropExhaustionHistory({ dir, pairKey: "P:X" })).toBe(true);
    expect(fs.existsSync(exhaustionHistoryPath(dir, "P:X"))).toBe(false);
    expect(dropExhaustionHistory({ dir, pairKey: "P:X" })).toBe(true);
  });
});
