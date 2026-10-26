// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LiveRangeCard, TIP_GAP_PX, TIP_ROOM_PX } from "../LiveRangeCard";
import type { LiveRangeRead } from "../liveRangeReader";
import { DEFAULT_LIVE_RANGE_SETTINGS, type CardSize, type LiveRangeSettings } from "../liveRangeSettings";
import { NO_TRADES_TEXT, WAITING_TEXT } from "../liveRangeWords";
import type { LiveRangeReport } from "../liveRangePrimitive";
import type { PrintRead } from "../liveRangePrints";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const START = Date.UTC(2026, 9, 16, 2, 35, 20);
const BID = "rgb(17, 34, 51)";
const ASK = "rgb(68, 85, 102)";
const settings = { ...DEFAULT_LIVE_RANGE_SETTINGS, bidColor: "#112233", askColor: "#445566" };
const pane = { left: 10, top: 20, width: 800, height: 600 };

function read(overrides: Partial<LiveRangeRead> = {}): LiveRangeRead {
  return { buys: 1_204.4, sells: 0.3, fromTs: START, toTs: START + 30 * 60_000, coveredMs: 30 * 60_000, tradedMs: 30 * 60_000, missing: [], noise: 600, minutesWon: { buyers: 18, sellers: 34 }, impact: { buyers: { moved: 12.4, volume: 6_500 }, sellers: { moved: 48, volume: 6_400 } }, ...overrides };
}

const PRINTS: PrintRead = { buys: 34.2, sells: 12, buyCount: 5, sellCount: 2, threshold: 5, floor: 0.39, unit: "BTC" };

function report(patch: Partial<LiveRangeReport> = {}): LiveRangeReport {
  return { mode: "visible", fromTs: START, toTs: START + 30 * 60_000, live: false, read: read(), prints: null, loading: false, ...patch };
}

function measure(card: HTMLDivElement) {
  card.getBoundingClientRect = () => ({ left: 310, top: 40, width: 236, height: 120, right: 546, bottom: 160, x: 310, y: 40, toJSON: () => ({}) });
  Object.defineProperty(card, "offsetWidth", { configurable: true, value: 236 });
  Object.defineProperty(card, "offsetHeight", { configurable: true, value: 120 });
}

function pointer(target: Element, type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", clientX: number, clientY: number, init: PointerEventInit = {}) {
  act(() => { target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 7, clientX, clientY, ...init })); });
}

function headOf(card: HTMLDivElement): string | null {
  return card.querySelector(".candle-monitor-head > .candle-monitor-candle")?.textContent ?? null;
}

function sinceOf(card: HTMLDivElement): string | null {
  return card.querySelector(":scope > .live-range-since")?.textContent ?? null;
}

function noteOf(card: HTMLDivElement): string | null {
  const notes = card.querySelectorAll(".live-range-note");
  expect(notes.length).toBeLessThanOrEqual(1);
  if (notes.length === 0) return null;
  expect(notes[0]).toBe(card.lastElementChild);
  expect(notes[0].className).toBe("live-range-sub live-range-note");
  return notes[0].textContent;
}

function verdictOf(card: HTMLDivElement): { key: string | null; text: string; z: string | null; color: string; aboveTable: boolean } | null {
  const lines = card.querySelectorAll<HTMLDivElement>(".live-range-verdict");
  expect(lines.length).toBeLessThanOrEqual(1);
  if (lines.length === 0) return null;
  const line = lines[0];
  expect(line.previousElementSibling?.className).toBe("live-range-sub live-range-since");
  const spans = [...line.children] as HTMLElement[];
  expect(spans.map((span) => [span.tagName, span.className, span.style.color])).toEqual([["SPAN", "live-range-verdict-text", ""], ["SPAN", "live-range-verdict-z tabular", ""]].slice(0, Math.max(1, spans.length)));
  return { key: line.getAttribute("data-verdict"), text: spans[0].textContent ?? "", z: spans[1]?.textContent ?? null, color: line.style.color, aboveTable: line.nextElementSibling?.tagName === "TABLE" };
}

function errorsFrom(run: () => void): unknown[] {
  const errors: unknown[] = [];
  const caught = (event: ErrorEvent) => {
    errors.push(event.error);
    event.preventDefault();
  };
  window.addEventListener("error", caught);
  try {
    run();
  } finally {
    window.removeEventListener("error", caught);
  }
  return errors;
}

describe("the live range card", () => {
  let mounted: { container: HTMLDivElement; root: Root } | null = null;

  function unmount() {
    if (mounted === null) return;
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }

  afterEach(unmount);

  function mount(element: React.ReactElement): HTMLDivElement {
    unmount();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted = { container, root };
    act(() => root.render(element));
    return container.querySelector<HTMLDivElement>('[data-testid="live-range-card"]')!;
  }

  function rerender(element: React.ReactElement) {
    const root = mounted!.root;
    act(() => root.render(element));
  }

  it("is the movable title with on screen beside it in the visible range, the span on its own line under it, then a table of the traded volume, one delta across both columns in the colour of its side, the big prints by side with their count on a line under their size, the minutes won by side and the price impact by side with the points per thousand under it, no sub-lines, and no note while the range has its data", () => {
    const card = mount(<LiveRangeCard report={report({ prints: PRINTS })} settings={settings} />);
    expect(card.className).toBe("live-range-card");
    expect(card.dataset.placed).toBeUndefined();
    expect([...card.children].map((child) => [child.tagName, child.className])).toEqual([["DIV", "candle-monitor-head"], ["DIV", "live-range-sub live-range-since"], ["DIV", "live-range-verdict"], ["TABLE", "live-range-table"]]);
    const head = card.children[0];
    expect([...head.children].map((child) => [child.tagName, child.className, child.textContent])).toEqual([
      ["BUTTON", "live-range-grip candle-monitor-title", "Live Range Control"],
      ["SPAN", "candle-monitor-candle", "on screen"],
    ]);
    expect(card.children[1].textContent).toBe("02:35 → 03:05 UTC · 30 min");
    const grip = head.children[0] as HTMLButtonElement;
    expect(grip.type).toBe("button");
    expect(grip.getAttribute("aria-label")).toBe("Move the card; double-click to put it back");
    const table = card.children[3] as HTMLTableElement;
    expect([...table.querySelectorAll("colgroup > col")].map((col) => col.className)).toEqual(["", "live-range-col", "live-range-col"]);
    const header = table.querySelector<HTMLTableRowElement>("tr.live-range-head")!;
    expect(header.parentElement?.tagName).toBe("THEAD");
    expect([...header.cells].map((cell) => [cell.tagName, cell.textContent, cell.scope, cell.style.color])).toEqual([
      ["TH", "Metric", "col", ""],
      ["TH", "Buyers", "col", BID],
      ["TH", "Sellers", "col", ASK],
    ]);
    const rows = [...table.querySelectorAll<HTMLTableRowElement>("tr.live-range-row")];
    expect(rows.map((row) => [row.parentElement?.tagName, row.dataset.row, row.cells.length])).toEqual([["TBODY", "volume", 3], ["TBODY", "delta", 2], ["TBODY", "prints", 3], ["TBODY", "minutes", 3], ["TBODY", "impact", 3]]);
    expect(rows.map((row) => [row.cells[0].tagName, row.cells[0].scope, [...row.cells[0].children].map((span) => [span.tagName, span.className, span.textContent])])).toEqual([
      ["TH", "row", [["SPAN", "live-range-label", "Traded volume"]]],
      ["TH", "row", [["SPAN", "live-range-label", "Delta"]]],
      ["TH", "row", [["SPAN", "live-range-label", "Big prints"]]],
      ["TH", "row", [["SPAN", "live-range-label", "Minutes won"]]],
      ["TH", "row", [["SPAN", "live-range-label", "Price impact"]]],
    ]);
    expect(card.querySelectorAll(".live-range-table .live-range-sub")).toHaveLength(0);
    expect(rows.map((row) => [...row.cells].slice(1).map((cell) => [cell.tagName, cell.className, cell.textContent, cell.style.color, cell.colSpan]))).toEqual([
      [["TD", "live-range-value tabular", "1.2k", BID, 1], ["TD", "live-range-value tabular", "<1", ASK, 1]],
      [["TD", "live-range-value live-range-joined tabular", "+1.2k", BID, 2]],
      [["TD", "live-range-value tabular", "34(5)", BID, 1], ["TD", "live-range-value tabular", "12(2)", ASK, 1]],
      [["TD", "live-range-value tabular", "18 min", BID, 1], ["TD", "live-range-value tabular", "34 min", ASK, 1]],
      [["TD", "live-range-value live-range-hover tabular", "+12(1.9/k)", BID, 1], ["TD", "live-range-value live-range-hover tabular", "−48(7.5/k)", ASK, 1]],
    ]);
    expect(rows[1].cells[1].getAttribute("data-tone")).toBe("buyers");
    const nodes = (cell: HTMLTableCellElement) => [...cell.childNodes].map((node) => (node instanceof Element ? [node.tagName, node.className, node.textContent] : ["#text", node.textContent]));
    expect([...rows[2].cells].slice(1).map(nodes)).toEqual([
      [["#text", "34"], ["SPAN", "live-range-count", "(5)"]],
      [["#text", "12"], ["SPAN", "live-range-count", "(2)"]],
    ]);
    expect([...rows[4].cells].slice(1).map(nodes)).toEqual([
      [["#text", "+12"], ["SPAN", "live-range-count", "(1.9/k)"]],
      [["#text", "−48"], ["SPAN", "live-range-count", "(7.5/k)"]],
    ]);
    expect(rows.filter((row) => row.dataset.row !== "prints" && row.dataset.row !== "impact").flatMap((row) => [...row.querySelectorAll(".live-range-count")])).toEqual([]);
    const bare = mount(<LiveRangeCard report={report()} settings={settings} />);
    expect([...bare.querySelectorAll('[data-row="prints"] .live-range-value')].map((cell) => cell.textContent)).toEqual(["–", "–"]);
    expect(bare.querySelectorAll("[data-row=\"prints\"] .live-range-count")).toHaveLength(0);
    expect([...bare.querySelectorAll('[data-row="minutes"] .live-range-value')].map((cell) => cell.textContent)).toEqual(["18 min", "34 min"]);
    const quiet = mount(<LiveRangeCard report={report({ read: read({ impact: { buyers: { moved: 0, volume: 0 }, sellers: { moved: 48, volume: 6_400 } } }) })} settings={settings} />);
    expect([...quiet.querySelectorAll('[data-row="impact"] .live-range-value')].map((cell) => cell.textContent)).toEqual(["–", "−48(7.5/k)"]);
    expect(noteOf(card)).toBeNull();
  });

  it("takes its size from the monitor size of the settings, medium for a size it does not know", () => {
    expect(mount(<LiveRangeCard report={report()} settings={settings} />).dataset.size).toBe("medium");
    expect(mount(<LiveRangeCard report={report()} settings={{ ...settings, cardSize: "small" }} />).dataset.size).toBe("small");
    expect(mount(<LiveRangeCard report={report()} settings={{ ...settings, cardSize: "large" }} />).dataset.size).toBe("large");
    expect(mount(<LiveRangeCard report={report()} settings={{ ...settings, cardSize: "huge" as CardSize }} />).dataset.size).toBe("medium");
    expect(mount(<LiveRangeCard report={report({ read: null })} settings={{ ...settings, cardSize: "small" }} />).dataset.size).toBe("small");
  });

  it("placed, it fits itself to the pane again once its size changes, so a larger card by the edge stays inside, and goes back to its spot at the smaller size", () => {
    const position = { x: 540, y: 40 };
    const paneOf = () => ({ left: 0, top: 0, width: 800, height: 600 });
    const at = (cardSize: CardSize) => <LiveRangeCard report={report()} settings={{ ...settings, cardSize }} position={position} paneOf={paneOf} />;
    const card = mount(at("medium"));
    Object.defineProperty(card, "offsetWidth", { configurable: true, get: () => (card.dataset.size === "large" ? 295 : 236) });
    Object.defineProperty(card, "offsetHeight", { configurable: true, value: 120 });
    rerender(at("medium"));
    expect(card.style.left).toBe("540px");
    rerender(at("large"));
    expect(card.style.left).toBe(`${800 - 295 - 4}px`);
    rerender(at("medium"));
    expect(card.style.left).toBe("540px");
  });

  it("while the hours of the range are loading it shows a spinner above the table where the verdict goes and holds back the verdict and its z, and shows both once the hours are in", () => {
    const loading = mount(<LiveRangeCard report={report({ loading: true, read: read() })} settings={settings} />);
    expect(verdictOf(loading)).toBeNull();
    expect(loading.querySelectorAll(".live-range-note")).toHaveLength(0);
    const spinner = loading.querySelector<HTMLDivElement>(".live-range-loading")!;
    expect(spinner.previousElementSibling?.className).toBe("live-range-sub live-range-since");
    expect(spinner.nextElementSibling?.tagName).toBe("TABLE");
    expect([spinner.className, spinner.getAttribute("role"), spinner.getAttribute("aria-label")]).toEqual(["live-range-sub live-range-loading", "status", "Loading the hours of the range"]);
    expect([...spinner.children].map((child) => [child.tagName, child.className, child.textContent])).toEqual([["SPAN", "live-range-spinner", ""], ["SPAN", "", "loading"]]);
    const loaded = mount(<LiveRangeCard report={report({ loading: false, read: read() })} settings={settings} />);
    expect(loaded.querySelector(".live-range-loading")).toBeNull();
    expect(verdictOf(loaded)?.z).toBe("z +2.0");
    expect(noteOf(loaded)).toBeNull();
    expect(mount(<LiveRangeCard report={report({ loading: true, read: null })} settings={settings} />).querySelector(".live-range-loading")).not.toBeNull();
    const empty = mount(<LiveRangeCard report={report({ loading: true, read: read({ buys: 0, sells: 0, coveredMs: 0 }) })} settings={settings} />);
    expect([empty.querySelectorAll(".live-range-note").length, empty.querySelectorAll(".live-range-loading").length]).toEqual([0, 1]);
  });

  it("colours a delta of sellers in the ask colour, and a delta of nothing in neither", () => {
    const sellers = mount(<LiveRangeCard report={report({ read: read({ buys: 100, sells: 1_000, noise: 400 }) })} settings={settings} />);
    const cell = sellers.querySelector<HTMLTableCellElement>('[data-row="delta"] td')!;
    expect([cell.textContent, cell.getAttribute("data-tone"), cell.style.color, cell.colSpan]).toEqual(["−900", "sellers", ASK, 2]);
    const even = mount(<LiveRangeCard report={report({ read: read({ buys: 10, sells: 10, noise: 4 }) })} settings={settings} />);
    const flat = even.querySelector<HTMLTableCellElement>('[data-row="delta"] td')!;
    expect([flat.textContent, flat.getAttribute("data-tone"), flat.style.color]).toEqual(["0", "even", ""]);
  });

  it("heads the card with the zone it reads in the zone modes, says since the start while the zone runs live and both ends once it ends, and counts the volume in the zone", () => {
    const live = mount(<LiveRangeCard report={report({ mode: "live", live: true })} settings={settings} />);
    expect([headOf(live), sinceOf(live)]).toEqual(["live zone", "since 02:35 UTC · 30 min"]);
    const selected = mount(<LiveRangeCard report={report({ mode: "selected" })} settings={settings} />);
    expect([headOf(selected), sinceOf(selected)]).toEqual(["selected zone", "02:35 → 03:05 UTC · 30 min"]);
    const waiting = mount(<LiveRangeCard report={report({ mode: "live", live: true, read: null })} settings={settings} />);
    expect(waiting.querySelectorAll("tr.live-range-row")).toHaveLength(0);
    expect(noteOf(waiting)).toBe(WAITING_TEXT);
    expect(noteOf(mount(<LiveRangeCard report={report({ mode: "selected", read: read({ buys: 0, sells: 0, coveredMs: 0 }) })} settings={settings} />))).toBe(NO_TRADES_TEXT.zone);
  });

  it("keeps on screen beside the title, so the head fits the card, and says the span on the line under it, with the first day once the span crosses midnight, before the screen has trades too", () => {
    const waiting = mount(<LiveRangeCard report={report({ read: null })} settings={settings} />);
    expect([headOf(waiting), sinceOf(waiting)]).toEqual(["on screen", "02:35 → 03:05 UTC · 30 min"]);
    const later = mount(<LiveRangeCard report={report({ read: read({ toTs: START + 3_600_000 }), toTs: START + 3 * 3_600_000 })} settings={settings} />);
    expect([headOf(later), sinceOf(later)]).toEqual(["on screen", "02:35 → 05:35 UTC · 3 h"]);
    const nextDay = mount(<LiveRangeCard report={report({ toTs: Date.UTC(2026, 9, 17, 0, 5) })} settings={settings} />);
    expect([headOf(nextDay), sinceOf(nextDay)]).toEqual(["on screen", "16 Oct 02:35 → 00:05 UTC · 21.5 h"]);
  });

  it("notes what is missing on its last line: waiting with no rows before there are candles, or no trades on screen yet; nothing once there are trades and the range has its data", () => {
    const waiting = mount(<LiveRangeCard report={report({ read: null })} settings={settings} />);
    expect(waiting.querySelector("tr.live-range-head")).not.toBeNull();
    expect(waiting.querySelectorAll("tr.live-range-row")).toHaveLength(0);
    expect(noteOf(waiting)).toBe(WAITING_TEXT);
    expect(noteOf(mount(<LiveRangeCard report={report({ read: read({ buys: 0, sells: 0, coveredMs: 0 }) })} settings={settings} />))).toBe(NO_TRADES_TEXT.screen);
    const holed = mount(<LiveRangeCard report={report({ read: read() })} settings={settings} />);
    expect(holed.querySelectorAll("tr.live-range-row")).toHaveLength(5);
    expect(noteOf(holed)).toBeNull();
    expect(noteOf(mount(<LiveRangeCard report={report()} settings={settings} />))).toBeNull();
  });

  it("says above the table who moved the range from the z of the tape, bigger than the rows, in the colour of that side with the z beside it in the same colour, Balanced inside 1 in the plain colour, and nothing while the range has no trades", () => {
    const buyers = mount(<LiveRangeCard report={report({ read: read({ buys: 1_000, sells: 100, noise: 500 }) })} settings={settings} />);
    expect(verdictOf(buyers)).toEqual({ key: "buyers", text: "Buyers in control", z: "z +1.8", color: BID, aboveTable: true });
    const sellers = mount(<LiveRangeCard report={report({ read: read({ buys: 100, sells: 1_000, noise: 500 }) })} settings={settings} />);
    expect(verdictOf(sellers)).toEqual({ key: "sellers", text: "Sellers in control", z: "z −1.8", color: ASK, aboveTable: true });
    expect(noteOf(sellers)).toBeNull();
    const leaning = mount(<LiveRangeCard report={report({ read: read({ buys: 700, sells: 100, noise: 500 }) })} settings={settings} />);
    expect(verdictOf(leaning)).toEqual({ key: "buyers", text: "Buyers in control", z: "z +1.2", color: BID, aboveTable: true });
    const balanced = mount(<LiveRangeCard report={report({ read: read({ buys: 600, sells: 400, noise: 500 }) })} settings={settings} />);
    expect(verdictOf(balanced)).toEqual({ key: "balanced", text: "Balanced", z: "z +0.4", color: "", aboveTable: true });
    expect(verdictOf(mount(<LiveRangeCard report={report({ read: read({ buys: 0, sells: 0, coveredMs: 0, noise: 0 }) })} settings={settings} />))).toBeNull();
    expect(verdictOf(mount(<LiveRangeCard report={report({ read: null })} settings={settings} />))).toBeNull();
  });

  it("holds the verdict in its place as Not enough data while half the range has no data, says Too few minutes under five minutes won, both in the plain colour with no z, and notes under the table the part with no data", () => {
    const unseen = mount(<LiveRangeCard report={report({ read: read({ missing: [[START + 5 * 60_000, START + 30 * 60_000]] }) })} settings={settings} />);
    expect(verdictOf(unseen)).toEqual({ key: "unseen", text: "Not enough data", z: null, color: "", aboveTable: true });
    expect(noteOf(unseen)).toBe("No data for 02:40–03:05 UTC · 83 % of the range");
    const partial = mount(<LiveRangeCard report={report({ read: read({ missing: [[START, START + 5 * 60_000]] }) })} settings={settings} />);
    expect(verdictOf(partial)).toEqual({ key: "buyers", text: "Buyers in control", z: "z +2.0", color: BID, aboveTable: true });
    expect(noteOf(partial)).toBe("No data for 02:35–02:40 UTC · 17 % of the range");
    const few = mount(<LiveRangeCard report={report({ read: read({ minutesWon: { buyers: 3, sellers: 1 } }) })} settings={settings} />);
    expect(verdictOf(few)).toEqual({ key: "few", text: "Too few minutes", z: null, color: "", aboveTable: true });
    expect(noteOf(few)).toBeNull();
    const loading = mount(<LiveRangeCard report={report({ loading: true, read: read({ missing: [[START, START + 30 * 60_000]] }) })} settings={settings} />);
    expect([verdictOf(loading), noteOf(loading)]).toEqual([null, null]);
  });

  it("moves with its grip: the pointer's travel from the press as a shift, kept inside the pane, committed on release; a second pointer is ignored and a double-click puts it back", () => {
    const onMove = vi.fn();
    const onReset = vi.fn();
    const card = mount(<LiveRangeCard report={report()} settings={settings} paneOf={() => pane} onMove={onMove} onReset={onReset} />);
    expect(card.dataset.placed).toBeUndefined();
    const grip = card.querySelector<HTMLButtonElement>("button.live-range-grip")!;
    measure(card);
    pointer(grip, "pointerdown", 400, 60);
    pointer(grip, "pointermove", 450, 90);
    expect(onMove).not.toHaveBeenCalled();
    expect(card.style.transform).toBe("translate(50px, 30px)");
    pointer(grip, "pointerdown", 480, 99, { pointerId: 8 });
    pointer(grip, "pointermove", 480, 99, { pointerId: 8 });
    pointer(grip, "pointerup", 480, 99, { pointerId: 8 });
    expect(card.style.transform).toBe("translate(50px, 30px)");
    expect(onMove).not.toHaveBeenCalled();
    pointer(grip, "pointermove", 5_000, -500);
    expect(card.style.transform).toBe(`translate(${800 - 236 - 4 - 300}px, ${4 - 20}px)`);
    pointer(grip, "pointerup", 460, 100);
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenLastCalledWith({ x: 360, y: 60 });
    expect(card.style.transform).toBe("");
    pointer(grip, "pointermove", 999, 999);
    pointer(grip, "pointerup", 999, 999);
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(card.style.transform).toBe("");
    act(() => { grip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledWith();
  });

  it("explains the price impact of a side in a tip under the pointer while it is over that side's cell, above the pointer near the bottom of the pane, following the card's numbers, and on no other cell", () => {
    const card = mount(<LiveRangeCard report={report({ prints: PRINTS })} settings={settings} paneOf={() => pane} />);
    measure(card);
    expect([TIP_GAP_PX, TIP_ROOM_PX]).toEqual([14, 110]);
    const cells = [...card.querySelectorAll<HTMLTableCellElement>('tr[data-row="impact"] td')];
    expect(cells.map((cell) => cell.className)).toEqual(["live-range-value live-range-hover tabular", "live-range-value live-range-hover tabular"]);
    expect(card.querySelectorAll("td.live-range-hover")).toHaveLength(2);
    expect(card.querySelector(".live-range-tip")).toBeNull();
    pointer(cells[0], "pointermove", 400, 100);
    const tip = () => card.querySelector<HTMLDivElement>(".live-range-tip");
    expect([tip()?.getAttribute("role"), tip()?.dataset.side, tip()?.style.top, tip()?.style.bottom]).toEqual(["tooltip", "buyers", `${100 - 40 + 14}px`, ""]);
    expect(tip()).toBe(card.lastElementChild);
    expect([...tip()!.children].map((line) => [line.className, line.textContent])).toEqual([
      ["live-range-tip-title", "Buyers · price impact"],
      ["live-range-tip-line", "Price went up 12 points in the minutes buyers won"],
      ["live-range-tip-line", "while buyers bought 6.5k BTC"],
      ["live-range-tip-line", "1.9 points up for every 1,000 BTC bought"],
      ["live-range-tip-reading", "Buyers needed 3.9× more size than sellers to move price"],
    ]);
    expect((tip()!.firstElementChild as HTMLElement).style.color).toBe(BID);
    pointer(cells[0], "pointermove", 420, 130);
    expect(tip()?.style.top).toBe(`${130 - 40 + 14}px`);
    act(() => { cells[0].dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body })); });
    expect(tip()).toBeNull();
    const short = mount(<LiveRangeCard report={report({ prints: PRINTS })} settings={settings} paneOf={() => ({ ...pane, height: 200 })} />);
    measure(short);
    const sellers = short.querySelectorAll<HTMLTableCellElement>('tr[data-row="impact"] td')[1];
    pointer(sellers, "pointermove", 500, 150);
    const shortTip = () => short.querySelector<HTMLDivElement>(".live-range-tip");
    expect([shortTip()?.dataset.side, shortTip()?.style.top, shortTip()?.style.bottom]).toEqual(["sellers", "", `${120 - (150 - 40) + 14}px`]);
    expect((shortTip()!.firstElementChild as HTMLElement).style.color).toBe(ASK);
    expect(shortTip()?.lastElementChild?.textContent).toBe("Sellers moved price 3.9× more per unit than buyers");
    pointer(sellers, "pointermove", 500, 110);
    expect(shortTip()?.style.bottom).toBe(`${120 - (110 - 40) + 14}px`);
    pointer(sellers, "pointermove", 500, 109);
    expect([shortTip()?.style.top, shortTip()?.style.bottom]).toEqual([`${109 - 40 + 14}px`, ""]);
    rerender(<LiveRangeCard report={report({ prints: PRINTS, read: read({ impact: { buyers: { moved: 12.4, volume: 6_500 }, sellers: { moved: -5, volume: 40 } } }) })} settings={settings} paneOf={() => ({ ...pane, height: 200 })} />);
    expect(shortTip()?.lastElementChild?.textContent).toBe("Sellers were absorbed: their selling did not drop price");
    rerender(<LiveRangeCard report={report({ prints: PRINTS, read: null })} settings={settings} paneOf={() => ({ ...pane, height: 200 })} />);
    expect(shortTip()).toBeNull();
    rerender(<LiveRangeCard report={report({ prints: PRINTS })} settings={settings} paneOf={() => ({ ...pane, height: 200 })} />);
    expect(shortTip()).toBeNull();
    const loose = mount(<LiveRangeCard report={report()} settings={settings} />);
    measure(loose);
    const looseCell = loose.querySelectorAll('tr[data-row="impact"] td')[0];
    pointer(looseCell, "pointermove", 400, 150);
    expect([loose.querySelector<HTMLDivElement>(".live-range-tip")?.style.top, loose.querySelector(".live-range-tip-line:nth-child(3)")?.textContent]).toEqual([`${150 - 40 + 14}px`, "while buyers bought 6.5k"]);
    act(() => { looseCell.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body })); });
    const others = loose.querySelectorAll('tr[data-row]:not([data-row="impact"]) td');
    expect(others.length).toBe(7);
    for (const other of others) pointer(other, "pointermove", 400, 60);
    expect(loose.querySelector(".live-range-tip")).toBeNull();
  });

  it("shows only the rows its settings keep, in the card's order, and no table at all with none of them, the head, the span, the verdict and the note staying", () => {
    const some = mount(<LiveRangeCard report={report({ prints: PRINTS })} settings={{ ...settings, showDeltaRow: false, showMinutesRow: false }} />);
    expect([...some.querySelectorAll("tr.live-range-row")].map((row) => row.getAttribute("data-row"))).toEqual(["volume", "prints", "impact"]);
    const none = { ...settings, showVolumeRow: false, showDeltaRow: false, showPrintsRow: false, showMinutesRow: false, showImpactRow: false };
    const bare = mount(<LiveRangeCard report={report({ prints: PRINTS })} settings={none} />);
    expect(bare.querySelector("table")).toBeNull();
    expect([headOf(bare), sinceOf(bare)]).toEqual(["on screen", "02:35 → 03:05 UTC · 30 min"]);
    expect(bare.querySelector(".live-range-verdict")?.textContent).toBe("Buyers in controlz +2.0");
    expect(verdictOf(bare)?.aboveTable).toBe(false);
    const waiting = mount(<LiveRangeCard report={report({ read: null })} settings={none} />);
    expect(waiting.querySelector("table")).toBeNull();
    expect(noteOf(waiting)).toBe(WAITING_TEXT);
    const one = mount(<LiveRangeCard report={report({ read: null })} settings={{ ...none, showImpactRow: true }} />);
    expect(one.querySelector("tr.live-range-head")).not.toBeNull();
  });

  it("calls the verdict at the sensitivity of its settings: High from any z off 0, Normal from ±1, Strict from ±2", () => {
    const at = (buys: number, sells: number, verdictSensitivity: LiveRangeSettings["verdictSensitivity"]) => verdictOf(mount(<LiveRangeCard report={report({ read: read({ buys, sells, noise: 500 }) })} settings={{ ...settings, verdictSensitivity }} />))?.key;
    expect([at(1_000, 100, "normal"), at(1_000, 100, "strict"), at(1_100, 100, "strict"), at(100, 1_100, "strict")]).toEqual(["buyers", "balanced", "buyers", "sellers"]);
    expect([at(600, 400, "normal"), at(600, 400, "high"), at(400, 600, "high"), at(500, 500, "high")]).toEqual(["balanced", "buyers", "sellers", "balanced"]);
    expect(at(600, 400, "loose" as LiveRangeSettings["verdictSensitivity"])).toBe("balanced");
  });

  it("shows the price impact tip only while the hover tips are on: with them off the cells let the pointer through and show none, and switching them off or hiding the row takes a shown tip away for good", () => {
    const off = mount(<LiveRangeCard report={report({ prints: PRINTS })} settings={{ ...settings, showTips: false }} paneOf={() => pane} />);
    measure(off);
    const cells = [...off.querySelectorAll<HTMLTableCellElement>('tr[data-row="impact"] td')];
    expect(cells.map((cell) => cell.className)).toEqual(["live-range-value tabular", "live-range-value tabular"]);
    pointer(cells[0], "pointermove", 400, 100);
    expect(off.querySelector(".live-range-tip")).toBeNull();
    const card = (shown: typeof settings) => <LiveRangeCard report={report({ prints: PRINTS })} settings={shown} paneOf={() => pane} />;
    const on = mount(card(settings));
    measure(on);
    const sellers = () => on.querySelectorAll('tr[data-row="impact"] td')[1];
    pointer(sellers(), "pointermove", 500, 100);
    expect(on.querySelector(".live-range-tip")).not.toBeNull();
    rerender(card({ ...settings, showTips: false }));
    expect(on.querySelector(".live-range-tip")).toBeNull();
    rerender(card(settings));
    expect(on.querySelector(".live-range-tip")).toBeNull();
    pointer(sellers(), "pointermove", 500, 100);
    expect(on.querySelector(".live-range-tip")?.getAttribute("data-side")).toBe("sellers");
    rerender(card({ ...settings, showImpactRow: false }));
    expect(on.querySelector(".live-range-tip")).toBeNull();
    rerender(card(settings));
    expect(on.querySelector(".live-range-tip")).toBeNull();
  });

  it("drops the shift and commits nothing when the browser cancels the drag, and drags again after", () => {
    const onMove = vi.fn();
    const card = mount(<LiveRangeCard report={report()} settings={settings} paneOf={() => pane} onMove={onMove} />);
    const grip = card.querySelector<HTMLButtonElement>("button.live-range-grip")!;
    measure(card);
    pointer(grip, "pointerdown", 400, 60);
    pointer(grip, "pointermove", 450, 90);
    expect(card.style.transform).toBe("translate(50px, 30px)");
    pointer(grip, "pointercancel", 0, 0, { pointerId: 8 });
    expect(card.style.transform).toBe("translate(50px, 30px)");
    pointer(grip, "pointercancel", 0, 0);
    expect(card.style.transform).toBe("");
    pointer(grip, "pointermove", 470, 99);
    pointer(grip, "pointerup", 470, 99);
    expect(card.style.transform).toBe("");
    expect(onMove).not.toHaveBeenCalled();
    pointer(grip, "pointerdown", 500, 100);
    pointer(grip, "pointerup", 510, 110);
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenLastCalledWith({ x: 310, y: 30 });
  });

  it("stays put without a way to save its spot, without a pane to keep it in, and under any button but the main one", () => {
    const onMove = vi.fn();
    const dragged = (element: React.ReactElement, button = 0) => {
      const card = mount(element);
      measure(card);
      const grip = card.querySelector<HTMLButtonElement>("button.live-range-grip")!;
      pointer(grip, "pointerdown", 400, 60, { button });
      pointer(grip, "pointermove", 450, 90);
      const shift = card.style.transform;
      pointer(grip, "pointerup", 450, 90);
      return shift;
    };
    expect(dragged(<LiveRangeCard report={report()} settings={settings} paneOf={() => pane} />)).toBe("");
    expect(dragged(<LiveRangeCard report={report()} settings={settings} onMove={onMove} />)).toBe("");
    expect(dragged(<LiveRangeCard report={report()} settings={settings} paneOf={() => null} onMove={onMove} />)).toBe("");
    expect(dragged(<LiveRangeCard report={report()} settings={settings} paneOf={() => pane} onMove={onMove} />, 2)).toBe("");
    expect(onMove).not.toHaveBeenCalled();
    expect(dragged(<LiveRangeCard report={report()} settings={settings} paneOf={() => pane} onMove={onMove} />)).toBe("translate(50px, 30px)");
    expect(onMove).toHaveBeenLastCalledWith({ x: 350, y: 50 });
  });

  it("placed, it sits at its saved spot, shows itself inside the pane by its own size while the pane is narrower, and goes back to the saved spot when the pane widens, never moving the saved spot", () => {
    const onMove = vi.fn();
    const at = (width: number) => <LiveRangeCard report={report()} settings={settings} position={{ x: 500, y: 40 }} paneOf={() => ({ left: 0, top: 0, width, height: 600 })} onMove={onMove} />;
    const card = mount(at(800));
    expect(card.dataset.placed).toBe("true");
    expect([card.style.left, card.style.top]).toEqual(["500px", "40px"]);
    measure(card);
    rerender(at(800));
    expect([card.style.left, card.style.top]).toEqual(["500px", "40px"]);
    rerender(at(700));
    expect([card.style.left, card.style.top]).toEqual(["460px", "40px"]);
    rerender(at(800));
    expect([card.style.left, card.style.top]).toEqual(["500px", "40px"]);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("placed, it also shows itself up inside a pane that got shorter, and back at its spot when the pane grows", () => {
    const onMove = vi.fn();
    const at = (height: number) => <LiveRangeCard report={report()} settings={settings} position={{ x: 100, y: 400 }} paneOf={() => ({ left: 0, top: 0, width: 800, height })} onMove={onMove} />;
    const card = mount(at(600));
    measure(card);
    rerender(at(600));
    expect([card.style.left, card.style.top]).toEqual(["100px", "400px"]);
    rerender(at(500));
    expect([card.style.left, card.style.top]).toEqual(["100px", "376px"]);
    rerender(at(600));
    expect([card.style.left, card.style.top]).toEqual(["100px", "400px"]);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("placed, it fits itself to the pane again when only the pane changed and its saved spot is the very same, as when the chart is resized", () => {
    const onMove = vi.fn();
    const position = { x: 500, y: 40 };
    const at = (width: number) => <LiveRangeCard report={report()} settings={settings} position={position} paneOf={() => ({ left: 0, top: 0, width, height: 600 })} onMove={onMove} />;
    const card = mount(at(800));
    measure(card);
    rerender(at(800));
    expect([card.style.left, card.style.top]).toEqual(["500px", "40px"]);
    rerender(at(700));
    expect([card.style.left, card.style.top]).toEqual(["460px", "40px"]);
    rerender(at(800));
    expect([card.style.left, card.style.top]).toEqual(["500px", "40px"]);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("placed, it keeps its saved spot and reports nothing while its pane has no size, as while the Live tab is hidden behind another panel", () => {
    const onMove = vi.fn();
    let size = { width: 0, height: 0 };
    const element = () => <LiveRangeCard report={report()} settings={settings} position={{ x: 900, y: 300 }} paneOf={() => ({ left: 0, top: 0, ...size })} onMove={onMove} />;
    const card = mount(element());
    measure(card);
    rerender(element());
    expect([card.style.left, card.style.top]).toEqual(["900px", "300px"]);
    size = { width: 1_200, height: 600 };
    rerender(element());
    expect([card.style.left, card.style.top]).toEqual(["900px", "300px"]);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("takes a click on its title without travel as no move at all, so a click, or the first click of a double-click, never takes it out of the column", () => {
    const onMove = vi.fn();
    const card = mount(<LiveRangeCard report={report()} settings={settings} paneOf={() => pane} onMove={onMove} />);
    measure(card);
    const grip = card.querySelector<HTMLButtonElement>("button.live-range-grip")!;
    pointer(grip, "pointerdown", 400, 60);
    pointer(grip, "pointerup", 400, 60);
    pointer(grip, "pointerdown", 400, 60);
    pointer(grip, "pointerup", 402, 61);
    expect(onMove).not.toHaveBeenCalled();
    expect(card.style.transform).toBe("");
    pointer(grip, "pointerdown", 400, 60);
    pointer(grip, "pointerup", 403, 60);
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenLastCalledWith({ x: 303, y: 20 });
  });

  it("placed outside its pane, it stays where it is and reports nothing while it has no pane to fit into or no way to report a move", () => {
    const onMove = vi.fn();
    const placed = (extra: Partial<React.ComponentProps<typeof LiveRangeCard>>) => {
      const card = mount(<LiveRangeCard report={report()} settings={settings} position={{ x: 900, y: 700 }} {...extra} />);
      return [card.dataset.placed, card.style.left, card.style.top];
    };
    expect(placed({ onMove })).toEqual(["true", "900px", "700px"]);
    expect(placed({ paneOf: () => null, onMove })).toEqual(["true", "900px", "700px"]);
    expect(placed({ paneOf: () => pane })).toEqual(["true", "900px", "700px"]);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("never throws from its grip: a pointer passing over it unpressed, a second pointer moving during a drag, a press with no pane to measure", () => {
    const onMove = vi.fn();
    const errors = errorsFrom(() => {
      const card = mount(<LiveRangeCard report={report()} settings={settings} paneOf={() => pane} onMove={onMove} />);
      measure(card);
      const grip = card.querySelector<HTMLButtonElement>("button.live-range-grip")!;
      pointer(grip, "pointermove", 450, 90);
      pointer(grip, "pointerdown", 400, 60);
      pointer(grip, "pointermove", 480, 99, { pointerId: 8 });
      pointer(grip, "pointerup", 450, 90);
      for (const paneOf of [undefined, () => null]) {
        const paneless = mount(<LiveRangeCard report={report()} settings={settings} paneOf={paneOf} onMove={onMove} />);
        measure(paneless);
        pointer(paneless.querySelector("button.live-range-grip")!, "pointerdown", 400, 60);
      }
    });
    expect(errors).toEqual([]);
    expect(onMove.mock.calls).toEqual([[{ x: 350, y: 50 }]]);
  });

  it("holds the pointer for the drag and keeps the press from the page under it, and leaves a press it does not take to the browser", () => {
    const card = mount(<LiveRangeCard report={report()} settings={settings} paneOf={() => pane} onMove={vi.fn()} />);
    measure(card);
    const grip = card.querySelector<HTMLButtonElement>("button.live-range-grip")!;
    const held: number[] = [];
    grip.setPointerCapture = (pointerId: number) => void held.push(pointerId);
    const press = (button: number) => {
      const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button, pointerId: 7, clientX: 400, clientY: 60 });
      act(() => { grip.dispatchEvent(event); });
      return event.defaultPrevented;
    };
    expect(press(2)).toBe(false);
    expect(held).toEqual([]);
    expect(press(0)).toBe(true);
    expect(held).toEqual([7]);
  });

  it("says in a tooltip that the title drags the card and a double-click puts it back", () => {
    const card = mount(<LiveRangeCard report={report()} settings={settings} />);
    expect(card.querySelector("button.live-range-grip")!.getAttribute("title")).toBe("Drag to move, double-click to put it back");
  });
});
