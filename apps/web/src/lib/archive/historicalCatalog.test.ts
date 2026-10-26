import { describe, expect, it } from "vitest";
import {
  HISTORICAL_INSTRUMENTS,
  initialArchiveQuery,
  type HistoricalQueryableInstrument,
} from "./historicalCatalog";

function byId(id: string) {
  const instrument = HISTORICAL_INSTRUMENTS.find((candidate) => candidate.id === id);
  if (instrument === undefined) throw new Error(`missing historical instrument ${id}`);
  return instrument;
}

function queryable(id: string): HistoricalQueryableInstrument {
  const instrument = byId(id);
  if (instrument.availability !== "ready" || instrument.kind !== "single") {
    throw new Error(`${id} is not queryable`);
  }
  return instrument;
}

function nanos(value: string): string {
  return (BigInt(Date.parse(value)) * 1_000_000n).toString();
}

describe("historical catalog", () => {
  it("contains exactly the closure-verified display universe rather than the live menu", () => {
    expect(HISTORICAL_INSTRUMENTS).toHaveLength(8);
    expect(HISTORICAL_INSTRUMENTS.map((instrument) => instrument.id).sort()).toEqual([
      "aapl", "btc-perpetual", "btc-spot", "es-continuous", "eth-perpetual", "eth-spot",
      "nq-continuous", "tsla",
    ]);
    expect(HISTORICAL_INSTRUMENTS.some((instrument) => instrument.symbol === "NVDA")).toBe(false);
  });

  it("uses the published provider identities for stable archive series", () => {
    for (const instrument of HISTORICAL_INSTRUMENTS) {
      if (instrument.kind !== "single") continue;
      const identity = JSON.parse(instrument.archiveInstrumentId) as string[];
      expect(identity[0]).toBe(instrument.source === "binance" ? "BINANCE" : "XNAS");
      expect(identity).toHaveLength(5);
    }
  });

  it("keeps archive chart identity separate from the similarly named live feed identity", () => {
    expect(queryable("btc-spot").chartIdentity).toEqual({ provider: "BINANCE", marketKind: "SPOT" });
    expect(queryable("aapl").chartIdentity).toEqual({ provider: "DATABENTO", assetClass: "EQUITY" });
  });

  it("defines one contiguous, immutable contract-roll manifest for each continuous future", () => {
    for (const id of ["es-continuous", "nq-continuous"]) {
      const instrument = byId(id);
      expect(instrument).toMatchObject({ availability: "ready", kind: "continuous" });
      if (instrument.kind !== "continuous") throw new Error("unreachable");
      expect(instrument.rolls).toHaveLength(5);
      expect(instrument.rolls.every((roll) => JSON.parse(roll.archiveInstrumentId)[0] === "XCME"))
        .toBe(true);
      expect(instrument.rolls[0].from).toBe(instrument.availableFrom);
      expect(instrument.rolls.at(-1)?.to).toBe(instrument.availableToExclusive);
      for (let index = 1; index < instrument.rolls.length; index += 1) {
        expect(instrument.rolls[index - 1].to).toBe(instrument.rolls[index].from);
      }
    }
  });

  it("requests a bounded latest intraday page and the complete published daily range", () => {
    const btc = queryable("btc-spot");
    const minute = initialArchiveQuery(btc, "1m");
    expect(minute).toMatchObject({ instrumentId: btc.archiveInstrumentId, family: "candle_1m", limit: 10_000 });
    expect(minute.to).toBe(nanos(btc.availableToExclusive));
    expect(minute.from).toBe((BigInt(minute.to) - 24n * 60n * 60n * 1_000_000_000n).toString());

    const aapl = queryable("aapl");
    const daily = initialArchiveQuery(aapl, "1d");
    expect(daily).toMatchObject({ instrumentId: aapl.archiveInstrumentId, family: "candle_1d", limit: 10_000 });
    expect(daily.from).toBe(nanos(aapl.availableFrom));
    expect(daily.to).toBe(nanos(aapl.availableToExclusive));
  });
});
