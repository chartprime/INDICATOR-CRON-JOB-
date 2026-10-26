const fc = require("fast-check");
const { spanOf, mergeSpans, clipSpansBefore, spansUntil, uncoveredIn, intersectSpans, subtractSpans, sameSpans } = require("../../../src/indicators/iceberg/spans");

function subtractOneHoleAtATime(spans, holes) {
  let out = spans.map(([from, to]) => [from, to]);
  for (const [holeFrom, holeTo] of holes) {
    const next = [];
    for (const [from, to] of out) {
      if (holeTo <= from || holeFrom >= to) {
        next.push([from, to]);
        continue;
      }
      if (holeFrom > from) next.push([from, holeFrom]);
      if (holeTo < to) next.push([holeTo, to]);
    }
    out = next;
  }
  return out;
}

describe("indicators/iceberg/spans", () => {
  test("a span is a pair of epoch-ms integers with from before to; anything else is null", () => {
    expect(spanOf(1, 2)).toEqual([1, 2]);
    for (const [from, to] of [[2, 1], [1, 1], [-1, 2], [1.5, 2], ["1", 2], [1, Number.NaN], [1, 9e15]]) expect(spanOf(from, to)).toBeNull();
  });

  test("merge sorts, joins spans that touch or overlap, leaves gaps alone, and drops the oldest past the bound", () => {
    expect(mergeSpans([[3000, 4000], [1000, 2000], [2000, 2500], [3500, 3600]])).toEqual([[1000, 2500], [3000, 4000]]);
    expect(mergeSpans([])).toEqual([]);
    expect(mergeSpans([[0, 50], [100, 150], [200, 250], [300, 350]], 2)).toEqual([[200, 250], [300, 350]]);
    const input = [[5, 6], [1, 2]];
    mergeSpans(input);
    expect(input).toEqual([[5, 6], [1, 2]]);
  });

  test("clipSpansBefore drops what ends at or before the cut and shortens what straddles it", () => {
    expect(clipSpansBefore([[0, 100], [100, 200], [300, 400]], 150)).toEqual([[150, 200], [300, 400]]);
    expect(clipSpansBefore([[0, 100]], 100)).toEqual([]);
  });

  test("spansUntil keeps what starts before the limit and ends each span there", () => {
    expect(spansUntil([[1000, 2500], [3000, 4000]], 3500)).toEqual([[1000, 2500], [3000, 3500]]);
    expect(spansUntil([[1000, 2500], [3000, 4000]], 3000)).toEqual([[1000, 2500]]);
    expect(spansUntil([[1000, 2500]], 500)).toEqual([]);
  });

  test("uncoveredIn lists the gaps of a window that no span covers", () => {
    const spans = [[1000, 2500], [3000, 4000]];
    expect(uncoveredIn(spans, 0, 5000)).toEqual([[0, 1000], [2500, 3000], [4000, 5000]]);
    expect(uncoveredIn(spans, 1100, 2400)).toEqual([]);
    expect(uncoveredIn(spans, 2600, 2900)).toEqual([[2600, 2900]]);
    expect(uncoveredIn([], 10, 20)).toEqual([[10, 20]]);
    expect(() => uncoveredIn(spans, 2, 1)).toThrow(/window/);
  });

  test("intersect and subtract work span by span", () => {
    expect(intersectSpans([[0, 100], [200, 300]], [[50, 250]])).toEqual([[50, 100], [200, 250]]);
    expect(intersectSpans([[0, 100]], [[100, 200]])).toEqual([]);
    expect(subtractSpans([[0, 100], [200, 300]], [[50, 60], [90, 210]])).toEqual([[0, 50], [60, 90], [210, 300]]);
    expect(subtractSpans([[0, 100]], [])).toEqual([[0, 100]]);
    expect(subtractSpans([[0, 100]], [[0, 100]])).toEqual([]);
  });

  test("subtract cuts each span by holes given in any order, joined, overlapping, outside or covering everything, keeps the span order and never leaves an empty piece", () => {
    expect(subtractSpans([[0, 100]], [[70, 80], [10, 20], [40, 50]])).toEqual([[0, 10], [20, 40], [50, 70], [80, 100]]);
    expect(subtractSpans([[0, 100]], [[20, 30], [10, 20]])).toEqual([[0, 10], [30, 100]]);
    expect(subtractSpans([[0, 100]], [[10, 40], [30, 60], [35, 45]])).toEqual([[0, 10], [60, 100]]);
    expect(subtractSpans([[100, 200], [300, 400]], [[0, 100], [200, 300], [400, 500]])).toEqual([[100, 200], [300, 400]]);
    expect(subtractSpans([[100, 200]], [[50, 120], [180, 250]])).toEqual([[120, 180]]);
    expect(subtractSpans([[100, 200]], [[100, 110]])).toEqual([[110, 200]]);
    expect(subtractSpans([[100, 200], [300, 400]], [[0, 1000]])).toEqual([]);
    expect(subtractSpans([[0, 100], [200, 300]], [[50, 250]])).toEqual([[0, 50], [250, 300]]);
    expect(subtractSpans([[300, 400], [0, 100]], [[350, 360], [50, 60]])).toEqual([[300, 350], [360, 400], [0, 50], [60, 100]]);
    expect(subtractSpans([], [[0, 10]])).toEqual([]);
  });

  test("subtract answers exactly what cutting one hole at a time from every piece answers, for any spans and holes", () => {
    const span = fc.tuple(fc.integer({ min: 0, max: 300 }), fc.integer({ min: 1, max: 80 })).map(([from, length]) => [from, from + length]);
    fc.assert(fc.property(fc.array(span, { maxLength: 6 }), fc.array(span, { maxLength: 30 }), (spans, holes) => {
      const given = JSON.stringify([spans, holes]);
      const pieces = subtractSpans(spans, holes);
      expect(pieces).toEqual(subtractOneHoleAtATime(spans, holes));
      expect(pieces.filter(([from, to]) => from >= to)).toEqual([]);
      expect(JSON.stringify([spans, holes])).toBe(given);
      const coverage = mergeSpans(spans);
      const gaps = [...holes].sort((a, b) => a[0] - b[0]);
      expect(subtractSpans(coverage, gaps)).toEqual(subtractOneHoleAtATime(coverage, gaps));
    }), { numRuns: 5_000 });
  });

  test("subtract is one sweep over the holes: eight times the holes costs about eight times as much, not sixty-four", () => {
    const timeSubtract = (count) => {
      const holes = Array.from({ length: count }, (_unused, i) => [i * 10 + 2, i * 10 + 7]);
      const startedAt = process.hrtime.bigint();
      const pieces = subtractSpans([[0, count * 10]], holes);
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      expect(pieces).toHaveLength(count + 1);
      return ms;
    };
    timeSubtract(500);
    timeSubtract(4_000);
    const fewMs = Math.min(timeSubtract(500), timeSubtract(500), timeSubtract(500));
    const manyMs = Math.min(timeSubtract(4_000), timeSubtract(4_000), timeSubtract(4_000));
    expect(manyMs).toBeLessThan(fewMs * 16 + 5);
  });

  test("sameSpans compares by value", () => {
    expect(sameSpans([[1, 2]], [[1, 2]])).toBe(true);
    expect(sameSpans([[1, 2]], [[1, 3]])).toBe(false);
    expect(sameSpans([], [[1, 2]])).toBe(false);
  });
});
