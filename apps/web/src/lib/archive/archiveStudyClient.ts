import type {
  FrameIdentity,
  MarkerFrame,
  ProfileFrame,
  VpinReading,
} from "../../types/frames";

export const ARCHIVE_STUDY_PATH = "/archive/study";
export const ARCHIVE_STUDY_CONTRACT_VERSION = "archive-study/1";
export const ARCHIVE_MIN_BIN_SIZE_MULTIPLIER = 0.1;

export type ArchiveStudy =
  | "volume_profile"
  | "vpin"
  | "large_prints"
  | "bar_flow";

export type ArchiveStudySegment = Readonly<{
  instrumentId: string;
  fromTs: number;
  toTs: number;
}>;
export type ArchiveStudyRange = Readonly<{ fromTs: number; toTs: number }>;

export type ArchiveStudyRequest = Readonly<{
  requestId: number;
  study: ArchiveStudy;
  symbol: string;
  assetClass: "FUTURE" | "EQUITY" | "SPOT" | "PERPETUAL";
  tickSize: number;
  segments: readonly ArchiveStudySegment[];
  ranges: readonly ArchiveStudyRange[];
  pointerToken?: string;
  options?: Readonly<{
    mode?: ProfileFrame["mode"];
    binSizeMultiplier?: number;
    bucketMs?: number;
  }>;
}>;

export type ArchivePrint = Readonly<{
  ts_exchange: number;
  price: number;
  size: number;
  side: "buy" | "sell";
}>;
export type ArchiveBarFlow = Readonly<{
  ts_open: number;
  volume: number;
  buy_volume: number;
  sell_volume: number;
  unknown_volume: number;
  trade_count: number;
}>;
export type ArchiveProfile = Omit<
  ProfileFrame,
  | "type"
  | "symbol"
  | "provider"
  | "marketKind"
  | "assetClass"
  | "period_start_ts"
  | "period_end_ts"
> &
  Readonly<{ period_start_ts: number; period_end_ts: number }>;

export type ArchiveStudyResult =
  | Readonly<{
      outcome: "volume_profile";
      profiles: readonly ArchiveProfile[];
      missing: readonly ArchiveStudyRange[];
      empty: readonly ArchiveStudyRange[];
      complete: boolean;
    }>
  | Readonly<{
      outcome: "vpin";
      readings: readonly VpinReading[];
      missing: readonly ArchiveStudyRange[];
      complete: boolean;
    }>
  | Readonly<{
      outcome: "large_prints";
      prints: readonly ArchivePrint[];
      missing: readonly ArchiveStudyRange[];
      complete: boolean;
    }>
  | Readonly<{
      outcome: "bar_flow";
      bars: readonly ArchiveBarFlow[];
      missing: readonly ArchiveStudyRange[];
      complete: boolean;
    }>
  | Readonly<{
      outcome: "refused";
      code: string;
      reason: string | null;
      status: number;
      retryAfterMs: number | null;
    }>;

export class ArchiveStudyTransportError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ArchiveStudyTransportError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function epoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function ranges(value: unknown): readonly ArchiveStudyRange[] | null {
  if (!Array.isArray(value)) return null;
  const out: ArchiveStudyRange[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !epoch(entry.fromTs) ||
      !epoch(entry.toTs) ||
      entry.toTs <= entry.fromTs
    )
      return null;
    out.push({ fromTs: entry.fromTs, toTs: entry.toTs });
  }
  return out;
}

function profile(value: unknown, requestId: number): ArchiveProfile | null {
  if (!isRecord(value)) return null;
  const {
    mode,
    delivery_scope: scope,
    history_request_id: historyId,
    period_start_ts: start,
    period_end_ts: end,
  } = value;
  if (mode !== "continuous" && mode !== "per_candle" && mode !== "fixed_range")
    return null;
  if (
    scope !== "HISTORICAL" ||
    historyId !== requestId ||
    !epoch(start) ||
    !epoch(end) ||
    end < start
  )
    return null;
  if (
    !finiteNonNegative(value.row_width) ||
    value.row_width === 0 ||
    !Array.isArray(value.buckets) ||
    value.buckets.length === 0
  )
    return null;
  let previous = -Infinity;
  const buckets = [];
  for (const bucket of value.buckets) {
    if (
      !isRecord(bucket) ||
      !finiteNonNegative(bucket.price) ||
      bucket.price <= previous ||
      !finiteNonNegative(bucket.volume) ||
      !finiteNonNegative(bucket.buy_volume) ||
      !finiteNonNegative(bucket.sell_volume) ||
      typeof bucket.single_print !== "boolean"
    )
      return null;
    previous = bucket.price;
    buckets.push({
      price: bucket.price,
      volume: bucket.volume,
      buy_volume: bucket.buy_volume,
      sell_volume: bucket.sell_volume,
      single_print: bucket.single_print,
    });
  }
  const prices = new Set(buckets.map((bucket) => bucket.price));
  for (const key of ["poc_price", "vah_price", "val_price"] as const) {
    if (!finiteNonNegative(value[key]) || !prices.has(value[key] as number))
      return null;
  }
  return {
    mode,
    delivery_scope: "HISTORICAL",
    history_request_id: requestId,
    period_start_ts: start,
    period_end_ts: end,
    row_width: value.row_width,
    buckets,
    poc_price: value.poc_price as number,
    vah_price: value.vah_price as number,
    val_price: value.val_price as number,
  };
}

function reading(value: unknown): VpinReading | null {
  if (
    !isRecord(value) ||
    !epoch(value.seal_ts) ||
    typeof value.active !== "boolean"
  )
    return null;
  const direction = value.direction;
  if (direction !== "buy" && direction !== "sell" && direction !== null)
    return null;
  if (
    typeof value.strength !== "number" ||
    value.strength < 0 ||
    value.strength > 1
  )
    return null;
  for (const key of ["z_vpin", "z_velocity", "z_acceleration"] as const) {
    if (
      value[key] !== null &&
      (typeof value[key] !== "number" || !Number.isFinite(value[key]))
    )
      return null;
  }
  if (value.activated_at_ts !== null && !epoch(value.activated_at_ts))
    return null;
  return {
    seal_ts: value.seal_ts,
    active: value.active,
    direction,
    strength: value.strength,
    z_vpin: value.z_vpin as number | null,
    z_velocity: value.z_velocity as number | null,
    z_acceleration: value.z_acceleration as number | null,
    activated_at_ts: value.activated_at_ts as number | null,
  };
}

function print(value: unknown): ArchivePrint | null {
  if (
    !isRecord(value) ||
    !epoch(value.ts_exchange) ||
    !finiteNonNegative(value.price) ||
    value.price === 0 ||
    !finiteNonNegative(value.size) ||
    value.size === 0 ||
    (value.side !== "buy" && value.side !== "sell")
  )
    return null;
  return {
    ts_exchange: value.ts_exchange,
    price: value.price,
    size: value.size,
    side: value.side,
  };
}

function barFlow(value: unknown): ArchiveBarFlow | null {
  if (!isRecord(value) || !epoch(value.ts_open)) return null;
  for (const key of [
    "volume",
    "buy_volume",
    "sell_volume",
    "unknown_volume",
  ] as const) {
    if (!finiteNonNegative(value[key])) return null;
  }
  const {
    volume,
    buy_volume: buy,
    sell_volume: sell,
    unknown_volume: unknown,
  } = value as Record<string, number>;
  if (buy + sell > volume + 1e-6) return null;
  if (Math.abs(buy + sell + unknown - volume) > 1e-6) return null;
  if (
    !Number.isSafeInteger(value.trade_count) ||
    (value.trade_count as number) < 0
  )
    return null;
  return {
    ts_open: value.ts_open,
    volume,
    buy_volume: buy,
    sell_volume: sell,
    unknown_volume: unknown,
    trade_count: value.trade_count as number,
  };
}

function all<T>(
  values: unknown,
  parse: (value: unknown) => T | null,
): readonly T[] | null {
  if (!Array.isArray(values)) return null;
  const out: T[] = [];
  for (const value of values) {
    const parsed = parse(value);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

function toResult(
  body: Record<string, unknown>,
  request: ArchiveStudyRequest,
): ArchiveStudyResult {
  if (
    body.study !== request.study ||
    body.requestId !== request.requestId ||
    typeof body.complete !== "boolean"
  ) {
    throw new ArchiveStudyTransportError(
      "the archive answered a different study than was asked",
    );
  }
  const missing = ranges(body.missing);
  if (missing === null)
    throw new ArchiveStudyTransportError(
      "the archive study reported malformed missing ranges",
    );
  if (body.complete !== (missing.length === 0)) {
    throw new ArchiveStudyTransportError(
      "the archive study completion flag contradicts its missing ranges",
    );
  }
  const requested = (fromTs: number, toTs: number): boolean =>
    request.ranges.some(
      (range) => fromTs >= range.fromTs && toTs <= range.toTs,
    );
  if (missing.some((range) => !requested(range.fromTs, range.toTs))) {
    throw new ArchiveStudyTransportError(
      "the archive study reported a missing range that was not requested",
    );
  }
  if (request.study === "volume_profile") {
    const profiles = all(body.profiles, (value) =>
      profile(value, request.requestId),
    );
    if (profiles === null)
      throw new ArchiveStudyTransportError(
        "the archive returned a profile outside the contract",
      );
    if (
      profiles.some(
        (entry) =>
          !request.ranges.some(
            (range) =>
              entry.period_start_ts === range.fromTs &&
              entry.period_end_ts === range.toTs,
          ),
      )
    ) {
      throw new ArchiveStudyTransportError(
        "the archive returned a profile outside the requested ranges",
      );
    }
    const empty = body.empty === undefined ? [] : ranges(body.empty);
    if (empty === null)
      throw new ArchiveStudyTransportError(
        "the archive study reported malformed empty ranges",
      );
    if (
      empty.some(
        (range) =>
          !request.ranges.some(
            (asked) =>
              asked.fromTs === range.fromTs && asked.toTs === range.toTs,
          ),
      )
    ) {
      throw new ArchiveStudyTransportError(
        "the archive study reported an empty range that was not requested",
      );
    }
    if (
      empty.some((range) =>
        profiles.some((entry) => entry.period_start_ts === range.fromTs),
      )
    ) {
      throw new ArchiveStudyTransportError(
        "the archive study reported a range as both empty and profiled",
      );
    }
    const key = (fromTs: number, toTs: number): string => `${fromTs}:${toTs}`;
    const classifications = [
      ...profiles.map((entry) =>
        key(entry.period_start_ts, entry.period_end_ts),
      ),
      ...empty.map((range) => key(range.fromTs, range.toTs)),
      ...missing.map((range) => key(range.fromTs, range.toTs)),
    ];
    const requestedKeys = request.ranges.map((range) =>
      key(range.fromTs, range.toTs),
    );
    if (
      new Set(classifications).size !== classifications.length ||
      classifications.length !== requestedKeys.length ||
      requestedKeys.some((rangeKey) => !classifications.includes(rangeKey))
    ) {
      throw new ArchiveStudyTransportError(
        "the archive study did not classify every profile range exactly once",
      );
    }
    return {
      outcome: "volume_profile",
      profiles,
      missing,
      empty,
      complete: body.complete,
    };
  }
  if (request.study === "vpin") {
    const readings = all(body.readings, reading);
    if (readings === null)
      throw new ArchiveStudyTransportError(
        "the archive returned a VPIN reading outside the contract",
      );
    for (let index = 1; index < readings.length; index += 1) {
      if (readings[index].seal_ts < readings[index - 1].seal_ts) {
        throw new ArchiveStudyTransportError(
          "the archive returned VPIN readings out of order",
        );
      }
    }
    if (
      readings.some((entry) => !requested(entry.seal_ts, entry.seal_ts + 1))
    ) {
      throw new ArchiveStudyTransportError(
        "the archive returned a VPIN reading outside the requested ranges",
      );
    }
    return { outcome: "vpin", readings, missing, complete: body.complete };
  }
  if (request.study === "bar_flow") {
    const bars = all(body.bars, barFlow);
    if (bars === null)
      throw new ArchiveStudyTransportError(
        "the archive returned a bar outside the contract",
      );
    for (let index = 0; index < bars.length; index += 1) {
      if (!requested(bars[index].ts_open, bars[index].ts_open + 1)) {
        throw new ArchiveStudyTransportError(
          "the archive returned a bar outside the requested ranges",
        );
      }
      if (index > 0 && bars[index].ts_open <= bars[index - 1].ts_open) {
        throw new ArchiveStudyTransportError(
          "the archive returned bars out of order",
        );
      }
    }
    return { outcome: "bar_flow", bars, missing, complete: body.complete };
  }
  const prints = all(body.prints, print);
  if (prints === null)
    throw new ArchiveStudyTransportError(
      "the archive returned a print outside the contract",
    );
  for (let index = 0; index < prints.length; index += 1) {
    if (!requested(prints[index].ts_exchange, prints[index].ts_exchange + 1)) {
      throw new ArchiveStudyTransportError(
        "the archive returned a print outside the requested ranges",
      );
    }
    if (
      index > 0 &&
      prints[index].ts_exchange < prints[index - 1].ts_exchange
    ) {
      throw new ArchiveStudyTransportError(
        "the archive returned prints out of order",
      );
    }
  }
  return { outcome: "large_prints", prints, missing, complete: body.complete };
}

export function createArchiveStudyClient({
  token,
  path = ARCHIVE_STUDY_PATH,
  fetchImpl = fetch,
}: {
  token: string;
  path?: string;
  fetchImpl?: typeof fetch;
}) {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("createArchiveStudyClient: a bearer token is required");
  }

  async function run(
    request: ArchiveStudyRequest,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<ArchiveStudyResult> {
    let response: Response;
    try {
      response = await fetchImpl(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          contractVersion: ARCHIVE_STUDY_CONTRACT_VERSION,
          ...request,
        }),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ArchiveStudyTransportError(
        `the archive could not be reached: ${(error as Error)?.message ?? "unknown error"}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new ArchiveStudyTransportError(
        "the archive returned a body that was not JSON",
        response.status,
      );
    }
    if (
      !isRecord(parsed) ||
      parsed.contractVersion !== ARCHIVE_STUDY_CONTRACT_VERSION
    ) {
      throw new ArchiveStudyTransportError(
        "the archive returned a body outside this contract",
        response.status,
      );
    }
    if (response.ok) return toResult(parsed, request);
    return {
      outcome: "refused",
      code:
        typeof parsed.error === "string" ? parsed.error : "READER_UNAVAILABLE",
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
      status: response.status,
      retryAfterMs: Number.isSafeInteger(parsed.retryAfterMs)
        ? (parsed.retryAfterMs as number)
        : null,
    };
  }

  return { run };
}

export function profileFrameFor(
  profileFields: ArchiveProfile,
  symbol: string,
  identity: FrameIdentity,
): ProfileFrame {
  return {
    type: "profile",
    symbol,
    ...identity,
    ...profileFields,
  } as ProfileFrame;
}

export function markerFrameFor(
  printFields: ArchivePrint,
  index: number,
  symbol: string,
  identity: FrameIdentity,
): MarkerFrame {
  return {
    type: "marker",
    symbol,
    ...identity,
    ts_exchange: printFields.ts_exchange,
    price: printFields.price,
    size: printFields.size,
    side: printFields.side,
    trade_id: `archive:${printFields.ts_exchange}:${printFields.side}:${index}`,
  } as MarkerFrame;
}
