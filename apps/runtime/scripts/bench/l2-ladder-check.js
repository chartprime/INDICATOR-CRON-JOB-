"use strict";

const fs = require("node:fs");
const { parseArgs, buildEngine, priceOfFrame } = require("./l2-engine-bench");
const { createReplaySource } = require("../../src/indicators/l2-memory/replay-source");
const { createDxFeedReplaySource } = require("../../src/indicators/l2-memory/dxfeed-replay-source");

const COLUMN_MS = 1_000;
const PRUNE_EVERY_MS = 30_000;
const DEPTHS = Object.freeze([20, 50]);
const KEEP_MISMATCHES = 5;

function buildFullSource(options) {
  if (options.provider === "binance") {
    return createReplaySource({ dbPath: options.db, symbol: options.symbol, marketKind: options.kind, fromTs: options.fromTs, toTs: options.toTs, bookMode: "full" });
  }
  return createDxFeedReplaySource({ dbPath: options.db, symbol: options.symbol, assetClass: options.kind, fromTs: options.fromTs, toTs: options.toTs, bookMode: "full" });
}

function topOf(levels, side, depth) {
  const sorted = (levels ?? [])
    .map(([price, size]) => [Number(price), Number(size)])
    .filter(([, size]) => size > 0)
    .sort((a, b) => (side === "bid" ? b[0] - a[0] : a[0] - b[0]));
  return sorted.slice(0, depth);
}

function firstDifference(a, b) {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index];
    const y = b[index];
    if (!x || !y || x[0] !== y[0] || x[1] !== y[1]) return { index, engine: x ?? null, book: y ?? null };
  }
  return null;
}

function closeQuietly(source) {
  try {
    source.close();
    return true;
  } catch {
    return false;
  }
}

function run(options) {
  const source = buildFullSource(options);
  const tally = Object.fromEntries(DEPTHS.map((depth) => [depth, { compared: 0, mismatches: 0, first: [] }]));
  let engine = null;
  let book = null;
  let nextColumnTs = null;
  let nextPruneTs = null;
  let frames = 0;
  let ladderMs = 0;
  let ladderCalls = 0;
  function compare(ts) {
    if (book === null || !engine.live) return;
    for (const depth of DEPTHS) {
      for (const side of ["bid", "ask"]) {
        const startedAt = performance.now();
        const engineLadder = engine.ladder({ side, depth });
        ladderMs += performance.now() - startedAt;
        ladderCalls += 1;
        const bookLadder = topOf(side === "bid" ? book.bids : book.asks, side, depth);
        const entry = tally[depth];
        entry.compared += 1;
        const difference = firstDifference(engineLadder, bookLadder);
        if (difference === null) continue;
        entry.mismatches += 1;
        if (entry.first.length < KEEP_MISMATCHES) entry.first.push({ ts: new Date(ts).toISOString(), side, ...difference });
      }
    }
  }
  try {
    for (const frame of source.frames()) {
      frames += 1;
      if (engine === null) {
        if (frame.kind !== "book" || frame.status !== "READY") continue;
        const price = priceOfFrame(frame);
        if (price === null) continue;
        engine = buildEngine(options, price).engine;
      }
      const ts = Number(frame.ts);
      if (engine.seeded && Number.isSafeInteger(ts) && nextColumnTs !== null) {
        while (ts >= nextColumnTs) {
          compare(nextColumnTs);
          nextColumnTs += COLUMN_MS;
        }
      }
      engine.apply(frame);
      if (frame.kind === "book") book = frame.status === "READY" ? frame.book : null;
      if (frame.kind === "anchor") book = null;
      if (!engine.seeded || !Number.isSafeInteger(ts)) continue;
      if (nextColumnTs === null) {
        nextColumnTs = (Math.floor(ts / COLUMN_MS) + 1) * COLUMN_MS;
        nextPruneTs = ts + PRUNE_EVERY_MS;
      }
      if (ts >= nextPruneTs) {
        engine.prune(ts);
        nextPruneTs = ts + PRUNE_EVERY_MS;
      }
    }
  } catch (error) {
    closeQuietly(source);
    throw error;
  }
  source.close();
  if (engine === null) throw new Error("the window held no READY book: nothing was compared");
  return {
    kind: "l2-ladder-check",
    provider: options.provider,
    symbol: options.symbol,
    instrumentKind: options.kind,
    window: { from: new Date(options.fromTs).toISOString(), to: new Date(options.toTs).toISOString() },
    frames,
    ladderMeanUs: ladderCalls > 0 ? Math.round((ladderMs / ladderCalls) * 1_000) : null,
    depths: tally,
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = run(options);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) fs.writeFileSync(options.out, text);
  process.stdout.write(text);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { run };
