function serializeConsoleValue(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function installConsolePersistenceBridge({ logger, consoleImpl = console } = {}) {
  if (!logger || typeof logger.warn !== "function" || typeof logger.error !== "function") {
    throw new Error("console persistence bridge: logger must expose warn() and error()");
  }
  if (!consoleImpl || typeof consoleImpl.warn !== "function" || typeof consoleImpl.error !== "function") {
    throw new Error("console persistence bridge: console must expose warn() and error()");
  }
  const originalWarn = consoleImpl.warn;
  const originalError = consoleImpl.error;
  let installed = true;
  const forward = (level, args) => {
    const [first, ...rest] = args;
    const message = serializeConsoleValue(first);
    const details = rest.length === 0 ? undefined : { details: rest.map(serializeConsoleValue) };
    logger[level](message, details);
  };
  consoleImpl.warn = (...args) => forward("warn", args);
  consoleImpl.error = (...args) => forward("error", args);
  return () => {
    if (!installed) return;
    installed = false;
    consoleImpl.warn = originalWarn;
    consoleImpl.error = originalError;
  };
}

module.exports = { serializeConsoleValue, installConsolePersistenceBridge };
