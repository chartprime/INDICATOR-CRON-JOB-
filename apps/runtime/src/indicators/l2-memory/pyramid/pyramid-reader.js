"use strict";

const { coarsenColumn, encodeAfter } = require("../../passive_liquidity/liquidity-history");
const { openPyramidStore, DEFAULT_WALL_PAGE } = require("./pyramid-store");
const { decodeWindow, isLevel } = require("./pyramid-levels");

const DEFAULT_PAGE_BYTES = 1_500_000;
const SIZE_BANDS_TTL_MS = 600_000;
const ROW_FACTORS = Object.freeze([1, 2, 4, 8, 16, 32, 64]);

function pairKeyOf(provider, marketKind, symbol) {
  return `${provider}:${marketKind}:${symbol}`;
}

function coarsenWindow(wires, rowFactor) {
  if (rowFactor === 1) return wires;
  const out = [];
  let prev = null;
  for (const column of decodeWindow(wires)) {
    const coarse = { ...coarsenColumn(column, rowFactor) };
    if (column.prints !== undefined) coarse.prints = column.prints;
    if (column.printsFloor !== undefined) coarse.printsFloor = column.printsFloor;
    out.push(encodeAfter(prev, coarse));
    prev = coarse;
  }
  return out;
}

function createPyramidReader({ dir, pageBytes = DEFAULT_PAGE_BYTES, open = openPyramidStore, now = () => Date.now(), sizeBandsTtlMs = SIZE_BANDS_TTL_MS }) {
  if (typeof dir !== "string" || dir.length === 0) throw new Error("pyramid-reader: dir is required");
  if (!Number.isSafeInteger(pageBytes) || pageBytes <= 0) throw new Error("pyramid-reader: pageBytes must be a positive integer");
  const stores = new Map();
  const bandCache = new Map();
  const counters = { pages: 0, windows: 0, bytes: 0, missing: 0, walls: 0, eventWindows: 0, sizeScans: 0 };

  function sizeBandsFor(pairKey, store, generation, rowWidth) {
    const at = now();
    const held = bandCache.get(pairKey);
    if (held !== undefined && held.generation === generation && at - held.at < sizeBandsTtlMs) return held.bands;
    const bands = store.sizeBands(rowWidth);
    counters.sizeScans += 1;
    bandCache.set(pairKey, { at, generation, bands });
    return bands;
  }

  function storeFor(pairKey) {
    const existing = stores.get(pairKey);
    if (existing !== undefined) return existing;
    const store = open({ dir, pairKey, readonly: true });
    if (store !== null) stores.set(pairKey, store);
    return store;
  }

  function readHeatmapColumns(provider, symbol, marketKind, { levelMs, fromTs, toTs, rowFactor = 1 }) {
    if (!isLevel(levelMs)) throw new Error("pyramid-reader: levelMs is not a pyramid level");
    if (!ROW_FACTORS.includes(rowFactor)) throw new Error("pyramid-reader: rowFactor must be a power of two up to 64");
    const store = storeFor(pairKeyOf(provider, marketKind, symbol));
    if (store === null) {
      counters.missing += 1;
      return { available: false, reason: "NO_PYRAMID" };
    }
    const snapshot = store.snapshotPage({ levelMs, fromTs, toTs, maxBytes: pageBytes });
    const { geometry, generation, page, span } = snapshot;
    if (geometry === null) return { available: false, reason: "NOT_PINNED" };
    const windows = page.windows.map((window) => ({ ts: window.ts, state: window.state, columns: coarsenWindow(window.columns, rowFactor) }));
    counters.pages += 1;
    counters.windows += windows.length;
    counters.bytes += page.bytes;
    return {
      available: true,
      generation,
      geometry: { ...geometry, rowClusters: geometry.rowClusters * rowFactor, rowWidth: geometry.rowWidth * rowFactor },
      levelMs,
      rowFactor,
      span,
      windows,
      next: page.next,
    };
  }

  function pinnedStore(provider, symbol, marketKind) {
    const store = storeFor(pairKeyOf(provider, marketKind, symbol));
    if (store === null) {
      counters.missing += 1;
      return { store: null, answer: { available: false, reason: "NO_PYRAMID" } };
    }
    return { store, answer: null };
  }

  function readWallHistory(provider, symbol, marketKind, { fromTs, toTs, limit = DEFAULT_WALL_PAGE, after = null, minUsd, alwaysOutcomes }) {
    if ((minUsd !== undefined || alwaysOutcomes !== undefined) && String(provider).toLowerCase() !== "binance") {
      throw new Error("pyramid-reader: the size filter is only defined for Binance");
    }
    const { store, answer } = pinnedStore(provider, symbol, marketKind);
    if (store === null) return answer;
    const { geometry, generation, page, span } = store.snapshotWalls({ fromTs, toTs, limit, after, minUsd, alwaysOutcomes });
    if (geometry === null) return { available: false, reason: "NOT_PINNED" };
    counters.walls += page.walls.length;
    const filter = minUsd === undefined ? {} : { filter: { minUsd, alwaysOutcomes: [...new Set(alwaysOutcomes ?? [])].sort() } };
    const bands = String(provider).toLowerCase() === "binance" ? sizeBandsFor(pairKeyOf(provider, marketKind, symbol), store, generation, geometry.rowWidth) : null;
    return { available: true, generation, geometry, span, walls: page.walls, next: page.next, ...filter, ...(bands === null ? {} : { sizeBands: bands }) };
  }

  function readEventHistory(provider, symbol, marketKind, { fromTs, toTs }) {
    const { store, answer } = pinnedStore(provider, symbol, marketKind);
    if (store === null) return answer;
    const { geometry, generation, page, span } = store.snapshotEvents({ fromTs, toTs, maxBytes: pageBytes });
    if (geometry === null) return { available: false, reason: "NOT_PINNED" };
    counters.eventWindows += page.windows.length;
    return { available: true, generation, geometry, span, windows: page.windows, next: page.next };
  }

  const METHODS = Object.freeze({ readHeatmapColumns, readWallHistory, readEventHistory });

  function readAsync(methodName, symbol, marketKind, options, { provider = "binance" } = {}) {
    const method = METHODS[methodName];
    if (method === undefined) return Promise.reject(new Error(`pyramid-reader: unknown method ${methodName}`));
    return Promise.resolve().then(() => method(provider, symbol, marketKind, options));
  }

  function stats() {
    return { ...counters, open: stores.size };
  }

  function close() {
    for (const store of stores.values()) store.close();
    stores.clear();
  }

  return Object.freeze({ readHeatmapColumns, readWallHistory, readEventHistory, readAsync, stats, close });
}

module.exports = { createPyramidReader, pairKeyOf, coarsenWindow, ROW_FACTORS, DEFAULT_PAGE_BYTES };
