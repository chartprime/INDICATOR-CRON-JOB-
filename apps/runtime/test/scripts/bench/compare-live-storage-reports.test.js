"use strict";

const { compareReports, sampleKey } = require("../../../scripts/bench/compare-live-storage-reports");

describe("scripts/bench/compare-live-storage-reports", () => {
  const sample = { user: 0, round: 0, requestIndex: 0, route: "recording-age", status: 200, failureClass: "SUCCESS", bodySha256: "a", responseBytes: 10 };
  const paged = (hashes) => hashes.map((bodySha256, page) => ({ ...sample, route: "replay-page", page, bodySha256 }));
  const source = (overrides = {}) => ({
    git: { commit: "c".repeat(40), dirty: false, trackedChanges: 0, untrackedFiles: 0, trackedDiffSha256: null },
    scriptSha256: "s".repeat(64), manifestSha256: "m".repeat(64), nodeVersion: "v24.0.0",
    contractVersions: { liveStorage: "live-storage/1", archive: null },
    endpoints: { liveStorageOrigin: "http://127.0.0.1:8002", archiveOrigin: null },
    ...overrides,
  });

  test("accepts identical semantic samples while ignoring latency", () => {
    expect(compareReports({ samples: [{ ...sample, durationMs: 10 }] }, { samples: [{ ...sample, durationMs: 2 }] })).toMatchObject({
      equivalent: true, comparedSamples: 1, differences: [],
    });
  });

  test("reports exact contract-output differences", () => {
    const result = compareReports({ samples: [sample] }, { samples: [{ ...sample, bodySha256: "b", responseBytes: 11 }] });
    expect(result.equivalent).toBe(false);
    expect(result.differences).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "bodySha256" }), expect.objectContaining({ field: "responseBytes" }),
    ]));
  });

  test("keys samples by page so paginated requests are compared page by page", () => {
    expect(sampleKey({ ...sample, page: 3 })).not.toBe(sampleKey({ ...sample, page: 0 }));
    expect(sampleKey(sample)).toBe(sampleKey({ ...sample, page: 0 }));
  });

  test("a difference on a middle page is reported even when the final page is identical", () => {
    const before = { samples: paged(["p0", "p1", "p2", "p3", "p4"]) };
    const after = { samples: paged(["p0", "p1", "p2", "CHANGED", "p4"]) };
    const result = compareReports(before, after);
    expect(result.equivalent).toBe(false);
    expect(result.comparedSamples).toBe(5);
    expect(result.differences).toEqual([expect.objectContaining({ field: "bodySha256", before: "p3", after: "CHANGED", key: expect.stringMatching(/:3$/) })]);
  });

  test("a swap of two earlier pages is reported even when the final page is identical", () => {
    const result = compareReports({ samples: paged(["a", "b", "c"]) }, { samples: paged(["b", "a", "c"]) });
    expect(result.equivalent).toBe(false);
    expect(result.differences.map((difference) => difference.key.split(":").at(-1))).toEqual(["0", "1"]);
  });

  test("a truncated pagination is reported as missing pages, not silently accepted", () => {
    const result = compareReports({ samples: paged(["a", "b", "c"]) }, { samples: paged(["a", "b"]) });
    expect(result.equivalent).toBe(false);
    expect(result.differences).toEqual([expect.objectContaining({ reason: "MISSING_AFTER", key: expect.stringMatching(/:2$/) })]);
  });

  test("a report that repeats a sample key is reported as ambiguous instead of collapsing to the last sample", () => {
    const duplicated = { samples: [{ ...sample, bodySha256: "a" }, { ...sample, bodySha256: "b" }] };
    const result = compareReports(duplicated, { samples: [sample] });
    expect(result.equivalent).toBe(false);
    expect(result.differences).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "DUPLICATE_BEFORE" })]));
  });

  describe("samples with a requested abort", () => {
    const aborted = { ...sample, route: "minute-rollup", status: 0, failureClass: "CLIENT_ABORTED", bodySha256: null, responseBytes: 0, abort: { afterMs: 5, fired: true } };
    const raced = { ...sample, route: "minute-rollup", failureClass: "SUCCESS", bodySha256: "x", responseBytes: 99, abort: { afterMs: 5, fired: true }, abortRaced: true };

    test("their outcome depends on which side won the race, so it is reported as a distribution instead of compared", () => {
      const result = compareReports({ samples: [aborted] }, { samples: [raced] });
      expect(result.equivalent).toBe(true);
      expect(result.abortSamples).toEqual({
        count: 1, notCompared: true, outcomes: { before: { CLIENT_ABORTED: 1 }, after: { SUCCESS: 1 } },
      });
    });

    test("a missing aborted sample is still a structural difference", () => {
      const result = compareReports({ samples: [aborted] }, { samples: [] });
      expect(result.equivalent).toBe(false);
      expect(result.differences).toEqual([expect.objectContaining({ reason: "MISSING_AFTER" })]);
    });

    test("un-aborted samples in the same report are still compared exactly", () => {
      const result = compareReports({ samples: [aborted, sample] }, { samples: [raced, { ...sample, bodySha256: "changed" }] });
      expect(result.equivalent).toBe(false);
      expect(result.differences).toEqual([expect.objectContaining({ field: "bodySha256", before: "a", after: "changed" })]);
    });

    test("a report with no aborts carries no abortSamples block", () => {
      expect(compareReports({ samples: [sample] }, { samples: [sample] }).abortSamples).toBeUndefined();
    });
  });

  describe("source identity", () => {
    test("reports produced from different manifests are never semantically equivalent", () => {
      const result = compareReports(
        { samples: [sample], source: source() },
        { samples: [sample], source: source({ manifestSha256: "n".repeat(64) }) },
      );
      expect(result.equivalent).toBe(false);
      expect(result.differences).toEqual([expect.objectContaining({ reason: "MANIFEST_MISMATCH" })]);
    });

    test("clean, identical identities produce no warnings and surface the sources", () => {
      const result = compareReports({ samples: [sample], source: source() }, { samples: [sample], source: source() });
      expect(result).toMatchObject({ equivalent: true, warnings: [], sources: { before: source(), after: source() } });
    });

    test("legacy reports without a source, dirty trees and a changed tool script are surfaced as warnings", () => {
      const dirty = source({ git: { commit: "c".repeat(40), dirty: true, trackedChanges: 2, untrackedFiles: 0, trackedDiffSha256: "d".repeat(64) } });
      const legacy = compareReports({ samples: [sample] }, { samples: [sample], source: dirty });
      expect(legacy.equivalent).toBe(true);
      expect(legacy.warnings.map((warning) => warning.reason)).toEqual(["SOURCE_MISSING_BEFORE", "TREE_DIRTY_AFTER"]);
      const changedTool = compareReports(
        { samples: [sample], source: source() }, { samples: [sample], source: source({ scriptSha256: "t".repeat(64) }) },
      );
      expect(changedTool.warnings.map((warning) => warning.reason)).toEqual(["TOOL_SCRIPT_DIFFERS"]);
    });

    test("strict identity turns every identity gap into a failure and clean identities still pass", () => {
      const dirty = source({ git: { commit: "c".repeat(40), dirty: true, trackedChanges: 1, untrackedFiles: 0, trackedDiffSha256: "d".repeat(64) } });
      const strict = compareReports({ samples: [sample] }, { samples: [sample], source: dirty }, { strictIdentity: true });
      expect(strict.equivalent).toBe(false);
      expect(strict.differences.map((difference) => difference.reason)).toEqual(["SOURCE_MISSING_BEFORE", "TREE_DIRTY_AFTER"]);
      expect(compareReports({ samples: [sample], source: source() }, { samples: [sample], source: source() }, { strictIdentity: true }).equivalent).toBe(true);
    });
  });
});
