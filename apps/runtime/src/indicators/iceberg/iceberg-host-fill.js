const { validWireIceberg } = require("./iceberg-history");
const { intersectSpans } = require("./spans");
const { sizeCeilingFor } = require("../../server/wire-fields");

const DAY_MS = 86_400_000;
const DEFAULT_LOOKBACK_MS = 5 * DAY_MS;
const DEFAULT_PAGE_LIMIT = 2_000;
const DEFAULT_TRIES = 3;
const DEFAULT_MAX_IN_FLIGHT = 2;
const DEFAULT_MAX_PAGES = 64;
const DEFAULT_TAIL_MS = 600_000;
const DUPLICATE_WINDOW_MS = 30_000;
const WATCH_GAP_MS = 30_000;
const RETRY_WAITS_MS = Object.freeze([2_000, 5_000]);
const BACKOFF_FIRST_MS = 60_000;
const BACKOFF_MAX_MS = 1_800_000;
const BACKED_OFF = "HOST_BACKED_OFF";
const HOST_SILENT = new Set(["STORAGE_UNAVAILABLE", "READ_FAILED"]);
const SETTLED = new Set(["filled", "pulled", "replaced", "interrupted", "ended"]);

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function bridged(spans) {
  const out = [];
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last !== undefined && from - last[1] <= WATCH_GAP_MS) {
      if (to > last[1]) last[1] = to;
      continue;
    }
    out.push([from, to]);
  }
  return out;
}

function createIcebergHostFill({
  read,
  lookbackMs = DEFAULT_LOOKBACK_MS,
  pageLimit = DEFAULT_PAGE_LIMIT,
  tries = DEFAULT_TRIES,
  maxInFlight = DEFAULT_MAX_IN_FLIGHT,
  maxPages = DEFAULT_MAX_PAGES,
  tailMs = DEFAULT_TAIL_MS,
  now = () => Date.now(),
  wait = sleep,
  log = () => {},
} = {}) {
  if (typeof read !== "function") throw new Error("iceberg-host-fill: read must be a function");
  for (const [name, value] of [["lookbackMs", lookbackMs], ["pageLimit", pageLimit], ["tries", tries], ["maxInFlight", maxInFlight], ["maxPages", maxPages], ["tailMs", tailMs]]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`iceberg-host-fill: ${name} must be a positive safe integer`);
  }
  const counters = { fills: 0, gaps: 0, pages: 0, records: 0, refused: 0, duplicates: 0, unavailable: 0, failed: 0, retries: 0, incomplete: 0, backedOff: 0 };
  let inFlight = 0;
  const pauses = new Map();
  const waiting = [];

  function acquire() {
    if (inFlight < maxInFlight) {
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

  async function readPage(provider, symbol, marketKind, options) {
    for (let attempt = 0; ; attempt += 1) {
      let page = null;
      try {
        page = await read(provider, symbol, marketKind, options);
      } catch (error) {
        log(`iceberg-host-fill: ${marketKind}:${symbol} page failed: ${error?.message ?? error}`);
      }
      if (page && page.available === true) return page;
      if (page && page.available === false && page.reason !== "STORAGE_UNAVAILABLE" && page.reason !== "RATE_LIMITED") return page;
      if (attempt + 1 >= tries) {
        counters.failed += 1;
        return page ?? { available: false, reason: "READ_FAILED" };
      }
      counters.retries += 1;
      await wait(RETRY_WAITS_MS[Math.min(attempt, RETRY_WAITS_MS.length - 1)]);
    }
  }

  async function fillGap({ provider, symbol, marketKind, history }, [from, to]) {
    const found = [];
    let watched = null;
    let generation = null;
    let rulesVersion = null;
    let after = null;
    let complete = false;
    let reason = "MAX_PAGES";
    let landed = 0;
    for (let pages = 0; pages < maxPages; pages += 1) {
      await acquire();
      let page;
      try {
        page = await readPage(provider, symbol, marketKind, { fromTs: from, toTs: to, limit: pageLimit, ...(after === null ? {} : { after }) });
      } finally {
        release();
      }
      if (page.available !== true) {
        counters.unavailable += 1;
        if (pages === 0) return { covered: [], records: 0, recorded: [], reason: page.reason, pages: 0 };
        reason = page.reason;
        break;
      }
      counters.pages += 1;
      landed += 1;
      if (watched === null) {
        watched = page.watched;
        generation = page.generation;
        rulesVersion = page.rulesVersion;
      } else if (page.generation !== generation || page.rulesVersion !== rulesVersion) {
        reason = "GENERATION_CHANGED";
        break;
      }
      found.push(...page.icebergs);
      if (page.next === null) {
        complete = true;
        break;
      }
      after = page.next;
    }
    const until = complete ? to : after.markedAt;
    if (!complete) {
      counters.incomplete += 1;
      log(`iceberg-host-fill: ${marketKind}:${symbol} stopped paging (${reason}) after ${found.length} iceberg(s); watched only up to ${until}, the rest is asked at the next fill`);
    }
    const covered = intersectSpans([[from, until]], bridged(watched ?? []));
    const ceiling = sizeCeilingFor({ provider: String(provider).toUpperCase(), assetClass: marketKind });
    let records = 0;
    let refused = 0;
    const recorded = [];
    for (const entry of found) {
      if (!validWireIceberg(entry, ceiling) || !SETTLED.has(entry.status)) {
        refused += 1;
        continue;
      }
      if (!covered.some(([start, end]) => entry.markedAt >= start && entry.markedAt < end)) continue;
      const own = history.findNear(entry, DUPLICATE_WINDOW_MS);
      if (own !== null && own.origin === "runtime") {
        counters.duplicates += 1;
        continue;
      }
      const taken = Object.freeze({ ...entry, origin: "host" });
      const outcome = history.record(taken);
      records += outcome.added + outcome.updated;
      if (outcome.added + outcome.updated > 0) recorded.push(taken);
    }
    counters.refused += refused;
    if (refused > 0) log(`iceberg-host-fill: ${marketKind}:${symbol} refused ${refused} host iceberg(s) that are not settled or that the pair's page cannot carry`);
    for (const [start, end] of covered) history.watch(start, end);
    return { covered, records, recorded, reason: complete ? null : reason, pages: landed };
  }

  async function fill(target) {
    const { history } = target;
    if (!history || typeof history.uncovered !== "function") throw new Error("iceberg-host-fill: target.history is required");
    const at = now();
    const from = Math.max(0, at - lookbackMs, history.heldFrom());
    const to = at - tailMs;
    const gaps = to > from ? history.uncovered(from, to) : [];
    counters.fills += 1;
    counters.gaps += gaps.length;
    const outcome = { gaps: gaps.length, records: 0, watched: [], reasons: [], icebergs: [] };
    const pair = `${target.provider}:${target.marketKind}:${target.symbol}`;
    const pause = pauses.get(pair);
    if (gaps.length > 0 && pause !== undefined && at < pause.blockedUntil) {
      counters.backedOff += 1;
      outcome.reasons.push(BACKED_OFF);
      return outcome;
    }
    let landed = 0;
    let asked = 0;
    let silent = 0;
    for (const [start, end] of [...gaps].reverse()) {
      const held = Math.max(start, history.heldFrom());
      if (held >= end) continue;
      asked += 1;
      const result = await fillGap(target, [held, end]);
      landed += result.pages;
      outcome.records += result.records;
      counters.records += result.records;
      outcome.watched.push(...result.covered);
      outcome.icebergs.push(...result.recorded);
      if (result.reason !== null) outcome.reasons.push(result.reason);
      if (HOST_SILENT.has(result.reason)) {
        silent += 1;
        break;
      }
    }
    if (landed > 0) pauses.delete(pair);
    else if (asked > 0 && silent > 0) {
      const backoffMs = Math.min(BACKOFF_MAX_MS, pause === undefined ? BACKOFF_FIRST_MS : pause.backoffMs * 2);
      pauses.set(pair, { backoffMs, blockedUntil: now() + backoffMs });
      log(`iceberg-host-fill: ${target.marketKind}:${target.symbol} the host answered no gap; not asking again for ${Math.round(backoffMs / 1_000)} s`);
    }
    if (outcome.icebergs.length > 0) {
      const kept = new Set(history.list().map((entry) => entry.id));
      outcome.icebergs = outcome.icebergs.filter((entry) => kept.has(entry.id));
    }
    return outcome;
  }

  function stats() {
    return { ...counters };
  }

  return Object.freeze({ fill, stats });
}

module.exports = { createIcebergHostFill, DUPLICATE_WINDOW_MS, WATCH_GAP_MS, DEFAULT_LOOKBACK_MS, DEFAULT_PAGE_LIMIT, DEFAULT_TRIES, DEFAULT_MAX_IN_FLIGHT, DEFAULT_MAX_PAGES, DEFAULT_TAIL_MS, RETRY_WAITS_MS, BACKOFF_FIRST_MS, BACKOFF_MAX_MS, BACKED_OFF };
