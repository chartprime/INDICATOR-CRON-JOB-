"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  runBrowserScenario, validateBrowserManifest, resolveChromePath, describeWebDist, digestFiles, deriveTimings, deriveSelectionTrace,
} = require("../../../scripts/bench/browser-load");
const { run: runBrowserSession } = require("../../../scripts/qualify/qualify-day3-browser");

const manifestOf = (overrides = {}) => ({
  version: 1, kind: "browser", name: "test", scenario: "steady-tape", durationSeconds: 10,
  upstream: { tradesPerPulse: 10, pulseMs: 20 },
  ...overrides,
});

const sessionResult = (overrides = {}) => ({
  sent: 100, observedTapeCommits: 100, newestCommittedId: 100, tapeRows: 60, canvases: 7,
  eventToTapeDomCommitMs: { samples: 100, p50: 20, p95: 40, p99: 50, max: 60 },
  longTaskMs: { samples: 0, p50: null, p95: null, p99: null, max: null }, memory: [], pageErrors: [], tapeRowsAfterDisconnect: 0,
  browserProduct: "Chrome/1.0", pass: true,
  timing: {
    navigatedAtMs: 1_000, connectedAtMs: 1_300, firstTradePublishedAtMs: 1_800, selectionSentAtMs: null, selectionTradeIdFloor: null,
    firstCommitAtMs: 1_823, firstAfterSelectionAtMs: null,
  },
  ...overrides,
});

describe("scripts/bench/browser-load", () => {
  describe("manifest validation", () => {
    test("accepts one manifest per scenario", () => {
      expect(() => validateBrowserManifest(manifestOf({ scenario: "cold-start", durationSeconds: 5 }))).not.toThrow();
      expect(() => validateBrowserManifest(manifestOf())).not.toThrow();
      expect(() => validateBrowserManifest(manifestOf({ scenario: "selection-change", selectionChangeAtSeconds: 5 }))).not.toThrow();
      expect(() => validateBrowserManifest(manifestOf({ observability: { selectionTrace: true, performanceEntries: ["longtask", "event", "paint"] } }))).not.toThrow();
    });

    test.each([
      ["a wrong kind", { kind: "ws-fanout" }, /kind/],
      ["an unknown key", { extra: 1 }, /unknown keys extra/],
      ["a paint setting, which belongs to a later phase", { paint: true }, /unknown keys paint/],
      ["an input-latency setting, which belongs to a later phase", { inp: true }, /unknown keys inp/],
      ["no name", { name: "" }, /name/],
      ["an unknown scenario", { scenario: "paint" }, /scenario/],
      ["a zero duration", { durationSeconds: 0 }, /durationSeconds/],
      ["a duration past the cap", { durationSeconds: 601 }, /durationSeconds/],
      ["an unbounded trade rate", { upstream: { tradesPerPulse: 401, pulseMs: 20 } }, /tradesPerPulse/],
      ["a too-fast pulse", { upstream: { tradesPerPulse: 1, pulseMs: 4 } }, /pulseMs/],
      ["unknown upstream keys", { upstream: { tradesPerPulse: 1, pulseMs: 20, seed: 1 } }, /unknown keys seed/],
      ["a selection change on a steady-tape run", { selectionChangeAtSeconds: 5 }, /only valid for the selection-change scenario/],
      ["a selection-change run without a change time", { scenario: "selection-change" }, /selectionChangeAtSeconds/],
      ["a selection change at second zero", { scenario: "selection-change", selectionChangeAtSeconds: 0 }, /selectionChangeAtSeconds/],
      ["a selection change at the end of the run", { scenario: "selection-change", selectionChangeAtSeconds: 10 }, /selectionChangeAtSeconds/],
      ["a fractional selection change", { scenario: "selection-change", selectionChangeAtSeconds: 2.5 }, /selectionChangeAtSeconds/],
      ["an unknown observability key", { observability: { selectionTrace: true, performanceEntries: [], cursor: true } }, /unknown keys cursor/],
      ["duplicate performance entries", { observability: { selectionTrace: true, performanceEntries: ["paint", "paint"] } }, /unique/],
    ])("rejects %s", (_label, overrides, pattern) => {
      expect(() => validateBrowserManifest(manifestOf(overrides))).toThrow(pattern);
    });
  });

  describe("Chrome discovery", () => {
    const exists = (...present) => (candidate) => present.includes(candidate);

    test("the environment variable wins and must point at a real file", () => {
      expect(resolveChromePath({ env: { TT_BENCH_CHROME_PATH: "/opt/chrome" }, platform: "linux", exists: exists("/opt/chrome", "/usr/bin/chromium") })).toBe("/opt/chrome");
      expect(() => resolveChromePath({ env: { TT_BENCH_CHROME_PATH: "/opt/missing" }, platform: "linux", exists: exists("/usr/bin/chromium") }))
        .toThrow(/TT_BENCH_CHROME_PATH does not exist: \/opt\/missing/);
    });

    test("on Windows it tries Program Files, Program Files (x86) and the local app data directory in order", () => {
      const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
      const third = path.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe");
      const first = path.join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe");
      expect(resolveChromePath({ env, platform: "win32", exists: exists(third) })).toBe(third);
      expect(resolveChromePath({ env, platform: "win32", exists: exists(third, first) })).toBe(first);
    });

    test("uses the standard macOS and Linux locations", () => {
      expect(resolveChromePath({ env: {}, platform: "darwin", exists: exists("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") }))
        .toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
      expect(resolveChromePath({ env: {}, platform: "linux", exists: exists("/usr/bin/chromium") })).toBe("/usr/bin/chromium");
    });

    test("fails with a message that says what was tried and how to fix it", () => {
      expect(() => resolveChromePath({ env: {}, platform: "linux", exists: () => false })).toThrow(/set TT_BENCH_CHROME_PATH.*\/usr\/bin\/google-chrome/);
      expect(() => resolveChromePath({ env: {}, platform: "win32", exists: () => false })).toThrow(/no Chrome found/);
    });
  });

  describe("web build identity", () => {
    let dir;
    const write = (relative, content) => {
      const target = path.join(dir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    };

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-dist-"));
    });

    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("counts files and bytes and digests names together with contents", () => {
      write("index.html", "<html></html>");
      write("assets/app-1.js", "console.log(1)");
      const info = describeWebDist(dir);
      expect(info).toMatchObject({ fileCount: 2, totalBytes: 13 + 14, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    });

    test("the digest does not depend on the order files were written", () => {
      write("index.html", "a");
      write("assets/x.js", "b");
      write("assets/y.js", "c");
      const first = describeWebDist(dir).sha256;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      write("assets/y.js", "c");
      write("assets/x.js", "b");
      write("index.html", "a");
      expect(describeWebDist(dir).sha256).toBe(first);
    });

    test("changing a byte or renaming a file changes the digest", () => {
      write("index.html", "a");
      write("assets/x.js", "b");
      const original = describeWebDist(dir).sha256;
      write("assets/x.js", "c");
      const edited = describeWebDist(dir).sha256;
      expect(edited).not.toBe(original);
      fs.renameSync(path.join(dir, "assets/x.js"), path.join(dir, "assets/z.js"));
      expect(describeWebDist(dir).sha256).not.toBe(edited);
    });

    test("digesting is independent of the order the files are listed in", () => {
      const files = [
        { relative: "index.html", bytes: Buffer.from("a") },
        { relative: "assets/x.js", bytes: Buffer.from("b") },
        { relative: "assets/y.js", bytes: Buffer.from("c") },
      ];
      const expected = digestFiles(files).sha256;
      expect(digestFiles([files[2], files[0], files[1]]).sha256).toBe(expected);
      expect(digestFiles([...files].reverse()).sha256).toBe(expected);
    });

    test("digesting binds each name to its own contents, so swapping contents between two files changes it", () => {
      const original = digestFiles([{ relative: "a.js", bytes: Buffer.from("1") }, { relative: "b.js", bytes: Buffer.from("2") }]).sha256;
      const swapped = digestFiles([{ relative: "a.js", bytes: Buffer.from("2") }, { relative: "b.js", bytes: Buffer.from("1") }]).sha256;
      expect(swapped).not.toBe(original);
    });

    test("the same contents under a different name digest differently", () => {
      expect(digestFiles([{ relative: "a.js", bytes: Buffer.from("1") }]).sha256)
        .not.toBe(digestFiles([{ relative: "b.js", bytes: Buffer.from("1") }]).sha256);
    });

    test("a missing build says how to produce it", () => {
      expect(() => describeWebDist(dir)).toThrow(/npm run build --workspace web/);
    });
  });

  describe("browser session arguments", () => {
    const session = (overrides) => runBrowserSession({ chromePath: process.execPath, durationSeconds: 10, ...overrides });

    test.each([
      ["a missing Chrome binary", { chromePath: path.join(os.tmpdir(), "no-such-chrome") }, /invalid Chrome path or duration/],
      ["a zero duration", { durationSeconds: 0 }, /invalid Chrome path or duration/],
      ["zero trades per pulse", { tradesPerPulse: 0 }, /invalid trade rate/],
      ["too many trades per pulse", { tradesPerPulse: 401 }, /invalid trade rate/],
      ["a fractional trade count", { tradesPerPulse: 1.5 }, /invalid trade rate/],
      ["a too-fast pulse", { pulseMs: 4 }, /invalid trade rate/],
      ["a too-slow pulse", { pulseMs: 1_001 }, /invalid trade rate/],
      ["a selection change at second zero", { selectionChangeAtSeconds: 0 }, /invalid selectionChangeAtSeconds/],
      ["a selection change at the end of the run", { selectionChangeAtSeconds: 10 }, /invalid selectionChangeAtSeconds/],
      ["a fractional selection change", { selectionChangeAtSeconds: 2.5 }, /invalid selectionChangeAtSeconds/],
    ])("rejects %s before starting anything", async (_label, overrides, pattern) => {
      await expect(session(overrides)).rejects.toThrow(pattern);
    });
  });

  describe("derived timings", () => {
    test("computes the intervals the scenarios report", () => {
      expect(deriveTimings(sessionResult())).toEqual({ navigationToWebSocketConnectMs: 300, firstTradePublishedToFirstCommitMs: 23 });
    });

    test("adds the selection interval only when a selection was sent", () => {
      const timing = { ...sessionResult().timing, selectionSentAtMs: 5_000, selectionTradeIdFloor: 90, firstAfterSelectionAtMs: 5_051 };
      expect(deriveTimings(sessionResult({ timing }))).toMatchObject({ selectionFrameToFirstNewTradeCommitMs: 51 });
    });

    test("reports null rather than a fabricated interval when an endpoint was never observed", () => {
      const timing = { ...sessionResult().timing, firstCommitAtMs: null, selectionSentAtMs: 5_000, firstAfterSelectionAtMs: null };
      expect(deriveTimings(sessionResult({ timing }))).toEqual({
        navigationToWebSocketConnectMs: 300, firstTradePublishedToFirstCommitMs: null, selectionFrameToFirstNewTradeCommitMs: null,
      });
    });

    test("rejects a physically impossible cross-context selection trace instead of publishing negative stages", () => {
      const base = {
        outcome: "COMPLETE", requestedAtMs: 100, workerSentAtMs: 110, workerReceivedAtMs: 120,
        workerParsedAtMs: 121, mainReceivedAtMs: 125, reactAppliedAtMs: 126, chartCommittedAtMs: 130, firstPaintAtMs: 146,
      };
      expect(deriveSelectionTrace(base)).toMatchObject({ ordered: true, durationsMs: { requestToFirstPaint: 46, workerParse: 1 } });
      expect(deriveSelectionTrace({ ...base, workerSentAtMs: 90 })).toMatchObject({ ordered: false });
    });
  });

  describe("running a scenario", () => {
    const distInfo = { fileCount: 3, totalBytes: 100, sha256: "d".repeat(64) };
    const provenance = { git: null, scriptSha256: "s", manifestSha256: "m", nodeVersion: "v24" };

    test("hands the manifest's rate and duration to the browser session and shapes the report", async () => {
      const runImpl = jest.fn(async () => sessionResult());
      const report = await runBrowserScenario({
        manifest: manifestOf({ upstream: { tradesPerPulse: 40, pulseMs: 20 } }), chromePath: "chrome", provenance, distInfo, runImpl,
      });
      expect(runImpl).toHaveBeenCalledWith({ chromePath: "chrome", durationSeconds: 10, tradesPerPulse: 40, pulseMs: 20, selectionChangeAtSeconds: null });
      expect(report).toMatchObject({
        contractVersion: 1, kind: "browser", name: "test", scenario: "steady-tape", pass: true,
        source: { ...provenance, webDist: distInfo, browser: "Chrome/1.0" },
        settings: { durationSeconds: 10, upstream: { tradesPerPulse: 40, pulseMs: 20 }, selectionChangeAtSeconds: null },
        timings: { navigationToWebSocketConnectMs: 300, firstTradePublishedToFirstCommitMs: 23 },
        tape: { published: 100, committed: 100, newestCommittedId: 100, rowsRetained: 60 },
        invariants: {
          latestPublishedTradeReachedTheDom: true, noPageErrors: true, tapeRowsBounded: true, chartCanvasesPresent: true,
          tapeWithdrawnOnDisconnect: true, selectionHonoured: null,
        },
      });
    });

    test("only the selection-change scenario asks the session to change the selection", async () => {
      const runImpl = jest.fn(async () => sessionResult({
        timing: { ...sessionResult().timing, selectionSentAtMs: 5_000, selectionTradeIdFloor: 90, firstAfterSelectionAtMs: 5_040 },
      }));
      const report = await runBrowserScenario({
        manifest: manifestOf({ scenario: "selection-change", selectionChangeAtSeconds: 5 }), chromePath: "chrome", distInfo, runImpl,
      });
      expect(runImpl.mock.calls[0][0].selectionChangeAtSeconds).toBe(5);
      expect(report.timings.selectionFrameToFirstNewTradeCommitMs).toBe(40);
      expect(report.invariants.selectionHonoured).toBe(true);
      expect(report.pass).toBe(true);
    });

    test("latest-frame delivery is not mislabeled as one DOM commit per published trade", async () => {
      const report = await runBrowserScenario({
        manifest: manifestOf(), chromePath: "chrome", distInfo,
        runImpl: async () => sessionResult({ sent: 100, observedTapeCommits: 80, newestCommittedId: 100 }),
      });
      expect(report.tape).toMatchObject({ published: 100, committed: 80, newestCommittedId: 100 });
      expect(report.invariants.latestPublishedTradeReachedTheDom).toBe(true);
      expect(report.invariants).not.toHaveProperty("everyPublishedTradeReachedTheDom");
    });

    test("a selection the page never showed fails the run even though the session itself passed", async () => {
      const report = await runBrowserScenario({
        manifest: manifestOf({ scenario: "selection-change", selectionChangeAtSeconds: 5 }), chromePath: "chrome", distInfo,
        runImpl: async () => sessionResult({ timing: { ...sessionResult().timing, selectionSentAtMs: 5_000, selectionTradeIdFloor: 90, firstAfterSelectionAtMs: null } }),
      });
      expect(report.invariants.selectionHonoured).toBe(false);
      expect(report.timings.selectionFrameToFirstNewTradeCommitMs).toBeNull();
      expect(report.pass).toBe(false);
    });

    test("missing or unordered required selection spans are classified as UNINSTRUMENTED", async () => {
      const manifest = manifestOf({
        scenario: "selection-change", selectionChangeAtSeconds: 5,
        observability: { selectionTrace: true, performanceEntries: ["longtask", "event", "paint"] },
      });
      const timing = { ...sessionResult().timing, selectionSentAtMs: 5_000, selectionTradeIdFloor: 90, firstAfterSelectionAtMs: 5_040 };
      const missing = await runBrowserScenario({
        manifest, chromePath: "chrome", distInfo,
        runImpl: async () => sessionResult({ timing, selectionTraces: [], performanceEntries: [] }),
      });
      expect(missing.browserTrace.classification).toBe("UNINSTRUMENTED");
      expect(missing.invariants.selectionTraceComplete).toBe(false);
      expect(missing.pass).toBe(false);

      const unorderedTrace = {
        outcome: "COMPLETE", requestedAtMs: 100, workerSentAtMs: 90, workerReceivedAtMs: 120,
        workerParsedAtMs: 121, mainReceivedAtMs: 125, reactAppliedAtMs: 126, chartCommittedAtMs: 130, firstPaintAtMs: 146,
      };
      const unordered = await runBrowserScenario({
        manifest, chromePath: "chrome", distInfo,
        runImpl: async () => sessionResult({ timing, selectionTraces: [unorderedTrace], performanceEntries: [] }),
      });
      expect(unordered.browserTrace.classification).toBe("UNINSTRUMENTED");
      expect(unordered.pass).toBe(false);
    });

    test("page errors, an unbounded tape or lost trades are visible in the invariants and fail the run", async () => {
      const report = await runBrowserScenario({
        manifest: manifestOf(), chromePath: "chrome", distInfo,
        runImpl: async () => sessionResult({ pageErrors: ["boom"], tapeRows: 101, newestCommittedId: 99, canvases: 0, tapeRowsAfterDisconnect: 3, pass: false }),
      });
      expect(report.invariants).toMatchObject({
        latestPublishedTradeReachedTheDom: false, noPageErrors: false, tapeRowsBounded: false, chartCanvasesPresent: false, tapeWithdrawnOnDisconnect: false,
      });
      expect(report.pageErrors).toEqual(["boom"]);
      expect(report.pass).toBe(false);
    });

    test("an invalid manifest fails before the browser is started", async () => {
      const runImpl = jest.fn();
      await expect(runBrowserScenario({ manifest: manifestOf({ scenario: "paint" }), chromePath: "chrome", distInfo, runImpl })).rejects.toThrow(/scenario/);
      expect(runImpl).not.toHaveBeenCalled();
    });

    test("carries no source block when no provenance is supplied", async () => {
      const report = await runBrowserScenario({ manifest: manifestOf(), chromePath: "chrome", distInfo, runImpl: async () => sessionResult() });
      expect(report.source).toBeUndefined();
    });
  });

  describe("real browser", () => {
    const enabled = process.env.TT_TEST_REAL_BROWSER === "1";
    (enabled ? test : test.skip)("a cold start against the built web app connects, commits the first trade and passes every invariant", async () => {
      const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../../benchmarks/browser/cold-start.json"), "utf8"));
      const report = await runBrowserScenario({ manifest, chromePath: resolveChromePath() });
      expect(report.pass).toBe(true);
      expect(report.timings.navigationToWebSocketConnectMs).toBeGreaterThan(0);
      expect(report.timings.firstTradePublishedToFirstCommitMs).toBeGreaterThan(0);
      expect(report.source).toBeUndefined();
    }, 60_000);
  });
});
