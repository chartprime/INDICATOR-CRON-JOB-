import { useLayoutEffect, useState } from "react";
import type { FrameIdentity } from "../../../types/frames";
import { instrumentKey } from "../../chart/drawingStore";
import { minSizeFor, sizeUnitFor, type InstitutionalV2Settings } from "./institutionalV2Rules";

type Identity = { symbol: string } & FrameIdentity;

function typedSize(raw: string): number | null {
  return /^\d+$/.test(raw.trim()) && Number(raw) > 0 ? Number(raw) : null;
}
export function MinSizeField({ identity, settings, onChange }: { identity: Identity | null; settings: InstitutionalV2Settings; onChange: (next: InstitutionalV2Settings) => void }) {
  const key = identity === null ? null : instrumentKey(identity);
  const inForce = identity === null || key === null ? null : (settings.minSizeByInstrument[key] ?? minSizeFor(identity));
  const [buffer, setBuffer] = useState(inForce === null ? "" : String(inForce));
  useLayoutEffect(() => {
    setBuffer(inForce === null ? "" : String(inForce));
  }, [inForce]);
  const store = (next: Record<string, number>) => onChange({ ...settings, minSizeByInstrument: next });
  return (
    <label className="indicator-settings-field">
      <span>Hide OBs Under</span>
      <span className="indicator-settings-with-unit">
        <input
          type="text"
          inputMode="numeric"
          disabled={key === null}
          value={buffer}
          onChange={(event) => {
            const raw = event.target.value;
            setBuffer(raw);
            if (key === null) return;
            const size = typedSize(raw);
            const rest = Object.fromEntries(Object.entries(settings.minSizeByInstrument).filter(([k]) => k !== key));
            if (size !== null) store({ ...rest, [key]: size });
            else if (raw.trim() === "") store(rest);
          }}
          onBlur={() => setBuffer(inForce === null ? "" : String(inForce))}
        />
        {identity === null ? null : <span className="indicator-settings-unit">{sizeUnitFor(identity)}</span>}
      </span>
    </label>
  );
}
