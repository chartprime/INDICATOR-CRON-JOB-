/** The net of one row as the bar's number: a whole number, "k" from 10,000, "M" from 10,000k, "<1" when it rounds to nothing. */
export function formatDelta(net: number): string {
  const whole = Math.round(Math.abs(net));
  if (whole === 0) return "<1";
  const sign = net < 0 ? "-" : "";
  if (whole < 10_000) return `${sign}${whole}`;
  const thousands = Math.round(whole / 1_000);
  if (thousands < 10_000) return `${sign}${thousands}k`;
  return `${sign}${Math.round(whole / 1_000_000)}M`;
}
