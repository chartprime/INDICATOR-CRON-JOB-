function emitTelemetry(sink, eventName, payload = {}) {
  try {
    if (typeof eventName !== "string" || eventName.length === 0) {
      throw new TypeError("telemetry eventName must be a non-empty string");
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TypeError("telemetry payload must be an object");
    }
    const entry = Object.freeze({ ...payload, event: eventName, ts: new Date().toISOString() });
    if (typeof sink === "function") {
      sink(entry);
      return entry;
    }
    console.log("[telemetry]", JSON.stringify(entry));
    return entry;
  } catch (error) {
    try {
      console.error("telemetry sink error", error?.message ?? error);
    } catch {
      void 0;
    }
    return null;
  }
}

module.exports = { emitTelemetry };
