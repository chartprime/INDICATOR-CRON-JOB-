import { ArchiveTransportError } from "./archiveClient";

export const HISTORICAL_L2_CONTRACT = "historical-l2-query/1";
export const HISTORICAL_L2_PATH = "/archive/l2";
export const HISTORICAL_L2_MAX_BYTES = 4 * 1024 * 1024;
export class HistoricalL2RequestError extends ArchiveTransportError {
  readonly code: string;

  constructor(code: string, status: number) {
    super(`historical L2 request refused: ${code}`, status);
    this.name = "HistoricalL2RequestError";
    this.code = code;
  }
}
export const HISTORICAL_L2_PROFILES: readonly string[] = [
  ["XCME", "FUTURE", "ESU6", "USD", "CONTRACT"], ["XCME", "FUTURE", "NQU6", "USD", "CONTRACT"],
  ["XNAS", "EQUITY", "AAPL", "USD", "SHARE"], ["XNAS", "EQUITY", "TSLA", "USD", "SHARE"],
].map((fields) => JSON.stringify(fields));

export type HistoricalL2Family = "states" | "events" | "walls" | "prints";
export type HistoricalL2Session = Readonly<{ instrument_id: string; date: string; state: "AVAILABLE" | "UNAVAILABLE"; reason: string }>;
export type HistoricalL2Catalog = Readonly<{ operation: "catalog"; releaseId: string; snapshotToken: string;
  depthLimit: 10; inference: string; sessions: readonly HistoricalL2Session[];
  indexes?: readonly Readonly<{ family: "walls" | "prints"; instrument_id: string; date: string }>[] }>;
export type HistoricalL2Row = Readonly<Record<string, unknown> & { schema: string; instrument_id: string;
  derivation_id: string; append_position: string; known_ns: string; known_key: readonly string[] | null;
  payload: Readonly<Record<string, unknown>> }>;
export type HistoricalL2Query = Readonly<{ snapshotToken: string; instrumentId: string; date: string;
  family: HistoricalL2Family; from: string; to: string; asOfKey: readonly string[];
  limit?: number; cursor?: string | null; maxScanBytes?: number }>;
export type HistoricalL2Page = Readonly<{ operation: "page"; releaseId: string; snapshotToken: string;
  instrumentId: string; date: string; family: HistoricalL2Family; from: string; to: string; asOfKey: readonly string[];
  derivationId: string; depthLimit: 10; tickSize: string; quantityUnit: "CONTRACT" | "SHARE";
  rows: readonly HistoricalL2Row[]; nextCursor: string | null; truncatedBy: "rows" | "bytes" | "scan" | null;
  scan: Readonly<Record<string, number>>; wallProfileId?: string; wallProfile?: Readonly<Record<string, unknown>> }>;

const SHA = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const DATE = /^2026-08-(0[1-9]|[12][0-9]|3[01])$/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const decimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value)
  && BigInt(value) <= 18446744073709551615n;
const sha = (value: unknown): value is string => typeof value === "string" && SHA.test(value);
const token = (value: unknown): value is string => typeof value === "string" && TOKEN.test(value);
const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const COMMON_ROW_FIELDS = ["schema", "instrument_id", "derivation_id", "append_position", "known_ns", "known_key", "payload"];
const STATE_ROW_FIELDS = [...COMMON_ROW_FIELDS, "record_id", "family"];
const WALL_ROW_FIELDS = [...COMMON_ROW_FIELDS, "record_id"];
const EVENT_ROW_FIELDS = [...COMMON_ROW_FIELDS, "segment_id", "event_id", "event_seq", "event_type", "source_ns", "observed_engine_ms",
  "engine_seq", "side", "price_key", "observation_id", "lifecycle_id", "record_evidence_gap", "evidence_quality"];
const PAGE_RESPONSE_FIELDS = ["contractVersion", "operation", "releaseId", "snapshotToken", "instrumentId", "date", "family", "from", "to",
  "asOfKey", "derivationId", "depthLimit", "tickSize", "quantityUnit", "rows", "nextCursor", "truncatedBy", "scan"];
const exactFields = (value: Record<string, unknown>, fields: readonly string[]) => Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));

function finite(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (typeof value === "number") return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (Array.isArray(value)) return value.length <= 4096 && value.every((v) => finite(v, depth + 1));
  if (record(value)) return Object.keys(value).length <= 128 && Object.values(value).every((v) => finite(v, depth + 1));
  return value === null || typeof value === "string" || typeof value === "boolean";
}

function cutAllows(key: readonly string[], cut: readonly string[]): boolean {
  for (let i = 0; i < 4; i += 1) {
    if (BigInt(key[i]) > BigInt(cut[i])) return false;
    if (BigInt(key[i]) < BigInt(cut[i])) return true;
  }
  return true;
}

function validRowShape(row: Record<string, unknown>, family: HistoricalL2Family): boolean {
  if (!exactFields(row, family === "states" ? STATE_ROW_FIELDS : family === "walls" || family === "prints" ? WALL_ROW_FIELDS : EVENT_ROW_FIELDS)) return false;
  if (family === "prints") return row.schema === "historical-l2-print-record/1" && sha(row.record_id) && record(row.payload)
    && row.payload.schema === "historical-l2-source-print/1" && row.payload.known_ns === row.known_ns;
  if (family === "walls") return row.schema === "historical-l2-wall-record/1" && sha(row.record_id) && record(row.payload)
    && ["historical-l2-wall-view/2", "historical-l2-wall-segment-end/2"].includes(String(row.payload.schema))
    && sha(row.payload.profile_id) && row.payload.known_ns === row.known_ns;
  if (family === "states") return row.schema === "historical-l2-second/1" && sha(row.record_id)
    && typeof row.family === "string" && ["l2_level_state_1s", "l2_book_segment"].includes(row.family);
  return row.schema === "historical-l2-level-event/1" && sha(row.segment_id) && sha(row.event_id) && typeof row.event_type === "string"
    && natural(row.event_seq) && natural(row.observed_engine_ms) && (row.engine_seq === null || natural(row.engine_seq))
    && decimal(row.source_ns) && decimal(row.known_ns) && BigInt(row.source_ns) <= BigInt(row.known_ns)
    && (row.side === null || row.side === "bid" || row.side === "ask") && (row.price_key === null || natural(row.price_key))
    && typeof row.record_evidence_gap === "boolean" && (row.evidence_quality === "resting_unknown" || row.evidence_quality === "observed_depth_inference")
    && ["observation_id", "lifecycle_id"].every((key) => row[key] === null || sha(row[key]));
}

function validQuery(query: HistoricalL2Query): boolean {
  if (!HISTORICAL_L2_PROFILES.includes(query.instrumentId) || !DATE.test(query.date) || !token(query.snapshotToken)
      || !["states", "events", "walls", "prints"].includes(query.family) || !decimal(query.from) || !decimal(query.to)
      || query.asOfKey.length !== 4 || !query.asOfKey.every(decimal)) return false;
  const start = BigInt(Date.parse(`${query.date}T00:00:00Z`)) * 1000000n;
  return BigInt(query.from) >= start && BigInt(query.to) <= start + 86400000000001n
    && BigInt(query.to) > BigInt(query.from) && BigInt(query.to) - BigInt(query.from) <= 3600000000000n
    && BigInt(query.asOfKey[0]) < BigInt(query.to)
    && (query.limit === undefined || natural(query.limit) && query.limit > 0 && query.limit <= 10000)
    && (query.maxScanBytes === undefined || natural(query.maxScanBytes) && query.maxScanBytes > 0 && query.maxScanBytes <= 67108864)
    && (query.cursor === undefined || query.cursor === null || /^[A-Za-z0-9_-]{1,512}$/.test(query.cursor));
}

function parseCatalog(body: Record<string, unknown>): HistoricalL2Catalog {
  if (!exactFields(body, ["contractVersion", "operation", "releaseId", "snapshotToken", "depthLimit", "inference", "sessions", ...(body.indexes === undefined ? [] : ["indexes"])])
      || body.operation !== "catalog" || !sha(body.releaseId) || !token(body.snapshotToken) || body.depthLimit !== 10
      || body.inference !== "top-ten depth inference; not order-level cancellation truth"
      || !Array.isArray(body.sessions) || body.sessions.length !== 124) throw new ArchiveTransportError("invalid historical L2 catalog");
  const seen = new Set<string>();
  for (const row of body.sessions) {
    if (!record(row) || !exactFields(row, ["instrument_id", "date", "state", "reason"]) || typeof row.instrument_id !== "string" || !HISTORICAL_L2_PROFILES.includes(row.instrument_id)
        || typeof row.date !== "string" || !DATE.test(row.date) || typeof row.state !== "string" || !["AVAILABLE", "UNAVAILABLE"].includes(row.state)
        || typeof row.reason !== "string" || row.reason.length === 0 || row.reason.length > 128) throw new ArchiveTransportError("invalid historical L2 coverage");
    seen.add(`${row.instrument_id}/${row.date}`);
  }
  if (seen.size !== 124) throw new ArchiveTransportError("duplicate historical L2 coverage");
  if (body.indexes !== undefined) {
    if (!Array.isArray(body.indexes) || body.indexes.length > 248) throw new ArchiveTransportError("invalid historical index coverage");
    const indexed = new Set<string>();
    for (const row of body.indexes) {
      if (!record(row) || !exactFields(row, ["family", "instrument_id", "date"]) || !["walls", "prints"].includes(String(row.family))
          || !body.sessions.some((session) => record(session) && session.instrument_id === row.instrument_id && session.date === row.date && session.state === "AVAILABLE")) throw new ArchiveTransportError("invalid historical index coverage");
      indexed.add(`${row.family}/${row.instrument_id}/${row.date}`);
    }
    if (indexed.size !== body.indexes.length) throw new ArchiveTransportError("duplicate historical index coverage");
  }
  return body as unknown as HistoricalL2Catalog;
}

function parsePage(body: Record<string, unknown>, query: HistoricalL2Query): HistoricalL2Page {
  const profile = JSON.parse(query.instrumentId) as string[];
  if (!exactFields(body, query.family === "walls" ? [...PAGE_RESPONSE_FIELDS, "wallProfile", "wallProfileId"] : PAGE_RESPONSE_FIELDS) || body.operation !== "page" || !sha(body.releaseId) || body.snapshotToken !== query.snapshotToken
      || body.instrumentId !== query.instrumentId || body.date !== query.date || body.family !== query.family
      || body.from !== query.from || body.to !== query.to || JSON.stringify(body.asOfKey) !== JSON.stringify(query.asOfKey)
      || !sha(body.derivationId) || body.depthLimit !== 10 || body.tickSize !== (profile[1] === "FUTURE" ? "0.25" : "0.01")
      || body.quantityUnit !== profile[4] || !Array.isArray(body.rows) || body.rows.length > (query.limit ?? 1000)
      || ![null, "rows", "bytes", "scan"].includes(body.truncatedBy as string | null)
      || (body.nextCursor === null) !== (body.truncatedBy === null)
      || body.nextCursor !== null && (typeof body.nextCursor !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(body.nextCursor))
      || !record(body.scan)) throw new ArchiveTransportError("invalid historical L2 page");
  if (query.family === "walls" && (!record(body.wallProfile) || !finite(body.wallProfile) || !sha(body.wallProfileId))) throw new ArchiveTransportError("invalid historical wall profile");
  let previous = -1n;
  for (const row of body.rows) {
    if (!record(row) || !validRowShape(row, query.family) || !decimal(row.append_position) || BigInt(row.append_position) <= previous
        || row.schema !== (query.family === "states" ? "historical-l2-second/1" : query.family === "walls" ? "historical-l2-wall-record/1" : query.family === "prints" ? "historical-l2-print-record/1" : "historical-l2-level-event/1")
        || row.instrument_id !== query.instrumentId || row.derivation_id !== body.derivationId || !decimal(row.known_ns)
        || BigInt(row.known_ns) < BigInt(query.from) || BigInt(row.known_ns) >= BigInt(query.to) || !record(row.payload)
        || !finite(row.payload)) throw new ArchiveTransportError("invalid historical L2 row");
    if (row.known_key === null) {
      if (query.family !== "states" && !(query.family === "walls" && row.payload.schema === "historical-l2-wall-segment-end/2")) throw new ArchiveTransportError("missing historical L2 knowledge key");
    } else if (!Array.isArray(row.known_key) || row.known_key.length !== 4 || !row.known_key.every(decimal)
      || !cutAllows(row.known_key, query.asOfKey) || BigInt(row.known_key[0]) > BigInt(row.known_ns)) {
      throw new ArchiveTransportError("historical L2 row precedes its evidence or exceeds the cut");
    }
    if (query.family === "events" && row.source_ns !== row.known_key![0]) throw new ArchiveTransportError("historical L2 source key differs");
    if (["walls", "prints"].includes(query.family) && BigInt(row.known_ns) > BigInt(query.asOfKey[0])) throw new ArchiveTransportError("historical indexed sample exceeds knowledge cut");
    if (query.family === "walls" && row.payload.profile_id !== body.wallProfileId) throw new ArchiveTransportError("historical wall profile differs");
    previous = BigInt(row.append_position);
  }
  const scan = body.scan;
  if (!["scanBytes", "partsOpened", "bytesRead", "cacheHits", "cacheMisses"].every((key) => natural(scan[key]))
      || Number(scan.scanBytes) > (query.maxScanBytes ?? 67108864)
      || !["fetchMs", "queryMs"].every((key) => typeof scan[key] === "number" && Number.isFinite(scan[key]) && Number(scan[key]) >= 0)) {
    throw new ArchiveTransportError("invalid historical L2 scan metrics");
  }
  return body as unknown as HistoricalL2Page;
}

async function boundedBody(response: Response): Promise<string> {
  if (response.body === null) throw new ArchiveTransportError("missing historical L2 response body");
  const stream = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await stream.read();
      if (done) break;
      size += value.byteLength;
      if (size > HISTORICAL_L2_MAX_BYTES) {
        await stream.cancel();
        throw new ArchiveTransportError("historical L2 response exceeds the byte limit");
      }
      chunks.push(value);
    }
  } finally { stream.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function createHistoricalL2Client({ token: bearer, fetchImpl = fetch, path = HISTORICAL_L2_PATH }:
  { token: string; fetchImpl?: typeof fetch; path?: string }) {
  if (!bearer) throw new Error("historical L2 bearer token required");
  async function send(body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await fetchImpl(path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ ...body, contractVersion: HISTORICAL_L2_CONTRACT }), signal });
    let parsed: unknown;
    try { parsed = JSON.parse(await boundedBody(response)); }
    catch (error) { if (signal?.aborted) throw error; throw new ArchiveTransportError("invalid or oversized historical L2 response", response.status); }
    if (!record(parsed) || parsed.contractVersion !== HISTORICAL_L2_CONTRACT) throw new ArchiveTransportError("historical L2 contract mismatch", response.status);
    if (!response.ok) throw new HistoricalL2RequestError(typeof parsed.error === "string" && /^[A-Z_]{1,64}$/.test(parsed.error)
      ? parsed.error : "UNKNOWN", response.status);
    return parsed;
  }
  const catalog = async ({ signal }: { signal?: AbortSignal } = {}): Promise<HistoricalL2Catalog> => parseCatalog(await send({ operation: "catalog" }, signal));
  const page = async (query: HistoricalL2Query, { signal }: { signal?: AbortSignal } = {}): Promise<HistoricalL2Page> => {
    if (!validQuery(query)) throw new ArchiveTransportError("invalid historical L2 request");
    return parsePage(await send({ ...query, operation: "page" }, signal), query);
  };
  async function* pages(query: HistoricalL2Query, { signal }: { signal?: AbortSignal } = {}): AsyncGenerator<HistoricalL2Page> {
    const cursors = new Set<string>();
    let cursor = query.cursor, release: string | null = null, last = -1n, count = 0, profileId: string | undefined;
    for (let index = 0; index < 128; index += 1) {
      if (signal?.aborted) throw new DOMException("Historical L2 request cancelled", "AbortError");
      const result = await page({ ...query, cursor }, { signal });
      if (release !== null && result.releaseId !== release) throw new ArchiveTransportError("historical L2 release changed while paging");
      release = result.releaseId;
      if (index > 0 && result.wallProfileId !== profileId) throw new ArchiveTransportError("historical wall profile changed while paging");
      profileId = result.wallProfileId;
      for (const row of result.rows) {
        if (BigInt(row.append_position) <= last) throw new ArchiveTransportError("historical L2 pages repeat or regress");
        last = BigInt(row.append_position);
      }
      count += result.rows.length;
      if (count > 100000) throw new ArchiveTransportError("historical L2 window exceeds the row limit");
      if (result.nextCursor !== null && cursors.has(result.nextCursor)) throw new ArchiveTransportError("historical L2 cursor does not progress");
      yield result;
      if (result.nextCursor === null) return;
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new ArchiveTransportError("historical L2 window exceeds the page limit");
  }
  async function window(query: HistoricalL2Query, { signal, maxRows = 100000, maxBytes = 32 * 1024 * 1024 }:
    { signal?: AbortSignal; maxRows?: number; maxBytes?: number } = {}): Promise<HistoricalL2Page> {
    if (!natural(maxRows) || maxRows < 1 || maxRows > 100000 || !natural(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) {
      throw new ArchiveTransportError("invalid historical L2 client budget");
    }
    const rows: HistoricalL2Row[] = [];
    let size = 0;
    for await (const result of pages(query, { signal })) {
      size += new TextEncoder().encode(JSON.stringify(result.rows)).length;
      if (rows.length + result.rows.length > maxRows || size > maxBytes) throw new ArchiveTransportError("historical L2 window exceeds the chart budget; select a smaller window");
      rows.push(...result.rows);
      if (result.nextCursor === null) return { ...result, rows };
    }
    throw new ArchiveTransportError("historical L2 window exceeds the page limit");
  }
  return { catalog, page, pages, window };
}
