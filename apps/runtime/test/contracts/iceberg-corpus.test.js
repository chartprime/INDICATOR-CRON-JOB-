"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { icebergOrdersFrame } = require("../../src/server/iceberg-frames");

const CORPUS_PATH = path.resolve(__dirname, "../../../web/src/test-fixtures/market-data-contract-v1.json");
const TYPE = "iceberg_orders";
const IDENTITIES = [
  { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" },
  { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" },
];
const TS = 1_789_000_060_000;

function samples(identity) {
  const native = { id: `${identity.symbol}|5137554220647449213|${TS - 127_000}`, kind: "native", confidence: "certain", origin: "runtime", side: "bid", price: 31188, display: 10, tranches: 4, executed: 32, startedAt: TS - 127_000, markedAt: TS - 120_000, updatedAt: TS - 1_000, status: "filled" };
  const probable = { id: `${identity.symbol}|${identity.marketKind ?? identity.assetClass}|ask|80924.2|${TS - 20_000}`, kind: "probable", confidence: "strong", origin: "runtime", side: "ask", price: 80924.2, display: 1.545, tranches: 2, executed: 12.475, startedAt: TS - 20_000, markedAt: TS - 14_000, updatedAt: TS, status: "active" };
  return [
    icebergOrdersFrame(identity, { ts: TS, seq: 0, reset: true, liveSince: 1000, icebergs: [native, probable], watched: [[TS - 3_600_000, TS - 60_000]] }),
    icebergOrdersFrame(identity, { ts: TS + 1_000, seq: 1, reset: false, liveSince: 1000, icebergs: [{ ...probable, executed: 13.1, updatedAt: TS + 1_000, status: "ended" }], watched: [[TS - 3_600_000, TS + 1_000]] }),
  ].map((frame) => JSON.parse(JSON.stringify(frame)));
}

describe("contract corpus: the iceberg_orders samples are the builder's own output", () => {
  const built = IDENTITIES.flatMap(samples);
  if (process.env.UPDATE_ICEBERG_CORPUS === "1") {
    const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8"));
    corpus.frames = [...corpus.frames.filter((frame) => frame.type !== TYPE), ...built];
    const note = {
      types: [TYPE],
      builtBy: "apps/runtime/test/contracts/iceberg-corpus.test.js, which rebuilds them with apps/runtime/src/server/iceberg-frames.js and holds this corpus equal to them",
      note: "The Iceberg Detector's opt-in channel, sent only to a client that declared iceberg_orders: a reset page and an increment, for both providers.",
    };
    corpus.extensions = [...corpus.extensions.filter((entry) => !entry.types.includes(TYPE)), note];
    fs.writeFileSync(CORPUS_PATH, `${JSON.stringify(corpus, null, 2)}\n`);
  }
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8"));

  test("the corpus holds exactly the rebuilt iceberg_orders samples, a reset and an increment for both providers", () => {
    expect(corpus.frames.filter((frame) => frame.type === TYPE)).toEqual(built);
    expect(new Set(built.map((frame) => `${frame.provider}:${frame.reset}`)).size).toBe(4);
  });

  test("the extensions note names this test as the samples' producer", () => {
    const entry = corpus.extensions.find((extension) => extension.types.includes(TYPE));
    expect(entry.builtBy).toContain("iceberg-corpus.test.js");
  });
});
