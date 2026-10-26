import type { LiquidityColumn } from "../passive-liquidity/liquidityGrid";
import { columnMid, eachColumn, type ColumnFeed } from "./absorptionColumns";
import { createBandTracker, foldedColumns, readBands, wallTier, type BandTrackerState, type BarClose, type TrackerRules } from "../institutional-order-blocks-v2/bandTracker";
import type { Side, Wall } from "../institutional-order-blocks-v2/institutionalV2Rules";
import type { AbsorptionRules } from "./absorptionSettings";

export { columnFlow, columnMid, type ColumnFeed, type ColumnTier } from "./absorptionColumns";
export type { AbsorptionRules } from "./absorptionSettings";

export const ABSORPTION_ENGINE_VERSION = 6;

/** The tracker's strong size, a multiple of the column's wall floor: it only drives its guard flags. */
export const STRONG_WALL_MULTIPLE = 3;

export const TRAIL_MAX = 256;

export interface AbsorptionPrint {
  key: string;
  side: Side;
  band: number;
  rows: number;

  ts: number;

  attackTs: number;

  share: number;

  strong: boolean;

  shown: number;

  resting: number;

  absorbed: number;

  yardstick: number;

  current: number;

  refills: number;

  price: number;
  judgedAt: number;

  held: boolean | null;

  broken: boolean;
}

/** An eligible column of a recorded attack: what had traded into the wall by then, and what the wall held. */
export interface AbsorptionTrailEntry {
  ts: number;
  absorbed: number;
  current: number;
  refills: number;
}

export type AbsorptionEndReason = "closed" | "pulled" | "other";

/**
 * One attack, recorded once it reaches the sliders' lowest numbers: the facts of the attack, its flow and refills growing
 * with it, the eligible columns since in a trail, and how its wall ended. The rule's numbers read it (`readPrint`).
 */
export interface AbsorptionRecord {
  key: string;
  side: Side;
  band: number;
  rows: number;

  ts: number;

  attackTs: number;

  /** What the band showed in the column before the attack's first hit. */
  shown: number;

  /** What the attack is measured against: what the band showed, or the heatmap's wall size for the column when it showed less. */
  resting: number;

  absorbed: number;

  yardstick: number;

  refills: number;

  price: number;

  trail: AbsorptionTrailEntry[];

  latest: AbsorptionTrailEntry;

  endTs: number | null;

  endReason: AbsorptionEndReason | null;
}

export function printKey(print: Pick<AbsorptionPrint, "side" | "band" | "rows" | "attackTs">): string {
  return `${print.side}:${print.band}:${print.rows}:${print.attackTs}`;
}

function isTrailEntry(value: unknown): value is AbsorptionTrailEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return ["ts", "absorbed", "current", "refills"].every((field) => Number.isFinite(entry[field]));
}

/** A whole record of this engine, as the browser stores read it back. */
export function isAbsorptionRecord(value: unknown): value is AbsorptionRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const numbers = ["band", "rows", "ts", "attackTs", "shown", "resting", "absorbed", "yardstick", "refills", "price"];
  const ended = record.endTs === null ? record.endReason === null : Number.isFinite(record.endTs) && (record.endReason === "closed" || record.endReason === "pulled" || record.endReason === "other");
  return typeof record.key === "string" && (record.side === "bid" || record.side === "ask") && numbers.every((field) => Number.isFinite(record[field]))
    && Array.isArray(record.trail) && record.trail.length > 0 && record.trail.every(isTrailEntry) && isTrailEntry(record.latest) && ended;
}

/**
 * The sphere the rule's numbers read in a record: at the first entry of the trail that reaches the absorbed share and
 * the multiple, the strong ring from the newest reading, broken by the wall's end within the break window of that
 * column; null when no entry reaches the numbers.
 */
export function readPrint(record: AbsorptionRecord, rules: Pick<AbsorptionRules, "absorbedPercent" | "strongPercent" | "absorbedMultiple" | "breakWindowMs">): AbsorptionPrint | null {
  const { trail } = record;
  const need = Math.max((rules.absorbedPercent / 100) * record.resting, rules.absorbedMultiple * record.yardstick);
  let at = 0;
  while (at < trail.length && trail[at].absorbed < need) at += 1;
  if (at === trail.length) return null;
  const entry = trail[at];
  const strongNeed = Math.max((rules.strongPercent / 100) * record.resting, (rules.strongPercent / rules.absorbedPercent) * rules.absorbedMultiple * record.yardstick);
  const strong = record.latest.absorbed >= strongNeed;
  const broken = (record.endReason === "closed" || record.endReason === "pulled") && record.endTs !== null && record.endTs - entry.ts <= rules.breakWindowMs;
  return {
    key: record.key,
    side: record.side,
    band: record.band,
    rows: record.rows,
    ts: entry.ts,
    attackTs: record.attackTs,
    share: (strong ? rules.strongPercent : rules.absorbedPercent) / 100,
    strong,
    shown: record.shown,
    resting: record.resting,
    absorbed: record.absorbed,
    yardstick: record.yardstick,
    current: entry.current,
    refills: record.refills,
    price: record.price,
    judgedAt: entry.ts,
    held: true,
    broken,
  };
}

interface Attack {
  ts: number;
  eatenAtStart: number;
  shown: number;
  resting: number;
  yardstick: number;
  lastHitTs: number;
  asks: number[];
  next: number;
  record: AbsorptionRecord | null;
}

interface Life {
  resumedTs: number;
  prevCurrent: number;
  prevEaten: number;
  attack: Attack | null;
}

interface Watch {
  key: string;
  wall: Wall;
  record: AbsorptionRecord;
}

function deepEdge(feed: ColumnFeed): number {
  const deep = feed.deep;
  if (deep === null || deep.columns.length === 0) return -Infinity;
  return deep.columns[deep.columns.length - 1].ts + deep.columnMs;
}

/** The price is on the wall's side of its band, at it or inside it: a mid past the band's far edge has gone through the wall. */
function holdsAt(wall: Pick<Wall, "side" | "band" | "bandRows">, mid: number, rowWidth: number): boolean {
  const rowLo = wall.band * wall.bandRows;
  return wall.side === "bid" ? mid > rowLo * rowWidth : mid < (rowLo + wall.bandRows) * rowWidth;
}

function asksOf(rules: Pick<AbsorptionRules, "askedPercents" | "askedMultiples">, resting: number, yardstick: number): number[] {
  return [...rules.askedPercents.map((percent) => (percent / 100) * resting), ...rules.askedMultiples.map((multiple) => multiple * yardstick)].sort((a, b) => a - b);
}

function passed(attack: Attack, absorbed: number): void {
  while (attack.next < attack.asks.length && attack.asks[attack.next] <= absorbed) attack.next += 1;
}

export function absorptionWallsKey(rules: Pick<AbsorptionRules, "instrument" | "bandRows" | "wallKey" | "quietMs">, rowWidth: number): string {
  return JSON.stringify([rules.instrument, rules.bandRows, rules.wallKey, rules.quietMs, rowWidth]);
}

export class AbsorptionTracker {
  private _state: BandTrackerState = createBandTracker();
  private _lives = new Map<string, Life>();
  private _records = new Map<string, AbsorptionRecord>();
  private _watched: Watch[] = [];
  private _epoch: number | null = null;
  private _rulesKey = "";

  update(feed: ColumnFeed, rowWidth: number, rules: AbsorptionRules, nowMs: number, closes: readonly BarClose[] = []): AbsorptionRecord[] {
    if (!(rowWidth > 0) || !(rules.bandRows >= 1)) return [];
    const rulesKey = absorptionWallsKey(rules, rowWidth);
    if (rulesKey !== this._rulesKey || (this._epoch !== null && feed.epoch !== this._epoch)) this._reset();
    this._rulesKey = rulesKey;
    this._epoch = feed.epoch;
    const reference = feed.reference ?? 0;
    let floorColumn: LiquidityColumn | null = null;
    let floor = 0;
    const floorOf = (column: LiquidityColumn): number => {
      if (column !== floorColumn) {
        floorColumn = column;
        floor = rules.wallFloor(column, reference);
      }
      return floor;
    };
    const tracker: TrackerRules = {
      bandRows: rules.bandRows,
      wallSize: Infinity,
      strongSize: Infinity,
      wallSizeAt: floorOf,
      strongSizeAt: (column) => STRONG_WALL_MULTIPLE * floorOf(column),
      bandSizeOf: rules.bandSize,
    };
    const rebuiltBefore = this._state.rebuiltAt;
    readBands(this._state, feed, 0, tracker, nowMs, closes);
    if (this._state.rebuiltAt !== rebuiltBefore) {
      this._lives.clear();
      this._records.clear();
      this._watched = [];
    }
    const from = this._state.lastTs === null ? 0 : this._state.lastTs + 1;
    const visit = (column: LiquidityColumn): void => {
      readBands(this._state, feed, column.ts + 1, tracker, nowMs, closes);
      this._observe(column, rules, rowWidth, reference);
      this._watch();
    };
    const edge = deepEdge(feed);
    if (feed.deep !== null && from < edge) eachColumn(wallTier(feed), from, edge - 1, visit);
    for (const column of foldedColumns(feed, from, Infinity)) visit(column);
    return [...this._records.values()].sort((a, b) => a.ts - b.ts || a.band - b.band);
  }

  private _reset(): void {
    this._state = createBandTracker();
    this._lives.clear();
    this._records.clear();
    this._watched = [];
  }

  private _observe(column: LiquidityColumn, rules: AbsorptionRules, rowWidth: number, reference: number): void {
    const ts = column.ts;
    const seen = new Set<string>();
    for (const [key, wall] of this._state.open) {
      seen.add(key);
      let life = this._lives.get(key);
      if (life === undefined || life.resumedTs !== wall.resumedTs) {
        life = { resumedTs: wall.resumedTs, prevCurrent: wall.current, prevEaten: wall.eaten, attack: null };
        this._lives.set(key, life);
        continue;
      }
      const hit = wall.eaten > life.prevEaten;
      if (life.attack !== null && ts - life.attack.lastHitTs >= rules.quietMs) life.attack = null;
      if (hit) {
        if (life.attack === null) {
          const level = column.reference !== undefined && column.reference > 0 ? column.reference : reference;
          if (level > 0) life.attack = { ts, eatenAtStart: life.prevEaten, shown: life.prevCurrent, resting: Math.max(life.prevCurrent, rules.wallSize(column, reference)), yardstick: level, lastHitTs: ts, asks: [], next: 0, record: null };
        }
        if (life.attack !== null) life.attack.lastHitTs = ts;
      }
      const attack = life.attack;
      if (attack !== null && attack.resting > 0) {
        const absorbed = wall.eaten - attack.eatenAtStart;
        const record = attack.record;
        if (record !== null && hit) {
          record.absorbed = absorbed;
          record.refills = wall.refills;
        }
        const recordable = absorbed >= (rules.recordPercent / 100) * attack.resting && absorbed >= rules.recordMultiple * attack.yardstick;
        const grown = record === null || absorbed > record.latest.absorbed;
        if (recordable && grown) {
          const mid = columnMid(column, rowWidth);
          if (wall.current > 0 && mid !== null && holdsAt(wall, mid, rowWidth)) {
            const entry: AbsorptionTrailEntry = { ts, absorbed, current: wall.current, refills: wall.refills };
            if (record === null) {
              const recorded: AbsorptionRecord = {
                key: "",
                side: wall.side,
                band: wall.band,
                rows: wall.bandRows,
                ts,
                attackTs: attack.ts,
                shown: attack.shown,
                resting: attack.resting,
                absorbed,
                yardstick: attack.yardstick,
                refills: wall.refills,
                price: (wall.band * wall.bandRows + wall.bandRows / 2) * rowWidth,
                trail: [entry],
                latest: entry,
                endTs: null,
                endReason: null,
              };
              recorded.key = printKey(recorded);
              attack.record = recorded;
              attack.asks = asksOf(rules, attack.resting, attack.yardstick);
              passed(attack, absorbed);
              this._records.set(recorded.key, recorded);
              this._watched.push({ key, wall, record: recorded });
            } else {
              record.latest = entry;
              if (attack.next < attack.asks.length && absorbed >= attack.asks[attack.next] && record.trail.length < TRAIL_MAX) {
                record.trail.push(entry);
                passed(attack, absorbed);
              }
            }
          }
        }
      }
      life.prevCurrent = wall.current;
      life.prevEaten = wall.eaten;
    }
    for (const key of this._lives.keys()) if (!seen.has(key)) this._lives.delete(key);
  }

  /** A record's wall is followed to its end: closed through or pulled is kept as such, a hole or the window's edge as some other end, and a wall forgotten is let go. */
  private _watch(): void {
    for (let i = this._watched.length - 1; i >= 0; i -= 1) {
      const { key, wall, record } = this._watched[i];
      if (wall.endReason !== null) {
        record.endTs = wall.endTs;
        record.endReason = wall.endReason === "closed" || wall.endReason === "pulled" ? wall.endReason : "other";
        this._watched.splice(i, 1);
      } else if (this._state.open.get(key) !== wall && this._state.memory.get(key) !== wall) this._watched.splice(i, 1);
    }
  }
}

export function detectAbsorption(feed: ColumnFeed, rowWidth: number, rules: AbsorptionRules, nowMs: number, closes: readonly BarClose[] = []): AbsorptionRecord[] {
  return new AbsorptionTracker().update(feed, rowWidth, rules, nowMs, closes);
}
