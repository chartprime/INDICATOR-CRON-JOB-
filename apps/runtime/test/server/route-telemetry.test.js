"use strict";

const { createRouteTelemetry } = require("../../src/server/route-telemetry");

describe("server/route-telemetry", () => {
  test("records bounded per-route latency, byte, and outcome totals without raw request labels", () => {
    let time = 10;
    const telemetry = createRouteTelemetry({ routes: ["fast", "slow"], now: () => time, latencyBucketsMs: [5, 10] });
    const fast = telemetry.start("fast", 12);
    time = 14;
    fast.finish(200, 20);
    fast.finish(500, 999);
    const slow = telemetry.start("slow", 8);
    telemetry.increment("slow", "cacheMisses");
    telemetry.increment("slow", "timedOut");
    telemetry.observeFailure("slow", "reader_timeout");
    telemetry.observeStage("slow", "queryMs", 12);
    telemetry.observeStage("slow", "serializationMs", 2);
    time = 30;
    slow.finish(503, 5);

    expect(telemetry.snapshot()).toEqual({
      latencyBucketsMs: [5, 10, "+Inf"],
      routes: {
        fast: {
          requests: 1, successes: 1, clientErrors: 0, serverErrors: 0,
          cacheHits: 0, cacheMisses: 0, coalesced: 0, overloaded: 0, timedOut: 0, cancelled: 0,
          requestBytes: 12, responseBytes: 20, durationMsTotal: 4, durationMsMax: 4,
          latencyBuckets: [1, 0, 0],
          stages: {},
          failureReasons: {},
        },
        slow: {
          requests: 1, successes: 0, clientErrors: 0, serverErrors: 1,
          cacheHits: 0, cacheMisses: 1, coalesced: 0, overloaded: 0, timedOut: 1, cancelled: 0,
          requestBytes: 8, responseBytes: 5, durationMsTotal: 16, durationMsMax: 16,
          latencyBuckets: [0, 0, 1],
          stages: {
            queryMs: { count: 1, totalMs: 12, maxMs: 12, latencyBuckets: [0, 0, 1] },
            serializationMs: { count: 1, totalMs: 2, maxMs: 2, latencyBuckets: [1, 0, 0] },
          },
          failureReasons: { reader_timeout: 1 },
        },
      },
    });
  });
});
