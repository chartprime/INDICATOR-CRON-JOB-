import { IndicatorSettingsModal } from "../../../components/IndicatorSettingsModal";
import { presetKeyFor, type PresetParams } from "../../chart/indicatorPresets";
import { KILLZONE_SESSIONS, type KillzoneId } from "./killzones";
import { DEFAULT_SESSIONS, KILLZONES_PRESET_SCHEMA } from "./killzonesPresets";

interface KillzonesSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  selectedSessions: ReadonlySet<KillzoneId>;
  onSessionChange: (sessionId: KillzoneId, selected: boolean) => void;
  presetScope?: string;
}

export function KillzonesSettingsModal({
  isOpen,
  onClose,
  visible,
  onVisibleChange,
  selectedSessions,
  onSessionChange,
  presetScope,
}: KillzonesSettingsModalProps) {
  function selectSessions(sessions: readonly unknown[]) {
    for (const session of KILLZONE_SESSIONS) onSessionChange(session.id, sessions.includes(session.id));
  }

  function handleReset() {
    selectSessions(DEFAULT_SESSIONS);
    onVisibleChange(true);
  }

  function applyPreset(params: PresetParams) {
    selectSessions([...(params.sessions as ReadonlySet<unknown>)]);
  }

  return (
    <IndicatorSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="ICT Killzones"
      ariaLabel="ICT Killzones settings"
      presets={{
        presetKey: presetKeyFor("killzones", presetScope),
        params: { sessions: KILLZONE_SESSIONS.filter((session) => selectedSessions.has(session.id)).map((session) => session.id) },
        schema: KILLZONES_PRESET_SCHEMA,
        defaults: { sessions: new Set(DEFAULT_SESSIONS) },
        onApply: applyPreset,
        onReset: handleReset,
      }}
    >
      <div className="indicator-settings-body">
        <label className="indicator-settings-checkbox">
          <input type="checkbox" checked={visible} onChange={(event) => onVisibleChange(event.target.checked)} />
          <span>Show on chart</span>
        </label>
        <fieldset className="indicator-settings-session-list">
          <legend>Sessions (New York time)</legend>
          {KILLZONE_SESSIONS.map((session) => (
            <label key={session.id} className="indicator-settings-checkbox">
              <input
                type="checkbox"
                checked={selectedSessions.has(session.id)}
                onChange={(event) => onSessionChange(session.id, event.target.checked)}
              />
              <span>{session.label}</span>
            </label>
          ))}
        </fieldset>
        <p className="indicator-settings-hint">Shown on chart timeframes up to 30 minutes.</p>
      </div>
    </IndicatorSettingsModal>
  );
}
