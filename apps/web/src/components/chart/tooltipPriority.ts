export interface TooltipPresence {
  whale: boolean;
  absorption: boolean;
  iceberg: boolean;
  exhaustion: boolean;
  initiative: boolean;
  bubble: boolean;
  wall: boolean;
  bookMap: boolean;
  whaleHeatmap: boolean;
  pivot: boolean;
  fvg: boolean;
  sessionLevel: boolean;
}

export function shownTooltips(present: TooltipPresence): TooltipPresence {
  return {
    whale: present.whale,
    absorption: present.absorption,
    iceberg: present.iceberg && !present.whale && !present.absorption,
    exhaustion: present.exhaustion && !present.whale && !present.absorption,
    initiative: present.initiative && !present.whale && !present.absorption,
    bubble: present.bubble,
    wall: present.wall,
    bookMap: present.bookMap && !present.wall && !present.fvg && !present.pivot && !present.sessionLevel && !present.whaleHeatmap,
    whaleHeatmap: present.whaleHeatmap && !present.wall && !present.fvg && !present.pivot && !present.sessionLevel,
    pivot: present.pivot && !present.whale,
    fvg: present.fvg && !present.whale && !present.wall && !present.absorption,
    sessionLevel: present.sessionLevel && !present.whale && !present.wall && !present.absorption && !present.bubble && !present.fvg,
  };
}
