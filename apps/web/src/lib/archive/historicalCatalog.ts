import type { ArchiveFamily, ArchiveQuery } from "./archiveClient";
import type { FrameIdentity } from "../../types/frames";

export type HistoricalResolution = "1m" | "1h" | "1d";
export type HistoricalInstrumentGroup = "Crypto" | "Futures" | "Equities";
export type HistoricalSource = "binance" | "databento";

type HistoricalInstrumentBase = {
  readonly id: string;
  readonly group: HistoricalInstrumentGroup;
  readonly label: string;
  readonly symbol: string;
  readonly source: HistoricalSource;
  readonly chartIdentity: FrameIdentity;
  readonly availableFrom: string;
  readonly availableToExclusive: string;
};

export type HistoricalQueryableInstrument = HistoricalInstrumentBase & {
  readonly availability: "ready";
  readonly kind: "single";
  readonly archiveInstrumentId: string;
};

export type HistoricalFutureRoll = Readonly<{
  readonly contract: string;
  readonly archiveInstrumentId: string;
  readonly from: string;
  readonly to: string;
}>;

export type HistoricalContinuousFuture = HistoricalInstrumentBase & {
  readonly availability: "ready";
  readonly kind: "continuous";
  readonly rolls: readonly HistoricalFutureRoll[];
};

export type HistoricalInstrument = HistoricalQueryableInstrument | HistoricalContinuousFuture;

const DAY_MS = 24 * 60 * 60 * 1_000;
const INITIAL_WINDOW_MS: Readonly<Record<HistoricalResolution, number>> = Object.freeze({
  "1m": DAY_MS,
  "1h": 14 * DAY_MS,
  "1d": Number.POSITIVE_INFINITY,
});

export const ARCHIVE_QUERY_LIMIT = 10_000;

function archiveIdentity(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function queryable(
  instrument: Omit<HistoricalQueryableInstrument, "availability" | "kind">,
): HistoricalQueryableInstrument {
  return Object.freeze({
    ...instrument,
    chartIdentity: Object.freeze({ ...instrument.chartIdentity }),
    availability: "ready",
    kind: "single",
  });
}

function future(
  instrument: Omit<HistoricalContinuousFuture, "availability" | "kind">,
): HistoricalContinuousFuture {
  return Object.freeze({
    ...instrument,
    chartIdentity: Object.freeze({ ...instrument.chartIdentity }),
    availability: "ready",
    kind: "continuous",
    rolls: Object.freeze(instrument.rolls.map((roll) => Object.freeze(roll))),
  });
}

const BINANCE_END = "2026-09-01T00:00:00.000Z";
const DATABENTO_END = "2026-09-01T00:00:00.000Z";

export const HISTORICAL_INSTRUMENTS: readonly HistoricalInstrument[] = Object.freeze([
  queryable({
    id: "btc-spot",
    group: "Crypto",
    label: "BTC Spot",
    symbol: "BTCUSDT",
    source: "binance",
    chartIdentity: { provider: "BINANCE", marketKind: "SPOT" },
    archiveInstrumentId: archiveIdentity(["BINANCE", "SPOT", "BTCUSDT", "USDT", "COIN"]),
    availableFrom: "2025-09-01T00:00:00.000Z",
    availableToExclusive: BINANCE_END,
  }),
  queryable({
    id: "btc-perpetual",
    group: "Crypto",
    label: "BTC Perpetual",
    symbol: "BTCUSDT",
    source: "binance",
    chartIdentity: { provider: "BINANCE", marketKind: "PERPETUAL" },
    archiveInstrumentId: archiveIdentity(["BINANCE", "PERPETUAL", "BTCUSDT", "USDT", "COIN"]),
    availableFrom: "2025-09-01T00:00:00.000Z",
    availableToExclusive: BINANCE_END,
  }),
  queryable({
    id: "eth-spot",
    group: "Crypto",
    label: "ETH Spot",
    symbol: "ETHUSDT",
    source: "binance",
    chartIdentity: { provider: "BINANCE", marketKind: "SPOT" },
    archiveInstrumentId: archiveIdentity(["BINANCE", "SPOT", "ETHUSDT", "USDT", "COIN"]),
    availableFrom: "2025-09-01T00:00:00.000Z",
    availableToExclusive: BINANCE_END,
  }),
  queryable({
    id: "eth-perpetual",
    group: "Crypto",
    label: "ETH Perpetual",
    symbol: "ETHUSDT",
    source: "binance",
    chartIdentity: { provider: "BINANCE", marketKind: "PERPETUAL" },
    archiveInstrumentId: archiveIdentity(["BINANCE", "PERPETUAL", "ETHUSDT", "USDT", "COIN"]),
    availableFrom: "2025-09-01T00:00:00.000Z",
    availableToExclusive: BINANCE_END,
  }),
  future({
    id: "es-continuous",
    group: "Futures",
    label: "ES Continuous",
    symbol: "ES",
    source: "databento",
    chartIdentity: { provider: "DATABENTO", assetClass: "FUTURE" },
    availableFrom: "2025-09-01T00:00:00.000Z",
    availableToExclusive: DATABENTO_END,
    rolls: [
      { contract: "ESU5", archiveInstrumentId: archiveIdentity(["XCME", "FUTURE", "ESU5", "USD", "CONTRACT"]), from: "2025-09-01T00:00:00.000Z", to: "2025-09-17T00:00:00.000Z" },
      { contract: "ESZ5", archiveInstrumentId: archiveIdentity(["XCME", "FUTURE", "ESZ5", "USD", "CONTRACT"]), from: "2025-09-17T00:00:00.000Z", to: "2025-12-17T00:00:00.000Z" },
      { contract: "ESH6", archiveInstrumentId: archiveIdentity(["XCME", "FUTURE", "ESH6", "USD", "CONTRACT"]), from: "2025-12-17T00:00:00.000Z", to: "2026-03-18T00:00:00.000Z" },
      { contract: "ESM6", archiveInstrumentId: archiveIdentity(["XCME", "FUTURE", "ESM6", "USD", "CONTRACT"]), from: "2026-03-18T00:00:00.000Z", to: "2026-06-17T00:00:00.000Z" },
      { contract: "ESU6", archiveInstrumentId: archiveIdentity(["XCME", "FUTURE", "ESU6", "USD", "CONTRACT"]), from: "2026-06-17T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" },
    ],
  }),
  future({
    id: "nq-continuous",
    group: "Futures",
    label: "NQ Continuous",
    symbol: "NQ",
    source: "databento",
    chartIdentity: { provider: "DATABENTO", assetClass: "FUTURE" },
    availableFrom: "2025-09-01T00:00:00.000Z",
    availableToExclusive: DATABENTO_END,
    rolls: [
      { contract: "NQU5", archiveInstrumentId: archiveIdentity(["XCME", "FUTURE", "NQU5", "USD", "CONTRACT"]), from: "2025-09-01T00:00:00.000Z", to: "2025-09-18T00:00:00.000Z" },
      { contract: "NQZ5", archiveInstrumentId: archiveIdentity(["XCME", "FUTURE", "NQZ5", "USD", "CONTRACT"]), from: "2025-09-18T00:00:00.000Z", to: "2025-12-18T00:00:00.000Z" },
      { contract: "NQH6", archiveInstrumentId: archiveIdentity(["XCME", "FUTURE", "NQH6", "USD", "CONTRACT"]), from: "2025-12-18T00:00:00.000Z", to: "2026-03-19T00:00:00.000Z" },
      { contract: "NQM6", archiveInstrumentId: archiveIdentity(["XCME", "FUTURE", "NQM6", "USD", "CONTRACT"]), from: "2026-03-19T00:00:00.000Z", to: "2026-06-17T00:00:00.000Z" },
      { contract: "NQU6", archiveInstrumentId: archiveIdentity(["XCME", "FUTURE", "NQU6", "USD", "CONTRACT"]), from: "2026-06-17T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" },
    ],
  }),
  queryable({
    id: "aapl",
    group: "Equities",
    label: "AAPL",
    symbol: "AAPL",
    source: "databento",
    chartIdentity: { provider: "DATABENTO", assetClass: "EQUITY" },
    archiveInstrumentId: archiveIdentity(["XNAS", "EQUITY", "AAPL", "USD", "SHARE"]),
    availableFrom: "2025-09-02T00:00:00.000Z",
    availableToExclusive: DATABENTO_END,
  }),
  queryable({
    id: "tsla",
    group: "Equities",
    label: "TSLA",
    symbol: "TSLA",
    source: "databento",
    chartIdentity: { provider: "DATABENTO", assetClass: "EQUITY" },
    archiveInstrumentId: archiveIdentity(["XNAS", "EQUITY", "TSLA", "USD", "SHARE"]),
    availableFrom: "2025-09-02T00:00:00.000Z",
    availableToExclusive: DATABENTO_END,
  }),
]);

export const HISTORICAL_INSTRUMENT_GROUPS: readonly HistoricalInstrumentGroup[] = Object.freeze([
  "Crypto", "Futures", "Equities",
]);

export function familyForResolution(resolution: HistoricalResolution): ArchiveFamily {
  return `candle_${resolution}` as ArchiveFamily;
}

export function initialArchiveWindow(
  instrument: HistoricalInstrument,
  resolution: HistoricalResolution,
): Readonly<{ fromMs: number; toMs: number }> {
  const earliest = Date.parse(instrument.availableFrom);
  const latest = Date.parse(instrument.availableToExclusive);
  const windowMs = INITIAL_WINDOW_MS[resolution];
  return Object.freeze({
    fromMs: Number.isFinite(windowMs) ? Math.max(earliest, latest - windowMs) : earliest,
    toMs: latest,
  });
}

export function initialArchiveQuery(
  instrument: HistoricalQueryableInstrument,
  resolution: HistoricalResolution,
): Readonly<ArchiveQuery> {
  const { fromMs, toMs } = initialArchiveWindow(instrument, resolution);
  return archiveQueryForWindow(instrument, resolution, { fromMs, toMs });
}

export function archiveQueryForWindow(
  instrument: HistoricalQueryableInstrument,
  resolution: HistoricalResolution,
  window: Readonly<{ fromMs: number; toMs: number }>,
  pointerToken?: string,
): Readonly<ArchiveQuery> {
  if (!Number.isSafeInteger(window.fromMs) || !Number.isSafeInteger(window.toMs) || window.fromMs >= window.toMs) {
    throw new RangeError("historical archive query window is invalid");
  }
  return Object.freeze({
    instrumentId: instrument.archiveInstrumentId,
    family: familyForResolution(resolution),
    from: (BigInt(window.fromMs) * 1_000_000n).toString(),
    to: (BigInt(window.toMs) * 1_000_000n).toString(),
    limit: ARCHIVE_QUERY_LIMIT,
    ...(pointerToken === undefined ? {} : { pointerToken }),
  });
}
