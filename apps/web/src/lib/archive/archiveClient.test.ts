import { describe, expect, it, vi } from "vitest";
import {
  createArchiveClient,
  ArchiveTransportError,
  ARCHIVE_CONTRACT_VERSION,
  ARCHIVE_QUERY_PATH,
  ARCHIVE_RESTART_HEADER,
} from "./archiveClient";

const TOKEN = "t".repeat(24);
const BASE = "1756684800000000000";

function page(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: ARCHIVE_CONTRACT_VERSION,
    rows: [{ event_ns: BASE, record_id: "rec-1" }],
    nextCursor: null,
    pointerToken: "token-1",
    queryFingerprint: "f".repeat(64),
    family: "trade",
    coverage: { requested: { from: BASE, to: "1756684800000001000" }, served: null, partitions: 1, states: {}, corrupt: [] },
    scan: { partitionsRead: 1 },
    ...overrides,
  };
}

function response(body: unknown, { status = 200, headers = {} as Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function query(overrides: Record<string, unknown> = {}) {
  return {
    instrumentId: '["XCME","FUTURE","NQU5","USD","CONTRACT"]',
    family: "trade" as const,
    from: BASE,
    to: "1756684800000001000",
    ...overrides,
  };
}

describe("archive client", () => {
  it("sends the bearer token and the contract version to the archive path", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(page()));
    const client = createArchiveClient({ token: TOKEN, fetchImpl });

    await client.query(query({ limit: 100 }));

    const [path, init] = fetchImpl.mock.calls[0];
    expect(path).toBe(ARCHIVE_QUERY_PATH);
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body)).toMatchObject({
      contractVersion: ARCHIVE_CONTRACT_VERSION, family: "trade", limit: 100,
    });
  });

  it("omits fields the caller left undefined rather than sending them as null", async () => {
    // The request declares additionalProperties false and each optional field
    // has its own type. Sending `limit: undefined` serialises to nothing, but
    // an explicit null would be refused -- so the difference has to be kept.
    const fetchImpl = vi.fn().mockResolvedValue(response(page()));
    const client = createArchiveClient({ token: TOKEN, fetchImpl });

    await client.query(query({ limit: undefined }));

    expect(Object.keys(JSON.parse(fetchImpl.mock.calls[0][1].body))).not.toContain("limit");
  });

  it("returns a page the caller can read directly", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(page({ nextCursor: "cursor-2" })));
    const client = createArchiveClient({ token: TOKEN, fetchImpl });

    const result = await client.query(query());

    expect(result.outcome).toBe("page");
    if (result.outcome !== "page") throw new Error("unreachable");
    expect(result.rows).toHaveLength(1);
    expect(result.nextCursor).toBe("cursor-2");
    expect(result.pointerToken).toBe("token-1");
  });

  it("reports a refusal as data, not as an exception", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(
      { contractVersion: ARCHIVE_CONTRACT_VERSION, error: "WINDOW_TOO_LARGE", detail: "too big" },
      { status: 413 }));
    const client = createArchiveClient({ token: TOKEN, fetchImpl });

    const result = await client.query(query());

    expect(result).toEqual({
      outcome: "refused", code: "WINDOW_TOO_LARGE", detail: "too big",
      status: 413, retryAfterMs: null,
    });
  });

  it("surfaces a rate refusal with the delay the server asked for", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(
      { contractVersion: ARCHIVE_CONTRACT_VERSION, error: "OVERLOADED", retryAfterMs: 2_500 },
      { status: 429 }));
    const client = createArchiveClient({ token: TOKEN, fetchImpl });

    const result = await client.query(query());

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("unreachable");
    expect(result.retryAfterMs).toBe(2_500);
  });

  it("distinguishes a restart from an ordinary refusal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(
      { contractVersion: ARCHIVE_CONTRACT_VERSION, error: "POINTER_TOKEN_INVALID" },
      { status: 409, headers: { [ARCHIVE_RESTART_HEADER]: "1" } }));
    const client = createArchiveClient({ token: TOKEN, fetchImpl });

    const result = await client.query(query());

    expect(result).toEqual({ outcome: "restart", code: "POINTER_TOKEN_INVALID" });
  });

  it("emits a restart marker instead of mixing generations when the service restarts mid-scroll", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(page({ nextCursor: "cursor-2" })))
      .mockResolvedValueOnce(response(
        { contractVersion: ARCHIVE_CONTRACT_VERSION, error: "POINTER_TOKEN_INVALID" },
        { status: 409, headers: { [ARCHIVE_RESTART_HEADER]: "1" } }));
    const client = createArchiveClient({ token: TOKEN, fetchImpl });

    const collected = [];
    for await (const result of client.pages(query())) collected.push(result);

    expect(collected).toHaveLength(2);
    expect(collected[0].outcome).toBe("page");
    expect(collected[1]).toEqual({ outcome: "restart", code: "POINTER_TOKEN_INVALID" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("pages until the cursor runs out, carrying the pinned snapshot forward", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(page({ nextCursor: "cursor-2", pointerToken: "pinned" })))
      .mockResolvedValueOnce(response(page({ nextCursor: null, pointerToken: "pinned" })));
    const client = createArchiveClient({ token: TOKEN, fetchImpl });

    const collected = [];
    for await (const result of client.pages(query())) collected.push(result);

    expect(collected).toHaveLength(2);
    const second = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(second.cursor).toBe("cursor-2");
    expect(second.pointerToken).toBe("pinned");
  });

  it("raises rather than pretending when the body is not this contract", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ hello: "world" }));
    const client = createArchiveClient({ token: TOKEN, fetchImpl });

    await expect(client.query(query())).rejects.toBeInstanceOf(ArchiveTransportError);
  });

  it("raises rather than returning a half-built page", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(page({ pointerToken: 7 })));
    const client = createArchiveClient({ token: TOKEN, fetchImpl });

    await expect(client.query(query())).rejects.toThrow(/does not match the contract/);
  });

  it("rejects a page from a different archive family", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(page({ family: "quote" })));
    const client = createArchiveClient({ token: TOKEN, fetchImpl });

    await expect(client.query(query())).rejects.toThrow(/does not match the contract/);
  });

  it("reports an unreachable archive as a transport error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = createArchiveClient({ token: TOKEN, fetchImpl });

    await expect(client.query(query())).rejects.toThrow(/could not be reached/);
  });

  it("lets a caller's abort through untouched", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });
    const client = createArchiveClient({ token: TOKEN, fetchImpl });

    await expect(client.query(query(), { signal: controller.signal }))
      .rejects.toThrow(/aborted/);
  });

  it("refuses to be built without a token", () => {
    expect(() => createArchiveClient({ token: "" })).toThrow(/bearer token is required/);
  });
});
