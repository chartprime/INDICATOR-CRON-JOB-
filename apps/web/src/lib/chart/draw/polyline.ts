import { assign, create, remove } from "./registry";
import type { LineStyleKind } from "./line";

export interface PolylinePoint {
  time: number;
  price: number;
}

export interface PolylineData {
  points: readonly PolylinePoint[];
  color: string;
  width: number;
  style: LineStyleKind;
}

export interface PolylineOptions {
  points: readonly PolylinePoint[];
  color?: string;
  width?: number;
  style?: LineStyleKind;
}

export interface PolylineHandle {
  setPoints(points: readonly PolylinePoint[]): void;
  setColor(color: string): void;
  setWidth(px: number): void;
  setStyle(style: LineStyleKind): void;
  delete(): void;
}

export const DEFAULT_POLYLINE_COLOR = "#787b86";
export const DEFAULT_POLYLINE_WIDTH = 1;

export function createPolyline(ownerId: string, options: PolylineOptions): PolylineHandle {
  const handleId = create<PolylineData>(ownerId, "polyline", {
    points: options.points,
    color: options.color ?? DEFAULT_POLYLINE_COLOR,
    width: options.width ?? DEFAULT_POLYLINE_WIDTH,
    style: options.style ?? "solid",
  });

  return {
    setPoints(points) {
      assign<PolylineData>(handleId, { points });
    },
    setColor(color) {
      assign<PolylineData>(handleId, { color });
    },
    setWidth(px) {
      assign<PolylineData>(handleId, { width: px });
    },
    setStyle(style) {
      assign<PolylineData>(handleId, { style });
    },
    delete() {
      remove(handleId);
    },
  };
}
