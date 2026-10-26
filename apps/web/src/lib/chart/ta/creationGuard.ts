let creationWindowDepth = 0;
const warnedFactoryNames = new Set<string>();

export function beginStreamCreationWindow(): void {
  creationWindowDepth += 1;
}

export function endStreamCreationWindow(): void {
  creationWindowDepth = Math.max(0, creationWindowDepth - 1);
}

export function isInsideStreamCreationWindow(): boolean {
  return creationWindowDepth > 0;
}

/** Test isolation only. Production code must use withStreamCreationWindow(). */
export function resetStreamCreationGuardForTests(): void {
  creationWindowDepth = 0;
  warnedFactoryNames.clear();
}

export function withStreamCreationWindow<T>(create: () => T): T {
  beginStreamCreationWindow();
  try {
    return create();
  } finally {
    endStreamCreationWindow();
  }
}

export function assertInsideCreationWindow(qualifiedFactoryName: string): void {
  if (isInsideStreamCreationWindow() || warnedFactoryNames.has(qualifiedFactoryName)) return;
  warnedFactoryNames.add(qualifiedFactoryName);
  console.error(
    `${qualifiedFactoryName}() was called outside createState(). A stream created inside onBar is recreated every bar and never warms up -- move this call into your indicator's createState() and store the returned stream on your own state object.`,
  );
}
