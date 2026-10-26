"use strict";

const { MAX_WINDOW_ROWS } = require("../../passive_liquidity/liquidity-geometry");

const DEFAULT_WINDOW_PCT = Object.freeze({ SPOT: 7, PERPETUAL: 7, FUTURE: 3, EQUITY: 3 });
const LANE_ROWS = MAX_WINDOW_ROWS;
const MAX_LANES = 6;

function laneWindowPctFor(marketKind, classDefaults, override) {
  if (Number.isFinite(override) && override > 0) return override;
  if (!classDefaults || typeof classDefaults !== "object") return null;
  const value = classDefaults[marketKind];
  return Number.isFinite(value) && value > 0 ? value : null;
}

function lanesFor({ price, rowClusters, rowWidth, windowRows, windowPct, columnMs, deepColumnMs }) {
  if (!(price > 0) || !(rowWidth > 0) || !(windowPct > 0)) return [];
  if (!Number.isSafeInteger(rowClusters) || rowClusters <= 0 || !Number.isSafeInteger(windowRows) || windowRows < 0) return [];
  const reach = (price * windowPct) / 100;
  if (windowRows * rowWidth >= reach) return [];
  const lanes = [];
  for (let k = 1; k <= MAX_LANES; k += 1) {
    const factor = 2 ** k;
    const laneRowWidth = rowWidth * factor;
    lanes.push(Object.freeze({
      k,
      factor,
      rowClusters: rowClusters * factor,
      rowWidth: laneRowWidth,
      windowRows: LANE_ROWS,
      columnMs: columnMs * factor,
      deepColumnMs: deepColumnMs * factor,
      reachPct: (100 * LANE_ROWS * laneRowWidth) / price,
    }));
    if (LANE_ROWS * laneRowWidth >= reach) break;
  }
  return lanes;
}

module.exports = { lanesFor, laneWindowPctFor, DEFAULT_WINDOW_PCT, LANE_ROWS, MAX_LANES };
