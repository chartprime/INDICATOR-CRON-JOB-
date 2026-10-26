"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { exhaustionShadesFrame } = require("../../src/server/exhaustion-frames");
const { candleMonitorFrame } = require("../../src/server/candle-monitor-frames");

const CORPUS_PATH = path.resolve(__dirname, "../../../web/src/test-fixtures/market-data-contract-v1.json");
const TYPE = "exhaustion_shades";
const MONITOR_TYPE = "candle_monitor";
const IDENTITIES = [
  { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" },
  { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" },
];
const TS = 1_789_000_060_000;

function samples(identity) {
  const held = { id: `60000|buyers|${TS - 600_000}`, candleMs: 60_000, side: "buyers", status: "held", intensity: 2, score: 4, readings: { rate: true, progress: true, delta: true, divergence: false, prints: true, book: false }, values: { rate: 0.3, progress: 0.2, delta: -0.25, divergence: 0.1, prints: 0.2, book: 0.95 }, raw: { own: 3, other: 7, legOwn: 14.222, moved: 0, legMoved: 1.778, big: 0, legBig: 0, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 }, startTs: TS - 600_000, endTs: TS - 480_000, extremeTs: TS - 660_000, extremePrice: 31188.25, legStartTs: TS - 1_200_000, legStartPrice: 31170, legSize: 18.25, efficiency: 0.8, atr: 3.25, judgedAt: TS, updatedAt: TS, origin: "stored" };
  const open = { id: `300000|sellers|${TS - 300_000}`, candleMs: 300_000, side: "sellers", status: "open", intensity: 1, score: 3, readings: { rate: false, progress: false, delta: true, divergence: true, prints: true, book: false }, values: { rate: 0.62, progress: 0.8, delta: -0.3, divergence: -0.5, prints: 0, book: 1.1 }, raw: { own: 3, other: 7, legOwn: 14.222, moved: 0, legMoved: 1.778, big: 0, legBig: 0, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 }, startTs: TS - 300_000, endTs: TS, extremeTs: TS - 600_000, extremePrice: 31160, legStartTs: TS - 2_400_000, legStartPrice: 31200, legSize: 40, efficiency: 0.6, atr: 7.5, judgedAt: null, updatedAt: TS, origin: "runtime" };
  return [
    exhaustionShadesFrame(identity, { ts: TS, seq: 0, reset: true, liveSince: TS - 3_600_000, loading: TS - 90_000_000, shades: [held, open] }),
    exhaustionShadesFrame(identity, { ts: TS + 300_000, seq: 1, reset: false, liveSince: TS - 3_600_000, loading: null, shades: [{ ...open, status: "pending", updatedAt: TS + 300_000 }] }),
    candleMonitorFrame(identity, { ts: TS + 30_000, entries: [
      { candleMs: 60_000, candleTs: TS - 40_000, buy: 2.97, sell: 0.56, biggestBuy: { price: 31190, size: 1.21 }, biggestSell: { price: 31186.5, size: 0.4 } },
      { candleMs: 300_000, candleTs: TS - 160_000, buy: 12.5, sell: 14.25, biggestBuy: null, biggestSell: { price: 31160, size: 3.5 } },
    ] }),
  ].map((frame) => JSON.parse(JSON.stringify(frame)));
}

describe("contract corpus: the exhaustion_shades samples are the builder's own output", () => {
  const built = IDENTITIES.flatMap(samples);
  if (process.env.UPDATE_EXHAUSTION_CORPUS === "1") {
    const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8"));
    corpus.frames = [...corpus.frames.filter((frame) => frame.type !== TYPE && frame.type !== MONITOR_TYPE), ...built];
    const note = {
      types: [TYPE, MONITOR_TYPE],
      builtBy: "apps/runtime/test/contracts/exhaustion-corpus.test.js, which rebuilds them with apps/runtime/src/server/exhaustion-frames.js and candle-monitor-frames.js and holds this corpus equal to them",
      note: "The Exhaustion engine's opt-in channel, sent only to a client that declared exhaustion_shades: a reset page (a held 1m shade judged after its leg's nine candles, an open 5m one) and an increment (the 5m shade pending once its strip stopped), for both providers; and a candle_monitor frame, the last closed candle per length for the Candle Monitor, sent with the same capability.",
    };
    corpus.extensions = [...corpus.extensions.filter((entry) => !entry.types.includes(TYPE) && !entry.types.includes(MONITOR_TYPE)), note];
    fs.writeFileSync(CORPUS_PATH, `${JSON.stringify(corpus, null, 2)}\n`);
  }
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8"));

  test("the corpus holds exactly the rebuilt exhaustion_shades samples, a reset and an increment for both providers", () => {
    expect(corpus.frames.filter((frame) => frame.type === TYPE || frame.type === MONITOR_TYPE)).toEqual(built);
    expect(corpus.extensions.find((entry) => entry.types.includes(TYPE))).toMatchObject({ builtBy: expect.stringContaining("exhaustion-corpus.test.js") });
  });
});
