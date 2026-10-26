import type { InitiativeBand, InitiativeDominant, InitiativeFacts, InitiativeSide } from "../../../types/frames";
import { MAX_SCORE } from "./initiativeSettings";
import { percentText, pushersOf, strengthOf, timesText } from "./initiativeWords";

export interface InitiativeLine {
  key: keyof InitiativeFacts;
  label: string;
  value: string;
  counted: boolean;
}

export interface InitiativeHover {
  id: string;
  side: InitiativeSide;
  pushers: InitiativeDominant;
  short: string;
  title: string;
  lines: InitiativeLine[];
}

export const INITIATIVE_LINE_KEYS: readonly (keyof InitiativeFacts)[] = Object.freeze(["efficiency", "closes", "burst", "delta", "prints"]);

export function scoreLabel(band: Pick<InitiativeBand, "score">): string {
  return `${band.score}/${MAX_SCORE}`;
}

function factLine(band: InitiativeBand, key: keyof InitiativeFacts): Pick<InitiativeLine, "label" | "value"> {
  const up = band.side === "up";
  const facts = band.facts;
  const trades = up ? "buy" : "sell";
  switch (key) {
    case "efficiency":
      return { label: "Clean move", value: facts.efficiency.value === null ? "price barely moved" : facts.efficiency.yes ? "price went mostly one way" : "price went back and forth" };
    case "closes": {
      const edge = up ? "high" : "low";
      const count = facts.closes.value === 0 ? "none" : facts.closes.yes ? `${facts.closes.value}` : `only ${facts.closes.value}`;
      return { label: "Strong candles", value: `${count} of ${band.windowCandles} closed near the ${edge}` };
    }
    case "burst":
      return { label: "Volume burst", value: facts.burst.value === null ? "volume not measured" : `volume ${facts.burst.yes ? "" : "only "}${timesText(facts.burst.value)} the quiet before` };
    case "delta":
      return { label: `${up ? "Buyers" : "Sellers"} in charge`, value: facts.delta.share === null ? "orders not measured" : `${percentText(facts.delta.share)} of orders were ${trades}s, ${facts.delta.yes ? "unusually high" : "not unusual"}` };
    case "prints":
      return { label: `Big ${pushersOf(band.side)}`, value: facts.prints.perCandle === null ? "large trades not measured" : facts.prints.yes ? `more large ${trades} trades than usual` : facts.prints.perCandle === 0 ? `no large ${trades} trades` : `large ${trades} trades at a usual pace` };
  }
}

export function describeInitiative(band: InitiativeBand): InitiativeHover {
  const up = band.side === "up";
  const strength = strengthOf(band.score);
  return {
    id: band.id,
    side: band.side,
    pushers: pushersOf(band.side),
    short: `${up ? "Buy" : "Sell"} start · ${strength} (${band.score} of ${MAX_SCORE})`,
    title: `${up ? "▲ BUY" : "▼ SELL"} START · ${strength.toUpperCase()} (${band.score} of ${MAX_SCORE})`,
    lines: INITIATIVE_LINE_KEYS.map((key) => ({ key, ...factLine(band, key), counted: band.facts[key].yes })),
  };
}
