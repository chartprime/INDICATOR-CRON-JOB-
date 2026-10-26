jest.mock("node:child_process", () => ({ ...jest.requireActual("node:child_process"), execFileSync: jest.fn() }));
jest.mock("tardis-dev", () => ({ getApiKeyAccessInfo: jest.fn() }));
const { execFileSync } = require("node:child_process");
const { coverageFiles } = require("../../scripts/collect/historical/coverage-files");
const tardis = require("../../scripts/collect/historical/ingest-tardis-backfill");
const databento = require("../../scripts/collect/historical/ingest-databento-backfill");

afterEach(() => jest.resetAllMocks());

test("unconfirmed uploader exit stops new jobs while other owned lanes settle", async () => {
  const worker = jest.fn(async () => { throw Object.assign(new Error("exit unknown"), { code: "RCLONE_CHILD_EXIT_UNCONFIRMED" }); });
  const result = await tardis.runWithConcurrency([1, 2, 3, 4, 5], 2, worker);
  expect(worker).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({ done: 0, skipped: 3 });
  expect(result.failed).toHaveLength(2);
});

test("only an explicitly missing directory counts as empty coverage", () => {
  execFileSync.mockImplementation(() => { throw Object.assign(new Error("missing"), { status: 3 }); });
  expect(coverageFiles("fixture", "remote:path").size).toBe(0);
  for (const status of [1, 5, 7, null]) {
    execFileSync.mockImplementation(() => { throw Object.assign(new Error("failed"), { status }); });
    expect(() => coverageFiles("fixture", "remote:path")).toThrow("inventory unavailable");
  }
});

test("inventory is bounded and hides its subprocess window", () => {
  execFileSync.mockReturnValue("a\nb\n");
  expect([...coverageFiles("fixture", "remote:path")]).toEqual(["a", "b"]);
  expect(execFileSync).toHaveBeenCalledWith("fixture", expect.any(Array), expect.objectContaining({ timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }));
});

test("Tardis finds an interior missing day despite a newer stored object", () => {
  execFileSync.mockReturnValue("year=2025/month=09/day=08/binance_trades_2025-09-08_BTCUSDT.csv.gz\n");
  const jobs = tardis.buildJobs("fixture").filter((job) => job.exchange === "binance" && job.dataType === "trades" && job.symbolUpper === "BTCUSDT");
  expect(jobs.some((job) => job.date.toISOString().startsWith("2025-09-07"))).toBe(true);
  expect(jobs.some((job) => job.date.toISOString().startsWith("2025-09-08"))).toBe(false);
});

test("Databento preserves daily and monthly interior gaps without reopening existing objects", () => {
  const boundaries = databento.loadEntitlementBoundaries();
  const freeStart = databento.freeStartDateFor(boundaries, "GLBX.MDP3", "ES", "mbp-10");
  const covered = new Date(freeStart);
  covered.setUTCDate(covered.getUTCDate() + 1);
  const gap = new Date(covered);
  gap.setUTCDate(gap.getUTCDate() - 1);
  const pad2 = (n) => String(n).padStart(2, "0");
  const compact = (d) => `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
  const iso = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const coveredPath = `year=${covered.getUTCFullYear()}/month=${pad2(covered.getUTCMonth() + 1)}/day=${pad2(covered.getUTCDate())}/glbx-mdp3-${compact(covered)}.mbp-10.dbn.zst`;
  execFileSync.mockReturnValue(`${coveredPath}\nyear=2025/month=10/glbx-mdp3-20251001-20251031.statistics.csv\n`);
  const jobs = databento.buildJobs("fixture").filter((job) => job.symbol.name === "ES");
  expect(jobs.some((job) => job.schema === "mbp-10" && job.start === iso(gap))).toBe(true);
  expect(jobs.some((job) => job.schema === "mbp-10" && job.start === iso(covered))).toBe(false);
  expect(jobs.some((job) => job.schema === "statistics" && job.start === "2025-09-06")).toBe(true);
  expect(jobs.some((job) => job.schema === "statistics" && job.start === "2025-10-01")).toBe(false);
});

test("mbp-1/ohlcv-1s are monthly-cadence, matching the real archive -- an already-covered month is not reopened, an uncovered one still is", () => {
  execFileSync.mockReturnValue("year=2025/month=10/glbx-mdp3-20251001-20251031.mbp-1.dbn.zst\n");
  const jobs = databento.buildJobs("fixture").filter((job) => job.symbol.name === "ES" && job.schema === "mbp-1");
  // September (the archive's own anchor month) is genuinely uncovered by the mock.
  expect(jobs.some((job) => job.start === "2025-09-06")).toBe(true);
  // October is already covered by the mocked listing -- must not reappear as a gap.
  expect(jobs.some((job) => job.start === "2025-10-01")).toBe(false);
});
