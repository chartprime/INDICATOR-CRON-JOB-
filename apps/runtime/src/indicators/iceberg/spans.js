const MAX_EPOCH_MS = 8_640_000_000_000_000;

function isEpochMs(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_EPOCH_MS;
}

function spanOf(from, to) {
  return isEpochMs(from) && isEpochMs(to) && from < to ? [from, to] : null;
}

function mergeSpans(list, maxSpans = Number.POSITIVE_INFINITY) {
  const out = [];
  for (const [from, to] of [...list].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last !== undefined && from <= last[1]) {
      if (to > last[1]) last[1] = to;
      continue;
    }
    out.push([from, to]);
  }
  while (out.length > maxSpans) out.shift();
  return out;
}

function clipSpansBefore(spans, ts) {
  const out = [];
  for (const [from, to] of spans) {
    if (to <= ts) continue;
    out.push([Math.max(from, ts), to]);
  }
  return out;
}

function spansUntil(spans, until) {
  return spans.filter(([from]) => from < until).map(([from, to]) => [from, Math.min(to, until)]);
}

function uncoveredIn(spans, from, to) {
  if (spanOf(from, to) === null) throw new Error("spans: uncoveredIn expects an epoch-ms window with from before to");
  const gaps = [];
  let cursor = from;
  for (const [start, end] of spans) {
    if (end <= cursor) continue;
    if (start >= to) break;
    if (start > cursor) gaps.push([cursor, start]);
    cursor = Math.max(cursor, end);
    if (cursor >= to) break;
  }
  if (cursor < to) gaps.push([cursor, to]);
  return gaps;
}

function intersectSpans(a, b) {
  const out = [];
  for (const [aFrom, aTo] of a) {
    for (const [bFrom, bTo] of b) {
      const from = Math.max(aFrom, bFrom);
      const to = Math.min(aTo, bTo);
      if (from < to) out.push([from, to]);
    }
  }
  return mergeSpans(out);
}

function subtractSpans(spans, holes) {
  const merged = mergeSpans(holes);
  const out = [];
  for (const [from, to] of spans) {
    let lo = 0;
    let hi = merged.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (merged[mid][1] <= from) lo = mid + 1;
      else hi = mid;
    }
    let cursor = from;
    for (let i = lo; i < merged.length && merged[i][0] < to; i += 1) {
      if (merged[i][0] > cursor) out.push([cursor, merged[i][0]]);
      cursor = merged[i][1];
    }
    if (cursor < to) out.push([cursor, to]);
  }
  return out;
}

function sameSpans(a, b) {
  return a.length === b.length && a.every((span, index) => span[0] === b[index][0] && span[1] === b[index][1]);
}

module.exports = { isEpochMs, spanOf, mergeSpans, clipSpansBefore, spansUntil, uncoveredIn, intersectSpans, subtractSpans, sameSpans };
