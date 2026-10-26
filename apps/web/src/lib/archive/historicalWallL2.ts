import { historicalL2, type IndicatorL2 } from "../chart/indicatorL2";
import type { L2Event, L2Wall } from "../l2/types";
import type { HistoricalL2Row } from "./historicalL2Client";

const SHA = /^[a-f0-9]{64}$/;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const safe = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function wallOf(value: unknown, prefix: number, cut: number): L2Wall {
  if (!object(value) || !safe(value.id) || value.id >= 1000000 || !["bid", "ask"].includes(String(value.side))
      || !safe(value.row) || !safe(value.span) || value.span === 0 || !safe(value.startTs) || value.startTs > cut
      || value.endTs !== null && (!safe(value.endTs) || value.endTs < value.startTs || value.endTs > cut)
      || !(value.endedBy === null || ["filled", "partial", "hit", "pulled", "moved"].includes(String(value.endedBy)))
      || !["size", "peak", "ratio", "chain", "fill", "eaten"].every((key) => typeof value[key] === "number" && Number.isFinite(value[key]) && Number(value[key]) >= 0)) {
    throw new Error("Historical L2: invalid wall sample.");
  }
  const detail = value.detail;
  if (detail !== null && !object(detail)) throw new Error("Historical L2: invalid wall detail.");
  if (object(detail) && (!['traded', 'absorbed', 'swept', 'hidden', 'cleared', 'fillRatio', 'crossSide', 'crossSideShare', 'repeats']
      .every((key) => typeof detail[key] === "number" && Number.isFinite(detail[key]) && Number(detail[key]) >= 0)
      || !['lifeMs', 'firstShrinkTs', 'endDistanceRows', 'endDistancePct'].every((key) => detail[key] === null
        || typeof detail[key] === "number" && Number.isFinite(detail[key]))
      || detail.firstShrinkTs !== null && Number(detail.firstShrinkTs) > cut)) throw new Error("Historical L2: invalid wall detail values.");
  return Object.freeze({ id: prefix + value.id, lane: 0, side: value.side as "bid" | "ask", row: value.row, span: value.span,
    startTs: value.startTs, endTs: value.endTs as number | null, size: Number(value.size), peak: Number(value.peak),
    endedBy: value.endedBy as L2Wall["endedBy"], ratio: Number(value.ratio), chain: Number(value.chain), fill: Number(value.fill),
    eaten: Number(value.eaten), absorbing: value.absorbing === true,
    detail: detail === null ? null : { ...(detail as unknown as NonNullable<L2Wall["detail"]>),
      continuityGapMs: object(detail.continuity) && safe(detail.continuity.gapMs) ? detail.continuity.gapMs : null } });
}

/** Samples are independent causal snapshots; future ends never alter an earlier view. */
export function historicalWallL2(base: IndicatorL2, rows: readonly HistoricalL2Row[], version: number,
  wallProfile: NonNullable<IndicatorL2["wallProfile"]>): IndicatorL2 {
  if (rows.length > 14400 || !Number.isSafeInteger(version) || version < 1 || version > Math.floor(Number.MAX_SAFE_INTEGER / 100000) - 1
      || !SHA.test(wallProfile.id) || wallProfile.sampleMs !== 1000 || !(wallProfile.minimumSize >= 0)) throw new Error("Historical L2: wall window exceeds admission.");
  const segments = new Map<string, number>();
  const segmentEvents = new Map<string, L2Event[]>();
  let profile: string | null = null, previous = -1n, position = -1n;
  let instrument: string | null = null, derivation: string | null = null;
  const records = rows.map((row) => {
    const payload = row.payload, known = BigInt(row.known_ns);
    if (row.schema !== "historical-l2-wall-record/1" || known < previous || BigInt(row.append_position) <= position
        || instrument !== null && instrument !== row.instrument_id || derivation !== null && derivation !== row.derivation_id
        || payload.known_ns !== row.known_ns || typeof payload.profile_id !== "string"
        || !SHA.test(payload.profile_id) || profile !== null && payload.profile_id !== profile
        || typeof payload.segment_id !== "string" || !SHA.test(payload.segment_id)) throw new Error("Historical L2: wall identity/order differs.");
    if (payload.profile_id !== wallProfile.id) throw new Error("Historical L2: detector settings differ.");
    previous = known; profile = payload.profile_id; position = BigInt(row.append_position);
    instrument = row.instrument_id; derivation = row.derivation_id;
    if (!segments.has(payload.segment_id)) segments.set(payload.segment_id, (segments.size + 1) * 1000000);
    const prefix = segments.get(payload.segment_id)!;
    const time = Number(known / 1000000n), closure = payload.schema === "historical-l2-wall-segment-end/2";
    if (!closure && (payload.schema !== "historical-l2-wall-view/2" || payload.instrument_id !== row.instrument_id
        || payload.derivation_id !== row.derivation_id || !Array.isArray(payload.walls) || !Array.isArray(payload.lifecycle)
        || !Array.isArray(payload.trades) || !Array.isArray(payload.wall_trades))) {
      throw new Error("Historical L2: incomplete wall sample.");
    }
    const walls = closure ? [] : (payload.walls as unknown[]).map((wall) => wallOf(wall, prefix, time));
    for (const event of closure ? [] : [...payload.lifecycle as unknown[], ...payload.trades as unknown[], ...payload.wall_trades as unknown[]]) {
      if (!object(event) || !safe(event.ts) || event.ts > time) throw new Error("Historical L2: future evidence.");
    }
    const events = segmentEvents.get(payload.segment_id) ?? [];
    if (!closure) {
      events.push(...(payload.lifecycle as Record<string, unknown>[]).map((event) => ({ ...event,
        ...(event.kind === "wall_trade" ? { mode: event.trade } : {}), wall: Number(event.wall) + prefix }) as L2Event));
      segmentEvents.set(payload.segment_id, events);
    }
    return { known, time, segment: payload.segment_id, prefix, closure, walls, payload, eventEnd: events.length };
  });
  const upper = (cut: bigint): number => {
    let lo = 0, hi = records.length;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (records[mid].known <= cut) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const maximum = previous;
  const identity = instrument === null ? [] : JSON.parse(instrument) as string[];
  const multiplier = identity[1] === "EQUITY" ? 1 : identity[2] === "ESU6" ? 50 : identity[2] === "NQU6" ? 20 : undefined;
  let cached: { cut: bigint; source: IndicatorL2 } | null = null;
  function build(cut: bigint): IndicatorL2 {
    if (cached?.cut === cut) return cached.source;
    const lastIndex = upper(cut) - 1, last = records[lastIndex];
    const depth = base.atTime?.(Number(cut / 1000000n)) ?? base;
    const trusted = last !== undefined && !last.closure && cut - last.known < 1000000000n && depth.trusted();
    const knownWalls = trusted ? last.walls : [];
    let history: readonly L2Wall[] | null = null;
    const historicalWalls = () => {
      if (history !== null) return history;
      const byId = new Map<number, L2Wall>();
      for (let index = 0; index <= lastIndex; index += 1) for (const wall of records[index].walls) byId.set(wall.id, wall);
      const current = new Set(knownWalls.map((wall) => wall.id));
      history = [...byId.values()].filter((wall) => wall.endTs !== null || current.has(wall.id));
      return history;
    };
    const source: IndicatorL2 = { ...depth, availability: "HISTORICAL", wallProfile, notionalMultiplier: multiplier, version: version * 100000 + lastIndex + 1,
      segment: () => last === undefined ? null : { id: last.segment, state: trusted ? "LIVE" : "GAP" },
      trusted: (ts) => trusted && (ts === undefined || BigInt(ts) * 1000000n <= cut && depth.trusted(ts)),
      status: (channel) => channel === "l2_walls" || channel === "l2_events"
        ? { synced: trusted, seq: lastIndex + 1, lastTs: trusted ? last.time : null, lastFrameAt: null } : depth.status(channel),
      walls: (lane = 0) => lane === 0 ? knownWalls : [], wall: (id) => knownWalls.find((wall) => wall.id === id) ?? null,
      historicalWalls,
      events: (sinceSeq = 0) => {
        const events = last === undefined ? [] : segmentEvents.get(last.segment) ?? [], end = last?.eventEnd ?? 0;
        if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0 || sinceSeq > end) return { seq: end, events: [], missed: 0, complete: false };
        return { seq: end, events: events.slice(sinceSeq, end), missed: 0, complete: trusted };
      },
      wallHistory: async (range) => ({ rowWidth: depth.lanes()[0]?.rowWidth ?? 0,
        walls: historicalWalls().filter((wall) => wall.startTs < range.toTs && wall.endTs !== null && wall.endTs >= range.fromTs)
          .map((wall) => ({ ...wall, id: -wall.id })), next: null }),
      eventHistory: async (range) => ({ rowWidth: depth.lanes()[0]?.rowWidth ?? 0, heldFrom: records[0]?.time ?? 0, next: null,
        wallTrades: [], trades: records.slice(0, lastIndex + 1).filter((r) => !r.closure && r.segment === last?.segment)
          .flatMap((r) => (r.payload.trades as Record<string, unknown>[]).filter((t) => Number(t.ts) >= range.fromTs && Number(t.ts) < range.toTs)
            .map((t) => ({ ts: Math.floor(Number(t.ts) / 1000) * 1000, columnMs: 1000, row: Number(t.row),
              aggressor: t.aggressor as "buy" | "sell", mode: t.mode as "absorbed" | "swept", size: Number(t.size), count: 1 }))) }),
      atTime: (ts) => Number.isSafeInteger(ts) && ts >= 0 ? build(BigInt(ts) * 1000000n < cut ? BigInt(ts) * 1000000n : cut) : historicalL2(),
    };
    cached = { cut, source };
    return source;
  }
  return build(maximum);
}
