"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { validateManifest } = require("../../../scripts/bench/live-storage-load");
const { validateFanoutManifest } = require("../../../scripts/bench/ws-fanout-load");
const { validateBrowserManifest } = require("../../../scripts/bench/browser-load");
const { ROUTES, DXFEED_ROUTES, validatePayload, validateQueryBounds } = require("../../../src/server/live-storage-route");

const BENCHMARKS = path.resolve(__dirname, "../../../../../benchmarks");
const HTTP_DIRECTORIES = ["live-storage", "archive"];

function loadManifests(directories) {
  return directories.flatMap((directory) => fs.readdirSync(path.join(BENCHMARKS, directory))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const relative = `${directory}/${file}`;
      return { relative, manifest: JSON.parse(fs.readFileSync(path.join(BENCHMARKS, directory, file), "utf8")) };
    }));
}

describe("committed benchmark manifests", () => {
  const manifests = loadManifests(HTTP_DIRECTORIES);
  const fanoutManifests = loadManifests(["ws"]);
  const browserManifests = loadManifests(["browser"]);

  test("the benchmark directories contain manifests to check", () => {
    expect(manifests.length).toBeGreaterThan(20);
  });

  test.each(manifests.map(({ relative, manifest }) => [relative, manifest]))("%s passes the runner's own validation", (_relative, manifest) => {
    expect(() => validateManifest(manifest)).not.toThrow();
    expect(typeof manifest.name).toBe("string");
    expect(manifest.name.length).toBeGreaterThan(0);
  });

  test("every manifest name is unique across all four benchmark kinds, so a report identifies exactly one workload", () => {
    const names = [...manifests, ...fanoutManifests, ...browserManifests].map(({ manifest }) => manifest.name);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  describe("WebSocket fan-out manifests", () => {
    test("the ws directory contains the fan-out, eviction and transient-stall workloads", () => {
      expect(fanoutManifests.map(({ relative }) => path.basename(relative)).sort()).toEqual([
        "fanout-32-clients-500-trades.json", "fanout-8-clients-1k-trades.json",
        "slow-client-eviction.json", "slow-client-transient-stall.json",
      ]);
    });

    test.each(fanoutManifests.map(({ relative, manifest }) => [relative, manifest]))("%s passes the fan-out runner's own validation", (_relative, manifest) => {
      expect(() => validateFanoutManifest(manifest)).not.toThrow();
    });

    test("the workloads stay inside the rate the single-process rig can sustain and warm up past the empty-database chatter", () => {
      for (const { manifest } of fanoutManifests) {
        const rate = manifest.upstream.tradesPerPulse * 1000 / manifest.upstream.pulseMs;
        expect(rate * manifest.clients).toBeLessThanOrEqual(16_000);
        expect(rate).toBeLessThanOrEqual(1_000);
        expect(manifest.warmupMs).toBeGreaterThanOrEqual(6_000);
      }
    });

    test("the eviction workload shrinks the thresholds and stops once the slow client is gone, while the transient stall keeps production defaults", () => {
      const byName = Object.fromEntries(fanoutManifests.map(({ relative, manifest }) => [path.basename(relative), manifest]));
      expect(byName["slow-client-eviction.json"].server).toEqual({ clientBufferSoftBytes: 300_000, clientBufferHardBytes: 3_000_000, clientBufferGraceMs: 300 });
      expect(byName["slow-client-eviction.json"].slowClients.stopAfterEviction).toBe(true);
      expect(byName["slow-client-transient-stall.json"].server).toBeUndefined();
      expect(byName["slow-client-transient-stall.json"].slowClients.resumeAfterMs).toBeGreaterThan(byName["slow-client-transient-stall.json"].slowClients.pauseAfterMs);
    });
  });

  describe("browser manifests", () => {
    test.each(browserManifests.map(({ relative, manifest }) => [relative, manifest]))("%s passes the browser runner's own validation", (_relative, manifest) => {
      expect(() => validateBrowserManifest(manifest)).not.toThrow();
    });

    test("cover a cold start, steady tape at two rates, and both legacy and traced selection changes", () => {
      const byScenario = (scenario) => browserManifests.filter(({ manifest }) => manifest.scenario === scenario).map(({ manifest }) => manifest);
      expect(byScenario("cold-start")).toHaveLength(1);
      expect(byScenario("selection-change")).toHaveLength(2);
      expect(byScenario("selection-change").filter((manifest) => manifest.observability?.selectionTrace === true)).toHaveLength(1);
      const rates = byScenario("steady-tape").map(({ upstream }) => upstream.tradesPerPulse * 1000 / upstream.pulseMs).sort((a, b) => a - b);
      expect(rates).toEqual([500, 2_000]);
    });

    test("keeps observability opt-in and bounded to the O1 trace vocabulary", () => {
      for (const { manifest } of browserManifests) {
        expect(Object.keys(manifest).sort()).toEqual(
          ["durationSeconds", "kind", "name", "scenario", "upstream", "version", ...(manifest.scenario === "selection-change" ? ["selectionChangeAtSeconds"] : []), ...(manifest.observability ? ["observability"] : [])].sort(),
        );
        if (manifest.observability) expect(manifest.observability).toEqual({ selectionTrace: true, performanceEntries: ["longtask", "event", "paint"] });
      }
    });
  });

  describe("live-storage requests are accepted by the service's own validators", () => {
    const requests = manifests.flatMap(({ relative, manifest }) => manifest.requests
      .filter((request) => request.kind !== "archive-query")
      .map((request, index) => [`${relative}#${index} ${request.route}`, request]));

    test.each(requests)("%s", (_label, request) => {
      const provider = request.body.provider ?? "binance";
      expect(Object.hasOwn(ROUTES, request.route)).toBe(true);
      if (provider === "dxfeed" && request.route !== "replay-page") expect(DXFEED_ROUTES.has(request.route)).toBe(true);
      expect(validatePayload(request.body)).toBeNull();
      expect(validateQueryBounds(request.route, request.body.options ?? {})).toBeNull();
      expect(Buffer.byteLength(JSON.stringify(request.body))).toBeLessThan(65_536);
    });
  });

  describe("workload families", () => {
    const named = (prefix) => manifests.filter(({ relative }) => path.basename(relative).startsWith(prefix));

    test("every cancellation manifest aborts at least one request and every aborting live-storage manifest reads the server delta", () => {
      const cancellation = named("cancel-");
      expect(cancellation.length).toBeGreaterThanOrEqual(4);
      for (const { relative, manifest } of cancellation) {
        expect(manifest.requests.some((request) => request.abort !== undefined)).toBe(true);
        const liveStorage = manifest.requests.some((request) => request.kind !== "archive-query");
        if (liveStorage) expect([relative, manifest.serverDelta]).toEqual([relative, true]);
      }
    });

    test("the deep tier covers the heaviest windows and row limits the route accepts", () => {
      const deep = named("deep-");
      const routes = new Set(deep.flatMap(({ manifest }) => manifest.requests.map((request) => request.route)));
      expect([...routes].sort()).toEqual(["aggressive-prints", "daily-notional", "large-trades", "minute-rollup", "replay-page", "volume-profile"]);
      const windowDays = (request) => (request.body.options.toTs - request.body.options.fromTs) / 86_400_000;
      const requests = deep.flatMap(({ manifest }) => manifest.requests);
      expect(requests.filter((request) => request.route === "daily-notional").map(windowDays).sort((a, b) => a - b)).toEqual([21, 31]);
      expect(requests.filter((request) => request.route === "minute-rollup").map(windowDays)).toEqual([31]);
      expect(requests.filter((request) => request.route === "large-trades").every((request) => request.body.options.limit === 45_000)).toBe(true);
      expect(requests.find((request) => request.route === "aggressive-prints").body.options.limit).toBe(20_000);
      const replayHours = requests.filter((request) => request.route === "replay-page")
        .map((request) => (request.body.options.toTs - request.body.options.fromTs) / 3_600_000).sort((a, b) => a - b);
      expect(replayHours).toEqual([11, 24, 168]);
      expect(requests.filter((request) => request.route === "replay-page").every((request) => request.paginate.maxPages > 0)).toBe(true);
    });
  });
});
