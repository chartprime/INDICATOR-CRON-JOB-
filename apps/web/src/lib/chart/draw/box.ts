import { assign, create, remove } from "./registry";

export type BoxTextVAlign = "middle" | "bottom";

export interface BoxData {
  time1: number;
  price1: number;
  time2: number;
  price2: number;
  borderColor: string;
  backgroundColor: string;
  borderWidth: number;
  text: string;
  textColor: string;
  textColorOnDark: string;
  fontSize: number;
  textAlign: CanvasTextAlign;
  textBackground: string;
  cornerRadius: number;
  tailFade: boolean;
  fontFamily: string;
  textPadding: number;
  textAccent: string;
  keepTextClear: boolean;
  textAfterBox: boolean;
  textFallbacks: readonly string[];
  minHeightPx: number;
  extendRight: boolean;
  textOffsetY: number;
  textVAlign: BoxTextVAlign;
  textOverLines: boolean;
  textFitsHeight: boolean;
}

export interface BoxOptions {
  time1: number;
  price1: number;
  time2: number;
  price2: number;
  borderColor?: string;
  backgroundColor?: string;
  borderWidth?: number;
  text?: string;
  textColor?: string;
  textColorOnDark?: string;
  fontSize?: number;
  textAlign?: CanvasTextAlign;
  textBackground?: string;
  cornerRadius?: number;
  tailFade?: boolean;
  fontFamily?: string;
  textPadding?: number;
  textAccent?: string;
  keepTextClear?: boolean;
  textAfterBox?: boolean;
  textFallbacks?: readonly string[];
  minHeightPx?: number;
  extendRight?: boolean;
  textOffsetY?: number;
  textVAlign?: BoxTextVAlign;
  textOverLines?: boolean;
  textFitsHeight?: boolean;
}

export interface BoxHandle {
  setLeftTop(time: number, price: number): void;
  setRightBottom(time: number, price: number): void;
  setBorderColor(color: string): void;
  setBackgroundColor(color: string): void;
  setBorderWidth(px: number): void;
  setText(text: string): void;
  setTextColor(color: string): void;
  setTextBackground(color: string): void;
  setTextAccent(color: string): void;
  setTailFade(on: boolean): void;
  setTextFallbacks(texts: readonly string[]): void;
  setMinHeightPx(px: number): void;
  setExtendRight(on: boolean): void;
  setTextOffsetY(px: number): void;
  delete(): void;
}

export const DEFAULT_BOX_BORDER_COLOR = "#787b86";
export const DEFAULT_BOX_BACKGROUND_COLOR = "rgba(120, 123, 134, 0.2)";
export const DEFAULT_BOX_BORDER_WIDTH = 1;
export const DEFAULT_BOX_TEXT_COLOR = "#787b86";
export const DEFAULT_BOX_FONT_SIZE = 10;
export const DEFAULT_BOX_FONT_FAMILY = "monospace";
export const DEFAULT_BOX_TEXT_PADDING = 4;
export const DEFAULT_BOX_TEXT_ALIGN: CanvasTextAlign = "left";

export function createBox(ownerId: string, options: BoxOptions): BoxHandle {
  const handleId = create<BoxData>(ownerId, "box", {
    time1: options.time1,
    price1: options.price1,
    time2: options.time2,
    price2: options.price2,
    borderColor: options.borderColor ?? DEFAULT_BOX_BORDER_COLOR,
    backgroundColor: options.backgroundColor ?? DEFAULT_BOX_BACKGROUND_COLOR,
    borderWidth: options.borderWidth ?? DEFAULT_BOX_BORDER_WIDTH,
    text: options.text ?? "",
    textColor: options.textColor ?? DEFAULT_BOX_TEXT_COLOR,
    textColorOnDark: options.textColorOnDark ?? "",
    fontSize: options.fontSize ?? DEFAULT_BOX_FONT_SIZE,
    textAlign: options.textAlign ?? DEFAULT_BOX_TEXT_ALIGN,
    textBackground: options.textBackground ?? "",
    cornerRadius: options.cornerRadius ?? 0,
    tailFade: options.tailFade ?? false,
    fontFamily: options.fontFamily ?? DEFAULT_BOX_FONT_FAMILY,
    textPadding: options.textPadding ?? DEFAULT_BOX_TEXT_PADDING,
    textAccent: options.textAccent ?? "",
    keepTextClear: options.keepTextClear ?? false,
    textAfterBox: options.textAfterBox ?? false,
    textFallbacks: options.textFallbacks ?? [],
    minHeightPx: options.minHeightPx ?? 0,
    extendRight: options.extendRight ?? false,
    textOffsetY: options.textOffsetY ?? 0,
    textVAlign: options.textVAlign ?? "middle",
    textOverLines: options.textOverLines ?? false,
    textFitsHeight: options.textFitsHeight ?? false,
  });

  return {
    setLeftTop(time, price) {
      assign<BoxData>(handleId, { time1: time, price1: price });
    },
    setRightBottom(time, price) {
      assign<BoxData>(handleId, { time2: time, price2: price });
    },
    setBorderColor(color) {
      assign<BoxData>(handleId, { borderColor: color });
    },
    setBackgroundColor(color) {
      assign<BoxData>(handleId, { backgroundColor: color });
    },
    setBorderWidth(px) {
      assign<BoxData>(handleId, { borderWidth: px });
    },
    setText(text) {
      assign<BoxData>(handleId, { text });
    },
    setTextColor(color) {
      assign<BoxData>(handleId, { textColor: color });
    },
    setTextBackground(color) {
      assign<BoxData>(handleId, { textBackground: color });
    },
    setTextAccent(color) {
      assign<BoxData>(handleId, { textAccent: color });
    },
    setTailFade(on) {
      assign<BoxData>(handleId, { tailFade: on });
    },
    setTextFallbacks(texts) {
      assign<BoxData>(handleId, { textFallbacks: texts });
    },
    setMinHeightPx(px) {
      assign<BoxData>(handleId, { minHeightPx: px });
    },
    setExtendRight(on) {
      assign<BoxData>(handleId, { extendRight: on });
    },
    setTextOffsetY(px) {
      assign<BoxData>(handleId, { textOffsetY: px });
    },
    delete() {
      remove(handleId);
    },
  };
}
