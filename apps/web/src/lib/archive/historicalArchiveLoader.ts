import { archivePageCandleSeries, ArchiveChartBarError } from "./archiveChartBars";
import { ArchiveTransportError, type ArchiveRefusal, type ArchiveRestart, createArchiveClient } from "./archiveClient";
import { queryArchivePages } from "./archivePagination";
import {
  archiveQueryForWindow,
  type HistoricalInstrument,
  type HistoricalQueryableInstrument,
} from "./historicalCatalog";
import { ContinuousArchiveError, planContinuousArchiveQueries, presentationPage, queryContinuousArchivePage, type ArchivePresentationPage } from "./continuousArchive";
import { HistoricalResampleError } from "./historicalResampleBars";
import {
  HistoricalIndicatorSeriesError,
  resampleHistoricalIndicatorSeries,
  type HistoricalIndicatorSeries,
} from "./historicalIndicatorSeries";
import type { HistoricalWindow } from "./historicalRetention";
import type { HistoricalTimeframe } from "./historicalTimeframes";

export type HistoricalArchiveWindowResult = ArchiveRefusal | ArchiveRestart | Readonly<{
  outcome: "page";
  page: ArchivePresentationPage;
  series: HistoricalIndicatorSeries;
}>;

export class HistoricalArchiveLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoricalArchiveLoadError";
  }
}

export function toSeries(
  instrument: HistoricalInstrument,
  timeframe: HistoricalTimeframe,
  page: ArchivePresentationPage,
  window: Pick<HistoricalWindow, "fromMs" | "toMs">,
): HistoricalIndicatorSeries {
  try {
    const source = archivePageCandleSeries(instrument, timeframe.sourceResolution, page);
    if (source.bars.some((bar) => bar.ts_open < window.fromMs || bar.ts_open + bar.interval_ms > window.toMs)) {
      throw new HistoricalArchiveLoadError("the archive returned a candle outside the requested historical window");
    }
    return resampleHistoricalIndicatorSeries(
      source,
      timeframe,
    );
  } catch (error) {
    if (error instanceof ArchiveChartBarError
        || error instanceof HistoricalResampleError
        || error instanceof HistoricalIndicatorSeriesError) {
      throw new HistoricalArchiveLoadError(error.message);
    }
    throw error;
  }
}

export async function loadHistoricalArchiveWindow(
  client: ReturnType<typeof createArchiveClient>,
  instrument: HistoricalInstrument,
  timeframe: HistoricalTimeframe,
  window: HistoricalWindow,
  { signal, pointerToken }: Readonly<{ signal?: AbortSignal; pointerToken?: string }> = {},
): Promise<HistoricalArchiveWindowResult> {
  try {
    if (instrument.kind === "continuous") {
      const result = await queryContinuousArchivePage(
        client,
        planContinuousArchiveQueries(instrument, timeframe.sourceResolution, window),
        { signal, pointerToken },
      );
      if (result.outcome !== "page") return result;
      return Object.freeze({ outcome: "page", page: result.page, series: toSeries(instrument, timeframe, result.page, window) });
    }
    const result = await queryArchivePages(
      client,
      archiveQueryForWindow(
        instrument as HistoricalQueryableInstrument,
        timeframe.sourceResolution,
        window,
        pointerToken,
      ),
      { signal, maximumPages: window.maximumPages },
    );
    if (result.outcome !== "page") return result;
    const page = presentationPage(result);
    return Object.freeze({ outcome: "page", page, series: toSeries(instrument, timeframe, page, window) });
  } catch (error) {
    if (error instanceof ArchiveTransportError || error instanceof ContinuousArchiveError || error instanceof HistoricalArchiveLoadError) {
      throw error;
    }
    throw new HistoricalArchiveLoadError("the archive returned an invalid historical window");
  }
}
