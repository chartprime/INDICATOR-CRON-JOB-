import type { SettingsFieldSchema } from "../../chart/indicatorTypes";
import { KILLZONE_SESSIONS, type KillzoneId } from "./killzones";

export const DEFAULT_SESSIONS: readonly KillzoneId[] = KILLZONE_SESSIONS.filter((session) => session.defaultShown).map((session) => session.id);

export const KILLZONES_PRESET_SCHEMA: readonly SettingsFieldSchema<{ sessions: readonly KillzoneId[] }>[] = [
  { kind: "checkboxList", key: "sessions", label: "Sessions", options: KILLZONE_SESSIONS.map((session) => ({ value: session.id, label: session.label })), affects: "recompute" },
];
