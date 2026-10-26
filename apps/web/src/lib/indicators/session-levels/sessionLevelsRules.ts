import type { SettingsFieldSchema } from "../../chart/indicatorTypes";
import { withAlpha } from "../classic-order-blocks/orderBlockRender";
import { formatLiquiditySize } from "../passive-liquidity/liquiditySettings";
import type { LevelStatus } from "./levelStatus";
import { shownVerdict, type Verdict, type WindowFacts } from "./levelWindow";
import { KILLZONE_SESSIONS, type KillzoneId, type KillzoneSessionDef } from "../killzones/killzones";
import { MAX_RANGES, ORB_WINDOWS_MIN, type OrbWindowMin, type Range, type RangeSettings } from "./sessionRanges";

export const MAX_LEVELS = 2 * MAX_RANGES;

export const LEVEL_LINE_WIDTH = 2;

export const LEVEL_FONT_SIZE = 11;

export const LEVEL_FONT_FAMILY = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif';

export const CHIP_RADIUS = 6;

export const CHIP_PADDING = 4;

export const CHIP_FILL = "rgba(255, 255, 255, 0.92)";

export const CHIP_TEXT = "#0f172a";

export const TEXT_LIFT_PX = 15;

export const SHADE_ALPHA = 0.04;

export const ORB_COLORS: Record<OrbWindowMin, string> = { 5: "#ca8a04", 15: "#7c3aed", 30: "#16a34a" };

export type RangeColorKey = `${KillzoneId}Color` | `orb${OrbWindowMin}Color`;

export type RangeColors = Record<RangeColorKey, string>;

export interface SessionLevelsSettings extends RangeSettings, RangeColors {
  showSwept: boolean;
}

function sessionColorKey(sessionId: KillzoneId): RangeColorKey {
  return `${sessionId}Color`;
}

function orbColorKey(windowMin: OrbWindowMin): RangeColorKey {
  return `orb${windowMin}Color`;
}

export function colorKeyOf(range: Range): RangeColorKey {
  return range.kind === "orb" ? orbColorKey(range.windowMin) : sessionColorKey(range.sessionId);
}

export const DEFAULT_RANGE_COLORS: RangeColors = Object.fromEntries([
  ...KILLZONE_SESSIONS.map((session) => [sessionColorKey(session.id), session.lineColor]),
  ...ORB_WINDOWS_MIN.map((windowMin) => [orbColorKey(windowMin), ORB_COLORS[windowMin]]),
]) as RangeColors;

export const DEFAULT_SESSION_LEVELS_SETTINGS: SessionLevelsSettings = {
  sessions: new Set<KillzoneId>(KILLZONE_SESSIONS.filter((session) => session.defaultShown).map((session) => session.id)),
  windows: new Set<OrbWindowMin>(ORB_WINDOWS_MIN),
  sessionLevels: true,
  showSwept: true,
  ...DEFAULT_RANGE_COLORS,
};

export const SESSION_LEVELS_SETTINGS_SCHEMA: readonly SettingsFieldSchema<SessionLevelsSettings>[] = [
  { kind: "checkboxList", key: "sessions", label: "Sessions", options: KILLZONE_SESSIONS.map((session) => ({ value: session.id, label: session.label })), affects: "recompute" },
  { kind: "boolean", key: "sessionLevels", label: "Session high and low", affects: "recompute" },
  { kind: "checkboxList", key: "windows", label: "Opening ranges (New York open)", options: ORB_WINDOWS_MIN.map((windowMin) => ({ value: windowMin, label: `ORB ${windowMin} min` })), affects: "recompute" },
  { kind: "boolean", key: "showSwept", label: "Show liquidity sweeps", affects: "recompute" },
  ...KILLZONE_SESSIONS.map((session): SettingsFieldSchema<SessionLevelsSettings> => ({ kind: "color", key: sessionColorKey(session.id), label: `${session.label} colour`, tab: "visibility", affects: "recompute", visibleIf: (settings) => settings.sessions.has(session.id) })),
  ...ORB_WINDOWS_MIN.map((windowMin): SettingsFieldSchema<SessionLevelsSettings> => ({ kind: "color", key: orbColorKey(windowMin), label: `ORB ${windowMin} min colour`, tab: "visibility", affects: "recompute", visibleIf: (settings) => settings.windows.has(windowMin) })),
];

export type LevelSide = "high" | "low";

export interface Level {
  range: Range;
  side: LevelSide;
  price: number;
  touchMs: number | null;
}

export function levelsOf(ranges: readonly Range[]): Level[] {
  const levels: Level[] = [];
  for (const range of ranges) {
    levels.push({ range, side: "high", price: range.high, touchMs: range.highTouchMs }, { range, side: "low", price: range.low, touchMs: range.lowTouchMs });
  }
  return levels;
}

export function sessionOf(sessionId: KillzoneId): KillzoneSessionDef {
  const session = KILLZONE_SESSIONS.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new Error(`session levels: unknown session ${sessionId}`);
  return session;
}

export function rangeColor(range: Range, colors: RangeColors = DEFAULT_RANGE_COLORS): string {
  return colors[colorKeyOf(range)];
}

export function shadeOf(range: Range, colors: RangeColors = DEFAULT_RANGE_COLORS): string {
  return withAlpha(rangeColor(range, colors), SHADE_ALPHA);
}

export function textOffsetFor(side: LevelSide): number {
  return side === "high" ? -TEXT_LIFT_PX : TEXT_LIFT_PX;
}

export function sharesPriceWithEarlier(level: Level, levels: readonly Level[]): boolean {
  return levels.some((other) => other.range !== level.range && other.range.sessionId === level.range.sessionId && other.side === level.side && other.price === level.price && other.range.endMs < level.range.endMs);
}

export function labelSpans(ranges: readonly Range[], barMs: number): Map<Range, readonly [number, number]> {
  const spans = new Map<Range, readonly [number, number]>();
  for (const range of ranges) {
    let from = range.startMs;
    for (const other of ranges) {
      if (other === range || other.sessionId !== range.sessionId || other.endMs >= range.endMs) continue;
      from = Math.max(from, other.endMs + barMs);
    }
    spans.set(range, [from, range.endMs + barMs]);
  }
  return spans;
}

function sideLetter(level: Level): string {
  return level.side === "high" ? "H" : "L";
}

export function levelName(level: Level): string {
  const name = level.range.kind === "orb" ? `ORB${level.range.windowMin}` : sessionOf(level.range.sessionId).label;
  return `${name}.${sideLetter(level)}`;
}

export function levelKey(level: Level): string {
  const { range } = level;
  return `${range.sessionId}:${range.kind === "orb" ? range.windowMin : "s"}:${range.startMs}:${level.side}`;
}

const VERDICT_WORDS: Record<Verdict, string> = {
  held: "Liquidity sweep",
  absorbed: "Absorbed",
  swept: "Liquidity sweep",
  weakBreak: "Weak break",
  strongBreak: "Strong break",
};

export function readsAsSweep(verdict: Verdict | null | undefined): boolean {
  return verdict === "swept" || verdict === "held";
}

function amount(size: number, unit: string): string {
  return `${formatLiquiditySize(size) || "0"} ${unit}`;
}

function traded(level: Level, read: WindowFacts, unit: string): string {
  const [attack, defence] = level.side === "high" ? ["bought", "sold"] : ["sold", "bought"];
  return `${amount(read.through, unit)} ${attack} / ${formatLiquiditySize(read.against) || "0"} ${defence}`;
}

function facts(level: Level, status: LevelStatus | null, unit: string): string[] {
  if (status === null) return [];
  const window = status.window;
  if (window === null) return status.peak > 0 ? [`resting ${amount(status.resting, unit)}`] : [];
  if (window.open) return ["Testing"];
  const verdict = shownVerdict(window);
  if (verdict === null) return ["no book"];
  if (window.noBook) return [verdict === "weakBreak" || verdict === "strongBreak" ? "Break" : VERDICT_WORDS[verdict]];
  return [VERDICT_WORDS[verdict], traded(level, window.facts, unit)];
}

export function describeSource(status: LevelStatus | null): string | null {
  const window = status?.window ?? null;
  if (window === null || window.open || window.verdict !== null || shownVerdict(window) === null) return null;
  if (window.noBook) return "Label from the candles alone: no book at this touch";
  if (window.bookGap) return "Label from an incomplete book: a hole inside this window";
  return `Label from an incomplete book: ${Math.round((100 * window.facts.captured) / window.facts.expected)}% of the traded volume`;
}

export function describeLevel(level: Level, status: LevelStatus | null, unit: string): string {
  return [levelName(level), ...facts(level, status, unit)].join(" · ");
}

export function shortenLevel(level: Level, status: LevelStatus | null, unit: string): string[] {
  const name = levelName(level);
  const parts = facts(level, status, unit);
  const forms: string[] = [];
  for (let keep = parts.length - 1; keep >= 1; keep -= 1) forms.push([name, ...parts.slice(0, keep)].join(" · "));
  if (parts.length > 0) forms.push(name);
  forms.push("");
  return forms;
}
