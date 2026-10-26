import type { BoxHandle } from "../../chart/draw/box";
import type { LineHandle } from "../../chart/draw/line";
import type { OrderBlock, OrderBlockSettings } from "./orderBlockRules";

export const PRIMARY_FILL_ALPHA = 0.3;
export const SECONDARY_FILL_ALPHA = 0.1;
export const MITIGATED_FILL_ALPHA = 0.15;
export const CARD_FILL = "rgba(15, 23, 42, 0.88)";
export const CARD_TEXT = "#cbd5e1";

export function withAlpha(color: string, alpha: number): string {
  const hex = color.startsWith("#") ? color.slice(1) : null;
  if (hex === null || (hex.length !== 3 && hex.length !== 6)) return color;
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) return color;
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

export function isShown(
  block: OrderBlock,
  settings: OrderBlockSettings,
): boolean {
  if (block.tier === "secondary" && !settings.showSecondary) return false;
  if (block.mitigatedTime !== null && !settings.showMitigated) return false;
  return true;
}

function hide(slot: BoxHandle): void {
  slot.setLeftTop(0, 0);
  slot.setRightBottom(0, 0);
  slot.setBorderColor("transparent");
  slot.setBackgroundColor("transparent");
}

function hideLine(line: LineHandle): void {
  line.setXY1(0, 0);
  line.setXY2(0, 0);
  line.setColor("transparent");
}

export function renderOrderBlocks(
  slots: readonly BoxHandle[],
  middleLines: readonly LineHandle[],
  activeBlocks: readonly OrderBlock[],
  mitigatedBlocks: readonly OrderBlock[],
  settings: OrderBlockSettings,
  currentTime: number,
): void {
  const filteredActive = activeBlocks.filter((block) =>
    block.tier === "secondary" ? settings.showSecondary : true,
  );
  const filteredMitigated = mitigatedBlocks.filter((block) =>
    block.tier === "secondary" ? settings.showSecondary : true,
  );

  const activeVisible = filteredActive.slice(-settings.maxBlocks);
  const mitigatedVisible = settings.showMitigated
    ? filteredMitigated.slice(-(slots.length - activeVisible.length))
    : [];

  const visible = [...activeVisible, ...mitigatedVisible];

  const maxActiveVolume =
    activeVisible.length > 0
      ? Math.max(...activeVisible.map((b) => b.volume))
      : 1;

  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const line = middleLines[index];
    const block = visible[index];
    if (block === undefined) {
      hide(slot);
      if (line) hideLine(line);
      continue;
    }
    const color =
      block.side === "bullish" ? settings.bullishColor : settings.bearishColor;
    const mitigated = block.mitigatedTime !== null;
    slot.setLeftTop(block.pivotTime, block.top);
    slot.setRightBottom(block.mitigatedTime ?? currentTime, block.bottom);
    if (block.tier === "primary" && !mitigated) {
      slot.setBorderColor("transparent");
      const pct =
        maxActiveVolume > 0
          ? Math.round((block.volume / maxActiveVolume) * 100)
          : 0;
      const volText = `${pct}%`;
      const prefix = block.side === "bullish" ? "Bull OB" : "Bear OB";
      slot.setText(`${prefix} | ${volText}`);
      slot.setTextColor(CARD_TEXT);
      slot.setTextBackground(CARD_FILL);
      slot.setTextAccent("");
      slot.setTailFade(true);
      if (line) {
        const midPrice = (block.top + block.bottom) / 2;
        line.setXY1(block.pivotTime, midPrice);
        line.setXY2(block.mitigatedTime ?? currentTime, midPrice);
        line.setColor(color);
        line.setStyle("dashed");
        line.setWidth(1);
      }
    } else if (block.tier === "secondary" && !mitigated) {
      slot.setBorderColor(
        mitigated ? "transparent" : withAlpha(color, PRIMARY_FILL_ALPHA),
      );
      const pct =
        maxActiveVolume > 0
          ? Math.round((block.volume / maxActiveVolume) * 100)
          : 0;
      const volText = `${pct}%`;
      slot.setText(volText);
      slot.setTextColor(CARD_TEXT);
      slot.setTextBackground(CARD_FILL);
      slot.setTextAccent("");
      slot.setTailFade(false);
      if (line) hideLine(line);
    } else {
      slot.setBorderColor(
        mitigated ? "transparent" : withAlpha(color, PRIMARY_FILL_ALPHA),
      );
      slot.setText("");
      slot.setTextBackground("");
      slot.setTextAccent("");
      slot.setTailFade(false);
      if (line) hideLine(line);
    }
    slot.setBackgroundColor(
      withAlpha(
        color,
        mitigated
          ? MITIGATED_FILL_ALPHA
          : block.tier === "primary"
            ? PRIMARY_FILL_ALPHA
            : SECONDARY_FILL_ALPHA,
      ),
    );
  }
}
