const { analyticsStatusFrame } = require("../../src/server/frames");
const { createAnalyticsStatusPublisher } = require("../../src/server/analytics-status");

test("query status validates identities and enums, deduplicates transitions, replays native/wire identity, and clears on restart", () => {
  const identity = { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "SPOT" };
  const broadcast = jest.fn();
  const publisher = createAnalyticsStatusPublisher(broadcast);
  publisher.set(identity, "PROFILE", "UNAVAILABLE");
  publisher.set(identity, "PROFILE", "UNAVAILABLE");
  expect(broadcast).toHaveBeenCalledTimes(1);
  expect(broadcast.mock.calls[0][0]).toEqual({ type: "analytics_status", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT", indicator: "PROFILE", status: "UNAVAILABLE" });
  const send = jest.fn();
  publisher.replay({ ...identity, symbol: "BTC-USDT" }, send);
  expect(send).toHaveBeenCalledWith(broadcast.mock.calls[0][0]);
  publisher.set(identity, "PROFILE", "READY");
  expect(broadcast).toHaveBeenCalledTimes(2);
  publisher.clear();
  send.mockClear();
  publisher.replay(identity, send);
  expect(send).not.toHaveBeenCalled();
  expect(() => analyticsStatusFrame(identity, "PROFILE", "COMPLETE")).toThrow();
  expect(() => analyticsStatusFrame(identity, "BOOK", "READY")).toThrow();
  expect(() => analyticsStatusFrame({ ...identity, provider: "OTHER" }, "VPIN", "READY")).toThrow();
});
