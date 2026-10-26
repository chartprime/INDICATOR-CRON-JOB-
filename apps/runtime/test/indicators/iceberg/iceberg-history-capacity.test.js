const fs = require("fs");
const os = require("os");
const path = require("path");
const { createIcebergIndicator } = require("../../../src/indicators/iceberg/iceberg-indicator");
const { createIcebergHostFill, DEFAULT_TAIL_MS } = require("../../../src/indicators/iceberg/iceberg-host-fill");

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T = 10 * DAY;
const NQ = { symbol: "/NQZ26:XCME", marketKind: "FUTURE" };
const quiet = { warn: () => {}, info: () => {}, error: () => {} };
const ev = (index, action, size) => Object.freeze({ index, eventFlags: 0, action, price: 31000, size, side: "BUY", source: "GLBX" });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function liveRun(indicator, clock) {
  clock.at = T;
  indicator.onNativeEvents(NQ, [ev("0", "NEW", 5)], { receivedAt: T });
  indicator.tick();
  for (const [index, at] of [["1", T + 10_000], ["2", T + 20_000], ["3", T + 30_000]]) {
    clock.at = at;
    indicator.onNativeEvents(NQ, [ev(index, "NEW", 10), ev(index, "PARTIAL", 3), ev(index, "PARTIAL", 10), ev(index, "EXECUTE", null)], { receivedAt: at });
    indicator.tick();
  }
}

describe("iceberg history at its cap, through the real indicator, store and host fill", () => {
  const dirs = [];

  function tempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iceberg-capacity-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("the runtime's own live run never claims time whose icebergs the history dropped for room: a run that began before the dropped mark keeps growing from past it", () => {
    const clock = { at: T };
    const indicator = createIcebergIndicator({ provider: "DXFEED", storeDir: tempDir(), histories: false, maxIcebergs: 2, now: () => clock.at, log: quiet });
    liveRun(indicator, clock);
    const page = indicator.snapshot(NQ, clock.at);
    expect(page.icebergs.map((entry) => entry.markedAt)).toEqual([T + 20_000, T + 30_000]);
    expect(page.watched).toEqual([[T + 10_001, T + 30_000]]);
    indicator.stop();
  });

  test("a history restored from the store at its cap keeps the rule: its spans claim nothing it dropped, and the host fill after the restart asks only for the time since, nothing older than what it can keep", async () => {
    const dir = tempDir();
    const clock = { at: T };
    const first = createIcebergIndicator({ provider: "DXFEED", storeDir: dir, maxIcebergs: 2, now: () => clock.at, log: quiet });
    liveRun(first, clock);
    first.stop();
    const asked = [];
    const read = async (provider, symbol, marketKind, options) => {
      asked.push([provider, options.fromTs, options.toTs]);
      return { available: true, generation: "g", rulesVersion: 1, span: { from: 0, to: clock.at }, watched: [[0, clock.at]], icebergs: [], next: null };
    };
    clock.at = T + HOUR;
    const again = createIcebergIndicator({ provider: "DXFEED", storeDir: dir, maxIcebergs: 2, now: () => clock.at, hostFill: createIcebergHostFill({ read, now: () => clock.at }), hostFillDelayMs: 0, log: quiet });
    const page = again.snapshot(NQ, clock.at);
    expect(page.icebergs.map((entry) => entry.markedAt)).toEqual([T + 20_000, T + 30_000]);
    expect(page.watched).toEqual([[T + 10_001, T + 30_000]]);
    again.tick();
    await flush();
    expect(asked).toEqual([["dxfeed", T + 30_000, T + HOUR - DEFAULT_TAIL_MS]]);
    expect(again.snapshot(NQ, clock.at).watched).toEqual([[T + 10_001, T + HOUR - DEFAULT_TAIL_MS]]);
    again.stop();
  });
});
