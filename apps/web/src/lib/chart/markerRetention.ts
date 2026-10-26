import type { MarkerFrame } from "../../types/frames";
import { markerMagnitude, type WhaleTradeStat } from "../indicators/whale-detector/whaleTrades";

export const DEFAULT_MARKER_COVERAGE_BUCKET_MS = 60_000;
export const DEFAULT_MAX_MARKERS_PER_BUCKET_SIDE = 4;
const HEAP_COMPACTION_RATIO = 4;

function lowerMagnitudePriority(candidate: MarkerFrame, incumbent: MarkerFrame): boolean {
  const candidateMagnitude = markerMagnitude(candidate);
  const incumbentMagnitude = markerMagnitude(incumbent);
  if (candidateMagnitude !== incumbentMagnitude) return candidateMagnitude < incumbentMagnitude;
  if (candidate.ts_exchange !== incumbent.ts_exchange) return candidate.ts_exchange < incumbent.ts_exchange;
  return candidate.trade_id < incumbent.trade_id;
}

function olderFirst(candidate: MarkerFrame, incumbent: MarkerFrame): boolean {
  return candidate.ts_exchange !== incumbent.ts_exchange
    ? candidate.ts_exchange < incumbent.ts_exchange
    : candidate.trade_id < incumbent.trade_id;
}

function snapshotOrder(a: MarkerFrame, b: MarkerFrame): number {
  return a.ts_exchange - b.ts_exchange || (a.trade_id < b.trade_id ? -1 : a.trade_id > b.trade_id ? 1 : 0);
}

function higherMagnitudeFirst(candidate: MarkerFrame, incumbent: MarkerFrame): boolean {
  return lowerMagnitudePriority(incumbent, candidate);
}

function statOrder(left: WhaleTradeStat, right: WhaleTradeStat): number {
  return snapshotOrder(left.marker, right.marker);
}

type LowerThan = (candidate: MarkerFrame, incumbent: MarkerFrame) => boolean;

function heapSwap(heap: MarkerFrame[], left: number, right: number): void {
  const tmp = heap[left];
  heap[left] = heap[right];
  heap[right] = tmp;
}

function heapPush(heap: MarkerFrame[], value: MarkerFrame, lower: LowerThan): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (!lower(heap[index], heap[parent])) break;
    heapSwap(heap, index, parent);
    index = parent;
  }
}

function heapSiftDown(heap: MarkerFrame[], index: number, lower: LowerThan): void {
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let lowest = index;
    if (left < heap.length && lower(heap[left], heap[lowest])) lowest = left;
    if (right < heap.length && lower(heap[right], heap[lowest])) lowest = right;
    if (lowest === index) return;
    heapSwap(heap, index, lowest);
    index = lowest;
  }
}

function heapPopRoot(heap: MarkerFrame[], lower: LowerThan): MarkerFrame | undefined {
  const root = heap[0];
  const last = heap.pop();
  if (heap.length > 0 && last !== undefined) {
    heap[0] = last;
    heapSiftDown(heap, 0, lower);
  }
  return root;
}

export interface TopMagnitudeSelection {
  stats: WhaleTradeStat[];
  resolvedThreshold: number | null;
}

export interface MarkerSelectionView {
  readonly version: number;
  size(): number;
  snapshot(): MarkerFrame[];
  topByMagnitude(limit: number): TopMagnitudeSelection;
  atLeastMagnitude(minMagnitude: number, maxMagnitude?: number | null): WhaleTradeStat[];
}

export interface MarkerRetentionBuffer extends MarkerSelectionView {
  insertAll(markers: readonly MarkerFrame[]): boolean;
}

export function createTimeCoveredMarkerRetentionBuffer(
  maxMarkers: number,
  bucketMs: number = DEFAULT_MARKER_COVERAGE_BUCKET_MS,
  maxPerBucketSide: number = DEFAULT_MAX_MARKERS_PER_BUCKET_SIDE,
): MarkerRetentionBuffer {
  if (!Number.isInteger(maxMarkers) || maxMarkers <= 0) {
    throw new Error("createTimeCoveredMarkerRetentionBuffer: maxMarkers must be a positive integer");
  }
  if (!Number.isSafeInteger(bucketMs) || bucketMs <= 0) {
    throw new Error("createTimeCoveredMarkerRetentionBuffer: bucketMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxPerBucketSide) || maxPerBucketSide <= 0) {
    throw new Error("createTimeCoveredMarkerRetentionBuffer: maxPerBucketSide must be a positive safe integer");
  }

  const byId = new Map<string, MarkerFrame>();
  const idsByBucketSide = new Map<string, Set<string>>();
  let timeHeap: MarkerFrame[] = [];
  let magnitudeHeap: MarkerFrame[] = [];
  let version = 0;

  function bucketKey(marker: MarkerFrame): string {
    return `${Math.floor(marker.ts_exchange / bucketMs)}:${marker.side}`;
  }

  function removeFromBucket(marker: MarkerFrame): void {
    byId.delete(marker.trade_id);
    const key = bucketKey(marker);
    const ids = idsByBucketSide.get(key);
    if (!ids) return;
    ids.delete(marker.trade_id);
    if (ids.size === 0) idsByBucketSide.delete(key);
  }

  function popOldestLive(): MarkerFrame | null {
    let popped = heapPopRoot(timeHeap, olderFirst);
    while (popped !== undefined) {
      if (byId.get(popped.trade_id) === popped) return popped;
      popped = heapPopRoot(timeHeap, olderFirst);
    }
    return null;
  }

  function compactTimeHeapIfNeeded(): void {
    if (timeHeap.length <= HEAP_COMPACTION_RATIO * maxMarkers) return;
    const rebuilt: MarkerFrame[] = [];
    for (const marker of byId.values()) heapPush(rebuilt, marker, olderFirst);
    timeHeap = rebuilt;
  }

  function compactMagnitudeHeapIfNeeded(): void {
    if (magnitudeHeap.length <= HEAP_COMPACTION_RATIO * Math.max(byId.size, 1)) return;
    const rebuilt: MarkerFrame[] = [];
    for (const marker of byId.values()) heapPush(rebuilt, marker, higherMagnitudeFirst);
    magnitudeHeap = rebuilt;
  }

  function topByMagnitude(limit: number): TopMagnitudeSelection {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error("createTimeCoveredMarkerRetentionBuffer: topByMagnitude limit must be a non-negative safe integer");
    }
    const taken: MarkerFrame[] = [];
    while (taken.length < limit) {
      const root = heapPopRoot(magnitudeHeap, higherMagnitudeFirst);
      if (root === undefined) break;
      if (byId.get(root.trade_id) === root) taken.push(root);
    }
    for (const marker of taken) heapPush(magnitudeHeap, marker, higherMagnitudeFirst);
    const stats = taken.map((marker) => ({ marker, magnitude: markerMagnitude(marker) }));
    const resolvedThreshold = stats.length === 0 ? null : stats[stats.length - 1].magnitude;
    stats.sort(statOrder);
    return { stats, resolvedThreshold };
  }

  function atLeastMagnitude(minMagnitude: number, maxMagnitude: number | null = null): WhaleTradeStat[] {
    if (!Number.isFinite(minMagnitude) || minMagnitude <= 0) {
      throw new Error("createTimeCoveredMarkerRetentionBuffer: atLeastMagnitude minMagnitude must be a positive finite number");
    }
    if (maxMagnitude !== null && (!Number.isFinite(maxMagnitude) || maxMagnitude < minMagnitude)) {
      throw new Error("createTimeCoveredMarkerRetentionBuffer: atLeastMagnitude maxMagnitude must be a finite number no smaller than minMagnitude");
    }
    const stats: WhaleTradeStat[] = [];
    const pending = magnitudeHeap.length === 0 ? [] : [0];
    while (pending.length > 0) {
      const index = pending.pop()!;
      const marker = magnitudeHeap[index];
      const magnitude = markerMagnitude(marker);
      // This is a max-heap. Once a node is below the floor, every descendant
      // is below it too, so the entire branch can be skipped. Lazy-deleted
      // nodes still participate in that ordering but are never returned.
      if (magnitude < minMagnitude) continue;
      if (byId.get(marker.trade_id) === marker && (maxMagnitude === null || magnitude <= maxMagnitude)) {
        stats.push({ marker, magnitude });
      }
      const left = index * 2 + 1;
      if (left < magnitudeHeap.length) pending.push(left);
      const right = left + 1;
      if (right < magnitudeHeap.length) pending.push(right);
    }
    stats.sort(statOrder);
    return stats;
  }

  function insertOne(marker: MarkerFrame): boolean {
    if (byId.has(marker.trade_id)) return false;
    const key = bucketKey(marker);
    const ids = idsByBucketSide.get(key) ?? new Set<string>();
    if (ids.size >= maxPerBucketSide) {
      let lowest: MarkerFrame | null = null;
      for (const id of ids) {
        const existing = byId.get(id);
        if (existing && (lowest === null || lowerMagnitudePriority(existing, lowest))) lowest = existing;
      }
      if (lowest !== null && lowerMagnitudePriority(marker, lowest)) return false;
      if (lowest !== null) removeFromBucket(lowest);
    }
    byId.set(marker.trade_id, marker);
    const nextIds = idsByBucketSide.get(key) ?? new Set<string>();
    nextIds.add(marker.trade_id);
    idsByBucketSide.set(key, nextIds);
    heapPush(timeHeap, marker, olderFirst);
    heapPush(magnitudeHeap, marker, higherMagnitudeFirst);
    if (byId.size > maxMarkers) {
      const oldest = popOldestLive();
      if (oldest !== null) removeFromBucket(oldest);
    }
    compactTimeHeapIfNeeded();
    compactMagnitudeHeapIfNeeded();
    return true;
  }

  return {
    get version() { return version; },
    size() { return byId.size; },
    insertAll(markers) {
      let changed = false;
      for (const marker of markers) if (insertOne(marker)) changed = true;
      if (changed) version += 1;
      return changed;
    },
    snapshot() {
      return [...byId.values()].sort(snapshotOrder);
    },
    topByMagnitude,
    atLeastMagnitude,
  };
}

export function retainTimeCoveredMarkers(
  markers: readonly MarkerFrame[],
  maxMarkers: number,
  bucketMs: number = DEFAULT_MARKER_COVERAGE_BUCKET_MS,
  maxPerBucketSide: number = DEFAULT_MAX_MARKERS_PER_BUCKET_SIDE,
): MarkerFrame[] {
  const buffer = createTimeCoveredMarkerRetentionBuffer(maxMarkers, bucketMs, maxPerBucketSide);
  buffer.insertAll(markers);
  return buffer.snapshot();
}
