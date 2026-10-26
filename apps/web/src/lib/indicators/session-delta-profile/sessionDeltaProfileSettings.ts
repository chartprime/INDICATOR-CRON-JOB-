import type { LineStyleKind } from "../../chart/draw/line";

export interface SessionDeltaProfileSettings {
  sessionPeriodMs: number;
  maxDisplaySessions: number;
  rowWidth: number;
  maxBarWidthPx: number;
  valueAreaPercent: number;
  buyColor: string;
  sellColor: string;
  buyPocColor: string;
  sellPocColor: string;
  buyPocStyle: LineStyleKind;
  sellPocStyle: LineStyleKind;
  vahValColor: string;
  developingOpacity: number;
  smallRowOpacity: number;
  showBuyPoc: boolean;
  showSellPoc: boolean;
  showValueAreaLines: boolean;
  showSessionHighLow: boolean;
  sessionHighLowColor: string;
}

export const DEFAULT_SESSION_DELTA_PROFILE_SETTINGS: SessionDeltaProfileSettings =
  {
    sessionPeriodMs: 4 * 60 * 60 * 1000,
    maxDisplaySessions: 5,
    rowWidth: 8,
    maxBarWidthPx: 110,
    valueAreaPercent: 0.7,
    buyColor: "#15bdc9",
    sellColor: "#8426dc",
    buyPocColor: "#15bdc9",
    sellPocColor: "#8426dc",
    buyPocStyle: "solid",
    sellPocStyle: "solid",
    vahValColor: "#0c61e2",
    developingOpacity: 0.8,
    smallRowOpacity: 0.5,
    showBuyPoc: true,
    showSellPoc: true,
    showValueAreaLines: false,
    showSessionHighLow: true,
    sessionHighLowColor: "#787b86",
  };
