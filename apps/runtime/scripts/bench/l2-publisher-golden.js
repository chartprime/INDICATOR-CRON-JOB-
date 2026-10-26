"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const { parseArgs, buildSource, buildEngine, priceOfFrame } = require("./l2-engine-bench");
const { createPublisherCapture } = require("./publisher-capture");
const { dxfeedLiquidityFrame } = require("../../src/server/frames");

const COLUMN_MS = 1_000;
const PRUNE_EVERY_MS = 30_000;
const PUBLISHER_OPTIONS = Object.freeze({ deepS: 4 * 3_600, deepColumnMs: 10_000, coarseS: 8 * 3_600, coarseColumnMs: 300_000, storeS: 60 });
const LANES_OFF = Object.freeze({ laneWindowPct: null });

function identityOf(options) {
  if (options.provider === "dxfeed") return { provider: "DXFEED", symbol: options.symbol, assetClass: options.kind };
  return { provider: "BINANCE", symbol: options.symbol, marketKind: options.kind };
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
  const source = buildSource(options);
  const dump = options.dump ? fs.openSync(options.dump, "w") : null;
  let engine = null;
  let capture = null;
  let nextColumnTs = null;
  let nextPruneTs = null;
  let frames = 0;
  try {
    for (const frame of source.frames()) {
      frames += 1;
      if (engine === null) {
        if (frame.kind !== "book" || frame.status !== "READY") continue;
        const price = priceOfFrame(frame);
        if (price === null) continue;
        const built = buildEngine(options, price);
        engine = built.engine;
        capture = createPublisherCapture({
          engine,
          marketKind: options.kind,
          symbol: options.symbol,
          rowClusters: built.fixedRowClusters,
          notionalMultiplier: options.multiplier,
          publisherOptions: {
            ...PUBLISHER_OPTIONS,
            ...(options.provider === "dxfeed" ? { buildFrame: dxfeedLiquidityFrame } : {}),
            ...(options.lanes === "off" ? LANES_OFF : {}),
            ...(options.l2 === "off" ? { l2: false } : {}),
          },
          onFrame: options.onFrame ?? (dump === null ? null : (kind, value) => fs.writeSync(dump, `${JSON.stringify({ kind, value })}\n`)),
          l2Identity: options.l2 === "off" ? null : identityOf(options),
        });
      }
      engine.apply(frame);
      const ts = Number(frame.ts);
      if (!engine.seeded || !Number.isSafeInteger(ts)) continue;
      if (nextColumnTs === null) {
        nextColumnTs = (Math.floor(ts / COLUMN_MS) + 1) * COLUMN_MS;
        nextPruneTs = ts + PRUNE_EVERY_MS;
      }
      while (ts >= nextColumnTs) {
        capture.tick(nextColumnTs);
        nextColumnTs += COLUMN_MS;
      }
      if (ts >= nextPruneTs) {
        engine.prune(ts);
        nextPruneTs = ts + PRUNE_EVERY_MS;
      }
    }
  } catch (error) {
    closeQuietly(source);
    if (dump !== null) fs.closeSync(dump);
    throw error;
  }
  source.close();
  if (dump !== null) fs.closeSync(dump);
  if (capture === null) throw new Error("the window held no READY book: nothing was captured");
  const tickTiming = capture.timing();
  const heapMiB = Math.round((process.memoryUsage().heapUsed / 1_048_576) * 10) / 10;
  const result = capture.finish();
  const golden = crypto.createHash("sha256").update(JSON.stringify(result.digests)).digest("hex");
  return {
    kind: "l2-publisher-golden",
    provider: options.provider,
    symbol: options.symbol,
    instrumentKind: options.kind,
    window: { from: new Date(options.fromTs).toISOString(), to: new Date(options.toTs).toISOString() },
    publisherOptions: PUBLISHER_OPTIONS,
    frames,
    ...result,
    tickTiming,
    heapMiB,
    goldenSha256: golden,
    ...(result.l2 ? { l2GoldenSha256: crypto.createHash("sha256").update(JSON.stringify(result.l2.digests)).digest("hex") } : {}),
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

module.exports = { run, PUBLISHER_OPTIONS };
