import type { InitiativeDominant, InitiativeSide } from "../../../types/frames";

export function pushersOf(side: InitiativeSide): InitiativeDominant {
  return side === "up" ? "buyers" : "sellers";
}

export function strengthOf(score: number): string {
  return score >= 5 ? "Very strong" : score === 4 ? "Strong" : score === 3 ? "Moderate" : "Weak";
}

export function percentText(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function timesText(ratio: number): string {
  return `${ratio.toFixed(1)}×`;
}
