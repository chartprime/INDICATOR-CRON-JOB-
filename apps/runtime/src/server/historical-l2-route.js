"use strict";

const { createArchiveRouteOrRefuse, REFUSAL_STATUS } = require("./archive-route");
const { createHash } = require("node:crypto");

const CONTRACT_VERSION = "historical-l2-query/1";
const ROUTE_PATH = "/archive/l2";
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;
const SHA = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const DATE = /^2026-08-(0[1-9]|[12][0-9]|3[01])$/;
const PROFILES = Object.freeze([
  ["XCME", "FUTURE", "ESU6", "USD", "CONTRACT"],
  ["XCME", "FUTURE", "NQU6", "USD", "CONTRACT"],
  ["XNAS", "EQUITY", "AAPL", "USD", "SHARE"],
  ["XNAS", "EQUITY", "TSLA", "USD", "SHARE"],
].map((fields) => JSON.stringify(fields)));
const PAGE_FIELDS = new Set(["contractVersion", "operation", "snapshotToken", "instrumentId", "date", "family",
  "from", "to", "asOfKey", "limit", "cursor", "maxScanBytes"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const decimal = (value) => typeof value === "string" && DECIMAL.test(value) && BigInt(value) <= 18446744073709551615n;
const bounded = (value, maximum) => Number.isSafeInteger(value) && value >= 1 && value <= maximum;
const refusal = (reason) => ({ contractVersion: CONTRACT_VERSION, error: "MALFORMED_REQUEST", detail: reason });
const COMMON_ROW_FIELDS = ["schema", "instrument_id", "derivation_id", "append_position", "known_ns", "known_key", "payload"];
const STATE_ROW_FIELDS = [...COMMON_ROW_FIELDS, "record_id", "family"];
const WALL_ROW_FIELDS = [...COMMON_ROW_FIELDS, "record_id"];
const EVENT_ROW_FIELDS = [...COMMON_ROW_FIELDS, "segment_id", "event_id", "event_seq", "event_type", "source_ns", "observed_engine_ms",
  "engine_seq", "side", "price_key", "observation_id", "lifecycle_id", "record_evidence_gap", "evidence_quality"];
const PAGE_RESPONSE_FIELDS = ["contractVersion", "operation", "releaseId", "snapshotToken", "instrumentId", "date", "family", "from", "to",
  "asOfKey", "derivationId", "depthLimit", "tickSize", "quantityUnit", "rows", "nextCursor", "truncatedBy", "scan"];
const exactFields = (value, fields) => object(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
const natural = (value) => Number.isSafeInteger(value) && value >= 0;
function finite(value, depth = 0) {
  if (depth > 16) return false;
  if (typeof value === "number") return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (Array.isArray(value)) return value.length <= 4096 && value.every((item) => finite(item, depth + 1));
  if (object(value)) return Object.keys(value).length <= 128 && Object.values(value).every((item) => finite(item, depth + 1));
  return value === null || typeof value === "string" || typeof value === "boolean";
}
function validRowShape(row, family) {
  if (!exactFields(row, family === "states" ? STATE_ROW_FIELDS : ["walls", "prints"].includes(family) ? WALL_ROW_FIELDS : EVENT_ROW_FIELDS) || !object(row.payload) || !finite(row.payload)) return false;
  if (family === "prints") return row.schema === "historical-l2-print-record/1" && SHA.test(row.record_id)
    && row.payload.schema === "historical-l2-source-print/1" && row.payload.known_ns === row.known_ns;
  if (family === "walls") return row.schema === "historical-l2-wall-record/1" && SHA.test(row.record_id)
    && ["historical-l2-wall-view/2", "historical-l2-wall-segment-end/2"].includes(row.payload.schema)
    && SHA.test(row.payload.profile_id) && row.payload.known_ns === row.known_ns;
  if (family === "states") return row.schema === "historical-l2-second/1" && typeof row.record_id === "string" && SHA.test(row.record_id)
    && ["l2_level_state_1s", "l2_book_segment"].includes(row.family);
  return row.schema === "historical-l2-level-event/1" && ["segment_id", "event_id"].every((key) => typeof row[key] === "string" && SHA.test(row[key]))
    && typeof row.event_type === "string" && natural(row.event_seq) && natural(row.observed_engine_ms)
    && (row.engine_seq === null || natural(row.engine_seq)) && decimal(row.source_ns) && decimal(row.known_ns)
    && BigInt(row.source_ns) <= BigInt(row.known_ns) && (row.side === null || ["bid", "ask"].includes(row.side))
    && (row.price_key === null || natural(row.price_key)) && typeof row.record_evidence_gap === "boolean"
    && ["resting_unknown", "observed_depth_inference"].includes(row.evidence_quality)
    && ["observation_id", "lifecycle_id"].every((key) => row[key] === null || typeof row[key] === "string" && SHA.test(row[key]));
}

function validateRequest(body) {
  if (!object(body) || body.contractVersion !== CONTRACT_VERSION) return refusal("CONTRACT_VERSION_MISMATCH");
  if (body.operation === "catalog") {
    return Object.keys(body).length === 2 ? null : refusal("UNKNOWN_CATALOG_FIELDS");
  }
  if (body.operation !== "page" || Object.keys(body).some((key) => !PAGE_FIELDS.has(key))
      || !PROFILES.includes(body.instrumentId) || !DATE.test(body.date) || typeof body.date !== "string"
      || !["states", "events", "walls", "prints"].includes(body.family) || typeof body.snapshotToken !== "string" || !TOKEN.test(body.snapshotToken)
      || !decimal(body.from) || !decimal(body.to) || !Array.isArray(body.asOfKey)
      || body.asOfKey.length !== 4 || !body.asOfKey.every(decimal)) return refusal("INVALID_PAGE_FIELDS");
  const start = BigInt(Date.parse(`${body.date}T00:00:00Z`)) * 1000000n;
  if (BigInt(body.to) <= BigInt(body.from) || BigInt(body.to) - BigInt(body.from) > 3600000000000n
      || BigInt(body.from) < start || BigInt(body.to) > start + 86400000000001n
      || BigInt(body.asOfKey[0]) >= BigInt(body.to)) return refusal("INVALID_WINDOW_OR_KNOWLEDGE_CUT");
  if ("limit" in body && !bounded(body.limit, 10000)
      || "maxScanBytes" in body && !bounded(body.maxScanBytes, 67108864)
      || "cursor" in body && body.cursor !== null && (typeof body.cursor !== "string"
        || !/^[A-Za-z0-9_-]{1,512}$/.test(body.cursor))) return refusal("INVALID_PAGE_BUDGET_OR_CURSOR");
  return null;
}

function validResponse(status, body, request) {
  if (!object(body) || body.contractVersion !== CONTRACT_VERSION) return false;
  if (status !== 200) {
    return typeof body.error === "string" && REFUSAL_STATUS[body.error] === status && Object.keys(body).every((key) =>
      ["contractVersion", "error", "detail", "retryAfterMs"].includes(key))
      && (!("detail" in body) || typeof body.detail === "string" && body.detail.length <= 512)
      && (!("retryAfterMs" in body) || bounded(body.retryAfterMs, Number.MAX_SAFE_INTEGER));
  }
  if (body.operation !== request.operation || typeof body.releaseId !== "string" || !SHA.test(body.releaseId)
      || typeof body.snapshotToken !== "string" || !TOKEN.test(body.snapshotToken) || body.depthLimit !== 10) return false;
  if (request.operation === "catalog") {
    if (body.inference !== "top-ten depth inference; not order-level cancellation truth"
        || !Array.isArray(body.sessions) || body.sessions.length !== 124
        || Object.keys(body).some((key) => !["contractVersion", "operation", "releaseId", "snapshotToken", "depthLimit", "inference", "sessions", "indexes"].includes(key))) return false;
    const seen = new Set();
    for (const row of body.sessions) {
      if (!object(row) || !PROFILES.includes(row.instrument_id) || typeof row.date !== "string" || !DATE.test(row.date)
          || !["AVAILABLE", "UNAVAILABLE"].includes(row.state) || typeof row.reason !== "string" || row.reason.length < 1
          || row.reason.length > 128 || Object.keys(row).length !== 4) return false;
      seen.add(`${row.instrument_id}/${row.date}`);
    }
    if (body.indexes !== undefined) {
      if (!Array.isArray(body.indexes) || body.indexes.length > 248) return false;
      const indexed = new Set();
      for (const row of body.indexes) {
        if (!exactFields(row, ["family", "instrument_id", "date"]) || !["walls", "prints"].includes(row.family)
            || !body.sessions.some((session) => session.instrument_id === row.instrument_id && session.date === row.date && session.state === "AVAILABLE")) return false;
        indexed.add(`${row.family}/${row.instrument_id}/${row.date}`);
      }
      if (indexed.size !== body.indexes.length) return false;
    }
    return seen.size === 124;
  }
  if (!exactFields(body, request.family === "walls" ? [...PAGE_RESPONSE_FIELDS, "wallProfile", "wallProfileId"] : PAGE_RESPONSE_FIELDS) || body.snapshotToken !== request.snapshotToken || body.instrumentId !== request.instrumentId || body.date !== request.date
      || body.family !== request.family || body.from !== request.from || body.to !== request.to
      || JSON.stringify(body.asOfKey) !== JSON.stringify(request.asOfKey) || !SHA.test(body.derivationId)
      || body.tickSize !== (JSON.parse(request.instrumentId)[1] === "FUTURE" ? "0.25" : "0.01")
      || body.quantityUnit !== JSON.parse(request.instrumentId)[4] || !Array.isArray(body.rows)
      || body.rows.length > (request.limit ?? 1000) || ![null, "rows", "bytes", "scan"].includes(body.truncatedBy)
      || (body.nextCursor === null) !== (body.truncatedBy === null)
      || body.nextCursor !== null && (typeof body.nextCursor !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(body.nextCursor))
      || !object(body.scan)) return false;
  if (request.family === "walls" && (!object(body.wallProfile) || !finite(body.wallProfile) || !SHA.test(body.wallProfileId)
      || createHash("sha256").update(JSON.stringify(body.wallProfile)).digest("hex") !== body.wallProfileId)) return false;
  let previous = -1n;
  for (const row of body.rows) {
    if (!validRowShape(row, request.family) || !decimal(row.append_position) || BigInt(row.append_position) <= previous
        || row.instrument_id !== request.instrumentId || row.derivation_id !== body.derivationId
        || !decimal(row.known_ns) || BigInt(row.known_ns) < BigInt(request.from) || BigInt(row.known_ns) >= BigInt(request.to)
        || !object(row.payload)) return false;
    if (row.known_key !== null) {
      if (!Array.isArray(row.known_key) || row.known_key.length !== 4 || !row.known_key.every(decimal)
          || BigInt(row.known_key[0]) > BigInt(row.known_ns)) return false;
      for (let index = 0; index < 4; index += 1) {
        if (BigInt(row.known_key[index]) > BigInt(request.asOfKey[index])) return false;
        if (BigInt(row.known_key[index]) < BigInt(request.asOfKey[index])) break;
      }
    } else if (request.family !== "states" && !(request.family === "walls" && row.payload.schema === "historical-l2-wall-segment-end/2")) return false;
    if (["walls", "prints"].includes(request.family) && BigInt(row.known_ns) > BigInt(request.asOfKey[0])) return false;
    if (request.family === "walls" && row.payload.profile_id !== body.wallProfileId) return false;
    if (request.family === "events" && row.source_ns !== row.known_key[0]) return false;
    previous = BigInt(row.append_position);
  }
  return ["scanBytes", "partsOpened", "bytesRead", "cacheHits", "cacheMisses"].every((key) =>
    Number.isSafeInteger(body.scan[key]) && body.scan[key] >= 0)
    && body.scan.scanBytes <= (request.maxScanBytes ?? 67108864)
    && ["fetchMs", "queryMs"].every((key) => Number.isFinite(body.scan[key]) && body.scan[key] >= 0);
}

function createHistoricalL2Route(options = {}) {
  return createArchiveRouteOrRefuse({ ...options,
    serviceUrl: options.serviceUrl ?? process.env.TT_L2_ARCHIVE_SERVICE_URL,
    routePath: ROUTE_PATH, contractVersion: CONTRACT_VERSION,
    requestValidator: validateRequest, responseValidator: validResponse, maxResponseBytes: 4194304,
  }, options.log ?? console.error);
}

module.exports = { createHistoricalL2Route, validateRequest, validResponse, CONTRACT_VERSION, ROUTE_PATH, PROFILES };
