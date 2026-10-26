"use strict";

const { attachReadTelemetry, readTelemetry } = require("../../src/storage/read-telemetry");

describe("storage/read-telemetry", () => {
  test("associates telemetry without mutating even a frozen domain result", () => {
    const result = Object.freeze({ rows: [], available: true });
    expect(attachReadTelemetry(result, { queryMs: 12 })).toBe(result);
    expect(readTelemetry(result)).toEqual({ queryMs: 12 });
    expect(Object.getOwnPropertySymbols(result)).toEqual([]);
    expect(JSON.stringify(result)).toBe('{"rows":[],"available":true}');
  });
});
