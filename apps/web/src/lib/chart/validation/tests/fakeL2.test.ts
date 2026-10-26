import { afterEach, describe, expect, it } from "vitest";
import { l2FeedStatusIndicator, statusRows } from "../../../indicators/l2-feed-status/l2FeedStatus";
import { EventRing } from "../../../l2/eventRing";
import type { L2EventsFrame } from "../../../../types/frames";
import { resetDrawOwnerScopeForTests } from "../../draw/creationScope";
import { handlesForOwners, resetDrawRegistryForTests } from "../../draw/registry";
import type { TableData } from "../../draw/table";
import { ABSORB_WINDOW_MS, absorbingAt, fakeL2, fakeL2Unsynced, ladderOf, ladderWithWall, segmentOf, tradeEvent, wallLifecycle, wallOf } from "../fakeL2";
import { trendBars } from "../fixtures";
import { openLiveSession } from "../liveDrive";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

const T0 = 1_780_000_000_000;

function scriptedBook() {
  const base = ladderOf(60_000, 10, 1, 2, T0 + 90_000);
  const born = wallLifecycle({ id: 1, side: "bid", row: 59_995, size: 300, startTs: T0 + 10_000, shrinkTs: T0 + 40_000, tradeTs: T0 + 50_000, endTs: T0 + 70_000, endedBy: "filled" });
  const living = wallOf({ id: 2, side: "ask", row: 60_004, size: 250, startTs: T0 + 20_000 });
  return fakeL2({
    lastTs: T0 + 90_000,
    ladder: ladderWithWall(base, "bid", 59_995, 300),
    walls: [born.wall, living],
    events: [...born.events, tradeEvent(T0 + 30_000, "buy", 60_001, 1.5), { kind: "wall_born", ts: living.startTs, wall: 2, side: "ask", row: 60_004, span: 1, size: 250 }],
  });
}

describe("fakeL2", () => {
  it("serves the scripted ladder, walls and events as a live, trusted, synced book", () => {
    const l2 = scriptedBook();
    expect(l2.availability).toBe("LIVE");
    expect(l2.trusted()).toBe(true);
    expect(l2.status("l2_ladder").synced).toBe(true);
    expect(l2.ladder()?.bids[4]).toEqual([59_995, 300]);
    expect(l2.ladder()?.asks[0]).toEqual([60_001, 2]);
    expect(l2.walls().map((wall) => wall.id)).toEqual([1, 2]);
    expect(l2.wall(1)).toMatchObject({ endedBy: "filled", size: 150, eaten: 150, peak: 300 });
    expect(l2.events().events.map((event) => event.kind)).toEqual(["wall_born", "wall_born", "trade", "wall_shrink", "wall_trade", "wall_end"]);
    expect(l2.events(l2.events().seq)).toMatchObject({ events: [], complete: true });
  });

  it("atTime cuts walls and events at a bar close, so a replay-time read cannot see the future", () => {
    const l2 = scriptedBook();
    const asOf = l2.atTime!(T0 + 45_000);
    expect(asOf.events().events.map((event) => event.kind)).toEqual(["wall_born", "wall_born", "trade", "wall_shrink"]);
    // Wall 1 ended at +70 s and was traded at +50 s; as of +45 s it is alive and untouched.
    expect(asOf.wall(1)).toMatchObject({ endTs: null, endedBy: null, size: 300, peak: 300, eaten: 0, fill: 0, absorbing: false });
    expect(asOf.atTime!(T0 + 5_000).walls()).toEqual([]);
    expect(l2.wall(1)?.endTs).toBe(T0 + 70_000);
  });

  it("patch changes the script and advances the version", () => {
    const l2 = fakeL2({});
    expect(l2.version).toBe(1);
    l2.patch({ trusted: false, synced: { l2_walls: false } });
    expect(l2.version).toBe(2);
    expect(l2.trusted()).toBe(false);
    expect(l2.status("l2_walls").synced).toBe(false);
    expect(l2.status("l2_ladder").synced).toBe(true);
  });

  it("the unsynced fake reports every channel untrusted and no segment", () => {
    const l2 = fakeL2Unsynced();
    expect(l2.trusted()).toBe(false);
    expect(l2.segment()).toBeNull();
    for (const channel of ["l2_view", "l2_walls", "l2_events", "l2_ladder"] as const) expect(l2.status(channel).synced).toBe(false);
  });
});

describe("ladder cutoff (Codex finding 2)", () => {
  const first = ladderOf(100, 3, 1, 1, T0);
  const second = ladderOf(110, 3, 1, 1, T0 + 60_000);

  it("a ladder sequence serves the newest ladder at or before the cut", () => {
    const l2 = fakeL2({ ladders: [first, second] });
    expect(l2.atTime!(T0 + 30_000).ladder()).toBe(first);
    expect(l2.atTime!(T0 + 60_000).ladder()).toBe(second);
    expect(l2.ladder()).toBe(second);
  });

  it("a cut before the first ladder serves null, never a later ladder", () => {
    const l2 = fakeL2({ ladders: [first, second] });
    expect(l2.atTime!(T0 - 1).ladder()).toBeNull();
  });

  it("the current ladder is a candidate under the same cutoff as the sequence", () => {
    const current = ladderOf(120, 3, 1, 1, 200);
    const l2 = fakeL2({ ladder: current, ladders: [ladderOf(90, 3, 1, 1, 50)] });
    expect(l2.atTime!(100).ladder()?.ts).toBe(50);
    expect(l2.atTime!(49).ladder()).toBeNull();
    expect(l2.atTime!(200).ladder()).toBe(current);
    expect(l2.ladder()).toBe(current);
  });
});

describe("wall state under a cut (Codex finding 3)", () => {
  it("snapshots give the wall as it stood, so peak and consumption from after the cut stay hidden", () => {
    const life = wallLifecycle({ id: 7, side: "ask", row: 101, size: 400, startTs: T0, tradeTs: T0 + 20_000, tradedSize: 250, endTs: T0 + 40_000, endedBy: "partial" });
    expect(life.wall).toMatchObject({ size: 150, peak: 400, eaten: 250, fill: 0.625, endedBy: "partial" });
    const l2 = fakeL2({ walls: [life.wall], events: life.events, wallSnapshots: life.snapshots });
    expect(l2.atTime!(T0 + 10_000).wall(7)).toMatchObject({ size: 400, peak: 400, eaten: 0, fill: 0, absorbing: false, endTs: null, endedBy: null });
    expect(l2.atTime!(T0 + 20_000).wall(7)).toMatchObject({ size: 150, eaten: 250, endTs: null, endedBy: null });
    expect(l2.atTime!(T0 + 40_000).wall(7)).toMatchObject({ size: 150, eaten: 250, endTs: T0 + 40_000, endedBy: "partial" });
    expect(l2.wall(7)).toBe(life.wall);
  });

  it("without snapshots the wall is rebuilt from its events through the cut", () => {
    const final = wallOf({ id: 3, side: "bid", row: 99, size: 20, peak: 500, eaten: 480, fill: 0.96, absorbing: true, startTs: T0 });
    const events = [
      { kind: "wall_born" as const, ts: T0, wall: 3, side: "bid" as const, row: 99, span: 1, size: 500 },
      { kind: "wall_trade" as const, ts: T0 + 10_000, wall: 3, mode: "absorbed" as const, price: 99, size: 180 },
      { kind: "wall_trade" as const, ts: T0 + 30_000, wall: 3, mode: "absorbed" as const, price: 99, size: 300 },
    ];
    const l2 = fakeL2({ walls: [final], events });
    expect(l2.atTime!(T0 + 5_000).wall(3)).toMatchObject({ size: 500, peak: 500, eaten: 0, fill: 0, absorbing: false, detail: null });
    // Right after the first trade the wall holds 64 percent of its peak: absorbing by the runtime's rule, until the 5 s window lapses.
    expect(l2.atTime!(T0 + 10_000).wall(3)).toMatchObject({ size: 320, peak: 500, eaten: 180, fill: 0.36, absorbing: true });
    expect(l2.atTime!(T0 + 16_000).wall(3)).toMatchObject({ size: 320, absorbing: false });
    // After the second trade it holds 4 percent: traded into, but not holding, so not absorbing.
    expect(l2.atTime!(T0 + 30_000).wall(3)).toMatchObject({ size: 20, eaten: 480, absorbing: false });
  });

  it("a wall with neither snapshots nor a birth record is omitted under a cut, never served at its final size (Codex round-2 finding 1)", () => {
    const final = wallOf({ id: 3, side: "bid", row: 99, size: 20, peak: 500, eaten: 480, startTs: T0 });
    const bare = fakeL2({ walls: [final] });
    expect(bare.atTime!(T0 + 5_000).wall(3)).toBeNull();
    expect(bare.atTime!(T0 + 5_000).walls()).toEqual([]);
    expect(bare.wall(3)).toBe(final);
  });

  it("changing a wall's future final record cannot change an earlier cut's view", () => {
    const life = wallLifecycle({ id: 9, side: "bid", row: 50, size: 500, startTs: T0, tradeTs: T0 + 20_000, tradedSize: 100 });
    const cut = T0 + 10_000;
    const before = fakeL2({ walls: [life.wall], events: life.events, wallSnapshots: life.snapshots }).atTime!(cut).wall(9);
    const shrunk = { ...life.wall, size: 20, peak: 500, eaten: 480, fill: 0.96, absorbing: false, endTs: T0 + 60_000, endedBy: "filled" as const };
    const after = fakeL2({ walls: [shrunk], events: life.events, wallSnapshots: life.snapshots }).atTime!(cut).wall(9);
    expect(before).toEqual(after);
    expect(before).toMatchObject({ size: 500, peak: 500, eaten: 0 });
    // The same holds for an event-backed view.
    const eventsOnlyBefore = fakeL2({ walls: [life.wall], events: life.events }).atTime!(cut).wall(9);
    const eventsOnlyAfter = fakeL2({ walls: [shrunk], events: life.events }).atTime!(cut).wall(9);
    expect(eventsOnlyBefore).toEqual(eventsOnlyAfter);
  });

  it("snapshot-backed and event-backed views agree on absorbing after an absorbed trade (Codex round-2 finding 2)", () => {
    const life = wallLifecycle({ id: 11, side: "ask", row: 120, size: 400, startTs: T0, tradeTs: T0 + 20_000, tradedSize: 100 });
    const withSnapshots = fakeL2({ walls: [life.wall], events: life.events, wallSnapshots: life.snapshots });
    const eventsOnly = fakeL2({ walls: [life.wall], events: life.events });
    for (const cut of [T0, T0 + 19_999, T0 + 20_000, T0 + 24_000, T0 + 30_000]) {
      const a = withSnapshots.atTime!(cut).wall(11);
      const b = eventsOnly.atTime!(cut).wall(11);
      expect(b).not.toBeNull();
      expect({ size: a!.size, peak: a!.peak, eaten: a!.eaten, fill: a!.fill, absorbing: a!.absorbing }).toEqual({ size: b!.size, peak: b!.peak, eaten: b!.eaten, fill: b!.fill, absorbing: b!.absorbing });
    }
    expect(withSnapshots.atTime!(T0 + 20_000).wall(11)!.absorbing).toBe(true);
    expect(eventsOnly.atTime!(T0 + 20_000).wall(11)!.absorbing).toBe(true);
    expect(eventsOnly.atTime!(T0 + 30_000).wall(11)!.absorbing).toBe(false);
    // The uncut final record follows the same rule as of the last event: traded into and holding 75 percent of its peak.
    expect(life.wall.absorbing).toBe(true);
    expect(absorbingAt({ size: 300, peak: 400, endTs: null }, T0 + 20_000, T0 + 20_000 + ABSORB_WINDOW_MS)).toBe(true);
    expect(absorbingAt({ size: 300, peak: 400, endTs: null }, T0 + 20_000, T0 + 20_000 + ABSORB_WINDOW_MS + 1)).toBe(false);
    expect(absorbingAt({ size: 199, peak: 400, endTs: null }, T0, T0)).toBe(false);
    expect(absorbingAt({ size: 300, peak: 400, endTs: T0 }, T0, T0)).toBe(false);
  });
});

describe("trust (Codex finding 4)", () => {
  it("mirrors the production checks: LIVE segment, walls and events synced, ts not before the segment began", () => {
    const l2 = fakeL2({ segment: segmentOf(200) });
    expect(l2.trusted()).toBe(true);
    expect(l2.trusted(199)).toBe(false);
    expect(l2.trusted(200)).toBe(true);
    expect(l2.trusted(201)).toBe(true);
    l2.patch({ segment: segmentOf(200, "GAP") });
    expect(l2.trusted()).toBe(false);
  });

  it("an unsynced trust channel breaks trust; an unsynced ladder does not", () => {
    expect(fakeL2({ synced: { l2_walls: false } }).trusted()).toBe(false);
    expect(fakeL2({ synced: { l2_events: false } }).trusted(10)).toBe(false);
    expect(fakeL2({ synced: { l2_ladder: false, l2_view: false } }).trusted()).toBe(true);
  });

  it("an explicit null segment stays null and is untrusted; the default is a LIVE segment from 0", () => {
    const none = fakeL2({ segment: null });
    expect(none.segment()).toBeNull();
    expect(none.trusted()).toBe(false);
    const dflt = fakeL2({});
    expect(dflt.segment()).toEqual({ id: "fake:0:LIVE", state: "LIVE" });
    expect(dflt.trusted(0)).toBe(true);
  });

  it("trusted: false forces the store untrusted whatever else the script says", () => {
    expect(fakeL2({ trusted: false, segment: segmentOf(0) }).trusted(5)).toBe(false);
  });
});

describe("event slices (Codex finding 5)", () => {
  const events = [tradeEvent(T0, "buy", 100, 1), tradeEvent(T0 + 1_000, "sell", 99, 1), tradeEvent(T0 + 2_000, "buy", 101, 1)];

  it("a cursor inside the ring is exact and complete; no cursor is never complete", () => {
    const l2 = fakeL2({ events });
    expect(l2.events()).toMatchObject({ seq: 3, missed: 0, complete: false });
    expect(l2.events().events).toHaveLength(3);
    expect(l2.events(1)).toMatchObject({ seq: 3, complete: true });
    expect(l2.events(1).events).toEqual(events.slice(1));
    expect(l2.events(3)).toMatchObject({ events: [], complete: true });
  });

  it("a cursor beyond the current seq or before the reset is not exact: every held event, incomplete", () => {
    const l2 = fakeL2({ events, eventSeq: 10, eventResetSeq: 8 });
    expect(l2.events(11)).toMatchObject({ seq: 10, complete: false });
    expect(l2.events(11).events).toHaveLength(3);
    expect(l2.events(7)).toMatchObject({ complete: false });
    expect(l2.events(7).events).toHaveLength(3);
    expect(l2.events(8)).toMatchObject({ complete: true });
    expect(l2.events(8).events).toHaveLength(2);
  });

  it("missed events make a cursor at or before the loss incomplete", () => {
    const l2 = fakeL2({ events, eventSeq: 3, missedEvents: 2 });
    expect(l2.events(1)).toMatchObject({ missed: 2, complete: false });
    const pinned = fakeL2({ events, eventSeq: 3, missedEvents: 2, missedThroughSeq: 1 });
    expect(pinned.events(1).complete).toBe(false);
    expect(pinned.events(2).complete).toBe(true);
  });

  it("an unsynced events channel is never complete, and an empty never-synced ring is the empty slice", () => {
    expect(fakeL2({ events, synced: { l2_events: false } }).events(1)).toMatchObject({ complete: false });
    expect(fakeL2({ synced: { l2_events: false } }).events(0)).toEqual({ seq: 0, events: [], missed: 0, complete: false });
  });

  it("agrees with the real EventRing on cursor semantics", () => {
    const ring = new EventRing(100);
    const wire = (ts: number) => ({ event: "trade" as const, ts, side: "ask" as const, aggressor: "buy" as const, mode: "swept" as const, price: 100, size: 1, late: false });
    const frame = (seq: number, evs: ReturnType<typeof wire>[], reset = false, missed = 0): L2EventsFrame =>
      ({ type: "l2_events", seq, ts: evs[evs.length - 1]?.ts ?? 0, reset, missed, events: evs } as unknown as L2EventsFrame);
    ring.apply(frame(2, [wire(1), wire(2)], true));
    ring.apply(frame(3, [wire(3)]));
    const fake = fakeL2({ events: [tradeEvent(1, "buy", 100, 1), tradeEvent(2, "buy", 100, 1), tradeEvent(3, "buy", 100, 1)], eventSeq: 3, eventResetSeq: 2 });
    for (const cursor of [undefined, 0, 1, 2, 3, 4]) {
      const real = ring.since(cursor);
      const ours = fake.events(cursor);
      expect([cursor, ours.seq, ours.events.length, ours.complete]).toEqual([cursor, real.seq, real.events.length, real.complete]);
    }
  });

  it("under a cut the slice holds only events through the cut and the seq moves with it", () => {
    const l2 = fakeL2({ events });
    const asOf = l2.atTime!(T0 + 1_000);
    expect(asOf.events()).toMatchObject({ seq: 2, complete: false });
    expect(asOf.events(0).events).toHaveLength(2);
    expect(asOf.events(2)).toMatchObject({ events: [], complete: true });
  });
});

describe("against L2 Feed Status", () => {
  it("statusRows reads the scripted walls, events and book", () => {
    const rows = statusRows(scriptedBook(), T0 + 90_500);
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
    expect(byLabel["Walls/events trusted"]).toMatchObject({ value: "yes", tone: "good" });
    expect(byLabel.Segment).toMatchObject({ value: "LIVE fake:0:LIVE", tone: "good" });
    expect(byLabel["Walls held"].value).toBe("1 active, 1 ended");
    expect(byLabel["Events held"].value).toBe("6, 0 missed by the cap");
    expect(byLabel["Book held"].value).toBe("10x10 of 10, best 59999 / 60001");
    expect(byLabel.Ladder).toMatchObject({ value: "synced seq 1, 0.5 s ago", tone: "good" });
  });

  it("an unsynced walls channel turns the trust row bad, as the real store would", () => {
    const l2 = scriptedBook();
    l2.patch({ synced: { l2_walls: false } });
    const rows = statusRows(l2, T0 + 90_500);
    expect(rows[0]).toMatchObject({ label: "Walls/events trusted", value: "no", tone: "bad" });
    expect(rows.find((row) => row.label === "Walls")).toMatchObject({ tone: "bad" });
  });

  it("through the runtime, a live bar writes the table from the fake book", () => {
    const { bars } = trendBars({ count: 3 });
    const session = openLiveSession(l2FeedStatusIndicator, {}, { l2: scriptedBook() }, []);
    try {
      for (const bar of bars) session.dispatch({ bar });
      const owner = session.runtime.getDrawOwnerId(l2FeedStatusIndicator.id)!;
      const table = handlesForOwners([owner]).find((record) => record.kind === "table");
      expect(table).toBeDefined();
      const grid = (table!.data as TableData).committedGrid;
      const cells = Object.values(grid).map((cell) => cell.text);
      expect(cells).toContain("1 active, 1 ended");
      expect(cells).toContain("6, 0 missed by the cap");
      expect(session.capture().faulted).toBe(false);
    } finally {
      session.close();
    }
  });
});
