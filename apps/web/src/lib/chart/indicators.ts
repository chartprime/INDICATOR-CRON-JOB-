function isUsableLength(valuesLength: number, length: number): boolean {
  return Number.isInteger(length) && length > 0 && valuesLength >= length;
}

function hasOnlyFiniteValues(values: readonly number[]): boolean {
  return values.every(Number.isFinite);
}

function windowMean(values: readonly number[], start: number, length: number): number {
  let sum = 0;
  for (let i = start; i < start + length; i += 1) sum += values[i];
  return sum / length;
}

export function ema(values: readonly number[], length: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (!isUsableLength(values.length, length) || !hasOnlyFiniteValues(values)) return result;

  const k = 2 / (length + 1);
  let prev = windowMean(values, 0, length);
  result[length - 1] = prev;
  for (let i = length; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    result[i] = prev;
  }
  return result;
}

export function rsi(values: readonly number[], length: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (!isUsableLength(values.length, length + 1) || !hasOnlyFiniteValues(values)) return result;

  const gains: number[] = new Array(values.length).fill(0);
  const losses: number[] = new Array(values.length).fill(0);
  for (let i = 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    gains[i] = Math.max(change, 0);
    losses[i] = Math.max(-change, 0);
  }

  let avgGain = windowMean(gains, 1, length);
  let avgLoss = windowMean(losses, 1, length);
  result[length] = rsiFromAverages(avgGain, avgLoss);

  for (let i = length + 1; i < values.length; i += 1) {
    avgGain = (avgGain * (length - 1) + gains[i]) / length;
    avgLoss = (avgLoss * (length - 1) + losses[i]) / length;
    result[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return result;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export interface BollingerBandsPoint {
  basis: number;
  upper: number;
  lower: number;
}

export function bollingerBands(
  values: readonly number[],
  length: number,
  mult: number,
): (BollingerBandsPoint | null)[] {
  const result: (BollingerBandsPoint | null)[] = new Array(values.length).fill(null);
  if (!isUsableLength(values.length, length) || !Number.isFinite(mult) || mult < 0 || !hasOnlyFiniteValues(values)) return result;

  for (let i = length - 1; i < values.length; i += 1) {
    const start = i - length + 1;
    const basis = windowMean(values, start, length);
    let variance = 0;
    for (let j = start; j < start + length; j += 1) {
      const diff = values[j] - basis;
      variance += diff * diff;
    }
    variance /= length;
    const dev = Math.sqrt(variance) * mult;
    result[i] = { basis, upper: basis + dev, lower: basis - dev };
  }
  return result;
}
