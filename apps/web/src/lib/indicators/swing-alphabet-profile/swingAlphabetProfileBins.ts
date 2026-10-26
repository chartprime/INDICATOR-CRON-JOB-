export interface SwingProfileBar {
  time: number;
  close: number;
  volume: number;
}

export interface SwingProfileBin {
  priceLow: number;
  priceHigh: number;
  volume: number;
  volumeRatio: number;
  isPoc: boolean;
  text: string;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const LETTER_BUCKETS: readonly {
  min: number;
  prefix: string;
  baseIndex: number;
}[] = [
  { min: 0.95, prefix: "A", baseIndex: 0 },
  { min: 0.8, prefix: "B", baseIndex: 1 },
  { min: 0.6, prefix: "C", baseIndex: 2 },
  { min: 0.4, prefix: "D", baseIndex: 3 },
  { min: 0.2, prefix: "E", baseIndex: 4 },
];

/** Deterministic replacement for Pine's `math.random()` -- same bar history must render the same letters on every recompute. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function proportionalBinText(
  volumeRatio: number,
  seed: number,
  maxTextLen: number,
): string {
  const bucket = LETTER_BUCKETS.find(
    (candidate) => volumeRatio >= candidate.min,
  );
  const prefix = bucket?.prefix ?? "F";
  const baseIndex = bucket?.baseIndex ?? 5;
  const length = Math.trunc(volumeRatio * maxTextLen);
  if (length <= 0) return "F";
  if (length === 1) return prefix;

  const random = mulberry32(seed);
  let text = prefix;
  for (let i = 1; i < length; i += 1) {
    const offset = Math.trunc(random() * 3) - 1; // -1, 0, or 1
    const charIndex = Math.min(
      LETTERS.length - 1,
      Math.max(0, baseIndex + i + offset),
    );
    text += LETTERS[charIndex];
  }
  return text;
}

/** Ports Pine's `drawProfile` bin loop: bins by candle close only (not high/low). A leg whose range needs more than `maxBins` bins at the requested size keeps its whole range in `maxBins` wider bins instead of losing its top. */
export function computeSwingProfileBins(
  legBars: readonly SwingProfileBar[],
  priceBottom: number,
  priceTop: number,
  priceBinSize: number,
  legSeed: number,
  maxTextLen: number,
  maxBins: number,
): SwingProfileBin[] {
  if (legBars.length === 0) return [];
  if (!Number.isFinite(priceBinSize) || priceBinSize <= 0) return [];
  if (!Number.isInteger(maxBins) || maxBins <= 0) return [];
  const sBottom = Math.min(priceBottom, priceTop);
  const sTop = Math.max(priceBottom, priceTop);
  const range = sTop - sBottom;
  if (range <= 0) return [];

  const binCount = Math.min(maxBins, Math.floor(range / priceBinSize));
  if (binCount <= 0) return [];
  const binStep = range / binCount;

  const volumeBins = new Array<number>(binCount).fill(0);
  // Same spread session-delta-profile uses: most of a bar's volume belongs
  // to its own nearest bin, with a smaller share bleeding into each neighbor
  // rather than an all-or-nothing single bin.
  for (const bar of legBars) {
    const mainIndex = Math.min(
      binCount - 1,
      Math.max(0, Math.floor((bar.close - sBottom) / binStep)),
    );
    const upIndex = Math.min(binCount - 1, mainIndex + 1);
    const downIndex = Math.max(0, mainIndex - 1);
    volumeBins[mainIndex] += bar.volume * 0.5;
    volumeBins[upIndex] += bar.volume * 0.25;
    volumeBins[downIndex] += bar.volume * 0.25;
  }

  const maxVolume = Math.max(0, ...volumeBins);
  // Pine's own tie-break: the first (lowest-price) bin to reach the max stays
  // the POC, not every bin that happens to tie it later.
  const pocBinIndex = maxVolume > 0 ? volumeBins.indexOf(maxVolume) : -1;
  return volumeBins.map((volume, k) => {
    const priceLow = sBottom + k * binStep;
    const volumeRatio = maxVolume > 0 ? volume / maxVolume : 0;
    return {
      priceLow,
      priceHigh: priceLow + binStep,
      volume,
      volumeRatio,
      isPoc: k === pocBinIndex,
      text: proportionalBinText(volumeRatio, legSeed + k, maxTextLen),
    };
  });
}

export interface SwingValueArea {
  vahIndex: number;
  valIndex: number;
  vahPrice: number;
  valPrice: number;
}

/** Ports Pine's value-area expansion: grows from the POC bin outward, always taking whichever neighbor (up/down) carries more volume, until the accumulated share reaches `valueAreaPercent`. */
export function computeSwingValueArea(
  bins: readonly SwingProfileBin[],
  valueAreaPercent: number,
): SwingValueArea | null {
  if (bins.length === 0) return null;
  const totalVolume = bins.reduce((sum, bin) => sum + bin.volume, 0);
  if (totalVolume <= 0) return null;

  const pocIndex = bins.reduce(
    (bestIndex, bin, index) =>
      bin.volume > bins[bestIndex].volume ? index : bestIndex,
    0,
  );
  const targetVolume = totalVolume * valueAreaPercent;

  let vahIndex = pocIndex;
  let valIndex = pocIndex;
  let accumulatedVolume = bins[pocIndex].volume;

  while (
    accumulatedVolume < targetVolume &&
    (vahIndex < bins.length - 1 || valIndex > 0)
  ) {
    const upperVolume =
      vahIndex < bins.length - 1 ? bins[vahIndex + 1].volume : -1;
    const lowerVolume = valIndex > 0 ? bins[valIndex - 1].volume : -1;
    if (upperVolume >= lowerVolume && vahIndex < bins.length - 1) {
      vahIndex += 1;
      accumulatedVolume += upperVolume;
    } else if (valIndex > 0) {
      valIndex -= 1;
      accumulatedVolume += lowerVolume;
    } else {
      break;
    }
  }

  return {
    vahIndex,
    valIndex,
    vahPrice: bins[vahIndex].priceHigh,
    valPrice: bins[valIndex].priceLow,
  };
}
