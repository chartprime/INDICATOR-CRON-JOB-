"use strict";

const crypto = require("node:crypto");

const { createReplayPageReader, MAX_PAGES } = require("../../src/server/replay-page-reader");

const PIN_CURSOR_SECRET = "fixture-replay-pin-cursor-secret";
const DEFAULT_GEOMETRY = Object.freeze({ tickSize: 0.01, clusterTicks: 50, rowClusters: 8, windowRows: 1023 });

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function updateDigest(hash, page) {
  hash.update(JSON.stringify(canonical({ frames: page.frames, complete: page.complete, stats: page.stats })));
  hash.update("\n");
}

async function forEachPage({ provider = "binance", dbPath, symbol, marketKind, fromTs, toTs, geometry = DEFAULT_GEOMETRY, limits = {}, pageLimit = MAX_PAGES }, onPage) {
  const reader = createReplayPageReader({
    dbPath,
    dxfeedDbPath: dbPath,
    cursorSecret: PIN_CURSOR_SECRET,
    poolSize: 1,
    tickSizeResolver: { getBinanceTickSize: async () => geometry.tickSize, getDxFeedTickSize: () => geometry.tickSize },
    ...limits,
  });
  try {
    let cursor = null;
    for (let index = 0; index < pageLimit; index += 1) {
      const result = await reader.readAsync("readReplayPage", symbol, marketKind, { fromTs, toTs, ...geometry, cursor }, { provider });
      onPage({ frames: result.frames, complete: result.complete, stats: result.stats });
      if (result.complete) return true;
      cursor = result.nextCursor;
    }
    if (pageLimit === MAX_PAGES) throw new Error("fixture-replay-pin: replay did not complete within the page ceiling");
    return false;
  } finally {
    await reader.close();
  }
}

async function computeReplayPin(request) {
  const geometry = request.geometry ?? DEFAULT_GEOMETRY;
  const provider = request.provider ?? "binance";
  const hash = crypto.createHash("sha256");
  const totals = {};
  let pages = 0;
  let frames = 0;
  const complete = await forEachPage({ ...request, provider, geometry }, (page) => {
    updateDigest(hash, page);
    pages += 1;
    frames += page.frames.length;
    for (const [key, value] of Object.entries(page.stats ?? {})) totals[key] = (totals[key] ?? 0) + (Number.isSafeInteger(value) ? value : 0);
    request.onProgress?.({ pages, frames, complete: page.complete });
  });
  return {
    ...(provider === "binance" ? {} : { provider }),
    geometry: { ...geometry },
    limits: { maxFrames: request.limits?.maxFrames ?? null, maxBytes: request.limits?.maxBytes ?? null },
    ...(request.pinWindow === undefined ? {} : { window: { ...request.pinWindow } }),
    ...(request.pageLimit === undefined ? {} : { pageLimit: request.pageLimit, complete }),
    pages,
    frames,
    stats: Object.fromEntries(Object.entries(totals).sort(([left], [right]) => left < right ? -1 : 1)),
    sha256: hash.digest("hex"),
  };
}

module.exports = { computeReplayPin, forEachPage, updateDigest, canonical, DEFAULT_GEOMETRY, PIN_CURSOR_SECRET };
