import { TIMEFRAMES } from "./resampleBars";

export type TimeframeMenuOption = Readonly<{
  id: string;
  label: string;
}>;

export const LIVE_TIMEFRAME_MENU_OPTIONS: readonly TimeframeMenuOption[] = Object.freeze(
  TIMEFRAMES.map((timeframe) => Object.freeze({ id: timeframe.label, label: timeframe.label })),
);
