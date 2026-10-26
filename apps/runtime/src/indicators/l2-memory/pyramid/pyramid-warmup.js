"use strict";

const { WINDOW_MS, BASE_LEVEL_MS, WINDOW_STATES, decodeWindow, windowStart } = require("./pyramid-levels");

const DEFAULT_PIN_REFRESH_MS = 6 * 3_600_000;
const PIN_LOOKBACK_MS = 3_600_000;
const MAX_PAGES = 64;
const RETRY_WAITS_MS = Object.freeze([2_000, 5_000]);
const MAX_IN_FLIGHT = 2;
const MAX_DETAIL_LENGTH = 160;
const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 10 * 60_000;

function providerOf(marketKind) {
  return marketKind === "FUTURE" || marketKind === "EQUITY" ? "dxfeed" : "binance";
}

function sameNumber(a, b) {
  return typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function withDetail(read, note) {
  return async (...args) => {
    note.last = null;
    const page = await read(...args);
    return page && page.available === false && note.last !== null ? { ...page, detail: note.last } : page;
  };
}

function noteOf(note) {
  return (...args) => {
    note.last = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ").replace(/^remote-storage-reader: /, "").slice(0, MAX_DETAIL_LENGTH);
  };
}

function createPyramidWarmup({
  read, readWalls = null, readEvents = null, close = () => {}, now = () => Date.now(), pinRefreshMs = DEFAULT_PIN_REFRESH_MS, log = () => {}, wait = sleep,
  cacheBytes = DEFAULT_CACHE_BYTES, cacheTtlMs = DEFAULT_CACHE_TTL_MS,
}) {
  if (typeof read !== "function") throw new Error("pyramid-warmup: read must be a function");
  if (readWalls !== null && typeof readWalls !== "function") throw new Error("pyramid-warmup: readWalls must be a function or null");
  if (readEvents !== null && typeof readEvents !== "function") throw new Error("pyramid-warmup: readEvents must be a function or null");
  if (typeof close !== "function") throw new Error("pyramid-warmup: close must be a function");
  if (typeof wait !== "function") throw new Error("pyramid-warmup: wait must be a function");
  if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0) throw new Error("pyramid-warmup: cacheBytes must be a non-negative safe integer");
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs <= 0) throw new Error("pyramid-warmup: cacheTtlMs must be a positive safe integer");
  const pins = new Map();
  const counters = { pinReads: 0, pinned: 0, pages: 0, columns: 0, refused: 0, failed: 0, retries: 0, walls: 0, eventWindows: 0, cachedWindows: 0, sharedWindows: 0 };
  let inFlight = 0;
  const waiting = [];
  const kept = new Map();
  let keptBytes = 0;

  function keyOf(marketKind, symbol) {
    return `${marketKind}:${symbol}`;
  }

  function windowKey({ marketKind, symbol, geometry }, ts) {
    return `${keyOf(marketKind, symbol)}:${geometry.rowWidth}:${geometry.tickSize}:${geometry.clusterTicks}:${ts}`;
  }

  function forget(key, entry) {
    kept.delete(key);
    keptBytes -= entry.bytes;
  }

  function keptWindow(key) {
    const entry = kept.get(key);
    if (entry === undefined) return undefined;
    if (entry.pending === null && now() - entry.at >= cacheTtlMs) {
      forget(key, entry);
      return undefined;
    }
    return entry;
  }

  function keepWindow(key, window) {
    const previous = kept.get(key);
    if (previous !== undefined) forget(key, previous);
    const bytes = JSON.stringify(window.columns).length;
    kept.set(key, { columns: window.columns, bytes, at: now(), pending: null });
    keptBytes += bytes;
    for (const [oldKey, old] of kept) {
      if (keptBytes <= cacheBytes) break;
      if (old.pending === null) forget(oldKey, old);
    }
  }

  async function refreshPin(marketKind, symbol) {
    const key = keyOf(marketKind, symbol);
    const entry = pins.get(key) ?? { geometry: null, at: 0, pending: null };
    if (entry.pending !== null) return entry.pending;
    const at = now();
    entry.pending = (async () => {
      counters.pinReads += 1;
      try {
        const page = await read(providerOf(marketKind), symbol, marketKind, { levelMs: 300_000, fromTs: windowStart(at) - PIN_LOOKBACK_MS, toTs: windowStart(at) + WINDOW_MS });
        if (page && page.available === true && page.geometry && Number.isSafeInteger(page.geometry.rowClusters)) {
          entry.geometry = Object.freeze({ ...page.geometry });
          counters.pinned += 1;
        }
      } catch (error) {
        counters.failed += 1;
        log(`pyramid-warmup: the pinned heatmap rows for ${key} could not be read: ${error?.message ?? error}`);
      } finally {
        entry.at = at;
        entry.pending = null;
      }
      return entry.geometry;
    })();
    pins.set(key, entry);
    return entry.pending;
  }

  function pinned(marketKind, symbol) {
    const entry = pins.get(keyOf(marketKind, symbol));
    if (entry === undefined || (entry.pending === null && now() - entry.at >= pinRefreshMs)) void refreshPin(marketKind, symbol);
    return entry?.geometry ?? null;
  }

  function pinReady(marketKind, symbol) {
    const entry = pins.get(keyOf(marketKind, symbol));
    return entry !== undefined && entry.pending === null;
  }

  function prefetch(pairs) {
    return Promise.all(pairs.map(({ marketKind, symbol }) => refreshPin(marketKind, symbol)));
  }

  function acquire() {
    if (inFlight < MAX_IN_FLIGHT) {
      inFlight += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve)).then(() => {
      inFlight += 1;
    });
  }

  function release() {
    inFlight -= 1;
    const next = waiting.shift();
    if (next !== undefined) next();
  }

  async function readPage(marketKind, symbol, options, reader = read) {
    for (let attempt = 0; ; attempt += 1) {
      let page = null;
      let reason;
      try {
        page = await reader(providerOf(marketKind), symbol, marketKind, options);
      } catch (error) {
        counters.failed += 1;
        reason = `READ_FAILED: ${String(error?.message ?? error).slice(0, 120)}`;
      }
      if (page && page.available === true) return { page, reason: null };
      if (page) reason = `${page.reason ?? "UNAVAILABLE"}${typeof page.detail === "string" && page.detail.length > 0 ? ` (${page.detail})` : ""}`;
      if (attempt >= RETRY_WAITS_MS.length) return { page: null, reason: `${reason} after ${attempt + 1} tries` };
      counters.retries += 1;
      await wait(RETRY_WAITS_MS[attempt]);
    }
  }

  async function pageWindows({ marketKind, symbol, fromTs, toTs, geometry }) {
    const windows = [];
    let cursor = fromTs;
    let pages = 0;
    while (cursor !== null && cursor < toTs && pages < MAX_PAGES) {
      const { page, reason } = await readPage(marketKind, symbol, { levelMs: BASE_LEVEL_MS, fromTs: cursor, toTs });
      if (page === null) return { windows: [], reason };
      pages += 1;
      counters.pages += 1;
      const g = page.geometry ?? {};
      if (!sameNumber(g.rowWidth, geometry.rowWidth) || !sameNumber(g.tickSize, geometry.tickSize) || g.clusterTicks !== geometry.clusterTicks) {
        counters.refused += 1;
        return { windows: [], reason: "GEOMETRY" };
      }
      for (const window of page.windows) windows.push(window);
      if (page.next !== null && (!Number.isSafeInteger(page.next) || page.next <= cursor || page.next > toTs)) {
        counters.refused += 1;
        return { windows: [], reason: "PAGE_CURSOR" };
      }
      cursor = page.next;
    }
    if (cursor !== null && cursor < toTs) {
      counters.refused += 1;
      return { windows: [], reason: "PAGE_LIMIT" };
    }
    return { windows, reason: null };
  }

  async function readMissing(ask, missing) {
    let settle;
    const pending = new Promise((resolve) => { settle = resolve; });
    const keys = missing.map((ts) => windowKey(ask, ts));
    for (const key of keys) kept.set(key, { columns: null, bytes: 0, at: now(), pending });
    const outcome = { reason: null, decoded: new Map() };
    let page = { windows: [], reason: null };
    try {
      await acquire();
      try {
        page = await pageWindows({ ...ask, fromTs: Math.max(ask.fromTs, missing[0]), toTs: Math.min(ask.toTs, missing[missing.length - 1] + WINDOW_MS) });
      } finally {
        release();
      }
      outcome.reason = page.reason;
      for (const window of page.windows) outcome.decoded.set(window.ts, decodeWindow(window.columns));
    } catch (error) {
      outcome.reason = `READ_FAILED: ${String(error?.message ?? error).slice(0, 120)}`;
      throw error;
    } finally {
      for (const key of keys) {
        const entry = kept.get(key);
        if (entry !== undefined && entry.pending === pending) kept.delete(key);
      }
      if (outcome.reason === null) for (const window of page.windows) if (window.state === WINDOW_STATES.COVERED) keepWindow(windowKey(ask, window.ts), window);
      settle(outcome);
    }
    return outcome;
  }

  async function deepColumns(ask) {
    const { fromTs, toTs } = ask;
    const decoded = new Map();
    const missing = [];
    const shared = [];
    for (let ts = windowStart(fromTs); ts < toTs; ts += WINDOW_MS) {
      const entry = keptWindow(windowKey(ask, ts));
      if (entry === undefined) missing.push(ts);
      else if (entry.pending !== null) shared.push([ts, entry.pending]);
      else {
        decoded.set(ts, decodeWindow(entry.columns));
        counters.cachedWindows += 1;
      }
    }
    if (missing.length > 0) {
      const outcome = await readMissing(ask, missing);
      if (outcome.reason !== null) return { columns: [], reason: outcome.reason };
      for (const [ts, columns] of outcome.decoded) decoded.set(ts, columns);
    }
    for (const [ts, pending] of shared) {
      const outcome = await pending;
      if (outcome.reason !== null) return { columns: [], reason: outcome.reason };
      const columns = outcome.decoded.get(ts);
      if (columns !== undefined) decoded.set(ts, columns);
      counters.sharedWindows += 1;
    }
    const columns = [];
    for (const windowColumns of decoded.values()) {
      for (const column of windowColumns) if (column.ts >= fromTs && column.ts < toTs) columns.push(column);
    }
    columns.sort((a, b) => a.ts - b.ts);
    counters.columns += columns.length;
    return { columns, reason: null };
  }

  function sameRows(page, geometry) {
    const g = page.geometry ?? {};
    return sameNumber(g.rowWidth, geometry.rowWidth) && sameNumber(g.tickSize, geometry.tickSize) && g.clusterTicks === geometry.clusterTicks;
  }

  async function pageWalls({ marketKind, symbol, fromTs, toTs, geometry }) {
    const walls = [];
    const read = (reason) => {
      counters.walls += walls.length;
      return { walls, reason };
    };
    let after = undefined;
    for (let pages = 0; pages < MAX_PAGES; pages += 1) {
      const { page, reason } = await readPage(marketKind, symbol, { fromTs, toTs, ...(after === undefined ? {} : { after }) }, readWalls);
      if (page === null) return read(reason);
      counters.pages += 1;
      if (!sameRows(page, geometry)) {
        counters.refused += 1;
        return { walls: [], reason: "GEOMETRY" };
      }
      if (page.next !== null && after !== undefined && page.next.endTs === after.endTs && page.next.id === after.id) {
        counters.refused += 1;
        return read("PAGE_CURSOR");
      }
      walls.push(...page.walls);
      if (page.next === null) return read(null);
      after = { endTs: page.next.endTs, id: page.next.id };
    }
    counters.refused += 1;
    return read("PAGE_LIMIT");
  }

  async function pageEvents({ marketKind, symbol, fromTs, toTs, geometry }) {
    const windows = [];
    const read = (reason) => {
      counters.eventWindows += windows.length;
      return { windows, reason };
    };
    let cursor = fromTs;
    for (let pages = 0; pages < MAX_PAGES; pages += 1) {
      const { page, reason } = await readPage(marketKind, symbol, { fromTs: cursor, toTs }, readEvents);
      if (page === null) return read(reason);
      counters.pages += 1;
      if (!sameRows(page, geometry)) {
        counters.refused += 1;
        return { windows: [], reason: "GEOMETRY" };
      }
      for (const window of page.windows) if (window.ts >= fromTs && window.ts < toTs) windows.push(window);
      if (page.next === null) return read(null);
      if (!Number.isSafeInteger(page.next) || page.next <= cursor || page.next > toTs) {
        counters.refused += 1;
        return read("PAGE_CURSOR");
      }
      cursor = page.next;
    }
    counters.refused += 1;
    return read("PAGE_LIMIT");
  }

  async function wallHistory(ask) {
    if (readWalls === null) return { walls: [], reason: "NO_READER" };
    await acquire();
    try {
      return await pageWalls(ask);
    } finally {
      release();
    }
  }

  async function eventHistory(ask) {
    if (readEvents === null) return { windows: [], reason: "NO_READER" };
    await acquire();
    try {
      return await pageEvents(ask);
    } finally {
      release();
    }
  }

  function stats() {
    return Object.freeze({ ...counters, pins: pins.size, inFlight, waiting: waiting.length, keptWindows: kept.size, keptBytes });
  }

  return Object.freeze({ pinned, pinReady, prefetch, refreshPin, deepColumns, wallHistory, eventHistory, stats, close });
}

module.exports = { createPyramidWarmup, providerOf, withDetail, noteOf, DEFAULT_PIN_REFRESH_MS, RETRY_WAITS_MS, MAX_IN_FLIGHT, DEFAULT_CACHE_BYTES, DEFAULT_CACHE_TTL_MS };
