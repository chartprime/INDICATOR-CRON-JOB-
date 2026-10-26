export const ARCHIVE_QUERY_PATH = "/archive/query";
export const ARCHIVE_CONTRACT_VERSION = "archive-query/1";
export const ARCHIVE_RESTART_HEADER = "x-archive-restart";

export type ArchiveFamily =
  | "candle" | "candle_1m" | "candle_1h" | "candle_1d" | "trade" | "quote" | "depth"
  | "trade_minute_1m" | "trade_level_1m" | "trade_slice_2s" | "trade_prints_1m";

export const ARCHIVE_FAMILIES: readonly ArchiveFamily[] = [
  "candle", "candle_1m", "candle_1h", "candle_1d", "trade", "quote", "depth",
  "trade_minute_1m", "trade_level_1m", "trade_slice_2s", "trade_prints_1m",
];

export const ARCHIVE_PAGE_FIELDS: readonly string[] = [
  "rows", "nextCursor", "pointerToken", "queryFingerprint", "family", "coverage", "scan",
];

export type ArchiveQuery = {
  instrumentId: string;
  family: ArchiveFamily;
  from: string;
  to: string;
  limit?: number;
  cursor?: string | null;
  maxScanBytes?: number;
  pointerToken?: string | null;
};

export type ArchiveRow = Readonly<Record<string, string | number | boolean | null | unknown[]>>;

export type ArchiveCoverage = {
  requested: { from: string; to: string };
  served: { from: string; to: string } | null;
  partitions: number;
  states: Readonly<Record<string, number>>;
  gaps?: ReadonlyArray<{ date: string; state: string }>;
  corrupt: ReadonlyArray<{ date: string; reason: string | null }>;
};

export const ARCHIVE_COVERAGE_STATES: readonly string[] = [
  "PUBLISHED", "QUIET", "MARKET_CLOSED", "MISSING", "QUARANTINED", "FAILED", "CORRUPT", "UNKNOWN",
];

const ARCHIVE_GAP_STATES: readonly string[] = ["MISSING", "QUARANTINED", "FAILED", "CORRUPT", "UNKNOWN"];
const EVENT_NS = /^(0|[1-9][0-9]{0,19})$/;
const CALENDAR_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const MAX_COVERAGE_ITEMS = 512;
const MAX_CORRUPT_REASON_LENGTH = 128;

export type ArchivePage = {
  outcome: "page";
  rows: readonly ArchiveRow[];
  nextCursor: string | null;
  pointerToken: string;
  queryFingerprint: string;
  family: ArchiveFamily;
  coverage: ArchiveCoverage;
  scan: Readonly<Record<string, number>>;
};

export type ArchiveRefusal = {
  outcome: "refused";
  code: string;
  detail: string | null;
  status: number;
  retryAfterMs: number | null;
};

export type ArchiveRestart = {
  outcome: "restart";
  code: string;
};

export type ArchiveResult = ArchivePage | ArchiveRefusal | ArchiveRestart;

export class ArchiveTransportError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ArchiveTransportError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isWindow(value: unknown): value is { from: string; to: string } {
  return isRecord(value) && onlyKeys(value, ["from", "to"])
    && typeof value.from === "string" && EVENT_NS.test(value.from)
    && typeof value.to === "string" && EVENT_NS.test(value.to)
    && BigInt(value.from) < BigInt(value.to);
}

function isBoundedList(value: unknown, isItem: (item: unknown) => boolean): value is unknown[] {
  return Array.isArray(value) && value.length <= MAX_COVERAGE_ITEMS && value.every(isItem);
}

function isGap(value: unknown): boolean {
  return isRecord(value) && onlyKeys(value, ["date", "state"])
    && typeof value.date === "string" && CALENDAR_DATE.test(value.date)
    && typeof value.state === "string" && ARCHIVE_GAP_STATES.includes(value.state);
}

function isCorruptEntry(value: unknown): boolean {
  return isRecord(value) && onlyKeys(value, ["date", "reason"])
    && typeof value.date === "string" && CALENDAR_DATE.test(value.date)
    && (value.reason === undefined || value.reason === null
      || (typeof value.reason === "string" && value.reason.length <= MAX_CORRUPT_REASON_LENGTH));
}

function parseCoverage(value: unknown): ArchiveCoverage | null {
  if (!isRecord(value) || !onlyKeys(value, ["requested", "served", "partitions", "states", "gaps", "corrupt"])) return null;
  const { requested, served, partitions, states, gaps, corrupt } = value;
  if (!isWindow(requested) || (served !== null && !isWindow(served))) return null;
  if (served !== null && (BigInt(served.from) < BigInt(requested.from) || BigInt(served.to) > BigInt(requested.to))) return null;
  if (typeof partitions !== "number" || !Number.isSafeInteger(partitions) || partitions < 0) return null;
  if (!isRecord(states) || !Object.entries(states).every(([state, count]) => ARCHIVE_COVERAGE_STATES.includes(state)
    && typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) return null;
  if (gaps !== undefined && !isBoundedList(gaps, isGap)) return null;
  if (corrupt !== undefined && !isBoundedList(corrupt, isCorruptEntry)) return null;
  return {
    requested,
    served,
    partitions,
    states: states as Readonly<Record<string, number>>,
    ...(gaps === undefined ? {} : { gaps: gaps as ReadonlyArray<{ date: string; state: string }> }),
    corrupt: ((corrupt ?? []) as ReadonlyArray<{ date: string; reason?: string | null }>).map((entry) => ({ date: entry.date, reason: entry.reason ?? null })),
  };
}

function readRetryAfter(body: Record<string, unknown>): number | null {
  const value = body.retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function toPage(body: Record<string, unknown>, expectedFamily: ArchiveFamily): ArchivePage {
  const { rows, nextCursor, pointerToken, queryFingerprint, family, coverage, scan } = body;
  if (!Array.isArray(rows) || typeof pointerToken !== "string"
      || typeof queryFingerprint !== "string" || typeof family !== "string"
      || !ARCHIVE_FAMILIES.includes(family as ArchiveFamily) || family !== expectedFamily
      || !isRecord(scan)
      || (nextCursor !== null && typeof nextCursor !== "string")) {
    throw new ArchiveTransportError("the archive returned a page that does not match the contract");
  }
  const parsedCoverage = parseCoverage(coverage);
  if (parsedCoverage === null) {
    throw new ArchiveTransportError("the archive returned coverage that does not match the contract");
  }
  return {
    outcome: "page",
    rows: rows as readonly ArchiveRow[],
    nextCursor,
    pointerToken,
    queryFingerprint,
    family: family as ArchiveFamily,
    coverage: parsedCoverage,
    scan: scan as Readonly<Record<string, number>>,
  };
}

export function createArchiveClient({
  token,
  path = ARCHIVE_QUERY_PATH,
  fetchImpl = fetch,
}: { token: string; path?: string; fetchImpl?: typeof fetch }) {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("createArchiveClient: a bearer token is required");
  }

  async function query(request: ArchiveQuery, { signal }: { signal?: AbortSignal } = {}): Promise<ArchiveResult> {
    const body: Record<string, unknown> = { contractVersion: ARCHIVE_CONTRACT_VERSION, ...request };
    for (const key of Object.keys(body)) {
      if (body[key] === undefined) delete body[key];
    }

    let response: Response;
    try {
      response = await fetchImpl(path, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ArchiveTransportError(
        `the archive could not be reached: ${(error as Error)?.message ?? "unknown error"}`);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new ArchiveTransportError("the archive returned a body that was not JSON", response.status);
    }
    if (!isRecord(parsed) || parsed.contractVersion !== ARCHIVE_CONTRACT_VERSION) {
      throw new ArchiveTransportError("the archive returned a body outside this contract", response.status);
    }

    if (response.ok) return toPage(parsed, request.family);

    const code = typeof parsed.error === "string" ? parsed.error : "READER_UNAVAILABLE";
    if (response.headers.get(ARCHIVE_RESTART_HEADER) === "1") {
      return { outcome: "restart", code };
    }
    return {
      outcome: "refused",
      code,
      detail: typeof parsed.detail === "string" ? parsed.detail : null,
      status: response.status,
      retryAfterMs: readRetryAfter(parsed),
    };
  }

  async function* pages(
    request: ArchiveQuery,
    { signal }: { signal?: AbortSignal } = {},
  ): AsyncGenerator<ArchivePage | ArchiveRestart> {
    let cursor: string | null = request.cursor ?? null;
    let pointerToken: string | null = request.pointerToken ?? null;
    for (;;) {
      const result = await query({ ...request, cursor, pointerToken }, { signal });
      if (result.outcome === "restart") {
        yield result;
        return;
      }
      if (result.outcome === "refused") {
        throw new ArchiveTransportError(
          `the archive refused the query: ${result.code}`, result.status);
      }
      yield result;
      if (result.nextCursor === null) return;
      cursor = result.nextCursor;
      pointerToken = result.pointerToken;
    }
  }

  return { query, pages };
}
