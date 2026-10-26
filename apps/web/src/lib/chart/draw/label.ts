import { assign, create, remove } from "./registry";

export interface LabelData {
  time: number;
  price: number;
  text: string;
  color: string;
  textColor: string;
  size: number;
  textSize: number;
  textAlign: CanvasTextAlign;
  offsetX: number;
  /**
   * Extra x, in bar widths, on top of the time's own coordinate -- how a label
   * reaches a point the time scale cannot: a bar that has not happened yet has
   * no coordinate of its own, but one bar's width still carries a label there.
   */
  barOffset: number;
}

export interface LabelOptions {
  time: number;
  price: number;
  text?: string;
  color?: string;
  textColor?: string;
  size?: number;
  textSize?: number;
  textAlign?: CanvasTextAlign;
  offsetX?: number;
  barOffset?: number;
}

export interface LabelHandle {
  setXY(time: number, price: number): void;
  setText(text: string): void;
  setColor(color: string): void;
  setTextColor(color: string): void;
  setSize(px: number): void;
  setTextSize(px: number): void;
  delete(): void;
}

export const DEFAULT_LABEL_COLOR = "#787b86";
export const DEFAULT_LABEL_TEXT_COLOR = "#ffffff";
export const DEFAULT_LABEL_SIZE = 12;

export function createLabel(
  ownerId: string,
  options: LabelOptions,
): LabelHandle {
  const handleId = create<LabelData>(ownerId, "label", {
    time: options.time,
    price: options.price,
    text: options.text ?? "",
    color: options.color ?? DEFAULT_LABEL_COLOR,
    textColor: options.textColor ?? DEFAULT_LABEL_TEXT_COLOR,
    size: options.size ?? DEFAULT_LABEL_SIZE,
    textSize: options.textSize ?? options.size ?? DEFAULT_LABEL_SIZE,
    textAlign: options.textAlign ?? "center",
    offsetX: options.offsetX ?? 0,
    barOffset: options.barOffset ?? 0,
  });

  return {
    setXY(time, price) {
      assign<LabelData>(handleId, { time, price });
    },
    setText(text) {
      assign<LabelData>(handleId, { text });
    },
    setColor(color) {
      assign<LabelData>(handleId, { color });
    },
    setTextColor(color) {
      assign<LabelData>(handleId, { textColor: color });
    },
    setSize(px) {
      assign<LabelData>(handleId, { size: px });
    },
    setTextSize(px) {
      assign<LabelData>(handleId, { textSize: px });
    },
    delete() {
      remove(handleId);
    },
  };
}
