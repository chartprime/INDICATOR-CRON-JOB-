const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRecorder, createLogTail, summarize, slopePerHour, parseArgs } = require("../../../scripts/bench/health-recorder");

function healthBody({ max = 12, p99 = 8, rss = 400, heap = 150 } = {}) {
  return {
    runtime: { eventLoopMaxDelayMs: max, eventLoopP99DelayMs: p99, processRssBytes: rss * 1024 * 1024, processHeapUsedBytes: heap * 1024 * 1024 },
    readiness: { warmups: { "binance.spot.btcusdt.large_trades": { state: "READY" }, "binance.spot.btcusdt.vpin": { state: "RUNNING" } } },
  };
}

function fakeFetch(bodies) {
  let index = 0;
  return jest.fn(async () => {
    const body = bodies[Math.min(index, bodies.length - 1)];
    index += 1;
    if (body === null) throw new Error("ECONNREFUSED");
    return { status: 200, json: async () => body };
  });
}

describe("health recorder (Block 8 soak evidence)", () => {
  test("a one-second stall that falls between 30 s windows is still caught, because every 1 s window is read", async () => {
    let clock = 0;
    const written = [];
    const bodies = Array.from({ length: 30 }, (_, i) => healthBody({ max: i === 17 ? 1_450 : 15 }));
    const recorder = createRecorder({ fetchImpl: fakeFetch(bodies), clock: () => clock, write: (r) => written.push(r), windowMs: 30_000 });
    for (let i = 0; i < 30; i += 1) {
      clock += 1_000;
      await recorder.poll();
    }
    expect(written.filter((r) => r.kind === "stall")).toEqual([{ kind: "stall", at: new Date(18_000).toISOString(), delayMs: 1_450, gcCountDelta: 0, gcMsDelta: 0 }]);
    const window = written.find((r) => r.kind === "window");
    expect(window).toMatchObject({ probes: 30, failures: 0, maxEventLoopDelayMs: 1_450, rssMiB: 400, heapMiB: 150, readiness: { large_trades: "READY", vpin: "RUNNING" } });
  });

  test("one monitor sample read by two polls is one stall, not two (Block 8: 01:35 was counted twice)", async () => {
    let clock = 0;
    const written = [];
    const stalled = { ...healthBody({ max: 1_113 }), runtime: { ...healthBody({ max: 1_113 }).runtime, eventLoopSamples: 44, gcCount: 10, gcTotalDurationMs: 5 } };
    const later = { ...healthBody({ max: 1_113 }), runtime: { ...healthBody({ max: 1_113 }).runtime, eventLoopSamples: 45, gcCount: 12, gcTotalDurationMs: 905 } };
    const before = { ...healthBody(), runtime: { ...healthBody().runtime, eventLoopSamples: 43, gcCount: 10, gcTotalDurationMs: 5 } };
    const recorder = createRecorder({ fetchImpl: fakeFetch([before, stalled, stalled, later]), clock: () => clock, write: (r) => written.push(r), windowMs: 60_000 });
    for (let i = 0; i < 4; i += 1) {
      clock += 1_000;
      await recorder.poll();
    }
    expect(written.filter((r) => r.kind === "stall")).toEqual([
      expect.objectContaining({ delayMs: 1_113, gcCountDelta: 0, gcMsDelta: 0 }),
      expect.objectContaining({ delayMs: 1_113, gcCountDelta: 2, gcMsDelta: 900 }),
    ]);
  });

  test("a 503 is a reachable runtime whose selected route is not ready: counted apart from failures, with the host request rate", async () => {
    let clock = 0;
    const written = [];
    const withReads = (requests, rateLimited) => ({ ...healthBody(), runtime: { ...healthBody().runtime, hostReads: { requests, rateLimited } } });
    const statuses = [200, 503, 503, 200];
    const bodies = [withReads(150, 0), withReads(420, 3), withReads(300, 0), withReads(160, 0)];
    let index = 0;
    const fetchImpl = async () => {
      const current = index;
      index += 1;
      return { status: statuses[current], json: async () => bodies[current] };
    };
    const recorder = createRecorder({ fetchImpl, clock: () => clock, write: (r) => written.push(r), windowMs: 4_000 });
    for (let i = 0; i < 4; i += 1) {
      clock += 1_000;
      await recorder.poll();
    }
    const window = written.find((r) => r.kind === "window");
    expect(window).toMatchObject({ probes: 4, failures: 0, routeNotReady: 2, hostReadsPerMin: 420, hostRateLimitedPerMin: 3 });
    expect(summarize(written)).toMatchObject({ probeFailures: 0, routeNotReadyMinutes: 0, hostReadsPeakPerMin: 420, hostRateLimitedPeakPerMin: 3 });
  });

  test("a runtime that stops answering is counted as failed probes, not as a healthy quiet window", async () => {
    let clock = 0;
    const written = [];
    const recorder = createRecorder({ fetchImpl: fakeFetch([healthBody(), null, null]), clock: () => clock, write: (r) => written.push(r), windowMs: 3_000 });
    for (let i = 0; i < 3; i += 1) {
      clock += 1_000;
      await recorder.poll();
    }
    expect(written.find((r) => r.kind === "window")).toMatchObject({ probes: 3, failures: 2 });
  });

  test("the log tail counts new WARN lines and keeps each new ERR line's text, and never re-reads what it has seen", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-recorder-log-"));
    try {
      const now = Date.UTC(2026, 8, 25, 12);
      const file = path.join(dir, "ws-server-2026-09-25.log");
      fs.writeFileSync(file, "12:00:00 INFO ok  runId a\n12:00:01 WARN book paused  runId a\n12:00:02 ERR  worker failed  runId a\n");
      const tail = createLogTail({ logDir: dir });
      expect(tail(now)).toEqual({ warn: 1, errors: ["12:00:02 ERR  worker failed"] });
      expect(tail(now)).toEqual({ warn: 0, errors: [] });
      fs.appendFileSync(file, "12:00:05 ERR  second  runId a\npartial line without newline");
      expect(tail(now)).toEqual({ warn: 0, errors: ["12:00:05 ERR  second"] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a soak starts at the end of an existing daily log, but captures new lines", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-recorder-log-"));
    try {
      const now = Date.UTC(2026, 8, 25, 12);
      const file = path.join(dir, "ws-server-2026-09-25.log");
      fs.writeFileSync(file, "11:59:59 ERR  earlier session\n");
      const tail = createLogTail({ logDir: dir, skipExistingOnStart: true });
      expect(tail(now)).toEqual({ warn: 0, errors: [] });
      fs.appendFileSync(file, "12:00:01 ERR  current session\n");
      expect(tail(now)).toEqual({ warn: 0, errors: ["12:00:01 ERR  current session"] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the summary adds hours across sessions and reports stalls, memory trend and distinct errors", () => {
    const hour = 3_600_000;
    const windowAt = (fromMs, rss) => ({
      kind: "window", from: new Date(fromMs).toISOString(), to: new Date(fromMs + hour).toISOString(),
      probes: 3600, failures: 0, maxEventLoopDelayMs: 40, maxEventLoopP99Ms: 9, maxProbeMs: 12,
      rssMiB: rss, heapMiB: 150, warnLines: 2, errLines: 0, readiness: {},
    });
    const summary = summarize([
      windowAt(0, 400), windowAt(hour, 402), windowAt(2 * hour, 404),
      { kind: "stall", at: "x", delayMs: 1_200 },
      { kind: "error_line", at: "x", text: "12:00:00 ERR  worker failed" },
      { kind: "error_line", at: "y", text: "13:00:00 ERR  worker failed" },
      windowAt(10 * hour, 404),
    ]);
    expect(summary).toMatchObject({
      hoursRecorded: 4, windows: 4, stallsOver1s: 1, worstEventLoopDelayMs: 40, warnLines: 8, errLines: 2,
      distinctErrors: ["ERR  worker failed"],
      rssMiB: { first: 400, last: 404, max: 404 },
    });
    expect(slopePerHour([[0, 400], [3_600_000, 402]])).toBe(2);
  });

  test("arguments are checked", () => {
    expect(parseArgs(["record", "--url", "http://127.0.0.1:18001/health", "--window-s", "10"])).toMatchObject({ mode: "record", windowS: 10 });
    expect(parseArgs(["summary", "a.jsonl", "b.jsonl"]).files).toEqual(["a.jsonl", "b.jsonl"]);
    expect(() => parseArgs(["record", "--window-s", "0"])).toThrow(/positive/);
    expect(() => parseArgs(["summary"])).toThrow(/at least one file/);
    expect(() => parseArgs(["watch"])).toThrow(/usage/);
  });
});
