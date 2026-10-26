import type { L2EventSlice } from "../../l2/eventRing";
import type { L2Channel, L2ChannelStatus, L2Event, L2Ladder, L2LaneInfo, L2Segment, L2Wall, L2WallVerdict } from "../../l2/types";
import type { IndicatorL2, L2Availability } from "../indicatorL2";

/**
 * A scripted `IndicatorL2` for order-book checks. The real one reads the L2
 * store NOW, not as of a replayed bar; this fake lets a test say exactly what
 * the ladder, the walls and the event stream hold, flip trust and sync, and
 * cut the view at a bar close through `atTime` so a replay-time check can
 * prove an indicator does not read walls or events from after the bar.
 */

export interface FakeL2Script {
  availability?: L2Availability;
  trusted?: boolean;
  /** Per-channel sync; every channel synced unless named here. */
  synced?: Partial<Record<L2Channel, boolean>>;
  seq?: number;
  lastTs?: number | null;
  lastFrameAt?: number | null;
  segment?: L2Segment | null;
  lanes?: readonly L2LaneInfo[];
  ladder?: L2Ladder | null;
  /** Ladders over time; `atTime(ts)` serves the newest at or before `ts`, falling back to `ladder`. */
  ladders?: readonly L2Ladder[];
  walls?: readonly L2Wall[];
  events?: readonly L2Event[];
  missedEvents?: number;
  version?: number;
  notionalMultiplier?: number;
}

export interface FakeL2 extends IndicatorL2 {
  /** Replace parts of the script; `version` advances by one. */
  patch(next: Partial<FakeL2Script>): void;
  readonly script: FakeL2Script;
}

const ALL_CHANNELS: readonly L2Channel[] = ["l2_view", "l2_walls", "l2_events", "l2_ladder"];

function statusOf(script: FakeL2Script, channel: L2Channel): L2ChannelStatus {
  const synced = script.synced?.[channel] ?? true;
  return Object.freeze({
    synced,
    seq: synced ? (script.seq ?? 1) : null,
    lastTs: script.lastTs ?? null,
    lastFrameAt: script.lastFrameAt ?? script.lastTs ?? null,
  });
}

function sliceOf(events: readonly L2Event[], sinceSeq: number | undefined, missed: number): L2EventSlice {
  const seq = events.length;
  if (sinceSeq !== undefined && sinceSeq >= seq) return { seq, events: [], missed, complete: true };
  return { seq, events: sinceSeq === undefined ? events : events.slice(sinceSeq), missed, complete: true };
}

function cutWall(wall: L2Wall, ts: number): L2Wall | null {
  if (wall.startTs > ts) return null;
  if (wall.endTs !== null && wall.endTs <= ts) return wall;
  return { ...wall, endTs: null, endedBy: null };
}

function sortedEvents(events: readonly L2Event[] | undefined): readonly L2Event[] | undefined {
  return events === undefined ? undefined : [...events].sort((a, b) => a.ts - b.ts);
}

export function fakeL2(initial: FakeL2Script = {}): FakeL2 {
  const script: FakeL2Script = { ...initial, events: sortedEvents(initial.events) };
  let version = initial.version ?? 1;
  const ladderAt = (ts: number | null): L2Ladder | null => {
    if (ts !== null && script.ladders) {
      let best: L2Ladder | null = null;
      for (const ladder of script.ladders) if (ladder.ts <= ts && (best === null || ladder.ts > best.ts)) best = ladder;
      if (best !== null) return best;
    }
    return script.ladder ?? null;
  };
  const build = (cut: number | null): FakeL2 => {
    const walls = (): readonly L2Wall[] => {
      const all = script.walls ?? [];
      if (cut === null) return all;
      return all.map((wall) => cutWall(wall, cut)).filter((wall): wall is L2Wall => wall !== null);
    };
    const events = (): readonly L2Event[] => {
      const all = script.events ?? [];
      return cut === null ? all : all.filter((event) => event.ts <= cut);
    };
    const fake: FakeL2 = {
      get availability() {
        return script.availability ?? "LIVE";
      },
      get version() {
        return version;
      },
      get script() {
        return script;
      },
      status: (channel) => statusOf(script, channel),
      segment: () => script.segment ?? { id: `fake:${script.lastTs ?? 0}:1`, state: "LIVE" },
      trusted: (ts) => {
        if (!(script.trusted ?? true)) return false;
        if (ts === undefined) return true;
        const segment = script.segment;
        return segment === undefined || segment === null || segment.state === "LIVE";
      },
      lanes: () => script.lanes ?? [],
      view: () => null,
      laneFor: (lo, hi) => {
        const known = script.lanes ?? [];
        for (const lane of known) if (lane.priceLo <= Math.min(lo, hi) && lane.priceHi >= Math.max(lo, hi)) return lane.lane;
        return 0;
      },
      walls: (lane = 0) => walls().filter((wall) => wall.lane === lane),
      wall: (id) => walls().find((wall) => wall.id === id) ?? null,
      events: (sinceSeq) => sliceOf(events(), sinceSeq, script.missedEvents ?? 0),
      ladder: () => ladderAt(cut),
      wallHistory: () => Promise.resolve(null),
      eventHistory: () => Promise.resolve(null),
      hostWalls: null,
      notionalMultiplier: script.notionalMultiplier,
      atTime: (timeMs) => build(timeMs),
      patch(next) {
        Object.assign(script, next, next.events === undefined ? {} : { events: sortedEvents(next.events) });
        version += 1;
      },
    };
    return fake;
  };
  return build(null);
}

/** Every channel unsynced and nothing trusted: the engine has not sent a frame yet. */
export function fakeL2Unsynced(): FakeL2 {
  return fakeL2({ trusted: false, synced: Object.fromEntries(ALL_CHANNELS.map((channel) => [channel, false])), segment: null });
}

/** A ladder of `levels` per side around `mid`, each `step` apart, `size` on every level. */
export function ladderOf(mid: number, levels: number, step: number, size: number, ts = 0): L2Ladder {
  const bids: [number, number][] = [];
  const asks: [number, number][] = [];
  for (let level = 1; level <= levels; level += 1) {
    bids.push([Math.round((mid - level * step) * 100) / 100, size]);
    asks.push([Math.round((mid + level * step) * 100) / 100, size]);
  }
  return { ts, depth: levels, bids, asks };
}

/** A ladder with one level inflated to `wallSize`: a resting wall at `wallPrice`. */
export function ladderWithWall(base: L2Ladder, side: "bid" | "ask", wallPrice: number, wallSize: number): L2Ladder {
  const bump = (levels: ReadonlyArray<readonly [number, number]>) => levels.map(([price, size]) => (price === wallPrice ? ([price, wallSize] as const) : ([price, size] as const)));
  return { ...base, bids: side === "bid" ? bump(base.bids) : base.bids, asks: side === "ask" ? bump(base.asks) : base.asks };
}

export interface WallSpec {
  id: number;
  side: "bid" | "ask";
  row: number;
  size: number;
  startTs: number;
  endTs?: number | null;
  endedBy?: L2WallVerdict | null;
  lane?: number;
  span?: number;
  peak?: number;
  ratio?: number;
  fill?: number;
  eaten?: number;
  absorbing?: boolean;
}

export function wallOf(spec: WallSpec): L2Wall {
  return {
    id: spec.id,
    lane: spec.lane ?? 0,
    side: spec.side,
    row: spec.row,
    span: spec.span ?? 1,
    startTs: spec.startTs,
    endTs: spec.endTs ?? null,
    size: spec.size,
    peak: spec.peak ?? spec.size,
    endedBy: spec.endTs === undefined || spec.endTs === null ? null : (spec.endedBy ?? "pulled"),
    ratio: spec.ratio ?? 5,
    chain: 0,
    fill: spec.fill ?? 0,
    eaten: spec.eaten ?? 0,
    absorbing: spec.absorbing ?? false,
    detail: null,
  };
}

export interface WallLifecycleSpec extends WallSpec {
  shrinkTs?: number;
  tradeTs?: number;
  tradedSize?: number;
  tradePrice?: number;
}

/** A wall's whole story as the event stream tells it: born, (shrunk), (traded), (ended). */
export function wallLifecycle(spec: WallLifecycleSpec): { wall: L2Wall; events: L2Event[] } {
  const wall = wallOf(spec);
  const events: L2Event[] = [{ kind: "wall_born", ts: spec.startTs, wall: spec.id, side: spec.side, row: spec.row, span: wall.span, size: spec.size }];
  if (spec.shrinkTs !== undefined) events.push({ kind: "wall_shrink", ts: spec.shrinkTs, wall: spec.id, exact: true, reached: false });
  if (spec.tradeTs !== undefined) {
    events.push({ kind: "wall_trade", ts: spec.tradeTs, wall: spec.id, mode: "absorbed", price: spec.tradePrice ?? spec.row, size: spec.tradedSize ?? spec.size / 2 });
  }
  if (spec.endTs !== undefined && spec.endTs !== null) {
    events.push({ kind: "wall_end", ts: spec.endTs, wall: spec.id, endedBy: wall.endedBy ?? "pulled", distanceRows: 1 });
  }
  events.sort((a, b) => a.ts - b.ts);
  return { wall, events };
}

/** A plain trade event (not against a wall) for the event stream. */
export function tradeEvent(ts: number, aggressor: "buy" | "sell", price: number, size: number, late = false): L2Event {
  return { kind: "trade", ts, side: aggressor === "buy" ? "ask" : "bid", aggressor, mode: "swept", price, size, late };
}
