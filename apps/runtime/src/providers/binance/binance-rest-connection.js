// The REST polling transport for Binance SPOT candles: the same surface as
// binance-connection.js (what market-data-server.js duck-types), emitting the
// same canonical KLINE envelopes through the same normalizer, for a host that
// cannot open a WebSocket. It serves 1m candles only: open, high, low, close,
// volume, taker-buy volume and trade count, forming and closed. There is no
// tape and no order book; both are reported unavailable, never approximated.
const {
  MARKET_KINDS,
  EVENT_TYPES,
  createBinanceMarketKindContext,
  restBaseUrlFor,
  resolveBinanceEndpoints,
  candleIntervalMsFor,
  listAllowedSymbols,
  DEFAULT_BINANCE_ENDPOINTS,
} = require("./binance-config");
const { describeBinanceSubscription, safeTelemetrySymbol } = require("./binance-subscription-guard");
const { emitTelemetry } = require("../../platform/telemetry");
const { normalizeBinanceEvent, parseKlineRows } = require("./binance-event-normalizer");
const { fetchKlines, fetchExchangeInfo, fetchServerTime, DEFAULT_TIMEOUT_MS } = require("./binance-http-client");
const { createBinanceFeedHealthMonitor } = require("./binance-feed-health");
const { createBinanceKlineBackfill } = require("./binance-kline-backfill");
const {
  createBinanceRestWeightBudget,
  planCadence,
  REQUEST_WEIGHTS,
  DEFAULT_WEIGHT_BUDGET_PER_MINUTE,
} = require("./binance-rest-weight-budget");
const { createBinanceRestBarCursor, DEFAULT_FINALIZE_GRACE_MS } = require("./binance-rest-bar-cursor");

const TRANSPORTS = Object.freeze({ WS: "ws", REST: "rest" });
const DEFAULT_POLL_MS = 1000;
const MIN_POLL_MS = 250;
// A catch-up page holds up to 1000 candles (the klines limit); at most this
// many pages are fetched back to back before the poller yields for a cadence.
const DEFAULT_MAX_CATCH_UP_PAGES = 10;
const DEFAULT_CLOCK_REFRESH_MS = 60_000;
const DEFAULT_BAN_MS = 120_000;
const CONSECUTIVE_FAILURES_BEFORE_DISCONNECT = 3;
const BACKOFF_BASE_DELAY_MS = 1000;
const BACKOFF_MAX_DELAY_MS = 30_000;
const BACKOFF_JITTER_RATIO = 0.2;
const MAX_LISTENERS = 50;
const ROUTE_NAME = "public";

const BOOK_UNAVAILABLE_REASON = "REST_NO_DEPTH";
const BOOK_UNAVAILABLE = Object.freeze({ status: "UNAVAILABLE", reason: BOOK_UNAVAILABLE_REASON });
// The trader-facing reason: what this feed is, in the words the chart shows.
const HEALTH_REASON_BASE = "Polled spot candles · no tape · no order book";
const HEALTH_REASON_VARIANTS = Object.freeze({
  RATE_LIMITED: "rate limited",
  POLL_FAILED: "poll failed",
  CATCHING_UP: "catching up",
  SLOW_POLLING: "slow polling (weight budget)",
});
const SERVED_EVENT_TYPES = new Set([EVENT_TYPES.KLINE]);
const TRANSPORT_FAILURE_REASONS = new Set([
  "NETWORK_ERROR", "TIMEOUT", "HTTP_ERROR", "INVALID_RESPONSE", "MALFORMED_RESPONSE_BODY", "RESPONSE_TOO_LARGE", "FETCH_UNAVAILABLE",
]);
const PERPETUAL_STATUS = Object.freeze({ public: "DISCONNECTED", market: "DISCONNECTED" });

function binanceTransportFromEnv(env = process.env) {
  const raw = env.TT_BINANCE_TRANSPORT;
  if (raw === undefined || raw.trim() === "") return TRANSPORTS.WS;
  const value = raw.trim();
  if (!Object.values(TRANSPORTS).includes(value)) {
    throw new Error(`TT_BINANCE_TRANSPORT must be ${Object.values(TRANSPORTS).join(" or ")}`);
  }
  return value;
}

function assertConsumerId(consumerId) {
  if (typeof consumerId !== "string" || consumerId.length === 0) {
    throw new Error("A non-empty consumerId is required to subscribe or unsubscribe.");
  }
}

function pollerKey(descriptor) {
  return JSON.stringify([descriptor.marketKind, descriptor.symbol, descriptor.eventType, descriptor.interval ?? null]);
}

function createBinanceRestConnection(options = {}) {
  const {
    telemetry,
    fetchImpl = globalThis.fetch,
    endpoints = DEFAULT_BINANCE_ENDPOINTS,
    pollMs = DEFAULT_POLL_MS,
    weightBudgetPerMinute = DEFAULT_WEIGHT_BUDGET_PER_MINUTE,
    now = () => Date.now(),
    random = Math.random,
    probeSymbol = listAllowedSymbols()[0],
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
    clockRefreshMs = DEFAULT_CLOCK_REFRESH_MS,
    maxCatchUpPages = DEFAULT_MAX_CATCH_UP_PAGES,
    finalizeGraceMs = DEFAULT_FINALIZE_GRACE_MS,
    defaultBanMs = DEFAULT_BAN_MS,
  } = options;

  if (!Number.isSafeInteger(pollMs) || pollMs < MIN_POLL_MS) {
    throw new Error(`pollMs must be a safe integer of at least ${MIN_POLL_MS}.`);
  }
  for (const [name, value] of [
    ["requestTimeoutMs", requestTimeoutMs],
    ["clockRefreshMs", clockRefreshMs],
    ["maxCatchUpPages", maxCatchUpPages],
    ["defaultBanMs", defaultBanMs],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer.`);
  }
  if (typeof now !== "function" || typeof random !== "function") {
    throw new Error("now and random must be functions.");
  }
  const resolvedEndpoints = resolveBinanceEndpoints(endpoints);
  const spotBaseUrl = restBaseUrlFor(MARKET_KINDS.SPOT, resolvedEndpoints);
  const marketKindContexts = Object.freeze({
    SPOT: createBinanceMarketKindContext(MARKET_KINDS.SPOT, resolvedEndpoints),
    PERPETUAL: createBinanceMarketKindContext(MARKET_KINDS.PERPETUAL, resolvedEndpoints),
  });
  const feedHealth = createBinanceFeedHealthMonitor({ now });
  const budget = createBinanceRestWeightBudget({ budgetPerMinute: weightBudgetPerMinute, now });
  const klineBackfill = createBinanceKlineBackfill({ fetchImpl: meteredFetch, telemetry, endpoints: resolvedEndpoints });

  const messageListeners = new Set();
  const errorListeners = new Set();
  const pollers = new Map();
  const probe = { inflight: null, timer: null, attempt: 0 };
  const clock = { inflight: null, timer: null };
  let accepting = false;
  let sessionGeneration = 0;
  let routeState = "DISCONNECTED";
  let exchangeOffsetMs = 0;
  let clockSyncedAtMs = null;
  let banUntilMs = 0;
  let rateLimitedUntilMs = 0;
  let consecutiveTransportFailures = 0;
  let plan = planCadence({ klinePollers: 0, pollMs, budgetPerMinute: weightBudgetPerMinute });
  const counters = { polls: 0, pollFailures: 0, budgetDeferrals: 0, emitted: 0, probes: 0, clockSyncs: 0, clockRefreshFailures: 0 };

  /** The exchange's clock as this process last measured it; rows are classified against it, never against the machine. */
  function exchangeNow() {
    return now() + exchangeOffsetMs;
  }

  function telemetryEvent(name, fields = {}) {
    emitTelemetry(telemetry, `market_data.binance_rest.${name}`, fields);
  }

  function safelyInvokeListener(listener, payload) {
    try {
      listener(payload);
    } catch (error) {
      console.error("binance rest listener failed", error?.message ?? error);
    }
  }

  function notifyMessageListeners(envelope) {
    counters.emitted += 1;
    for (const listener of [...messageListeners]) safelyInvokeListener(listener, envelope);
  }

  function notifyErrorListeners(payload) {
    for (const listener of [...errorListeners]) safelyInvokeListener(listener, Object.freeze(payload));
  }

  // Wraps fetch for the candle backfill: each page's weight is reserved first
  // and the exchange's own count is read back from the response.
  async function meteredFetch(url, init) {
    while (!budget.reserve(REQUEST_WEIGHTS.KLINES)) {
      counters.budgetDeferrals += 1;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, budget.msUntilReset());
        timer.unref?.();
      });
    }
    const response = await Reflect.apply(fetchImpl, undefined, [url, init]);
    try {
      budget.observe(Object.fromEntries(response.headers.entries()));
    } catch {
      void 0;
    }
    return response;
  }

  function setRouteState(next, fields = {}) {
    if (routeState === next) return;
    routeState = next;
    if (next === "CONNECTED") feedHealth.recordRouteConnected(MARKET_KINDS.SPOT, ROUTE_NAME);
    else feedHealth.recordRouteDisconnected(MARKET_KINDS.SPOT, ROUTE_NAME);
    telemetryEvent(next === "CONNECTED" ? "route_connected" : "route_disconnected", { state: next, ...fields });
  }

  function backoffDelayMs(attempt) {
    const raw = Math.min(BACKOFF_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_MAX_DELAY_MS);
    const jitter = raw * BACKOFF_JITTER_RATIO * (random() * 2 - 1);
    return Math.max(0, Math.round(raw + jitter));
  }

  function clearTimer(holder) {
    if (holder.timer) clearTimeout(holder.timer);
    holder.timer = null;
  }

  function schedule(holder, delayMs, run) {
    clearTimer(holder);
    const generationAtSchedule = sessionGeneration;
    holder.timer = setTimeout(() => {
      holder.timer = null;
      if (!accepting || generationAtSchedule !== sessionGeneration) return;
      run().catch((error) => {
        notifyErrorListeners({ marketKind: MARKET_KINDS.SPOT, route: ROUTE_NAME, message: error?.message ?? String(error), code: "REST_INTERNAL" });
      });
    }, Math.max(0, delayMs));
    holder.timer.unref?.();
  }

  function waitBeforeDispatchMs() {
    const at = now();
    return Math.max(0, banUntilMs - at, rateLimitedUntilMs - at);
  }

  function requestOptions(signal) {
    return { fetchImpl, baseUrl: spotBaseUrl, timeoutMs: requestTimeoutMs, signal };
  }

  function observeWeight(result) {
    const headers = result.ok ? result.value.headers : result.headers;
    if (headers) budget.observe(headers);
  }

  function applyServerTime(serverTime, sentAt, receivedAt) {
    exchangeOffsetMs = serverTime - Math.round((sentAt + receivedAt) / 2);
    clockSyncedAtMs = receivedAt;
    counters.clockSyncs += 1;
  }

  // The route is up once exchangeInfo (weight 20) answers: it proves the
  // origin, the proxy and the symbol, and its serverTime seeds the exchange
  // clock every candle is classified against.
  async function runProbe() {
    if (!accepting || probe.inflight) return;
    const wait = waitBeforeDispatchMs();
    if (wait > 0) {
      schedule(probe, wait, runProbe);
      return;
    }
    if (!budget.reserve(REQUEST_WEIGHTS.EXCHANGE_INFO)) {
      counters.budgetDeferrals += 1;
      schedule(probe, budget.msUntilReset(), runProbe);
      return;
    }
    const controller = new AbortController();
    probe.inflight = controller;
    const generation = sessionGeneration;
    const sentAt = now();
    counters.probes += 1;
    let result;
    try {
      result = await fetchExchangeInfo(MARKET_KINDS.SPOT, probeSymbol, requestOptions(controller.signal));
    } catch {
      result = Object.freeze({ ok: false, reason: "NETWORK_ERROR" });
    }
    probe.inflight = null;
    if (!accepting || generation !== sessionGeneration) return;
    const receivedAt = now();
    observeWeight(result);
    const serverTime = result.ok ? result.value.body?.serverTime : undefined;
    if (!result.ok || !Number.isSafeInteger(serverTime)) {
      probe.attempt += 1;
      telemetryEvent("probe_failed", { reason: result.ok ? "MALFORMED_RESPONSE_BODY" : result.reason, attempt: probe.attempt });
      if (!result.ok) noteRequestFailure(result);
      schedule(probe, Math.max(waitBeforeDispatchMs(), backoffDelayMs(probe.attempt)), runProbe);
      return;
    }
    probe.attempt = 0;
    applyServerTime(serverTime, sentAt, receivedAt);
    consecutiveTransportFailures = 0;
    setRouteState("CONNECTED");
    scheduleClockRefresh();
    for (const poller of pollers.values()) schedulePoll(poller, 0);
  }

  // The exchange clock is re-read from /api/v3/time (weight 1, reserved like
  // every request) once a minute; a failed refresh keeps the last offset.
  function scheduleClockRefresh() {
    schedule(clock, clockRefreshMs, refreshClock);
  }

  async function refreshClock() {
    if (!accepting || routeState !== "CONNECTED" || clock.inflight) return;
    if (waitBeforeDispatchMs() > 0 || !budget.reserve(REQUEST_WEIGHTS.SERVER_TIME)) {
      counters.budgetDeferrals += 1;
      scheduleClockRefresh();
      return;
    }
    const controller = new AbortController();
    clock.inflight = controller;
    const generation = sessionGeneration;
    const sentAt = now();
    let result;
    try {
      result = await fetchServerTime(MARKET_KINDS.SPOT, requestOptions(controller.signal));
    } catch {
      result = Object.freeze({ ok: false, reason: "NETWORK_ERROR" });
    }
    clock.inflight = null;
    if (!accepting || generation !== sessionGeneration) return;
    observeWeight(result);
    if (result.ok && Number.isSafeInteger(result.value.body?.serverTime)) {
      applyServerTime(result.value.body.serverTime, sentAt, now());
    } else {
      counters.clockRefreshFailures += 1;
      telemetryEvent("clock_refresh_failed", { reason: result.ok ? "MALFORMED_RESPONSE_BODY" : result.reason });
    }
    scheduleClockRefresh();
  }

  // Bookkeeping shared by every failed request: 429 pauses everything until
  // Retry-After (or the backoff); 418 is an IP ban that stops polling for the
  // whole window; three transport failures in a row mean the route is down.
  function noteRequestFailure(result) {
    counters.pollFailures += 1;
    const at = now();
    if (result.reason === "IP_BANNED") {
      banUntilMs = Math.max(banUntilMs, at + (result.retryAfterMs ?? defaultBanMs));
      telemetryEvent("ip_banned", { untilMs: banUntilMs, retryAfterMs: result.retryAfterMs ?? null });
      notifyErrorListeners({ marketKind: MARKET_KINDS.SPOT, route: ROUTE_NAME, message: "Binance banned this IP; polling stops for the Retry-After window.", code: 418 });
      setRouteState("DISCONNECTED", { reason: "IP_BANNED" });
      schedule(probe, banUntilMs - at, runProbe);
      return;
    }
    if (result.reason === "RATE_LIMITED") {
      rateLimitedUntilMs = Math.max(rateLimitedUntilMs, at + (result.retryAfterMs ?? backoffDelayMs(1)));
      telemetryEvent("rate_limited", { untilMs: rateLimitedUntilMs, retryAfterMs: result.retryAfterMs ?? null });
      return;
    }
    if (TRANSPORT_FAILURE_REASONS.has(result.reason)) {
      consecutiveTransportFailures += 1;
      if (routeState === "CONNECTED" && consecutiveTransportFailures >= CONSECUTIVE_FAILURES_BEFORE_DISCONNECT) {
        notifyErrorListeners({ marketKind: MARKET_KINDS.SPOT, route: ROUTE_NAME, message: "Binance REST polling failed repeatedly; the route is down until a probe succeeds." });
        setRouteState("DISCONNECTED", { reason: result.reason });
        schedule(probe, backoffDelayMs(1), runProbe);
      }
    }
  }

  function replan() {
    plan = planCadence({ klinePollers: pollers.size, pollMs, budgetPerMinute: weightBudgetPerMinute });
  }

  function createPoller(descriptor) {
    return {
      descriptor,
      key: pollerKey(descriptor),
      timer: null,
      inflight: null,
      epoch: 0,
      seq: 0,
      attempt: 0,
      catchUpPages: 0,
      catchingUp: false,
      lastFailureReason: null,
      lastLatencyMs: null,
      lastSuccessAtMs: null,
      lastSentAtMs: null,
      budgetDeferred: false,
      bars: createBinanceRestBarCursor({ intervalMs: candleIntervalMsFor(descriptor.interval), finalizeGraceMs }),
    };
  }

  function resetPollerState(poller) {
    poller.bars.reset();
    poller.catchUpPages = 0;
    poller.catchingUp = false;
    poller.attempt = 0;
  }

  function schedulePoll(poller, delayMs) {
    schedule(poller, delayMs, () => runPoll(poller));
  }

  function scheduleNextPoll(poller, { immediate = false } = {}) {
    if (immediate) {
      schedulePoll(poller, 0);
      return;
    }
    const elapsed = poller.lastSentAtMs === null ? 0 : now() - poller.lastSentAtMs;
    schedulePoll(poller, Math.max(0, plan.klineCadenceMs - elapsed));
  }

  function beginRecovery(poller) {
    const { marketKind, symbol, eventType, interval } = poller.descriptor;
    feedHealth.beginRecovery(marketKind, symbol, eventType, interval);
  }

  function endRecovery(poller) {
    const { marketKind, symbol, eventType, interval } = poller.descriptor;
    feedHealth.endRecovery(marketKind, symbol, eventType, interval);
  }

  async function runPoll(poller) {
    if (!accepting || routeState !== "CONNECTED" || poller.inflight || pollers.get(poller.key) !== poller) return;
    const wait = waitBeforeDispatchMs();
    if (wait > 0) {
      schedulePoll(poller, wait);
      return;
    }
    // Weight is reserved before dispatch; a refusal waits for the next minute.
    if (!budget.reserve(REQUEST_WEIGHTS.KLINES)) {
      counters.budgetDeferrals += 1;
      poller.budgetDeferred = true;
      telemetryEvent("poll_deferred_by_budget", { symbol: safeTelemetrySymbol(poller.descriptor.symbol) });
      schedulePoll(poller, budget.msUntilReset());
      return;
    }
    poller.budgetDeferred = false;
    const controller = new AbortController();
    const epochAtRequest = poller.epoch;
    const generationAtRequest = sessionGeneration;
    const seq = ++poller.seq;
    poller.inflight = controller;
    poller.lastSentAtMs = now();
    counters.polls += 1;
    const request = poller.bars.nextRequest(exchangeNow());
    let result;
    try {
      result = await fetchKlines(MARKET_KINDS.SPOT, poller.descriptor.symbol, {
        ...requestOptions(controller.signal),
        interval: poller.descriptor.interval,
        startTime: request.startTime,
        limit: request.limit,
      });
    } catch (error) {
      result = Object.freeze({ ok: false, reason: error?.name === "AbortError" ? "ABORTED" : "NETWORK_ERROR" });
    }
    if (poller.inflight === controller) poller.inflight = null;
    // A response for a subscription that ended, or from a session that was
    // disconnected, is thrown away whatever it says.
    if (!accepting || generationAtRequest !== sessionGeneration || epochAtRequest !== poller.epoch || pollers.get(poller.key) !== poller) return;
    const receivedAt = now();
    poller.lastLatencyMs = receivedAt - poller.lastSentAtMs;
    observeWeight(result);
    if (!result.ok) {
      onPollFailure(poller, result);
      return;
    }
    const outcome = applyKlinePage(poller, result.value.body, receivedAt, seq);
    if (outcome.malformed) {
      onPollFailure(poller, Object.freeze({ ok: false, reason: "MALFORMED_RESPONSE_BODY" }));
      return;
    }
    consecutiveTransportFailures = 0;
    poller.attempt = 0;
    poller.lastFailureReason = null;
    poller.lastSuccessAtMs = receivedAt;
    if (outcome.complete) endRecovery(poller);
    scheduleNextPoll(poller, { immediate: outcome.immediate });
  }

  function onPollFailure(poller, result) {
    poller.attempt += 1;
    poller.lastFailureReason = result.reason;
    poller.catchUpPages = 0;
    beginRecovery(poller);
    telemetryEvent("poll_failed", {
      symbol: safeTelemetrySymbol(poller.descriptor.symbol),
      reason: result.reason,
      status: result.status ?? null,
      attempt: poller.attempt,
    });
    noteRequestFailure(result);
    if (routeState !== "CONNECTED") return;
    schedulePoll(poller, Math.max(waitBeforeDispatchMs(), backoffDelayMs(poller.attempt)));
  }

  function emitEnvelope(poller, raw, receivedAtMs) {
    const { marketKind, symbol, eventType, interval } = poller.descriptor;
    const envelope = normalizeBinanceEvent({ marketKind, symbol, eventType, interval, raw }, { receivedAtMs });
    const health = feedHealth.computeContext({ marketKind, symbol, eventType, interval, routeConnected: routeState === "CONNECTED", nowMs: now() });
    notifyMessageListeners(Object.freeze({ ...envelope, stale: health.stale, recoveryState: health.recoveryState }));
  }

  function applyKlinePage(poller, body, receivedAt, seq) {
    const { marketKind, symbol, eventType, interval } = poller.descriptor;
    const rows = parseKlineRows(body, candleIntervalMsFor(interval));
    if (rows === null) return { malformed: true };
    // A successful poll is an observation of the pair; only a failed poll
    // leaves the feed to go stale, as a dead stream would.
    feedHealth.recordEvent(marketKind, symbol, eventType, interval, receivedAt);
    const outcome = poller.bars.apply({ rows, exchangeNowMs: exchangeNow(), seq });
    if (outcome.stale) {
      telemetryEvent("kline_poll_superseded", { symbol: safeTelemetrySymbol(symbol) });
      return { malformed: false, complete: !poller.catchingUp, immediate: false };
    }
    if (outcome.hole) telemetryEvent("kline_hole", { symbol: safeTelemetrySymbol(symbol), confirmedOpenTime: poller.bars.confirmedOpenTime });
    for (const { row, closed } of outcome.emit) {
      emitEnvelope(poller, {
        e: "kline",
        E: receivedAt,
        s: symbol,
        k: {
          t: row.openTime,
          T: row.closeTime,
          s: symbol,
          i: interval,
          o: row.open,
          c: row.close,
          h: row.high,
          l: row.low,
          v: row.volume,
          n: row.numberOfTrades,
          x: closed,
          q: row.quoteVolume,
          V: row.takerBuyBaseVolume,
          Q: row.takerBuyQuoteVolume,
        },
      }, receivedAt);
    }
    if (outcome.catchingUp) {
      // Behind by more than one bar: the next request continues from the
      // confirmed close, in pages of up to 1000, at most maxCatchUpPages in a
      // row before the poller yields for a cadence and continues.
      if (!poller.catchingUp) telemetryEvent("kline_catch_up_started", { symbol: safeTelemetrySymbol(symbol), confirmedOpenTime: poller.bars.confirmedOpenTime });
      poller.catchingUp = true;
      beginRecovery(poller);
      poller.catchUpPages += 1;
      if (poller.catchUpPages >= maxCatchUpPages) {
        poller.catchUpPages = 0;
        return { malformed: false, complete: false, immediate: false };
      }
      return { malformed: false, complete: false, immediate: true };
    }
    if (poller.catchingUp) telemetryEvent("kline_catch_up_completed", { symbol: safeTelemetrySymbol(symbol), confirmedOpenTime: poller.bars.confirmedOpenTime });
    poller.catchingUp = false;
    poller.catchUpPages = 0;
    return { malformed: false, complete: true, immediate: false };
  }

  function connect() {
    accepting = true;
    for (const poller of pollers.values()) resetPollerState(poller);
    if (routeState === "DISCONNECTED") routeState = "CONNECTING";
    schedule(probe, 0, runProbe);
  }

  function abortAll() {
    for (const holder of [probe, clock, ...pollers.values()]) {
      clearTimer(holder);
      holder.inflight?.abort();
      holder.inflight = null;
    }
  }

  function disconnect() {
    accepting = false;
    sessionGeneration += 1;
    abortAll();
    probe.attempt = 0;
    banUntilMs = 0;
    rateLimitedUntilMs = 0;
    consecutiveTransportFailures = 0;
    for (const poller of pollers.values()) resetPollerState(poller);
    setRouteState("DISCONNECTED", { reason: "DISCONNECT" });
  }

  function getStatus() {
    return Object.freeze({
      SPOT: Object.freeze({ public: routeState }),
      PERPETUAL: PERPETUAL_STATUS,
    });
  }

  function registryFor(marketKind) {
    return marketKindContexts[marketKind].subscriptionRegistry;
  }

  function subscribeMany(requests, consumerId) {
    assertConsumerId(consumerId);
    if (!Array.isArray(requests) || requests.length === 0) {
      throw new Error("subscribeMany() requires a non-empty array of subscription requests.");
    }
    const descriptors = requests.map((request) => describeBinanceSubscription(request));
    const added = [];
    const rollback = () => {
      for (const descriptor of added) {
        registryFor(descriptor.marketKind).remove(descriptor.symbol, descriptor.eventType, consumerId, descriptor.interval);
      }
    };
    for (const descriptor of descriptors) {
      const isNewOnWire = registryFor(descriptor.marketKind).add(descriptor.symbol, descriptor.eventType, consumerId, undefined, descriptor.interval);
      if (isNewOnWire) added.push(descriptor);
    }
    for (const descriptor of descriptors) {
      // Perpetuals have no REST mirror and are not served by this transport;
      // their route never connects, exactly as the stream transport reports a
      // route that is not up.
      if (descriptor.marketKind === MARKET_KINDS.PERPETUAL || routeState !== "CONNECTED") {
        rollback();
        throw new Error(`Cannot subscribe before the Binance ${descriptor.marketKind} ${ROUTE_NAME} route is connected.`);
      }
    }
    for (const descriptor of added) {
      // Trades, book ticker and depth are accepted so the server's bookkeeping
      // is unchanged, but nothing is polled for them: they are unavailable.
      if (!SERVED_EVENT_TYPES.has(descriptor.eventType)) continue;
      const poller = createPoller(descriptor);
      pollers.set(poller.key, poller);
      beginRecovery(poller);
      schedulePoll(poller, 0);
    }
    replan();
    return added.length;
  }

  function subscribe(request, consumerId) {
    return subscribeMany([request], consumerId) === 1;
  }

  function teardownDescriptor(descriptor) {
    const key = pollerKey(descriptor);
    const poller = pollers.get(key);
    if (!poller) return;
    pollers.delete(key);
    poller.epoch += 1;
    clearTimer(poller);
    poller.inflight?.abort();
    poller.inflight = null;
    feedHealth.endRecovery(descriptor.marketKind, descriptor.symbol, descriptor.eventType, descriptor.interval);
  }

  function unsubscribeMany(requests, consumerId) {
    assertConsumerId(consumerId);
    if (!Array.isArray(requests) || requests.length === 0) {
      throw new Error("unsubscribeMany() requires a non-empty array of subscription requests.");
    }
    const descriptors = requests.map((request) => describeBinanceSubscription(request));
    let released = 0;
    for (const descriptor of descriptors) {
      const lastHolderReleased = registryFor(descriptor.marketKind).remove(descriptor.symbol, descriptor.eventType, consumerId, descriptor.interval);
      if (!lastHolderReleased) continue;
      released += 1;
      teardownDescriptor(descriptor);
    }
    replan();
    return released;
  }

  function unsubscribe(request, consumerId) {
    return unsubscribeMany([request], consumerId) === 1;
  }

  function removeConsumer(consumerId) {
    assertConsumerId(consumerId);
    const released = [];
    for (const marketKind of Object.values(MARKET_KINDS)) {
      for (const tuple of registryFor(marketKind).removeConsumer(consumerId)) {
        const descriptor = Object.freeze({
          symbol: tuple.symbol,
          marketKind,
          eventType: tuple.eventType,
          ...(tuple.interval !== undefined ? { interval: tuple.interval } : {}),
        });
        teardownDescriptor(descriptor);
        released.push(descriptor);
      }
    }
    replan();
    return released;
  }

  function isSubscribed(marketKind, symbol, eventType, interval) {
    const context = marketKindContexts[marketKind];
    if (!context) return false;
    return context.subscriptionRegistry.list().some(
      (entry) => entry.symbol === symbol && entry.eventType === eventType && (entry.interval ?? null) === (interval ?? null),
    );
  }

  function recoverStaleSubscription(request, { automatic = false } = {}) {
    if (typeof automatic !== "boolean") {
      throw new Error("recoverStaleSubscription(): automatic must be a boolean when provided.");
    }
    const descriptor = describeBinanceSubscription(request);
    const poller = pollers.get(pollerKey(descriptor));
    if (!poller || routeState !== "CONNECTED" || poller.inflight || waitBeforeDispatchMs() > 0) return false;
    telemetryEvent("stale_subscription_recovery_started", { eventType: descriptor.eventType, symbol: safeTelemetrySymbol(descriptor.symbol) });
    beginRecovery(poller);
    poller.attempt = 0;
    schedulePoll(poller, 0);
    return true;
  }

  function healthVariants(poller) {
    const variants = [];
    const at = now();
    if (at < banUntilMs || at < rateLimitedUntilMs) variants.push(HEALTH_REASON_VARIANTS.RATE_LIMITED);
    const pollFailed = poller !== null && poller.lastFailureReason !== null &&
      poller.lastFailureReason !== "RATE_LIMITED" && poller.lastFailureReason !== "IP_BANNED";
    if (routeState !== "CONNECTED" || pollFailed) variants.push(HEALTH_REASON_VARIANTS.POLL_FAILED);
    if (poller !== null && poller.catchingUp) variants.push(HEALTH_REASON_VARIANTS.CATCHING_UP);
    if (plan.stretched || poller?.budgetDeferred) variants.push(HEALTH_REASON_VARIANTS.SLOW_POLLING);
    return variants;
  }

  function healthReason(poller) {
    return [HEALTH_REASON_BASE, ...healthVariants(poller)].join(" · ");
  }

  function getFeedHealth(marketKind, symbol, eventType, interval) {
    if (!isSubscribed(marketKind, symbol, eventType, interval)) return undefined;
    if (marketKind !== MARKET_KINDS.SPOT || !SERVED_EVENT_TYPES.has(eventType)) {
      // Not served at all: unavailable, and flagged so the server's worst-of
      // health follows the candle feed while the reason names what is missing.
      return Object.freeze({ stale: true, recoveryState: "UNAVAILABLE", transport: TRANSPORTS.REST, served: false, reason: healthReason(null) });
    }
    const poller = pollers.get(pollerKey({ marketKind, symbol, eventType, interval })) ?? null;
    const context = feedHealth.computeContext({ marketKind, symbol, eventType, interval, routeConnected: routeState === "CONNECTED" });
    return Object.freeze({
      ...context,
      transport: TRANSPORTS.REST,
      served: true,
      reason: healthReason(poller),
      pollMs: plan.klineCadenceMs,
      lastPollLatencyMs: poller?.lastLatencyMs ?? null,
    });
  }

  function getOrderBook(marketKind, symbol) {
    return isSubscribed(marketKind, symbol, EVENT_TYPES.DEPTH) ? BOOK_UNAVAILABLE : undefined;
  }

  function getDepthSnapshot() {
    return undefined;
  }

  function onMessage(listener) {
    if (typeof listener !== "function") throw new Error("Binance message listener must be a function.");
    if (!messageListeners.has(listener) && messageListeners.size >= MAX_LISTENERS) {
      throw new Error(`Cannot register more than ${MAX_LISTENERS} Binance message listeners.`);
    }
    messageListeners.add(listener);
    return () => messageListeners.delete(listener);
  }

  function onError(listener) {
    if (typeof listener !== "function") throw new Error("Binance error listener must be a function.");
    if (!errorListeners.has(listener) && errorListeners.size >= MAX_LISTENERS) {
      throw new Error(`Cannot register more than ${MAX_LISTENERS} Binance error listeners.`);
    }
    errorListeners.add(listener);
    return () => errorListeners.delete(listener);
  }

  function getOperationalStats() {
    let inflight = 0;
    const pollerStats = [];
    for (const poller of pollers.values()) {
      if (poller.inflight) inflight += 1;
      pollerStats.push(Object.freeze({
        symbol: poller.descriptor.symbol,
        interval: poller.descriptor.interval,
        cadenceMs: plan.klineCadenceMs,
        lastLatencyMs: poller.lastLatencyMs,
        lastSuccessAtMs: poller.lastSuccessAtMs,
        lastFailureReason: poller.lastFailureReason,
        catchingUp: poller.catchingUp,
        confirmedOpenTime: poller.bars.confirmedOpenTime,
      }));
    }
    return Object.freeze({
      transport: TRANSPORTS.REST,
      routeState,
      pollMs,
      klineCadenceMs: plan.klineCadenceMs,
      cadenceStretched: plan.stretched,
      projectedWeightPerMinute: plan.projectedPerMinute,
      weight: budget.stats(),
      ...counters,
      inflight: inflight + (probe.inflight ? 1 : 0) + (clock.inflight ? 1 : 0),
      exchangeOffsetMs,
      clockSyncedAtMs,
      rateLimitedUntilMs,
      banUntilMs,
      pollers: Object.freeze(pollerStats),
    });
  }

  function quiesce({ timeoutMs = 30_000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error("quiesce timeoutMs must be a positive safe integer."));
    }
    accepting = false;
    for (const holder of [probe, clock, ...pollers.values()]) clearTimer(holder);
    const deadline = now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const inspect = () => {
        const { inflight } = getOperationalStats();
        if (inflight === 0) {
          resolve();
          return;
        }
        if (now() >= deadline) {
          reject(new Error(`Binance REST connection still has ${inflight} request(s) in flight at shutdown.`));
          return;
        }
        setTimeout(inspect, 10);
      };
      inspect();
    });
  }

  function fetchRecentKlines(marketKind, symbol, klineOptions) {
    return klineBackfill.fetchRecentBars(marketKind, symbol, klineOptions);
  }

  return Object.freeze({
    connect,
    disconnect,
    getStatus,
    subscribe,
    subscribeMany,
    unsubscribe,
    unsubscribeMany,
    recoverStaleSubscription,
    removeConsumer,
    onMessage,
    onError,
    getDepthSnapshot,
    getOrderBook,
    getOrderBookStatus: getOrderBook,
    getFeedHealth,
    getOperationalStats,
    quiesce,
    fetchRecentKlines,
  });
}

module.exports = {
  createBinanceRestConnection,
  binanceTransportFromEnv,
  TRANSPORTS,
  DEFAULT_POLL_MS,
  MIN_POLL_MS,
  BOOK_UNAVAILABLE_REASON,
  HEALTH_REASON_BASE,
  HEALTH_REASON_VARIANTS,
  DEFAULT_MAX_CATCH_UP_PAGES,
  DEFAULT_CLOCK_REFRESH_MS,
  CONSECUTIVE_FAILURES_BEFORE_DISCONNECT,
};
