import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BAND_COLUMN_MAX_PER_MINUTE } from "../../../chart/bandHistory";
import { STREAM_MAX_REQUESTS_PER_MINUTE } from "../columnHistoryStream";
import { HISTORY_MAX_REQUESTS_PER_MINUTE } from "../heatmapHistory";
import { COLUMN_HISTORY_MAX_IN_FLIGHT, COLUMN_HISTORY_MAX_PER_MINUTE, InFlightPool, RequestBudget, retryDelayMs } from "../requestBudget";

const T = 1_780_000_000_000;

describe("request budget: one minute's requests shared by several readers (PR #40 review)", () => {
  it("lets its shares spend one total between them, each no more than its own cap, and frees a request a minute after it was sent", () => {
    const budget = new RequestBudget(5);
    const stream = budget.share(3);
    const band = budget.share(3);
    for (let i = 0; i < 3; i += 1) {
      expect(stream.left(T + i)).toBe(true);
      stream.take(T + i);
    }
    expect(stream.left(T + 10)).toBe(false);
    expect(band.left(T + 10)).toBe(true);
    band.take(T + 10);
    band.take(T + 11);
    expect(band.left(T + 12)).toBe(false);
    expect(budget.left(T + 12)).toBe(false);
    expect(band.left(T + 59_999)).toBe(false);
    expect(band.left(T + 60_000)).toBe(true);
    expect(stream.left(T + 60_000)).toBe(true);
    stream.take(T + 60_000);
    expect(band.left(T + 60_000)).toBe(false);
    expect(band.left(T + 60_001)).toBe(true);
  });

  it("tells a share how long to wait: for its own oldest request when its cap is spent, for the total's oldest when the total is", () => {
    const budget = new RequestBudget(3);
    const stream = budget.share(2);
    const band = budget.share(2);
    expect(stream.waitMs(T)).toBe(1);
    stream.take(T);
    stream.take(T + 1_000);
    expect(stream.left(T + 2_000)).toBe(false);
    expect(stream.waitMs(T + 2_000)).toBe(58_000);
    expect(band.waitMs(T + 2_000)).toBe(1);
    band.take(T + 2_000);
    expect(band.left(T + 3_000)).toBe(false);
    expect(band.waitMs(T + 3_000)).toBe(57_000);
    expect(budget.share().cap).toBe(3);
    expect(stream.pool).toBe(budget);
  });

  it("keeps the browser's readers of /heatmap/columns under the route's limit together: the heatmap's own budget plus the indicators' shared one, with each indicator's cap inside the shared one", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const require = createRequire(import.meta.url);
    const route = require(path.join(here, "../../../../../../runtime/src/server/heatmap-route.js"));
    expect(HISTORY_MAX_REQUESTS_PER_MINUTE + COLUMN_HISTORY_MAX_PER_MINUTE).toBeLessThan(route.DEFAULT_RATE_LIMIT.max);
    expect(route.DEFAULT_RATE_LIMIT.windowMs).toBe(60_000);
    expect(STREAM_MAX_REQUESTS_PER_MINUTE).toBeLessThanOrEqual(COLUMN_HISTORY_MAX_PER_MINUTE);
    expect(BAND_COLUMN_MAX_PER_MINUTE).toBeLessThanOrEqual(COLUMN_HISTORY_MAX_PER_MINUTE);
    expect(STREAM_MAX_REQUESTS_PER_MINUTE + BAND_COLUMN_MAX_PER_MINUTE).toBeGreaterThan(COLUMN_HISTORY_MAX_PER_MINUTE);
  });

  it("holds open no more reads of /heatmap/columns at once, across the heatmap, the column stream and the band store, than the route serves at once (PR #47 review)", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const require = createRequire(import.meta.url);
    const route = require(path.join(here, "../../../../../../runtime/src/server/heatmap-route.js"));
    expect(COLUMN_HISTORY_MAX_IN_FLIGHT).toBe(route.DEFAULT_MAX_CONCURRENT);
  });
});

describe("in-flight pool: the reads held open on one route, counted across its readers (PR #47 review)", () => {
  it("counts the reads its readers hold open up to its cap, and never below zero", () => {
    const pool = new InFlightPool(2);
    expect([pool.max, pool.held, pool.left()]).toEqual([2, 0, true]);
    pool.take();
    expect([pool.held, pool.left()]).toEqual([1, true]);
    pool.take();
    expect([pool.held, pool.left()]).toEqual([2, false]);
    pool.free();
    expect([pool.held, pool.left()]).toEqual([1, true]);
    pool.free(5);
    expect([pool.held, pool.left()]).toEqual([0, true]);
  });
});

describe("retryDelayMs", () => {
  it("waits the fallback when the host named no delay or an unusable one", () => {
    for (const delay of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) expect(retryDelayMs(delay, 30_000)).toBe(30_000);
  });

  it("waits the delay the host named, never under two seconds and never over the fallback", () => {
    expect(retryDelayMs(250, 30_000)).toBe(2_000);
    expect(retryDelayMs(0, 30_000)).toBe(2_000);
    expect(retryDelayMs(5_000, 30_000)).toBe(5_000);
    expect(retryDelayMs(120_000, 30_000)).toBe(30_000);
    expect(retryDelayMs(250, 300)).toBe(300);
  });
});
