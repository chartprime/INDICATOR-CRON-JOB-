import { describe, expect, it, vi } from "vitest";
import type { MarkerFrame } from "../../../../types/frames";
import type { WhaleTradeStat } from "../whaleTrades";
import { WhaleMarkersPrimitive } from "../whaleMarkersPrimitive";

function stat(overrides: Partial<MarkerFrame> = {}): WhaleTradeStat {
  const marker: MarkerFrame = {
    type: "marker",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    ts_exchange: 60_000,
    price: 100,
    size: 10,
    side: "buy",
    trade_id: "trade-1",
    ...overrides,
  } as MarkerFrame;
  return { marker, magnitude: marker.price * marker.size};
}

function attach(primitive: WhaleMarkersPrimitive) {
  const requestUpdate = vi.fn();
  primitive.attached({
    chart: {
      timeScale: () => ({
        getVisibleRange: () => ({ from: 0, to: 120 }),
        timeToCoordinate: (time: number) => time * 10,
      }),
    },
    series: { priceToCoordinate: (price: number) => price * 2 },
    requestUpdate,
  } as never);
  return requestUpdate;
}

describe("WhaleMarkersPrimitive", () => {
  it("projects clusters into render and hit-test coordinates only while attached", () => {
    const primitive = new WhaleMarkersPrimitive();
    const requestUpdate = attach(primitive);

    primitive.setStats([stat()], 60_000, "delta");
    expect(requestUpdate).toHaveBeenCalledTimes(1);

    primitive.updateAllViews();
    expect(primitive.renderPoints).toHaveLength(1);
    expect(primitive.renderPoints[0]).toMatchObject({ x: 600, y: 200, stroke: "#16a34a", label: "10" });
    expect(primitive.hitTestCluster(600, 200)?.stats[0].marker.trade_id).toBe("trade-1");

    primitive.detached();
    primitive.updateAllViews();
    expect(primitive.renderPoints).toEqual([]);
    expect(primitive.hitTestCluster(600, 200)).toBeNull();
  });

  it("does not render clusters outside the chart's visible time range", () => {
    const primitive = new WhaleMarkersPrimitive();
    attach(primitive);
    primitive.setStats([stat({ ts_exchange: 180_001 })], 60_000, "delta");

    primitive.updateAllViews();
    expect(primitive.renderPoints).toEqual([]);
  });
});
