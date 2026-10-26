import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { clampCardPosition, type CardPosition } from "./cardPosition";
import type { LiveRangeReport } from "./liveRangePrimitive";
import { ROW_SETTINGS, cardSizeOf, rowShownOf, tipsShownOf, zFromOf, type LiveRangeSettings } from "./liveRangeSettings";
import { headText, impactTip, rangeLine, rangeNote, rangeRows, verdictOf, zText, type Tone } from "./liveRangeWords";

export const DRAG_THRESHOLD_PX = 3;
export const TIP_GAP_PX = 14;
export const TIP_ROOM_PX = 110;

type TipSide = "buyers" | "sellers";

interface TipAt {
  side: TipSide;
  below: boolean;
  offset: number;
}

export interface CardPane {
  left: number;
  top: number;
  width: number;
  height: number;
}

function fitOf(position: CardPosition, pane: CardPane | null, card: HTMLDivElement | null): CardPosition | null {
  if (pane === null || card === null || !(pane.width > 0 && pane.height > 0 && card.offsetWidth > 0 && card.offsetHeight > 0)) return null;
  return clampCardPosition(position, { width: card.offsetWidth, height: card.offsetHeight }, pane);
}

type CardSettings = Pick<LiveRangeSettings, "bidColor" | "askColor" | "cardSize" | "verdictSensitivity" | "showVolumeRow" | "showDeltaRow" | "showPrintsRow" | "showMinutesRow" | "showImpactRow" | "showTips">;

interface LiveRangeCardProps {
  report: LiveRangeReport;
  settings: CardSettings;
  position?: CardPosition | null;
  paneOf?: () => CardPane | null;
  onMove?: (position: CardPosition) => void;
  onReset?: () => void;
}

function toneColor(tone: Tone, settings: Pick<LiveRangeSettings, "bidColor" | "askColor">): string | undefined {
  if (tone === "even") return undefined;
  return tone === "buyers" ? settings.bidColor : settings.askColor;
}

export function LiveRangeCard({ report, settings, position = null, paneOf, onMove, onReset }: LiveRangeCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; pointerX: number; pointerY: number; x: number; y: number } | null>(null);
  const [shift, setShift] = useState<{ dx: number; dy: number } | null>(null);
  const [fit, setFit] = useState<CardPosition | null>(null);
  const [tipAt, setTipAt] = useState<TipAt | null>(null);
  const { read, mode } = report;
  const tipsOn = tipsShownOf(settings) && rowShownOf(settings, "impact");
  if ((read === null || !tipsOn) && tipAt !== null) setTipAt(null);
  const tip = read === null || tipAt === null ? null : impactTip(read.impact, tipAt.side, report.prints?.unit ?? "");
  const since = rangeLine(mode, report.fromTs, report.toTs, report.live);
  const tableShown = ROW_SETTINGS.some(([row]) => rowShownOf(settings, row));
  const rows = read === null ? [] : rangeRows(read, report.prints).filter((row) => rowShownOf(settings, row.key));
  const note = rangeNote(read, mode, report.loading);
  const verdict = report.loading ? null : verdictOf(read, zFromOf(settings));
  const size = cardSizeOf(settings);
  const verdictColor = verdict?.key === "buyers" ? settings.bidColor : verdict?.key === "sellers" ? settings.askColor : undefined;

  function clamped(next: CardPosition): CardPosition {
    return fitOf(next, paneOf?.() ?? null, cardRef.current) ?? next;
  }

  useLayoutEffect(() => {
    if (position === null) {
      if (fit !== null) setFit(null);
      return;
    }
    const next = fitOf(position, paneOf?.() ?? null, cardRef.current);
    if (next === null) return;
    if (fit === null || fit.x !== next.x || fit.y !== next.y) setFit(next);
  }, [position, fit, paneOf, size]);

  const shown = position === null ? null : fit ?? position;

  function dragged(event: ReactPointerEvent<HTMLButtonElement>): CardPosition | null {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return null;
    return clamped({ x: drag.x + event.clientX - drag.pointerX, y: drag.y + event.clientY - drag.pointerY });
  }

  function onImpactMove(side: TipSide, event: ReactPointerEvent<HTMLTableCellElement>) {
    const card = cardRef.current;
    if (card === null) return;
    const y = event.clientY - card.getBoundingClientRect().top;
    const pane = paneOf?.() ?? null;
    const below = pane === null || event.clientY + TIP_ROOM_PX < pane.top + pane.height;
    const offset = below ? y + TIP_GAP_PX : card.offsetHeight - y + TIP_GAP_PX;
    if (tipAt !== null && tipAt.side === side && tipAt.below === below && tipAt.offset === offset) return;
    setTipAt({ side, below, offset });
  }

  function hoverOf(row: { key: string }, side: TipSide) {
    if (row.key !== "impact" || !tipsOn) return { className: "live-range-value tabular" };
    return {
      className: "live-range-value live-range-hover tabular",
      onPointerMove: (event: ReactPointerEvent<HTMLTableCellElement>) => onImpactMove(side, event),
      onPointerLeave: () => setTipAt(null),
    };
  }

  function released(event: ReactPointerEvent<HTMLButtonElement>) {
    dragRef.current = null;
    setShift(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function onGripDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || dragRef.current !== null || onMove === undefined) return;
    const pane = paneOf?.() ?? null;
    const card = cardRef.current;
    if (pane === null || card === null) return;
    const rect = card.getBoundingClientRect();
    dragRef.current = { pointerId: event.pointerId, pointerX: event.clientX, pointerY: event.clientY, x: rect.left - pane.left, y: rect.top - pane.top };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function onGripMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    const next = dragged(event);
    if (drag === null || next === null) return;
    setShift({ dx: next.x - drag.x, dy: next.y - drag.y });
  }

  function onGripUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    const next = dragged(event);
    if (drag === null || next === null) return;
    released(event);
    if (Math.hypot(event.clientX - drag.pointerX, event.clientY - drag.pointerY) < DRAG_THRESHOLD_PX) return;
    onMove?.(next);
  }

  function onGripCancel(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    released(event);
  }

  return (
    <div
      ref={cardRef}
      className="live-range-card"
      data-testid="live-range-card"
      data-placed={position === null ? undefined : "true"}
      data-size={size}
      style={{
        ...(shown === null ? {} : { left: shown.x, top: shown.y }),
        ...(shift === null ? {} : { transform: `translate(${shift.dx}px, ${shift.dy}px)` }),
      }}
    >
      <div className="candle-monitor-head">
        <button
          type="button"
          className="live-range-grip candle-monitor-title"
          aria-label="Move the card; double-click to put it back"
          title="Drag to move, double-click to put it back"
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripCancel}
          onDoubleClick={() => onReset?.()}
        >
          Live Range Control
        </button>
        <span className="candle-monitor-candle">{headText(mode)}</span>
      </div>
      <div className="live-range-sub live-range-since">{since}</div>
      {report.loading ? (
        <div className="live-range-sub live-range-loading" role="status" aria-label="Loading the hours of the range">
          <span className="live-range-spinner" />
          <span>loading</span>
        </div>
      ) : null}
      {verdict === null ? null : (
        <div className="live-range-verdict" data-verdict={verdict.key} style={{ color: verdictColor }}>
          <span className="live-range-verdict-text">{verdict.text}</span>
          {verdict.z === null ? null : <span className="live-range-verdict-z tabular">{zText(verdict.z)}</span>}
        </div>
      )}
      {tableShown ? (
        <table className="live-range-table">
          <colgroup>
            <col />
            <col className="live-range-col" />
            <col className="live-range-col" />
          </colgroup>
          <thead>
            <tr className="live-range-head">
              <th scope="col">Metric</th>
              <th scope="col" style={{ color: settings.bidColor }}>Buyers</th>
              <th scope="col" style={{ color: settings.askColor }}>Sellers</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="live-range-row" data-row={row.key}>
                <th scope="row">
                  <span className="live-range-label">{row.label}</span>
                </th>
                {row.joined === undefined ? (
                  <>
                    <td {...hoverOf(row, "buyers")} style={{ color: settings.bidColor }}>
                      {row.left}
                      {row.counts === undefined ? null : <span className="live-range-count">{row.counts.left}</span>}
                    </td>
                    <td {...hoverOf(row, "sellers")} style={{ color: settings.askColor }}>
                      {row.right}
                      {row.counts === undefined ? null : <span className="live-range-count">{row.counts.right}</span>}
                    </td>
                  </>
                ) : (
                  <td className="live-range-value live-range-joined tabular" colSpan={2} data-tone={row.joined.tone} style={{ color: toneColor(row.joined.tone, settings) }}>
                    {row.joined.text}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {note === null ? null : <div className="live-range-sub live-range-note">{note}</div>}
      {tip === null || tipAt === null ? null : (
        <div className="live-range-tip" role="tooltip" data-side={tipAt.side} style={tipAt.below ? { top: tipAt.offset } : { bottom: tipAt.offset }}>
          <div className="live-range-tip-title" style={{ color: tipAt.side === "buyers" ? settings.bidColor : settings.askColor }}>
            {tip.title}
          </div>
          {tip.lines.map((line) => (
            <div key={line} className="live-range-tip-line">
              {line}
            </div>
          ))}
          {tip.reading === null ? null : <div className="live-range-tip-reading">{tip.reading}</div>}
        </div>
      )}
    </div>
  );
}
