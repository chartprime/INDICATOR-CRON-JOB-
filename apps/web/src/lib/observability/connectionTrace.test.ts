// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { connectionCloseCategory, recordConnectionClose } from "./connectionTrace";

describe("connection close trace", () => {
  beforeEach(() => {
    delete window.__ttConnectionCloses;
  });

  it("counts closes by the reason's category and keeps the full reason in the recent list", () => {
    recordConnectionClose("flow-paused:4000/1234+56:liquidity", 1);
    recordConnectionClose("flow-paused:4000/999+10:l2_view", 2);
    recordConnectionClose("server-close:1013:Client is too slow", 3);
    recordConnectionClose(undefined, 4);

    expect(window.__ttConnectionCloses?.counts).toEqual({ "flow-paused": 2, "server-close": 1, unspecified: 1 });
    expect(window.__ttConnectionCloses?.recent.map((record) => record.reason)).toEqual([
      "flow-paused:4000/1234+56:liquidity",
      "flow-paused:4000/999+10:l2_view",
      "server-close:1013:Client is too slow",
      "unspecified",
    ]);
    expect(window.__ttConnectionCloses?.recent.map((record) => record.atMs)).toEqual([1, 2, 3, 4]);
  });

  it("bounds the recent list to the newest 256 closes and each reason to 160 characters", () => {
    for (let index = 0; index < 300; index += 1) recordConnectionClose(`socket-error:${index}`, index);
    recordConnectionClose(`parse-rejected:${"x".repeat(400)}`, 300);

    const trace = window.__ttConnectionCloses;
    expect(trace?.recent).toHaveLength(256);
    expect(trace?.recent[0].reason).toBe("socket-error:45");
    expect(trace?.recent.at(-1)?.reason).toHaveLength(160);
    expect(trace?.counts).toEqual({ "socket-error": 300, "parse-rejected": 1 });
  });

  it("uses the text before the first colon as the category", () => {
    expect(connectionCloseCategory("connect-timeout:1")).toBe("connect-timeout");
    expect(connectionCloseCategory("malformed-json")).toBe("malformed-json");
  });
});
