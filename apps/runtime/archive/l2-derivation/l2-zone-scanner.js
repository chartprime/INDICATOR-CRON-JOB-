const ZONE_WIDTH_RATIO = 0.0025;
const SCAN_RANGE_RATIO = 0.1;
const QUALIFYING_MEDIAN_MULTIPLIER = 1.2;
const MAX_QUALIFYING_ZONES_PER_SIDE = 35;

function toNumericLevel(level) {
  return [Number(level[0]), Number(level[1])];
}

function bucketSide(levels, zoneWidth, withinRange) {
  const buckets = new Map();
  for (const level of levels) {
    const [price, size] = toNumericLevel(level);
    if (!withinRange(price)) continue;
    const bucketIndex = Math.floor(price / zoneWidth);
    buckets.set(bucketIndex, (buckets.get(bucketIndex) ?? 0) + size);
  }
  return buckets;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function qualifyingZones(buckets, zoneWidth) {
  const threshold = median([...buckets.values()]) * QUALIFYING_MEDIAN_MULTIPLIER;
  return [...buckets.entries()]
    .filter(([, size]) => size >= threshold)
    .map(([bucketIndex, size]) => ({ priceBand: bucketIndex * zoneWidth, size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, MAX_QUALIFYING_ZONES_PER_SIDE);
}

function sumSizes(buckets) {
  let total = 0;
  for (const size of buckets.values()) total += size;
  return total;
}

function scanZones(book) {
  const bids = book?.bids;
  const asks = book?.asks;
  if (!bids?.length || !asks?.length) return null;

  const bestBid = Number(bids[0][0]);
  const bestAsk = Number(asks[0][0]);
  const mid = (bestBid + bestAsk) / 2;
  const zoneWidth = mid * ZONE_WIDTH_RATIO;
  const scanFloor = mid * (1 - SCAN_RANGE_RATIO);
  const scanCeil = mid * (1 + SCAN_RANGE_RATIO);

  const bidBuckets = bucketSide(bids, zoneWidth, (price) => price >= scanFloor);
  const askBuckets = bucketSide(asks, zoneWidth, (price) => price <= scanCeil);

  return {
    bestBid,
    bestAsk,
    spread: bestAsk - bestBid,
    totalBidLiquidity: sumSizes(bidBuckets),
    totalAskLiquidity: sumSizes(askBuckets),
    bidZones: qualifyingZones(bidBuckets, zoneWidth),
    askZones: qualifyingZones(askBuckets, zoneWidth),
  };
}

module.exports = {
  scanZones,
  ZONE_WIDTH_RATIO,
  SCAN_RANGE_RATIO,
  QUALIFYING_MEDIAN_MULTIPLIER,
  MAX_QUALIFYING_ZONES_PER_SIDE,
};
