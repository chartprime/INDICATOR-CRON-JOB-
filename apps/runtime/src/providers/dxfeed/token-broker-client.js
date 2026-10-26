const { types: utilTypes } = require("node:util");

const TOKEN_PATH = "/v1/dxfeed/development-token";
const DEFAULT_TIMEOUT_MS = Number(process.env.TT_DXFEED_TOKEN_TIMEOUT_MS) > 0 ? Number(process.env.TT_DXFEED_TOKEN_TIMEOUT_MS) : 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16_384;
const MAX_TOKEN_TTL_MS = 35 * 60 * 1000;
const TEMP_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 2_048;
const TOKEN_REQUEST_HEADERS = Object.freeze({
  "X-Trading-Terminal-Token-Request": "1",
  "X-Trading-Terminal-Feed-Claims": "REALTIME",
  "X-Trading-Terminal-Client-Version": "trading-terminal-development/1.0",
});

const RESPONSE_PROTOTYPE = globalThis.Response?.prototype;
const STREAM_PROTOTYPE = globalThis.ReadableStream?.prototype;

const TOKEN_FIELD = "token";
const EXPIRY_FIELD = "expiresAt";

function tokenBrokerError(message, {
  code = "DXFEED_TOKEN_BROKER_INVALID_RESPONSE",
  retryable = false,
  status = undefined,
} = {}) {
  const error = new Error(message);
  error.name = "DxFeedTokenBrokerError";
  error.code = code;
  error.retryable = retryable;
  if (status !== undefined) error.status = status;
  return error;
}

function isRetryableTokenBrokerError(error) {
  return error?.name === "DxFeedTokenBrokerError" && error.retryable === true;
}

function isBlank(value) {
  return typeof value !== "string" || value.trim().length === 0;
}

function assertBrokerUrl(rawUrl) {
  if (isBlank(rawUrl)) {
    throw new Error("dxfeed-token-broker: missing broker URL");
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("dxfeed-token-broker: broker URL is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("dxfeed-token-broker: broker URL must use https:");
  }
  if (!url.hostname.endsWith(".ts.net") || url.hostname.length <= ".ts.net".length) {
    throw new Error("dxfeed-token-broker: broker URL must be a Tailscale HTTPS host");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") {
    throw new Error("dxfeed-token-broker: broker URL must be an origin without credentials, path, query, or fragment");
  }
  return url;
}

function assertPositiveSafeInteger(name, value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`dxfeed-token-broker: ${name} must be a positive safe integer`);
  }
}

function parseDevelopmentTokenResponse(body, now) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    const kind = Array.isArray(body) ? "array" : typeof body;
    throw new Error(`dxfeed-token-broker: response body was not a JSON object (got ${kind})`);
  }

  if (
    isBlank(body[TOKEN_FIELD]) ||
    body[TOKEN_FIELD].length > MAX_TOKEN_LENGTH ||
    !TEMP_TOKEN_PATTERN.test(body[TOKEN_FIELD])
  ) {
    throw new Error(`dxfeed-token-broker: response had an invalid "${TOKEN_FIELD}" field`);
  }

  const nowMs = now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 8_640_000_000_000_000) {
    throw new Error("dxfeed-token-broker: clock returned an invalid timestamp");
  }

  if (isBlank(body[EXPIRY_FIELD])) {
    throw new Error(`dxfeed-token-broker: response had an invalid "${EXPIRY_FIELD}" field`);
  }
  const parsed = new Date(body[EXPIRY_FIELD]);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`dxfeed-token-broker: response had an invalid "${EXPIRY_FIELD}" field`);
  }
  if (parsed.getTime() <= nowMs) {
    throw new Error("dxfeed-token-broker: broker returned an expired token");
  }
  if (parsed.getTime() - nowMs > MAX_TOKEN_TTL_MS) {
    throw new Error("dxfeed-token-broker: broker returned an expiry outside the approved temporary-token lifetime");
  }
  const expiresAt = parsed.toISOString();

  return { token: body[TOKEN_FIELD], expiresAt };
}

function isGenuineResponse(response) {
  return (
    response !== null &&
    typeof response === "object" &&
    !utilTypes.isProxy(response) &&
    RESPONSE_PROTOTYPE !== undefined &&
    Object.getPrototypeOf(response) === RESPONSE_PROTOTYPE
  );
}

function isGenuineStream(stream) {
  return (
    stream !== null &&
    typeof stream === "object" &&
    !utilTypes.isProxy(stream) &&
    STREAM_PROTOTYPE !== undefined &&
    Object.getPrototypeOf(stream) === STREAM_PROTOTYPE
  );
}

async function readBoundedBody(response, maxBytes) {
  let body;
  try {
    body = response.body;
  } catch {
    throw new Error("dxfeed-token-broker: invalid response");
  }
  if (!isGenuineResponse(response) || !isGenuineStream(body)) {
    throw new Error("dxfeed-token-broker: invalid response");
  }

  let reader;
  try {
    reader = body.getReader();
  } catch {
    throw new Error("dxfeed-token-broker: invalid response");
  }
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        throw new Error("dxfeed-token-broker: invalid response");
      }
      if (!chunk || typeof chunk !== "object") {
        throw new Error("dxfeed-token-broker: invalid response");
      }
      if (chunk.done) {
        break;
      }
      if (!(chunk.value instanceof Uint8Array)) {
        throw new Error("dxfeed-token-broker: invalid response");
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("dxfeed-token-broker: response exceeded the size limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      void 0;
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeJson(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("dxfeed-token-broker: response body was not valid UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("dxfeed-token-broker: response body was not valid JSON");
  }
}

async function performTokenPost({ url, fetchImpl, controller, maxResponseBytes, now }) {
  let response;
  try {
    response = await Reflect.apply(fetchImpl, undefined, [
      url.toString(),
      {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: TOKEN_REQUEST_HEADERS,
      },
    ]);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw tokenBrokerError("dxfeed-token-broker: request timed out", {
        code: "DXFEED_TOKEN_BROKER_TIMEOUT",
        retryable: true,
      });
    }
    throw tokenBrokerError("dxfeed-token-broker: network error reaching broker", {
      code: "DXFEED_TOKEN_BROKER_NETWORK_ERROR",
      retryable: true,
    });
  }

  if (!isGenuineResponse(response)) {
    throw new Error("dxfeed-token-broker: invalid response");
  }
  if (response.status < 200 || response.status >= 300) {
    try {
      await response.body?.cancel();
    } catch {
      void 0;
    }
    const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    throw tokenBrokerError(`dxfeed-token-broker: broker returned HTTP ${response.status}`, {
      code: `DXFEED_TOKEN_BROKER_HTTP_${response.status}`,
      retryable,
      status: response.status,
    });
  }

  const bytes = await readBoundedBody(response, maxResponseBytes);
  const body = decodeJson(bytes);
  return parseDevelopmentTokenResponse(body, now);
}

async function requestDevelopmentToken({
  brokerUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  now = () => Date.now(),
  signal,
} = {}) {
  const url = assertBrokerUrl(brokerUrl);
  url.pathname = TOKEN_PATH;
  url.search = "";
  url.hash = "";

  if (typeof fetchImpl !== "function") {
    throw new Error("dxfeed-token-broker: fetchImpl is unavailable");
  }
  assertPositiveSafeInteger("timeoutMs", timeoutMs);
  assertPositiveSafeInteger("maxResponseBytes", maxResponseBytes);
  if (typeof now !== "function") {
    throw new Error("dxfeed-token-broker: now must be a function");
  }

  const controller = new AbortController();
  let cancel;
  const cancelled = new Promise((_, reject) => {
    cancel = () => {
      controller.abort();
      reject(tokenBrokerError("dxfeed-token-broker: request cancelled", { code: "DXFEED_TOKEN_BROKER_CANCELLED" }));
    };
  });
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(tokenBrokerError(`dxfeed-token-broker: request timed out after ${timeoutMs}ms`, {
        code: "DXFEED_TOKEN_BROKER_TIMEOUT",
        retryable: true,
      }));
    }, timeoutMs);
  });

  const attempt = signal?.aborted ? cancelled : performTokenPost({ url, fetchImpl, controller, maxResponseBytes, now });

  try {
    return await Promise.race([attempt, deadline, cancelled]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

module.exports = {
  assertBrokerUrl,
  requestDevelopmentToken,
  parseDevelopmentTokenResponse,
  DEFAULT_TIMEOUT_MS,
  TOKEN_PATH,
  MAX_TOKEN_TTL_MS,
  TOKEN_REQUEST_HEADERS,
  isRetryableTokenBrokerError,
};
