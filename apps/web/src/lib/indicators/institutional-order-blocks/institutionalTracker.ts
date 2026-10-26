import type { IndicatorLiquidity } from "../../chart/indicatorLiquidity";
import {
  BAND_MAX_ROWS,
  bandColumnMsFor,
  bandKeyOf,
  type BandHistoryGap,
  type BandHistoryWant,
  type IndicatorBandHistory,
} from "../../chart/bandHistory";
import {
  type OrderBlock,
} from "../classic-order-blocks/orderBlockRules";
import {
  advanceOrderBlocks,
  createOrderBlockTrackerState,
  type OrderBlockTrackerState,
  type PivotInputs,
  type TrackedBar,
} from "../classic-order-blocks/orderBlockTracker";
import type { ColumnFeed } from "../absorption-detector/absorptionColumns";
import {
  createZoneRead,
  holeFilled,
  oldestWallColumnTs,
  readZone,
  type EvidenceZone,
  type RecordingGap,
  type UnverifiableReason,
  type ZoneRead,
} from "./bookEvidence";
import {
  verdictOf,
  zoneRows,
  type BookEvidence,
  type Thresholds,
  type Verdict,
} from "./institutionalRules";

export type BookReader = Pick<IndicatorLiquidity, "feed" | "rowWidth">;

export interface BookInput {
  reader: BookReader;
  flashMs: number;
  barMs: number;
  bands?: IndicatorBandHistory | null;
  /** The reader's columns end at the depth the source observed (historical top of book). */
  edgeUnknown?: boolean;
}

export interface InstitutionalBlock {
  block: OrderBlock;
  verdict: Verdict;
  evidence: BookEvidence | null;
  reason: UnverifiableReason | null;
  gap: RecordingGap | null;
  read: ZoneRead;
  readAt: number;
  rowWidth: number;
  oldest: number;
  want: BandHistoryWant | null;
  historical: boolean;
  gaps: readonly BandHistoryGap[];
}

export interface InstitutionalTrackerState {
  classic: OrderBlockTrackerState;
  graded: Map<OrderBlock, InstitutionalBlock>;
  blocks: InstitutionalBlock[];
  reads: number;
}

export function createInstitutionalTrackerState(
  options: { keepStack?: boolean; maxBars?: number; maxBlocks?: number } = {},
): InstitutionalTrackerState {
  return {
    classic: createOrderBlockTrackerState(options),
    graded: new Map(),
    blocks: [],
    reads: 0,
  };
}

function fresh(block: OrderBlock): InstitutionalBlock {
  return {
    block,
    verdict: "unverifiable",
    evidence: null,
    reason: "feed",
    gap: null,
    read: createZoneRead(),
    readAt: NaN,
    rowWidth: NaN,
    oldest: NaN,
    want: null,
    historical: false,
    gaps: [],
  };
}

function startOver(entry: InstitutionalBlock): void {
  entry.read = createZoneRead();
  entry.reason = "feed";
  entry.gap = null;
}

function zoneOf(block: OrderBlock): EvidenceZone {
  return {
    side: block.side,
    top: block.top,
    bottom: block.bottom,
    pivotTime: block.pivotTime,
    baseTime: block.baseTime,
    breakTime: block.breakTime,
  };
}

function wantFor(block: OrderBlock, book: BookInput): BandHistoryWant | null {
  const rows = zoneRows(block.top, block.bottom, book.reader.rowWidth);
  if (rows === null || rows.rowHi - rows.rowLo + 1 > BAND_MAX_ROWS) return null;
  const fromTs = block.pivotTime - book.flashMs;
  const toTs = block.breakTime + book.barMs;
  return {
    key: bandKeyOf(fromTs, toTs, block.bottom, block.top),
    fromTs,
    toTs,
    priceLo: block.bottom,
    priceHi: block.top,
    columnMs: bandColumnMsFor(rows.rowHi - rows.rowLo + 1),
  };
}

export function bandWantsOf(state: InstitutionalTrackerState): BandHistoryWant[] {
  const wants: BandHistoryWant[] = [];
  for (const entry of state.blocks) if (entry.want !== null) wants.push(entry.want);
  return wants;
}

function gradeFromRecording(
  state: InstitutionalTrackerState,
  entry: InstitutionalBlock,
  want: BandHistoryWant,
  book: BookInput,
  bar: TrackedBar,
  oldest: number,
  thresholds: Thresholds,
): boolean {
  const answer = book.bands?.feedFor(want.key) ?? null;
  if (answer === null) return false;
  const read = createZoneRead();
  const result = readZone(
    read,
    { feed: recordedOnly(answer.feed, answer.gaps), rowWidth: answer.rowWidth },
    zoneOf(entry.block),
    book.barMs,
    want.toTs,
    { wall: thresholds.wall, bandRows: thresholds.bandRows, flashMs: book.flashMs, partial: true },
  );
  state.reads += 1;
  if (result.kind !== "evidence") {
    if (result.reason !== "before" || answer.gaps.length === 0) return false;
    entry.readAt = bar.time;
    entry.rowWidth = answer.rowWidth;
    entry.oldest = oldest;
    entry.evidence = null;
    entry.reason = "hole";
    entry.gap = answer.gaps.reduce((widest, gap) => (gap.to - gap.from > widest.to - widest.from ? gap : widest));
    entry.verdict = "unverifiable";
    entry.historical = true;
    entry.gaps = answer.gaps;
    return true;
  }
  entry.read = read;
  entry.readAt = bar.time;
  entry.rowWidth = answer.rowWidth;
  entry.oldest = oldest;
  entry.historical = true;
  entry.gaps = answer.gaps;
  settle(entry, result.evidence, result.missing, thresholds);
  return true;
}

/**
 * A recording gap can confirm a zone, never reject it: a zone the book reads as Rejected while part of its window
 * was not recorded stays Unverified and names that stretch, since a wall that stood through the gap reads the same.
 */
function settle(entry: InstitutionalBlock, evidence: BookEvidence, missing: RecordingGap | null, thresholds: Thresholds): void {
  const verdict = verdictOf(evidence, thresholds);
  if (verdict === "rejected" && missing !== null) {
    entry.evidence = null;
    entry.reason = "gap";
    entry.gap = missing;
    entry.verdict = "unverifiable";
    return;
  }
  entry.evidence = evidence;
  entry.reason = null;
  entry.gap = entry.historical ? null : missing;
  entry.verdict = verdict;
}

function recordedOnly(feed: ColumnFeed, gaps: readonly BandHistoryGap[]): ColumnFeed {
  if (gaps.length === 0) return feed;
  const recorded = feed.fine.columns.filter((column) => !gaps.some((gap) => column.ts > gap.from && column.ts <= gap.to));
  return { epoch: feed.epoch, deep: null, fine: { columns: recorded, columnMs: feed.fine.columnMs } };
}

function wantsRead(
  entry: InstitutionalBlock,
  barTime: number,
  barMs: number,
): boolean {
  switch (entry.reason) {
    case null:
    case "gap":
      return (
        entry.block.mitigatedTime === null && barTime - entry.readAt >= barMs
      );
    case "feed":
    case "after":
      return true;
    default:
      return false;
  }
}

function grade(
  state: InstitutionalTrackerState,
  entry: InstitutionalBlock,
  book: BookInput,
  bar: TrackedBar,
  oldest: number,
  thresholds: Thresholds,
): void {
  const { block } = entry;
  const read = readZone(
    entry.read,
    { feed: book.reader.feed, rowWidth: book.reader.rowWidth },
    zoneOf(block),
    book.barMs,
    bar.time + book.barMs,
    { wall: thresholds.wall, bandRows: thresholds.bandRows, flashMs: book.flashMs, edgeUnknown: book.edgeUnknown === true, partial: entry.historical },
  );
  state.reads += 1;
  entry.readAt = bar.time;
  entry.rowWidth = book.reader.rowWidth;
  entry.oldest = oldest;
  if (read.kind === "evidence") {
    settle(entry, read.evidence, read.missing, thresholds);
    if (!entry.historical) entry.want = read.missing === null ? null : entry.want ?? wantFor(block, book);
    return;
  }
  entry.evidence = null;
  entry.reason = read.reason;
  entry.gap = read.gap ?? null;
  entry.verdict = "unverifiable";
  if ((read.reason === "before" || read.reason === "hole") && entry.want === null) entry.want = wantFor(block, book);
}

export function advanceInstitutional(
  state: InstitutionalTrackerState,
  bar: TrackedBar,
  pivots: PivotInputs,
  width: number | null,
  rightBars: number,
  book: BookInput | null,
  thresholds: Thresholds,
): void {
  advanceOrderBlocks(state.classic, bar, pivots, width, rightBars);
  const retained = new Set([...state.classic.activeBlocks, ...state.classic.mitigatedBlocks]);
  for (const block of state.graded.keys())
    if (!retained.has(block)) state.graded.delete(block);

  const feed = book === null ? null : book.reader.feed;
  const oldest = feed === null ? Infinity : oldestWallColumnTs(feed);
  state.blocks = [...state.classic.mitigatedBlocks, ...state.classic.activeBlocks].map((block) => {
    let entry = state.graded.get(block);
    if (entry === undefined) {
      entry = fresh(block);
      state.graded.set(block, entry);
    }
    if (
      book !== null &&
      entry.want !== null &&
      !entry.historical &&
      gradeFromRecording(state, entry, entry.want, book, bar, oldest, thresholds)
    )
      return entry;
    if (
      book !== null &&
      entry.want !== null &&
      entry.reason === "before" &&
      book.bands?.older(entry.want.key) === true
    )
      entry.reason = "older";
    if (block.mitigatedTime !== null) return entry;
    if (book === null || feed === null) return entry;
    if (entry.historical && entry.rowWidth !== book.reader.rowWidth) return entry;
    if (
      !Number.isNaN(entry.rowWidth) &&
      entry.rowWidth !== book.reader.rowWidth
    )
      startOver(entry);
    else if (
      (entry.reason === "before" || entry.reason === "older") &&
      oldest < entry.oldest
    )
      startOver(entry);
    else if (
      entry.gap !== null &&
      holeFilled(feed, entry.gap)
    )
      startOver(entry);
    if (wantsRead(entry, bar.time, book.barMs))
      grade(state, entry, book, bar, oldest, thresholds);
    return entry;
  });
}
