import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useMarketData } from "../../hooks/useMarketData";
import { INSTRUMENTS } from "../../lib/chart/instruments";
import {
  admitSourceBar,
  fullBarBuffer,
  latestSourceBar,
  replaceClosedBars,
  sourceBarsForBucket,
} from "../../lib/chart/candleLifecycle";
import { resampleBars, TIMEFRAMES } from "../../lib/chart/resampleBars";
import { identitiesMatch, type BarFrame, type FrameIdentity, type TradeFrame } from "../../types/frames";
import type { TradeAvailability } from "../../lib/chart/indicatorTypes";
import { type ChartPanelHandle } from "./ChartPanel";
import { ChartPrimeLogo } from "../chrome/ChartPrimeLogo";
import { ComingSoonPanel } from "../chrome/ComingSoonPanel";
import { HistoricalModePanel } from "../historical/HistoricalModePanel";
import { MainPanel } from "./MainPanel";
import { SymbolMenu } from "../chrome/SymbolMenu";
import { formatRecordingLag } from "../../lib/chart/recordingLag";
import { installBrowserPerformanceTrace, recordSelectionChartCommit, recordSelectionTrace } from "../../lib/observability/selectionTrace";
import type { SelectionTraceTransport } from "../../workers/marketDataWorker";

type SelectedInstrument = { symbol: string } & FrameIdentity;

const DEFAULT_INSTRUMENT = INSTRUMENTS[0];
const DEFAULT_PAIR: SelectedInstrument = {
  symbol: DEFAULT_INSTRUMENT.symbol,
  ...DEFAULT_INSTRUMENT.identity,
};

function sameInstrument(a: SelectedInstrument, symbol: string, identity: FrameIdentity): boolean {
  return a.symbol === symbol && identitiesMatch(a, identity);
}

function instrumentIdentity(instrument: SelectedInstrument): FrameIdentity {
  return instrument.provider === "BINANCE"
    ? { provider: "BINANCE", marketKind: instrument.marketKind }
    : { provider: "DXFEED", assetClass: instrument.assetClass };
}

interface PanelDef {
  id: string;
  icon: string;
  label: string;
}

const PANELS: readonly PanelDef[] = [
  { id: "chart", icon: "▤", label: "Live mode" },
  { id: "historical", icon: "◷", label: "Historical mode" },
  { id: "heatmap", icon: "▦", label: "Liquidity heatmap" },
];

function defaultWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}
const WS_URL = import.meta.env.VITE_BACKEND_WS_URL ?? defaultWsUrl();
const BASE_INTERVAL_MS = TIMEFRAMES[0].intervalMs;
const SELECTION_CONFIRM_TIMEOUT_MS = 15_000;
// A flat retention cap can't cover every selectable timeframe: 1D needs 1,440
// constituent 1m source bars, 4h needs 240, both well past a small fixed cap.
// Size retention off whatever timeframe is actually selected instead, with a
// floor that keeps the common (<=1h) case as lean as before.
const MIN_RETAINED_LIVE_TRADE_SOURCE_BARS = 120;
const RETAINED_LIVE_TRADE_SOURCE_BARS_HEADROOM = 5;

interface SourceBarTrades {
  trades: readonly TradeFrame[];
  tradeAvailability: TradeAvailability;
}

function combinedTradeAvailability(
  current: TradeAvailability,
  next: TradeAvailability,
): TradeAvailability {
  if (current === "HISTORICAL_UNAVAILABLE" || next === "HISTORICAL_UNAVAILABLE") return "HISTORICAL_UNAVAILABLE";
  if (current === "LIVE_PARTIAL" || next === "LIVE_PARTIAL") return "LIVE_PARTIAL";
  return "LIVE_COMPLETE";
}

export function Terminal() {
  const [activePanel, setActivePanel] = useState<string>(PANELS[0].id);
  const [railExpanded, setRailExpanded] = useState(false);
  const historicalModeActive = activePanel === "historical";
  const railRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  useEffect(() => installBrowserPerformanceTrace(), []);

  const onRailKeyDown = useCallback((index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (index + 1) % PANELS.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (index - 1 + PANELS.length) % PANELS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = PANELS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = PANELS[nextIndex];
    setActivePanel(next.id);
    railRefs.current[next.id]?.focus();
  }, []);

  const chartRef = useRef<ChartPanelHandle>(null);
  const [latestBar, setLatestBar] = useState<BarFrame | null>(null);
  const closedBarsRef = useRef<BarFrame[]>([]);
  const [tapeTradeCount, setTapeTradeCount] = useState(0);
  const developingBarRef = useRef<BarFrame | null>(null);
  // The hook provides complete observed prints per *source* bar. Keep the
  // recent source-bar sets here, where we know the chosen chart timeframe,
  // so a 5m/15m/1h replacement receives the complete selected-bar bundle.
  const sourceBarTradesRef = useRef<Map<number, SourceBarTrades>>(new Map());
  const prevPxRef = useRef<number | undefined>(undefined);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const flashTimeoutRef = useRef<number | null>(null);
  const [lastTickDirection, setLastTickDirection] = useState<"up" | "down" | null>(null);
  const [intervalMs, setIntervalMs] = useState<number>(BASE_INTERVAL_MS);
  const intervalMsRef = useRef(intervalMs);
  intervalMsRef.current = intervalMs;

  const resetPriceMotion = useCallback(() => {
    prevPxRef.current = undefined;
    setFlash(null);
    setLastTickDirection(null);
    if (flashTimeoutRef.current !== null) {
      window.clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = null;
    }
  }, []);

  const onSnapshotBars = useCallback((bars: BarFrame[], selectionTrace?: SelectionTraceTransport) => {
    const closedBars = replaceClosedBars(bars);
    closedBarsRef.current = closedBars;
    developingBarRef.current = null;
    sourceBarTradesRef.current.clear();
    setTapeTradeCount(closedBars.reduce((total, candidate) => total + (candidate.trade_count ?? 0), 0));
    chartRef.current?.applyRawBars(closedBars);
    chartRef.current?.applySnapshot(resampleBars(closedBars, intervalMsRef.current));
    if (selectionTrace !== undefined) recordSelectionChartCommit(selectionTrace);
    setLatestBar(closedBars.at(-1) ?? null);
    resetPriceMotion();
  }, [resetPriceMotion]);

  const onBar = useCallback((
    bar: BarFrame,
    trades: readonly TradeFrame[],
    tradeAvailability: TradeAvailability = "LIVE_COMPLETE",
  ) => {
    const admission = admitSourceBar(closedBarsRef.current, developingBarRef.current, bar);
    if (!admission.accepted) return;
    developingBarRef.current = admission.developingBar;
    // How many of this source-bar's own interval it takes to cover the
    // currently-selected display timeframe -- used both to size retention
    // below and to judge whether a resampled bucket is fully covered later.
    const requiredSourceBarsForDisplay = intervalMsRef.current % bar.interval_ms === 0
      ? intervalMsRef.current / bar.interval_ms
      : 1;
    const existingTradeSet = sourceBarTradesRef.current.get(bar.ts_open);
    // A duplicate final-bar frame can arrive after the hook has released its
    // temporary source-bar buffer. Never let that empty duplicate erase a
    // complete live observation already accepted by the terminal.
    if (trades.length > 0 || existingTradeSet === undefined) {
      sourceBarTradesRef.current.set(bar.ts_open, { trades: [...trades], tradeAvailability });
    } else if (tradeAvailability !== "LIVE_COMPLETE") {
      sourceBarTradesRef.current.set(bar.ts_open, {
        ...existingTradeSet,
        tradeAvailability: combinedTradeAvailability(existingTradeSet.tradeAvailability, tradeAvailability),
      });
    }
    const retentionTarget = Math.max(
      MIN_RETAINED_LIVE_TRADE_SOURCE_BARS,
      requiredSourceBarsForDisplay + RETAINED_LIVE_TRADE_SOURCE_BARS_HEADROOM,
    );
    // A while loop, not a single eviction: retentionTarget shrinks whenever
    // the user drops to a smaller display timeframe, and a map built up
    // under a much larger target (e.g. 1D) must be able to drain back down
    // in one pass rather than one entry per subsequent bar.
    while (sourceBarTradesRef.current.size > retentionTarget) {
      let oldestOpenTime: number | null = null;
      for (const openTime of sourceBarTradesRef.current.keys()) {
        if (oldestOpenTime === null || openTime < oldestOpenTime) oldestOpenTime = openTime;
      }
      if (oldestOpenTime === null) break;
      sourceBarTradesRef.current.delete(oldestOpenTime);
    }
    if (bar.closed) {
      chartRef.current?.applyRawBars(closedBarsRef.current);
      setTapeTradeCount(closedBarsRef.current.reduce((total, candidate) => total + (candidate.trade_count ?? 0), 0));
    }
    const affectedOpenTime = Math.floor(bar.ts_open / intervalMsRef.current) * intervalMsRef.current;
    const affectedSourceBars = sourceBarsForBucket(
      closedBarsRef.current,
      developingBarRef.current,
      affectedOpenTime,
      intervalMsRef.current,
    );
    const affected = resampleBars(affectedSourceBars, intervalMsRef.current)[0];
    let bucketTradeAvailability: TradeAvailability = affectedSourceBars.length === requiredSourceBarsForDisplay
      ? "LIVE_COMPLETE"
      : "HISTORICAL_UNAVAILABLE";
    const bucketTrades: TradeFrame[] = [];
    for (const sourceBar of affectedSourceBars) {
      const sourceTradeSet = sourceBarTradesRef.current.get(sourceBar.ts_open);
      if (sourceTradeSet === undefined) {
        bucketTradeAvailability = "HISTORICAL_UNAVAILABLE";
        continue;
      }
      bucketTrades.push(...sourceTradeSet.trades);
      bucketTradeAvailability = combinedTradeAvailability(bucketTradeAvailability, sourceTradeSet.tradeAvailability);
    }
    // `ctx.trades` is a complete live trade set for the visible chart bar,
    // never merely the last source-bar/rAF increment. If this bucket reaches
    // back before activation or has a bounded live loss, the availability
    // tells the indicator to decline the calculation rather than invent zero.
    if (affected) chartRef.current?.applyBar(affected, bucketTrades, bucketTradeAvailability);
    else {
      const buffer = fullBarBuffer(closedBarsRef.current, developingBarRef.current);
      chartRef.current?.applySnapshot(resampleBars(buffer, intervalMsRef.current));
    }
    setLatestBar(latestSourceBar(closedBarsRef.current, developingBarRef.current));
  }, []);

  const { analyticsStatus, analyticsIncomplete, status, feedHealth, trades, markerView, markersVersion, book, profile, liquidity, liquidityVersion, heatmapHistory, columnHistory, hostWalls, whaleWalls, l2, l2Version, icebergs, icebergsVersion, exhaustions, exhaustionsVersion, initiatives, initiativesVersion, candleMonitor, aggressiveTape, aggressiveHistoryIssue, bandHistory, bandHistoryVersion, requestBandHistory, requestL2History, deltaProfile, deltaProfileVersion, deltaTickProfile, deltaTickProfileVersion, requestDeltaProfile, rangePrints, askRangePrints, historicalProfiles, vpinHistory, vpinStatus, barHistory, activeSelection, selectPair, sendProfileConfig, sendProfileHistory, requestLiquidityResync, requestExhaustionHistory, requestInitiativeHistory, requestAggressiveHistory, stats } = useMarketData({ url: WS_URL, onSnapshotBars, onSelectionTrace: recordSelectionTrace, onBar });
  const activeSelectionRef = useRef(activeSelection);
  activeSelectionRef.current = activeSelection;

  const requestedPairRef = useRef<SelectedInstrument>(DEFAULT_PAIR);
  const [requestedPair, setRequestedPair] = useState(requestedPairRef.current);
  const [selectionInFlight, setSelectionInFlight] = useState(false);
  const selectionTimeoutRef = useRef<number | null>(null);
  const selectionAttemptRef = useRef(0);
  const unconfirmedRetryAllowedRef = useRef(false);
  const clearSelectionTimeout = useCallback(() => {
    if (selectionTimeoutRef.current !== null) {
      window.clearTimeout(selectionTimeoutRef.current);
      selectionTimeoutRef.current = null;
    }
  }, []);
  useEffect(() => {
    if (activeSelection) {
      selectionAttemptRef.current += 1;
      requestedPairRef.current = activeSelection;
      setRequestedPair(activeSelection);
      setSelectionInFlight(false);
      unconfirmedRetryAllowedRef.current = false;
      clearSelectionTimeout();
    }
  }, [activeSelection, clearSelectionTimeout]);
  useEffect(() => () => {
    selectionAttemptRef.current += 1;
    clearSelectionTimeout();
  }, [clearSelectionTimeout]);

  const feedUnavailable = feedHealth?.recoveryState === "UNAVAILABLE";
  const historyOnly = feedUnavailable && feedHealth?.reason === "DXFEED_NOT_CONFIGURED";
  const feedRecovering = feedHealth?.recoveryState === "RECOVERING";
  const feedStale = status === "open" && feedHealth?.recoveryState === "READY" && feedHealth.stale === true;
  const feedQuiet = feedHealth?.printsQuiet === true && !feedUnavailable;
  const feedInitializing = status === "open" && feedHealth === null;
  const backendDegraded = status === "open" && (feedRecovering || feedUnavailable || feedStale);
  const recordingStale = status === "open" && feedHealth?.recordingStale === true;
  const recordingLatestTs = feedHealth?.recordingLatestTs;
  const [recordingClock, setRecordingClock] = useState(() => Date.now());
  useEffect(() => {
    if (!recordingStale) return undefined;
    setRecordingClock(Date.now());
    const timer = setInterval(() => setRecordingClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [recordingStale, recordingLatestTs]);
  const recordingBehind = recordingStale && recordingLatestTs !== undefined ? formatRecordingLag(recordingClock - recordingLatestTs) : null;

  const handleSelectPair = useCallback(
    (symbol: string, identity: FrameIdentity) => {
      const sameRequestedPair = sameInstrument(requestedPairRef.current, symbol, identity);
      const forceRequest = sameRequestedPair && (
        unconfirmedRetryAllowedRef.current || (identity.provider === "DXFEED" && feedUnavailable)
      );
      if (sameRequestedPair && !forceRequest) return;
      unconfirmedRetryAllowedRef.current = false;
      const nextPair: SelectedInstrument = { symbol, ...identity };
      requestedPairRef.current = nextPair;
      setRequestedPair(nextPair);
      setSelectionInFlight(true);
      clearSelectionTimeout();
      const attempt = selectionAttemptRef.current + 1;
      selectionAttemptRef.current = attempt;
      const armTimeout = (allowRollback: boolean) => {
        selectionTimeoutRef.current = window.setTimeout(() => {
          selectionTimeoutRef.current = null;
          if (selectionAttemptRef.current !== attempt) return;
          const confirmed = activeSelectionRef.current;
          const requested = requestedPairRef.current;
          if (allowRollback && confirmed && !sameInstrument(confirmed, requested.symbol, requested)) {
            requestedPairRef.current = confirmed;
            setRequestedPair(confirmed);
            selectPair(confirmed.symbol, instrumentIdentity(confirmed));
            armTimeout(false);
            return;
          }
          setSelectionInFlight(false);
          unconfirmedRetryAllowedRef.current = true;
        }, SELECTION_CONFIRM_TIMEOUT_MS);
      };
      armTimeout(true);
      if (forceRequest) selectPair(symbol, identity, true);
      else selectPair(symbol, identity);
      closedBarsRef.current = [];
      developingBarRef.current = null;
      setLatestBar(null);
      chartRef.current?.applySnapshot([]);
      chartRef.current?.applyRawBars([]);
      resetPriceMotion();
    },
    [selectPair, clearSelectionTimeout, feedUnavailable, resetPriceMotion],
  );

  const selectionPending = selectionInFlight || (activeSelection !== null && !sameInstrument(activeSelection, requestedPair.symbol, requestedPair));

  const handleTimeframeSelect = useCallback(
    (newIntervalMs: number) => {
      if (newIntervalMs === intervalMsRef.current) return;
      setIntervalMs(newIntervalMs);
      const buffer = fullBarBuffer(closedBarsRef.current, developingBarRef.current);
      chartRef.current?.applySnapshot(resampleBars(buffer, newIntervalMs));
    },
    [],
  );

  const displayBar = (() => {
    if (!latestBar) return null;
    if (intervalMs === BASE_INTERVAL_MS) return latestBar;
    const bucketOpen = Math.floor(latestBar.ts_open / intervalMs) * intervalMs;
    const sourceBars = sourceBarsForBucket(closedBarsRef.current, developingBarRef.current, bucketOpen, intervalMs);
    return resampleBars(sourceBars, intervalMs)[0] ?? null;
  })();

  const lastTrade = trades[0];
  const px = lastTrade?.price ?? latestBar?.close;
  const deltaPct = displayBar && displayBar.open > 0 ? ((displayBar.close - displayBar.open) / displayBar.open) * 100 : null;
  const up = (deltaPct ?? 0) >= 0;

  useEffect(() => {
    if (px === undefined) return;
    const prev = prevPxRef.current;
    prevPxRef.current = px;
    if (prev === undefined || px === prev) return;
    const direction = px > prev ? "up" : "down";
    setFlash(direction);
    setLastTickDirection(direction);
    if (flashTimeoutRef.current !== null) window.clearTimeout(flashTimeoutRef.current);
    flashTimeoutRef.current = window.setTimeout(() => setFlash(null), 420);
  }, [px]);
  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current !== null) window.clearTimeout(flashTimeoutRef.current);
    };
  }, []);

  return (
    <div className={`shell${historicalModeActive ? " historical-active" : ""}${railExpanded ? " rail-expanded" : ""}`}>
      <div className="topbar">
        <div className="brand">
          <ChartPrimeLogo />
        </div>
        {historicalModeActive ? (
          <div className="historical-topbar-title">
            <span>Historical mode</span>
            <span>Archive workspace</span>
          </div>
        ) : (
          <>
            <div className="symbol-select">
              <SymbolMenu
                instruments={INSTRUMENTS}
                activeSymbol={requestedPair.symbol}
                activeIdentity={requestedPair}
                disabled={status !== "open" || selectionPending}
                onSelect={handleSelectPair}
              />
            </div>
            {px !== undefined && (
              <div className="px-readout">
                <span className={`px tabular${flash ? ` flash-${flash}` : ""}`}>{px.toFixed(2)}</span>
                {deltaPct !== null && (
                  <span className={`tabular delta ${up ? "o-up" : "o-down"}`}>
                    {up ? "+" : ""}
                    {deltaPct.toFixed(2)}%
                  </span>
                )}
              </div>
            )}
          </>
        )}
        <div className="topbar-spacer" />
        {historicalModeActive ? (
          <div className="status-chip historical-status-chip">
            <span className="dot quiet" />
            ARCHIVE MODE
          </div>
        ) : (
          <>
        {Object.entries(analyticsStatus ?? {}).filter(([, value]) => value !== "READY").map(([indicator, value]) => (
          <span key={indicator} role="status" className="status-chip">{indicator === "PROFILE" ? "Live profile" : "VPIN"} {value === "CLOSED" ? "market closed" : value === "EMPTY" ? "waiting for trades" : value === "WARMING" ? "catching up" : "unavailable"}</span>
        ))}
        {analyticsIncomplete && <span role="status" className="status-chip">Analytics incomplete — reload to rebuild</span>}
        {recordingStale && (
          <span role="status" className="status-chip recording" title="The collector is not writing this pair. The chart is live; tomorrow's history is not being recorded.">
            <span className="dot closed" />
            NO RECORDING{recordingBehind !== null ? ` ${recordingBehind}` : ""}
          </span>
        )}
        <div className="status-chip">
          <span className={`dot ${status === "open" ? (feedInitializing ? "connecting" : feedUnavailable ? (historyOnly ? "quiet" : "unavailable") : feedQuiet ? "quiet" : backendDegraded ? (feedStale ? "stale" : feedHealth!.recoveryState.toLowerCase()) : "pulse") : status}`} />
          {status === "open" ? (feedInitializing ? "SYNCING" : feedUnavailable ? (historyOnly ? "HISTORY ONLY" : feedHealth!.recoveryState) : feedQuiet ? "QUIET" : backendDegraded ? (feedStale ? "STALE" : feedHealth!.recoveryState) : "LIVE") : status.toUpperCase()}
        </div>
          </>
        )}
      </div>

      <div className="rail">
        <button type="button" className="rail-expand" onClick={() => setRailExpanded((expanded) => !expanded)} aria-expanded={railExpanded} aria-label={railExpanded ? "Collapse navigation" : "Expand navigation"} title={railExpanded ? "Collapse navigation" : "Expand navigation"}>
          <span aria-hidden="true">☰</span><span className="rail-label">Panels</span>
        </button>
        <div className="rail-tabs" role="tablist" aria-label="Panels" aria-orientation="vertical">
          {PANELS.map((panel, index) => (
            <button
              key={panel.id}
              ref={(node) => {
                railRefs.current[panel.id] = node;
              }}
              id={`panel-tab-${panel.id}`}
              type="button"
              role="tab"
              aria-selected={panel.id === activePanel}
              aria-current={panel.id === activePanel ? "true" : undefined}
              aria-controls={`panel-content-${panel.id}`}
              aria-label={panel.label}
              title={panel.label}
              tabIndex={panel.id === activePanel ? 0 : -1}
              className={`rail-item${panel.id === activePanel ? " active" : ""}`}
              onClick={() => {
                setActivePanel(panel.id);
                railRefs.current[panel.id]?.focus();
              }}
              onKeyDown={onRailKeyDown(index)}
            >
              <span className="rail-icon" aria-hidden="true">{panel.icon}</span><span className="rail-label">{panel.label}</span>
            </button>
          ))}
        </div>
        <div className="rail-gap" />
      </div>

      <div className="main">
        {PANELS.map((panel) => (
          <div
            key={panel.id}
            id={`panel-content-${panel.id}`}
            role="tabpanel"
            aria-labelledby={`panel-tab-${panel.id}`}
            hidden={panel.id !== activePanel}
            tabIndex={panel.id === activePanel && panel.id !== "chart" ? 0 : undefined}
          >
            {panel.id === "chart" ? (
              <MainPanel
                tapeTradeCount={tapeTradeCount}
                chartRef={chartRef}
                intervalMs={intervalMs}
                onTimeframeSelect={handleTimeframeSelect}
                displayBar={displayBar}
                up={up}
                status={status}
                backendDegraded={backendDegraded}
                latestBar={latestBar}
                feedHealth={feedHealth}
                feedStale={feedStale}
                barHistory={barHistory}
                book={book}
                profile={profile}
                liquidity={liquidity}
                liquidityVersion={liquidityVersion}
                heatmapHistory={heatmapHistory}
                columnHistory={columnHistory}
                hostWalls={hostWalls}
                whaleWalls={whaleWalls}
                l2={l2}
                l2Version={l2Version}
                icebergs={icebergs}
                icebergsVersion={icebergsVersion}
                exhaustions={exhaustions}
                exhaustionsVersion={exhaustionsVersion}
                initiatives={initiatives}
                initiativesVersion={initiativesVersion}
                candleMonitor={candleMonitor}
                aggressiveTape={aggressiveTape}
                aggressiveHistoryIssue={aggressiveHistoryIssue}
                bandHistory={bandHistory}
                bandHistoryVersion={bandHistoryVersion}
                requestBandHistory={requestBandHistory}
                requestL2History={requestL2History}
                deltaProfile={deltaProfile}
                deltaProfileVersion={deltaProfileVersion}
                deltaTickProfile={deltaTickProfile}
                deltaTickProfileVersion={deltaTickProfileVersion}
                requestDeltaProfile={requestDeltaProfile}
                rangePrints={rangePrints}
                askRangePrints={askRangePrints}
                historicalProfiles={historicalProfiles}
                vpinHistory={vpinHistory}
                vpinStatus={vpinStatus}
                sendProfileConfig={sendProfileConfig}
                sendProfileHistory={sendProfileHistory}
                requestLiquidityResync={requestLiquidityResync}
                requestExhaustionHistory={requestExhaustionHistory}
                requestInitiativeHistory={requestInitiativeHistory}
                requestAggressiveHistory={requestAggressiveHistory}
                trades={trades}
                markerView={markerView}
                markersVersion={markersVersion}
                lastPrice={px}
                watchlistPrice={!feedQuiet && !selectionPending ? lastTrade?.price : undefined}
                lastTickDirection={lastTickDirection}
                instrumentIdentity={requestedPair}
                onSelectWatchInstrument={handleSelectPair}
              />
            ) : panel.id === "historical" ? (
              activePanel === "historical" ? <HistoricalModePanel /> : null
            ) : (
              <ComingSoonPanel
                title={panel.label}
                description="This panel is not connected yet."
              />
            )}
          </div>
        ))}
      </div>

      <div className="statusbar">
        {historicalModeActive ? (
          <>
            <span className="historical-status-label"><span className="dot quiet" />HISTORICAL</span>
            <span className="sep" />
            <span>archive query workspace</span>
            <span className="statusbar-spacer" />
            <span>select an instrument</span>
          </>
        ) : (
          <>
            <span>ws {status}</span>
            <span className="sep" />
            <span>
              trades <span className="hot">{stats.tradesReceived.toLocaleString()}</span>
            </span>
            <span className="sep" />
            <span>
              bars closed <span className="hot">{stats.barsClosed.toLocaleString()}</span>
            </span>
            {stats.latencyMs !== null && (
              <>
                <span className="sep" />
                <span>
                  latency <span className="hot tabular">{Math.round(stats.latencyMs)}ms</span>
                </span>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
