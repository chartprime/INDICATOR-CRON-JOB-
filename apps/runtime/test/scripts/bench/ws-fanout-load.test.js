"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { safeRm } = require("../../helpers/temp-files");
const { icebergOptionsFromEnv } = require("../../../src/indicators/iceberg/iceberg-indicator");

const ICEBERG_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fanout-bench-icebergs-"));
process.env.L2_ICEBERG_STORE_DIR = ICEBERG_STORE_DIR;
afterAll(() => safeRm(ICEBERG_STORE_DIR, { recursive: true, force: true }));
test("the iceberg store env points at this suite temp dir before any server boots", () => {
  expect(icebergOptionsFromEnv().storeDir).toBe(ICEBERG_STORE_DIR);
});

const {
  runFanout, validateFanoutManifest, latencySummary, main, gapBefore, observeTradeId, seededRandom, createTradeGenerator, producerKeptUp, createLatencyHistogram,
} = require("../../../scripts/bench/ws-fanout-load");

const manifestOf = (overrides = {}) => ({
  version: 1, kind: "ws-fanout", name: "test", clients: 3, warmupMs: 200, durationMs: 1_000,
  upstream: { tradesPerPulse: 10, pulseMs: 20 },
  ...overrides,
});

describe("scripts/bench/ws-fanout-load", () => {
  beforeAll(() => {
    jest.spyOn(console, "info").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterAll(() => jest.restoreAllMocks());

  describe("manifest validation", () => {
    test("accepts a minimal manifest and one with every optional section", () => {
      expect(() => validateFanoutManifest(manifestOf())).not.toThrow();
      expect(() => validateFanoutManifest(manifestOf({
        sampleEveryMs: 100,
        slowClients: { count: 1, pauseAfterMs: 100, resumeAfterMs: 500, stopAfterEviction: true },
        server: { clientBufferSoftBytes: 1_000, clientBufferHardBytes: 2_000, clientBufferGraceMs: 0 },
      }))).not.toThrow();
    });

    test.each([
      ["a wrong kind", { kind: "live-storage" }, /kind/],
      ["an unknown top-level key", { extra: 1 }, /unknown keys extra/],
      ["no name", { name: "" }, /name/],
      ["zero clients", { clients: 0 }, /clients/],
      ["too many clients", { clients: 65 }, /clients/],
      ["a too-short duration", { durationMs: 99 }, /durationMs/],
      ["a fractional warmup", { warmupMs: 1.5 }, /warmupMs/],
      ["an unbounded trade rate", { upstream: { tradesPerPulse: 401, pulseMs: 20 } }, /tradesPerPulse/],
      ["a too-fast pulse", { upstream: { tradesPerPulse: 1, pulseMs: 4 } }, /pulseMs/],
      ["unknown upstream keys", { upstream: { tradesPerPulse: 1, pulseMs: 20, burst: 9 } }, /unknown keys burst/],
      ["every client slow", { slowClients: { count: 3, pauseAfterMs: 0 } }, /at least one client must stay healthy/],
      ["a pause after the run ends", { slowClients: { count: 1, pauseAfterMs: 1_001 } }, /pauseAfterMs/],
      ["a resume before the pause", { slowClients: { count: 1, pauseAfterMs: 500, resumeAfterMs: 500 } }, /resumeAfterMs/],
      ["a non-boolean stopAfterEviction", { slowClients: { count: 1, pauseAfterMs: 0, stopAfterEviction: "yes" } }, /stopAfterEviction/],
      ["unknown server options", { server: { wsHeartbeatMs: 1 } }, /unknown keys wsHeartbeatMs/],
      ["a hard limit below the soft limit", { server: { clientBufferSoftBytes: 2_000, clientBufferHardBytes: 1_000 } }, /clientBufferHardBytes/],
    ])("rejects %s", (_label, overrides, pattern) => {
      expect(() => validateFanoutManifest(manifestOf(overrides))).toThrow(pattern);
    });

    test("an invalid manifest fails before any server or temp directory is created", async () => {
      const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("ws-fanout-")).length;
      await expect(runFanout({ manifest: manifestOf({ clients: 0 }) })).rejects.toThrow(/clients/);
      expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("ws-fanout-")).length).toBe(before);
    });
  });

  test("nearest-rank latency summary of an empty and a populated sample", () => {
    expect(latencySummary([])).toEqual({ samples: 0, p50: null, p95: null, p99: null, max: null });
    expect(latencySummary([5, 1, 4, 2, 3])).toEqual({ samples: 5, p50: 3, p95: 5, p99: 5, max: 5 });
  });

  describe("latency histogram", () => {
    const fill = (values, maxMs) => {
      const histogram = createLatencyHistogram(maxMs);
      for (const value of values) histogram.record(value);
      return histogram;
    };

    test("an empty histogram summarises to nulls", () => {
      expect(createLatencyHistogram().summary()).toEqual({ samples: 0, p50: null, p95: null, p99: null, max: null });
    });

    test("matches the exact nearest-rank summary of the raw samples for whole-millisecond latencies", () => {
      const random = seededRandom(11);
      for (let round = 0; round < 200; round += 1) {
        const count = 1 + Math.floor(random() * 300);
        const values = Array.from({ length: count }, () => Math.floor(random() * random() * 900));
        expect(fill(values, 1_000).summary()).toEqual(latencySummary(values));
      }
    });

    test("counts samples beyond the cap in an overflow bucket and still reports the exact maximum", () => {
      const summary = fill([5, 7, 250, 40_000], 100).summary();
      expect(summary).toEqual({ samples: 4, p50: 7, p95: 40_000, p99: 40_000, max: 40_000 });
    });

    test("negative values are clamped to zero rather than corrupting the counts", () => {
      expect(fill([-3, 4], 100).summary()).toEqual({ samples: 2, p50: 0, p95: 4, p99: 4, max: 4 });
    });

    test("merging equals recording everything into one histogram", () => {
      const left = [1, 2, 3, 900, 50];
      const right = [4, 5, 6, 7, 1_200];
      const merged = fill(left, 1_000);
      merged.merge(fill(right, 1_000));
      expect(merged.summary()).toEqual(fill([...left, ...right], 1_000).summary());
    });

    test("uses fixed memory however many samples are recorded", () => {
      const histogram = createLatencyHistogram(1_000);
      const before = histogram.snapshot().counts.length;
      for (let index = 0; index < 200_000; index += 1) histogram.record(index % 1_500);
      expect(histogram.snapshot().counts.length).toBe(before);
      expect(histogram.summary().samples).toBe(200_000);
    });
  });

  describe("gap accounting", () => {
    test.each([
      [5, 6, 0, 0],
      [5, 8, 0, 2],
      [5, 11, 10, 0],
      [5, 13, 10, 2],
      [12, 12, 10, 0],
      [12, 9, 10, 0],
      [0, 1, 0, 0],
      [0, 4, 0, 3],
    ])("after %i a trade %i with the measured window starting past %i skips %i", (last, id, floor, expected) => {
      expect(gapBefore(last, id, floor)).toBe(expected);
    });

    test("ids missing before the measured window are never counted as loss", () => {
      expect(gapBefore(3, 11, 10)).toBe(0);
    });
  });

  describe("trade sequence observation", () => {
    test("an in-order trade advances the high-water mark without a duplicate or a gap", () => {
      expect(observeTradeId(5, 6, true, 0)).toEqual({ lastTradeId: 6, duplicateOrReordered: false, gap: 0 });
    });

    test("a repeated trade id is a duplicate and does not move the mark", () => {
      expect(observeTradeId(6, 6, true, 0)).toEqual({ lastTradeId: 6, duplicateOrReordered: true, gap: 0 });
    });

    test("an older trade id arriving late is a reorder and never lowers the mark", () => {
      expect(observeTradeId(9, 7, true, 0)).toEqual({ lastTradeId: 9, duplicateOrReordered: true, gap: 0 });
    });

    test("the first trade ever seen is never a duplicate", () => {
      expect(observeTradeId(0, 1, false, 0)).toEqual({ lastTradeId: 1, duplicateOrReordered: false, gap: 0 });
    });

    test("skipped ids are only a gap once the trade is inside the measured window", () => {
      expect(observeTradeId(5, 9, true, 0)).toEqual({ lastTradeId: 9, duplicateOrReordered: false, gap: 3 });
      expect(observeTradeId(5, 9, false, 0)).toEqual({ lastTradeId: 9, duplicateOrReordered: false, gap: 0 });
    });
  });

  describe("producer rate check", () => {
    test.each([
      [1_000, 1_000, true],
      [950, 1_000, true],
      [949, 1_000, false],
      [0, 1_000, false],
      [1_500, 1_000, true],
      [475, 500, true],
      [474, 500, false],
    ])("achieved %i of nominal %i trades per second is kept up: %s", (achieved, nominal, expected) => {
      expect(producerKeptUp(achieved, nominal)).toBe(expected);
    });
  });

  describe("synthetic trade stream", () => {
    const take = (seed, count) => { const next = createTradeGenerator(seed); return Array.from({ length: count }, () => next()); };

    test("is deterministic for a seed and differs across seeds", () => {
      expect(take(7, 200)).toEqual(take(7, 200));
      expect(take(7, 200)).not.toEqual(take(8, 200));
      const random = seededRandom(3);
      const values = Array.from({ length: 1_000 }, () => random());
      expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
      expect(new Set(values).size).toBeGreaterThan(990);
    });

    test("looks like a market rather than a constant: a moving price, varied sizes and a small share of large prints", () => {
      const trades = take(1, 20_000);
      const prices = new Set(trades.map((trade) => trade.price));
      const sizes = trades.map((trade) => Number(trade.quantity));
      expect(prices.size).toBeGreaterThan(20);
      expect(trades.every((trade) => Number(trade.price) > 0 && /^\d+\.\d{2}$/.test(trade.price) && /^\d+\.\d{6}$/.test(trade.quantity))).toBe(true);
      const mean = sizes.reduce((total, size) => total + size, 0) / sizes.length;
      const large = sizes.filter((size) => size > mean * 10).length / sizes.length;
      expect(large).toBeGreaterThan(0.002);
      expect(large).toBeLessThan(0.05);
      const buyers = trades.filter((trade) => trade.buyerIsMaker).length / trades.length;
      expect(buyers).toBeGreaterThan(0.45);
      expect(buyers).toBeLessThan(0.55);
    });

    test("the seed is validated as an unsigned 32-bit integer", () => {
      expect(() => validateFanoutManifest(manifestOf({ upstream: { tradesPerPulse: 1, pulseMs: 20, seed: 0 } }))).not.toThrow();
      expect(() => validateFanoutManifest(manifestOf({ upstream: { tradesPerPulse: 1, pulseMs: 20, seed: 4_294_967_295 } }))).not.toThrow();
      expect(() => validateFanoutManifest(manifestOf({ upstream: { tradesPerPulse: 1, pulseMs: 20, seed: -1 } }))).toThrow(/seed/);
      expect(() => validateFanoutManifest(manifestOf({ upstream: { tradesPerPulse: 1, pulseMs: 20, seed: 4_294_967_296 } }))).toThrow(/seed/);
      expect(() => validateFanoutManifest(manifestOf({ upstream: { tradesPerPulse: 1, pulseMs: 20, seed: 1.5 } }))).toThrow(/seed/);
    });
  });

  describe("fan-out to real WebSocket clients", () => {
    test("every healthy client receives every measured trade once, in order, and the report says how it was produced", async () => {
      const provenance = { git: null, scriptSha256: "s", manifestSha256: "m", nodeVersion: "v24" };
      const report = await runFanout({ manifest: manifestOf(), provenance });
      expect(report).toMatchObject({ contractVersion: 1, kind: "ws-fanout", name: "test", source: { ...provenance, wsVersion: expect.any(String) } });
      expect(report.sent.measured).toBeGreaterThan(0);
      expect(report.invariants).toMatchObject({
        producerKeptUp: true, healthyClientsReceivedEverySentTrade: true, duplicatesOrReordered: 0,
        gapsOnHealthyClients: 0, slowClients: 0, slowClientsEvictedByServer: 0, incidents: 0,
      });
      expect(report.invariants.healthyClientsMinReceived).toBe(report.sent.measured);
      expect(report.clients).toHaveLength(3);
      for (const client of report.clients) {
        expect(client).toMatchObject({ slow: false, received: report.sent.measured, serverClose: null, serverTerminatedAtMs: null });
        expect(client.frameCounts.trade).toBe(report.sent.measured);
        expect(client.frameCounts.marker ?? 0).toBeLessThan(client.received * 0.2);
        expect(client.latencyMs.samples).toBe(report.sent.measured);
      }
      expect(report.latencyMs.healthy.samples).toBe(report.sent.measured * 3);
      expect(report.latencyMs.healthy.p50).toBeGreaterThanOrEqual(0);
      expect(report.server.eventLoopDelayMs.max).toBeGreaterThan(0);
      expect(report.interrupted).toBeUndefined();
      expect(report.endedEarly).toBeUndefined();
    });

    test("the producer emits the nominal rate even when timer ticks arrive late", async () => {
      const report = await runFanout({ manifest: manifestOf({ upstream: { tradesPerPulse: 10, pulseMs: 20 }, durationMs: 1_500 }) });
      expect(report.sent.nominalTradesPerSecond).toBe(500);
      expect(report.sent.achievedTradesPerSecond).toBeGreaterThanOrEqual(450);
      expect(report.sent.achievedTradesPerSecond).toBeLessThanOrEqual(550);
    });

    // The paused client's operating system buffers the stream before the
    // server's own buffer grows: a few hundred kB on Windows, megabytes on
    // Linux. The rate fills either within seconds.
    test("a slow client is evicted by the server with 1013 while healthy clients are unaffected and the run ends early", async () => {
      const report = await runFanout({
        manifest: manifestOf({
          clients: 3, warmupMs: 300, durationMs: 15_000, sampleEveryMs: 100,
          upstream: { tradesPerPulse: 60, pulseMs: 20 },
          slowClients: { count: 1, pauseAfterMs: 300, stopAfterEviction: true },
          server: { clientBufferSoftBytes: 150_000, clientBufferHardBytes: 1_500_000, clientBufferGraceMs: 200 },
        }),
      });
      const [first, second, slow] = report.clients;
      expect(report.endedEarly).toBe("SLOW_CLIENTS_EVICTED");
      expect(report.measuredWallMs).toBeLessThan(12_000);
      expect(slow).toMatchObject({ slow: true, serverClose: { code: 1013, reason: expect.stringMatching(/too slow/) } });
      expect(slow.pausedAtMs).toBeGreaterThanOrEqual(0);
      expect(slow.serverClose.atMs).toBeGreaterThan(slow.pausedAtMs);
      expect(slow.maxBufferedBytes).toBeGreaterThan(150_000);
      expect(slow.bufferedSeriesMs.length).toBeGreaterThan(2);
      for (const healthy of [first, second]) expect(healthy).toMatchObject({ slow: false, serverClose: null, received: report.sent.measured, gaps: 0 });
      expect(report.invariants).toMatchObject({
        slowClients: 1, slowClientsEvictedByServer: 1, serverCloseCodes: { 1013: 1 },
        healthyClientsReceivedEverySentTrade: true, duplicatesOrReordered: 0, resumedSlowClientsReceivedEverySentTrade: null,
      });
    }, 30_000);

    test("a client that stalls briefly and resumes under the production thresholds is not evicted", async () => {
      const report = await runFanout({
        manifest: manifestOf({
          durationMs: 1_500, slowClients: { count: 1, pauseAfterMs: 200, resumeAfterMs: 900 },
        }),
      });
      const slow = report.clients[2];
      expect(slow).toMatchObject({ slow: true, serverClose: null, serverTerminatedAtMs: null });
      expect(slow.pausedAtMs).toBeGreaterThanOrEqual(0);
      expect(slow.resumedAtMs).toBeGreaterThan(slow.pausedAtMs);
      expect(report.invariants).toMatchObject({ slowClientsEvictedByServer: 0, healthyClientsReceivedEverySentTrade: true, duplicatesOrReordered: 0 });
      expect(report.invariants.resumedSlowClientsReceivedEverySentTrade).toBe(true);
      expect(slow.received).toBe(report.sent.measured);
      expect(slow.duplicatesOrReordered).toBe(0);
      expect(slow.gaps).toBe(0);
    });

    test("the run waits for a client that resumes at the very end to catch up before it reports", async () => {
      const report = await runFanout({
        manifest: manifestOf({
          durationMs: 1_500, upstream: { tradesPerPulse: 50, pulseMs: 20 },
          slowClients: { count: 1, pauseAfterMs: 100, resumeAfterMs: 1_500 },
        }),
      });
      const slow = report.clients[2];
      expect(slow.resumedAtMs).toBeGreaterThanOrEqual(1_490);
      expect(slow.pausedAtMs).toBeLessThan(slow.resumedAtMs);
      expect(slow.serverClose).toBeNull();
      expect(report.invariants.resumedSlowClientsReceivedEverySentTrade).toBe(true);
      expect(slow.received).toBe(report.sent.measured);
    });

    test("an interrupt ends the run early and is recorded", async () => {
      const interruption = new AbortController();
      setTimeout(() => interruption.abort(), 600);
      const startedAt = Date.now();
      const report = await runFanout({ manifest: manifestOf({ durationMs: 30_000 }), signal: interruption.signal });
      expect(report.interrupted).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    });

    test("leaves no temp directory behind after a run", async () => {
      // Its own directory, by name: a count of every ws-fanout- entry in the
      // shared temp folder also counts any other run going on beside this one.
      const made = [];
      const mkdtemp = fs.mkdtempSync;
      const spy = jest.spyOn(fs, "mkdtempSync").mockImplementation((prefix, options) => {
        const dir = mkdtemp(prefix, options);
        if (path.basename(prefix).startsWith("ws-fanout-")) made.push(dir);
        return dir;
      });
      try {
        await runFanout({ manifest: manifestOf({ durationMs: 300, warmupMs: 0 }) });
      } finally {
        spy.mockRestore();
      }
      expect(made).toHaveLength(1);
      expect(fs.existsSync(made[0])).toBe(false);
    });

    test("a run keeps its iceberg store under its own temp dir, next to its other stores, and hands the env back when the dir is gone", async () => {
      const made = [];
      const mkdtemp = fs.mkdtempSync;
      const mkdtempSpy = jest.spyOn(fs, "mkdtempSync").mockImplementation((prefix, options) => {
        const dir = mkdtemp(prefix, options);
        if (path.basename(prefix).startsWith("ws-fanout-")) made.push(dir);
        return dir;
      });
      const storeDirsAtRemoval = [];
      const rm = fs.rmSync;
      const rmSpy = jest.spyOn(fs, "rmSync").mockImplementation((target, options) => {
        if (made.includes(target)) storeDirsAtRemoval.push(process.env.L2_ICEBERG_STORE_DIR);
        return rm(target, options);
      });
      try {
        await runFanout({ manifest: manifestOf({ durationMs: 300, warmupMs: 0 }) });
      } finally {
        mkdtempSpy.mockRestore();
        rmSpy.mockRestore();
      }
      expect(made).toHaveLength(1);
      expect(storeDirsAtRemoval).toEqual([path.join(made[0], "icebergs")]);
      expect(process.env.L2_ICEBERG_STORE_DIR).toBe(ICEBERG_STORE_DIR);
    });
  });

  describe("command line", () => {
    test("writes the report atomically, pins the runner and manifest bytes, and keeps stdout clean", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-fanout-cli-"));
      try {
        const manifestPath = path.join(dir, "manifest.json");
        const manifestBytes = Buffer.from(JSON.stringify(manifestOf({ durationMs: 300, warmupMs: 0 })));
        fs.writeFileSync(manifestPath, manifestBytes);
        const outputPath = path.join(dir, "report.json");
        const logBefore = console.log;
        await main([manifestPath, outputPath]);
        expect(console.log).toBe(logBefore);
        const report = JSON.parse(fs.readFileSync(outputPath, "utf8"));
        expect(report.kind).toBe("ws-fanout");
        expect(report.source.manifestSha256).toBe(crypto.createHash("sha256").update(manifestBytes).digest("hex"));
        expect(report.source.scriptSha256).toBe(crypto.createHash("sha256")
          .update(fs.readFileSync(path.resolve(__dirname, "../../../scripts/bench/ws-fanout-load.js"))).digest("hex"));
        expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);

    test("refuses to run without a manifest path", async () => {
      await expect(main([])).rejects.toThrow(/usage/);
    });
  });
});
