export function formatTokenSize(value: number, decimals: number = 1): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const absoluteValue = Math.abs(value);
  if (absoluteValue === 0) return "0";

  const tiers = [
    { factor: 1, suffix: "" },
    { factor: 1_000, suffix: "k" },
    { factor: 1_000_000, suffix: "M" },
    { factor: 1_000_000_000, suffix: "B" },
    { factor: 1_000_000_000_000, suffix: "T" },
  ] as const;
  let tierIndex = 0;
  while (tierIndex < tiers.length - 1 && absoluteValue >= tiers[tierIndex + 1].factor) {
    tierIndex += 1;
  }
  while (tierIndex < tiers.length - 1) {
    const tier = tiers[tierIndex];
    if (Number((absoluteValue / tier.factor).toFixed(decimals)) < 1_000) break;
    tierIndex += 1;
  }
  const tier = tiers[tierIndex];
  if (tier.factor === 1) return `${sign}${Number(absoluteValue.toFixed(decimals))}`;
  return `${sign}${(absoluteValue / tier.factor).toFixed(decimals)}${tier.suffix}`;
}
