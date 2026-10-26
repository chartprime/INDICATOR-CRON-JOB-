const { remoteErrorDiagnostic } = require("../../src/storage/remote-error-diagnostic");

test("remote diagnostics are bounded, redact credentials and preserve reader deadline detail", async () => {
  const response = new Response(JSON.stringify({ error: "secret-key", detail: "replay-page-reader: timeout" }), { status: 503 });
  expect(await remoteErrorDiagnostic(response, "correlation-1", "secret-key")).toEqual({ correlationId: "correlation-1", error: "[REDACTED]", detail: "replay-page-reader: timeout" });
  const large = new Response(JSON.stringify({ detail: "x".repeat(5_000) }));
  expect((await remoteErrorDiagnostic(large, "id", "key")).detail).toBeNull();
});

test("a stalled error body cannot occupy the reader indefinitely", async () => {
  jest.useFakeTimers();
  try {
    const response = new Response(new ReadableStream({ start() {} }));
    const result = remoteErrorDiagnostic(response, "id", "key");
    await jest.advanceTimersByTimeAsync(1_000);
    expect(await result).toEqual({ correlationId: "id", error: null, detail: null });
    void response.body.cancel();
  } finally { jest.useRealTimers(); }
});
