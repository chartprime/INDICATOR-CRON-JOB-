import { describe, expect, it, vi } from "vitest";
import {
  ARCHIVE_STUDY_CONTRACT_VERSION,
  ARCHIVE_STUDY_PATH,
  ArchiveStudyTransportError,
  createArchiveStudyClient,
  markerFrameFor,
  profileFrameFor,
  type ArchiveStudyRequest,
} from "./archiveStudyClient";

const TOKEN = "t".repeat(24);
const DAY = 86_400_000;
const START = Date.parse("2025-10-06T00:00:00.000Z");

function request(
  overrides: Partial<ArchiveStudyRequest> = {},
): ArchiveStudyRequest {
  return {
    requestId: 7,
    study: "volume_profile",
    symbol: "ES",
    assetClass: "FUTURE",
    tickSize: 0.25,
    segments: [
      {
        instrumentId: '["XCME","FUTURE","ESZ5","USD","CONTRACT"]',
        fromTs: START - 30 * DAY,
        toTs: START + 60 * DAY,
      },
    ],
    ranges: [{ fromTs: START, toTs: START + DAY }],
    options: { mode: "continuous", binSizeMultiplier: 1 },
    ...overrides,
  };
}

function profileBody(overrides: Record<string, unknown> = {}) {
  return {
    mode: "continuous",
    delivery_scope: "HISTORICAL",
    history_request_id: 7,
    period_start_ts: START,
    period_end_ts: START + DAY,
    row_width: 0.25,
    buckets: [
      {
        price: 6000,
        volume: 10,
        buy_volume: 6,
        sell_volume: 4,
        single_print: false,
      },
      {
        price: 6000.25,
        volume: 30,
        buy_volume: 10,
        sell_volume: 20,
        single_print: false,
      },
    ],
    poc_price: 6000.25,
    vah_price: 6000.25,
    val_price: 6000,
    ...overrides,
  };
}

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ok(extra: Record<string, unknown>, study = "volume_profile") {
  return reply({
    contractVersion: ARCHIVE_STUDY_CONTRACT_VERSION,
    study,
    requestId: 7,
    missing: [],
    complete: true,
    ...extra,
  });
}

describe("archive study client", () => {
  it("posts the versioned request with the bearer token and returns validated profiles", async () => {
    const fetchImpl = vi.fn(async () => ok({ profiles: [profileBody()] }));
    const client = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.run(request());
    const [path, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(path).toBe(ARCHIVE_STUDY_PATH);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      contractVersion: ARCHIVE_STUDY_CONTRACT_VERSION,
      requestId: 7,
      study: "volume_profile",
    });
    expect(result).toMatchObject({ outcome: "volume_profile", complete: true });
    if (result.outcome !== "volume_profile") throw new Error("unreachable");
    expect(result.profiles[0]).toMatchObject({
      period_start_ts: START,
      poc_price: 6000.25,
      delivery_scope: "HISTORICAL",
    });
  });

  it("accepts periods the market was closed as empty, and refuses an empty range that was not asked for or was also profiled", async () => {
    const asked = request();
    const closed = { fromTs: START, toTs: START + DAY };
    const client = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () =>
        ok({ profiles: [], empty: [closed] })) as unknown as typeof fetch,
    });
    await expect(client.run(asked)).resolves.toMatchObject({
      outcome: "volume_profile",
      complete: true,
      empty: [closed],
      profiles: [],
    });

    const absent = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () => ok({ profiles: [] })) as unknown as typeof fetch,
    });
    await expect(absent.run(asked)).rejects.toThrow(
      "classify every profile range exactly once",
    );

    const unasked = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () =>
        ok({
          profiles: [],
          empty: [{ fromTs: START + 5 * DAY, toTs: START + 6 * DAY }],
        })) as unknown as typeof fetch,
    });
    await expect(unasked.run(asked)).rejects.toThrow(
      "empty range that was not requested",
    );

    const both = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () =>
        ok({
          profiles: [profileBody()],
          empty: [closed],
        })) as unknown as typeof fetch,
    });
    await expect(both.run(asked)).rejects.toThrow("both empty and profiled");
  });

  it("requires every profile range to be exactly one of profiled, empty, or missing", async () => {
    const omitted = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () =>
        ok({ profiles: [], empty: [] })) as unknown as typeof fetch,
    });
    await expect(omitted.run(request())).rejects.toThrow(
      "classify every profile range exactly once",
    );

    const bothMissingAndEmpty = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () =>
        reply({
          contractVersion: ARCHIVE_STUDY_CONTRACT_VERSION,
          study: "volume_profile",
          requestId: 7,
          profiles: [],
          empty: [{ fromTs: START, toTs: START + DAY }],
          missing: [{ fromTs: START, toTs: START + DAY }],
          complete: false,
        })) as unknown as typeof fetch,
    });
    await expect(bothMissingAndEmpty.run(request())).rejects.toThrow(
      "classify every profile range exactly once",
    );
  });

  it("rejects an answer for a different request id or study", async () => {
    const other = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () =>
        reply({
          contractVersion: ARCHIVE_STUDY_CONTRACT_VERSION,
          study: "volume_profile",
          requestId: 8,
          missing: [],
          complete: true,
          profiles: [],
        })) as unknown as typeof fetch,
    });
    await expect(other.run(request())).rejects.toBeInstanceOf(
      ArchiveStudyTransportError,
    );
    const wrongStudy = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () =>
        ok({ readings: [] }, "vpin")) as unknown as typeof fetch,
    });
    await expect(wrongStudy.run(request())).rejects.toThrow("different study");
  });

  it.each([
    ["a point of control that is not a bucket", { poc_price: 6001 }],
    [
      "buckets out of price order",
      { buckets: [profileBody().buckets[1], profileBody().buckets[0]] },
    ],
    ["a live-scoped profile", { delivery_scope: "LIVE" }],
    ["a profile tagged for another request", { history_request_id: 6 }],
    ["an empty profile", { buckets: [] }],
  ])("rejects %s", async (_label, override) => {
    const client = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () =>
        ok({ profiles: [profileBody(override)] })) as unknown as typeof fetch,
    });
    await expect(client.run(request())).rejects.toThrow("outside the contract");
  });

  it("validates VPIN readings and their order", async () => {
    const readingAt = (seal: number) => ({
      seal_ts: seal,
      active: true,
      direction: "buy",
      strength: 0.5,
      z_vpin: 1.2,
      z_velocity: null,
      z_acceleration: 0.1,
      activated_at_ts: seal,
    });
    const good = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () =>
        ok(
          { readings: [readingAt(START), readingAt(START + 1)] },
          "vpin",
        )) as unknown as typeof fetch,
    });
    const result = await good.run(
      request({ study: "vpin", options: undefined }),
    );
    expect(result.outcome === "vpin" ? result.readings.length : -1).toBe(2);
    const unordered = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () =>
        ok(
          { readings: [readingAt(START + 1), readingAt(START)] },
          "vpin",
        )) as unknown as typeof fetch,
    });
    await expect(unordered.run(request({ study: "vpin" }))).rejects.toThrow(
      "out of order",
    );
    const outOfRange = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () =>
        ok(
          { readings: [{ ...readingAt(START), strength: 1.5 }] },
          "vpin",
        )) as unknown as typeof fetch,
    });
    await expect(outOfRange.run(request({ study: "vpin" }))).rejects.toThrow(
      "outside the contract",
    );
  });

  it("validates bar flow: sides inside the bar's volume, the unknown share accounted for, ordered and inside the request", async () => {
    const asked = request({ study: "bar_flow", options: { bucketMs: 60_000 } });
    const good = {
      ts_open: START,
      volume: 1_000,
      buy_volume: 400,
      sell_volume: 300,
      unknown_volume: 300,
      trade_count: 5,
    };
    const client = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () =>
        ok({ bars: [good] }, "bar_flow")) as unknown as typeof fetch,
    });
    await expect(client.run(asked)).resolves.toMatchObject({
      outcome: "bar_flow",
      bars: [good],
      complete: true,
    });

    for (const [label, bar] of [
      [
        "sides above the bar's own volume",
        { ...good, buy_volume: 800, sell_volume: 400, unknown_volume: 0 },
      ],
      [
        "an unknown share that does not reconcile",
        { ...good, unknown_volume: 0 },
      ],
      [
        "a bar outside the requested range",
        { ...good, ts_open: START + 5 * DAY },
      ],
    ] as const) {
      const bad = createArchiveStudyClient({
        token: TOKEN,
        fetchImpl: (async () =>
          ok({ bars: [bar] }, "bar_flow")) as unknown as typeof fetch,
      });
      await expect(bad.run(asked), label).rejects.toThrow(
        /outside the contract|outside the requested ranges/,
      );
    }

    const unordered = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () =>
        ok(
          { bars: [{ ...good, ts_open: START + 60_000 }, good] },
          "bar_flow",
        )) as unknown as typeof fetch,
    });
    await expect(unordered.run(asked)).rejects.toThrow("bars out of order");
  });

  it("validates prints", async () => {
    const client = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () =>
        ok(
          {
            prints: [{ ts_exchange: START, price: 6000, size: 0, side: "buy" }],
          },
          "large_prints",
        )) as unknown as typeof fetch,
    });
    await expect(
      client.run(
        request({ study: "large_prints", options: { bucketMs: 60_000 } }),
      ),
    ).rejects.toThrow("outside the contract");
  });

  it("rejects payload or missing ranges outside the request and contradictory completion", async () => {
    const outside = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () =>
        ok({
          profiles: [
            profileBody({
              period_start_ts: START + DAY,
              period_end_ts: START + 2 * DAY,
            }),
          ],
        })) as unknown as typeof fetch,
    });
    await expect(outside.run(request())).rejects.toThrow(
      "outside the requested ranges",
    );

    const foreignMissing = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () =>
        reply({
          contractVersion: ARCHIVE_STUDY_CONTRACT_VERSION,
          study: "volume_profile",
          requestId: 7,
          profiles: [],
          missing: [{ fromTs: START + DAY, toTs: START + 2 * DAY }],
          complete: false,
        })) as unknown as typeof fetch,
    });
    await expect(foreignMissing.run(request())).rejects.toThrow(
      "not requested",
    );

    const contradiction = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () =>
        reply({
          contractVersion: ARCHIVE_STUDY_CONTRACT_VERSION,
          study: "volume_profile",
          requestId: 7,
          profiles: [],
          missing: [{ fromTs: START, toTs: START + DAY }],
          complete: true,
        })) as unknown as typeof fetch,
    });
    await expect(contradiction.run(request())).rejects.toThrow("contradicts");
  });

  it("returns refusals as values, carrying the retry hint", async () => {
    const client = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () =>
        reply(
          {
            contractVersion: ARCHIVE_STUDY_CONTRACT_VERSION,
            error: "OVERLOADED",
            reason: "STUDY_IN_FLIGHT",
            retryAfterMs: 1500,
          },
          429,
        )) as unknown as typeof fetch,
    });
    await expect(client.run(request())).resolves.toEqual({
      outcome: "refused",
      code: "OVERLOADED",
      reason: "STUDY_IN_FLIGHT",
      status: 429,
      retryAfterMs: 1500,
    });
  });

  it("treats an unversioned or non-JSON body as a transport failure", async () => {
    const unversioned = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () =>
        reply({ error: "X" }, 502)) as unknown as typeof fetch,
    });
    await expect(unversioned.run(request())).rejects.toThrow(
      "outside this contract",
    );
    const html = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: (async () =>
        new Response("<html>", { status: 502 })) as unknown as typeof fetch,
    });
    await expect(html.run(request())).rejects.toThrow("not JSON");
  });

  it("passes an abort through untouched", async () => {
    const controller = new AbortController();
    const client = createArchiveStudyClient({
      token: TOKEN,
      fetchImpl: ((_path: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        })) as unknown as typeof fetch,
    });
    const pending = client.run(request(), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses to build without a token", () => {
    expect(() => createArchiveStudyClient({ token: "" })).toThrow(
      "bearer token",
    );
  });

  it("frames profiles and prints with the chart identity", () => {
    const identity = { provider: "DATABENTO", assetClass: "FUTURE" } as const;
    const fields = { ...profileBody(), mode: "continuous" } as Parameters<
      typeof profileFrameFor
    >[0];
    expect(profileFrameFor(fields, "ES", identity)).toMatchObject({
      type: "profile",
      symbol: "ES",
      provider: "DATABENTO",
      period_start_ts: START,
    });
    const marker = markerFrameFor(
      { ts_exchange: START, price: 6000, size: 40, side: "sell" },
      3,
      "ES",
      identity,
    );
    expect(marker).toMatchObject({
      type: "marker",
      symbol: "ES",
      provider: "DATABENTO",
      assetClass: "FUTURE",
      size: 40,
      side: "sell",
    });
    expect(marker.trade_id).toBe(`archive:${START}:sell:3`);
  });
});
