/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseServerFrame, type ServerFrame } from "./frames";
import { resampleBars } from "../lib/chart/resampleBars";

describe("Day 2 real capture-to-browser conservation", () => {
  it("preserves trade/bar/derived totals and withdraws both providers' incomplete books through the independent wire parser", () => {
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../../../runtime/test/helpers/day2-conservation-trace.js");
    const result = JSON.parse(execFileSync(process.execPath, [fixture], { encoding: "utf8", timeout: 20_000 }));
    expect(result.counts).toEqual({ sourceTrades: 5, rejected: 1, storedTrades: 3, storedBars: 2,
      deliveredTrades: 3, deliveredBars: 2, profileTrades: 3, vpinTrades: 3, vpinSeals: 1 });
    const parsed = result.frames.map((raw: unknown) => parseServerFrame(raw)) as (ServerFrame | null)[];
    expect(parsed.every((frame) => frame !== null)).toBe(true);
    const frames = parsed.filter((frame): frame is ServerFrame => frame !== null);
    const snapshot = frames.find((frame) => frame.type === "snapshot");
    expect(snapshot?.type).toBe("snapshot");
    if (snapshot?.type !== "snapshot") throw new Error("missing snapshot");
    const displayed = resampleBars(snapshot.bars, 120_000);
    expect(displayed).toHaveLength(1);
    expect(displayed[0]).toMatchObject({ closed: true, volume: 10, trade_count: 3, buy_volume: 10 });
    expect(snapshot.trades.reduce((sum, trade) => sum + trade.size, 0)).toBe(10);
    const profile = frames.find((frame) => frame.type === "profile");
    expect(profile?.type === "profile" && profile.buckets.reduce((sum, row) => sum + row.volume, 0)).toBe(10);
    for (const provider of ["BINANCE", "DXFEED"]) {
      const books = frames.filter((frame) => frame.type === "book" && frame.provider === provider);
      expect(books).toHaveLength(2);
      expect(books[0]).toMatchObject({ status: "READY" });
      expect(books[1]).toMatchObject({ status: "UNAVAILABLE" });
      expect(books[1]).not.toHaveProperty("bids");
      expect(books[1]).not.toHaveProperty("asks");
    }
    expect(frames.at(-1)).toMatchObject({ type: "analytics_status", status: "UNAVAILABLE" });
  });
});
