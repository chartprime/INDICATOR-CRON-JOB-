#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_URL = "http://127.0.0.1:8001/health";
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_WINDOW_MS = 30_000;
const STALL_MS = 1_000;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_ERR_TEXT = 240;
const MIB = 1024 * 1024;

function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function readinessStates(body) {
  const warmups = body?.readiness?.warmups;
  if (!warmups || typeof warmups !== "object") return {};
  const states = {};
  for (const [feature, entry] of Object.entries(warmups)) {
    if (entry && typeof entry.state === "string") states[feature.split(".").pop()] = entry.state;
  }
  return states;
}

function createLogTail({ logDir, name = "ws-server", fsImpl = fs, skipExistingOnStart = false }) {
  let file = null;
  let offset = 0;
  let firstRead = true;
  return function readNew(nowMs) {
    const skipExisting = firstRead && skipExistingOnStart;
    firstRead = false;
    const current = path.join(logDir, `${name}-${utcDate(nowMs)}.log`);
    if (current !== file) {
      file = current;
      offset = 0;
    }
    let size;
    try {
      size = fsImpl.statSync(file).size;
    } catch {
      return { warn: 0, errors: [] };
    }
    if (skipExisting) {
      offset = size;
      return { warn: 0, errors: [] };
    }
    if (size < offset) offset = 0;
    if (size === offset) return { warn: 0, errors: [] };
    const length = size - offset;
    const buffer = Buffer.alloc(length);
    const fd = fsImpl.openSync(file, "r");
    try {
      fsImpl.readSync(fd, buffer, 0, length, offset);
    } finally {
      fsImpl.closeSync(fd);
    }
    const text = buffer.toString("utf8");
    const complete = text.lastIndexOf("\n") + 1;
    offset += Buffer.byteLength(text.slice(0, complete));
    const lines = text.slice(0, complete).split("\n").filter(Boolean);
    return {
      warn: lines.filter((line) => / WARN /.test(line)).length,
      errors: lines.filter((line) => / ERR /.test(line)).map((line) => line.replace(/\s+runId .*$/, "").slice(0, MAX_ERR_TEXT)),
    };
  };
}

async function probe(url, fetchImpl, timeoutMs, clock) {
  const startedAt = clock();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    const body = await response.json();
    return { ok: response.status === 200 || response.status === 503, routeReady: response.status === 200, latencyMs: clock() - startedAt, body };
  } catch {
    return { ok: false, routeReady: false, latencyMs: clock() - startedAt, body: null };
  } finally {
    clearTimeout(timer);
  }
}

function createWindow() {
  return {
    probes: 0, failures: 0, routeNotReady: 0, maxDelayMs: 0, maxP99Ms: 0, maxProbeMs: 0, rssBytes: null, heapBytes: null,
    hostReadsPerMin: null, hostRateLimitedPerMin: null, readiness: {},
  };
}

function createRecorder({
  url = DEFAULT_URL,
  windowMs = DEFAULT_WINDOW_MS,
  fetchImpl = globalThis.fetch,
  clock = () => Date.now(),
  write,
  readLog = () => ({ warn: 0, errors: [] }),
  probeTimeoutMs = PROBE_TIMEOUT_MS,
}) {
  let window = createWindow();
  let windowStartedAt = clock();
  let lastStallSample = null;
  let lastGc = null;

  async function poll() {
    const result = await probe(url, fetchImpl, probeTimeoutMs, clock);
    window.probes += 1;
    window.maxProbeMs = Math.max(window.maxProbeMs, result.latencyMs);
    const runtime = result.body?.runtime;
    if (!result.ok || !runtime) {
      window.failures += 1;
    } else {
      if (!result.routeReady) window.routeNotReady += 1;
      window.maxDelayMs = Math.max(window.maxDelayMs, runtime.eventLoopMaxDelayMs ?? 0);
      window.maxP99Ms = Math.max(window.maxP99Ms, runtime.eventLoopP99DelayMs ?? 0);
      window.rssBytes = runtime.processRssBytes ?? window.rssBytes;
      window.heapBytes = runtime.processHeapUsedBytes ?? window.heapBytes;
      window.readiness = readinessStates(result.body);
      const hostReads = runtime.hostReads;
      if (hostReads && Number.isFinite(hostReads.requests)) {
        window.hostReadsPerMin = Math.max(window.hostReadsPerMin ?? 0, hostReads.requests);
        window.hostRateLimitedPerMin = Math.max(window.hostRateLimitedPerMin ?? 0, hostReads.rateLimited ?? 0);
      }
      const gc = { count: runtime.gcCount ?? 0, totalMs: runtime.gcTotalDurationMs ?? 0 };
      const sample = runtime.eventLoopSamples ?? null;
      if ((runtime.eventLoopMaxDelayMs ?? 0) > STALL_MS && (sample === null || sample !== lastStallSample)) {
        lastStallSample = sample;
        write({
          kind: "stall",
          at: new Date(clock()).toISOString(),
          delayMs: runtime.eventLoopMaxDelayMs,
          gcCountDelta: lastGc === null ? null : gc.count - lastGc.count,
          gcMsDelta: lastGc === null ? null : Number((gc.totalMs - lastGc.totalMs).toFixed(1)),
        });
      }
      lastGc = gc;
    }
    if (result.latencyMs > STALL_MS) {
      write({ kind: "slow_probe", at: new Date(clock()).toISOString(), latencyMs: result.latencyMs, ok: result.ok });
    }
    const now = clock();
    if (now - windowStartedAt >= windowMs) flush(now);
  }

  function flush(now = clock()) {
    const log = readLog(now);
    for (const text of log.errors) write({ kind: "error_line", at: new Date(now).toISOString(), text });
    write({
      kind: "window",
      from: new Date(windowStartedAt).toISOString(),
      to: new Date(now).toISOString(),
      probes: window.probes,
      failures: window.failures,
      routeNotReady: window.routeNotReady,
      hostReadsPerMin: window.hostReadsPerMin,
      hostRateLimitedPerMin: window.hostRateLimitedPerMin,
      maxEventLoopDelayMs: window.maxDelayMs,
      maxEventLoopP99Ms: window.maxP99Ms,
      maxProbeMs: window.maxProbeMs,
      rssMiB: window.rssBytes === null ? null : Number((window.rssBytes / MIB).toFixed(1)),
      heapMiB: window.heapBytes === null ? null : Number((window.heapBytes / MIB).toFixed(1)),
      warnLines: log.warn,
      errLines: log.errors.length,
      readiness: window.readiness,
    });
    window = createWindow();
    windowStartedAt = now;
  }

  return { poll, flush };
}

function slopePerHour(points) {
  if (points.length < 2) return null;
  const n = points.length;
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / n;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const [x, y] of points) {
    numerator += (x - meanX) * (y - meanY);
    denominator += (x - meanX) ** 2;
  }
  return denominator === 0 ? 0 : Number(((numerator / denominator) * 3_600_000).toFixed(2));
}

function summarize(records) {
  const windows = records.filter((record) => record.kind === "window");
  const stalls = records.filter((record) => record.kind === "stall");
  const errors = records.filter((record) => record.kind === "error_line");
  const coveredMs = windows.reduce((sum, w) => sum + Math.max(0, Date.parse(w.to) - Date.parse(w.from)), 0);
  const rss = windows.filter((w) => w.rssMiB !== null).map((w) => [Date.parse(w.to), w.rssMiB]);
  const heap = windows.filter((w) => w.heapMiB !== null).map((w) => [Date.parse(w.to), w.heapMiB]);
  const distinctErrors = [...new Set(errors.map((e) => e.text.replace(/^\d\d:\d\d:\d\d\s+/, "")))];
  return {
    hoursRecorded: Number((coveredMs / 3_600_000).toFixed(2)),
    windows: windows.length,
    probeFailures: windows.reduce((sum, w) => sum + w.failures, 0),
    routeNotReadyMinutes: Number((windows.reduce((sum, w) => sum + (w.routeNotReady ?? 0), 0) * (DEFAULT_POLL_MS / 60_000)).toFixed(1)),
    hostReadsPeakPerMin: windows.reduce((max, w) => Math.max(max, w.hostReadsPerMin ?? 0), 0),
    hostRateLimitedPeakPerMin: windows.reduce((max, w) => Math.max(max, w.hostRateLimitedPerMin ?? 0), 0),
    stallsOver1s: stalls.length,
    worstEventLoopDelayMs: windows.reduce((max, w) => Math.max(max, w.maxEventLoopDelayMs), 0),
    worstEventLoopP99Ms: windows.reduce((max, w) => Math.max(max, w.maxEventLoopP99Ms), 0),
    rssMiB: rss.length === 0 ? null : { first: rss[0][1], last: rss.at(-1)[1], max: Math.max(...rss.map(([, y]) => y)), slopePerHour: slopePerHour(rss) },
    heapMiB: heap.length === 0 ? null : { first: heap[0][1], last: heap.at(-1)[1], max: Math.max(...heap.map(([, y]) => y)), slopePerHour: slopePerHour(heap) },
    warnLines: windows.reduce((sum, w) => sum + w.warnLines, 0),
    errLines: errors.length,
    distinctErrors,
  };
}

function readRecords(files, fsImpl = fs) {
  return files.flatMap((file) => fsImpl.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const options = { mode, url: DEFAULT_URL, windowS: DEFAULT_WINDOW_MS / 1000, out: null, logDir: null, files: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const next = () => {
      index += 1;
      if (rest[index] === undefined) throw new Error(`health-recorder: ${arg} needs a value`);
      return rest[index];
    };
    if (arg === "--url") options.url = next();
    else if (arg === "--window-s") options.windowS = Number(next());
    else if (arg === "--out") options.out = next();
    else if (arg === "--log-dir") options.logDir = next();
    else if (mode === "summary") options.files.push(arg);
    else throw new Error(`health-recorder: unknown argument ${arg}`);
  }
  if (mode !== "record" && mode !== "summary") throw new Error("usage: health-recorder.js record [--url U] [--out file.jsonl] [--window-s 30] [--log-dir D] | summary file.jsonl...");
  if (mode === "record" && (!Number.isFinite(options.windowS) || options.windowS <= 0)) throw new Error("health-recorder: --window-s must be positive");
  if (mode === "summary" && options.files.length === 0) throw new Error("health-recorder: summary needs at least one file");
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.mode === "summary") {
    process.stdout.write(`${JSON.stringify(summarize(readRecords(options.files)), null, 2)}\n`);
    return null;
  }
  const { logDir: defaultLogDir } = require("../../src/platform/runtime-paths");
  const out = options.out ?? path.resolve(`health-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const write = (record) => fs.appendFileSync(out, `${JSON.stringify(record)}\n`);
  const recorder = createRecorder({
    url: options.url,
    windowMs: options.windowS * 1000,
    write,
    readLog: createLogTail({ logDir: options.logDir ?? defaultLogDir(), skipExistingOnStart: true }),
  });
  process.stdout.write(`health-recorder: polling ${options.url} every 1 s, writing ${out}; Ctrl-C to stop\n`);
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    recorder.poll().finally(() => { busy = false; });
  }, DEFAULT_POLL_MS);
  const stop = () => {
    clearInterval(timer);
    recorder.flush();
    process.stdout.write(`health-recorder: stopped; summarise with: node scripts/bench/health-recorder.js summary ${out}\n`);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return timer;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 2;
  }
}

module.exports = { createRecorder, createLogTail, summarize, slopePerHour, parseArgs, readinessStates, STALL_MS };
