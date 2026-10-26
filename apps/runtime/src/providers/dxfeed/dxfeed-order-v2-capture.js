const { WebSocket: DefaultWebSocket } = require("ws");
const { createWsConnector } = require("./dxlink-ws-connector");
const { normalizeDxFeedOrderV2Event } = require("./dxfeed-event-normalizer");

const DEFAULT_MAX_PENDING_FRAMES = 2_048;
const DEFAULT_MAX_PENDING_INDEX_VALUES = 250_000;

function skipWhitespace(text, position) {
  let cursor = position;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function jsonStringEnd(text, start) {
  if (text[start] !== '"') return null;
  let cursor = start + 1;
  while (cursor < text.length) {
    if (text[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (text[cursor] === '"') return cursor + 1;
    cursor += 1;
  }
  return null;
}

function jsonValueEnd(text, start) {
  const first = text[start];
  if (first === '"') return jsonStringEnd(text, start);
  if (first !== "{" && first !== "[") {
    let cursor = start;
    while (cursor < text.length && !/[\s,}\]]/.test(text[cursor])) cursor += 1;
    return cursor === start ? null : cursor;
  }
  const stack = [first === "{" ? "}" : "]"];
  let cursor = start + 1;
  while (cursor < text.length) {
    if (text[cursor] === '"') {
      const end = jsonStringEnd(text, cursor);
      if (end === null) return null;
      cursor = end;
      continue;
    }
    if (text[cursor] === "{") stack.push("}");
    if (text[cursor] === "[") stack.push("]");
    if (text[cursor] === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return cursor + 1;
    }
    cursor += 1;
  }
  return null;
}

function objectMembers(text, start) {
  if (text[start] !== "{") return null;
  const members = [];
  let cursor = skipWhitespace(text, start + 1);
  if (text[cursor] === "}") return { members, end: cursor + 1 };
  while (cursor < text.length) {
    const keyEnd = jsonStringEnd(text, cursor);
    if (keyEnd === null) return null;
    let key;
    try {
      key = JSON.parse(text.slice(cursor, keyEnd));
    } catch {
      return null;
    }
    cursor = skipWhitespace(text, keyEnd);
    if (text[cursor] !== ":") return null;
    const valueStart = skipWhitespace(text, cursor + 1);
    const valueEnd = jsonValueEnd(text, valueStart);
    if (valueEnd === null) return null;
    members.push({ key, valueStart, valueEnd });
    cursor = skipWhitespace(text, valueEnd);
    if (text[cursor] === "}") return { members, end: cursor + 1 };
    if (text[cursor] !== ",") return null;
    cursor = skipWhitespace(text, cursor + 1);
  }
  return null;
}

function arrayElementRanges(text, start) {
  if (text[start] !== "[") return null;
  const elements = [];
  let cursor = skipWhitespace(text, start + 1);
  if (text[cursor] === "]") return { elements, end: cursor + 1 };
  while (cursor < text.length) {
    const valueEnd = jsonValueEnd(text, cursor);
    if (valueEnd === null) return null;
    elements.push({ valueStart: cursor, valueEnd });
    cursor = skipWhitespace(text, valueEnd);
    if (text[cursor] === "]") return { elements, end: cursor + 1 };
    if (text[cursor] !== ",") return null;
    cursor = skipWhitespace(text, cursor + 1);
  }
  return null;
}

function lastMember(members, key) {
  for (let index = members.length - 1; index >= 0; index -= 1) {
    if (members[index].key === key) return members[index];
  }
  return null;
}

function parseJsonStringValue(text, member) {
  if (!member || text[member.valueStart] !== '"') return null;
  try {
    return JSON.parse(text.slice(member.valueStart, member.valueEnd));
  } catch {
    return null;
  }
}

function parseFeedDataFrame(rawText) {
  if (typeof rawText !== "string") return null;
  const rootStart = skipWhitespace(rawText, 0);
  const root = objectMembers(rawText, rootStart);
  if (!root || skipWhitespace(rawText, root.end) !== rawText.length) return null;
  if (parseJsonStringValue(rawText, lastMember(root.members, "type")) !== "FEED_DATA") return null;
  const dataMember = lastMember(root.members, "data");
  if (!dataMember) return null;
  const data = arrayElementRanges(rawText, dataMember.valueStart);
  if (!data || data.end !== dataMember.valueEnd) return null;
  return { root, data };
}

function isFeedDataFrameText(rawText) {
  return parseFeedDataFrame(rawText) !== null;
}

function extractChannelNumber(rawText) {
  if (typeof rawText !== "string") return null;
  const rootStart = skipWhitespace(rawText, 0);
  const root = objectMembers(rawText, rootStart);
  if (!root || skipWhitespace(rawText, root.end) !== rawText.length) return null;
  const channel = lastMember(root.members, "channel");
  if (!channel) return null;
  const rawChannel = rawText.slice(channel.valueStart, channel.valueEnd);
  if (!/^(?:0|[1-9]\d*)$/.test(rawChannel)) return null;
  const parsed = Number(rawChannel);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function extractOrderIndexStringsFromDataArray(rawText) {
  const frame = parseFeedDataFrame(rawText);
  if (!frame) return null;
  const results = [];
  for (const { valueStart, valueEnd } of frame.data.elements) {
    const item = objectMembers(rawText, valueStart);
    if (!item || item.end !== valueEnd) continue;
    if (parseJsonStringValue(rawText, lastMember(item.members, "eventType")) !== "Order") continue;
    const index = lastMember(item.members, "index");
    const rawIndex = index ? rawText.slice(index.valueStart, index.valueEnd) : undefined;
    results.push(typeof rawIndex === "string" && /^\d+$/.test(rawIndex) ? rawIndex : undefined);
  }
  return results;
}

function createRawFrameCapturingWebSocketImpl(RealWebSocket, onRawFrame) {
  return class RawFrameCapturingWebSocket extends RealWebSocket {
    on(event, listener) {
      if (event !== "message") return super.on(event, listener);
      return super.on(event, (data, ...rest) => {
        try {
          onRawFrame(typeof data === "string" ? data : data.toString());
        } catch (error) {
          console.error("dxfeed-order-v2-capture: raw-frame capture failed", error?.message ?? error);
        }
        return listener(data, ...rest);
      });
    }
  };
}

function createDxFeedOrderV2Capture({
  webSocketImpl = DefaultWebSocket,
  resolveOrderContext,
  onEnvelope = null,
  onEnvelopes = null,
  onCaptureError = (error) => console.error("dxfeed-order-v2-capture: envelope processing failed", error?.message ?? error),
  maxPendingFrames = DEFAULT_MAX_PENDING_FRAMES,
  maxPendingIndexValues = DEFAULT_MAX_PENDING_INDEX_VALUES,
  now = () => Date.now(),
} = {}) {
  if (typeof resolveOrderContext !== "function") {
    throw new Error("dxfeed-order-v2-capture: resolveOrderContext must be a function");
  }
  if (typeof onEnvelope !== "function" && typeof onEnvelopes !== "function") {
    throw new Error("dxfeed-order-v2-capture: onEnvelope or onEnvelopes must be a function");
  }
  if (typeof onEnvelope === "function" && typeof onEnvelopes === "function") {
    throw new Error("dxfeed-order-v2-capture: configure exactly one of onEnvelope or onEnvelopes");
  }
  if (typeof onCaptureError !== "function") {
    throw new Error("dxfeed-order-v2-capture: onCaptureError must be a function");
  }
  if (typeof now !== "function") {
    throw new Error("dxfeed-order-v2-capture: now must be a function");
  }
  if (!Number.isSafeInteger(maxPendingFrames) || maxPendingFrames <= 0) {
    throw new Error("dxfeed-order-v2-capture: maxPendingFrames must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxPendingIndexValues) || maxPendingIndexValues <= 0) {
    throw new Error("dxfeed-order-v2-capture: maxPendingIndexValues must be a positive safe integer");
  }

  const pendingFrames = [];
  let pendingIndexValues = 0;
  let targetChannelId = null;
  let correlationFailed = false;
  let lastFailure = null;

  function reportCaptureError(error) {
    try {
      onCaptureError(error);
    } catch (callbackError) {
      console.error("dxfeed-order-v2-capture: onCaptureError threw", callbackError?.message ?? callbackError);
    }
  }

  function failCorrelation(message, eventSymbols = []) {
    pendingFrames.length = 0;
    pendingIndexValues = 0;
    correlationFailed = true;
    lastFailure = Object.freeze({ reason: message, eventSymbols, atMs: now() });
    const error = new Error(`dxfeed-order-v2-capture: ${message}`);
    error.code = "DXFEED_ORDER_V2_CORRELATION_LOST";
    error.eventSymbols = eventSymbols;
    reportCaptureError(error);
  }

  function setChannelId(channelId) {
    if (!Number.isSafeInteger(channelId) || channelId < 0) {
      throw new Error("dxfeed-order-v2-capture: setChannelId requires a non-negative safe integer channel id");
    }
    pendingFrames.length = 0;
    pendingIndexValues = 0;
    correlationFailed = false;
    targetChannelId = channelId;
  }

  function onRawFrame(rawText) {
    if (targetChannelId === null || extractChannelNumber(rawText) !== targetChannelId) {
      return;
    }
    if (correlationFailed) return;
    const orderIndexStrings = extractOrderIndexStringsFromDataArray(rawText);
    if (orderIndexStrings !== null && orderIndexStrings.length > 0) {
      if (
        pendingFrames.length >= maxPendingFrames ||
        pendingIndexValues + orderIndexStrings.length > maxPendingIndexValues
      ) {
        failCorrelation("raw order-frame correlation backlog exceeded its bounded capacity");
        return;
      }
      pendingFrames.push(orderIndexStrings);
      pendingIndexValues += orderIndexStrings.length;
    }
  }

  function createConnector(url) {
    return createWsConnector(url, {
      webSocketImpl: createRawFrameCapturingWebSocketImpl(webSocketImpl, onRawFrame),
    });
  }

  function handleChannelMessage(message) {
    if (message?.type !== "FEED_DATA" || !Array.isArray(message.data)) return;
    if (correlationFailed) return;
    const parsedOrderCount = message.data.reduce(
      (count, item) => count + (item?.eventType === "Order" ? 1 : 0),
      0,
    );
    if (parsedOrderCount === 0) return;
    const orderEventSymbols = [...new Set(
      message.data
        .filter((item) => item?.eventType === "Order")
        .map((item) => item?.eventSymbol)
        .filter((symbol) => typeof symbol === "string" && symbol.length > 0),
    )];
    if (pendingFrames.length === 0) {
      failCorrelation("parsed FEED_DATA arrived without its raw frame", orderEventSymbols);
      return;
    }
    const frameOrderIndices = pendingFrames.shift();
    pendingIndexValues -= frameOrderIndices.length;
    if (parsedOrderCount !== frameOrderIndices.length || frameOrderIndices.some((value) => value === undefined)) {
      failCorrelation("raw and parsed Order item counts or exact indices do not match", orderEventSymbols);
      return;
    }
    let orderPosition = 0;
    const envelopes = [];
    for (const item of message.data) {
      if (item?.eventType !== "Order") continue;
      const rawIndexString = frameOrderIndices[orderPosition];
      orderPosition += 1;
      let context;
      try {
        context = resolveOrderContext(item?.eventSymbol);
      } catch (error) {
        reportCaptureError(error);
        continue;
      }
      if (!context) continue;
      let envelope;
      try {
        envelope = normalizeDxFeedOrderV2Event(
          { assetClass: context.assetClass, symbol: context.symbol, raw: item, rawIndexString },
          { receivedAtMs: now() },
        );
      } catch (error) {
        reportCaptureError(error);
        continue;
      }
      envelopes.push(envelope);
    }
    if (envelopes.length === 0) return;
    if (typeof onEnvelopes === "function") {
      try {
        onEnvelopes(envelopes);
      } catch (error) {
        reportCaptureError(error);
      }
      return;
    }
    for (const envelope of envelopes) {
      try {
        onEnvelope(envelope);
      } catch (error) {
        reportCaptureError(error);
      }
    }
  }

  function pendingFrameCount() {
    return pendingFrames.length;
  }

  function getCorrelationStatus() {
    return Object.freeze({
      healthy: !correlationFailed,
      pendingFrames: pendingFrames.length,
      pendingIndexValues,
      lastFailure,
    });
  }

  return Object.freeze({ createConnector, handleChannelMessage, setChannelId, pendingFrameCount, getCorrelationStatus });
}

module.exports = {
  createDxFeedOrderV2Capture,
  extractOrderIndexStringsFromDataArray,
  extractChannelNumber,
  isFeedDataFrameText,
  createRawFrameCapturingWebSocketImpl,
  DEFAULT_MAX_PENDING_FRAMES,
  DEFAULT_MAX_PENDING_INDEX_VALUES,
};
