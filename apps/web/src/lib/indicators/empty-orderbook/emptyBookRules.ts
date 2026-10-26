import { minMoveOf, type Identity, type Sensitivity } from "../liquidity-voids/liquidityVoidsRules";
import { DEFAULT_EMPTY_BOOK_RULES, type BandSizes, type EmptyBookRules } from "./emptyBookModel";

export const MIN_ZONE_ROWS = 2;

export function minRowsOf(settings: { sensitivity: Sensitivity }, identity: Identity, price: number, intervalMs: number, rowWidth: number, clusterRows: number): number {
  const height = rowWidth * clusterRows;
  if (!(height > 0)) return MIN_ZONE_ROWS;
  return Math.max(MIN_ZONE_ROWS, Math.round(minMoveOf(settings, identity, price, intervalMs) / height));
}

export function emptyBookRulesFor(clusterRows: number, minRows: number, bandSizes: BandSizes, clearRows: number = DEFAULT_EMPTY_BOOK_RULES.clearRows, thinShare: number = DEFAULT_EMPTY_BOOK_RULES.thinShare, refillMultiple: number = DEFAULT_EMPTY_BOOK_RULES.refillMultiple): EmptyBookRules {
  const clear = Number.isFinite(clearRows) ? Math.max(0, Math.floor(clearRows)) : DEFAULT_EMPTY_BOOK_RULES.clearRows;
  const thin = Number.isFinite(thinShare) && thinShare > 0 ? thinShare : DEFAULT_EMPTY_BOOK_RULES.thinShare;
  const refill = Math.max(thin, Number.isFinite(refillMultiple) ? refillMultiple : DEFAULT_EMPTY_BOOK_RULES.refillMultiple);
  return { ...DEFAULT_EMPTY_BOOK_RULES, clusterRows: Math.max(1, Math.floor(clusterRows)), minRows: Math.max(1, Math.floor(minRows)), bandSizes, clearRows: clear, thinShare: thin, refillMultiple: refill };
}
