import { afterEach, describe, expect, it } from "vitest";
import { l2FeedStatusIndicator, statusRows } from "../../../indicators/l2-feed-status/l2FeedStatus";
import { resetDrawOwnerScopeForTests } from "../../draw/creationScope";
import { handlesForOwners, resetDrawRegistryForTests } from "../../draw/registry";
import type { TableData } from "../../draw/table";
import { fakeL2, fakeL2Unsynced, ladderOf, ladderWithWall, tradeEvent, wallLifecycle, wallOf } from "../fakeL2";
import { trendBars } from "../fixtures";
import { openLiveSession } from "../liveDrive";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

const T0 = 1_780_000_000_000;

function scriptedBook() {
  const base = ladderOf(60_000, 10, 1, 2);
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
    expect(l2.wall(1)?.endedBy).toBe("filled");
    expect(l2.events().events.map((event) => event.kind)).toEqual(["wall_born", "wall_born", "trade", "wall_shrink", "wall_trade", "wall_end"]);
    expect(l2.events(l2.events().seq).events).toEqual([]);
  });

  it("atTime cuts walls and events at a bar close, so a replay-time read cannot see the future", () => {
    const l2 = scriptedBook();
    const asOf = l2.atTime!(T0 + 45_000);
    expect(asOf.events().events.map((event) => event.kind)).toEqual(["wall_born", "wall_born", "trade", "wall_shrink"]);
    // Wall 1 ended at +70 s; as of +45 s it is still alive.
    expect(asOf.wall(1)).toMatchObject({ endTs: null, endedBy: null });
    expect(asOf.atTime!(T0 + 5_000).walls()).toEqual([]);
    expect(l2.wall(1)?.endTs).toBe(T0 + 70_000);
  });

  it("a ladder sequence serves the newest ladder at or before the cut", () => {
    const first = ladderOf(100, 3, 1, 1, T0);
    const second = ladderOf(110, 3, 1, 1, T0 + 60_000);
    const l2 = fakeL2({ ladders: [first, second] });
    expect(l2.atTime!(T0 + 30_000).ladder()).toBe(first);
    expect(l2.atTime!(T0 + 60_000).ladder()).toBe(second);
    expect(l2.ladder()).toBeNull();
  });

  it("patch changes the script and advances the version", () => {
    const l2 = fakeL2({ trusted: true });
    expect(l2.version).toBe(1);
    l2.patch({ trusted: false, synced: { l2_walls: false } });
    expect(l2.version).toBe(2);
    expect(l2.trusted()).toBe(false);
    expect(l2.status("l2_walls").synced).toBe(false);
    expect(l2.status("l2_ladder").synced).toBe(true);
  });

  it("the unsynced fake reports every channel untrusted", () => {
    const l2 = fakeL2Unsynced();
    expect(l2.trusted()).toBe(false);
    for (const channel of ["l2_view", "l2_walls", "l2_events", "l2_ladder"] as const) expect(l2.status(channel).synced).toBe(false);
  });
});

describe("against L2 Feed Status", () => {
  it("statusRows reads the scripted walls, events and book", () => {
    const rows = statusRows(scriptedBook(), T0 + 90_500);
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
    expect(byLabel["Walls/events trusted"]).toMatchObject({ value: "yes", tone: "good" });
    expect(byLabel["Walls held"].value).toBe("1 active, 1 ended");
    expect(byLabel["Events held"].value).toBe("6, 0 missed by the cap");
    expect(byLabel["Book held"].value).toBe("10x10 of 10, best 59999 / 60001");
    expect(byLabel.Ladder).toMatchObject({ value: "synced seq 1, 0.5 s ago", tone: "good" });
  });

  it("flipping trust turns the rows bad", () => {
    const l2 = scriptedBook();
    l2.patch({ trusted: false });
    const rows = statusRows(l2, T0 + 90_500);
    expect(rows[0]).toMatchObject({ label: "Walls/events trusted", value: "no", tone: "bad" });
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
