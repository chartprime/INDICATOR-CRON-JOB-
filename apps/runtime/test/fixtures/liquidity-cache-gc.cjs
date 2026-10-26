const { createLiquidityHistory, encodeAfter } = require("../../src/indicators/passive_liquidity/liquidity-history");
const process = require("node:process");
const { setImmediate } = require("node:timers");

function cohort(cached) {
  const history = createLiquidityHistory({ maxColumns: 2 });
  let first;
  let prev = null;
  for (let i = 0; i < 20_000; i += 1) {
    const column = { ts: i, lo: 0, hi: 63, bid: new Float64Array(64).fill(i), ask: new Float64Array(64).fill(i + 1) };
    if (i === 0) first = new WeakRef(column);
    if (cached) encodeAfter(prev, column);
    history.push(column);
    prev = column;
  }
  return { history, first };
}

async function main() {
  const cached = cohort(true);
  const control = cohort(false);
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    global.gc();
  }
  process.stdout.write(JSON.stringify({
    retained: cached.history.length,
    cachedFirstAlive: cached.first.deref() !== undefined,
    controlFirstAlive: control.first.deref() !== undefined,
    bufferBytes: process.memoryUsage().arrayBuffers,
  }));
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
