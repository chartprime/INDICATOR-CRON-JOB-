import { beginStreamCreationWindow, endStreamCreationWindow } from "../ta/creationGuard";
import { clearForIndicator } from "./registry";

let ownerStack: string[] = [];

// Every real call site that needs owner-scoping also needs a stream creation
// window open (a legitimate createState() call can freely mix ta.* and
// draw.* factories) -- so this opens both rather than requiring every caller
// to remember to nest withStreamCreationWindow separately. ta.*'s own guard
// only ever checks the window depth, not how it was opened, so this is
// transparent to ta/creationGuard.ts's own callers.
export function withDrawOwnerScope<T>(ownerId: string, fn: () => T): T {
  clearForIndicator(ownerId);
  ownerStack.push(ownerId);
  beginStreamCreationWindow();
  try {
    return fn();
  } finally {
    endStreamCreationWindow();
    ownerStack.pop();
  }
}

export function currentDrawOwnerId(): string | null {
  return ownerStack.length > 0 ? ownerStack[ownerStack.length - 1] : null;
}

export function resetDrawOwnerScopeForTests(): void {
  ownerStack = [];
}
