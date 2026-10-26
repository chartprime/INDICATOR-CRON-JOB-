const {
  createBinanceRestConnection,
  binanceTransportFromEnv,
  HEALTH_REASON_BASE,
  BOOK_UNAVAILABLE_REASON,
  DEFAULT_MAX_CATCH_UP_PAGES,
  DEFAULT_CLOCK_REFRESH_MS,
} = require("../../../src/providers/binance/binance-rest-connection");
const { normalizeBinanceEvent } = require("../../../src/providers/binance/binance-event-normalizer");

const MINUTE = 60_000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % MINUTE) + 30_000; // :30 into a minute
const OPEN = Math.floor(T0 / MINUTE) * MINUTE;
const SPOT_TRADE = { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "TRADE" };
const SPOT_KLINE = { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "KLINE", interval: "1m" };
const SPOT_DEPTH = { symbol: "BTCUSDT", marketKind: "SPOT", eventType: "DEPTH" };
const ETH_KLINE = { symbol: "ETHUSDT", marketKind: "SPOT", eventType: "KLINE", interval: "1m" };

function klineRow(openTime, { close = "64275.99", volume = "12.3", trades = 418, takerBuy = "6.0" } = {}) {
  return [openTime, "64200.00", "64300.50", "64150.25", close, volume, openTime + MINUTE - 1, "792345.11", trades, takerBuy, "385000.0", "0"];
}

/**
 * A scripted Binance: candles are derived from the fake clock, so the same
 * handler serves the two-row poll and catch-up pages; exchangeInfo and time
 * answer with the fake clock plus a configurable skew.
 */
function fakeBinance() {
  const state = {
    serverTimeOffsetMs: 0,
    usedWeight: 10,
    klineStart: OPEN - 10 * MINUTE,
    rowFor: () => ({}),
    failures: [],
    hang: null,
    pending: [],
  };
  const requests = [];
  function respond(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), { status, headers: { "x-mbx-used-weight-1m": String(state.usedWeight), ...headers } });
  }
  function currentOpen() {
    return Math.floor((Date.now() + state.serverTimeOffsetMs) / MINUTE) * MINUTE;
  }
  const fetchImpl = jest.fn(async (url, init) => {
    const u = new URL(url);
    requests.push(u);
    const failure = state.failures.find((entry) => entry.match(u) && entry.times > 0);
    if (failure) {
      failure.times -= 1;
      if (failure.network) throw new TypeError("fetch failed");
      return respond(failure.body ?? {}, failure.status, failure.headers ?? {});
    }
    if (state.hang && state.hang(u)) {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
        state.pending.push((body) => resolve(respond(body)));
      });
    }
    switch (u.pathname) {
      case "/api/v3/exchangeInfo":
        return respond({ serverTime: Date.now() + state.serverTimeOffsetMs, symbols: [] });
      case "/api/v3/time":
        return respond({ serverTime: Date.now() + state.serverTimeOffsetMs });
      case "/api/v3/klines": {
        const startTime = Number(u.searchParams.get("startTime"));
        const limit = Number(u.searchParams.get("limit"));
        const rows = [];
        for (let openTime = Math.max(startTime, state.klineStart); openTime <= currentOpen() && rows.length < limit; openTime += MINUTE) {
          rows.push(klineRow(openTime, state.rowFor(openTime)));
        }
        return respond(rows);
      }
      default:
        return respond({}, 404);
    }
  });
  return {
    fetchImpl,
    requests,
    state,
    pathsRequested: () => requests.map((u) => u.pathname),
    klineRequests: () => requests.filter((u) => u.pathname === "/api/v3/klines"),
  };
}

const active = new Set();

function connection(fake, options = {}) {
  const created = createBinanceRestConnection({ fetchImpl: fake.fetchImpl, random: () => 0.5, telemetry: () => {}, ...options });
  active.add(created);
  return created;
}

async function connected(fake, options) {
  const created = connection(fake, options);
  created.connect();
  await tick(0);
  expect(created.getStatus().SPOT.public).toBe("CONNECTED");
  return created;
}

// Advance the fake clock, then let the fetch and body-reading promise chains
// settle: a poll completing at the end of the window schedules its follow-up
// a few microtask turns later, and a zero-delay timer created during a fake
// tick is due one millisecond on, so the flush steps by one millisecond.
async function tick(ms) {
  await jest.advanceTimersByTimeAsync(ms);
  for (let turn = 0; turn < 6; turn += 1) await jest.advanceTimersByTimeAsync(1);
}

function collector(created) {
  const envelopes = [];
  created.onMessage((envelope) => envelopes.push(envelope));
  return envelopes;
}

function bars(envelopes) {
  return envelopes.map((e) => [(e.payload.openTime - OPEN) / MINUTE, e.payload.isClosed]);
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick"] });
  jest.setSystemTime(T0);
});

afterEach(() => {
  for (const created of active) created.disconnect();
  active.clear();
  jest.useRealTimers();
});

describe("binance-rest-connection: route, clock and subscriptions", () => {
  test("binanceTransportFromEnv defaults to ws, accepts rest, refuses anything else", () => {
    expect(binanceTransportFromEnv({})).toBe("ws");
    expect(binanceTransportFromEnv({ TT_BINANCE_TRANSPORT: " " })).toBe("ws");
    expect(binanceTransportFromEnv({ TT_BINANCE_TRANSPORT: "rest" })).toBe("rest");
    expect(() => binanceTransportFromEnv({ TT_BINANCE_TRANSPORT: "http" })).toThrow(/ws or rest/);
  });

  test("connect() probes exchangeInfo (weight 20) for the route and the exchange clock; PERPETUAL routes stay DISCONNECTED and cannot be subscribed", async () => {
    const fake = fakeBinance();
    fake.state.serverTimeOffsetMs = 1500;
    const created = connection(fake);
    expect(created.getStatus()).toEqual({ SPOT: { public: "DISCONNECTED" }, PERPETUAL: { public: "DISCONNECTED", market: "DISCONNECTED" } });
    expect(() => created.subscribe(SPOT_KLINE, "c1")).toThrow(/Cannot subscribe before the Binance SPOT public route is connected/);
    created.connect();
    expect(created.getStatus().SPOT.public).toBe("CONNECTING");
    await tick(0);
    expect(created.getStatus().SPOT.public).toBe("CONNECTED");
    expect(fake.pathsRequested()).toEqual(["/api/v3/exchangeInfo"]);
    expect(() => created.subscribe({ symbol: "BTCUSDT", marketKind: "PERPETUAL", eventType: "KLINE", interval: "1m" }, "c1"))
      .toThrow(/Cannot subscribe before the Binance PERPETUAL public route is connected/);
    expect(created.getFeedHealth("PERPETUAL", "BTCUSDT", "KLINE", "1m")).toBeUndefined();
    const stats = created.getOperationalStats();
    expect(stats).toMatchObject({ transport: "rest", routeState: "CONNECTED", probes: 1, clockSyncs: 1, exchangeOffsetMs: 1500 });
    expect(stats.weight.used).toBe(20);
  });

  test("the exchange clock is refreshed from /api/v3/time once a minute, charged 1 to the budget, and a failed refresh keeps the last offset", async () => {
    const fake = fakeBinance();
    const created = await connected(fake);
    await tick(DEFAULT_CLOCK_REFRESH_MS);
    expect(fake.pathsRequested()).toEqual(["/api/v3/exchangeInfo", "/api/v3/time"]);
    expect(created.getOperationalStats()).toMatchObject({ clockSyncs: 2, exchangeOffsetMs: 0 });
    fake.state.serverTimeOffsetMs = -2000;
    await tick(DEFAULT_CLOCK_REFRESH_MS);
    expect(created.getOperationalStats()).toMatchObject({ clockSyncs: 3, exchangeOffsetMs: -2000 });
    fake.state.failures.push({ match: (u) => u.pathname === "/api/v3/time", times: 1, status: 503 });
    await tick(DEFAULT_CLOCK_REFRESH_MS);
    expect(created.getOperationalStats()).toMatchObject({ clockSyncs: 3, clockRefreshFailures: 1, exchangeOffsetMs: -2000, routeState: "CONNECTED" });
    // 20 for the probe plus one per refresh minute: the minute roll resets the count, so only this minute's refresh shows.
    expect(created.getOperationalStats().weight.reserved).toBe(1);
  });

  test("the tape and the book are accepted but unavailable: no trade frames, book UNAVAILABLE with reason REST_NO_DEPTH, health flagged unserved", async () => {
    const fake = fakeBinance();
    const created = await connected(fake);
    const envelopes = collector(created);
    expect(created.getOrderBook("SPOT", "BTCUSDT")).toBeUndefined();
    created.subscribeMany([SPOT_TRADE, SPOT_KLINE, SPOT_DEPTH], "server");
    expect(created.getOrderBook("SPOT", "BTCUSDT")).toEqual({ status: "UNAVAILABLE", reason: BOOK_UNAVAILABLE_REASON });
    expect(created.getOrderBookStatus("SPOT", "BTCUSDT")).toEqual({ status: "UNAVAILABLE", reason: "REST_NO_DEPTH" });
    expect(created.getDepthSnapshot("SPOT", "BTCUSDT")).toBeUndefined();
    for (const [eventType, interval] of [["TRADE", undefined], ["DEPTH", undefined]]) {
      expect(created.getFeedHealth("SPOT", "BTCUSDT", eventType, interval)).toEqual({
        stale: true, recoveryState: "UNAVAILABLE", transport: "rest", served: false, reason: HEALTH_REASON_BASE,
      });
    }
    expect(created.recoverStaleSubscription(SPOT_DEPTH)).toBe(false);
    expect(created.recoverStaleSubscription(SPOT_TRADE)).toBe(false);
    await tick(3000);
    expect(fake.pathsRequested().filter((path) => path !== "/api/v3/klines" && path !== "/api/v3/exchangeInfo")).toEqual([]);
    expect(envelopes.every((e) => e.eventType === "KLINE")).toBe(true);
    expect(envelopes.length).toBeGreaterThan(0);
    expect(created.getFeedHealth("SPOT", "BTCUSDT", "KLINE", "1m")).toMatchObject({ stale: false, recoveryState: "READY", served: true, reason: HEALTH_REASON_BASE, pollMs: 1000 });
  });

  test("unsubscribing the last holder cancels the in-flight request and a response that lands afterwards is thrown away", async () => {
    const fake = fakeBinance();
    const created = await connected(fake);
    const envelopes = collector(created);
    fake.state.hang = (u) => u.pathname === "/api/v3/klines";
    created.subscribe(SPOT_KLINE, "c1");
    created.subscribe(SPOT_KLINE, "c2");
    await tick(0);
    expect(fake.state.pending).toHaveLength(1);
    expect(created.getOperationalStats().inflight).toBe(1);
    expect(created.unsubscribe(SPOT_KLINE, "c1")).toBe(false);
    expect(created.unsubscribe(SPOT_KLINE, "c2")).toBe(true);
    fake.state.pending[0]([klineRow(OPEN - MINUTE), klineRow(OPEN)]);
    await tick(5000);
    expect(envelopes).toEqual([]);
    expect(fake.klineRequests()).toHaveLength(1);
    expect(created.getFeedHealth("SPOT", "BTCUSDT", "KLINE", "1m")).toBeUndefined();
    expect(created.getOperationalStats().inflight).toBe(0);
  });

  test("removeConsumer releases every subscription of a consumer and quiesce resolves once nothing is in flight", async () => {
    const fake = fakeBinance();
    const created = await connected(fake);
    created.subscribeMany([SPOT_TRADE, SPOT_KLINE, SPOT_DEPTH], "server");
    await tick(10);
    expect(created.removeConsumer("server").map((d) => d.eventType).sort()).toEqual(["DEPTH", "KLINE", "TRADE"]);
    expect(created.getOperationalStats().pollers).toEqual([]);
    const settled = created.quiesce({ timeoutMs: 1000 });
    await tick(20);
    await expect(settled).resolves.toBeUndefined();
  });
});

describe("binance-rest-connection: candles", () => {
  test("polls the previous and forming bar: a revision only when a field changed, the close emitted once after the grace, with the WebSocket kline envelope shape", async () => {
    const fake = fakeBinance();
    const created = await connected(fake);
    const envelopes = collector(created);
    created.subscribe(SPOT_KLINE, "c1");
    await tick(0);
    expect(bars(envelopes)).toEqual([[-1, true], [0, false]]);
    expect(envelopes[1]).toMatchObject({ stale: false, recoveryState: "READY" });
    await tick(1000);
    expect(envelopes).toHaveLength(2); // unchanged forming bar: no revision
    fake.state.rowFor = (openTime) => (openTime === OPEN ? { takerBuy: "6.5" } : {});
    await tick(1000);
    expect(envelopes.at(-1)).toMatchObject({ payload: { openTime: OPEN, isClosed: false, takerBuyBaseVolume: "6.5" } });
    jest.setSystemTime(OPEN + MINUTE + 300);
    await tick(400); // 700 ms after the close: the grace has not passed on the exchange clock
    expect(envelopes.filter((e) => e.payload.openTime === OPEN && e.payload.isClosed)).toHaveLength(0);
    await tick(1000);
    const closed = envelopes.filter((e) => e.payload.openTime === OPEN && e.payload.isClosed);
    expect(closed).toHaveLength(1);
    await tick(3000);
    expect(envelopes.filter((e) => e.payload.openTime === OPEN && e.payload.isClosed)).toHaveLength(1);
    const viaStream = normalizeBinanceEvent(
      { marketKind: "SPOT", symbol: "BTCUSDT", eventType: "KLINE", interval: "1m", raw: { e: "kline", E: T0, s: "BTCUSDT", k: { t: OPEN, T: OPEN + MINUTE - 1, s: "BTCUSDT", i: "1m", f: 1, L: 2, o: "64200.00", c: "64275.99", h: "64300.50", l: "64150.25", v: "12.3", n: 418, x: true, q: "792345.11", V: "6.5", Q: "385000.0", B: "0" } } },
      { receivedAtMs: T0 },
    );
    expect(Object.keys(closed[0]).sort()).toEqual(Object.keys(viaStream).sort());
    expect(Object.keys(closed[0].payload).sort()).toEqual(Object.keys(viaStream.payload).sort());
    expect(closed[0].payload).toEqual(viaStream.payload);
    expect(closed[0]).toMatchObject({ provider: "BINANCE", venue: "BINANCE", marketKind: "SPOT", providerSymbol: "BTCUSDT", eventType: "KLINE", timingClass: "REALTIME", stale: false, recoveryState: "READY" });
    expect(Object.isFrozen(closed[0])).toBe(true);
  });

  test("clock skew: with the machine 30 s ahead of the exchange, a bar the exchange still has open is never finalised early", async () => {
    const fake = fakeBinance();
    fake.state.serverTimeOffsetMs = -45_000; // the machine is :30 into a minute, the exchange :45 into the previous one
    const created = await connected(fake);
    const envelopes = collector(created);
    created.subscribe(SPOT_KLINE, "c1");
    await tick(0);
    const exchangeOpen = OPEN - MINUTE; // the exchange is still in the previous minute
    expect(envelopes.map((e) => [(e.payload.openTime - exchangeOpen) / MINUTE, e.payload.isClosed])).toEqual([[-1, true], [0, false]]);
    jest.setSystemTime(exchangeOpen + MINUTE + 20_000); // closed by the machine 20 s ago, open on the exchange for 25 more seconds
    await tick(1000);
    expect(envelopes.filter((e) => e.payload.openTime === exchangeOpen && e.payload.isClosed)).toHaveLength(0);
    jest.setSystemTime(exchangeOpen + MINUTE + 47_000); // two seconds past the close on the exchange: the grace has passed
    await tick(1000);
    expect(envelopes.filter((e) => e.payload.openTime === exchangeOpen && e.payload.isClosed)).toHaveLength(1);
    expect(created.getOperationalStats().exchangeOffsetMs).toBe(-45_000);
  });

  test("a multi-minute outage: polls fail, the feed goes stale then UNAVAILABLE, and after it catch-up emits every missed close in order before the two-row poll resumes", async () => {
    const fake = fakeBinance();
    const created = await connected(fake);
    const envelopes = collector(created);
    created.subscribe(SPOT_KLINE, "c1");
    await tick(0);
    // The whole origin is unreachable: polls and probes fail alike.
    fake.state.failures.push({ match: () => true, times: Number.MAX_SAFE_INTEGER, network: true });
    await tick(2000);
    expect(created.getFeedHealth("SPOT", "BTCUSDT", "KLINE", "1m")).toMatchObject({ stale: true, recoveryState: "RECOVERING", reason: `${HEALTH_REASON_BASE} · poll failed` });
    await tick(5 * MINUTE);
    expect(created.getStatus().SPOT.public).toBe("DISCONNECTED");
    expect(created.getFeedHealth("SPOT", "BTCUSDT", "KLINE", "1m")).toMatchObject({ stale: true, recoveryState: "UNAVAILABLE", reason: `${HEALTH_REASON_BASE} · poll failed` });
    const emittedBeforeOutage = envelopes.length;
    fake.state.failures.length = 0;
    await tick(31_000); // the probe retries at most every 30 s
    expect(created.getStatus().SPOT.public).toBe("CONNECTED");
    await tick(2000); // one steady two-row poll after the catch-up
    const currentBar = Math.floor(Date.now() / MINUTE) - OPEN / MINUTE;
    const closes = envelopes.slice(emittedBeforeOutage).filter((e) => e.payload.isClosed).map((e) => (e.payload.openTime - OPEN) / MINUTE);
    expect(closes).toEqual(Array.from({ length: currentBar }, (_, i) => i));
    expect(currentBar).toBeGreaterThanOrEqual(5);
    // The current bar was announced forming (it may since have been followed by the previous bar's close after its grace).
    expect(envelopes.some((e) => e.payload.openTime === OPEN + currentBar * MINUTE && e.payload.isClosed === false)).toBe(true);
    expect(created.getFeedHealth("SPOT", "BTCUSDT", "KLINE", "1m")).toMatchObject({ stale: false, recoveryState: "READY", reason: HEALTH_REASON_BASE });
    const catchUpRequest = fake.klineRequests().find((u) => u.searchParams.get("limit") === "1000");
    expect(Number(catchUpRequest.searchParams.get("startTime"))).toBe(OPEN); // continuation cursor: the confirmed close plus one bar
    expect(fake.klineRequests().at(-1).searchParams.get("limit")).toBe("2");
  });

  test("catch-up pages hold 1000 candles, continue from the confirmed close, run at most maxCatchUpPages back to back, and read catching up while they run", async () => {
    const fake = fakeBinance();
    fake.state.klineStart = OPEN - 5000 * MINUTE;
    const telemetry = jest.fn();
    const created = await connected(fake, { maxCatchUpPages: 2, telemetry });
    const envelopes = collector(created);
    created.subscribe(SPOT_KLINE, "c1");
    await tick(0);
    expect(DEFAULT_MAX_CATCH_UP_PAGES).toBe(10);
    // A long silence: the next poll finds itself 2500 bars behind.
    jest.setSystemTime(T0 + 2500 * MINUTE);
    await tick(1000);
    const pages = fake.klineRequests().filter((u) => u.searchParams.get("limit") === "1000");
    expect(pages.map((u) => (Number(u.searchParams.get("startTime")) - OPEN) / MINUTE)).toEqual([0, 1000]);
    expect(created.getFeedHealth("SPOT", "BTCUSDT", "KLINE", "1m")).toMatchObject({ recoveryState: "RECOVERING", stale: true, reason: `${HEALTH_REASON_BASE} · catching up` });
    expect(created.getOperationalStats().pollers[0]).toMatchObject({ catchingUp: true, confirmedOpenTime: OPEN + 1999 * MINUTE });
    expect(telemetry.mock.calls.some(([entry]) => entry.event === "market_data.binance_rest.kline_catch_up_started")).toBe(true);
    await tick(1000); // the poller yielded for one cadence, then continues
    const morePages = fake.klineRequests().filter((u) => u.searchParams.get("limit") === "1000");
    expect(morePages.map((u) => (Number(u.searchParams.get("startTime")) - OPEN) / MINUTE)).toEqual([0, 1000, 2000]);
    expect(created.getFeedHealth("SPOT", "BTCUSDT", "KLINE", "1m")).toMatchObject({ recoveryState: "READY", reason: HEALTH_REASON_BASE });
    expect(telemetry.mock.calls.some(([entry]) => entry.event === "market_data.binance_rest.kline_catch_up_completed")).toBe(true);
    const closes = envelopes.filter((e) => e.payload.isClosed).map((e) => (e.payload.openTime - OPEN) / MINUTE);
    expect(closes).toEqual(Array.from({ length: 2501 }, (_, i) => i - 1)); // bars -1 .. 2499 closed; 2500 is forming
    await tick(1000); // back on the steady two-row poll
    expect(fake.klineRequests().at(-1).searchParams.get("limit")).toBe("2");
  });
});

describe("binance-rest-connection: honesty under failure and the weight budget", () => {
  test("429 pauses every poll for Retry-After and says rate limited; a 418 stops polling for its ban window and takes the route down until a probe succeeds", async () => {
    const fake = fakeBinance();
    const created = await connected(fake);
    created.subscribeMany([SPOT_KLINE, ETH_KLINE], "server");
    await tick(0);
    fake.state.failures.push({ match: (u) => u.pathname === "/api/v3/klines", times: 1, status: 429, headers: { "retry-after": "3", "x-mbx-used-weight-1m": "3900" } });
    await tick(1000);
    expect(created.getFeedHealth("SPOT", "BTCUSDT", "KLINE", "1m").reason).toBe(`${HEALTH_REASON_BASE} · rate limited`);
    expect(created.getFeedHealth("SPOT", "ETHUSDT", "KLINE", "1m").reason).toBe(`${HEALTH_REASON_BASE} · rate limited`);
    // Retry-After 3 s from the failed poll, honoured over the 1 s backoff
    expect(created.getOperationalStats().rateLimitedUntilMs).toBeGreaterThanOrEqual(Date.now() + 2950);
    expect(created.getOperationalStats().rateLimitedUntilMs).toBeLessThanOrEqual(Date.now() + 3000);
    const requestsAtLimit = fake.requests.length;
    await tick(2500);
    expect(fake.requests.length).toBe(requestsAtLimit); // nothing is sent inside the Retry-After window
    expect(created.getOperationalStats().weight.observed).toBe(3900); // the exchange's count is adopted
    await tick(1500);
    expect(fake.requests.length).toBeGreaterThan(requestsAtLimit);
    expect(created.getStatus().SPOT.public).toBe("CONNECTED");

    fake.state.failures.push({ match: (u) => u.pathname === "/api/v3/klines", times: 1, status: 418, headers: { "retry-after": "10" } });
    await tick(2000);
    expect(created.getStatus().SPOT.public).toBe("DISCONNECTED");
    expect(created.getFeedHealth("SPOT", "BTCUSDT", "KLINE", "1m")).toMatchObject({ stale: true, recoveryState: "UNAVAILABLE" });
    expect(created.getFeedHealth("SPOT", "BTCUSDT", "KLINE", "1m").reason).toContain("rate limited");
    const requestsAtBan = fake.requests.length;
    await tick(8500); // inside the 10 s ban window (the fake clock drifts a few ms per tick)
    expect(fake.requests.length).toBe(requestsAtBan);
    await tick(2500);
    expect(fake.pathsRequested().slice(requestsAtBan)[0]).toBe("/api/v3/exchangeInfo");
    expect(created.getStatus().SPOT.public).toBe("CONNECTED");
    await tick(1000);
    expect(created.getFeedHealth("SPOT", "BTCUSDT", "KLINE", "1m")).toMatchObject({ stale: false, recoveryState: "READY", reason: HEALTH_REASON_BASE });
  });

  test("three transport failures in a row take the route down until a probe succeeds; a failed poll emits nothing and reads poll failed, never a quiet market", async () => {
    const fake = fakeBinance();
    const telemetry = jest.fn();
    const created = await connected(fake, { telemetry });
    const envelopes = collector(created);
    created.subscribe(SPOT_KLINE, "c1");
    await tick(0);
    const emittedAtStart = envelopes.length;
    fake.state.failures.push({ match: (u) => u.pathname === "/api/v3/klines", times: 3, status: 503 });
    fake.state.rowFor = () => ({ close: "64290.00" });
    await tick(1000);
    expect(envelopes.length).toBe(emittedAtStart);
    expect(created.getFeedHealth("SPOT", "BTCUSDT", "KLINE", "1m")).toMatchObject({ stale: true, recoveryState: "RECOVERING", reason: `${HEALTH_REASON_BASE} · poll failed` });
    await tick(10_000);
    const routeEvents = telemetry.mock.calls.map(([entry]) => entry).filter((entry) => entry.event.startsWith("market_data.binance_rest.route_"));
    expect(routeEvents.map((entry) => [entry.event.slice("market_data.binance_rest.".length), entry.reason ?? null])).toEqual([
      ["route_connected", null],
      ["route_disconnected", "HTTP_ERROR"],
      ["route_connected", null],
    ]);
    expect(fake.pathsRequested().filter((path) => path === "/api/v3/exchangeInfo")).toHaveLength(2);
    expect(created.getStatus().SPOT.public).toBe("CONNECTED");
    expect(envelopes.at(-1)).toMatchObject({ payload: { openTime: OPEN, isClosed: false, close: "64290.00" }, recoveryState: "READY" });
    expect(created.getFeedHealth("SPOT", "BTCUSDT", "KLINE", "1m")).toMatchObject({ stale: false, recoveryState: "READY", reason: HEALTH_REASON_BASE });
  });

  test("weight is reserved before dispatch: a budget too small for the pairs lengthens the cadence and the reason says slow polling", async () => {
    const fake = fakeBinance();
    const created = await connected(fake, { weightBudgetPerMinute: 100 });
    created.subscribeMany([SPOT_KLINE, ETH_KLINE], "server");
    const stats = created.getOperationalStats();
    expect(stats).toMatchObject({ klineCadenceMs: 3000, cadenceStretched: true, projectedWeightPerMinute: 81 });
    expect(created.getFeedHealth("SPOT", "BTCUSDT", "KLINE", "1m")).toMatchObject({ reason: `${HEALTH_REASON_BASE} · slow polling (weight budget)`, pollMs: 3000 });
    await tick(MINUTE);
    expect(created.getOperationalStats().weight.used).toBeLessThanOrEqual(100);
  });

  test("a 429 whose header says the whole limit is spent stops every poll until the minute turns, even after Retry-After", async () => {
    const fake = fakeBinance();
    const created = await connected(fake);
    created.subscribe(SPOT_KLINE, "c1");
    await tick(0);
    fake.state.failures.push({ match: (u) => u.pathname === "/api/v3/klines", times: 1, status: 429, headers: { "retry-after": "1", "x-mbx-used-weight-1m": "6010" } });
    await tick(1000);
    const sent = fake.requests.length;
    await tick(20_000);
    expect(fake.requests.length).toBe(sent);
    expect(created.getFeedHealth("SPOT", "BTCUSDT", "KLINE", "1m").reason).toBe(`${HEALTH_REASON_BASE} · slow polling (weight budget)`);
    await tick(MINUTE);
    expect(fake.requests.length).toBeGreaterThan(sent);
  });

  test("when the exchange reports the budget already spent, concurrent polls are deferred to the next minute instead of sent", async () => {
    const fake = fakeBinance();
    const created = await connected(fake, { weightBudgetPerMinute: 100 });
    created.subscribeMany([SPOT_KLINE, ETH_KLINE], "server");
    await tick(0);
    fake.state.usedWeight = 99;
    await tick(5000);
    const sent = fake.requests.length;
    await tick(10_000);
    expect(fake.requests.length).toBe(sent);
    expect(created.getOperationalStats().budgetDeferrals).toBeGreaterThan(0);
    expect(created.getOperationalStats().weight.used).toBeLessThanOrEqual(100);
    fake.state.usedWeight = 10;
    await tick(MINUTE);
    expect(fake.requests.length).toBeGreaterThan(sent);
  });

  test("the candle backfill goes through the same budget and reads the exchange's count back", async () => {
    const fake = fakeBinance();
    fake.state.klineStart = OPEN - 3 * MINUTE;
    const created = await connected(fake);
    const result = await created.fetchRecentKlines("SPOT", "BTCUSDT", { interval: "1m", intervalMs: MINUTE, days: 1 / 24 / 20 });
    expect(result.rows.length).toBeGreaterThan(0);
    expect(created.getOperationalStats().weight.reserved).toBe(22);
  });
});
