import type { Stream } from "./stream";

interface StdevState {
  committedValues: number[];
  committedHead: number;
  committedCount: number;
  committedMean: number;
  committedM2: number;
  pendingValue: number | null;
}

function isValidLength(length: number): boolean {
  return Number.isSafeInteger(length) && length >= 1;
}

function reset(state: StdevState): void {
  state.committedValues = [];
  state.committedHead = 0;
  state.committedCount = 0;
  state.committedMean = 0;
  state.committedM2 = 0;
}

function addMoment(mean: number, m2: number, count: number, value: number): { mean: number; m2: number } {
  const nextMean = mean + (value - mean) / count;
  return { mean: nextMean, m2: m2 + (value - mean) * (value - nextMean) };
}

function removeMoment(mean: number, m2: number, count: number, value: number): { mean: number; m2: number } {
  const nextCount = count - 1;
  if (nextCount === 0) return { mean: 0, m2: 0 };
  const nextMean = (count * mean - value) / nextCount;
  return { mean: nextMean, m2: Math.max(0, m2 - (value - mean) * (value - nextMean)) };
}

function finalizeCommit(state: StdevState, newValue: number, length: number): void {
  if (!Number.isFinite(newValue)) return;
  if (state.committedCount < length) {
    state.committedValues[(state.committedHead + state.committedCount) % length] = newValue;
    state.committedCount += 1;
    const next = addMoment(state.committedMean, state.committedM2, state.committedCount, newValue);
    state.committedMean = next.mean;
    state.committedM2 = next.m2;
  } else {
    const evicted = state.committedValues[state.committedHead];
    state.committedValues[state.committedHead] = newValue;
    state.committedHead = (state.committedHead + 1) % length;
    if (length === 1) {
      state.committedMean = newValue;
      state.committedM2 = 0;
      return;
    }
    const removed = removeMoment(state.committedMean, state.committedM2, length, evicted);
    const next = addMoment(removed.mean, removed.m2, length, newValue);
    state.committedMean = next.mean;
    state.committedM2 = next.m2;
  }
}

function tentativeValue(state: StdevState, value: number, length: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (state.committedCount < length) {
    const count = state.committedCount + 1;
    if (count !== length) return null;
    const next = addMoment(state.committedMean, state.committedM2, count, value);
    return Math.sqrt(Math.max(0, next.m2 / length));
  }
  if (length === 1) return 0;
  const evicted = state.committedValues[state.committedHead];
  const removed = removeMoment(state.committedMean, state.committedM2, length, evicted);
  const next = addMoment(removed.mean, removed.m2, length, value);
  return Math.sqrt(Math.max(0, next.m2 / length));
}

export function stdev(length: number): Stream<number, number> {
  const state: StdevState = {
    committedValues: [],
    committedHead: 0,
    committedCount: 0,
    committedMean: 0,
    committedM2: 0,
    pendingValue: null,
  };
  return {
    push(value: number, replace: boolean): number | null {
      if (!isValidLength(length)) {
        reset(state);
        state.pendingValue = null;
        return null;
      }
      if (!replace && state.pendingValue !== null) {
        finalizeCommit(state, state.pendingValue, length);
      }
      state.pendingValue = value;
      return tentativeValue(state, value, length);
    },
  };
}
