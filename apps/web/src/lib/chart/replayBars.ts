import type { BarFrame, TradeFrame } from "../../types/frames";
import { withDrawOwnerScope } from "./draw/creationScope";
import { clearForIndicator } from "./draw/registry";
import type { RuntimeIndicatorDef } from "./indicatorTypes";

const EMPTY_NAMESPACE = Object.freeze({});
const EMPTY_TRADES: readonly TradeFrame[] = Object.freeze([]);
const NOOP_DRAW = Object.freeze({ fill: () => {} });
const NOOP_MARKERS = Object.freeze({ plotshape: () => {}, plotchar: () => {} });
let nextReplayOwnerId = 1;

export interface ReplayResult {
  perBar: Readonly<Record<string, readonly (number | null)[]>>;
}

export function replayBars<S, T>(def: RuntimeIndicatorDef<S, T>, bars: readonly BarFrame[], settings: T): ReplayResult {
  // A replay is not a live chart. Give it a temporary isolated owner and
  // remove any created handles when it completes.
  const drawOwnerId = `replay:${nextReplayOwnerId}:${def.id}`;
  nextReplayOwnerId += 1;
  try {
    const state = withDrawOwnerScope(drawOwnerId, () => def.createState(settings));
    const outputs: Record<string, (number | null)[]> = {};
    for (const line of def.lines) outputs[line.key] = [];

    for (const bar of bars) {
      def.onBar({
        bar,
        trades: EMPTY_TRADES,
        tradeAvailability: "HISTORICAL_UNAVAILABLE",
        state,
        settings,
        replace: false,
        replaying: true,
        ta: EMPTY_NAMESPACE,
        draw: NOOP_DRAW,
        markers: NOOP_MARKERS,
        pane: { paneIndex: 0 },
      });
      const values = def.readOutput(state);
      for (const key of Object.keys(outputs)) {
        outputs[key].push(values[key] ?? null);
      }
    }

    return { perBar: outputs };
  } finally {
    clearForIndicator(drawOwnerId);
  }
}
