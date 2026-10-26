"use strict";

jest.mock("../../../../scripts/collect/historical/tardis-datasets-api");
jest.mock("../../../../src/platform/rclone-stream");
jest.mock("tardis-dev", () => ({ getApiKeyAccessInfo: jest.fn() }));

const { Readable, PassThrough } = require("node:stream");
const { fetchWithRetry } = require("../../../../scripts/collect/historical/tardis-datasets-api");
const { streamToRclone } = require("../../../../src/platform/rclone-stream");
const {
  resolveConcurrencyLimit, DEFAULT_CONCURRENCY_LIMIT, runWithConcurrency, runJob, resolveJobSettings,
  DEFAULT_STALL_MS, DEFAULT_UPLOAD_MAX_MS, DEFAULT_JOB_ATTEMPTS, orderJobs, providerSize, buildJobs,
  verifyExisting, expectedDays, ANCHOR_DATE, TARGETS,
} = require("../../../../scripts/collect/historical/ingest-tardis-backfill");

function response(chunks, headers = {}) {
  return Object.assign(Readable.from(chunks.map((chunk) => Buffer.from(chunk))), { statusCode: 200, headers });
}

function sized(text) {
  return response([text], { "content-length": String(Buffer.byteLength(text)) });
}

async function drain(readable) {
  let bytes = 0;
  for await (const chunk of readable) bytes += chunk.length;
  return bytes;
}

describe("resolveConcurrencyLimit", () => {
  test("falls back to the default when unset", () => {
    expect(resolveConcurrencyLimit({})).toBe(DEFAULT_CONCURRENCY_LIMIT);
  });

  test("falls back to the default when set to an empty string", () => {
    expect(resolveConcurrencyLimit({ TARDIS_BACKFILL_CONCURRENCY: "" })).toBe(DEFAULT_CONCURRENCY_LIMIT);
  });

  test("honors a configured positive integer", () => {
    expect(resolveConcurrencyLimit({ TARDIS_BACKFILL_CONCURRENCY: "7" })).toBe(7);
  });

  test.each(["0", "-3", "abc", "2.5"])("rejects a non-positive-integer value %p", (raw) => {
    expect(() => resolveConcurrencyLimit({ TARDIS_BACKFILL_CONCURRENCY: raw })).toThrow(/positive integer/);
  });
});

describe("resolveJobSettings", () => {
  test("defaults to a 5 min stall, a 6 h upload cap and 3 day attempts", () => {
    expect(resolveJobSettings({})).toEqual({ stallMs: DEFAULT_STALL_MS, uploadMaxMs: DEFAULT_UPLOAD_MAX_MS, jobAttempts: DEFAULT_JOB_ATTEMPTS });
    expect([DEFAULT_STALL_MS, DEFAULT_UPLOAD_MAX_MS, DEFAULT_JOB_ATTEMPTS]).toEqual([300_000, 21_600_000, 3]);
  });

  test("honors configured values", () => {
    expect(resolveJobSettings({ TARDIS_STALL_MS: "1000", TARDIS_UPLOAD_MAX_MS: "2000", TARDIS_JOB_ATTEMPTS: "5" }))
      .toEqual({ stallMs: 1000, uploadMaxMs: 2000, jobAttempts: 5 });
  });

  test.each(["TARDIS_STALL_MS", "TARDIS_UPLOAD_MAX_MS", "TARDIS_JOB_ATTEMPTS"])("refuses an invalid %s", (name) => {
    expect(() => resolveJobSettings({ [name]: "0" })).toThrow(new RegExp(`${name} must be a positive integer`));
    expect(() => resolveJobSettings({ [name]: "1.5" })).toThrow(/positive integer/);
  });
});

describe("runWithConcurrency", () => {
  test("fires onTick once per settled job, success or failure, with a running snapshot", async () => {
    const jobs = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const onTick = jest.fn();
    const worker = jest.fn(async (job) => {
      if (job.id === 2) throw new Error("boom");
      return job.id;
    });
    const result = await runWithConcurrency(jobs, 2, worker, { onTick });
    expect(onTick).toHaveBeenCalledTimes(3);
    expect(result.done).toBe(2);
    expect(result.failed).toHaveLength(1);
    const lastSnapshot = onTick.mock.calls[onTick.mock.calls.length - 1][0];
    expect(lastSnapshot.total).toBe(3);
    expect(lastSnapshot.done + lastSnapshot.failedCount).toBe(3);
  });

  test("onTick is optional", async () => {
    const result = await runWithConcurrency([{ id: 1 }], 1, async () => "ok");
    expect(result.done).toBe(1);
  });

  test("keeps the HTTP status of a failure and collects unverified successes", async () => {
    const jobs = [{ id: 1 }, { id: 2 }];
    const result = await runWithConcurrency(jobs, 1, async (job) => {
      if (job.id === 1) throw Object.assign(new Error("HTTP 404"), { status: 404 });
      return { verified: false };
    });
    expect(result.failed[0]).toMatchObject({ status: 404, reason: "HTTP 404" });
    expect(result.unverified).toEqual([{ id: 2 }]);
  });

  test("stops every lane once an upload child's exit is unconfirmed", async () => {
    const jobs = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const worker = jest.fn(async () => {
      throw Object.assign(new Error("gone"), { code: "RCLONE_CHILD_EXIT_UNCONFIRMED" });
    });
    const result = await runWithConcurrency(jobs, 1, worker);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe(2);
  });
});

describe("runJob", () => {
  const job = {
    exchange: "binance", symbol: "btcusdt", symbolUpper: "BTCUSDT", dataType: "trades",
    date: new Date(Date.UTC(2026, 8, 6)), destPath: "raw/tardis/exchange=binance/data_type=trades/symbol=BTCUSDT/year=2026/month=09/day=06/x.csv.gz",
  };
  const settings = { stallMs: 200, uploadMaxMs: 60_000, jobAttempts: 3 };
  const sleepImpl = jest.fn(async () => {});

  function fakeLogger() {
    return { warn: jest.fn(), info: jest.fn() };
  }

  beforeEach(() => {
    fetchWithRetry.mockReset();
    streamToRclone.mockReset();
    sleepImpl.mockClear();
    streamToRclone.mockImplementation(async (readable) => { await drain(readable); });
  });

  test("a request retry reported by fetchWithRetry lands as a logger.warn line", async () => {
    fetchWithRetry.mockImplementation(async (_apiKey, _target, { onRetry } = {}) => {
      onRetry?.({ attempt: 1, maxAttempts: 10, reason: "HTTP 429", statusCode: 429, waitMs: 60_000 });
      return sized("hello");
    });
    const logger = fakeLogger();

    await runJob("key", job, logger, "rclone.exe", { settings, sleepImpl, objectSizeImpl: async () => 5 });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, meta] = logger.warn.mock.calls[0];
    expect(message).toMatch(/retrying/);
    expect(meta).toMatchObject({ attempt: 1, maxAttempts: 10, statusCode: 429, waitMs: 60_000 });
    expect(logger.info.mock.calls[0][0]).toMatch(/streamed/);
  });

  test("a clean day is verified: provider, streamed and stored sizes agree", async () => {
    fetchWithRetry.mockResolvedValue(sized("hello"));
    const objectSizeImpl = jest.fn(async () => 5);
    const logger = fakeLogger();

    const result = await runJob("key", job, logger, "rclone.exe", { settings, sleepImpl, objectSizeImpl });

    expect(result).toEqual({ verified: true, bytes: 5 });
    expect(objectSizeImpl).toHaveBeenCalledWith("rclone.exe", job.destPath);
    expect(streamToRclone.mock.calls[0][2]).toEqual({ rcloneBin: "rclone.exe", timeoutMs: 60_000 });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("a stalled stream fails the attempt after the stall window", async () => {
    fetchWithRetry.mockImplementation(async () => Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-length": "5" } }));
    const logger = fakeLogger();

    await expect(runJob("key", job, logger, "rclone.exe", {
      settings: { ...settings, stallMs: 50, jobAttempts: 1 }, sleepImpl, objectSizeImpl: async () => 5,
    })).rejects.toMatchObject({ code: "TARDIS_STALL" });
  });

  test("a slow but moving stream never trips the stall window", async () => {
    fetchWithRetry.mockImplementation(async () => {
      const slow = new Readable({ read() {} });
      let sent = 0;
      const timer = setInterval(() => {
        sent += 1;
        slow.push(Buffer.from("x"));
        if (sent === 5) { clearInterval(timer); slow.push(null); }
      }, 20);
      return Object.assign(slow, { statusCode: 200, headers: { "content-length": "5" } });
    });

    const result = await runJob("key", job, fakeLogger(), "rclone.exe", {
      settings: { ...settings, stallMs: 80 }, sleepImpl, objectSizeImpl: async () => 5,
    });

    expect(result).toEqual({ verified: true, bytes: 5 });
  });

  test("a mid-body failure retries the whole day with a fresh request", async () => {
    const broken = new Readable({
      read() {
        this.push(Buffer.from("he"));
        this.destroy(new Error("aborted"));
      },
    });
    fetchWithRetry
      .mockResolvedValueOnce(Object.assign(broken, { statusCode: 200, headers: { "content-length": "5" } }))
      .mockResolvedValueOnce(sized("hello"));
    const logger = fakeLogger();

    const result = await runJob("key", job, logger, "rclone.exe", { settings, sleepImpl, objectSizeImpl: async () => 5 });

    expect(result.verified).toBe(true);
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/day retrying/);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ attempt: 1, maxAttempts: 3, reason: "aborted" });
  });

  test("an unconfirmed upload child exit is never retried", async () => {
    fetchWithRetry.mockResolvedValue(sized("hello"));
    streamToRclone.mockImplementation(async (readable) => {
      readable.destroy();
      throw Object.assign(new Error("exit unconfirmed"), { code: "RCLONE_CHILD_EXIT_UNCONFIRMED" });
    });

    await expect(runJob("key", job, fakeLogger(), "rclone.exe", { settings, sleepImpl, objectSizeImpl: async () => 5 }))
      .rejects.toMatchObject({ code: "RCLONE_CHILD_EXIT_UNCONFIRMED" });
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  test("a stored object shorter than the provider size is retried, then reported", async () => {
    fetchWithRetry.mockImplementation(async () => sized("hello"));
    const objectSizeImpl = jest.fn(async () => 3);

    await expect(runJob("key", job, fakeLogger(), "rclone.exe", {
      settings: { ...settings, jobAttempts: 2 }, sleepImpl, objectSizeImpl,
    })).rejects.toMatchObject({ code: "SIZE_MISMATCH", message: "size mismatch: provider 5, streamed 5, stored 3" });
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
    expect(objectSizeImpl).toHaveBeenCalledTimes(2);
  });

  test("a failure inside fetchWithRetry is final: it already retried the request", async () => {
    fetchWithRetry.mockRejectedValue(Object.assign(new Error("HTTP 404"), { status: 404 }));

    await expect(runJob("key", job, fakeLogger(), "rclone.exe", { settings, sleepImpl })).rejects.toMatchObject({ status: 404 });
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
  });

  test("a response without a size header is uploaded but reported unverified", async () => {
    fetchWithRetry.mockResolvedValue(response(["hello"]));
    const objectSizeImpl = jest.fn();
    const logger = fakeLogger();

    const result = await runJob("key", job, logger, "rclone.exe", { settings, sleepImpl, objectSizeImpl });

    expect(result).toEqual({ verified: false, bytes: 5 });
    expect(objectSizeImpl).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls[0][0]).toMatch(/without a provider size/);
  });
});

describe("providerSize", () => {
  test("prefers content-length, falls back to x-dataset-size, else null", () => {
    expect(providerSize({ headers: { "content-length": "10", "x-dataset-size": "9" } })).toBe(10);
    expect(providerSize({ headers: { "x-dataset-size": "9" } })).toBe(9);
    expect(providerSize({ headers: { "content-length": "abc" } })).toBeNull();
    expect(providerSize({ headers: {} })).toBeNull();
  });
});

describe("orderJobs", () => {
  test("small series first, spot order book next to last, perpetual order book last, dates kept in order", () => {
    const make = (exchange, dataType, day) => ({ exchange, dataType, day });
    const jobs = [
      make("binance-futures", "incremental_book_L2", 1),
      make("binance", "incremental_book_L2", 1),
      make("binance-futures", "book_ticker", 1),
      make("binance", "trades", 2),
      make("binance", "trades", 1),
      make("binance-futures", "liquidations", 1),
    ];
    expect(orderJobs(jobs).map((j) => `${j.exchange}/${j.dataType}/${j.day}`)).toEqual([
      "binance-futures/liquidations/1",
      "binance/trades/2",
      "binance/trades/1",
      "binance-futures/book_ticker/1",
      "binance/incremental_book_L2/1",
      "binance-futures/incremental_book_L2/1",
    ]);
  });
});

describe("buildJobs", () => {
  test("lists every expected day not already in S3, one listing per series", () => {
    const seriesCount = TARGETS.reduce((n, t) => n + t.dataTypes.length, 0);
    const present = "year=2025/month=09/day=06/binance_trades_2025-09-06_BTCUSDT.csv.gz";
    const coverageImpl = jest.fn((_bin, target) => new Set(target.endsWith("exchange=binance/data_type=trades/symbol=BTCUSDT/") ? [present] : []));

    const jobs = buildJobs("rclone", { cutoff: new Date(ANCHOR_DATE), coverageImpl });

    expect(coverageImpl).toHaveBeenCalledTimes(seriesCount);
    expect(jobs).toHaveLength(seriesCount - 1);
    expect(jobs.some((j) => j.exchange === "binance" && j.dataType === "trades" && j.symbolUpper === "BTCUSDT")).toBe(false);
  });
});

describe("verifyExisting", () => {
  test("re-queues a short object, keeps a matching one, lists a sizeless one", async () => {
    const days = [...expectedDays(new Date(ANCHOR_DATE))];
    const [good, short, sizeless] = days;
    const stored = new Map([[good.destPath, 100], [short.destPath, 40], [sizeless.destPath, 7]]);
    const probeImpl = jest.fn(async (_key, job) => (job.destPath === sizeless.destPath ? null : 100));
    const logger = { info: jest.fn() };

    const result = await verifyExisting("key", "rclone", logger, {
      cutoff: new Date(ANCHOR_DATE), listImpl: async () => stored, probeImpl, limit: 2,
    });

    expect(probeImpl).toHaveBeenCalledTimes(3);
    expect(result.checked).toBe(3);
    expect(result.mismatched).toEqual([{ job: short, providerSize: 100, storedSize: 40 }]);
    expect(result.unverifiable).toEqual([sizeless]);
    expect(result.failed).toEqual([]);
  });

  test("a probe that fails is reported, not treated as a match", async () => {
    const [day] = [...expectedDays(new Date(ANCHOR_DATE))];
    const result = await verifyExisting("key", "rclone", { info: jest.fn() }, {
      cutoff: new Date(ANCHOR_DATE),
      listImpl: async () => new Map([[day.destPath, 5]]),
      probeImpl: async () => { throw new Error("HTTP 500"); },
    });
    expect(result.mismatched).toEqual([]);
    expect(result.failed).toHaveLength(1);
  });
});
