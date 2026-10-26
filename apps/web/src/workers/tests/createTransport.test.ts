// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import klineRows from "./fixtures/binance-mirror/klines.json";

// The worker module assigns `self.onmessage` and calls `postMessage` at import
// time, so it is re-imported per test with the globals stubbed, as
// ../marketDataWorker.test.ts does.

class FakeClientWebSocket {
  static instances: FakeClientWebSocket[] = [];
  static OPEN = 1;
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeClientWebSocket.instances.push(this);
  }
  close() {
    this.readyState = 3;
  }
  send() {}
}

const loadedWorkers: Array<NonNullable<typeof self.onmessage>> = [];
afterEach(() => {
  for (const handler of loadedWorkers.splice(0)) handler.call(self, { data: { kind: "stop" } } as MessageEvent);
  vi.unstubAllGlobals();
});

async function loadWorkerModule() {
  vi.resetModules();
  FakeClientWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeClientWebSocket);
  const posted: unknown[] = [];
  vi.stubGlobal("postMessage", (message: unknown) => {
    posted.push(message);
  });
  const workerModule = await import("../marketDataWorker");
  const transportModule = await import("../browserBinanceTransport");
  if (self.onmessage) loadedWorkers.push(self.onmessage);
  return { posted, workerModule, transportModule };
}

describe("createTransport", () => {
  it("returns the real WebSocket when no source is set and the browser-direct transport when it is", async () => {
    const { workerModule, transportModule } = await loadWorkerModule();
    const plain = workerModule.createTransport("ws://127.0.0.1:8000/ws", undefined);
    expect(plain).toBeInstanceOf(FakeClientWebSocket);
    expect((plain as unknown as FakeClientWebSocket).url).toBe("ws://127.0.0.1:8000/ws");
    const direct = workerModule.createTransport("ws://127.0.0.1:8000/ws", "browser-binance");
    expect(direct).toBeInstanceOf(transportModule.BrowserBinanceTransport);
    expect(FakeClientWebSocket.instances).toHaveLength(1);
    direct.close();
  });

  it("a start without a source opens a real WebSocket to the runtime, exactly as before", async () => {
    const { posted } = await loadWorkerModule();
    self.onmessage!({ data: { kind: "start", url: "ws://127.0.0.1:8000/ws" } } as MessageEvent);
    expect(FakeClientWebSocket.instances).toHaveLength(1);
    expect(posted).toEqual([{ kind: "status", status: "connecting" }]);
  });

  it("a start with an unknown source is refused like an invalid URL", async () => {
    const { posted } = await loadWorkerModule();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      self.onmessage!({ data: { kind: "start", url: "ws://127.0.0.1:8000/ws", source: "something-else" } } as MessageEvent);
      expect(FakeClientWebSocket.instances).toHaveLength(0);
      expect(posted).toEqual([{ kind: "status", status: "closed", reason: "invalid-start-url" }]);
    } finally {
      warn.mockRestore();
    }
  });

  it("a start with source browser-binance opens no runtime socket, and the frames it produces pass the worker's own parser on the way to the main thread", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(klineRows), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    // Bars older than eight days are rejected by the live window, so the
    // fixture minute is treated as now.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_761_400_150_000);
    try {
      const { posted } = await loadWorkerModule();
      self.onmessage!({ data: { kind: "start", url: "ws://127.0.0.1:8000/ws", source: "browser-binance" } } as MessageEvent);
      expect(FakeClientWebSocket.instances).toHaveLength(0);
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(7));
      const kinds = posted.map((message) => {
        const typed = message as { kind: string; status?: string; frame?: { type: string } };
        return typed.kind === "status" ? `status:${typed.status}` : `frame:${typed.frame?.type}`;
      });
      expect(kinds).toEqual(["status:connecting", "status:open", "frame:selection", "frame:snapshot", "frame:health", "frame:book", "frame:bar"]);
      const health = (posted[4] as { frame: Record<string, unknown> }).frame;
      expect(health).toMatchObject({ recoveryState: "READY", reason: "BROWSER_DIRECT" });
      // The upstream stream is a real WebSocket in the browser; here it is the stubbed one.
      expect(FakeClientWebSocket.instances).toHaveLength(1);
      expect(FakeClientWebSocket.instances[0]!.url).toContain("data-stream.binance.vision");
    } finally {
      nowSpy.mockRestore();
    }
  });
});
