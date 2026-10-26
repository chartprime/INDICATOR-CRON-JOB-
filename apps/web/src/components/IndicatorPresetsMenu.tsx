import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  MAX_PRESETS_PER_INDICATOR,
  MAX_PRESET_NAME_LENGTH,
  indicatorPresets,
  isPresetName,
  type Preset,
  type PresetParams,
  type PresetStore,
  useIndicatorPresets,
} from "../lib/chart/indicatorPresets";
import { activePreset, appliedPreset, presetParamsOf } from "../lib/chart/presetFields";
import type { SettingsFieldSchema } from "../lib/chart/indicatorTypes";

export interface IndicatorPresetsProps {
  presetKey: string;
  params: PresetParams;
  schema: readonly SettingsFieldSchema<any>[];
  defaults: PresetParams;
  onApply: (params: PresetParams) => void;
  onReset: () => void;
  store?: PresetStore;
}

const MENU_GAP_PX = 4;
const SAVE_ERRORS = {
  full: `Up to ${MAX_PRESETS_PER_INDICATOR} presets per indicator`,
  "not-written": "Could not save the preset",
} as const;

function placeMenu(button: HTMLElement, menu: HTMLElement) {
  const anchor = button.getBoundingClientRect();
  const { width, height } = menu.getBoundingClientRect();
  const below = anchor.bottom + MENU_GAP_PX;
  const fitsBelow = below + height <= window.innerHeight || anchor.top - MENU_GAP_PX - height < 0;
  menu.style.top = `${Math.max(0, fitsBelow ? below : anchor.top - MENU_GAP_PX - height)}px`;
  menu.style.left = `${Math.max(0, Math.min(anchor.left, window.innerWidth - width))}px`;
}

export function IndicatorPresetsMenu({ presetKey, params, schema, defaults, onApply, onReset, store = indicatorPresets }: IndicatorPresetsProps) {
  const presets = useIndicatorPresets(presetKey, store);
  const [isOpen, setIsOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const saveItemRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const active = activePreset(presets, schema, params, defaults);

  function close() {
    setIsOpen(false);
    setNaming(false);
    setName("");
    setInvalid(false);
    setError(null);
    buttonRef.current?.focus();
  }

  function toggle() {
    if (isOpen) {
      close();
      return;
    }
    setContainer(buttonRef.current?.closest(".indicator-settings-modal")?.parentElement ?? document.body);
    setIsOpen(true);
  }

  function reset() {
    onReset();
    close();
  }

  function apply(preset: Preset) {
    onApply(appliedPreset(schema, preset, params, defaults));
    close();
  }

  async function remove(preset: Preset) {
    saveItemRef.current?.focus({ preventScroll: true });
    const removed = await store.remove(presetKey, preset.name);
    setError(removed ? null : "Could not delete the preset");
  }

  async function save() {
    if (!isPresetName(name)) {
      setInvalid(true);
      return;
    }
    saveItemRef.current?.focus();
    setNaming(false);
    setName("");
    setInvalid(false);
    setError(null);
    const outcome = await store.save(presetKey, name, presetParamsOf(schema, params, defaults));
    if (outcome !== "saved") setError(SAVE_ERRORS[outcome]);
  }

  function onNameKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void save();
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const focusable = [...(menuRef.current?.querySelectorAll<HTMLElement>("button, input") ?? [])];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  useLayoutEffect(() => {
    if (isOpen && buttonRef.current && menuRef.current) placeMenu(buttonRef.current, menuRef.current);
  }, [isOpen, naming, presets.length, error]);

  useEffect(() => {
    if (!isOpen) return;
    menuRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setIsOpen(false);
      setNaming(false);
      setName("");
      setInvalid(false);
      setError(null);
    };
    const onResize = () => {
      if (buttonRef.current && menuRef.current) placeMenu(buttonRef.current, menuRef.current);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onResize);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setName("");
      setInvalid(false);
      if (naming) {
        setNaming(false);
        saveItemRef.current?.focus();
        return;
      }
      setIsOpen(false);
      setError(null);
      buttonRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isOpen, naming]);

  useEffect(() => {
    if (naming) menuRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [naming]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="indicator-settings-defaults"
        title={active?.name}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        onClick={toggle}
      >
        <span className="indicator-settings-defaults-label">{active?.name ?? "Defaults"}</span> <span aria-hidden="true">▾</span>
      </button>
      {isOpen && container !== null && createPortal(
        <div ref={menuRef} id={menuId} className="indicator-presets-menu" role="dialog" aria-label="Defaults" tabIndex={-1} onKeyDown={onMenuKeyDown}>
          <button type="button" className="indicator-presets-item" onClick={reset}>
            Reset settings
          </button>
          <div className="indicator-presets-separator" role="separator" />
          <button ref={saveItemRef} type="button" className="indicator-presets-item" onClick={() => setNaming(true)}>
            Save as preset…
          </button>
          {naming && (
            <div className="indicator-presets-name">
              <input
                type="text"
                aria-label="Preset name"
                aria-invalid={invalid}
                className={invalid ? "is-invalid" : undefined}
                placeholder="Preset name"
                maxLength={MAX_PRESET_NAME_LENGTH}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setInvalid(false);
                }}
                onKeyDown={onNameKeyDown}
              />
              <button type="button" onClick={() => void save()}>Save</button>
            </div>
          )}
          {error !== null && <p className="indicator-presets-error" role="alert">{error}</p>}
          {presets.length > 0 && (
            <>
              <div className="indicator-presets-heading">Presets</div>
              {presets.map((preset) => (
                <div key={preset.name} className="indicator-presets-row">
                  <button
                    type="button"
                    className={preset === active ? "indicator-presets-item is-active" : "indicator-presets-item"}
                    aria-current={preset === active ? "true" : undefined}
                    title={preset.name}
                    onClick={() => apply(preset)}
                  >
                    {preset.name}
                  </button>
                  <button
                    type="button"
                    className="indicator-presets-delete"
                    aria-label={`Delete preset ${preset.name}`}
                    onClick={() => void remove(preset)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </>
          )}
        </div>,
        container,
      )}
    </>
  );
}
