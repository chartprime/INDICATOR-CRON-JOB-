#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { collectToolProvenance } = require("./live-storage-load");
const { run: runBrowserSession } = require("../qualify/qualify-day3-browser");

const REPORT_CONTRACT_VERSION = 1;
const KIND = "browser";
const SCENARIOS = Object.freeze(["cold-start", "steady-tape", "selection-change"]);
const MAX_DURATION_SECONDS = 600;
const WEB_DIST = path.resolve(__dirname, "../../../web/dist");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`browser-load: ${label} must be an integer ${min}..${max}`);
  }
}

function validateBrowserManifest(value) {
  if (!isRecord(value) || value.version !== 1 || value.kind !== KIND) {
    throw new Error(`browser-load: manifest must be version 1 with kind "${KIND}"`);
  }
  const allowed = ["version", "kind", "name", "scenario", "durationSeconds", "upstream", "selectionChangeAtSeconds", "observability"];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`browser-load: manifest has unknown keys ${unknown.sort().join(",")}`);
  if (typeof value.name !== "string" || value.name.length === 0) throw new Error("browser-load: name must be a non-empty string");
  if (!SCENARIOS.includes(value.scenario)) throw new Error(`browser-load: scenario must be one of ${SCENARIOS.join(", ")}`);
  boundedInteger(value.durationSeconds, 1, MAX_DURATION_SECONDS, "durationSeconds");
  if (!isRecord(value.upstream)) throw new Error("browser-load: upstream must be an object");
  const unknownUpstream = Object.keys(value.upstream).filter((key) => key !== "tradesPerPulse" && key !== "pulseMs");
  if (unknownUpstream.length > 0) throw new Error(`browser-load: upstream has unknown keys ${unknownUpstream.sort().join(",")}`);
  boundedInteger(value.upstream.tradesPerPulse, 1, 400, "upstream.tradesPerPulse");
  boundedInteger(value.upstream.pulseMs, 5, 1_000, "upstream.pulseMs");
  if (value.observability !== undefined) {
    if (!isRecord(value.observability)) throw new Error("browser-load: observability must be an object");
    const unknownObservability = Object.keys(value.observability).filter((key) => key !== "selectionTrace" && key !== "performanceEntries");
    if (unknownObservability.length > 0) throw new Error(`browser-load: observability has unknown keys ${unknownObservability.sort().join(",")}`);
    if (typeof value.observability.selectionTrace !== "boolean") throw new Error("browser-load: observability.selectionTrace must be boolean");
    if (!Array.isArray(value.observability.performanceEntries) || value.observability.performanceEntries.some((entry) => !["longtask", "event", "paint"].includes(entry)) || new Set(value.observability.performanceEntries).size !== value.observability.performanceEntries.length) {
      throw new Error("browser-load: observability.performanceEntries must contain unique longtask/event/paint values");
    }
  }
  if (value.scenario === "selection-change") {
    boundedInteger(value.selectionChangeAtSeconds, 1, value.durationSeconds - 1, "selectionChangeAtSeconds (a whole second inside the run)");
  } else if (value.selectionChangeAtSeconds !== undefined) {
    throw new Error(`browser-load: selectionChangeAtSeconds is only valid for the selection-change scenario`);
  }
  return value;
}

function chromeCandidates(env, platform) {
  if (platform === "win32") {
    return [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]
      .filter((base) => typeof base === "string" && base.length > 0)
      .map((base) => path.join(base, "Google", "Chrome", "Application", "chrome.exe"));
  }
  if (platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

function resolveChromePath({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const configured = env.TT_BENCH_CHROME_PATH;
  if (typeof configured === "string" && configured.length > 0) {
    if (!exists(configured)) throw new Error(`browser-load: TT_BENCH_CHROME_PATH does not exist: ${configured}`);
    return configured;
  }
  const candidates = chromeCandidates(env, platform);
  const found = candidates.find((candidate) => exists(candidate));
  if (found === undefined) {
    throw new Error(`browser-load: no Chrome found; set TT_BENCH_CHROME_PATH. Looked in: ${candidates.join(", ") || "(no default locations for this platform)"}`);
  }
  return found;
}

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory() ? listFiles(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}

function digestFiles(unsortedFiles) {
  const files = [...unsortedFiles].sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0);
  const digest = crypto.createHash("sha256");
  for (const file of files) {
    digest.update(`${file.relative}\0${crypto.createHash("sha256").update(file.bytes).digest("hex")}\n`);
  }
  return { fileCount: files.length, totalBytes: files.reduce((total, file) => total + file.bytes.length, 0), sha256: digest.digest("hex") };
}

function describeWebDist(distDir = WEB_DIST) {
  if (!fs.existsSync(path.join(distDir, "index.html"))) {
    throw new Error("browser-load: apps/web/dist/index.html not found; build the web app first with `npm run build --workspace web`");
  }
  return digestFiles(listFiles(distDir).map((file) => ({
    relative: path.relative(distDir, file).split(path.sep).join("/"),
    bytes: fs.readFileSync(file),
  })));
}

function interval(later, earlier) {
  return Number.isFinite(later) && Number.isFinite(earlier) ? later - earlier : null;
}

function deriveTimings(result) {
  const { timing } = result;
  return {
    navigationToWebSocketConnectMs: interval(timing.connectedAtMs, timing.navigatedAtMs),
    firstTradePublishedToFirstCommitMs: interval(timing.firstCommitAtMs, timing.firstTradePublishedAtMs),
    ...(timing.selectionSentAtMs === null ? {} : {
      selectionFrameToFirstNewTradeCommitMs: interval(timing.firstAfterSelectionAtMs, timing.selectionSentAtMs),
    }),
  };
}

function deriveSelectionTrace(trace) {
  const milestones = [
    trace.requestedAtMs, trace.workerSentAtMs, trace.workerReceivedAtMs, trace.workerParsedAtMs,
    trace.mainReceivedAtMs, trace.reactAppliedAtMs, trace.chartCommittedAtMs, trace.firstPaintAtMs,
  ];
  const complete = trace.outcome === "COMPLETE" && milestones.every(Number.isFinite);
  const ordered = complete && milestones.every((value, index) => index === 0 || value >= milestones[index - 1]);
  return {
    ...trace,
    ordered,
    durationsMs: complete ? {
      requestToWorkerSend: trace.workerSentAtMs - trace.requestedAtMs,
      transportToWorkerReceive: trace.workerReceivedAtMs - trace.workerSentAtMs,
      workerParse: trace.workerParsedAtMs - trace.workerReceivedAtMs,
      workerPostToMainReceive: trace.mainReceivedAtMs - trace.workerParsedAtMs,
      reactApply: trace.reactAppliedAtMs - trace.mainReceivedAtMs,
      snapshotToChartCommit: trace.chartCommittedAtMs - trace.reactAppliedAtMs,
      chartCommitToFirstPaint: trace.firstPaintAtMs - trace.chartCommittedAtMs,
      requestToFirstPaint: trace.firstPaintAtMs - trace.requestedAtMs,
    } : null,
  };
}

async function runBrowserScenario({ manifest, chromePath, provenance = null, distInfo = describeWebDist(), runImpl = runBrowserSession }) {
  validateBrowserManifest(manifest);
  const startedAtUtc = new Date().toISOString();
  const result = await runImpl({
    chromePath,
    durationSeconds: manifest.durationSeconds,
    tradesPerPulse: manifest.upstream.tradesPerPulse,
    pulseMs: manifest.upstream.pulseMs,
    selectionChangeAtSeconds: manifest.scenario === "selection-change" ? manifest.selectionChangeAtSeconds : null,
  });
  const derived = deriveTimings(result);
  const selectionTraces = (result.selectionTraces ?? []).map(deriveSelectionTrace);
  return {
    contractVersion: REPORT_CONTRACT_VERSION,
    kind: KIND,
    name: manifest.name,
    scenario: manifest.scenario,
    ...(provenance === null ? {} : { source: { ...provenance, webDist: distInfo, browser: result.browserProduct ?? null } }),
    startedAtUtc,
    settings: {
      durationSeconds: manifest.durationSeconds,
      upstream: manifest.upstream,
      selectionChangeAtSeconds: manifest.selectionChangeAtSeconds ?? null,
      observability: manifest.observability ?? null,
    },
    timings: derived,
    tape: {
      published: result.sent,
      committed: result.observedTapeCommits,
      newestCommittedId: result.newestCommittedId,
      rowsRetained: result.tapeRows,
      eventToDomCommitMs: result.eventToTapeDomCommitMs,
    },
    longTaskMs: result.longTaskMs,
    browserTrace: manifest.observability === undefined ? null : {
      selectionTraces: manifest.observability.selectionTrace ? selectionTraces : [],
      performanceEntries: (result.performanceEntries ?? []).filter((entry) => manifest.observability.performanceEntries.includes(entry.entryType)),
      classification: manifest.observability.selectionTrace && !selectionTraces.some((trace) => trace.outcome === "COMPLETE" && trace.ordered)
        ? "UNINSTRUMENTED"
        : "COMPLETE",
    },
    memory: result.memory,
    pageErrors: result.pageErrors,
    invariants: {
      latestPublishedTradeReachedTheDom: result.newestCommittedId === result.sent,
      noPageErrors: result.pageErrors.length === 0,
      tapeRowsBounded: result.tapeRows <= 100,
      chartCanvasesPresent: result.canvases > 0,
      tapeWithdrawnOnDisconnect: result.tapeRowsAfterDisconnect === 0,
      selectionHonoured: manifest.scenario === "selection-change" ? result.timing.firstAfterSelectionAtMs !== null : null,
      selectionTraceComplete: manifest.observability?.selectionTrace === true
        ? selectionTraces.some((trace) => trace.outcome === "COMPLETE" && trace.ordered)
        : null,
    },
    pass: result.pass &&
      (manifest.scenario !== "selection-change" || result.timing.firstAfterSelectionAtMs !== null) &&
      (manifest.observability?.selectionTrace !== true || selectionTraces.some((trace) => trace.outcome === "COMPLETE" && trace.ordered)),
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const manifestPath = argv[0];
  if (!manifestPath) throw new Error("usage: browser-load <manifest.json> [output.json]");
  const manifestBytes = fs.readFileSync(path.resolve(manifestPath));
  const manifest = validateBrowserManifest(JSON.parse(manifestBytes.toString("utf8")));
  const chromePath = resolveChromePath({ env });
  const provenance = collectToolProvenance({ manifestBytes, scriptPath: __filename });
  const report = await runBrowserScenario({ manifest, chromePath, provenance });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (argv[1]) {
    const outputPath = path.resolve(argv[1]);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporaryPath = `${outputPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporaryPath, outputPath);
  } else {
    process.stdout.write(serialized);
  }
  if (!report.pass) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}

module.exports = {
  main, runBrowserScenario, validateBrowserManifest, resolveChromePath, describeWebDist, digestFiles, deriveTimings, deriveSelectionTrace, SCENARIOS,
};
