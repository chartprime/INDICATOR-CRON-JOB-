import type { ExhaustionReadings, ExhaustionShade, ExhaustionSide, ExhaustionStatus } from "../../../types/frames";
import { exhaustionLabels, exhaustionValueTexts } from "./exhaustionWords";

export interface ExhaustionLine {
  key: keyof ExhaustionReadings;
  label: string;
  value: string;
  detail: string;
  counted: boolean;
}

export interface ExhaustionHover {
  id: string;
  side: ExhaustionSide;
  short: string;
  title: string;
  lines: ExhaustionLine[];
}

export const MAX_SCORE = 6;
export const SCORE_ACCURACY: Readonly<Record<number, number>> = Object.freeze({ 3: 57, 4: 54, 5: 60, 6: 69 });

const STATUS_WORDS: Record<ExhaustionStatus, string> = {
  open: "live",
  pending: "waiting for the verdict",
  held: "held",
  broke: "broke through",
  interrupted: "session break",
};

export function statusWords(status: ExhaustionStatus): string {
  return STATUS_WORDS[status];
}

export function scoreAccuracy(score: number): number | null {
  return SCORE_ACCURACY[score] ?? null;
}

export function scoreLabel(shade: Pick<ExhaustionShade, "score">, calibrated = true): string {
  const accuracy = calibrated ? scoreAccuracy(shade.score) : null;
  return `${shade.score}/${MAX_SCORE}${accuracy === null ? "" : ` · ~${accuracy}%`}`;
}

export const EXHAUSTION_LINE_KEYS: readonly (keyof ExhaustionReadings)[] = Object.freeze(["rate", "progress", "delta", "divergence", "prints", "book"]);

export function describeExhaustion(shade: ExhaustionShade, calibrated = true, unit = ""): ExhaustionHover {
  const who = shade.side === "buyers" ? "Buyers" : "Sellers";
  const labels = exhaustionLabels(shade.side);
  const texts = exhaustionValueTexts(shade.side, shade.raw, unit);
  const lines: ExhaustionLine[] = EXHAUSTION_LINE_KEYS.map((key) => ({ key, label: labels[key], value: texts[key].main, detail: texts[key].sub, counted: shade.readings[key] }));
  return {
    id: shade.id,
    side: shade.side,
    short: `${who} exhausted · ${shade.score}/${MAX_SCORE}`,
    title: `${who} exhausted · ${scoreLabel(shade, calibrated)} · ${statusWords(shade.status)}`,
    lines,
  };
}
