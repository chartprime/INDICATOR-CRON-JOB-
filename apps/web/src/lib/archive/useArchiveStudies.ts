import { useEffect, useRef, useState, type RefObject } from "react";
import type { ChartPanelHandle } from "../../components/chart/ChartPanel";
import type { VpinReading } from "../../types/frames";
import {
  DEFAULT_VPIN_SENSITIVITY,
  MIN_READINGS_FOR_DERIVED_DEFAULT,
  deriveDefaultVpinSensitivity,
  reapplyVpinHysteresis,
} from "../indicators/vpin-cloud/vpinSensitivity";
import {
  DEFAULT_WHALE_THRESHOLD_CONTRACTS,
  DEFAULT_WHALE_THRESHOLD_USD,
  computeWhaleTradeStats,
  filterWhaleTradesBySize,
} from "../indicators/whale-detector/whaleTrades";
import type { WhaleClusterMode } from "../indicators/whale-detector/whaleMarkerClusters";
import type { HistoricalInstrument } from "./historicalCatalog";
import {
  createArchiveStudyClient,
  markerFrameFor,
  profileFrameFor,
  type ArchiveBarFlow,
  type ArchivePrint,
  type ArchiveProfile,
  type ArchiveStudyRange,
  type ArchiveStudyRequest,
  type ArchiveStudyResult,
} from "./archiveStudyClient";
import {
  MAX_VPIN_WEEKS_PER_REQUEST,
  chartFlowBars,
  flowBucketMs,
  flowChunks,
  flowSpan,
  WEEK_MS,
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
} from "./archiveStudyPlan";

const ARCHIVE_CLIENT_TOKEN =
  typeof import.meta.env.VITE_ARCHIVE_CLIENT_TOKEN === "string"
    ? import.meta.env.VITE_ARCHIVE_CLIENT_TOKEN.trim()
    : "";

export type ArchiveStudyToggles = Readonly<{
  profile: boolean;
  vpin: boolean;
  prints: boolean;
  flow: boolean;
}>;
export type ArchiveStudyProfileSettings = Readonly<{
  mode: "continuous" | "per_candle";
  periodMs: number;
  binSizeMultiplier: number;
}>;
export type ArchiveStudiesStatus = Readonly<{
  loading: boolean;
  issue: string | null;
  unsidedShare: number | null;
  vpinDerivedSensitivity?: number;
}>;
export type ArchiveStudyDisplaySettings = Readonly<{
  whaleThresholdUsd: number;
  whaleThresholdContracts: number;
  whaleClusterMode: WhaleClusterMode;
  whaleMinDeltaPercent: number;
  vpinSensitivity: number | null;
}>;
export const DEFAULT_ARCHIVE_STUDY_DISPLAY_SETTINGS: ArchiveStudyDisplaySettings = Object.freeze({
  whaleThresholdUsd: DEFAULT_WHALE_THRESHOLD_USD,
  whaleThresholdContracts: DEFAULT_WHALE_THRESHOLD_CONTRACTS,
  whaleClusterMode: "delta",
  whaleMinDeltaPercent: 0,
  vpinSensitivity: null,
});

type StudyClient = Readonly<{
  run: (
    request: ArchiveStudyRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<ArchiveStudyResult>;
}>;

type Job = Readonly<{
  request: Omit<ArchiveStudyRequest, "requestId">;
  keys: readonly string[];
  attempt: number;
}>;

const DEFAULT_DEBOUNCE_MS = 300;
const MAX_ATTEMPTS = 3;
const MAX_CACHED_VPIN_WEEKS = 52;

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

function profileKey(start: number): string {
  return `profile:${start}`;
}

function weekKey(start: number): string {
  return `vpin:${start}`;
}

function printKey(from: number, to: number): string {
  return `prints:${from}:${to}`;
}

function flowKey(from: number, to: number): string {
  return `flow:${from}:${to}`;
}

export function useArchiveStudies({
  chartRef,
  instrument,
  pointerToken = null,
  intervalMs,
  toggles,
  profileSettings,
  displaySettings = DEFAULT_ARCHIVE_STUDY_DISPLAY_SETTINGS,
  token = ARCHIVE_CLIENT_TOKEN,
  client: injectedClient,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}: {
  chartRef: RefObject<ChartPanelHandle | null>;
  instrument: HistoricalInstrument | null;
  pointerToken?: string | null;
  intervalMs: number;
  toggles: ArchiveStudyToggles;
  profileSettings: ArchiveStudyProfileSettings;
  displaySettings?: ArchiveStudyDisplaySettings;
  token?: string;
  client?: StudyClient;
  debounceMs?: number;
}): ArchiveStudiesStatus {
  const [status, setStatus] = useState<ArchiveStudiesStatus>({
    loading: false,
    issue: null,
    unsidedShare: null,
  });
  const togglesRef = useRef(toggles);
  togglesRef.current = toggles;
  const displayRef = useRef(displaySettings);
  displayRef.current = displaySettings;
  const visibleRef = useRef<{ fromMs: number; toMs: number } | null>(null);
  const planRef = useRef<(() => void) | null>(null);
  const applyRef = useRef<(() => void) | null>(null);
  const tickSize = instrument === null ? null : studyTickSize(instrument);
  const assetClass = instrument === null ? null : studyAssetClass(instrument);
  const periodMs =
    profileSettings.mode === "continuous"
      ? profileSettings.periodMs
      : intervalMs;
  const contextKey =
    instrument === null || tickSize === null || assetClass === null
      ? null
      : [
          instrument.id,
          intervalMs,
          profileSettings.mode,
          periodMs,
          profileSettings.binSizeMultiplier,
          pointerToken ?? "",
        ].join("|");

  useEffect(() => {
    const chart = chartRef.current;
    if (
      contextKey === null ||
      instrument === null ||
      tickSize === null ||
      assetClass === null
    ) {
      chart?.applyHistoricalProfiles([]);
      chart?.applyVpinReadings([]);
      chart?.applyMarkerSnapshot([], intervalMs, "delta", 0);
      chart?.applyBarFlow([]);
      return undefined;
    }
    const studyClient: StudyClient | null =
      injectedClient ?? (token ? createArchiveStudyClient({ token }) : null);
    if (studyClient === null) {
      setStatus({
        loading: false,
        issue: "Archive studies need an archive client token.",
        unsidedShare: null,
      });
      return undefined;
    }
    const segments = studySegmentsFor(instrument);
    const coverage = studyCoverage(segments);
    if (coverage === null) return undefined;
    const selected = instrument;
    const client = studyClient;
    const span = coverage;
    const base = {
      symbol: instrument.symbol,
      assetClass,
      tickSize,
      segments,
      ...(pointerToken === null ? {} : { pointerToken }),
    } as const;
    const controller = new AbortController();
    const profiles = new Map<number, ArchiveProfile>();
    const emptyProfileStarts = new Set<number>();
    const weeks = new Map<number, readonly VpinReading[]>();
    const prints = new Map<
      string,
      Readonly<{
        fromTs: number;
        toTs: number;
        prints: readonly ArchivePrint[];
      }>
    >();
    const flow = new Map<string, Readonly<{ range: ArchiveStudyRange; bars: readonly ArchiveBarFlow[] }>>();
    const requested = new Set<string>();
    const queue: Job[] = [];
    const desired = new Map<
      ArchiveStudyRequest["study"],
      ReadonlySet<string>
    >();
    let running = false;
    let runningJob: Job | null = null;
    let jobController: AbortController | null = null;
    controller.signal.addEventListener("abort", () => jobController?.abort(), { once: true });
    let requestId = 0;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const bucketMs = printBucketMs(intervalMs);
    const flowBucket = flowBucketMs(intervalMs);

    function apply(): void {
      const target = chartRef.current;
      if (target === null || controller.signal.aborted) return;
      const visible = visibleRef.current;
      const active = togglesRef.current;
      const display = displayRef.current;
      const whaleThreshold =
        assetClass === "FUTURE"
          ? display.whaleThresholdContracts
          : display.whaleThresholdUsd;
      if (active.profile && visible !== null) {
        const frames = profileBlocks(
          visible.fromMs,
          visible.toMs,
          periodMs,
          span,
        ).flatMap((block) => {
          const fields = profiles.get(block.fromTs);
          return fields === undefined
            ? []
            : [
                profileFrameFor(
                  fields,
                  selected.symbol,
                  selected.chartIdentity,
                ),
              ];
        });
        target.applyHistoricalProfiles(frames);
      } else {
        target.applyHistoricalProfiles([]);
      }
      if (active.vpin) {
        const readings = [...weeks.entries()]
          .sort((left, right) => left[0] - right[0])
          .flatMap(([, entries]) => entries);
        const derived =
          readings.length >= MIN_READINGS_FOR_DERIVED_DEFAULT
            ? deriveDefaultVpinSensitivity(readings)
            : DEFAULT_VPIN_SENSITIVITY;
        const sensitivity = display.vpinSensitivity ?? derived;
        setStatus((current) =>
          current.vpinDerivedSensitivity === derived
            ? current
            : { ...current, vpinDerivedSensitivity: derived },
        );
        target.applyVpinReadings(
          readings.length === 0
            ? []
            : reapplyVpinHysteresis(readings, sensitivity),
        );
      } else {
        target.applyVpinReadings([]);
      }
      if (active.prints) {
        const markers = [...prints.values()]
          .sort((left, right) => left.fromTs - right.fromTs)
          .flatMap((chunk) => chunk.prints)
          .map((entry, index) =>
            markerFrameFor(
              entry,
              index,
              selected.symbol,
              selected.chartIdentity,
            ),
          );
        const stats = filterWhaleTradesBySize(
          computeWhaleTradeStats(markers, Number.MAX_SAFE_INTEGER),
          whaleThreshold,
        );
        target.applyMarkerSnapshot(
          stats,
          intervalMs,
          display.whaleClusterMode,
          display.whaleMinDeltaPercent / 100,
        );
      } else {
        target.applyMarkerSnapshot([], intervalMs, "delta", 0);
      }
      if (active.flow) {
        const bars = chartFlowBars([...flow.values()], intervalMs, span);
        target.applyBarFlow(bars);
        const volume = bars.reduce((sum, entry) => sum + entry.volume, 0);
        const unknown = bars.reduce(
          (sum, entry) => sum + entry.unknown_volume,
          0,
        );
        setStatus((current) => {
          const share = volume > 0 ? unknown / volume : null;
          return current.unsidedShare === share
            ? current
            : { ...current, unsidedShare: share };
        });
      } else {
        target.applyBarFlow([]);
        setStatus((current) =>
          current.unsidedShare === null
            ? current
            : { ...current, unsidedShare: null },
        );
      }
    }

    function enqueue(
      request: Omit<ArchiveStudyRequest, "requestId">,
      keys: readonly string[],
    ): void {
      for (const key of keys) requested.add(key);
      queue.push({ request, keys, attempt: 1 });
      setStatus((current) =>
        current.issue === null ? current : { ...current, issue: null },
      );
      void drain();
    }

    function release(job: Job): void {
      for (const key of job.keys) requested.delete(key);
    }

    function setDesired(
      study: ArchiveStudyRequest["study"],
      keys: ReadonlySet<string>,
    ): void {
      desired.set(study, keys);
      if (runningJob?.request.study === study && !stillDesired(runningJob)) jobController?.abort();
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const job = queue[index];
        if (
          job.request.study === study &&
          !job.keys.every((key) => keys.has(key))
        ) {
          queue.splice(index, 1);
          release(job);
        }
      }
    }

    function stillDesired(job: Job): boolean {
      const keys = desired.get(job.request.study);
      return keys !== undefined && job.keys.every((key) => keys.has(key));
    }

    function store(job: Job, result: ArchiveStudyResult): void {
      if (result.outcome === "volume_profile") {
        for (const profile of result.profiles)
          profiles.set(profile.period_start_ts, profile);
        for (const range of result.empty) emptyProfileStarts.add(range.fromTs);
        for (const range of result.missing)
          requested.delete(profileKey(range.fromTs));
      } else if (result.outcome === "vpin") {
        const missingWeeks = new Set<number>();
        for (const range of result.missing) {
          for (let week = range.fromTs; week < range.toTs; week += WEEK_MS)
            missingWeeks.add(week);
        }
        for (const range of job.request.ranges) {
          for (let week = range.fromTs; week < range.toTs; week += WEEK_MS) {
            if (missingWeeks.has(week)) requested.delete(weekKey(week));
            else
              weeks.set(
                week,
                result.readings.filter(
                  (reading) =>
                    reading.seal_ts >= week && reading.seal_ts < week + WEEK_MS,
                ),
              );
          }
        }
        while (weeks.size > MAX_CACHED_VPIN_WEEKS) {
          const oldest = weeks.keys().next().value as number;
          weeks.delete(oldest);
          requested.delete(weekKey(oldest));
        }
      } else if (result.outcome === "bar_flow") {
        const [range] = job.request.ranges;
        const key = flowKey(range.fromTs, range.toTs);
        if (result.complete) flow.set(key, { range, bars: result.bars });
        else requested.delete(key);
      } else if (result.outcome === "large_prints") {
        const [range] = job.request.ranges;
        const key = printKey(range.fromTs, range.toTs);
        if (result.complete)
          prints.set(key, {
            fromTs: range.fromTs,
            toTs: range.toTs,
            prints: result.prints,
          });
        else requested.delete(key);
      }
    }

    async function drain(): Promise<void> {
      if (running) return;
      running = true;
      setStatus((current) => ({ ...current, loading: true }));
      try {
        while (queue.length > 0 && !controller.signal.aborted) {
          const job = queue.shift() as Job;
          runningJob = job;
          jobController = new AbortController();
          try {
            requestId += 1;
            let result: ArchiveStudyResult;
            try {
              result = await client.run(
                { ...job.request, requestId },
                { signal: jobController.signal },
              );
            } catch (error) {
              if (controller.signal.aborted) return;
              release(job);
              if (jobController.signal.aborted) { plan(); continue; }
              setStatus((current) => ({
                ...current,
                loading: true,
                issue: (error as Error)?.message ?? "The archive study failed.",
              }));
              continue;
            }
            if (controller.signal.aborted || jobController.signal.aborted || !stillDesired(job)) {
              release(job);
              if (!controller.signal.aborted) plan();
              continue;
            }
            if (result.outcome === "refused") {
              if (result.code === "OVERLOADED" && job.attempt < MAX_ATTEMPTS) {
                await waitForRetry(result.retryAfterMs ?? 1_000, jobController.signal);
                if (controller.signal.aborted) return;
                if (stillDesired(job))
                  queue.unshift({ ...job, attempt: job.attempt + 1 });
                else { release(job); plan(); }
                continue;
              }
              release(job);
              setStatus((current) => ({
                ...current,
                loading: true,
                issue: `The archive refused a study: ${result.reason ?? result.code}.`,
              }));
              continue;
            }
            store(job, result);
            if (!result.complete) {
              setStatus((current) => ({
                ...current,
                loading: true,
                issue:
                  "The archive could not serve part of this study range; it will retry when the view changes.",
              }));
            }
            apply();
          } finally { runningJob = null; jobController = null; }
        }
      } finally {
        running = false;
        if (!controller.signal.aborted)
          setStatus((current) => ({ ...current, loading: false }));
      }
    }

    function plan(): void {
      const visible = visibleRef.current;
      if (visible === null || controller.signal.aborted) return;
      const active = togglesRef.current;

      if (active.profile) {
        const blocks = profileBlocks(
          visible.fromMs,
          visible.toMs,
          periodMs,
          span,
        );
        const visibleStarts = new Set(blocks.map((block) => block.fromTs));
        setDesired(
          "volume_profile",
          new Set(blocks.map((block) => profileKey(block.fromTs))),
        );
        for (const start of [...profiles.keys(), ...emptyProfileStarts]) {
          if (!visibleStarts.has(start)) {
            profiles.delete(start);
            emptyProfileStarts.delete(start);
            requested.delete(profileKey(start));
          }
        }
        const pending = blocks.filter(
          (block) => !requested.has(profileKey(block.fromTs)),
        );
        const batchSize = profileBlocksPerRequest(periodMs);
        for (let index = 0; index < pending.length; index += batchSize) {
          const batch = pending.slice(index, index + batchSize);
          enqueue(
            {
              ...base,
              study: "volume_profile",
              ranges: batch,
              options: {
                mode: profileSettings.mode,
                binSizeMultiplier: profileSettings.binSizeMultiplier,
              },
            },
            batch.map((block) => profileKey(block.fromTs)),
          );
        }
      } else setDesired("volume_profile", new Set());

      if (active.vpin) {
        const wantedWeeks = vpinWeeks(visible.fromMs, visible.toMs, span);
        setDesired("vpin", new Set(wantedWeeks.map(weekKey)));
        const pendingWeeks = wantedWeeks.filter(
          (week) => !requested.has(weekKey(week)),
        );
        for (const run of contiguousRuns(
          pendingWeeks,
          WEEK_MS,
          MAX_VPIN_WEEKS_PER_REQUEST,
        )) {
          const keys: string[] = [];
          for (let week = run.fromTs; week < run.toTs; week += WEEK_MS)
            keys.push(weekKey(week));
          enqueue({ ...base, study: "vpin", ranges: [run] }, keys);
        }
      } else setDesired("vpin", new Set());

      if (active.prints) {
        const chunks = printChunks(
          visible.fromMs,
          visible.toMs,
          bucketMs,
          span,
        );
        const wanted = new Set(
          chunks.map((chunk) => printKey(chunk.fromTs, chunk.toTs)),
        );
        setDesired("large_prints", wanted);
        for (const key of [...prints.keys()]) {
          if (!wanted.has(key)) {
            prints.delete(key);
            requested.delete(key);
          }
        }
        for (const chunk of chunks) {
          const key = printKey(chunk.fromTs, chunk.toTs);
          if (!requested.has(key))
            enqueue(
              {
                ...base,
                study: "large_prints",
                ranges: [chunk],
                options: { bucketMs },
              },
              [key],
            );
        }
      } else setDesired("large_prints", new Set());

      if (active.flow && flowBucket !== null) {
        const wantedSpan = flowSpan(visible.fromMs, visible.toMs, intervalMs);
        const chunks = flowChunks(
          wantedSpan.fromTs,
          wantedSpan.toTs,
          flowBucket,
          span,
        );
        const wanted = new Set(
          chunks.map((chunk) => flowKey(chunk.fromTs, chunk.toTs)),
        );
        setDesired("bar_flow", wanted);
        for (const key of [...flow.keys()]) {
          if (!wanted.has(key)) {
            flow.delete(key);
            requested.delete(key);
          }
        }
        for (const chunk of chunks) {
          const key = flowKey(chunk.fromTs, chunk.toTs);
          if (!requested.has(key)) {
            enqueue(
              {
                ...base,
                study: "bar_flow",
                ranges: [chunk],
                options: { bucketMs: flowBucket },
              },
              [key],
            );
          }
        }
      } else setDesired("bar_flow", new Set());
      apply();
    }

    planRef.current = plan;
    applyRef.current = apply;
    const unsubscribe = chart?.subscribeVisibleRangeChange((fromMs, toMs) => {
      visibleRef.current = { fromMs, toMs: toMs + intervalMs };
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(plan, debounceMs);
    });
    plan();

    return () => {
      controller.abort();
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      unsubscribe?.();
      planRef.current = null;
      applyRef.current = null;
      setStatus({ loading: false, issue: null, unsidedShare: null });
    };
  }, [
    assetClass,
    chartRef,
    contextKey,
    debounceMs,
    injectedClient,
    instrument,
    intervalMs,
    periodMs,
    pointerToken,
    profileSettings.mode,
    profileSettings.binSizeMultiplier,
    tickSize,
    token,
  ]);

  useEffect(() => {
    planRef.current?.();
    applyRef.current?.();
  }, [toggles.flow, toggles.profile, toggles.vpin, toggles.prints]);

  useEffect(() => {
    applyRef.current?.();
  }, [
    displaySettings.whaleThresholdUsd,
    displaySettings.whaleThresholdContracts,
    displaySettings.whaleClusterMode,
    displaySettings.whaleMinDeltaPercent,
    displaySettings.vpinSensitivity,
  ]);

  return status;
}
