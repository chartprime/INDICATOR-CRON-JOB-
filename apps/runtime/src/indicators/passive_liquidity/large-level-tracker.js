"use strict";

// Large resting levels: the walls in a heatmap column, and what became of
// each wall.
//
// A wall is a cluster of adjacent rows holding size that is large for THIS
// book near price. Each row in the cluster holds at least half the entry
// threshold and the cluster as a whole reaches it; the threshold is
// `multiplier` times the 95th percentile row size within `referenceRows` of
// the column's mid (smoothed), and at least `minSize` in base units. The
// far book is thicker than the near book, so the reference is local. The relative part makes one setting serve a perpetual whose
// typical $4 row holds 60 BTC and a spot book whose typical row holds 6; the
// clustering turns three stacked rows of size into one bar instead of three.
//
// A wall is tracked from the column it first qualified. Each later column
// it is matched to the cluster overlapping its rows (an older wall claims
// first; a younger wall swallowed by an older one's cluster is absorbed
// silently). With no cluster left it survives while its rows still hold
// half the threshold it entered at (hysteresis), then ends, and the ledger
// says how: the rows' bands count traded and cancelled volume cumulatively.
// The verdict asks what became of the size that left the wall, not how it
// compares with the wall itself. On BTC spot the book cancels between one
// and two hundred times more size than it trades, so "a fifth of the wall
// traded" is a bar the market can never clear: a sixty coin wall would need
// twelve coins traded into one price, while the whole book trades a dozen
// coins a minute. A wall that gave at least `EATEN_SHARE` of its departing
// size to trades rather than to cancels was eaten ("filled"). One price
// reached that left mostly by cancelling was "hit" (the quoting bot pulled
// at the touch: price got there, the size did not stay to be taken). One
// price never reached was withdrawn ("pulled").
// A pulled wall that shows up again within `RELINK_MS` on the same side,
// near its old rows, at about the same size is the same order re-placed:
// the old wall becomes "moved" and both carry the chain id of the first
// wall in that trace, so a chart can draw the bot's path as one stepped
// bar. Ended walls are kept for `keepEndedMs` so a reconnecting client
// still sees where price ate through.

const { rowOf } = require("./liquidity-sampler");

const DEFAULT_KEEP_ENDED_MS = 20 * 60_000;
const DEFAULT_MAX_LEVELS = 60;
// The server tracks a superset: anything 1.5x the typical row is a wall on
// the wire, with its ratio, and each chart decides what its timeframe shows.
const DEFAULT_MULTIPLIER = 1.5;
const DEFAULT_GAP_ROWS = 2;
const REFERENCE_PERCENTILE = 0.95;
const REFERENCE_ALPHA = 0.1;
const END_RATIO = 0.5;
// Of everything that left a wall, the share that traded rather than being
// cancelled decides the verdict. A share, not an amount, so it reads the
// same on a quiet pair and a busy one. Measured on live BTC spot, an
// ordinary price band trades under one percent of what leaves it, and a
// band where real absorption happened traded twenty-two percent. At least
// FILLED_SHARE is "filled", at least EATEN_SHARE is "partial", under that a
// wall price reached is "hit" and one it never reached is "pulled".
const EATEN_SHARE = 0.2;
const FILLED_SHARE = 0.5;
// The share of a wall's own peak that has to print on its rows for the same
// two verdicts. The share-of-what-left rule above cannot see a wall being eaten
// on a book that cancels far more than it trades: measured on BTC perp, a wall
// that gave 43 of its 84 coins to trades came out at a one percent share, and
// across 253 ended walls not one was ever called filled or partial.
const EATEN_OF_PEAK = 0.15;
const FILLED_OF_PEAK = 0.5;
// A wall is not judged the moment its rows empty. Depth updates and trades
// travel on different streams and the update that shows a level empty
// usually lands before the trades that emptied it, so a verdict taken on
// the spot calls a swept wall "pulled". The wall waits this long, still
// resting on the wire, then the verdict is taken on what has arrived.
const DEFAULT_SETTLE_MS = 5_000;
// A resting wall is "absorbing" while trades keep landing on its rows and it
// still holds at least this share of its peak: being hit and refilled.
const ABSORB_WINDOW_MS = 5_000;
const ABSORB_HOLD_SHARE = 0.5;
// "Hit" means pulled at the touch: price was at the wall's rows within this
// long before it left. A wall price visited ten minutes earlier and that was
// withdrawn with price a hundred dollars away was pulled, not hit. Checked on
// the recording: the largest spot bid of the hour was called hit while every
// trade in the minute it left printed more than a hundred dollars above it.
const HIT_WINDOW_MS = 10_000;

function round2(value) {
  return Math.round(value * 100) / 100;
}
// A wall whose rows the ledger does not know (not yet seen since a re-seed)
// is held this long before it is written off as pulled.
const UNKNOWN_HOLD_MS = 15 * 60_000;
// A pulled wall re-placed within this long, within this many rows, at a
// size within this share of its peak is the same order moved.
const RELINK_MS = 15_000;
const RELINK_ROWS = 30;
const RELINK_SIZE_TOLERANCE = 0.35;
// Beyond `keepEndedMs`, up to `deepKeepEndedMs`, only ended walls that meant
// something stay: anything price reached or that moved, and pulled walls
// that rested at least this long. Sub-minute flickers are not history.
const DEEP_MIN_LIFE_MS = 60_000;
// Over the cap, the ended walls that meant least go first: a moved segment
// (its successor is on the chart), a pull that never rested a minute, a pull,
// a wall price reached, and last the walls price ate into. Within a class
// the oldest goes first. On a busy pair the newest-first cut emptied the
// list of every traded wall within hours while short pulls filled it.
const EVICTION_RANK = Object.freeze({ moved: 0, pulled: 2, hit: 3, partial: 4, filled: 4 });

function evictionRank(level) {
  if (level.endedBy === "pulled" && level.endTs - level.startTs < DEEP_MIN_LIFE_MS) return 1;
  return EVICTION_RANK[level.endedBy] ?? 0;
}

function trimEnded(list, cap) {
  if (list.length <= cap) return list;
  const drop = new Set([...list].sort((a, b) => evictionRank(a) - evictionRank(b) || a.endTs - b.endTs).slice(0, list.length - cap));
  return list.filter((level) => !drop.has(level));
}

function similarSize(a, b) {
  return a > 0 && b > 0 && Math.abs(a - b) <= RELINK_SIZE_TOLERANCE * Math.max(a, b);
}

/**
 * The p-th percentile (0..1) of the non-zero cells on both sides of a
 * column, 0 when empty. `referenceRows` limits the sample to rows within
 * that distance of the column's mid: the book far from price is much
 * thicker, and a wall has to be judged against its neighbours.
 */
function columnPercentile(column, p, referenceRows = Infinity) {
  const values = [];
  const mid = (column.lo + column.hi) / 2;
  const from = Math.max(0, Math.ceil(mid - referenceRows - column.lo));
  const to = Math.min(column.bid.length - 1, Math.floor(mid + referenceRows - column.lo));
  for (const side of [column.bid, column.ask]) for (let i = from; i <= to; i += 1) if (side[i] > 0) values.push(side[i]);
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.max(0, Math.round(p * (values.length - 1))))];
}

/**
 * Runs of rows each holding at least `half`, whose total reaches `entry`.
 * Up to `gapRows` thinner rows between two strong rows are bridged (their
 * size counted in), so a wall split by a nearly empty row is one wall.
 */
function clustersOf(values, lo, half, entry, gapRows = 0) {
  const clusters = [];
  let start = -1;
  let lastStrong = -1;
  let total = 0;
  let gapTotal = 0;
  const close = () => {
    if (start >= 0 && total >= entry) clusters.push({ row: lo + start, span: lastStrong - start + 1, total });
    start = -1;
    gapTotal = 0;
  };
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value >= half) {
      if (start < 0) {
        start = i;
        total = 0;
      }
      total += gapTotal + value;
      gapTotal = 0;
      lastStrong = i;
    } else if (start >= 0) {
      if (i - lastStrong <= gapRows) gapTotal += value;
      else close();
    }
  }
  close();
  return clusters;
}

function overlaps(a, b) {
  return a.row <= b.row + b.span - 1 && b.row <= a.row + a.span - 1;
}

/** Resting size over a level's rows in a column (rows outside the window count as 0). */
function rangeTotal(level, values, lo, hi) {
  let total = 0;
  for (let row = level.row; row < level.row + level.span; row += 1) {
    if (row >= lo && row <= hi) total += values[row - lo];
  }
  return total;
}

function rowTotals(records, rowClusters, rows) {
  const totals = new Map(); // row -> { traded, cancelled }
  for (const record of records) {
    const row = rowOf(record.key, rowClusters);
    if (!rows.has(row)) continue;
    let entry = totals.get(row);
    if (!entry) {
      entry = { traded: 0, cancelled: 0 };
      totals.set(row, entry);
    }
    entry.traded += record.traded ?? 0;
    entry.cancelled += record.cancelled ?? 0;
  }
  return totals;
}

/**
 * Volume traded and cancelled on a wall's rows since each row joined it.
 *
 * The obvious implementation, one sum taken when the wall qualified and
 * subtracted from one taken when it left, is wrong, and wrong in the worst
 * possible direction. A wall slides sideways as its cluster shifts and it
 * narrows as it is worked, so the closing sum covers different rows, and
 * usually fewer, than the opening one. Every price the market has already
 * visited carries traded volume from before the wall existed, so the closing
 * sum comes out below the opening one, the difference clamps to zero, and a
 * wall that was completely eaten reports nothing traded. Eaten walls are
 * precisely the ones that narrow, so the failure was systematic: on a real
 * book almost nothing was ever called "filled".
 *
 * So each row carries its own baseline, recorded the first time the wall
 * covers it. A row the ledger has no record for yet is skipped rather than
 * baselined at zero, or its whole history would land in the total the moment
 * a record appeared.
 */
function volumeSince(level, totals) {
  let traded = 0;
  let cancelled = 0;
  for (let row = level.row; row < level.row + level.span; row += 1) {
    const now = totals.get(row);
    if (now === undefined) continue;
    let base = level.baseline.get(row);
    if (base === undefined) {
      base = { traded: now.traded, cancelled: now.cancelled };
      level.baseline.set(row, base);
    }
    traded += Math.max(0, now.traded - base.traded);
    cancelled += Math.max(0, now.cancelled - base.cancelled);
  }
  return { traded, cancelled };
}

/** Of the most a wall ever held, the share that has traded on its rows since it formed. */
function eatenShare(level) {
  return level.peak > 0 ? Math.min(1, level.tradedSeen / level.peak) : 0;
}

function createLargeLevelTracker({
  minSize,
  multiplier = DEFAULT_MULTIPLIER,
  gapRows = DEFAULT_GAP_ROWS,
  keepEndedMs = DEFAULT_KEEP_ENDED_MS,
  deepKeepEndedMs = keepEndedMs,
  maxLevels = DEFAULT_MAX_LEVELS,
  settleMs = DEFAULT_SETTLE_MS,
} = {}) {
  if (!Number.isSafeInteger(settleMs) || settleMs < 0) throw new Error("large-level-tracker: settleMs must be a non-negative safe integer");
  if (!(minSize > 0) || !Number.isFinite(minSize)) throw new Error("large-level-tracker: minSize must be a positive finite number");
  if (!(multiplier >= 0) || !Number.isFinite(multiplier)) throw new Error("large-level-tracker: multiplier must be a non-negative finite number");
  if (!Number.isSafeInteger(gapRows) || gapRows < 0) throw new Error("large-level-tracker: gapRows must be a non-negative safe integer");
  if (!Number.isSafeInteger(keepEndedMs) || keepEndedMs <= 0) throw new Error("large-level-tracker: keepEndedMs must be a positive safe integer");
  if (!Number.isSafeInteger(deepKeepEndedMs) || deepKeepEndedMs < keepEndedMs) throw new Error("large-level-tracker: deepKeepEndedMs must be a safe integer no smaller than keepEndedMs");
  if (!Number.isSafeInteger(maxLevels) || maxLevels <= 0) throw new Error("large-level-tracker: maxLevels must be a positive safe integer");

  const active = new Map(); // id -> level
  let ended = []; // oldest first
  let reference = 0; // smoothed p95 row size
  let nextId = 1;
  let changed = false;
  let dirty = false;

  /** The size a cluster must reach right now to become a wall. */
  function threshold() {
    return Math.max(minSize, multiplier * reference);
  }

  /** Price is at or through the wall's rows: a bid wall with the mid at or below it, an ask wall with the mid at or above it. */
  function reachedBy(level, midRow) {
    return level.side === "bid" ? midRow <= level.row + level.span - 1 : midRow >= level.row;
  }

  function endLevel(id, level, endTs, size, totals, midRow) {
    const { traded, cancelled } = volumeSince(level, totals);
    if (traded > level.tradedSeen) level.tradedSeen = traded;
    const reached = reachedBy(level, midRow) || (level.reachedTs !== null && endTs - level.reachedTs <= HIT_WINDOW_MS);
    const left = traded + cancelled;
    const share = left > 0 ? traded / left : 0;
    const eaten = eatenShare(level);
    level.size = size;
    level.endTs = endTs;
    level.fill = share;
    level.absorbing = false;
    level.endedBy = share >= FILLED_SHARE || eaten >= FILLED_OF_PEAK ? "filled"
      : share >= EATEN_SHARE || eaten >= EATEN_OF_PEAK ? "partial"
      : reached ? "hit" : "pulled";
    active.delete(id);
    ended.push(level);
    if (level.endedBy === "pulled" || level.endedBy === "hit") relinkForward(level, endTs);
    changed = true;
  }

  function worthKeeping(level) {
    return level.endedBy !== "pulled" || level.endTs - level.startTs >= DEEP_MIN_LIFE_MS;
  }

  function link(previous, next) {
    if (previous.chain === 0) previous.chain = previous.id;
    next.chain = previous.chain;
    previous.endedBy = "moved";
    changed = true;
  }

  function relinkCandidate(previous, next) {
    return previous !== next && previous.side === next.side && next.chain === 0 && (previous.endedBy === "pulled" || previous.endedBy === "hit")
      && Math.abs(previous.row - next.row) <= RELINK_ROWS && similarSize(previous.peak, next.peak);
  }

  /** A wall just pulled: was it re-placed around then as a wall that is still resting? `at` is when it left, not when it was judged. */
  function relinkForward(previous, at) {
    let best = null;
    for (const level of active.values()) {
      if (level.startTs < at - RELINK_MS || !relinkCandidate(previous, level)) continue;
      if (!best || Math.abs(level.peak - previous.peak) < Math.abs(best.peak - previous.peak)) best = level;
    }
    if (best) link(previous, best);
  }

  /** A wall just born: is it a wall pulled moments ago, re-placed? */
  function relinkBackward(next, ts) {
    let best = null;
    for (const level of ended) {
      if (level.endTs < ts - RELINK_MS || !relinkCandidate(level, next)) continue;
      if (!best || Math.abs(level.peak - next.peak) < Math.abs(best.peak - next.peak)) best = level;
    }
    if (best) link(best, next);
  }

  /** Merge same-side walls whose rows are within `gapRows` of each other: the older keeps the union. */
  function mergeAdjacent(side, values, column) {
    const mine = [...active.entries()].filter(([, level]) => level.side === side).sort(([, a], [, b]) => a.row - b.row);
    for (let i = 1; i < mine.length; i += 1) {
      const [idPrev, prev] = mine[i - 1];
      const [idNext, next] = mine[i];
      if (next.row - (prev.row + prev.span) > gapRows) continue;
      const [keepId, keep, dropId, drop] = prev.startTs <= next.startTs ? [idPrev, prev, idNext, next] : [idNext, next, idPrev, prev];
      const row = Math.min(prev.row, next.row);
      const top = Math.max(prev.row + prev.span, next.row + next.span);
      keep.row = row;
      keep.span = top - row;
      keep.size = rangeTotal(keep, values, column.lo, column.hi);
      keep.peak = Math.max(keep.peak, drop.peak, keep.size);
      for (const [row, base] of drop.baseline) if (!keep.baseline.has(row)) keep.baseline.set(row, base);
      if (drop.lastTradeTs !== null && (keep.lastTradeTs === null || drop.lastTradeTs > keep.lastTradeTs)) keep.lastTradeTs = drop.lastTradeTs;
      keep.tradedSeen = Math.max(keep.tradedSeen, drop.tradedSeen);
      if (keep.chain === 0 && drop.chain > 0) keep.chain = drop.chain;
      active.delete(dropId);
      mine[i] = [keepId, keep];
      changed = true;
    }
  }

  /**
   * Feed the column just sampled plus the ledger snapshot it came from.
   * Returns true when the reported set changed.
   */
  function update({ ts, column, snapshot, rowClusters, referenceRows = Infinity }) {
    changed = dirty;
    dirty = false;
    const sample = columnPercentile(column, REFERENCE_PERCENTILE, referenceRows);
    if (sample > 0) reference = reference <= 0 ? sample : reference + REFERENCE_ALPHA * (sample - reference);
    const entry = threshold();
    const half = entry * END_RATIO;
    const midRow = (column.lo + column.hi) / 2;
    const sides = [["bid", snapshot.bids], ["ask", snapshot.asks]];
    for (const [side, records] of sides) {
      const values = column[side];
      const clusters = clustersOf(values, column.lo, half, entry, gapRows);
      const mine = [...active.entries()].filter(([, level]) => level.side === side).sort(([, a], [, b]) => a.startTs - b.startTs);
      const interesting = new Set();
      for (const cluster of clusters) for (let r = cluster.row; r < cluster.row + cluster.span; r += 1) interesting.add(r);
      for (const [, level] of mine) for (let r = level.row; r < level.row + level.span; r += 1) interesting.add(r);
      const totals = rowTotals(records, rowClusters, interesting);
      // A wall adopted from a backfill has no baseline yet: the ledger it was
      // measured against lived in the worker. Take this column's totals as
      // its zero, so its verdict counts what happens from here.
      for (const [, level] of mine) {
        if (!level.baselinePending) continue;
        level.baseline.clear();
        level.baselinePending = false;
      }
      const claimed = new Set();
      // Existing walls, oldest first: follow their cluster, or end.
      for (const [id, level] of mine) {
        if (reachedBy(level, midRow)) level.reachedTs = ts; // the last time price was at it
        const cluster = clusters.find((c) => !claimed.has(c) && overlaps(c, level));
        if (cluster) {
          claimed.add(cluster);
          level.leftTs = null;
          if (cluster.row !== level.row || cluster.span !== level.span || cluster.total !== level.size) {
            level.row = cluster.row;
            level.span = cluster.span;
            level.size = cluster.total;
            if (cluster.total > level.peak) level.peak = cluster.total;
            changed = true;
          }
          continue;
        }
        const swallower = [...claimed].some((c) => overlaps(c, level)) ? mine.find(([, other]) => other !== level && [...claimed].some((c) => overlaps(c, other) && overlaps(c, level)))?.[1] : null;
        if (swallower) {
          // Swallowed by an older wall's cluster: one bar, not two. A trace
          // the swallowed wall carried continues under the survivor.
          if (swallower.chain === 0 && level.chain > 0) swallower.chain = level.chain;
          active.delete(id);
          changed = true;
          continue;
        }
        const remaining = rangeTotal(level, values, column.lo, column.hi);
        if (remaining >= level.threshold * END_RATIO) {
          level.unknownSince = null;
          level.leftTs = null;
          if (remaining !== level.size) {
            level.size = remaining;
            if (remaining > level.peak) level.peak = remaining;
            changed = true;
          }
          continue;
        }
        // Zero because the ledger has no record for these rows is not the
        // same as zero because the size left. After a re-seed (pair switch,
        // restart, depth gap) the REST snapshot covers only the levels near
        // price; a far wall adopted from a backfill stays unknown until a
        // diff mentions its price. Hold it meanwhile, but not forever: an
        // order cancelled while we were not listening never gets a diff.
        let known = false;
        for (let row = level.row; row < level.row + level.span && !known; row += 1) known = totals.has(row);
        if (!known) {
          level.unknownSince ??= ts;
          if (ts - level.unknownSince < UNKNOWN_HOLD_MS) continue;
        }
        // Its rows are empty. The trades that emptied them may still be on
        // their way, so remember when it left and judge it after the settle.
        if (level.leftTs === null) {
          level.leftTs = ts;
          if (remaining !== level.size) {
            level.size = remaining;
            changed = true;
          }
        }
        if (ts - level.leftTs < settleMs) continue;
        endLevel(id, level, level.leftTs, remaining, totals, midRow);
      }
      // New walls.
      for (const cluster of clusters) {
        if (claimed.has(cluster)) continue;
        const level = {
          id: nextId, side, row: cluster.row, span: cluster.span, startTs: ts, endTs: null, size: cluster.total, peak: cluster.total,
          endedBy: null, threshold: entry, referenceAtStart: reference, baseline: new Map(), unknownSince: null,
          reachedTs: reachedBy({ side, row: cluster.row, span: cluster.span }, midRow) ? ts : null, chain: 0, // the last time price was at it
          leftTs: null, tradedSeen: 0, lastTradeTs: null, fill: 0, absorbing: false,
        };
        active.set(nextId, level);
        nextId += 1;
        relinkBackward(level, ts);
        changed = true;
      }
      // Walls of this side whose rows touch (within the bridging gap) are one
      // wall whatever state they are in: an older wall holding on with thin
      // rows and a fresh cluster right beside it must not draw as two bars.
      mergeAdjacent(side, values, column);
      for (const [, level] of active) {
        if (level.side !== side) continue;
        const now = volumeSince(level, totals);
        if (now.traded > level.tradedSeen) {
          level.tradedSeen = now.traded;
          level.lastTradeTs = ts;
        }
        const left = now.traded + now.cancelled;
        const fill = round2(left > 0 ? now.traded / left : 0);
        if (fill !== level.fill) {
          level.fill = fill;
          changed = true;
        }
        // Being hit and still standing: trades landed on its rows within the
        // window and it holds most of its peak.
        const absorbing = level.leftTs === null && level.lastTradeTs !== null && ts - level.lastTradeTs <= ABSORB_WINDOW_MS && level.size >= level.peak * ABSORB_HOLD_SHARE;
        if (absorbing !== level.absorbing) {
          level.absorbing = absorbing;
          changed = true;
        }
      }
    }
    const before = ended.length;
    ended = ended.filter((level) => ts - level.endTs <= keepEndedMs || (ts - level.endTs <= deepKeepEndedMs && worthKeeping(level)));
    ended = trimEnded(ended, maxLevels);
    if (ended.length !== before) changed = true;
    return changed;
  }

  /**
   * At most maxLevels walls, oldest first: every resting wall (largest
   * first when there are too many), then the most recently ended ones.
   */
  function levels({ withId = false } = {}) {
    const resting = [...active.values()].sort((a, b) => b.peak - a.peak).slice(0, maxLevels);
    const room = Math.max(0, maxLevels - resting.length);
    // Verdicts first: a moved segment's successor is on the chart already,
    // so when the list is over the cap those are the first to go.
    const verdicts = ended.filter((level) => level.endedBy !== "moved");
    const moved = ended.filter((level) => level.endedBy === "moved");
    const recent = [...verdicts.slice(Math.max(0, verdicts.length - room)), ...moved.slice(Math.max(0, moved.length - Math.max(0, room - verdicts.length)))];
    return [...resting, ...recent]
      .sort((a, b) => a.startTs - b.startTs)
      .map((level) => Object.freeze({
        side: level.side,
        row: level.row,
        span: level.span,
        startTs: level.startTs,
        endTs: level.endTs,
        size: level.size,
        peak: level.peak,
        endedBy: level.endedBy,
        // How many typical rows this wall is, measured when it qualified.
        ratio: level.referenceAtStart > 0 ? level.peak / level.referenceAtStart : 0,
        // The trace this wall belongs to (the first wall's id), 0 when it never moved.
        chain: level.chain,
        // Of the size that has left it so far, the share that traded rather than being cancelled.
        fill: round2(level.fill),
        // Of the most it ever held, the share that has traded on its rows: what a
        // trader means by how much of the wall was eaten.
        eaten: round2(eatenShare(level)),
        // Resting, being traded into, and still holding most of its peak.
        absorbing: level.absorbing,
        ...(withId ? { id: level.id } : {}),
      }));
  }

  function entries() {
    const out = [];
    for (const level of active.values()) out.push(Object.freeze({ id: level.id, side: level.side, row: level.row, span: level.span, startTs: level.startTs, endTs: null, endedBy: null, size: level.size, peak: level.peak }));
    for (const level of ended) out.push(Object.freeze({ id: level.id, side: level.side, row: level.row, span: level.span, startTs: level.startTs, endTs: level.endTs, endedBy: level.endedBy, size: level.size, peak: level.peak }));
    return out;
  }

  /**
   * Take on walls measured elsewhere (a backfill worker replaying the
   * collector's recording), so they keep their real start times instead of
   * looking new. Resting walls get their traded/cancelled baseline from the
   * first live column that touches them; ended ones are kept as history.
   */
  function adopt(levels) {
    if (!Array.isArray(levels)) throw new Error("large-level-tracker: adopt expects an array of levels");
    // The other tracker numbered its chains from 1 too: shift them past our
    // ids so a trace adopted from the recording never collides with a live one.
    const base = nextId;
    let maxChain = 0;
    const records = [];
    for (const level of levels) {
      if (level.side !== "bid" && level.side !== "ask") throw new Error("large-level-tracker: adopted level needs a side");
      const chain = Number.isSafeInteger(level.chain) && level.chain > 0 ? level.chain : 0;
      if (chain > maxChain) maxChain = chain;
      const record = {
        id: 0,
        chain: chain > 0 ? base + chain : 0,
        reachedTs: null,
        side: level.side,
        row: level.row,
        span: level.span ?? 1,
        startTs: level.startTs,
        endTs: level.endTs ?? null,
        size: level.size,
        peak: Math.max(level.peak ?? level.size, level.size),
        endedBy: level.endedBy ?? null,
        threshold: level.threshold ?? threshold(),
        referenceAtStart: level.referenceAtStart ?? (level.ratio > 0 && level.peak > 0 ? level.peak / level.ratio : reference),
        baseline: new Map(),
        baselinePending: true,
        leftTs: null,
        // What it had already given to trades, so a wall out of the store or a
        // backfill does not come back looking untouched.
        tradedSeen: Number.isFinite(level.eaten) && level.eaten > 0 ? level.eaten * Math.max(level.peak ?? 0, level.size ?? 0) : 0,
        lastTradeTs: null,
        fill: Number.isFinite(level.fill) && level.fill >= 0 && level.fill <= 1 ? level.fill : 0,
        absorbing: false,
        unknownSince: null,
      };
      records.push(record);
    }
    nextId = base + maxChain + 1;
    const ids = [];
    for (const record of records) {
      record.id = nextId;
      ids.push(nextId);
      nextId += 1;
      if (record.endedBy) ended.push(record);
      else active.set(record.id, record);
    }
    ended.sort((a, b) => a.endTs - b.endTs);
    ended = trimEnded(ended, maxLevels);
    changed = true;
    dirty = true;
    return ids;
  }

  /**
   * Walls still standing when a replayed window ended (`endTs` null) are the
   * same orders as the walls born at that window's end: the next window, or
   * the live tracker, saw them from its first column and dated them there.
   * Each one hands its birth, its peak and what had already traded into it
   * to the wall on its side and rows born within `toleranceMs` of `until`,
   * standing or ended. A wall no window continues is dropped, never invented.
   */
  function extend(standing, { until, toleranceMs } = {}) {
    if (!Array.isArray(standing)) throw new Error("large-level-tracker: extend expects an array of standing walls");
    if (!Number.isSafeInteger(until) || until < 0) throw new Error("large-level-tracker: extend needs the window's end as until");
    if (!Number.isSafeInteger(toleranceMs) || toleranceMs < 0) throw new Error("large-level-tracker: toleranceMs must be a non-negative safe integer");
    const extended = [];
    for (const candidate of standing) {
      if (candidate.side !== "bid" && candidate.side !== "ask") throw new Error("large-level-tracker: a standing wall needs a side");
      if (!Number.isSafeInteger(candidate.startTs)) throw new Error("large-level-tracker: a standing wall needs a startTs");
      let best = null;
      for (const level of [...active.values(), ...ended]) {
        if (level.side !== candidate.side || !overlaps(level, candidate) || level.startTs <= candidate.startTs) continue;
        if (Math.abs(level.startTs - until) > toleranceMs) continue;
        if (best === null || Math.abs(level.startTs - until) < Math.abs(best.startTs - until)) best = level;
      }
      if (best === null) continue;
      const from = best.startTs;
      const peak = Math.max(candidate.peak ?? 0, candidate.size ?? 0);
      best.startTs = candidate.startTs;
      if (peak > best.peak) best.peak = peak;
      if (Number.isFinite(candidate.eaten) && candidate.eaten > 0) best.tradedSeen += candidate.eaten * peak;
      extended.push(Object.freeze({ id: best.id, from, startTs: best.startTs }));
      dirty = true;
    }
    return extended;
  }

  function clear() {
    active.clear();
    ended = [];
    reference = 0;
  }

  function invalidateObservedRow({ side, row }) {
    if ((side !== "bid" && side !== "ask") || !Number.isSafeInteger(row)) {
      throw new Error("large-level-tracker: invalid observed row");
    }
    const removed = [];
    for (const [id, level] of active) {
      if (level.side !== side || row < level.row || row >= level.row + level.span) continue;
      active.delete(id);
      removed.push(Object.freeze({ id, side, row: level.row, span: level.span, startTs: level.startTs }));
    }
    if (removed.length) dirty = true;
    return Object.freeze(removed);
  }

  return Object.freeze({
    update,
    levels,
    entries,
    adopt,
    extend,
    clear,
    invalidateObservedRow,
    threshold,
    get minSize() {
      return minSize;
    },
    get reference() {
      return reference;
    },
    get activeCount() {
      return active.size;
    },
  });
}

module.exports = {
  createLargeLevelTracker,
  columnPercentile,
  clustersOf,
  evictionRank,
  DEFAULT_KEEP_ENDED_MS,
  DEFAULT_MAX_LEVELS,
  DEFAULT_MULTIPLIER,
  DEFAULT_GAP_ROWS,
  END_RATIO,
  EATEN_SHARE,
  UNKNOWN_HOLD_MS,
  RELINK_MS,
  RELINK_ROWS,
  RELINK_SIZE_TOLERANCE,
  DEEP_MIN_LIFE_MS,
  FILLED_SHARE,
  DEFAULT_SETTLE_MS,
  ABSORB_WINDOW_MS,
  ABSORB_HOLD_SHARE,
  HIT_WINDOW_MS,
};
