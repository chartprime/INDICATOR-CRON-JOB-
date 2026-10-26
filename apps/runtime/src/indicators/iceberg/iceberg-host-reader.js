const { openIcebergHostStore, DEFAULT_PAGE } = require("./iceberg-host-store");

const MAX_PAGE_WATCHED_SPANS = 20_000;

function pairKeyOf(provider, marketKind, symbol) {
  return `${String(provider).toLowerCase()}:${marketKind}:${symbol}`;
}

function watchedIn(spans, fromTs, toTs) {
  if (toTs <= fromTs) return [];
  const out = [];
  for (const [from, to] of spans) {
    if (to <= fromTs) continue;
    if (from >= toTs || out.length === MAX_PAGE_WATCHED_SPANS) break;
    out.push([Math.max(from, fromTs), Math.min(to, toTs)]);
  }
  return out;
}

function createIcebergHostReader({ dir, open = openIcebergHostStore }) {
  if (typeof dir !== "string" || dir.length === 0) throw new Error("iceberg-host-reader: dir is required");
  const stores = new Map();
  const counters = { pages: 0, icebergs: 0, missing: 0 };

  function storeFor(pairKey) {
    const existing = stores.get(pairKey);
    if (existing !== undefined) return existing;
    const store = open({ dir, pairKey, readonly: true });
    if (store !== null) stores.set(pairKey, store);
    return store;
  }

  function readIcebergHistory(provider, symbol, marketKind, { fromTs, toTs, limit = DEFAULT_PAGE, after = null }) {
    const store = storeFor(pairKeyOf(provider, marketKind, symbol));
    if (store === null) {
      counters.missing += 1;
      return { available: false, reason: "NO_HISTORY" };
    }
    return store.readTransaction(() => {
      const checkpoint = store.checkpoint();
      if (checkpoint.cursor === null || checkpoint.settledThrough === null) return { available: false, reason: "NOT_BUILT" };
      const page = store.readPage({ fromTs, toTs, limit, after });
      counters.pages += 1;
      counters.icebergs += page.icebergs.length;
      return {
        available: true,
        generation: store.generation(),
        rulesVersion: store.rulesVersion(),
        span: { from: checkpoint.start, to: checkpoint.settledThrough },
        watched: watchedIn(store.watched(), fromTs, Math.min(toTs, checkpoint.settledThrough)),
        icebergs: page.icebergs,
        next: page.next,
      };
    });
  }

  const METHODS = Object.freeze({ readIcebergHistory });

  function readAsync(methodName, symbol, marketKind, options, { provider = "binance" } = {}) {
    const method = METHODS[methodName];
    if (method === undefined) return Promise.reject(new Error(`iceberg-host-reader: unknown method ${methodName}`));
    return Promise.resolve().then(() => method(provider, symbol, marketKind, options));
  }

  function stats() {
    return { ...counters, open: stores.size };
  }

  function close() {
    for (const store of stores.values()) store.close();
    stores.clear();
  }

  return Object.freeze({ readIcebergHistory, readAsync, stats, close });
}

module.exports = { createIcebergHostReader, pairKeyOf, MAX_PAGE_WATCHED_SPANS };
