"use strict";

const http = require("node:http");
const { createHash } = require("node:crypto");
const { createArchiveAuth } = require("../../src/server/archive-auth");
const { createHistoricalL2Route, validateRequest, validResponse, CONTRACT_VERSION, PROFILES } = require("../../src/server/historical-l2-route");

const catalogRequest = { contractVersion: CONTRACT_VERSION, operation: "catalog" };
const pageRequest = { contractVersion: CONTRACT_VERSION, operation: "page", snapshotToken: "a".repeat(32),
  instrumentId: PROFILES[0], date: "2026-08-05", family: "events", from: "1785888000000000000",
  to: "1785888001000000000", asOfKey: ["1785888000999999999", "2", "999", "0"] };

function catalogPage() {
  return { ...catalogRequest, releaseId: "a".repeat(64), snapshotToken: "a".repeat(32), depthLimit: 10,
    inference: "top-ten depth inference; not order-level cancellation truth",
    sessions: PROFILES.flatMap((instrument_id) => Array.from({ length: 31 }, (_, i) => ({
      instrument_id, date: `2026-08-${String(i + 1).padStart(2, "0")}`, state: "UNAVAILABLE", reason: "NOT_YET_QUALIFIED",
    }))) };
}

function page() {
  return { ...pageRequest, releaseId: "a".repeat(64), derivationId: "b".repeat(64), depthLimit: 10,
    tickSize: "0.25", quantityUnit: "CONTRACT", rows: [], nextCursor: null, truncatedBy: null,
    scan: { scanBytes: 0, partsOpened: 0, bytesRead: 0, cacheHits: 0, cacheMisses: 0, fetchMs: 0, queryMs: 0 } };
}

test("advertises only distinct indexes for available sessions", () => {
  const body = catalogPage();
  body.sessions[4].state = "AVAILABLE";
  const entry = { family: "walls", instrument_id: PROFILES[0], date: "2026-08-05" };
  body.indexes = [entry, { ...entry, family: "prints" }];
  expect(validResponse(200, body, catalogRequest)).toBe(true);
  body.indexes.push(entry);
  expect(validResponse(200, body, catalogRequest)).toBe(false);
  body.indexes = [{ ...entry, date: "2026-08-06" }];
  expect(validResponse(200, body, catalogRequest)).toBe(false);
});

test("binds wall settings to their hash and refuses knowledge after the cut", () => {
  const request = { ...pageRequest, family: "walls" };
  const wallProfile = { tick_size: "0.25", sample_ms: 1000, tracker: { minSize: 40 } };
  const wallProfileId = createHash("sha256").update(JSON.stringify(wallProfile)).digest("hex");
  const row = { schema: "historical-l2-wall-record/1", instrument_id: request.instrumentId, derivation_id: "b".repeat(64),
    append_position: "0", known_ns: request.from, known_key: [request.from, "2", "1", "0"], record_id: "d".repeat(64),
    payload: { schema: "historical-l2-wall-view/2", profile_id: wallProfileId, known_ns: request.from } };
  const body = { ...page(), family: "walls", rows: [row], wallProfile, wallProfileId };
  expect(validResponse(200, body, request)).toBe(true);
  expect(validResponse(200, { ...body, wallProfile: { ...wallProfile, sample_ms: 500 } }, request)).toBe(false);
  expect(validResponse(200, { ...body, rows: [{ ...row, known_ns: request.asOfKey[0], payload: { ...row.payload, known_ns: request.asOfKey[0] } }] },
    { ...request, asOfKey: [(BigInt(request.asOfKey[0]) - 1n).toString(), "2", "999", "0"] })).toBe(false);
});

test.each([
  { ...pageRequest, from: "0" }, { ...pageRequest, family: [] }, { ...pageRequest, limit: true },
  { ...pageRequest, to: "18446744073709551616" }, { ...pageRequest, asOfKey: ["1", "2"] },
  { ...pageRequest, cursor: "?" }, { ...catalogRequest, extra: 1 },
])("rejects malformed requests before forwarding: %j", (body) => {
  expect(validateRequest(body)?.error).toBe("MALFORMED_REQUEST");
});

test("accepts the documented catalog and bounded page requests", () => {
  expect(validateRequest(catalogRequest)).toBeNull();
  expect(validateRequest(pageRequest)).toBeNull();
  expect(validResponse(200, catalogPage(), catalogRequest)).toBe(true);
  expect(validResponse(200, page(), pageRequest)).toBe(true);
});

test("rejects duplicate coverage, wrong identity, unordered rows and future evidence", () => {
  const catalog = catalogPage();
  catalog.sessions[1] = catalog.sessions[0];
  expect(validResponse(200, catalog, catalogRequest)).toBe(false);
  const row = { schema: "historical-l2-level-event/1", segment_id: "c".repeat(64), event_id: "d".repeat(64), event_seq: 1,
    event_type: "segment_open", source_ns: pageRequest.from, observed_engine_ms: 1785888000000, engine_seq: null,
    side: null, price_key: null, observation_id: null, lifecycle_id: null, record_evidence_gap: false, evidence_quality: "resting_unknown",
    instrument_id: pageRequest.instrumentId, derivation_id: "b".repeat(64),
    append_position: "10", known_ns: pageRequest.from, known_key: [pageRequest.from, "2", "1", "0"], payload: {} };
  expect(validResponse(200, { ...page(), rows: [row] }, pageRequest)).toBe(true);
  for (const rows of [[row, row], [{ ...row, known_ns: pageRequest.to }],
    [{ ...row, known_key: [pageRequest.to, "2", "1", "0"] }], [{ ...row, instrument_id: PROFILES[1] }],
    [{ ...row, extra: "unexpected" }], [{ ...row, schema: "unexpected" }], [{ ...row, payload: { value: 9007199254740992 } }]]) {
    expect(validResponse(200, { ...page(), rows }, pageRequest)).toBe(false);
  }
});

test("uses existing authenticated gateway with L2 validation and private upstream identity", async () => {
  const token = "b".repeat(24);
  const calls = [];
  const route = createHistoricalL2Route({
    auth: createArchiveAuth({ clientTokens: `viewer:${token}` }), serviceUrl: "http://127.0.0.1:8004/query",
    serviceSecret: "private-service-secret", log: () => {},
    fetchImpl: async (_url, options) => {
      calls.push(options);
      return new Response(JSON.stringify(catalogPage()), { status: 200 });
    },
  });
  const server = http.createServer((req, res) => {
    if (!route.handle(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/archive/l2`;
  try {
    const send = (body, authenticated = true) => fetch(url, { method: "POST", body: JSON.stringify(body),
      headers: authenticated ? { authorization: `Bearer ${token}` } : {} });
    const unauthorised = await send(catalogRequest, false);
    expect(unauthorised.status).toBe(401);
    expect((await unauthorised.json()).contractVersion).toBe(CONTRACT_VERSION);
    expect((await send({ ...catalogRequest, extra: 1 })).status).toBe(400);
    expect(calls).toHaveLength(0);
    const response = await send(catalogRequest);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(catalogPage());
    expect(calls[0].headers["x-archive-client"]).toBe("viewer");
    expect(calls[0].headers["x-archive-service-secret"]).toBe("private-service-secret");
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(route.stats().inFlight).toBe(0);
  } finally {
    route.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("bad service configuration refuses the correct route with the L2 contract", () => {
  const route = createHistoricalL2Route({ serviceUrl: "https://external.example/query", log: () => {} });
  let status, body;
  const res = { writeHead: (value) => { status = value; }, end: (value) => { body = JSON.parse(value); } };
  expect(route.handle({ url: "/archive/query" }, res)).toBe(false);
  expect(route.handle({ url: "/archive/l2" }, res)).toBe(true);
  expect(status).toBe(503);
  expect(body.contractVersion).toBe(CONTRACT_VERSION);
});
