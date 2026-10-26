const { analyticsStatusFrame } = require("./frames");

// Query availability is separate from transport health and capture completeness.
function createAnalyticsStatusPublisher(broadcast) {
  const frames = new Map();
  function key(identity, indicator) {
    const symbol = identity.provider === "BINANCE" ? identity.symbol.replace("-", "") : identity.symbol;
    return `${identity.provider}:${identity.marketKind ?? identity.assetClass}:${symbol}:${indicator}`;
  }
  return {
    get(identity, indicator) { return frames.get(key(identity, indicator))?.status ?? "IDLE"; },
    set(identity, indicator, status) {
      const id = key(identity, indicator);
      if (frames.get(id)?.status === status) return;
      const frame = analyticsStatusFrame(identity, indicator, status);
      frames.set(id, frame);
      broadcast(frame);
    },
    replay(identity, send) {
      for (const indicator of ["PROFILE", "VPIN"]) {
        const frame = frames.get(key(identity, indicator));
        if (frame) send(frame);
      }
    },
    clear() { frames.clear(); },
  };
}

module.exports = { createAnalyticsStatusPublisher };
