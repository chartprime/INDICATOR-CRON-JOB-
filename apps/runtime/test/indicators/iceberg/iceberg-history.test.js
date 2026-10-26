const { createIcebergHistory, wireIcebergOf, validWireIceberg, ICEBERG_HISTORY_VERSION, DEFAULT_MAX_SPANS, ORIGINS, WIRE_FIELDS } = require("../../../src/indicators/iceberg/iceberg-history");
const { icebergOrdersFrame, MAX_ICEBERG_ID_LENGTH, ICEBERG_KINDS, ICEBERG_CONFIDENCES, ICEBERG_SIDES, ICEBERG_STATUSES, ICEBERG_ORIGINS } = require("../../../src/server/iceberg-frames");
const { sizeCeilingFor, MAX_WIRE_MAGNITUDE } = require("../../../src/server/wire-fields");

const DAY = 86_400_000;

function native(overrides = {}) {
  return {
    id: "/NQZ26:XCME|5137554220647449213|1000", symbol: "/NQZ26:XCME", kind: "native", confidence: "certain", origin: "runtime", side: "bid", price: 31188,
    display: 10, tranches: 4, executed: 32, startedAt: 1000, firstRefillAt: 1500, updatedAt: 9000, status: "filled", ...overrides,
  };
}

function probable(overrides = {}) {
  return {
    id: "BTCUSDT|PERPETUAL|ask|80924.2|5000", symbol: "BTCUSDT", marketKind: "PERPETUAL", kind: "probable", confidence: "strong", origin: "runtime", side: "ask", price: 80924.2,
    display: 1.545, tranches: 2, refills: 1, hits: 50, executed: 12.475, ratio: 8.07, durationMs: 6200, startedAt: 5000, markedAt: 10_000, updatedAt: 11_200, status: "ended", ...overrides,
  };
}

describe("indicators/iceberg/iceberg-history", () => {
  describe("the wire shape", () => {
    test("a native update maps to the wire iceberg with markedAt = the first refill", () => {
      expect(wireIcebergOf(native())).toEqual({
        id: "/NQZ26:XCME|5137554220647449213|1000", kind: "native", confidence: "certain", origin: "runtime", side: "bid", price: 31188, display: 10, tranches: 4, executed: 32,
        startedAt: 1000, markedAt: 1500, updatedAt: 9000, status: "filled",
      });
      expect(Object.isFrozen(wireIcebergOf(native()))).toBe(true);
    });

    test("a probable update maps with its own markedAt and drops the hover-only fields", () => {
      const wire = wireIcebergOf(probable());
      expect(wire).toEqual({
        id: "BTCUSDT|PERPETUAL|ask|80924.2|5000", kind: "probable", confidence: "strong", origin: "runtime", side: "ask", price: 80924.2, display: 1.545, tranches: 2, executed: 12.475,
        startedAt: 5000, markedAt: 10_000, updatedAt: 11_200, status: "ended",
      });
      expect(validWireIceberg(wire)).toBe(true);
    });

    test("validWireIceberg refuses anything outside the closed vocabularies or the wire ranges", () => {
      const ok = wireIcebergOf(native());
      expect(validWireIceberg(ok)).toBe(true);
      expect(validWireIceberg({ ...ok, kind: "synthetic" })).toBe(false);
      expect(validWireIceberg({ ...ok, confidence: "sure" })).toBe(false);
      expect(validWireIceberg({ ...ok, side: "buy" })).toBe(false);
      expect(validWireIceberg({ ...ok, status: "open" })).toBe(false);
      expect(validWireIceberg({ ...ok, price: 0 })).toBe(false);
      expect(validWireIceberg({ ...ok, display: -1 })).toBe(false);
      expect(validWireIceberg({ ...ok, tranches: 0 })).toBe(false);
      expect(validWireIceberg({ ...ok, executed: Number.NaN })).toBe(false);
      expect(validWireIceberg({ ...ok, markedAt: 999 })).toBe(false);
      expect(validWireIceberg({ ...ok, updatedAt: 1499 })).toBe(false);
      expect(validWireIceberg({ ...ok, id: "" })).toBe(false);
      expect(validWireIceberg({ ...ok, id: "x".repeat(97) })).toBe(false);
      expect(validWireIceberg({ ...ok, extra: 1 })).toBe(false);
      expect(validWireIceberg(null)).toBe(false);
    });

    test("the wire check is the frame builder's own: at the id length, every closed vocabulary, the price magnitude and each pair's size ceiling, the history keeps exactly what icebergOrdersFrame accepts", () => {
      const ok = wireIcebergOf(native());
      const identities = [{ provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" }, { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" }, { provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }];
      const shared = [
        { ...ok, id: "x".repeat(MAX_ICEBERG_ID_LENGTH) }, { ...ok, id: "x".repeat(MAX_ICEBERG_ID_LENGTH + 1) },
        ...ICEBERG_KINDS.map((kind) => ({ ...ok, kind })), { ...ok, kind: "synthetic" },
        ...ICEBERG_CONFIDENCES.map((confidence) => ({ ...ok, confidence })), { ...ok, confidence: "sure" },
        ...ICEBERG_SIDES.map((side) => ({ ...ok, side })), { ...ok, side: "buy" },
        ...ICEBERG_STATUSES.map((status) => ({ ...ok, status })), { ...ok, status: "open" },
        ...ICEBERG_ORIGINS.map((origin) => ({ ...ok, origin })), { ...ok, origin: "laptop" },
        { ...ok, price: MAX_WIRE_MAGNITUDE }, { ...ok, price: MAX_WIRE_MAGNITUDE + 1 },
      ];
      for (const identity of identities) {
        const ceiling = sizeCeilingFor(identity);
        const sized = [{ ...ok, display: ceiling, executed: ceiling }, { ...ok, executed: ceiling * 2 }, { ...ok, display: ceiling * 2 }];
        expect(sized.map((entry) => validWireIceberg(entry, ceiling))).toEqual([true, false, false]);
        for (const entry of [...shared, ...sized]) {
          const frame = () => icebergOrdersFrame(identity, { ts: 10_000, seq: 0, reset: true, liveSince: 0, icebergs: [entry] });
          if (validWireIceberg(entry, ceiling)) expect(frame).not.toThrow();
          else expect(frame).toThrow();
        }
      }
      expect(shared.filter((entry) => validWireIceberg(entry))).toHaveLength(shared.length - 7);
      expect(Object.keys(icebergOrdersFrame(identities[0], { ts: 10_000, seq: 0, reset: true, liveSince: 0, icebergs: [ok] }).icebergs[0])).toEqual([...WIRE_FIELDS]);
    });
  });

  describe("recording", () => {
    test("only settled icebergs are kept; an active update is refused and reported", () => {
      const history = createIcebergHistory({ maxAgeMs: DAY });
      expect(history.record(wireIcebergOf(native({ status: "active" })))).toEqual({ added: 0, updated: 0, ignored: 1 });
      expect(history.record(wireIcebergOf(native()))).toEqual({ added: 1, updated: 0, ignored: 0 });
      expect(history.size).toBe(1);
      expect(history.dirty).toBe(true);
    });

    test("a later update of the same id replaces it; an identical one changes nothing", () => {
      const history = createIcebergHistory({ maxAgeMs: DAY });
      history.record(wireIcebergOf(native()));
      history.markSaved();
      expect(history.record(wireIcebergOf(native()))).toEqual({ added: 0, updated: 0, ignored: 0 });
      expect(history.dirty).toBe(false);
      expect(history.record(wireIcebergOf(native({ executed: 40, updatedAt: 9500 })))).toEqual({ added: 0, updated: 1, ignored: 0 });
      expect(history.list()[0].executed).toBe(40);
      expect(history.dirty).toBe(true);
    });

    test("an older update never overwrites a newer record", () => {
      const history = createIcebergHistory({ maxAgeMs: DAY });
      history.record(wireIcebergOf(native({ executed: 40, updatedAt: 9500 })));
      expect(history.record(wireIcebergOf(native({ executed: 32, updatedAt: 9000 })))).toEqual({ added: 0, updated: 0, ignored: 1 });
      expect(history.list()[0].executed).toBe(40);
    });

    test("list is oldest mark first, frozen, and independent of insertion order", () => {
      const history = createIcebergHistory({ maxAgeMs: DAY });
      history.record(wireIcebergOf(probable()));
      history.record(wireIcebergOf(native()));
      const list = history.list();
      expect(list.map((entry) => entry.markedAt)).toEqual([1500, 10_000]);
      expect(Object.isFrozen(list)).toBe(true);
    });

    test("record refuses a malformed wire iceberg loudly", () => {
      const history = createIcebergHistory({ maxAgeMs: DAY });
      expect(() => history.record({ ...wireIcebergOf(native()), side: "buy" })).toThrow(/wire iceberg/);
    });
  });

  describe("bounds", () => {
    test("prune drops what ended before the age window", () => {
      const history = createIcebergHistory({ maxAgeMs: DAY });
      history.record(wireIcebergOf(native({ id: "old", updatedAt: 9000 })));
      history.record(wireIcebergOf(native({ id: "new", startedAt: DAY, firstRefillAt: DAY + 1, updatedAt: DAY + 2 })));
      expect(history.prune(DAY + 9001)).toBe(1);
      expect(history.list().map((entry) => entry.id)).toEqual(["new"]);
    });

    test("the count cap drops the oldest settled first", () => {
      const history = createIcebergHistory({ maxAgeMs: DAY, maxIcebergs: 2 });
      for (const [id, at] of [["a", 3000], ["b", 2000], ["c", 4000]]) history.record(wireIcebergOf(native({ id, updatedAt: at })));
      expect(history.size).toBe(2);
      expect(history.list().map((entry) => entry.id).sort()).toEqual(["a", "c"]);
    });

    test("trimToBytes drops the oldest until the serialized history fits nine tenths of the budget", () => {
      const history = createIcebergHistory({ maxAgeMs: DAY });
      for (let i = 0; i < 50; i += 1) history.record(wireIcebergOf(native({ id: `i${i}`, updatedAt: 2000 + i })));
      const before = JSON.stringify(history.toJSON()).length;
      const dropped = history.trimToBytes(Math.floor(before / 2));
      expect(dropped).toBeGreaterThan(0);
      expect(JSON.stringify(history.toJSON()).length).toBeLessThanOrEqual(Math.floor(before / 2) * 0.9);
      expect(history.list()[0].id).not.toBe("i0");
    });

    test("options must be positive safe integers", () => {
      expect(() => createIcebergHistory({})).toThrow(/maxAgeMs/);
      expect(() => createIcebergHistory({ maxAgeMs: DAY, maxIcebergs: 0 })).toThrow(/maxIcebergs/);
      expect(() => createIcebergHistory({ maxAgeMs: DAY, maxBytes: 0 })).toThrow(/maxBytes/);
    });

    test("every entry is held to its pair's wire size ceiling: record refuses a size over it, load rejects a history holding one, an entry at it is kept, and the ceiling must be a positive number", () => {
      const history = createIcebergHistory({ maxAgeMs: DAY, sizeCeiling: 10_000_000 });
      const at = wireIcebergOf(native({ id: "at", display: 10_000_000, executed: 10_000_000 }));
      const over = wireIcebergOf(native({ id: "over", executed: 10_000_001 }));
      expect(history.record(at)).toEqual({ added: 1, updated: 0, ignored: 0 });
      expect(() => history.record(over)).toThrow(/wire iceberg/);
      expect(() => history.record({ ...over, executed: 1, display: 20_000_000 })).toThrow(/wire iceberg/);
      const restored = createIcebergHistory({ maxAgeMs: DAY, sizeCeiling: 10_000_000 });
      expect(restored.load({ version: ICEBERG_HISTORY_VERSION, icebergs: [at] })).toBe(true);
      expect(restored.load({ version: ICEBERG_HISTORY_VERSION, icebergs: [at, over] })).toBe(false);
      expect(restored.list().map((entry) => entry.id)).toEqual(["at"]);
      expect(history.sizeCeiling).toBe(10_000_000);
      expect(createIcebergHistory({ maxAgeMs: DAY }).sizeCeiling).toBe(1_000_000_000_000);
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1e7"]) expect(() => createIcebergHistory({ maxAgeMs: DAY, sizeCeiling: bad })).toThrow(/sizeCeiling/);
    });
  });

  describe("persistence", () => {
    test("toJSON and load round-trip, and load refuses a foreign or malformed shape", () => {
      const history = createIcebergHistory({ maxAgeMs: DAY });
      history.record(wireIcebergOf(native()));
      history.record(wireIcebergOf(probable()));
      const saved = JSON.parse(JSON.stringify(history.toJSON()));
      expect(saved.version).toBe(ICEBERG_HISTORY_VERSION);
      const restored = createIcebergHistory({ maxAgeMs: DAY });
      expect(restored.load(saved)).toBe(true);
      expect(restored.list()).toEqual(history.list());
      expect(restored.dirty).toBe(false);
      expect(restored.load({ ...saved, version: 99 })).toBe(false);
      expect(restored.load({ ...saved, icebergs: [{ ...saved.icebergs[0], kind: "synthetic" }] })).toBe(false);
      expect(restored.load({ ...saved, icebergs: [saved.icebergs[0], saved.icebergs[0]] })).toBe(false);
      expect(restored.list()).toHaveLength(2);
    });

    test("load drops a saved probable iceberg that took less than the floor times what it showed, counts it and leaves the history dirty; natives are exchange-proven and stay", () => {
      const history = createIcebergHistory({ maxAgeMs: DAY, minProbableRatio: 2 });
      const thin = wireIcebergOf(probable({ id: "thin", executed: 2.5 }));
      const edge = wireIcebergOf(probable({ id: "edge", executed: 3.09, markedAt: 10_001 }));
      const fat = wireIcebergOf(probable({ id: "fat", markedAt: 10_002 }));
      const nativeThin = wireIcebergOf(native({ executed: 12 }));
      expect(history.load({ version: ICEBERG_HISTORY_VERSION, icebergs: [thin, edge, fat, nativeThin] })).toBe(true);
      expect(history.list().map((entry) => entry.id)).toEqual([nativeThin.id, "edge", "fat"]);
      expect(history.stats()).toMatchObject({ belowFloor: 1, icebergs: 3 });
      expect(history.dirty).toBe(true);
      const lenient = createIcebergHistory({ maxAgeMs: DAY });
      expect(lenient.load({ version: ICEBERG_HISTORY_VERSION, icebergs: [thin] })).toBe(true);
      expect(lenient.list()).toHaveLength(1);
      expect(lenient.dirty).toBe(false);
      expect(() => createIcebergHistory({ maxAgeMs: DAY, minProbableRatio: 0.5 })).toThrow(/minProbableRatio/);
    });

    test("the ratio floor never drops a weak mark on load: a mark whose shown size outgrew what traded comes back weak at the default floor and at a raised one", () => {
      const weak = wireIcebergOf(probable({ id: "weak", confidence: "weak", display: 5, executed: 2.7 }));
      for (const minProbableRatio of [1, 2]) {
        const history = createIcebergHistory({ maxAgeMs: DAY, minProbableRatio });
        expect(history.load({ version: ICEBERG_HISTORY_VERSION, icebergs: [weak] })).toBe(true);
        expect(history.list()).toEqual([weak]);
        expect(history.stats()).toMatchObject({ belowFloor: 0, icebergs: 1 });
        expect(history.dirty).toBe(false);
      }
    });

    test("every change moves the revision and nothing else does, so a save can tell whether what it wrote is still all there is", () => {
      const history = createIcebergHistory({ maxAgeMs: DAY });
      const fresh = history.revision;
      history.record(wireIcebergOf(native()));
      const recorded = history.revision;
      expect(recorded).toBeGreaterThan(fresh);
      history.markSaved();
      history.record(wireIcebergOf(native()));
      expect(history.revision).toBe(recorded);
      history.watch(1000, 2000);
      const watched = history.revision;
      expect(watched).toBeGreaterThan(recorded);
      history.watch(1200, 1300);
      expect(history.revision).toBe(watched);
    });

    test("watched spans merge when they touch or overlap, come back sorted and frozen, mark the history dirty only when they change, and uncovered lists the gaps inside a window", () => {
      const history = createIcebergHistory({ maxAgeMs: DAY });
      history.watch(1000, 2000);
      history.watch(3000, 4000);
      history.watch(2000, 2500);
      history.watch(3500, 3600);
      expect(history.coverage()).toEqual([[1000, 2500], [3000, 4000]]);
      expect(Object.isFrozen(history.coverage()) && Object.isFrozen(history.coverage()[0])).toBe(true);
      expect(history.dirty).toBe(true);
      history.markSaved();
      history.watch(1200, 1300);
      expect(history.dirty).toBe(false);
      expect(history.uncovered(0, 5000)).toEqual([[0, 1000], [2500, 3000], [4000, 5000]]);
      expect(history.uncovered(1100, 2400)).toEqual([]);
      expect(history.uncovered(2600, 2900)).toEqual([[2600, 2900]]);
      expect(() => history.watch(2000, 1000)).toThrow(/watch/);
      expect(() => history.uncovered(2, 1)).toThrow(/uncovered/);
      expect(history.coverageUntil(3500)).toEqual([[1000, 2500], [3000, 3500]]);
      expect(history.coverageUntil(2500)).toEqual([[1000, 2500]]);
      expect(history.coverageUntil(500)).toEqual([]);
      expect(DEFAULT_MAX_SPANS).toBe(64);
      const bounded = createIcebergHistory({ maxAgeMs: DAY, maxSpans: 3 });
      for (let i = 0; i < 5; i += 1) bounded.watch(i * 100, i * 100 + 50);
      expect(bounded.coverage()).toEqual([[200, 250], [300, 350], [400, 450]]);
    });

    test("loadCoverage replaces the spans, merged, and refuses a malformed list without touching what is held", () => {
      const history = createIcebergHistory({ maxAgeMs: DAY });
      history.watch(1, 2);
      history.markSaved();
      expect(history.loadCoverage([[5000, 6000], [1000, 2000], [2000, 3000]])).toBe(true);
      expect(history.coverage()).toEqual([[1000, 3000], [5000, 6000]]);
      expect(history.dirty).toBe(false);
      for (const bad of [null, [[1, 1]], [[2, 1]], [[1, "2"]], [[1]], [1, 2]]) expect(history.loadCoverage(bad)).toBe(false);
      expect(history.coverage()).toEqual([[1000, 3000], [5000, 6000]]);
    });

    test("every iceberg says which machine saw it: a tracker update maps to the runtime's own, the wire refuses a missing or unknown origin, a history saved before origins existed loads as the runtime's own, and findNear finds a record of the same kind, side and price within the tolerance", () => {
      expect([...ORIGINS]).toEqual(["runtime", "host"]);
      expect(wireIcebergOf(native()).origin).toBe("runtime");
      expect(wireIcebergOf(probable()).origin).toBe("runtime");
      const bare = { ...wireIcebergOf(native()) };
      delete bare.origin;
      expect(validWireIceberg(bare)).toBe(false);
      expect(validWireIceberg({ ...bare, origin: "laptop" })).toBe(false);
      expect(validWireIceberg({ ...bare, origin: "host" })).toBe(true);
      const history = createIcebergHistory({ maxAgeMs: DAY });
      expect(history.load({ version: ICEBERG_HISTORY_VERSION, icebergs: [bare] })).toBe(true);
      expect(history.list()[0].origin).toBe("runtime");
      expect(history.findNear({ kind: "native", side: "bid", price: 31188, markedAt: 1500 + 5000 }, 5000)).toBe(history.list()[0]);
      expect(history.findNear({ kind: "native", side: "bid", price: 31188, markedAt: 1500 + 5001 }, 5000)).toBeNull();
      expect(history.findNear({ kind: "native", side: "ask", price: 31188, markedAt: 1500 }, 5000)).toBeNull();
      expect(history.findNear({ kind: "probable", side: "bid", price: 31188, markedAt: 1500 }, 5000)).toBeNull();
      expect(history.findNear({ kind: "native", side: "bid", price: 31188.25, markedAt: 1500 }, 5000)).toBeNull();
      expect(() => history.findNear(null, 5000)).toThrow(/findNear/);
      expect(() => history.findNear({ kind: "native" }, -1)).toThrow(/findNear/);
    });

    test("the spans never claim time the history no longer holds: prune clips them at the age cutoff, and dropping entries for room clips them past the newest mark dropped", () => {
      const history = createIcebergHistory({ maxAgeMs: DAY, maxIcebergs: 2 });
      history.watch(0, 3 * DAY);
      history.prune(3 * DAY);
      expect(history.coverage()).toEqual([[2 * DAY, 3 * DAY]]);
      history.record(wireIcebergOf(native({ id: "a", firstRefillAt: 2 * DAY + 1000, updatedAt: 2 * DAY + 2000 })));
      history.record(wireIcebergOf(native({ id: "b", firstRefillAt: 2 * DAY + 3000, updatedAt: 2 * DAY + 4000 })));
      history.record(wireIcebergOf(native({ id: "c", firstRefillAt: 2 * DAY + 5000, updatedAt: 2 * DAY + 6000 })));
      expect(history.list().map((entry) => entry.id)).toEqual(["b", "c"]);
      expect(history.coverage()).toEqual([[2 * DAY + 1001, 3 * DAY]]);
    });

    test("a span watched after the history dropped icebergs for room starts past the newest mark dropped, whoever watches it: a live run that began before it grows without claiming it, and a span wholly before it changes nothing", () => {
      const history = createIcebergHistory({ maxAgeMs: DAY, maxIcebergs: 2 });
      history.watch(1000, 10_000);
      for (const [id, mark] of [["a", 2000], ["b", 4000], ["c", 6000]]) history.record(wireIcebergOf(native({ id, startedAt: mark - 500, firstRefillAt: mark, updatedAt: mark + 500 })));
      expect(history.list().map((entry) => entry.id)).toEqual(["b", "c"]);
      expect(history.coverage()).toEqual([[2001, 10_000]]);
      history.watch(1000, 11_000);
      expect(history.coverage()).toEqual([[2001, 11_000]]);
      const revision = history.revision;
      history.watch(500, 2001);
      expect(history.coverage()).toEqual([[2001, 11_000]]);
      expect(history.revision).toBe(revision);
    });

    test("the time the history dropped never comes back: a long-lived iceberg dropped after one marked later leaves the floor past the later mark", () => {
      const history = createIcebergHistory({ maxAgeMs: DAY, maxIcebergs: 1 });
      history.record(wireIcebergOf(native({ id: "short", startedAt: 4500, firstRefillAt: 5000, updatedAt: 5500 })));
      history.record(wireIcebergOf(native({ id: "long", startedAt: 2500, firstRefillAt: 3000, updatedAt: 9000 })));
      history.record(wireIcebergOf(native({ id: "late", startedAt: 9500, firstRefillAt: 9600, updatedAt: 9700 })));
      expect(history.list().map((entry) => entry.id)).toEqual(["late"]);
      history.watch(0, 10_000);
      expect(history.coverage()).toEqual([[5001, 10_000]]);
    });

    test("heldFrom is the first mark the history can still hold: past the newest mark it dropped for room, and while at its cap past its oldest iceberg's end, since one that ended earlier would be dropped at once; a history loaded at its cap answers the same as the one it was saved from", () => {
      const history = createIcebergHistory({ maxAgeMs: DAY, maxIcebergs: 2 });
      expect(history.heldFrom()).toBe(0);
      history.record(wireIcebergOf(native({ id: "a", startedAt: 1500, firstRefillAt: 2000, updatedAt: 2500 })));
      expect(history.heldFrom()).toBe(0);
      history.record(wireIcebergOf(native({ id: "long", startedAt: 3500, firstRefillAt: 4000, updatedAt: 9000 })));
      expect(history.heldFrom()).toBe(2501);
      history.record(wireIcebergOf(native({ id: "c", startedAt: 4500, firstRefillAt: 5000, updatedAt: 5500 })));
      expect(history.list().map((entry) => entry.id)).toEqual(["long", "c"]);
      expect(history.heldFrom()).toBe(5501);
      const restored = createIcebergHistory({ maxAgeMs: DAY, maxIcebergs: 2 });
      expect(restored.load(JSON.parse(JSON.stringify(history.toJSON())))).toBe(true);
      expect(restored.heldFrom()).toBe(5501);
      const roomy = createIcebergHistory({ maxAgeMs: DAY });
      for (let i = 0; i < 50; i += 1) roomy.record(wireIcebergOf(native({ id: `i${i}`, firstRefillAt: 2000 + i, updatedAt: 3000 + i })));
      expect(roomy.trimToBytes(Math.floor(JSON.stringify(roomy.toJSON()).length / 2))).toBeGreaterThan(0);
      expect(roomy.heldFrom()).toBe(roomy.list()[0].markedAt);
    });

    test("clear empties it and marks it dirty only when something was there", () => {
      const history = createIcebergHistory({ maxAgeMs: DAY });
      history.clear();
      expect(history.dirty).toBe(false);
      history.record(wireIcebergOf(native()));
      history.markSaved();
      history.clear();
      expect(history.size).toBe(0);
      expect(history.dirty).toBe(true);
    });
  });
});
