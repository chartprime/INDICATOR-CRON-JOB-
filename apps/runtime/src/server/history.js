const DEFAULT_MAX_BARS = 10_080;
const DEFAULT_MAX_TRADES = 100;
const DEFAULT_MAX_SEEN_TRADE_IDS = 5_000;
const DEFAULT_MAX_MARKERS = 100_000;
const {
  markerMagnitude,
  lowerMagnitudePriority,
} = require("../indicators/large-trade/large-trade-detection");

function olderFirst(candidate, incumbent) {
  return candidate.ts_exchange !== incumbent.ts_exchange
    ? candidate.ts_exchange < incumbent.ts_exchange
    : candidate.trade_id < incumbent.trade_id;
}

const HEAP_COMPACTION_RATIO = 4;

function swap(heap, left, right) {
  [heap[left], heap[right]] = [heap[right], heap[left]];
}

function heapPush(heap, value, lower) {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (!lower(heap[index], heap[parent])) break;
    swap(heap, index, parent);
    index = parent;
  }
}

function heapSiftDown(heap, index, lower) {
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let lowest = index;
    if (left < heap.length && lower(heap[left], heap[lowest])) lowest = left;
    if (right < heap.length && lower(heap[right], heap[lowest])) lowest = right;
    if (lowest === index) return;
    swap(heap, index, lowest);
    index = lowest;
  }
}

function heapReplaceRoot(heap, value, lower) {
  heap[0] = value;
  heapSiftDown(heap, 0, lower);
}

function heapPopRoot(heap, lower) {
  const root = heap[0];
  const last = heap.pop();
  if (heap.length > 0 && last !== undefined) {
    heap[0] = last;
    heapSiftDown(heap, 0, lower);
  }
  return root;
}

function createHistoryBuffer({
  maxBars = DEFAULT_MAX_BARS,
  maxTrades = DEFAULT_MAX_TRADES,
  maxSeenTradeIds = DEFAULT_MAX_SEEN_TRADE_IDS,
  maxMarkers = DEFAULT_MAX_MARKERS,
  markerBucketMs = null,
  maxMarkersPerBucketSide = null,
  markerMaxAgeMs = null,
} = {}) {
  if (!Number.isInteger(maxBars) || maxBars <= 0) {
    throw new Error("createHistoryBuffer: maxBars must be a positive integer");
  }
  if (!Number.isInteger(maxTrades) || maxTrades <= 0) {
    throw new Error("createHistoryBuffer: maxTrades must be a positive integer");
  }
  if (!Number.isInteger(maxSeenTradeIds) || maxSeenTradeIds < maxTrades) {
    throw new Error("createHistoryBuffer: maxSeenTradeIds must be an integer greater than or equal to maxTrades");
  }
  if (!Number.isInteger(maxMarkers) || maxMarkers <= 0) {
    throw new Error("createHistoryBuffer: maxMarkers must be a positive integer");
  }
  const timeCoveredMarkers = markerBucketMs !== null || maxMarkersPerBucketSide !== null;
  if (timeCoveredMarkers) {
    if (!Number.isSafeInteger(markerBucketMs) || markerBucketMs <= 0) {
      throw new Error("createHistoryBuffer: markerBucketMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxMarkersPerBucketSide) || maxMarkersPerBucketSide <= 0) {
      throw new Error("createHistoryBuffer: maxMarkersPerBucketSide must be a positive safe integer");
    }
  }
  if (markerMaxAgeMs !== null && (!Number.isSafeInteger(markerMaxAgeMs) || markerMaxAgeMs <= 0)) {
    throw new Error("createHistoryBuffer: markerMaxAgeMs must be a positive safe integer");
  }

  const bars = new Map();
  const trades = [];
  const tradeIds = new Set();
  const tradeIdOrder = [];
  let tradeIdOrderHead = 0;
  const markers = new Map();
  const markerMinHeap = [];
  const markerIdsByBucketSide = new Map();
  let markerTimeHeap = [];

  function markerBucketKey(markerFrame) {
    return `${Math.floor(markerFrame.ts_exchange / markerBucketMs)}:${markerFrame.side}`;
  }

  function removeCoveredMarker(markerFrame) {
    markers.delete(markerFrame.trade_id);
    const key = markerBucketKey(markerFrame);
    const ids = markerIdsByBucketSide.get(key);
    if (!ids) return;
    ids.delete(markerFrame.trade_id);
    if (ids.size === 0) markerIdsByBucketSide.delete(key);
  }

  function popOldestLiveCoveredMarker() {
    let popped = heapPopRoot(markerTimeHeap, olderFirst);
    while (popped !== undefined) {
      if (markers.get(popped.trade_id) === popped) return popped;
      popped = heapPopRoot(markerTimeHeap, olderFirst);
    }
    return null;
  }

  function compactMarkerTimeHeap() {
    if (markerTimeHeap.length <= HEAP_COMPACTION_RATIO * maxMarkers) return;
    const rebuilt = [];
    for (const existing of markers.values()) heapPush(rebuilt, existing, olderFirst);
    markerTimeHeap = rebuilt;
  }

  function evictExpiredMarkers(nowMs) {
    const cutoff = nowMs - markerMaxAgeMs;
    while (markerTimeHeap.length > 0) {
      const candidate = markerTimeHeap[0];
      if (markers.get(candidate.trade_id) !== candidate) {
        heapPopRoot(markerTimeHeap, olderFirst);
        continue;
      }
      if (candidate.ts_exchange >= cutoff) break;
      heapPopRoot(markerTimeHeap, olderFirst);
      removeCoveredMarker(candidate);
    }
  }

  function recordTimeCoveredMarker(markerFrame) {
    const key = markerBucketKey(markerFrame);
    const ids = markerIdsByBucketSide.get(key) ?? new Set();
    if (ids.size >= maxMarkersPerBucketSide) {
      let lowest = null;
      for (const id of ids) {
        const existing = markers.get(id);
        if (existing && (lowest === null || lowerMagnitudePriority(existing, lowest))) lowest = existing;
      }
      if (lowest !== null && lowerMagnitudePriority(markerFrame, lowest)) return false;
      if (lowest !== null) removeCoveredMarker(lowest);
    }
    markers.set(markerFrame.trade_id, markerFrame);
    const nextIds = markerIdsByBucketSide.get(key) ?? new Set();
    nextIds.add(markerFrame.trade_id);
    markerIdsByBucketSide.set(key, nextIds);
    heapPush(markerTimeHeap, markerFrame, olderFirst);
    if (markerMaxAgeMs !== null) {
      evictExpiredMarkers(Date.now());
    }
    if (markers.size > maxMarkers) {
      const oldest = popOldestLiveCoveredMarker();
      if (oldest !== null) removeCoveredMarker(oldest);
    }
    compactMarkerTimeHeap();
    return markers.has(markerFrame.trade_id);
  }

  function wouldRetainMarker(tsExchange, side, magnitude) {
    if (!timeCoveredMarkers) return true;
    const ids = markerIdsByBucketSide.get(`${Math.floor(tsExchange / markerBucketMs)}:${side}`);
    if (ids === undefined || ids.size < maxMarkersPerBucketSide) return true;
    for (const id of ids) {
      const existing = markers.get(id);
      if (existing !== undefined && markerMagnitude(existing) <= magnitude) return true;
    }
    return false;
  }

  function recordBar(barFrame) {
    if (barFrame.closed !== true) {
      return;
    }
    if (bars.has(barFrame.ts_open)) {
      bars.delete(barFrame.ts_open);
    }
    bars.set(barFrame.ts_open, barFrame);
    while (bars.size > maxBars) {
      let oldestKey;
      for (const key of bars.keys()) {
        if (oldestKey === undefined || key < oldestKey) {
          oldestKey = key;
        }
      }
      bars.delete(oldestKey);
    }
  }

  function recordTrade(tradeFrame) {
    if (typeof tradeFrame?.trade_id !== "string" || tradeFrame.trade_id.length === 0) {
      throw new Error("recordTrade: trade_id must be a non-empty string");
    }
    if (tradeIds.has(tradeFrame.trade_id)) {
      return false;
    }
    tradeIds.add(tradeFrame.trade_id);
    tradeIdOrder.push(tradeFrame.trade_id);
    trades.push(tradeFrame);
    if (trades.length > maxTrades) {
      trades.shift();
    }
    if (tradeIdOrder.length - tradeIdOrderHead > maxSeenTradeIds) {
      tradeIds.delete(tradeIdOrder[tradeIdOrderHead]);
      tradeIdOrderHead += 1;
      if (tradeIdOrderHead >= 4_096 && tradeIdOrderHead * 2 >= tradeIdOrder.length) {
        tradeIdOrder.splice(0, tradeIdOrderHead);
        tradeIdOrderHead = 0;
      }
    }
    return true;
  }

  function recordMarker(markerFrame) {
    if (typeof markerFrame?.trade_id !== "string" || markerFrame.trade_id.length === 0) {
      throw new Error("recordMarker: trade_id must be a non-empty string");
    }
    if (markers.has(markerFrame.trade_id)) {
      return false;
    }
    const significance = markerMagnitude(markerFrame);
    if (!Number.isFinite(significance) || significance <= 0 || !Number.isSafeInteger(markerFrame.ts_exchange) || markerFrame.ts_exchange < 0) {
      throw new Error("recordMarker: marker significance and timestamp must be finite and positive/non-negative");
    }
    if (timeCoveredMarkers) return recordTimeCoveredMarker(markerFrame);
    if (markers.size >= maxMarkers) {
      const lowestPriority = markerMinHeap[0];
      if (lowerMagnitudePriority(markerFrame, lowestPriority)) return false;
      markers.delete(lowestPriority.trade_id);
      markers.set(markerFrame.trade_id, markerFrame);
      heapReplaceRoot(markerMinHeap, markerFrame, lowerMagnitudePriority);
      return true;
    }
    markers.set(markerFrame.trade_id, markerFrame);
    heapPush(markerMinHeap, markerFrame, lowerMagnitudePriority);
    return true;
  }

  function snapshotBars() {
    return [...bars.values()].sort((a, b) => a.ts_open - b.ts_open);
  }

  function snapshotTrades() {
    return [...trades];
  }

  function snapshotMarkers() {
    return [...markers.values()].sort((a, b) => a.ts_exchange - b.ts_exchange || (a.trade_id < b.trade_id ? -1 : a.trade_id > b.trade_id ? 1 : 0));
  }

  function markerCount() {
    return markers.size;
  }

  return Object.freeze({
    recordBar, recordTrade, recordMarker, wouldRetainMarker, snapshotBars, snapshotTrades, snapshotMarkers, markerCount,
  });
}

module.exports = {
  createHistoryBuffer,
  DEFAULT_MAX_BARS,
  DEFAULT_MAX_TRADES,
  DEFAULT_MAX_SEEN_TRADE_IDS,
  DEFAULT_MAX_MARKERS,
};
