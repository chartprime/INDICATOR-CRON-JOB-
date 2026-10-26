import {
  ArchiveTransportError,
  type ArchiveCoverage,
  type ArchivePage,
  type ArchiveQuery,
  type ArchiveRefusal,
  type ArchiveRestart,
  type ArchiveRow,
  createArchiveClient,
} from "./archiveClient";
import { archiveCandles } from "./archiveCandles";
import { queryArchivePages } from "./archivePagination";
import {
  familyForResolution,
  initialArchiveWindow,
  type HistoricalContinuousFuture,
  type HistoricalResolution,
} from "./historicalCatalog";
import {
  HISTORICAL_MAX_CURSOR_PAGES_PER_WINDOW,
  type HistoricalWindow,
} from "./historicalRetention";

export type HistoricalRollMarker = Readonly<{
  time: number;
  label: string;
}>;

export type ArchivePresentationPage = Readonly<{
  rows: readonly ArchiveRow[];
  pointerToken: string;
  family: ArchivePage["family"];
  coverage: ArchiveCoverage;
  scan: Readonly<Record<string, number>>;
  rollMarkers: readonly HistoricalRollMarker[];
}>;

export type ContinuousArchivePlan = Readonly<{
  requests: readonly Readonly<{
    contract: string;
    fromMs: number;
    toMs: number;
    maximumPages: number;
    request: ArchiveQuery;
  }>[];
  rollMarkers: readonly HistoricalRollMarker[];
}>;

export class ContinuousArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContinuousArchiveError";
  }
}

export function dateMs(value: string, field: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new ContinuousArchiveError(`continuous future ${field} is not a canonical UTC date`);
  }
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result)) {
    throw new ContinuousArchiveError(`continuous future ${field} is not a valid UTC date`);
  }
  return result;
}

function archiveIdentityContract(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 5 || parsed.some((part) => typeof part !== "string")) {
      return null;
    }
    const identity = parsed as string[];
    return identity[0] === "XCME" && identity[1] === "FUTURE" && identity[3] === "USD" && identity[4] === "CONTRACT"
      ? identity[2]
      : null;
  } catch {
    return null;
  }
}

export function validateContinuousFuture(instrument: HistoricalContinuousFuture): void {
  if (instrument.rolls.length === 0) {
    throw new ContinuousArchiveError("continuous future has no roll intervals");
  }
  const availableFrom = dateMs(instrument.availableFrom, "availableFrom");
  const availableTo = dateMs(instrument.availableToExclusive, "availableToExclusive");
  let priorTo: number | null = null;
  for (const roll of instrument.rolls) {
    const fromMs = dateMs(roll.from, "roll.from");
    const toMs = dateMs(roll.to, "roll.to");
    if (fromMs >= toMs) {
      throw new ContinuousArchiveError(`continuous future ${roll.contract} has an empty roll interval`);
    }
    if (priorTo !== null && priorTo !== fromMs) {
      throw new ContinuousArchiveError(`continuous future ${instrument.symbol} has non-contiguous roll intervals`);
    }
    if (archiveIdentityContract(roll.archiveInstrumentId) !== roll.contract) {
      throw new ContinuousArchiveError(`continuous future ${roll.contract} has a mismatched archive identity`);
    }
    priorTo = toMs;
  }
  if (dateMs(instrument.rolls[0].from, "roll.from") !== availableFrom || priorTo !== availableTo) {
    throw new ContinuousArchiveError(`continuous future ${instrument.symbol} does not cover its advertised range`);
  }
}

function ns(ms: number): string {
  return (BigInt(ms) * 1_000_000n).toString();
}

function canonicalNs(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ContinuousArchiveError(`continuous archive ${field} is not an unsigned nanosecond value`);
  }
  return BigInt(value);
}

function validatePageCoverage(page: ArchivePage, request: ContinuousArchivePlan["requests"][number]): void {
  const coverage = page.coverage;
  if (coverage.requested.from !== request.request.from || coverage.requested.to !== request.request.to) {
    throw new ContinuousArchiveError(`continuous archive ${request.contract} page has mismatched coverage bounds`);
  }
  const requestedFrom = canonicalNs(coverage.requested.from, "coverage.requested.from");
  const requestedTo = canonicalNs(coverage.requested.to, "coverage.requested.to");
  if (requestedFrom >= requestedTo) {
    throw new ContinuousArchiveError(`continuous archive ${request.contract} page has an empty requested coverage`);
  }
  if (coverage.served === null) return;
  const servedFrom = canonicalNs(coverage.served.from, "coverage.served.from");
  const servedTo = canonicalNs(coverage.served.to, "coverage.served.to");
  if (servedFrom >= servedTo || servedFrom < requestedFrom || servedTo > requestedTo) {
    throw new ContinuousArchiveError(`continuous archive ${request.contract} page has invalid served coverage`);
  }
}

export function planContinuousArchiveQueries(
  instrument: HistoricalContinuousFuture,
  resolution: HistoricalResolution,
  requestedWindow?: Pick<HistoricalWindow, "fromMs" | "toMs">,
): ContinuousArchivePlan {
  validateContinuousFuture(instrument);
  const { fromMs: requestedFromMs, toMs: requestedToMs } = requestedWindow ?? initialArchiveWindow(instrument, resolution);
  const family = familyForResolution(resolution);
  const requests = instrument.rolls.flatMap((roll) => {
    const fromMs = Math.max(requestedFromMs, dateMs(roll.from, "roll.from"));
    const toMs = Math.min(requestedToMs, dateMs(roll.to, "roll.to"));
    if (fromMs >= toMs) return [];
    return [Object.freeze({
      contract: roll.contract,
      fromMs,
      toMs,
      maximumPages: resolution === "1d" ? 1 : HISTORICAL_MAX_CURSOR_PAGES_PER_WINDOW,
      request: Object.freeze({
        instrumentId: roll.archiveInstrumentId,
        family,
        from: ns(fromMs),
        to: ns(toMs),
        limit: 10_000,
      }),
    })];
  });
  if (requests.length === 0) {
    throw new ContinuousArchiveError(`continuous future ${instrument.symbol} has no requestable roll interval`);
  }
  const rollMarkers = instrument.rolls.slice(1).flatMap((roll, index) => {
    const time = dateMs(roll.from, "roll.from");
    if (time < requestedFromMs || time >= requestedToMs) return [];
    return [Object.freeze({ time, label: `${instrument.rolls[index].contract} → ${roll.contract}` })];
  });
  return Object.freeze({ requests: Object.freeze(requests), rollMarkers: Object.freeze(rollMarkers) });
}

function combineCoverage(
  pages: readonly ArchivePage[],
  from: string,
  to: string,
): ArchiveCoverage {
  const states: Record<string, number> = {};
  const corrupt = new Map<string, { date: string; reason: string | null }>();
  const served = pages.flatMap((page) => page.coverage.served === null
    ? []
    : [Object.freeze({
      from: page.coverage.served.from,
      to: page.coverage.served.to,
      fromNs: canonicalNs(page.coverage.served.from, "coverage.served.from"),
      toNs: canonicalNs(page.coverage.served.to, "coverage.served.to"),
    })]);
  for (const page of pages) {
    for (const [state, count] of Object.entries(page.coverage.states)) {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new ContinuousArchiveError("continuous archive page has invalid coverage counts");
      }
      const total = (states[state] ?? 0) + count;
      if (!Number.isSafeInteger(total)) {
        throw new ContinuousArchiveError("continuous archive coverage count exceeds the safe integer range");
      }
      states[state] = total;
    }
    for (const entry of page.coverage.corrupt) {
      corrupt.set(`${entry.date}\u0000${entry.reason ?? ""}`, entry);
    }
  }
  const partitions = pages.reduce((total, page) => {
    if (!Number.isSafeInteger(page.coverage.partitions) || page.coverage.partitions < 0) {
      throw new ContinuousArchiveError("continuous archive page has invalid partition coverage");
    }
    const next = total + page.coverage.partitions;
    if (!Number.isSafeInteger(next)) {
      throw new ContinuousArchiveError("continuous archive partition coverage exceeds the safe integer range");
    }
    return next;
  }, 0);
  return Object.freeze({
    requested: { from, to },
    served: served.length === 0
      ? null
      : {
        from: served.reduce((minimum, value) => value.fromNs < minimum.fromNs ? value : minimum).from,
        to: served.reduce((maximum, value) => value.toNs > maximum.toNs ? value : maximum).to,
      },
    partitions,
    states: Object.freeze(states),
    corrupt: Object.freeze([...corrupt.values()]),
  });
}

function combineScan(pages: readonly ArchivePage[]): Readonly<Record<string, number>> {
  const integerFields = [
    "partitionsRead", "partitionsSelected", "partsOpened", "exactScanBytes", "bytesRead", "cacheHits", "cacheMisses",
  ] as const;
  const durationFields = ["fetchMs", "queryMs"] as const;
  const requiredFields = new Set<string>([...integerFields, ...durationFields]);
  const scan: Record<string, number> = {};
  for (const page of pages) {
    const fields = Object.keys(page.scan);
    if (fields.length !== requiredFields.size || fields.some((field) => !requiredFields.has(field))) {
      throw new ContinuousArchiveError("continuous archive page has an invalid scan metric set");
    }
    for (const [field, value] of Object.entries(page.scan)) {
      const integer = integerFields.includes(field as typeof integerFields[number]);
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0
          || (integer && !Number.isSafeInteger(value))) {
        throw new ContinuousArchiveError(`continuous archive page has invalid ${field} scan metric`);
      }
      const total = (scan[field] ?? 0) + value;
      if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) {
        throw new ContinuousArchiveError(`continuous archive ${field} scan metric exceeds the safe integer range`);
      }
      scan[field] = total;
    }
  }
  return Object.freeze(scan);
}

export function presentationPage(page: ArchivePage): ArchivePresentationPage {
  return Object.freeze({
    rows: page.rows,
    pointerToken: page.pointerToken,
    family: page.family,
    coverage: page.coverage,
    scan: page.scan,
    rollMarkers: Object.freeze([]),
  });
}

export function mergeContinuousArchivePages(
  plan: ContinuousArchivePlan,
  pages: readonly ArchivePage[],
): ArchivePresentationPage {
  if (pages.length !== plan.requests.length) {
    throw new ContinuousArchiveError("continuous archive did not return every planned contract page");
  }
  const first = pages[0];
  if (first.pointerToken.length === 0) {
    throw new ContinuousArchiveError("continuous archive page has an empty catalog snapshot token");
  }
  const rows: { row: ArchiveRow; openMs: number }[] = [];
  for (const [index, page] of pages.entries()) {
    const request = plan.requests[index];
    if (page.family !== request.request.family || page.nextCursor !== null) {
      throw new ContinuousArchiveError(`continuous archive ${request.contract} page is incomplete`);
    }
    validatePageCoverage(page, request);
    if (page.pointerToken.length === 0) {
      throw new ContinuousArchiveError("continuous archive page has an empty catalog snapshot token");
    }
    if (page.pointerToken !== first.pointerToken) {
      throw new ContinuousArchiveError("continuous archive pages do not share one catalog snapshot");
    }
    const candles = archiveCandles(page.rows);
    for (const [rowIndex, candle] of candles.entries()) {
      if (candle.openMs < request.fromMs || candle.openMs >= request.toMs) {
        throw new ContinuousArchiveError(`continuous archive ${request.contract} returned a candle outside its roll interval`);
      }
      rows.push({ row: page.rows[rowIndex], openMs: candle.openMs });
    }
  }
  rows.sort((left, right) => left.openMs - right.openMs);
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index - 1].openMs >= rows[index].openMs) {
      throw new ContinuousArchiveError("continuous archive contains duplicate or unordered candle timestamps");
    }
  }
  return Object.freeze({
    rows: Object.freeze(rows.map(({ row }) => row)),
    pointerToken: first.pointerToken,
    family: first.family,
    coverage: combineCoverage(pages, plan.requests[0].request.from, plan.requests.at(-1)!.request.to),
    scan: combineScan(pages),
    rollMarkers: plan.rollMarkers,
  });
}

export type ContinuousArchiveResult = ArchiveRefusal | ArchiveRestart | Readonly<{
  outcome: "page";
  page: ArchivePresentationPage;
}>;

type ContinuousArchiveLegResult = ArchiveRefusal | ArchiveRestart | Readonly<{
  outcome: "page";
  page: ArchivePage;
}>;

async function queryContinuousArchiveLeg(
  client: ReturnType<typeof createArchiveClient>,
  item: ContinuousArchivePlan["requests"][number],
  pointerToken: string | null,
  signal: AbortSignal | undefined,
): Promise<ContinuousArchiveLegResult> {
  const result = await queryArchivePages(client, {
    ...item.request,
    ...(pointerToken === null ? {} : { pointerToken }),
  }, { signal, maximumPages: item.maximumPages });
  if (result.outcome !== "page") return result;
  if (pointerToken !== null && result.pointerToken !== pointerToken) {
    throw new ContinuousArchiveError("continuous archive pages do not share one catalog snapshot");
  }
  if (result.pointerToken.length === 0) {
    throw new ContinuousArchiveError("continuous archive page has an empty catalog snapshot token");
  }
  return { outcome: "page", page: result };
}

export async function queryContinuousArchivePage(
  client: ReturnType<typeof createArchiveClient>,
  plan: ContinuousArchivePlan,
  { signal, pointerToken: initialPointerToken = null }: { signal?: AbortSignal; pointerToken?: string | null } = {},
): Promise<ContinuousArchiveResult> {
  const [firstItem, ...restItems] = plan.requests;
  const first = await queryContinuousArchiveLeg(client, firstItem, initialPointerToken, signal);
  if (first.outcome !== "page") return first;

  const rest = await Promise.all(
    restItems.map((item) => queryContinuousArchiveLeg(client, item, first.page.pointerToken, signal)),
  );
  const failed = rest.find((result): result is Exclude<ContinuousArchiveLegResult, { outcome: "page" }> => result.outcome !== "page");
  if (failed !== undefined) return failed;

  const pages = [first.page, ...rest.map((result) => {
    if (result.outcome !== "page") throw new ContinuousArchiveError("continuous archive leg failed after being checked");
    return result.page;
  })];
  try {
    return { outcome: "page", page: mergeContinuousArchivePages(plan, pages) };
  } catch (error) {
    if (error instanceof ContinuousArchiveError) throw error;
    throw new ArchiveTransportError("the archive returned an invalid continuous futures page");
  }
}
