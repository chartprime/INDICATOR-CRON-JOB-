const { EventEmitter } = require("node:events");
const { requestStream, buildPath, fetchWithRetry, MAX_ATTEMPTS, HttpStatusError } = require("../../../../scripts/collect/historical/tardis-datasets-api");

function fakeReq() {
  const req = new EventEmitter();
  req.end = jest.fn();
  req.destroy = jest.fn((err) => { if (err) setImmediate(() => req.emit("error", err)); });
  return req;
}

test("resolves once headers arrive well within the deadline", async () => {
  const requestImpl = jest.fn((_options, callback) => {
    const req = fakeReq();
    setImmediate(() => callback({ statusCode: 200, headers: {}, resume() {} }));
    return req;
  });
  const res = await requestStream("key", "/v1/x/y/2025/01/01/BTCUSDT.csv.gz", { requestImpl, headerDeadlineMs: 5000 });
  expect(res.statusCode).toBe(200);
  expect(requestImpl).toHaveBeenCalledTimes(1);
});

test("a response that trickles without ever completing headers is bounded by the header deadline, not just inactivity", async () => {
  // Regression test: the socket `timeout` option only fires on total
  // silence. A connection that stays nominally "active" (never idle long
  // enough to trip that) but never actually delivers full headers used to
  // hang forever -- this is exactly what stalled the live Tardis backfill.
  const requestImpl = jest.fn(() => fakeReq()); // never invokes callback, never emits "timeout"
  await expect(
    requestStream("key", "/v1/x/y/2025/01/01/BTCUSDT.csv.gz", { requestImpl, headerDeadlineMs: 10 }),
  ).rejects.toThrow(/header deadline/);
});

test("the existing inactivity timeout still aborts a fully silent connection", async () => {
  let capturedReq;
  const requestImpl = jest.fn(() => { capturedReq = fakeReq(); return capturedReq; });
  const promise = requestStream("key", "/v1/x/y/2025/01/01/BTCUSDT.csv.gz", { requestImpl, headerDeadlineMs: 5000 });
  await new Promise((resolve) => setImmediate(resolve));
  capturedReq.emit("timeout");
  await expect(promise).rejects.toThrow(/timed out/);
});

test("a request-level error rejects without waiting for the header deadline", async () => {
  const requestImpl = jest.fn(() => {
    const req = fakeReq();
    setImmediate(() => req.emit("error", new Error("socket reset")));
    return req;
  });
  await expect(
    requestStream("key", "/v1/x/y/2025/01/01/BTCUSDT.csv.gz", { requestImpl, headerDeadlineMs: 5000 }),
  ).rejects.toThrow("socket reset");
});

test("follows a redirect through to the final response, applying the same deadline to each hop", async () => {
  let call = 0;
  const requestImpl = jest.fn((_options, callback) => {
    call += 1;
    const req = fakeReq();
    if (call === 1) {
      setImmediate(() => callback({ statusCode: 302, headers: { location: "https://datasets.tardis.dev/v1/final" }, resume() {} }));
    } else {
      setImmediate(() => callback({ statusCode: 200, headers: {}, resume() {} }));
    }
    return req;
  });
  const res = await requestStream("key", "/v1/x/y/2025/01/01/BTCUSDT.csv.gz", { requestImpl, headerDeadlineMs: 5000 });
  expect(res.statusCode).toBe(200);
  expect(requestImpl).toHaveBeenCalledTimes(2);
});

test("buildPath is unaffected by the deadline plumbing", () => {
  const path = buildPath({ exchange: "binance", dataType: "trades", date: new Date(Date.UTC(2025, 8, 6)), symbol: "btcusdt" });
  expect(path).toBe("/v1/binance/trades/2025/09/06/BTCUSDT.csv.gz");
});

describe("fetchWithRetry", () => {
  const target = { exchange: "binance", dataType: "trades", date: new Date(Date.UTC(2026, 8, 6)), symbol: "btcusdt" };

  function fakeRequestImplSequence(responses) {
    let call = 0;
    return jest.fn((_options, callback) => {
      const spec = responses[Math.min(call, responses.length - 1)];
      call += 1;
      const req = fakeReq();
      if (spec.error) {
        setImmediate(() => req.emit("error", spec.error));
      } else {
        setImmediate(() => callback({ statusCode: spec.statusCode, headers: spec.headers || {}, resume() {} }));
      }
      return req;
    });
  }

  test("returns the response on the first attempt without ever calling onRetry", async () => {
    const requestImpl = fakeRequestImplSequence([{ statusCode: 200 }]);
    const onRetry = jest.fn();
    const sleepImpl = jest.fn().mockResolvedValue();
    const res = await fetchWithRetry("key", target, { requestImpl, onRetry, sleepImpl });
    expect(res.statusCode).toBe(200);
    expect(onRetry).not.toHaveBeenCalled();
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  test("a 429 waits a fixed 60s and reports it to onRetry before succeeding", async () => {
    const requestImpl = fakeRequestImplSequence([{ statusCode: 429 }, { statusCode: 200 }]);
    const onRetry = jest.fn();
    const sleepImpl = jest.fn().mockResolvedValue();
    const res = await fetchWithRetry("key", target, { requestImpl, onRetry, sleepImpl });
    expect(res.statusCode).toBe(200);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 1, maxAttempts: MAX_ATTEMPTS, statusCode: 429, waitMs: 60_000 });
    expect(sleepImpl).toHaveBeenCalledWith(60_000);
  });

  test("a transport error also reports to onRetry and backs off before retrying", async () => {
    const requestImpl = fakeRequestImplSequence([{ error: new Error("socket reset") }, { statusCode: 200 }]);
    const onRetry = jest.fn();
    const sleepImpl = jest.fn().mockResolvedValue();
    const res = await fetchWithRetry("key", target, { requestImpl, onRetry, sleepImpl });
    expect(res.statusCode).toBe(200);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 1, statusCode: null, reason: "socket reset" });
    expect(sleepImpl).toHaveBeenCalledTimes(1);
  });

  test("a non-retryable status throws immediately without ever calling onRetry or sleeping", async () => {
    const requestImpl = fakeRequestImplSequence([{ statusCode: 404 }]);
    const onRetry = jest.fn();
    const sleepImpl = jest.fn().mockResolvedValue();
    await expect(fetchWithRetry("key", target, { requestImpl, onRetry, sleepImpl })).rejects.toThrow(HttpStatusError);
    expect(onRetry).not.toHaveBeenCalled();
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  test("exhausting every attempt on persistent 429s throws, having reported every retry along the way", async () => {
    const requestImpl = fakeRequestImplSequence([{ statusCode: 429 }]);
    const onRetry = jest.fn();
    const sleepImpl = jest.fn().mockResolvedValue();
    await expect(fetchWithRetry("key", target, { requestImpl, onRetry, sleepImpl })).rejects.toThrow(HttpStatusError);
    // The last attempt (MAX_ATTEMPTS) throws instead of retrying, so onRetry
    // fires exactly MAX_ATTEMPTS - 1 times.
    expect(onRetry).toHaveBeenCalledTimes(MAX_ATTEMPTS - 1);
    expect(sleepImpl).toHaveBeenCalledTimes(MAX_ATTEMPTS - 1);
  });

  test("onRetry is optional -- retrying still works with no callback supplied", async () => {
    const requestImpl = fakeRequestImplSequence([{ statusCode: 429 }, { statusCode: 200 }]);
    const sleepImpl = jest.fn().mockResolvedValue();
    const res = await fetchWithRetry("key", target, { requestImpl, sleepImpl });
    expect(res.statusCode).toBe(200);
  });
});
