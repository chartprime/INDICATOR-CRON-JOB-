#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { createCliLogger, flushAndExit } = require("../../../src/platform/cli-logger");
const { loadDatabentoKey, requestJson, RUNTIME_ROOT } = require("./databento-hist-api");

const OUTPUT_DIR = path.join(RUNTIME_ROOT, "data", "historical", "databento");
const RATE_LIMIT_MS = 100;

const DATASETS = {
  "GLBX.MDP3": { primary: { name: "ES", symbol: "ES.n.0" }, secondary: { name: "NQ", symbol: "NQ.n.0" }, stypeIn: "continuous" },
  "XNAS.ITCH": { primary: { name: "AAPL", symbol: "AAPL" }, secondary: { name: "TSLA", symbol: "TSLA" }, stypeIn: "raw_symbol" },
};

const BOUNDARY_SCHEMAS = ["mbo", "mbp-10", "mbp-1", "tbbo", "trades"];
const ALWAYS_FREE_SCHEMAS = ["ohlcv-1s", "definition", "statistics", "status"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dayWindow(ageDays) {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() - ageDays);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 1);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

async function costAt(key, dataset, symbol, stypeIn, schema, ageDays) {
  const { start, end } = dayWindow(ageDays);
  const { status, body } = await requestJson(key, "metadata.get_cost", {
    dataset,
    schema,
    symbols: symbol,
    stype_in: stypeIn,
    start,
    end,
  });
  await sleep(RATE_LIMIT_MS);
  if (status !== 200 || typeof body !== "number") {
    throw new Error(`metadata.get_cost failed for ${dataset}/${symbol}/${schema} at age ${ageDays}d: HTTP ${status}`);
  }
  return { ageDays, date: start, status, cost: body, paid: body > 0 };
}

function logSpacedAges(maxAgeDays) {
  const base = [
    1, 2, 4, 8, 16, 32, 64, 100, 150, 200, 250, 300, 330, 350, 365, 380, 400, 450, 500, 600, 700, 850, 1000,
    1200, 1400, 1700, 2000, 2300, 2600, 2900, 3200, 3500, 3800, 4100, 4400, 4700, 5000, 5500, 6000,
  ];
  const filtered = base.filter((d) => d <= maxAgeDays);
  if (filtered[filtered.length - 1] !== maxAgeDays) filtered.push(maxAgeDays);
  return [...new Set(filtered)].sort((a, b) => a - b);
}

async function coarseScan(key, dataset, symbol, stypeIn, schema, maxAgeDays) {
  const ages = logSpacedAges(maxAgeDays);
  const points = [];
  for (const age of ages) points.push(await costAt(key, dataset, symbol, stypeIn, schema, age));
  return points;
}

function findBrackets(points) {
  const brackets = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i - 1].paid !== points[i].paid) {
      brackets.push({ lowAge: points[i - 1].ageDays, lowPaid: points[i - 1].paid, highAge: points[i].ageDays });
    }
  }
  return brackets;
}

async function binarySearchBoundary(key, dataset, symbol, stypeIn, schema, bracket) {
  let { lowAge, highAge } = bracket;
  const { lowPaid } = bracket;
  while (highAge - lowAge > 1) {
    const midAge = Math.floor((lowAge + highAge) / 2);
    const midResult = await costAt(key, dataset, symbol, stypeIn, schema, midAge);
    if (midResult.paid === lowPaid) lowAge = midAge;
    else highAge = midAge;
  }
  const freeSide = await costAt(key, dataset, symbol, stypeIn, schema, lowAge);
  const paidSide = await costAt(key, dataset, symbol, stypeIn, schema, highAge);
  return {
    fromState: lowPaid ? "paid" : "free",
    toState: lowPaid ? "free" : "paid",
    lastDateInFromState: freeSide.date,
    firstDateInToState: paidSide.date,
    sampleCostUsd: lowPaid ? freeSide.cost : paidSide.cost,
  };
}

async function findBoundariesForSymbol(key, dataset, symbol, stypeIn, schema, maxAgeDays) {
  const scan = await coarseScan(key, dataset, symbol, stypeIn, schema, maxAgeDays);
  const brackets = findBrackets(scan);
  const boundaries = [];
  for (const bracket of brackets) {
    boundaries.push(await binarySearchBoundary(key, dataset, symbol, stypeIn, schema, bracket));
  }
  return boundaries;
}

async function confirmSecondaryAtBoundaries(key, dataset, symbol, stypeIn, schema, primaryBoundaries) {
  for (const boundary of primaryBoundaries) {
    const freeSideDate = new Date(`${boundary.lastDateInFromState}T00:00:00Z`);
    const paidSideDate = new Date(`${boundary.firstDateInToState}T00:00:00Z`);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const freeAge = Math.round((today - freeSideDate) / 86_400_000);
    const paidAge = Math.round((today - paidSideDate) / 86_400_000);
    const fromResult = await costAt(key, dataset, symbol, stypeIn, schema, freeAge);
    const toResult = await costAt(key, dataset, symbol, stypeIn, schema, paidAge);
    const fromMatches = (fromResult.paid ? "paid" : "free") === boundary.fromState;
    const toMatches = (toResult.paid ? "paid" : "free") === boundary.toState;
    if (!fromMatches || !toMatches) return false;
  }
  return true;
}

async function resolveSchemaForDataset(key, dataset, config, schema, maxAgeDays, logger) {
  const results = [];
  logger.info(`boundary search -- ${dataset} ${schema} (primary: ${config.primary.name})`);
  const primaryBoundaries = await findBoundariesForSymbol(key, dataset, config.primary.symbol, config.stypeIn, schema, maxAgeDays);
  results.push({ dataset, name: config.primary.name, schema, method: "full_search", boundaries: primaryBoundaries });

  if (primaryBoundaries.length === 0) {
    const secondaryScan = await coarseScan(key, dataset, config.secondary.symbol, config.stypeIn, schema, maxAgeDays);
    const secondaryPaid = secondaryScan.some((point) => point.paid);
    if (!secondaryPaid) {
      results.push({ dataset, name: config.secondary.name, schema, method: "confirmed_matching_primary", boundaries: [] });
    } else {
      logger.warn(`${config.secondary.name} diverges from ${config.primary.name} on ${schema} -- running full search`);
      const secondaryBoundaries = await findBoundariesForSymbol(key, dataset, config.secondary.symbol, config.stypeIn, schema, maxAgeDays);
      results.push({ dataset, name: config.secondary.name, schema, method: "mismatch_full_search", boundaries: secondaryBoundaries });
    }
    return results;
  }

  const matches = await confirmSecondaryAtBoundaries(key, dataset, config.secondary.symbol, config.stypeIn, schema, primaryBoundaries);
  if (matches) {
    results.push({ dataset, name: config.secondary.name, schema, method: "confirmed_matching_primary", boundaries: primaryBoundaries });
  } else {
    logger.warn(`${config.secondary.name} diverges from ${config.primary.name} on ${schema} -- running full search`);
    const secondaryBoundaries = await findBoundariesForSymbol(key, dataset, config.secondary.symbol, config.stypeIn, schema, maxAgeDays);
    results.push({ dataset, name: config.secondary.name, schema, method: "mismatch_full_search", boundaries: secondaryBoundaries });
  }
  return results;
}

async function resolveAlwaysFreeSchema(key, dataset, config, schema, maxAgeDays, logger) {
  const results = [];
  for (const who of [config.primary, config.secondary]) {
    const recent = await costAt(key, dataset, who.symbol, config.stypeIn, schema, 3);
    const oldest = await costAt(key, dataset, who.symbol, config.stypeIn, schema, maxAgeDays);
    if (!recent.paid && !oldest.paid) {
      results.push({ dataset, name: who.name, schema, method: "spot_check_2_points", boundaries: [], alwaysFree: true });
    } else {
      logger.warn(`${who.name} shows a real cost on ${schema}, expected always-free -- running full search`);
      const boundaries = await findBoundariesForSymbol(key, dataset, who.symbol, config.stypeIn, schema, maxAgeDays);
      results.push({ dataset, name: who.name, schema, method: "full_search_after_surprise", boundaries, alwaysFree: false });
    }
  }
  return results;
}

async function main({
  logger = createCliLogger({ name: "verify-databento-entitlement" }),
  exit = process.exit,
} = {}) {
  let key;
  try {
    key = loadDatabentoKey();
  } catch (error) {
    logger.error("could not load databento_key", { reason: error.message });
    await flushAndExit(logger, exit, 1);
    return;
  }

  logger.banner([
    "DATABENTO ENTITLEMENT BOUNDARY FINDER",
    "metadata-only -- cannot incur cost by construction",
    "finds the exact free/paid transition day per symbol, not a 5-point guess",
  ]);

  const evidence = { generatedAt: new Date().toISOString(), datasetRanges: {}, results: [] };

  for (const [dataset, config] of Object.entries(DATASETS)) {
    logger.info(`metadata.get_dataset_range -- ${dataset}`);
    const { status, body } = await requestJson(key, "metadata.get_dataset_range", { dataset });
    if (status !== 200 || !body) {
      logger.error("get_dataset_range failed", { dataset, status });
      await flushAndExit(logger, exit, 1);
      return;
    }
    const startDate = new Date(body.start);
    const today = new Date();
    const maxAgeDays = Math.floor((today - startDate) / 86_400_000);
    evidence.datasetRanges[dataset] = { start: body.start, end: body.end, maxAgeDays };
    logger.ok(`${dataset} spans ${maxAgeDays} days`, { start: body.start });

    try {
      for (const schema of BOUNDARY_SCHEMAS) {
        const results = await resolveSchemaForDataset(key, dataset, config, schema, maxAgeDays, logger);
        evidence.results.push(...results);
        for (const r of results) {
          console.log(`  ${r.name.padEnd(6)} ${r.schema.padEnd(10)} ${r.method.padEnd(28)} boundaries=${r.boundaries.length}`);
          for (const b of r.boundaries) {
            console.log(`      ${b.fromState} until ${b.lastDateInFromState}  ->  ${b.toState} from ${b.firstDateInToState}  (sample cost $${b.sampleCostUsd})`);
          }
        }
      }

      for (const schema of ALWAYS_FREE_SCHEMAS) {
        const results = await resolveAlwaysFreeSchema(key, dataset, config, schema, maxAgeDays, logger);
        evidence.results.push(...results);
        for (const r of results) {
          console.log(`  ${r.name.padEnd(6)} ${r.schema.padEnd(10)} ${r.method.padEnd(28)} alwaysFree=${r.alwaysFree}`);
        }
      }
    } catch (error) {
      logger.error("boundary search aborted -- a metadata.get_cost call did not return a trustworthy result", {
        dataset, reason: error.message,
      });
      await flushAndExit(logger, exit, 1);
      return;
    }
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, "entitlement-boundaries.json");
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2) + "\n", "utf-8");
  logger.ok("entitlement boundary search complete", { outPath, results: evidence.results.length });

  await flushAndExit(logger, exit, 0);
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  dayWindow,
  logSpacedAges,
  findBrackets,
  DATASETS,
  BOUNDARY_SCHEMAS,
  ALWAYS_FREE_SCHEMAS,
};
