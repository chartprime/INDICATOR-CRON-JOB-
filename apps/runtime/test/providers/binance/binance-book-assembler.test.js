const {
  createBinanceBookAssembler,
  MAX_RETAINED_DEPTH_LEVELS,
} = require("../../../src/providers/binance/binance-book-assembler");

// Real live-captured sequence (from the reference engagement,
// wss://stream.binance.com/stream, btcusdt@depth): a real REST snapshot
// plus the real WS diff events observed immediately around it. Proven
// live to satisfy the documented alignment and full-chain-contiguity
// conditions before ever being used as a test fixture.
const REAL_SNAPSHOT = { lastUpdateId: 98434073483, bids: [["100.00", "1.0"]], asks: [["200.00", "1.0"]] };
const REAL_BUFFERED_PAIRS = [
  [98434061565, 98434062288], [98434062289, 98434063957], [98434063958, 98434064177],
  [98434064178, 98434064497], [98434064498, 98434067726], [98434067727, 98434071631],
  [98434071632, 98434072183], [98434072184, 98434072598], [98434072599, 98434073113],
  [98434073114, 98434073356], [98434073357, 98434074773], [98434074774, 98434075407],
  [98434075408, 98434075578], [98434075579, 98434075907], [98434075908, 98434076325],
];

function depthEvent({ U, u, pu = null, bids = [], asks = [] }) {
  return {
    state: undefined,
    payload: { firstUpdateId: U, lastUpdateId: u, previousUpdateId: pu, bids, asks },
  };
}

function degradedEvent() {
  return { state: "UNAVAILABLE", reason: "MISSING_OR_INVALID_REQUIRED_FIELD" };
}

describe("binance-book-assembler", () => {
  test("rejects an unsupported market kind at construction", () => {
    expect(() => createBinanceBookAssembler({ marketKind: "MARGIN" })).toThrow(/marketKind/);
  });

  test("supports sequence-only depth reconciliation without materializing a sorted book", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    expect(assembler.applySnapshotStatus({
      lastUpdateId: 100,
      bids: [["99.0", "1.0"], ["98.0", "2.0"]],
      asks: [["101.0", "1.0"], ["102.0", "2.0"]],
    })).toEqual({ status: "BUFFERING" });
    expect(assembler.applyDeltaEventStatus(depthEvent({
      U: 101,
      u: 101,
      bids: [["100.0", "3.0"]],
    }))).toEqual({ status: "READY" });

    expect(assembler.getState()).toEqual({
      status: "READY",
      book: {
        bids: [["100.0", "3.0"], ["99.0", "1.0"], ["98.0", "2.0"]],
        asks: [["101.0", "1.0"], ["102.0", "2.0"]],
        lastUpdateId: 101,
      },
    });
  });

  test("assembles the real live-captured sequence correctly end to end (spot)", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    for (const [U, u] of REAL_BUFFERED_PAIRS) {
      assembler.applyDeltaEvent(depthEvent({ U, u }));
    }
    expect(assembler.getState()).toEqual({ status: "BUFFERING" });

    const result = assembler.applySnapshot(REAL_SNAPSHOT);
    expect(result.status).toBe("READY");
    expect(result.book.lastUpdateId).toBe(98434076325);
  });

  describe("spot algorithm (U/u contiguity)", () => {
    function readySpotAssembler() {
      const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
      assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
      return assembler;
    }

    test("accepts the first live event immediately following the snapshot (U == lastUpdateId + 1)", () => {
      const assembler = readySpotAssembler();
      const result = assembler.applyDeltaEvent(depthEvent({ U: 101, u: 105 }));
      expect(result.status).toBe("READY");
      expect(result.book.lastUpdateId).toBe(105);
    });

    test("ignores a duplicate/stale event (u < localUpdateId) without disturbing the book", () => {
      const assembler = readySpotAssembler();
      assembler.applyDeltaEvent(depthEvent({ U: 101, u: 110, bids: [["1.0", "5.0"]] }));
      const result = assembler.applyDeltaEvent(depthEvent({ U: 95, u: 99, bids: [["1.0", "999.0"]] }));
      expect(result.status).toBe("READY");
      expect(result.book.lastUpdateId).toBe(110);
      expect(result.book.bids).toEqual([["1.0", "5.0"]]);
    });

    test("detects a skipped-sequence gap (U > localUpdateId + 1) and transitions to UNAVAILABLE", () => {
      const assembler = readySpotAssembler();
      const result = assembler.applyDeltaEvent(depthEvent({ U: 103, u: 108 }));
      expect(result).toEqual({ status: "UNAVAILABLE", reason: "SEQUENCE_GAP" });
    });

    test("SPOT: a gap on an already-READY book uses U/u continuity, not the snapshot-bridge rule", () => {
      const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
      assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
      assembler.applyDeltaEvent(depthEvent({ U: 101, u: 105 }));
      expect(assembler.getState().status).toBe("READY");

      const result = assembler.applyDeltaEvent(depthEvent({ U: 108, u: 110 }));
      expect(result).toEqual({ status: "UNAVAILABLE", reason: "SEQUENCE_GAP" });
    });

    test("rejects a snapshot too old relative to what's already buffered", () => {
      const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
      assembler.applyDeltaEvent(depthEvent({ U: 200, u: 210 }));
      const result = assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
      expect(result).toEqual({ status: "UNAVAILABLE", reason: "SNAPSHOT_TOO_OLD" });
    });
  });

  describe("USD-M perpetual algorithm (pu chain)", () => {
    function readyPerpAssembler() {
      const assembler = createBinanceBookAssembler({ marketKind: "PERPETUAL" });
      // Buffer a bridging event before the snapshot arrives so establishment
      // goes through applySnapshot's own synchronous alignment check, the
      // same way "discards buffered events already covered by the snapshot"
      // proves it below -- these tests are about ongoing pu-chain behavior
      // on an already-established book, not about establishment itself.
      assembler.applyDeltaEvent(depthEvent({ U: 95, u: 100, pu: 94 }));
      assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
      return assembler;
    }

    test("accepts a live event whose pu equals the local update ID", () => {
      const assembler = readyPerpAssembler();
      const result = assembler.applyDeltaEvent(depthEvent({ U: 101, u: 105, pu: 100 }));
      expect(result.status).toBe("READY");
      expect(result.book.lastUpdateId).toBe(105);
    });

    test("detects a broken pu chain and transitions to UNAVAILABLE, even when U/u alone would look contiguous", () => {
      const assembler = readyPerpAssembler();
      assembler.applyDeltaEvent(depthEvent({ U: 101, u: 105, pu: 100 }));
      // U=106 looks perfectly contiguous by spot's own rule, but pu=999 does
      // not match the real previous u (105) -- USD-M's own chain is broken.
      const result = assembler.applyDeltaEvent(depthEvent({ U: 106, u: 110, pu: 999 }));
      expect(result).toEqual({ status: "UNAVAILABLE", reason: "SEQUENCE_GAP" });
    });

    test("ignores a duplicate/stale event (u < localUpdateId) the same way spot does", () => {
      const assembler = readyPerpAssembler();
      assembler.applyDeltaEvent(depthEvent({ U: 101, u: 110, pu: 100, bids: [["1.0", "5.0"]] }));
      const result = assembler.applyDeltaEvent(depthEvent({ U: 90, u: 95, pu: 89, bids: [["1.0", "999.0"]] }));
      expect(result.book.lastUpdateId).toBe(110);
      expect(result.book.bids).toEqual([["1.0", "5.0"]]);
    });

    test("ignores an EXACT duplicate redelivery (u == localUpdateId) as stale, not a broken pu chain", () => {
      // A retransmitted copy of the very last applied event carries its OLD
      // pu (pointing at what preceded IT), which will never equal the
      // current localUpdateId -- so without an explicit exact-duplicate
      // short-circuit, this was misread as a broken chain instead of a
      // harmless replay.
      const assembler = readyPerpAssembler();
      const applied = assembler.applyDeltaEvent(depthEvent({ U: 101, u: 110, pu: 100, bids: [["1.0", "5.0"]] }));
      expect(applied.status).toBe("READY");

      const duplicate = assembler.applyDeltaEvent(depthEvent({ U: 101, u: 110, pu: 100, bids: [["1.0", "5.0"]] }));
      expect(duplicate.status).toBe("READY");
      expect(duplicate.book.lastUpdateId).toBe(110);
      expect(duplicate.book.bids).toEqual([["1.0", "5.0"]]);
    });
  });

  describe("first live event after a snapshot resolves with an empty buffer (no WS event buffered yet)", () => {
    // Realistic race: the REST snapshot fetch resolves before the very first
    // WS diff event has arrived. Binance's own algorithm still validates the
    // first post-snapshot event using the snapshot-bridge rule (spot: U <=
    // lastUpdateId+1; USD-M: U <= lastUpdateId <= u), NOT the ongoing pu-chain
    // rule -- pu refers to the previous WS event, which has no relationship
    // to a REST snapshot's lastUpdateId.
    test("reports BUFFERING, not READY, immediately after a valid snapshot with nothing buffered to confirm it", () => {
      const spotAssembler = createBinanceBookAssembler({ marketKind: "SPOT" });
      expect(spotAssembler.applySnapshot({ lastUpdateId: 100, bids: [["1.0", "1.0"]], asks: [] }).status).toBe(
        "BUFFERING",
      );

      const perpAssembler = createBinanceBookAssembler({ marketKind: "PERPETUAL" });
      expect(perpAssembler.applySnapshot({ lastUpdateId: 100, bids: [["1.0", "1.0"]], asks: [] }).status).toBe(
        "BUFFERING",
      );
    });

    test("PERPETUAL: bridges via containment, ignoring a pu value that would never legitimately match", () => {
      const assembler = createBinanceBookAssembler({ marketKind: "PERPETUAL" });
      const afterSnapshot = assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
      expect(afterSnapshot.status).toBe("BUFFERING");

      // U=95 <= 100 and u=105 >= 100: satisfies containment. pu is
      // deliberately wrong (999) to prove it is correctly ignored for this
      // specific bridging event.
      const result = assembler.applyDeltaEvent(depthEvent({ U: 95, u: 105, pu: 999 }));
      expect(result.status).toBe("READY");
      expect(result.book.lastUpdateId).toBe(105);
    });

    test("PERPETUAL: rejects a first event that fails snapshot containment", () => {
      const assembler = createBinanceBookAssembler({ marketKind: "PERPETUAL" });
      assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });

      // U=101 > lastUpdateId=100: the first post-snapshot event does not
      // cover the snapshot ID and therefore cannot establish a verified book.
      const result = assembler.applyDeltaEvent(depthEvent({ U: 101, u: 105, pu: 999 }));
      expect(result).toEqual({ status: "UNAVAILABLE", reason: "SEQUENCE_GAP" });
    });

    test("PERPETUAL: does not treat a pu pointer as a substitute for snapshot containment", () => {
      // Binance's USD-M bootstrap contract requires the first processed
      // event to span lastUpdateId. A pu pointer governs only subsequent
      // stream-to-stream continuity.
      const assembler = createBinanceBookAssembler({ marketKind: "PERPETUAL" });
      assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });

      const result = assembler.applyDeltaEvent(depthEvent({ U: 106, u: 110, pu: 100 }));
      expect(result).toEqual({ status: "UNAVAILABLE", reason: "SEQUENCE_GAP" });
    });

    test("PERPETUAL: discards a covered/late-arriving event before finding the real bridge candidate", () => {
      const assembler = createBinanceBookAssembler({ marketKind: "PERPETUAL" });
      assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });

      // Arrives after the snapshot but is fully covered by it (u < lastUpdateId,
      // strict for USD-M) -- reordering on the wire, must be discarded, not
      // mistaken for the bridge candidate.
      assembler.applyDeltaEvent(depthEvent({ U: 90, u: 95, pu: 89 }));
      const result = assembler.applyDeltaEvent(depthEvent({ U: 96, u: 106, pu: 95 }));
      expect(result.status).toBe("READY");
      expect(result.book.lastUpdateId).toBe(106);
    });

    test("SPOT: still bridges correctly via the same (here, equivalent) rule", () => {
      const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
      assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
      const result = assembler.applyDeltaEvent(depthEvent({ U: 101, u: 105 }));
      expect(result.status).toBe("READY");
      expect(result.book.lastUpdateId).toBe(105);
    });
  });

  test("spot and USD-M genuinely use different alignment boundaries, not the same rule plus one field", () => {
    // snapshot.lastUpdateId = 100, first buffered event U=101 u=105.
    // Spot's rule (U <= lastUpdateId+1 = 101): 101 <= 101 -> passes.
    // USD-M's rule (U <= lastUpdateId AND u >= lastUpdateId): 101 <= 100 -> fails.
    const spotAssembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    spotAssembler.applyDeltaEvent(depthEvent({ U: 101, u: 105 }));
    const spotResult = spotAssembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    expect(spotResult.status).toBe("READY");

    // pu deliberately does not match lastUpdateId, so this isolates the
    // containment-vs-adjacency difference without also exercising the
    // separate pu-pointer bridge fallback (covered above).
    const perpAssembler = createBinanceBookAssembler({ marketKind: "PERPETUAL" });
    perpAssembler.applyDeltaEvent(depthEvent({ U: 101, u: 105, pu: 999 }));
    const perpResult = perpAssembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    expect(perpResult).toEqual({ status: "UNAVAILABLE", reason: "SNAPSHOT_TOO_OLD" });
  });

  test("discards buffered events already covered by the snapshot using each market's own exact boundary", () => {
    // Spot discards u <= lastUpdateId (inclusive); USD-M discards u < lastUpdateId (strict).
    // An event with u exactly equal to lastUpdateId must be discarded for spot
    // but retained (and must bridge) for USD-M.
    const spotAssembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    spotAssembler.applyDeltaEvent(depthEvent({ U: 95, u: 100 }));
    spotAssembler.applyDeltaEvent(depthEvent({ U: 101, u: 105 }));
    const spotResult = spotAssembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    expect(spotResult.status).toBe("READY");
    expect(spotResult.book.lastUpdateId).toBe(105);

    const perpAssembler = createBinanceBookAssembler({ marketKind: "PERPETUAL" });
    perpAssembler.applyDeltaEvent(depthEvent({ U: 95, u: 100, pu: 94 }));
    const perpResult = perpAssembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    // u=100 is NOT < lastUpdateId=100, so it is retained; it also bridges
    // (U=95<=100 and u=100>=100), so it gets applied on top of the snapshot.
    expect(perpResult.status).toBe("READY");
    expect(perpResult.book.lastUpdateId).toBe(100);
  });

  test("rejects a malformed snapshot body (missing lastUpdateId) and keeps buffering", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    const result = assembler.applySnapshot({ bids: [], asks: [] });
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "SNAPSHOT_MALFORMED" });
  });

  test("rejects a snapshot whose bids/asks are not valid tuple arrays", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    const result = assembler.applySnapshot({ lastUpdateId: 1, bids: [["1.0"]], asks: [] });
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "SNAPSHOT_MALFORMED" });
  });

  test("rejects a snapshot containing a negative price or quantity rather than accepting an impossible book level", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    const negativeQty = assembler.applySnapshot({ lastUpdateId: 1, bids: [["1.0", "-5.0"]], asks: [] });
    expect(negativeQty).toEqual({ status: "UNAVAILABLE", reason: "SNAPSHOT_MALFORMED" });

    const negativePrice = assembler.applySnapshot({ lastUpdateId: 1, bids: [["-1.0", "5.0"]], asks: [] });
    expect(negativePrice).toEqual({ status: "UNAVAILABLE", reason: "SNAPSHOT_MALFORMED" });
  });

  test("rejects a Proxy-wrapped snapshot body outright", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    const result = assembler.applySnapshot(new Proxy({ lastUpdateId: 1, bids: [], asks: [] }, {}));
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "SNAPSHOT_MALFORMED" });
  });

  test("never invokes an accessor-defined field on the snapshot body, rejecting it instead", () => {
    let reads = 0;
    const hostile = { bids: [], asks: [] };
    Object.defineProperty(hostile, "lastUpdateId", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return 100;
      },
    });
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    const result = assembler.applySnapshot(hostile);
    expect(reads).toBe(0);
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "SNAPSHOT_MALFORMED" });
  });

  test("accepts a realistic USD-M snapshot body carrying E/T, which spot's response never has", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "PERPETUAL" });
    const result = assembler.applySnapshot({
      lastUpdateId: 100,
      E: 1786449788013,
      T: 1786449788012,
      bids: [],
      asks: [],
    });
    // Not READY yet -- accepted (not SNAPSHOT_MALFORMED) is the point of this
    // test; READY only follows a confirming live delta (see the dedicated
    // "reports BUFFERING, not READY" tests for that distinction).
    expect(result.status).toBe("BUFFERING");
  });

  test("rejects a snapshot body carrying an unexpected extra field beyond the known superset", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    const result = assembler.applySnapshot({
      lastUpdateId: 100,
      bids: [],
      asks: [],
      symbol: "BTCUSDT",
    });
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "SNAPSHOT_MALFORMED" });
  });

  test("a malformed-snapshot or too-old attempt never regresses an already-READY book", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({ lastUpdateId: 100, bids: [["1.0", "5.0"]], asks: [] });
    assembler.applyDeltaEvent(depthEvent({ U: 101, u: 101 }));
    const afterBadAttempt = assembler.applySnapshot({ bids: [], asks: [] });
    expect(afterBadAttempt.status).toBe("READY");
    expect(afterBadAttempt.book.lastUpdateId).toBe(101);
  });

  test("drops the oldest buffered event once the pre-snapshot bound is exceeded, and reports BUFFER_OVERFLOW_BEFORE_SNAPSHOT", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    for (let i = 0; i < 1001; i += 1) {
      assembler.applyDeltaEvent(depthEvent({ U: i, u: i }));
    }
    expect(assembler.getState()).toEqual({ status: "UNAVAILABLE", reason: "BUFFER_OVERFLOW_BEFORE_SNAPSHOT" });
  });

  test("withdraws a READY book rather than retaining unbounded distinct price levels between snapshots", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    const snapshotLevels = Array.from({ length: 5000 }, (_, index) => [`${index + 1}`, "1"]);
    const firstDeltaLevels = Array.from({ length: 5000 }, (_, index) => [`${index + 5001}`, "1"]);

    assembler.applySnapshot({ lastUpdateId: 100, bids: snapshotLevels, asks: [] });
    expect(assembler.applyDeltaEventStatus(depthEvent({ U: 101, u: 101, bids: firstDeltaLevels })))
      .toEqual({ status: "READY" });

    expect(assembler.applyDeltaEventStatus(depthEvent({ U: 102, u: 102, bids: [["10001", "1"]] })))
      .toEqual({ status: "UNAVAILABLE", reason: "BOOK_LEVEL_CAP_EXCEEDED" });
    expect(assembler.getState()).toEqual({ status: "UNAVAILABLE", reason: "BOOK_LEVEL_CAP_EXCEEDED" });
    expect(MAX_RETAINED_DEPTH_LEVELS.SPOT).toBe(10_000);
  });

  test("rejects a perpetual REST snapshot that exceeds Binance's 1000-level contract", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "PERPETUAL" });
    const tooManyLevels = Array.from({ length: 1001 }, (_, index) => [`${index + 1}`, "1"]);
    expect(assembler.applySnapshot({ lastUpdateId: 100, bids: tooManyLevels, asks: [] }))
      .toEqual({ status: "UNAVAILABLE", reason: "SNAPSHOT_MALFORMED" });
  });

  test("does not overwrite an existing SEQUENCE_GAP reason with BUFFER_OVERFLOW while buffering for recovery", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    const gapResult = assembler.applyDeltaEvent(depthEvent({ U: 500, u: 505 }));
    expect(gapResult.reason).toBe("SEQUENCE_GAP");
    for (let i = 0; i < 1001; i += 1) {
      assembler.applyDeltaEvent(depthEvent({ U: 505 + i, u: 505 + i }));
    }
    expect(assembler.getState().reason).toBe("SEQUENCE_GAP");
  });

  test("does not overwrite an existing UPSTREAM_EVENT_UNAVAILABLE reason with BUFFER_OVERFLOW either -- the preservation rule is general, not SEQUENCE_GAP-specific", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    const invalidResult = assembler.applyDeltaEvent(degradedEvent());
    expect(invalidResult.reason).toBe("UPSTREAM_EVENT_UNAVAILABLE");
    for (let i = 0; i < 1001; i += 1) {
      assembler.applyDeltaEvent(depthEvent({ U: i, u: i }));
    }
    expect(assembler.getState().reason).toBe("UPSTREAM_EVENT_UNAVAILABLE");
  });

  test("an invalid/degraded delta event arriving while already UNAVAILABLE from a real SEQUENCE_GAP does not overwrite that reason", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    const gapResult = assembler.applyDeltaEvent(depthEvent({ U: 500, u: 505 }));
    expect(gapResult.reason).toBe("SEQUENCE_GAP");

    const afterInvalid = assembler.applyDeltaEvent(degradedEvent());
    expect(afterInvalid).toEqual({ status: "UNAVAILABLE", reason: "SEQUENCE_GAP" });
  });

  test("a too-old snapshot arriving while already UNAVAILABLE from SEQUENCE_GAP does not overwrite that reason", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    const gapResult = assembler.applyDeltaEvent(depthEvent({ U: 500, u: 505 }));
    expect(gapResult.reason).toBe("SEQUENCE_GAP");

    const afterTooOld = assembler.applySnapshot({ lastUpdateId: 1, bids: [], asks: [] });
    expect(afterTooOld).toEqual({ status: "UNAVAILABLE", reason: "SEQUENCE_GAP" });
  });

  test("rejects a delta event whose previousUpdateId is present but the wrong type, rather than letting it silently reach the pu-chain check", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "PERPETUAL" });
    assembler.applyDeltaEvent(depthEvent({ U: 95, u: 100, pu: 94 }));
    assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });

    const malformed = {
      state: undefined,
      payload: { firstUpdateId: 101, lastUpdateId: 105, previousUpdateId: "100", bids: [], asks: [] },
    };
    const result = assembler.applyDeltaEvent(malformed);
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "UPSTREAM_EVENT_UNAVAILABLE" });
  });

  test("detects a gap found while replaying the buffered backlog against a fresh snapshot, not just live", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applyDeltaEvent(depthEvent({ U: 101, u: 105 }));
    assembler.applyDeltaEvent(depthEvent({ U: 110, u: 115 })); // gap: expected U=106
    const result = assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "SEQUENCE_GAP" });
  });

  test("continues buffering through UNAVAILABLE so a queued event is ready to bridge once a fresh snapshot arrives", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    const gapResult = assembler.applyDeltaEvent(depthEvent({ U: 500, u: 505 }));
    expect(gapResult.status).toBe("UNAVAILABLE");

    // A fresh snapshot arrives later; the event queued during UNAVAILABLE is
    // still there to bridge from immediately.
    const recovered = assembler.applySnapshot({ lastUpdateId: 499, bids: [], asks: [] });
    expect(recovered.status).toBe("READY");
    expect(recovered.book.lastUpdateId).toBe(505);
  });

  test("a zero-quantity level removes it from the book", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({ lastUpdateId: 100, bids: [["50.00", "1.0"]], asks: [] });
    const result = assembler.applyDeltaEvent(
      depthEvent({ U: 101, u: 101, bids: [["50.00", "0.00000000"]] }),
    );
    expect(result.book.bids).toEqual([]);
  });

  test("a zero-quantity delta whose price string differs only by trailing zeros still removes the level", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({ lastUpdateId: 100, bids: [["50.00", "1.0"]], asks: [] });
    const result = assembler.applyDeltaEvent(
      depthEvent({ U: 101, u: 101, bids: [["50.0", "0"]] }),
    );
    expect(result.status).toBe("READY");
    expect(result.book.bids).toEqual([]);
  });

  test("an update whose price string differs only by trailing zeros replaces the existing level rather than duplicating it", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({ lastUpdateId: 100, bids: [["50.00", "1.0"]], asks: [] });
    const result = assembler.applyDeltaEvent(
      depthEvent({ U: 101, u: 101, bids: [["50.0", "2.0"]] }),
    );
    expect(result.status).toBe("READY");
    expect(result.book.bids).toEqual([["50.0", "2.0"]]);
  });

  test("removing a price level that was never present is a safe no-op, not an error", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    const result = assembler.applyDeltaEvent(
      depthEvent({ U: 101, u: 101, bids: [["999.00", "0.00000000"]] }),
    );
    expect(result.status).toBe("READY");
    expect(result.book.bids).toEqual([]);
  });

  test("a valid non-zero quantity far below Number's precision floor is not mistaken for a zero-quantity deletion", () => {
    const tinyQuantity = `0.${"0".repeat(400)}1`;
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    const result = assembler.applyDeltaEvent(
      depthEvent({ U: 101, u: 101, bids: [["50.00", tinyQuantity]] }),
    );
    expect(result.status).toBe("READY");
    expect(result.book.bids).toEqual([["50.00", tinyQuantity]]);
  });

  test("sort order survives price levels with more significant digits than Number's safe precision", () => {
    // Inserted in ascending order deliberately: bids must sort descending, so
    // this only passes if the comparator actually reorders them. At this
    // magnitude Number(a) === Number(b) for these two (both round to the
    // same float), so a comparator that routes through Number() returns a
    // tie and a stable sort leaves the (wrong) insertion order untouched --
    // this is the exact failure mode this test must catch.
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({
      lastUpdateId: 100,
      bids: [
        ["12345678901234567890.1", "1.0"],
        ["12345678901234567890.2", "1.0"],
      ],
      asks: [],
    });
    assembler.applyDeltaEvent(depthEvent({ U: 101, u: 101 }));
    const { book } = assembler.getState();
    expect(book.bids.map(([price]) => price)).toEqual([
      "12345678901234567890.2",
      "12345678901234567890.1",
    ]);
  });

  test("sorts bids descending and asks ascending by numeric price, regardless of insertion order", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({
      lastUpdateId: 100,
      bids: [["9.5", "1.0"], ["10.2", "1.0"], ["1.0", "1.0"]],
      asks: [["20.0", "1.0"], ["15.5", "1.0"], ["100.0", "1.0"]],
    });
    assembler.applyDeltaEvent(depthEvent({ U: 101, u: 101 }));
    const { book } = assembler.getState();
    expect(book.bids.map(([price]) => price)).toEqual(["10.2", "9.5", "1.0"]);
    expect(book.asks.map(([price]) => price)).toEqual(["15.5", "20.0", "100.0"]);
  });

  test("treats an upstream UNAVAILABLE (degraded) event as an unverifiable gap while READY", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    const result = assembler.applyDeltaEvent(degradedEvent());
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "UPSTREAM_EVENT_UNAVAILABLE" });
  });

  test("surfaces an upstream UNAVAILABLE event before the first snapshot too, not silently as BUFFERING", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    const result = assembler.applyDeltaEvent(degradedEvent());
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "UPSTREAM_EVENT_UNAVAILABLE" });
  });

  test("does not overwrite an existing BUFFER_OVERFLOW_BEFORE_SNAPSHOT reason with a later invalid pre-snapshot delta", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    for (let i = 0; i < 1001; i += 1) {
      assembler.applyDeltaEvent(depthEvent({ U: i, u: i }));
    }
    expect(assembler.getState().reason).toBe("BUFFER_OVERFLOW_BEFORE_SNAPSHOT");

    const result = assembler.applyDeltaEvent(degradedEvent());
    expect(result.reason).toBe("BUFFER_OVERFLOW_BEFORE_SNAPSHOT");
  });

  test("still recovers to READY normally after a pre-snapshot invalid delta, once a real snapshot and a bridging event arrive", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applyDeltaEvent(degradedEvent());
    const snapshotResult = assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    expect(snapshotResult.status).toBe("BUFFERING");

    const result = assembler.applyDeltaEvent(depthEvent({ U: 101, u: 105 }));
    expect(result.status).toBe("READY");
    expect(result.book.lastUpdateId).toBe(105);
  });

  test("rejects a hostile Proxy-wrapped delta event outright", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    const result = assembler.applyDeltaEvent(new Proxy(depthEvent({ U: 101, u: 105 }), {}));
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "UPSTREAM_EVENT_UNAVAILABLE" });
  });

  test("fails closed rather than throwing when a delta event's bids field is a revoked Proxy", () => {
    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    const hostileEvent = depthEvent({ U: 101, u: 105, bids: proxy });
    let result;
    expect(() => {
      result = assembler.applyDeltaEvent(hostileEvent);
    }).not.toThrow();
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "UPSTREAM_EVENT_UNAVAILABLE" });
  });

  test("never invokes a getter defined on a delta event's own payload update-ID fields, rejecting it instead", () => {
    let reads = 0;
    const hostilePayload = { bids: [], asks: [] };
    Object.defineProperty(hostilePayload, "firstUpdateId", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return 101;
      },
    });
    Object.defineProperty(hostilePayload, "lastUpdateId", { value: 105, enumerable: true, configurable: true });
    Object.defineProperty(hostilePayload, "previousUpdateId", { value: null, enumerable: true, configurable: true });
    const hostileEvent = { state: undefined, payload: hostilePayload };

    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    const result = assembler.applyDeltaEvent(hostileEvent);

    expect(reads).toBe(0);
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "UPSTREAM_EVENT_UNAVAILABLE" });
  });

  test("rejects a delta event whose bids tuple is malformed rather than crashing the price-level comparator", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    const result = assembler.applyDeltaEvent(
      depthEvent({ U: 101, u: 105, bids: [["1.0"]] }),
    );
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "UPSTREAM_EVENT_UNAVAILABLE" });
  });

  test("rejects a delta event whose asks tuple has a non-decimal-string quantity rather than applying it", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    const result = assembler.applyDeltaEvent(
      depthEvent({ U: 101, u: 105, asks: [["1.0", "not-a-number"]] }),
    );
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "UPSTREAM_EVENT_UNAVAILABLE" });
  });

  test("never invokes a getter defined on a delta event's own bids tuple element, rejecting it instead", () => {
    let reads = 0;
    const hostileBids = [];
    Object.defineProperty(hostileBids, 0, {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return ["1.0", "1.0"];
      },
    });
    Object.defineProperty(hostileBids, "length", { value: 1 });
    const hostileEvent = {
      state: undefined,
      payload: { firstUpdateId: 101, lastUpdateId: 105, previousUpdateId: null, bids: hostileBids, asks: [] },
    };

    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    const result = assembler.applyDeltaEvent(hostileEvent);

    expect(reads).toBe(0);
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "UPSTREAM_EVENT_UNAVAILABLE" });
  });

  test("rejects an update ID beyond Number.MAX_SAFE_INTEGER rather than accepting it with potential precision loss", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    const unsafeSnapshot = assembler.applySnapshot({
      lastUpdateId: Number.MAX_SAFE_INTEGER + 2,
      bids: [],
      asks: [],
    });
    expect(unsafeSnapshot.status).toBe("UNAVAILABLE");

    assembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    const unsafeLastUpdateId = assembler.applyDeltaEvent(
      depthEvent({ U: 101, u: Number.MAX_SAFE_INTEGER + 2 }),
    );
    expect(unsafeLastUpdateId).toEqual({ status: "UNAVAILABLE", reason: "UPSTREAM_EVENT_UNAVAILABLE" });

    const secondAssembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    secondAssembler.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    const unsafeFirstUpdateId = secondAssembler.applyDeltaEvent(
      depthEvent({ U: Number.MAX_SAFE_INTEGER + 2, u: 105 }),
    );
    expect(unsafeFirstUpdateId).toEqual({ status: "UNAVAILABLE", reason: "UPSTREAM_EVENT_UNAVAILABLE" });
  });

  test("rejects negative, reversed, or market-kind-inconsistent delta sequence metadata", () => {
    const spot = createBinanceBookAssembler({ marketKind: "SPOT" });
    spot.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    expect(spot.applyDeltaEvent(depthEvent({ U: -1, u: 101 }))).toEqual({
      status: "UNAVAILABLE",
      reason: "UPSTREAM_EVENT_UNAVAILABLE",
    });

    const reversed = createBinanceBookAssembler({ marketKind: "SPOT" });
    reversed.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    expect(reversed.applyDeltaEvent(depthEvent({ U: 102, u: 101 }))).toEqual({
      status: "UNAVAILABLE",
      reason: "UPSTREAM_EVENT_UNAVAILABLE",
    });

    const perpetual = createBinanceBookAssembler({ marketKind: "PERPETUAL" });
    expect(perpetual.applyDeltaEvent(depthEvent({ U: 101, u: 105, pu: null }))).toEqual({
      status: "UNAVAILABLE",
      reason: "UPSTREAM_EVENT_UNAVAILABLE",
    });
  });

  // Regression for a real production bug (found live, 2026-08-19):
  // market-data-server.js calls getState() after every envelope it
  // handles, not just DEPTH ones, to catch a stale-book transition even
  // when no further DEPTH events arrive. getState() used to re-sort the
  // entire bids/asks map from scratch on every call. On a deep,
  // actively-traded book, a burst of hundreds of trades/sec turned that
  // redundant per-trade sort into more CPU work than the second actually
  // contains, and the backlog compounded without bound for as long as
  // the burst lasted -- observed live as a growing multi-second latency
  // reading and the order book itself going stale (the whole event loop
  // was blocked, so the health/book checks that would have caught real
  // staleness couldn't run promptly either). Confirmed by direct
  // benchmark before fixing: the real sortedLevels() algorithm at
  // MAX_DEPTH_ENTRIES (5000/side) cost ~1s of CPU per ~300 redundant
  // calls -- over budget on its own. Fixed by memoizing the sorted book,
  // invalidated only when bids/asks actually change.
  describe("getState() memoization (regression, 2026-08-19 latency incident)", () => {
    function readySpotAssemblerWithLevels() {
      const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
      assembler.applySnapshot({
        lastUpdateId: 100,
        bids: [["10.00", "1.0"]],
        asks: [["20.00", "1.0"]],
      });
      assembler.applyDeltaEvent(depthEvent({ U: 101, u: 105 }));
      return assembler;
    }

    test("repeated getState() calls with no intervening depth mutation return the exact same book reference, not a freshly-sorted one", () => {
      const assembler = readySpotAssemblerWithLevels();
      const first = assembler.getState();
      const second = assembler.getState();
      const third = assembler.getState();
      expect(first.status).toBe("READY");
      expect(second.book).toBe(first.book);
      expect(third.book).toBe(first.book);
    });

    test("a real depth mutation invalidates the cache -- the next getState() reflects the new data, not the stale reference", () => {
      const assembler = readySpotAssemblerWithLevels();
      const before = assembler.getState();

      const after = assembler.applyDeltaEvent(depthEvent({ U: 106, u: 110, bids: [["10.00", "999.0"]] }));

      expect(after.book).not.toBe(before.book);
      expect(after.book.bids).toEqual([["10.00", "999.0"]]);
    });

    test("a snapshot re-application also invalidates the cache", () => {
      const assembler = readySpotAssemblerWithLevels();
      const before = assembler.getState();

      const resnapped = assembler.applySnapshot({
        lastUpdateId: 200,
        bids: [["50.00", "1.0"]],
        asks: [["60.00", "1.0"]],
      });
      assembler.applyDeltaEvent(depthEvent({ U: 201, u: 205 }));
      const after = assembler.getState();

      expect(resnapped.status).toBe("BUFFERING");
      expect(after.book).not.toBe(before.book);
      expect(after.book.bids).toEqual([["50.00", "1.0"]]);
    });
  });

  test("rejects zero-priced and crossed snapshots instead of publishing an impossible ladder", () => {
    const zeroPrice = createBinanceBookAssembler({ marketKind: "SPOT" });
    expect(zeroPrice.applySnapshot({ lastUpdateId: 1, bids: [["0", "1"]], asks: [] })).toEqual({
      status: "UNAVAILABLE",
      reason: "SNAPSHOT_MALFORMED",
    });

    const crossed = createBinanceBookAssembler({ marketKind: "SPOT" });
    expect(crossed.applySnapshot({ lastUpdateId: 1, bids: [["101", "1"]], asks: [["100", "1"]] })).toEqual({
      status: "UNAVAILABLE",
      reason: "CROSSED_BOOK",
    });

    const locked = createBinanceBookAssembler({ marketKind: "SPOT" });
    expect(locked.applySnapshot({ lastUpdateId: 1, bids: [["100.50", "1"]], asks: [["100.5", "1"]] })).toEqual({
      status: "UNAVAILABLE",
      reason: "CROSSED_BOOK",
    });
  });

  test("a delta that crosses a ready book invalidates it immediately", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
    assembler.applySnapshot({ lastUpdateId: 100, bids: [["99", "1"]], asks: [["101", "1"]] });
    assembler.applyDeltaEvent(depthEvent({ U: 101, u: 101 }));

    expect(assembler.applyDeltaEvent(depthEvent({ U: 102, u: 102, bids: [["102", "1"]] }))).toEqual({
      status: "UNAVAILABLE",
      reason: "CROSSED_BOOK",
    });
  });

  test("best-price tracking is recomputed when a best level is deleted", () => {
    const bidDeletion = createBinanceBookAssembler({ marketKind: "SPOT" });
    bidDeletion.applySnapshot({
      lastUpdateId: 100,
      bids: [["99", "1"], ["98", "1"]],
      asks: [["101", "1"]],
    });
    bidDeletion.applyDeltaEventStatus(depthEvent({ U: 101, u: 101 }));
    expect(bidDeletion.applyDeltaEventStatus(depthEvent({
      U: 102,
      u: 102,
      bids: [["99", "0"]],
      asks: [["98.5", "1"]],
    }))).toEqual({ status: "READY" });

    const askDeletion = createBinanceBookAssembler({ marketKind: "SPOT" });
    askDeletion.applySnapshot({
      lastUpdateId: 100,
      bids: [["99", "1"]],
      asks: [["101", "1"], ["102", "1"]],
    });
    askDeletion.applyDeltaEventStatus(depthEvent({ U: 101, u: 101 }));
    expect(askDeletion.applyDeltaEventStatus(depthEvent({
      U: 102,
      u: 102,
      bids: [["101.5", "1"]],
      asks: [["101", "0"]],
    }))).toEqual({ status: "READY" });
  });

  test("signals a proactive refresh before the perpetual retained-level hard cap is reached", () => {
    const assembler = createBinanceBookAssembler({ marketKind: "PERPETUAL" });
    const snapshotBids = Array.from({ length: 1_000 }, (_, index) => [`${index + 1}`, "1"]);
    const deltaBids = Array.from({ length: 3_000 }, (_, index) => [`${index + 1_001}`, "1"]);
    assembler.applySnapshot({ lastUpdateId: 100, bids: snapshotBids, asks: [] });
    expect(assembler.shouldRefreshSnapshot()).toBe(false);

    assembler.applyDeltaEventStatus(depthEvent({
      U: 100,
      u: 101,
      pu: 100,
      bids: deltaBids,
    }));
    expect(assembler.getStatus()).toEqual({ status: "READY" });
    expect(assembler.shouldRefreshSnapshot()).toBe(true);
  });
});

test("the READY status carries the best prices non-enumerably, so it still compares as { status } and costs no sort", () => {
  const assembler = createBinanceBookAssembler({ marketKind: "SPOT" });
  assembler.applyDeltaEventStatus(depthEvent({ U: 101, u: 102, bids: [["99.0", "1.0"], ["98.0", "2.0"]], asks: [["101.0", "1.0"], ["102.5", "3.0"]] }));
  const status = assembler.applySnapshotStatus({ lastUpdateId: 100, bids: [["100.0", "3.0"]], asks: [["101.0", "1.0"]] });
  expect(status).toEqual({ status: "READY" });
  // Best prices are the assembler's canonical keys, so "100.0" reads back as "100".
  expect(status.bestBid).toBe("100");
  expect(status.bestAsk).toBe("101");
  const next = assembler.applyDeltaEventStatus(depthEvent({ U: 103, u: 103, bids: [["100.5", "1.0"]], asks: [] }));
  expect(next).toEqual({ status: "READY" });
  expect(next.bestBid).toBe("100.5");
  expect(assembler.getState().book.bids[0][0]).toBe("100.5");
});

// Property: however levels are inserted, updated and removed, the book the
// assembler reports is exactly what a fresh sort of every retained level gives,
// and the best prices are that sort's top of book. Oracle: an independent
// mirror of the retained levels re-sorted from scratch after every event, with
// the same numeric-then-decimal-string order the assembler documents; the
// stream repeatedly deletes the best level, the case that used to rescan.
test("the sorted book and the best prices always equal a fresh sort of the retained levels, across thousands of best-level deletions", () => {
  let state = 12345;
  const random = () => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return state / 2_147_483_648; };
  const price = (n) => (n / 100).toFixed(2);
  const orderKey = (a, b) => (Number(a) - Number(b)) || (a < b ? -1 : a > b ? 1 : 0);
  const assembler = createBinanceBookAssembler({ marketKind: "PERPETUAL" });
  const mirror = { bids: new Map(), asks: new Map() };
  const apply = (side, tuples) => {
    for (const [p, q] of tuples) {
      const key = String(Number(p));
      if (Number(q) === 0) mirror[side].delete(key);
      else mirror[side].set(key, [p, q]);
    }
  };
  const snapshot = { lastUpdateId: 1000, bids: [], asks: [] };
  for (let i = 0; i < 300; i += 1) {
    snapshot.bids.push([price(9_990 - i * 3), "1"]);
    snapshot.asks.push([price(10_010 + i * 3), "1"]);
  }
  assembler.applySnapshot(snapshot);
  apply("bids", snapshot.bids);
  apply("asks", snapshot.asks);
  expect(assembler.applyDeltaEventStatus(depthEvent({ U: 1000, u: 1001, pu: 999, bids: [], asks: [] }))).toEqual({ status: "READY" });
  let deletedBest = 0;
  for (let u = 1002; u < 4000; u += 1) {
    const book = assembler.getState().book;
    const bids = [];
    const asks = [];
    const roll = random();
    if (roll < 0.35 && book.bids.length > 1) { bids.push([book.bids[0][0], "0"]); deletedBest += 1; }
    else if (roll < 0.7 && book.asks.length > 1) { asks.push([book.asks[0][0], "0"]); deletedBest += 1; }
    else {
      const mid = (Number(book.bids[0][0]) + Number(book.asks[0][0])) / 2;
      const below = price(Math.round((mid - 0.01 - random() * 5) * 100));
      const above = price(Math.round((mid + 0.01 + random() * 5) * 100));
      bids.push([below, (1 + Math.floor(random() * 9)).toString()]);
      asks.push([above, (1 + Math.floor(random() * 9)).toString()]);
    }
    const status = assembler.applyDeltaEventStatus(depthEvent({ U: u, u, pu: u - 1, bids, asks }));
    expect(status).toEqual({ status: "READY" });
    apply("bids", bids);
    apply("asks", asks);
    const expectedBids = [...mirror.bids.keys()].sort(orderKey).reverse();
    const expectedAsks = [...mirror.asks.keys()].sort(orderKey);
    const reported = assembler.getState().book;
    expect(reported.bids.map(([p]) => String(Number(p)))).toEqual(expectedBids);
    expect(reported.asks.map(([p]) => String(Number(p)))).toEqual(expectedAsks);
    expect(String(Number(status.bestBid))).toBe(expectedBids[0]);
    expect(String(Number(status.bestAsk))).toBe(expectedAsks[0]);
    expect(Number(status.bestBid)).toBeLessThan(Number(status.bestAsk));
  }
  expect(deletedBest).toBeGreaterThan(1_500);
});
