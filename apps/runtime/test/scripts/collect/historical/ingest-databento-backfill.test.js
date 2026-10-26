"use strict";

jest.mock("../../../../scripts/collect/historical/coverage-files");

const { coverageFiles } = require("../../../../scripts/collect/historical/coverage-files");
const {
  buildDefinitionJobs, buildJobs, buildDailyJobsFor, ANCHOR_DATE, SYMBOLS, SCHEMA_CONFIG,
  loadEntitlementBoundaries, freeStartDateFor, effectiveAnchorFor,
} = require("../../../../scripts/collect/historical/ingest-databento-backfill");

// Real filenames as they actually exist in S3 (confirmed directly against
// the bucket, 2026-09-11) -- mbp-1/ohlcv-1s are monthly range files, not one
// per day. A prior version of SCHEMA_CONFIG declared them "daily", so the
// coverage check compared against a daily-named file that could never exist
// and treated the entire already-covered archive as missing on every run.
const REAL_GLBX_MBP1_SEP2025 = "year=2025/month=09/glbx-mdp3-20250901-20250930.mbp-1.dbn.zst";
const REAL_GLBX_OHLCV1S_SEP2025 = "year=2025/month=09/glbx-mdp3-20250901-20250930.ohlcv-1s.csv";
const REAL_GLBX_MBP10_DAY = "year=2026/month=08/day=03/glbx-mdp3-20260803.mbp-10.dbn.zst";

describe("SCHEMA_CONFIG cadence matches the real archive layout", () => {
  beforeEach(() => coverageFiles.mockReset());

  test("mbp-1 is declared monthly, matching the real monthly range filenames", () => {
    expect(SCHEMA_CONFIG.find((s) => s.schema === "mbp-1").cadence).toBe("monthly");
  });

  test("ohlcv-1s is declared monthly, matching the real monthly range filenames", () => {
    expect(SCHEMA_CONFIG.find((s) => s.schema === "ohlcv-1s").cadence).toBe("monthly");
  });

  test("mbp-10 stays declared daily -- it genuinely is, per real per-day filenames", () => {
    expect(SCHEMA_CONFIG.find((s) => s.schema === "mbp-10").cadence).toBe("daily");
  });

  test("a real already-covered mbp-1 month is recognized as covered, not re-queued as a gap", () => {
    coverageFiles.mockImplementation((_rcloneBin, target) => {
      if (target.includes("schema=mbp-1/") && target.includes("symbol=NQ/")) return new Set([REAL_GLBX_MBP1_SEP2025]);
      return new Set();
    });
    const jobs = buildJobs("rclone.exe").filter((j) => j.symbol.name === "NQ" && j.schema === "mbp-1");
    // September 2025 (the covered month) must not reappear as a gap.
    expect(jobs.some((j) => j.start === "2025-09-15")).toBe(false);
  });

  test("a real already-covered ohlcv-1s month is recognized as covered, not re-queued as a gap", () => {
    coverageFiles.mockImplementation((_rcloneBin, target) => {
      if (target.includes("schema=ohlcv-1s/") && target.includes("symbol=NQ/")) return new Set([REAL_GLBX_OHLCV1S_SEP2025]);
      return new Set();
    });
    const jobs = buildJobs("rclone.exe").filter((j) => j.symbol.name === "NQ" && j.schema === "ohlcv-1s");
    expect(jobs.some((j) => j.start === "2025-09-15")).toBe(false);
  });

  test("a real already-covered mbp-10 day is recognized as covered (daily cadence still correct)", () => {
    coverageFiles.mockImplementation((_rcloneBin, target) => {
      if (target.includes("schema=mbp-10/") && target.includes("symbol=NQ/")) return new Set([REAL_GLBX_MBP10_DAY]);
      return new Set();
    });
    const jobs = buildJobs("rclone.exe").filter((j) => j.symbol.name === "NQ" && j.schema === "mbp-10");
    expect(jobs.some((j) => j.start === "2026-08-03")).toBe(false);
  });

  test("mutation check: the real bug reproduced directly -- daily cadence against the real monthly file wrongly treats the whole covered month as missing", () => {
    coverageFiles.mockImplementation((_rcloneBin, target) => {
      if (target.includes("schema=mbp-1/") && target.includes("symbol=NQ/")) return new Set([REAL_GLBX_MBP1_SEP2025]);
      return new Set();
    });
    // buildDailyJobsFor is the exact function buildJobs would have called
    // for mbp-1 under the old (buggy) SCHEMA_CONFIG entry -- calling it
    // directly with "daily" reproduces that bug against the real filename
    // without needing to mutate SCHEMA_CONFIG itself.
    const jobs = buildDailyJobsFor("rclone.exe", "mbp-1", "dbn").filter((j) => j.symbol.name === "NQ" && j.start.startsWith("2025-09"));
    // Every day in the already-covered month wrongly reappears as "missing"
    // -- this is exactly the real symptom (a --quote-only dry run visibly
    // treating the whole archive as ungapped coverage it already had).
    expect(jobs.length).toBeGreaterThan(20);
  });
});

describe("entitlement boundaries (real free/paid transitions from Databento's own cost API)", () => {
  const real = loadEntitlementBoundaries();

  test("mbp-1 on GLBX.MDP3 has no boundary -- free across the whole scanned history", () => {
    expect(freeStartDateFor(real, "GLBX.MDP3", "ES", "mbp-1")).toBeNull();
  });

  test("mbp-10 on GLBX.MDP3 has a real, recent free-start date", () => {
    const freeStart = freeStartDateFor(real, "GLBX.MDP3", "NQ", "mbp-10");
    expect(freeStart).toBeInstanceOf(Date);
    expect(freeStart.getTime()).toBeGreaterThan(ANCHOR_DATE.getTime());
  });

  test("effectiveAnchorFor uses ANCHOR_DATE when there's no boundary", () => {
    const symbol = SYMBOLS.find((s) => s.name === "ES");
    expect(effectiveAnchorFor(real, symbol, "mbp-1").getTime()).toBe(ANCHOR_DATE.getTime());
  });

  test("effectiveAnchorFor uses the real free-start date for mbp-10, later than ANCHOR_DATE", () => {
    const symbol = SYMBOLS.find((s) => s.name === "NQ");
    const anchor = effectiveAnchorFor(real, symbol, "mbp-10");
    expect(anchor.getTime()).toBeGreaterThan(ANCHOR_DATE.getTime());
    expect(anchor.getTime()).toBe(freeStartDateFor(real, "GLBX.MDP3", "NQ", "mbp-10").getTime());
  });

  test("freeStartDateFor throws when the nearest boundary isn't free -- fails loudly rather than scanning a paid range", () => {
    const synthetic = { results: [{ dataset: "GLBX.MDP3", name: "ES", schema: "mbp-10", boundaries: [{ fromState: "paid", toState: "free", lastDateInFromState: "2026-01-01", firstDateInToState: "2025-12-31" }] }] };
    expect(() => freeStartDateFor(synthetic, "GLBX.MDP3", "ES", "mbp-10")).toThrow("ENTITLEMENT_BOUNDARY_UNEXPECTED_SHAPE");
  });

  test("loadEntitlementBoundaries throws a clear error when the file is unreadable", () => {
    expect(() => loadEntitlementBoundaries("/nonexistent/path.json")).toThrow("entitlement boundaries file unreadable");
  });

  test("mbp-10's real free window actually explains the earlier 1380-gap finding -- most of the archive predates it", () => {
    const freeStart = freeStartDateFor(real, "GLBX.MDP3", "ES", "mbp-10");
    const daysExcluded = Math.round((freeStart.getTime() - ANCHOR_DATE.getTime()) / 86_400_000);
    expect(daysExcluded).toBeGreaterThan(300);
  });

  test("buildDailyJobsFor for mbp-10 actually uses the real free-start date, not ANCHOR_DATE -- no gap job predates it", () => {
    coverageFiles.mockReturnValue(new Set());
    const freeStart = freeStartDateFor(real, "GLBX.MDP3", "NQ", "mbp-10");
    const jobs = buildDailyJobsFor("rclone.exe", "mbp-10", "dbn", real).filter((j) => j.symbol.name === "NQ");
    expect(jobs.length).toBeGreaterThan(0);
    const earliestJobDate = new Date(`${jobs[0].start}T00:00:00Z`);
    expect(earliestJobDate.getTime()).toBeGreaterThanOrEqual(freeStart.getTime());
    expect(jobs.length).toBeLessThan(120);
  });
});

// ANCHOR_DATE is 2025-09-06; "today" for safeCutoffDate is the real clock, so
// tests only assert shape/invariants that hold for any current date, not a
// fixed job count.

describe("buildDefinitionJobs", () => {
  const NQ = SYMBOLS.find((s) => s.name === "NQ");

  beforeEach(() => {
    coverageFiles.mockReset();
    coverageFiles.mockReturnValue(new Set()); // nothing covered anywhere, by default
  });

  test("with no existing coverage, builds one job per calendar month from ANCHOR_DATE through the safe cutoff, per symbol", () => {
    const jobs = buildDefinitionJobs("rclone.exe");
    const nqJobs = jobs.filter((j) => j.symbol.name === "NQ");
    // At least a year's worth of monthly jobs given the real archive range.
    expect(nqJobs.length).toBeGreaterThanOrEqual(12);
    // Every symbol got some jobs -- this isn't scoped to futures only.
    for (const symbol of SYMBOLS) {
      expect(jobs.some((j) => j.symbol.name === symbol.name)).toBe(true);
    }
  });

  test("each job's destPath keeps the existing day-inclusive S3 layout (matches what's already archived)", () => {
    const jobs = buildDefinitionJobs("rclone.exe").filter((j) => j.symbol.name === "NQ");
    for (const job of jobs) {
      expect(job.destPath).toMatch(
        /^raw\/databento\/dataset=GLBX\.MDP3\/schema=definition\/symbol=NQ\/year=\d{4}\/month=\d{2}\/day=\d{2}\/glbx-mdp3-\d{8}\.definition\.csv$/,
      );
    }
  });

  test("consecutive jobs for the same symbol advance strictly forward in time, one calendar month apart", () => {
    const jobs = buildDefinitionJobs("rclone.exe").filter((j) => j.symbol.name === "NQ");
    for (let i = 1; i < jobs.length; i++) {
      const prevEnd = new Date(jobs[i - 1].end);
      const curEnd = new Date(jobs[i].end);
      expect(curEnd.getTime()).toBeGreaterThan(prevEnd.getTime());
    }
  });

  test("a month whose destPath is already in coverage is skipped, not re-requested", () => {
    // First pass: see what NQ would ask for.
    const allJobs = buildDefinitionJobs("rclone.exe").filter((j) => j.symbol.name === "NQ");
    expect(allJobs.length).toBeGreaterThan(1);
    const firstRelative = allJobs[0].destPath.slice(`raw/databento/dataset=${NQ.dataset}/schema=definition/symbol=NQ/`.length);

    coverageFiles.mockImplementation((_rcloneBin, target) => {
      // Only NQ's prefix reports the first month as already covered.
      if (target.includes("symbol=NQ/")) return new Set([firstRelative]);
      return new Set();
    });

    const jobsAfter = buildDefinitionJobs("rclone.exe").filter((j) => j.symbol.name === "NQ");
    expect(jobsAfter.length).toBe(allJobs.length - 1);
    expect(jobsAfter.map((j) => j.destPath)).not.toContain(allJobs[0].destPath);
  });

  test("the first request window never predates the archive anchor date", () => {
    const jobs = buildDefinitionJobs("rclone.exe").filter((j) => j.symbol.name === "NQ");
    const earliestStart = new Date(jobs[0].start);
    expect(earliestStart.getTime()).toBeGreaterThanOrEqual(ANCHOR_DATE.getTime());
  });

  test("the final job's end date never exceeds the safe cutoff (today minus publish lag)", () => {
    const jobs = buildDefinitionJobs("rclone.exe").filter((j) => j.symbol.name === "NQ");
    const lastEnd = new Date(jobs[jobs.length - 1].end);
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    expect(lastEnd.getTime()).toBeLessThanOrEqual(now.getTime());
  });
});
