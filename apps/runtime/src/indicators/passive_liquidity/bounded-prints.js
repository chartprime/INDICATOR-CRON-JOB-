"use strict";

function floorAbove(size) {
  return size + Number.EPSILON * Math.max(1, size);
}

function selectPrintsWithFloor(prints, floor, maxPrints) {
  const ranked = prints.filter((print) => print.size >= floor).sort((a, b) => b.size - a.size || a.ts - b.ts);
  if (ranked.length <= maxPrints) return { prints: ranked.sort((a, b) => a.ts - b.ts), floor };
  let count = 0;
  while (count < ranked.length) {
    let end = count + 1;
    while (end < ranked.length && ranked[end].size === ranked[count].size) end += 1;
    if (end > maxPrints) break;
    count = end;
  }
  if (count === 0) {
    const maxSize = ranked[0].size;
    return { prints: [], floor: Math.max(floor, floorAbove(maxSize)) };
  }
  return { prints: ranked.slice(0, count).sort((a, b) => a.ts - b.ts), floor: Math.max(floor, ranked[count - 1].size) };
}

module.exports = { floorAbove, selectPrintsWithFloor };
