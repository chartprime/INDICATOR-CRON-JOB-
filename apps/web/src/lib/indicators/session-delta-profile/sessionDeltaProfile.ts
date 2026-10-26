import type { BarFrame } from "../../../types/frames";
import { barSides } from "../barSides";

export interface SessionDeltaRow {
  price: number;
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  knownVolume: number;
}

export interface SessionDeltaProfile {
  sessionStartTs: number;
  sessionEndTs: number;
  // Timestamp of the last real bar observed in this session, used to anchor
  // line/box right edges to actual chart data instead of a nominal boundary
  // that may not resolve to any bar (e.g. right after the session length changes).
  lastBarTs: number;
  periodMs: number;
  rowWidth: number;
  rows: SessionDeltaRow[];
  pocPrice: number;
  buyPocPrice: number;
  sellPocPrice: number;
  vahPrice: number;
  valPrice: number;

  sessionHigh: number;
  sessionLow: number;
}

function roundPriceToRow(price: number, rowWidth: number): number {
  if (!Number.isFinite(price) || !Number.isFinite(rowWidth) || rowWidth <= 0) {
    return NaN;
  }
  return Math.floor(price / rowWidth) * rowWidth;
}

function computeValueArea(
  rows: SessionDeltaRow[],
  valueAreaPercent: number,
  rowWidth: number,
): {
  vahPrice: number;
  valPrice: number;
} {
  if (rows.length === 0) {
    return { vahPrice: NaN, valPrice: NaN };
  }

  const totalVolume = rows.reduce((sum, row) => sum + row.totalVolume, 0);
  if (totalVolume <= 0) {
    return { vahPrice: NaN, valPrice: NaN };
  }

  const sorted = [...rows].sort((a, b) => a.price - b.price);
  const pocIndex = sorted.reduce(
    (bestIndex, row, index) =>
      row.totalVolume > sorted[bestIndex].totalVolume ? index : bestIndex,
    0,
  );
  const targetVolume = totalVolume * valueAreaPercent;

  let accumulatedVolume = sorted[pocIndex].totalVolume;
  let lowIndex = pocIndex;
  let highIndex = pocIndex;

  while (accumulatedVolume < targetVolume) {
    const canExpandUp = highIndex < sorted.length - 1;
    const canExpandDown = lowIndex > 0;
    if (!canExpandUp && !canExpandDown) break;

    const upVolume = canExpandUp ? sorted[highIndex + 1].totalVolume : 0;
    const downVolume = canExpandDown ? sorted[lowIndex - 1].totalVolume : 0;
    if (upVolume >= downVolume && canExpandUp) {
      highIndex += 1;
      accumulatedVolume += sorted[highIndex].totalVolume;
    } else if (canExpandDown) {
      lowIndex -= 1;
      accumulatedVolume += sorted[lowIndex].totalVolume;
    } else {
      highIndex += 1;
      accumulatedVolume += sorted[highIndex].totalVolume;
    }
  }

  return {
    vahPrice: sorted[highIndex].price + rowWidth / 2,
    valPrice: sorted[lowIndex].price - rowWidth / 2,
  };
}

export function buildSessionDeltaProfile(
  bars: readonly BarFrame[],
  sessionStartTs: number,
  sessionEndTs: number,
  rowWidth: number,
  periodMs: number,
  valueAreaPercent = 0.7,
): SessionDeltaProfile {
  const rowsByPrice = new Map<number, SessionDeltaRow>();

  let sessionHigh = Number.NEGATIVE_INFINITY;
  let sessionLow = Number.POSITIVE_INFINITY;
  let lastBarTs = Number.NaN;

  for (const bar of bars) {
    const ts = bar.ts_open;
    if (ts < sessionStartTs || ts >= sessionEndTs) {
      continue;
    }

    const rowPrice = roundPriceToRow(bar.close, rowWidth);
    if (!Number.isFinite(rowPrice)) {
      continue;
    }

    const sides = barSides(bar);
    const deltaKnown = sides.known;
    const buyVolume = sides.buy;
    const sellVolume = sides.sell;
    const knownVolume = deltaKnown ? sides.sided : 0;
    sessionHigh = Math.max(sessionHigh, bar.high);
    sessionLow = Math.min(sessionLow, bar.low);
    lastBarTs = ts;

    const distributions = [
      { price: rowPrice, ratio: 0.6 },
      { price: rowPrice + rowWidth, ratio: 0.2 },
      { price: rowPrice - rowWidth, ratio: 0.2 },
    ];

    for (const { price, ratio } of distributions) {
      const existing = rowsByPrice.get(price) ?? {
        price,
        buyVolume: 0,
        sellVolume: 0,
        totalVolume: 0,
        knownVolume: 0,
      };

      existing.buyVolume += buyVolume * ratio;
      existing.sellVolume += sellVolume * ratio;
      existing.totalVolume += bar.volume * ratio;
      existing.knownVolume += knownVolume * ratio;
      rowsByPrice.set(price, existing);
    }
  }

  if (rowsByPrice.size === 0) {
    return {
      sessionStartTs,
      sessionEndTs,
      lastBarTs,
      periodMs,
      rowWidth,
      rows: [],
      pocPrice: NaN,
      buyPocPrice: NaN,
      sellPocPrice: NaN,
      vahPrice: NaN,
      valPrice: NaN,
      sessionHigh: NaN,
      sessionLow: NaN,
    };
  }

  const loBound = roundPriceToRow(sessionLow, rowWidth);
  const hiBound = roundPriceToRow(sessionHigh, rowWidth);
  const clampedByPrice = new Map<number, SessionDeltaRow>();
  for (const row of rowsByPrice.values()) {
    const price = Math.min(hiBound, Math.max(loBound, row.price));
    const existing = clampedByPrice.get(price) ?? {
      price,
      buyVolume: 0,
      sellVolume: 0,
      totalVolume: 0,
      knownVolume: 0,
    };
    existing.buyVolume += row.buyVolume;
    existing.sellVolume += row.sellVolume;
    existing.totalVolume += row.totalVolume;
    existing.knownVolume += row.knownVolume;
    clampedByPrice.set(price, existing);
  }

  const rows = [...clampedByPrice.values()].sort((a, b) => a.price - b.price);

  const poc = rows.reduce(
    (best, row) => (row.totalVolume > best.totalVolume ? row : best),
    rows[0],
  );
  const buyPoc = rows.reduce(
    (best, row) => (row.buyVolume > best.buyVolume ? row : best),
    rows[0],
  );
  const sellPoc = rows.reduce(
    (best, row) => (row.sellVolume > best.sellVolume ? row : best),
    rows[0],
  );
  const valueArea = computeValueArea(rows, valueAreaPercent, rowWidth);

  return {
    sessionStartTs,
    sessionEndTs,
    lastBarTs,
    periodMs,
    rowWidth,
    rows,
    pocPrice: poc.price,
    buyPocPrice: buyPoc.buyVolume > 0 ? buyPoc.price : NaN,
    sellPocPrice: sellPoc.sellVolume > 0 ? sellPoc.price : NaN,
    vahPrice: valueArea.vahPrice,
    valPrice: valueArea.valPrice,
    sessionHigh: sessionHigh,
    sessionLow: sessionLow,
  };
}
