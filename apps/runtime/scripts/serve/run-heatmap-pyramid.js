#!/usr/bin/env node

require("../../src/platform/process-env").bootProcess("heatmap-pyramid", { isMain: require.main === module });

const { createCliLogger } = require("../../src/platform/cli-logger");
const { DEFAULT_DB_PATH } = require("../../src/storage/storage-db");
const { DEFAULT_DB_PATH: DEFAULT_DXFEED_DB_PATH } = require("../../src/storage/dxfeed/dxfeed-storage-db");
const { createInstrumentTickSizeResolver } = require("../../src/providers/shared/instrument-tick-size");
const { createPyramidService, pyramidOptionsFromEnv } = require("../../src/indicators/l2-memory/pyramid/pyramid-service");
const { defaultHeatmapDir } = require("../../src/indicators/l2-memory/pyramid/pyramid-paths");
const marketInstrumentCatalog = require("../../../../config/market-instruments.json");

const EXIT_CONFIGURATION = 2;

function parsePyramidArgs(env = process.env) {
  return {
    dir: env.TT_HEATMAP_DIR || defaultHeatmapDir(),
    dbPaths: {
      binance: env.TT_PYRAMID_BINANCE_DB_PATH || DEFAULT_DB_PATH,
      dxfeed: env.TT_PYRAMID_DXFEED_DB_PATH || DEFAULT_DXFEED_DB_PATH,
    },
    options: pyramidOptionsFromEnv(env),
  };
}

async function main({ env = process.env, processImpl = process, logger = createCliLogger({ name: "heatmap-pyramid" }) } = {}) {
  let service;
  try {
    const { dir, dbPaths, options } = parsePyramidArgs(env);
    service = createPyramidService({
      dir, dbPaths, catalog: marketInstrumentCatalog, env, options,
      tickSizeResolver: createInstrumentTickSizeResolver(),
      log: (line) => logger.info(line),
    });
    logger.banner([
      "HEATMAP PYRAMID - 10 s / 30 s / 1 m / 5 m columns from the capture",
      `store    ${dir}`,
      `binance  ${dbPaths.binance}`,
      `dxfeed   ${dbPaths.dxfeed}`,
      `pairs    ${service.pairs.length}`,
      `keep     ${Math.round(options.retentionMs / 86_400_000)} days`,
    ]);
  } catch (error) {
    logger.error("heatmap pyramid could not start", { reason: error?.message ?? error });
    processImpl.exitCode = EXIT_CONFIGURATION;
    return null;
  }
  const stop = (reason) => {
    logger.info(`${reason}, finishing the current window`);
    service.stop();
  };
  const onSigint = () => stop("received SIGINT");
  const onSigterm = () => stop("received SIGTERM");
  processImpl.on("SIGINT", onSigint);
  processImpl.on("SIGTERM", onSigterm);
  try {
    await service.run();
    logger.ok("heatmap pyramid stopped");
  } catch (error) {
    logger.error("heatmap pyramid failed", { reason: String(error?.message ?? error).slice(0, 300) });
    processImpl.exitCode = 1;
  } finally {
    service.close();
    processImpl.off("SIGINT", onSigint);
    processImpl.off("SIGTERM", onSigterm);
    try { await logger.flush?.({ throwOnError: true }); } catch { processImpl.exitCode = 1; }
    logger.close?.();
  }
  return service;
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode ?? 0), (error) => {
    console.error("run-heatmap-pyramid: unexpected fatal error", error?.message ?? error);
    process.exit(1);
  });
}

module.exports = { main, parsePyramidArgs, EXIT_CONFIGURATION };
