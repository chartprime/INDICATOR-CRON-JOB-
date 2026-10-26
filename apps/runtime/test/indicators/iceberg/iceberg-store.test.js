const fs = require("fs");
const os = require("os");
const path = require("path");
const { saveIcebergHistory, saveIcebergHistoryAsync, loadIcebergHistory, dropIcebergHistory, icebergHistoryPath, MAX_ICEBERG_FILE_BYTES } = require("../../../src/indicators/iceberg/iceberg-store");
const { createIcebergHistory, wireIcebergOf } = require("../../../src/indicators/iceberg/iceberg-history");

const DAY = 86_400_000;
const sample = () => wireIcebergOf({
  id: "/NQZ26:XCME|1|1000", kind: "native", confidence: "certain", origin: "runtime", side: "bid", price: 31188, display: 10, tranches: 3, executed: 20,
  startedAt: 1000, firstRefillAt: 1500, updatedAt: 9000, status: "filled",
});

describe("indicators/iceberg/iceberg-store", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "iceberg-store-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("the file is <pair>.icebergs.json with unsafe characters replaced, in its own directory", () => {
    expect(path.basename(icebergHistoryPath(dir, "PERPETUAL:BTCUSDT"))).toBe("PERPETUAL_BTCUSDT.icebergs.json");
    expect(path.basename(icebergHistoryPath(dir, "FUTURE:/NQZ26:XCME"))).toBe("FUTURE_NQZ26_XCME.icebergs.json");
    expect(() => icebergHistoryPath(dir, "")).toThrow(/pairKey/);
  });

  test("save then load round-trips through the model, atomically, leaving no temp file", () => {
    const history = createIcebergHistory({ maxAgeMs: DAY });
    history.record(sample());
    const cuts = { version: 1, touch: [1], durations: [2], ratios: [3] };
    const saved = saveIcebergHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", savedAt: 10_000, history: history.toJSON(), cuts, coverage: [[1000, 9000]] });
    expect(saved.ok).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(["FUTURE_NQZ26_XCME.icebergs.json"]);
    const loaded = loadIcebergHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME" });
    expect(loaded.savedAt).toBe(10_000);
    expect(loaded.cuts).toEqual(cuts);
    expect(loaded.coverage).toEqual([[1000, 9000]]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "FUTURE_NQZ26_XCME.icebergs.json"), "utf8")).version).toBe(2);
    const restored = createIcebergHistory({ maxAgeMs: DAY });
    expect(restored.load(loaded.history)).toBe(true);
    expect(restored.list()).toEqual(history.list());
  });

  test("the async save uses a pid-tagged temp name and cleans up on failure", async () => {
    const history = createIcebergHistory({ maxAgeMs: DAY });
    history.record(sample());
    const saved = await saveIcebergHistoryAsync({ dir, pairKey: "PERPETUAL:BTCUSDT", history: history.toJSON() });
    expect(saved.ok).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(["PERPETUAL_BTCUSDT.icebergs.json"]);
    const blocked = path.join(dir, "blocked");
    fs.writeFileSync(blocked, "not a directory");
    const failed = await saveIcebergHistoryAsync({ dir: blocked, pairKey: "PERPETUAL:BTCUSDT", history: history.toJSON() });
    expect(failed.ok).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual(["PERPETUAL_BTCUSDT.icebergs.json", "blocked"].sort());
  });

  test("an async save that a newer save supersedes while it writes never lands over the newer file and leaves no temp file behind", async () => {
    const history = createIcebergHistory({ maxAgeMs: DAY });
    history.record(sample());
    let newer = false;
    const pending = saveIcebergHistoryAsync({ dir, pairKey: "P:X", savedAt: 1, history: history.toJSON(), superseded: () => newer });
    newer = true;
    expect(saveIcebergHistory({ dir, pairKey: "P:X", savedAt: 2, history: { version: 1, icebergs: [] } }).ok).toBe(true);
    expect(await pending).toEqual({ ok: false, reason: "SUPERSEDED" });
    expect(loadIcebergHistory({ dir, pairKey: "P:X" }).savedAt).toBe(2);
    expect(fs.readdirSync(dir)).toEqual(["P_X.icebergs.json"]);
  });

  test("every rejection has a reason: missing is silent, then NOT_A_FILE, TOO_LARGE, MALFORMED, FOREIGN", () => {
    const reasons = [];
    const onReject = (reason) => reasons.push(reason);
    expect(loadIcebergHistory({ dir, pairKey: "P:X", onReject })).toBeNull();
    expect(reasons).toEqual([]);
    const file = icebergHistoryPath(dir, "P:X");
    fs.mkdirSync(file);
    expect(loadIcebergHistory({ dir, pairKey: "P:X", onReject })).toBeNull();
    fs.rmdirSync(file);
    fs.writeFileSync(file, "{}");
    expect(loadIcebergHistory({ dir, pairKey: "P:X", onReject, maxFileBytes: 1 })).toBeNull();
    fs.writeFileSync(file, "{ not json");
    expect(loadIcebergHistory({ dir, pairKey: "P:X", onReject })).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: 1, pairKey: "P:Y", savedAt: 1, history: { version: 1, icebergs: [] } }));
    expect(loadIcebergHistory({ dir, pairKey: "P:X", onReject })).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: 1, pairKey: "P:X", savedAt: "soon", history: { version: 1, icebergs: [] } }));
    expect(loadIcebergHistory({ dir, pairKey: "P:X", onReject })).toBeNull();
    expect(reasons).toEqual(["NOT_A_FILE", "TOO_LARGE", "MALFORMED", "FOREIGN", "MALFORMED"]);
  });

  test("a version 1 file still loads, with no cuts and no coverage; a save without them writes null and none; a newer version is foreign", () => {
    const file = icebergHistoryPath(dir, "P:X");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, pairKey: "P:X", savedAt: 1, history: { version: 1, icebergs: [] }, cuts: { version: 1, touch: [9], durations: [], ratios: [] } }));
    expect(loadIcebergHistory({ dir, pairKey: "P:X" })).toEqual({ savedAt: 1, history: { version: 1, icebergs: [] }, cuts: null, coverage: [] });
    expect(saveIcebergHistory({ dir, pairKey: "P:X", savedAt: 2, history: { version: 1, icebergs: [] } }).ok).toBe(true);
    expect(loadIcebergHistory({ dir, pairKey: "P:X" })).toEqual({ savedAt: 2, history: { version: 1, icebergs: [] }, cuts: null, coverage: [] });
    const reasons = [];
    fs.writeFileSync(file, JSON.stringify({ version: 3, pairKey: "P:X", savedAt: 1, history: { version: 1, icebergs: [] } }));
    expect(loadIcebergHistory({ dir, pairKey: "P:X", onReject: (reason) => reasons.push(reason) })).toBeNull();
    expect(reasons).toEqual(["FOREIGN"]);
  });

  test("a payload over the byte budget is refused before anything is written", () => {
    const history = createIcebergHistory({ maxAgeMs: DAY });
    history.record(sample());
    const result = saveIcebergHistory({ dir, pairKey: "P:X", history: history.toJSON(), maxBytes: 10 });
    expect(result).toMatchObject({ ok: false, reason: "OVER_BUDGET" });
    expect(result.bytes).toBeGreaterThan(10);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(MAX_ICEBERG_FILE_BYTES).toBe(8 * 1024 * 1024);
  });

  test("drop removes the file and is true even when there was none", () => {
    const history = createIcebergHistory({ maxAgeMs: DAY });
    saveIcebergHistory({ dir, pairKey: "P:X", history: history.toJSON() });
    expect(dropIcebergHistory({ dir, pairKey: "P:X" })).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(dropIcebergHistory({ dir, pairKey: "P:X" })).toBe(true);
  });
});
