"use strict";

const { createHostReadMeter, createProcessMeter } = require("../../src/platform/host-read-meter");

describe("host-read meter", () => {
  test("counts requests and 429s per route over the last minute only", () => {
    let now = 0;
    const meter = createHostReadMeter({ now: () => now });
    meter.record("recent-trades", 200);
    meter.record("recent-trades", 429);
    meter.record("trades-since", 200);
    now = 30_000;
    meter.record("trades-since", 200);
    expect(meter.snapshot()).toEqual({
      windowMs: 60_000,
      requests: 4,
      rateLimited: 1,
      routes: { "recent-trades": { requests: 2, rateLimited: 1 }, "trades-since": { requests: 2, rateLimited: 0 } },
    });
    now = 60_001;
    expect(meter.snapshot()).toMatchObject({ requests: 1, rateLimited: 0, routes: { "trades-since": { requests: 1, rateLimited: 0 } } });
  });

  test("a worker thread's reads reach the main thread's count through the broadcast channel", () => {
    const channels = [];
    class FakeChannel {
      constructor() { this.onmessage = null; channels.push(this); }
      postMessage(data) { for (const other of channels) if (other !== this) other.onmessage?.({ data }); }
      unref() {}
      close() {}
    }
    const main = createProcessMeter({ mainThread: true, Channel: FakeChannel });
    const worker = createProcessMeter({ mainThread: false, Channel: FakeChannel });
    main.snapshot();
    worker.record("sliced-notional", 200);
    worker.record("replay-page", 429);
    expect(main.snapshot()).toMatchObject({ requests: 2, rateLimited: 1, routes: { "replay-page": { requests: 1, rateLimited: 1 } } });
    expect(worker.snapshot().requests).toBe(0);
  });
});
