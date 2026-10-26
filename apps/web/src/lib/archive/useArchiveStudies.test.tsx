// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChartPanelHandle } from "../../components/chart/ChartPanel";
import type { VpinReading } from "../../types/frames";
import type { WhaleTradeStat } from "../indicators/whale-detector/whaleTrades";
import {
  HISTORICAL_INSTRUMENTS,
  type HistoricalInstrument,
} from "./historicalCatalog";
import type {
  ArchiveStudyRequest,
  ArchiveStudyResult,
} from "./archiveStudyClient";
import { DAY_MS, MINUTE_MS, WEEK_MS } from "./archiveStudyPlan";
import {
  useArchiveStudies,
  type ArchiveStudiesStatus,
  type ArchiveStudyProfileSettings,
  type ArchiveStudyToggles,
} from "./useArchiveStudies";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ES = HISTORICAL_INSTRUMENTS.find(
  (candidate) => candidate.id === "es-continuous",
) as HistoricalInstrument;
const BTC = HISTORICAL_INSTRUMENTS.find(
  (candidate) => candidate.id === "btc-spot",
) as HistoricalInstrument;
const MONDAY = Date.parse("2025-10-06T00:00:00.000Z");
const CONTINUOUS_DAY: ArchiveStudyProfileSettings = {
  mode: "continuous",
  periodMs: DAY_MS,
  binSizeMultiplier: 1,
};
const OFF: ArchiveStudyToggles = {
  profile: false,
  vpin: false,
  prints: false,
  flow: false,
};

type RangeHandler = (fromMs: number, toMs: number) => void;

function fakeChart(initial: { fromMs: number; toMs: number } | null) {
  let handler: RangeHandler | null = null;
  const chart = {
    applyHistoricalProfiles: vi.fn(),
    applyVpinReadings: vi.fn(),
    applyMarkerSnapshot: vi.fn(),
    applyBarFlow: vi.fn(),
    subscribeVisibleRangeChange: vi.fn((next: RangeHandler) => {
      handler = next;
      if (initial !== null) next(initial.fromMs, initial.toMs);
      return () => {
        handler = null;
      };
    }),
  };
  return {
    chart,
    ref: { current: chart as unknown as ChartPanelHandle },
    pan: (fromMs: number, toMs: number) => handler?.(fromMs, toMs),
    subscribed: () => handler !== null,
  };
}

function profileFor(start: number, requestId: number) {
  return {
    mode: "continuous" as const,
    delivery_scope: "HISTORICAL" as const,
    history_request_id: requestId,
    period_start_ts: start,
    period_end_ts: start + DAY_MS,
    row_width: 0.25,
    buckets: [
      {
        price: 6000,
        volume: 5,
        buy_volume: 3,
        sell_volume: 2,
        single_print: false,
      },
    ],
    poc_price: 6000,
    vah_price: 6000,
    val_price: 6000,
  };
}

function readingAt(seal: number): VpinReading {
  return {
    seal_ts: seal,
    active: true,
    direction: "buy",
    strength: 0.6,
    z_vpin: 2,
    z_velocity: 1,
    z_acceleration: 0.5,
    activated_at_ts: seal,
  };
}

function answer(request: ArchiveStudyRequest): ArchiveStudyResult {
  if (request.study === "volume_profile") {
    return {
      outcome: "volume_profile",
      profiles: request.ranges.map((range) =>
        profileFor(range.fromTs, request.requestId),
      ),
      missing: [],
      empty: [],
      complete: true,
    };
  }
  if (request.study === "vpin") {
    const readings: VpinReading[] = [];
    for (
      let week = request.ranges[0].fromTs;
      week < request.ranges[0].toTs;
      week += WEEK_MS
    )
      readings.push(readingAt(week + DAY_MS));
    return { outcome: "vpin", readings, missing: [], complete: true };
  }
  const start = request.ranges[0].fromTs;
  return {
    outcome: "large_prints",
    prints: [
      { ts_exchange: start + 1_000, price: 6000, size: 25, side: "buy" },
      { ts_exchange: start + 2_000, price: 6000.25, size: 5, side: "sell" },
    ],
    missing: [],
    complete: true,
  };
}

let root: Root;
let container: HTMLDivElement;
let status: ArchiveStudiesStatus;

function Harness(props: Parameters<typeof useArchiveStudies>[0]) {
  status = useArchiveStudies(props);
  return null;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function render(props: Parameters<typeof useArchiveStudies>[0]) {
  return act(async () => root.render(<Harness {...props} />));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("useArchiveStudies", () => {
  it("pins study requests to the chart page and re-reads after a pointer change", async () => {
    const view = fakeChart({ fromMs: MONDAY, toMs: MONDAY + DAY_MS - 60 * MINUTE_MS });
    const run = vi.fn(async (request: ArchiveStudyRequest) => answer(request));
    const base = {
      chartRef: view.ref, instrument: ES, intervalMs: 60 * MINUTE_MS,
      profileSettings: CONTINUOUS_DAY, client: { run }, debounceMs: 0,
      toggles: { ...OFF, profile: true },
    };
    await render({ ...base, pointerToken: "snapshot_1" });
    await settle();
    expect(run.mock.calls[0][0].pointerToken).toBe("snapshot_1");
    await render({ ...base, pointerToken: "snapshot_2" });
    await settle();
    expect(run.mock.calls.at(-1)?.[0].pointerToken).toBe("snapshot_2");
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("aborts obsolete work and re-plans the still-needed overlapping profile periods", async () => {
    const view = fakeChart({ fromMs: MONDAY, toMs: MONDAY + 3 * DAY_MS - 60 * MINUTE_MS });
    let oldSignal: AbortSignal | undefined;
    const run = vi.fn((request: ArchiveStudyRequest, options?: { signal?: AbortSignal }): Promise<ArchiveStudyResult> => {
      if (oldSignal !== undefined) return Promise.resolve(answer(request));
      oldSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    await render({ chartRef: view.ref, instrument: ES, intervalMs: 60 * MINUTE_MS, profileSettings: CONTINUOUS_DAY, client: { run }, debounceMs: 0, toggles: { ...OFF, profile: true } });
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    await act(async () => view.pan(MONDAY + DAY_MS, MONDAY + 4 * DAY_MS - 60 * MINUTE_MS));
    await settle();
    expect(oldSignal!.aborted).toBe(true);
    const requestedStarts = run.mock.calls.slice(1).flatMap(([request]) => request.ranges.map((range) => range.fromTs));
    expect(new Set(requestedStarts)).toEqual(new Set([MONDAY + DAY_MS, MONDAY + 2 * DAY_MS, MONDAY + 3 * DAY_MS]));
    expect(status.issue).toBeNull();
    expect(status.loading).toBe(false);
    expect(view.chart.applyHistoricalProfiles.mock.calls.at(-1)?.[0]).toHaveLength(3);
  });
  it("computes the visible profile periods when the study is switched on, then reuses them while panning", async () => {
    const view = fakeChart({
      fromMs: MONDAY,
      toMs: MONDAY + 3 * DAY_MS - 60 * MINUTE_MS,
    });
    const run = vi.fn(async (request: ArchiveStudyRequest) => answer(request));
    const base = {
      chartRef: view.ref,
      instrument: ES,
      intervalMs: 60 * MINUTE_MS,
      profileSettings: CONTINUOUS_DAY,
      client: { run },
      debounceMs: 0,
    };
    await render({ ...base, toggles: OFF });
    await settle();
    expect(run).not.toHaveBeenCalled();

    await render({ ...base, toggles: { ...OFF, profile: true } });
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    const first = run.mock.calls[0][0];
    expect(first).toMatchObject({
      study: "volume_profile",
      symbol: "ES",
      assetClass: "FUTURE",
      tickSize: 0.25,
      options: { mode: "continuous", binSizeMultiplier: 1 },
    });
    expect(first.ranges.map((range) => range.fromTs)).toEqual([
      MONDAY,
      MONDAY + DAY_MS,
      MONDAY + 2 * DAY_MS,
    ]);
    expect(first.segments.length).toBe(5);
    const applied = view.chart.applyHistoricalProfiles.mock.calls.at(-1)?.[0];
    expect(
      applied.map(
        (frame: { period_start_ts: number }) => frame.period_start_ts,
      ),
    ).toEqual([MONDAY, MONDAY + DAY_MS, MONDAY + 2 * DAY_MS]);
    expect(applied[0]).toMatchObject({
      type: "profile",
      symbol: "ES",
      provider: "DATABENTO",
      assetClass: "FUTURE",
    });
    expect(status).toEqual({ loading: false, issue: null, unsidedShare: null });

    await act(async () =>
      view.pan(MONDAY + DAY_MS, MONDAY + 4 * DAY_MS - 60 * MINUTE_MS),
    );
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0].ranges).toEqual([
      { fromTs: MONDAY + 3 * DAY_MS, toTs: MONDAY + 4 * DAY_MS },
    ]);
    const afterPan = view.chart.applyHistoricalProfiles.mock.calls.at(-1)?.[0];
    expect(
      afterPan.map(
        (frame: { period_start_ts: number }) => frame.period_start_ts,
      ),
    ).toEqual([MONDAY + DAY_MS, MONDAY + 2 * DAY_MS, MONDAY + 3 * DAY_MS]);

    await render({ ...base, toggles: OFF });
    expect(view.chart.applyHistoricalProfiles).toHaveBeenLastCalledWith([]);
  });

  it("a pan cancels a long Retry-After wait rather than stalling the new viewport", async () => {
    const view = fakeChart({ fromMs: MONDAY, toMs: MONDAY + DAY_MS - 60 * MINUTE_MS });
    const run = vi.fn(async (request: ArchiveStudyRequest): Promise<ArchiveStudyResult> => run.mock.calls.length === 1 ? { outcome: "refused", code: "OVERLOADED", reason: "busy", status: 429, retryAfterMs: 60_000 } : answer(request));
    await render({ chartRef: view.ref, instrument: ES, intervalMs: 60 * MINUTE_MS, profileSettings: CONTINUOUS_DAY, client: { run }, debounceMs: 0, toggles: { ...OFF, profile: true } });
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    await act(async () => view.pan(MONDAY + DAY_MS, MONDAY + 2 * DAY_MS - 60 * MINUTE_MS));
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0].ranges[0].fromTs).toBe(MONDAY + DAY_MS);
    expect(status.loading).toBe(false);
    expect(status.issue).toBeNull();
  });

  it("asks for VPIN a whole week at a time and draws the readings", async () => {
    const view = fakeChart({
      fromMs: MONDAY + 2 * DAY_MS,
      toMs: MONDAY + 9 * DAY_MS,
    });
    const run = vi.fn(async (request: ArchiveStudyRequest) => answer(request));
    await render({
      chartRef: view.ref,
      instrument: ES,
      intervalMs: 60 * MINUTE_MS,
      profileSettings: CONTINUOUS_DAY,
      client: { run },
      debounceMs: 0,
      toggles: { ...OFF, vpin: true },
    });
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({
      study: "vpin",
      ranges: [{ fromTs: MONDAY, toTs: MONDAY + 2 * WEEK_MS }],
    });
    const readings = view.chart.applyVpinReadings.mock.calls.at(
      -1,
    )?.[0] as VpinReading[];
    expect(readings.map((reading) => reading.seal_ts)).toEqual([
      MONDAY + DAY_MS,
      MONDAY + WEEK_MS + DAY_MS,
    ]);
  });

  it("splits a long VPIN view into two-week requests and a long profile view into bounded batches", async () => {
    const view = fakeChart({
      fromMs: MONDAY,
      toMs: MONDAY + 5 * WEEK_MS - 4 * 60 * MINUTE_MS,
    });
    const run = vi.fn(async (request: ArchiveStudyRequest) => answer(request));
    await render({
      chartRef: view.ref,
      instrument: ES,
      intervalMs: 4 * 60 * MINUTE_MS,
      profileSettings: CONTINUOUS_DAY,
      client: { run },
      debounceMs: 0,
      toggles: { ...OFF, profile: true, vpin: true },
    });
    await settle();
    const vpin = run.mock.calls
      .map(([request]) => request)
      .filter((request) => request.study === "vpin");
    const profile = run.mock.calls
      .map(([request]) => request)
      .filter((request) => request.study === "volume_profile");
    expect(
      vpin.map(
        (request) =>
          (request.ranges[0].toTs - request.ranges[0].fromTs) / WEEK_MS,
      ),
    ).toEqual([2, 2, 1]);
    expect(profile.map((request) => request.ranges.length)).toEqual([
      16, 16, 3,
    ]);
    expect(view.chart.applyVpinReadings.mock.calls.at(-1)?.[0]).toHaveLength(5);
  });

  it("on 1W asks for daily flow and feeds the chart whole Monday weeks, never the archive's epoch-aligned ones", async () => {
    const DAY = 24 * 60 * MINUTE_MS;
    const view = fakeChart({ fromMs: MONDAY + 2 * DAY, toMs: MONDAY + 9 * DAY });
    const run = vi.fn(async (request: ArchiveStudyRequest): Promise<ArchiveStudyResult> => {
      const [range] = request.ranges;
      const bars = [];
      for (let ts = range.fromTs; ts < range.toTs; ts += DAY) {
        bars.push({ ts_open: ts, volume: 4, buy_volume: 1, sell_volume: 2, unknown_volume: 1, trade_count: 1 });
      }
      return { outcome: "bar_flow", bars, missing: [], complete: true };
    });
    await render({
      chartRef: view.ref,
      instrument: ES,
      intervalMs: 7 * DAY,
      profileSettings: CONTINUOUS_DAY,
      client: { run },
      debounceMs: 0,
      toggles: { ...OFF, flow: true },
    });
    await settle();

    const asked = run.mock.calls.map(([request]) => request);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((request) => request.options?.bucketMs === DAY)).toBe(true);
    expect(Math.min(...asked.map((request) => request.ranges[0].fromTs))).toBeLessThanOrEqual(MONDAY);
    const weeks = view.chart.applyBarFlow.mock.calls.at(-1)?.[0] as { ts_open: number; buy_volume: number; sell_volume: number }[];
    expect(weeks.length).toBeGreaterThan(0);
    expect(weeks.every((week) => new Date(week.ts_open).getUTCDay() === 1)).toBe(true);
    expect(weeks.find((week) => week.ts_open === MONDAY)).toMatchObject({ buy_volume: 7, sell_volume: 14 });
  });

  it("on 1W asks for the whole of the first week on screen, even where it starts in an earlier month-long request chunk", async () => {
    const DAY = 24 * 60 * MINUTE_MS;
    // 2025-11-06 is a request chunk boundary; the week of Monday 2025-11-03 runs across it,
    // and the screen starts on the Friday after it.
    const firstWeek = Date.parse("2025-11-03T00:00:00.000Z");
    const view = fakeChart({ fromMs: firstWeek + 4 * DAY, toMs: firstWeek + 18 * DAY });
    const run = vi.fn(async (request: ArchiveStudyRequest): Promise<ArchiveStudyResult> => {
      const [range] = request.ranges;
      const bars = [];
      for (let ts = range.fromTs; ts < range.toTs; ts += DAY) {
        bars.push({ ts_open: ts, volume: 4, buy_volume: 1, sell_volume: 2, unknown_volume: 1, trade_count: 1 });
      }
      return { outcome: "bar_flow", bars, missing: [], complete: true };
    });
    await render({
      chartRef: view.ref,
      instrument: ES,
      intervalMs: 7 * DAY,
      profileSettings: CONTINUOUS_DAY,
      client: { run },
      debounceMs: 0,
      toggles: { ...OFF, flow: true },
    });
    await settle();

    const weeks = view.chart.applyBarFlow.mock.calls.at(-1)?.[0] as { ts_open: number; buy_volume: number }[];
    expect(weeks.find((week) => week.ts_open === firstWeek)).toMatchObject({ buy_volume: 7 });
  });

  it("feeds the bar buy/sell split to the chart and reports the share with no side", async () => {
    const view = fakeChart({
      fromMs: MONDAY,
      toMs: MONDAY + 6 * 60 * MINUTE_MS,
    });
    const run = vi.fn(
      async (request: ArchiveStudyRequest): Promise<ArchiveStudyResult> => {
        const [range] = request.ranges;
        return {
          outcome: "bar_flow",
          bars: [
            {
              ts_open: range.fromTs,
              volume: 1_000,
              buy_volume: 400,
              sell_volume: 300,
              unknown_volume: 300,
              trade_count: 20,
            },
            {
              ts_open: range.fromTs + 60 * MINUTE_MS,
              volume: 1_000,
              buy_volume: 500,
              sell_volume: 500,
              unknown_volume: 0,
              trade_count: 30,
            },
          ],
          missing: [],
          complete: true,
        };
      },
    );
    const client = { run };
    const base = {
      chartRef: view.ref,
      instrument: ES,
      intervalMs: 60 * MINUTE_MS,
      profileSettings: CONTINUOUS_DAY,
      client,
      debounceMs: 0,
    };
    await render({ ...base, toggles: OFF });
    await settle();
    expect(run).not.toHaveBeenCalled();

    await render({ ...base, toggles: { ...OFF, flow: true } });
    await settle();

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({
      study: "bar_flow",
      options: { bucketMs: 60 * MINUTE_MS },
    });
    const bars = view.chart.applyBarFlow.mock.calls.at(-1)?.[0];
    expect(
      bars.map((bar: { buy_volume: number; sell_volume: number }) => [
        bar.buy_volume,
        bar.sell_volume,
      ]),
    ).toEqual([
      [400, 300],
      [500, 500],
    ]);
    expect(status.unsidedShare).toBeCloseTo(0.15, 9);

    await render({ ...base, toggles: OFF });
    expect(view.chart.applyBarFlow).toHaveBeenLastCalledWith([]);
    expect(status.unsidedShare).toBeNull();
  });

  it("draws large prints per bar with the futures contract threshold", async () => {
    const view = fakeChart({
      fromMs: MONDAY,
      toMs: MONDAY + 3 * 60 * MINUTE_MS,
    });
    const run = vi.fn(async (request: ArchiveStudyRequest) => answer(request));
    await render({
      chartRef: view.ref,
      instrument: ES,
      intervalMs: 5 * MINUTE_MS,
      profileSettings: CONTINUOUS_DAY,
      client: { run },
      debounceMs: 0,
      toggles: { ...OFF, prints: true },
    });
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({
      study: "large_prints",
      options: { bucketMs: 5 * MINUTE_MS },
    });
    const [stats, intervalMs] = view.chart.applyMarkerSnapshot.mock.calls.at(
      -1,
    ) as [WhaleTradeStat[], number];
    expect(intervalMs).toBe(5 * MINUTE_MS);
    expect(stats.map((stat) => [stat.marker.size, stat.magnitude])).toEqual([
      [25, 25],
    ]);
  });

  it("applies the trader's large-trade and VPIN settings locally, at once, without asking the host again (Block 8 #12, #13)", async () => {
    const view = fakeChart({
      fromMs: MONDAY,
      toMs: MONDAY + 3 * 60 * MINUTE_MS,
    });
    const run = vi.fn(async (request: ArchiveStudyRequest) => answer(request));
    const base = {
      chartRef: view.ref,
      instrument: ES,
      intervalMs: 5 * MINUTE_MS,
      profileSettings: CONTINUOUS_DAY,
      client: { run },
      debounceMs: 0,
      toggles: { ...OFF, prints: true, vpin: true },
    };
    await render(base);
    await settle();
    const requestsBefore = run.mock.calls.length;
    expect(status.vpinDerivedSensitivity).toEqual(expect.any(Number));

    await render({
      ...base,
      displaySettings: {
        whaleThresholdUsd: 75_000,
        whaleThresholdContracts: 3,
        whaleClusterMode: "buySell",
        whaleMinDeltaPercent: 40,
        vpinSensitivity: 2.5,
      },
    });
    await settle();
    expect(run).toHaveBeenCalledTimes(requestsBefore);
    const [stats, , clusterMode, minDelta] = view.chart.applyMarkerSnapshot.mock.calls.at(-1) as [WhaleTradeStat[], number, string, number];
    expect(stats.map((stat) => stat.marker.size).sort((a, b) => a - b)).toEqual([5, 25]);
    expect(clusterMode).toBe("buySell");
    expect(minDelta).toBeCloseTo(0.4);
    expect(view.chart.applyVpinReadings.mock.calls.length).toBeGreaterThan(1);
  });

  it("retries an overloaded study quietly with the same request", async () => {
    const view = fakeChart({
      fromMs: MONDAY,
      toMs: MONDAY + DAY_MS - 60 * MINUTE_MS,
    });
    const issues: (string | null)[] = [];
    let calls = 0;
    const run = vi.fn(
      async (request: ArchiveStudyRequest): Promise<ArchiveStudyResult> => {
        calls += 1;
        if (calls === 1)
          return {
            outcome: "refused",
            code: "OVERLOADED",
            reason: "ONE_STUDY_PER_CLIENT",
            status: 429,
            retryAfterMs: 1,
          };
        return answer(request);
      },
    );
    function Watch(props: Parameters<typeof useArchiveStudies>[0]) {
      issues.push(useArchiveStudies(props).issue);
      return null;
    }
    const client = { run };
    // A long debounce and no pan: nothing can re-plan this range, so a second
    // call can only come from the retry itself. Giving up and re-requesting on
    // the next plan would leave exactly one call here.
    await act(async () =>
      root.render(
        <Watch
          chartRef={view.ref}
          instrument={ES}
          intervalMs={60 * MINUTE_MS}
          profileSettings={CONTINUOUS_DAY}
          client={client}
          debounceMs={60_000}
          toggles={{ ...OFF, profile: true }}
        />,
      ),
    );
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0].ranges).toEqual(run.mock.calls[0][0].ranges);
    expect(run.mock.calls[1][0].requestId).toBeGreaterThan(
      run.mock.calls[0][0].requestId,
    );
    expect(issues.every((issue) => issue === null)).toBe(true);
    expect(
      view.chart.applyHistoricalProfiles.mock.calls.at(-1)?.[0],
    ).toHaveLength(1);
  });

  it("settles a period the market was closed: nothing drawn, nothing reported, and it is not asked for again", async () => {
    const view = fakeChart({
      fromMs: MONDAY,
      toMs: MONDAY + 3 * DAY_MS - 60 * MINUTE_MS,
    });
    const closed = MONDAY + DAY_MS;
    const run = vi.fn(
      async (request: ArchiveStudyRequest): Promise<ArchiveStudyResult> => {
        const served = request.ranges.filter(
          (range) => range.fromTs !== closed,
        );
        return {
          outcome: "volume_profile",
          profiles: served.map((range) =>
            profileFor(range.fromTs, request.requestId),
          ),
          missing: [],
          empty: request.ranges.filter((range) => range.fromTs === closed),
          complete: true,
        };
      },
    );
    await render({
      chartRef: view.ref,
      instrument: ES,
      intervalMs: 60 * MINUTE_MS,
      profileSettings: CONTINUOUS_DAY,
      client: { run },
      debounceMs: 0,
      toggles: { ...OFF, profile: true },
    });
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(status).toEqual({ loading: false, issue: null, unsidedShare: null });
    expect(
      view.chart.applyHistoricalProfiles.mock.calls
        .at(-1)?.[0]
        .map((frame: { period_start_ts: number }) => frame.period_start_ts),
    ).toEqual([MONDAY, MONDAY + 2 * DAY_MS]);

    await act(async () =>
      view.pan(MONDAY, MONDAY + 3 * DAY_MS - 60 * MINUTE_MS),
    );
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports a refused study, then asks for it again on the next pan and clears the report", async () => {
    const view = fakeChart(null);
    let calls = 0;
    const run = vi.fn(
      async (request: ArchiveStudyRequest): Promise<ArchiveStudyResult> => {
        calls += 1;
        if (calls === 1)
          return {
            outcome: "refused",
            code: "READER_UNAVAILABLE",
            reason: "UPSTREAM_UNREACHABLE",
            status: 503,
            retryAfterMs: null,
          };
        return answer(request);
      },
    );
    await render({
      chartRef: view.ref,
      instrument: ES,
      intervalMs: 60 * MINUTE_MS,
      profileSettings: CONTINUOUS_DAY,
      client: { run },
      debounceMs: 0,
      toggles: { ...OFF, profile: true },
    });
    await act(async () => view.pan(MONDAY, MONDAY + DAY_MS - 60 * MINUTE_MS));
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(status.issue).toContain("UPSTREAM_UNREACHABLE");
    expect(view.chart.applyHistoricalProfiles.mock.calls.at(-1)?.[0]).toEqual(
      [],
    );

    await act(async () => view.pan(MONDAY, MONDAY + DAY_MS - 60 * MINUTE_MS));
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
    expect(
      view.chart.applyHistoricalProfiles.mock.calls.at(-1)?.[0],
    ).toHaveLength(1);
    expect(status).toEqual({ loading: false, issue: null, unsidedShare: null });
  });

  it("does not cache a partial success as complete and retries its missing range on the next pan", async () => {
    const view = fakeChart(null);
    let calls = 0;
    const run = vi.fn(
      async (request: ArchiveStudyRequest): Promise<ArchiveStudyResult> => {
        calls += 1;
        if (calls === 1) {
          return {
            outcome: "volume_profile",
            profiles: [],
            missing: request.ranges,
            empty: [],
            complete: false,
          };
        }
        return answer(request);
      },
    );
    await render({
      chartRef: view.ref,
      instrument: ES,
      intervalMs: 60 * MINUTE_MS,
      profileSettings: CONTINUOUS_DAY,
      client: { run },
      debounceMs: 0,
      toggles: { ...OFF, profile: true },
    });

    await act(async () => view.pan(MONDAY, MONDAY + DAY_MS - 60 * MINUTE_MS));
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(status.issue).toContain("could not serve part");

    await act(async () => view.pan(MONDAY, MONDAY + DAY_MS - 60 * MINUTE_MS));
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
    expect(
      view.chart.applyHistoricalProfiles.mock.calls.at(-1)?.[0],
    ).toHaveLength(1);
    expect(status).toEqual({ loading: false, issue: null, unsidedShare: null });
  });

  it("does not report a late refusal for a viewport no longer on screen", async () => {
    const view = fakeChart(null);
    let refuseFirst: ((result: ArchiveStudyResult) => void) | null = null;
    const run = vi.fn((request: ArchiveStudyRequest) =>
      refuseFirst === null
        ? new Promise<ArchiveStudyResult>((resolve) => {
            refuseFirst = resolve;
          })
        : Promise.resolve(answer(request)),
    );
    await render({
      chartRef: view.ref,
      instrument: ES,
      intervalMs: 60 * MINUTE_MS,
      profileSettings: CONTINUOUS_DAY,
      client: { run },
      debounceMs: 0,
      toggles: { ...OFF, profile: true },
    });
    await act(async () => view.pan(MONDAY, MONDAY + DAY_MS - 60 * MINUTE_MS));
    await settle();
    await act(async () =>
      view.pan(MONDAY + 2 * DAY_MS, MONDAY + 3 * DAY_MS - 60 * MINUTE_MS),
    );
    await settle();
    await act(async () =>
      refuseFirst?.({
        outcome: "refused",
        code: "READER_UNAVAILABLE",
        reason: "UPSTREAM_UNREACHABLE",
        status: 503,
        retryAfterMs: null,
      }),
    );
    await settle();
    expect(status.issue).toBeNull();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0].ranges).toEqual([
      { fromTs: MONDAY + 2 * DAY_MS, toTs: MONDAY + 3 * DAY_MS },
    ]);
  });

  it("drops a late result for an old viewport and runs the newest viewport next", async () => {
    const view = fakeChart(null);
    let resolveFirst: ((result: ArchiveStudyResult) => void) | null = null;
    let resolveSecond: ((result: ArchiveStudyResult) => void) | null = null;
    const run = vi.fn((_request: ArchiveStudyRequest) => {
      if (resolveFirst === null) {
        return new Promise<ArchiveStudyResult>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return new Promise<ArchiveStudyResult>((resolve) => {
        resolveSecond = resolve;
      });
    });
    await render({
      chartRef: view.ref,
      instrument: ES,
      intervalMs: 60 * MINUTE_MS,
      profileSettings: CONTINUOUS_DAY,
      client: { run },
      debounceMs: 0,
      toggles: { ...OFF, profile: true },
    });

    await act(async () => view.pan(MONDAY, MONDAY + DAY_MS - 60 * MINUTE_MS));
    await settle();
    expect(run).toHaveBeenCalledTimes(1);

    await act(async () =>
      view.pan(MONDAY + 2 * DAY_MS, MONDAY + 3 * DAY_MS - 60 * MINUTE_MS),
    );
    await settle();
    const applyCountBeforeLateAnswer =
      view.chart.applyHistoricalProfiles.mock.calls.length;
    await act(async () => resolveFirst?.(answer(run.mock.calls[0][0])));
    await settle();

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0].ranges).toEqual([
      { fromTs: MONDAY + 2 * DAY_MS, toTs: MONDAY + 3 * DAY_MS },
    ]);
    const afterLateAnswer = view.chart.applyHistoricalProfiles.mock.calls.slice(
      applyCountBeforeLateAnswer,
    );
    expect(
      afterLateAnswer.every(([frames]) =>
        frames.every(
          (frame: { period_start_ts: number }) =>
            frame.period_start_ts !== MONDAY,
        ),
      ),
    ).toBe(true);
    await act(async () => resolveSecond?.(answer(run.mock.calls[1][0])));
    await settle();
    const frames = view.chart.applyHistoricalProfiles.mock.calls.at(-1)?.[0];
    expect(
      frames.map((frame: { period_start_ts: number }) => frame.period_start_ts),
    ).toEqual([MONDAY + 2 * DAY_MS]);

    await act(async () => view.pan(MONDAY, MONDAY + DAY_MS - 60 * MINUTE_MS));
    await settle();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("cancels the study in flight when the instrument goes away", async () => {
    const view = fakeChart({ fromMs: MONDAY, toMs: MONDAY + DAY_MS });
    const signals: AbortSignal[] = [];
    const run = vi.fn(
      (_request: ArchiveStudyRequest, options?: { signal?: AbortSignal }) => {
        if (options?.signal) signals.push(options.signal);
        return new Promise<ArchiveStudyResult>(() => {});
      },
    );
    const base = {
      chartRef: view.ref,
      intervalMs: 60 * MINUTE_MS,
      profileSettings: CONTINUOUS_DAY,
      client: { run },
      debounceMs: 0,
      toggles: { ...OFF, profile: true },
    };
    await render({ ...base, instrument: ES });
    await settle();
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);

    await render({ ...base, instrument: null });
    expect(signals[0].aborted).toBe(true);
    expect(view.subscribed()).toBe(false);
    expect(view.chart.applyHistoricalProfiles).toHaveBeenLastCalledWith([]);
  });

  it("requests Binance spot studies with the approved trade window and tick", async () => {
    const view = fakeChart({ fromMs: MONDAY, toMs: MONDAY + DAY_MS });
    const run = vi.fn(async (request: ArchiveStudyRequest) => answer(request));
    await render({
      chartRef: view.ref,
      instrument: BTC,
      intervalMs: 60 * MINUTE_MS,
      profileSettings: CONTINUOUS_DAY,
      client: { run },
      debounceMs: 0,
      toggles: { profile: true, vpin: true, prints: true, flow: false },
    });
    await settle();
    expect(run).toHaveBeenCalled();
    expect(view.chart.subscribeVisibleRangeChange).toHaveBeenCalled();
    expect(run.mock.calls.every(([request]) => request.assetClass === "SPOT" && request.tickSize === 0.01)).toBe(true);
    expect(run.mock.calls.every(([request]) => request.segments[0].fromTs === Date.parse("2025-09-06T00:00:00.000Z"))).toBe(true);
  });
});
