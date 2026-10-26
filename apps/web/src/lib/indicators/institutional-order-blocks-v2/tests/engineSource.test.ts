import { describe, expect, it, vi } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { parseServerFrame } from "../../../../types/frames";
import type { IndicatorLiquidity } from "../../../chart/indicatorLiquidity";
import { historicalL2, indicatorL2Of, type IndicatorL2 } from "../../../chart/indicatorL2";
import type { IndicatorBarCtx } from "../../../chart/indicatorTypes";
import { withStreamCreationWindow } from "../../../chart/ta/creationGuard";
import { withDrawOwnerScope } from "../../../chart/draw/creationScope";
import { handlesForOwners, resetDrawRegistryForTests } from "../../../chart/draw/registry";
import type { BoxData } from "../../../chart/draw/box";
import { L2Store, type L2Frame } from "../../../l2/l2Store";
import type { LiquidityColumn, LiquidityGrid } from "../../passive-liquidity/liquidityGrid";
import { ENGINE_STATUS_TEXT, HALF_WALLS, MAX_WALLS, institutionalOrderBlocksV2Indicator, type InstitutionalV2State } from "../institutionalOrderBlocksV2";
import { ENGINE_BORDER_PX, ENGINE_TAG } from "../institutionalV2Render";
import { HOLE_MS, MAX_HISTORY_HOURS, RUNTIME_HISTORY_MS, type InstitutionalV2Settings } from "../institutionalV2Rules";
import { hostWallId } from "../../../l2/hostWalls";
import type { WallHistoryStream, WallStreamListener } from "../../../l2/wallHistoryStream";
import { INSTITUTIONAL_V2_SETTINGS_SCHEMA } from "../institutionalV2Schema";

const T0 = 1_700_000_000_000;
const S = 1_000;
const STEP = 60 * S;
const COLUMN_MS = 10 * S;
const ID = { provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL" } as const;
const LIVE = { id: "PERPETUAL:BTCUSDT:1000:LIVE", state: "LIVE" };
// The BTC perp's numbers: bands of four rows, wall size 50, strong 200. The engine's wall sits on row 9 (band 2, prices 8 to 12);
// the heatmap's own wall on row 1 (band 0, prices 0 to 4), so each source has a wall of its own and the boxes tell them apart.
const ENGINE_ROW = 9;
const TRACKER_ROW = 1;
const BIG = 240;
const DEFAULTS: InstitutionalV2Settings = institutionalOrderBlocksV2Indicator.defaultSettings;

function makeBar(ts_open: number, closed = true): BarFrame {
  return {
    type: "bar", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", interval_ms: STEP,
    ts_open, open: 9.5, high: 10, low: 9, close: 9.5, volume: 100, trade_count: 10, closed,
  };
}

function book(): IndicatorLiquidity {
  const columns: LiquidityColumn[] = [];
  for (let ts = T0 - 20 * STEP; ts <= T0 + 30 * STEP; ts += COLUMN_MS) {
    const bid = new Float64Array(31);
    if (ts >= T0) bid[TRACKER_ROW] = BIG;
    columns.push({ ts, lo: 0, hi: 30, bid, ask: new Float64Array(31), buy: [], sell: [] });
  }
  return { feed: { epoch: 1, deep: null, fine: { columns, columnMs: COLUMN_MS } }, rowWidth: 1, baseAsset: "BTC", version: 1 };
}

function parse(raw: Record<string, unknown>): L2Frame {
  const frame = parseServerFrame(raw);
  if (frame === null) throw new Error(`fixture rejected: ${JSON.stringify(raw)}`);
  return frame as L2Frame;
}

function wallWire(id: number, size = BIG, start = T0, row = ENGINE_ROW): Record<string, unknown> {
  return {
    id, side: "bid", row, span: 1, start_ts: start, end_ts: null, size, peak: size, ended_by: null, ratio: 4, chain: 0, fill: 0, eaten: 0, absorbing: false,
    detail: {
      life_ms: null, first_shrink_ts: null, first_shrink_exact: false, reached_at_first_shrink: null, traded: 0, absorbed: 0, swept: 0, hidden: 0, cleared: 0,
      fill_ratio: 0, cross_side: 0, cross_side_share: 0, end_distance_rows: null, end_distance_pct: null, cleared_by_trades: false, continuity: null, repeats: 1, repeats_complete: false, evidence_gap: false,
    },
  };
}

class Feed {
  readonly store = new L2Store();
  readonly l2: IndicatorL2;
  private _seq = 0;

  constructor() {
    this.walls([], { ts: T0, reset: true });
    this.store.apply(parse({ type: "l2_events", ...ID, ts: T0, seq: 0, reset: true, missed: 0, events: [] }));
    this.l2 = indicatorL2Of(this.store, () => null)!;
  }

  resync(list: Record<string, unknown>[], ts: number): void {
    this.walls(list, { ts, reset: true });
    this.store.apply(parse({ type: "l2_events", ...ID, ts, seq: 0, reset: true, missed: 0, events: [] }));
  }

  walls(list: Record<string, unknown>[], { ts = T0, reset = false, removed = [] as number[], segment = LIVE as Record<string, unknown> } = {}): void {
    this._seq += 1;
    this.store.apply(parse({ type: "l2_walls", ...ID, ts, seq: this._seq, reset, row_width: 1, walls: list, removed, segment }));
  }
}

function context(state: InstitutionalV2State, bar: BarFrame, settings: InstitutionalV2Settings, liquidity: IndicatorLiquidity | undefined, l2: IndicatorL2 | undefined): IndicatorBarCtx<InstitutionalV2State, InstitutionalV2Settings> {
  return {
    bar, trades: [], tradeAvailability: "LIVE_COMPLETE", liquidity, l2, state, settings, replace: false, replaying: false,
    ta: {}, draw: { fill: vi.fn() }, markers: { plotshape: vi.fn(), plotchar: vi.fn() }, pane: { paneIndex: 0 },
  };
}

function createState(settings: InstitutionalV2Settings, ownerId: string): InstitutionalV2State {
  resetDrawRegistryForTests();
  return withDrawOwnerScope(ownerId, () => withStreamCreationWindow(() => institutionalOrderBlocksV2Indicator.createState(settings)));
}

/** Closed bars from T0, one a minute, `count` of them, all with the same book and feed. */
function run(state: InstitutionalV2State, settings: InstitutionalV2Settings, count: number, liquidity: IndicatorLiquidity | undefined, l2: IndicatorL2 | undefined, from = 0): void {
  for (let i = from; i < from + count; i += 1) institutionalOrderBlocksV2Indicator.onBar(context(state, makeBar(T0 + i * STEP), settings, liquidity, l2));
}

function boxes(ownerId: string): BoxData[] {
  return handlesForOwners([ownerId]).filter((record) => record.kind === "box").map((record) => record.data as BoxData).filter((box) => box.time1 !== 0);
}

function wallBoxes(ownerId: string): BoxData[] {
  return boxes(ownerId).filter((box) => !box.text.startsWith("IOB v2 ·"));
}

function statusBox(ownerId: string): BoxData | undefined {
  return boxes(ownerId).find((box) => box.text.startsWith("IOB v2 ·"));
}

describe("IOB v2 wall source: the setting", () => {
  it("ships on the engine, with a three-way choice in the dialog", () => {
    expect(DEFAULTS.source).toBe("engine");
    const field = INSTITUTIONAL_V2_SETTINGS_SCHEMA.find((entry) => "key" in entry && entry.key === "source");
    expect(field).toMatchObject({ kind: "radioGroup", affects: "recompute" });
    expect(field?.kind === "radioGroup" ? field.options.map((option) => option.value) : null).toEqual(["engine", "tracker", "both"]);
  });
});

describe("IOB v2 wall source: what each source draws", () => {
  it("on the engine, draws the engine's wall and not the heatmap's", () => {
    const feed = new Feed();
    feed.walls([wallWire(1)]);
    const state = createState(DEFAULTS, "engine");
    run(state, DEFAULTS, 4, book(), feed.l2);
    const drawn = wallBoxes("engine");
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).toMatchObject({ time1: T0, price1: 12, price2: 8, borderWidth: 1 });
    expect(drawn[0].text).toBe("Strong OB · 240 BTC · Fresh · 41/100");
    expect(statusBox("engine")).toBeUndefined();
  });

  it("on the engine, the heatmap tracker does no work at all", () => {
    const feed = new Feed();
    feed.walls([wallWire(1)]);
    const state = createState(DEFAULTS, "idle-tracker");
    run(state, DEFAULTS, 4, book(), feed.l2);
    expect(state.tracker.lastTs).toBeNull();
    expect(state.tracker.open.size).toBe(0);
  });

  it("starts the engine read over when the row width changes, since the bands mean different prices", () => {
    const feed = new Feed();
    feed.walls([wallWire(1)]);
    const state = createState(DEFAULTS, "rewidth");
    feed.walls([wallWire(1), wallWire(2, BIG, T0, 3)], { ts: T0 + S });
    run(state, DEFAULTS, 4, book(), feed.l2);
    const before = state.engine;
    expect(before.open.size).toBe(2);
    expect(wallBoxes("rewidth").map((box) => box.price1).sort()).toEqual([12, 4]);
    const wider: IndicatorLiquidity = { ...book(), rowWidth: 2 };
    run(state, DEFAULTS, 1, wider, feed.l2, 4);
    expect(state.engine).not.toBe(before);
    expect(state.engine.version).toBe(feed.l2.version);
    expect(wallBoxes("rewidth").map((box) => [box.price1, box.price2])).toEqual([[8, 0]]);
  });

  it("on the tracker, draws the heatmap's wall and ignores the engine", () => {
    const feed = new Feed();
    feed.walls([wallWire(1)]);
    const settings = { ...DEFAULTS, source: "tracker" as const };
    const state = createState(settings, "tracker");
    run(state, settings, 4, book(), feed.l2);
    const drawn = wallBoxes("tracker");
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).toMatchObject({ price1: 4, price2: 0, borderWidth: 1 });
  });

  it("on both, draws the two side by side and marks the engine's", () => {
    const feed = new Feed();
    feed.walls([wallWire(1)]);
    const settings = { ...DEFAULTS, source: "both" as const };
    const state = createState(settings, "both");
    run(state, settings, 4, book(), feed.l2);
    const drawn = wallBoxes("both").sort((a, b) => a.price1 - b.price1);
    expect(drawn).toHaveLength(2);
    expect(drawn[0]).toMatchObject({ price1: 4, price2: 0, borderWidth: 1 });
    expect(drawn[0].text.startsWith(ENGINE_TAG)).toBe(false);
    expect(drawn[1]).toMatchObject({ price1: 12, price2: 8, borderWidth: ENGINE_BORDER_PX });
    expect(drawn[1].text).toBe(`${ENGINE_TAG} · Strong OB · 240 BTC · Fresh · 41/100`);
    expect(handlesForOwners(["both"]).filter((record) => record.kind === "box")).toHaveLength(MAX_WALLS + 1);
    expect(HALF_WALLS * 2).toBe(MAX_WALLS);
  });

  it("switching the source at the same bar redraws from the other one and clears the old boxes", () => {
    const feed = new Feed();
    feed.walls([wallWire(1)]);
    const state = createState(DEFAULTS, "switch");
    run(state, DEFAULTS, 4, book(), feed.l2);
    expect(wallBoxes("switch").map((box) => box.price1)).toEqual([12]);
    run(state, { ...DEFAULTS, source: "tracker" }, 1, book(), feed.l2, 3);
    expect(wallBoxes("switch").map((box) => box.price1)).toEqual([4]);
  });
});

describe("IOB v2 wall source: trust, gaps and modes", () => {
  it("hides the engine's walls and says so while the feed is untrusted, and draws them again once it resyncs", () => {
    const feed = new Feed();
    feed.walls([wallWire(1)]);
    const state = createState(DEFAULTS, "trust");
    run(state, DEFAULTS, 4, book(), feed.l2);
    expect(wallBoxes("trust")).toHaveLength(1);
    feed.store.markUntrusted();
    run(state, DEFAULTS, 1, book(), feed.l2, 3);
    expect(wallBoxes("trust")).toHaveLength(0);
    expect(statusBox("trust")).toMatchObject({ text: ENGINE_STATUS_TEXT.untrusted, time1: T0 + 3 * STEP, price1: 9.5 });
    feed.resync([wallWire(1)], T0 + 4 * STEP);
    run(state, DEFAULTS, 1, book(), feed.l2, 4);
    expect(wallBoxes("trust")).toHaveLength(1);
    expect(statusBox("trust")).toBeUndefined();
  });

  it("on the tracker, an untrusted engine changes nothing", () => {
    const feed = new Feed();
    feed.walls([wallWire(1)]);
    feed.store.markUntrusted();
    const settings = { ...DEFAULTS, source: "tracker" as const };
    const state = createState(settings, "tracker-trust");
    run(state, settings, 4, book(), feed.l2);
    expect(wallBoxes("tracker-trust")).toHaveLength(1);
    expect(statusBox("tracker-trust")).toBeUndefined();
  });

  it("says it is unavailable in Historical Mode and draws no wall", () => {
    const state = createState(DEFAULTS, "historical");
    run(state, DEFAULTS, 4, book(), historicalL2());
    expect(wallBoxes("historical")).toHaveLength(0);
    expect(statusBox("historical")?.text).toBe(ENGINE_STATUS_TEXT.historical);
  });

  it("says it is waiting while no L2 frame has arrived", () => {
    const state = createState(DEFAULTS, "waiting");
    run(state, DEFAULTS, 4, book(), undefined);
    expect(wallBoxes("waiting")).toHaveLength(0);
    expect(statusBox("waiting")?.text).toBe(ENGINE_STATUS_TEXT["no-l2"]);
  });

  it("hides the walls when the engine's last frame is older than the hole tolerance", () => {
    const feed = new Feed();
    feed.walls([wallWire(1)]);
    const state = createState(DEFAULTS, "stale");
    run(state, DEFAULTS, 4, book(), feed.l2);
    expect(wallBoxes("stale")).toHaveLength(1);
    const later = Math.ceil(HOLE_MS / STEP) + 4;
    institutionalOrderBlocksV2Indicator.onBar(context(state, makeBar(T0 + later * STEP), DEFAULTS, book(), feed.l2));
    expect(wallBoxes("stale")).toHaveLength(0);
    expect(statusBox("stale")?.text).toBe(ENGINE_STATUS_TEXT.stale);
  });

  it("clears the engine's walls on a pair switch", () => {
    const feed = new Feed();
    feed.walls([wallWire(1)]);
    const state = createState(DEFAULTS, "pair");
    run(state, DEFAULTS, 4, book(), feed.l2);
    expect(wallBoxes("pair")).toHaveLength(1);
    feed.walls([], { ts: T0 + 4 * STEP, reset: true, segment: { id: "SPOT:ETHUSDT:2000:LIVE", state: "LIVE" } });
    run(state, DEFAULTS, 1, book(), feed.l2, 4);
    expect(wallBoxes("pair")).toHaveLength(0);
    expect(statusBox("pair")).toBeUndefined();
  });

  it("draws nothing and shows no status without a book, whatever the source", () => {
    const feed = new Feed();
    feed.walls([wallWire(1)]);
    for (const source of ["engine", "tracker", "both"] as const) {
      const settings = { ...DEFAULTS, source };
      const state = createState(settings, `nobook-${source}`);
      run(state, settings, 4, undefined, feed.l2);
      expect(boxes(`nobook-${source}`)).toHaveLength(0);
    }
  });
});

describe("IOB v2 history from the host", () => {
  it("asks the runtime for its day of walls, then the host for the rest up to the History setting, adopts the host's pages as they land, and keeps them for the reach", () => {
    const feed = new Feed();
    const asked: [string, number, number][] = [];
    const wants: [number, number][] = [];
    let listener: WallStreamListener | null = null;
    const history = async (kind: string, request: { from_ts: number; to_ts: number }) => { asked.push([kind, request.from_ts, request.to_ts]); return null; };
    const hostWalls = { want: (fromTs: number, toTs: number) => { wants.push([fromTs, toTs]); }, subscribe: (l: WallStreamListener) => { listener = l; return () => { listener = null; }; }, status: () => ({ oldestDone: null, inFlight: 0, unavailable: null }) } as unknown as WallHistoryStream;
    const lane0 = { rowWidth: 1, columnMs: 1_000, deepColumnMs: 10_000, columns: [{ ts: T0, lo: 0, hi: 20, bid: new Float64Array(21), ask: new Float64Array(21) }] } as unknown as LiquidityGrid;
    const l2 = indicatorL2Of(feed.store, () => lane0, history as never, hostWalls)!;
    expect(l2.hostWalls).toBe(hostWalls);
    const settings = { ...DEFAULTS, historyHours: 72 };
    const state = createState(settings, "host");
    run(state, settings, 1, book(), l2);
    const edge = T0 + STEP;
    expect(asked).toEqual([["wall_history", edge - RUNTIME_HISTORY_MS, edge]]);
    expect(wants).toEqual([[edge - 72 * 3_600_000, edge - RUNTIME_HISTORY_MS]]);
    expect(MAX_HISTORY_HOURS).toBe(168);
    const twoDaysAgo = T0 - 2 * 86_400_000;
    const hostWall = { id: hostWallId(5), lane: 0, side: "bid" as const, row: ENGINE_ROW, span: 1, startTs: twoDaysAgo, endTs: twoDaysAgo + 600_000, size: 0, peak: BIG, endedBy: "pulled" as const, ratio: 2, chain: 0, fill: 0.5, eaten: 0, absorbing: false, detail: null };
    listener!.onWalls([hostWall], 1);
    listener!.onWalls([{ ...hostWall, id: hostWallId(6), row: ENGINE_ROW + 8, startTs: twoDaysAgo + 1_200_000, endTs: twoDaysAgo + 1_800_000 }], 1);
    run(state, settings, 1, book(), l2, 1);
    expect(state.engine.adopted.has(hostWallId(5))).toBe(true);
    expect(state.engine.adopted.has(hostWallId(6))).toBe(true);
    expect(state.engine.memory.size).toBe(2);
    expect(wants).toHaveLength(1);
    run(state, settings, 3, book(), l2, 2);
    expect(state.engine.memory.size).toBe(2);
    run(state, { ...settings, historyHours: 1 }, 1, book(), l2, 5);
    expect(state.engine.memory.size).toBe(0);
    run(state, { ...settings, historyHours: 12 }, 1, book(), l2, 6);
    expect(wants).toHaveLength(1);
    expect(institutionalOrderBlocksV2Indicator.createState(settings).bars).toEqual([]);
  });
});
