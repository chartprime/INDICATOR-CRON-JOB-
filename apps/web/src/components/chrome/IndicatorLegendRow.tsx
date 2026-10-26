function EyeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
      <path
        d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2.1" fill="currentColor" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
      <path
        d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2.1" fill="currentColor" />
      <path d="M2 14 14 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.6" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M8 1v2M8 13v2M15 8h-2M3 8H1M12.8 3.2l-1.4 1.4M4.6 11.4l-1.4 1.4M12.8 12.8l-1.4-1.4M4.6 4.6 3.2 3.2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
      <path
        d="M2 4h12M6 4V2h4v2M3.4 4l.7 9.4c.04.6.55 1 1.1 1h5.6c.55 0 1.06-.4 1.1-1L12.6 4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface IndicatorLegendRowProps {
  label: string;
  detail?: string;
  visible: boolean;
  onToggleVisible: () => void;
  onOpenSettings?: () => void;
  onRemove: () => void;
}

export function IndicatorLegendRow({
  label,
  detail,
  visible,
  onToggleVisible,
  onOpenSettings,
  onRemove,
}: IndicatorLegendRowProps) {
  return (
    <div className={`indicator-legend-row${visible ? "" : " indicator-legend-row-hidden"}`}>
      <span className="indicator-legend-label">{label}</span>
      {detail && <span className="indicator-legend-detail tabular">{detail}</span>}
      <div className="indicator-legend-actions">
        <button
          type="button"
          className="indicator-legend-icon"
          onClick={onToggleVisible}
          aria-pressed={visible}
          aria-label={visible ? "Hide indicator" : "Show indicator"}
          title={visible ? "Hide" : "Show"}
        >
          {visible ? <EyeIcon /> : <EyeOffIcon />}
        </button>
        {onOpenSettings && (
          <button
            type="button"
            className="indicator-legend-icon"
            onClick={onOpenSettings}
            aria-label="Indicator settings"
            title="Settings"
          >
            <GearIcon />
          </button>
        )}
        <button
          type="button"
          className="indicator-legend-icon"
          onClick={onRemove}
          aria-label="Remove indicator"
          title="Remove"
        >
          <TrashIcon />
        </button>
      </div>
    </div>
  );
}
