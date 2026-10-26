import { describe, expect, it } from "vitest";
import { HISTORICAL_INSTRUMENTS, type HistoricalInstrument } from "./historicalCatalog";
import {
  DAY_MS,
  FIRST_MONDAY_MS,
  FLOW_CHUNK_BARS,
  MAX_FLOW_CHUNK_MS,
  chartFlowBars,
  flowBucketMs,
  flowChunks,
  flowSpan,
  MAX_PROFILE_BLOCKS_PER_REQUEST,
  MAX_VPIN_WEEKS_PER_REQUEST,
  MINUTE_MS,
  PRINT_CHUNK_BARS,
  WEEK_MS,
  VPIN_CALIBRATION_WINDOW_MS,
  archiveStudiesSupported,
  contiguousRuns,
  printBucketMs,
  printChunks,
  profileBlocks,
  profileBlocksPerRequest,
  studyAssetClass,
  studyCoverage,
  studySegmentsFor,
  studyTickSize,
  vpinWeeks,
  weekStartOf,
} from "./archiveStudyPlan";

function instrument(id: string): HistoricalInstrument {
  const found = HISTORICAL_INSTRUMENTS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing ${id}`);
  return found;
}

const HOUR_MS = 60 * MINUTE_MS;
const COVERAGE = { fromTs: Date.parse("2025-09-01T00:00:00.000Z"), toTs: Date.parse("2026-09-01T00:00:00.000Z") };

describe("archive study planning", () => {
  it("builds contiguous roll segments for a continuous future and one segment for an equity", () => {
    const es = studySegmentsFor(instrument("es-continuous"));
    expect(es.length).toBe(5);
    for (let index = 1; index < es.length; index += 1) expect(es[index].fromTs).toBe(es[index - 1].toTs);
    expect(es[1]).toMatchObject({ instrumentId: '["XCME","FUTURE","ESZ5","USD","CONTRACT"]', fromTs: Date.parse("2025-09-17T00:00:00.000Z") });
    expect(studyCoverage(es)).toEqual({ fromTs: Date.parse("2025-09-01T00:00:00.000Z"), toTs: Date.parse("2026-09-01T00:00:00.000Z") });
    const aapl = studySegmentsFor(instrument("aapl"));
    expect(aapl).toEqual([expect.objectContaining({ fromTs: Date.parse("2025-09-02T00:00:00.000Z") })]);
    expect(studyCoverage(studySegmentsFor(instrument("btc-spot")))).toEqual({
      fromTs: Date.parse("2025-09-06T00:00:00.000Z"),
      toTs: Date.parse("2026-09-01T00:00:00.000Z"),
    });
    expect(studyCoverage([])).toBeNull();
  });

  it("uses the conversion tick geometry for supported Databento and Binance instruments", () => {
    expect(studyTickSize(instrument("es-continuous"))).toBe(0.25);
    expect(studyTickSize(instrument("aapl"))).toBe(0.01);
    expect(studyAssetClass(instrument("nq-continuous"))).toBe("FUTURE");
    expect(studyAssetClass(instrument("tsla"))).toBe("EQUITY");
    expect(archiveStudiesSupported(instrument("es-continuous"))).toBe(true);
    expect(archiveStudiesSupported(instrument("btc-perpetual"))).toBe(true);
    expect(studyAssetClass(instrument("btc-perpetual"))).toBe("PERPETUAL");
    expect(studyAssetClass(instrument("btc-spot"))).toBe("SPOT");
    expect(studyTickSize(instrument("btc-perpetual"))).toBe(0.1);
    expect(studyTickSize(instrument("btc-spot"))).toBe(0.01);
  });

  it("asks only for whole visible profile periods inside coverage", () => {
    const from = Date.parse("2025-10-06T05:00:00.000Z");
    const blocks = profileBlocks(from, from + 3 * DAY_MS, DAY_MS, COVERAGE);
    expect(blocks.every((block) => block.toTs - block.fromTs === DAY_MS)).toBe(true);
    expect(blocks.every((block) => block.fromTs % DAY_MS === 0)).toBe(true);
    expect(profileBlocks(COVERAGE.fromTs - 2 * DAY_MS, COVERAGE.fromTs + DAY_MS, DAY_MS, COVERAGE)
      .every((block) => block.fromTs >= COVERAGE.fromTs)).toBe(true);
  });

  it("aligns VPIN weeks to Monday 00:00 UTC and drops weeks the archive cannot finish", () => {
    expect(new Date(FIRST_MONDAY_MS).getUTCDay()).toBe(1);
    const wednesday = Date.parse("2025-10-08T13:00:00.000Z");
    expect(new Date(weekStartOf(wednesday)).toISOString()).toBe("2025-10-06T00:00:00.000Z");
    const weeks = vpinWeeks(wednesday, wednesday + 10 * DAY_MS, COVERAGE);
    expect(weeks.map((week) => new Date(week).toISOString())).toEqual([
      "2025-10-06T00:00:00.000Z", "2025-10-13T00:00:00.000Z",
    ]);
    const tail = vpinWeeks(COVERAGE.toTs - 3 * DAY_MS, COVERAGE.toTs, COVERAGE);
    expect(tail.every((week) => week + WEEK_MS <= COVERAGE.toTs)).toBe(true);
    expect(vpinWeeks(wednesday, wednesday, COVERAGE)).toEqual([]);
    expect(vpinWeeks(COVERAGE.fromTs, COVERAGE.fromTs + VPIN_CALIBRATION_WINDOW_MS, COVERAGE)).toEqual([]);
    expect(vpinWeeks(COVERAGE.fromTs + VPIN_CALIBRATION_WINDOW_MS, COVERAGE.fromTs + VPIN_CALIBRATION_WINDOW_MS + WEEK_MS, COVERAGE))
      .toEqual([COVERAGE.fromTs + VPIN_CALIBRATION_WINDOW_MS]);
  });

  it("buckets prints per bar, falling back to days for calendar timeframes", () => {
    expect(printBucketMs(MINUTE_MS)).toBe(MINUTE_MS);
    expect(printBucketMs(4 * HOUR_MS)).toBe(4 * HOUR_MS);
    expect(printBucketMs(DAY_MS)).toBe(DAY_MS);
    expect(printBucketMs(7 * DAY_MS)).toBe(DAY_MS);
    expect(printBucketMs(7 * HOUR_MS)).toBe(DAY_MS);
  });

  it("splits prints into fixed, bar-aligned chunks so a pan reuses what it already has", () => {
    const from = Date.parse("2025-10-06T10:17:00.000Z");
    const first = printChunks(from, from + 12 * HOUR_MS, MINUTE_MS, COVERAGE);
    const panned = printChunks(from + 2 * HOUR_MS, from + 14 * HOUR_MS, MINUTE_MS, COVERAGE);
    const chunkMs = MINUTE_MS * PRINT_CHUNK_BARS;
    expect(first.every((chunk) => chunk.fromTs % chunkMs === 0 && chunk.toTs - chunk.fromTs === chunkMs)).toBe(true);
    const keys = new Set(first.map((chunk) => `${chunk.fromTs}:${chunk.toTs}`));
    expect(panned.filter((chunk) => keys.has(`${chunk.fromTs}:${chunk.toTs}`)).length).toBeGreaterThan(0);
    const edge = printChunks(COVERAGE.fromTs - chunkMs, COVERAGE.fromTs + MINUTE_MS, MINUTE_MS, COVERAGE);
    expect(edge.every((chunk) => chunk.fromTs >= COVERAGE.fromTs)).toBe(true);
    expect(printChunks(from, from, MINUTE_MS, COVERAGE)).toEqual([]);
  });

  it("keeps each request small enough to finish inside the study deadline at the archive's pace", () => {
    expect(profileBlocksPerRequest(MINUTE_MS)).toBe(MAX_PROFILE_BLOCKS_PER_REQUEST);
    expect(profileBlocksPerRequest(DAY_MS)).toBe(16);
    expect(profileBlocksPerRequest(WEEK_MS)).toBe(2);
    expect(profileBlocksPerRequest(30 * DAY_MS)).toBe(1);
    expect(MAX_VPIN_WEEKS_PER_REQUEST).toBe(2);
    const from = Date.parse("2025-10-06T00:00:00.000Z");
    const daily = printChunks(from, from + 60 * DAY_MS, DAY_MS, COVERAGE);
    expect(daily.every((chunk) => chunk.toTs - chunk.fromTs <= WEEK_MS && chunk.fromTs % DAY_MS === 0)).toBe(true);
    const hourly = printChunks(from, from + 30 * DAY_MS, HOUR_MS, COVERAGE);
    expect(Math.max(...hourly.map((chunk) => chunk.toTs - chunk.fromTs))).toBe(WEEK_MS);
    expect(printChunks(from, from + DAY_MS, MINUTE_MS, COVERAGE)
      .every((chunk) => chunk.toTs - chunk.fromTs <= PRINT_CHUNK_BARS * MINUTE_MS)).toBe(true);
  });

  it("asks for bar flow on the display interval, in chunks no longer than a month", () => {
    expect(flowBucketMs(MINUTE_MS)).toBe(MINUTE_MS);
    expect(flowBucketMs(4 * HOUR_MS)).toBe(4 * HOUR_MS);
    expect(flowBucketMs(30_000)).toBeNull();

    const from = Date.parse("2025-10-06T00:00:00.000Z");
    const minute = flowChunks(from, from + 3 * DAY_MS, MINUTE_MS, COVERAGE);
    expect(minute.every((chunk) => chunk.toTs - chunk.fromTs === FLOW_CHUNK_BARS * MINUTE_MS)).toBe(true);
    expect(minute.every((chunk) => chunk.fromTs % (FLOW_CHUNK_BARS * MINUTE_MS) === 0)).toBe(true);

    const daily = flowChunks(from, from + 200 * DAY_MS, DAY_MS, COVERAGE);
    expect(Math.max(...daily.map((chunk) => chunk.toTs - chunk.fromTs))).toBe(MAX_FLOW_CHUNK_MS);
    expect(daily.every((chunk) => chunk.fromTs >= COVERAGE.fromTs && chunk.toTs <= COVERAGE.toTs)).toBe(true);

    const panned = flowChunks(from + 6 * HOUR_MS, from + 3 * DAY_MS + 6 * HOUR_MS, MINUTE_MS, COVERAGE);
    const keys = new Set(minute.map((chunk) => `${chunk.fromTs}:${chunk.toTs}`));
    expect(panned.filter((chunk) => keys.has(`${chunk.fromTs}:${chunk.toTs}`)).length).toBeGreaterThan(0);
    expect(flowChunks(from, from, MINUTE_MS, COVERAGE)).toEqual([]);
  });

  describe("bar flow on 1W and 1M, whose candles open on Mondays and on the 1st", () => {
    const day = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`);
    const flowOn = (iso: string, buy: number, sell: number) => ({
      ts_open: day(iso), volume: buy + sell + 1, buy_volume: buy, sell_volume: sell, unknown_volume: 1, trade_count: 3,
    });
    const WIDE = { fromTs: day("2025-01-01"), toTs: day("2026-01-01") };

    it("asks for daily flow above 1D, since the archive's 7- and 30-day buckets start on epoch Thursdays and epoch steps", () => {
      expect(flowBucketMs(DAY_MS)).toBe(DAY_MS);
      expect(flowBucketMs(7 * DAY_MS)).toBe(DAY_MS);
      expect(flowBucketMs(30 * DAY_MS)).toBe(DAY_MS);
      expect(new Date(Math.floor(day("2025-10-08") / (7 * DAY_MS)) * 7 * DAY_MS).getUTCDay()).toBe(4);
    });

    it("widens the span it asks for to whole weeks and months, and leaves shorter timeframes as they are", () => {
      expect(flowSpan(day("2025-10-08"), day("2025-10-15"), 7 * DAY_MS)).toEqual({ fromTs: day("2025-10-06"), toTs: day("2025-10-20") });
      expect(flowSpan(day("2025-10-08"), day("2025-12-02"), 30 * DAY_MS)).toEqual({ fromTs: day("2025-10-01"), toTs: day("2026-01-01") });
      expect(flowSpan(day("2025-10-08"), day("2025-10-09"), HOUR_MS)).toEqual({ fromTs: day("2025-10-08"), toTs: day("2025-10-09") });
    });

    it("adds the days up into Monday weeks and calendar months, once every day of each has loaded", () => {
      const october = { range: { fromTs: day("2025-10-01"), toTs: day("2025-11-01") }, bars: [flowOn("2025-10-06", 5, 1), flowOn("2025-10-08", 2, 4), flowOn("2025-10-13", 1, 1), flowOn("2025-10-31", 7, 0)] };
      expect(chartFlowBars([october], 7 * DAY_MS, WIDE)).toEqual([
        { ts_open: day("2025-10-06"), volume: 14, buy_volume: 7, sell_volume: 5, unknown_volume: 2, trade_count: 6 },
        { ts_open: day("2025-10-13"), volume: 3, buy_volume: 1, sell_volume: 1, unknown_volume: 1, trade_count: 3 },
      ]);
      // The week of the 27th runs into November, which has not loaded: it waits.
      const november = { range: { fromTs: day("2025-11-01"), toTs: day("2025-12-01") }, bars: [flowOn("2025-11-02", 1, 0)] };
      expect(chartFlowBars([october, november], 7 * DAY_MS, WIDE).map((bar) => bar.ts_open)).toContain(day("2025-10-27"));
      expect(chartFlowBars([october, november], 30 * DAY_MS, WIDE).map((bar) => [bar.ts_open, bar.buy_volume])).toEqual([
        [day("2025-10-01"), 15],
        [day("2025-11-01"), 1],
      ]);
      expect(chartFlowBars([october], 30 * DAY_MS, WIDE).map((bar) => bar.ts_open)).toEqual([day("2025-10-01")]);
    });

    it("counts a week the archive starts or ends inside as whole once the days it holds have loaded", () => {
      const chunk = { range: { fromTs: day("2025-10-08"), toTs: day("2025-10-15") }, bars: [flowOn("2025-10-08", 1, 1), flowOn("2025-10-13", 2, 2)] };
      expect(chartFlowBars([chunk], 7 * DAY_MS, { fromTs: day("2025-10-08"), toTs: day("2025-10-15") }).map((bar) => bar.ts_open))
        .toEqual([day("2025-10-06"), day("2025-10-13")]);
      expect(chartFlowBars([chunk], 7 * DAY_MS, WIDE)).toEqual([]);
    });

    it("passes daily and shorter flow through as the archive bucketed it", () => {
      const chunk = { range: { fromTs: day("2025-10-06"), toTs: day("2025-10-08") }, bars: [flowOn("2025-10-07", 1, 1), flowOn("2025-10-06", 2, 2)] };
      expect(chartFlowBars([chunk], DAY_MS, WIDE).map((bar) => bar.ts_open)).toEqual([day("2025-10-06"), day("2025-10-07")]);
    });
  });

  it("joins adjacent steps into runs no longer than the request cap", () => {
    const base = Date.parse("2025-10-06T00:00:00.000Z");
    const starts = [base, base + WEEK_MS, base + 2 * WEEK_MS, base + 5 * WEEK_MS];
    expect(contiguousRuns(starts, WEEK_MS, 26)).toEqual([
      { fromTs: base, toTs: base + 3 * WEEK_MS },
      { fromTs: base + 5 * WEEK_MS, toTs: base + 6 * WEEK_MS },
    ]);
    expect(contiguousRuns(starts.slice(0, 3), WEEK_MS, 2)).toEqual([
      { fromTs: base, toTs: base + 2 * WEEK_MS },
      { fromTs: base + 2 * WEEK_MS, toTs: base + 3 * WEEK_MS },
    ]);
    expect(contiguousRuns([], WEEK_MS, 26)).toEqual([]);
  });
});
