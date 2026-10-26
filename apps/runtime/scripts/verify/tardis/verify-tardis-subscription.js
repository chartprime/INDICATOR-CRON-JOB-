#!/usr/bin/env node
"use strict";

const { init, getApiKeyAccessInfo } = require("tardis-dev");
const { createCliLogger, flushAndExit } = require("../../../src/platform/cli-logger");

const EXPECTED_MIN_EXCHANGES = 50;
const SPOT_CHECK_EXCHANGES = ["binance", "binance-futures", "bybit", "bybit-spot", "deribit"];

async function main({
  logger = createCliLogger({ name: "verify-tardis-subscription" }),
  exit = process.exit,
} = {}) {
  const apiKey = process.env.tardis_key;
  if (!apiKey) {
    logger.error("tardis_key not set in environment");
    await flushAndExit(logger, exit, 1);
    return;
  }
  init({ apiKey });

  logger.banner([
    "TARDIS SUBSCRIPTION / ENTITLEMENT CHECK",
    "reads real entitlement from the API -- the key value itself is never logged",
  ]);

  let info;
  try {
    info = await getApiKeyAccessInfo();
  } catch (error) {
    logger.error("could not fetch entitlement info", { reason: error.message });
    await flushAndExit(logger, exit, 1);
    return;
  }

  const exchanges = new Set(info.map((entry) => entry.exchange));
  const accessTypes = new Set(info.map((entry) => entry.accessType));
  const dataPlans = new Set(info.map((entry) => entry.dataPlan));
  const earliestFrom = info.reduce((min, entry) => (min === null || entry.from < min ? entry.from : min), null);
  const latestTo = info.reduce((max, entry) => (max === null || entry.to > max ? entry.to : max), null);

  logger.info("entitlement summary", {
    exchangeCount: exchanges.size,
    accessTypes: [...accessTypes],
    dataPlans: [...dataPlans],
    dateRange: `${earliestFrom} -> ${latestTo}`,
  });

  for (const exchange of SPOT_CHECK_EXCHANGES) {
    const entry = info.find((e) => e.exchange === exchange);
    console.log(`  ${exchange.padEnd(16)} ${entry ? `access=${entry.accessType} dataPlan=${entry.dataPlan}` : "NOT ENTITLED"}`);
  }

  const isPaid = ![...accessTypes].every((type) => type === "trial");
  const isBroad = exchanges.size >= EXPECTED_MIN_EXCHANGES;

  if (isPaid && isBroad) {
    logger.ok(`real paid subscription confirmed -- ${exchanges.size} exchanges, access types: ${[...accessTypes].join(", ")}`);
  } else if (!isPaid) {
    logger.warn("still shows trial-only access -- this key has not been swapped for the paid one yet", { exchangeCount: exchanges.size });
  } else {
    logger.warn("access type is not trial, but exchange coverage is narrower than expected for All Exchanges", { exchangeCount: exchanges.size, expected: EXPECTED_MIN_EXCHANGES });
  }

  await flushAndExit(logger, exit, 0);
}

if (require.main === module) {
  main();
}

module.exports = { main, EXPECTED_MIN_EXCHANGES, SPOT_CHECK_EXCHANGES };
