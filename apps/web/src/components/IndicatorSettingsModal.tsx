import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { IndicatorPresetsMenu, type IndicatorPresetsProps } from "./IndicatorPresetsMenu";

function placeWithinViewport(modal: HTMLDivElement, left: number, top: number) {
  const { width, height } = modal.getBoundingClientRect();
  modal.style.left = `${Math.max(0, Math.min(left, window.innerWidth - width))}px`;
  modal.style.top = `${Math.max(0, Math.min(top, window.innerHeight - height))}px`;
  modal.style.transform = "none";
}

interface IndicatorSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  ariaLabel: string;
  children: ReactNode;
  footerStart?: ReactNode;
  presets?: IndicatorPresetsProps;
}

export function IndicatorSettingsModal({ isOpen, onClose, title, ariaLabel, children, footerStart, presets }: IndicatorSettingsModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  function onDragStart(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || dragRef.current !== null || !modalRef.current) return;
    const rect = modalRef.current.getBoundingClientRect();
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    placeWithinViewport(modalRef.current, rect.left, rect.top);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onDragMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !modalRef.current) return;
    placeWithinViewport(modalRef.current, drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
  }

  function onDragEnd(event: ReactPointerEvent<HTMLButtonElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function onMoveKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const delta = event.shiftKey ? 1 : 20;
    const movement: Record<string, [number, number]> = {
      ArrowLeft: [-delta, 0],
      ArrowRight: [delta, 0],
      ArrowUp: [0, -delta],
      ArrowDown: [0, delta],
    };
    const step = movement[event.key];
    if (!step || !modalRef.current) return;
    event.preventDefault();
    const rect = modalRef.current.getBoundingClientRect();
    placeWithinViewport(modalRef.current, rect.left + step[0], rect.top + step[1]);
  }

  useEffect(() => {
    if (!isOpen) return;
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!modalRef.current?.contains(document.activeElement)) {
      modalRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    }
    return () => {
      if (previouslyFocusedRef.current?.isConnected) previouslyFocusedRef.current.focus();
      previouslyFocusedRef.current = null;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onResize = () => {
      const modal = modalRef.current;
      if (modal?.style.transform !== "none") return;
      const rect = modal.getBoundingClientRect();
      placeWithinViewport(modal, rect.left, rect.top);
    };
    window.addEventListener("resize", onResize);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
    if (modalRef.current) observer?.observe(modalRef.current);
    return () => {
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
      dragRef.current = null;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "Tab") {
        const focusable = [...(modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [])].filter((element) => !element.hasAttribute("hidden"));
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
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <>
      <div className="menu-backdrop modal-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={modalRef}
        className="indicator-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={titleId}
      >
        <div className="indicator-settings-header">
          <button
            type="button"
            className="indicator-settings-drag-handle"
            aria-label={`Move ${title} settings panel`}
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            onKeyDown={onMoveKeyDown}
          >
            <span id={titleId}>{title}</span>
          </button>
          <button type="button" className="indicator-settings-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        {children}
        <div className="indicator-settings-footer">
          {(footerStart !== undefined || presets !== undefined) && (
            <div className="indicator-settings-footer-start">
              {footerStart}
              {presets !== undefined && <IndicatorPresetsMenu {...presets} />}
            </div>
          )}
          <button type="button" className="indicator-settings-ok" onClick={onClose}>
            Ok
          </button>
        </div>
      </div>
    </>
  );
}
