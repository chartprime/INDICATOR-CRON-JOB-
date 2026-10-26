function normalizeDxFeedSide(aggressorSide) {
  if (aggressorSide === "BUY") return "buy";
  if (aggressorSide === "SELL") return "sell";
  return null;
}

function createBinanceVolumeProfileAdapter(storageReader, symbol, marketKind) {
  if (
    !storageReader ||
    typeof storageReader.readVolumeProfile !== "function" ||
    typeof storageReader.readRecentTrades !== "function"
  ) {
    throw new Error(
      "volume-profile-adapters: storageReader must implement readVolumeProfile and readRecentTrades",
    );
  }
  if (typeof symbol !== "string" || symbol.trim().length === 0) {
    throw new Error(
      "volume-profile-adapters: symbol must be a non-empty string",
    );
  }
  if (typeof marketKind !== "string" || marketKind.trim().length === 0) {
    throw new Error(
      "volume-profile-adapters: marketKind must be a non-empty string",
    );
  }
  return Object.freeze({
    prefersDirectHistoricalProfiles: storageReader.remote !== undefined,
    readPriceRange(fromTs, toTs) {
      if (typeof storageReader.readPriceRange !== "function") {
        return Promise.resolve({
          minPrice: null,
          maxPrice: null,
          tradeCount: 0,
          available: false,
        });
      }
      return Promise.resolve(
        storageReader.readPriceRange(symbol, marketKind, { fromTs, toTs }),
      );
    },




    readCandles(options) {
      if (typeof storageReader.readRecentCandles !== "function") {
        return Promise.resolve({ rows: [], available: false });
      }
      return Promise.resolve(
        storageReader.readRecentCandles(symbol, marketKind, options),
      );
    },
    readMinuteRollup(fromTs, toTs, tickSize) {
      if (typeof storageReader.readMinuteRollup !== "function") {
        return Promise.resolve({ rows: [], available: false });
      }
      return Promise.resolve(
        storageReader.readMinuteRollup(symbol, marketKind, {
          fromTs,
          toTs,
          tickSize,
        }),
      );
    },
    readDailyNotional(fromTs, toTs) {
      if (typeof storageReader.readDailyNotional !== "function") {
        return Promise.resolve({ rows: [], available: false });
      }
      return Promise.resolve(
        storageReader.readDailyNotional(symbol, marketKind, { fromTs, toTs }),
      );
    },
    readSlicedNotional(fromTs, toTs, sliceMs) {
      if (typeof storageReader.readSlicedNotional !== "function") {
        return Promise.resolve({ rows: [], available: false });
      }
      return Promise.resolve(
        storageReader.readSlicedNotional(symbol, marketKind, {
          fromTs,
          toTs,
          sliceMs,
        }),
      );
    },
    readVolumeProfile(fromTs, toTs, originPrice, rowWidth) {
      return Promise.resolve(
        storageReader.readVolumeProfile(symbol, marketKind, {
          fromTs,
          toTs,
          originPrice,
          rowWidth,
        }),
      );
    },
    async readTradesSince(fromTs, toTs, cursor, limit) {
      if (
        !Number.isSafeInteger(fromTs) ||
        !Number.isSafeInteger(toTs) ||
        toTs < fromTs
      ) {
        throw new Error(
          "volume-profile-adapters: fromTs/toTs must be safe integers with toTs not before fromTs",
        );
      }
      if (fromTs === toTs)
        return { rows: [], nextCursor: cursor, available: true };
      const scanFromTs =
        cursor === null ? fromTs : Math.max(fromTs, cursor.ts);
      const result = await storageReader.readRecentTrades(symbol, marketKind, {
        // readRecentTrades is inclusive; analytic periods are [fromTs, toTs).
        windowMs: Math.max(0, toTs - scanFromTs - 1),
        nowMs: toTs - 1,
        cursor,
        limit,
      });
      return {
        rows: result.rows.map((row) => ({
          ts: row.ts_exchange,
          tradeId: row.trade_id,
          price: row.price,
          size: row.size,
          side: row.side,
        })),
        nextCursor: result.nextCursor ?? null,
        available: result.available,
      };
    },
  });
}

function createDxFeedVolumeProfileAdapter(
  dxfeedStorageReader,
  symbol,
  assetClass,
) {
  if (
    !dxfeedStorageReader ||
    typeof dxfeedStorageReader.readVolumeProfile !== "function" ||
    typeof dxfeedStorageReader.readTradesSince !== "function"
  ) {
    throw new Error(
      "volume-profile-adapters: dxfeedStorageReader must implement readVolumeProfile and readTradesSince",
    );
  }
  if (typeof symbol !== "string" || symbol.trim().length === 0) {
    throw new Error(
      "volume-profile-adapters: symbol must be a non-empty string",
    );
  }
  if (typeof assetClass !== "string" || assetClass.trim().length === 0) {
    throw new Error(
      "volume-profile-adapters: assetClass must be a non-empty string",
    );
  }
  return Object.freeze({
    prefersDirectHistoricalProfiles: dxfeedStorageReader.remote !== undefined,
    readPriceRange(fromTs, toTs) {
      if (typeof dxfeedStorageReader.readPriceRange !== "function") {
        return Promise.resolve({
          minPrice: null,
          maxPrice: null,
          tradeCount: 0,
          available: false,
        });
      }
      return Promise.resolve(
        dxfeedStorageReader.readPriceRange(symbol, assetClass, {
          fromTs,
          toTs,
        }),
      );
    },
    readDailyNotional(fromTs, toTs) {
      if (typeof dxfeedStorageReader.readDailyNotional !== "function") {
        return Promise.resolve({ rows: [], available: false });
      }
      return Promise.resolve(
        dxfeedStorageReader.readDailyNotional(symbol, assetClass, {
          fromTs,
          toTs,
        }),
      );
    },
    readMinuteRollup(fromTs, toTs, tickSize) {
      if (typeof dxfeedStorageReader.readMinuteRollup !== "function") {
        return Promise.resolve({ rows: [], available: false });
      }
      return Promise.resolve(
        dxfeedStorageReader.readMinuteRollup(symbol, assetClass, {
          fromTs,
          toTs,
          tickSize,
        }),
      );
    },
    readSlicedNotional(fromTs, toTs, sliceMs) {
      if (typeof dxfeedStorageReader.readSlicedNotional !== "function") {
        return Promise.resolve({ rows: [], available: false });
      }
      return Promise.resolve(
        dxfeedStorageReader.readSlicedNotional(symbol, assetClass, {
          fromTs,
          toTs,
          sliceMs,
        }),
      );
    },
    readVolumeProfile(fromTs, toTs, originPrice, rowWidth) {
      return Promise.resolve(
        dxfeedStorageReader.readVolumeProfile(symbol, assetClass, {
          fromTs,
          toTs,
          originPrice,
          rowWidth,
        }),
      );
    },
    async readTradesSince(fromTs, toTs, cursor, limit) {
      const result = await dxfeedStorageReader.readTradesSince(
        symbol,
        assetClass,
        {
          fromTs: cursor === null ? fromTs : Math.max(fromTs, cursor.ts),
          toTs,
          cursor,
          limit,
        },
      );
      return {
        rows: result.rows.map((row) => ({
          ts: row.event_time,
          tradeId: row.provider_trade_id,
          price: row.price,
          size: row.size,
          side: normalizeDxFeedSide(row.aggressor_side),
        })),
        nextCursor: result.nextCursor,
        available: result.available,
      };
    },
  });
}

module.exports = {
  createBinanceVolumeProfileAdapter,
  createDxFeedVolumeProfileAdapter,
};
