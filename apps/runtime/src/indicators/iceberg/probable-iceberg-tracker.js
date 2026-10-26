const PROBABLE_STATUS = Object.freeze(["active", "ended"]);
const PROBABLE_CONFIDENCE = Object.freeze(["strong", "probable", "weak"]);
const SIDES = new Set(["bid", "ask"]);
const AGGRESSORS = new Set(["buy", "sell"]);
const DEFAULT_GAP_MS = 2000;
const DEFAULT_MAX_OPEN_EPISODES = 10_000;
const DEFAULT_MAX_LEVELS = 20_000;
const REFILL_LOW_SHARE = 0.5;
const REFILL_BACK_SHARE = 0.9;

function assertTs(ts) {
  if (!Number.isSafeInteger(ts) || ts < 0) throw new Error("probable-iceberg-tracker: ts must be a non-negative safe integer");
}

function assertPrice(price) {
  if (!Number.isFinite(price) || price <= 0) throw new Error("probable-iceberg-tracker: price must be a positive finite number");
}

function createProbableIcebergTracker({ symbol, marketKind, cuts, gapMs = DEFAULT_GAP_MS, maxOpenEpisodes = DEFAULT_MAX_OPEN_EPISODES, maxLevels = DEFAULT_MAX_LEVELS } = {}) {
  if (typeof symbol !== "string" || symbol.length === 0) throw new Error("probable-iceberg-tracker: symbol must be a non-empty string");
  if (typeof marketKind !== "string" || marketKind.length === 0) throw new Error("probable-iceberg-tracker: marketKind must be a non-empty string");
  if (!cuts || typeof cuts.current !== "function" || typeof cuts.observeTouch !== "function" || typeof cuts.observeEpisode !== "function") {
    throw new Error("probable-iceberg-tracker: cuts must provide current, observeTouch and observeEpisode");
  }
  if (!Number.isSafeInteger(gapMs) || gapMs <= 0) throw new Error("probable-iceberg-tracker: gapMs must be a positive safe integer");
  if (!Number.isSafeInteger(maxOpenEpisodes) || maxOpenEpisodes <= 0) throw new Error("probable-iceberg-tracker: maxOpenEpisodes must be a positive safe integer");
  if (!Number.isSafeInteger(maxLevels) || maxLevels <= 0) throw new Error("probable-iceberg-tracker: maxLevels must be a positive safe integer");

  const levels = new Map();
  const open = new Map();
  let lastTradePrice = null;
  let lastDepthPrice = null;

  function level(side, price) {
    const key = `${side}|${price}`;
    let entry = levels.get(key);
    if (!entry) {
      entry = { key, side, price, visible: 0, seen: false, episode: null };
      levels.set(key, entry);
    }
    return entry;
  }

  function dropIfEmpty(entry) {
    if (entry.visible === 0) levels.delete(entry.key);
  }

  function forgetFarLevels() {
    if (levels.size <= maxLevels) return;
    const reference = lastTradePrice ?? lastDepthPrice;
    const idle = [];
    for (const entry of levels.values()) if (entry.episode === null) idle.push(entry);
    idle.sort((a, b) => Math.abs(b.price - reference) - Math.abs(a.price - reference));
    const excess = levels.size - (maxLevels - Math.floor(maxLevels / 8));
    for (let i = 0; i < excess && i < idle.length; i += 1) levels.delete(idle[i].key);
  }

  function snapshot(episode, status, ts) {
    const ratio = episode.display > 0 ? episode.executed / episode.display : 0;
    const updatedAt = Math.max(ts, episode.markedAt, episode.emittedAt);
    return Object.freeze({
      id: `${symbol}|${marketKind}|${episode.side}|${episode.price}|${episode.startedAt}`,
      symbol,
      marketKind,
      kind: "probable",
      confidence: episode.confidence,
      side: episode.side,
      price: episode.price,
      display: episode.display,
      tranches: episode.refills + 1,
      refills: episode.refills,
      hits: episode.hits,
      executed: episode.executed,
      ratio,
      durationMs: episode.lastHitAt - episode.startedAt,
      startedAt: episode.startedAt,
      markedAt: episode.markedAt,
      updatedAt,
      status,
    });
  }

  function confidenceFor(ratio, current) {
    if (ratio < current.ratioCut) return "weak";
    if (current.strongRatio !== null && ratio >= current.strongRatio) return "strong";
    return "probable";
  }

  function isSolid(episode) {
    if (episode.display <= 0) return false;
    return episode.floorAtOpen === null || episode.display >= episode.floorAtOpen;
  }

  function evaluate(episode, ts) {
    const current = cuts.current();
    if (!current.ready || current.ratioCut === null || !isSolid(episode)) return null;
    const durationMs = episode.lastHitAt - episode.startedAt;
    const ratio = episode.executed / episode.display;
    if (durationMs < current.minDurationMs) return null;
    if (ratio < current.ratioCut && episode.markedAt === null) return null;
    if (episode.markedAt === null) episode.markedAt = Math.max(ts, episode.startedAt);
    episode.confidence = confidenceFor(ratio, current);
    const signature = `${episode.executed}|${episode.display}|${episode.refills}|${episode.confidence}`;
    if (signature === episode.emitted) return null;
    episode.emitted = signature;
    const update = snapshot(episode, "active", ts);
    episode.emittedAt = update.updatedAt;
    return update;
  }

  function close(episode, ts) {
    open.delete(episode.level.key);
    episode.level.episode = null;
    dropIfEmpty(episode.level);
    const ratio = episode.display > 0 ? episode.executed / episode.display : 0;
    cuts.observeEpisode({ ratio, durationMs: episode.lastHitAt - episode.startedAt, solid: isSolid(episode), hits: episode.hits });
    if (episode.markedAt === null) return null;
    const current = cuts.current();
    if (current.ready && current.ratioCut !== null) episode.confidence = confidenceFor(ratio, current);
    return snapshot(episode, "ended", ts);
  }

  function dropQuietestUnmarked() {
    let quietest = null;
    for (const episode of open.values()) {
      if (episode.markedAt !== null) continue;
      if (quietest === null || episode.lastHitAt < quietest.lastHitAt) quietest = episode;
    }
    if (quietest === null) return false;
    open.delete(quietest.level.key);
    quietest.level.episode = null;
    dropIfEmpty(quietest.level);
    return true;
  }

  function openEpisode(entry, ts) {
    if (open.size >= maxOpenEpisodes && !dropQuietestUnmarked()) return null;
    const current = cuts.current();
    if (entry.seen && entry.visible > 0) cuts.observeTouch(entry.visible);
    const floorAtOpen = current.ready && Number.isFinite(current.visibleFloor) ? current.visibleFloor : null;
    const episode = {
      level: entry,
      side: entry.side,
      price: entry.price,
      startedAt: ts,
      lastHitAt: ts,
      executed: 0,
      hits: 0,
      display: entry.visible,
      low: entry.visible,
      refills: 0,
      floorAtOpen,
      markedAt: null,
      confidence: "probable",
      emitted: null,
      emittedAt: 0,
    };
    entry.episode = episode;
    levels.set(entry.key, entry);
    open.set(entry.key, episode);
    return episode;
  }

  function applyTrade({ price, size, aggressor, ts } = {}) {
    assertPrice(price);
    if (!Number.isFinite(size) || size <= 0) throw new Error("probable-iceberg-tracker: size must be a positive finite number");
    if (!AGGRESSORS.has(aggressor)) throw new Error("probable-iceberg-tracker: aggressor must be buy or sell");
    assertTs(ts);
    lastTradePrice = price;
    const entry = level(aggressor === "sell" ? "bid" : "ask", price);
    let ended = null;
    if (entry.episode && ts - entry.episode.lastHitAt > gapMs) ended = close(entry.episode, ts);
    const episode = entry.episode ?? openEpisode(entry, ts);
    if (episode === null) {
      dropIfEmpty(entry);
      return ended;
    }
    episode.executed += size;
    episode.hits += 1;
    episode.lastHitAt = Math.max(episode.lastHitAt, ts);
    return ended ?? evaluate(episode, ts);
  }

  function applyDepth({ side, price, size, ts } = {}) {
    if (!SIDES.has(side)) throw new Error("probable-iceberg-tracker: side must be bid or ask");
    assertPrice(price);
    if (!Number.isFinite(size) || size < 0) throw new Error("probable-iceberg-tracker: size must be a finite non-negative number");
    assertTs(ts);
    lastDepthPrice = price;
    const entry = level(side, price);
    entry.visible = size;
    entry.seen = true;
    const episode = entry.episode;
    if (!episode) {
      dropIfEmpty(entry);
      forgetFarLevels();
      return null;
    }
    if (ts - episode.lastHitAt > gapMs) return close(episode, ts);
    if (episode.display === 0) {
      episode.display = size;
      episode.low = size;
      return evaluate(episode, ts);
    }
    if (size > episode.display) episode.display = size;
    if (size < episode.low) episode.low = size;
    if (episode.low <= REFILL_LOW_SHARE * episode.display && size >= REFILL_BACK_SHARE * episode.display && size > episode.low) {
      episode.refills += 1;
      episode.low = size;
    }
    return evaluate(episode, ts);
  }

  function sweep(ts) {
    assertTs(ts);
    const ended = [];
    for (const episode of [...open.values()]) {
      if (ts - episode.lastHitAt <= gapMs) continue;
      const update = close(episode, ts);
      if (update) ended.push(update);
    }
    return Object.freeze(ended);
  }

  function reset(ts) {
    assertTs(ts);
    const ended = [];
    for (const episode of open.values()) if (episode.markedAt !== null) ended.push(snapshot(episode, "ended", ts));
    open.clear();
    levels.clear();
    lastTradePrice = null;
    lastDepthPrice = null;
    return Object.freeze(ended);
  }

  function active() {
    const out = [];
    for (const episode of open.values()) {
      if (episode.markedAt !== null) out.push(snapshot(episode, "active", episode.lastHitAt));
    }
    return Object.freeze(out);
  }

  function openEpisodes() {
    return open.size;
  }

  function trackedLevels() {
    return levels.size;
  }

  return Object.freeze({ applyTrade, applyDepth, sweep, reset, active, openEpisodes, trackedLevels });
}

module.exports = { createProbableIcebergTracker, PROBABLE_STATUS, PROBABLE_CONFIDENCE, DEFAULT_GAP_MS, DEFAULT_MAX_OPEN_EPISODES, DEFAULT_MAX_LEVELS };
