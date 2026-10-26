export type PocLineStyle = "dotted" | "solid" | "dashed";

export interface VolumeDeltaProfileTickSettings {
  buyColor: string;
  sellColor: string;
  /** Rings every bin's total-volume bar. */
  binBorderVisible: boolean;
  binBorderColor: string;
  /** 0 is invisible, 1 is the colour at full strength. */
  binBorderOpacity: number;
  /** Writes each bin's total volume inside its bar, where the bar is tall enough. */
  binVolumeVisible: boolean;
  minOpacity: number;
  maxOpacity: number;
  profileWidth: number;
  binCount: number;
  /**
   * Off: `binCount` is the count while the price range holds room for buckets
   * that are whole source rows, and the range's own rows below that, so the
   * profile zooms with the chart. On: exactly `binCount` buckets, whatever that
   * makes of a source row.
   */
  fixedRowCount: boolean;
  pocVisible: boolean;
  pocColor: string;
  pocLineStyle: PocLineStyle;
  /** Stroke width in px for the POC line. */
  pocLineWidth: number;
  vahValVisible: boolean;
  vahValPercent: number;
  vahColor: string;
  valColor: string;
  vahLineStyle: PocLineStyle;
  valLineStyle: PocLineStyle;
  /** Stroke width in px, shared by VAH and VAL. */
  vahValLineWidth: number;
}

export const DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS: VolumeDeltaProfileTickSettings =
  {
    minOpacity: 0.4,
    maxOpacity: 1.0,
    profileWidth: 300,
    binCount: 200,
    // Dynamic by default: the profile follows the price range in view, so its
    // rows stay whole source rows rather than slices of them.
    fixedRowCount: false,
    // Bright blue-buy / red-sell pair, so the bins read clearly at the low end
    // of the opacity ramp.
    buyColor: "#3b82f6",
    sellColor: "#ef4444",
    // A black border at low opacity: enough to separate bins, faint enough to
    // stay behind the volume ramp.
    binBorderVisible: true,
    binBorderColor: "#000000",
    binBorderOpacity: 0.2,
    binVolumeVisible: true,
    pocVisible: true,
    pocColor: "#dc2626",
    pocLineStyle: "solid",
    pocLineWidth: 2,
    vahValVisible: true,
    vahValPercent: 68,
    vahColor: "#1b94c4",
    valColor: "#ef4444",
    vahLineStyle: "dashed",
    valLineStyle: "dashed",
    // Thin by default: the levels are guides over the profile, not readings.
    vahValLineWidth: 1,
  };

/**
 * Settings as saved by an older build can lack keys added since, so anything
 * that reads settings other than straight from the modal runs them through
 * here first: a missing colour or opacity would otherwise reach the renderer
 * as undefined.
 */
export function normalizeVolumeDeltaProfileTickSettings(
  settings: Partial<VolumeDeltaProfileTickSettings> | undefined,
): VolumeDeltaProfileTickSettings {
  return { ...DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS, ...settings };
}
