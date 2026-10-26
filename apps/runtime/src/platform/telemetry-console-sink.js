const DEFAULT_WINDOW_MS = 1000;
const DEFAULT_MAX_OPEN_WINDOWS = 10_000;

function createThrottledConsoleSink({
  windowMs = DEFAULT_WINDOW_MS,
  maxOpenWindows = DEFAULT_MAX_OPEN_WINDOWS,
  log = console.log,
  keyForEntry = null,
} = {}) {
  if (!Number.isInteger(windowMs) || windowMs <= 0) {
    throw new Error("createThrottledConsoleSink: windowMs must be a positive integer");
  }
  if (typeof log !== "function") {
    throw new Error("createThrottledConsoleSink: log must be a function");
  }
  if (!Number.isSafeInteger(maxOpenWindows) || maxOpenWindows <= 0) {
    throw new Error("createThrottledConsoleSink: maxOpenWindows must be a positive safe integer");
  }
  if (keyForEntry !== null && typeof keyForEntry !== "function") {
    throw new Error("createThrottledConsoleSink: keyForEntry must be a function when provided");
  }
  const windows = new Map();
  let suppressedDuplicates = 0;
  let serializationFailures = 0;
  let logFailures = 0;
  let capacityBypasses = 0;
  let stopped = false;

  function safelyLog(...args) {
    try {
      Reflect.apply(log, undefined, args);
      return true;
    } catch {
      logFailures += 1;
      return false;
    }
  }

  function sink(entry) {
    if (stopped) return;
    let key;
    let serializedEntry;
    let context;
    try {
      if (entry === null || typeof entry !== "object") {
        throw new TypeError("telemetry entry must be an object");
      }
      serializedEntry = JSON.stringify(entry);
      const snapshot = JSON.parse(serializedEntry);
      if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        throw new TypeError("telemetry entry must serialize to an object");
      }
      context = { ...snapshot };
      delete context.ts;
      const customKey = keyForEntry?.(Object.freeze({ ...snapshot }));
      key = customKey === null || customKey === undefined ? JSON.stringify(context) : String(customKey);
    } catch {
      serializationFailures += 1;
      safelyLog("[telemetry]", JSON.stringify({
        event: "telemetry.serialization_failed",
        ts: new Date().toISOString(),
      }));
      return;
    }
    const existing = windows.get(key);
    if (!existing) {
      if (windows.size >= maxOpenWindows) {
        capacityBypasses += 1;
        safelyLog("[telemetry]", serializedEntry);
        return;
      }
      safelyLog("[telemetry]", serializedEntry);
      const timer = setTimeout(() => {
        const state = windows.get(key);
        windows.delete(key);
        if (state && state.suppressedCount > 0) {
          safelyLog(
            "[telemetry]",
            JSON.stringify({
              ...context,
              suppressedDuplicates: state.suppressedCount,
              windowMs,
              ts: new Date().toISOString(),
            }),
          );
        }
      }, windowMs);
      timer.unref?.();
      windows.set(key, { suppressedCount: 0, timer });
      return;
    }
    existing.suppressedCount += 1;
    suppressedDuplicates += 1;
  }

  sink.getStats = () => Object.freeze({
    telemetryThrottleOpenWindows: windows.size,
    telemetrySuppressedDuplicates: suppressedDuplicates,
    telemetrySerializationFailures: serializationFailures,
    telemetryLogFailures: logFailures,
    telemetryThrottleCapacityBypasses: capacityBypasses,
  });
  sink.stop = () => {
    stopped = true;
    for (const state of windows.values()) clearTimeout(state.timer);
    windows.clear();
  };
  return Object.freeze(sink);
}

module.exports = { createThrottledConsoleSink, DEFAULT_MAX_OPEN_WINDOWS };
