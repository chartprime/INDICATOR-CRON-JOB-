import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { InstrumentGroup, InstrumentOption } from "../../lib/chart/instruments";
import { identitiesMatch, type FrameIdentity } from "../../types/frames";

interface SymbolMenuProps {
  instruments: readonly InstrumentOption[];
  activeSymbol: string;
  activeIdentity: FrameIdentity;
  disabled: boolean;
  onSelect: (symbol: string, identity: FrameIdentity) => void;
}

const GROUP_ORDER: readonly InstrumentGroup[] = ["Crypto", "Futures", "Equities"];

function isActiveInstrument(option: InstrumentOption, symbol: string, identity: FrameIdentity): boolean {
  return option.symbol === symbol && identitiesMatch(option.identity, identity);
}

export function SymbolMenu({ instruments, activeSymbol, activeIdentity, disabled, onSelect }: SymbolMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const activeOption = instruments.find((option) => isActiveInstrument(option, activeSymbol, activeIdentity));
  const activeIndexRef = useRef(-1);
  activeIndexRef.current = instruments.findIndex((option) => isActiveInstrument(option, activeSymbol, activeIdentity));

  const closeMenu = () => {
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!isOpen) return;
    const activeIndex = activeIndexRef.current;
    optionRefs.current[activeIndex >= 0 ? activeIndex : 0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
        return;
      }
      if (event.key === "Tab") {
        const focusable = optionRefs.current.filter((element): element is HTMLButtonElement => element !== null);
        if (focusable.length === 0) {
          event.preventDefault();
          return;
        }
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
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  useEffect(() => {
    if (disabled) setIsOpen(false);
  }, [disabled]);

  function moveFocus(fromIndex: number, delta: number): void {
    const count = instruments.length;
    optionRefs.current[(fromIndex + delta + count) % count]?.focus();
  }

  function onOptionKeyDown(index: number) {
    return (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        moveFocus(index, 1);
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        moveFocus(index, -1);
      } else if (event.key === "Home") {
        event.preventDefault();
        optionRefs.current[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        optionRefs.current[instruments.length - 1]?.focus();
      }
    };
  }

  function handleSelect(option: InstrumentOption): void {
    onSelect(option.symbol, option.identity);
    closeMenu();
  }

  let flatIndex = -1;

  return (
    <div className="symbol-menu">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        className={`tf-pill symbol-menu-trigger${isOpen ? " active" : ""}`}
        onClick={() => setIsOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label="Select instrument"
      >
        {activeOption?.label ?? activeSymbol}
        <span className="symbol-menu-caret" aria-hidden="true">▾</span>
      </button>
      {isOpen && (
        <>
          <div className="menu-backdrop" onClick={closeMenu} aria-hidden="true" />
          <div className="symbol-menu-popover" role="listbox" aria-label="Instruments">
            {GROUP_ORDER.map((group) => {
              const groupInstruments = instruments.filter((option) => option.group === group);
              if (groupInstruments.length === 0) return null;
              return (
                <div key={group} className="symbol-menu-group" role="group" aria-label={group}>
                  <div className="menu-popover-title">{group}</div>
                  {groupInstruments.map((option) => {
                    flatIndex += 1;
                    const index = flatIndex;
                    const isActive = isActiveInstrument(option, activeSymbol, activeIdentity);
                    return (
                      <button
                        key={`${option.symbol}-${option.label}`}
                        ref={(node) => {
                          optionRefs.current[index] = node;
                        }}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        tabIndex={isActive ? 0 : -1}
                        className={`symbol-menu-option${isActive ? " active" : ""}`}
                        onClick={() => handleSelect(option)}
                        onKeyDown={onOptionKeyDown(index)}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
