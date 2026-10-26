import type { IChartApiBase, ISeriesApi, SeriesType, Time } from "lightweight-charts";
import type { BinanceIdentity, DxFeedIdentity, LiquidityColumnFrame, LiquidityEntry, LiquidityFrame, LiquidityLevel } from "../../../../types/frames";
import type { HistoryReach, HistoryStatus, HistoryWant } from "../heatmapHistory";
import { HISTORY_WINDOW_MS } from "../heatmapHistoryDecode";
import {
  LIQUIDITY_REFERENCE_ALPHA,
  LIQUIDITY_REFERENCE_BP,
  LIQUIDITY_REFERENCE_PERCENTILE,
  LiquidityGrid,
  liquidityPercentile,
  type LiquidityColumn,
} from "../liquidityGrid";
import { computeHeatmapLayout, type HeatHistorySource, type HeatmapLayout } from "../liquidityHeatmapLayout";
import { historyDaysOf, historyReachFor, type LiquiditySettings } from "../liquiditySettings";
import { liquidityStyleFor } from "../liquidityStyle";

// Seeded heatmap scenes for the renderer's tests: a LiquidityGrid fed by real
// frames (a reset per tier, delta columns, one fine column a second, a deep
// column every ten), the one-minute candles over it, the fake chart and series
// computeHeatmapLayout reads, and on request a host history tier behind it.
//
// The book is a forward simulation, one step a second: a mid that wanders, thin
// background on every row, and walls that appear, grow in steps every ten
// seconds, dip for a few seconds, get eaten when a hunt walks the mid onto them,
// get pulled with price away, or stand through the live candle; now and then the
// mid sits between a bid wall and an ask wall inside one band ("range" walls).
// Three walls are scripted into every scene: an "anchor" each side that is never
// eaten or pulled, a "connector" that dips under the paint floor in the fine tier
// and is pulled after, and a "grower" that steps up from 20 s before the live
// edge to 100 s after it. The sizes are set against each market's floors:
//
//   crypto  BTC-USDT perp, $1 rows, 10 rows a band, window +-250 rows. One
//           "ladder" row per band holds about 60 BTC, so the reference (95th
//           percentile of the rows) is about 62 whatever the walls do: paint
//           248 a band, link 124, about 1000 to appear inside the quiet zone.
//           The rest of a band is under 3 BTC a row, so background never
//           reaches the 100 BTC minimum.
//   index   /NQZ26 at 0.25, 12 rows a band, window +-180 rows, all of it inside
//           the quiet zone. A wall is a core row of 330-900 contracts with two
//           to four shoulder rows of about 100; the shoulders set the reference
//           near 100, so paint is about 62, link 31 and a wall appears from
//           about 250. Background is 1-18 contracts a row, under the 20 minimum.

export type SceneFlavour = "crypto" | "index";

export interface SceneOptions {
  seed: number;
  flavour: SceneFlavour;
  minutes?: number;
  deepMinutes?: number;
  history?: boolean;
  paneWidth?: number;
  paneHeight?: number;
}

export interface SceneView {
  xCenter: number;
  barSpacing: number;
  paneWidth: number;
  paneHeight: number;
  priceTop: number;
  pricePerPx: number;
}

export interface SceneBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type SceneWallRole = "wall" | "anchor" | "connector" | "grower" | "range";

export interface SceneWall {
  id: number;
  role: SceneWallRole;
  side: "bid" | "ask";
  rows: readonly number[];
  core: number;
  bornTs: number;
  endTs: number | null;
  endedBy: "eaten" | "pulled" | null;
  peak: number;
  growSteps: readonly number[];
  dip: { from: number; until: number } | null;
}

export interface Scene {
  readonly flavour: SceneFlavour;
  grid: LiquidityGrid;
  settings: LiquiditySettings;
  view: SceneView;
  readonly history: HeatHistorySource | null;
  layout(): HeatmapLayout;
  pan(dxMediaPx: number): void;
  zoom(barSpacing: number): void;
  shiftPrice(dyMediaPx: number): void;
  scalePrice(factor: number): void;
  addLiveColumn(): void;
  closeCandle(): void;
  setLevels(levels: LiquidityLevel[]): void;
  wallRows(): { side: "bid" | "ask"; row: number }[];
  rng(): number;
  bars(): readonly SceneBar[];
  walls(): SceneWall[];
  mid(): number;
}

type Side = "bid" | "ask";

const SECOND = 1_000;
const MINUTE = 60_000;
const DEEP_MS = 10_000;
const GROW_STEP_MS = 10_000;
const LIVE_OPEN_MS = Date.UTC(2026, 9, 6, 14, 30);

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function unitHash(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) ^ 0x7f4a7c15, 0x85ebca77) ^ Math.imul((c | 0) ^ 0x165667b1, 0xc2b2ae3d);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function epochOf(seed: number, row: number, second: number): number {
  const period = 6 + Math.floor(unitHash(row, seed, 11) * 30);
  return Math.floor((second + Math.floor(unitHash(row, seed, 12) * period)) / period);
}

interface WallShape {
  rows: number[];
  base: number[];
  grows: boolean[];
  core: number;
}

interface FlavourModel {
  identity: BinanceIdentity | DxFeedIdentity;
  symbol: string;
  rowWidth: number;
  bandRows: number;
  quietBands: number;
  windowRows: number;
  bandPx: number;
  wallTarget: number;
  wallMax: number;
  huntRows: number;
  dipClearRows: number;
  dipMinRows: number;
  rangeOffsets: readonly [number, number];
  startRow(random: () => number): number;
  unit(size: number): number;
  background(row: number, second: number): number;
  spawnDistance(random: () => number): number;
  anchorDistance(random: () => number): number;
  wall(random: () => number, side: Side, core: number, mid: number, near: boolean): WallShape;
  rangeWall(random: () => number, side: Side, mid: number): WallShape;
  dip(random: () => number, shape: WallShape): number[];
}

function styleDefaults(identity: BinanceIdentity | DxFeedIdentity, symbol: string): LiquiditySettings {
  return liquidityStyleFor(identity.provider, symbol, identity.provider === "BINANCE" ? identity.marketKind : "").defaultSettings;
}

function cryptoModel(seed: number): FlavourModel {
  const identity: BinanceIdentity = { provider: "BINANCE", marketKind: "PERPETUAL" };
  const defaults = styleDefaults(identity, "BTC-USDT");
  const bandRows = Math.max(1, Math.floor(defaults.clusterRows));
  const unit = (size: number) => Math.round(size * 1000) / 1000;
  const ladder = 60;
  return {
    identity,
    symbol: "BTC-USDT",
    rowWidth: 1,
    bandRows,
    quietBands: defaults.quietBands,
    windowRows: 250,
    bandPx: 3.75,
    wallTarget: 8,
    wallMax: 10,
    huntRows: 40,
    dipClearRows: 15,
    dipMinRows: 15,
    rangeOffsets: [2, bandRows - 3],
    startRow: (random) => Math.round(104_000 + (random() - 0.5) * 4_000),
    unit,
    background: (row, second) => {
      const epoch = epochOf(seed, row, second);
      const band = Math.floor(row / bandRows);
      const v = unitHash(row, epoch, seed);
      if (row - band * bandRows === Math.floor(unitHash(band, seed, 13) * bandRows)) return unit(ladder * (0.95 + 0.1 * v));
      if (unitHash(row, epoch, seed + 7) < 0.1) return 0;
      return unit(0.2 + 2.8 * v);
    },
    spawnDistance: (random) => (random() < 0.5 ? 3 + Math.floor(random() * 58) : 80 + Math.floor(random() * 121)),
    anchorDistance: (random) => 100 + Math.floor(random() * 61),
    wall: (random, side, core, _mid, near) => {
      const rows = [core];
      if (random() < 0.3) {
        const other = side === "bid" ? core - 1 : core + 1;
        if (Math.floor(other / bandRows) === Math.floor(core / bandRows)) rows.push(other);
      }
      rows.sort((a, b) => a - b);
      const total = near ? 1150 + random() * 1450 : 320 + random() * 580;
      return { rows, base: rows.map((row) => unit(rows.length === 1 ? total : (row === core ? 0.6 : 0.4) * total)), grows: rows.map(() => true), core };
    },
    rangeWall: (random, side, mid) => {
      const core = side === "bid" ? mid - 2 : mid + 2;
      return { rows: [core], base: [unit(1200 + random() * 800)], grows: [true], core };
    },
    dip: (random, shape) => {
      const total = 105 + random() * 25;
      const sum = shape.base.reduce((a, b) => a + b, 0);
      return shape.base.map((size) => unit((size / sum) * total));
    },
  };
}

function indexModel(seed: number): FlavourModel {
  const identity: DxFeedIdentity = { provider: "DXFEED", assetClass: "FUTURE" };
  const defaults = styleDefaults(identity, "/NQZ26:XCME");
  const bandRows = Math.max(1, Math.floor(defaults.clusterRows));
  const unit = (size: number) => Math.round(size);
  const shoulder = 100;
  const shaped = (random: () => number, rows: number[], core: number, coreSize: number): WallShape => ({
    rows,
    base: rows.map((row) => (row === core ? coreSize : unit(shoulder * (0.85 + 0.3 * random())))),
    grows: rows.map((row) => row === core),
    core,
  });
  return {
    identity,
    symbol: "/NQZ26:XCME",
    rowWidth: 0.25,
    bandRows,
    quietBands: defaults.quietBands,
    windowRows: 180,
    bandPx: 4.5,
    wallTarget: 9,
    wallMax: 12,
    huntRows: 40,
    dipClearRows: 5,
    dipMinRows: 4,
    rangeOffsets: [4, bandRows - 5],
    startRow: (random) => Math.round((25_000 + (random() - 0.5) * 1_000) / 0.25),
    unit,
    background: (row, second) => 1 + Math.floor(unitHash(row, epochOf(seed, row, second), seed) * 18),
    spawnDistance: (random) => 4 + Math.floor(random() * 107),
    anchorDistance: (random) => 60 + Math.floor(random() * 41),
    wall: (random, side, core, mid) => {
      const band = Math.floor(core / bandRows);
      const fits = (row: number) => Math.floor(row / bandRows) === band && (side === "bid" ? row <= mid - 2 : row >= mid + 2);
      const around = [core - 1, core + 1, core - 2, core + 2].filter(fits);
      const rows = [core, ...around.slice(0, Math.min(around.length, 2 + Math.floor(random() * 3)))].sort((a, b) => a - b);
      return shaped(random, rows, core, unit(330 + random() * 570));
    },
    rangeWall: (random, side, mid) => {
      const core = side === "bid" ? mid - 3 : mid + 3;
      return shaped(random, [core - 1, core, core + 1], core, unit(360 + random() * 340));
    },
    dip: (random, shape) => shape.grows.map((grows) => (grows ? 42 + Math.floor(random() * 11) : 26 + Math.floor(random() * 11))),
  };
}

interface SimWall {
  id: number;
  role: SceneWallRole;
  side: Side;
  core: number;
  rows: number[];
  base: number[];
  grows: boolean[];
  band: number;
  top: number;
  bottom: number;
  bornTs: number;
  growFrom: number;
  growUntil: number;
  growBy: number;
  dipFrom: number;
  dipUntil: number;
  dip: number[];
  dipStarted: boolean;
  pullTs: number;
  guarded: boolean;
  hunted: boolean;
  eaten: number;
  endTs: number | null;
  endedBy: "eaten" | "pulled" | null;
  peak: number;
}

interface Book {
  ts: number;
  lo: number;
  hi: number;
  bid: Float64Array;
  ask: Float64Array;
}

function growStepsOf(wall: SimWall): number {
  return Math.max(1, Math.round((wall.growUntil - wall.growFrom) / GROW_STEP_MS));
}

function wallRowSize(wall: SimWall, index: number, t: number): number {
  if (t >= wall.dipFrom && t < wall.dipUntil) return wall.dip[index] * (1 - wall.eaten);
  let size = wall.base[index];
  if (wall.grows[index] && t >= wall.growFrom && Number.isFinite(wall.growUntil)) {
    const steps = growStepsOf(wall);
    size *= 1 + ((wall.growBy - 1) * Math.min(steps, Math.floor((t - wall.growFrom) / GROW_STEP_MS))) / steps;
  }
  return size * (1 - wall.eaten);
}

class BookSim {
  readonly model: FlavourModel;
  readonly live: SimWall[] = [];
  readonly ended: SimWall[] = [];
  t: number;
  mid: number;
  private readonly _random: () => number;
  private _nextId = 1;
  private _run: { dir: number; left: number } | null = null;
  private _hunt: { id: number; dir: number; through: number } | null = null;
  private _range: { lo: number; hi: number; until: number; band: number; bid: SimWall; ask: SimWall } | null = null;
  private _nextHuntAt: number;
  private _nextRangeAt: number;
  private readonly _script: { at: number; act: () => void }[];

  constructor(model: FlavourModel, seed: number, startTs: number, fineStart: number, lastTs: number) {
    this.model = model;
    this._random = mulberry32(seed);
    this.t = startTs;
    this.mid = model.startRow(this._random);
    this._nextHuntAt = startTs + Math.round(60 + this._random() * 120) * SECOND;
    this._nextRangeAt = startTs + Math.round(120 + this._random() * 180) * SECOND;
    const span = lastTs + SECOND - fineStart;
    const at = (share: number) => fineStart + Math.round((share * span) / SECOND) * SECOND;
    this._script = [
      { at: at(0.1), act: () => this._spawnConnector(at(0.45), at(0.62)) },
      { at: at(0.15), act: () => { this._nextRangeAt = Math.min(this._nextRangeAt, this.t); } },
      { at: at(0.3), act: () => this._spawnGrower(lastTs) },
    ];
    for (const side of ["bid", "ask"] as const) {
      for (let attempt = 0; attempt < 8; attempt += 1) if (this._place(side, model.anchorDistance(this._random), "anchor") !== null) break;
    }
    for (let i = 0; i < model.wallTarget; i += 1) this._spawnRandom();
  }

  advance(): void {
    this.t += SECOND;
    this._moveMid();
    this._endWalls();
    this._runEpisodes();
    this._settleDips();
    this._spawnWalls();
  }

  book(): Book {
    const model = this.model;
    const mid = this.mid;
    const lo = mid - model.windowRows;
    const hi = mid + model.windowRows;
    const bid = new Float64Array(hi - lo + 1);
    const ask = new Float64Array(hi - lo + 1);
    const second = this.t / SECOND;
    for (let row = lo; row <= hi; row += 1) {
      if (row === mid) continue;
      const size = model.background(row, second);
      if (row < mid) bid[row - lo] = size;
      else ask[row - lo] = size;
    }
    for (const wall of this.live) {
      let total = 0;
      wall.rows.forEach((row, index) => {
        const size = model.unit(wallRowSize(wall, index, this.t));
        total += size;
        if (row < lo || row > hi) return;
        if (wall.side === "bid" && row < mid) bid[row - lo] = size;
        if (wall.side === "ask" && row > mid) ask[row - lo] = size;
      });
      if (total > wall.peak) wall.peak = total;
    }
    return { ts: this.t, lo, hi, bid, ask };
  }

  private _uniform(lo: number, hi: number): number {
    return lo + this._random() * (hi - lo);
  }

  private _seconds(lo: number, hi: number): number {
    return Math.round(this._uniform(lo, hi)) * SECOND;
  }

  private _place(side: Side, distance: number, role: SceneWallRole): SimWall | null {
    const model = this.model;
    const core = side === "bid" ? this.mid - distance : this.mid + distance;
    const band = Math.floor(core / model.bandRows);
    if (distance < 2 || distance > model.windowRows - 8) return null;
    if (this.live.some((wall) => wall.band === band)) return null;
    if (this._range !== null && band === this._range.band) return null;
    const near = Math.abs(band - Math.floor(this.mid / model.bandRows)) <= model.quietBands + 2;
    return this._make(side, model.wall(this._random, side, core, this.mid, near), role);
  }

  private _make(side: Side, made: WallShape, role: SceneWallRole): SimWall {
    const wall: SimWall = {
      id: this._nextId,
      role,
      side,
      core: made.core,
      rows: made.rows,
      base: made.base,
      grows: made.grows,
      band: Math.floor(made.core / this.model.bandRows),
      top: Math.max(...made.rows),
      bottom: Math.min(...made.rows),
      bornTs: this.t,
      growFrom: Infinity,
      growUntil: Infinity,
      growBy: 1,
      dipFrom: Infinity,
      dipUntil: Infinity,
      dip: [],
      dipStarted: false,
      pullTs: Infinity,
      guarded: role !== "wall",
      hunted: false,
      eaten: 0,
      endTs: null,
      endedBy: null,
      peak: 0,
    };
    this._nextId += 1;
    this.live.push(wall);
    return wall;
  }

  private _spawnRandom(): void {
    const side: Side = this._random() < 0.5 ? "bid" : "ask";
    const distance = this.model.spawnDistance(this._random);
    if (this._hunt !== null && (this._hunt.dir < 0) === (side === "bid")) return;
    const wall = this._place(side, distance, "wall");
    if (wall === null) return;
    if (this._random() < 0.4) {
      wall.growFrom = this.t + this._seconds(15, 150);
      wall.growUntil = wall.growFrom + this._seconds(10, 90);
      wall.growBy = this._uniform(1.4, 2.4);
    }
    if (distance >= this.model.dipMinRows && this._random() < 0.35) {
      wall.dipFrom = this.t + this._seconds(20, 240);
      wall.dipUntil = wall.dipFrom + this._seconds(4, 14);
      wall.dip = this.model.dip(this._random, wall);
    }
    const pull = this._random();
    if (pull >= 0.2) wall.pullTs = Number.isFinite(wall.dipUntil) ? wall.dipUntil + this._seconds(15, 150) : this.t + this._seconds(60, 600);
  }

  private _spawnConnector(dipFrom: number, pullTs: number): void {
    const side: Side = this._random() < 0.5 ? "bid" : "ask";
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const distance = this.model.dipClearRows + 10 + Math.floor(this._random() * 30);
      const wall = this._place(attempt % 2 === 0 ? side : side === "bid" ? "ask" : "bid", distance, "connector");
      if (wall === null) continue;
      wall.dipFrom = Math.max(dipFrom, this.t + 5 * SECOND);
      wall.dipUntil = wall.dipFrom + this._seconds(6, 10);
      wall.dip = this.model.dip(this._random, wall);
      wall.pullTs = Math.max(pullTs, wall.dipUntil + 20 * SECOND);
      return;
    }
  }

  private _spawnGrower(lastTs: number): void {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const side: Side = this._random() < 0.5 ? "bid" : "ask";
      const wall = this._place(side, 15 + Math.floor(this._random() * 45), "grower");
      if (wall === null) continue;
      wall.growFrom = Math.max(this.t + 5 * SECOND, lastTs - 20 * SECOND);
      wall.growUntil = Math.max(wall.growFrom + 30 * SECOND, lastTs + 100 * SECOND);
      wall.growBy = 2.2;
      return;
    }
  }

  private _blocker(dir: number, next: number): SimWall | null {
    for (const wall of this.live) {
      if (dir < 0 && wall.side === "bid" && wall.top >= next) return wall;
      if (dir > 0 && wall.side === "ask" && wall.bottom <= next) return wall;
    }
    return null;
  }

  private _moveMid(): void {
    let dir = 0;
    const hunt = this._hunt;
    if (this._range !== null) {
      const r = this._random();
      dir = r < 0.25 ? -1 : r < 0.5 ? 1 : 0;
      if (this.mid + dir < this._range.lo || this.mid + dir > this._range.hi) dir = 0;
    } else if (hunt !== null) {
      dir = hunt.dir;
    } else if (this._run !== null) {
      dir = this._run.dir;
      this._run.left -= 1;
      if (this._run.left <= 0) this._run = null;
    } else {
      const r = this._random();
      if (r < 0.012) this._run = { dir: this._random() < 0.5 ? -1 : 1, left: 3 + Math.floor(this._random() * 6) };
      else dir = r < 0.18 ? -1 : r < 0.35 ? 1 : 0;
    }
    if (dir === 0) return;
    const next = this.mid + dir;
    const blocker = this._blocker(dir, next);
    if (blocker === null) {
      this.mid = next;
      if (hunt !== null && hunt.through > 0) {
        hunt.through -= 1;
        if (hunt.through === 0) this._stopHunt();
      }
      return;
    }
    this._run = null;
    if (hunt === null || hunt.through > 0 || blocker.guarded) {
      this._stopHunt();
      return;
    }
    if (blocker.id !== hunt.id) {
      this._release(hunt.id);
      blocker.hunted = true;
      hunt.id = blocker.id;
    }
    blocker.eaten = Math.min(1, blocker.eaten + this._uniform(0.22, 0.45));
    if (blocker.eaten >= 1) {
      this._end(blocker, "eaten");
      hunt.through = 2 + Math.floor(this._random() * 4);
    }
  }

  private _release(id: number): void {
    const wall = this.live.find((entry) => entry.id === id);
    if (wall !== undefined) wall.hunted = false;
  }

  private _stopHunt(): void {
    if (this._hunt !== null) this._release(this._hunt.id);
    this._hunt = null;
  }

  private _far(wall: SimWall): boolean {
    const rows = this.model.bandRows;
    return wall.side === "bid" ? this.mid >= (wall.band + 1) * rows + 2 : this.mid <= wall.band * rows - 3;
  }

  private _end(wall: SimWall, how: "eaten" | "pulled"): void {
    const index = this.live.indexOf(wall);
    if (index < 0) return;
    this.live.splice(index, 1);
    wall.endTs = this.t;
    wall.endedBy = how;
    this.ended.push(wall);
  }

  private _endWalls(): void {
    const reach = this.model.windowRows;
    for (const wall of [...this.live]) {
      if (wall.bottom < this.mid - reach || wall.top > this.mid + reach) {
        this._end(wall, "pulled");
        continue;
      }
      if (this.t < wall.pullTs || wall.hunted) continue;
      if (this._far(wall)) this._end(wall, "pulled");
      else wall.pullTs = this.t + 5 * SECOND;
    }
    const hunt = this._hunt;
    if (hunt !== null && hunt.through === 0 && !this.live.some((wall) => wall.id === hunt.id)) this._hunt = null;
  }

  private _settleDips(): void {
    for (const wall of this.live) {
      if (wall.dipStarted || this.t < wall.dipFrom) continue;
      if (wall.hunted) {
        wall.dipFrom = Infinity;
        wall.dipUntil = Infinity;
        continue;
      }
      const distance = wall.side === "bid" ? this.mid - wall.top : wall.bottom - this.mid;
      if (distance >= this.model.dipClearRows) {
        wall.dipStarted = true;
        continue;
      }
      wall.dipFrom += 5 * SECOND;
      wall.dipUntil += 5 * SECOND;
      if (wall.pullTs < wall.dipUntil + 10 * SECOND) wall.pullTs = wall.dipUntil + 10 * SECOND;
    }
  }

  private _runEpisodes(): void {
    while (this._script.length > 0 && this._script[0].at <= this.t) this._script.shift()?.act();
    if (this._range !== null && this.t >= this._range.until) this._endRange();
    if (this._hunt === null && this._range === null && this.t >= this._nextHuntAt) this._startHunt();
    if (this._hunt === null && this._range === null && this.t >= this._nextRangeAt) this._startRange();
  }

  private _startHunt(): void {
    let target: SimWall | null = null;
    for (const side of ["bid", "ask"] as const) {
      let nearest: SimWall | null = null;
      for (const wall of this.live) {
        if (wall.side !== side) continue;
        if (nearest === null || (side === "bid" ? wall.top > nearest.top : wall.bottom < nearest.bottom)) nearest = wall;
      }
      if (nearest === null || nearest.guarded || nearest.hunted || (this.t >= nearest.dipFrom - MINUTE && this.t < nearest.dipUntil)) continue;
      const distance = side === "bid" ? this.mid - nearest.top : nearest.bottom - this.mid;
      const best = target === null ? Infinity : target.side === "bid" ? this.mid - target.top : target.bottom - this.mid;
      if (distance <= this.model.huntRows && distance < best) target = nearest;
    }
    if (target === null) {
      this._nextHuntAt = this.t + 20 * SECOND;
      return;
    }
    target.hunted = true;
    this._hunt = { id: target.id, dir: target.side === "bid" ? -1 : 1, through: 0 };
    this._run = null;
    this._nextHuntAt = this.t + this._seconds(100, 220);
  }

  private _startRange(): void {
    const model = this.model;
    const band = Math.floor(this.mid / model.bandRows);
    const offset = this.mid - band * model.bandRows;
    if (offset < model.rangeOffsets[0] || offset > model.rangeOffsets[1] || this.live.some((wall) => wall.band === band)) {
      this._nextRangeAt = this.t + 7 * SECOND;
      return;
    }
    const bid = this._make("bid", model.rangeWall(this._random, "bid", this.mid), "range");
    const ask = this._make("ask", model.rangeWall(this._random, "ask", this.mid), "range");
    this._range = { lo: this.mid - 1, hi: this.mid + 1, until: this.t + this._seconds(25, 70), band, bid, ask };
    this._run = null;
    this._nextRangeAt = this.t + this._seconds(240, 420);
  }

  private _endRange(): void {
    const range = this._range;
    if (range === null) return;
    this._range = null;
    const eat = this._random() < 0.5 ? range.bid : range.ask;
    const other = eat === range.bid ? range.ask : range.bid;
    other.guarded = false;
    if (this._random() < 0.5) other.pullTs = this.t + this._seconds(20, 90);
    if (!this.live.includes(eat)) return;
    eat.guarded = false;
    eat.hunted = true;
    this._hunt = { id: eat.id, dir: eat.side === "bid" ? -1 : 1, through: 0 };
  }

  private _spawnWalls(): void {
    const count = this.live.length;
    if (count < this.model.wallTarget ? this._random() < 0.2 : count < this.model.wallMax && this._random() < 0.01) this._spawnRandom();
  }
}

function wireOf(prev: Book | null, next: Book): LiquidityColumnFrame {
  const bid: LiquidityEntry[] = [];
  const ask: LiquidityEntry[] = [];
  for (let row = next.lo; row <= next.hi; row += 1) {
    const at = row - next.lo;
    const held = prev !== null && row >= prev.lo && row <= prev.hi;
    const prevBid = held ? prev.bid[row - prev.lo] : 0;
    const prevAsk = held ? prev.ask[row - prev.lo] : 0;
    if (next.bid[at] !== prevBid) bid.push([at, next.bid[at]]);
    if (next.ask[at] !== prevAsk) ask.push([at, next.ask[at]]);
  }
  return { ts: next.ts, lo: next.lo, hi: next.hi, bid, ask };
}

interface HistoryWall {
  side: Side;
  rows: number[];
  base: number[];
  band: number;
  top: number;
  bottom: number;
  until: number;
}

interface HistoryTape {
  columns: LiquidityColumn[];
  bars: SceneBar[];
}

function smoothed(column: LiquidityColumn, rowWidth: number, percentile: number, current: number, alpha: number): number {
  const midPrice = ((column.lo + column.hi) / 2) * rowWidth;
  const referenceRows = Math.max(1, Math.round((midPrice * LIQUIDITY_REFERENCE_BP) / 10_000 / rowWidth));
  const sample = liquidityPercentile(column, percentile, referenceRows);
  if (sample <= 0) return current;
  return current <= 0 ? sample : current + alpha * (sample - current);
}

function buildHistoryTape(model: FlavourModel, seed: number, endTs: number, endMid: number, minutes: number): HistoryTape {
  const random = mulberry32((seed ^ 0x51ed270b) >>> 0);
  const mids = new Int32Array(minutes + 1);
  mids[minutes] = endMid;
  for (let i = minutes - 1; i >= 0; i -= 1) mids[i] = mids[i + 1] - Math.round((random() + random() + random() - 1.5) * 6);
  const fromTs = endTs - minutes * MINUTE;
  const rows = model.bandRows;
  const reach = model.windowRows;
  const alpha = 1 - (1 - LIQUIDITY_REFERENCE_ALPHA) ** (MINUTE / SECOND);
  let walls: HistoryWall[] = [];
  let reference = 0;
  let median = 0;
  const columns: LiquidityColumn[] = [];
  const bars: SceneBar[] = [];
  for (let i = 0; i < minutes; i += 1) {
    const ts = fromTs + i * MINUTE;
    const mid = mids[i];
    walls = walls.filter((wall) => {
      if (wall.side === "bid" ? mid <= wall.top + 1 : mid >= wall.bottom - 1) return false;
      if (wall.bottom < mid - reach || wall.top > mid + reach) return false;
      const far = wall.side === "bid" ? mid >= (wall.band + 1) * rows + 2 : mid <= wall.band * rows - 3;
      return !(i >= wall.until && far);
    });
    for (let attempt = 0; attempt < 4 && walls.length < model.wallTarget; attempt += 1) {
      const side: Side = random() < 0.5 ? "bid" : "ask";
      const distance = model.spawnDistance(random);
      const core = side === "bid" ? mid - distance : mid + distance;
      const band = Math.floor(core / rows);
      if (distance > reach - 8 || walls.some((wall) => wall.band === band)) continue;
      const near = Math.abs(band - Math.floor(mid / rows)) <= model.quietBands + 2;
      const shape = model.wall(random, side, core, mid, near);
      const until = random() < 0.2 ? Infinity : i + 5 + Math.floor(random() * 175);
      walls.push({ side, rows: shape.rows, base: shape.base, band, top: Math.max(...shape.rows), bottom: Math.min(...shape.rows), until });
    }
    const lo = mid - reach;
    const hi = mid + reach;
    const bid = new Float64Array(hi - lo + 1);
    const ask = new Float64Array(hi - lo + 1);
    for (let row = lo; row <= hi; row += 1) {
      if (row === mid) continue;
      const size = model.background(row, ts / SECOND);
      if (row < mid) bid[row - lo] = size;
      else ask[row - lo] = size;
    }
    for (const wall of walls) {
      wall.rows.forEach((row, index) => {
        if (row < lo || row > hi) return;
        if (wall.side === "bid" && row < mid) bid[row - lo] = wall.base[index];
        if (wall.side === "ask" && row > mid) ask[row - lo] = wall.base[index];
      });
    }
    const column: LiquidityColumn = { ts, lo, hi, bid, ask };
    reference = smoothed(column, model.rowWidth, LIQUIDITY_REFERENCE_PERCENTILE, reference, alpha);
    median = smoothed(column, model.rowWidth, 0.5, median, alpha);
    column.reference = reference;
    column.median = median;
    columns.push(column);
    const before = mids[Math.max(0, i - 1)];
    const after = mids[i + 1];
    bars.push({
      time: ts / SECOND,
      open: (mid + 0.5) * model.rowWidth,
      high: (Math.max(before, mid, after) + 1.5) * model.rowWidth,
      low: (Math.min(before, mid, after) - 0.5) * model.rowWidth,
      close: (after + 0.5) * model.rowWidth,
    });
  }
  return { columns, bars };
}

function historySourceOf(tape: HistoryTape, rowWidth: number): HeatHistorySource {
  const cache = new Map<string, readonly LiquidityColumn[]>();
  const first = tape.columns.length > 0 ? tape.columns[0].ts : null;
  const last = tape.columns.length > 0 ? tape.columns[tape.columns.length - 1].ts : null;
  const window = (ts: number | null) => (ts === null ? null : Math.floor(ts / HISTORY_WINDOW_MS) * HISTORY_WINDOW_MS);
  return {
    reach(want: HistoryWant): HistoryReach {
      const to = Math.min(want.toTs, want.beforeTs);
      const key = `${want.levelMs}:${want.rowFactor}:${want.fromTs}:${to}`;
      let columns = cache.get(key);
      if (columns === undefined) {
        columns = want.rowFactor !== 1 || want.levelMs % MINUTE !== 0 ? [] : tape.columns.filter((column) => column.ts >= want.fromTs && column.ts < to && column.ts % want.levelMs === 0);
        cache.set(key, columns);
      }
      return { columns, shown: { ...want }, loading: false };
    },
    status(_levelMs: number, rowFactor: number): HistoryStatus {
      return { rowWidth: rowWidth * rowFactor, span: { oldest: window(first), newest: window(last) }, reachTs: window(first), unavailable: null };
    },
  };
}

export function buildScene(options: SceneOptions): Scene {
  const minutes = options.minutes ?? 12;
  const deepMinutes = options.deepMinutes ?? 30;
  const paneWidth = options.paneWidth ?? 600;
  const paneHeight = options.paneHeight ?? 400;
  if (!Number.isSafeInteger(minutes) || minutes < 1) throw new Error("buildScene: minutes must be a whole number of at least 1");
  if (!Number.isSafeInteger(deepMinutes) || deepMinutes < 0) throw new Error("buildScene: deepMinutes must be a whole number");
  if (!(paneWidth > 0) || !(paneHeight > 0)) throw new Error("buildScene: the pane needs a size");
  const seed = options.seed >>> 0;
  const flavour = options.flavour;
  const model = flavour === "crypto" ? cryptoModel(seed) : indexModel(seed);
  const settings: LiquiditySettings = { ...styleDefaults(model.identity, model.symbol) };
  const rowWidth = model.rowWidth;

  const lastTs = LIVE_OPEN_MS + (20 + Math.floor(unitHash(seed, 1, 99) * 26)) * SECOND;
  const fineStart = lastTs - (minutes * 60 - 1) * SECOND;
  const startTs = Math.floor(fineStart / MINUTE) * MINUTE - deepMinutes * MINUTE;
  const sim = new BookSim(model, seed, startTs, fineStart, lastTs);

  const bars: SceneBar[] = [];
  const barIndex = new Map<number, number>();
  let historySource: HeatHistorySource | null = null;
  if (options.history === true) {
    const { reachMs } = historyReachFor(historyDaysOf(settings));
    const tape = buildHistoryTape(model, seed, startTs, sim.mid, Math.round(reachMs / MINUTE));
    for (const bar of tape.bars) {
      barIndex.set(bar.time, bars.length);
      bars.push(bar);
    }
    historySource = historySourceOf(tape, rowWidth);
  }

  const followMid = (ts: number, mid: number) => {
    const open = Math.floor(ts / MINUTE) * MINUTE;
    const price = (mid + 0.5) * rowWidth;
    const low = (mid - 0.5) * rowWidth;
    const high = (mid + 1.5) * rowWidth;
    const last = bars[bars.length - 1];
    if (last === undefined || last.time * SECOND < open) {
      barIndex.set(open / SECOND, bars.length);
      bars.push({ time: open / SECOND, open: price, high, low, close: price });
      return;
    }
    bars[bars.length - 1] = { ...last, high: Math.max(last.high, high), low: Math.min(last.low, low), close: price };
  };

  const fineBooks: Book[] = [];
  const deepBooks: Book[] = [];
  const record = () => {
    followMid(sim.t, sim.mid);
    const fine = sim.t >= fineStart;
    const deep = sim.t % DEEP_MS === 0;
    if (!fine && !deep) return;
    const book = sim.book();
    if (fine) fineBooks.push(book);
    if (deep) deepBooks.push(book);
  };
  record();
  while (sim.t < lastTs) {
    sim.advance();
    record();
  }

  const frameOf = (columnMs: number, seq: number, reset: boolean, columns: LiquidityColumnFrame[], levels?: LiquidityLevel[]): LiquidityFrame => {
    const frame: LiquidityFrame = {
      ...model.identity,
      type: "liquidity",
      symbol: model.symbol,
      ts: columns.length > 0 ? columns[columns.length - 1].ts : sim.t,
      seq,
      reset,
      row_width: rowWidth,
      column_ms: columnMs,
      columns,
    };
    if (levels !== undefined) frame.levels = levels;
    return frame;
  };
  const chain = (books: readonly Book[]) => books.map((book, i) => wireOf(i === 0 ? null : books[i - 1], book));
  const grid = new LiquidityGrid();
  const apply = (frame: LiquidityFrame) => {
    if (!grid.apply(frame)) throw new Error(`buildScene: the grid refused a ${frame.column_ms} ms frame at seq ${frame.seq}`);
  };
  let fineSeq = fineBooks.length;
  let deepSeq = deepBooks.length;
  apply(frameOf(SECOND, fineSeq, true, chain(fineBooks)));
  apply(frameOf(DEEP_MS, deepSeq, true, chain(deepBooks)));
  let lastFine = fineBooks[fineBooks.length - 1];
  let lastDeep = deepBooks[deepBooks.length - 1];

  const livePrice = (sim.mid + 0.5) * rowWidth;
  const pricePerPx = (model.bandRows * rowWidth) / model.bandPx;
  const sceneRandom = mulberry32((seed ^ 0x5bd1e995) >>> 0);

  const chart = {
    timeScale: () => ({
      timeToIndex: (time: Time) => barIndex.get(Number(time)) ?? null,
      logicalToCoordinate: (logical: number) => scene.view.xCenter - (bars.length - 1 - logical) * scene.view.barSpacing,
      options: () => ({ barSpacing: scene.view.barSpacing }),
      width: () => scene.view.paneWidth,
    }),
    paneSize: () => ({ height: scene.view.paneHeight, width: scene.view.paneWidth }),
  } as unknown as IChartApiBase<Time>;
  const series = {
    data: () => bars,
    coordinateToPrice: (y: number) => scene.view.priceTop - y * scene.view.pricePerPx,
    priceToCoordinate: (price: number) => (scene.view.priceTop - price) / scene.view.pricePerPx,
  } as unknown as ISeriesApi<SeriesType, Time>;

  const addLiveColumn = () => {
    sim.advance();
    followMid(sim.t, sim.mid);
    const book = sim.book();
    fineSeq += 1;
    apply(frameOf(SECOND, fineSeq, false, [wireOf(lastFine, book)]));
    lastFine = book;
    if (sim.t % DEEP_MS === 0) {
      deepSeq += 1;
      apply(frameOf(DEEP_MS, deepSeq, false, [wireOf(lastDeep, book)]));
      lastDeep = book;
    }
  };

  const toWall = (wall: SimWall): SceneWall => ({
    id: wall.id,
    role: wall.role,
    side: wall.side,
    rows: wall.rows.slice(),
    core: wall.core,
    bornTs: wall.bornTs,
    endTs: wall.endTs,
    endedBy: wall.endedBy,
    peak: wall.peak,
    growSteps: Number.isFinite(wall.growUntil) ? Array.from({ length: growStepsOf(wall) }, (_, k) => wall.growFrom + (k + 1) * GROW_STEP_MS) : [],
    dip: Number.isFinite(wall.dipFrom) ? { from: wall.dipFrom, until: wall.dipUntil } : null,
  });

  const scene: Scene = {
    flavour,
    grid,
    settings,
    view: {
      xCenter: Math.round(paneWidth * 0.8),
      barSpacing: 6,
      paneWidth,
      paneHeight,
      priceTop: livePrice + (paneHeight / 2) * pricePerPx,
      pricePerPx,
    },
    history: historySource,
    layout: () => {
      const layout = computeHeatmapLayout(chart, series, grid, scene.settings, null, null, "auto", historySource);
      if (layout === null) throw new Error("heatRasterScenes: no layout at this view");
      return layout;
    },
    pan: (dxMediaPx) => {
      scene.view.xCenter += dxMediaPx;
    },
    zoom: (barSpacing) => {
      scene.view.barSpacing = barSpacing;
    },
    shiftPrice: (dyMediaPx) => {
      scene.view.priceTop += dyMediaPx * scene.view.pricePerPx;
    },
    scalePrice: (factor) => {
      const view = scene.view;
      const middle = view.priceTop - (view.paneHeight / 2) * view.pricePerPx;
      view.pricePerPx *= factor;
      view.priceTop = middle + (view.paneHeight / 2) * view.pricePerPx;
    },
    addLiveColumn,
    closeCandle: () => {
      const open = bars[bars.length - 1].time;
      do addLiveColumn();
      while (bars[bars.length - 1].time === open);
    },
    setLevels: (levels) => apply(frameOf(SECOND, fineSeq, false, [], levels)),
    wallRows: () => sim.live.map((wall) => ({ side: wall.side, row: wall.core })),
    rng: sceneRandom,
    bars: () => bars,
    walls: () => [...sim.ended, ...sim.live].sort((a, b) => a.id - b.id).map(toWall),
    mid: () => sim.mid,
  };
  return scene;
}
