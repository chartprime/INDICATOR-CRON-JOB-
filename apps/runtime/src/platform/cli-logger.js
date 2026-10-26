const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { logDir } = require("./runtime-paths");

const DEFAULT_LOG_DIR = logDir();

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

const COLORS = Object.freeze({
  info: "\x1b[34m",
  ok: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
});

const LEVEL_LABELS = Object.freeze({ info: "INFO", ok: "OK  ", warn: "WARN", error: "ERR " });
const COUNTER_FORMATTER = new Intl.NumberFormat("en-US");

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatClock(date) {
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

function formatDateKey(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function singleLine(value) {
  return String(value).replace(/[\r\n\u2028\u2029]+/g, "\\n");
}

function formatMeta(meta) {
  if (!meta || typeof meta !== "object") return "";
  const parts = Object.entries(meta).map(([key, value]) => `${singleLine(key)} ${formatValue(value)}`);
  return parts.length > 0 ? `  ${parts.join("  ")}` : "";
}

function formatValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return COUNTER_FORMATTER.format(value);
  if (value === null || value === undefined) return "n/a";
  if (typeof value !== "object") return singleLine(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function formatCounters(counters) {
  return Object.entries(counters)
    .map(([key, value]) => `${singleLine(key)} ${formatValue(value)}`)
    .join("  ");
}

const DECLARED_SEVERITIES = Object.freeze(new Set(["info", "warn", "error"]));

function classifyTelemetryEvent(eventName, entry = null) {
  if (DECLARED_SEVERITIES.has(entry?.severity)) return entry.severity;
  if (typeof eventName !== "string") return "info";
  if (/_failed|_exception|rejected|overflow|dropped|exhausted/.test(eventName)) return "error";
  if (/_attempt|retry_scheduled|disconnected|unavailable/.test(eventName)) return "warn";
  if (/_succeeded|route_connected/.test(eventName)) return "ok";
  return "info";
}

function stripCommonPrefix(eventName) {
  return eventName.startsWith("market_data.") ? eventName.slice("market_data.".length) : eventName;
}

function formatInstrumentL1(l1) {
  if (!l1) return "n/a";
  if (l1.recoveryState !== "READY") return l1.recoveryState;
  return l1.quiet ? "QUIET" : "LIVE";
}

function formatInstrumentL2(l2) {
  if (!l2) return "n/a";
  if (l2.status !== "UNAVAILABLE") return l2.status;
  return l2.reason ? `UNAVAILABLE (${l2.reason})` : "UNAVAILABLE";
}

function createCliLogger({ name, logDir = DEFAULT_LOG_DIR, stream = process.stdout, now = () => new Date(),
  maxPendingWrites = 4096, maxPendingBytes = 8 * 1024 * 1024, maxRecordBytes = 64 * 1024,
  flushTimeoutMs = 5000, appendFile = fs.promises.appendFile,
} = {}) {
  for (const limit of [maxPendingWrites, maxPendingBytes, maxRecordBytes, flushTimeoutMs]) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("cli-logger: limits must be positive safe integers");
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("createCliLogger: name must be a non-empty string");
  }
  if (typeof logDir !== "string" || logDir.length === 0) {
    throw new Error("createCliLogger: logDir must be a non-empty string");
  }
  if (!stream || typeof stream.write !== "function") {
    throw new Error("createCliLogger: stream must expose write()");
  }
  fs.mkdirSync(logDir, { recursive: true });
  let persistTail = Promise.resolve();
  let persistenceError = null;
  let pendingWrites = 0;
  let persistedRecords = 0;
  let streamWriteFailures = 0;
  let pendingBytes = 0;
  let droppedRecords = 0;
  let streamBlocked = false;
  let closed = false;
  const identity = Object.freeze({ runId: randomUUID(), pid: process.pid, parentPid: process.ppid });
  const onDrain = () => { streamBlocked = false; };

  const useColor = typeof stream.hasColors === "function" ? stream.hasColors() : false;

  function paint(code, text) {
    return useColor ? `${code}${text}${RESET}` : text;
  }

  function writeToStream(text) {
    if (streamBlocked || Buffer.byteLength(text) > maxRecordBytes) {
      streamWriteFailures += 1;
      return;
    }
    try {
      if (stream.write(text) === false) {
        streamBlocked = true;
        stream.once?.("drain", onDrain);
      }
    } catch {
      streamWriteFailures += 1;
    }
  }

  function logFilePath(date) {
    return path.join(logDir, `${name}-${formatDateKey(date)}.log`);
  }

  function persist(plainLine, date) {
    if (closed) return;
    const record = `${plainLine}  runId ${identity.runId}  pid ${identity.pid}  parentPid ${identity.parentPid}\n`;
    const bytes = Buffer.byteLength(record);
    if (pendingWrites >= maxPendingWrites || pendingBytes + bytes > maxPendingBytes || bytes > maxRecordBytes) {
      droppedRecords += 1;
      persistenceError ??= new Error("cli-logger: bounded persistence queue overflow");
      return;
    }
    const destination = logFilePath(date);
    pendingWrites += 1;
    pendingBytes += bytes;
    persistTail = persistTail
      .then(() => appendFile(destination, record))
      .then(() => {
        persistedRecords += 1;
      })
      .catch((error) => {
        persistenceError ??= error;
      })
      .finally(() => {
        pendingWrites -= 1;
        pendingBytes -= bytes;
      });
  }

  function writeLine(level, message, meta) {
    const date = now();
    const clock = formatClock(date);
    const label = LEVEL_LABELS[level];
    const metaText = formatMeta(meta);
    const safeMessage = singleLine(message);
    const plainLine = `${clock} ${label} ${safeMessage}${metaText}`;
    const coloredLine = `${paint(DIM, clock)} ${paint(COLORS[level], label)} ${safeMessage}${paint(DIM, metaText)}`;
    writeToStream(`${coloredLine}\n`);
    persist(plainLine, date);
  }

  function info(message, meta) {
    writeLine("info", message, meta);
  }

  function ok(message, meta) {
    writeLine("ok", message, meta);
  }

  function warn(message, meta) {
    writeLine("warn", message, meta);
  }

  function error(message, meta) {
    writeLine("error", message, meta);
  }

  function banner(lines) {
    if (!Array.isArray(lines) || lines.length === 0 || lines.some((line) => typeof line !== "string")) {
      throw new Error("createCliLogger: banner lines must be a non-empty string array");
    }
    const safeLines = lines.map(singleLine);
    const width = Math.max(...safeLines.map((line) => line.length)) + 2;
    const top = `+${"-".repeat(width)}+`;
    const bottom = `+${"-".repeat(width)}+`;
    const plainLines = [top];
    writeToStream(`${paint(DIM, top)}\n`);
    safeLines.forEach((line, index) => {
      const padded = ` ${line}`.padEnd(width);
      const styled = index === 0 ? `${BOLD}${COLORS.cyan}${padded}${RESET}` : `${DIM}${padded}${RESET}`;
      writeToStream(`${paint(DIM, "|")}${useColor ? styled : padded}${paint(DIM, "|")}\n`);
      plainLines.push(`|${padded}|`);
    });
    writeToStream(`${paint(DIM, bottom)}\n`);
    plainLines.push(bottom);
    persist(plainLines.join("\n"), now());
  }

  function instrumentTable(rows) {
    if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== "object")) {
      throw new Error("createCliLogger: instrumentTable rows must be an array of objects");
    }
    const headers = ["SYMBOL", "ASSET", "L1", "L2"];
    const cells = rows.map((row) => [
      singleLine(row.symbol),
      singleLine(row.assetClass),
      formatInstrumentL1(row.l1),
      formatInstrumentL2(row.l2),
    ]);
    const columnWidths = headers.map((header, col) => Math.max(header.length, ...cells.map((line) => line[col].length)));
    const formatRow = (values) => values.map((value, col) => value.padEnd(columnWidths[col])).join("   ").trimEnd();
    const headerLine = formatRow(headers);
    const dataLines = cells.map(formatRow);
    const date = now();
    const titleLine = "INSTRUMENTS";
    const clockLabel = `${formatClock(date)} UTC`;
    const bodyWidth = Math.max(headerLine.length, ...dataLines.map((line) => line.length), 0);
    const width = Math.max(bodyWidth, titleLine.length + 1 + clockLabel.length) + 2;
    const rule = `+${"-".repeat(width)}+`;
    const titleRow = `${titleLine}${" ".repeat(Math.max(1, width - titleLine.length - clockLabel.length))}${clockLabel}`;
    const bodyLines = [headerLine, ...dataLines];

    const plainLines = [rule];
    writeToStream(`${paint(DIM, rule)}\n`);

    const titlePadded = ` ${titleRow}`.padEnd(width);
    writeToStream(`${paint(DIM, "|")}${useColor ? `${BOLD}${COLORS.cyan}${titlePadded}${RESET}` : titlePadded}${paint(DIM, "|")}\n`);
    plainLines.push(`|${titlePadded}|`);

    writeToStream(`${paint(DIM, rule)}\n`);
    plainLines.push(rule);

    bodyLines.forEach((line, index) => {
      const padded = ` ${line}`.padEnd(width);
      const styled = index === 0 ? `${BOLD}${padded}${RESET}` : padded;
      writeToStream(`${paint(DIM, "|")}${useColor ? styled : padded}${paint(DIM, "|")}\n`);
      plainLines.push(`|${padded}|`);
    });

    writeToStream(`${paint(DIM, rule)}\n`);
    plainLines.push(rule);

    persist(plainLines.join("\n"), date);
  }

  function heartbeat(uptimeLabel, counters, nominal, degradedReason) {
    const date = now();
    const clock = formatClock(date);
    const counterText = formatCounters(counters);
    const statusText = nominal
      ? "current path nominal"
      : typeof degradedReason === "string" && degradedReason.length > 0
        ? degradedReason
        : "no new market data since last heartbeat";
    const coloredStatus = paint(nominal ? COLORS.ok : COLORS.warn, statusText);
    const coloredLine =
      `${paint(DIM, clock)} ${paint(COLORS.magenta, "*")} ${paint(COLORS.magenta, "heartbeat")}  ` +
      `${paint(DIM, "uptime")} ${uptimeLabel}  ${counterText}  ${paint(DIM, "-")} ${coloredStatus}`;
    const plainLine = `${clock} heartbeat  uptime ${uptimeLabel}  ${counterText}  ${statusText}`;
    writeToStream(`${coloredLine}\n`);
    persist(plainLine, date);
  }

  function telemetryLine(_prefixTag, jsonString) {
    let entry;
    try {
      entry = JSON.parse(jsonString);
    } catch {
      writeLine("info", String(jsonString));
      return;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      writeLine("info", String(jsonString));
      return;
    }
    const level = classifyTelemetryEvent(entry.event, entry);
    const label = stripCommonPrefix(String(entry.event ?? "telemetry"));
    const meta = { ...entry };
    delete meta.event;
    delete meta.ts;
    delete meta.severity;
    writeLine(level, label, meta);
  }

  function flush({ throwOnError = false } = {}) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("cli-logger: flush deadline exceeded")), flushTimeoutMs);
    });
    return Promise.race([persistTail, deadline]).then(() => {
      if (throwOnError && persistenceError) {
        throw new Error("cli-logger: durable log persistence failed");
      }
    }).finally(() => clearTimeout(timer));
  }

  function getStats() {
    return Object.freeze({
      operatorLogPersistenceHealthy: persistenceError === null,
      operatorLogOutputHealthy: streamWriteFailures === 0,
      operatorLogPendingWrites: pendingWrites,
      operatorLogPendingBytes: pendingBytes,
      operatorLogDroppedRecords: droppedRecords,
      operatorLogPersistedRecords: persistedRecords,
      operatorLogStreamWriteFailures: streamWriteFailures,
      operatorLogPersistenceError: persistenceError?.message ?? null,
    });
  }

  const close = () => { closed = true; stream.removeListener?.("drain", onDrain); streamBlocked = true; };
  return Object.freeze({ info, ok, warn, error, banner, instrumentTable, heartbeat, telemetryLine, flush, getStats, close, identity });
}

function flushAndExit(logger, exit, exitCode) {
  if (typeof exit !== "function") {
    throw new Error("flushAndExit: exit must be a function");
  }
  let pending;
  try {
    pending = logger?.flush?.({ throwOnError: true });
  } catch {
    exit(1);
    return Promise.resolve(1);
  }
  if (!pending || typeof pending.then !== "function") {
    exit(exitCode);
    return Promise.resolve(exitCode);
  }
  return Promise.resolve(pending).then(
    () => {
      exit(exitCode);
      return exitCode;
    },
    () => {
      exit(1);
      return 1;
    },
  );
}

module.exports = { createCliLogger, classifyTelemetryEvent, flushAndExit, DEFAULT_LOG_DIR };
