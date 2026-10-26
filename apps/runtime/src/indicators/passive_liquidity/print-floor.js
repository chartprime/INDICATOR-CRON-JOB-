"use strict";

function createPrintFloor({ window, share, minSamples }) {
  if (!Number.isSafeInteger(window) || window <= 0) throw new Error("print-floor: window must be a positive safe integer");
  if (!(share > 0 && share < 1)) throw new Error("print-floor: share must be in (0, 1)");
  if (!Number.isSafeInteger(minSamples) || minSamples <= 0) throw new Error("print-floor: minSamples must be a positive safe integer");

  const arrivals = new Float64Array(window);
  const sorted = new Float64Array(window);
  let next = 0;
  let filled = 0;

  function firstAbove(size) {
    let lo = 0;
    let hi = filled;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] <= size) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function remove(size) {
    const at = firstAbove(size) - 1;
    sorted.copyWithin(at, at + 1, filled);
    filled -= 1;
  }

  function insert(size) {
    const at = firstAbove(size);
    sorted.copyWithin(at + 1, at, filled);
    sorted[at] = size;
    filled += 1;
  }

  function push(size) {
    if (filled === window) remove(arrivals[next]);
    arrivals[next] = size;
    next = (next + 1) % window;
    insert(size);
  }

  function value() {
    if (filled < minSamples) return 0;
    const index = Math.min(filled - 1, Math.max(0, Math.ceil(filled * (1 - share)) - 1));
    return sorted[index];
  }

  return Object.freeze({ push, value });
}

module.exports = { createPrintFloor };
