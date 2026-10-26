export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const absoluteValue = Math.abs(value);
  const tiers = [
    { factor: 1, suffix: "", decimals: 0 },
    { factor: 1_000, suffix: "k", decimals: 1 },
    { factor: 1_000_000, suffix: "M", decimals: 2 },
    { factor: 1_000_000_000, suffix: "B", decimals: 2 },
    { factor: 1_000_000_000_000, suffix: "T", decimals: 2 },
  ] as const;
  let tierIndex = 0;
  while (tierIndex < tiers.length - 1 && absoluteValue >= tiers[tierIndex + 1].factor) {
    tierIndex += 1;
  }
  while (tierIndex < tiers.length - 1) {
    const tier = tiers[tierIndex];
    if (Number((absoluteValue / tier.factor).toFixed(tier.decimals)) < 1_000) break;
    tierIndex += 1;
  }
  const tier = tiers[tierIndex];
  return `${sign}$${(absoluteValue / tier.factor).toFixed(tier.decimals)}${tier.suffix}`;
}
