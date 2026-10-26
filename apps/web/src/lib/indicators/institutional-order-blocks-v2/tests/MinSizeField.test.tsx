// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FrameIdentity } from "../../../../types/frames";
import { instrumentKey } from "../../../chart/drawingStore";
import { MinSizeField } from "../MinSizeField";
import { DEFAULT_INSTITUTIONAL_V2_SETTINGS, type InstitutionalV2Settings } from "../institutionalV2Rules";

const eth: { symbol: string } & FrameIdentity = { provider: "BINANCE", symbol: "ETH-USDT", marketKind: "PERPETUAL" };
const btc: { symbol: string } & FrameIdentity = { provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL" };

describe("MinSizeField", () => {
  let container: HTMLDivElement;
  let root: Root;
  let settings: InstitutionalV2Settings;
  const onChange = (next: InstitutionalV2Settings) => {
    settings = next;
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    settings = DEFAULT_INSTITUTIONAL_V2_SETTINGS;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(identity: ({ symbol: string } & FrameIdentity) | null, current = settings) {
    act(() => {
      root.render(<MinSizeField identity={identity} settings={current} onChange={onChange} />);
    });
  }

  const input = () => container.querySelector<HTMLInputElement>("input")!;
  const type = (text: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input(), text);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("shows the floor in force with the instrument's unit beside it, and no spinner: a size to type, not a count to step", () => {
    render(eth);
    expect(input().value).toBe("2400");
    expect(input().type).toBe("text");
    expect(input().inputMode).toBe("numeric");
    expect(container.querySelector(".indicator-settings-unit")?.textContent).toBe("ETH");
    expect(container.querySelector(".indicator-settings-field > span")?.textContent).toBe("Hide OBs Under");
  });

  it("stores a whole number typed for this instrument only, and shows it", () => {
    // The trader, 2026-09-20: "type 2500, it should read 2500 ETH and hide any wall resting smaller than 2500".
    render(eth);
    type("2500");
    expect(settings.minSizeByInstrument).toEqual({ [instrumentKey(eth)]: 2500 });
    render(eth);
    expect(input().value).toBe("2500");
    // The BTC perp still shows its own floor.
    render(btc);
    expect(input().value).toBe("150");
    expect(container.querySelector(".indicator-settings-unit")?.textContent).toBe("BTC");
  });

  it("stores nothing for a fraction, a negative, a zero or letters, and lets the box hold them while they are typed", () => {
    render(eth);
    for (const text of ["25.5", "-3", "0", "abc", ""]) {
      type(text);
      expect(settings.minSizeByInstrument).toEqual({});
      expect(input().value).toBe(text);
    }
  });

  it("clears the typed floor back to the instrument's default when the box is emptied, and shows the default again on leaving it", () => {
    render(eth, { ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, minSizeByInstrument: { [instrumentKey(eth)]: 2500, [instrumentKey(btc)]: 300 } });
    expect(input().value).toBe("2500");
    type("");
    expect(settings.minSizeByInstrument).toEqual({ [instrumentKey(btc)]: 300 });
    act(() => {
      input().dispatchEvent(new Event("blur", { bubbles: true }));
    });
    render(eth);
    expect(input().value).toBe("2400");
  });

  it("follows the instrument when the chart switches under an open panel", () => {
    render(eth);
    expect(input().value).toBe("2400");
    render(btc);
    expect(input().value).toBe("150");
  });

  it("is disabled with no unit where no instrument is known", () => {
    render(null);
    expect(input().disabled).toBe(true);
    expect(input().value).toBe("");
    expect(container.querySelector(".indicator-settings-unit")).toBeNull();
  });
});
