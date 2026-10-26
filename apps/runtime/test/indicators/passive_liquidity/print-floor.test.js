"use strict";

const { createPrintFloor } = require("../../../src/indicators/passive_liquidity/print-floor");

function bruteFloor(sizes, window, share, minSamples) {
  const recent = sizes.slice(-window);
  if (recent.length < minSamples) return 0;
  const sorted = recent.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * (1 - share)) - 1));
  return sorted[index];
}

describe("print-floor", () => {
  test("argument checks", () => {
    expect(() => createPrintFloor({ window: 0, share: 0.1, minSamples: 1 })).toThrow(/window/);
    expect(() => createPrintFloor({ window: 10, share: 1, minSamples: 1 })).toThrow(/share/);
    expect(() => createPrintFloor({ window: 10, share: 0.1, minSamples: 0 })).toThrow(/minSamples/);
  });

  test("is 0 until enough prints have been seen, then the size only the top share of the window reaches, the oldest forgotten", () => {
    const floor = createPrintFloor({ window: 100, share: 0.1, minSamples: 50 });
    for (let i = 1; i <= 49; i += 1) floor.push(i);
    expect(floor.value()).toBe(0);
    floor.push(50);
    expect(floor.value()).toBe(45);
    for (let i = 1; i <= 100; i += 1) floor.push(1000 + i);
    expect(floor.value()).toBe(1090);
  });

  test("matches a sort of the window after every print, duplicates and all", () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const window = 64;
    const share = 0.25;
    const minSamples = 10;
    const floor = createPrintFloor({ window, share, minSamples });
    const sizes = [];
    for (let i = 0; i < 600; i += 1) {
      const size = Math.floor(random() * 50);
      sizes.push(size);
      floor.push(size);
      expect(floor.value()).toBe(bruteFloor(sizes, window, share, minSamples));
    }
  });
});
