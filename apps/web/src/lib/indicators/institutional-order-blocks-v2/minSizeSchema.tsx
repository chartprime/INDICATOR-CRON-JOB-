import type { FrameIdentity } from "../../../types/frames";
import type { SettingsFieldSchema } from "../../chart/indicatorTypes";
import { MinSizeField } from "./MinSizeField";
import { isMinSizeByInstrument, type InstitutionalV2Settings } from "./institutionalV2Rules";

export function minSizeField(identity: ({ symbol: string } & FrameIdentity) | null): SettingsFieldSchema<InstitutionalV2Settings> {
  return {
    kind: "custom",
    key: "minSizeByInstrument",
    affects: "recompute",
    isValidPersistedValue: isMinSizeByInstrument,
    byInstrument: true,
    render: (settings, onChange) => <MinSizeField identity={identity} settings={settings} onChange={onChange} />,
  };
}
