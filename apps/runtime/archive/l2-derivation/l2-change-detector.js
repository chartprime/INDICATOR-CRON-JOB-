const CHANGE_RATIO_THRESHOLD = 0.3;

function labelFor(prevSize, currSize) {
  if (prevSize === undefined) return "APPEARED";
  if (currSize === undefined) return "DISAPPEARED";
  return currSize >= prevSize ? "GREW" : "SHRANK";
}

function diffSide(prevZones, currZones) {
  const prevByBand = new Map(prevZones.map((zone) => [zone.priceBand, zone.size]));
  const currByBand = new Map(currZones.map((zone) => [zone.priceBand, zone.size]));
  const allBands = new Set([...prevByBand.keys(), ...currByBand.keys()]);

  const events = [];
  for (const band of allBands) {
    const prevSize = prevByBand.get(band);
    const currSize = currByBand.get(band);
    if (prevSize === undefined || currSize === undefined) {
      events.push({ priceBand: band, sizeBefore: prevSize ?? null, sizeAfter: currSize ?? null, label: labelFor(prevSize, currSize) });
      continue;
    }
    const changeRatio = Math.abs(currSize - prevSize) / prevSize;
    if (changeRatio >= CHANGE_RATIO_THRESHOLD) {
      events.push({ priceBand: band, sizeBefore: prevSize, sizeAfter: currSize, label: labelFor(prevSize, currSize) });
    }
  }
  return events;
}

function detectChanges(previousScan, currentScan) {
  if (!currentScan) return [];
  const prevBidZones = previousScan?.bidZones ?? [];
  const prevAskZones = previousScan?.askZones ?? [];
  const bidEvents = diffSide(prevBidZones, currentScan.bidZones).map((event) => ({ ...event, side: "bid" }));
  const askEvents = diffSide(prevAskZones, currentScan.askZones).map((event) => ({ ...event, side: "ask" }));
  return [...bidEvents, ...askEvents];
}

module.exports = { detectChanges, CHANGE_RATIO_THRESHOLD };
