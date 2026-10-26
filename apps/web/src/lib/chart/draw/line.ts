import { assign, create, remove } from "./registry";

export type LineStyleKind = "solid" | "dashed" | "dotted";
export type LineExtendKind = "none" | "left" | "right" | "both";

export interface LineData {
  time1: number;
  price1: number;
  time2: number;
  price2: number;
  color: string;
  width: number;
  style: LineStyleKind;
  extend: LineExtendKind;
}

export interface LineOptions {
  time1: number;
  price1: number;
  time2: number;
  price2: number;
  color?: string;
  width?: number;
  style?: LineStyleKind;
  extend?: LineExtendKind;
}

export interface LineHandle {
  setXY1(time: number, price: number): void;
  setXY2(time: number, price: number): void;
  setColor(color: string): void;
  setWidth(px: number): void;
  setStyle(style: LineStyleKind): void;
  setExtend(extend: LineExtendKind): void;
  delete(): void;
}

export const DEFAULT_LINE_COLOR = "#787b86";
export const DEFAULT_LINE_WIDTH = 1;

export function createLine(ownerId: string, options: LineOptions): LineHandle {
  const handleId = create<LineData>(ownerId, "line", {
    time1: options.time1,
    price1: options.price1,
    time2: options.time2,
    price2: options.price2,
    color: options.color ?? DEFAULT_LINE_COLOR,
    width: options.width ?? DEFAULT_LINE_WIDTH,
    style: options.style ?? "solid",
    extend: options.extend ?? "none",
  });

  return {
    setXY1(time, price) {
      assign<LineData>(handleId, { time1: time, price1: price });
    },
    setXY2(time, price) {
      assign<LineData>(handleId, { time2: time, price2: price });
    },
    setColor(color) {
      assign<LineData>(handleId, { color });
    },
    setWidth(px) {
      assign<LineData>(handleId, { width: px });
    },
    setStyle(style) {
      assign<LineData>(handleId, { style });
    },
    setExtend(extend) {
      assign<LineData>(handleId, { extend });
    },
    delete() {
      remove(handleId);
    },
  };
}
