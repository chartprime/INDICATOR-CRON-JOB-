#!/usr/bin/env node

require("../../src/platform/process-env").bootProcess("iceberg-history", { isMain: require.main === module });

const { createCliLogger } = require("../../src/platform/cli-logger");
const { createIcebergHostService, icebergHostOptionsFromEnv } = require("../../src/indicators/iceberg/iceberg-host-service");
const marketInstrumentCatalog = require("../../../../config/market-instruments.json");

const EXIT_CONFIGURATION = 2;

async function main({ env = process.env, processImpl = process, logger = createCliLogger({ name: "iceberg-history" }) } = {}) {
  let service;
  try {
    const options = icebergHostOptionsFromEnv(env);
    if (!options.enabled) {
      logger.warn("iceberg history is switched off (TT_ICEBERG_HISTORY=0); nothing to build");
      processImpl.exitCode = EXIT_CONFIGURATION;
      return null;
    }
    service = createIcebergHostService({ catalog: marketInstrumentCatalog, options, log: (line) => logger.info(line) });
    logger.banner([
      "ICEBERG HISTORY - native and probable icebergs from the capture",
      `store    ${options.dir}`,
      `binance  ${options.dbPaths.binance}`,
      `dxfeed   ${options.dbPaths.dxfeed}`,
      `pairs    ${service.pairs.length}`,
      `keep     ${Math.round(options.retentionMs / 86_400_000)} days`,
    ]);
  } catch (error) {
    logger.error("iceberg history could not start", { reason: error?.message ?? error });
    processImpl.exitCode = EXIT_CONFIGURATION;
    return null;
  }
  const stop = (reason) => {
    logger.info(`${reason}, finishing the current chunk`);
    service.stop();
  };
  const onSigint = () => stop("received SIGINT");
  const onSigterm = () => stop("received SIGTERM");
  processImpl.on("SIGINT", onSigint);
  processImpl.on("SIGTERM", onSigterm);
  try {
    await service.run();
    logger.ok("iceberg history stopped");
  } catch (error) {
    logger.error("iceberg history failed", { reason: String(error?.message ?? error).slice(0, 300) });
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
    console.error("run-iceberg-history: unexpected fatal error", error?.message ?? error);
    process.exit(1);
  });
}

module.exports = { main, EXIT_CONFIGURATION };
