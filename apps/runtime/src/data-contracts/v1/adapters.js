"use strict";
const { requireValue, token, integer, timestamp, decimal, compareDecimal, subtractDecimal, fixed9 } = require("./exact");
const { createRecord, quarantine, DERIVED_FAMILIES, DERIVED_INTERVAL_NS } = require("./record");

const DERIVED_SOURCE_PROVIDERS = Object.freeze(["DATABENTO", "BINANCE", "TARDIS"]);
const TARDIS_EXCHANGE_TRADE_PRECISION = Object.freeze({ binance: "us", "binance-futures": "ms" });
const TARDIS_RECEIVE_CLOCK_LAG_LIMIT_NS = 50000000n;

const KLINE_INTERVAL_NS = new Map([
  ["klines-1m", 60000000000n],
  ["klines-1h", 3600000000000n],
  ["klines-1d", 86400000000000n],
]);

const OHLCV_INTERVAL_NS = new Map([
  ["ohlcv-1s", 1000000000n],
  ["ohlcv-1m", 60000000000n],
  ["ohlcv-1h", 3600000000000n],
  ["ohlcv-1d", 86400000000000n],
]);

function mapObservation(provider, family, row, context) {
  return quarantine(() => {
    requireValue(row && typeof row === "object" && !Array.isArray(row), "INVALID_SOURCE_ROW");
    requireValue(context && typeof context.resolveIdentity === "function", "IDENTITY_RESOLVER_REQUIRED");
    requireValue(context.lineage && typeof context.lineage === "object", "LINEAGE_REQUIRED");
    let eventNs, receiveNs = null, precision, origin = "EXCHANGE", sequence = null, ordinal = "0";
    const flags = [];
    const data = [];
    const dec = v => decimal(v);
    const nullableDecimal = v => v === null || v === undefined || v === "" ? null : dec(v);
    const id = v => integer(v);
    const trade = (entityId, price, size, side, action = "NEW", validTick = true) => ({ entityId: token(entityId), price, size, side, action, validTick, replaces: action === "NEW" ? null : entityId });
    const quoteSide = (price, size) => ({ price, size });
    const levels = xs => { requireValue(Array.isArray(xs), "INVALID_SOURCE_LEVELS"); return xs.map(x => { requireValue(Array.isArray(x) && x.length === 2, "INVALID_SOURCE_LEVEL"); return { price: dec(x[0]), size: dec(x[1]) }; }); };
    if (DERIVED_FAMILIES.includes(family)) {
      requireValue(DERIVED_SOURCE_PROVIDERS.includes(provider), "UNSUPPORTED_DERIVED_SOURCE_PROVIDER");
      requireValue(context.schema === `${family}/1`, "DERIVED_SCHEMA_MISMATCH");
      requireValue(row.source_symbol === context.sourceSymbol, "SOURCE_IDENTITY_MISMATCH");
      eventNs = timestamp(row.open_ns); precision = "ns"; origin = "EXCHANGE"; ordinal = id(row.ordinal);
      const closeNs = (BigInt(eventNs) + DERIVED_INTERVAL_NS[family]).toString();
      const method = `${family}/1`;
      if (family === "trade_minute") {
        data.push([family, {
          openNs: eventNs, closeNs, volume: dec(row.volume), buyVolume: dec(row.buy_volume), sellVolume: dec(row.sell_volume),
          undefinedVolume: dec(row.undefined_volume), buyNotional: dec(row.buy_notional), sellNotional: dec(row.sell_notional),
          tradeCount: id(row.trade_count), method,
        }]);
      } else if (family === "trade_level") {
        data.push([family, {
          openNs: eventNs, closeNs, tickSize: dec(row.tick_size), priceBucket: integer(row.price_bucket, true),
          volume: dec(row.volume), buyVolume: dec(row.buy_volume), sellVolume: dec(row.sell_volume),
          tradeCount: id(row.trade_count), method,
        }]);
      } else if (family === "trade_slice") {
        data.push([family, {
          openNs: eventNs, closeNs, lastTradeNs: timestamp(row.last_trade_ns),
          buyNotional: dec(row.buy_notional), sellNotional: dec(row.sell_notional), tradeCount: id(row.trade_count), method,
        }]);
      } else {
        data.push([family, {
          openNs: eventNs, closeNs, side: row.side, rank: id(row.rank), tradeNs: timestamp(row.trade_ns),
          price: dec(row.price), size: dec(row.size), tradeEntityId: token(row.trade_entity_id), method,
        }]);
      }
    } else if (provider === "BINANCE" && family === "candle") {
      const intervalNs = KLINE_INTERVAL_NS.get(context.schema);
      requireValue(intervalNs !== undefined, "BINANCE_KLINE_SCHEMA_REQUIRED");
      const openTime = BigInt(id(row.open_time));
      const span = BigInt(id(row.close_time)) - openTime;
      const unit = span === intervalNs / 1000n - 1n ? "us"
        : span === intervalNs / 1000000n - 1n ? "ms" : null;
      requireValue(unit !== null, "BINANCE_KLINE_INTERVAL_MISMATCH");
      eventNs = timestamp(row.open_time, unit); precision = unit; origin = "EXCHANGE";
      requireValue(BigInt(eventNs) % intervalNs === 0n, "BINANCE_KLINE_NOT_UTC_GRID_ALIGNED");
      const volume = dec(row.volume);
      const quoteVolume = dec(row.quote_volume);
      const takerBuyBase = dec(row.taker_buy_volume);
      const takerBuyQuote = dec(row.taker_buy_quote_volume);
      const tradeCount = BigInt(integer(row.count, true));
      const zero = dec("0");
      requireValue(compareDecimal(quoteVolume, zero) >= 0, "NEGATIVE_QUOTE_VOLUME");
      requireValue(compareDecimal(takerBuyQuote, zero) >= 0, "NEGATIVE_TAKER_BUY_QUOTE_VOLUME");
      requireValue(compareDecimal(takerBuyBase, volume) <= 0, "TAKER_BUY_EXCEEDS_VOLUME");
      requireValue(compareDecimal(takerBuyQuote, quoteVolume) <= 0, "TAKER_BUY_EXCEEDS_QUOTE_VOLUME");
      requireValue(tradeCount >= 0n, "NEGATIVE_TRADE_COUNT");
      requireValue(tradeCount <= 9223372036854775807n, "TRADE_COUNT_OUT_OF_RANGE");
      data.push(["candle", {
        openNs: eventNs, closeNs: (BigInt(eventNs) + intervalNs).toString(),
        open: dec(row.open), high: dec(row.high), low: dec(row.low), close: dec(row.close),
        volume, buyVolume: takerBuyBase, closed: true, method: `binance-${context.schema}/1`,
        quoteVolume, takerBuyQuoteVolume: takerBuyQuote,
        takerSellBaseVolume: subtractDecimal(volume, takerBuyBase),
        takerSellQuoteVolume: subtractDecimal(quoteVolume, takerBuyQuote),
        tradeCount: tradeCount.toString(),
      }]);
    } else if (provider === "BINANCE") {
      precision = "ms";
      eventNs = timestamp(row.T ?? row.E ?? context.receiveMs, "ms");
      if (row.T === undefined && row.E === undefined) { origin = "RECEIVE_FALLBACK"; flags.push("EXCHANGE_TIME_UNAVAILABLE"); }
      receiveNs = timestamp(context.receiveMs, "ms");
      requireValue(row.s === context.sourceSymbol, "SOURCE_IDENTITY_MISMATCH");
      if (family === "trade") {
        requireValue(row.e === "trade" && typeof row.m === "boolean", "INVALID_BINANCE_TRADE");
        data.push(["trade", trade(id(row.t), dec(row.p), dec(row.q), row.m ? "SELL" : "BUY")]);
      } else if (family === "quote") {
        sequence = id(row.u);
        data.push(["quote", { bid: quoteSide(dec(row.b), dec(row.B)), ask: quoteSide(dec(row.a), dec(row.A)), depthLimit: 1 }]);
      } else if (family === "depth") {
        requireValue(row.e === "depthUpdate", "INVALID_BINANCE_DEPTH"); sequence = id(row.u);
        requireValue(BigInt(id(row.U)) <= BigInt(sequence), "INVALID_SEQUENCE_RANGE");
        data.push(["depth", { action: "SET_LEVELS", model: "INCREMENTAL", depthLimit: null, bids: levels(row.b), asks: levels(row.a), firstSequence: id(row.U), lastSequence: sequence, previousSequence: row.pu === undefined ? null : id(row.pu), batchId: sequence, batchEnd: true, reset: false }]);
      } else requireValue(false, "UNSUPPORTED_BINANCE_FAMILY");
    } else if (provider === "TARDIS") {
      requireValue(row.symbol === context.sourceSymbol && row.exchange === context.dataset, "SOURCE_IDENTITY_MISMATCH");
      eventNs = timestamp(row.timestamp, "us"); receiveNs = timestamp(row.local_timestamp, "us"); precision = "us";
      const exchangePrecision = family === "trade" && Object.hasOwn(TARDIS_EXCHANGE_TRADE_PRECISION, row.exchange)
        ? TARDIS_EXCHANGE_TRADE_PRECISION[row.exchange] : null;
      if (exchangePrecision === null) {
        origin = "PROVIDER"; flags.push("EXCHANGE_OR_PROVIDER_FALLBACK");
      } else {
        const receiveLagNs = BigInt(eventNs) - BigInt(receiveNs);
        requireValue(receiveLagNs <= TARDIS_RECEIVE_CLOCK_LAG_LIMIT_NS, "EXCHANGE_TIME_AFTER_RECEIVE");
        requireValue(exchangePrecision !== "ms" || BigInt(eventNs) % 1000000n === 0n, "EXCHANGE_TIME_PRECISION_MISMATCH");
        if (receiveLagNs > 0n) flags.push("RECEIVE_BEFORE_EXCHANGE_TIME");
        origin = "EXCHANGE"; precision = exchangePrecision;
      }
      if (family === "trade" || family === "liquidation") {
        requireValue(["buy", "sell", "unknown", ""].includes(row.side), "INVALID_SOURCE_SIDE");
        const entityId = row.id ? token(row.id) : `raw:${context.lineage.sha256}:${context.lineage.row}`;
        if (!row.id) flags.push("NO_NATIVE_TRADE_ID");
        data.push([family, trade(entityId, dec(row.price), dec(row.amount), row.side === "buy" ? "BUY" : row.side === "sell" ? "SELL" : "UNKNOWN")]);
      } else if (family === "quote") {
        data.push(["quote", { bid: quoteSide(nullableDecimal(row.bid_price), nullableDecimal(row.bid_amount)), ask: quoteSide(nullableDecimal(row.ask_price), nullableDecimal(row.ask_amount)), depthLimit: 1 }]);
      } else if (family === "depth") {
        requireValue(["true", "false"].includes(row.is_snapshot) && ["bid", "ask"].includes(row.side), "INVALID_TARDIS_DEPTH");
        requireValue(typeof context.batchEnd === "boolean" && typeof context.snapshotStart === "boolean", "BATCH_BOUNDARY_REQUIRED");
        requireValue(!context.snapshotStart || row.is_snapshot === "true", "INVALID_SNAPSHOT_START");
        flags.push("NO_EXCHANGE_SEQUENCE");
        data.push(["depth", { action: row.is_snapshot === "true" ? "SNAPSHOT" : "SET_LEVELS", model: "INCREMENTAL", depthLimit: null, bids: row.side === "bid" ? [{ price: dec(row.price), size: dec(row.amount) }] : [], asks: row.side === "ask" ? [{ price: dec(row.price), size: dec(row.amount) }] : [], firstSequence: null, lastSequence: null, previousSequence: null, batchId: token(context.batchId), batchEnd: context.batchEnd, reset: context.snapshotStart }]);
      } else if (family === "derivative") {
        data.push([family, { fundingRate: nullableDecimal(row.funding_rate), fundingTimeNs: row.funding_timestamp ? timestamp(row.funding_timestamp, "us") : null, markPrice: nullableDecimal(row.mark_price), indexPrice: nullableDecimal(row.index_price), openInterest: nullableDecimal(row.open_interest) }]);
      } else requireValue(false, "UNSUPPORTED_TARDIS_FAMILY");
    } else if (provider === "DXFEED") {
      requireValue(row.eventSymbol === context.sourceSymbol, "SOURCE_IDENTITY_MISMATCH");
      requireValue((family === "trade" && row.eventType === "TimeAndSale") || (family === "order" && row.eventType === "Order"), "UNSUPPORTED_DXFEED_EVENT");
      const part = row.timeNanoPart === undefined ? 0n : BigInt(id(row.timeNanoPart));
      requireValue(part < 1000000n, "INVALID_NANO_PART");
      const clock = row.time ?? row.eventTime;
      requireValue(clock !== undefined, "DXFEED_TIME_REQUIRED");
      eventNs = (BigInt(timestamp(clock, "ms")) + part).toString();
      precision = row.timeNanoPart === undefined ? "ms" : "ns";
      receiveNs = timestamp(context.receiveMs, "ms"); sequence = row.sequence === undefined ? null : id(row.sequence);
      if (row.time === undefined) flags.push("EVENT_TIME_FALLBACK");
      if (family === "order") {
        const eventFlags = id(row.eventFlags);
        const remove = (BigInt(eventFlags) & 2n) !== 0n;
        requireValue(["BUY", "SELL", "UNDEFINED"].includes(row.side) || remove, "INVALID_SOURCE_SIDE");
        origin = "PROVIDER";
        flags.push("INDEXED_ENTRY_NOT_ASSUMED_EXCHANGE_ORDER");
        data.push(["order", { index: id(row.index), source: token(row.source), scope: remove ? (row.scope ?? "UNKNOWN") : token(row.scope), action: remove ? "REMOVE" : token(row.action), eventFlags, remove, orderId: row.orderId === undefined ? null : id(row.orderId), side: row.side === "BUY" ? "BUY" : row.side === "SELL" ? "SELL" : "UNKNOWN", price: remove ? null : dec(row.price), size: remove ? null : dec(row.size) }]);
      } else {
      requireValue(["NEW", "CORRECTION", "CANCEL"].includes(row.type), "INVALID_TRADE_ACTION");
      requireValue(["BUY", "SELL", "UNDEFINED"].includes(row.aggressorSide), "INVALID_SOURCE_SIDE");
      requireValue(typeof row.validTick === "boolean", "VALID_TICK_REQUIRED");
      const eventFlags = id(row.eventFlags);
      requireValue(eventFlags === "0", "DXFEED_TRANSACTION_REQUIRES_MATERIALIZER");
      origin = "PROVIDER";
      const cancel = row.type === "CANCEL";
      data.push(["trade", { ...trade(id(row.index), cancel ? null : dec(row.price), cancel ? null : dec(row.size), row.aggressorSide === "UNDEFINED" ? "UNKNOWN" : row.aggressorSide, row.type, row.validTick), eventFlags, saleConditions: row.exchangeSaleConditions ?? null, exchangeCode: row.exchangeCode ?? null, spreadLeg: row.spreadLeg ?? null, extendedTradingHours: row.extendedTradingHours ?? null }]);
      }
    } else if (provider === "DATABENTO") {
      const intervalNs = OHLCV_INTERVAL_NS.get(context.schema);
      const isOhlcv = intervalNs !== undefined;
      requireValue(isOhlcv || ["mbp-1", "mbp-10", "tbbo"].includes(context.schema), "DECODED_DATABENTO_SCHEMA_REQUIRED");
      requireValue(String(row.instrument_id) === context.sourceSymbol, "SOURCE_IDENTITY_MISMATCH");
      if (isOhlcv) {
        requireValue(family === "candle", "OHLCV_MAPS_TO_CANDLE_ONLY");
        eventNs = timestamp(row.ts_event); precision = "ns"; origin = "PROVIDER";
        data.push(["candle", {
          openNs: eventNs, closeNs: (BigInt(eventNs) + intervalNs).toString(),
          open: fixed9(row.open), high: fixed9(row.high), low: fixed9(row.low), close: fixed9(row.close),
          volume: decimal(id(row.volume)), buyVolume: null, closed: true, method: `databento-${context.schema}/1`,
        }]);
      } else {
        eventNs = timestamp(row.ts_event); receiveNs = timestamp(row.ts_recv); precision = "ns"; sequence = id(row.sequence);
        requireValue(["A", "C", "F", "M", "R", "T"].includes(row.action), "UNSUPPORTED_MBP_ACTION");
        requireValue(["A", "B", "N"].includes(row.side), "INVALID_SOURCE_SIDE");
        const sourceFlags = id(row.flags);
        requireValue(BigInt(sourceFlags) <= 255n, "INVALID_MBP_FLAGS");
        flags.push(`DBN_FLAGS_${sourceFlags}`);
        const price = v => v === "9223372036854775807" ? null : fixed9(v);
        const depth = context.schema === "mbp-10" ? 10 : 1;
        const bids = [], asks = [];
        for (let i = 0; i < depth; i++) {
          const suffix = String(i).padStart(2, "0");
          for (const [s, out] of [["bid", bids], ["ask", asks]]) {
            const p = price(row[`${s}_px_${suffix}`]);
            const size = decimal(id(row[`${s}_sz_${suffix}`]));
            if (p !== null) out.push({ price: p, size });
          }
        }
        if (family === "trade" || family === "mbp") {
          if (row.action === "T") data.push(["trade", { ...trade(`raw:${context.lineage.sha256}:${context.lineage.row}`, fixed9(row.price), decimal(id(row.size)), row.side === "B" ? "BUY" : row.side === "A" ? "SELL" : "UNKNOWN"), publisherId: id(row.publisher_id), sourceFlags, sourceAction: row.action }]);
        }
        if (family === "quote" || family === "mbp") data.push(["quote", { bid: bids[0] ?? { price: null, size: null }, ask: asks[0] ?? { price: null, size: null }, depthLimit: 1, sourceFlags, publisherId: id(row.publisher_id), sourceAction: row.action }]);
        if (family === "depth") data.push(["depth", { action: "SNAPSHOT", model: "TOP_N", depthLimit: depth, bids, asks, firstSequence: null, lastSequence: sequence, previousSequence: null, batchId: `${context.lineage.sha256}:${context.lineage.row}`, batchEnd: true, reset: true, sourceFlags, publisherId: id(row.publisher_id) }]);
        requireValue(["trade", "quote", "mbp", "depth"].includes(family), "UNSUPPORTED_MBP_FAMILY");
      }
    } else requireValue(false, "UNSUPPORTED_PROVIDER");
    const mapping = context.resolveIdentity({ provider, dataset: context.dataset, sourceSymbol: context.sourceSymbol, eventNs });
    return data.map(([kind, payload]) => createRecord({
      family: kind, instrument: mapping.instrument,
      source: { provider, dataset: context.dataset, schema: context.schema ?? family, population: context.population, datasetVersion: context.datasetVersion, methodVersion: "provider-map/1", sourceSymbol: context.sourceSymbol, mappingVersion: mapping.mappingVersion, mappingReference: mapping.reference, streamId: context.streamId },
      time: { eventNs, receiveNs, ingestNs: timestamp(context.ingestNs), precision, origin },
      order: { sequence, ordinal, position: integer(context.position), domain: context.streamId },
      lineage: context.lineage, quality: { state: "UNVERIFIED", flags }, data: payload,
    }));
  }, context?.lineage ?? null);
}
module.exports = { mapObservation };
