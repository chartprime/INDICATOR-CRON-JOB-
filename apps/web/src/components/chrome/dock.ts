/**
 * The width below which the right dock (book & tape, watchlist) stops being a column beside the chart and lies over
 * it. Kept in step with the `@media (max-width: 650px)` rules in App.css.
 */
export const DOCK_OVERLAY_QUERY = "(max-width: 650px)";

/** Open beside the chart; closed where it would lie over the chart, so a phone opens on the chart, not the dock. */
export function dockOpenByDefault(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return !window.matchMedia(DOCK_OVERLAY_QUERY).matches;
}
