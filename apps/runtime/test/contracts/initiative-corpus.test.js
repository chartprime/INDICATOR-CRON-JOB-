"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { initiativeBandsFrame } = require("../../src/server/initiative-frames");

const CORPUS_PATH = path.resolve(__dirname, "../../../web/src/test-fixtures/market-data-contract-v1.json");
const TYPE = "initiative_bands";
const IDENTITIES = [
  { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" },
  { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" },
];
const TS = 1_789_000_060_000;

function samples(identity) {
  const facts = { efficiency: { yes: true, value: 0.714 }, closes: { yes: true, value: 2 }, burst: { yes: false, value: 0.8 }, delta: { yes: true, rank: 1, share: 0.75 }, prints: { yes: true, rank: 0.833, perCandle: 1 } };
  const ended = { id: `60000|down|${TS - 900_000}`, candleMs: 60_000, side: "down", dominant: "sellers", dominantShare: 0.75, score: 4, facts, pivotTs: TS - 900_000, pivotPrice: 31188.25, frozenTs: TS - 720_000, frozenPrice: 31170, windowCandles: 3, atr: 3.25, legExtremePrice: 31160, legExtremeTs: TS - 660_000, legEndTs: TS - 600_000, updatedAt: TS - 600_000, origin: "stored" };
  const running = { id: `300000|up|${TS - 660_000}`, candleMs: 300_000, side: "up", dominant: "buyers", dominantShare: 0.9, score: 3, facts: { efficiency: { yes: true, value: 1 }, closes: { yes: true, value: 1 }, burst: { yes: false, value: 1.667 }, delta: { yes: true, rank: 0.85, share: 0.9 }, prints: { yes: false, rank: 0.4, perCandle: 0 } }, pivotTs: TS - 660_000, pivotPrice: 31160, frozenTs: TS - 300_000, frozenPrice: 31190, windowCandles: 1, atr: 7.5, legExtremePrice: 31195.5, legExtremeTs: TS - 300_000, legEndTs: null, updatedAt: TS, origin: "runtime" };
  return [
    initiativeBandsFrame(identity, { ts: TS, seq: 0, reset: true, liveSince: TS - 3_600_000, loading: TS - 90_000_000, bands: [ended, running] }),
    initiativeBandsFrame(identity, { ts: TS + 300_000, seq: 1, reset: false, liveSince: TS - 3_600_000, loading: null, bands: [{ ...running, legExtremePrice: 31210, legExtremeTs: TS, updatedAt: TS + 300_000 }] }),
  ].map((frame) => JSON.parse(JSON.stringify(frame)));
}

describe("contract corpus: the initiative_bands samples are the builder's own output", () => {
  const built = IDENTITIES.flatMap(samples);
  if (process.env.UPDATE_INITIATIVE_CORPUS === "1") {
    const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8"));
    corpus.frames = [...corpus.frames.filter((frame) => frame.type !== TYPE), ...built];
    const note = {
      types: [TYPE],
      builtBy: "apps/runtime/test/contracts/initiative-corpus.test.js, which rebuilds them with apps/runtime/src/server/initiative-frames.js and holds this corpus equal to them",
      note: "The Initiative Continuation engine's opt-in channel, sent only to a client that declared initiative_bands: a reset page (a 1m band whose leg has ended, a 5m band whose leg still runs) and an increment (the 5m band's extreme moved), for both providers.",
    };
    corpus.extensions = [...corpus.extensions.filter((entry) => !entry.types.includes(TYPE)), note];
    fs.writeFileSync(CORPUS_PATH, `${JSON.stringify(corpus, null, 2)}\n`);
  }
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8"));

  test("the corpus holds exactly the rebuilt initiative_bands samples, a reset and an increment for both providers", () => {
    expect(corpus.frames.filter((frame) => frame.type === TYPE)).toEqual(built);
    expect(corpus.extensions.find((entry) => entry.types.includes(TYPE))).toMatchObject({ builtBy: expect.stringContaining("initiative-corpus.test.js") });
  });
});
