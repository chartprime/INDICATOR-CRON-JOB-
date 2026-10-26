import type { L2EventSlice } from "../../l2/eventRing";
import type { L2Channel, L2ChannelStatus, L2Event, L2Ladder, L2LaneInfo, L2Segment, L2Wall, L2WallVerdict } from "../../l2/types";
import { segmentStartTs, type IndicatorL2, type L2Availability } from "../indicatorL2";

/**
 * A scripted `IndicatorL2` for order-book checks. The real one reads the L2
 * store NOW, not as of a replayed bar; this fake lets a test say exactly what
 * the ladder, the walls and the event stream hold, flip trust and sync, and
 * cut the view at a bar close through `atTime` so a replay-time check can
 * prove an indicator does not read walls, events or a ladder from after the
 * bar. Trust, segment and event-slice semantics mirror `indicatorL2Of`,
 * `L2Store.trusted` and `EventRing.since`, so a gate that works against the
 * fake works against the terminal.
 */

/** A wall's state as it stood at `ts`; `atTime(cut)` serves the newest snapshot at or before the cut. */
export interface WallSnapshot {
  ts: number;
  wall: L2Wall;
}

export interface FakeL2Script {
  availability?: L2Availability;
  /** `false` forces the store untrusted whatever the segment and sync say; `true` (default) lets them decide. */
  trusted?: boolean;
  /** Per-channel sync; every channel synced unless named here. */
  synced?: Partial<Record<L2Channel, boolean>>;
  seq?: number;
  lastTs?: number | null;
  lastFrameAt?: number | null;
  /** Explicit `null` means "no segment yet" and is served as such; omitted means a LIVE segment that started at 0. */
  segment?: L2Segment | null;
  lanes?: readonly L2LaneInfo[];
  /** The current ladder; eligible under a cut only when its `ts` is at or before the cut. */
  ladder?: L2Ladder | null;
  /** Ladders over time; `atTime(ts)` serves the newest at or before `ts` among these and `ladder`. */
  ladders?: readonly L2Ladder[];
  /** Final wall records, as `walls()` serves them now. */
  walls?: readonly L2Wall[];
  /** How each wall looked over time; without one, a cut view reconstructs the wall from its events. */
  wallSnapshots?: readonly WallSnapshot[];
  events?: readonly L2Event[];
  /** The ring's current sequence number; defaults to the event count (the ring holds every event since seq 0). */
  eventSeq?: number;
  /** The seq of the last reset frame; a cursor before it is not exact. Defaults to the oldest held event's seq. */
  eventResetSeq?: number;
  missedEvents?: number;
  /** The seq through which events were reported missed; a cursor at or before it is incomplete. Defaults to the current seq when `missedEvents > 0`. */
  missedThroughSeq?: number | null;
  version?: number;
  notionalMultiplier?: number;
}

export interface FakeL2 extends IndicatorL2 {
  /** Replace parts of the script; `version` advances by one. */
  patch(next: Partial<FakeL2Script>): void;
  readonly script: FakeL2Script;
}

const ALL_CHANNELS: readonly L2Channel[] = ["l2_view", "l2_walls", "l2_events", "l2_ladder"];
/** The channels `L2Store.trusted()` requires synced. */
export const TRUST_CHANNELS: readonly L2Channel[] = ["l2_walls", "l2_events"];
const EMPTY_SLICE: L2EventSlice = Object.freeze({ seq: 0, events: Object.freeze([]), missed: 0, complete: false });

/** A segment id the production parser (`segmentStartTs`) reads back as starting at `startTs`. */
export function segmentOf(startTs: number, state: L2Segment["state"] = "LIVE"): L2Segment {
  return { id: `fake:${startTs}:${state}`, state };
}

const DEFAULT_SEGMENT = segmentOf(0);

function statusOf(script: FakeL2Script, channel: L2Channel): L2ChannelStatus {
  const synced = script.synced?.[channel] ?? true;
  return Object.freeze({
    synced,
    seq: synced ? (script.seq ?? 1) : null,
    lastTs: script.lastTs ?? null,
    lastFrameAt: script.lastFrameAt ?? script.lastTs ?? null,
  });
}

function segmentOfScript(script: FakeL2Script): L2Segment | null {
  return script.segment === undefined ? DEFAULT_SEGMENT : script.segment;
}

/** `L2Store.trusted()` then `indicatorL2Of(...).trusted(ts)`: LIVE segment, trust channels synced, and `ts` not before the segment began. */
function trustedAt(script: FakeL2Script, ts: number | undefined): boolean {
  if (script.trusted === false) return false;
  const segment = segmentOfScript(script);
  if (segment === null || segment.state !== "LIVE") return false;
  if (!TRUST_CHANNELS.every((channel) => statusOf(script, channel).synced)) return false;
  if (ts === undefined) return true;
  const start = segmentStartTs(segment);
  return start !== null && ts >= start;
}

function sortedEvents(events: readonly L2Event[] | undefined): readonly L2Event[] | undefined {
  return events === undefined ? undefined : [...events].sort((a, b) => a.ts - b.ts);
}

function sortedSnapshots(snapshots: readonly WallSnapshot[] | undefined): readonly WallSnapshot[] | undefined {
  return snapshots === undefined ? undefined : [...snapshots].sort((a, b) => a.ts - b.ts);
}

/**
 * The wall as it stood at `cut`: the newest snapshot at or before the cut, or
 * else the wall reconstructed from its events through the cut (born size as
 * size and peak, `wall_trade` sizes as `eaten`), or else the scripted record
 * served as freshly born. A wall that ended at or before the cut is history
 * and is served as its final record.
 */
function wallAt(wall: L2Wall, cut: number, snapshots: readonly WallSnapshot[], events: readonly L2Event[]): L2Wall | null {
  if (wall.startTs > cut) return null;
  if (wall.endTs !== null && wall.endTs <= cut) return wall;
  let snapshot: WallSnapshot | null = null;
  for (const candidate of snapshots) {
    if (candidate.wall.id === wall.id && candidate.ts <= cut && (snapshot === null || candidate.ts >= snapshot.ts)) snapshot = candidate;
  }
  if (snapshot !== null) return { ...snapshot.wall, endTs: null, endedBy: null };
  let bornSize: number | null = null;
  let eaten = 0;
  for (const event of events) {
    if (event.ts > cut) break;
    if (event.kind === "wall_born" && event.wall === wall.id) bornSize = event.size;
    if (event.kind === "wall_trade" && event.wall === wall.id) eaten += event.size;
  }
  const peak = bornSize ?? wall.size;
  return {
    ...wall,
    size: Math.max(0, peak - eaten),
    peak,
    eaten,
    fill: peak > 0 ? eaten / peak : 0,
    absorbing: false,
    endTs: null,
    endedBy: null,
    detail: null,
  };
}

export function fakeL2(initial: FakeL2Script = {}): FakeL2 {
  const script: FakeL2Script = { ...initial, events: sortedEvents(initial.events), wallSnapshots: sortedSnapshots(initial.wallSnapshots) };
  let version = initial.version ?? 1;

  const ladderAt = (cut: number | null): L2Ladder | null => {
    let best: L2Ladder | null = null;
    for (const ladder of [...(script.ladders ?? []), ...(script.ladder ? [script.ladder] : [])]) {
      if (cut !== null && ladder.ts > cut) continue;
      if (best === null || ladder.ts > best.ts) best = ladder;
    }
    // Uncut, the current ladder is what the store holds now, whatever its stamp.
    if (cut === null && script.ladder) return script.ladder;
    return best;
  };

  const build = (cut: number | null): FakeL2 => {
    const allEvents = (): readonly L2Event[] => script.events ?? [];
    const events = (): readonly L2Event[] => {
      const all = allEvents();
      return cut === null ? all : all.filter((event) => event.ts <= cut);
    };
    const walls = (): readonly L2Wall[] => {
      const all = script.walls ?? [];
      if (cut === null) return all;
      const snapshots = script.wallSnapshots ?? [];
      const seen = events();
      return all.map((wall) => wallAt(wall, cut, snapshots, seen)).filter((wall): wall is L2Wall => wall !== null);
    };
    const since = (sinceSeq: number | undefined): L2EventSlice => {
      const synced = script.synced?.l2_events ?? true;
      const all = allEvents();
      const visible = events();
      if (!synced && script.eventSeq === undefined && all.length === 0) return EMPTY_SLICE;
      const fullSeq = script.eventSeq ?? all.length;
      const oldestExact = fullSeq - all.length;
      const seq = oldestExact + visible.length;
      const resetSeq = script.eventResetSeq ?? oldestExact;
      const missed = script.missedEvents ?? 0;
      const missedThrough = script.missedThroughSeq === undefined ? (missed > 0 ? seq : null) : script.missedThroughSeq;
      const exact = sinceSeq !== undefined && sinceSeq >= resetSeq && sinceSeq >= oldestExact && sinceSeq <= seq;
      const slice = exact ? visible.slice(visible.length - (seq - sinceSeq!)) : visible.slice();
      const afterReportedLoss = missedThrough === null || (sinceSeq !== undefined && sinceSeq > missedThrough);
      return Object.freeze({ seq, events: Object.freeze(slice), missed, complete: exact && synced && afterReportedLoss });
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
      segment: () => segmentOfScript(script),
      trusted: (ts) => trustedAt(script, ts),
      lanes: () => script.lanes ?? [],
      view: () => null,
      laneFor: (lo, hi) => {
        const known = script.lanes ?? [];
        for (const lane of known) if (lane.priceLo <= Math.min(lo, hi) && lane.priceHi >= Math.max(lo, hi)) return lane.lane;
        return 0;
      },
      walls: (lane = 0) => walls().filter((wall) => wall.lane === lane),
      wall: (id) => walls().find((wall) => wall.id === id) ?? null,
      events: since,
      ladder: () => ladderAt(cut),
      wallHistory: () => Promise.resolve(null),
      eventHistory: () => Promise.resolve(null),
      hostWalls: null,
      notionalMultiplier: script.notionalMultiplier,
      atTime: (timeMs) => build(timeMs),
      patch(next) {
        Object.assign(
          script,
          next,
          next.events === undefined ? {} : { events: sortedEvents(next.events) },
          next.wallSnapshots === undefined ? {} : { wallSnapshots: sortedSnapshots(next.wallSnapshots) },
        );
        version += 1;
      },
    };
    return fake;
  };
  return build(null);
}

/** Every channel unsynced and no segment yet: the engine has not sent a frame. */
export function fakeL2Unsynced(): FakeL2 {
  return fakeL2({ synced: Object.fromEntries(ALL_CHANNELS.map((channel) => [channel, false])), segment: null });
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

/**
 * A wall's whole story: the final record, the event stream that tells it
 * (born, shrunk, traded, ended) and the snapshots a cut view serves, one per
 * event, with `size`, `eaten` and `fill` as they stood after that event.
 */
export function wallLifecycle(spec: WallLifecycleSpec): { wall: L2Wall; events: L2Event[]; snapshots: WallSnapshot[] } {
  const traded = spec.tradeTs === undefined ? 0 : (spec.tradedSize ?? spec.size / 2);
  const ended = spec.endTs !== undefined && spec.endTs !== null;
  const wall: L2Wall = {
    ...wallOf(spec),
    peak: spec.peak ?? spec.size,
    size: spec.size - traded,
    eaten: traded,
    fill: spec.size > 0 ? traded / spec.size : 0,
    absorbing: spec.absorbing ?? traded > 0,
  };
  const born: L2Wall = { ...wall, size: spec.size, eaten: 0, fill: 0, absorbing: false, endTs: null, endedBy: null };
  const events: L2Event[] = [{ kind: "wall_born", ts: spec.startTs, wall: spec.id, side: spec.side, row: spec.row, span: wall.span, size: spec.size }];
  const snapshots: WallSnapshot[] = [{ ts: spec.startTs, wall: born }];
  if (spec.shrinkTs !== undefined) {
    events.push({ kind: "wall_shrink", ts: spec.shrinkTs, wall: spec.id, exact: true, reached: false });
    snapshots.push({ ts: spec.shrinkTs, wall: born });
  }
  if (spec.tradeTs !== undefined) {
    events.push({ kind: "wall_trade", ts: spec.tradeTs, wall: spec.id, mode: "absorbed", price: spec.tradePrice ?? spec.row, size: traded });
    snapshots.push({ ts: spec.tradeTs, wall: { ...wall, endTs: null, endedBy: null } });
  }
  if (ended) {
    events.push({ kind: "wall_end", ts: spec.endTs!, wall: spec.id, endedBy: wall.endedBy ?? "pulled", distanceRows: 1 });
    snapshots.push({ ts: spec.endTs!, wall });
  }
  events.sort((a, b) => a.ts - b.ts);
  snapshots.sort((a, b) => a.ts - b.ts);
  return { wall, events, snapshots };
}

/** A plain trade event (not against a wall) for the event stream. */
export function tradeEvent(ts: number, aggressor: "buy" | "sell", price: number, size: number, late = false): L2Event {
  return { kind: "trade", ts, side: aggressor === "buy" ? "ask" : "bid", aggressor, mode: "swept", price, size, late };
}
