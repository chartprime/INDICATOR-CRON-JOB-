import { assertInsideCreationWindow } from "../ta/creationGuard";
import { currentDrawOwnerId } from "./creationScope";
import { createBox, type BoxHandle, type BoxOptions } from "./box";
import { createLabel, type LabelHandle, type LabelOptions } from "./label";
import { createLine, type LineHandle, type LineOptions } from "./line";
import { createPolyline, type PolylineHandle, type PolylineOptions } from "./polyline";
import { createTable, type TableHandle, type TableOptions } from "./table";

function noop(): void {}

// This module's `draw.line`/`.box`/etc. are the top-level, called-once-in-
// createState factories -- deliberately distinct from the per-bar `ctx.draw`
// field (which only ever carries `.fill`), the same split TA.02 already
// established between the top-level `ta` module and the always-empty
// `ctx.ta`. Do not conflate the two despite the shared name.
function makeDrawFactory<TArgs extends unknown[], THandle>(
  name: string,
  create: (ownerId: string, ...args: TArgs) => THandle,
  inertHandle: THandle,
): (...args: TArgs) => THandle {
  return (...args: TArgs) => {
    assertInsideCreationWindow(name);
    const ownerId = currentDrawOwnerId();
    if (ownerId === null) return inertHandle;
    return create(ownerId, ...args);
  };
}

const INERT_LINE_HANDLE: LineHandle = {
  setXY1: noop, setXY2: noop, setColor: noop, setWidth: noop, setStyle: noop, setExtend: noop, delete: noop,
};
const INERT_BOX_HANDLE: BoxHandle = {
  setLeftTop: noop, setRightBottom: noop, setBorderColor: noop, setBackgroundColor: noop, setBorderWidth: noop, setText: noop, setTextColor: noop, setTextBackground: noop, setTextAccent: noop, setTailFade: noop, setTextFallbacks: noop, setMinHeightPx: noop, setExtendRight: noop, setTextOffsetY: noop, delete: noop,
};
const INERT_LABEL_HANDLE: LabelHandle = {
  setXY: noop, setText: noop, setColor: noop, setTextColor: noop, setSize: noop, setTextSize: noop, delete: noop,
};
const INERT_POLYLINE_HANDLE: PolylineHandle = {
  setPoints: noop, setColor: noop, setWidth: noop, setStyle: noop, delete: noop,
};
const INERT_TABLE_HANDLE: TableHandle = { cell: noop, delete: noop };

export const draw = {
  line: makeDrawFactory("draw.line", (ownerId, options: LineOptions) => createLine(ownerId, options), INERT_LINE_HANDLE),
  box: makeDrawFactory("draw.box", (ownerId, options: BoxOptions) => createBox(ownerId, options), INERT_BOX_HANDLE),
  label: makeDrawFactory("draw.label", (ownerId, options: LabelOptions) => createLabel(ownerId, options), INERT_LABEL_HANDLE),
  polyline: makeDrawFactory(
    "draw.polyline",
    (ownerId, options: PolylineOptions) => createPolyline(ownerId, options),
    INERT_POLYLINE_HANDLE,
  ),
  table: makeDrawFactory("draw.table", (ownerId, options?: TableOptions) => createTable(ownerId, options), INERT_TABLE_HANDLE),
};
