import type { Stream } from "./stream";

interface ExtremumEntry {
  index: number;
  value: number;
}

interface ExtremumState {
  committedCount: number;
  committedIndex: number;
  entries: ExtremumEntry[];
  entriesHead: number;
  pendingValue: number | null;
}

interface PreviousState {
  committedCount: number;
  committedHead: number;
  committedValues: number[];
  pendingValue: number | null;
}

function isValidLength(length: number): boolean {
  return Number.isSafeInteger(length) && length >= 1;
}

function resetExtremum(state: ExtremumState): void {
  state.committedCount = 0;
  state.committedIndex = 0;
  state.entries = [];
  state.entriesHead = 0;
  state.pendingValue = null;
}

function compactExtremumEntries(state: ExtremumState): void {
  if (state.entriesHead === 0) return;
  if (state.entriesHead === state.entries.length) {
    state.entries = [];
    state.entriesHead = 0;
    return;
  }
  if (
    state.entriesHead >= 1_024 &&
    state.entriesHead * 2 >= state.entries.length
  ) {
    state.entries = state.entries.slice(state.entriesHead);
    state.entriesHead = 0;
  }
}

function commitExtremum(
  state: ExtremumState,
  value: number,
  length: number,
  prefers: (candidate: number, existing: number) => boolean,
): void {
  if (!Number.isFinite(value)) return;
  state.committedIndex += 1;
  state.committedCount = Math.min(length, state.committedCount + 1);
  while (
    state.entries.length > state.entriesHead &&
    prefers(value, state.entries[state.entries.length - 1].value)
  ) {
    state.entries.pop();
  }
  compactExtremumEntries(state);
  state.entries.push({ index: state.committedIndex, value });
}

function extremum(
  length: number,
  prefers: (candidate: number, existing: number) => boolean,
): Stream<number, number> {
  const state: ExtremumState = {
    committedCount: 0,
    committedIndex: 0,
    entries: [],
    entriesHead: 0,
    pendingValue: null,
  };
  return {
    push(value: number, replace: boolean): number | null {
      if (!isValidLength(length)) {
        resetExtremum(state);
        return null;
      }
      if (!replace && state.pendingValue !== null) {
        commitExtremum(state, state.pendingValue, length, prefers);
      }
      state.pendingValue = value;
      if (!Number.isFinite(value)) return null;

      const pendingIndex = state.committedIndex + 1;
      const firstIncludedIndex = pendingIndex - length + 1;
      while (
        state.entriesHead < state.entries.length &&
        state.entries[state.entriesHead].index < firstIncludedIndex
      ) {
        state.entriesHead += 1;
      }
      compactExtremumEntries(state);
      if (state.committedCount + 1 < length) return null;
      const committedExtremum = state.entries[state.entriesHead]?.value;
      return committedExtremum === undefined ||
        prefers(value, committedExtremum)
        ? value
        : committedExtremum;
    },
  };
}

export function highest(length: number): Stream<number, number> {
  return extremum(length, (candidate, existing) => candidate >= existing);
}

export function lowest(length: number): Stream<number, number> {
  return extremum(length, (candidate, existing) => candidate <= existing);
}

interface PivotState {
  committedValues: number[];
  pendingValue: number | null;
}

function resetPivot(state: PivotState): void {
  state.committedValues = [];
  state.pendingValue = null;
}

function isValidPivotStrength(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function pivot(
  leftBars: number,
  rightBars: number,
  prefers: (candidate: number, neighbor: number) => boolean,
): Stream<number, number> {
  const state: PivotState = { committedValues: [], pendingValue: null };
  return {
    push(value: number, replace: boolean): number | null {
      if (!isValidPivotStrength(leftBars) || !isValidPivotStrength(rightBars)) {
        resetPivot(state);
        return null;
      }
      const windowSize = leftBars + rightBars + 1;
      if (!replace && state.pendingValue !== null) {
        state.committedValues.push(state.pendingValue);
        if (state.committedValues.length > windowSize) {
          state.committedValues.splice(0, state.committedValues.length - windowSize);
        }
      }
      state.pendingValue = value;

      const values = [...state.committedValues, value];
      const candidateIndex = values.length - 1 - rightBars;
      if (
        candidateIndex < leftBars ||
        candidateIndex + rightBars >= values.length
      )
        return null;
      const candidate = values[candidateIndex];
      if (!Number.isFinite(candidate)) return null;
      for (
        let index = candidateIndex - leftBars;
        index <= candidateIndex + rightBars;
        index += 1
      ) {
        if (
          index !== candidateIndex &&
          (!Number.isFinite(values[index]) ||
            !prefers(candidate, values[index]))
        ) {
          return null;
        }
      }
      return candidate;
    },
  };
}

export function pivotHigh(
  leftBars: number,
  rightBars: number,
): Stream<number, number> {
  return pivot(
    leftBars,
    rightBars,
    (candidate, neighbor) => candidate > neighbor,
  );
}

export function pivotLow(
  leftBars: number,
  rightBars: number,
): Stream<number, number> {
  return pivot(
    leftBars,
    rightBars,
    (candidate, neighbor) => candidate < neighbor,
  );
}

function resetPrevious(state: PreviousState): void {
  state.committedCount = 0;
  state.committedHead = 0;
  state.committedValues = [];
  state.pendingValue = null;
}

function commitPrevious(
  state: PreviousState,
  value: number,
  offset: number,
): void {
  if (!Number.isFinite(value)) return;
  if (state.committedCount < offset) {
    state.committedValues[
      (state.committedHead + state.committedCount) % offset
    ] = value;
    state.committedCount += 1;
    return;
  }
  state.committedValues[state.committedHead] = value;
  state.committedHead = (state.committedHead + 1) % offset;
}

export function prev(offset: number): Stream<number, number> {
  const state: PreviousState = {
    committedCount: 0,
    committedHead: 0,
    committedValues: [],
    pendingValue: null,
  };
  return {
    push(value: number, replace: boolean): number | null {
      if (!isValidLength(offset)) {
        resetPrevious(state);
        return null;
      }
      if (!replace && state.pendingValue !== null) {
        commitPrevious(state, state.pendingValue, offset);
      }
      state.pendingValue = value;
      return state.committedCount === offset
        ? state.committedValues[state.committedHead]
        : null;
    },
  };
}

interface Pair {
  a: number;
  b: number;
}

function crossDetector(direction: "over" | "under"): Stream<Pair, boolean> {
  let committedPrev: Pair | null = null;
  let pendingValue: Pair | null = null;

  return {
    push(value: Pair, replace: boolean): boolean {
      if (!replace && pendingValue !== null) {
        committedPrev = pendingValue;
      }
      pendingValue = value;
      if (!committedPrev) return false;
      return direction === "over"
        ? committedPrev.a <= committedPrev.b && value.a > value.b
        : committedPrev.a >= committedPrev.b && value.a < value.b;
    },
  };
}

export function crossover(): Stream<Pair, boolean> {
  return crossDetector("over");
}

export function crossunder(): Stream<Pair, boolean> {
  return crossDetector("under");
}
