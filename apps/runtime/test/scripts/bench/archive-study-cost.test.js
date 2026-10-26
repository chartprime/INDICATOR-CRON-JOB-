"use strict";

const http = require("node:http");
const zlib = require("node:zlib");
const {
  parseArgs,
  validatePlan,
  deltas,
  runBench,
  summarize,
  BenchError,
} = require("../../../scripts/bench/archive-study-cost");

const TOKEN = "bench-token-that-must-never-appear-in-a-report";
const ES_SEGMENT = {
  instrumentId: '["XCME","FUTURE","ESU6","USD","CONTRACT"]',
  fromTs: "2026-06-17T00:00:00Z",
  toTs: "2026-09-01T00:00:00Z",
};

function plan(
  runs = [
    {
      id: "es.profile.day",
      instrument: "ES",
      study: "volume_profile",
      ranges: [
        { fromTs: "2026-08-04T00:00:00Z", toTs: "2026-08-05T00:00:00Z" },
      ],
      options: { mode: "continuous", binSizeMultiplier: 1 },
    },
  ],
) {
  return {
    instruments: [
      {
        id: "ES",
        assetClass: "FUTURE",
        tickSize: 0.25,
        segments: [ES_SEGMENT],
      },
    ],
    fenceProbe: {
      instrumentId: ES_SEGMENT.instrumentId,
      family: "trade",
      fromTs: "2026-08-04T13:30:00Z",
      toTs: "2026-08-04T13:31:00Z",
    },
    runs,
  };
}

function fakeHost({
  pagesPerStudy = 5,
  chartQueriesDuring = {},
  overloadFirst = false,
} = {}) {
  const state = {
    route: 0,
    study: 0,
    paced: 0,
    served: 0,
    downloads: 0,
    seenAuth: [],
    overloaded: false,
  };
  const archive = () => ({
    telemetry: {
      stages: {
        serviceMs: { count: state.served, totalMs: state.served * 10 },
        downloadMs: { count: state.downloads, totalMs: 0 },
        cacheLookupMs: { count: state.served, totalMs: 0 },
        queryMs: { count: state.served, totalMs: state.served * 4 },
      },
    },
  });
  const send = (response, status, body) => {
    const zipped = zlib.gzipSync(Buffer.from(JSON.stringify(body)));
    response.writeHead(status, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": String(zipped.length),
    });
    response.end(zipped);
  };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      state.seenAuth.push(request.headers.authorization ?? null);
      if (request.method === "GET" && request.url === "/health") {
        send(response, 200, {
          ready: true,
          route: { admitted: state.route },
          study: {
            admitted: state.study,
            pacedWaits: state.paced,
            timedOut: 0,
            failed: 0,
          },
        });
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (request.url === "/archive/query") {
        state.route += 1;
        state.served += 1;
        send(response, 200, {
          pointer: { publisher_fence: 50, dataset_version: "v3" },
          rows: [],
        });
        return;
      }
      if (overloadFirst && !state.overloaded) {
        state.overloaded = true;
        send(response, 429, {
          contractVersion: "archive-study/1",
          error: "OVERLOADED",
          reason: "ONE_STUDY_PER_CLIENT",
          retryAfterMs: 5,
        });
        return;
      }
      state.study += 1;
      state.served += pagesPerStudy;
      state.downloads += 2;
      state.paced += 1;
      const extraChart = chartQueriesDuring[body.requestId] ?? 0;
      state.route += extraChart;
      state.served += extraChart;
      send(response, 200, {
        contractVersion: "archive-study/1",
        study: body.study,
        requestId: body.requestId,
        missing: [],
        complete: true,
        profiles: [
          {
            buckets: Array.from({ length: 40 }, (_, index) => ({
              price: 6000 + index,
              volume: 1,
            })),
          },
        ],
      });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        state,
        archive,
        server,
        base: `http://127.0.0.1:${server.address().port}`,
      }),
    ),
  );
}

describe("archive-study-cost arguments", () => {
  const env = {
    TT_ARCHIVE_PROXY_URL: "http://10.88.0.1:8001",
    VITE_ARCHIVE_CLIENT_TOKEN: TOKEN,
  };
  const base = [
    "--plan",
    "p.json",
    "--out",
    "o.json",
    "--archive-health-cmd",
    "ssh host curl",
  ];

  test("the token comes only from the environment and the gateway must be a bare origin", () => {
    expect(parseArgs(base, env)).toMatchObject({
      base: "http://10.88.0.1:8001",
      token: TOKEN,
      passes: 2,
    });
    expect(() => parseArgs([...base, "--token", "x"], env)).toThrow(
      "unknown argument --token",
    );
    expect(() =>
      parseArgs(base, { TT_ARCHIVE_PROXY_URL: env.TT_ARCHIVE_PROXY_URL }),
    ).toThrow("must be set in the environment");
    expect(() =>
      parseArgs(base, {
        ...env,
        TT_ARCHIVE_PROXY_URL: "http://user:pw@10.88.0.1:8001",
      }),
    ).toThrow("without credentials");
    expect(() =>
      parseArgs(base, {
        ...env,
        TT_ARCHIVE_PROXY_URL: "http://10.88.0.1:8001/archive",
      }),
    ).toThrow("without credentials or a path");
    expect(() =>
      parseArgs(["--plan", "p.json", "--out", "o.json"], env),
    ).toThrow("--archive-health-cmd is required");
    expect(() => parseArgs([...base, "--passes", "9"], env)).toThrow(
      "--passes",
    );
  });
});

describe("archive-study-cost plan", () => {
  test("ISO times become epoch milliseconds and the request carries the instrument's roll segments", () => {
    const { runs, fenceProbe } = validatePlan(plan());
    expect(runs[0].request).toMatchObject({
      study: "volume_profile",
      symbol: "ES",
      assetClass: "FUTURE",
      tickSize: 0.25,
      ranges: [
        {
          fromTs: Date.parse("2026-08-04T00:00:00Z"),
          toTs: Date.parse("2026-08-05T00:00:00Z"),
        },
      ],
      segments: [
        {
          instrumentId: ES_SEGMENT.instrumentId,
          fromTs: Date.parse(ES_SEGMENT.fromTs),
          toTs: Date.parse(ES_SEGMENT.toTs),
        },
      ],
    });
    expect(fenceProbe.fromTs).toBe(Date.parse("2026-08-04T13:30:00Z"));
  });

  test.each([
    [
      "an unaligned range",
      {
        ranges: [
          { fromTs: "2026-08-04T00:00:30Z", toTs: "2026-08-05T00:00:00Z" },
        ],
      },
      "minute-aligned",
    ],
    ["an undeclared instrument", { instrument: "NQ" }, "not declared"],
    ["an unknown study", { study: "footprint" }, "study is invalid"],
    [
      "an empty window",
      {
        ranges: [
          { fromTs: "2026-08-04T00:00:00Z", toTs: "2026-08-04T00:00:00Z" },
        ],
      },
      "end after it starts",
    ],
  ])("refuses %s", (_label, override, message) => {
    const [run] = plan().runs;
    expect(() => validatePlan(plan([{ ...run, ...override }]))).toThrow(
      message,
    );
  });

  test("refuses a duplicate run id", () => {
    const [run] = plan().runs;
    expect(() => validatePlan(plan([run, run]))).toThrow(BenchError);
  });
});

describe("archive-study-cost attribution", () => {
  const snapshot = (served, route, downloads = 0) => ({
    archive: {
      "serviceMs.count": served,
      "serviceMs.totalMs": served,
      "downloadMs.count": downloads,
      "cacheLookupMs.count": served,
      "queryMs.totalMs": 0,
    },
    gateway: {
      chartQueries: route,
      studyAdmitted: 0,
      studyPacedWaits: 0,
      studyTimedOut: 0,
      studyFailed: 0,
    },
  });

  test("study queries are the archive's admissions minus the gateway's own chart queries", () => {
    expect(deltas(snapshot(100, 10), snapshot(135, 10, 4))).toMatchObject({
      valid: true,
      attribution: "exact",
      archiveQueries: 35,
      chartQueries: 0,
      s3Downloads: 4,
    });
    expect(deltas(snapshot(100, 10), snapshot(137, 12))).toMatchObject({
      valid: true,
      attribution: "shared",
      archiveQueries: 35,
      chartQueries: 2,
    });
  });

  test("a restarted service is reported as unattributable, never as a negative cost", () => {
    expect(deltas(snapshot(100, 10), snapshot(3, 0))).toEqual({
      valid: false,
      reason: "COUNTERS_WENT_BACKWARDS_SERVICE_RESTARTED",
    });
  });
});

describe("archive-study-cost run", () => {
  let host;
  afterEach(async () => {
    if (host) await new Promise((resolve) => host.server.close(resolve));
    host = null;
  });

  test("measures wire and JSON bytes, attributes pages per run, retries the route's own overload and keeps the token out of the report", async () => {
    host = await fakeHost({
      pagesPerStudy: 7,
      chartQueriesDuring: { 3: 2 },
      overloadFirst: true,
    });
    const [run] = plan().runs;
    const result = await runBench({
      plan: plan([
        { ...run, expect: { complete: true, status: 200 } },
        { ...run, id: "es.profile.day.again", expect: { complete: false } },
      ]),
      base: host.base,
      token: TOKEN,
      passes: 1,
      timeoutMs: 5_000,
      scrapeArchive: async () => host.archive(),
      sleep: async () => {},
    });
    const [first, second] = result.records;
    expect(result.fenceBefore).toEqual({
      status: 200,
      publisherFence: 50,
      datasetVersion: "v3",
    });
    expect(first).toMatchObject({
      status: 200,
      complete: true,
      routeRetries: 1,
      gzip: true,
      payload: { profiles: 1, profileRows: 40 },
      expectationMet: true,
    });
    expect(first.wireBytes).toBeLessThan(first.jsonBytes);
    expect(first.host).toMatchObject({
      valid: true,
      attribution: "exact",
      archiveQueries: 7,
      s3Downloads: 2,
      pacedWaits: 1,
    });
    expect(second.host).toMatchObject({
      attribution: "shared",
      archiveQueries: 7,
      chartQueries: 2,
    });
    expect(second.expectationMet).toBe(false);
    expect(summarize(result.records)).toMatchObject({
      expectationsFailed: ["es.profile.day.again#1"],
      sharedAttribution: ["es.profile.day.again#1"],
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(
      host.state.seenAuth
        .filter((value) => value !== null)
        .every((value) => value === `Bearer ${TOKEN}`),
    ).toBe(true);
  });
});
