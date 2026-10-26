const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStorageDb } = require("../../../src/storage/storage-db");
const { createStorageReader } = require("../../../src/storage/storage-reader");
const { createBinanceVolumeProfileAdapter } = require("../../../src/indicators/volume-profile/volume-profile-adapters");
const { createSession, pollOpenPeriod } = require("../../../src/indicators/volume-profile/volume-profile-engine");
const { createVpinState } = require("../../../src/indicators/vpin/vpin-engine");
const { run } = require("../../../src/indicators/vpin/vpin-live-poll-worker");

test("real SQLite rows reach profile and VPIN exactly once across equal-time pages and a period boundary", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w502-conservation-"));
  const dbPath = path.join(dir, "capture.sqlite");
  const writer = createStorageDb({ dbPath });
  let reader;
  try {
    for (const [tradeId, ts, size] of [["1", 60_010, 2], ["2", 60_010, 3], ["3", 60_020, 5], ["4", 120_000, 7]]) {
      writer.insert("trades", { tradeId, ts, size, price: 100, symbol: "BTCUSDT", marketKind: "SPOT", side: "buy" });
    }
    reader = createStorageReader({ dbPath });
    const adapter = createBinanceVolumeProfileAdapter(reader, "BTCUSDT", "SPOT");
    const session = createSession({ periodStartTs: 60_000, originPrice: 0, rowWidth: 1 });
    const first = await pollOpenPeriod(session, adapter, 120_000, { pageLimit: 2 });
    expect(first.rowsApplied).toBe(3);
    expect([...session.buckets.values()].reduce((sum, bucket) => sum + bucket.volume, 0)).toBe(10);
    expect((await pollOpenPeriod(session, adapter, 120_000, { pageLimit: 2 })).rowsApplied).toBe(0);
    const input = { provider: "binance", dbPath, symbol: "BTCUSDT", marketKind: "SPOT", pollFromTs: 60_000, pollCursor: null, nowMs: 120_000, vpinState: createVpinState({ vBucket: 1000 }), pollOptions: { pageLimit: 2 } };
    const result = await run(input);
    expect(result.tradesApplied).toBe(3);
    expect(result.sealedCount).toBe(1);
    expect((await run({ ...input, ...result })).tradesApplied).toBe(0);
    expect((await adapter.readTradesSince(120_000, 120_001, null, 2)).rows.map((row) => row.tradeId)).toEqual(["4"]);
    await reader.close();
    expect((await adapter.readTradesSince(60_000, 120_000, null, 2)).available).toBe(false);
  } finally {
    await reader?.close();
    writer.close();
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  }
});
