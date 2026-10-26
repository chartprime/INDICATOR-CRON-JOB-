export type PocLineStyle = "dotted" | "solid" | "dashed";

export interface VolumeDeltaProfileOhlcSettings {
  buyColor: string;
  sellColor: string;
  borderColor: string;
  minOpacity: number;
  maxOpacity: number;
  profileWidth: number;
  binCount: number;
  pocVisible: boolean;
  pocColor: string;
  pocLineStyle: PocLineStyle;
  vahValVisible: boolean;
  vahValPercent: number;
  vahColor: string;
  valColor: string;
  vahLineStyle: PocLineStyle;
  valLineStyle: PocLineStyle;
  /** Stroke width in px, shared by VAH and VAL. */
  vahValLineWidth: number;
}

export const MIN_PROFILE_WIDTH_PX = 50;
export const MAX_PROFILE_WIDTH_PX = 300;
export const PROFILE_WIDTH_STEP_PX = 10;

export const DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS: VolumeDeltaProfileOhlcSettings =
  {
    borderColor: "#ffffff",
    minOpacity: 0.6,
    maxOpacity: 1.0,
    profileWidth: 140,
    binCount: 100,
    pocVisible: true,
    pocColor: "#dc2626",
    pocLineStyle: "solid",
    buyColor: "#1b94c4",
    sellColor: "#dc2626",
    vahValVisible: true,
    vahValPercent: 68,
    vahColor: "#1b94c4",
    valColor: "#ef4444",
    vahLineStyle: "dashed",
    valLineStyle: "dashed",
    vahValLineWidth: 1,
  };
