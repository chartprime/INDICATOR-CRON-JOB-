export function isIndexProvider(provider: string | undefined): boolean {
  return provider === "DXFEED" || provider === "DATABENTO";
}

export function futuresRoot(symbol: string): string | null {
  const root = /^\/?([A-Z]{1,4})[FGHJKMNQUVXZ]\d{1,4}(?::[A-Z]+)?$/.exec(symbol)?.[1]
    ?? /^\/(ES|NQ|MES|MNQ)(?::[A-Z]+)?$/.exec(symbol)?.[1];
  return root === undefined ? null : `/${root}`;
}
