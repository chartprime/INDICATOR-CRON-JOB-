import { useCallback, useEffect, useRef, useState } from "react";
import type { BarFrame } from "../../types/frames";
import { ArchiveTransportError, createArchiveClient } from "./archiveClient";
import type { ArchivePresentationPage } from "./continuousArchive";
import { HistoricalArchiveLoadError, loadHistoricalArchiveWindow, toSeries } from "./historicalArchiveLoader";
import {
  historicalWindowAfter,
  historicalWindowBefore,
  initialHistoricalWindow,
  isUncappedHistoricalTimeframe,
  needsHistoricalLogicalPrefetch,
  type HistoricalWindow,
} from "./historicalRetention";
import type { HistoricalInstrument, HistoricalResolution } from "./historicalCatalog";
import type { HistoricalTimeframe } from "./historicalTimeframes";
import {
  mergeHistoricalIndicatorSeries,
  retainHistoricalIndicatorSeries,
  type HistoricalIndicatorSeries,
} from "./historicalIndicatorSeries";
import { HISTORICAL_INTRADAY_DISPLAY_BAR_LIMIT } from "./historicalRetention";

type ReadySeries = Readonly<{
  series: HistoricalIndicatorSeries;
  page: ArchivePresentationPage;
  pointerToken: string;
  instrumentId: string;
  requestToken: number;
  beforeBoundaryMs: number;
  afterBoundaryMs: number;
  rollMarkers: ArchivePresentationPage["rollMarkers"];
}>;

export type HistoricalExtensionIssue = Readonly<{
  kind: "refused" | "restart" | "error";
  detail: string;
}>;

export type ArchivePageLoad =
  | Readonly<{ state: "idle" }>
  | Readonly<{ state: "configuration" }>
  | Readonly<{ state: "loading" }>
  | Readonly<{
    state: "ready";
    page: ArchivePresentationPage;
    series: HistoricalIndicatorSeries;
    instrumentId: string;
    timeframeId: string;
    resolution: HistoricalResolution;
    loadingDirection: "before" | "after" | null;
    extensionIssue?: HistoricalExtensionIssue;
    onVisibleLogicalRangeChange: (barsBefore: number, barsAfter: number) => void;
  }>
  | Readonly<{ state: "refused"; code: string }>
  | Readonly<{ state: "restart"; code: string }>
  | Readonly<{ state: "error"; message: string }>;

const token = typeof import.meta.env.VITE_ARCHIVE_CLIENT_TOKEN === "string"
  ? import.meta.env.VITE_ARCHIVE_CLIENT_TOKEN.trim()
  : "";

function mergeMarkers(
  existing: readonly ArchivePresentationPage["rollMarkers"][number][],
  incoming: ArchivePresentationPage["rollMarkers"],
  bars: readonly BarFrame[],
): ArchivePresentationPage["rollMarkers"] {
  const markers = new Map<number, ArchivePresentationPage["rollMarkers"][number]>();
  for (const marker of [...existing, ...incoming]) markers.set(marker.time, marker);
  const first = bars[0];
  const last = bars.at(-1);
  if (first === undefined || last === undefined) return Object.freeze([]);
  const toMs = last.ts_open + last.interval_ms;
  return Object.freeze([...markers.values()]
    .filter((marker) => marker.time >= first.ts_open && marker.time < toMs)
    .sort((left, right) => left.time - right.time));
}

function failureMessage(error: unknown): string {
  return error instanceof ArchiveTransportError || error instanceof HistoricalArchiveLoadError || error instanceof Error
    ? error.message
    : "archive request failed";
}

function resampleHeldPageForTimeframeSwitch(
  priorReady: ReadySeries | null,
  instrument: HistoricalInstrument,
  timeframe: HistoricalTimeframe,
  requestToken: number,
  window: HistoricalWindow,
): ReadySeries | null {
  if (
    priorReady === null
    || priorReady.instrumentId !== instrument.id
    || priorReady.requestToken !== requestToken
    || !isUncappedHistoricalTimeframe(timeframe)
    || priorReady.beforeBoundaryMs !== window.fromMs
    || priorReady.afterBoundaryMs !== window.toMs
  ) {
    return null;
  }
  try {
    const series = toSeries(instrument, timeframe, priorReady.page, window);
    return Object.freeze({
      series,
      page: priorReady.page,
      pointerToken: priorReady.pointerToken,
      instrumentId: priorReady.instrumentId,
      requestToken: priorReady.requestToken,
      beforeBoundaryMs: window.fromMs,
      afterBoundaryMs: window.toMs,
      rollMarkers: mergeMarkers([], priorReady.page.rollMarkers, series.bars),
    });
  } catch {
    return null;
  }
}

export function useArchivePage(
  instrument: HistoricalInstrument | null,
  timeframe: HistoricalTimeframe,
  requestToken = 0,
  initialRange: Readonly<{ fromMs: number; toMs: number }> | null = null,
): ArchivePageLoad {
  const [state, setState] = useState<ArchivePageLoad>({ state: "idle" });
  const seriesRef = useRef<ReadySeries | null>(null);
  const activeDirectionRef = useRef<"before" | "after" | "initial" | null>(null);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const visibleCallbackRef = useRef<(barsBefore: number, barsAfter: number) => void>(() => {});

  const finish = useCallback((next: Exclude<ArchivePageLoad, { state: "ready" }>) => {
    seriesRef.current = null;
    activeDirectionRef.current = null;
    setState(next);
  }, []);

  const retainAfterExtensionFailure = useCallback((issue: HistoricalExtensionIssue) => {
    const current = seriesRef.current;
    activeDirectionRef.current = null;
    if (current === null || instrument === null) {
      finish({ state: "error", message: "the historical chart was unavailable while extending history" });
      return;
    }
    setState({
      state: "ready",
      page: { ...current.page, rollMarkers: current.rollMarkers },
      series: current.series,
      instrumentId: instrument.id,
      timeframeId: timeframe.id,
      resolution: timeframe.sourceResolution,
      loadingDirection: null,
      extensionIssue: issue,
      onVisibleLogicalRangeChange: visibleCallbackRef.current,
    });
  }, [finish, instrument, timeframe]);

  const loadAdjacent = useCallback((direction: "before" | "after") => {
    if (instrument === null || instrument.availability !== "ready" || activeDirectionRef.current !== null) return;
    const current = seriesRef.current;
    if (current === null) return;
    const window = direction === "before"
      ? historicalWindowBefore(instrument, timeframe, current.beforeBoundaryMs)
      : historicalWindowAfter(instrument, timeframe, current.afterBoundaryMs);
    if (window === null) return;
    const generation = generationRef.current;
    const controller = controllerRef.current;
    if (controller === null) return;
    activeDirectionRef.current = direction;
    setState({
      state: "ready",
      page: current.page,
      series: current.series,
      instrumentId: instrument.id,
      timeframeId: timeframe.id,
      resolution: timeframe.sourceResolution,
      loadingDirection: direction,
      extensionIssue: undefined,
      onVisibleLogicalRangeChange: visibleCallbackRef.current,
    });
    void loadHistoricalArchiveWindow(
      createArchiveClient({ token }),
      instrument,
      timeframe,
      window,
      { signal: controller.signal, pointerToken: current.pointerToken },
    ).then((result) => {
      if (controller.signal.aborted || generationRef.current !== generation) return;
      activeDirectionRef.current = null;
      if (result.outcome === "refused") {
        retainAfterExtensionFailure({ kind: "refused", detail: result.code });
        return;
      }
      if (result.outcome === "restart") {
        retainAfterExtensionFailure({ kind: "restart", detail: result.code });
        return;
      }
      const prior = seriesRef.current;
      if (prior === null || result.page.pointerToken !== prior.pointerToken) {
        retainAfterExtensionFailure({ kind: "error", detail: "the archive changed catalog snapshot while extending history" });
        return;
      }
      try {
        const combined = mergeHistoricalIndicatorSeries(prior.series, result.series, direction);
        const series = retainHistoricalIndicatorSeries(
          combined,
          direction,
          HISTORICAL_INTRADAY_DISPLAY_BAR_LIMIT,
        );
        const trimmed = series.bars.length !== combined.bars.length;
        const bars = series.bars;
        const first = bars[0];
        const last = bars.at(-1);
        const next: ReadySeries = Object.freeze({
          series,
          page: result.page,
          pointerToken: prior.pointerToken,
          instrumentId: prior.instrumentId,
          requestToken: prior.requestToken,
          beforeBoundaryMs: direction === "before"
            ? window.fromMs
            : trimmed && first !== undefined ? first.ts_open : prior.beforeBoundaryMs,
          afterBoundaryMs: trimmed && last !== undefined
            ? last.ts_open + last.interval_ms
            : direction === "after" ? window.toMs : prior.afterBoundaryMs,
          rollMarkers: mergeMarkers(prior.rollMarkers, result.page.rollMarkers, bars),
        });
        seriesRef.current = next;
        setState({
          state: "ready",
          page: { ...next.page, rollMarkers: next.rollMarkers },
          series: next.series,
          instrumentId: instrument.id,
          timeframeId: timeframe.id,
          resolution: timeframe.sourceResolution,
          loadingDirection: null,
          extensionIssue: undefined,
          onVisibleLogicalRangeChange: visibleCallbackRef.current,
        });
      } catch (error) {
        retainAfterExtensionFailure({ kind: "error", detail: failureMessage(error) });
      }
    }).catch((error: unknown) => {
      if (controller.signal.aborted || generationRef.current !== generation) return;
      retainAfterExtensionFailure({ kind: "error", detail: failureMessage(error) });
    });
  }, [instrument, retainAfterExtensionFailure, timeframe]);

  const onVisibleLogicalRangeChange = useCallback((barsBefore: number, barsAfter: number) => {
    const current = seriesRef.current;
    if (current === null || current.series.bars.length === 0) return;
    const direction = needsHistoricalLogicalPrefetch(timeframe, barsBefore, barsAfter);
    if (direction !== null) loadAdjacent(direction);
  }, [loadAdjacent, timeframe]);
  visibleCallbackRef.current = onVisibleLogicalRangeChange;

  useEffect(() => {
    const priorReady = seriesRef.current;
    generationRef.current += 1;
    const generation = generationRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    seriesRef.current = null;
    activeDirectionRef.current = null;
    if (instrument === null) {
      setState({ state: "idle" });
      return () => controller.abort();
    }
    if (!token) {
      setState({ state: "configuration" });
      return () => controller.abort();
    }
    let initialWindow;
    try {
      initialWindow = initialHistoricalWindow(instrument, timeframe);
      if (initialRange !== null) {
        if (!Number.isSafeInteger(initialRange.fromMs) || !Number.isSafeInteger(initialRange.toMs)
            || initialRange.fromMs < Date.parse(instrument.availableFrom)
            || initialRange.toMs > Date.parse(instrument.availableToExclusive)
            || initialRange.toMs <= initialRange.fromMs || initialRange.toMs - initialRange.fromMs > 3600000
            || timeframe.sourceResolution !== "1m") throw new RangeError("Invalid historical sample window");
        initialWindow = { ...initialRange, maximumPages: 4 };
      }
    } catch (error) {
      setState({ state: "error", message: failureMessage(error) });
      return () => controller.abort();
    }
    const resampled = resampleHeldPageForTimeframeSwitch(
      priorReady,
      instrument,
      timeframe,
      requestToken,
      initialWindow,
    );
    if (resampled !== null) {
      seriesRef.current = resampled;
      setState({
        state: "ready",
        page: { ...resampled.page, rollMarkers: resampled.rollMarkers },
        series: resampled.series,
        instrumentId: instrument.id,
        timeframeId: timeframe.id,
        resolution: timeframe.sourceResolution,
        loadingDirection: null,
        onVisibleLogicalRangeChange: visibleCallbackRef.current,
      });
      return () => controller.abort();
    }
    activeDirectionRef.current = "initial";
    setState({ state: "loading" });
    void loadHistoricalArchiveWindow(
      createArchiveClient({ token }),
      instrument,
      timeframe,
      initialWindow,
      { signal: controller.signal },
    ).then((result) => {
      if (controller.signal.aborted || generationRef.current !== generation) return;
      activeDirectionRef.current = null;
      if (result.outcome === "refused") {
        finish({ state: "refused", code: result.code });
        return;
      }
      if (result.outcome === "restart") {
        finish({ state: "restart", code: result.code });
        return;
      }
      const next: ReadySeries = Object.freeze({
        series: result.series,
        page: result.page,
        pointerToken: result.page.pointerToken,
        instrumentId: instrument.id,
        requestToken,
        beforeBoundaryMs: initialWindow.fromMs,
        afterBoundaryMs: initialWindow.toMs,
        rollMarkers: mergeMarkers([], result.page.rollMarkers, result.series.bars),
      });
      seriesRef.current = next;
      setState({
        state: "ready",
        page: result.page,
        series: next.series,
        instrumentId: instrument.id,
        timeframeId: timeframe.id,
        resolution: timeframe.sourceResolution,
        loadingDirection: null,
        onVisibleLogicalRangeChange: visibleCallbackRef.current,
      });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || generationRef.current !== generation) return;
      finish({ state: "error", message: failureMessage(error) });
    });
    return () => controller.abort();
  }, [finish, instrument, onVisibleLogicalRangeChange, requestToken, timeframe, initialRange]);

  return state;
}
