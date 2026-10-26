import { afterEach, describe, expect, it } from "vitest";
import { createTable, flushTableCells, type TableData } from "../table";
import { handlesForOwners, resetDrawRegistryForTests } from "../registry";

afterEach(() => {
  resetDrawRegistryForTests();
});

describe("createTable -- buffering", () => {
  it("registers one object with empty pending and committed grids, in the top-right corner unless told otherwise", () => {
    createTable("statsPanel");
    const [record] = handlesForOwners(["statsPanel"]);
    expect(record.kind).toBe("table");
    expect(record.data).toEqual({ position: "top-right", pendingGrid: {}, committedGrid: {} });
    createTable("cornerPanel", { position: "bottom-right" });
    expect((handlesForOwners(["cornerPanel"])[0].data as TableData).position).toBe("bottom-right");
  });

  it("a cell() call is visible in the pending grid but not the committed grid until flushed", () => {
    const table = createTable("statsPanel");
    table.cell(0, 0, { text: "VPIN" });
    const [record] = handlesForOwners(["statsPanel"]);
    const data = record.data as TableData;
    expect(data.pendingGrid["0,0"]).toMatchObject({ text: "VPIN" });
    expect(data.committedGrid).toEqual({});
  });

  it("multiple cell() calls before one flush produce exactly one committed-grid replacement, not one per call", () => {
    const table = createTable("statsPanel");
    table.cell(0, 0, { text: "VPIN" });
    table.cell(0, 1, { text: "0.42" });
    table.cell(1, 0, { text: "GEX" });
    flushTableCells("statsPanel");

    const [record] = handlesForOwners(["statsPanel"]);
    const data = record.data as TableData;
    expect(data.committedGrid).toEqual({
      "0,0": { text: "VPIN", bgColor: "transparent", textColor: "#d1d4dc" },
      "0,1": { text: "0.42", bgColor: "transparent", textColor: "#d1d4dc" },
      "1,0": { text: "GEX", bgColor: "transparent", textColor: "#d1d4dc" },
    });
  });

  it("applies explicit bgColor/textColor overrides per cell", () => {
    const table = createTable("statsPanel");
    table.cell(0, 0, { text: "VPIN", bgColor: "#111111", textColor: "#ffffff" });
    flushTableCells("statsPanel");
    const [record] = handlesForOwners(["statsPanel"]);
    expect((record.data as TableData).committedGrid["0,0"]).toEqual({ text: "VPIN", bgColor: "#111111", textColor: "#ffffff" });
  });

  it("a later cell() call for the same row/col overwrites the earlier one in the pending grid", () => {
    const table = createTable("statsPanel");
    table.cell(0, 0, { text: "first" });
    table.cell(0, 0, { text: "second" });
    flushTableCells("statsPanel");
    const [record] = handlesForOwners(["statsPanel"]);
    expect((record.data as TableData).committedGrid["0,0"]).toMatchObject({ text: "second" });
  });

  it("flushing an owner with no table objects is a silent no-op", () => {
    expect(() => flushTableCells("nobody")).not.toThrow();
  });

  it("flushing does not affect a different owner's table", () => {
    createTable("a");
    const tableB = createTable("b");
    tableB.cell(0, 0, { text: "b-only" });
    flushTableCells("a");
    const [recordB] = handlesForOwners(["b"]);
    expect((recordB.data as TableData).committedGrid).toEqual({});
  });

  it("delete removes the object from the registry", () => {
    const table = createTable("statsPanel");
    table.delete();
    expect(handlesForOwners(["statsPanel"])).toEqual([]);
  });
});
