// Deterministic provider -> capture queue/SQLite -> server wire fixture.
// Invoked by the web suite in a real Node process, then independently parsed
// by the browser contract. Never opens a provider connection or a user DB.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeBinanceEvent } = require("../../src/providers/binance/binance-event-normalizer");
const { createBinanceBookAssembler } = require("../../src/providers/binance/binance-book-assembler");
const { createDxFeedOrderBookAssembler } = require("../../src/providers/dxfeed/dxfeed-book-assembler");
const { createStorageService } = require("../../src/storage/storage-service");
const { createStorageReader } = require("../../src/storage/storage-reader");
const { createHistoryBuffer } = require("../../src/server/history");
const frames = require("../../src/server/frames");
const { createBinanceVolumeProfileAdapter } = require("../../src/indicators/volume-profile/volume-profile-adapters");
const { createSession, pollOpenPeriod, computeProfile } = require("../../src/indicators/volume-profile/volume-profile-engine");
const { createVpinState } = require("../../src/indicators/vpin/vpin-engine");
const { run: pollVpin } = require("../../src/indicators/vpin/vpin-live-poll-worker");

async function trace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w502-wire-trace-"));
  const dbPath = path.join(dir, "fixture.sqlite");
  let receive;
  const storage = createStorageService({ dbPath, telemetry() {}, connection: { onMessage(listener) { receive = listener; return () => { receive = null; }; } } });
  let reader;
  try {
    storage.start();
    const history = createHistoryBuffer();
    const base = 1_700_000_040_000; // UTC two-minute boundary
    const end = base + 120_000;
    const rawTrades = [[1, base + 10, "2"], [2, base + 10, "3"], [2, base + 10, "3"], [3, base + 60_010, "5"], [4, base + 60_020, "NaN"]];
    let rejected = 0;
    const liveTrades = [];
    for (const [id, ts, quantity] of rawTrades) {
      const envelope = normalizeBinanceEvent({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE",
        raw: { e: "trade", s: "BTCUSDT", E: ts, T: ts, t: id, p: "100", q: quantity, m: false } }, { receivedAtMs: ts });
      if (envelope.state === "UNAVAILABLE") { rejected++; continue; }
      receive(envelope);
      const frame = frames.tradeEnvelopeToFrame(envelope);
      if (history.recordTrade(frame)) liveTrades.push(frame);
    }
    for (const [offset, count] of [[0, 2], [60_000, 1], [0, 2]]) {
      const open = base + offset;
      const ts = open + 59_999;
      const envelope = normalizeBinanceEvent({ symbol: "BTCUSDT", marketKind: "SPOT", eventType: "KLINE", interval: "1m",
        raw: { e: "kline", E: ts, s: "BTCUSDT", k: { t: open, T: ts, s: "BTCUSDT", i: "1m", f: 1, L: count,
          o: "100", c: "100", h: "100", l: "100", v: "5", n: count, x: true, q: "500", V: "5", Q: "500", B: "0" } } }, { receivedAtMs: ts });
      receive(envelope);
      history.recordBar(frames.klineEnvelopeToFrame(envelope));
    }
    storage.setCaptureOutcome({ quality: "HEALTHY", cleanShutdown: true });
    await storage.stop();
    reader = createStorageReader({ dbPath });
    const stored = reader.readRecentTrades("BTCUSDT", "SPOT", { windowMs: 120_000, nowMs: end });
    const bars = reader.readRecentCandles("BTCUSDT", "SPOT", { intervalMs: 60_000, windowMs: 120_000, nowMs: end });
    const adapter = createBinanceVolumeProfileAdapter(reader, "BTCUSDT", "SPOT");
    const session = createSession({ periodStartTs: base, originPrice: 0, rowWidth: 1 });
    const applied = await pollOpenPeriod(session, adapter, end, { pageLimit: 2 });
    const vpin = await pollVpin({ dbPath, provider: "binance", symbol: "BTCUSDT", marketKind: "SPOT", pollFromTs: base,
      pollCursor: null, nowMs: end, vpinState: createVpinState({ vBucket: 1000 }), pollOptions: { pageLimit: 2 } });
    const book = createBinanceBookAssembler({ marketKind: "SPOT" });
    book.applySnapshot({ lastUpdateId: 100, bids: [["99", "2"]], asks: [["101", "3"]] });
    book.applyDeltaEvent({ payload: { firstUpdateId: 101, lastUpdateId: 101, previousUpdateId: null, bids: [["99", "4"]], asks: [] } });
    const readyBook = frames.bookFrame("BTCUSDT", "SPOT", book.getState());
    book.applyDeltaEvent({ payload: { firstUpdateId: 103, lastUpdateId: 103, previousUpdateId: null, bids: [], asks: [] } });
    const unavailableBook = frames.bookFrame("BTCUSDT", "SPOT", book.getState());
    const dxBook = createDxFeedOrderBookAssembler({ expectedSymbol: "AAPL", expectedAssetClass: "EQUITY", expectedSource: "NTV" });
    const order = { provider: "DXFEED", eventType: "ORDER", providerSymbol: "AAPL", assetClass: "EQUITY",
      payload: { index: "5137554220647461001", eventFlags: 12, action: "NEW", price: 100, size: 3, side: "BUY", scope: "ORDER", source: "NTV" } };
    dxBook.applyEvent(order);
    const dxReady = frames.dxfeedBookFrame("AAPL", "EQUITY", dxBook.getState());
    dxBook.applyEvent({ ...order, payload: { ...order.payload, eventFlags: 20 } });
    const dxUnavailable = frames.dxfeedBookFrame("AAPL", "EQUITY", dxBook.getState());
    return {
      counts: { sourceTrades: rawTrades.length, rejected, storedTrades: stored.rows.length, storedBars: bars.rows.length,
        deliveredTrades: liveTrades.length, deliveredBars: history.snapshotBars().length, profileTrades: applied.rowsApplied,
        vpinTrades: vpin.tradesApplied, vpinSeals: vpin.sealedCount },
      frames: [frames.selectionFrame("BTCUSDT", "SPOT"), frames.snapshotFrame(history.snapshotBars(), history.snapshotTrades(), "BTCUSDT", "SPOT"),
        ...liveTrades, frames.profileFrame({ session, profile: computeProfile(session.buckets), mode: "continuous" }, "BTCUSDT", "SPOT"),
        ...vpin.readings.map((reading) => frames.vpinFrame(reading, "BTCUSDT", "SPOT")), readyBook, unavailableBook, dxReady, dxUnavailable,
        frames.analyticsStatusFrame({ provider: "BINANCE", symbol: "BTCUSDT", marketKind: "SPOT" }, "PROFILE", "UNAVAILABLE")],
    };
  } finally {
    await reader?.close();
    await storage.stop();
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  }
}

if (require.main === module) trace().then((result) => process.stdout.write(JSON.stringify(result))).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
module.exports = { trace };
