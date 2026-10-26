import {
  ArchiveTransportError,
  type ArchivePage,
  type ArchiveQuery,
  type ArchiveResult,
  createArchiveClient,
} from "./archiveClient";

type ArchiveClient = ReturnType<typeof createArchiveClient>;

type ServedWindow = ArchivePage["coverage"]["served"];

function sameCoverage(left: ArchivePage["coverage"], right: ArchivePage["coverage"]): boolean {
  return JSON.stringify({ ...left, served: null }) === JSON.stringify({ ...right, served: null });
}

function servedContinues(previous: ServedWindow, next: ServedWindow): boolean {
  if (previous === null || next === null) return true;
  return BigInt(next.from) >= BigInt(previous.from) && BigInt(next.to) >= BigInt(previous.to);
}

function combinedServed(pages: readonly ArchivePage[]): ServedWindow {
  const served = pages.map((page) => page.coverage.served).filter((window): window is NonNullable<ServedWindow> => window !== null);
  const first = served[0];
  const last = served.at(-1);
  if (first === undefined || last === undefined) return null;
  return Object.freeze({ from: first.from, to: last.to });
}

function validatePageForRequest(page: ArchivePage, request: ArchiveQuery): void {
  if (page.family !== request.family) {
    throw new ArchiveTransportError("the archive changed candle family while paging");
  }
  if (page.pointerToken.length === 0 || page.queryFingerprint.length === 0) {
    throw new ArchiveTransportError("the archive returned an unpinned page");
  }
  if (page.coverage.requested.from !== request.from || page.coverage.requested.to !== request.to) {
    throw new ArchiveTransportError("the archive changed coverage bounds while paging");
  }
}

export function combineArchiveScan(pages: readonly ArchivePage[]): Readonly<Record<string, number>> {
  const integerMetrics = new Set([
    "partitionsRead", "partitionsSelected", "partsOpened", "exactScanBytes", "bytesRead", "cacheHits", "cacheMisses",
  ]);
  if (pages.length === 0) throw new ArchiveTransportError("the archive returned no pages");
  const keys = Object.keys(pages[0].scan).sort();
  const scan: Record<string, number> = {};
  for (const page of pages) {
    const pageKeys = Object.keys(page.scan).sort();
    if (pageKeys.length !== keys.length || pageKeys.some((key, index) => key !== keys[index])) {
      throw new ArchiveTransportError("the archive changed scan metrics while paging");
    }
    for (const key of keys) {
      const value = page.scan[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new ArchiveTransportError("the archive returned an invalid scan metric");
      }
      if (integerMetrics.has(key) && !Number.isSafeInteger(value)) {
        throw new ArchiveTransportError("the archive returned an invalid integer scan metric");
      }
      const total = (scan[key] ?? 0) + value;
      if (integerMetrics.has(key) && !Number.isSafeInteger(total)) {
        throw new ArchiveTransportError("the archive scan metric exceeds the safe integer range");
      }
      if (!Number.isFinite(total)) throw new ArchiveTransportError("the archive scan metric is not finite");
      scan[key] = total;
    }
  }
  return Object.freeze(scan);
}

export async function queryArchivePages(
  client: ArchiveClient,
  request: ArchiveQuery,
  { signal, maximumPages }: Readonly<{ signal?: AbortSignal; maximumPages: number }>,
): Promise<ArchiveResult> {
  if (!Number.isSafeInteger(maximumPages) || maximumPages < 1) {
    throw new RangeError("archive pagination requires a positive integer page budget");
  }
  const pages: ArchivePage[] = [];
  const requestedPointerToken = request.pointerToken ?? null;
  let pointerToken = requestedPointerToken;
  let cursor = request.cursor ?? null;
  let fingerprint: string | null = null;
  for (let index = 0; index < maximumPages; index += 1) {
    const result = await client.query({
      ...request,
      ...(cursor === null ? {} : { cursor }),
      ...(pointerToken === null ? {} : { pointerToken }),
    }, { signal });
    if (result.outcome !== "page") return result;
    validatePageForRequest(result, request);
    if (pointerToken !== null && result.pointerToken !== pointerToken) {
      throw new ArchiveTransportError("the archive changed catalog snapshot while paging");
    }
    if (fingerprint !== null && result.queryFingerprint !== fingerprint) {
      throw new ArchiveTransportError("the archive changed query identity while paging");
    }
    const previous = pages.at(-1);
    if (previous !== undefined && !sameCoverage(previous.coverage, result.coverage)) {
      throw new ArchiveTransportError("the archive changed coverage while paging");
    }
    if (previous !== undefined && !servedContinues(previous.coverage.served, result.coverage.served)) {
      throw new ArchiveTransportError("the archive served pages out of order");
    }
    pages.push(result);
    pointerToken = result.pointerToken;
    fingerprint = result.queryFingerprint;
    if (result.nextCursor === null) {
      return Object.freeze({
        outcome: "page" as const,
        rows: Object.freeze(pages.flatMap((page) => page.rows)),
        nextCursor: null,
        pointerToken,
        queryFingerprint: fingerprint,
        family: result.family,
        coverage: Object.freeze({ ...pages[0].coverage, served: combinedServed(pages) }),
        scan: combineArchiveScan(pages),
      });
    }
    if (result.nextCursor.length === 0) {
      throw new ArchiveTransportError("the archive returned an empty cursor");
    }
    cursor = result.nextCursor;
  }
  throw new ArchiveTransportError("the archive page budget was exhausted before the requested window completed");
}
