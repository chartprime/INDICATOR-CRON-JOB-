export type DrawObjectKind = "line" | "box" | "label" | "polyline" | "table";

export interface DrawObjectRecord<T = unknown> {
  handleId: number;
  ownerId: string;
  kind: DrawObjectKind;
  data: T;
}

let nextHandleId = 1;
const recordsById = new Map<number, DrawObjectRecord>();
const handleIdsByOwner = new Map<string, Set<number>>();
const tableIdsByOwner = new Map<string, Set<number>>();
const requestUpdateByOwner = new Map<string, () => void>();
let deferDepth = 0;
const deferredOwners = new Set<string>();
let changeClock = 0;
const changedAtByOwner = new Map<string, number>();

export function ownerChangedAt(ownerId: string): number {
  return changedAtByOwner.get(ownerId) ?? 0;
}

function notifyOwner(ownerId: string): void {
  changeClock += 1;
  changedAtByOwner.set(ownerId, changeClock);
  if (deferDepth > 0) {
    deferredOwners.add(ownerId);
    return;
  }
  requestUpdateByOwner.get(ownerId)?.();
}

function releaseOwnerRevisionIfUnused(ownerId: string): void {
  if (!handleIdsByOwner.has(ownerId) && !requestUpdateByOwner.has(ownerId)) {
    changedAtByOwner.delete(ownerId);
  }
}

function forget(index: Map<string, Set<number>>, ownerId: string, handleId: number): void {
  const owned = index.get(ownerId);
  if (!owned) return;
  owned.delete(handleId);
  if (owned.size === 0) index.delete(ownerId);
}

export function withNotificationsDeferred<T>(fn: () => T): T {
  deferDepth += 1;
  try {
    return fn();
  } finally {
    deferDepth -= 1;
    if (deferDepth === 0 && deferredOwners.size > 0) {
      const owners = [...deferredOwners];
      deferredOwners.clear();
      for (const ownerId of owners) requestUpdateByOwner.get(ownerId)?.();
    }
  }
}

export function setRequestUpdate(ownerId: string, callback: (() => void) | null): void {
  if (callback) requestUpdateByOwner.set(ownerId, callback);
  else {
    requestUpdateByOwner.delete(ownerId);
    releaseOwnerRevisionIfUnused(ownerId);
  }
}

export function create<T>(ownerId: string, kind: DrawObjectKind, initial: T): number {
  const handleId = nextHandleId;
  nextHandleId += 1;
  recordsById.set(handleId, { handleId, ownerId, kind, data: initial });
  let owned = handleIdsByOwner.get(ownerId);
  if (!owned) {
    owned = new Set();
    handleIdsByOwner.set(ownerId, owned);
  }
  owned.add(handleId);
  if (kind === "table") {
    let tables = tableIdsByOwner.get(ownerId);
    if (!tables) {
      tables = new Set();
      tableIdsByOwner.set(ownerId, tables);
    }
    tables.add(handleId);
  }
  notifyOwner(ownerId);
  return handleId;
}

export function update<T>(handleId: number, patch: (data: T) => T): void {
  const record = recordsById.get(handleId) as DrawObjectRecord<T> | undefined;
  if (!record) return;
  record.data = patch(record.data);
  notifyOwner(record.ownerId);
}

export function assign<T extends object>(handleId: number, fields: Partial<T>): void {
  const record = recordsById.get(handleId) as DrawObjectRecord<T> | undefined;
  if (!record) return;
  const current = record.data as Record<string, unknown>;
  const next = fields as Record<string, unknown>;
  let changed = false;
  for (const key in next) {
    if (!Object.is(current[key], next[key])) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  record.data = { ...record.data, ...fields };
  notifyOwner(record.ownerId);
}

export function remove(handleId: number): void {
  const record = recordsById.get(handleId);
  if (!record) return;
  recordsById.delete(handleId);
  forget(handleIdsByOwner, record.ownerId, handleId);
  if (record.kind === "table") forget(tableIdsByOwner, record.ownerId, handleId);
  notifyOwner(record.ownerId);
  releaseOwnerRevisionIfUnused(record.ownerId);
}

export function get<T>(handleId: number): DrawObjectRecord<T> | undefined {
  return recordsById.get(handleId) as DrawObjectRecord<T> | undefined;
}

export function clearForIndicator(ownerId: string): void {
  const owned = handleIdsByOwner.get(ownerId);
  if (!owned) {
    releaseOwnerRevisionIfUnused(ownerId);
    return;
  }
  for (const handleId of owned) recordsById.delete(handleId);
  handleIdsByOwner.delete(ownerId);
  tableIdsByOwner.delete(ownerId);
  notifyOwner(ownerId);
  releaseOwnerRevisionIfUnused(ownerId);
}

function recordsOf(index: Map<string, Set<number>>, ownerIds: readonly string[]): DrawObjectRecord[] {
  const result: DrawObjectRecord[] = [];
  for (const ownerId of ownerIds) {
    const owned = index.get(ownerId);
    if (!owned) continue;
    for (const handleId of owned) {
      const record = recordsById.get(handleId);
      if (record) result.push(record);
    }
  }
  return result;
}

export function handlesForOwners(ownerIds: readonly string[]): DrawObjectRecord[] {
  return recordsOf(handleIdsByOwner, ownerIds);
}

export function tablesForOwners(ownerIds: readonly string[]): DrawObjectRecord[] {
  return recordsOf(tableIdsByOwner, ownerIds);
}

export function resetDrawRegistryForTests(): void {
  nextHandleId = 1;
  recordsById.clear();
  handleIdsByOwner.clear();
  tableIdsByOwner.clear();
  requestUpdateByOwner.clear();
  deferDepth = 0;
  deferredOwners.clear();
  changeClock = 0;
  changedAtByOwner.clear();
}

export function drawRegistryStats() {
  return { objects: recordsById.size, owners: handleIdsByOwner.size, callbacks: requestUpdateByOwner.size };
}
