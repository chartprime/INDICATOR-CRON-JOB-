const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function two(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

export function fmtUsd(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  return `$${Math.round(value / 1e3)}k`;
}

export function fmtUtc(ms: number, withSeconds = false): string {
  const date = new Date(ms);
  const clock = `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
  return withSeconds ? `${clock}:${two(date.getUTCSeconds())}` : clock;
}

export function fmtUtcDay(ms: number): string {
  const date = new Date(ms);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

export function fmtDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds} s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${minutes.toFixed(1)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

export function fmtPrice(price: number, rowWidth: number): string {
  return rowWidth < 1 ? price.toFixed(2) : price.toFixed(1);
}

export function fmtSize(size: number): string {
  return size.toLocaleString("en-US", { maximumFractionDigits: 1 });
}
