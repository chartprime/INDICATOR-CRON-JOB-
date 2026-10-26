// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { useMarketData, type UseMarketDataResult } from "./useMarketData";
import type { L2ViewFrame, LiquidityFrame, ServerFrame } from "../types/frames";
import type { WorkerToMainMessage } from "../workers/marketDataWorker";
import { LaneDecoder } from "../lib/l2/laneGrids";
import { LiquidityDecoder } from "../lib/indicators/passive-liquidity/liquidityGrid";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Report 61 P4b: the hook routes the four L2 channels of the live pair into
// one store, asks the worker for a single channel when that channel breaks,
// clears every model on a pair switch (snapshot or not), and keeps them but
// untrusted across a dropped socket until the server's resets arrive.

class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerToMainMessage>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: Event) => void) | null = null;
  posted: unknown[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {}
  emit(msg: WorkerToMainMessage): void {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerToMainMessage>);
  }
}

let lastWorker: FakeWorker;
let rafCallbacks: FrameRequestCallback[] = [];

beforeEach(() => {
  rafCallbacks = [];
  vi.stubGlobal("Worker", class {
    constructor() {
      lastWorker = new FakeWorker();
      return lastWorker as unknown as Worker;
    }
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

function flushRaf(): void {
  const cbs = rafCallbacks;
  rafCallbacks = [];
  for (const cb of cbs) cb(0);
}

const PAIR = { symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" } as const;
const SEGMENT = { id: "SPOT:BTCUSDT:1000:LIVE", state: "LIVE" } as const;

function selection(symbol = "BTC-USDT"): ServerFrame {
  return { type: "selection", ...PAIR, symbol } as ServerFrame;
}

function walls(seq: number, reset: boolean, ids: number[], symbol = "BTC-USDT"): ServerFrame {
  return {
    type: "l2_walls", ...PAIR, symbol, ts: 10_000 + seq, seq, reset, row_width: 0.5, removed: [], segment: SEGMENT,
    walls: ids.map((id) => ({ id, lane: 0, side: "bid", row: 200, span: 1, start_ts: 1_000, end_ts: null, size: 12, peak: 12, ended_by: null, ratio: 4, chain: 0, fill: 0, eaten: 0, absorbing: false, detail: null })),
  } as ServerFrame;
}

function events(seq: number, reset: boolean): ServerFrame {
  return { type: "l2_events", ...PAIR, ts: 20_000, seq, reset, missed: 0, events: [{ event: "hidden", ts: 19_000, side: "bid", price: 100, volume: 1 }] } as ServerFrame;
}

function ladder(): ServerFrame {
  return { type: "l2_ladder", ...PAIR, ts: 20_000, depth: 50, bids: [[100, 1]], asks: [[101, 1]], segment: SEGMENT } as ServerFrame;
}

function view(seq: number, reset: boolean): ServerFrame {
  return { type: "l2_view", ...PAIR, lane: 1, tier: "recent", ts: 4_000, seq, reset, row_width: 8, column_ms: 2_000, columns: [{ ts: 4_000, lo: 100, hi: 101, bid: [[0, 1]], ask: [[1, 1]] }], segment: SEGMENT } as ServerFrame;
}

async function mounted(): Promise<{ latest: () => UseMarketDataResult; unmount: () => Promise<void> }> {
  const root = createRoot(document.createElement("div"));
  let current!: UseMarketDataResult;
  function Harness() {
    current = useMarketData({ url: "ws://test" });
    return null;
  }
  await act(async () => root.render(<Harness />));
  await act(async () => lastWorker.emit({ kind: "frame", frame: selection() }));
  return { latest: () => current, unmount: async () => act(async () => root.unmount()) };
}

const emit = (frame: ServerFrame) => lastWorker.emit({ kind: "frame", frame });

describe("useMarketData: the L2 channels (report 61 P4b)", () => {
  it("delivers the live pair's four channels into one store, published at the next frame flush", async () => {
    const { latest, unmount } = await mounted();
    try {
      await act(async () => {
        emit(view(1, true));
        emit(walls(1, true, [1, 2]));
        emit(events(1, true));
        emit(ladder());
      });
      expect(latest().l2).toBeNull();
      await act(async () => flushRaf());
      const store = latest().l2;
      expect(store).not.toBeNull();
      expect(store?.walls.list().map((wall) => wall.id)).toEqual([1, 2]);
      expect(store?.events.since().events).toHaveLength(1);
      expect(store?.ladder.ladder?.bids).toEqual([[100, 1]]);
      expect(store?.lanes.lanes()).toHaveLength(1);
      expect(store?.trusted()).toBe(true);
      expect(latest().l2Version).toBeGreaterThan(0);
    } finally {
      await unmount();
    }
  });

  it("takes the worker's decoded columns when it sends them, with the rows no longer on the frame (P4c.1)", async () => {
    const { latest, unmount } = await mounted();
    try {
      const strip = <F extends L2ViewFrame | LiquidityFrame>(frame: F): F => ({ ...frame, columns: frame.columns.map((column) => ({ ...column, bid: [], ask: [] })) });
      const laneFrame = view(1, true) as L2ViewFrame;
      const heatFrame = { type: "liquidity", ...PAIR, ts: 4_000, seq: 1, reset: true, row_width: 4, column_ms: 1_000, columns: [{ ts: 4_000, lo: 10, hi: 12, bid: [[0, 7]], ask: [[2, 9]] }] } as LiquidityFrame;
      await act(async () => {
        lastWorker.emit({ kind: "frame", frame: strip(laneFrame), decodedLane: new LaneDecoder().decode(laneFrame) });
        lastWorker.emit({ kind: "frame", frame: strip(heatFrame), decodedLiquidity: new LiquidityDecoder().decode(heatFrame) });
        flushRaf();
      });
      expect(Array.from(latest().l2!.lanes.view(1)!.fine.columns[0].bid)).toEqual([1, 0]);
      expect(Array.from(latest().liquidity!.columns[0].ask)).toEqual([0, 0, 9]);
    } finally {
      await unmount();
    }
  });

  it("ignores another pair's channels", async () => {
    const { latest, unmount } = await mounted();
    try {
      await act(async () => {
        emit(walls(1, true, [1], "ETH-USDT"));
        flushRaf();
      });
      expect(latest().l2).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("shows an untrusted feed when its first frame is an increment without a snapshot", async () => {
    const { latest, unmount } = await mounted();
    try {
      await act(async () => {
        emit(walls(3, false, [1]));
        flushRaf();
      });
      expect(latest().l2?.status("l2_walls").synced).toBe(false);
      expect(lastWorker.posted).toContainEqual({ kind: "l2_resync", channel: "l2_walls" });
    } finally {
      await unmount();
    }
  });

  it("a broken chain asks the worker for that one channel, once per debounce window", async () => {
    const { unmount } = await mounted();
    try {
      await act(async () => {
        emit(walls(1, true, [1]));
        emit(walls(5, false, [2]));
        emit(walls(6, false, [3]));
      });
      const asks = lastWorker.posted.filter((message) => (message as { kind: string }).kind === "l2_resync");
      expect(asks).toEqual([{ kind: "l2_resync", channel: "l2_walls" }]);
    } finally {
      await unmount();
    }
  });

  it("publishes a newly untrusted channel on a sequence gap without waiting for another accepted frame", async () => {
    const { latest, unmount } = await mounted();
    try {
      await act(async () => {
        emit(walls(1, true, [1]));
        emit(events(1, true));
        emit(ladder());
        flushRaf();
      });
      expect(latest().l2?.trusted()).toBe(true);
      const previousVersion = latest().l2Version;
      await act(async () => {
        emit(walls(3, false, [2]));
        flushRaf();
      });
      expect(latest().l2?.status("l2_walls").synced).toBe(false);
      expect(latest().l2Version).toBeGreaterThan(previousVersion);
    } finally {
      await unmount();
    }
  });

  it("a pair switch clears all four models even though no snapshot for the new pair has arrived", async () => {
    const { latest, unmount } = await mounted();
    try {
      await act(async () => {
        emit(view(1, true));
        emit(walls(1, true, [1]));
        emit(events(1, true));
        emit(ladder());
        flushRaf();
      });
      const store = latest().l2!;
      const before = latest().l2Version;
      await act(async () => emit(selection("ETH-USDT")));
      expect(store.walls.list()).toEqual([]);
      expect(store.events.since().events).toEqual([]);
      expect(store.ladder.ladder).toBeNull();
      expect(store.lanes.lanes()).toEqual([]);
      expect(store.segment).toBeNull();
      expect(latest().l2Version).toBeGreaterThan(before);
    } finally {
      await unmount();
    }
  });

  it("a dropped socket keeps the models untrusted until the server's resets arrive", async () => {
    const { latest, unmount } = await mounted();
    try {
      await act(async () => {
        emit(walls(1, true, [1]));
        emit(events(1, true));
        emit(ladder());
        flushRaf();
      });
      const store = latest().l2!;
      await act(async () => lastWorker.emit({ kind: "status", status: "closed" }));
      expect(store.walls.list()).toHaveLength(1);
      expect(store.trusted()).toBe(false);
      await act(async () => {
        lastWorker.emit({ kind: "status", status: "open" });
        emit(selection());
        emit(walls(1, true, [1]));
        emit(events(1, true));
        emit(ladder());
        flushRaf();
      });
      expect(store.trusted()).toBe(true);
    } finally {
      await unmount();
    }
  });
});

describe("useMarketData: the column stream beside the heatmap history", () => {
  it("follows the confirmed pair, asks the worker for 10 s pages under its own ids, and gets its answers routed back by those ids", async () => {
    const { latest, unmount } = await mounted();
    try {
      const stream = latest().columnHistory;
      const history = latest().heatmapHistory;
      if (stream === null || history === null) throw new Error("expected a stream and a history store");
      const chunks: [number, boolean][] = [];
      stream.subscribe({ onPage: () => undefined, onChunk: (start, done) => chunks.push([start, done]) });
      stream.want(1_757_340_000_000, 1_757_343_600_000, 600_000, 240_000);
      const request = lastWorker.posted.filter((m) => (m as { kind: string }).kind === "heatmap_history").at(-1) as { request_id: number; provider: string; market_kind: string; symbol: string; level_ms: number; row_factor: number };
      expect(request).toMatchObject({ provider: "BINANCE", market_kind: "SPOT", symbol: "BTC-USDT", level_ms: 10_000, row_factor: 1 });
      expect(stream.owns(request.request_id)).toBe(true);
      await act(async () => lastWorker.emit({ kind: "heatmap_history", request_id: request.request_id, page: { available: false, reason: "NO_PYRAMID" }, failed: false }));
      expect(chunks).toEqual([[1_757_340_000_000, false]]);
      expect(stream.status().unavailable).toBe("NO_PYRAMID");
      expect(history.status(10_000, 1).unavailable).toBeNull();
      await act(async () => lastWorker.emit({ kind: "frame", frame: selection("ETH-USDT") }));
      expect(stream.status().unavailable).toBeNull();
      expect(stream.identity).toMatchObject({ symbol: "ETH-USDT" });
    } finally {
      await unmount();
    }
  });
});

describe("useMarketData: the host wall stream beside the heatmap history", () => {
  it("follows the confirmed pair, asks the worker for wall pages under its own kind and ids, and gets its answers routed back", async () => {
    const { latest, unmount } = await mounted();
    try {
      const stream = latest().hostWalls;
      if (stream === null) throw new Error("expected a wall stream");
      const chunks: [number, boolean][] = [];
      stream.subscribe({ onWalls: () => undefined, onChunk: (start, done) => chunks.push([start, done]) });
      stream.want(1_757_300_000_000, 1_757_321_600_000);
      const request = lastWorker.posted.filter((m) => (m as { kind: string }).kind === "heatmap_walls").at(-1) as { request_id: number; provider: string; market_kind: string; symbol: string; limit: number; after: unknown };
      expect(request).toMatchObject({ provider: "BINANCE", market_kind: "SPOT", symbol: "BTC-USDT", limit: 400, after: null });
      expect(stream.owns(request.request_id)).toBe(true);
      await act(async () => lastWorker.emit({ kind: "heatmap_walls", request_id: request.request_id, page: { available: false, reason: "NO_PYRAMID" }, failed: false }));
      expect(chunks).toEqual([[1_757_300_000_000 - (1_757_300_000_000 % 21_600_000), false]]);
      expect(stream.status().unavailable).toBe("NO_PYRAMID");
      await act(async () => lastWorker.emit({ kind: "frame", frame: selection("ETH-USDT") }));
      expect(stream.identity).toMatchObject({ symbol: "ETH-USDT" });
      expect(stream.status().unavailable).toBeNull();
    } finally {
      await unmount();
    }
  });
});

describe("useMarketData: the whale wall stream beside the host wall stream", () => {
  it("follows the confirmed pair under its own ids and twelve-hour chunks, sends its filter, and gets its answers routed back without the other stream hearing them", async () => {
    const { latest, unmount } = await mounted();
    try {
      const whale = latest().whaleWalls;
      const host = latest().hostWalls;
      if (whale === null || host === null) throw new Error("expected both wall streams");
      const whaleChunks: [number, boolean][] = [];
      const hostChunks: [number, boolean][] = [];
      whale.subscribe({ onWalls: () => undefined, onChunk: (start, done) => whaleChunks.push([start, done]) });
      host.subscribe({ onWalls: () => undefined, onChunk: (start, done) => hostChunks.push([start, done]) });
      const wallRequests = () => lastWorker.posted.filter((m) => (m as { kind: string }).kind === "heatmap_walls") as { request_id: number; provider: string; market_kind: string; symbol: string; limit: number; after: unknown; min_usd?: number; always_outcomes?: string[] }[];
      whale.setFilter({ minUsd: 5_000_000, alwaysOutcomes: ["filled", "partial"] });
      whale.want(1_757_313_000_000, 1_757_331_000_000);
      const asked = wallRequests().at(-1)!;
      expect(asked).toMatchObject({ provider: "BINANCE", market_kind: "SPOT", symbol: "BTC-USDT", limit: 400, after: null, min_usd: 5_000_000, always_outcomes: ["filled", "partial"] });
      expect(whale.owns(asked.request_id)).toBe(true);
      expect(host.owns(asked.request_id)).toBe(false);
      await act(async () => lastWorker.emit({ kind: "heatmap_walls", request_id: asked.request_id, page: { available: false, reason: "NO_PYRAMID" }, failed: false }));
      expect(whaleChunks).toEqual([[1_757_313_000_000 - (1_757_313_000_000 % 43_200_000), false]]);
      expect(hostChunks).toEqual([]);
      expect(whale.status().unavailable).toBe("NO_PYRAMID");
      expect(host.status().unavailable).toBeNull();
      host.want(1_757_300_000_000, 1_757_321_600_000);
      const hostAsked = wallRequests().at(-1)!;
      expect(host.owns(hostAsked.request_id)).toBe(true);
      expect(Object.hasOwn(hostAsked, "min_usd")).toBe(false);
      await act(async () => lastWorker.emit({ kind: "heatmap_walls", request_id: hostAsked.request_id, page: { available: false, reason: "NO_PYRAMID" }, failed: false }));
      expect(hostChunks).toEqual([[1_757_300_000_000 - (1_757_300_000_000 % 21_600_000), false]]);
      expect(whaleChunks).toHaveLength(1);
      await act(async () => lastWorker.emit({ kind: "frame", frame: selection("ETH-USDT") }));
      expect(whale.identity).toMatchObject({ symbol: "ETH-USDT" });
      expect(whale.status().unavailable).toBeNull();
    } finally {
      await unmount();
    }
  });
});

describe("useMarketData: the whale wall stream's failures and teardown", () => {
  it("hands a failed answer with its retry delay to the whale stream alone, and lets go of its pair and its place in the hook's result on unmount", async () => {
    const { latest, unmount } = await mounted();
    let whale: ReturnType<typeof latest>["whaleWalls"] = null;
    try {
      whale = latest().whaleWalls;
      const host = latest().hostWalls;
      if (whale === null || host === null) throw new Error("expected both wall streams");
      const whaleFail = vi.spyOn(whale, "fail");
      const hostFail = vi.spyOn(host, "fail");
      whale.want(1_757_300_000_000, 1_757_321_600_000);
      const asked = lastWorker.posted.filter((m) => (m as { kind: string }).kind === "heatmap_walls").at(-1) as { request_id: number };
      await act(async () => lastWorker.emit({ kind: "heatmap_walls", request_id: asked.request_id, page: null, failed: true, retry_after_ms: 750 }));
      expect(whaleFail).toHaveBeenCalledWith(asked.request_id, 750);
      expect(hostFail).not.toHaveBeenCalled();
      expect(whale.identity).toMatchObject({ symbol: "BTC-USDT" });
    } finally {
      await unmount();
    }
    expect(whale?.identity).toBeNull();
  });
});

describe("useMarketData: L2 history requests", () => {
  const range = { from_ts: 1_000, to_ts: 2_000, price_lo: 99, price_hi: 101 };
  const wallReply = (requestId: number, symbol = "BTC-USDT"): ServerFrame =>
    ({ type: "wall_history", ...PAIR, symbol, request_id: requestId, row_width: 0.5, walls: [], next: null }) as unknown as ServerFrame;

  const open = () => act(async () => lastWorker.emit({ kind: "status", status: "open" }));

  it("routes the live pair's answer back to the request by its id, and answers another pair's with null", async () => {
    const { latest, unmount } = await mounted();
    try {
      await open();
      const first = latest().requestL2History("wall_history", range);
      const second = latest().requestL2History("l2_event_history", range);
      const asked = lastWorker.posted.filter((m) => ["wall_history", "l2_event_history"].includes((m as { kind: string }).kind)) as { kind: string; request_id: number }[];
      expect(asked.map((m) => m.kind)).toEqual(["wall_history", "l2_event_history"]);
      expect(asked[0]).toMatchObject(range);
      await act(async () => emit(wallReply(asked[1].request_id, "ETH-USDT")));
      await act(async () => emit(wallReply(asked[0].request_id)));
      await expect(first).resolves.toMatchObject({ type: "wall_history", request_id: asked[0].request_id });
      await expect(second).resolves.toBeNull();
    } finally {
      await unmount();
    }
  });

  it("answers null at once to a request made while the socket is not open, since the worker would drop it, and to one still out when the socket closes", async () => {
    const { latest, unmount } = await mounted();
    try {
      const asked = () => lastWorker.posted.filter((m) => (m as { kind: string }).kind === "wall_history").length;
      await expect(latest().requestL2History("wall_history", range)).resolves.toBeNull();
      expect(asked()).toBe(0);
      await open();
      const out = latest().requestL2History("wall_history", range);
      expect(asked()).toBe(1);
      await act(async () => lastWorker.emit({ kind: "status", status: "closed", reason: "server-close:1006:" }));
      await expect(out).resolves.toBeNull();
      // A retry while the worker reconnects would be dropped there and never answered.
      await act(async () => lastWorker.emit({ kind: "status", status: "connecting" }));
      await expect(latest().requestL2History("wall_history", range)).resolves.toBeNull();
      expect(asked()).toBe(1);
    } finally {
      await unmount();
    }
  });

  it("answers null to a request still out at unmount and to one made after it, instead of never", async () => {
    const { latest, unmount } = await mounted();
    await open();
    const request = latest().requestL2History;
    const pending = request("wall_history", range);
    await unmount();
    await expect(pending).resolves.toBeNull();
    await expect(request("l2_event_history", range)).resolves.toBeNull();
  });
});

describe("useMarketData: a busy host's retry delay", () => {
  it("hands the delay the worker reports to the column stream, the heatmap history and the wall stream that asked", async () => {
    const { latest, unmount } = await mounted();
    try {
      const stream = latest().columnHistory;
      const history = latest().heatmapHistory;
      const walls = latest().hostWalls;
      if (stream === null || history === null || walls === null) throw new Error("expected the three history stores");
      const streamFail = vi.spyOn(stream, "fail");
      const historyFail = vi.spyOn(history, "fail");
      const wallsFail = vi.spyOn(walls, "fail");
      const lastOf = (kind: string) => lastWorker.posted.filter((m) => (m as { kind: string }).kind === kind).at(-1) as { request_id: number };
      stream.want(1_757_340_000_000, 1_757_343_600_000, 600_000, 240_000);
      const columns = lastOf("heatmap_history");
      await act(async () => lastWorker.emit({ kind: "heatmap_history", request_id: columns.request_id, page: null, failed: true, retry_after_ms: 250 }));
      expect(streamFail).toHaveBeenCalledWith(columns.request_id, 250);
      history.want({ levelMs: 60_000, rowFactor: 1, fromTs: 1_757_340_000_000, toTs: 1_757_340_600_000, beforeTs: Infinity });
      const heat = lastOf("heatmap_history");
      await act(async () => lastWorker.emit({ kind: "heatmap_history", request_id: heat.request_id, page: null, failed: true, retry_after_ms: 4_000 }));
      expect(historyFail).toHaveBeenCalledWith(heat.request_id, 4_000);
      walls.want(1_757_300_000_000, 1_757_321_600_000);
      const asked = lastOf("heatmap_walls");
      await act(async () => lastWorker.emit({ kind: "heatmap_walls", request_id: asked.request_id, page: null, failed: true, retry_after_ms: 250 }));
      expect(wallsFail).toHaveBeenCalledWith(asked.request_id, 250);
    } finally {
      await unmount();
    }
  });
});

describe("useMarketData: the heatmap history (report 61 P4c.4)", () => {
  it("follows the confirmed pair, asks the worker for pages, and never counts a page as a delivered frame", async () => {
    const { latest, unmount } = await mounted();
    try {
      const history = latest().heatmapHistory;
      if (history === null) throw new Error("expected a history store");
      const acksBefore = lastWorker.posted.filter((m) => (m as { kind: string }).kind === "ack").length;
      history.want({ levelMs: 60_000, rowFactor: 1, fromTs: 1_757_340_000_000, toTs: 1_757_340_600_000, beforeTs: Infinity });
      const request = lastWorker.posted.find((m) => (m as { kind: string }).kind === "heatmap_history") as { request_id: number; provider: string; market_kind: string; symbol: string };
      expect(request).toMatchObject({ provider: "BINANCE", market_kind: "SPOT", symbol: "BTC-USDT", level_ms: 60_000, row_factor: 1 });
      await act(async () => lastWorker.emit({ kind: "heatmap_history", request_id: request.request_id, page: { available: false, reason: "NO_PYRAMID" }, failed: false }));
      expect(history.status(60_000, 1).unavailable).toBe("NO_PYRAMID");
      expect(lastWorker.posted.filter((m) => (m as { kind: string }).kind === "ack").length).toBe(acksBefore);
      await act(async () => lastWorker.emit({ kind: "frame", frame: selection("ETH-USDT") }));
      expect(history.status(60_000, 1).unavailable).toBeNull();
      history.want({ levelMs: 60_000, rowFactor: 1, fromTs: 1_757_340_000_000, toTs: 1_757_340_600_000, beforeTs: Infinity });
      const second = lastWorker.posted.filter((m) => (m as { kind: string }).kind === "heatmap_history").at(-1);
      expect(second).toMatchObject({ symbol: "ETH-USDT" });
    } finally {
      await unmount();
    }
  });
});
